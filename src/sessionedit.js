'use strict';
// Session (transcript) lifecycle MUTATIONS for Claude Code conversations. Where sessions.js
// only BROWSES ~/.claude/projects/<project>/<sessionId>.jsonl, this file DELETES, SCRUBS (PII),
// and surgically EDITS a transcript — every op reversible-by-default or backed up, every write
// atomic + 0600, and the file always left as valid JSONL (one JSON object per line). It leans on
// archive.js (recoverable delete), pii.js (redaction), and fsutil.js (atomicWrite/safeDestUnder),
// and never follows a path outside projectsDir.
const fs = require('fs');
const path = require('path');
const fsutil = require('./fsutil');
const sessions = require('./sessions');
const archive = require('./archive');

// pii.js is a sibling built in parallel: pii.scrub(text, opts) -> { text, counts }, pii.CATEGORIES.
// Lazy-require so this module still loads if pii.js isn't present yet, and allow a ctx.pii override
// (dependency injection for tests / alternate engines) that falls back to the real module.
function getPii(ctx) {
  if (ctx && ctx.pii && typeof ctx.pii.scrub === 'function') return ctx.pii;
  return require('./pii');
}

// --- validation ------------------------------------------------------------
// A session id must start alphanumeric (a leading '-' could smuggle a flag into `claude --resume`)
// and contain only safe id chars.
function safeId(id) { return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id); }
// A project is a SINGLE encoded dir segment: no separators, no '.'/'..' traversal, no NUL.
function safeSeg(p) {
  return typeof p === 'string' && p.length > 0 &&
    p.indexOf('/') === -1 && p.indexOf('\\') === -1 && p.indexOf('\0') === -1 &&
    p !== '.' && p !== '..' && p.indexOf('..') === -1;
}

// Resolve + confine the transcript path. Returns { ok, root, file } or { ok:false, reason }.
function locate(ctx, project, sessionId) {
  if (!safeSeg(project) || !safeId(sessionId)) return { ok: false, reason: 'invalid' };
  const root = sessions.projectsDir(ctx);
  const file = path.join(root, project, sessionId + '.jsonl');
  if (!fsutil.safeDestUnder(root, file).ok) return { ok: false, reason: 'unsafe-path' };
  return { ok: true, root: root, file: file };
}

// --- visible-text helpers --------------------------------------------------
// The HUMAN-VISIBLE text of an event lives at obj.message.content (string OR array of
// {type:'text',text}), obj.text, or obj.summary. Structural fields (ids, timestamps, tool
// json, tool_use/tool_result blocks) are NEVER touched.
function mergeCounts(into, counts) {
  if (!counts) return;
  Object.keys(counts).forEach(function (k) { into[k] = (into[k] || 0) + (counts[k] || 0); });
}
function sumCounts(counts) {
  if (!counts) return 0;
  let n = 0; Object.keys(counts).forEach(function (k) { n += counts[k] || 0; }); return n;
}

// Run `scrub` (text -> {text,counts}) over every visible-text field of `obj`, mutating it in
// place. Returns { total, counts, scanned }.
function scrubVisible(obj, scrub) {
  const counts = {}; let total = 0; let scanned = false;
  function apply(t) {
    const r = scrub(String(t)) || {};
    mergeCounts(counts, r.counts);
    total += sumCounts(r.counts);
    return typeof r.text === 'string' ? r.text : String(t);
  }
  const m = obj && typeof obj === 'object' ? obj.message : null;
  if (m && typeof m.content === 'string') { scanned = true; m.content = apply(m.content); }
  else if (m && Array.isArray(m.content)) {
    m.content.forEach(function (b) {
      if (b && b.type === 'text' && typeof b.text === 'string') { scanned = true; b.text = apply(b.text); }
      // Extended-thinking blocks are human-visible natural-language reasoning that routinely
      // restates the user's PII verbatim; without this they slip through a "successful" scrub.
      else if (b && b.type === 'thinking' && typeof b.thinking === 'string') { scanned = true; b.thinking = apply(b.thinking); }
    });
  }
  if (obj && typeof obj.text === 'string') { scanned = true; obj.text = apply(obj.text); }
  if (obj && typeof obj.summary === 'string') { scanned = true; obj.summary = apply(obj.summary); }
  return { total: total, counts: counts, scanned: scanned };
}

