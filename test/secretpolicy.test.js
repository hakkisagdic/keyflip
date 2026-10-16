// Tests for #44 — the secrets POLICY: what the history scan reports becomes an ALARM or a recorded
// decision, and the difference must never be allowed to mean "leave the secret in the past".
// These own the git path, so KEYFLIP_VCS is cleared (the rest of the suite runs with it off).
delete process.env.KEYFLIP_VCS;

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import cp from 'child_process';
import * as secretpolicy from '../src/secretpolicy.js';
import * as leakscan from '../src/leakscan.js';
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

// Shapes for the scanner to find. Nothing here is a live credential.
const FAKE_ANTHROPIC = 'sk-ant-api03-' + 'AbCdEfGhIjKlMnOpQrStUvWx'.repeat(2);
const FAKE_GOOGLE = 'AIza' + 'Simulated-Not-A-Real-Google-Key-00000';

function git(cfg, args) {
  return cp.execFileSync('git', ['-C', cfg].concat(args), { encoding: 'utf8' });
}
function commitAll(cfg, msg) {
  git(cfg, ['-c', 'user.email=t@keyflip.test', '-c', 'user.name=t', 'add', '-A', '-f']);
  git(cfg, ['-c', 'user.email=t@keyflip.test', '-c', 'user.name=t', 'commit', '-q', '-m', msg]);
}
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
const NOW = function () {
  return '2026-01-01T00:00:00.000Z';
};

// ---- the pattern language ------------------------------------------------------

test('a rule path is repo-relative, and "*" never crosses a directory boundary', function () {
  assert.strictEqual(secretpolicy.matchPath('providers/gmail.json', 'providers/gmail.json'), true);
  assert.strictEqual(secretpolicy.matchPath('providers/gmail.json', 'providers/yahoo.json'), false);
  // a directory prefix
  assert.strictEqual(secretpolicy.matchPath('surfaces/kiro/', 'surfaces/kiro/work/auth.json'), true);
  assert.strictEqual(secretpolicy.matchPath('surfaces/kiro/', 'surfaces/chatgpt/auth.json'), false);
  // the segment rule: `*.json` is a top-level glob, NOT the whole repo
  assert.strictEqual(secretpolicy.matchPath('*.json', 'yahoo.json'), true);
  assert.strictEqual(secretpolicy.matchPath('*.json', 'app/yahoo.json'), false, 'a * cannot cross /');
  assert.strictEqual(secretpolicy.matchPath('app/*.cookies', 'app/claude.cookies'), true);
  assert.strictEqual(secretpolicy.matchPath('app/*.cookies', 'app/sub/claude.cookies'), false);
  // explicit any-path
  assert.strictEqual(secretpolicy.matchPath('*', 'memory/anything.md'), true);
});

test('a pasted absolute path is made relative; a path reaching outside the repo is refused', function () {
  const ctx = makeCtx();
  const inside = secretpolicy.normalizePattern(path.join(ctx.configDir, 'providers', 'gmail.json'), ctx);
  assert.strictEqual(inside.error, undefined);
  assert.strictEqual(inside.pattern, 'providers/gmail.json');
  const outside = secretpolicy.normalizePattern('/etc/passwd', ctx);
  assert.match(outside.error, /not inside the state repo/);
  const up = secretpolicy.normalizePattern('../../.ssh/id_rsa', ctx);
  assert.match(up.error, /cannot contain "\.\."/);
  const empty = secretpolicy.normalizePattern('', ctx);
  assert.match(empty.error, /needs a path/);
});

// ---- writing rules -------------------------------------------------------------

