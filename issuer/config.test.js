'use strict';
// ============================================================================
// issuer/config.test.js — zero-dep tests for issuer/config.js.
//
// ROLE / SECURITY
//   Exercises config LOADING, VALIDATION, and the routing/product/secret-name
//   resolvers against the real issuer.config.json plus hand-built in-memory
//   configs. It asserts secretEnvFor() returns only ENV VAR NAMES (never a
//   secret value) — the value is read from process.env by the server, never by
//   the config layer. Uses only node:test + node:assert (no npm). Run with:
//     node --test issuer/**/*.test.js
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const cfgMod = require('./config');

const realCfg = cfgMod.loadConfig(); // loads issuer.config.json beside config.js

test('loadConfig loads and validates the shipped issuer.config.json', function () {
  assert.ok(Array.isArray(realCfg.activeProviders));
  assert.ok(realCfg.activeProviders.length > 0);
  assert.strictEqual(typeof realCfg.regionRouting.default, 'string');
  assert.ok(Number.isInteger(realCfg.licenseTtlDaysDefault));
});

test('providerForRegion: TR routes to iyzico', function () {
  assert.strictEqual(cfgMod.providerForRegion(realCfg, 'TR'), 'iyzico');
});

test('providerForRegion: unknown region falls back to regionRouting.default', function () {
  const fallback = realCfg.regionRouting.default;
  assert.strictEqual(cfgMod.providerForRegion(realCfg, 'ZZ'), fallback);
  assert.strictEqual(cfgMod.providerForRegion(realCfg, 'US'), fallback);
  // No region argument -> still the default (never undefined).
  assert.strictEqual(cfgMod.providerForRegion(realCfg, undefined), fallback);
  assert.strictEqual(cfgMod.providerForRegion(realCfg, null), fallback);
});

test('providerForRegion: literal "default" and prototype keys do not resolve as regions', function () {
  const fallback = realCfg.regionRouting.default;
  assert.strictEqual(cfgMod.providerForRegion(realCfg, 'default'), fallback);
  assert.strictEqual(cfgMod.providerForRegion(realCfg, '__proto__'), fallback);
  assert.strictEqual(cfgMod.providerForRegion(realCfg, 'toString'), fallback);
});

test('tierForProduct: maps a known id to { tier, months }', function () {
  // Pick a real id straight from the loaded config so the test tracks the file.
  const knownId = Object.keys(realCfg.products)[0];
  const got = cfgMod.tierForProduct(realCfg, knownId);
  assert.ok(got, 'known id should resolve');
  assert.strictEqual(got.tier, realCfg.products[knownId].tier);
  assert.strictEqual(got.months, realCfg.products[knownId].months);
  assert.ok(['pro', 'team'].indexOf(got.tier) !== -1);
  assert.ok(Number.isInteger(got.months) && got.months > 0);
});

test('tierForProduct: unknown / prototype ids return null', function () {
  assert.strictEqual(cfgMod.tierForProduct(realCfg, 'no_such_product_id'), null);
  assert.strictEqual(cfgMod.tierForProduct(realCfg, '__proto__'), null);
  assert.strictEqual(cfgMod.tierForProduct(realCfg, ''), null);
});

test('secretEnvFor: returns ENV VAR NAMES only (never a secret value)', function () {
  assert.strictEqual(cfgMod.secretEnvFor('stripe'), 'STRIPE_WEBHOOK_SECRET');
  assert.strictEqual(cfgMod.secretEnvFor('lemonsqueezy'), 'LEMONSQUEEZY_WEBHOOK_SECRET');
  assert.strictEqual(cfgMod.secretEnvFor('iyzico'), 'IYZICO_WEBHOOK_SECRET');
  // PayTR authenticates with a key + salt pair -> array of two NAMES.
  assert.deepStrictEqual(cfgMod.secretEnvFor('paytr'), ['PAYTR_MERCHANT_KEY', 'PAYTR_MERCHANT_SALT']);

  // Every returned name is an UPPER_SNAKE env-var identifier, not a value.
  const names = ['stripe', 'lemonsqueezy', 'iyzico', 'paytr']
    .map(cfgMod.secretEnvFor)
    .reduce(function (acc, v) { return acc.concat(v); }, []);
  names.forEach(function (n) {
    assert.match(n, /^[A-Z][A-Z0-9_]*$/, n + ' should look like an env var NAME');
  });

  // Unknown provider -> null (no guessing).
  assert.strictEqual(cfgMod.secretEnvFor('unknown'), null);
  assert.strictEqual(cfgMod.secretEnvFor('__proto__'), null);
});

test('secretEnvFor: returns a fresh array for paytr (caller cannot mutate the table)', function () {
  const a = cfgMod.secretEnvFor('paytr');
  a.push('INJECTED');
  assert.deepStrictEqual(cfgMod.secretEnvFor('paytr'), ['PAYTR_MERCHANT_KEY', 'PAYTR_MERCHANT_SALT']);
});

// ---- validation: bad configs must fail closed --------------------------------
test('validateConfig: rejects an unknown provider in activeProviders', function () {
  assert.throws(function () {
    cfgMod.validateConfig({
      activeProviders: ['stripe', 'bitcoin'],
      regionRouting: { default: 'stripe' },
      products: {},
      licenseTtlDaysDefault: 400,
    });
  }, /unknown provider/);
});

test('validateConfig: rejects routing to a non-active provider', function () {
  assert.throws(function () {
    cfgMod.validateConfig({
      activeProviders: ['stripe'],
      regionRouting: { default: 'stripe', TR: 'iyzico' },
      products: {},
      licenseTtlDaysDefault: 400,
    });
  }, /not in activeProviders/);
});

test('validateConfig: requires a regionRouting.default fallback', function () {
  assert.throws(function () {
    cfgMod.validateConfig({
      activeProviders: ['stripe'],
      regionRouting: { TR: 'stripe' },
      products: {},
      licenseTtlDaysDefault: 400,
    });
  }, /regionRouting\.default/);
});

test('validateConfig: rejects a product with an unknown tier or bad months', function () {
  assert.throws(function () {
    cfgMod.validateConfig({
      activeProviders: ['stripe'],
      regionRouting: { default: 'stripe' },
      products: { p1: { tier: 'enterprise', months: 1 } },
      licenseTtlDaysDefault: 400,
    });
  }, /tier/);
  assert.throws(function () {
    cfgMod.validateConfig({
      activeProviders: ['stripe'],
      regionRouting: { default: 'stripe' },
      products: { p1: { tier: 'pro', months: 0 } },
      licenseTtlDaysDefault: 400,
    });
  }, /months/);
});

test('validateConfig: rejects a non-positive licenseTtlDaysDefault', function () {
  assert.throws(function () {
    cfgMod.validateConfig({
      activeProviders: ['stripe'],
      regionRouting: { default: 'stripe' },
      products: {},
      licenseTtlDaysDefault: 0,
    });
  }, /licenseTtlDaysDefault/);
});

test('loadConfig: a missing file throws a clear BAD_ISSUER_CONFIG error', function () {
  assert.throws(function () {
    cfgMod.loadConfig(path.join(__dirname, 'does-not-exist.json'));
  }, function (e) {
    return e && e.code === 'BAD_ISSUER_CONFIG' && /cannot read/.test(e.message);
  });
});
