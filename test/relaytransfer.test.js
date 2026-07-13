'use strict';
// Tests for the internet RELAY transport (relaytransfer.js). The relay is
// ZERO-KNOWLEDGE: it only ever holds CIPHERTEXT, and the slot it is keyed by is a
// PUBLIC random rendezvous handle — NOT the encryption key and NOT derived from it.
// The pairing the user copies is `<rendezvous>-<key>`: rendezvous locates the blob,
// key (never seen by the relay) decrypts it. These tests pin exactly that: the slot
// never contains the key, both backends round-trip only ciphertext, decryption
// succeeds only with the right pairing (and fails the SAME way for a wrong key as for
// corruption), the WebDAV backend addresses the slot as a single path segment, and
// awaitPickup gives the live pickup signal. No network, no clock.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const relay = require('../src/relaytransfer');
const sync = require('../src/sync');
const migrate = require('../src/migrate');
const lantransfer = require('../src/lantransfer');
const { createContext } = require('../src/context');

function tmpdir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'kf-relay-' + (tag || '') + '-')); }

// A hermetic ctx whose only portable content is a memory file, so buildBundle
// produces a real, non-empty bundle without touching a keychain or real home.
function hermeticCtx() {
  const home = tmpdir('home');
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), '# portable memory\nhello from the source machine\n');
  return createContext({
    home: home,
    configDir: path.join(home, 'kfcfg'),
    claudeDir: claudeDir,
    appDataDir: null,
    now: function () { return '2026-07-13T00:00:00.000Z'; },
    store: { getProfile: function () { return null; }, setProfile: function () {} },
  });
}

// ---- pairing: two independent random parts; the KEY never leaks into the slot ----

test('genPairing mints <rendezvous>-<key>; parsePairing splits it back', function () {
  const p = relay.genPairing();
  assert.strictEqual(p.code, p.rendezvous + '-' + p.key);
  assert.match(p.rendezvous, /^[A-HJ-NP-Z2-9]{8}$/, 'rendezvous is an 8-char base32 handle');
  assert.match(p.key, /^[A-HJ-NP-Z2-9]{12}$/, 'key is a 12-char (~60-bit) base32 secret');
  const parsed = relay.parsePairing(p.code);
  assert.deepStrictEqual(parsed, { rendezvous: p.rendezvous, key: p.key });
});

test('parsePairing requires both halves', function () {
  assert.throws(function () { return relay.parsePairing('NODASHERE'); }, /rendezvous.*key|two parts/);
  assert.throws(function () { return relay.parsePairing('ABCD1234-'); }, /incomplete|rendezvous/);
  assert.throws(function () { return relay.parsePairing('-KEYONLY'); }, /incomplete|rendezvous/);
});

test('slotFor(rendezvous) is deterministic, valid, and NEVER contains the key', function () {
  const SLOT_RE = /^[A-Za-z0-9._-]{1,128}$/;
  const p = relay.genPairing();
  const s1 = relay.slotFor(p.rendezvous);
  assert.strictEqual(s1, relay.slotFor(p.rendezvous), 'same handle => same slot');
  assert.match(s1, SLOT_RE);
  assert.ok(s1.startsWith('kf-xfer-') && s1.endsWith('.enc'));
  assert.strictEqual(s1, 'kf-xfer-' + p.rendezvous + '.enc', 'slot is the raw public handle — no hashing of any secret');
  // The load-bearing property: the ENCRYPTION KEY must not appear in the published slot.
  assert.strictEqual(s1.indexOf(p.key), -1, 'the key half must never appear in the slot');
  // Different rendezvous => different slot; normCode-insensitive on the handle.
  assert.notStrictEqual(relay.slotFor('ABCD2345'), relay.slotFor('WXYZ6789'));
  assert.strictEqual(relay.slotFor('ABCD2345'), relay.slotFor('abcd 2345'));
});

// ---- dirBackend: round-trips and refuses traversal ----

