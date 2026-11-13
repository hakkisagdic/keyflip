'use strict';
// ADAPTER: iyzico (Turkish PSP) webhook/notification verification + event parsing
// for the keyflip license issuer. iyzico POSTs a JSON notification to our webhook
// URL when a payment settles / is refunded; this module authenticates that POST
// and extracts the business event (purchase | refund) so the issuer can mint the
// right license.
//
// SECURITY NOTES:
//   * The iyzico signing SECRET (your account "secretKey") is a credential. It is
//     read from process.env ONLY (never argv, never logged, never committed). The
//     caller passes it in as `secret`; this module never persists or prints it.
//   * ALL signature comparisons go through crypto.timingSafeEqual over EQUAL-length
//     buffers (we guard lengths first) so verification leaks no timing signal and
//     never throws on a length mismatch.
//   * We verify over the EXACT raw request bytes the server received. We JSON.parse
//     a COPY only to read fields for reconstructing the signed string; we never
//     re-serialize the body and hash that.

const crypto = require('crypto');

const HEADER = 'x-iyz-signature-v3';

// Lowercase-hex HMAC-SHA256 of `data` keyed by `secret`.
function hmacHex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data, 'utf8').digest('hex');
}

// Constant-time equality of two hex strings. Decodes both from hex so casing is
// normalized, and GUARDS lengths so timingSafeEqual (which throws on unequal
// lengths) is only ever called on equal-length buffers.
function safeEqualHex(aHex, bHex) {
  let a, b;
  try {
    a = Buffer.from(String(aHex), 'hex');
    b = Buffer.from(String(bHex), 'hex');
  } catch (e) {
    return false;
  }
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function field(v) {
  return v == null ? '' : String(v);
}

// Build the concatenated data string iyzico signed, choosing the HPP variant when
// a `token` is present (hosted checkout) and the Direct variant otherwise.
function signedData(secret, body, opts) {
  opts = opts || {};
  const prepend = opts.prependSecret === false ? '' : field(secret);
  const sep = opts.separator == null ? '' : String(opts.separator);
  const parts = [];
  if (Object.prototype.hasOwnProperty.call(body, 'token') && body.token != null && body.token !== '') {
    parts.push(
      field(body.iyziEventType),
      field(body.iyziPaymentId),
      field(body.token),
      field(body.paymentConversationId),
      field(body.status),
    );
  } else {
    parts.push(field(body.iyziEventType), field(body.paymentId), field(body.paymentConversationId), field(body.status));
  }
  return prepend + parts.join(sep);
}

function parseBody(rawBody) {
  try {
    return JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || ''));
  } catch (e) {
    return null;
  }
}

// Map an iyziEventType (+status) to our coarse business event kind.
function eventKind(body) {
  const t = String((body && body.iyziEventType) || '').toUpperCase();
  const status = String((body && body.status) || '').toUpperCase();
  if (/REFUND|CANCEL|CHARGEBACK/.test(t)) return 'refund';
  if (/PAYMENT|THREE_DS|BALANCE|CHECKOUT|SETTLE/.test(t)) {
    return status === 'SUCCESS' ? 'purchase' : 'other';
  }
  return 'other';
}

function extractAmount(body) {
  const raw = body.paidPrice != null ? body.paidPrice : body.price != null ? body.price : body.amount;
  if (raw == null || raw === '') return null;
  const num = Number(raw);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function extractCurrency(body, amount) {
  if (body.currency != null && String(body.currency).trim() !== '') {
    return String(body.currency).trim().toUpperCase();
  }
  return amount != null ? 'TRY' : null;
}

function extractSeats(body) {
  const raw = body.seats != null ? body.seats : body.seatCount;
  if (raw == null) return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

module.exports = {
  id: 'iyzico',

  // Verify the X-IYZ-SIGNATURE-V3 header over the raw body. Returns {ok, reason?}.
  verifyWebhook: function (rawBody, headers, secret, opts) {
    if (!secret) return { ok: false, reason: 'no-secret' };
    headers = headers || {};
    const sig = headers[HEADER];
    if (!sig) return { ok: false, reason: 'missing-signature' };
    const body = parseBody(rawBody);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'bad-json' };

    const expected = hmacHex(secret, signedData(secret, body, opts));
    if (!safeEqualHex(sig, expected)) return { ok: false, reason: 'bad-signature' };
    return { ok: true };
  },

  // Extract the business event AFTER verification. Surfaces email, product/basketId,
  // orderId, amount (paidPrice/price), currency (TRY/USD), seats, and countryCode.
  parseEvent: function (rawBody /*, headers */) {
    const body = parseBody(rawBody);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const basketId = body.basketId != null ? String(body.basketId) : null;
    const product =
      body.product != null
        ? String(body.product)
        : body.productName != null
          ? String(body.productName)
          : basketId;
    const amount = extractAmount(body);
    const currency = extractCurrency(body, amount);
    const seats = extractSeats(body);
    const countryCode =
      body.countryCode != null
        ? String(body.countryCode).toUpperCase()
        : body.buyerCountry != null
          ? String(body.buyerCountry).toUpperCase()
          : 'TR';
    return {
      type: eventKind(body),
      email: body.email != null ? String(body.email) : body.buyerEmail != null ? String(body.buyerEmail) : null,
      product: product,
      basketId: basketId,
      amount: amount,
      currency: currency,
      seats: seats,
      countryCode: countryCode,
      orderId:
        body.paymentConversationId != null
          ? String(body.paymentConversationId)
          : body.conversationId != null
            ? String(body.conversationId)
            : null,
      raw: body,
    };
  },
};
