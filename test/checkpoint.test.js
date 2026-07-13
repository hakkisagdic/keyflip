'use strict';
// Git-bound checkpoints (src/checkpoint.js): create/list/latest/get + READ-ONLY restore, the
// parent chain, canonical content hashing, and — critically — that NO secret ever reaches a
// checkpoint file (summary prose, provider, or nested task fields).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const checkpoint = require('../src/checkpoint');
const secretscan = require('../src/secretscan');

function tmpProject() { return fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-cp-')); }

// A fake `git` runner: canned branch/commit/dirty, no real subprocess.
function fakeGit(over) {
  over = over || {};
  return function (cmd, args) {
    assert.strictEqual(cmd, 'git');
    const sub = (args || []).join(' ');
    if (/rev-parse --abbrev-ref HEAD/.test(sub)) return { code: 0, stdout: (over.branch || 'main') + '\n', stderr: '' };
    if (/rev-parse --short HEAD/.test(sub)) return { code: 0, stdout: (over.commit || 'a1b2c3d') + '\n', stderr: '' };
    if (/status --porcelain/.test(sub)) return { code: 0, stdout: over.status != null ? over.status : ' M src/app.js\n?? new.txt\n', stderr: '' };
    return { code: 1, stdout: '', stderr: 'unknown' };
  };
}
// A runner for a directory that is NOT a git repo: everything fails.
function noGit() { return function () { return { code: 128, stdout: '', stderr: 'not a git repository' }; }; }

const clockAt = function (iso) { return function () { return iso; }; };

test('create: records git state, redacts summary, writes <id>.json + latest.json', function () {
  const proj = tmpProject();
  const cp = checkpoint.create(proj, { summary: 'wrapped up auth work', provider: 'work-account' }, {
    run: fakeGit(), now: clockAt('2026-07-12T10:00:00.000Z'),
  });

  assert.strictEqual(cp.git.branch, 'main');
  assert.strictEqual(cp.git.commit, 'a1b2c3d');
  assert.deepStrictEqual(cp.git.dirty, ['src/app.js', 'new.txt']);
  assert.strictEqual(cp.summary, 'wrapped up auth work');
  assert.strictEqual(cp.provider, 'work-account');
  assert.strictEqual(cp.parent, null, 'first checkpoint has no parent');
  assert.ok(/^20260712T100000-[0-9a-f]{8}$/.test(cp.id), 'id = compact stamp + hash prefix: ' + cp.id);
  assert.match(cp.contentHash, /^[0-9a-f]{64}$/);

  // both files exist on disk and round-trip to the same object
  const dir = checkpoint.checkpointsDir(proj);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, cp.id + '.json'), 'utf8'));
  const latestOnDisk = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'));
  assert.deepStrictEqual(onDisk, cp);
  assert.deepStrictEqual(latestOnDisk, cp);
});

test('create: 0600 perms on the checkpoint files', function () {
  if (process.platform === 'win32') return; // POSIX perms only
  const proj = tmpProject();
  const cp = checkpoint.create(proj, { summary: 'x' }, { run: fakeGit(), now: clockAt('2026-07-12T10:00:00.000Z') });
  const mode = fs.statSync(path.join(checkpoint.checkpointsDir(proj), cp.id + '.json')).mode & 0o777;
  assert.strictEqual(mode, 0o600);
});

test('parent chain: each checkpoint links to the previous latest, list is newest-first', function () {
  const proj = tmpProject();
  const c1 = checkpoint.create(proj, { summary: 'one' }, { run: fakeGit(), now: clockAt('2026-07-12T10:00:00.000Z') });
  const c2 = checkpoint.create(proj, { summary: 'two' }, { run: fakeGit(), now: clockAt('2026-07-12T11:00:00.000Z') });
  const c3 = checkpoint.create(proj, { summary: 'three' }, { run: fakeGit(), now: clockAt('2026-07-12T12:00:00.000Z') });

  assert.strictEqual(c2.parent, c1.id);
  assert.strictEqual(c3.parent, c2.id);
  assert.notStrictEqual(c1.id, c2.id);

  assert.strictEqual(checkpoint.latest(proj).id, c3.id);
  const ids = checkpoint.list(proj).map(function (c) { return c.id; });
  assert.deepStrictEqual(ids, [c3.id, c2.id, c1.id], 'newest first');
});

