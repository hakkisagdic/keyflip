// One canonical conversation shape for every local AI tool keyflip can read.
//
// Sources are read-only and discovered on this machine:
//   claude  ~/.claude/projects/<cwd-key>/<session>.jsonl        (Claude Code CLI/Qoder-style)
//   codex   ~/.codex/sessions/**.jsonl[.zst]                     (ChatGPT desktop + Codex CLI)
//   kiro    ~/.kiro/sessions/cli/<id>.jsonl                      (Kiro CLI)
//           ~/.kiro/sessions/<hash>/sess_*/messages.jsonl        (Kiro IDE)
//   cursor  <Cursor>/User/**/state.vscdb  cursorDiskKV rows       (editor + cursor-agent, via cursor.js)
//   foreign opencode / Qoder / Gemini / Copilot / Aider via foreign.js
//
// The shape is deliberately small so transfer, export and retrieval never have to
// learn a vendor schema twice:
//   { schemaVersion, id, app, surface, title, cwd, account, createdAt, updatedAt,
//     messages: [{ role, text, ts, tools }], counts, source: { path, mtimeMs, size }, hash }
//
// Nothing here writes to any tool's store. ChatGPT/Codex rollout files can be zstd
// compressed; Node >=22.15 has zlib.zstdDecompressSync, older Nodes fall back to the
// `zstd` CLI, and if neither exists the file is reported as skipped rather than
// guessed at.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { run } from './exec.js';
import * as transcript from './transcript.js';
import * as foreign from './foreign.js';
import * as cursor from './cursor.js';

const SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 160 * 1024 * 1024; // on-disk cap per source (rollouts reach ~140 MB)
const MAX_TEXT_BYTES = 256 * 1024 * 1024; // decompressed cap (zstd bomb guard)
const MAX_MESSAGE_CHARS = 200000;
const MAX_MESSAGES = 20000;
const SOURCE_BUDGET = 5000;

function homeOf(ctx) {
  return (ctx && ctx.home) || os.homedir();
}

function claudeRoot(ctx) {
  return path.join((ctx && ctx.claudeDir) || path.join(homeOf(ctx), '.claude'), 'projects');
}

function codexRoot(ctx) {
  const env = (ctx && ctx.env) || process.env;
  return (ctx && ctx.codexHome) || (env && env.CODEX_HOME) || path.join(homeOf(ctx), '.codex');
}

function kiroRoot(ctx) {
  return (ctx && ctx.kiroDir) || path.join(homeOf(ctx), '.kiro');
}

function safeStr(v, max) {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is being removed
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return s ? s.slice(0, max || 400) : null;
}

function oneLine(v, max) {
  const s = safeStr(v, max || 120);
  return s ? s.replace(/\s+/g, ' ') : null;
}

function countsOf(messages) {
  return {
    messages: messages.length,
    user: messages.filter((m) => m.role === 'user').length,
    assistant: messages.filter((m) => m.role === 'assistant').length,
  };
}

function convHash(messages) {
  return crypto.createHash('sha1').update(JSON.stringify(messages)).digest('hex');
}

function makeConv(fields) {
  const messages = (fields.messages || [])
    .map((m) => {
      if (!m || m.role !== 'user') return m;
      const text = stripHarness(m.text);
      if (!text) return null;
      return { role: m.role, text: text, ts: m.ts || null, tools: m.tools || [] };
    })
    .filter(Boolean)
    .slice(0, MAX_MESSAGES);
  return {
    schemaVersion: SCHEMA_VERSION,
    id: fields.id,
    app: fields.app,
    surface: fields.surface || 'local',
    title: oneLine(fields.title) || '(untitled)',
    cwd: safeStr(fields.cwd, 4000) || null,
    account: safeStr(fields.account, 320) || null,
    createdAt: fields.createdAt || null,
    updatedAt: fields.updatedAt || null,
    messages: messages,
    counts: countsOf(messages),
    source: {
      path: fields.path || null,
      mtimeMs: fields.mtimeMs || null,
      size: fields.size || null,
    },
    hash: convHash(messages),
  };
}

// ---- reading / decompression --------------------------------------------------------------

