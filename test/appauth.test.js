'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const appauth = require('../src/appauth');
const profiles = require('../src/profiles');
const { tmpdir } = require('./helpers');

function setup() {
  const home = tmpdir();
  const appDataDir = path.join(home, 'Library', 'Application Support', 'Claude');
  fs.mkdirSync(appDataDir, { recursive: true });
  const cfg = path.join(appDataDir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ locale: 'en-US', 'oauth:tokenCache': 'TOKEN-A-V1', 'oauth:tokenCacheV2': 'TOKEN-A-V2', keep: 'me' }));
  const cookies = path.join(appDataDir, 'Cookies');
  fs.writeFileSync(cookies, 'sessionKey COOKIES-A'); // stands in for the SQLite session DB
  const ctx = { home: home, platform: 'darwin', appDataDir: appDataDir, configDir: path.join(home, '.config', 'keyflip'), now: function () { return '2026-01-01T00:00:00.000Z'; } };
  return { ctx: ctx, cfg: cfg, cookies: cookies };
}

test('snapshotToProfile captures the desktop app login tokens', function () {
  const s = setup();
  const r = appauth.snapshotToProfile(s.ctx, 'A');
  assert.strictEqual(r.ok, true);
  assert.ok(appauth.hasProfile(s.ctx, 'A'));
  const snap = JSON.parse(fs.readFileSync(appauth.profilePath(s.ctx, 'A'), 'utf8'));
  assert.strictEqual(snap['oauth:tokenCacheV2'], 'TOKEN-A-V2');
  assert.strictEqual(snap['oauth:tokenCache'], 'TOKEN-A-V1');
});

test('applyFromProfile restores tokens, preserves other keys, and backs up', function () {
  const s = setup();
  appauth.snapshotToProfile(s.ctx, 'A');
  // app is now logged in as B
  fs.writeFileSync(s.cfg, JSON.stringify({ locale: 'en-US', 'oauth:tokenCache': 'TOKEN-B-V1', 'oauth:tokenCacheV2': 'TOKEN-B-V2', keep: 'me', extra: 1 }));
  const r = appauth.applyFromProfile(s.ctx, 'A');
  assert.strictEqual(r.ok, true);
  const cfg = JSON.parse(fs.readFileSync(s.cfg, 'utf8'));
  assert.strictEqual(cfg['oauth:tokenCacheV2'], 'TOKEN-A-V2'); // restored A
  assert.strictEqual(cfg.extra, 1);                            // unrelated keys kept
  assert.strictEqual(cfg.keep, 'me');
  const bdir = path.join(s.ctx.configDir, 'backups');
  assert.ok(fs.readdirSync(bdir).some(function (n) { return n.indexOf('config-') === 0; }), 'config backup made');
});

test('applyFromProfile is not-ok when the profile has no saved desktop login', function () {
  const s = setup();
  assert.strictEqual(appauth.applyFromProfile(s.ctx, 'nope').ok, false);
});

test('snapshot/apply are no-ops without the desktop app (non-macOS)', function () {
  const s = setup();
  s.ctx.appDataDir = null;
  assert.strictEqual(appauth.snapshotToProfile(s.ctx, 'A').ok, false);
  assert.strictEqual(appauth.applyFromProfile(s.ctx, 'A').ok, false);
});

test('snapshotToProfile is not-ok when config.json has no token', function () {
  const s = setup();
  fs.writeFileSync(s.cfg, JSON.stringify({ locale: 'en-US' }));
  assert.strictEqual(appauth.snapshotToProfile(s.ctx, 'A').ok, false);
});

test('snapshot captures the Cookies DB and apply restores it (the real login)', function () {
  const s = setup();
  appauth.snapshotToProfile(s.ctx, 'A'); // captures COOKIES-A
  assert.ok(fs.existsSync(appauth.profileCookiesPath(s.ctx, 'A')));
  // app later logged in as B
  fs.writeFileSync(s.cookies, 'sessionKey COOKIES-B');
  fs.writeFileSync(path.join(path.dirname(s.cookies), 'Cookies-journal'), 'B-journal');
  const r = appauth.applyFromProfile(s.ctx, 'A');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(fs.readFileSync(s.cookies, 'utf8'), 'sessionKey COOKIES-A'); // session restored
  assert.strictEqual(fs.existsSync(path.join(path.dirname(s.cookies), 'Cookies-journal')), false); // stale journal removed
});

