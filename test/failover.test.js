// P4: API failover through keysmith. keysmith OWNS the failover: its alias `claude-failover`
// (gmail API key -> kiro-emu -> agy) and the spend cap on the paid first leg (25 USD over a window).
// keyflip only reads them, mints a scoped key and engages once the running gateway reports the cap;
// it never creates an alias or writes a cap. keysmith is never run: a fake runner stands in for its
// CLI, a temp file for its config, a fake fetch for its gateway. No real key, keychain, settings or app.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { makeCtx, writeClaude } from './helpers.js';
import * as failover from '../src/failover.js';
import * as provider from '../src/provider.js';
import * as autosw from '../src/autoswitch.js';
import * as core from '../src/core.js';
import * as history from '../src/history.js';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const GATEWAY_KEY = 'ks_FAKE_GATEWAY_KEY_FOR_TESTS';
const LEGS = ['claude-failover-api/claude-opus-5-5', 'kiro-emu/claude-opus-5.5', 'agy/claude-sonnet-5-5-low'];

// keysmith's config as it is on the machine since 12 Nov: the failover alias, its own adapter for the
// gmail key, a windowed 25 USD cap on it — and claude-api, which the failover must leave alone.
function keysmithConfig(ctx, edit) {
  const p = path.join(ctx.home, 'keysmith', 'config.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const c = {
    host: '127.0.0.1',
    port: 8787,
    auth: { keys: ['ks_EXISTING'] },
    adapters: {
      'claude-api': { kind: 'http', apiKey: '{exec:/usr/bin/security find-generic-password -s gmail-api -w}' },
      'claude-failover-api': { kind: 'http', apiKey: '{exec:/usr/bin/security find-generic-password -s gmail-api -w}' },
    },
    aliases: { chat: ['agy/gemini-4-argon-high'], 'claude-failover': LEGS.slice() },
    limits: { spend: { 'claude-failover-api': { usd: 25, since: '2026-11-12', until: '2026-12-09' }, other: 5 } },
  };
  if (edit) edit(c);
  fs.writeFileSync(p, JSON.stringify(c, null, 2), { mode: 0o600 });
  return p;
}
// Plays keysmith's CLI: records argv; `key add … --out F` writes a key into F like the real one.
function fakeKeysmith(state) {
  return function (cmd, args) {
    (state.calls = state.calls || []).push([cmd].concat(args || []));
    if (cmd === 'which') return { code: 1, stdout: '' };
    const sub = args.slice(1);
    if (sub[0] === 'key' && sub[1] === 'add') {
      if (state.keyFails) return { code: 1, stdout: '', stderr: 'unknown pattern' };
      const out = sub[sub.indexOf('--out') + 1];
      fs.writeFileSync(out, GATEWAY_KEY + '\n', { mode: 0o600 });
      return { code: 0, stdout: 'added (written to file)' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
}

test('the plan: keysmith alias claude-failover, legs and paid leg read from keysmith, at most $25', function () {
  const ctx = makeCtx();
  const p = failover.plan(ctx);
  assert.strictEqual(p.alias, 'claude-failover');
  assert.strictEqual(p.capUsd, 25);
  assert.strictEqual(p.gatewayUrl, 'http://127.0.0.1:8787');
  assert.strictEqual(p.legs, null, 'keyflip has no legs of its own');
  const rp = failover.resolvePlan(ctx, { keysmithConfig: keysmithConfig(ctx) });
  assert.deepStrictEqual(rp.legs, LEGS);
  assert.strictEqual(rp.capAdapter, 'claude-failover-api');
  assert.deepStrictEqual(rp.configCap, { usd: 25, text: '$25 over 2026-11-12..2026-12-09' });
});

test('setup: checks keysmith alias + cap (never edits them), mints a scoped key, saves the provider', async function () {
  const ctx = makeCtx();
  const cfgPath = keysmithConfig(ctx);
  const before = fs.readFileSync(cfgPath, 'utf8');
  const state = {};
  const r = await failover.setup(ctx, {
    run: fakeKeysmith(state),
    keysmithConfig: cfgPath,
    keysmithDir: '/opt/keysmith',
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r.steps));
  assert.deepStrictEqual(
    r.steps.map((s) => s.step),
    ['alias', 'spend-cap', 'key', 'provider'],
  );
  assert.ok(/claude-failover = claude-failover-api\/claude-opus-5-5 -> kiro-emu/.test(r.steps[0].detail));
  assert.ok(/\$25 over 2026-11-12\.\.2026-12-09/.test(r.steps[1].detail), r.steps[1].detail);
  // keysmith ran exactly once: the key. No `alias`, nothing else.
  const ks = state.calls.filter((c) => c[0] !== 'which');
  assert.strictEqual(ks.length, 1);
  assert.deepStrictEqual(ks[0].slice(0, 5), [
    process.execPath,
    '/opt/keysmith/src/cli.js',
    'key',
    'add',
    'keyflip-failover',
  ]);
  assert.ok(!state.calls.some((c) => c.indexOf('alias') !== -1), 'no alias created or changed');
  const allow = ks[0][ks[0].indexOf('--allow') + 1].split(',');
  assert.deepStrictEqual(allow, ['alias:claude-failover'].concat(LEGS));
  assert.ok(
    !allow.some((a) => a === 'claude-api' || a.indexOf('claude-api/') === 0),
    'the key cannot reach claude-api',
  );
  assert.ok(ks[0].indexOf('--out') !== -1, 'the key comes back through a file, never stdout');
  assert.strictEqual(ctx.store.getProfile('provider__keysmith-failover'), GATEWAY_KEY);
  assert.ok(JSON.stringify(r).indexOf(GATEWAY_KEY) === -1, 'the key is in no result');
  assert.strictEqual(fs.readFileSync(cfgPath, 'utf8'), before, "keysmith's config is not touched (caps, aliases)");
  const meta = provider.read(ctx, 'keysmith-failover');
  assert.strictEqual(meta.baseUrl, 'http://127.0.0.1:8787');
  assert.strictEqual(meta.models.default, 'claude-failover');
  assert.strictEqual(meta.models.smallFast, 'claude-failover', 'background models go through the alias too');
  assert.strictEqual(provider.readActive(ctx), null, 'saved, not put in use');
  assert.strictEqual(r.restartGateway, false, 'nothing keysmith reads at start changed');
});

test('REGRESSION: setup never creates the alias — a keysmith without claude-failover fails the setup', async function () {
  const ctx = makeCtx();
  const cfgPath = keysmithConfig(ctx, (c) => delete c.aliases['claude-failover']);
  const before = fs.readFileSync(cfgPath, 'utf8');
  const state = {};
  const r = await failover.setup(ctx, { run: fakeKeysmith(state), keysmithConfig: cfgPath });
  assert.strictEqual(r.ok, false);
  assert.ok(/keysmith has no alias claude-failover/.test(r.steps[0].detail), r.steps[0].detail);
  assert.ok(!(state.calls || []).some((c) => c[0] !== 'which'), 'keysmith never run');
  assert.strictEqual(fs.readFileSync(cfgPath, 'utf8'), before);
  assert.strictEqual(ctx.store.getProfile('provider__keysmith-failover'), null, 'no key minted');
  assert.strictEqual(provider.exists(ctx, 'keysmith-failover'), false);
  const none = await failover.setup(makeCtx(), { run: fakeKeysmith({}), keysmithConfig: '/nonexistent/keysmith.json' });
  assert.strictEqual(none.ok, false);
  assert.ok(/could not read the keysmith config/.test(none.steps[0].detail));
});

test('REGRESSION: setup never writes a cap — a missing or looser one is reported and the failover stays off', async function () {
  for (const edit of [
    (c) => delete c.limits.spend['claude-failover-api'],
    (c) => (c.limits.spend['claude-failover-api'] = { usd: 185, since: '2026-11-06', until: '2026-12-09' }),
  ]) {
    const ctx = makeCtx();
    const cfgPath = keysmithConfig(ctx, edit);
    const before = fs.readFileSync(cfgPath, 'utf8');
    const r = await failover.setup(ctx, { run: fakeKeysmith({}), keysmithConfig: cfgPath });
    const step = r.steps.find((s) => s.step === 'spend-cap');
    assert.strictEqual(step.ok, false, step.detail);
    assert.ok(/keyflip never writes caps|looser than the \$25/.test(step.detail), step.detail);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(fs.readFileSync(cfgPath, 'utf8'), before, 'no cap added or replaced');
  }
  // a stricter cap, nested the other way keysmith accepts, is fine as it is
  const ctx = makeCtx();
  const cfgPath = keysmithConfig(ctx, (c) => (c.limits.spend = { adapters: { 'claude-failover-api': 10 } }));
  const r = await failover.setup(ctx, { run: fakeKeysmith({}), keysmithConfig: cfgPath });
  assert.strictEqual(r.steps.find((s) => s.step === 'spend-cap').ok, true);
});

test('setup is idempotent: no second key', async function () {
  const ctx = makeCtx();
  const cfgPath = keysmithConfig(ctx);
  await failover.setup(ctx, { run: fakeKeysmith({}), keysmithConfig: cfgPath });
  const s2 = {};
  const r = await failover.setup(ctx, { run: fakeKeysmith(s2), keysmithConfig: cfgPath });
  assert.strictEqual(r.ok, true);
  assert.ok(!(s2.calls || []).some((c) => c.indexOf('key') !== -1 && c.indexOf('add') !== -1), 'no second key minted');
});

test('setup --dry-run writes nothing and runs nothing', async function () {
  const ctx = makeCtx();
  const cfgPath = keysmithConfig(ctx);
  const before = fs.readFileSync(cfgPath, 'utf8');
  const state = {};
  const r = await failover.setup(ctx, { run: fakeKeysmith(state), keysmithConfig: cfgPath, dryRun: true });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(state.calls || [], []);
  assert.strictEqual(fs.readFileSync(cfgPath, 'utf8'), before);
  assert.strictEqual(provider.exists(ctx, 'keysmith-failover'), false);
  assert.strictEqual(ctx.store.getProfile('provider__keysmith-failover'), null);
});

test('a failing keysmith step is reported, not hidden', async function () {
  const ctx = makeCtx();
  const r = await failover.setup(ctx, { run: fakeKeysmith({ keyFails: true }), keysmithConfig: keysmithConfig(ctx) });
  assert.strictEqual(r.ok, false);
  assert.ok(/unknown pattern/.test(r.steps.find((s) => s.step === 'key').detail));
});

// The running gateway: /v1/models, and /v1/keysmith/usage reporting the spend caps it LOADED, as
// keysmith returns them to the scoped key (spent = that key's own share). Default: the windowed $25.
function gateway(models, status, spend) {
  const calls = [];
  const rows =
    spend !== undefined
      ? spend
      : [
          {
            kind: 'adapter',
            target: 'claude-failover-api',
            spent: 0,
            cap: 25,
            exceeded: false,
            window: { since: '2026-11-12', until: '2026-12-09' },
            windowStatus: 'open',
            month: null,
            resetAt: null,
          },
        ];
  const f = async (url, opts) => {
    calls.push({ url: url, auth: opts.headers.Authorization });
    if (status) return { ok: false, status: status };
    if (/\/v1\/keysmith\/usage/.test(url)) {
      if (rows === null) return { ok: false, status: 404 };
      return { ok: true, status: 200, json: async () => ({ summary: {}, spend: rows }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: models.map((id) => ({ id: id })) }) };
  };
  f.calls = calls;
  return f;
}
async function setUp(ctx) {
  const cfgPath = keysmithConfig(ctx);
  await failover.setup(ctx, { run: fakeKeysmith({}), keysmithConfig: cfgPath });
  return cfgPath;
}

test('gatewayReady: up + serving the alias + the cap; not set up; alias missing; unreachable', async function () {
  const ctx = makeCtx();
  assert.ok(/not set up/.test((await failover.gatewayReady(ctx, { fetch: gateway(['claude-failover']) })).reason));
  const ksc = await setUp(ctx);
  const f = gateway(['claude-failover', 'chat']);
  const ok = await failover.gatewayReady(ctx, { fetch: f, keysmithConfig: ksc });
  assert.strictEqual(ok.ok, true, ok.reason);
  assert.deepStrictEqual(ok.cap, {
    kind: 'adapter',
    target: 'claude-failover-api',
    cap: 25,
    spent: 0,
    exceeded: false,
    window: { since: '2026-11-12', until: '2026-12-09' },
    windowStatus: 'open',
  });
  assert.strictEqual(failover.capText(ok.cap), '$25 over 2026-11-12..2026-12-09');
  assert.strictEqual(f.calls[0].url, 'http://127.0.0.1:8787/v1/models');
  assert.strictEqual(f.calls[0].auth, 'Bearer ' + GATEWAY_KEY);
  const noAlias = await failover.gatewayReady(ctx, { fetch: gateway(['chat']), keysmithConfig: ksc });
  assert.ok(/does not serve claude-failover/.test(noAlias.reason));
  const down = async () => {
    throw new Error('ECONNREFUSED');
  };
  assert.ok(/unreachable/.test((await failover.gatewayReady(ctx, { fetch: down, keysmithConfig: ksc })).reason));
});

test('REGRESSION: the failover never engages uncapped — the RUNNING gateway must report the cap', async function () {
  const ctx = makeCtx();
  const ksc = await setUp(ctx);
  // the config holds the cap, but the running gateway does not enforce one
  const noCap = gateway(['claude-failover'], null, []);
  const r1 = await failover.gatewayReady(ctx, { fetch: noCap, keysmithConfig: ksc });
  assert.strictEqual(r1.ok, false);
  assert.ok(/no spend cap of at most \$25 on claude-failover-api/.test(r1.reason), r1.reason);
  // an older gateway with no usage route: cannot prove the cap -> refuse
  const r2 = await failover.gatewayReady(ctx, { fetch: gateway(['claude-failover'], null, null), keysmithConfig: ksc });
  assert.strictEqual(r2.ok, false);
  assert.ok(/refusing to fail over uncapped/.test(r2.reason));
  // a looser cap, or a cap on another adapter (claude-api), does not count
  for (const rows of [
    [{ kind: 'adapter', target: 'claude-failover-api', cap: 185 }],
    [{ kind: 'adapter', target: 'claude-api', cap: 25 }],
  ])
    assert.strictEqual(
      (await failover.gatewayReady(ctx, { fetch: gateway(['claude-failover'], null, rows), keysmithConfig: ksc })).ok,
      false,
    );
  // the legs unknown (keysmith config unreadable): no paid leg to check -> refuse
  const blind = await failover.gatewayReady(ctx, {
    fetch: gateway(['claude-failover']),
    keysmithConfig: '/nonexistent',
  });
  assert.strictEqual(blind.ok, false);
  const log = [];
  const e = await failover.engage(
    ctx,
    { from: 'gmail' },
    { fetch: noCap, keysmithConfig: ksc, useProvider: () => log.push('use') },
  );
  assert.strictEqual(e.ok, false);
  assert.deepStrictEqual(log, [], 'Claude Code was never pointed at the gateway');
  assert.strictEqual(failover.state(ctx), null);
  // the per-tick health check does not re-prove the cap (proven at engage), only that it serves
  assert.strictEqual((await failover.gatewayReady(ctx, { fetch: noCap, capCheck: false })).ok, true);
  // a reached cap still engages: keysmith skips the paid leg and the free legs carry on
  const spent = gateway(['claude-failover'], null, [
    { kind: 'adapter', target: 'claude-failover-api', cap: 25, spent: 25.2, exceeded: true },
  ]);
  const ok = await failover.gatewayReady(ctx, { fetch: spent, keysmithConfig: ksc });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.cap.exceeded, true);
});

test('engage points Claude Code at the gateway, asks Desktop to follow, records it; release undoes it', async function () {
  const ctx = makeCtx();
  const ksc = await setUp(ctx);
  const log = [];
  const deps = {
    fetch: gateway(['claude-failover']),
    keysmithConfig: ksc,
    useProvider: (n) => log.push('use:' + n),
    useOfficial: () => log.push('official'),
    requestDesktop: (rec) => log.push('desktop:' + rec.kind),
    notify: async (ev, msg) => log.push('notify:' + ev + ':' + msg),
  };
  const e = await failover.engage(ctx, { from: 'gmail' }, deps);
  assert.strictEqual(e.ok, true, e.reason);
  assert.ok(failover.state(ctx).engaged);
  assert.strictEqual(failover.state(ctx).alias, 'claude-failover');
  assert.strictEqual(failover.state(ctx).cap.cap, 25);
  assert.deepStrictEqual(log.slice(0, 2), ['use:keysmith-failover', 'desktop:gateway-on']);
  assert.ok(/capped at \$25 over 2026-11-12\.\.2026-12-09 by keysmith/.test(log[2]), log[2]);
  assert.strictEqual((await failover.engage(ctx, {}, deps)).already, true, 'engaging twice is a no-op');
  const r = await failover.release(ctx, { to: 'yahoo' }, deps);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(failover.state(ctx), null);
  assert.ok(log.includes('official') && log.includes('desktop:gateway-off'));
  const kinds = history.readEvents(ctx).map((x) => x.kind);
  assert.ok(kinds.includes('failover-engage') && kinds.includes('failover-release'));
});

test('engage refuses when the gateway is not ready, and changes nothing', async function () {
  const ctx = makeCtx();
  const ksc = await setUp(ctx);
  const log = [];
  const r = await failover.engage(
    ctx,
    {},
    {
      fetch: gateway([], 502),
      keysmithConfig: ksc,
      useProvider: () => log.push('use'),
      requestDesktop: () => log.push('d'),
    },
  );
  assert.strictEqual(r.ok, false);
  assert.ok(/502/.test(r.reason));
  assert.deepStrictEqual(log, []);
  assert.strictEqual(failover.state(ctx), null);
});

// ---- the autoswitch tick drives it ----
function login(ctx, email, uid, tok) {
  writeClaude(ctx, { oauthAccount: { emailAddress: email }, userID: uid });
  ctx.store.setLive(JSON.stringify({ claudeAiOauth: { accessToken: tok } }));
}
function usageFetch(pct) {
  return async (url, opts) => {
    const tok = opts.headers.Authorization.replace('Bearer ', '');
    if (pct[tok] === undefined) return { ok: false, status: 401, headers: { get: () => null } };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ five_hour: { utilization: pct[tok] } }),
    };
  };
}
function fakeFailover() {
  const st = { engaged: null, log: [] };
  return {
    st: st,
    api: {
      state: () => st.engaged,
      engage: async (info) => {
        st.log.push('engage:' + info.from);
        st.engaged = { engaged: true };
        return { ok: true, state: st.engaged };
      },
      release: async (info) => {
        st.log.push('release:' + info.to);
        st.engaged = null;
        return { ok: true };
      },
    },
  };
}

