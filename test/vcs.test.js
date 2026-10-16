// Tests for git-backed versioning (src/vcs.js). Requires the system `git`; skips if absent.
// This file OWNS the enabled path, so it clears KEYFLIP_VCS (the rest of the suite runs
// with KEYFLIP_VCS=off, supplied by the CI job env, so it doesn't git-init temp dirs).
delete process.env.KEYFLIP_VCS;

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import cp from 'child_process';
import * as vcs from '../src/vcs.js';
import * as threads from '../src/threads.js';
import * as config from '../src/config.js';
import { makeCtx } from './helpers.js';

const HAS_GIT = vcs.gitAvailable();
function tracked(cfg) {
  return cp.execFileSync('git', ['-C', cfg, 'ls-files'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
}

test('ensureRepo inits a repo + managed .gitignore; secrets are NEVER tracked', function (t) {
  if (!HAS_GIT) return t.skip('git not installed');
  const ctx = makeCtx();
  // Seed a metadata file (should be tracked) and a secret (must NOT be tracked).
  fs.writeFileSync(path.join(ctx.configDir, 'work.json'), '{"name":"work"}');
  fs.mkdirSync(path.join(ctx.configDir, 'creds'), { recursive: true });
  fs.writeFileSync(path.join(ctx.configDir, 'creds', 'work.cred'), '{"token":"SECRET"}');
  fs.mkdirSync(path.join(ctx.configDir, 'browser-sessions'), { recursive: true });
  fs.writeFileSync(path.join(ctx.configDir, 'browser-sessions', 'a.sql'), 'INSERT ...');
  // A third-party capture: innocent-looking basenames (auth.json, CURRENT) under surfaces/.
  fs.mkdirSync(path.join(ctx.configDir, 'surfaces', 'codex', 'work'), { recursive: true });
  fs.writeFileSync(
    path.join(ctx.configDir, 'surfaces', 'codex', 'work', 'auth.json'),
    '{"tokens":{"refresh_token":"SECRET"}}',
  );
  fs.writeFileSync(path.join(ctx.configDir, 'surfaces', 'codex', 'work', 'CURRENT'), 'MANIFEST-000001');
  // ...and the same credential file shape loose at the top level.
  fs.writeFileSync(path.join(ctx.configDir, 'auth.json'), '{"tokens":{"access_token":"SECRET"}}');

  assert.strictEqual(vcs.ensureRepo(ctx), true);
  assert.ok(vcs.isRepo(ctx));
  assert.ok(fs.existsSync(path.join(ctx.configDir, '.gitignore')));
  const files = tracked(ctx.configDir);
  assert.ok(files.indexOf('work.json') !== -1, 'metadata is versioned');
  assert.ok(files.indexOf('.gitignore') !== -1);
  assert.strictEqual(files.indexOf('creds/work.cred'), -1, 'a .cred secret is NEVER committed');
  assert.strictEqual(files.indexOf('browser-sessions/a.sql'), -1, 'a browser session is NEVER committed');
  assert.strictEqual(files.indexOf('surfaces/codex/work/auth.json'), -1, 'a surface capture is NEVER committed');
  assert.strictEqual(
    files.indexOf('surfaces/codex/work/CURRENT'),
    -1,
    'the whole surfaces/ dir is the secret boundary',
  );
  assert.strictEqual(files.indexOf('auth.json'), -1, 'a loose auth.json is NEVER committed');
});

// #36/#40: a schedule receipt is a fact about THIS machine's launchd/cron table. Versioned, it would
// ride along with `migrate`/`restore` to a machine where nothing is scheduled, and doctor — which
// reads the receipt as "the schedule keyflip agreed to" — would report a nightly job that isn't there.
test('schedule receipts are machine-local and never versioned', function (t) {
  if (!HAS_GIT) return t.skip('git not installed');
  const ctx = makeCtx();
  fs.writeFileSync(path.join(ctx.configDir, 'work.json'), '{"name":"work"}');
  fs.writeFileSync(
    path.join(ctx.configDir, 'dream-schedule.json'),
    '{"job":"dream","provider":"ollama","at":{"h":3,"m":0}}',
  );
  fs.writeFileSync(path.join(ctx.configDir, 'refresh-schedule.json'), '{"job":"refresh","kind":"launchd"}');
  assert.strictEqual(vcs.ensureRepo(ctx), true);
  vcs.autoCommit(ctx, 'install schedules');
  const files = tracked(ctx.configDir);
  assert.ok(files.indexOf('work.json') !== -1, 'accounts are still versioned');
  assert.strictEqual(files.indexOf('dream-schedule.json'), -1, 'the dream receipt stays local');
  assert.strictEqual(files.indexOf('refresh-schedule.json'), -1, 'the refresh receipt stays local');
});

test('autoCommit records a change; log lists it; nothing-to-commit is a no-op', function (t) {
  if (!HAS_GIT) return t.skip('git not installed');
  const ctx = makeCtx();
  fs.writeFileSync(path.join(ctx.configDir, 'a.json'), '1');
  vcs.ensureRepo(ctx);
  fs.writeFileSync(path.join(ctx.configDir, 'a.json'), '2');
  assert.strictEqual(vcs.autoCommit(ctx, 'switch work'), true);
  const hist = vcs.log(ctx, 10);
  assert.ok(hist.length >= 2);
  assert.ok(hist[0].subject.indexOf('switch work') !== -1);
  assert.strictEqual(vcs.commit(ctx, 'noop'), false); // nothing changed since
});

test('undo reverts the last change; restore returns to a past ref', function (t) {
  if (!HAS_GIT) return t.skip('git not installed');
  const ctx = makeCtx();
  const f = path.join(ctx.configDir, 'v.json');
  fs.writeFileSync(f, 'ONE');
  vcs.ensureRepo(ctx); // commit ONE
  const first = vcs.log(ctx, 1)[0].ref;
  fs.writeFileSync(f, 'TWO');
  vcs.autoCommit(ctx, 'set two'); // commit TWO
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'TWO');

  assert.strictEqual(vcs.undo(ctx).ok, true); // undo -> back to ONE
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'ONE');

  fs.writeFileSync(f, 'THREE');
  vcs.autoCommit(ctx, 'set three');
  assert.strictEqual(vcs.restore(ctx, first).ok, true); // restore original commit
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'ONE');
});