function readText(file) {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error('not a file');
  if (st.size > MAX_FILE_BYTES)
    throw new Error('source is larger than ' + Math.round(MAX_FILE_BYTES / 1048576) + ' MB');
  let buf = fs.readFileSync(file);
  if (/\.zst$/i.test(file)) {
    if (typeof zlib.zstdDecompressSync === 'function') {
      try {
        buf = zlib.zstdDecompressSync(buf, { maxOutputLength: MAX_TEXT_BYTES });
      } catch (e) {
        if (e && e.code === 'ERR_OUT_OF_RANGE')
          throw new Error('compressed source expands beyond the safety cap', { cause: e });
        throw new Error('could not decompress ' + path.basename(file) + ': ' + (e && e.message), { cause: e });
      }
    } else {
      const r = run('zstd', ['-dc', file], undefined, { timeoutMs: 60000 });
      if (!r || r.code !== 0) throw new Error('zstd is not installed (or failed) and this source is compressed');
      buf = Buffer.from(r.stdout, 'utf8');
    }
  }
  if (buf.length > MAX_TEXT_BYTES) throw new Error('source expands beyond the safety cap');
  return buf.toString('utf8');
}

// User turns wrapped by the host app carry environment/instructions, not conversation.
const INJECTED = [
  /^<environment_context>/i,
  /^<app-context>/i,
  /^<multi_agent_/i,
  /^<user_instructions>/i,
  /^<permissions/i,
  /^<skills_instructions>/i,
  /^# AGENTS\.md instructions/i,
  /^<turn_aborted>/i,
];

function isInjected(text) {
  const s = String(text || '').trim();
  return INJECTED.some((re) => re.test(s));
}

// Host apps inject machine turns into the user role: task notifications, slash-command
// plumbing, worktree notices. They are not conversation, they dominate real transcripts
// (2,800 of 6,699 user turns on this machine), and indexing them buries actual prompts.
// Whole-turn noise is dropped; wrappers around real user text are stripped and the rest kept.
const NOISE_TURN = [
  /^<task-notification>/i,
  /^<cross-session-message>/i,
  /^<local-command-stdout>/i,
  /^<local-command-caveat>/i,
  /^<ci-monitor-event>/i,
  /^<scheduled-task>/i,
  /^<previous_session_context>/i,
];
const STRIP_BLOCKS = [
  [/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ''],
  [/<command-name>[\s\S]*?<\/command-name>/gi, ''],
  [/<command-message>[\s\S]*?<\/command-message>/gi, ''],
  [/<command-args>[\s\S]*?<\/command-args>/gi, ''],
  [/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, ''],
  // The host sometimes repeats the id on the CLOSING tag (`</pasted_content id="…">`), so match
  // any attributes on both ends; a paste with no closing tag still loses its opening tag below.
  [/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/gi, '$1'],
  [/<\/?pasted_content[^>]*>/gi, ''],
  [/<skill-format[^>]*>(?:true|false)<\/skill-format>/gi, ''],
  [/<\/?skill-format[^>]*>/gi, ''],
  [/<\/?(?:bash-input|bash-stdout|bash-stderr)>/gi, ''],
];

function stripHarness(text) {
  let s = String(text == null ? '' : text);
  const head = s.trim();
  if (!head || NOISE_TURN.some((re) => re.test(head))) return '';
  STRIP_BLOCKS.forEach((pair) => {
    s = s.replace(pair[0], pair[1]);
  });
  return s.trim();
}

function cleanMessage(text) {
  let s = String(text == null ? '' : text)
    .replace(/\r\n/g, '\n')
    .trim();
  if (!s) return '';
  if (s.length > MAX_MESSAGE_CHARS) s = s.slice(0, MAX_MESSAGE_CHARS) + '\n…[truncated by keyflip]';
  return s;
}

