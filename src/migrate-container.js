// @ts-check
// The migrate CONTAINER: framing, key derivation and record encryption only.
//
// This module imports Node built-ins and nothing from keyflip, on purpose: other tools
// (keysmith and the rest) copy this file byte for byte and read/write the same bundles.
// What the records MEAN (accounts, providers, transcripts) lives in migrate-stream.js.
//
//   KEYFLIP-MIGRATE-STREAM/3                      <- magic line
//   {"format":…,"version":3,"encrypted":true,     <- header line (clear, authenticated)
//    "alg":"aes-256-gcm",
//    "kdf":{"name":"scrypt","N":131072,"r":8,"p":1},
//    "salt":"…","bundleId":"…","tool":"keyflip","toolVersion":"…","createdAt":"…"}
//   {"seq":0,"iv":"…","tag":"…","ct":"…"}         <- one JSON line per record
//   …
//   (the last record is {type:"end",…}; a missing one is an error)
//
// Encrypted records: AES-256-GCM, one scrypt key, the AAD of record n is
//   prev || uint64be(n)
// where prev is the previous record's tag (16 bytes). For record 0 of a v3 bundle prev is
// SHA-256(magic + "\n" + headerLine) (32 bytes), so the header cannot be altered without
// the first record failing to authenticate. v2 bundles (read only) start from 16 zero bytes.
//
// Blob records (blob-start{name,bytes,sha256} / chunk / blob-end) are checked here by
// BlobTracker: declared size and SHA-256 must match what arrived.
import crypto from 'crypto';

export const MAGIC_V2 = 'KEYFLIP-MIGRATE-STREAM/2';
export const MAGIC_V3 = 'KEYFLIP-MIGRATE-STREAM/3';
export const FORMAT = 'keyflip-migrate-stream';
export const KDF_N = 131072; // 2^17: ~128 MiB with r=8
export const KDF_N_MIN = 32768; // 2^15
export const KDF_N_MAX = 1048576; // 2^20
export const SCRYPT_MAXMEM = 256 * 1024 * 1024;
export const DEFAULT_CHUNK = 128 * 1024;
// One record line never comes close to this (<200 KB). A LEGACY bundle is one giant JSON line.
export const MAX_LINE = 256 * 1024 * 1024;

const BUNDLE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Every failure of the container has a stable `code`; the CLI maps the reject family
 * (STREAM_*, LEGACY_*) to exit 3. Messages never quote file content.
 * @param {string} message
 * @param {string=} code
 */
export function containerError(message, code) {
  const e = /** @type {any} */ (new Error(message));
  e.code = code || 'MIGRATE_STREAM';
  return e;
}

export function isValidBundleId(id) {
  return typeof id === 'string' && BUNDLE_ID_RE.test(id);
}

export function newBundleId(randomBytes) {
  return (randomBytes || crypto.randomBytes)(16).toString('hex');
}

function tooLongLine(maxLine) {
  return containerError(
    'a bundle line is larger than ' +
      Math.round(maxLine / 1048576) +
      ' MB — this is the legacy one-string format; re-export on the source machine with a current keyflip (streaming)',
    'LEGACY_TOO_LARGE',
  );
}

// --- line reading -----------------------------------------------------------

// Turn a Node readable into an async iterator of lines without holding more than one.
// Chunks accumulate in an array so a long line costs O(n) copies, not O(n²).
export async function* linesOf(stream, maxLine) {
  const cap = maxLine || MAX_LINE;
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
          if (len > cap) throw tooLongLine(cap);
        }
        break;
      }
      const piece = chunk.subarray(start, nl);
      parts.push(piece);
      len += piece.length;
      if (len > cap) throw tooLongLine(cap);
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

// --- key derivation ---------------------------------------------------------

/**
 * @param {string} passphrase
 * @param {Buffer} salt
 * @param {{N:number,r:number,p:number}} kdf
 */
