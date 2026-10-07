// Liveness + janitorial tests for `keyflip sessions` (src/sessions.js).
//
// These encode what a real cleanup pass on a real machine proved: a missing recorded cwd is NOT
// proof of a dead session, rebind's `.keyflip-bak` snapshots are invisible to every listing (so
// they need a proven-redundant prune), and emptied project keys pile up unnoticed.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as sessions from '../src/sessions.js';
import { makeCtx } from './helpers.js';

const GONE = '/Users/x/Projects/deleted-folder';
const ALIVE = process.cwd(); // a path that exists, for the "not orphan" control

function seed(ctx, cwd, id, body) {
  const dir = path.join(sessions.projectsDir(ctx), sessions.encodeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.jsonl');
  fs.writeFileSync(file, body || '{"cwd":"' + cwd + '","type":"user"}\n');
  return { dir: dir, file: file };
}

function rowFor(rows, id) {
  return rows.filter(function (r) {
    return r.sessionId === id;
  })[0];
}

// ---- liveness signals ----

test('parseResumeIds reads both --resume forms and quoted values', function () {
  const out = [
    'claude --resume=aaaaaaaa-1111-2222-3333-444455556666',
    'node /usr/local/bin/claude --resume bbbbcccc-1111-2222-3333-444455556666 --model x',
    'zsh -c claude "--resume" "quoted-uuid-9999"',
    'grep --resume=not-an-id-here',
  ].join('\n');
  const ids = sessions.parseResumeIds(out);
  assert.ok(ids.has('aaaaaaaa-1111-2222-3333-444455556666'), '--resume=<id>');
  assert.ok(ids.has('bbbbcccc-1111-2222-3333-444455556666'), '--resume <id>');
  assert.ok(ids.has('quoted-uuid-9999'), 'quoted value');
  assert.ok(ids.has('not-an-id-here'), 'a real-looking token counts even from grep (it is still an id)');
});

test('parseResumeIds ignores shell noise that merely mentions --resume', function () {
  // `ps -Ao command` lists the probing shell too; without a floor these become fake live claims
  // and hide genuine orphans.
  const out = [
    "grep -o -- '--resume=[0-9a-f-]*'",
    'echo --resume=var',
    'awk /--resume=/{print}',
    'claude --resume= ',
    'claude --resume ab',
  ].join('\n');
  assert.deepStrictEqual([...sessions.parseResumeIds(out)], [], 'no junk survives');
});

test('a session resumed by a RUNNING process is not an orphan even though its cwd is gone', function () {
  const ctx = makeCtx();
  const LIVE_ID = 'ec408f26-012b-4073-a60d-e98a277dd814';
  seed(ctx, GONE, LIVE_ID);
  seed(ctx, GONE, 'dead-session-0001');
  const rows = sessions.list(ctx, { limit: 50, running: [LIVE_ID], appIds: [] });
  const live = rowFor(rows, LIVE_ID);
  assert.strictEqual(live.live, true, 'running process -> live');
  assert.strictEqual(live.liveReason, 'running');
  assert.strictEqual(live.orphan, false, 'MUST NOT be offered for delete/rebind as an orphan');
  assert.strictEqual(live.staleCwd, true, 'reported instead as a stale path record');
  const dead = rowFor(rows, 'dead-session-0001');
  assert.strictEqual(dead.orphan, true, 'a gone cwd with no live signal is still an orphan');
});

test('the Claude desktop app registry marks a session live', function () {
  const ctx = makeCtx();
  ctx.appDataDir = path.join(ctx.home, 'AppSupport');
  const ID = '9423e283-9969-40fc-8e19-33f0bcfce901';
  seed(ctx, GONE, ID);
  const store = path.join(ctx.appDataDir, 'claude-code-sessions', 'acct-uuid', 'org-uuid');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(
    path.join(store, 'local_' + ID + '.json'),
    JSON.stringify({ cliSessionId: ID, cwd: GONE, lastActivityAt: 1, isArchived: false }),
  );
  // no opts injection: exercise the real reader end to end
  const rows = sessions.list(ctx, { limit: 50, running: [] });
  const r = rowFor(rows, ID);
  assert.strictEqual(r.live, true, 'app registry -> live');
  assert.strictEqual(r.liveReason, 'app');
  assert.strictEqual(r.orphan, false);
  assert.strictEqual(sessions.appRegistrySessionIds(ctx).has(ID), true);
});

test('appRegistrySessionIds ignores junk and survives a missing store', function () {
  const ctx = makeCtx();
  assert.strictEqual(sessions.appRegistrySessionIds(ctx).size, 0, 'no appDataDir -> empty, no throw');
  ctx.appDataDir = path.join(ctx.home, 'AppSupport');
  const store = path.join(ctx.appDataDir, 'claude-code-sessions', 'a', 'b');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'local_broken.json'), '{not json');
  fs.writeFileSync(path.join(store, 'other.json'), '{"cliSessionId":"should-be-ignored"}');
  assert.strictEqual(sessions.appRegistrySessionIds(ctx).size, 0, 'unparsable/non-registry files skipped');
});

