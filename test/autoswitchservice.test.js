// The unattended autoswitch service (launchd StartInterval / cron */N). Runner + home are
// injected so NO test ever touches the real launchctl/crontab or writes into ~/Library.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as svc from '../src/autoswitchservice.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kf-autosvc-'));
}
// What `which keyflip` answers on an npm/fnm install: a real `#!/usr/bin/env node` script on disk.
let SCRIPT = null;
function installedScript() {
  if (SCRIPT) return SCRIPT;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kf-bin-')));
  SCRIPT = path.join(dir, 'keyflip');
  fs.writeFileSync(SCRIPT, '#!/usr/bin/env node\nconsole.log("keyflip");\n', { mode: 0o755 });
  return SCRIPT;
}
// A fake command runner that records calls and returns success for launchctl/crontab.
function fakeRunner(state) {
  state = state || {};
  return function (cmd, args, stdin) {
    state.calls = state.calls || [];
    state.calls.push({ cmd: cmd, args: args, stdin: stdin });
    if (cmd === 'which') return { code: 0, stdout: (state.which || installedScript()) + '\n' };
    if (cmd === 'launchctl' && args && args[0] === 'list') return { code: 0, stdout: state.launchctl || '' };
    if (cmd === 'crontab' && args && args[0] === '-l') return { code: 0, stdout: state.cron || '' };
    if (cmd === 'crontab' && args && args[0] === '-') {
      state.cron = stdin;
      return { code: 0, stdout: '' };
    }
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
  const cmds = state.calls.map(function (c) {
    return c.cmd + ' ' + (c.args || [])[0];
  });
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
  assert.strictEqual(svc.status({ platform: 'darwin' }, { home: home, run: fakeRunner() }).installed, false);
  svc.install({ platform: 'darwin' }, { home: home, interval: 300, run: fakeRunner() });
  assert.strictEqual(svc.status({ platform: 'darwin' }, { home: home, run: fakeRunner() }).installed, true);
});

// ---- P0: the live job exited 127 on every run (an fnm shim exec'd without node) ----
function plistArgv(plist) {
  return svc.plistArgs(plist);
}
function fnmShim() {
  // ~/.local/state/fnm_multishells/<pid>_<ts>/bin/keyflip -> …/lib/node_modules/keyflip/bin/keyflip.js
  const root = fs.realpathSync(tmpHome());
  const real = path.join(root, 'node-versions', 'v24', 'lib', 'node_modules', 'keyflip', 'bin', 'keyflip.js');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, '#!/usr/bin/env node\n', { mode: 0o755 });
  const shimDir = path.join(root, 'fnm_multishells', '65408_1794173843337', 'bin');
  fs.mkdirSync(shimDir, { recursive: true });
  const shim = path.join(shimDir, 'keyflip');
  fs.symlinkSync(real, shim);
  return { shim: shim, real: real, root: root };
}

test('P0: an fnm per-shell shim is never the program — the job is <absolute node> <real script>', function () {
  const f = fnmShim();
  const c = svc.autoswitchCommand({ run: fakeRunner({ which: f.shim }), threshold: 95 });
  assert.ok(path.isAbsolute(c.exec), 'absolute program');
  assert.strictEqual(path.basename(c.exec), path.basename(process.execPath), 'node runs the job');
  assert.strictEqual(c.args[0], f.real, 'the resolved script, not the shim');
  assert.ok(c.args.join(' ').indexOf('fnm_multishells') === -1, 'no per-shell path anywhere in the argv');
  assert.deepStrictEqual(c.args.slice(1, 4), ['autoswitch', '--once', '-y']);
});

test('P0: a non-.js `#!/usr/bin/env node` file on PATH is run by node, not exec\'d bare', function () {
  const script = installedScript();
  const c = svc.autoswitchCommand({ run: fakeRunner({ which: script }) });
  assert.strictEqual(c.exec, fs.realpathSync(process.execPath));
  assert.strictEqual(c.args[0], script);
});

