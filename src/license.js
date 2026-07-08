'use strict';
// LICENSE: offline, phone-home-free license verification + tier gating for the
// open-core paywall. A license is a signed TOKEN carrying { tier, email, expiry,
// issued }. It is signed with the maintainer's Ed25519 PRIVATE key at release
// time; only the PUBLIC key ships (PUBKEY_B64 below), so the client can VERIFY a
// license entirely offline but can never MINT one. verify() checks the Ed25519
// signature over a canonical JSON of the payload plus expiry — no network, ever.
// State lives at <configDir>/license.json (0600). Effective tier collapses to
// 'free' whenever there is no license, the signature is bad, or it has expired,
// so a paid feature is enabled ONLY by a genuine, unexpired, sufficiently-tiered
// license. Pure w.r.t. ctx (paths + injectable now) so tests need no real time.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWrite, readJsonForWrite } = require('./fsutil');

// The release PUBLIC key (single-line base64 of an Ed25519 SPKI DER, exactly the
// shape src/fleet.js publishes). This placeholder is NOT a valid key, so a build
// that forgets to replace it verifies NOTHING (everything degrades to 'free') —
// fail-closed by construction. The maintainer swaps this at release; tests call
// setPublicKey() with a throwaway key.
const PUBKEY_B64 = 'REPLACE_AT_RELEASE_WITH_ED25519_SPKI_DER_BASE64';

let PUBLIC_KEY_B64 = PUBKEY_B64;
let _pubCache = null;      // cached KeyObject
let _pubCacheFor = null;   // the b64 it was built from (invalidate on change)

// Swap the verifying key (release build patches PUBKEY_B64; tests inject a
// throwaway public key so they can mint + verify with their own keypair).
function setPublicKey(b64) { PUBLIC_KEY_B64 = String(b64 == null ? '' : b64); _pubCache = null; _pubCacheFor = null; }
function getPublicKeyB64() { return PUBLIC_KEY_B64; }

// Build (and cache) the Ed25519 public KeyObject. Throws when the embedded key is
// still the placeholder / otherwise unparseable — callers treat that as "no key".
function publicKeyObject() {
  if (_pubCache && _pubCacheFor === PUBLIC_KEY_B64) return _pubCache;
  const obj = crypto.createPublicKey({ key: Buffer.from(PUBLIC_KEY_B64, 'base64'), format: 'der', type: 'spki' });
  _pubCache = obj; _pubCacheFor = PUBLIC_KEY_B64;
  return obj;
}

// ---- tiers -------------------------------------------------------------------
// Ordered least->most capable; a feature gated at tier T is unlocked by T and any
// tier to its right. TIER_RANK is a null-proto map so a hostile tier string
// (e.g. '__proto__') can never resolve to an inherited, truthy rank.
const TIER_ORDER = ['free', 'pro', 'team', 'enterprise'];
const TIER_RANK = Object.create(null);
TIER_ORDER.forEach(function (t, i) { TIER_RANK[t] = i; });
function rankOf(t) { return TIER_RANK[t] == null ? -1 : TIER_RANK[t]; }

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

// ---- token codec -------------------------------------------------------------
function b64uEnc(buf) { return Buffer.from(buf).toString('base64url'); }
function b64uDec(s) { return Buffer.from(String(s), 'base64url'); }

// The exact bytes that get signed/verified: a fixed-key-order JSON of the four
// meaningful fields, with every field coerced deterministically so signer and
// verifier always agree (an absent email/expiry can never shift the bytes).
function canonicalPayload(p) {
  p = p || {};
  return JSON.stringify({
    email: p.email == null ? '' : String(p.email),
    expiry: p.expiry == null ? null : String(p.expiry),
    issued: p.issued == null ? '' : String(p.issued),
    tier: p.tier == null ? '' : String(p.tier),
  });
}

// A token is `base64url(canonicalJSON).base64url(ed25519sig)` — whitespace-free
// and copy-pasteable.
function nowIso(opts) {
  opts = opts || {};
  if (typeof opts.now === 'function') return opts.now();
  return new Date().toISOString();
}

