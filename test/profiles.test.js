'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const profiles = require('../src/profiles');
const { tmpdir } = require('./helpers');

test('write/read/exists/email round-trip', function () {
  const dir = tmpdir();
  assert.strictEqual(profiles.exists(dir, 'alice'), false);
  profiles.write(dir, { name: 'alice', email: 'alice@example.com', userID: 'u1', oauthAccount: { emailAddress: 'alice@example.com' }, savedAt: 't' });
  assert.strictEqual(profiles.exists(dir, 'alice'), true);
  const m = profiles.read(dir, 'alice');
  assert.strictEqual(m.email, 'alice@example.com');
  assert.strictEqual(profiles.email(dir, 'alice'), 'alice@example.com');
});

test('list returns sorted names and ignores non-json files', function () {
  const dir = tmpdir();
  profiles.write(dir, { name: 'bravo', email: 'b@x.com' });
  profiles.write(dir, { name: 'alpha', email: 'a@x.com' });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore me');
  assert.deepStrictEqual(profiles.list(dir), ['alpha', 'bravo']);
});

test('remove deletes the metadata file', function () {
  const dir = tmpdir();
  profiles.write(dir, { name: 'gone', email: 'g@x.com' });
  profiles.remove(dir, 'gone');
  assert.strictEqual(profiles.exists(dir, 'gone'), false);
});

test('read/list are safe on a missing directory', function () {
  const dir = path.join(tmpdir(), 'does-not-exist');
  assert.deepStrictEqual(profiles.list(dir), []);
  assert.strictEqual(profiles.read(dir, 'x'), null);
});

test('metadata files are written with 0600 permissions (non-Windows)', function (t) {
  if (process.platform === 'win32') return t.skip('POSIX permissions not applicable on Windows');
  const dir = tmpdir();
  profiles.write(dir, { name: 'secret', email: 's@x.com' });
  const mode = fs.statSync(profiles.metaPath(dir, 'secret')).mode & 0o777;
  assert.strictEqual(mode, 0o600);
});
