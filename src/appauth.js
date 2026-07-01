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
const crypto = require('crypto');
const { atomicWrite } = require('./fsutil');
const { run } = require('./exec');

const KEYS = ['oauth:tokenCache', 'oauth:tokenCacheV2'];

// The app's REAL login is its claude.ai session cookie (sessionKey) in the Cookies
// SQLite DB — config.json's oauth:tokenCache is only a derived cache the app
// re-creates from the cookie on launch. So sign-out/switch must handle Cookies too.
function cookiesPath(ctx) { return ctx.appDataDir ? path.join(ctx.appDataDir, 'Cookies') : null; }
function cookiesJournalPath(ctx) { return ctx.appDataDir ? path.join(ctx.appDataDir, 'Cookies-journal') : null; }
function profileCookiesPath(ctx, name) { return path.join(ctx.configDir, 'app', name + '.cookies'); }

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

// ---- decrypting the app's token cache (Electron safeStorage, macOS) ----
// Format: base64( "v10" + AES-128-CBC(data) ), key = PBKDF2-SHA1(password,
// "saltysalt", 1003, 16), IV = 16 spaces; password lives in the login Keychain
// ("Claude Safe Storage"/"Claude Key"). We only use this to identify WHICH
// account the app is signed into — nothing decrypted is ever written or printed.
function isV10(b64) {
  try { return Buffer.from(String(b64), 'base64').slice(0, 3).toString() === 'v10'; }
  catch (e) { return false; }
}
function decryptBlob(b64, password) {
  try {
    const buf = Buffer.from(String(b64), 'base64');
    if (buf.slice(0, 3).toString() !== 'v10') return null;
    const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
    const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    return Buffer.concat([d.update(buf.slice(3)), d.final()]).toString('utf8');
  } catch (e) { return null; }
}
function getSafeStoragePassword(ctx) {
  if (ctx && ctx.safeStoragePassword) return ctx.safeStoragePassword;
  const r = run('security', ['find-generic-password', '-s', 'Claude Safe Storage', '-a', 'Claude Key', '-w']);
  return r.code === 0 ? r.stdout.replace(/\r?\n$/, '') : null;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

// Scan a small tree for an "emailAddress" field (bounded; best-effort).
function findEmailUnder(dir, budget) {
  let left = budget || 80;
  function walk(d) {
    if (left <= 0) return null;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return null; }
    for (const ent of entries) {
      if (left <= 0) return null;
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) { const r = walk(p); if (r) return r; }
      else if (ent.isFile() && /\.(json|backup\.[0-9]+)$/.test(ent.name)) {
        left -= 1;
        try {
          const txt = fs.readFileSync(p, 'utf8');
          const m = /"emailAddress"\s*:\s*"([^"]+)"/.exec(txt);
          if (m) return m[1];
        } catch (e) { /* skip */ }
      }
    }
    return null;
  }
  return walk(dir);
}

// Identify the account the desktop app is CURRENTLY signed into, independent of
// the CLI: decrypt the token cache -> org uuid -> account uuid (via the app's own
// per-account folders) -> email (best-effort from the app's data). Returns
// { org, account, email } (fields may be null) or null.
function detectAppAccount(ctx) {
  const cfg = readJSON(configPath(ctx));
  if (!cfg || !ctx.appDataDir) return null;
  let blob = null;
  ['oauth:tokenCacheV2', 'oauth:tokenCache'].forEach(function (k) {
    if (!blob && typeof cfg[k] === 'string' && isV10(cfg[k])) blob = cfg[k];
  });
  if (!blob) return null; // also avoids a Keychain prompt when there's nothing to decrypt
  const pw = getSafeStoragePassword(ctx);
  if (!pw) return null;
  const text = decryptBlob(blob, pw);
  if (!text) return null;
  const uuids = []; let m;
  const re = new RegExp(UUID_RE.source, 'g');
  while ((m = re.exec(text)) !== null) { if (uuids.indexOf(m[0]) === -1) uuids.push(m[0]); }

  const store = path.join(ctx.appDataDir, 'claude-code-sessions');
  let org = null, account = null;
  uuids.forEach(function (u) { if (!org && cfg['dxt:allowlistLastUpdated:' + u] !== undefined) org = u; });
  const accts = (function () { try { return fs.readdirSync(store); } catch (e) { return []; } })();
  accts.forEach(function (a) {
    let orgs; try { orgs = fs.readdirSync(path.join(store, a)); } catch (e) { return; }
    orgs.forEach(function (o) {
      if (org ? o === org : uuids.indexOf(o) !== -1) { org = org || o; if (!account) account = a; }
    });
  });
  let email = null;
  if (account) email = findEmailUnder(path.join(ctx.appDataDir, 'local-agent-mode-sessions', account));
  return { org: org, account: account, email: email };
}

