'use strict';
// Tests for J3's settings dot-path helpers (src/settings.js getPath/setPath).
const test = require('node:test');
const assert = require('node:assert');
const settings = require('../src/settings');

test('getPath/setPath handle top-level and nested dot-paths', function () {
  const o = { model: 'opus', env: { A: '1' } };
  assert.strictEqual(settings.getPath(o, 'model'), 'opus');
  assert.strictEqual(settings.getPath(o, 'env.A'), '1');
  assert.strictEqual(settings.getPath(o, 'env.missing'), undefined);
  settings.setPath(o, 'env.B', 'two');
  assert.strictEqual(o.env.B, 'two');
  settings.setPath(o, 'permissions.allow', ['Bash']);
  assert.deepStrictEqual(o.permissions.allow, ['Bash']);
  settings.setPath(o, 'model', undefined); // unset
  assert.strictEqual('model' in o, false);
});

test('setPath refuses prototype-pollution keys', function () {
  const o = {};
  settings.setPath(o, '__proto__.polluted', 'yes');
  settings.setPath(o, 'a.constructor.x', 'yes');
  assert.strictEqual(({}).polluted, undefined, 'Object prototype not polluted');
  assert.strictEqual(o.__proto__.polluted, undefined);
});

test('setPath overwrites a non-object intermediate rather than crashing', function () {
  const o = { env: 'not-an-object' };
  settings.setPath(o, 'env.KEY', 'v');
  assert.deepStrictEqual(o.env, { KEY: 'v' });
});
