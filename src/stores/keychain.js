'use strict';
// macOS credential store backed by the login Keychain via /usr/bin/security.
// Secrets never touch the filesystem here, and writes go through stdin so the
// secret never appears in the process table.
//
// Error taxonomy: `security` exit 44 (errSecItemNotFound) is a genuine miss and
// reads return null; any other failure (locked keychain, denied ACL, timeout)
// throws an Error with code 'EKEYCHAIN' so callers can say "keychain locked"
// instead of the misleading "no credentials".
const defaultRun = require('../exec').run;

const SERVICE_LIVE = 'Claude Code-credentials'; // the item Claude itself manages
const PROFILE_PREFIX = 'ccswitch:';
const SECURITY = '/usr/bin/security';
const NOT_FOUND = 44;          // errSecItemNotFound
const TIMEOUT_MS = 5000;       // a locked keychain must not hang the CLI
const STDIN_CMD_LIMIT = 3800;  // conservative `security -i` line-length budget

function keychainError(op, r) {
  const detail = r.timedOut ? 'timed out (keychain locked or waiting on a prompt?)'
    : ((r.stderr || '').trim() || ('exit ' + r.code));
  const err = new Error('Keychain ' + op + ' failed: ' + detail +
    ' — unlock the login keychain and try again');
  err.code = 'EKEYCHAIN';
  return err;
}

// Quote a value for a `security -i` command line.
function q(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

class KeychainStore {
  constructor(opts) {
    this.account = (opts && opts.account) || '';
    this.run = (opts && opts.runner) || defaultRun;
    this.keychainPath = (opts && opts.keychainPath) || null; // for tests/CI: a throwaway keychain
    this.type = 'keychain';
  }

  _tail() { return this.keychainPath ? [this.keychainPath] : []; }

  _read(service) {
    const r = this.run(SECURITY, ['find-generic-password', '-s', service, '-a', this.account, '-w'].concat(this._tail()), undefined, { timeoutMs: TIMEOUT_MS });
    if (r.code === 0) return r.stdout.replace(/\r?\n$/, '');
    if (r.code === NOT_FOUND) return null;
    throw keychainError('read of "' + service + '"', r);
  }

  _write(service, blob) {
    // Preferred: feed `add-generic-password ... -X <hex>` to `security -i` on
    // stdin — the secret never becomes an argv value visible in `ps`. Very large
    // blobs fall back to argv (-w) rather than risk truncating the command line.
    const hex = Buffer.from(String(blob), 'utf8').toString('hex');
    const tail = this.keychainPath ? ' ' + q(this.keychainPath) : '';
    let r;
    if (hex.length <= STDIN_CMD_LIMIT) {
      const cmd = 'add-generic-password -U -s ' + q(service) + ' -a ' + q(this.account) + ' -X ' + hex + tail + '\n';
      r = this.run(SECURITY, ['-i'], cmd, { timeoutMs: TIMEOUT_MS });
    } else {
      r = this.run(SECURITY, ['add-generic-password', '-U', '-s', service, '-a', this.account, '-w', blob].concat(this._tail()), undefined, { timeoutMs: TIMEOUT_MS });
    }
    if (r.code !== 0) throw keychainError('write of "' + service + '"', r);
  }

  _delete(service) {
    const r = this.run(SECURITY, ['delete-generic-password', '-s', service, '-a', this.account].concat(this._tail()), undefined, { timeoutMs: TIMEOUT_MS });
    if (r.code !== 0 && r.code !== NOT_FOUND && r.timedOut) throw keychainError('delete of "' + service + '"', r);
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
module.exports.SECURITY = SECURITY;
