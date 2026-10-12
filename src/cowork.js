// Cowork sessions (the Claude desktop app's local agent-mode work). Each session
// is indexed at:
//   <appData>/local-agent-mode-sessions/<accountUuid>/<orgUuid>/local_<id>.json
// with title, initial message, the underlying Claude Code cliSessionId, cwd,
// model, account email and timestamps. Read-only; account-independent browsing.
import fs from 'fs';
import path from 'path';
import { isAccountDirName } from './appsessions.js';

function coworkDir(ctx) {
  return ctx.appDataDir ? path.join(ctx.appDataDir, 'local-agent-mode-sessions') : null;
}

// Cowork timestamps are epoch-ms (as number or numeric string); normalize to ISO.
function toIso(t) {
  if (t == null) return null;
  if (typeof t === 'string' && /^\d{10,}$/.test(t)) t = parseInt(t, 10);
  if (typeof t === 'number') {
    try {
      return new Date(t).toISOString();
    } catch (e) {
      return null;
    }
  }
  return String(t);
}

function readIndex(file) {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
  if (!j || !j.sessionId) return null;
  return {
    sessionId: j.sessionId,
    cliSessionId: j.cliSessionId || null,
    title: (j.title || '').trim() || null,
    initialMessage:
      typeof j.initialMessage === 'string' ? j.initialMessage.replace(/\s+/g, ' ').trim().slice(0, 120) : null,
    cwd: j.cwd || null,
    model: j.model || null,
    account: j.emailAddress || j.accountName || null,
    archived: !!j.isArchived,
    createdAt: toIso(j.createdAt),
    lastActivityAt: toIso(j.lastActivityAt || j.createdAt),
    file: file,
  };
}

// List Cowork sessions across ALL accounts, newest activity first.
// opts: { search, account, includeArchived, limit }.
function list(ctx, opts) {
  opts = opts || {};
  const root = coworkDir(ctx);
  if (!root) return [];
  const rows = [];
  let accts;
  try {
    accts = fs.readdirSync(root);
  } catch (e) {
    return [];
  }
  // Only <accountUuid>/<orgUuid>/ folders hold sessions; the store also has app bookkeeping
  // (skills-plugin/…) that is laid out the same way but is not an account.
  accts.filter(isAccountDirName).forEach(function (a) {
    const adir = path.join(root, a);
    let orgs;
    try {
      orgs = fs.readdirSync(adir);
    } catch (e) {
      return;
    }
    orgs.filter(isAccountDirName).forEach(function (o) {
      const odir = path.join(adir, o);
      let files;
      try {
        files = fs.readdirSync(odir);
      } catch (e) {
        return;
      }
      files.forEach(function (f) {
        if (f.indexOf('local_') !== 0 || f.slice(-5) !== '.json') return;
        const r = readIndex(path.join(odir, f));
        if (r) {
          r.accountUuid = a;
          // The session's own data dir (transcript, outputs) exists only in its home account.
          r.home = fs.existsSync(path.join(odir, f.slice(0, -5)));
          rows.push(r);
        }
      });
    });
  });
  // After `consolidate` the same session's index file sits in every account folder. Report it
  // once: the home copy if there is one, otherwise the most recently active.
  const byId = Object.create(null);
  rows.forEach(function (r) {
    const cur = byId[r.sessionId];
    if (
      !cur ||
      (r.home && !cur.home) ||
      (r.home === cur.home && String(r.lastActivityAt || '') > String(cur.lastActivityAt || ''))
    )
      byId[r.sessionId] = r;
  });
  let out = Object.keys(byId)
    .map(function (id) {
      return byId[id];
    })
    .filter(function (r) {
      return opts.includeArchived || !r.archived;
    });
  if (opts.search) {
    const t = String(opts.search).toLowerCase();
    out = out.filter(function (r) {
      return (
        (r.title || '').toLowerCase().indexOf(t) !== -1 ||
        (r.initialMessage || '').toLowerCase().indexOf(t) !== -1 ||
        (r.cwd || '').toLowerCase().indexOf(t) !== -1 ||
        (r.account || '').toLowerCase().indexOf(t) !== -1
      );
    });
  }
  if (opts.account)
    out = out.filter(function (r) {
      return (r.account || '') === opts.account;
    });
  out.sort(function (a, b) {
    return String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || ''));
  });
  return opts.limit ? out.slice(0, opts.limit) : out;
}

function find(ctx, idOrPrefix) {
  const all = list(ctx, { includeArchived: true });
  const exact = all.filter(function (r) {
    return r.sessionId === idOrPrefix;
  })[0];
  if (exact) return exact;
  const pref = all.filter(function (r) {
    return r.sessionId.indexOf(idOrPrefix) === 0;
  });
  if (pref.length === 1) return pref[0];
  if (pref.length > 1) throw new Error("'" + idOrPrefix + "' is ambiguous — use more of the id");
  return null;
}

// Cowork runs Claude Code underneath, so resume via its cliSessionId.
function resumeCommand(row) {
  if (!row.cliSessionId) return null;
  return { cwd: row.cwd, command: 'claude', args: ['--resume', row.cliSessionId] };
}

export { coworkDir, list, find, readIndex, resumeCommand };
