// Tests for the `keyflip doctor` state-hygiene checks (src/doctor.js diagnose). The git checks
// need the enabled VCS path, so this file clears KEYFLIP_VCS (the rest of the suite runs with it
// off). Skips the git tests if git is absent.
delete process.env.KEYFLIP_VCS;

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import cp from 'child_process';
import * as doctor from '../src/doctor.js';
import * as vcs from '../src/vcs.js';
import * as config from '../src/config.js';
import * as profiles from '../src/profiles.js';
import * as schedule from '../src/schedule.js';
import * as threads from '../src/threads.js';
import * as instances from '../src/instances.js';
import { makeCtx } from './helpers.js';

const HAS_GIT = vcs.gitAvailable();
function find(checks, name) {
  return checks.filter(function (c) {
    return c.name === name;
  })[0];
}

// Synthesize what createInstance() leaves on disk — without cloning a real /Applications app.
function fakeInstance(ctx, tool, slug, opts) {
  opts = opts || {};
  const dir = path.join(ctx.instancesBase, tool, slug);
  const userDataDir = path.join(dir, 'User Data');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'Config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ tool: tool, slug: slug }));
  if (opts.framework) {
    const app = path.join(dir, instances.TOOL_ADAPTERS[tool].appName, 'Contents', 'Frameworks');
    fs.mkdirSync(path.join(app, opts.framework + '.framework'), { recursive: true });
  }
  if (opts.config) fs.writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify(opts.config));
  return { dir: dir, userDataDir: userDataDir };
}

test('secrets in git: clean repo passes', async function (t) {
  if (!HAS_GIT) return t.skip('git not installed');
  const ctx = makeCtx();
  fs.writeFileSync(path.join(ctx.configDir, 'a.json'), '{"name":"a"}');
  vcs.ensureRepo(ctx);
  vcs.commit(ctx, 'seed');
  const r = await doctor.diagnose(ctx);
  const c = find(r.checks, 'secrets in git');
  assert.ok(c && c.ok === true, 'clean repo has no tracked secrets');
});

test('secrets in git: a tracked secret FAILS with a git rm --cached fix', async function (t) {
  if (!HAS_GIT) return t.skip('git not installed');
  const ctx = makeCtx();
  vcs.ensureRepo(ctx);
  // force-add a secret that the .gitignore would normally exclude, to simulate a legacy leak
  fs.mkdirSync(path.join(ctx.configDir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(ctx.configDir, 'app', 'work.json'), '{"oauth:token":"sk-ant-SECRET"}');
  cp.execFileSync('git', ['-C', ctx.configDir, 'add', '-f', 'app/work.json']);
  const r = await doctor.diagnose(ctx);
  const c = find(r.checks, 'secrets in git');
  assert.ok(c && c.ok === false, 'the leaked secret is flagged');
  assert.ok(/app\/work\.json/.test(c.detail));
  assert.ok(/git .*rm --cached/.test(c.fix), 'offers the remediation');
  assert.strictEqual(r.ok, false, 'overall doctor is not ok when a secret is tracked');
});

test('orphaned sessions surface as a warning with a rebind fix', async function () {
  const ctx = makeCtx();
  ctx.claudeDir = path.join(ctx.home, '.claude');
  const dir = path.join(ctx.claudeDir, 'projects', '-Users-me-gone');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 's1.jsonl'), JSON.stringify({ cwd: '/Users/me/gone-forever-' + process.pid }) + '\n');
  const r = await doctor.diagnose(ctx);
  const c = find(r.checks, 'orphaned sessions');
  assert.ok(c && c.ok === 'warn', 'orphan is an advisory warning, not a hard fail');
  assert.ok(/rebind/.test(c.fix));
});

