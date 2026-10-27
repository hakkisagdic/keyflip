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

test('two transcripts that claim one id are kept apart, and the counts still match the disk', async function () {
  const ctx = ctxFor();
  const dir = path.join(ctx.home, '.codex', 'sessions', '2026', '01', '01');
  fs.mkdirSync(dir, { recursive: true });
  // Both files resolve to the same thread id (a rollout and a copy of it).
  const SHARED = '55555555-5555-4555-8555-555555555555';
  const meta = (id, sid) => ({ type: 'session_meta', payload: { id: id, session_id: sid, cwd: '/work/codex' } });
  const turn = (text) => ({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: text }] },
  });
  fs.writeFileSync(
    path.join(dir, 'rollout-2026-01-01T10-00-00-' + SHARED + '.jsonl'),
    [meta(SHARED, SHARED), turn('First copy of the thread.')].map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
  fs.writeFileSync(
    path.join(dir, 'rollout-2026-01-02T10-00-00-' + SHARED + '.jsonl'),
    [meta(SHARED, SHARED), turn('Second copy.'), turn('And a third turn.')].map((l) => JSON.stringify(l)).join('\n') +
      '\n',
  );

  const r = await convindex.build(ctx, {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.duplicates, 1, 'the collision is reported, not swallowed');
  assert.strictEqual(r.duplicateIds.length, 1);
  assert.strictEqual(r.duplicateIds[0].id, 'codex:' + SHARED);
  assert.ok(r.duplicateIds[0].as.startsWith('codex:' + SHARED + '-'));

  const meta1 = readManifest(ctx);
  const rows = Object.values(meta1.sources);
  assert.strictEqual(rows.length, 2, 'both conversations are indexed');
  // The point of the guard: every row is backed by its OWN chunk file.
  for (const row of rows) {
    const disk = chunkLineCount(ctx, row.id);
    assert.strictEqual(disk, row.chunks, 'row ' + row.id + ' must match its chunk file');
  }
  const texts = rows.map((r2) => fs.readFileSync(convindex.chunkPath(ctx, r2.id), 'utf8')).join('\n');
  assert.match(texts, /First copy of the thread\./);
  assert.match(texts, /Second copy\./);
});

test('a deleted conversation disappears from an unfiltered build (an empty app list is no filter)', async function () {
  const ctx = ctxFor();
  const file = writeClaude(ctx, 'db-1', [
    { type: 'user', message: { role: 'user', content: 'How do we run the database migration safely?' } },
  ]);
  await convindex.build(ctx, {});
  const id = 'claude:local:db-1';
  assert.ok(fs.existsSync(convindex.chunkPath(ctx, id)));

  fs.rmSync(file);
  // The CLI passes apps: [] when no --app is given — that is no filter, so the build is full.
  const r = await convindex.build(ctx, { apps: [] });
  assert.strictEqual(r.removed, 1);
  const manifest = readManifest(ctx);
  assert.strictEqual(manifest.sources[id], undefined, 'the row is gone');
  assert.strictEqual(fs.existsSync(convindex.chunkPath(ctx, id)), false, 'the chunk file is gone');
  assert.strictEqual(r.stats.sources, 0);
});

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

test('fusion keeps BM25 in front: a vector-only hit never displaces a lexical hit', function () {
  // With the classic RRF constant (k=60) "deep in both lists" outranked "rank 1 in one", which
  // made hybrid search worse than plain BM25 on every measured metric. The rank has to mean
  // something, and the vector list must not push a BM25 hit off the page.
  const lex = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, chunk: i, score: 9 - i }));
  const sem = [
    { id: 'f', chunk: 0, score: 0.9 },
    { id: 'a', chunk: 0, score: 0.8 },
  ];
  const fused = convindex.rrf([lex, sem], 10, 1);
  const ids = fused.map((h) => h.id);
  assert.deepStrictEqual(ids.slice(0, 5), ['a', 'b', 'c', 'd', 'e'], 'the lexical order survives the fusion');
  assert.ok(ids.includes('f'), 'the vector list still contributes a candidate');
  assert.ok(
    fused.find((h) => h.id === 'f').rrf < fused.find((h) => h.id === 'e').rrf,
    'a vector-only hit scores below every lexical hit',
  );
  // The semantic list is deliberately the lighter one: the lexical rank still decides the page.
  assert.ok(convindex.RRF_WEIGHTS[1] < convindex.RRF_WEIGHTS[0], 'the semantic list carries less weight');
});