test('a rule is refused if it cannot work: unknown kind, no path, or everything-anywhere', function () {
  const ctx = makeCtx();
  const typo = secretpolicy.addRule(ctx, { path: 'yahoo.json', kinds: ['google-api-ky'], now: NOW });
  assert.strictEqual(typo.ok, false, 'a typo in a KIND would match nothing, forever, silently');
  assert.match(typo.reason, /unknown secret kind/);
  assert.match(typo.reason, /google-api-key/, 'and the refusal names the kinds that DO exist');
  const blanket = secretpolicy.addRule(ctx, { path: '*', now: NOW });
  assert.strictEqual(blanket.ok, false, '"*" with no kind is the scan switched off, not a policy');
  assert.match(blanket.reason, /switched off/);
  const kindOnly = secretpolicy.addRule(ctx, { path: '*', kinds: ['google-api-key'], now: NOW });
  assert.strictEqual(kindOnly.ok, true, 'a KIND that is always fine is a legitimate rule');
  assert.deepStrictEqual(secretpolicy.load(ctx).rules, [
    { path: '*', kinds: ['google-api-key'], addedAt: '2026-01-01T00:00:00.000Z' },
  ]);
});

test('a note carrying a key is redacted before the rule is written — the policy file holds no value', function () {
  const ctx = makeCtx();
  const r = secretpolicy.addRule(ctx, {
    path: 'providers/gmail.json',
    kinds: ['google-api-key'],
    note: 'free tier, the key is ' + FAKE_GOOGLE + ' and ' + FAKE_ANTHROPIC,
    now: NOW,
  });
  assert.strictEqual(r.ok, true);
  assert.ok(r.noteRedacted >= 1, 'the write reports that it sanitized the note');
  const raw = fs.readFileSync(secretpolicy.fileFor(ctx), 'utf8');
  assert.strictEqual(raw.indexOf(FAKE_GOOGLE), -1, 'never the value, in the versioned file');
  assert.strictEqual(raw.indexOf(FAKE_ANTHROPIC), -1);
  assert.match(raw, /keyflip_redacted/);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(secretpolicy.fileFor(ctx)).mode & 0o777, 0o600);
});

test('the policy file is versioned metadata, NOT a secret path — so it travels with backup and undo', function () {
  // It carries paths and KIND names only. If it were git-ignored the policy would reset on every new
  // machine, which is how the alarms come back and the user turns the feature off in anger.
  assert.strictEqual(secretpaths.isSecretFile(secretpolicy.FILE_NAME), false);
  assert.strictEqual(secretpaths.gitignoreLines().indexOf(secretpolicy.FILE_NAME), -1);
  const ctx = makeCtx();
  assert.strictEqual(
    path.dirname(secretpolicy.fileFor(ctx)),
    ctx.configDir,
    'it sits at the root of the state dir, like the other versioned metadata',
  );
});

test('untolerate removes every rule on a path, and the findings are alarms again', function () {
  const ctx = makeCtx();
  secretpolicy.addRule(ctx, { path: 'providers/gmail.json', now: NOW });
  secretpolicy.addRule(ctx, { path: 'providers/gmail.json', kinds: ['jwt'], now: NOW });
  const leaks = [
    { file: 'providers/gmail.json', kinds: ['jwt'], confidence: 'high', trackedNow: false, commits: 2, bytes: 10 },
  ];
  assert.strictEqual(secretpolicy.classify(ctx, leaks).tolerated.length, 1, 'tolerated while a rule exists');
  const r = secretpolicy.removeRule(ctx, { path: 'providers/gmail.json' });
  assert.strictEqual(r.removed.length, 2, 'both rules on that path — no half-policy left');
  assert.strictEqual(secretpolicy.classify(ctx, leaks).alarms.length, 1, 'the alarm is back, immediately');
  const none = secretpolicy.removeRule(ctx, { path: 'providers/gmail.json' });
  assert.strictEqual(none.removed.length, 0);
  assert.match(none.reason, /no rule matched/);
});

// ---- classifying findings ------------------------------------------------------

