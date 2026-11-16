// @ts-check
// Streaming transport for `keyflip migrate export/import`.
//
// The legacy bundle embedded every transcript in ONE JSON string: at ~830 MB
// JSON.stringify exhausted the heap, and encrypting it base64-encoded the whole
// ciphertext into a second giant string that hits V8's max-string limit. This
// stream never materializes the transcript set.
//
// The framing, key derivation and record encryption live in migrate-container.js
// (no keyflip imports, shared byte for byte with other tools). This file decides what
// the records mean:
//   meta      the small tier (accounts/providers/memory/config/agents) — no transcripts;
//             in an encrypted bundle it also carries fromHome / fromUser
//   tx        start of one transcript: {project, sessionId, bytes}
//   chunk     {n, data:base64} — at most `chunkSize` decoded bytes
//   tx-end    end of the current transcript
//   end       {transcripts, bytes, counts} — totals, checked on import
//
// Nothing reaches the target before the whole stream verified: transcripts are staged
// as temp files and renamed, and the metadata tier applied, only after the `end` record
// reconciled. A tampered, truncated or wrong-passphrase bundle leaves the target as it was.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { applyBundle, isSafeSegment, planApply } from './migrate.js';
import * as fsutil from './fsutil.js';
import * as sync from './sync.js';
import * as container from './migrate-container.js';

const MAGIC = container.MAGIC_V3;
const FORMAT = container.FORMAT;
const VERSION = 3;
const DEFAULT_CHUNK = container.DEFAULT_CHUNK;
// A record line never comes close to this (<200 KB). The cap exists because a
// LEGACY bundle is one giant JSON line, and it matches LEGACY_MAX so the two
// refusal paths agree on the same limit.
const LEGACY_MAX = container.MAX_LINE;
const MAX_LINE = LEGACY_MAX;
const linesOf = container.linesOf;
const error = container.containerError;