test('tick: every account over the threshold -> failover engaged instead of waiting', async function () {
  const ctx = makeCtx();
  login(ctx, 'a@x.com', 'u1', 'TA');
  core.addCurrent(ctx);
  login(ctx, 'b@x.com', 'u2', 'TB');
  core.addCurrent(ctx);
  const fo = fakeFailover();
  const r = await autosw.tick(ctx, {
    threshold: 95,
    fetch: usageFetch({ TB: 99, TA: 97 }),
    nowMs: 1,
    cacheTtlMs: 0,
    failover: fo.api,
  });
  assert.strictEqual(r.state, 'failover-engaged');
  assert.deepStrictEqual(fo.st.log, ['engage:b']);
  // still exhausted next tick: stays on failover, engages nothing new
  const r2 = await autosw.tick(ctx, {
    threshold: 95,
    fetch: usageFetch({ TB: 99, TA: 97 }),
    nowMs: 2,
    cacheTtlMs: 0,
    failover: fo.api,
  });
  assert.strictEqual(r2.state, 'failover');
  assert.deepStrictEqual(fo.st.log, ['engage:b']);
  // b drops to 90%: under the threshold but inside the hysteresis band -> still on failover (no flapping)
  const r3 = await autosw.tick(ctx, {
    threshold: 95,
    fetch: usageFetch({ TB: 90, TA: 97 }),
    nowMs: 3,
    cacheTtlMs: 0,
    failover: fo.api,
  });
  assert.strictEqual(r3.state, 'failover');
  // b's window resets -> back to Claude
  const r4 = await autosw.tick(ctx, {
    threshold: 95,
    fetch: usageFetch({ TB: 10, TA: 97 }),
    nowMs: 4,
    cacheTtlMs: 0,
    failover: fo.api,
  });
  assert.strictEqual(r4.state, 'failback');
  assert.deepStrictEqual(fo.st.log, ['engage:b', 'release:b']);
});

