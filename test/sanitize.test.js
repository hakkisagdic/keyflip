'use strict';
const test = require('node:test');
const assert = require('node:assert');
const profiles = require('../src/profiles');

test('sanitizeName derives a safe name from the email local-part', function () {
  assert.strictEqual(profiles.sanitizeName('alice@example.com'), 'alice');
  assert.strictEqual(profiles.sanitizeName('Bob.Smith@Work.CO'), 'bob.smith');
  assert.strictEqual(profiles.sanitizeName('weird+tag@x.com'), 'weird-tag');
  assert.strictEqual(profiles.sanitizeName('foo@bar'), 'foo');
});

test('sanitizeName never returns an empty or unsafe name', function () {
  assert.strictEqual(profiles.sanitizeName('@only-domain.com'), 'account');
  assert.strictEqual(profiles.sanitizeName(''), 'account');
  assert.strictEqual(profiles.sanitizeName('+++@x.com'), 'account');
  assert.ok(profiles.NAME_RE.test(profiles.sanitizeName('a.b_c-d@x.com')));
});

test('isValidName rejects names with disallowed characters', function () {
  assert.ok(profiles.isValidName('alice'));
  assert.ok(profiles.isValidName('a.b-c_1'));
  assert.ok(!profiles.isValidName('has space'));
  assert.ok(!profiles.isValidName('slash/name'));
  assert.ok(!profiles.isValidName(''));
});