test('dirBackend round-trips put/get/del and returns null for a missing slot', async function () {
  const dir = tmpdir('dir');
  const be = relay.dirBackend(dir);
  const slot = relay.slotFor('ROUNDTRIP');
  assert.strictEqual(await be.get(slot), null, 'missing => null');
  await be.put(slot, 'CIPHERTEXT-BLOB');
  assert.strictEqual(await be.get(slot), 'CIPHERTEXT-BLOB');
  const onDisk = path.join(dir, slot);
  assert.ok(fs.existsSync(onDisk));
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(onDisk).mode & 0o777, 0o600);
  await be.del(slot);
  assert.strictEqual(await be.get(slot), null, 'deleted => null');
  await be.del(slot); // deleting a missing slot is a no-op, not an error
});

test('dirBackend REJECTS a path-traversal slot', async function () {
  const dir = tmpdir('trav');
  const be = relay.dirBackend(dir);
  await assert.rejects(function () { return be.get('..'); }, /escapes the relay dir|invalid relay slot/);
  await assert.rejects(function () { return be.put('../evil', 'x'); }, /invalid relay slot/);
  await assert.rejects(function () { return be.put('a/b', 'x'); }, /invalid relay slot/);
  await assert.rejects(function () { return be.get(''); }, /invalid relay slot/);
});

// ---- push -> pull round-trip through a dir backend ----

test('push then pull round-trips a real bundle; the relay holds only ciphertext', async function () {
  const dir = tmpdir('xfer');
  const p = relay.genPairing();
  const ctx = hermeticCtx();

  const res = await relay.push(ctx, { relay: dir, code: p.code });
  assert.strictEqual(res.slot, relay.slotFor(p.rendezvous));
  assert.ok(res.counts.memory >= 1, 'the CLAUDE.md made the bundle non-empty');

  // The relay only holds CIPHERTEXT — the plaintext bundle markers AND the key must NOT be present.
  const blob = fs.readFileSync(path.join(dir, res.slot), 'utf8');
  assert.ok(blob.indexOf('portable memory') === -1, 'plaintext memory must not be on the relay');
  assert.ok(blob.indexOf(migrate.FORMAT) === -1, 'bundle format string must not be on the relay');
  assert.ok(res.slot.indexOf(p.key) === -1 && blob.indexOf(p.key) === -1, 'the key never reaches the relay');
  assert.strictEqual(JSON.parse(blob).magic, 'keyflip-sync', 'stored blob is a sync envelope');

  // Right pairing => the bundle comes back intact.
  const ok = await relay.pull(ctx, { relay: dir, code: p.code });
  assert.strictEqual(ok.found, true);
  assert.strictEqual(ok.bundle.format, migrate.FORMAT);
  assert.ok(ok.bundle.memory.some(function (m) { return /portable memory/.test(m.content); }));

  // A different rendezvous (never pushed) simply isn't found — the relay reveals nothing.
  const otherPair = relay.genPairing();
  const other = await relay.pull(ctx, { relay: dir, code: otherPair.code });
  assert.deepStrictEqual(other, { found: false });

  // Right rendezvous, WRONG key: a blob is present but does not decrypt — throws the SAME
  // generic message as corruption, never leaking that it was specifically a bad key.
  const wrongKey = p.rendezvous + '-' + lantransfer.genCode(12);
  await assert.rejects(
    function () { return relay.pull(ctx, { relay: dir, code: wrongKey }); },
    function (e) { return /wrong code or corrupt payload/.test(e.message); }
  );
  // A corrupt/foreign ciphertext at the slot fails the same way.
  const be = relay.dirBackend(dir);
  await be.put(relay.slotFor(p.rendezvous), sync.encrypt('not-json-plaintext', p.key));
  await assert.rejects(
    function () { return relay.pull(ctx, { relay: dir, code: p.code }); },
    function (e) { return /wrong code or corrupt payload/.test(e.message); }
  );
  // restore the real blob for the cleanup assertions below.
  await relay.push(ctx, { relay: dir, code: p.code });

  const ok2 = await relay.pull(ctx, { relay: dir, code: p.code });
  assert.strictEqual(ok2.found, true);
  // one-shot cleanup: after pickup the source can delete the blob.
  await ok2.cleanup();
  const gone = await relay.pull(ctx, { relay: dir, code: p.code });
  assert.deepStrictEqual(gone, { found: false }, 'a missing blob is found=false, distinct from a throw');
});

