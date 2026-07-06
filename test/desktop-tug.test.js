'use strict';
// Tests for #8: the desktop↔CLI tug-of-war warning. desktopTugRisk() decides whether a
// running desktop app on a DIFFERENT account than the just-switched CLI account should
// be flagged (it can rewrite the shared login and undo an in-place --force swap).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const cli = require('../src/cli');
const profiles = require('../src/profiles');
const { makeCtx } = require('./helpers');

const APP_ORG = '11111111-2222-3333-4444-555555555555';
const OTHER_ORG = '99999999-8888-7777-6666-555555555555';

// A darwin ctx with a fake Claude desktop data dir signed into APP_ORG (config-only
// detection path: non-decryptable token + allowlist org + a live session cookie).
function darwinCtx() {
  const ctx = makeCtx({ platform: 'darwin' });
  const ad = path.join(ctx.home, 'Library', 'Application Support', 'Claude');
  fs.mkdirSync(ad, { recursive: true });
  const cfg = { 'oauth:tokenCacheV2': 'not-a-v10-blob' };
  cfg['dxt:allowlistLastUpdated:' + APP_ORG] = '2026-07-05T00:00:00.000Z';
  fs.writeFileSync(path.join(ad, 'config.json'), JSON.stringify(cfg));
  fs.writeFileSync(path.join(ad, 'Cookies'), 'sessionKey LIVE'); // app is signed in
  ctx.appDataDir = ad;
  return ctx;
}
function saveProfile(ctx, name, org) {
  profiles.write(ctx.configDir, { name: name, email: name + '@x.com', oauthAccount: org ? { organizationUuid: org } : {}, savedAt: ctx.now() });
}

test('risk=true when the running app is on a different account than the switch target', function () {
  process.env.KEYFLIP_TEST_CLAUDE = 'running';
  const ctx = darwinCtx();
  saveProfile(ctx, 'work', OTHER_ORG); // switched CLI to OTHER_ORG; app is on APP_ORG
  const r = cli.desktopTugRisk(ctx, 'work');
  assert.strictEqual(r.risk, true);
  assert.ok(r.appLabel, 'a label identifies the app account');
});

test('risk=false when the app is on the SAME account as the target', function () {
  process.env.KEYFLIP_TEST_CLAUDE = 'running';
  const ctx = darwinCtx();
  saveProfile(ctx, 'work', APP_ORG); // app and target agree
  assert.strictEqual(cli.desktopTugRisk(ctx, 'work').risk, false);
});

test('risk=false when the desktop app is NOT running', function () {
  process.env.KEYFLIP_TEST_CLAUDE = 'stopped';
  const ctx = darwinCtx();
  saveProfile(ctx, 'work', OTHER_ORG);
  assert.strictEqual(cli.desktopTugRisk(ctx, 'work').risk, false);
});

test('risk=false when the app is RUNNING but SIGNED OUT (stale allowlist, no session cookie)', function () {
  process.env.KEYFLIP_TEST_CLAUDE = 'running';
  const ctx = darwinCtx();
  // Overwrite the live cookie with a signed-out one (no sessionKey) — a running app with
  // only a stale allowlist org can't rewrite anything, so it must not raise the warning.
  fs.writeFileSync(path.join(ctx.appDataDir, 'Cookies'), 'logged-out-no-session');
  saveProfile(ctx, 'work', OTHER_ORG);
  assert.strictEqual(cli.desktopTugRisk(ctx, 'work').risk, false);
});

test('risk=false off macOS / without an app data dir', function () {
  process.env.KEYFLIP_TEST_CLAUDE = 'running';
  const ctx = makeCtx({ platform: 'linux' });
  saveProfile(ctx, 'work', OTHER_ORG);
  assert.strictEqual(cli.desktopTugRisk(ctx, 'work').risk, false);
});

test('risk=false when the target profile has no org to compare', function () {
  process.env.KEYFLIP_TEST_CLAUDE = 'running';
  const ctx = darwinCtx();
  saveProfile(ctx, 'work', null); // no oauthAccount.organizationUuid
  assert.strictEqual(cli.desktopTugRisk(ctx, 'work').risk, false);
});
