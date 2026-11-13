'use strict';
// ISSUER / server.js — the PSP webhook receiver that MINTS keyflip licenses.
//
// Role: a tiny zero-dependency node:http server that a payment provider (iyzico,
// PayTR, LemonSqueezy, Stripe, …) calls when a purchase completes. For each
// webhook it:
//   1. captures the EXACT raw request bytes (never JSON.parse before verifying),
//   2. resolves the provider's adapter (issuer/adapters/<provider>.js),
//   3. verifies the signature with the provider secret from process.env,
//   4. parses the business event, maps product -> tier (config.js),
//   5. MINTS an Ed25519-signed license (sign.js -> loadPrivateKey) exactly once
//      per orderId (idempotency ledger) and records the non-secret invoice in
//      invoices.jsonl (when an InvoiceStore is configured), and
//   6. answers 200 {issued:true, tier} without ever leaking the token.

const http = require('http');
const path = require('path');
const fs = require('fs');

const DEFAULT_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1 << 20; // 1 MiB — webhooks are small; reject anything larger.

// Strict provider-name charset: lowercase letters, digits, dash, underscore.
const PROVIDER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Env-var name that holds a given provider's webhook signing secret.
function secretEnvName(provider) {
  return (
    String(provider)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '_') + '_WEBHOOK_SECRET'
  );
}

// Add N calendar months to an ISO timestamp, returning an ISO string.
function addMonths(iso, months) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d.toISOString();
}

// ---- default (production) dependency implementations -------------------------
let _cfgMod = null;
let _cfgData = null;
let _signMod = null;
let _privKey = null;

function cfgMod() {
  return _cfgMod || (_cfgMod = require('./config'));
}
function cfgData() {
  if (!_cfgData) _cfgData = cfgMod().loadConfig();
  return _cfgData;
}
function signMod() {
  return _signMod || (_signMod = require('./sign'));
}
function privKey() {
  if (!_privKey) _privKey = signMod().loadPrivateKey();
  return _privKey;
}

// Resolve issuer/adapters/<provider>.js after validating the provider name.
function defaultResolveAdapter(provider) {
  if (!PROVIDER_RE.test(provider)) return null;
  const file = path.join(__dirname, 'adapters', provider + '.js');
  const adaptersDir = path.join(__dirname, 'adapters') + path.sep;
  if (!file.startsWith(adaptersDir)) return null;
  let mod;
  try {
    mod = require(file);
  } catch (e) {
    return null;
  }
  if (!mod || typeof mod.verifyWebhook !== 'function' || typeof mod.parseEvent !== 'function') return null;
  return mod;
}

// The signing secret for a provider, read from the environment ONLY.
function defaultSecretForProvider(provider) {
  let name;
  try {
    name = cfgMod().secretEnvFor(provider);
  } catch (e) {
    name = secretEnvName(provider);
  }
  if (!name) return undefined;
  const primary = Array.isArray(name) ? name[0] : name;
  return process.env[primary];
}

// product -> { tier, months, seats?, amount?, currency? } via issuer/config.js.
function defaultProductToTier(product) {
  const r = cfgMod().tierForProduct(cfgData(), product);
  return r && r.tier ? r : null;
}

// Mint a license token via issuer/sign.js using the issuer private key.
function defaultSignLicense(payload) {
  return signMod().signLicense(payload, privKey());
}

// Out-of-band delivery of the freshly minted token (email/store).
function defaultDeliverLicense(/* record, token */) {
  return;
}

// ---- ledger (idempotency) ----------------------------------------------------
function loadLedgerFile(file, ledger) {
  if (!file) return;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return;
  }
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch (e) {
    return;
  }
  if (!Array.isArray(arr)) return;
  for (const rec of arr) {
    if (rec && typeof rec.orderId === 'string') ledger.set(rec.orderId, rec);
  }
}

