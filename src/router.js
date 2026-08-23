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
// (2) Cache: a CONTENT cache keyed by sha256(model + '\n' + prompt), stored at
//     <configDir>/cache/<hash>.json = { model, promptHash, response, at }. The
//     PROMPT is never stored (only its hash — it may hold secrets); the RESPONSE
//     is model text that still gets a notify-style secret strip before it lands
//     on disk. The dir is bounded (cap file count, evict oldest). TTL and "now"
//     come from ctx.now() (injectable) — no real clock, no network, pure-ish.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as profiles from './profiles.js';
import * as provider from './provider.js';
import * as secretscan from './secretscan.js';
import { atomicWrite, readJsonForWrite } from './fsutil.js';

// A model id is user-supplied and becomes a MAP KEY, so it must be bounded and
// free of reserved object-property names (prototype-pollution safety). The char
// set covers real ids: claude-opus-4-8, us.anthropic.claude-*, anthropic/x, gpt-4o@2024.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/@-]*$/;
const RESERVED = ['__proto__', 'prototype', 'constructor'];
function isValidModel(m) { return typeof m === 'string' && m.length >= 1 && m.length <= 200 && MODEL_RE.test(m) && RESERVED.indexOf(m) === -1; }

// ---------------------------------------------------------------------------
// Routing state
// ---------------------------------------------------------------------------
function routerPath(ctx) { return path.join(ctx.configDir, 'router.json'); }

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
  try { parsed = readJsonForWrite(routerPath(ctx)); } catch (e) { return { routes: Object.create(null), arbitrage: false }; }
  return normalizeState(parsed);
}
// Read-for-write: a MISSING file is empty, but a CORRUPT file THROWS so a
// read-modify-write never silently clobbers the user's real state.
function loadForWrite(ctx) { return normalizeState(readJsonForWrite(routerPath(ctx))); }

function saveState(ctx, state) {
  const routes = {};
  Object.keys(state.routes).sort().forEach(function (k) { routes[k] = state.routes[k]; });
  atomicWrite(routerPath(ctx), JSON.stringify({ routes: routes, arbitrage: !!state.arbitrage }, null, 2), 0o600);
}

// Public read: plain, sorted, JSON-safe view of the state.
function get(ctx) {
  const s = getState(ctx);
  const routes = {};
  Object.keys(s.routes).sort().forEach(function (k) { routes[k] = s.routes[k]; });
  return { routes: routes, arbitrage: s.arbitrage };
}

// Pin `model` onto `providerName`. Rejects invalid names and (unless
// opts.allowMissing) a provider that isn't configured — so a typo can't silently
// pin to nothing. CORRUPT file throws (never clobbers).
function setRoute(ctx, model, providerName, opts) {
  opts = opts || {};
  if (!isValidModel(model)) throw new Error("invalid model: '" + model + "'");
  if (!profiles.isValidName(providerName)) throw new Error("invalid provider name: '" + providerName + "'");
  if (!opts.allowMissing && !provider.exists(ctx, providerName)) throw new Error("no such provider: '" + providerName + "' (see: keyflip provider list)");
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
    m.forEach(function (x) { if (typeof x === 'string' && x) out[x] = true; });
  } else if (m && typeof m === 'object') {
    Object.keys(m).forEach(function (k) { if (k !== '__proto__') out[k] = true; if (typeof m[k] === 'string' && m[k]) out[m[k]] = true; });
  }
  if (Array.isArray(meta.servesModels)) meta.servesModels.forEach(function (x) { if (typeof x === 'string' && x) out[x] = true; });
  return out;
}
function providerServes(meta, model) { return servedModels(meta)[model] === true; }

// A numeric cost hint carried on a provider's own metadata (used when no
// priceFor is injected). Lower = cheaper.
function costHintOf(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const c = (typeof meta.costHint === 'number') ? meta.costHint : (typeof meta.pricePerMTok === 'number' ? meta.pricePerMTok : null);
  return (typeof c === 'number' && isFinite(c)) ? c : null;
}

function rankReason(ranked, win, anyPriced) {
  if (ranked.length === 1) return 'only provider serving the model';
  if (anyPriced && win.cost != null) return 'cheapest of ' + ranked.length + ' (cost ' + win.cost + ')';
  return 'first of ' + ranked.length + ' (no price hints; alphabetical)';
}

