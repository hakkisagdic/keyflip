import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as prov from '../src/provusage.js';
import { makeCtx } from './helpers.js';

// Fixed clock so relative "resets in" strings are deterministic.
const NOW_MS = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01T00:00:00Z
// HERMETIC by default: env is EMPTY (never the developer's real env — so CODEX_HOME/API keys
// can't leak in) and fetch THROWS (so any un-injected network call fails loudly instead of
// sending a real token to a third-party host). Tests that need network inject their own stub.
function noNet() {
  throw new Error('test attempted a real network call (inject a fetch stub)');
}
function deps(over) {
  return Object.assign(
    {
      now: function () {
        return NOW_MS;
      },
      env: {},
      fetch: noNet,
    },
    over || {},
  );
}

function write(ctx, rel, data) {
  const abs = path.join(ctx.home, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof data === 'string' ? data : JSON.stringify(data));
  return abs;
}

// The canonical normalized window/read keys every provider must produce.
function assertNormalizedRead(r) {
  assert.ok(['ok', 'throttled', 'unknown', 'unauthenticated'].indexOf(r.status) !== -1, 'status enum: ' + r.status);
  assert.ok(Array.isArray(r.windows), 'windows is array');
  r.windows.forEach(function (w) {
    assert.deepStrictEqual(Object.keys(w).sort(), ['human', 'name', 'resetsAt', 'usedPct']);
    assert.ok(typeof w.name === 'string');
    assert.ok(w.usedPct === null || typeof w.usedPct === 'number');
    assert.ok(w.resetsAt === null || typeof w.resetsAt === 'string');
    assert.ok(w.human === null || typeof w.human === 'string');
  });
}

// ---------------------------------------------------------------------------
// resetWindow / helpers
// ---------------------------------------------------------------------------
test('resetWindow: unix seconds -> correct ISO + relative human string', function () {
  const in2h = Math.floor(NOW_MS / 1000) + 2 * 3600;
  const rw = prov.resetWindow({ unixSeconds: in2h }, deps());
  assert.strictEqual(rw.resetsAt, '2026-01-01T02:00:00.000Z');
  assert.strictEqual(rw.human, 'resets in 2h');
});

test('resetWindow: bare number heuristic (seconds vs ms), ISO string, inSeconds, null', function () {
  // seconds
  assert.strictEqual(prov.resetWindow(Math.floor(NOW_MS / 1000) + 90 * 60, deps()).human, 'resets in 1h 30m');
  // already-ms
  assert.strictEqual(prov.resetWindow(NOW_MS + 30 * 60000, deps()).resetsAt, '2026-01-01T00:30:00.000Z');
  // ISO passthrough
  assert.strictEqual(prov.resetWindow('2026-01-02T00:00:00Z', deps()).human, 'resets in 1d');
  // relative
  assert.strictEqual(prov.resetWindow({ inSeconds: 45 }, deps()).human, 'resets in <1m');
  // none
  assert.deepStrictEqual(prov.resetWindow(null, deps()), { resetsAt: null, human: null });
  // already elapsed
  assert.strictEqual(prov.resetWindow({ inSeconds: -10 }, deps()).human, 'resets now');
});

test('windowNameForMinutes buckets durations to canonical names', function () {
  assert.strictEqual(prov.windowNameForMinutes(300), '5h');
  assert.strictEqual(prov.windowNameForMinutes(10080), 'weekly');
  assert.strictEqual(prov.windowNameForMinutes(43200), 'monthly');
  assert.strictEqual(prov.windowNameForMinutes(60), '1h');
  assert.strictEqual(prov.windowNameForMinutes(null), 'window');
});

// ---------------------------------------------------------------------------
// codex (file) — real rate_limits JSONL format
// ---------------------------------------------------------------------------
function codexLine(rl) {
  return JSON.stringify({
    timestamp: '2026-01-01T00:00:00Z',
    type: 'event_msg',
    payload: { type: 'token_count', info: {}, rate_limits: rl },
  });
}

