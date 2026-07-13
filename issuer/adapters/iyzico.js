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
//
// SIGNATURE SCHEME (X-IYZ-SIGNATURE-V3, the only version iyzico still supports):
//   iyzico's *webhook* V3 signature is HMAC-SHA256, HEX-encoded (lowercase), where
//   the account secretKey is used BOTH as the HMAC key AND as the first component
//   of the concatenated (separator-less) data string:
//
//     Direct (non-3DS / 3DS callback) payload:
//       data = secretKey + iyziEventType + paymentId + paymentConversationId + status
//     HPP (hosted checkout, `token` present) payload:
//       data = secretKey + iyziEventType + iyziPaymentId + token + paymentConversationId + status
//     signature = HEX( HMAC_SHA256(key = secretKey, data) )
//
//   Docs: https://docs.iyzico.com/en/advanced/webhook  (EN)
//         https://docs.iyzico.com/ek-servisler/webhook  (TR)
//
//   NEEDS-VERIFICATION: iyzico publishes TWO distinct V3 constructions and the docs
//   are inconsistent about them. The response/API signature (see
//   https://docs.iyzico.com/en/advanced/response-signature-validation ) uses ':'
//   separators and does NOT prepend the secretKey. The WEBHOOK signature (what we
//   verify here) prepends the secretKey with no separators, per the webhook page.
//   Confirm against a REAL sandbox notification before go-live; if a live payload
//   fails, try (a) the ':'-joined form and (b) omitting the secretKey prefix. The
//   `opts.separator` and `opts.prependSecret` knobs below let you flip either
//   without a code change.

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
  try { a = Buffer.from(String(aHex), 'hex'); b = Buffer.from(String(bHex), 'hex'); }
  catch (e) { return false; }
  // A non-hex header decodes to a short/empty buffer; length guard rejects it.
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Coerce a payload field to the exact string that went into the signature. iyzico
// sends numbers as JSON numbers sometimes; String() reproduces the canonical form.
function field(v) { return v == null ? '' : String(v); }

// Build the concatenated data string iyzico signed, choosing the HPP variant when
// a `token` is present (hosted checkout) and the Direct variant otherwise.
function signedData(secret, body, opts) {
  opts = opts || {};
  const prepend = opts.prependSecret === false ? '' : field(secret);
  const sep = opts.separator == null ? '' : String(opts.separator);
  const parts = [];
  if (Object.prototype.hasOwnProperty.call(body, 'token') && body.token != null && body.token !== '') {
    // HPP / hosted-checkout notification.
    parts.push(field(body.iyziEventType), field(body.iyziPaymentId), field(body.token),
      field(body.paymentConversationId), field(body.status));
  } else {
    // Direct API (non-3DS / 3DS) notification.
    parts.push(field(body.iyziEventType), field(body.paymentId),
      field(body.paymentConversationId), field(body.status));
  }
  return prepend + parts.join(sep);
}

function parseBody(rawBody) {
  try { return JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '')); }
  catch (e) { return null; }
}

// Map an iyziEventType (+status) to our coarse business event kind.
// iyzico event types include PAYMENT_API / THREE_DS_AUTH / BALANCE_UPDATED (money
// in) and cancel/refund families (money out). We key off substrings so new but
// similarly-named events still classify sensibly.
function eventKind(body) {
  const t = String(body && body.iyziEventType || '').toUpperCase();
  const status = String(body && body.status || '').toUpperCase();
  if (/REFUND|CANCEL|CHARGEBACK/.test(t)) return 'refund';
  // A payment-family event only counts as a purchase when it actually succeeded.
  if (/PAYMENT|THREE_DS|BALANCE|CHECKOUT|SETTLE/.test(t)) {
    return status === 'SUCCESS' ? 'purchase' : 'other';
  }
  return 'other';
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

  // Extract the business event AFTER verification. orderId is the merchant's own
  // conversation id (paymentConversationId, falling back to conversationId); we
  // surface any email/product the payload carries (iyzico's core notification does
  // not always include them — callers may look them up by orderId).
  parseEvent: function (rawBody /*, headers */) {
    const body = parseBody(rawBody);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    return {
      type: eventKind(body),
      email: body.email != null ? String(body.email)
        : (body.buyerEmail != null ? String(body.buyerEmail) : null),
      product: body.product != null ? String(body.product)
        : (body.productName != null ? String(body.productName) : null),
      orderId: body.paymentConversationId != null ? String(body.paymentConversationId)
        : (body.conversationId != null ? String(body.conversationId) : null),
      raw: body,
    };
  },
};
