'use strict';
// JOB QUEUE / capacity scheduler. Everything IO/time is injected — a fake usage
// `fetch`, a fake `run` (NO real claude), a fixed clock — so the whole scheduler is
// exercised hermetically: enqueue/list/get/clear, headroom-based selection, isolated
// per-account headless runs, fan-out, and the confirm-gated MCP tools.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const orch = require('../src/orchestrator');
const profiles = require('../src/profiles');
const groups = require('../src/groups');
const policy = require('../src/policy');
const { makeCtx } = require('./helpers');

test('runJob is BLOCKED by a policy deny rule for the selected account — nothing spawns', async function () {
  const ctx = makeCtx();
  ctx.store.setProfile('work', JSON.stringify({ claudeAiOauth: { accessToken: 'TW', refreshToken: 'RW', expiresAt: 9999999999999 } }));
  profiles.write(ctx.configDir, { name: 'work', email: 'w@x.com', oauthAccount: { emailAddress: 'w@x.com', organizationUuid: 'o' }, savedAt: ctx.now() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pol-'));
  policy.addRule(ctx, { match: { cwdPrefix: dir }, deny: { accounts: ['work'] } });
  const job = orch.enqueue(ctx, { prompt: 'hi', cwd: dir });
  const rec = [];
  const done = await orch.runJob(ctx, job, { fetch: async function () { return { ok: true, status: 200, json: async function () { return { five_hour: { utilization: 10 } }; } }; }, run: function (b, a, i, o) { rec.push(o); return { code: 0, stdout: 'x' }; } });
  assert.strictEqual(done.status, 'error');
  assert.match(done.error, /policy denied/);
  assert.strictEqual(rec.length, 0, 'a policy-denied job never spawns claude');
});

test('runJob runs in the JOB\'s cwd — the runner is invoked with cwd=job.cwd (exec forwards it)', async function () {
  const ctx = makeCtx();
  ctx.store.setProfile('work', JSON.stringify({ claudeAiOauth: { accessToken: 'TW', refreshToken: 'RW', expiresAt: 9999999999999 } }));
  profiles.write(ctx.configDir, { name: 'work', email: 'w@x.com', oauthAccount: { emailAddress: 'w@x.com', organizationUuid: 'o' }, savedAt: ctx.now() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cwd-'));
  const job = orch.enqueue(ctx, { prompt: 'hi', cwd: dir });
  const rec = [];
  await orch.runJob(ctx, job, { fetch: async function () { return { ok: true, status: 200, json: async function () { return { five_hour: { utilization: 10 } }; } }; }, run: function (b, a, i, o) { rec.push(o); return { code: 0, stdout: 'x' }; } });
  assert.strictEqual(rec.length, 1);
  assert.strictEqual(rec[0].cwd, dir, 'the job cwd is passed to the runner (not the process cwd)');
});

// A stored account = a CLI credential blob (with a distinct accessToken) + metadata.
function seed(ctx, name, email, token) {
  ctx.store.setProfile(name, JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'R' + token, expiresAt: 9999999999999 } }));
  profiles.write(ctx.configDir, { name: name, email: email, oauthAccount: { emailAddress: email, organizationUuid: 'org-' + name }, userID: 'u-' + name, savedAt: ctx.now() });
}

// Fake usage endpoint: map accessToken -> 5h utilization %. headroom = 100 - pct.
// An unmapped token yields a non-ok response (usage unknown).
function fakeFetch(pctByToken) {
  return async function (url, opts) {
    const auth = (opts && opts.headers && opts.headers.Authorization) || '';
    const token = auth.replace(/^Bearer /, '');
    if (!(token in pctByToken)) return { ok: false, status: 500 };
    const pct = pctByToken[token];
    return { ok: true, status: 200, json: async function () { return { five_hour: { utilization: pct, resets_at: null } }; } };
  };
}

// Fake CLI runner: records every invocation, echoes which isolated config dir it ran
// under, and lets a test force a non-zero exit / stderr for a chosen account.
function fakeRun(record, opts) {
  opts = opts || {};
  return function (bin, args, input, o) {
    const dir = o && o.env && o.env.CLAUDE_CONFIG_DIR;
    record.push({ bin: bin, args: args, input: input, cwd: o && o.cwd, configDir: dir, env: o && o.env });
    if (opts.failFor && dir && dir.indexOf(path.sep + opts.failFor) !== -1) return { code: 2, stdout: '', stderr: 'boom for ' + opts.failFor, error: null };
    return { code: 0, stdout: 'answer from ' + dir, stderr: '', error: null };
  };
}

// ---- queue CRUD ----------------------------------------------------------------

test('enqueue persists a queued job with an id, cwd default, and createdAt', function () {
  const ctx = makeCtx();
  const job = orch.enqueue(ctx, { prompt: 'hello' });
  assert.ok(job.id && typeof job.id === 'string');
  assert.strictEqual(job.status, 'queued');
  assert.strictEqual(job.prompt, 'hello');
  assert.strictEqual(job.cwd, process.cwd());
  assert.strictEqual(job.createdAt, ctx.now());
  const onDisk = JSON.parse(fs.readFileSync(orch.jobsPath(ctx), 'utf8'));
  assert.strictEqual(onDisk.jobs.length, 1);
  assert.strictEqual(onDisk.jobs[0].id, job.id);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(orch.jobsPath(ctx)).mode & 0o777, 0o600);
});

