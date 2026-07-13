'use strict';
// Tests for the iyzico webhook adapter: a valid X-IYZ-SIGNATURE-V3 verifies, a
// tampered signature/body does not, and timingSafeEqual never throws on a
// length-mismatched (garbage) header. Zero-dep: node:test + node:assert + crypto.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const iyzico = require('./iyzico');

const SECRET = 'sandbox-qaIiLIxhjMgx3LSKIVvp6j17NunHOFtD';

// Recompute the adapter's Direct-format signed string + hex signature so the test
// is an independent oracle (not a copy of the module's internals beyond the doc'd
// contract: secretKey is both the HMAC key AND the data prefix).
function signDirect(body) {
  const data = SECRET + String(body.iyziEventType) + String(body.paymentId) +
    String(body.paymentConversationId) + String(body.status);
  return crypto.createHmac('sha256', SECRET).update(data, 'utf8').digest('hex');
}

function directBody() {
  return { iyziEventType: 'PAYMENT_API', paymentId: '22416032',
    paymentConversationId: 'order-777', status: 'SUCCESS' };
}

test('valid V3 signature (direct payment) verifies ok', () => {
  const body = directBody();
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  const sig = signDirect(body);
  const r = iyzico.verifyWebhook(raw, { 'x-iyz-signature-v3': sig }, SECRET);
  assert.strictEqual(r.ok, true);
});

test('uppercase hex header still verifies (case-insensitive hex)', () => {
  const body = directBody();
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  const sig = signDirect(body).toUpperCase();
  const r = iyzico.verifyWebhook(raw, { 'x-iyz-signature-v3': sig }, SECRET);
  assert.strictEqual(r.ok, true);
});

test('wrong signature is rejected', () => {
  const body = directBody();
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  // Correct length, wrong content: flip the last hex nibble.
  const good = signDirect(body);
  const bad = good.slice(0, -1) + (good.slice(-1) === '0' ? '1' : '0');
  const r = iyzico.verifyWebhook(raw, { 'x-iyz-signature-v3': bad }, SECRET);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'bad-signature');
});

test('tampered body (status flipped) is rejected under the original signature', () => {
  const body = directBody();
  const sig = signDirect(body);
  const tampered = Object.assign({}, body, { status: 'FAILURE' });
  const raw = Buffer.from(JSON.stringify(tampered), 'utf8');
  const r = iyzico.verifyWebhook(raw, { 'x-iyz-signature-v3': sig }, SECRET);
  assert.strictEqual(r.ok, false);
});

test('length-mismatched / non-hex header does not throw and returns ok:false', () => {
  const body = directBody();
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  for (const junk of ['', 'zz', 'not-hex!!', 'abcd', signDirect(body) + 'ff']) {
    let r;
    assert.doesNotThrow(() => { r = iyzico.verifyWebhook(raw, { 'x-iyz-signature-v3': junk }, SECRET); });
    assert.strictEqual(r.ok, false);
  }
});

test('missing header / missing secret are reported, not thrown', () => {
  const raw = Buffer.from(JSON.stringify(directBody()), 'utf8');
  assert.strictEqual(iyzico.verifyWebhook(raw, {}, SECRET).reason, 'missing-signature');
  assert.strictEqual(iyzico.verifyWebhook(raw, { 'x-iyz-signature-v3': 'ab' }, '').reason, 'no-secret');
});

test('HPP (token present) uses the token variant of the signed string', () => {
  const body = { iyziEventType: 'CHECKOUT_FORM_AUTH', iyziPaymentId: '99',
    token: 'tok_abc', paymentConversationId: 'order-9', status: 'SUCCESS' };
  const data = SECRET + body.iyziEventType + body.iyziPaymentId + body.token +
    body.paymentConversationId + body.status;
  const sig = crypto.createHmac('sha256', SECRET).update(data, 'utf8').digest('hex');
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  const r = iyzico.verifyWebhook(raw, { 'x-iyz-signature-v3': sig }, SECRET);
  assert.strictEqual(r.ok, true);
});

test('parseEvent maps a successful payment to purchase with orderId', () => {
  const body = directBody();
  const ev = iyzico.parseEvent(Buffer.from(JSON.stringify(body), 'utf8'));
  assert.strictEqual(ev.type, 'purchase');
  assert.strictEqual(ev.orderId, 'order-777');
});

test('parseEvent maps a refund/cancel event to refund', () => {
  const body = { iyziEventType: 'PAYMENT_REFUND', paymentId: '1', paymentConversationId: 'o', status: 'SUCCESS' };
  const ev = iyzico.parseEvent(Buffer.from(JSON.stringify(body), 'utf8'));
  assert.strictEqual(ev.type, 'refund');
});

test('parseEvent maps a failed payment to other', () => {
  const body = Object.assign(directBody(), { status: 'FAILURE' });
  const ev = iyzico.parseEvent(Buffer.from(JSON.stringify(body), 'utf8'));
  assert.strictEqual(ev.type, 'other');
});

test('parseEvent returns null on non-JSON body', () => {
  assert.strictEqual(iyzico.parseEvent(Buffer.from('not json', 'utf8')), null);
});

test('adapter exposes the shared interface shape', () => {
  assert.strictEqual(iyzico.id, 'iyzico');
  assert.strictEqual(typeof iyzico.verifyWebhook, 'function');
  assert.strictEqual(typeof iyzico.parseEvent, 'function');
});
