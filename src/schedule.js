// C2 + #36: schedule keyflip's unattended jobs (nightly `dream --apply`, nightly `refresh --all`)
// to run WITHOUT a human. Command-activated, NOT a daemon — the user explicitly installs/removes
// each one. macOS = a launchd user agent; Linux = a crontab line; else unsupported (documented).
// Runner + home are injectable so tests never touch the real system.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { run } from './exec.js';
import { atomicWrite } from './fsutil.js';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LABEL = 'com.keyflip.dream';
const CRON_MARK = '# keyflip-dream (managed by keyflip)';
const REFRESH_LABEL = 'com.keyflip.refresh';
const REFRESH_CRON_MARK = '# keyflip-refresh (managed by keyflip)';
const DAEMON_LABEL = 'com.keyflip.refresh-daemon';
const DAEMON_CRON_MARK = '# keyflip-refresh-daemon (managed by keyflip)';
const CONV_LABEL = 'com.keyflip.conv-index';
const CONV_CRON_MARK = '# keyflip-conv-index (managed by keyflip)';

// The conversation index runs on an INTERVAL, not at a wall-clock time: search must find the chat
// you just had, not the chat you had before lunch. These are the intervals the flag accepts, in
// minutes. Only values that are valid in BOTH launchd (seconds) and cron (`*/N` minutes) are
// allowed, so one flag means the same thing on macOS and Linux.
const CONV_INTERVALS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];

// Where the keyflip binary is: the installed `keyflip`, else this checkout. Injectable runner so
// tests never shell out. Returns the resolved path UNCHANGED — how to run it is argvFor's call alone.
function keyflipBin(opts) {
  opts = opts || {};
  const runner = opts.run || run;
  let bin = null;
  const w = runner('which', ['keyflip']);
  if (w && w.code === 0 && String(w.stdout).trim()) bin = String(w.stdout).trim();
  if (!bin) bin = path.join(__dirname, '..', 'bin', 'keyflip.js');
  return bin;
}
// ONE decision, made on the resolved script path: a `.js` bin must be run BY node, with the script
// itself as the first argument; a real installed binary is executed directly. Splitting this test
// across two functions is exactly how a scheduled job once launched `node refresh --all` with no
// script at all — the second check looked at the already-transformed value and never saw the path.
function argvFor(bin, args) {
  return bin.slice(-3) === '.js' ? { exec: process.execPath, args: [bin].concat(args) } : { exec: bin, args: args };
}

// The command that runs the nightly dream —
function dreamCommand(opts) {
  opts = opts || {};
  const bin = keyflipBin(opts);
  // SECURITY: `days` may arrive from the MCP tool (args.older_than_days), which is NOT
  // schema-validated server-side, and it flows unescaped into the Linux cron `/bin/sh -c`
  // line. Coerce to a bounded integer at the source so it can never carry shell metachars.
  const days = Math.max(1, Math.min(3650, parseInt(opts.days, 10) || 30));
  const args = ['dream', '--apply', '--older-than', days + 'd'];
  if (opts.archive) args.push('--archive');
  return argvFor(bin, args);
}

// #36: the command that keeps every stored token alive. `opts` is used ONLY to resolve the binary
// through the injectable runner — it contributes nothing to argv, so this job cannot be steered by
// an untrusted value the way `older_than_days` could. An idle Claude is enforced by `cmdRefresh`
// itself (it refuses to rotate a token something is holding), so a badly-timed run changes nothing
// instead of logging someone out.
function refreshCommand(opts) {
  return argvFor(keyflipBin(opts), ['refresh', '--all']);
}

// Background refresh daemon: runs continuously as a KeepAlive process, checking expiry every 5 min
function daemonCommand(opts) {
  const bin = path.join(__dirname, '..', 'bin', 'keyflip-refresh.js');
  // The daemon binary must be run by node regardless of installation state
  return { exec: process.execPath, args: [bin] };
}

// The conversation index, refreshed on an interval so `keyflip conv search` never returns a
// stale answer. The pass is incremental: an unchanged transcript is one `stat()`, and `--embed`
// only covers chunks that are new or changed, so a tick costs seconds, not an hour.
function convCommand(opts) {
  const args = ['conv', 'index', '--embed'];
  // `--no-embed` keeps the lexical index current without asking the embedding endpoint for
  // anything — useful when the local model is not running.
  if (opts && opts.embed === false) args.pop();
  return argvFor(keyflipBin(opts), args);
}

