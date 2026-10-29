// LIVE PRICE TABLE tests. Hermetic: the fetch is injected, the cache lives in
// a temp configDir. No network, no real clock.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as prices from '../src/prices.js';
import * as cost from '../src/cost.js';
import * as profiles from '../src/profiles.js';
import { makeCtx } from './helpers.js';

// A trimmed stand-in for LiteLLM's model_prices_and_context_window.json.
function fixture() {
  return {
    sample_spec: { input_cost_per_token: 0.0000001, litellm_provider: 'anthropic' },
    'claude-opus-4-8': {
      litellm_provider: 'anthropic',
      mode: 'chat',
      max_input_tokens: 200000,
      input_cost_per_token: 0.000009,
      output_cost_per_token: 0.000045,
    },
    'claude-sonnet-4-6': {
      litellm_provider: 'anthropic',
      mode: 'chat',
      max_input_tokens: 1000000,
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015,
    },
    'claude-haiku-4-5': {
      litellm_provider: 'anthropic',
      mode: 'chat',
      max_input_tokens: 200000,
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000005,
    },
    'claude-new-9': {
      litellm_provider: 'anthropic',
      mode: 'chat',
      max_input_tokens: 1000000,
      input_cost_per_token: 0.000004,
      output_cost_per_token: 0.00002,
    },
    'claude-old-1': {
      litellm_provider: 'anthropic',
      mode: 'chat',
      max_input_tokens: 200000,
      input_cost_per_token: 0.000015,
      output_cost_per_token: 0.000075,
    },
    'claude-bad-1': {
      litellm_provider: 'anthropic',
      mode: 'chat',
      input_cost_per_token: 0,
      output_cost_per_token: 0.000005,
    },
    'gpt-4o': {
      litellm_provider: 'openai',
      mode: 'chat',
      input_cost_per_token: 0.0000025,
      output_cost_per_token: 0.00001,
    },
    'claude-embed-1': {
      litellm_provider: 'anthropic',
      mode: 'embedding',
      input_cost_per_token: 0.0000001,
      output_cost_per_token: 0,
    },
    __proto__: {
      litellm_provider: 'anthropic',
      mode: 'chat',
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000005,
    },
  };
}

function fakeFetch(body, opts) {
  opts = opts || {};
  return async function () {
    if (opts.status && opts.status !== 200) {
      return {
        ok: false,
        status: opts.status,
        headers: {
          get: function () {
            return null;
          },
        },
        text: async function () {
          return '';
        },
      };
    }
    return {
      ok: true,
      status: 200,
      headers: {
        get: function (h) {
          if (h && h.toLowerCase() === 'content-length')
            return opts.contentLength == null ? null : String(opts.contentLength);
          return null;
        },
      },
      text: async function () {
        return body;
      },
    };
  };
}

function body() {
  return JSON.stringify(fixture());
}

function digestOf(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---- buildRows --------------------------------------------------------------

test('buildRows keeps Claude rows, converts per-token to per-MTok, drops the rest', function () {
  const built = prices.buildRows(fixture());
  assert.strictEqual(built.rows['claude-opus-4-8'].inputPerMTok, 9);
  assert.strictEqual(built.rows['claude-opus-4-8'].outputPerMTok, 45);
  assert.strictEqual(built.rows['claude-sonnet-4-6'].inputPerMTok, 3);
  // A known bundled id keeps its capability flags.
  assert.strictEqual(built.rows['claude-opus-4-8'].longContext, true);
  assert.strictEqual(built.rows['claude-opus-4-8'].fast, true);
  // An unknown id infers the long-context tier from the upstream context size.
  assert.strictEqual(built.rows['claude-new-9'].longContext, true);
  assert.strictEqual(built.rows['claude-new-9'].fast, false);
  // Non-Claude providers, non-chat modes, zero rates and junk keys are skipped.
  assert.strictEqual(built.rows['gpt-4o'], undefined);
  assert.strictEqual(built.rows['claude-embed-1'], undefined);
  assert.strictEqual(built.rows['claude-bad-1'], undefined);
  assert.strictEqual(built.rows['__proto__'], undefined);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(built.rows, '__proto__'), false);
});

test('buildRows survives junk input without throwing', function () {
  assert.strictEqual(prices.buildRows(null).kept, 0);
  assert.strictEqual(prices.buildRows([]).kept, 0);
  assert.strictEqual(prices.buildRows('nope').kept, 0);
  assert.strictEqual(prices.buildRows({ 'claude-x': 'not an object' }).kept, 0);
});

// ---- refresh ----------------------------------------------------------------

