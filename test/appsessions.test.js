'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { consolidate, pruneBackups } = require('../src/appsessions');
const { tmpdir } = require('./helpers');

// Fake Claude desktop app store with two accounts (A active in ~/.claude.json,
// but consolidate unions all folders regardless of which account is "active").
function setup() {
  const home = tmpdir();
  const appDataDir = path.join(home, 'Library', 'Application Support', 'Claude');
  const store = path.join(appDataDir, 'claude-code-sessions');
  const A = 'acctA', OA = 'orgA', B = 'acctB', OB = 'orgB';
  fs.mkdirSync(path.join(store, A, OA), { recursive: true });
  fs.mkdirSync(path.join(store, B, OB), { recursive: true });
  fs.writeFileSync(path.join(store, A, OA, 'local_1.json'), JSON.stringify({ sessionId: 'local_1', cliSessionId: 'cs1', title: 'in-A' }));
  fs.writeFileSync(path.join(store, B, OB, 'local_2.json'), JSON.stringify({ sessionId: 'local_2', cliSessionId: 'cs2', title: 'in-B' }));
  const ctx = {
    home: home, platform: 'darwin', appDataDir: appDataDir,
    configDir: path.join(home, '.config', 'ccswitch'),
    now: function () { return '2026-01-01T00:00:00.000Z'; },
  };
  return { ctx: ctx, store: store, A: A, OA: OA, B: B, OB: OB };
}

test('consolidate unions sessions into every account folder', function () {
  const s = setup();
  const r = consolidate(s.ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.merged, 2); // cs2 -> A, cs1 -> B
  assert.ok(fs.existsSync(path.join(s.store, s.A, s.OA, 'local_2.json')), 'A now has B\'s session');
  assert.ok(fs.existsSync(path.join(s.store, s.B, s.OB, 'local_1.json')), 'B now has A\'s session');
});

test('consolidate is idempotent', function () {
  const s = setup();
  consolidate(s.ctx);
  const r2 = consolidate(s.ctx);
  assert.strictEqual(r2.merged, 0);
});

test('consolidate dedupes by cliSessionId (no duplicate pointers)', function () {
  const s = setup();
  // B already has cs1 under a different local id
  fs.writeFileSync(path.join(s.store, s.B, s.OB, 'local_9.json'), JSON.stringify({ sessionId: 'local_9', cliSessionId: 'cs1' }));
  const r = consolidate(s.ctx);
  assert.strictEqual(r.merged, 1); // only cs2 -> A; B already has cs1 and cs2
  assert.ok(!fs.existsSync(path.join(s.store, s.A, s.OA, 'local_9.json')), 'no duplicate cs1 pointer added to A');
});

test('consolidate backs up the store when it merges', function () {
  const s = setup();
  const r = consolidate(s.ctx);
  assert.ok(r.backup && fs.existsSync(r.backup), 'backup created');
  assert.ok(fs.existsSync(path.join(r.backup, s.A, s.OA, 'local_1.json')), 'backup has originals');
});

test('consolidate does not back up when there is nothing to merge', function () {
  const s = setup();
  consolidate(s.ctx);
  const bdir = path.join(s.ctx.configDir, 'backups');
  const before = fs.existsSync(bdir) ? fs.readdirSync(bdir).length : 0;
  const r2 = consolidate(s.ctx);
  assert.strictEqual(r2.merged, 0);
  assert.strictEqual(r2.backup, null);
  const after = fs.existsSync(bdir) ? fs.readdirSync(bdir).length : 0;
  assert.strictEqual(after, before);
});

test('consolidate is a no-op when there is only one account', function () {
  const s = setup();
  fs.rmSync(path.join(s.store, s.B), { recursive: true, force: true });
  const r = consolidate(s.ctx);
  assert.strictEqual(r.merged, 0);
});

test('consolidate is a no-op when there is no app store (non-macOS)', function () {
  const s = setup();
  s.ctx.appDataDir = null;
  const r = consolidate(s.ctx);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.merged, 0);
});

test('pruneBackups keeps only the last N backups', function () {
  const dir = tmpdir();
  const bdir = path.join(dir, 'backups');
  fs.mkdirSync(bdir, { recursive: true });
  for (let i = 1; i <= 8; i++) fs.mkdirSync(path.join(bdir, 'claude-code-sessions-2026-01-0' + i + 'T00-00-00'));
  pruneBackups(dir, 5);
  const left = fs.readdirSync(bdir).sort();
  assert.strictEqual(left.length, 5);
  assert.strictEqual(left[0], 'claude-code-sessions-2026-01-04T00-00-00');
});