// Titles come from a user prompt, but the first user turn is often machine noise
// (`[traycer:agent-message]`, command plumbing, a continuation preamble). Prefer a plausible
// human sentence; fall back to whatever exists so a title is never empty.
function titleCandidate(messages) {
  let long = null;
  let first = null;
  for (const m of messages) {
    if (!m || m.role !== 'user' || !m.text) continue;
    const t = m.text.trim();
    if (!first) first = t;
    if (t.length < 12 || /^[[<#]/.test(t) || /^this session is being continued/i.test(t)) continue;
    // A pasted document is a poor title; keep it only if nothing request-shaped appears.
    if (t.length > 300) {
      if (!long) long = t;
      continue;
    }
    return t;
  }
  return long || first;
}

function withFallbackTitle(conv, fallback) {
  if (conv.title && conv.title !== '(untitled)' && !/^[[<]/.test(conv.title)) return conv;
  conv.title = oneLine(titleCandidate(conv.messages) || fallback, 100) || '(untitled)';
  return conv;
}

// ---- Claude Code / Qoder-style message-event JSONL ---------------------------------------

function parseClaudeLocal(text, src, opts) {
  const parsed = transcript.parse(text);
  const messages = parsed.messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && (m.text || (m.tools && m.tools.length)))
    .map((m) => ({ role: m.role, text: cleanMessage(m.text), ts: m.ts || null, tools: m.tools || [] }))
    .filter((m) => m.text || m.tools.length);
  const fallbackTitle = src.title || null;
  const conv = makeConv({
    id: 'claude:local:' + src.idHint,
    app: 'claude',
    surface: 'cli',
    title: fallbackTitle,
    cwd: parsed.cwd || (opts && opts.cwd) || null,
    createdAt: messages.length ? messages[0].ts : null,
    updatedAt: messages.length ? messages[messages.length - 1].ts : new Date(src.mtimeMs).toISOString(),
    messages: messages,
    path: src.path,
    mtimeMs: src.mtimeMs,
    size: src.size,
  });
  return withFallbackTitle(conv, src.idHint);
}

// ---- Codex / ChatGPT desktop rollout JSONL -------------------------------------------------

const codexTitleCache = { file: null, mtimeMs: 0, map: null };

function codexTitles(ctx) {
  const file = path.join(codexRoot(ctx), 'session_index.jsonl');
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return Object.create(null);
  }
  if (codexTitleCache.file === file && codexTitleCache.mtimeMs === st.mtimeMs) return codexTitleCache.map;
  const map = Object.create(null);
  try {
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line) => {
        if (!line.trim()) return;
        try {
          const j = JSON.parse(line);
          if (j && typeof j.id === 'string' && typeof j.thread_name === 'string' && j.thread_name.trim()) {
            // Newest record wins; the index is append-only and rewrites titles in place.
            map[j.id] = j.thread_name.trim();
          }
        } catch {
          /* ignore a torn line */
        }
      });
  } catch {
    return Object.create(null);
  }
  codexTitleCache.file = file;
  codexTitleCache.mtimeMs = st.mtimeMs;
  codexTitleCache.map = map;
  return map;
}

function codexContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  content.forEach((b) => {
    if (!b || typeof b !== 'object') return;
    if ((b.type === 'input_text' || b.type === 'output_text' || b.type === 'text') && typeof b.text === 'string') {
      out.push(b.text);
    }
  });
  return out.join('\n');
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// Which thread does THIS rollout file belong to?
// Two things make the answer non-obvious:
//   * Codex Desktop writes a second `session_meta` line that repeats the PARENT thread, so the
//     last meta in the file is the parent, not this rollout.
//   * A fork is named `rollout-<date>-<parent>_<own>.jsonl`: the file's own thread is the LAST
//     uuid in the name, and its session_meta may carry the parent's id.
// Taking the parent id for a fork gives two different files the same conversation id; they then
// overwrite each other's chunk file while the manifest keeps one row. So: prefer an id that is
// not a parent thread, and fall back to the file name before the parent.
function codexOwnId(metas, src) {
  const parents = new Set();
  for (const m of metas) {
    const sid = safeStr(m.session_id, 120);
    if (sid) parents.add(sid);
  }
  const candidates = [];
  for (const m of metas) {
    const v = safeStr(m.id, 120);
    if (v) candidates.push(v);
  }
  const uuids = String((src && src.path) || '').match(UUID_RE) || [];
  for (let i = uuids.length - 1; i >= 0; i--) candidates.push(uuids[i].toLowerCase());
  for (const c of candidates) if (!parents.has(c)) return c;
  return candidates[0] || null;
}

