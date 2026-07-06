'use strict';
// Tests for the onboard wizard's inline provider (API-key endpoint) capture (#6).
// The full wizard is TTY-interactive, but `onboardProvider(ctx, ask, rl)` is pure
// enough to drive with a scripted answer queue (shared by the visible `ask` and the
// hidden key read via rl.question).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const cli = require('../src/cli');
const provider = require('../src/provider');
const { makeCtx } = require('./helpers');

// Drive onboardProvider with a queue of answers consumed in prompt order:
// name, baseUrl, authScheme, key(hidden), route-now.
function driver(answers) {
  const q = answers.slice();
  const ask = function () { return Promise.resolve(q.length ? q.shift() : ''); };
  const rl = { question: function (_prompt, cb) { cb(q.length ? q.shift() : ''); }, _writeToOutput: null };
  return { ask: ask, rl: rl };
}
function ctxForProviders() {
  const ctx = makeCtx();
  ctx.claudeSettingsPath = path.join(ctx.home, '.claude', 'settings.json'); // for the "route now?" path
  return ctx;
}

test('onboardProvider saves an api-key provider with the key in the store', async function () {
  const ctx = ctxForProviders();
  const d = driver(['relay', 'https://relay.example', 'a', 'sk-123', 'n']); // api-key, do not activate
  const name = await cli.onboardProvider(ctx, d.ask, d.rl);
  assert.strictEqual(name, 'relay');
  assert.ok(provider.exists(ctx, 'relay'));
  const meta = provider.read(ctx, 'relay');
  assert.strictEqual(meta.baseUrl, 'https://relay.example');
  assert.strictEqual(meta.authScheme, 'api-key');
  assert.strictEqual(ctx.store.getProfile('provider__relay'), 'sk-123'); // secret in the store, not argv
});

test('onboardProvider defaults to bearer and allows a keyless provider', async function () {
  const ctx = ctxForProviders();
  const d = driver(['gw', 'https://gw.example', '', '', 'n']); // Enter=bearer, blank key
  const name = await cli.onboardProvider(ctx, d.ask, d.rl);
  assert.strictEqual(name, 'gw');
  assert.strictEqual(provider.read(ctx, 'gw').authScheme, 'bearer');
  assert.strictEqual(ctx.store.getProfile('provider__gw'), null); // no key stored
});

test('onboardProvider rejects an invalid base URL (no provider written)', async function () {
  const ctx = ctxForProviders();
  const d = driver(['bad', 'ftp://nope', '', '', 'n']);
  const name = await cli.onboardProvider(ctx, d.ask, d.rl);
  assert.strictEqual(name, null);
  assert.strictEqual(provider.exists(ctx, 'bad'), false);
});

test('onboardProvider cancels on an empty name', async function () {
  const ctx = ctxForProviders();
  const d = driver(['', '', '', '', '']);
  assert.strictEqual(await cli.onboardProvider(ctx, d.ask, d.rl), null);
});

test('onboardProvider skips a duplicate provider name', async function () {
  const ctx = ctxForProviders();
  provider.add(ctx, 'relay', { baseUrl: 'https://existing.example', authScheme: 'bearer' });
  const d = driver(['relay', 'https://new.example', 'a', 'sk-9', 'n']);
  const name = await cli.onboardProvider(ctx, d.ask, d.rl);
  assert.strictEqual(name, null);
  assert.strictEqual(provider.read(ctx, 'relay').baseUrl, 'https://existing.example'); // untouched
});
