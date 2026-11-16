// Slice 1 + Slice 2 tests: failover transaction core & CLI surface (T1-T20, T30).
// Every test is hermetic: makeCtx() temp dirs, MemoryStore / fake KeychainStore,
// and injected fakes for fetch, spawn, listProcesses, lsof, notify, and clock.
import test from 'node:test';
import assert from 'node:assert';
import cp from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeCtx, writeClaude, assertPrivateMode } from './helpers.js';
import * as config from '../src/config.js';
import * as provider from '../src/provider.js';
import * as failover from '../src/failover.js';
import * as fosurface from '../src/fosurface.js';
import * as sessions from '../src/sessions.js';
import * as mcp from '../src/mcp.js';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIN_PATH = path.join(__dirname, '..', 'bin', 'keyflip.js');

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

async function runCliCaptured(argv, ctx) {
  const outChunks = [];
  const errChunks = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const prevExit = process.exitCode;
  process.stdout.write = function (c, enc, cb) {
    if (typeof c === 'string') {
      outChunks.push(c);
      if (typeof enc === 'function') enc();
      else if (typeof cb === 'function') cb();
      return true;
    }
    return origOut(c, enc, cb);
  };
  process.stderr.write = function (c, enc, cb) {
    if (typeof c === 'string') {
      errChunks.push(c);
      if (typeof enc === 'function') enc();
      else if (typeof cb === 'function') cb();
      return true;
    }
    return origErr(c, enc, cb);
  };
  process.exitCode = 0;
  let exitCode;
  try {
    await cliMain(argv, ctx);
    exitCode = process.exitCode || 0;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exitCode = prevExit;
  }
  return {
    stdout: outChunks.join(''),
    stderr: errChunks.join(''),
    exitCode,
  };
}

function mcpTool(name) {
  const hit = mcp.TOOLS.find((t) => t.name === name);
  assert.ok(hit, 'missing MCP tool: ' + name);
  return hit;
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
    nowMs: 1700000500000,
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

test('T11: probe failure classification: too-many-tools, quota (with "Resets in 46h43m" -> reset time), auth', async function () {
  const fixedNow = Date.UTC(2026, 10, 14, 12, 0, 0); // 2026-11-14T12:00:00.000Z

  // 1) too-many-tools ("at most 128")
  const cTools = fosurface.classifyProbeFailure(
    {
      timedOut: false,
      code: 1,
      stdout: '',
      stderr: 'APIError: 400 invalid_request_error: tools: 243 tools provided, at most 128 are taken',
    },
    { nowMs: fixedNow },
  );
  assert.strictEqual(cTools.class, 'too-many-tools');
  assert.match(cTools.reason, /^too-many-tools:/);
  assert.strictEqual(cTools.resetAt, null);

  // 2) quota ("Resets in 46h43m" -> exact ISO resetAt)
  const expectedResetIso = new Date(fixedNow + (46 * 3600 + 43 * 60) * 1000).toISOString();
  const cQuota = fosurface.classifyProbeFailure(
    {
      timedOut: false,
      code: 1,
      stdout: JSON.stringify({
        type: 'result',
        is_error: true,
        result: 'leg agy/claude-sonnet-5-5-low: quota reached. Resets in 46h43m',
      }),
      stderr: '',
    },
    { nowMs: fixedNow },
  );
  assert.strictEqual(cQuota.class, 'quota');
  assert.strictEqual(cQuota.resetAt, expectedResetIso);
  assert.match(cQuota.reason, /^quota:/);

  // Also verify end-to-end through fosurface.probe() with fake spawn.
  const ctx = makeCtx();
  setupGateway(ctx);
  const quotaSpawn = makeFakeSpawn(function (rec) {
    setImmediate(function () {
      rec.child.stderr.emit('data', 'Error: out of quota on agy/claude-sonnet-5-5-low — Resets in 46h43m');
      rec.child.emit('close', 1);
    });
  });
  const probeRes = await fosurface.probe(ctx, 'cli-launcher', {
    forceGateway: true,
    spawn: quotaSpawn.spawn,
    now: () => fixedNow,
  });
  assert.strictEqual(probeRes.ok, false);
  assert.strictEqual(probeRes.class, 'quota');
  assert.strictEqual(probeRes.resetAt, expectedResetIso);

  // 3) auth (401/403 + secret redaction)
  const cAuth = fosurface.classifyProbeFailure(
    {
      timedOut: false,
      code: 1,
      stdout: '',
      stderr: 'HTTP 401 authentication_error: invalid key ' + FAKE_GW_KEY + ' / ' + FAKE_API_KEY,
    },
    { nowMs: fixedNow },
  );
  assert.strictEqual(cAuth.class, 'auth');
  assert.strictEqual(cAuth.resetAt, null);
  assert.match(cAuth.reason, /^auth:/);
  assert.strictEqual(cAuth.reason.indexOf(FAKE_GW_KEY), -1, 'gateway key redacted from auth reason');
  assert.strictEqual(cAuth.reason.indexOf(FAKE_API_KEY), -1, 'api key redacted from auth reason');
});

test('T12: failover run spawns claude with token only in env (assert argv has no token) and --strict-mcp-config when configured', async function () {
  const ctx = makeCtx();
  const { ksPath, gwFetch } = setupGateway(ctx);

  // Refuses when failover is not engaged and --force-gateway is omitted.
  let spawnedCount = 0;
  const refused = await runCliCaptured(
    ['failover', 'run', '--', '-p', 'ping'],
    Object.assign({}, ctx, {
      spawnSync: function () {
        spawnedCount++;
        return { status: 0 };
      },
    }),
  );
  assert.strictEqual(refused.exitCode, 1);
  assert.strictEqual(spawnedCount, 0);
  assert.match(refused.stderr, /not engaged|--force-gateway/);

  // Engage cli-launcher and configure failover.mcpConfig.
  const mcpConfigFile = path.join(ctx.home, 'reduced-mcp.json');
  fs.writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: {} }));
  config.set(ctx, 'failover.mcpConfig', mcpConfigFile);

  const sp = okSpawnRecorder();
  const eng = await failover.engage(
    ctx,
    { from: 'gmail', manual: true },
    { fetch: gwFetch, keysmithConfig: ksPath, spawn: sp.spawn, nowMs: 1700000100000 },
  );
  assert.strictEqual(eng.ok, true);

  const syncCalls = [];
  const runCtx = Object.assign({}, ctx, {
    claudeBin: '/fake/bin/claude',
    env: {
      PATH: '/usr/bin:/bin',
      USER_KEEP: 'yes',
      ANTHROPIC_API_KEY: FAKE_API_KEY,
      ANTHROPIC_MODEL: 'claude-3-5-sonnet-parent',
    },
    spawnSync: function (cmd, args, opts) {
      syncCalls.push({ cmd, args: args.slice(), opts });
      return { status: 0 };
    },
  });

  const okRun = await runCliCaptured(['failover', 'run', '--', '-p', 'hello', '--max-turns', '1'], runCtx);
  assert.strictEqual(okRun.exitCode, 0);
  assert.strictEqual(syncCalls.length, 1);
  assert.strictEqual(syncCalls[0].cmd, '/fake/bin/claude');
  assert.deepStrictEqual(syncCalls[0].args, [
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfigFile,
    '-p',
    'hello',
    '--max-turns',
    '1',
  ]);
  assert.strictEqual(JSON.stringify(syncCalls[0].args).indexOf(FAKE_GW_KEY), -1, 'argv has NO token');
  assert.strictEqual(syncCalls[0].opts.stdio, 'inherit');
  assert.strictEqual(syncCalls[0].opts.env.ANTHROPIC_AUTH_TOKEN, FAKE_GW_KEY, 'token passed in child env');
  assert.strictEqual(syncCalls[0].opts.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8787');
  assert.strictEqual(syncCalls[0].opts.env.ANTHROPIC_MODEL, 'claude-failover');
  assert.strictEqual(syncCalls[0].opts.env.ANTHROPIC_API_KEY, undefined, 'parent ANTHROPIC_* stripped');
  assert.strictEqual(syncCalls[0].opts.env.USER_KEEP, 'yes');

  // --print-command prints exact command, never spawns, never leaks token.
  const printed = await runCliCaptured(['failover', 'run', '--print-command', '--', '-p', 'hello world'], runCtx);
  assert.strictEqual(printed.exitCode, 0);
  assert.strictEqual(syncCalls.length, 1, '--print-command must not spawn');
  assert.match(printed.stdout.trim(), /^keyflip failover run -- -p 'hello world'$/);
  assert.strictEqual(printed.stdout.indexOf(FAKE_GW_KEY), -1);

  // Release failover, verify --force-gateway works without writing .failover-env.json, and propagates child exit code.
  await failover.release(ctx, { by: 'test', reason: 'done' });
  assert.strictEqual(fs.existsSync(fosurface.envPath(ctx)), false);

  const nonZeroCtx = Object.assign({}, runCtx, {
    spawnSync: function (cmd, args, opts) {
      syncCalls.push({ cmd, args: args.slice(), opts });
      return { status: 42 };
    },
  });
  const forced = await runCliCaptured(['failover', 'run', '--force-gateway', '--', '--version'], nonZeroCtx);
  assert.strictEqual(forced.exitCode, 42, 'child exit code propagated');
  assert.strictEqual(syncCalls.length, 2);
  assert.strictEqual(syncCalls[1].opts.env.ANTHROPIC_AUTH_TOKEN, FAKE_GW_KEY);
  assert.strictEqual(JSON.stringify(syncCalls[1].args).indexOf(FAKE_GW_KEY), -1);
  assert.strictEqual(fs.existsSync(fosurface.envPath(ctx)), false, '--force-gateway writes nothing on disk');
});