test('a tolerated kind on a path silences it; another kind on the SAME path is still an alarm', function () {
  const ctx = makeCtx();
  secretpolicy.addRule(ctx, { path: 'providers/gmail.json', kinds: ['google-api-key'], now: NOW });
  const leaks = [
    {
      file: 'providers/gmail.json',
      kinds: ['google-api-key'],
      confidence: 'high',
      trackedNow: false,
      commits: 1,
      bytes: 40,
    },
    {
      file: 'providers/gmail.json',
      kinds: ['github-token'],
      confidence: 'high',
      trackedNow: false,
      commits: 3,
      bytes: 40,
    },
  ];
  const cls = secretpolicy.classify(ctx, leaks);
  assert.strictEqual(cls.tolerated.length, 1);
  assert.strictEqual(cls.alarms.length, 1, 'a permission for one KIND is not a permission for the file');
  assert.strictEqual(cls.tolerated[0].by, 'providers/gmail.json [google-api-key]');
  assert.strictEqual(cls.findings.length, 2, 'nothing is dropped from the report');
});

test('a secret-PATH capture with no shape hit is addressable, as "secret-path-capture"', function () {
  const ctx = makeCtx();
  const leak = { file: 'surfaces/kiro/work/auth.json', kinds: [], secretPath: true, trackedNow: false, commits: 1 };
  assert.deepStrictEqual(secretpolicy.labelsOf(leak), [secretpolicy.PATH_ONLY_LABEL]);
  secretpolicy.addRule(ctx, { path: 'surfaces/kiro/', kinds: [secretpolicy.PATH_ONLY_LABEL], now: NOW });
  const cls = secretpolicy.classify(ctx, [leak]);
  assert.strictEqual(cls.tolerated.length, 1);
  // and a kind rule does NOT cover it, because there is no kind there to cover
  const other = makeCtx();
  secretpolicy.addRule(other, { path: 'surfaces/kiro/', kinds: ['jwt'], now: NOW });
  assert.strictEqual(secretpolicy.classify(other, [leak]).alarms.length, 1);
});

test('the most specific rule is the one named as the reason', function () {
  const ctx = makeCtx();
  secretpolicy.addRule(ctx, { path: 'surfaces/', now: NOW });
  secretpolicy.addRule(ctx, { path: 'surfaces/kiro/work/auth.json', kinds: ['jwt'], now: NOW });
  const cls = secretpolicy.classify(ctx, [
    { file: 'surfaces/kiro/work/auth.json', kinds: ['jwt'], trackedNow: false, commits: 1 },
  ]);
  assert.strictEqual(cls.tolerated[0].by, 'surfaces/kiro/work/auth.json [jwt]');
});

test('a corrupt policy applies NOTHING — the alarms stay on and the report says why', function () {
  const ctx = makeCtx();
  fs.writeFileSync(secretpolicy.fileFor(ctx), '{ this is not json');
  const leaks = [{ file: 'providers/gmail.json', kinds: ['google-api-key'], trackedNow: false, commits: 1 }];
  const pol = secretpolicy.load(ctx);
  assert.strictEqual(pol.rules.length, 0);
  assert.match(pol.error, /not valid JSON/);
  const cls = secretpolicy.classify(ctx, leaks, { policy: pol });
  assert.strictEqual(cls.alarms.length, 1, 'fail CLOSED: unreadable rules are not read as "no rules"');
  assert.match(cls.policyError, /not valid JSON/);
  // an unusable rule line is counted, never silently dropped
  const half = makeCtx();
  fs.writeFileSync(
    secretpolicy.fileFor(half),
    JSON.stringify({ rules: [{ path: 'ok.json' }, { path: '/etc/passwd' }, { path: 'x', kinds: ['not-a-kind'] }] }),
  );
  const p2 = secretpolicy.load(half);
  assert.strictEqual(p2.rules.length, 1);
  assert.strictEqual(p2.dropped, 2, 'and the count of what was NOT applied is reported');
});

// ---- the part that is NOT an exemption ----------------------------------------

