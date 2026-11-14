// Slice 1 tests: failover transaction core (T1-T10, T15-T20, T30).
// Every test is hermetic: makeCtx() temp dirs, MemoryStore / fake KeychainStore,
// and injected fakes for fetch, spawn, listProcesses, lsof, notify, and clock.
import test from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { makeCtx, writeClaude, assertPrivateMode } from './helpers.js';
import * as config from '../src/config.js';
import * as provider from '../src/provider.js';
import * as failover from '../src/failover.js';
import * as fosurface from '../src/fosurface.js';
import * as desktopgw from '../src/desktopgw.js';
import * as dr from '../src/desktoprestart.js';
import * as autosw from '../src/autoswitch.js';
import * as core from '../src/core.js';
import * as history from '../src/history.js';
import * as logmod from '../src/log.js';
import * as notify from '../src/notify.js';
import * as redactMod from '../src/redact.js';
import { HybridStore, KeychainStore, FileStore } from '../src/stores/index.js';
import { main as cliMain } from '../src/cli.js';

const FAKE_GW_KEY = 'ks_FAKE_GATEWAY_KEY_FOR_TESTS';
const FAKE_API_KEY = 'sk-ant-FAKE-API03-9999999999999999';
const FAKE_OAUTH_TOK = 'sk-ant-FAKE-OAT01-8888888888888888';
const FAKE_SESSION_KEY = 'sessionKey-FAKE-COOKIE-7777777777';
const FAKE_CUSTOM_SECRET = 'custom_store_secret_FAKE_654321';

function writeKeysmithCfg(ctx) {
  const p = path.join(ctx.home, 'keysmith-config.json');
  fs.writeFileSync(
    p,
    JSON.stringify({
      aliases: {
        'claude-failover': ['claude-failover-api/claude-opus-5-5', 'agy/claude-sonnet-5-5-low'],
      },
      limits: {
        spend: {
          'claude-failover-api': { usd: 25, since: '2026-11-12', until: '2026-12-09' },
        },
      },
    }),
  );
  return p;
}

function setupGateway(ctx, opts) {
  opts = opts || {};
  const ksPath = writeKeysmithCfg(ctx);
  const key = opts.key || FAKE_GW_KEY;
  ctx.store.setProfile('provider__keysmith-failover', key);
  provider.add(ctx, 'keysmith-failover', {
    baseUrl: 'http://127.0.0.1:8787',
    authScheme: 'bearer',
    compat: 'anthropic',
    models: {
      default: 'claude-failover',
      smallFast: 'claude-failover',
      haiku: 'claude-failover',
      sonnet: 'claude-failover',
      opus: 'claude-failover',
    },
  });
  const models = opts.models || ['claude-failover'];
  const gwFetch = async function (url) {
    if (/\/v1\/keysmith\/usage/.test(url)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          spend: [
            {
              kind: 'adapter',
              target: 'claude-failover-api',
              cap: 25,
              spent: 7.34,
              exceeded: false,
              window: { since: '2026-11-12', until: '2026-12-09' },
              windowStatus: 'open',
            },
          ],
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: models.map((id) => ({ id })),
      }),
    };
  };
  return { ksPath, gwFetch };
}

function makeFakeSpawn(handler) {
  const calls = [];
  const spawnFn = function (cmd, args, opts) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killedSignals = [];
    child.kill = function (sig) {
      child.killedSignals.push(sig || 'SIGTERM');
    };
    const rec = {
      cmd,
      args: args.slice(),
      cwd: opts && opts.cwd,
      env: Object.assign({}, (opts && opts.env) || {}),
      child,
    };
    calls.push(rec);
    handler(rec, calls.length - 1);
    return child;
  };
  return { spawn: spawnFn, calls };
}

function okSpawnRecorder(costPerCall) {
  const cost = costPerCall !== undefined ? costPerCall : 0.005;
  return makeFakeSpawn(function (rec) {
    setImmediate(function () {
      rec.child.stdout.emit(
        'data',
        JSON.stringify({ type: 'result', is_error: false, result: 'OK', total_cost_usd: cost }),
      );
      rec.child.emit('close', 0);
    });
  });
}

function loginAccount(ctx, email, uid, tok) {
  writeClaude(ctx, { oauthAccount: { emailAddress: email }, userID: uid });
  ctx.store.setLive(JSON.stringify({ claudeAiOauth: { accessToken: tok } }));
}

function walkFiles(dir, acc) {
  acc = acc || [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  entries.forEach(function (ent) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, acc);
    else if (ent.isFile()) acc.push(p);
  });
  return acc;
}

test('T1: engage cli-launcher: probe passes -> .failover-env.json written, settings.json untouched, state kept', async function () {
  const ctx = makeCtx();
  const { ksPath, gwFetch } = setupGateway(ctx);
  fs.mkdirSync(path.dirname(ctx.claudeSettingsPath), { recursive: true });
  const originalSettings = '{\n  "theme": "dark",\n  "env": {\n    "USER_CUSTOM": "keep"\n  }\n}\n';
  fs.writeFileSync(ctx.claudeSettingsPath, originalSettings, 'utf8');

  const sp = okSpawnRecorder(0.005);
  const res = await failover.engage(
    ctx,
    { from: 'gmail', reason: 'every Claude account is over the threshold' },
    { fetch: gwFetch, keysmithConfig: ksPath, spawn: sp.spawn, nowMs: 1700000000000 },
  );

  assert.strictEqual(res.ok, true, res.reason);
  assert.strictEqual(res.surface, 'cli-launcher');
  assert.strictEqual(fs.readFileSync(ctx.claudeSettingsPath, 'utf8'), originalSettings, 'settings.json untouched');

  const envFile = fosurface.envPath(ctx);
  assert.ok(fs.existsSync(envFile), '.failover-env.json written');
  assertPrivateMode(envFile, '.failover-env.json');
  const envRaw = fs.readFileSync(envFile, 'utf8');
  assert.strictEqual(envRaw.indexOf(FAKE_GW_KEY), -1, 'no token written to disk');
  const envJson = JSON.parse(envRaw);
  assert.strictEqual(envJson.baseUrl, 'http://127.0.0.1:8787');
  assert.strictEqual(envJson.provider, 'keysmith-failover');
  assert.strictEqual(envJson.tokenRef, 'provider__keysmith-failover');
  assert.strictEqual(envJson.modelEnv.ANTHROPIC_MODEL, 'claude-failover');

  const txnFile = fosurface.txnPath(ctx);
  assertPrivateMode(txnFile, '.failover-txn.json');
  const txn = fosurface.readTxn(ctx);
  assert.strictEqual(txn.phase, 'kept');
  assert.strictEqual(txn.surface, 'cli-launcher');
  assert.deepStrictEqual(txn.probe.models, ['default', 'sonnet']);
  assert.strictEqual(txn.probe.ok, true);
  assert.strictEqual(txn.probe.costUsd, 0.01);

  const st = failover.state(ctx);
  assert.ok(st && st.engaged);
  assert.strictEqual(st.surface, 'cli-launcher');
  assert.deepStrictEqual(st.txn.models, ['default', 'sonnet']);
});

