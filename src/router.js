// MODEL ROUTING / ARBITRAGE + a response CACHE.
//
// (1) Routing: given a desired model, pick the CHEAPEST configured provider that
//     serves it. State lives in <configDir>/router.json = { routes: { model:
//     providerName }, arbitrage: bool }. A `route` is an explicit user PIN
//     (setRoute) that forces a model onto one provider; `arbitrage` (when on)
//     ignores pins and always chases the cheapest. Cost comes from an injected
//     priceFor(provider,model) hint, else a per-provider costHint on the meta,
//     else a deterministic alphabetical fallback. Provider facts are read from
//     provider.list/read — routing never mutates a provider.
//
// (2) Cache: a CONTENT + NORMALIZED/SIMILARITY cache keyed by sha256(model + '\n' + prompt),
//     stored at <configDir>/cache/<hash>.json = { model, promptHash, normHash, shingles,
//     response, inputTokens, outputTokens, costUsd, at }. The raw PROMPT is never stored
//     (only its hashes and numeric 32-bit FNV-1a shingle hashes — it may hold secrets);
//     the RESPONSE is model text that still gets a notify-style secret strip before it lands
//     on disk. Cache hits/misses and USD/TRY/token savings are tracked in cache-stats.json
//     and synced with license.recordUsage().
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as profiles from './profiles.js';
import * as provider from './provider.js';
import * as secretscan from './secretscan.js';
import * as license from './license.js';
import { atomicWrite, readJsonForWrite } from './fsutil.js';

const USD_TO_TRY_APPROX = 35;
const DEFAULT_SIMILARITY_THRESHOLD = 0.88;
const DEFAULT_BLENDED_USD_PER_MTOK = 6.0;

// A model id is user-supplied and becomes a MAP KEY, so it must be bounded and
// free of reserved object-property names (prototype-pollution safety). The char
// set covers real ids: claude-opus-4-8, us.anthropic.claude-*, anthropic/x, gpt-4o@2024.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/@-]*$/;
const RESERVED = ['__proto__', 'prototype', 'constructor'];
function isValidModel(m) {
  return typeof m === 'string' && m.length >= 1 && m.length <= 200 && MODEL_RE.test(m) && RESERVED.indexOf(m) === -1;
}

// ---------------------------------------------------------------------------
// Routing state
// ---------------------------------------------------------------------------
function routerPath(ctx) {
  return path.join(ctx.configDir, 'router.json');
}

// Coerce parsed JSON into a null-prototype { routes: {model->provider}, arbitrage }.
// Drops junk (bad model names, non-string/invalid provider names) so a tampered or
// hand-edited file can never inject a dangerous shape. Provider EXISTENCE is not
// checked here (route() reports a dangling pin at call time).
function normalizeState(parsed) {
  const out = { routes: Object.create(null), arbitrage: false };
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  out.arbitrage = parsed.arbitrage === true;
  const r = parsed.routes;
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    Object.keys(r).forEach(function (model) {
      if (!isValidModel(model)) return;
      const p = r[model];
      if (typeof p === 'string' && profiles.isValidName(p)) out.routes[model] = p;
    });
  }
  return out;
}

// Read-only, never throws (missing OR corrupt -> empty). Safe on the hot path.
function getState(ctx) {
  let parsed;
  try {
    parsed = readJsonForWrite(routerPath(ctx));
  } catch (e) {
    return { routes: Object.create(null), arbitrage: false };
  }
  return normalizeState(parsed);
}
// Read-for-write: a MISSING file is empty, but a CORRUPT file THROWS so a
// read-modify-write never silently clobbers the user's real state.
function loadForWrite(ctx) {
  return normalizeState(readJsonForWrite(routerPath(ctx)));
}

function saveState(ctx, state) {
  const routes = {};
  Object.keys(state.routes)
    .sort()
    .forEach(function (k) {
      routes[k] = state.routes[k];
    });
  atomicWrite(routerPath(ctx), JSON.stringify({ routes: routes, arbitrage: !!state.arbitrage }, null, 2), 0o600);
}

