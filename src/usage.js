// Per-account usage/quota via the OAuth usage API (ported from claude-swap):
// GET https://api.anthropic.com/api/oauth/usage with the account's Bearer token.
// Best-effort with a short cache; degraded states are explicit sentinels so the
// UI can render "?" instead of lying.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { atomicWrite } from './fsutil.js';
import * as _config from './config.js';
import * as _history from './history.js';
import * as _tiers from './tiers.js';
import * as _lock from './lock.js';
import * as _oauth from './oauth.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const CACHE_TTL_MS = 60 * 1000;
// A 429 from the usage endpoint opens a per-account quiet window: at least Retry-After, at least the
// cache TTL (never below THROTTLE_BASE_MS), doubling per consecutive 429 up to THROTTLE_MAX_MS.
// Every caller on the machine reads the same cache file, so the window holds for all of them.
const THROTTLE_BASE_MS = 60 * 1000;
const THROTTLE_MAX_MS = 30 * 60 * 1000;
const RETRY_AFTER_MAX_MS = 6 * 3600 * 1000; // a corrupt header must not pin the cache for days
const LOCK_TIMEOUT_MS = 8000;

let VERSION = '0.0.0';
try {
  VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
} catch (e) {
  /* ignore */
}

function accessTokenOf(blob) {
  try {
    return JSON.parse(blob).claudeAiOauth.accessToken || null;
  } catch (e) {
    return null;
  }
}

// Retry-After -> milliseconds, or null. Both forms: delta-seconds and an HTTP date.
function parseRetryAfter(v, nowMs) {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  if (!t) return null;
  let ms = null;
  if (/^[0-9]+(\.[0-9]+)?$/.test(t)) ms = Math.round(parseFloat(t) * 1000);
  else {
    const d = Date.parse(t);
    if (!isNaN(d)) ms = Math.max(0, d - (nowMs !== undefined ? nowMs : Date.now()));
  }
  if (ms === null || !isFinite(ms) || ms < 0) return null;
  return Math.min(ms, RETRY_AFTER_MAX_MS);
}
function headerOf(res, name) {
  const h = res && res.headers;
  if (!h) return null;
  if (typeof h.get === 'function') return h.get(name);
  return h[name] !== undefined ? h[name] : h[name.toLowerCase()] !== undefined ? h[name.toLowerCase()] : null;
}

// Detailed variant: { usage, httpStatus, retryAfterMs } — httpStatus lets callers distinguish
// an expired/invalid token (401/403) from a network failure; retryAfterMs is the server's
// Retry-After on a 429/503 (null when absent).
async function fetchUsageDetailed(accessToken, opts) {
  opts = opts || {};
  const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch || !accessToken) return { usage: null, httpStatus: null };
  try {
    const res = await doFetch(USAGE_URL, {
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'anthropic-beta': OAUTH_BETA_HEADER,
        'User-Agent': 'keyflip/' + VERSION,
      },
      signal:
        typeof AbortSignal !== 'undefined' && AbortSignal.timeout
          ? AbortSignal.timeout(opts.timeoutMs || 5000)
          : undefined,
    });
    if (!res || !res.ok)
      return {
        usage: null,
        httpStatus: (res && res.status) || null,
        retryAfterMs: parseRetryAfter(headerOf(res, 'retry-after'), opts.nowMs),
      };
    const data = await res.json();
    const out = {};
    if (data.five_hour && typeof data.five_hour.utilization === 'number') {
      out.fiveHour = { pct: data.five_hour.utilization, resetsAt: data.five_hour.resets_at || null };
    }
    if (data.seven_day && typeof data.seven_day.utilization === 'number') {
      out.sevenDay = { pct: data.seven_day.utilization, resetsAt: data.seven_day.resets_at || null };
    }
    if (data.seven_day_opus && typeof data.seven_day_opus.utilization === 'number') {
      out.sevenDayOpus = {
        pct: data.seven_day_opus.utilization,
        resetsAt: data.seven_day_opus.resets_at || null,
        family: 'opus',
      };
    }
    if (data.seven_day_sonnet && typeof data.seven_day_sonnet.utilization === 'number') {
      out.sevenDaySonnet = {
        pct: data.seven_day_sonnet.utilization,
        resetsAt: data.seven_day_sonnet.resets_at || null,
        family: 'sonnet',
      };
    }
    const hasAny = out.fiveHour || out.sevenDay || out.sevenDayOpus || out.sevenDaySonnet;
    return { usage: hasAny ? out : null, httpStatus: res.status, retryAfterMs: null };
  } catch (e) {
    return { usage: null, httpStatus: null, retryAfterMs: null };
  }
}

