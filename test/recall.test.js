'use strict';
// Tests for I1: local BM25 recall over distilled keepsakes (src/recall.js).
const test = require('node:test');
const assert = require('node:assert');
const recall = require('../src/recall');
const memory = require('../src/memory');
const { makeCtx } = require('./helpers');

test('tokenize lowercases, splits, drops stopwords + 1-char tokens', function () {
  assert.deepStrictEqual(recall.tokenize('The OAuth Token-Refresh bug!'), ['oauth', 'token', 'refresh', 'bug']);
});

test('search ranks the keepsake that actually discusses the topic first', function () {
  const ctx = makeCtx();
  memory.save(ctx, 'sess-a', '# Goal\n- fix the OAuth token refresh and retry backoff\n', { session: 'sess-a', cwd: '/proj/api' });
  memory.save(ctx, 'sess-b', '# Goal\n- redesign the CSS grid layout for the dashboard\n', { session: 'sess-b', cwd: '/proj/web' });
  memory.save(ctx, 'sess-c', '# Goal\n- add unit tests for the parser\n', { session: 'sess-c' });

  const hits = recall.search(ctx, 'oauth token refresh', { limit: 5 });
  assert.ok(hits.length >= 1);
  assert.strictEqual(hits[0].session, 'sess-a', 'the OAuth keepsake ranks first');
  assert.ok(hits[0].snippet.toLowerCase().indexOf('oauth') !== -1, 'snippet shows the match');
  assert.strictEqual(hits[0].cwd, '/proj/api', 'cwd pulled from frontmatter');
  // the unrelated CSS keepsake should not outrank it (and likely not match at all)
  assert.ok(!hits.some(function (h) { return h.session === 'sess-b' && h.score >= hits[0].score; }));
});

test('search returns [] when nothing matches or the corpus is empty', function () {
  const ctx = makeCtx();
  assert.deepStrictEqual(recall.search(ctx, 'anything', {}), []);
  memory.save(ctx, 's', 'about widgets', {});
  assert.deepStrictEqual(recall.search(ctx, 'nonexistentterm', {}), []);
});

test('answer feeds the top keepsakes to claude -p and returns a cited synthesis', function () {
  const ctx = makeCtx();
  memory.save(ctx, 'aaaa1111', '# Goal\n- fix OAuth token refresh with backoff\n', { session: 'aaaa1111', cwd: '/api' });
  memory.save(ctx, 'bbbb2222', '# Goal\n- CSS grid dashboard\n', { session: 'bbbb2222' });
  let seen = null;
  const runner = function (cmd, args, input) {
    if (args && args[0] === '--version') return { code: 0, stdout: 'claude 1' };
    seen = { args: args, input: input };
    return { code: 0, stdout: 'You handled it with backoff [aaaa1111].' };
  };
  const a = recall.answer(ctx, 'how did I fix the oauth refresh', { run: runner, limit: 6 });
  assert.strictEqual(a.ok, true);
  assert.ok(a.text.indexOf('[aaaa1111]') !== -1, 'cited answer');
  assert.strictEqual(a.hits[0].session, 'aaaa1111', 'the relevant keepsake was retrieved');
  assert.ok(seen.args[0] === '-p' && /QUESTION:/.test(seen.args[1]), 'question is in the instruction');
  assert.ok(seen.input.indexOf('OAuth token refresh') !== -1, 'the keepsake text is the stdin context');
});

test('answer reports no-matches / claude-not-installed cleanly', function () {
  const ctx = makeCtx();
  const runner = function () { return { code: 0, stdout: 'claude 1' }; };
  assert.strictEqual(recall.answer(ctx, 'x', { run: runner }).reason, 'no-matches');
  memory.save(ctx, 's', 'about oauth tokens', {});
  const absent = function () { return { code: 127 }; };
  assert.strictEqual(recall.answer(ctx, 'oauth', { run: absent }).reason, 'claude-not-installed');
});

test('rank is a pure BM25 over supplied docs (idf favors the rarer term)', function () {
  const docs = [
    { key: '1', session: '1', text: 'common common common rare', toks: recall.tokenize('common common common rare') },
    { key: '2', session: '2', text: 'common common common common', toks: recall.tokenize('common common common common') },
  ];
  const hits = recall.rank(docs, 'rare', 5);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].key, '1'); // only doc 1 has the rare term
});

// ---- I2: semantic search via the embedding seam (mock endpoint) ----

test('embed.cosine ranks the nearest vector; parses Ollama/OpenAI shapes', function () {
  const embed = require('../src/embed');
  assert.ok(embed.cosine([1, 0], [1, 0]) > embed.cosine([1, 0], [0, 1]));
  assert.strictEqual(embed.cosine([0, 0], [1, 1]), 0);
});

test('semanticSearch embeds query+keepsakes, cosine-ranks, caches vectors', async function () {
  const ctx = makeCtx();
  memory.save(ctx, 'aaaa1111', 'about oauth token refresh and retries', { session: 'aaaa1111' });
  memory.save(ctx, 'bbbb2222', 'about css grid dashboards', { session: 'bbbb2222' });
  // Fake embed endpoint: map any text to a 2-vector by keyword presence.
  let calls = 0;
  const post = function (url, body) {
    calls++;
    const vecs = body.input.map(function (t) { return [/oauth|token|retr/.test(t) ? 1 : 0, /css|grid|dashboard/.test(t) ? 1 : 0]; });
    return Promise.resolve({ embeddings: vecs });
  };
  const r1 = await require('../src/recall').semanticSearch(ctx, 'how did i handle token refresh', { post: post });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.hits[0].session, 'aaaa1111', 'the oauth keepsake ranks first semantically');
  const firstCalls = calls;
  // Second query: keepsake vectors are cached, so only the query is embedded (1 call, not re-embedding docs).
  const r2 = await require('../src/recall').semanticSearch(ctx, 'css dashboard layout', { post: post });
  assert.strictEqual(r2.hits[0].session, 'bbbb2222');
  assert.strictEqual(calls - firstCalls, 1, 'keepsake embeddings were cached (only the query re-embedded)');
});

test('semanticSearch reports a clean reason when the endpoint is unreachable', async function () {
  const ctx = makeCtx();
  memory.save(ctx, 's', 'about widgets', {});
  const post = function () { return Promise.reject(new Error('ECONNREFUSED')); };
  const r = await require('../src/recall').semanticSearch(ctx, 'widgets', { post: post });
  assert.strictEqual(r.ok, false);
  assert.ok(/ECONNREFUSED/.test(r.reason));
});