test('a refresh caches the table, pins it by digest and cost estimates use it', async function () {
  const ctx = makeCtx();
  const text = body();
  const res = await prices.refresh(ctx, { fetch: fakeFetch(text), url: 'https://example.test/prices.json' });
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(res.digest, digestOf(text));
  assert.strictEqual(res.models, 5);
  assert.ok(res.newModels >= 1);
  assert.ok(res.shadowed >= 1, 'known bundled ids are repriced, not duplicated');
  assert.ok(fs.existsSync(prices.cachePath(ctx)));

  // The overlay reprices the model and the cost engine picks it up.
  const table = prices.overlay(ctx);
  assert.strictEqual(table['claude-opus-4-8'].inputPerMTok, 9);
  assert.strictEqual(cost.priceFor('claude-opus-4-8', table).inputPerMTok, 9);
  assert.strictEqual(cost.priceFor('claude-opus-4-8').inputPerMTok, 5); // bundled floor untouched
  const card = cost.rateCard('claude-opus-4-8', table);
  assert.strictEqual(card.inputPerMTok, 9);
  assert.strictEqual(card.fallback, false);
  // A model the cache knows but the bundle does not is priced from the cache.
  assert.strictEqual(cost.priceFor('claude-new-9', table).inputPerMTok, 4);
  assert.strictEqual(cost.priceFor('claude-new-9').fallback, true);
});

test('a pinned digest that does not match refuses the write and keeps the old cache', async function () {
  const ctx = makeCtx();
  const good = body();
  const first = await prices.refresh(ctx, { fetch: fakeFetch(good) });
  assert.strictEqual(first.ok, true);

  const other = JSON.stringify(fixture());
  other.replace('0.000009', '0.000008');
  const bad = await prices.refresh(ctx, {
    fetch: fakeFetch(other.replace('0.000009', '0.000008')),
    pin: digestOf(good),
  });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /sha-256 mismatch/);
  // The previous cache is untouched.
  const still = prices.read(ctx);
  assert.strictEqual(still.digest, digestOf(good));
});

test('a malformed pin fails closed and never fetches', async function () {
  const ctx = makeCtx();
  let called = false;
  const res = await prices.refresh(ctx, {
    fetch: async function () {
      called = true;
      return null;
    },
    pin: 'not-a-digest',
  });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /sha-256/);
  assert.strictEqual(called, false, 'a malformed pin must not reach the network');
});

test('the matching pin is accepted', async function () {
  const ctx = makeCtx();
  const text = body();
  const res = await prices.refresh(ctx, { fetch: fakeFetch(text), pin: 'sha256:' + digestOf(text) });
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(res.pinMatches, true);
});

test('a failed refresh leaves the cache alone and explains itself', async function () {
  const ctx = makeCtx();
  const res = await prices.refresh(ctx, { fetch: fakeFetch('', { status: 503 }) });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /http 503/);
  assert.strictEqual(fs.existsSync(prices.cachePath(ctx)), false);

  const notJson = await prices.refresh(ctx, { fetch: fakeFetch('not json') });
  assert.strictEqual(notJson.ok, false);
  assert.match(notJson.error, /not JSON/);

  const tooSmall = await prices.refresh(ctx, {
    fetch: fakeFetch(
      JSON.stringify({
        'claude-a': { litellm_provider: 'anthropic', input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 },
      }),
    ),
  });
  assert.strictEqual(tooSmall.ok, false);
  assert.match(tooSmall.error, /not a price table/);

  const huge = await prices.refresh(ctx, { fetch: fakeFetch('{}', { contentLength: prices.MAX_BYTES + 1 }) });
  assert.strictEqual(huge.ok, false);
  assert.match(huge.error, /too large/);

  const notHttp = await prices.refresh(ctx, { fetch: fakeFetch('{}'), url: 'file:///etc/passwd' });
  assert.strictEqual(notHttp.ok, false);
  assert.match(notHttp.error, /http/);
  assert.strictEqual(fs.existsSync(prices.cachePath(ctx)), false);
});

test('a network error is reported, not thrown', async function () {
  const ctx = makeCtx();
  const res = await prices.refresh(ctx, {
    fetch: async function () {
      throw new Error('boom');
    },
  });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /network error/);
});

// ---- reading an untrusted cache --------------------------------------------

test('a corrupt cache is ignored whole, never half-applied', function () {
  const ctx = makeCtx();
  fs.writeFileSync(prices.cachePath(ctx), '{not json');
  assert.strictEqual(prices.read(ctx), null);
  assert.strictEqual(prices.overlay(ctx), null);
  assert.strictEqual(cost.priceFor('claude-opus-4-8').inputPerMTok, 5);
});

