import test from 'node:test';
import assert from 'node:assert';
import * as usage from '../src/usage.js';
import * as provusage from '../src/provusage.js';
import { makeCtx } from './helpers.js';

// A sanitised copy of the real usage response shape: no five-hour window, the account-wide weekly
// window, a weekly window scoped to one model tier, the older top-level keys, and fields that are
// not windows at all. Every value is made up.
function realShape() {
  return {
    five_hour: null,
    seven_day: { utilization: 44, resets_at: '2026-01-10T07:00:00.000000+00:00', limit_dollars: null },
    seven_day_opus: null,
    seven_day_sonnet: null,
    seven_day_cowork: null,
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
    limits: [
      {
        kind: 'weekly_all',
        group: 'weekly',
        percent: 44,
        severity: 'normal',
        resets_at: '2026-01-10T07:00:00.000000+00:00',
        scope: null,
        is_active: true,
      },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 15,
        severity: 'normal',
        resets_at: '2026-01-10T07:00:00.000000+00:00',
        scope: { model: { id: null, display_name: 'Fable' }, surface: null },
        is_active: false,
      },
    ],
    spend: { used: { amount_minor: 0, currency: 'USD', exponent: 2 }, limit: null, percent: 0 },
    weekly_scoped_shares: [{ limit_index: 1, used_percent_of_weekly: 8, allowance_percent_of_weekly: 50 }],
    seven_day_breakdown: { rows: [{ key: 'claude_code', percent: 100, percent_of_limit: 44 }] },
  };
}
const byName = function (u, n) {
  return u.windows.filter(function (w) {
    return w.name === n;
  })[0];
};

test('parseUsage keeps every window, with a stable name each', function () {
  const u = usage.parseUsage(realShape());
  assert.deepStrictEqual(
    u.windows.map(function (w) {
      return w.name;
    }),
    ['weekly', 'weekly:fable'],
  );
  assert.strictEqual(byName(u, 'weekly').pct, 44);
  assert.strictEqual(byName(u, 'weekly').resetsAt, '2026-01-10T07:00:00.000000+00:00');
  assert.strictEqual(byName(u, 'weekly').severity, 'normal');
  assert.strictEqual(byName(u, 'weekly:fable').pct, 15);
  assert.strictEqual(byName(u, 'weekly:fable').scope, 'fable');
});

test('the old fields stay for existing callers', function () {
  const u = usage.parseUsage(realShape());
  assert.strictEqual(u.sevenDay.pct, 44);
  assert.strictEqual(u.sevenDay.resetsAt, '2026-01-10T07:00:00.000000+00:00');
  assert.strictEqual(u.fiveHour, undefined);
  assert.strictEqual(usage.fmt(u), '7d 44% · fable 15%');
});

test('headroomPct is the smallest remaining share across the windows that limit the account', function () {
  const d = realShape();
  d.five_hour = { utilization: 70, resets_at: '2026-01-05T15:00:00Z' };
  const u = usage.parseUsage(d);
  assert.strictEqual(u.headroomPct, 30); // 5h (70% used) is tighter than weekly (44%)
  assert.strictEqual(usage.headroom(u), 30);
  // a model-scoped window that is not flagged active does not lower the account-wide headroom
  d.limits[1].percent = 95;
  assert.strictEqual(usage.parseUsage(d).headroomPct, 30);
  // but it does gate that model
  assert.strictEqual(usage.headroomForModel(usage.parseUsage(d), 'claude-fable-5-2'), 5);
  assert.strictEqual(usage.headroomForModel(usage.parseUsage(d), 'claude-sonnet-5-5'), 30);
});

test('limitedScopes covers every window at 100%', function () {
  const d = realShape();
  d.limits[0].percent = 100;
  d.limits[1].percent = 100;
  const u = usage.parseUsage(d);
  assert.deepStrictEqual(u.limitedScopes, ['7d', 'fable']);
  assert.deepStrictEqual(usage.limitedScopes(u), ['7d', 'fable']);
  assert.strictEqual(u.headroomPct, 0);
});

