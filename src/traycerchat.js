// Read-only reader for Traycer epic chat transcripts (`~/.traycer/epic-chat-transcripts/<epicUUID>/*.txt`).
//
// Format confidence: NEEDS-VERIFICATION — Traycer's inner `.txt` layout is not confirmed on a live
// multi-session corpus yet, so the parser splits conservatively on obvious line-start role markers
// (`User:` / `Assistant:`, `### User` / `### Assistant`, `[User]` / `[Assistant]`) and falls back to
// a single block when no markers appear. Only `epic-chat-transcripts/<epic>/*.txt` is allow-listed;
// `host/auth`, `chat-search.db`, `epics/`, credential files, and `*.enc` are never opened.
import fs from 'fs';
import os from 'os';
import path from 'path';

const MAX_MESSAGE_CHARS = 200000;
const MAX_MESSAGES = 20000;
const MAX_TEXT_BYTES = 256 * 1024 * 1024;
const PER_SOURCE_BUDGET = 25000;

const SKIP_DIR_RE = /^(host|auth|accounts?|credentials?|secrets?|tokens?|epics|\.git)$/i;
const SKIP_FILE_RE =
  /^(auth|accounts?|credentials?|secrets?|tokens?|oauth[\w-]*|config|settings|status)(?:$|[-_.\s])|\.enc(?:\.|$)/i;

const FULL_UUID_STEM_RE = /^(.*?)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const BARE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_ID_STEM_RE = /^(.*?)-([0-9a-f]{6,32}|[A-Za-z]*\d[A-Za-z0-9_]*)$/i;
const SHORT_PREFIX_STEM_RE = /^([A-Za-z0-9]{1,4})-([A-Za-z0-9_]{2,64})$/;

const ROLE_HEADING_RE = /^#{1,4}\s*(user|human|you|prompt|assistant|agent|ai|traycer|system)\s*:?\s*(.*)$/i;
const ROLE_BRACKET_RE = /^\[(user|human|you|prompt|assistant|agent|ai|traycer|system)\]\s*:?\s*(.*)$/i;
const ROLE_LABEL_RE = /^(?:\*\*)?(user|human|you|prompt|assistant|agent|ai|traycer|system)(?:\*\*)?\s*:\s*(.*)$/i;

function homeOf(ctx) {
  return (ctx && ctx.home) || os.homedir();
}

function traycerRoot(ctx) {
  return (ctx && ctx.traycerDir) || path.join(homeOf(ctx), '.traycer');
}

function parseFileStem(stem) {
  const s = String(stem || '').trim();
  let m = FULL_UUID_STEM_RE.exec(s);
  if (m) return { title: m[1].trim() || null, fileUuid: m[2] };
  if (BARE_UUID_RE.test(s)) return { title: null, fileUuid: s };
  m = SHORT_ID_STEM_RE.exec(s) || SHORT_PREFIX_STEM_RE.exec(s);
  if (m) return { title: m[1].trim() || null, fileUuid: m[2] };
  return { title: s || null, fileUuid: s || 'unknown' };
}