export function deriveKey(passphrase, salt, kdf) {
  try {
    return crypto.scryptSync(passphrase, salt, 32, {
      N: kdf.N,
      r: kdf.r,
      p: kdf.p,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch (e) {
    throw containerError('the key derivation parameters of this bundle are refused (too much memory)', 'STREAM_KDF');
  }
}

function headerDigest(magic, headerLine) {
  return crypto
    .createHash('sha256')
    .update(magic + '\n' + headerLine, 'utf8')
    .digest();
}

function aadFor(prev, seq) {
  const aad = Buffer.alloc(prev.length + 8);
  prev.copy(aad, 0);
  aad.writeBigUInt64BE(BigInt(seq), prev.length);
  return aad;
}

// --- writing ----------------------------------------------------------------

/**
 * Build a v3 header and a `seal` function that turns a record into one output line.
 * opts: { passphrase|null, bundleId, tool, toolVersion, createdAt, chunkSize,
 *         transcripts, bytes, randomBytes }  (randomBytes is injectable for fixed test vectors)
 */
export function createWriter(opts) {
  const rnd = opts.randomBytes || crypto.randomBytes;
  const passphrase = opts.passphrase || null;
  const bundleId = opts.bundleId == null ? newBundleId(rnd) : opts.bundleId;
  if (!isValidBundleId(bundleId)) {
    throw containerError('a bundle id is 1-64 characters of A-Z a-z 0-9 . _ -', 'USAGE');
  }
  const salt = passphrase ? rnd(16) : null;
  const header = {
    format: FORMAT,
    version: 3,
    encrypted: !!passphrase,
    alg: passphrase ? 'aes-256-gcm' : null,
    // kdfN exists only so the test vectors can build a bundle the reader must refuse.
    kdf: passphrase ? { name: 'scrypt', N: opts.kdfN || KDF_N, r: 8, p: 1 } : null,
    salt: salt ? salt.toString('base64') : null,
    bundleId: bundleId,
    tool: opts.tool || 'unknown',
    toolVersion: opts.toolVersion || '0',
    createdAt: opts.createdAt || new Date().toISOString(),
    chunkSize: opts.chunkSize || DEFAULT_CHUNK,
    transcripts: opts.transcripts == null ? null : opts.transcripts,
    bytes: opts.bytes == null ? null : opts.bytes,
  };
  const headerLine = JSON.stringify(header);
  const key = passphrase ? deriveKey(passphrase, /** @type {Buffer} */ (salt), /** @type {any} */ (header.kdf)) : null;
  let prev = headerDigest(MAGIC_V3, headerLine);
  let seq = 0;
  return {
    header: header,
    bundleId: bundleId,
    encrypted: !!passphrase,
    headerText: MAGIC_V3 + '\n' + headerLine + '\n',
    /** @param {Record<string, any>} record */
    seal: function (record) {
      record.seq = seq;
      let line;
      if (key) {
        const iv = rnd(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(aadFor(prev, seq));
        const ct = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        line = JSON.stringify({
          seq: seq,
          iv: iv.toString('base64'),
          tag: tag.toString('base64'),
          ct: ct.toString('base64'),
        });
        prev = tag;
      } else {
        line = JSON.stringify(record);
      }
      seq++;
      return line + '\n';
    },
  };
}

// --- reading ----------------------------------------------------------------

function parseJson(line, what) {
  try {
    return JSON.parse(line);
  } catch (e) {
    throw containerError(what + ' is not valid JSON', 'STREAM_CORRUPT');
  }
}

/**
 * Validate the two leading lines and return a reader.
 * opts: { passphrase, requireEncrypted, expectBundleId }
 * Rejects (before any record is touched): bad magic/version, a plaintext bundle when a
 * passphrase was given or encryption is required (downgrade), an unexpected bundle id,
 * KDF parameters outside the allowed range.
 */
export function openReader(magic, headerLine, opts) {
  opts = opts || {};
  const v3 = magic === MAGIC_V3;
  if (!v3 && magic !== MAGIC_V2) {
    throw containerError(
      'unsupported migrate bundle version (this keyflip understands stream v2 and v3)',
      'STREAM_VERSION',
    );
  }
  const version = v3 ? 3 : 2;
  const header = parseJson(headerLine, 'bundle header');
  if (!header || typeof header !== 'object' || header.format !== FORMAT || header.version !== version) {
    throw containerError('the bundle header does not match its magic line', 'STREAM_VERSION');
  }
  if (v3 && typeof header.encrypted !== 'boolean') {
    throw containerError('the bundle header is malformed', 'STREAM_CORRUPT');
  }
  const encrypted = !!header.encrypted;
  if (!encrypted && (opts.passphrase || opts.requireEncrypted)) {
    throw containerError(
      'this bundle is not encrypted but encryption was asked for — refusing it (a plain bundle could have replaced the encrypted one)',
      'STREAM_PLAINTEXT',
    );
  }
  if (opts.expectBundleId != null) {
    if (!v3 || header.bundleId !== opts.expectBundleId) {
      throw containerError('the bundle id does not match --expect-bundle-id', 'STREAM_BUNDLE_ID');
    }
  }
  if (v3 && !isValidBundleId(header.bundleId)) {
    throw containerError('the bundle header is malformed', 'STREAM_CORRUPT');
  }
  let key = null;
  /** @type {{N:number,r:number,p:number}|null} */
  let kdf = null;
  if (encrypted) {
    if (!opts.passphrase)
      throw containerError('this bundle is encrypted — pass --passphrase-file <file>', 'NEED_PASSPHRASE');
    const salt = Buffer.from(String(header.salt || ''), 'base64');
    if (salt.length !== 16) throw containerError('encrypted bundle has a bad salt', 'STREAM_CORRUPT');
    if (v3) {
      const k = header.kdf;
      const ok =
        header.alg === 'aes-256-gcm' &&
        k &&
        k.name === 'scrypt' &&
        Number.isInteger(k.N) &&
        k.N >= KDF_N_MIN &&
        k.N <= KDF_N_MAX &&
        (k.N & (k.N - 1)) === 0 &&
        k.r === 8 &&
        k.p === 1;
      if (!ok) {
        throw containerError('the bundle key derivation parameters are outside the allowed range', 'STREAM_KDF');
      }
      kdf = { N: k.N, r: k.r, p: k.p };
    } else {
      kdf = { N: 16384, r: 8, p: 1 };
    }
    key = deriveKey(opts.passphrase, salt, kdf);
  }
  let prev = v3 ? headerDigest(magic, headerLine) : Buffer.alloc(16);
  let seq = 0;
  let ended = false;
  return {
    version: version,
    header: header,
    encrypted: encrypted,
    /** @param {string} line @returns {Record<string, any>} */
    decode: function (line) {
      if (ended) throw containerError('trailing data after the end record', 'STREAM_SHAPE');
      const outer = parseJson(line, 'bundle record');
      if (!outer || typeof outer !== 'object') throw containerError('bundle record is not an object', 'STREAM_CORRUPT');
      if (outer.seq !== seq) throw containerError('bundle record out of order (expected ' + seq + ')', 'STREAM_ORDER');
      let rec = outer;
      if (key) {
        let iv, tag, ct;
        try {
          iv = Buffer.from(String(outer.iv || ''), 'base64');
          tag = Buffer.from(String(outer.tag || ''), 'base64');
          ct = Buffer.from(String(outer.ct || ''), 'base64');
        } catch (e) {
          throw containerError('corrupt encrypted record', 'STREAM_CORRUPT');
        }
        if (iv.length !== 12 || tag.length !== 16) throw containerError('corrupt encrypted record', 'STREAM_CORRUPT');
        let plain;
        try {
          const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
          d.setAAD(aadFor(prev, seq));
          d.setAuthTag(tag);
          plain = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
        } catch (e) {
          throw containerError('decryption failed — wrong passphrase or corrupt bundle', 'STREAM_CRYPTO');
        }
        rec = parseJson(plain, 'decrypted record');
        if (!rec || typeof rec !== 'object') throw containerError('corrupt bundle record', 'STREAM_CORRUPT');
        if (rec.seq != null && rec.seq !== seq) throw containerError('bundle record out of order', 'STREAM_ORDER');
        prev = tag;
      }
      seq++;
      if (rec.type === 'end') ended = true;
      return rec;
    },
    /** True once the end record was decoded. */
    get ended() {
      return ended;
    },
  };
}

/**
 * Iterate decoded records; fail when the stream stops before the end record.
 * @param {AsyncIterator<string>} it  positioned after the header line
 */
export async function* records(it, reader) {
  for (;;) {
    const n = await it.next();
    if (n.done) break;
    if (!n.value.trim()) continue;
    yield reader.decode(n.value);
  }
  if (!reader.ended) throw containerError('the bundle is truncated (no end record)', 'STREAM_TRUNCATED');
}

// --- blobs ------------------------------------------------------------------

/** Checks blob-start / chunk / blob-end sequences: declared bytes and SHA-256 must match. */
export class BlobTracker {
  constructor() {
    /** @type {null|{name:string,bytes:number,sha256:string,hash:any,received:number}} */
    this.cur = null;
    this.blobs = 0;
    this.bytes = 0;
  }
  start(rec) {
    if (this.cur) throw containerError('blob started before the previous one ended', 'STREAM_SHAPE');
    if (
      typeof rec.name !== 'string' ||
      !Number.isInteger(rec.bytes) ||
      rec.bytes < 0 ||
      !/^[0-9a-f]{64}$/.test(String(rec.sha256))
    ) {
      throw containerError('malformed blob-start record', 'STREAM_SHAPE');
    }
    this.cur = { name: rec.name, bytes: rec.bytes, sha256: rec.sha256, hash: crypto.createHash('sha256'), received: 0 };
  }
  /** @returns {Buffer} the decoded bytes */
  chunk(rec) {
    if (!this.cur) throw containerError('blob chunk without a start record', 'STREAM_SHAPE');
    const buf = Buffer.from(String(rec.data || ''), 'base64');
    if (rec.n != null && rec.n !== buf.length) throw containerError('corrupt blob chunk length', 'STREAM_DATA');
    this.cur.received += buf.length;
    if (this.cur.received > this.cur.bytes) throw containerError('blob exceeds its declared size', 'STREAM_DATA');
    this.cur.hash.update(buf);
    return buf;
  }
  end() {
    if (!this.cur) throw containerError('blob end without a start record', 'STREAM_SHAPE');
    const cur = this.cur;
    this.cur = null;
    if (cur.received !== cur.bytes) throw containerError('blob is truncated', 'STREAM_DATA');
    if (cur.hash.digest('hex') !== cur.sha256) throw containerError('blob checksum does not match', 'STREAM_DATA');
    this.blobs++;
    this.bytes += cur.bytes;
    return { name: cur.name, bytes: cur.bytes };
  }
  finish() {
    if (this.cur) throw containerError('bundle ended in the middle of a blob', 'STREAM_TRUNCATED');
    return { blobs: this.blobs, bytes: this.bytes };
  }
}
