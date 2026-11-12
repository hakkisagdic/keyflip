import test from 'node:test';
import assert from 'node:assert';
import * as usage from '../src/usage.js';
import { makeCtx } from './helpers.js';
import * as _config from '../src/config.js';

function apiFetch(fiveHour, sevenDay, calls) {
  return async function (url, opts) {
    if (calls) calls.push({ url: url, auth: opts.headers.Authorization });
    return {
      ok: true,
      json: async function () {
        return {
          five_hour: { utilization: fiveHour, resets_at: '2026-07-02T10:00:00Z' },
          seven_day: { utilization: sevenDay, resets_at: null },
        };
      },
    };
  };
}
function blobWithToken(tok) {
  return JSON.stringify({ claudeAiOauth: { accessToken: tok } });
}

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
  assert.strictEqual(
    await usage.fetchUsage('TOK', {
      fetch: async function () {
        return { ok: false };
      },
    }),
    null,
  );
  assert.strictEqual(usage.headroom(null), null);
  assert.strictEqual(usage.headroom({ fiveHour: { pct: 70 }, sevenDay: { pct: 90 } }), 10); // binding window
});

test('usageForProfiles reports sentinels and serves the cache', async function () {
  const ctx = makeCtx();
  ctx.store.setProfile('ok', blobWithToken('T1'));
  ctx.store.setProfile('notoken', '{"claudeAiOauth":{}}');
  let calls = 0;
  const f = async function () {
    calls++;
    return {
      ok: true,
      json: async function () {
        return { five_hour: { utilization: 50 } };
      },
    };
  };
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

test('usageForProfiles honors config usage.cacheTtlSeconds for the default TTL', function () {
  return (async function () {
    const ctx = makeCtx();
    ctx.store.setProfile('ok', blobWithToken('T1'));
    let calls = 0;
    const f = async function () {
      calls++;
      return {
        ok: true,
        json: async function () {
          return { five_hour: { utilization: 50 } };
        },
      };
    };
    _config.set(ctx, 'usage.cacheTtlSeconds', '5'); // 5-second cache
    const NOW = 1800000000000;
    await usage.usageForProfiles(ctx, ['ok'], { fetch: f, nowMs: NOW });
    assert.strictEqual(calls, 1);
    await usage.usageForProfiles(ctx, ['ok'], { fetch: f, nowMs: NOW + 4000 }); // within 5s
    assert.strictEqual(calls, 1, 'served from cache within the configured 5s TTL');
    await usage.usageForProfiles(ctx, ['ok'], { fetch: f, nowMs: NOW + 6000 }); // past 5s
    assert.strictEqual(calls, 2, 'refetched after the configured TTL elapsed');
  })();
});

test('a 401 from the usage API surfaces as the "expired" sentinel', async function () {
  const ctx = makeCtx();
  ctx.store.setProfile('stale', blobWithToken('DEAD'));
  const f401 = async function () {
    return { ok: false, status: 401 };
  };
  const r = await usage.usageForProfiles(ctx, ['stale'], { fetch: f401, nowMs: 1800000000000 });
  assert.strictEqual(r.stale.status, 'expired');
});

test('a 429 (endpoint throttle) surfaces as throttled/unknown — never auto-skipped', async function () {
  const ctx = makeCtx();
  ctx.store.setProfile('busy', blobWithToken('T'));
  const f429 = async function () {
    return { ok: false, status: 429 };
  };
  const r = await usage.usageForProfiles(ctx, ['busy'], { fetch: f429, nowMs: 1800000000000 });
  assert.strictEqual(r.busy.status, 'throttled');
  assert.strictEqual(r.busy.headroom, null); // unknown, not "account exhausted"
});

test('the active account uses the LIVE credential for usage (liveFor)', async function () {
  const ctx = makeCtx();
  ctx.store.setLive(blobWithToken('LIVE-TOK'));
  ctx.store.setProfile('me', blobWithToken('STALE-TOK'));
  const seen = [];
  const f = async function (url, opts) {
    seen.push(opts.headers.Authorization);
    return {
      ok: true,
      status: 200,
      json: async function () {
        return { five_hour: { utilization: 1 } };
      },
    };
  };
  await usage.usageForProfiles(ctx, ['me'], { fetch: f, nowMs: 1800000000000, liveFor: 'me' });
  assert.deepStrictEqual(seen, ['Bearer LIVE-TOK']);
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

test('fetchUsageDetailed parses seven_day_opus and seven_day_sonnet and computes model headroom', async function () {
  const u = await usage.fetchUsage('TOK', {
    fetch: async function () {
      return {
        ok: true,
        status: 200,
        json: async function () {
          return {
            five_hour: { utilization: 20 },
            seven_day: { utilization: 30 },
            seven_day_opus: { utilization: 100, resets_at: '2026-07-05T00:00:00Z' },
            seven_day_sonnet: { utilization: 40 },
          };
        },
      };
    },
  });
  assert.strictEqual(u.sevenDayOpus.pct, 100);
  assert.strictEqual(u.sevenDaySonnet.pct, 40);
  assert.strictEqual(usage.headroom(u), 70);
  assert.strictEqual(usage.headroomForModel(u, 'claude-opus-4-6'), 0);
  assert.strictEqual(usage.headroomForModel(u, 'claude-sonnet-4-6'), 60);
  assert.deepStrictEqual(usage.limitedScopes(u), ['opus']);
});

test('usageForProfiles retains lastGood across transient 429/error but clears on 401 expired', async function () {
  const ctx = makeCtx();
  ctx.store.setProfile('a', blobWithToken('TOK-A'));
  const NOW = 1800000000000;

  // 1. Healthy fetch populates usage + lastGood
  const r1 = await usage.usageForProfiles(ctx, ['a'], {
    fetch: apiFetch(25, 10),
    nowMs: NOW,
    cacheTtlMs: 1000,
  });
  assert.strictEqual(r1.a.status, 'ok');
  assert.strictEqual(r1.a.headroom, 75);

  // 2. Transient 429 after cache expiry keeps lastGood
  const r2 = await usage.usageForProfiles(ctx, ['a'], {
    fetch: async function () {
      return { ok: false, status: 429 };
    },
    nowMs: NOW + 5000,
    cacheTtlMs: 1000,
  });
  assert.strictEqual(r2.a.status, 'throttled');
  assert.strictEqual(r2.a.headroom, null);
  assert.ok(r2.a.lastGood, 'lastGood preserved across 429');
  assert.strictEqual(usage.headroom(r2.a.lastGood), 75);

  // 3. Authoritative 401 clears lastGood (asked once the 429's quiet window has passed)
  const r3 = await usage.usageForProfiles(ctx, ['a'], {
    fetch: async function () {
      return { ok: false, status: 401 };
    },
    nowMs: NOW + 5000 + usage.THROTTLE_BASE_MS + 1,
    cacheTtlMs: 1000,
  });
  assert.strictEqual(r3.a.status, 'expired');
  assert.strictEqual(r3.a.lastGood, null, 'lastGood cleared on 401');
});
