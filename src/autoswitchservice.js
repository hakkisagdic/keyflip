'use strict';
// The autoswitch PILOT as an unattended background service. `keyflip autoswitch` alone is a
// foreground loop you must keep a terminal open for — so it never runs when you actually need it.
// This installs a scheduled `keyflip autoswitch --once -y` that fires on an INTERVAL (macOS launchd
// StartInterval; Linux cron */N) so account rotation happens on its own while you keep using Claude.
//
// Command-activated, NOT a hidden daemon: the user explicitly installs/removes it. Runner + home are
// injectable so tests never touch the real launchctl/crontab. Sibling of schedule.js (dream's
// nightly CALENDAR job); this one is INTERVAL-based and left separate so dream stays untouched.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { run } = require('./exec');

const LABEL = 'com.keyflip.autoswitch';
const CRON_MARK = '# keyflip-autoswitch (managed by keyflip)';

function xmlEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Resolve the `keyflip` entrypoint the same way dream's scheduler does: the installed binary if
// on PATH, else this checkout's bin/keyflip.js under the current node.
function autoswitchCommand(opts) {
  opts = opts || {};
  const runner = opts.run || run;
  let bin = null;
  const w = runner('which', ['keyflip']);
  if (w && w.code === 0 && String(w.stdout).trim()) bin = String(w.stdout).trim();
  if (!bin) bin = path.join(__dirname, '..', 'bin', 'keyflip.js');
  // A scheduled tick is non-interactive: --once does exactly one check, -y skips the confirm.
  // threshold/strategy/group are bounded/whitelisted at the source so they can never carry shell
  // metacharacters into the Linux cron `/bin/sh -c` line.
  const args = ['autoswitch', '--once', '-y'];
  const th = parseInt(opts.threshold, 10);
  if (!isNaN(th)) args.push('--threshold', String(Math.min(100, Math.max(50, th))));
  if (opts.strategy === 'best' || opts.strategy === 'next-available') args.push('--strategy', opts.strategy);
  if (opts.group && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opts.group)) args.push('--group', opts.group);
  return bin.slice(-3) === '.js'
    ? { exec: process.execPath, args: [bin].concat(args) }
    : { exec: bin, args: args };
}

// Interval in seconds, clamped so a runaway config can't hammer the endpoint (min 60s) or drift
// uselessly long (max 6h). launchd wants seconds; cron gets whole minutes (min 1).
function intervalSec(opts) { return Math.min(21600, Math.max(60, parseInt(opts && opts.interval, 10) || 300)); }

// ---- macOS launchd (StartInterval) ----
function plistPath(home) { return path.join(home || os.homedir(), 'Library', 'LaunchAgents', LABEL + '.plist'); }
function buildPlist(opts) {
  const c = autoswitchCommand(opts);
  const prog = [c.exec].concat(c.args).map(function (a) { return '      <string>' + xmlEsc(a) + '</string>'; }).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n  <dict>\n' +
    '    <key>Label</key><string>' + LABEL + '</string>\n' +
    '    <key>ProgramArguments</key>\n    <array>\n' + prog + '\n    </array>\n' +
    '    <key>StartInterval</key><integer>' + intervalSec(opts) + '</integer>\n' +
    '    <key>RunAtLoad</key><true/>\n  </dict>\n</plist>\n';
}
function installLaunchd(opts) {
  opts = opts || {};
  const runner = opts.run || run;
  const p = plistPath(opts.home);
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buildPlist(opts)); }
  catch (e) { return { ok: false, reason: 'write-failed', detail: e.message }; }
  runner('launchctl', ['unload', p]); // idempotent
  const r = runner('launchctl', ['load', p]);
  return { ok: !r || r.code === 0, path: p, intervalSec: intervalSec(opts) };
}
function uninstallLaunchd(opts) {
  opts = opts || {};
  const runner = opts.run || run;
  const p = plistPath(opts.home);
  const existed = fs.existsSync(p);
  runner('launchctl', ['unload', p]);
  try { fs.rmSync(p, { force: true }); } catch (e) { /* ignore */ }
  return { ok: true, path: p, existed: existed };
}

// ---- Linux crontab (*/N minutes) ----
function cronLine(opts) {
  const c = autoswitchCommand(opts);
  const everyMin = Math.max(1, Math.round(intervalSec(opts) / 60));
  const spec = everyMin >= 60 ? '0 */' + Math.min(23, Math.round(everyMin / 60)) + ' * * *' : '*/' + everyMin + ' * * * *';
  return spec + ' ' + [c.exec].concat(c.args).join(' ') + '  ' + CRON_MARK;
}
function readCron(runner) { const r = runner('crontab', ['-l']); return r && r.code === 0 ? String(r.stdout || '') : ''; }
function installCron(opts) {
  opts = opts || {};
  const runner = opts.run || run;
  const kept = readCron(runner).split('\n').filter(function (l) { return l.trim() && l.indexOf(CRON_MARK) === -1; });
  kept.push(cronLine(opts));
  const r = runner('crontab', ['-'], kept.join('\n') + '\n');
  return { ok: !!(r && r.code === 0), intervalSec: intervalSec(opts) };
}
function uninstallCron(opts) {
  opts = opts || {};
  const runner = opts.run || run;
  const all = readCron(runner).split('\n');
  const kept = all.filter(function (l) { return l.trim() && l.indexOf(CRON_MARK) === -1; });
  const existed = all.some(function (l) { return l.indexOf(CRON_MARK) !== -1; });
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
function status(ctx, opts) {
  opts = opts || {};
  const runner = opts.run || run;
  if (ctx.platform === 'darwin') { const p = plistPath(opts.home); return { kind: 'launchd', installed: fs.existsSync(p), path: p }; }
  if (ctx.platform === 'linux') { return { kind: 'cron', installed: readCron(runner).indexOf(CRON_MARK) !== -1 }; }
  return { kind: 'unsupported', installed: false };
}

module.exports = {
  LABEL: LABEL, CRON_MARK: CRON_MARK,
  autoswitchCommand: autoswitchCommand, intervalSec: intervalSec,
  buildPlist: buildPlist, cronLine: cronLine, plistPath: plistPath,
  installLaunchd: installLaunchd, uninstallLaunchd: uninstallLaunchd,
  installCron: installCron, uninstallCron: uninstallCron,
  install: install, uninstall: uninstall, status: status,
};