function parseCodexRollout(text, src, opts) {
  const titles = (opts && opts.titles) || Object.create(null);
  const metas = [];
  const messages = [];
  let lastTs = null;
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type === 'session_meta' && j.payload && typeof j.payload === 'object') {
      metas.push(j.payload);
      if (j.timestamp) lastTs = j.timestamp;
      continue;
    }
    if (j.type !== 'response_item' || !j.payload || j.payload.type !== 'message') continue;
    const role = j.payload.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const raw = codexContentText(j.payload.content);
    if (!raw || isInjected(raw)) continue;
    const body = cleanMessage(raw);
    if (!body) continue;
    const prev = messages[messages.length - 1];
    if (prev && prev.role === role && prev.text === body) continue; // app + event stream echo
    messages.push({ role: role, text: body, ts: j.timestamp || null, tools: [] });
    if (j.timestamp) lastTs = j.timestamp;
  }
  // Resumed/forked threads log `session_id` = the PARENT thread while `id` is this rollout's
  // own thread. Preferring session_id collapsed dozens of distinct rollouts into one index
  // entry (their chunk files overwrote each other). Titles still come from the parent thread.
  const meta = metas[0] || null;
  const threadId = (meta && safeStr(meta.session_id, 120)) || null;
  const sessionId = codexOwnId(metas, src) || threadId || src.idHint;
  const conv = makeConv({
    id: 'codex:' + sessionId,
    app: 'codex',
    surface: /desktop/i.test((meta && meta.originator) || '') ? 'desktop' : 'cli',
    title: titles[threadId || sessionId] || src.title || null,
    cwd: (meta && meta.cwd) || (opts && opts.cwd) || null,
    createdAt: (meta && meta.timestamp) || (messages.length ? messages[0].ts : null),
    updatedAt: lastTs || new Date(src.mtimeMs).toISOString(),
    messages: messages,
    path: src.path,
    mtimeMs: src.mtimeMs,
    size: src.size,
  });
  return withFallbackTitle(conv, sessionId);
}

// ---- Kiro ---------------------------------------------------------------------------------

function kiroSiblingMeta(file) {
  const json = file.replace(/\.jsonl$/i, '.json');
  try {
    return JSON.parse(fs.readFileSync(json, 'utf8'));
  } catch {
    return null;
  }
}

function kiroBlocksText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  content.forEach((b) => {
    if (!b || typeof b !== 'object') return;
    if (b.kind === 'text' && typeof b.data === 'string') out.push(b.data);
    else if (b.kind === 'text' && b.data && typeof b.data.text === 'string') out.push(b.data.text);
  });
  return out.join('\n');
}

function parseKiroCli(text, src, opts) {
  const meta = kiroSiblingMeta(src.path) || {};
  const messages = [];
  String(text || '')
    .split('\n')
    .forEach((line) => {
      if (!line.trim()) return;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        return;
      }
      const d = j && j.data;
      if (!d) return;
      if (j.kind === 'Prompt') {
        const body = cleanMessage(kiroBlocksText(d.content));
        if (body && !isInjected(body)) messages.push({ role: 'user', text: body, ts: d.timestamp || null, tools: [] });
        return;
      }
      if (j.kind === 'AssistantMessage') {
        const body = cleanMessage(kiroBlocksText(d.content));
        if (!body) return;
        const tools = Array.isArray(d.content)
          ? d.content.filter((b) => b && b.kind === 'toolUse').map((b) => (b.data && b.data.name) || 'tool')
          : [];
        messages.push({ role: 'assistant', text: body, ts: d.timestamp || null, tools: tools });
      }
    });
  const conv = makeConv({
    id: 'kiro:cli:' + (meta.session_id || src.idHint),
    app: 'kiro',
    surface: 'cli',
    title: meta.title || src.title || null,
    cwd: meta.cwd || (opts && opts.cwd) || null,
    createdAt: meta.created_at || (messages.length ? messages[0].ts : null),
    updatedAt: meta.updated_at || new Date(src.mtimeMs).toISOString(),
    messages: messages,
    path: src.path,
    mtimeMs: src.mtimeMs,
    size: src.size,
  });
  return withFallbackTitle(conv, src.idHint);
}

function parseKiroIde(text, src, opts) {
  const messages = [];
  String(text || '')
    .split('\n')
    .forEach((line) => {
      if (!line.trim()) return;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        return;
      }
      const p = j && j.payload;
      if (!p) return;
      if (p.type === 'user') {
        const body = cleanMessage(p.content);
        if (body && !isInjected(body)) messages.push({ role: 'user', text: body, ts: j.timestamp || null, tools: [] });
        return;
      }
      if (p.type === 'assistant') {
        // Reasoning traces are the agent's scratchpad, not the conversation.
        if (p.operationType === 'Reasoning') return;
        const body = cleanMessage(p.content);
        if (body) messages.push({ role: 'assistant', text: body, ts: j.timestamp || null, tools: [] });
      }
    });
  const meta = src.meta || {};
  const conv = makeConv({
    id: 'kiro:ide:' + (meta.id || src.idHint),
    app: 'kiro',
    surface: 'desktop',
    title: meta.title || src.title || null,
    cwd: Array.isArray(meta.workspacePaths) ? meta.workspacePaths[0] : meta.cwd || (opts && opts.cwd) || null,
    createdAt: meta.createdAt || (messages.length ? messages[0].ts : null),
    updatedAt: meta.lastModifiedAt || new Date(src.mtimeMs).toISOString(),
    messages: messages,
    path: src.path,
    mtimeMs: src.mtimeMs,
    size: src.size,
  });
  return withFallbackTitle(conv, src.idHint);
}