test('T2: engage probe fails (model_not_found) -> everything rolled back, settings.json byte-identical, notify once, history failover-engage-failed', async function () {
  const ctx = makeCtx();
  const allModelIds = ['claude-failover', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
  const { ksPath, gwFetch } = setupGateway(ctx, { models: allModelIds });
  config.set(ctx, 'failover.cliTarget', 'settings');

  fs.mkdirSync(path.dirname(ctx.claudeSettingsPath), { recursive: true });
  // Deliberately non-standard key order & spacing to prove byte-for-byte rollback.
  const originalBytes = '{\n  "z_custom": 42,\n  "a_env": { "FOO": "bar" }\n}';
  fs.writeFileSync(ctx.claudeSettingsPath, originalBytes, 'utf8');

  let sawModifiedSettingsDuringProbe = false;
  const sp = makeFakeSpawn(function (rec) {
    const duringBytes = fs.readFileSync(ctx.claudeSettingsPath, 'utf8');
    if (duringBytes !== originalBytes) sawModifiedSettingsDuringProbe = true;
    setImmediate(function () {
      rec.child.stderr.emit('data', 'API Error: 404 {"error":{"type":"not_found_error","message":"model_not_found"}}');
      rec.child.emit('close', 1);
    });
  });

  const notes = [];
  const res = await failover.engage(
    ctx,
    { from: 'gmail' },
    {
      fetch: gwFetch,
      keysmithConfig: ksPath,
      spawn: sp.spawn,
      notify: async (ev, msg) => notes.push({ ev, msg }),
      nowMs: 1700000001000,
    },
  );

  assert.strictEqual(sawModifiedSettingsDuringProbe, true, 'cli-settings wrote settings.json before probing');
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /model-not-found/);
  assert.strictEqual(
    fs.readFileSync(ctx.claudeSettingsPath, 'utf8'),
    originalBytes,
    'settings.json restored byte-identical',
  );
  assert.strictEqual(fs.existsSync(fosurface.envPath(ctx)), false, '.failover-env.json rolled back');
  assert.strictEqual(fs.existsSync(provider.activePath(ctx)), false, 'providers/.active.json rolled back');
  assert.strictEqual(failover.state(ctx), null, '.failover-state.json not written');
  assert.strictEqual(fosurface.readTxn(ctx).phase, 'rolled-back');

  assert.strictEqual(notes.length, 1, 'notify called exactly once');
  assert.match(notes[0].msg, /^API failover could not be switched on: model-not-found/);

  const failedEvents = history.readEvents(ctx).filter((e) => e.kind === 'failover-engage-failed');
  assert.ok(failedEvents.length >= 1, 'failover-engage-failed recorded in history');
  assert.match(failedEvents[0].reason, /model-not-found/);
});

test('T3: probe timeout (fake spawn never exits) -> child killed, rollback, reason timeout', async function () {
  const ctx = makeCtx();
  const { ksPath, gwFetch } = setupGateway(ctx);

  // Never emits close/exit.
  const sp = makeFakeSpawn(function () {});
  const notes = [];
  const res = await failover.engage(
    ctx,
    { from: 'gmail' },
    {
      fetch: gwFetch,
      keysmithConfig: ksPath,
      spawn: sp.spawn,
      probeTimeoutMs: 25,
      notify: async (ev, msg) => notes.push({ ev, msg }),
      nowMs: 1700000002000,
    },
  );

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'timeout');
  assert.strictEqual(sp.calls.length, 1);
  assert.strictEqual(sp.calls[0].child.killedSignals.length, 1, 'hung probe child was killed');
  assert.strictEqual(fs.existsSync(fosurface.envPath(ctx)), false, '.failover-env.json rolled back');
  assert.strictEqual(failover.state(ctx), null);
  assert.strictEqual(fosurface.readTxn(ctx).phase, 'rolled-back');
  assert.strictEqual(fosurface.readTxn(ctx).probe.reason, 'timeout');
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(notes[0].msg, 'API failover could not be switched on: timeout');
});

test('T4: cli-settings refused when gateway lacks a modelIds entry -> falls back to launcher with reason', async function () {
  const ctx = makeCtx();
  // Serves opus + sonnet, but lacks claude-haiku-5-5.
  const { ksPath, gwFetch } = setupGateway(ctx, {
    models: ['claude-failover', 'claude-opus-5-5', 'claude-sonnet-5-5'],
  });
  config.set(ctx, 'failover.cliTarget', 'settings');

  const sp = okSpawnRecorder();
  const res = await failover.engage(
    ctx,
    { from: 'gmail' },
    { fetch: gwFetch, keysmithConfig: ksPath, spawn: sp.spawn, nowMs: 1700000003000 },
  );

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.surface, 'cli-launcher');
  assert.match(String(res.fallbackReason), /claude-haiku-5-5/);
  assert.strictEqual(failover.state(ctx).surface, 'cli-launcher');
  assert.match(String(failover.state(ctx).fallbackReason), /claude-haiku-5-5/);
  assert.ok(fs.existsSync(fosurface.envPath(ctx)));
  assert.strictEqual(fs.existsSync(ctx.claudeSettingsPath), false, 'settings.json never written on fallback');
});

