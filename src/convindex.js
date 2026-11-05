// Cross-app conversation retrieval: a local, incremental index over every chat keyflip can
// read (src/conversations.js). Nothing is uploaded. Text is stored 0600 under
// <configDir>/conv-index/, which secretpaths registers as a SECRET_DIR, so it never enters
// keyflip's git repo, metadata backups or `migrate`.
//
// Design notes (best practice, zero runtime deps):
//   * One directory per conversation (`chunks/<key>.jsonl`) instead of one giant file: a
//     changed chat rewrites only its own slice, and a search streams sources it needs.
//   * Lexical ranking is BM25 (src/bm25.js) over ALL documents. A per-source token sidecar
//     (`tokens/<key>.t32`: per chunk len + [token hash, tf]) is written with the chunks, so a
//     query compares 32-bit hashes instead of re-tokenizing 150 MB of text; df/avgdl stay exact
//     because every chunk is scanned. The sidecar is derived data and can be rebuilt from chunks.
//   * Embeddings are OPT-IN (`--semantic`). Vectors are per-source Float32LE files, keyed by
//     an embedding-space hash (url+model). A changed conversation reuses the unchanged
//     prefix's vectors, so an append-only chat only embeds its new turns.
//   * A remote embedding endpoint is treated as untrusted: text is secret-scanned/redacted
//     before it leaves the machine. Localhost (the Ollama default) keeps full fidelity.
//   * `--hybrid` fuses lexical + vector rankings with Reciprocal Rank Fusion.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import childProcess from 'child_process';
import { fileURLToPath } from 'url';
import * as conversations from './conversations.js';
import * as _convaccounts from './convaccounts.js';
import * as _bm25 from './bm25.js';
import * as _embed from './embed.js';
import * as _secretscan from './secretscan.js';
import * as _fsutil from './fsutil.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCHEMA_VERSION = 1;
// Bump when the way a conversation id is derived changes. A row written by an older scheme
// is re-parsed once (so its id is re-derived) instead of being reused with the old id.
const ID_SCHEME = 2;
// Bump when the way text is cut into chunks changes. The reuse paths compare mtime/size, so
// without this an unchanged transcript would keep serving chunks cut by the old rules.
// 2: whole turns (question + its answer) instead of ~1400-char windows.
// Not bumped for the tool-output cap below: a tool payload only exists in a Cursor message, and
// the flag changes that conversation's hash, so those sources re-chunk on their own — bumping
// here would re-parse all 142 MB of this machine's transcripts to change nothing.
const CHUNK_SCHEME = 2;
const INDEX_DIR = 'conv-index';
const CHUNK_TARGET = 1400; // characters per chunk
// A tool result (Cursor keeps it inside the message) is searchable by its head; the tail of a
// `cat` of a large file is not what anyone is looking for, and it would eat the chunk budget.
const MACHINE_CAP = 800;
const CHUNK_OVERLAP = 180; // only for a single oversized message
const EMBED_BATCH = 32;
const EMBED_MAX_CHARS = 6000;
// Flush meta.json periodically while embedding so an interrupted or background pass makes
// every completed conversation immediately searchable instead of waiting for all 2k sources.
const EMBED_CHECKPOINT_SOURCES = 10;
const EMBED_CHECKPOINT_MS = 15000;
// A lock whose heartbeat (`updatedAt` / `startedAt`) has not advanced in 2 hours is treated as
// abandoned even if its PID was later reused by the OS for an unrelated process.
const EMBED_LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const META_LOCK_STALE_MS = 30 * 1000;
const META_LOCK_WAIT_MS = 5 * 1000;

// Rank fusion between the lexical (BM25) list and the semantic (vector) list.
//
// RRF's classic k=60 assumes an ensemble of *many* result lists. With only two lists of very
// different precision it flattens the rank so hard that "appears deep in both lists" outranks
// "rank 1 in one": 1/(60+21) twice beats 1/(60+1). Measured over 1856 live conversations the
// shipped k=60 gave hybrid search a hit@1 of 0.33 against BM25's 0.60 — the fusion was
// destroying the stronger retriever, and hybrid is the default mode of `conv search`.
//
// A small constant keeps the rank meaningful, and the semantic list carries less weight, so
// BM25 stays in front and the vector only promotes what it agrees with (and fills in when
// BM25 returns little). Measured on 109 verbatim and 38 paraphrased live queries, through the
// shipped search path: hybrid now ties BM25 on hit@1/hit@5 (0.596/0.798 verbatim, 0.447/0.763
// paraphrased) instead of trailing it (0.330/0.587 and 0.395/0.684). Every more aggressive
// weighting was measured too and lost: equal weights drop verbatim hit@1 to 0.486, and a
// vector-only ranking breaks 41 of the 109 queries BM25 got right.
const RRF_K = 2;
const RRF_WEIGHTS = [1, 0.25]; // list 0 = lexical, list 1 = semantic

function dirOf(ctx) {
  return path.join(ctx.configDir, INDEX_DIR);
}
function metaPath(ctx) {
  return path.join(dirOf(ctx), 'meta.json');
}
function metaLockPath(ctx) {
  return path.join(dirOf(ctx), 'meta.lock');
}
function embedLockPath(ctx) {
  return path.join(dirOf(ctx), 'embed.lock');
}
function chunksDir(ctx) {
  return path.join(dirOf(ctx), 'chunks');
}
function vectorsDir(ctx) {
  return path.join(dirOf(ctx), 'vectors');
}
function keyOf(id) {
  return crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 16);
}
function chunkPath(ctx, id) {
  return path.join(chunksDir(ctx), keyOf(id) + '.jsonl');
}
function vectorPath(ctx, id) {
  return path.join(vectorsDir(ctx), keyOf(id) + '.f32');
}
function tokensDir(ctx) {
  return path.join(dirOf(ctx), 'tokens');
}
function tokenPath(ctx, id) {
  return path.join(tokensDir(ctx), keyOf(id) + '.t32');
}
function hashText(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
}

function readMeta(ctx) {
  try {
    const m = JSON.parse(fs.readFileSync(metaPath(ctx), 'utf8'));
    if (m && m.schemaVersion === SCHEMA_VERSION && m.sources && typeof m.sources === 'object') return m;
  } catch {
    /* no index yet */
  }
  return null;
}

function makeLockToken() {
  return process.pid + '-' + Date.now() + '-' + crypto.randomBytes(6).toString('hex');
}

function reclaimLockFile(file, expectedRaw) {
  const claim = file + '.reclaim-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  try {
    fs.renameSync(file, claim);
  } catch {
    return false;
  }
  try {
    if (expectedRaw !== undefined) {
      let current = null;
      try {
        current = fs.readFileSync(claim, 'utf8');
      } catch {
        current = null;
      }
      if (current !== null && current !== expectedRaw) {
        // Another process replaced the lock just before our rename; restore it if no new file exists.
        try {
          fs.linkSync(claim, file);
        } catch {
          /* a newer lock is already in place */
        }
        return false;
      }
    }
    return true;
  } finally {
    try {
      fs.rmSync(claim, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

function withMetaLock(ctx, opts, fn) {
  if (typeof opts === 'function') {
    fn = opts;
    opts = {};
  }
  opts = opts || {};
  const waitMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs >= 0 ? opts.timeoutMs : META_LOCK_WAIT_MS;
  const deadline = Date.now() + waitMs;
  const file = metaLockPath(ctx);
  try {
    fs.mkdirSync(dirOf(ctx), { recursive: true });
  } catch {
    /* best-effort */
  }
  const token = makeLockToken();
  const startedMs = Date.now();
  function refreshMetaLock() {
    try {
      const now = Date.now();
      _fsutil.atomicWrite(
        file,
        JSON.stringify({ pid: process.pid, at: startedMs, updatedAt: now, token: token }) + '\n',
        0o600,
      );
    } catch {
      /* best-effort */
    }
  }
  let acquired = false;
  while (true) {
    let fd = null;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
      const now = Date.now();
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now, updatedAt: now, token: token }) + '\n', 'utf8');
      fs.closeSync(fd);
      fd = null;
      acquired = true;
      break;
    } catch (e) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      if (!e || e.code !== 'EEXIST') {
        if (Date.now() >= deadline) break;
        try {
          fs.mkdirSync(dirOf(ctx), { recursive: true });
        } catch {
          /* ignore */
        }
      } else {
        let rawText = null;
        let cur = null;
        try {
          rawText = fs.readFileSync(file, 'utf8');
          cur = JSON.parse(rawText);
        } catch {
          cur = null;
        }
        const dead = !cur || !cur.pid || !pidAlive(cur.pid);
        const beat = cur ? Number(cur.updatedAt || cur.at || 0) : 0;
        // Never steal a lock held by a live PID unless its heartbeat is hours old (PID reuse).
        const pidReusedOrAbandoned = cur && beat > 0 && Date.now() - beat > EMBED_LOCK_STALE_MS;
        if (dead || pidReusedOrAbandoned) {
          reclaimLockFile(file, rawText);
          continue;
        }
      }
      if (Date.now() >= deadline) break;
      const rem = Math.max(1, Math.min(20, deadline - Date.now()));
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, rem);
      } catch {
        /* ignore */
      }
    }
  }
  // Never run the critical section unlocked: if meta.lock could not be acquired within the
  // deadline, skip the write rather than risking a lockless overwrite of meta.json.
  if (!acquired) return { acquired: false, skipped: true };
  try {
    return { acquired: true, value: fn(refreshMetaLock) };
  } finally {
    let rawText = null;
    try {
      rawText = fs.readFileSync(file, 'utf8');
      const cur = JSON.parse(rawText);
      if (cur && cur.token === token) reclaimLockFile(file, rawText);
    } catch {
      /* ignore */
    }
  }
}

function countStats(sources) {
  const stats = { sources: 0, chunks: 0, messages: 0, bytes: 0, byApp: Object.create(null) };
  Object.keys(sources).forEach((id) => {
    const s = sources[id];
    stats.sources++;
    stats.chunks += s.chunks || 0;
    stats.messages += (s.counts && s.counts.messages) || 0;
    stats.bytes += s.bytes || 0;
    const app = s.app || 'other';
    const a = stats.byApp[app] || (stats.byApp[app] = { sources: 0, chunks: 0, messages: 0, bytes: 0 });
    a.sources++;
    a.chunks += s.chunks || 0;
    a.messages += (s.counts && s.counts.messages) || 0;
    a.bytes += s.bytes || 0;
  });
  return stats;
}

