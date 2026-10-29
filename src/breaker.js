// Per-account circuit breaker (#7): an account that repeatedly fails (expired
// token, hard errors) trips OPEN and is skipped by autoswitch until a recovery
// window passes (HALF-OPEN trial); a success CLOSES it again. State persists in
// <configDir>/breakers.json so it survives across invocations. Passive usage
// polls must NOT reset breaker state — only real success/failure signals do.
import fs from 'fs';
import path from 'path';
import { writeJsonStable } from './fsutil.js';

const DEFAULTS = { failureThreshold: 4, recoveryMs: 60 * 1000, successesToClose: 2 };

function file(ctx) {
  return path.join(ctx.configDir, 'breakers.json');
}
function readAll(ctx) {
  try {
    const o = JSON.parse(fs.readFileSync(file(ctx), 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch (e) {
    return {};
  }
}
function writeAll(ctx, all) {
  try {
    writeJsonStable(file(ctx), all, 0o600);
  } catch (e) {
    /* best effort */
  }
}

function entry(all, name) {
  if (!all[name]) all[name] = { state: 'closed', failures: 0, successes: 0, openedAt: 0 };
  return all[name];
}

// --- per-account cooldown (#11) -------------------------------------------------
// The breaker is a LONG-horizon signal (4 failures open it for a full minute). A
// single authoritative "come back at T" from upstream (429 + Retry-After, a
// billing block, an expired token) should take an account out of rotation at
// once without waiting to trip that breaker. Cooldown lives in the SAME
// breakers.json entry (cooldownUntil/cooldownKind) so no new state file — and no
// new RESERVED_FILES entry — is introduced. lastUsedAt is the LRU key (#9).

function markCooldown(ctx, name, ms, kind, opts) {
  opts = opts || {};
  const now = opts.nowMs !== undefined ? opts.nowMs : Date.now();
  const until = now + Math.max(0, Number(ms) || 0);
  const all = readAll(ctx);
  const e = entry(all, name);
  if (!ms) {
    delete e.cooldownUntil;
    delete e.cooldownKind;
  } else if (!e.cooldownUntil || until > e.cooldownUntil) {
    // never SHORTEN an existing cooldown (a later short Retry-After must not
    // release an account another response has already parked for longer)
    e.cooldownUntil = until;
    e.cooldownKind = String(kind || 'throttled');
  }
  writeAll(ctx, all);
  return e.cooldownUntil || 0;
}

// Effective cooldown: {active, remainingMs, until, kind}. Expired entries read as
// inactive without writing (a read must never mutate on a status check).
function cooldownOf(ctx, name, opts) {
  opts = opts || {};
  const now = opts.nowMs !== undefined ? opts.nowMs : Date.now();
  const e = readAll(ctx)[name];
  if (!e || !e.cooldownUntil) return { active: false, remainingMs: 0, until: 0, kind: null };
  const remainingMs = Math.max(0, e.cooldownUntil - now);
  return {
    active: remainingMs > 0,
    remainingMs: remainingMs,
    until: e.cooldownUntil,
    kind: remainingMs > 0 ? e.cooldownKind || 'throttled' : null,
  };
}

function clearCooldown(ctx, name) {
  const all = readAll(ctx);
  if (!all[name]) return false;
  const had = !!all[name].cooldownUntil;
  delete all[name].cooldownUntil;
  delete all[name].cooldownKind;
  if (!all[name].state || all[name].state === 'closed') {
    // a closed entry with nothing else recorded is noise — drop it entirely
    if (!all[name].failures && !all[name].successes && !all[name].lastUsedAt) delete all[name];
  }
  writeAll(ctx, all);
  return had;
}

// Effective state, accounting for the recovery window (Open -> Half-open once
// recoveryMs has elapsed). Does not mutate.
function state(ctx, name, opts) {
  opts = Object.assign({}, DEFAULTS, opts);
  const now = opts && opts.nowMs !== undefined ? opts.nowMs : Date.now();
  const e = readAll(ctx)[name];
  if (!e || e.state === 'closed') return 'closed';
  if (e.state === 'open') return now - (e.openedAt || 0) >= opts.recoveryMs ? 'half-open' : 'open';
  return e.state; // half-open
}

// Is this account eligible to be switched to right now?
function isAvailable(ctx, name, opts) {
  return state(ctx, name, opts) !== 'open';
}

function recordFailure(ctx, name, opts) {
  opts = Object.assign({}, DEFAULTS, opts);
  const now = opts.nowMs !== undefined ? opts.nowMs : Date.now();
  const all = readAll(ctx);
  const e = entry(all, name);
  e.lastUsedAt = now; // LRU key for the router (#9): every real attempt counts
  e.failures = (e.failures || 0) + 1;
  e.successes = 0;
  // Trip open (or RE-ARM the recovery window) on any failure at/over threshold —
  // a failed half-open trial restarts the cooldown instead of staying eligible.
  if (e.failures >= opts.failureThreshold) {
    e.state = 'open';
    e.openedAt = now;
  }
  writeAll(ctx, all);
  return e.state;
}

function recordSuccess(ctx, name, opts) {
  opts = Object.assign({}, DEFAULTS, opts);
  const now = opts.nowMs !== undefined ? opts.nowMs : Date.now();
  const all = readAll(ctx);
  const e = entry(all, name);
  e.lastUsedAt = now;
  if (!e || e.state === 'closed') {
    e.failures = 0;
    writeAll(ctx, all);
    return 'closed';
  }
  // A success only counts toward closing once the recovery window has elapsed
  // (effective half-open). While still cooling (open), a success is IGNORED —
  // a passive usage poll must never force-close a breaker inside its cooldown.
  const cooling = e.state === 'open' && now - (e.openedAt || 0) < opts.recoveryMs;
  if (cooling) {
    writeAll(ctx, all);
    return 'open';
  }
  e.successes = (e.successes || 0) + 1;
  if (e.successes >= opts.successesToClose) {
    e.state = 'closed';
    e.failures = 0;
    e.successes = 0;
    e.openedAt = 0;
  }
  writeAll(ctx, all);
  return e.state;
}

function reset(ctx, name) {
  const all = readAll(ctx);
  delete all[name];
  writeAll(ctx, all);
}

export {
  state,
  isAvailable,
  recordFailure,
  recordSuccess,
  reset,
  readAll,
  markCooldown,
  cooldownOf,
  clearCooldown,
  DEFAULTS,
};
