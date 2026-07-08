'use strict';
// CONFIG (E4): a validated, namespaced SETTINGS store at <configDir>/config.json.
// A hermetic makeCtx() gives each test a fresh temp configDir; config.json is the
// only state. Covers the happy path (get/getAll/set/unset/describe, coercion of
// CLI strings, persistence, 0600) plus hostile input (unknown keys, bad types,
// out-of-range, control chars, prototype pollution, corrupt file). No network, no
// real credential store, no clock — every read/write is local + deterministic.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { makeCtx } = require('./helpers');

function cpath(ctx) { return path.join(ctx.configDir, 'config.json'); }

// ---- defaults / describe ----------------------------------------------------

test('get returns the schema default when nothing is stored (no file created)', function () {
  const ctx = makeCtx();
  assert.strictEqual(config.get(ctx, 'autoswitch.threshold'), 90);
  assert.strictEqual(config.get(ctx, 'notify.desktop'), false);
  assert.strictEqual(config.get(ctx, 'ui.theme'), 'auto');
  assert.strictEqual(config.get(ctx, 'ui.color'), true);
  assert.strictEqual(config.get(ctx, 'autoswitch.group'), '');
  assert.strictEqual(fs.existsSync(cpath(ctx)), false, 'a pure read never creates the file');
});

test('getAll merges defaults for every known key and is null-prototype', function () {
  const ctx = makeCtx();
  const all = config.getAll(ctx);
  assert.strictEqual(Object.getPrototypeOf(all), null, 'effective map is null-proto');
  assert.strictEqual(all['autoswitch.threshold'], 90);
  assert.strictEqual(all['security.relockMinutes'], 0);
  assert.strictEqual(all['usage.cacheTtlSeconds'], 60);
  // exactly the declared keys, nothing else
  assert.deepStrictEqual(Object.keys(all).sort(), Object.keys(config.describe()).sort());
});

test('describe returns a safe COPY — mutating it never touches the live schema', function () {
  const d = config.describe();
  assert.strictEqual(Object.getPrototypeOf(d), null);
  assert.strictEqual(d['autoswitch.threshold'].type, 'int');
  assert.strictEqual(d['autoswitch.threshold'].min, 0);
  assert.strictEqual(d['autoswitch.threshold'].max, 100);
  assert.deepStrictEqual(d['ui.theme'].values, ['auto', 'light', 'dark']);
  // tamper with the returned copy...
  d['autoswitch.threshold'].default = 999;
  d['ui.theme'].values.push('neon');
  const fresh = config.describe();
  assert.strictEqual(fresh['autoswitch.threshold'].default, 90, 'live default untouched');
  assert.deepStrictEqual(fresh['ui.theme'].values, ['auto', 'light', 'dark'], 'live enum values untouched');
});

// ---- set: coercion of CLI strings ------------------------------------------

test('set coerces an int string, returns the typed value, persists, and getAll reflects it', function () {
  const ctx = makeCtx();
  assert.strictEqual(config.set(ctx, 'autoswitch.threshold', '75'), 75, 'returns coerced number');
  assert.strictEqual(config.get(ctx, 'autoswitch.threshold'), 75);
  // stored as a real JSON number, not a string
  const raw = JSON.parse(fs.readFileSync(cpath(ctx), 'utf8'));
  assert.strictEqual(raw['autoswitch.threshold'], 75);
  assert.strictEqual(config.getAll(ctx)['autoswitch.threshold'], 75);
});

test('set coerces bool from many truthy/falsy spellings', function () {
  const ctx = makeCtx();
  ['true', '1', 'yes', 'on', 'TRUE', 'On'].forEach(function (t) {
    assert.strictEqual(config.set(ctx, 'notify.desktop', t), true, t + ' -> true');
  });
  ['false', '0', 'no', 'off', 'OFF'].forEach(function (t) {
    assert.strictEqual(config.set(ctx, 'notify.desktop', t), false, t + ' -> false');
  });
  assert.strictEqual(config.get(ctx, 'notify.desktop'), false);
});

test('set accepts native scalars too (String()-coerced), not only strings', function () {
  const ctx = makeCtx();
  assert.strictEqual(config.set(ctx, 'autoswitch.threshold', 42), 42, 'number 42 -> 42');
  assert.strictEqual(config.set(ctx, 'notify.desktop', true), true, 'boolean true -> true');
  assert.strictEqual(config.set(ctx, 'usage.cacheTtlSeconds', 0), 0, 'zero is a valid in-range int');
});