test('enqueue rejects an empty prompt and an invalid group', function () {
  const ctx = makeCtx();
  assert.throws(function () { orch.enqueue(ctx, { prompt: '   ' }); }, /non-empty prompt/);
  assert.throws(function () { orch.enqueue(ctx, {}); }, /non-empty prompt/);
  assert.throws(function () { orch.enqueue(ctx, { prompt: 'x', group: '__proto__' }); }, /invalid group/);
  assert.throws(function () { orch.enqueue(ctx, { prompt: 'x', group: '../evil' }); }, /invalid group/);
});

test('list / get reflect what was enqueued; get(unknown) is null', function () {
  const ctx = makeCtx();
  const a = orch.enqueue(ctx, { prompt: 'a', cwd: '/tmp/a' });
  const b = orch.enqueue(ctx, { prompt: 'b', group: 'work' });
  assert.strictEqual(orch.list(ctx).length, 2);
  assert.strictEqual(orch.get(ctx, a.id).prompt, 'a');
  assert.strictEqual(orch.get(ctx, b.id).group, 'work');
  assert.strictEqual(orch.get(ctx, 'nope'), null);
  assert.strictEqual(orch.get(ctx, null), null);
});

test('clear removes all, or only a given status; returns the count removed', function () {
  const ctx = makeCtx();
  orch.enqueue(ctx, { prompt: '1' });
  const two = orch.enqueue(ctx, { prompt: '2' });
  orch.enqueue(ctx, { prompt: '3' });
  // mark one done via the store patch path (through runJob is covered later)
  const st = JSON.parse(fs.readFileSync(orch.jobsPath(ctx), 'utf8'));
  st.jobs.forEach(function (j) { if (j.id === two.id) j.status = 'done'; });
  fs.writeFileSync(orch.jobsPath(ctx), JSON.stringify(st));
  assert.strictEqual(orch.clear(ctx, { status: 'done' }), 1);
  assert.strictEqual(orch.list(ctx).length, 2);
  assert.strictEqual(orch.clear(ctx), 2);
  assert.strictEqual(orch.list(ctx).length, 0);
});

test('a corrupt jobs.json is empty to readers but REFUSES to be clobbered on write', function () {
  const ctx = makeCtx();
  fs.writeFileSync(orch.jobsPath(ctx), '{not json');
  assert.deepStrictEqual(orch.list(ctx), []);        // read-only accessors degrade to empty
  assert.strictEqual(orch.get(ctx, 'x'), null);
  assert.throws(function () { orch.enqueue(ctx, { prompt: 'x' }); }, /not valid JSON/); // write path throws
});

