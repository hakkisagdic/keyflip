'use strict';
// JOB QUEUE / capacity scheduler: "run a prompt on the best available account,
// headless". A prompt is enqueued into <configDir>/jobs.json; running it picks the
// account with the most quota HEADROOM (reusing usage.usageForProfiles +
// usage.pickByStrategy, optionally scoped to a group), then runs `claude -p` as
// that account in an ISOLATED config dir (session.prepareSession + sessionEnv) so
// the user's live login — and every other surface — stays untouched. fanOut runs
// the SAME prompt across several accounts at once (each isolated).
//
// Everything that touches the outside world is INJECTED via opts (run/fetch/clock)
// so tests need no network, no subprocess, and no real clock — NO real `claude`
// ever runs under test.
//
// SEAM (v1, deliberately out of scope): dispatch to REMOTE machines via the fleet.
// runJob runs the job on THIS machine. To dispatch remotely, a caller would queue a
// fleet command (see fleet.queue / a future { type: 'run-job' }) instead of calling
// runJob locally, and the target machine would drain it. Left unbuilt on purpose.
const path = require('path');
const crypto = require('crypto');
const core = require('./core');
const usage = require('./usage');
const groups = require('./groups');
const session = require('./session');
const { atomicWrite, readJsonForWrite } = require('./fsutil');
const { run: execRun } = require('./exec');

const STATUSES = ['queued', 'running', 'done', 'error'];
const MAX_JOBS = 500;          // bounded list — keep the most recent N jobs
const MAX_TEXT = 100 * 1000;   // cap a captured result/error so jobs.json can't balloon

function jobsPath(ctx) { return path.join(ctx.configDir, 'jobs.json'); }

// ---- state (persisted as <configDir>/jobs.json) --------------------------------

// Coerce parsed JSON into a safe { jobs: [ normalizedJob... ] }. A tampered or
// hand-edited file (scalar JSON, non-array jobs, junk entries) can never inject a
// bad shape: unknown fields are dropped, statuses clamped, entries without a valid
// id discarded. Keys are all fixed literals, so no name-keyed map to pollute.
function normalizeJob(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j) || typeof j.id !== 'string' || !j.id) return null;
  const out = {
    id: j.id,
    prompt: typeof j.prompt === 'string' ? j.prompt : '',
    cwd: typeof j.cwd === 'string' ? j.cwd : '',
    status: STATUSES.indexOf(j.status) !== -1 ? j.status : 'queued',
    createdAt: typeof j.createdAt === 'string' ? j.createdAt : null,
  };
  if (typeof j.group === 'string' && groups.isValidTag(j.group)) out.group = j.group;
  if (typeof j.account === 'string') out.account = j.account;
  if (typeof j.result === 'string') out.result = j.result;
  if (typeof j.error === 'string') out.error = j.error;
  if (typeof j.finishedAt === 'string') out.finishedAt = j.finishedAt;
  return out;
}
function normalizeState(parsed) {
  const out = { jobs: [] };
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
  jobs.forEach(function (j) { const n = normalizeJob(j); if (n) out.jobs.push(n); });
  if (out.jobs.length > MAX_JOBS) out.jobs = out.jobs.slice(out.jobs.length - MAX_JOBS);
  return out;
}

// Guarded read (never throws): missing OR corrupt -> empty. For read-only accessors.
function readStateSafe(ctx) {
  try { return normalizeState(readJsonForWrite(jobsPath(ctx))); }
  catch (e) { return { jobs: [] }; }
}
// Read-for-write: a MISSING file is empty, but a CORRUPT file THROWS (readJsonForWrite)
// so a read-modify-write never silently clobbers real state.
function readStateForWrite(ctx) { return normalizeState(readJsonForWrite(jobsPath(ctx))); }
function writeState(ctx, state) {
  atomicWrite(jobsPath(ctx), JSON.stringify({ jobs: state.jobs }, null, 2), 0o600);
}

