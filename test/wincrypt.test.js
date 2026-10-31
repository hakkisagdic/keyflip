// Tests for the Windows app-auth & Chromium cookie crypto primitives (src/wincrypt.js).
// The DPAPI call is injected (no Windows needed); AES-256-GCM value & cookie decryption
// are round-tripped against blobs encrypted the exact way Electron/Chromium does on Windows.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import * as win from '../src/wincrypt.js';

// Encrypt like Chromium/Electron: "v10" + 12-byte nonce + AES-256-GCM ciphertext + 16-byte tag.
function encryptRaw(plainBuf, key, prefix) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([c.update(plainBuf), c.final()]);
  return Buffer.concat([Buffer.from(prefix || 'v10', 'latin1'), nonce, ct, c.getAuthTag()]);
}

function encryptValue(plaintext, key, prefix) {
  return encryptRaw(Buffer.from(plaintext, 'utf8'), key, prefix);
}

test('decryptValue round-trips a v10 and v11 AES-256-GCM value', function () {
  const key = crypto.randomBytes(32);
  const secret = 'sessionKey=abc.123; org=xyz';
  assert.strictEqual(win.decryptValue(encryptValue(secret, key, 'v10'), key), secret);
  assert.strictEqual(win.decryptValue(encryptValue(secret, key, 'v11'), key), secret, 'v11 prefix also handled');
});

test('decryptValue accepts base64 input and rejects wrong key / bad prefix / wrong key size', function () {
  const key = crypto.randomBytes(32);
  const enc = encryptValue('hello', key, 'v10');
  assert.strictEqual(win.decryptValue(enc.toString('base64'), key), 'hello');
  assert.strictEqual(win.decryptValue(enc, crypto.randomBytes(32)), null, 'wrong key -> null (auth tag fails)');
  assert.strictEqual(win.decryptValue(enc, Buffer.alloc(16)), null, 'non-32B key -> null');
  assert.strictEqual(win.decryptValue(Buffer.from('not-encrypted'), key), null, 'no v10/v11 prefix -> null');
  assert.strictEqual(win.decryptValue(Buffer.from('v10short'), key), null, 'too short -> null');
});

test('decryptCookie handles both legacy (<130) cookies and Chromium 130+ 32-byte SHA-256 host_key prefixes', function () {
  const key = crypto.randomBytes(32);
  const shortVal = 'org-uuid-123';
  const longVal = 'sk-ant-sid01-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-abcdefghijklmnopqrstuvwxyz';
  const hostHash = crypto.createHash('sha256').update('.claude.ai', 'utf8').digest();

  // Legacy (<130): no 32-byte prefix — must NOT truncate >32-char sessionKey tokens!
  assert.strictEqual(win.decryptCookie(encryptValue(shortVal, key, 'v10'), key), shortVal);
  assert.strictEqual(win.decryptCookie(encryptValue(longVal, key, 'v10'), key), longVal);

  // Chromium 130+ (meta >= 24): 32-byte SHA-256(host_key) prepended to plaintext
  const encShortHashed = encryptRaw(Buffer.concat([hostHash, Buffer.from(shortVal, 'utf8')]), key, 'v10');
  const encLongHashed = encryptRaw(Buffer.concat([hostHash, Buffer.from(longVal, 'utf8')]), key, 'v10');
  const encEmptyHashed = encryptRaw(hostHash, key, 'v10');

  assert.strictEqual(win.decryptCookie(encShortHashed, key), shortVal);
  assert.strictEqual(win.decryptCookie(encLongHashed, key), longVal);
  assert.strictEqual(win.decryptCookie(encEmptyHashed, key), '');
  assert.strictEqual(win.decryptCookie(encLongHashed, key, { hostKey: '.claude.ai' }), longVal);

  // Binary garbage after 32-byte prefix is rejected
  const garbage = encryptRaw(Buffer.concat([hostHash, Buffer.from([0x00, 0xff, 0x01])]), key, 'v10');
  assert.strictEqual(win.decryptCookie(garbage, key), null);
});