test('codex: parses newest session rate_limits into normalized windows with usedPct + resetsAt', function () {
  const ctx = makeCtx();
  const resetPrimary = Math.floor(NOW_MS / 1000) + 3600; // +1h
  const resetSecondary = Math.floor(NOW_MS / 1000) + 7 * 86400; // +7d
  const rl = {
    primary: { used_percent: 42.5, window_minutes: 300, resets_at: resetPrimary },
    secondary: { used_percent: 88, window_minutes: 10080, resets_at: resetSecondary },
  };
  // Two session files across dates; the lexicographically-later one must win.
  write(
    ctx,
    '.codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-aaaa.jsonl',
    codexLine({ primary: { used_percent: 1, window_minutes: 300, resets_at: resetPrimary } }),
  );
  write(
    ctx,
    '.codex/sessions/2026/01/02/rollout-2026-01-02T00-00-00-bbbb.jsonl',
    'garbage-not-json\n' +
      codexLine({ primary: { used_percent: 5, window_minutes: 300, resets_at: resetPrimary } }) +
      '\n' +
      codexLine(rl) +
      '\n',
  );

  const r = prov.readOne(makeReadyCtx(ctx), 'codex', deps());
  return r.then(function (out) {
    assert.strictEqual(out.present, true);
    assert.strictEqual(out.status, 'ok');
    assertNormalizedRead(out);
    assert.strictEqual(out.windows.length, 2);
    const five = out.windows.find(function (w) {
      return w.name === '5h';
    });
    const week = out.windows.find(function (w) {
      return w.name === 'weekly';
    });
    assert.strictEqual(five.usedPct, 42.5);
    assert.strictEqual(five.resetsAt, '2026-01-01T01:00:00.000Z');
    assert.strictEqual(five.human, 'resets in 1h');
    assert.strictEqual(week.usedPct, 88);
    assert.strictEqual(week.resetsAt, '2026-01-08T00:00:00.000Z');
  });
});

test('codex: older resets_in_seconds format is honored', function () {
  const ctx = makeCtx();
  write(
    ctx,
    '.codex/sessions/2026/01/01/rollout-x.jsonl',
    codexLine({ primary: { used_percent: 10, window_minutes: 300, resets_in_seconds: 1800 } }),
  );
  return prov.readOne(makeReadyCtx(ctx), 'codex', deps()).then(function (out) {
    assert.strictEqual(out.windows[0].resetsAt, '2026-01-01T00:30:00.000Z');
  });
});

test('codex: absent -> present:false and skipped by readAll', function () {
  const ctx = makeReadyCtx(makeCtx());
  return prov
    .readOne(ctx, 'codex', deps())
    .then(function (out) {
      assert.strictEqual(out.present, false);
      assert.strictEqual(out.status, 'unknown');
      return prov.readAll(ctx, deps());
    })
    .then(function (all) {
      assert.ok(
        !all.some(function (p) {
          return p.id === 'codex';
        }),
        'codex not in readAll when absent',
      );
    });
});

test('codex: malformed session file never throws -> status unknown', function () {
  const ctx = makeCtx();
  write(ctx, '.codex/sessions/2026/01/01/rollout-bad.jsonl', '{not json at all\n\x00\x01broken');
  return prov.readOne(makeReadyCtx(ctx), 'codex', deps()).then(function (out) {
    assert.strictEqual(out.present, true); // dir exists
    assert.strictEqual(out.status, 'unknown');
    assertNormalizedRead(out);
  });
});

test('codex: CODEX_HOME env override is respected', function () {
  const ctx = makeCtx();
  const alt = path.join(ctx.home, 'altcodex');
  fs.mkdirSync(path.join(alt, 'sessions', 'd'), { recursive: true });
  fs.writeFileSync(
    path.join(alt, 'sessions', 'd', 'rollout-z.jsonl'),
    codexLine({ primary: { used_percent: 33, window_minutes: 300, resets_at: Math.floor(NOW_MS / 1000) + 60 } }),
  );
  return prov.readOne(makeReadyCtx(ctx), 'codex', deps({ env: { CODEX_HOME: alt } })).then(function (out) {
    assert.strictEqual(out.status, 'ok');
    assert.strictEqual(out.windows[0].usedPct, 33);
  });
});

