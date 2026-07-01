'use strict';
const test = require('node:test');
const assert = require('node:assert');
const usage = require('../src/usage');
const { makeCtx } = require('./helpers');

function apiFetch(fiveHour, sevenDay, calls) {
  return async function (url, opts) {
    if (calls) calls.push({ url: url, auth: opts.headers.Authorization });
    return { ok: true, json: async function () {
      return { five_hour: { utilization: fiveHour, resets_at: '2026-07-02T10:00:00Z' },
               seven_day: { utilization: sevenDay, resets_at: null } };
    } };
  };
}
function blobWithToken(tok) { return JSON.stringify({ claudeAiOauth: { accessToken: tok } }); }

test('fetchUsage normalizes the usage API response', async function () {
  const calls = [];
  const u = await usage.fetchUsage('TOK', { fetch: apiFetch(42, 13, calls) });
  assert.strictEqual(calls[0].url, usage.USAGE_URL);
  assert.strictEqual(calls[0].auth, 'Bearer TOK');
  assert.strictEqual(u.fiveHour.pct, 42);
  assert.strictEqual(u.sevenDay.pct, 13);
  assert.strictEqual(usage.fmt(u), '5h 42% · 7d 13%');
});

test('fetchUsage returns null on failure and headroom handles unknowns', async function () {
  assert.strictEqual(await usage.fetchUsage('TOK', { fetch: async function () { return { ok: false }; } }), null);
  assert.strictEqual(usage.headroom(null), null);
  assert.strictEqual(usage.headroom({ fiveHour: { pct: 70 }, sevenDay: { pct: 90 } }), 10); // binding window
});

test('usageForProfiles reports sentinels and serves the cache', async function () {
  const ctx = makeCtx();
  ctx.store.setProfile('ok', blobWithToken('T1'));
  ctx.store.setProfile('notoken', '{"claudeAiOauth":{}}');
  let calls = 0;
  const f = async function () { calls++; return { ok: true, json: async function () { return { five_hour: { utilization: 50 } }; } }; };
  const NOW = 1800000000000;
  const r1 = await usage.usageForProfiles(ctx, ['ok', 'notoken', 'missing'], { fetch: f, nowMs: NOW });
  assert.strictEqual(r1.ok.status, 'ok');
  assert.strictEqual(r1.ok.headroom, 50);
  assert.strictEqual(r1.notoken.status, 'no-token');
  assert.strictEqual(r1.missing.status, 'no-creds');
  assert.strictEqual(calls, 1);
  // cached within TTL — no second network call
  await usage.usageForProfiles(ctx, ['ok'], { fetch: f, nowMs: NOW + 1000 });
  assert.strictEqual(calls, 1);
});

test('pickByStrategy: best picks max headroom; next-available skips exhausted', function () {
  const candidates = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  const infos = {
    a: { headroom: 5 },
    b: { headroom: 60 },
    c: { headroom: null }, // unknown
  };
  assert.strictEqual(usage.pickByStrategy(candidates, infos, 'best').name, 'b');
  const exhausted = { a: { headroom: 0 }, b: { headroom: -3 }, c: { headroom: null } };
  assert.strictEqual(usage.pickByStrategy(candidates, exhausted, 'next-available').name, 'c'); // unknown counts as available
  const allDead = { a: { headroom: 0 }, b: { headroom: 0 }, c: { headroom: 0 } };
  assert.strictEqual(usage.pickByStrategy(candidates, allDead, 'next-available'), null);
  const noneKnown = { a: { headroom: null }, b: { headroom: null }, c: { headroom: null } };
  assert.strictEqual(usage.pickByStrategy(candidates, noneKnown, 'best'), null);
});