// ---- verify (offline) --------------------------------------------------------
// verify(token, {now}) -> { valid, tier, reason, expiry, email, issued }.
//   * tier is the CLAIMED tier for a genuine signature (so callers can say
//     "your pro license expired"); it is 'free' when there is nothing to trust
//     (bad signature / malformed / no verifying key).
//   * valid is true only for a genuine, known-tier, unexpired license.
// Never touches the network or the real clock (now is injected).
function verify(token, opts) {
  const untrusted = function (reason) { return { valid: false, tier: 'free', reason: reason, expiry: null, email: null, issued: null }; };
  if (typeof token !== 'string') return untrusted('malformed');
  const parts = token.trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return untrusted('malformed');

  let canonical, sig, payload;
  try {
    canonical = b64uDec(parts[0]).toString('utf8');
    sig = b64uDec(parts[1]);
  } catch (e) { return untrusted('malformed'); }
  try { payload = JSON.parse(canonical); } catch (e) { return untrusted('malformed'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return untrusted('malformed');

  let pub;
  try { pub = publicKeyObject(); } catch (e) { return untrusted('no-pubkey'); }

  // Re-serialize to the canonical form and verify the signature over THAT — so a
  // reordered/reencoded transport still checks, and a tampered field flips it.
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(canonicalPayload(payload), 'utf8'), pub, sig); } catch (e) { ok = false; }
  if (!ok) return untrusted('bad-signature');

  const email = payload.email == null ? null : String(payload.email);
  const issued = payload.issued == null ? null : String(payload.issued);
  const expiry = payload.expiry == null ? null : String(payload.expiry);

  // Signature is genuine from here on — a known tier is required to be valid.
  if (TIER_ORDER.indexOf(payload.tier) === -1) {
    return { valid: false, tier: 'free', reason: 'unknown-tier', expiry: expiry, email: email, issued: issued };
  }
  if (expiry !== null) {
    const expMs = Date.parse(expiry);
    if (isNaN(expMs)) return { valid: false, tier: payload.tier, reason: 'bad-expiry', expiry: expiry, email: email, issued: issued };
    const nowMs = Date.parse(nowIso(opts));
    if (!isNaN(nowMs) && nowMs > expMs) {
      return { valid: false, tier: payload.tier, reason: 'expired', expiry: expiry, email: email, issued: issued };
    }
  }
  return { valid: true, tier: payload.tier, reason: 'ok', expiry: expiry, email: email, issued: issued };
}

// ---- state (activate / status / effective tier) ------------------------------
function licensePath(ctx) { return path.join(ctx.configDir, 'license.json'); }

// The stored record, or null when absent/corrupt (corrupt = treat as no license
// so a mangled file fails closed to 'free' rather than throwing on every gate).
function readStored(ctx) {
  let rec;
  try { rec = readJsonForWrite(licensePath(ctx)); } catch (e) { return null; }
  if (!rec || typeof rec !== 'object' || Array.isArray(rec) || typeof rec.token !== 'string') return null;
  return rec;
}

// Pull a bare token out of file contents: a JSON wrapper ({token|license|key}),
// or the first whitespace-delimited token (tokens themselves never contain
// whitespace), tolerating a trailing newline or surrounding blank lines.
function extractToken(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  if (s[0] === '{') {
    try { const o = JSON.parse(s); const t = o && (o.token || o.license || o.key); if (t) return String(t).trim(); } catch (e) { /* fall through to raw */ }
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
    try { raw = fs.readFileSync(opts.file, 'utf8'); }
    catch (e) { throw new Error('cannot read license file ' + opts.file + ': ' + ((e && e.message) || e)); }
    token = extractToken(raw);
  }
  if (typeof token !== 'string' || !token.trim()) throw new Error('no license token provided (pass a token or a license file)');
  token = token.trim();

  const v = verify(token, { now: ctx.now });
  if (!v.valid) throw new Error('this license is not valid (' + v.reason + ') — nothing was activated');

  const rec = { token: token, tier: v.tier, email: v.email, expiry: v.expiry, issued: v.issued, activatedAt: ctx.now() };
  atomicWrite(licensePath(ctx), JSON.stringify(rec, null, 2), 0o600);
  return { tier: v.tier, email: v.email, expiry: v.expiry, valid: true };
}

