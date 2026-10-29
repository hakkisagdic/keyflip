// COST / SPEND INTELLIGENCE. A dated static pricing table + read-only spend
// reporting. estimateCost/priceFor are pure; unified aggregates per-account
// utilization from <configDir>/.usage-cache.json (pct-based -- the OAuth usage
// API never returns per-token spend, so we report what IS known and never
// fabricate a dollar figure); predict projects time-to-limit from the usage
// trend log; attribute measures per-cwd/repo token+cost by scanning
// ~/.claude/projects transcripts. Nothing here writes state or hits the network.
import fs from 'fs';
import path from 'path';
import * as _sessions from './sessions.js';
import * as _transcript from './transcript.js';
import * as _history from './history.js';

// ---------------------------------------------------------------------------
// PRICING SNAPSHOT -- USD per 1,000,000 tokens (input / output). This is a
// hand-maintained mid-2026 snapshot; list prices DRIFT (models launch, intro
// pricing lapses, tiers change), so treat every dollar figure as an ESTIMATE
// and re-check platform.claude.com/docs/en/pricing periodically.
//   * Current-gen rows are the authoritative table cached in the claude-api
//     skill (as-of below). Legacy rows are best-known historical list prices,
//     kept so old transcripts still cost out instead of hitting the fallback.
//   * Sonnet 5 has an intro rate ($2/$10 through 2026-08-31); we price at the
//     STANDARD $3/$15 so estimates never understate steady-state spend.
// ---------------------------------------------------------------------------
const PRICING_AS_OF = '2026-06-24';
// Rows may carry two capability flags (see the rate card below):
//   longContext: the model bills a PREMIUM once the request's input (fresh +
//                cache) passes 200K tokens — 2x input, 1.5x output today.
//   fast:        the model offers fast mode, billed at a flat 6x multiplier.
// Legacy rows carry neither: a retired model is priced at its plain list rate.
const PRICING = Object.freeze({
  // --- current generation (authoritative) ---
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50, longContext: true, fast: true },
  'claude-mythos-5': { inputPerMTok: 10, outputPerMTok: 50, longContext: true, fast: true },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25, longContext: true, fast: true },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25, longContext: true, fast: true },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25, longContext: true, fast: true },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15, longContext: true },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15, longContext: true },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  // --- legacy (still active or recently retired) -- historical list prices ---
  'claude-opus-4-5': { inputPerMTok: 5, outputPerMTok: 25, longContext: true },
  'claude-opus-4-1': { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-opus-4-0': { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15, longContext: true },
  'claude-sonnet-4-0': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-3-opus': { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-3-5-haiku': { inputPerMTok: 0.8, outputPerMTok: 4 },
  'claude-3-haiku': { inputPerMTok: 0.25, outputPerMTok: 1.25 },
});
// Unknown model -> Opus-tier default. Conservative (not the cheapest), and
// always flagged fallback:true so callers can label the estimate as a guess.
// Both premium capabilities are assumed so an unknown model is never understated.
const FALLBACK_PRICE = Object.freeze({
  inputPerMTok: 5,
  outputPerMTok: 25,
  longContext: true,
  fast: true,
});

// Cache-token economics, relative to the model's INPUT rate (see the prompt-
// caching docs): reads bill ~0.1x, 5-minute writes ~1.25x, 1-hour writes ~2x.
// Applied on top of the same input $/MTok so cache tokens are costed without a
// second table.
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25; // 5-minute writes (the long-standing default)
const CACHE_WRITE_1H_MULT = 2;

// Long-context premium: a request whose total input passes 200K tokens bills a
// higher rate for the WHOLE request (not just the excess): 2x input, 1.5x
// output on models that support the 1M-context beta.
const LONG_CONTEXT_THRESHOLD = 200000;
const LONG_CONTEXT_INPUT_MULT = 2;
const LONG_CONTEXT_OUTPUT_MULT = 1.5;

// Fast mode is a flat 6x on every rate of the request.
const FAST_MULT = 6;

// ---- pricing lookup --------------------------------------------------------

