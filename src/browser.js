'use strict';
// Phase 2/3: read and manage the BROWSER's claude.ai session. The Claude Chrome
// extension has NO login of its own — it inherits the browser's claude.ai cookies.
// The native-messaging bridge rejects the connection ("Invalid token or user
// mismatch") when the browser's claude.ai account != the active CLI/desktop
// account. So keyflip must see, and be able to reset, the browser session too.
//
// Cookie decryption reuses chat.js's Chromium v10 scheme, but with each BROWSER's
// own "Safe Storage" Keychain key (Chrome/Brave/Edge/Arc), not Claude's.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./exec');
const { decryptCookie } = require('./chat');

// Known Chromium browsers: default-profile Cookies DB, the macOS login-Keychain
// service/account that holds their cookie key, and the process name (for the
// "is it running?" guard before we touch the on-disk Cookies DB).
function catalog(home) {
  const AS = path.join(home, 'Library', 'Application Support');
  return {
    chrome: { id: 'chrome', name: 'Chrome', cookies: path.join(AS, 'Google', 'Chrome', 'Default', 'Cookies'), service: 'Chrome Safe Storage', account: 'Chrome', proc: 'Google Chrome' },
    brave: { id: 'brave', name: 'Brave', cookies: path.join(AS, 'BraveSoftware', 'Brave-Browser', 'Default', 'Cookies'), service: 'Brave Safe Storage', account: 'Brave', proc: 'Brave Browser' },
    edge: { id: 'edge', name: 'Edge', cookies: path.join(AS, 'Microsoft Edge', 'Default', 'Cookies'), service: 'Microsoft Edge Safe Storage', account: 'Microsoft Edge', proc: 'Microsoft Edge' },
    arc: { id: 'arc', name: 'Arc', cookies: path.join(AS, 'Arc', 'User Data', 'Default', 'Cookies'), service: 'Arc Safe Storage', account: 'Arc', proc: 'Arc' },
  };
}

// Chromium browsers actually present on this machine (a Cookies DB exists).
function installed(home, opts) {
  opts = opts || {};
  const exists = opts.exists || fs.existsSync;
  const all = catalog(home);
  return Object.keys(all).map(function (k) { return all[k]; }).filter(function (b) { return exists(b.cookies); });
}

// The browser's cookie-encryption key from the login Keychain (macOS).
function safeKey(b, runner) {
  const r = (runner || run)('/usr/bin/security', ['find-generic-password', '-s', b.service, '-a', b.account, '-w']);
  return r && r.code === 0 ? String(r.stdout).replace(/\r?\n$/, '') : null;
}

// Is the browser running? Writing its on-disk Cookies DB while it runs is unsafe
// (Chromium keeps cookies in memory and rewrites on exit), so callers guard on it.
function isRunning(b, runner) {
  const r = (runner || run)('/usr/bin/pgrep', ['-x', b.proc]);
  return !!(r && r.code === 0 && String(r.stdout).trim());
}

// Gracefully quit the browser (macOS) so its Cookies DB unlocks and we can clear it.
function quit(b, runner) {
  return (runner || run)('/usr/bin/osascript', ['-e', 'tell application "' + b.proc + '" to quit']);
}

// Read + decrypt this browser's claude.ai cookies. Returns { cookie, org } | null,
// where `org` is the lastActiveOrg cookie (the account's org uuid) if present.
function readClaudeCookies(b, opts) {
  opts = opts || {};
  const runner = opts.run || run;
  const key = opts.key || safeKey(b, runner);
  if (!key) return null;
  const tmp = path.join(os.tmpdir(), 'keyflip-bck-' + process.pid + '-' + b.id + '.db');
  try { fs.copyFileSync(b.cookies, tmp); } catch (e) { return null; }
  try {
    const r = runner('sqlite3', ['-separator', '\x01', 'file:' + tmp + '?mode=ro',
      "SELECT name,quote(encrypted_value) FROM cookies WHERE host_key LIKE '%claude.ai';"]);
    if (!r || r.code !== 0) return null;
    return parseCookieRows(r.stdout, key);
  } finally { try { fs.rmSync(tmp, { force: true }); } catch (e) { /* ignore */ } }
}

// Parse the sqlite `name\x01X'hex'` rows and decrypt each. Split out for testing.
function parseCookieRows(stdout, key) {
  const pairs = [];
  let org = null;
  String(stdout || '').trim().split('\n').forEach(function (line) {
    const i = line.indexOf('\x01');
    if (i === -1) return;
    const name = line.slice(0, i);
    const hex = line.slice(i + 1).replace(/^X'|'$/g, '');
    let val = null;
    try { val = decryptCookie(Buffer.from(hex, 'hex'), key); } catch (e) { val = null; }
    if (val == null) return;
    pairs.push(name + '=' + val);
    if (name === 'lastActiveOrg') org = val;
  });
  if (!pairs.length) return null;
  return { cookie: pairs.join('; '), org: org };
}