test('T5: cli-settings writes only URL + token (no ANTHROPIC_*MODEL keys) and probe env has no ANTHROPIC_*', async function () {
  const ctx = makeCtx();
  const { ksPath, gwFetch } = setupGateway(ctx, {
    models: ['claude-failover', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  });
  config.set(ctx, 'failover.cliTarget', 'settings');

  fs.mkdirSync(path.dirname(ctx.claudeSettingsPath), { recursive: true });
  fs.writeFileSync(
    ctx.claudeSettingsPath,
    JSON.stringify({
      env: {
        USER_KEEP: '1',
        ANTHROPIC_MODEL: 'stale-model',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'stale-sonnet',
      },
    }),
  );

  const sp = okSpawnRecorder();
  const res = await failover.engage(
    ctx,
    { from: 'gmail' },
    {
      fetch: gwFetch,
      keysmithConfig: ksPath,
      spawn: sp.spawn,
      env: {
        PATH: '/usr/bin:/bin',
        ANTHROPIC_MODEL: 'from-parent-env',
        ANTHROPIC_API_KEY: FAKE_API_KEY,
        ANTHROPIC_BASE_URL: 'https://parent.invalid',
      },
      nowMs: 1700000004000,
    },
  );

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.surface, 'cli-settings');

  const written = JSON.parse(fs.readFileSync(ctx.claudeSettingsPath, 'utf8'));
  assert.deepStrictEqual(Object.keys(written.env).sort(), ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'USER_KEEP']);
  Object.keys(written.env).forEach(function (k) {
    assert.strictEqual(/^ANTHROPIC_.*MODEL$/.test(k), false, 'no ANTHROPIC_*MODEL key in settings.json: ' + k);
  });

  assert.ok(sp.calls.length >= 2);
  sp.calls.forEach(function (call) {
    const anthropicKeys = Object.keys(call.env).filter((k) => /^ANTHROPIC_/.test(k));
    assert.deepStrictEqual(anthropicKeys, [], 'probe child env has zero ANTHROPIC_* keys');
    assert.strictEqual(call.cwd, ctx.home);
  });
});

test('T6: probe argv includes --model sonnet for probeModels=sonnet; failure on that probe alone rolls back', async function () {
  const ctx = makeCtx();
  const { ksPath, gwFetch } = setupGateway(ctx);
  config.set(ctx, 'failover.probeModels', 'sonnet');

  const sp = makeFakeSpawn(function (rec, idx) {
    setImmediate(function () {
      if (idx === 0) {
        // Default-model probe passes.
        rec.child.stdout.emit('data', JSON.stringify({ type: 'result', is_error: false, result: 'OK' }));
        rec.child.emit('close', 0);
      } else {
        // `--model sonnet` probe fails.
        rec.child.stderr.emit('data', '404 model_not_found: sonnet');
        rec.child.emit('close', 1);
      }
    });
  });

  const res = await failover.engage(
    ctx,
    { from: 'gmail' },
    { fetch: gwFetch, keysmithConfig: ksPath, spawn: sp.spawn, nowMs: 1700000005000 },
  );

  assert.strictEqual(sp.calls.length, 2);
  assert.strictEqual(sp.calls[0].args.includes('--model'), false, 'first probe uses default model');
  const modelFlagIdx = sp.calls[1].args.indexOf('--model');
  assert.ok(modelFlagIdx !== -1, 'second probe passes --model');
  assert.strictEqual(sp.calls[1].args[modelFlagIdx + 1], 'sonnet');

  assert.strictEqual(res.ok, false, 'failure on --model sonnet alone fails engage');
  assert.strictEqual(fs.existsSync(fosurface.envPath(ctx)), false, '.failover-env.json rolled back');
  assert.strictEqual(failover.state(ctx), null);
  assert.strictEqual(fosurface.readTxn(ctx).phase, 'rolled-back');
});

test('T7: crash simulation: .failover-txn.json in probing -> next tick rolls back first', async function () {
  const ctx = makeCtx();
  loginAccount(ctx, 'alice@example.com', 'u1', FAKE_OAUTH_TOK);
  core.addCurrent(ctx);

  fs.mkdirSync(path.dirname(ctx.claudeSettingsPath), { recursive: true });
  const cleanSettings = '{\n  "model": "opus",\n  "env": {\n    "MY_FLAG": "1"\n  }\n}\n';
  const backupDir = path.join(ctx.configDir, 'backups', 'failover', '1700000006000');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, 'settings.json');
  fs.writeFileSync(backupFile, cleanSettings, 'utf8');

  // Crashed state: settings.json has gateway env and .failover-txn.json is stuck in `probing`.
  fs.writeFileSync(
    ctx.claudeSettingsPath,
    JSON.stringify({
      model: 'opus',
      env: {
        MY_FLAG: '1',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787',
        ANTHROPIC_AUTH_TOKEN: FAKE_GW_KEY,
      },
    }),
  );
  fosurface.writeTxn(ctx, {
    v: 1,
    surface: 'cli-settings',
    phase: 'probing',
    startedAt: 1700000006000,
    wrote: [
      {
        path: ctx.claudeSettingsPath,
        kind: 'settings-env',
        keys: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'],
        backup: backupFile,
      },
    ],
    probe: null,
  });

  let sawRolledBackDuringUsageFetch = false;
  const r = await autosw.tick(ctx, {
    nowMs: 1700000007000,
    cacheTtlMs: 0,
    fetch: async () => {
      // Prove rollback happened BEFORE the tick's usage work ran.
      sawRolledBackDuringUsageFetch = fs.readFileSync(ctx.claudeSettingsPath, 'utf8') === cleanSettings;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ five_hour: { utilization: 20 } }),
      };
    },
  });

  assert.strictEqual(sawRolledBackDuringUsageFetch, true, 'crashed txn rolled back before rest of tick');
  assert.ok(r.recoveredTxn && r.recoveredTxn.rolledBack);
  assert.strictEqual(fs.readFileSync(ctx.claudeSettingsPath, 'utf8'), cleanSettings);
  assert.strictEqual(fosurface.readTxn(ctx).phase, 'rolled-back');
});

