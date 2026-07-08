'use strict';
// SWARM: run one command across YOUR OWN enrolled fleet machines + reachability (ping) checks.
// This is AUTHORIZED distributed ops on machines the operator themselves enrolled in their
// encrypted rendezvous (see fleet.js) — NOT a tool for reaching third-party targets. It COMPOSES
// the fleet primitives (queue/inbox, origin auth, replay guard, the encrypted bus) and adds one new
// command flavour, `exec`. Exec is CONSENT-GATED: applyExec never runs anything unless the operator
// passes allowExec:true (mirrors fleet's allowSwitch/allowSave). Commands travel as an ARGV ARRAY
// and are spawned WITHOUT a shell (see exec.js) — there is no string to inject into. Every exec is
// origin-authenticated (fleet.checkOrigin — a leaked passphrase still can't forge one) and
// replay-guarded (fleet.markApplied). Results are published back, encrypted, so the initiator can
// aggregate them. State lives at <configDir>/swarm.json (0600).
const path = require('path');
const crypto = require('crypto');
const fleet = require('./fleet');
const fsutil = require('./fsutil');

const MAX_OUTPUT = 64 * 1024;      // cap each captured stream (anti-DoS / anti-transcript-bloat)
const MAX_ARGS = 256;              // cap argv length
const MAX_ARG_LEN = 4096;          // cap each argv token
const MAX_CMD_LEN = 4096;          // cap the program name
const DEFAULT_TIMEOUT_MS = 60000;  // per-exec wall clock (injectable via opts.timeoutMs)
const RESULT_SUFFIX = '.result.enc';

// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x1f\x7f]/g;                       // ALL control incl. newline/ESC — short display fields
// eslint-disable-next-line no-control-regex
const OUT_CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;  // control EXCEPT \t \n \r — captured command output
function scrub(s, max) { return String(s == null ? '' : s).replace(CTRL, ' ').slice(0, max || 200); }
function scrubOut(s, max) { return String(s == null ? '' : s).replace(OUT_CTRL, ' ').slice(0, max || MAX_OUTPUT); }

// ---- argv hygiene (NEVER a shell string) ----
function normCommand(command) {
  if (typeof command !== 'string' || !command) throw new Error('exec requires a command (the program to run)');
  if (command.length > MAX_CMD_LEN) throw new Error('exec command is too long');
  return command;
}
function normArgs(args) {
  if (args == null) return [];
  if (!Array.isArray(args)) throw new Error('exec args must be an ARGV ARRAY, never a shell string (no injection)');
  if (args.length > MAX_ARGS) throw new Error('too many exec args (max ' + MAX_ARGS + ')');
  return args.map(function (a) { const s = String(a); if (s.length > MAX_ARG_LEN) throw new Error('an exec arg is too long'); return s; });
}
function capOutput(s) { return scrubOut(s, MAX_OUTPUT); }

// ---- state (<configDir>/swarm.json): remembers the last fan-out group so `swarm results` can default to it ----
function statePath(ctx) { return path.join(ctx.configDir, 'swarm.json'); }
function readState(ctx) { try { return fsutil.readJsonForWrite(statePath(ctx)) || {}; } catch (e) { return {}; } }
function writeState(ctx, obj) { try { fsutil.atomicWrite(statePath(ctx), JSON.stringify(obj, null, 2), 0o600); } catch (e) { /* best-effort */ } }

// Resolve `to` (a machine name / id / id-prefix) to a list of target machine ids. When `to` is
// omitted, FAN OUT to every machine currently checked in to the rendezvous (fleet.readFleet).
function targets(ctx, b, to) {
  const statuses = fleet.readFleet(ctx, b);
  if (to != null && to !== '') {
    const t = String(to);
    const byName = statuses.filter(function (s) { return s.name === t; });
    if (byName.length === 1) return [byName[0].machineId];
    const byId = statuses.filter(function (s) { return s.machineId === t || s.machineId.indexOf(t) === 0; });
    if (byId.length === 1) return [byId[0].machineId];
    if (byName.length > 1 || byId.length > 1) throw new Error("'" + t + "' matches more than one fleet machine");
    if (fleet.safeId(t)) return [t]; // a raw, valid machine id not (yet) in the roster
    throw new Error("no fleet machine named '" + t + "' (run `keyflip fleet status`)");
  }
  const ids = statuses.map(function (s) { return s.machineId; }).filter(fleet.safeId);
  if (!ids.length) throw new Error('no fleet machines have checked in yet (run `keyflip fleet push` on each machine)');
  return ids;
}

