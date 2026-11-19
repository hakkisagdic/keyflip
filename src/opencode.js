// Read-only reader for opencode's SQLite database (`~/.local/share/opencode/opencode.db`).
//
// Selects ONLY from `session`, `message`, and `part` — never reads `credential`, `account`,
// `account_state`, `control_account`, or `event`. Opens via `sqliteread.openFile` (read-only fd +
// committed `-wal` page overlay), closes the handle in `finally`, and peeks column headers before
// chasing overflow page chains so multi-megabyte `tool` and `reasoning` payloads are never loaded.
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as sq from './sqliteread.js';

const MAX_SCAN_ROWS = 1000000;
const MAX_SCAN_BYTES = 2 * 1024 * 1024 * 1024;
const CACHE_MAX = 4;
const storeCache = new Map();

function envOf(ctx) {
  return (ctx && ctx.env) || process.env;
}

function homeOf(ctx) {
  return (ctx && ctx.home) || os.homedir();
}

function toMs(v) {
  if (typeof v === 'number' && isFinite(v) && v > 0) {
    return v > 1e12 ? Math.round(v) : Math.round(v * 1000);
  }
  if (typeof v === 'string' && /^\d{10,}(\.\d+)?$/.test(v.trim())) {
    return toMs(Number(v.trim()));
  }
  return null;
}

function toIso(v) {
  const ms = toMs(v);
  if (ms != null) {
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v.trim());
    if (!isNaN(t)) return new Date(t).toISOString();
  }
  return null;
}

function strOrNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t || null;
}