// Write `meta.json` under `meta.lock` and reconcile concurrent updates from disk:
//   * Never writes unlocked if `meta.lock` cannot be acquired within the wait window.
//   * Any source added on disk by a concurrent lexical build while an embedding worker was running
//     is preserved (unless this build explicitly removed it in `opts.removedIds`).
//   * Any source deleted by a concurrent full lexical build (present in `opts.baseline`, now absent
//     from `onDisk.sources` or missing its chunk file on disk) is dropped so a worker checkpoint
//     never resurrects a deleted conversation.
//   * Any source whose on-disk row is newer (`mtimeMs` greater, or different `hash`/`chunkBytes`
//     written by a concurrent lexical pass while this writer held an older snapshot) wins over the
//     stale in-memory row so a worker checkpoint never reverts newly re-parsed chunks.
//   * Any source whose hash/chunks match on disk and in memory preserves completed `vec` progress.
function writeMeta(ctx, meta, opts) {
  opts = opts || {};
  const removedIds = opts.removedIds instanceof Set ? opts.removedIds : null;
  const baseline = opts.baseline instanceof Map ? opts.baseline : null;
  const lockRes = withMetaLock(ctx, { timeoutMs: opts.metaLockTimeoutMs }, function (refreshMetaLock) {
    if (typeof opts.beforeMerge === 'function') opts.beforeMerge(refreshMetaLock);
    const onDisk = readMeta(ctx);
    if (onDisk && onDisk.sources && meta && meta.sources) {
      if (opts.checkpoint === true) {
        // Drop any source from the worker snapshot that a concurrent full lexical build removed.
        Object.keys(meta.sources).forEach((id) => {
          const inOnDisk = !!onDisk.sources[id];
          const wasInBaseline = baseline ? baseline.has(id) : true;
          if (!inOnDisk && (wasInBaseline || !fs.existsSync(chunkPath(ctx, id)))) {
            delete meta.sources[id];
          }
        });
      }
      Object.keys(onDisk.sources).forEach((id) => {
        const diskRow = onDisk.sources[id];
        if (!diskRow) return;
        const memRow = meta.sources[id];
        if (!memRow) {
          // A source absent from `meta.sources` was either explicitly removed during this scan
          // (its file is gone) or added by a concurrent lexical build after our scan started.
          if (removedIds && removedIds.has(id)) return;
          if (fs.existsSync(chunkPath(ctx, id))) {
            meta.sources[id] = diskRow;
          }
          return;
        }
        const diskNewerMtime =
          typeof diskRow.mtimeMs === 'number' && typeof memRow.mtimeMs === 'number' && diskRow.mtimeMs > memRow.mtimeMs;
        // If this write is an embedding checkpoint (`opts.checkpoint === true`) and a concurrent
        // lexical build rewrote the source on disk (different hash or chunkBytes), the on-disk
        // lexical state is authoritative — never overwrite it with the worker's start-time snapshot.
        const diskSig = String(diskRow.hash || '') + ':' + String(diskRow.chunkBytes || 0);
        const diskRewrittenDuringCheckpoint =
          opts.checkpoint === true &&
          diskRow.hash &&
          (baseline
            ? baseline.get(id) !== diskSig
            : !!memRow.hash && (diskRow.hash !== memRow.hash || diskRow.chunkBytes !== memRow.chunkBytes));
        if (diskNewerMtime || diskRewrittenDuringCheckpoint) {
          meta.sources[id] = diskRow;
          return;
        }
        if (
          !opts.force &&
          diskRow.vec &&
          diskRow.hash &&
          diskRow.hash === memRow.hash &&
          diskRow.chunks === memRow.chunks
        ) {
          if (
            !memRow.vec ||
            (meta.embedding && diskRow.vec.space === meta.embedding.space && memRow.vec.space !== meta.embedding.space)
          ) {
            memRow.vec = diskRow.vec;
          }
        }
      });
      if (!meta.embedding && onDisk.embedding) meta.embedding = onDisk.embedding;
      meta.stats = countStats(meta.sources);
    }
    const replacer = function (k, v) {
      if (k === '_oldVec' || k === '_oldHashes') return undefined;
      return v;
    };
    _fsutil.atomicWrite(metaPath(ctx), JSON.stringify(meta, replacer, 2) + '\n', 0o600);
  });
  return lockRes.acquired;
}

function emptyMeta() {
  return {
    schemaVersion: SCHEMA_VERSION,
    builtAt: null,
    embedding: null,
    stats: { sources: 0, chunks: 0, messages: 0, bytes: 0 },
    sources: Object.create(null),
  };
}

// ---- background embedding lock & worker ----------------------------------------------------

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

function embedLockExpired(raw, staleMs) {
  if (!raw || typeof raw !== 'object') return true;
  const maxAge = staleMs > 0 ? staleMs : EMBED_LOCK_STALE_MS;
  const beat = typeof raw.updatedAt === 'number' ? raw.updatedAt : raw.startedAt ? Date.parse(raw.startedAt) : 0;
  if (beat > 0 && Date.now() - beat > maxAge) return true;
  return false;
}

function embedLockHolderAlive(raw, opts) {
  if (!raw || !pidAlive(raw.pid) || embedLockExpired(raw)) return false;
  const pid = Number(raw.pid);
  // PID 1 is init/launchd/systemd and can never be a detached keyflip worker.
  if (pid <= 1) return false;
  if (pid === process.pid || pid === process.ppid) return true;
  if (opts && opts.checkProcess === true && process.platform !== 'win32') {
    try {
      const ps = childProcess.spawnSync('ps', ['-p', String(pid), '-o', 'comm='], {
        encoding: 'utf8',
        timeout: 500,
      });
      if (ps && ps.status === 0 && ps.stdout) {
        const comm = path.basename(ps.stdout.trim()).toLowerCase();
        const selfComm = path.basename(process.execPath || 'node').toLowerCase();
        if (comm && comm !== selfComm && !comm.includes('node')) {
          return false;
        }
      }
    } catch {
      /* fall through to pidAlive + heartbeat check */
    }
  }
  return true;
}

// Purely read-only inspection of `embed.lock`: never creates directories/lock files, never
// deletes stale locks on disk, and never spawns a child process. Cleanup belongs to writers.
function backgroundStatus(ctx) {
  const file = embedLockPath(ctx);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { running: false };
  }
  if (!embedLockHolderAlive(raw, { checkProcess: false })) {
    return { running: false, stale: true };
  }
  return {
    running: true,
    pid: raw.pid,
    startedAt: raw.startedAt || null,
    model: raw.model || null,
    space: raw.space || null,
    done: raw.done || 0,
    total: raw.total || 0,
  };
}

function writeEmbedLock(ctx, info) {
  try {
    const payload = Object.assign({ updatedAt: Date.now() }, info);
    _fsutil.atomicWrite(embedLockPath(ctx), JSON.stringify(payload) + '\n', 0o600);
  } catch {
    /* best-effort */
  }
}

// Atomically claim `embed.lock` via O_CREAT|O_EXCL (`wx`) so two concurrent foreground or
// background embedders never duplicate work or overwrite each other's lock. Stale locks (dead
// PID or heartbeat older than EMBED_LOCK_STALE_MS after PID reuse) are reclaimed via atomic
// rename + content verification, and any `ps` identity check happens outside `meta.lock`.
function acquireEmbedLock(ctx, info) {
  const file = embedLockPath(ctx);
  try {
    fs.mkdirSync(dirOf(ctx), { recursive: true });
  } catch {
    /* best-effort */
  }
  const token = (info && info.token) || makeLockToken();
  const payload = Object.assign({ updatedAt: Date.now() }, info, { token: token });
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd = null;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(payload) + '\n', 'utf8');
      } finally {
        fs.closeSync(fd);
        fd = null;
      }
      return { acquired: true, token: token };
    } catch (e) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      if (!e || e.code !== 'EEXIST') return { acquired: false, error: e };
      let rawText = null;
      let cur = null;
      try {
        rawText = fs.readFileSync(file, 'utf8');
        cur = JSON.parse(rawText);
      } catch {
        cur = null;
      }
      if (cur && cur.pid === process.pid) {
        const keepToken = cur.token || token;
        writeEmbedLock(ctx, Object.assign({}, payload, { token: keepToken }));
        return { acquired: true, token: keepToken };
      }
      // Check process liveness + identity OUTSIDE meta.lock so we never hold meta.lock during spawnSync.
      if (embedLockHolderAlive(cur, { checkProcess: true })) {
        return { acquired: false, holder: cur };
      }
      const reclaimed = withMetaLock(ctx, function () {
        return reclaimLockFile(file, rawText);
      });
      if (!reclaimed.acquired || !reclaimed.value) {
        return { acquired: false, holder: cur };
      }
    }
  }
  return { acquired: false };
}

function releaseEmbedLock(ctx, expectedToken) {
  const file = embedLockPath(ctx);
  try {
    const rawText = fs.readFileSync(file, 'utf8');
    const cur = JSON.parse(rawText);
    if (!cur) return;
    if (expectedToken ? cur.token === expectedToken || cur.pid === process.pid : cur.pid === process.pid) {
      reclaimLockFile(file, rawText);
    }
  } catch {
    /* best-effort */
  }
}

// Spawn a detached `keyflip conv index --embed --foreground` worker when explicitly requested
// (`keyflip conv index --embed --background`). Never spawns inside node:test unless an explicit
// injectable `opts.spawn` stub is supplied.
function spawnBackgroundEmbed(ctx, opts) {
  opts = opts || {};
  const spawnFn = typeof opts.spawn === 'function' ? opts.spawn : null;
  if (
    !spawnFn &&
    (opts.post || process.env.NODE_TEST_CONTEXT || (ctx && ctx.env && ctx.env.KEYFLIP_NO_BG_EMBED === '1'))
  ) {
    return { started: false, reason: 'disabled-in-test' };
  }
  const space = spaceOf(opts, ctx);
  const startedAt = (ctx && ctx.now && ctx.now()) || new Date().toISOString();
  // Atomically reserve embed.lock BEFORE spawning so two concurrent callers cannot both start a worker.
  const lockRes = acquireEmbedLock(ctx, {
    pid: process.pid,
    startedAt: startedAt,
    model: space.model,
    space: space.hash,
    done: 0,
    total: 0,
  });
  if (!lockRes.acquired) {
    const holder = lockRes.holder || {};
    return { started: false, alreadyRunning: true, pid: holder.pid || null, model: holder.model || null };
  }
  const binPath = path.resolve(__dirname, '..', 'bin', 'keyflip.js');
  const args = [binPath, 'conv', 'index', '--embed', '--foreground'];
  if (opts.apps && opts.apps.length) args.push('--app', opts.apps.join(','));
  if (opts.limitSources) args.push('--limit-sources', String(opts.limitSources));
  if (opts.force) args.push('--force');
  const env = Object.assign({}, process.env, (ctx && ctx.env) || {});
  if (ctx && ctx.configDir) {
    env.KEYFLIP_CONFIG_DIR = ctx.configDir;
    env.KEYFLIP_DIR = ctx.configDir;
  }
  if (opts.model) env.KEYFLIP_EMBED_MODEL = opts.model;
  if (opts.url) env.KEYFLIP_EMBED_URL = opts.url;
  try {
    const child = (spawnFn || childProcess.spawn)(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      env: env,
    });
    if (child && typeof child.unref === 'function') child.unref();
    writeEmbedLock(ctx, {
      pid: child.pid,
      token: lockRes.token,
      startedAt: startedAt,
      model: space.model,
      space: space.hash,
      done: 0,
      total: 0,
    });
    return { started: true, pid: child.pid, model: space.model, space: space.hash };
  } catch (e) {
    releaseEmbedLock(ctx, lockRes.token);
    return { started: false, reason: (e && e.message) || String(e) };
  }
}

