'use strict';
// C2: schedule `keyflip dream --apply` to run UNATTENDED (nightly). Command-activated, NOT
// a daemon — the user explicitly installs/removes it. macOS = a launchd user agent; Linux =
// a crontab line; else unsupported (documented). Runner + home are injectable so tests never
// touch the real system.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { run } = require('./exec');

const LABEL = 'com.keyflip.dream';
const CRON_MARK = '# keyflip-dream (managed by keyflip)';

// The command that runs the nightly dream — the installed `keyflip`, else this checkout.
function dreamCommand(opts) {
  opts = opts || {};
  const runner = opts.run || run;
  let bin = null;
  const w = runner('which', ['keyflip']);
  if (w && w.code === 0 && String(w.stdout).trim()) bin = String(w.stdout).trim();
  if (!bin) bin = path.join(__dirname, '..', 'bin', 'keyflip.js');
  // SECURITY: `days` may arrive from the MCP tool (args.older_than_days), which is NOT
  // schema-validated server-side, and it flows unescaped into the Linux cron `/bin/sh -c`
  // line. Coerce to a bounded integer at the source so it can never carry shell metachars.
  const days = Math.max(1, Math.min(3650, parseInt(opts.days, 10) || 30));
  const args = ['dream', '--apply', '--older-than', days + 'd'];
  if (opts.archive) args.push('--archive');
  return bin.slice(-3) === '.js'
    ? { exec: process.execPath, args: [bin].concat(args) }
    : { exec: bin, args: args };
}

function parseAt(at) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at || '03:00'));
  return m ? { h: Math.min(23, parseInt(m[1], 10)), m: Math.min(59, parseInt(m[2], 10)) } : { h: 3, m: 0 };
}
function xmlEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ---- macOS launchd ----
function plistPath(home) { return path.join(home || os.homedir(), 'Library', 'LaunchAgents', LABEL + '.plist'); }
function buildPlist(opts) {
  const c = dreamCommand(opts);
  const t = parseAt(opts.at);
  const prog = [c.exec].concat(c.args).map(function (a) { return '      <string>' + xmlEsc(a) + '</string>'; }).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n  <dict>\n' +
    '    <key>Label</key><string>' + LABEL + '</string>\n' +
    '    <key>ProgramArguments</key>\n    <array>\n' + prog + '\n    </array>\n' +
    '    <key>StartCalendarInterval</key>\n    <dict><key>Hour</key><integer>' + t.h + '</integer><key>Minute</key><integer>' + t.m + '</integer></dict>\n' +
    '    <key>RunAtLoad</key><false/>\n  </dict>\n</plist>\n';
}
function installLaunchd(opts) {
  opts = opts || {};
  const runner = opts.run || run;
  const p = plistPath(opts.home);
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buildPlist(opts)); }
  catch (e) { return { ok: false, reason: 'write-failed', detail: e.message }; }
  runner('launchctl', ['unload', p]); // idempotent: drop any prior copy
  const r = runner('launchctl', ['load', p]);
  return { ok: !r || r.code === 0, path: p, when: parseAt(opts.at) };
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

// ---- Linux crontab ----
function cronLine(opts) {
  const c = dreamCommand(opts);
  const t = parseAt(opts.at);
  return t.m + ' ' + t.h + ' * * * ' + [c.exec].concat(c.args).join(' ') + '  ' + CRON_MARK;
}
function readCron(runner) { const r = runner('crontab', ['-l']); return r && r.code === 0 ? String(r.stdout || '') : ''; }
function installCron(opts) {
  opts = opts || {};
  const runner = opts.run || run;
  const kept = readCron(runner).split('\n').filter(function (l) { return l.trim() && l.indexOf(CRON_MARK) === -1; });
  kept.push(cronLine(opts));
  const r = runner('crontab', ['-'], kept.join('\n') + '\n');
  return { ok: !!(r && r.code === 0), when: parseAt(opts.at) };
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
  return { ok: false, kind: 'unsupported', reason: 'scheduling is macOS/Linux-only for now' };
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
  dreamCommand: dreamCommand, parseAt: parseAt, buildPlist: buildPlist, cronLine: cronLine,
  plistPath: plistPath, installLaunchd: installLaunchd, uninstallLaunchd: uninstallLaunchd,
  installCron: installCron, uninstallCron: uninstallCron,
  install: install, uninstall: uninstall, status: status,
};
