// P5: Claude Desktop restarts to pick up a new account/gateway ONLY when idle, with a notification.
// Everything is injected: the idle/busy detector, the app's running state, quit/open, notify and
// the per-action apply. No test ever quits, opens or inspects the real app.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { makeCtx, writeClaude } from './helpers.js';
import * as dr from '../src/desktoprestart.js';
import * as core from '../src/core.js';
import * as failover from '../src/failover.js';
import * as _mcp from '../src/mcp.js';

function app(opts) {
  opts = opts || {};
  const log = [];
  let running = opts.running !== false;
  const quitWorks = opts.quitWorks !== false;
  return {
    log: log,
    deps: {
      isRunning: () => running,
      quit: () => {
        log.push('quit');
        if (quitWorks) running = false;
      },
      open: () => {
        log.push('open');
        running = true;
      },
      notify: async (event, msg) => {
        log.push('notify:' + msg);
      },
      detector: {
        name: 'fake',
        check: () => (opts.busy ? { busy: true, reason: opts.busy } : { busy: false, reason: 'idle' }),
      },
      kinds: {
        account: (ctx, target) => {
          log.push('apply:account:' + target + ':' + (running ? 'RUNNING' : 'closed'));
          return opts.applyFails ? { ok: false, reason: 'no saved desktop login' } : { ok: true };
        },
        'gateway-on': (ctx, target) => {
          log.push('apply:gateway-on:' + target + ':' + (running ? 'RUNNING' : 'closed'));
          return { ok: true };
        },
        'gateway-off': () => {
          log.push('apply:gateway-off:' + (running ? 'RUNNING' : 'closed'));
          return { ok: true };
        },
      },
      waitMs: 30,
      pollMs: 5,
    },
  };
}

test('nothing pending -> nothing happens', async function () {
  const a = app();
  const r = await dr.processPending(makeCtx(), a.deps);
  assert.strictEqual(r.state, 'none');
  assert.deepStrictEqual(a.log, []);
});

test('a CLOSED app is switched in place: no quit, no open, no restart', async function () {
  const ctx = makeCtx();
  const a = app({ running: false });
  dr.request(ctx, { kind: 'account', target: 'gmail' });
  const r = await dr.processPending(ctx, a.deps);
  assert.strictEqual(r.state, 'applied');
  assert.deepStrictEqual(a.log, ['apply:account:gmail:closed']);
  assert.strictEqual(dr.readPending(ctx), null);
});

test('BUSY (a streaming turn / a working session): deferred, notified ONCE, never quit', async function () {
  const ctx = makeCtx();
  const a = app({ busy: 'Desktop Claude Code session(s) working: proj (busy)' });
  dr.request(ctx, { kind: 'account', target: 'gmail' });
  const r1 = await dr.processPending(ctx, a.deps);
  const r2 = await dr.processPending(ctx, a.deps);
  assert.strictEqual(r1.state, 'deferred');
  assert.strictEqual(r2.state, 'deferred');
  assert.ok(/working/.test(r1.reason));
  assert.strictEqual(a.log.filter((l) => l === 'quit').length, 0, 'never quit while busy');
  assert.strictEqual(a.log.filter((l) => l.indexOf('notify:') === 0).length, 1, 'one notification, not one per tick');
  assert.ok(/as soon as it is idle/.test(a.log[0]));
  assert.ok(dr.readPending(ctx), 'still pending');
});

test('IDLE: notify, quit, apply while CLOSED, reopen, clear', async function () {
  const ctx = makeCtx();
  const a = app();
  dr.request(ctx, { kind: 'account', target: 'gmail', email: 'me@gmail.com' });
  const r = await dr.processPending(ctx, a.deps);
  assert.strictEqual(r.state, 'restarted');
  assert.deepStrictEqual(
    a.log.map((l) => l.replace(/^notify:.*$/, 'notify')),
    ['notify', 'quit', 'apply:account:gmail:closed', 'open'],
  );
  assert.ok(/Restarting Claude Desktop to switch to me@gmail\.com/.test(a.log[0]));
  assert.strictEqual(dr.readPending(ctx), null);
});

test('one restart carries the gateway AND the account change, gateway first', async function () {
  const ctx = makeCtx();
  const a = app();
  dr.request(ctx, { kind: 'account', target: 'yahoo' });
  dr.request(ctx, { kind: 'gateway-off' });
  const r = await dr.processPending(ctx, a.deps);
  assert.strictEqual(r.state, 'restarted');
  assert.deepStrictEqual(
    a.log.filter((l) => l.indexOf('apply:') === 0),
    ['apply:gateway-off:closed', 'apply:account:yahoo:closed'],
  );
});