test('P0: the plist carries a PATH with node first and logs stdout+stderr', function () {
  const home = tmpHome();
  const plist = svc.buildPlist({ home: home, run: fakeRunner() });
  const m = /<key>PATH<\/key><string>([^<]*)<\/string>/.exec(plist);
  assert.ok(m, 'EnvironmentVariables PATH present');
  assert.strictEqual(m[1].split(':')[0], path.dirname(fs.realpathSync(process.execPath)), 'node dir first');
  assert.ok(m[1].split(':').indexOf('/usr/bin') !== -1);
  assert.ok(plist.indexOf('<key>StandardErrorPath</key><string>' + svc.logPath(home) + '</string>') !== -1);
  assert.ok(plist.indexOf('<key>StandardOutPath</key>') !== -1);
  const argv = plistArgv(plist);
  assert.ok(path.isAbsolute(argv[0]) && path.isAbsolute(argv[1]), 'node + script, both absolute');
});

test('P0: install refuses a command that cannot run instead of scheduling a 127', function () {
  const home = tmpHome();
  const state = { which: path.join(tmpHome(), 'gone', 'keyflip.js') }; // a script that does not exist
  const r = svc.install({ platform: 'darwin' }, { home: home, run: fakeRunner(state) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unrunnable');
  assert.ok(/script does not exist/.test(r.detail), r.detail);
  assert.strictEqual(fs.existsSync(svc.plistPath(home)), false, 'nothing written');
  assert.ok(
    !(state.calls || []).some(function (c) {
      return c.cmd === 'launchctl' && c.args[0] === 'load';
    }),
    'nothing loaded',
  );
});

test('P0: status reads launchd\'s last exit — a 127 is BROKEN, not "installed"', function () {
  const home = tmpHome();
  svc.install({ platform: 'darwin' }, { home: home, run: fakeRunner() });
  const broken = svc.status(
    { platform: 'darwin' },
    { home: home, run: fakeRunner({ launchctl: 'PID\tStatus\tLabel\n-\t127\tcom.keyflip.autoswitch\n-\t0\tcom.other\n' }) },
  );
  assert.strictEqual(broken.installed, true);
  assert.strictEqual(broken.healthy, false);
  assert.strictEqual(broken.lastExit, 127);
  assert.ok(/command not found/.test(broken.lastExitMeaning));
  assert.ok(broken.fix && /autoswitch install/.test(broken.fix));
  const ok = svc.status(
    { platform: 'darwin' },
    { home: home, run: fakeRunner({ launchctl: '-\t0\tcom.keyflip.autoswitch\n' }) },
  );
  assert.strictEqual(ok.healthy, true);
  assert.strictEqual(ok.lastExit, 0);
  const notLoaded = svc.status({ platform: 'darwin' }, { home: home, run: fakeRunner({ launchctl: '-\t0\tcom.x\n' }) });
  assert.strictEqual(notLoaded.loaded, false);
  assert.strictEqual(notLoaded.healthy, false);
});

test('P0: status flags an OLD plist whose program is an fnm shim even before it fails', function () {
  const home = tmpHome();
  const f = fnmShim();
  fs.mkdirSync(path.dirname(svc.plistPath(home)), { recursive: true });
  // What was really on disk: the shim exec'd directly.
  fs.writeFileSync(
    svc.plistPath(home),
    svc.buildPlist({ home: home, command: { exec: f.shim, args: ['autoswitch', '--once', '-y', '--threshold', '100'] } }),
  );
  const st = svc.status({ platform: 'darwin' }, { home: home, run: fakeRunner({ launchctl: '-\t0\tcom.keyflip.autoswitch\n' }) });
  assert.strictEqual(st.healthy, false);
  assert.ok(
    st.problems.some(function (p) {
      return /per-shell path/.test(p);
    }),
    st.problems.join(' | '),
  );
  assert.strictEqual(st.threshold, 100);
});

test('P0: the cron line is absolute node + script and appends to a log', function () {
  const line = svc.cronLine({ interval: 300, run: fakeRunner(), home: '/home/u' });
  const node = fs.realpathSync(process.execPath);
  assert.ok(line.indexOf(node + ' ' + installedScript() + ' autoswitch --once -y') !== -1, line);
  assert.ok(/>>\/home\/u\/\.cache\/keyflip\/autoswitch\.log 2>&1/.test(line), line);
});

test('unsupported platform is handled, not crashed', function () {
  const r = svc.install({ platform: 'win32' }, { interval: 300, run: fakeRunner() });
  assert.strictEqual(r.kind, 'unsupported');
  assert.strictEqual(r.ok, false);
});