test('tick: on failover, another account recovering means switch to it AND release', async function () {
  const ctx = makeCtx();
  login(ctx, 'a@x.com', 'u1', 'TA');
  core.addCurrent(ctx);
  login(ctx, 'b@x.com', 'u2', 'TB');
  core.addCurrent(ctx);
  const fo = fakeFailover();
  fo.st.engaged = { engaged: true };
  const r = await autosw.tick(ctx, {
    threshold: 95,
    fetch: usageFetch({ TB: 99, TA: 20 }),
    nowMs: 1,
    cacheTtlMs: 0,
    failover: fo.api,
  });
  assert.strictEqual(r.state, 'switched');
  assert.strictEqual(r.switchedTo.name, 'a');
  assert.strictEqual(r.failoverReleased, true);
  assert.deepStrictEqual(fo.st.log, ['release:a']);
});

test('tick: no failover configured keeps the old answer (no-candidate)', async function () {
  const ctx = makeCtx();
  login(ctx, 'a@x.com', 'u1', 'TA');
  core.addCurrent(ctx);
  login(ctx, 'b@x.com', 'u2', 'TB');
  core.addCurrent(ctx);
  const r = await autosw.tick(ctx, { threshold: 95, fetch: usageFetch({ TB: 99, TA: 97 }), nowMs: 1, cacheTtlMs: 0 });
  assert.strictEqual(r.state, 'no-candidate');
});