// -> { fiveHour: {pct, resetsAt}, sevenDay: {pct, resetsAt}, sevenDayOpus?, sevenDaySonnet? } | null
async function fetchUsage(accessToken, opts) {
  return (await fetchUsageDetailed(accessToken, opts)).usage;
}

// Remaining % before the binding account-wide rate-limit window; null = unknown.
function headroom(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const pcts = [];
  [usage.fiveHour, usage.sevenDay].forEach(function (w) {
    if (w && typeof w.pct === 'number') pcts.push(w.pct);
  });
  if (!pcts.length) {
    [usage.sevenDayOpus, usage.sevenDaySonnet].forEach(function (w) {
      if (w && typeof w.pct === 'number') pcts.push(w.pct);
    });
  }
  if (!pcts.length) return null;
  return 100 - Math.max.apply(null, pcts);
}

// Model-scoped headroom (Traycer semantics): shared windows (5h, 7d) gate every
// model, while model-family windows (sevenDayOpus, sevenDaySonnet) gate only
// models of that family. An account at 100% Opus quota still has headroom for Sonnet.
function headroomForModel(usage, model) {
  if (!usage || typeof usage !== 'object') return null;
  const family = model ? _tiers.familyOf(model) : null;
  const pcts = [];
  [usage.fiveHour, usage.sevenDay].forEach(function (w) {
    if (w && typeof w.pct === 'number') pcts.push(w.pct);
  });
  if (!family || family === 'opus') {
    if (usage.sevenDayOpus && typeof usage.sevenDayOpus.pct === 'number') {
      pcts.push(usage.sevenDayOpus.pct);
    }
  }
  if (!family || family === 'sonnet') {
    if (usage.sevenDaySonnet && typeof usage.sevenDaySonnet.pct === 'number') {
      pcts.push(usage.sevenDaySonnet.pct);
    }
  }
  if (!pcts.length) return null;
  return 100 - Math.max.apply(null, pcts);
}

// Which quota scopes are currently exhausted (pct >= 100).
function limitedScopes(usage) {
  if (!usage || typeof usage !== 'object') return [];
  const scopes = [];
  if (usage.fiveHour && typeof usage.fiveHour.pct === 'number' && usage.fiveHour.pct >= 100) scopes.push('5h');
  if (usage.sevenDay && typeof usage.sevenDay.pct === 'number' && usage.sevenDay.pct >= 100) scopes.push('7d');
  if (usage.sevenDayOpus && typeof usage.sevenDayOpus.pct === 'number' && usage.sevenDayOpus.pct >= 100)
    scopes.push('opus');
  if (usage.sevenDaySonnet && typeof usage.sevenDaySonnet.pct === 'number' && usage.sevenDaySonnet.pct >= 100)
    scopes.push('sonnet');
  return scopes;
}

function fmt(usage) {
  if (!usage) return '?';
  const parts = [];
  if (usage.fiveHour) parts.push('5h ' + Math.round(usage.fiveHour.pct) + '%');
  if (usage.sevenDay) parts.push('7d ' + Math.round(usage.sevenDay.pct) + '%');
  if (usage.sevenDayOpus) parts.push('opus ' + Math.round(usage.sevenDayOpus.pct) + '%');
  if (usage.sevenDaySonnet) parts.push('sonnet ' + Math.round(usage.sevenDaySonnet.pct) + '%');
  return parts.join(' · ') || '?';
}

function cachePath(ctx) {
  return path.join(ctx.configDir, '.usage-cache.json');
}

