// The conversation index: chunking, incremental builds, BM25, hybrid fallback, RRF and the
// char-budgeted RAG context block. Synthetic fixtures only; no embedding endpoint is contacted.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { makeCtx } from './helpers.js';
import * as convindex from '../src/convindex.js';

function ctxFor() {
  const ctx = makeCtx();
  ctx.env = {};
  return ctx;
}

function writeClaude(ctx, id, lines) {
  const dir = path.join(ctx.home, '.claude', 'projects', '-work-proj');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

function seed(ctx) {
  writeClaude(ctx, 'db-1', [
    { type: 'user', message: { role: 'user', content: 'How do we run the database migration safely?' } },
    {
      type: 'assistant',
      message: { role: 'assistant', content: 'Run the migrate command in dry-run first, then apply it.' },
    },
  ]);
  // Three oversized turns become three chunks, so expand can pull in neighbours.
  writeClaude(ctx, 'expand-1', [
    { type: 'user', message: { role: 'user', content: 'ALPHAMARKER ' + 'a'.repeat(1000) } },
    { type: 'assistant', message: { role: 'assistant', content: 'BRAVOMARKER ' + 'b'.repeat(1000) } },
    { type: 'user', message: { role: 'user', content: 'CHARLIEMARKER ' + 'c'.repeat(1000) } },
  ]);
  writeClaude(ctx, 'haiku-1', [{ type: 'user', message: { role: 'user', content: 'Write a haiku about autumn.' } }]);
  const dir = path.join(ctx.home, '.codex', 'sessions', '2026', '01', '01');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'rollout-2026-01-01T10-00-00-abc12345.jsonl'),
    [
      { type: 'session_meta', payload: { session_id: 'abc12345', cwd: '/work/codex', originator: 'codex_cli' } },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Ship the release.' }] },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
  );
}

test('build parses every app, writes chunk files, and reports real counts', async function () {
  const ctx = ctxFor();
  seed(ctx);
  const r = await convindex.build(ctx, {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.indexed, 4);
  assert.strictEqual(r.stats.sources, 4);
  assert.strictEqual(r.stats.messages, 7);
  assert.ok(r.stats.chunks >= 5);
  assert.strictEqual(r.stats.byApp.claude.sources, 3);
  assert.strictEqual(r.stats.byApp.codex.sources, 1);
  assert.strictEqual(r.embedded, 0);
  const st = convindex.status(ctx);
  assert.strictEqual(st.exists, true);
  assert.strictEqual(st.vectorChunks, 0);
  assert.ok(fs.existsSync(convindex.chunkPath(ctx, 'claude:local:db-1')));
  // The manifest is not a credential store, but it lives beside them: still 0600.
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(convindex.metaPath(ctx)).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(convindex.chunkPath(ctx, 'claude:local:db-1')).mode & 0o777, 0o600);
  }
});

test('a second build reuses unchanged files; an append re-chunks only that conversation', async function () {
  const ctx = ctxFor();
  const file = writeClaude(ctx, 'db-1', [
    { type: 'user', message: { role: 'user', content: 'How do we run the database migration safely?' } },
  ]);
  writeClaude(ctx, 'haiku-1', [{ type: 'user', message: { role: 'user', content: 'Write a haiku about autumn.' } }]);
  const first = await convindex.build(ctx, {});
  assert.strictEqual(first.indexed, 2);

  const second = await convindex.build(ctx, {});
  assert.strictEqual(second.reused, 2);
  assert.strictEqual(second.indexed, 0);

  fs.appendFileSync(
    file,
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'And then verify the migration.' } }) + '\n',
  );
  const third = await convindex.build(ctx, {});
  assert.strictEqual(third.changed, 1);
  assert.strictEqual(third.reused, 1);
  assert.strictEqual(third.stats.sources, 2);

  const forced = await convindex.build(ctx, { force: true });
  assert.strictEqual(forced.changed, 2);
  assert.strictEqual(forced.reused, 0);
});

test('a filtered build keeps conversations outside the filter', async function () {
  const ctx = ctxFor();
  seed(ctx);
  await convindex.build(ctx, {});
  const r = await convindex.build(ctx, { apps: ['codex'] });
  assert.strictEqual(r.changed, 0);
  assert.strictEqual(r.reused, 1);
  assert.strictEqual(r.stats.sources, 4); // claude sources were kept, not removed
});

