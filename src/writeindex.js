// Write-input extractor and store for Claude Code sessions (including sub-agent transcripts).
// Extracts file-writing tool inputs (Write, Edit, MultiEdit, NotebookEdit, and Bash commands
// that actually write files), masks secrets before hashing or saving, caps bodies at 64 KiB
// (48 KiB head + 16 KiB tail + marker), deduplicates blobs by masked SHA-256, tracks a byte
// offset per source file for incremental/idempotent builds, and stores everything 0600 under
// <configDir>/conv-index/writes/ (covered by secretpaths.SECRET_DIRS).
// Tool outputs (tool_result / toolUseResult) are NEVER stored.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import * as conversations from './conversations.js';
import * as config from './config.js';
import * as secretscan from './secretscan.js';
import * as secretpaths from './secretpaths.js';
import * as fsutil from './fsutil.js';

const SCHEMA_VERSION = 1;
const WRITES_DIR = 'writes';
const UNRESOLVED_PATH = '(bash:belirsiz)';
const HEAD_BYTES = 48 * 1024;
const TAIL_BYTES = 16 * 1024;
const MAX_BODY_BYTES = HEAD_BYTES + TAIL_BYTES;
const WARN_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;
const HEAD_HASH_BYTES = 4096;
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']);
const SPECIAL_DEVICES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/stdin', '/dev/tty']);
const SHELL_PRELUDE = new Set(['env', 'command', 'builtin', 'nohup', 'time', 'sudo']);
const HEREDOC_RE = /(?<!<)<<(-?)\s*(?:(['"])([^'"]+)\2|\\?([^\s'"();|&<>]+))/;
const PY_CMD_RE = /^python(?:\d+(?:\.\d+)?)?$/i;
const JS_CMD_RE = /^(?:node|bun|deno)$/i;
const SED_CMD_RE = /^g?sed$/i;

// ---- paths & configuration -----------------------------------------------------------------

function dirOf(ctx) {
  return path.join(ctx.configDir, 'conv-index', WRITES_DIR);
}

function eventsDir(ctx) {
  return path.join(dirOf(ctx), 'events');
}

function blobsDir(ctx) {
  return path.join(dirOf(ctx), 'blobs');
}

function pathsFile(ctx) {
  return path.join(dirOf(ctx), 'paths.json');
}

function statePath(ctx) {
  return path.join(dirOf(ctx), 'state.json');
}

function lockPath(ctx) {
  return path.join(dirOf(ctx), 'writes.lock');
}

function keyOf(targetPath) {
  return crypto.createHash('sha1').update(String(targetPath)).digest('hex').slice(0, 16);
}

function eventPath(ctx, targetPath) {
  return path.join(eventsDir(ctx), keyOf(targetPath) + '.jsonl');
}

function blobPath(ctx, sha256) {
  return path.join(blobsDir(ctx), sha256.slice(0, 2), sha256);
}

function homeOf(ctx) {
  return (ctx && ctx.home) || os.homedir();
}

function expandHome(p, home) {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

function isEnabled(ctx, opts) {
  if (opts && typeof opts.writes === 'boolean') return opts.writes;
  return Boolean(config.get(ctx, 'conv.writes.enabled'));
}

function excludeList(ctx, opts) {
  const home = homeOf(ctx);
  const raw = [];
  const cfgVal = config.get(ctx, 'conv.writes.exclude');
  if (cfgVal) raw.push(...String(cfgVal).split(','));
  if (opts && opts.exclude) {
    if (Array.isArray(opts.exclude)) raw.push(...opts.exclude);
    else raw.push(...String(opts.exclude).split(','));
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const trimmed = String(item || '').trim();
    if (!trimmed) continue;
    const expanded = expandHome(trimmed, home);
    if (seen.has(expanded)) continue;
    seen.add(expanded);
    out.push(expanded);
  }
  return out;
}

function encodeCwd(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

function isExcludedProject(rules, info) {
  if (!rules || !rules.length) return false;
  const projectKey = (info && info.projectKey) || '';
  const cwd = (info && info.cwd) || '';
  const targetPath = (info && info.targetPath) || '';
  for (const rule of rules) {
    if (rule.includes('/') || rule.includes('\\')) {
      const normRule = rule.replace(/\\/g, '/').replace(/\/+$/, '');
      if (!normRule) continue;
      for (const candidate of [cwd, targetPath]) {
        if (!candidate || candidate === UNRESOLVED_PATH) continue;
        const normVal = String(candidate).replace(/\\/g, '/').replace(/\/+$/, '');
        if (normVal === normRule || normVal.startsWith(normRule + '/')) return true;
      }
      const enc = encodeCwd(normRule);
      if (projectKey && projectKey === enc) return true;
    } else {
      const low = rule.toLowerCase();
      if (projectKey && (projectKey === rule || projectKey.toLowerCase().includes(low))) return true;
      for (const candidate of [cwd, targetPath]) {
        if (!candidate || candidate === UNRESOLVED_PATH) continue;
        const segs = String(candidate).split(/[/\\]+/).filter(Boolean);
        if (segs.some((s) => s === rule || s.toLowerCase() === low)) return true;
      }
    }
  }
  return false;
}

function isSecretTarget(targetPath) {
  if (!targetPath || targetPath === UNRESOLVED_PATH) return false;
  const base = path.basename(String(targetPath));
  const lower = base.toLowerCase();
  if (/^\.env\.(?:example|sample|template|dist)$/i.test(lower)) return false;
  if (secretpaths.isSecretFile(base)) return true;
  if (lower === '.env' || lower.startsWith('.env.')) return true;
  if (/^id_(?:rsa|ed25519|ecdsa|dsa)$/.test(lower)) return true;
  if (/\.(?:p12|pfx|kdbx|jks)$/.test(lower)) return true;
  if (lower === '.netrc' || lower === '.npmrc' || lower === '.pypirc') return true;
  return false;
}

// ---- locking -------------------------------------------------------------------------------

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === 'EPERM');
  }
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
        /* ignore */
      }
      if (current !== null && current !== expectedRaw) {
        try {
          fs.linkSync(claim, file);
        } catch {
          /* newer lock already exists */
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

function withWriteLock(ctx, opts, fn) {
  const file = lockPath(ctx);
  const waitMs = opts && typeof opts.lockTimeoutMs === 'number' && opts.lockTimeoutMs >= 0 ? opts.lockTimeoutMs : LOCK_WAIT_MS;
  const deadline = Date.now() + waitMs;
  const token = process.pid + '-' + Date.now() + '-' + crypto.randomBytes(6).toString('hex');
  fs.mkdirSync(dirOf(ctx), { recursive: true });
  let acquired = false;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        const now = Date.now();
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now, updatedAt: now, token: token }) + '\n', 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      acquired = true;
      break;
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        let rawText = null;
        let cur = null;
        try {
          rawText = fs.readFileSync(file, 'utf8');
          cur = JSON.parse(rawText);
        } catch {
          /* ignore */
        }
        const dead = !cur || !cur.pid || !pidAlive(cur.pid);
        const beat = cur ? Number(cur.updatedAt || cur.at || 0) : 0;
        const stale = cur && beat > 0 && Date.now() - beat > LOCK_STALE_MS;
        if (dead || stale) {
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
  if (!acquired) return { acquired: false };
  try {
    return { acquired: true, value: fn() };
  } finally {
    try {
      const rawText = fs.readFileSync(file, 'utf8');
      const cur = JSON.parse(rawText);
      if (cur && cur.token === token) reclaimLockFile(file, rawText);
    } catch {
      /* ignore */
    }
  }
}

// ---- secret masking, line counting & 64 KiB capping ----------------------------------------

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function countBufferLines(buf) {
  if (!buf || buf.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = buf.indexOf(0x0a, pos)) !== -1) {
    count++;
    pos++;
  }
  if (buf[buf.length - 1] !== 0x0a) count++;
  return count;
}

