// Cursor's own chat stores, read into keyflip's conversation shape.
//
// Cursor is TWO products with TWO stores, and keyflip reads both (read-only, always):
//
//   1. THE EDITOR (Cursor 2 → 3.x) keeps every chat on the machine in one VS Code-style SQLite
//      file, `User/globalStorage/state.vscdb` (older builds also wrote a copy per workspace under
//      `User/workspaceStorage/<hash>/`). Its `cursorDiskKV` key/value table holds:
//        composerData:<composerId>        the chat's state document: name, project, the ordered
//                                         bubble manifest, model, todos…
//        bubbleId:<composerId>:<bubbleId> one message: type 1 = you / 2 = the model, its text,
//                                         and for a tool turn the call and its result
//      Cursor ≥ 3.12 additionally maintains a real `composerHeaders` TABLE (one row per session:
//      composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, value)
//      as the sidebar's discovery index; databases older than that migration have no such table and
//      are discovered by scanning `composerData:` keys instead. The sidebar's other index — the
//      `ItemTable` key `composer.composerHeaders` — is a write-side registration that Cursor only
//      flushes on exit, so chats are enumerated from the data itself: a session the sidebar has not
//      written yet is still a chat, and a closed editor cannot hide history.
//
//   2. THE CLI AGENT (`cursor-agent`) keeps one SQLite file PER session:
//        ~/.cursor/chats/<md5 of the workspace path>/<session uuid>/store.db
//      with content-addressed `blobs(id, data)` (the conversation, as protobuf-framed JSON) and a
//      `meta(key, value)` row whose value is hex-encoded JSON (agent name, workspacePath,
//      createdAt), plus a sibling `meta.json` carrying the title and timestamps.
//
// WHAT THIS IS BUILT FROM. Cursor publishes no schema, so every field name and enum above comes
// from the shipped parsers of four independent reverse-engineering projects, in this order of
// confidence: agentgrep 3.26.13 (2026-10-25), txcript 3.17.8 (2026-09-01, read against real Cursor
// 3.16/3.17.8 sessions), SpecStory (Cursor 2–3.12+), and magpie's cursor provider (2026-02). The
// citations are in CHANGELOG. None of it was captured on the machine these lines were written on —
// Cursor is not installed here — so the tests pin the CONTRACT this adapter promises (tolerant
// reads, honest skips, no invented messages) against databases built by the same `sqlite3` binary
// keyflip uses elsewhere. Re-run them against a real install when one is available.
//
// THREE DECISIONS THAT COME FROM THAT EVIDENCE AND NOT FROM INTUITION:
//  - `fullConversationHeadersOnly` is AUTHORITATIVE. A store routinely holds bubbles the manifest
//    does not list — they are edited-away and regenerated turns, ~17% of rows on a real machine.
//    Rendering them would show the user a conversation that never happened, so when a manifest
//    exists, unlisted bubbles are counted and dropped, never appended.
//  - `grouping.isRenderable === false` on a header means Cursor itself does not draw that turn.
//    A header without `grouping` at all is kept: some builds omit the field, and dropping those
//    would silently delete whole transcripts.
//  - ONE FILE IS MANY CHATS, and the same composer can live in several files. Discovery expands
//    every composer and dedupes by composer id, newest store first; otherwise `conv index` would
//    embed one month of work as a single giant conversation, and embed it twice.
//
// MEMORY. `state.vscdb` is typically ~100 MB and has been observed in the tens of gigabytes, so
// this module never reads the file into a Buffer: it opens a page-wise handle (src/sqliteread.js
// openFile) and scans `cursorDiskKV` decoding only each row's KEY, keeping the rows whose prefix is
// a chat and reading a value only when a chat is actually built. A store bigger than the scan
// budget is reported as skipped with the numbers, and the same for a `-wal` that could not be
// replayed — the newest chat going missing is never silent.
import fs from 'fs';
import path from 'path';
import os from 'os';
import * as _sq from './sqliteread.js';

const KV_TABLE = 'cursorDiskKV';
const HEADERS_TABLE = 'composerHeaders';
const COMPOSER_PREFIX = 'composerData:';
const BUBBLE_PREFIX = 'bubbleId:';
// A walk that reads more than this stops and reports the store as skipped. The number is not a
// guess about Cursor: 2 GB of leaf pages is far past any machine's chat history that keyflip has
// seen, and letting a scheduled index pass read past that would cost minutes of I/O for no chat.
const MAX_SCAN_BYTES = 2 * 1024 * 1024 * 1024;
// The row ceiling is about memory, not patience: one kept chat row costs a key plus four numbers in
// the scan's cell list, so half a million of them is ~100 MB — the most an unattended index pass
// should hold for one app's database.
const MAX_SCAN_ROWS = 500000;
// The `agent-transcripts` mirror is plain text, so its bound is a text bound. keyflip's conversation
// layer caps a source at 160 MB; a transcript that big is a machine's whole year in one file and
// holding it plus its parsed form would double that in RAM.
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
// Bubble `type` values Cursor writes (1=user, 2=assistant). Nothing else is attested; an unknown
// type is still reported as the machine's turn rather than dropped, because a silently missing
// answer is worse than a mislabelled one.
const TYPE_USER = 1;
const TYPE_ASSISTANT = 2;
// `capabilityType`: 15 = a tool call (with its result), 30 = a thinking segment.
const CAP_TOOL = 15;
const CAP_THINKING = 30;
// Numeric tool ids seen in real bubbles (txcript, Cursor 3.17.8). `toolFormerData.name` is written
// alongside them, so this table is only a fallback for builds that omit the name.
const TOOL_NAMES = {
  15: 'run_terminal_command_v2',
  40: 'read_file_v2',
  41: 'ripgrep_raw_search',
  42: 'glob_file_search',
  51: 'ask_question',
};

function envOf(ctx) {
  return (ctx && ctx.env) || process.env;
}
function homeOf(ctx) {
  return (ctx && ctx.home) || os.homedir();
}

