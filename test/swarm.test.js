'use strict';
// SWARM: run one command across YOUR OWN enrolled fleet machines, over the same encrypted
// rendezvous the fleet uses. Each machine is a separate makeCtx (its own config dir + credential
// store) sharing one fleet dir + passphrase — the real topology, run locally. All IO/time/subprocess
// is injected: the fake `run` means NO real command ever executes and there is no network or clock.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fleet = require('../src/fleet');
const swarm = require('../src/swarm');
const { makeCtx } = require('./helpers');

const PASS = 'swarm-secret-passphrase';
function sharedDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kf-swarm-')); }
function machine(name, dir) {
  const ctx = makeCtx();
  ctx.claudeDir = path.join(ctx.home, '.claude');
  fs.mkdirSync(path.join(ctx.claudeDir, 'projects'), { recursive: true });
  fleet.setConfig(ctx, { name: name, dir: dir });
  return ctx;
}
function busOf(ctx, dir) { return fleet.bus(ctx, { dir: dir, passphrase: PASS }); }
// A recording, injectable subprocess runner — nothing real ever spawns.
function fakeRun(fn) {
  const calls = [];
  const run = function (cmd, args, input, o) {
    calls.push({ cmd: cmd, args: args, input: input, o: o });
    return fn ? fn(cmd, args) : { code: 0, stdout: 'OK', stderr: '', error: null, timedOut: false };
  };
  run.calls = calls;
  return run;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------
test('run across the fleet: A queues an exec for B; B drains + runs it; A aggregates the result', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir), B = machine('beta', dir);
  fleet.publish(A, busOf(A, dir), {});
  fleet.publish(B, busOf(B, dir), {});
  const q = swarm.queueExec(A, busOf(A, dir), { command: 'echo', args: ['hi'], to: 'beta' });
  assert.strictEqual(q.commands.length, 1, 'one target');
  assert.strictEqual(q.commands[0].machineId, fleet.identity(B).machineId);

  const run = fakeRun(function () { return { code: 0, stdout: 'hi\n', stderr: '', error: null }; });
  const d = swarm.drainExec(B, busOf(B, dir), { allowExec: true, run: run });
  assert.strictEqual(d.results.length, 1);
  assert.ok(d.results[0].ok, JSON.stringify(d.results[0]));
  assert.strictEqual(run.calls[0].cmd, 'echo');
  assert.deepStrictEqual(run.calls[0].args, ['hi'], 'argv array, never a shell string');

  const rec = fleet.reconcileKeys(A, fleet.readFleet(A, busOf(A, dir)));
  const agg = swarm.aggregate(A, busOf(A, dir), { group: q.group, reconcile: rec });
  assert.strictEqual(agg.length, 1);
  assert.strictEqual(agg[0].ok, true);
  assert.strictEqual(agg[0].stdout.trim(), 'hi');
  assert.strictEqual(agg[0].verified, true, 'the result signature verifies against B\'s pinned key');
  assert.strictEqual(agg[0].machineId, fleet.identity(B).machineId);
  assert.strictEqual(agg[0].machine, 'beta');
});

test('fan-out: with no --to, queueExec targets every checked-in machine and records the group in state', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir), B = machine('beta', dir), C = machine('gamma', dir);
  [A, B, C].forEach(function (m) { fleet.publish(m, busOf(m, dir), {}); });
  const q = swarm.queueExec(A, busOf(A, dir), { command: 'uptime', args: [] });
  assert.strictEqual(q.commands.length, 3, 'fanned to all three machines');
  assert.strictEqual(swarm.readState(A).lastGroup, q.group, 'the last group is persisted to <configDir>/swarm.json');
});