// Public read: plain, sorted, JSON-safe view of the state.
function get(ctx) {
  const s = getState(ctx);
  const routes = {};
  Object.keys(s.routes)
    .sort()
    .forEach(function (k) {
      routes[k] = s.routes[k];
    });
  return { routes: routes, arbitrage: s.arbitrage };
}

// Pin `model` onto `providerName`. Rejects invalid names and (unless
// opts.allowMissing) a provider that isn't configured — so a typo can't silently
// pin to nothing. CORRUPT file throws (never clobbers).
function setRoute(ctx, model, providerName, opts) {
  opts = opts || {};
  if (!isValidModel(model)) throw new Error("invalid model: '" + model + "'");
  if (!profiles.isValidName(providerName)) throw new Error("invalid provider name: '" + providerName + "'");
  if (!opts.allowMissing && !provider.exists(ctx, providerName))
    throw new Error("no such provider: '" + providerName + "' (see: keyflip provider list)");
  const s = loadForWrite(ctx);
  s.routes[model] = providerName;
  saveState(ctx, s);
  return { model: model, provider: providerName };
}

function clearRoute(ctx, model) {
  if (!isValidModel(model)) return false;
  const s = loadForWrite(ctx);
  if (!Object.prototype.hasOwnProperty.call(s.routes, model)) return false;
  delete s.routes[model];
  saveState(ctx, s);
  return true;
}

// Toggle pure-arbitrage mode (ignore pins, always cheapest). CORRUPT file throws.
function setArbitrage(ctx, on) {
  const s = loadForWrite(ctx);
  s.arbitrage = on === true;
  saveState(ctx, s);
  return s.arbitrage;
}

// ---------------------------------------------------------------------------
// Routing decision
// ---------------------------------------------------------------------------
// The set of model ids a provider serves: the concrete ids in meta.models
// (values), the logical slot names (keys: default/opus/sonnet/haiku/smallFast),
// plus an optional meta.servesModels array. Null-proto so a hostile id can't
// pollute a prototype during the membership test.
function servedModels(meta) {
  const out = Object.create(null);
  if (!meta || typeof meta !== 'object') return out;
  const m = meta.models;
  if (Array.isArray(m)) {
    m.forEach(function (x) {
      if (typeof x === 'string' && x) out[x] = true;
    });
  } else if (m && typeof m === 'object') {
    Object.keys(m).forEach(function (k) {
      if (k !== '__proto__') out[k] = true;
      if (typeof m[k] === 'string' && m[k]) out[m[k]] = true;
    });
  }
  if (Array.isArray(meta.servesModels))
    meta.servesModels.forEach(function (x) {
      if (typeof x === 'string' && x) out[x] = true;
    });
  return out;
}
function providerServes(meta, model) {
  return servedModels(meta)[model] === true;
}

// A numeric cost hint carried on a provider's own metadata (used when no
// priceFor is injected). Lower = cheaper.
function costHintOf(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const c =
    typeof meta.costHint === 'number'
      ? meta.costHint
      : typeof meta.pricePerMTok === 'number'
        ? meta.pricePerMTok
        : null;
  return typeof c === 'number' && isFinite(c) ? c : null;
}

const DEFAULT_COMPOSITE_WEIGHTS = { cost: 0.45, latency: 0.25, error: 0.2, quota: 0.1 };

function latencyHintOf(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const v = typeof meta.ttftMs === 'number' ? meta.ttftMs : typeof meta.latencyMs === 'number' ? meta.latencyMs : null;
  return typeof v === 'number' && isFinite(v) && v >= 0 ? v : null;
}

function errorRateHintOf(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const v =
    typeof meta.errorRate429 === 'number'
      ? meta.errorRate429
      : typeof meta.errorRate === 'number'
        ? meta.errorRate
        : null;
  return typeof v === 'number' && isFinite(v) && v >= 0 ? Math.min(1, v) : null;
}

function quotaHealthHintOf(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const v = typeof meta.quotaHealth === 'number' ? meta.quotaHealth : null;
  return typeof v === 'number' && isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
}