// Strip provider/region prefixes and version suffixes so a Bedrock/Vertex/dated
// id resolves to a base model. Keeps only the printable id chars a-z0-9._@- so
// no control char (a hostile transcript's model field) reaches a lookup or a
// terminal, and hyphens/dots are preserved.
function normalizeModel(model) {
  let s = String(model == null ? '' : model)
    .toLowerCase()
    .replace(/[^a-z0-9._@-]/g, '');
  if (!s) return '';
  s = s.slice(0, 100);
  s = s.split('@')[0]; // Vertex "@version"
  s = s.replace(/^[a-z]+\./, ''); // region prefix (us./eu./apac.)
  s = s.replace(/^anthropic\./, ''); // Bedrock provider prefix
  return s;
}
function lookup(id) {
  return Object.prototype.hasOwnProperty.call(PRICING, id) ? PRICING[id] : null;
}

// priceFor(model) -> { id, inputPerMTok, outputPerMTok, fallback }. fallback is
// true when the model wasn't in the table and default rates were used.
function priceFor(model) {
  const norm = normalizeModel(model);
  let id = norm;
  let hit = lookup(id);
  if (!hit) {
    const s = id.replace(/-\d{8}$/, '');
    if (s !== id && (hit = lookup(s))) id = s;
  } // trailing -YYYYMMDD
  if (!hit) {
    const s = id.replace(/-(fast|latest)$/, '');
    if (s !== id && (hit = lookup(s))) id = s;
  } // -fast / -latest
  if (hit) return { id: id, inputPerMTok: hit.inputPerMTok, outputPerMTok: hit.outputPerMTok, fallback: false };
  return {
    id: norm || null,
    inputPerMTok: FALLBACK_PRICE.inputPerMTok,
    outputPerMTok: FALLBACK_PRICE.outputPerMTok,
    fallback: true,
  };
}

function num(x) {
  return typeof x === 'number' && isFinite(x) && x >= 0 ? x : 0;
}

// rateCard(model) -> the BILLABLE rate card behind a model, on top of the
// stable 4-field priceFor() shape: cache multipliers, the long-context premium
// (null when the model has no 200K+ tier) and the fast-mode multiplier (null
// when the model has no fast mode). Unknown models inherit the fallback card,
// which assumes BOTH premiums so an estimate is never understated.
function rateCard(model) {
  const p = priceFor(model);
  const row = lookup(p.id) || FALLBACK_PRICE;
  return {
    id: p.id,
    inputPerMTok: p.inputPerMTok,
    outputPerMTok: p.outputPerMTok,
    fallback: p.fallback,
    cache: { read: CACHE_READ_MULT, write5m: CACHE_WRITE_MULT, write1h: CACHE_WRITE_1H_MULT },
    longContext: row.longContext
      ? {
          threshold: LONG_CONTEXT_THRESHOLD,
          inputMult: LONG_CONTEXT_INPUT_MULT,
          outputMult: LONG_CONTEXT_OUTPUT_MULT,
        }
      : null,
    fast: row.fast ? FAST_MULT : null,
  };
}