function projectsDir(ctx) {
  return path.join(ctx.claudeDir || path.join(ctx.home, '.claude'), 'projects');
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

// opts: { out, meta, files:[{project,sessionId,file,bytes}], passphrase, chunkSize, now, bundleId,
//         toolVersion, fromHome, fromUser }
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

  const writer = container.createWriter({
    passphrase: passphrase,
    bundleId: opts.bundleId,
    tool: 'keyflip',
    toolVersion: opts.toolVersion,
    createdAt: opts.now,
    chunkSize: chunkSize,
    transcripts: files.length,
    bytes: totalBytes,
    randomBytes: opts.randomBytes,
  });

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

  let exportedBytes = 0;
  const emit = async function (record) {
    await writeLine(stream, writer.seal(record));
  };

  try {
    await writeLine(stream, writer.headerText);
    const metaRec = { type: 'meta', data: meta.bundle };
    // Where the bundle came from rides inside the ENCRYPTED part only; the clear header
    // never names the machine or the user.
    if (passphrase && opts.fromHome) metaRec.fromHome = opts.fromHome;
    if (passphrase && opts.fromUser) metaRec.fromUser = opts.fromUser;
    await emit(metaRec);
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
  return { transcripts: files.length, bytes: exportedBytes, counts: meta.counts, bundleId: writer.bundleId };
}

// --- importing --------------------------------------------------------------

function fileSha256(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

// Remove a directory and its sub-directories, but only while they hold no file.
function removeEmptyTree(dir) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  ents.forEach(function (ent) {
    if (ent.isDirectory()) removeEmptyTree(path.join(dir, ent.name));
  });
  try {
    fs.rmdirSync(dir);
  } catch (e) {
    /* not empty */
  }
}

// Writes the transcript tier to ~/.claude/projects. One temp file per session; the temp
// files are renamed into place only by commit(), after the whole stream verified.
class TranscriptSink {
  constructor(ctx, force, backup) {
    this.ctx = ctx;
    this.root = projectsDir(ctx);
    this.force = !!force;
    this.backup = backup || null;
    this.cur = null;
    this.pending = [];
    this.madeDirs = [];
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
    const made = fs.mkdirSync(path.dirname(file), { recursive: true });
    if (made) this.madeDirs.push(made); // the topmost directory this call created
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
      this.pending.push(cur);
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

  // Move every staged transcript into place (after the stream verified).
  commit() {
    const list = this.pending;
    this.pending = [];
    list.forEach(
      function (cur) {
        if (cur.overwrite && this.backup) this.backup.before(cur.file);
        replaceFile(cur.tmp, cur.file);
        try {
          fs.chmodSync(cur.file, 0o600);
        } catch (e) {
          /* non-POSIX FS */
        }
        if (cur.overwrite) this.result.overwritten++;
        else this.result.added++;
      }.bind(this),
    );
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
    this.pending.forEach(function (cur) {
      try {
        fs.rmSync(cur.tmp, { force: true });
      } catch (e) {
        /* best effort */
      }
    });
    this.pending = [];
    // Directories created only for staged files go away again (rmdir refuses non-empty ones).
    this.madeDirs.reverse().forEach(function (d) {
      removeEmptyTree(d);
    });
    this.madeDirs = [];
  }

  finish() {
    if (this.cur) throw error('bundle ended in the middle of a transcript', 'STREAM_TRUNCATED');
    this.result.total = this.seen;
    return this.result;
  }
}

// --dry-run: the same verification, no file written. Counts transcripts as
// new / exists-kept (same bytes already there) / conflict (a different file is there).
class DrySink {
  constructor(ctx) {
    this.root = projectsDir(ctx);
    this.cur = null;
    this.seen = 0;
    this.bytes = 0;
    this.result = { new: 0, existsKept: 0, conflict: 0, skipped: 0, total: 0 };
  }

  start(rec) {
    if (this.cur) throw error('transcript record started before the previous one ended', 'STREAM_SHAPE');
    this.seen++;
    const bytes = rec.bytes;
    if (!isSafeSegment(rec.project) || !isSafeSegment(rec.sessionId) || !Number.isInteger(bytes) || bytes < 0) {
      this.result.skipped++;
      this.cur = { skip: true };
      return;
    }
    const file = path.join(this.root, rec.project, rec.sessionId + '.jsonl');
    if (!fsutil.safeDestUnder(this.root, file).ok) {
      this.result.skipped++;
      this.cur = { skip: true };
      return;
    }
    this.cur = { file: file, bytes: bytes, received: 0, hash: crypto.createHash('sha256') };
  }

  chunk(rec) {
    if (!this.cur) throw error('transcript chunk without a start record', 'STREAM_SHAPE');
    const buf = Buffer.from(String(rec.data || ''), 'base64');
    if (rec.n != null && rec.n !== buf.length) throw error('corrupt transcript chunk length', 'STREAM_DATA');
    this.bytes += buf.length;
    if (this.cur.skip) return;
    this.cur.received += buf.length;
    if (this.cur.received > this.cur.bytes) throw error('transcript chunk exceeds its declared size', 'STREAM_DATA');
    this.cur.hash.update(buf);
  }

  end() {
    if (!this.cur) throw error('transcript end without a start record', 'STREAM_SHAPE');
    const cur = this.cur;
    this.cur = null;
    if (cur.skip) return;
    if (cur.received !== cur.bytes) throw error('transcript is truncated', 'STREAM_DATA');
    let st = null;
    try {
      st = fs.statSync(cur.file);
    } catch (e) {
      st = null;
    }
    if (!st) this.result.new++;
    else if (st.size === cur.bytes && fileSha256(cur.file) === cur.hash.digest('hex')) this.result.existsKept++;
    else this.result.conflict++;
  }

  abort() {
    this.cur = null;
  }

  finish() {
    if (this.cur) throw error('bundle ended in the middle of a transcript', 'STREAM_TRUNCATED');
    this.result.total = this.seen;
    return this.result;
  }
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
  if (opts.expectBundleId != null) throw error('a legacy bundle has no bundle id', 'STREAM_BUNDLE_ID');
  if (obj && obj.magic === 'keyflip-sync') {
    if (!opts.passphrase) throw error('this bundle is encrypted — pass --passphrase-file <file>', 'NEED_PASSPHRASE');
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
  } else if (opts.passphrase || opts.requireEncrypted) {
    throw error('this bundle is not encrypted but encryption was asked for — refusing it', 'STREAM_PLAINTEXT');
  }
  if (opts.dryRun) {
    return {
      dryRun: true,
      plan: planApply(opts.ctx, obj, { force: opts.force, transcripts: legacyTranscriptPlan(opts.ctx, obj) }),
    };
  }
  if (opts.backup) opts.backup.start(obj);
  const res = applyBundle(opts.ctx, obj, { force: opts.force });
  res.agentConfigWithKeys = (obj.agentConfig || []).some(function (c) {
    return c && c.redacted === false;
  });
  return res;
}

function legacyTranscriptPlan(ctx, obj) {
  const r = { new: 0, existsKept: 0, conflict: 0, skipped: 0, total: 0 };
  (obj.transcripts || []).forEach(function (t) {
    r.total++;
    if (!t || typeof t.content !== 'string' || !isSafeSegment(t.project) || !isSafeSegment(t.sessionId)) {
      r.skipped++;
      return;
    }
    const file = path.join(projectsDir(ctx), t.project, t.sessionId + '.jsonl');
    let cur = null;
    try {
      cur = fs.readFileSync(file, 'utf8');
    } catch (e) {
      cur = null;
    }
    if (cur == null) r.new++;
    else if (cur === t.content) r.existsKept++;
    else r.conflict++;
  });
  return r;
}

// opts: { ctx, input:'<path>'|'-', passphrase, force, requireEncrypted, expectBundleId,
//         dryRun, backup:{start(meta), before(file)} }
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
    if (!head.startsWith('KEYFLIP-MIGRATE-STREAM/') && st.size > LEGACY_MAX) {
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
    if (e && e.code === 'LEGACY_TOO_LARGE') throw e;
    throw error('cannot read ' + input + ': ' + e.message, 'READ');
  }
  if (first.done) throw error('the bundle is empty', 'STREAM_EMPTY');
  const magic = first.value.trim();
  if (magic.indexOf('KEYFLIP-MIGRATE-STREAM/') !== 0) {
    return await readLegacy(it, first.value, opts);
  }

  const h = await it.next();
  if (h.done) throw error('the bundle has no header', 'STREAM_TRUNCATED');
  const reader = container.openReader(magic, h.value, {
    passphrase: opts.passphrase,
    requireEncrypted: opts.requireEncrypted,
    expectBundleId: opts.expectBundleId,
  });
  const header = reader.header;

  let meta = null; // the metadata tier, applied only after the stream verifies
  let source = null;
  let res = null;
  let sink = null;
  try {
    for await (const rec of container.records(it, reader)) {
      if (!meta) {
        if (rec.type !== 'meta' || !rec.data || typeof rec.data !== 'object') {
          throw error('the first record must be the metadata tier', 'STREAM_SHAPE');
        }
        meta = Object.assign({}, rec.data);
        meta.transcripts = [];
        source = {
          bundleId: header.bundleId || null,
          version: reader.version,
          fromHome: typeof rec.fromHome === 'string' ? rec.fromHome : null,
          fromUser: typeof rec.fromUser === 'string' ? rec.fromUser : null,
        };
        sink = opts.dryRun ? new DrySink(opts.ctx) : new TranscriptSink(opts.ctx, opts.force, opts.backup);
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
        if (opts.dryRun) {
          res = {
            dryRun: true,
            plan: planApply(opts.ctx, meta, { force: opts.force, transcripts: counted }),
            source: source,
          };
        } else {
          // Apply the metadata tier only after the whole stream reconciled: a
          // truncated or corrupt bundle must not install anything.
          // The safety copy happens now: the stream is verified and nothing has been
          // written to its final place yet.
          if (opts.backup) opts.backup.start(meta);
          sink.commit();
          res = applyBundle(opts.ctx, meta, { force: opts.force });
          // The CLI labels the agent-config line by whether the sender opted in to
          // carrying raw keys; the merge itself re-redacts anything not marked false.
          res.agentConfigWithKeys = (meta.agentConfig || []).some(function (c) {
            return c && c.redacted === false;
          });
          res.transcripts = counted;
          res.source = source;
        }
      } else throw error("unknown bundle record type '" + rec.type + "'", 'STREAM_SHAPE');
    }
  } catch (e) {
    if (sink) sink.abort();
    throw e;
  }
  return res;
}

export { MAGIC, FORMAT, VERSION, LEGACY_MAX, MAX_LINE, DEFAULT_CHUNK, writeBundle, importBundle, linesOf };