function maskSegment(raw) {
  const src = String(raw == null ? '' : raw);
  const kinds = secretscan.scanLabeled(src);
  const lined = secretscan.redactLines(src);
  let count = lined.count;

  // Catch `export KEY=value` shell lines that redactLines skips because of the `export ` prefix.
  const exported = lined.text
    .split('\n')
    .map(function (line) {
      const m = line.match(/^(\s*export\s+)(["']?[A-Za-z0-9_.-]+["']?)(\s*=\s*)(.+?)(\s*;?\s*)$/);
      if (!m) return line;
      const key = m[2].replace(/^["']|["']$/g, '');
      const val = m[4];
      if (secretscan.isCredentialKey(key) && !secretscan.isEnvRefOrEmpty(val)) {
        count++;
        const q = /^["']/.test(val) ? val.slice(0, 1) : '';
        return m[1] + m[2] + m[3] + q + secretscan.REDACTED + q + m[5];
      }
      return line;
    })
    .join('\n');

  // Catch inline JSON `"credential_key": "value"` fields inside single-line configs.
  const jsonMasked = exported.replace(
    /"([A-Za-z0-9_.-]+)"(\s*:\s*)"([^"\r\n]*)"/g,
    function (full, key, sep, val) {
      if (secretscan.isCredentialKey(key) && !secretscan.isEnvRefOrEmpty(val)) {
        count++;
        return '"' + key + '"' + sep + '"' + secretscan.REDACTED + '"';
      }
      return full;
    },
  );

  const keyHits = count;
  const shaped = secretscan.redactShapes(jsonMasked);
  count += shaped.count;
  if (keyHits > 0 && kinds.indexOf('credential-key') === -1) kinds.push('credential-key');
  return { text: shaped.text, count: count, kinds: kinds.sort() };
}

function sliceUtf8Head(buf, maxBytes) {
  if (buf.length <= maxBytes) return buf.toString('utf8');
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

function sliceUtf8Tail(buf, maxBytes) {
  if (buf.length <= maxBytes) return buf.toString('utf8');
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString('utf8');
}

function trimBrokenMarkerTail(text) {
  const open = text.lastIndexOf('«');
  if (open === -1) return text;
  const suffix = text.slice(open);
  if (suffix.length < secretscan.REDACTED.length && secretscan.REDACTED.startsWith(suffix)) {
    return text.slice(0, open);
  }
  return text;
}

function trimBrokenMarkerHead(text) {
  const close = text.indexOf('»');
  if (close === -1 || close >= secretscan.REDACTED.length) return text;
  const prefix = text.slice(0, close + 1);
  if (secretscan.REDACTED.endsWith(prefix)) {
    return text.slice(close + 1);
  }
  return text;
}

function maskAndCap(rawText) {
  const s = String(rawText == null ? '' : rawText);
  const rawBuf = Buffer.from(s, 'utf8');
  const lines = countBufferLines(rawBuf);

  if (rawBuf.length <= MAX_BODY_BYTES) {
    const masked = maskSegment(s);
    const bytes = Buffer.byteLength(masked.text, 'utf8');
    return {
      text: masked.text,
      hash: sha256Hex(masked.text),
      bytes: bytes,
      rawBytes: rawBuf.length,
      lines: lines,
      redacted: masked.count,
      secretKinds: masked.kinds,
      truncated: false,
      truncatedBytes: 0,
    };
  }

  // Mask slightly wider head/tail windows so tokens crossing the 48 KiB / 16 KiB boundary still redact.
  const headWin = maskSegment(sliceUtf8Head(rawBuf, HEAD_BYTES + 4096));
  const tailWin = maskSegment(sliceUtf8Tail(rawBuf, TAIL_BYTES + 4096));

  const headPart = trimBrokenMarkerTail(sliceUtf8Head(Buffer.from(headWin.text, 'utf8'), HEAD_BYTES));
  const tailPart = trimBrokenMarkerHead(sliceUtf8Tail(Buffer.from(tailWin.text, 'utf8'), TAIL_BYTES));
  const keptHeadBytes = Math.min(HEAD_BYTES, Buffer.byteLength(headPart, 'utf8'));
  const keptTailBytes = Math.min(TAIL_BYTES, Buffer.byteLength(tailPart, 'utf8'));
  const truncatedBytes = Math.max(1, rawBuf.length - keptHeadBytes - keptTailBytes);
  const marker = '«keyflip_truncated ' + truncatedBytes + ' bytes»';
  const finalText = headPart + '\n' + marker + '\n' + tailPart;

  const kindsSet = new Set([...headWin.kinds, ...tailWin.kinds]);
  return {
    text: finalText,
    hash: sha256Hex(finalText),
    bytes: Buffer.byteLength(finalText, 'utf8'),
    rawBytes: rawBuf.length,
    lines: lines,
    redacted: headWin.count + tailWin.count,
    secretKinds: Array.from(kindsSet).sort(),
    truncated: true,
    truncatedBytes: truncatedBytes,
  };
}

// ---- source discovery (main sessions + subagents/) -----------------------------------------

function statFile(file, extra) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size === 0) return null;
  return Object.assign({ path: file, mtimeMs: st.mtimeMs, size: st.size }, extra || {});
}

function collectSubagentFiles(dir, depth, out, projectKey, sessionId) {
  if (depth < 0) return;
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      collectSubagentFiles(p, depth - 1, out, projectKey, sessionId);
    } else if (e.isFile() && e.name.endsWith('.jsonl') && !e.name.endsWith('.meta.json')) {
      const stem = e.name.slice(0, -6);
      const agentId = stem.replace(/^agent-/, '') || stem;
      const src = statFile(p, {
        projectKey: projectKey,
        sessionId: sessionId,
        agentId: agentId,
        subagent: true,
      });
      if (src) out.push(src);
    }
  }
}

function discoverSources(ctx, excludes) {
  const root = conversations.claudeRoot(ctx);
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.endsWith('.keyflip-bak')) continue;
    if (isExcludedProject(excludes, { projectKey: d.name })) continue;
    const projDir = path.join(root, d.name);
    let entries;
    try {
      entries = fs.readdirSync(projDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isFile()) {
        const f = ent.name;
        if (!f.endsWith('.jsonl') || f.endsWith('.meta.json')) continue;
        const id = f.slice(0, -6);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) continue;
        const src = statFile(path.join(projDir, f), {
          projectKey: d.name,
          sessionId: id,
          agentId: null,
          subagent: false,
        });
        if (src) out.push(src);
      } else if (ent.isDirectory()) {
        const subDir = path.join(projDir, ent.name, 'subagents');
        collectSubagentFiles(subDir, 2, out, d.name, ent.name);
      }
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

// ---- byte-offset streaming JSONL reader ----------------------------------------------------

function computeHeadHash(file, maxBytes) {
  const len = maxBytes > 0 ? Math.min(maxBytes, HEAD_HASH_BYTES) : HEAD_HASH_BYTES;
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, 0);
    return {
      hash: crypto.createHash('sha1').update(buf.subarray(0, n)).digest('hex'),
      len: n,
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function scanJsonlFromOffset(file, startOffset, onLine) {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error('not a file');
  const fileSize = st.size;
  if (startOffset >= fileSize) return { offset: fileSize, oversized: 0 };

  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Math.max(4096, fileSize - startOffset)));
  let pos = startOffset;
  let lineStartByte = startOffset;
  let committedOffset = startOffset;
  let pendingParts = [];
  let pendingBytes = 0;
  let overflow = false;
  let oversized = 0;

  function emitLine(lineBuf, byteOffset) {
    if (lineBuf.length === 0) return;
    if (lineBuf[lineBuf.length - 1] === 0x0d) lineBuf = lineBuf.subarray(0, lineBuf.length - 1);
    if (lineBuf.length === 0) return;
    onLine(lineBuf.toString('utf8'), byteOffset);
  }

  try {
    while (pos < fileSize) {
      const toRead = Math.min(buf.length, fileSize - pos);
      const n = fs.readSync(fd, buf, 0, toRead, pos);
      if (n <= 0) break;
      const chunk = buf.subarray(0, n);
      let cursor = 0;

      while (cursor < n) {
        const nl = chunk.indexOf(0x0a, cursor);
        if (nl === -1) {
          const pieceLen = n - cursor;
          if (!overflow) {
            if (pendingBytes + pieceLen > MAX_LINE_BYTES) {
              pendingParts = [];
              pendingBytes = 0;
              overflow = true;
              oversized++;
            } else if (pieceLen > 0) {
              pendingParts.push(Buffer.from(chunk.subarray(cursor, n)));
              pendingBytes += pieceLen;
            }
          }
          break;
        }
        const piece = chunk.subarray(cursor, nl);
        if (!overflow) {
          if (pendingBytes + piece.length > MAX_LINE_BYTES) {
            oversized++;
          } else if (pendingParts.length > 0) {
            if (piece.length > 0) pendingParts.push(piece);
            emitLine(Buffer.concat(pendingParts, pendingBytes + piece.length), lineStartByte);
          } else {
            emitLine(piece, lineStartByte);
          }
        }
        pendingParts = [];
        pendingBytes = 0;
        overflow = false;
        committedOffset = pos + nl + 1;
        lineStartByte = committedOffset;
        cursor = nl + 1;
      }
      pos += n;
    }

    // Only consume a trailing line without '\n' if it already parses as valid JSON; otherwise
    // keep committedOffset at the last newline so a live-writing line is picked up cleanly.
    if (!overflow && pendingBytes > 0) {
      const tailText = Buffer.concat(pendingParts, pendingBytes).toString('utf8').trim();
      if (tailText) {
        try {
          JSON.parse(tailText);
          onLine(tailText, lineStartByte);
          committedOffset = fileSize;
        } catch {
          /* incomplete JSON line at EOF — retry from lineStartByte on the next pass */
        }
      } else {
        committedOffset = fileSize;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return { offset: committedOffset, oversized: oversized };
}

// ---- Bash heredoc & file-write classifier --------------------------------------------------

function quoteDelta(line, state) {
  const s = state || { stack: [] };
  const top = () => (s.stack.length ? s.stack[s.stack.length - 1] : null);
  const heredocPositions = [];
  let escaped = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const mode = top();

    if (mode === "'") {
      if (ch === "'") s.stack.pop();
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (mode === '"') {
      if (ch === '"') {
        s.stack.pop();
      } else if (ch === '$' && line[i + 1] === '(') {
        s.stack.push('$(');
        i++;
      } else if (ch === '`') {
        s.stack.push('`');
      }
      continue;
    }
    if (mode === '`') {
      if (ch === '`') s.stack.pop();
      else if (ch === '"') s.stack.push('"');
      else if (ch === "'") s.stack.push("'");
      continue;
    }

    // Outside quotes (top-level or inside $(...))
    if (ch === "'") {
      s.stack.push("'");
    } else if (ch === '"') {
      s.stack.push('"');
    } else if (ch === '`') {
      s.stack.push('`');
    } else if (ch === '$' && line[i + 1] === '(') {
      s.stack.push('$(');
      i++;
    } else if (ch === ')' && mode === '$(') {
      s.stack.pop();
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      break;
    } else if (ch === '<' && line[i + 1] === '<' && line[i + 2] !== '<' && line[i - 1] !== '<') {
      heredocPositions.push(i);
    }
  }
  return heredocPositions;
}

function extractHeredocs(command) {
  const lines = String(command || '').replace(/\r\n/g, '\n').split('\n');
  const heredocs = [];
  const outLines = [];
  const quoteState = { stack: [] };
  let i = 0;

  while (i < lines.length) {
    let line = lines[i];
    const positions = quoteDelta(line, quoteState);
    const pending = [];

    if (positions.length) {
      let replaced = '';
      let cursor = 0;
      for (const pos of positions) {
        if (pos < cursor) continue;
        replaced += line.slice(cursor, pos);
        const m = HEREDOC_RE.exec(line.slice(pos));
        if (m && m.index === 0) {
          const stripTabs = m[1] === '-';
          const delim = m[3] || m[4];
          const quoted = Boolean(m[2]) || line.slice(pos, pos + m[0].length).includes('\\');
          const id = heredocs.length;
          heredocs.push({ delim: delim, stripTabs: stripTabs, quoted: quoted, body: '' });
          pending.push(id);
          replaced += ' «HD' + id + '» ';
          cursor = pos + m[0].length;
        } else {
          replaced += '<<';
          cursor = pos + 2;
        }
      }
      replaced += line.slice(cursor);
      line = replaced;
    }

    outLines.push(line);
    i++;

    for (const id of pending) {
      const hd = heredocs[id];
      const bodyLines = [];
      while (i < lines.length) {
        const cur = lines[i];
        const check = hd.stripTabs ? cur.replace(/^\t+/, '') : cur;
        if (check === hd.delim) {
          i++;
          break;
        }
        bodyLines.push(hd.stripTabs ? cur.replace(/^\t+/, '') : cur);
        i++;
      }
      hd.body = bodyLines.length ? bodyLines.join('\n') + '\n' : '';
    }
  }

  return { commandText: outLines.join('\n'), heredocs: heredocs };
}

function splitTopLevel(text, opts, onTopChar) {
  const stack = [];
  let cur = '';
  let escaped = false;
  const joinCont = Boolean(opts && opts.joinContinuations);

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const mode = stack.length ? stack[stack.length - 1] : null;

    if (mode === "'") {
      cur += ch;
      if (ch === "'") stack.pop();
      continue;
    }
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (mode === null && joinCont && text[i + 1] === '\n') {
        i++;
        cur += ' ';
        continue;
      }
      cur += ch;
      escaped = true;
      continue;
    }
    if (mode === '"') {
      if (ch === '"') {
        stack.pop();
        cur += ch;
      } else if (ch === '$' && text[i + 1] === '(') {
        stack.push('$(');
        cur += '$(';
        i++;
      } else if (ch === '`') {
        stack.push('`');
        cur += ch;
      } else {
        cur += ch;
      }
      continue;
    }
    if (mode === '`') {
      cur += ch;
      if (ch === '`') stack.pop();
      else if (ch === '"') stack.push('"');
      else if (ch === "'") stack.push("'");
      continue;
    }
    if (ch === "'") {
      stack.push("'");
      cur += ch;
    } else if (ch === '"') {
      stack.push('"');
      cur += ch;
    } else if (ch === '`') {
      stack.push('`');
      cur += ch;
    } else if (ch === '$' && text[i + 1] === '(') {
      stack.push('$(');
      cur += '$(';
      i++;
    } else if (ch === '(') {
      stack.push('(');
      cur += ch;
    } else if (ch === ')' && (mode === '$(' || mode === '(')) {
      stack.pop();
      cur += ch;
    } else if (stack.length === 0) {
      const sep = onTopChar(text, i, ch);
      if (sep) {
        cur = sep.push(cur);
        i += sep.advance - 1;
        continue;
      }
      cur += ch;
    } else {
      cur += ch;
    }
  }
  return cur;
}

function splitShellStatements(commandText) {
  const statements = [];
  const rem = splitTopLevel(commandText, { joinContinuations: true }, function (text, i, ch) {
    let op = null;
    let advance = 0;
    if (ch === ';' || ch === '\n') {
      op = ch;
      advance = 1;
    } else if (ch === '&' && text[i + 1] === '&') {
      op = '&&';
      advance = 2;
    } else if (ch === '|' && text[i + 1] === '|') {
      op = '||';
      advance = 2;
    }
    if (!op) return null;
    return {
      advance: advance,
      push: function (cur) {
        const trimmed = cur.trim();
        if (trimmed) statements.push({ text: trimmed, op: op });
        return '';
      },
    };
  });
  const tail = rem.trim();
  if (tail) statements.push({ text: tail, op: null });
  return statements;
}

function splitPipeline(stmtText) {
  const stages = [];
  const rem = splitTopLevel(stmtText, null, function (text, i, ch) {
    if (ch === '|' && text[i + 1] !== '|' && text[i - 1] !== '>') {
      return {
        advance: 1,
        push: function (cur) {
          const trimmed = cur.trim();
          if (trimmed) stages.push(trimmed);
          return '';
        },
      };
    }
    return null;
  });
  const tail = rem.trim();
  if (tail) stages.push(tail);
  return stages;
}

function tokenizeStage(stageText) {
  const tokens = [];
  let i = 0;
  const n = stageText.length;

  while (i < n) {
    while (i < n && /\s/.test(stageText[i])) i++;
    if (i >= n) break;

    // Check unquoted output redirect operators: >, >>, >|, 1>, 1>>, 1>|, &>, &>>, &>|, 2>, 2>>
    const rest = stageText.slice(i);
    const rMatch = rest.match(/^(?:[012&]?>>\|?|[012&]?>\|?)/);
    if (rMatch) {
      const op = rMatch[0];
      // Do not consume bare digits unless followed by `>` (regex guarantees `>` is present)
      i += op.length;
      if (stageText[i] === '&') {
        // fd duplication like `>&2` or `2>&1` or `>&-`
        let j = i + 1;
        while (j < n && /[0-9-]/.test(stageText[j])) j++;
        tokens.push({ type: 'fddup', value: op + stageText.slice(i, j) });
        i = j;
      } else {
        tokens.push({ type: 'redir', op: op });
      }
      continue;
    }
    if (stageText[i] === '<') {
      let j = i + 1;
      while (j < n && stageText[j] === '<') j++;
      tokens.push({ type: 'inredir', op: stageText.slice(i, j) });
      i = j;
      continue;
    }

    let val = '';
    let dynamic = false;
    let quoted = false;
    while (i < n && !/[\s<>|;&]/.test(stageText[i])) {
      const ch = stageText[i];
      if (ch === "'") {
        quoted = true;
        i++;
        while (i < n && stageText[i] !== "'") {
          val += stageText[i++];
        }
        if (i < n) i++;
      } else if (ch === '"') {
        quoted = true;
        i++;
        while (i < n && stageText[i] !== '"') {
          if (stageText[i] === '\\' && i + 1 < n && /["\\$`\n]/.test(stageText[i + 1])) {
            i++;
            val += stageText[i++];
          } else {
            if (stageText[i] === '$' || stageText[i] === '`') dynamic = true;
            val += stageText[i++];
          }
        }
        if (i < n) i++;
      } else if (ch === '\\' && i + 1 < n) {
        i++;
        val += stageText[i++];
      } else {
        if (ch === '$' || ch === '`' || ch === '*' || ch === '?') dynamic = true;
        if (ch === '~' && val === '') dynamic = false; // tilde at start is expanded safely
        val += ch;
        i++;
      }
    }

    const hdMatch = !quoted && /^«HD(\d+)»$/.exec(val);
    if (hdMatch) {
      tokens.push({ type: 'heredoc', id: Number(hdMatch[1]) });
    } else if (val !== '' || quoted) {
      tokens.push({ type: 'word', value: val, dynamic: dynamic, quoted: quoted });
    }
  }
  return tokens;
}

function isIgnoredTarget(target, dynamic) {
  if (dynamic) return false;
  if (!target) return true;
  if (SPECIAL_DEVICES.has(target) || target.startsWith('/dev/fd/')) return true;
  if (/^&\d+$/.test(target) || target === '&-') return true;
  return false;
}

function stripCommandPrelude(words) {
  let idx = 0;
  while (idx < words.length) {
    const w = words[idx];
    if (!w.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.value)) {
      idx++;
      continue;
    }
    const base = path.basename(w.value);
    if (!w.quoted && SHELL_PRELUDE.has(base)) {
      idx++;
      if (base === 'env' || base === 'sudo' || base === 'time') {
        while (idx < words.length && words[idx].value.startsWith('-') && words[idx].value !== '--') {
          const flag = words[idx].value;
          idx++;
          if ((base === 'env' && flag === '-u') || (base === 'sudo' && flag === '-u')) idx++;
        }
      }
      continue;
    }
    break;
  }
  return words.slice(idx);
}

function extractInlineArg(args, heredocs, stageHeredocs, flags) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (flags.includes(a.value) && i + 1 < args.length) {
      return args[i + 1].value;
    }
    for (const f of flags) {
      if (f.startsWith('--') && a.value.startsWith(f + '=')) {
        return a.value.slice(f.length + 1);
      }
    }
  }
  if (stageHeredocs.length > 0) {
    const hd = heredocs[stageHeredocs[0]];
    return hd ? hd.body : null;
  }
  return null;
}

