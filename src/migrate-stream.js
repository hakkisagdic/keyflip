// @ts-check
// Streaming container for `keyflip migrate export/import`.
//
// The legacy bundle embedded every transcript in ONE JSON string: at ~830 MB
// JSON.stringify exhausted the heap, and encrypting it base64-encoded the whole
// ciphertext into a second giant string that hits V8's max-string limit. This
// container never materializes the transcript set:
//
//   KEYFLIP-MIGRATE-STREAM/2
//   {"format":"keyflip-migrate-stream","version":2,"encrypted":true,"salt":"…",…}
//   <record>
//   <record>
//   …
//
// A record is one JSON line. Unencrypted records carry their own fields
// ({seq,type,…}); with a passphrase each record is encrypted on its own
// ({seq,iv,tag,ct}) under one scrypt-derived key. Because the AAD is the previous
// record's tag + this record's sequence number, reordering, replay and truncation
// are all detected. The last record must be `end`; a missing one is an error.
//
// Record types:
//   meta      the small tier (accounts/providers/memory/config/agents) — no transcripts
//   tx        start of one transcript: {project, sessionId, bytes}
//   chunk     {n, data:base64} — at most `chunkSize` decoded bytes
//   tx-end    end of the current transcript
//   end       {transcripts, bytes, counts} — totals, checked on import
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { applyBundle, isSafeSegment } from './migrate.js';
import * as fsutil from './fsutil.js';
import * as sync from './sync.js';

const MAGIC = 'KEYFLIP-MIGRATE-STREAM/2';
const FORMAT = 'keyflip-migrate-stream';
const VERSION = 2;
const DEFAULT_CHUNK = 128 * 1024;
// A record line never comes close to this (<200 KB). The cap exists because a
// LEGACY bundle is one giant JSON line, and it matches LEGACY_MAX so the two
// refusal paths agree on the same limit.
const LEGACY_MAX = 256 * 1024 * 1024;
const MAX_LINE = LEGACY_MAX;

function error(message, code) {
  const e = /** @type {any} */ (new Error(message));
  e.code = code || 'MIGRATE_STREAM';
  return e;
}

function projectsDir(ctx) {
  return path.join(ctx.claudeDir || path.join(ctx.home, '.claude'), 'projects');
}

function tooLongLine(maxLine) {
  return error(
    'a bundle line is larger than ' +
      Math.round(maxLine / 1048576) +
      ' MB — this is the legacy one-string format; re-export on the source machine with a current keyflip (streaming)',
    'LEGACY_TOO_LARGE',
  );
}

// --- line reading -----------------------------------------------------------

// Turn a Node readable into an async iterator of Buffers/strings without ever
// holding more than one line. Chunks are accumulated in an array so a long line
// costs O(n) copies, not O(n²).
async function* linesOf(stream, maxLine) {
  let parts = [];
  let len = 0;
  const emit = function () {
    const line = parts.length === 1 ? parts[0] : Buffer.concat(parts, len);
    parts = [];
    len = 0;
    return line;
  };
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(10, start);
      if (nl === -1) {
        const rest = chunk.subarray(start);
        if (rest.length) {
          parts.push(rest);
          len += rest.length;
          if (len > maxLine) throw tooLongLine(maxLine);
        }
        break;
      }
      const piece = chunk.subarray(start, nl);
      parts.push(piece);
      len += piece.length;
      if (len > maxLine) throw tooLongLine(maxLine);
      let line = emit();
      if (line.length && line[line.length - 1] === 13) line = line.subarray(0, -1); // CRLF
      yield line.toString('utf8');
      start = nl + 1;
    }
  }
  if (len) {
    let line = emit();
    if (line.length && line[line.length - 1] === 13) line = line.subarray(0, -1);
    if (line.length) yield line.toString('utf8');
  }
}

// --- writing ----------------------------------------------------------------

function writeLine(stream, line) {
  return new Promise(function (resolve, reject) {
    stream.write(line, function (e) {
      if (e) reject(e);
      else resolve(undefined);
    });
  });
}

function replaceFile(tmp, out) {
  try {
    fs.renameSync(tmp, out);
  } catch (e) {
    // Windows can refuse to replace an existing file by rename; copyFile replaces.
    fs.copyFileSync(tmp, out);
    fs.rmSync(tmp, { force: true });
  }
}