test('T8: Desktop-leak guard: fake Desktop process started after txn with ANTHROPIC_MODEL=claude-failover -> rollback to launcher + history event; values not in output', async function () {
  const ctx = makeCtx();
  logmod.init(ctx.configDir, false);
  loginAccount(ctx, 'alice@example.com', 'u1', FAKE_OAUTH_TOK);
  core.addCurrent(ctx);

  const { ksPath, gwFetch } = setupGateway(ctx, {
    models: ['claude-failover', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  });
  config.set(ctx, 'failover.cliTarget', 'settings');

  fs.mkdirSync(path.dirname(ctx.claudeSettingsPath), { recursive: true });
  const preSettings = JSON.stringify({ env: { KEEP_ME: 'yes' } }, null, 2) + '\n';
  fs.writeFileSync(ctx.claudeSettingsPath, preSettings);

  const sp = okSpawnRecorder();
  const tEngage = 1700000010000;
  const eng = await failover.engage(
    ctx,
    { from: 'alice', manual: true },
    { fetch: gwFetch, keysmithConfig: ksPath, spawn: sp.spawn, nowMs: tEngage },
  );
  assert.strictEqual(eng.ok, true);
  assert.strictEqual(eng.surface, 'cli-settings');

  // Process started BEFORE txn.startedAt must NOT trigger leak guard.
  const noLeak = await fosurface.checkDesktopLeak(ctx, {
    nowMs: tEngage + 1000,
    listProcesses: () => [
      {
        pid: 1111,
        startedAt: tEngage - 5000,
        env: {
          CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
          ANTHROPIC_MODEL: 'claude-failover',
          ANTHROPIC_AUTH_TOKEN: FAKE_GW_KEY,
        },
      },
    ],
  });
  assert.strictEqual(noLeak.leaked, false);
  assert.strictEqual(failover.state(ctx).surface, 'cli-settings');

  // Process started AFTER txn.startedAt triggers leak rollback to cli-launcher.
  const leakNotes = [];
  const tickRes = await autosw.tick(ctx, {
    nowMs: tEngage + 5000,
    cacheTtlMs: 0,
    spawn: sp.spawn,
    notify: async (ev, msg) => leakNotes.push({ ev, msg }),
    listProcesses: () => [
      {
        pid: 4242,
        startedAt: tEngage + 2000,
        env: {
          CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
          ANTHROPIC_MODEL: 'claude-failover',
          ANTHROPIC_AUTH_TOKEN: FAKE_GW_KEY,
          SECRET_EXTRA: FAKE_SESSION_KEY,
        },
      },
    ],
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ five_hour: { utilization: 99 } }),
    }),
    failover: {
      state: () => failover.state(ctx),
      check: async () => ({ ok: true }),
      engage: async () => ({ ok: true }),
      release: async () => ({ ok: true }),
    },
  });

  assert.ok(tickRes.desktopLeak && tickRes.desktopLeak.leaked);
  assert.deepStrictEqual(tickRes.desktopLeak.pids, [4242]);
  assert.strictEqual(fs.readFileSync(ctx.claudeSettingsPath, 'utf8'), preSettings, 'settings.json rolled back');
  assert.ok(fs.existsSync(fosurface.envPath(ctx)), 'switched to cli-launcher .failover-env.json');
  assert.strictEqual(failover.state(ctx).surface, 'cli-launcher');
  assert.strictEqual(leakNotes.length, 1);

  const leakEv = history.readEvents(ctx).find((e) => e.kind === 'failover-desktop-leak');
  assert.ok(leakEv, 'failover-desktop-leak recorded');
  assert.deepStrictEqual(leakEv.pids, [4242]);

  const dump = JSON.stringify({ tickRes, leakNotes, events: history.readEvents(ctx) });
  assert.strictEqual(dump.indexOf(FAKE_GW_KEY), -1, 'gateway key never appears in output');
  assert.strictEqual(dump.indexOf(FAKE_SESSION_KEY), -1, 'process env values never appear in output');
});

test('T9: engage never creates a gateway-* pending action', async function () {
  const ctx = makeCtx({ platform: 'darwin', appDataDir: true });
  const { ksPath, gwFetch } = setupGateway(ctx, {
    models: ['claude-failover', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  });
  const sp = okSpawnRecorder();

  // Default cli-launcher engage.
  const r1 = await failover.engage(
    ctx,
    { from: 'gmail' },
    { fetch: gwFetch, keysmithConfig: ksPath, spawn: sp.spawn, nowMs: 1700000020000 },
  );
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(dr.readPending(ctx), null, 'no pending Desktop action after cli-launcher engage');
  await failover.release(ctx, { reason: 'reset' });
  assert.strictEqual(dr.readPending(ctx), null, 'no pending Desktop action after release');

  // Opt-in cli-settings engage.
  config.set(ctx, 'failover.cliTarget', 'settings');
  const r2 = await failover.engage(
    ctx,
    { from: 'gmail' },
    { fetch: gwFetch, keysmithConfig: ksPath, spawn: sp.spawn, nowMs: 1700000025000 },
  );
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.surface, 'cli-settings');
  assert.strictEqual(dr.readPending(ctx), null, 'no pending Desktop action after cli-settings engage');
});