test('fusion promotes a chunk that both retrievers found', function () {
  const fused = convindex.rrf(
    [
      [
        { id: 'a', chunk: 0, score: 9 },
        { id: 'b', chunk: 1, score: 8 },
        { id: 'c', chunk: 2, score: 7 },
      ],
      [
        { id: 'c', chunk: 2, score: 0.9 },
        { id: 'z', chunk: 0, score: 0.5 },
      ],
    ],
    10,
    1,
  );
  const ids = fused.map((h) => h.id);
  assert.ok(ids.indexOf('c') < ids.indexOf('b'), 'agreement outranks a lexical-only hit');
  assert.deepStrictEqual(fused.find((h) => h.id === 'c').sources, { 0: true, 1: true });
});

test('the result page is filled with distinct conversations, not with one long chat', async function () {
  const ctx = ctxFor();
  // One chat holds 120 chunks that all match, and they outrank everything else, so the top of
  // the ranking is a single conversation. The page must still be filled: a result list answers
  // "which conversations discuss this", so it needs more than one chat even when one chat wins.
  const long = [];
  for (let i = 0; i < 120; i++) {
    long.push({
      type: 'user',
      message: { role: 'user', content: 'migration '.repeat(30) + 'step ' + i + ' ' + 'x'.repeat(1100) },
    });
  }
  writeClaude(ctx, 'long-1', long);
  for (const id of ['other-1', 'other-2', 'other-3', 'other-4']) {
    writeClaude(ctx, id, [{ type: 'user', message: { role: 'user', content: 'a small migration note' } }]);
  }
  await convindex.build(ctx, {});
  const r = await convindex.lexical(ctx, 'migration', { limit: 5 });
  assert.strictEqual(r.hits.length, 5, 'the page is full');
  const ids = r.hits.map((h) => h.id);
  assert.strictEqual(new Set(ids).size, 5, 'one chunk per conversation');
  assert.ok(ids.includes('claude:local:long-1'), 'the winning chat is on the page');
});

