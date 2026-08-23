// SPEND/QUOTA BUDGETS: per-account usage ceilings with breach / near-breach alerts.
// You set a % ceiling on the 5-hour and/or 7-day rate-limit windows — per account,
// or a '*' default that covers every account — and evaluate() reads keyflip's usage
// CACHE (<configDir>/.usage-cache.json, populated by the usage module / `keyflip
// list --usage`; this module NEVER fetches) and flags any account+window at/over
// its ceiling ('breach') or within WARN_MARGIN of it ('warn'). No network, no
// secrets: ceilings are plain numbers in <configDir>/budget.json (0600).
import fs from 'fs';
import path from 'path';
import * as profiles from './profiles.js';
import { atomicWrite, readJsonForWrite } from './fsutil.js';

const WARN_MARGIN = 10;    // pct below the ceiling at which we raise a 'warn'
const DEFAULT_KEY = '*';   // the catch-all defaults entry (applies to every account)
// The two rate-limit windows the usage cache exposes. `limitKey` is how each ceiling
// is stored in budget.json; `metric` is how usage.js names the window in the cache.
const METRICS = [
  { metric: 'fiveHour', limitKey: 'fiveHourPct' },
  { metric: 'sevenDay', limitKey: 'sevenDayPct' },
];

function budgetPath(ctx) { return path.join(ctx.configDir, 'budget.json'); }
function cachePath(ctx) { return path.join(ctx.configDir, '.usage-cache.json'); }

// A ceiling is a finite percentage in [0,100]. NaN/Infinity/string/negative/>100
// are not usable limits.
function validPct(n) { return typeof n === 'number' && isFinite(n) && n >= 0 && n <= 100; }

// A budget key is the '*' defaults sentinel or a real, safe account name.
// profiles.isValidName rejects '__proto__'/'constructor'/'prototype' + reserved
// state files, so a hostile key can never pollute a prototype or shadow our files.
function validKey(name) { return name === DEFAULT_KEY || profiles.isValidName(name); }

// Copy one raw entry into a clean null-proto {fiveHourPct?, sevenDayPct?} keeping
// only valid pcts.
function cleanEntry(raw) {
  const out = Object.create(null);
  if (!raw || typeof raw !== 'object') return out;
  METRICS.forEach(function (m) { if (validPct(raw[m.limitKey])) out[m.limitKey] = raw[m.limitKey]; });
  return out;
}

// Parse an arbitrary value into a null-prototype { key -> {limits} } map, dropping
// unsafe keys, junk values and empty entries. Prototype-pollution-safe
// (Object.create(null) + own-key iteration + a key allow-list), so a tampered
// budget.json can never poison a lookup.
function sanitize(parsed) {
  const out = Object.create(null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  Object.keys(parsed).forEach(function (k) {
    if (!validKey(k)) return;
    const e = cleanEntry(parsed[k]);
    if (Object.keys(e).length) out[k] = e; // drop entries with no usable ceiling
  });
  return out;
}

// Read for display/evaluation: TOLERANT — a missing OR corrupt file reads as empty
// (a read-only command must never throw over a garbage state file).
function readSafe(ctx) {
  try { return sanitize(JSON.parse(fs.readFileSync(budgetPath(ctx), 'utf8'))); }
  catch (e) { return Object.create(null); }
}

// get(ctx) -> the whole config (null-proto): { <name>: {limits}, '*': {defaults} }.
function get(ctx) { return readSafe(ctx); }

// Effective ceilings for one account = the '*' defaults with the account's own
// entry layered on top (per-metric override). Returns a null-proto {limits}.
function mergeLimits(cfg, name) {
  const out = Object.create(null);
  [cfg[DEFAULT_KEY], cfg[name]].forEach(function (src) {
    if (src) METRICS.forEach(function (m) { if (validPct(src[m.limitKey])) out[m.limitKey] = src[m.limitKey]; });
  });
  return out;
}
// Public: effective ceilings for one account, read fresh from disk.
function limitsFor(ctx, name) { return mergeLimits(readSafe(ctx), name); }

function persist(ctx, cfg) { atomicWrite(budgetPath(ctx), JSON.stringify(cfg, null, 2), 0o600); }

// setLimit(ctx, name, limits) — set/merge ceilings for one account (or '*' for the
// defaults). limits = { fiveHourPct, sevenDayPct }: a number sets that window, null
// deletes it, undefined leaves it. At least one must be provided. Returns the
// resulting entry (or null if it ended up empty).
function setLimit(ctx, name, limits) {
  if (!validKey(name)) throw new Error("invalid account name: '" + name + "'");
  limits = limits || {};
  // Validate every PROVIDED value up front so we reject before touching disk.
  METRICS.forEach(function (m) {
    const v = limits[m.limitKey];
    if (v !== undefined && v !== null && !validPct(v)) throw new Error(m.limitKey + ' must be a number 0-100');
  });
  const provided = METRICS.some(function (m) { return limits[m.limitKey] !== undefined; });
  if (!provided) throw new Error('nothing to set — give a 5h and/or 7d ceiling');
  // read-modify-write via readJsonForWrite so a CORRUPT file THROWS (never clobbered).
  const cfg = sanitize(readJsonForWrite(budgetPath(ctx)));
  const entry = cfg[name] || Object.create(null);
  METRICS.forEach(function (m) {
    const v = limits[m.limitKey];
    if (v === null) delete entry[m.limitKey];
    else if (v !== undefined) entry[m.limitKey] = v;
  });
  if (Object.keys(entry).length) cfg[name] = entry; else delete cfg[name];
  persist(ctx, cfg);
  return cfg[name] ? Object.assign({}, cfg[name]) : null;
}

// clear(ctx, name) — drop all ceilings for one account (or the '*' defaults).
// Returns true if an entry existed. Corrupt file THROWS (never clobbered).
function clear(ctx, name) {
  if (!validKey(name)) throw new Error("invalid account name: '" + name + "'");
  const cfg = sanitize(readJsonForWrite(budgetPath(ctx)));
  if (!(name in cfg)) return false;
  delete cfg[name];
  persist(ctx, cfg);
  return true;
}

// Read the usage cache. We only READ it — the usage module owns writing it.
// Null-proto + shape-guarded so a tampered cache can't pollute anything.
// Per-entry shape: { usage: { fiveHour:{pct}, sevenDay:{pct} } }.
function readUsageCache(ctx) {
  const out = Object.create(null);
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(ctx), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      Object.keys(parsed).forEach(function (name) {
        const e = parsed[name];
        if (e && typeof e === 'object') out[name] = e;
      });
    }
  } catch (e) { /* missing / corrupt -> no usage known */ }
  return out;
}

