'use strict';
// #18 Encrypted cloud sync of the account/provider bundle over WebDAV. Because
// keyflip's export contains OAuth tokens (secrets), the payload is ALWAYS
// encrypted with a passphrase (AES-256-GCM, scrypt-derived key) before it leaves
// the machine. Choreography: pull shows the remote snapshot's metadata first and
// takes a mandatory local safety backup before applying.
//
// (The simpler "point KEYFLIP_CONFIG_DIR at a Dropbox/iCloud folder" path needs
// no code — it's documented in the README.)
const crypto = require('crypto');
const transfer = require('./transfer');
const backup = require('./backup');

const MAGIC = 'keyflip-sync';
const VERSION = 2;

function encrypt(plaintext, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return JSON.stringify({ magic: MAGIC, v: VERSION, alg: 'aes-256-gcm', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64') });
}

function decrypt(envelope, passphrase) {
  let e;
  try { e = JSON.parse(envelope); } catch (err) { throw new Error('not a keyflip sync payload'); }
  if (e.magic !== MAGIC) throw new Error('not a keyflip sync payload');
  const key = crypto.scryptSync(passphrase, Buffer.from(e.salt, 'base64'), 32);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
  d.setAuthTag(Buffer.from(e.tag, 'base64'));
  try {
    return Buffer.concat([d.update(Buffer.from(e.ct, 'base64')), d.final()]).toString('utf8');
  } catch (err) { throw new Error('decryption failed — wrong passphrase or corrupt payload'); }
}

// --- WebDAV (injectable fetch; Basic auth) ---
function authHeader(o) { return o.user ? { authorization: 'Basic ' + Buffer.from(o.user + ':' + (o.pass || '')).toString('base64') } : {}; }

async function davPut(o, body) {
  const doFetch = o.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) throw new Error('no fetch available');
  const res = await doFetch(o.url, { method: 'PUT', headers: Object.assign({ 'content-type': 'application/json' }, authHeader(o)), body: body });
  if (!res || res.status >= 300) throw new Error('WebDAV PUT failed (http ' + (res && res.status) + ')');
  return true;
}
async function davGet(o) {
  const doFetch = o.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) throw new Error('no fetch available');
  const res = await doFetch(o.url, { method: 'GET', headers: authHeader(o) });
  if (res && res.status === 404) return null;
  if (!res || res.status >= 300) throw new Error('WebDAV GET failed (http ' + (res && res.status) + ')');
  return await res.text();
}

// Reachability check (any 2xx/3xx/401 = server responded).
async function test(o) {
  const doFetch = o.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) return { ok: false, reason: 'no fetch' };
  try {
    const res = await doFetch(o.url, { method: 'HEAD', headers: authHeader(o) });
    return { ok: !!res, httpStatus: res && res.status };
  } catch (e) { return { ok: false, reason: (e && e.message) || 'network' }; }
}

// Push: build the export bundle, wrap with metadata, encrypt, PUT.
async function push(ctx, o) {
  if (!o.passphrase) throw new Error('sync requires a passphrase (the payload carries secrets)');
  const bundle = transfer.buildExport(ctx).envelope;
  const wrapped = JSON.stringify({ schema: VERSION, device: o.device || 'this-device', at: ctx.now(), accounts: bundle.accounts.length, bundle: bundle });
  await davPut(o, encrypt(wrapped, o.passphrase));
  return { pushed: bundle.accounts.length };
}

// Pull: GET, decrypt, return metadata for a preview. apply() does the write.
async function pull(ctx, o) {
  if (!o.passphrase) throw new Error('sync requires a passphrase');
  const raw = await davGet(o);
  if (raw == null) return { found: false };
  const meta = JSON.parse(decrypt(raw, o.passphrase));
  return { found: true, meta: { schema: meta.schema, device: meta.device, at: meta.at, accounts: meta.accounts }, _bundle: meta.bundle };
}

// Apply a previously-pulled bundle: mandatory safety backup, then import.
function apply(ctx, pulled, opts) {
  if (!pulled || !pulled._bundle) throw new Error('nothing to apply');
  backup.create(ctx, { suffix: 'pre-sync' });
  return transfer.applyImport(ctx, pulled._bundle, { force: !!(opts && opts.force) });
}

module.exports = { encrypt: encrypt, decrypt: decrypt, test: test, push: push, pull: pull, apply: apply, VERSION: VERSION };