// opts: { out, meta, files:[{project,sessionId,file,bytes}], passphrase, chunkSize, now }
// meta is the buildBundle() result with `bundle.transcripts` empty and
// `counts.transcripts` already set to files.length.
async function writeBundle(opts) {
  const out = opts.out;
  const passphrase = opts.passphrase || null;
  const chunkSize = Math.max(1, opts.chunkSize || DEFAULT_CHUNK);
  const files = opts.files || [];
  const meta = opts.meta;
  if (!meta || !meta.bundle) throw new Error('writeBundle needs the built metadata tier');
  const totalBytes = files.reduce(function (n, f) {
    return n + (f.bytes || 0);
  }, 0);

  const salt = passphrase ? crypto.randomBytes(16) : null;
  const key = passphrase ? crypto.scryptSync(passphrase, salt, 32) : null;
  const header = {
    format: FORMAT,
    version: VERSION,
    encrypted: !!passphrase,
    alg: passphrase ? 'aes-256-gcm' : null,
    kdf: passphrase ? 'scrypt' : null,
    salt: salt ? salt.toString('base64') : null,
    createdAt: opts.now || new Date().toISOString(),
    chunkSize: chunkSize,
    transcripts: files.length,
    bytes: totalBytes,
  };

  const tmp = out === '-' ? null : out + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  let stream;
  let fd = null;
  if (out === '-') stream = process.stdout;
  else {
    fd = fs.openSync(tmp, 'wx', 0o600);
    // The stream owns the fd (autoClose): it closes exactly once, on end or on
    // destroy, so the error path can wait for that before removing the temp file
    // (Windows refuses to unlink an open file). A late 'error' after a rejected
    // write must not crash the process; every write is surfaced through writeLine.
    stream = fs.createWriteStream(null, { fd: fd, autoClose: true });
    stream.on('error', function () {});
  }

  let seq = 0;
  let prevTag = Buffer.alloc(16);
  let exportedBytes = 0;
  const emit = async function (record) {
    record.seq = seq;
    let line;
    if (key) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const aad = Buffer.alloc(24);
      prevTag.copy(aad, 0);
      aad.writeBigUInt64BE(BigInt(seq), 16);
      cipher.setAAD(aad);
      const ct = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      line = JSON.stringify({
        seq: seq,
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        ct: ct.toString('base64'),
      });
      prevTag = tag;
    } else {
      line = JSON.stringify(record);
    }
    await writeLine(stream, line + '\n');
    seq++;
  };

  try {
    await writeLine(stream, MAGIC + '\n' + JSON.stringify(header) + '\n');
    await emit({ type: 'meta', data: meta.bundle });
    const buf = Buffer.allocUnsafe(chunkSize);
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const size = f.bytes || 0;
      await emit({ type: 'tx', project: f.project, sessionId: f.sessionId, bytes: size });
      const fh = await fs.promises.open(f.file, 'r');
      try {
        let pos = 0;
        while (pos < size) {
          const want = Math.min(buf.length, size - pos);
          const r = await fh.read(buf, 0, want, pos);
          if (!r.bytesRead) throw error('transcript changed while exporting: ' + f.file, 'CHANGED');
          await emit({ type: 'chunk', n: r.bytesRead, data: buf.subarray(0, r.bytesRead).toString('base64') });
          pos += r.bytesRead;
          exportedBytes += r.bytesRead;
        }
      } finally {
        await fh.close();
      }
      await emit({ type: 'tx-end' });
    }
    await emit({
      type: 'end',
      transcripts: files.length,
      bytes: exportedBytes,
      counts: meta.counts,
    });
    await new Promise(function (resolve, reject) {
      if (out === '-') return resolve(undefined);
      // 'close' (not the end callback) guarantees the fd is gone before the rename.
      stream.once('close', resolve);
      stream.once('error', reject);
      stream.end();
    });
    fd = null; // the stream closed it
    if (tmp) {
      try {
        fs.chmodSync(tmp, 0o600);
      } catch (e) {
        /* non-POSIX FS */
      }
      replaceFile(tmp, out);
      try {
        fs.chmodSync(out, 0o600);
      } catch (e) {
        /* non-POSIX FS */
      }
    }
  } catch (e) {
    if (out !== '-') {
      // Wait for the stream to release the fd before unlinking on Windows.
      if (!stream.closed) {
        await new Promise(function (resolve) {
          stream.once('close', resolve);
          if (!stream.destroyed) stream.destroy();
        });
      }
      fd = null;
    }
    if (tmp) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch (e2) {
        /* best effort */
      }
    }
    throw e;
  } finally {
    // A write error may have destroyed the stream without leaving a 'close'
    // listener: never keep the descriptor open past this function.
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch (e2) {
        /* already closed by the stream */
      }
    }
  }
  return { transcripts: files.length, bytes: exportedBytes, counts: meta.counts };
}

