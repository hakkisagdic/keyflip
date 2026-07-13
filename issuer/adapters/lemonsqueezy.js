'use strict';
// ADAPTER: Lemon Squeezy webhook receiver for the keyflip license issuer.
//
// Role: authenticate an incoming Lemon Squeezy webhook and, once authentic,
// distill it into the neutral business event the issuer acts on
// ({type, email, product, orderId}). A verified 'purchase' triggers minting +
// emailing a signed Ed25519 license; a 'refund' triggers revocation. This file
// NEVER mints anything and NEVER touches the issuer private key.
//
// Security notes:
//   * The signing secret is the one configured on the Lemon Squeezy webhook. It
//     is passed in by the caller (which reads it from process.env) — never
//     hardcoded, logged, or persisted here.
//   * Verification runs over the EXACT raw request bytes (Buffer). Never
//     re-serialize the JSON first — that would change the bytes and both break a
//     genuine signature and risk validating a forged, re-encoded body.
//   * The comparison uses crypto.timingSafeEqual on equal-length buffers.
//
// Lemon Squeezy's scheme (https://docs.lemonsqueezy.com/help/webhooks/signing-requests):
//   header 'X-Signature' : hex HMAC-SHA256(secret, rawBody)
//   verify               : recompute HMAC-SHA256 of the raw body with the signing
//                          secret, hex-encode it, and constant-time compare to the
//                          header. (No timestamp component — unlike Stripe.)
const crypto = require('crypto');

function asBuffer(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (rawBody == null) return Buffer.alloc(0);
  return Buffer.from(String(rawBody), 'utf8');
}

function signatureHeader(headers) {
  if (!headers || typeof headers !== 'object') return '';
  const v = headers['x-signature'] != null ? headers['x-signature'] : headers['X-Signature'];
  return v == null ? '' : String(v);
}

// Constant-time hex compare; rejects on length mismatch before timingSafeEqual.
function hexEqual(aHex, bHex) {
  if (typeof aHex !== 'string' || typeof bHex !== 'string') return false;
  if (aHex.length !== bHex.length || aHex.length === 0) return false;
  let a, b;
  try { a = Buffer.from(aHex, 'hex'); b = Buffer.from(bHex, 'hex'); }
  catch (e) { return false; }
  if (a.length !== b.length || a.length === 0) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}

function verifyWebhook(rawBody, headers, secret /*, opts */) {
  if (typeof secret !== 'string' || secret.length === 0) return { ok: false, reason: 'no-secret' };

  const provided = signatureHeader(headers).trim();
  if (!provided) return { ok: false, reason: 'missing-signature' };
  if (!/^[0-9a-fA-F]+$/.test(provided)) return { ok: false, reason: 'malformed-signature' };

  const expected = crypto.createHmac('sha256', secret).update(asBuffer(rawBody)).digest('hex');
  if (!hexEqual(provided.toLowerCase(), expected)) return { ok: false, reason: 'signature-mismatch' };
  return { ok: true };
}

// ---- event parsing (only call AFTER verifyWebhook returns ok) ----------------
// meta.event_name -> neutral type.
const TYPE_MAP = Object.assign(Object.create(null), {
  order_created: 'purchase',
  subscription_created: 'purchase',
  refund: 'refund',
  order_refunded: 'refund',
  subscription_expired: 'other',
});

// Product = the first order item's variant/product id. Shapes vary by event:
//   order_created:   data.attributes.first_order_item.{variant_id,product_id}
//   subscription_*:  data.attributes.{variant_id,product_id}
function extractProduct(attrs) {
  if (!attrs || typeof attrs !== 'object') return null;
  const foi = attrs.first_order_item;
  if (foi && typeof foi === 'object') {
    if (foi.variant_id != null) return String(foi.variant_id);
    if (foi.product_id != null) return String(foi.product_id);
  }
  if (attrs.variant_id != null) return String(attrs.variant_id);
  if (attrs.product_id != null) return String(attrs.product_id);
  return null;
}

function parseEvent(rawBody /*, headers */) {
  let body;
  try { body = JSON.parse(asBuffer(rawBody).toString('utf8')); }
  catch (e) { return null; }
  if (!body || typeof body !== 'object') return null;

  const meta = body.meta && typeof body.meta === 'object' ? body.meta : {};
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  const attrs = data.attributes && typeof data.attributes === 'object' ? data.attributes : {};

  const type = TYPE_MAP[meta.event_name] || 'other';
  return {
    type: type,
    email: attrs.user_email != null ? String(attrs.user_email) : null,
    product: extractProduct(attrs),
    orderId: data.id != null ? String(data.id) : null,
    raw: body,
  };
}

module.exports = {
  id: 'lemonsqueezy',
  verifyWebhook: verifyWebhook,
  parseEvent: parseEvent,
};