test('an existing cwd is neither orphan nor staleCwd', function () {
  const ctx = makeCtx();
  seed(ctx, ALIVE, 'ok-session-0001');
  const r = rowFor(sessions.list(ctx, { limit: 10, running: [], appIds: [] }), 'ok-session-0001');
  assert.strictEqual(r.orphan, false);
  assert.strictEqual(r.staleCwd, false);
  assert.strictEqual(r.live, false);
});

test('recentlyWritten is reported but does not cancel orphan (no wall-clock dependency)', function () {
  const ctx = makeCtx();
  const s = seed(ctx, GONE, 'fresh-session-01');
  const rows = sessions.list(ctx, { limit: 10, running: [], appIds: [], nowMs: Date.now() + 1000 });
  const r = rowFor(rows, 'fresh-session-01');
  assert.strictEqual(r.recentlyWritten, true, 'a file written seconds ago is flagged');
  assert.strictEqual(r.orphan, true, 'but liveness stays a claim about processes/app, not mtimes');
  const old = sessions.list(ctx, { limit: 10, running: [], appIds: [], nowMs: Date.now() + 10 * 60000 });
  assert.strictEqual(rowFor(old, 'fresh-session-01').recentlyWritten, false);
  fs.utimesSync(s.file, new Date(), new Date());
});

// ---- rebind backup reclaim ----

// rebind backs up the old key AND copies into the new one, so the old key keeps the originals.
// A backup is therefore redundant exactly when (a) the live old key still matches it byte-for-byte
// and (b) the session id now exists in a second key.
function backupOf(ctx, cwd) {
  return path.join(sessions.projectsDir(ctx), sessions.encodeCwd(cwd) + '.keyflip-bak');
}

test('sessions backups removes a provably redundant rebind snapshot, only with --apply', function () {
  const ctx = makeCtx();
  const OLD = '/Users/x/Documents/OpenTraycer',
    NEW = '/Users/x/Documents/Plansmith';
  seed(ctx, OLD, 'sess-1', '{"cwd":"' + OLD + '"}\n{"cwd":"' + OLD + '/apps"}\n');
  const r = sessions.rebind(ctx, OLD, NEW, {});
  assert.ok(r.backup && fs.existsSync(r.backup), 'rebind took the snapshot');

  let plan = sessions.pruneBackups(ctx, {});
  assert.strictEqual(plan.keys.length, 1);
  assert.strictEqual(plan.keys[0].status, 'redundant', 'identical twin + landed under the new key');
  assert.strictEqual(plan.removable, 1);
  assert.ok(plan.removableBytes > 0);
  assert.strictEqual(fs.existsSync(r.backup), true, 'dry run deletes nothing');

  const applied = sessions.pruneBackups(ctx, { apply: true });
  assert.strictEqual(applied.removed, 1);
  assert.strictEqual(fs.existsSync(r.backup), false, '--apply removed it');
  assert.strictEqual(fs.existsSync(backupOf(ctx, OLD)), false);
  // the real history is untouched
  assert.ok(fs.existsSync(path.join(sessions.projectsDir(ctx), sessions.encodeCwd(NEW), 'sess-1.jsonl')));
  assert.ok(fs.existsSync(path.join(sessions.projectsDir(ctx), sessions.encodeCwd(OLD), 'sess-1.jsonl')));
});

test('a backup whose live twin differs is KEPT and named', function () {
  const ctx = makeCtx();
  const OLD = '/Users/x/old',
    NEW = '/Users/x/new';
  seed(ctx, OLD, 'sess-2', '{"cwd":"' + OLD + '"}\n');
  sessions.rebind(ctx, OLD, NEW, {}); // creates <old>.keyflip-bak from the pre-append content
  // the transcript continued AFTER the snapshot -> live key no longer byte-identical
  fs.appendFileSync(path.join(sessions.projectsDir(ctx), sessions.encodeCwd(OLD), 'sess-2.jsonl'), '{"more":1}\n');
  const plan = sessions.pruneBackups(ctx, {});
  assert.strictEqual(plan.removable, 0, 'never delete a backup that holds a unique byte');
  assert.deepStrictEqual(plan.keys[0].blockers, ['differs-from-live-copy']);
});

test('a backup whose rebind never landed is KEPT', function () {
  const ctx = makeCtx();
  const OLD = '/Users/x/old-only';
  seed(ctx, OLD, 'sess-3', '{"cwd":"' + OLD + '"}\n');
  // hand-create a .keyflip-bak without any new key existing
  const bak = backupOf(ctx, OLD);
  fs.mkdirSync(bak, { recursive: true });
  fs.copyFileSync(
    path.join(sessions.projectsDir(ctx), sessions.encodeCwd(OLD), 'sess-3.jsonl'),
    path.join(bak, 'sess-3.jsonl'),
  );
  const plan = sessions.pruneBackups(ctx, {});
  assert.strictEqual(plan.removable, 0);
  assert.deepStrictEqual(plan.keys[0].blockers, ['rebind-not-landed']);
  assert.strictEqual(fs.existsSync(bak), true);
});

