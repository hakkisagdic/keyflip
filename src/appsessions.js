// Consolidate the Claude *desktop app*'s Code-session index across accounts.
//
// The app stores its "Recents" as index files at:
//   <appData>/claude-code-sessions/<accountUuid>/<orgUuid>/local_*.json
// keyed by account. Those files embed NO account id (association is purely the
// folder), and each points at a cliSessionId — the account-independent transcript
// in ~/.claude/projects.
//
// We UNION every account's folder: give each folder the sessions it is missing, so
// no matter which account the desktop app is actually logged in to, its Recents
// shows them all. (The app's own login can differ from ~/.claude.json, so we don't
// rely on a single "active" account.)
//
// The same store exists inside each keyflip instance clone
// (~/.keyflip-instances/<tool>/<slug>/User Data/claude-code-sessions), so the union
// spans the base app AND every clone: a chat read in one clone is visible in all of
// them. A clone whose instance.pid is alive is skipped, because the app owns and
// rewrites its index on exit.
//
// macOS desktop app only. The cloud "Chat" conversations (claude.ai) are NOT here —
// they live server-side per account and cannot be merged locally.
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const BACKUP_PREFIX = 'claude-code-sessions-';
const BACKUPS_TO_KEEP = 5;

function listDirs(p) {
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter(function (d) {
        return d.isDirectory();
      })
      .map(function (d) {
        return d.name;
      });
  } catch (e) {
    return [];
  }
}
// Account and org folders are named by their UUIDs. Anything else under a store is the app's own
// bookkeeping — e.g. local-agent-mode-sessions/skills-plugin/<orgUuid>/<accountUuid>/ — and is
// NOT an account. Treating it as one made consolidate copy session pointers into it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isAccountDirName(name) {
  return UUID_RE.test(name);
}
function listAccountDirs(p) {
  return listDirs(p).filter(isAccountDirName);
}
// The app leaves `deleted_<id>` beside the index files when the user deletes a session while
// signed in to that account. Copying the pointer back from another account's folder would
// resurrect a chat the user removed.
function isTombstoned(dir, indexName) {
  const id = indexName.slice('local_'.length, -'.json'.length);
  return fs.existsSync(path.join(dir, 'deleted_' + id));
}
function listIndexFiles(p) {
  try {
    return fs.readdirSync(p).filter(function (f) {
      return f.indexOf('local_') === 0 && f.slice(-5) === '.json';
    });
  } catch (e) {
    return [];
  }
}
function cliIdOf(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return o.cliSessionId || o.sessionId || null;
  } catch (e) {
    return null;
  }
}
function copyTree(src, dest) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) return; // don't follow symlinks
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    fs.readdirSync(src).forEach(function (n) {
      copyTree(path.join(src, n), path.join(dest, n));
    });
  } else if (st.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}