test('newest wins per group; gateway-on then gateway-off before a restart cancel out', function () {
  const ctx = makeCtx();
  dr.request(ctx, { kind: 'account', target: 'a' });
  dr.request(ctx, { kind: 'account', target: 'b' });
  assert.deepStrictEqual(dr.readPending(ctx).actions, [{ kind: 'account', target: 'b' }]);
  dr.request(ctx, { kind: 'gateway-on', target: 'keysmith-failover' });
  dr.request(ctx, { kind: 'gateway-off' });
  assert.deepStrictEqual(dr.readPending(ctx).actions, [{ kind: 'account', target: 'b' }]);
});

test('an app that will not quit is left alone: nothing applied, not reopened, still pending', async function () {
  const ctx = makeCtx();
  const a = app({ quitWorks: false });
  dr.request(ctx, { kind: 'gateway-on', target: 'keysmith-failover' });
  const r = await dr.processPending(ctx, a.deps);
  assert.strictEqual(r.state, 'quit-failed');
  assert.ok(!a.log.some((l) => l.indexOf('apply:') === 0), 'never applied under a running app');
  assert.ok(!a.log.includes('open'));
  assert.ok(dr.readPending(ctx));
});

test('REGRESSION: an app that will not quit is asked again only after a while, and the user told ONCE', async function () {
  const ctx = makeCtx();
  const a = app({ quitWorks: false });
  const t0 = 1800000000000;
  dr.request(ctx, { kind: 'gateway-on', target: 'keysmith-failover' }, { nowMs: t0 });
  const r1 = await dr.processPending(ctx, Object.assign({}, a.deps, { nowMs: t0 }));
  const r2 = await dr.processPending(ctx, Object.assign({}, a.deps, { nowMs: t0 + 120000 }));
  const r3 = await dr.processPending(ctx, Object.assign({}, a.deps, { nowMs: t0 + 240000 }));
  assert.strictEqual(r1.state, 'quit-failed');
  assert.strictEqual(r2.state, 'deferred');
  assert.strictEqual(r3.state, 'deferred');
  assert.strictEqual(a.log.filter((l) => l === 'quit').length, 1, 'one quit attempt, not one per tick');
  assert.strictEqual(a.log.filter((l) => /^notify:/.test(l)).length, 2, '"restarting" + "did not quit", once');
  const r4 = await dr.processPending(ctx, Object.assign({}, a.deps, { nowMs: t0 + 31 * 60 * 1000 }));
  assert.strictEqual(r4.state, 'quit-failed', 'tried again after the back-off');
});

test('REGRESSION: helpers and keyflip clones are not "the app" — only the main executable is', function () {
  const ps = [
    ' 101 /Applications/Claude.app/Contents/MacOS/Claude',
    ' 102 /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer',
    ' 103 /Users/x/.keyflip-instances/claude/work/Claude.app/Contents/MacOS/Claude --user-data-dir=/Users/x/.keyflip-instances/claude/work/data',
    ' 104 /Applications/Claude.app/Contents/Resources/app.asar.unpacked/claude-code/claude --resume',
  ].join('\n');
  const run = () => ({ code: 0, stdout: ps });
  const ctx = { platform: 'darwin', instancesBase: '/Users/x/.keyflip-instances' };
  assert.deepStrictEqual(dr.desktopProcesses(ctx, run), { main: [101], instances: [103] });
  const quitDone = () => ({ code: 0, stdout: ps.split('\n').slice(1).join('\n') });
  assert.deepStrictEqual(dr.desktopProcesses(ctx, quitDone).main, [], 'a lingering helper is not a running app');
});