// Queue an exec command onto one or every fleet machine's inbox. Each fanned command is signed
// (fleet.queue) so the recipient can verify our origin; they share a random `group` id so their
// results can be aggregated together. Returns { group, command, args, commands:[{machineId,id}] }.
function queueExec(ctx, b, opts) {
  opts = opts || {};
  const command = normCommand(opts.command);
  const args = normArgs(opts.args);
  const group = crypto.randomBytes(8).toString('hex');
  const ids = targets(ctx, b, opts.to);
  const commands = ids.map(function (id) {
    const cmd = fleet.queue(ctx, b, id, { type: 'exec', payload: { command: command, args: args, group: group } });
    return { machineId: id, id: cmd.id };
  });
  const st = readState(ctx);
  st.lastGroup = group; st.lastAt = ctx.now(); st.lastCommand = command; st.pending = commands;
  writeState(ctx, st);
  return { group: group, command: command, args: args, commands: commands };
}

// Reachability check: queue an exec that curls the operator's OWN url (no shell — argv array).
// The url must be a plain http(s) URL you control; a strict check also stops it being read as a
// curl flag (a leading '-') or smuggling whitespace.
function ping(ctx, b, url, opts) {
  opts = opts || {};
  if (typeof url !== 'string' || url.length > 2048 || !/^https?:\/\/[^\s]+$/i.test(url)) {
    throw new Error('ping needs a plain http(s) URL you control (reachability check)');
  }
  const timeout = Math.max(1, Math.min(120, parseInt(opts.timeout, 10) || 10));
  const devNull = ctx.platform === 'win32' ? 'NUL' : '/dev/null';
  const args = ['-sS', '-m', String(timeout), '-o', devNull, '-w', '%{http_code}', url];
  return queueExec(ctx, b, { command: (opts.command || 'curl'), args: args, to: opts.to });
}

// Apply ONE inbound exec command. CONSENT-GATED: does nothing unless opts.allowExec === true
// (default OFF, mirroring fleet.applyCommand's allowSwitch/allowSave). Origin is re-verified when a
// senderKey is supplied (defence in depth). Executes via opts.run (default require('./exec').run)
// as an ARGV ARRAY — spawnSync with no shell. Output is size-capped. When opts.bus is supplied the
// result is published back to the initiator. Returns { ok, applied:'exec', detail, result?, skipped? }.
function applyExec(ctx, cmd, opts) {
  opts = opts || {};
  if (!cmd || cmd.type !== 'exec') return { ok: false, applied: 'exec', detail: 'not an exec command' };
  // Origin authentication (defence in depth — the drain already gates on fleet.checkOrigin).
  if (opts.requireSignature || opts.senderKey) {
    if (!fleet.verifyCommand(cmd, opts.senderKey)) return { ok: false, applied: 'exec', detail: 'unverified origin (rejected)' };
    if (cmd.to !== fleet.identity(ctx).machineId) return { ok: false, applied: 'exec', detail: 'wrong recipient (rejected)' };
  }
  // Consent gate — exec is OFF unless the operator explicitly turned it on for this drain.
  if (opts.allowExec !== true) return { ok: false, applied: 'exec', detail: 'skipped (exec is off by default — pass --allow-exec)', skipped: 'consent' };
  const payload = cmd.payload || {};
  let command, args;
  try { command = normCommand(payload.command); args = normArgs(payload.args); }
  catch (e) { return { ok: false, applied: 'exec', detail: (e && e.message) || 'bad exec payload' }; }
  const run = opts.run || require('./exec').run;
  let r;
  try { r = run(command, args, undefined, { timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS }); }
  catch (e) { return { ok: false, applied: 'exec', detail: 'exec failed: ' + ((e && e.message) || 'error') }; }
  r = r || {};
  const result = {
    ok: (typeof r.code === 'number' ? r.code === 0 : false) && !r.error,
    code: typeof r.code === 'number' ? r.code : 1,
    stdout: capOutput(r.stdout),
    stderr: capOutput(r.stderr),
    timedOut: !!r.timedOut,
    command: command,
  };
  if (opts.bus) { try { publishResult(ctx, opts.bus, cmd, result); } catch (e) { /* best-effort */ } }
  // ok = "we RAN it" (so it is ledgered and never replayed) — the command's own exit is result.ok.
  return { ok: true, applied: 'exec', detail: 'ran ' + command + ' -> code ' + result.code, result: result };
}

function resultName(id) { if (!fleet.safeId(id)) throw new Error('unsafe result id'); return id + RESULT_SUFFIX; }

// Publish a signed result back to the initiator, keyed by the command id (unique per fanned command).
// It is a command-shaped object so fleet.signCommand / fleet.checkOrigin verify it end-to-end.
function publishResult(ctx, b, cmd, result) {
  const obj = {
    id: cmd.id, from: b.machineId, to: cmd.from, at: ctx.now(), type: 'exec-result',
    payload: { group: (cmd.payload && cmd.payload.group) || null, result: result },
  };
  fleet.signCommand(ctx, obj); // sign so the initiator can prove WHO ran it
  b.write(resultName(cmd.id), obj);
  return obj;
}

