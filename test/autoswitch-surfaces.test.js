// The autoswitch surfaces nothing used to test: the MCP tools (keyflip_autoswitch_tick,
// keyflip_autoswitch_service) and the CLI `autoswitch --once` the background service runs.
// Everything is offline: injected runners (ctx.run), injected fetch (ctx.fetch), temp homes.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { makeCtx, writeClaude } from './helpers.js';
import * as _mcp from '../src/mcp.js';
import * as core from '../src/core.js';
import * as svc from '../src/autoswitchservice.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');

function tool(n) {
  return _mcp.TOOLS.find(function (t) {
    return t.name === n;
  });
}
function login(ctx, email, uid, tok) {
  writeClaude(ctx, { oauthAccount: { emailAddress: email }, userID: uid });
  ctx.store.setLive(JSON.stringify({ claudeAiOauth: { accessToken: tok } }));
}
function usageFetch(pctByToken) {
  return async function (url, opts) {
    const tok = opts.headers.Authorization.replace('Bearer ', '');
    const pct = pctByToken[tok];
    if (pct === undefined) return { ok: false, status: 401, headers: { get: () => null } };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async function () {
        return { five_hour: { utilization: pct } };
      },
    };
  };
}
function script() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kf-svc-bin-')));
  const p = path.join(dir, 'keyflip');
  fs.writeFileSync(p, '#!/usr/bin/env node\n', { mode: 0o755 });
  return p;
}
function fakeRun(state) {
  return function (cmd, args) {
    (state.calls = state.calls || []).push(cmd + ' ' + (args || []).join(' '));
    if (cmd === 'which') return { code: 0, stdout: state.which + '\n' };
    if (cmd === 'launchctl' && args[0] === 'list') return { code: 0, stdout: state.launchctl || '' };
    return { code: 0, stdout: '' };
  };
}

test('MCP keyflip_autoswitch_service: status, confirm gate, install writes an absolute node job', async function () {
  const t = tool('keyflip_autoswitch_service');
  const ctx = makeCtx({ platform: 'darwin' });
  const state = { which: script() };
  ctx.run = fakeRun(state);
  const st = await t.run(ctx, { action: 'status' });
  assert.strictEqual(st.autoswitchService.installed, false);
  await assert.rejects(function () {
    return t.run(ctx, { action: 'install' });
  }, /confirmation required/);
  const r = await t.run(ctx, { action: 'install', confirm: true, threshold: 95 });
  assert.strictEqual(r.installed.ok, true);
  const argv = svc.plistArgs(fs.readFileSync(svc.plistPath(ctx.home), 'utf8'));
  assert.strictEqual(argv[0], fs.realpathSync(process.execPath), 'node is the program');
  assert.strictEqual(argv[1], state.which, 'the script is argv[1]');
  assert.ok(argv.indexOf('95') !== -1);
  state.launchctl = '-\t127\tcom.keyflip.autoswitch\n';
  const broken = await t.run(ctx, { action: 'status' });
  assert.strictEqual(broken.autoswitchService.healthy, false);
  assert.strictEqual(broken.autoswitchService.lastExit, 127);
  const rm = await t.run(ctx, { action: 'remove', confirm: true });
  assert.strictEqual(rm.removed.existed, true);
  assert.ok(
    state.calls.every(function (c) {
      return c.indexOf('launchctl') !== 0 || /^launchctl (list|load|unload)/.test(c);
    }),
  );
});

test('MCP keyflip_autoswitch_tick: needs confirm, then switches over the threshold', async function () {
  const t = tool('keyflip_autoswitch_tick');
  const ctx = makeCtx();
  login(ctx, 'a@x.com', 'u1', 'TA');
  core.addCurrent(ctx);
  login(ctx, 'b@x.com', 'u2', 'TB');
  core.addCurrent(ctx); // b active
  ctx.fetch = usageFetch({ TB: 97, TA: 10 });
  await assert.rejects(function () {
    return t.run(ctx, { threshold: 95 });
  }, /confirmation required/);
  const r = await t.run(ctx, { threshold: 95, confirm: true });
  assert.strictEqual(r.state, 'switched');
  assert.strictEqual(r.switchedTo.name, 'a');
  assert.strictEqual(core.currentEmail(ctx), 'a@x.com');
});

function cli(home, args) {
  return spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      KEYFLIP_CONFIG_DIR: path.join(home, '.config', 'keyflip'),
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      KEYFLIP_TEST_CLAUDE: 'stopped',
      KEYFLIP_APP_BUNDLE: path.join(home, 'no-such-Claude.app'),
    }),
  });
}

test('CLI `autoswitch --once -y` (what the service runs) completes one tick and exits 0', function () {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-once-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}'); // file backend, no keychain
  const r = cli(home, ['autoswitch', '--once', '-y']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/no active CLI account/.test(r.stdout), r.stdout);
});

test('CLI `autoswitch status` on a home without the service says not installed (exit 0)', function () {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-status-'));
  const r = cli(home, ['autoswitch', 'status', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.autoswitchService.installed, false);
});

// ---- P3: the switch threshold is 95% everywhere it is not given explicitly ----
test('P3: the default threshold is 95 in config, the tick, the MCP tool and the service', async function () {
  const _config = await import('../src/config.js');
  const ctx = makeCtx({ platform: 'darwin' });
  assert.strictEqual(_config.get(ctx, 'autoswitch.threshold'), 95);
  // tick with no threshold: 94% used stays, 95% switches
  login(ctx, 'a@x.com', 'u1', 'TA');
  core.addCurrent(ctx);
  login(ctx, 'b@x.com', 'u2', 'TB');
  core.addCurrent(ctx);
  const _autosw = await import('../src/autoswitch.js');
  const below = await _autosw.tick(ctx, { fetch: usageFetch({ TB: 94, TA: 10 }), nowMs: 1, cacheTtlMs: 0 });
  assert.strictEqual(below.state, 'below');
  const over = await _autosw.tick(ctx, { fetch: usageFetch({ TB: 95, TA: 10 }), nowMs: 2, cacheTtlMs: 0 });
  assert.strictEqual(over.state, 'switched');
  // the MCP service install writes --threshold 95 when none is given
  const state = { which: script() };
  ctx.run = fakeRun(state);
  await tool('keyflip_autoswitch_service').run(ctx, { action: 'install', confirm: true });
  const argv = svc.plistArgs(fs.readFileSync(svc.plistPath(ctx.home), 'utf8'));
  assert.strictEqual(argv[argv.indexOf('--threshold') + 1], '95');
  // and the MCP tick, without a threshold, uses it too
  ctx.fetch = usageFetch({ TA: 94, TB: 96 }); // a is active now at 94%; b (the primary) has not recovered
  const r = await tool('keyflip_autoswitch_tick').run(ctx, { confirm: true });
  assert.strictEqual(r.state, 'below');
});