// ---- chunking ------------------------------------------------------------------------------

function splitLong(text) {
  const out = [];
  const step = CHUNK_TARGET - CHUNK_OVERLAP;
  for (let i = 0; i < text.length; i += step) {
    out.push(text.slice(i, i + CHUNK_TARGET));
    if (i + CHUNK_TARGET >= text.length) break;
  }
  return out;
}

// A chunk should be a question and the answer it got, not a 1400-character window that can
// start in the middle of an answer. The window packer used to place "Assistant: …" alone in a
// chunk whenever the user's question filled the previous one: on the live index 15,392 of
// 122,611 chunks (12.6%) began with an answer whose question was nowhere in the chunk, so a
// cosine/BM25 match had no question terms to lean on and the retrieved text lost its context.
//
// v2 groups messages into TURNS (a user message plus everything said before the next user
// message) and only ever breaks BETWEEN turns. A turn that is itself too long is split with
// overlap, and every continuation keeps a short copy of its question so the middle of a long
// answer is still findable by what was asked.
// What a message contributes to the index. A tool's output (marked `machine` by the one adapter
// that keeps it in the message text) is kept — an error string or a path is exactly what someone
// searches for — but only its head, labelled, so one `cat` cannot fill several chunks with bytes
// nobody meant to search. The full text stays in the transcript and every export.
function chunkBody(m) {
  const body = String(m.text || '').trim();
  if (!body || m.machine !== true) return body;
  const head = body.length > MACHINE_CAP ? body.slice(0, MACHINE_CAP).trimEnd() + ' …' : body;
  return 'Tool output: ' + head;
}

function chunkConversation(conv) {
  const labelOf = (role) => (role === 'assistant' ? 'Assistant: ' : role === 'user' ? 'User: ' : '');
  const turns = [];
  let cur = null;
  for (const m of conv.messages || []) {
    const body = chunkBody(m);
    if (!body) continue;
    const text = labelOf(m.role) + body;
    // A user message always starts a turn; so does any message with no turn open (a transcript
    // can begin with an assistant message, and tool/system lines sometimes lead).
    if (!cur || m.role === 'user') {
      cur = { role: m.role, ts: m.ts || null, head: text, parts: [text] };
      turns.push(cur);
    } else {
      cur.parts.push(text);
    }
  }
  const out = [];
  let buf = null;
  const flush = () => {
    if (!buf) return;
    out.push(buf);
    buf = null;
  };
  for (const t of turns) {
    const text = t.parts.join('\n\n');
    // A turn up to 1.5x the target stays whole even when it is bigger than a window: the
    // question and its answer belong together.
    if (text.length <= CHUNK_TARGET * 1.5) {
      if (buf && buf.text.length + 2 + text.length > CHUNK_TARGET) flush();
      if (!buf) buf = { role: t.role, ts: t.ts, text: text };
      else buf.text += '\n\n' + text;
      continue;
    }
    flush();
    const head = t.head.length > 220 ? t.head.slice(0, 220).trimEnd() + ' …' : t.head;
    splitLong(text).forEach((part, i) => {
      out.push({ role: t.role, ts: t.ts, text: i === 0 ? part : head + '\n\n' + part });
    });
  }
  flush();
  return out.map((c, i) => ({
    n: i,
    role: c.role,
    ts: c.ts,
    h: hashText(c.text),
    len: _bm25.tokenize(c.text).length,
    text: c.text,
  }));
}

function readChunks(file) {
  const out = [];
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  raw.split('\n').forEach((line) => {
    if (!line.trim()) return;
    try {
      const c = JSON.parse(line);
      if (c && typeof c.text === 'string') out.push(c);
    } catch {
      /* torn line (interrupted write) — the next build replaces it */
    }
  });
  return out;
}

function writeChunks(ctx, id, chunks) {
  const body = chunks.map((c) => JSON.stringify(c)).join('\n') + '\n';
  _fsutil.atomicWrite(chunkPath(ctx, id), body, 0o600);
  return Buffer.byteLength(body);
}

// The chunk file must be the one this entry describes. Another source can write to the same
// path when two transcripts claim one id, so the byte size is fingerprinted: a file with a
// different size is not ours, and the entry must be re-chunked instead of reused.
function chunkBytesOk(ctx, entry) {
  if (!entry || !entry.chunkBytes) return false;
  try {
    return fs.statSync(chunkPath(ctx, entry.id)).size === entry.chunkBytes;
  } catch {
    return false;
  }
}

// ---- lexical sidecar -----------------------------------------------------------------------
//
// BM25 used to re-tokenize every chunk that matched a raw prefilter, per query: ~4 s on a
// 120k-chunk index. Tokens are already computed when a chunk is built, so store them next to
// the chunks: per chunk `uint32 len, uint16 uniqueTokens, [uint32 tokenHash, uint16 tf]*`.
// A query then compares 32-bit hashes instead of running the tokenizer over transcript text,
// and reads the text only for the handful of hits it returns. Exact same tokenizer (bm25.js),
// so rankings do not change; a 32-bit collision can only add a small tf to a chunk.
function tokenHash(t) {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function tokensForChunk(text) {
  const toks = _bm25.tokenize(text);
  const tf = new Map();
  for (const t of toks) {
    const h = tokenHash(t);
    tf.set(h, (tf.get(h) || 0) + 1);
  }
  return { len: toks.length, tf: tf };
}

function encodeTokensBuffer(chunks) {
  const parts = [];
  for (const c of chunks) {
    const { len, tf } = tokensForChunk(c.text);
    const buf = Buffer.alloc(6 + tf.size * 6);
    buf.writeUInt32LE(Math.min(len, 0xffffffff), 0);
    buf.writeUInt16LE(Math.min(tf.size, 0xffff), 4);
    let off = 6;
    for (const [h, n] of tf) {
      buf.writeUInt32LE(h, off);
      buf.writeUInt16LE(Math.min(n, 0xffff), off + 4);
      off += 6;
    }
    parts.push(buf);
  }
  return Buffer.concat(parts);
}

function writeTokens(ctx, id, chunks) {
  _fsutil.atomicWrite(tokenPath(ctx, id), encodeTokensBuffer(chunks), 0o600);
}

function dropTokens(ctx, id) {
  try {
    fs.rmSync(tokenPath(ctx, id), { force: true });
  } catch {
    /* best-effort */
  }
}

// First build after an upgrade (or a lost sidecar): derive tokens from the chunk file, no
// transcript parse needed.
function ensureTokens(ctx, id) {
  if (fs.existsSync(tokenPath(ctx, id))) return;
  const chunks = readChunks(chunkPath(ctx, id));
  if (chunks.length) writeTokens(ctx, id, chunks);
}

// ---- embedding space & safety --------------------------------------------------------------

function isLoopback(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
  } catch {
    return false;
  }
}

function spaceOf(opts, ctx) {
  const env = (ctx && ctx.env) || process.env || {};
  const url = (opts && opts.url) || env.KEYFLIP_EMBED_URL || _embed.defaultUrl();
  const model = (opts && opts.model) || env.KEYFLIP_EMBED_MODEL || _embed.defaultModel();
  return {
    hash: crypto
      .createHash('sha1')
      .update(url + '\0' + model)
      .digest('hex')
      .slice(0, 16),
    urlHash: crypto.createHash('sha1').update(url).digest('hex').slice(0, 12),
    host: (function () {
      try {
        return new URL(url).host;
      } catch {
        return 'invalid';
      }
    })(),
    model: model,
    remote: !isLoopback(url),
  };
}

function safeForEmbedding(text, space) {
  // Remote endpoints get redacted text; a local Ollama keeps full fidelity.
  return space.remote ? _secretscan.redactLines(String(text || '')).text : String(text || '');
}

function readVectorFile(file, dim, count) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (!dim || buf.length !== dim * count * 4) return null;
  return buf;
}

// Cheap (stat-only) check that a recorded vector really is on disk at the expected size.
function vectorFileOk(ctx, id, vec) {
  if (!vec || !vec.dim || !vec.count) return false;
  try {
    return fs.statSync(vectorPath(ctx, id)).size === vec.dim * vec.count * 4;
  } catch {
    return false;
  }
}

