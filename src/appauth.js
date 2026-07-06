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
const profiles = require('./profiles');

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
  // An explicitly-set property (even null) is authoritative — lets tests inject a
  // locked/denied keychain without shelling out to the real `security` binary.
  if (ctx && Object.prototype.hasOwnProperty.call(ctx, 'safeStoragePassword')) return ctx.safeStoragePassword;
  const r = run('/usr/bin/security', ['find-generic-password', '-s', 'Claude Safe Storage', '-a', 'Claude Key', '-w']);
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

// The account folder (in claude-code-sessions) whose org subfolder matches `org`.
function accountForOrg(ctx, org) {
  if (!org || !ctx.appDataDir) return null;
  const store = path.join(ctx.appDataDir, 'claude-code-sessions');
  let accts; try { accts = fs.readdirSync(store); } catch (e) { return null; }
  for (const a of accts) {
    let orgs; try { orgs = fs.readdirSync(path.join(store, a)); } catch (e) { continue; }
    if (orgs.indexOf(org) !== -1) return a;
  }
  return null;
}

// Best-effort email for an account uuid — the app scatters it across a couple of
// per-account stores, so try both.
function emailForAccount(ctx, account) {
  if (!account || !ctx.appDataDir) return null;
  return findEmailUnder(path.join(ctx.appDataDir, 'local-agent-mode-sessions', account), 80) ||
         findEmailUnder(path.join(ctx.appDataDir, 'claude-code-sessions', account), 80) ||
         null;
}

// Identify the account the desktop app is CURRENTLY signed into, independent of
// the CLI. Primary signal: decrypt the token cache -> org uuid -> account -> email.
// When that's unavailable (no cache yet, keychain locked, decrypt fails) it FALLS
// BACK to the config's allowlist timestamps, which still name the active org — enough
// to match a saved profile. ALWAYS returns { org, account, email, reason } (fields may
// be null); `reason` names why a read is partial: 'no-desktop-config' | 'no-token-cache'
// | 'keychain-locked' | 'decrypt-failed', or null on a full decrypt.
function detectAppAccount(ctx) {
  if (!ctx || !ctx.appDataDir) return { org: null, account: null, email: null, reason: 'no-desktop-config' };
  const cfg = readJSON(configPath(ctx));
  if (!cfg) return { org: null, account: null, email: null, reason: 'no-desktop-config' };

  const orgFromCfg = detectActiveOrg(ctx); // most-recently-touched allowlist org (no keychain access)
  function fromConfigOnly(reason) {
    // The allowlist org is only trustworthy if the app is ACTUALLY signed in — otherwise
    // it's stale (signOutApp leaves the allowlist keys), which would falsely present a
    // signed-out app as an account. Keep the caller's `reason` (locked/decrypt/no-cache)
    // so the hint stays accurate.
    const org = cookiesLookLoggedIn(cookiesPath(ctx)) ? (orgFromCfg || null) : null;
    const acct = accountForOrg(ctx, org);
    return { org: org, account: acct, email: emailForAccount(ctx, acct), reason: reason };
  }

  let blob = null;
  ['oauth:tokenCacheV2', 'oauth:tokenCache'].forEach(function (k) {
    if (!blob && typeof cfg[k] === 'string' && isV10(cfg[k])) blob = cfg[k];
  });
  if (!blob) return fromConfigOnly('no-token-cache'); // no v10 blob -> config-only (avoids a Keychain prompt)
  const pw = getSafeStoragePassword(ctx);
  if (!pw) return fromConfigOnly('keychain-locked');
  const text = decryptBlob(blob, pw);
  if (!text) return fromConfigOnly('decrypt-failed');

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
  // Fall back to the allowlist org ONLY if the decrypted token corroborates it — using
  // the most-recent allowlist org unconditionally can confidently mislabel a brand-new
  // account (whose org isn't in the allowlist yet) as a different, stale one.
  if (!org && orgFromCfg && uuids.indexOf(orgFromCfg) !== -1) org = orgFromCfg;
  if (org && !account) account = accountForOrg(ctx, org);
  // A decrypt that yields no resolvable org is ambiguous — don't present it as confident.
  return { org: org || null, account: account || null, email: emailForAccount(ctx, account), reason: org ? null : 'unresolved-org' };
}