function parseAt(at) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at || '03:00'));
  return m ? { h: Math.min(23, parseInt(m[1], 10)), m: Math.min(59, parseInt(m[2], 10)) } : { h: 3, m: 0 };
}
function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The jobs, in one table, so a new scheduled command cannot forget a label / marker / receipt.
// `dream` is the default everywhere: every call site and test written before #36 stays valid.
// `install` and `does` are here too because `doctor` lists the whole inventory: a job that can be
// scheduled must also be explainable, and a second table is how a job gets forgotten.
const JOBS = {
  dream: {
    name: 'dream',
    label: LABEL,
    cronMark: CRON_MARK,
    record: 'dream-schedule.json',
    at: '03:00',
    command: dreamCommand,
    llm: true,
    install: 'keyflip dream schedule --at 03:00',
    does: 'distills old chats into keepsakes overnight (runs a model, so check `keyflip llm status`)',
  },
  refresh: {
    name: 'refresh',
    label: REFRESH_LABEL,
    cronMark: REFRESH_CRON_MARK,
    record: 'refresh-schedule.json',
    at: '04:30',
    command: refreshCommand,
    llm: false,
    install: 'keyflip refresh --schedule',
    does: 'renews every stored token before it dies on the calendar',
  },
  daemon: {
    name: 'daemon',
    label: DAEMON_LABEL,
    cronMark: DAEMON_CRON_MARK,
    record: 'refresh-daemon-schedule.json',
    at: null, // daemon runs continuously, no schedule time
    command: daemonCommand,
    llm: false,
    install: 'keyflip refresh --daemon-start',
    does: 'watches credential expiry every 5 min and refreshes what is about to die',
  },
  conv: {
    name: 'conv',
    label: CONV_LABEL,
    cronMark: CONV_CRON_MARK,
    record: 'conv-index-schedule.json',
    at: null, // interval-based, no wall-clock time
    interval: 30, // minutes between passes
    command: convCommand,
    llm: false,
    install: 'keyflip conv index --schedule',
    does: 'keeps every local chat from every tool searchable',
  },
};
function jobOf(opts) {
  const j = opts && opts.job;
  return j && JOBS[j] ? JOBS[j] : JOBS.dream;
}
// The time a job runs: its own `--at`, else its own default (a dream at 03:00, a refresh at 04:30 —
// deliberately NOT the same hour, so a token rotation cannot race the distill that reads those chats).
// Daemon and interval jobs have no schedule time (they run continuously / on a cadence), so return
// null for them.
function whenOf(opts) {
  const job = jobOf(opts);
  if (!job.at) return null;
  return parseAt((opts && opts.at) || job.at);
}

// How often an interval-based job runs, in MINUTES. Only the allowed values are honoured, so the
// same flag cannot mean "every 7 minutes" on launchd and "every 7 hours" on cron. An unknown value
// falls back to the job's default.
function intervalOf(opts) {
  const job = jobOf(opts);
  if (!job.interval) return null;
  const raw = opts && opts.interval != null ? parseInt(opts.interval, 10) : job.interval;
  for (const m of CONV_INTERVALS) if (m === raw) return m;
  return job.interval;
}