test('REGRESSION: a pending account restart follows the CLI NOW (retargeted, or dropped), and expires', async function () {
  const ctx = makeCtx();
  const a = app();
  dr.request(ctx, { kind: 'account', target: 'b' }, { nowMs: Date.now() });
  // the user switched the CLI to "a" by hand since; a has a desktop login -> Desktop follows a
  const r = await dr.processPending(
    ctx,
    Object.assign({}, a.deps, { currentCli: () => 'a', hasDesktopLogin: () => true, desktopAccount: () => null }),
  );
  assert.strictEqual(r.state, 'restarted');
  assert.ok(a.log.includes('apply:account:a:closed'), a.log.join(' | '));
  assert.ok(!a.log.some((l) => l.indexOf('apply:account:b') === 0), 'the stale target is never applied');
  // CLI moved to an account with no desktop login: the record is dropped, nothing restarts
  const b = app();
  dr.request(ctx, { kind: 'account', target: 'b' }, { nowMs: Date.now() });
  const r2 = await dr.processPending(
    ctx,
    Object.assign({}, b.deps, { currentCli: () => 'c', hasDesktopLogin: () => false }),
  );
  assert.strictEqual(r2.state, 'none');
  assert.ok(!b.log.includes('quit'));
  assert.strictEqual(dr.readPending(ctx), null);
  // Desktop is already on the target (a manual switch moved it): no restart
  const c = app();
  dr.request(ctx, { kind: 'account', target: 'b' }, { nowMs: Date.now() });
  const r3 = await dr.processPending(
    ctx,
    Object.assign({}, c.deps, { currentCli: () => 'b', desktopAccount: () => 'b' }),
  );
  assert.strictEqual(r3.state, 'none');
  assert.ok(!c.log.includes('quit'));
  // and an old record is dropped, not replayed
  const d = app();
  dr.request(ctx, { kind: 'account', target: 'b' }, { nowMs: 1000 });
  const r4 = await dr.processPending(ctx, Object.assign({}, d.deps, { nowMs: 1000 + 13 * 3600 * 1000 }));
  assert.strictEqual(r4.state, 'none');
  assert.ok(!d.log.includes('quit'));
});

test('a running keyflip Claude clone defers the restart (quit-by-name could hit the clone)', async function () {
  const ctx = makeCtx({ platform: 'darwin' });
  ctx.instancesBase = '/Users/x/.keyflip-instances';
  const a = app();
  delete a.deps.isRunning;
  const ps = [
    ' 101 /Applications/Claude.app/Contents/MacOS/Claude',
    ' 103 /Users/x/.keyflip-instances/claude/w/Claude.app/Contents/MacOS/Claude',
  ].join('\n');
  a.deps.run = () => ({ code: 0, stdout: ps });
  a.deps.desktopAccount = () => null;
  dr.request(ctx, { kind: 'gateway-on', target: 'keysmith-failover' });
  const saved = process.env.KEYFLIP_TEST_CLAUDE;
  delete process.env.KEYFLIP_TEST_CLAUDE;
  try {
    const r = await dr.processPending(ctx, a.deps);
    assert.strictEqual(r.state, 'deferred');
    assert.ok(/keyflip Claude instance is running/.test(r.reason));
    assert.ok(!a.log.includes('quit'));
  } finally {
    if (saved !== undefined) process.env.KEYFLIP_TEST_CLAUDE = saved;
  }
});

test('a failed apply still reopens the app, says so, and is not retried every tick', async function () {
  const ctx = makeCtx();
  const a = app({ applyFails: true });
  dr.request(ctx, { kind: 'account', target: 'gmail' });
  const r = await dr.processPending(ctx, a.deps);
  assert.strictEqual(r.state, 'apply-failed');
  assert.ok(a.log.includes('open'));
  assert.ok(a.log.some((l) => /could not switch to gmail/.test(l)));
  assert.strictEqual(dr.readPending(ctx), null);
});

test('auto-restart off: the user is told once, the app is never quit', async function () {
  const ctx = makeCtx();
  const a = app();
  dr.request(ctx, { kind: 'account', target: 'gmail' });
  const deps = Object.assign({}, a.deps, { enabled: false });
  assert.strictEqual((await dr.processPending(ctx, deps)).state, 'disabled');
  assert.strictEqual((await dr.processPending(ctx, deps)).state, 'disabled');
  assert.ok(!a.log.includes('quit'));
  assert.strictEqual(a.log.filter((l) => l.indexOf('notify:') === 0).length, 1);
});

// ---- the detectors (the interface's default implementation) ----

function sessionFile(ctx, pid, body) {
  const dir = path.join(ctx.home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, pid + '.json'), JSON.stringify(Object.assign({ pid: pid }, body)));
}

