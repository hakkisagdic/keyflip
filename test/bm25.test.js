// One BM25 implementation shared by recall and the conversation index. The stemmer only has
// to be CONSISTENT between query and document, not linguistically perfect.
import test from 'node:test';
import assert from 'node:assert';
import * as bm25 from '../src/bm25.js';

test('tokenize lowercases, drops stop words and one-letter tokens, and stems', function () {
  assert.deepStrictEqual(bm25.tokenize('The QUERIES and retries for caches'), ['query', 'retry', 'cach']);
  assert.deepStrictEqual(bm25.tokenize('limiting the backoffs'), ['limit', 'backoff']);
  assert.deepStrictEqual(bm25.tokenize('a b i'), []);
  assert.deepStrictEqual(bm25.tokenize(''), []);
  // Singular and plural meet at the same token (that is the whole point of the stemmer).
  assert.strictEqual(bm25.tokenize('cache')[0], bm25.tokenize('caches')[0]);
});

test('scores ranks the document that actually contains the terms, best first', function () {
  const docs = [
    { id: 'a', toks: bm25.tokenize('database migration dry run first') },
    { id: 'b', toks: bm25.tokenize('write a haiku about autumn') },
    { id: 'c', toks: bm25.tokenize('run the migration and verify the migration') },
  ];
  const out = bm25.scores(docs, 'migration');
  assert.deepStrictEqual(
    out.map((h) => h.id),
    ['c', 'a'],
  );
  assert.ok(out[0].score > out[1].score);
  // Zero-score documents are omitted, not returned with 0.
  assert.ok(!out.some((h) => h.id === 'b'));
});

test('a query made only of stop words, or an empty corpus, scores nothing', function () {
  const docs = [{ id: 'a', toks: bm25.tokenize('the migration') }];
  assert.deepStrictEqual(bm25.scores(docs, 'the and of'), []);
  assert.deepStrictEqual(bm25.scores([], 'migration'), []);
  assert.deepStrictEqual(bm25.scores([{ id: 'empty', toks: [] }], 'migration'), []);
});

test('a rarer term outranks a ubiquitous one (IDF is real)', function () {
  const docs = [];
  for (let i = 0; i < 20; i++) docs.push({ id: 'common-' + i, toks: bm25.tokenize('common token') });
  docs.push({ id: 'rare', toks: bm25.tokenize('common needle') });
  const out = bm25.scores(docs, 'common needle');
  assert.strictEqual(out[0].id, 'rare');
});
