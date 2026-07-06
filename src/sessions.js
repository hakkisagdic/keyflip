'use strict';
// Session manager: browse/search/resume local Claude Code conversations across
// ALL accounts (transcripts in ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// are account-independent). Read-only; nothing is uploaded.
const fs = require('fs');
const path = require('path');

function projectsDir(ctx) { return path.join(ctx.claudeDir || path.join(ctx.home, '.claude'), 'projects'); }

// Pull the first-line cwd and the first user message text from a transcript,
// reading only the head of the file (transcripts can be large).
function summarize(file) {
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.slice(0, n).toString('utf8');
  } catch (e) { return null; }
  let cwd = null, preview = null;
  const lines = head.split('\n');
  for (let i = 0; i < lines.length && (!cwd || !preview); i++) {
    if (!lines[i].trim()) continue;
    let j; try { j = JSON.parse(lines[i]); } catch (e) { continue; }
    if (!cwd && typeof j.cwd === 'string') cwd = j.cwd;
    if (!preview && j.type === 'user' && j.message && j.message.content) {
      const c = j.message.content;
      const text = typeof c === 'string' ? c : (Array.isArray(c) ? (c.filter(function (b) { return b && b.type === 'text'; })[0] || {}).text : null);
      if (text) preview = String(text).replace(/\s+/g, ' ').trim().slice(0, 100);
    }
  }
  return { cwd: cwd, preview: preview };
}

// List sessions, newest first. opts: { cwd, search, limit }.
function list(ctx, opts) {
  opts = opts || {};
  const root = projectsDir(ctx);
  let projectDirs = [];
  try { projectDirs = fs.readdirSync(root); } catch (e) { return []; }
  const rows = [];
  const wantCwd = opts.cwd ? path.resolve(opts.cwd) : null;
  projectDirs.forEach(function (pd) {
    const dir = path.join(root, pd);
    let files;
    try { files = fs.readdirSync(dir); } catch (e) { return; }
    files.forEach(function (f) {
      if (f.slice(-6) !== '.jsonl') return;
      const id = f.slice(0, -6);
      // Must start alphanumeric (a leading '-' would smuggle a flag into
      // `claude --resume <id>`) and contain only safe id chars.
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return;
      const file = path.join(dir, f);
      let st; try { st = fs.statSync(file); } catch (e) { return; }
      rows.push({ sessionId: f.slice(0, -6), file: file, project: pd, mtimeMs: st.mtimeMs, mtime: st.mtime.toISOString(), sizeBytes: st.size });
    });
  });
  rows.sort(function (a, b) { return b.mtimeMs - a.mtimeMs; });

  // Enrich (head-read) only as many as we might show — cheap for a listing,
  // bounded for a search. For --search we may need full-content scanning.
  const scanLimit = opts.search ? (opts.scanLimit || 800) : (opts.limit || 40) * 3;
  const out = [];
  for (let i = 0; i < rows.length && out.length < (opts.limit || 40); i++) {
    if (i >= scanLimit && !opts.search) break;
    const r = rows[i];
    const s = summarize(r.file) || {};
    r.cwd = s.cwd || decodeProjectDir(r.project);
    r.preview = s.preview || '';
    r.orphan = !!(r.cwd && !fs.existsSync(r.cwd)); // its working dir is gone (renamed/moved) -> needs rebind
    if (wantCwd && path.resolve(r.cwd || '') !== wantCwd) continue;
    if (opts.search) { const m = searchRow(r, opts.search); if (!m) continue; r.match = m; }
    out.push(r);
  }
  return out;
}

function decodeProjectDir(name) {
  // best-effort: dashes were slashes; leading dash = root. Not lossless.
  return name.replace(/^-/, '/').replace(/-/g, '/');
}

// A short context snippet around `idx` in `text` (whitespace-collapsed).
function snippet(text, idx, len) {
  const start = Math.max(0, idx - 55);
  const end = Math.min(text.length, idx + len + 65);
  const s = text.slice(start, end).replace(/\\[nrt"]/g, ' ').replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + s + (end < text.length ? '…' : '');
}

// Stream a transcript in bounded chunks looking for `term`; return a context snippet on
// the first hit (or null). Scans up to 8 MB (a chunk-boundary carry catches split matches)
// so a huge/hostile transcript can't exhaust memory yet we search far deeper than a 1 MB read.
function findMatch(file, term) {
  const t = String(term).toLowerCase();
  const CAP = 8 * 1024 * 1024;
  let read = 0, carry = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(256 * 1024);
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (n <= 0) break;
        read += n;
        const chunk = carry + buf.slice(0, n).toString('utf8');
        const idx = chunk.toLowerCase().indexOf(t);
        if (idx !== -1) return snippet(chunk, idx, term.length);
        carry = chunk.slice(-Math.max(term.length, 220)); // catch a match spanning chunks
        if (read >= CAP) break;
      }
    } finally { fs.closeSync(fd); }
  } catch (e) { /* ignore */ }
  return null;
}

