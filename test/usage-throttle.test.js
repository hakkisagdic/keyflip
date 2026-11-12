// P1: the usage endpoint answered 429 and keyflip ignored Retry-After; every caller on the machine
// (CLI, MCP, the autoswitch service, a quota guard shelling `keyflip usage --json`) polled on its
// own. These tests drive a FAKE endpoint — 429 with and without Retry-After — and count requests.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import * as usage from '../src/usage.js';
import * as autosw from '../src/autoswitch.js';
import * as core from '../src/core.js';
import { makeCtx, writeClaude } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOW = 1800000000000;

function blob(tok) {
  return JSON.stringify({ claudeAiOauth: { accessToken: tok } });
}
// A fake usage endpoint. `plan` maps token -> array of responses consumed in order (the last repeats):
//   { pct } | { status: 429, retryAfter?: '120' | http-date } | { status: 401 }
function endpoint(plan) {
  const calls = [];
  const f = async function (url, opts) {
    const tok = opts.headers.Authorization.replace('Bearer ', '');
    calls.push(tok);
    const seq = plan[tok] || [{ status: 401 }];
    const n = calls.filter(function (t) {
      return t === tok;
    }).length;
    const step = seq[Math.min(n, seq.length) - 1];
    if (step.status) {
      const h = {};
      if (step.retryAfter !== undefined) h['retry-after'] = step.retryAfter;
      return { ok: false, status: step.status, headers: { get: (k) => (k in h ? h[k] : null) } };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ five_hour: { utilization: step.pct, resets_at: step.resetsAt || null } }),
    };
  };
  f.calls = calls;
  return f;
}

test('parseRetryAfter reads delta-seconds and HTTP dates, and caps garbage', function () {
  assert.strictEqual(usage.parseRetryAfter('120', NOW), 120000);
  assert.strictEqual(usage.parseRetryAfter('1.5', NOW), 1500);
  assert.strictEqual(usage.parseRetryAfter(new Date(NOW + 90000).toUTCString(), NOW), 90000);
  assert.strictEqual(usage.parseRetryAfter('soon', NOW), null);
  assert.strictEqual(usage.parseRetryAfter(null, NOW), null);
  assert.strictEqual(usage.parseRetryAfter('99999999', NOW), 6 * 3600 * 1000, 'capped at 6h');
});

test('fetchUsageDetailed surfaces Retry-After on a 429', async function () {
  const f = endpoint({ T: [{ status: 429, retryAfter: '300' }] });
  const r = await usage.fetchUsageDetailed('T', { fetch: f, nowMs: NOW });
  assert.strictEqual(r.httpStatus, 429);
  assert.strictEqual(r.retryAfterMs, 300000);
});

test('a 429 with Retry-After keeps EVERY caller quiet until then, then polls once', async function () {
  const ctx = makeCtx();
  ctx.store.setProfile('a', blob('TA'));
  const f = endpoint({ TA: [{ status: 429, retryAfter: '600' }, { pct: 40 }] });
  const r1 = await usage.usageForProfiles(ctx, ['a'], { fetch: f, nowMs: NOW, cacheTtlMs: 60000 });
  assert.strictEqual(r1.a.status, 'throttled');
  assert.strictEqual(r1.a.retryAt, NOW + 600000);
  // Five more callers inside the window (any TTL, even 0 — the window is not the cache TTL).
  for (let i = 1; i <= 5; i++) {
    const r = await usage.usageForProfiles(ctx, ['a'], { fetch: f, nowMs: NOW + i * 100000 - 1, cacheTtlMs: 0 });
    assert.strictEqual(r.a.status, 'throttled');
  }
  assert.strictEqual(f.calls.length, 1, 'nobody polled inside the Retry-After window');
  const after = await usage.usageForProfiles(ctx, ['a'], { fetch: f, nowMs: NOW + 600001, cacheTtlMs: 0 });
  assert.strictEqual(after.a.status, 'ok');
  assert.strictEqual(after.a.headroom, 60);
  assert.strictEqual(f.calls.length, 2);
});

