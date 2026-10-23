// switchfacts — the READ-ONLY facts both `keyflip <account> --dry-run` and the MCP switch-plan tool
// build their plan from. These tests pin the safe-default contract: no app login / no captures must
// degrade to explicit values, never throw, and nothing may be written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { makeCtx, tmpdir } from './helpers.js';
import * as switchfacts from '../src/switchfacts.js';
import * as profiles from '../src/profiles.js';

function profile(ctx, name, email) {
  profiles.write(ctx.configDir, { name: name, email: email, schemaVersion: 1 });
}

test('appActiveProfile is null when this platform has no desktop app data dir', function () {
  const ctx = makeCtx(); // no appDataDir
  profile(ctx, 'work', 'work@example.test');
  assert.equal(switchfacts.appActiveProfile(ctx), null);
});

test('appActiveProfile is null when the app has no readable login (empty app data dir)', function () {
  const ctx = makeCtx();
  ctx.appDataDir = tmpdir(); // exists, but holds no Cookies/token index
  profile(ctx, 'work', 'work@example.test');
  assert.equal(switchfacts.appActiveProfile(ctx), null);
});

test('collect degrades to explicit safe defaults on a bare machine', async function () {
  const ctx = makeCtx();
  profile(ctx, 'work', 'work@example.test');
  const before = fs.readdirSync(ctx.configDir).sort();

  const f = await switchfacts.collect(ctx, 'work', {});

  assert.equal(f.target, 'work');
  assert.equal(f.email, 'work@example.test');
  assert.equal(f.activeCliEmail, '', 'no ~/.claude.json means no active CLI account');
  assert.equal(f.activeCliProfile, null);
  assert.equal(f.appActiveProfile, null);
  assert.equal(f.cliCaptured, false);
  assert.equal(f.appCaptured, false);
  assert.equal(f.canManageApp, false);
  assert.equal(f.browserCaptured, false);
  assert.equal(f.appSignIn, null);
  assert.equal(f.needsRefresh, false);
  assert.equal(f.tokenDead, false);
  assert.equal(f.policyDenied, null);
  assert.equal(typeof f.targetState, 'string');
  assert.ok(Array.isArray(f.targetChecks) && f.targetChecks.length > 0);
  assert.ok(
    f.targetChecks.every(function (c) {
      return typeof c.name === 'string' && typeof c.state === 'string';
    }),
  );
  assert.deepEqual(fs.readdirSync(ctx.configDir).sort(), before, 'collect must not write anything');
});

test('collect with the browser surface excluded does not inspect browsers', async function () {
  const ctx = makeCtx();
  profile(ctx, 'work', 'work@example.test');
  const f = await switchfacts.collect(ctx, 'work', { surfaces: { browser: false } });
  assert.equal(f.browsers, null);
});

test('collect handles an unknown account without throwing', async function () {
  const ctx = makeCtx();
  const f = await switchfacts.collect(ctx, 'ghost', {});
  assert.equal(f.target, 'ghost');
  assert.equal(f.email, '', 'profiles.email degrades to an empty string for a missing profile');
  assert.equal(f.cliCaptured, false);
  assert.equal(f.appCaptured, false);
});

test('a policy denial is reported as a plan fact, not thrown', async function () {
  const ctx = makeCtx();
  profile(ctx, 'work', 'work@example.test');
  // Real policy schema (see src/policy.js): a rule needs a valid id and a {accounts?,groups?}
  // bucket; a deny bucket with an empty match applies everywhere.
  const policyPath = path.join(ctx.configDir, 'policy.json');
  fs.writeFileSync(
    policyPath,
    JSON.stringify({ default: 'allow', rules: [{ id: 'r1', deny: { accounts: ['work'] }, note: 'test deny' }] }),
  );
  const f = await switchfacts.collect(ctx, 'work', {});
  assert.match(String(f.policyDenied), /explicitly denied .*r1/, 'the enforce() reason is surfaced');
  assert.match(String(f.policyDenied), /test deny/, 'the rule note is included');
});

test('a force plan skips the policy check (the real switch still enforces it)', async function () {
  const ctx = makeCtx();
  profile(ctx, 'work', 'work@example.test');
  fs.writeFileSync(
    path.join(ctx.configDir, 'policy.json'),
    JSON.stringify({ default: 'allow', rules: [{ id: 'r1', deny: { accounts: ['work'] } }] }),
  );
  const f = await switchfacts.collect(ctx, 'work', { force: true });
  assert.equal(f.policyDenied, null);
});
