'use strict';
// Tests for the PayTR callback adapter: a valid base64 HMAC hash verifies, a wrong
// hash does not, and timingSafeEqual never throws on a length-mismatched hash.
// Zero-dep: node:test + node:assert + crypto.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const paytr = require('./paytr');

const MERCHANT_KEY = 'test_merchant_key_ABC';   // -> `secret` param
const MERCHANT_SALT = 'test_merchant_salt_XYZ'; // -> opts.salt (env in prod)

// Independent oracle for the documented hash:
//   base64( HMAC_SHA256( merchant_oid + merchant_salt + status + total_amount, merchant_key ) )
function paytrHash(fields) {
  const data = String(fields.merchant_oid) + MERCHANT_SALT + String(fields.status) + String(fields.total_amount);
  return crypto.createHmac('sha256', MERCHANT_KEY).update(data, 'utf8').digest('base64');
}

// Build the url-encoded body PayTR actually POSTs.
function formBody(fields) {
  const p = new URLSearchParams();
  Object.keys(fields).forEach((k) => p.append(k, String(fields[k])));
  return Buffer.from(p.toString(), 'utf8');
}

function successFields() {
  return { merchant_oid: 'ORD1000', status: 'success', total_amount: '3456', payment_type: 'card', test_mode: '1' };
}

test('valid hash verifies ok (salt via opts)', () => {
  const f = successFields();
  f.hash = paytrHash(f);
  const r = paytr.verifyWebhook(formBody(f), {}, MERCHANT_KEY, { salt: MERCHANT_SALT });
  assert.strictEqual(r.ok, true);
});

test('valid hash verifies ok (salt via process.env)', () => {
  const prev = process.env.PAYTR_MERCHANT_SALT;
  process.env.PAYTR_MERCHANT_SALT = MERCHANT_SALT;
  try {
    const f = successFields();
    f.hash = paytrHash(f);
    const r = paytr.verifyWebhook(formBody(f), {}, MERCHANT_KEY);
    assert.strictEqual(r.ok, true);
  } finally {
    if (prev === undefined) delete process.env.PAYTR_MERCHANT_SALT;
    else process.env.PAYTR_MERCHANT_SALT = prev;
  }
});

test('wrong hash is rejected', () => {
  const f = successFields();
  const good = paytrHash(f);
  // Same byte length, different content: flip one base64 char.
  const buf = Buffer.from(good, 'base64');
  buf[0] = buf[0] ^ 0xff;
  f.hash = buf.toString('base64');
  const r = paytr.verifyWebhook(formBody(f), {}, MERCHANT_KEY, { salt: MERCHANT_SALT });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'bad-signature');
});

test('tampered total_amount is rejected under the original hash', () => {
  const f = successFields();
  f.hash = paytrHash(f);
  f.total_amount = '999999'; // change amount after signing
  const r = paytr.verifyWebhook(formBody(f), {}, MERCHANT_KEY, { salt: MERCHANT_SALT });
  assert.strictEqual(r.ok, false);
});

test('length-mismatched / garbage hash does not throw and returns ok:false', () => {
  const f = successFields();
  for (const junk of ['', 'AAAA', 'not base64 %%%', paytrHash(f) + 'AA']) {
    const body = Object.assign({}, f, { hash: junk });
    let r;
    assert.doesNotThrow(() => { r = paytr.verifyWebhook(formBody(body), {}, MERCHANT_KEY, { salt: MERCHANT_SALT }); });
    assert.strictEqual(r.ok, false);
  }
});

test('missing hash / secret / salt are reported, not thrown', () => {
  const f = successFields();
  assert.strictEqual(paytr.verifyWebhook(formBody(f), {}, MERCHANT_KEY, { salt: MERCHANT_SALT }).reason, 'missing-hash');
  f.hash = paytrHash(f);
  assert.strictEqual(paytr.verifyWebhook(formBody(f), {}, '', { salt: MERCHANT_SALT }).reason, 'no-secret');
  assert.strictEqual(paytr.verifyWebhook(formBody(f), {}, MERCHANT_KEY, { salt: '' }).reason, 'no-salt');
});

test('parseEvent maps success -> purchase, orderId = merchant_oid', () => {
  const ev = paytr.parseEvent(formBody(successFields()));
  assert.strictEqual(ev.type, 'purchase');
  assert.strictEqual(ev.orderId, 'ORD1000');
});

test('parseEvent maps failed -> other', () => {
  const f = Object.assign(successFields(), { status: 'failed', failed_reason_code: '0', failed_reason_msg: 'red' });
  const ev = paytr.parseEvent(formBody(f));
  assert.strictEqual(ev.type, 'other');
  assert.strictEqual(ev.orderId, 'ORD1000');
});

test('parseEvent returns null when merchant_oid is absent', () => {
  assert.strictEqual(paytr.parseEvent(Buffer.from('status=success', 'utf8')), null);
});

test('adapter exposes the shared interface shape', () => {
  assert.strictEqual(paytr.id, 'paytr');
  assert.strictEqual(typeof paytr.verifyWebhook, 'function');
  assert.strictEqual(typeof paytr.parseEvent, 'function');
});
