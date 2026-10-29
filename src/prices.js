// LIVE PRICE TABLE. cost.js ships a dated bundled snapshot; this module lets
// that snapshot update ITSELF from LiteLLM's public price list instead of being
// hand-edited. The fetched table is normalized to keyflip's row shape and cached
// at <configDir>/prices-cache.json; cost.js reads it as an overlay whose rows win
// over the bundled ones per model id (bundled rows stay as the floor).
//
// Trust model:
//   * The network runs ONLY on an explicit refresh (keyflip cost prices --refresh).
//     Every other command reads the cache -- no request is ever made implicitly.
//   * The cache is UNTRUSTED input (it is a file an agent can write): fixed JSON
//     shape, bounded size/row count, printable model ids, finite rates in range.
//     A corrupt cache is ignored whole, never half-applied.
//   * A SHA-256 pin is honored only when it comes from the user (--pin) or the
//     config (cost.pricesSha256). We never pin what we fetched ourselves: no TOFU.
//   * A pinned mismatch refuses the write and keeps the previous cache.
//   * No credentials: the URL is a public static file.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { atomicWrite } from './fsutil.js';
import { PRICING, PRICING_AS_OF, LONG_CONTEXT_THRESHOLD, normalizeModel } from './cost.js';

const CACHE_FILE = 'prices-cache.json';
const SCHEMA_VERSION = 1;
// LiteLLM's list is ~1.5 MB today; allow headroom but never a multi-MB body.
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 4000;
const MAX_RATE = 10000; // $/MTok -- nothing real is within two zeros of this
const MIN_ROWS = 5; // fewer usable rows than this is not a price table
const MIN_CACHE_ROWS = 1; // a cached table needs at least one sane row to be usable
const DEFAULT_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

function cachePath(ctx) {
  return path.join(ctx.configDir, CACHE_FILE);
}

// Sha-256 pins are 64 hex chars; "sha256:" and case are tolerated, anything
// else is a malformed pin (callers fail CLOSED on that).
function normalizePin(pin) {
  if (pin === undefined || pin === null || pin === '') return null;
  const s = String(pin)
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, '');
  return /^[a-f0-9]{64}$/.test(s) ? s : '';
}

function isRate(x) {
  return typeof x === 'number' && isFinite(x) && x > 0 && x <= MAX_RATE;
}

// LiteLLM charges per TOKEN; keyflip's table is per MTok with 6 decimals.
function perMTok(perToken) {
  return Math.round(perToken * 1e12) / 1e6;
}

// A bundled row for this id (exact, then date-stripped) so a refreshed row
// keeps the capability flags (long-context premium, fast mode) keyflip knows
// about. Unknown models infer only what the upstream data proves.
function bundledRow(id) {
  if (Object.prototype.hasOwnProperty.call(PRICING, id)) return PRICING[id];
  const s = id.replace(/-\d{8}.*$/, '');
  if (s !== id && Object.prototype.hasOwnProperty.call(PRICING, s)) return PRICING[s];
  return null;
}

// Turn LiteLLM's full multi-provider file into keyflip rows for Claude models.
// Returns { rows, kept, skipped } and never throws on odd input; ids are
// normalized with the SAME function cost.js uses, so lookups agree.
function buildRows(raw) {
  const rows = Object.create(null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { rows: rows, kept: 0, skipped: 0 };
  const keys = Object.keys(raw).sort(); // deterministic: first mapping of an id wins
  let skipped = 0;
  keys.forEach(function (key) {
    const v = raw[key];
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      skipped++;
      return;
    }
    if (key === 'sample_spec' || key.indexOf('/') !== -1) {
      skipped++;
      return;
    }
    const provider = typeof v.litellm_provider === 'string' ? v.litellm_provider.toLowerCase() : '';
    if (provider && provider !== 'anthropic') {
      skipped++;
      return;
    }
    if (v.mode && v.mode !== 'chat' && v.mode !== 'completion') {
      skipped++;
      return;
    }
    const id = normalizeModel(key);
    if (!id || /^(__proto__|constructor|prototype)$/.test(id)) {
      skipped++;
      return;
    }
    const input = perMTok(v.input_cost_per_token);
    const output = perMTok(v.output_cost_per_token);
    if (!isRate(input) || !isRate(output)) {
      skipped++;
      return;
    }
    if (Object.prototype.hasOwnProperty.call(rows, id)) {
      skipped++;
      return;
    }
    if (Object.keys(rows).length >= MAX_ROWS) {
      skipped++;
      return;
    }
    const known = bundledRow(id);
    const maxIn = typeof v.max_input_tokens === 'number' ? v.max_input_tokens : 0;
    rows[id] = {
      inputPerMTok: input,
      outputPerMTok: output,
      // An upstream model advertising a >200K window bills the long-context
      // premium; fast mode is never inferred from upstream data.
      longContext: known ? !!known.longContext : maxIn > LONG_CONTEXT_THRESHOLD,
      fast: known ? !!known.fast : false,
    };
  });
  return { rows: rows, kept: Object.keys(rows).length, skipped: skipped };
}

