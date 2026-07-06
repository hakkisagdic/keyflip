'use strict';
// Tests for B1/B2: archive + gzip Claude Code transcripts (src/archive.js). Archiving
// moves a transcript out of ~/.claude/projects into keyflip's gzipped archive store;
// unarchive restores it. Round-trip must be byte-exact.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const archive = require('../src/archive');
const { makeCtx } = require('./helpers');

function ctxWithClaude() {
  const ctx = makeCtx();
  ctx.claudeDir = path.join(ctx.home, '.claude');
  fs.mkdirSync(path.join(ctx.claudeDir, 'projects'), { recursive: true });
  return ctx;
}
function seed(ctx, project, id, content) {
  const dir = path.join(ctx.claudeDir, 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.jsonl'), content);
  return path.join(dir, id + '.jsonl');
}

test('archiveSession gzips into the store and removes the live copy', function () {
  const ctx = ctxWithClaude();
  const body = '{"type":"user","text":"hello"}\n'.repeat(50);
  const live = seed(ctx, '-p', 'sess-1', body);
  const r = archive.archiveSession(ctx, '-p', 'sess-1');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(fs.existsSync(live), false, 'live transcript removed');
  const gz = path.join(archive.store(ctx), '-p', 'sess-1.jsonl.gz');
  assert.ok(fs.existsSync(gz), 'gzipped copy stored');
  assert.ok(r.gzBytes < r.bytes, 'compressed smaller than raw');
  assert.strictEqual(zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8'), body, 'content preserved');
});

test('unarchiveSession restores byte-exact and removes the archived copy', function () {
  const ctx = ctxWithClaude();
  const body = '{"a":1}\n{"b":2}\n';
  seed(ctx, '-proj', 'xyz', body);
  archive.archiveSession(ctx, '-proj', 'xyz');
  const r = archive.unarchiveSession(ctx, '-proj', 'xyz');
  assert.strictEqual(r.ok, true);
  const back = path.join(ctx.claudeDir, 'projects', '-proj', 'xyz.jsonl');
  assert.strictEqual(fs.readFileSync(back, 'utf8'), body);
  assert.strictEqual(fs.existsSync(path.join(archive.store(ctx), '-proj', 'xyz.jsonl.gz')), false, 'archived copy removed');
});

test('listArchived + findArchived enumerate and resolve by prefix', function () {
  const ctx = ctxWithClaude();
  seed(ctx, '-a', 'aaaa1111', 'x\n'); seed(ctx, '-b', 'bbbb2222', 'y\n');
  archive.archiveSession(ctx, '-a', 'aaaa1111');
  archive.archiveSession(ctx, '-b', 'bbbb2222');
  const all = archive.listArchived(ctx);
  assert.strictEqual(all.length, 2);
  assert.strictEqual(archive.findArchived(ctx, 'aaaa').sessionId, 'aaaa1111');
  assert.strictEqual(archive.findArchived(ctx, 'nomatch'), null);
});

test('archiveSession reports not-found for a missing transcript', function () {
  const ctx = ctxWithClaude();
  assert.strictEqual(archive.archiveSession(ctx, '-p', 'ghost').reason, 'not-found');
  assert.strictEqual(archive.unarchiveSession(ctx, '-p', 'ghost').reason, 'not-archived');
});

// SECURITY / robustness (review #18): the corrupt-archive branch and the 0600 mode must be
// exercised, else a regression (uncaught gunzip throw, or a world-readable archive) ships silently.
test('archiveSession stores the gz mode 0600; unarchiveSession reports corrupt on a bad archive', function () {
  const ctx = ctxWithClaude();
  seed(ctx, '-p', 'sc1', 'HELLO\n');
  const a = archive.archiveSession(ctx, '-p', 'sc1');
  assert.ok(a.ok);
  const gz = path.join(archive.store(ctx), '-p', 'sc1.jsonl.gz');
  assert.strictEqual(fs.statSync(gz).mode & 0o777, 0o600, 'archived gz is not world/group readable');
  // corrupt it (non-gzip bytes) and confirm unarchive returns a clean {ok:false,reason:'corrupt'}
  fs.writeFileSync(gz, 'not-a-gzip-stream');
  const u = archive.unarchiveSession(ctx, '-p', 'sc1');
  assert.strictEqual(u.ok, false);
  assert.strictEqual(u.reason, 'corrupt');
});