test('push throws on an empty bundle', async function () {
  const dir = tmpdir('empty');
  const home = tmpdir('emptyhome');
  const ctx = createContext({
    home: home, configDir: path.join(home, 'kfcfg'), claudeDir: path.join(home, '.claude'),
    appDataDir: null, now: function () { return 'x'; },
    store: { getProfile: function () { return null; }, setProfile: function () {} },
  });
  await assert.rejects(
    function () { return relay.push(ctx, { relay: dir, code: relay.genPairing().code }); },
    /nothing to transfer/
  );
});

// ---- davBackend: addresses the slot as ONE path segment via an injected fetch ----

test('davBackend PUT/GET/DELETE hit joinUrl(base, slot) with the slot as one segment', async function () {
  const base = 'https://dav.example.com/keyflip/';
  const slot = relay.slotFor('DAVCODE1');
  const expectUrl = base.replace(/\/+$/, '') + '/' + slot; // slot chars are URI-unreserved -> unchanged
  assert.strictEqual(relay.joinUrl(base, slot), expectUrl);

  const calls = [];
  let stored = null;
  const fakeFetch = async function (url, init) {
    calls.push({ url: url, method: init.method, body: init.body, auth: init.headers && init.headers.authorization });
    if (init.method === 'PUT') { stored = init.body; return { status: 201, async text() { return ''; } }; }
    if (init.method === 'GET') {
      if (stored == null) return { status: 404, async text() { return ''; } };
      return { status: 200, async text() { return stored; } };
    }
    if (init.method === 'DELETE') { stored = null; return { status: 204, async text() { return ''; } }; }
    return { status: 500, async text() { return ''; } };
  };

  const be = relay.davBackend(base, 'alice', 's3cr3t', fakeFetch);

  assert.strictEqual(await be.get(slot), null, '404 => null');
  await be.put(slot, 'ENVELOPE');
  assert.strictEqual(await be.get(slot), 'ENVELOPE');
  await be.del(slot);
  assert.strictEqual(await be.get(slot), null);

  // Every request targeted exactly base/<slot> — no extra segment, no traversal.
  assert.ok(calls.length >= 4);
  calls.forEach(function (c) {
    assert.strictEqual(c.url, expectUrl, 'slot addressed as a single segment under base');
    assert.ok(c.url.indexOf('..') === -1);
    assert.match(c.auth || '', /^Basic /, 'Basic auth carried from user/pass');
  });
  assert.deepStrictEqual(calls.map(function (c) { return c.method; }), ['GET', 'PUT', 'GET', 'DELETE', 'GET']);
});

test('resolveBackend picks dav for http(s) and dir otherwise', function () {
  const dav = relay.resolveBackend('https://host/dav', { user: 'u', pass: 'p', fetch: async function () {} });
  const dir = relay.resolveBackend('/tmp/relay-folder', {});
  ['put', 'get', 'del'].forEach(function (m) {
    assert.strictEqual(typeof dav[m], 'function');
    assert.strictEqual(typeof dir[m], 'function');
  });
});

// ---- awaitPickup: live pickup signal, injected clock ----

test('awaitPickup resolves pickedUp=true when the blob is deleted (get() -> null)', async function () {
  let n = 0;
  const backend = { async get() { n++; return n >= 3 ? null : 'still-there'; } };
  let t = 0;
  const now = function () { return t; };
  const sleep = async function (ms) { t += ms; };
  const r = await relay.awaitPickup(backend, 'ABCD1234-MNBVCXZLKJHG', { pollMs: 1000, ttlMs: 60000, now: now, sleep: sleep });
  assert.deepStrictEqual(r, { pickedUp: true });
  assert.strictEqual(n, 3, 'stopped as soon as the blob vanished');
});

test('awaitPickup resolves pickedUp=false at TTL when the blob never leaves', async function () {
  const backend = { async get() { return 'never-picked-up'; } };
  let t = 0;
  const now = function () { return t; };
  const sleep = async function (ms) { t += ms; };
  const r = await relay.awaitPickup(backend, 'ABCD1234-MNBVCXZLKJHG', { pollMs: 1000, ttlMs: 3000, now: now, sleep: sleep });
  assert.deepStrictEqual(r, { pickedUp: false });
});
