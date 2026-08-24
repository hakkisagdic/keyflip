// Reader for the action/audit log (<configDir>/logs/keyflip.log). Covers the
// happy path plus hostile/edge input: missing file, huge file (tail-only read),
// blank/malformed lines, filters, and the strict read-only ("never create")
// contract. The log's writer is src/log.js.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as auditview from '../src/auditview.js';
import * as logmod from '../src/log.js';
import { makeCtx } from './helpers.js';

function logDir(ctx) {
  return path.join(ctx.configDir, 'logs');
}

// Write raw log lines EXACTLY as log.js would ("<ts> <msg>\n"), joined by `sep`.
function writeLog(ctx, lines, sep) {
  sep = sep || '\n';
  fs.mkdirSync(logDir(ctx), { recursive: true });
  fs.writeFileSync(auditview.path(ctx), lines.join(sep) + sep, { mode: 0o600 });
}

test('path() points at <configDir>/logs/keyflip.log', function () {
  const ctx = makeCtx();
  assert.strictEqual(auditview.path(ctx), path.join(ctx.configDir, 'logs', 'keyflip.log'));
});

test('missing file -> [] and NEVER creates the file or its dir', function () {
  const ctx = makeCtx();
  assert.deepStrictEqual(auditview.tail(ctx, {}), []);
  assert.deepStrictEqual(auditview.tail(ctx), []); // opts omitted entirely
  assert.strictEqual(fs.existsSync(auditview.path(ctx)), false, 'log file must not be created');
  assert.strictEqual(fs.existsSync(logDir(ctx)), false, 'logs dir must not be created');
});

test('happy path: parses "<ts> <msg>", newest LAST, ts + msg split correctly', function () {
  const ctx = makeCtx();
  writeLog(ctx, [
    '2026-01-01T00:00:01.000Z switched to work',
    '2026-01-01T00:00:02.000Z added account home',
    '2026-01-01T00:00:03.000Z cleaned stale creds',
  ]);
  const out = auditview.tail(ctx, {});
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(out[0], { ts: '2026-01-01T00:00:01.000Z', msg: 'switched to work' });
  assert.strictEqual(out[2].msg, 'cleaned stale creds', 'newest entry is last');
});

test('message keeps every space after the first (split on first space only)', function () {
  const ctx = makeCtx();
  writeLog(ctx, ['2026-01-01T00:00:01.000Z a  b   c']);
  assert.strictEqual(auditview.tail(ctx, {})[0].msg, 'a  b   c');
});

test('limit: default 50, custom N, and non-positive/garbage falls back to 50', function () {
  const ctx = makeCtx();
  const lines = [];
  for (let i = 0; i < 120; i++) lines.push('2026-01-01T00:00:00.000Z msg ' + i);
  writeLog(ctx, lines);
  assert.strictEqual(auditview.tail(ctx, {}).length, 50, 'default 50');
  assert.strictEqual(auditview.tail(ctx, { limit: 10 }).length, 10);
  assert.strictEqual(auditview.tail(ctx, { limit: 10 })[9].msg, 'msg 119', 'newest kept, newest last');
  assert.strictEqual(auditview.tail(ctx, { limit: 0 }).length, 50, '0 -> default');
  assert.strictEqual(auditview.tail(ctx, { limit: -5 }).length, 50, 'negative -> default');
  assert.strictEqual(auditview.tail(ctx, { limit: 'x' }).length, 50, 'NaN -> default');
  assert.strictEqual(auditview.tail(ctx, { limit: 1e9 }).length, 120, 'huge limit is capped by data');
});

test('grep: case-insensitive substring, matches the MESSAGE only', function () {
  const ctx = makeCtx();
  writeLog(ctx, [
    '2026-01-01T00:00:01.000Z Switched to work',
    '2026-01-01T00:00:02.000Z added account',
    '2026-01-01T00:00:03.000Z switch failed: token expired',
  ]);
  const m = auditview.tail(ctx, { grep: 'SWITCH' });
  assert.strictEqual(m.length, 2);
  assert.strictEqual(m[0].msg, 'Switched to work');
  assert.strictEqual(m[1].msg, 'switch failed: token expired');
  // the timestamp is NOT part of the grep target
  assert.strictEqual(auditview.tail(ctx, { grep: '2026' }).length, 0, 'grep does not match the ts');
  // empty grep is a no-op filter (all rows)
  assert.strictEqual(auditview.tail(ctx, { grep: '' }).length, 3);
});

test('grep is a literal substring, not a regex', function () {
  const ctx = makeCtx();
  writeLog(ctx, ['2026-01-01T00:00:01.000Z plain message', '2026-01-01T00:00:02.000Z has .* literal']);
  const m = auditview.tail(ctx, { grep: '.*' });
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].msg, 'has .* literal');
});