// Compute lower-is-better composite routing score in [0, 1].
function compositeScoreOf(metrics, bounds, weights) {
  const w = Object.assign({}, DEFAULT_COMPOSITE_WEIGHTS, weights || {});
  const maxCost = bounds && bounds.maxCost > 0 ? bounds.maxCost : 0;
  const maxLat = bounds && bounds.maxLatency > 0 ? bounds.maxLatency : 0;
  const normCost = metrics.cost != null && maxCost > 0 ? metrics.cost / maxCost : 0.5;
  const normLatency = metrics.latencyMs != null && maxLat > 0 ? metrics.latencyMs / maxLat : 0.5;
  const errPenalty = metrics.errorRate != null ? Math.min(1, Math.max(0, metrics.errorRate)) : 0;
  const quotaPenalty = metrics.quotaHealth != null ? Math.max(0, 1 - Math.min(1, Math.max(0, metrics.quotaHealth))) : 0;
  const score = w.cost * normCost + w.latency * normLatency + w.error * errPenalty + w.quota * quotaPenalty;
  return {
    score: Math.round(score * 10000) / 10000,
    normCost: Math.round(normCost * 10000) / 10000,
    normLatency: Math.round(normLatency * 10000) / 10000,
    errPenalty: Math.round(errPenalty * 10000) / 10000,
    quotaPenalty: Math.round(quotaPenalty * 10000) / 10000,
  };
}

function rankReason(ranked, win, anyPriced, strategy) {
  if (ranked.length === 1) return 'only provider serving the model';
  if (strategy === 'composite') {
    const parts = ['score=' + win.compositeScore];
    if (win.cost != null) parts.push('cost=' + win.cost);
    if (win.latencyMs != null) parts.push('ttft=' + win.latencyMs + 'ms');
    if (win.errorRate != null) parts.push('err=' + Math.round(win.errorRate * 100) + '%');
    return 'composite best of ' + ranked.length + ' (' + parts.join(', ') + ')';
  }
  if (strategy === 'latency' && win.latencyMs != null) {
    return 'lowest latency of ' + ranked.length + ' (' + win.latencyMs + 'ms)';
  }
  if (anyPriced && win.cost != null) return 'cheapest of ' + ranked.length + ' (cost ' + win.cost + ')';
  return 'first of ' + ranked.length + ' (no price hints; alphabetical)';
}

