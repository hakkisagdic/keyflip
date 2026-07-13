'use strict';
// ISSUER / server.test.js — zero-dep (node:test + node:assert) coverage for the
// webhook->mint router in server.js.
//
// What it proves:
//   * GET /health -> 200 {ok:true}.
//   * POST /webhook/:provider with a BAD signature -> 401 and NO license minted.
//   * POST with a GOOD signature (a real HMAC computed here) -> 200 {issued:true}
//     and exactly one mint.
//   * A REPLAY of the same orderId -> 200 but NOT minted a second time.
//   * CRYPTO ROUND-TRIP: the token our injected signer produces (built to the
//     license.js contract byte-for-byte) verifies GREEN in src/license.js when
//     that module's public key is set to our throwaway keypair's public key.
//
// Isolation: the router is driven with STUB dependencies (a fake HMAC adapter, a
// tiny product->tier map, and a throwaway Ed25519 signer). No real provider
// crypto, no real issuer private key, no disk secrets.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { createIssuer } = require('./server');
const license = require('../src/license');

// ---- crypto contract helpers (mirror src/license.js EXACTLY) -----------------
function b64u(buf) { return Buffer.from(buf).toString('base64url'); }

// canonicalPayload — same fixed key order + coercion as license.js.
function canonicalPayload(p) {
  return JSON.stringify({
    email: p.email == null ? '' : String(p.email),
    expiry: p.expiry == null ? null : String(p.expiry),
    issued: p.issued == null ? '' : String(p.issued),
    tier: p.tier == null ? '' : String(p.tier),
  });
}

// Mint a token independently of license.js (crypto.sign(null,...) = Ed25519 pure)
// so the round-trip is a genuine cross-check, not license.js verifying its own
// helper.
function signToContract(privKey, payload) {
  const canonical = canonicalPayload(payload);
  const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), privKey);
  return b64u(Buffer.from(canonical, 'utf8')) + '.' + b64u(sig);
}

// A throwaway keypair. Public key is the single-line base64 SPKI DER that a
// maintainer would paste into license.js PUBKEY_B64.
function makeKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spkiB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  return { publicKey, privateKey, spkiB64 };
}

// ---- a stub provider adapter (HMAC-SHA256 over the raw body) ------------------
// Matches the shared adapter interface: verifyWebhook + parseEvent, timing-safe.
function makeHmacAdapter() {
  return {
    id: 'stub',
    verifyWebhook: function (rawBody, headers, secret) {
      const sig = headers['x-stub-signature'];
      if (typeof sig !== 'string') return { ok: false, reason: 'missing-sig' };
      const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      const a = Buffer.from(sig, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      if (a.length !== b.length) return { ok: false, reason: 'bad-sig' };
      if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad-sig' };
      return { ok: true };
    },
    parseEvent: function (rawBody /*, headers */) {
      const o = JSON.parse(rawBody.toString('utf8'));
      return { type: o.type, email: o.email, product: o.product, orderId: o.orderId, raw: o };
    },
  };
}

// ---- harness: build an issuer with injected stubs + a live server ------------
function buildHarness(overrides) {
  overrides = overrides || {};
  const kp = overrides.kp || makeKeypair();
  const secret = overrides.secret || ('whsec_test_' + crypto.randomBytes(6).toString('hex'));
  const state = { mintCount: 0, lastToken: null, lastPayload: null };

  const issuer = createIssuer(Object.assign({
    resolveAdapter: function () { return makeHmacAdapter(); },
    secretForProvider: function () { return secret; },
    productToTier: function (product) { return ({ 'plan-pro': 'pro', 'plan-team': 'team' })[product] || null; },
    signLicense: function (payload) {
      state.mintCount++;
      state.lastPayload = payload;
      const token = signToContract(kp.privateKey, payload);
      state.lastToken = token;
      return token;
    },
    log: function () { /* silence */ },
    ledgerFile: overrides.ledgerFile || null,
  }, overrides.deps || {}));

  return { issuer: issuer, secret: secret, state: state, kp: kp };
}

function listen(server) {
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () { resolve(server.address().port); });
  });
}