// Does a cookie DB (or a snapshot of it) contain the claude.ai login cookie?
// Cookie NAMES are plaintext in Chromium's DB, so a substring scan is reliable
// and works on non-SQLite test fixtures too.
function cookiesLookLoggedIn(file) {
  try { return fs.readFileSync(file).includes('sessionKey'); } catch (e) { return false; }
}

// Copy the live Cookies DB as consistently as possible: prefer sqlite3's online
// .backup (safe while the app writes), fall back to a plain copy.
function copyCookieDb(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.rmSync(dest, { force: true }); } catch (e) { /* ignore */ }
  const r = run('sqlite3', [src, '.backup "' + dest.replace(/"/g, '""') + '"']);
  if (r.code !== 0 || !fs.existsSync(dest)) fs.copyFileSync(src, dest);
  try { fs.chmodSync(dest, 0o600); } catch (e) { /* best effort */ }
}

// Capture the app's current login (token cache + the session Cookies DB that is
// the actual auth) into profile <name>. Returns { ok, cookies } where cookies is
// 'ok' | 'incomplete' | 'missing' — 'incomplete' means the DB was copied but has
// no sessionKey yet (Chromium hadn't flushed a fresh login to disk; capturing
// again with the app closed fixes it).
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
  let cookies = 'missing';
  try {
    const ck = cookiesPath(ctx);
    if (ck && fs.existsSync(ck)) {
      const dest = profileCookiesPath(ctx, name);
      copyCookieDb(ck, dest);
      cookies = cookiesLookLoggedIn(dest) ? 'ok' : 'incomplete';
    }
  } catch (e) { /* cookies snapshot is best-effort */ }
  return { ok: true, cookies: cookies };
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

  // The session cookie IS the login. Refuse to restore a snapshot without it —
  // that would boot the app straight to the login screen (better to leave the
  // current session in place and say why).
  const savedCkPre = profileCookiesPath(ctx, name);
  if (!fs.existsSync(savedCkPre) || !cookiesLookLoggedIn(savedCkPre)) {
    return { ok: false, reason: "saved desktop login for '" + name + "' has no session cookie — " +
      "sign the app into that account and run 'keyflip add' again" };
  }

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

// Which saved profile is the desktop app CURRENTLY signed into? Identified by the
// org uuid inside its (rotating) token — stable per account, unlike token/cookie
// values. Returns the profile name, or null. (Decrypts the token cache; may prompt
// the Keychain once — so call sparingly, not on every render.)
function activeProfileName(ctx) {
  const det = detectAppAccount(ctx);
  if (!det || !det.org) return null;
  const names = profiles.list(ctx.configDir);
  for (let i = 0; i < names.length; i++) {
    const m = profiles.read(ctx.configDir, names[i]);
    if (m && m.oauthAccount && m.oauthAccount.organizationUuid === det.org) return names[i];
  }
  return null;
}

module.exports = {
  snapshotToProfile: snapshotToProfile,
  applyFromProfile: applyFromProfile,
  signOutApp: signOutApp,
  activeProfileName: activeProfileName,
  hasProfile: hasProfile,
  detectActiveOrg: detectActiveOrg,
  detectAppAccount: detectAppAccount,
  cookiesLookLoggedIn: cookiesLookLoggedIn,
  decryptBlob: decryptBlob,
  configPath: configPath,
  profilePath: profilePath,
  cookiesPath: cookiesPath,
  profileCookiesPath: profileCookiesPath,
  KEYS: KEYS,
};