// costBreakdown(opts) -> itemized USD for ONE request (or one metered
// transcript line):
//   { model, id, fallback, tokens, rates, longContext, fast, usd, totalUSD }
// opts = { model, inputTokens, outputTokens [, cacheReadTokens,
//          cacheCreationTokens (5-minute writes), cacheCreation1hTokens,
//          fast, longContext] }.
//   * fast defaults to true when the model id carries a -fast suffix (a
//     caller that read the response's speed reports it explicitly instead).
//   * longContext defaults to "prompt tokens passed the model's threshold";
//     the premium bills the WHOLE request, and cached tokens are input tokens
//     on the invoice, so they count toward the threshold and are uprated too.
//   * Pass longContext:false for an AGGREGATE figure (a month of usage is not
//     one request) -- unified() does exactly that.
function costBreakdown(opts) {
  opts = opts || {};
  const card = rateCard(opts.model);
  const input = num(opts.inputTokens);
  const output = num(opts.outputTokens);
  const cacheRead = num(opts.cacheReadTokens);
  const cacheWrite = num(opts.cacheCreationTokens);
  const cacheWrite1h = num(opts.cacheCreation1hTokens);
  const promptTokens = input + cacheRead + cacheWrite + cacheWrite1h;
  const fast = opts.fast === undefined || opts.fast === null ? /-fast$/.test(normalizeModel(opts.model)) : !!opts.fast;
  const lcOn = !!(
    card.longContext &&
    (opts.longContext === undefined || opts.longContext === null
      ? promptTokens > card.longContext.threshold
      : opts.longContext)
  );
  const lcIn = lcOn ? card.longContext.inputMult : 1;
  const lcOut = lcOn ? card.longContext.outputMult : 1;
  const fastMult = fast ? FAST_MULT : 1;
  const rates = {
    input: card.inputPerMTok * lcIn * fastMult,
    output: card.outputPerMTok * lcOut * fastMult,
    cacheRead: card.inputPerMTok * CACHE_READ_MULT * lcIn * fastMult,
    cacheWrite: card.inputPerMTok * CACHE_WRITE_MULT * lcIn * fastMult,
    cacheWrite1h: card.inputPerMTok * CACHE_WRITE_1H_MULT * lcIn * fastMult,
  };
  const usd = {
    input: (input / 1e6) * rates.input,
    output: (output / 1e6) * rates.output,
    cacheRead: (cacheRead / 1e6) * rates.cacheRead,
    cacheWrite: (cacheWrite / 1e6) * rates.cacheWrite,
    cacheWrite1h: (cacheWrite1h / 1e6) * rates.cacheWrite1h,
  };
  return {
    model: normalizeModel(opts.model) || null,
    id: card.id,
    fallback: card.fallback,
    tokens: {
      input: input,
      output: output,
      cacheRead: cacheRead,
      cacheCreation: cacheWrite,
      cacheCreation1h: cacheWrite1h,
      total: input + output + cacheRead + cacheWrite + cacheWrite1h,
    },
    rates: rates,
    longContext: {
      supported: !!card.longContext,
      applied: lcOn,
      threshold: card.longContext ? card.longContext.threshold : null,
      inputMult: lcIn,
      outputMult: lcOut,
    },
    fast: { supported: card.fast !== null, applied: fast, mult: fastMult },
    usd: usd,
    totalUSD: usd.input + usd.output + usd.cacheRead + usd.cacheWrite + usd.cacheWrite1h,
  };
}

// estimateCost({model, inputTokens, outputTokens[, cacheReadTokens,
// cacheCreationTokens, cacheCreation1hTokens, fast, longContext]}) -> USD
// number. Cache/latency fields are optional (default 0 / inferred), so the
// required {model,inputTokens,outputTokens} shape works unchanged.
function estimateCost(opts) {
  return costBreakdown(opts).totalUSD;
}

// ---- usage cache (read-only; usage.js owns writing it) ---------------------

const METRICS = [{ metric: 'fiveHour' }, { metric: 'sevenDay' }];
function usageCachePath(ctx) {
  return path.join(ctx.configDir, '.usage-cache.json');
}

