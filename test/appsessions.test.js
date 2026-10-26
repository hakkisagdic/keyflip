import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { consolidate, mergeStore, pruneBackups } from '../src/appsessions.js';
// backup behavior is a per-store concern -> test it on mergeStore directly.
function mergeCode(ctx) {
  return mergeStore(ctx, 'claude-code-sessions', 'claude-code-sessions-');
}
import { tmpdir } from './helpers.js';

// Fake Claude desktop app store with two accounts (A active in ~/.claude.json,
// but consolidate unions all folders regardless of which account is "active").
function setup() {
  const home = tmpdir();
  const appDataDir = path.join(home, 'Library', 'Application Support', 'Claude');
  const store = path.join(appDataDir, 'claude-code-sessions');
  const A = 'aaaaaaaa-0000-4000-8000-000000000001',
    OA = 'aaaaaaaa-0000-4000-8000-0000000000a1',
    B = 'bbbbbbbb-0000-4000-8000-000000000002',
    OB = 'bbbbbbbb-0000-4000-8000-0000000000b2';
  fs.mkdirSync(path.join(store, A, OA), { recursive: true });
  fs.mkdirSync(path.join(store, B, OB), { recursive: true });
  fs.writeFileSync(
    path.join(store, A, OA, 'local_1.json'),
    JSON.stringify({ sessionId: 'local_1', cliSessionId: 'cs1', title: 'in-A' }),
  );
  fs.writeFileSync(
    path.join(store, B, OB, 'local_2.json'),
    JSON.stringify({ sessionId: 'local_2', cliSessionId: 'cs2', title: 'in-B' }),
  );
  const ctx = {
    home: home,
    platform: 'darwin',
    appDataDir: appDataDir,
    configDir: path.join(home, '.config', 'keyflip'),
    now: function () {
      return '2026-01-01T00:00:00.000Z';
    },
  };
  return { ctx: ctx, store: store, A: A, OA: OA, B: B, OB: OB };
}

test('consolidate unions sessions into every account folder', function () {
  const s = setup();
  const r = consolidate(s.ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.merged, 2); // cs2 -> A, cs1 -> B
  assert.ok(fs.existsSync(path.join(s.store, s.A, s.OA, 'local_2.json')), "A now has B's session");
  assert.ok(fs.existsSync(path.join(s.store, s.B, s.OB, 'local_1.json')), "B now has A's session");
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
  fs.writeFileSync(
    path.join(s.store, s.B, s.OB, 'local_9.json'),
    JSON.stringify({ sessionId: 'local_9', cliSessionId: 'cs1' }),
  );
  const r = consolidate(s.ctx);
  assert.strictEqual(r.merged, 1); // only cs2 -> A; B already has cs1 and cs2
  assert.ok(!fs.existsSync(path.join(s.store, s.A, s.OA, 'local_9.json')), 'no duplicate cs1 pointer added to A');
});

test('consolidate backs up the store when it merges', function () {
  const s = setup();
  const r = mergeCode(s.ctx);
  assert.ok(r.backup && fs.existsSync(r.backup), 'backup created');
  assert.ok(fs.existsSync(path.join(r.backup, s.A, s.OA, 'local_1.json')), 'backup has originals');
});

