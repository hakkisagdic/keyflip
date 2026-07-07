'use strict';
// Tests for the Windows app-auth crypto primitives (src/wincrypt.js). The DPAPI call is
// injected (no Windows needed); the AES-256-GCM value decryption is round-tripped against a
// value we encrypt here exactly the way Electron/Chromium does on Windows.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const win = require('../src/wincrypt');

// Encrypt like Chromium/Electron: "v10" + 12-byte nonce + AES-256-GCM ciphertext + 16-byte tag.
function encryptValue(plaintext, key, prefix) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()]);
  return Buffer.concat([Buffer.from(prefix || 'v10', 'latin1'), nonce, ct, c.getAuthTag()]);
}

test('decryptValue round-trips a v10 AES-256-GCM value', function () {
  const key = crypto.randomBytes(32);
  const secret = 'sessionKey=abc.123; org=xyz';
  assert.strictEqual(win.decryptValue(encryptValue(secret, key, 'v10'), key), secret);
  assert.strictEqual(win.decryptValue(encryptValue(secret, key, 'v11'), key), secret, 'v11 prefix also handled');
});

test('decryptValue accepts base64 input and rejects wrong key / bad prefix', function () {
  const key = crypto.randomBytes(32);
  const enc = encryptValue('hello', key, 'v10');
  assert.strictEqual(win.decryptValue(enc.toString('base64'), key), 'hello');
  assert.strictEqual(win.decryptValue(enc, crypto.randomBytes(32)), null, 'wrong key -> null (auth tag fails)');
  assert.strictEqual(win.decryptValue(Buffer.from('not-encrypted'), key), null, 'no v10/v11 prefix -> null');
  assert.strictEqual(win.decryptValue(Buffer.from('v10short'), key), null, 'too short -> null');
});

test('masterKey extracts + DPAPI-unprotects the encrypted_key from Local State', function () {
  const realKey = crypto.randomBytes(32);
  // Local State stores base64("DPAPI" + <dpapi-encrypted key>). We inject the DPAPI decryptor.
  const dpapiBlob = Buffer.concat([Buffer.from('DPAPI', 'latin1'), Buffer.from('ENCRYPTED-KEY-BYTES')]);
  const localState = JSON.stringify({ os_crypt: { encrypted_key: dpapiBlob.toString('base64') } });
  const got = win.masterKey(localState, { unprotect: function (blob) {
    assert.strictEqual(blob.toString(), 'ENCRYPTED-KEY-BYTES', 'the DPAPI prefix is stripped before unprotect');
    return realKey;
  } });
  assert.ok(Buffer.isBuffer(got) && got.equals(realKey));
});

test('masterKey returns null on a Local State without an encrypted_key or a bad DPAPI prefix', function () {
  assert.strictEqual(win.masterKey('{}', {}), null);
  assert.strictEqual(win.masterKey('not json', {}), null);
  const noDpapi = JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('NODPAPIhere').toString('base64') } });
  assert.strictEqual(win.masterKey(noDpapi, { unprotect: function () { return Buffer.alloc(32); } }), null);
});

test('dpapiUnprotect builds a CurrentUser PowerShell CryptUnprotectData call', function () {
  let seen = null;
  const r = win.dpapiUnprotect(Buffer.from('blob'), { run: function (cmd, args) { seen = { cmd: cmd, args: args }; return { code: 0, stdout: Buffer.from('decrypted').toString('base64') }; } });
  assert.strictEqual(seen.cmd, 'powershell');
  const script = seen.args[seen.args.length - 1];
  assert.ok(script.indexOf('ProtectedData]::Unprotect') !== -1 && script.indexOf("'CurrentUser'") !== -1);
  assert.strictEqual(r.toString(), 'decrypted');
});

test('dpapiUnprotect returns null when PowerShell fails', function () {
  assert.strictEqual(win.dpapiUnprotect(Buffer.from('x'), { run: function () { return { code: 1, stdout: '' }; } }), null);
});
