'use strict';
const test = require('node:test');
const assert = require('node:assert');
const oauth = require('../src/oauth');
const { makeCtx } = require('./helpers');

const NOW = 1800000000000;
function blobExpiring() {
  return JSON.stringify({ claudeAiOauth: { accessToken: 'OLD', refreshToken: 'RT-1', expiresAt: NOW + 60000, scopes: ['a'] } });
}
function blobFresh() {
  return JSON.stringify({ claudeAiOauth: { accessToken: 'OK', refreshToken: 'RT-1', expiresAt: NOW + 3600000 } });
}
function okFetch(calls) {
  return async function (url, opts) {
    calls.push({ url: url, body: JSON.parse(opts.body) });
    return { ok: true, json: async function () { return { access_token: 'NEW', refresh_token: 'RT-2', expires_in: 3600, scope: 'x y' }; } };
  };
}

test('isExpiring respects the 5-minute buffer and unknown expiry', function () {
  assert.strictEqual(oauth.isExpiring(blobExpiring(), NOW), true);   // 1min left < 5min buffer
  assert.strictEqual(oauth.isExpiring(blobFresh(), NOW), false);     // 1h left
  assert.strictEqual(oauth.isExpiring('{"claudeAiOauth":{}}', NOW), false);
  assert.strictEqual(oauth.isExpiring('not json', NOW), false);
});

test('refreshBlob posts the refresh grant and rewrites token fields', async function () {
  const calls = [];
  const out = await oauth.refreshBlob(blobExpiring(), { fetch: okFetch(calls), nowMs: NOW });
  const d = JSON.parse(out);
  assert.strictEqual(calls[0].url, oauth.OAUTH_TOKEN_URL);
  assert.strictEqual(calls[0].body.grant_type, 'refresh_token');
  assert.strictEqual(calls[0].body.client_id, oauth.OAUTH_CLIENT_ID);
  assert.strictEqual(d.claudeAiOauth.accessToken, 'NEW');
  assert.strictEqual(d.claudeAiOauth.refreshToken, 'RT-2');           // rotated
  assert.strictEqual(d.claudeAiOauth.expiresAt, NOW + 3600000);
  assert.deepStrictEqual(d.claudeAiOauth.scopes, ['x', 'y']);
});

test('refreshBlob returns null on HTTP failure or missing refresh token', async function () {
  const bad = await oauth.refreshBlob(blobExpiring(), { fetch: async function () { return { ok: false }; } });
  assert.strictEqual(bad, null);
  const noRt = JSON.stringify({ claudeAiOauth: { accessToken: 'A' } });
  assert.strictEqual(await oauth.refreshBlob(noRt, { fetch: okFetch([]) }), null);
});

test('maybeRefreshProfile refreshes an expiring profile and persists it', async function () {
  const ctx = makeCtx();
  ctx.store.setProfile('alice', blobExpiring());
  const r = await oauth.maybeRefreshProfile(ctx, 'alice', { fetch: okFetch([]), nowMs: NOW });
  assert.strictEqual(r.status, 'refreshed');
  assert.strictEqual(JSON.parse(ctx.store.getProfile('alice')).claudeAiOauth.accessToken, 'NEW');
});

test('maybeRefreshProfile skips when a live instance owns the credential', async function () {
  const ctx = makeCtx();
  ctx.store.setProfile('alice', blobExpiring());
  const r = await oauth.maybeRefreshProfile(ctx, 'alice', {
    fetch: okFetch([]), nowMs: NOW,
    instances: function () { return [{ pid: 1 }]; },
  });
  assert.strictEqual(r.status, 'skipped');
  assert.strictEqual(JSON.parse(ctx.store.getProfile('alice')).claudeAiOauth.accessToken, 'OLD');
});

test('maybeRefreshProfile reports persist-failed when the rotated blob cannot be saved', async function () {
  const ctx = makeCtx();
  ctx.store.setProfile('alice', blobExpiring());
  const realSet = ctx.store.setProfile.bind(ctx.store);
  ctx.store.setProfile = function () { throw new Error('keychain locked'); };
  const r = await oauth.maybeRefreshProfile(ctx, 'alice', { fetch: okFetch([]), nowMs: NOW });
  assert.strictEqual(r.status, 'persist-failed');
  ctx.store.setProfile = realSet;
});

test('maybeRefreshProfile leaves fresh tokens alone', async function () {
  const ctx = makeCtx();
  ctx.store.setProfile('alice', blobFresh());
  const r = await oauth.maybeRefreshProfile(ctx, 'alice', { fetch: okFetch([]), nowMs: NOW });
  assert.strictEqual(r.status, 'fresh');
});