function pruneBackups(configDir, keep, prefix) {
  prefix = prefix || BACKUP_PREFIX;
  try {
    const bdir = path.join(configDir, 'backups');
    const entries = fs
      .readdirSync(bdir)
      .filter(function (n) {
        return n.indexOf(prefix) === 0;
      })
      .sort();
    for (let i = 0; i < entries.length - keep; i++) {
      fs.rmSync(path.join(bdir, entries[i]), { recursive: true, force: true });
    }
  } catch (e) {
    /* ignore */
  }
}
function uniquePath(base) {
  let p = base;
  let n = 1;
  while (fs.existsSync(p)) p = base + '.' + n++;
  return p;
}
function pidAlive(pid) {
  if (!pid || !isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

// Every keyflip instance user-data dir that could carry a Claude store. We read the pid file
// keyflip itself writes; an instance launched by hand has no pid file, so it is treated as
// closed (the add-only write is still safe; the worst case is the app overwriting it on exit).
function instanceRoots(ctx) {
  const home = (ctx && ctx.home) || os.homedir();
  const bases = [
    ctx && ctx.instancesBase,
    path.join(home, '.keyflip-instances'),
    path.join(home, 'Library', 'Application Support', 'keyflip-instances'),
  ].filter(Boolean);
  const seen = Object.create(null);
  const out = [];
  bases.forEach(function (base) {
    listDirs(base).forEach(function (tool) {
      listDirs(path.join(base, tool)).forEach(function (slug) {
        const dir = path.join(base, tool, slug);
        const userData = path.join(dir, 'User Data');
        if (!fs.existsSync(userData)) return;
        const key = path.resolve(userData);
        if (seen[key]) return;
        seen[key] = true;
        let running = false;
        try {
          running = pidAlive(parseInt(fs.readFileSync(path.join(dir, 'instance.pid'), 'utf8'), 10));
        } catch (e) {
          /* no pid file / unreadable: assume closed */
        }
        out.push({ appDataDir: userData, label: tool + '/' + slug, running: running });
      });
    });
  });
  return out;
}

// A collision-safe filename derived from the transcript id. cliSessionId is normally a UUID;
// sanitize anyway so a hostile/corrupt index can never escape the account folder.
function safeId(id) {
  const s = String(id || '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 64);
  return s || crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 16);
}

// Where to put one missing pointer. The app names files by its own local id, and two accounts can
// legitimately use the SAME filename for DIFFERENT transcripts. A bare existsSync() skip loses
// one of them (the bug this replaces); instead, fall back to the transcript id as the filename.
function destinationFor(dir, entry) {
  const wanted = entry.name;
  if (isTombstoned(dir, wanted)) return { skip: 'tombstone' };
  const direct = path.join(dir, wanted);
  if (!fs.existsSync(direct)) return { to: direct, name: wanted };
  if (cliIdOf(direct) === entry.cliId) return { skip: 'exists' };

  const stem = 'local_' + safeId(entry.cliId);
  let name = stem + '.json';
  for (let n = 2; ; n++) {
    if (isTombstoned(dir, name)) return { skip: 'tombstone' };
    const dest = path.join(dir, name);
    if (!fs.existsSync(dest)) return { to: dest, name: name };
    if (cliIdOf(dest) === entry.cliId) return { skip: 'exists' };
    name = stem + '-' + n + '.json';
  }
}

// Merge one account-keyed index store (<root>/<storeName>/<accountUuid>/<orgUuid>/local_*.json)
// so every account's folder — in the base app and in every writable clone — gains the sessions
// it is missing.
function mergeStore(ctx, storeName, backupPrefix, opts) {
  opts = opts || {};
  const roots = Array.isArray(opts.roots)
    ? opts.roots
    : ctx.appDataDir
      ? [{ appDataDir: ctx.appDataDir, label: null, running: false }]
      : [];
  const stores = [];
  const seen = Object.create(null);
  roots.forEach(function (root) {
    if (!root || !root.appDataDir) return;
    const key = path.resolve(root.appDataDir);
    if (seen[key]) return;
    seen[key] = true;
    const store = path.join(root.appDataDir, storeName);
    if (!fs.existsSync(store)) return;
    stores.push({ root: root, store: store });
  });
  if (!stores.length) {
    return {
      ok: false,
      merged: 0,
      reason: ctx.appDataDir ? 'no ' + storeName + ' store found' : 'only the macOS desktop app has this store',
      accounts: 0,
      roots: 0,
      skippedRunning: 0,
    };
  }

  const runningStores = stores.filter(function (s) {
    return !!s.root.running;
  });
  const writable = stores.filter(function (s) {
    return !s.root.running;
  });
  const orgDirs = [];
  writable.forEach(function (s) {
    listAccountDirs(s.store).forEach(function (acct) {
      listAccountDirs(path.join(s.store, acct)).forEach(function (org) {
        orgDirs.push({ dir: path.join(s.store, acct, org), store: s.store, root: s.root });
      });
    });
  });
  const skippedRunning = runningStores.length;
  if (orgDirs.length < 2) {
    return {
      ok: true,
      merged: 0,
      backup: null,
      backups: [],
      accounts: orgDirs.length,
      roots: stores.length,
      skippedRunning: skippedRunning,
      runningLabels: runningStores.map(function (s) {
        return (s.root.label || 'base') + ' (running)';
      }),
    };
  }

  // Master set: one representative index file per unique cliSessionId.
  const master = Object.create(null); // cliId -> { name, from, cliId }
  orgDirs.forEach(function (entry) {
    listIndexFiles(entry.dir).forEach(function (f) {
      const id = cliIdOf(path.join(entry.dir, f));
      if (id && !master[id]) master[id] = { name: f, from: path.join(entry.dir, f), cliId: id };
    });
  });

  // Plan: give every folder the sessions it is missing.
  const plan = [];
  let skippedExists = 0;
  let skippedTomb = 0;
  orgDirs.forEach(function (entry) {
    const dir = entry.dir;
    const have = Object.create(null);
    listIndexFiles(dir).forEach(function (f) {
      const id = cliIdOf(path.join(dir, f));
      if (id) have[id] = true;
    });
    Object.keys(master).forEach(function (id) {
      if (have[id]) return;
      const m = master[id];
      const dest = destinationFor(dir, m);
      if (dest.skip === 'exists') {
        skippedExists++;
        return;
      }
      if (dest.skip === 'tombstone') {
        skippedTomb++;
        return;
      }
      plan.push({ from: m.from, to: dest.to, store: entry.store, root: entry.root });
    });
  });

  if (!plan.length) {
    return {
      ok: true,
      merged: 0,
      backup: null,
      backups: [],
      accounts: orgDirs.length,
      roots: stores.length,
      skippedRunning: skippedRunning,
      skippedExists: skippedExists,
      skippedTomb: skippedTomb,
    };
  }

  // A dry run reports the plan and stops: no backup, no copy, nothing on disk moves.
  if (opts.dryRun) {
    return {
      ok: true,
      merged: 0,
      wouldMerge: plan.length,
      plan: plan.slice(0, 50).map(function (p) {
        return {
          // Absolute source, destination relative to its store root: enough to review without
          // dumping a path per account-uuid pair into an agent transcript.
          from: p.from,
          to: path.relative(p.store, p.to),
          store: p.store,
          instance: (p.root && p.root.label) || null,
        };
      }),
      planTruncated: plan.length > 50,
      backup: null,
      backups: [],
      accounts: orgDirs.length,
      roots: stores.length,
      skippedRunning: skippedRunning,
      skippedExists: skippedExists,
      skippedTomb: skippedTomb,
    };
  }

  // Back up each store ONCE (only when we will change it), keep only the last few. The base app
  // keeps the historical name; a clone's backup names its tool/slug so two roots in the same
  // second never collide.
  const backups = []; // [{ store, path }]
  const storesToBackup = [];
  plan.forEach(function (p) {
    if (storesToBackup.indexOf(p.store) === -1) storesToBackup.push(p.store);
  });
  storesToBackup.forEach(function (store) {
    const root = stores.filter(function (s) {
      return s.store === store;
    })[0].root;
    try {
      const ts = String(ctx.now()).replace(/[:.]/g, '-');
      const label = root.label ? 'instance-' + safeId(root.label.replace('/', '-')) + '-' : '';
      const backup = uniquePath(path.join(ctx.configDir, 'backups', backupPrefix + label + ts));
      copyTree(store, backup);
      backups.push({ store: store, path: backup });
      pruneBackups(ctx.configDir, BACKUPS_TO_KEEP, backupPrefix);
    } catch (e) {
      /* a failed backup must not abort the add-only merge */
    }
  });

  let merged = 0;
  plan.forEach(function (p) {
    try {
      fs.copyFileSync(p.from, p.to);
      merged += 1;
    } catch (e) {
      /* skip */
    }
  });
  const baseBackup = backups.filter(function (b) {
    const root = stores.filter(function (s) {
      return s.store === b.store;
    })[0].root;
    return !root.label;
  })[0];
  return {
    ok: true,
    merged: merged,
    backup: baseBackup ? baseBackup.path : (backups[0] && backups[0].path) || null,
    backups: backups.map(function (b) {
      return b.path;
    }),
    accounts: orgDirs.length,
    roots: stores.length,
    skippedRunning: skippedRunning,
    skippedExists: skippedExists,
    skippedTomb: skippedTomb,
    runningLabels: runningStores.map(function (s) {
      return (s.root.label || 'base') + ' (running)';
    }),
  };
}

// Store names that carry per-account chat pointers.
const STORE_NAMES = ['claude-code-sessions', 'local-agent-mode-sessions'];

function instanceRootsWithStore(ctx, roots) {
  return roots.filter(function (r) {
    return STORE_NAMES.some(function (name) {
      return fs.existsSync(path.join(r.appDataDir, name));
    });
  });
}

// Consolidate BOTH the Claude Code Recents and the Cowork session indexes — in the base app and
// in every non-running instance clone — so every account sees them all. Returns the combined
// merge count plus per-store/instance diagnostics.
function consolidate(ctx, opts) {
  opts = opts || {};
  const roots = [];
  if (ctx.appDataDir) roots.push({ appDataDir: ctx.appDataDir, label: null, running: false });
  if (opts.includeInstances !== false) roots.push.apply(roots, instanceRoots(ctx));
  const withStore = instanceRootsWithStore(ctx, roots);
  if (!roots.length) {
    return { ok: false, merged: 0, reason: 'only the macOS desktop app has this store' };
  }
  const mergeOpts = { roots: roots, dryRun: !!opts.dryRun };
  const code = mergeStore(ctx, 'claude-code-sessions', 'claude-code-sessions-', mergeOpts);
  const cowork = mergeStore(ctx, 'local-agent-mode-sessions', 'cowork-sessions-', mergeOpts);
  const merged = (code.merged || 0) + (cowork.merged || 0);
  const would = (code.wouldMerge || 0) + (cowork.wouldMerge || 0);
  const plan = (code.plan || []).concat(cowork.plan || []);
  return {
    ok: code.ok || cowork.ok,
    merged: merged,
    wouldMerge: opts.dryRun ? would : undefined,
    wouldCode: opts.dryRun ? code.wouldMerge || 0 : undefined,
    wouldCowork: opts.dryRun ? cowork.wouldMerge || 0 : undefined,
    dryRun: !!opts.dryRun,
    backups: (code.backups || []).concat(cowork.backups || []),
    plan: plan.length ? plan : undefined,
    planTruncated: !!(code.planTruncated || cowork.planTruncated),
    planTotal: would || undefined,
    code: code.merged || 0,
    cowork: cowork.merged || 0,
    instances: withStore.filter(function (r) {
      return !!r.label;
    }).length,
    roots: withStore.length,
    skippedRunning: Math.max(code.skippedRunning || 0, cowork.skippedRunning || 0),
    runningLabels: Array.from(new Set((code.runningLabels || []).concat(cowork.runningLabels || []))),
    skippedExists: code.skippedExists || 0,
    skippedTomb: code.skippedTomb || 0,
  };
}

export {
  consolidate,
  mergeStore,
  pruneBackups,
  isAccountDirName,
  instanceRoots,
  instanceRootsWithStore,
  destinationFor,
};