// Null-proto + shape-guarded so a tampered cache (scalar JSON, a '__proto__'
// key) can never pollute a prototype or shadow a lookup.
function readUsageCache(ctx) {
  const out = Object.create(null);
  try {
    const parsed = JSON.parse(fs.readFileSync(usageCachePath(ctx), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      Object.keys(parsed).forEach(function (name) {
        const e = parsed[name];
        if (e && typeof e === 'object' && !Array.isArray(e)) out[name] = e;
      });
    }
  } catch (e) {
    /* missing / corrupt -> nothing known */
  }
  return out;
}

function pctOf(entry, metric) {
  const w = entry && entry.usage && entry.usage[metric];
  return w && typeof w.pct === 'number' && isFinite(w.pct) ? w.pct : null;
}

// Token totals are NOT part of the current usage-cache schema (the OAuth usage
// API is pct-only). Read them defensively IF a future/enriched cache carries
// them under usage.tokens or a top-level tokens object -- return null otherwise,
// so nothing is ever invented.
function tokensOf(entry) {
  const raw = (entry && entry.usage && entry.usage.tokens) || (entry && entry.tokens);
  if (!raw || typeof raw !== 'object') return null;
  const known = ['input', 'output', 'cacheRead', 'cacheCreation'].some(function (k) {
    return typeof raw[k] === 'number' && isFinite(raw[k]);
  });
  if (!known) return null;
  return {
    input: num(raw.input),
    output: num(raw.output),
    cacheRead: num(raw.cacheRead),
    cacheCreation: num(raw.cacheCreation),
    cacheCreation1h: num(raw.cacheCreation1h),
  };
}
function tokensModel(entry) {
  const m = (entry && entry.usage && entry.usage.model) || (entry && entry.model);
  return typeof m === 'string' ? m : null;
}
function avg(a) {
  return (
    a.reduce(function (s, x) {
      return s + x;
    }, 0) / a.length
  );
}

// unified(ctx, opts) -> aggregate spend/utilization across every account in the
// usage cache. Reports 5h/7d utilization always; reports token totals + costUSD
// ONLY for accounts whose cache entry actually carries token counts
// (measured:true). costUSD is null otherwise -- never a pct-derived guess.
function unified(ctx, opts) {
  opts = opts || {};
  const cache = opts.cache || readUsageCache(ctx);
  const names = Object.keys(cache).sort();
  const accounts = [];
  const totalTok = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0 };
  let anyTokens = false,
    totalCost = 0,
    costMeasured = false;
  names.forEach(function (name) {
    const e = cache[name];
    const tok = tokensOf(e);
    const row = {
      name: name,
      status: e && typeof e.status === 'string' ? e.status : null,
      fiveHourPct: pctOf(e, 'fiveHour'),
      sevenDayPct: pctOf(e, 'sevenDay'),
      tokens: tok,
      costUSD: null,
      measured: false,
    };
    if (tok) {
      anyTokens = true;
      costMeasured = true;
      // Aggregate spend: never infer a per-request long-context premium from
      // the sum (a month of small requests is not one 200K request).
      row.costUSD = estimateCost({
        model: tokensModel(e),
        inputTokens: tok.input,
        outputTokens: tok.output,
        cacheReadTokens: tok.cacheRead,
        cacheCreationTokens: tok.cacheCreation,
        cacheCreation1hTokens: tok.cacheCreation1h,
        longContext: false,
      });
      row.measured = true;
      totalTok.input += tok.input;
      totalTok.output += tok.output;
      totalTok.cacheRead += tok.cacheRead;
      totalTok.cacheCreation += tok.cacheCreation;
      totalTok.cacheCreation1h += tok.cacheCreation1h;
      totalCost += row.costUSD;
    }
    accounts.push(row);
  });
  const fives = accounts
    .map(function (a) {
      return a.fiveHourPct;
    })
    .filter(function (n) {
      return typeof n === 'number';
    });
  const sevens = accounts
    .map(function (a) {
      return a.sevenDayPct;
    })
    .filter(function (n) {
      return typeof n === 'number';
    });
  return {
    at: ctx.now(),
    source: '.usage-cache.json',
    accounts: accounts,
    totals: {
      accounts: accounts.length,
      fiveHourPctMax: fives.length ? Math.max.apply(null, fives) : null,
      fiveHourPctAvg: fives.length ? avg(fives) : null,
      sevenDayPctMax: sevens.length ? Math.max.apply(null, sevens) : null,
      sevenDayPctAvg: sevens.length ? avg(sevens) : null,
      tokens: anyTokens ? totalTok : null,
      costUSD: costMeasured ? totalCost : null,
    },
    note: 'The OAuth usage API is percentage-based: 5h/7d utilization is measured, but per-token spend is not exposed. costUSD is reported only when a cache entry carries token totals (measured:true); otherwise it is null -- never inferred from a percentage.',
  };
}

// ---- prediction ------------------------------------------------------------

