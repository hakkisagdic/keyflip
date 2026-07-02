'use strict';
// Tests for: structured process detection (#10), live-account guard (#11),
// store reconciliation (#14), learned keychain fallback (#15), migrations (#18).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const platform = require('../src/platform');
const { HybridStore, KeychainStore, FileStore, reconcileStaleKeychain } = require('../src/stores');
const migrations = require('../src/migrations');
const profiles = require('../src/profiles');
const { tmpdir } = require('./helpers');

// ---- claudeInstances ----
test('claudeInstances reads live sessions from ~/.claude/sessions/<pid>.json', function () {
  const home = tmpdir();
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, process.pid + '.json'),
    JSON.stringify({ pid: process.pid, cwd: '/tmp/x', entrypoint: 'cli' }));
  fs.writeFileSync(path.join(dir, '999999.json'),
    JSON.stringify({ pid: 999999, cwd: '/tmp/dead', entrypoint: 'cli' })); // dead pid
  fs.writeFileSync(path.join(dir, 'junk.txt'), 'ignore');
  const live = platform.claudeInstances(home);
  assert.strictEqual(live.length, 1);
  assert.strictEqual(live[0].pid, process.pid);
  assert.strictEqual(live[0].cwd, '/tmp/x');
});

test('claudeInstances is empty without a sessions dir', function () {
  assert.deepStrictEqual(platform.claudeInstances(tmpdir()), []);
});

// ---- HybridStore learned fallback ----
function lockedRunner() {
  return function () { return { code: 36, stdout: '', stderr: 'keychain locked', timedOut: false }; };
}
function okRunner(value) {
  return function (cmd, args) {
    if (args[0] === 'find-generic-password') return { code: 0, stdout: value + '\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
}

test('HybridStore falls back to the file store for profiles when the keychain is locked', function () {
  const home = tmpdir();
  const kc = new KeychainStore({ account: 'me', runner: lockedRunner() });
  const file = new FileStore({ credsFilePath: path.join(home, 'creds.json'), profileCredDir: path.join(home, 'creds') });
  const s = new HybridStore(kc, file);
  s.setProfile('alice', 'BLOB');            // keychain throws EKEYCHAIN -> file fallback
  assert.strictEqual(s.fallback, true);
  assert.strictEqual(s.getProfile('alice'), 'BLOB');
  // the live item must NOT silently fall back — Claude reads it from the keychain
  assert.throws(function () { s.setLive('X'); }, function (e) { return e.code === 'EKEYCHAIN'; });
});

test('HybridStore reads file-stored profiles even when the keychain works but has no item', function () {
  const home = tmpdir();
  const kc = new KeychainStore({ account: 'me', runner: function () { return { code: 44, stdout: '', stderr: '' }; } });
  const file = new FileStore({ credsFilePath: path.join(home, 'creds.json'), profileCredDir: path.join(home, 'creds') });
  file.setProfile('bob', 'FILE-BLOB');
  const s = new HybridStore(kc, file);
  assert.strictEqual(s.getProfile('bob'), 'FILE-BLOB');
});

// ---- reconciliation ----
test('reconcileStaleKeychain deletes the live Keychain item after a file-backend write', function () {
  const calls = [];
  const runner = function (cmd, args) { calls.push(args); return { code: 0, stdout: '', stderr: '' }; };
  const ctx = { platform: 'darwin', account: 'me', keychainRunner: runner, store: { type: 'file' } };
  assert.strictEqual(reconcileStaleKeychain(ctx), true);
  assert.strictEqual(calls[0][0], 'delete-generic-password');
  assert.ok(calls[0].indexOf('Claude Code-credentials') !== -1);
});

test('reconcileStaleKeychain is a no-op off macOS or on non-file stores', function () {
  assert.strictEqual(reconcileStaleKeychain({ platform: 'linux', store: { type: 'file' } }), false);
  assert.strictEqual(reconcileStaleKeychain({ platform: 'darwin', store: { type: 'keychain' } }), false);
});

// ---- migrations ----
test('migrations stamp schemaVersion once and are idempotent', function () {
  const home = tmpdir();
  const configDir = path.join(home, '.config', 'keyflip');
  fs.mkdirSync(configDir, { recursive: true });
  // legacy profile without schemaVersion (write raw to bypass the auto-stamp)
  fs.writeFileSync(path.join(configDir, 'old.json'), JSON.stringify({ name: 'old', email: 'o@x.com' }));
  const ctx = { configDir: configDir };
  const first = migrations.runMigrations(ctx);
  assert.ok(first.indexOf('001-stamp-schema-version') !== -1);
  assert.strictEqual(profiles.read(configDir, 'old').schemaVersion, 1);
  const second = migrations.runMigrations(ctx);
  assert.deepStrictEqual(second, []); // recorded as applied
});

test('new profiles are written with schemaVersion', function () {
  const dir = tmpdir();
  profiles.write(dir, { name: 'n', email: 'n@x.com' });
  assert.strictEqual(profiles.read(dir, 'n').schemaVersion, 1);
});