// ---- macOS launchd ----
function plistPath(home, opts) {
  return path.join(home || os.homedir(), 'Library', 'LaunchAgents', jobOf(opts).label + '.plist');
}
// An unattended job writes two files nobody would otherwise look at: stdout and stderr. Without
// them a job that silently did nothing is indistinguishable from a job that never ran.
function logPath(home, opts) {
  const dir = path.join(home || os.homedir(), 'Library', 'Logs');
  return path.join(dir, jobOf(opts).name + '-keyflip.log');
}
function buildPlist(opts) {
  opts = opts || {};
  const job = jobOf(opts);
  const c = job.command(opts);
  const t = whenOf(opts);
  const prog = [c.exec]
    .concat(c.args)
    .map(function (a) {
      return '      <string>' + xmlEsc(a) + '</string>';
    })
    .join('\n');
  const log = xmlEsc(logPath(opts.home, opts));

  // An interval job runs every N minutes (StartInterval), a daemon runs continuously (KeepAlive),
  // and a nightly job runs at a wall-clock time (StartCalendarInterval).
  let startSection;
  if (job.interval) {
    startSection = '    <key>StartInterval</key>\n    <integer>' + intervalOf(opts) * 60 + '</integer>\n';
  } else if (job.name === 'daemon') {
    startSection = '    <key>KeepAlive</key><true/>\n';
  } else {
    startSection =
      '    <key>StartCalendarInterval</key>\n    <dict><key>Hour</key><integer>' +
      t.h +
      '</integer><key>Minute</key><integer>' +
      t.m +
      '</integer></dict>\n';
  }

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n  <dict>\n' +
    '    <key>Label</key><string>' +
    job.label +
    '</string>\n' +
    '    <key>ProgramArguments</key>\n    <array>\n' +
    prog +
    '\n    </array>\n' +
    startSection +
    // launchd kills the job's whole process group when the job exits. That is exactly what murdered
    // the nohup workers a scheduled dream used to start (verified live: the supervisor's exit took
    // them with it). AbandonProcessGroup lets detached children finish their work.
    '    <key>AbandonProcessGroup</key><true/>\n' +
    '    <key>StandardOutPath</key><string>' +
    log +
    '</string>\n' +
    '    <key>StandardErrorPath</key><string>' +
    log +
    '</string>\n' +
    '    <key>RunAtLoad</key><false/>\n  </dict>\n</plist>\n'
  );
}
function installLaunchd(opts) {
  opts = opts || {};
  const runner = opts.run || run;
  const p = plistPath(opts.home, opts);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buildPlist(opts));
  } catch (e) {
    return { ok: false, reason: 'write-failed', detail: e.message };
  }
  runner('launchctl', ['unload', p]); // idempotent: drop any prior copy
  const r = runner('launchctl', ['load', p]);
  return { ok: !r || r.code === 0, path: p, when: whenOf(opts), log: logPath(opts.home, opts) };
}
function uninstallLaunchd(opts) {
  opts = opts || {};
  const runner = opts.run || run;
  const p = plistPath(opts.home, opts);
  const existed = fs.existsSync(p);
  runner('launchctl', ['unload', p]);
  try {
    fs.rmSync(p, { force: true });
  } catch (e) {
    /* ignore */
  }
  return { ok: true, path: p, existed: existed };
}

// ---- Linux crontab ----
function cronLine(opts) {
  opts = opts || {};
  const job = jobOf(opts);
  const c = job.command(opts);

  // Daemon jobs run via @reboot instead of time-based scheduling
  if (job.name === 'daemon') {
    return '@reboot ' + [c.exec].concat(c.args).join(' ') + '  ' + job.cronMark;
  }

  // An interval job runs every N minutes. The minutes are restricted to divisors of 60 that
  // cron accepts in a `*/N` field, so this line means the same thing as the launchd one.
  if (job.interval) {
    return '*/' + intervalOf(opts) + ' * * * * ' + [c.exec].concat(c.args).join(' ') + '  ' + job.cronMark;
  }

  const t = whenOf(opts);
  return t.m + ' ' + t.h + ' * * * ' + [c.exec].concat(c.args).join(' ') + '  ' + job.cronMark;
}
function readCron(runner) {
  const r = runner('crontab', ['-l']);
  return r && r.code === 0 ? String(r.stdout || '') : '';
}
function installCron(opts) {
  opts = opts || {};
  const runner = opts.run || run;
  const mark = jobOf(opts).cronMark;
  const kept = readCron(runner)
    .split('\n')
    .filter(function (l) {
      return l.trim() && l.indexOf(mark) === -1;
    });
  kept.push(cronLine(opts));
  const r = runner('crontab', ['-'], kept.join('\n') + '\n');
  return { ok: !!(r && r.code === 0), when: whenOf(opts) };
}
function uninstallCron(opts) {
  opts = opts || {};
  const runner = opts.run || run;
  const mark = jobOf(opts).cronMark;
  const all = readCron(runner).split('\n');
  const kept = all.filter(function (l) {
    return l.trim() && l.indexOf(mark) === -1;
  });
  const existed = all.some(function (l) {
    return l.indexOf(mark) !== -1;
  });
  const r = runner('crontab', ['-'], kept.length ? kept.join('\n') + '\n' : '');
  return { ok: !!(r && r.code === 0), existed: existed };
}

// Is launchd actually HOLDING this job? `installed` only proves a plist is on disk: a job can be
// written and never loaded, unloaded by a logout, or left behind by a moved repo, and printing
// "scheduled" from the file alone would then be a lie. `launchctl list <label>` answers it locally —
// exit 0 plus the job's own description when loaded, exit 113 "Could not find service" when not.
// NOTE the honest meaning: loaded = enrolled and will fire on its cadence, NOT "running right now".
function launchdLoaded(label, runner) {
  const r = runner('launchctl', ['list', label]);
  if (!r || r.code !== 0) return false;
  // Require the label back in the output: a runner that answers 0 with nothing (a stub, a stripped
  // launchctl) must not be read as proof that the job exists.
  return String((r && r.stdout) || '').indexOf(label) !== -1;
}