// Overwrite every visible-text field of `obj` with a fixed replacement (structure untouched).
function replaceVisible(obj, replacement) {
  let changed = 0;
  const m = obj && typeof obj === 'object' ? obj.message : null;
  if (m && typeof m.content === 'string') { m.content = replacement; changed++; }
  else if (m && Array.isArray(m.content)) {
    m.content.forEach(function (b) {
      if (b && b.type === 'text' && typeof b.text === 'string') { b.text = replacement; changed++; }
      else if (b && b.type === 'thinking' && typeof b.thinking === 'string') { b.thinking = replacement; changed++; }
    });
  }
  if (obj && typeof obj.text === 'string') { obj.text = replacement; changed++; }
  if (obj && typeof obj.summary === 'string') { obj.summary = replacement; changed++; }
  return changed;
}

// Back up the ORIGINAL bytes to <file>.bak (0600) before an in-place mutation.
function backup(file, raw) {
  const dest = file + '.bak';
  fsutil.atomicWrite(dest, raw, 0o600);
  return dest;
}
// Re-join event lines into valid JSONL (trailing newline unless empty).
function joinLines(lines) { const body = lines.join('\n'); return body ? body + '\n' : ''; }

// --- public API ------------------------------------------------------------

// deleteSession: DEFAULT (hard falsy) archives-then-removes (recoverable via unarchive);
// hard===true PERMANENTLY unlinks the .jsonl. Returns { ok, mode, dest?, bytes? } | { ok:false, reason }.
function deleteSession(ctx, opts) {
  opts = opts || {};
  const loc = locate(ctx, opts.project, opts.sessionId);
  if (!loc.ok) return loc;
  if (opts.hard === true) {
    let st; try { st = fs.statSync(loc.file); } catch (e) { return { ok: false, reason: 'not-found' }; }
    try { fs.rmSync(loc.file); } catch (e) { return { ok: false, reason: 'delete-failed', detail: e.message }; }
    return { ok: true, mode: 'deleted', bytes: st.size };
  }
  const a = archive.archiveSession(ctx, opts.project, opts.sessionId);
  if (!a.ok) return a; // {ok:false, reason:'not-found'|'unsafe-path'|'write-failed'}
  return { ok: true, mode: 'archived', dest: a.dest, bytes: a.bytes, gzBytes: a.gzBytes };
}