function request(port, method, urlPath, body, headers) {
  return new Promise(function (resolve, reject) {
    const data = body == null ? null : Buffer.from(body);
    const req = http.request({
      host: '127.0.0.1', port: port, method: method, path: urlPath,
      headers: Object.assign(data ? { 'content-length': data.length } : {}, headers || {}),
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* leave null */ }
        resolve({ status: res.statusCode, json: json, raw: raw });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function hmacHex(secret, raw) {
  return crypto.createHmac('sha256', secret).update(Buffer.from(raw)).digest('hex');
}

// -----------------------------------------------------------------------------

test('GET /health -> 200 {ok:true}', async function (t) {
  const h = buildHarness();
  const port = await listen(h.issuer.server);
  t.after(function () { h.issuer.server.close(); });

  const res = await request(port, 'GET', '/health');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.json, { ok: true });
});

test('POST with a BAD signature -> 401 and nothing minted', async function (t) {
  const h = buildHarness();
  const port = await listen(h.issuer.server);
  t.after(function () { h.issuer.server.close(); });

  const body = JSON.stringify({ type: 'purchase', email: 'a@b.co', product: 'plan-pro', orderId: 'ord_bad_1' });
  const res = await request(port, 'POST', '/webhook/stub', body, { 'x-stub-signature': 'deadbeef' });

  assert.strictEqual(res.status, 401);
  assert.strictEqual(h.state.mintCount, 0, 'a bad signature must never mint');
  assert.ok(!h.issuer.ledger.has('ord_bad_1'), 'ledger must not record a rejected webhook');
});

test('POST with a GOOD signature -> 200 {issued:true, tier} and minted once', async function (t) {
  const h = buildHarness();
  const port = await listen(h.issuer.server);
  t.after(function () { h.issuer.server.close(); });

  const body = JSON.stringify({ type: 'purchase', email: 'buyer@x.io', product: 'plan-pro', orderId: 'ord_good_1' });
  const sig = hmacHex(h.secret, body);
  const res = await request(port, 'POST', '/webhook/stub', body, { 'x-stub-signature': sig });

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.json, { issued: true, tier: 'pro' });
  assert.strictEqual(h.state.mintCount, 1);
  assert.strictEqual(res.raw.indexOf(h.state.lastToken), -1, 'the HTTP response must NOT leak the token');
});

test('REPLAY of the same orderId -> 200 but not minted twice', async function (t) {
  const h = buildHarness();
  const port = await listen(h.issuer.server);
  t.after(function () { h.issuer.server.close(); });

  const body = JSON.stringify({ type: 'purchase', email: 'buyer@x.io', product: 'plan-team', orderId: 'ord_replay_1' });
  const sig = hmacHex(h.secret, body);

  const first = await request(port, 'POST', '/webhook/stub', body, { 'x-stub-signature': sig });
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.json.issued, true);
  assert.strictEqual(first.json.tier, 'team');

  const second = await request(port, 'POST', '/webhook/stub', body, { 'x-stub-signature': sig });
  assert.strictEqual(second.status, 200);
  assert.strictEqual(second.json.issued, true, 'a replay still reports issued (already have a license)');
  assert.strictEqual(second.json.idempotent, true);

  assert.strictEqual(h.state.mintCount, 1, 'a replayed webhook must not double-issue');
});

test('CRYPTO ROUND-TRIP: a minted token verifies green in src/license.js', async function (t) {
  const h = buildHarness();
  const port = await listen(h.issuer.server);
  t.after(function () {
    h.issuer.server.close();
    license.setPublicKey(license.PUBKEY_B64); // restore the placeholder for other tests
  });

  const body = JSON.stringify({ type: 'purchase', email: 'roundtrip@x.io', product: 'plan-pro', orderId: 'ord_rt_1' });
  const sig = hmacHex(h.secret, body);
  const res = await request(port, 'POST', '/webhook/stub', body, { 'x-stub-signature': sig });
  assert.strictEqual(res.status, 200);

  // Point license.js at OUR throwaway public key, then verify the token the
  // issuer just minted (captured via the injected signer).
  license.setPublicKey(h.kp.spkiB64);
  const token = h.state.lastToken;
  assert.ok(token, 'signer should have produced a token');

  const v = license.verify(token);
  assert.strictEqual(v.valid, true, 'issuer-minted token must verify valid in license.js: ' + v.reason);
  assert.strictEqual(v.tier, 'pro');
  assert.strictEqual(v.email, 'roundtrip@x.io');
});

test('unknown provider -> 404 and no mint', async function (t) {
  const h = buildHarness({ deps: { resolveAdapter: function () { return null; } } });
  const port = await listen(h.issuer.server);
  t.after(function () { h.issuer.server.close(); });

  const body = JSON.stringify({ type: 'purchase', product: 'plan-pro', orderId: 'ord_x' });
  const res = await request(port, 'POST', '/webhook/nope', body, { 'x-stub-signature': 'x' });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(h.state.mintCount, 0);
});

test('a path-traversal provider name is rejected (400) before any adapter load', async function (t) {
  // resolveAdapter throws if reached — proves the router rejects on charset first.
  const h = buildHarness({ deps: { resolveAdapter: function () { throw new Error('resolveAdapter must not be called'); } } });
  const port = await listen(h.issuer.server);
  t.after(function () { h.issuer.server.close(); });

  const res = await request(port, 'POST', '/webhook/..%2F..%2Fetc', '{}', { 'x-stub-signature': 'x' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(h.state.mintCount, 0);
});

test('non-purchase event is acknowledged without minting', async function (t) {
  const h = buildHarness();
  const port = await listen(h.issuer.server);
  t.after(function () { h.issuer.server.close(); });

  const body = JSON.stringify({ type: 'refund', product: 'plan-pro', orderId: 'ord_refund_1' });
  const sig = hmacHex(h.secret, body);
  const res = await request(port, 'POST', '/webhook/stub', body, { 'x-stub-signature': sig });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.issued, false);
  assert.strictEqual(h.state.mintCount, 0);
});

test('ledger.json persists metadata (not the token) and dedups across restart', async function (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-ledger-'));
  const ledgerFile = path.join(dir, 'ledger.json');
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });

  const kp = makeKeypair();
  const sharedSecret = 'whsec_persist_' + crypto.randomBytes(6).toString('hex');
  const h1 = buildHarness({ kp: kp, secret: sharedSecret, ledgerFile: ledgerFile });
  const port1 = await listen(h1.issuer.server);

  const body = JSON.stringify({ type: 'purchase', email: 'p@x.io', product: 'plan-pro', orderId: 'ord_persist_1' });
  const sig = hmacHex(h1.secret, body);
  const r1 = await request(port1, 'POST', '/webhook/stub', body, { 'x-stub-signature': sig });
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(h1.state.mintCount, 1);
  h1.issuer.server.close();

  // The persisted file must exist and must NOT contain the minted token.
  const onDisk = fs.readFileSync(ledgerFile, 'utf8');
  assert.ok(onDisk.indexOf('ord_persist_1') !== -1, 'orderId should be persisted');
  assert.strictEqual(onDisk.indexOf(h1.state.lastToken), -1, 'ledger file must never contain the token');

  // A fresh issuer sharing the same file must refuse to re-mint the same order.
  const h2 = buildHarness({ kp: kp, secret: sharedSecret, ledgerFile: ledgerFile });
  const port2 = await listen(h2.issuer.server);
  t.after(function () { h2.issuer.server.close(); });
  const r2 = await request(port2, 'POST', '/webhook/stub', body, { 'x-stub-signature': sig });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.json.idempotent, true);
  assert.strictEqual(h2.state.mintCount, 0, 'a restart must not re-mint a persisted order');
});