// Snapshot this browser's claude.ai cookie ROWS as portable INSERT statements
// (encrypted_value bytes preserved verbatim — no decrypt, so it works even for
// app-bound v20 cookies as long as it's the same browser+machine). Returns the SQL
// string, or null. Used to save an account's browser session for later restore.
function snapshotClaudeCookies(b, opts) {
  opts = opts || {};
  const runner = opts.run || run;
  const tmp = path.join(os.tmpdir(), 'keyflip-snap-' + process.pid + '-' + b.id + '.db');
  try { fs.copyFileSync(b.cookies, tmp); } catch (e) { return null; }
  try {
    const r = runner('sqlite3', ['-cmd', '.mode insert cookies', 'file:' + tmp + '?mode=ro',
      "SELECT * FROM cookies WHERE host_key LIKE '%claude.ai';"]);
    if (!r || r.code !== 0) return null;
    const sql = String(r.stdout || '').trim();
    return sql || null;
  } finally { try { fs.rmSync(tmp, { force: true }); } catch (e) { /* ignore */ } }
}

// Restore a saved claude.ai session (from snapshotClaudeCookies) into this browser:
// drop the current claude.ai cookies, re-insert the saved rows. REFUSES while the
// browser runs (unless force) and backs up the Cookies DB first.
function restoreClaudeCookies(b, sql, opts) {
  opts = opts || {};
  const runner = opts.run || run;
  if (!sql) return { ok: false, reason: 'no-snapshot' };
  if (!opts.force && isRunning(b, runner)) return { ok: false, reason: 'browser-running' };
  let backup;
  try { backup = b.cookies + '.keyflip-bak'; fs.copyFileSync(b.cookies, backup); } catch (e) { return { ok: false, reason: 'no-cookies-db' }; }
  const script = "DELETE FROM cookies WHERE host_key LIKE '%claude.ai';\n" + sql + '\n';
  const r = runner('sqlite3', [b.cookies], script);
  if (!r || r.code !== 0) return { ok: false, reason: 'sqlite-failed', detail: r && r.stderr, backup: backup };
  return { ok: true, backup: backup };
}

// Phase 3 (conservative): clear this browser's claude.ai cookies so the next
// visit prompts a fresh login as the right account. Backs up the Cookies DB
// first and REFUSES while the browser is running (unless force). Reversible via
// the returned backup path.
function clearClaudeCookies(b, opts) {
  opts = opts || {};
  const runner = opts.run || run;
  if (!opts.force && isRunning(b, runner)) return { ok: false, reason: 'browser-running' };
  let backup;
  try {
    backup = b.cookies + '.keyflip-bak';
    fs.copyFileSync(b.cookies, backup);
  } catch (e) { return { ok: false, reason: 'no-cookies-db' }; }
  const r = runner('sqlite3', [b.cookies, "DELETE FROM cookies WHERE host_key LIKE '%claude.ai';"]);
  if (!r || r.code !== 0) return { ok: false, reason: 'sqlite-failed', detail: r && r.stderr, backup: backup };
  return { ok: true, backup: backup };
}

// Where keyflip stores a saved browser (claude.ai) session per account+browser.
function sessionStorePath(configDir, name, browserId) {
  return path.join(configDir, 'browser-sessions', name + '__' + browserId + '.sql');
}
// Snapshot the account's current browser session and stash it (best-effort).
function saveSession(configDir, name, b, opts) {
  const sql = snapshotClaudeCookies(b, opts);
  if (!sql) return false;
  const p = sessionStorePath(configDir, name, b.id);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, sql, { mode: 0o600 });
    try { fs.chmodSync(p, 0o600); } catch (e) { /* non-POSIX FS */ } // tighten a pre-existing loose file
    return true;
  } catch (e) { return false; }
}
function loadSession(configDir, name, b) {
  try { return fs.readFileSync(sessionStorePath(configDir, name, b.id), 'utf8'); } catch (e) { return null; }
}

module.exports = {
  catalog: catalog,
  installed: installed,
  sessionStorePath: sessionStorePath,
  saveSession: saveSession,
  loadSession: loadSession,
  safeKey: safeKey,
  isRunning: isRunning,
  quit: quit,
  readClaudeCookies: readClaudeCookies,
  parseCookieRows: parseCookieRows,
  clearClaudeCookies: clearClaudeCookies,
  snapshotClaudeCookies: snapshotClaudeCookies,
  restoreClaudeCookies: restoreClaudeCookies,
};