async function embedSource(ctx, id, chunks, prev, space, opts) {
  // A source with no chunks on disk has nothing to embed. Never record it as vectorized:
  // doing so used to leave a 0-byte vector file and a meta row claiming "embedded", which
  // hid the real problem (missing/torn chunk file) behind a healthy-looking count.
  if (!chunks.length) return null;
  const file = vectorPath(ctx, id);
  let prefix = 0;
  let prefixBuf = null;
  let dim = (prev && prev.vec && prev.vec.dim) || 0;
  const canReuse = prev && prev.vec && prev.vec.space === space.hash && prev.vec.dim && Array.isArray(prev.chunkHashes);
  if (canReuse) {
    const oldHashes = prev.chunkHashes;
    while (prefix < oldHashes.length && prefix < chunks.length && oldHashes[prefix] === chunks[prefix].h) prefix++;
    const old = prefix ? readVectorFile(file, prev.vec.dim, oldHashes.length) : null;
    if (old) {
      prefixBuf = old.subarray(0, prefix * prev.vec.dim * 4);
      dim = prev.vec.dim;
    } else {
      prefix = 0;
    }
  } else {
    // Switching models (e.g. nomic-embed-text 768d -> bge-m3 1024d) starts a new vector space:
    // never seed `dim` from the previous model's vector metadata.
    dim = 0;
  }
  const need = chunks.slice(prefix);
  if (!need.length && prefix) {
    return {
      space: space.hash,
      dim: dim,
      count: chunks.length,
      model: space.model,
      host: space.host,
      remote: space.remote,
    };
  }
  const fresh = [];
  for (let i = 0; i < need.length; i += EMBED_BATCH) {
    const batch = need.slice(i, i + EMBED_BATCH).map((c) => safeForEmbedding(c.text, space).slice(0, EMBED_MAX_CHARS));
    // A flaky local endpoint (busy model, restarted Ollama) must cost a retry, not the whole
    // run: embedSource throws only after 3 tries, and the caller skips just this source.
    let got = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        got = await _embed.embed(batch, opts);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    if (lastErr) throw lastErr;
    if (!Array.isArray(got) || got.length !== batch.length)
      throw new Error(
        'embedding endpoint returned ' + (got ? got.length : 0) + ' vectors for ' + batch.length + ' inputs',
      );
    got.forEach((v) => {
      if (!Array.isArray(v) || !v.length) throw new Error('embedding endpoint returned an empty vector');
      if (!dim) dim = v.length;
      else if (v.length !== dim)
        throw new Error('embedding dimension changed mid-build (' + v.length + ' vs ' + dim + ')');
      fresh.push(v);
    });
    if (opts && opts.onProgress)
      opts.onProgress({
        phase: 'embed-chunks',
        done: prefix + Math.min(i + EMBED_BATCH, need.length),
        total: chunks.length,
      });
  }
  if (!dim || prefix + fresh.length !== chunks.length) return null;
  const freshBuf = Buffer.alloc(fresh.length * dim * 4);
  let off = 0;
  for (const v of fresh) {
    for (let j = 0; j < dim; j++) {
      freshBuf.writeFloatLE(Number(v[j]) || 0, off);
      off += 4;
    }
  }
  _fsutil.atomicWrite(file, prefixBuf ? Buffer.concat([prefixBuf, freshBuf]) : freshBuf, 0o600);
  return {
    space: space.hash,
    dim: dim,
    count: chunks.length,
    model: space.model,
    host: space.host,
    remote: space.remote,
  };
}

// ---- build ---------------------------------------------------------------------------------