test('sessions detector: a Desktop session that is busy/waiting blocks; idle, CLI or dead ones do not', function () {
  const ctx = makeCtx();
  const alive = (pid) => pid !== 999;
  const d = dr.sessionsDetector({ pidAlive: alive });
  assert.strictEqual(d.check(ctx).busy, false, 'no sessions dir');
  sessionFile(ctx, 101, { entrypoint: 'claude-desktop', status: 'idle', name: 'a' });
  sessionFile(ctx, 102, { entrypoint: 'cli', status: 'busy', name: 'terminal' });
  sessionFile(ctx, 999, { entrypoint: 'claude-desktop', status: 'busy', name: 'dead' });
  assert.strictEqual(d.check(ctx).busy, false);
  sessionFile(ctx, 103, { entrypoint: 'claude-desktop', status: 'waiting', name: 'asks' });
  const r = d.check(ctx);
  assert.strictEqual(r.busy, true);
  assert.ok(/asks \(waiting\)/.test(r.reason));
});

test('activity detector: a Desktop agent-session file written within the quiet window blocks', function () {
  const ctx = makeCtx();
  ctx.appDataDir = path.join(ctx.home, 'AppData');
  const f = path.join(ctx.appDataDir, 'local-agent-mode-sessions', 's1', 'events.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{}');
  const now = Date.now();
  fs.utimesSync(f, new Date(now - 10000), new Date(now - 10000));
  fs.utimesSync(path.dirname(f), new Date(now - 10000), new Date(now - 10000));
  fs.utimesSync(path.dirname(path.dirname(f)), new Date(now - 10000), new Date(now - 10000));
  assert.strictEqual(dr.activityDetector({ quietMs: 60000, nowMs: now }).check(ctx).busy, true);
  assert.strictEqual(dr.activityDetector({ quietMs: 5000, nowMs: now }).check(ctx).busy, false);
});

test('cpu detector: sums the Desktop app tree (not Claude Code CLIs) against the threshold', function () {
  const ctx = makeCtx({ platform: 'darwin' });
  const ps = [
    ' 12.0 /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)',
    ' 14.5 /Applications/Claude.app/Contents/MacOS/Claude',
    ' 90.0 /Users/x/.local/bin/claude --resume',
    ' 80.0 /Applications/Claude.app/Contents/Resources/claude-code/2.1/claude',
  ].join('\n');
  const run = () => ({ code: 0, stdout: ps });
  assert.strictEqual(dr.cpuDetector({ run: run, cpuBusyPct: 20 }).check(ctx).busy, true);
  assert.strictEqual(dr.cpuDetector({ run: run, cpuBusyPct: 40 }).check(ctx).busy, false);
});

test('composite: a detector that cannot read its signal counts as BUSY (never green-lights a restart)', function () {
  const c = dr.composite([
    { name: 'ok', check: () => ({ busy: false, reason: 'idle' }) },
    {
      name: 'broken',
      check: () => {
        throw new Error('EACCES');
      },
    },
  ]);
  const r = c.check(makeCtx());
  assert.strictEqual(r.busy, true);
  assert.ok(/broken check failed/.test(r.reason));
});

// ---- wiring: who asks for a restart, and who takes it ----

test('the DEFAULT detector defers on a busy Desktop session (no injected detector, app never touched)', async function () {
  const ctx = makeCtx({ platform: 'darwin' });
  ctx.appDataDir = path.join(ctx.home, 'AppData');
  sessionFile(ctx, process.pid, { entrypoint: 'claude-desktop', status: 'busy', name: 'this-test' });
  dr.request(ctx, { kind: 'account', target: 'gmail' });
  const log = [];
  const r = await dr.processPending(ctx, {
    isRunning: () => true,
    quit: () => log.push('quit'),
    open: () => log.push('open'),
    notify: async (e, m) => log.push(m),
  });
  assert.strictEqual(r.state, 'deferred');
  assert.ok(/this-test \(busy\)/.test(r.reason), r.reason);
  assert.ok(!log.includes('quit'));
});

test('MCP autoswitch tick only RECORDS the Desktop follow-up (it may run inside Desktop)', async function () {
  const ctx = makeCtx({ platform: 'darwin' });
  ctx.appDataDir = path.join(ctx.home, 'AppData');
  const login = (email, uid, tok) => {
    writeClaude(ctx, { oauthAccount: { emailAddress: email }, userID: uid });
    ctx.store.setLive(JSON.stringify({ claudeAiOauth: { accessToken: tok } }));
  };
  login('a@x.com', 'u1', 'TA');
  core.addCurrent(ctx);
  login('b@x.com', 'u2', 'TB');
  core.addCurrent(ctx);
  // a has a saved desktop login
  fs.mkdirSync(path.join(ctx.configDir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(ctx.configDir, 'app', 'a.json'), '{}');
  ctx.fetch = async (url, o) => {
    const tok = o.headers.Authorization.replace('Bearer ', '');
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ five_hour: { utilization: tok === 'TB' ? 97 : 10 } }),
    };
  };
  const t = _mcp.TOOLS.find((x) => x.name === 'keyflip_autoswitch_tick');
  const r = await t.run(ctx, { confirm: true });
  assert.strictEqual(r.state, 'switched');
  assert.ok(/pending/.test(r.desktopRestart));
  assert.deepStrictEqual(
    dr.readPending(ctx).actions.map((a) => a.kind + ':' + a.target),
    ['account:a'],
  );
});