// Current pct for one window from a cache entry, or null if unknown.
function pctOf(entry, metric) {
  const w = entry && entry.usage && entry.usage[metric];
  return (w && typeof w.pct === 'number' && isFinite(w.pct)) ? w.pct : null;
}

// The accounts to evaluate: every explicitly-configured one, plus (when a '*'
// default exists) every account we hold cached usage for. Returns a null-proto set.
function candidateNames(cfg, cache) {
  const names = Object.create(null);
  Object.keys(cfg).forEach(function (k) { if (k !== DEFAULT_KEY) names[k] = true; });
  if (cfg[DEFAULT_KEY]) Object.keys(cache).forEach(function (k) { if (validKey(k) && k !== DEFAULT_KEY) names[k] = true; });
  return names;
}

// evaluate(ctx) -> alert rows for every configured account/window whose CURRENT
// cached usage is at/over its ceiling (breached:true, level:'breach') or within
// WARN_MARGIN of it (breached:false, level:'warn'). Reads the usage cache; NEVER
// fetches. Accounts with no configured ceiling, or no cached usage, yield nothing.
// Row: { name, metric, pct, limit, breached, level }. Breaches first, then pct desc.
function evaluate(ctx) {
  const cfg = readSafe(ctx);
  const cache = readUsageCache(ctx);
  const names = candidateNames(cfg, cache);
  const out = [];
  Object.keys(names).forEach(function (name) {
    const limits = mergeLimits(cfg, name);
    const entry = cache[name];
    METRICS.forEach(function (m) {
      const limit = limits[m.limitKey];
      if (!validPct(limit)) return;          // no ceiling for this window
      const pct = pctOf(entry, m.metric);
      if (pct === null) return;              // no usage sample -> can't judge
      if (pct >= limit) out.push({ name: name, metric: m.metric, pct: pct, limit: limit, breached: true, level: 'breach' });
      else if (pct >= limit - WARN_MARGIN) out.push({ name: name, metric: m.metric, pct: pct, limit: limit, breached: false, level: 'warn' });
    });
  });
  out.sort(function (a, b) {
    if (a.breached !== b.breached) return a.breached ? -1 : 1;
    if (b.pct !== a.pct) return b.pct - a.pct;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });
  return out;
}

// status(ctx) -> a combined snapshot of ceilings + current usage. One row per
// account that has an effective ceiling: its effective limits, its current cached
// usage (null when unknown) and its alerts. Plus the raw defaults and the flat
// alert list (same rows as evaluate) for convenience.
function status(ctx) {
  const cfg = readSafe(ctx);
  const cache = readUsageCache(ctx);
  const alerts = evaluate(ctx);
  const byName = Object.create(null);
  alerts.forEach(function (a) { (byName[a.name] || (byName[a.name] = [])).push(a); });
  const names = candidateNames(cfg, cache);
  const accounts = Object.keys(names).sort().map(function (name) {
    const limits = mergeLimits(cfg, name);
    const entry = cache[name];
    return {
      name: name,
      limits: {
        fiveHourPct: validPct(limits.fiveHourPct) ? limits.fiveHourPct : null,
        sevenDayPct: validPct(limits.sevenDayPct) ? limits.sevenDayPct : null,
      },
      usage: { fiveHour: pctOf(entry, 'fiveHour'), sevenDay: pctOf(entry, 'sevenDay') },
      alerts: byName[name] || [],
    };
  });
  const def = cfg[DEFAULT_KEY];
  return {
    defaults: def ? {
      fiveHourPct: validPct(def.fiveHourPct) ? def.fiveHourPct : null,
      sevenDayPct: validPct(def.sevenDayPct) ? def.sevenDayPct : null,
    } : null,
    accounts: accounts,
    alerts: alerts,
    breached: alerts.some(function (a) { return a.breached; }),
  };
}

export { get, setLimit, clear, evaluate, status, limitsFor, budgetPath, WARN_MARGIN, DEFAULT_KEY };