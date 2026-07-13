'use strict';
// ============================================================================
// issuer/config.js — load + VALIDATE the issuer's CENTRAL selection file
// (issuer.config.json) and resolve routing/product/secret questions from it.
//
// ROLE
//   This is the single place that turns the owner-edited issuer.config.json into
//   answers the license-issuing HTTP server needs at request time:
//     * which payment PROVIDER serves a buyer from a given region,
//     * what TIER + duration a given provider product/price id grants,
//     * the NAME of the environment variable that carries a provider's webhook
//       signing secret (so the server can read process.env at request time).
//
// SECURITY (read before editing)
//   * ZERO dependencies — Node built-ins only. No network, no npm.
//   * This module NEVER reads a webhook secret VALUE and NEVER touches the
//     issuer private key. secretEnvFor() resolves only the ENV VAR *NAME*; the
//     server reads process.env[name] itself, at request time, and keeps the
//     value out of config, logs, argv, and git.
//   * The config file itself holds NO secrets — only ids, tiers, and routing.
//     Validation below rejects anything that looks like a leaked secret shape
//     is out of scope, but we do keep the file to a strict, known schema so a
//     malformed/hostile config fails loudly instead of silently misrouting.
// ============================================================================

const fs = require('fs');
const path = require('path');

// The provider ids this issuer understands. A config that names any provider
// outside this set is rejected — we will not route money to an unknown adapter.
const KNOWN_PROVIDERS = ['iyzico', 'paytr', 'lemonsqueezy', 'stripe'];

// Tiers a product may grant. Kept in sync with src/license.js TIER_ORDER
// (free is not a purchasable product tier, so it is intentionally excluded).
const KNOWN_TIERS = ['pro', 'team'];

// Provider id -> the NAME(s) of the env var(s) holding its webhook signing
// secret. A single-secret provider maps to one string; PayTR authenticates with
// a merchant key + salt pair, so it maps to an array of two names. NOTE: these
// are NAMES ONLY — never the values. Null-proto so a hostile provider id such as
// '__proto__' can never inherit a truthy entry.
const SECRET_ENV = Object.assign(Object.create(null), {
  stripe: 'STRIPE_WEBHOOK_SECRET',
  lemonsqueezy: 'LEMONSQUEEZY_WEBHOOK_SECRET',
  iyzico: 'IYZICO_WEBHOOK_SECRET',
  paytr: ['PAYTR_MERCHANT_KEY', 'PAYTR_MERCHANT_SALT'],
});

const DEFAULT_CONFIG_PATH = path.join(__dirname, 'issuer.config.json');

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// Throw a clear, prefixed error so a bad config is obvious at boot.
function fail(msg) {
  const err = new Error('issuer.config.json: ' + msg);
  err.code = 'BAD_ISSUER_CONFIG';
  return err;
}

