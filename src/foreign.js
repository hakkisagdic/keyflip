'use strict';
// Epic F: read OTHER agents' session logs into keyflip's unified conversation shape (the same
// { messages:[{role,text,tools,ts}], cwd, counts } that src/transcript.js produces for Claude
// Code), so the same export/markdown/HTML rendering works across tools.
//
// Format confidence:
//   - message-event JSONL → HIGH: reuses the tested transcript.parse (Claude Code, Gemini).
//   - Cursor SQLite (`cursorDiskKV`) → the FILE reader (src/sqliteread.js) is verified against
//     real sqlite3 fixtures; the bubble→message MAPPING is best-effort (Cursor's schema is
//     NEEDS-VERIFICATION — confirm against a real install).
//   - generic JSON of messages → tolerant: finds the biggest array of {role, text/content} objects.
//   - Aider `.aider.chat.history.md` → best-effort markdown (`#### ` user, `> ` tool, else assistant).
// Copilot (YAML) is deferred (needs a YAML parser).

const fs = require('fs');
const path = require('path');

// Best-effort locations of OTHER agents' session stores (relative to $HOME). Existence-gated,
// so a machine without a given tool simply yields nothing. Paths are NEEDS-VERIFICATION —
// confirm on a real install; adding/fixing one is a one-line change.
// Cursor lives under a platform-specific base (macOS Application Support / Windows AppData\Roaming /
// Linux .config). All variants are listed and existence-gated, so the right one matches per OS and
// the others simply yield nothing — no platform branch needed.
const CURSOR_BASES = ['Library/Application Support/Cursor', 'AppData/Roaming/Cursor', '.config/Cursor'];
const SESSION_SOURCES = [
  { tool: 'cursor',
    files: CURSOR_BASES.map(function (b) { return b + '/User/globalStorage/state.vscdb'; }),
    dirs: CURSOR_BASES.map(function (b) { return { base: b + '/User/workspaceStorage', match: /state\.vscdb$/ }; }) },
  { tool: 'opencode', dirs: [{ base: '.local/share/opencode', match: /\.jsonl?$/ }] },
  { tool: 'gemini', dirs: [{ base: '.gemini/antigravity-cli', match: /transcript\.jsonl$/ }] },
  { tool: 'copilot', dirs: [{ base: '.copilot/session-state', match: /workspace\.ya?ml$/ }] },
  // Windsurf (Codeium) + Kiro (AWS) are VS Code forks; their Cascade/chat transcripts live in an
  // app-specific globalStorage SQLite (NOT the `cursorDiskKV` schema parseCursor reads) whose table
  // layout is undocumented. Listing them here without a verified parser would surface files
  // discover() can't normalize, so they are deferred until the on-disk format is confirmed on
  // real hardware. Their portable MEMORY/config IS already carried (agents.js) and they are
  // EXPORT (handoff continue-prompt) targets. NEEDS-VERIFICATION — likely locations:
  //   windsurf: ~/Library/Application Support/Windsurf/User/{globalStorage,workspaceStorage}/**/state.vscdb
  //   kiro:     ~/Library/Application Support/Kiro/User/{globalStorage,workspaceStorage}/**/state.vscdb
];
function walkFind(dir, matchRe, budget, out) {
  if (budget.left <= 0) return;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (let i = 0; i < ents.length && budget.left > 0; i++) {
    const p = path.join(dir, ents[i].name);
    if (ents[i].isDirectory()) walkFind(p, matchRe, budget, out);
    else if (ents[i].isFile() && matchRe.test(ents[i].name)) { out.push(p); budget.left--; }
  }
}
// Discover foreign session files present on this machine → [{ tool, path, mtime }].
function discover(ctx) {
  const home = (ctx && ctx.home) || require('os').homedir();
  const budget = { left: 3000 };
  const out = [];
  const add = function (tool, p) { try { const st = fs.statSync(p); out.push({ tool: tool, path: p, mtime: st.mtime.toISOString() }); } catch (e) { /* vanished */ } };
  SESSION_SOURCES.forEach(function (src) {
    (src.files || []).forEach(function (f) { const p = path.join(home, f); try { if (fs.statSync(p).isFile()) add(src.tool, p); } catch (e) { /* absent */ } });
    (src.dirs || []).forEach(function (d) { const found = []; walkFind(path.join(home, d.base), d.match, budget, found); found.forEach(function (p) { add(src.tool, p); }); });
  });
  return out;
}