// The 429 window also belongs to the TOKEN: the same live login can be asked under two names (the
// profile autoswitch knows it by, and whatever another caller lists it as), and the endpoint
// throttles the token. Kept apart from the per-account cache, whose keys other readers treat as
// account names. Keys are truncated SHA-256 fingerprints — never a token.
const THROTTLE_FILE = '.usage-throttle.json';
function tokenFp(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 24);
}
function readThrottles(ctx) {
  const t = Object.create(null);
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ctx.configDir, THROTTLE_FILE), 'utf8'));
    if (j && typeof j === 'object' && !Array.isArray(j)) Object.assign(t, j);
  } catch (e) {
    /* none */
  }
  return t;
}
function writeThrottles(ctx, t, nowMs) {
  const out = {};
  Object.keys(t).forEach(function (k) {
    if (t[k] && typeof t[k].until === 'number' && t[k].until > nowMs) out[k] = t[k];
  });
  try {
    atomicWrite(path.join(ctx.configDir, THROTTLE_FILE), JSON.stringify(out), 0o600);
  } catch (e) {
    /* best effort */
  }
}
function quietUntil(w, nowMs) {
  return w && typeof w.until === 'number' && nowMs < w.until && w.until - nowMs <= RETRY_AFTER_MAX_MS + THROTTLE_MAX_MS
    ? w.until
    : null;
}

// The cache TTL, in ms, defaulting from config (`keyflip config set usage.cacheTtlSeconds N`).
// Falls back to the built-in 60s if config is unreadable. Callers can still override via opts.cacheTtlMs.
function cfgTtlMs(ctx) {
  try {
    const s = _config.get(ctx, 'usage.cacheTtlSeconds');
    return (typeof s === 'number' ? s : 60) * 1000;
  } catch (e) {
    return CACHE_TTL_MS;
  }
}

// The quiet window after the n-th consecutive 429: max(Retry-After, base·2^(n-1)), capped.
function throttleWindowMs(strikes, retryAfterMs, ttl) {
  const base = Math.max(ttl || 0, THROTTLE_BASE_MS);
  const backoff = Math.min(THROTTLE_MAX_MS, base * Math.pow(2, Math.max(0, strikes - 1)));
  return Math.max(retryAfterMs || 0, backoff);
}

function readCache(ctx) {
  // Null-prototype + shape check: a corrupt/tampered cache (scalar JSON, a far-future timestamp
  // pinning fake usage, or a '__proto__' key) must never poison a lookup.
  const cache = Object.create(null);
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(ctx), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) Object.assign(cache, parsed);
  } catch (e) {
    /* none / corrupt — start empty */
  }
  return cache;
}

// A cache entry as a result row. `fresh` = within TTL; `quiet` = inside a 429 window.
function rowFromCache(c, nowMs) {
  const usageNow = c.usage || null;
  const row = {
    status: c.status,
    usage: usageNow,
    headroom: headroom(usageNow),
    lastGood: usageNow ? usageNow : c.lastGood || null,
    lastGoodAt: usageNow ? c.at : typeof c.lastGoodAt === 'number' ? c.lastGoodAt : null,
    limitedScopes: limitedScopes(usageNow || c.lastGood),
    cached: true,
  };
  if (c.throttle && typeof c.throttle.until === 'number' && nowMs < c.throttle.until) row.retryAt = c.throttle.until;
  return row;
}
function cacheState(c, nowMs, ttl) {
  if (!c || typeof c.at !== 'number' || c.at > nowMs) return 'miss';
  const t = c.throttle;
  if (t && typeof t.until === 'number' && nowMs < t.until && t.until - nowMs <= RETRY_AFTER_MAX_MS + THROTTLE_MAX_MS)
    return 'quiet';
  return nowMs - c.at < ttl ? 'fresh' : 'stale';
}

