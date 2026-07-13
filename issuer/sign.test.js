'use strict';
// Tests for issuer/sign.js — zero-dep (node:test + node:assert). The load-bearing
// proof is the round-trip: a token minted by signLicense() verifies GREEN in
// src/license.js verify() once its public key is injected. Also proves tampering
// any field flips verify to invalid, that an expired expiry yields valid=false,
// that loadPrivateKey round-trips the on-disk key, and that the CLI reads the key
// from disk (never argv) and prints only the token.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sign = require('./sign');
const keygen = require('./keygen');
const license = require('../src/license');

const NOW = function () { return '2026-06-01T00:00:00.000Z'; };

// A throwaway issuer keypair pinned into license.js for the whole offline path.
function pinFreshKeys() {
  const kp = keygen.genKeypair();
  license.setPublicKey(kp.publicKeyB64);
  return {
    priv: crypto.createPrivateKey({ key: kp.privateKeyDer, format: 'der', type: 'pkcs8' }),
    privDer: kp.privateKeyDer,
    pubB64: kp.publicKeyB64,
  };
}

test('round-trip: a signed token verifies GREEN in src/license.js', function () {
  const k = pinFreshKeys();
  const token = sign.signLicense({ tier: 'pro', email: 'a@b.co', expiry: '2030-01-01T00:00:00.000Z', issued: '2026-01-01T00:00:00.000Z' }, k.priv);
  const v = license.verify(token, { now: NOW });
  assert.strictEqual(v.valid, true);
  assert.strictEqual(v.tier, 'pro');
  assert.strictEqual(v.email, 'a@b.co');
  assert.strictEqual(v.expiry, '2030-01-01T00:00:00.000Z');
  assert.strictEqual(v.reason, 'ok');
});

test('signLicense canonical bytes match src/license.js exactly', function () {
  // Same fields -> identical canonical JSON in both modules (byte-for-byte contract).
  const fields = { tier: 'team', email: 'x@y.z', expiry: null, issued: '2026-01-01T00:00:00.000Z' };
  assert.strictEqual(sign.canonicalPayload(fields), license.canonicalPayload(fields));
  // And a token minted here equals one minted by license.makeLicense with the same key.
  const k = pinFreshKeys();
  const mine = sign.signLicense(fields, k.priv);
  const theirs = license.makeLicense(k.priv, fields);
  assert.strictEqual(mine, theirs);
});

test('tampering ANY field flips verify to invalid (bad-signature)', function () {
  const k = pinFreshKeys();
  const token = sign.signLicense({ tier: 'pro', email: 'a@b.co', expiry: null, issued: '2026-01-01T00:00:00.000Z' }, k.priv);
  const parts = token.split('.');
  const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));

  ['tier', 'email', 'issued'].forEach(function (field) {
    const mutated = Object.assign({}, payload);
    mutated[field] = String(mutated[field]) + 'X';
    const forged = Buffer.from(license.canonicalPayload(mutated), 'utf8').toString('base64url') + '.' + parts[1];
    const v = license.verify(forged, { now: NOW });
    assert.strictEqual(v.valid, false, 'tampering ' + field + ' should invalidate');
    assert.strictEqual(v.reason, 'bad-signature');
  });

  // Upgrading the tier to 'enterprise' (privilege escalation) must also fail.
  const esc = Object.assign({}, payload, { tier: 'enterprise' });
  const forgedEsc = Buffer.from(license.canonicalPayload(esc), 'utf8').toString('base64url') + '.' + parts[1];
  assert.strictEqual(license.verify(forgedEsc, { now: NOW }).valid, false);
});

test('an expired expiry yields valid=false in src/license.js', function () {
  const k = pinFreshKeys();
  const token = sign.signLicense({ tier: 'pro', email: 'a@b.co', expiry: '2026-01-01T00:00:00.000Z', issued: '2025-01-01T00:00:00.000Z' }, k.priv);
  const v = license.verify(token, { now: NOW }); // NOW (2026-06) is past the 2026-01 expiry
  assert.strictEqual(v.valid, false);
  assert.strictEqual(v.reason, 'expired');
  assert.strictEqual(v.tier, 'pro'); // signature is genuine, so claimed tier still surfaces
});

test('loadPrivateKey round-trips the on-disk key and signs a verifiable token', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-sign-'));
  const keyPath = path.join(dir, 'private', 'issuer.key');
  const kp = keygen.genKeypair();
  keygen.writePrivateKey(kp.privateKeyDer, keyPath, false);
  license.setPublicKey(kp.publicKeyB64);

  const key = sign.loadPrivateKey(keyPath);
  assert.strictEqual(key.asymmetricKeyType, 'ed25519');
  const token = sign.signLicense({ tier: 'pro', email: 'd@e.f', expiry: null, issued: '2026-01-01T00:00:00.000Z' }, key);
  assert.strictEqual(license.verify(token, { now: NOW }).valid, true);
});

test('CLI reads the key from disk (not argv) and prints only the token', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-sign-cli-'));
  const keyPath = path.join(dir, 'private', 'issuer.key');
  const kp = keygen.genKeypair();
  keygen.writePrivateKey(kp.privateKeyDer, keyPath, false);
  license.setPublicKey(kp.publicKeyB64);

  const env = Object.assign({}, process.env, { KEYFLIP_ISSUER_KEY: keyPath });
  const out = require('child_process').execFileSync(process.execPath, [
    path.join(__dirname, 'sign.js'), '--tier', 'pro', '--email', 'cli@e.co',
    '--expiry', '2030-01-01T00:00:00.000Z', '--issued', '2026-01-01T00:00:00.000Z',
  ], { cwd: dir, encoding: 'utf8', env: env });

  const token = out.trim();
  assert.ok(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token), 'stdout must be exactly one token');
  const v = license.verify(token, { now: NOW });
  assert.strictEqual(v.valid, true);
  assert.strictEqual(v.email, 'cli@e.co');
});
