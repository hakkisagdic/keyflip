'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const claude = require('../src/claude');
const { tmpdir } = require('./helpers');

test('readConfig returns null for missing/invalid files', function () {
  const p = path.join(tmpdir(), '.claude.json');
  assert.strictEqual(claude.readConfig(p), null);
  fs.writeFileSync(p, 'not json {');
  assert.strictEqual(claude.readConfig(p), null);
});

test('writeConfig preserves unrelated keys and round-trips', function () {
  const p = path.join(tmpdir(), '.claude.json');
  const original = { keepMe: 1, nested: { a: 'b' }, oauthAccount: { emailAddress: 'x@y.com' }, userID: 'u' };
  fs.writeFileSync(p, JSON.stringify(original));
  const cfg = claude.readConfig(p);
  cfg.oauthAccount = { emailAddress: 'new@y.com' };
  cfg.userID = 'u2';
  claude.writeConfig(p, cfg);
  const after = claude.readConfig(p);
  assert.strictEqual(after.keepMe, 1);
  assert.deepStrictEqual(after.nested, { a: 'b' });
  assert.strictEqual(after.oauthAccount.emailAddress, 'new@y.com');
  assert.strictEqual(after.userID, 'u2');
});

test('writeConfig preserves the existing file mode (non-Windows)', function (t) {
  if (process.platform === 'win32') return t.skip('POSIX permissions not applicable on Windows');
  const p = path.join(tmpdir(), '.claude.json');
  fs.writeFileSync(p, JSON.stringify({ a: 1 }), { mode: 0o644 });
  claude.writeConfig(p, { a: 2 });
  assert.strictEqual(fs.statSync(p).mode & 0o777, 0o644);
});

test('currentAccount extracts email/userID or null', function () {
  assert.strictEqual(claude.currentAccount(null), null);
  assert.strictEqual(claude.currentAccount({}), null);
  const acc = claude.currentAccount({ oauthAccount: { emailAddress: 'a@b.com' }, userID: 'u' });
  assert.strictEqual(acc.email, 'a@b.com');
  assert.strictEqual(acc.userID, 'u');
});

test('loadForWrite returns {} when missing but throws on a corrupt file', function () {
  const p = path.join(tmpdir(), '.claude.json');
  assert.deepStrictEqual(claude.loadForWrite(p), {});
  fs.writeFileSync(p, '{ not valid json');
  assert.throws(function () { claude.loadForWrite(p); }, /not valid JSON/);
});

test('writeConfig gives a brand-new file 0600 (non-Windows)', function (t) {
  if (process.platform === 'win32') return t.skip('POSIX permissions not applicable on Windows');
  const p = path.join(tmpdir(), '.claude.json');
  claude.writeConfig(p, { a: 1 });
  assert.strictEqual(fs.statSync(p).mode & 0o777, 0o600);
});

test('writeConfig is not defeated by a stale temp file (mode enforced)', function (t) {
  if (process.platform === 'win32') return t.skip('POSIX permissions not applicable on Windows');
  const p = path.join(tmpdir(), '.claude.json');
  fs.writeFileSync(p, JSON.stringify({ a: 1 }), { mode: 0o600 });
  fs.writeFileSync(p + '.tmp-' + process.pid, 'stale', { mode: 0o644 }); // pre-existing stale temp
  claude.writeConfig(p, { a: 2 });
  assert.strictEqual(fs.statSync(p).mode & 0o777, 0o600);
});