test('set validates enum and string values', function () {
  const ctx = makeCtx();
  assert.strictEqual(config.set(ctx, 'ui.theme', 'dark'), 'dark');
  assert.strictEqual(config.get(ctx, 'ui.theme'), 'dark');
  assert.strictEqual(config.set(ctx, 'autoswitch.group', 'work'), 'work');
  assert.strictEqual(config.set(ctx, 'autoswitch.group', ''), '', 'empty string is allowed');
});

test('int bounds are inclusive at both ends', function () {
  const ctx = makeCtx();
  assert.strictEqual(config.set(ctx, 'autoswitch.threshold', '0'), 0);
  assert.strictEqual(config.set(ctx, 'autoswitch.threshold', '100'), 100);
  assert.strictEqual(config.set(ctx, 'security.relockMinutes', '1440'), 1440);
});

// ---- unset ------------------------------------------------------------------

test('unset reverts to default and reports whether an override was present', function () {
  const ctx = makeCtx();
  config.set(ctx, 'ui.theme', 'light');
  assert.strictEqual(config.get(ctx, 'ui.theme'), 'light');
  assert.strictEqual(config.unset(ctx, 'ui.theme'), true, 'reports it removed an override');
  assert.strictEqual(config.get(ctx, 'ui.theme'), 'auto', 'back to default');
  assert.strictEqual(config.unset(ctx, 'ui.theme'), false, 'no-op when already default');
});

test('setting one key preserves the others and stores keys sorted', function () {
  const ctx = makeCtx();
  config.set(ctx, 'ui.theme', 'dark');
  config.set(ctx, 'autoswitch.threshold', '80');
  config.set(ctx, 'notify.desktop', 'on');
  const raw = fs.readFileSync(cpath(ctx), 'utf8');
  const parsed = JSON.parse(raw);
  assert.deepStrictEqual(parsed, { 'autoswitch.threshold': 80, 'notify.desktop': true, 'ui.theme': 'dark' });
  assert.deepStrictEqual(Object.keys(parsed), ['autoswitch.threshold', 'notify.desktop', 'ui.theme'], 'keys written sorted');
});

test('readAll returns only stored overrides (null-proto), not defaults', function () {
  const ctx = makeCtx();
  assert.strictEqual(Object.getPrototypeOf(config.readAll(ctx)), null);
  assert.deepStrictEqual(Object.keys(config.readAll(ctx)), []);
  config.set(ctx, 'ui.color', 'false');
  assert.deepStrictEqual(config.readAll(ctx), Object.assign(Object.create(null), { 'ui.color': false }));
});

// ---- hostile: unknown keys --------------------------------------------------

test('hostile: unknown key is rejected by get/set/unset (nothing written)', function () {
  const ctx = makeCtx();
  assert.throws(function () { config.get(ctx, 'does.not.exist'); }, /unknown config key/);
  assert.throws(function () { config.set(ctx, 'does.not.exist', 'x'); }, /unknown config key/);
  assert.throws(function () { config.unset(ctx, 'does.not.exist'); }, /unknown config key/);
  assert.throws(function () { config.get(ctx, '__proto__'); }, /unknown config key/, 'reserved key is not known');
  assert.strictEqual(fs.existsSync(cpath(ctx)), false, 'no write on rejection');
});

// ---- hostile: bad types / ranges -------------------------------------------

test('hostile: bad type or out-of-range value throws and never writes', function () {
  const ctx = makeCtx();
  assert.throws(function () { config.set(ctx, 'autoswitch.threshold', 'abc'); }, /expected an integer/);
  assert.throws(function () { config.set(ctx, 'autoswitch.threshold', '9.5'); }, /expected an integer/);
  assert.throws(function () { config.set(ctx, 'autoswitch.threshold', '150'); }, /must be <= 100/);
  assert.throws(function () { config.set(ctx, 'autoswitch.threshold', '-1'); }, /must be >= 0/);
  assert.throws(function () { config.set(ctx, 'security.relockMinutes', '5000'); }, /must be <= 1440/);
  assert.throws(function () { config.set(ctx, 'notify.desktop', 'maybe'); }, /expected a boolean/);
  assert.throws(function () { config.set(ctx, 'ui.theme', 'purple'); }, /must be one of/);
  assert.throws(function () { config.set(ctx, 'autoswitch.threshold', null); }, /a value is required/);
  assert.throws(function () { config.set(ctx, 'autoswitch.threshold', undefined); }, /a value is required/);
  assert.strictEqual(fs.existsSync(cpath(ctx)), false, 'no write on any rejection');
});

