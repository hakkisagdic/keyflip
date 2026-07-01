'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createStore, MemoryStore, FileStore, KeychainStore } = require('../src/stores');
const { tmpdir } = require('./helpers');

test('FileStore round-trips live and profile credentials', function () {
  const home = tmpdir();
  const store = new FileStore({
    credsFilePath: path.join(home, '.claude', '.credentials.json'),
    profileCredDir: path.join(home, '.config', 'ccswitch', 'creds'),
  });
  assert.strictEqual(store.getLive(), null);
  store.setLive('{"token":"LIVE"}');
  assert.strictEqual(store.getLive(), '{"token":"LIVE"}');

  assert.strictEqual(store.getProfile('alice'), null);
  store.setProfile('alice', 'AL');
  assert.strictEqual(store.getProfile('alice'), 'AL');
  store.delProfile('alice');
  assert.strictEqual(store.getProfile('alice'), null);
});

test('FileStore writes credential files with 0600 (non-Windows)', function (t) {
  if (process.platform === 'win32') return t.skip('POSIX permissions not applicable on Windows');
  const home = tmpdir();
  const credsFilePath = path.join(home, '.claude', '.credentials.json');
  const store = new FileStore({ credsFilePath: credsFilePath, profileCredDir: path.join(home, 'creds') });
  store.setLive('x');
  assert.strictEqual(fs.statSync(credsFilePath).mode & 0o777, 0o600);
});

test('createStore uses the file backend when a credentials file exists (even on macOS)', function () {
  const home = tmpdir();
  const credsFilePath = path.join(home, '.claude', '.credentials.json');
  fs.mkdirSync(path.dirname(credsFilePath), { recursive: true });
  fs.writeFileSync(credsFilePath, '{}');
  const store = createStore({ platform: 'darwin', credsFilePath: credsFilePath, configDir: path.join(home, '.config', 'ccswitch'), account: 'me' });
  assert.strictEqual(store.type, 'file');
});

test('createStore uses Keychain on macOS when no credentials file exists', function () {
  const home = tmpdir();
  const store = createStore({ platform: 'darwin', credsFilePath: path.join(home, 'nope.json'), configDir: path.join(home, 'cfg'), account: 'me' });
  assert.ok(store instanceof KeychainStore);
});

test('createStore defaults to the file backend on Linux/Windows', function () {
  const home = tmpdir();
  const linux = createStore({ platform: 'linux', credsFilePath: path.join(home, 'nope.json'), configDir: path.join(home, 'cfg'), account: 'me' });
  const win = createStore({ platform: 'win32', credsFilePath: path.join(home, 'nope2.json'), configDir: path.join(home, 'cfg'), account: 'me' });
  assert.strictEqual(linux.type, 'file');
  assert.strictEqual(win.type, 'file');
});

test('FileStore preserves credential bytes verbatim, including a trailing newline', function () {
  const home = tmpdir();
  const store = new FileStore({
    credsFilePath: path.join(home, '.claude', '.credentials.json'),
    profileCredDir: path.join(home, 'creds'),
  });
  const blob = '{"token":"X"}\n';
  store.setLive(blob);
  assert.strictEqual(store.getLive(), blob);
});

test('MemoryStore behaves like a store', function () {
  const s = new MemoryStore();
  assert.strictEqual(s.getLive(), null);
  s.setLive('L'); assert.strictEqual(s.getLive(), 'L');
  s.setProfile('p', 'V'); assert.strictEqual(s.getProfile('p'), 'V');
  s.delProfile('p'); assert.strictEqual(s.getProfile('p'), null);
});