// Parse every source, compare mtime/size (+ content hash after parse), write changed chunk
// files, and optionally embed them. Returns a report; never mutates a tool's own store.
async function build(ctx, opts) {
  opts = opts || {};
  const dsOpts = { apps: opts.apps, foreign: opts.foreign, limitSources: opts.limitSources };
  const sources = conversations.discover(ctx, dsOpts);
  const meta = readMeta(ctx) || emptyMeta();
  // A source is looked up by its PATH, not by a computed id: the id is assigned by the
  // parser (Codex may take it from session_meta rather than the filename), so guessing it
  // here would miss and re-parse every file on every run.
  const byPath = Object.create(null);
  Object.keys(meta.sources).forEach((id) => {
    const s = meta.sources[id];
    if (s && s.path) byPath[s.path] = s;
  });
  const next = Object.create(null);
  const removedIds = new Set();
  const discoveredPaths = new Set();
  for (const s of sources) {
    if (s && s.path) discoveredPaths.add(s.path);
  }
  const pendingWrites = [];
  const pendingDeletes = [];
  const pendingBlankIds = [];
  const pendingEnsureTokens = [];
  const report = {
    ok: true,
    candidateSources: sources.length,
    indexed: 0,
    reused: 0,
    changed: 0,
    removed: 0,
    skipped: 0,
    empty: 0,
    rechunk: 0,
    duplicates: 0,
    duplicateIds: [],
    errors: [],
    warnings: [],
    embedded: 0,
    embedding: null,
  };
  // A store an adapter refused outright contributes no sources at all, so it can never reach the
  // per-source `catch` below. Fold its reason in here: a database past the read budget counts as a
  // skipped source, while a store that still yielded chats from an unreadable -wal is a warning —
  // an unreadable history and an empty one must not print the same line.
  (sources.storeIssues || []).forEach((issue) => {
    report.skipped++;
    report.errors.push(issue);
  });
  (sources.storeWarnings || []).forEach((w) => report.warnings.push(w));
  // One id, one conversation. If two DIFFERENT transcripts resolve to the same id, the second
  // one would overwrite the first one's chunk file while the manifest keeps a single row — the
  // counts then disagree with the disk. The newcomer gets a stable, path-derived id instead and
  // the collision is reported, never swallowed.
  const claimed = new Map(); // id -> path that owns it in this build
  const counted = new Set(); // "id|path" pairs already reported
  function claimId(id, srcPath) {
    const owner = claimed.get(id);
    if (owner && owner !== srcPath) {
      const alt = id + '-' + crypto.createHash('sha1').update(String(srcPath)).digest('hex').slice(0, 8);
      claimed.set(alt, srcPath);
      const key = id + '|' + srcPath;
      if (!counted.has(key)) {
        counted.add(key);
        report.duplicates++;
        if (report.duplicateIds.length < 5) {
          report.duplicateIds.push({ id: id, path: srcPath, keptFor: owner, as: alt });
        }
      }
      return alt;
    }
    claimed.set(id, srcPath);
    return id;
  }
  const wantEmbed = !!(opts.embed || opts.semantic);
  const space = wantEmbed ? spaceOf(opts, ctx) : null;
  if (wantEmbed && opts.background) {
    // Write lexical chunks synchronously first, then kick off a detached background worker to
    // generate or migrate embeddings incrementally without blocking the terminal.
    const lexReport = await build(ctx, Object.assign({}, opts, { embed: false, semantic: false, background: false }));
    const bg = spawnBackgroundEmbed(ctx, opts);
    lexReport.backgroundEmbed = bg;
    return lexReport;
  }
  // WHICH ACCOUNT worked on each conversation. The switch timelines and the account lists are
  // read ONCE for the whole pass: placing a row on a timeline is cheap, but re-reading the
  // action log ~1900 times would not be. A reused row is re-attributed too — the transcript
  // did not change, but the account that was live when it was written may have been learned
  // since the last pass.
  const accounts = _convaccounts.attributor(ctx);
  let done = 0;
  for (const src of sources) {
    done++;
    if (opts.onProgress) opts.onProgress({ phase: 'scan', done: done, total: sources.length, id: src.path });
    const prev = byPath[src.path];
    try {
      // Fast path BEFORE parsing: an unchanged file keeps its id and hash by definition, so a
      // no-op build is a stat() per source instead of re-reading every transcript. A row from
      // an older id scheme is re-parsed once, so the id is re-derived under the current one.
      if (
        !opts.force &&
        prev &&
        prev.id &&
        prev.hash &&
        prev.scheme === ID_SCHEME &&
        prev.chunkScheme === CHUNK_SCHEME &&
        prev.mtimeMs === src.mtimeMs &&
        prev.size === src.size &&
        chunkBytesOk(ctx, prev)
      ) {
        const id = claimId(prev.id, src.path);
        if (id === prev.id) {
          next[prev.id] = Object.assign({}, prev, accounts.fields(prev));
          report.reused++;
          pendingEnsureTokens.push(prev.id);
          continue;
        }
        // A collision: reusing the row would point two paths at ONE chunk file. Fall through
        // to the full parse so this source gets its own chunk file under the new id.
      }
      const conv = conversations.load(ctx, src, opts);
      if (Array.isArray(conv.warnings) && conv.warnings.length) {
        conv.warnings.forEach((w) => report.warnings.push(w));
      }
      const bytes = conv.messages.reduce((n, m) => n + Buffer.byteLength(m.text || ''), 0);
      if (!conv.messages.length) {
        report.empty++;
        if (prev && prev.id && !claimed.has(prev.id) && !next[prev.id]) {
          removedIds.add(prev.id);
          pendingDeletes.push(prev.id);
          report.removed++;
        }
        continue;
      }
      const id = claimId(conv.id, src.path);
      const had = meta.sources[id] || prev;
      // Reuse is only safe when the entry really belongs to THIS id and its chunk file is
      // still on disk. Checking the id matters: entries are looked up by path, and before the
      // Codex id fix several rollouts shared one id, so reusing `had` blind could copy a
      // neighbour's chunk count onto a source whose own chunk file was never written.
      // An entry with hash null asked to be re-chunked (see the embed loop's disk check).
      // The chunk file must also still be the one this entry describes: two transcripts that
      // claimed one id could have overwritten it, and a reused count would then describe a
      // conversation that is not on disk.
      const sameEntry =
        !!had &&
        had.id === id &&
        had.hash &&
        had.chunkScheme === CHUNK_SCHEME &&
        fs.existsSync(chunkPath(ctx, id)) &&
        chunkBytesOk(ctx, had);
      if (!opts.force && sameEntry && had.mtimeMs === src.mtimeMs && had.size === src.size) {
        // Re-attributed even though the row is reused: the account that was live when it was
        // written may have been learned (or deleted) since the last pass.
        next[id] = Object.assign({}, had, accounts.fields(conv));
        report.reused++;
        pendingEnsureTokens.push(id);
        continue;
      }
      if (!opts.force && sameEntry && had.hash === conv.hash) {
        next[id] = Object.assign(
          {},
          had,
          {
            scheme: ID_SCHEME,
            mtimeMs: src.mtimeMs,
            size: src.size,
            path: src.path,
            updatedAt: conv.updatedAt,
            title: conv.title,
            cwd: conv.cwd,
          },
          accounts.fields(conv),
        );
        report.reused++;
        pendingEnsureTokens.push(id);
        continue;
      }
      const chunks = chunkConversation(conv);
      if (!chunks.length) {
        report.empty++;
        continue;
      }
      // Old hashes/vectors may only seed prefix reuse when they belong to this same id —
      // a path that changed id (or an entry copied from a colliding id) must start clean.
      const sameOwner = !!had && had.id === id;
      const oldHashes = sameOwner ? had.chunkHashes || readChunks(chunkPath(ctx, id)).map((c) => c.h) : [];
      const entry = {
        id: id,
        scheme: ID_SCHEME,
        chunkScheme: CHUNK_SCHEME,
        app: conv.app,
        surface: conv.surface,
        title: conv.title,
        cwd: conv.cwd,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        counts: conv.counts,
        path: src.path,
        mtimeMs: src.mtimeMs,
        size: src.size,
        hash: conv.hash,
        // The account the SOURCE names, kept apart from the resolved `account` below: the
        // resolved value is this pass's answer and changes, the source's own fact does not.
        parserAccount: conv.account || null,
        chunks: chunks.length,
        bytes: bytes,
        chunkHashes: chunks.map((c) => c.h),
        // Changed text invalidates the vector alignment. Keep the OLD vector/hash pair only
        // so an appended chat can reuse its unchanged prefix instead of embedding 8k chunks again.
        vec: null,
        _oldVec: sameOwner && space && had.vec && had.vec.space === space.hash ? had.vec : null,
        _oldHashes: sameOwner && space && had.vec && had.vec.space === space.hash ? oldHashes : null,
      };
      // Which account worked on it — stated if the user said so, inferred from the switch
      // timeline otherwise (and labelled as an inference).
      Object.assign(entry, accounts.fields(conv));
      pendingWrites.push({ id: id, chunks: chunks, entry: entry });
      next[id] = entry;
      report.changed++;
      report.indexed++;
    } catch (e) {
      report.skipped++;
      report.errors.push({ path: src.path, app: src.app, error: (e && e.message) || String(e) });
    }
  }

  // An empty source scanned earlier in this pass may have queued its previous id in
  // `pendingDeletes` before a colliding transcript later in the same scan claimed that id.
  // Reconcile `pendingDeletes` and `removedIds` against `next`/`claimed` before committing.
  for (let i = pendingDeletes.length - 1; i >= 0; i--) {
    const id = pendingDeletes[i];
    if (next[id] || claimed.has(id)) {
      pendingDeletes.splice(i, 1);
      if (removedIds.delete(id) && report.removed > 0) report.removed--;
    }
  }

  // Full discovery means anything absent is gone. Filtered builds must not delete the rest.
  // An empty app list is NO filter (the CLI passes []), so it must still count as a full build:
  // otherwise a deleted conversation keeps its row, chunk file and vector forever.
  const full = !(opts.apps && opts.apps.length) && !opts.limitSources;
  if (full) {
    const claimedPaths = new Set(claimed.values());
    Object.keys(meta.sources).forEach((id) => {
      if (!next[id]) {
        const s = meta.sources[id];
        // In a full build, any row from our initial meta snapshot that was not produced by this
        // scan is removed: either its path was discovered and claimed by a newer id (e.g. an
        // ID_SCHEME bump or collision resolution), or its path was not in the discovery snapshot
        // at all. Rows added on disk by a concurrent build after our initial readMeta() are not in
        // `meta.sources` (and not in `removedIds`), so writeMeta() still preserves them.
        const supersededOrGone = !s || !s.path || claimedPaths.has(s.path) || !discoveredPaths.has(s.path);
        if (supersededOrGone) {
          removedIds.add(id);
          report.removed++;
          pendingDeletes.push(id);
        }
      }
    });
  } else {
    // Keep sources outside this filtered build untouched — but never keep a count the disk
    // cannot back: a row whose chunk file vanished is blanked and flagged (hash null) for the
    // next full build instead of inflating stats and coverage.
    Object.keys(meta.sources).forEach((id) => {
      if (next[id]) return;
      const s = meta.sources[id];
      if (s && !fs.existsSync(chunkPath(ctx, id))) {
        report.rechunk = (report.rechunk || 0) + 1;
        pendingBlankIds.push(id);
        next[id] = Object.assign({}, s, { chunks: 0, chunkHashes: [], hash: null, vec: null });
        return;
      }
      next[id] = s;
    });
  }

  // Stage all new chunk and token sidecar payloads to temporary files BEFORE acquiring meta.lock
  // so that tokenization and disk writes do not hold meta.lock; the locked section only performs
  // fast atomic renames, unlinks, and the meta.json merge.
  const stageSuffix = '.stage-' + process.pid + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  const stagedRenames = [];
  for (const id of pendingEnsureTokens) {
    const targetTok = tokenPath(ctx, id);
    if (!fs.existsSync(targetTok)) {
      const existingChunks = readChunks(chunkPath(ctx, id));
      if (existingChunks.length) {
        const tmpTok = targetTok + stageSuffix;
        _fsutil.atomicWrite(tmpTok, encodeTokensBuffer(existingChunks), 0o600);
        stagedRenames.push({ tmp: tmpTok, dest: targetTok });
      }
    }
  }
  for (const w of pendingWrites) {
    const body = w.chunks.map((c) => JSON.stringify(c)).join('\n') + '\n';
    w.entry.chunkBytes = Buffer.byteLength(body);
    const targetChunk = chunkPath(ctx, w.id);
    const tmpChunk = targetChunk + stageSuffix;
    _fsutil.atomicWrite(tmpChunk, body, 0o600);
    stagedRenames.push({ tmp: tmpChunk, dest: targetChunk });

    const targetTok = tokenPath(ctx, w.id);
    const tmpTok = targetTok + stageSuffix;
    _fsutil.atomicWrite(tmpTok, encodeTokensBuffer(w.chunks), 0o600);
    stagedRenames.push({ tmp: tmpTok, dest: targetTok });
  }

  function cleanupStagedFiles() {
    for (const r of stagedRenames) {
      try {
        fs.rmSync(r.tmp, { force: true });
      } catch {
        /* best-effort */
      }
    }
  }

  let lexicalCommitted = false;
  function applyPendingLexicalMutations(refreshMetaLock) {
    if (lexicalCommitted) return;
    lexicalCommitted = true;
    let ops = 0;
    for (const r of stagedRenames) {
      fs.mkdirSync(path.dirname(r.dest), { recursive: true });
      fs.renameSync(r.tmp, r.dest);
      ops++;
      if (ops % 200 === 0 && typeof refreshMetaLock === 'function') refreshMetaLock();
    }
    for (const id of pendingDeletes) {
      if (next[id] || claimed.has(id)) continue;
      try {
        fs.rmSync(chunkPath(ctx, id), { force: true });
        fs.rmSync(vectorPath(ctx, id), { force: true });
      } catch {
        /* best-effort */
      }
      dropTokens(ctx, id);
    }
    for (const id of pendingBlankIds) {
      try {
        fs.rmSync(vectorPath(ctx, id), { force: true });
      } catch {
        /* best-effort */
      }
      dropTokens(ctx, id);
    }
  }

  function snapshotMeta() {
    return {
      schemaVersion: SCHEMA_VERSION,
      builtAt: (ctx.now && ctx.now()) || new Date().toISOString(),
      embedding: report.embedding
        ? {
            space: report.embedding.space,
            model: report.embedding.model,
            host: report.embedding.host,
            remote: report.embedding.remote,
          }
        : meta.embedding || null,
      stats: countStats(next),
      sources: next,
    };
  }

  // Commit all lexical chunk/token writes, removals, and meta.json under meta.lock BEFORE any
  // embedding pass. If meta.lock cannot be acquired within the timeout, abort cleanly without
  // having modified or deleted a single chunk, token, or vector file on disk.
  const initialMeta = snapshotMeta();
  const initialWrote = writeMeta(ctx, initialMeta, {
    force: !!opts.force,
    beforeMerge: applyPendingLexicalMutations,
    removedIds: removedIds,
    metaLockTimeoutMs: opts.metaLockTimeoutMs,
  });
  if (!initialWrote) {
    cleanupStagedFiles();
    report.ok = false;
    report.errors.push({ path: metaPath(ctx), app: 'conv-index', error: 'meta.json write skipped (meta.lock busy)' });
    report.stats = meta.stats || countStats(meta.sources || {});
    return report;
  }

  let didEmbedPass = false;
  let embedBaseline = null;
  if (space && wantEmbed) {
    report.embedding = {
      space: space.hash,
      model: space.model,
      host: space.host,
      remote: space.remote,
      error: null,
      sources: 0,
      chunks: 0,
      remainingSources: 0,
    };
    // Embed newest conversations first so when the embedding model changes (or on the first
    // pass), the user's active chats become semantically searchable right away.
    const candidates = Object.keys(next)
      .filter((id) => {
        const entry = next[id];
        const needVec = !entry.vec || entry.vec.space !== space.hash || entry.vec.count !== entry.chunks;
        return needVec || !vectorFileOk(ctx, id, entry.vec);
      })
      .sort((a, b) =>
        String((next[b] && next[b].updatedAt) || '').localeCompare(String((next[a] && next[a].updatedAt) || '')),
      );
    const maxEmbed = opts.maxEmbedSources ? Math.max(1, Number(opts.maxEmbedSources)) : candidates.length;
    const toEmbed = candidates.slice(0, maxEmbed);
    report.embedding.remainingSources = Math.max(0, candidates.length - toEmbed.length);

    const lockStartedAt = (ctx.now && ctx.now()) || new Date().toISOString();
    const lockRes =
      toEmbed.length > 0
        ? acquireEmbedLock(ctx, {
            pid: process.pid,
            startedAt: lockStartedAt,
            model: space.model,
            space: space.hash,
            done: 0,
            total: candidates.length,
          })
        : { acquired: false, skipped: true };
    if (toEmbed.length > 0 && !lockRes.acquired) {
      // Another embed writer (background worker or concurrent tick) holds embed.lock:
      // do not duplicate embedding work, and never overwrite or delete its lock.
      report.embedding.busy = true;
      report.embedding.busyPid = (lockRes.holder && lockRes.holder.pid) || null;
      report.embedding.remainingSources = candidates.length;
    } else if (toEmbed.length > 0) {
      didEmbedPass = true;
      embedBaseline = new Map();
      Object.keys(initialMeta.sources).forEach((id) => {
        const s = initialMeta.sources[id];
        if (s) embedBaseline.set(id, String(s.hash || '') + ':' + String(s.chunkBytes || 0));
      });
      let embedDone = 0;
      let consecutiveFails = 0;
      let sinceFlush = 0;
      let lastFlushMs = Date.now();
      try {
        for (const id of toEmbed) {
          const entry = next[id];
          embedDone++;
          if (opts.onProgress) opts.onProgress({ phase: 'embed', done: embedDone, total: toEmbed.length, id: id });
          const chunks = readChunks(chunkPath(ctx, id));
          const diskHashes = chunks.map((c) => c.h);
          const hashesMatch =
            chunks.length === (entry.chunks || 0) &&
            Array.isArray(entry.chunkHashes) &&
            entry.chunkHashes.length === diskHashes.length &&
            diskHashes.every((h, idx) => h === entry.chunkHashes[idx]);
          // Metadata must never outrun the disk. A missing/torn chunk file — or a chunk file
          // rewritten by a concurrent lexical build while this embed pass was running — must
          // reconcile to the actual chunks on disk before embedding.
          if (!hashesMatch) {
            const diskMeta = readMeta(ctx);
            const diskEntry = diskMeta && diskMeta.sources && diskMeta.sources[id];
            if (diskEntry && diskEntry.hash && diskEntry.hash !== entry.hash) {
              // A concurrent lexical build updated this conversation on disk: adopt its row
              // and skip embedding stale hashes so prefix reuse can never mismatch.
              next[id] = diskEntry;
              continue;
            }
            entry.chunks = chunks.length;
            entry.chunkHashes = diskHashes;
            entry.hash = null;
            entry.vec = null;
            try {
              fs.rmSync(vectorPath(ctx, id), { force: true }); // stale: it described other chunks
            } catch {
              /* best-effort */
            }
            if (chunks.length) writeTokens(ctx, id, chunks);
            else dropTokens(ctx, id);
            report.rechunk = (report.rechunk || 0) + 1;
          }
          try {
            const prev = Object.assign({}, entry, {
              vec: entry._oldVec || entry.vec,
              chunkHashes: entry._oldHashes || entry.chunkHashes,
            });
            const vec = await embedSource(ctx, id, chunks, prev, space, opts);
            if (vec) {
              // Re-check that a concurrent lexical build did not rewrite the chunk file while
              // the HTTP embedding call was awaiting. If the chunk hashes on disk changed mid-call,
              // discard this vector so it is never paired with mismatched chunkHashes.
              const afterChunks = readChunks(chunkPath(ctx, id));
              const stillMatches =
                afterChunks.length === diskHashes.length && afterChunks.every((c, idx) => c.h === diskHashes[idx]);
              if (!stillMatches) {
                try {
                  fs.rmSync(vectorPath(ctx, id), { force: true });
                } catch {
                  /* best-effort */
                }
                const diskMeta = readMeta(ctx);
                if (diskMeta && diskMeta.sources && diskMeta.sources[id]) {
                  next[id] = diskMeta.sources[id];
                } else {
                  entry.vec = null;
                }
                continue;
              }
              entry.vec = vec;
              report.embedded++;
              report.embedding.sources++;
              report.embedding.chunks += chunks.length;
              sinceFlush++;
              const nowMs = Date.now();
              if (sinceFlush >= EMBED_CHECKPOINT_SOURCES || nowMs - lastFlushMs >= EMBED_CHECKPOINT_MS) {
                writeMeta(ctx, snapshotMeta(), {
                  checkpoint: true,
                  baseline: embedBaseline,
                  removedIds: removedIds,
                  metaLockTimeoutMs: opts.metaLockTimeoutMs,
                });
                writeEmbedLock(ctx, {
                  pid: process.pid,
                  token: lockRes.token,
                  startedAt: lockStartedAt,
                  model: space.model,
                  space: space.hash,
                  done: embedDone,
                  total: candidates.length,
                });
                sinceFlush = 0;
                lastFlushMs = nowMs;
              }
            }
          } catch (e) {
            // One unreadable source must not abandon the sources behind it. Only a streak of
            // consecutive failures means the endpoint is down: then stop hammering it.
            consecutiveFails++;
            report.embedding.errors = (report.embedding.errors || 0) + 1;
            report.embedding.error = (e && e.message) || String(e);
            report.ok = false; // embedding is incomplete even if the chunks are fine
            if (consecutiveFails >= 3) break; // the endpoint is down: stop hammering it
            continue;
          }
          consecutiveFails = 0;
        }
      } finally {
        releaseEmbedLock(ctx, lockRes.token);
      }
    }
  }
  Object.keys(next).forEach((id) => {
    delete next[id]._oldHashes;
    delete next[id]._oldVec;
  });

  const built = snapshotMeta();
  if (didEmbedPass) {
    const finalWrote = writeMeta(ctx, built, {
      checkpoint: true,
      baseline: embedBaseline,
      removedIds: removedIds,
      metaLockTimeoutMs: opts.metaLockTimeoutMs,
    });
    if (!finalWrote) {
      report.ok = false;
      report.errors.push({ path: metaPath(ctx), app: 'conv-index', error: 'meta.json write skipped (meta.lock busy)' });
      if (report.embedding && !report.embedding.error) {
        report.embedding.error = 'meta.json write skipped (meta.lock busy)';
      }
    }
    report.stats = built.stats;
  } else {
    report.stats = initialMeta.stats;
  }
  return report;
}