// Usage per profile name -> { status: 'ok'|'no-creds'|'no-token'|'error'|'throttled'|'expired'|'pending',
// usage, headroom, lastGood, lastGoodAt, limitedScopes, retryAt? }.
//
// ONE poll per account per window for the whole machine: the cache file is shared by the CLI, the
// MCP server, the autoswitch service, the status line and outside callers (a polyctl quota guard
// shells `keyflip usage --json`), and fetching happens under a cross-process lock that re-reads the
// cache first — so ten callers in the same minute cost one request, not ten.
// A 429 opens a quiet window (Retry-After honoured, exponential backoff) during which nobody asks.
// Transient failures retain `lastGood` (+ when it was read) from the previous reading (Traycer
// `isTransientRateLimitUnavailableReason` semantics); a 401/403 clears it.
async function usageForProfiles(ctx, names, opts) {
  opts = opts || {};
  const nowMs = opts.nowMs !== undefined ? opts.nowMs : Date.now();
  const ttl = opts.cacheTtlMs !== undefined ? opts.cacheTtlMs : cfgTtlMs(ctx);
  const out = {};

  function serveFromCache(cache, name) {
    const c = cache[name];
    const st = cacheState(c, nowMs, ttl);
    if (st === 'fresh') {
      out[name] = rowFromCache(c, nowMs);
      return true;
    }
    if (st === 'quiet') {
      // Inside a 429 window: report throttled with the last good reading; never ask.
      const row = rowFromCache(c, nowMs);
      row.status = 'throttled';
      row.usage = null;
      row.headroom = null;
      out[name] = row;
      return true;
    }
    return false;
  }

  let cache = readCache(ctx);
  let todo = names.filter(function (n) {
    return !serveFromCache(cache, n);
  });
  if (!todo.length) return out;

  // Fetch under the machine-wide usage lock. Another process may have refreshed the cache while we
  // waited, so re-read it before deciding what is still missing. If the lock cannot be had, do NOT
  // poll anyway: hand back the last reading as 'pending'.
  let held = null;
  if (opts.lock !== false) {
    try {
      held = await _lock.acquire(ctx.configDir, {
        resource: 'usage',
        timeoutMs: opts.lockTimeoutMs !== undefined ? opts.lockTimeoutMs : LOCK_TIMEOUT_MS,
      });
    } catch (e) {
      held = null;
      todo.forEach(function (name) {
        const c = cache[name];
        const prevGood = (c && (c.usage || c.lastGood)) || null;
        out[name] = {
          status: 'pending',
          usage: null,
          headroom: null,
          lastGood: prevGood,
          lastGoodAt: c ? (c.usage ? c.at : c.lastGoodAt || null) : null,
          limitedScopes: limitedScopes(prevGood),
        };
      });
      return out;
    }
    cache = readCache(ctx);
    todo = todo.filter(function (n) {
      return !serveFromCache(cache, n);
    });
  }

  const tthrottle = readThrottles(ctx);
  let tthrottleDirty = false;
  try {
    for (let i = 0; i < todo.length; i++) {
      const name = todo[i];
      const c = cache[name];
      const prevGood = (c && (c.usage || c.lastGood)) || null;
      const prevGoodAt = c ? (c.usage ? c.at : typeof c.lastGoodAt === 'number' ? c.lastGoodAt : null) : null;
      let throttle = null;
      // For the ACTIVE account prefer the LIVE credential — Claude keeps it fresh,
      // while the stored snapshot may hold an already-expired access token.
      let blob = null;
      if (opts.liveFor && opts.liveFor === name) {
        try {
          blob = ctx.store.getLive();
        } catch (e) {
          blob = null;
        }
      }
      if (!blob) {
        try {
          blob = ctx.store.getProfile(name);
        } catch (e) {
          blob = null;
        }
      }
      if (!blob) {
        out[name] = {
          status: 'no-creds',
          usage: null,
          headroom: null,
          lastGood: null,
          lastGoodAt: null,
          limitedScopes: [],
        };
      } else {
        const token = accessTokenOf(blob);
        if (!token) {
          out[name] = {
            status: 'no-token',
            usage: null,
            headroom: null,
            lastGood: null,
            lastGoodAt: null,
            limitedScopes: [],
          };
        } else {
          let tfp = tokenFp(token);
          const tUntil = quietUntil(tthrottle[tfp], nowMs);
          // This TOKEN is inside a 429 window opened under another name: do not ask.
          let r = tUntil
            ? { usage: null, httpStatus: 'quiet', retryAfterMs: null }
            : await fetchUsageDetailed(token, Object.assign({}, opts, { nowMs: nowMs }));
          // If a non-live account gets 401/403 and its stored blob is expired/due with a refresh token,
          // refresh that one account via the shared core and retry the usage read once.
          if (
            (r.httpStatus === 401 || r.httpStatus === 403) &&
            !(opts.liveFor && opts.liveFor === name) &&
            _oauth.isDue(blob, nowMs, _oauth.leadMinutesOf(ctx, opts))
          ) {
            const refreshFn = typeof opts.refreshAccount === 'function' ? opts.refreshAccount : _oauth.refreshAccount;
            const refreshEnabled =
              opts.refreshOnExpired === false
                ? false
                : Boolean(
                    typeof opts.refreshAccount === 'function' ||
                    typeof opts.refreshFetch === 'function' ||
                    opts.refreshOnExpired === true ||
                    !process.env.KEYFLIP_TEST_OFFLINE,
                  );
            if (refreshEnabled) {
              let refRes = null;
              try {
                refRes = await refreshFn(ctx, name, {
                  nowMs: nowMs,
                  fetch: opts.refreshFetch,
                });
              } catch (e) {
                refRes = null;
              }
              let refreshedBlob = null;
              try {
                refreshedBlob = ctx.store.getProfile(name);
              } catch (e) {
                refreshedBlob = null;
              }
              if ((!refreshedBlob || refreshedBlob === blob) && refRes && typeof refRes.blob === 'string') {
                refreshedBlob = refRes.blob;
              }
              const newToken =
                (refreshedBlob && accessTokenOf(refreshedBlob)) ||
                (refRes && typeof refRes.accessToken === 'string' ? refRes.accessToken : null);
              if (newToken && newToken !== token) {
                tfp = tokenFp(newToken);
                r = await fetchUsageDetailed(newToken, Object.assign({}, opts, { nowMs: nowMs }));
              }
            }
          }
          if (r.httpStatus === 'quiet') {
            const tw = tthrottle[tfp];
            throttle = { until: tUntil, strikes: tw.strikes || 1, retryAfterMs: tw.retryAfterMs || null };
            out[name] = {
              status: 'throttled',
              usage: null,
              headroom: null,
              lastGood: prevGood,
              lastGoodAt: prevGoodAt,
              limitedScopes: limitedScopes(prevGood),
              retryAt: tUntil,
            };
          } else if (r.usage) {
            if (tthrottle[tfp]) {
              delete tthrottle[tfp];
              tthrottleDirty = true;
            }
            out[name] = {
              status: 'ok',
              usage: r.usage,
              headroom: headroom(r.usage),
              lastGood: r.usage,
              lastGoodAt: nowMs,
              limitedScopes: limitedScopes(r.usage),
            };
          } else if (r.httpStatus === 401 || r.httpStatus === 403) {
            out[name] = {
              status: 'expired',
              usage: null,
              headroom: null,
              lastGood: null,
              lastGoodAt: null,
              limitedScopes: [],
            };
          }
          // 429 here means the USAGE ENDPOINT throttled this token — it does NOT
          // prove the account's inference is rate-limited (verified live: a 429
          // account kept working). Report unknown, never auto-skip on it, preserve
          // `lastGood`, and stay quiet for the window the server asked for (or longer).
          else if (r.httpStatus === 429) {
            const prevStrikes = Math.max(
              (c && c.throttle && c.throttle.strikes) || 0,
              (tthrottle[tfp] && tthrottle[tfp].strikes) || 0,
            );
            const strikes = prevStrikes + 1;
            const wait = throttleWindowMs(strikes, r.retryAfterMs, ttl);
            throttle = { until: nowMs + wait, strikes: strikes, retryAfterMs: r.retryAfterMs };
            tthrottle[tfp] = throttle;
            tthrottleDirty = true;
            out[name] = {
              status: 'throttled',
              usage: null,
              headroom: null,
              lastGood: prevGood,
              lastGoodAt: prevGoodAt,
              limitedScopes: limitedScopes(prevGood),
              retryAt: throttle.until,
            };
          } else {
            out[name] = {
              status: 'error',
              usage: null,
              headroom: null,
              lastGood: prevGood,
              lastGoodAt: prevGoodAt,
              limitedScopes: limitedScopes(prevGood),
            };
          }
        }
      }
      cache[name] = {
        at: nowMs,
        status: out[name].status,
        usage: out[name].usage,
        lastGood: out[name].lastGood || null,
        lastGoodAt: out[name].lastGoodAt || null,
      };
      if (throttle) cache[name].throttle = throttle;
      // #12: record every FRESH sample (cache hits never get here) to the trend log.
      if (opts.recordHistory) {
        try {
          _history.recordUsage(ctx, name, out[name]);
        } catch (e) {
          /* best effort */
        }
      }
    }
    try {
      atomicWrite(cachePath(ctx), JSON.stringify(cache), 0o600);
    } catch (e) {
      /* best effort */
    }
    if (tthrottleDirty) writeThrottles(ctx, tthrottle, nowMs);
  } finally {
    if (held) held.release();
  }
  return out;
}