test('an unknown future window is kept, not dropped', function () {
  const d = realShape();
  d.seven_day_newthing = { utilization: 12.5, resets_at: '2026-01-11T00:00:00Z' };
  d.limits.push({
    kind: 'monthly_pool',
    group: 'monthly',
    percent: 77,
    resets_at: null,
    scope: null,
    is_active: false,
  });
  const u = usage.parseUsage(d);
  assert.strictEqual(byName(u, 'weekly:newthing').pct, 12.5);
  assert.strictEqual(byName(u, 'monthly-pool').pct, 77);
  assert.ok(u.windows.length >= 4);
});

test('legacy-only responses still parse (no limits list)', function () {
  const u = usage.parseUsage({
    five_hour: { utilization: 42, resets_at: '2026-01-05T15:00:00Z' },
    seven_day: { utilization: 13, resets_at: null },
    seven_day_opus: { utilization: 90, resets_at: null },
  });
  assert.deepStrictEqual(
    u.windows.map(function (w) {
      return w.name;
    }),
    ['5h', 'weekly', 'weekly:opus'],
  );
  assert.strictEqual(u.fiveHour.pct, 42);
  assert.strictEqual(u.sevenDayOpus.pct, 90);
  assert.strictEqual(u.headroomPct, 58);
  assert.strictEqual(usage.parseUsage({ five_hour: null, seven_day: null }), null);
});

test('provusage claude provider reports every window by name', async function () {
  const ctx = makeCtx();
  const u = usage.parseUsage(realShape());
  const r = await provusage.get('claude').read(ctx, {
    now: function () {
      return Date.parse('2026-01-05T00:00:00Z');
    },
    requireUsage: function () {
      return {
        usageForProfiles: async function () {
          return { tester: { status: 'ok', usage: u } };
        },
      };
    },
  });
  assert.strictEqual(r.status, 'ok');
  assert.deepStrictEqual(
    r.windows.map(function (w) {
      return w.name + ':' + w.usedPct;
    }),
    ['weekly:44', 'weekly:fable:15'],
  );
});

// ---- why an account reads "throttled" or not at all -------------------------------------------
function blobWith(tok, scopes) {
  return JSON.stringify({ claudeAiOauth: { accessToken: tok, scopes: scopes } });
}
const OAUTH_SCOPES = ['user:inference', 'user:profile'];
function status(code, body, headers) {
  return async function () {
    return {
      ok: code >= 200 && code < 300,
      status: code,
      headers: { get: (n) => (headers && headers[n.toLowerCase()]) || null },
      json: async function () {
        return body;
      },
    };
  };
}

test('signInKind tells a browser sign-in from an inference-only token', function () {
  assert.strictEqual(usage.signInKind(blobWith('t', OAUTH_SCOPES)), 'oauth');
  assert.strictEqual(usage.signInKind(blobWith('t', ['user:inference'])), 'inference-only');
  assert.strictEqual(usage.signInKind(JSON.stringify({ claudeAiOauth: { accessToken: 't' } })), 'unknown');
  assert.strictEqual(usage.signInKind('not json'), 'unknown');
});

test('a sign-in kind the endpoint refuses is reported as unsupported, not throttled', async function () {
  const ctx = makeCtx();
  ctx.store.setProfile('long', blobWith('tok-long-lived', ['user:inference']));
  const refusal = {
    type: 'error',
    error: { type: 'permission_error', message: 'OAuth token does not meet scope requirement user:profile' },
  };
  const out = await usage.usageForProfiles(ctx, ['long'], { fetch: status(403, refusal), lock: false, nowMs: 1000000 });
  assert.strictEqual(out.long.status, 'unsupported');
  assert.strictEqual(out.long.note, 'unsupported for this sign-in kind');
  assert.strictEqual(out.long.httpStatus, 403);
  assert.strictEqual(out.long.reason.type, 'permission_error');
  assert.strictEqual(out.long.headroom, null);
});

