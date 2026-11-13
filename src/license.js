// LICENSE: offline, phone-home-free license verification + tier gating for the
// open-core paywall. A license is a signed TOKEN carrying { tier, email, expiry,
// issued, seats?, trial? }. It is signed with the maintainer's Ed25519 PRIVATE key at release
// time; only the PUBLIC key ships (PUBKEY_B64 below), so the client can VERIFY a
// license entirely offline but can never MINT one. verify() checks the Ed25519
// signature over a canonical JSON of the payload plus expiry — no network, ever.
// State lives at <configDir>/license.json (0600). Effective tier collapses to
// 'free' whenever there is no license, the signature is bad, or it has expired
// past the grace window, so a paid feature is enabled ONLY by a genuine,
// unexpired (or in-grace) license or an active one-time 14-day local trial.
// Pure w.r.t. ctx (paths + injectable now) so tests need no real time.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { atomicWrite, readJsonForWrite } from './fsutil.js';

// The release VERIFYING key: single-line base64 of an Ed25519 SPKI DER (exactly
// the shape src/fleet.js publishes). It is the PUBLIC half of the issuer keypair —
// the matching PRIVATE key lives only at issuer/private/issuer.key (mode 0600,
// gitignored) and never ships in any artifact. A client can therefore VERIFY a
// license fully offline but can never MINT one.
//
// Generated with `node issuer/keygen.js`. ROTATE by generating a new keypair and
// replacing this one line — but note that every license signed by the old key
// stops verifying the moment you do, so reissue the affected customers first.
// Fail-closed: an unparseable key here makes verify() answer 'no-pubkey' and
// every effective tier collapse to 'free', so a broken release locks nothing
// open — it locks everything shut. Paywall enforcement itself is a separate
// switch (KEYFLIP_LICENSING, below) and is OFF unless explicitly enabled.
const PUBKEY_B64 = 'MCowBQYDK2VwAyEAem3b9ybdmIiW0h/gq3FqLz1q0aDDUrIsZMw6Beq6rxM=';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GRACE_DAYS = 7;
const EXPIRING_SOON_DAYS = 7;
const TRIAL_DAYS = 14;
const USD_TO_TRY_RATE = 34.9;

const PRICING_CATALOG = Object.freeze({
  free: Object.freeze({
    tier: 'free',
    label: 'Free (Open Core)',
    monthlyUsd: 0,
    yearlyUsd: 0,
    monthlyTry: 0,
    yearlyTry: 0,
    seatsIncluded: 1,
  }),
  pro: Object.freeze({
    tier: 'pro',
    label: 'Pro',
    monthlyUsd: 12,
    yearlyUsd: 120,
    monthlyTry: 349,
    yearlyTry: 3490,
    seatsIncluded: 1,
  }),
  team: Object.freeze({
    tier: 'team',
    label: 'Team',
    monthlyUsd: 10,
    yearlyUsd: 100,
    monthlyTry: 299,
    yearlyTry: 2990,
    minSeats: 3,
    seatsIncluded: 3,
  }),
  enterprise: Object.freeze({
    tier: 'enterprise',
    label: 'Enterprise',
    monthlyUsd: null,
    yearlyUsd: 1200,
    monthlyTry: null,
    yearlyTry: 29900,
    minSeats: 15,
    seatsIncluded: 15,
  }),
});

let PUBLIC_KEY_B64 = PUBKEY_B64;
let _pubCache = null; // cached KeyObject
let _pubCacheFor = null; // the b64 it was built from (invalidate on change)

// Swap the verifying key (release build patches PUBKEY_B64; tests inject a
// throwaway public key so they can mint + verify with their own keypair).
function setPublicKey(b64) {
  PUBLIC_KEY_B64 = String(b64 == null ? '' : b64);
  _pubCache = null;
  _pubCacheFor = null;
}
function getPublicKeyB64() {
  return PUBLIC_KEY_B64;
}