// The headroom a decision may use. A live reading wins. While the endpoint is throttled (or the
// lock was busy) the last good reading still counts when it is recent (<= maxStaleMs) and none of
// its windows has reset since — utilization only rises inside a window, so an old "97% used" is
// still at least 97% now. -> { headroom, basis: 'live'|'last-good'|null, usage, ageMs? }
function effectiveHeadroom(info, nowMs, maxStaleMs) {
  if (!info) return { headroom: null, basis: null, usage: null };
  if (typeof info.headroom === 'number') return { headroom: info.headroom, basis: 'live', usage: info.usage };
  const lg = info.lastGood;
  const at = info.lastGoodAt;
  if (!lg || typeof at !== 'number' || !(maxStaleMs > 0)) return { headroom: null, basis: null, usage: null };
  const now = nowMs !== undefined ? nowMs : Date.now();
  const age = now - at;
  if (age < 0 || age > maxStaleMs) return { headroom: null, basis: null, usage: null };
  const reset = [lg.fiveHour, lg.sevenDay, lg.sevenDayOpus, lg.sevenDaySonnet].some(function (w) {
    const r = w && w.resetsAt ? Date.parse(w.resetsAt) : NaN;
    return !isNaN(r) && r <= now;
  });
  if (reset) return { headroom: null, basis: null, usage: null };
  const h = headroom(lg);
  return typeof h === 'number'
    ? { headroom: h, basis: 'last-good', usage: lg, ageMs: age }
    : { headroom: null, basis: null, usage: null };
}

