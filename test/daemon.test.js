// Tests for the unified supervised daemon (`src/daemon.js`).
// All tests use hermetic temp directories, fake runners, and injectable callbacks —
// NEVER touching ~/Library/LaunchAgents, real launchctl, live accounts, or Claude Desktop.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import net from 'net';
import path from 'path';
import * as daemon from '../src/daemon.js';
import * as profiles from '../src/profiles.js';
import * as core from '../src/core.js';
import * as config from '../src/config.js';
import * as history from '../src/history.js';
import * as doctor from '../src/doctor.js';
import { makeCtx, writeClaude, tmpdir } from './helpers.js';

function fakeRunner(state) {
  state = state || {};
  state.calls = state.calls || [];
  return function (cmd, args) {
    state.calls.push({ cmd: cmd, args: args });
    if (cmd === 'which' && state.which) {
      return { code: 0, stdout: state.which + '\n', stderr: '' };
    }
    if (cmd === 'launchctl' && args[0] === 'list' && args[1] === daemon.LABEL) {
      if (state.notLoaded) return { code: 113, stdout: '', stderr: 'Could not find service' };
      return {
        code: 0,
        stdout: '{\n\t"Label" = "com.keyflip.daemon";\n\t"PID" = 42424;\n\t"LastExitStatus" = 0;\n};\n',
        stderr: '',
      };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
}

function httpOverUnixSocket(sockPath, method, urlPath, bodyObj) {
  return new Promise(function (resolve, reject) {
    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
    const reqLines = [
      method + ' ' + urlPath + ' HTTP/1.1',
      'Host: localhost',
      'Content-Type: application/json',
      'Content-Length: ' + Buffer.byteLength(bodyStr, 'utf8'),
      'Connection: close',
      '',
      bodyStr,
    ].join('\r\n');

    const client = net.createConnection({ path: sockPath });
    let raw = '';
    client.setEncoding('utf8');
    client.on('connect', function () {
      client.write(reqLines);
    });
    client.on('data', function (chunk) {
      raw += chunk;
    });
    client.on('end', function () {
      const idx = raw.indexOf('\r\n\r\n');
      const head = idx !== -1 ? raw.slice(0, idx) : raw;
      const body = idx !== -1 ? raw.slice(idx + 4) : '';
      const statusMatch = /^HTTP\/1\.1\s+(\d+)/.exec(head);
      const code = statusMatch ? parseInt(statusMatch[1], 10) : 0;
      resolve({ status: code, body: body ? JSON.parse(body) : null });
    });
    client.on('error', reject);
  });
}

test('redactSecrets strips secret keys and token substrings recursively', function () {
  const dirty = {
    account: 'gmail',
    accessToken: 'sk-ant-oat01-SECRET-ACCESS-TOKEN-123456',
    refreshToken: 'sk-ant-ort01-SECRET-REFRESH-TOKEN-123456',
    sessionKey: 'sk-ant-sid01-SECRET-SESSION',
    nested: {
      cookie: 'sessionKey=sk-ant-sid01-COOKIE-VAL; Path=/',
      error: 'upstream failed with token sk-ant-oat01-LEAKED-IN-ERROR-MSG',
      jwt: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    },
  };
  const clean = daemon.redactSecrets(dirty);
  const serialized = JSON.stringify(clean);
  assert.strictEqual(clean.account, 'gmail');
  assert.strictEqual(clean.accessToken, '[REDACTED]');
  assert.strictEqual(clean.refreshToken, '[REDACTED]');
  assert.strictEqual(clean.sessionKey, '[REDACTED]');
  assert.strictEqual(clean.nested.cookie, '[REDACTED]');
  assert.doesNotMatch(serialized, /SECRET-ACCESS-TOKEN/);
  assert.doesNotMatch(serialized, /SECRET-REFRESH-TOKEN/);
  assert.doesNotMatch(serialized, /LEAKED-IN-ERROR-MSG/);
  assert.doesNotMatch(serialized, /eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9/);
});

test('scheduler runs jobs without overlapping and respects Retry-After quiet window on usage', async function () {
  const ctx = makeCtx();
  writeClaude(ctx, { oauthAccount: { emailAddress: 'a@example.com', accountUuid: 'u1' }, userID: 'id1' });
  ctx.store.setLive(
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-LIVE-SECRET-111111',
        refreshToken: 'sk-ant-ort01-REFRESH-SECRET-111111',
        expiresAt: Date.now() + 3600 * 1000,
      },
    }),
  );
  core.addCurrent(ctx, 'gmail');

  let refreshCalls = 0;
  let releaseRefresh;
  const gatePromise = new Promise(function (resolve) {
    releaseRefresh = resolve;
  });

  const sched = daemon.createScheduler(ctx, {
    jobs: {
      refresh: async function () {
        refreshCalls++;
        await gatePromise;
        return { state: 'ok', refreshed: 1 };
      },
    },
  });

  // Fire two concurrent refresh runs — they must share the single in-flight execution
  const p1 = sched.runJob('refresh');
  const p2 = sched.runJob('refresh');
  assert.strictEqual(sched.getJobsSnapshot().refresh.running, true);
  releaseRefresh();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.strictEqual(refreshCalls, 1, 'concurrent calls do not overlap');
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(sched.getJobsSnapshot().refresh.runCount, 1);

  // Write a Retry-After quiet window in .usage-throttle.json and verify `usage` job does not call fetch
  let fetchCalled = false;
  const futureMs = Date.now() + 120 * 1000;
  fs.writeFileSync(
    path.join(ctx.configDir, '.usage-throttle.json'),
    JSON.stringify({ retryAt: futureMs, strike: 2 }),
    { mode: 0o600 },
  );
  const schedWithFetch = daemon.createScheduler(ctx, {
    fetch: async function () {
      fetchCalled = true;
      throw new Error('should not fetch during Retry-After quiet window');
    },
  });
  const uRes = await schedWithFetch.runJob('usage');
  assert.strictEqual(uRes.ok, true);
  assert.strictEqual(uRes.result, 'throttled');
  assert.strictEqual(fetchCalled, false, 'Retry-After quiet window strictly honored');
});

