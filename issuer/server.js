'use strict';
// ISSUER / server.js — the PSP webhook receiver that MINTS keyflip licenses.
//
// Role: a tiny zero-dependency node:http server that a payment provider (Stripe,
// Paddle, LemonSqueezy, Gumroad, …) calls when a purchase completes. For each
// webhook it:
//   1. captures the EXACT raw request bytes (never JSON.parse before verifying),
//   2. resolves the provider's adapter (issuer/adapters/<provider>.js),
//   3. verifies the signature with the provider secret from process.env,
//   4. parses the business event, maps product -> tier (config.js),
//   5. MINTS an Ed25519-signed license (sign.js -> loadPrivateKey) exactly once
//      per orderId (idempotency ledger), and
//   6. answers 200 {issued:true, tier} without ever leaking the token.
//
// SECURITY NOTES (load-bearing — read before editing):
//   * The issuer PRIVATE key never appears here: signing is delegated to sign.js,
//     which reads issuer/private/issuer.key (0600). This module never reads,
//     logs, or serialises the key or any minted token. The token is handed to an
//     out-of-band delivery stub (deliverLicense) and is otherwise discarded.
//   * Provider webhook secrets come ONLY from process.env (never argv, never
//     disk, never logs). We resolve them by a fixed env-var name per provider.
//   * The RAW body is verified BEFORE parsing so a forged/tampered payload can
//     never reach the minting path. verifyWebhook returning ok=false => 401 and
//     absolutely no side effects.
//   * :provider is validated against a strict allowlist charset so it can never
//     traverse the filesystem when resolving the adapter module.
//   * The persisted ledger (issuer/state/ledger.json, 0600) stores only
//     non-secret metadata (orderId, tier, email, timestamps) — NEVER the token —
//     so a leaked ledger file can't unlock anything.
//   * Binds 127.0.0.1 by default (put a TLS-terminating reverse proxy in front);
//     PORT comes from env.
//
// Everything is dependency-injectable (createIssuer(deps)) so tests exercise the
// router/idempotency/verification wiring with stub adapters + a throwaway signer,
// with no real provider crypto and no real private key on disk.

const http = require('http');
const path = require('path');
const fs = require('fs');

const DEFAULT_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1 << 20; // 1 MiB — webhooks are small; reject anything larger.

// Strict provider-name charset: lowercase letters, digits, dash, underscore. This
// is what stops `/webhook/..%2f..%2fetc` from ever resolving to an arbitrary file.
const PROVIDER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Env-var name that holds a given provider's webhook signing secret, e.g.
// 'stripe' -> 'STRIPE_WEBHOOK_SECRET'. Kept deterministic so ops can wire it once.
// (Fallback only — config.js secretEnvFor is authoritative in production.)
function secretEnvName(provider) {
  return String(provider).toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_WEBHOOK_SECRET';
}

// Add N calendar months to an ISO timestamp, returning an ISO string. Used to
// turn a plan's `months` into a concrete license expiry. Clamps overflow days
// (e.g. Jan 31 + 1mo -> Feb 28/29) the way Date arithmetic naturally would after
// normalising, so we never produce a surprising next-month date.
function addMonths(iso, months) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  // If the day rolled over into the following month, clamp back to month-end.
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d.toISOString();
}

// ---- default (production) dependency implementations -------------------------
// All of these are LAZY: required only when actually invoked, so this module
// loads (and its tests run) with stub injections even if a sibling module is
// momentarily absent. They are wired to the REAL sign.js / config.js APIs.

// Module + parsed-config caches (built once, on first use).
let _cfgMod = null;   // the config.js module
let _cfgData = null;  // the loaded/validated config object
let _signMod = null;  // the sign.js module
let _privKey = null;  // the issuer Ed25519 private KeyObject (never logged/serialised)

function cfgMod() { return _cfgMod || (_cfgMod = require('./config')); }
function cfgData() { if (!_cfgData) _cfgData = cfgMod().loadConfig(); return _cfgData; }
function signMod() { return _signMod || (_signMod = require('./sign')); }
function privKey() { if (!_privKey) _privKey = signMod().loadPrivateKey(); return _privKey; }

