'use strict';
// Consolidate the Claude *desktop app*'s Code-session index across accounts.
//
// The app stores its "Recents" as index files at:
//   <appData>/claude-code-sessions/<accountUuid>/<orgUuid>/local_*.json
// keyed by account. Those files embed NO account id (association is purely the
// folder), and each points at a cliSessionId — the account-independent transcript
// in ~/.claude/projects. So we can make every account's Recents show all sessions
// by copying the index files from other accounts into the active account's folder.
//
// macOS desktop app only. The cloud "Chat" conversations (claude.ai) are NOT here —
// they live server-side per account and cannot be merged locally.
const fs = require('fs');
const path = require('path');
const claude = require('./claude');

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

  const cfg = claude.readConfig(ctx.claudeConfigPath);
  const oa = cfg && cfg.oauthAccount;
  if (!oa || !oa.accountUuid || !oa.organizationUuid) {
    return { ok: false, merged: 0, reason: 'no active account (accountUuid/organizationUuid) in ~/.claude.json' };
  }

  const activeDir = path.join(store, oa.accountUuid, oa.organizationUuid);
  fs.mkdirSync(activeDir, { recursive: true });

  // Sessions already present in the active account (dedupe by cliSessionId).
  const seen = Object.create(null);
  listIndexFiles(activeDir).forEach(function (f) { const id = cliIdOf(path.join(activeDir, f)); if (id) seen[id] = true; });

  // Plan the copies first — so we only back up / write when there is actually work.
  const plan = [];
  listDirs(store).forEach(function (acct) {
    if (acct === oa.accountUuid) return;
    listDirs(path.join(store, acct)).forEach(function (org) {
      const src = path.join(store, acct, org);
      listIndexFiles(src).forEach(function (f) {
        const id = cliIdOf(path.join(src, f));
        if (id && seen[id]) return;
        const dest = path.join(activeDir, f);
        if (fs.existsSync(dest)) return; // same index file already here
        plan.push({ from: path.join(src, f), to: dest });
        if (id) seen[id] = true;
      });
    });
  });

  if (!plan.length) return { ok: true, merged: 0, backup: null, activeDir: activeDir };

  // Back up the store once (only when we will change it), and keep only the last few.
  let backup = null;
  try {
    const ts = String(ctx.now()).replace(/[:.]/g, '-');
    backup = path.join(ctx.configDir, 'backups', BACKUP_PREFIX + ts);
    copyTree(store, backup);
    pruneBackups(ctx.configDir, BACKUPS_TO_KEEP);
  } catch (e) { backup = null; }

  let merged = 0;
  plan.forEach(function (p) { try { fs.copyFileSync(p.from, p.to); merged += 1; } catch (e) { /* skip */ } });
  return { ok: true, merged: merged, backup: backup, activeDir: activeDir };
}

module.exports = { consolidate: consolidate, pruneBackups: pruneBackups };
