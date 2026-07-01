'use strict';
// File-based credential store for Linux / Windows (and any machine where Claude
// stores credentials in ~/.claude/.credentials.json instead of a system keyring).
// The live blob is the whole credentials file; profile blobs are 0600 files under
// <configDir>/creds/<name>.cred.
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('../fsutil');

class FileStore {
  constructor(opts) {
    this.credsFilePath = opts.credsFilePath;
    this.profileCredDir = opts.profileCredDir;
    this.type = 'file';
  }

  _read(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
  }

  _write(p, blob) {
    atomicWrite(p, blob, 0o600);
  }

  _profPath(name) { return path.join(this.profileCredDir, name + '.cred'); }

  getLive() { return this._read(this.credsFilePath); }
  setLive(blob) { this._write(this.credsFilePath, blob); }
  getProfile(name) { return this._read(this._profPath(name)); }
  setProfile(name, blob) { this._write(this._profPath(name), blob); }
  delProfile(name) { try { fs.unlinkSync(this._profPath(name)); } catch (e) { /* ignore */ } }
}

module.exports = FileStore;