function countsOf(m) { return { messages: m.length, user: m.filter(function (x) { return x.role === 'user'; }).length, assistant: m.filter(function (x) { return x.role === 'assistant'; }).length }; }
function dedupe(a) { const seen = {}; return (a || []).filter(function (x) { if (!x || seen[x]) return false; seen[x] = 1; return true; }); }
function asBuffer(input) { return Buffer.isBuffer(input) ? input : Buffer.from(String(input == null ? '' : input), 'utf8'); }

// Detect the source format from filename + a header sniff (works on a Buffer or string).
function detect(filePath, input) {
  const buf = asBuffer(input);
  if (buf.length >= 16 && buf.toString('latin1', 0, 15) === 'SQLite format 3') return 'cursor';
  const p = String(filePath || '').toLowerCase();
  const head = buf.toString('utf8', 0, 2000);
  if (/\.aider\.chat\.history\.md$/.test(p) || /^#\s*aider chat started/m.test(head)) return 'aider';
  if (/\.jsonl$/.test(p)) return 'jsonl';
  const firstLine = (head.split('\n').find(function (l) { return l.trim(); }) || '').trim();
  if (firstLine[0] === '{') {
    try { const o = JSON.parse(firstLine); if (o && (o.message || o.type || o.role)) return 'jsonl'; } catch (e) { /* maybe a whole-file JSON */ }
    // a whole-file JSON document (opencode / generic)?
    try { JSON.parse(head.length < 2000 ? buf.toString('utf8') : head); return 'json'; } catch (e) { /* not a small json */ }
    if (/"(messages|parts|conversation)"\s*:/.test(head)) return 'json';
  }
  if (firstLine[0] === '[' ) return 'json';
  if (/\.ya?ml$/.test(p) || /workspace\.yaml$/.test(p)) return 'yaml';
  if (/\.md$/.test(p)) return 'aider';
  return null;
}

// Aider markdown chat history → unified shape.
function parseAider(text) {
  const messages = [];
  let cur = null;
  const flush = function () { if (cur && cur.text.trim()) messages.push({ role: 'assistant', text: cur.text.trim(), tools: dedupe(cur.tools), ts: null }); cur = null; };
  String(text == null ? '' : text).split('\n').forEach(function (line) {
    if (/^####\s/.test(line)) { flush(); messages.push({ role: 'user', text: line.replace(/^####\s+/, '').trim(), tools: [], ts: null }); cur = { text: '', tools: [] }; return; }
    if (/^#\s*aider chat started/i.test(line)) { flush(); return; }
    if (/^>\s?/.test(line)) {
      if (cur) { const s = line.replace(/^>\s?/, '');
        if (/^Applied edit/i.test(s)) cur.tools.push('edit');
        else if (/^Commit/i.test(s)) cur.tools.push('commit');
        else if (/^(Added|Removed)\b/i.test(s)) cur.tools.push('files');
        else if (/^Running\b/i.test(s)) cur.tools.push('run'); }
      return;
    }
    if (!cur) cur = { text: '', tools: [] };
    cur.text += (cur.text ? '\n' : '') + line;
  });
  flush();
  const msgs = messages.filter(function (m) { return m.text || m.tools.length; });
  return { messages: msgs, cwd: null, counts: countsOf(msgs) };
}

// Cursor SQLite (`cursorDiskKV`): bubbles are `bubbleId:<composer>:<id>` JSON rows; the composer
// row may carry the order. Best-effort mapping over the verified SQLite reader.
function textOf(j) {
  if (!j || typeof j !== 'object') return '';
  if (typeof j.text === 'string' && j.text.trim()) return j.text.trim();
  if (typeof j.content === 'string' && j.content.trim()) return j.content.trim();
  if (Array.isArray(j.content)) { const t = j.content.filter(function (b) { return b && b.type === 'text' && b.text; }).map(function (b) { return b.text; }).join('\n'); if (t.trim()) return t.trim(); }
  return '';
}
function roleOf(j) {
  if (j && (j.role === 'assistant' || j.role === 'user')) return j.role;
  if (j && (j.type === 2 || j.type === 'ai' || j.isAgentic)) return 'assistant';
  return 'user';
}
function parseCursor(buf) {
  const sq = require('./sqliteread');
  const kv = sq.readKV(buf, 'cursorDiskKV'); // throws if the table is absent
  const bubbles = [];
  const composers = Object.create(null); // keyed by attacker-controlled composer ids
  Object.keys(kv).forEach(function (k) {
    let m = k.match(/^bubbleId:([^:]+):(.+)$/);
    if (m) { let j; try { j = JSON.parse(kv[k]); } catch (e) { return; } const text = textOf(j); if (text) bubbles.push({ composer: m[1], id: m[2], key: k, role: roleOf(j), text: text }); return; }
    m = k.match(/^composerData:(.+)$/);
    if (m) { try { composers[m[1]] = JSON.parse(kv[k]); } catch (e) { /* ignore */ } }
  });
  if (!bubbles.length) return { messages: [], cwd: null, counts: countsOf([]) };
  // pick the composer with the most bubbles; order by its header list if present, else by key
  const byComposer = Object.create(null);
  bubbles.forEach(function (b) { (byComposer[b.composer] = byComposer[b.composer] || []).push(b); });
  const composer = Object.keys(byComposer).sort(function (a, b) { return byComposer[b].length - byComposer[a].length; })[0];
  let chosen = byComposer[composer];
  const meta = composers[composer];
  const order = meta && (meta.fullConversationHeadersOnly || meta.conversation || meta.messageIds);
  if (Array.isArray(order) && order.length) {
    const idOf = function (h) { return typeof h === 'string' ? h : (h && (h.bubbleId || h.id)) || ''; };
    const rank = Object.create(null); order.forEach(function (h, i) { rank[idOf(h)] = i; });
    chosen = chosen.slice().sort(function (a, b) { const ra = rank[a.id], rb = rank[b.id]; if (ra == null && rb == null) return a.key < b.key ? -1 : 1; if (ra == null) return 1; if (rb == null) return -1; return ra - rb; });
  } else {
    chosen = chosen.slice().sort(function (a, b) { return a.key < b.key ? -1 : 1; });
  }
  const messages = chosen.map(function (b) { return { role: b.role, text: b.text, tools: [], ts: null }; });
  return { messages: messages, cwd: null, counts: countsOf(messages) };
}

// Find the largest array of message-like objects anywhere in a parsed document, and map it to
// the unified shape. Shared by JSON (opencode + others) and YAML (Copilot + others).
function extractMessages(doc) {
  let best = null;
  (function scan(node) {
    if (Array.isArray(node)) {
      const msgish = node.filter(function (x) { return x && typeof x === 'object' && (x.role || x.type) && (typeof x.text === 'string' || typeof x.content !== 'undefined' || typeof x.message === 'string'); });
      if (msgish.length && (!best || msgish.length > best.length)) best = node;
      node.forEach(scan);
    } else if (node && typeof node === 'object') { Object.keys(node).forEach(function (k) { scan(node[k]); }); }
  })(doc);
  const messages = (best || []).map(function (x) {
    const text = typeof x.message === 'string' ? x.message : textOf(x);
    return { role: roleOf(x), text: text, tools: [], ts: (x && (x.timestamp || x.time)) || null };
  }).filter(function (m) { return m.text; });
  return { messages: messages, cwd: (doc && doc.cwd) || null, counts: countsOf(messages) };
}
function parseJson(text) {
  let doc; try { doc = JSON.parse(text); } catch (e) { throw new Error('not valid JSON'); }
  return extractMessages(doc);
}
// Copilot / generic YAML: parse then find the conversation array (best-effort — Copilot's
// session shape is NEEDS-VERIFICATION; the YAML reader itself is fixture-tested).
function parseYaml(text) {
  const doc = require('./yamlread').parse(text);
  return extractMessages(doc);
}

// Normalize a foreign session (Buffer or string) into the unified shape. Returns { tool, ... }.
// A SQLite DB in WAL mode keeps recent writes in a sibling `<db>-wal` file that this zero-dep reader
// does NOT replay. If that file exists and is non-empty, the latest chats may be missing — surface a
// warning so the user can quit the app (which checkpoints the WAL into the main DB) and re-run.
function walNote(filePath) {
  try {
    if (!filePath) return null;
    const st = fs.statSync(filePath + '-wal');
    if (st && st.size > 0) return 'the Cursor DB has an unflushed -wal log (' + Math.round(st.size / 1024) + ' KB) that this reader cannot replay — the newest chats may be missing. Quit Cursor to checkpoint it, then re-run.';
  } catch (e) { /* no -wal sibling — fully checkpointed */ }
  return null;
}
function normalize(filePath, input) {
  const buf = asBuffer(input);
  const tool = detect(filePath, buf);
  if (tool === 'cursor') {
    // Replay the WAL sibling so RECENT (uncheckpointed) Cursor chats aren't missed. applyOverlay
    // never throws and returns the same buffer when there's nothing to merge — only warn if a -wal
    // exists but we could NOT fold it in.
    let dbBuf = buf, merged = false;
    if (filePath) { try { const walBuf = fs.readFileSync(filePath + '-wal'); const m = require('./walmerge').applyOverlay(buf, walBuf); if (m !== buf) { dbBuf = m; merged = true; } } catch (e) { /* no -wal sibling */ } }
    const out = Object.assign({ tool: 'cursor' }, parseCursor(dbBuf));
    if (!merged) { const w = walNote(filePath); if (w) out.warning = w; }
    return out;
  }
  if (tool === 'jsonl') return Object.assign({ tool: 'jsonl' }, require('./transcript').parse(buf.toString('utf8')));
  if (tool === 'json') return Object.assign({ tool: 'json' }, parseJson(buf.toString('utf8')));
  if (tool === 'yaml') return Object.assign({ tool: 'copilot' }, parseYaml(buf.toString('utf8')));
  if (tool === 'aider') return Object.assign({ tool: 'aider' }, parseAider(buf.toString('utf8')));
  throw new Error('unrecognized session format (supported: message-event JSONL, JSON, YAML, Cursor SQLite, Aider .md)');
}

// Best-effort command to CONTINUE a session in its native tool (documented per tool; the
// session id mapping is NEEDS-VERIFICATION). Returns null when the tool has no resume.
const RESUME = {
  cursor: function (id) { return 'cursor agent --resume ' + id; },
  copilot: function (id) { return 'copilot --resume=' + id; },
  opencode: function (id) { return 'opencode --session ' + id; },
  jsonl: function (id) { return 'claude --resume ' + id; }, // Claude Code / Gemini-style
};
function resumeCommand(tool, id) {
  const f = RESUME[tool];
  return (f && id) ? f(String(id)) : null;
}

module.exports = { detect: detect, parseAider: parseAider, parseCursor: parseCursor, parseJson: parseJson, parseYaml: parseYaml, normalize: normalize, walNote: walNote, discover: discover, resumeCommand: resumeCommand, SESSION_SOURCES: SESSION_SOURCES };
