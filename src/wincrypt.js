// Windows app-auth & Chromium cookie CRYPTO primitives, isolated + injectable so the
// (hardened) macOS Keychain path is untouched. On Windows, Electron/Chromium protects the
// safeStorage/OSCrypt MASTER KEY with DPAPI (stored in "Local State" → `os_crypt.encrypted_key`,
// "DPAPI"-prefixed) and encrypts values/cookies with AES-256-GCM ("v10"/"v11" prefix + 12-byte
// nonce + ciphertext + 16-byte tag). Chrome 127+ also introduces "v20" App-Bound Encryption
// (tied to Chrome's elevated SYSTEM service; detected and surfaced clearly by isAppBoundCookie).
import fs from 'fs';
import crypto from 'crypto';
import * as _exec from './exec.js';

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  try {
    return Buffer.from(String(input), 'base64');
  } catch (e) {
    return Buffer.alloc(0);
  }
}

// True when every byte of `buf` is printable ASCII (0x20..0x7e).
function isPrintableAscii(buf) {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] < 0x20 || buf[i] > 0x7e) return false;
  }
  return true;
}

// Raw AES-256-GCM decrypt of a "v10"/"v11" Chromium/Electron blob -> Buffer | null.
function decryptBytes(input, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) return null;
  const buf = toBuffer(input);
  const prefix = buf.slice(0, 3).toString('latin1');
  if (prefix !== 'v10' && prefix !== 'v11') return null;
  if (buf.length < 3 + 12 + 16) return null;
  const nonce = buf.slice(3, 15);
  const tag = buf.slice(buf.length - 16);
  const ct = buf.slice(15, buf.length - 16);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  } catch (e) {
    return null;
  }
}

// Decrypt a Chromium/Electron "v10"/"v11" AES-256-GCM value (UTF-8 JSON/token) with the 32-byte master key.
function decryptValue(input, key) {
  const raw = decryptBytes(input, key);
  return raw ? raw.toString('utf8') : null;
}

// Chrome 127+ on Windows marks App-Bound Encrypted cookies with a "v20" prefix. Those keys are
// wrapped by Chrome's SYSTEM elevation service and cannot be decrypted by a regular user process.
function isAppBoundCookie(input) {
  const buf = toBuffer(input);
  return buf.length >= 3 + 12 + 16 && buf.slice(0, 3).toString('latin1') === 'v20';
}

// Decrypt one Windows Chromium/Electron cookie `encrypted_value` ("v10"/"v11" AES-256-GCM).
// Chromium 130+ (cookie DB meta >= 24) prepends a 32-byte binary SHA-256(host_key) digest to
// the cookie plaintext before encrypting:
//   • If `opts.hostKey` is supplied and the leading 32 bytes match SHA-256(hostKey), strip 32 bytes.
//   • Otherwise, if the whole decrypted buffer is already printable ASCII (legacy <130 cookie,
//     including >32-char tokens like `sk-ant-sid01-...`), return it intact without truncating.
//   • Otherwise, if `raw.length >= 32` and `raw.slice(32)` is printable ASCII (non-ASCII SHA-256
//     header followed by the ASCII cookie value), strip the 32-byte header.
function decryptCookie(input, key, opts) {
  const raw = decryptBytes(input, key);
  if (!raw) return null;
  if (raw.length === 0) return '';
  if (opts && opts.hostKey && raw.length >= 32) {
    const expected = crypto.createHash('sha256').update(String(opts.hostKey), 'utf8').digest();
    if (raw.slice(0, 32).equals(expected)) {
      const rest = raw.slice(32);
      return isPrintableAscii(rest) ? rest.toString('utf8') : null;
    }
  }
  if (isPrintableAscii(raw)) return raw.toString('utf8');
  if (raw.length >= 32 && isPrintableAscii(raw.slice(32))) return raw.slice(32).toString('utf8');
  return null;
}

// DPAPI CryptUnprotectData (CurrentUser) via PowerShell. Returns the decrypted Buffer or null.
// opts.unprotect (a fn(Buffer)->Buffer) or opts.run are injectable for tests.
function dpapiUnprotect(blob, opts) {
  opts = opts || {};
  const bytes = Buffer.isBuffer(blob) ? blob : Buffer.from(String(blob), 'base64');
  if (opts.unprotect) return opts.unprotect(bytes); // test hook (no PowerShell)
  const run = opts.run || _exec.run;
  const b64 = bytes.toString('base64');
  const ps =
    "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;" +
    "$b=[Convert]::FromBase64String('" +
    b64 +
    "');" +
    "$d=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');" +
    '[Convert]::ToBase64String($d)';
  let r;
  try {
    r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  } catch (e) {
    return null;
  }
  if (!r || r.code !== 0 || !String(r.stdout || '').trim()) return null;
  try {
    return Buffer.from(String(r.stdout).trim(), 'base64');
  } catch (e) {
    return null;
  }
}

// Extract the AES-256 master key from a Chromium/Electron "Local State" JSON string.
function masterKey(localStateText, opts) {
  let ls;
  try {
    ls = JSON.parse(localStateText);
  } catch (e) {
    return null;
  }
  const enc = ls && ls.os_crypt && ls.os_crypt.encrypted_key;
  if (!enc) return null;
  let raw;
  try {
    raw = Buffer.from(String(enc), 'base64');
  } catch (e) {
    return null;
  }
  if (raw.slice(0, 5).toString('latin1') !== 'DPAPI') return null;
  const key = dpapiUnprotect(raw.slice(5), opts);
  return Buffer.isBuffer(key) && key.length === 32 ? key : null; // a valid 32-byte key, or null
}

// Read a Chromium/Electron "Local State" file from disk and extract its 32-byte AES-256 master key.
function masterKeyFromFile(localStatePath, opts) {
  if (!localStatePath) return null;
  let text;
  try {
    text = fs.readFileSync(localStatePath, 'utf8');
  } catch (e) {
    return null;
  }
  return masterKey(text, opts);
}

export { decryptBytes, decryptValue, decryptCookie, isAppBoundCookie, dpapiUnprotect, masterKey, masterKeyFromFile };