// ---------------------------------------------------------------------------
// gemini (cli) — injected fake runner
// ---------------------------------------------------------------------------
function fakeRunner(map) {
  return function (cmd, args) {
    const k = [cmd].concat(args || []).join(' ');
    if (map[k] !== undefined) return map[k];
    if (map[cmd] !== undefined) return map[cmd];
    return { code: -1, stdout: '', stderr: 'not found', error: true };
  };
}

test('gemini: injected runner output parses to normalized windows with usedPct + resetsAt', function () {
  const ctx = makeCtx();
  fs.mkdirSync(path.join(ctx.home, '.gemini'), { recursive: true });
  const out = {
    windows: [{ window_minutes: 1440, used_percent: 60, resets_at: Math.floor(NOW_MS / 1000) + 3 * 3600 }],
  };
  const d = deps({
    runner: fakeRunner({ 'gemini usage --json': { code: 0, stdout: JSON.stringify(out), stderr: '' } }),
  });
  return prov.readOne(makeReadyCtx(ctx), 'gemini', d).then(function (r) {
    assert.strictEqual(r.status, 'ok');
    assertNormalizedRead(r);
    assert.strictEqual(r.windows[0].name, 'daily');
    assert.strictEqual(r.windows[0].usedPct, 60);
    assert.strictEqual(r.windows[0].resetsAt, '2026-01-01T03:00:00.000Z');
  });
});

test('gemini: present but CLI missing -> status unknown, never throws', function () {
  const ctx = makeCtx();
  fs.mkdirSync(path.join(ctx.home, '.gemini'), { recursive: true });
  const d = deps({ runner: fakeRunner({}) }); // every command fails
  return prov.readOne(makeReadyCtx(ctx), 'gemini', d).then(function (r) {
    assert.strictEqual(r.present, true);
    assert.strictEqual(r.status, 'unknown');
    assertNormalizedRead(r);
  });
});

// ---------------------------------------------------------------------------
// opencode (file)
// ---------------------------------------------------------------------------
test('opencode: local usage file parses; absent usage -> unknown but present', function () {
  const ctx = makeCtx();
  write(ctx, '.local/share/opencode/usage.json', {
    windows: [{ name: 'weekly', usedPct: 12, resetsAt: '2026-01-02T00:00:00Z' }],
  });
  return prov
    .readOne(makeReadyCtx(ctx), 'opencode', deps())
    .then(function (r) {
      assert.strictEqual(r.status, 'ok');
      assert.strictEqual(r.windows[0].usedPct, 12);
      assert.strictEqual(r.windows[0].resetsAt, '2026-01-02T00:00:00.000Z');

      // now a present-but-no-usage-file install
      const ctx2 = makeCtx();
      fs.mkdirSync(path.join(ctx2.home, '.config', 'opencode'), { recursive: true });
      return prov.readOne(makeReadyCtx(ctx2), 'opencode', deps());
    })
    .then(function (r2) {
      assert.strictEqual(r2.present, true);
      assert.strictEqual(r2.status, 'unknown');
      assert.deepStrictEqual(r2.windows, []);
    });
});

// ---------------------------------------------------------------------------
// openrouter (api) — injected fake fetch
// ---------------------------------------------------------------------------
function fakeFetch(status, body, capture) {
  return async function (url, opts) {
    if (capture) capture.push({ url: url, headers: opts.headers });
    return {
      ok: status >= 200 && status < 300,
      status: status,
      json: async function () {
        return body;
      },
    };
  };
}