function persistLedgerFile(file, ledger) {
  if (!file) return;
  const arr = [];
  for (const rec of ledger.values()) {
    arr.push({
      orderId: rec.orderId,
      provider: rec.provider,
      tier: rec.tier,
      seats: rec.seats || 1,
      email: rec.email,
      issuedAt: rec.issuedAt,
    });
  }
  const tmp = file + '.tmp.' + process.pid;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (e) {
    /* best effort */
  }
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---- small http helpers ------------------------------------------------------
function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

function readRawBody(req, limit) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', function (c) {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        reject(Object.assign(new Error('payload too large'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', function () {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', function (e) {
      if (!done) {
        done = true;
        reject(e);
      }
    });
  });
}

// ---- issuer factory ----------------------------------------------------------
function createIssuer(deps) {
  deps = deps || {};
  const resolveAdapter = deps.resolveAdapter || defaultResolveAdapter;
  const secretForProvider = deps.secretForProvider || defaultSecretForProvider;
  const productToTier = deps.productToTier || defaultProductToTier;
  const signLicense = deps.signLicense || defaultSignLicense;
  const deliverLicense = deps.deliverLicense || defaultDeliverLicense;
  const expiryFor =
    deps.expiryFor ||
    function () {
      return null;
    };
  const now =
    deps.now ||
    function () {
      return new Date().toISOString();
    };
  const ledgerFile = deps.ledgerFile || null;
  const ledger = deps.ledger || new Map();
  const admin = deps.admin || null;
  const events = deps.events || null;
  const invoices = deps.invoices || null;

  function recordEvent(evt) {
    if (!events || typeof events.append !== 'function') return;
    try {
      events.append(evt);
    } catch (e) {
      /* best effort */
    }
  }

  const log =
    deps.log ||
    function (obj) {
      try {
        process.stdout.write(JSON.stringify(obj) + '\n');
      } catch (e) {
        /* ignore */
      }
    };

  loadLedgerFile(ledgerFile, ledger);

  async function handleWebhook(provider, req, res) {
    if (!PROVIDER_RE.test(provider)) {
      sendJson(res, 400, { error: 'bad provider' });
      return;
    }

    const adapter = resolveAdapter(provider);
    if (!adapter) {
      sendJson(res, 404, { error: 'unknown provider' });
      return;
    }

    const secret = secretForProvider(provider);
    if (!secret) {
      log({ evt: 'webhook', provider: provider, status: 500, reason: 'no-secret-configured' });
      sendJson(res, 500, { error: 'issuer misconfigured' });
      return;
    }

    // 1) EXACT raw bytes — verified before anything parses them.
    let rawBody;
    try {
      rawBody = await readRawBody(req, MAX_BODY_BYTES);
    } catch (e) {
      if (e && e.code === 'TOO_LARGE') {
        sendJson(res, 413, { error: 'payload too large' });
        return;
      }
      sendJson(res, 400, { error: 'bad request' });
      return;
    }

    // 2) Authenticity check.
    let v;
    try {
      v = adapter.verifyWebhook(rawBody, req.headers, secret);
    } catch (e) {
      v = { ok: false, reason: 'verify-threw' };
    }
    if (!v || v.ok !== true) {
      log({ evt: 'webhook', provider: provider, status: 401, reason: (v && v.reason) || 'unverified' });
      recordEvent({ event: 'webhook.rejected', provider: provider, note: (v && v.reason) || 'unverified' });
      sendJson(res, 401, { error: 'signature verification failed' });
      return;
    }

    // 3) Parse the business event.
    let event;
    try {
      event = adapter.parseEvent(rawBody, req.headers);
    } catch (e) {
      event = null;
    }
    if (!event || typeof event !== 'object') {
      sendJson(res, 400, { error: 'unparseable event' });
      return;
    }

    if (event.type !== 'purchase') {
      if (event.type === 'refund' && event.orderId && invoices && typeof invoices.recordRefund === 'function') {
        try {
          invoices.recordRefund(event.orderId, 'webhook refund from ' + provider);
        } catch (e) {
          /* best effort */
        }
      }
      log({ evt: 'webhook', provider: provider, status: 200, type: event.type, issued: false });
      recordEvent({
        event: 'webhook.other',
        provider: provider,
        orderId: event.orderId || undefined,
        note: event.type || 'other',
      });
      sendJson(res, 200, { issued: false, type: event.type || 'other' });
      return;
    }

    const orderId = event.orderId;
    if (!orderId || typeof orderId !== 'string') {
      sendJson(res, 400, { error: 'missing orderId' });
      return;
    }

    // 4) Idempotency: a replay of the same orderId must NOT mint again.
    const existing = ledger.get(orderId);
    if (existing) {
      log({
        evt: 'webhook',
        provider: provider,
        status: 200,
        orderId: orderId,
        tier: existing.tier,
        issued: true,
        idempotent: true,
      });
      recordEvent({
        event: 'webhook.duplicate',
        provider: provider,
        orderId: orderId,
        tier: existing.tier,
        note: 'already issued',
      });
      sendJson(res, 200, { issued: true, tier: existing.tier, idempotent: true });
      return;
    }

    // 5) product -> tier.
    const mapped = productToTier(event.product);
    const tier = mapped && typeof mapped === 'object' ? mapped.tier : mapped;
    if (!tier) {
      const product = String(event.product == null ? '' : event.product).slice(0, 200);
      log({ evt: 'webhook', provider: provider, status: 422, orderId: orderId, reason: 'unmapped-product' });
      recordEvent({
        event: 'webhook.unmapped',
        provider: provider,
        orderId: orderId,
        note: 'product not mapped to a tier: ' + product,
      });
      sendJson(res, 422, { error: 'product not mapped to a tier' });
      return;
    }
    const months = mapped && typeof mapped === 'object' ? mapped.months : undefined;
    const mappedSeats = mapped && typeof mapped === 'object' && mapped.seats ? mapped.seats : undefined;
    const seats =
      Number.isInteger(Number(event.seats)) && Number(event.seats) > 1
        ? Number(event.seats)
        : Number.isInteger(Number(mappedSeats)) && Number(mappedSeats) > 1
          ? Number(mappedSeats)
          : 1;

    // 6) MINT exactly once.
    const issuedAt = now();
    const expiry = typeof months === 'number' && months > 0 ? addMonths(issuedAt, months) : expiryFor(tier);
    const payload = {
      tier: tier,
      email: event.email == null ? '' : String(event.email),
      issued: issuedAt,
      expiry: expiry,
    };
    if (seats > 1) payload.seats = seats;

    let token;
    try {
      token = signLicense(payload);
    } catch (e) {
      log({ evt: 'webhook', provider: provider, status: 500, orderId: orderId, reason: 'sign-failed' });
      sendJson(res, 500, { error: 'minting failed' });
      return;
    }

    const record = {
      orderId: orderId,
      provider: provider,
      tier: tier,
      seats: seats,
      email: payload.email,
      issuedAt: issuedAt,
    };
    ledger.set(orderId, record);
    try {
      persistLedgerFile(ledgerFile, ledger);
    } catch (e) {
      /* durability best-effort; in-memory guard still holds */
    }

    if (invoices && typeof invoices.recordPurchase === 'function') {
      try {
        const mappedAmount = mapped && typeof mapped === 'object' ? mapped.amount : undefined;
        const mappedCurrency = mapped && typeof mapped === 'object' ? mapped.currency : undefined;
        invoices.recordPurchase({
          orderId: orderId,
          provider: provider,
          email: payload.email,
          tier: tier,
          seats: seats,
          months: typeof months === 'number' && months > 0 ? months : 12,
          amount: event.amount != null ? event.amount : mappedAmount != null ? mappedAmount : 0,
          currency: event.currency || mappedCurrency || (provider === 'iyzico' || provider === 'paytr' ? 'TRY' : 'USD'),
          countryCode: event.countryCode || (provider === 'iyzico' || provider === 'paytr' ? 'TR' : 'INTL'),
          issuedAt: issuedAt,
        });
      } catch (e) {
        /* invoice log best effort */
      }
    }

    try {
      deliverLicense(record, token);
    } catch (e) {
      /* delivery failures don't unmint */
    }
    token = null;

    log({ evt: 'webhook', provider: provider, status: 200, orderId: orderId, tier: tier, issued: true });
    recordEvent({
      event: 'license.issued',
      source: 'webhook',
      provider: provider,
      orderId: orderId,
      email: payload.email,
      tier: tier,
      seats: seats,
      note: 'issued from ' + provider,
    });
    sendJson(res, 200, { issued: true, tier: tier });
  }

  const handler = function (req, res) {
    let parsed;
    try {
      parsed = new URL(req.url, 'http://localhost');
    } catch (e) {
      sendJson(res, 400, { error: 'bad url' });
      return;
    }
    const pathname = parsed.pathname;

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && pathname === '/plans') {
      const region = parsed.searchParams.get('region') || undefined;
      const plans = cfgMod().plansForRegion(region);
      sendJson(res, 200, { plans: plans, region: region || 'ALL' });
      return;
    }

    if (admin && (pathname === '/admin' || pathname.startsWith('/admin/'))) {
      admin(req, res);
      return;
    }

    const m = /^\/webhook\/([^/]+)\/?$/.exec(pathname);
    if (m) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      let provider;
      try {
        provider = decodeURIComponent(m[1]);
      } catch (e) {
        sendJson(res, 400, { error: 'bad provider' });
        return;
      }
      handleWebhook(provider, req, res).catch(function () {
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  };

  const server = http.createServer(handler);
  return { server: server, handler: handler, ledger: ledger, invoices: invoices, secretEnvName: secretEnvName };
}

function configReadiness() {
  try {
    const pending = cfgMod().pendingProducts(cfgData());
    return { ready: pending.length === 0, pendingProducts: pending };
  } catch (e) {
    return { ready: false, pendingProducts: [] };
  }
}

// ---- production bootstrap ----------------------------------------------------
function start(deps) {
  deps = deps || {};
  const port = Number(deps.port || process.env.PORT || 8787);
  const host = deps.host || process.env.HOST || DEFAULT_HOST;
  const ledgerFile = deps.ledgerFile || path.join(__dirname, 'state', 'ledger.json');
  const storeMod = require('./store');
  const events =
    deps.events ||
    new storeMod.EventLog({
      file: deps.eventLogFile || path.join(__dirname, 'state', 'events.jsonl'),
    });
  const invoices =
    deps.invoices ||
    new storeMod.InvoiceStore({
      file: deps.invoiceFile || path.join(__dirname, 'state', 'invoices.jsonl'),
    });
  const admin =
    deps.admin ||
    require('./admin').createAdmin({
      events: events,
      invoices: invoices,
      storeFile: deps.storeFile || path.join(__dirname, 'state', 'licenses.json'),
      eventLogFile: deps.eventLogFile || path.join(__dirname, 'state', 'events.jsonl'),
      invoiceFile: deps.invoiceFile || path.join(__dirname, 'state', 'invoices.jsonl'),
    }).handler;
  const issuer = createIssuer(
    Object.assign({}, deps, {
      ledgerFile: ledgerFile,
      events: events,
      invoices: invoices,
      admin: admin,
    }),
  );
  issuer.server.listen(port, host, function () {
    process.stdout.write(JSON.stringify({ evt: 'listen', host: host, port: port }) + '\n');
    const readiness = configReadiness();
    if (!readiness.ready) {
      process.stdout.write(
        JSON.stringify({
          evt: 'config',
          ready: false,
          pendingProducts: readiness.pendingProducts,
          note: 'replace every REPLACE_ product id in issuer.config.json with the real PSP product id before selling',
        }) + '\n',
      );
    }
  });
  return issuer;
}

module.exports = {
  createIssuer: createIssuer,
  start: start,
  secretEnvName: secretEnvName,
  configReadiness: configReadiness,
  MAX_BODY_BYTES: MAX_BODY_BYTES,
};

if (require.main === module) {
  start();
}