// route(ctx, {model}, opts) -> { provider, baseUrl, reason }. provider is null
// when nothing is configured to serve the model. opts.priceFor(provider,model)
// (returns a number or null) overrides the per-provider costHint.
function route(ctx, sel, opts) {
  sel = sel || {}; opts = opts || {};
  const model = sel.model;
  if (!isValidModel(model)) throw new Error('route requires a valid model');
  const state = getState(ctx);
  const priceFor = typeof opts.priceFor === 'function' ? opts.priceFor : null;

  const names = provider.list(ctx);
  const metas = Object.create(null);
  names.forEach(function (n) { metas[n] = provider.read(ctx, n); });

  const pinned = state.routes[model];
  const pinExists = !!pinned && names.indexOf(pinned) !== -1;

  // A pin is honored verbatim unless arbitrage mode overrides it for savings.
  if (pinned && pinExists && !state.arbitrage) {
    const pm = metas[pinned];
    return { provider: pinned, baseUrl: (pm && pm.baseUrl) || null,
      reason: 'pinned route' + (providerServes(pm, model) ? '' : ' (note: provider does not list this model)') };
  }

  const candidates = names.filter(function (n) { return providerServes(metas[n], model); });
  if (!candidates.length) {
    return { provider: null, baseUrl: null,
      reason: 'no configured provider serves "' + model + '"' + (pinned && !pinExists ? ' (pinned provider "' + pinned + '" is not configured)' : '') };
  }

  const ranked = candidates.map(function (n) {
    let cost = null;
    if (priceFor) { const c = priceFor(n, model); if (typeof c === 'number' && isFinite(c)) cost = c; }
    if (cost == null) cost = costHintOf(metas[n]);
    return { name: n, cost: cost };
  }).sort(function (a, b) {
    if (a.cost == null && b.cost == null) return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    if (a.cost == null) return 1;   // unpriced sorts last
    if (b.cost == null) return -1;
    if (a.cost !== b.cost) return a.cost - b.cost;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); // stable tiebreak
  });

  const win = ranked[0];
  const anyPriced = ranked.some(function (r) { return r.cost != null; });
  let reason;
  if (state.arbitrage) reason = 'arbitrage: ' + rankReason(ranked, win, anyPriced);
  else if (pinned && !pinExists) reason = 'pinned provider "' + pinned + '" missing; ' + rankReason(ranked, win, anyPriced);
  else reason = rankReason(ranked, win, anyPriced);

  return { provider: win.name, baseUrl: (metas[win.name] && metas[win.name].baseUrl) || null, reason: reason };
}

// ---------------------------------------------------------------------------
// Response cache
// ---------------------------------------------------------------------------
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_FILES = 500; // bound the dir (anti-unbounded-growth); oldest evicted

function cacheDir(ctx) { return path.join(ctx.configDir, 'cache'); }
function cacheKey(model, prompt) { return crypto.createHash('sha256').update(String(model) + '\n' + String(prompt)).digest('hex'); }
function cacheFile(ctx, model, prompt) { return path.join(cacheDir(ctx), cacheKey(model, prompt) + '.json'); }

// "now" as an ISO string / ms, from opts.now (fn|string) else ctx.now() — never a real clock.
function nowIso(ctx, opts) { return (opts && opts.now != null) ? (typeof opts.now === 'function' ? String(opts.now()) : String(opts.now)) : ctx.now(); }
function nowMs(ctx, opts) { const t = Date.parse(nowIso(ctx, opts)); return isNaN(t) ? Date.parse(ctx.now()) : t; }

// Notify-style secret strip for the free-text response: redact any token that
// matches a known secret SHAPE (sk-ant-…, JWTs, private keys, …) before storing.
// The response is model text, but a model can echo a secret back — never persist it.
function stripSecretText(text) {
  let s = String(text == null ? '' : text);
  secretscan.SECRET_PATTERNS.forEach(function (p) { s = s.replace(new RegExp(p.re.source, 'g'), secretscan.REDACTED); });
  return s;
}

// Only files we own: <64-hex-sha256>.json (never touches sibling config files).
function listCacheFiles(ctx) {
  let files;
  try { files = fs.readdirSync(cacheDir(ctx)); } catch (e) { return []; }
  return files.filter(function (f) { return /^[0-9a-f]{64}\.json$/.test(f); });
}
function readEntryFile(ctx, file) {
  try { return JSON.parse(fs.readFileSync(path.join(cacheDir(ctx), file), 'utf8')); } catch (e) { return null; }
}

// Enforce the file-count cap by evicting the OLDEST (by stored `at`, mtime fallback).
function evict(ctx, opts) {
  const cap = (opts && typeof opts.maxFiles === 'number' && opts.maxFiles > 0) ? opts.maxFiles : MAX_CACHE_FILES;
  const dir = cacheDir(ctx);
  const files = listCacheFiles(ctx);
  if (files.length <= cap) return 0;
  const stamped = files.map(function (f) {
    let at = null;
    const e = readEntryFile(ctx, f);
    if (e && e.at) { const t = Date.parse(e.at); if (!isNaN(t)) at = t; }
    if (at == null) { try { at = fs.statSync(path.join(dir, f)).mtimeMs; } catch (e2) { at = 0; } }
    return { f: f, at: at };
  }).sort(function (a, b) { return (a.at - b.at) || (a.f < b.f ? -1 : (a.f > b.f ? 1 : 0)); });
  const toRemove = stamped.length - cap;
  let removed = 0;
  for (let i = 0; i < toRemove; i++) { try { fs.rmSync(path.join(dir, stamped[i].f), { force: true }); removed++; } catch (e) { /* ignore */ } }
  return removed;
}