test('isAppBoundCookie detects Chrome 127+ Windows v20 App-Bound Encryption blobs', function () {
  const key = crypto.randomBytes(32);
  const v20 = encryptValue('secret', key, 'v20');
  const v10 = encryptValue('secret', key, 'v10');
  assert.strictEqual(win.isAppBoundCookie(v20), true);
  assert.strictEqual(win.isAppBoundCookie(v20.toString('base64')), true);
  assert.strictEqual(win.isAppBoundCookie(v10), false);
  assert.strictEqual(win.isAppBoundCookie(Buffer.from('v20short')), false);
  assert.strictEqual(win.decryptCookie(v20, key), null, 'v20 is not misinterpreted as v10');
});

test('masterKey and masterKeyFromFile extract + DPAPI-unprotect encrypted_key from Local State', function () {
  const realKey = crypto.randomBytes(32);
  const dpapiBlob = Buffer.concat([Buffer.from('DPAPI', 'latin1'), Buffer.from('ENCRYPTED-KEY-BYTES')]);
  const localState = JSON.stringify({ os_crypt: { encrypted_key: dpapiBlob.toString('base64') } });
  const unprotect = function (blob) {
    assert.strictEqual(blob.toString(), 'ENCRYPTED-KEY-BYTES', 'the DPAPI prefix is stripped before unprotect');
    return realKey;
  };
  const got = win.masterKey(localState, { unprotect: unprotect });
  assert.ok(Buffer.isBuffer(got) && got.equals(realKey));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-winls-'));
  const file = path.join(dir, 'Local State');
  fs.writeFileSync(file, localState);
  const fromFile = win.masterKeyFromFile(file, { unprotect: unprotect });
  assert.ok(Buffer.isBuffer(fromFile) && fromFile.equals(realKey));
  assert.strictEqual(win.masterKeyFromFile(path.join(dir, 'missing'), { unprotect: unprotect }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('masterKey returns null on a Local State without an encrypted_key or a bad DPAPI prefix', function () {
  assert.strictEqual(win.masterKey('{}', {}), null);
  assert.strictEqual(win.masterKey('not json', {}), null);
  const noDpapi = JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('NODPAPIhere').toString('base64') } });
  assert.strictEqual(
    win.masterKey(noDpapi, {
      unprotect: function () {
        return Buffer.alloc(32);
      },
    }),
    null,
  );
});

test('dpapiUnprotect builds a CurrentUser PowerShell CryptUnprotectData call', function () {
  let seen = null;
  const r = win.dpapiUnprotect(Buffer.from('blob'), {
    run: function (cmd, args) {
      seen = { cmd: cmd, args: args };
      return { code: 0, stdout: Buffer.from('decrypted').toString('base64') };
    },
  });
  assert.strictEqual(seen.cmd, 'powershell');
  const script = seen.args[seen.args.length - 1];
  assert.ok(script.indexOf('ProtectedData]::Unprotect') !== -1 && script.indexOf("'CurrentUser'") !== -1);
  assert.strictEqual(r.toString(), 'decrypted');
});

test('dpapiUnprotect returns null when PowerShell fails', function () {
  assert.strictEqual(
    win.dpapiUnprotect(Buffer.from('x'), {
      run: function () {
        return { code: 1, stdout: '' };
      },
    }),
    null,
  );
});

test('masterKey returns null for a wrong-length DPAPI result (not the buffer)', function () {
  const ls = JSON.stringify({
    os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), Buffer.from('x')]).toString('base64') },
  });
  assert.strictEqual(
    win.masterKey(ls, {
      unprotect: function () {
        return Buffer.alloc(16);
      },
    }),
    null,
    '16-byte key is rejected',
  );
  assert.ok(
    Buffer.isBuffer(
      win.masterKey(ls, {
        unprotect: function () {
          return Buffer.alloc(32);
        },
      }),
    ),
    '32-byte key is accepted',
  );
});
