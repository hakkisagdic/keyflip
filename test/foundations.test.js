// Batch A foundations: atomicWrite mode/sorted-JSON (#9), txn rollback (#5),
// config-dir resolution (#2), per-resource locks (#8).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as fsutil from '../src/fsutil.js';
import * as txn from '../src/txn.js';
import * as lock from '../src/lock.js';
import { createContext } from '../src/context.js';
import { tmpdir } from './helpers.js';

// ---- #9 atomicWrite ----
test('atomicWrite preserves an existing file mode when none is given', function (t) {
  if (process.platform === 'win32') return t.skip('POSIX mode bits');
  const f = path.join(tmpdir(), 'x.json');
  fsutil.atomicWrite(f, 'a', 0o644);
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o644);
  fsutil.atomicWrite(f, 'b');                         // no mode -> preserve 0644
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o644);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'b');
});

test('atomicWrite defaults a NEW file to 0600', function (t) {
  if (process.platform === 'win32') return t.skip('POSIX mode bits');
  const f = path.join(tmpdir(), 'new.json');
  fsutil.atomicWrite(f, 'hi');
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
});

test('writeJsonStable emits recursively key-sorted, byte-identical JSON', function () {
  const a = path.join(tmpdir(), 'a.json');
  const b = path.join(tmpdir(), 'b.json');
  fsutil.writeJsonStable(a, { b: 1, a: { z: 2, y: 3 } });
  fsutil.writeJsonStable(b, { a: { y: 3, z: 2 }, b: 1 });   // same logical, different key order
  assert.strictEqual(fs.readFileSync(a, 'utf8'), fs.readFileSync(b, 'utf8'));
  assert.match(fs.readFileSync(a, 'utf8'), /^\{\n  "a": \{\n    "y": 3,\n    "z": 2/);
});

// ---- #5 txn rollback ----
test('withRollback restores every file (recreate + delete) on failure', function () {
  const d = tmpdir();
  const keep = path.join(d, 'keep.json');
  const created = path.join(d, 'created.json');
  fs.writeFileSync(keep, 'ORIGINAL');
  assert.throws(function () {
    txn.withRollback([keep, created], function () {
      fs.writeFileSync(keep, 'MUTATED');
      fs.writeFileSync(created, 'NEW');
      throw new Error('boom');
    });
  }, /boom/);
  assert.strictEqual(fs.readFileSync(keep, 'utf8'), 'ORIGINAL'); // restored
  assert.strictEqual(fs.existsSync(created), false);            // absent again
});

test('withRollback keeps changes on success', function () {
  const d = tmpdir();
  const f = path.join(d, 'ok.json');
  txn.withRollback([f], function () { fs.writeFileSync(f, 'DONE'); });
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'DONE');
});

// ---- #2 config-dir resolution ----
test('CLAUDE_CONFIG_DIR relocates Claude config/credentials/settings paths', function () {
  const home = tmpdir();
  const alt = path.join(home, 'alt', '.claude');
  const ctx = createContext({ home: home, platform: 'linux', claudeDir: alt, store: { type: 'memory' } });
  assert.strictEqual(ctx.credsFilePath, path.join(alt, '.credentials.json'));
  assert.strictEqual(ctx.claudeSettingsPath, path.join(alt, 'settings.json'));
  // .claude.json goes in the PARENT of a *.../.claude dir (like a real home)
  assert.strictEqual(ctx.claudeConfigPath, path.join(home, 'alt', '.claude.json'));
});

test('a non-.claude config dir keeps .claude.json inside it', function () {
  const home = tmpdir();
  const alt = path.join(home, 'custom');
  const ctx = createContext({ home: home, platform: 'linux', claudeDir: alt, store: { type: 'memory' } });
  assert.strictEqual(ctx.claudeConfigPath, path.join(alt, '.claude.json'));
});

test('appDataDir defaults to the Claude Electron userData dir per platform (Linux now set, was null)', function () {
  const home = tmpdir();
  assert.strictEqual(
    createContext({ home: home, platform: 'darwin', store: { type: 'memory' } }).appDataDir,
    path.join(home, 'Library', 'Application Support', 'Claude'));
  const savedXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  try {
    assert.strictEqual(
      createContext({ home: home, platform: 'linux', store: { type: 'memory' } }).appDataDir,
      path.join(home, '.config', 'Claude'), 'Linux → ~/.config/Claude (enables desktop app-auth)');
    process.env.XDG_CONFIG_HOME = path.join(home, 'xdg');
    assert.strictEqual(
      createContext({ home: home, platform: 'linux', store: { type: 'memory' } }).appDataDir,
      path.join(home, 'xdg', 'Claude'), 'Linux honors $XDG_CONFIG_HOME');
  } finally {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
  }
  assert.strictEqual(
    createContext({ home: home, platform: 'freebsd', store: { type: 'memory' } }).appDataDir, null,
    'unsupported platforms stay null');
});

// ---- #8 per-resource locks ----
test('different resources lock independently; same resource is exclusive', async function () {
  const d = tmpdir();
  const cli = await lock.acquire(d, { resource: 'claude-cli' });
  // a different resource can be taken concurrently
  const app = await lock.acquire(d, { resource: 'claude-desktop', timeoutMs: 300 });
  assert.ok(fs.existsSync(path.join(d, '.lock-claude-cli')));
  assert.ok(fs.existsSync(path.join(d, '.lock-claude-desktop')));
  // the SAME resource is blocked
  await assert.rejects(function () { return lock.acquire(d, { resource: 'claude-cli', timeoutMs: 200 }); },
    function (e) { return e.code === 'ELOCKED'; });
  cli.release(); app.release();
});
