// BM25 lexical ranking shared by `recall` (distilled keepsakes) and the conversation
// index. One implementation keeps stemming/scoring identical everywhere, so a query
// that works on memories behaves the same on raw chat chunks.
//
// Zero-dependency and clock-free. Callers supply tokenized documents:
//   scores([{ id, toks: [...] }], 'query words') -> [{ id, score }]  (score > 0 only)
const K1 = 1.5;
const B = 0.75;

const STOP = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'is',
  'it',
  'for',
  'on',
  'with',
  'this',
  'that',
  'as',
  'at',
  'by',
  'be',
  'i',
]);

// A light stemmer so "retries"/"retry", "limiting"/"limit", "backoffs"/"backoff"
// converge. Query and documents run this identically — convergence, not linguistic
// accuracy, is what matters. Zero-dep.
function stem(w) {
  if (w.length > 4 && w.slice(-3) === 'ies') return w.slice(0, -3) + 'y'; // "queries"->"query"
  if (w.length > 5 && w.slice(-3) === 'ing')
    w = w.slice(0, -3); // "limiting"->"limit"
  else if (w.length > 4 && w.slice(-2) === 'ed')
    w = w.slice(0, -2); // "limited"->"limit"
  else if (w.length > 3 && w.slice(-2) === 'es')
    w = w.slice(0, -2); // "caches"->"cach", "boxes"->"box"
  else if (w.length > 3 && w.slice(-1) === 's' && w.slice(-2) !== 'ss') w = w.slice(0, -1); // "tokens"->"token"
  // Normalize a trailing silent 'e' so a singular ("cache") and a de-pluralized stem
  // ("caches"->"cach") land on the SAME token.
  if (w.length > 3 && w.slice(-1) === 'e') w = w.slice(0, -1);
  return w;
}

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && t.length > 1 && !STOP.has(t))
    .map(stem);
}

// BM25 over pre-tokenized documents. Returns [{ id, score }] sorted best-first,
// with zero-score documents omitted.
function scores(docs, query) {
  const qterms = tokenize(query);
  if (!qterms.length || !docs.length) return [];
  const N = docs.length;
  let total = 0;
  docs.forEach((d) => {
    total += d.toks.length;
  });
  const avgdl = total / N;
  if (!avgdl) return [];

  const df = Object.create(null);
  docs.forEach((d) => {
    const seen = Object.create(null);
    d.toks.forEach((t) => {
      if (!seen[t]) {
        seen[t] = 1;
        df[t] = (df[t] || 0) + 1;
      }
    });
  });

  const out = [];
  docs.forEach((d) => {
    const tf = Object.create(null);
    d.toks.forEach((t) => {
      tf[t] = (tf[t] || 0) + 1;
    });
    const dl = d.toks.length;
    let score = 0;
    qterms.forEach((q) => {
      const n = df[q] || 0;
      if (!n) return;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const f = tf[q] || 0;
      if (!f) return;
      score += (idf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * dl) / avgdl));
    });
    if (score > 0) out.push({ id: d.id, score: score });
  });
  out.sort((a, b) => b.score - a.score);
  return out;
}

export { K1, B, STOP, stem, tokenize, scores };