function decodeJson(raw) {
  if (raw == null) return null;
  let s = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  try {
    const j = JSON.parse(s);
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

// Fast top-level `"type"` extractor on an on-page JSON prefix of `part.data`. Returns the string
// type if it can be read unambiguously before any complex/escaped field, or null to fall back to
// reading the full overflow chain.
function peekJsonType(head) {
  if (typeof head !== 'string') return null;
  let i = 0;
  const n = head.length;
  while (i < n && head.charCodeAt(i) <= 32) i++;
  if (i >= n || head[i] !== '{') return null;
  i++;
  while (i < n) {
    while (i < n && (head.charCodeAt(i) <= 32 || head[i] === ',')) i++;
    if (i >= n || head[i] !== '"') return null;
    i++;
    const ks = i;
    while (i < n && head[i] !== '"' && head[i] !== '\\') i++;
    if (i >= n || head[i] === '\\') return null;
    const key = head.slice(ks, i);
    i++;
    while (i < n && head.charCodeAt(i) <= 32) i++;
    if (i >= n || head[i] !== ':') return null;
    i++;
    while (i < n && head.charCodeAt(i) <= 32) i++;
    if (i >= n) return null;
    if (key === 'type') {
      if (head[i] !== '"') return null;
      i++;
      const vs = i;
      while (i < n && head[i] !== '"' && head[i] !== '\\') i++;
      if (i >= n || head[i] === '\\') return null;
      return head.slice(vs, i);
    }
    const ch = head[i];
    if (ch === '"') {
      i++;
      while (i < n && head[i] !== '"' && head[i] !== '\\') i++;
      if (i >= n || head[i] === '\\') return null;
      i++;
    } else if (ch === '{' || ch === '[') {
      return null;
    } else {
      const start = i;
      while (i < n && head[i] !== ',' && head[i] !== '}' && head.charCodeAt(i) > 32) i++;
      if (i === start || i >= n) return null;
    }
  }
  return null;
}

// Discover existing opencode SQLite database files on this machine, newest first.
function storePaths(ctx) {
  const env = envOf(ctx);
  const home = homeOf(ctx);
  const candidates = [];
  const push = function (p) {
    if (typeof p === 'string' && p) candidates.push(p);
  };
  if (ctx && ctx.opencodeDb) {
    if (Array.isArray(ctx.opencodeDb)) ctx.opencodeDb.forEach(push);
    else push(ctx.opencodeDb);
  }
  if (env && env.XDG_DATA_HOME) push(path.join(env.XDG_DATA_HOME, 'opencode', 'opencode.db'));
  push(path.join(home, '.local', 'share', 'opencode', 'opencode.db'));
  push(path.join(home, 'AppData', 'Local', 'opencode', 'opencode.db'));

  const out = [];
  const seen = new Set();
  for (const file of candidates) {
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size === 0) continue;
      const real = fs.realpathSync(file);
      if (seen.has(real)) continue;
      seen.add(real);
      out.push({ file: file, real: real, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* absent or unreadable */
    }
  }
  out.sort(function (a, b) {
    return b.mtimeMs - a.mtimeMs;
  });
  return out;
}

function peekRecordPartial(payload, want) {
  try {
    return sq.decodeColumns(payload, want, false);
  } catch {
    return null;
  }
}

function cmpId(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Read all top-level user/assistant text conversations from one `opencode.db` into memory (cached by
// realpath + mtime + size + optional `-wal` mtime + size). Never writes, never locks, closes fd in finally.
function readStore(file, opts) {
  opts = opts || {};
  const st = fs.statSync(file);
  let real;
  try {
    real = fs.realpathSync(file);
  } catch {
    real = path.resolve(file);
  }
  let walFile = null;
  let walMtimeMs = 0;
  let walSize = 0;
  try {
    const wst = fs.statSync(file + '-wal');
    if (wst.isFile() && wst.size > 0) {
      walFile = file + '-wal';
      walMtimeMs = wst.mtimeMs;
      walSize = wst.size;
    }
  } catch {
    /* no -wal sidecar */
  }
  const cacheKey = [real, st.mtimeMs, st.size, walMtimeMs, walSize].join('|');
  const cached = storeCache.get(cacheKey);
  if (cached) return cached;

  const maxRows = opts.maxScanRows || MAX_SCAN_ROWS;
  const maxBytes = opts.maxScanBytes || MAX_SCAN_BYTES;
  const result = {
    file: file,
    real: real,
    mtimeMs: st.mtimeMs,
    size: st.size,
    sessions: new Map(),
    skipped: false,
    reason: null,
    warning: null,
  };

  let handle = null;
  try {
    handle = sq.openFile(file, { walFile: walFile });
    if (walFile && handle.walPages === 0 && handle.walBytes > 32) {
      result.warning =
        'the opencode database has an unflushed -wal sidecar that could not be replayed — quit opencode to checkpoint it, then re-index.';
    }
    const view = handle.view;
    const cx = handle.cx;

    // Query ONLY session, message, part — never touch credential/account tables.
    const sessionMeta = sq.tableMeta(view, cx, 'session');
    const messageMeta = sq.tableMeta(view, cx, 'message');
    const partMeta = sq.tableMeta(view, cx, 'part');
    if (!sessionMeta || !messageMeta || !partMeta) {
      result.skipped = true;
      result.reason = 'missing expected session/message/part table';
      cachePut(cacheKey, result);
      return result;
    }

    const sCol = indexCols(sessionMeta.columns);
    const mCol = indexCols(messageMeta.columns);
    const pCol = indexCols(partMeta.columns);
    if (
      sCol('id') < 0 ||
      mCol('id') < 0 ||
      mCol('session_id') < 0 ||
      mCol('data') < 0 ||
      pCol('id') < 0 ||
      pCol('message_id') < 0 ||
      pCol('data') < 0
    ) {
      result.skipped = true;
      result.reason = 'unexpected opencode table columns';
      cachePut(cacheKey, result);
      return result;
    }

    const budget = { rows: 0, bytes: 0, aborted: false };
    const tick = function (payloadSize) {
      if (budget.aborted || budget.rows >= maxRows || budget.bytes >= maxBytes) {
        budget.aborted = true;
        return false;
      }
      budget.rows++;
      budget.bytes += payloadSize;
      return true;
    };

    // 1. Scan `session`: keep top-level sessions only (parent_id null or empty).
    const sessions = new Map();
    const sIdxId = sCol('id');
    const sIdxParent = sCol('parent_id');
    const sIdxDir = sCol('directory');
    const sIdxTitle = sCol('title');
    const sIdxCreated = sCol('time_created');
    const sIdxUpdated = sCol('time_updated');
    sq.walkCells(view, cx, sessionMeta.root, function (payloadSize, payloadStart, rowid) {
      if (!tick(payloadSize) || payloadSize > sq.MAX_PAYLOAD_BYTES) return;
      const rec = sq.parseRecord(sq.readCellPayload(view, cx, payloadSize, payloadStart));
      const rawId = rec[sIdxId] != null ? rec[sIdxId] : rowid;
      if (rawId == null) return;
      const id = String(rawId);
      if (!id) return;
      const parentId = sIdxParent >= 0 ? rec[sIdxParent] : null;
      if (parentId != null && String(parentId).trim() !== '') return; // child/subagent session
      sessions.set(id, {
        id: id,
        directory: sIdxDir >= 0 ? strOrNull(rec[sIdxDir]) : null,
        title: sIdxTitle >= 0 ? strOrNull(rec[sIdxTitle]) : null,
        timeCreatedMs: sIdxCreated >= 0 ? toMs(rec[sIdxCreated]) : null,
        timeUpdatedMs: sIdxUpdated >= 0 ? toMs(rec[sIdxUpdated]) : null,
      });
    });

    if (budget.aborted) {
      result.skipped = true;
      result.reason = 'opencode scan budget exceeded';
      cachePut(cacheKey, result);
      return result;
    }
    if (sessions.size === 0) {
      cachePut(cacheKey, result);
      return result;
    }

    // 2. Scan `message`: keep user/assistant messages belonging to top-level sessions.
    const mIdxId = mCol('id');
    const mIdxSid = mCol('session_id');
    const mIdxCreated = mCol('time_created');
    const mIdxData = mCol('data');
    const mPeekNeed = Math.max(mIdxId, mIdxSid) + 1;
    const keptMessages = new Map();
    const msgsBySession = new Map();

    sq.walkCells(view, cx, messageMeta.root, function (payloadSize, payloadStart, rowid) {
      if (!tick(payloadSize) || payloadSize > sq.MAX_PAYLOAD_BYTES) return;
      const K = sq.onPagePayloadBytes(payloadSize, cx.usable);
      const head = view.read(payloadStart, Math.min(K, payloadSize));
      const peek = sq.peekColumns(head, mPeekNeed);
      if (peek && peek[mIdxSid] != null && !sessions.has(String(peek[mIdxSid]))) return;
      const payload = payloadSize <= K ? head : sq.readCellPayload(view, cx, payloadSize, payloadStart);
      const rec = sq.parseRecord(payload);
      const rawSid = rec[mIdxSid];
      if (rawSid == null) return;
      const sid = String(rawSid);
      if (!sessions.has(sid)) return;
      const rawId = rec[mIdxId] != null ? rec[mIdxId] : rowid;
      if (rawId == null) return;
      const mid = String(rawId);
      const d = decodeJson(rec[mIdxData]);
      const role = d && (d.role === 'user' || d.role === 'assistant') ? d.role : null;
      if (!role) return;
      const tCreated = mIdxCreated >= 0 ? toMs(rec[mIdxCreated]) || 0 : 0;
      const msgObj = { id: mid, sessionId: sid, role: role, timeCreated: tCreated, parts: [] };
      keptMessages.set(mid, msgObj);
      let list = msgsBySession.get(sid);
      if (!list) msgsBySession.set(sid, (list = []));
      list.push(msgObj);
    });

    if (budget.aborted) {
      result.skipped = true;
      result.reason = 'opencode scan budget exceeded';
      cachePut(cacheKey, result);
      return result;
    }

    // 3. Scan `part`: keep non-synthetic, non-ignored `type === 'text'` parts on kept messages.
    const pIdxId = pCol('id');
    const pIdxMid = pCol('message_id');
    const pIdxSid = pCol('session_id');
    const pIdxCreated = pCol('time_created');
    const pIdxData = pCol('data');
    const pPeekNeed = Math.max(pIdxId, pIdxMid, pIdxSid >= 0 ? pIdxSid : 0) + 1;

    sq.walkCells(view, cx, partMeta.root, function (payloadSize, payloadStart, rowid) {
      if (!tick(payloadSize) || payloadSize > sq.MAX_PAYLOAD_BYTES) return;
      const K = sq.onPagePayloadBytes(payloadSize, cx.usable);
      const head = view.read(payloadStart, Math.min(K, payloadSize));
      const peek = sq.peekColumns(head, pPeekNeed);
      if (peek) {
        if (pIdxSid >= 0 && peek[pIdxSid] != null && !sessions.has(String(peek[pIdxSid]))) return;
        if (peek[pIdxMid] != null && !keptMessages.has(String(peek[pIdxMid]))) return;
      }
      if (payloadSize > K) {
        const partial = peekRecordPartial(head, pIdxData + 1);
        if (partial && typeof partial[pIdxData] === 'string') {
          const pType = peekJsonType(partial[pIdxData]);
          if (pType !== null && pType !== 'text') return;
        }
      }
      const payload = payloadSize <= K ? head : sq.readCellPayload(view, cx, payloadSize, payloadStart);
      const rec = sq.parseRecord(payload);
      const rawMid = rec[pIdxMid];
      if (rawMid == null) return;
      const msg = keptMessages.get(String(rawMid));
      if (!msg) return;
      const d = decodeJson(rec[pIdxData]);
      if (!d || d.type !== 'text' || d.synthetic || d.ignored || typeof d.text !== 'string') return;
      const txt = d.text.trim();
      if (!txt) return;
      const rawPid = rec[pIdxId] != null ? rec[pIdxId] : rowid;
      const pid = rawPid != null ? String(rawPid) : '';
      const pCreated =
        (pIdxCreated >= 0 ? toMs(rec[pIdxCreated]) : null) || (d.time && toMs(d.time.start)) || msg.timeCreated || 0;
      msg.parts.push({ id: pid, timeCreated: pCreated, text: txt });
    });

    if (budget.aborted) {
      result.skipped = true;
      result.reason = 'opencode scan budget exceeded';
      cachePut(cacheKey, result);
      return result;
    }

    // 4. Assemble ordered conversations per top-level session.
    sessions.forEach(function (sess) {
      const msgList = msgsBySession.get(sess.id);
      if (!msgList || !msgList.length) return;
      msgList.sort(function (a, b) {
        return a.timeCreated - b.timeCreated || cmpId(a.id, b.id);
      });
      const messages = [];
      let maxMsgMs = 0;
      for (const m of msgList) {
        if (!m.parts.length) continue;
        m.parts.sort(function (a, b) {
          return a.timeCreated - b.timeCreated || cmpId(a.id, b.id);
        });
        const text = m.parts
          .map(function (p) {
            return p.text;
          })
          .join('\n')
          .trim();
        if (!text) continue;
        if (m.timeCreated > maxMsgMs) maxMsgMs = m.timeCreated;
        messages.push({
          role: m.role,
          text: text,
          ts: m.timeCreated ? new Date(m.timeCreated).toISOString() : null,
          tools: [],
        });
      }
      if (!messages.length) return;
      const updatedMs = sess.timeUpdatedMs || maxMsgMs || st.mtimeMs;
      result.sessions.set(sess.id, {
        sessionId: sess.id,
        title: sess.title,
        cwd: sess.directory,
        createdAt: toIso(sess.timeCreatedMs) || messages[0].ts,
        updatedAt: toIso(updatedMs) || messages[messages.length - 1].ts,
        mtimeMs: updatedMs,
        size: st.size,
        messages: messages,
        source: { path: file, subId: sess.id, mtimeMs: updatedMs, size: st.size },
      });
    });

    cachePut(cacheKey, result);
    return result;
  } finally {
    if (handle) {
      try {
        handle.close();
      } catch {
        /* ignore close errors */
      }
    }
  }
}

function indexCols(columns) {
  return function (name) {
    return columns.indexOf(name);
  };
}

function cachePut(key, val) {
  if (storeCache.size >= CACHE_MAX) {
    storeCache.delete(storeCache.keys().next().value);
  }
  storeCache.set(key, val);
}

// Discover every top-level opencode session across SQLite stores, newest first.
function discover(ctx) {
  const stores = storePaths(ctx);
  const rows = [];
  const seen = new Set();
  const skipped = [];
  const warnings = [];
  for (const s of stores) {
    let store;
    try {
      store = readStore(s.file, (ctx && ctx.opencode) || {});
    } catch (e) {
      skipped.push({ file: s.file, reason: (e && e.message) || 'unreadable opencode database' });
      continue;
    }
    if (store.skipped) {
      skipped.push({ file: s.file, reason: store.reason || 'unreadable opencode database' });
      continue;
    }
    if (store.warning) warnings.push({ file: s.file, reason: store.warning });
    store.sessions.forEach(function (sess) {
      if (seen.has(sess.sessionId)) return;
      seen.add(sess.sessionId);
      rows.push({
        path: s.file,
        mtimeMs: sess.mtimeMs,
        size: sess.size,
        sessionId: sess.sessionId,
        subId: sess.sessionId,
        kind: 'opencode-db',
        app: 'opencode',
        surface: 'cli',
        title: sess.title,
        cwd: sess.cwd,
        createdAt: sess.createdAt,
        updatedAt: sess.updatedAt,
      });
    });
  }
  rows.sort(function (a, b) {
    return b.mtimeMs - a.mtimeMs;
  });
  rows.skipped = skipped;
  rows.warnings = warnings;
  return rows;
}

function loadChat(ctx, src) {
  const sid = src && (src.sessionId || src.subId);
  if (!src || !src.path || !sid) throw new Error('missing opencode session reference');
  const store = readStore(src.path, (ctx && ctx.opencode) || {});
  if (store.skipped) throw new Error(store.reason || 'unreadable opencode database');
  const sess = store.sessions.get(String(sid));
  if (!sess) throw new Error('opencode session ' + sid + ' has no readable text messages in ' + src.path);
  return sess;
}

export { storePaths, readStore, discover, loadChat, storeCache, peekJsonType, MAX_SCAN_ROWS, MAX_SCAN_BYTES };
