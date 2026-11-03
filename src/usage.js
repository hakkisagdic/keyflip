// Per-account usage/quota via the OAuth usage API (ported from claude-swap):
// GET https://api.anthropic.com/api/oauth/usage with the account's Bearer token.
// Best-effort with a short cache; degraded states are explicit sentinels so the
// UI can render "?" instead of lying.
import fs from 'fs';
import path from 'path';
import { atomicWrite } from './fsutil.js';
import * as _config from './config.js';
import * as _history from './history.js';
import * as _tiers from './tiers.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const CACHE_TTL_MS = 60 * 1000;

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

// Detailed variant: { usage, httpStatus } — httpStatus lets callers distinguish
// an expired/invalid token (401/403) from a network failure.
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
    if (!res || !res.ok) return { usage: null, httpStatus: (res && res.status) || null };
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
    return { usage: hasAny ? out : null, httpStatus: res.status };
  } catch (e) {
    return { usage: null, httpStatus: null };
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

// Usage per profile name -> { status: 'ok'|'no-creds'|'no-token'|'error'|'throttled'|'expired',
// usage, headroom, lastGood, limitedScopes }. Serves a 60s cache to keep list/strategy calls cheap.
// Transient failures ('throttled' 429 on usage endpoint or network 'error') retain `lastGood`
// from the previous reading (Traycer `isTransientRateLimitUnavailableReason` semantics).
async function usageForProfiles(ctx, names, opts) {
  opts = opts || {};
  const nowMs = opts.nowMs !== undefined ? opts.nowMs : Date.now();
  const ttl = opts.cacheTtlMs !== undefined ? opts.cacheTtlMs : cfgTtlMs(ctx);
  // Null-prototype + shape check: a corrupt/tampered cache (scalar JSON, a
  // far-future timestamp pinning fake usage, or a '__proto__' key) must never
  // poison a lookup — fall back to a fresh fetch instead.
  let cache = Object.create(null);
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(ctx), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      cache = Object.assign(Object.create(null), parsed);
  } catch (e) {
    /* none / corrupt — start empty */
  }
  const out = {};
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const c = cache[name];
    const prevGood = (c && (c.usage || c.lastGood)) || null;
    // Trust a cache entry only if its timestamp is a sane, non-future number.
    if (c && typeof c.at === 'number' && c.at <= nowMs && nowMs - c.at < ttl) {
      out[name] = {
        status: c.status,
        usage: c.usage || null,
        headroom: headroom(c.usage),
        lastGood: c.usage ? c.usage : c.lastGood || null,
        limitedScopes: limitedScopes(c.usage || c.lastGood),
      };
      continue;
    }
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
      out[name] = { status: 'no-creds', usage: null, headroom: null, lastGood: null, limitedScopes: [] };
    } else {
      const token = accessTokenOf(blob);
      if (!token) {
        out[name] = { status: 'no-token', usage: null, headroom: null, lastGood: null, limitedScopes: [] };
      } else {
        const r = await fetchUsageDetailed(token, opts);
        if (r.usage) {
          out[name] = {
            status: 'ok',
            usage: r.usage,
            headroom: headroom(r.usage),
            lastGood: r.usage,
            limitedScopes: limitedScopes(r.usage),
          };
        } else if (r.httpStatus === 401 || r.httpStatus === 403) {
          out[name] = { status: 'expired', usage: null, headroom: null, lastGood: null, limitedScopes: [] };
        }
        // 429 here means the USAGE ENDPOINT throttled this token — it does NOT
        // prove the account's inference is rate-limited (verified live: a 429
        // account kept working). Report unknown, never auto-skip on it, and
        // preserve `lastGood` from the prior reading.
        else if (r.httpStatus === 429) {
          out[name] = {
            status: 'throttled',
            usage: null,
            headroom: null,
            lastGood: prevGood,
            limitedScopes: limitedScopes(prevGood),
          };
        } else {
          out[name] = {
            status: 'error',
            usage: null,
            headroom: null,
            lastGood: prevGood,
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
    };
    // #12: record every FRESH sample (cache hits `continue` above) to the trend log.
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
  return out;
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
  USAGE_URL,
};