// Longest trailing run of samples whose pct is non-decreasing in time order.
// Isolates the current fill-up from earlier window resets (pct dropping back).
function trailingRun(series) {
  const run = [];
  for (let i = series.length - 1; i >= 0; i--) {
    if (!run.length) {
      run.unshift(series[i]);
      continue;
    }
    if (series[i].pct <= run[0].pct) run.unshift(series[i]);
    else break;
  }
  return run;
}

function predictWindow(metric, samples, entry) {
  const series = (samples || [])
    .map(function (s) {
      return {
        t: Date.parse(s && s.at),
        pct: s && typeof s[metric] === 'number' && isFinite(s[metric]) ? s[metric] : null,
      };
    })
    .filter(function (x) {
      return !isNaN(x.t) && x.pct !== null;
    })
    .sort(function (a, b) {
      return a.t - b.t;
    });

  let cur = pctOf(entry, metric);
  if (cur === null && series.length) cur = series[series.length - 1].pct;

  const run = trailingRun(series);
  let ratePerHour = null,
    etaMinutes = null;
  if (run.length >= 2) {
    const first = run[0],
      last = run[run.length - 1];
    const hrs = (last.t - first.t) / 3600000;
    const dp = last.pct - first.pct;
    if (hrs > 0 && dp > 0) ratePerHour = dp / hrs;
  }
  if (cur !== null) {
    if (cur >= 100) etaMinutes = 0;
    else if (ratePerHour && ratePerHour > 0) etaMinutes = Math.max(0, ((100 - cur) / ratePerHour) * 60);
  }
  return { metric: metric, pct: cur, ratePerHour: ratePerHour, etaMinutes: etaMinutes, samples: run.length };
}

// predict(ctx, name, opts) -> project time-to-limit for the 5h/7d windows from
// the usage trend log. Each window: { metric, pct, ratePerHour?, etaMinutes|null,
// samples }. rate/eta are null when the trend is unknown or flat (never faked).
// opts.samples / opts.cache / opts.clock injectable for hermetic tests.
function predict(ctx, name, opts) {
  opts = opts || {};
  const nowIso = opts.clock ? opts.clock() : ctx.now();
  let samples = opts.samples;
  if (!samples) {
    try {
      samples = _history.readUsage(ctx);
    } catch (e) {
      samples = [];
    }
    samples = (samples || []).filter(function (s) {
      return s && s.account === name;
    });
  }
  const cache = opts.cache || readUsageCache(ctx);
  const entry = cache[name];
  const windows = METRICS.map(function (m) {
    return predictWindow(m.metric, samples, entry);
  });
  return { account: name, at: nowIso, windows: windows };
}

// ---- per-cwd / repo attribution -------------------------------------------

function newTok() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0, costUSD: 0 };
}
// Public view of a token bucket: counts only (no accumulator fields), with the
// cached-token split preserved and a total that includes every kind.
function tokenView(t) {
  return {
    input: t.input,
    output: t.output,
    cacheRead: t.cacheRead,
    cacheCreation: t.cacheCreation,
    cacheCreation1h: t.cacheCreation1h,
    total: t.input + t.output + t.cacheRead + t.cacheCreation + t.cacheCreation1h,
  };
}
function clampInt(v, dflt, lo, hi) {
  const n = typeof v === 'number' && isFinite(v) ? Math.floor(v) : dflt;
  return Math.max(lo, Math.min(hi, n));
}
// Strip control chars (< 0x20 and 0x7f) and cap length, WITHOUT a control-char
// regex (regex-free so no literal control byte lives in this source). Keeps
// slashes, spaces and non-ASCII so cwd paths render intact but stay safe.
function scrub(s, max) {
  s = String(s == null ? '' : s);
  const lim = max || 120;
  let out = '';
  for (let i = 0; i < s.length && out.length < lim; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c !== 0x7f) out += s[i];
  }
  return out;
}