// ---------------------------------------------------------------------------
// Consent gate (exec OFF by default)
// ---------------------------------------------------------------------------
test('consent gate: a drain WITHOUT allowExec runs nothing and keeps the command for a later consented drain', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir), B = machine('beta', dir);
  fleet.publish(A, busOf(A, dir), {});
  fleet.publish(B, busOf(B, dir), {});
  swarm.queueExec(A, busOf(A, dir), { command: 'rm', args: ['-rf', '/tmp/x'], to: 'beta' });

  const run = fakeRun();
  const d = swarm.drainExec(B, busOf(B, dir), { allowExec: false, run: run });
  assert.strictEqual(run.calls.length, 0, 'nothing executes without consent');
  assert.strictEqual(d.results[0].skipped, 'consent');
  assert.strictEqual(fleet.readInbox(B, busOf(B, dir)).length, 1, 'the unconsented exec stays in the inbox');

  const d2 = swarm.drainExec(B, busOf(B, dir), { allowExec: true, run: run });
  assert.strictEqual(run.calls.length, 1, 'the same command runs once consent is given');
  assert.ok(d2.results[0].ok);
  assert.strictEqual(fleet.readInbox(B, busOf(B, dir)).length, 0, 'now consumed');
});

test('applyExec is off by default: allowExec must be exactly true', function () {
  const B = machine('beta', sharedDir());
  const cmd = { id: 'x1', from: 'a', to: fleet.identity(B).machineId, at: B.now(), type: 'exec', payload: { command: 'echo', args: ['y'] } };
  const run = fakeRun();
  assert.strictEqual(swarm.applyExec(B, cmd, { run: run }).skipped, 'consent');
  assert.strictEqual(swarm.applyExec(B, cmd, { allowExec: 1, run: run }).skipped, 'consent', 'truthy-but-not-true is refused');
  assert.strictEqual(run.calls.length, 0);
});

// ---------------------------------------------------------------------------
// ARGV array only — never a shell string
// ---------------------------------------------------------------------------
test('argv-array only: a string payload.args is rejected (no shell injection surface)', function () {
  const B = machine('beta', sharedDir());
  const cmd = { id: 'x2', from: 'a', to: fleet.identity(B).machineId, at: B.now(), type: 'exec', payload: { command: 'sh', args: 'rm -rf / #' } };
  const r = swarm.applyExec(B, cmd, { allowExec: true, run: fakeRun() });
  assert.ok(!r.ok && /ARGV ARRAY|array/i.test(r.detail), r.detail);
});

test('argv-array only: queueExec refuses a shell string and caps abuse', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir); fleet.publish(A, busOf(A, dir), {});
  assert.throws(function () { swarm.queueExec(A, busOf(A, dir), { command: 'sh', args: 'rm -rf', to: fleet.identity(A).machineId }); }, /ARGV|array/i);
  assert.throws(function () { swarm.queueExec(A, busOf(A, dir), { command: '', to: fleet.identity(A).machineId }); }, /command/i);
  const big = new Array(300).fill('x');
  assert.throws(function () { swarm.queueExec(A, busOf(A, dir), { command: 'echo', args: big, to: fleet.identity(A).machineId }); }, /too many/i);
});

// ---------------------------------------------------------------------------
// Origin authentication + replay
// ---------------------------------------------------------------------------
test('origin-auth: a FORGED exec (attacker key, claims from=alpha) is rejected and never runs, even with the passphrase', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir), B = machine('beta', dir), evil = machine('evil', dir);
  fleet.publish(A, busOf(A, dir), {}); // B will pin A's REAL key
  const forged = { id: 'deadbeef', from: fleet.identity(A).machineId, to: fleet.identity(B).machineId, at: A.now(), type: 'exec', payload: { command: 'echo', args: ['pwned'], group: 'g' } };
  fleet.signCommand(evil, forged); // attacker holds the passphrase + folder write — but only THEIR key
  const bB = busOf(B, dir);
  bB.write(fleet.inboxName(fleet.identity(B).machineId), [forged]);
  const run = fakeRun();
  const d = swarm.drainExec(B, bB, { allowExec: true, run: run });
  assert.strictEqual(run.calls.length, 0, 'a forged command never executes');
  assert.ok(/rejected/.test(d.results[0].detail), d.results[0].detail);
});