function discover(ctx) {
  const root = path.join(traycerRoot(ctx), 'epic-chat-transcripts');
  let epics;
  try {
    epics = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const raw = [];
  for (const d of epics) {
    if (!d.isDirectory() || d.isSymbolicLink() || SKIP_DIR_RE.test(d.name)) continue;
    const epicDir = path.join(root, d.name);
    let ents;
    try {
      ents = fs.readdirSync(epicDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (!e.isFile() || e.isSymbolicLink() || !/\.txt$/i.test(e.name) || SKIP_FILE_RE.test(e.name)) continue;
      const file = path.join(epicDir, e.name);
      try {
        const st = fs.statSync(file);
        if (!st.isFile() || st.size === 0) continue;
        const parsed = parseFileStem(e.name.replace(/\.txt$/i, ''));
        raw.push({
          path: file,
          mtimeMs: st.mtimeMs,
          size: st.size,
          epicId: d.name,
          fileUuid: parsed.fileUuid,
          title: parsed.title,
          kind: 'traycer-chat',
          app: 'traycer',
          surface: 'desktop',
        });
      } catch {
        /* vanished */
      }
    }
  }
  // Sort newest-first BEFORE applying any cap so newer transcripts are never dropped behind older files.
  raw.sort(function (a, b) {
    return b.mtimeMs - a.mtimeMs;
  });
  return raw.slice(0, PER_SOURCE_BUDGET);
}

function eachLine(input, fn) {
  if (typeof input === 'function') {
    input(fn);
    return;
  }
  String(input == null ? '' : input)
    .split('\n')
    .forEach(fn);
}

function normalizeRole(rawRole) {
  const low = String(rawRole || '').toLowerCase();
  if (low === 'user' || low === 'human' || low === 'you' || low === 'prompt') return 'user';
  if (low === 'assistant' || low === 'agent' || low === 'ai' || low === 'traycer') return 'assistant';
  if (low === 'system') return 'system';
  return null;
}

function matchRoleMarker(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;
  const m = ROLE_HEADING_RE.exec(trimmed) || ROLE_BRACKET_RE.exec(trimmed) || ROLE_LABEL_RE.exec(trimmed);
  if (!m) return null;
  const role = normalizeRole(m[1]);
  if (!role) return null;
  return { role: role, rest: String(m[2] || '').trim() };
}

function cleanText(text) {
  const cleaned = String(text == null ? '' : text)
    .replace(/\r\n/g, '\n')
    // eslint-disable-next-line no-control-regex -- stripping binary control bytes while keeping tabs/newlines
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > MAX_MESSAGE_CHARS ? cleaned.slice(0, MAX_MESSAGE_CHARS) : cleaned;
}

function emptyParsed(opts) {
  return {
    epicId: opts.epicId || null,
    fileUuid: opts.fileUuid || null,
    title: opts.title || null,
    cwd: null,
    createdAt: null,
    updatedAt: null,
    messages: [],
    counts: { messages: 0, user: 0, assistant: 0 },
  };
}

function parseTranscript(input, opts) {
  opts = opts || {};
  if (Buffer.isBuffer(input)) {
    if (input.includes(0)) return emptyParsed(opts);
    input = input.toString('utf8');
  }

  const messages = [];
  let textBytes = 0;
  let corrupt = false;
  let sawMarker = false;
  let curRole = null;
  let curLines = [];
  let curChars = 0;
  const preambleLines = [];
  let preambleChars = 0;

  const pushMessage = function (role, rawText) {
    if (role !== 'user' && role !== 'assistant') return;
    if (messages.length >= MAX_MESSAGES || textBytes >= MAX_TEXT_BYTES) return;
    const text = cleanText(rawText);
    if (!text) return;
    const addBytes = Buffer.byteLength(text, 'utf8');
    if (textBytes + addBytes > MAX_TEXT_BYTES && messages.length > 0) {
      textBytes = MAX_TEXT_BYTES;
      return;
    }
    textBytes += addBytes;
    messages.push({ role: role, text: text, tools: [], ts: null });
  };

  const flushCurrent = function () {
    if (curRole) pushMessage(curRole, curLines.join('\n'));
    curLines = [];
    curChars = 0;
  };

  const appendLimited = function (arr, charsRef, line) {
    if (charsRef >= MAX_MESSAGE_CHARS + 1024) return charsRef;
    arr.push(line);
    return charsRef + line.length + 1;
  };

  eachLine(input, function (rawLine) {
    if (corrupt) return;
    const line = String(rawLine == null ? '' : rawLine).replace(/\r$/, '');
    if (line.includes('\0')) {
      corrupt = true;
      return;
    }
    const marker = matchRoleMarker(line);
    if (marker) {
      if (sawMarker) flushCurrent();
      sawMarker = true;
      curRole = marker.role;
      curLines = marker.rest ? [marker.rest] : [];
      curChars = marker.rest ? marker.rest.length + 1 : 0;
      return;
    }
    if (!sawMarker) {
      preambleChars = appendLimited(preambleLines, preambleChars, line);
    } else if (curRole !== 'system') {
      curChars = appendLimited(curLines, curChars, line);
    }
  });

  if (corrupt) return emptyParsed(opts);
  if (sawMarker) flushCurrent();
  if (messages.length === 0 && preambleLines.length > 0) {
    pushMessage('assistant', preambleLines.join('\n'));
  }

  return {
    epicId: opts.epicId || null,
    fileUuid: opts.fileUuid || null,
    title: opts.title || null,
    cwd: null,
    createdAt: null,
    updatedAt: null,
    messages: messages,
    counts: {
      messages: messages.length,
      user: messages.filter(function (m) {
        return m.role === 'user';
      }).length,
      assistant: messages.filter(function (m) {
        return m.role === 'assistant';
      }).length,
    },
  };
}

export { traycerRoot, discover, parseFileStem, parseTranscript };
