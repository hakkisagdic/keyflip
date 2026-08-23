// Tests for the guided-capture wizard's detection helpers (src/onboard.js) and
// that `keyflip setup` refuses non-interactively. The interactive loop itself is
// keyboard/poll driven and covered by exercising its building blocks here.
import test from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { makeCtx, writeClaude } from './helpers.js';
import * as onboard from '../src/onboard.js';
import * as profiles from '../src/profiles.js';
import _child_process from 'child_process';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('capturedEmails collects saved profile emails, lowercased', function () {
  const ctx = makeCtx();
  profiles.write(ctx.configDir, { name: 'work', email: 'Work@X.com' });
  profiles.write(ctx.configDir, { name: 'home', email: 'home@x.com' });
  const s = onboard.capturedEmails(ctx);
  assert.ok(s.has('work@x.com'));
  assert.ok(s.has('home@x.com'));
  assert.strictEqual(s.size, 2);
});

test('snapshotLogins reads the current CLI login; app is null off-macOS', function () {
  const ctx = makeCtx(); // no appDataDir
  writeClaude(ctx, { oauthAccount: { emailAddress: 'a@x.com' }, userID: 'u1' });
  const s = onboard.snapshotLogins(ctx);
  assert.strictEqual(s.cli, 'a@x.com');
  assert.strictEqual(s.app, null);
});

test('firstNewLogin flags an uncaptured login and stays quiet once it is saved', function () {
  const ctx = makeCtx();
  writeClaude(ctx, { oauthAccount: { emailAddress: 'new@x.com' }, userID: 'u1' });
  assert.deepStrictEqual(onboard.firstNewLogin(ctx, new Set()), { surface: 'CLI', email: 'new@x.com' });
  // case-insensitive: an already-saved account is not "new"
  assert.strictEqual(onboard.firstNewLogin(ctx, new Set(['NEW@x.com'.toLowerCase()])), null);
});

test('firstNewLogin returns null when signed out', function () {
  const ctx = makeCtx();
  writeClaude(ctx, {}); // no oauthAccount
  assert.strictEqual(onboard.firstNewLogin(ctx, new Set()), null);
});

test('`keyflip setup` refuses when stdin is not a TTY (points at add)', function () {
  const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');
  const r = _child_process.spawnSync(process.execPath, [BIN, 'setup'], { encoding: 'utf8', input: '' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /interactive wizard/);
});

test('`keyflip onboard` refuses when stdin is not a TTY', function () {
  const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');
  const r = _child_process.spawnSync(process.execPath, [BIN, 'onboard'], { encoding: 'utf8', input: '' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /interactive wizard/);
});