test('a tolerated finding is silenced AND STILL in the scrub plan', function (t) {
  if (!HAS_GIT) return t.skip('git not installed');
  const ctx = mkrepo();
  write(ctx, 'providers/gmail.json', '{"apiKey":"' + FAKE_GOOGLE + '"}\n');
  commitAll(ctx.configDir, 'a free-tier key, parked where it belongs');
  fs.rmSync(path.join(ctx.configDir, 'providers'), { recursive: true, force: true });
  commitAll(ctx.configDir, 'removed the file — the blob is still reachable');

  const hist = leakscan.historyLeaks(ctx);
  const leak = hist.leaks.filter(function (l) {
    return l.file === 'providers/gmail.json';
  })[0];
  assert.ok(leak, 'the scan found it');
  assert.ok(leak.kinds.indexOf('google-api-key') !== -1);

  secretpolicy.addRule(ctx, {
    path: 'providers/gmail.json',
    kinds: ['google-api-key'],
    note: 'free tier, known',
    now: NOW,
  });
  const cls = secretpolicy.classify(ctx, hist.leaks);
  assert.strictEqual(cls.alarms.length, 0, 'nothing alarms');
  assert.strictEqual(cls.tolerated.length >= 1, true, 'and it is on the record why');

  const plan = leakscan.planScrub(ctx, hist.leaks, { now: NOW, policy: secretpolicy.load(ctx) });
  assert.ok(plan.paths.indexOf('providers/gmail.json') !== -1, 'THE POINT: tolerating is not leaving it in history');
  assert.deepStrictEqual(plan.toleratedPaths, ['providers/gmail.json']);
  assert.deepStrictEqual(plan.alarmPaths, []);
  assert.strictEqual(plan.warns.join().indexOf('rotated'), -1, 'no rotation advice for a key the user decided about');
  assert.match(plan.warns.join(), /TOLERATED/, 'and the plan SAYS it scrubbed a tolerated path');

  // A file that has one tolerated blob and one alarming blob is NOT taken off the alarm list: the
  // per-file verdict is "any live alarm wins".
  const mixed = makeCtx();
  const mixedLeaks = [
    { file: 'providers/x.json', kinds: ['google-api-key'], trackedNow: false, confidence: 'high' },
    { file: 'providers/x.json', kinds: ['github-token'], trackedNow: false, confidence: 'high' },
  ];
  secretpolicy.addRule(mixed, { path: 'providers/x.json', kinds: ['google-api-key'], now: NOW });
  const mp = leakscan.planScrub(mixed, mixedLeaks, { now: NOW, policy: secretpolicy.load(mixed) });
  assert.deepStrictEqual(mp.alarmPaths, ['providers/x.json']);
  assert.deepStrictEqual(mp.toleratedPaths, []);
  assert.match(mp.warns.join(), /rotated/, 'so the rotation advice stays for the path that still warrants it');
});

test('coverageOf shows how much a broad rule actually silences', function () {
  const ctx = makeCtx();
  secretpolicy.addRule(ctx, { path: '*', kinds: ['google-api-key'], now: NOW });
  const leaks = [
    { file: 'providers/a.json', kinds: ['google-api-key'] },
    { file: 'providers/b.json', kinds: ['google-api-key'] },
    { file: 'providers/c.json', kinds: ['jwt'] },
  ];
  const rule = secretpolicy.load(ctx).rules[0];
  const cov = secretpolicy.coverageOf(ctx, leaks, rule);
  assert.strictEqual(cov.findings, 2);
  assert.deepStrictEqual(cov.paths, ['providers/a.json', 'providers/b.json']);
});

test('a policy with no file at all is an empty policy, not an error', function () {
  const ctx = makeCtx();
  const pol = secretpolicy.load(ctx);
  assert.strictEqual(pol.exists, false);
  assert.strictEqual(pol.error, null);
  deepEmpty(pol.rules);
  const cls = secretpolicy.classify(ctx, [{ file: 'a.json', kinds: ['jwt'], trackedNow: false }]);
  assert.strictEqual(cls.alarms.length, 1, 'and every finding is therefore an alarm');
});
function deepEmpty(arr) {
  assert.deepStrictEqual(arr, []);
}