test('a session the desktop app still lists is NOT called an orphan — it is a stale cwd', async function () {
  const ctx = makeCtx();
  ctx.claudeDir = path.join(ctx.home, '.claude');
  ctx.appDataDir = path.join(ctx.home, 'AppSupport');
  const gone = '/Users/me/worktree-pruned-' + process.pid;
  const dir = path.join(ctx.claudeDir, 'projects', '-Users-me-live-but-gone');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run1.jsonl'), JSON.stringify({ cwd: gone }) + '\n');
  const store = path.join(ctx.appDataDir, 'claude-code-sessions', 'acct', 'org');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'local_x.json'), JSON.stringify({ cliSessionId: 'run1', cwd: gone }));

  const r = await doctor.diagnose(ctx);
  assert.strictEqual(find(r.checks, 'orphaned sessions').ok, true, 'no orphan claim for a live session');
  const stale = find(r.checks, 'live sessions with a stale cwd');
  assert.ok(stale && stale.ok === 'warn', 'reported as an advisory path mismatch instead');
  assert.ok(/do not delete/.test(stale.detail + (stale.fix || '')), 'the wording forbids deletion');
});

test('doctor surfaces rebind backups and offers the proven-redundant prune', async function () {
  const ctx = makeCtx();
  ctx.claudeDir = path.join(ctx.home, '.claude');
  const projects = path.join(ctx.claudeDir, 'projects');
  const OLD = '/Users/me/old-' + process.pid,
    NEW = '/Users/me/new-' + process.pid;
  const sessions = await import('../src/sessions.js');
  const oldDir = path.join(projects, sessions.encodeCwd(OLD));
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'b1.jsonl'), JSON.stringify({ cwd: OLD }) + '\n');
  const res = sessions.rebind(ctx, OLD, NEW, {});
  assert.ok(res.backup, 'rebind left a .keyflip-bak behind');
  const r = await doctor.diagnose(ctx);
  const c = find(r.checks, 'rebind backups');
  assert.ok(c && c.ok === 'warn', 'the duplicate snapshot is visible in doctor');
  assert.ok(/sessions backups --apply/.test(c.fix || ''), 'and it names the fix');
});

test('doctor surfaces an un-redacted keepsake original that only the .pre-scrub copy still holds', async function () {
  const memory = await import('../src/memory.js');
  const leakscan = await import('../src/leakscan.js');
  const KEY = 'sk-ant-api03-' + 'AbCdEfGhIjKlMnOpQrStUvWx'.repeat(2);
  const ctx = makeCtx();
  ctx.claudeDir = path.join(ctx.home, '.claude');
  let c = find((await doctor.diagnose(ctx)).checks, 'keepsake originals');
  assert.ok(c && c.ok === true && /none/.test(c.detail), 'nothing pending is not a warning');

  memory.save(ctx, 'k1', 'key: ' + KEY + '\n');
  leakscan.keepsakeScrub(ctx, memory); // leaves k1.md.pre-scrub holding the raw key
  c = find((await doctor.diagnose(ctx)).checks, 'keepsake originals');
  assert.strictEqual(c.ok, 'warn', 'a secret left on disk by design must be visible');
  assert.match(c.detail, /UNREDACTED original/);
  assert.match(c.fix || '', /--drop-copies/, 'and it names the way out');
  // The scan reports a COUNT, never the secret it is warning about.
  const r = await doctor.diagnose(ctx);
  assert.strictEqual(JSON.stringify(r.checks).indexOf(KEY), -1, 'doctor output carries no secret value');

  leakscan.dropKeepsakeCopies(ctx, memory);
  c = find((await doctor.diagnose(ctx)).checks, 'keepsake originals');
  assert.strictEqual(c.ok, true, 'dropped => quiet again');
});

test('doctor reports empty project folders (and keeps quiet when there are none)', async function () {
  const ctx = makeCtx();
  ctx.claudeDir = path.join(ctx.home, '.claude');
  const projects = path.join(ctx.claudeDir, 'projects');
  fs.mkdirSync(path.join(projects, '-Users-me-nothing'), { recursive: true });
  let r = await doctor.diagnose(ctx);
  const c = find(r.checks, 'empty project folders');
  assert.ok(c && c.ok === 'warn' && /sessions empty --apply/.test(c.fix || ''));
  fs.rmSync(path.join(projects, '-Users-me-nothing'), { recursive: true, force: true });
  r = await doctor.diagnose(ctx);
  assert.strictEqual(find(r.checks, 'empty project folders'), undefined, 'nothing to report -> no line');
});