test('a cache with hostile rows keeps only the sane ones', function () {
  const ctx = makeCtx();
  fs.writeFileSync(
    prices.cachePath(ctx),
    JSON.stringify({
      schemaVersion: prices.SCHEMA_VERSION,
      source: 'litellm',
      url: 'https://example.test/p.json',
      fetchedAt: '2026-10-01T00:00:00.000Z',
      digest: digestOf('x'),
      rows: {
        'claude-opus-4-8': { inputPerMTok: 9, outputPerMTok: 45, longContext: true, fast: true },
        'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
        'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
        'claude-new-9': { inputPerMTok: 4, outputPerMTok: 20 },
        __proto__: { inputPerMTok: 1, outputPerMTok: 1 },
        'claude-evil-1': { inputPerMTok: 1e12, outputPerMTok: 5 },
        'claude-evil-2': { inputPerMTok: -1, outputPerMTok: 5 },
        'claude evil 3': { inputPerMTok: 1, outputPerMTok: 5 },
      },
    }),
  );
  const c = prices.read(ctx);
  assert.ok(c, 'a mostly-valid cache is still usable');
  assert.strictEqual(c.rows['claude-opus-4-8'].inputPerMTok, 9);
  assert.strictEqual(c.rows['claude-evil-1'], undefined);
  assert.strictEqual(c.rows['claude-evil-2'], undefined);
  assert.strictEqual(c.rows['claude evil 3'], undefined);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(c.rows, '__proto__'), false);
});

test('a cache with the wrong schema version is ignored', function () {
  const ctx = makeCtx();
  fs.writeFileSync(
    prices.cachePath(ctx),
    JSON.stringify({
      schemaVersion: 99,
      fetchedAt: '2026-10-01T00:00:00.000Z',
      digest: digestOf('x'),
      rows: { 'claude-opus-4-8': { inputPerMTok: 9, outputPerMTok: 45 } },
    }),
  );
  assert.strictEqual(prices.read(ctx), null);
});

test('the overlay reloads when the cache file changes', async function () {
  const ctx = makeCtx();
  await prices.refresh(ctx, { fetch: fakeFetch(body()) });
  assert.strictEqual(prices.overlay(ctx)['claude-opus-4-8'].inputPerMTok, 9);
  const other = body().replace('0.000009', '0.000011');
  await prices.refresh(ctx, { fetch: fakeFetch(other) });
  assert.strictEqual(prices.overlay(ctx)['claude-opus-4-8'].inputPerMTok, 11);
});

// ---- status and clear -------------------------------------------------------

test('describe reports the bundled table until a refresh lands', async function () {
  const ctx = makeCtx();
  const before = prices.describe(ctx);
  assert.strictEqual(before.source, 'bundled');
  assert.strictEqual(before.models, 0);
  assert.strictEqual(before.bundledModels, Object.keys(cost.PRICING).length);

  await prices.refresh(ctx, { fetch: fakeFetch(body()) });
  const after = prices.describe(ctx);
  assert.strictEqual(after.source, 'cache');
  assert.strictEqual(after.models, 5);
  assert.ok(after.shadowed >= 3, 'known bundled ids are repriced');
  assert.ok(after.added >= 1, 'new ids are added');
  assert.ok(after.ageHours >= 0);
  assert.strictEqual(after.pinMatches, null);

  const pinned = prices.describe(ctx, { pin: after.digest });
  assert.strictEqual(pinned.pinMatches, true);
  const wrong = prices.describe(ctx, { pin: digestOf('other') });
  assert.strictEqual(wrong.pinMatches, false);
});

test('clear drops the cache and the bundled table takes over again', async function () {
  const ctx = makeCtx();
  await prices.refresh(ctx, { fetch: fakeFetch(body()) });
  assert.strictEqual(prices.clear(ctx), true);
  assert.strictEqual(prices.read(ctx), null);
  assert.strictEqual(prices.describe(ctx).source, 'bundled');
  assert.strictEqual(cost.priceFor('claude-opus-4-8').inputPerMTok, 5);
});

test('a live row never lowers a rate below the bundled floor, but may raise it', async function () {
  const ctx = makeCtx();
  // Sonnet 5 upstream carries the intro rate ($2/$10); the bundle deliberately
  // prices the standard $3/$15, and an estimate must not understate.
  await prices.refresh(ctx, { fetch: fakeFetch(body().replace('0.000003', '0.000002')) });
  const table = prices.overlay(ctx);
  assert.strictEqual(table['claude-sonnet-4-6'].inputPerMTok, 2); // the raw row is the upstream one
  assert.strictEqual(cost.priceFor('claude-sonnet-4-6', table).inputPerMTok, 3); // the floor holds
  assert.strictEqual(cost.priceFor('claude-sonnet-4-6').inputPerMTok, 3);
});

test('the price cache is a reserved state file, not a phantom account', function () {
  assert.ok(
    profiles.RESERVED_FILES.indexOf('prices-cache') !== -1,
    'prices-cache must be reserved (see profiles.RESERVED_FILES)',
  );
});