test('disable writes a .noversion marker; isEnabled then false', function (t) {
  if (!HAS_GIT) return t.skip('git not installed');
  const ctx = makeCtx();
  assert.strictEqual(vcs.isEnabled(ctx), true);
  vcs.disable(ctx);
  assert.strictEqual(vcs.isEnabled(ctx), false);
  assert.strictEqual(vcs.commit(ctx, 'x'), false); // disabled -> no-op
});

test('KEYFLIP_VCS=off forces versioning off regardless', function (t) {
  if (!HAS_GIT) return t.skip('git not installed');
  const ctx = makeCtx();
  process.env.KEYFLIP_VCS = 'off';
  try {
    assert.strictEqual(vcs.isEnabled(ctx), false);
  } finally {
    delete process.env.KEYFLIP_VCS;
  }
});

// SECURITY (review P0 #1/#2, #16): the managed .gitignore is the ONLY thing keeping secrets
// out of keyflip's git. Prove EVERY secret-bearing path is untracked — not just .cred/.sql.
test('every secret-bearing path is git-ignored (app oauth cache, cookies, tokens, registry, pre-sync)', function (t) {
  if (!HAS_GIT) return t.skip('git not installed');
  const ctx = makeCtx();
  const seed = function (rel, body) {
    const p = path.join(ctx.configDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  seed('keep.json', '{"ok":1}'); // non-secret metadata -> tracked
  seed('app/work.json', '{"oauth:tokenCacheV2":"BLOB"}'); // desktop OAuth token cache
  seed('app/work.cookies', 'SQLITE-sessionKey'); // claude.ai sessionKey cookie DB
  seed('pre-sync-backups/pre-sync-1.json', '{"accessToken":"T"}'); // raw OAuth tokens
  seed('mcp-registry.json', '{"srv":{"env":{"API_KEY":"sk"}}}'); // MCP env can hold keys
  seed('.credentials.json', 'SECRET');
  seed('a.token', 'SECRET');
  seed('a.key', 'SECRET');
  seed('a.pem', 'SECRET');
  // B1/B2 archive store = gzipped CHAT HISTORY. It is neither a secret file nor metadata, but it
  // holds everything a user ever pasted into a session, so it must not enter the versioned repo that
  // `keyflip migrate`/`backup` carries between machines. Archiving 200+ sessions used to commit ~1 GB
  // of transcripts into git.
  seed('archive/-Users-x-proj/deadbeef.jsonl.gz', 'not-really-gzip-but-bytes');
  assert.strictEqual(vcs.ensureRepo(ctx), true);
  const files = tracked(ctx.configDir);
  assert.ok(files.indexOf('keep.json') !== -1, 'non-secret metadata is versioned');
  [
    'app/work.json',
    'app/work.cookies',
    'pre-sync-backups/pre-sync-1.json',
    'mcp-registry.json',
    '.credentials.json',
    'a.token',
    'a.key',
    'a.pem',
    'archive/-Users-x-proj/deadbeef.jsonl.gz',
  ].forEach(function (rel) {
    assert.strictEqual(files.indexOf(rel), -1, rel + ' must NEVER be committed');
  });
});

// SECURITY (review P0 #1): a repo initialised by an OLDER keyflip has a STALE .gitignore.
// ensureRepo must refresh it AND untrack anything it now excludes (e.g. a leaked app/ blob).
test('ensureRepo refreshes a stale .gitignore and purges now-ignored files from the index', function (t) {
  if (!HAS_GIT) return t.skip('git not installed');
  const ctx = makeCtx();
  fs.writeFileSync(path.join(ctx.configDir, 'keep.json'), '{"ok":1}');
  // Simulate an old repo whose .gitignore did NOT know about app/, and that already committed it.
  fs.writeFileSync(path.join(ctx.configDir, '.gitignore'), 'creds/\n');
  fs.mkdirSync(path.join(ctx.configDir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(ctx.configDir, 'app', 'work.cookies'), 'sessionKey');
  cp.execFileSync('git', ['-C', ctx.configDir, 'init', '-q']);
  cp.execFileSync('git', ['-C', ctx.configDir, 'add', '-A']);
  cp.execFileSync('git', [
    '-C',
    ctx.configDir,
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '-m',
    'legacy',
  ]);
  assert.ok(tracked(ctx.configDir).indexOf('app/work.cookies') !== -1, 'precondition: leaked into the old repo');
  // Now a current keyflip runs ensureRepo -> must refresh + purge.
  vcs.ensureRepo(ctx);
  assert.strictEqual(
    tracked(ctx.configDir).indexOf('app/work.cookies'),
    -1,
    'the leaked secret is untracked after refresh',
  );
  assert.ok(fs.existsSync(path.join(ctx.configDir, 'app', 'work.cookies')), 'the working file itself is NOT deleted');
});

// SECURITY (#35): a thread is a NAME plus POINTERS — that is versioned metadata and must survive
// `migrate` between machines. Its OPTIONAL mirror (`threads.mirror`) is the merged conversation text,
// i.e. everything ever pasted into those sessions, and it must never enter the git repo. The whole
// difference between the two dirs is one line of .gitignore, so both halves are asserted here, on a
// real repo, with real files — plus the remote check the mirror consults before it writes anything.
test('threads/ is versioned, thread-mirror/ never is, and a configured remote blocks the mirror', function (t) {
  if (!HAS_GIT) return t.skip('git not installed');
  const ctx = makeCtx();
  fs.writeFileSync(path.join(ctx.configDir, 'keep.json'), '{"ok":1}');
  threads.create(ctx, { slug: 'design', title: 'Threads design' });
  threads.addMember(ctx, 'design', { kind: 'session', id: 'aaaaaaaa-1111-4111-8111-111111111111' });
  config.set(ctx, 'threads.mirror', true);
  const m = threads.mirror(ctx, threads.read(ctx, 'design'));
  assert.strictEqual(m.ok, true, 'a local-only repo may mirror');

  assert.strictEqual(vcs.ensureRepo(ctx), true);
  vcs.autoCommit(ctx, 'thread work');
  const files = tracked(ctx.configDir);
  assert.ok(files.indexOf('threads/design.json') !== -1, 'the pointer file is versioned — that is the feature');
  assert.strictEqual(files.indexOf('thread-mirror/design.md'), -1, 'the conversation text is NEVER committed');
  assert.ok(fs.existsSync(path.join(ctx.configDir, 'thread-mirror', 'design.md')), 'the mirror itself stays on disk');

  // The gate is git's own answer, not a cached flag: add a remote and the next mirror refuses.
  assert.strictEqual(vcs.hasRemote(ctx), false, 'no remote until one is added');
  cp.execFileSync('git', [
    '-C',
    ctx.configDir,
    'remote',
    'add',
    'origin',
    path.join(ctx.configDir, '..', 'elsewhere.git'),
  ]);
  assert.strictEqual(vcs.hasRemote(ctx), true, 'hasRemote reads live state');
  const refused = threads.mirror(ctx, threads.read(ctx, 'design'));
  assert.strictEqual(refused.ok, false, 'the mirror refuses once the repo could leave this machine');
  assert.strictEqual(refused.reason, 'remote-configured');
  assert.ok(
    fs.existsSync(path.join(ctx.configDir, 'thread-mirror', 'design.md')),
    'refusing does not delete what is already there',
  );
  assert.strictEqual(
    tracked(ctx.configDir).indexOf('thread-mirror/design.md'),
    -1,
    'and it is still ignored after the remote appears',
  );
});