// Rotation strategies over the non-active candidates (in rotation order):
//  - 'best'           -> most headroom among accounts with known usage
//  - 'next-available' -> first with headroom > 0 (unknown counts as available)
// Supports optional `opts.model` to evaluate model-scoped headroom (`headroomForModel`).
// Returns the chosen candidate or null.
function pickByStrategy(candidates, infos, strategy, opts) {
  opts = opts || {};
  if (!candidates.length) return null;
  function effectiveHeadroom(info) {
    if (!info) return null;
    if (opts.model && info.usage) return headroomForModel(info.usage, opts.model);
    return typeof info.headroom === 'number' ? info.headroom : null;
  }
  if (strategy === 'best') {
    let best = null,
      bestH = -Infinity;
    candidates.forEach(function (c) {
      const info = infos[c.name];
      const h = effectiveHeadroom(info);
      if (typeof h === 'number' && h > bestH) {
        best = c;
        bestH = h;
      }
    });
    return best; // null when no candidate has known usage
  }
  if (strategy === 'next-available') {
    for (let i = 0; i < candidates.length; i++) {
      const info = infos[candidates[i].name];
      const h = effectiveHeadroom(info);
      if (!info || h === null || h > 0) return candidates[i];
    }
    return null;
  }
  return null;
}

export {
  fetchUsage,
  fetchUsageDetailed,
  headroom,
  headroomForModel,
  limitedScopes,
  fmt,
  usageForProfiles,
  pickByStrategy,
  accessTokenOf,
  parseRetryAfter,
  throttleWindowMs,
  effectiveHeadroom,
  USAGE_URL,
  THROTTLE_BASE_MS,
  THROTTLE_MAX_MS,
  THROTTLE_FILE,
};