// ---- Gemini / Antigravity CLI --------------------------------------------------------------
// <brain>/<session-id>/.system_generated/logs/transcript[_full].jsonl, one record per step:
//   { type: 'USER_INPUT'|'PLANNER_RESPONSE'|…, content, created_at, step_index }
// Some releases only persist USER_INPUT, so a zero-message conversation is honest rather
// than a parse failure. Prompt wrappers (<USER_REQUEST>, <system>) are host scaffolding.
function geminiSessionId(file) {
  const m = /[/\\]brain[/\\]([^/\\]+)[/\\]/.exec(file);
  return m ? m[1] : crypto.createHash('sha1').update(file).digest('hex').slice(0, 12);
}

function geminiText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      if (!b || typeof b !== 'object') return '';
      if (typeof b.text === 'string') return b.text;
      if (typeof b.content === 'string') return b.content;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function stripGeminiPrompt(text) {
  return String(text || '')
    .replace(/<\/?USER_REQUEST>/gi, '')
    .replace(/<system>[\s\S]*?<\/system>/gi, '')
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .trim();
}

function parseGeminiTranscript(text, src, opts) {
  const messages = [];
  let lastTs = null;
  String(text || '')
    .split('\n')
    .forEach((line) => {
      if (!line.trim()) return;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        return;
      }
      if (!j || typeof j.type !== 'string') return;
      const body = cleanMessage(stripGeminiPrompt(geminiText(j.content)));
      if (!body || isInjected(body)) return;
      let role = null;
      if (j.type === 'USER_INPUT') role = 'user';
      else if (/RESPONSE|ASSISTANT|MODEL_OUTPUT/i.test(j.type)) role = 'assistant';
      if (!role) return;
      messages.push({ role: role, text: body, ts: j.created_at || j.timestamp || null, tools: [] });
      if (j.created_at || j.timestamp) lastTs = j.created_at || j.timestamp;
    });
  const conv = makeConv({
    id: 'gemini:' + (src.idHint || geminiSessionId(src.path)),
    app: 'gemini',
    surface: 'cli',
    title: src.title || null,
    cwd: (opts && opts.cwd) || null,
    createdAt: messages.length ? messages[0].ts : null,
    updatedAt: lastTs || new Date(src.mtimeMs).toISOString(),
    messages: messages,
    path: src.path,
    mtimeMs: src.mtimeMs,
    size: src.size,
  });
  return withFallbackTitle(conv, path.basename(path.dirname(src.path)));
}

// ---- foreign tools (opencode, Qoder, Gemini, Copilot, Aider) -------------------------------

// ---- Cursor composers (one `state.vscdb` holds MANY chats) ---------------------------------

// Cursor is not a JSONL tool: its editor chats are `composerData:` / `bubbleId:` rows in a SQLite
// key/value store (one file holds every chat the machine has), its CLI agent keeps one `store.db`
// per session, and it mirrors agent sessions as JSONL under `projects/`. src/cursor.js expands all
// three into one chat each, deduped by session id across the global and per-workspace copies.
function parseCursorChat(ctx, src, opts) {
  const chat = cursor.loadChat(ctx, src);
  const messages = (chat.messages || [])
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      text: cleanMessage(m.text),
      ts: m.ts || null,
      tools: m.tools || [],
    }))
    .filter((m) => m.text || m.tools.length);
  // Surface is part of the identity, the same way Kiro's `kiro:cli:` / `kiro:ide:` are: an editor
  // composer and a CLI session are different products even if a UUID someday collided.
  const surface = src.surface || (src.kind === 'cursor-composer' ? 'local' : 'cli');
  const conv = makeConv({
    id: 'cursor:' + surface + ':' + chat.composerId,
    app: 'cursor',
    surface: surface,
    title: chat.title || src.title || null,
    cwd: chat.cwd || src.cwd || (opts && opts.cwd) || null,
    createdAt: chat.createdAt || null,
    updatedAt: chat.updatedAt || null,
    messages: messages,
    path: src.path,
    mtimeMs: src.mtimeMs,
    size: src.size,
  });
  return withFallbackTitle(
    conv,
    (src.kind === 'cursor-composer' ? 'composer ' : 'session ') + String(chat.composerId).slice(0, 8),
  );
}