function newId() { return crypto.randomBytes(8).toString('hex'); }
function cap(s) { s = String(s == null ? '' : s); return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…[truncated]' : s; }

// Update the stored job with matching id (Object.assign patch) and persist.
// Returns the updated job, or null if no such job is stored.
function updateJob(ctx, id, patch) {
  const state = readStateForWrite(ctx);
  let found = null;
  state.jobs.forEach(function (jb) { if (jb && jb.id === id) { Object.assign(jb, patch); found = jb; } });
  if (found) writeState(ctx, state);
  return found;
}
// Apply a patch to a job: persist it (if stored) AND reflect it on the passed object,
// so callers that hold the object see the new status even for an unstored job.
function applyPatch(ctx, job, patch) {
  const updated = updateJob(ctx, job.id, patch);
  Object.assign(job, patch);
  return updated || job;
}
function finish(ctx, job, patch) { return applyPatch(ctx, job, Object.assign({ finishedAt: ctx.now() }, patch)); }

// ---- public queue API ----------------------------------------------------------

function enqueue(ctx, spec) {
  spec = spec || {};
  if (typeof spec.prompt !== 'string' || !spec.prompt.trim()) throw new Error('a non-empty prompt is required');
  let group;
  if (spec.group != null && String(spec.group) !== '') {
    group = String(spec.group);
    if (!groups.isValidTag(group)) throw new Error("invalid group: '" + group + "'");
  }
  const job = {
    id: newId(),
    prompt: String(spec.prompt),
    cwd: spec.cwd ? String(spec.cwd) : process.cwd(),
    status: 'queued',
    createdAt: ctx.now(),
  };
  if (group) job.group = group;
  const state = readStateForWrite(ctx);
  state.jobs.push(job);
  if (state.jobs.length > MAX_JOBS) state.jobs = state.jobs.slice(state.jobs.length - MAX_JOBS);
  writeState(ctx, state);
  return job;
}

function list(ctx) { return readStateSafe(ctx).jobs; }
function get(ctx, id) {
  if (id == null) return null;
  const want = String(id);
  return readStateSafe(ctx).jobs.filter(function (j) { return j.id === want; })[0] || null;
}
// Remove all jobs, or (with {status}) only those in that status. Returns the count removed.
function clear(ctx, opts) {
  opts = opts || {};
  const state = readStateForWrite(ctx);
  const before = state.jobs.length;
  if (opts.status != null && String(opts.status) !== '') {
    const st = String(opts.status);
    state.jobs = state.jobs.filter(function (j) { return j.status !== st; });
  } else {
    state.jobs = [];
  }
  writeState(ctx, state);
  return before - state.jobs.length;
}

// ---- account selection ---------------------------------------------------------

// nowMs for the usage cache: injectable clock -> fixed ctx.now() -> wall clock.
function nowMs(ctx, opts) {
  if (opts && typeof opts.clock === 'function') {
    const v = opts.clock();
    if (typeof v === 'number') return v;
    const t = Date.parse(v); if (!isNaN(t)) return t;
  }
  const t = Date.parse(ctx.now());
  return isNaN(t) ? Date.now() : t;
}

// Best RUNNABLE account NAME by quota headroom (strategy default 'best'), scoped to
// `group` when given. Only accounts with stored CLI credentials are candidates —
// an app-only profile can't be run headless. Returns null when the pool is empty.
// Falls back to 'next-available' (unknown counts as available) so a job can still
// run OFFLINE / when usage is unknown, and finally to the first candidate.
async function selectAccount(ctx, spec, opts) {
  spec = spec || {}; opts = opts || {};
  const strategy = spec.strategy || 'best';
  let profs = core.listProfiles(ctx);
  if (spec.group) {
    if (!groups.isValidTag(spec.group)) return null;
    profs = groups.filterProfiles(ctx, profs, spec.group);
  }
  const candidates = profs.filter(function (p) {
    try { return !!ctx.store.getProfile(p.name); } catch (e) { return false; }
  });
  if (!candidates.length) return null;
  const infos = await usage.usageForProfiles(ctx, candidates.map(function (p) { return p.name; }), {
    fetch: opts.fetch, nowMs: nowMs(ctx, opts), cacheTtlMs: opts.cacheTtlMs,
  });
  let picked = usage.pickByStrategy(candidates, infos, strategy);
  if (!picked) picked = usage.pickByStrategy(candidates, infos, 'next-available'); // offline / all-unknown
  if (!picked) picked = candidates[0]; // last resort: never fail to pick when a runnable account exists
  return picked ? picked.name : null;
}

// ---- running -------------------------------------------------------------------

// Run `bin -p <prompt>` as `name` in that account's ISOLATED config dir. Injected
// runner (opts.run) defaults to exec.run. NOTE on cwd: the job's cwd is passed in
// the runner opts; exec.run honors env + timeoutMs today but not cwd, so full
// per-job cwd needs a cwd-aware runner (or exec.run gaining `cwd: opts.cwd` in its
// spawnSync options). The runner contract carries it either way.
function runAs(ctx, name, prompt, cwd, opts) {
  opts = opts || {};
  const runner = opts.run || execRun;
  const dir = session.prepareSession(ctx, name, { share: true });
  const se = session.sessionEnv(ctx, dir, opts.env || process.env);
  const bin = ctx.claudeBin || 'claude';
  const input = opts.input != null ? String(opts.input) : '';
  const res = runner(bin, ['-p', String(prompt)], input, { cwd: cwd, env: se.env, timeoutMs: opts.timeoutMs });
  // If claude rotated the token in-session, persist it back so the profile never goes stale.
  try { session.syncBack(ctx, name); } catch (e) { /* best effort */ }
  return res;
}
function runResultError(res) {
  return String((res && (res.stderr || (res.error && res.error.message))) || ('claude exited with code ' + (res && res.code))).trim() || 'run failed';
}

// Pick an account and run one job HEADLESS, updating its status in the store.
async function runJob(ctx, job, opts) {
  opts = opts || {};
  let name;
  try { name = await selectAccount(ctx, { group: job.group, strategy: opts.strategy }, opts); }
  catch (e) { return finish(ctx, job, { status: 'error', error: (e && e.message) || 'account selection failed' }); }
  if (!name) return finish(ctx, job, { status: 'error', error: 'no available account' + (job.group ? " in group '" + job.group + "'" : '') });

  // Policy engine: the job runs headless AS `name` in job.cwd — honor the same directory→account
  // rules a switch would (a job auto-selects any credentialed account, so it could pick a denied one).
  const pol = require('./policy').evaluate(ctx, { cwd: job.cwd, account: name });
  if (!pol.allowed) return finish(ctx, job, { status: 'error', account: name, error: 'policy denied: ' + pol.reason });

  applyPatch(ctx, job, { status: 'running', account: name }); // persist RUNNING before we spawn
  let res;
  try { res = runAs(ctx, name, job.prompt, job.cwd, opts); }
  catch (e) { return finish(ctx, job, { status: 'error', account: name, error: (e && e.message) || 'run failed' }); }
  if (!res || res.code !== 0) return finish(ctx, job, { status: 'error', account: name, error: cap(runResultError(res)) });
  return finish(ctx, job, { status: 'done', account: name, result: cap(res.stdout || '') });
}

// Run the next QUEUED job. Returns the finished job, or null when the queue is empty.
// (v1 is single-process; two concurrent runNext calls could both pick the same job —
// remote/coordinated dispatch is the fleet seam noted at the top.)
async function runNext(ctx, opts) {
  const next = readStateSafe(ctx).jobs.filter(function (j) { return j.status === 'queued'; })[0];
  if (!next) return null;
  return runJob(ctx, next, opts);
}

// Run the SAME prompt across several accounts (each ISOLATED). Ad-hoc — does NOT
// touch the job queue. Returns [{ account, result } | { account, error }].
async function fanOut(ctx, prompt, accountNames, opts) {
  opts = opts || {};
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('a non-empty prompt is required');
  const names = Array.isArray(accountNames) ? accountNames : [];
  const cwd = opts.cwd ? String(opts.cwd) : process.cwd();
  const out = [];
  for (let i = 0; i < names.length; i++) {
    const name = String(names[i]);
    const entry = { account: name };
    const pol = require('./policy').evaluate(ctx, { cwd: cwd, account: name });
    if (!pol.allowed) { entry.error = 'policy denied: ' + pol.reason; out.push(entry); continue; }
    try {
      const res = runAs(ctx, name, prompt, cwd, opts);
      if (!res || res.code !== 0) entry.error = cap(runResultError(res));
      else entry.result = cap(res.stdout || '');
    } catch (e) { entry.error = (e && e.message) || 'run failed'; }
    out.push(entry);
  }
  return out;
}

// ---- MCP tools -----------------------------------------------------------------
// Self-contained tool objects (shape from src/mcp.js): the parent spreads these into
// mcp.js's TOOLS array. Mutating tools gate on confirm=true; selection/list is
// read-only. Annotations + the confirm gate are inlined so no import from mcp.js is
// needed. run functions use DEFAULT injections (real exec.run) — the same code paths
// are unit-tested here through opts.run with a fake runner.
const MCP_RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const MCP_MUT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const MCP_MUT_NET = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const mcpConfirm = { type: 'boolean', description: 'Must be true — set it only after the user has agreed.' };
function mcpNeedConfirm(args) { if (!args || args.confirm !== true) throw new Error('confirmation required: ask the user first, then call again with confirm=true'); }

const mcpTools = [
  {
    name: 'keyflip_jobs',
    title: 'List the headless job queue',
    description: 'List headless jobs (id, status, chosen account, prompt, captured result/error). Optionally filter by status, or fetch one by id. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Fetch a single job by id.' }, status: { type: 'string', enum: STATUSES, description: 'Filter to one status.' } },
      additionalProperties: false,
    },
    annotations: MCP_RO,
    run: async function (ctx, args) {
      args = args || {};
      if (args.id) return { job: get(ctx, String(args.id)) };
      let jobs = list(ctx);
      if (args.status) { const st = String(args.status); jobs = jobs.filter(function (j) { return j.status === st; }); }
      return { jobs: jobs };
    },
  },
  {
    name: 'keyflip_job_enqueue',
    title: 'Queue a headless job',
    description: 'Add a prompt to the headless job queue to later run on the best available account (by quota headroom), optionally scoped to a group. Does NOT run it — use keyflip_job_run. Mutating (writes the queue) — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt to run headless (claude -p).' },
        cwd: { type: 'string', description: 'Working directory to run in (default: current).' },
        group: { type: 'string', description: 'Only pick an account from this group.' },
        confirm: mcpConfirm,
      },
      required: ['prompt', 'confirm'],
      additionalProperties: false,
    },
    annotations: MCP_MUT,
    run: async function (ctx, args) {
      mcpNeedConfirm(args);
      const job = enqueue(ctx, { prompt: String(args.prompt), cwd: args.cwd ? String(args.cwd) : undefined, group: args.group ? String(args.group) : undefined });
      return { enqueued: job };
    },
  },
  {
    name: 'keyflip_job_run',
    title: 'Run a queued job on the best available account',
    description: 'Pick the account with the most quota headroom (strategy "best", or "next-available") and run a queued job HEADLESS as that account in an ISOLATED config dir (its own CLAUDE_CONFIG_DIR — your live login is untouched). With id runs that job; otherwise the next queued one. IMPORTANT: this SPENDS the chosen account\'s quota. Ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Run this specific queued job (default: next queued).' },
        strategy: { type: 'string', enum: ['best', 'next-available'], description: 'Account selection strategy (default best).' },
        confirm: mcpConfirm,
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: MCP_MUT_NET,
    run: async function (ctx, args) {
      mcpNeedConfirm(args);
      let job;
      if (args.id) {
        job = get(ctx, String(args.id));
        if (!job) throw new Error("no such job: '" + args.id + "'");
        if (job.status !== 'queued') throw new Error("job '" + args.id + "' is not queued (status: " + job.status + ')');
        job = await runJob(ctx, job, { strategy: args.strategy });
      } else {
        job = await runNext(ctx, { strategy: args.strategy });
        if (!job) throw new Error('no queued jobs to run');
      }
      return { job: job };
    },
  },
  {
    name: 'keyflip_fanout',
    title: 'Run one prompt across several accounts',
    description: 'Run the SAME prompt HEADLESS across several saved accounts at once (each in its own ISOLATED CLAUDE_CONFIG_DIR), returning each account\'s output. IMPORTANT: this SPENDS quota on EVERY listed account. Ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt to run on every account.' },
        accounts: { type: 'array', items: { type: 'string' }, description: 'Account names to fan the prompt out to.' },
        cwd: { type: 'string', description: 'Working directory to run in (default: current).' },
        confirm: mcpConfirm,
      },
      required: ['prompt', 'accounts', 'confirm'],
      additionalProperties: false,
    },
    annotations: MCP_MUT_NET,
    run: async function (ctx, args) {
      mcpNeedConfirm(args);
      const names = Array.isArray(args.accounts) ? args.accounts.map(String) : [];
      if (!names.length) throw new Error('accounts must be a non-empty array');
      const results = await fanOut(ctx, String(args.prompt), names, { cwd: args.cwd ? String(args.cwd) : undefined });
      return { results: results };
    },
  },
];

module.exports = {
  enqueue: enqueue,
  list: list,
  get: get,
  clear: clear,
  selectAccount: selectAccount,
  runNext: runNext,
  runJob: runJob,
  fanOut: fanOut,
  jobsPath: jobsPath,
  mcpTools: mcpTools,
  STATUSES: STATUSES,
  MAX_JOBS: MAX_JOBS,
};
