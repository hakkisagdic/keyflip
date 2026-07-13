'use strict';
// Roadmap #10(b): the INTERNET RELAY transport for `keyflip transfer` — the same
// one-time-CODE, ephemeral, one-shot UX as the LAN path, but the encrypted bundle
// travels THROUGH a user-controlled relay (a plain directory that both machines can
// reach — e.g. Dropbox/iCloud/a shared mount — or a WebDAV server) instead of a
// direct LAN socket. Two interchangeable backends, auto-detected from --relay.
//
// SECURITY MODEL — the relay is ZERO-KNOWLEDGE. It only ever stores/serves
// CIPHERTEXT (sync.encrypt: AES-256-GCM, scrypt-derived key, per-call random salt).
//
// The pairing string the user copies is TWO independent random parts joined by a dash:
//     <rendezvous>-<key>       e.g.  8LS9DZ7R-2GQ26Z2H2EY3
//   * `rendezvous` (8 base32 chars) is a PUBLIC, RANDOM lookup handle. The relay slot
//     is literally 'kf-xfer-<rendezvous>.enc' — NOTHING about it is derived from the
//     secret, so an attacker who reads the slot name learns nothing that helps decrypt.
//     (The earlier design hashed the code into the slot; that was a fast-hash offline
//     ORACLE for the code and was removed — the slot must never be a function of the key.)
//   * `key` (12 base32 chars, ~60 bits) is the AES passphrase — the ONLY confidentiality
//     boundary. It NEVER reaches the relay, a slot name, a URL, or a log. sync.encrypt
//     runs scrypt over it with a per-call random salt, so an offline guess is memory-hard.
//   * Both machines split the same pairing to rendezvous (find the blob) + key (decrypt).
//   * One-shot: after the receiver picks up + decrypts, it DELETES the blob (cleanup());
//     the source's awaitPickup() sees it vanish and reports the live "picked up" signal.
const fs = require('fs');
const path = require('path');
const sync = require('./sync');
const migrate = require('./migrate');
const fsutil = require('./fsutil');
const lantransfer = require('./lantransfer');

// The same slot grammar the relay server enforces: a single, harmless path segment.
const SLOT_RE = /^[A-Za-z0-9._-]{1,128}$/;

function normCode(code) { return lantransfer.normCode(code); }

// Mint a fresh pairing: a random public rendezvous handle + a random secret key,
// shown to the user as one dash-joined string. rendezvous is 8 base32 chars (a handle
// needs no secrecy — a guesser only reaches ciphertext they still can't read); key is
// 12 chars (~60 bits), the real confidentiality boundary.
function genPairing() {
  const rendezvous = lantransfer.genCode(8);
  const key = lantransfer.genCode(12);
  return { rendezvous: rendezvous, key: key, code: rendezvous + '-' + key };
}

// Split a pairing string into { rendezvous, key }. The dash separates the two parts, so
// we MUST split before normalizing (normCode strips the dash). Both parts are required.
function parsePairing(code) {
  const raw = String(code == null ? '' : code);
  const dash = raw.indexOf('-');
  if (dash === -1) throw new Error('a relay code looks like <rendezvous>-<key> (two parts joined by a dash)');
  const rendezvous = normCode(raw.slice(0, dash));
  const key = normCode(raw.slice(dash + 1));
  if (!rendezvous || !key) throw new Error('incomplete relay code — expected <rendezvous>-<key>');
  return { rendezvous: rendezvous, key: key };
}

// The relay SLOT for a rendezvous handle. The handle is a PUBLIC random token, NOT the
// key and NOT derived from it — so publishing the slot leaks nothing about the secret.
function slotFor(rendezvous) {
  const h = normCode(rendezvous);
  if (!h || !SLOT_RE.test('kf-xfer-' + h + '.enc')) throw new Error('invalid rendezvous handle');
  return 'kf-xfer-' + h + '.enc';
}

// Validate a slot against the shared grammar (used before every backend touch so a
// malformed/hostile slot can never widen the write surface).
function assertSlot(slot) {
  if (typeof slot !== 'string' || !SLOT_RE.test(slot)) throw new Error('invalid relay slot');
  return slot;
}

// --- backend: a plain directory (filesystem relay) ---
// put/get/del of a single slot file, confined to `dir` and written 0600. SLOT_RE
// already forbids '/' and NUL, but '..' matches the grammar, so we ALSO confine the
// resolved path under dir (path-traversal-safe) — same belt-and-braces the server uses.
function dirBackend(dir) {
  const root = path.resolve(dir);
  function pathFor(slot) {
    assertSlot(slot);
    const dest = path.resolve(root, slot);
    if (dest !== root && dest.indexOf(root + path.sep) !== 0) throw new Error('relay slot escapes the relay dir');
    return dest;
  }
  return {
    async put(slot, data) {
      const p = pathFor(slot);
      fs.mkdirSync(root, { recursive: true });
      fsutil.atomicWrite(p, data, 0o600);
      return true;
    },
    async get(slot) {
      const p = pathFor(slot);
      try { return fs.readFileSync(p, 'utf8'); }
      catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
    },
    async del(slot) {
      const p = pathFor(slot);
      try { fs.unlinkSync(p); } catch (e) { if (!(e && e.code === 'ENOENT')) throw e; }
      return true;
    },
  };
}