test('equal scores keep the earlier conversation in front', async function () {
  const ctx = ctxFor();
  // Two chats with the same text get the same vector and therefore the same score. The
  // candidate heap has to break that tie the way a stable sort does, or the same query would
  // return a different conversation on every run.
  writeClaude(ctx, 'twin-a', [{ type: 'user', message: { role: 'user', content: 'identical text here' } }]);
  writeClaude(ctx, 'twin-b', [{ type: 'user', message: { role: 'user', content: 'identical text here' } }]);
  await convindex.build(ctx, { embed: true, post: stubPost({}) });
  const r = await convindex.semantic(ctx, 'identical text', { post: stubPost({}), limit: 5 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.hits.length, 2);
  assert.strictEqual(r.hits[0].score, r.hits[1].score, 'the scores are identical');
  const order = Object.keys(readManifest(ctx).sources);
  assert.ok(order.indexOf(r.hits[0].id) < order.indexOf(r.hits[1].id), 'the earlier conversation stays in front');
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

// ---- embedding: retries, skips, and honest mode labels --------------------------------------

function stubPost(counters) {
  // counters: { failTimes, calls, dims } — fails the first `failTimes` calls, then succeeds.
  return async function (url, body) {
    counters.calls = (counters.calls || 0) + 1;
    if ((counters.failTimes || 0) > 0) {
      counters.failTimes--;
      throw new Error('simulated: embed endpoint timed out');
    }
    const dim = counters.dim || 8;
    return { model: body.model, embeddings: body.input.map(() => Array(dim).fill(0.5)) };
  };
}

test('embed batches retry a flaky endpoint instead of failing the run', async function () {
  const ctx = ctxFor();
  writeClaude(ctx, 'db-1', [
    { type: 'user', message: { role: 'user', content: 'How do we run the database migration safely?' } },
    { type: 'assistant', message: { role: 'assistant', content: 'Dry run first.' } },
  ]);
  const counters = { failTimes: 2 }; // first two batches fail, then recover
  const r = await convindex.build(ctx, { embed: true, post: stubPost(counters) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.embedded, 1);
  assert.strictEqual(r.stats.chunks, r.embedding.chunks);
  assert.ok(counters.calls >= 2, 'the endpoint was retried, calls=' + counters.calls);
  const st = convindex.status(ctx);
  assert.ok(st.vectorChunks > 0, 'vectors were written');
});

test('a source that keeps failing is skipped, the rest still embed', async function () {
  const ctx = ctxFor();
  writeClaude(ctx, 'db-1', [
    { type: 'user', message: { role: 'user', content: 'First conversation text alpha.' } },
    { type: 'assistant', message: { role: 'assistant', content: 'Answer alpha.' } },
  ]);
  writeClaude(ctx, 'haiku-1', [
    { type: 'user', message: { role: 'user', content: 'Second conversation text beta.' } },
    { type: 'assistant', message: { role: 'assistant', content: 'Answer beta.' } },
  ]);
  // Every embed call fails: both sources hit 3 retries, the loop stops on the streak,
  // but the build itself still produced chunks and reports the failure honestly.
  const counters = { failTimes: 999 };
  const r = await convindex.build(ctx, { embed: true, post: stubPost(counters) });
  assert.strictEqual(r.ok, false);
  assert.match(r.embedding.error, /timed out/);
  assert.ok(r.embedding.errors >= 1, 'per-source errors are counted');
  // Lexical search still works on what was built — the corpus is not lost.
  const hits = convindex.lexical(ctx, 'alpha', { limit: 3 });
  assert.strictEqual(hits.hits.length, 1);
});

test('semantic search reports mode=semantic and no-vectors before touching an endpoint', async function () {
  const ctx = ctxFor();
  writeClaude(ctx, 'db-1', [{ type: 'user', message: { role: 'user', content: 'alpha beta gamma' } }]);
  // No index at all yet: must fail fast without embedding.
  let sem = await convindex.semantic(ctx, 'alpha', { post: stubPost({ calls: 0 }) });
  assert.strictEqual(sem.ok, false);
  assert.strictEqual(sem.reason, 'no-index');

  // Index exists but nothing is vectorized yet: also fail fast, still no endpoint call.
  await convindex.build(ctx, {});
  sem = await convindex.semantic(ctx, 'alpha', { post: stubPost({ calls: 0 }) });
  assert.strictEqual(sem.ok, false);
  assert.strictEqual(sem.reason, 'no-vectors');

  await convindex.build(ctx, { embed: true, post: stubPost({}) });
  sem = await convindex.semantic(ctx, 'alpha', { post: stubPost({}) });
  assert.strictEqual(sem.ok, true);
  assert.strictEqual(sem.mode, 'semantic', 'a semantic hit is labelled semantic');
  assert.strictEqual(sem.hits.length, 1);
});

// ---- disk/meta integrity -------------------------------------------------------------------

function readManifest(ctx) {
  return JSON.parse(fs.readFileSync(convindex.metaPath(ctx), 'utf8'));
}

function chunkLineCount(ctx, id) {
  const file = convindex.chunkPath(ctx, id);
  if (!fs.existsSync(file)) return 0;
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim()).length;
}

function totalDiskChunks(ctx) {
  const meta = readManifest(ctx);
  return Object.keys(meta.sources).reduce((n, id) => n + chunkLineCount(ctx, id), 0);
}

test('a meta row that belongs to another id is re-chunked, never reused', async function () {
  const ctx = ctxFor();
  writeClaude(ctx, 'db-1', [
    { type: 'user', message: { role: 'user', content: 'How do we run the database migration safely?' } },
    { type: 'assistant', message: { role: 'assistant', content: 'Dry run first.' } },
  ]);
  await convindex.build(ctx, {});
  const id = 'claude:local:db-1';
  // Reproduce the old collision shape: the row filed under this id actually belongs to a
  // different conversation, and this id never got a chunk file. mtime/size still match.
  const meta = readManifest(ctx);
  meta.sources[id].id = 'claude:local:somebody-else';
  fs.writeFileSync(convindex.metaPath(ctx), JSON.stringify(meta));
  fs.rmSync(convindex.chunkPath(ctx, id));

  const r = await convindex.build(ctx, {});
  assert.strictEqual(r.changed, 1);
  assert.strictEqual(r.reused, 0);
  assert.strictEqual(readManifest(ctx).sources[id].id, id);
  assert.ok(chunkLineCount(ctx, id) > 0, 'the chunk file was rebuilt');
  assert.strictEqual(r.stats.chunks, totalDiskChunks(ctx));
});

test('a missing chunk file can never be recorded as embedded; the next build heals it', async function () {
  const ctx = ctxFor();
  seed(ctx);
  await convindex.build(ctx, { embed: true, post: stubPost({}) });
  assert.strictEqual(convindex.status(ctx).coverage, 100);
  const id = 'claude:local:db-1';
  assert.strictEqual(convindex.readChunks(convindex.chunkPath(ctx, id)).length, chunkLineCount(ctx, id));

  fs.rmSync(convindex.chunkPath(ctx, id));
  // A build filtered to codex carries the claude rows over untouched. The embedding pass
  // used to read 0 chunks for the deleted one, write a 0-byte vector and count it embedded.
  const r = await convindex.build(ctx, { apps: ['codex'], embed: true, post: stubPost({}) });
  assert.strictEqual(r.rechunk, 1);
  assert.strictEqual(fs.existsSync(convindex.vectorPath(ctx, id)), false, 'no empty vector file');
  const manifest = readManifest(ctx);
  assert.strictEqual(manifest.sources[id].chunks, 0);
  assert.strictEqual(manifest.sources[id].hash, null, 'flagged for a re-chunk');
  assert.strictEqual(manifest.sources[id].vec, null);
  assert.strictEqual(manifest.stats.chunks, totalDiskChunks(ctx), 'stats never outrun the disk');

  // hash=null defeats the mtime/size shortcut, so a plain build restores the source.
  const heal = await convindex.build(ctx, {});
  assert.strictEqual(heal.changed, 1);
  assert.ok(chunkLineCount(ctx, id) > 0);
  assert.strictEqual(heal.stats.chunks, totalDiskChunks(ctx));
});

test('a torn chunk file is reconciled to the disk, never embedded as if complete', async function () {
  const ctx = ctxFor();
  writeClaude(ctx, 'expand-1', [
    { type: 'user', message: { role: 'user', content: 'ALPHAMARKER ' + 'a'.repeat(1000) } },
    { type: 'assistant', message: { role: 'assistant', content: 'BRAVOMARKER ' + 'b'.repeat(1000) } },
    { type: 'user', message: { role: 'user', content: 'CHARLIEMARKER ' + 'c'.repeat(1000) } },
  ]);
  await convindex.build(ctx, { embed: true, post: stubPost({}) });
  const id = 'claude:local:expand-1';
  const file = convindex.chunkPath(ctx, id);
  const full = convindex.readChunks(file).length;
  assert.ok(full >= 3);
  // Keep only the first line and drop the vector, so the source is picked up for embedding
  // with fewer chunks than the manifest claims.
  fs.writeFileSync(file, JSON.stringify(convindex.readChunks(file)[0]) + '\n');
  fs.rmSync(convindex.vectorPath(ctx, id));

  const r = await convindex.build(ctx, { embed: true, post: stubPost({}) });
  assert.strictEqual(r.changed, 1, 'the torn file is re-chunked from its source');
  const manifest = readManifest(ctx);
  assert.strictEqual(manifest.sources[id].chunks, full);
  assert.strictEqual(chunkLineCount(ctx, id), full);
  assert.strictEqual(manifest.sources[id].vec.count, full, 'the vector matches what is on disk');
  assert.strictEqual(r.stats.chunks, totalDiskChunks(ctx));

  const heal = await convindex.build(ctx, {});
  assert.strictEqual(heal.changed, 0);
  assert.strictEqual(chunkLineCount(ctx, id), full, 'the healed file stays whole');
  assert.strictEqual(heal.stats.chunks, totalDiskChunks(ctx));
});

test('a manifest row that lies about the chunk count is reconciled to the file, not trusted', async function () {
  const ctx = ctxFor();
  writeClaude(ctx, 'db-1', [
    { type: 'user', message: { role: 'user', content: 'How do we run the database migration safely?' } },
    { type: 'assistant', message: { role: 'assistant', content: 'Dry run first.' } },
  ]);
  await convindex.build(ctx, { embed: true, post: stubPost({}) });
  const id = 'claude:local:db-1';
  // The file on disk still holds N chunks; only the manifest row lies.
  const metaFile = convindex.metaPath(ctx);
  const lying = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  lying.sources[id].chunks = 999;
  fs.writeFileSync(metaFile, JSON.stringify(lying));

  const r = await convindex.build(ctx, { embed: true, post: stubPost({}) });
  assert.strictEqual(r.rechunk, 1);
  const after = readManifest(ctx);
  assert.strictEqual(after.sources[id].chunks, chunkLineCount(ctx, id));
  assert.strictEqual(after.sources[id].vec.count, chunkLineCount(ctx, id));
  assert.strictEqual(r.stats.chunks, totalDiskChunks(ctx));
});

test('the token sidecar speeds lexical search without changing it, and a torn/missing one falls back', async function () {
  const ctx = ctxFor();
  seed(ctx);
  await convindex.build(ctx, {});
  const id = 'claude:local:db-1';
  const tok = convindex.tokenPath(ctx, id);
  assert.ok(fs.existsSync(tok), 'the sidecar is written with the chunks');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(tok).mode & 0o777, 0o600);
  const want = convindex.lexical(ctx, 'database migration', { limit: 5 });
  assert.strictEqual(want.hits[0].id, id);
  assert.match(want.hits[0].snippet, /migration/i);
  assert.ok('role' in want.hits[0] && 'ts' in want.hits[0], 'hit metadata is hydrated from the chunk');

  // Missing sidecar: the per-source text fallback must rank identically.
  fs.rmSync(tok);
  const fallback = convindex.lexical(ctx, 'database migration', { limit: 5 });
  assert.deepStrictEqual(
    fallback.hits.map((h) => h.id),
    want.hits.map((h) => h.id),
  );

  // The next build regenerates it from the chunk file alone (still a reuse, no re-parse).
  const r = await convindex.build(ctx, {});
  assert.strictEqual(r.reused, 4);
  assert.ok(fs.existsSync(tok));

  // A torn sidecar is caught by the chunk-count check, not trusted silently.
  fs.writeFileSync(tok, Buffer.from([1, 0, 0, 0]));
  const torn = convindex.lexical(ctx, 'database migration', { limit: 5 });
  assert.deepStrictEqual(
    torn.hits.map((h) => h.id),
    want.hits.map((h) => h.id),
  );
});

test('status only counts vector files that really hold dim*count floats', async function () {
  const ctx = ctxFor();
  writeClaude(ctx, 'db-1', [{ type: 'user', message: { role: 'user', content: 'alpha beta gamma' } }]);
  await convindex.build(ctx, { embed: true, post: stubPost({}) });
  assert.strictEqual(convindex.status(ctx).coverage, 100);

  fs.writeFileSync(convindex.vectorPath(ctx, 'claude:local:db-1'), '');
  const st = convindex.status(ctx);
  assert.strictEqual(st.vectorSources, 0, 'a 0-byte vector is not coverage');
  assert.strictEqual(st.vectorChunks, 0);
  assert.strictEqual(st.coverage, 0);

  // ...and the next embed pass treats it as missing and rewrites it.
  const r = await convindex.build(ctx, { embed: true, post: stubPost({}) });
  assert.strictEqual(r.rechunk, 0);
  assert.strictEqual(r.embedded, 1);
  assert.strictEqual(convindex.status(ctx).coverage, 100);
});