test('signOutApp deletes the Cookies DB and strips tokens (with backups)', function () {
  const s = setup();
  const r = appauth.signOutApp(s.ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(fs.existsSync(s.cookies), false); // real login removed
  const cfg = JSON.parse(fs.readFileSync(s.cfg, 'utf8'));
  assert.strictEqual('oauth:tokenCacheV2' in cfg, false);
  assert.strictEqual(cfg.keep, 'me');
  const bdir = path.join(s.ctx.configDir, 'backups');
  const names = fs.readdirSync(bdir);
  assert.ok(names.some(function (n) { return n.indexOf('config-') === 0; }), 'config backed up');
  assert.ok(names.some(function (n) { return n.indexOf('cookies-') === 0; }), 'cookies backed up');
});

test('signOutApp still signs out when only cookies exist (no tokens in config)', function () {
  const s = setup();
  fs.writeFileSync(s.cfg, JSON.stringify({ locale: 'en-US' })); // tokens already gone
  const r = appauth.signOutApp(s.ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(fs.existsSync(s.cookies), false);
});

test('app-login snapshots live in app/ and do NOT pollute profiles.list()', function () {
  const s = setup();
  profiles.write(s.ctx.configDir, { name: 'alice', email: 'a@x.com' });
  appauth.snapshotToProfile(s.ctx, 'alice');
  assert.deepStrictEqual(profiles.list(s.ctx.configDir), ['alice']); // no phantom 'alice.app'
  assert.ok(appauth.hasProfile(s.ctx, 'alice'));
});

test('detectActiveOrg returns the org with the most recent allowlist timestamp', function () {
  const s = setup();
  fs.writeFileSync(s.cfg, JSON.stringify({
    'oauth:tokenCacheV2': 'T',
    'dxt:allowlistLastUpdated:ORG-GMAIL': '2026-07-01T12:00:00.000Z',
    'dxt:allowlistLastUpdated:ORG-YAHOO': '2026-07-01T19:00:00.000Z',
  }));
  assert.strictEqual(appauth.detectActiveOrg(s.ctx), 'ORG-YAHOO');
});

test('detectActiveOrg returns null when there is no app store', function () {
  const s = setup();
  s.ctx.appDataDir = null;
  assert.strictEqual(appauth.detectActiveOrg(s.ctx), null);
});

test('applyFromProfile clears a stale counterpart key (no mismatched V1/V2)', function () {
  const s = setup();
  fs.mkdirSync(path.dirname(appauth.profilePath(s.ctx, 'A')), { recursive: true });
  fs.writeFileSync(appauth.profilePath(s.ctx, 'A'), JSON.stringify({ 'oauth:tokenCache': 'A-V1' })); // only V1
  fs.writeFileSync(appauth.profileCookiesPath(s.ctx, 'A'), 'sessionKey A'); // valid session snapshot
  fs.writeFileSync(s.cfg, JSON.stringify({ 'oauth:tokenCache': 'B-V1', 'oauth:tokenCacheV2': 'B-V2', keep: 'me' })); // app on B, both keys
  const r = appauth.applyFromProfile(s.ctx, 'A');
  assert.strictEqual(r.ok, true);
  const cfg = JSON.parse(fs.readFileSync(s.cfg, 'utf8'));
  assert.strictEqual(cfg['oauth:tokenCache'], 'A-V1');
  assert.strictEqual('oauth:tokenCacheV2' in cfg, false); // stale B-V2 removed
  assert.strictEqual(cfg.keep, 'me');
});

test('snapshot reports cookies:"incomplete" when the live DB lacks the session cookie', function () {
  const s = setup();
  fs.writeFileSync(s.cookies, 'only activitySessionId here'); // fresh login not yet flushed
  const r = appauth.snapshotToProfile(s.ctx, 'A');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.cookies, 'incomplete');
});

test('applyFromProfile refuses to restore a snapshot without a session cookie', function () {
  const s = setup();
  fs.writeFileSync(s.cookies, 'no session here');
  appauth.snapshotToProfile(s.ctx, 'A'); // incomplete snapshot
  const before = fs.readFileSync(s.cfg, 'utf8');
  const r = appauth.applyFromProfile(s.ctx, 'A');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /no session cookie/);
  assert.strictEqual(fs.readFileSync(s.cfg, 'utf8'), before); // nothing was touched
});

function encryptV10(text, password) {
  const crypto = require('crypto');
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from('v10'), c.update(text, 'utf8'), c.final()]).toString('base64');
}

test('decryptBlob round-trips an Electron safeStorage (v10) blob', function () {
  const blob = encryptV10('{"hello":"world"}', 'pw123');
  assert.strictEqual(appauth.decryptBlob(blob, 'pw123'), '{"hello":"world"}');
  assert.strictEqual(appauth.decryptBlob(blob, 'wrong'), null);
  assert.strictEqual(appauth.decryptBlob('bm90LXYxMA==', 'pw123'), null); // not v10
});

test('detectAppAccount identifies org/account/email from the app\'s own data', function () {
  const s = setup();
  const ORG = '48ebd0e4-4225-4565-93b1-beb21171933e', ACCT = '99b327a0-bd81-4e43-b2ef-ee618d301400';
  const obj = {};
  obj['oauth:tokenCacheV2'] = encryptV10('{"org":"' + ORG + '","scopes":[]}', 'pw123');
  obj['dxt:allowlistLastUpdated:' + ORG] = '2026-07-01T00:00:00.000Z';
  fs.writeFileSync(s.cfg, JSON.stringify(obj));
  fs.mkdirSync(path.join(s.ctx.appDataDir, 'claude-code-sessions', ACCT, ORG), { recursive: true });
  const lam = path.join(s.ctx.appDataDir, 'local-agent-mode-sessions', ACCT, ORG);
  fs.mkdirSync(lam, { recursive: true });
  fs.writeFileSync(path.join(lam, 'x.json'), JSON.stringify({ oauthAccount: { emailAddress: 'y@yahoo.com' } }));
  s.ctx.safeStoragePassword = 'pw123';
  const det = appauth.detectAppAccount(s.ctx);
  assert.ok(det);
  assert.strictEqual(det.org, ORG);
  assert.strictEqual(det.account, ACCT);
  assert.strictEqual(det.email, 'y@yahoo.com');
});