test('a corrupt settings.json FAILS; a valid one stays quiet', async function () {
  const ctx = makeCtx();
  ctx.claudeSettingsPath = path.join(ctx.home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(ctx.claudeSettingsPath), { recursive: true });
  fs.writeFileSync(ctx.claudeSettingsPath, '{ not: valid json');
  let r = await doctor.diagnose(ctx);
  assert.ok(find(r.checks, 'settings.json') && find(r.checks, 'settings.json').ok === false);
  fs.writeFileSync(ctx.claudeSettingsPath, '{"env":{"ANTHROPIC_MODEL":"opus"}}');
  r = await doctor.diagnose(ctx);
  assert.strictEqual(find(r.checks, 'settings.json'), undefined, 'a valid settings file produces no check line');
});

test('quota pressure warns only when an account is near its limit', async function () {
  const ctx = makeCtx();
  fs.writeFileSync(
    path.join(ctx.configDir, '.usage-cache.json'),
    JSON.stringify({ hot: { usage: { fiveHour: { pct: 97 } } }, cool: { usage: { fiveHour: { pct: 20 } } } }),
  );
  const r = await doctor.diagnose(ctx);
  const c = find(r.checks, 'quota headroom');
  assert.ok(c && c.ok === 'warn' && /hot/.test(c.detail) && !/cool/.test(c.detail));
});

// ---- the desktop app's LIVE session (the token cache cannot answer this) ----
// keyflip's "app ✓" means a restorable capture exists; the app itself can still be
// signed out, because it re-mints its token cache from a claude.ai session cookie and
// shows its sign-in screen without one. `doctor` must say so.
import os from 'os';
function appCtxWithJar(jarBody) {
  const ctx = makeCtx();
  const ad = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-doctor-app-'));
  ctx.appDataDir = ad;
  if (jarBody !== null) fs.writeFileSync(path.join(ad, 'Cookies'), jarBody);
  return ctx;
}

test('doctor: warns when the app jar has no session cookie', async function () {
  const ctx = appCtxWithJar('lastActiveOrg COOKIES-NO-SESSION');
  const r = await doctor.diagnose(ctx);
  const c = find(r.checks, 'desktop app session');
  assert.ok(c && c.ok === 'warn', 'advisory, not a failure: the CLI may be fine');
  assert.match(c.detail, /no claude.ai session cookie/);
  assert.match(c.fix, /sign in once/, 'and it names the only real fix (a restore cannot mint the cookie)');
});

test('doctor: passes when the app jar holds a session cookie', async function () {
  const ctx = appCtxWithJar('sessionKey COOKIES-LIVE');
  const r = await doctor.diagnose(ctx);
  const c = find(r.checks, 'desktop app session');
  assert.ok(c && c.ok === true, 'signed in: ' + (c && c.detail));
});

test('doctor: says nothing about an app that is not installed', async function () {
  const r = await doctor.diagnose(makeCtx()); // no appDataDir
  assert.strictEqual(find(r.checks, 'desktop app session'), undefined);
});

test('doctor: a just-updated app with no session is named as a post-update gap', async function () {
  // The real bug behind "it used to work": an in-app update relaunches the app before Chromium
  // flushes the claude.ai session cookie to disk. Dating the bundle lets doctor explain that
  // instead of implying the capture broke.
  const ctx = appCtxWithJar('lastActiveOrg NO-SESSION');
  const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-bundle-'));
  fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'Contents', 'MacOS', 'Claude'), 'BIN');
  fs.writeFileSync(
    path.join(bundle, 'Contents', 'Info.plist'),
    'CFBundleShortVersionString\u0000' + '\u0000'.repeat(6) + '9.9.9',
  );
  ctx.appBundlePath = bundle;
  const r = await doctor.diagnose(ctx);
  const c = find(r.checks, 'desktop app session');
  assert.ok(c && c.ok === 'warn');
  assert.match(c.detail, /UPDATED/, c.detail);
  assert.match(c.detail, /v9\.9\.9/, 'names the new version');
  assert.match(c.fix, /post-update timing gap/, 'explains it is timing, not a broken capture');
});

