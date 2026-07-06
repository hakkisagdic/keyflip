'use strict';
// Tests for Phase 2/3 browser-session management (src/browser.js). The live
// claude.ai calls and real Cookies-DB writes can't be unit-tested, so we cover
// the browser catalog, Keychain key read, the v10 cookie decrypt/parse (with an
// encrypt fixture), and the destructive-op guards.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const browser = require('../src/browser');

// Encrypt like Chromium's macOS v10 scheme so we can round-trip parseCookieRows.
function encV10(plain, password) {
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from('v10'), c.update(Buffer.from(plain)), c.final()]);
}
function row(name, plain, pw) { return name + '\x01X\'' + encV10(plain, pw).toString('hex') + '\''; }

test('installed() returns only browsers whose Cookies DB exists', function () {
  const got = browser.installed('/Users/x', { exists: function (p) { return p.indexOf('Chrome') !== -1; } });
  assert.deepStrictEqual(got.map(function (b) { return b.id; }), ['chrome']);
});

test('catalog maps each browser to its Safe Storage Keychain service', function () {
  const c = browser.catalog('/Users/x');
  assert.strictEqual(c.chrome.service, 'Chrome Safe Storage');
  assert.strictEqual(c.brave.service, 'Brave Safe Storage');
  assert.strictEqual(c.edge.service, 'Microsoft Edge Safe Storage');
  assert.strictEqual(c.arc.service, 'Arc Safe Storage');
});

test('safeKey reads the browser key from the login Keychain', function () {
  const b = browser.catalog('/Users/x').chrome;
  const key = browser.safeKey(b, function (cmd, args) {
    assert.strictEqual(cmd, '/usr/bin/security');
    assert.ok(args.indexOf('Chrome Safe Storage') !== -1);
    return { code: 0, stdout: 'THEKEY\n' };
  });
  assert.strictEqual(key, 'THEKEY');
  assert.strictEqual(browser.safeKey(b, function () { return { code: 44, stdout: '' }; }), null);
});

test('parseCookieRows decrypts v10 cookies and extracts lastActiveOrg', function () {
  const pw = 'pw';
  const rows = [row('lastActiveOrg', 'org-uuid-abc', pw), row('sessionKey', 'sk-value-xyz', pw)].join('\n');
  const parsed = browser.parseCookieRows(rows, pw);
  assert.ok(parsed);
  assert.strictEqual(parsed.org, 'org-uuid-abc');
  assert.ok(parsed.cookie.indexOf('lastActiveOrg=org-uuid-abc') !== -1);
  assert.ok(parsed.cookie.indexOf('sessionKey=sk-value-xyz') !== -1);
});

test('parseCookieRows also strips the 32-byte domain-hash prefix (newer Chromium)', function () {
  const pw = 'pw';
  const key = crypto.pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');
  const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  const plain = Buffer.concat([crypto.randomBytes(32), Buffer.from('real-org')]);
  const enc = Buffer.concat([Buffer.from('v10'), c.update(plain), c.final()]);
  const parsed = browser.parseCookieRows('lastActiveOrg\x01X\'' + enc.toString('hex') + '\'', pw);
  assert.strictEqual(parsed.org, 'real-org');
});

test('parseCookieRows returns null when nothing decrypts', function () {
  assert.strictEqual(browser.parseCookieRows('', 'pw'), null);
  assert.strictEqual(browser.parseCookieRows('bad\x01X\'00\'', 'pw'), null);
});

test('clearClaudeCookies refuses while the browser is running (guard)', function () {
  const b = browser.catalog('/Users/x').chrome;
  const r = browser.clearClaudeCookies(b, {
    run: function (cmd) { return cmd.indexOf('pgrep') !== -1 ? { code: 0, stdout: '4242' } : { code: 0 }; },
  });
  assert.deepStrictEqual(r, { ok: false, reason: 'browser-running' });
});

