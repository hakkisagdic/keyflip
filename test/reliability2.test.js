'use strict';
// Batch C: circuit breaker (#7), usage history + events (#12), doctor/test (#13).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const breaker = require('../src/breaker');
const history = require('../src/history');
const doctor = require('../src/doctor');
const provider = require('../src/provider');
const autosw = require('../src/autoswitch');
const core = require('../src/core');
const { makeCtx, writeClaude } = require('./helpers');

// ---- #7 breaker ----
test('breaker opens after N failures, recovers to half-open, closes on successes', function () {
  const ctx = makeCtx();
  const o = { failureThreshold: 3, recoveryMs: 1000, successesToClose: 2, nowMs: 0 };
  breaker.recordFailure(ctx, 'x', o);
  breaker.recordFailure(ctx, 'x', o);
  assert.strictEqual(breaker.state(ctx, 'x', { nowMs: 0 }), 'closed');
  breaker.recordFailure(ctx, 'x', o);                       // 3rd -> open
  assert.strictEqual(breaker.state(ctx, 'x', { nowMs: 0, recoveryMs: 1000 }), 'open');
  assert.strictEqual(breaker.isAvailable(ctx, 'x', { nowMs: 0, recoveryMs: 1000 }), false);
  // after recovery window -> half-open (eligible for a trial)
  assert.strictEqual(breaker.state(ctx, 'x', { nowMs: 2000, recoveryMs: 1000 }), 'half-open');
  assert.strictEqual(breaker.isAvailable(ctx, 'x', { nowMs: 2000, recoveryMs: 1000 }), true);
  breaker.recordSuccess(ctx, 'x', o);
  breaker.recordSuccess(ctx, 'x', o);                        // 2 successes -> closed
  assert.strictEqual(breaker.state(ctx, 'x', { nowMs: 2000 }), 'closed');
});

test('autoswitch skips a breaker-open candidate and logs a failover event', async function () {
  const ctx = makeCtx();
  function login(email, uid, tok) { writeClaude(ctx, { oauthAccount: { emailAddress: email }, userID: uid }); ctx.store.setLive(JSON.stringify({ claudeAiOauth: { accessToken: tok } })); }
  login('a@x.com', 'u1', 'TA'); core.addCurrent(ctx);
  login('b@x.com', 'u2', 'TB'); core.addCurrent(ctx);       // active b
  // force a's breaker open
  const bo = { failureThreshold: 1, nowMs: 0 };
  breaker.recordFailure(ctx, 'a', bo);
  const fetchMock = async function (url, o) {
    const tok = o.headers.Authorization.replace('Bearer ', '');
    return { ok: true, status: 200, json: async function () { return { five_hour: { utilization: tok === 'TB' ? 95 : 5 } }; } };
  };
  const r = await autosw.tick(ctx, { threshold: 90, fetch: fetchMock, nowMs: 0, cacheTtlMs: 0 });
  assert.strictEqual(r.state, 'no-candidate');               // a is open -> skipped, no other candidate
  // now clear a's breaker and it should switch + log an event
  breaker.reset(ctx, 'a');
  const r2 = await autosw.tick(ctx, { threshold: 90, fetch: fetchMock, nowMs: 10, cacheTtlMs: 0 });
  assert.strictEqual(r2.state, 'switched');
  const events = history.readEvents(ctx);
  assert.ok(events.some(function (e) { return e.kind === 'autoswitch' && e.to === 'a'; }));
});

// ---- #12 history ----
test('usage history + event log round-trip', function () {
  const ctx = makeCtx();
  history.recordUsage(ctx, 'a', { status: 'ok', usage: { fiveHour: { pct: 42 }, sevenDay: { pct: 10 } } });
  history.recordEvent(ctx, { kind: 'autoswitch', from: 'a', to: 'b', reason: 'test' });
  const u = history.readUsage(ctx);
  assert.strictEqual(u[0].account, 'a');
  assert.strictEqual(u[0].fiveHour, 42);
  assert.strictEqual(history.readEvents(ctx)[0].to, 'b');
});

// ---- #13 doctor ----
test('probe treats any HTTP status as reachable and network errors as failure', async function () {
  const ok = await doctor.probe('https://x/', { fetch: async function () { return { status: 404 }; }, clock: (function () { let t = 0; return function () { return (t += 5); }; })() });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.httpStatus, 404);
  const bad = await doctor.probe('https://x/', { fetch: async function () { throw new Error('ENOTFOUND'); } });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.reason, 'network');
});

test('diagnose reports provider reachability', async function () {
  const ctx = makeCtx();
  ctx.claudeSettingsPath = path.join(ctx.home, '.claude', 'settings.json');
  fs.mkdirSync(ctx.claudeDir || path.join(ctx.home, '.claude'), { recursive: true });
  provider.add(ctx, 'p', { baseUrl: 'https://p/v1' });
  const r = await doctor.diagnose(ctx, { fetch: async function () { return { status: 200 }; }, clock: (function () { let t = 0; return function () { return (t += 7); }; })() });
  const pc = r.checks.filter(function (c) { return c.name === 'provider p'; })[0];
  assert.ok(pc && /reachable/.test(pc.detail));
});

test('testProvider categorizes 401 as an auth failure', async function () {
  const ctx = makeCtx();
  provider.add(ctx, 'p', { baseUrl: 'https://p/v1', key: 'k', authScheme: 'bearer' });
  const r = await doctor.testProvider(ctx, 'p', { fetch: async function () { return { status: 401 }; }, clock: (function () { let t = 0; return function () { return (t += 3); }; })() });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.category, 'auth');
});
