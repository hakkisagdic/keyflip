// The autoswitch PILOT as an unattended background service. `keyflip autoswitch` alone is a
// foreground loop you must keep a terminal open for — so it never runs when you actually need it.
// This installs a scheduled `keyflip autoswitch --once -y` that fires on an INTERVAL (macOS launchd
// StartInterval; Linux cron */N) so account rotation happens on its own while you keep using Claude.
//
// Command-activated, NOT a hidden daemon: the user explicitly installs/removes it. Runner + home are
// injectable so tests never touch the real launchctl/crontab. Sibling of schedule.js (dream's
// nightly CALENDAR job); this one is INTERVAL-based and left separate so dream stays untouched.
//
// It must fail LOUDLY. The first version exec'd whatever `which keyflip` said — an fnm per-shell
// shim with `#!/usr/bin/env node` — and launchd, which has no node on its PATH, exited 127 on every
// run for days while `status` said "installed". Now: the job is `<absolute node> <absolute script>`
// (selfbin.js), install refuses an argv that cannot run, the job writes its output to a log, and
// status reads launchd's last exit code back.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { run } from './exec.js';
import * as selfbin from './selfbin.js';

const LABEL = 'com.keyflip.autoswitch';
const CRON_MARK = '# keyflip-autoswitch (managed by keyflip)';

function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function xmlUnesc(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
// One POSIX shell word. Paths can hold spaces; the cron line runs under `/bin/sh -c`.
function shq(s) {
  s = String(s);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
}

// `<absolute node> <absolute keyflip script> autoswitch --once -y …` (or a real native binary).
function autoswitchCommand(opts) {
  opts = opts || {};
  const self = selfbin.resolveSelf({
    run: opts.run,
    fs: opts.fs,
    execPath: opts.execPath,
    fallbackScript: opts.script,
  });
  // A scheduled tick is non-interactive: --once does exactly one check, -y skips the confirm.
  // threshold/strategy/group are bounded/whitelisted at the source so they can never carry shell
  // metacharacters into the Linux cron `/bin/sh -c` line.
  const args = ['autoswitch', '--once', '-y'];
  const th = parseInt(opts.threshold, 10);
  if (!isNaN(th)) args.push('--threshold', String(Math.min(100, Math.max(50, th))));
  if (opts.strategy === 'best' || opts.strategy === 'next-available') args.push('--strategy', opts.strategy);
  if (opts.group && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opts.group)) args.push('--group', opts.group);
  const c = selfbin.argvFor(self, args);
  if (self.pathCopy) c.pathCopy = self.pathCopy; // the PATH's `keyflip` is another (older) copy
  return c;
}

// Interval in seconds, clamped so a runaway config can't hammer the endpoint (min 60s) or drift
// uselessly long (max 6h). launchd wants seconds; cron gets whole minutes (min 1).
function intervalSec(opts) {
  return Math.min(21600, Math.max(60, parseInt(opts && opts.interval, 10) || 300));
}

// Where the job's stdout+stderr go. Without it a job that fails every time is indistinguishable
// from one that never ran.
function logPath(home) {
  return path.join(home || os.homedir(), 'Library', 'Logs', 'autoswitch-keyflip.log');
}
function cronLogPath(home) {
  return path.join(home || os.homedir(), '.cache', 'keyflip', 'autoswitch.log');
}