// Remove any stored license (back to free). Returns whether one existed.
function deactivate(ctx) {
  const had = !!readStored(ctx);
  try { fs.rmSync(licensePath(ctx), { force: true }); } catch (e) { /* best effort */ }
  return had;
}

// status(ctx) -> { tier, email, expiry, valid, reason }. tier is the CLAIMED tier
// of the stored license (for display, e.g. "pro (expired)"); valid says whether
// it is currently in force. No license -> free / not valid.
function status(ctx) {
  const rec = readStored(ctx);
  if (!rec) return { tier: 'free', email: null, expiry: null, valid: false, reason: 'no-license' };
  const v = verify(rec.token, { now: ctx.now });
  return { tier: v.tier, email: v.email, expiry: v.expiry, valid: v.valid, reason: v.reason };
}

// tier(ctx) -> EFFECTIVE tier: 'free' unless a genuine, unexpired license grants
// more. This is the single source of truth every gate() consults.
function tier(ctx) {
  const rec = readStored(ctx);
  if (!rec) return 'free';
  const v = verify(rec.token, { now: ctx.now });
  return v.valid ? v.tier : 'free';
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
  if (gate(ctx, feature)) return true;
  const min = FEATURES[feature] || 'pro';
  const err = new Error('this feature needs the ' + min + ' plan (keyflip license activate ...)');
  err.code = 'LICENSE_REQUIRED';
  err.feature = feature;
  err.requiredTier = min;
  err.currentTier = tier(ctx);
  throw err;
}

// Feature names unlocked at the current effective tier (handy for status UIs).
function unlockedFeatures(ctx) {
  const cur = rankOf(tier(ctx));
  return Object.keys(FEATURES).filter(function (f) { return cur >= rankOf(FEATURES[f]); }).sort();
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
  const canonical = canonicalPayload(p);
  const key = (typeof privKey === 'string' || Buffer.isBuffer(privKey)) ? crypto.createPrivateKey(privKey) : privKey;
  const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), key);
  return b64uEnc(Buffer.from(canonical, 'utf8')) + '.' + b64uEnc(sig);
}

// ---- MCP tool descriptors (spliced into src/mcp.js TOOLS via wiring) ---------
// Self-contained (own annotations + confirm check) so mcp.js only has to concat
// them. status = read-only; activate = mutating + requires confirm:true.
const mcpTools = [
  {
    name: 'keyflip_license_status',
    title: 'License / plan status',
    description: 'Show the machine\'s keyflip license: effective plan (free|pro|team|enterprise), the licensed email, expiry, whether it is currently valid, and which paid features are unlocked. Fully offline (no phone-home). Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    run: async function (ctx) {
      const s = status(ctx);
      return { plan: tier(ctx), tier: s.tier, email: s.email, expiry: s.expiry, valid: s.valid, reason: s.reason, features: unlockedFeatures(ctx) };
    },
  },
  {
    name: 'keyflip_license_activate',
    title: 'Activate a license file',
    description: 'Verify a license FILE offline and, if valid, store it as this machine\'s license (unlocking its plan). Pass the path to the license file. Mutating — ask the user first, then set confirm=true.',
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
      if (!args || args.confirm !== true) throw new Error('confirmation required: ask the user first, then call again with confirm=true');
      const r = activate(ctx, { file: String(args.file) });
      return { activated: true, tier: r.tier, email: r.email, expiry: r.expiry };
    },
  },
];

module.exports = {
  // verification / minting
  verify: verify,
  makeLicense: makeLicense,
  signCommandForTest: makeLicense, // alias — mint a license in tests
  canonicalPayload: canonicalPayload,
  setPublicKey: setPublicKey,
  getPublicKeyB64: getPublicKeyB64,
  PUBKEY_B64: PUBKEY_B64,
  // state
  activate: activate,
  deactivate: deactivate,
  status: status,
  tier: tier,
  licensePath: licensePath,
  // gating
  gate: gate,
  requireTier: requireTier,
  unlockedFeatures: unlockedFeatures,
  FEATURES: FEATURES,
  TIER_ORDER: TIER_ORDER,
  // wiring
  mcpTools: mcpTools,
};