// scrubSession: redact PII in visible text only. apply===true backs up + atomic-writes the
// redacted JSONL; apply falsy is a DRY RUN (counts only, writes nothing).
// Returns { ok, applied, redactions:{label:n}, messagesScanned, backup? } | { ok:false, reason }.
function scrubSession(ctx, opts) {
  opts = opts || {};
  const loc = locate(ctx, opts.project, opts.sessionId);
  if (!loc.ok) return loc;
  let raw; try { raw = fs.readFileSync(loc.file, 'utf8'); } catch (e) { return { ok: false, reason: 'not-found' }; }
  let pii; try { pii = getPii(ctx); } catch (e) { return { ok: false, reason: 'pii-unavailable', detail: e.message }; }
  const scrubOpts = { categories: opts.categories, custom: opts.custom, llm: opts.llm };
  const scrub = function (t) { return pii.scrub(t, scrubOpts); };

  const redactions = {}; let messagesScanned = 0;
  const outLines = raw.split('\n').map(function (line) {
    if (!line.trim()) return line; // preserve blank/trailing lines
    let obj; try { obj = JSON.parse(line); } catch (e) { return line; } // keep un-parseable lines verbatim
    const r = scrubVisible(obj, scrub);
    if (r.scanned) messagesScanned++;
    mergeCounts(redactions, r.counts);
    if (!r.total) return line; // no change -> keep original bytes (no reformat churn)
    try { return JSON.stringify(obj); } catch (e) { return line; }
  });

  if (opts.apply !== true) {
    return { ok: true, applied: false, redactions: redactions, messagesScanned: messagesScanned };
  }
  let bak;
  try { bak = backup(loc.file, raw); } catch (e) { return { ok: false, reason: 'backup-failed', detail: e.message }; }
  // outLines already carries the original trailing-blank element (from split on a '\n'-terminated
  // file), so a plain join reproduces the trailing newline — don't append another.
  try { fsutil.atomicWrite(loc.file, outLines.join('\n'), 0o600); }
  catch (e) { return { ok: false, reason: 'write-failed', detail: e.message }; }
  return { ok: true, applied: true, redactions: redactions, messagesScanned: messagesScanned, backup: bak };
}

// editSession: surgical single-op edit. op:
//   { type:'delete-message', index }           — drop the Nth event line
//   { type:'redact-message', index, replacement? } — overwrite that event's visible text ('[REDACTED]')
//   { type:'truncate-after', index }           — drop every event after N
// Indices are 0-based over the (non-empty) event lines. Dry-run unless op.apply===true; always
// backs up before writing; keeps one JSON object per line.
// Returns { ok, applied, op, index, before, after, backup? } | { ok:false, reason }.
function editSession(ctx, opts) {
  opts = opts || {};
  const op = opts.op || {};
  const loc = locate(ctx, opts.project, opts.sessionId);
  if (!loc.ok) return loc;
  let raw; try { raw = fs.readFileSync(loc.file, 'utf8'); } catch (e) { return { ok: false, reason: 'not-found' }; }

  const events = [];
  raw.split('\n').forEach(function (line) { if (line.trim()) events.push(line); });

  const type = op.type;
  if (type !== 'delete-message' && type !== 'redact-message' && type !== 'truncate-after') {
    return { ok: false, reason: 'bad-op' };
  }
  const index = op.index;
  if (typeof index !== 'number' || !isFinite(index) || Math.floor(index) !== index || index < 0 || index >= events.length) {
    return { ok: false, reason: 'index-out-of-range' };
  }

  let newLines;
  if (type === 'delete-message') {
    newLines = events.filter(function (_, k) { return k !== index; });
  } else if (type === 'truncate-after') {
    newLines = events.slice(0, index + 1);
  } else { // redact-message
    let obj; try { obj = JSON.parse(events[index]); } catch (e) { return { ok: false, reason: 'unparseable' }; }
    const replacement = (op.replacement === undefined || op.replacement === null) ? '[REDACTED]' : String(op.replacement);
    replaceVisible(obj, replacement);
    newLines = events.slice();
    try { newLines[index] = JSON.stringify(obj); } catch (e) { return { ok: false, reason: 'stringify-failed' }; }
  }

  const summary = { ok: true, op: type, index: index, before: events.length, after: newLines.length };
  if (op.apply !== true) { summary.applied = false; return summary; }
  let bak;
  try { bak = backup(loc.file, raw); } catch (e) { return { ok: false, reason: 'backup-failed', detail: e.message }; }
  try { fsutil.atomicWrite(loc.file, joinLines(newLines), 0o600); }
  catch (e) { return { ok: false, reason: 'write-failed', detail: e.message }; }
  summary.applied = true; summary.backup = bak;
  return summary;
}

module.exports = {
  deleteSession: deleteSession,
  scrubSession: scrubSession,
  editSession: editSession,
  // exported for reuse/tests
  scrubVisible: scrubVisible,
  replaceVisible: replaceVisible,
};
