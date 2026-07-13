'use strict';
// Tests for issuer/keygen.js — zero-dep (node:test + node:assert). Proves the
// keypair is a usable Ed25519 pair, the public key is the exact SPKI-DER base64
// that src/license.js consumes, and that the CLI file-writing helper enforces
// 0600 + no-clobber. NEVER asserts on / prints private-key bytes beyond what a
// round-trip sign requires in-process.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const keygen = require('./keygen');
const { signLicense } = require('./sign');
const license = require('../src/license');

test('genKeypair returns a single-line SPKI-DER base64 public key and PKCS8 DER private buffer', function () {
  const kp = keygen.genKeypair();
  assert.strictEqual(typeof kp.publicKeyB64, 'string');
  assert.ok(kp.publicKeyB64.length > 0);
  assert.ok(!/\s/.test(kp.publicKeyB64), 'public key must be a single line (no whitespace)');
  assert.ok(Buffer.isBuffer(kp.privateKeyDer), 'private key must be a Buffer');
  // Public b64 must parse as an Ed25519 SPKI key (the shape license.js loads).
  const pub = crypto.createPublicKey({ key: Buffer.from(kp.publicKeyB64, 'base64'), format: 'der', type: 'spki' });
  assert.strictEqual(pub.asymmetricKeyType, 'ed25519');
  // Private DER must parse as the matching Ed25519 PKCS8 key.
  const priv = crypto.createPrivateKey({ key: kp.privateKeyDer, format: 'der', type: 'pkcs8' });
  assert.strictEqual(priv.asymmetricKeyType, 'ed25519');
});

test('the generated pair round-trips through src/license.js verify()', function () {
  const kp = keygen.genKeypair();
  license.setPublicKey(kp.publicKeyB64);
  const priv = crypto.createPrivateKey({ key: kp.privateKeyDer, format: 'der', type: 'pkcs8' });
  const token = signLicense({ tier: 'pro', email: 'k@e.co', expiry: null, issued: '2026-01-01T00:00:00.000Z' }, priv);
  const v = license.verify(token, { now: function () { return '2026-06-01T00:00:00.000Z'; } });
  assert.strictEqual(v.valid, true);
  assert.strictEqual(v.tier, 'pro');
});

test('writePrivateKey writes mode 0600 and refuses to overwrite without force', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-keygen-'));
  const keyPath = path.join(dir, 'private', 'issuer.key');
  const kp = keygen.genKeypair();

  keygen.writePrivateKey(kp.privateKeyDer, keyPath, false);
  const mode = fs.statSync(keyPath).mode & 0o777;
  assert.strictEqual(mode, 0o600, 'key file must be 0600, got 0' + mode.toString(8));
  // Bytes on disk must equal what we wrote (raw DER, loadable back).
  assert.ok(fs.readFileSync(keyPath).equals(kp.privateKeyDer));

  // Second write without force must throw EEXIST and leave the file untouched.
  assert.throws(function () { keygen.writePrivateKey(keygen.genKeypair().privateKeyDer, keyPath, false); }, /EEXIST|refusing to overwrite/);
  assert.ok(fs.readFileSync(keyPath).equals(kp.privateKeyDer), 'original key must be intact after refused overwrite');

  // With force it replaces the key.
  const kp2 = keygen.genKeypair();
  keygen.writePrivateKey(kp2.privateKeyDer, keyPath, true);
  assert.ok(fs.readFileSync(keyPath).equals(kp2.privateKeyDer));
  assert.strictEqual(fs.statSync(keyPath).mode & 0o777, 0o600);
});

test('CLI prints the public key and NEVER the private key', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-keygen-cli-'));
  const keyPath = path.join(dir, 'private', 'issuer.key');
  const env = Object.assign({}, process.env, { KEYFLIP_ISSUER_KEY: keyPath });
  const out = require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'keygen.js')], {
    cwd: dir, encoding: 'utf8', env: env,
  });
  // The private key landed only at the redirected 0600 path, never in the repo.
  assert.strictEqual(fs.statSync(keyPath).mode & 0o777, 0o600);
  assert.ok(/Paste this public key/.test(out));
  const printedB64 = out.trim().split('\n').pop().trim();
  const pub = crypto.createPublicKey({ key: Buffer.from(printedB64, 'base64'), format: 'der', type: 'spki' });
  assert.strictEqual(pub.asymmetricKeyType, 'ed25519');
  // The private key must not appear anywhere in stdout.
  assert.ok(!/PRIVATE KEY/.test(out), 'stdout must not contain a private key');
});