test('socket server enforces 0600 permissions, serves HTTP/1.1 & NDJSON, and never leaks secrets', async function (t) {
  if (process.platform === 'win32') return t.skip('Unix socket permissions test is POSIX-only');
  const ctx = makeCtx();
  const SECRET_ACCESS = 'sk-ant-oat01-SUPER-SECRET-TOKEN-999999';
  const SECRET_REFRESH = 'sk-ant-ort01-SUPER-REFRESH-TOKEN-999999';
  writeClaude(ctx, { oauthAccount: { emailAddress: 'alice@example.com', accountUuid: 'u-alice' }, userID: 'u1' });
  ctx.store.setLive(
    JSON.stringify({
      claudeAiOauth: {
        accessToken: SECRET_ACCESS,
        refreshToken: SECRET_REFRESH,
        expiresAt: Date.now() + 7200 * 1000,
      },
    }),
  );
  core.addCurrent(ctx, 'alice');

  profiles.write(ctx.configDir, {
    name: 'bob',
    email: 'bob@example.com',
    userID: 'u2',
    oauthAccount: { emailAddress: 'bob@example.com', accountUuid: 'u-bob' },
    savedAt: ctx.now(),
  });
  ctx.store.setProfile(
    'bob',
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-BOB-SECRET-TOKEN-888888',
        refreshToken: 'sk-ant-ort01-BOB-REFRESH-TOKEN-888888',
        expiresAt: Date.now() + 7200 * 1000,
      },
    }),
  );

  // Seed usage cache
  fs.writeFileSync(
    path.join(ctx.configDir, '.usage-cache.json'),
    JSON.stringify({
      alice: {
        fetchedAt: Date.now(),
        usage: {
          fiveHour: { pct: 48, resetsAt: '2026-11-13T18:00:00.000Z' },
          sevenDay: { pct: 62, resetsAt: '2026-11-18T00:00:00.000Z' },
        },
      },
    }),
    { mode: 0o600 },
  );

  const switched = [];
  let failoverState = null;
  const handle = await daemon.startDaemon(ctx, {
    runOnStart: false,
    performSwitch: async function (target) {
      switched.push(target);
      return { cli: true };
    },
    failover: {
      state: function () {
        return failoverState;
      },
      gatewayHealth: async function () {
        return { ok: true, reason: null };
      },
      engage: async function (info) {
        failoverState = { at: Date.now(), manual: Boolean(info.manual), reason: info.reason };
        return { ok: true, state: failoverState };
      },
      release: async function () {
        failoverState = null;
        return { ok: true };
      },
    },
    jobs: {
      autoswitch: async function () {
        return { state: 'below' };
      },
    },
  });

  try {
    // 1. Socket permissions must be 0600
    const mode = fs.statSync(handle.socketPath).mode & 0o777;
    assert.strictEqual(mode, 0o600, 'daemon.sock must be 0600');

    // 2. Query status over NDJSON
    const q = await daemon.querySocket(ctx, { cmd: 'status' });
    assert.strictEqual(q.ok, true);
    assert.strictEqual(q.reachable, true);
    assert.strictEqual(q.response.activeAccount.name, 'alice');
    assert.strictEqual(q.response.accounts.length, 2);
    assert.strictEqual(q.response.accounts[0].usage.fiveHour.pct, 48);

    // Verify ZERO secrets in the response
    const rawStr = JSON.stringify(q.response);
    assert.strictEqual(rawStr.indexOf(SECRET_ACCESS), -1, 'accessToken never exposed');
    assert.strictEqual(rawStr.indexOf(SECRET_REFRESH), -1, 'refreshToken never exposed');
    assert.strictEqual(rawStr.indexOf('BOB-SECRET-TOKEN'), -1, 'inactive account token never exposed');

    // 3. Query status over HTTP/1.1
    const httpSt = await httpOverUnixSocket(handle.socketPath, 'GET', '/v1/status');
    assert.strictEqual(httpSt.status, 200);
    assert.strictEqual(httpSt.body.ok, true);
    assert.strictEqual(httpSt.body.activeAccount.name, 'alice');

    // 4. Switch without confirm:true is rejected (400)
    const badSwitch = await httpOverUnixSocket(handle.socketPath, 'POST', '/v1/switch', {
      account: 'bob',
    });
    assert.strictEqual(badSwitch.status, 400);
    assert.strictEqual(badSwitch.body.error, 'confirmation_required');
    assert.deepStrictEqual(switched, [], 'no switch occurred without confirmation');

    // 5. Switch with confirm:true succeeds and writes audit event
    const okSwitch = await httpOverUnixSocket(handle.socketPath, 'POST', '/v1/switch', {
      account: 'bob',
      confirm: true,
      reason: 'menubar-test',
    });
    assert.strictEqual(okSwitch.status, 200);
    assert.strictEqual(okSwitch.body.ok, true);
    assert.strictEqual(okSwitch.body.switchedTo, 'bob');
    assert.deepStrictEqual(switched, ['bob']);

    const events = history.readEvents(ctx);
    assert.ok(
      events.some(function (e) {
        return e.kind === 'daemon-switch' && e.to === 'bob' && e.reason === 'menubar-test';
      }),
      'switch recorded in audit events.jsonl',
    );

    // 6. Failover toggle requires confirm:true and records audit event
    const badFo = await httpOverUnixSocket(handle.socketPath, 'POST', '/v1/failover', {
      action: 'on',
    });
    assert.strictEqual(badFo.status, 400);
    assert.strictEqual(badFo.body.error, 'confirmation_required');

    const okFo = await httpOverUnixSocket(handle.socketPath, 'POST', '/v1/failover', {
      action: 'on',
      confirm: true,
      reason: 'manual-toggle',
    });
    assert.strictEqual(okFo.status, 200);
    assert.strictEqual(okFo.body.ok, true);
    assert.ok(failoverState && failoverState.manual === true);

    // 7. Run-now triggers a job immediately
    const runRes = await httpOverUnixSocket(handle.socketPath, 'POST', '/v1/run-now', {
      job: 'autoswitch',
    });
    assert.strictEqual(runRes.status, 200);
    assert.strictEqual(runRes.body.ok, true);
    assert.strictEqual(runRes.body.result, 'below');

    // 8. Config update validates via config.js and requires confirm:true
    const okCfg = await httpOverUnixSocket(handle.socketPath, 'POST', '/v1/config', {
      set: { 'autoswitch.threshold': 90 },
      confirm: true,
    });
    assert.strictEqual(okCfg.status, 200);
    assert.strictEqual(config.get(ctx, 'autoswitch.threshold'), 90);
  } finally {
    await handle.stop();
  }
});