test('tick: a failover that cannot engage says why and stays no-candidate', async function () {
  const ctx = makeCtx();
  login(ctx, 'a@x.com', 'u1', 'TA');
  core.addCurrent(ctx);
  login(ctx, 'b@x.com', 'u2', 'TB');
  core.addCurrent(ctx);
  const api = {
    state: () => null,
    engage: async () => ({ ok: false, reason: 'gateway unreachable at http://127.0.0.1:8787' }),
    release: async () => ({ ok: true }),
  };
  const r = await autosw.tick(ctx, {
    threshold: 95,
    fetch: usageFetch({ TB: 99, TA: 97 }),
    nowMs: 1,
    cacheTtlMs: 0,
    failover: api,
  });
  assert.strictEqual(r.state, 'no-candidate');
  assert.ok(/unreachable/.test(r.failoverError));
});

// ---- review fixes: never pay on a guess, never stay on a dead gateway, always find the way back ----
function usageFetchBy(byTok) {
  // byTok[tok] = number (utilization) | 429 | 401
  return async (url, opts) => {
    const tok = opts.headers.Authorization.replace('Bearer ', '');
    const v = byTok[tok];
    if (v === 429 || v === 401 || v === undefined)
      return {
        ok: false,
        status: v === undefined ? 401 : v,
        headers: { get: (h) => (h === 'retry-after' ? '120' : null) },
      };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ five_hour: { utilization: v, resets_at: '2027-01-15T08:00:00Z' } }),
    };
  };
}
function twoAccounts() {
  const ctx = makeCtx();
  login(ctx, 'a@x.com', 'u1', 'TA');
  core.addCurrent(ctx);
  login(ctx, 'b@x.com', 'u2', 'TB');
  core.addCurrent(ctx);
  return ctx; // b is live
}

