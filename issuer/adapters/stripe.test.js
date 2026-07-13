'use strict';
// TESTS for the Stripe webhook adapter. Zero-dependency (node:test + node:assert).
// Run: node --test issuer/**/*.test.js
//
// Covers, per contract: a validly-signed request verifies ok=true; a forged /
// short / wrong / missing signature verifies ok=false; a genuine signature whose
// timestamp is older than the tolerance verifies ok=false; and parseEvent maps
// the Stripe event types + extracts email/product/orderId. Signatures are minted
// here with a known secret so no network or real Stripe key is needed.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const stripe = require('./stripe');

const SECRET = 'whsec_test_' + 'a'.repeat(24);

// Mint a Stripe-Signature header for a body at unix-second `t` using `secret`.
function sign(rawBody, t, secret) {
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  const signedPayload = Buffer.concat([Buffer.from(t + '.', 'utf8'), buf]);
  const v1 = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return { header: 't=' + t + ',v1=' + v1, v1: v1 };
}

const T = 1_700_000_000; // fixed unix seconds
const NOW = () => T * 1000; // opts.now returns epoch ms, at exactly t

test('verifyWebhook: valid signature within tolerance -> ok', function () {
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const { header } = sign(body, T, SECRET);
  const r = stripe.verifyWebhook(Buffer.from(body), { 'stripe-signature': header }, SECRET, { now: NOW });
  assert.strictEqual(r.ok, true, r.reason);
});

test('verifyWebhook: raw Buffer body (not re-serialized) verifies', function () {
  // Body with insignificant whitespace: re-serializing would change bytes and
  // break the HMAC. Verifying the raw buffer must still pass.
  const raw = Buffer.from('{ "id":"evt_2",  "type" : "invoice.paid" }');
  const { header } = sign(raw, T, SECRET);
  const r = stripe.verifyWebhook(raw, { 'stripe-signature': header }, SECRET, { now: NOW });
  assert.strictEqual(r.ok, true, r.reason);
});

test('verifyWebhook: forged/wrong signature -> ok:false', function () {
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const { header } = sign(body, T, 'whsec_the_wrong_secret_zzzzzzzzzzz');
  const r = stripe.verifyWebhook(Buffer.from(body), { 'stripe-signature': header }, SECRET, { now: NOW });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'signature-mismatch');
});

test('verifyWebhook: tampered body -> ok:false', function () {
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const { header } = sign(body, T, SECRET);
  const tampered = JSON.stringify({ id: 'evt_1', type: 'charge.refunded' });
  const r = stripe.verifyWebhook(Buffer.from(tampered), { 'stripe-signature': header }, SECRET, { now: NOW });
  assert.strictEqual(r.ok, false);
});

test('verifyWebhook: short/truncated v1 -> ok:false (no timing crash)', function () {
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const { v1 } = sign(body, T, SECRET);
  const header = 't=' + T + ',v1=' + v1.slice(0, 10); // wrong length
  const r = stripe.verifyWebhook(Buffer.from(body), { 'stripe-signature': header }, SECRET, { now: NOW });
  assert.strictEqual(r.ok, false);
});

test('verifyWebhook: missing signature header -> ok:false', function () {
  const body = '{}';
  const r = stripe.verifyWebhook(Buffer.from(body), {}, SECRET, { now: NOW });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'missing-signature');
});

test('verifyWebhook: no v1 scheme (only v0) -> ok:false', function () {
  const body = '{}';
  const header = 't=' + T + ',v0=deadbeef';
  const r = stripe.verifyWebhook(Buffer.from(body), { 'stripe-signature': header }, SECRET, { now: NOW });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no-v1-scheme');
});

test('verifyWebhook: no secret -> ok:false', function () {
  const r = stripe.verifyWebhook(Buffer.from('{}'), { 'stripe-signature': 't=1,v1=x' }, '', { now: NOW });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no-secret');
});

test('verifyWebhook: timestamp too old (beyond 300s tolerance) -> ok:false', function () {
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const { header } = sign(body, T, SECRET); // signed at T (genuine signature)
  const lateNow = () => (T + 301) * 1000;    // but "now" is 301s later
  const r = stripe.verifyWebhook(Buffer.from(body), { 'stripe-signature': header }, SECRET, { now: lateNow });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'timestamp-out-of-tolerance');
});

test('verifyWebhook: timestamp just inside tolerance -> ok', function () {
  const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' });
  const { header } = sign(body, T, SECRET);
  const r = stripe.verifyWebhook(Buffer.from(body), { 'stripe-signature': header }, SECRET, { now: () => (T + 299) * 1000 });
  assert.strictEqual(r.ok, true, r.reason);
});

test('verifyWebhook: custom tolerance:0 disables recency, still verifies signature', function () {
  const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' });
  const { header } = sign(body, T, SECRET);
  const r = stripe.verifyWebhook(Buffer.from(body), { 'stripe-signature': header }, SECRET, { now: () => (T + 99999) * 1000, tolerance: 0 });
  assert.strictEqual(r.ok, true, r.reason);
});

// ---- parseEvent --------------------------------------------------------------
test('parseEvent: checkout.session.completed -> purchase (customer_details.email)', function () {
  const body = JSON.stringify({
    id: 'evt_x', type: 'checkout.session.completed',
    data: { object: { id: 'cs_123', customer_details: { email: 'a@b.com' }, metadata: { product: 'keyflip-pro' } } },
  });
  const ev = stripe.parseEvent(Buffer.from(body));
  assert.strictEqual(ev.type, 'purchase');
  assert.strictEqual(ev.email, 'a@b.com');
  assert.strictEqual(ev.orderId, 'cs_123');
  assert.strictEqual(ev.product, 'keyflip-pro');
});

test('parseEvent: invoice.paid -> purchase (customer_email fallback, line price.product)', function () {
  const body = JSON.stringify({
    id: 'evt_y', type: 'invoice.paid',
    data: { object: { id: 'in_9', customer_email: 'c@d.com', lines: { data: [{ price: { product: 'prod_ABC' } }] } } },
  });
  const ev = stripe.parseEvent(Buffer.from(body));
  assert.strictEqual(ev.type, 'purchase');
  assert.strictEqual(ev.email, 'c@d.com');
  assert.strictEqual(ev.orderId, 'in_9');
  assert.strictEqual(ev.product, 'prod_ABC');
});

test('parseEvent: charge.refunded -> refund', function () {
  const body = JSON.stringify({
    id: 'evt_z', type: 'charge.refunded',
    data: { object: { id: 'ch_5', billing_details: { email: 'e@f.com' } } },
  });
  const ev = stripe.parseEvent(Buffer.from(body));
  assert.strictEqual(ev.type, 'refund');
  assert.strictEqual(ev.email, 'e@f.com');
  assert.strictEqual(ev.orderId, 'ch_5');
});

test('parseEvent: unmapped type -> other', function () {
  const body = JSON.stringify({ id: 'evt_o', type: 'customer.created', data: { object: { id: 'cus_1' } } });
  const ev = stripe.parseEvent(Buffer.from(body));
  assert.strictEqual(ev.type, 'other');
  assert.strictEqual(ev.orderId, 'cus_1');
});

test('parseEvent: invalid JSON -> null', function () {
  assert.strictEqual(stripe.parseEvent(Buffer.from('not json')), null);
});
