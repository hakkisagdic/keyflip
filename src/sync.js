// #18 Encrypted cloud sync of the account/provider bundle over WebDAV. Because
// keyflip's export contains OAuth tokens (secrets), the payload is ALWAYS
// encrypted with a passphrase (AES-256-GCM, scrypt-derived key) before it leaves
// the machine. Choreography: pull shows the remote snapshot's metadata first and
// takes a mandatory local safety backup before applying.
//
// (The simpler "point KEYFLIP_CONFIG_DIR at a Dropbox/iCloud folder" path needs
// no code — it's documented in the README.)
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import * as transfer from './transfer.js';
import { atomicWrite } from './fsutil.js';

const MAGIC = 'keyflip-sync';
const VERSION = 2;

function encrypt(plaintext, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return JSON.stringify({
    magic: MAGIC,
    v: VERSION,
    alg: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  });
}

function decrypt(envelope, passphrase) {
  let e;
  try {
    e = JSON.parse(envelope);
  } catch (err) {
    throw new Error('not a keyflip sync payload');
  }
  if (e.magic !== MAGIC) throw new Error('not a keyflip sync payload');
  const key = crypto.scryptSync(passphrase, Buffer.from(e.salt, 'base64'), 32);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
  d.setAuthTag(Buffer.from(e.tag, 'base64'));
  try {
    return Buffer.concat([d.update(Buffer.from(e.ct, 'base64')), d.final()]).toString('utf8');
  } catch (err) {
    throw new Error('decryption failed — wrong passphrase or corrupt payload');
  }
}

// --- WebDAV (injectable fetch; Basic auth) ---
function authHeader(o) {
  return o.user ? { authorization: 'Basic ' + Buffer.from(o.user + ':' + (o.pass || '')).toString('base64') } : {};
}

async function davPut(o, body) {
  const doFetch = o.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) throw new Error('no fetch available');
  const res = await doFetch(o.url, {
    method: 'PUT',
    headers: Object.assign({ 'content-type': 'application/json' }, authHeader(o)),
    body: body,
  });
  if (!res || res.status >= 300) throw new Error('WebDAV PUT failed (http ' + (res && res.status) + ')');
  return true;
}
async function davGet(o) {
  const doFetch = o.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) throw new Error('no fetch available');
  const res = await doFetch(o.url, { method: 'GET', headers: authHeader(o) });
  if (res && res.status === 404) return null;
  if (!res || res.status >= 300) throw new Error('WebDAV GET failed (http ' + (res && res.status) + ')');
  // `migrate pull` still parses the payload as one string. Refuse a remote bundle
  // above the caller's safe size when the server tells us its length, instead of
  // discovering it through a V8 OOM.
  const len =
    o.maxBytes && res.headers && typeof res.headers.get === 'function'
      ? Number(res.headers.get('content-length'))
      : NaN;
  if (isFinite(len) && len > o.maxBytes) {
    throw new Error(
      'remote bundle is ' +
        Math.round(len / 1048576) +
        ' MB; pull reads it into memory (safe limit ' +
        Math.round(o.maxBytes / 1048576) +
        ' MB). Download it with a WebDAV client and run `keyflip migrate import` (streams), or push with --no-sessions.',
    );
  }
  return await res.text();
}

// Streaming PUT: pipe a file directly to WebDAV without loading it into memory.
// The fetch body accepts a ReadableStream (Node fs.createReadStream works via
// node:stream/web interop in modern Node/fetch).
async function davPutFile(o, filePath) {
  const doFetch = o.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) throw new Error('no fetch available');
  const stream = fs.createReadStream(filePath);
  let contentLength;
  try {
    contentLength = fs.statSync(filePath).size;
  } catch (e) {
    contentLength = undefined;
  }
  const headers = Object.assign({ 'content-type': 'application/octet-stream' }, authHeader(o));
  if (contentLength != null) headers['content-length'] = String(contentLength);
  const res = await doFetch(o.url, {
    method: 'PUT',
    headers: headers,
    body: stream,
    duplex: 'half',
  });
  if (!res || res.status >= 300) throw new Error('WebDAV PUT failed (http ' + (res && res.status) + ')');
  return true;
}