test('REGRESSION: an account whose usage is UNKNOWN (429) is not "exhausted" — no paid failover', async function () {
  const ctx = twoAccounts();
  const fo = fakeFailover();
  const r = await autosw.tick(ctx, {
    threshold: 95,
    fetch: usageFetchBy({ TB: 99, TA: 429 }),
    nowMs: Date.parse('2027-01-15T06:00:00Z'),
    cacheTtlMs: 0,
    failover: fo.api,
  });
  assert.strictEqual(r.state, 'no-candidate');
  assert.deepStrictEqual(r.unknownCandidates, ['a']);
  assert.ok(/not engaging the paid failover/.test(r.failoverDeferred));
  assert.deepStrictEqual(fo.st.log, [], 'engage was never called');
  // once a's reading says it is out too, the failover engages — and knows when b's window resets
  let info = null;
  fo.api.engage = async (i) => {
    info = i;
    fo.st.log.push('engage:' + i.from);
    fo.st.engaged = { engaged: true, recoverAt: i.recoverAt };
    return { ok: true, state: fo.st.engaged };
  };
  const r2 = await autosw.tick(ctx, {
    threshold: 95,
    fetch: usageFetchBy({ TB: 99, TA: 98 }),
    nowMs: Date.parse('2027-01-15T07:00:00Z'),
    cacheTtlMs: 0,
    failover: fo.api,
  });
  assert.strictEqual(r2.state, 'failover-engaged');
  assert.strictEqual(info.recoverAt, '2027-01-15T08:00:00.000Z');
});