test('detectAppAccount reports no-token-cache (no Keychain access) when the blob is not v10', function () {
  const s = setup(); // plain 'TOKEN-A-V2' — not a v10 blob, no allowlist keys
  s.ctx.safeStoragePassword = null; // if it (wrongly) reached the keychain, this proves it didn't need to
  const det = appauth.detectAppAccount(s.ctx);
  assert.strictEqual(det.org, null);
  assert.strictEqual(det.reason, 'no-token-cache');
});

test('detectAppAccount FALLS BACK to the allowlist org when the token cannot be decrypted', function () {
  const s = setup();
  const ORG = '11111111-2222-3333-4444-555555555555', ACCT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  // Non-decryptable token cache, but the config's allowlist still names the active org.
  const cfg = { 'oauth:tokenCacheV2': 'not-a-v10-blob' };
  cfg['dxt:allowlistLastUpdated:' + ORG] = '2026-07-05T00:00:00.000Z';
  fs.writeFileSync(s.cfg, JSON.stringify(cfg));
  fs.mkdirSync(path.join(s.ctx.appDataDir, 'claude-code-sessions', ACCT, ORG), { recursive: true });
  const lam = path.join(s.ctx.appDataDir, 'local-agent-mode-sessions', ACCT, ORG);
  fs.mkdirSync(lam, { recursive: true });
  fs.writeFileSync(path.join(lam, 'x.json'), JSON.stringify({ oauthAccount: { emailAddress: 'z@x.com' } }));
  const det = appauth.detectAppAccount(s.ctx);
  assert.strictEqual(det.org, ORG, 'org recovered from the allowlist');
  assert.strictEqual(det.account, ACCT, 'account recovered by org->folder match');
  assert.strictEqual(det.email, 'z@x.com');
  assert.strictEqual(det.reason, 'no-token-cache');
});

test('detectAppAccount reports keychain-locked when the token is v10 but the key is unavailable', function () {
  const s = setup();
  const ORG = '77777777-8888-9999-0000-111111111111';
  const cfg2 = { 'oauth:tokenCacheV2': encryptV10('{"org":"' + ORG + '"}', 'realpw') };
  cfg2['dxt:allowlistLastUpdated:' + ORG] = '2026-07-05T00:00:00.000Z';
  fs.writeFileSync(s.cfg, JSON.stringify(cfg2));
  s.ctx.safeStoragePassword = null; // simulate a locked/denied keychain
  const det = appauth.detectAppAccount(s.ctx);
  assert.strictEqual(det.org, ORG, 'still names the org from the allowlist');
  assert.strictEqual(det.reason, 'keychain-locked');
});

test('detectAppAccount reports no-desktop-config when there is no app data dir', function () {
  const s = setup();
  s.ctx.appDataDir = null;
  const det = appauth.detectAppAccount(s.ctx);
  assert.strictEqual(det.reason, 'no-desktop-config');
  assert.strictEqual(det.org, null);
});

test('detectAppAccount does NOT surface a stale allowlist org when the app is signed OUT', function () {
  const s = setup();
  const ORG = '33333333-4444-5555-6666-777777777777';
  const cfg = { 'oauth:tokenCacheV2': 'not-a-v10-blob' };
  cfg['dxt:allowlistLastUpdated:' + ORG] = '2026-07-05T00:00:00.000Z';
  fs.writeFileSync(s.cfg, JSON.stringify(cfg));
  fs.writeFileSync(s.cookies, 'logged-out-no-session-cookie'); // no sessionKey => signed out
  const det = appauth.detectAppAccount(s.ctx);
  assert.strictEqual(det.org, null, 'a signed-out app must not present the stale allowlist org');
});

test('detectAppAccount returns unresolved-org (not a stale org) when the token names an unlisted account', function () {
  const s = setup();
  const STALE = '88888888-8888-8888-8888-888888888888', FRESH = '99999999-9999-9999-9999-999999999999';
  // The token decrypts to FRESH (brand-new account, not in the allowlist / no folder yet),
  // while a DIFFERENT account (STALE) holds the most-recent allowlist timestamp.
  const cfg = { 'oauth:tokenCacheV2': encryptV10('{"org":"' + FRESH + '"}', 'pw123') };
  cfg['dxt:allowlistLastUpdated:' + STALE] = '2026-07-05T00:00:00.000Z';
  fs.writeFileSync(s.cfg, JSON.stringify(cfg));
  s.ctx.safeStoragePassword = 'pw123';
  const det = appauth.detectAppAccount(s.ctx);
  assert.notStrictEqual(det.org, STALE, 'must not confidently claim the stale allowlist org');
  assert.strictEqual(det.org, null);
  assert.strictEqual(det.reason, 'unresolved-org');
});