test('doctor: an OLD app bundle does not claim "just updated"', async function () {
  const ctx = appCtxWithJar('lastActiveOrg NO-SESSION');
  const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-bundle-old-'));
  fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
  const bin = path.join(bundle, 'Contents', 'MacOS', 'Claude');
  fs.writeFileSync(bin, 'BIN');
  const old = new Date(Date.now() - 10 * 86400000); // ten days ago
  fs.utimesSync(bin, old, old);
  ctx.appBundlePath = bundle;
  const c = find((await doctor.diagnose(ctx)).checks, 'desktop app session');
  assert.doesNotMatch(c.detail, /UPDATED/, 'stale bundle -> the plain signed-out message, not the update story');
});

// --- #40: a chore's cost belongs in doctor, because nobody re-reads a schedule they set months ago,
// and a nightly job that quietly moved back onto the subscription is otherwise invisible. ---
test('chore provider: names the model and whose quota it burns', async function () {
  const ctx = makeCtx();
  const c = find((await doctor.diagnose(ctx)).checks, 'chore provider');
  assert.ok(c && c.ok === true, 'an on-demand chore on the default provider is not a warning');
  assert.match(c.detail, /^claude — spends the ACTIVE Claude account/);
  assert.match(c.detail, /on demand only/, 'and says there is no unattended job');

  config.set(ctx, 'llm.provider', 'ollama');
  const o = find((await doctor.diagnose(ctx)).checks, 'chore provider');
  assert.match(o.detail, /ollama qwen2\.5:7b-instruct/, 'the resolved model is shown, not guessed');
  assert.match(o.detail, /locally/i, 'with its cost');
});

test('chore provider: a nightly job still distilling on the subscription is a warning', async function () {
  const ctx = makeCtx();
  schedule.writeRecord(ctx, {
    installedAt: '2026-01-01T00:00:00.000Z',
    kind: 'cron',
    at: { h: 2, m: 0 },
    days: 30,
    provider: 'claude',
    model: '',
  });
  const c = find((await doctor.diagnose(ctx)).checks, 'chore provider');
  assert.strictEqual(c.ok, 'warn', 'unattended + subscription quota is worth surfacing');
  assert.match(c.fix, /--provider ollama/, 'and it offers the way off');
});

test('chore provider: a schedule whose cost changed after install is called out', async function () {
  const ctx = makeCtx();
  schedule.writeRecord(ctx, {
    installedAt: '2026-01-01T00:00:00.000Z',
    kind: 'cron',
    at: { h: 2, m: 0 },
    days: 30,
    provider: 'ollama',
    model: 'qwen2.5:7b-instruct',
  });
  config.set(ctx, 'llm.provider', 'claude');
  const c = find((await doctor.diagnose(ctx)).checks, 'chore provider');
  assert.strictEqual(c.ok, 'warn');
  assert.match(c.detail, /scheduled on "ollama"/, 'the install receipt and the live config must agree');
});

// #39 — the credential-chain row. The distinction being tested is the one that keeps doctor honest:
// a relationship problem (a stale capture, four accounts in one browser profile) is advisory, while
// a secret keyflip itself left world-readable is the only thing that may turn the row red.
test('doctor: credential chains are clean until a state-repo secret is world-readable', async function (t) {
  if (process.platform === 'win32') return t.skip('POSIX permissions not applicable on Windows');
  const ctx = makeCtx();
  const clean = find((await doctor.diagnose(ctx)).checks, 'credential chains');
  assert.ok(clean, 'the row exists');
  assert.strictEqual(clean.ok, true);
  assert.match(clean.detail, /mapped over 0 account\(s\)/);

  fs.mkdirSync(path.join(ctx.configDir, 'browser-sessions'), { recursive: true });
  fs.writeFileSync(path.join(ctx.configDir, 'browser-sessions', 'work__chrome.sql'), 'cookies');
  fs.chmodSync(path.join(ctx.configDir, 'browser-sessions', 'work__chrome.sql'), 0o644);
  const bad = find((await doctor.diagnose(ctx)).checks, 'credential chains');
  assert.strictEqual(bad.ok, false, 'a 644 cookie dump in the git-versioned state repo is a live exposure');
  assert.match(bad.detail, /loose-mode/);
  assert.match(bad.fix || '', /keyflip chains --tighten --apply/);

  // Fix it the way the row says, and the row goes back to green — the fix text must actually work.
  fs.chmodSync(path.join(ctx.configDir, 'browser-sessions', 'work__chrome.sql'), 0o600);
  const fixed = find((await doctor.diagnose(ctx)).checks, 'credential chains');
  assert.strictEqual(fixed.ok, 'warn', 'a capture of an account with no profile is still worth mentioning');
  assert.match(fixed.detail, /orphan-capture/);
  assert.match(fixed.fix || '', /keyflip chains/);
});

