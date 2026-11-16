// src/spawnguard.js: a test run never reaches a real desktop tool or a real webhook.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { tmpdir, makeCtx } from './helpers.js';
import * as exec from '../src/exec.js';
import * as guard from '../src/spawnguard.js';
import * as notify from '../src/notify.js';

function withLog(fn) {
  const file = path.join(tmpdir(), 'spawns.log');
  const prev = process.env.KEYFLIP_SPAWN_LOG;
  process.env.KEYFLIP_SPAWN_LOG = file;
  return Promise.resolve(fn(file)).finally(function () {
    if (prev === undefined) delete process.env.KEYFLIP_SPAWN_LOG;
    else process.env.KEYFLIP_SPAWN_LOG = prev;
  });
}

test('the guard is armed under the test runner', function () {
  assert.equal(guard.active(), true);
});

test('exec.run refuses osascript, open, say and terminal-notifier and logs each', function () {
  return withLog(function (file) {
    for (const cmd of ['/usr/bin/osascript', 'open', 'say', 'terminal-notifier']) {
      const r = exec.run(cmd, ['-e', 'beep']);
      assert.equal(r.code, 1);
      assert.equal(r.refused, true);
      assert.ok(r.error && r.error.code === 'KEYFLIP_TEST_GUARD');
    }
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 4);
  });
});

test('exec.run still runs ordinary commands', function () {
  const r = exec.run(process.execPath, ['-e', 'process.stdout.write("ok")']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'ok');
});

test('notify.send with desktop on and no injected runner spawns nothing real (refused and logged)', function () {
  return withLog(async function (file) {
    const ctx = makeCtx({ platform: 'darwin' });
    notify.setConfig(ctx, { desktop: true, events: ['switch'] });
    const r = await notify.send(ctx, 'switch', { to: 'a' });
    assert.equal(r.sent, false);
    assert.match(fs.readFileSync(file, 'utf8'), /^spawn osascript /);
  });
});

test('notify.send never fires a banner when the desktop setting is off, even with forceDesktop', function () {
  return withLog(async function (file) {
    const ctx = makeCtx({ platform: 'darwin' });
    notify.setConfig(ctx, { desktop: false, events: ['switch'] });
    const calls = [];
    const run = function () {
      calls.push(arguments);
      return { code: 0, stdout: '', stderr: '' };
    };
    await notify.send(ctx, 'switch', { to: 'a' }, { run: run });
    await notify.send(ctx, 'token-refresh', { to: 'a' }, { run: run, force: true, forceDesktop: true });
    assert.equal(calls.length, 0);
    assert.equal(fs.existsSync(file), false);
  });
});

test('an injected runner is used and the guard is not involved', function () {
  return withLog(async function (file) {
    const ctx = makeCtx({ platform: 'darwin' });
    notify.setConfig(ctx, { desktop: true, events: ['switch'] });
    let n = 0;
    const r = await notify.send(
      ctx,
      'switch',
      { to: 'a' },
      {
        run: function () {
          n++;
          return { code: 0, stdout: '', stderr: '' };
        },
      },
    );
    assert.equal(n, 1);
    assert.equal(r.sent, true);
    assert.equal(fs.existsSync(file), false);
  });
});

test('a real webhook POST is refused unless a fetch was injected', function () {
  return withLog(async function (file) {
    const ctx = makeCtx({ platform: 'linux' });
    notify.setConfig(ctx, { webhook: 'https://example.invalid/hook', desktop: false, events: ['switch'] });
    const r = await notify.send(ctx, 'switch', { to: 'a' });
    assert.equal(r.sent, false);
    assert.equal(r.channels[0].reason, 'test-offline');
    assert.match(fs.readFileSync(file, 'utf8'), /^fetch /);
    let hit = 0;
    const r2 = await notify.send(
      ctx,
      'switch',
      { to: 'a' },
      {
        fetch: async function () {
          hit++;
          return { ok: true, status: 200 };
        },
      },
    );
    assert.equal(hit, 1);
    assert.equal(r2.sent, true);
  });
});

test('exec.run refuses every `claude auth ...` call of the real binary (logout, login, status)', function () {
  const before = guard.refusedCount();
  assert.equal(exec.run('claude', ['auth', 'logout']).refused, true);
  assert.equal(exec.run('claude', ['auth', 'login', '--claudeai']).refused, true);
  assert.equal(exec.run('claude', ['auth', 'status']).refused, true);
  assert.equal(guard.refusedCount(), before + 3);
});

test('a loopback webhook sink is allowed without an injected fetch', function () {
  assert.equal(guard.refuseFetch(false, 'http://127.0.0.1:5000/hook'), false);
  assert.equal(guard.refuseFetch(false, 'http://localhost:5000/hook'), false);
});

test('a stand-in claude under the temp dir may answer `auth status`', function () {
  if (process.platform === 'win32') return;
  const dir = tmpdir();
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\necho stub\n');
  fs.chmodSync(bin, 0o755);
  const r = exec.run(bin, ['auth', 'status']);
  assert.equal(r.refused, undefined);
  assert.equal(r.stdout.trim(), 'stub');
});