test('T10: keychain read error -> retry, no "not set up" log line, no release of an engaged failover', async function () {
  const ctx = makeCtx({ platform: 'darwin' });
  const logLines = [];
  logmod.init(ctx.configDir, false);
  const { ksPath, gwFetch } = setupGateway(ctx);
  loginAccount(ctx, 'alice@example.com', 'u1', FAKE_OAUTH_TOK);
  core.addCurrent(ctx);

  const sp = okSpawnRecorder();
  const t0 = 1700000030000;
  const eng = await failover.engage(
    ctx,
    { from: 'alice' },
    { fetch: gwFetch, keysmithConfig: ksPath, spawn: sp.spawn, nowMs: t0 },
  );
  assert.strictEqual(eng.ok, true);

  // Replace store with a HybridStore backed by a locked macOS Keychain (exit 36 -> EKEYCHAIN).
  const lockedKc = new KeychainStore({
    account: 'tester',
    runner: () => ({ code: 36, stdout: '', stderr: 'User interaction is not allowed', timedOut: false }),
  });
  const emptyFileStore = new FileStore({
    credsFilePath: path.join(ctx.home, 'empty-creds.json'),
    profileCredDir: path.join(ctx.home, 'empty-creds'),
  });
  ctx.store = new HybridStore(lockedKc, emptyFileStore);
  // Keep live CLI token readable for active account usage mock while provider key read hits locked keychain.
  lockedKc.getLive = () => JSON.stringify({ claudeAiOauth: { accessToken: FAKE_OAUTH_TOK } });

  const ready = await failover.gatewayReady(ctx, { fetch: gwFetch, keysmithConfig: ksPath });
  assert.strictEqual(ready.ok, false);
  assert.strictEqual(ready.retry, true);
  assert.strictEqual(ready.reason, 'keychain unavailable');

  let released = false;
  const sleeps = [];
  const tickRes = await autosw.tick(ctx, {
    nowMs: t0 + 600 * 1000,
    cacheTtlMs: 0,
    sleep: async (ms) => sleeps.push(ms),
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ five_hour: { utilization: 99 } }),
    }),
    failover: {
      state: () => failover.state(ctx),
      markLost: (at) => failover.markLost(ctx, at),
      clearLost: () => failover.clearLost(ctx),
      check: () => failover.gatewayReady(ctx, { fetch: gwFetch, capCheck: false }),
      engage: async () => ({ ok: false }),
      release: async () => {
        released = true;
        return { ok: true };
      },
    },
  });

  assert.strictEqual(tickRes.state, 'failover');
  assert.strictEqual(tickRes.failoverRetry, true);
  assert.strictEqual(released, false, 'engaged failover must NOT be released on keychain error');
  assert.strictEqual(failover.state(ctx).lostSince, undefined, 'lostSince must NOT be set on keychain error');
  assert.deepStrictEqual(sleeps, [], 'no gateway-dead retry sleep loop on keychain error');

  const logFile = path.join(ctx.configDir, 'logs', 'keyflip.log');
  if (fs.existsSync(logFile)) logLines.push(fs.readFileSync(logFile, 'utf8'));
  assert.strictEqual(/not set up/i.test(logLines.join('\n')), false, 'never logs "not set up" on keychain error');
});

test('T15: failover off works with failover.enabled=false while engaged', async function () {
  const ctx = makeCtx();
  const { ksPath, gwFetch } = setupGateway(ctx);
  const sp = okSpawnRecorder();
  const eng = await failover.engage(
    ctx,
    { from: 'gmail', manual: true },
    { fetch: gwFetch, keysmithConfig: ksPath, spawn: sp.spawn, nowMs: 1700000040000 },
  );
  assert.strictEqual(eng.ok, true);
  assert.ok(failover.state(ctx));

  // Disable failover in config AFTER engaging.
  config.set(ctx, 'failover.enabled', false);

  // Run CLI `keyflip failover off --json` against this isolated HOME/configDir.
  const prevHome = process.env.HOME;
  const prevCfg = process.env.KEYFLIP_CONFIG_DIR;
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.env.HOME = ctx.home;
  process.env.KEYFLIP_CONFIG_DIR = ctx.configDir;
  process.stdout.write = function (c) {
    chunks.push(String(c));
    return true;
  };
  try {
    process.exitCode = 0;
    await cliMain(['failover', 'off', '--json']);
  } finally {
    process.stdout.write = origWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCfg === undefined) delete process.env.KEYFLIP_CONFIG_DIR;
    else process.env.KEYFLIP_CONFIG_DIR = prevCfg;
  }

  assert.strictEqual(process.exitCode || 0, 0);
  const parsed = JSON.parse(chunks.join('').trim());
  assert.strictEqual(parsed.failover.ok, true);
  assert.strictEqual(failover.state(ctx), null, 'engaged state cleared');
  assert.strictEqual(fs.existsSync(fosurface.envPath(ctx)), false);
  assert.strictEqual(fs.existsSync(fosurface.txnPath(ctx)), false);
});

test('T16: off restores both Desktop config dirs from 3p to the recorded mode and removes configLibrary + .keyflip-gateway.json', async function () {
  const ctx = makeCtx({ platform: 'darwin', appDataDir: true });
  const mainDir = ctx.appDataDir;
  const dir3p = ctx.appDataDir + '-3p';

  fs.mkdirSync(path.join(mainDir, 'configLibrary'), { recursive: true });
  fs.mkdirSync(path.join(dir3p, 'configLibrary'), { recursive: true });

  const mainCfg = path.join(mainDir, 'claude_desktop_config.json');
  const cfg3p = path.join(dir3p, 'claude_desktop_config.json');
  const profMain = path.join(mainDir, 'configLibrary', desktopgw.KEYFLIP_PROFILE_ID + '.json');
  const prof3p = path.join(dir3p, 'configLibrary', 'keyflip-gateway-9999.json');
  const gwMeta = path.join(ctx.configDir, '.keyflip-gateway.json');

  fs.writeFileSync(
    mainCfg,
    JSON.stringify({
      deploymentMode: '3p',
      enterpriseConfig: { activeConfigId: desktopgw.KEYFLIP_PROFILE_ID },
      preferences: { darkMode: true },
    }),
  );
  fs.writeFileSync(
    cfg3p,
    JSON.stringify({
      deploymentMode: '3p',
      enterpriseConfig: { activeConfigId: desktopgw.KEYFLIP_PROFILE_ID },
      preferences: { sidebar: true },
    }),
  );
  fs.writeFileSync(profMain, JSON.stringify({ id: desktopgw.KEYFLIP_PROFILE_ID }));
  fs.writeFileSync(prof3p, JSON.stringify({ id: 'keyflip-gateway-9999' }));
  fs.writeFileSync(
    gwMeta,
    JSON.stringify({
      provider: 'keysmith-failover',
      profileId: desktopgw.KEYFLIP_PROFILE_ID,
      previousDeploymentMode: '1p',
      previousModes: {
        [mainDir]: '1p',
        [dir3p]: null,
      },
    }),
  );

  const rel = await failover.release(ctx, { by: 'cli', reason: 'turned off by hand' });
  assert.strictEqual(rel.ok, true);

  const afterMain = JSON.parse(fs.readFileSync(mainCfg, 'utf8'));
  const after3p = JSON.parse(fs.readFileSync(cfg3p, 'utf8'));
  assert.strictEqual(afterMain.deploymentMode, '1p', 'main dir restored to recorded mode 1p');
  assert.strictEqual(afterMain.enterpriseConfig, undefined);
  assert.deepStrictEqual(afterMain.preferences, { darkMode: true });

  assert.strictEqual('deploymentMode' in after3p, false, 'dir with null recorded mode deletes deploymentMode key');
  assert.strictEqual(after3p.enterpriseConfig, undefined);
  assert.deepStrictEqual(after3p.preferences, { sidebar: true });

  assert.strictEqual(fs.existsSync(profMain), false, 'main configLibrary profile deleted');
  assert.strictEqual(fs.existsSync(prof3p), false, '3p configLibrary profile deleted');
  assert.strictEqual(fs.existsSync(gwMeta), false, '.keyflip-gateway.json deleted');
});

