'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const lock = require('../src/lock');
const { tmpdir } = require('./helpers');

test('acquire creates the lock and release removes it', async function () {
  const dir = tmpdir();
  const l = await lock.acquire(dir);
  assert.ok(fs.existsSync(path.join(dir, '.lock')));
  l.release();
  assert.ok(!fs.existsSync(path.join(dir, '.lock')));
});

test('a held lock blocks a second acquire (ELOCKED after timeout)', async function () {
  const dir = tmpdir();
  const l = await lock.acquire(dir);
  await assert.rejects(
    function () { return lock.acquire(dir, { timeoutMs: 300 }); },
    function (e) { return e.code === 'ELOCKED'; }
  );
  l.release();
});

test('a stale lock (dead pid) is reclaimed', async function () {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, '.lock'), JSON.stringify({ pid: 999999, at: Date.now() }));
  const l = await lock.acquire(dir, { timeoutMs: 1000 });
  l.release();
});

test('a stale lock (too old) is reclaimed even if pid looks alive', async function () {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, '.lock'), JSON.stringify({ pid: process.pid, at: Date.now() - 120000 }));
  const l = await lock.acquire(dir, { timeoutMs: 1000, staleMs: 60000 });
  l.release();
});

test('an unreadable lock file is treated as stale', async function () {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, '.lock'), 'not json');
  const l = await lock.acquire(dir, { timeoutMs: 1000 });
  l.release();
});

test('a lock held by a LIVE process within staleMs is honored (not reclaimed)', async function () {
  const dir = tmpdir();
  // our own (alive) pid, recent timestamp -> must be honored
  fs.writeFileSync(path.join(dir, '.lock'), JSON.stringify({ pid: process.pid, at: Date.now(), token: 'x' }));
  await assert.rejects(
    function () { return lock.acquire(dir, { timeoutMs: 200, staleMs: 5 * 60 * 1000 }); },
    function (e) { return e.code === 'ELOCKED'; }
  );
});

test('a lock stuck past staleMs is reclaimed as a deadlock safety net', async function () {
  const dir = tmpdir();
  // alive pid but ancient (> staleMs) -> presumed stuck / pid-reused, reclaimable
  fs.writeFileSync(path.join(dir, '.lock'), JSON.stringify({ pid: process.pid, at: Date.now() - 10 * 60 * 1000, token: 'x' }));
  const l = await lock.acquire(dir, { timeoutMs: 500, staleMs: 5 * 60 * 1000 });
  l.release();
});

test('release() only deletes the lock if it still carries our token (no cross-delete)', async function () {
  const dir = tmpdir();
  const a = await lock.acquire(dir);
  // Simulate a reclaim: a different owner overwrites the lock file.
  fs.writeFileSync(path.join(dir, '.lock'), JSON.stringify({ pid: process.pid, at: Date.now(), token: 'someone-else' }));
  a.release();                                   // must NOT delete the new owner's lock
  assert.ok(fs.existsSync(path.join(dir, '.lock')), "another owner's lock survives our release");
  const info = JSON.parse(fs.readFileSync(path.join(dir, '.lock'), 'utf8'));
  assert.strictEqual(info.token, 'someone-else');
});
