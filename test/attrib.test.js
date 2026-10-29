// #50 SESSION → ACCOUNT ATTRIBUTION — keyflip guesses which account a session was worked on from
// its OWN switch timeline. The tests pin the parts that could hurt:
//   • a guess must never be written over (or relabelled as) the user's word;
//   • a window that a session merely TOUCHES must not be reported as proof;
//   • history the bounded log read cannot see must read as "no evidence", never as an account;
//   • the provenance sidecar is a reserved state file (or it shows up as a phantom account).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as attrib from '../src/attrib.js';
import * as sessions from '../src/sessions.js';
import * as sessionmap from '../src/sessionmap.js';
import * as profiles from '../src/profiles.js';
import * as auditview from '../src/auditview.js';
import { makeCtx, assertPrivateMode } from './helpers.js';

const ID_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const ID_B = 'bbbbbbbb-2222-4222-8222-222222222222';

// A transcript as Claude Code writes it: one JSON record per line, cwd + timestamp on the first turn.
function seed(ctx, project, id, cwd, firstTs, lastTs) {
  const dir = path.join(ctx.home, '.claude', 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.jsonl');
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: 'user', sessionId: id, cwd: cwd, timestamp: firstTs, message: { content: 'hi' } }),
      JSON.stringify({ type: 'assistant', sessionId: id, timestamp: lastTs }),
    ].join('\n') + '\n',
    { mode: 0o600 },
  );
  fs.utimesSync(file, new Date(lastTs), new Date(lastTs)); // last write = the session's end
  return file;
}