// ---- catalog / status ----------------------------------------------------------------------

// Does this row belong to the asked-for account? The account is the keyflip account name
// (a Claude profile, a Kiro slug, a ChatGPT/Codex slug) — case-insensitive, because these
// names are typed by hand. A row with no account (a tool keyflip does not manage accounts
// for) never matches: it is not "the account you asked for", it is "unknown".
function matchesAccount(row, wanted) {
  const have = String((row && row.account) || '').toLowerCase();
  const want = String(wanted || '').toLowerCase();
  if (!want) return true;
  return !!have && have === want;
}

// Metadata rows for every conversation. When the index exists this is a manifest read (no
// transcript parsing); otherwise it falls back to a full discovery pass. Both branches return
// the same row shape so callers (CLI, MCP) never branch on which source produced it.
function catalog(ctx, opts) {
  opts = opts || {};
  const meta = readMeta(ctx);
  if (meta && !opts.refresh) {
    const rows = Object.keys(meta.sources)
      .map((id) => meta.sources[id])
      .filter((s) => !opts.apps || !opts.apps.length || opts.apps.indexOf(s.app) !== -1)
      .filter((s) => !opts.sinceMs || Date.parse(s.updatedAt || '') >= opts.sinceMs)
      .filter(
        (s) =>
          !opts.cwd ||
          String(s.cwd || '')
            .toLowerCase()
            .indexOf(String(opts.cwd).toLowerCase()) !== -1,
      )
      .filter(
        (s) =>
          !opts.q ||
          String(s.title || '')
            .toLowerCase()
            .indexOf(String(opts.q).toLowerCase()) !== -1,
      )
      .filter((s) => !opts.account || matchesAccount(s, opts.account))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return { indexed: true, builtAt: meta.builtAt, conversations: rows, stats: meta.stats, errors: [] };
  }
  const r = conversations.list(ctx, opts);
  // The fallback branch has no manifest, so the account is resolved here — the same
  // attributor the build uses, so both paths answer identically.
  const accounts = _convaccounts.attributor(ctx);
  const rows = r.conversations
    .map((c) =>
      Object.assign({}, c, {
        path: c.source && c.source.path,
        mtimeMs: c.source && c.source.mtimeMs,
        size: c.source && c.source.size,
      }),
    )
    .map((s) => Object.assign({}, s, accounts.fields(s)))
    .filter((s) => !opts.sinceMs || Date.parse(s.updatedAt || '') >= opts.sinceMs)
    .filter(
      (s) =>
        !opts.cwd ||
        String(s.cwd || '')
          .toLowerCase()
          .indexOf(String(opts.cwd).toLowerCase()) !== -1,
    )
    .filter(
      (s) =>
        !opts.q ||
        String(s.title || '')
          .toLowerCase()
          .indexOf(String(opts.q).toLowerCase()) !== -1,
    )
    .filter((s) => !opts.account || matchesAccount(s, opts.account));
  return { indexed: false, builtAt: null, conversations: rows, stats: null, errors: r.errors };
}

function status(ctx, opts) {
  const meta = readMeta(ctx);
  if (!meta) return { exists: false, dir: dirOf(ctx), sources: 0, chunks: 0 };
  const activeSpace = spaceOf(opts, ctx);
  let vectorSources = 0;
  let vectorChunks = 0;
  let staleVectorSources = 0;
  let staleVectorChunks = 0;
  let staleModel = null;
  Object.keys(meta.sources).forEach((id) => {
    const s = meta.sources[id];
    if (s.vec && vectorFileOk(ctx, id, s.vec)) {
      if (s.vec.space === activeSpace.hash) {
        vectorSources++;
        vectorChunks += s.vec.count || 0;
      } else {
        staleVectorSources++;
        staleVectorChunks += s.vec.count || 0;
        if (!staleModel && s.vec.model) staleModel = s.vec.model;
      }
    }
  });
  const bg = backgroundStatus(ctx);
  const effectiveEmbedding =
    vectorChunks > 0 || staleVectorChunks > 0 || meta.embedding
      ? {
          space: activeSpace.hash,
          model: activeSpace.model,
          host: activeSpace.host,
          remote: activeSpace.remote,
        }
      : null;
  return {
    exists: true,
    dir: dirOf(ctx),
    builtAt: meta.builtAt,
    stats: meta.stats,
    embedding: effectiveEmbedding,
    vectorSources: vectorSources,
    vectorChunks: vectorChunks,
    coverage: meta.stats && meta.stats.chunks ? Math.round((vectorChunks / meta.stats.chunks) * 1000) / 10 : 0,
    staleVectorSources: staleVectorSources,
    staleVectorChunks: staleVectorChunks,
    staleModel:
      staleModel || (meta.embedding && meta.embedding.space !== activeSpace.hash ? meta.embedding.model : null),
    backgroundEmbed: bg.running ? bg : null,
  };
}

// Parse a user duration (`7d`, `12h`, `2026-10-01`) into epoch ms. Returns null when absent.
function parseSince(s, nowMs) {
  if (s == null || s === '') return null;
  const str = String(s).trim();
  const rel = /^(\d+)\s*([hdwmy])$/i.exec(str);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = { h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3, y: 365 * 86400e3 }[rel[2].toLowerCase()];
    return (nowMs == null ? Date.now() : nowMs) - n * unit;
  }
  const t = Date.parse(str);
  return Number.isNaN(t) ? null : t;
}

function activeSources(ctx, meta, opts) {
  opts = opts || {};
  const keys = [];
  Object.keys(meta.sources).forEach((id) => {
    const s = meta.sources[id];
    if (opts.apps && opts.apps.length && opts.apps.indexOf(s.app) === -1) return;
    if (opts.sinceMs && Date.parse(s.updatedAt || '') < opts.sinceMs) return;
    if (
      opts.cwd &&
      String(s.cwd || '')
        .toLowerCase()
        .indexOf(String(opts.cwd).toLowerCase()) === -1
    )
      return;
    if (opts.ids && opts.ids.length && opts.ids.indexOf(id) === -1) return;
    keys.push(id);
  });
  return keys;
}

// ---- lexical search ------------------------------------------------------------------------