// Build (and cache) the Ed25519 public KeyObject. Throws when the embedded key is
// still the placeholder / otherwise unparseable — callers treat that as "no key".
function publicKeyObject() {
  if (_pubCache && _pubCacheFor === PUBLIC_KEY_B64) return _pubCache;
  const obj = crypto.createPublicKey({ key: Buffer.from(PUBLIC_KEY_B64, 'base64'), format: 'der', type: 'spki' });
  _pubCache = obj;
  _pubCacheFor = PUBLIC_KEY_B64;
  return obj;
}

// ---- tiers -------------------------------------------------------------------
// Ordered least->most capable; a feature gated at tier T is unlocked by T and any
// tier to its right. TIER_RANK is a null-proto map so a hostile tier string
// (e.g. '__proto__') can never resolve to an inherited, truthy rank.
const TIER_ORDER = ['free', 'pro', 'team', 'enterprise'];
const TIER_RANK = Object.create(null);
TIER_ORDER.forEach(function (t, i) {
  TIER_RANK[t] = i;
});
function rankOf(t) {
  return TIER_RANK[t] == null ? -1 : TIER_RANK[t];
}

// Feature -> minimum tier. Null-proto so gate('__proto__') can't inherit a value
// and mis-report a non-feature as gated. Anything NOT listed here is a free
// feature (gate returns true). Paid surfaces, per product spec:
//   pro : fleet, orchestrator/jobs, cost, budget, notify, autoswitch, router/cache
//   team: teampool, policy, vault, swarm
const FEATURES = Object.assign(Object.create(null), {
  fleet: 'pro',
  orchestrator: 'pro',
  jobs: 'pro',
  cost: 'pro',
  budget: 'pro',
  notify: 'pro',
  autoswitch: 'pro',
  router: 'pro',
  cache: 'pro',
  teampool: 'team',
  policy: 'team',
  vault: 'team',
  swarm: 'team',
});

// Paywall enforcement is OFF unless KEYFLIP_LICENSING is explicitly enabled. So requireTier() and the
// central CLI/MCP gates are no-ops by default — shipping the machinery WITHOUT gating anyone until the
// product launches. Flip it on with `KEYFLIP_LICENSING=1` (env) once the issuer/checkout are live.
function enforcementEnabled() {
  const v = process.env.KEYFLIP_LICENSING;
  return v === '1' || v === 'true' || v === 'on';
}

// Map a CLI command OR an MCP tool name to the paywalled feature it belongs to (null = free/core).
const CMD_FEATURE = Object.assign(Object.create(null), {
  fleet: 'fleet',
  'run-job': 'orchestrator',
  jobs: 'orchestrator',
  fanout: 'orchestrator',
  'fan-out': 'orchestrator',
  cost: 'cost',
  budget: 'budget',
  notify: 'notify',
  autoswitch: 'autoswitch',
  route: 'router',
  cache: 'router',
  post: 'notify',
  team: 'teampool',
  policy: 'policy',
  vault: 'vault',
  swarm: 'swarm',
});
const AREA_FEATURE = Object.assign(Object.create(null), {
  fleet: 'fleet',
  job: 'orchestrator',
  jobs: 'orchestrator',
  fanout: 'orchestrator',
  cost: 'cost',
  budget: 'budget',
  notify: 'notify',
  autoswitch: 'autoswitch',
  route: 'router',
  cache: 'router',
  post: 'notify',
  team: 'teampool',
  policy: 'policy',
  vault: 'vault',
  swarm: 'swarm',
});
function featureFor(name) {
  const n = String(name || '');
  if (Object.prototype.hasOwnProperty.call(CMD_FEATURE, n)) return CMD_FEATURE[n];
  const m = /^keyflip_([a-z]+)/.exec(n); // MCP tool: keyflip_<area>_...
  return (m && AREA_FEATURE[m[1]]) || null;
}

// ---- token codec -------------------------------------------------------------
function b64uEnc(buf) {
  return Buffer.from(buf).toString('base64url');
}
function b64uDec(s) {
  return Buffer.from(String(s), 'base64url');
}

