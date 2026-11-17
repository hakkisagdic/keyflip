// exec.run — the single synchronous process runner every adapter shells through. It must never
// throw: callers branch on code/stdout/stderr/timedOut, so a missing binary or a timeout has to come
// back as data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { tmpdir } from './helpers.js';
import * as exec from '../src/exec.js';

test('run captures stdout, passes input, and reports exit 0', function () {
  const r = exec.run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], 'hello\n');
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'hello\n');
  assert.equal(r.stderr, '');
  assert.equal(r.error, null);
  assert.equal(r.timedOut, false);
});

test('run returns a non-zero code and stderr without throwing', function () {
  const r = exec.run(process.execPath, ['-e', 'process.stderr.write("boom"); process.exit(3)']);
  assert.equal(r.code, 3);
  assert.equal(r.stderr, 'boom');
  assert.equal(r.error, null);
});

test('run treats a missing binary as code 1 with an error object', function () {
  const r = exec.run('keyflip-definitely-not-a-real-binary-9f2c', []);
  assert.equal(r.code, 1);
  assert.ok(r.error, 'spawn error is surfaced');
  assert.equal(r.timedOut, false);
});

test('run reports a timeout distinctly and never throws', function () {
  const r = exec.run(process.execPath, ['-e', 'setTimeout(function () {}, 5000)'], null, { timeoutMs: 100 });
  assert.equal(r.code, 1);
  assert.equal(r.timedOut, true);
  assert.ok(r.error && r.error.code === 'ETIMEDOUT');
});

test('run honors cwd and env overrides', function () {
  const dir = tmpdir();
  const r = exec.run(
    process.execPath,
    ['-e', 'console.log(process.cwd()); console.log(process.env.KEYFLIP_EXEC_TEST)'],
    null,
    { cwd: dir, env: Object.assign({}, process.env, { KEYFLIP_EXEC_TEST: 'sentinel' }) },
  );
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split(/\r?\n/);
  assert.equal(fs.realpathSync(lines[0]), fs.realpathSync(dir));
  assert.equal(lines[1], 'sentinel');
});

test('run passes a file path that requires no shell (spaces are safe)', function () {
  const dir = tmpdir();
  const file = path.join(dir, 'a file with spaces.txt');
  fs.writeFileSync(file, 'ok');
  const r = exec.run(process.execPath, [
    '-e',
    'console.log(require("fs").readFileSync(process.argv[1], "utf8"))',
    file,
  ]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), 'ok');
});

test('KEYFLIP_KEYCHAIN_FILE is ignored with the guard off unless it is a keychain file under the temp dir', function () {
  const prev = {
    f: process.env.KEYFLIP_KEYCHAIN_FILE,
    o: process.env.KEYFLIP_TEST_OFFLINE,
    n: process.env.NODE_TEST_CONTEXT,
  };
  try {
    process.env.KEYFLIP_KEYCHAIN_FILE = '/Users/someone/Library/Keychains/real.keychain-db';
    delete process.env.KEYFLIP_TEST_OFFLINE;
    delete process.env.NODE_TEST_CONTEXT;
    const a = exec.withKeychainFile('/usr/bin/security', ['find-generic-password', '-s', 'x']);
    assert.deepEqual(a, ['find-generic-password', '-s', 'x']);
    const i = exec.withKeychainFileInput('/usr/bin/security', ['-i'], 'find-generic-password -s "x"\n');
    assert.equal(i, 'find-generic-password -s "x"\n');
    const ok = path.join(tmpdir(), 'k.keychain-db');
    fs.writeFileSync(ok, '');
    process.env.KEYFLIP_KEYCHAIN_FILE = ok;
    assert.deepEqual(exec.withKeychainFile('/usr/bin/security', ['find-generic-password']), [
      'find-generic-password',
      ok,
    ]);
    // guard active: the variable is honoured
    process.env.KEYFLIP_TEST_OFFLINE = '1';
    process.env.KEYFLIP_KEYCHAIN_FILE = '/elsewhere/z.keychain-db';
    assert.deepEqual(exec.withKeychainFile('/usr/bin/security', ['find-generic-password']), [
      'find-generic-password',
      '/elsewhere/z.keychain-db',
    ]);
  } finally {
    for (const [k, v] of [
      ['KEYFLIP_KEYCHAIN_FILE', prev.f],
      ['KEYFLIP_TEST_OFFLINE', prev.o],
      ['NODE_TEST_CONTEXT', prev.n],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