test('T17: off reports stillCarrying for fake processes (names only), not values', async function () {
  const ctx = makeCtx();
  const { ksPath, gwFetch } = setupGateway(ctx);
  const sp = okSpawnRecorder();
  await failover.engage(
    ctx,
    { from: 'gmail', manual: true },
    { fetch: gwFetch, keysmithConfig: ksPath, spawn: sp.spawn, nowMs: 1700000050000 },
  );

  const rel = await failover.release(
    ctx,
    { by: 'cli', reason: 'turned off by hand' },
    {
      lsof: (pid) => (pid === 7001 ? '/Users/tester/proj-a' : '/Users/tester/proj-b'),
      listProcesses: () => [
        {
          pid: 7001,
          startedAt: 1700000051000,
          command: '/Applications/Claude.app/Contents/Resources/claude-code/claude',
          env: {
            CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
            ANTHROPIC_MODEL: 'claude-failover',
            ANTHROPIC_AUTH_TOKEN: FAKE_GW_KEY,
          },
        },
        {
          pid: 7002,
          startedAt: 1700000052000,
          command: '/usr/local/bin/claude -p hi',
          env: {
            CLAUDE_CODE_ENTRYPOINT: 'cli',
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787',
          },
        },
        {
          pid: 7003,
          startedAt: 1700000053000,
          command: '/usr/bin/zsh',
          env: {
            HOME: '/Users/tester',
          },
        },
      ],
    },
  );

  assert.strictEqual(rel.ok, true);
  assert.strictEqual(rel.stillCarrying.length, 2);
  assert.deepStrictEqual(rel.stillCarrying[0], {
    pid: 7001,
    kind: 'desktop session',
    startedAt: new Date(1700000051000).toISOString(),
    cwd: '/Users/tester/proj-a',
    vars: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL'],
  });
  assert.deepStrictEqual(rel.stillCarrying[1], {
    pid: 7002,
    kind: 'cli',
    startedAt: new Date(1700000052000).toISOString(),
    cwd: '/Users/tester/proj-b',
    vars: ['ANTHROPIC_BASE_URL'],
  });

  const formatted = fosurface.formatProcessReport(rel.stillCarrying).join('\n');
  assert.match(formatted, /restart this session\/app to drop the old env/);
  const serialized = JSON.stringify(rel) + '\n' + formatted;
  assert.strictEqual(serialized.indexOf(FAKE_GW_KEY), -1, 'gateway key value never reported');
  assert.strictEqual(serialized.indexOf('http://127.0.0.1:8787'), -1, 'gateway URL value never reported');
  assert.strictEqual(serialized.indexOf('claude-failover'), -1, 'alias value never reported');
});