test('doctor: a shared browser profile is advisory, never a permanent red', async function () {
  const ctx = makeCtx();
  profiles.write(ctx.configDir, { name: 'alpha', email: 'a@example.com' });
  profiles.write(ctx.configDir, { name: 'beta', email: 'b@example.com' });
  fs.mkdirSync(path.join(ctx.configDir, 'browser-sessions'), { recursive: true });
  ['alpha', 'beta'].forEach(function (a) {
    const p = path.join(ctx.configDir, 'browser-sessions', a + '__chrome.sql');
    fs.writeFileSync(p, 'cookies');
    fs.chmodSync(p, 0o600);
  });
  const c = find((await doctor.diagnose(ctx)).checks, 'credential chains');
  assert.strictEqual(c.ok, 'warn', 'several accounts on one profile is structural reality, not a red ✗');
  assert.match(c.detail, /shared-source/);
  assert.match(c.detail, /\d+ node\(s\)/, 'it names the map size, so the row is a measurement not a mood');
});

// #36: a stored token expires on the calendar, not at switch time — so the row doctor must give is
// "is anything renewing them?", read from the install receipt rather than from ~/Library (doctor
// stays offline and hermetic, and the receipt is the schedule keyflip itself agreed to).
test('doctor: nothing renews the stored tokens until the refresh job is scheduled', async function () {
  const ctx = makeCtx();
  assert.strictEqual(
    find((await doctor.diagnose(ctx)).checks, 'token renewal'),
    undefined,
    'no accounts saved = nothing that can expire = nothing to nag about',
  );
  profiles.write(ctx.configDir, { name: 'alpha', email: 'a@example.com' });
  const bad = find((await doctor.diagnose(ctx)).checks, 'token renewal');
  assert.ok(bad, 'the row appears once there is a token that can die');
  assert.strictEqual(bad.ok, 'warn');
  assert.match(bad.detail, /1 saved account\(s\) and nothing renews their tokens/);
  assert.match(bad.fix || '', /keyflip refresh --schedule/, 'the fix is the command that closes the gap');
  // The `dream` receipt must not be mistaken for a renewal schedule: it distills chats, it does not
  // rotate tokens.
  schedule.writeRecord(ctx, {
    installedAt: '2026-01-01T00:00:00.000Z',
    job: 'dream',
    kind: 'cron',
    provider: 'claude',
  });
  assert.strictEqual(find((await doctor.diagnose(ctx)).checks, 'token renewal').ok, 'warn');
  schedule.writeRecord(
    ctx,
    { installedAt: '2026-01-01T00:00:00.000Z', job: 'refresh', kind: 'cron', at: { h: 4, m: 30 } },
    { job: 'refresh' },
  );
  const good = find((await doctor.diagnose(ctx)).checks, 'token renewal');
  assert.strictEqual(good.ok, true);
  assert.match(good.detail, /renewed nightly at 04:30/);
  assert.strictEqual(good.fix, undefined, 'a green row needs no fix');
  assert.strictEqual(fs.existsSync(path.join(ctx.configDir, schedule.RECORD_NAME)), true, 'the dream receipt survived');
});

