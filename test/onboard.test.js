'use strict';
// Tests for the guided-capture wizard's detection helpers (src/onboard.js) and
// that `keyflip setup` refuses non-interactively. The interactive loop itself is
// keyboard/poll driven and covered by exercising its building blocks here.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { makeCtx, writeClaude } = require('./helpers');
const onboard = require('../src/onboard');
const profiles = require('../src/profiles');

test('capturedEmails collects saved profile emails, lowercased', function () {
  const ctx = makeCtx();
  profiles.write(ctx.configDir, { name: 'work', email: 'Work@X.com' });
  profiles.write(ctx.configDir, { name: 'home', email: 'home@x.com' });
  const s = onboard.capturedEmails(ctx);
  assert.ok(s.has('work@x.com'));
  assert.ok(s.has('home@x.com'));
  assert.strictEqual(s.size, 2);
});

test('snapshotLogins reads the current CLI login; app is null off-macOS', function () {
  const ctx = makeCtx(); // no appDataDir
  writeClaude(ctx, { oauthAccount: { emailAddress: 'a@x.com' }, userID: 'u1' });
  const s = onboard.snapshotLogins(ctx);
  assert.strictEqual(s.cli, 'a@x.com');
  assert.strictEqual(s.app, null);
});

test('firstNewLogin flags an uncaptured login and stays quiet once it is saved', function () {
  const ctx = makeCtx();
  writeClaude(ctx, { oauthAccount: { emailAddress: 'new@x.com' }, userID: 'u1' });
  assert.deepStrictEqual(onboard.firstNewLogin(ctx, new Set()), { surface: 'CLI', email: 'new@x.com' });
  // case-insensitive: an already-saved account is not "new"
  assert.strictEqual(onboard.firstNewLogin(ctx, new Set(['NEW@x.com'.toLowerCase()])), null);
});

test('firstNewLogin returns null when signed out', function () {
  const ctx = makeCtx();
  writeClaude(ctx, {}); // no oauthAccount
  assert.strictEqual(onboard.firstNewLogin(ctx, new Set()), null);
});

test('`keyflip setup` refuses when stdin is not a TTY (points at add)', function () {
  const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');
  const r = require('child_process').spawnSync(process.execPath, [BIN, 'setup'], { encoding: 'utf8', input: '' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /interactive wizard/);
});