test('openrouter: reads balance via injected fetch; key referenced by ENV NAME only', function () {
  const cap = [];
  const d = deps({
    env: { OPENROUTER_API_KEY: 'sk-or-SECRET' },
    fetch: fakeFetch(
      200,
      { data: { label: 'k', limit: 200, usage: 50, limit_remaining: 150, is_free_tier: false } },
      cap,
    ),
  });
  const ctx = makeReadyCtx(makeCtx());
  return prov.readOne(ctx, 'openrouter', d).then(function (r) {
    assert.strictEqual(r.present, true);
    assert.strictEqual(r.status, 'ok');
    assertNormalizedRead(r);
    assert.strictEqual(r.windows[0].name, 'credits');
    assert.strictEqual(r.windows[0].usedPct, 25); // 50/200
    // secret never appears in raw; only used to build the Authorization header
    assert.ok(JSON.stringify(r.raw).indexOf('SECRET') === -1);
    assert.strictEqual(cap[0].headers.Authorization, 'Bearer sk-or-SECRET');
  });
});

test('openrouter: no env key -> unauthenticated and absent from readAll', function () {
  const d = deps({ env: {} });
  const ctx = makeReadyCtx(makeCtx());
  return prov
    .readOne(ctx, 'openrouter', d)
    .then(function (r) {
      assert.strictEqual(r.present, false); // detection keys off the env var
      return prov.readAll(ctx, d);
    })
    .then(function (all) {
      assert.ok(
        !all.some(function (p) {
          return p.id === 'openrouter';
        }),
      );
    });
});

test('openrouter: fetch throws / 401 -> degrades to unknown/unauthenticated, never throws', function () {
  const ctxOk = makeReadyCtx(makeCtx());
  const throwing = deps({
    env: { OPENROUTER_API_KEY: 'k' },
    fetch: async function () {
      throw new Error('offline');
    },
  });
  return prov
    .readOne(ctxOk, 'openrouter', throwing)
    .then(function (r) {
      assert.strictEqual(r.status, 'unknown');
      assertNormalizedRead(r);
      const unauth = deps({ env: { OPENROUTER_API_KEY: 'k' }, fetch: fakeFetch(401, {}) });
      return prov.readOne(ctxOk, 'openrouter', unauth);
    })
    .then(function (r2) {
      assert.strictEqual(r2.status, 'unauthenticated');
    });
});

// ---------------------------------------------------------------------------
// claude — delegates to src/usage.js (injected stub)
// ---------------------------------------------------------------------------
// Give the claude provider a detectable credential surface (a config file).
function withClaude(ctx) {
  fs.writeFileSync(ctx.claudeConfigPath, '{}');
  return ctx;
}

test('claude: delegates to usage.js and maps to normalized windows', function () {
  const ctx = withClaude(makeReadyCtx(makeCtx()));
  ctx.account = 'work';
  let delegated = false;
  const usageStub = {
    usageForProfiles: async function (c, names, opts) {
      delegated = true;
      assert.deepStrictEqual(names, ['work']);
      assert.strictEqual(typeof opts.nowMs, 'number');
      return {
        work: {
          status: 'ok',
          usage: {
            fiveHour: { pct: 30, resetsAt: '2026-01-01T05:00:00Z' },
            sevenDay: { pct: 70, resetsAt: null },
          },
        },
      };
    },
  };
  const d = deps({
    requireUsage: function () {
      return usageStub;
    },
  });
  return prov.readOne(ctx, 'claude', d).then(function (r) {
    assert.ok(delegated, 'usage.js was invoked');
    assert.strictEqual(r.status, 'ok');
    assertNormalizedRead(r);
    assert.deepStrictEqual(
      r.windows.map(function (w) {
        return w.name;
      }),
      ['5h', 'weekly'],
    );
    assert.strictEqual(r.windows[0].usedPct, 30);
    assert.strictEqual(r.windows[0].resetsAt, '2026-01-01T05:00:00.000Z');
    assert.strictEqual(r.windows[1].usedPct, 70);
  });
});

