// Read-only reader for VS Code Copilot Chat persisted sessions (`chatSessions/*.jsonl`).
//
// VS Code stores each session as an append-only JSONL replay log (`MFi` protocol):
//   line with kind=0  initial snapshot `{ kind: 0, v: { sessionId, customTitle, creationDate, workingDirectory, requests, ... } }`
//   line with kind=1  set property at path `k` to `v` (`_applySet`)
//   line with kind=2  push array items `v` at path `k` (optionally truncating array to index `i` first)
//   line with kind=3  delete property at path `k`
// Discovered across both `User/workspaceStorage/<hash>/chatSessions/*.jsonl` (reading sibling
// `workspace.json` for fallback cwd) and `User/globalStorage/emptyWindowChatSessions/*.jsonl`,
// deduplicated newest-first by session id.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { uriToPath } from './cursor.js';

const MAX_MESSAGE_CHARS = 200000;
const MAX_MESSAGES = 20000;
const MAX_TEXT_BYTES = 256 * 1024 * 1024;
const USER_BASES = ['Library/Application Support/Code', 'AppData/Roaming/Code', '.config/Code'];
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function envOf(ctx) {
  if (ctx && ctx.env) return ctx.env;
  if (ctx && ctx.home && ctx.home !== os.homedir()) return {};
  return process.env;
}

function homeOf(ctx) {
  return (ctx && ctx.home) || os.homedir();
}

function toIso(v) {
  if (typeof v === 'number' && isFinite(v) && v > 0) {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(Math.round(ms));
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v.trim());
    if (!isNaN(t)) return new Date(t).toISOString();
  }
  return null;
}

function isSafeKey(k) {
  const s = String(k);
  return !BAD_KEYS.has(s);
}

function isArrayIndex(k) {
  return typeof k === 'number' && Number.isInteger(k) && k >= 0 && k < 1000000;
}

function walkParent(root, keys) {
  if (!root || typeof root !== 'object' || !Array.isArray(keys) || keys.length === 0) return null;
  let cur = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const seg = keys[i];
    if (!isSafeKey(seg)) return null;
    if (cur[seg] == null || typeof cur[seg] !== 'object') {
      cur[seg] = isArrayIndex(keys[i + 1]) ? [] : {};
    }
    cur = cur[seg];
    if (!cur || typeof cur !== 'object') return null;
  }
  const last = keys[keys.length - 1];
  if (!isSafeKey(last)) return null;
  return { parent: cur, key: last };
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

// Replay VS Code's `chatSessions/*.jsonl` snapshot/patch stream into the final session object.
function replayState(input) {
  let state = null;
  eachLine(input, function (line) {
    if (!line || !line.trim()) return;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      return;
    }
    if (!rec || typeof rec !== 'object') return;
    if (rec.kind === 0) {
      if (rec.v && typeof rec.v === 'object') state = rec.v;
      return;
    }
    if (rec.kind === undefined && state === null && Array.isArray(rec.requests)) {
      state = rec;
      return;
    }
    if (!state || typeof state !== 'object') state = {};
    if (rec.kind === 1 || rec.kind === 3) {
      const target = walkParent(state, rec.k);
      if (!target) return;
      if (rec.kind === 3 || rec.v === undefined) delete target.parent[target.key];
      else target.parent[target.key] = rec.v;
      return;
    }
    if (rec.kind === 2) {
      const target = walkParent(state, rec.k);
      if (!target) return;
      if (!Array.isArray(target.parent[target.key])) target.parent[target.key] = [];
      const arr = target.parent[target.key];
      if (typeof rec.i === 'number' && Number.isInteger(rec.i) && rec.i >= 0 && rec.i < arr.length) {
        arr.length = rec.i;
      }
      if (Array.isArray(rec.v)) {
        for (let idx = 0; idx < rec.v.length; idx++) arr.push(rec.v[idx]);
      }
    }
  });
  return state;
}

function clampText(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  return t.length > MAX_MESSAGE_CHARS ? t.slice(0, MAX_MESSAGE_CHARS) : t;
}