// #35: a thread is only a NAME until it is checked. Three silent failures this row exists to catch:
// a file that no longer parses, a member no account can be resolved for (`threads open` would resume
// it under whatever account is active now — the exact bug threads were built to kill), and the mirror
// switch being on without the user remembering conversation text is on disk. Stat-only: no transcript
// is read and no subprocess runs, so the row is cheap enough for every `doctor`.
test('doctor: threads are named, checked and fixed — and the row never prints an absolute path', async function () {
  const ctx = makeCtx();
  const none = find((await doctor.diagnose(ctx)).checks, 'threads');
  assert.strictEqual(none.ok, true);
  assert.match(none.detail, /none named yet/, 'the empty state points at the command that fills it');

  // A thread spanning two accounts is the success case, and it is described as one.
  threads.create(ctx, { slug: 'design', title: 'Threads design' });
  threads.addMember(ctx, 'design', { kind: 'session', id: 'aaaaaaaa-1111-4111-8111-111111111111', account: 'gmail' });
  threads.addMember(ctx, 'design', { kind: 'chat', id: 'dddddddd-4444-4444-8444-444444444444', account: 'yahoo' });
  const good = find((await doctor.diagnose(ctx)).checks, 'threads');
  assert.strictEqual(good.ok, true, 'a complete thread is green');
  assert.match(
    good.detail,
    /1 named task\(s\), 2 member\(s\) \(1 session\(s\), 1 chat\(s\)\), 1 spanning 2\+ accounts/,
  );
  assert.match(good.detail, /pointers only \(mirror off\)/);
  assert.strictEqual(good.detail.indexOf(ctx.configDir), -1, 'the state repo path stays out of the row');

  // A dangling pointer is a warning with the one command that fixes it.
  threads.addMember(ctx, 'design', { kind: 'session', id: 'bbbbbbbb-2222-4222-8222-222222222222' });
  const loose = find((await doctor.diagnose(ctx)).checks, 'threads');
  assert.strictEqual(loose.ok, 'warn');
  assert.match(loose.detail, /1 member\(s\) have no account \(design\)/);
  assert.match(loose.fix, /keyflip sessions assign/, 'the fix names the assignment command');

  // A hand-edited file that no longer parses is REPORTED, never counted as zero threads.
  fs.writeFileSync(path.join(threads.dir(ctx), 'broken.json'), '{ this is not json', { mode: 0o600 });
  const bad = find((await doctor.diagnose(ctx)).checks, 'threads');
  assert.strictEqual(bad.ok, 'warn');
  assert.match(bad.detail, /unreadable or holding invalid members \(broken\)/);
  assert.match(bad.fix, /keyflip threads show/, 'and it says where to look');

  // Mirror on: the row states what is now on disk, in relative terms.
  config.set(ctx, 'threads.mirror', true);
  fs.mkdirSync(threads.mirrorDir(ctx), { recursive: true });
  fs.writeFileSync(path.join(threads.mirrorDir(ctx), 'design.md'), '# conversation text', { mode: 0o600 });
  fs.rmSync(path.join(threads.dir(ctx), 'broken.json'));
  const mirrored = find((await doctor.diagnose(ctx)).checks, 'threads');
  assert.strictEqual(mirrored.ok, 'warn', 'the unassigned member still warns');
  assert.match(
    mirrored.detail,
    /mirror ON — 1 text file\(s\) in thread-mirror\/ \(0600, never versioned or backed up\)/,
  );
  assert.strictEqual(mirrored.detail.indexOf(ctx.configDir), -1, 'even with the mirror on, no absolute path leaks');
});

test('desktop auto-updates: the base Claude app updating is normal, not a warning', async function () {
  const ctx = makeCtx();
  ctx.appDataDir = path.join(ctx.home, 'Claude');
  fs.mkdirSync(ctx.appDataDir, { recursive: true });
  const c = find((await doctor.diagnose(ctx)).checks, 'desktop auto-updates');
  assert.ok(c, 'the check is present whenever there is a Claude app dir');
  assert.strictEqual(c.ok, true, 'the unmodified base install updates itself by design');
  assert.match(c.detail, /Claude app: updates ON/);
});

test('desktop auto-updates: the base Claude config switch is read live', async function () {
  const ctx = makeCtx();
  ctx.appDataDir = path.join(ctx.home, 'Claude');
  fs.mkdirSync(ctx.appDataDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.appDataDir, 'config.json'), JSON.stringify({ disableAutoUpdates: true }));
  const c = find((await doctor.diagnose(ctx)).checks, 'desktop auto-updates');
  assert.strictEqual(c.ok, true);
  assert.match(c.detail, /Claude app: updates off/);
});