test('replay: an already-applied exec id is remembered and not re-run when re-injected', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir), B = machine('beta', dir);
  fleet.publish(A, busOf(A, dir), {});
  fleet.publish(B, busOf(B, dir), {});
  swarm.queueExec(A, busOf(A, dir), { command: 'echo', args: ['x'], to: 'beta' });
  const bB = busOf(B, dir);
  const orig = fleet.readInbox(B, bB)[0];
  const run = fakeRun();
  swarm.drainExec(B, bB, { allowExec: true, run: run });
  assert.strictEqual(run.calls.length, 1);
  bB.write(fleet.inboxName(fleet.identity(B).machineId), [orig]); // replay the identical captured bytes
  const d2 = swarm.drainExec(B, bB, { allowExec: true, run: run });
  assert.strictEqual(run.calls.length, 1, 'the replayed command is not re-run');
  assert.ok(/already applied/.test(d2.results[0].detail), d2.results[0].detail);
});

test('non-exec commands are left in the inbox for `fleet push` (swarm only consumes exec)', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir), B = machine('beta', dir);
  fleet.publish(A, busOf(A, dir), {});
  fleet.publish(B, busOf(B, dir), {});
  fleet.queue(A, busOf(A, dir), fleet.identity(B).machineId, { type: 'switch', payload: { account: 'work' } });
  swarm.queueExec(A, busOf(A, dir), { command: 'echo', args: ['k'], to: 'beta' });
  swarm.drainExec(B, busOf(B, dir), { allowExec: true, run: fakeRun() });
  const rest = fleet.readInbox(B, busOf(B, dir));
  assert.ok(rest.some(function (c) { return c.type === 'switch'; }), 'switch is left for fleet push');
  assert.ok(!rest.some(function (c) { return c.type === 'exec'; }), 'exec is consumed by the swarm drain');
});

// ---------------------------------------------------------------------------
// ping (reachability)
// ---------------------------------------------------------------------------
test('ping: queues a curl argv (no shell) for the operator\'s own url; rejects non-http / flag-like / whitespace urls', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir); fleet.publish(A, busOf(A, dir), {});
  swarm.ping(A, busOf(A, dir), 'https://health.example.com/live', { timeout: 5 });
  const cmd = fleet.readInbox(A, busOf(A, dir))[0];
  assert.strictEqual(cmd.type, 'exec');
  assert.strictEqual(cmd.payload.command, 'curl');
  assert.ok(Array.isArray(cmd.payload.args));
  assert.ok(cmd.payload.args.indexOf('https://health.example.com/live') !== -1, 'the url is a distinct argv token');
  assert.ok(cmd.payload.args.indexOf('-m') !== -1 && cmd.payload.args.indexOf('5') !== -1, 'timeout is applied');
  assert.throws(function () { swarm.ping(A, busOf(A, dir), 'file:///etc/passwd', {}); }, /URL/);
  assert.throws(function () { swarm.ping(A, busOf(A, dir), '-oremote', {}); }, /URL/, 'a flag-like url cannot slip in as a curl option');
  assert.throws(function () { swarm.ping(A, busOf(A, dir), 'http://a b/c', {}); }, /URL/);
});

// ---------------------------------------------------------------------------
// aggregate: scoping, binding, isolation, output caps
// ---------------------------------------------------------------------------
test('aggregate: only results addressed to this machine are visible; group filter scopes them', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir), B = machine('beta', dir), C = machine('gamma', dir);
  [A, B, C].forEach(function (m) { fleet.publish(m, busOf(m, dir), {}); });
  const q1 = swarm.queueExec(A, busOf(A, dir), { command: 'echo', args: ['1'], to: 'beta' });
  swarm.drainExec(B, busOf(B, dir), { allowExec: true, run: fakeRun(function () { return { code: 0, stdout: 'r1', stderr: '', error: null }; }) });
  // C issues its OWN exec to B — that result is addressed to C and must NOT leak into A's view.
  swarm.queueExec(C, busOf(C, dir), { command: 'echo', args: ['2'], to: 'beta' });
  swarm.drainExec(B, busOf(B, dir), { allowExec: true, run: fakeRun(function () { return { code: 0, stdout: 'r2', stderr: '', error: null }; }) });

  const recA = fleet.reconcileKeys(A, fleet.readFleet(A, busOf(A, dir)));
  const scoped = swarm.aggregate(A, busOf(A, dir), { group: q1.group, reconcile: recA });
  assert.strictEqual(scoped.length, 1);
  assert.strictEqual(scoped[0].stdout, 'r1');

  const all = swarm.aggregate(A, busOf(A, dir), {});
  assert.ok(all.some(function (r) { return r.stdout === 'r1'; }));
  assert.ok(!all.some(function (r) { return r.stdout === 'r2'; }), "C's result is not visible to A (addressed to C)");
});