function extractUserText(msg) {
  if (!msg) return '';
  if (typeof msg === 'string') return clampText(msg);
  if (typeof msg !== 'object') return '';
  if (typeof msg.text === 'string' && msg.text.trim()) return clampText(msg.text);
  if (Array.isArray(msg.parts)) {
    const out = msg.parts
      .map(function (p) {
        return p && typeof p.text === 'string' ? p.text : '';
      })
      .filter(Boolean)
      .join('\n');
    return clampText(out);
  }
  return '';
}

function extractResponse(resp) {
  const parts = [];
  const tools = [];
  const seenTools = new Set();
  const items = Array.isArray(resp) ? resp : typeof resp === 'string' ? [resp] : [];
  for (const item of items) {
    if (!item) continue;
    if (typeof item === 'string') {
      if (item.trim()) parts.push(item.trim());
      continue;
    }
    if (typeof item !== 'object') continue;
    // Skip reasoning traces and raw tool execution payloads (K9).
    if (item.kind === 'thinking') continue;
    if (item.kind === 'toolInvocationSerialized' || item.kind === 'toolInvocation') {
      const name = item.toolId || item.toolName || item.name;
      if (typeof name === 'string' && name.trim() && !seenTools.has(name.trim())) {
        seenTools.add(name.trim());
        tools.push(name.trim());
      }
      continue;
    }
    if ((!item.kind || item.kind === 'markdownContent' || item.kind === 'text') && typeof item.value === 'string') {
      if (item.value.trim()) parts.push(item.value.trim());
      continue;
    }
    if (item.kind === 'markdownContent' && item.content && typeof item.content.value === 'string') {
      if (item.content.value.trim()) parts.push(item.content.value.trim());
      continue;
    }
    if (item.kind === 'text' && typeof item.text === 'string' && item.text.trim()) {
      parts.push(item.text.trim());
    }
  }
  return { text: clampText(parts.join('\n')), tools: tools };
}

// Candidate `<Code>/User` directories across macOS, Windows, and Linux.
function userDirs(ctx) {
  const env = envOf(ctx);
  const home = homeOf(ctx);
  const out = [];
  const push = function (p) {
    if (p && out.indexOf(p) < 0) out.push(p);
  };
  push(ctx && ctx.vscodeUserDir);
  if (env && env.APPDATA) push(path.join(env.APPDATA, 'Code', 'User'));
  if (env && env.XDG_CONFIG_HOME) push(path.join(env.XDG_CONFIG_HOME, 'Code', 'User'));
  USER_BASES.forEach(function (b) {
    push(path.join(home, b, 'User'));
  });
  return out;
}

function readWorkspaceCwd(wsDir) {
  try {
    const file = path.join(wsDir, 'workspace.json');
    const st = fs.statSync(file);
    if (!st.isFile() || st.size === 0 || st.size > 262144) return null;
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!doc || typeof doc !== 'object') return null;
    return uriToPath(doc.folder || doc.workspace || doc.directory || null);
  } catch {
    return null;
  }
}

// Discover VS Code chat session logs across workspaceStorage and emptyWindowChatSessions,
// deduplicated newest-first by session id (migrated sessions leave stale emptyWindow copies).
function discover(ctx) {
  const raw = [];
  const scanDir = function (chatDir, wsCwd, fromWorkspace) {
    let ents;
    try {
      ents = fs.readdirSync(chatDir, { withFileTypes: true });
    } catch {
      return;
    }
    ents.forEach(function (e) {
      if (!e.isFile() || !/\.jsonl$/i.test(e.name)) return;
      const file = path.join(chatDir, e.name);
      try {
        const st = fs.statSync(file);
        if (!st.isFile() || st.size === 0) return;
        raw.push({
          path: file,
          mtimeMs: st.mtimeMs,
          size: st.size,
          sessionId: e.name.replace(/\.jsonl$/i, ''),
          cwd: wsCwd || null,
          fromWorkspace: !!fromWorkspace,
          kind: 'vscode-chat',
          app: 'vscode-chat',
          surface: 'desktop',
        });
      } catch {
        /* vanished */
      }
    });
  };

  userDirs(ctx).forEach(function (uDir) {
    const wsRoot = path.join(uDir, 'workspaceStorage');
    try {
      const wsDirs = fs.readdirSync(wsRoot, { withFileTypes: true });
      wsDirs.forEach(function (d) {
        if (!d.isDirectory()) return;
        const dir = path.join(wsRoot, d.name);
        scanDir(path.join(dir, 'chatSessions'), readWorkspaceCwd(dir), true);
      });
    } catch {
      /* absent */
    }
    scanDir(path.join(uDir, 'globalStorage', 'emptyWindowChatSessions'), null, false);
  });

  raw.sort(function (a, b) {
    return b.mtimeMs - a.mtimeMs || (a.fromWorkspace === b.fromWorkspace ? 0 : a.fromWorkspace ? -1 : 1);
  });

  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (seen.has(item.sessionId)) continue;
    seen.add(item.sessionId);
    out.push({
      path: item.path,
      mtimeMs: item.mtimeMs,
      size: item.size,
      sessionId: item.sessionId,
      cwd: item.cwd,
      kind: 'vscode-chat',
      app: 'vscode-chat',
      surface: 'desktop',
    });
  }
  return out;
}