// Append `slot` to `baseUrl` as ONE path segment. encodeURIComponent escapes any
// '/', so the slot can never inject an extra segment or a '..'; SLOT_RE's chars are
// all URI-unreserved, so a valid slot passes through byte-for-byte.
function joinUrl(baseUrl, slot) {
  return String(baseUrl).replace(/\/+$/, '') + '/' + encodeURIComponent(slot);
}

// --- backend: WebDAV (via sync's injectable-fetch helpers) ---
function davBackend(baseUrl, user, pass, doFetch) {
  function opt(slot) {
    assertSlot(slot);
    return { url: joinUrl(baseUrl, slot), user: user, pass: pass, fetch: doFetch };
  }
  return {
    async put(slot, data) { return sync.davPut(opt(slot), data); },
    async get(slot) { return sync.davGet(opt(slot)); },
    async del(slot) { return sync.davDelete(opt(slot)); },
  };
}

// Auto-detect the backend from the --relay value: an http(s) URL => WebDAV, else a
// filesystem directory. `fetch` is injected (tests/offline) through opts.
function resolveBackend(relay, opts) {
  opts = opts || {};
  if (/^https?:\/\//i.test(relay)) return davBackend(relay, opts.user, opts.pass, opts.fetch);
  return dirBackend(relay);
}

// PUSH: build the portable bundle, encrypt it with the code, and store the ciphertext
// at the code-derived slot. Returns { slot, counts }. Throws on an empty bundle.
async function push(ctx, opts) {
  opts = opts || {};
  const pair = parsePairing(opts.code);
  const backend = resolveBackend(opts.relay, opts);
  const built = migrate.buildBundle(ctx, opts);
  const c = built.counts;
  if (!c.accounts && !c.providers && !c.transcripts && !c.memory && !c.config && !c.agents && !c.agentConfig) {
    throw new Error('nothing to transfer');
  }
  const enc = sync.encrypt(JSON.stringify(built.bundle), pair.key); // encrypt with the KEY half only
  const slot = slotFor(pair.rendezvous);                           // store at the PUBLIC handle
  await backend.put(slot, enc);
  return { slot: slot, counts: c };
}

// PULL: fetch the ciphertext at the code-derived slot and decrypt with the code.
//   * No blob            => { found:false }.
//   * Blob but bad code  => throw 'wrong code or corrupt payload' (the SAME message
//     for a wrong code and a corrupt/mismatched envelope — never leak WHICH, so an
//     attacker can't use the error to distinguish a near-miss code).
// Does NOT auto-apply: the CLI previews + confirms, applies via migrate.applyBundle,
// then calls cleanup() for the one-shot delete.
async function pull(ctx, opts) {
  opts = opts || {};
  const pair = parsePairing(opts.code);
  const backend = resolveBackend(opts.relay, opts);
  const slot = slotFor(pair.rendezvous);
  const enc = await backend.get(slot);
  if (enc == null) return { found: false };
  let bundle;
  try { bundle = JSON.parse(sync.decrypt(enc, pair.key)); }
  catch (e) { throw new Error('wrong code or corrupt payload'); }
  return {
    found: true,
    bundle: bundle,
    cleanup: async function () { return backend.del(slot); },
  };
}

// Give the SOURCE terminal a "live" feel: poll the slot until it disappears (the
// receiver deleted it after a successful pickup) or the TTL elapses. now()/sleep()
// are injectable so tests need no real clock. Resolves { pickedUp: boolean }.
async function awaitPickup(backend, code, opts) {
  opts = opts || {};
  const pollMs = opts.pollMs != null ? opts.pollMs : 2000;
  const ttlMs = opts.ttlMs != null ? opts.ttlMs : 300000;
  const now = opts.now || Date.now;
  const sleep = opts.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const slot = slotFor(parsePairing(code).rendezvous);
  const start = now();
  for (;;) {
    const v = await backend.get(slot);
    if (v == null) return { pickedUp: true };
    if (now() - start >= ttlMs) return { pickedUp: false };
    await sleep(pollMs);
  }
}

module.exports = {
  push: push,
  pull: pull,
  awaitPickup: awaitPickup,
  genPairing: genPairing,
  parsePairing: parsePairing,
  slotFor: slotFor,
  resolveBackend: resolveBackend,
  dirBackend: dirBackend,
  davBackend: davBackend,
  joinUrl: joinUrl,
  normCode: normCode,
};
