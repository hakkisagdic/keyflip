// The conversation index: chunking, incremental builds, BM25, hybrid fallback, RRF and the
// char-budgeted RAG context block. Synthetic fixtures only; no embedding endpoint is contacted.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { makeCtx } from './helpers.js';
import * as convindex from '../src/convindex.js';
import * as profiles from '../src/profiles.js';

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
  // A question, its answer, and a second question: two chunks, so expand has a neighbour.
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

  // The lexical list is hydrated wide (50) so fusion has candidates to work with; with no
  // semantic list the fallback must still cut back to the page that was asked for.
  const tight = await convindex.search(ctx, 'database', { mode: 'hybrid', limit: 1 });
  assert.strictEqual(tight.hits.length, 1);
  assert.strictEqual(tight.collapsed, 0);
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
  ).hits;
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
  const fused = convindex.rrf([lex, sem], 10, 1).hits;
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
  ).hits;
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
    // Distinct texts on purpose: identical notes would (correctly) collapse into `alsoIn`.
    writeClaude(ctx, id, [{ type: 'user', message: { role: 'user', content: 'a small migration note for ' + id } }]);
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
  // return a different conversation on every run. The second copy is folded into `alsoIn`
  // (same text, another conversation), so the page shows the earlier one and still names it.
  writeClaude(ctx, 'twin-a', [{ type: 'user', message: { role: 'user', content: 'identical text here' } }]);
  writeClaude(ctx, 'twin-b', [{ type: 'user', message: { role: 'user', content: 'identical text here' } }]);
  await convindex.build(ctx, { embed: true, post: stubPost({}) });
  const r = await convindex.semantic(ctx, 'identical text', { post: stubPost({}), limit: 5 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.hits.length, 1, 'one page slot, not the same paragraph twice');
  const order = Object.keys(readManifest(ctx).sources);
  assert.strictEqual(r.hits[0].id, order[0], 'the earlier conversation stays in front');
  assert.deepStrictEqual(r.hits[0].alsoIn, [order[1]]);
  assert.strictEqual(r.collapsed, 1);
});

test('identical text in a forked session fills one page slot and names the twin', async function () {
  const ctx = ctxFor();
  // A resumed/forked session repeats the earlier turns verbatim. Showing the same paragraph
  // twice spends two page slots on one answer, so the copy is folded into `alsoIn`.
  const line = [
    { type: 'user', message: { role: 'user', content: 'deploy the service to staging with kubectl' } },
    { type: 'assistant', message: { role: 'assistant', content: 'Run kubectl apply -k overlays/staging.' } },
  ];
  writeClaude(ctx, 'fork-a', line);
  writeClaude(ctx, 'fork-b', line);
  writeClaude(ctx, 'other-1', [{ type: 'user', message: { role: 'user', content: 'deploy unrelated thing' } }]);
  writeClaude(ctx, 'other-2', [{ type: 'user', message: { role: 'user', content: 'deploy another thing' } }]);
  await convindex.build(ctx, {});
  const r = convindex.lexical(ctx, 'kubectl staging deploy', { limit: 3 });
  const ids = r.hits.map((h) => h.id);
  const forks = ids.filter((id) => id === 'claude:local:fork-a' || id === 'claude:local:fork-b');
  assert.strictEqual(forks.length, 1, 'the twin is not printed twice');
  const kept = r.hits.find((h) => h.id === forks[0]);
  assert.strictEqual(kept.alsoIn.length, 1, 'the other conversation is named, not lost');
  assert.ok(['claude:local:fork-a', 'claude:local:fork-b'].includes(kept.alsoIn[0]));
  assert.strictEqual(r.collapsed, 1);
  assert.strictEqual(new Set(ids).size, ids.length, 'the page still holds distinct conversations');
  assert.strictEqual(ids.length, 3, 'the freed slot went to another conversation');
});

test('fusion collapses a duplicate that each retriever found separately', function () {
  const lex = [
    { id: 'a', chunk: 0, score: 9, chunkHash: 'h1', alsoIn: [] },
    { id: 'c', chunk: 0, score: 8, chunkHash: 'h2', alsoIn: [] },
  ];
  const sem = [
    { id: 'b', chunk: 3, score: 0.9, chunkHash: 'h1', alsoIn: [] },
    { id: 'd', chunk: 0, score: 0.8, chunkHash: 'h3', alsoIn: [] },
  ];
  const fused = convindex.rrf([lex, sem], 10, 1);
  const ids = fused.hits.map((h) => h.id);
  assert.deepStrictEqual(ids, ['a', 'c', 'd'], 'the same text arrives once, as the higher-ranked id');
  assert.deepStrictEqual(fused.hits[0].alsoIn, ['b']);
  assert.strictEqual(fused.collapsed, 1);
});

