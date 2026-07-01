'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const core = require('../src/core');
const profiles = require('../src/profiles');
const claude = require('../src/claude');
const { makeCtx, writeClaude } = require('./helpers');

function login(ctx, email, userID, liveBlob) {
  writeClaude(ctx, { oauthAccount: { emailAddress: email }, userID: userID });
  ctx.store.setLive(liveBlob);
}

test('addCurrent detects the logged-in account and auto-names it', function () {
  const ctx = makeCtx();
  login(ctx, 'alice@example.com', 'u-alice', 'LIVE-ALICE');
  const r = core.addCurrent(ctx);
  assert.strictEqual(r.name, 'alice');
  assert.strictEqual(r.refreshed, false);
  assert.strictEqual(profiles.email(ctx.configDir, 'alice'), 'alice@example.com');
  assert.strictEqual(ctx.store.getProfile('alice'), 'LIVE-ALICE');
});

test('addCurrent on an already-saved account refreshes its tokens', function () {
  const ctx = makeCtx();
  login(ctx, 'alice@example.com', 'u-alice', 'LIVE-1');
  core.addCurrent(ctx);
  ctx.store.setLive('LIVE-2'); // token rotated
  const r = core.addCurrent(ctx);
  assert.strictEqual(r.refreshed, true);
  assert.strictEqual(r.name, 'alice');
  assert.strictEqual(ctx.store.getProfile('alice'), 'LIVE-2');
});

test('addCurrent disambiguates a name collision across different emails', function () {
  const ctx = makeCtx();
  login(ctx, 'alice@example.com', 'u1', 'A');
  core.addCurrent(ctx); // -> "alice"
  login(ctx, 'alice@other.org', 'u2', 'B');
  const r = core.addCurrent(ctx);
  assert.strictEqual(r.name, 'alice-other');
  assert.strictEqual(profiles.email(ctx.configDir, 'alice-other'), 'alice@other.org');
});

test('switching swaps the live credential and patches ~/.claude.json (keeping other keys)', function () {
  const ctx = makeCtx();
  // Save alice.
  writeClaude(ctx, { keepMe: 42, oauthAccount: { emailAddress: 'alice@example.com' }, userID: 'u-alice' });
  ctx.store.setLive('LIVE-ALICE');
  core.addCurrent(ctx);
  // Log in as bob and save.
  writeClaude(ctx, { keepMe: 42, oauthAccount: { emailAddress: 'bob@example.com' }, userID: 'u-bob' });
  ctx.store.setLive('LIVE-BOB');
  core.addCurrent(ctx);

  // Currently bob. Switch to alice.
  core.doSwitch(ctx, 'alice');

  assert.strictEqual(ctx.store.getLive(), 'LIVE-ALICE');
  assert.strictEqual(core.currentEmail(ctx), 'alice@example.com');
  const cfg = claude.readConfig(ctx.claudeConfigPath);
  assert.strictEqual(cfg.keepMe, 42);
  assert.strictEqual(cfg.userID, 'u-alice');
});

test('refreshCurrent re-saves the active account before switching away', function () {
  const ctx = makeCtx();
  writeClaude(ctx, { oauthAccount: { emailAddress: 'alice@example.com' }, userID: 'u-alice' });
  ctx.store.setLive('ALICE-OLD');
  core.addCurrent(ctx);
  writeClaude(ctx, { oauthAccount: { emailAddress: 'bob@example.com' }, userID: 'u-bob' });
  ctx.store.setLive('BOB');
  core.addCurrent(ctx);

  // Back on alice; her token rotates before we switch to bob.
  core.doSwitch(ctx, 'alice');       // live becomes ALICE-OLD
  ctx.store.setLive('ALICE-NEW');    // simulate rotation while alice active
  core.doSwitch(ctx, 'bob');         // should re-save alice as ALICE-NEW first

  assert.strictEqual(ctx.store.getProfile('alice'), 'ALICE-NEW');
  assert.strictEqual(ctx.store.getLive(), 'BOB');
});

test('resolveProfile accepts exact names and 1-based numbers', function () {
  const ctx = makeCtx();
  login(ctx, 'alice@example.com', 'u1', 'A'); core.addCurrent(ctx);
  login(ctx, 'bob@example.com', 'u2', 'B'); core.addCurrent(ctx);
  // sorted: [alice, bob]
  assert.strictEqual(core.resolveProfile(ctx, 'bob'), 'bob');
  assert.strictEqual(core.resolveProfile(ctx, '1'), 'alice');
  assert.strictEqual(core.resolveProfile(ctx, '2'), 'bob');
  assert.strictEqual(core.resolveProfile(ctx, '3'), null);
  assert.strictEqual(core.resolveProfile(ctx, 'nope'), null);
});

test('listProfiles marks the active account', function () {
  const ctx = makeCtx();
  login(ctx, 'alice@example.com', 'u1', 'A'); core.addCurrent(ctx);
  login(ctx, 'bob@example.com', 'u2', 'B'); core.addCurrent(ctx); // bob now active
  const list = core.listProfiles(ctx);
  const bob = list.find(function (e) { return e.name === 'bob'; });
  const alice = list.find(function (e) { return e.name === 'alice'; });
  assert.strictEqual(bob.active, true);
  assert.strictEqual(alice.active, false);
});