// --- importing --------------------------------------------------------------

// Writes the transcript tier directly to ~/.claude/projects. One temp file per
// session, renamed only after the tc-end record and the byte count agree.
class TranscriptSink {
  constructor(ctx, force) {
    this.ctx = ctx;
    this.root = projectsDir(ctx);
    this.force = !!force;
    this.cur = null;
    this.seen = 0;
    this.bytes = 0;
    this.seq = 0;
    this.result = { added: 0, kept: 0, overwritten: 0, skipped: 0, total: 0 };
  }

  start(rec) {
    if (this.cur) throw error('transcript record started before the previous one ended', 'STREAM_SHAPE');
    this.seen++;
    const project = rec.project;
    const sessionId = rec.sessionId;
    const bytes = rec.bytes;
    if (!isSafeSegment(project) || !isSafeSegment(sessionId) || !Number.isInteger(bytes) || bytes < 0) {
      this._skip();
      return;
    }
    const file = path.join(this.root, project, sessionId + '.jsonl');
    if (!fsutil.safeDestUnder(this.root, file).ok) {
      this._skip();
      return;
    }
    const exists = fs.existsSync(file);
    if (exists && !this.force) {
      this.result.kept++;
      this.cur = { skip: true, bytes: bytes, received: 0 };
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.kfimport-' + process.pid + '-' + this.seq++;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    this.cur = { file: file, tmp: tmp, fd: fd, bytes: bytes, received: 0, overwrite: exists };
  }

  _skip() {
    this.result.skipped++;
    this.cur = { skip: true };
  }

  chunk(rec) {
    if (!this.cur) throw error('transcript chunk without a start record', 'STREAM_SHAPE');
    let buf;
    try {
      buf = Buffer.from(String(rec.data || ''), 'base64');
    } catch (e) {
      throw error('corrupt transcript chunk', 'STREAM_DATA');
    }
    if (rec.n != null && rec.n !== buf.length) throw error('corrupt transcript chunk length', 'STREAM_DATA');
    this.cur.received += buf.length;
    this.bytes += buf.length;
    if (!this.cur.skip) fs.writeSync(this.cur.fd, buf);
    if (this.cur.bytes != null && this.cur.received > this.cur.bytes) {
      throw error('transcript chunk exceeds its declared size', 'STREAM_DATA');
    }
  }

  end() {
    if (!this.cur) throw error('transcript end without a start record', 'STREAM_SHAPE');
    const cur = this.cur;
    this.cur = null;
    if (cur.skip) return;
    try {
      if (cur.received !== cur.bytes)
        throw error('transcript is truncated (declared ' + cur.bytes + ' bytes)', 'STREAM_DATA');
      fs.closeSync(cur.fd);
      cur.fd = null;
      replaceFile(cur.tmp, cur.file);
      try {
        fs.chmodSync(cur.file, 0o600);
      } catch (e) {
        /* non-POSIX FS */
      }
      if (cur.overwrite) this.result.overwritten++;
      else this.result.added++;
    } catch (e) {
      if (cur.fd != null) {
        try {
          fs.closeSync(cur.fd);
        } catch (e2) {
          /* already closed */
        }
      }
      try {
        fs.rmSync(cur.tmp, { force: true });
      } catch (e2) {
        /* best effort */
      }
      throw e;
    }
  }

  abort() {
    if (this.cur && !this.cur.skip) {
      try {
        fs.closeSync(this.cur.fd);
      } catch (e) {
        /* already closed */
      }
      try {
        fs.rmSync(this.cur.tmp, { force: true });
      } catch (e) {
        /* best effort */
      }
    }
    this.cur = null;
  }

  finish() {
    if (this.cur) throw error('bundle ended in the middle of a transcript', 'STREAM_TRUNCATED');
    this.result.total = this.seen;
    return this.result;
  }
}

function parseJson(line, what) {
  try {
    return JSON.parse(line);
  } catch (e) {
    throw error(what + ' is not valid JSON', 'STREAM_CORRUPT');
  }
}

// Read one record, decrypting with the chained AAD when needed.
function decodeRecord(line, seq, key, prevTag) {
  const outer = parseJson(line, 'bundle record');
  if (!outer || typeof outer !== 'object') throw error('bundle record is not an object', 'STREAM_CORRUPT');
  if (key) {
    if (outer.seq !== seq) throw error('bundle record out of order (expected ' + seq + ')', 'STREAM_ORDER');
    let iv, tag, ct;
    try {
      iv = Buffer.from(String(outer.iv || ''), 'base64');
      tag = Buffer.from(String(outer.tag || ''), 'base64');
      ct = Buffer.from(String(outer.ct || ''), 'base64');
    } catch (e) {
      throw error('corrupt encrypted record', 'STREAM_CORRUPT');
    }
    if (iv.length !== 12 || tag.length !== 16) throw error('corrupt encrypted record', 'STREAM_CORRUPT');
    const aad = Buffer.alloc(24);
    prevTag.copy(aad, 0);
    aad.writeBigUInt64BE(BigInt(seq), 16);
    let plain;
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
      d.setAAD(aad);
      d.setAuthTag(tag);
      plain = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    } catch (e) {
      throw error('decryption failed — wrong passphrase or corrupt bundle', 'STREAM_CRYPTO');
    }
    const rec = parseJson(plain, 'decrypted record');
    if (!rec || typeof rec !== 'object') throw error('corrupt bundle record', 'STREAM_CORRUPT');
    if (rec.seq != null && rec.seq !== seq) throw error('bundle record out of order', 'STREAM_ORDER');
    return { rec: rec, tag: tag };
  }
  if (outer.seq !== seq) throw error('bundle record out of order (expected ' + seq + ')', 'STREAM_ORDER');
  return { rec: outer, tag: null };
}

