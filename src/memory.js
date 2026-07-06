'use strict';
// H1: keyflip's OWN memory store — durable "keepsakes" distilled from old chats, kept
// INDEPENDENT of Claude's ~/.claude memory. Lives under configDir, so H3 git-versions it
// and migrate/backup carry it. Feeding a keepsake back into Claude's memory is a separate,
// opt-in step (the distill --to-claude flag), never automatic.
const fs = require('fs');
const path = require('path');
const fsutil = require('./fsutil');

function store(ctx) { return path.join(ctx.configDir, 'memory'); }
function safeKey(k) { return String(k).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'memory'; }

function frontmatter(meta) {
  if (!meta) return '';
  const lines = ['---'];
  Object.keys(meta).forEach(function (k) { lines.push(k + ': ' + String(meta[k]).replace(/[\r\n]+/g, ' ')); });
  lines.push('---', '');
  return lines.join('\n');
}

// Save a keepsake (markdown) under a stable key (e.g. a sessionId). Returns the path.
function save(ctx, key, content, meta) {
  const p = path.join(store(ctx), safeKey(key) + '.md');
  const body = String(content || '');
  // Atomic so a crash/ENOSPC mid-write can't leave a truncated keepsake.
  fsutil.atomicWrite(p, frontmatter(meta) + body + (body.slice(-1) === '\n' ? '' : '\n'), 0o600);
  return p;
}

function list(ctx) {
  const dir = store(ctx);
  let files; try { files = fs.readdirSync(dir); } catch (e) { return []; }
  return files.filter(function (f) { return f.slice(-3) === '.md'; }).map(function (f) {
    let st; try { st = fs.statSync(path.join(dir, f)); } catch (e) { st = {}; }
    return { key: f.slice(0, -3), file: path.join(dir, f), bytes: st.size || 0, mtime: st.mtime ? st.mtime.toISOString() : null };
  }).sort(function (a, b) { return String(b.mtime || '').localeCompare(String(a.mtime || '')); });
}

function read(ctx, key) { try { return fs.readFileSync(path.join(store(ctx), safeKey(key) + '.md'), 'utf8'); } catch (e) { return null; } }
function has(ctx, key) { try { return fs.existsSync(path.join(store(ctx), safeKey(key) + '.md')); } catch (e) { return false; } }
function remove(ctx, key) { try { fs.rmSync(path.join(store(ctx), safeKey(key) + '.md'), { force: true }); return true; } catch (e) { return false; } }

module.exports = { store: store, safeKey: safeKey, save: save, list: list, read: read, has: has, remove: remove };
