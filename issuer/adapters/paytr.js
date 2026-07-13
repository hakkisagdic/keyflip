'use strict';
// ADAPTER: PayTR (Turkish PSP) callback/notification ("bildirim URL") verification
// + event parsing for the keyflip license issuer. After a payment, PayTR POSTs a
// url-encoded form to our Callback URL; this module authenticates that POST and
// extracts the business event (purchase | other) so the issuer can mint a license.
//
// SECURITY NOTES:
//   * PayTR credentials `merchant_key` and `merchant_salt` are secrets. They are
//     read from process.env ONLY (never argv, never logged, never committed). The
//     caller passes `merchant_key` as `secret`; `merchant_salt` comes from
//     process.env.PAYTR_MERCHANT_SALT (overridable via opts.salt for tests). This
//     module never persists or prints either value.
//   * Signature comparison uses crypto.timingSafeEqual over EQUAL-length buffers
//     (lengths guarded first) so it leaks no timing and never throws on mismatch.
//   * We verify over the fields as POSTed; we do not re-serialize anything.
//
// CALLBACK RESPONSE CONTRACT (important):
//   PayTR requires the callback endpoint to respond with the LITERAL body "OK"
//   (and nothing else — no HTML, no whitespace framing) once the notification is
//   accepted; otherwise PayTR keeps retrying. This adapter only verifies + parses;
//   the HTTP server that mounts it MUST special-case a verified PayTR callback and
//   write exactly "OK" (200) as the response body. See parseEvent's return + the
//   issuer webhook server. PayTR may re-send the same merchant_oid; the server
//   should treat the first as authoritative and still answer "OK" to repeats.
//
// SIGNATURE SCHEME:
//   hash = base64( HMAC_SHA256( merchant_oid + merchant_salt + status + total_amount,
//                               key = merchant_key ) )
//   compared against the posted `hash` field.
//   Docs: https://dev.paytr.com/en/direkt-api/direkt-api-2-adim
//
//   NEEDS-VERIFICATION: the concatenation ORDER (merchant_oid + merchant_salt +
//   status + total_amount) matches PayTR's documented PHP sample, but PayTR ships
//   several product flows (Direct API, iFrame API, Link API) whose callback strings
//   have historically differed in whether extra fields are appended. Confirm the
//   exact string for YOUR integration against the doc URL above and a real sandbox
//   callback before go-live. `total_amount` is used EXACTLY as posted (integer
//   string, amount x100) — do not reformat it.

const crypto = require('crypto');

// Base64 HMAC-SHA256 of `data` keyed by `secret` (merchant_key).
function hmacB64(secret, data) {
  return crypto.createHmac('sha256', secret).update(data, 'utf8').digest('base64');
}

// Constant-time equality of two base64 signature strings. We compare the base64
// TEXT (utf8 bytes), NOT the decoded bytes: PayTR's own reference compares the
// hash strings directly, and decoding first is malleable — Node's base64 decoder
// silently ignores characters after the '=' padding, so a decoded compare would
// accept `<validhash>XY`. Lengths are guarded so timingSafeEqual never throws.
function safeEqualB64(aB64, bB64) {
  const a = Buffer.from(String(aB64), 'utf8');
  const b = Buffer.from(String(bB64), 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// PayTR posts application/x-www-form-urlencoded. Parse the RAW bytes into a plain
// object of the last value per key (URLSearchParams handles percent-decoding). We
// fall back to JSON in case a test or gateway variant sends JSON.
function parseBody(rawBody) {
  const s = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  if (!s) return {};
  const trimmed = s.trimStart();
  if (trimmed[0] === '{') {
    try { const o = JSON.parse(trimmed); if (o && typeof o === 'object' && !Array.isArray(o)) return o; }
    catch (e) { /* fall through to form parsing */ }
  }
  const out = {};
  const params = new URLSearchParams(s);
  for (const [k, v] of params) out[k] = v;
  return out;
}

function saltFrom(opts) {
  if (opts && opts.salt != null) return String(opts.salt);
  return process.env.PAYTR_MERCHANT_SALT || '';
}

module.exports = {
  id: 'paytr',

  // Verify the posted `hash` over merchant_oid+merchant_salt+status+total_amount.
  // `secret` is merchant_key; merchant_salt comes from env (or opts.salt in tests).
  verifyWebhook: function (rawBody, headers, secret, opts) {
    if (!secret) return { ok: false, reason: 'no-secret' };
    const salt = saltFrom(opts);
    if (!salt) return { ok: false, reason: 'no-salt' };
    const body = parseBody(rawBody);
    const posted = body.hash;
    if (!posted) return { ok: false, reason: 'missing-hash' };
    if (body.merchant_oid == null || body.status == null || body.total_amount == null) {
      return { ok: false, reason: 'missing-fields' };
    }
    const data = String(body.merchant_oid) + salt + String(body.status) + String(body.total_amount);
    const expected = hmacB64(secret, data);
    if (!safeEqualB64(posted, expected)) return { ok: false, reason: 'bad-signature' };
    return { ok: true };
  },

  // Extract the business event AFTER verification. status 'success' -> purchase,
  // anything else (typically 'failed') -> other. orderId is merchant_oid. PayTR's
  // callback does not carry the buyer email or a product name, so those are null
  // here — the issuer resolves them from merchant_oid (which our checkout mints to
  // encode the order). NOTE: the mounting server must still reply "OK".
  parseEvent: function (rawBody /*, headers */) {
    const body = parseBody(rawBody);
    if (!body || body.merchant_oid == null) return null;
    const status = String(body.status || '');
    return {
      type: status === 'success' ? 'purchase' : 'other',
      email: body.email != null ? String(body.email) : null,
      product: body.product != null ? String(body.product) : null,
      orderId: String(body.merchant_oid),
      raw: body,
    };
  },
};