test(
  'T18: one-step failure (settings.json read-only) still runs the other steps and reports the failure',
  { skip: process.platform === 'win32' || (typeof process.geteuid === 'function' && process.geteuid() === 0) },
  async function () {
    const ctx = makeCtx({ platform: 'darwin', appDataDir: true });
    const { ksPath, gwFetch } = setupGateway(ctx, {
      models: ['claude-failover', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    });
    config.set(ctx, 'failover.cliTarget', 'settings');

    const sp = okSpawnRecorder();
    const eng = await failover.engage(
      ctx,
      { from: 'gmail', manual: true },
      { fetch: gwFetch, keysmithConfig: ksPath, spawn: sp.spawn, nowMs: 1700000060000 },
    );
    assert.strictEqual(eng.ok, true);

    // Also stage a launcher env file and Desktop 3p leftovers so Steps 2 & 3 have real work.
    fs.writeFileSync(fosurface.envPath(ctx), JSON.stringify({ baseUrl: 'http://127.0.0.1:8787' }), { mode: 0o600 });
    fs.mkdirSync(ctx.appDataDir, { recursive: true });
    const deskCfg = path.join(ctx.appDataDir, 'claude_desktop_config.json');
    fs.writeFileSync(deskCfg, JSON.stringify({ deploymentMode: '3p' }));
    fs.writeFileSync(path.join(ctx.configDir, '.keyflip-gateway.json'), JSON.stringify({ provider: 'keysmith-failover' }));

    fs.chmodSync(ctx.claudeSettingsPath, 0o444);
    let rel;
    try {
      rel = await failover.release(ctx, { by: 'cli', reason: 'turned off by hand' });
    } finally {
      fs.chmodSync(ctx.claudeSettingsPath, 0o600);
    }

    assert.strictEqual(rel.ok, false, 'reports overall step failure');
    assert.strictEqual(rel.failed.length, 1);
    assert.strictEqual(rel.failed[0].step, 'settings.json');
    assert.match(rel.failed[0].error, /EACCES|permission denied/i);

    // Every other step still ran and cleaned its target!
    assert.strictEqual(fs.existsSync(fosurface.envPath(ctx)), false, '.failover-env.json still cleaned');
    assert.strictEqual(fs.existsSync(fosurface.txnPath(ctx)), false, '.failover-txn.json still cleaned');
    assert.strictEqual(fs.existsSync(path.join(ctx.configDir, failover.STATE_FILE)), false, '.failover-state.json still cleaned');
    assert.strictEqual(fs.existsSync(path.join(ctx.configDir, '.keyflip-gateway.json')), false, '.keyflip-gateway.json still cleaned');
    assert.strictEqual('deploymentMode' in JSON.parse(fs.readFileSync(deskCfg, 'utf8')), false, 'Desktop 3p still cleaned');
    assert.ok(rel.cleaned.includes('.failover-state.json'));
  },
);

test('T19: migration: pending gateway-off + account -> restore applied, gateway action removed, account kept', async function () {
  const ctx = makeCtx({ platform: 'darwin', appDataDir: true });
  logmod.init(ctx.configDir, false);
  loginAccount(ctx, 'alice@example.com', 'u1', FAKE_OAUTH_TOK);
  core.addCurrent(ctx);

  const mainCfg = path.join(ctx.appDataDir, 'claude_desktop_config.json');
  const prof = path.join(ctx.appDataDir, 'configLibrary', desktopgw.KEYFLIP_PROFILE_ID + '.json');
  const gwMeta = path.join(ctx.configDir, '.keyflip-gateway.json');
  fs.mkdirSync(path.dirname(prof), { recursive: true });
  fs.writeFileSync(mainCfg, JSON.stringify({ deploymentMode: '3p', keep: true }));
  fs.writeFileSync(prof, JSON.stringify({ id: desktopgw.KEYFLIP_PROFILE_ID }));
  fs.writeFileSync(gwMeta, JSON.stringify({ provider: 'keysmith-failover', previousDeploymentMode: '1p' }));

  fs.writeFileSync(
    path.join(ctx.configDir, dr.PENDING_FILE),
    JSON.stringify({
      actions: [
        { kind: 'gateway-off', target: null, reason: 'legacy' },
        { kind: 'account', target: 'alice', email: 'alice@example.com', reason: 'autoswitch' },
      ],
      since: 1700000070000,
      notified: false,
    }),
  );

  const tickRes = await autosw.tick(ctx, {
    nowMs: 1700000071000,
    cacheTtlMs: 0,
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ five_hour: { utilization: 15 } }),
    }),
  });

  assert.ok(tickRes.migratedGateway && tickRes.migratedGateway.migrated);
  assert.strictEqual(JSON.parse(fs.readFileSync(mainCfg, 'utf8')).deploymentMode, '1p');
  assert.strictEqual(fs.existsSync(prof), false);
  assert.strictEqual(fs.existsSync(gwMeta), false);

  const pending = dr.readPending(ctx);
  assert.ok(pending, 'account action preserved');
  assert.deepStrictEqual(
    pending.actions.map((a) => a.kind + ':' + a.target),
    ['account:alice'],
  );

  const logText = fs.readFileSync(path.join(ctx.configDir, 'logs', 'keyflip.log'), 'utf8');
  assert.match(logText, /migrated pending gateway-off: restored Desktop first-party config/);
});

test('T20: old 12 h expiry can no longer drop a gateway action without restore (no gateway actions exist)', async function () {
  const ctx = makeCtx({ platform: 'darwin', appDataDir: true });

  // 1) Gateway restart kinds no longer exist in KINDS or request().
  assert.strictEqual('gateway-on' in dr.KINDS, false);
  assert.strictEqual('gateway-off' in dr.KINDS, false);
  assert.deepStrictEqual(Object.keys(dr.KINDS), ['account']);
  assert.throws(() => dr.request(ctx, { kind: 'gateway-on', target: 'gw' }), /unsupported desktop restart kind/);
  assert.throws(() => dr.request(ctx, { kind: 'gateway-off' }), /unsupported desktop restart kind/);

  // 2) Even if a legacy .desktop-restart.json on disk is >12h old with gateway-off and Desktop is in 3p,
  // processPending / revalidate restores Desktop BEFORE expiry can drop the record.
  const mainCfg = path.join(ctx.appDataDir, 'claude_desktop_config.json');
  fs.mkdirSync(ctx.appDataDir, { recursive: true });
  fs.writeFileSync(mainCfg, JSON.stringify({ deploymentMode: '3p' }));
  const t0 = 1700000000000;
  fs.writeFileSync(
    path.join(ctx.configDir, dr.PENDING_FILE),
    JSON.stringify({
      actions: [{ kind: 'gateway-off', target: null }],
      since: t0,
    }),
  );

  const r = await dr.processPending(ctx, {
    nowMs: t0 + 24 * 3600 * 1000, // 24h > 12h pendingMaxHours
    isRunning: () => false,
  });
  assert.strictEqual(r.state, 'none');
  assert.strictEqual(dr.readPending(ctx), null);
  assert.strictEqual('deploymentMode' in JSON.parse(fs.readFileSync(mainCfg, 'utf8')), false, '3p restored despite >12h age');
});