test('install migrates and backs up the 4 legacy launchd plists with ROLLBACK.md and avoids fnm shims', async function () {
  const ctx = makeCtx({ platform: 'darwin' });
  const agentsDir = path.join(ctx.home, 'Library', 'LaunchAgents');
  fs.mkdirSync(agentsDir, { recursive: true });

  // Create fake legacy plists on disk
  daemon.LEGACY_LABELS.forEach(function (label) {
    fs.writeFileSync(path.join(agentsDir, label + '.plist'), '<plist>' + label + '</plist>');
  });

  // Simulate an ephemeral fnm_multishells shim on PATH pointing to a real script
  const root = fs.realpathSync(tmpdir());
  const realScript = path.join(root, 'node-versions', 'v24', 'lib', 'node_modules', 'keyflip', 'bin', 'keyflip.js');
  fs.mkdirSync(path.dirname(realScript), { recursive: true });
  fs.writeFileSync(realScript, '#!/usr/bin/env node\n', { mode: 0o755 });
  const shimDir = path.join(root, 'fnm_multishells', '12345_67890', 'bin');
  fs.mkdirSync(shimDir, { recursive: true });
  const shim = path.join(shimDir, 'keyflip');
  fs.symlinkSync(realScript, shim);

  const state = { which: shim };
  const res = daemon.install(ctx, {
    home: ctx.home,
    run: fakeRunner(state),
  });

  assert.strictEqual(res.ok, true);
  assert.strictEqual(path.basename(res.argv[0]), path.basename(process.execPath), 'runs via resolved node binary');
  assert.strictEqual(res.argv[1], realScript, 'resolves symlink away from fnm_multishells');
  assert.strictEqual(res.argv.join(' ').indexOf('fnm_multishells'), -1, 'no ephemeral path in argv');
  assert.deepStrictEqual(res.migratedLegacy.sort(), daemon.LEGACY_LABELS.slice().sort());
  assert.ok(res.legacyBackupDir && fs.existsSync(path.join(res.legacyBackupDir, 'ROLLBACK.md')));

  // Legacy plists removed from LaunchAgents, backed up in legacyBackupDir
  daemon.LEGACY_LABELS.forEach(function (label) {
    assert.strictEqual(
      fs.existsSync(path.join(agentsDir, label + '.plist')),
      false,
      label + ' removed from LaunchAgents',
    );
    assert.strictEqual(fs.existsSync(path.join(res.legacyBackupDir, label + '.plist')), true, label + ' backed up');
  });

  // Unified plist written and loaded
  assert.strictEqual(fs.existsSync(daemon.plistPath(ctx.home)), true);
  const plistContent = fs.readFileSync(daemon.plistPath(ctx.home), 'utf8');
  assert.match(plistContent, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.doesNotMatch(plistContent, /fnm_multishells/);

  // Status & doctor integration
  const st = await daemon.status(ctx, { home: ctx.home, run: fakeRunner(state), probeSocket: false });
  assert.strictEqual(st.installed, true);
  assert.strictEqual(st.healthy, true);
  assert.strictEqual(st.pid, 42424);

  profiles.write(ctx.configDir, { name: 'work', email: 'work@example.com' });
  const diag = await doctor.diagnose(ctx, { home: ctx.home, run: fakeRunner(state) });
  const dCheck = diag.checks.find(function (c) {
    return c.name === 'keyflip daemon';
  });
  assert.ok(dCheck && dCheck.ok === true, 'doctor reports keyflip daemon healthy');
  const trCheck = diag.checks.find(function (c) {
    return c.name === 'token renewal';
  });
  assert.ok(trCheck && trCheck.ok === true && /com\.keyflip\.daemon/.test(trCheck.detail));

  // Uninstall removes the plist but keeps the backup dir
  const un = daemon.uninstall(ctx, { home: ctx.home, run: fakeRunner(state) });
  assert.strictEqual(un.ok, true);
  assert.strictEqual(un.existed, true);
  assert.strictEqual(fs.existsSync(daemon.plistPath(ctx.home)), false);
  assert.strictEqual(fs.existsSync(path.join(res.legacyBackupDir, 'ROLLBACK.md')), true);
});

test('rotateLogIfNeeded rotates daemon log when size reaches limit', function () {
  const dir = tmpdir();
  const lf = path.join(dir, 'keyflip-daemon.log');
  fs.writeFileSync(lf, 'x'.repeat(2048), { mode: 0o600 });
  daemon.rotateLogIfNeeded(lf, 1024);
  assert.strictEqual(fs.existsSync(lf), false);
  assert.strictEqual(fs.existsSync(lf + '.1'), true);
  assert.strictEqual(fs.statSync(lf + '.1').size, 2048);
});