// cacheGet(ctx, {model, prompt}, opts) -> hit | null. Respects opts.ttlMs
// (default 24h) measured against ctx.now(). A model/hash mismatch (tamper or the
// vanishingly unlikely collision) is treated as a miss.
function cacheGet(ctx, sel, opts) {
  sel = sel || {}; opts = opts || {};
  const model = sel.model, prompt = sel.prompt;
  if (!isValidModel(model) || typeof prompt !== 'string' || !prompt.length) return null;
  const hash = cacheKey(model, prompt);
  let entry;
  try { entry = JSON.parse(fs.readFileSync(path.join(cacheDir(ctx), hash + '.json'), 'utf8')); } catch (e) { return null; }
  if (!entry || typeof entry !== 'object' || entry.model !== model || entry.promptHash !== hash) return null;
  const ttl = (typeof opts.ttlMs === 'number' && opts.ttlMs >= 0) ? opts.ttlMs : DAY_MS;
  const at = Date.parse(entry.at);
  const now = nowMs(ctx, opts);
  if (!isNaN(at) && (now - at) > ttl) return null; // expired
  return { model: entry.model, promptHash: entry.promptHash, response: typeof entry.response === 'string' ? entry.response : '', at: entry.at, ageMs: isNaN(at) ? null : (now - at) };
}

// cachePut(ctx, {model, prompt, response}, opts). Stores model + key-hash +
// secret-stripped response + timestamp. Never stores the raw prompt. Evicts to cap.
function cachePut(ctx, sel, opts) {
  sel = sel || {}; opts = opts || {};
  const model = sel.model, prompt = sel.prompt;
  if (!isValidModel(model)) throw new Error('cachePut requires a valid model');
  if (typeof prompt !== 'string' || !prompt.length) throw new Error('cachePut requires a non-empty prompt');
  const response = stripSecretText(sel.response);
  const dir = cacheDir(ctx);
  fs.mkdirSync(dir, { recursive: true });
  const hash = cacheKey(model, prompt);
  const at = nowIso(ctx, opts);
  atomicWrite(path.join(dir, hash + '.json'), JSON.stringify({ model: model, promptHash: hash, response: response, at: at }, null, 2), 0o600);
  const evicted = evict(ctx, opts);
  return { model: model, promptHash: hash, at: at, bytes: Buffer.byteLength(response), evicted: evicted };
}

// cachePurge(ctx, {olderThanMs?}, opts) -> { removed }. No olderThanMs = purge all.
function cachePurge(ctx, sel, opts) {
  sel = sel || {}; opts = opts || {};
  const dir = cacheDir(ctx);
  const files = listCacheFiles(ctx);
  const now = nowMs(ctx, opts);
  const older = (typeof sel.olderThanMs === 'number' && sel.olderThanMs >= 0) ? sel.olderThanMs : null;
  let removed = 0;
  files.forEach(function (f) {
    if (older == null) { try { fs.rmSync(path.join(dir, f), { force: true }); removed++; } catch (e) { /* ignore */ } return; }
    const e = readEntryFile(ctx, f);
    let at = (e && e.at) ? Date.parse(e.at) : NaN;
    if (isNaN(at)) { try { at = fs.statSync(path.join(dir, f)).mtimeMs; } catch (e2) { at = 0; } }
    if ((now - at) > older) { try { fs.rmSync(path.join(dir, f), { force: true }); removed++; } catch (e2) { /* ignore */ } }
  });
  return { removed: removed };
}

// Read-only cache overview for `cache status` / its MCP tool.
function cacheStatus(ctx) {
  const dir = cacheDir(ctx);
  const files = listCacheFiles(ctx);
  let bytes = 0, oldest = null, newest = null;
  files.forEach(function (f) {
    let st; try { st = fs.statSync(path.join(dir, f)); } catch (e) { return; }
    bytes += st.size;
    const e = readEntryFile(ctx, f);
    const at = (e && e.at) ? e.at : null;
    if (at) { if (!oldest || at < oldest) oldest = at; if (!newest || at > newest) newest = at; }
  });
  return { dir: dir, count: files.length, bytes: bytes, cap: MAX_CACHE_FILES, oldest: oldest, newest: newest };
}

export { // routing
  routerPath, get, route, setRoute, clearRoute, setArbitrage, isValidModel, servedModels, providerServes, costHintOf, // cache
  cacheDir, cacheKey, cacheFile, cacheGet, cachePut, cachePurge, cacheStatus, stripSecretText, DAY_MS, MAX_CACHE_FILES };