test('get + restore are read-only and resolve by id / latest', function () {
  const proj = tmpProject();
  const c1 = checkpoint.create(proj, { summary: 'one' }, { run: fakeGit(), now: clockAt('2026-07-12T10:00:00.000Z') });
  const c2 = checkpoint.create(proj, { summary: 'two' }, { run: fakeGit(), now: clockAt('2026-07-12T11:00:00.000Z') });

  assert.strictEqual(checkpoint.get(proj, c1.id).summary, 'one');
  assert.strictEqual(checkpoint.restore(proj, c1.id).id, c1.id, 'restore by id returns that checkpoint');
  assert.strictEqual(checkpoint.restore(proj).id, c2.id, 'restore with no id returns latest');
  assert.strictEqual(checkpoint.get(proj, 'nope'), null);
});

test('get: rejects path traversal in the id', function () {
  const proj = tmpProject();
  checkpoint.create(proj, { summary: 'x' }, { run: fakeGit(), now: clockAt('2026-07-12T10:00:00.000Z') });
  assert.strictEqual(checkpoint.get(proj, '../../etc/passwd'), null);
  assert.strictEqual(checkpoint.get(proj, '..'), null);
  assert.strictEqual(checkpoint.safeId('../../x'), '');
});

test('missing project: list/latest/get degrade to empty, never throw', function () {
  const proj = path.join(tmpProject(), 'no-such-subdir');
  assert.deepStrictEqual(checkpoint.list(proj), []);
  assert.strictEqual(checkpoint.latest(proj), null);
  assert.strictEqual(checkpoint.get(proj, 'anything'), null);
  assert.strictEqual(checkpoint.restore(proj), null);
});

test('non-git project: branch/commit null, dirty empty — still checkpoints', function () {
  const proj = tmpProject();
  const cp = checkpoint.create(proj, { summary: 'not a repo' }, { run: noGit(), now: clockAt('2026-07-12T10:00:00.000Z') });
  assert.strictEqual(cp.git.branch, null);
  assert.strictEqual(cp.git.commit, null);
  assert.deepStrictEqual(cp.git.dirty, []);
});

test('rename entries in porcelain keep the new path', function () {
  const proj = tmpProject();
  const cp = checkpoint.create(proj, { summary: 'x' }, {
    run: fakeGit({ status: 'R  old.js -> src/renamed.js\n M keep.js\n' }),
    now: clockAt('2026-07-12T10:00:00.000Z'),
  });
  assert.deepStrictEqual(cp.git.dirty, ['src/renamed.js', 'keep.js']);
});

test('contentHash is canonical: identical body -> identical hash, changed body -> changed hash', function () {
  const proj1 = tmpProject();
  const proj2 = tmpProject();
  const a = checkpoint.create(proj1, { summary: 'same', provider: 'p' }, { run: fakeGit(), now: clockAt('2026-07-12T10:00:00.000Z') });
  const b = checkpoint.create(proj2, { summary: 'same', provider: 'p' }, { run: fakeGit(), now: clockAt('2026-07-12T10:00:00.000Z') });
  assert.strictEqual(a.contentHash, b.contentHash, 'same body -> same hash (both parent=null)');

  const c = checkpoint.create(proj1, { summary: 'DIFFERENT', provider: 'p' }, { run: fakeGit(), now: clockAt('2026-07-12T10:00:00.000Z') });
  assert.notStrictEqual(a.contentHash, c.contentHash, 'changed summary -> changed hash');
});

// ---- HOSTILE: secrets must never reach a checkpoint ----
const ANTHROPIC = 'sk-ant-api03-ABCDEFGHIJKLMNOP1234567890';
const GH = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