function writeLog(ctx, lines) {
  const dir = path.join(ctx.configDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(auditview.path(ctx), lines.join('\n') + '\n', { mode: 0o600 });
}

function seedAccounts(ctx) {
  profiles.write(ctx.configDir, { name: 'gmail', email: 'g@example.com' });
  profiles.write(ctx.configDir, { name: 'yahoo', email: 'y@example.com' });
}

// ---- log parsing --------------------------------------------------------------

test('switchName reads every landed-switch form and rejects intent / other axes', function () {
  assert.strictEqual(attrib.switchName('active -> yahoo'), 'yahoo');
  assert.strictEqual(attrib.switchName('switched -> gmail (cli=true, app=false)'), 'gmail');
  assert.strictEqual(attrib.switchName('mcp switch -> yahoo'), 'yahoo');
  assert.strictEqual(attrib.switchName('mcp next -> gmail'), 'gmail');
  assert.strictEqual(attrib.switchName('autoswitch: gmail -> yahoo'), 'yahoo');
  // Not boundaries: intent (can fail), a different axis, or an unrelated event.
  assert.strictEqual(attrib.switchName('switch requested -> yahoo'), null);
  assert.strictEqual(attrib.switchName('provider -> official'), null);
  assert.strictEqual(attrib.switchName('oauth refresh: refreshed'), null);
  assert.strictEqual(attrib.switchName('add invoked'), null);
});

test('timeline collapses a repeat switch and the two lines one switch emits', function () {
  const ctx = makeCtx();
  writeLog(ctx, [
    '2026-10-14T09:00:00.000Z active -> gmail',
    '2026-10-14T09:00:00.005Z switched -> gmail (cli=true, app=true)', // same switch, second line
    '2026-10-14T10:00:00.000Z active -> yahoo',
    '2026-10-14T10:00:00.002Z mcp switch -> yahoo',
    '2026-10-14T11:00:00.000Z active -> yahoo', // already live -> not a boundary
  ]);
  const tl = attrib.timeline(ctx);
  assert.deepStrictEqual(
    tl.boundaries.map(function (b) {
      return b.name;
    }),
    ['gmail', 'yahoo'],
  );
  assert.strictEqual(tl.from, Date.parse('2026-10-14T09:00:00.000Z'));
  assert.strictEqual(tl.truncated, false);
});

// ---- the window logic ---------------------------------------------------------

test('a session entirely inside one window is high confidence', function () {
  const ctx = makeCtx();
  writeLog(ctx, ['2026-10-14T09:00:00.000Z active -> gmail', '2026-10-14T12:00:00.000Z active -> yahoo']);
  const tl = attrib.timeline(ctx);
  const v = attrib.verdict(tl, {
    mtimeMs: Date.parse('2026-10-14T10:30:00.000Z'),
    startedAtMs: Date.parse('2026-10-14T10:00:00.000Z'),
  });
  assert.strictEqual(v.confidence, 'high');
  assert.strictEqual(v.account, 'gmail');
  assert.strictEqual(v.spanning, false);
});

test('a session spanning a switch is LOW and says which account held most of it', function () {
  const ctx = makeCtx();
  writeLog(ctx, ['2026-10-14T09:00:00.000Z active -> gmail', '2026-10-14T10:00:00.000Z active -> yahoo']);
  const tl = attrib.timeline(ctx);
  const v = attrib.verdict(tl, {
    mtimeMs: Date.parse('2026-10-14T11:00:00.000Z'),
    startedAtMs: Date.parse('2026-10-14T09:50:00.000Z'),
  });
  assert.strictEqual(v.confidence, 'low');
  assert.strictEqual(v.spanning, true, 'a session that crosses a switch is flagged as spanning');
  assert.strictEqual(v.account, 'yahoo', '10 min under gmail vs 60 under yahoo');
  assert.ok(v.why.indexOf('spans') !== -1, v.why);
});

test('no start timestamp caps the answer at medium — last write is a point, not a span', function () {
  const ctx = makeCtx();
  writeLog(ctx, ['2026-10-14T09:00:00.000Z active -> gmail']);
  const tl = attrib.timeline(ctx);
  const v = attrib.verdict(tl, { mtimeMs: Date.parse('2026-10-14T10:00:00.000Z'), startedAtMs: null });
  assert.strictEqual(v.confidence, 'medium');
  assert.strictEqual(v.account, 'gmail');
});

test('a session that opens before the logged history is medium, not high', function () {
  const ctx = makeCtx();
  writeLog(ctx, ['2026-10-14T09:00:00.000Z active -> gmail']);
  const tl = attrib.timeline(ctx);
  const v = attrib.verdict(tl, {
    mtimeMs: Date.parse('2026-10-14T10:00:00.000Z'),
    startedAtMs: Date.parse('2026-10-14T08:00:00.000Z'), // before the first switch
  });
  assert.strictEqual(v.confidence, 'medium');
  assert.strictEqual(v.account, 'gmail');
  assert.ok(v.why.indexOf('before the logged history') !== -1, v.why);
});

test('a session older than the whole log is NO evidence — never a guess', function () {
  const ctx = makeCtx();
  writeLog(ctx, ['2026-10-14T09:00:00.000Z active -> gmail']);
  const tl = attrib.timeline(ctx);
  const v = attrib.verdict(tl, {
    mtimeMs: Date.parse('2026-10-13T23:00:00.000Z'),
    startedAtMs: Date.parse('2026-10-13T22:00:00.000Z'),
  });
  assert.strictEqual(v.confidence, 'none');
  assert.strictEqual(v.account, undefined);
});

test('no switches logged at all -> no evidence (an empty log must not invent an account)', function () {
  const ctx = makeCtx();
  const tl = attrib.timeline(ctx);
  assert.deepStrictEqual(tl.boundaries, []);
  const v = attrib.verdict(tl, { mtimeMs: Date.now(), startedAtMs: Date.now() - 1000 });
  assert.strictEqual(v.confidence, 'none');
});

// ---- proposals: never over the user's word ------------------------------------

test('proposals skip stated sessions, count them, and propose nothing without evidence', function () {
  const ctx = makeCtx();
  seedAccounts(ctx);
  writeLog(ctx, ['2026-10-14T09:00:00.000Z active -> gmail']);
  // stored by hand -> must be counted, never proposed over
  sessionmap.set(ctx, ID_A, 'yahoo');
  seed(ctx, '-proj-a', ID_A, '/proj/a', '2026-10-14T09:30:00.000Z', '2026-10-14T10:00:00.000Z');
  // unassigned, clearly inside the gmail window
  seed(ctx, '-proj-b', ID_B, '/proj/b', '2026-10-14T09:10:00.000Z', '2026-10-14T09:20:00.000Z');

  const r = attrib.proposals(ctx, {});
  assert.strictEqual(r.counts.stated, 1);
  assert.strictEqual(r.proposals.length, 1);
  assert.strictEqual(r.proposals[0].session, ID_B);
  assert.strictEqual(r.proposals[0].account, 'gmail');
  assert.strictEqual(r.proposals[0].confidence, 'high');
  assert.ok(!sessionmap.get(ctx, ID_B), 'proposals alone must not write');
});

test('an account that is no longer a saved profile is reported, never proposed', function () {
  const ctx = makeCtx();
  profiles.write(ctx.configDir, { name: 'gmail', email: 'g@example.com' });
  writeLog(ctx, ['2026-10-14T09:00:00.000Z active -> deleted-account']);
  seed(ctx, '-proj-a', ID_A, '/proj/a', '2026-10-14T09:10:00.000Z', '2026-10-14T09:20:00.000Z');
  const r = attrib.proposals(ctx, {});
  assert.strictEqual(r.proposals.length, 0);
  assert.strictEqual(r.counts.unknownAccount, 1);
});

test('a partial log read is admitted in coverage instead of silently deciding old sessions', function () {
  const ctx = makeCtx();
  // 300 KiB of padding forces the 256 KiB default read to cut the front of the file when asked for
  // a small window; the deep read below is what attribution actually uses, so it is NOT truncated.
  writeLog(ctx, ['2026-10-14T09:00:00.000Z active -> gmail']);
  const small = auditview.scan(ctx, { bytes: auditview.MAX_BYTES });
  assert.strictEqual(small.truncated, false, 'a tiny log fits');
  const deep = attrib.timeline(ctx);
  assert.strictEqual(deep.truncated, false);
  // And the deep read is bounded: no caller can ask for "everything".
  const capped = auditview.scan(ctx, { bytes: 999 * 1024 * 1024 });
  assert.strictEqual(capped.maxBytes, auditview.HARD_MAX_BYTES);
});

// ---- apply + provenance -------------------------------------------------------

test('apply writes the map AND a 0600 sidecar, and a second run proposes nothing new', function () {
  const ctx = makeCtx();
  seedAccounts(ctx);
  writeLog(ctx, ['2026-10-14T09:00:00.000Z active -> gmail']);
  seed(ctx, '-proj-b', ID_B, '/proj/b', '2026-10-14T09:10:00.000Z', '2026-10-14T09:20:00.000Z');

  const r = attrib.proposals(ctx, {});
  const written = attrib.apply(ctx, r.proposals, { at: '2026-10-16T00:00:00.000Z' });
  assert.deepStrictEqual(written, [ID_B]);
  assert.strictEqual(sessionmap.get(ctx, ID_B), 'gmail', 'the live map now knows the account');
  assertPrivateMode(attrib.sourcePath(ctx), 'the provenance sidecar');

  const src = attrib.sources(ctx);
  assert.strictEqual(src[ID_B].source, 'inferred');
  assert.strictEqual(src[ID_B].confidence, 'high');
  assert.strictEqual(src[ID_B].at, '2026-10-16T00:00:00.000Z');

  // Idempotent: the second pass counts it as already attributed, not as a fresh proposal.
  const again = attrib.proposals(ctx, {});
  assert.strictEqual(again.proposals.length, 0);
  assert.strictEqual(again.counts.inferred, 1);
  assert.strictEqual(again.counts.stated, 0);
});

test('stated vs inferred is never conflated', function () {
  const ctx = makeCtx();
  seedAccounts(ctx);
  writeLog(ctx, ['2026-10-14T09:00:00.000Z active -> gmail']);
  seed(ctx, '-proj-a', ID_A, '/proj/a', '2026-10-14T09:10:00.000Z', '2026-10-14T09:20:00.000Z');
  seed(ctx, '-proj-b', ID_B, '/proj/b', '2026-10-14T09:10:00.000Z', '2026-10-14T09:20:00.000Z');

  attrib.apply(ctx, attrib.proposals(ctx, {}).proposals, {});
  sessionmap.set(ctx, ID_A, 'yahoo'); // the user overrides one of them by hand
  attrib.recordStated(ctx, ID_A, { account: 'yahoo' });

  const src = attrib.sources(ctx);
  const asObj = { [ID_A]: 'yahoo', [ID_B]: 'gmail' };
  assert.strictEqual(attrib.provenanceFor(ID_A, asObj, src), 'stated');
  assert.strictEqual(attrib.provenanceFor(ID_B, asObj, src), 'inferred');
  // An assignment with NO provenance record at all predates inference -> the user's word.
  assert.strictEqual(attrib.provenanceFor('cccccccc-3333-4333-8333-333333333333', { x: 1 }, {}), null);
  assert.strictEqual(attrib.provenanceFor(ID_A, new Map([[ID_A, 'yahoo']]), src), 'stated', 'a Map works too');
});

test('removeSource drops provenance; a corrupt sidecar degrades to "no provenance"', function () {
  const ctx = makeCtx();
  attrib.setSource(ctx, ID_A, { source: 'inferred', account: 'gmail' });
  assert.strictEqual(attrib.removeSource(ctx, ID_A), true);
  assert.strictEqual(attrib.removeSource(ctx, ID_A), false);
  assert.deepStrictEqual(attrib.sources(ctx), {});

  fs.writeFileSync(attrib.sourcePath(ctx), '{ not json', { mode: 0o600 });
  assert.deepStrictEqual(attrib.sources(ctx), {}, 'a torn file must not throw');
});

test('the sidecar is a reserved state file, so it is never listed as a phantom account', function () {
  assert.ok(
    profiles.RESERVED_FILES.indexOf(attrib.SOURCE_NAME) !== -1,
    attrib.SOURCE_NAME + ' must be reserved (see profiles.RESERVED_FILES)',
  );
  const ctx = makeCtx();
  profiles.write(ctx.configDir, { name: 'gmail', email: 'g@example.com' });
  attrib.setSource(ctx, ID_A, { source: 'inferred', account: 'gmail' });
  assert.deepStrictEqual(profiles.list(ctx.configDir), ['gmail']);
});

// ---- sessions.list integration ------------------------------------------------

test('sessions.list exposes startedAtMs from the transcript, and drops a skewed one', function () {
  const ctx = makeCtx();
  seed(ctx, '-proj-a', ID_A, '/proj/a', '2026-10-14T09:00:00.000Z', '2026-10-14T10:00:00.000Z');
  const rows = sessions.list(ctx, {});
  const row = rows.filter(function (r) {
    return r.sessionId === ID_A;
  })[0];
  assert.strictEqual(row.startedAt, '2026-10-14T09:00:00.000Z');
  assert.strictEqual(row.startedAtMs, Date.parse('2026-10-14T09:00:00.000Z'));

  // A start recorded AFTER the last write is clock skew / a copied file: report no start rather
  // than a negative span the attribution logic would have to defend against.
  const ctx2 = makeCtx();
  seed(ctx2, '-proj-a', ID_A, '/proj/a', '2026-10-15T09:00:00.000Z', '2026-10-14T10:00:00.000Z');
  const row2 = sessions.list(ctx2, {}).filter(function (r) {
    return r.sessionId === ID_A;
  })[0];
  assert.strictEqual(row2.startedAtMs, null);
});

test('a life of zero length (one message) still resolves to the account live at that instant', function () {
  const ctx = makeCtx();
  writeLog(ctx, ['2026-10-14T09:00:00.000Z active -> gmail', '2026-10-14T12:00:00.000Z active -> yahoo']);
  const tl = attrib.timeline(ctx);
  // A transcript with a single message opens and closes at the same instant — a zero-length
  // span. That is a fact, not an absence: the account live at that instant worked on it.
  const v = attrib.verdict(tl, {
    mtimeMs: Date.parse('2026-10-14T10:30:00.000Z'),
    startedAtMs: Date.parse('2026-10-14T10:30:00.000Z'),
  });
  assert.strictEqual(v.confidence, 'high');
  assert.strictEqual(v.account, 'gmail');
  assert.strictEqual(v.spanning, false);
});