test('a 429 on an inference-only token is also the sign-in kind, not load', async function () {
  const ctx = makeCtx();
  ctx.store.setProfile('long', blobWith('tok-long-lived', ['user:inference']));
  const out = await usage.usageForProfiles(ctx, ['long'], {
    fetch: status(429, {}, { 'retry-after': '3600' }),
    lock: false,
    nowMs: 1000000,
  });
  assert.strictEqual(out.long.status, 'unsupported');
});

test('an unsupported answer is not repeated while the credential is the same, and is dropped when it is renewed', async function () {
  const ctx = makeCtx();
  ctx.store.setProfile('long', blobWith('tok-A', ['user:inference']));
  let calls = 0;
  const f403 = async function () {
    calls++;
    return {
      ok: false,
      status: 403,
      headers: { get: () => null },
      json: async () => ({ error: { type: 'permission_error', message: 'scope' } }),
    };
  };
  await usage.usageForProfiles(ctx, ['long'], { fetch: f403, lock: false, nowMs: 1000000 });
  const again = await usage.usageForProfiles(ctx, ['long'], { fetch: f403, lock: false, nowMs: 1000000 + 3600 * 1000 });
  assert.strictEqual(calls, 1);
  assert.strictEqual(again.long.status, 'unsupported');
  // the sign-in is renewed as a full OAuth login: asked again at once, reads normally
  ctx.store.setProfile('long', blobWith('tok-B', OAUTH_SCOPES));
  const ok = await usage.usageForProfiles(ctx, ['long'], {
    fetch: status(200, realShape()),
    lock: false,
    nowMs: 1000000 + 3600 * 1000 + 1,
  });
  assert.strictEqual(ok.long.status, 'ok');
  assert.strictEqual(ok.long.headroom, 56);
});

test('a real rate limit keeps the last good reading with its age and backs off', async function () {
  const ctx = makeCtx();
  ctx.store.setProfile('acct', blobWith('tok-A', OAUTH_SCOPES));
  const t0 = 5000000;
  await usage.usageForProfiles(ctx, ['acct'], { fetch: status(200, realShape()), lock: false, nowMs: t0 });
  const lim = await usage.usageForProfiles(ctx, ['acct'], {
    fetch: status(429, {}, { 'retry-after': '120' }),
    lock: false,
    nowMs: t0 + 120000,
    cacheTtlMs: 1000,
  });
  assert.strictEqual(lim.acct.status, 'throttled');
  assert.strictEqual(lim.acct.httpStatus, 429);
  assert.ok(lim.acct.lastGood && lim.acct.lastGood.windows.length === 2);
  assert.strictEqual(lim.acct.lastGoodAt, t0);
  assert.ok(lim.acct.retryAt >= t0 + 120000 + 120000);
});

test('a renewed sign-in is not held in the quiet window earned by the old credential', async function () {
  const ctx = makeCtx();
  ctx.store.setProfile('acct', blobWith('tok-OLD', ['user:inference', 'user:profile']));
  const t0 = 9000000;
  const hit = async function () {
    return {
      ok: false,
      status: 429,
      headers: { get: (n) => (n === 'retry-after' ? '3600' : null) },
      json: async () => ({}),
    };
  };
  const first = await usage.usageForProfiles(ctx, ['acct'], { fetch: hit, lock: false, nowMs: t0 });
  assert.strictEqual(first.acct.status, 'throttled');
  // still the same credential: stays quiet, nobody asks
  let asked = 0;
  const spy = async function () {
    asked++;
    return status(200, realShape())();
  };
  const quiet = await usage.usageForProfiles(ctx, ['acct'], { fetch: spy, lock: false, nowMs: t0 + 60000 });
  assert.strictEqual(quiet.acct.status, 'throttled');
  assert.strictEqual(asked, 0);
  // sign-in renewed: asked at once
  ctx.store.setProfile('acct', blobWith('tok-NEW', ['user:inference', 'user:profile']));
  const fresh = await usage.usageForProfiles(ctx, ['acct'], { fetch: spy, lock: false, nowMs: t0 + 120000 });
  assert.strictEqual(asked, 1);
  assert.strictEqual(fresh.acct.status, 'ok');
  assert.strictEqual(fresh.acct.usage.windows.length, 2);
});
