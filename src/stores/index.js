'use strict';
// Chooses the right credential backend for the current machine, and provides an
// in-memory store used by the tests.
const fs = require('fs');
const path = require('path');
const KeychainStore = require('./keychain');
const FileStore = require('./file');

// Detection order:
//  1) If Claude already keeps a credentials FILE, use the file backend (any OS,
//     any version — this is what actually holds the live token).
//  2) Otherwise on macOS use the Keychain.
//  3) Otherwise (Linux / Windows without the file yet) default to the file backend.
function createStore(opts) {
  const platform = opts.platform || process.platform;
  const profileCredDir = path.join(opts.configDir, 'creds');
  const fileOpts = { credsFilePath: opts.credsFilePath, profileCredDir: profileCredDir };

  let credsFileExists = false;
  try { credsFileExists = fs.existsSync(opts.credsFilePath); } catch (e) { credsFileExists = false; }

  if (credsFileExists) return new FileStore(fileOpts);
  if (platform === 'darwin') return new KeychainStore({ account: opts.account });
  return new FileStore(fileOpts);
}

// In-memory store for tests (no filesystem, no Keychain).
class MemoryStore {
  constructor() {
    this.type = 'memory';
    this.live = null;
    this.profiles = Object.create(null);
  }
  getLive() { return this.live; }
  setLive(blob) { this.live = blob; }
  getProfile(name) {
    return Object.prototype.hasOwnProperty.call(this.profiles, name) ? this.profiles[name] : null;
  }
  setProfile(name, blob) { this.profiles[name] = blob; }
  delProfile(name) { delete this.profiles[name]; }
}

module.exports = { createStore, MemoryStore, KeychainStore, FileStore };
