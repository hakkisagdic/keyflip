// I1: local, zero-dep semantic-ish recall over keyflip's distilled KEEPSAKES (and optionally
// raw transcripts) using BM25 lexical ranking. Offline, private, no embeddings, no cost — the
// honest baseline of epic I. The corpus is the distilled keepsakes, which are small and
// high-signal, so plain BM25 already answers "where did I discuss X" well. (Optional embedding
// + `claude -p` answer layers come later as I2/I3.)
import fs from 'fs';
import path from 'path';
import * as memory from './memory.js';
import * as _llm from './llm.js';
import * as _embed from './embed.js';
import _crypto from 'crypto';
import { tokenize, scores as bm25Scores } from './bm25.js';

// Build the keepsake corpus (each doc = one keepsake). Returns [{ key, session, cwd, text, toks }].
function corpus(ctx) {
  return memory
    .list(ctx)
    .map(function (m) {
      const text = memory.read(ctx, m.key) || '';
      // pull session/cwd out of the frontmatter if present
      const sm = /(^|\n)session:\s*([^\n]+)/.exec(text);
      const cm = /(^|\n)cwd:\s*([^\n]+)/.exec(text);
      return {
        key: m.key,
        session: sm ? sm[2].trim() : m.key,
        cwd: cm ? cm[2].trim() : null,
        text: text,
        toks: tokenize(text),
      };
    })
    .filter(function (d) {
      return d.toks.length;
    });
}