test('readers ignore junk/prototype-polluting entries in a tampered file', function () {
  const ctx = makeCtx();
  fs.writeFileSync(orch.jobsPath(ctx), JSON.stringify({
    jobs: [
      { id: 'ok1', prompt: 'p', status: 'weird', group: '__proto__', account: 'a' }, // status clamped, bad group dropped
      { prompt: 'no-id' },        // no id -> dropped
      42,                          // scalar -> dropped
      { id: 'ok2', prompt: 'q', status: 'done' },
    ],
  }));
  const jobs = orch.list(ctx);
  assert.deepStrictEqual(jobs.map(function (j) { return j.id; }), ['ok1', 'ok2']);
  assert.strictEqual(jobs[0].status, 'queued'); // 'weird' -> default
  assert.ok(!('group' in jobs[0]));            // '__proto__' rejected by isValidTag
  assert.strictEqual({}.polluted, undefined);
});

// ---- account selection ---------------------------------------------------------

test('selectAccount picks the most headroom (best) among runnable accounts', async function () {
  const ctx = makeCtx();
  seed(ctx, 'alpha', 'a@x.com', 'TA'); // 90% used -> 10 headroom
  seed(ctx, 'beta', 'b@x.com', 'TB');  // 20% used -> 80 headroom (winner)
  seed(ctx, 'gamma', 'g@x.com', 'TG'); // 50% used -> 50 headroom
  const name = await orch.selectAccount(ctx, {}, { fetch: fakeFetch({ TA: 90, TB: 20, TG: 50 }) });
  assert.strictEqual(name, 'beta');
});

test('selectAccount honors a group scope', async function () {
  const ctx = makeCtx();
  seed(ctx, 'alpha', 'a@x.com', 'TA');
  seed(ctx, 'beta', 'b@x.com', 'TB');
  seed(ctx, 'gamma', 'g@x.com', 'TG');
  groups.addTag(ctx, 'alpha', 'work');
  groups.addTag(ctx, 'gamma', 'work'); // beta is NOT in work
  // beta has the most headroom overall (99), but it's excluded by the group scope;
  // within 'work', gamma (90 headroom) beats alpha (30 headroom).
  const name = await orch.selectAccount(ctx, { group: 'work' }, { fetch: fakeFetch({ TA: 70, TB: 1, TG: 10 }) });
  assert.strictEqual(name, 'gamma');
});

test('selectAccount ignores app-only accounts (no stored CLI credential)', async function () {
  const ctx = makeCtx();
  seed(ctx, 'alpha', 'a@x.com', 'TA');
  // app-only: metadata but NO credential blob in the store
  profiles.write(ctx.configDir, { name: 'apponly', email: 'z@x.com', savedAt: ctx.now() });
  const name = await orch.selectAccount(ctx, {}, { fetch: fakeFetch({ TA: 40 }) });
  assert.strictEqual(name, 'alpha');
});

test('selectAccount returns null when the pool is empty / group has no runnable members', async function () {
  const ctx = makeCtx();
  assert.strictEqual(await orch.selectAccount(ctx, {}, { fetch: fakeFetch({}) }), null);
  seed(ctx, 'alpha', 'a@x.com', 'TA');
  assert.strictEqual(await orch.selectAccount(ctx, { group: 'nobody' }, { fetch: fakeFetch({ TA: 10 }) }), null);
});

test('selectAccount falls back to a candidate when usage is entirely unknown (offline)', async function () {
  const ctx = makeCtx();
  seed(ctx, 'alpha', 'a@x.com', 'TA');
  seed(ctx, 'beta', 'b@x.com', 'TB');
  // fetch returns non-ok for every token -> all headroom unknown -> still pick one.
  const name = await orch.selectAccount(ctx, {}, { fetch: fakeFetch({}) });
  assert.ok(name === 'alpha' || name === 'beta');
});

// ---- running -------------------------------------------------------------------

