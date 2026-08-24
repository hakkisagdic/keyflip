// Regression tests for the 8 confirmed review findings (data-loss class).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as provider from '../src/provider.js';
import * as mcpreg from '../src/mcpreg.js';
import * as desktopgw from '../src/desktopgw.js';
import * as backup from '../src/backup.js';
import * as settings from '../src/settings.js';
import { makeCtx, writeClaude } from './helpers.js';
import * as _sync from '../src/sync.js';
import * as _core from '../src/core.js';

function withSettings(ctx) {
  ctx.claudeSettingsPath = path.join(ctx.home, '.claude', 'settings.json');
  return ctx;
}
function writeCorrupt(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{ "theme":"dark", }');
} // trailing comma

// #1 (settings.js) — corrupt settings.json is NOT clobbered
test('provider.use refuses to run on a corrupt settings.json (no data loss)', function () {
  const ctx = withSettings(makeCtx());
  writeCorrupt(ctx.claudeSettingsPath);
  const before = fs.readFileSync(ctx.claudeSettingsPath, 'utf8');
  provider.add(ctx, 'p', { baseUrl: 'https://p/v1', key: 'k' });
  assert.throws(function () {
    provider.use(ctx, 'p');
  }, /not valid JSON/);
  assert.strictEqual(fs.readFileSync(ctx.claudeSettingsPath, 'utf8'), before); // untouched
});

// #4 (mcpreg desktop) — corrupt desktop config is not wiped
test('mcpreg desktop enable refuses a corrupt claude_desktop_config.json', function () {
  const ctx = makeCtx();
  ctx.appDataDir = path.join(ctx.home, 'Claude');
  const p = path.join(ctx.appDataDir, 'claude_desktop_config.json');
  writeCorrupt(p);
  const before = fs.readFileSync(p, 'utf8');
  mcpreg.add(ctx, 'x', { command: 'node', args: ['s.js'] });
  assert.throws(function () {
    mcpreg.setEnabled(ctx, 'x', 'claude-desktop', true);
  }, /not valid JSON/);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), before);
});

// #5 (desktopgw) — corrupt desktop config not clobbered; txn restores
test('desktopgw.use rolls back and preserves a corrupt desktop config', function () {
  const ctx = makeCtx();
  ctx.appDataDir = path.join(ctx.home, 'Library', 'Application Support', 'Claude');
  const p = path.join(ctx.appDataDir, 'claude_desktop_config.json');
  writeCorrupt(p);
  const before = fs.readFileSync(p, 'utf8');
  provider.add(ctx, 'gw', { baseUrl: 'https://gw/v1' });
  assert.throws(function () {
    desktopgw.use(ctx, 'gw');
  }, /not valid JSON/);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), before);
});

// #3 (backup restore) — restoring the oldest backup with a full retention set
test('restoring the oldest backup does not prune it away (no silent 0-file restore)', function () {
  const ctx = makeCtx();
  const alice = path.join(ctx.configDir, 'alice.json');
  let n = 0;
  ctx.now = function () {
    return '2026-07-02T12:00:' + String(n++).padStart(2, '0') + '.000Z';
  };
  // 10 backups (fills the default retention), each with a distinct marker
  for (let i = 0; i < 10; i++) {
    fs.mkdirSync(ctx.configDir, { recursive: true });
    fs.writeFileSync(alice, 'gen' + i);
    backup.create(ctx);
  }
  const list = backup.list(ctx);
  assert.strictEqual(list.length, 10);
  const oldest = list.length; // index of the oldest in the 1-based list
  fs.writeFileSync(alice, 'CURRENT');
  const r = backup.restore(ctx, oldest);
  assert.ok(r.files > 0); // real restore, not a phantom success
  assert.strictEqual(fs.readFileSync(alice, 'utf8'), 'gen0'); // oldest content actually restored
});

// #6 (backup secret file) — a stray root-level credential file is never copied
test('backup excludes credential-shaped files at the config root', function () {
  const ctx = makeCtx();
  fs.mkdirSync(ctx.configDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.configDir, 'alice.json'), '{"name":"alice"}');
  fs.writeFileSync(path.join(ctx.configDir, '.credentials.json'), 'SECRET');
  fs.writeFileSync(path.join(ctx.configDir, 'legacy.cred'), 'SECRET2');
  const b = backup.create(ctx);
  assert.ok(fs.existsSync(path.join(b.path, 'alice.json')));
  assert.strictEqual(fs.existsSync(path.join(b.path, '.credentials.json')), false);
  assert.strictEqual(fs.existsSync(path.join(b.path, 'legacy.cred')), false);
});

// #8 medium — two backups in the same second don't collapse
test('two backups within the same second get distinct dirs', function () {
  const ctx = makeCtx();
  ctx.now = function () {
    return '2026-07-02T12:00:00.000Z';
  }; // fixed second
  fs.mkdirSync(ctx.configDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.configDir, 'a.json'), '1');
  const b1 = backup.create(ctx, { keep: 100 });
  const b2 = backup.create(ctx, { keep: 100 });
  assert.notStrictEqual(b1.name, b2.name);
  assert.strictEqual(backup.list(ctx).length, 2);
});

// #4 sync — apply writes a credential-capturing safety export before overwriting
test('sync.apply snapshots credentials (not just metadata) before overwriting', function () {
  const sync = _sync;
  const core = _core;
  const ctx = makeCtx();
  writeClaude(ctx, { oauthAccount: { emailAddress: 'a@x.com' }, userID: 'u' });
  ctx.store.setLive('{"claudeAiOauth":{"accessToken":"OLD-TOKEN"}}');
  core.addCurrent(ctx);
  const pulled = {
    _bundle: {
      format: 'keyflip-export',
      version: 1,
      accounts: [{ name: 'a', email: 'a@x.com', cliCredentials: '{"claudeAiOauth":{"accessToken":"NEW"}}' }],
    },
  };
  sync.apply(ctx, pulled, { force: true });
  // a pre-sync export containing the OLD token must exist (recoverable)
  const dir = path.join(ctx.configDir, 'pre-sync-backups');
  const files = fs.readdirSync(dir);
  assert.ok(files.length >= 1);
  assert.match(fs.readFileSync(path.join(dir, files[0]), 'utf8'), /OLD-TOKEN/);
});

// deepMerge proto guard
test('deepMerge ignores __proto__ (no prototype pollution)', function () {
  const r = settings.deepMerge({}, JSON.parse('{"__proto__":{"polluted":1},"ok":2}'));
  assert.strictEqual({}.polluted, undefined);
  assert.strictEqual(r.ok, 2);
});