test('clearClaudeCookies reports no-cookies-db when the DB is absent', function () {
  const b = { id: 'x', cookies: '/no/such/Cookies', proc: 'X' };
  const r = browser.clearClaudeCookies(b, { force: true, run: function () { return { code: 0 }; } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no-cookies-db');
});

test('quit issues an osascript "quit" for the browser app', function () {
  const b = browser.catalog('/Users/x').chrome;
  let called = null;
  browser.quit(b, function (cmd, args) { called = { cmd: cmd, args: args }; return { code: 0 }; });
  assert.strictEqual(called.cmd, '/usr/bin/osascript');
  assert.ok(called.args.join(' ').indexOf('tell application "Google Chrome" to quit') !== -1);
});

// ---- browser-session snapshot/restore (gap #1: browser sync on switch) ----
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpCookiesFile() {
  const p = path.join(os.tmpdir(), 'keyflip-test-cookies-' + process.pid + '-' + Math.floor(Math.random() * 1e6));
  fs.writeFileSync(p, 'sqlite-db-bytes');
  return p;
}

test('sessionStorePath keys a saved session by account + browser', function () {
  const p = browser.sessionStorePath('/cfg', 'work', 'chrome');
  assert.strictEqual(p, path.join('/cfg', 'browser-sessions', 'work__chrome.sql'));
});

test('snapshotClaudeCookies returns the INSERT SQL sqlite3 emits', function () {
  const b = { id: 'chrome', cookies: tmpCookiesFile(), proc: 'Google Chrome' };
  const sql = browser.snapshotClaudeCookies(b, {
    run: function (cmd, args) {
      assert.strictEqual(cmd, 'sqlite3');
      assert.ok(args.join(' ').indexOf('.mode insert cookies') !== -1);
      return { code: 0, stdout: "INSERT INTO cookies VALUES('claude.ai','sessionKey',X'deadbeef');\n" };
    },
  });
  assert.ok(sql.indexOf('INSERT INTO cookies') !== -1);
  fs.rmSync(b.cookies, { force: true });
});

test('snapshotClaudeCookies returns null when the Cookies DB is missing', function () {
  const b = { id: 'chrome', cookies: '/no/such/Cookies', proc: 'Google Chrome' };
  assert.strictEqual(browser.snapshotClaudeCookies(b, { run: function () { return { code: 0 }; } }), null);
});

test('restoreClaudeCookies refuses while the browser runs (unless force)', function () {
  const b = { id: 'chrome', cookies: tmpCookiesFile(), proc: 'Google Chrome' };
  const r = browser.restoreClaudeCookies(b, 'INSERT ...', {
    run: function (cmd) { return cmd.indexOf('pgrep') !== -1 ? { code: 0, stdout: '99' } : { code: 0 }; },
  });
  assert.deepStrictEqual(r, { ok: false, reason: 'browser-running' });
  fs.rmSync(b.cookies, { force: true });
});

test('restoreClaudeCookies (force) backs up, then DELETEs + replays the snapshot', function () {
  const b = { id: 'chrome', cookies: tmpCookiesFile(), proc: 'Google Chrome' };
  let script = null;
  const r = browser.restoreClaudeCookies(b, "INSERT INTO cookies VALUES('claude.ai');", {
    force: true,
    run: function (cmd, args, input) { script = input; return { code: 0 }; },
  });
  assert.strictEqual(r.ok, true);
  assert.ok(fs.existsSync(r.backup), 'a backup of the Cookies DB is taken first');
  assert.ok(script.indexOf('DELETE FROM cookies') !== -1);
  assert.ok(script.indexOf('INSERT INTO cookies') !== -1);
  fs.rmSync(b.cookies, { force: true });
  fs.rmSync(r.backup, { force: true });
});

test('restoreClaudeCookies refuses an empty snapshot', function () {
  const b = { id: 'chrome', cookies: tmpCookiesFile(), proc: 'Google Chrome' };
  assert.deepStrictEqual(browser.restoreClaudeCookies(b, '', { force: true }), { ok: false, reason: 'no-snapshot' });
  fs.rmSync(b.cookies, { force: true });
});

test('saveSession then loadSession round-trips a snapshot through the store', function () {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-store-'));
  const b = { id: 'chrome', cookies: tmpCookiesFile(), proc: 'Google Chrome' };
  const runner = function () { return { code: 0, stdout: "INSERT INTO cookies VALUES('claude.ai');" }; };
  assert.strictEqual(browser.saveSession(cfg, 'work', b, { run: runner }), true);
  const loaded = browser.loadSession(cfg, 'work', b);
  assert.ok(loaded.indexOf('INSERT INTO cookies') !== -1);
  assert.strictEqual(browser.loadSession(cfg, 'other', b), null); // unknown account
  fs.rmSync(b.cookies, { force: true });
  fs.rmSync(cfg, { recursive: true, force: true });
});
