// Preset provider catalog (#1). A handful of endpoints (Z.AI/GLM, Kimi, DeepSeek,
// MiniMax, Qwen, OpenRouter, OpenAI, Gemini, local Ollama/LM Studio/llama.cpp…)
// with the base URL from the vendor's own docs and the model names a Claude-Code
// user would put in ANTHROPIC_*. `keyflip provider add <id>` therefore needs only
// the key. This module is PURE DATA + one HTTP probe: it never stores a key and
// never logs one.
//
// `compat` is the honest part of the table: 'anthropic' means Claude Code can be
// pointed at the URL directly; 'openai' means the endpoint speaks the OpenAI chat
// API and needs an Anthropic-compatible gateway/shim (or is for router/cost use).
// `keyflip provider use` warns for the latter instead of silently breaking the
// CLI. Model names drift — `keyflip provider models <id>` asks the live
// /v1/models so the user can confirm/replace them.
import fs from 'fs';
import * as provider from './provider.js';

const CATALOG_URL = new URL('./catalog.json', import.meta.url);
const CATEGORY_LABELS = {
  official: 'Official',
  aggregator: 'Aggregators',
  china: 'China / direct',
  global: 'Global',
  local: 'Local (no key needed)',
};

let cache = null;

function normalize(entry) {
  return {
    id: entry.id,
    name: entry.name || entry.id,
    category: entry.category || 'global',
    baseUrl: entry.baseUrl,
    compat: entry.compat === 'openai' ? 'openai' : 'anthropic',
    authScheme: entry.authScheme === 'api-key' ? 'api-key' : 'bearer',
    models: entry.models && typeof entry.models === 'object' ? entry.models : {},
    docs: entry.docs || null,
  };
}

// Read + validate the bundled catalog. A malformed file must not take the CLI
// down: it degrades to an empty list (and callers say "no catalog").
function load() {
  if (cache) return cache;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(CATALOG_URL, 'utf8'));
  } catch (e) {
    parsed = null;
  }
  const rows = parsed && Array.isArray(parsed.providers) ? parsed.providers : [];
  cache = rows
    .filter(function (e) {
      return (
        e && typeof e.id === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(e.id) && /^https?:\/\//.test(e.baseUrl || '')
      );
    })
    .map(normalize);
  return cache;
}

function list() {
  return load().map(function (e) {
    return Object.assign({}, e, { models: Object.assign({}, e.models) });
  });
}

function get(id) {
  const want = String(id || '').toLowerCase();
  const hit = load().filter(function (e) {
    return e.id === want;
  })[0];
  return hit ? Object.assign({}, hit, { models: Object.assign({}, hit.models) }) : null;
}

function categories() {
  const out = [];
  load().forEach(function (e) {
    if (out.indexOf(e.category) === -1) out.push(e.category);
  });
  return out;
}

function categoryLabel(id) {
  return CATEGORY_LABELS[id] || id;
}

// Where to ask the endpoint for its model list: an OpenAI-style base ends in
// /v1 (append /models); an Anthropic-style base is a host (append /v1/models).
function modelsUrl(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (/\/v1$/.test(base)) return base + '/models';
  return base + '/v1/models';
}

// Auth headers for a probe — same scheme the proxy/provider uses. The key is
// never included in a returned value; only the header object is built.
function authHeaders(meta, key) {
  const headers = {};
  if (key) {
    if (meta.authScheme === 'api-key') headers['x-api-key'] = key;
    else headers.authorization = 'Bearer ' + key;
  }
  if (meta.compat === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  return headers;
}

// Probe GET <base>/v1/models. Any HTTP response proves reachability; a 401/403
// means the key is the problem, which the caller reports as such.
async function fetchModels(ctx, meta, opts) {
  opts = opts || {};
  const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) return { ok: false, error: 'fetch unavailable', models: [], status: null };
  let key = opts.key || null;
  if (!key && meta && meta.name) {
    try {
      key = ctx.store.getProfile(provider.keyStoreName(meta.name));
    } catch (e) {
      key = null;
    }
  }
  const url = modelsUrl(meta.baseUrl);
  const t0 = Date.now();
  let res;
  try {
    res = await doFetch(url, {
      method: 'GET',
      headers: authHeaders(meta, key),
      signal:
        typeof AbortSignal !== 'undefined' && AbortSignal.timeout
          ? AbortSignal.timeout(opts.timeoutMs || 8000)
          : undefined,
    });
  } catch (e) {
    return { ok: false, status: null, models: [], ms: Date.now() - t0, error: (e && e.message) || 'network error' };
  }
  const ms = Date.now() - t0;
  let body = null;
  try {
    const text = await res.text();
    body = text ? JSON.parse(text) : null;
  } catch (e) {
    body = null;
  }
  const rows = body && Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [];
  const models = rows
    .map(function (m) {
      return typeof m === 'string' ? m : m && (m.id || m.name);
    })
    .filter(function (s) {
      return typeof s === 'string' && s;
    });
  return {
    ok: res.ok && models.length > 0,
    status: res.status,
    models: models,
    ms: ms,
    error: res.ok ? (models.length ? null : 'no model list in the response') : 'http ' + res.status,
  };
}

export { list, get, categories, categoryLabel, modelsUrl, authHeaders, fetchModels, CATEGORY_LABELS };