// route(ctx, {model, strategy?}, opts) -> { provider, baseUrl, reason, score?, breakdown? }.
// provider is null when nothing is configured to serve the model.
// Supports strategy: 'cost' (default) | 'latency' | 'composite'.
function route(ctx, sel, opts) {
  sel = sel || {};
  opts = opts || {};
  const model = sel.model;
  if (!isValidModel(model)) throw new Error('route requires a valid model');
  const state = getState(ctx);
  const priceFor = typeof opts.priceFor === 'function' ? opts.priceFor : null;

  const names = provider.list(ctx);
  const metas = Object.create(null);
  names.forEach(function (n) {
    metas[n] = provider.read(ctx, n);
  });

  const pinned = state.routes[model];
  const pinExists = !!pinned && names.indexOf(pinned) !== -1;

  // A pin is honored verbatim unless arbitrage mode overrides it for savings.
  if (pinned && pinExists && !state.arbitrage) {
    const pm = metas[pinned];
    return {
      provider: pinned,
      baseUrl: (pm && pm.baseUrl) || null,
      reason: 'pinned route' + (providerServes(pm, model) ? '' : ' (note: provider does not list this model)'),
    };
  }

  const candidates = names.filter(function (n) {
    return providerServes(metas[n], model);
  });
  if (!candidates.length) {
    return {
      provider: null,
      baseUrl: null,
      reason:
        'no configured provider serves "' +
        model +
        '"' +
        (pinned && !pinExists ? ' (pinned provider "' + pinned + '" is not configured)' : ''),
    };
  }

  const latencyFor = typeof opts.latencyFor === 'function' ? opts.latencyFor : null;
  const errorRateFor = typeof opts.errorRateFor === 'function' ? opts.errorRateFor : null;
  const healthFor = typeof opts.healthFor === 'function' ? opts.healthFor : null;
  const requestedStrategy = sel.strategy || opts.strategy || null;
  const strategy =
    requestedStrategy === 'composite' || requestedStrategy === 'latency' || requestedStrategy === 'cost'
      ? requestedStrategy
      : latencyFor || errorRateFor || healthFor
        ? 'composite'
        : 'cost';

  const rawRows = candidates.map(function (n) {
    let cost = null;
    if (priceFor) {
      const c = priceFor(n, model);
      if (typeof c === 'number' && isFinite(c)) cost = c;
    }
    if (cost == null) cost = costHintOf(metas[n]);

    let latencyMs = null;
    if (latencyFor) {
      const l = latencyFor(n, model);
      if (typeof l === 'number' && isFinite(l) && l >= 0) latencyMs = l;
    }
    if (latencyMs == null) latencyMs = latencyHintOf(metas[n]);

    let errorRate = null;
    if (errorRateFor) {
      const er = errorRateFor(n, model);
      if (typeof er === 'number' && isFinite(er) && er >= 0) errorRate = Math.min(1, er);
    }
    if (errorRate == null) errorRate = errorRateHintOf(metas[n]);

    let quotaHealth = null;
    if (healthFor) {
      const qh = healthFor(n, model);
      if (typeof qh === 'number' && isFinite(qh)) quotaHealth = Math.min(1, Math.max(0, qh));
    }
    if (quotaHealth == null) quotaHealth = quotaHealthHintOf(metas[n]);

    return {
      name: n,
      cost: cost,
      latencyMs: latencyMs,
      errorRate: errorRate,
      quotaHealth: quotaHealth,
    };
  });

  const maxCost = rawRows.reduce(function (m, r) {
    return r.cost != null && r.cost > m ? r.cost : m;
  }, 0);
  const maxLatency = rawRows.reduce(function (m, r) {
    return r.latencyMs != null && r.latencyMs > m ? r.latencyMs : m;
  }, 0);

  const ranked = rawRows
    .map(function (r) {
      const comp = compositeScoreOf(r, { maxCost: maxCost, maxLatency: maxLatency }, opts.weights);
      return Object.assign({}, r, { compositeScore: comp.score, breakdown: comp });
    })
    .sort(function (a, b) {
      if (strategy === 'composite') {
        if (a.compositeScore !== b.compositeScore) return a.compositeScore - b.compositeScore;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      }
      if (strategy === 'latency') {
        if (a.latencyMs == null && b.latencyMs == null) return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
        if (a.latencyMs == null) return 1;
        if (b.latencyMs == null) return -1;
        if (a.latencyMs !== b.latencyMs) return a.latencyMs - b.latencyMs;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      }
      if (a.cost == null && b.cost == null) return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      if (a.cost == null) return 1; // unpriced sorts last
      if (b.cost == null) return -1;
      if (a.cost !== b.cost) return a.cost - b.cost;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; // stable tiebreak
    });

  const win = ranked[0];
  const anyPriced = ranked.some(function (r) {
    return r.cost != null;
  });
  let reason;
  if (state.arbitrage) reason = 'arbitrage: ' + rankReason(ranked, win, anyPriced, strategy);
  else if (pinned && !pinExists)
    reason = 'pinned provider "' + pinned + '" missing; ' + rankReason(ranked, win, anyPriced, strategy);
  else reason = rankReason(ranked, win, anyPriced, strategy);

  const out = { provider: win.name, baseUrl: (metas[win.name] && metas[win.name].baseUrl) || null, reason: reason };
  if (strategy === 'composite') {
    out.score = win.compositeScore;
    out.breakdown = win.breakdown;
  } else if (strategy === 'latency' && win.latencyMs != null) {
    out.latencyMs = win.latencyMs;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Response cache + Normalized/Similarity Lookup + Savings Ledger (P1-2)
// ---------------------------------------------------------------------------
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_FILES = 500; // bound the dir (anti-unbounded-growth); oldest evicted

function cacheDir(ctx) {
  return path.join(ctx.configDir, 'cache');
}
function cacheStatsPath(ctx) {
  return path.join(ctx.configDir, 'cache-stats.json');
}
function cacheKey(model, prompt) {
  return crypto
    .createHash('sha256')
    .update(String(model) + '\n' + String(prompt))
    .digest('hex');
}
function cacheFile(ctx, model, prompt) {
  return path.join(cacheDir(ctx), cacheKey(model, prompt) + '.json');
}

// Normalize prompt text for equivalence / similarity comparison:
// lowercase, strip punctuation, collapse whitespace.
function normalizePrompt(prompt) {
  return String(prompt == null ? '' : prompt)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normKey(model, prompt) {
  return crypto
    .createHash('sha256')
    .update(String(model) + '\n' + normalizePrompt(prompt))
    .digest('hex');
}

// FNV-1a 32-bit unsigned integer hash of a 3-gram shingle.
// Storing only sorted integer hashes (capped to 64) ensures raw prompt words
// never touch disk while allowing fast Jaccard similarity evaluation.
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function shingleSignatures(prompt) {
  const norm = normalizePrompt(prompt);
  if (!norm) return [];
  const compact = norm.replace(/\s+/g, ' ');
  const set = new Set();
  if (compact.length < 3) {
    set.add(fnv1a32(compact));
  } else {
    for (let i = 0; i <= compact.length - 3; i++) {
      set.add(fnv1a32(compact.slice(i, i + 3)));
    }
  }
  // Keep up to 96 smallest hashes (MinHash-style bounded sketch)
  return Array.from(set)
    .sort(function (a, b) {
      return a - b;
    })
    .slice(0, 96);
}

function jaccardSimilarity(sigA, sigB) {
  if (!Array.isArray(sigA) || !Array.isArray(sigB) || !sigA.length || !sigB.length) return 0;
  let i = 0,
    j = 0,
    inter = 0;
  while (i < sigA.length && j < sigB.length) {
    if (sigA[i] === sigB[j]) {
      inter++;
      i++;
      j++;
    } else if (sigA[i] < sigB[j]) {
      i++;
    } else {
      j++;
    }
  }
  const union = sigA.length + sigB.length - inter;
  return union > 0 ? inter / union : 0;
}

function round6(n) {
  return Math.round((Number(n) || 0) * 1000000) / 1000000;
}
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function readCacheStatsRaw(ctx) {
  try {
    const raw = readJsonForWrite(cacheStatsPath(ctx));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return {
        hits: Number(raw.hits) || 0,
        misses: Number(raw.misses) || 0,
        savedTokens: Number(raw.savedTokens) || 0,
        savedUsd: round6(raw.savedUsd),
        savedTry: round2(raw.savedTry),
      };
    }
  } catch (e) {
    /* fall through */
  }
  return { hits: 0, misses: 0, savedTokens: 0, savedUsd: 0, savedTry: 0 };
}

function recordCacheMetric(ctx, hitEntry, isHit, promptText, opts) {
  if (!ctx || !ctx.configDir || (opts && opts.trackStats === false)) return;
  try {
    const cur = readCacheStatsRaw(ctx);
    if (isHit && hitEntry) {
      cur.hits += 1;
      const inTok =
        typeof hitEntry.inputTokens === 'number' && hitEntry.inputTokens > 0
          ? hitEntry.inputTokens
          : Math.max(1, Math.ceil(String(promptText || '').length / 4));
      const outTok =
        typeof hitEntry.outputTokens === 'number' && hitEntry.outputTokens > 0
          ? hitEntry.outputTokens
          : Math.max(1, Math.ceil(String(hitEntry.response || '').length / 4));
      const tok = inTok + outTok;
      const usd =
        typeof hitEntry.costUsd === 'number' && hitEntry.costUsd > 0
          ? hitEntry.costUsd
          : round6((tok / 1000000) * DEFAULT_BLENDED_USD_PER_MTOK);
      const tryAmt = round2(usd * ((opts && opts.usdToTryRate) || USD_TO_TRY_APPROX));
      cur.savedTokens += tok;
      cur.savedUsd = round6(cur.savedUsd + usd);
      cur.savedTry = round2(cur.savedTry + tryAmt);
      atomicWrite(cacheStatsPath(ctx), JSON.stringify(cur, null, 2), 0o600);
      try {
        license.recordUsage(ctx, { savedUsd: usd, savedTokens: tok });
      } catch (e) {
        /* best effort */
      }
    } else if (!isHit) {
      cur.misses += 1;
      atomicWrite(cacheStatsPath(ctx), JSON.stringify(cur, null, 2), 0o600);
    }
  } catch (e) {
    /* best effort */
  }
}

// "now" as an ISO string / ms, from opts.now (fn|string) else ctx.now() — never a real clock.
function nowIso(ctx, opts) {
  return opts && opts.now != null
    ? typeof opts.now === 'function'
      ? String(opts.now())
      : String(opts.now)
    : ctx.now();
}
function nowMs(ctx, opts) {
  const t = Date.parse(nowIso(ctx, opts));
  return isNaN(t) ? Date.parse(ctx.now()) : t;
}

// Notify-style secret strip for the free-text response: redact any token that
// matches a known secret SHAPE (sk-ant-…, JWTs, private keys, …) before storing.
// The response is model text, but a model can echo a secret back — never persist it.
function stripSecretText(text) {
  let s = String(text == null ? '' : text);
  secretscan.SECRET_PATTERNS.forEach(function (p) {
    s = s.replace(new RegExp(p.re.source, 'g'), secretscan.REDACTED);
  });
  return s;
}

// Only files we own: <64-hex-sha256>.json (never touches sibling config files).
function listCacheFiles(ctx) {
  let files;
  try {
    files = fs.readdirSync(cacheDir(ctx));
  } catch (e) {
    return [];
  }
  return files.filter(function (f) {
    return /^[0-9a-f]{64}\.json$/.test(f);
  });
}
function readEntryFile(ctx, file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cacheDir(ctx), file), 'utf8'));
  } catch (e) {
    return null;
  }
}

