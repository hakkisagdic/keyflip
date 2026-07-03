'use strict';
// Planning helpers for `keyflip reset` and `keyflip uninstall`. Pure functions —
// they compute WHAT to remove; the CLI does the confirmation and the actual I/O
// (mirrors how cmdClean keeps its side effects in cli.js).
const path = require('path');

// Runtime/derived state under configDir that `reset` clears. It all regenerates
// on next use, so wiping it returns keyflip to a clean working state WITHOUT
// touching saved accounts. Everything NOT listed here is KEPT by reset:
// accounts (<name>.json), providers/, app/ (captured desktop logins), backups/,
// pre-sync-backups/, skill-backups/, sessions/, creds/, links.json,
// mcp-registry.json, installed-skills.json, .migrations.json.
const DERIVED = [
  'usage-history.jsonl',   // usage trend history
  'proxy.json',            // failover-proxy state (pid/port/wired)
  'proxy-usage.jsonl',     // per-account proxy token totals
  'breakers.json',         // circuit-breaker open/closed state
  'events.jsonl',          // autoswitch/failover event log
  '.usage-cache.json',     // cached usage probe
  '.update-check.json',    // "new version?" throttle stamp
  { name: 'logs', dir: true },
];

// Absolute paths of the derived-state entries for this context.
function derivedStatePaths(ctx) {
  return DERIVED.map(function (e) {
    const name = typeof e === 'string' ? e : e.name;
    return { path: path.join(ctx.configDir, name), name: name, dir: !!(e && e.dir) };
  });
}

// Files `uninstall` removes for an install.sh ('installer') layout — derived from
// the SAME env/defaults install.sh uses, so an overridden install location is
// still found. Order matters: the program dir (which holds the JS we're running)
// is removed last by the caller.
function installerArtifacts(opts) {
  opts = opts || {};
  const home = opts.home;
  const platform = opts.platform || process.platform;
  const shareDir = opts.shareDir || process.env.KEYFLIP_DIR || path.join(home, '.local', 'share', 'keyflip');
  const binDir = opts.binDir || process.env.KEYFLIP_BIN_DIR || path.join(home, '.local', 'bin');
  const appDir = opts.appDir || process.env.KEYFLIP_APP_DIR || path.join(home, 'Applications');
  const items = [
    { path: path.join(binDir, 'keyflip'), label: 'CLI symlink', dir: false },
  ];
  if (platform === 'darwin') items.push({ path: path.join(appDir, 'Keyflip.app'), label: 'launcher app', dir: true });
  items.push({ path: shareDir, label: 'program files', dir: true, self: true });
  return items;
}

// Full uninstall plan. `method` is update.detectInstallMethod's result plus a
// derived 'dev' when we're running out of a source checkout (never self-delete
// a repo). Returns either an npm spawn, or a file list, or a dev no-op.
//   method: 'npm' | 'installer' | 'dev'
function planUninstall(opts) {
  opts = opts || {};
  const method = opts.method;
  const platform = opts.platform || process.platform;
  const plan = { method: method, npm: null, files: [], pathNote: null };
  if (method === 'dev') return plan;                 // running from a checkout: remove nothing
  if (method === 'npm') {
    plan.npm = { cmd: platform === 'win32' ? 'npm.cmd' : 'npm', args: ['uninstall', '-g', 'keyflip'] };
    return plan;
  }
  // 'installer' (or anything else we choose to treat as an installer layout)
  plan.files = installerArtifacts(opts);
  plan.pathNote = "if present, remove the '# keyflip PATH' block from ~/.zshrc / ~/.bashrc";
  return plan;
}

// Decide install method from the running bin path. 'dev' when it's a plain
// checkout (not the installer share dir, not node_modules).
function classifyInstall(realBinPath, platform) {
  const p = realBinPath || '';
  if (p.indexOf(path.join('.local', 'share', 'keyflip')) !== -1) return 'installer';
  if (p.indexOf('node_modules') !== -1) return 'npm';
  return 'dev';
}

module.exports = {
  DERIVED: DERIVED,
  derivedStatePaths: derivedStatePaths,
  installerArtifacts: installerArtifacts,
  planUninstall: planUninstall,
  classifyInstall: classifyInstall,
};
