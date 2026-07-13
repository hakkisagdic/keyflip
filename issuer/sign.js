'use strict';
// SIGN: mint a keyflip license TOKEN with the maintainer's Ed25519 PRIVATE key.
// A token is `base64url(canonicalJSON) . base64url(ed25519Signature)` and MUST
// verify green in src/license.js verify() when that file's PUBKEY_B64 is the
// matching public key. The canonical payload here is byte-for-byte identical to
// src/license.js canonicalPayload() (fixed key order: email, expiry, issued, tier).
//
// SECURITY (read before running):
//   * The signing key is read ONLY from issuer/private/issuer.key (0600). It is
//     NEVER accepted on argv, never printed, never logged. A leaked key forges any
//     license, so keep it off git and out of shell history.
//   * CLI takes only license CONTENT flags (--tier/--email/--expiry/--issued); the
//     key path is fixed, not user-supplied, so it can't be pointed at a file whose
//     bytes then leak into logs.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// base64url without padding — matches Buffer.toString('base64url') used by license.js.
function b64uEnc(buf) { return Buffer.from(buf).toString('base64url'); }

// EXACT canonical bytes that get signed. Must equal src/license.js canonicalPayload():
// keys in alphabetical order (email, expiry, issued, tier); email/issued/tier coerce
// to '' when null/undefined, expiry coerces to null when null/undefined else String.
function canonicalPayload(p) {
  p = p || {};
  return JSON.stringify({
    email: p.email == null ? '' : String(p.email),
    expiry: p.expiry == null ? null : String(p.expiry),
    issued: p.issued == null ? '' : String(p.issued),
    tier: p.tier == null ? '' : String(p.tier),
  });
}

// Default location of the issuer private key. KEYFLIP_ISSUER_KEY (a path, not a
// secret) relocates it, matching keygen.js so keygen+sign agree in tests.
function defaultKeyPath() { return process.env.KEYFLIP_ISSUER_KEY || path.join(__dirname, 'private', 'issuer.key'); }

// Read the PKCS8 DER private key written by keygen.js and return a KeyObject.
// Accepts either raw DER bytes (what keygen writes) or a PEM/base64 text file, so a
// key exported in either form still loads. Returns a crypto KeyObject (never bytes).
function loadPrivateKey(keyPath) {
  keyPath = keyPath || defaultKeyPath();
  const raw = fs.readFileSync(keyPath); // Buffer
  const head = raw.slice(0, 32).toString('utf8');
  if (head.indexOf('-----BEGIN') !== -1) {
    // PEM text
    return crypto.createPrivateKey({ key: raw.toString('utf8'), format: 'pem' });
  }
  // Heuristic: a base64-DER text file is all base64 chars/whitespace; raw DER isn't.
  const txt = raw.toString('utf8').trim();
  if (/^[A-Za-z0-9+/=\s]+$/.test(txt) && raw[0] !== 0x30) {
    return crypto.createPrivateKey({ key: Buffer.from(txt, 'base64'), format: 'der', type: 'pkcs8' });
  }
  // Raw DER (SEQUENCE tag 0x30 …)
  return crypto.createPrivateKey({ key: raw, format: 'der', type: 'pkcs8' });
}

// signLicense({tier,email,expiry,issued}, privateKey) -> token string.
// privateKey may be a KeyObject, a PEM/DER string, or a Buffer; anything non-object
// is coerced via createPrivateKey. Pure Ed25519 (algorithm = null).
function signLicense(fields, privateKey) {
  fields = fields || {};
  const canonical = canonicalPayload({
    tier: fields.tier,
    email: fields.email,
    expiry: fields.expiry,
    issued: fields.issued,
  });
  const key = (privateKey && typeof privateKey === 'object' && !Buffer.isBuffer(privateKey))
    ? privateKey
    : crypto.createPrivateKey(privateKey);
  const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), key);
  return b64uEnc(Buffer.from(canonical, 'utf8')) + '.' + b64uEnc(sig);
}

// ---- CLI ---------------------------------------------------------------------
// Minimal `--flag value` parser (no deps). Unknown flags are ignored.
function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.slice(0, 2) === '--') {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.slice(0, 2) === '--') { out[key] = true; }
      else { out[key] = next; i++; }
    }
  }
  return out;
}

// `node issuer/sign.js --tier pro --email a@b.co [--expiry ISO] [--issued ISO]`
// Reads the key from issuer/private/issuer.key (NEVER from argv) and prints only
// the token. --expiry omitted => perpetual (null). --issued omitted => now.
function main(argv) {
  const f = parseFlags(argv);
  if (!f.tier || typeof f.tier !== 'string') {
    process.stderr.write('sign: --tier is required (free|pro|team|enterprise)\n');
    process.exitCode = 1;
    return;
  }
  let key;
  try {
    key = loadPrivateKey(defaultKeyPath());
  } catch (e) {
    process.stderr.write('sign: cannot load issuer key (' + defaultKeyPath() + '): ' + ((e && e.message) || e) + '\n');
    process.stderr.write('      run `node issuer/keygen.js` first.\n');
    process.exitCode = 1;
    return;
  }
  const token = signLicense({
    tier: f.tier,
    email: typeof f.email === 'string' ? f.email : '',
    expiry: typeof f.expiry === 'string' ? f.expiry : null,
    issued: typeof f.issued === 'string' ? f.issued : new Date().toISOString(),
  }, key);
  process.stdout.write(token + '\n');
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  signLicense: signLicense,
  loadPrivateKey: loadPrivateKey,
  canonicalPayload: canonicalPayload,
  defaultKeyPath: defaultKeyPath,
};