test('aggregate: a mislabelled result file (filename stem != claimed id) is ignored', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir); fleet.publish(A, busOf(A, dir), {});
  const bA = busOf(A, dir);
  bA.write('spoof.result.enc', { id: 'other', type: 'exec-result', from: 'x', to: fleet.identity(A).machineId, at: A.now(), payload: { result: { ok: true, stdout: 'evil' } } });
  const agg = swarm.aggregate(A, bA, {});
  assert.ok(!agg.some(function (r) { return r.stdout === 'evil'; }), 'a result file whose name does not match its id is dropped');
});

test('aggregate: peer output is size-capped and control chars are scrubbed (tabs/newlines survive)', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir), B = machine('beta', dir);
  fleet.publish(A, busOf(A, dir), {});
  fleet.publish(B, busOf(B, dir), {});
  const big = '\x1b[2Jline\ttab\n' + 'A'.repeat(200000); // control chars up front, within the cap window
  swarm.queueExec(A, busOf(A, dir), { command: 'cat', args: ['big'], to: 'beta' });
  swarm.drainExec(B, busOf(B, dir), { allowExec: true, run: fakeRun(function () { return { code: 0, stdout: big, stderr: '', error: null }; }) });
  const agg = swarm.aggregate(A, busOf(A, dir), {});
  assert.ok(agg[0].stdout.length <= swarm.MAX_OUTPUT + 32, 'stdout is capped');
  assert.strictEqual(agg[0].stdout.indexOf('\x1b'), -1, 'ANSI ESC is stripped');
  assert.ok(agg[0].stdout.indexOf('\t') !== -1, 'tabs are preserved for readability');
});

test('applyExec caps output directly and reports a non-zero exit as result.ok=false while still "applied"', function () {
  const B = machine('beta', sharedDir());
  const cmd = { id: 'cap1', from: 'a', to: fleet.identity(B).machineId, at: B.now(), type: 'exec', payload: { command: 'false', args: [] } };
  const r = swarm.applyExec(B, cmd, { allowExec: true, run: function () { return { code: 3, stdout: 'A'.repeat(999999), stderr: 'boom', error: null }; } });
  assert.ok(r.ok, 'we ran it (so it is ledgered / not replayed)');
  assert.strictEqual(r.result.ok, false, 'the command itself failed (exit 3)');
  assert.strictEqual(r.result.code, 3);
  assert.ok(r.result.stdout.length <= swarm.MAX_OUTPUT, 'stdout capped');
});

// ---------------------------------------------------------------------------
// Robustness / hostile input
// ---------------------------------------------------------------------------
test('robustness: aggregate id-filter is prototype-pollution safe', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir); fleet.publish(A, busOf(A, dir), {});
  assert.doesNotThrow(function () { swarm.aggregate(A, busOf(A, dir), { ids: ['__proto__', 'constructor', 'prototype'] }); });
  assert.strictEqual({}.polluted, undefined, 'Object.prototype is intact');
});

test('robustness: applyExec ignores a non-exec command and a wrong-recipient signed command', function () {
  const B = machine('beta', sharedDir());
  assert.strictEqual(swarm.applyExec(B, { type: 'switch', payload: {} }, { allowExec: true }).ok, false);
  const cmd = { id: 'w1', from: 'a', to: 'someone-else', at: B.now(), type: 'exec', payload: { command: 'echo', args: [] } };
  fleet.signCommand(B, cmd); // valid signature, but addressed to the wrong machine
  const r = swarm.applyExec(B, cmd, { allowExec: true, senderKey: fleet.publicKey(B), requireSignature: true, run: fakeRun() });
  assert.ok(!r.ok && /recipient/.test(r.detail), r.detail);
});

test('resultName rejects an unsafe id (defence in depth)', function () {
  assert.throws(function () { swarm.resultName('../evil'); }, /unsafe/);
  assert.ok(/^[0-9a-f]+\.result\.enc$/.test(swarm.resultName('abc123')));
});