// ---- macOS launchd (StartInterval) ----
function plistPath(home) {
  return path.join(home || os.homedir(), 'Library', 'LaunchAgents', LABEL + '.plist');
}
function buildPlist(opts) {
  opts = opts || {};
  const c = opts.command || autoswitchCommand(opts);
  const prog = [c.exec]
    .concat(c.args)
    .map(function (a) {
      return '      <string>' + xmlEsc(a) + '</string>';
    })
    .join('\n');
  const log = xmlEsc(logPath(opts.home));
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n  <dict>\n' +
    '    <key>Label</key><string>' +
    LABEL +
    '</string>\n' +
    '    <key>ProgramArguments</key>\n    <array>\n' +
    prog +
    '\n    </array>\n' +
    // Anything the tick spawns (ps, security, osascript, open) must resolve without a login shell.
    '    <key>EnvironmentVariables</key>\n    <dict>\n      <key>PATH</key><string>' +
    xmlEsc(selfbin.jobPath(c.exec)) +
    '</string>\n    </dict>\n' +
    '    <key>StartInterval</key><integer>' +
    intervalSec(opts) +
    '</integer>\n' +
    '    <key>StandardOutPath</key><string>' +
    log +
    '</string>\n' +
    '    <key>StandardErrorPath</key><string>' +
    log +
    '</string>\n' +
    '    <key>RunAtLoad</key><true/>\n  </dict>\n</plist>\n'
  );
}
// ProgramArguments back out of an installed plist (status/doctor read what launchd will run).
function plistArgs(text) {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(String(text || ''));
  if (!block) return null;
  return (block[1].match(/<string>([\s\S]*?)<\/string>/g) || []).map(function (s) {
    return xmlUnesc(s.replace(/<\/?string>/g, ''));
  });
}
function installLaunchd(opts) {
  opts = opts || {};
  const runner = opts.run || run;
  const p = plistPath(opts.home);
  const c = autoswitchCommand(opts);
  // Refuse to schedule something that cannot run: a 127 every two minutes is worse than no service,
  // because `status` used to call it installed.
  const bad = selfbin.problems(c, { fs: opts.fs });
  if (bad.length) return { ok: false, reason: 'unrunnable', detail: bad.join('; '), path: p };
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.mkdirSync(path.dirname(logPath(opts.home)), { recursive: true });
    fs.writeFileSync(p, buildPlist(Object.assign({}, opts, { command: c })));
  } catch (e) {
    return { ok: false, reason: 'write-failed', detail: e.message };
  }
  runner('launchctl', ['unload', p]); // idempotent
  const r = runner('launchctl', ['load', p]);
  return {
    ok: !r || r.code === 0,
    path: p,
    intervalSec: intervalSec(opts),
    log: logPath(opts.home),
    exec: c.exec,
    args: c.args,
    pathCopy: c.pathCopy || undefined,
  };
}
function uninstallLaunchd(opts) {
  opts = opts || {};
  const runner = opts.run || run;
  const p = plistPath(opts.home);
  const existed = fs.existsSync(p);
  runner('launchctl', ['unload', p]);
  try {
    fs.rmSync(p, { force: true });
  } catch (e) {
    /* ignore */
  }
  return { ok: true, path: p, existed: existed };
}

// `launchctl list` rows: "<pid|-> <status> <label>". status is the last exit code, or a negative
// signal number. -> { loaded, pid, lastExit } (lastExit null = never exited yet).
function launchdState(runner) {
  const r = runner('launchctl', ['list']);
  if (!r || r.code !== 0) return { loaded: null, pid: null, lastExit: null };
  const lines = String(r.stdout || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i].trim().split(/\s+/);
    if (cols.length >= 3 && cols[cols.length - 1] === LABEL) {
      const pid = /^[0-9]+$/.test(cols[0]) ? parseInt(cols[0], 10) : null;
      const st = /^-?[0-9]+$/.test(cols[1]) ? parseInt(cols[1], 10) : null;
      return { loaded: true, pid: pid, lastExit: st };
    }
  }
  return { loaded: false, pid: null, lastExit: null };
}

// What a last exit code means, in words — 127 is the one this module was rewritten for.
function explainExit(code) {
  if (code === null || code === undefined) return null;
  if (code === 0) return 'ok';
  if (code === 127) return 'command not found (the program or its interpreter is not on launchd PATH)';
  if (code === 126) return 'not executable';
  if (code < 0) return 'killed by signal ' + -code;
  return 'exited with ' + code + ' (see the log)';
}

