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
import { makeCtx } from './helpers.js';

const HAS_GIT = vcs.gitAvailable();
function find(checks, name) {
  return checks.filter(function (c) {
    return c.name === name;
  })[0];
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