// Drain THIS machine's inbox: apply exec commands (consent-gated + origin-authenticated +
// replay-guarded), publish their results, and LEAVE every non-exec command in the inbox for
// `keyflip fleet push` to handle. Unconsented exec commands are also left, so a later
// `--allow-exec` drain can run them. Returns { results, kept }.
function drainExec(ctx, b, opts) {
  opts = opts || {};
  const reconcile = opts.reconcile || fleet.reconcileKeys(ctx, fleet.readFleet(ctx, b));
  const inbox = fleet.readInbox(ctx, b);
  const hadExec = inbox.some(function (c) { return c && c.type === 'exec'; });
  const kept = [];
  const results = [];
  inbox.forEach(function (cmd) {
    if (!cmd || cmd.type !== 'exec') { kept.push(cmd); return; }
    // Replay protection: never re-run a ledgered command; drop stale/far-future ones.
    if (cmd.id && fleet.wasApplied(ctx, cmd.id)) { results.push({ ok: false, applied: 'exec', detail: 'skipped (already applied)', id: cmd.id }); return; }
    if (!fleet.commandFresh(ctx, cmd)) { results.push({ ok: false, applied: 'exec', detail: 'skipped (expired)', id: cmd && cmd.id }); return; }
    // Origin authentication: reject anything not signed by the sender's TOFU-pinned key.
    const origin = fleet.checkOrigin(ctx, cmd, reconcile);
    if (!origin.ok) { results.push({ ok: false, applied: 'exec', detail: 'rejected: ' + origin.reason, id: cmd.id }); return; }
    const r = applyExec(ctx, cmd, { allowExec: opts.allowExec === true, run: opts.run, timeoutMs: opts.timeoutMs, bus: b, senderKey: origin.key, requireSignature: true });
    r.id = cmd.id; r.from = cmd.from;
    if (r.skipped === 'consent') { kept.push(cmd); results.push(r); return; } // keep for a later consented drain
    if (r.ok && cmd.id) fleet.markApplied(ctx, cmd.id); // ledger so it is never verbatim-replayed
    results.push(r);
  });
  if (hadExec) { if (kept.length) b.write(fleet.inboxName(b.machineId), kept); else fleet.clearInbox(ctx, b); }
  return { results: results, kept: kept };
}

// Collect published exec results addressed to THIS machine (the initiator). Filters by group and/or a
// set of command ids, binds each result file to its claimed id, scrubs peer output, and — when a
// reconcile map is supplied — verifies each result's signed origin. opts.prune removes collected files.
function aggregate(ctx, b, opts) {
  opts = opts || {};
  const selfId = fleet.identity(ctx).machineId;
  const reconcile = opts.reconcile || null;
  const wanted = Array.isArray(opts.ids) ? indexList(opts.ids) : null;
  const nameById = Object.create(null);
  try { fleet.readFleet(ctx, b).forEach(function (s) { nameById[s.machineId] = s.name; }); } catch (e) { /* names are cosmetic */ }
  const out = [];
  b.list(RESULT_SUFFIX).forEach(function (n) {
    const obj = b.read(n);
    if (!obj || obj.type !== 'exec-result' || !fleet.safeId(obj.id)) return;
    let expect; try { expect = resultName(obj.id); } catch (e) { return; }
    if (expect !== n) return;                          // filename must match the claimed id (binding)
    if (obj.to !== selfId) return;                     // only results addressed to us are ours
    const group = obj.payload && obj.payload.group;
    if (opts.group && group !== opts.group) return;
    if (wanted && !wanted[obj.id]) return;
    let verified = null;
    if (reconcile) { verified = fleet.checkOrigin(ctx, obj, reconcile).ok; if (opts.strict && !verified) return; }
    const r = (obj.payload && obj.payload.result) || {};
    const from = fleet.safeId(obj.from) ? obj.from : null;
    out.push({
      id: obj.id, machineId: from, machine: (from && nameById[from]) || from,
      group: group == null ? null : scrub(group, 40), at: scrub(obj.at, 40),
      ok: !!r.ok, code: typeof r.code === 'number' ? r.code : null,
      stdout: scrubOut(r.stdout, MAX_OUTPUT + 32), stderr: scrubOut(r.stderr, MAX_OUTPUT + 32),
      timedOut: !!r.timedOut, command: scrub(r.command, 200), verified: verified,
    });
    if (opts.prune) b.remove(n);
  });
  return out;
}
// A null-prototype id set — a hostile id ("__proto__"/"constructor") can never pollute a prototype.
function indexList(ids) { const m = Object.create(null); ids.forEach(function (id) { if (typeof id === 'string') m[id] = 1; }); return m; }

module.exports = {
  queueExec: queueExec, applyExec: applyExec, drainExec: drainExec,
  ping: ping, aggregate: aggregate,
  publishResult: publishResult, resultName: resultName,
  targets: targets, normArgs: normArgs, normCommand: normCommand, capOutput: capOutput,
  readState: readState, writeState: writeState, statePath: statePath,
  RESULT_SUFFIX: RESULT_SUFFIX, MAX_OUTPUT: MAX_OUTPUT,
};
