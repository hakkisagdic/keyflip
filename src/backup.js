'use strict';
// #6 Unified backup of keyflip's own (non-secret) metadata: the profile/provider
// JSON, links, breakers — everything in configDir EXCEPT secrets (credentials
// live in the OS store / creds dir and are never copied here) and volatile files
// (locks, caches, the backups dir itself). Timestamped, retention-capped, with a
// mandatory safety snapshot before any restore.
const fs = require('fs');
const path = require('path');

const DEFAULT_KEEP = 10;
const SKIP = ['backups', 'creds', 'logs']; // dirs never backed up (secrets/volatile)
const SKIP_FILE = /^\.lock|^\.usage-cache\.json$|^\.update-check\.json$/;

function backupsDir(ctx) { return path.join(ctx.configDir, 'backups'); }

// stamp like 20260702T093015 from ctx.now() (ISO); filename-safe, sortable.
function stamp(ctx) { return String(ctx.now()).replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', 'T'); }

function copyInto(srcDir, destDir) {
  let entries = [];
  try { entries = fs.readdirSync(srcDir, { withFileTypes: true }); } catch (e) { return 0; }
  let n = 0;
  entries.forEach(function (ent) {
    if (ent.isDirectory()) {
      if (SKIP.indexOf(ent.name) !== -1) return;
      n += copyInto(path.join(srcDir, ent.name), path.join(destDir, ent.name));
    } else if (ent.isFile()) {
      if (SKIP_FILE.test(ent.name)) return;
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(path.join(srcDir, ent.name), path.join(destDir, ent.name));
      n++;
    }
  });
  return n;
}

function dirSize(dir) {
  let total = 0;
  try {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      const p = path.join(dir, e.name);
      total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    });
  } catch (e) { /* ignore */ }
  return total;
}

function create(ctx, opts) {
  opts = opts || {};
  const name = 'backup-' + stamp(ctx) + (opts.suffix ? '-' + opts.suffix : '');
  const dest = path.join(backupsDir(ctx), name);
  fs.mkdirSync(dest, { recursive: true });
  const files = copyInto(ctx.configDir, dest);
  prune(ctx, opts.keep !== undefined ? opts.keep : DEFAULT_KEEP);
  return { name: name, path: dest, files: files, sizeBytes: dirSize(dest) };
}

function list(ctx) {
  let entries = [];
  try { entries = fs.readdirSync(backupsDir(ctx)); } catch (e) { return []; }
  return entries.filter(function (n) { return n.indexOf('backup-') === 0; }).sort().reverse()
    .map(function (n) {
      const p = path.join(backupsDir(ctx), n);
      let mtime = null; try { mtime = fs.statSync(p).mtime.toISOString(); } catch (e) { /* */ }
      return { name: n, path: p, sizeBytes: dirSize(p), mtime: mtime };
    });
}

function prune(ctx, keep) {
  if (keep === undefined) keep = DEFAULT_KEEP;
  const all = list(ctx); // newest first
  all.slice(keep).forEach(function (b) { try { fs.rmSync(b.path, { recursive: true, force: true }); } catch (e) { /* */ } });
  return all.length - Math.min(all.length, keep);
}

// Restore a backup by name or 1-based index (as shown by list). Takes a safety
// snapshot of the current state first.
function restore(ctx, nameOrIndex) {
  const all = list(ctx);
  let target = null;
  if (/^[0-9]+$/.test(String(nameOrIndex))) target = all[parseInt(nameOrIndex, 10) - 1];
  else target = all.filter(function (b) { return b.name === nameOrIndex; })[0];
  if (!target) throw new Error('no such backup: ' + nameOrIndex + ' (see: keyflip backup list)');
  create(ctx, { suffix: 'pre-restore' }); // safety net
  // copy the backup's files back over configDir (additive; never touches creds)
  const restored = copyInto(target.path, ctx.configDir);
  return { name: target.name, files: restored };
}

module.exports = { create: create, list: list, prune: prune, restore: restore, backupsDir: backupsDir, DEFAULT_KEEP: DEFAULT_KEEP };