test('hostile: string value rejects control chars and over-length input', function () {
  const ctx = makeCtx();
  assert.throws(function () { config.set(ctx, 'autoswitch.group', 'a\u001bb'); }, /control characters/, 'ANSI ESC refused');
  assert.throws(function () { config.set(ctx, 'autoswitch.group', 'a\nb'); }, /control characters/, 'newline refused');
  assert.throws(function () { config.set(ctx, 'autoswitch.group', 'x'.repeat(1025)); }, /too long/);
  assert.strictEqual(fs.existsSync(cpath(ctx)), false);
});

// ---- hostile: tampered / corrupt file --------------------------------------

test('hostile: a tampered config.json cannot pollute prototypes and bad entries are dropped', function () {
  const ctx = makeCtx();
  fs.writeFileSync(cpath(ctx), JSON.stringify({
    __proto__: { polluted: true },
    constructor: 'nope',
    'autoswitch.threshold': 55,          // valid -> survives
    'autoswitch.strategy': 'bogus',      // invalid enum -> dropped (default)
    'security.relockMinutes': 99999,     // out of range -> dropped (default)
    'ui.theme': 5,                       // wrong type -> dropped (default)
    'notify.desktop': 'true',            // wrong type (string not bool) -> dropped
    'totally.unknown': 1,                // unknown key -> dropped
  }));
  const all = config.readAll(ctx);
  assert.strictEqual(Object.getPrototypeOf(all), null, 'readAll is null-proto');
  assert.strictEqual(({}).polluted, undefined, 'Object.prototype was not polluted');
  assert.deepStrictEqual(Object.keys(all), ['autoswitch.threshold'], 'only the valid override survives');
  assert.strictEqual(all['autoswitch.threshold'], 55);
  // effective values fall back to defaults for every dropped/invalid key
  assert.strictEqual(config.get(ctx, 'autoswitch.strategy'), 'best');
  assert.strictEqual(config.get(ctx, 'security.relockMinutes'), 0);
  assert.strictEqual(config.get(ctx, 'ui.theme'), 'auto');
  assert.strictEqual(config.get(ctx, 'notify.desktop'), false);
});

test('a subsequent set rewrites the file clean — junk/invalid keys are pruned', function () {
  const ctx = makeCtx();
  fs.writeFileSync(cpath(ctx), JSON.stringify({
    'ui.theme': 'light',        // valid, kept
    'bad.key': 1,               // unknown, pruned
    'ui.color': 'yes',          // wrong stored type, pruned then irrelevant
  }));
  config.set(ctx, 'autoswitch.threshold', '70');
  const parsed = JSON.parse(fs.readFileSync(cpath(ctx), 'utf8'));
  assert.deepStrictEqual(parsed, { 'autoswitch.threshold': 70, 'ui.theme': 'light' }, 'only valid keys survive the rewrite');
});

test('corrupt config.json: reads degrade to defaults, but writes REFUSE to clobber', function () {
  const ctx = makeCtx();
  fs.writeFileSync(cpath(ctx), '{ this is not json');
  assert.deepStrictEqual(config.readAll(ctx), Object.create(null), 'read degrades to empty');
  assert.strictEqual(config.get(ctx, 'ui.theme'), 'auto', 'get falls back to default');
  assert.throws(function () { config.set(ctx, 'ui.theme', 'dark'); }, /not valid JSON/, 'set refuses to overwrite a corrupt file');
  assert.throws(function () { config.unset(ctx, 'ui.theme'); }, /not valid JSON/, 'unset refuses too');
  assert.strictEqual(fs.readFileSync(cpath(ctx), 'utf8'), '{ this is not json', 'corrupt file left untouched');
});

// ---- persistence / permissions ---------------------------------------------

test('values persist across a fresh module read of the same configDir', function () {
  const ctx = makeCtx();
  config.set(ctx, 'ui.theme', 'dark');
  config.set(ctx, 'autoswitch.threshold', '65');
  const ctx2 = makeCtx({ home: ctx.home }); // reuse the same home/configDir
  assert.strictEqual(config.get(ctx2, 'ui.theme'), 'dark');
  assert.strictEqual(config.get(ctx2, 'autoswitch.threshold'), 65);
});

test('config.json is written with 0600 permissions', function () {
  const ctx = makeCtx();
  config.set(ctx, 'ui.theme', 'dark');
  const mode = fs.statSync(cpath(ctx)).mode & 0o777;
  if (process.platform !== 'win32') assert.strictEqual(mode, 0o600);
});