// Search a row by preview/cwd/id (cheap) then transcript CONTENT. Returns the matching
// snippet (so callers can show WHY it matched), or null.
function searchRow(row, term) {
  const t = String(term).toLowerCase();
  if ((row.preview || '').toLowerCase().indexOf(t) !== -1) return row.preview;
  if ((row.cwd || '').toLowerCase().indexOf(t) !== -1) return row.cwd;
  if (row.sessionId.toLowerCase().indexOf(t) !== -1) return row.sessionId;
  return findMatch(row.file, term);
}
function matchesSearch(row, term) { return !!searchRow(row, term); }

// Find one session by id (full or unique prefix).
function find(ctx, idOrPrefix) {
  const all = list(ctx, { limit: 100000 });
  const exact = all.filter(function (r) { return r.sessionId === idOrPrefix; })[0];
  if (exact) return exact;
  const pref = all.filter(function (r) { return r.sessionId.indexOf(idOrPrefix) === 0; });
  if (pref.length === 1) return pref[0];
  if (pref.length > 1) throw new Error("'" + idOrPrefix + "' is ambiguous (" + pref.length + ' sessions) — use more of the id');
  return null;
}

// The command that resumes a session in its original directory.
function resumeCommand(row) {
  return { cwd: row.cwd, command: 'claude', args: ['--resume', row.sessionId] };
}

// E4: the headless command that INJECTS a message into a session and prints the reply —
// `claude -p "<message>" --resume <id>` (add --fork-session to branch instead of appending).
function sendCommand(row, message, opts) {
  opts = opts || {};
  const args = ['-p', String(message), '--resume', row.sessionId];
  if (opts.fork) args.push('--fork-session');
  return { cwd: row.cwd, command: 'claude', args: args };
}

// Claude Code encodes a project's cwd into its dir name by replacing BOTH '/' and '.'
// with '-' (so decode is lossy — that's why decodeProjectDir is best-effort). But when
// we already KNOW the cwd, the encode is exact.
function encodeCwd(cwd) { return String(cwd).replace(/[/.]/g, '-'); }

// Rebind a project's transcripts after its folder was RENAMED/MOVED. Claude stores each
// transcript under <encoded-old-cwd>/ and refuses to open a session whose recorded `cwd`
// no longer exists — so a rename orphans the whole history. This copies every
// <sessionId>.jsonl from the OLD encoded dir to the NEW one, rewriting the old cwd string
// to the new one inside each. Backs up the old dir first. Pure fs (cross-platform).
// Returns { ok, moved, skipped, oldDir, newDir, backup, reason? }.
function rebind(ctx, oldCwd, newCwd, opts) {
  opts = opts || {};
  const root = projectsDir(ctx);
  const oldDir = path.join(root, encodeCwd(oldCwd));
  const newDir = path.join(root, encodeCwd(newCwd));
  if (oldDir === newDir) return { ok: false, reason: 'same-path', oldDir: oldDir, newDir: newDir };
  if (!fs.existsSync(oldDir)) return { ok: false, reason: 'no-old-project', oldDir: oldDir, newDir: newDir };
  let files;
  try { files = fs.readdirSync(oldDir).filter(function (f) { return f.slice(-6) === '.jsonl'; }); }
  catch (e) { return { ok: false, reason: 'unreadable', oldDir: oldDir, newDir: newDir }; }
  if (!files.length) return { ok: false, reason: 'no-transcripts', oldDir: oldDir, newDir: newDir };

  let backup = null;
  try {
    backup = oldDir + '.keyflip-bak';
    fs.mkdirSync(backup, { recursive: true });
    files.forEach(function (f) { fs.copyFileSync(path.join(oldDir, f), path.join(backup, f)); });
  } catch (e) { backup = null; }

  fs.mkdirSync(newDir, { recursive: true });
  let moved = 0, skipped = 0;
  files.forEach(function (f) {
    const dest = path.join(newDir, f);
    if (fs.existsSync(dest) && !opts.force) { skipped++; return; }
    let content;
    try { content = fs.readFileSync(path.join(oldDir, f), 'utf8'); } catch (e) { skipped++; return; }
    const rewritten = content.split(oldCwd).join(newCwd); // rewrite cwd refs so Claude accepts it
    try { fs.writeFileSync(dest, rewritten); moved++; } catch (e) { skipped++; }
  });
  // Disable the old copies so the app doesn't show stale duplicates (reversible: .disabled).
  if (opts.purgeOld && moved) {
    files.forEach(function (f) { try { fs.renameSync(path.join(oldDir, f), path.join(oldDir, f + '.disabled')); } catch (e) { /* ignore */ } });
  }
  return { ok: moved > 0, moved: moved, skipped: skipped, oldDir: oldDir, newDir: newDir, backup: backup };
}