test("T13: failover resume --last picks newest transcript; refuses (exit 3) when that session's pid is alive", async function () {
  const ctx = makeCtx({ platform: 'darwin', appDataDir: true });
  const { ksPath, gwFetch } = setupGateway(ctx);
  const sp = okSpawnRecorder();
  const eng = await failover.engage(
    ctx,
    { from: 'gmail', manual: true },
    { fetch: gwFetch, keysmithConfig: ksPath, spawn: sp.spawn, nowMs: 1700000110000 },
  );
  assert.strictEqual(eng.ok, true);

  const projOld = path.join(ctx.home, 'proj-old');
  const projDesk = path.join(ctx.home, 'proj-desk');
  const projNewest = path.join(ctx.home, 'proj-newest');
  [projOld, projDesk, projNewest].forEach((d) => fs.mkdirSync(d, { recursive: true }));

  function writeTranscript(cwdDir, sessionId, mtimeSec, extra) {
    const dir = path.join(ctx.claudeDir, 'projects', sessions.encodeCwd(cwdDir));
    fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, sessionId + '.jsonl');
    const rec = Object.assign({ cwd: cwdDir, timestamp: new Date(mtimeSec * 1000).toISOString() }, extra || {});
    fs.writeFileSync(fp, JSON.stringify(rec) + '\n');
    const dt = new Date(mtimeSec * 1000);
    fs.utimesSync(fp, dt, dt);
    return fp;
  }

  const idOld = '11111111-1111-4111-8111-111111111111';
  const idDesk = '22222222-2222-4222-8222-222222222222';
  const idNewest = '33333333-3333-4333-8333-333333333333';
  writeTranscript(projOld, idOld, 1700000100);
  writeTranscript(projDesk, idDesk, 1700000200, { entrypoint: 'claude-desktop' });
  writeTranscript(projNewest, idNewest, 1700000300);

  // Also register idDesk in Desktop's claude-code-sessions registry.
  const deskStore = path.join(ctx.appDataDir, 'claude-code-sessions', 'acct', 'org');
  fs.mkdirSync(deskStore, { recursive: true });
  fs.writeFileSync(path.join(deskStore, 'local_desk.json'), JSON.stringify({ cliSessionId: idDesk, cwd: projDesk }));

  // Also verify shared sessions.resolveResume() works directly and via MCP keyflip_resume_command.
  const mcpRc = await mcpTool('keyflip_resume_command').run(ctx, { id: idOld.slice(0, 8) });
  assert.deepStrictEqual(mcpRc, { cwd: projOld, command: 'claude --resume ' + idOld });

  const syncCalls = [];
  const baseResumeCtx = Object.assign({}, ctx, {
    claudeBin: '/fake/bin/claude',
    pidAlive: () => false,
    spawnSync: function (cmd, args, opts) {
      syncCalls.push({ cmd, args: args.slice(), cwd: opts.cwd, env: opts.env });
      return { status: 0 };
    },
  });

  // 1) `failover resume --last` picks newest transcript (idNewest in projNewest).
  const rLast = await runCliCaptured(['failover', 'resume', '--last'], baseResumeCtx);
  assert.strictEqual(rLast.exitCode, 0);
  assert.strictEqual(syncCalls.length, 1);
  assert.deepStrictEqual(syncCalls[0].args, ['--resume', idNewest]);
  assert.strictEqual(syncCalls[0].cwd, projNewest);
  assert.strictEqual(syncCalls[0].env.ANTHROPIC_AUTH_TOKEN, FAKE_GW_KEY);
  assert.strictEqual(JSON.stringify(syncCalls[0].args).indexOf(FAKE_GW_KEY), -1);

  // 2) `failover resume --last --desktop` picks newest Desktop session (idDesk in projDesk).
  const rDeskIdle = await runCliCaptured(['failover', 'resume', '--last', '--desktop'], baseResumeCtx);
  assert.strictEqual(rDeskIdle.exitCode, 0);
  assert.strictEqual(syncCalls.length, 2);
  assert.deepStrictEqual(syncCalls[1].args, ['--resume', idDesk]);
  assert.strictEqual(syncCalls[1].cwd, projDesk);

  // 3) Mark idDesk's PID as alive -> refuses with exit 3 and exact message, unless --yes is passed.
  const sessDir = path.join(ctx.claudeDir, 'sessions');
  fs.mkdirSync(sessDir, { recursive: true });
  const liveDeskPid = process.pid; // guaranteed alive in both in-process and spawned subprocess checks
  fs.writeFileSync(
    path.join(sessDir, liveDeskPid + '.json'),
    JSON.stringify({ pid: liveDeskPid, sessionId: idDesk, entrypoint: 'claude-desktop', status: 'idle' }),
  );

  const liveResumeCtx = Object.assign({}, baseResumeCtx, {
    pidAlive: (p) => p === liveDeskPid,
  });
  const refused = await runCliCaptured(['failover', 'resume', '--last', '--desktop'], liveResumeCtx);
  assert.strictEqual(refused.exitCode, 3);
  assert.strictEqual(syncCalls.length, 2, 'must not spawn when session pid is alive');
  assert.match(refused.stderr, /stop this session in Desktop first \(one writer per transcript\)/);

  // Verify real spawned CLI process exit code === 3 as well.
  const sub = cp.spawnSync(process.execPath, [BIN_PATH, 'failover', 'resume', '--last', '--desktop'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      HOME: ctx.home,
      USERPROFILE: ctx.home,
      KEYFLIP_CONFIG_DIR: ctx.configDir,
      KEYFLIP_TEST_OFFLINE: '1',
    }),
  });
  assert.strictEqual(sub.status, 3, 'spawned keyflip exits with code 3 when session pid is alive');
  assert.match(sub.stderr, /stop this session in Desktop first \(one writer per transcript\)/);

  // With --yes, proceeds despite live pid.
  const forcedYes = await runCliCaptured(['failover', 'resume', '--last', '--desktop', '--yes'], liveResumeCtx);
  assert.strictEqual(forcedYes.exitCode, 0);
  assert.strictEqual(syncCalls.length, 3);
  assert.deepStrictEqual(syncCalls[2].args, ['--resume', idDesk]);
  assert.strictEqual(syncCalls[2].cwd, projDesk);
});

