'use strict';
// Tests for the `keyflip login` helpers (src/login.js) — the browser OAuth itself
// can't be unit-tested, so we cover credential-reading, the macOS Keychain service
// derivation, status parsing, and the non-interactive refusal.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const login = require('../src/login');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-login-')); }

test('buildLoginArgs wires --sso / --console / --email into `claude auth login` (#7)', function () {
  assert.deepStrictEqual(login.buildLoginArgs({}), ['auth', 'login', '--claudeai']);
  assert.deepStrictEqual(login.buildLoginArgs({ sso: true }), ['auth', 'login', '--claudeai', '--sso']);
  assert.deepStrictEqual(login.buildLoginArgs({ useConsole: true }), ['auth', 'login', '--console']);
  assert.deepStrictEqual(login.buildLoginArgs({ sso: true, useConsole: true, email: 'you@corp.com' }),
    ['auth', 'login', '--console', '--sso', '--email', 'you@corp.com']);
  // no --sso unless asked — guards against the flag silently drifting off
  assert.strictEqual(login.buildLoginArgs({ email: 'a@b.c' }).indexOf('--sso'), -1);
});

test('isoKeychainService derives "Claude Code-credentials-<8 hex>" and is deterministic', function () {
  const a = login.isoKeychainService('/some/dir');
  assert.match(a, /^Claude Code-credentials-[0-9a-f]{8}$/);
  assert.strictEqual(a, login.isoKeychainService('/some/dir'));
  assert.notStrictEqual(a, login.isoKeychainService('/other/dir'));
});

test('validBlob accepts a real OAuth blob, rejects junk and empty tokens', function () {
  assert.ok(login.validBlob(JSON.stringify({ claudeAiOauth: { accessToken: 'x' } })));
  assert.strictEqual(login.validBlob('not json'), null);
  assert.strictEqual(login.validBlob(JSON.stringify({ claudeAiOauth: {} })), null);
  assert.strictEqual(login.validBlob(JSON.stringify({ claudeAiOauth: { accessToken: '   ' } })), null);
});

test('readIsolatedCredential reads the isolated .credentials.json; null when absent', function () {
  const d = tmp();
  fs.writeFileSync(path.join(d, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok123', refreshToken: 'r' } }));
  const got = login.readIsolatedCredential(d, { platform: 'linux' });
  assert.ok(got && JSON.parse(got).claudeAiOauth.accessToken === 'tok123');
  assert.strictEqual(login.readIsolatedCredential(tmp(), { platform: 'linux' }), null);
});

test('readIsolatedCredential falls back to the hashed Keychain on macOS', function () {
  const d = tmp(); // no .credentials.json file
  const svc = login.isoKeychainService(d);
  let asked = null;
  const fakeRun = function (cmd, args) {
    asked = { cmd: cmd, args: args };
    return { code: 0, stdout: JSON.stringify({ claudeAiOauth: { accessToken: 'kc-tok' } }) };
  };
  const got = login.readIsolatedCredential(d, { platform: 'darwin', run: fakeRun });
  assert.ok(got && JSON.parse(got).claudeAiOauth.accessToken === 'kc-tok');
  assert.strictEqual(asked.cmd, '/usr/bin/security');
  assert.ok(asked.args.indexOf(svc) !== -1, 'queried the hashed service');
});

test('parseAuthStatus extracts identity fields', function () {
  const st = login.parseAuthStatus(JSON.stringify({ loggedIn: true, email: 'a@x.com', orgId: 'o1', orgName: 'Org', subscriptionType: 'max' }));
  assert.deepStrictEqual(st, { email: 'a@x.com', orgId: 'o1', orgName: 'Org', plan: 'max', loggedIn: true });
  assert.strictEqual(login.parseAuthStatus('garbage'), null);
});

test('`keyflip login` refuses in --json mode (interactive/browser)', function () {
  const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');
  const r = require('child_process').spawnSync(process.execPath, [BIN, '--json', 'login'], { encoding: 'utf8', input: '' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /interactive|browser/);
});

test('extractCode pulls the OAuth code from a bare code or a redirect URL', function () {
  assert.strictEqual(login.extractCode('ABC123'), 'ABC123');
  assert.strictEqual(login.extractCode('  spaced-code  '), 'spaced-code');
  assert.strictEqual(login.extractCode('https://platform.claude.com/oauth/code/callback?code=XYZ%2F789&state=s'), 'XYZ/789');
  assert.strictEqual(login.extractCode('https://x/cb?state=s&code=CODE9&foo=1'), 'CODE9');
});
