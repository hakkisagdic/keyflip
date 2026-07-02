'use strict';
// Per-account circuit breaker (#7): an account that repeatedly fails (expired
// token, hard errors) trips OPEN and is skipped by autoswitch until a recovery
// window passes (HALF-OPEN trial); a success CLOSES it again. State persists in
// <configDir>/breakers.json so it survives across invocations. Passive usage
// polls must NOT reset breaker state — only real success/failure signals do.
const fs = require('fs');
const path = require('path');
const { writeJsonStable } = require('./fsutil');

const DEFAULTS = { failureThreshold: 4, recoveryMs: 60 * 1000, successesToClose: 2 };

function file(ctx) { return path.join(ctx.configDir, 'breakers.json'); }
function readAll(ctx) {
  try { const o = JSON.parse(fs.readFileSync(file(ctx), 'utf8')); return (o && typeof o === 'object') ? o : {}; }
  catch (e) { return {}; }
}
function writeAll(ctx, all) { try { writeJsonStable(file(ctx), all, 0o600); } catch (e) { /* best effort */ } }

function entry(all, name) {
  if (!all[name]) all[name] = { state: 'closed', failures: 0, successes: 0, openedAt: 0 };
  return all[name];
}

// Effective state, accounting for the recovery window (Open -> Half-open once
// recoveryMs has elapsed). Does not mutate.
function state(ctx, name, opts) {
  opts = Object.assign({}, DEFAULTS, opts);
  const now = (opts && opts.nowMs !== undefined) ? opts.nowMs : Date.now();
  const e = readAll(ctx)[name];
  if (!e || e.state === 'closed') return 'closed';
  if (e.state === 'open') return (now - (e.openedAt || 0) >= opts.recoveryMs) ? 'half-open' : 'open';
  return e.state; // half-open
}

// Is this account eligible to be switched to right now?
function isAvailable(ctx, name, opts) { return state(ctx, name, opts) !== 'open'; }

function recordFailure(ctx, name, opts) {
  opts = Object.assign({}, DEFAULTS, opts);
  const now = opts.nowMs !== undefined ? opts.nowMs : Date.now();
  const all = readAll(ctx); const e = entry(all, name);
  e.failures = (e.failures || 0) + 1; e.successes = 0;
  if (e.failures >= opts.failureThreshold && e.state !== 'open') { e.state = 'open'; e.openedAt = now; }
  writeAll(ctx, all);
  return e.state;
}

function recordSuccess(ctx, name, opts) {
  opts = Object.assign({}, DEFAULTS, opts);
  const all = readAll(ctx); const e = entry(all, name);
  if (e.state === 'half-open' || (e.state === 'open')) {
    e.successes = (e.successes || 0) + 1;
    if (e.successes >= opts.successesToClose) { e.state = 'closed'; e.failures = 0; e.successes = 0; e.openedAt = 0; }
  } else { e.failures = 0; }
  writeAll(ctx, all);
  return e.state;
}

function reset(ctx, name) {
  const all = readAll(ctx); delete all[name]; writeAll(ctx, all);
}

module.exports = { state: state, isAvailable: isAvailable, recordFailure: recordFailure, recordSuccess: recordSuccess, reset: reset, readAll: readAll, DEFAULTS: DEFAULTS };