test('without Retry-After, consecutive 429s back off exponentially (capped), and success resets it', async function () {
  const ctx = makeCtx();
  ctx.store.setProfile('a', blob('TA'));
  const f = endpoint({ TA: [{ status: 429 }, { status: 429 }, { status: 429 }, { pct: 10 }, { status: 429 }] });
  const base = usage.THROTTLE_BASE_MS;
  let t = NOW;
  const r1 = await usage.usageForProfiles(ctx, ['a'], { fetch: f, nowMs: t, cacheTtlMs: 0 });
  assert.strictEqual(r1.a.retryAt - t, base);
  t = r1.a.retryAt;
  const r2 = await usage.usageForProfiles(ctx, ['a'], { fetch: f, nowMs: t, cacheTtlMs: 0 });
  assert.strictEqual(r2.a.retryAt - t, 2 * base, 'second strike doubles');
  t = r2.a.retryAt;
  const r3 = await usage.usageForProfiles(ctx, ['a'], { fetch: f, nowMs: t, cacheTtlMs: 0 });
  assert.strictEqual(r3.a.retryAt - t, 4 * base);
  t = r3.a.retryAt;
  const r4 = await usage.usageForProfiles(ctx, ['a'], { fetch: f, nowMs: t, cacheTtlMs: 0 });
  assert.strictEqual(r4.a.status, 'ok');
  const r5 = await usage.usageForProfiles(ctx, ['a'], { fetch: f, nowMs: t + 1, cacheTtlMs: 0 });
  assert.strictEqual(r5.a.retryAt - (t + 1), base, 'a success resets the strike count');
  assert.strictEqual(usage.throttleWindowMs(30, null, 0), usage.THROTTLE_MAX_MS, 'capped');
  assert.strictEqual(usage.throttleWindowMs(1, 5 * 60000, 0), 5 * 60000, 'Retry-After longer than backoff wins');
  assert.strictEqual(usage.throttleWindowMs(1, 2000, 0), base, 'never shorter than the base window');
});

test('the shared cache: callers with a stale cache re-read it under the lock and do not re-poll', async function () {
  const ctx = makeCtx();
  ctx.store.setProfile('a', blob('TA'));
  const f = endpoint({ TA: [{ pct: 30 }] });
  // Two concurrent callers, same instant: one polls, the other finds the fresh entry after the lock.
  const [x, y] = await Promise.all([
    usage.usageForProfiles(ctx, ['a'], { fetch: f, nowMs: NOW, cacheTtlMs: 60000 }),
    usage.usageForProfiles(ctx, ['a'], { fetch: f, nowMs: NOW, cacheTtlMs: 60000 }),
  ]);
  assert.strictEqual(x.a.headroom, 70);
  assert.strictEqual(y.a.headroom, 70);
  assert.strictEqual(f.calls.length, 1, 'one request for two callers');
});

test('a busy usage lock never turns into a second poll: the caller gets the last reading as pending', async function () {
  const ctx = makeCtx();
  ctx.store.setProfile('a', blob('TA'));
  const f = endpoint({ TA: [{ pct: 30 }] });
  await usage.usageForProfiles(ctx, ['a'], { fetch: f, nowMs: NOW, cacheTtlMs: 1000 });
  // Another live process holds the usage lock (this test's parent pid stands in for it).
  fs.writeFileSync(
    path.join(ctx.configDir, '.lock-usage'),
    JSON.stringify({ pid: process.ppid || process.pid, at: Date.now(), token: 'other' }),
  );
  const r = await usage.usageForProfiles(ctx, ['a'], {
    fetch: f,
    nowMs: NOW + 5000,
    cacheTtlMs: 1000,
    lockTimeoutMs: 50,
  });
  assert.strictEqual(r.a.status, 'pending');
  assert.strictEqual(usage.headroom(r.a.lastGood), 70);
  assert.strictEqual(f.calls.length, 1);
});