test('since: inclusive at/after; unparseable since is ignored', function () {
  const ctx = makeCtx();
  writeLog(ctx, ['2026-01-01T00:00:01.000Z one', '2026-01-01T00:00:02.000Z two', '2026-01-01T00:00:03.000Z three']);
  const m = auditview.tail(ctx, { since: '2026-01-01T00:00:02.000Z' });
  assert.deepStrictEqual(
    m.map(function (e) {
      return e.msg;
    }),
    ['two', 'three'],
    'boundary is inclusive',
  );
  assert.strictEqual(auditview.tail(ctx, { since: '2026-01-01T00:00:04.000Z' }).length, 0);
  // a since that Date.parse cannot read must NOT hide everything
  assert.strictEqual(auditview.tail(ctx, { since: 'not-a-date' }).length, 3);
  assert.strictEqual(auditview.tail(ctx, { since: '' }).length, 3, 'empty since is a no-op');
});

test('since accepts a looser ISO form (numeric compare, not string compare)', function () {
  const ctx = makeCtx();
  writeLog(ctx, ['2026-01-01T00:00:01.000Z one', '2026-01-01T00:00:03.000Z three']);
  // date-only since -> midnight; both entries are after it
  assert.strictEqual(auditview.tail(ctx, { since: '2026-01-01' }).length, 2);
});

test('grep + since + limit compose', function () {
  const ctx = makeCtx();
  writeLog(ctx, [
    '2026-01-01T00:00:01.000Z switch a',
    '2026-01-01T00:00:02.000Z noise',
    '2026-01-01T00:00:03.000Z switch b',
    '2026-01-01T00:00:04.000Z switch c',
  ]);
  const m = auditview.tail(ctx, { grep: 'switch', since: '2026-01-01T00:00:02.000Z', limit: 1 });
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].msg, 'switch c', 'newest matching kept');
});

test('hostile input: blank lines, whitespace-only lines, and a line with no space', function () {
  const ctx = makeCtx();
  writeLog(ctx, ['', '   ', '2026-01-01T00:00:01.000Z real entry', 'no-space-line', '']);
  const out = auditview.tail(ctx, {});
  assert.strictEqual(out.length, 2, 'blank/whitespace lines skipped');
  assert.deepStrictEqual(out[0], { ts: '2026-01-01T00:00:01.000Z', msg: 'real entry' });
  assert.deepStrictEqual(out[1], { ts: 'no-space-line', msg: '' }, 'no-space line: whole line is ts, empty msg');
});

test('CRLF line endings: trailing \\r is stripped from the message', function () {
  const ctx = makeCtx();
  writeLog(ctx, ['2026-01-01T00:00:01.000Z alpha', '2026-01-01T00:00:02.000Z beta'], '\r\n');
  const out = auditview.tail(ctx, {});
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[1].msg, 'beta', 'no trailing carriage return');
});

test('huge file: reads only the tail, drops the partial first line, no corruption', function () {
  const ctx = makeCtx();
  const lines = [];
  const total = 20000; // well over MAX_BYTES (256 KB) of "<ts> msg N\n"
  for (let i = 0; i < total; i++) lines.push('2026-01-01T00:00:00.000Z entry ' + i);
  writeLog(ctx, lines);
  assert.ok(fs.statSync(auditview.path(ctx)).size > auditview.MAX_BYTES, 'test fixture must exceed the cap');

  const out = auditview.tail(ctx, { limit: 5 });
  assert.strictEqual(out.length, 5);
  assert.strictEqual(out[4].msg, 'entry ' + (total - 1), 'the very newest line survives');
  assert.strictEqual(out[0].msg, 'entry ' + (total - 5));
  // Every returned entry must be a cleanly-parsed row (no mid-line byte garbage
  // from the tail cut leaking into a ts).
  out.forEach(function (e) {
    assert.strictEqual(Number.isNaN(Date.parse(e.ts)), false, 'ts parses: ' + e.ts);
  });
});

test('reading never mutates the file', function () {
  const ctx = makeCtx();
  writeLog(ctx, ['2026-01-01T00:00:01.000Z x', '2026-01-01T00:00:02.000Z y']);
  const before = fs.readFileSync(auditview.path(ctx));
  auditview.tail(ctx, {});
  auditview.tail(ctx, { grep: 'x', since: '2026-01-01', limit: 1 });
  const after = fs.readFileSync(auditview.path(ctx));
  assert.ok(before.equals(after), 'file bytes unchanged by reads');
});

test('integration: entries written by src/log.js are read back', function () {
  const ctx = makeCtx();
  logmod.init(ctx.configDir, false); // real writer -> real <configDir>/logs/keyflip.log
  logmod.log('switched profile work');
  logmod.log('cleaned stale creds');
  const out = auditview.tail(ctx, {});
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].msg, 'switched profile work');
  assert.strictEqual(out[1].msg, 'cleaned stale creds', 'newest last');
  assert.strictEqual(Number.isNaN(Date.parse(out[0].ts)), false, 'writer ts is ISO-parseable');
});