test('runJob selects the best account and runs it HEADLESS in an isolated config dir', async function () {
  const ctx = makeCtx();
  seed(ctx, 'alpha', 'a@x.com', 'TA'); // 90 used
  seed(ctx, 'beta', 'b@x.com', 'TB');  // 10 used -> winner
  const job = orch.enqueue(ctx, { prompt: 'do the thing', cwd: '/work/here' });
  const rec = [];
  const done = await orch.runJob(ctx, job, { fetch: fakeFetch({ TA: 90, TB: 10 }), run: fakeRun(rec), env: { PATH: '/bin' } });
  assert.strictEqual(done.status, 'done');
  assert.strictEqual(done.account, 'beta');
  assert.strictEqual(done.finishedAt, ctx.now());
  assert.ok(done.result.indexOf('answer from') === 0);
  // the runner saw: claude -p <prompt>, the job cwd, and an ISOLATED CLAUDE_CONFIG_DIR for beta
  assert.strictEqual(rec.length, 1);
  assert.strictEqual(rec[0].bin, 'claude');
  assert.deepStrictEqual(rec[0].args, ['-p', 'do the thing']);
  assert.strictEqual(rec[0].cwd, '/work/here');
  assert.ok(rec[0].configDir.indexOf(path.join(ctx.configDir, 'sessions', 'beta')) === 0);
  assert.notStrictEqual(rec[0].configDir, ctx.claudeConfigPath);
  // persisted to disk too
  assert.strictEqual(orch.get(ctx, job.id).status, 'done');
});

test('runJob honors ctx.claudeBin and passes the isolated env', async function () {
  const ctx = makeCtx();
  ctx.claudeBin = '/opt/claude/bin/claude';
  seed(ctx, 'alpha', 'a@x.com', 'TA');
  const job = orch.enqueue(ctx, { prompt: 'p' });
  const rec = [];
  await orch.runJob(ctx, job, { fetch: fakeFetch({ TA: 5 }), run: fakeRun(rec) });
  assert.strictEqual(rec[0].bin, '/opt/claude/bin/claude');
  assert.ok(rec[0].env.CLAUDE_CONFIG_DIR.indexOf(path.join(ctx.configDir, 'sessions', 'alpha')) === 0);
});

test('runJob records status=error when no account is available', async function () {
  const ctx = makeCtx();
  const job = orch.enqueue(ctx, { prompt: 'p' }); // no accounts seeded
  const rec = [];
  const done = await orch.runJob(ctx, job, { fetch: fakeFetch({}), run: fakeRun(rec) });
  assert.strictEqual(done.status, 'error');
  assert.match(done.error, /no available account/);
  assert.strictEqual(rec.length, 0); // never spawned
  assert.strictEqual(orch.get(ctx, job.id).status, 'error');
});

test('runJob records status=error and the account when the CLI exits non-zero', async function () {
  const ctx = makeCtx();
  seed(ctx, 'alpha', 'a@x.com', 'TA');
  const job = orch.enqueue(ctx, { prompt: 'p' });
  const done = await orch.runJob(ctx, job, { fetch: fakeFetch({ TA: 5 }), run: fakeRun([], { failFor: 'alpha' }) });
  assert.strictEqual(done.status, 'error');
  assert.strictEqual(done.account, 'alpha');
  assert.match(done.error, /boom for alpha/);
});

test('runNext runs the FIRST queued job and returns null when the queue is drained', async function () {
  const ctx = makeCtx();
  seed(ctx, 'alpha', 'a@x.com', 'TA');
  const j1 = orch.enqueue(ctx, { prompt: 'first' });
  const j2 = orch.enqueue(ctx, { prompt: 'second' });
  const rec = [];
  const runOpts = { fetch: fakeFetch({ TA: 10 }), run: fakeRun(rec) };
  const r1 = await orch.runNext(ctx, runOpts);
  assert.strictEqual(r1.id, j1.id);
  assert.strictEqual(r1.status, 'done');
  const r2 = await orch.runNext(ctx, runOpts);
  assert.strictEqual(r2.id, j2.id);
  assert.strictEqual(await orch.runNext(ctx, runOpts), null); // both done now
  assert.deepStrictEqual(rec.map(function (r) { return r.args[1]; }), ['first', 'second']);
});

// ---- fan-out -------------------------------------------------------------------