function cwdFromState(wd) {
  if (!wd) return null;
  if (typeof wd === 'string') return uriToPath(wd);
  if (typeof wd === 'object') return uriToPath(wd.fsPath || wd.path || null);
  return null;
}

// Parse one VS Code chatSessions JSONL stream/string into canonical messages + metadata.
function parseChatSession(input, opts) {
  opts = opts || {};
  const state = replayState(input);
  if (!state || typeof state !== 'object') {
    return {
      sessionId: opts.sessionId || null,
      title: null,
      cwd: opts.cwd || null,
      createdAt: null,
      updatedAt: null,
      messages: [],
      counts: { messages: 0, user: 0, assistant: 0 },
    };
  }
  const sessionId = typeof state.sessionId === 'string' && state.sessionId ? state.sessionId : opts.sessionId || null;
  const title =
    typeof state.customTitle === 'string' && state.customTitle.trim()
      ? state.customTitle.trim()
      : typeof state.title === 'string' && state.title.trim()
        ? state.title.trim()
        : null;
  const createdAt = toIso(state.creationDate || state.createdAt);
  const cwd = cwdFromState(state.workingDirectory) || opts.cwd || null;
  const requests = Array.isArray(state.requests) ? state.requests : [];

  const messages = [];
  let textBytes = 0;
  const push = function (role, text, tools, ts) {
    if (messages.length >= MAX_MESSAGES || textBytes >= MAX_TEXT_BYTES) return false;
    if (!text && !(tools && tools.length)) return false;
    const addBytes = Buffer.byteLength(text, 'utf8');
    if (textBytes + addBytes > MAX_TEXT_BYTES && messages.length > 0) {
      textBytes = MAX_TEXT_BYTES;
      return false;
    }
    textBytes += addBytes;
    messages.push({ role: role, text: text, ts: ts || null, tools: tools || [] });
    return true;
  };

  for (const req of requests) {
    if (!req || typeof req !== 'object' || req.isHidden || req.hiddenFromTranscript) continue;
    const reqTs = toIso(req.timestamp || req.requestTimestamp) || createdAt || null;
    if (!req.requestHiddenFromTranscript && !req.isSystemInitiated) {
      const uText = extractUserText(req.message);
      if (uText) push('user', uText, [], reqTs);
    }
    const asst = extractResponse(req.response);
    const asstTs = toIso(req.responseTimestamp || req.timestamp) || reqTs || null;
    if (asst.text || asst.tools.length) push('assistant', asst.text, asst.tools, asstTs);
  }

  const counts = {
    messages: messages.length,
    user: messages.filter(function (m) {
      return m.role === 'user';
    }).length,
    assistant: messages.filter(function (m) {
      return m.role === 'assistant';
    }).length,
  };
  const updatedAt =
    toIso(state.lastMessageDate) || (messages.length ? messages[messages.length - 1].ts : null) || createdAt || null;

  return {
    sessionId: sessionId,
    title: title,
    cwd: cwd,
    createdAt: createdAt || (messages[0] && messages[0].ts) || null,
    updatedAt: updatedAt,
    messages: messages,
    counts: counts,
  };
}

export { userDirs, discover, replayState, parseChatSession };