function parseForeignSource(text, src, opts) {
  const normalized = foreign.normalize(src.path, text);
  const messages = (normalized.messages || [])
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      text: cleanMessage(m.text),
      ts: m.ts || null,
      tools: m.tools || [],
    }))
    .filter((m) => m.text || m.tools.length);
  // src.tool is the DISCOVERED app (qoder, cursor, aider…); normalized.tool is only the file
  // format (`jsonl`), which must not become the app name.
  const tool = safeStr(src.tool || normalized.tool || 'foreign', 40) || 'foreign';
  const digest = crypto.createHash('sha1').update(src.path).digest('hex').slice(0, 12);
  const conv = makeConv({
    id: 'foreign:' + tool + ':' + digest,
    app: tool,
    surface: 'local',
    title: src.title || null,
    cwd: normalized.cwd || (opts && opts.cwd) || null,
    createdAt: messages.length ? messages[0].ts : null,
    updatedAt: messages.length ? messages[messages.length - 1].ts : new Date(src.mtimeMs).toISOString(),
    messages: messages,
    path: src.path,
    mtimeMs: src.mtimeMs,
    size: src.size,
  });
  return withFallbackTitle(conv, path.basename(src.path));
}

// ---- discovery ----------------------------------------------------------------------------

function statSource(file, kind, extra) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size === 0) return null;
  return Object.assign(
    {
      kind: kind,
      path: file,
      mtimeMs: st.mtimeMs,
      size: st.size,
    },
    extra || {},
  );
}

function walk(dir, depth, visit) {
  if (depth < 0) return;
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  ents.forEach((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth - 1, visit);
    else if (e.isFile()) visit(p, e.name);
  });
}

function claudeSources(ctx) {
  const root = claudeRoot(ctx);
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  dirs.forEach((d) => {
    if (!d.isDirectory() || d.name.slice(-'.keyflip-bak'.length) === '.keyflip-bak') return;
    const dir = path.join(root, d.name);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      return;
    }
    files.forEach((f) => {
      if (f.slice(-6) !== '.jsonl' || f.slice(-10) === '.meta.json') return;
      const id = f.slice(0, -6);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return;
      const file = path.join(dir, f);
      let title = null;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, id + '.meta.json'), 'utf8'));
        title = meta && meta.title ? meta.title : null;
      } catch {
        /* title is optional */
      }
      const src = statSource(file, 'claude-local', { app: 'claude', surface: 'cli', idHint: id, title: title });
      if (src) out.push(src);
    });
  });
  return out;
}

function codexSources(ctx) {
  const root = path.join(codexRoot(ctx), 'sessions');
  const out = [];
  const seen = Object.create(null);
  walk(root, 6, (file, name) => {
    if (!/^rollout-.*\.jsonl(\.zst)?$/i.test(name)) return;
    const compressed = /\.zst$/i.test(name);
    const base = file.replace(/\.zst$/i, '');
    // Prefer the uncompressed twin when both exist (same conversation, less work).
    if (compressed && fs.existsSync(base)) return;
    if (seen[base]) return;
    seen[base] = true;
    const idHint =
      /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/i.exec(name)?.[1] || path.basename(base);
    const src = statSource(file, 'codex-rollout', { app: 'codex', surface: 'cli', idHint: idHint });
    if (src) out.push(src);
  });
  return out;
}

function kiroSources(ctx) {
  const root = kiroRoot(ctx);
  const out = [];
  const cli = path.join(root, 'sessions', 'cli');
  try {
    fs.readdirSync(cli).forEach((f) => {
      if (f.slice(-6) !== '.jsonl') return;
      const file = path.join(cli, f);
      const id = f.slice(0, -6);
      const src = statSource(file, 'kiro-cli', { app: 'kiro', surface: 'cli', idHint: id });
      if (src) out.push(src);
    });
  } catch {
    /* no Kiro CLI sessions */
  }
  // Kiro IDE: ~/.kiro/sessions/<workspace-hash>/sess_<id>/messages.jsonl
  const ide = path.join(root, 'sessions');
  walk(ide, 3, (file, name) => {
    if (name !== 'messages.jsonl') return;
    const dir = path.dirname(file);
    if (path.basename(dir).slice(0, 5) !== 'sess_') return;
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
    } catch {
      meta = null; // optional sibling; the dir name is a valid fallback id
    }
    const idHint = (meta && meta.id) || path.basename(dir);
    const src = statSource(file, 'kiro-ide', {
      app: 'kiro',
      surface: 'desktop',
      idHint: idHint,
      title: meta && meta.title ? meta.title : null,
      meta: meta,
    });
    if (src) out.push(src);
  });
  return out;
}

