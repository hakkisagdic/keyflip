// Chooses the right credential backend for the current machine, and provides an
// in-memory store used by the tests.
import fs from 'fs';
import path from 'path';
import KeychainStore from './keychain.js';
import FileStore from './file.js';
import { registerSecret } from '../redact.js';

// macOS store: live credential ALWAYS lives in the Keychain (Claude Code reads it
// there first), but keyflip's own profile backups learn to fall back to files
// when the keychain is locked/unavailable (SSH session, locked login keychain) —
// so add/list/remove keep working and only the live swap fails loudly.
class HybridStore {
  constructor(kc, file) {
    this.kc = kc;
    this.file = file;
    this.fallback = false; // sticky for this process once the keychain misbehaves
    this.lastKeychainError = null;
    this.type = 'keychain';
  }
  _profileOp(op, args) {
    if (this.fallback) return this.file[op].apply(this.file, args);
    try {
      return this.kc[op].apply(this.kc, args);
    } catch (e) {
      if (e && e.code === 'EKEYCHAIN') {
        this.fallback = true;
        this.lastKeychainError = e;
        return this.file[op].apply(this.file, args);
      }
      throw e;
    }
  }
  getLive() {
    return registerSecret(this.kc.getLive());
  }
  setLive(blob) {
    registerSecret(blob);
    return this.kc.setLive(blob);
  }
  delLive() {
    return this.kc.delLive();
  }
  getProfile(name) {
    if (this.fallback) {
      const fv = this.file.getProfile(name);
      if (fv !== null) return registerSecret(fv);
      if (this.lastKeychainError) throw this.lastKeychainError;
      return null;
    }
    try {
      const v = this.kc.getProfile(name);
      if (v !== null) return registerSecret(v);
      try {
        return registerSecret(this.file.getProfile(name));
      } catch {
        return null;
      }
    } catch (e) {
      if (e && e.code === 'EKEYCHAIN') {
        this.fallback = true;
        this.lastKeychainError = e;
        let fv = null;
        try {
          fv = this.file.getProfile(name);
        } catch {
          fv = null;
        }
        if (fv !== null) return registerSecret(fv);
      }
      throw e;
    }
  }
  setProfile(name, blob) {
    registerSecret(blob);
    return this._profileOp('setProfile', [name, blob]);
  }
  delProfile(name) {
    this._profileOp('delProfile', [name]);
    try {
      this.file.delProfile(name);
    } catch (e) {
      /* ignore */
    }
  }
}

// Detection order:
//  1) If Claude already keeps a credentials FILE, use the file backend (any OS,
//     any version — this is what actually holds the live token).
//  2) Otherwise on macOS use the Keychain (with learned file fallback for profiles).
//  3) Otherwise (Linux / Windows without the file yet) default to the file backend.
function createStore(opts) {
  const platform = opts.platform || process.platform;
  const profileCredDir = path.join(opts.configDir, 'creds');
  const fileOpts = { credsFilePath: opts.credsFilePath, profileCredDir: profileCredDir };

  let credsFileExists = false;
  try {
    credsFileExists = fs.existsSync(opts.credsFilePath);
  } catch (e) {
    credsFileExists = false;
  }

  if (credsFileExists) return new FileStore(fileOpts);
  if (platform === 'darwin') {
    return new HybridStore(new KeychainStore({ account: opts.account, runner: opts.runner }), new FileStore(fileOpts));
  }
  return new FileStore(fileOpts);
}

// Reconciliation (macOS): Claude Code reads the Keychain BEFORE the plaintext
// credentials file, so when the live credential was written to the FILE backend,
// a stale Keychain item would silently win. Best-effort remove it.
function reconcileStaleKeychain(ctx) {
  if (ctx.platform !== 'darwin' || !ctx.store || ctx.store.type !== 'file') return false;
  try {
    new KeychainStore({ account: ctx.account, runner: ctx.keychainRunner }).delLive();
    return true;
  } catch (e) {
    return false;
  }
}

// In-memory store for tests (no filesystem, no Keychain).
class MemoryStore {
  constructor() {
    this.type = 'memory';
    this.live = null;
    this.profiles = Object.create(null);
  }
  getLive() {
    return registerSecret(this.live);
  }
  setLive(blob) {
    registerSecret(blob);
    this.live = blob;
  }
  delLive() {
    this.live = null;
  }
  getProfile(name) {
    return Object.prototype.hasOwnProperty.call(this.profiles, name) ? registerSecret(this.profiles[name]) : null;
  }
  setProfile(name, blob) {
    registerSecret(blob);
    this.profiles[name] = blob;
  }
  delProfile(name) {
    delete this.profiles[name];
  }
}

export { createStore, MemoryStore, KeychainStore, FileStore, HybridStore, reconcileStaleKeychain };
