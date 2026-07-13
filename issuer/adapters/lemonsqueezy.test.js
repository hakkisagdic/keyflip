'use strict';
// TESTS for the Lemon Squeezy webhook adapter. Zero-dependency (node:test +
// node:assert). Run: node --test issuer/**/*.test.js
//
// Covers, per contract: a validly-signed request verifies ok=true; a forged /
// short / wrong / missing signature verifies ok=false; and parseEvent maps the
// event_name values + extracts email/product/orderId. The signature is minted
// here with a known secret so no network or real Lemon Squeezy key is needed.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const ls = require('./lemonsqueezy');

const SECRET = 'ls_test_secret_' + 'b'.repeat(20);

// X-Signature = hex HMAC-SHA256(secret, rawBody).
function sign(rawBody, secret) {
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  return crypto.createHmac('sha256', secret).update(buf).digest('hex');
}

test('verifyWebhook: valid signature -> ok', function () {
  const body = JSON.stringify({ meta: { event_name: 'order_created' }, data: { id: '77' } });
  const sig = sign(body, SECRET);
  const r = ls.verifyWebhook(Buffer.from(body), { 'x-signature': sig }, SECRET);
  assert.strictEqual(r.ok, true, r.reason);
});

test('verifyWebhook: raw Buffer body (not re-serialized) verifies', function () {
  const raw = Buffer.from('{ "meta" : { "event_name":"refund" }, "data":{"id":"9"} }');
  const sig = sign(raw, SECRET);
  const r = ls.verifyWebhook(raw, { 'x-signature': sig }, SECRET);
  assert.strictEqual(r.ok, true, r.reason);
});

test('verifyWebhook: uppercase hex signature still verifies', function () {
  const body = JSON.stringify({ meta: { event_name: 'order_created' }, data: { id: '1' } });
  const sig = sign(body, SECRET).toUpperCase();
  const r = ls.verifyWebhook(Buffer.from(body), { 'x-signature': sig }, SECRET);
  assert.strictEqual(r.ok, true, r.reason);
});

test('verifyWebhook: wrong secret -> ok:false', function () {
  const body = JSON.stringify({ meta: { event_name: 'order_created' }, data: { id: '1' } });
  const sig = sign(body, 'a-different-secret');
  const r = ls.verifyWebhook(Buffer.from(body), { 'x-signature': sig }, SECRET);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'signature-mismatch');
});

test('verifyWebhook: tampered body -> ok:false', function () {
  const body = JSON.stringify({ meta: { event_name: 'order_created' }, data: { id: '1' } });
  const sig = sign(body, SECRET);
  const tampered = JSON.stringify({ meta: { event_name: 'order_created' }, data: { id: '999' } });
  const r = ls.verifyWebhook(Buffer.from(tampered), { 'x-signature': sig }, SECRET);
  assert.strictEqual(r.ok, false);
});

test('verifyWebhook: short signature -> ok:false (no timing crash)', function () {
  const body = JSON.stringify({ meta: { event_name: 'order_created' }, data: { id: '1' } });
  const sig = sign(body, SECRET).slice(0, 8);
  const r = ls.verifyWebhook(Buffer.from(body), { 'x-signature': sig }, SECRET);
  assert.strictEqual(r.ok, false);
});

test('verifyWebhook: non-hex signature -> ok:false', function () {
  const body = '{}';
  const r = ls.verifyWebhook(Buffer.from(body), { 'x-signature': 'zzzz-not-hex-zzzz' }, SECRET);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'malformed-signature');
});

test('verifyWebhook: missing header -> ok:false', function () {
  const r = ls.verifyWebhook(Buffer.from('{}'), {}, SECRET);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'missing-signature');
});

test('verifyWebhook: no secret -> ok:false', function () {
  const r = ls.verifyWebhook(Buffer.from('{}'), { 'x-signature': 'deadbeef' }, '');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no-secret');
});

// ---- parseEvent --------------------------------------------------------------
test('parseEvent: order_created -> purchase (email, first_order_item variant id, order id)', function () {
  const body = JSON.stringify({
    meta: { event_name: 'order_created' },
    data: { id: '12345', attributes: { user_email: 'buyer@x.com', first_order_item: { variant_id: 555, product_id: 111 } } },
  });
  const ev = ls.parseEvent(Buffer.from(body));
  assert.strictEqual(ev.type, 'purchase');
  assert.strictEqual(ev.email, 'buyer@x.com');
  assert.strictEqual(ev.orderId, '12345');
  assert.strictEqual(ev.product, '555'); // variant_id preferred
});

test('parseEvent: subscription_created -> purchase (variant on attributes)', function () {
  const body = JSON.stringify({
    meta: { event_name: 'subscription_created' },
    data: { id: 'sub_1', attributes: { user_email: 's@x.com', variant_id: 777 } },
  });
  const ev = ls.parseEvent(Buffer.from(body));
  assert.strictEqual(ev.type, 'purchase');
  assert.strictEqual(ev.product, '777');
  assert.strictEqual(ev.orderId, 'sub_1');
});

test('parseEvent: refund -> refund', function () {
  const body = JSON.stringify({ meta: { event_name: 'refund' }, data: { id: 'r1', attributes: { user_email: 'r@x.com' } } });
  const ev = ls.parseEvent(Buffer.from(body));
  assert.strictEqual(ev.type, 'refund');
  assert.strictEqual(ev.email, 'r@x.com');
});

test('parseEvent: subscription_expired -> other', function () {
  const body = JSON.stringify({ meta: { event_name: 'subscription_expired' }, data: { id: 'e1', attributes: {} } });
  const ev = ls.parseEvent(Buffer.from(body));
  assert.strictEqual(ev.type, 'other');
  assert.strictEqual(ev.orderId, 'e1');
});

test('parseEvent: unknown event_name -> other', function () {
  const body = JSON.stringify({ meta: { event_name: 'license_key_created' }, data: { id: 'x' } });
  const ev = ls.parseEvent(Buffer.from(body));
  assert.strictEqual(ev.type, 'other');
});

test('parseEvent: invalid JSON -> null', function () {
  assert.strictEqual(ls.parseEvent(Buffer.from('<<<not json>>>')), null);
});
