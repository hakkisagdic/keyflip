'use strict';
// B1/B2: archive + compress old Claude Code transcripts. Archiving MOVES a transcript out
// of ~/.claude/projects (declutters the live history) into keyflip's archive store,
// gzipped (zlib — zero dep). The store lives under configDir, so H3 git-versions it and
// migrate/backup carry it. Fully reversible: `unarchive` gunzips it back into projects.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const fsutil = require('./fsutil');

function store(ctx) { return path.join(ctx.configDir, 'archive'); }
function projectsDir(ctx) { return path.join(ctx.claudeDir || path.join(ctx.home, '.claude'), 'projects'); }

// gzip a live transcript into the archive store, then remove the live copy.
function archiveSession(ctx, project, sessionId) {
  const src = path.join(projectsDir(ctx), project, sessionId + '.jsonl');
  let raw; try { raw = fs.readFileSync(src); } catch (e) { return { ok: false, reason: 'not-found' }; }
  const dest = path.join(store(ctx), project, sessionId + '.jsonl.gz');
  if (!fsutil.safeDestUnder(store(ctx), dest).ok) return { ok: false, reason: 'unsafe-path' };
  try {
    fsutil.atomicWrite(dest, zlib.gzipSync(raw), 0o600);
  } catch (e) { return { ok: false, reason: 'write-failed', detail: e.message }; }
  let gzBytes = 0; try { gzBytes = fs.statSync(dest).size; } catch (e) { /* ignore */ }
  try { fs.rmSync(src); } catch (e) { /* keep the archive even if the original can't be removed */ }
  return { ok: true, bytes: raw.length, gzBytes: gzBytes, dest: dest };
}

// gunzip an archived transcript back into ~/.claude/projects; remove the archived copy.
function unarchiveSession(ctx, project, sessionId) {
  const gz = path.join(store(ctx), project, sessionId + '.jsonl.gz');
  let comp; try { comp = fs.readFileSync(gz); } catch (e) { return { ok: false, reason: 'not-archived' }; }
  let raw; try { raw = zlib.gunzipSync(comp); } catch (e) { return { ok: false, reason: 'corrupt' }; }
  const dest = path.join(projectsDir(ctx), project, sessionId + '.jsonl');
  if (!fsutil.safeDestUnder(projectsDir(ctx), dest).ok) return { ok: false, reason: 'unsafe-path' };
  try { fsutil.atomicWrite(dest, raw); }
  catch (e) { return { ok: false, reason: 'write-failed', detail: e.message }; }
  try { fs.rmSync(gz); } catch (e) { /* ignore */ }
  return { ok: true, bytes: raw.length, dest: dest };
}

// Archived transcripts, newest first: [{ project, sessionId, gzBytes, mtime }].
function listArchived(ctx) {
  const root = store(ctx);
  const out = [];
  let projs; try { projs = fs.readdirSync(root); } catch (e) { return out; }
  projs.forEach(function (p) {
    let files; try { files = fs.readdirSync(path.join(root, p)); } catch (e) { return; }
    files.forEach(function (f) {
      if (f.slice(-9) !== '.jsonl.gz') return;
      let st; try { st = fs.statSync(path.join(root, p, f)); } catch (e) { return; }
      out.push({ project: p, sessionId: f.slice(0, -9), gzBytes: st.size, mtimeMs: st.mtimeMs, mtime: st.mtime.toISOString() });
    });
  });
  out.sort(function (a, b) { return b.mtimeMs - a.mtimeMs; });
  return out;
}

// Resolve an archived session by id or unique prefix.
function findArchived(ctx, idOrPrefix) {
  const all = listArchived(ctx);
  const exact = all.filter(function (r) { return r.sessionId === idOrPrefix; });
  if (exact.length) return exact[0];
  const pre = all.filter(function (r) { return r.sessionId.indexOf(idOrPrefix) === 0; });
  return pre.length === 1 ? pre[0] : null;
}

module.exports = {
  store: store,
  archiveSession: archiveSession,
  unarchiveSession: unarchiveSession,
  listArchived: listArchived,
  findArchived: findArchived,
};