// Enforce the file-count cap by evicting the OLDEST (by stored `at`, mtime fallback).
function evict(ctx, opts) {
  const cap = opts && typeof opts.maxFiles === 'number' && opts.maxFiles > 0 ? opts.maxFiles : MAX_CACHE_FILES;
  const dir = cacheDir(ctx);
  const files = listCacheFiles(ctx);
  if (files.length <= cap) return 0;
  const stamped = files
    .map(function (f) {
      let at = null;
      const e = readEntryFile(ctx, f);
      if (e && e.at) {
        const t = Date.parse(e.at);
        if (!isNaN(t)) at = t;
      }
      if (at == null) {
        try {
          at = fs.statSync(path.join(dir, f)).mtimeMs;
        } catch (e2) {
          at = 0;
        }
      }
      return { f: f, at: at };
    })
    .sort(function (a, b) {
      return a.at - b.at || (a.f < b.f ? -1 : a.f > b.f ? 1 : 0);
    });
  const toRemove = stamped.length - cap;
  let removed = 0;
  for (let i = 0; i < toRemove; i++) {
    try {
      fs.rmSync(path.join(dir, stamped[i].f), { force: true });
      removed++;
    } catch (e) {
      /* ignore */
    }
  }
  return removed;
}

// cacheGet(ctx, {model, prompt}, opts) -> hit | null. Respects opts.ttlMs
// (default 24h) measured against ctx.now(). A model/hash mismatch (tamper or the
// vanishingly unlikely collision) is treated as a miss.
function cacheGet(ctx, sel, opts) {
  sel = sel || {};
  opts = opts || {};
  const model = sel.model,
    prompt = sel.prompt;
  if (!isValidModel(model) || typeof prompt !== 'string' || !prompt.length) return null;
  const hash = cacheKey(model, prompt);
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(path.join(cacheDir(ctx), hash + '.json'), 'utf8'));
  } catch (e) {
    recordCacheMetric(ctx, null, false, prompt, opts);
    return null;
  }
  if (!entry || typeof entry !== 'object' || entry.model !== model || entry.promptHash !== hash) {
    recordCacheMetric(ctx, null, false, prompt, opts);
    return null;
  }
  const ttl = typeof opts.ttlMs === 'number' && opts.ttlMs >= 0 ? opts.ttlMs : DAY_MS;
  const at = Date.parse(entry.at);
  const now = nowMs(ctx, opts);
  if (!isNaN(at) && now - at > ttl) {
    recordCacheMetric(ctx, null, false, prompt, opts);
    return null; // expired
  }
  recordCacheMetric(ctx, entry, true, prompt, opts);
  return {
    model: entry.model,
    promptHash: entry.promptHash,
    response: typeof entry.response === 'string' ? entry.response : '',
    at: entry.at,
    ageMs: isNaN(at) ? null : now - at,
  };
}