function needles(qterms, rawQuery) {
  // Prefix (>=4 chars) so "retry" matches "retries"/"retrying"; short words stay exact.
  const set = Object.create(null);
  const add = (w) => {
    if (!w) return;
    set[w.length >= 5 ? w.slice(0, 4) : w] = 1;
  };
  qterms.forEach(add);
  String(rawQuery || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .forEach((w) => {
      if (w.length > 1 && !_bm25.STOP.has(w)) add(w);
    });
  return Object.keys(set);
}

function makeSnippet(text, terms) {
  const low = String(text || '').toLowerCase();
  let at = -1;
  for (const t of terms) {
    const p = low.indexOf(t);
    if (p !== -1 && (at === -1 || p < at)) at = p;
  }
  if (at === -1) at = 0;
  const start = Math.max(0, at - 80);
  const end = Math.min(low.length, at + 220);
  return (
    (start > 0 ? '…' : '') + String(text).slice(start, end).replace(/\s+/g, ' ').trim() + (end < low.length ? '…' : '')
  );
}

// Same text, another conversation: the duplicate is dropped from the page, so keep a pointer
// to where else it lives.
function foldTwin(twin, id) {
  if (!twin || twin.id === id) return;
  const list = twin.alsoIn || (twin.alsoIn = []);
  if (list.length < 10 && list.indexOf(id) === -1) list.push(id);
}

// Top chunks often all come from the same long session. A result list should answer "which
// conversations discuss this", so keep at most `perConv` chunks per conversation (default 1)
// while preserving rank order. Context packs may ask for more.
function diversify(hits, perConv) {
  const cap = perConv == null ? 1 : Math.max(1, perConv);
  const seen = Object.create(null);
  const out = [];
  for (const h of hits) {
    const n = seen[h.id] || 0;
    if (n >= cap) continue;
    seen[h.id] = n + 1;
    out.push(h);
  }
  return out;
}

function lexical(ctx, query, opts) {
  opts = opts || {};
  const meta = readMeta(ctx);
  const qterms = _bm25.tokenize(query);
  if (!meta) return { ok: false, reason: 'no-index', hits: [] };
  if (!qterms.length) return { ok: true, hits: [], scanned: 0 };
  const keys = activeSources(ctx, meta, opts);
  const need = needles(qterms, query);
  const qhash = new Map();
  qterms.forEach((t) => qhash.set(tokenHash(t), t));
  const docs = [];
  let totalLen = 0;
  let totalDocs = 0;
  // A source without a token sidecar (older index, torn file) is still searchable: tokenize
  // its text directly. Same tokenizer, same result — just slower.
  const textFallback = function (id) {
    const chunks = readChunks(chunkPath(ctx, id));
    for (const c of chunks) {
      totalDocs++;
      const toks = _bm25.tokenize(c.text);
      totalLen += typeof c.len === 'number' ? c.len : toks.length;
      const tf = Object.create(null);
      toks.forEach((t) => {
        tf[t] = (tf[t] || 0) + 1;
      });
      const hit = [];
      qterms.forEach((q) => {
        if (tf[q]) hit.push([q, tf[q]]);
      });
      if (hit.length) docs.push({ id: id, n: c.n, len: toks.length, tf: hit });
    }
  };
  for (const id of keys) {
    let buf = null;
    try {
      buf = fs.readFileSync(tokenPath(ctx, id));
    } catch {
      /* no sidecar yet */
    }
    if (!buf || !buf.length) {
      textFallback(id);
      continue;
    }
    const local = [];
    const expect = (meta.sources[id] && meta.sources[id].chunks) || 0;
    let localLen = 0;
    let off = 0;
    let n = 0;
    let ok = true;
    // The bytes are read with Buffer.readUInt32LE on purpose: a Uint16Array view over the same
    // bytes was measured and is only ~6% faster on this loop, because the cost is the ~13
    // million Map lookups, not the reads — and the view has to mask every uint32 back to
    // unsigned, which is easy to get wrong.
    while (off + 6 <= buf.length) {
      const len = buf.readUInt32LE(off);
      const count = buf.readUInt16LE(off + 4);
      const end = off + 6 + count * 6;
      if (end > buf.length) {
        ok = false; // torn sidecar — do not trust a partial scan
        break;
      }
      localLen += len;
      let hit = null;
      for (let p = off + 6; p < end; p += 6) {
        const term = qhash.get(buf.readUInt32LE(p));
        if (term !== undefined) (hit || (hit = [])).push([term, buf.readUInt16LE(p + 4)]);
      }
      if (hit) local.push({ id: id, n: n, len: len, tf: hit });
      n++;
      off = end;
    }
    if (!ok || n !== expect) {
      textFallback(id);
      continue;
    }
    totalDocs += n;
    totalLen += localLen;
    for (const d of local) docs.push(d);
  }
  if (!docs.length) return { ok: true, hits: [], scanned: totalDocs };
  const avgdl = totalLen / (totalDocs || 1);
  const df = Object.create(null);
  docs.forEach((d) => {
    d.tf.forEach((pair) => {
      df[pair[0]] = (df[pair[0]] || 0) + 1;
    });
  });
  const N = totalDocs;
  const scored = docs.map((d) => {
    let score = 0;
    d.tf.forEach((pair) => {
      const q = pair[0];
      const f = pair[1];
      const n = df[q] || 1;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * (f * (_bm25.K1 + 1))) / (f + _bm25.K1 * (1 - _bm25.B + (_bm25.B * d.len) / (avgdl || 1)));
    });
    return { id: d.id, chunk: d.n, score: score };
  });
  scored.sort((a, b) => b.score - a.score);
  // Hydrate only what can reach the page: text, role and ts come from the chunk file. Reading a
  // chunk file costs a file read plus a JSON parse per line, and most of the top candidates
  // belong to a conversation that is already on the page.
  const cap = opts.perConv == null ? 1 : Math.max(1, opts.perConv);
  const page = opts.limit || 10;
  const chunkCache = new Map();
  const hits = [];
  const seen = Object.create(null);
  // Forked and resumed sessions contain the very same turns, so the best hits for a query are
  // often byte-identical text in different conversation ids (19,779 duplicate chunk hashes
  // across 2,613 source pairs on the live index). A page that shows the same paragraph twice
  // wastes a slot: the duplicate is folded into the first hit's `alsoIn` instead of printed.
  const seenHash = new Map();
  let collapsed = 0;
  for (const h of scored) {
    if (hits.length >= page) break;
    const used = seen[h.id] || 0;
    if (used >= cap) continue;
    let chunks = chunkCache.get(h.id);
    if (!chunks) {
      chunks = readChunks(chunkPath(ctx, h.id));
      chunkCache.set(h.id, chunks);
    }
    const c = chunks[h.chunk];
    if (!c) continue;
    const twin = c.h && seenHash.get(c.h);
    if (twin) {
      foldTwin(twin, h.id);
      collapsed++;
      continue;
    }
    const src = meta.sources[h.id];
    seen[h.id] = used + 1;
    const hit = {
      id: h.id,
      app: src.app,
      title: src.title,
      cwd: src.cwd,
      updatedAt: src.updatedAt,
      account: src.account || null,
      accountConfidence: src.accountConfidence || null,
      chunk: c.n,
      role: c.role,
      ts: c.ts,
      score: h.score,
      chunkHash: c.h || null,
      alsoIn: [],
      snippet: makeSnippet(c.text, need),
    };
    if (c.h) seenHash.set(c.h, hit);
    hits.push(hit);
  }
  return { ok: true, hits: hits, scanned: totalDocs, collapsed: collapsed };
}

// ---- semantic search -----------------------------------------------------------------------

// A bounded min-heap of the best candidates. The semantic scan touches every chunk in the
// index, so it must not allocate one object per chunk nor sort the whole list: the heap keeps
// only the `cap` best and costs O(log cap) per candidate that beats the current worst.
//
// The order is (score desc, insertion order) — the same order a stable sort by score produces.
// Two conversations can hold the very same text and therefore score identically, and the
// earlier one has to stay in front.
function heapWorse(a, b) {
  if (a.score !== b.score) return a.score < b.score;
  return a.seq > b.seq;
}

function heapPush(heap, item) {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (!heapWorse(heap[i], heap[parent])) break;
    const swap = heap[parent];
    heap[parent] = heap[i];
    heap[i] = swap;
    i = parent;
  }
}

function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let worst = i;
      if (left < heap.length && heapWorse(heap[left], heap[worst])) worst = left;
      if (right < heap.length && heapWorse(heap[right], heap[worst])) worst = right;
      if (worst === i) break;
      const swap = heap[worst];
      heap[worst] = heap[i];
      heap[i] = swap;
      i = worst;
    }
  }
  return top;
}