// Read at most maxBytes from the head of a (possibly huge) transcript.
// -> { text, truncated } or null on error. A partial tail line just fails to
// parse and is skipped, so a bounded read stays JSONL-safe.
function readHead(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (e) {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const want = Math.min(size, maxBytes);
    const buf = Buffer.alloc(want);
    let read = 0;
    while (read < want) {
      const n = fs.readSync(fd, buf, read, want - read, read);
      if (n <= 0) break;
      read += n;
    }
    return { text: buf.slice(0, read).toString('utf8'), truncated: size > maxBytes };
  } catch (e) {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch (e2) {
      /* ignore */
    }
  }
}

// Split one usage object into 5-minute and 1-hour cache-write counts. The
// top-level cache_creation_input_tokens is the TOTAL; the nested ephemeral_*
// pair says how it splits, so the 1h share is never counted twice.
function cacheWrites(u) {
  const cc = u && u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  const e5 = num(cc && cc.ephemeral_5m_input_tokens);
  const e1 = num(cc && cc.ephemeral_1h_input_tokens);
  const total = num(u && u.cache_creation_input_tokens) || e5 + e1;
  const write1h = Math.min(total, e1);
  return { write5m: Math.max(0, total - write1h), write1h: write1h };
}

// Sum per-model token usage from a transcript's assistant lines into `bucket`,
// costing each LINE on its own (one line = one request), so the 200K premium
// and fast mode land on the requests that actually incurred them instead of on
// a session-wide sum.
function scanUsage(text, bucket) {
  String(text)
    .split('\n')
    .forEach(function (line) {
      if (!line.trim()) return;
      let j;
      try {
        j = JSON.parse(line);
      } catch (e) {
        return;
      }
      const m = j && j.message;
      if (!m || typeof m !== 'object') return;
      const u = m.usage;
      if (!u || typeof u !== 'object') return;
      const input = num(u.input_tokens);
      const output = num(u.output_tokens);
      const cacheRead = num(u.cache_read_input_tokens);
      const w = cacheWrites(u);
      if (!(input || output || cacheRead || w.write5m || w.write1h)) return;
      const model = scrub(m.model, 100) || 'unknown';
      const mt = bucket.models[model] || (bucket.models[model] = newTok());
      mt.input += input;
      mt.output += output;
      mt.cacheRead += cacheRead;
      mt.cacheCreation += w.write5m;
      mt.cacheCreation1h += w.write1h;
      mt.costUSD += costBreakdown({
        model: model,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: w.write5m,
        cacheCreation1hTokens: w.write1h,
        fast: u.speed === 'fast' ? true : undefined,
      }).totalUSD;
      bucket.tokens.input += input;
      bucket.tokens.output += output;
      bucket.tokens.cacheRead += cacheRead;
      bucket.tokens.cacheCreation += w.write5m;
      bucket.tokens.cacheCreation1h += w.write1h;
    });
}