// Normalized / Jaccard similarity cache lookup (P1-2).
// First attempts an exact match; if missed, compares normalized prompt hash and
// 3-gram shingle Jaccard similarity against non-expired entries for the same model.
function cacheLookupSimilar(ctx, sel, opts) {
  sel = sel || {};
  opts = opts || {};
  const model = sel.model,
    prompt = sel.prompt;
  if (!isValidModel(model) || typeof prompt !== 'string' || !prompt.length) return null;

  // 1) Try exact match (without double-counting miss if we fall back to similarity)
  const exact = cacheGet(ctx, sel, Object.assign({}, opts, { trackStats: false }));
  if (exact) {
    recordCacheMetric(ctx, exact, true, prompt, opts);
    return Object.assign({}, exact, { similarity: 1, matchType: 'exact' });
  }

  const threshold =
    typeof opts.threshold === 'number' && opts.threshold > 0 && opts.threshold <= 1
      ? opts.threshold
      : DEFAULT_SIMILARITY_THRESHOLD;
  const ttl = typeof opts.ttlMs === 'number' && opts.ttlMs >= 0 ? opts.ttlMs : DAY_MS;
  const now = nowMs(ctx, opts);
  const targetNorm = normKey(model, prompt);
  const targetShingles = shingleSignatures(prompt);

  const files = listCacheFiles(ctx);
  let bestEntry = null;
  let bestSim = 0;
  let bestAgeMs = null;

  for (let i = 0; i < files.length; i++) {
    const e = readEntryFile(ctx, files[i]);
    if (!e || typeof e !== 'object' || e.model !== model) continue;
    const at = Date.parse(e.at);
    if (!isNaN(at) && now - at > ttl) continue;
    let sim = 0;
    if (e.normHash && e.normHash === targetNorm) {
      sim = 1;
    } else if (Array.isArray(e.shingles) && e.shingles.length) {
      sim = jaccardSimilarity(targetShingles, e.shingles);
    }
    if (sim >= threshold && sim > bestSim) {
      bestSim = sim;
      bestEntry = e;
      bestAgeMs = isNaN(at) ? null : now - at;
      if (sim === 1) break;
    }
  }

  if (!bestEntry) {
    recordCacheMetric(ctx, null, false, prompt, opts);
    return null;
  }

  recordCacheMetric(ctx, bestEntry, true, prompt, opts);
  return {
    model: bestEntry.model,
    promptHash: bestEntry.promptHash,
    response: typeof bestEntry.response === 'string' ? bestEntry.response : '',
    at: bestEntry.at,
    ageMs: bestAgeMs,
    similarity: Math.round(bestSim * 10000) / 10000,
    matchType: bestSim === 1 ? 'normalized' : 'similar',
  };
}