// Cursor is its own family because one file is many chats: discovery expands every composer, agent
// session and transcript mirror, and a source row carries the session id it stands for.
function cursorSources(ctx) {
  const out = [];
  let found;
  try {
    found = cursor.discover(ctx);
  } catch {
    return out; // a Cursor layout keyflip does not recognise must not hide the other apps
  }
  found.forEach((c) => {
    const src = statSource(c.path, c.kind || 'cursor-composer', {
      app: 'cursor',
      surface: c.surface || 'local',
      // The session id is the identity: stable across runs, so a rebuilt index reuses the chat's
      // chunks and vectors instead of re-embedding the same conversation under a new key.
      idHint: c.composerId,
      title: c.title,
      cwd: c.cwd,
      composerId: c.composerId,
    });
    if (src) out.push(src);
  });
  // A store the adapter refused to read yields NO source row, so the per-source error path in the
  // indexer can never mention it. Keep the reason attached; `discover` aggregates it and `conv
  // index` prints it, because "Cursor is not installed" and "Cursor's database is past the read
  // budget" must not look like the same empty result.
  out.issues = (found.skipped || []).map((s) => ({ path: s.file, app: 'cursor', error: s.reason }));
  // A store that yielded chats but whose newest writes could not be replayed is not a skip: it is a
  // degraded read, reported apart so the count of skipped sources stays what it says.
  out.storeWarnings = (found.warnings || []).map((w) => ({ path: w.file, app: 'cursor', error: w.reason }));
  return out;
}

function foreignSources(ctx) {
  const out = [];
  let found;
  try {
    found = foreign.discover(ctx);
  } catch {
    return out; // a broken foreign layout must not hide the built-in apps
  }
  found.forEach((f) => {
    const gemini = f.tool === 'gemini' && /transcript\.jsonl$/i.test(f.path);
    let file = f.path;
    if (gemini) {
      // transcript_full.jsonl carries the same records plus steps an older transcript omitted.
      const full = f.path.replace(/transcript\.jsonl$/i, 'transcript_full.jsonl');
      try {
        if (fs.statSync(full).size >= fs.statSync(f.path).size) file = full;
      } catch {
        /* keep transcript.jsonl */
      }
    }
    const src = statSource(file, gemini ? 'gemini-transcript' : 'foreign', {
      app: f.tool,
      surface: gemini ? 'cli' : 'local',
      idHint: gemini ? geminiSessionId(file) : crypto.createHash('sha1').update(f.path).digest('hex').slice(0, 12),
      tool: f.tool,
    });
    if (src) out.push(src);
  });
  return out;
}