async function semantic(ctx, query, opts) {
  opts = opts || {};
  const meta = readMeta(ctx);
  if (!meta) return { ok: false, reason: 'no-index', hits: [] };
  const space = spaceOf(opts, ctx);
  const keys = activeSources(ctx, meta, opts);
  // Do not ask the embedding endpoint for a query vector when no source has one: hybrid search
  // used to spend a network round-trip on every call and then silently rank by BM25 only.
  const hasVectors = keys.some((id) => {
    const s = meta.sources[id];
    return s && s.vec && s.vec.space === space.hash && s.vec.dim && fs.existsSync(vectorPath(ctx, id));
  });
  if (!hasVectors) {
    return { ok: false, reason: 'no-vectors', hits: [] };
  }
  let qv;
  try {
    const got = await _embed.embed([safeForEmbedding(query, space)], opts);
    qv = got && got[0];
  } catch (e) {
    return { ok: false, reason: 'embed-failed', detail: (e && e.message) || String(e), hits: [] };
  }
  if (!Array.isArray(qv) || !qv.length) return { ok: false, reason: 'no-query-vector', hits: [] };
  // Score first, hydrate later. Building a snippet (and reading the chunk file) for every one of
  // ~120k chunks — almost all of which score > 0 on cosine — made one query take minutes. The
  // ranking only needs id/index/score; text is read for the top candidates that can reach the page.
  //
  // Only the best `want` candidates are kept, in a bounded min-heap: scoring every chunk into an
  // array and sorting 120k entries allocated 120k objects per query and dominated the scan.
  const want = Math.max(50, (opts.limit || 10) * 20); // enough to survive diversify
  const heap = [];
  let seq = 0;
  let covered = 0;
  let qCache = null; // { dim, q, norm } — the query, padded and normalized once per dimension
  for (const id of keys) {
    const src = meta.sources[id];
    if (!src.vec || src.vec.space !== space.hash || !src.vec.dim) continue;
    const buf = readVectorFile(vectorPath(ctx, id), src.vec.dim, src.vec.count);
    if (!buf) continue;
    covered++;
    const dim = src.vec.dim;
    // A Float32Array view over the same bytes. The per-element Buffer.readFloatLE call was
    // ~94 million calls for a 120k-chunk index; the view removes them without changing a score
    // (the float32 bytes are the same, and the arithmetic order is the same).
    const vecs =
      buf.byteOffset % 4 === 0
        ? new Float32Array(buf.buffer, buf.byteOffset, dim * src.vec.count)
        : new Float32Array(buf);
    // The query norm does not depend on the chunk, but it used to be recomputed for every one
    // of the ~120k chunks.
    if (!qCache || qCache.dim !== dim) {
      const q = new Float64Array(dim);
      let nn = 0;
      for (let j = 0; j < dim; j++) {
        const b = qv[j] || 0;
        q[j] = b;
        nn += b * b;
      }
      qCache = { dim: dim, q: q, norm: Math.sqrt(nn) };
    }
    const q = qCache.q;
    const qn = qCache.norm;
    for (let i = 0; i < src.vec.count; i++) {
      let dot = 0,
        na = 0;
      const base = i * dim;
      for (let j = 0; j < dim; j++) {
        const a = vecs[base + j];
        dot += a * q[j];
        na += a * a;
      }
      const score = na && qn ? dot / (Math.sqrt(na) * qn) : 0;
      if (score > 0) {
        const item = { id: id, i: i, score: score, seq: seq++ };
        if (heap.length < want) heapPush(heap, item);
        else if (score > heap[0].score) {
          heapPop(heap);
          heapPush(heap, item);
        }
      }
    }
  }
  // The heap pops in ascending score order; the page wants the best first.
  const scored = [];
  while (heap.length) scored.push(heapPop(heap));
  scored.reverse();
  const needlesForQuery = needles(_bm25.tokenize(query), query);
  const chunkCache = new Map();
  const hits = [];
  // Hydrate only what can reach the page: one chunk per conversation until the page is full.
  // Reading a chunk file costs a file read plus a JSON parse per line, and most of the top
  // candidates belong to a conversation that is already on the page.
  const cap = opts.perConv == null ? 1 : Math.max(1, opts.perConv);
  const page = opts.limit || 10;
  const seen = Object.create(null);
  // Same duplicate collapse as the lexical side: identical chunk text in a forked session
  // scores identically, so the page would otherwise repeat itself.
  const seenHash = new Map();
  let collapsed = 0;
  for (const h of scored) {
    if (hits.length >= page) break;
    const used = seen[h.id] || 0;
    if (used >= cap) continue;
    let chunks = chunkCache.get(h.id);
    if (!chunks) {
      chunks = readChunks(chunkPath(ctx, h.id));
      chunkCache.set(h.id, chunks);
    }
    const c = chunks[h.i];
    if (!c) continue;
    const twin = c.h && seenHash.get(c.h);
    if (twin) {
      foldTwin(twin, h.id);
      collapsed++;
      continue;
    }
    const src = meta.sources[h.id];
    seen[h.id] = used + 1;
    const hit = {
      id: h.id,
      app: src.app,
      title: src.title,
      cwd: src.cwd,
      updatedAt: src.updatedAt,
      account: src.account || null,
      accountConfidence: src.accountConfidence || null,
      chunk: c.n,
      role: c.role,
      ts: c.ts,
      score: h.score,
      chunkHash: c.h || null,
      alsoIn: [],
      snippet: makeSnippet(c.text, needlesForQuery),
    };
    if (c.h) seenHash.set(c.h, hit);
    hits.push(hit);
  }
  return {
    ok: true,
    mode: 'semantic',
    hits: hits,
    collapsed: collapsed,
    coverage: { sources: covered, total: keys.length },
    model: space.model,
  };
}

// Reciprocal Rank Fusion: independent rankings are combined by position, so scores from
// BM25 and cosine (different scales) never have to be comparable.
//
// The weight per list (RRF_WEIGHTS) decides who leads. The semantic list is deliberately
// lighter than the lexical one: on a real corpus of 1856 conversations BM25 is the sharper
// retriever, and a vector-only hit must never push a BM25 hit off the page.
function rrf(lists, limit, perConv, weights) {
  const byId = Object.create(null);
  lists.forEach((hits, li) => {
    const w = weights && weights[li] != null ? weights[li] : RRF_WEIGHTS[li] != null ? RRF_WEIGHTS[li] : 1;
    (hits || []).forEach((h, i) => {
      const key = h.id + '#' + h.chunk;
      const cur = byId[key];
      const add = w / (RRF_K + i + 1);
      if (cur) {
        cur.rrf += add;
        cur.sources[li] = true;
        if (h.score > cur.score) Object.assign(cur, { score: h.score, snippet: h.snippet || cur.snippet });
      } else {
        byId[key] = Object.assign({}, h, { rrf: add, sources: { [li]: true } });
      }
    });
  });
  const out = Object.keys(byId).map((k) => byId[k]);
  out.sort((a, b) => b.rrf - a.rrf);
  // The two lists collapse duplicates inside themselves, but the same text can still arrive
  // once from each list. Fold it here too, before `perConv` spends page slots on it.
  const seenHash = new Map();
  const unique = [];
  let collapsed = 0;
  for (const h of out) {
    if (h.chunkHash) {
      const twin = seenHash.get(h.chunkHash);
      if (twin) {
        foldTwin(twin, h.id);
        collapsed++;
        continue;
      }
      seenHash.set(h.chunkHash, h);
    }
    unique.push(h);
  }
  return {
    hits: diversify(unique, perConv)
      .slice(0, limit || 10)
      .map((h) => Object.assign(h, { score: h.rrf })),
    collapsed: collapsed,
  };
}

async function search(ctx, query, opts) {
  opts = opts || {};
  const mode = opts.mode || (opts.semantic ? 'semantic' : 'lexical');
  const r = await searchMode(ctx, query, opts, mode);
  if (!opts.account || !r || !r.hits) return r;
  // The account filter runs AFTER the ranking, not before it: the ranking is over the whole
  // corpus, and filtering first would change what "the best match" even means.
  r.hits = r.hits.filter((h) => matchesAccount(h, opts.account));
  r.accountFiltered = opts.account;
  return r;
}

async function searchMode(ctx, query, opts, mode) {
  if (mode === 'lexical') return lexical(ctx, query, opts);
  if (mode === 'semantic') return semantic(ctx, query, opts);
  if (mode === 'hybrid') {
    // Independent retrievers: run them together so a hybrid is not the sum of both latencies.
    const wide = Object.assign({}, opts, { limit: Math.max(opts.limit || 10, 50) });
    const both = await Promise.all([lexical(ctx, query, wide), semantic(ctx, query, wide)]);
    const lex = both[0];
    const sem = both[1];
    if (!sem.ok) {
      // `lex` ran wide (max(limit,50)) so that fusion would have enough candidates to survive
      // diversify. With no semantic list there is nothing to fuse, so cut back to the page the
      // caller asked for — otherwise `--limit 3` silently printed 50 results.
      const page = opts.limit || 10;
      const hits = lex.hits.slice(0, page);
      // Each kept hit already carries the twins folded into it, so counting them here stays
      // honest about this page (twins folded into hits beyond the cut are not claimed).
      let collapsed = 0;
      for (const h of hits) collapsed += h.alsoIn ? h.alsoIn.length : 0;
      // Say what actually ranked: an agent/user reading `mode` must not believe vectors were used
      // when the endpoint was never asked (no-vectors) or failed.
      return Object.assign({}, lex, {
        mode: 'lexical',
        hits: hits,
        collapsed: collapsed,
        semanticError: sem.reason,
        semanticDetail: sem.detail || null,
      });
    }
    const fused = rrf([lex.hits, sem.hits], opts.limit || 10, opts.perConv);
    return {
      ok: true,
      hits: fused.hits,
      mode: 'hybrid',
      collapsed: (lex.collapsed || 0) + (sem.collapsed || 0) + (fused.collapsed || 0),
      semanticCoverage: sem.coverage,
    };
  }
  return { ok: false, reason: 'bad-mode', hits: [] };
}

// ---- context pack --------------------------------------------------------------------------

function expandHit(ctx, hit, opts) {
  const meta = readMeta(ctx);
  if (!meta || !meta.sources[hit.id]) return null;
  const chunks = readChunks(chunkPath(ctx, hit.id));
  const span = Math.max(0, Number(opts.expand) || 0);
  const from = Math.max(0, hit.chunk - span);
  const to = Math.min(chunks.length - 1, hit.chunk + span);
  if (from > to) return null;
  const parts = [];
  for (let i = from; i <= to; i++) parts.push(chunks[i].text);
  return { source: meta.sources[hit.id], text: parts.join('\n\n'), from: from, to: to };
}

// A portable RAG context block: stable headings, source ids, paths and dates, char-budgeted.
function contextPack(ctx, query, hits, opts) {
  opts = opts || {};
  const budget = Number(opts.budget) || 12000;
  const expand = opts.expand == null ? 1 : Number(opts.expand);
  const lines = [
    '# Conversation context',
    '',
    'Query: ' + query,
    'Retrieved from ' + (hits.length || 0) + ' local conversation chunks. Read-only; no conversation was uploaded.',
    '',
  ];
  let used = lines.join('\n').length;
  let n = 0;
  for (const hit of hits) {
    const ex = expandHit(ctx, hit, { expand: expand });
    if (!ex) continue;
    const s = ex.source;
    const head = [
      '## ' + (n + 1) + '. [' + s.app + '] ' + s.title,
      'source: `' + s.id + '` · updated: ' + (s.updatedAt || '?') + (s.cwd ? ' · cwd: ' + s.cwd : ''),
      '',
    ].join('\n');
    let body = ex.text;
    const room = budget - used - head.length;
    // Count the source only once it is actually included: `n` drives the "no chunks" line.
    if (room < 200) break;
    n++;
    if (body.length > room) body = body.slice(0, room) + '\n…[trimmed by keyflip]';
    lines.push(head + body + '\n');
    used += head.length + body.length + 1;
    if (used >= budget) break;
  }
  if (!n) lines.push('_No matching chunks._');
  return lines.join('\n');
}

export {
  SCHEMA_VERSION,
  INDEX_DIR,
  CHUNK_SCHEME,
  CHUNK_TARGET,
  RRF_K,
  RRF_WEIGHTS,
  dirOf,
  metaPath,
  metaLockPath,
  embedLockPath,
  chunkPath,
  vectorPath,
  tokenPath,
  keyOf,
  chunkConversation,
  readChunks,
  build,
  catalog,
  status,
  backgroundStatus,
  acquireEmbedLock,
  spawnBackgroundEmbed,
  parseSince,
  lexical,
  semantic,
  search,
  rrf,
  contextPack,
  expandHit,
  spaceOf,
  safeForEmbedding,
  isLoopback,
};