async function readLegacy(it, firstLine, opts) {
  const pieces = [Buffer.from(firstLine + '\n', 'utf8')];
  let total = pieces[0].length;
  for (;;) {
    const n = await it.next();
    if (n.done) break;
    const b = Buffer.from(n.value + '\n', 'utf8');
    total += b.length;
    if (total > LEGACY_MAX) {
      throw error(
        'this legacy bundle is larger than ' +
          Math.round(LEGACY_MAX / 1048576) +
          ' MB and cannot be read in one string. Re-export it on the source machine with a current keyflip (streaming), or use --no-sessions plus the out-of-band transcript copy.',
        'LEGACY_TOO_LARGE',
      );
    }
    pieces.push(b);
  }
  const raw = Buffer.concat(pieces, total).toString('utf8');
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw error('that file is not a keyflip migrate bundle (invalid JSON)', 'LEGACY_JSON');
  }
  if (obj && obj.magic === 'keyflip-sync') {
    if (!opts.passphrase) throw error('this bundle is encrypted — pass --passphrase-file <file>', 'LEGACY_CRYPTO');
    let plain;
    try {
      plain = sync.decrypt(raw, opts.passphrase);
    } catch (e) {
      throw error(e.message, 'LEGACY_CRYPTO');
    }
    try {
      obj = JSON.parse(plain);
    } catch (e) {
      throw error('decrypted bundle is not valid JSON', 'LEGACY_JSON');
    }
  }
  const res = applyBundle(opts.ctx, obj, { force: opts.force });
  res.agentConfigWithKeys = (obj.agentConfig || []).some(function (c) {
    return c && c.redacted === false;
  });
  return res;
}

