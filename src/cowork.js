// Cowork sessions (the Claude desktop app's local agent-mode work). Each session
// is indexed at:
//   <appData>/local-agent-mode-sessions/<accountUuid>/<orgUuid>/local_<id>.json
// with title, initial message, the underlying Claude Code cliSessionId, cwd,
// model, account email and timestamps. Read-only; account-independent browsing.
import fs from 'fs';
import os from 'os';
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

function envOf(ctx) {
  if (ctx && ctx.env) return ctx.env;
  if (ctx && ctx.home && ctx.home !== os.homedir()) return {};
  return process.env;
}

function auditRoots(ctx) {
  const env = envOf(ctx);
  const home = (ctx && ctx.home) || os.homedir();
  const out = [];
  const push = function (dir) {
    if (!dir) return;
    const p = path.join(dir, 'local-agent-mode-sessions');
    if (out.indexOf(p) < 0) out.push(p);
  };
  if (ctx && ctx.appDataDir) push(ctx.appDataDir);
  if (env && env.APPDATA) push(path.join(env.APPDATA, 'Claude'));
  if (env && env.XDG_CONFIG_HOME) push(path.join(env.XDG_CONFIG_HOME, 'Claude'));
  push(path.join(home, 'Library', 'Application Support', 'Claude'));
  push(path.join(home, 'AppData', 'Roaming', 'Claude'));
  push(path.join(home, '.config', 'Claude'));
  return out;
}

// Discover Cowork `audit.jsonl` logs under `local-agent-mode-sessions` (skipping `skills-plugin`),
// enriched with non-PII metadata from sibling `local_<id>.json`, deduped newest-first by sessionId.
function auditSources(ctx) {
  const raw = [];
  const seenPath = new Set();
  const walk = function (dir, depth) {
    if (depth < 0) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    ents.forEach(function (e) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'skills-plugin' || e.name.slice(-'.keyflip-bak'.length) === '.keyflip-bak') return;
        walk(p, depth - 1);
      } else if (e.isFile() && e.name === 'audit.jsonl') {
        try {
          const st = fs.statSync(p);
          if (!st.isFile() || st.size === 0) return;
          let real;
          try {
            real = fs.realpathSync(p);
          } catch {
            real = path.resolve(p);
          }
          if (seenPath.has(real)) return;
          seenPath.add(real);
          const sessDir = path.dirname(p);
          const meta = readIndex(sessDir + '.json');
          const sid = (meta && meta.sessionId) || path.basename(sessDir);
          const updMs = meta && meta.lastActivityAt ? Date.parse(meta.lastActivityAt) : NaN;
          raw.push({
            path: p,
            mtimeMs: !isNaN(updMs) && updMs > st.mtimeMs ? updMs : st.mtimeMs,
            size: st.size,
            sessionId: sid,
            title: (meta && meta.title) || null,
            cwd: (meta && meta.cwd) || null,
            createdAt: (meta && meta.createdAt) || null,
            updatedAt: (meta && meta.lastActivityAt) || null,
          });
        } catch {
          /* vanished */
        }
      }
    });
  };
  auditRoots(ctx).forEach(function (root) {
    walk(root, 6);
  });
  raw.sort(function (a, b) {
    return b.mtimeMs - a.mtimeMs || b.size - a.size;
  });
  const out = [];
  const seenId = new Set();
  for (const item of raw) {
    if (seenId.has(item.sessionId)) continue;
    seenId.add(item.sessionId);
    out.push(item);
  }
  return out;
}

export { coworkDir, auditRoots, auditSources, list, find, readIndex, resumeCommand };
