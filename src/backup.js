'use strict';
// #6 Unified backup of keyflip's own (non-secret) metadata: the profile/provider
// JSON, links, breakers — everything in configDir EXCEPT secrets (credentials
// live in the OS store / creds dir and are never copied here) and volatile files
// (locks, caches, the backups dir itself). Timestamped, retention-capped, with a
// mandatory safety snapshot before any restore.
const fs = require('fs');
const path = require('path');
const secretpaths = require('./secretpaths');

const DEFAULT_KEEP = 10;
// Dirs never backed up: the shared SECRET set (creds/app/browser-sessions/pre-sync-backups)
// plus backup's own volatile/self-referential dirs.
const SKIP = secretpaths.SECRET_DIRS.concat(['backups', 'logs', 'skill-backups']);
// Never copy a secret-shaped FILE (shared source of truth — *.cred/*.cookies/*.key/*.token/
// *.pem/*.sql, .credentials.json, mcp-registry.json, stray *credentials.json) or a volatile
// cache/lock, wherever it sits.
const VOLATILE_FILE = /^\.lock|^\.usage-cache\.json$|^\.update-check\.json$/i;
function skipFile(name) { return VOLATILE_FILE.test(name) || secretpaths.isSecretFile(name); }

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
      if (skipFile(ent.name)) return;
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
  // Guarantee a unique dir even for two backups in the same second (stamp has
  // 1s resolution) so retention/history never silently merge two snapshots.
  const base = 'backup-' + stamp(ctx) + (opts.suffix ? '-' + opts.suffix : '');
  let name = base, dest = path.join(backupsDir(ctx), name), n = 1;
  while (fs.existsSync(dest)) { name = base + '.' + (n++); dest = path.join(backupsDir(ctx), name); }
  fs.mkdirSync(dest, { recursive: true });
  const files = copyInto(ctx.configDir, dest);
  // keep:Infinity skips pruning (used by the pre-restore safety snapshot so it
  // can never evict the very backup being restored).
  const keep = opts.keep !== undefined ? opts.keep : DEFAULT_KEEP;
  if (keep !== Infinity) prune(ctx, keep);
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
  const before = dirSize(target.path);
  create(ctx, { suffix: 'pre-restore', keep: Infinity }); // safety net that never prunes the target
  if (!fs.existsSync(target.path)) throw new Error('the backup being restored disappeared — aborting');
  // copy the backup's files back over configDir (additive; never touches creds)
  const restored = copyInto(target.path, ctx.configDir);
  if (before > 0 && restored === 0) throw new Error('restore copied 0 files (backup unreadable) — nothing changed');
  return { name: target.name, files: restored };
}

module.exports = { create: create, list: list, prune: prune, restore: restore, backupsDir: backupsDir, DEFAULT_KEEP: DEFAULT_KEEP };