test('fanOut runs the SAME prompt across accounts, each in its own isolated dir', async function () {
  const ctx = makeCtx();
  seed(ctx, 'alpha', 'a@x.com', 'TA');
  seed(ctx, 'beta', 'b@x.com', 'TB');
  seed(ctx, 'gamma', 'g@x.com', 'TG');
  const rec = [];
  const out = await orch.fanOut(ctx, 'same prompt', ['alpha', 'beta', 'gamma'], { run: fakeRun(rec, { failFor: 'beta' }), cwd: '/fan' });
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(out.map(function (o) { return o.account; }), ['alpha', 'beta', 'gamma']);
  assert.ok(out[0].result && !out[0].error);
  assert.ok(out[1].error && !out[1].result); // beta forced to fail
  assert.ok(out[2].result);
  // three distinct isolated config dirs, same prompt+cwd, no usage fetch needed
  const dirs = rec.map(function (r) { return r.configDir; });
  assert.strictEqual(new Set(dirs).size, 3);
  rec.forEach(function (r) { assert.deepStrictEqual(r.args, ['-p', 'same prompt']); assert.strictEqual(r.cwd, '/fan'); });
});

test('fanOut reports an error entry (not a throw) for an unknown account', async function () {
  const ctx = makeCtx();
  seed(ctx, 'alpha', 'a@x.com', 'TA');
  const out = await orch.fanOut(ctx, 'p', ['alpha', 'ghost'], { run: fakeRun([]) });
  assert.strictEqual(out[0].account, 'alpha');
  assert.ok(out[0].result);
  assert.strictEqual(out[1].account, 'ghost');
  assert.match(out[1].error, /no stored CLI credentials|credentials/);
});

test('fanOut rejects an empty prompt', async function () {
  const ctx = makeCtx();
  await assert.rejects(function () { return orch.fanOut(ctx, '  ', ['alpha'], {}); }, /non-empty prompt/);
});

// ---- MCP tools -----------------------------------------------------------------

function tool(name) { return orch.mcpTools.filter(function (t) { return t.name === name; })[0]; }

test('MCP tool shape: names, annotations, and confirm gating', function () {
  assert.deepStrictEqual(orch.mcpTools.map(function (t) { return t.name; }).sort(),
    ['keyflip_fanout', 'keyflip_job_enqueue', 'keyflip_job_run', 'keyflip_jobs']);
  // read-only listing
  assert.strictEqual(tool('keyflip_jobs').annotations.readOnlyHint, true);
  // mutating tools declare readOnlyHint:false and require 'confirm'
  ['keyflip_job_enqueue', 'keyflip_job_run', 'keyflip_fanout'].forEach(function (n) {
    const t = tool(n);
    assert.strictEqual(t.annotations.readOnlyHint, false);
    assert.ok(t.inputSchema.required.indexOf('confirm') !== -1, n + ' must require confirm');
  });
});

test('MCP mutating tools throw without confirm=true (and never spawn)', async function () {
  const ctx = makeCtx();
  await assert.rejects(function () { return tool('keyflip_job_enqueue').run(ctx, { prompt: 'p' }); }, /confirmation required/);
  await assert.rejects(function () { return tool('keyflip_job_run').run(ctx, {}); }, /confirmation required/);
  await assert.rejects(function () { return tool('keyflip_fanout').run(ctx, { prompt: 'p', accounts: ['a'] }); }, /confirmation required/);
  assert.strictEqual(orch.list(ctx).length, 0);
});

test('MCP keyflip_job_enqueue + keyflip_jobs round-trip (read-only list/filter/get)', async function () {
  const ctx = makeCtx();
  const r = await tool('keyflip_job_enqueue').run(ctx, { prompt: 'queued one', confirm: true });
  assert.strictEqual(r.enqueued.status, 'queued');
  const all = await tool('keyflip_jobs').run(ctx, {});
  assert.strictEqual(all.jobs.length, 1);
  const byId = await tool('keyflip_jobs').run(ctx, { id: r.enqueued.id });
  assert.strictEqual(byId.job.prompt, 'queued one');
  const filtered = await tool('keyflip_jobs').run(ctx, { status: 'done' });
  assert.strictEqual(filtered.jobs.length, 0);
});

test('MCP keyflip_job_run rejects an unknown or non-queued id', async function () {
  const ctx = makeCtx();
  await assert.rejects(function () { return tool('keyflip_job_run').run(ctx, { id: 'nope', confirm: true }); }, /no such job/);
  await assert.rejects(function () { return tool('keyflip_job_run').run(ctx, { confirm: true }); }, /no queued jobs/);
});