test('secret leakage: summary prose, provider, and nested task fields are all redacted', function () {
  const proj = tmpProject();
  const cp = checkpoint.create(proj, {
    summary: 'shipped it; leaked key ' + ANTHROPIC + ' oops',
    provider: 'relay ' + GH,
    tasksSnapshot: [
      { id: 't1', title: 'deploy', api_key: ANTHROPIC, note: 'token is ' + GH + ' keep' },
      { id: 't2', title: 'ok', env: { NAME: 'ANTHROPIC_API_KEY' } }, // env VAR NAME must survive
    ],
  }, { run: fakeGit(), now: clockAt('2026-07-12T10:00:00.000Z') });

  // the returned object
  const asText = JSON.stringify(cp);
  assert.strictEqual(asText.indexOf(ANTHROPIC), -1, 'no anthropic key in the checkpoint object');
  assert.strictEqual(asText.indexOf(GH), -1, 'no github token in the checkpoint object');

  // the on-disk files (both id.json and latest.json)
  const dir = checkpoint.checkpointsDir(proj);
  const idRaw = fs.readFileSync(path.join(dir, cp.id + '.json'), 'utf8');
  const latestRaw = fs.readFileSync(path.join(dir, 'latest.json'), 'utf8');
  [idRaw, latestRaw].forEach(function (raw) {
    assert.strictEqual(raw.indexOf(ANTHROPIC), -1, 'no anthropic key on disk');
    assert.strictEqual(raw.indexOf(GH), -1, 'no github token on disk');
  });

  // prose is preserved around the mask; the mask token is present
  assert.ok(cp.summary.indexOf('shipped it;') === 0 && cp.summary.indexOf('oops') !== -1, 'summary prose kept');
  assert.ok(cp.summary.indexOf(secretscan.REDACTED) !== -1, 'summary secret masked');
  assert.strictEqual(cp.tasksSnapshot[0].api_key, secretscan.REDACTED, 'credential-keyed value dropped');
  assert.strictEqual(cp.tasksSnapshot[0].title, 'deploy', 'non-secret task field kept');
  assert.strictEqual(cp.tasksSnapshot[1].env.NAME, 'ANTHROPIC_API_KEY', 'env-var NAME (not a value) survives');
});

test('secret leakage: a secret in a git dirty path is redacted too', function () {
  const proj = tmpProject();
  const cp = checkpoint.create(proj, { summary: 'x' }, {
    run: fakeGit({ status: ' M creds-' + ANTHROPIC + '.txt\n' }),
    now: clockAt('2026-07-12T10:00:00.000Z'),
  });
  assert.strictEqual(JSON.stringify(cp.git.dirty).indexOf(ANTHROPIC), -1, 'secret in a filename is masked');
});

test('secret leakage: credential-keyed ARRAY values are redacted, not just string leaves', function () {
  // Regression (Wave-4 review): deepRedact must keep the key context when recursing into arrays,
  // else a plaintext secret stored as an array element under a credential-shaped key slips through
  // (it is not token-SHAPED, so only the credential-KEY rule can catch it).
  const proj = tmpProject();
  const cp = checkpoint.create(proj, {
    summary: 'x',
    tasksSnapshot: { password: ['hunter2'], api_key: ['AKIA-plaintext'], nested: { access_token: ['tok-plain'], secret: ['sk-plain'] } },
  }, { run: fakeGit(), now: clockAt('2026-07-12T10:00:00.000Z') });

  const j = JSON.stringify(cp.tasksSnapshot);
  ['hunter2', 'AKIA-plaintext', 'tok-plain', 'sk-plain'].forEach(function (leak) {
    assert.strictEqual(j.indexOf(leak), -1, 'plaintext under a credential key must not survive: ' + leak);
  });
  assert.strictEqual(cp.tasksSnapshot.password[0], secretscan.REDACTED, 'array element redacted');
  assert.strictEqual(cp.tasksSnapshot.nested.access_token[0], secretscan.REDACTED, 'nested array element redacted');
});

test('prototype-pollution: a __proto__ key in tasksSnapshot cannot pollute Object.prototype', function () {
  const proj = tmpProject();
  const hostile = JSON.parse('{"tasks":[{"__proto__":{"polluted":true},"title":"ok"}]}');
  checkpoint.create(proj, { summary: 'x', tasksSnapshot: hostile }, { run: fakeGit(), now: clockAt('2026-07-12T10:00:00.000Z') });
  assert.strictEqual({}.polluted, undefined, 'Object.prototype not polluted');
});