function pick(obj, names) {
  for (const n of names) {
    const v = obj && obj[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

// A timestamp in any shape Cursor has used: epoch milliseconds (composer rows), an RFC3339 string
// (bubbles), a fractional-millisecond float (`timingInfo`), or a numeric string.
function toIso(v) {
  if (typeof v === 'number' && isFinite(v)) {
    const ms = v > 1e12 ? v : v * 1000; // a bare seconds value is not a ms epoch of anything modern
    const d = new Date(Math.round(ms));
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!isNaN(t)) return new Date(t).toISOString();
    const n = Number(v);
    if (isFinite(n) && n > 0) return toIso(n);
  }
  return null;
}

// Ids go into keyflip's own keys and file names. Cursor's ids are UUIDs, but a bubble id with a
// literal newline has been observed in the wild, so anything outside [A-Za-z0-9._:-] folds to '-'
// and control characters go. The RAW id still addresses the row; only the reported identity is
// folded, so a hostile store cannot inject a path segment or a newline into an index key.
function safeId(v) {
  const s = String(v == null ? '' : v);
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is being removed
  const folded = s.replace(/[\u0000-\u001f\u007f]/g, '-').replace(/[^A-Za-z0-9._:-]/g, '-');
  return (
    folded
      .replace(/-{2,}/g, '-')
      .replace(/^[-.]+/, '')
      .slice(0, 120) || 'unknown'
  );
}

function decodeJson(raw) {
  if (raw == null) return null;
  let s = typeof raw === 'string' ? raw : String(raw);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // BLOB-affinity values keep a BOM sometimes
  try {
    const j = JSON.parse(s);
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null; // a torn or version-shifted row is not a chat; the sweep continues
  }
}

// ---- where Cursor keeps its files ------------------------------------------------------------

// The editor's `<app-data>/User` directories, existence-gated by the caller.
// `CURSOR_DESKTOP_USER_DIR` names the `User` directory itself (txcript's override); the rest are
// the platform defaults, listed together so one code path covers macOS, Windows and Linux.
const IDE_BASES = ['Library/Application Support/Cursor', 'AppData/Roaming/Cursor', '.config/Cursor'];
function ideUserDirs(ctx) {
  const env = envOf(ctx);
  const home = homeOf(ctx);
  const out = [];
  const push = function (p) {
    if (p && out.indexOf(p) < 0) out.push(p);
  };
  push(ctx && ctx.cursorUserDir);
  push(env && env.CURSOR_DESKTOP_USER_DIR);
  IDE_BASES.forEach(function (b) {
    push(path.join(home, b, 'User'));
  });
  if (env && env.XDG_CONFIG_HOME) push(path.join(env.XDG_CONFIG_HOME, 'Cursor', 'User'));
  return out;
}

// The CLI agent's config roots. `CURSOR_DATA_DIR` / `CURSOR_CONFIG_DIR` are the overrides the CLI
// itself documents; txcript reads `~/.cursor/chats` with no env support at all, so an override that
// does not exist must simply fall through instead of disabling the store.
function agentRoots(ctx) {
  const env = envOf(ctx);
  const home = homeOf(ctx);
  const out = [];
  const push = function (p) {
    if (p && out.indexOf(p) < 0) out.push(p);
  };
  push(ctx && ctx.cursorHome);
  push(env && env.CURSOR_DATA_DIR);
  push(env && env.CURSOR_CONFIG_DIR);
  if (env && env.XDG_CONFIG_HOME) push(path.join(env.XDG_CONFIG_HOME, 'cursor'));
  push(path.join(home, '.cursor'));
  return out;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// `file:///Users/me/proj` → `/Users/me/proj`, percent-decoded; a bare path passes through. Remote
// and WSL URI forms are reported as the decoded location they name, which is honest about being a
// path on another machine — the cwd is metadata, never a filesystem operation.
function uriToPath(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  if (raw.indexOf('file://') !== 0) return raw;
  let p = raw.replace(/^file:\/\/+/, '/');
  try {
    p = decodeURIComponent(p);
  } catch {
    /* a malformed escape is a path, not a crash */
  }
  // A Windows URI has an empty authority, so `file:///C:/work` decodes to `/C:/work`; the leading
  // slash is an artifact of the URI, not part of the path, and keeping it would make a cwd that
  // exists on no platform.
  p = p.replace(/^\/(?=[A-Za-z]:[\\/])/, '');
  return p;
}

// ---- the editor store ------------------------------------------------------------------------

// Every `state.vscdb` that could hold chats, newest first, each with the workspace folder it
// belongs to (VS Code writes that in the sibling `workspace.json`).
function storePaths(ctx) {
  const out = [];
  const seenFile = new Set();
  ideUserDirs(ctx).forEach(function (userDir) {
    const addFile = function (file, wsCwd) {
      try {
        const st = fs.statSync(file);
        if (!st.isFile() || st.size === 0) return;
        const key = fs.realpathSync(file);
        if (seenFile.has(key)) return;
        seenFile.add(key);
        out.push({ file: file, cwd: wsCwd || null, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* absent */
      }
    };
    addFile(path.join(userDir, 'globalStorage', 'state.vscdb'), null);
    const wsRoot = path.join(userDir, 'workspaceStorage');
    let dirs;
    try {
      dirs = fs.readdirSync(wsRoot, { withFileTypes: true });
    } catch {
      return;
    }
    dirs.forEach(function (d) {
      if (!d.isDirectory()) return;
      const dir = path.join(wsRoot, d.name);
      let wsCwd = null;
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8'));
        wsCwd = uriToPath(pick(doc, ['folder', 'workspace', 'directory']));
      } catch {
        /* no workspace.json, or not JSON: the store still may hold chats, just without a cwd */
      }
      addFile(path.join(dir, 'state.vscdb'), wsCwd);
    });
  });
  out.sort(function (a, b) {
    return b.mtimeMs - a.mtimeMs;
  });
  return out;
}

// Open a store, folding its `-wal` in as a page overlay. Returns the handle, or throws.
function openStore(file) {
  let wal = null;
  try {
    if (fs.statSync(file + '-wal').size > 0) wal = file + '-wal';
  } catch {
    /* no -wal sibling: the main file is fully checkpointed */
  }
  const handle = _sq.openFile(file, { walFile: wal });
  // A live editor's newest writes are in the -wal; if the overlay came back empty (a torn tail, a
  // foreign generation, an over-large log) those writes are invisible to us. Say so — "the newest
  // chat is missing" must never be silent. 32 bytes is the WAL header alone, which legitimately
  // holds zero frames; anything longer held a frame this reader could not use.
  if (wal && handle.walPages === 0 && handle.walBytes > 32) {
    handle.overlayWarning = 'the -wal sidecar could not be replayed';
  }
  return handle;
}

// A parsed store: descriptors of the chat rows, values read lazily. Cached by (path, mtime, size)
// because discovery reads every composer and each conversation load reads some of them again, and a
// 100 MB file must not be re-opened once per chat.
const storeCache = new Map();
const CACHE_MAX = 3;

function walWarning(handle) {
  if (!handle.overlayWarning) return null;
  return (
    'the store has an unflushed -wal this reader could not replay — quit Cursor to checkpoint it, ' +
    'then re-index; the newest chats may be missing.'
  );
}

function parseStore(file, ctx) {
  const opts = (ctx && ctx.cursor) || {};
  const st = fs.statSync(file);
  const cached = storeCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
  const handle = openStore(file);
  const store = {
    file: file,
    mtimeMs: st.mtimeMs,
    size: st.size,
    handle: handle,
    heads: new Map(), // composerId -> composerHeaders row (Cursor >= 3.12 only)
    composerCells: new Map(), // composerId -> cell descriptor of its composerData row
    bubbleCells: new Map(), // composerId -> Map(bubbleId -> cell descriptor)
    hasHeadersTable: false,
    warning: walWarning(handle),
    skipped: false,
    scan: null,
    docs: new Map(), // small decode cache, FIFO
  };
  try {
    const cols = _sq.tableColumns(handle, HEADERS_TABLE);
    if (cols.length && cols.indexOf('composerId') >= 0) {
      store.hasHeadersTable = true;
      const at = function (name) {
        return cols.indexOf(name);
      };
      _sq.readTable(handle, HEADERS_TABLE).forEach(function (row) {
        const cid = at('composerId') >= 0 ? row[at('composerId')] : null;
        if (typeof cid !== 'string' || !cid) return;
        store.heads.set(cid, {
          composerId: cid,
          workspaceId: at('workspaceId') >= 0 ? row[at('workspaceId')] : null,
          createdAt: at('createdAt') >= 0 ? row[at('createdAt')] : null,
          lastUpdatedAt: at('lastUpdatedAt') >= 0 ? row[at('lastUpdatedAt')] : null,
          isArchived: at('isArchived') >= 0 ? row[at('isArchived')] : null,
          isSubagent: at('isSubagent') >= 0 ? row[at('isSubagent')] : null,
          recency: at('recency') >= 0 ? row[at('recency')] : null,
          head: decodeJson(at('value') >= 0 ? row[at('value')] : null),
        });
      });
    }
    const want = function (k) {
      return k.indexOf(COMPOSER_PREFIX) === 0 || k.indexOf(BUBBLE_PREFIX) === 0;
    };
    const scan = _sq.scanCells(handle, KV_TABLE, want, {
      maxBytes: opts.maxScanBytes || MAX_SCAN_BYTES,
      maxRows: opts.maxScanRows || MAX_SCAN_ROWS,
    });
    store.scan = scan;
    scan.cells.forEach(function (cell) {
      if (cell.key.indexOf(COMPOSER_PREFIX) === 0) {
        const cid = cell.key.slice(COMPOSER_PREFIX.length);
        if (cid) store.composerCells.set(cid, cell);
        return;
      }
      const rest = cell.key.slice(BUBBLE_PREFIX.length);
      const sep = rest.indexOf(':');
      if (sep <= 0) return;
      const cid = rest.slice(0, sep);
      const bid = rest.slice(sep + 1);
      if (!cid || !bid) return;
      let list = store.bubbleCells.get(cid);
      if (!list) store.bubbleCells.set(cid, (list = new Map()));
      list.set(bid, cell);
    });
    if (scan.aborted) {
      store.skipped = true;
      store.warning =
        'the store is past the keyflip read budget (stopped after ' +
        scan.rows.toLocaleString() +
        ' rows / ' +
        Math.round(scan.bytes / 1048576) +
        ' MB of leaf pages), so no chat was indexed from it';
    }
  } catch (e) {
    handle.close();
    throw e;
  }
  if (storeCache.size >= CACHE_MAX) {
    const oldest = storeCache.keys().next().value;
    const evicted = storeCache.get(oldest);
    storeCache.delete(oldest);
    if (evicted && evicted.handle) evicted.handle.close();
  }
  storeCache.set(file, store);
  return store;
}

// The composer's state document, decoded on demand and held for a few chats at most: the docs carry
// the editor's whole UI state, so caching them all would hold megabytes per chat in RAM.
function composerDoc(store, cid) {
  const hit = store.docs.get(cid);
  if (hit !== undefined) return hit;
  const cell = store.composerCells.get(cid);
  const doc = cell ? decodeJson(_sq.cellValue(store.handle, cell)) : null;
  if (store.docs.size >= 32) store.docs.delete(store.docs.keys().next().value);
  store.docs.set(cid, doc);
  return doc;
}

function bubbleDoc(store, cid, bid) {
  const list = store.bubbleCells.get(cid);
  const cell = list && list.get(bid);
  return cell ? decodeJson(_sq.cellValue(store.handle, cell)) : null;
}

// The turn order. `fullConversationHeadersOnly` is what the editor renders, so when it exists it
// decides both the order and which bubbles are part of the conversation at all. When the manifest
// is missing entirely (older or half-written composers), bubbles fall back to their rowid — the
// table's insertion order — which is what txcript does in the same case.
function conversationOrder(store, cid) {
  const doc = composerDoc(store, cid);
  const headers = Array.isArray(doc && doc.fullConversationHeadersOnly) ? doc.fullConversationHeadersOnly : [];
  const result = { items: [], hasManifest: headers.length > 0, hidden: 0, unlisted: 0, missing: 0 };
  const seen = new Set();
  headers.forEach(function (h) {
    const bid = h && typeof h === 'object' ? h.bubbleId : h;
    if (typeof bid !== 'string' || !bid || seen.has(bid)) return;
    seen.add(bid);
    // Cursor refuses to draw a header marked un-renderable; a header with no `grouping` is kept.
    if (h && h.grouping && h.grouping.isRenderable === false) {
      result.hidden++;
      return;
    }
    result.items.push({ bid: bid, type: h && typeof h === 'object' ? h.type : undefined, createdAt: h && h.createdAt });
  });
  if (!result.hasManifest) {
    const list = store.bubbleCells.get(cid);
    if (list) {
      Array.from(list.entries())
        .sort(function (a, b) {
          return a[1].rowid - b[1].rowid;
        })
        .forEach(function (entry) {
          if (seen.has(entry[0])) return;
          seen.add(entry[0]);
          result.items.push({ bid: entry[0], type: undefined, createdAt: null });
        });
    }
    return result;
  }
  const list = store.bubbleCells.get(cid) || new Map();
  list.forEach(function (cell, bid) {
    if (!seen.has(bid)) result.unlisted++; // an edited-away or regenerated turn: not this conversation
  });
  seen.forEach(function (bid) {
    if (!list.has(bid)) result.missing++; // the manifest lists a row the store no longer has
  });
  return result;
}

function roleOf(bubble, headerType) {
  const t = headerType != null ? headerType : bubble.type != null ? bubble.type : bubble.role;
  if (t === TYPE_ASSISTANT || t === '2' || t === 'assistant') return 'assistant';
  if (t === TYPE_USER || t === '1' || t === 'user' || t === 'human') return 'user';
  return 'assistant';
}

// Bubble text has appeared as a plain string, as `{text}` content blocks, and as a markdown field.
function textOf(bubble) {
  const raw = pick(bubble, ['text', 'content', 'markdown', 'message']);
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw)) {
    return raw
      .map(function (b) {
        if (typeof b === 'string') return b;
        return (b && (b.text || b.content)) || '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (raw && typeof raw === 'object') return textOf(raw);
  return '';
}

// Pre-`_v 3` composers keep a tool's payload out of the bubble, in
// `capabilities[].data.bubbleDataMap` — which is itself sometimes a JSON-encoded string.
function legacyToolMap(doc) {
  const caps = doc && Array.isArray(doc.capabilities) ? doc.capabilities : [];
  const map = new Map();
  caps.forEach(function (cap) {
    let bm = cap && cap.data && cap.data.bubbleDataMap;
    if (typeof bm === 'string') bm = decodeJson(bm);
    if (!bm || typeof bm !== 'object') return;
    Object.keys(bm).forEach(function (bid) {
      const v = bm[bid];
      if (v && typeof v === 'object') map.set(bid, v);
    });
  });
  return map;
}

function toolNameOf(tool) {
  const name = tool && (tool.name || (tool.toolFormerData && tool.toolFormerData.name));
  if (typeof name === 'string' && name) return name;
  const id = tool && (tool.tool != null ? tool.tool : tool.id);
  if (typeof id === 'number' && TOOL_NAMES[id]) return TOOL_NAMES[id];
  if (id != null) return 'cursor-tool-' + String(id);
  return 'tool';
}

// A bubble's timestamp: the RFC3339 `createdAt` the client writes, else the manifest's, else
// `timingInfo` (fractional milliseconds), else the composer's own clock.
function bubbleTs(bubble, item, docTs) {
  return (
    toIso(pick(bubble, ['createdAt', 'created', 'timestamp'])) ||
    toIso(item && item.createdAt) ||
    toIso(bubble && bubble.timingInfo && (bubble.timingInfo.start ?? bubble.timingInfo.startTime)) ||
    docTs
  );
}

// One composer → one conversation, in the fields keyflip's shape wants. Null when nothing readable
// was left after filtering: an empty draft composer is not a chat, and inventing one is worse.
function chatOf(store, cid, opts) {
  opts = opts || {};
  const doc = composerDoc(store, cid) || {};
  const head = store.heads.get(cid) || {};
  const order = conversationOrder(store, cid);
  const legacy = doc._v != null && doc._v < 3 ? legacyToolMap(doc) : null;
  const docUpdated = toIso(pick(doc, ['lastUpdatedAt', 'updatedAt', 'modifiedAt']) || head.lastUpdatedAt);
  const messages = [];
  order.items.forEach(function (item) {
    const bubble = bubbleDoc(store, cid, item.bid);
    if (!bubble) return; // a gap in the transcript, not an error: Cursor prunes rows across upgrades
    const cap = bubble.capabilityType;
    const tool = bubble.toolFormerData || (legacy && legacy.get(item.bid)) || null;
    const tools = [];
    let text = textOf(bubble);
    if (cap === CAP_THINKING) {
      // Reasoning is often signature-only on recent builds; an empty thinking bubble is no message.
      text = (bubble.thinking && bubble.thinking.text) || text;
    } else if (cap === CAP_TOOL || tool) {
      // A tool card whose payload did not survive still names a turn the agent took; dropping it
      // would silently shorten the transcript, so an unnameable one is labelled rather than guessed.
      tools.push(tool ? toolNameOf(tool) : 'tool');
    }
    // A tool call with no prose is still a turn the agent took, so it survives on its tool name.
    if (!text && !tools.length) return;
    messages.push({
      id: safeId(item.bid),
      role: roleOf(bubble, item.type),
      text: text,
      ts: bubbleTs(bubble, item, docUpdated),
      tools: tools,
    });
  });
  if (!messages.length) return null;
  const wsId = head.workspaceId || (doc.workspaceIdentifier && doc.workspaceIdentifier.id) || null;
  const title =
    pick(doc, ['name', 'title']) || (head.head && head.head.name) || (head.head && head.head.subtitle) || null;
  // Where the chat happened, in the order the reverse-engineered readers trust: the path the
  // composer embedded itself, then the agent-location and git-repo hints, then the workspace this
  // store belongs to. Remote URIs are reported as the location they name.
  const cwd =
    uriToPath(pick(doc, ['projectPath', 'workspaceDirectory'])) ||
    uriToPath(doc.workspaceIdentifier && doc.workspaceIdentifier.uri && doc.workspaceIdentifier.uri.fsPath) ||
    uriToPath(
      doc.agentLocation &&
        doc.agentLocation.environment &&
        doc.agentLocation.environment.uri &&
        doc.agentLocation.environment.uri.fsPath,
    ) ||
    (Array.isArray(doc.trackedGitRepos) && doc.trackedGitRepos[0] && doc.trackedGitRepos[0].repoPath) ||
    opts.storeCwd ||
    null;
  const subs = Array.isArray(pick(doc, ['subagentComposerIds', 'subsComposerIds']))
    ? pick(doc, ['subagentComposerIds', 'subsComposerIds'])
    : [];
  return {
    composerId: cid,
    id: safeId(cid),
    title: typeof title === 'string' ? title : null,
    cwd: cwd,
    workspaceId: wsId,
    isSubagent: head.isSubagent === 1 || head.isSubagent === true || doc.isSubagent === true,
    isArchived: head.isArchived === 1 || head.isArchived === true || doc.isArchived === true,
    forkOf:
      (doc.subagentInfo && doc.subagentInfo.parentComposerId) ||
      pick(doc, ['parentComposerId', 'forkedFromComposerId']) ||
      null,
    children: subs,
    messages: messages,
    hidden: order.hidden,
    unlisted: order.unlisted,
    missing: order.missing,
    createdAt: toIso(pick(doc, ['createdAt', 'created']) || head.createdAt) || messages[0].ts,
    updatedAt: docUpdated || messages[messages.length - 1].ts,
  };
}

// Every chat in every editor store on this machine, deduped by composer id (newest store first).
// `{ chats, stores, skipped, warnings }` is what an honest report needs: a tool with zero chats
// because its database is unreadable must not look like a tool with no history.
function chats(ctx) {
  const stores = storePaths(ctx);
  const chats = [];
  const claimed = new Set();
  const skipped = [];
  const warnings = [];
  stores.forEach(function (s) {
    let store;
    try {
      store = parseStore(s.file, ctx);
    } catch (e) {
      skipped.push({ file: s.file, reason: (e && e.message) || 'unreadable' });
      return;
    }
    if (store.skipped) {
      // Past the read budget the store yields no chat at all, so it is reported once, as a skip —
      // listing it as a warning too would double-count the same file in `conv index` output.
      skipped.push({ file: s.file, reason: store.warning });
      return;
    }
    if (store.warning) warnings.push({ file: s.file, reason: store.warning });
    const ids = new Set();
    store.heads.forEach(function (h, cid) {
      ids.add(cid);
    });
    store.composerCells.forEach(function (c, cid) {
      ids.add(cid);
    });
    store.bubbleCells.forEach(function (list, cid) {
      if (list.size) ids.add(cid);
    });
    ids.forEach(function (cid) {
      if (claimed.has(cid)) return;
      const chat = chatOf(store, cid, { storeCwd: s.cwd });
      if (!chat) return; // an empty draft is not a session
      claimed.add(cid);
      chat.source = { path: s.file, mtimeMs: s.mtimeMs, size: s.size };
      chat.kind = 'composer';
      chats.push(chat);
    });
  });
  return { chats: chats, stores: stores.length, skipped: skipped, warnings: warnings };
}

// ---- the cursor-agent CLI store --------------------------------------------------------------

// One `store.db` per session, under a workspace bucket named by the md5 of the absolute path. The
// hash is one-way, so the directory name is not read for the cwd: `meta`'s `workspacePath` is.
function agentStorePaths(ctx) {
  const out = [];
  const seen = new Set();
  agentRoots(ctx).forEach(function (root) {
    const chatsDir = path.join(root, 'chats');
    let buckets;
    try {
      buckets = fs.readdirSync(chatsDir, { withFileTypes: true });
    } catch {
      return;
    }
    buckets.forEach(function (bucket) {
      if (!bucket.isDirectory()) return;
      const dir = path.join(chatsDir, bucket.name);
      let sessions;
      try {
        sessions = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      sessions.forEach(function (s) {
        if (!s.isDirectory()) return;
        const file = path.join(dir, s.name, 'store.db');
        try {
          const st = fs.statSync(file);
          if (!st.isFile() || st.size === 0) return;
          const key = fs.realpathSync(file);
          if (seen.has(key)) return;
          seen.add(key);
          out.push({ file: file, dir: path.join(dir, s.name), sessionId: s.name, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          /* no store.db: the session directory is still being created */
        }
      });
    });
  });
  out.sort(function (a, b) {
    return b.mtimeMs - a.mtimeMs;
  });
  return out;
}

// Cursor frames each blob as protobuf and puts the message JSON inside it. Find the first balanced
// object and decode it; anything else in the row is the turn graph, which carries no text.
function extractJson(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  const s = buf.toString('latin1');
  let from = 0;
  for (let tries = 0; tries < 8; tries++) {
    const start = s.indexOf('{', from);
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const doc = decodeJson(buf.toString('utf8', start, i + 1));
          if (doc) return doc;
          break; // the braces balanced but it was not JSON: look for the next candidate
        }
      }
    }
    from = start + 1;
  }
  return null;
}

// Order the message blobs as the conversation happened.
//
// The shipped readers walk the protobuf reference graph instead (SpecStory's `topologicalSort`: pick
// the blob with the most outgoing references, DFS backwards, post-order, drop what it cannot reach).
// keyflip does not, for two reasons that come from that same code. (1) A single-root traversal is
// sound only if one root exists: a resumed session has several, and the reference scan also matches
// each blob's own content-addressed id, so a walk from one blob can miss whole turns — and losing a
// transcript silently is the one failure mode this adapter must not have. (2) Every message blob
// carries the `createdAt` the client wrote for that message, which is a direct clock on the conversation,
// while rowid insertion order is what txcript itself falls back to ("nothing in the records themselves
// orders them"). So: order by that clock when every blob has one, else by insertion order, and read
// every JSON blob.
//
// The cost of that choice, stated: a prompt the user edited away in the CLI stays in the transcript
// (in the EDITOR store the render manifest is authoritative and such turns are dropped). For a search
// index over one's own history, an extra superseded prompt is a smaller harm than a missing answer.
function blobOrder(blobs) {
  const timed = blobs.every(function (b) {
    return b.ts != null;
  });
  return blobs.slice().sort(function (a, b) {
    if (timed && a.ts !== b.ts) return a.ts - b.ts;
    return a.rowid - b.rowid;
  });
}

function agentTextAndTools(doc) {
  const content = doc.content;
  const parts = [];
  const tools = [];
  // Cursor is the one adapter that has nowhere else to put a tool's payload: the transcript holds
  // it inside the message. It is kept (export and exact-string search want it) but flagged, so the
  // conversation index can cap what one `cat` of a 2 MB file turns into. Reasoning is the agent's
  // scratchpad in the same way — it stays, it is just not what the user said.
  let machine = false;
  const push = function (t) {
    if (typeof t === 'string' && t.trim()) parts.push(t.trim());
  };
  if (typeof content === 'string') push(content);
  else if (Array.isArray(content)) {
    content.forEach(function (b) {
      if (!b || typeof b !== 'object') return;
      if (b.type === 'text' || typeof b.text === 'string') push(b.text);
      else if (b.type === 'tool-call' || b.type === 'tool_use') tools.push(b.toolName || b.name || 'tool');
      else if (b.type === 'reasoning' || b.type === 'thinking' || b.type === 'redacted-reasoning') push(b.text);
      // A tool result is what the machine saw. Its payload is a string, block array or structured
      // value depending on the tool, so anything not already text is kept as JSON: searchable, and
      // never presented as something a person wrote.
      else if (b.type === 'tool-result' || b.type === 'tool_result') {
        if (b.toolName || b.name) tools.push(b.toolName || b.name);
        const before = parts.length;
        const r = b.result != null ? b.result : b.output;
        if (typeof r === 'string') push(r);
        else if (Array.isArray(r))
          push(
            r
              .map(function (x) {
                return typeof x === 'string' ? x : (x && (x.text || x.content)) || '';
              })
              .filter(Boolean)
              .join('\n'),
          );
        else if (r && typeof r === 'object') push(JSON.stringify(r));
        if (parts.length > before) machine = true;
      }
    });
  }
  // The CLI injects the editor's context as a user turn; txcript drops it and so do we.
  let text = parts.join('\n');
  const head = text.trim();
  if (/^<user_info>/i.test(head) || /^<user_info>/i.test(head.replace(/^\s*(system|environment):/i, ''))) text = '';
  const m = /<user_query>([\s\S]*?)<\/user_query>/i.exec(text);
  if (m) text = m[1];
  return {
    text: String(text)
      .replace(/\[REDACTED\]/g, '')
      .trim(),
    tools: tools,
    machine: machine,
  };
}

// A blob's row key as text. In observed stores `blobs.id` is a 64-char lowercase hex digest (the
// SHA-256 of the row's own bytes), but a BLOB-affinity column would arrive as raw bytes and utf8
// conversion of those is lossy, so both shapes are normalised here rather than one trusted.
function blobId(cell) {
  const raw = cell.keyBuf;
  if (Buffer.isBuffer(raw)) return raw.toString('hex');
  const s = String(cell.key == null ? '' : cell.key);
  return /^[0-9a-fA-F]{64}$/.test(s) ? s.toLowerCase() : s;
}

function agentChats(ctx, opts) {
  opts = opts || {};
  const found = agentStorePaths(ctx);
  const chats = [];
  const skipped = [];
  const warnings = [];
  found.forEach(function (s) {
    let handle;
    try {
      handle = openStore(s.file);
    } catch (e) {
      skipped.push({ file: s.file, reason: (e && e.message) || 'unreadable' });
      return;
    }
    // Same rule as the editor store: a session whose -wal this reader could not replay may be
    // missing its newest turns, and that belongs in the report rather than in a short transcript.
    const wal = walWarning(handle);
    if (wal) warnings.push({ file: s.file, reason: wal });
    try {
      // `meta` key "0" is the agent record, hex-encoded in observed builds and plain JSON in others.
      let meta = null;
      try {
        const metaCells = _sq.scanCells(handle, 'meta', function (k) {
          return k === '0';
        });
        if (metaCells.cells.length) {
          const raw = String(_sq.cellValue(handle, metaCells.cells[0]) || '').trim();
          meta =
            /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0
              ? decodeJson(Buffer.from(raw, 'hex').toString('utf8'))
              : decodeJson(raw);
        }
      } catch {
        /* no meta table: the session still has blobs, just no title/cwd */
      }
      let sidecar = null;
      try {
        sidecar = JSON.parse(fs.readFileSync(path.join(s.dir, 'meta.json'), 'utf8'));
      } catch {
        /* optional */
      }
      const scan = _sq.scanCells(
        handle,
        'blobs',
        function () {
          return true;
        },
        {
          maxBytes: opts.maxScanBytes || MAX_SCAN_BYTES,
          maxRows: opts.maxScanRows || MAX_SCAN_ROWS,
        },
      );
      if (scan.aborted) {
        skipped.push({
          file: s.file,
          reason:
            'the session store is past the keyflip read budget (stopped after ' +
            scan.rows.toLocaleString() +
            ' blobs / ' +
            Math.round(scan.bytes / 1048576) +
            ' MB of leaf pages)',
        });
        return;
      }
      const blobs = scan.cells.map(function (cell) {
        const data = _sq.cellValue(handle, cell, 1, true);
        const doc = extractJson(data);
        return {
          id: blobId(cell),
          rowid: cell.rowid,
          doc: doc,
          // A numeric per-message clock, or nothing: `blobOrder` only trusts it when every message
          // blob has one, so a half-timestamped session stays in insertion order instead of mixing.
          ts: doc && typeof doc.createdAt === 'number' && isFinite(doc.createdAt) ? doc.createdAt : null,
        };
      });
      const withJson = blobs.filter(function (b) {
        return b.doc;
      });
      const ordered = blobOrder(withJson);
      const messages = [];
      ordered.forEach(function (b) {
        const doc = b.doc;
        const role = doc.role === 'user' ? 'user' : 'assistant'; // tool results are the machine's turn
        const body = agentTextAndTools(doc);
        if (!body.text && !body.tools.length) return;
        messages.push({
          id: safeId(doc.messageId || doc.id || b.id || String(b.rowid)),
          role: role,
          text: body.text,
          ts: toIso(doc.createdAt) || null,
          tools: body.tools,
          machine: body.machine || undefined,
        });
      });
      if (!messages.length) return; // an empty session directory is not a chat
      const title = (sidecar && sidecar.title) || (meta && meta.name) || null;
      const cwd = (meta && meta.workspacePath) || null;
      // Both bounds come from every clock the session records, not one preferred source: the meta
      // row is written when the session is created and so predates the first prompt, while a
      // resumed session's newest message can postdate the sidecar's `updatedAtMs`. Taking the first
      // of each pair mis-dates one end of the conversation. The file's mtime stays a last resort —
      // copying or restoring a store resets it to today, which would make old chats look new.
      let first = null;
      let last = null;
      const note = function (v) {
        if (typeof v !== 'number' || !isFinite(v)) return;
        if (first === null || v < first) first = v;
        if (last === null || v > last) last = v;
      };
      note(sidecar && sidecar.createdAtMs);
      note(sidecar && sidecar.updatedAtMs);
      note(meta && meta.createdAt);
      ordered.forEach(function (b) {
        note(b.ts);
      });
      chats.push({
        composerId: s.sessionId,
        id: safeId(s.sessionId),
        kind: 'agent',
        title: typeof title === 'string' ? title : null,
        cwd: cwd,
        forkOf: null,
        children: [],
        messages: messages,
        hidden: 0,
        // The CLI store has no render manifest, so nothing is left out of a transcript on purpose:
        // every message blob is read (see blobOrder for the trade-off that buys).
        unlisted: 0,
        missing: 0,
        createdAt: first === null ? null : new Date(first).toISOString(),
        updatedAt: last === null ? new Date(s.mtimeMs).toISOString() : new Date(last).toISOString(),
        source: { path: s.file, mtimeMs: s.mtimeMs, size: s.size },
      });
    } catch (e) {
      skipped.push({ file: s.file, reason: (e && e.message) || 'unreadable' });
    } finally {
      handle.close();
    }
  });
  return { chats: chats, stores: found.length, skipped: skipped, warnings: warnings };
}

// The transcript mirror Cursor exports per session under `projects/<enc>/agent-transcripts/<id>/`.
// It is the SAME conversation as the composer row, so indexing both would double-count every chat
// in the search index — which measurably hurts retrieval. It is used only for session ids the
// composer store does not have, which is how magpie decides the same thing.
function transcriptPaths(ctx, exceptIds) {
  const out = [];
  const skip = exceptIds || new Set();
  agentRoots(ctx).forEach(function (root) {
    const projects = path.join(root, 'projects');
    let encs;
    try {
      encs = fs.readdirSync(projects, { withFileTypes: true });
    } catch {
      return;
    }
    encs.forEach(function (enc) {
      if (!enc.isDirectory()) return;
      const at = path.join(projects, enc.name, 'agent-transcripts');
      if (!isDir(at)) return;
      let dirs;
      try {
        dirs = fs.readdirSync(at, { withFileTypes: true });
      } catch {
        return;
      }
      dirs.forEach(function (d) {
        // Only the top level: subagent transcripts live one deeper and are not separate user chats.
        const file = isDir(path.join(at, d.name)) ? path.join(at, d.name, d.name + '.jsonl') : path.join(at, d.name);
        if (!/\.jsonl$/i.test(file)) return;
        const id = path.basename(file).replace(/\.jsonl$/i, '');
        if (skip.has(id)) return;
        try {
          const st = fs.statSync(file);
          // A mirror past the read cap is not indexed rather than half-indexed: a truncated JSONL
          // read yields a chat with its answers missing and no way to tell that from a short one.
          if (st.isFile() && st.size > 0 && st.size <= MAX_TRANSCRIPT_BYTES)
            out.push({ file: file, sessionId: id, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          /* absent */
        }
      });
    });
  });
  out.sort(function (a, b) {
    return b.mtimeMs - a.mtimeMs;
  });
  return out;
}

// One transcript mirror → one chat. The attested line shape (magpie's `readCursorEditor`) is
// `{ role, message: { content: "text" | [{ type: "text", text }] } }`; `tool-call`/`tool_use` parts
// carry the tool name, and these files have NO per-line timestamps, which is why the activity dates
// below come from the file's mtime and never from the moment of the scan.
function transcriptChat(src) {
  let st;
  try {
    st = fs.statSync(src.path);
  } catch {
    throw new Error('transcript ' + src.path + ' is gone');
  }
  if (st.size > MAX_TRANSCRIPT_BYTES) throw new Error('transcript ' + src.path + ' is past the read cap');
  const stamp = new Date(st.mtimeMs).toISOString();
  const messages = [];
  fs.readFileSync(src.path, 'utf8')
    .split(/\r?\n/)
    .forEach(function (line, i) {
      const s = line.trim();
      if (!s || s[0] !== '{') return;
      let doc;
      try {
        doc = JSON.parse(s);
      } catch {
        return; // a torn trailing line is a truncated export, not a message
      }
      if (!doc || typeof doc !== 'object') return;
      const msg = doc.message && typeof doc.message === 'object' ? doc.message : doc;
      const role = doc.role || msg.role || doc.type;
      if (role !== 'user' && role !== 'assistant') return; // system/meta records are not turns
      const body = agentTextAndTools({ role: role, content: msg.content != null ? msg.content : msg.text });
      if (!body.text && !body.tools.length) return;
      messages.push({
        id: safeId(doc.id || msg.id || src.sessionId + '-' + i),
        role: role,
        text: body.text,
        ts: toIso(msg.createdAt || doc.createdAt || msg.timestamp) || null,
        tools: body.tools,
        machine: body.machine || undefined,
      });
    });
  if (!messages.length) throw new Error('transcript ' + src.path + ' has no readable messages');
  const first = messages[0].ts;
  return {
    composerId: src.composerId || path.basename(src.path).replace(/\.jsonl$/i, ''),
    id: safeId(src.sessionId || src.composerId || path.basename(src.path)),
    kind: 'transcript',
    title: null,
    cwd: null,
    forkOf: null,
    children: [],
    messages: messages,
    hidden: 0,
    unlisted: 0,
    missing: 0,
    createdAt: first || stamp,
    updatedAt: messages[messages.length - 1].ts || stamp,
    source: { path: src.path, mtimeMs: st.mtimeMs, size: st.size },
  };
}

// ---- the surface the conversation pipeline uses ----------------------------------------------

// Source rows for `conv`: one per chat, with an id stable across runs so a rebuilt index reuses the
// chat's chunks and vectors instead of re-embedding the same conversation under a new key.
function discover(ctx) {
  const ide = chats(ctx);
  const seenIds = new Set();
  ide.chats.forEach(function (c) {
    seenIds.add(c.composerId);
  });
  const rows = ide.chats.map(function (c) {
    return sourceRow(c);
  });
  let agent;
  try {
    agent = agentChats(ctx);
  } catch {
    agent = { chats: [], skipped: [] };
  }
  agent.chats.forEach(function (c) {
    if (seenIds.has(c.composerId)) return;
    seenIds.add(c.composerId);
    rows.push(sourceRow(c));
  });
  try {
    transcriptPaths(ctx, seenIds).forEach(function (t) {
      rows.push({
        path: t.file,
        mtimeMs: t.mtimeMs,
        size: t.size,
        composerId: t.sessionId,
        kind: 'cursor-transcript',
        app: 'cursor',
        surface: 'cli',
        title: null,
        cwd: null,
        updatedAt: new Date(t.mtimeMs).toISOString(),
      });
    });
  } catch {
    /* the mirror is optional; the composer store already has these chats */
  }
  rows.skipped = ide.skipped.concat(agent.skipped || []);
  rows.warnings = ide.warnings.concat(agent.warnings || []);
  return rows;
}

// The chat kinds keyflip's adapter produces, and the source-row `kind`/`surface` each maps to. The
// editor's composers are the desktop surface; the CLI agent and its transcript mirror are `cli`.
const KIND_OF = { composer: 'cursor-composer', agent: 'cursor-agent', transcript: 'cursor-transcript' };
const SURFACE_OF = { composer: 'local', agent: 'cli', transcript: 'cli' };

function sourceRow(c) {
  return {
    path: c.source.path,
    mtimeMs: c.source.mtimeMs,
    size: c.source.size,
    composerId: c.composerId,
    kind: KIND_OF[c.kind] || 'cursor-composer',
    app: 'cursor',
    surface: SURFACE_OF[c.kind] || 'local',
    title: c.title,
    cwd: c.cwd,
    updatedAt: c.updatedAt,
  };
}

// The one message list a source row stands for. Composer rows go through the (path, mtime) cache,
// so a build that touches one file a thousand times parses it once.
function loadChat(ctx, src) {
  if (src.kind === 'cursor-transcript' || (!src.kind && /\.jsonl$/i.test(src.path))) return transcriptChat(src);
  if (src.kind === 'cursor-agent' || /store\.db$/i.test(src.path)) {
    const found = agentChats(ctx).chats.filter(function (c) {
      return c.source.path === src.path;
    })[0];
    if (!found) throw new Error('no readable session in ' + src.path);
    return found;
  }
  const store = parseStore(src.path, ctx);
  if (store.skipped) throw new Error(store.warning);
  const s = storePaths(ctx).filter(function (x) {
    return x.file === src.path;
  })[0];
  const chat = chatOf(store, src.composerId, { storeCwd: s && s.cwd });
  if (!chat) throw new Error('composer ' + src.composerId + ' has no readable messages in ' + src.path);
  chat.source = { path: store.file, mtimeMs: store.mtimeMs, size: store.size };
  return chat;
}

export {
  KV_TABLE,
  HEADERS_TABLE,
  COMPOSER_PREFIX,
  BUBBLE_PREFIX,
  MAX_SCAN_BYTES,
  MAX_SCAN_ROWS,
  MAX_TRANSCRIPT_BYTES,
  TOOL_NAMES,
  safeId,
  toIso,
  pick,
  uriToPath,
  ideUserDirs,
  agentRoots,
  storePaths,
  parseStore,
  composerDoc,
  bubbleDoc,
  conversationOrder,
  legacyToolMap,
  roleOf,
  textOf,
  chatOf,
  chats,
  agentStorePaths,
  agentChats,
  extractJson,
  blobId,
  blobOrder,
  agentTextAndTools,
  transcriptPaths,
  transcriptChat,
  discover,
  sourceRow,
  loadChat,
  storeCache,
};
