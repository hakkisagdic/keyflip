'use strict';
// ADAPTER: Stripe webhook receiver for the keyflip license issuer.
//
// Role: authenticate an incoming Stripe webhook request and, once authentic,
// distill it into the neutral business event the issuer acts on
// ({type, email, product, orderId}). A verified 'purchase' event is what
// ultimately triggers minting + emailing a signed Ed25519 license token; a
// 'refund' event is what triggers a revocation. This file NEVER mints anything
// and NEVER touches the issuer private key — it only proves the message really
// came from Stripe and reads fields out of it.
//
// Security notes:
//   * The signing secret (Stripe endpoint's "whsec_..." secret) is passed in by
//     the caller, which reads it from process.env — it is never hardcoded,
//     logged, or written to disk here.
//   * Verification is done over the EXACT raw request bytes (a Buffer). Never
//     re-serialize the JSON before verifying: a re-encode would change bytes and
//     break the HMAC, and worse, verifying re-serialized data would let a forged
//     body slip through. rawBody in == rawBody hashed.
//   * All signature comparisons use crypto.timingSafeEqual on equal-length
//     buffers to avoid leaking the secret through timing.
//   * A replay window (default 300s, matching Stripe's own libraries) is enforced
//     against opts.now (an injectable () => epoch-milliseconds), so an attacker
//     cannot replay a captured-but-old request.
//
// Stripe's scheme (https://docs.stripe.com/webhooks — "Verify manually"):
//   header  'Stripe-Signature': "t=<unixSeconds>,v1=<hexHmac>[,v0=...]"
//   signed  payload           : "<t>.<rawBody>"
//   expected                  : HMAC-SHA256(secret, signedPayload) as lowercase hex
//   accept                    : any v1 in the header that matches expected AND
//                               |now - t| <= tolerance. Only v1 is trusted
//                               (ignore v0/other schemes — downgrade protection).
const crypto = require('crypto');

const DEFAULT_TOLERANCE_SEC = 300;

function asBuffer(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (rawBody == null) return Buffer.alloc(0);
  return Buffer.from(String(rawBody), 'utf8');
}

// Pull the raw 'stripe-signature' value from LOWERCASED headers (the shared
// interface guarantees lowercase keys), tolerating a stray original-case key.
function signatureHeader(headers) {
  if (!headers || typeof headers !== 'object') return '';
  const v = headers['stripe-signature'] != null ? headers['stripe-signature'] : headers['Stripe-Signature'];
  return v == null ? '' : String(v);
}

// Parse "t=..,v1=..,v1=..,v0=.." into { t: <string|null>, v1: [hex,...] }.
// Multiple v1 values are allowed (Stripe sends more than one during a secret
// roll); a match against ANY of them is acceptance.
function parseSignatureHeader(header) {
  const out = { t: null, v1: [] };
  const parts = String(header).split(',');
  for (let i = 0; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq === -1) continue;
    const key = parts[i].slice(0, eq).trim();
    const val = parts[i].slice(eq + 1).trim();
    if (key === 't') out.t = val;
    else if (key === 'v1') out.v1.push(val);
  }
  return out;
}

// Constant-time hex compare. Rejects immediately on length mismatch (which is
// itself not secret) so timingSafeEqual only ever sees equal-length buffers.
function hexEqual(aHex, bHex) {
  if (typeof aHex !== 'string' || typeof bHex !== 'string') return false;
  if (aHex.length !== bHex.length || aHex.length === 0) return false;
  let a, b;
  try { a = Buffer.from(aHex, 'hex'); b = Buffer.from(bHex, 'hex'); }
  catch (e) { return false; }
  if (a.length !== b.length || a.length === 0) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}

function nowMs(opts) {
  if (opts && typeof opts.now === 'function') return Number(opts.now());
  return Date.now();
}

