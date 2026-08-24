// GROUPS/TAGS: label accounts into pools so rotation/failover can be scoped.
// A hermetic makeCtx() gives each test a fresh temp configDir; groups.json is the
// only state. Covers the happy path plus hostile input (prototype pollution,
// corrupt file, bad names/tags) — no network, no real credential store needed.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as groups from '../src/groups.js';
import { makeCtx } from './helpers.js';

function gpath(ctx) {
  return path.join(ctx.configDir, 'groups.json');
}

test('tagsFor is empty for an untagged account', function () {
  const ctx = makeCtx();
  assert.deepStrictEqual(groups.tagsFor(ctx, 'work'), []);
  assert.deepStrictEqual(groups.readAll(ctx), Object.create(null));
});

test('addTag is idempotent and persists across reloads', function () {
  const ctx = makeCtx();
  assert.deepStrictEqual(groups.addTag(ctx, 'acme', 'work'), ['work']);
  assert.deepStrictEqual(groups.addTag(ctx, 'acme', 'work'), ['work'], 'adding the same tag twice is a no-op');
  assert.deepStrictEqual(groups.addTag(ctx, 'acme', 'billing'), ['billing', 'work'], 'tags come back sorted');
  // fresh read = persisted to disk
  assert.deepStrictEqual(groups.tagsFor(ctx, 'acme'), ['billing', 'work']);
  assert.ok(fs.existsSync(gpath(ctx)), 'groups.json written');
});

test('setTags replaces wholesale; empty set drops the account entry', function () {
  const ctx = makeCtx();
  groups.addTag(ctx, 'acme', 'work');
  assert.deepStrictEqual(groups.setTags(ctx, 'acme', ['b', 'a', 'a']), ['a', 'b'], 'dedupes, returns sorted');
  assert.deepStrictEqual(groups.tagsFor(ctx, 'acme'), ['a', 'b'], 'stored sorted');
  groups.setTags(ctx, 'acme', []);
  assert.deepStrictEqual(groups.tagsFor(ctx, 'acme'), []);
  assert.strictEqual(groups.readAll(ctx).acme, undefined, 'account removed from map when it has no tags');
});

test('removeTag removes one tag; removing the last drops the account', function () {
  const ctx = makeCtx();
  groups.setTags(ctx, 'acme', ['work', 'billing']);
  assert.deepStrictEqual(groups.removeTag(ctx, 'acme', 'work'), ['billing']);
  assert.deepStrictEqual(groups.removeTag(ctx, 'acme', 'nope'), ['billing'], 'removing an absent tag is a no-op');
  assert.deepStrictEqual(groups.removeTag(ctx, 'acme', 'billing'), []);
  assert.strictEqual(groups.readAll(ctx).acme, undefined);
});

test('listGroups builds the inverse index (union over tags), members sorted', function () {
  const ctx = makeCtx();
  groups.setTags(ctx, 'zeta', ['work']);
  groups.setTags(ctx, 'alpha', ['work', 'personal']);
  groups.setTags(ctx, 'beta', ['personal']);
  const g = groups.listGroups(ctx);
  assert.deepStrictEqual(Object.keys(g).sort(), ['personal', 'work']);
  assert.deepStrictEqual(g.work, ['alpha', 'zeta']);
  assert.deepStrictEqual(g.personal, ['alpha', 'beta']);
  assert.strictEqual(Object.getPrototypeOf(g), null, 'derived index is null-prototype');
});

test('membersOf returns the pool; unknown/invalid group -> []', function () {
  const ctx = makeCtx();
  groups.setTags(ctx, 'a', ['work']);
  groups.setTags(ctx, 'b', ['work']);
  assert.deepStrictEqual(groups.membersOf(ctx, 'work'), ['a', 'b']);
  assert.deepStrictEqual(groups.membersOf(ctx, 'ghost'), []);
  assert.deepStrictEqual(groups.membersOf(ctx, '__proto__'), [], 'reserved name is not a valid group');
});

test('filterProfiles keeps only tagged names and PRESERVES input order', function () {
  const ctx = makeCtx();
  groups.setTags(ctx, 'a', ['work']);
  groups.setTags(ctx, 'c', ['work']);
  // rotation order is c, b, a — must survive the filter
  const profs = [{ name: 'c' }, { name: 'b' }, { name: 'a' }];
  assert.deepStrictEqual(groups.filterProfiles(ctx, profs, 'work'), [{ name: 'c' }, { name: 'a' }]);
  assert.deepStrictEqual(groups.filterProfiles(ctx, profs, 'ghost'), []);
  assert.deepStrictEqual(groups.filterProfiles(ctx, null, 'work'), [], 'non-array input is safe');
  assert.deepStrictEqual(
    groups.filterProfiles(ctx, [{ nope: 1 }, 'x', null], 'work'),
    [],
    'junk profile entries dropped',
  );
});

test('hostile: invalid account name or tag throws (no write)', function () {
  const ctx = makeCtx();
  assert.throws(function () {
    groups.addTag(ctx, '__proto__', 'work');
  }, /invalid account name/);
  assert.throws(function () {
    groups.addTag(ctx, 'acme', '__proto__');
  }, /invalid group tag/);
  assert.throws(function () {
    groups.addTag(ctx, 'acme', 'has space');
  }, /invalid group tag/);
  assert.throws(function () {
    groups.addTag(ctx, 'acme', 'a/b');
  }, /invalid group tag/);
  assert.throws(function () {
    groups.setTags(ctx, 'acme', ['ok', 'bad tag']);
  }, /invalid group tag/);
  assert.strictEqual(fs.existsSync(gpath(ctx)), false, 'nothing was written on rejection');
});

test('hostile: a tampered groups.json cannot pollute prototypes and is sanitized', function () {
  const ctx = makeCtx();
  fs.writeFileSync(
    gpath(ctx),
    JSON.stringify({
      __proto__: { polluted: true },
      constructor: ['x'],
      good: ['work', 'work', 'bad tag', 5, 'billing'],
      empty: [],
      scalar: 'nope',
    }),
  );
  const all = groups.readAll(ctx);
  assert.strictEqual(Object.getPrototypeOf(all), null, 'readAll returns a null-proto map');
  assert.strictEqual({}.polluted, undefined, 'Object.prototype was not polluted');
  assert.deepStrictEqual(Object.keys(all), ['good'], 'only the valid account survives');
  assert.deepStrictEqual(all.good, ['billing', 'work'], 'bad/duplicate tags stripped, rest sorted');
  assert.deepStrictEqual(groups.listGroups(ctx).work, ['good']);
});

test('corrupt groups.json: reads degrade to empty, but writes REFUSE to clobber', function () {
  const ctx = makeCtx();
  fs.writeFileSync(gpath(ctx), '{ this is not json');
  assert.deepStrictEqual(groups.readAll(ctx), Object.create(null), 'read degrades to empty');
  assert.deepStrictEqual(groups.tagsFor(ctx, 'acme'), []);
  assert.throws(
    function () {
      groups.addTag(ctx, 'acme', 'work');
    },
    /not valid JSON/,
    'write refuses to overwrite corrupt file',
  );
  assert.strictEqual(fs.readFileSync(gpath(ctx), 'utf8'), '{ this is not json', 'the corrupt file is left untouched');
});

test('groups.json is written with 0600 permissions', function () {
  const ctx = makeCtx();
  groups.addTag(ctx, 'acme', 'work');
  const mode = fs.statSync(gpath(ctx)).mode & 0o777;
  // Windows does not honour POSIX bits; assert only where it is meaningful.
  if (process.platform !== 'win32') assert.strictEqual(mode, 0o600);
});
