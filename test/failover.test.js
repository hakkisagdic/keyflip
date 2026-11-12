// P4: API failover through keysmith — alias chain gmail API -> agy -> kiro-emu, a 25 USD monthly
// cap on the gmail promo key. keysmith is never run: a fake runner stands in for its CLI, a temp
// file for its config, a fake fetch for its gateway. No real key, keychain, settings or app.
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

function keysmithConfig(ctx) {
  const p = path.join(ctx.home, 'keysmith', 'config.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify(
      {
        host: '127.0.0.1',
        port: 8787,
        auth: { keys: ['ks_EXISTING'] },
        adapters: {
          'claude-api': {
            kind: 'http',
            apiKey: '{exec:/usr/bin/security find-generic-password -s keyflip:provider__gmail-api -w}',
          },
        },
        limits: { spend: { other: 5 } },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return p;
}
// Plays keysmith's CLI: records argv; `key add … --out F` writes a key into F like the real one.
function fakeKeysmith(state) {
  return function (cmd, args) {
    (state.calls = state.calls || []).push([cmd].concat(args || []));
    if (cmd === 'which') return { code: 1, stdout: '' };
    const sub = args.slice(1);
    if (sub[0] === 'key' && sub[1] === 'add') {
      const out = sub[sub.indexOf('--out') + 1];
      fs.writeFileSync(out, GATEWAY_KEY + '\n', { mode: 0o600 });
      return { code: 0, stdout: 'added (written to file)' };
    }
    return {
      code: state.aliasFails && sub[0] === 'alias' ? 1 : 0,
      stdout: '',
      stderr: state.aliasFails ? 'unknown adapter' : '',
    };
  };
}

test('the plan: alias chain gmail API -> agy -> kiro-emu, $25 on the first (paid) leg', function () {
  const p = failover.plan(makeCtx());
  assert.deepStrictEqual(p.legs, [
    'claude-api/claude-opus-5-5',
    'agy/claude-opus-5-5-medium',
    'kiro-emu/claude-opus-5.5',
  ]);
  assert.strictEqual(p.capUsd, 25);
  assert.strictEqual(p.capAdapter, 'claude-api');
  assert.strictEqual(p.gatewayUrl, 'http://127.0.0.1:8787');
  assert.strictEqual(p.alias, 'keyflip-failover');
});

test('setup: alias, spend cap (adapter + account), scoped key into the store, provider profile', async function () {
  const ctx = makeCtx();
  const cfgPath = keysmithConfig(ctx);
  const state = {};
  const r = await failover.setup(ctx, {
    run: fakeKeysmith(state),
    keysmithConfig: cfgPath,
    keysmithDir: '/opt/keysmith',
    accountOf: () => 'keyflip:provider__gmail-api',
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r.steps));
  const alias = state.calls.find((c) => c[2] === 'alias');
  assert.deepStrictEqual(alias, [
    process.execPath,
    '/opt/keysmith/src/cli.js',
    'alias',
    'keyflip-failover',
    'claude-api/claude-opus-5-5',
    'agy/claude-opus-5-5-medium',
    'kiro-emu/claude-opus-5.5',
  ]);
  const keyAdd = state.calls.find((c) => c[2] === 'key');
  const allow = keyAdd[keyAdd.indexOf('--allow') + 1].split(',');
  assert.deepStrictEqual(allow, [
    'alias:keyflip-failover',
    'claude-api/claude-opus-5-5',
    'agy/claude-opus-5-5-medium',
    'kiro-emu/claude-opus-5.5',
  ]);
  assert.ok(keyAdd.indexOf('--out') !== -1, 'the key comes back through a file, never stdout');
  assert.strictEqual(ctx.store.getProfile('provider__keysmith-failover'), GATEWAY_KEY);
  assert.ok(JSON.stringify(r).indexOf(GATEWAY_KEY) === -1, 'the key is in no result');
  const ks = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.strictEqual(ks.limits.spend['adapter:claude-api'], 25);
  assert.strictEqual(ks.limits.spend['account:keyflip:provider__gmail-api'], 25);
  assert.strictEqual(ks.limits.spend.other, 5, 'existing caps kept');
  assert.deepStrictEqual(ks.auth.keys, ['ks_EXISTING'], 'the rest of the config untouched');
  assert.strictEqual(fs.statSync(cfgPath).mode & 0o777, 0o600, 'mode kept');
  const meta = provider.read(ctx, 'keysmith-failover');
  assert.strictEqual(meta.baseUrl, 'http://127.0.0.1:8787');
  assert.strictEqual(meta.models.default, 'keyflip-failover');
  assert.strictEqual(meta.models.smallFast, 'keyflip-failover', 'background models go through the alias too');
  assert.strictEqual(r.restartGateway, true);
});

test('setup is idempotent: no second key, cap unchanged', async function () {
  const ctx = makeCtx();
  const cfgPath = keysmithConfig(ctx);
  const s1 = {};
  await failover.setup(ctx, { run: fakeKeysmith(s1), keysmithConfig: cfgPath, accountOf: () => null });
  const s2 = {};
  const r = await failover.setup(ctx, { run: fakeKeysmith(s2), keysmithConfig: cfgPath, accountOf: () => null });
  assert.ok(!s2.calls.some((c) => c.indexOf('key') !== -1 && c.indexOf('add') !== -1), 'no second key minted');
  assert.strictEqual(r.steps.find((s) => s.step === 'spend-cap').changed, false);
});

test('setup --dry-run writes nothing and runs nothing but `which`', async function () {
  const ctx = makeCtx();
  const cfgPath = keysmithConfig(ctx);
  const before = fs.readFileSync(cfgPath, 'utf8');
  const state = {};
  const r = await failover.setup(ctx, {
    run: fakeKeysmith(state),
    keysmithConfig: cfgPath,
    dryRun: true,
    accountOf: () => null,
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(
    state.calls.map((c) => c[0]),
    ['which'],
  );
  assert.strictEqual(fs.readFileSync(cfgPath, 'utf8'), before);
  assert.strictEqual(provider.exists(ctx, 'keysmith-failover'), false);
});

test('a failing keysmith step is reported, not hidden', async function () {
  const ctx = makeCtx();
  const r = await failover.setup(ctx, {
    run: fakeKeysmith({ aliasFails: true }),
    keysmithConfig: keysmithConfig(ctx),
    accountOf: () => null,
  });
  assert.strictEqual(r.ok, false);
  assert.ok(/unknown adapter/.test(r.steps.find((s) => s.step === 'alias').detail));
});

function gateway(models, status) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url: url, auth: opts.headers.Authorization });
    if (status) return { ok: false, status: status };
    return { ok: true, status: 200, json: async () => ({ data: models.map((id) => ({ id: id })) }) };
  };
  f.calls = calls;
  return f;
}
async function setUp(ctx) {
  await failover.setup(ctx, { run: fakeKeysmith({}), keysmithConfig: keysmithConfig(ctx), accountOf: () => null });
}

