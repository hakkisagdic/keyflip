'use strict';
// Read/write ~/.claude.json (the account "pointer") safely and cross-platform.
const fs = require('fs');
const { atomicWrite } = require('./fsutil');

// Lenient read: returns null for a missing OR unparseable file. Use for display.
function readConfig(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

// Strict read for the write path: {} if the file is missing, but THROWS if the
// file exists yet is not valid JSON — so we never clobber a corrupt-but-real
// config (which could hold mcpServers, settings, etc.) by rewriting it as {}.
function loadForWrite(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return {};
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(p + ' exists but is not valid JSON; refusing to overwrite it. Fix or remove it first.');
  }
}

// Atomic write that preserves the original file mode and every unrelated key.
function writeConfig(p, obj) {
  let mode = 0o600;
  try { mode = fs.statSync(p).mode & 0o777; } catch (e) { /* new file */ }
  atomicWrite(p, JSON.stringify(obj, null, 2), mode);
}

function currentAccount(config) {
  if (!config || !config.oauthAccount) return null;
  return {
    email: config.oauthAccount.emailAddress || '',
    userID: config.userID || '',
    oauthAccount: config.oauthAccount,
  };
}

module.exports = { readConfig, loadForWrite, writeConfig, currentAccount };