test('cross-process: N real processes calling `keyflip usage --json` together cost ONE request per account', async function () {
  // Real processes share the cache file + lock. The endpoint is a fake HTTP server; usage.js is
  // pointed at it by a --import preload that swaps global fetch (no network, no real token).
  const ctx = makeCtx();
  const http = await import('http');
  let hits = 0;
  const srv = http.createServer(function (req, res) {
    hits++;
    setTimeout(function () {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ five_hour: { utilization: 12 } }));
    }, 150);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const pre = path.join(ctx.home, 'fetch-redirect.mjs');
  fs.writeFileSync(
    pre,
    "const real = globalThis.fetch; globalThis.fetch = (u, o) => real('http://127.0.0.1:" + port + "/', o);\n",
  );
  const script = path.join(ctx.home, 'probe.mjs');
  fs.writeFileSync(
    script,
    "import * as usage from '" +
      path.join(__dirname, '..', 'src', 'usage.js').replace(/\\/g, '/') +
      "';\n" +
      "const ctx = { configDir: process.argv[2], store: { getProfile: () => JSON.stringify({ claudeAiOauth: { accessToken: 'T' } }), getLive: () => null } };\n" +
      "const r = await usage.usageForProfiles(ctx, ['a'], { cacheTtlMs: 60000 });\n" +
      'process.stdout.write(String(r.a.headroom));\n',
  );
  const runs = [];
  for (let i = 0; i < 5; i++) {
    runs.push(
      new Promise(function (resolve) {
        const p = spawn(process.execPath, ['--import', pre, script, ctx.configDir], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        p.on('close', () => resolve(out));
      }),
    );
  }
  const outs = await Promise.all(runs);
  srv.close();
  assert.deepStrictEqual(outs, ['88', '88', '88', '88', '88']);
  assert.strictEqual(hits, 1, 'five processes, one poll');
});

function login(ctx, email, uid, tok) {
  writeClaude(ctx, { oauthAccount: { emailAddress: email }, userID: uid });
  ctx.store.setLive(blob(tok));
}
function twoAccounts() {
  const ctx = makeCtx();
  login(ctx, 'a@x.com', 'u1', 'TA');
  core.addCurrent(ctx);
  login(ctx, 'b@x.com', 'u2', 'TB');
  core.addCurrent(ctx); // b active
  return ctx;
}

test('autoswitch: a RECENT last-good reading over the threshold still switches while the endpoint 429s', async function () {
  const ctx = twoAccounts();
  // b read 97% a minute ago; now the endpoint throttles both tokens.
  const warm = endpoint({ TB: [{ pct: 97 }], TA: [{ pct: 10 }] });
  await usage.usageForProfiles(ctx, ['b', 'a'], { fetch: warm, nowMs: NOW, cacheTtlMs: 0 });
  const f = endpoint({ TB: [{ status: 429, retryAfter: '900' }], TA: [{ status: 429, retryAfter: '900' }] });
  const r = await autosw.tick(ctx, { threshold: 95, fetch: f, nowMs: NOW + 60000, cacheTtlMs: 0, maxStaleMs: 900000 });
  assert.strictEqual(r.state, 'switched');
  assert.strictEqual(r.basis, 'last-good');
  assert.strictEqual(r.switchedTo.name, 'a');
});

test('autoswitch: an OLD or reset last-good reading is not trusted (never switches blind)', async function () {
  const ctx = twoAccounts();
  const warm = endpoint({ TB: [{ pct: 97, resetsAt: new Date(NOW + 30000).toISOString() }], TA: [{ pct: 10 }] });
  await usage.usageForProfiles(ctx, ['b', 'a'], { fetch: warm, nowMs: NOW, cacheTtlMs: 0 });
  const f = endpoint({ TB: [{ status: 429 }], TA: [{ status: 429 }] });
  // The 5h window reset at NOW+30s: the 97% no longer describes the account.
  const reset = await autosw.tick(ctx, {
    threshold: 95,
    fetch: f,
    nowMs: NOW + 60000,
    cacheTtlMs: 0,
    maxStaleMs: 900000,
  });
  assert.strictEqual(reset.state, 'unknown');
  assert.strictEqual(reset.usageStatus, 'throttled');
  assert.ok(reset.retryAt > NOW + 60000);
  const ctx2 = twoAccounts();
  await usage.usageForProfiles(ctx2, ['b', 'a'], {
    fetch: endpoint({ TB: [{ pct: 97 }], TA: [{ pct: 10 }] }),
    nowMs: NOW,
    cacheTtlMs: 0,
  });
  const old = await autosw.tick(ctx2, {
    threshold: 95,
    fetch: f,
    nowMs: NOW + 3600000,
    cacheTtlMs: 0,
    maxStaleMs: 900000,
  });
  assert.strictEqual(old.state, 'unknown', 'an hour-old reading is too old');
});