// The exact bytes that get signed/verified: a fixed-key-order JSON of the four
// core fields, plus optional `seats` and `trial` when present so existing 4-field
// tokens verify identically while seat-scoped / trial tokens are cryptographically bound.
function canonicalPayload(p) {
  p = p || {};
  const obj = {
    email: p.email == null ? '' : String(p.email),
    expiry: p.expiry == null ? null : String(p.expiry),
    issued: p.issued == null ? '' : String(p.issued),
    tier: p.tier == null ? '' : String(p.tier),
  };
  if (p.seats != null && Number.isInteger(Number(p.seats)) && Number(p.seats) > 0) {
    obj.seats = Number(p.seats);
  }
  if (p.trial === true) {
    obj.trial = true;
  }
  return JSON.stringify(obj);
}

// A token is `base64url(canonicalJSON).base64url(ed25519sig)` — whitespace-free
// and copy-pasteable.
function nowIso(opts) {
  opts = opts || {};
  if (typeof opts.now === 'function') return opts.now();
  return new Date().toISOString();
}

// ---- verify (offline) --------------------------------------------------------
// verify(token, {now, graceDays}) -> { valid, tier, reason, expiry, email, issued, seats, trial, daysRemaining, expiringSoon, inGrace }.
//   * tier is the CLAIMED tier for a genuine signature (so callers can say
//     "your pro license expired"); it is 'free' when there is nothing to trust
//     (bad signature / malformed / no verifying key).
//   * valid is true only for a genuine, known-tier, unexpired license.
// Never touches the network or the real clock (now is injected).
function verify(token, opts) {
  opts = opts || {};
  const graceDays =
    typeof opts.graceDays === 'number' && opts.graceDays >= 0 ? opts.graceDays : DEFAULT_GRACE_DAYS;
  const untrusted = function (reason) {
    return {
      valid: false,
      tier: 'free',
      reason: reason,
      expiry: null,
      email: null,
      issued: null,
      seats: 1,
      trial: false,
      daysRemaining: null,
      expiringSoon: false,
      inGrace: false,
    };
  };
  if (typeof token !== 'string') return untrusted('malformed');
  const parts = token.trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return untrusted('malformed');

  let canonical, sig, payload;
  try {
    canonical = b64uDec(parts[0]).toString('utf8');
    sig = b64uDec(parts[1]);
  } catch (e) {
    return untrusted('malformed');
  }
  try {
    payload = JSON.parse(canonical);
  } catch (e) {
    return untrusted('malformed');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return untrusted('malformed');

  let pub;
  try {
    pub = publicKeyObject();
  } catch (e) {
    return untrusted('no-pubkey');
  }

  // Re-serialize to the canonical form and verify the signature over THAT — so a
  // reordered/reencoded transport still checks, and a tampered field flips it.
  let ok = false;
  try {
    ok = crypto.verify(null, Buffer.from(canonicalPayload(payload), 'utf8'), pub, sig);
  } catch (e) {
    ok = false;
  }
  if (!ok) return untrusted('bad-signature');

  const email = payload.email == null ? null : String(payload.email);
  const issued = payload.issued == null ? null : String(payload.issued);
  const expiry = payload.expiry == null ? null : String(payload.expiry);
  const seats =
    payload.seats != null && Number.isInteger(Number(payload.seats)) && Number(payload.seats) > 0
      ? Number(payload.seats)
      : 1;
  const trial = payload.trial === true;

  // Signature is genuine from here on — a known tier is required to be valid.
  if (TIER_ORDER.indexOf(payload.tier) === -1) {
    return {
      valid: false,
      tier: 'free',
      reason: 'unknown-tier',
      expiry: expiry,
      email: email,
      issued: issued,
      seats: seats,
      trial: trial,
      daysRemaining: null,
      expiringSoon: false,
      inGrace: false,
    };
  }
  let daysRemaining = null;
  let expiringSoon = false;
  let inGrace = false;
  if (expiry !== null) {
    const expMs = Date.parse(expiry);
    if (isNaN(expMs)) {
      return {
        valid: false,
        tier: payload.tier,
        reason: 'bad-expiry',
        expiry: expiry,
        email: email,
        issued: issued,
        seats: seats,
        trial: trial,
        daysRemaining: null,
        expiringSoon: false,
        inGrace: false,
      };
    }
    const nowMs = Date.parse(nowIso(opts));
    if (!isNaN(nowMs)) {
      const diffMs = expMs - nowMs;
      daysRemaining = Math.ceil(diffMs / DAY_MS);
      if (nowMs > expMs) {
        inGrace = !trial && graceDays > 0 && nowMs - expMs <= graceDays * DAY_MS;
        return {
          valid: false,
          tier: payload.tier,
          reason: 'expired',
          expiry: expiry,
          email: email,
          issued: issued,
          seats: seats,
          trial: trial,
          daysRemaining: daysRemaining,
          expiringSoon: false,
          inGrace: inGrace,
        };
      }
      expiringSoon = diffMs <= EXPIRING_SOON_DAYS * DAY_MS;
    }
  }
  return {
    valid: true,
    tier: payload.tier,
    reason: 'ok',
    expiry: expiry,
    email: email,
    issued: issued,
    seats: seats,
    trial: trial,
    daysRemaining: daysRemaining,
    expiringSoon: expiringSoon,
    inGrace: false,
  };
}

// ---- state (activate / trial / status / effective tier) ----------------------
function licensePath(ctx) {
  return path.join(ctx.configDir, 'license.json');
}
function trialPath(ctx) {
  return path.join(ctx.configDir, 'trial.json');
}
function usageLedgerPath(ctx) {
  return path.join(ctx.configDir, 'usage-ledger.json');
}

// The stored record, or null when absent/corrupt (corrupt = treat as no license
// so a mangled file fails closed to 'free' rather than throwing on every gate).
function readStored(ctx) {
  let rec;
  try {
    rec = readJsonForWrite(licensePath(ctx));
  } catch (e) {
    return null;
  }
  if (!rec || typeof rec !== 'object' || Array.isArray(rec) || typeof rec.token !== 'string') return null;
  return rec;
}

function trialChecksum(rec) {
  const raw = [rec.startedAt || '', rec.expiry || '', rec.email || '', rec.tier || 'pro'].join('|');
  return crypto.createHash('sha256').update('keyflip-trial-v1:' + raw, 'utf8').digest('hex');
}

function readTrial(ctx) {
  let rec;
  try {
    rec = readJsonForWrite(trialPath(ctx));
  } catch (e) {
    return null;
  }
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  if (typeof rec.startedAt !== 'string' || typeof rec.expiry !== 'string') return null;
  if (rec.checksum !== trialChecksum(rec)) return null;
  return rec;
}

// Start a one-time 14-day local Pro trial on this machine. Refuses if a trial
// was already started on this configDir so the trial cannot be reset endlessly.
function startTrial(ctx, opts) {
  opts = opts || {};
  const existing = readTrial(ctx);
  if (existing) {
    throw new Error(
      'trial already used on this machine (started ' +
        existing.startedAt.slice(0, 10) +
        ') — activate a paid license with `keyflip license activate <file>`',
    );
  }
  const nowStr = typeof ctx.now === 'function' ? ctx.now() : new Date().toISOString();
  const nowMs = Date.parse(nowStr);
  const baseMs = isNaN(nowMs) ? Date.now() : nowMs;
  const days =
    typeof opts.days === 'number' && opts.days > 0 && opts.days <= 30 ? Math.floor(opts.days) : TRIAL_DAYS;
  const expiryStr = new Date(baseMs + days * DAY_MS).toISOString();
  const email = opts.email ? String(opts.email).trim() : null;
  const rec = {
    tier: 'pro',
    trial: true,
    email: email,
    startedAt: new Date(baseMs).toISOString(),
    expiry: expiryStr,
    days: days,
  };
  rec.checksum = trialChecksum(rec);
  atomicWrite(trialPath(ctx), JSON.stringify(rec, null, 2), 0o600);
  return {
    tier: 'pro',
    trial: true,
    email: email,
    startedAt: rec.startedAt,
    expiry: rec.expiry,
    daysRemaining: days,
    valid: true,
  };
}

// Pull a bare token out of file contents: a JSON wrapper ({token|license|key}),
// or the first whitespace-delimited token (tokens themselves never contain
// whitespace), tolerating a trailing newline or surrounding blank lines.
function extractToken(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  if (s[0] === '{') {
    try {
      const o = JSON.parse(s);
      const t = o && (o.token || o.license || o.key);
      if (t) return String(t).trim();
    } catch (e) {
      /* fall through to raw */
    }
  }
  return s.split(/\s+/)[0];
}

// activate(ctx, { file | token }): verify FIRST, then persist to
// <configDir>/license.json (0600). Throws on an invalid/expired license so the
// caller never stores something that wouldn't unlock anything.
function activate(ctx, opts) {
  opts = opts || {};
  let token = opts.token;
  if (!token && opts.file) {
    let raw;
    try {
      raw = fs.readFileSync(opts.file, 'utf8');
    } catch (e) {
      throw new Error('cannot read license file ' + opts.file + ': ' + ((e && e.message) || e));
    }
    token = extractToken(raw);
  }
  if (typeof token !== 'string' || !token.trim())
    throw new Error('no license token provided (pass a token or a license file)');
  token = token.trim();

  const v = verify(token, { now: ctx.now });
  if (!v.valid) throw new Error('this license is not valid (' + v.reason + ') — nothing was activated');

  const rec = {
    token: token,
    tier: v.tier,
    email: v.email,
    expiry: v.expiry,
    issued: v.issued,
    seats: v.seats,
    trial: v.trial,
    activatedAt: ctx.now(),
  };
  atomicWrite(licensePath(ctx), JSON.stringify(rec, null, 2), 0o600);
  return {
    tier: v.tier,
    email: v.email,
    expiry: v.expiry,
    seats: v.seats,
    trial: v.trial,
    daysRemaining: v.daysRemaining,
    expiringSoon: v.expiringSoon,
    valid: true,
  };
}

// Remove any stored license (back to free). Returns whether one existed.
function deactivate(ctx) {
  const had = !!readStored(ctx);
  try {
    fs.rmSync(licensePath(ctx), { force: true });
  } catch (e) {
    /* best effort */
  }
  return had;
}

// status(ctx, opts) -> { tier, email, expiry, valid, reason, seats, trial, daysRemaining, expiringSoon, inGrace }.
// tier is the CLAIMED tier of the stored license (for display, e.g. "pro (expired)");
// valid says whether it is currently in force. No license -> checks active trial, else free / not valid.
function status(ctx, opts) {
  opts = opts || {};
  const rec = readStored(ctx);
  if (rec) {
    const v = verify(rec.token, { now: ctx.now, graceDays: opts.graceDays });
    return {
      tier: v.tier,
      email: v.email,
      expiry: v.expiry,
      valid: v.valid,
      reason: v.reason,
      seats: v.seats,
      trial: v.trial,
      daysRemaining: v.daysRemaining,
      expiringSoon: v.expiringSoon,
      inGrace: v.inGrace,
    };
  }
  const tr = readTrial(ctx);
  if (tr) {
    const nowMs = Date.parse(typeof ctx.now === 'function' ? ctx.now() : new Date().toISOString());
    const expMs = Date.parse(tr.expiry);
    const diffMs = expMs - nowMs;
    const daysRemaining = isNaN(diffMs) ? 0 : Math.ceil(diffMs / DAY_MS);
    const active = !isNaN(diffMs) && diffMs >= 0;
    return {
      tier: 'pro',
      email: tr.email || null,
      expiry: tr.expiry,
      valid: active,
      reason: active ? 'trial' : 'trial-expired',
      seats: 1,
      trial: true,
      daysRemaining: daysRemaining,
      expiringSoon: active && daysRemaining <= 3,
      inGrace: false,
    };
  }
  return {
    tier: 'free',
    email: null,
    expiry: null,
    valid: false,
    reason: 'no-license',
    seats: 1,
    trial: false,
    daysRemaining: null,
    expiringSoon: false,
    inGrace: false,
  };
}

// tier(ctx, opts) -> EFFECTIVE tier: 'free' unless a genuine, unexpired (or in-grace)
// license or active 14-day trial grants more. This is the single source of truth every gate() consults.
function tier(ctx, opts) {
  const s = status(ctx, opts);
  if (s.valid) return s.tier;
  if (s.inGrace && (!opts || opts.allowGrace !== false)) return s.tier;
  return 'free';
}

// ---- local usage & ROI value ledger (<configDir>/usage-ledger.json) ----------
function emptyBucket() {
  return {
    requests: 0,
    savedUsd: 0,
    savedTokens: 0,
    failoversSaved: 0,
    leaksBlocked: 0,
  };
}

function readLedgerSafe(ctx) {
  let raw;
  try {
    raw = readJsonForWrite(usageLedgerPath(ctx));
  } catch (e) {
    return { total: emptyBucket(), months: Object.create(null), updatedAt: null };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { total: emptyBucket(), months: Object.create(null), updatedAt: null };
  }
  const sanitizeBucket = function (b) {
    const out = emptyBucket();
    if (!b || typeof b !== 'object') return out;
    if (typeof b.requests === 'number' && isFinite(b.requests) && b.requests >= 0) out.requests = Math.floor(b.requests);
    if (typeof b.savedUsd === 'number' && isFinite(b.savedUsd) && b.savedUsd >= 0)
      out.savedUsd = Math.round(b.savedUsd * 1e6) / 1e6;
    if (typeof b.savedTokens === 'number' && isFinite(b.savedTokens) && b.savedTokens >= 0)
      out.savedTokens = Math.floor(b.savedTokens);
    if (typeof b.failoversSaved === 'number' && isFinite(b.failoversSaved) && b.failoversSaved >= 0)
      out.failoversSaved = Math.floor(b.failoversSaved);
    if (typeof b.leaksBlocked === 'number' && isFinite(b.leaksBlocked) && b.leaksBlocked >= 0)
      out.leaksBlocked = Math.floor(b.leaksBlocked);
    return out;
  };
  const months = Object.create(null);
  if (raw.months && typeof raw.months === 'object' && !Array.isArray(raw.months)) {
    Object.keys(raw.months).forEach(function (k) {
      if (/^\d{4}-\d{2}$/.test(k)) months[k] = sanitizeBucket(raw.months[k]);
    });
  }
  return {
    total: sanitizeBucket(raw.total),
    months: months,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

function recordUsage(ctx, delta) {
  delta = delta || {};
  const ledger = readLedgerSafe(ctx);
  const nowStr = typeof ctx.now === 'function' ? ctx.now() : new Date().toISOString();
  const monthKey = String(nowStr).slice(0, 7);
  const validMonth = /^\d{4}-\d{2}$/.test(monthKey) ? monthKey : new Date().toISOString().slice(0, 7);
  if (!ledger.months[validMonth]) ledger.months[validMonth] = emptyBucket();

  const applyDelta = function (b) {
    if (typeof delta.requests === 'number' && isFinite(delta.requests) && delta.requests > 0)
      b.requests += Math.floor(delta.requests);
    if (typeof delta.savedUsd === 'number' && isFinite(delta.savedUsd) && delta.savedUsd > 0)
      b.savedUsd = Math.round((b.savedUsd + delta.savedUsd) * 1e6) / 1e6;
    if (typeof delta.savedTokens === 'number' && isFinite(delta.savedTokens) && delta.savedTokens > 0)
      b.savedTokens += Math.floor(delta.savedTokens);
    if (typeof delta.failoversSaved === 'number' && isFinite(delta.failoversSaved) && delta.failoversSaved > 0)
      b.failoversSaved += Math.floor(delta.failoversSaved);
    if (typeof delta.leaksBlocked === 'number' && isFinite(delta.leaksBlocked) && delta.leaksBlocked > 0)
      b.leaksBlocked += Math.floor(delta.leaksBlocked);
  };

  applyDelta(ledger.total);
  applyDelta(ledger.months[validMonth]);
  ledger.updatedAt = nowStr;

  const plainMonths = {};
  Object.keys(ledger.months)
    .sort()
    .slice(-24)
    .forEach(function (k) {
      plainMonths[k] = ledger.months[k];
    });
  atomicWrite(
    usageLedgerPath(ctx),
    JSON.stringify({ total: ledger.total, months: plainMonths, updatedAt: ledger.updatedAt }, null, 2),
    0o600,
  );
  return usageSummary(ctx);
}

function usageSummary(ctx) {
  const ledger = readLedgerSafe(ctx);
  const nowStr = typeof ctx.now === 'function' ? ctx.now() : new Date().toISOString();
  const monthKey = /^\d{4}-\d{2}/.test(String(nowStr))
    ? String(nowStr).slice(0, 7)
    : new Date().toISOString().slice(0, 7);
  const cur = ledger.months[monthKey] || emptyBucket();
  const decorate = function (b) {
    return {
      requests: b.requests,
      savedUsd: b.savedUsd,
      savedTry: Math.round(b.savedUsd * USD_TO_TRY_RATE * 100) / 100,
      savedTokens: b.savedTokens,
      failoversSaved: b.failoversSaved,
      leaksBlocked: b.leaksBlocked,
    };
  };
  return {
    currentMonth: monthKey,
    month: decorate(cur),
    total: decorate(ledger.total),
    updatedAt: ledger.updatedAt,
  };
}

// ---- gating ------------------------------------------------------------------
// gate(ctx, feature) -> boolean. Unlisted feature = free = always allowed.
function gate(ctx, feature) {
  const min = FEATURES[feature];
  if (!min) return true;
  return rankOf(tier(ctx)) >= rankOf(min);
}

// requireTier(ctx, feature): allow, or throw a clear LICENSE_REQUIRED error naming
// the plan the user needs. Call this at the TOP of every paid handler.
function requireTier(ctx, feature) {
  if (!enforcementEnabled()) return true; // paywall OFF by default — a pure no-op until KEYFLIP_LICENSING=1
  if (!feature || !FEATURES[feature]) return true; // free/core feature
  if (gate(ctx, feature)) return true;
  const min = FEATURES[feature] || 'pro';
  const err = new Error('this feature needs the ' + min + ' plan (keyflip license activate ... or keyflip license trial)');
  err.code = 'LICENSE_REQUIRED';
  err.feature = feature;
  err.requiredTier = min;
  err.currentTier = tier(ctx);
  throw err;
}

// Feature names unlocked at the current effective tier (handy for status UIs).
function unlockedFeatures(ctx) {
  const cur = rankOf(tier(ctx));
  return Object.keys(FEATURES)
    .filter(function (f) {
      return cur >= rankOf(FEATURES[f]);
    })
    .sort();
}

// ---- test helper -------------------------------------------------------------
// makeLicense(privKey, payload, {now}) -> token string. `privKey` is a KeyObject,
// a PEM/DER string, or a Buffer. Lets a test mint a license with a throwaway
// keypair (pair with setPublicKey) so the whole mint->verify path runs offline.
function makeLicense(privKey, payload, opts) {
  opts = opts || {};
  payload = payload || {};
  const p = {
    tier: payload.tier,
    email: payload.email != null ? payload.email : '',
    expiry: payload.expiry !== undefined ? payload.expiry : null,
    issued: payload.issued != null ? payload.issued : nowIso(opts),
  };
  if (payload.seats != null) p.seats = payload.seats;
  if (payload.trial === true) p.trial = true;
  const canonical = canonicalPayload(p);
  const key = typeof privKey === 'string' || Buffer.isBuffer(privKey) ? crypto.createPrivateKey(privKey) : privKey;
  const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), key);
  return b64uEnc(Buffer.from(canonical, 'utf8')) + '.' + b64uEnc(sig);
}

// ---- MCP tool descriptors (spliced into src/mcp.js TOOLS via wiring) ---------
// Self-contained (own annotations + confirm check) so mcp.js only has to concat
// them. status = read-only; activate / trial = mutating + requires confirm:true.
const mcpTools = [
  {
    name: 'keyflip_license_status',
    title: 'License / plan status',
    description:
      "Show the machine's keyflip license: effective plan (free|pro|team|enterprise), the licensed email, expiry, seats, trial/grace status, unlocked features, local ROI usage summary, pricing plans, and whether the paywall is enforcing. Fully offline (no phone-home). Read-only.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    run: async function (ctx) {
      const s = status(ctx);
      return {
        plan: tier(ctx),
        tier: s.tier,
        email: s.email,
        expiry: s.expiry,
        valid: s.valid,
        reason: s.reason,
        seats: s.seats,
        trial: s.trial,
        daysRemaining: s.daysRemaining,
        expiringSoon: s.expiringSoon,
        inGrace: s.inGrace,
        features: unlockedFeatures(ctx),
        enforcement: enforcementEnabled(),
        usage: usageSummary(ctx),
        pricing: PRICING_CATALOG,
      };
    },
  },
  {
    name: 'keyflip_license_activate',
    title: 'Activate a license file',
    description:
      "Verify a license FILE offline and, if valid, store it as this machine's license (unlocking its plan). Pass the path to the license file. Mutating — ask the user first, then set confirm=true.",
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to the license file to verify and activate.' },
        confirm: { type: 'boolean', description: 'Must be true — set it only after the user has agreed.' },
      },
      required: ['file', 'confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: async function (ctx, args) {
      if (!args || args.confirm !== true)
        throw new Error('confirmation required: ask the user first, then call again with confirm=true');
      const r = activate(ctx, { file: String(args.file) });
      return {
        activated: true,
        tier: r.tier,
        email: r.email,
        expiry: r.expiry,
        seats: r.seats,
        trial: r.trial,
      };
    },
  },
  {
    name: 'keyflip_license_trial',
    title: 'Start 14-day local Pro trial',
    description:
      'Start a one-time 14-day local Pro trial on this machine (no network call, no credit card). Mutating — ask the user first, then set confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Optional email address to associate with the trial.' },
        confirm: { type: 'boolean', description: 'Must be true — set it only after the user has agreed.' },
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async function (ctx, args) {
      if (!args || args.confirm !== true)
        throw new Error('confirmation required: ask the user first, then call again with confirm=true');
      return startTrial(ctx, { email: args.email });
    },
  },
];

function requireForName(ctx, name) {
  return requireTier(ctx, featureFor(name));
}

export {
  makeLicense,
  makeLicense as signCommandForTest,
  setPublicKey,
  getPublicKeyB64,
  PUBKEY_B64,
  PRICING_CATALOG,
  DEFAULT_GRACE_DAYS,
  TRIAL_DAYS,
  deactivate,
  startTrial,
  recordUsage,
  usageSummary,
  status,
  tier,
  licensePath,
  trialPath,
  usageLedgerPath,
  requireTier,
  enforcementEnabled,
  featureFor,
  unlockedFeatures,
  FEATURES,
  TIER_ORDER,
  requireForName,
  verify,
  canonicalPayload,
  activate,
  gate,
  mcpTools,
};