// ---- validation -------------------------------------------------------------
// validateConfig(raw) -> raw (throws on any problem). Strict on purpose: an
// issuer that mints paid licenses must fail closed, never guess.
function validateConfig(raw) {
  if (!isPlainObject(raw)) throw fail('must be a JSON object');

  // activeProviders: non-empty array of known providers, no dupes.
  const active = raw.activeProviders;
  if (!Array.isArray(active) || active.length === 0) {
    throw fail('"activeProviders" must be a non-empty array');
  }
  const seen = Object.create(null);
  active.forEach(function (p) {
    if (typeof p !== 'string' || KNOWN_PROVIDERS.indexOf(p) === -1) {
      throw fail('"activeProviders" contains unknown provider ' + JSON.stringify(p) +
        ' (known: ' + KNOWN_PROVIDERS.join(', ') + ')');
    }
    if (seen[p]) throw fail('"activeProviders" lists ' + JSON.stringify(p) + ' more than once');
    seen[p] = true;
  });

  // regionRouting: object mapping region code (or "default") -> an ACTIVE
  // provider. A "default" entry is required so every region resolves.
  const routing = raw.regionRouting;
  if (!isPlainObject(routing)) throw fail('"regionRouting" must be an object');
  if (typeof routing.default !== 'string') {
    throw fail('"regionRouting.default" (fallback provider) is required and must be a string');
  }
  Object.keys(routing).forEach(function (region) {
    const prov = routing[region];
    if (typeof prov !== 'string') {
      throw fail('"regionRouting.' + region + '" must be a provider id string');
    }
    if (active.indexOf(prov) === -1) {
      throw fail('"regionRouting.' + region + '" routes to ' + JSON.stringify(prov) +
        ' which is not in activeProviders');
    }
  });

  // products: object mapping provider product/price id -> { tier, months }.
  const products = raw.products;
  if (!isPlainObject(products)) throw fail('"products" must be an object');
  Object.keys(products).forEach(function (id) {
    const entry = products[id];
    if (!isPlainObject(entry)) throw fail('"products.' + id + '" must be an object');
    if (KNOWN_TIERS.indexOf(entry.tier) === -1) {
      throw fail('"products.' + id + '.tier" must be one of ' + KNOWN_TIERS.join(', '));
    }
    if (!Number.isInteger(entry.months) || entry.months <= 0) {
      throw fail('"products.' + id + '.months" must be a positive integer');
    }
  });

  // licenseTtlDaysDefault: positive integer.
  if (!Number.isInteger(raw.licenseTtlDaysDefault) || raw.licenseTtlDaysDefault <= 0) {
    throw fail('"licenseTtlDaysDefault" must be a positive integer (days)');
  }

  return raw;
}

// ---- loading ----------------------------------------------------------------
// loadConfig(configPath?) -> validated config object. Defaults to the file next
// to this module. Reads only this file; touches no secrets.
function loadConfig(configPath) {
  const p = configPath ? String(configPath) : DEFAULT_CONFIG_PATH;
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    throw fail('cannot read ' + p + ': ' + ((e && e.message) || e));
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw fail('is not valid JSON: ' + ((e && e.message) || e));
  }
  return validateConfig(raw);
}

// ---- resolvers --------------------------------------------------------------
// providerForRegion(cfg, regionCode) -> provider id. Exact region match wins;
// otherwise the required regionRouting.default fallback. Region lookup is via
// hasOwnProperty so a code like "default" or "__proto__" can never resolve
// through the prototype chain or be confused with the fallback key.
function providerForRegion(cfg, regionCode) {
  const routing = (cfg && cfg.regionRouting) || {};
  const code = regionCode == null ? '' : String(regionCode);
  if (code && code !== 'default' &&
      Object.prototype.hasOwnProperty.call(routing, code)) {
    return routing[code];
  }
  return routing.default;
}

// tierForProduct(cfg, providerProductId) -> { tier, months } | null. Null for
// an unknown id so the caller can reject an unrecognized purchase rather than
// mint an arbitrary license. Own-property check guards against prototype keys.
function tierForProduct(cfg, providerProductId) {
  const products = (cfg && cfg.products) || {};
  const id = providerProductId == null ? '' : String(providerProductId);
  if (!Object.prototype.hasOwnProperty.call(products, id)) return null;
  const entry = products[id];
  if (!isPlainObject(entry)) return null;
  return { tier: entry.tier, months: entry.months };
}

// secretEnvFor(providerId) -> ENV VAR NAME (string) or NAMES (array, for PayTR),
// or null for an unknown provider. Returns only the NAME(s); the value is read
// from process.env by the server at request time and never handled here.
function secretEnvFor(providerId) {
  const id = providerId == null ? '' : String(providerId);
  if (!Object.prototype.hasOwnProperty.call(SECRET_ENV, id)) return null;
  const v = SECRET_ENV[id];
  // Hand back a fresh array so a caller can't mutate the shared table.
  return Array.isArray(v) ? v.slice() : v;
}

module.exports = {
  loadConfig: loadConfig,
  validateConfig: validateConfig,
  providerForRegion: providerForRegion,
  tierForProduct: tierForProduct,
  secretEnvFor: secretEnvFor,
  KNOWN_PROVIDERS: KNOWN_PROVIDERS,
  KNOWN_TIERS: KNOWN_TIERS,
  DEFAULT_CONFIG_PATH: DEFAULT_CONFIG_PATH,
};
