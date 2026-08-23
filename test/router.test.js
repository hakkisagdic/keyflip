import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as router from '../src/router.js';
import * as provider from '../src/provider.js';
import * as secretscan from '../src/secretscan.js';
import { makeCtx } from './helpers.js';

function addProv(ctx, name, baseUrl, models, extra) {
  provider.add(ctx, name, Object.assign({ baseUrl: baseUrl, models: models || {} }, extra || {}));
}

// provider.add persists only a fixed field set, so to exercise the per-provider
// costHint path we patch it onto the meta file directly (as a hand-config would).
function setCostHint(ctx, name, hint) {
  const p = provider.metaPath(ctx, name);
  const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
  meta.costHint = hint;
  fs.writeFileSync(p, JSON.stringify(meta, null, 2));
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
test('route picks the cheapest provider that serves the model (injected priceFor)', function () {
  const ctx = makeCtx();
  addProv(ctx, 'cheap', 'https://cheap/v1', { opus: 'claude-opus-4-8' });
  addProv(ctx, 'pricey', 'https://pricey/v1', { opus: 'claude-opus-4-8' });
  const priceFor = function (name) { return name === 'cheap' ? 1 : 9; };
  const r = router.route(ctx, { model: 'claude-opus-4-8' }, { priceFor: priceFor });
  assert.strictEqual(r.provider, 'cheap');
  assert.strictEqual(r.baseUrl, 'https://cheap/v1');
  assert.match(r.reason, /cheapest of 2/);
});

test('route uses per-provider costHint when no priceFor is injected', function () {
  const ctx = makeCtx();
  addProv(ctx, 'a', 'https://a/v1', { default: 'm1' });
  addProv(ctx, 'b', 'https://b/v1', { default: 'm1' });
  setCostHint(ctx, 'a', 5);
  setCostHint(ctx, 'b', 2);
  const r = router.route(ctx, { model: 'm1' });
  assert.strictEqual(r.provider, 'b');
});

test('route with a single serving provider says so', function () {
  const ctx = makeCtx();
  addProv(ctx, 'solo', 'https://solo/v1', { sonnet: 'claude-sonnet' });
  const r = router.route(ctx, { model: 'claude-sonnet' });
  assert.strictEqual(r.provider, 'solo');
  assert.match(r.reason, /only provider/);
});

test('route honors an explicit pin when arbitrage is off (even over a cheaper peer)', function () {
  const ctx = makeCtx();
  addProv(ctx, 'cheap', 'https://cheap/v1', { opus: 'M' });
  addProv(ctx, 'fav', 'https://fav/v1', { opus: 'M' });
  router.setRoute(ctx, 'M', 'fav');
  const priceFor = function (name) { return name === 'cheap' ? 1 : 100; };
  const r = router.route(ctx, { model: 'M' }, { priceFor: priceFor });
  assert.strictEqual(r.provider, 'fav');
  assert.match(r.reason, /pinned route/);
});

test('arbitrage mode ignores the pin and takes the cheapest', function () {
  const ctx = makeCtx();
  addProv(ctx, 'cheap', 'https://cheap/v1', { opus: 'M' });
  addProv(ctx, 'fav', 'https://fav/v1', { opus: 'M' });
  router.setRoute(ctx, 'M', 'fav');
  router.setArbitrage(ctx, true);
  const priceFor = function (name) { return name === 'cheap' ? 1 : 100; };
  const r = router.route(ctx, { model: 'M' }, { priceFor: priceFor });
  assert.strictEqual(r.provider, 'cheap');
  assert.match(r.reason, /^arbitrage:/);
});

test('a dangling pin (provider deleted) falls back to the cheapest with a note', function () {
  const ctx = makeCtx();
  addProv(ctx, 'keepme', 'https://keep/v1', { opus: 'M' });
  router.setRoute(ctx, 'M', 'keepme', { allowMissing: true }); // pin, then remove the provider
  provider.remove(ctx, 'keepme');
  addProv(ctx, 'other', 'https://other/v1', { opus: 'M' });
  const r = router.route(ctx, { model: 'M' });
  assert.strictEqual(r.provider, 'other');
  assert.match(r.reason, /pinned provider "keepme" missing/);
});

test('route returns provider:null when nothing serves the model', function () {
  const ctx = makeCtx();
  addProv(ctx, 'a', 'https://a/v1', { opus: 'claude-opus' });
  const r = router.route(ctx, { model: 'gpt-4o' });
  assert.strictEqual(r.provider, null);
  assert.strictEqual(r.baseUrl, null);
  assert.match(r.reason, /no configured provider serves/);
});

test('route throws on an invalid / hostile model name', function () {
  const ctx = makeCtx();
  assert.throws(function () { router.route(ctx, { model: '__proto__' }); });
  assert.throws(function () { router.route(ctx, { model: '' }); });
  assert.throws(function () { router.route(ctx, {}); });
});

test('setRoute rejects a provider that is not configured', function () {
  const ctx = makeCtx();
  assert.throws(function () { router.setRoute(ctx, 'M', 'ghost'); }, /no such provider/);
});

test('setRoute / clearRoute / get round-trip and persist to router.json', function () {
  const ctx = makeCtx();
  addProv(ctx, 'p', 'https://p/v1', { opus: 'M' });
  router.setRoute(ctx, 'M', 'p');
  assert.deepStrictEqual(router.get(ctx).routes, { M: 'p' });
  // persisted with 0600
  const st = fs.statSync(router.routerPath(ctx));
  assert.strictEqual(st.mode & 0o777, 0o600);
  assert.strictEqual(router.clearRoute(ctx, 'M'), true);
  assert.deepStrictEqual(router.get(ctx).routes, {});
  assert.strictEqual(router.clearRoute(ctx, 'M'), false); // idempotent
});

test('a hand-tampered router.json (bad names / prototype keys) is normalized away', function () {
  const ctx = makeCtx();
  fs.writeFileSync(router.routerPath(ctx), JSON.stringify({
    routes: { '__proto__': 'evil', 'good-model': 'p', 'bad model!': 'p', ok: 42 }, arbitrage: 'yes',
  }));
  addProv(ctx, 'p', 'https://p/v1', { default: 'good-model' });
  const g = router.get(ctx);
  assert.deepStrictEqual(g.routes, { 'good-model': 'p' }); // junk dropped
  assert.strictEqual(g.arbitrage, false);                  // non-true coerced to false
  assert.strictEqual(Object.getPrototypeOf(g.routes) === Object.prototype, true);
  assert.strictEqual({}.polluted, undefined);              // no prototype pollution
});

test('a corrupt router.json throws on write (never silently clobbers)', function () {
  const ctx = makeCtx();
  addProv(ctx, 'p', 'https://p/v1', { opus: 'M' });
  fs.writeFileSync(router.routerPath(ctx), '{not json');
  assert.throws(function () { router.setRoute(ctx, 'M', 'p'); }, /not valid JSON/);
  // but the read-only path stays quiet
  assert.deepStrictEqual(router.get(ctx).routes, {});
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
test('cachePut then cacheGet returns the stored response', function () {
  const ctx = makeCtx();
  router.cachePut(ctx, { model: 'M', prompt: 'hello', response: 'world' });
  const hit = router.cacheGet(ctx, { model: 'M', prompt: 'hello' });
  assert.ok(hit);
  assert.strictEqual(hit.response, 'world');
  assert.strictEqual(hit.model, 'M');
  assert.strictEqual(hit.promptHash, router.cacheKey('M', 'hello'));
});

test('cacheGet misses for an unknown key and for a different model (hash space is model-scoped)', function () {
  const ctx = makeCtx();
  router.cachePut(ctx, { model: 'M', prompt: 'hello', response: 'world' });
  assert.strictEqual(router.cacheGet(ctx, { model: 'M', prompt: 'goodbye' }), null);
  assert.strictEqual(router.cacheGet(ctx, { model: 'OTHER', prompt: 'hello' }), null);
});

test('cacheGet respects the TTL (default 24h) using the injectable clock', function () {
  const ctx = makeCtx();
  router.cachePut(ctx, { model: 'M', prompt: 'p', response: 'r' }, { now: '2026-01-01T00:00:00.000Z' });
  // 12h later: fresh under the default 24h TTL
  assert.ok(router.cacheGet(ctx, { model: 'M', prompt: 'p' }, { now: '2026-01-01T12:00:00.000Z' }));
  // 25h later: expired under default TTL
  assert.strictEqual(router.cacheGet(ctx, { model: 'M', prompt: 'p' }, { now: '2026-01-02T01:00:00.000Z' }), null);
  // a tiny custom TTL expires almost immediately
  assert.strictEqual(router.cacheGet(ctx, { model: 'M', prompt: 'p' }, { now: '2026-01-01T00:00:01.000Z', ttlMs: 100 }), null);
});

test('secrets in the response are stripped before they touch disk', function () {
  const ctx = makeCtx();
  const leaky = 'here is your key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 keep it safe';
  router.cachePut(ctx, { model: 'M', prompt: 'p', response: leaky });
  const raw = fs.readFileSync(router.cacheFile(ctx, 'M', 'p'), 'utf8');
  assert.doesNotMatch(raw, /sk-ant-api03/);          // the token is gone from disk
  assert.match(raw, new RegExp(secretscan.REDACTED)); // replaced with the redaction marker
  const hit = router.cacheGet(ctx, { model: 'M', prompt: 'p' });
  assert.doesNotMatch(hit.response, /sk-ant-api03/);
});

test('the raw prompt is NEVER written to disk (only its hash)', function () {
  const ctx = makeCtx();
  const secretPrompt = 'my password is hunter2-super-secret-prompt-text';
  router.cachePut(ctx, { model: 'M', prompt: secretPrompt, response: 'ok' });
  const raw = fs.readFileSync(router.cacheFile(ctx, 'M', secretPrompt), 'utf8');
  assert.doesNotMatch(raw, /hunter2-super-secret-prompt-text/);
});

test('the cache dir is bounded — oldest entries are evicted past the cap', function () {
  const ctx = makeCtx();
  // write 5 entries with increasing timestamps, cap of 3
  for (let i = 0; i < 5; i++) {
    router.cachePut(ctx, { model: 'M', prompt: 'p' + i, response: 'r' + i }, { now: '2026-01-01T00:00:0' + i + '.000Z', maxFiles: 3 });
  }
  assert.strictEqual(router.cacheStatus(ctx).count, 3);
  // the two oldest (p0, p1) were evicted; the three newest survive
  assert.strictEqual(router.cacheGet(ctx, { model: 'M', prompt: 'p0' }), null);
  assert.strictEqual(router.cacheGet(ctx, { model: 'M', prompt: 'p1' }), null);
  assert.ok(router.cacheGet(ctx, { model: 'M', prompt: 'p4' }));
});

test('cachePurge removes everything, or only entries older than a cutoff', function () {
  const ctx = makeCtx();
  router.cachePut(ctx, { model: 'M', prompt: 'old', response: 'r' }, { now: '2026-01-01T00:00:00.000Z' });
  router.cachePut(ctx, { model: 'M', prompt: 'new', response: 'r' }, { now: '2026-01-03T00:00:00.000Z' });
  // purge entries older than 24h as of 2026-01-02 -> only 'old' goes
  let res = router.cachePurge(ctx, { olderThanMs: router.DAY_MS }, { now: '2026-01-02T00:00:01.000Z' });
  assert.strictEqual(res.removed, 1);
  assert.strictEqual(router.cacheGet(ctx, { model: 'M', prompt: 'old' }), null);
  assert.ok(router.cacheGet(ctx, { model: 'M', prompt: 'new' }));
  // purge-all
  res = router.cachePurge(ctx, {});
  assert.strictEqual(res.removed, 1);
  assert.strictEqual(router.cacheStatus(ctx).count, 0);
});

test('cacheGet is null-safe on a missing / hostile model and empty prompt', function () {
  const ctx = makeCtx();
  assert.strictEqual(router.cacheGet(ctx, { model: '__proto__', prompt: 'x' }), null);
  assert.strictEqual(router.cacheGet(ctx, { model: 'M', prompt: '' }), null);
  assert.throws(function () { router.cachePut(ctx, { model: 'M', prompt: '', response: 'r' }); });
});

test('cacheStatus reports count, cap and the timestamp range', function () {
  const ctx = makeCtx();
  router.cachePut(ctx, { model: 'M', prompt: 'a', response: 'r' }, { now: '2026-01-01T00:00:00.000Z' });
  router.cachePut(ctx, { model: 'M', prompt: 'b', response: 'r' }, { now: '2026-01-05T00:00:00.000Z' });
  const s = router.cacheStatus(ctx);
  assert.strictEqual(s.count, 2);
  assert.strictEqual(s.cap, router.MAX_CACHE_FILES);
  assert.strictEqual(s.oldest, '2026-01-01T00:00:00.000Z');
  assert.strictEqual(s.newest, '2026-01-05T00:00:00.000Z');
  assert.ok(s.bytes > 0);
});