test('a backup whose source key was deleted is KEPT (it is the only copy)', function () {
  const ctx = makeCtx();
  const OLD = '/Users/x/gone-source';
  seed(ctx, OLD, 'sess-4', '{"cwd":"' + OLD + '"}\n');
  const bak = backupOf(ctx, OLD);
  fs.mkdirSync(bak, { recursive: true });
  fs.copyFileSync(
    path.join(sessions.projectsDir(ctx), sessions.encodeCwd(OLD), 'sess-4.jsonl'),
    path.join(bak, 'sess-4.jsonl'),
  );
  // and pretend the rebind landed elsewhere so ONLY the source-key check can block it
  seed(ctx, '/Users/x/elsewhere', 'sess-4', '{}\n');
  fs.rmSync(path.join(sessions.projectsDir(ctx), sessions.encodeCwd(OLD)), { recursive: true, force: true });
  const plan = sessions.pruneBackups(ctx, {});
  assert.strictEqual(plan.removable, 0);
  assert.ok(plan.keys[0].blockers.indexOf('source-key-gone') !== -1, 'source-key-gone blocks it');
});

test('a backup is redundant only when its sub-agent sidecar is proven too', function () {
  const ctx = makeCtx();
  const OLD = '/Users/x/side',
    NEW = '/Users/x/side-new';
  const s = seed(ctx, OLD, 'sess-5', '{"cwd":"' + OLD + '"}\n');
  const sub = path.join(s.dir, 'sess-5', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), '{"cwd":"' + OLD + '"}\n');
  const r = sessions.rebind(ctx, OLD, NEW, {});
  assert.strictEqual(r.sidecars, 1, 'rebind carried the sidecar');
  // identical sidecar in backup + live key + landed under the new key -> redundant
  assert.strictEqual(sessions.pruneBackups(ctx, {}).removable, 1);
  // now make ONLY the sidecar unique
  fs.writeFileSync(path.join(r.backup, 'sess-5', 'subagents', 'agent-2.jsonl'), '{"unique":1}\n');
  const plan = sessions.pruneBackups(ctx, {});
  assert.strictEqual(plan.removable, 0, 'a unique sidecar blocks the whole folder');
  assert.deepStrictEqual(plan.keys[0].blockers, ['differs-from-live-copy']);
});

// ---- empty / half-empty keys ----

test('sessions empty prunes only folders with ZERO files, and never a notes-only key', function () {
  const ctx = makeCtx();
  const root = sessions.projectsDir(ctx);
  // 1) truly empty
  fs.mkdirSync(path.join(root, '-Users-x-empty'), { recursive: true });
  // 2) notes only (content!)
  fs.mkdirSync(path.join(root, '-Users-x-notes', 'memory'), { recursive: true });
  fs.writeFileSync(path.join(root, '-Users-x-notes', 'memory', 'note.md'), 'keep me');
  // 3) transcript-less sidecar only (content!)
  fs.mkdirSync(path.join(root, '-Users-x-side', 'sess-9', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(root, '-Users-x-side', 'sess-9', 'subagents', 'agent-1.jsonl'), '{}\n');
  // 4) a real session
  seed(ctx, '/Users/x/real', 'sess-10', '{}\n');

  const plan = sessions.emptyProjects(ctx, {});
  assert.strictEqual(plan.empty, 1, 'only the zero-file key counts as empty');
  assert.strictEqual(plan.removed, 0, 'dry run');
  assert.strictEqual(plan.notesOnly.length, 1);
  assert.strictEqual(plan.notesOnly[0].key, '-Users-x-notes');
  assert.strictEqual(plan.sidecarsOnly.length, 1);
  assert.strictEqual(plan.sidecarsOnly[0].key, '-Users-x-side');

  const applied = sessions.emptyProjects(ctx, { apply: true });
  assert.strictEqual(applied.removed, 1);
  assert.strictEqual(fs.existsSync(path.join(root, '-Users-x-empty')), false);
  assert.ok(fs.existsSync(path.join(root, '-Users-x-notes', 'memory', 'note.md')), 'notes survive');
  assert.ok(
    fs.existsSync(path.join(root, '-Users-x-side', 'sess-9', 'subagents', 'agent-1.jsonl')),
    'sidecars survive',
  );
  assert.ok(fs.existsSync(path.join(root, '-Users-x-real', 'sess-10.jsonl')), 'live history survives');
});

test('emptyProjects does not touch .keyflip-bak folders (backups are the other command)', function () {
  const ctx = makeCtx();
  const root = sessions.projectsDir(ctx);
  fs.mkdirSync(path.join(root, '-Users-x-old.keyflip-bak'), { recursive: true });
  const r = sessions.emptyProjects(ctx, { apply: true });
  assert.strictEqual(r.empty, 0);
  assert.strictEqual(fs.existsSync(path.join(root, '-Users-x-old.keyflip-bak')), true);
  // and pruneBackups reports it as an empty backup rather than deleting silently
  assert.strictEqual(sessions.pruneBackups(ctx, {}).keys[0].status, 'empty');
});