// opts: { ctx, input:'<path>'|'-', passphrase, force }
async function importBundle(opts) {
  const input = opts.input;
  if (!input) throw error('no bundle path', 'USAGE');
  // A legacy FILE can be refused before reading a byte. Detect the streaming
  // magic with a small head read; only paths get this cheap preflight.
  if (input !== '-') {
    let st;
    try {
      st = fs.statSync(input);
    } catch (e) {
      throw error('cannot read ' + input + ': ' + e.message, 'READ');
    }
    if (st.isDirectory()) throw error('cannot read ' + input + ': is a directory', 'READ');
    let head = '';
    try {
      const fd = fs.openSync(input, 'r');
      try {
        const b = Buffer.alloc(Math.min(64, st.size));
        const n = fs.readSync(fd, b, 0, b.length, 0);
        head = b.subarray(0, n).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      throw error('cannot read ' + input + ': ' + e.message, 'READ');
    }
    if (!head.startsWith(MAGIC) && st.size > LEGACY_MAX) {
      throw error(
        'this legacy bundle is ' +
          Math.round(st.size / 1048576) +
          ' MB and would be parsed as one string (the old OOM path). Re-export it on the source machine with a current keyflip (streaming), or use --no-sessions plus the out-of-band transcript copy.',
        'LEGACY_TOO_LARGE',
      );
    }
  }

  const stream = input === '-' ? process.stdin : fs.createReadStream(input);
  const it = linesOf(stream, MAX_LINE)[Symbol.asyncIterator]();
  let first;
  try {
    first = await it.next();
  } catch (e) {
    throw error('cannot read ' + input + ': ' + e.message, 'READ');
  }
  if (first.done) throw error('the bundle is empty', 'STREAM_EMPTY');
  if (first.value.trim() !== MAGIC) {
    return await readLegacy(it, first.value, opts);
  }

  const h = await it.next();
  if (h.done) throw error('the bundle has no header', 'STREAM_TRUNCATED');
  const header = parseJson(h.value, 'bundle header');
  if (!header || header.format !== FORMAT || header.version !== VERSION) {
    throw error(
      'unsupported migrate bundle version (this keyflip understands stream v' + VERSION + ')',
      'STREAM_VERSION',
    );
  }
  const encrypted = !!header.encrypted;
  if (encrypted && !opts.passphrase)
    throw error('this bundle is encrypted — pass --passphrase-file <file>', 'STREAM_CRYPTO');
  let key = null;
  if (encrypted) {
    const salt = Buffer.from(String(header.salt || ''), 'base64');
    if (!salt.length) throw error('encrypted bundle has no salt', 'STREAM_CORRUPT');
    key = crypto.scryptSync(opts.passphrase, salt, 32);
  }

  let seq = 0;
  let prevTag = Buffer.alloc(16);
  let meta = null; // the metadata tier, applied only after the stream verifies
  let res = null;
  let sink = null;
  let ended = false;
  try {
    for (;;) {
      const n = await it.next();
      if (n.done) break;
      const line = n.value;
      if (!line.trim()) continue;
      if (ended) throw error('trailing data after the end record', 'STREAM_SHAPE');
      const decoded = decodeRecord(line, seq, key, prevTag);
      const rec = decoded.rec;
      if (decoded.tag) prevTag = decoded.tag;
      seq++;
      if (!meta) {
        if (rec.type !== 'meta' || !rec.data || typeof rec.data !== 'object') {
          throw error('the first record must be the metadata tier', 'STREAM_SHAPE');
        }
        meta = Object.assign({}, rec.data);
        meta.transcripts = [];
        sink = new TranscriptSink(opts.ctx, opts.force);
        continue;
      }
      if (rec.type === 'tx') sink.start(rec);
      else if (rec.type === 'chunk') sink.chunk(rec);
      else if (rec.type === 'tx-end') sink.end();
      else if (rec.type === 'end') {
        const counted = sink.finish();
        if (rec.transcripts != null && rec.transcripts !== counted.total) {
          throw error('bundle end says ' + rec.transcripts + ' transcripts, saw ' + counted.total, 'STREAM_TRUNCATED');
        }
        if (rec.bytes != null && rec.bytes !== sink.bytes) {
          throw error('bundle end says ' + rec.bytes + ' transcript bytes, saw ' + sink.bytes, 'STREAM_TRUNCATED');
        }
        if (header.transcripts != null && header.transcripts !== counted.total) {
          throw error(
            'bundle header says ' + header.transcripts + ' transcripts, saw ' + counted.total,
            'STREAM_TRUNCATED',
          );
        }
        if (header.bytes != null && header.bytes !== sink.bytes) {
          throw error(
            'bundle header says ' + header.bytes + ' transcript bytes, saw ' + sink.bytes,
            'STREAM_TRUNCATED',
          );
        }
        // Apply the metadata tier only after the whole stream reconciled: a
        // truncated or corrupt bundle must not install accounts, providers or
        // memory. Individual transcripts were already byte-checked per session.
        res = applyBundle(opts.ctx, meta, { force: opts.force });
        // The CLI labels the agent-config line by whether the sender opted in to
        // carrying raw keys; the merge itself re-redacts anything not marked false.
        res.agentConfigWithKeys = (meta.agentConfig || []).some(function (c) {
          return c && c.redacted === false;
        });
        res.transcripts = counted;
        ended = true;
      } else throw error("unknown bundle record type '" + rec.type + "'", 'STREAM_SHAPE');
    }
  } catch (e) {
    if (sink) sink.abort();
    throw e;
  }
  if (!ended) {
    if (sink) sink.abort();
    throw error('the bundle is truncated (no end record)', 'STREAM_TRUNCATED');
  }
  return res;
}

export { MAGIC, FORMAT, VERSION, LEGACY_MAX, MAX_LINE, DEFAULT_CHUNK, writeBundle, importBundle, linesOf };