test('engaging the failover asks Desktop for a gateway-on restart (default path)', async function () {
  const ctx = makeCtx({ platform: 'darwin' });
  ctx.appDataDir = path.join(ctx.home, 'AppData');
  ctx.store.setProfile('provider__keysmith-failover', 'ks_FAKE');
  const provider = await import('../src/provider.js');
  provider.add(ctx, 'keysmith-failover', { baseUrl: 'http://127.0.0.1:8787', models: { default: 'claude-failover' } });
  // keysmith's own alias and its paid leg (keyflip reads them from keysmith's config, never writes them)
  const ksc = path.join(ctx.home, 'keysmith.json');
  fs.writeFileSync(ksc, JSON.stringify({ aliases: { 'claude-failover': ['claude-failover-api/m', 'agy/m'] } }));
  const fetch = async (url) =>
    /\/v1\/keysmith\/usage/.test(url)
      ? {
          ok: true,
          status: 200,
          json: async () => ({ spend: [{ kind: 'adapter', target: 'claude-failover-api', cap: 25 }] }),
        }
      : { ok: true, status: 200, json: async () => ({ data: [{ id: 'claude-failover' }] }) };
  const e = await failover.engage(ctx, { from: 'b' }, { fetch: fetch, keysmithConfig: ksc, useProvider: () => {} });
  assert.strictEqual(e.ok, true);
  assert.deepStrictEqual(dr.readPending(ctx).actions, [
    { kind: 'gateway-on', target: 'keysmith-failover', reason: 'every Claude account is over the threshold' },
  ]);
});

test(
  'CLI `autoswitch --once` takes a pending restart: a closed app is switched in place (macOS layout)',
  { skip: process.platform !== 'darwin' },
  function () {
    const home = makeCtx().home;
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}');
    const cfgDir = path.join(home, '.config', 'keyflip');
    fs.mkdirSync(cfgDir, { recursive: true });
    // pending: switch Desktop to an account that has NO saved desktop login -> apply fails, reported
    fs.writeFileSync(
      path.join(cfgDir, dr.PENDING_FILE),
      JSON.stringify({ actions: [{ kind: 'account', target: 'ghost' }], since: Date.now() }),
    );
    const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'keyflip.js');
    const r = spawnSync(process.execPath, [BIN, 'autoswitch', '--once', '-y'], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, {
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        KEYFLIP_CONFIG_DIR: cfgDir,
        KEYFLIP_TEST_CLAUDE: 'stopped', // the app is "closed": nothing is quit or opened
        KEYFLIP_APP_BUNDLE: path.join(home, 'no-such-Claude.app'),
      }),
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(/desktop: apply-failed — switch to ghost: no saved desktop login/.test(r.stdout), r.stdout);
    assert.strictEqual(
      fs.existsSync(path.join(cfgDir, dr.PENDING_FILE)),
      false,
      'a failing apply is not retried forever',
    );
  },
);

test('MCP keyflip_switch records the Desktop follow-up for an account with a saved desktop login', async function () {
  const ctx = makeCtx({ platform: 'darwin' });
  ctx.appDataDir = path.join(ctx.home, 'AppData');
  const login = (email, uid, tok) => {
    writeClaude(ctx, { oauthAccount: { emailAddress: email }, userID: uid });
    ctx.store.setLive(JSON.stringify({ claudeAiOauth: { accessToken: tok } }));
  };
  login('a@x.com', 'u1', 'TA');
  core.addCurrent(ctx);
  login('b@x.com', 'u2', 'TB');
  core.addCurrent(ctx);
  fs.mkdirSync(path.join(ctx.configDir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(ctx.configDir, 'app', 'a.json'), '{}');
  const t = _mcp.TOOLS.find((x) => x.name === 'keyflip_switch');
  const r = await t.run(ctx, { name: 'a', confirm: true });
  assert.ok(/pending/.test(r.desktopRestart));
  assert.deepStrictEqual(
    dr.readPending(ctx).actions.map((x) => x.target),
    ['a'],
  );
});
