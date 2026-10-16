// Tests for #41 — the history leak scan + scrub planner + keepsake audit (src/leakscan.js).
// These OWN the git path, so KEYFLIP_VCS is cleared (the rest of the suite runs with it off).
delete process.env.KEYFLIP_VCS;

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import cp from 'child_process';
import * as leakscan from '../src/leakscan.js';
import * as memory from '../src/memory.js';
import * as secretpaths from '../src/secretpaths.js';
import { makeCtx } from './helpers.js';

const HAS_GIT = (function () {
  try {
    cp.execFileSync('git', ['--version']);
    return true;
  } catch (e) {
    return false;
  }
})();

// A fake Anthropic key used ONLY as a shape to detect. Nothing here is a live credential.
const FAKE_KEY = 'sk-ant-api03-' + 'AbCdEfGhIjKlMnOpQrStUvWx'.repeat(2);
const HEX_ID = 'bb902f1e2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789ab';

function git(cfg, args) {
  return cp.execFileSync('git', ['-C', cfg].concat(args), { encoding: 'utf8' });
}
function commitAll(cfg, msg) {
  git(cfg, ['-c', 'user.email=t@keyflip.test', '-c', 'user.name=t', 'add', '-A', '-f']);
  git(cfg, ['-c', 'user.email=t@keyflip.test', '-c', 'user.name=t', 'commit', '-q', '-m', msg]);
}

