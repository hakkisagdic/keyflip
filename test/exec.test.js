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