test('claude: delegate reporting expired -> unauthenticated; throwing delegate -> unknown', function () {
  const ctx = withClaude(makeReadyCtx(makeCtx()));
  const expired = deps({
    requireUsage: function () {
      return {
        usageForProfiles: async function () {
          return { tester: { status: 'expired', usage: null } };
        },
      };
    },
  });
  return prov
    .readOne(ctx, 'claude', expired)
    .then(function (r) {
      assert.strictEqual(r.status, 'unauthenticated');
      const boom = deps({
        requireUsage: function () {
          return {
            usageForProfiles: async function () {
              throw new Error('nope');
            },
          };
        },
      });
      return prov.readOne(ctx, 'claude', boom);
    })
    .then(function (r2) {
      assert.strictEqual(r2.status, 'unknown');
      assertNormalizedRead(r2);
    });
});

// ---------------------------------------------------------------------------
// cross-provider: identical normalized shape + readAll
// ---------------------------------------------------------------------------
test('every provider produces the identical normalized shape (keys match)', function () {
  const ctx = makeCtx();
  // make several present at once
  write(
    ctx,
    '.codex/sessions/2026/01/01/rollout-a.jsonl',
    codexLine({ primary: { used_percent: 5, window_minutes: 300, resets_at: Math.floor(NOW_MS / 1000) + 60 } }),
  );
  fs.mkdirSync(path.join(ctx.home, '.gemini'), { recursive: true });
  write(ctx, '.local/share/opencode/usage.json', {
    windows: [{ name: 'weekly', usedPct: 9, resetsAt: '2026-01-02T00:00:00Z' }],
  });
  const rctx = makeReadyCtx(ctx);
  const d = deps({
    env: { OPENROUTER_API_KEY: 'k' },
    fetch: fakeFetch(200, { data: { limit: 100, usage: 10 } }),
    runner: fakeRunner({
      'gemini usage --json': {
        code: 0,
        stdout: JSON.stringify({ used_percent: 1, window_minutes: 1440, resets_at: Math.floor(NOW_MS / 1000) + 60 }),
      },
    }),
    requireUsage: function () {
      return {
        usageForProfiles: async function () {
          return { tester: { status: 'ok', usage: { fiveHour: { pct: 2, resetsAt: null } } } };
        },
      };
    },
  });
  return prov.readAll(rctx, d).then(function (all) {
    assert.ok(
      all.length >= 4,
      'several providers present: ' +
        all
          .map(function (p) {
            return p.id;
          })
          .join(','),
    );
    const topKeys = ['id', 'kind', 'label', 'present', 'status', 'windows'];
    all.forEach(function (p) {
      topKeys.forEach(function (k) {
        assert.ok(k in p, p.id + ' missing ' + k);
      });
      assert.strictEqual(p.present, true);
      assertNormalizedRead(p);
    });
  });
});

test('normalizeRead coerces junk into the canonical shape and never throws', function () {
  const n = prov.normalizeRead({
    status: 'bogus',
    windows: [{ name: 5, usedPct: 'x', resetsAt: 12, human: {} }, null],
  });
  assert.strictEqual(n.status, 'unknown');
  assert.strictEqual(n.windows.length, 2);
  assert.deepStrictEqual(Object.keys(n.windows[0]).sort(), ['human', 'name', 'resetsAt', 'usedPct']);
  assert.strictEqual(n.windows[0].name, 'window');
  assert.strictEqual(n.windows[0].usedPct, null);
  assert.strictEqual(n.windows[0].resetsAt, null);
  assert.deepStrictEqual(prov.normalizeRead(undefined), { status: 'unknown', windows: [] });
});

test('registry: get() is null-prototype safe and unknown id -> null', function () {
  assert.strictEqual(prov.get('__proto__'), null);
  assert.strictEqual(prov.get('nope'), null);
  assert.strictEqual(prov.get('codex').id, 'codex');
});

// ---------------------------------------------------------------------------
// helper: a ctx with a claude config file so claudeProvider.detect() is stable
// across tests that don't care about Claude (kept OFF unless a test opts in).
// ---------------------------------------------------------------------------
function makeReadyCtx(ctx) {
  return ctx;
}