function splitCallArgs(code, openParenIdx) {
  const args = [];
  let depth = 0;
  let quote = null;
  let escaped = false;
  let start = openParenIdx + 1;

  for (let i = openParenIdx + 1; i < code.length; i++) {
    const ch = code[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0 && ch === ')') {
        const last = code.slice(start, i).trim();
        if (last) args.push(last);
        return { args: args, endIdx: i };
      }
      if (depth > 0) depth--;
    } else if (ch === ',' && depth === 0) {
      args.push(code.slice(start, i).trim());
      start = i + 1;
    }
  }
  return null;
}

function parsePyOrNodePathArg(rawExpr) {
  const s = String(rawExpr || '').trim();
  if (!s) return { rawTarget: null, dynamic: true };
  // String literal: '...' or "..." without f-prefix / interpolation
  const m = s.match(/^(['"])([^'"\\]*(?:\\.[^'"\\]*)*)\1$/);
  if (m) return { rawTarget: m[2], dynamic: false };
  const tmpl = s.match(/^`([^`$\\]*)`$/);
  if (tmpl) return { rawTarget: tmpl[1], dynamic: false };
  return { rawTarget: null, dynamic: true };
}

function extractPythonWrites(code) {
  const out = [];
  const seen = new Set();
  function add(rawTarget, dynamic) {
    const key = (dynamic ? '*' : '') + String(rawTarget || '');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ rawTarget: rawTarget, dynamic: dynamic });
  }

  // open(path, mode) or io.open(path, mode)
  const openRe = /\b(?:io\.)?open\s*\(/g;
  let m;
  while ((m = openRe.exec(code)) !== null) {
    const parsed = splitCallArgs(code, m.index + m[0].length - 1);
    if (!parsed || parsed.args.length < 2) continue; // open(path) alone defaults to read-only 'r'
    let modeVal = null;
    for (let k = 1; k < parsed.args.length; k++) {
      const p = parsed.args[k];
      const kw = /^mode\s*=\s*(['"])([^'"]+)\1/.exec(p);
      if (kw) {
        modeVal = kw[2];
        break;
      }
      if (k === 1 && !/=/.test(p)) {
        const lit = /^(['"])([^'"]+)\1$/.exec(p);
        if (lit) modeVal = lit[2];
      }
    }
    if (modeVal && /[wax+]/.test(modeVal)) {
      const t = parsePyOrNodePathArg(parsed.args[0]);
      add(t.rawTarget, t.dynamic);
    }
  }

  // Path(path).write_text / .write_bytes
  const pathRe = /\b(?:pathlib\.)?Path\s*\(/g;
  while ((m = pathRe.exec(code)) !== null) {
    const parsed = splitCallArgs(code, m.index + m[0].length - 1);
    if (!parsed || !parsed.args.length) continue;
    if (/^\s*\.\s*write_(?:text|bytes)\s*\(/.test(code.slice(parsed.endIdx + 1))) {
      const t = parsePyOrNodePathArg(parsed.args[0]);
      add(t.rawTarget, t.dynamic);
    }
  }
  if (out.length === 0 && /\.write_(?:text|bytes)\s*\(/.test(code)) {
    add(null, true);
  }

  // shutil.copy / copy2 / copyfile / move
  const shutilRe = /\bshutil\.(?:copy2?|copyfile|move)\s*\(/g;
  while ((m = shutilRe.exec(code)) !== null) {
    const parsed = splitCallArgs(code, m.index + m[0].length - 1);
    if (!parsed || parsed.args.length < 2) continue;
    const t = parsePyOrNodePathArg(parsed.args[1]);
    add(t.rawTarget, t.dynamic);
  }

  return out;
}

function extractNodeWrites(code) {
  const out = [];
  const seen = new Set();
  function add(rawTarget, dynamic) {
    const key = (dynamic ? '*' : '') + String(rawTarget || '');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ rawTarget: rawTarget, dynamic: dynamic });
  }

  const arg1Re = /\b(?:(?:writeFile|appendFile)(?:Sync)?|createWriteStream|Deno\.write(?:Text)?File(?:Sync)?|Bun\.write)\s*\(/g;
  let m;
  while ((m = arg1Re.exec(code)) !== null) {
    const parsed = splitCallArgs(code, m.index + m[0].length - 1);
    if (!parsed || !parsed.args.length) continue;
    const t = parsePyOrNodePathArg(parsed.args[0]);
    add(t.rawTarget, t.dynamic);
  }

  const arg2Re = /\b(?:copyFile|cp|rename)(?:Sync)?\s*\(/g;
  while ((m = arg2Re.exec(code)) !== null) {
    const parsed = splitCallArgs(code, m.index + m[0].length - 1);
    if (!parsed || parsed.args.length < 2) continue;
    const t = parsePyOrNodePathArg(parsed.args[1]);
    add(t.rawTarget, t.dynamic);
  }

  return out;
}

function extractSedTargets(args) {
  let hasInPlace = false;
  let hasExplicitScript = false;
  let stopFlags = false;
  const positionals = [];

  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    const v = tok.value;
    if (!stopFlags && v === '--') {
      stopFlags = true;
      continue;
    }
    if (!stopFlags && v.startsWith('-') && v.length > 1) {
      if (v === '-i' || v === '--in-place') {
        hasInPlace = true;
        if (v === '-i' && i + 1 < args.length) {
          const next = args[i + 1];
          // macOS `sed -i '' 's/a/b/' file` or `sed -i .bak 's/a/b/' file`
          if (next.value === '' || /^\.[A-Za-z0-9_~-]+$/.test(next.value)) {
            i++;
          }
        }
        continue;
      }
      if (v.startsWith('-i') || v.startsWith('--in-place=')) {
        hasInPlace = true;
        continue;
      }
      if (v === '-e' || v === '-f' || v === '--expression' || v === '--file') {
        hasExplicitScript = true;
        i++;
        continue;
      }
      if (v.startsWith('-e') || v.startsWith('-f') || v.startsWith('--expression=') || v.startsWith('--file=')) {
        hasExplicitScript = true;
        continue;
      }
      if (/^-[A-Za-z]*i/.test(v)) hasInPlace = true;
      if (/^-[A-Za-z]*[ef]/.test(v)) hasExplicitScript = true;
      continue;
    }
    positionals.push(tok);
  }

  if (!hasInPlace) return [];
  if (hasExplicitScript) return positionals;
  return positionals.slice(1);
}

function extractTeeTargets(args) {
  let isAppend = false;
  let stopFlags = false;
  const targets = [];
  for (const tok of args) {
    const v = tok.value;
    if (!stopFlags && v === '--') {
      stopFlags = true;
      continue;
    }
    if (!stopFlags && v.startsWith('-') && v.length > 1) {
      if (v === '--append' || (v.startsWith('-') && !v.startsWith('--') && v.includes('a'))) {
        isAppend = true;
      }
      continue;
    }
    if (!tok.quoted && v === '-') continue;
    targets.push(tok);
  }
  return { isAppend: isAppend, targets: targets };
}

function isPureHeredocProducer(cmdArgs, stageHeredocs) {
  if (!stageHeredocs.length) return false;
  if (cmdArgs.length === 0) return true;
  const cmd = path.basename(cmdArgs[0].value);
  if (cmd !== 'cat') return false;
  return cmdArgs.slice(1).every((a) => !a.quoted && (a.value === '-' || a.value === '-u'));
}

function resolveBashPath(rawTarget, effectiveCwd, dynamic, homeDir) {
  if (dynamic || !rawTarget) return UNRESOLVED_PATH;
  const expanded = expandHome(rawTarget, homeDir);
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  if (effectiveCwd) return path.resolve(effectiveCwd, expanded);
  return UNRESOLVED_PATH;
}

function classifyBash(command, initialCwd, homeDir) {
  const fullCmd = String(command || '');
  if (!fullCmd.trim()) return [];
  const { commandText, heredocs } = extractHeredocs(fullCmd);
  const statements = splitShellStatements(commandText);
  const results = [];
  let effectiveCwd = initialCwd || null;

  for (const stmt of statements) {
    const stages = splitPipeline(stmt.text);
    let pipedHeredoc = null;

    for (let si = 0; si < stages.length; si++) {
      const stageInputHeredoc = pipedHeredoc;
      pipedHeredoc = null;
      const tokens = tokenizeStage(stages[si]);
      const words = [];
      const redirects = [];
      const stageHeredocs = [];

      for (let ti = 0; ti < tokens.length; ti++) {
        const tok = tokens[ti];
        if (tok.type === 'redir') {
          const next = tokens[ti + 1];
          if (next && next.type === 'word') {
            redirects.push({ op: tok.op, target: next.value, dynamic: next.dynamic });
            ti++;
          }
        } else if (tok.type === 'inredir') {
          if (tokens[ti + 1] && tokens[ti + 1].type === 'word') ti++;
        } else if (tok.type === 'fddup') {
          continue;
        } else if (tok.type === 'heredoc') {
          stageHeredocs.push(tok.id);
        } else if (tok.type === 'word') {
          words.push(tok);
        }
      }

      const cmdWords = stripCommandPrelude(words);
      const cmdName = cmdWords.length ? path.basename(cmdWords[0].value) : '';
      const args = cmdWords.slice(1);

      // Update working directory tracking across `cd` statements
      if (cmdName === 'cd' && stages.length === 1 && redirects.length === 0) {
        const dest = args.find((a) => a.value !== '--');
        if (!dest || dest.dynamic || dest.value === '-') {
          effectiveCwd = null;
        } else {
          effectiveCwd = resolveBashPath(dest.value, effectiveCwd, false, homeDir);
        }
        continue;
      }

      // 1. Output redirects (>, >>, >|, 1>, 1>>, &>, &>>)
      const pureLocalHeredoc = isPureHeredocProducer(cmdWords, stageHeredocs)
        ? heredocs[stageHeredocs[0]]
        : null;
      const upstreamHeredoc = pureLocalHeredoc || (cmdWords.length === 0 && stageInputHeredoc ? stageInputHeredoc : null);

      for (const redir of redirects) {
        if (redir.op.startsWith('2>')) continue; // stderr redirection is log/suppression, not a file write
        if (isIgnoredTarget(redir.target, redir.dynamic)) continue;
        const isAppend = redir.op.includes('>>');
        const resolved = resolveBashPath(redir.target, effectiveCwd, redir.dynamic, homeDir);
        if (upstreamHeredoc) {
          results.push({
            targetPath: resolved,
            kind: isAppend ? 'append' : 'write',
            replayable: true,
            content: upstreamHeredoc.body,
          });
        } else {
          results.push({
            targetPath: resolved,
            kind: isAppend ? 'append-cmd' : 'redirect',
            replayable: false,
            content: fullCmd,
          });
        }
      }

      // 2. `tee`
      if (cmdName === 'tee') {
        const tee = extractTeeTargets(args);
        const teeHd = stageHeredocs.length ? heredocs[stageHeredocs[0]] : stageInputHeredoc;
        for (const t of tee.targets) {
          if (isIgnoredTarget(t.value, t.dynamic)) continue;
          const resolved = resolveBashPath(t.value, effectiveCwd, t.dynamic, homeDir);
          if (teeHd) {
            results.push({
              targetPath: resolved,
              kind: tee.isAppend ? 'append' : 'write',
              replayable: true,
              content: teeHd.body,
            });
          } else {
            results.push({
              targetPath: resolved,
              kind: 'tee',
              replayable: false,
              content: fullCmd,
            });
          }
        }
      }

      // 3. `sed -i` / `gsed -i`
      if (SED_CMD_RE.test(cmdName)) {
        for (const t of extractSedTargets(args)) {
          if (isIgnoredTarget(t.value, t.dynamic)) continue;
          results.push({
            targetPath: resolveBashPath(t.value, effectiveCwd, t.dynamic, homeDir),
            kind: 'sed',
            replayable: false,
            content: fullCmd,
          });
        }
      }

      // 4. `python -c` / heredoc
      if (PY_CMD_RE.test(cmdName)) {
        const code = extractInlineArg(args, heredocs, stageHeredocs, ['-c']);
        if (code) {
          for (const w of extractPythonWrites(code)) {
            if (isIgnoredTarget(w.rawTarget, w.dynamic)) continue;
            results.push({
              targetPath: resolveBashPath(w.rawTarget, effectiveCwd, w.dynamic, homeDir),
              kind: 'python',
              replayable: false,
              content: fullCmd,
            });
          }
        }
      }

      // 5. `node -e` / `bun -e` / `deno -e` / heredoc
      if (JS_CMD_RE.test(cmdName)) {
        const code = extractInlineArg(args, heredocs, stageHeredocs, ['-e', '--eval', '-p', '--print']);
        if (code) {
          for (const w of extractNodeWrites(code)) {
            if (isIgnoredTarget(w.rawTarget, w.dynamic)) continue;
            results.push({
              targetPath: resolveBashPath(w.rawTarget, effectiveCwd, w.dynamic, homeDir),
              kind: 'node',
              replayable: false,
              content: fullCmd,
            });
          }
        }
      }

      // Carry pure heredoc output forward to the next pipeline stage
      pipedHeredoc = redirects.length === 0 && pureLocalHeredoc ? pureLocalHeredoc : null;
    }
  }
  return results;
}

// ---- line extractor ------------------------------------------------------------------------

function resolveToolPath(rawTarget, cwd, homeDir) {
  if (!rawTarget || typeof rawTarget !== 'string') return UNRESOLVED_PATH;
  const trimmed = rawTarget.trim();
  if (!trimmed) return UNRESOLVED_PATH;
  const expanded = expandHome(trimmed, homeDir);
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  if (cwd) return path.resolve(cwd, expanded);
  return UNRESOLVED_PATH;
}

function eventIdOf(srcPath, toolId, idx) {
  const input = idx === 0 ? srcPath + '\0' + toolId : srcPath + '\0' + toolId + '\0' + idx;
  return crypto.createHash('sha1').update(input).digest('hex');
}

function extractLine(line, lineByteOffset, src, state, homeDir) {
  if (!line || !line.trim()) return [];
  let j;
  try {
    j = JSON.parse(line);
  } catch {
    return [];
  }
  if (!j || typeof j !== 'object') return [];
  if (typeof j.cwd === 'string' && j.cwd.trim()) state.cwd = j.cwd.trim();
  if (typeof j.sessionId === 'string' && j.sessionId.trim()) state.sessionId = j.sessionId.trim();
  if (typeof j.agentId === 'string' && j.agentId.trim()) state.agentId = j.agentId.trim();

  const msg = j.message;
  if (!msg || typeof msg !== 'object') return [];
  const isAssistant = j.type === 'assistant' || msg.role === 'assistant';
  if (!isAssistant || !Array.isArray(msg.content)) return [];

  const ts = typeof j.timestamp === 'string' ? j.timestamp : null;
  const extracted = [];

  for (let bi = 0; bi < msg.content.length; bi++) {
    const b = msg.content[bi];
    if (!b || typeof b !== 'object' || b.type !== 'tool_use' || !b.input || typeof b.input !== 'object') continue;
    if (!WRITE_TOOLS.has(b.name)) continue;

    const toolId = typeof b.id === 'string' && b.id ? b.id : 'off:' + lineByteOffset + ':' + bi;
    const inp = b.input;
    const items = [];

    if (b.name === 'Write') {
      const targetPath = resolveToolPath(inp.file_path || inp.path, state.cwd, homeDir);
      items.push({
        targetPath: targetPath,
        kind: 'write',
        replayable: true,
        content: inp.content == null ? '' : String(inp.content),
      });
    } else if (b.name === 'Edit') {
      const targetPath = resolveToolPath(inp.file_path || inp.path, state.cwd, homeDir);
      items.push({
        targetPath: targetPath,
        kind: 'edit',
        replayable: true,
        oldString: inp.old_string == null ? '' : String(inp.old_string),
        content: inp.new_string == null ? '' : String(inp.new_string),
        replaceAll: Boolean(inp.replace_all),
      });
    } else if (b.name === 'MultiEdit') {
      const targetPath = resolveToolPath(inp.file_path || inp.path, state.cwd, homeDir);
      const rawEdits = Array.isArray(inp.edits) ? inp.edits : [];
      if (rawEdits.length > 0) {
        items.push({
          targetPath: targetPath,
          kind: 'multiedit',
          replayable: true,
          edits: rawEdits.map((ed) => ({
            oldString: ed && ed.old_string != null ? String(ed.old_string) : '',
            newString: ed && ed.new_string != null ? String(ed.new_string) : '',
            replaceAll: Boolean(ed && ed.replace_all),
          })),
        });
      }
    } else if (b.name === 'NotebookEdit') {
      const targetPath = resolveToolPath(inp.notebook_path || inp.file_path || inp.path, state.cwd, homeDir);
      items.push({
        targetPath: targetPath,
        kind: 'notebook-edit',
        replayable: false,
        content: inp.new_source == null ? '' : String(inp.new_source),
      });
    } else if (b.name === 'Bash') {
      const writes = classifyBash(inp.command, state.cwd, homeDir);
      for (const w of writes) items.push(w);
    }

    for (let wi = 0; wi < items.length; wi++) {
      const item = items[wi];
      extracted.push(
        Object.assign(
          {
            id: eventIdOf(src.path, toolId, wi),
            ts: ts,
            seq: lineByteOffset * 1000 + bi * 10 + wi,
            session: state.sessionId || src.sessionId,
            subagent: Boolean(src.subagent),
            agent: src.subagent ? state.agentId || src.agentId || 'subagent' : null,
            source: src.path,
            projectKey: src.projectKey,
            cwd: state.cwd || null,
            tool: b.name,
          },
          item,
        ),
      );
    }
  }
  return extracted;
}

// ---- store persistence & blob materialization ----------------------------------------------

function storeBlob(ctx, masked, blobsWritten) {
  const file = blobPath(ctx, masked.hash);
  if (!blobsWritten.has(masked.hash) && !fs.existsSync(file)) {
    fsutil.atomicWrite(file, masked.text, 0o600);
    blobsWritten.add(masked.hash);
  }
}

function materializeEvent(ctx, raw, blobsWritten) {
  const secretFile = isSecretTarget(raw.targetPath);
  const base = {
    id: raw.id,
    ts: raw.ts,
    seq: raw.seq,
    path: raw.targetPath,
    session: raw.session,
    subagent: raw.subagent,
    agent: raw.agent,
    source: raw.source,
    cwd: raw.cwd,
    tool: raw.tool,
    kind: raw.kind,
    replayable: Boolean(raw.replayable),
    secretFile: secretFile,
  };

  if (secretFile) {
    return Object.assign(base, {
      blob: null,
      bytes: 0,
      rawBytes: Buffer.byteLength(raw.content || '', 'utf8'),
      lines: countBufferLines(Buffer.from(raw.content || '', 'utf8')),
      redacted: 0,
      secretKinds: [],
      truncated: false,
      truncatedBytes: 0,
    });
  }

  if (raw.kind === 'multiedit') {
    const edits = [];
    let totalRedacted = 0;
    let anyTruncated = false;
    let totalTruncatedBytes = 0;
    const kinds = new Set();
    const combinedNew = [];

    for (const ed of raw.edits || []) {
      const oldM = maskAndCap(ed.oldString);
      const newM = maskAndCap(ed.newString);
      storeBlob(ctx, oldM, blobsWritten);
      storeBlob(ctx, newM, blobsWritten);
      combinedNew.push(ed.newString);
      totalRedacted += oldM.redacted + newM.redacted;
      if (oldM.truncated || newM.truncated) anyTruncated = true;
      totalTruncatedBytes += oldM.truncatedBytes + newM.truncatedBytes;
      oldM.secretKinds.forEach((k) => kinds.add(k));
      newM.secretKinds.forEach((k) => kinds.add(k));
      edits.push({
        oldBlob: oldM.hash,
        oldBytes: oldM.bytes,
        oldLines: oldM.lines,
        blob: newM.hash,
        bytes: newM.bytes,
        lines: newM.lines,
        replaceAll: Boolean(ed.replaceAll),
        truncated: newM.truncated,
        truncatedBytes: newM.truncatedBytes,
      });
    }
    const joinedM = maskAndCap(combinedNew.join('\n'));
    storeBlob(ctx, joinedM, blobsWritten);
    return Object.assign(base, {
      blob: joinedM.hash,
      bytes: joinedM.bytes,
      rawBytes: joinedM.rawBytes,
      lines: joinedM.lines,
      edits: edits,
      redacted: totalRedacted,
      secretKinds: Array.from(kinds).sort(),
      truncated: anyTruncated,
      truncatedBytes: totalTruncatedBytes,
    });
  }

  const mainM = maskAndCap(raw.content);
  storeBlob(ctx, mainM, blobsWritten);
  const out = Object.assign(base, {
    blob: mainM.hash,
    bytes: mainM.bytes,
    rawBytes: mainM.rawBytes,
    lines: mainM.lines,
    redacted: mainM.redacted,
    secretKinds: mainM.secretKinds,
    truncated: mainM.truncated,
    truncatedBytes: mainM.truncatedBytes,
  });

  if (raw.kind === 'edit') {
    const oldM = maskAndCap(raw.oldString);
    storeBlob(ctx, oldM, blobsWritten);
    out.oldBlob = oldM.hash;
    out.oldBytes = oldM.bytes;
    out.oldLines = oldM.lines;
    out.replaceAll = Boolean(raw.replaceAll);
    out.redacted += oldM.redacted;
    if (oldM.truncated) {
      out.truncated = true;
      out.truncatedBytes += oldM.truncatedBytes;
    }
    if (oldM.secretKinds.length) {
      const merged = new Set([...out.secretKinds, ...oldM.secretKinds]);
      out.secretKinds = Array.from(merged).sort();
    }
  }
  return out;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function compareEvents(a, b) {
  const ta = a.ts || '';
  const tb = b.ts || '';
  if (ta < tb) return -1;
  if (ta > tb) return 1;
  const sa = typeof a.seq === 'number' ? a.seq : 0;
  const sb = typeof b.seq === 'number' ? b.seq : 0;
  if (sa !== sb) return sa - sb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function readEventFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev && ev.id) out.push(ev);
    } catch {
      /* ignore torn line */
    }
  }
  out.sort(compareEvents);
  return out;
}

function measureStore(ctx) {
  const root = dirOf(ctx);
  const bDir = blobsDir(ctx);
  let totalBytes = 0;
  let totalBlobs = 0;

  function walk(dir, underBlobs) {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p, underBlobs || p === bDir);
      } else if (ent.isFile()) {
        if (ent.name === 'writes.lock' || ent.name.includes('.tmp-') || ent.name.includes('.reclaim-')) continue;
        try {
          totalBytes += fs.statSync(p).size;
          if (underBlobs) totalBlobs++;
        } catch {
          /* ignore */
        }
      }
    }
  }

  walk(root, false);
  return { totalBytes: totalBytes, totalBlobs: totalBlobs };
}

// ---- build ---------------------------------------------------------------------------------

function build(ctx, opts) {
  opts = opts || {};
  const homeDir = homeOf(ctx);
  const excludes = excludeList(ctx, opts);
  const warnLimit = opts.warnBytes > 0 ? Number(opts.warnBytes) : WARN_BYTES;

  const lockRes = withWriteLock(ctx, opts, function () {
    const prevState = readJsonSafe(statePath(ctx));
    const prevSources = prevState && prevState.sources && typeof prevState.sources === 'object' ? prevState.sources : {};
    const pathsDoc = readJsonSafe(pathsFile(ctx));
    const pathsMap =
      pathsDoc && pathsDoc.paths && typeof pathsDoc.paths === 'object' ? pathsDoc.paths : Object.create(null);

    const sources = discoverSources(ctx, excludes);
    const nextSources = Object.create(null);
    const pendingByPath = new Map();
    const blobsWritten = new Set();
    const warnings = [];
    const errors = [];

    let indexed = 0;
    let reused = 0;
    let appended = 0;
    let eventsAdded = 0;

    for (let si = 0; si < sources.length; si++) {
      const src = sources[si];
      if (opts.onProgress) opts.onProgress({ phase: 'writes', done: si + 1, total: sources.length, id: src.path });
      const prev = prevSources[src.path];

      if (!opts.force && prev && prev.offset === src.size && prev.mtimeMs === src.mtimeMs) {
        reused++;
        nextSources[src.path] = prev;
        continue;
      }

      const prevLen = prev && typeof prev.headHashLen === 'number' ? prev.headHashLen : 0;
      const prefixHead =
        !opts.force && prev && typeof prev.offset === 'number' && prev.offset > 0 && src.size >= prev.offset && prevLen > 0
          ? computeHeadHash(src.path, prevLen)
          : null;
      const canResume = Boolean(
        prefixHead && prefixHead.len === prevLen && prev.headHash && prefixHead.hash === prev.headHash,
      );

      const startOffset = canResume ? prev.offset : 0;
      const parserState = {
        cwd: canResume ? prev.cwd || null : null,
        sessionId: canResume ? prev.sessionId || src.sessionId : src.sessionId,
        agentId: canResume ? prev.agentId || src.agentId : src.agentId,
      };

      if (canResume) appended++;
      else indexed++;

      try {
        const scanRes = scanJsonlFromOffset(src.path, startOffset, function (line, byteOff) {
          const rawEvents = extractLine(line, byteOff, src, parserState, homeDir);
          for (const raw of rawEvents) {
            if (isExcludedProject(excludes, { projectKey: src.projectKey, cwd: raw.cwd, targetPath: raw.targetPath })) {
              continue;
            }
            const ev = materializeEvent(ctx, raw, blobsWritten);
            let list = pendingByPath.get(ev.path);
            if (!list) {
              list = [];
              pendingByPath.set(ev.path, list);
            }
            list.push(ev);
          }
        });

        if (scanRes.oversized > 0) {
          warnings.push('skipped ' + scanRes.oversized + ' oversized line(s) in ' + path.basename(src.path));
        }

        const nextHeadLen = Math.min(scanRes.offset, HEAD_HASH_BYTES);
        const nextHead =
          nextHeadLen <= 0
            ? null
            : canResume && prevLen === HEAD_HASH_BYTES
              ? { hash: prev.headHash, len: prevLen }
              : computeHeadHash(src.path, nextHeadLen);

        nextSources[src.path] = {
          offset: scanRes.offset,
          size: src.size,
          mtimeMs: src.mtimeMs,
          headHash: nextHead ? nextHead.hash : null,
          headHashLen: nextHead ? nextHead.len : 0,
          cwd: parserState.cwd,
          sessionId: parserState.sessionId,
          agentId: parserState.agentId,
          subagent: src.subagent,
          projectKey: src.projectKey,
        };
      } catch (e) {
        errors.push({ path: src.path, error: (e && e.message) || String(e) });
        if (prev) nextSources[src.path] = prev;
      }
    }

    let pathsDirty = false;
    for (const [targetPath, newEvents] of pendingByPath.entries()) {
      const destFile = eventPath(ctx, targetPath);
      const existing = readEventFile(destFile);
      const byId = new Map();
      for (const ev of existing) byId.set(ev.id, ev);

      let addedHere = 0;
      let changedHere = false;
      for (const ev of newEvents) {
        if (!byId.has(ev.id)) {
          addedHere++;
          changedHere = true;
          byId.set(ev.id, ev);
        } else {
          const prevJson = JSON.stringify(byId.get(ev.id));
          const nextJson = JSON.stringify(ev);
          if (prevJson !== nextJson) {
            changedHere = true;
            byId.set(ev.id, ev);
          }
        }
      }

      if (changedHere || !fs.existsSync(destFile)) {
        const merged = Array.from(byId.values()).sort(compareEvents);
        const body = merged.map((e) => JSON.stringify(e)).join('\n') + '\n';
        fsutil.atomicWrite(destFile, body, 0o600);
        eventsAdded += addedHere;

        const firstTs = merged.find((e) => e.ts)?.ts || null;
        let lastTs = null;
        for (let i = merged.length - 1; i >= 0; i--) {
          if (merged[i].ts) {
            lastTs = merged[i].ts;
            break;
          }
        }
        pathsMap[targetPath] = {
          key: keyOf(targetPath),
          path: targetPath,
          events: merged.length,
          firstTs: firstTs,
          lastTs: lastTs,
          secretFile: merged.some((e) => e.secretFile === true),
        };
        pathsDirty = true;
      }
    }

    if (pathsDirty || !fs.existsSync(pathsFile(ctx))) {
      fsutil.writeJsonStable(pathsFile(ctx), { schemaVersion: SCHEMA_VERSION, paths: pathsMap }, 0o600);
    }

    const totalPaths = Object.keys(pathsMap).length;
    let totalEvents = 0;
    for (const k of Object.keys(pathsMap)) totalEvents += pathsMap[k].events || 0;
    const disk = measureStore(ctx);

    if (disk.totalBytes >= warnLimit) {
      warnings.push(
        'conv-index/writes size (' + disk.totalBytes + ' bytes) reached the 2 GB manual-prune warning threshold',
      );
    }

    const builtAt = (ctx.now && ctx.now()) || new Date().toISOString();
    const stateDoc = {
      schemaVersion: SCHEMA_VERSION,
      builtAt: builtAt,
      stats: {
        sources: Object.keys(nextSources).length,
        paths: totalPaths,
        events: totalEvents,
        blobs: disk.totalBlobs,
        bytes: disk.totalBytes,
      },
      sources: nextSources,
    };
    fsutil.atomicWrite(statePath(ctx), JSON.stringify(stateDoc, null, 2) + '\n', 0o600);

    return {
      ok: errors.length === 0,
      builtAt: builtAt,
      sources: sources.length,
      indexed: indexed,
      reused: reused,
      appended: appended,
      eventsAdded: eventsAdded,
      totalPaths: totalPaths,
      totalEvents: totalEvents,
      totalBlobs: disk.totalBlobs,
      totalBytes: disk.totalBytes,
      overWarnLimit: disk.totalBytes >= warnLimit,
      warnings: warnings,
      errors: errors,
    };
  });

  if (!lockRes.acquired) {
    return {
      ok: false,
      busy: true,
      sources: 0,
      indexed: 0,
      reused: 0,
      appended: 0,
      eventsAdded: 0,
      totalPaths: 0,
      totalEvents: 0,
      totalBlobs: 0,
      totalBytes: 0,
      overWarnLimit: false,
      warnings: ['writes index update skipped (writes.lock busy)'],
      errors: [],
    };
  }
  return lockRes.value;
}

// ---- read-only store API (for tests and slices D2/D3) --------------------------------------

function listPaths(ctx) {
  const doc = readJsonSafe(pathsFile(ctx));
  if (!doc || !doc.paths || typeof doc.paths !== 'object') return [];
  return Object.keys(doc.paths)
    .map((k) => doc.paths[k])
    .filter((row) => row && typeof row.path === 'string')
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function resolveTargetKey(ctx, queryPath) {
  const q = String(queryPath || '').trim();
  if (!q) return null;
  const rows = listPaths(ctx);
  const normQ = path.normalize(q);
  for (const r of rows) {
    if (r.path === q || r.path === normQ) return r;
  }
  const suffix = rows.filter((r) => r.path.endsWith('/' + q) || r.path.endsWith(path.sep + q));
  if (suffix.length === 1) return suffix[0];
  const low = q.toLowerCase();
  const matches = rows.filter((r) => r.path.toLowerCase().includes(low));
  if (matches.length === 1) return matches[0];
  return null;
}

function readEvents(ctx, targetPath) {
  if (!targetPath) return [];
  return readEventFile(eventPath(ctx, targetPath));
}

function readAllEvents(ctx) {
  const rows = listPaths(ctx);
  const out = [];
  for (const r of rows) {
    out.push(...readEventFile(eventPath(ctx, r.path)));
  }
  out.sort(compareEvents);
  return out;
}

function readBlob(ctx, sha256) {
  const h = String(sha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) return null;
  try {
    return fs.readFileSync(blobPath(ctx, h), 'utf8');
  } catch {
    return null;
  }
}

function status(ctx, opts) {
  opts = opts || {};
  const warnBytes = opts.warnBytes > 0 ? Number(opts.warnBytes) : WARN_BYTES;
  const st = readJsonSafe(statePath(ctx));
  const enabled = isEnabled(ctx, opts);
  const dir = dirOf(ctx);
  if (!st || !fs.existsSync(dir)) {
    return {
      exists: false,
      enabled: enabled,
      dir: dir,
      builtAt: null,
      totalPaths: 0,
      totalEvents: 0,
      totalBlobs: 0,
      totalBytes: 0,
      overWarnLimit: false,
      warnBytes: warnBytes,
    };
  }
  const rows = listPaths(ctx);
  const disk = measureStore(ctx);
  let totalEvents = 0;
  for (const r of rows) totalEvents += r.events || 0;
  return {
    exists: true,
    enabled: enabled,
    dir: dir,
    builtAt: st.builtAt || null,
    totalPaths: rows.length,
    totalEvents: totalEvents,
    totalBlobs: disk.totalBlobs,
    totalBytes: disk.totalBytes,
    overWarnLimit: disk.totalBytes >= warnBytes,
    warnBytes: warnBytes,
  };
}

export {
  SCHEMA_VERSION,
  WRITES_DIR,
  UNRESOLVED_PATH,
  HEAD_BYTES,
  TAIL_BYTES,
  MAX_BODY_BYTES,
  WARN_BYTES,
  dirOf,
  eventsDir,
  blobsDir,
  pathsFile,
  statePath,
  lockPath,
  keyOf,
  eventPath,
  blobPath,
  isEnabled,
  excludeList,
  isExcludedProject,
  isSecretTarget,
  maskAndCap,
  discoverSources,
  classifyBash,
  extractLine,
  build,
  listPaths,
  resolveTargetKey,
  readEvents,
  readAllEvents,
  readBlob,
  status,
};