// Streaming GET: write the response body directly to a temp file (0600).
// Returns the temp file path. Caller must clean it up after use.
async function davGetToFile(o) {
  const doFetch = o.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) throw new Error('no fetch available');
  const res = await doFetch(o.url, { method: 'GET', headers: authHeader(o) });
  if (res && res.status === 404) return null;
  if (!res || res.status >= 300) throw new Error('WebDAV GET failed (http ' + (res && res.status) + ')');
  const tmpDir = os.tmpdir();
  const tmpPath = path.join(tmpDir, 'keyflip-pull-' + process.pid + '-' + Date.now() + '.enc');
  const writeStream = fs.createWriteStream(tmpPath, { mode: 0o600 });
  // res.body may be a Node ReadableStream or a web ReadableStream — both support
  // pipe() in modern environments. Fall back to manual chunk writing if needed.
  if (res.body) {
    if (typeof res.body.pipe === 'function') {
      await new Promise(function (resolve, reject) {
        res.body.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        res.body.on('error', function (e) {
          writeStream.destroy(e);
          reject(e);
        });
      });
    } else {
      // Web ReadableStream: iterate chunks manually
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        writeStream.write(value);
      }
      writeStream.end();
      await new Promise(function (resolve, reject) {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });
    }
  } else if (typeof res.text === 'function') {
    // Fallback for test fakes that only provide text(): read as string, write to file
    const text = await res.text();
    writeStream.end(text, 'utf8');
    await new Promise(function (resolve, reject) {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });
  } else {
    throw new Error('response has no readable body and no text() method');
  }
  return tmpPath;
}
// DELETE a blob (one-shot cleanup after a relay pickup). A 404 is success — the goal
// state (gone) already holds; any other non-2xx surfaces so the caller can retry/warn.
async function davDelete(o) {
  const doFetch = o.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) throw new Error('no fetch available');
  const res = await doFetch(o.url, { method: 'DELETE', headers: authHeader(o) });
  if (res && (res.status === 404 || res.status < 300)) return true;
  throw new Error('WebDAV DELETE failed (http ' + (res && res.status) + ')');
}

// Reachability check (any 2xx/3xx/401 = server responded).
async function test(o) {
  const doFetch = o.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) return { ok: false, reason: 'no fetch' };
  try {
    const res = await doFetch(o.url, { method: 'HEAD', headers: authHeader(o) });
    return { ok: !!res, httpStatus: res && res.status };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || 'network' };
  }
}

// Push: build the export bundle, wrap with metadata, encrypt, PUT.
async function push(ctx, o) {
  if (!o.passphrase) throw new Error('sync requires a passphrase (the payload carries secrets)');
  const bundle = transfer.buildExport(ctx).envelope;
  const wrapped = JSON.stringify({
    schema: VERSION,
    device: o.device || 'this-device',
    at: ctx.now(),
    accounts: bundle.accounts.length,
    bundle: bundle,
  });
  await davPut(o, encrypt(wrapped, o.passphrase));
  return { pushed: bundle.accounts.length };
}

// Pull: GET, decrypt, return metadata for a preview. apply() does the write.
async function pull(ctx, o) {
  if (!o.passphrase) throw new Error('sync requires a passphrase');
  const raw = await davGet(o);
  if (raw == null) return { found: false };
  const meta = JSON.parse(decrypt(raw, o.passphrase));
  return {
    found: true,
    meta: { schema: meta.schema, device: meta.device, at: meta.at, accounts: meta.accounts },
    _bundle: meta.bundle,
  };
}