// A real, throwaway state repo. `git init` directly (not vcs.ensureRepo) so the managed
// .gitignore cannot hide the very files these tests are trying to leak on purpose.
function mkrepo() {
  const ctx = makeCtx();
  git(ctx.configDir, ['init', '-q']);
  return ctx;
}
function write(ctx, rel, content) {
  const p = path.join(ctx.configDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

test("historyLeaks finds a secret in an OLD commit that today's file checks cannot see", function (t) {
  if (!HAS_GIT) return t.skip('git not installed');
  const ctx = mkrepo();
  write(ctx, 'notes.md', '# setup\n\nkey: ' + FAKE_KEY + '\n');
  commitAll(ctx.configDir, 'leak it');
  // Then do the "fix" everyone believes is enough: untrack it.
  fs.rmSync(path.join(ctx.configDir, 'notes.md'));
  git(ctx.configDir, ['rm', '--cached', '-q', '-f', 'notes.md']);
  git(ctx.configDir, ['-c', 'user.email=t@keyflip.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'untrack it']);
  assert.strictEqual(fs.existsSync(path.join(ctx.configDir, 'notes.md')), false, 'gone from the working tree');

  const r = leakscan.historyLeaks(ctx);
  assert.strictEqual(r.ok, true);
  assert.ok(r.scanned >= 1);
  const leak = r.leaks.filter(function (l) {
    return l.file === 'notes.md';
  })[0];
  assert.ok(leak, 'the untracked blob is still reachable and is reported');
  assert.ok(leak.kinds.indexOf('anthropic-api-key') !== -1, 'named by KIND, not by value');
  assert.strictEqual(leak.trackedNow, false, 'it is history-only — safe to scrub');
  assert.strictEqual(leak.confidence, 'high');
  assert.ok(leak.commits >= 1, 'and it says how many commits hold it');
  // The whole point: a scan result must never BECOME a copy of the secret.
  assert.strictEqual(JSON.stringify(r).indexOf(FAKE_KEY), -1, 'no secret VALUE leaves the scanner');
});

test('historyLeaks flags a secret-PATH capture even when its content matches no known shape', function (t) {
  if (!HAS_GIT) return t.skip('git not installed');
  const ctx = mkrepo();
  write(ctx, 'surfaces/codex/work/auth.json', '{"opaque_format":"zzz-no-shape-zzz"}');
  commitAll(ctx.configDir, 'a capture in the days before surfaces/ was ignored');
  const r = leakscan.historyLeaks(ctx);
  const leak = r.leaks[0];
  assert.ok(leak, 'a capture under a secret dir counts even with no shape hit');
  assert.strictEqual(leak.file, 'surfaces/codex/work/auth.json');
  assert.strictEqual(leak.secretPath, true);
  assert.strictEqual(leak.confidence, 'high', 'the DIR is the evidence here');
});

test('a still-TRACKED file with only a weak hex match is never scrubbed unasked', function (t) {
  if (!HAS_GIT) return t.skip('git not installed');
  const ctx = mkrepo();
  // The real-world case: an account profile whose userID is 64 hex chars — an identifier, not a key.
  write(ctx, 'tester.json', '{"name":"tester","userID":"' + HEX_ID + '"}');
  commitAll(ctx.configDir, 'profile');
  const r = leakscan.historyLeaks(ctx);
  const leak = r.leaks.filter(function (l) {
    return l.file === 'tester.json';
  })[0];
  assert.ok(leak, 'it is still REPORTED — err broad on the warning');
  assert.strictEqual(leak.kinds.join(), 'long-hex-secret');
  assert.strictEqual(leak.confidence, 'low', 'a generic hex match alone is weak evidence');
  assert.strictEqual(leak.trackedNow, true);

  const plan = leakscan.planScrub(ctx, r.leaks, {
    now: function () {
      return '2026-01-01T00:00:00.000Z';
    },
  });
  assert.deepStrictEqual(plan.paths, [], 'the live file is NOT on the chopping block');
  assert.deepStrictEqual(plan.skippedTracked, ['tester.json']);
  assert.ok(plan.blockers.join().indexOf('--include-tracked') !== -1, 'and the plan says why nothing can go');
  // Only an explicit opt-in puts a tracked path in the plan.
  const forced = leakscan.planScrub(ctx, r.leaks, { includeTracked: true });
  assert.deepStrictEqual(forced.paths, ['tester.json']);
});

test('planScrub REFUSES without git-filter-repo — no hand-rolled history rewrite', function (t) {
  if (!HAS_GIT) return t.skip('git not installed');
  const ctx = mkrepo();
  write(ctx, 'notes.md', FAKE_KEY);
  commitAll(ctx.configDir, 'leak');
  const leaks = [{ file: 'notes.md', trackedNow: false, confidence: 'high', kinds: ['anthropic-api-key'] }];
  const missing = function () {
    return { code: 1, stdout: '', stderr: 'not found' };
  };
  const plan = leakscan.planScrub(ctx, leaks, { run: missing });
  assert.strictEqual(plan.mode, 'refuse');
  assert.ok(plan.blockers.join().indexOf('git-filter-repo') !== -1);
  // The bundle lands OUTSIDE the repo — a backup of the leak must not become a tracked file.
  assert.strictEqual(path.dirname(plan.bundle), path.dirname(ctx.configDir));
  assert.ok(/keyflip-history-backup-.*\.bundle$/.test(plan.bundle));
  assert.ok(plan.warns.join().indexOf('rotate') !== -1, 'a removed secret that is still valid is not fixed');
});

test('applyScrub writes the bundle FIRST and refuses to rewrite without it', function (t) {
  if (!HAS_GIT) return t.skip('git not installed');
  const ctx = mkrepo();
  write(ctx, 'notes.md', FAKE_KEY);
  commitAll(ctx.configDir, 'leak');
  const before = git(ctx.configDir, ['rev-list', '--count', '--all']).trim();
  const leaks = [{ file: 'notes.md', trackedNow: false, confidence: 'high', kinds: ['anthropic-api-key'] }];
  // git-filter-repo IS available, but the backup fails — the rewrite must not start.
  const runner = function (cmd, args) {
    if (args.indexOf('bundle') !== -1) return { code: 128, stdout: '', stderr: 'bundle blew up' };
    if (cmd === 'git' && args.join(' ').indexOf('filter-repo --version') !== -1)
      return { code: 0, stdout: 'ok', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const r = leakscan.applyScrub(ctx, leaks, { run: runner });
  assert.strictEqual(r.ok, false);
  assert.ok(/bundle/i.test(r.reason), 'the failure names the backup, not the rewrite');
  assert.strictEqual(git(ctx.configDir, ['rev-list', '--count', '--all']).trim(), before, 'history is untouched');
  const siblings = fs.readdirSync(path.dirname(ctx.configDir)).filter(function (f) {
    return /^keyflip-history-backup-.*\.bundle$/.test(f);
  });
  assert.deepStrictEqual(siblings, [], 'a failed backup leaves no half-written bundle behind');
});

test('applyScrub really removes the blob, and the RE-SCAN proves it (needs git-filter-repo)', function (t) {
  if (!HAS_GIT) return t.skip('git not installed');
  if (!leakscan.filterRepoAvailable()) return t.skip('git-filter-repo not installed on this machine');
  const ctx = mkrepo();
  write(ctx, 'notes.md', '# setup\nkey: ' + FAKE_KEY + '\n');
  write(ctx, 'ok.json', '{"a":1}');
  commitAll(ctx.configDir, 'leak it');
  // The realistic shape: the leak was untracked (that is the "fix" people believe), so scrubbing
  // it is pure history cleanup and cannot cost the user a live file.
  fs.rmSync(path.join(ctx.configDir, 'notes.md'));
  git(ctx.configDir, ['rm', '--cached', '-q', '-f', 'notes.md']);
  commitAll(ctx.configDir, 'untrack the leak');
  const hist = leakscan.historyLeaks(ctx);
  assert.ok(hist.leaks.length >= 1);
  assert.strictEqual(
    hist.leaks.every((l) => !l.trackedNow),
    true,
    'ok.json is not a leak, notes.md is history-only',
  );

  const r = leakscan.applyScrub(ctx, hist.leaks, {
    now: function () {
      return '2026-01-01T00:00:00.000Z';
    },
  });
  assert.strictEqual(r.ok, true, r.reason);
  assert.deepStrictEqual(r.removed, ['notes.md']);
  assert.ok(fs.existsSync(r.bundle), 'the escape hatch exists');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(r.bundle).mode & 0o777, 0o600, 'and it is 0600');
  assert.strictEqual(r.bundle.indexOf(path.dirname(ctx.configDir)), 0, 'outside the repo');

  const after = leakscan.historyLeaks(ctx);
  assert.strictEqual(after.leaks.length, 0, 're-scan: the secret is no longer reachable from ANY commit');
  assert.strictEqual(JSON.stringify(after).indexOf(FAKE_KEY), -1);
  // The non-leaked file survives the rewrite — a scrub is not a wipe.
  assert.ok(fs.existsSync(path.join(ctx.configDir, 'ok.json')));
  fs.rmSync(r.bundle, { force: true });
});

test('historyLeaks is honest about not being able to run', function (t) {
  const ctx = makeCtx(); // a temp home with no .git
  const r = leakscan.historyLeaks(ctx);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no-repo');
  assert.deepStrictEqual(r.leaks, []);
});

test('historyLeaks caps the walk instead of running forever, and says so', function (t) {
  if (!HAS_GIT) return t.skip('git not installed');
  const ctx = mkrepo();
  write(ctx, 'a.txt', 'one');
  write(ctx, 'b.txt', 'two');
  write(ctx, 'c.txt', 'three');
  commitAll(ctx.configDir, 'three files');
  const capped = leakscan.historyLeaks(ctx, { maxBlobs: 1 });
  assert.strictEqual(capped.truncated, true);
  assert.strictEqual(capped.scanned, 1);
  assert.ok(capped.skipped >= 2, 'what it did not look at is counted, not silently dropped');
  const whole = leakscan.historyLeaks(ctx);
  assert.strictEqual(whole.truncated, false);
  assert.ok(whole.scanned >= 3);
});

test('keepsakeAudit names the KIND, keepsakeScrub redacts reversibly and never leaks a value', function (t) {
  const ctx = makeCtx();
  memory.save(ctx, 'session-1', '# gotchas\n\nmy key is ' + FAKE_KEY + '\nand a password: hunter2secretvalue\n', {
    source: 'test',
  });
  memory.save(ctx, 'clean-1', '# notes\n\nnothing secret here at all\n');

  const a = leakscan.keepsakeAudit(ctx, memory);
  assert.strictEqual(a.audited, 2);
  assert.strictEqual(a.leaks.length, 1, 'only the one that holds a secret');
  assert.strictEqual(a.leaks[0].key, 'session-1');
  assert.ok(a.leaks[0].kinds.indexOf('anthropic-api-key') !== -1);
  assert.strictEqual(JSON.stringify(a).indexOf(FAKE_KEY), -1, 'the audit result is not a copy of the secret');
  assert.strictEqual(JSON.stringify(a).indexOf('hunter2secretvalue'), -1);

  const s = leakscan.keepsakeScrub(ctx, memory);
  assert.strictEqual(s.redacted, 1);
  assert.deepStrictEqual(s.files, ['session-1']);
  assert.ok(s.total >= 1);

  const file = path.join(ctx.configDir, 'memory', 'session-1.md');
  const red = fs.readFileSync(file, 'utf8');
  assert.strictEqual(red.indexOf(FAKE_KEY), -1, 'the keepsake itself is clean now');
  assert.ok(red.indexOf('«keyflip_redacted»') !== -1);
  const keep = file + '.pre-scrub';
  assert.ok(fs.existsSync(keep), 'the original is kept so the edit is provably reversible');
  assert.ok(fs.readFileSync(keep, 'utf8').indexOf(FAKE_KEY) !== -1);

  // ...and that original is EXACTLY as secret as the file it came from, so it must be a
  // recognized secret path — otherwise the next autoCommit would put the key back in git.
  assert.strictEqual(secretpaths.isSecretFile('session-1.md.pre-scrub'), true);
  assert.strictEqual(secretpaths.gitignoreLines().indexOf('*.pre-scrub') !== -1, true);
  // A 0600 file is the minimum for anything holding a credential.
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(keep).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  }

  // The clean keepsake was not touched, and the .pre-scrub copy is not mistaken for a keepsake.
  assert.ok(fs.readFileSync(path.join(ctx.configDir, 'memory', 'clean-1.md'), 'utf8').indexOf('nothing secret') !== -1);
  const again = leakscan.keepsakeAudit(ctx, memory);
  assert.strictEqual(again.audited, 2, 'a .pre-scrub backup is not a keepsake');
  assert.strictEqual(again.leaks.length, 0, 're-audit is the proof');
});

test('the un-redacted originals are listed, and dropped only when the keepsake is provably clean', function (t) {
  const ctx = makeCtx();
  assert.deepStrictEqual(leakscan.keepsakeCopies(ctx, memory).files, [], 'no memory dir yet is not an error');

  memory.save(ctx, 'k1', 'token: ' + FAKE_KEY + '\n');
  assert.strictEqual(leakscan.keepsakeCopies(ctx, memory).files.length, 0, 'an untouched keepsake has no copy');
  leakscan.keepsakeScrub(ctx, memory);

  const c = leakscan.keepsakeCopies(ctx, memory);
  assert.strictEqual(c.files.length, 1);
  assert.strictEqual(c.files[0].key, 'k1');
  assert.ok(c.files[0].bytes > 0, 'and how much secret text is still sitting there');

  // The refusal case: the redacted file leaked AGAIN (a second paste), so its original is not spare.
  const file = path.join(ctx.configDir, 'memory', 'k1.md');
  fs.writeFileSync(file, 'again: ' + FAKE_KEY + '\n');
  const kept = leakscan.dropKeepsakeCopies(ctx, memory);
  assert.deepStrictEqual(kept.dropped, [], 'nothing is dropped from a keepsake that still leaks');
  assert.strictEqual(kept.kept.length, 1);
  assert.match(kept.kept[0].reason, /STILL matches a secret/);
  assert.ok(fs.existsSync(c.files[0].copy), 'the original is still there');

  // Clean keepsake => the copy is the last copy of a secret and can go.
  fs.writeFileSync(file, 'token: «keyflip_redacted»\n');
  const gone = leakscan.dropKeepsakeCopies(ctx, memory);
  assert.deepStrictEqual(gone.dropped, ['k1']);
  assert.strictEqual(fs.existsSync(c.files[0].copy), false);
  assert.strictEqual(leakscan.keepsakeCopies(ctx, memory).files.length, 0, 'and it is really gone');

  // A keepsake that no longer exists must NOT lose its only surviving text.
  fs.rmSync(file);
  fs.writeFileSync(file + '.pre-scrub', 'the only version left\n');
  const orphan = leakscan.dropKeepsakeCopies(ctx, memory);
  assert.deepStrictEqual(orphan.dropped, []);
  assert.match(orphan.kept[0].reason, /only version left/);
  assert.ok(fs.existsSync(file + '.pre-scrub'), 'an orphaned original is kept, not silently deleted');
});

test('an empty keepsake store audits clean instead of throwing', function (t) {
  const ctx = makeCtx();
  const a = leakscan.keepsakeAudit(ctx, memory);
  assert.strictEqual(a.audited, 0);
  assert.deepStrictEqual(a.leaks, []);
  const s = leakscan.keepsakeScrub(ctx, memory);
  assert.strictEqual(s.redacted, 0);
});