test('T30: secret redaction unit + probe-reason redaction + engage/tick/off output grep -> zero hits', async function () {
  redactMod.clearSecrets();
  const ctx = makeCtx({ platform: 'darwin', appDataDir: true });
  logmod.init(ctx.configDir, false);
  notify.setConfig(ctx, { webhook: 'https://hooks.invalid/test', events: ['quota', 'switch'] });

  // Register custom secret via store read + standard token shapes.
  ctx.store.setProfile('custom__slot', FAKE_CUSTOM_SECRET);
  assert.strictEqual(ctx.store.getProfile('custom__slot'), FAKE_CUSTOM_SECRET);

  const sampleRaw = [
    'key1=' + FAKE_API_KEY,
    'key2=' + FAKE_GW_KEY,
    'oauth=' + FAKE_OAUTH_TOK,
    'cookie: sessionKey=' + FAKE_SESSION_KEY,
    'hdr Authorization: Bearer tok_FAKE_BEARER_123456',
    'inline Bearer tok_FAKE_INLINE_987654',
    'custom=' + FAKE_CUSTOM_SECRET,
  ].join(' | ');

  const redactedSample = redactMod.redact(sampleRaw);
  const forbidden = [
    FAKE_API_KEY,
    FAKE_GW_KEY,
    FAKE_OAUTH_TOK,
    FAKE_SESSION_KEY,
    FAKE_CUSTOM_SECRET,
    'tok_FAKE_BEARER_123456',
    'tok_FAKE_INLINE_987654',
  ];
  forbidden.forEach(function (sec) {
    assert.strictEqual(redactedSample.indexOf(sec), -1, 'redact() must strip ' + sec);
  });

  // Probe-reason redaction + <= 160 char cap.
  const longNoisyStderr =
    '401 Unauthorized: invalid key ' +
    FAKE_GW_KEY +
    ' and ' +
    FAKE_API_KEY +
    ' sessionKey=' +
    FAKE_SESSION_KEY +
    ' Authorization: Bearer tok_FAKE_BEARER_123456 ' +
    'X'.repeat(400);
  const classified = fosurface.classifyProbeFailure({ timedOut: false, code: 1, stdout: '', stderr: longNoisyStderr });
  assert.strictEqual(classified.class, 'auth');
  assert.ok(classified.reason.length <= 160, 'probe reason capped at <= 160 chars, got ' + classified.reason.length);
  forbidden.forEach(function (sec) {
    assert.strictEqual(classified.reason.indexOf(sec), -1, 'probe reason must not contain ' + sec);
  });

  // End-to-end Slice 1 flow (failed probe -> successful engage -> tick -> off) with webhook + log + history.
  loginAccount(ctx, 'alice@example.com', 'u1', FAKE_OAUTH_TOK);
  core.addCurrent(ctx);
  const { ksPath, gwFetch } = setupGateway(ctx, { key: FAKE_GW_KEY });

  const webhookBodies = [];
  const webhookFetch = async function (url, init) {
    if (String(url).indexOf('hooks.invalid') !== -1) {
      webhookBodies.push(String((init && init.body) || ''));
      return { ok: true, status: 200 };
    }
    return gwFetch(url, init);
  };
  const noteFn = async function (ev, msg) {
    await notify.send(ctx, ev, { message: msg }, { force: true, fetch: webhookFetch });
  };

  // 1) Failing probe that leaks secrets on stderr.
  const failSp = makeFakeSpawn(function (rec) {
    setImmediate(function () {
      rec.child.stderr.emit('data', longNoisyStderr);
      rec.child.emit('close', 1);
    });
  });
  const badEng = await failover.engage(
    ctx,
    { from: 'alice' },
    { fetch: gwFetch, keysmithConfig: ksPath, spawn: failSp.spawn, notify: noteFn, nowMs: 1700000080000 },
  );
  assert.strictEqual(badEng.ok, false);

  // 2) Passing engage -> tick -> off with fake processes carrying secrets.
  const okSp = okSpawnRecorder();
  const goodEng = await failover.engage(
    ctx,
    { from: 'alice', reason: 'exhausted with token ' + FAKE_OAUTH_TOK + ' at https://api.example/v1?key=' + FAKE_GW_KEY },
    { fetch: gwFetch, keysmithConfig: ksPath, spawn: okSp.spawn, notify: noteFn, nowMs: 1700000081000 },
  );
  assert.strictEqual(goodEng.ok, true);

  const envSnapshotWhileEngaged = fs.readFileSync(fosurface.envPath(ctx), 'utf8');
  const stateSnapshotWhileEngaged = fs.readFileSync(path.join(ctx.configDir, failover.STATE_FILE), 'utf8');
  const txnSnapshotWhileEngaged = fs.readFileSync(fosurface.txnPath(ctx), 'utf8');

  const tickOut = await autosw.tick(ctx, {
    nowMs: 1700000082000,
    cacheTtlMs: 0,
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ five_hour: { utilization: 99 } }),
    }),
    failover: {
      state: () => failover.state(ctx),
      check: () => failover.gatewayReady(ctx, { fetch: gwFetch, capCheck: false }),
      engage: async () => ({ ok: true }),
      release: async () => ({ ok: true }),
    },
  });

  const relOut = await failover.release(
    ctx,
    { by: 'cli', to: 'alice', reason: 'off' },
    {
      notify: noteFn,
      listProcesses: () => [
        {
          pid: 9001,
          startedAt: 1700000081500,
          command: 'claude',
          env: {
            CLAUDE_CODE_ENTRYPOINT: 'cli',
            ANTHROPIC_AUTH_TOKEN: FAKE_GW_KEY,
            ANTHROPIC_API_KEY: FAKE_API_KEY,
            SESSION: FAKE_SESSION_KEY,
          },
        },
      ],
    },
  );
  assert.strictEqual(relOut.ok, true);

  // Log a line directly with fake secrets to verify log.log redaction on disk too.
  logmod.log('manual check: ' + sampleRaw);

  // Collect every output surface: snapshots, configDir files (except creds store if file-backed; here MemoryStore),
  // logs/keyflip.log, events.jsonl, webhook bodies, and JSON return payloads.
  const corpusParts = [
    envSnapshotWhileEngaged,
    stateSnapshotWhileEngaged,
    txnSnapshotWhileEngaged,
    JSON.stringify(badEng),
    JSON.stringify(goodEng),
    JSON.stringify(tickOut),
    JSON.stringify(relOut),
    webhookBodies.join('\n'),
  ];
  walkFiles(ctx.configDir).forEach(function (fp) {
    corpusParts.push(fp + ':\n' + fs.readFileSync(fp, 'utf8'));
  });
  const corpus = corpusParts.join('\n');

  forbidden.forEach(function (sec) {
    assert.strictEqual(corpus.indexOf(sec), -1, 'secret leaked in output/files: ' + sec);
  });
});
