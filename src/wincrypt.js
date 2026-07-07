'use strict';
// Windows app-auth CRYPTO primitives, isolated + injectable so the (hardened) macOS path in
// appauth.js is untouched. On Windows, Electron/Chromium protects the safeStorage MASTER KEY
// with DPAPI (stored in "Local State" → `os_crypt.encrypted_key`, "DPAPI"-prefixed) and encrypts
// values with AES-256-GCM ("v10"/"v11" prefix + 12-byte nonce + ciphertext + 16-byte tag).
// This module: DPAPI-unprotect (via PowerShell — zero native dep) + GCM value decrypt + master
// key extraction. The AES-GCM + key-extraction paths are fixture-tested here; wiring this into
// appauth's account detection is the remaining Windows step (needs a real Windows machine to
// verify) — see docs/PORTING.md.
const crypto = require('crypto');

// Decrypt a Chromium/Electron "v10"/"v11" AES-256-GCM value with the 32-byte master key.
function decryptValue(input, key) {
  const buf = Buffer.isBuffer(input) ? input : (function () { try { return Buffer.from(String(input), 'base64'); } catch (e) { return Buffer.alloc(0); } })();
  const prefix = buf.slice(0, 3).toString('latin1');
  if (prefix !== 'v10' && prefix !== 'v11') return null;
  if (buf.length < 3 + 12 + 16) return null;
  const nonce = buf.slice(3, 15);
  const tag = buf.slice(buf.length - 16);
  const ct = buf.slice(15, buf.length - 16);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch (e) { return null; }
}

// DPAPI CryptUnprotectData (CurrentUser) via PowerShell. Returns the decrypted Buffer or null.
// opts.unprotect (a fn(Buffer)->Buffer) or opts.run are injectable for tests.
function dpapiUnprotect(blob, opts) {
  opts = opts || {};
  const bytes = Buffer.isBuffer(blob) ? blob : Buffer.from(String(blob), 'base64');
  if (opts.unprotect) return opts.unprotect(bytes); // test hook (no PowerShell)
  const run = opts.run || require('./exec').run;
  const b64 = bytes.toString('base64');
  const ps = "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;" +
    "$b=[Convert]::FromBase64String('" + b64 + "');" +
    "$d=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');" +
    "[Convert]::ToBase64String($d)";
  let r; try { r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]); } catch (e) { return null; }
  if (!r || r.code !== 0 || !String(r.stdout || '').trim()) return null;
  try { return Buffer.from(String(r.stdout).trim(), 'base64'); } catch (e) { return null; }
}

// Extract the AES-256 master key from a Chromium/Electron "Local State" JSON string.
function masterKey(localStateText, opts) {
  let ls; try { ls = JSON.parse(localStateText); } catch (e) { return null; }
  const enc = ls && ls.os_crypt && ls.os_crypt.encrypted_key;
  if (!enc) return null;
  let raw; try { raw = Buffer.from(String(enc), 'base64'); } catch (e) { return null; }
  if (raw.slice(0, 5).toString('latin1') !== 'DPAPI') return null;
  const key = dpapiUnprotect(raw.slice(5), opts);
  return (Buffer.isBuffer(key) && key.length === 32) ? key : (Buffer.isBuffer(key) ? key : null);
}

module.exports = { decryptValue: decryptValue, dpapiUnprotect: dpapiUnprotect, masterKey: masterKey };
