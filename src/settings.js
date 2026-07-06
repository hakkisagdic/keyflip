'use strict';
// Helpers for ~/.claude/settings.json — the file Claude Code hot-reloads. Used
// by provider switching (env block) and the shared-config-snippet feature.
const fs = require('fs');
const { readJsonForWrite } = require('./fsutil');

// Missing file -> {} (legit empty). Exists-but-corrupt -> THROW (never clobber
// the user's real settings.json by treating a parse error as emptiness).
function read(file) { return readJsonForWrite(file); }

// A "credential-shaped" env key we must never carry in a SHARED (non-secret)
// snippet: *_API_KEY, *_AUTH_TOKEN, anything with SECRET/TOKEN — but NOT plural
// *_TOKENS limits (MAX_OUTPUT_TOKENS etc.).
function isCredentialKey(k) {
  const s = String(k);
  if (/_TOKENS$/i.test(s)) return false;          // MAX_OUTPUT_TOKENS, ...
  // Catch UPPER_SNAKE (ANTHROPIC_API_KEY) and camelCase (apiKey, authToken) alike.
  return /(_API_KEY|_AUTH_TOKEN|SECRET|TOKEN|_KEY|APIKEY|AUTHTOKEN|PASSWORD|PASSWD)$/i.test(s) ||
    /SECRET|PASSWORD|APIKEY|API_KEY/i.test(s) || /(?:^|[^A-Z])(apiKey|authToken|accessToken|secretKey)$/.test(s);
}

// Return a shallow copy of an env map with credential-shaped keys removed.
function stripCredentialEnv(env) {
  const out = {};
  Object.keys(env || {}).forEach(function (k) { if (!isCredentialKey(k)) out[k] = env[k]; });
  return out;
}

// Recursive merge: patch wins on scalars/arrays, objects merge. Setting a patch
// value to null DELETES that key (so a snippet can subtract).
const PROTO_KEYS = ['__proto__', 'constructor', 'prototype'];
function deepMerge(base, patch) {
  const out = Object.assign({}, base);
  Object.keys(patch || {}).forEach(function (k) {
    if (PROTO_KEYS.indexOf(k) !== -1) return; // never let a patch pollute the prototype
    const pv = patch[k];
    if (pv === null) { delete out[k]; return; }
    if (pv && typeof pv === 'object' && !Array.isArray(pv) &&
        out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], pv);
    } else {
      out[k] = pv;
    }
  });
  return out;
}

// J3: dot-path get/set for `keyflip settings`. Guards against prototype pollution.
function getPath(obj, kp) { return String(kp).split('.').reduce(function (o, k) { return (o && typeof o === 'object') ? o[k] : undefined; }, obj); }
function setPath(obj, kp, val) {
  const parts = String(kp).split('.'); let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]; if (PROTO_KEYS.indexOf(p) !== -1) return;
    if (!o[p] || typeof o[p] !== 'object' || Array.isArray(o[p])) o[p] = {};
    o = o[p];
  }
  const last = parts[parts.length - 1]; if (PROTO_KEYS.indexOf(last) !== -1) return;
  if (val === undefined) delete o[last]; else o[last] = val;
}

module.exports = { read: read, isCredentialKey: isCredentialKey, stripCredentialEnv: stripCredentialEnv, deepMerge: deepMerge, getPath: getPath, setPath: setPath };