// Best-effort (macOS): the desktop app also keeps a session REGISTRY that records each
// session's cwd/originCwd; a rename leaves those pointing at the gone path (and the app
// flags `transcriptUnavailable`). Rewrite the old cwd -> new cwd in those records and, when
// the transcript now exists, clear the unavailable flag. Only safe while the app is closed.
function rebindAppRegistry(ctx, oldCwd, newCwd) {
  if (!ctx.appDataDir) return { patched: 0 };
  const store = path.join(ctx.appDataDir, 'claude-code-sessions');
  let patched = 0;
  let accts; try { accts = fs.readdirSync(store); } catch (e) { return { patched: 0 }; }
  accts.forEach(function (a) {
    let orgs; try { orgs = fs.readdirSync(path.join(store, a)); } catch (e) { return; }
    orgs.forEach(function (o) {
      const dir = path.join(store, a, o);
      let recs; try { recs = fs.readdirSync(dir); } catch (e) { return; }
      recs.forEach(function (rf) {
        if (rf.slice(-5) !== '.json') return;
        const p = path.join(dir, rf);
        let txt; try { txt = fs.readFileSync(p, 'utf8'); } catch (e) { return; }
        if (txt.indexOf(oldCwd) === -1) return;
        let obj; try { obj = JSON.parse(txt); } catch (e) { return; }
        const before = JSON.stringify(obj);
        ['cwd', 'originCwd'].forEach(function (k) { if (typeof obj[k] === 'string') obj[k] = obj[k].split(oldCwd).join(newCwd); });
        if (obj.transcriptUnavailable) delete obj.transcriptUnavailable;
        if (JSON.stringify(obj) !== before) {
          try { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); patched++; } catch (e) { /* ignore */ }
        }
      });
    });
  });
  return { patched: patched };
}

// B3: compact a transcript by eliding bulky TOOL OUTPUT (file reads, command output,
// images) while keeping the conversation text intact and the JSONL still valid/resumable.
// Long strings are truncated ONLY inside tool-result/tool-use contexts (or stdout/stderr/
// toolUseResult keys) — message text is never touched. Returns { compacted, before, after, elided }.
function shortenStr(s, threshold) {
  const b = Buffer.byteLength(s);
  if (b <= threshold) return null;
  return s.slice(0, 400) + '\n…[' + (b - 600) + ' bytes elided by keyflip compact]…\n' + s.slice(-200);
}
function truncateToolStrings(node, threshold, changed, inTool) {
  if (!node || typeof node !== 'object') return;
  const here = inTool || node.type === 'tool_result' || node.type === 'tool_use' ||
    Object.prototype.hasOwnProperty.call(node, 'tool_use_id') || Object.prototype.hasOwnProperty.call(node, 'toolUseResult');
  Object.keys(node).forEach(function (k) {
    const v = node[k];
    if (typeof v === 'string') {
      if (here || k === 'stdout' || k === 'stderr' || k === 'toolUseResult' || k === 'output') {
        const sh = shortenStr(v, threshold);
        if (sh !== null) { node[k] = sh; changed.n++; }
      }
    } else if (v && typeof v === 'object') {
      truncateToolStrings(v, threshold, changed, here);
    }
  });
}
function compactTranscript(content, opts) {
  opts = opts || {};
  const threshold = opts.threshold || 2000;
  const before = Buffer.byteLength(content);
  let elided = 0;
  const out = String(content).split('\n').map(function (line) {
    if (!line.trim()) return line;
    let obj; try { obj = JSON.parse(line); } catch (e) { return line; } // keep un-parseable lines verbatim
    const changed = { n: 0 };
    truncateToolStrings(obj, threshold, changed, false);
    if (!changed.n) return line;
    elided += changed.n;
    try { return JSON.stringify(obj); } catch (e) { return line; }
  }).join('\n');
  return { compacted: out, before: before, after: Buffer.byteLength(out), elided: elided };
}

module.exports = { projectsDir: projectsDir, list: list, find: find, summarize: summarize, resumeCommand: resumeCommand, sendCommand: sendCommand, decodeProjectDir: decodeProjectDir, encodeCwd: encodeCwd, rebind: rebind, rebindAppRegistry: rebindAppRegistry, searchRow: searchRow, findMatch: findMatch, matchesSearch: matchesSearch, compactTranscript: compactTranscript };