// attribute(ctx, opts) -> per-cwd/repo token + cost attribution, scanning
// ~/.claude/projects via sessions.list + transcript.parse. Token counts are
// MEASURED; costUSD is an estimate from the static pricing snapshot. Work is
// capped: opts.maxSessions (default 200) and opts.maxBytesPerFile (default 8MB).
function attribute(ctx, opts) {
  opts = opts || {};
  const sessions = _sessions;
  const transcript = _transcript;
  const maxSessions = clampInt(opts.maxSessions, 200, 1, 5000);
  const maxBytes = clampInt(opts.maxBytesPerFile, 8 * 1024 * 1024, 64 * 1024, 128 * 1024 * 1024);

  let rows;
  try {
    rows = sessions.list(ctx, { limit: maxSessions });
  } catch (e) {
    rows = [];
  }

  const byCwd = Object.create(null); // cwd is transcript-supplied -> null-proto
  let filesRead = 0,
    truncatedFiles = 0;
  rows.forEach(function (r) {
    const head = readHead(r.file, maxBytes);
    if (!head) return;
    filesRead++;
    if (head.truncated) truncatedFiles++;
    const cwd = scrub(r.cwd, 300) || 'unknown';
    const bucket =
      byCwd[cwd] ||
      (byCwd[cwd] = {
        cwd: cwd,
        repo: cwd === 'unknown' ? 'unknown' : path.basename(cwd) || cwd,
        sessions: 0,
        messages: 0,
        tokens: newTok(),
        models: Object.create(null),
        costUSD: 0,
        estimate: false,
      });
    bucket.sessions++;
    try {
      bucket.messages += transcript.parse(head.text).counts.messages;
    } catch (e) {
      /* ignore */
    }
    scanUsage(head.text, bucket);
  });

  const totalTok = newTok();
  let totalCost = 0,
    totalSessions = 0,
    totalMessages = 0,
    anyFallback = false;
  const list = Object.keys(byCwd).map(function (k) {
    const b = byCwd[k];
    const models = Object.create(null); // model id is transcript-supplied -> null-proto (no __proto__ setter)
    let cost = 0;
    Object.keys(b.models).forEach(function (mid) {
      const t = b.models[mid];
      // Cost was summed per transcript line in scanUsage; only the fallback
      // price flag needs the table again here.
      const fallback = priceFor(mid).fallback;
      if (fallback) {
        anyFallback = true;
        b.estimate = true;
      }
      models[mid] = {
        tokens: tokenView(t),
        costUSD: t.costUSD,
        fallbackPrice: fallback,
      };
      cost += t.costUSD;
    });
    b.models = models;
    b.costUSD = cost;
    b.tokens = tokenView(b.tokens);
    totalTok.input += b.tokens.input;
    totalTok.output += b.tokens.output;
    totalTok.cacheRead += b.tokens.cacheRead;
    totalTok.cacheCreation += b.tokens.cacheCreation;
    totalTok.cacheCreation1h += b.tokens.cacheCreation1h;
    totalCost += cost;
    totalSessions += b.sessions;
    totalMessages += b.messages;
    return b;
  });
  list.sort(function (a, b) {
    return b.costUSD - a.costUSD || (a.cwd < b.cwd ? -1 : 1);
  });
  return {
    at: ctx.now(),
    scanned: { sessions: rows.length, filesRead: filesRead, truncatedFiles: truncatedFiles },
    capped: rows.length >= maxSessions,
    byCwd: list,
    totals: {
      cwds: list.length,
      sessions: totalSessions,
      messages: totalMessages,
      tokens: tokenView(totalTok),
      costUSD: totalCost,
    },
    note:
      'Token counts are MEASURED from local transcripts; costUSD is an ESTIMATE from a static pricing snapshot (' +
      PRICING_AS_OF +
      ') and will drift.' +
      (anyFallback ? ' Some models used fallback pricing.' : ''),
  };
}

// ---- tiny display helpers (for CLI wiring) --------------------------------

function fmtUsd(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '$?';
  if (n === 0) return '$0.00';
  if (n < 0.01) return '$' + n.toFixed(4);
  if (n < 100) return '$' + n.toFixed(2);
  return '$' + Math.round(n).toLocaleString('en-US');
}
function fmtEta(minutes) {
  if (typeof minutes !== 'number' || !isFinite(minutes)) return '-';
  if (minutes <= 0) return 'now';
  if (minutes < 60) return Math.round(minutes) + 'm';
  if (minutes < 60 * 24) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return h + 'h' + (m ? ' ' + m + 'm' : '');
  }
  const d = Math.floor(minutes / 1440);
  const h = Math.round((minutes % 1440) / 60);
  return d + 'd' + (h ? ' ' + h + 'h' : '');
}

export {
  PRICING,
  PRICING_AS_OF,
  FALLBACK_PRICE,
  CACHE_READ_MULT,
  CACHE_WRITE_MULT,
  CACHE_WRITE_1H_MULT,
  LONG_CONTEXT_THRESHOLD,
  LONG_CONTEXT_INPUT_MULT,
  LONG_CONTEXT_OUTPUT_MULT,
  FAST_MULT,
  priceFor,
  rateCard,
  costBreakdown,
  estimateCost,
  unified,
  predict,
  attribute,
  readUsageCache,
  fmtUsd,
  fmtEta,
  usageCachePath,
};
