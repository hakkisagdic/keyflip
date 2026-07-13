'use strict';
// The unattended autoswitch service (launchd StartInterval / cron */N). Runner + home are
// injected so NO test ever touches the real launchctl/crontab or writes into ~/Library.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const svc = require('../src/autoswitchservice');

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kf-autosvc-')); }
// A fake command runner that records calls and returns success for launchctl/crontab.
function fakeRunner(state) {
  state = state || {};
  return function (cmd, args, stdin) {
    state.calls = state.calls || [];
    state.calls.push({ cmd: cmd, args: args, stdin: stdin });
    if (cmd === 'which') return { code: 0, stdout: '/usr/local/bin/keyflip\n' };
    if (cmd === 'crontab' && args && args[0] === '-l') return { code: 0, stdout: state.cron || '' };
    if (cmd === 'crontab' && args && args[0] === '-') { state.cron = stdin; return { code: 0, stdout: '' }; }
    return { code: 0, stdout: '' };
  };
}

test('buildPlist embeds the label, a --once -y command, and a StartInterval', function () {
  const plist = svc.buildPlist({ interval: 300, threshold: 80, strategy: 'best', run: fakeRunner() });
  assert.ok(plist.indexOf(svc.LABEL) !== -1);
  assert.ok(/autoswitch/.test(plist) && /--once/.test(plist) && /-y/.test(plist), 'runs a one-shot tick');
  assert.ok(/--threshold/.test(plist) && />80</.test(plist), 'threshold flows in');
  assert.ok(/StartInterval<\/key><integer>300</.test(plist), 'interval in seconds');
  assert.ok(/RunAtLoad<\/key><true\/>/.test(plist), 'runs at load');
});

test('interval is clamped to a sane band (>=60s, <=6h)', function () {
  assert.strictEqual(svc.intervalSec({ interval: 5 }), 60, 'floor 60s');
  assert.strictEqual(svc.intervalSec({ interval: 999999 }), 21600, 'cap 6h');
  assert.strictEqual(svc.intervalSec({ interval: 'garbage' }), 300, 'default 300');
});

test('autoswitchCommand whitelists strategy/group + clamps threshold (no shell metachars)', function () {
  const c = svc.autoswitchCommand({ threshold: 999, strategy: 'evil; rm -rf /', group: 'work; rm', run: fakeRunner() });
  const line = [c.exec].concat(c.args).join(' ');
  assert.ok(/--threshold 100/.test(line), 'threshold clamped to <=100');
  assert.ok(line.indexOf('rm -rf') === -1, 'a hostile strategy is dropped, not passed');
  assert.ok(line.indexOf('work; rm') === -1, 'a hostile group is dropped');
});

test('cronLine uses */N minutes and carries the managed marker', function () {
  const line = svc.cronLine({ interval: 300, run: fakeRunner() }); // 300s -> every 5 min
  assert.ok(line.indexOf(svc.CRON_MARK) !== -1);
  assert.ok(/^\*\/5 \* \* \* \*/.test(line), 'every 5 minutes: ' + line);
});

test('launchd install writes a plist under the injected home and load-cycles it', function () {
  const home = tmpHome();
  const state = {};
  const r = svc.install({ platform: 'darwin' }, { home: home, interval: 300, run: fakeRunner(state) });
  assert.strictEqual(r.ok, true);
  assert.ok(fs.existsSync(svc.plistPath(home)), 'plist written');
  const cmds = state.calls.map(function (c) { return c.cmd + ' ' + (c.args || [])[0]; });
  assert.ok(cmds.indexOf('launchctl unload') !== -1 && cmds.indexOf('launchctl load') !== -1, 'idempotent load');
  // uninstall removes it
  const u = svc.uninstall({ platform: 'darwin' }, { home: home, run: fakeRunner() });
  assert.strictEqual(u.existed, true);
  assert.strictEqual(fs.existsSync(svc.plistPath(home)), false, 'plist removed');
});

test('cron install adds exactly one managed line, uninstall removes it, other jobs kept', function () {
  const state = { cron: '0 0 * * * other-job\n' };
  const runner = fakeRunner(state);
  svc.install({ platform: 'linux' }, { interval: 300, run: runner });
  assert.ok(state.cron.indexOf(svc.CRON_MARK) !== -1, 'managed line added');
  assert.ok(state.cron.indexOf('other-job') !== -1, 'unrelated job preserved');
  // idempotent: a second install does not duplicate
  svc.install({ platform: 'linux' }, { interval: 300, run: runner });
  // literal count (CRON_MARK contains regex-special parens, so split — not RegExp — to count)
  assert.strictEqual(state.cron.split(svc.CRON_MARK).length - 1, 1, 'no duplicate');
  const u = svc.uninstall({ platform: 'linux' }, { run: runner });
  assert.strictEqual(u.existed, true);
  assert.ok(state.cron.indexOf(svc.CRON_MARK) === -1 && state.cron.indexOf('other-job') !== -1, 'only ours removed');
});

test('status reflects install state (launchd)', function () {
  const home = tmpHome();
  assert.strictEqual(svc.status({ platform: 'darwin' }, { home: home }).installed, false);
  svc.install({ platform: 'darwin' }, { home: home, interval: 300, run: fakeRunner() });
  assert.strictEqual(svc.status({ platform: 'darwin' }, { home: home }).installed, true);
});

test('unsupported platform is handled, not crashed', function () {
  const r = svc.install({ platform: 'win32' }, { interval: 300, run: fakeRunner() });
  assert.strictEqual(r.kind, 'unsupported');
  assert.strictEqual(r.ok, false);
});