// All readable sources, newest first. `apps` filters by app name when given.
function discover(ctx, opts) {
  opts = opts || {};
  const want = opts.apps && opts.apps.length ? new Set(opts.apps) : null;
  const cursorFamily = cursorSources(ctx);
  const all = []
    .concat(claudeSources(ctx))
    .concat(codexSources(ctx))
    .concat(kiroSources(ctx))
    .concat(cursorFamily)
    .concat(opts.foreign === false ? [] : foreignSources(ctx));
  const seen = new Set();
  const out = [];
  for (const src of all) {
    if (want && !want.has(src.app)) continue;
    // The dedupe key is the CHAT, not the file: a Cursor store contributes many sources with one
    // path, and keying on the path would collapse months of work into the first composer.
    const key = src.composerId ? src.path + '#' + src.composerId : src.path;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(src);
    if (out.length >= (opts.limitSources || SOURCE_BUDGET)) break;
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  // Store-level refusals and degraded reads travel with the source list for the index report to
  // print — but only when this run actually asked for Cursor, so `--app claude` does not inherit
  // another app's complaint.
  const asked = !want || want.has('cursor');
  out.storeIssues = asked ? cursorFamily.issues || [] : [];
  out.storeWarnings = asked ? cursorFamily.storeWarnings || [] : [];
  return out;
}

// Load one source into the canonical shape.
function load(ctx, src, opts) {
  opts = opts || {};
  // Cursor's stores are SQLite databases or its own JSONL mirror, not the text formats below:
  // reading a 100 MB vscdb as a string would hit the text size cap and decode megabytes of non-chat
  // state. The adapter opens them itself, for every one of its three kinds.
  if (src.kind === 'cursor-composer' || src.kind === 'cursor-agent' || src.kind === 'cursor-transcript')
    return parseCursorChat(ctx, src, opts);
  const text = readText(src.path);
  if (src.kind === 'claude-local') return parseClaudeLocal(text, src, opts);
  if (src.kind === 'codex-rollout')
    return parseCodexRollout(text, src, Object.assign({}, opts, { titles: opts.titles || codexTitles(ctx) }));
  if (src.kind === 'kiro-cli') return parseKiroCli(text, src, opts);
  if (src.kind === 'kiro-ide') return parseKiroIde(text, src, opts);
  if (src.kind === 'gemini-transcript') return parseGeminiTranscript(text, src, opts);
  return parseForeignSource(text, src, opts);
}

// Metadata for every source. Parsing is required for honest titles/counts; callers
// that only need a directory listing can pass `fast` to skip empty sources.
function list(ctx, opts) {
  opts = opts || {};
  const rows = [];
  const errors = [];
  discover(ctx, opts).forEach((src) => {
    try {
      const c = load(ctx, src, opts);
      rows.push({
        id: c.id,
        app: c.app,
        surface: c.surface,
        title: c.title,
        cwd: c.cwd,
        account: c.account,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        counts: c.counts,
        source: c.source,
        hash: c.hash,
      });
    } catch (e) {
      errors.push({ path: src.path, app: src.app, error: (e && e.message) || String(e) });
    }
  });
  rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return { conversations: rows, errors: errors };
}

function matchRef(rows, ref) {
  const s = String(ref == null ? '' : ref).trim();
  if (!s) return { match: null, reason: 'empty' };
  const exact = rows.filter((r) => r.id === s);
  if (exact.length === 1) return { match: exact[0] };
  const pref = rows.filter((r) => r.id.indexOf(s) === 0 || r.id.split(':').pop().indexOf(s) === 0);
  if (pref.length === 1) return { match: pref[0] };
  if (pref.length > 1) return { match: null, reason: 'ambiguous', candidates: pref.slice(0, 10) };
  const low = s.toLowerCase();
  const titled = rows.filter(
    (r) =>
      String(r.title || '')
        .toLowerCase()
        .indexOf(low) !== -1,
  );
  if (titled.length === 1) return { match: titled[0] };
  if (titled.length > 1) return { match: null, reason: 'ambiguous', candidates: titled.slice(0, 10) };
  return { match: null, reason: 'not-found' };
}

// Resolve an id/prefix/title to one source and load it. Ambiguity is an error, not
// a silent first hit — transferring the wrong conversation is worse than retrying.
function get(ctx, ref, opts) {
  const r = list(ctx, opts);
  const m = matchRef(r.conversations, ref);
  if (!m.match) {
    const e = new Error(
      m.reason === 'ambiguous'
        ? "'" + ref + "' matches several conversations — use more of the id"
        : "no conversation matching '" + ref + "'",
    );
    e.code = m.reason === 'ambiguous' ? 'CONV_AMBIGUOUS' : 'CONV_NOT_FOUND';
    e.candidates = m.candidates || [];
    throw e;
  }
  const src = discover(ctx, opts).find((s) => s.path === m.match.source.path);
  if (!src) {
    const e = new Error('the source for ' + m.match.id + ' disappeared');
    e.code = 'CONV_SOURCE_GONE';
    throw e;
  }
  return load(ctx, src, opts);
}

function find(ctx, ref, opts) {
  return matchRef(list(ctx, opts).conversations, ref);
}

// Load one source straight from its file path. Used when a cheap catalog lookup already
// resolved the source: stat-only discovery, then parse just that file.
function loadPath(ctx, file, opts) {
  const want = path.resolve(file);
  const src = discover(ctx, Object.assign({}, opts, { apps: null })).find((s) => path.resolve(s.path) === want);
  if (!src) {
    const e = new Error('the source for this conversation is no longer on disk: ' + file);
    e.code = 'CONV_SOURCE_GONE';
    throw e;
  }
  return load(ctx, src, opts);
}

function toParsed(conv) {
  return { messages: conv.messages, cwd: conv.cwd, counts: conv.counts };
}

export {
  SCHEMA_VERSION,
  MAX_FILE_BYTES,
  MAX_MESSAGE_CHARS,
  discover,
  load,
  loadPath,
  list,
  get,
  find,
  matchRef,
  toParsed,
  countsOf,
  codexTitles,
  claudeRoot,
  codexRoot,
  kiroRoot,
  readText,
  isInjected,
  makeConv,
};