test('removeProfile deletes metadata and stored credentials', function () {
  const ctx = makeCtx();
  login(ctx, 'alice@example.com', 'u1', 'A'); core.addCurrent(ctx);
  core.removeProfile(ctx, 'alice');
  assert.strictEqual(profiles.exists(ctx.configDir, 'alice'), false);
  assert.strictEqual(ctx.store.getProfile('alice'), null);
});

test('saveAs rejects invalid names and refuses when not logged in', function () {
  const ctx = makeCtx();
  ctx.store.setLive('X');
  assert.throws(function () { core.saveAs(ctx, 'bad name'); }, /invalid profile name/);
  const ctx2 = makeCtx();
  assert.throws(function () { core.saveAs(ctx2, 'ok'); }, /No live Claude session/);
});

test('addCurrent throws when no account is logged in', function () {
  const ctx = makeCtx();
  ctx.store.setLive('X');
  assert.throws(function () { core.addCurrent(ctx); }, /No logged-in account/);
});

test('addCurrent uniquifies instead of overwriting a different account on a double collision', function () {
  const ctx = makeCtx();
  login(ctx, 'alice@example.com', 'u1', 'A'); core.addCurrent(ctx); // -> 'alice'
  login(ctx, 'alice@other.org', 'u2', 'B'); core.addCurrent(ctx);   // -> 'alice-other'
  login(ctx, 'alice@other.net', 'u3', 'C');
  const r = core.addCurrent(ctx);
  assert.notStrictEqual(r.name, 'alice');
  assert.notStrictEqual(r.name, 'alice-other');
  // the previously-saved other.org account is untouched
  assert.strictEqual(profiles.email(ctx.configDir, 'alice-other'), 'alice@other.org');
  assert.strictEqual(ctx.store.getProfile('alice-other'), 'B');
  // and the new one is saved under a fresh name
  assert.strictEqual(profiles.email(ctx.configDir, r.name), 'alice@other.net');
  assert.strictEqual(ctx.store.getProfile(r.name), 'C');
});

test('addCurrent rejects an explicit name already used by a different account', function () {
  const ctx = makeCtx();
  login(ctx, 'alice@example.com', 'u1', 'A'); core.addCurrent(ctx);
  login(ctx, 'bob@example.com', 'u2', 'B');
  assert.throws(function () { core.addCurrent(ctx, 'alice'); }, /already exists/);
});

test('switching away from an unsaved account auto-saves it so its token is not lost', function () {
  const ctx = makeCtx();
  login(ctx, 'alice@example.com', 'u1', 'ALICE'); core.addCurrent(ctx);
  login(ctx, 'charlie@example.com', 'u3', 'CHARLIE'); // never saved
  core.doSwitch(ctx, 'alice');
  const names = profiles.list(ctx.configDir);
  const charlie = names.filter(function (n) { return profiles.email(ctx.configDir, n) === 'charlie@example.com'; })[0];
  assert.ok(charlie, 'charlie should have been auto-saved');
  assert.strictEqual(ctx.store.getProfile(charlie), 'CHARLIE');
  assert.strictEqual(ctx.store.getLive(), 'ALICE');
});

test('applyProfile creates ~/.claude.json when it is missing', function () {
  const ctx = makeCtx();
  login(ctx, 'alice@example.com', 'u1', 'ALICE'); core.addCurrent(ctx);
  fs.rmSync(ctx.claudeConfigPath, { force: true });
  core.applyProfile(ctx, 'alice');
  assert.strictEqual(claude.readConfig(ctx.claudeConfigPath).oauthAccount.emailAddress, 'alice@example.com');
});

test('applyProfile refuses to overwrite a corrupt ~/.claude.json (no data loss)', function () {
  const ctx = makeCtx();
  login(ctx, 'alice@example.com', 'u1', 'ALICE'); core.addCurrent(ctx);
  fs.writeFileSync(ctx.claudeConfigPath, '{ "mcpServers": {}, broken');
  assert.throws(function () { core.applyProfile(ctx, 'alice'); }, /not valid JSON/);
  // the corrupt file is left intact, not clobbered
  assert.strictEqual(fs.readFileSync(ctx.claudeConfigPath, 'utf8'), '{ "mcpServers": {}, broken');
});

test('resolveProfile treats a number as the menu index, not a digit-named profile', function () {
  const ctx = makeCtx();
  login(ctx, 'z@example.com', 'u1', 'Z'); core.saveAs(ctx, '2');
  login(ctx, 'a@example.com', 'u2', 'A'); core.saveAs(ctx, 'aaa');
  // sorted names: ['2','aaa'] -> menu shows [1]=2, [2]=aaa
  assert.strictEqual(core.resolveProfile(ctx, '1'), '2');
  assert.strictEqual(core.resolveProfile(ctx, '2'), 'aaa'); // index 2, NOT the profile literally named "2"
  assert.strictEqual(core.resolveProfile(ctx, '3'), null);  // out of range
});
