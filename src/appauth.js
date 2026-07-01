'use strict';
// Switch the Claude *desktop app*'s own login (separate from the CLI creds).
//
// The app keeps its OAuth login as encrypted blobs in
//   <appData>/config.json  ->  "oauth:tokenCache" and "oauth:tokenCacheV2"
// encrypted with a machine-stable key in the Keychain ("Claude Safe Storage").
// The account is inside the token (no plaintext account field), so swapping these
// blobs — while the app is closed — logs the app into the other account without a
// manual re-login. We snapshot them per profile on `add` and restore on `switch`.
//
// macOS desktop app only.
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./fsutil');

const KEYS = ['oauth:tokenCache', 'oauth:tokenCacheV2'];

function configPath(ctx) { return ctx.appDataDir ? path.join(ctx.appDataDir, 'config.json') : null; }
// Kept in an "app/" subdir so it never shows up in profiles.list() (which scans
// configDir for <name>.json).
function profilePath(ctx, name) { return path.join(ctx.configDir, 'app', name + '.json'); }
function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }

function hasProfile(ctx, name) {
  try { return fs.existsSync(profilePath(ctx, name)); } catch (e) { return false; }
}

// Best-effort: which org the desktop app is currently signed into, inferred from
// the most recently touched "dxt:allowlistLastUpdated:<orgUuid>" key in config.json.
// Lets `capture-app` attach the token to the right account without trusting the CLI.
function detectActiveOrg(ctx) {
  const cp = configPath(ctx);
  if (!cp) return null;
  const cfg = readJSON(cp);
  if (!cfg) return null;
  let best = null, bestTs = '';
  Object.keys(cfg).forEach(function (k) {
    const m = /^dxt:allowlistLastUpdated:(.+)$/.exec(k);
    if (m && typeof cfg[k] === 'string' && cfg[k] > bestTs) { bestTs = cfg[k]; best = m[1]; }
  });
  return best;
}

// Capture the app's current login tokens into profile <name>.
function snapshotToProfile(ctx, name) {
  const cp = configPath(ctx);
  if (!cp) return { ok: false, reason: 'only the macOS desktop app has this' };
  const cfg = readJSON(cp);
  if (!cfg) return { ok: false, reason: 'no desktop config.json' };
  const snap = {};
  let any = false;
  KEYS.forEach(function (k) { if (typeof cfg[k] === 'string' && cfg[k]) { snap[k] = cfg[k]; any = true; } });
  if (!any) return { ok: false, reason: 'no desktop login token in config.json' };
  atomicWrite(profilePath(ctx, name), JSON.stringify(snap, null, 2), 0o600);
  return { ok: true };
}

function pruneConfigBackups(ctx, keep) {
  try {
    const bdir = path.join(ctx.configDir, 'backups');
    const entries = fs.readdirSync(bdir).filter(function (n) { return n.indexOf('config-') === 0; }).sort();
    for (let i = 0; i < entries.length - keep; i++) fs.rmSync(path.join(bdir, entries[i]), { force: true });
  } catch (e) { /* ignore */ }
}

// Restore profile <name>'s desktop login into config.json. App must be closed.
function applyFromProfile(ctx, name) {
  const cp = configPath(ctx);
  if (!cp) return { ok: false, reason: 'only the macOS desktop app has this' };
  const snap = readJSON(profilePath(ctx, name));
  if (!snap) return { ok: false, reason: 'no saved desktop login for this profile' };
  const cfg = readJSON(cp);
  if (!cfg) return { ok: false, reason: 'no desktop config.json' };

  // Back up config.json once (keep the last few).
  try {
    const ts = String(ctx.now()).replace(/[:.]/g, '-');
    const backup = path.join(ctx.configDir, 'backups', 'config-' + ts + '.json');
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.copyFileSync(cp, backup);
    pruneConfigBackups(ctx, 5);
  } catch (e) { /* non-fatal */ }

  // Restore exactly the snapshot's token keys; clear any counterpart that isn't in
  // the snapshot, so we never leave a stale V1/V2 blob from the previous account.
  let changed = false;
  KEYS.forEach(function (k) {
    if (typeof snap[k] === 'string') { cfg[k] = snap[k]; changed = true; }
    else if (k in cfg) { delete cfg[k]; changed = true; }
  });
  if (!changed) return { ok: false, reason: 'saved desktop login was empty' };

  let mode = 0o600;
  try { mode = fs.statSync(cp).mode & 0o777; } catch (e) { /* keep default */ }
  atomicWrite(cp, JSON.stringify(cfg, null, 2), mode);
  return { ok: true };
}

// Sign the desktop app out: remove its login tokens from config.json (app closed).
function signOutApp(ctx) {
  const cp = configPath(ctx);
  if (!cp) return { ok: false, reason: 'only the macOS desktop app has this' };
  const cfg = readJSON(cp);
  if (!cfg) return { ok: false, reason: 'no desktop config.json' };
  let changed = false;
  KEYS.forEach(function (k) { if (k in cfg) { delete cfg[k]; changed = true; } });
  if (!changed) return { ok: false, reason: 'already signed out' };
  try {
    const ts = String(ctx.now()).replace(/[:.]/g, '-');
    const backup = path.join(ctx.configDir, 'backups', 'config-' + ts + '.json');
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.copyFileSync(cp, backup);
    pruneConfigBackups(ctx, 5);
  } catch (e) { /* non-fatal */ }
  let mode = 0o600;
  try { mode = fs.statSync(cp).mode & 0o777; } catch (e) { /* keep default */ }
  atomicWrite(cp, JSON.stringify(cfg, null, 2), mode);
  return { ok: true };
}

module.exports = {
  snapshotToProfile: snapshotToProfile,
  applyFromProfile: applyFromProfile,
  signOutApp: signOutApp,
  hasProfile: hasProfile,
  detectActiveOrg: detectActiveOrg,
  configPath: configPath,
  profilePath: profilePath,
  KEYS: KEYS,
};