test('consolidate does not back up when there is nothing to merge', function () {
  const s = setup();
  mergeCode(s.ctx);
  const bdir = path.join(s.ctx.configDir, 'backups');
  const before = fs.existsSync(bdir) ? fs.readdirSync(bdir).length : 0;
  const r2 = mergeCode(s.ctx);
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

test('consolidate ignores folders that are not accounts (skills-plugin)', function () {
  const s = setup();
  // The app keeps its own bookkeeping in the same store, laid out like an account folder:
  // <store>/skills-plugin/<orgUuid>/<accountUuid>/. It must be neither read nor written.
  const plugin = path.join(s.store, 'skills-plugin', s.OA);
  fs.mkdirSync(path.join(plugin, s.A), { recursive: true });
  fs.writeFileSync(
    path.join(plugin, 'local_7.json'),
    JSON.stringify({ sessionId: 'local_7', cliSessionId: 'cs7', title: 'stray' }),
  );
  const r = consolidate(s.ctx);
  assert.strictEqual(r.merged, 2); // cs2 -> A, cs1 -> B; nothing to or from skills-plugin
  assert.deepStrictEqual(fs.readdirSync(plugin).sort(), [s.A, 'local_7.json'].sort(), 'skills-plugin left untouched');
  assert.ok(!fs.existsSync(path.join(s.store, s.A, s.OA, 'local_7.json')), 'stray pointer not spread to accounts');
});

test('consolidate does not resurrect a session deleted in an account', function () {
  const s = setup();
  // The user deleted local_1 while signed in to B: the app left a tombstone there.
  fs.writeFileSync(path.join(s.store, s.B, s.OB, 'deleted_1'), '1791378056000');
  const r = consolidate(s.ctx);
  assert.strictEqual(r.merged, 1); // only cs2 -> A
  assert.ok(!fs.existsSync(path.join(s.store, s.B, s.OB, 'local_1.json')), 'deleted session stays deleted in B');
  assert.ok(fs.existsSync(path.join(s.store, s.A, s.OA, 'local_1.json')), 'A keeps its own copy');
});

// Two accounts can legitimately name DIFFERENT transcripts local_<same>.json. The old
// existsSync() guard dropped one of them forever; the merge must give the newcomer a
// transcript-derived filename instead.
test('consolidate keeps both sessions when accounts reuse the same filename', function () {
  const s = setup();
  fs.rmSync(path.join(s.store, s.A, s.OA, 'local_1.json'));
  fs.rmSync(path.join(s.store, s.B, s.OB, 'local_2.json'));
  fs.writeFileSync(
    path.join(s.store, s.A, s.OA, 'local_7.json'),
    JSON.stringify({ sessionId: 'local_7', cliSessionId: 'cs-A', title: 'A chat' }),
  );
  fs.writeFileSync(
    path.join(s.store, s.B, s.OB, 'local_7.json'),
    JSON.stringify({ sessionId: 'local_7', cliSessionId: 'cs-B', title: 'B chat' }),
  );
  const r = consolidate(s.ctx);
  assert.strictEqual(r.merged, 2);
  const aNames = fs.readdirSync(path.join(s.store, s.A, s.OA)).sort();
  const bNames = fs.readdirSync(path.join(s.store, s.B, s.OB)).sort();
  assert.deepStrictEqual(aNames, ['local_7.json', 'local_cs-B.json'].sort());
  assert.deepStrictEqual(bNames, ['local_7.json', 'local_cs-A.json'].sort());
  assert.strictEqual(cliIdOfTest(path.join(s.store, s.A, s.OA, 'local_cs-B.json')), 'cs-B');
  assert.strictEqual(cliIdOfTest(path.join(s.store, s.B, s.OB, 'local_cs-A.json')), 'cs-A');
});

test('a collision fallback still respects the tombstone for the transcript id', function () {
  const s = setup();
  fs.rmSync(path.join(s.store, s.A, s.OA, 'local_1.json'));
  fs.rmSync(path.join(s.store, s.B, s.OB, 'local_2.json'));
  fs.writeFileSync(
    path.join(s.store, s.A, s.OA, 'local_7.json'),
    JSON.stringify({ sessionId: 'local_7', cliSessionId: 'cs-A' }),
  );
  fs.writeFileSync(
    path.join(s.store, s.B, s.OB, 'local_7.json'),
    JSON.stringify({ sessionId: 'local_7', cliSessionId: 'cs-B' }),
  );
  fs.writeFileSync(path.join(s.store, s.B, s.OB, 'deleted_cs-A'), '1791378056000');
  const r = consolidate(s.ctx);
  assert.strictEqual(r.merged, 1); // only cs-B -> A
  assert.ok(!fs.existsSync(path.join(s.store, s.B, s.OB, 'local_cs-A.json')), 'tombstoned transcript stays gone');
});

test('consolidate unions the base app store with instance clone stores', function () {
  const s = setup();
  const base = path.join(s.ctx.home, '.keyflip-instances', 'claude', 'work');
  const userData = path.join(base, 'User Data');
  const C = 'cccccccc-0000-4000-8000-000000000003';
  const OC = 'cccccccc-0000-4000-8000-0000000000c3';
  const cloneStore = path.join(userData, 'claude-code-sessions');
  fs.mkdirSync(path.join(cloneStore, C, OC), { recursive: true });
  fs.writeFileSync(
    path.join(cloneStore, C, OC, 'local_3.json'),
    JSON.stringify({ sessionId: 'local_3', cliSessionId: 'cs3', title: 'in-clone' }),
  );

  const r = consolidate(s.ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.merged, 6); // each of the 3 folders is missing the other two sessions
  assert.strictEqual(r.instances, 1);
  assert.ok(fs.existsSync(path.join(cloneStore, C, OC, 'local_1.json')), 'clone gains the base sessions');
  assert.ok(fs.existsSync(path.join(s.store, s.A, s.OA, 'local_3.json')), 'base gains the clone session');
  assert.ok(fs.existsSync(path.join(s.store, s.B, s.OB, 'local_3.json')));
  const r2 = consolidate(s.ctx);
  assert.strictEqual(r2.merged, 0, 'second pass is idempotent across roots');
});

test('consolidate skips a clone whose instance.pid is alive', function () {
  const s = setup();
  const base = path.join(s.ctx.home, '.keyflip-instances', 'claude', 'work');
  const userData = path.join(base, 'User Data');
  const C = 'cccccccc-0000-4000-8000-000000000003';
  const OC = 'cccccccc-0000-4000-8000-0000000000c3';
  const cloneStore = path.join(userData, 'claude-code-sessions');
  fs.mkdirSync(path.join(cloneStore, C, OC), { recursive: true });
  fs.writeFileSync(
    path.join(cloneStore, C, OC, 'local_3.json'),
    JSON.stringify({ sessionId: 'local_3', cliSessionId: 'cs3' }),
  );
  fs.writeFileSync(path.join(base, 'instance.pid'), String(process.pid)); // this test process is alive

  const r = consolidate(s.ctx);
  assert.strictEqual(r.skippedRunning, 1);
  assert.ok(fs.existsSync(path.join(cloneStore, C, OC, 'local_1.json')) === false, 'running clone is not written');
  assert.ok(!fs.existsSync(path.join(s.store, s.A, s.OA, 'local_3.json')), 'running clone is not read');
});

function cliIdOfTest(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).cliSessionId;
}

// ---- dry run: the plan without the writes ---------------------------------------------------

test('consolidate dry run reports the exact plan and writes nothing', function () {
  const s = setup();
  const r = consolidate(s.ctx, { dryRun: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dryRun, true);
  assert.strictEqual(r.wouldMerge, 2); // cs2 -> A, cs1 -> B
  assert.strictEqual(r.wouldCode, 2);
  assert.strictEqual(r.wouldCowork, 0);
  assert.strictEqual(r.merged, 0);
  // The plan names where each pointer would land, relative to its store.
  assert.strictEqual(r.plan.length, 2);
  const dests = r.plan
    .map(function (p) {
      return p.to;
    })
    .sort();
  // `to` is store-relative; aaaa… sorts first, so B's session (local_2) landing in A is dests[0].
  assert.ok(dests[0].indexOf(s.A + '/' + s.OA + '/local_2.json') !== -1, 'B session lands in A: ' + dests[0]);
  assert.ok(dests[1].indexOf(s.B + '/' + s.OB + '/local_1.json') !== -1, 'A session lands in B: ' + dests[1]);
  r.plan.forEach(function (p) {
    assert.strictEqual(p.instance, null); // base store, not a clone
    assert.ok(fs.existsSync(p.from), 'the plan source exists: ' + p.from);
  });
  // Nothing moved: no backup, no copied pointer.
  assert.deepStrictEqual(r.backups, []);
  assert.ok(!fs.existsSync(path.join(s.store, s.A, s.OA, 'local_2.json')), 'A unchanged');
  assert.ok(!fs.existsSync(path.join(s.store, s.B, s.OB, 'local_1.json')), 'B unchanged');
  assert.ok(!fs.existsSync(path.join(s.ctx.configDir, 'backups')), 'no backup dir created');

  // A dry run is also idempotent and does not change what a real run would do.
  const again = consolidate(s.ctx, { dryRun: true });
  assert.strictEqual(again.wouldMerge, 2);
  const real = consolidate(s.ctx);
  assert.strictEqual(real.merged, 2);
  assert.ok(fs.existsSync(path.join(s.store, s.A, s.OA, 'local_2.json')));
});

test('consolidate dry run plans nothing when the stores already agree', function () {
  const s = setup();
  consolidate(s.ctx);
  const r = consolidate(s.ctx, { dryRun: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.wouldMerge, 0);
  assert.strictEqual(r.plan, undefined);
});