test('T14: failover verify --no-spend makes zero inference calls; --deep issues the tool and subagent probes; exit codes 0/2/1', async function () {
  const fixedNow = Date.UTC(2026, 10, 14, 14, 0, 0);
  const ctx = makeCtx({ platform: 'darwin', appDataDir: true });
  const ksPath = writeKeysmithCfg(ctx);
  ctx.store.setProfile('provider__keysmith-failover', FAKE_GW_KEY);
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

  const usageLogPath = path.join(ctx.home, '.local', 'share', 'keysmith', 'usage.jsonl');
  fs.mkdirSync(path.dirname(usageLogPath), { recursive: true });
  fs.writeFileSync(
    usageLogPath,
    JSON.stringify({
      ts: new Date(fixedNow - 60 * 1000).toISOString(),
      leg: 'claude-failover-api/claude-opus-5-5',
      adapter: 'claude-failover-api',
      status: 200,
      ok: true,
    }) + '\n',
  );

  let capCalls = 0;
  const meteredFetch = async function (url) {
    if (/\/v1\/keysmith\/usage/.test(url)) {
      capCalls++;
      // Return 7.34 before probes, 7.39 after probes (delta = $0.05).
      const spent = capCalls === 1 ? 7.34 : 7.39;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          spend: [
            {
              kind: 'adapter',
              target: 'claude-failover-api',
              cap: 25,
              spent,
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
      json: async () => ({ data: [{ id: 'claude-failover' }] }),
    };
  };

  // A) --no-spend -> zero inference spawns, exit 0, read-only (nothing written to settings.json or .failover-env.json).
  const noSpendRecorder = okSpawnRecorder();
  const verifyCtxA = Object.assign({}, ctx, {
    fetch: meteredFetch,
    spawn: noSpendRecorder.spawn,
    keysmithConfig: ksPath,
    nowMs: fixedNow,
    listProcesses: () => [],
  });
  const resNoSpend = await runCliCaptured(['failover', 'verify', '--no-spend', '--json'], verifyCtxA);
  assert.strictEqual(resNoSpend.exitCode, 0, resNoSpend.stderr || resNoSpend.stdout);
  assert.strictEqual(noSpendRecorder.calls.length, 0, '--no-spend must make zero inference calls');
  assert.strictEqual(fs.existsSync(ctx.claudeSettingsPath), false, 'verify never writes settings.json');
  assert.strictEqual(fs.existsSync(fosurface.envPath(ctx)), false, 'verify never writes .failover-env.json');

  const jsonA = JSON.parse(resNoSpend.stdout.trim());
  assert.strictEqual(jsonA.spentUsd, 0);
  assert.deepStrictEqual(
    jsonA.checks.map((c) => c.id),
    ['gateway', 'legs', 'modelIds', 'probe', 'leftovers', 'processes', 'toolCount'],
  );
  assert.ok(jsonA.checks.every((c) => c.state === 'ok'));
  assert.match(jsonA.checks[0].reason, /\$7\.34 of \$25, window 12 Nov–9 Dec/);

  // Also check MCP `keyflip_failover_verify` and `keyflip_failover` surface/exhausted fields.
  const mcpVerifyTool = mcpTool('keyflip_failover_verify');
  assert.strictEqual(mcpVerifyTool.annotations.readOnlyHint, false);
  assert.strictEqual(mcpVerifyTool.annotations.openWorldHint, true);
  assert.strictEqual(mcpVerifyTool.annotations.destructiveHint, false);
  const mcpV = await mcpVerifyTool.run(verifyCtxA, { no_spend: true });
  assert.strictEqual(mcpV.exitCode, 0);
  assert.strictEqual(mcpV.checks.length, 7);

  const mcpStatus = await mcpTool('keyflip_failover').run(verifyCtxA, { action: 'status' });
  assert.strictEqual(mcpStatus.failover.surface, null);
  assert.strictEqual(mcpStatus.failover.exhausted, null);

  // B) --deep -> runs default, sonnet, Bash tool ("run: echo hi"), and sonnet subagent ("PONG") probes; metered spentUsd = 0.05; exit 0.
  capCalls = 0;
  const deepSpawn = makeFakeSpawn(function (rec, idx) {
    setImmediate(function () {
      const reply = idx === 2 ? 'hi' : idx === 3 ? 'PONG' : 'OK';
      rec.child.stdout.emit(
        'data',
        JSON.stringify({ type: 'result', is_error: false, result: reply, total_cost_usd: 0.01 }),
      );
      rec.child.emit('close', 0);
    });
  });
  const verifyCtxB = Object.assign({}, verifyCtxA, { spawn: deepSpawn.spawn });
  const resDeep = await runCliCaptured(['failover', 'verify', '--deep', '--json'], verifyCtxB);
  assert.strictEqual(resDeep.exitCode, 0, resDeep.stderr || resDeep.stdout);
  assert.strictEqual(deepSpawn.calls.length, 4, 'default + sonnet + bash + subagent = 4 spawns');

  // Verify exact probe shapes:
  assert.strictEqual(deepSpawn.calls[0].args.includes('--model'), false, '1st probe is default model');
  assert.ok(
    deepSpawn.calls[1].args.includes('--model') && deepSpawn.calls[1].args.includes('sonnet'),
    '2nd probe passes --model sonnet',
  );
  assert.ok(
    deepSpawn.calls[2].args.includes('--allowedTools') &&
      deepSpawn.calls[2].args.includes('Bash') &&
      deepSpawn.calls[2].args.includes('run: echo hi'),
    '3rd probe (--deep) runs Bash tool check',
  );
  assert.ok(
    deepSpawn.calls[3].args.some((a) => /sonnet.*subagent.*PONG/i.test(a)),
    '4th probe (--deep) runs sonnet general-purpose subagent PONG check',
  );
  deepSpawn.calls.forEach(function (call) {
    assert.strictEqual(JSON.stringify(call.args).indexOf(FAKE_GW_KEY), -1, 'probe argv never carries key');
    assert.strictEqual(call.env.ANTHROPIC_AUTH_TOKEN, FAKE_GW_KEY);
  });

  const jsonB = JSON.parse(resDeep.stdout.trim());
  assert.strictEqual(jsonB.spentUsd, 0.05, 'metered spend delta read from cap before/after');
  const probeCheckB = jsonB.checks.find((c) => c.id === 'probe');
  assert.strictEqual(probeCheckB.state, 'ok');
  assert.deepStrictEqual(probeCheckB.detail.deepChecks, ['bash', 'subagent']);
  assert.strictEqual(fs.existsSync(ctx.claudeSettingsPath), false, '--deep still writes nothing to settings.json');
  assert.strictEqual(fs.existsSync(fosurface.envPath(ctx)), false, '--deep still writes nothing to .failover-env.json');

  // C) Warn -> exit code 2 (quota leg with "Resets in 12h", >128-tool rejection in 7d, leftover file, process carrying gateway env).
  const legErrTs = fixedNow - 1800 * 1000;
  const expectedLegReset = new Date(legErrTs + 12 * 3600 * 1000).toISOString();
  fs.writeFileSync(
    usageLogPath,
    [
      JSON.stringify({
        ts: new Date(legErrTs).toISOString(),
        leg: 'agy/claude-sonnet-5-5-low',
        adapter: 'agy',
        ok: false,
        status: 429,
        error: 'quota reached. Resets in 12h',
      }),
      JSON.stringify({
        ts: new Date(fixedNow - 2 * 86400 * 1000).toISOString(),
        leg: 'claude-failover-api/claude-opus-5-5',
        adapter: 'claude-failover-api',
        ok: false,
        status: 400,
        error: 'tools: 243 provided, at most 128 are taken',
      }),
    ].join('\n') + '\n',
  );
  fs.writeFileSync(path.join(ctx.configDir, '.keyflip-gateway.json'), JSON.stringify({ provider: 'keysmith-failover' }));

  const verifyCtxWarn = Object.assign({}, verifyCtxA, {
    listProcesses: () => [
      {
        pid: 8181,
        startedAt: fixedNow - 5000,
        command: 'claude',
        env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' },
      },
    ],
  });
  const resWarn = await runCliCaptured(['failover', 'verify', '--no-spend', '--json'], verifyCtxWarn);
  assert.strictEqual(resWarn.exitCode, 2, 'warnings without failures must exit 2');
  const jsonWarn = JSON.parse(resWarn.stdout.trim());
  const byIdWarn = Object.fromEntries(jsonWarn.checks.map((c) => [c.id, c]));
  assert.strictEqual(byIdWarn.legs.state, 'warn');
  assert.ok(byIdWarn.legs.reason.includes(expectedLegReset), 'legs warn includes computed reset time');
  assert.strictEqual(byIdWarn.leftovers.state, 'warn');
  assert.strictEqual(byIdWarn.processes.state, 'warn');
  assert.strictEqual(byIdWarn.toolCount.state, 'warn');
  assert.match(byIdWarn.toolCount.reason, /failover\.mcpConfig/);

  // D) Fail -> exit code 1 when probe fails (or gateway fails).
  const failProbeSpawn = makeFakeSpawn(function (rec) {
    setImmediate(function () {
      rec.child.stderr.emit('data', '404 model_not_found');
      rec.child.emit('close', 1);
    });
  });
  const verifyCtxFail = Object.assign({}, verifyCtxWarn, { spawn: failProbeSpawn.spawn });
  const resFail = await runCliCaptured(['failover', 'verify', '--json'], verifyCtxFail);
  assert.strictEqual(resFail.exitCode, 1, 'any failing check must exit 1');
  const jsonFail = JSON.parse(resFail.stdout.trim());
  assert.strictEqual(jsonFail.checks.find((c) => c.id === 'probe').state, 'fail');
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
  process.stdout.write = function (c, enc, cb) {
    if (typeof c === 'string') {
      chunks.push(c);
      if (typeof enc === 'function') enc();
      else if (typeof cb === 'function') cb();
      return true;
    }
    return origWrite(c, enc, cb);
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
  fs.writeFileSync(
    mainCfg,
    JSON.stringify({ deploymentMode: '3p', enterpriseConfig: { activeConfigId: desktopgw.KEYFLIP_PROFILE_ID } }),
  );
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

test('T30: end-to-end (engage -> tick -> verify -> off) with fake key ks_FAKE_GATEWAY_KEY_FOR_TESTS and fake OAuth/session tokens: grep stdout, stderr, logs/keyflip.log, events.jsonl, history, notifications, --json outputs, txn/state files -> zero hits', async function () {
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

  // End-to-end flow: engage -> tick -> verify -> off (CLI human + --json + MCP + webhook + log + history).
  loginAccount(ctx, 'alice@example.com', 'u1', FAKE_OAUTH_TOK);
  core.addCurrent(ctx);
  const { ksPath, gwFetch } = setupGateway(ctx, { key: FAKE_GW_KEY });

  // Seed keysmith usage.jsonl with an error line containing fake secrets to verify `verify` redacts leg errors too.
  const usageLogPath = path.join(ctx.home, '.local', 'share', 'keysmith', 'usage.jsonl');
  fs.mkdirSync(path.dirname(usageLogPath), { recursive: true });
  fs.writeFileSync(
    usageLogPath,
    JSON.stringify({
      ts: new Date(1700000081500).toISOString(),
      leg: 'agy/claude-sonnet-5-5-low',
      adapter: 'agy',
      ok: false,
      status: 401,
      error: 'upstream rejected key ' + FAKE_GW_KEY + ' and ' + FAKE_API_KEY + ' Resets in 2h',
    }) + '\n',
  );

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
    { fetch: gwFetch, keysmithConfig: ksPath, spawn: failSp.spawn, notify: noteFn, nowMs: 1700000080000 - 31 * 60 * 1000 },
  );
  assert.strictEqual(badEng.ok, false);

  // 2) Passing engage -> tick -> verify -> off with fake processes carrying secrets.
  const okSp = okSpawnRecorder();
  const goodEng = await failover.engage(
    ctx,
    {
      from: 'alice',
      reason: 'exhausted with token ' + FAKE_OAUTH_TOK + ' at https://api.example/v1?key=' + FAKE_GW_KEY,
    },
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

  const fakeProcessList = () => [
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
    {
      pid: 9002,
      startedAt: 1700000081600,
      command: 'claude',
      env: {
        CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
        ANTHROPIC_MODEL: 'claude-failover',
        ANTHROPIC_AUTH_TOKEN: FAKE_GW_KEY,
        COOKIE: 'sessionKey=' + FAKE_SESSION_KEY,
      },
    },
  ];

  const e2eCliCtx = Object.assign({}, ctx, {
    fetch: webhookFetch, // answers the fake webhook itself, everything else goes to gwFetch
    spawn: okSp.spawn,
    keysmithConfig: ksPath,
    nowMs: 1700000083000,
    listProcesses: fakeProcessList,
    lsof: () => ({ 9001: '/Users/tester/proj-cli', 9002: '/Users/tester/proj-desk' }),
    run: () => ({ code: 0, stdout: '', stderr: '' }),
  });

  // Exercise CLI status, verify, run --print-command, and MCP tools (human + --json) while engaged.
  const cliStatusHuman = await runCliCaptured(['failover', 'status'], e2eCliCtx);
  const cliStatusJson = await runCliCaptured(['failover', 'status', '--json'], e2eCliCtx);
  const cliVerifyHuman = await runCliCaptured(['failover', 'verify'], e2eCliCtx);
  const cliVerifyJson = await runCliCaptured(['failover', 'verify', '--json'], e2eCliCtx);
  const cliPrintRun = await runCliCaptured(['failover', 'run', '--print-command', '--', '-p', 'test'], e2eCliCtx);
  const mcpStatusOut = await mcpTool('keyflip_failover').run(e2eCliCtx, { action: 'status' });
  const mcpVerifyOut = await mcpTool('keyflip_failover_verify').run(e2eCliCtx, {});

  // Exercise CLI `failover off` (human, then re-engage & `--json`) so both human process report and JSON `stillCarrying` are grepped.
  const cliOffHuman = await runCliCaptured(['failover', 'off'], e2eCliCtx);
  assert.strictEqual(cliOffHuman.exitCode, 0);
  await failover.engage(
    ctx,
    { from: 'alice', manual: true },
    { fetch: gwFetch, keysmithConfig: ksPath, spawn: okSp.spawn, notify: noteFn, nowMs: 1700000084000 },
  );
  const cliOffJson = await runCliCaptured(['failover', 'off', '--json'], e2eCliCtx);
  assert.strictEqual(cliOffJson.exitCode, 0);
  const offJsonParsed = JSON.parse(cliOffJson.stdout.trim());
  assert.strictEqual(Array.isArray(offJsonParsed.stillCarrying), true);
  assert.strictEqual(offJsonParsed.stillCarrying.length, 2);

  // Log a line directly with fake secrets to verify log.log redaction on disk too.
  logmod.log('manual check: ' + sampleRaw);

  // Collect EVERY output surface: CLI stdout + stderr, --json outputs, MCP payloads,
  // snapshots while engaged, history.readEvents, webhook bodies, logs/keyflip.log, events.jsonl, and all configDir files.
  const cliOutputs = [
    cliStatusHuman,
    cliStatusJson,
    cliVerifyHuman,
    cliVerifyJson,
    cliPrintRun,
    cliOffHuman,
    cliOffJson,
  ]
    .map((r) => r.stdout + '\n' + r.stderr)
    .join('\n');

  const corpusParts = [
    cliOutputs,
    envSnapshotWhileEngaged,
    stateSnapshotWhileEngaged,
    txnSnapshotWhileEngaged,
    JSON.stringify(badEng),
    JSON.stringify(goodEng),
    JSON.stringify(tickOut),
    JSON.stringify(mcpStatusOut),
    JSON.stringify(mcpVerifyOut),
    JSON.stringify(history.readEvents(ctx)),
    webhookBodies.join('\n'),
  ];
  walkFiles(ctx.configDir).forEach(function (fp) {
    corpusParts.push(fp + ':\n' + fs.readFileSync(fp, 'utf8'));
  });
  const corpus = corpusParts.join('\n');

  assert.ok(fs.existsSync(path.join(ctx.configDir, 'logs', 'keyflip.log')), 'logs/keyflip.log present');
  assert.ok(fs.existsSync(path.join(ctx.configDir, 'events.jsonl')), 'events.jsonl present');

  forbidden.forEach(function (sec) {
    assert.strictEqual(corpus.indexOf(sec), -1, 'secret leaked in output/files: ' + sec);
  });
});

test('A1: listProcesses passes -axEwwo and C locale env; parsePsOutput parses C-locale lstart', function () {
  const calls = [];
  const fakeRun = function (cmd, args, input, opts) {
    calls.push({ cmd, args: args.slice(), input, opts });
    return {
      code: 0,
      stdout:
        '  4812 Sat Oct 31 03:24:31 2026 /Applications/Claude.app/Contents/Resources/claude-code/claude CLAUDE_CODE_ENTRYPOINT=claude-desktop ANTHROPIC_MODEL=claude-failover\n',
      stderr: '',
    };
  };

  const rows = fosurface.listProcesses({ run: fakeRun });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'ps');
  assert.strictEqual(calls[0].args[0].indexOf('-ax'), 0, 'first arg starts with -ax');
  assert.deepStrictEqual(calls[0].args, ['-axEwwo', 'pid=,lstart=,command=']);
  assert.ok(calls[0].opts && calls[0].opts.env, 'env passed in options');
  assert.strictEqual(calls[0].opts.env.LC_ALL, 'C');
  assert.strictEqual(calls[0].opts.env.LANG, 'C');

  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].pid, 4812);
  assert.strictEqual(rows[0].startedAt, Date.parse('Sat Oct 31 03:24:31 2026'));
  assert.strictEqual(rows[0].env.CLAUDE_CODE_ENTRYPOINT, 'claude-desktop');
  assert.strictEqual(rows[0].env.ANTHROPIC_MODEL, 'claude-failover');

  const parsedDirect = fosurface.parsePsOutput(' 991 Sat Oct 31 03:24:31 2026 /usr/local/bin/claude FOO=bar\n');
  assert.strictEqual(parsedDirect.length, 1);
  assert.strictEqual(parsedDirect[0].pid, 991);
  assert.strictEqual(parsedDirect[0].startedAt, Date.parse('Sat Oct 31 03:24:31 2026'));
  assert.strictEqual(parsedDirect[0].command, '/usr/local/bin/claude');
  assert.strictEqual(parsedDirect[0].env.FOO, 'bar');
});

test('A2: recoverCrashedTxn respects live pid & limit, missing backup does not delete target, mid-probe rollback aborts commit', async function () {
  // (a) Live engage (pid = process.pid, fresh startedAt) + tick-style recoverCrashedTxn -> not rolled back, files intact.
  const ctxA = makeCtx();
  setupGateway(ctxA);
  const t0 = 1700001000000;
  const txnA = fosurface.beginTxn(ctxA, 'cli-launcher', { startedAt: t0 });
  assert.strictEqual(txnA.pid, process.pid);
  assert.strictEqual(txnA.phase, 'probing');
  assert.ok(fs.existsSync(fosurface.envPath(ctxA)));

  const recLive = fosurface.recoverCrashedTxn(ctxA, { nowMs: t0 + 5000 });
  assert.deepStrictEqual(recLive, { rolledBack: false, skipped: 'in-progress' });
  assert.ok(fs.existsSync(fosurface.envPath(ctxA)), '.failover-env.json still intact during live probe');
  assert.strictEqual(fosurface.readTxn(ctxA).phase, 'probing');

  // (b) Dead pid (2^22+ non-existent pid via override) -> rolled back; also old record without pid past limit -> rolled back.
  const deadPid = 4194304 + 99999;
  fosurface.writeTxn(ctxA, Object.assign({}, txnA, { pid: deadPid }));
  const recDead = fosurface.recoverCrashedTxn(ctxA, {
    nowMs: t0 + 5000,
    pidAlive: (p) => p !== deadPid,
  });
  assert.strictEqual(recDead.rolledBack, true);
  assert.strictEqual(fs.existsSync(fosurface.envPath(ctxA)), false);
  assert.strictEqual(fosurface.readTxn(ctxA).phase, 'rolled-back');

  // Old record without pid: within limit -> skipped; past limit (90 * 2 * 2 + 60 = 420s) -> rolled back.
  const txnOld = fosurface.beginTxn(ctxA, 'cli-launcher', { startedAt: t0 });
  delete txnOld.pid;
  fosurface.writeTxn(ctxA, txnOld);
  assert.deepStrictEqual(fosurface.recoverCrashedTxn(ctxA, { nowMs: t0 + 400 * 1000 }), {
    rolledBack: false,
    skipped: 'in-progress',
  });
  assert.strictEqual(fosurface.recoverCrashedTxn(ctxA, { nowMs: t0 + 421 * 1000 }).rolledBack, true);

  // (c) rollbackTxn with missing backup but backup recorded does NOT delete settings.json.
  const ctxC = makeCtx();
  logmod.init(ctxC.configDir, false);
  setupGateway(ctxC, { models: ['claude-failover', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] });
  fs.mkdirSync(path.dirname(ctxC.claudeSettingsPath), { recursive: true });
  const userSettings = JSON.stringify({ theme: 'dark', env: { KEEP: '1' } }, null, 2) + '\n';
  fs.writeFileSync(ctxC.claudeSettingsPath, userSettings, 'utf8');

  const txnC = fosurface.beginTxn(ctxC, 'cli-settings', { startedAt: t0 + 1000 });
  assert.ok(txnC.wrote[0].backup, 'backup path recorded');
  // Simulate another process having deleted the backup file before rollbackTxn runs.
  fs.unlinkSync(txnC.wrote[0].backup);
  const currentSettingsBytes = fs.readFileSync(ctxC.claudeSettingsPath, 'utf8');
  fosurface.rollbackTxn(ctxC, txnC, { at: t0 + 2000, ok: false, ms: 0, models: [], reason: 'test', costUsd: null });
  assert.strictEqual(fs.existsSync(ctxC.claudeSettingsPath), true, 'settings.json must NOT be unlinked when backup is missing');
  assert.strictEqual(fs.readFileSync(ctxC.claudeSettingsPath, 'utf8'), currentSettingsBytes);

  // (d) engage with a probe stub that, mid-probe, runs recoverCrashedTxn-with-force or deletes the txn file:
  // engage returns ok:false and no 'kept' state is written.
  for (const mode of ['force-recover', 'delete-txn']) {
    const ctxD = makeCtx();
    const { ksPath, gwFetch } = setupGateway(ctxD);
    const spD = makeFakeSpawn(function (rec, idx) {
      if (idx === 0) {
        if (mode === 'force-recover') {
          fosurface.recoverCrashedTxn(ctxD, { force: true, nowMs: t0 + 3000 });
        } else {
          fs.unlinkSync(fosurface.txnPath(ctxD));
        }
      }
      setImmediate(function () {
        rec.child.stdout.emit('data', JSON.stringify({ type: 'result', is_error: false, result: 'OK', total_cost_usd: 0.001 }));
        rec.child.emit('close', 0);
      });
    });

    const resD = await failover.engage(
      ctxD,
      { from: 'gmail', manual: true },
      { fetch: gwFetch, keysmithConfig: ksPath, spawn: spD.spawn, nowMs: t0 + 3000 },
    );
    assert.strictEqual(resD.ok, false, 'engage must fail when txn rolled back/deleted mid-probe (' + mode + ')');
    assert.match(resD.reason, /transaction was rolled back during the probe/);
    assert.strictEqual(failover.state(ctxD), null, 'no .failover-state.json written');
    const afterTxn = fosurface.readTxn(ctxD);
    assert.strictEqual(!afterTxn || afterTxn.phase !== 'kept', true, 'no kept phase written');
  }
});

test('A3: checkDesktopLeak on kept cli-settings preserves user settings edits, restores overwritten prior ANTHROPIC keys, and keeps state degraded when launcher probe fails', async function () {
  const ctx = makeCtx();
  logmod.init(ctx.configDir, false);
  const { ksPath, gwFetch } = setupGateway(ctx, {
    models: ['claude-failover', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  });
  config.set(ctx, 'failover.cliTarget', 'settings');

  fs.mkdirSync(path.dirname(ctx.claudeSettingsPath), { recursive: true });
  const preUserToken = 'sk-ant-USER-PREEXISTING-KEY-000111222';
  fs.writeFileSync(
    ctx.claudeSettingsPath,
    JSON.stringify(
      {
        env: {
          KEEP_EXISTING: '1',
          ANTHROPIC_MODEL: 'claude-3-7-sonnet-custom',
          ANTHROPIC_API_KEY: preUserToken,
        },
      },
      null,
      2,
    ) + '\n',
  );

  const okSp = okSpawnRecorder();
  const tEngage = 1700002000000;
  const eng = await failover.engage(
    ctx,
    { from: 'alice', manual: true },
    { fetch: gwFetch, keysmithConfig: ksPath, spawn: okSp.spawn, nowMs: tEngage },
  );
  assert.strictEqual(eng.ok, true);
  assert.strictEqual(eng.surface, 'cli-settings');

  // Verify txn JSON recorded priorKeys names only, never the preUserToken value.
  const txnRaw = fs.readFileSync(fosurface.txnPath(ctx), 'utf8');
  assert.strictEqual(txnRaw.indexOf(preUserToken), -1, 'pre-existing user secret never stored in txn JSON');
  const txnObj = JSON.parse(txnRaw);
  assert.deepStrictEqual(txnObj.priorKeys.slice().sort(), ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL']);

  // User edits settings.json hours later while cli-settings is kept: adds permissions.allow and NEW_USER_VAR.
  const liveSettings = JSON.parse(fs.readFileSync(ctx.claudeSettingsPath, 'utf8'));
  liveSettings.permissions = { allow: ['Bash(git status)'] };
  liveSettings.env.NEW_USER_VAR = 'added-after-engage';
  fs.writeFileSync(ctx.claudeSettingsPath, JSON.stringify(liveSettings, null, 2) + '\n');

  // Trigger leak guard with a failing cli-launcher probe to verify both key-wise settings rollback AND degraded state preservation.
  const failLauncherSpawn = makeFakeSpawn(function (rec) {
    setImmediate(function () {
      rec.child.stderr.emit('data', '500 upstream error on launcher probe');
      rec.child.emit('close', 1);
    });
  });

  const leakNotes = [];
  const leakRes = await fosurface.checkDesktopLeak(ctx, {
    nowMs: tEngage + 3600 * 1000,
    spawn: failLauncherSpawn.spawn,
    notify: async (ev, msg) => leakNotes.push({ ev, msg }),
    listProcesses: () => [
      {
        pid: 5151,
        startedAt: tEngage + 10000,
        env: {
          CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
          ANTHROPIC_AUTH_TOKEN: FAKE_GW_KEY,
        },
      },
    ],
  });

  assert.strictEqual(leakRes.leaked, true);
  assert.strictEqual(leakRes.surface, 'cli-launcher');
  assert.ok(leakRes.degraded && leakRes.degraded.at === tEngage + 3600 * 1000);

  // Post-engage edits (permissions.allow, NEW_USER_VAR) survived; gateway keys removed; overwritten prior keys restored.
  const afterSettings = JSON.parse(fs.readFileSync(ctx.claudeSettingsPath, 'utf8'));
  assert.deepStrictEqual(afterSettings.permissions, { allow: ['Bash(git status)'] });
  assert.strictEqual(afterSettings.env.KEEP_EXISTING, '1');
  assert.strictEqual(afterSettings.env.NEW_USER_VAR, 'added-after-engage');
  assert.strictEqual(afterSettings.env.ANTHROPIC_MODEL, 'claude-3-7-sonnet-custom');
  assert.strictEqual(afterSettings.env.ANTHROPIC_API_KEY, preUserToken);
  assert.strictEqual(afterSettings.env.ANTHROPIC_BASE_URL, undefined);
  assert.strictEqual(afterSettings.env.ANTHROPIC_AUTH_TOKEN, undefined);

  // Launcher txn committed (.failover-env.json stays) and .failover-state.json kept with surface='cli-launcher' and degraded={at, reason}.
  assert.strictEqual(fs.existsSync(fosurface.envPath(ctx)), true, '.failover-env.json kept on disk');
  assert.strictEqual(fosurface.readTxn(ctx).phase, 'kept');
  assert.strictEqual(fosurface.readTxn(ctx).surface, 'cli-launcher');
  const stAfter = failover.state(ctx);
  assert.ok(stAfter && stAfter.engaged, '.failover-state.json must not be deleted');
  assert.strictEqual(stAfter.surface, 'cli-launcher');
  assert.ok(stAfter.degraded, 'state has degraded field');
  assert.strictEqual(stAfter.degraded.at, tEngage + 3600 * 1000);
  assert.match(stAfter.degraded.reason, /500 upstream error/);
  assert.strictEqual(leakNotes.length, 1);
  assert.match(leakNotes[0].msg, /degraded/i);
});

test(
  'A4: rollbackTxn preserves original file mode (0644 -> 0644) and byte-identical contents',
  { skip: process.platform === 'win32' },
  async function () {
    const ctx = makeCtx();
    const { ksPath, gwFetch } = setupGateway(ctx, {
      models: ['claude-failover', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    });
    config.set(ctx, 'failover.cliTarget', 'settings');

    fs.mkdirSync(path.dirname(ctx.claudeSettingsPath), { recursive: true });
    const originalBytes = '{\n  "customOrder": 1,\n  "env": {\n    "A": "B"\n  }\n}\n';
    fs.writeFileSync(ctx.claudeSettingsPath, originalBytes, { mode: 0o644 });
    fs.chmodSync(ctx.claudeSettingsPath, 0o644);
    assert.strictEqual(fs.statSync(ctx.claudeSettingsPath).mode & 0o777, 0o644);

    const failSp = makeFakeSpawn(function (rec) {
      setImmediate(function () {
        rec.child.stderr.emit('data', '404 model_not_found');
        rec.child.emit('close', 1);
      });
    });

    const res = await failover.engage(
      ctx,
      { from: 'gmail', manual: true },
      { fetch: gwFetch, keysmithConfig: ksPath, spawn: failSp.spawn, nowMs: 1700003000000 },
    );
    assert.strictEqual(res.ok, false);
    assert.strictEqual(fs.readFileSync(ctx.claudeSettingsPath, 'utf8'), originalBytes);
    assert.strictEqual(
      fs.statSync(ctx.claudeSettingsPath).mode & 0o777,
      0o644,
      'settings.json mode restored to 0644 after rollback',
    );
  },
);

test('A5: failed engage records .failover-engage-fail.json backoff, skips non-manual ticks without probing or re-notifying, manual bypasses, class change re-notifies', async function () {
  const ctx = makeCtx();
  loginAccount(ctx, 'alice@example.com', 'u1', FAKE_OAUTH_TOK);
  core.addCurrent(ctx);
  const { ksPath, gwFetch } = setupGateway(ctx);

  let currentFailureStderr = '404 model_not_found: claude-failover';
  const sp = makeFakeSpawn(function (rec) {
    setImmediate(function () {
      rec.child.stderr.emit('data', currentFailureStderr);
      rec.child.emit('close', 1);
    });
  });

  const notes = [];
  let nowMs = Date.UTC(2026, 10, 14, 15, 0, 0);

  function makeTickFailoverAdapter() {
    return {
      enabled: true,
      state: () => failover.state(ctx),
      engage: (info) =>
        failover.engage(ctx, info, {
          fetch: gwFetch,
          keysmithConfig: ksPath,
          spawn: sp.spawn,
          notify: async (ev, msg) => notes.push({ ev, msg }),
          nowMs,
        }),
      release: (info) => failover.release(ctx, info, { nowMs }),
    };
  }

  const exhaustedUsageFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ five_hour: { utilization: 99 } }),
  });

  // 3 consecutive ticks (2 min apart) with a failing probe -> exactly 1 probe spawn and 1 notification.
  const t1 = await autosw.tick(ctx, {
    nowMs,
    cacheTtlMs: 0,
    fetch: exhaustedUsageFetch,
    failover: makeTickFailoverAdapter(),
  });
  assert.strictEqual(t1.state, 'no-candidate');
  assert.strictEqual(sp.calls.length, 1, '1st tick spawned probe once');
  assert.strictEqual(notes.length, 1, '1st tick notified once');
  assertPrivateMode(failover.engageFailPath(ctx), '.failover-engage-fail.json');
  assert.strictEqual(failover.readEngageFail(ctx).count, 1);
  assert.strictEqual(failover.readEngageFail(ctx).class, 'model-not-found');

  nowMs += 2 * 60 * 1000;
  const t2 = await autosw.tick(ctx, {
    nowMs,
    cacheTtlMs: 0,
    fetch: exhaustedUsageFetch,
    failover: makeTickFailoverAdapter(),
  });
  assert.strictEqual(t2.state, 'no-candidate');
  assert.match(t2.failoverError, /^engage failed at .* \(model-not-found\); next try after /);
  assert.strictEqual(sp.calls.length, 1, '2nd tick skipped probe during backoff');
  assert.strictEqual(notes.length, 1, '2nd tick did not re-notify');

  nowMs += 2 * 60 * 1000;
  const t3 = await autosw.tick(ctx, {
    nowMs,
    cacheTtlMs: 0,
    fetch: exhaustedUsageFetch,
    failover: makeTickFailoverAdapter(),
  });
  assert.strictEqual(t3.state, 'no-candidate');
  assert.strictEqual(sp.calls.length, 1, '3rd tick skipped probe during backoff');
  assert.strictEqual(notes.length, 1, '3rd tick did not re-notify');

  // Advance nowMs past the 30m backoff -> a second attempt runs; same failure class does NOT re-notify.
  nowMs += 30 * 60 * 1000;
  await autosw.tick(ctx, {
    nowMs,
    cacheTtlMs: 0,
    fetch: exhaustedUsageFetch,
    failover: makeTickFailoverAdapter(),
  });
  assert.strictEqual(sp.calls.length, 2, 'probe spawned again after backoff elapsed');
  assert.strictEqual(notes.length, 1, 'same failure class (model-not-found) does not re-notify');
  assert.strictEqual(failover.readEngageFail(ctx).count, 2);

  // Manual engage bypasses the backoff; changing failure class to quota re-notifies and caps backoff at 6h.
  nowMs += 60 * 1000; // only 1 min into backoff
  currentFailureStderr = 'Error: quota reached on leg. Resets in 48h';
  const manualRes = await failover.engage(
    ctx,
    { from: 'alice', manual: true },
    {
      fetch: gwFetch,
      keysmithConfig: ksPath,
      spawn: sp.spawn,
      notify: async (ev, msg) => notes.push({ ev, msg }),
      nowMs,
    },
  );
  assert.strictEqual(manualRes.ok, false);
  assert.strictEqual(sp.calls.length, 3, 'manual engage bypassed backoff');
  assert.strictEqual(notes.length, 2, 'class change (model-not-found -> quota) re-notified');
  assert.strictEqual(failover.readEngageFail(ctx).class, 'quota');

  // Quota with resetAt 48h in the future is capped at 6h backoff.
  const skippedQuota = await failover.engage(
    ctx,
    { from: 'alice' },
    { fetch: gwFetch, keysmithConfig: ksPath, spawn: sp.spawn, nowMs: nowMs + 2 * 3600 * 1000 },
  );
  assert.strictEqual(skippedQuota.ok, false);
  assert.strictEqual(skippedQuota.backoff, true);
  const expectedCapIso = new Date(nowMs + 6 * 3600 * 1000).toISOString();
  assert.ok(skippedQuota.reason.endsWith('next try after ' + expectedCapIso), skippedQuota.reason);

  // Successful engage deletes .failover-engage-fail.json.
  const okSp = okSpawnRecorder();
  const okRes = await failover.engage(
    ctx,
    { from: 'alice', manual: true },
    { fetch: gwFetch, keysmithConfig: ksPath, spawn: okSp.spawn, nowMs: nowMs + 3 * 3600 * 1000 },
  );
  assert.strictEqual(okRes.ok, true);
  assert.strictEqual(fs.existsSync(failover.engageFailPath(ctx)), false, 'deleted on successful engage');
});

test('A6: release() with another provider active leaves settings.json and .active.json untouched; release after engage still cleans', async function () {
  const ctx = makeCtx();
  setupGateway(ctx, {
    models: ['claude-failover', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  });

  // User adds and activates another provider ('openrouter') while failover is NOT engaged.
  ctx.store.setProfile('provider__openrouter', 'sk-or-FAKE-OPENROUTER-KEY-12345');
  provider.add(ctx, 'openrouter', {
    baseUrl: 'https://openrouter.ai/api',
    authScheme: 'bearer',
    compat: 'anthropic',
    models: { default: 'anthropic/claude-sonnet-4' },
  });
  provider.use(ctx, 'openrouter');

  const settingsBefore = fs.readFileSync(ctx.claudeSettingsPath, 'utf8');
  const activeBefore = fs.readFileSync(provider.activePath(ctx), 'utf8');

  const rel = await failover.release(ctx, { by: 'cli', reason: 'turned off by hand' });
  assert.strictEqual(rel.ok, true);
  assert.strictEqual(fs.readFileSync(ctx.claudeSettingsPath, 'utf8'), settingsBefore, 'settings.json bytes unchanged');
  assert.strictEqual(fs.readFileSync(provider.activePath(ctx), 'utf8'), activeBefore, '.active.json unchanged');
  assert.strictEqual(provider.readActive(ctx).name, 'openrouter');

  // Now engage failover on cli-settings and release -> cleans settings.json and .active.json.
  config.set(ctx, 'failover.cliTarget', 'settings');
  const sp = okSpawnRecorder();
  const eng = await failover.engage(
    ctx,
    { from: 'gmail', manual: true },
    {
      fetch: setupGateway(ctx, {
        models: ['claude-failover', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
      }).gwFetch,
      keysmithConfig: writeKeysmithCfg(ctx),
      spawn: sp.spawn,
      nowMs: 1700004000000,
    },
  );
  assert.strictEqual(eng.ok, true);
  assert.strictEqual(provider.readActive(ctx).name, 'keysmith-failover');

  const relAfterEngage = await failover.release(ctx, { by: 'cli', reason: 'turned off by hand' });
  assert.strictEqual(relAfterEngage.ok, true);
  assert.strictEqual(provider.readActive(ctx), null, '.active.json cleaned for failover provider');
  const afterCfg = JSON.parse(fs.readFileSync(ctx.claudeSettingsPath, 'utf8'));
  assert.strictEqual(afterCfg.env, undefined, 'gateway env keys cleaned from settings.json');
});

test('A7: failover on prints surface-accurate message; failover run reports missing .failover-env.json clearly', async function () {
  const ctx = makeCtx();
  const { ksPath, gwFetch } = setupGateway(ctx, {
    models: ['claude-failover', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  });
  const sp = okSpawnRecorder();
  const cliCtx = Object.assign({}, ctx, {
    fetch: gwFetch,
    keysmithConfig: ksPath,
    spawn: sp.spawn,
    nowMs: 1700005000000,
  });

  // 1) `failover on` on cli-launcher prints launcher instructions.
  const onLauncher = await runCliCaptured(['failover', 'on'], cliCtx);
  assert.strictEqual(onLauncher.exitCode, 0);
  assert.match(
    onLauncher.stdout,
    /on \(cli-launcher\) - start work through it with: keyflip failover run \(or keyflip failover resume --last\)/,
  );

  // 2) When engaged on cli-launcher but .failover-env.json is missing, `failover run` reports the exact recovery command.
  fs.unlinkSync(fosurface.envPath(ctx));
  const missingEnvRun = failover.run(ctx, ['-p', 'hi'], {});
  assert.strictEqual(missingEnvRun.ok, false);
  assert.strictEqual(
    missingEnvRun.error,
    '.failover-env.json is missing; run: keyflip failover off && keyflip failover on',
  );

  // 3) `failover on` on cli-settings keeps the old wording.
  await failover.release(ctx, { by: 'test' });
  config.set(ctx, 'failover.cliTarget', 'settings');
  const onSettings = await runCliCaptured(['failover', 'on'], cliCtx);
  assert.strictEqual(onSettings.exitCode, 0);
  assert.match(onSettings.stdout, /on \(cli-settings\) — Claude Code now uses the gateway\./);
});

test('B1: migratePendingGateway drops gateway-* immediately, defers restore while Desktop runs, and tick restores once Desktop closes', async function () {
  const ctx = makeCtx({ platform: 'darwin', appDataDir: true });
  logmod.init(ctx.configDir, false);
  loginAccount(ctx, 'alice@example.com', 'u1', FAKE_OAUTH_TOK);
  core.addCurrent(ctx);

  const mainCfg = path.join(ctx.appDataDir, 'claude_desktop_config.json');
  const prof = path.join(ctx.appDataDir, 'configLibrary', desktopgw.KEYFLIP_PROFILE_ID + '.json');
  const gwMeta = path.join(ctx.configDir, '.keyflip-gateway.json');
  fs.mkdirSync(path.dirname(prof), { recursive: true });
  const runningBytes = '{\n  "deploymentMode": "3p",\n  "preferences": { "liveEdit": 1 }\n}\n';
  fs.writeFileSync(mainCfg, runningBytes);
  fs.writeFileSync(prof, JSON.stringify({ id: desktopgw.KEYFLIP_PROFILE_ID }));
  fs.writeFileSync(gwMeta, JSON.stringify({ provider: 'keysmith-failover', previousDeploymentMode: '1p' }));

  fs.writeFileSync(
    path.join(ctx.configDir, dr.PENDING_FILE),
    JSON.stringify({
      actions: [
        { kind: 'gateway-off', target: null, reason: 'legacy' },
        { kind: 'account', target: 'alice', email: 'alice@example.com', reason: 'autoswitch' },
      ],
      since: 1700000090000,
      notified: false,
    }),
  );

  let desktopRunning = true;
  const tickFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ five_hour: { utilization: 10 } }),
  });

  // Tick 1: Desktop is running -> gateway-off dropped, account kept, restore deferred, config file untouched.
  const tick1 = await autosw.tick(ctx, {
    nowMs: 1700000091000,
    cacheTtlMs: 0,
    isDesktopRunning: () => desktopRunning,
    fetch: tickFetch,
  });
  assert.ok(tick1.migratedGateway);
  assert.strictEqual(tick1.migratedGateway.migrated, true);
  assert.strictEqual(tick1.migratedGateway.restored, false);
  assert.strictEqual(tick1.migratedGateway.deferred, true);
  assert.deepStrictEqual(tick1.migratedGateway.removed, ['gateway-off']);
  assert.strictEqual(tick1.migratedGateway.kept, 1);
  assert.strictEqual(fs.readFileSync(mainCfg, 'utf8'), runningBytes, 'running Desktop config must not be rewritten');
  assert.strictEqual(fs.existsSync(prof), true);
  assert.strictEqual(fs.existsSync(gwMeta), true);

  const pendingAfterTick1 = dr.readPending(ctx);
  assert.ok(pendingAfterTick1);
  assert.deepStrictEqual(
    pendingAfterTick1.actions.map((a) => a.kind + ':' + a.target),
    ['account:alice'],
  );

  // Tick 2: Desktop closes -> hasLeftovers re-check restores Desktop config and deletes leftovers.
  desktopRunning = false;
  await autosw.tick(ctx, {
    nowMs: 1700000092000,
    cacheTtlMs: 0,
    isDesktopRunning: () => desktopRunning,
    fetch: tickFetch,
  });
  const afterClose = JSON.parse(fs.readFileSync(mainCfg, 'utf8'));
  assert.strictEqual(afterClose.deploymentMode, '1p');
  assert.deepStrictEqual(afterClose.preferences, { liveEdit: 1 });
  assert.strictEqual(fs.existsSync(prof), false);
  assert.strictEqual(fs.existsSync(gwMeta), false);
});

