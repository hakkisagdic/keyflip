'use strict';
// Tests for A2's session→account mapping (src/sessionmap.js) + that profiles.list does NOT
// count the map file as a phantom account.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sessionmap = require('../src/sessionmap');
const profiles = require('../src/profiles');
const { makeCtx } = require('./helpers');

test('set/get/unset round-trip a session→account assignment', function () {
  const ctx = makeCtx();
  assert.strictEqual(sessionmap.get(ctx, 'sess-1'), null);
  sessionmap.set(ctx, 'sess-1', 'work');
  sessionmap.set(ctx, 'sess-2', 'home');
  assert.strictEqual(sessionmap.get(ctx, 'sess-1'), 'work');
  assert.strictEqual(sessionmap.get(ctx, 'sess-2'), 'home');
  assert.strictEqual(sessionmap.unset(ctx, 'sess-1'), true);
  assert.strictEqual(sessionmap.get(ctx, 'sess-1'), null);
  assert.strictEqual(sessionmap.unset(ctx, 'sess-1'), false); // already gone
  assert.strictEqual(sessionmap.get(ctx, 'sess-2'), 'home', 'other assignment untouched');
});

test('the map file (session-accounts.json) is NOT counted as an account by profiles.list', function () {
  const ctx = makeCtx();
  fs.writeFileSync(path.join(ctx.configDir, 'work.json'), '{"name":"work","email":"a@x.com"}');
  sessionmap.set(ctx, 'sess-1', 'work'); // writes session-accounts.json
  const names = profiles.list(ctx.configDir);
  assert.deepStrictEqual(names, ['work'], 'only the real profile, not session-accounts');
});

test('get tolerates a missing / corrupt map file', function () {
  const ctx = makeCtx();
  assert.deepStrictEqual(sessionmap.read(ctx), {});
  fs.writeFileSync(path.join(ctx.configDir, 'session-accounts.json'), 'not json');
  assert.deepStrictEqual(sessionmap.read(ctx), {});
});
