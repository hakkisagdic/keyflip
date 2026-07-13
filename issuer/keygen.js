'use strict';
// KEYGEN: one-time generator of the maintainer's Ed25519 signing keypair for the
// keyflip license system. The PRIVATE key mints licenses; the PUBLIC key ships in
// src/license.js (PUBKEY_B64) so clients can VERIFY offline but never MINT.
//
// SECURITY (read before running):
//   * The PRIVATE key is the crown jewel: anyone holding it can forge any license.
//     It is written ONLY to issuer/private/issuer.key at mode 0600 and is NEVER
//     printed to stdout/stderr, logged, or passed on argv. issuer/private/ must
//     stay out of git (repo .gitignore already ignores *.key).
//   * genKeypair() returns the private key as an in-memory Buffer (PKCS8 DER). Do
//     not serialize it anywhere but the 0600 key file.
//   * The PUBLIC key is safe to publish and is the only thing printed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Generate a fresh Ed25519 keypair.
//   -> { publicKeyB64: single-line base64 of the SPKI DER (paste into license.js),
//        privateKeyDer: Buffer of the PKCS8 DER private key (write to 0600 file) }
function genKeypair() {
  const kp = crypto.generateKeyPairSync('ed25519');
  const publicKeyB64 = kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const privateKeyDer = kp.privateKey.export({ type: 'pkcs8', format: 'der' });
  return { publicKeyB64: publicKeyB64, privateKeyDer: privateKeyDer };
}

// Default on-disk location of the private key, relative to this file. An optional
// KEYFLIP_ISSUER_KEY env var relocates it (used by tests to avoid touching the repo);
// it is a PATH, not a secret, so env is an acceptable source.
function defaultKeyPath() { return process.env.KEYFLIP_ISSUER_KEY || path.join(__dirname, 'private', 'issuer.key'); }

// Persist a PKCS8 DER private key to `keyPath` at mode 0600, creating the parent
// directory (also 0700). Refuses to clobber an existing key unless force=true so a
// second run can never silently destroy the signing key. NEVER logs key bytes.
function writePrivateKey(privateKeyDer, keyPath, force) {
  const dir = path.dirname(keyPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (e) { /* best effort on platforms without full chmod */ }
  if (fs.existsSync(keyPath) && !force) {
    const err = new Error('refusing to overwrite existing key at ' + keyPath + ' (pass --force to replace it)');
    err.code = 'EEXIST';
    throw err;
  }
  // wx unless forcing; always 0600. Write raw DER bytes (what loadPrivateKey reads).
  fs.writeFileSync(keyPath, privateKeyDer, { mode: 0o600, flag: force ? 'w' : 'wx' });
  try { fs.chmodSync(keyPath, 0o600); } catch (e) { /* best effort */ }
}

// ---- CLI ---------------------------------------------------------------------
// `node issuer/keygen.js [--force]` — generate a keypair, store the private key at
// issuer/private/issuer.key (0600), and print ONLY the public key + paste hint.
function main(argv) {
  const force = argv.indexOf('--force') !== -1;
  const keyPath = defaultKeyPath();
  const kp = genKeypair();
  try {
    writePrivateKey(kp.privateKeyDer, keyPath, force);
  } catch (e) {
    process.stderr.write('keygen: ' + ((e && e.message) || e) + '\n');
    process.exitCode = 1;
    return;
  }
  // Only the PUBLIC key is ever emitted. The private key never leaves the 0600 file.
  process.stdout.write(
    'Ed25519 issuer keypair generated.\n' +
    '  private key -> ' + keyPath + ' (mode 0600, keep secret, never commit)\n\n' +
    'Paste this public key into src/license.js as PUBKEY_B64:\n\n' +
    kp.publicKeyB64 + '\n'
  );
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  genKeypair: genKeypair,
  writePrivateKey: writePrivateKey,
  defaultKeyPath: defaultKeyPath,
};