test('B1: failover.release step 3 defers desktopgw.restore into deferred[] when Desktop is running and restores when closed', async function () {
  const ctx = makeCtx({ platform: 'darwin', appDataDir: true });
  const { ksPath, gwFetch } = setupGateway(ctx);
  const sp = okSpawnRecorder();
  await failover.engage(
    ctx,
    { from: 'gmail', manual: true },
    { fetch: gwFetch, keysmithConfig: ksPath, spawn: sp.spawn, nowMs: 1700000095000 },
  );

  const mainCfg = path.join(ctx.appDataDir, 'claude_desktop_config.json');
  const prof = path.join(ctx.appDataDir, 'configLibrary', desktopgw.KEYFLIP_PROFILE_ID + '.json');
  const gwMeta = path.join(ctx.configDir, '.keyflip-gateway.json');
  fs.mkdirSync(path.dirname(prof), { recursive: true });
  const runningBytes = '{\n  "deploymentMode": "3p",\n  "enterpriseConfig": { "activeConfigId": "' + desktopgw.KEYFLIP_PROFILE_ID + '" },\n  "preferences": { "sidebar": true }\n}\n';
  fs.writeFileSync(mainCfg, runningBytes);
  fs.writeFileSync(prof, JSON.stringify({ id: desktopgw.KEYFLIP_PROFILE_ID }));
  fs.writeFileSync(gwMeta, JSON.stringify({ provider: 'keysmith-failover', previousDeploymentMode: '1p' }));

  // Release while Desktop is running: release succeeds, desktopgw is deferred (not failed), Desktop files untouched.
  const relRunning = await failover.release(
    ctx,
    { by: 'cli', reason: 'turned off while Desktop open' },
    { isDesktopRunning: () => true },
  );
  assert.strictEqual(relRunning.ok, true);
  assert.deepStrictEqual(relRunning.failed, []);
  assert.ok(Array.isArray(relRunning.deferred));
  assert.ok(relRunning.deferred.some((d) => /desktopgw deferred.*Desktop is running/i.test(d)));
  assert.strictEqual(failover.state(ctx), null, 'CLI failover state still released');
  assert.strictEqual(fs.readFileSync(mainCfg, 'utf8'), runningBytes, 'Desktop config untouched while running');
  assert.strictEqual(fs.existsSync(prof), true);
  assert.strictEqual(fs.existsSync(gwMeta), true);

  // Release once Desktop is closed: desktopgw.restore runs and cleans up.
  const relClosed = await failover.release(
    ctx,
    { by: 'cli', reason: 'turned off after Desktop closed' },
    { isDesktopRunning: () => false },
  );
  assert.strictEqual(relClosed.ok, true);
  assert.deepStrictEqual(relClosed.failed, []);
  assert.deepStrictEqual(relClosed.deferred, []);
  const afterCfg = JSON.parse(fs.readFileSync(mainCfg, 'utf8'));
  assert.strictEqual(afterCfg.deploymentMode, '1p');
  assert.strictEqual(afterCfg.enterpriseConfig, undefined);
  assert.deepStrictEqual(afterCfg.preferences, { sidebar: true });
  assert.strictEqual(fs.existsSync(prof), false);
  assert.strictEqual(fs.existsSync(gwMeta), false);
});