test('REGRESSION: a gateway that dies while engaged is left (after one re-check), loudly', async function () {
  const ctx = twoAccounts();
  const fo = fakeFailover();
  fo.st.engaged = { engaged: true };
  let checks = 0;
  fo.api.check = async () => {
    checks++;
    return { ok: false, reason: 'gateway unreachable at http://127.0.0.1:8787' };
  };
  let released = null;
  fo.api.release = async (i) => {
    released = i;
    fo.st.engaged = null;
    return { ok: true };
  };
  const r = await autosw.tick(ctx, {
    threshold: 95,
    fetch: usageFetchBy({ TB: 99, TA: 99 }),
    nowMs: 1,
    cacheTtlMs: 0,
    failover: fo.api,
    sleep: async () => {},
  });
  assert.strictEqual(r.state, 'failover-lost');
  assert.strictEqual(checks, 2, 'one re-check before giving up (a gateway restart takes seconds)');
  assert.strictEqual(released.lost, true);
  assert.ok(/stopped answering/.test(released.reason));
  // a healthy gateway is left alone
  fo.st.engaged = { engaged: true };
  fo.api.check = async () => ({ ok: true });
  const r2 = await autosw.tick(ctx, {
    threshold: 95,
    fetch: usageFetchBy({ TB: 99, TA: 99 }),
    nowMs: 2,
    cacheTtlMs: 0,
    failover: fo.api,
    sleep: async () => {},
  });
  assert.strictEqual(r2.state, 'failover');
});

