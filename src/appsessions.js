'use strict';
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
// macOS desktop app only. The cloud "Chat" conversations (claude.ai) are NOT here —
// they live server-side per account and cannot be merged locally.
const fs = require('fs');
const path = require('path');

const BACKUP_PREFIX = 'claude-code-sessions-';
const BACKUPS_TO_KEEP = 5;

function listDirs(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }).filter(function (d) { return d.isDirectory(); }).map(function (d) { return d.name; }); }
  catch (e) { return []; }
}
function listIndexFiles(p) {
  try { return fs.readdirSync(p).filter(function (f) { return f.indexOf('local_') === 0 && f.slice(-5) === '.json'; }); }
  catch (e) { return []; }
}
function cliIdOf(file) {
  try { const o = JSON.parse(fs.readFileSync(file, 'utf8')); return o.cliSessionId || o.sessionId || null; }
  catch (e) { return null; }
}
function copyTree(src, dest) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) return;           // don't follow symlinks
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    fs.readdirSync(src).forEach(function (n) { copyTree(path.join(src, n), path.join(dest, n)); });
  } else if (st.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}
function pruneBackups(configDir, keep) {
  try {
    const bdir = path.join(configDir, 'backups');
    const entries = fs.readdirSync(bdir).filter(function (n) { return n.indexOf(BACKUP_PREFIX) === 0; }).sort();
    for (let i = 0; i < entries.length - keep; i++) {
      fs.rmSync(path.join(bdir, entries[i]), { recursive: true, force: true });
    }
  } catch (e) { /* ignore */ }
}

function consolidate(ctx) {
  const appDir = ctx.appDataDir;
  if (!appDir) return { ok: false, merged: 0, reason: 'only the macOS desktop app has this store' };
  const store = path.join(appDir, 'claude-code-sessions');
  if (!fs.existsSync(store)) return { ok: false, merged: 0, reason: 'no app session store found' };

  // Every <accountUuid>/<orgUuid>/ folder that holds session index files.
  const orgDirs = [];
  listDirs(store).forEach(function (acct) {
    listDirs(path.join(store, acct)).forEach(function (org) { orgDirs.push(path.join(store, acct, org)); });
  });
  if (orgDirs.length < 2) return { ok: true, merged: 0, backup: null, accounts: orgDirs.length };

  // Master set: one representative index file per unique cliSessionId.
  const master = Object.create(null); // cliId -> { name, from }
  orgDirs.forEach(function (dir) {
    listIndexFiles(dir).forEach(function (f) {
      const id = cliIdOf(path.join(dir, f));
      if (id && !master[id]) master[id] = { name: f, from: path.join(dir, f) };
    });
  });

  // Plan: give every folder the sessions it is missing.
  const plan = [];
  orgDirs.forEach(function (dir) {
    const have = Object.create(null);
    listIndexFiles(dir).forEach(function (f) { const id = cliIdOf(path.join(dir, f)); if (id) have[id] = true; });
    Object.keys(master).forEach(function (id) {
      if (have[id]) return;
      const m = master[id];
      const dest = path.join(dir, m.name);
      if (fs.existsSync(dest)) return; // filename clash safety (add-only)
      plan.push({ from: m.from, to: dest });
    });
  });

  if (!plan.length) return { ok: true, merged: 0, backup: null, accounts: orgDirs.length };

  // Back up the store once (only when we will change it), keep only the last few.
  let backup = null;
  try {
    const ts = String(ctx.now()).replace(/[:.]/g, '-');
    backup = path.join(ctx.configDir, 'backups', BACKUP_PREFIX + ts);
    copyTree(store, backup);
    pruneBackups(ctx.configDir, BACKUPS_TO_KEEP);
  } catch (e) { backup = null; }

  let merged = 0;
  plan.forEach(function (p) { try { fs.copyFileSync(p.from, p.to); merged += 1; } catch (e) { /* skip */ } });
  return { ok: true, merged: merged, backup: backup, accounts: orgDirs.length };
}

module.exports = { consolidate: consolidate, pruneBackups: pruneBackups };