test('B2: desktopgw.hasLeftovers and restore leave foreign 3p configs byte-identical and clean each of the 3 keyflip-owned signals', function () {
  // 1) Foreign '3p' + foreign activeConfigId (and bare '3p' in sibling dir): hasLeftovers false, restore leaves bytes identical.
  const ctxForeign = makeCtx({ platform: 'darwin', appDataDir: true });
  const mainDir = ctxForeign.appDataDir;
  const dir3p = ctxForeign.appDataDir + '-3p';
  fs.mkdirSync(mainDir, { recursive: true });
  fs.mkdirSync(dir3p, { recursive: true });
  const mainCfg = path.join(mainDir, 'claude_desktop_config.json');
  const sibCfg = path.join(dir3p, 'claude_desktop_config.json');
  const foreignMainBytes =
    '{\n  "z_order": 1,\n  "deploymentMode": "3p",\n  "enterpriseConfig": {\n    "activeConfigId": "my-bedrock-profile",\n    "region": "us-east-1"\n  }\n}';
  const foreignSibBytes = '{\n  "deploymentMode": "3p",\n  "preferences": { "theme": "dark" }\n}';
  fs.writeFileSync(mainCfg, foreignMainBytes);
  fs.writeFileSync(sibCfg, foreignSibBytes);

  assert.strictEqual(desktopgw.hasLeftovers(ctxForeign), false, 'foreign 3p must not be flagged as leftover');
  const rForeign = desktopgw.restore(ctxForeign);
  assert.strictEqual(rForeign.restored, false);
  assert.deepStrictEqual(rForeign.cleaned, []);
  assert.strictEqual(fs.readFileSync(mainCfg, 'utf8'), foreignMainBytes, 'foreign main config left byte-identical');
  assert.strictEqual(fs.readFileSync(sibCfg, 'utf8'), foreignSibBytes, 'foreign sibling 3p config left byte-identical');

  // Even if .keyflip-gateway.json exists, a dir whose 3p points at a foreign activeConfigId is never touched.
  fs.writeFileSync(path.join(ctxForeign.configDir, desktopgw.META), JSON.stringify({ provider: 'gw' }));
  assert.strictEqual(desktopgw.hasLeftovers(ctxForeign), true);
  desktopgw.restore(ctxForeign);
  assert.strictEqual(
    fs.readFileSync(mainCfg, 'utf8'),
    foreignMainBytes,
    'foreign activeConfigId never touched even when .keyflip-gateway.json exists',
  );
  assert.strictEqual(fs.existsSync(path.join(ctxForeign.configDir, desktopgw.META)), false);

  // 2) Signal 1: .keyflip-gateway.json exists.
  const ctxSig1 = makeCtx({ platform: 'darwin', appDataDir: true });
  fs.mkdirSync(ctxSig1.appDataDir, { recursive: true });
  const cfg1 = path.join(ctxSig1.appDataDir, 'claude_desktop_config.json');
  fs.writeFileSync(cfg1, JSON.stringify({ deploymentMode: '3p', preferences: { a: 1 } }));
  fs.writeFileSync(
    path.join(ctxSig1.configDir, desktopgw.META),
    JSON.stringify({ provider: 'gw', previousDeploymentMode: '1p' }),
  );
  assert.strictEqual(desktopgw.hasLeftovers(ctxSig1), true);
  const r1 = desktopgw.restore(ctxSig1);
  assert.strictEqual(r1.restored, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(cfg1, 'utf8')).deploymentMode, '1p');
  assert.strictEqual(fs.existsSync(path.join(ctxSig1.configDir, desktopgw.META)), false);

  // 3) Signal 2: activeConfigId matches /^keyflip-gateway-/.
  const ctxSig2 = makeCtx({ platform: 'darwin', appDataDir: true });
  fs.mkdirSync(ctxSig2.appDataDir, { recursive: true });
  const cfg2 = path.join(ctxSig2.appDataDir, 'claude_desktop_config.json');
  fs.writeFileSync(
    cfg2,
    JSON.stringify({
      deploymentMode: '3p',
      enterpriseConfig: { activeConfigId: 'keyflip-gateway-custom' },
      preferences: { b: 2 },
    }),
  );
  assert.strictEqual(desktopgw.hasLeftovers(ctxSig2), true);
  const r2 = desktopgw.restore(ctxSig2);
  assert.strictEqual(r2.restored, true);
  const after2 = JSON.parse(fs.readFileSync(cfg2, 'utf8'));
  assert.strictEqual('deploymentMode' in after2, false);
  assert.strictEqual('enterpriseConfig' in after2, false);
  assert.deepStrictEqual(after2.preferences, { b: 2 });

  // 4) Signal 3: keyflip-gateway-*.json profile file present in configLibrary.
  const ctxSig3 = makeCtx({ platform: 'darwin', appDataDir: true });
  const lib3 = path.join(ctxSig3.appDataDir, 'configLibrary');
  fs.mkdirSync(lib3, { recursive: true });
  const cfg3 = path.join(ctxSig3.appDataDir, 'claude_desktop_config.json');
  const pf3 = path.join(lib3, 'keyflip-gateway-orphan.json');
  fs.writeFileSync(cfg3, JSON.stringify({ deploymentMode: '3p', preferences: { c: 3 } }));
  fs.writeFileSync(pf3, JSON.stringify({ id: 'keyflip-gateway-orphan' }));
  assert.strictEqual(desktopgw.hasLeftovers(ctxSig3), true);
  const r3 = desktopgw.restore(ctxSig3);
  assert.strictEqual(r3.restored, true);
  const after3 = JSON.parse(fs.readFileSync(cfg3, 'utf8'));
  assert.strictEqual('deploymentMode' in after3, false);
  assert.deepStrictEqual(after3.preferences, { c: 3 });
  assert.strictEqual(fs.existsSync(pf3), false);
});