// Capture the app's current login (token cache + the session Cookies DB that is
// the actual auth) into profile <name>.
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
  try {
    const ck = cookiesPath(ctx);
    if (ck && fs.existsSync(ck)) {
      const dest = profileCookiesPath(ctx, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(ck, dest);
      try { fs.chmodSync(dest, 0o600); } catch (e) { /* best effort */ }
    }
  } catch (e) { /* cookies snapshot is best-effort */ }
  return { ok: true };
}

function pruneConfigBackups(ctx, keep) {
  try {
    const bdir = path.join(ctx.configDir, 'backups');
    ['config-', 'cookies-'].forEach(function (prefix) {
      const entries = fs.readdirSync(bdir).filter(function (n) { return n.indexOf(prefix) === 0; }).sort();
      for (let i = 0; i < entries.length - keep; i++) fs.rmSync(path.join(bdir, entries[i]), { force: true });
    });
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

  // Restore the account's session cookies — the app's actual login. Without this
  // the app just re-authenticates from the old cookie and rewrites the old tokens.
  try {
    const savedCk = profileCookiesPath(ctx, name);
    const ck = cookiesPath(ctx);
    if (ck && fs.existsSync(savedCk)) {
      fs.copyFileSync(savedCk, ck);
      try { fs.rmSync(cookiesJournalPath(ctx), { force: true }); } catch (e) { /* stale journal */ }
    }
  } catch (e) { /* best-effort */ }
  return { ok: true };
}

// Sign the desktop app out: remove its login tokens from config.json (app closed).
function signOutApp(ctx) {
  const cp = configPath(ctx);
  if (!cp) return { ok: false, reason: 'only the macOS desktop app has this' };
  const cfg = readJSON(cp);
  if (!cfg) return { ok: false, reason: 'no desktop config.json' };

  const ck = cookiesPath(ctx);
  const hasCookies = ck && fs.existsSync(ck);
  let hasTokens = false;
  KEYS.forEach(function (k) { if (k in cfg) hasTokens = true; });
  if (!hasTokens && !hasCookies) return { ok: false, reason: 'already signed out' };

  // Back up config.json and the Cookies DB before touching them.
  try {
    const ts = String(ctx.now()).replace(/[:.]/g, '-');
    const bdir = path.join(ctx.configDir, 'backups');
    fs.mkdirSync(bdir, { recursive: true });
    fs.copyFileSync(cp, path.join(bdir, 'config-' + ts + '.json'));
    if (hasCookies) fs.copyFileSync(ck, path.join(bdir, 'cookies-' + ts));
    pruneConfigBackups(ctx, 5);
  } catch (e) { /* non-fatal */ }

  // The real login is the session cookie — delete the Cookies DB (the app
  // recreates an empty one), then strip the derived token cache.
  if (hasCookies) {
    try { fs.rmSync(ck, { force: true }); } catch (e) { /* ignore */ }
    try { fs.rmSync(cookiesJournalPath(ctx), { force: true }); } catch (e) { /* ignore */ }
  }
  KEYS.forEach(function (k) { delete cfg[k]; });
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
  detectAppAccount: detectAppAccount,
  decryptBlob: decryptBlob,
  configPath: configPath,
  profilePath: profilePath,
  cookiesPath: cookiesPath,
  profileCookiesPath: profileCookiesPath,
  KEYS: KEYS,
};
