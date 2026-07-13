'use strict';
// G4: the always-glanceable surface WITHOUT keyflip becoming a daemon. `keyflip menubar`
// emits xbar/SwiftBar plugin format (https://xbarapp.com, https://swiftbar.app): the active
// account + 5h quota in the title, a dropdown of accounts with click-to-switch, providers,
// and quick actions. xbar/SwiftBar is the resident host that re-runs this on an interval —
// keyflip stays a plain CLI. Zero-dep; the render is pure + unit-tested.
const path = require('path');

// Resolve how to invoke keyflip from a menu-bar action (xbar runs from its own cwd, so we
// need an absolute exec). Injectable runner keeps tests hermetic.
function resolveExec(opts) {
  opts = opts || {};
  if (opts.exec) return opts.exec; // test/override
  const runner = opts.run || require('./exec').run;
  let bin = null;
  try { const w = runner('which', ['keyflip']); if (w && w.code === 0 && String(w.stdout).trim()) bin = String(w.stdout).trim(); } catch (e) { /* ignore */ }
  if (!bin) bin = path.join(__dirname, '..', 'bin', 'keyflip.js');
  return bin.slice(-3) === '.js' ? { exec: process.execPath, pre: [bin] } : { exec: bin, pre: [] };
}

// An xbar/SwiftBar clickable action: `bash=<exec> param1=.. param2=.. terminal=false`.
function action(execInfo, args) {
  const all = execInfo.pre.concat(args);
  let s = 'shell=' + execInfo.exec;
  all.forEach(function (a, i) { s += ' param' + (i + 1) + '=' + String(a); });
  return s + ' terminal=false refresh=true';
}

function pct(p) { return p == null ? '—' : Math.round(p) + '%'; }
function quotaColor(p) { return p == null ? '' : p >= 90 ? ' color=red' : p >= 70 ? ' color=orange' : ' color=green'; }
// Menu-item text must not contain a raw '|' (xbar treats it as the params delimiter) or newline.
function clean(s) { return String(s == null ? '' : s).replace(/[|\n\r]/g, ' ').trim(); }

// Render the plugin output for the given dashboard state (from panel.buildState).
function render(ctx, opts) {
  opts = opts || {};
  const panel = require('./panel');
  const s = opts.state || panel.buildState(ctx);
  const ex = resolveExec(opts);
  const accounts = s.accounts || [];
  const active = accounts.filter(function (a) { return a.active; })[0];
  const lines = [];

  // --- title (menu bar) ---
  const short = s.activeEmail ? String(s.activeEmail).split('@')[0] : (active ? (active.name) : 'keyflip');
  const q = active && active.fiveHourPct != null ? ' ' + Math.round(active.fiveHourPct) + '%' : '';
  lines.push('⚡ ' + clean(short) + q + (s.activeProvider ? ' ›' + clean(s.activeProvider) : ''));
  lines.push('---');

  // --- accounts (click a non-active one to switch) ---
  if (!accounts.length) {
    lines.push('No saved accounts | color=gray');
    lines.push('Log in, then run keyflip add | ' + action(ex, ['add']));
  } else {
    lines.push('Accounts | size=11 color=gray');
    accounts.forEach(function (a) {
      const label = (a.active ? '✓ ' : '') + clean(a.email || a.name);
      if (a.active) lines.push(label + ' | font=Menlo' + quotaColor(a.fiveHourPct));
      else lines.push(label + ' | font=Menlo' + quotaColor(a.fiveHourPct) + ' ' + action(ex, [a.name, '--restart']));
      lines.push('--5h ' + pct(a.fiveHourPct) + '  ·  7d ' + pct(a.sevenDayPct) + ' | size=11 color=gray');
    });
  }

  // --- providers ---
  if ((s.providers || []).length) {
    lines.push('---');
    lines.push('Provider | size=11 color=gray');
    s.providers.forEach(function (p) {
      lines.push((p.active ? '● ' : '○ ') + clean(p.name) + ' | size=12' + (p.active ? ' color=#7aa2f7' : ''));
    });
  }

  // --- actions ---
  lines.push('---');
  lines.push('Open dashboard | ' + action(ex, ['panel', '--open']));
  lines.push('Sync all chats (consolidate) | ' + action(ex, ['consolidate']));
  lines.push('Refresh | refresh=true');
  return lines.join('\n');
}

// Resolve the menu-bar host + its plugin folder for a platform. The plugin format (a script whose
// stdout is the menu, filename `keyflip.<interval>.sh`) is shared by macOS xbar/SwiftBar and Linux
// GNOME Argos / KDE kargos, so one render installs on both. Returns { host, dir, mustExist } or null
// when the platform has no built-in host (caller should ask for an explicit --dir).
function pluginTarget(platform, home, xdgConfigHome) {
  if (platform === 'darwin') return { host: 'xbar/SwiftBar', dir: path.join(home, 'Library', 'Application Support', 'xbar', 'plugins'), mustExist: true };
  if (platform === 'linux') return { host: 'Argos/kargos', dir: path.join(xdgConfigHome || path.join(home, '.config'), 'argos'), mustExist: false };
  return null; // win32 / others: no built-in host — the user points --dir at their tray tool
}

module.exports = { render: render, resolveExec: resolveExec, pluginTarget: pluginTarget };