// cachePut(ctx, {model, prompt, response, inputTokens?, outputTokens?, costUsd?}, opts).
// Stores model + key-hash + normHash + numeric shingle sketch + secret-stripped response + timestamp.
// Never stores the raw prompt. Evicts to cap.
function cachePut(ctx, sel, opts) {
  sel = sel || {};
  opts = opts || {};
  const model = sel.model,
    prompt = sel.prompt;
  if (!isValidModel(model)) throw new Error('cachePut requires a valid model');
  if (typeof prompt !== 'string' || !prompt.length) throw new Error('cachePut requires a non-empty prompt');
  const response = stripSecretText(sel.response);
  const dir = cacheDir(ctx);
  fs.mkdirSync(dir, { recursive: true });
  const hash = cacheKey(model, prompt);
  const nHash = normKey(model, prompt);
  const shingles = shingleSignatures(prompt);
  const at = nowIso(ctx, opts);
  const record = {
    model: model,
    promptHash: hash,
    normHash: nHash,
    shingles: shingles,
    response: response,
    at: at,
  };
  if (typeof sel.inputTokens === 'number' && sel.inputTokens >= 0) record.inputTokens = sel.inputTokens;
  if (typeof sel.outputTokens === 'number' && sel.outputTokens >= 0) record.outputTokens = sel.outputTokens;
  if (typeof sel.costUsd === 'number' && sel.costUsd >= 0) record.costUsd = round6(sel.costUsd);
  atomicWrite(path.join(dir, hash + '.json'), JSON.stringify(record, null, 2), 0o600);
  const evicted = evict(ctx, opts);
  return { model: model, promptHash: hash, at: at, bytes: Buffer.byteLength(response), evicted: evicted };
}