// Validate a parsed cache file. Returns a normalized snapshot or null; the
// file is either good enough to use whole or discarded whole.
function validate(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (obj.schemaVersion !== SCHEMA_VERSION) return null;
  if (typeof obj.digest !== 'string' || !/^[a-f0-9]{64}$/.test(obj.digest)) return null;
  if (typeof obj.fetchedAt !== 'string' || isNaN(Date.parse(obj.fetchedAt))) return null;
  if (!obj.rows || typeof obj.rows !== 'object' || Array.isArray(obj.rows)) return null;
  const rows = Object.create(null);
  let kept = 0;
  Object.keys(obj.rows).forEach(function (id) {
    if (kept >= MAX_ROWS) return;
    const r = obj.rows[id];
    if (!r || typeof r !== 'object' || Array.isArray(r)) return;
    if (!/^[a-z0-9._@-]{1,100}$/.test(id)) return;
    if (!isRate(r.inputPerMTok) || !isRate(r.outputPerMTok)) return;
    rows[id] = {
      inputPerMTok: r.inputPerMTok,
      outputPerMTok: r.outputPerMTok,
      longContext: r.longContext === true,
      fast: r.fast === true,
    };
    kept++;
  });
  if (kept < MIN_CACHE_ROWS) return null;
  return {
    schemaVersion: SCHEMA_VERSION,
    source: typeof obj.source === 'string' ? obj.source.slice(0, 60) : 'litellm',
    url: typeof obj.url === 'string' ? obj.url.slice(0, 300) : DEFAULT_URL,
    fetchedAt: obj.fetchedAt,
    digest: obj.digest,
    rows: rows,
  };
}

// read(ctx) -> validated cache snapshot or null (missing, oversized, corrupt).
function read(ctx) {
  const file = cachePath(ctx);
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_CACHE_BYTES) return null;
    return validate(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    return null;
  }
}

// Hot-reload memo: the proxy prices every request, but re-validating an
// unchanged file each time would be wasteful. Keyed on path + mtime + size.
const _memo = new Map();
function overlay(ctx) {
  if (!ctx || !ctx.configDir) return null;
  const file = cachePath(ctx);
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    _memo.delete(file);
    return null;
  }
  const stamp = st.mtimeMs + ':' + st.size;
  const hit = _memo.get(file);
  if (hit && hit.stamp === stamp) return hit.rows;
  const c = read(ctx);
  const rows = c ? c.rows : null;
  _memo.set(file, { stamp: stamp, rows: rows });
  return rows;
}

// describe(ctx, { pin, now }) -> what the cost engine is actually using.
function describe(ctx, opts) {
  opts = opts || {};
  const now = opts.now instanceof Date ? opts.now : new Date();
  const pin = normalizePin(opts.pin);
  const cache = read(ctx);
  const bundled = Object.keys(PRICING).length;
  let shadowed = 0;
  let added = 0;
  if (cache) {
    Object.keys(cache.rows).forEach(function (id) {
      if (Object.prototype.hasOwnProperty.call(PRICING, id)) shadowed++;
      else added++;
    });
  }
  return {
    source: cache ? 'cache' : 'bundled',
    bundledAsOf: PRICING_AS_OF,
    bundledModels: bundled,
    url: cache ? cache.url : opts.url || DEFAULT_URL,
    fetchedAt: cache ? cache.fetchedAt : null,
    digest: cache ? cache.digest : null,
    models: cache ? Object.keys(cache.rows).length : 0,
    shadowed: shadowed,
    added: added,
    ageHours: cache ? Math.max(0, Math.round((now - new Date(cache.fetchedAt)) / 3600000)) : null,
    pin: pin || null,
    pinMatches: pin && cache ? pin === cache.digest : null,
  };
}

