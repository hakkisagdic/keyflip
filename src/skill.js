'use strict';
// #10 Bundled-skill install/freshness. The package's skills/keyflip dir is the
// single source of truth; install symlinks it into ~/.claude/skills (copy
// fallback for Windows/permission issues) so upgrades propagate. Drift is
// detected by a SHA-256 fingerprint over sorted "relpath\0content\0" of the
// non-hidden files. The old install is backed up before overwrite/removal.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sourceDir() { return path.join(__dirname, '..', 'skills', 'keyflip'); }
function installDir(ctx) { return path.join(ctx.home, '.claude', 'skills', 'keyflip'); }
function backupsDir(ctx) { return path.join(ctx.configDir, 'skill-backups'); }

function walk(dir, base, acc) {
  base = base || dir; acc = acc || [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  entries.forEach(function (e) {
    if (e.name[0] === '.') return; // skip hidden
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, acc);
    else if (e.isFile()) acc.push(path.relative(base, p));
  });
  return acc.sort();
}

// SHA-256 over sorted "relpath\0content\0" — order-independent, content-sensitive.
function fingerprint(dir) {
  const h = crypto.createHash('sha256');
  walk(dir).forEach(function (rel) {
    h.update(rel); h.update('\0');
    try { h.update(fs.readFileSync(path.join(dir, rel))); } catch (e) { /* */ }
    h.update('\0');
  });
  return h.digest('hex');
}

function isInstalled(ctx) { try { return fs.existsSync(path.join(installDir(ctx), 'SKILL.md')); } catch (e) { return false; } }

// 'current' | 'stale' | 'absent'
function status(ctx) {
  if (!isInstalled(ctx)) return 'absent';
  return fingerprint(sourceDir()) === fingerprint(installDir(ctx)) ? 'current' : 'stale';
}

function backupExisting(ctx) {
  const dest = installDir(ctx);
  if (!fs.existsSync(dest)) return null;
  fs.mkdirSync(backupsDir(ctx), { recursive: true });
  const b = path.join(backupsDir(ctx), 'keyflip-' + String(ctx.now()).replace(/[-:]/g, '').replace(/\..*$/, ''));
  try { fs.cpSync(dest, b, { recursive: true }); } catch (e) { /* best effort */ }
  // keep 20 most recent
  try {
    const all = fs.readdirSync(backupsDir(ctx)).filter(function (n) { return n.indexOf('keyflip-') === 0; }).sort();
    all.slice(0, Math.max(0, all.length - 20)).forEach(function (n) { fs.rmSync(path.join(backupsDir(ctx), n), { recursive: true, force: true }); });
  } catch (e) { /* */ }
  return b;
}

// Install (or refresh) the skill. Prefers a symlink so future upgrades are
// instant; copies on failure (Windows / no symlink permission).
function install(ctx) {
  const src = sourceDir();
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error('bundled skill missing SKILL.md — reinstall keyflip');
  const dest = installDir(ctx);
  backupExisting(ctx);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.rmSync(dest, { recursive: true, force: true }); } catch (e) { /* */ }
  let mode = 'symlink';
  try { fs.symlinkSync(src, dest, 'dir'); }
  catch (e) { fs.cpSync(src, dest, { recursive: true }); mode = 'copy'; }
  return { dest: dest, mode: mode };
}

module.exports = { sourceDir: sourceDir, installDir: installDir, fingerprint: fingerprint, status: status, install: install, isInstalled: isInstalled };