// Resolve issuer/adapters/<provider>.js after validating the provider name.
function defaultResolveAdapter(provider) {
  if (!PROVIDER_RE.test(provider)) return null;
  const file = path.join(__dirname, 'adapters', provider + '.js');
  // Defence in depth: the resolved path must stay inside the adapters dir.
  const adaptersDir = path.join(__dirname, 'adapters') + path.sep;
  if (!file.startsWith(adaptersDir)) return null;
  let mod;
  try { mod = require(file); } catch (e) { return null; }
  if (!mod || typeof mod.verifyWebhook !== 'function' || typeof mod.parseEvent !== 'function') return null;
  return mod;
}

// The signing secret for a provider, read from the environment ONLY. config.js
// owns the provider->env-var-NAME mapping (never the value). Some providers
// (PayTR) declare several env vars; the FIRST is the HMAC key we hand to the
// adapter as `secret`, and the adapter reads any companion secret (e.g. salt)
// from process.env itself.
function defaultSecretForProvider(provider) {
  let name;
  try { name = cfgMod().secretEnvFor(provider); }
  catch (e) { name = secretEnvName(provider); } // fall back to the deterministic name
  if (!name) return undefined;
  const primary = Array.isArray(name) ? name[0] : name;
  return process.env[primary];
}

// product -> { tier, months } via issuer/config.js (null for an unknown product,
// so an unrecognised purchase is rejected rather than granted an arbitrary tier).
function defaultProductToTier(product) {
  const r = cfgMod().tierForProduct(cfgData(), product);
  return r && r.tier ? r : null;
}

// Mint a license token via issuer/sign.js using the issuer private key, which is
// loaded once from issuer/private/issuer.key (0600) and kept only as an in-memory
// KeyObject — never logged, serialised, or handed out.
function defaultSignLicense(payload) {
  return signMod().signLicense(payload, privKey());
}

// Out-of-band delivery of the freshly minted token (email/store). Deliberately a
// stub: NEVER log the token; a real implementation queues an email or persists to
// a secrets store the buyer can pull from.
function defaultDeliverLicense(/* record, token */) {
  // TODO(delivery): email the token to record.email / drop into a secure outbox.
  // Intentionally a no-op that ignores the token so it never reaches a log sink.
  return;
}

// ---- ledger (idempotency) ----------------------------------------------------
// In-memory Map keyed by orderId, optionally mirrored to a 0600 JSON file so a
// restart still refuses to double-issue. The file holds NO token — metadata only.

function loadLedgerFile(file, ledger) {
  if (!file) return;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return; } // absent => empty
  let arr;
  try { arr = JSON.parse(raw); } catch (e) { return; } // corrupt => start fresh (fail closed to empty)
  if (!Array.isArray(arr)) return;
  for (const rec of arr) {
    if (rec && typeof rec.orderId === 'string') ledger.set(rec.orderId, rec);
  }
}

function persistLedgerFile(file, ledger) {
  if (!file) return;
  const arr = [];
  for (const rec of ledger.values()) {
    // Whitelist non-secret fields only — never persist a token.
    arr.push({ orderId: rec.orderId, provider: rec.provider, tier: rec.tier, email: rec.email, issuedAt: rec.issuedAt });
  }
  const tmp = file + '.tmp.' + process.pid;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e) { /* best effort */ }
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---- small http helpers ------------------------------------------------------
function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