test('REGRESSION: on the failover with the live token rejected (401), a recovered account still ends it', async function () {
  const ctx = twoAccounts();
  const fo = fakeFailover();
  fo.st.engaged = { engaged: true };
  const r = await autosw.tick(ctx, {
    threshold: 95,
    fetch: usageFetchBy({ TB: 401, TA: 10 }),
    nowMs: 1,
    cacheTtlMs: 0,
    failover: fo.api,
  });
  assert.strictEqual(r.state, 'switched');
  assert.strictEqual(r.switchedTo.name, 'a');
  assert.deepStrictEqual(fo.st.log, ['release:a']);
});

test("REGRESSION: on the failover with the usage unreadable, the binding window's reset ends it", async function () {
  const ctx = twoAccounts();
  const fo = fakeFailover();
  fo.st.engaged = { engaged: true, recoverAt: '2027-01-15T08:00:00.000Z' };
  // b's own token aged out (nothing renews it while Claude Code is on the gateway); a still out
  ctx.store.setLive(
    JSON.stringify({ claudeAiOauth: { accessToken: 'TB', expiresAt: Date.parse('2027-01-15T05:00:00Z') } }),
  );
  const before = await autosw.tick(ctx, {
    threshold: 95,
    fetch: usageFetchBy({ TB: 401, TA: 99 }),
    nowMs: Date.parse('2027-01-15T07:59:00Z'),
    cacheTtlMs: 0,
    failover: fo.api,
  });
  assert.strictEqual(before.state, 'failover', 'not before the reset');
  const after = await autosw.tick(ctx, {
    threshold: 95,
    fetch: usageFetchBy({ TB: 401, TA: 99 }),
    nowMs: Date.parse('2027-01-15T08:00:01Z'),
    cacheTtlMs: 0,
    failover: fo.api,
  });
  assert.strictEqual(after.state, 'failback');
  assert.strictEqual(after.basis, 'window-reset');
  assert.deepStrictEqual(fo.st.log, ['release:b']);
});