// ---- Linux crontab (*/N minutes) ----
function cronLine(opts) {
  opts = opts || {};
  const c = opts.command || autoswitchCommand(opts);
  const everyMin = Math.max(1, Math.round(intervalSec(opts) / 60));
  const spec =
    everyMin >= 60 ? '0 */' + Math.min(23, Math.round(everyMin / 60)) + ' * * *' : '*/' + everyMin + ' * * * *';
  return (
    spec +
    ' ' +
    [c.exec].concat(c.args).map(shq).join(' ') +
    ' >>' +
    shq(cronLogPath(opts.home)) +
    ' 2>&1  ' +
    CRON_MARK
  );
}
function readCron(runner) {
  const r = runner('crontab', ['-l']);
  return r && r.code === 0 ? String(r.stdout || '') : '';
}
function installCron(opts) {
  opts = opts || {};
  const runner = opts.run || run;
  const c = autoswitchCommand(opts);
  const bad = selfbin.problems(c, { fs: opts.fs });
  if (bad.length) return { ok: false, reason: 'unrunnable', detail: bad.join('; ') };
  try {
    fs.mkdirSync(path.dirname(cronLogPath(opts.home)), { recursive: true });
  } catch (e) {
    /* the redirect then fails visibly in cron's mail, not silently */
  }
  const kept = readCron(runner)
    .split('\n')
    .filter(function (l) {
      return l.trim() && l.indexOf(CRON_MARK) === -1;
    });
  kept.push(cronLine(Object.assign({}, opts, { command: c })));
  const r = runner('crontab', ['-'], kept.join('\n') + '\n');
  return { ok: !!(r && r.code === 0), intervalSec: intervalSec(opts), log: cronLogPath(opts.home) };
}
function uninstallCron(opts) {
  opts = opts || {};
  const runner = opts.run || run;
  const all = readCron(runner).split('\n');
  const kept = all.filter(function (l) {
    return l.trim() && l.indexOf(CRON_MARK) === -1;
  });
  const existed = all.some(function (l) {
    return l.indexOf(CRON_MARK) !== -1;
  });
  const r = runner('crontab', ['-'], kept.length ? kept.join('\n') + '\n' : '');
  return { ok: !!(r && r.code === 0), existed: existed };
}

// ---- platform dispatch ----
function install(ctx, opts) {
  opts = Object.assign({}, opts);
  if (ctx.platform === 'darwin') return Object.assign({ kind: 'launchd' }, installLaunchd(opts));
  if (ctx.platform === 'linux') return Object.assign({ kind: 'cron' }, installCron(opts));
  return { ok: false, kind: 'unsupported', reason: 'the autoswitch service is macOS/Linux-only for now' };
}
function uninstall(ctx, opts) {
  opts = Object.assign({}, opts);
  if (ctx.platform === 'darwin') return Object.assign({ kind: 'launchd' }, uninstallLaunchd(opts));
  if (ctx.platform === 'linux') return Object.assign({ kind: 'cron' }, uninstallCron(opts));
  return { ok: false, kind: 'unsupported' };
}
function argOf(args, flag) {
  const i = (args || []).indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}
// installed ≠ working. `healthy` is true only when the job is installed, loaded, its argv can run,
// and its last run (if any) exited 0. `problems` says what to fix; `fix` is the command.
function status(ctx, opts) {
  opts = opts || {};
  const runner = opts.run || run;
  if (ctx.platform === 'darwin') {
    const p = plistPath(opts.home);
    if (!fs.existsSync(p)) return { kind: 'launchd', installed: false, healthy: false, path: p };
    let argv = null;
    try {
      argv = plistArgs(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      argv = null;
    }
    const out = { kind: 'launchd', installed: true, path: p, log: logPath(opts.home) };
    const problems =
      argv && argv.length
        ? selfbin.problems({ exec: argv[0], args: argv.slice(1) }, { fs: opts.fs })
        : ['the plist has no ProgramArguments'];
    out.program = argv ? argv[0] : null;
    out.threshold = argv ? parseInt(argOf(argv, '--threshold'), 10) || null : null;
    out.strategy = argv ? argOf(argv, '--strategy') : null;
    const ls = launchdState(runner);
    out.loaded = ls.loaded;
    out.pid = ls.pid;
    out.lastExit = ls.lastExit;
    out.lastExitMeaning = explainExit(ls.lastExit);
    if (ls.loaded === false) problems.push('the plist exists but launchd has not loaded it');
    if (ls.lastExit !== null && ls.lastExit !== 0) problems.push('last run failed: ' + explainExit(ls.lastExit));
    out.problems = problems;
    out.healthy = problems.length === 0;
    if (!out.healthy) out.fix = 'keyflip autoswitch install   (rewrites the job with an absolute node path)';
    return out;
  }
  if (ctx.platform === 'linux') {
    const line = readCron(runner)
      .split('\n')
      .filter(function (l) {
        return l.indexOf(CRON_MARK) !== -1;
      })[0];
    if (!line) return { kind: 'cron', installed: false, healthy: false };
    return { kind: 'cron', installed: true, healthy: true, log: cronLogPath(opts.home) };
  }
  return { kind: 'unsupported', installed: false, healthy: false };
}

export {
  LABEL,
  CRON_MARK,
  autoswitchCommand,
  intervalSec,
  buildPlist,
  plistArgs,
  cronLine,
  plistPath,
  logPath,
  launchdState,
  explainExit,
  installLaunchd,
  uninstallLaunchd,
  installCron,
  uninstallCron,
  install,
  uninstall,
  status,
};
