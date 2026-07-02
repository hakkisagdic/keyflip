'use strict';
// Contract tests for KeychainStore using an injected runner — asserts the exact
// security invocations (argv/stdin) without touching a real keychain.
const test = require('node:test');
const assert = require('node:assert');
const KeychainStore = require('../src/stores/keychain');

function fakeRunner(script) {
  const calls = [];
  const fn = function (cmd, args, input, opts) {
    calls.push({ cmd: cmd, args: args, input: input, opts: opts });
    return script(cmd, args, input) || { code: 0, stdout: '', stderr: '', error: null, timedOut: false };
  };
  fn.calls = calls;
  return fn;
}

test('reads use /usr/bin/security find-generic-password with -w and a timeout', function () {
  const r = fakeRunner(function () { return { code: 0, stdout: 'SECRET\n', stderr: '', timedOut: false }; });
  const s = new KeychainStore({ account: 'me', runner: r });
  assert.strictEqual(s.getLive(), 'SECRET');
  const c = r.calls[0];
  assert.strictEqual(c.cmd, '/usr/bin/security');
  assert.deepStrictEqual(c.args, ['find-generic-password', '-s', 'Claude Code-credentials', '-a', 'me', '-w']);
  assert.ok(c.opts && c.opts.timeoutMs > 0, 'timeout set');
});

test('exit 44 (not found) reads as null; other failures throw EKEYCHAIN', function () {
  const notFound = new KeychainStore({ account: 'me', runner: fakeRunner(function () { return { code: 44, stdout: '', stderr: '' }; }) });
  assert.strictEqual(notFound.getLive(), null);

  const locked = new KeychainStore({ account: 'me', runner: fakeRunner(function () { return { code: 36, stdout: '', stderr: 'SecKeychainSearchCopyNext' }; }) });
  assert.throws(function () { locked.getLive(); }, function (e) { return e.code === 'EKEYCHAIN'; });

  const hung = new KeychainStore({ account: 'me', runner: fakeRunner(function () { return { code: 1, stdout: '', stderr: '', timedOut: true }; }) });
  assert.throws(function () { hung.getLive(); }, /timed out/);
});

test('writes go through `security -i` stdin as hex — the secret is never in argv', function () {
  const r = fakeRunner(function () { return { code: 0, stdout: '', stderr: '' }; });
  const s = new KeychainStore({ account: 'me', runner: r });
  s.setLive('{"top":"secret"}');
  const c = r.calls[0];
  assert.deepStrictEqual(c.args, ['-i']);                       // no secret in argv
  assert.match(c.input, /^add-generic-password -U -s "Claude Code-credentials" -a "me" -X [0-9a-f]+\n$/);
  const hex = /-X ([0-9a-f]+)/.exec(c.input)[1];
  assert.strictEqual(Buffer.from(hex, 'hex').toString('utf8'), '{"top":"secret"}');
});

test('a normal-size credential always goes through stdin (never argv), even at a few KB', function () {
  const r = fakeRunner(function () { return { code: 0, stdout: '', stderr: '' }; });
  const s = new KeychainStore({ account: 'me', runner: r });
  const realistic = 'x'.repeat(4000); // ~4 KB — bigger than any real OAuth blob
  s.setLive(realistic);
  const c = r.calls[0];
  assert.deepStrictEqual(c.args, ['-i']);                 // stdin path, secret not in argv
  assert.match(c.input, /-X [0-9a-f]+\n$/);
});

test('an implausibly large blob is refused, never leaked to argv', function () {
  const r = fakeRunner(function () { return { code: 0, stdout: '', stderr: '' }; });
  const s = new KeychainStore({ account: 'me', runner: r });
  assert.throws(function () { s.setLive('x'.repeat(200000)); }, /implausibly large/);
  assert.strictEqual(r.calls.length, 0); // security never invoked with the secret
});

test('write failures throw EKEYCHAIN with the stderr detail', function () {
  const s = new KeychainStore({ account: 'me', runner: fakeRunner(function () { return { code: 51, stdout: '', stderr: 'User interaction is not allowed.' }; }) });
  assert.throws(function () { s.setLive('x'); }, /User interaction is not allowed/);
});