// refresh(ctx, opts) -> { ok, error?, ...describe, added, changed, removed }.
// opts = { url, pin, fetch, timeoutMs, now }. Writes only after every check
// passes; a failed refresh leaves the previous cache untouched.
async function refresh(ctx, opts) {
  opts = opts || {};
  const now = opts.now instanceof Date ? opts.now : new Date();
  const url = opts.url || DEFAULT_URL;
  const pin = normalizePin(opts.pin);
  if (pin === '') return { ok: false, error: 'pin must be a 64-character sha-256 hex digest' };
  const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) return { ok: false, error: 'fetch unavailable in this runtime' };

  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'price URL must be http(s)' };
  let res;
  try {
    res = await doFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'follow',
      signal:
        typeof AbortSignal !== 'undefined' && AbortSignal.timeout
          ? AbortSignal.timeout(opts.timeoutMs || 20000)
          : undefined,
    });
  } catch (e) {
    return { ok: false, error: 'network error: ' + ((e && e.message) || 'fetch failed') };
  }
  if (!res || typeof res.text !== 'function') return { ok: false, error: 'unexpected fetch response' };
  if (!res.ok) return { ok: false, status: res.status, error: 'http ' + res.status };
  const declared = Number(res.headers && res.headers.get ? res.headers.get('content-length') : NaN);
  if (isFinite(declared) && declared > MAX_BYTES) {
    return { ok: false, error: 'response too large (' + declared + ' bytes, cap ' + MAX_BYTES + ')' };
  }
  let text;
  try {
    text = await res.text();
  } catch (e) {
    return { ok: false, error: 'could not read the response body' };
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
    return { ok: false, error: 'response too large (cap ' + MAX_BYTES + ' bytes)' };
  }
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  if (pin && pin !== digest) {
    return { ok: false, error: 'sha-256 mismatch: fetched ' + digest + ', pin ' + pin, digest: digest };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: 'the response is not JSON' };
  }
  const built = buildRows(raw);
  if (built.kept < MIN_ROWS) {
    return { ok: false, error: 'not a price table: ' + built.kept + ' usable Claude rows (need ' + MIN_ROWS + ')' };
  }
  const prev = read(ctx);
  const prevRows = prev ? prev.rows : null;
  let added = 0,
    changed = 0,
    removed = 0;
  Object.keys(built.rows).forEach(function (id) {
    const before = prevRows ? prevRows[id] : null;
    if (!before) added++;
    else if (
      before.inputPerMTok !== built.rows[id].inputPerMTok ||
      before.outputPerMTok !== built.rows[id].outputPerMTok
    )
      changed++;
  });
  if (prevRows) {
    Object.keys(prevRows).forEach(function (id) {
      if (!Object.prototype.hasOwnProperty.call(built.rows, id)) removed++;
    });
  }
  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    source: 'litellm',
    url: url,
    fetchedAt: now.toISOString(),
    digest: digest,
    rows: built.rows,
  };
  try {
    atomicWrite(cachePath(ctx), JSON.stringify(snapshot, null, 2) + '\n', 0o600);
  } catch (e) {
    return { ok: false, error: 'could not write the price cache: ' + ((e && e.message) || 'write failed') };
  }
  const result = describe(ctx, { pin: pin, now: now });
  result.ok = true;
  // Counters against the PREVIOUS cache (describe()'s added/shadowed count
  // against the bundled table, so the two never shadow each other).
  result.newModels = added;
  result.repriced = changed;
  result.dropped = removed;
  result.skipped = built.skipped;
  return result;
}

// clear(ctx) -> true when a cache file was removed.
function clear(ctx) {
  try {
    fs.rmSync(cachePath(ctx), { force: true });
    _memo.delete(cachePath(ctx));
    return true;
  } catch (e) {
    return false;
  }
}

export {
  CACHE_FILE,
  SCHEMA_VERSION,
  MAX_BYTES,
  MAX_CACHE_BYTES,
  MAX_ROWS,
  MIN_ROWS,
  MIN_CACHE_ROWS,
  DEFAULT_URL,
  cachePath,
  normalizePin,
  buildRows,
  read,
  overlay,
  describe,
  refresh,
  clear,
};
