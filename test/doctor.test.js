'use strict';
// Tests for the `keyflip doctor` state-hygiene checks (src/doctor.js diagnose). The git checks
// need the enabled VCS path, so this file clears KEYFLIP_VCS (the rest of the suite runs with it
// off). Skips the git tests if git is absent.
delete process.env.KEYFLIP_VCS;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const doctor = require('../src/doctor');
const vcs = require('../src/vcs');
const { makeCtx } = require('./helpers');

const HAS_GIT = vcs.gitAvailable();
function find(checks, name) { return checks.filter(function (c) { return c.name === name; })[0]; }

test('secrets in git: clean repo passes', async function (t) {
  if (!HAS_GIT) return t.skip('git not installed');
  const ctx = makeCtx();
  fs.writeFileSync(path.join(ctx.configDir, 'a.json'), '{"name":"a"}');
  vcs.ensureRepo(ctx); vcs.commit(ctx, 'seed');
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
  fs.writeFileSync(path.join(ctx.configDir, '.usage-cache.json'), JSON.stringify({ hot: { usage: { fiveHour: { pct: 97 } } }, cool: { usage: { fiveHour: { pct: 20 } } } }));
  const r = await doctor.diagnose(ctx);
  const c = find(r.checks, 'quota headroom');
  assert.ok(c && c.ok === 'warn' && /hot/.test(c.detail) && !/cool/.test(c.detail));
});