test('gatewayReady: up + serving the alias; not set up; alias missing; unreachable', async function () {
  const ctx = makeCtx();
  assert.ok(/not set up/.test((await failover.gatewayReady(ctx, { fetch: gateway(['keyflip-failover']) })).reason));
  await setUp(ctx);
  const f = gateway(['keyflip-failover', 'chat']);
  assert.strictEqual((await failover.gatewayReady(ctx, { fetch: f })).ok, true);
  assert.strictEqual(f.calls[0].url, 'http://127.0.0.1:8787/v1/models');
  assert.strictEqual(f.calls[0].auth, 'Bearer ' + GATEWAY_KEY);
  assert.ok(/restart keysmith/.test((await failover.gatewayReady(ctx, { fetch: gateway(['chat']) })).reason));
  const down = async () => {
    throw new Error('ECONNREFUSED');
  };
  assert.ok(/unreachable/.test((await failover.gatewayReady(ctx, { fetch: down })).reason));
});

test('engage points Claude Code at the gateway, asks Desktop to follow, records it; release undoes it', async function () {
  const ctx = makeCtx();
  await setUp(ctx);
  const log = [];
  const deps = {
    fetch: gateway(['keyflip-failover']),
    useProvider: (n) => log.push('use:' + n),
    useOfficial: () => log.push('official'),
    requestDesktop: (rec) => log.push('desktop:' + rec.kind),
    notify: async (ev, msg) => log.push('notify:' + ev + ':' + msg),
  };
  const e = await failover.engage(ctx, { from: 'gmail' }, deps);
  assert.strictEqual(e.ok, true);
  assert.ok(failover.state(ctx).engaged);
  assert.deepStrictEqual(log.slice(0, 2), ['use:keysmith-failover', 'desktop:gateway-on']);
  assert.ok(/capped at \$25/.test(log[2]));
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
  await setUp(ctx);
  const log = [];
  const r = await failover.engage(
    ctx,
    {},
    { fetch: gateway([], 502), useProvider: () => log.push('use'), requestDesktop: () => log.push('d') },
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

// ---- the CLI surface (sandbox HOME; keysmith is not installed there, nothing is reachable) ----
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'keyflip.js');
function cli(home, args) {
  return spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      KEYFLIP_CONFIG_DIR: path.join(home, '.config', 'keyflip'),
      KEYSMITH_DIR: path.join(home, 'no-keysmith'),
      KEYSMITH_CONFIG: path.join(home, 'no-keysmith', 'config.json'),
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
  const dry = cli(home, ['failover', 'setup', '--dry-run', '--json']);
  assert.strictEqual(dry.status, 0, dry.stderr);
  const d = JSON.parse(dry.stdout).failoverSetup;
  assert.deepStrictEqual(
    d.steps.map((s) => s.step),
    ['alias', 'spend-cap', 'key', 'provider'],
  );
  assert.ok(!fs.existsSync(path.join(home, '.config', 'keyflip', 'providers', 'keysmith-failover.json')));
});