// When the job last produced anything. launchd appends the job's stdout/stderr to its log file, so a
// log older than twice the cadence means the job is not running even though the plist says it should.
function lastRunAt(logPathStr) {
  try {
    const st = fs.statSync(logPathStr);
    return st.mtime.toISOString();
  } catch (e) {
    return null; // no log at all: the job has never written anything
  }
}

// ---- platform dispatch ----
// The schedule ALSO records what it was installed to use, in keyflip's own state dir: a nightly
// job that quietly starts spending subscription quota is a bill nobody agreed to. This is metadata
// only (provider name, model, cadence) — never a key, never a transcript.
// One receipt FILE per job, on purpose: `doctor`'s chore-provider check compares the live
// `llm.provider` against the DREAM receipt, and a refresh job runs no model at all. A shared
// receipt would compare a dream's provider against a job that never calls an LLM.
const RECORD_NAME = 'dream-schedule.json';
const REFRESH_RECORD_NAME = 'refresh-schedule.json';
function recordPath(ctx, opts) {
  const dir = (opts && opts.configDir) || (ctx && ctx.configDir);
  return dir ? path.join(dir, jobOf(opts).record) : null;
}
function readRecord(ctx, opts) {
  const p = recordPath(ctx, opts);
  if (!p) return null;
  try {
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    return o && typeof o === 'object' ? o : null;
  } catch (e) {
    return null;
  }
}
function writeRecord(ctx, rec, opts) {
  const p = recordPath(ctx, opts);
  if (!p) return false;
  try {
    atomicWrite(p, JSON.stringify(rec, null, 2) + '\n', 0o600);
    return true;
  } catch (e) {
    return false;
  }
}
function dropRecord(ctx, opts) {
  const p = recordPath(ctx, opts);
  if (!p) return;
  try {
    fs.rmSync(p, { force: true });
  } catch (e) {
    /* ignore */
  }
}

// How often a job is supposed to produce something, in ms, or null when it has no cadence to age
// against (a KeepAlive daemon writes only when something happens). An interval job is measured
// against the cadence it was INSTALLED with, because the receipt is the contract: a job set to 5
// minutes that has been silent for two hours is failing, while one set to 12 hours is not.
function cadenceMsOf(job, rec) {
  if (job.interval) {
    const minutes = rec && rec.interval ? rec.interval : job.interval;
    return minutes * 60000;
  }
  if (job.name === 'daemon') return null;
  return 24 * 3600 * 1000; // nightly
}

// How a job is scheduled, in one word — so a report never calls the always-on daemon "nightly".
function modeOf(job) {
  if (job.interval) return 'interval';
  if (job.name === 'daemon') return 'continuous';
  return 'nightly';
}
// The wall-clock hour a nightly job runs at, normalized to "HH:MM". The receipt stores a parsed
// `{h, m}` while the JOBS default is the string it was parsed from, and a consumer should not have
// to know which of the two it is holding.
function hhmm(rec, job) {
  const a = rec && rec.at ? rec.at : job.at;
  if (!a) return null;
  if (typeof a === 'string') return a;
  if (typeof a.h === 'number') return String(a.h).padStart(2, '0') + ':' + String(a.m || 0).padStart(2, '0');
  return null;
}

// Every job, with what the system actually says about it. Shared by `doctor`'s background-services
// check and any future inventory view, so "is it installed / is launchd holding it / when did it
// last speak" is answered in one place.
function inventory(ctx, opts) {
  opts = opts || {};
  return Object.keys(JOBS).map(function (name) {
    const job = JOBS[name];
    const st = status(ctx, Object.assign({ job: name }, opts));
    const rec = st.recorded;
    // The promise date: the receipt when there is one, else the plist's own mtime — an install older
    // than receipts still has a file that says when it was made.
    let agreedAt = rec && rec.installedAt ? rec.installedAt : null;
    if (!agreedAt && st.path) {
      try {
        agreedAt = fs.statSync(st.path).mtime.toISOString();
      } catch (e) {
        agreedAt = null;
      }
    }
    return {
      job: name,
      label: job.label,
      does: job.does,
      install: job.install,
      kind: st.kind,
      installed: st.installed,
      loaded: st.loaded,
      lastRun: st.lastRun,
      // The interval the job was agreed to, in minutes — null for anything with no cadence.
      everyMinutes: job.interval ? (rec && rec.interval ? rec.interval : job.interval) : null,
      cadenceMs: cadenceMsOf(job, rec),
      // When the user agreed to this job. A schedule younger than two cadences has not had its turn
      // yet, so silence is not a fault — this is what separates "never ran" from "not due yet".
      installedAt: agreedAt,
      path: st.path || null,
      log: st.log || null,
      at: rec && rec.at ? rec.at : job.at,
      // The two normalized views a report should use instead of guessing from the raw fields.
      mode: modeOf(job),
      atLabel: hhmm(rec, job),
    };
  });
}

