'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { consolidate, pruneBackups } = require('../src/appsessions');
const { tmpdir } = require('./helpers');

// Build a fake Claude desktop app store with two accounts.
function setup() {
  const home = tmpdir();
  const appDataDir = path.join(home, 'Library', 'Application Support', 'Claude');
  const store = path.join(appDataDir, 'claude-code-sessions');
  const A = 'acctA', OA = 'orgA', B = 'acctB', OB = 'orgB';
  fs.mkdirSync(path.join(store, A, OA), { recursive: true });
  fs.mkdirSync(path.join(store, B, OB), { recursive: true });
  fs.writeFileSync(path.join(store, A, OA, 'local_1.json'), JSON.stringify({ sessionId: 'local_1', cliSessionId: 'cs1', title: 'active-one' }));
  fs.writeFileSync(path.join(store, B, OB, 'local_2.json'), JSON.stringify({ sessionId: 'local_2', cliSessionId: 'cs2', title: 'other-one' }));
  const claudeConfigPath = path.join(home, '.claude.json');
  fs.writeFileSync(claudeConfigPath, JSON.stringify({ oauthAccount: { accountUuid: A, organizationUuid: OA, emailAddress: 'a@x.com' }, userID: 'u' }));
  const ctx = {
    home: home, platform: 'darwin', appDataDir: appDataDir,
    claudeConfigPath: claudeConfigPath, configDir: path.join(home, '.config', 'ccswitch'),
    now: function () { return '2026-01-01T00:00:00.000Z'; },
  };
  return { ctx: ctx, store: store, A: A, OA: OA };
}

test('consolidate copies other accounts\' Code sessions into the active account', function () {
  const s = setup();
  const r = consolidate(s.ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.merged, 1);
  assert.ok(fs.existsSync(path.join(s.store, s.A, s.OA, 'local_2.json')), 'other account session copied in');
});

test('consolidate is idempotent (dedupe by cliSessionId)', function () {
  const s = setup();
  consolidate(s.ctx);
  const r2 = consolidate(s.ctx);
  assert.strictEqual(r2.merged, 0);
});

test('consolidate backs up the store before modifying it', function () {
  const s = setup();
  const r = consolidate(s.ctx);
  assert.ok(r.backup && fs.existsSync(r.backup), 'backup dir exists');
  assert.ok(fs.existsSync(path.join(r.backup, s.A, s.OA, 'local_1.json')), 'backup contains the original files');
});

test('consolidate does not duplicate a session already present under the active account', function () {
  const s = setup();
  // account B also has cs1 (same underlying transcript) under a different local id
  fs.writeFileSync(path.join(s.store, 'acctB', 'orgB', 'local_9.json'), JSON.stringify({ sessionId: 'local_9', cliSessionId: 'cs1' }));
  const r = consolidate(s.ctx);
  // only local_2 (cs2) is new; local_9 (cs1) is a dup of the active account's cs1
  assert.strictEqual(r.merged, 1);
  assert.ok(!fs.existsSync(path.join(s.store, s.A, s.OA, 'local_9.json')));
});

test('consolidate is a no-op when there is no app store (non-macOS)', function () {
  const s = setup();
  s.ctx.appDataDir = null;
  const r = consolidate(s.ctx);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.merged, 0);
});

test('consolidate does not back up when there is nothing to merge', function () {
  const s = setup();
  consolidate(s.ctx); // first run merges cs2 and creates a backup
  const bdir = path.join(s.ctx.configDir, 'backups');
  const before = fs.existsSync(bdir) ? fs.readdirSync(bdir).length : 0;
  const r2 = consolidate(s.ctx); // nothing new -> no backup
  assert.strictEqual(r2.merged, 0);
  assert.strictEqual(r2.backup, null);
  const after = fs.existsSync(bdir) ? fs.readdirSync(bdir).length : 0;
  assert.strictEqual(after, before);
});

test('pruneBackups keeps only the last N backups', function () {
  const dir = tmpdir();
  const bdir = path.join(dir, 'backups');
  fs.mkdirSync(bdir, { recursive: true });
  for (let i = 1; i <= 8; i++) fs.mkdirSync(path.join(bdir, 'claude-code-sessions-2026-01-0' + i + 'T00-00-00'));
  pruneBackups(dir, 5);
  const left = fs.readdirSync(bdir).sort();
  assert.strictEqual(left.length, 5);
  assert.strictEqual(left[0], 'claude-code-sessions-2026-01-04T00-00-00'); // 1..3 pruned
});
