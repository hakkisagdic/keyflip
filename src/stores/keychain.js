'use strict';
// macOS credential store backed by the login Keychain via the `security` CLI.
// Secrets never touch the filesystem here.
const { run } = require('../exec');

const SERVICE_LIVE = 'Claude Code-credentials'; // the item Claude itself manages
const PROFILE_PREFIX = 'ccswitch:';

class KeychainStore {
  constructor(opts) {
    this.account = (opts && opts.account) || '';
    this.type = 'keychain';
  }

  _read(service) {
    const r = run('security', ['find-generic-password', '-s', service, '-a', this.account, '-w']);
    if (r.code !== 0) return null;
    return r.stdout.replace(/\r?\n$/, '');
  }

  _write(service, blob) {
    // NOTE: `security` has no stdin input for the password, so the secret is passed
    // as an argv value and is briefly visible in the process table (`ps`) for the
    // duration of this call. Acceptable for a single-user macOS machine; documented
    // in the README's security notes. (The read path does not expose the secret.)
    const r = run('security', ['add-generic-password', '-U', '-s', service, '-a', this.account, '-w', blob]);
    if (r.code !== 0) {
      throw new Error('Keychain write failed for "' + service + '": ' + (r.stderr || r.code));
    }
  }

  _delete(service) {
    run('security', ['delete-generic-password', '-s', service, '-a', this.account]);
  }

  getLive() { return this._read(SERVICE_LIVE); }
  setLive(blob) { this._write(SERVICE_LIVE, blob); }
  delLive() { this._delete(SERVICE_LIVE); }
  getProfile(name) { return this._read(PROFILE_PREFIX + name); }
  setProfile(name, blob) { this._write(PROFILE_PREFIX + name, blob); }
  delProfile(name) { this._delete(PROFILE_PREFIX + name); }
}

module.exports = KeychainStore;
module.exports.SERVICE_LIVE = SERVICE_LIVE;
module.exports.PROFILE_PREFIX = PROFILE_PREFIX;