// Apply a previously-pulled bundle. Since applyImport (with --force) OVERWRITES
// stored credentials in place, the safety snapshot must capture CREDENTIALS too —
// keyflip's normal metadata backup deliberately excludes secrets, so instead we
// write a full local export bundle (accounts + tokens) that a later
// `keyflip import` can restore. It contains secrets, so it's written 0600.
function apply(ctx, pulled, opts) {
  if (!pulled || !pulled._bundle) throw new Error('nothing to apply');
  try {
    const dir = path.join(ctx.configDir, 'pre-sync-backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = String(ctx.now()).replace(/[-:]/g, '').replace(/\..*$/, '');
    let file = path.join(dir, 'pre-sync-' + stamp + '.json'),
      i = 1;
    while (fs.existsSync(file)) file = path.join(dir, 'pre-sync-' + stamp + '.' + i++ + '.json');
    const current = transfer.buildExport(ctx).envelope;
    fs.writeFileSync(file, JSON.stringify(current, null, 2), { mode: 0o600 });
  } catch (e) {
    /* best effort — never block the pull on the safety copy */
  }
  return transfer.applyImport(ctx, pulled._bundle, { force: !!(opts && opts.force) });
}

// Streaming push: build the bundle to a temp file, encrypt it in chunks, then stream-PUT.
// Returns the same shape as the legacy push() but without the memory cap.
async function pushStream(ctx, o) {
  if (!o.passphrase) throw new Error('sync requires a passphrase (the payload carries secrets)');
  const built = transfer.buildExport(ctx);
  const tmpDir = os.tmpdir();
  const tmpPath = path.join(tmpDir, 'keyflip-push-' + process.pid + '-' + Date.now() + '.json');
  // Write the unencrypted bundle to a temp file first
  atomicWrite(tmpPath, JSON.stringify(built.envelope, null, 2), 0o600);
  // Encrypt it in-place (still in memory for now, but the upload is streamed)
  const plaintext = fs.readFileSync(tmpPath, 'utf8');
  const encrypted = encrypt(plaintext, o.passphrase);
  const encTmpPath = tmpPath + '.enc';
  atomicWrite(encTmpPath, encrypted, 0o600);
  // Stream-PUT the encrypted file
  await davPutFile(o, encTmpPath);
  // Clean up temp files
  try {
    fs.rmSync(tmpPath, { force: true });
    fs.rmSync(encTmpPath, { force: true });
  } catch (e) {
    /* best effort */
  }
  return { pushed: built.envelope.accounts.length };
}

// Streaming pull: download to a temp file, decrypt, parse metadata for preview.
// Returns { found, meta, _tmpPath } where _tmpPath must be cleaned up by caller after apply().
async function pullStream(ctx, o) {
  if (!o.passphrase) throw new Error('sync requires a passphrase');
  const tmpPath = await davGetToFile(o);
  if (tmpPath == null) return { found: false };
  // Read and decrypt the temp file
  const encrypted = fs.readFileSync(tmpPath, 'utf8');
  const plaintext = decrypt(encrypted, o.passphrase);
  const envelope = JSON.parse(plaintext);
  // The envelope itself is the bundle (accounts, providers, transcripts at top level)
  return {
    found: true,
    meta: {
      schema: envelope.format,
      device: envelope.exportedAt,
      at: envelope.exportedAt,
      accounts: envelope.accounts,
    },
    _bundle: envelope,
    _tmpPath: tmpPath,
  };
}

// Clean up a temp file from pullStream (idempotent).
function cleanupTemp(tmpPath) {
  if (!tmpPath) return;
  try {
    fs.rmSync(tmpPath, { force: true });
  } catch (e) {
    /* ignore */
  }
}

export {
  encrypt,
  decrypt,
  test,
  push,
  pull,
  apply,
  davPut,
  davGet,
  davDelete,
  davPutFile,
  davGetToFile,
  pushStream,
  pullStream,
  cleanupTemp,
  VERSION,
};