function verifyWebhook(rawBody, headers, secret, opts) {
  opts = opts || {};
  if (typeof secret !== 'string' || secret.length === 0) return { ok: false, reason: 'no-secret' };

  const header = signatureHeader(headers);
  if (!header) return { ok: false, reason: 'missing-signature' };

  const parsed = parseSignatureHeader(header);
  if (parsed.t == null || !/^\d+$/.test(parsed.t)) return { ok: false, reason: 'malformed-signature' };
  if (parsed.v1.length === 0) return { ok: false, reason: 'no-v1-scheme' };

  const raw = asBuffer(rawBody);

  // signed_payload = "<t>.<rawBody>" — build it as bytes so the raw body is
  // hashed verbatim (no utf8 round-trip of the body).
  const signedPayload = Buffer.concat([Buffer.from(parsed.t + '.', 'utf8'), raw]);
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

  let matched = false;
  for (let i = 0; i < parsed.v1.length; i++) {
    if (hexEqual(parsed.v1[i], expected)) { matched = true; break; }
  }
  if (!matched) return { ok: false, reason: 'signature-mismatch' };

  // Replay window: |now - t| must be within tolerance. Checked only AFTER the
  // signature matches, so a bogus t on a forged request is already rejected.
  const tolerance = (opts.tolerance == null ? DEFAULT_TOLERANCE_SEC : Number(opts.tolerance));
  if (tolerance > 0) {
    const tSec = Number(parsed.t);
    const nowSec = Math.floor(nowMs(opts) / 1000);
    if (!isFinite(nowSec) || Math.abs(nowSec - tSec) > tolerance) {
      return { ok: false, reason: 'timestamp-out-of-tolerance' };
    }
  }
  return { ok: true };
}

// ---- event parsing (only call AFTER verifyWebhook returns ok) ----------------
const TYPE_MAP = Object.assign(Object.create(null), {
  'checkout.session.completed': 'purchase',
  'invoice.paid': 'purchase',
  'charge.refunded': 'refund',
});

// Best-effort product extraction across the object shapes Stripe sends for the
// mapped events (checkout session / invoice / charge). Returns a string id/name
// or null — the issuer treats product as advisory metadata, not a trust input.
function extractProduct(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.metadata && obj.metadata.product != null) return String(obj.metadata.product);
  if (obj.metadata && obj.metadata.product_id != null) return String(obj.metadata.product_id);
  // invoice: lines.data[0].price.product ; charge/session may carry a price too.
  const line = obj.lines && Array.isArray(obj.lines.data) ? obj.lines.data[0] : null;
  if (line && line.price && line.price.product != null) return String(line.price.product);
  if (obj.price && obj.price.product != null) return String(obj.price.product);
  if (obj.plan && obj.plan.product != null) return String(obj.plan.product);
  return null;
}

function extractEmail(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.customer_details && obj.customer_details.email != null) return String(obj.customer_details.email);
  if (obj.customer_email != null) return String(obj.customer_email);
  if (obj.billing_details && obj.billing_details.email != null) return String(obj.billing_details.email);
  if (obj.receipt_email != null) return String(obj.receipt_email);
  return null;
}

function parseEvent(rawBody /*, headers */) {
  let event;
  try { event = JSON.parse(asBuffer(rawBody).toString('utf8')); }
  catch (e) { return null; }
  if (!event || typeof event !== 'object') return null;

  const obj = event.data && typeof event.data === 'object' ? event.data.object : null;
  const type = TYPE_MAP[event.type] || 'other';
  return {
    type: type,
    email: extractEmail(obj),
    product: extractProduct(obj),
    orderId: obj && obj.id != null ? String(obj.id) : (event.id != null ? String(event.id) : null),
    raw: event,
  };
}

module.exports = {
  id: 'stripe',
  verifyWebhook: verifyWebhook,
  parseEvent: parseEvent,
  // exported for tests / reuse
  parseSignatureHeader: parseSignatureHeader,
  DEFAULT_TOLERANCE_SEC: DEFAULT_TOLERANCE_SEC,
};