// A short context snippet around the first query-term hit (whitespace-collapsed).
function snippet(text, terms) {
  const low = text.toLowerCase();
  let at = -1;
  for (let i = 0; i < terms.length; i++) {
    const p = low.indexOf(terms[i]);
    if (p !== -1 && (at === -1 || p < at)) at = p;
  }
  if (at === -1) at = 0;
  const start = Math.max(0, at - 50),
    end = Math.min(text.length, at + 110);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

// BM25 rank the docs against `query`. Returns [{ key, session, cwd, score, snippet }], best first.
function rank(docs, query, limit) {
  const qterms = tokenize(query);
  if (!qterms.length || !docs.length) return [];
  const byKey = Object.create(null);
  docs.forEach(function (d) {
    byKey[d.key] = d;
  });
  return bm25Scores(
    docs.map(function (d) {
      return { id: d.key, toks: d.toks };
    }),
    query,
  )
    .slice(0, limit || 10)
    .map(function (r) {
      const d = byKey[r.id];
      return { key: d.key, session: d.session, cwd: d.cwd, score: r.score, snippet: snippet(d.text, qterms) };
    });
}

// Search the keepsakes for `query`.
function search(ctx, query, opts) {
  opts = opts || {};
  return rank(corpus(ctx), query, opts.limit || 10);
}

// I3: RAG answer — retrieve the top keepsakes, then have the configured provider synthesize a CITED
// answer over ONLY them. Provider = `keyflip llm` (default `claude -p`, which spends the active
// account's quota; ollama/openai do not). Returns { ok, text, hits, provider } or
// { ok:false, reason, fix, hits }. Runner/poster injectable for tests.
async function answer(ctx, query, opts) {
  opts = opts || {};
  const llm = _llm;
  if (!opts.skipCheck) {
    const a = llm.availability(ctx, opts);
    if (!a.ok) return { ok: false, reason: a.reason, fix: a.fix, hits: [] };
    if (a.provider.provider === 'claude' && !llm.available(ctx, { run: opts.run }))
      return { ok: false, reason: 'claude-not-installed', hits: [] };
  }
  const docs = corpus(ctx);
  const hits = rank(docs, query, opts.limit || 6);
  if (!hits.length) return { ok: false, reason: 'no-matches', hits: [] };
  const byKey = Object.create(null);
  docs.forEach(function (d) {
    byKey[d.key] = d;
  });
  const context = hits
    .map(function (h, i) {
      const d = byKey[h.key];
      return (
        '### Source ' +
        (i + 1) +
        ' — session ' +
        h.session +
        (h.cwd ? ' (' + h.cwd + ')' : '') +
        '\n' +
        (d ? d.text : h.snippet)
      );
    })
    .join('\n\n');
  const instruction =
    'Answer the QUESTION using ONLY the SOURCES that follow on stdin (each is a distilled memory of a past coding chat). Cite the session id in brackets like [' +
    hits[0].session.slice(0, 8) +
    '] after each supported claim. If the sources do not answer it, say so plainly. Be concise.\n\nQUESTION: ' +
    query +
    '\n\nSOURCES follow:';
  const res = await llm.complete(ctx, instruction, context, {
    run: opts.run,
    model: opts.model,
    skipCheck: true,
    post: opts.post,
    env: opts.env,
    provider: opts.provider,
  });
  return res.ok
    ? { ok: true, text: res.text, hits: hits, provider: res.provider, model: res.model || null }
    : { ok: false, reason: res.reason, fix: res.fix || null, hits: hits };
}

// I2 (opt-in): semantic search via embeddings. Embeds the query + keepsakes through the
// embedding seam (Ollama/hosted) and cosine-ranks. Keepsake vectors are cached by
// content-hash in <configDir>/embeddings.json so only NEW/changed keepsakes are re-embedded.
// Returns { ok, hits } or { ok:false, reason } (e.g. no embedding endpoint) so callers can
// fall back to lexical.
async function semanticSearch(ctx, query, opts) {
  opts = opts || {};
  const embed = _embed;
  const crypto = _crypto;
  const docs = corpus(ctx);
  if (!docs.length) return { ok: false, reason: 'no-keepsakes', hits: [] };

  // The cache key MUST include the embedding space (model + endpoint): a cached vector from
  // one model is meaningless against a query embedded by another. Without this, changing
  // KEYFLIP_EMBED_MODEL/_URL silently serves stale cross-space vectors and ranks garbage.
  const space = (opts.model || embed.defaultModel()) + '\0' + (opts.url || embed.defaultUrl());
  const cacheFile = path.join(ctx.configDir, 'embeddings.json');
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {};
  } catch (e) {
    cache = {};
  }
  const need = [],
    needIdx = [];
  docs.forEach(function (d, i) {
    d._hash = crypto.createHash('sha1').update(d.text).digest('hex').slice(0, 16);
    const c = cache[d.key];
    if (!c || c.hash !== d._hash || c.space !== space) {
      need.push(d.text);
      needIdx.push(i);
    }
  });
  try {
    if (need.length) {
      const vecs = await embed.embed(need, opts);
      needIdx.forEach(function (di, k) {
        if (vecs[k]) cache[docs[di].key] = { hash: docs[di]._hash, space: space, vec: vecs[k] };
      });
      try {
        fs.writeFileSync(cacheFile, JSON.stringify(cache), { mode: 0o600 });
      } catch (e) {
        /* cache is best-effort */
      }
    }
    const qv = (await embed.embed([query], opts))[0];
    if (!qv) return { ok: false, reason: 'no-query-vector', hits: [] };
    const qterms = tokenize(query);
    const scored = docs
      .map(function (d) {
        const c = cache[d.key];
        const v = c && c.space === space ? c.vec : null; // never score against a stale-space vector
        return {
          key: d.key,
          session: d.session,
          cwd: d.cwd,
          score: v ? embed.cosine(qv, v) : 0,
          snippet: snippet(d.text, qterms),
        };
      })
      .filter(function (r) {
        return r.score > 0;
      });
    scored.sort(function (a, b) {
      return b.score - a.score;
    });
    return { ok: true, hits: scored.slice(0, opts.limit || 10) };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || 'embed-failed', hits: [] };
  }
}

export { tokenize, corpus, rank, search, answer, semanticSearch };