test('desktop auto-updates: an unhardened Claude clone warns with the universal harden command', async function () {
  const ctx = makeCtx();
  ctx.instancesBase = path.join(ctx.home, 'instances');
  fakeInstance(ctx, 'claude', 'yahoo');
  const c = find((await doctor.diagnose(ctx)).checks, 'desktop auto-updates');
  assert.ok(c, 'instances alone are enough to run the check');
  assert.strictEqual(c.ok, 'warn', 'a clone that can self-update is a real risk');
  assert.match(c.detail, /claude\/yahoo: updates ON/);
  assert.match(c.fix, /keyflip instance harden claude yahoo/);
});

test('desktop auto-updates: a hardened Claude clone passes', async function () {
  const ctx = makeCtx();
  ctx.instancesBase = path.join(ctx.home, 'instances');
  fakeInstance(ctx, 'claude', 'yahoo', { config: { disableAutoUpdates: true } });
  const c = find((await doctor.diagnose(ctx)).checks, 'desktop auto-updates');
  assert.strictEqual(c.ok, true);
  assert.match(c.detail, /claude\/yahoo: updates off/);
  assert.strictEqual(c.fix, undefined, 'nothing to fix');
});

test('desktop auto-updates: autoUpdate.disabled wins over the flat key, exactly like Claude', async function () {
  const ctx = makeCtx();
  ctx.instancesBase = path.join(ctx.home, 'instances');
  const inst = fakeInstance(ctx, 'claude', 'yahoo', {
    config: { disableAutoUpdates: true, autoUpdate: { disabled: false } },
  });
  const st = instances.updateState('claude', inst.userDataDir, path.join(inst.dir, 'Claude.app'));
  assert.strictEqual(st.state, 'enabled', 'the nested key has precedence in Claude, so mirror it');
});

test('desktop auto-updates: a tool with no switch is reported, never nagged', async function () {
  const ctx = makeCtx();
  ctx.instancesBase = path.join(ctx.home, 'instances');
  fakeInstance(ctx, 'kiro', 'work', { framework: 'Squirrel' });
  const c = find((await doctor.diagnose(ctx)).checks, 'desktop auto-updates');
  assert.strictEqual(c.ok, true, 'keyflip cannot disable Kiro updates, so this is not the user’s fault');
  assert.match(c.detail, /kiro\/work: uncontrollable \(squirrel\)/);
});

test('instance harden: writes the Claude switch without clobbering existing config', async function () {
  const ctx = makeCtx();
  ctx.instancesBase = path.join(ctx.home, 'instances');
  const inst = fakeInstance(ctx, 'claude', 'yahoo');
  // The nested key outranks the flat one, so harden must flip both when it is already present.
  fs.writeFileSync(
    path.join(inst.userDataDir, 'config.json'),
    JSON.stringify({ locale: 'en-US', autoUpdate: { disabled: false, channel: 'stable' } }),
  );

  const st = instances.hardenInstance('claude', 'yahoo', ctx.instancesBase);
  assert.strictEqual(st.state, 'disabled');
  const cfg = JSON.parse(fs.readFileSync(path.join(inst.userDataDir, 'config.json'), 'utf8'));
  assert.strictEqual(cfg.locale, 'en-US', 'unrelated keys survive');
  assert.strictEqual(cfg.disableAutoUpdates, true);
  assert.strictEqual(cfg.autoUpdate.disabled, true, 'the winning nested key is flipped too');
  assert.strictEqual(cfg.autoUpdate.channel, 'stable', 'siblings inside autoUpdate survive');

  const meta = JSON.parse(fs.readFileSync(path.join(inst.dir, 'profile.json'), 'utf8'));
  assert.strictEqual(meta.autoUpdateDisabled, true, 'metadata now reflects the live state');
  assert.strictEqual(meta.autoUpdateMethod, 'config');
});

test('instance harden: refuses while the Claude instance runs, because it would rewrite the config', async function (t) {
  if (process.platform === 'win32') return t.skip('PID liveness uses kill -0 (POSIX)');
  const ctx = makeCtx();
  ctx.instancesBase = path.join(ctx.home, 'instances');
  const inst = fakeInstance(ctx, 'claude', 'yahoo');
  fs.writeFileSync(path.join(inst.dir, 'instance.pid'), String(process.pid));
  assert.throws(() => instances.hardenInstance('claude', 'yahoo', ctx.instancesBase), /is running/);
  assert.ok(!fs.existsSync(path.join(inst.userDataDir, 'config.json')), 'nothing written while running');
});
