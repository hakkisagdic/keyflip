// commands.test.js — the CATALOG of the keyflip CLI surface stays well-formed
// and searchable so a TUI command palette can list/search every command.

import { test } from 'node:test';
import assert from 'node:assert';
import { CATALOG, GROUPS, search, byGroup, get } from '../src/commands.js';

test('CATALOG is non-empty and every entry is well-formed', function () {
  assert.ok(Array.isArray(CATALOG), 'CATALOG is an array');
  assert.ok(CATALOG.length > 0, 'CATALOG is non-empty');
  for (const e of CATALOG) {
    assert.ok(e && typeof e === 'object', 'entry is an object');
    assert.strictEqual(typeof e.name, 'string', e.name + ': name is a string');
    assert.ok(e.name.length > 0, 'name is non-empty');
    assert.strictEqual(typeof e.group, 'string', e.name + ': group is a string');
    assert.strictEqual(typeof e.desc, 'string', e.name + ': desc is a string');
    assert.ok(e.desc.length > 0, e.name + ': desc is non-empty');
    assert.strictEqual(typeof e.usage, 'string', e.name + ': usage is a string');
    assert.strictEqual(typeof e.safe, 'boolean', e.name + ': safe is a boolean');
    if ('aliases' in e) assert.ok(Array.isArray(e.aliases), e.name + ': aliases is an array');
  }
});

test('command names are unique (including aliases)', function () {
  const seen = new Set();
  for (const e of CATALOG) {
    assert.ok(!seen.has(e.name), 'duplicate name: ' + e.name);
    seen.add(e.name);
    for (const a of (e.aliases || [])) {
      assert.ok(!seen.has(a), 'duplicate alias/name: ' + a);
      seen.add(a);
    }
  }
});

test('GROUPS covers every entry.group', function () {
  const groupSet = new Set(GROUPS);
  for (const e of CATALOG) {
    assert.ok(groupSet.has(e.group), 'group not in GROUPS: ' + e.group + ' (from ' + e.name + ')');
  }
});

test('search("session") finds the sessions commands', function () {
  const names = search('session').map(function (e) { return e.name; });
  assert.ok(names.indexOf('sessions') !== -1, 'finds sessions');
  // "session" appears in several descs (send/resume/foreign/…) — the sessions group is covered.
  assert.ok(names.length >= 1);
});

test('search is case-insensitive and matches name, alias, and desc', function () {
  assert.ok(search('SWITCH').some(function (e) { return e.name === 'switch'; }), 'name, case-insensitive');
  assert.ok(search('groups').some(function (e) { return e.name === 'group'; }), 'alias match');
  assert.ok(search('quota').some(function (e) { return e.name === 'list'; }), 'desc match');
});

test('empty / whitespace query returns the whole catalog', function () {
  assert.strictEqual(search('').length, CATALOG.length);
  assert.strictEqual(search('   ').length, CATALOG.length);
  assert.strictEqual(search().length, CATALOG.length);
});

test('search returns a fresh array (does not leak the CATALOG reference)', function () {
  const all = search('');
  assert.notStrictEqual(all, CATALOG, 'not the same reference');
  all.push({ name: 'bogus' });
  assert.ok(!CATALOG.some(function (e) { return e.name === 'bogus'; }), 'CATALOG unmutated');
});

test('get returns entries by name and by alias', function () {
  assert.strictEqual(get('status').name, 'status');
  assert.strictEqual(get('ctx').name, 'context', 'resolves alias -> canonical entry');
  assert.strictEqual(get('groups').name, 'group');
});

test('get is null-proto safe for unknown and inherited keys', function () {
  assert.strictEqual(get('nope'), null);
  assert.strictEqual(get('__proto__'), null);
  assert.strictEqual(get('constructor'), null);
  assert.strictEqual(get('toString'), null);
  assert.strictEqual(get(undefined), null);
  assert.strictEqual(get(42), null);
});

test('safe is true for read-only commands and false for mutating ones', function () {
  assert.strictEqual(get('status').safe, true);
  assert.strictEqual(get('list').safe, true);
  assert.strictEqual(get('usage').safe, true);
  assert.strictEqual(get('doctor').safe, true);
  assert.strictEqual(get('surfaces').safe, true);
  assert.strictEqual(get('ui').safe, true);
  assert.strictEqual(get('switch').safe, false);
  assert.strictEqual(get('remove').safe, false, 'delete/remove is not safe');
  assert.strictEqual(get('reset').safe, false);
});

test('byGroup buckets entries by group, ordered by GROUPS', function () {
  const grouped = byGroup();
  const keys = Object.keys(grouped);
  // Keys appear in GROUPS order.
  const expectedOrder = GROUPS.filter(function (g) { return keys.indexOf(g) !== -1; });
  assert.deepStrictEqual(keys, expectedOrder);
  // Every entry is accounted for exactly once.
  let total = 0;
  for (const g of keys) {
    for (const e of grouped[g]) assert.strictEqual(e.group, g);
    total += grouped[g].length;
  }
  assert.strictEqual(total, CATALOG.length);
});

test('the whole dispatch surface is covered (key commands present)', function () {
  // Spot-check one command from each group so the palette is genuinely complete.
  const must = ['add', 'provider', 'sessions', 'context', 'migrate', 'fleet',
    'run-job', 'cost', 'policy', 'config', 'ui', 'agents', 'doctor'];
  for (const n of must) assert.ok(get(n), 'missing command: ' + n);
  assert.ok(CATALOG.length >= 60, 'catalog covers the bulk of the CLI surface');
});