test('a live login the server REJECTS (not merely aged) is left for an account with headroom', async function () {
  const ctx = twoAccounts();
  // not aged: no expiresAt in the past -> 401 means the login itself is dead
  const r = await autosw.tick(ctx, {
    threshold: 95,
    fetch: usageFetchBy({ TB: 401, TA: 20 }),
    nowMs: 1,
    cacheTtlMs: 0,
  });
  assert.strictEqual(r.state, 'switched');
  assert.strictEqual(r.switchedTo.name, 'a');
  // an access token past its expiry is Claude Code's to renew: wait, do not switch
  const ctx2 = twoAccounts();
  ctx2.store.setLive(JSON.stringify({ claudeAiOauth: { accessToken: 'TB', expiresAt: 1000 } }));
  const r2 = await autosw.tick(ctx2, {
    threshold: 95,
    fetch: usageFetchBy({ TB: 401, TA: 20 }),
    nowMs: 5000,
    cacheTtlMs: 0,
  });
  assert.strictEqual(r2.state, 'unknown');
});

test('REGRESSION: MCP keyflip_autoswitch_tick clamps the threshold like the CLI (0 is not "everyone is out")', async function () {
  const ctx = twoAccounts();
  ctx.fetch = usageFetchBy({ TB: 5, TA: 5 });
  const mcp = await import('../src/mcp.js');
  const t = mcp.TOOLS.find((x) => x.name === 'keyflip_autoswitch_tick');
  const r = await t.run(ctx, { threshold: 0, confirm: true });
  assert.strictEqual(r.state, 'below');
});

// ---- the CLI surface (sandbox HOME; keysmith is not installed there, nothing is reachable) ----
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'keyflip.js');
function cli(home, args, ksConfig) {
  return spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      KEYFLIP_CONFIG_DIR: path.join(home, '.config', 'keyflip'),
      KEYSMITH_DIR: path.join(home, 'no-keysmith'),
      KEYSMITH_CONFIG: ksConfig || path.join(home, 'no-keysmith', 'config.json'),
      KEYFLIP_TEST_CLAUDE: 'stopped',
      KEYFLIP_APP_BUNDLE: path.join(home, 'no-such-Claude.app'),
      PATH: path.dirname(process.execPath) + ':/usr/bin:/bin',
    }),
  });
}
test('CLI `failover status` and `failover setup --dry-run` (nothing set up, nothing touched)', function () {
  const home = makeCtx().home;
  const st = cli(home, ['failover', 'status', '--json']);
  assert.strictEqual(st.status, 0, st.stderr);
  const j = JSON.parse(st.stdout).failover;
  assert.strictEqual(j.engaged, false);
  assert.strictEqual(j.gateway.ok, false);
  assert.ok(/not set up/.test(j.gateway.reason));
  assert.strictEqual(j.plan.alias, 'claude-failover');
  assert.ok(
    /could not read the keysmith config/.test(j.plan.aliasError),
    'no keysmith: the legs are unknown, not invented',
  );
  // No keysmith config: setup stops at the alias, which it never creates.
  const blind = cli(home, ['failover', 'setup', '--dry-run', '--json']);
  assert.strictEqual(blind.status, 1);
  assert.deepStrictEqual(
    JSON.parse(blind.stdout).failoverSetup.steps.map((s) => s.step),
    ['alias'],
  );
  // With keysmith's alias and cap in place, the dry run walks every step and touches nothing.
  const ksc = keysmithConfig({ home: home });
  const before = fs.readFileSync(ksc, 'utf8');
  const dry = cli(home, ['failover', 'setup', '--dry-run', '--json'], ksc);
  assert.strictEqual(dry.status, 0, dry.stderr);
  const d = JSON.parse(dry.stdout).failoverSetup;
  assert.deepStrictEqual(
    d.steps.map((s) => s.step),
    ['alias', 'spend-cap', 'key', 'provider'],
  );
  assert.strictEqual(d.restartGateway, false);
  assert.strictEqual(fs.readFileSync(ksc, 'utf8'), before);
  assert.ok(!fs.existsSync(path.join(home, '.config', 'keyflip', 'providers', 'keysmith-failover.json')));
  const human = cli(home, ['failover', 'status'], ksc).stdout;
  assert.ok(/chain:\s+claude-failover = claude-failover-api\/claude-opus-5-5 → kiro-emu/.test(human), human);
});