// Collect the raw request body as a Buffer, enforcing a hard size cap. Resolves
// with the exact bytes — no decoding, no parsing.
function readRawBody(req, limit) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', function (c) {
      if (done) return;
      size += c.length;
      if (size > limit) { done = true; reject(Object.assign(new Error('payload too large'), { code: 'TOO_LARGE' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', function (e) { if (!done) { done = true; reject(e); } });
  });
}

// ---- issuer factory ----------------------------------------------------------
// createIssuer(deps) -> { server, handler, ledger }. Inject any of:
//   resolveAdapter(provider) -> adapter | null
//   secretForProvider(provider) -> secret | undefined
//   productToTier(product) -> tier | null
//   signLicense(payload) -> token string
//   deliverLicense(record, token) -> void   (out-of-band; must not log token)
//   expiryFor(tier) -> ISO expiry string | null
//   now() -> ISO string     ledgerFile -> path | null     ledger -> Map     log -> fn
function createIssuer(deps) {
  deps = deps || {};
  const resolveAdapter = deps.resolveAdapter || defaultResolveAdapter;
  const secretForProvider = deps.secretForProvider || defaultSecretForProvider;
  const productToTier = deps.productToTier || defaultProductToTier;
  const signLicense = deps.signLicense || defaultSignLicense;
  const deliverLicense = deps.deliverLicense || defaultDeliverLicense;
  const expiryFor = deps.expiryFor || function () { return null; }; // perpetual by default
  const now = deps.now || function () { return new Date().toISOString(); };
  const ledgerFile = deps.ledgerFile || null;
  const ledger = deps.ledger || new Map();
  // Structured, secret-free logger. Only ever receives non-sensitive fields.
  const log = deps.log || function (obj) { try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch (e) { /* ignore */ } };

  loadLedgerFile(ledgerFile, ledger);

  async function handleWebhook(provider, req, res) {
    if (!PROVIDER_RE.test(provider)) { sendJson(res, 400, { error: 'bad provider' }); return; }

    const adapter = resolveAdapter(provider);
    if (!adapter) { sendJson(res, 404, { error: 'unknown provider' }); return; }

    const secret = secretForProvider(provider);
    if (!secret) {
      // Misconfiguration, not the caller's fault — but never mint without a secret.
      log({ evt: 'webhook', provider: provider, status: 500, reason: 'no-secret-configured' });
      sendJson(res, 500, { error: 'issuer misconfigured' });
      return;
    }

    // 1) EXACT raw bytes — verified before anything parses them.
    let rawBody;
    try {
      rawBody = await readRawBody(req, MAX_BODY_BYTES);
    } catch (e) {
      if (e && e.code === 'TOO_LARGE') { sendJson(res, 413, { error: 'payload too large' }); return; }
      sendJson(res, 400, { error: 'bad request' });
      return;
    }

    // 2) Authenticity check. node lowercases header keys already.
    let v;
    try { v = adapter.verifyWebhook(rawBody, req.headers, secret); }
    catch (e) { v = { ok: false, reason: 'verify-threw' }; }
    if (!v || v.ok !== true) {
      // Do NOT log the reason at info if it might echo secret material; adapters
      // return only coarse reasons, so this is safe and useful.
      log({ evt: 'webhook', provider: provider, status: 401, reason: (v && v.reason) || 'unverified' });
      sendJson(res, 401, { error: 'signature verification failed' });
      return; // 401 and absolutely nothing else.
    }

    // 3) Parse the business event (only now that it's authentic).
    let event;
    try { event = adapter.parseEvent(rawBody, req.headers); }
    catch (e) { event = null; }
    if (!event || typeof event !== 'object') { sendJson(res, 400, { error: 'unparseable event' }); return; }

    if (event.type !== 'purchase') {
      // Refunds/other are acknowledged but mint nothing here (refund handling is
      // a separate concern). Ack so the PSP stops retrying.
      log({ evt: 'webhook', provider: provider, status: 200, type: event.type, issued: false });
      sendJson(res, 200, { issued: false, type: event.type || 'other' });
      return;
    }

    const orderId = event.orderId;
    if (!orderId || typeof orderId !== 'string') { sendJson(res, 400, { error: 'missing orderId' }); return; }

    // 4) Idempotency: a replay of the same orderId must NOT mint again.
    const existing = ledger.get(orderId);
    if (existing) {
      log({ evt: 'webhook', provider: provider, status: 200, orderId: orderId, tier: existing.tier, issued: true, idempotent: true });
      sendJson(res, 200, { issued: true, tier: existing.tier, idempotent: true });
      return;
    }

    // 5) product -> tier. The mapper may return a bare tier string (test stubs)
    // or a { tier, months } record (config.js). months (when a positive number)
    // drives the expiry; otherwise expiryFor(tier) decides (perpetual by default).
    const mapped = productToTier(event.product);
    const tier = (mapped && typeof mapped === 'object') ? mapped.tier : mapped;
    if (!tier) {
      log({ evt: 'webhook', provider: provider, status: 422, orderId: orderId, reason: 'unmapped-product' });
      sendJson(res, 422, { error: 'product not mapped to a tier' });
      return;
    }
    const months = (mapped && typeof mapped === 'object') ? mapped.months : undefined;

    // 6) MINT exactly once. The token is handed straight to delivery and never
    // stored in the ledger or logged.
    const issuedAt = now();
    const expiry = (typeof months === 'number' && months > 0) ? addMonths(issuedAt, months) : expiryFor(tier);
    const payload = {
      tier: tier,
      email: event.email == null ? '' : String(event.email),
      issued: issuedAt,
      expiry: expiry,
    };

    let token;
    try {
      token = signLicense(payload);
    } catch (e) {
      // Never include the payload/secret in the error surface.
      log({ evt: 'webhook', provider: provider, status: 500, orderId: orderId, reason: 'sign-failed' });
      sendJson(res, 500, { error: 'minting failed' });
      return;
    }

    const record = { orderId: orderId, provider: provider, tier: tier, email: payload.email, issuedAt: issuedAt };
    ledger.set(orderId, record);
    try { persistLedgerFile(ledgerFile, ledger); } catch (e) { /* durability best-effort; in-memory guard still holds */ }

    // Out-of-band delivery (stub). Token is scoped to this call only.
    try { deliverLicense(record, token); } catch (e) { /* delivery failures don't unmint */ }
    token = null; // drop the reference promptly.

    log({ evt: 'webhook', provider: provider, status: 200, orderId: orderId, tier: tier, issued: true });
    sendJson(res, 200, { issued: true, tier: tier });
  }

  const handler = function (req, res) {
    let parsed;
    try { parsed = new URL(req.url, 'http://localhost'); }
    catch (e) { sendJson(res, 400, { error: 'bad url' }); return; }
    const pathname = parsed.pathname;

    if (req.method === 'GET' && pathname === '/health') { sendJson(res, 200, { ok: true }); return; }

    const m = /^\/webhook\/([^/]+)\/?$/.exec(pathname);
    if (m) {
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return; }
      // decodeURIComponent so an encoded provider still validates against the RE
      // (and traversal attempts fail the strict charset check).
      let provider;
      try { provider = decodeURIComponent(m[1]); } catch (e) { sendJson(res, 400, { error: 'bad provider' }); return; }
      handleWebhook(provider, req, res).catch(function () {
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  };

  const server = http.createServer(handler);
  return { server: server, handler: handler, ledger: ledger, secretEnvName: secretEnvName };
}

// ---- production bootstrap ----------------------------------------------------
function start(deps) {
  deps = deps || {};
  const port = Number(deps.port || process.env.PORT || 8787);
  const host = deps.host || process.env.HOST || DEFAULT_HOST;
  const ledgerFile = deps.ledgerFile || path.join(__dirname, 'state', 'ledger.json');
  const issuer = createIssuer(Object.assign({ ledgerFile: ledgerFile }, deps));
  issuer.server.listen(port, host, function () {
    // No secrets here — just where we're listening.
    process.stdout.write(JSON.stringify({ evt: 'listen', host: host, port: port }) + '\n');
  });
  return issuer;
}

module.exports = { createIssuer: createIssuer, start: start, secretEnvName: secretEnvName, MAX_BODY_BYTES: MAX_BODY_BYTES };

// Run directly: `node issuer/server.js`.
if (require.main === module) { start(); }
