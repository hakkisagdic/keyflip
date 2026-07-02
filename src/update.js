'use strict';
// Passive update notice + self-upgrade. The check fetches the repo's package.json
// version at most once per 24h (cached in <configDir>/.update-check.json), is
// timeout-boxed, and can never block or fail a command.
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./fsutil');

const RAW_PKG_URL = 'https://raw.githubusercontent.com/hakkisagdic/ccswitch/main/package.json';
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

function cachePath(ctx) { return path.join(ctx.configDir, '.update-check.json'); }

function cmpVersions(a, b) { // 1 if a>b
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

// Latest known version (cached or freshly fetched); null when unknown.
async function latestVersion(ctx, opts) {
  opts = opts || {};
  const nowMs = opts.nowMs !== undefined ? opts.nowMs : Date.now();
  try {
    const c = JSON.parse(fs.readFileSync(cachePath(ctx), 'utf8'));
    if (c && c.at && nowMs - c.at < CHECK_EVERY_MS) return c.latest || null;
  } catch (e) { /* no cache */ }
  const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) return null;
  let latest = null;
  try {
    const res = await doFetch(RAW_PKG_URL, {
      signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(opts.timeoutMs || 2000) : undefined,
    });
    if (res && res.ok) latest = (await res.json()).version || null;
  } catch (e) { latest = null; }
  try { atomicWrite(cachePath(ctx), JSON.stringify({ at: nowMs, latest: latest }), 0o600); } catch (e) { /* ignore */ }
  return latest;
}

// Print a one-line stderr notice when a newer version exists. Never throws.
async function maybeNotify(ctx, currentVersion, opts) {
  opts = opts || {};
  if (opts.suppress) return null;
  try {
    const latest = await latestVersion(ctx, opts);
    if (latest && cmpVersions(latest, currentVersion) > 0) {
      (opts.stderr || process.stderr).write(
        'ℹ️  ccswitch ' + latest + ' is available (you have ' + currentVersion + ') — run: ccswitch upgrade\n');
      return latest;
    }
  } catch (e) { /* never block a command on this */ }
  return null;
}

// How was this copy installed? -> 'installer' (install.sh copy) | 'npm' | 'unknown'
function detectInstallMethod(binPath) {
  let real = binPath;
  try { real = fs.realpathSync(binPath); } catch (e) { /* keep */ }
  if (real.indexOf(path.join('.local', 'share', 'ccswitch')) !== -1) return 'installer';
  if (real.indexOf('node_modules') !== -1) return 'npm';
  return 'unknown';
}

// Human-readable command (for messages/manual fallback).
function upgradeCommand(method, platform) {
  platform = platform || process.platform;
  if (method === 'installer') {
    return platform === 'win32'
      ? 'irm https://raw.githubusercontent.com/hakkisagdic/ccswitch/main/install.ps1 | iex'
      : 'curl -fsSL https://raw.githubusercontent.com/hakkisagdic/ccswitch/main/install.sh | bash';
  }
  if (method === 'npm') return 'npm install -g git+https://github.com/hakkisagdic/ccswitch.git';
  return null;
}

// The actual { cmd, args } to spawn — platform-appropriate, no shell assumptions
// (bash isn't present on Windows). npm is invoked directly (npm.cmd on Windows).
function upgradeSpawn(method, platform) {
  platform = platform || process.platform;
  if (method === 'npm') {
    return { cmd: platform === 'win32' ? 'npm.cmd' : 'npm', args: ['install', '-g', 'git+https://github.com/hakkisagdic/ccswitch.git'] };
  }
  if (method === 'installer') {
    if (platform === 'win32') {
      return { cmd: 'powershell', args: ['-NoProfile', '-Command', 'irm https://raw.githubusercontent.com/hakkisagdic/ccswitch/main/install.ps1 | iex'] };
    }
    return { cmd: 'bash', args: ['-lc', 'curl -fsSL https://raw.githubusercontent.com/hakkisagdic/ccswitch/main/install.sh | bash'] };
  }
  return null;
}

module.exports = {
  latestVersion: latestVersion,
  maybeNotify: maybeNotify,
  cmpVersions: cmpVersions,
  detectInstallMethod: detectInstallMethod,
  upgradeCommand: upgradeCommand,
  upgradeSpawn: upgradeSpawn,
  RAW_PKG_URL: RAW_PKG_URL,
};