test('lexical search finds content and catalog filters by title without parsing', async function () {
  const ctx = ctxFor();
  seed(ctx);
  await convindex.build(ctx, {});
  const r = convindex.lexical(ctx, 'database migration', { limit: 5 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.hits.length, 1);
  assert.strictEqual(r.hits[0].id, 'claude:local:db-1');
  assert.strictEqual(r.hits[0].app, 'claude');
  assert.match(r.hits[0].snippet, /migration/i);

  const cat = convindex.catalog(ctx, {});
  assert.strictEqual(cat.indexed, true);
  assert.strictEqual(cat.conversations.length, 4);
  assert.strictEqual(convindex.catalog(ctx, { q: 'haiku' }).conversations.length, 1);
  assert.strictEqual(convindex.catalog(ctx, { apps: ['codex'] }).conversations.length, 1);
});

test('no vectors: semantic reports no-vectors and hybrid says it ranked lexically', async function () {
  const ctx = ctxFor();
  seed(ctx);
  await convindex.build(ctx, {});
  // Must answer BEFORE calling any embedding endpoint (this test has no network dependency).
  const sem = await convindex.semantic(ctx, 'database', {});
  assert.strictEqual(sem.ok, false);
  assert.strictEqual(sem.reason, 'no-vectors');

  const hy = await convindex.search(ctx, 'database', { mode: 'hybrid', limit: 5 });
  assert.strictEqual(hy.ok, true);
  assert.strictEqual(hy.mode, 'lexical');
  assert.strictEqual(hy.semanticError, 'no-vectors');
  assert.strictEqual(hy.hits[0].id, 'claude:local:db-1');
});

test('RRF ranks a document found by both retrievers above a single-list hit', function () {
  const fused = convindex.rrf(
    [
      [{ id: 'a', chunk: 0, score: 9 }],
      [
        { id: 'a', chunk: 0, score: 0.9 },
        { id: 'b', chunk: 1, score: 0.8 },
      ],
    ],
    5,
    1,
  );
  assert.strictEqual(fused[0].id, 'a');
  assert.strictEqual(fused[1].id, 'b');
  assert.ok(fused[0].rrf > fused[1].rrf);
  assert.deepStrictEqual(fused[0].sources, { 0: true, 1: true });
  assert.strictEqual(fused[0].score, fused[0].rrf);
});

test('context pack is budgeted, sourced, and expand pulls in neighbouring chunks', async function () {
  const ctx = ctxFor();
  seed(ctx);
  await convindex.build(ctx, {});
  const hit = convindex.lexical(ctx, 'BRAVOMARKER', { limit: 1 }).hits[0];
  assert.ok(hit);
  const ex = convindex.expandHit(ctx, hit, { expand: 1 });
  assert.match(ex.text, /ALPHAMARKER/);
  assert.match(ex.text, /BRAVOMARKER/);
  assert.match(ex.text, /CHARLIEMARKER/);

  const pack = convindex.contextPack(ctx, 'BRAVOMARKER', [hit], { budget: 4000, expand: 1 });
  assert.match(pack, /^# Conversation context/);
  assert.match(pack, /source: `claude:local:expand-1`/);
  assert.match(pack, /ALPHAMARKER/);
  assert.ok(pack.length < 4500, 'budget must be respected, got ' + pack.length);

  const tight = convindex.contextPack(ctx, 'BRAVOMARKER', [hit], { budget: 300, expand: 0 });
  assert.match(tight, /_No matching chunks\._/); // too small for even one source block
});

test('chunkConversation keeps each chunk within one turn group and marks oversized turns', function () {
  const conv = {
    messages: [
      { role: 'user', text: 'short one', ts: '2026-01-01T00:00:00Z' },
      { role: 'assistant', text: 'short two', ts: null },
      { role: 'user', text: 'x'.repeat(5000), ts: null },
    ],
  };
  const chunks = convindex.chunkConversation(conv);
  assert.strictEqual(chunks[0].text, 'User: short one\n\nAssistant: short two');
  const long = chunks.filter((c) => c.n > 0);
  assert.ok(long.length >= 4); // 5000 chars split at 1400 with 180 overlap
  long.forEach((c) => assert.ok(c.text.length <= convindex.CHUNK_TARGET));
  long.forEach((c) => assert.strictEqual(c.role, 'user'));
  assert.strictEqual(new Set(chunks.map((c) => c.n)).size, chunks.length);
});
