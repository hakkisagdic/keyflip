// Tests for the zero-dep YAML subset reader (src/yamlread.js).
import test from 'node:test';
import assert from 'node:assert';
import * as yaml from '../src/yamlread.js';

test('scalars are coerced (int/float/bool/null) and quoted strings preserved', function () {
  const o = yaml.parse('a: 1\nb: 1.5\nc: true\nd: false\ne: ~\nf: null\ng: "hi: there # not a comment"\nh: plain text');
  assert.strictEqual(o.a, 1);
  assert.strictEqual(o.b, 1.5);
  assert.strictEqual(o.c, true);
  assert.strictEqual(o.d, false);
  assert.strictEqual(o.e, null);
  assert.strictEqual(o.f, null);
  assert.strictEqual(o.g, 'hi: there # not a comment');
  assert.strictEqual(o.h, 'plain text');
});

test('nested mappings via indentation', function () {
  const o = yaml.parse('root:\n  a: 1\n  b:\n    c: two\ntop: x');
  assert.deepStrictEqual(o, { root: { a: 1, b: { c: 'two' } }, top: 'x' });
});

test('block sequences of scalars and of inline mappings', function () {
  const o = yaml.parse([
    'list:',
    '  - one',
    '  - two',
    'servers:',
    '  - name: relay',
    '    url: https://x.y',
    '    enabled: false',
    '  - name: spare',
    '    url: https://z.w',
  ].join('\n'));
  assert.deepStrictEqual(o.list, ['one', 'two']);
  assert.strictEqual(o.servers.length, 2);
  assert.deepStrictEqual(o.servers[0], { name: 'relay', url: 'https://x.y', enabled: false });
  assert.strictEqual(o.servers[1].name, 'spare');
});

test('flow collections [..] and {..} with nesting', function () {
  const o = yaml.parse('nums: [1, 2, 3]\nmap: {k: v, n: 2}\nnested: [a, [b, c]]');
  assert.deepStrictEqual(o.nums, [1, 2, 3]);
  assert.deepStrictEqual(o.map, { k: 'v', n: 2 });
  assert.deepStrictEqual(o.nested, ['a', ['b', 'c']]);
});

test('comments (full-line and trailing) are stripped; # inside quotes kept', function () {
  const o = yaml.parse('# header\nkey: value  # trailing\nurl: "http://x/#frag"');
  assert.strictEqual(o.key, 'value');
  assert.strictEqual(o.url, 'http://x/#frag');
});

test('empty / whitespace input yields null, never throws', function () {
  assert.strictEqual(yaml.parse(''), null);
  assert.strictEqual(yaml.parse('\n\n# only a comment\n'), null);
  assert.strictEqual(yaml.parse(null), null);
});

test('document markers are ignored', function () {
  assert.deepStrictEqual(yaml.parse('---\na: 1\n...'), { a: 1 });
});

test('a top-level sequence parses to an array', function () {
  assert.deepStrictEqual(yaml.parse('- a\n- b\n- c'), ['a', 'b', 'c']);
});

// SECURITY (review): a hostile __proto__ key must not touch any prototype; deep nesting must not crash.
test('__proto__ key becomes an own property, not a prototype mutation', function () {
  const o = yaml.parse('__proto__: pwned\nok: 1');
  assert.strictEqual(({}).pwned, undefined, 'Object.prototype not polluted');
  assert.strictEqual(o.ok, 1);
  assert.ok(Object.prototype.hasOwnProperty.call(o, '__proto__'), '__proto__ stored as an own prop');
  assert.notStrictEqual(Object.getPrototypeOf(o), null, 'the parsed object keeps a normal prototype');
});
test('deeply-nested YAML is depth-capped, never a stack overflow', function () {
  let deep = ''; for (let i = 0; i < 600; i++) deep += ' '.repeat(i) + 'k:\n';
  assert.doesNotThrow(function () { yaml.parse(deep); });
});