// cachePurge(ctx, {olderThanMs?}, opts) -> { removed }. No olderThanMs = purge all.
function cachePurge(ctx, sel, opts) {
  sel = sel || {};
  opts = opts || {};
  const dir = cacheDir(ctx);
  const files = listCacheFiles(ctx);
  const now = nowMs(ctx, opts);
  const older = typeof sel.olderThanMs === 'number' && sel.olderThanMs >= 0 ? sel.olderThanMs : null;
  let removed = 0;
  files.forEach(function (f) {
    if (older == null) {
      try {
        fs.rmSync(path.join(dir, f), { force: true });
        removed++;
      } catch (e) {
        /* ignore */
      }
      return;
    }
    const e = readEntryFile(ctx, f);
    let at = e && e.at ? Date.parse(e.at) : NaN;
    if (isNaN(at)) {
      try {
        at = fs.statSync(path.join(dir, f)).mtimeMs;
      } catch (e2) {
        at = 0;
      }
    }
    if (now - at > older) {
      try {
        fs.rmSync(path.join(dir, f), { force: true });
        removed++;
      } catch (e2) {
        /* ignore */
      }
    }
  });
  return { removed: removed };
}

// Read-only cache overview + savings metrics for `cache status` / `cache stats` / MCP tools.
function cacheStatus(ctx) {
  const dir = cacheDir(ctx);
  const files = listCacheFiles(ctx);
  let bytes = 0,
    oldest = null,
    newest = null;
  files.forEach(function (f) {
    let st;
    try {
      st = fs.statSync(path.join(dir, f));
    } catch (e) {
      return;
    }
    bytes += st.size;
    const e = readEntryFile(ctx, f);
    const at = e && e.at ? e.at : null;
    if (at) {
      if (!oldest || at < oldest) oldest = at;
      if (!newest || at > newest) newest = at;
    }
  });
  const s = readCacheStatsRaw(ctx);
  const totalLookups = s.hits + s.misses;
  const hitRatePct = totalLookups > 0 ? round2((s.hits / totalLookups) * 100) : 0;
  return {
    dir: dir,
    count: files.length,
    bytes: bytes,
    cap: MAX_CACHE_FILES,
    oldest: oldest,
    newest: newest,
    hits: s.hits,
    misses: s.misses,
    totalLookups: totalLookups,
    hitRatePct: hitRatePct,
    savedTokens: s.savedTokens,
    savedUsd: s.savedUsd,
    savedTry: s.savedTry,
  };
}

function cacheStats(ctx) {
  return cacheStatus(ctx);
}

export {
  // routing
  routerPath,
  get,
  route,
  setRoute,
  clearRoute,
  setArbitrage,
  isValidModel,
  servedModels,
  providerServes,
  costHintOf,
  latencyHintOf,
  errorRateHintOf,
  quotaHealthHintOf,
  compositeScoreOf, // cache
  cacheDir,
  cacheStatsPath,
  cacheKey,
  normKey,
  normalizePrompt,
  shingleSignatures,
  jaccardSimilarity,
  cacheFile,
  cacheGet,
  cacheLookupSimilar,
  cachePut,
  cachePurge,
  cacheStatus,
  cacheStats,
  stripSecretText,
  DAY_MS,
  MAX_CACHE_FILES,
};