test('chunks cut by an older scheme are rebuilt even when the transcript is untouched', async function () {
  const ctx = ctxFor();
  writeClaude(ctx, 'db-1', [
    { type: 'user', message: { role: 'user', content: 'How do we run the database migration safely?' } },
  ]);
  await convindex.build(ctx, {});
  // Simulate a row written by the previous scheme: same id, same hash, same mtime/size — only
  // the chunking rules are older. Reusing it would keep serving chunks cut the old way.
  const meta = readManifest(ctx);
  meta.sources['claude:local:db-1'].chunkScheme = convindex.CHUNK_SCHEME - 1;
  fs.writeFileSync(convindex.metaPath(ctx), JSON.stringify(meta));
  const r = await convindex.build(ctx, {});
  assert.strictEqual(r.changed, 1, 'the source is re-chunked');
  assert.strictEqual(r.reused, 0);
  assert.strictEqual(readManifest(ctx).sources['claude:local:db-1'].chunkScheme, convindex.CHUNK_SCHEME);
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

test('chunkConversation keeps a question with its answer and never orphans an answer', function () {
  // The v1 packer flushed as soon as the window filled, so a 1200-char question followed by a
  // 1200-char answer left "Assistant: …" alone at the top of the next chunk: 12.6% of the live
  // index looked like that, and a hit on one carried no question terms at all.
  const q = 'Q'.repeat(1200);
  const a = 'A'.repeat(1200);
  const chunks = convindex.chunkConversation({
    messages: [
      { role: 'user', text: q, ts: '2026-01-01T00:00:00Z' },
      { role: 'assistant', text: a, ts: null },
    ],
  });
  assert.ok(chunks.length >= 2, 'a 2400-char turn is split, it is bigger than a chunk');
  chunks.forEach((c) => assert.match(c.text.slice(0, 7), /^User: Q/, 'every piece starts with the question'));
  assert.strictEqual(chunks[0].ts, '2026-01-01T00:00:00Z');
});

test('chunkConversation packs short turns and marks oversized ones', function () {
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
  assert.ok(long[0].text.length <= convindex.CHUNK_TARGET);
  // Continuations carry a short copy of the question they answer (bounded, so it cannot grow).
  long.slice(1).forEach((c) => {
    assert.ok(c.text.startsWith('User: xxxx'));
    assert.ok(c.text.length <= convindex.CHUNK_TARGET + 240);
  });
  long.forEach((c) => assert.strictEqual(c.role, 'user'));
  assert.strictEqual(new Set(chunks.map((c) => c.n)).size, chunks.length);
});

test('a tool result is indexed by its head, labelled, not swallowed into the answer', function () {
  // Cursor is the only adapter that keeps a tool's payload in the message text. A 40 KB `cat`
  // would otherwise own dozens of chunks and drown the turn it belongs to; the head keeps an
  // error string or a path searchable, and the label says whose words these are not.
  const dump = 'Exit code: 1\n' + 'stack frame line\n'.repeat(3000);
  const conv = {
    messages: [
      { role: 'user', text: 'why did the build fail?' },
      { role: 'assistant', text: 'the retry count', machine: false },
      { role: 'assistant', text: dump, machine: true },
    ],
  };
  const chunks = convindex.chunkConversation(conv);
  assert.strictEqual(chunks.length, 1, 'the capped payload fits in the turn');
  assert.match(chunks[0].text, /why did the build fail\?/);
  assert.match(chunks[0].text, /Assistant: the retry count/);
  assert.match(chunks[0].text, /Tool output: Exit code: 1/);
  assert.ok(chunks[0].text.length < convindex.CHUNK_TARGET * 1.5, 'the dump does not fill the chunk');
  // A message that is not a tool payload is untouched — no label, no cap.
  const plain = convindex.chunkConversation({ messages: [{ role: 'assistant', text: dump.slice(0, 100) }] });
  assert.strictEqual(plain[0].text, 'Assistant: ' + dump.slice(0, 100));
});

test('a question and its answer stay in one chunk when they fit together', function () {
  const q = 'How do I replay the WAL? ' + 'context '.repeat(80);
  const a = 'Recover the overlay before reading. ' + 'detail '.repeat(80);
  const chunks = convindex.chunkConversation({
    messages: [
      { role: 'user', text: q },
      { role: 'assistant', text: a },
    ],
  });
  assert.strictEqual(chunks.length, 1);
  assert.match(chunks[0].text, /^User: How do I replay the WAL\?/);
  assert.match(chunks[0].text, /Assistant: Recover the overlay/);
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
  assert.ok(full >= 2, 'the exchange is one chunk and the next question another');
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

// ---- which account worked on it ------------------------------------------------------------
// The manifest row carries the account, so `conv list` can show it and `conv search --account`
// can filter on it without re-reading a single transcript.

test('the manifest stores the account that worked on a conversation, and keeps the label', async function () {
  const ctx = ctxFor();
  profiles.write(ctx.configDir, { name: 'gmail', email: 'g@example.com' });
  const logDir = path.join(ctx.configDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(
    path.join(logDir, 'keyflip.log'),
    '2026-10-14T09:00:00.000Z active -> gmail\n2026-10-14T20:00:00.000Z active -> yahoo\n',
    { mode: 0o600 },
  );
  writeClaude(ctx, 'db-1', [
    {
      type: 'user',
      timestamp: '2026-10-14T10:00:00.000Z',
      message: { role: 'user', content: 'How do we run the database migration safely?' },
    },
    {
      type: 'assistant',
      timestamp: '2026-10-14T10:30:00.000Z',
      message: { role: 'assistant', content: 'Run migrate in dry-run first, then apply it.' },
    },
  ]);

  const r = await convindex.build(ctx, {});
  assert.strictEqual(r.ok, true);
  const row = Object.values(readManifest(ctx).sources).find((s) => s.id === 'claude:local:db-1');
  assert.ok(row, 'the transcript is indexed');
  assert.strictEqual(row.account, 'gmail');
  assert.strictEqual(row.accountSource, 'inferred');
  assert.strictEqual(row.accountConfidence, 'high');

  // The second build (this is what `conv index --schedule` runs) must NOT relabel the
  // inference as the user's word.
  await convindex.build(ctx, {});
  const row2 = Object.values(readManifest(ctx).sources).find((s) => s.id === 'claude:local:db-1');
  assert.strictEqual(row2.account, 'gmail');
  assert.strictEqual(row2.accountSource, 'inferred', 'an inference stays an inference');
});

test('the account filter uses the stored account', async function () {
  const ctx = ctxFor();
  profiles.write(ctx.configDir, { name: 'gmail', email: 'g@example.com' });
  const logDir = path.join(ctx.configDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'keyflip.log'), '2026-10-14T09:00:00.000Z active -> gmail\n', {
    mode: 0o600,
  });
  writeClaude(ctx, 'db-1', [
    {
      type: 'user',
      timestamp: '2026-10-14T10:00:00.000Z',
      message: { role: 'user', content: 'database migration plan' },
    },
  ]);
  writeClaude(ctx, 'haiku-1', [
    {
      type: 'user',
      timestamp: '2026-10-14T10:10:00.000Z',
      message: { role: 'user', content: 'a haiku about autumn' },
    },
  ]);
  await convindex.build(ctx, {});

  const all = convindex.catalog(ctx, {});
  assert.strictEqual(all.conversations.length, 2);
  const only = convindex.catalog(ctx, { account: 'gmail' });
  assert.strictEqual(only.conversations.length, 2, 'both sit in the gmail window');
  const none = convindex.catalog(ctx, { account: 'yahoo' });
  assert.strictEqual(none.conversations.length, 0, 'a row that is not there never matches');
});

test('when the embedding model changes, vectors regenerate incrementally newest-first across dimension changes', async function () {
  const ctx = ctxFor();
  writeClaude(ctx, 'old-chat', [
    {
      type: 'user',
      timestamp: '2026-10-01T10:00:00.000Z',
      message: { role: 'user', content: 'Older conversation about budget notifications.' },
    },
  ]);
  writeClaude(ctx, 'new-chat', [
    {
      type: 'user',
      timestamp: '2026-10-15T10:00:00.000Z',
      message: { role: 'user', content: 'Newest conversation about harcama sınırına yaklaşınca bütçe.' },
    },
  ]);

  // Initial embedding pass with an older 8-dim model (e.g. nomic-embed-text).
  const r1 = await convindex.build(ctx, {
    embed: true,
    model: 'nomic-embed-text',
    post: stubPost({ dim: 8 }),
  });
  assert.strictEqual(r1.embedded, 2);
  assert.strictEqual(convindex.status(ctx, { model: 'nomic-embed-text' }).coverage, 100);

  // Switch active model to bge-m3 (16-dim in this stub): coverage for bge-m3 starts at 0%
  // while staleVectorChunks tracks the 2 old nomic-embed-text vectors on disk.
  const stBefore = convindex.status(ctx, { model: 'bge-m3' });
  assert.strictEqual(stBefore.coverage, 0);
  assert.strictEqual(stBefore.staleVectorSources, 2);
  assert.strictEqual(stBefore.staleModel, 'nomic-embed-text');

  // Incremental pass capped at 1 source (maxEmbedSources: 1): must embed new-chat first!
  const r2 = await convindex.build(ctx, {
    embed: true,
    model: 'bge-m3',
    maxEmbedSources: 1,
    post: stubPost({ dim: 16 }),
  });
  assert.strictEqual(r2.embedded, 1);
  assert.strictEqual(r2.embedding.remainingSources, 1);
  const metaMid = readManifest(ctx);
  assert.strictEqual(metaMid.sources['claude:local:new-chat'].vec.model, 'bge-m3');
  assert.strictEqual(metaMid.sources['claude:local:new-chat'].vec.dim, 16);
  assert.strictEqual(metaMid.sources['claude:local:old-chat'].vec.model, 'nomic-embed-text');

  // Hybrid search works seamlessly mid-migration when mode='hybrid' is requested.
  const hyMid = await convindex.search(ctx, 'harcama bütçe', {
    mode: 'hybrid',
    model: 'bge-m3',
    post: stubPost({ dim: 16 }),
  });
  assert.strictEqual(hyMid.ok, true);
  assert.strictEqual(hyMid.mode, 'hybrid');
  assert.strictEqual(hyMid.semanticCoverage.sources, 1);

  // Second incremental pass finishes the remaining source (old-chat).
  const r3 = await convindex.build(ctx, {
    embed: true,
    model: 'bge-m3',
    post: stubPost({ dim: 16 }),
  });
  assert.strictEqual(r3.embedded, 1);
  assert.strictEqual(r3.embedding.remainingSources, 0);
  const stAfter = convindex.status(ctx, { model: 'bge-m3' });
  assert.strictEqual(stAfter.coverage, 100);
  assert.strictEqual(stAfter.staleVectorSources, 0);
});

test('search() defaults to lexical (pure BM25) when opts.mode is omitted, never hitting the embedding endpoint', async function () {
  // MEDIUM 3: Library callers that omit opts.mode must get local BM25, not a network call.
  const ctx = ctxFor();
  writeClaude(ctx, 'db-1', [
    { type: 'user', message: { role: 'user', content: 'How do we run the database migration safely?' } },
  ]);
  await convindex.build(ctx, { embed: true, post: stubPost({ dim: 8 }) });
  const counters = { calls: 0 };
  const res = await convindex.search(ctx, 'database migration', {
    post: stubPost(counters),
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.hits.length, 1);
  assert.strictEqual(counters.calls, 0, 'omitting mode must not call the embedding endpoint');
});

test('a plain build (no --embed) never spawns a background embedding worker when stored space differs from default', async function () {
  // MEDIUM 4: Plain `keyflip conv index` (no --embed) must not silently start a detached
  // embedding worker or trigger hours of GPU/CPU work on upgrade.
  const ctx = ctxFor();
  writeClaude(ctx, 'db-1', [
    { type: 'user', message: { role: 'user', content: 'How do we run the database migration safely?' } },
  ]);
  await convindex.build(ctx, { embed: true, model: 'nomic-embed-text', post: stubPost({ dim: 8 }) });
  const savedNodeTest = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    const r = await convindex.build(ctx, {
      model: 'bge-m3',
      spawn: function () {
        return { pid: process.ppid, unref: function () {} };
      },
    });
    assert.strictEqual(r.backgroundEmbed, undefined, 'plain build must not trigger backgroundEmbed');
    assert.strictEqual(fs.existsSync(convindex.embedLockPath(ctx)), false, 'plain build must not create embed.lock');
  } finally {
    if (savedNodeTest !== undefined) process.env.NODE_TEST_CONTEXT = savedNodeTest;
    fs.rmSync(convindex.embedLockPath(ctx), { force: true });
  }
});

test('read-only search paths (semantic and search) never spawn a background writer process even when stale vectors exist', async function () {
  // HIGH 2: Read-only search paths must never start detached writer processes as a side effect.
  const ctx = ctxFor();
  writeClaude(ctx, 'old-chat', [
    { type: 'user', message: { role: 'user', content: 'Older conversation about database migrations.' } },
  ]);
  await convindex.build(ctx, { embed: true, model: 'nomic-embed-text', post: stubPost({ dim: 8 }) });
  let spawnCalls = 0;
  const customSpawn = function () {
    spawnCalls++;
    return { pid: 99999, unref: function () {} };
  };
  const savedNodeTest = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    const sem = await convindex.semantic(ctx, 'database', {
      model: 'bge-m3',
      spawn: customSpawn,
    });
    assert.strictEqual(sem.ok, false);
    assert.strictEqual(sem.reason, 'no-vectors');
    assert.strictEqual(spawnCalls, 0, 'semantic() must never spawn a background worker');
    assert.strictEqual(fs.existsSync(convindex.embedLockPath(ctx)), false, 'no embed.lock written by search');
  } finally {
    if (savedNodeTest !== undefined) process.env.NODE_TEST_CONTEXT = savedNodeTest;
    fs.rmSync(convindex.embedLockPath(ctx), { force: true });
  }

  const hy = await convindex.search(ctx, 'database', {
    mode: 'hybrid',
    model: 'bge-m3',
    spawn: customSpawn,
    post: stubPost({ dim: 16 }),
  });
  assert.strictEqual(hy.ok, true);
  assert.strictEqual(hy.mode, 'lexical');
  assert.strictEqual(spawnCalls, 0, 'hybrid search() must never spawn a background worker');
});

test('foreground build({embed:true}) respects an active embed.lock held by another process and never clobbers its lock or vectors', async function () {
  // HIGH 1 + LOW 3: Mutual exclusion between concurrent index/embed writers.
  // If a background worker (or another process, e.g. process.ppid) holds embed.lock:
  // 1) A foreground build({embed:true}) (such as the scheduled 30-min tick) must NOT run a duplicate
  //    embedding pass, must NOT overwrite embed.lock with its own pid, and must NOT delete embed.lock on exit.
  // 2) Concurrent meta.json writes must preserve fresh `vec` progress written to disk by the active worker.
  const ctx = ctxFor();
  writeClaude(ctx, 'chat-1', [
    { type: 'user', timestamp: '2026-10-01T10:00:00Z', message: { role: 'user', content: 'First chat text.' } },
  ]);
  writeClaude(ctx, 'chat-2', [
    { type: 'user', timestamp: '2026-10-02T10:00:00Z', message: { role: 'user', content: 'Second chat text.' } },
  ]);
  await convindex.build(ctx, {});

  // Simulate an active background worker holding embed.lock under a live external PID (process.ppid).
  const holderPid = process.ppid && process.ppid !== process.pid ? process.ppid : process.pid;
  const spCalls = [];
  const fakeSpawn = function () {
    spCalls.push(1);
    return { pid: holderPid, unref: function () {} };
  };
  const bg1 = convindex.spawnBackgroundEmbed(ctx, { spawn: fakeSpawn, model: 'bge-m3' });
  assert.strictEqual(bg1.started, true, 'spawnBackgroundEmbed starts when injectable spawn is provided');
  assert.strictEqual(bg1.pid, holderPid);
  assert.strictEqual(spCalls.length, 1);

  // A second concurrent spawnBackgroundEmbed must see the lock and refuse to start a second worker.
  const bg2 = convindex.spawnBackgroundEmbed(ctx, { spawn: fakeSpawn, model: 'bge-m3' });
  assert.strictEqual(bg2.started, false);
  assert.strictEqual(bg2.alreadyRunning, true);
  assert.strictEqual(bg2.pid, holderPid);
  assert.strictEqual(spCalls.length, 1, 'must not spawn a second worker while lock is held');

  // Simulate the background worker having finished embedding chat-2 on disk while another build runs.
  const metaOnDisk = readManifest(ctx);
  const vecBuf = Buffer.alloc(16 * 4, 1);
  fs.mkdirSync(path.dirname(convindex.vectorPath(ctx, 'claude:local:chat-2')), { recursive: true });
  fs.writeFileSync(convindex.vectorPath(ctx, 'claude:local:chat-2'), vecBuf);
  metaOnDisk.sources['claude:local:chat-2'].vec = {
    space: bg1.space,
    dim: 16,
    count: 1,
    model: 'bge-m3',
    host: 'localhost:11434',
    remote: false,
  };
  fs.writeFileSync(convindex.metaPath(ctx), JSON.stringify(metaOnDisk, null, 2));

  // Now run a foreground build({embed:true}) from a different writer (simulate lock held by another live pid):
  // If holderPid === process.pid (rare), use pid 1 or ppid; on macOS/Linux process.ppid !== process.pid.
  assert.notStrictEqual(holderPid, process.pid, 'test requires a distinct live holderPid (process.ppid)');
  const embedCounter = { calls: 0 };
  const fgReport = await convindex.build(ctx, {
    embed: true,
    model: 'bge-m3',
    post: stubPost(embedCounter),
  });
  assert.strictEqual(
    embedCounter.calls,
    0,
    'foreground build must not duplicate embedding work while worker holds embed.lock',
  );
  assert.strictEqual(fgReport.embedded, 0);
  assert.strictEqual(fgReport.embedding.busy, true, 'report.embedding.busy indicates another embed writer is active');
  assert.strictEqual(fgReport.embedding.busyPid, holderPid);

  // Critical: embed.lock must STILL exist and belong to holderPid after foreground build exits!
  const stAfterFg = convindex.backgroundStatus(ctx);
  assert.strictEqual(stAfterFg.running, true, 'foreground build must not delete the background worker lock on exit');
  assert.strictEqual(stAfterFg.pid, holderPid);

  // Critical: chat-2's vector metadata must still be preserved in meta.json!
  const metaAfterFg = readManifest(ctx);
  assert.ok(metaAfterFg.sources['claude:local:chat-2'].vec, 'concurrent build must not clobber worker vec progress');
  assert.strictEqual(metaAfterFg.sources['claude:local:chat-2'].vec.dim, 16);

  // Clean up simulated lock
  fs.rmSync(convindex.embedLockPath(ctx), { force: true });
});

test('concurrent meta.json writers: a worker checkpoint merges newer and added rows from disk and discards vectors for rows modified mid-embed', async function () {
  // HIGH 1 + NEW MEDIUM 1: While a long-running embedding pass is in flight, a concurrent
  // lexical build (e.g. a 30-minute scheduled tick) can add new conversations and update existing
  // conversations in meta.json and on disk. When the embedding worker later checkpoints or finishes
  // its snapshotMeta() to meta.json:
  // 1) Newly added rows on disk must NOT disappear.
  // 2) Rows updated on disk with a newer mtimeMs/hash must NOT revert to the worker's stale hash/chunkHashes.
  // 3) If a source's chunk file/hash changed on disk while the worker was embedding it, the worker
  //    must NOT attach a vector computed against new chunks onto the old chunkHashes.
  const ctx = ctxFor();
  writeClaude(ctx, 'chat-a', [
    { type: 'user', timestamp: '2026-10-01T10:00:00Z', message: { role: 'user', content: 'Original chat A content.' } },
  ]);
  writeClaude(ctx, 'chat-b', [
    { type: 'user', timestamp: '2026-10-02T10:00:00Z', message: { role: 'user', content: 'Original chat B content.' } },
  ]);
  await convindex.build(ctx, {});

  let midBuildDone = false;
  const postWithConcurrentLexicalBuild = async function (url, body) {
    if (!midBuildDone) {
      midBuildDone = true;
      // Simulate a concurrent lexical tick running while the worker is mid-embedding:
      // 1) Modify chat-a with a new turn (newer mtime + new hash + new chunks on disk)
      const fileA = writeClaude(ctx, 'chat-a', [
        {
          type: 'user',
          timestamp: '2026-10-01T10:00:00Z',
          message: { role: 'user', content: 'Original chat A content.' },
        },
        {
          type: 'assistant',
          timestamp: '2026-10-03T10:00:00Z',
          message: { role: 'assistant', content: 'Appended answer during worker run.' },
        },
      ]);
      const future = new Date(Date.now() + 60000);
      fs.utimesSync(fileA, future, future);
      // 2) Add a brand-new conversation chat-c
      writeClaude(ctx, 'chat-c', [
        {
          type: 'user',
          timestamp: '2026-10-04T10:00:00Z',
          message: { role: 'user', content: 'Brand new chat C added by concurrent lexical build.' },
        },
      ]);
      // Run the concurrent lexical build (writes updated chat-a and new chat-c to meta.json)
      await convindex.build(ctx, { embed: false });
    }
    const inputs = (body && body.input) || [];
    return { embeddings: inputs.map(() => new Array(8).fill(0.25)) };
  };

  await convindex.build(ctx, {
    embed: true,
    model: 'bge-m3',
    post: postWithConcurrentLexicalBuild,
  });

  const finalMeta = readManifest(ctx);
  assert.ok(
    finalMeta.sources['claude:local:chat-c'],
    'newly added row chat-c from concurrent lexical build must survive worker writeMeta',
  );
  assert.strictEqual(
    finalMeta.sources['claude:local:chat-a'].counts.messages,
    2,
    'updated row chat-a from concurrent lexical build must keep its newer 2-message state, not revert to 1',
  );
  assert.strictEqual(
    finalMeta.sources['claude:local:chat-a'].chunks,
    1,
    'chat-a still has 1 chunk after the concurrent update',
  );
  const diskChunksA = convindex.readChunks(convindex.chunkPath(ctx, 'claude:local:chat-a'));
  assert.deepStrictEqual(
    finalMeta.sources['claude:local:chat-a'].chunkHashes,
    diskChunksA.map((c) => c.h),
    'chat-a chunkHashes in meta.json match the new chunk file on disk, not the worker start-time snapshot',
  );
  assert.strictEqual(
    finalMeta.sources['claude:local:chat-a'].vec,
    null,
    'chat-a changed on disk during the worker run so stale-snapshot vector must not be bound to mismatched chunkHashes',
  );
  assert.ok(
    finalMeta.sources['claude:local:chat-b'].vec && finalMeta.sources['claude:local:chat-b'].vec.dim === 8,
    'unchanged row chat-b keeps its newly computed vector',
  );
});

test('spawnBackgroundEmbed passes KEYFLIP_CONFIG_DIR, and the spawned worker takes over embed.lock under its own pid and releases it on exit', async function () {
  // LOW 9 + NEW LOW 2 + NEW LOW 3:
  // 1) spawnBackgroundEmbed must set KEYFLIP_CONFIG_DIR (which createContext reads) in the child env.
  // 2) When the spawned worker runs build({embed:true}) under its own pid (written to embed.lock by the parent),
  //    acquireEmbedLock recognizes its own pid, updates progress, embeds the sources, and releases embed.lock on exit.
  // 3) An expired/stale lock (whose heartbeat/updatedAt is past the stale window) is safely reclaimed without a remove race.
  const ctx = ctxFor();
  writeClaude(ctx, 'bg-worker-chat', [
    {
      type: 'user',
      timestamp: '2026-10-05T10:00:00Z',
      message: { role: 'user', content: 'Background worker takeover test.' },
    },
  ]);

  let capturedEnv = null;
  let capturedArgs = null;
  // Spawn stub returns process.pid to simulate the child process taking over the lock written for its PID.
  const fakeSpawn = function (_execPath, args, opts) {
    capturedArgs = args;
    capturedEnv = opts && opts.env;
    return { pid: process.pid, unref: function () {} };
  };

  // build({embed:true, background:true}) must write lexical index and invoke spawnBackgroundEmbed
  const bgBuild = await convindex.build(ctx, {
    embed: true,
    background: true,
    model: 'bge-m3',
    spawn: fakeSpawn,
  });
  assert.ok(
    bgBuild.backgroundEmbed && bgBuild.backgroundEmbed.started,
    'build({embed:true, background:true}) starts background worker',
  );
  assert.strictEqual(
    capturedEnv && capturedEnv.KEYFLIP_CONFIG_DIR,
    ctx.configDir,
    'child env must carry KEYFLIP_CONFIG_DIR',
  );
  assert.ok(Array.isArray(capturedArgs) && capturedArgs.indexOf('--foreground') !== -1);
  assert.strictEqual(fs.existsSync(convindex.embedLockPath(ctx)), true, 'embed.lock exists after spawnBackgroundEmbed');

  // Now the worker itself runs foreground build({embed:true}) with the same PID that embed.lock was reserved for:
  const workerReport = await convindex.build(ctx, {
    embed: true,
    model: 'bge-m3',
    post: stubPost({ dim: 8 }),
  });
  assert.strictEqual(workerReport.embedded, 1, 'worker took over its reserved embed.lock and embedded the source');
  assert.strictEqual(fs.existsSync(convindex.embedLockPath(ctx)), false, 'worker released embed.lock on completion');

  // Verify stale-lock reclamation when a live PID was reused after the lock expired (updatedAt older than staleMs):
  const holderPid = process.ppid && process.ppid !== process.pid ? process.ppid : process.pid;
  fs.writeFileSync(
    convindex.embedLockPath(ctx),
    JSON.stringify({
      pid: holderPid,
      token: 'stale-token',
      startedAt: '2020-01-01T00:00:00.000Z',
      updatedAt: Date.now() - 24 * 3600 * 1000,
      model: 'bge-m3',
      space: 'deadbeef',
    }) + '\n',
  );
  assert.strictEqual(
    convindex.backgroundStatus(ctx).running,
    false,
    'a lock whose heartbeat is hours old (PID reuse) is treated as stale, not running forever',
  );

  // And on POSIX, if a crashed worker PID was immediately reused by an unrelated non-node process (e.g. PID 1),
  // process identity verification detects PID reuse even when updatedAt is fresh:
  if (process.platform !== 'win32') {
    fs.writeFileSync(
      convindex.embedLockPath(ctx),
      JSON.stringify({
        pid: 1,
        token: 'reused-pid-token',
        startedAt: new Date().toISOString(),
        updatedAt: Date.now(),
        model: 'bge-m3',
        space: 'deadbeef',
      }) + '\n',
    );
    assert.strictEqual(
      convindex.backgroundStatus(ctx).running,
      false,
      'a lock whose PID now belongs to a non-node process (PID reuse) is reported as not running',
    );
    const reclaimBuild = await convindex.build(ctx, {
      embed: true,
      force: true,
      model: 'bge-m3',
      post: stubPost({ dim: 8 }),
    });
    assert.strictEqual(reclaimBuild.embedded, 1, 'writer reclaims a lock whose PID belongs to a non-node process');
  }
});

test('withMetaLock waits past 200ms contention and never writes unlocked when meta.lock is held', async function () {
  // Round 3 MEDIUM 1:
  // 1) A meta.lock held for ~350ms (representing a 100-300ms meta.json merge+write on a 2k-source index)
  //    must be waited out by a concurrent build instead of timing out at 200ms and writing unlocked.
  // 2) If meta.lock remains held by a live external process past the wait deadline, writeMeta must
  //    NOT fall through and clobber meta.json unlocked.
  const ctx = ctxFor();
  writeClaude(ctx, 'lock-chat-1', [
    { type: 'user', timestamp: '2026-10-01T10:00:00Z', message: { role: 'user', content: 'Lock test chat 1.' } },
  ]);
  await convindex.build(ctx, {});

  const metaLockFile = path.join(ctx.configDir, 'conv-index', 'meta.lock');
  const holderPid = process.ppid && process.ppid !== process.pid ? process.ppid : process.pid;

  // Case A: meta.lock is held by a live writer that finishes after 350ms (> 200ms) and writes a new row
  // just before releasing meta.lock. If the waiting build gave up at 200ms and wrote unlocked while
  // the holder was still mid-write, the holder or waiter would clobber each other without merging.
  fs.writeFileSync(metaLockFile, JSON.stringify({ pid: holderPid, at: Date.now(), token: 'holder-350ms' }) + '\n');
  // Spawn a helper process that sleeps 300ms, writes a new row "claude:local:holder-added" to meta.json,
  // and removes meta.lock:
  const chunkFileAdded = convindex.chunkPath(ctx, 'claude:local:holder-added');
  fs.mkdirSync(path.dirname(chunkFileAdded), { recursive: true });
  fs.writeFileSync(
    chunkFileAdded,
    JSON.stringify({ n: 0, role: 'user', text: 'Added by holder', h: 'h1', len: 3 }) + '\n',
  );

  const helperScript = [
    "const fs = require('fs');",
    'setTimeout(() => {',
    '  const metaFile = ' + JSON.stringify(convindex.metaPath(ctx)) + ';',
    '  const lockFile = ' + JSON.stringify(metaLockFile) + ';',
    "  const m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));",
    "  m.sources['claude:local:holder-added'] = {",
    "    id: 'claude:local:holder-added', app: 'claude', chunks: 1, bytes: 15,",
    "    counts: { messages: 1 }, mtimeMs: Date.now() + 50000, hash: 'holderhash', chunkBytes: 64",
    '  };',
    '  fs.writeFileSync(metaFile, JSON.stringify(m, null, 2));',
    '  fs.rmSync(lockFile, { force: true });',
    '}, 300);',
  ].join('\n');
  const childProcess = await import('child_process');
  const helper = childProcess.spawn(process.execPath, ['-e', helperScript], { stdio: 'ignore' });
  // Update meta.lock PID to the live helper PID
  fs.writeFileSync(metaLockFile, JSON.stringify({ pid: helper.pid, at: Date.now(), token: 'holder-300ms' }) + '\n');

  writeClaude(ctx, 'lock-chat-2', [
    { type: 'user', timestamp: '2026-10-02T10:00:00Z', message: { role: 'user', content: 'Lock test chat 2.' } },
  ]);
  await convindex.build(ctx, {});
  await new Promise((resolve) => helper.on('exit', resolve));

  const mergedMeta = readManifest(ctx);
  assert.ok(
    mergedMeta.sources['claude:local:holder-added'],
    'build must wait past 300ms for meta.lock holder to finish and merge its row, not write unlocked at 200ms',
  );
  assert.ok(mergedMeta.sources['claude:local:lock-chat-2'], 'waiter row is also written');

  // Case B: If meta.lock is held past the wait deadline by a live external process, writeMeta must NEVER write unlocked.
  const sentinelMeta = readManifest(ctx);
  sentinelMeta.sentinelProtectedByLock = true;
  fs.writeFileSync(convindex.metaPath(ctx), JSON.stringify(sentinelMeta, null, 2));
  fs.writeFileSync(
    metaLockFile,
    JSON.stringify({ pid: holderPid, at: Date.now(), token: 'held-past-deadline' }) + '\n',
  );
  try {
    writeClaude(ctx, 'lock-chat-3', [
      {
        type: 'user',
        timestamp: '2026-10-03T10:00:00Z',
        message: { role: 'user', content: 'Should not write unlocked.' },
      },
    ]);
    await convindex.build(ctx, { metaLockTimeoutMs: 50 });
    const afterContended = readManifest(ctx);
    assert.strictEqual(
      afterContended.sentinelProtectedByLock,
      true,
      'meta.json must NEVER be overwritten unlocked when meta.lock cannot be acquired',
    );
  } finally {
    fs.rmSync(metaLockFile, { force: true });
  }
});

test('worker checkpoint does not resurrect a source deleted by a concurrent full lexical build, and status() is purely read-only', async function () {
  // Round 3 LOW 2 + LOW 4:
  // 1) If a concurrent full lexical build deletes a conversation while an embedding worker is running,
  //    the worker checkpoint / final writeMeta must NOT resurrect the deleted source row in meta.json.
  // 2) status() / backgroundStatus() must be strictly read-only: never create meta.lock, never delete
  //    embed.lock on disk, and never spawn a child process (such as ps).
  const ctx = ctxFor();
  const fileDel = writeClaude(ctx, 'to-be-deleted', [
    {
      type: 'user',
      timestamp: '2026-10-01T10:00:00Z',
      message: { role: 'user', content: 'Conversation that will be deleted.' },
    },
  ]);
  writeClaude(ctx, 'stays-alive', [
    { type: 'user', timestamp: '2026-10-02T10:00:00Z', message: { role: 'user', content: 'Conversation that stays.' } },
  ]);
  await convindex.build(ctx, {});

  let deletedDuringEmbed = false;
  const postWithConcurrentDelete = async function (_url, body) {
    if (!deletedDuringEmbed) {
      deletedDuringEmbed = true;
      // Delete the transcript file and run a concurrent full lexical build
      fs.rmSync(fileDel, { force: true });
      const delBuild = await convindex.build(ctx, { embed: false });
      assert.strictEqual(delBuild.removed, 1);
      assert.strictEqual(readManifest(ctx).sources['claude:local:to-be-deleted'], undefined);
    }
    const inputs = (body && body.input) || [];
    return { embeddings: inputs.map(() => new Array(8).fill(0.5)) };
  };

  await convindex.build(ctx, {
    embed: true,
    model: 'bge-m3',
    post: postWithConcurrentDelete,
  });

  const afterEmbed = readManifest(ctx);
  assert.strictEqual(
    afterEmbed.sources['claude:local:to-be-deleted'],
    undefined,
    'worker writeMeta must not resurrect a source whose transcript and chunk file were removed by a concurrent lexical build',
  );
  assert.strictEqual(afterEmbed.stats.sources, 1, 'stats.sources must reflect only the surviving conversation');

  // Verify status() and backgroundStatus() are strictly read-only even when a stale embed.lock exists on disk:
  const staleLockFile = convindex.embedLockPath(ctx);
  fs.writeFileSync(
    staleLockFile,
    JSON.stringify({
      pid: 999999,
      token: 'stale-ro-token',
      startedAt: '2020-01-01T00:00:00.000Z',
      updatedAt: Date.now() - 24 * 3600 * 1000,
      model: 'bge-m3',
      space: 'deadbeef',
    }) + '\n',
  );
  const childProcess = await import('child_process');
  const origSpawnSync = childProcess.default.spawnSync;
  let spawnSyncCalls = 0;
  childProcess.default.spawnSync = function () {
    spawnSyncCalls++;
    return origSpawnSync.apply(this, arguments);
  };
  try {
    const st = convindex.status(ctx);
    assert.strictEqual(st.backgroundEmbed, null, 'status() reports stale embed.lock as not running');
    assert.strictEqual(
      fs.existsSync(staleLockFile),
      true,
      'read-only status() must NOT unlink embed.lock on disk (cleanup belongs to writers)',
    );
    assert.strictEqual(
      fs.existsSync(path.join(ctx.configDir, 'conv-index', 'meta.lock')),
      false,
      'read-only status() must NOT create meta.lock',
    );
    assert.strictEqual(spawnSyncCalls, 0, 'read-only status() must NOT spawn a child process (ps)');
  } finally {
    childProcess.default.spawnSync = origSpawnSync;
    fs.rmSync(staleLockFile, { force: true });
  }
});

test('when meta.lock cannot be acquired, build() returns ok:false with an explicit error and does not mutate chunk/token/vector files on disk', async function () {
  // Round 4 MEDIUM 1:
  // If meta.lock is held past the wait deadline:
  // 1) build() must report ok: false with an explicit meta.lock error in report.errors.
  // 2) Destructive chunk/token/vector writes and deletions must NOT have happened before meta.lock
  //    was acquired, so existing chunk/vector files on disk never drift apart from meta.json.
  const ctx = ctxFor();
  const file1 = writeClaude(ctx, 'drift-chat-1', [
    {
      type: 'user',
      timestamp: '2026-10-01T10:00:00Z',
      message: { role: 'user', content: 'Original text before lock contention.' },
    },
  ]);
  const file2 = writeClaude(ctx, 'drift-chat-2', [
    {
      type: 'user',
      timestamp: '2026-10-02T10:00:00Z',
      message: { role: 'user', content: 'Second chat that will be deleted while lock is held.' },
    },
  ]);
  await convindex.build(ctx, { embed: true, model: 'bge-m3', post: stubPost({ dim: 8 }) });

  const id1 = 'claude:local:drift-chat-1';
  const id2 = 'claude:local:drift-chat-2';
  const origChunk1 = fs.readFileSync(convindex.chunkPath(ctx, id1), 'utf8');
  const origChunk2 = fs.readFileSync(convindex.chunkPath(ctx, id2), 'utf8');

  // Modify chat-1 and delete chat-2 while meta.lock is held by an external process:
  writeClaude(ctx, 'drift-chat-1', [
    {
      type: 'user',
      timestamp: '2026-10-01T10:00:00Z',
      message: { role: 'user', content: 'MODIFIED text during lock contention.' },
    },
  ]);
  const future = new Date(Date.now() + 60000);
  fs.utimesSync(file1, future, future);
  fs.rmSync(file2, { force: true });

  const metaLockFile = path.join(ctx.configDir, 'conv-index', 'meta.lock');
  const holderPid = process.ppid && process.ppid !== process.pid ? process.ppid : process.pid;
  fs.writeFileSync(
    metaLockFile,
    JSON.stringify({ pid: holderPid, at: Date.now(), token: 'held-during-destructive-ops' }) + '\n',
  );
  try {
    const failedReport = await convindex.build(ctx, { metaLockTimeoutMs: 50 });
    assert.strictEqual(failedReport.ok, false, 'build() must return ok:false when meta.lock cannot be acquired');
    assert.ok(
      failedReport.errors.some((e) => String(e && (e.error || e)).includes('meta.lock')),
      'report.errors must explain that meta.json write failed due to meta.lock contention',
    );
    assert.strictEqual(
      fs.readFileSync(convindex.chunkPath(ctx, id1), 'utf8'),
      origChunk1,
      'chat-1 chunk file on disk must NOT be overwritten when meta.lock was not acquired',
    );
    assert.strictEqual(
      fs.existsSync(convindex.chunkPath(ctx, id2)),
      true,
      'chat-2 chunk file on disk must NOT be deleted when meta.lock was not acquired',
    );
    assert.strictEqual(fs.readFileSync(convindex.chunkPath(ctx, id2), 'utf8'), origChunk2);
  } finally {
    fs.rmSync(metaLockFile, { force: true });
  }
});

test('full build removes stale old-id rows when a transcript re-parses under a new id even though its file still exists on disk', async function () {
  // Round 4 MEDIUM 2:
  // When a source file still exists on disk, but re-parsing assigns it a different id (e.g. an ID_SCHEME
  // bump, Codex session_id -> id migration, or collision handling), the old id is no longer produced by
  // the scan and its path is now owned by the new id. A full build must remove the old id row and its
  // orphaned chunk/vector/token files instead of keeping both rows forever because fs.existsSync(s.path) is true.
  const ctx = ctxFor();
  const file = writeClaude(ctx, 'renamed-id-chat', [
    {
      type: 'user',
      timestamp: '2026-10-01T10:00:00Z',
      message: { role: 'user', content: 'Chat that used to have an older id.' },
    },
  ]);
  await convindex.build(ctx, { embed: true, model: 'bge-m3', post: stubPost({ dim: 8 }) });

  const newId = 'claude:local:renamed-id-chat';
  const oldId = 'claude:local:legacy-scheme-id';
  const meta = readManifest(ctx);
  const currentEntry = meta.sources[newId];
  assert.ok(currentEntry);

  // Simulate an index built under an older ID_SCHEME where this exact transcript path was stored under oldId:
  delete meta.sources[newId];
  meta.sources[oldId] = Object.assign({}, currentEntry, {
    id: oldId,
    scheme: 1,
  });
  fs.writeFileSync(convindex.chunkPath(ctx, oldId), fs.readFileSync(convindex.chunkPath(ctx, newId)));
  fs.rmSync(convindex.chunkPath(ctx, newId), { force: true });
  fs.writeFileSync(convindex.metaPath(ctx), JSON.stringify(meta, null, 2));

  // Now run a full build: the transcript file still exists at s.path, and re-parses as newId.
  const r = await convindex.build(ctx, {});
  assert.strictEqual(r.ok, true);
  const after = readManifest(ctx);
  assert.ok(after.sources[newId], 'the new id is indexed');
  assert.strictEqual(
    after.sources[oldId],
    undefined,
    'the superseded old id row must be removed even though its transcript file still exists on disk',
  );
  assert.strictEqual(
    fs.existsSync(convindex.chunkPath(ctx, oldId)),
    false,
    'the superseded old id chunk file must be cleaned up',
  );
  assert.strictEqual(after.stats.sources, 1, 'stats.sources must count the conversation once, not twice');
});

test('withMetaLock never steals a meta.lock held by a live process even when its initial timestamp is older than 30s, and stages chunk/token files to temp paths before acquiring meta.lock', async function () {
  // Round 5 MEDIUM 1:
  // 1) A meta.lock held by a LIVE process whose initial timestamp is > 30s old must NOT be reclaimed
  //    as stale while its holder PID is still alive (only dead PIDs or a PID-reuse age > 2h may be reclaimed).
  // 2) New chunk and token files must be staged to temporary paths before taking meta.lock so the
  //    critical section inside meta.lock only performs fast renames/deletes + meta.json merge.
  const ctx = ctxFor();
  writeClaude(ctx, 'live-lock-chat', [
    {
      type: 'user',
      timestamp: '2026-10-01T10:00:00Z',
      message: { role: 'user', content: 'Initial chat before live lock test.' },
    },
  ]);
  await convindex.build(ctx, {});

  const sentinelMeta = readManifest(ctx);
  sentinelMeta.heldByLiveBuilderOver30s = true;
  fs.writeFileSync(convindex.metaPath(ctx), JSON.stringify(sentinelMeta, null, 2));

  // Simulate a live builder (holderPid) whose meta.lock was acquired 45 seconds ago (> 30s META_LOCK_STALE_MS):
  const metaLockFile = path.join(ctx.configDir, 'conv-index', 'meta.lock');
  const holderPid = process.ppid && process.ppid !== process.pid ? process.ppid : process.pid;
  const lockPayload =
    JSON.stringify({
      pid: holderPid,
      at: Date.now() - 45 * 1000,
      updatedAt: Date.now() - 45 * 1000,
      token: 'live-holder-45s',
    }) + '\n';
  fs.writeFileSync(metaLockFile, lockPayload);

  try {
    writeClaude(ctx, 'live-lock-chat-2', [
      {
        type: 'user',
        timestamp: '2026-10-02T10:00:00Z',
        message: { role: 'user', content: 'Second chat while 45s live lock is held.' },
      },
    ]);
    const r = await convindex.build(ctx, { metaLockTimeoutMs: 60 });
    assert.strictEqual(
      r.ok,
      false,
      'build must NOT steal a meta.lock held by a live process just because it is 45s old (> 30s)',
    );
    assert.strictEqual(
      fs.readFileSync(metaLockFile, 'utf8'),
      lockPayload,
      'the live holder meta.lock file must remain untouched',
    );
    assert.strictEqual(
      readManifest(ctx).heldByLiveBuilderOver30s,
      true,
      'meta.json must not be overwritten while the live holder still owns meta.lock',
    );
    // And any temporary staged files created before meta.lock acquisition must be cleaned up on abort:
    const chunkFiles = fs.readdirSync(path.join(ctx.configDir, 'conv-index', 'chunks'));
    assert.strictEqual(
      chunkFiles.some((f) => f.includes('.tmp-') || f.includes('.stage-')),
      false,
      'no leftover staged temp chunk files after failed meta.lock acquisition',
    );
  } finally {
    fs.rmSync(metaLockFile, { force: true });
  }
});

test('a source that shrinks to zero messages removes its row and deletes its orphaned chunk, vector, and token files', async function () {
  // Round 5 LOW 2:
  // When a previously indexed conversation is truncated/emptied so it parses to 0 messages,
  // the empty-source branch in build() must also queue its id in pendingDeletes so its chunk,
  // vector, and token files are removed from disk instead of leaking as orphans.
  const ctx = ctxFor();
  const file = writeClaude(ctx, 'emptied-chat', [
    {
      type: 'user',
      timestamp: '2026-10-01T10:00:00Z',
      message: { role: 'user', content: 'Conversation that will become empty.' },
    },
  ]);
  await convindex.build(ctx, { embed: true, model: 'bge-m3', post: stubPost({ dim: 8 }) });

  const id = 'claude:local:emptied-chat';
  assert.strictEqual(fs.existsSync(convindex.chunkPath(ctx, id)), true);
  assert.strictEqual(fs.existsSync(convindex.vectorPath(ctx, id)), true);
  assert.strictEqual(fs.existsSync(convindex.tokenPath(ctx, id)), true);

  // Overwrite the transcript file so it still exists on disk but has 0 user/assistant messages:
  fs.writeFileSync(file, JSON.stringify({ type: 'summary', summary: 'no messages' }) + '\n');
  const future = new Date(Date.now() + 60000);
  fs.utimesSync(file, future, future);

  const r = await convindex.build(ctx, {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.empty, 1);
  assert.strictEqual(r.removed, 1);
  assert.strictEqual(readManifest(ctx).sources[id], undefined, 'row is removed from meta.json');
  assert.strictEqual(
    fs.existsSync(convindex.chunkPath(ctx, id)),
    false,
    'orphaned chunk file for emptied source must be deleted',
  );
  assert.strictEqual(
    fs.existsSync(convindex.vectorPath(ctx, id)),
    false,
    'orphaned vector file for emptied source must be deleted',
  );
  assert.strictEqual(
    fs.existsSync(convindex.tokenPath(ctx, id)),
    false,
    'orphaned token file for emptied source must be deleted',
  );
});

test('when an emptied source had a colliding id that another source claims in the same build, pendingDeletes does not delete the newly written chunk/token files', async function () {
  // Round 6 LOW 1:
  // Two transcripts share a canonical id (e.g. two Codex rollouts with the same session_meta id).
  // Codex discovery orders newer filenames first, so file2 is scanned first and owns canonicalId
  // ("codex:" + SHARED) while file1 gets the collision alt id.
  // When file2 shrinks to 0 messages, it hits the empty-source branch and queues prev.id (canonicalId)
  // in pendingDeletes; in the same scan, file1 is modified (no longer matching the fast stat shortcut)
  // so it re-parses and claims canonicalId. At commit time, pendingDeletes must be filtered against
  // next/claimed so it does NOT delete the chunk and token files just written for file1.
  const ctx = ctxFor();
  const dir = path.join(ctx.home, '.codex', 'sessions', '2026', '01', '01');
  fs.mkdirSync(dir, { recursive: true });
  const SHARED = '77777777-7777-4777-8777-777777777777';
  const metaLine = { type: 'session_meta', payload: { id: SHARED, session_id: SHARED, cwd: '/work/codex' } };
  const turnLine = (text) => ({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: text }] },
  });
  const file1 = path.join(dir, 'rollout-2026-01-01T10-00-00-' + SHARED + '.jsonl');
  const file2 = path.join(dir, 'rollout-2026-01-02T10-00-00-' + SHARED + '.jsonl');
  fs.writeFileSync(file1, [metaLine, turnLine('First rollout text.')].map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(file2, [metaLine, turnLine('Second rollout text.')].map((l) => JSON.stringify(l)).join('\n') + '\n');

  await convindex.build(ctx, {});
  const canonicalId = 'codex:' + SHARED;
  assert.strictEqual(readManifest(ctx).sources[canonicalId].path, file2, 'file2 initially owns canonicalId');

  // Now file2 shrinks to 0 messages, and file1 grows by a turn so it re-parses and claims canonicalId:
  fs.writeFileSync(file2, JSON.stringify(metaLine) + '\n');
  fs.writeFileSync(
    file1,
    [metaLine, turnLine('First rollout text.'), turnLine('Appended turn so file1 re-parses and claims canonicalId.')]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
  );
  const future = new Date(Date.now() + 60000);
  fs.utimesSync(file1, future, future);
  fs.utimesSync(file2, future, future);

  const r = await convindex.build(ctx, {});
  assert.strictEqual(r.ok, true);
  const after = readManifest(ctx);
  assert.ok(after.sources[canonicalId], 'canonicalId row is now owned by file1');
  assert.strictEqual(after.sources[canonicalId].path, file1);
  assert.strictEqual(
    fs.existsSync(convindex.chunkPath(ctx, canonicalId)),
    true,
    "chunk file for canonicalId must NOT be deleted by file2's empty-source pendingDeletes",
  );
  assert.strictEqual(
    fs.existsSync(convindex.tokenPath(ctx, canonicalId)),
    true,
    "token sidecar for canonicalId must NOT be deleted by file2's empty-source pendingDeletes",
  );
  assert.strictEqual(chunkLineCount(ctx, canonicalId), after.sources[canonicalId].chunks);
});
