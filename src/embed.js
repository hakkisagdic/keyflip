'use strict';
// I2 (opt-in): an EMBEDDING seam for true semantic recall. keyflip bundles NO model — it
// calls a user-run embedding endpoint (Ollama by default: POST /api/embed, or
// KEYFLIP_EMBED_URL) so zero-dep holds and nothing leaves the machine unless the user set up
// a hosted one. Used only by `recall --semantic`. Injectable poster for tests.
const http = require('http');
const https = require('https');

function defaultUrl() { return process.env.KEYFLIP_EMBED_URL || 'http://localhost:11434/api/embed'; }
function defaultModel() { return process.env.KEYFLIP_EMBED_MODEL || 'nomic-embed-text'; }

function postJson(url, body, timeoutMs) {
  return new Promise(function (resolve, reject) {
    let u; try { u = new URL(url); } catch (e) { return reject(new Error('bad embed URL: ' + url)); }
    const lib = u.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''), method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      timeout: timeoutMs || 30000,
    }, function (res) {
      let b = ''; res.on('data', function (d) { b += d; if (b.length > 64 * 1024 * 1024) req.destroy(new Error('embed response too large')); });
      res.on('end', function () {
        if (res.statusCode >= 300) return reject(new Error('embed endpoint returned http ' + res.statusCode));
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('embed endpoint returned invalid JSON')); }
      });
    });
    req.on('timeout', function () { req.destroy(new Error('embed endpoint timed out')); });
    req.on('error', function (e) { reject(new Error('embed endpoint unreachable (' + ((e && e.message) || 'error') + ') — is Ollama running? try `ollama serve`')); });
    req.end(payload);
  });
}

// Embed an array of strings -> array of vectors. Handles Ollama's {embeddings:[[...]]} and the
// OpenAI-style {data:[{embedding}]}. Throws on an unreachable/odd endpoint.
async function embed(texts, opts) {
  opts = opts || {};
  const url = opts.url || defaultUrl();
  const model = opts.model || defaultModel();
  const post = opts.post || postJson;
  const res = await post(url, { model: model, input: texts }, opts.timeoutMs || 30000);
  if (res && Array.isArray(res.embeddings)) return res.embeddings;
  if (res && Array.isArray(res.data)) {
    // OpenAI-style: entries are NOT guaranteed to be in request order — each carries an
    // `index`. Scatter by index so vectors align with their input text.
    const out = [];
    res.data.forEach(function (d, i) { out[(d && typeof d.index === 'number') ? d.index : i] = d && d.embedding; });
    return out;
  }
  if (res && Array.isArray(res.embedding)) return [res.embedding]; // single-vector shape
  throw new Error('unexpected embedding response shape');
}

function cosine(a, b) {
  if (!a || !b) return 0;
  // Different dimensions ⇒ vectors from different embedding spaces (e.g. a stale cached
  // vector vs a new-model query). Refuse rather than silently truncate to a garbage score.
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0; const n = a.length;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

module.exports = { embed: embed, cosine: cosine, defaultUrl: defaultUrl, defaultModel: defaultModel };