function install(ctx, opts) {
  opts = Object.assign({}, opts);
  const job = jobOf(opts);
  const r =
    ctx.platform === 'darwin'
      ? Object.assign({ kind: 'launchd' }, installLaunchd(opts))
      : ctx.platform === 'linux'
        ? Object.assign({ kind: 'cron' }, installCron(opts))
        : { ok: false, kind: 'unsupported', reason: 'scheduling is macOS/Linux-only for now' };
  if (r.ok) {
    const rec = {
      installedAt: new Date().toISOString(),
      job: job.name,
      kind: r.kind,
      at: whenOf(opts),
    };
    // An interval job records its cadence, so `status` can say how fresh the index is without
    // re-reading the plist.
    if (job.interval) rec.interval = intervalOf(opts);
    // Only an LLM-running job has a provider to receipts. Recording "claude" against a refresh job
    // would be a lie about a bill it cannot incur.
    if (job.llm) {
      rec.days = opts.days;
      rec.archive = !!opts.archive;
      rec.provider = opts.provider || 'claude';
      rec.model = opts.model || '';
    }
    writeRecord(ctx, rec, opts);
  }
  return r;
}
function uninstall(ctx, opts) {
  opts = Object.assign({}, opts);
  let r;
  if (ctx.platform === 'darwin') r = Object.assign({ kind: 'launchd' }, uninstallLaunchd(opts));
  else if (ctx.platform === 'linux') r = Object.assign({ kind: 'cron' }, uninstallCron(opts));
  else r = { ok: false, kind: 'unsupported' };
  if (r.ok) dropRecord(ctx, opts);
  return r;
}
function status(ctx, opts) {
  opts = opts || {};
  const runner = opts.run || run;
  // `askSystem: false` answers from keyflip's own files and spawns NOTHING — for callers that must
  // stay hermetic (a test suite, anything without a shell). `loaded` is then null, meaning "not
  // asked", which is a different fact from false ("asked, and launchd does not hold it").
  const ask = opts.askSystem !== false;
  const job = jobOf(opts);
  const rec = readRecord(ctx, opts);
  if (ctx.platform === 'darwin') {
    const p = plistPath(opts.home, opts);
    const installed = fs.existsSync(p);
    const log = logPath(opts.home, opts);
    return {
      kind: 'launchd',
      job: job.name,
      installed: installed,
      // A plist on disk and a job launchd will fire are two different facts, and only the second
      // one means the thing is actually being kept current.
      loaded: !ask ? null : installed ? launchdLoaded(job.label, runner) : false,
      lastRun: lastRunAt(log),
      path: p,
      log: log,
      recorded: rec,
    };
  }
  if (ctx.platform === 'linux') {
    const installed = ask && readCron(runner).indexOf(job.cronMark) !== -1;
    return {
      kind: 'cron',
      job: job.name,
      installed: installed,
      // cron has no separate registry: a line in the table IS the loaded state. There is no log path
      // to age, so lastRun stays null rather than claiming a job never ran.
      loaded: installed,
      lastRun: null,
      recorded: rec,
    };
  }
  return { kind: 'unsupported', job: job.name, installed: false, loaded: null, lastRun: null, recorded: rec };
}

export {
  LABEL,
  CRON_MARK,
  REFRESH_LABEL,
  REFRESH_CRON_MARK,
  CONV_LABEL,
  CONV_CRON_MARK,
  CONV_INTERVALS,
  RECORD_NAME,
  REFRESH_RECORD_NAME,
  JOBS,
  jobOf,
  whenOf,
  intervalOf,
  cadenceMsOf,
  modeOf,
  hhmm,
  inventory,
  launchdLoaded,
  lastRunAt,
  dreamCommand,
  refreshCommand,
  convCommand,
  parseAt,
  buildPlist,
  logPath,
  cronLine,
  plistPath,
  installLaunchd,
  uninstallLaunchd,
  installCron,
  uninstallCron,
  readRecord,
  writeRecord,
  install,
  uninstall,
  status,
};
