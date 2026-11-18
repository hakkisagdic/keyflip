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
// A sign-in kind the endpoint refuses stays refused until the credential changes: ask again rarely.
const UNSUPPORTED_TTL_MS = 6 * 3600 * 1000;

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

// The server's own reason for a refusal: { type, message } from the error body, never anything else
// (no header, no token). Best effort; null when the body is not the usual error envelope.
async function errorReasonOf(res) {
  try {
    if (!res || typeof res.json !== 'function') return null;
    const j = await res.json();
    const e = j && typeof j === 'object' ? j.error : null;
    if (!e || typeof e !== 'object') return null;
    const type = typeof e.type === 'string' ? e.type.slice(0, 80) : null;
    const message = typeof e.message === 'string' ? e.message.slice(0, 200) : null;
    return type || message ? { type: type, message: message } : null;
  } catch (e) {
    return null;
  }
}

// What kind of sign-in a stored credential is, from its scopes (a name list, not a secret).
// The usage endpoint needs the 'user:profile' scope: a browser OAuth sign-in has it, a long-lived
// token made for inference only ('claude setup-token') does not and is refused.
// -> 'oauth' | 'inference-only' | 'unknown'
function signInKind(blob) {
  try {
    const o = JSON.parse(blob).claudeAiOauth;
    if (!o || !Array.isArray(o.scopes)) return 'unknown';
    return o.scopes.indexOf('user:profile') !== -1 ? 'oauth' : 'inference-only';
  } catch (e) {
    return 'unknown';
  }
}

// A refusal that is about the KIND of sign-in, not about load: a missing scope in the server's
// words, or a refusal (401/403/429) on a credential that lacks the profile scope altogether.
const UNSUPPORTED_NOTE = 'unsupported for this sign-in kind';
function isUnsupportedSignIn(httpStatus, reason, kind) {
  const msg = reason ? String(reason.message || '') + ' ' + String(reason.type || '') : '';
  if (httpStatus === 403 && /scope|user:profile|permission/i.test(msg)) return true;
  if (kind === 'inference-only' && (httpStatus === 401 || httpStatus === 403 || httpStatus === 429)) return true;
  return false;
}

// ---- windows -------------------------------------------------------------------------------
// The usage endpoint grew: the old top-level keys (five_hour, seven_day, seven_day_opus, ...) and a
// newer `limits` list (kind, group, percent, severity, resets_at, scope.model, is_active). Every
// window found becomes { name, pct, resetsAt, scope, severity, active, limiting, source } with a
// STABLE name: '5h', 'weekly', 'weekly:<model>' (e.g. 'weekly:fable'), or the slug of an unknown
// kind/key. Unknown future windows are kept, never dropped.
function slug(v) {
  return String(v == null ? '' : v)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
function isPct(v) {
  return typeof v === 'number' && isFinite(v);
}
function legacyName(key) {
  if (key === 'five_hour') return { name: '5h', scope: null, limiting: true };
  if (key === 'seven_day') return { name: 'weekly', scope: null, limiting: true };
  const m = /^seven_day_(.+)$/.exec(key);
  if (m) return { name: 'weekly:' + slug(m[1]), scope: slug(m[1]), limiting: false };
  return { name: slug(key), scope: null, limiting: false };
}
function limitName(l) {
  const kind = String(l.kind || '');
  const sc = l.scope && typeof l.scope === 'object' ? l.scope : null;
  const model = sc && sc.model && typeof sc.model === 'object' ? sc.model.display_name || sc.model.id : null;
  const surface = sc && sc.surface ? sc.surface : null;
  const scopeSlug = model ? slug(model) : surface ? slug(surface) : null;
  let base;
  if (kind === 'weekly_all' || kind === 'weekly_scoped' || kind === 'weekly') base = 'weekly';
  else if (kind === 'five_hour' || kind === 'session' || kind === 'five_hour_all') base = '5h';
  else base = slug(kind) || slug(l.group) || 'limit';
  return { name: scopeSlug ? base + ':' + scopeSlug : base, scope: scopeSlug };
}
function parseWindows(data) {
  const wins = [];
  const seen = Object.create(null);
  function add(w) {
    if (seen[w.name]) return;
    seen[w.name] = true;
    wins.push(w);
  }
  if (!data || typeof data !== 'object') return wins;
  // 1. the `limits` list (carries severity and which window is the binding one)
  if (Array.isArray(data.limits)) {
    data.limits.forEach(function (l) {
      if (!l || typeof l !== 'object' || !isPct(l.percent)) return;
      const n = limitName(l);
      add({
        name: n.name,
        pct: l.percent,
        resetsAt: l.resets_at || null,
        scope: n.scope,
        severity: typeof l.severity === 'string' ? l.severity : null,
        active: l.is_active === true,
        limiting: !n.scope || l.is_active === true,
        source: 'limits',
      });
    });
  }
  // 2. every top-level key that is itself a window ({ utilization, resets_at }) — known or not
  Object.keys(data).forEach(function (key) {
    const w = data[key];
    if (!w || typeof w !== 'object' || Array.isArray(w) || !isPct(w.utilization)) return;
    const n = legacyName(key);
    add({
      name: n.name,
      pct: w.utilization,
      resetsAt: w.resets_at || null,
      scope: n.scope,
      severity: null,
      active: null,
      limiting: n.limiting,
      source: key,
    });
  });
  const rank = function (w) {
    return w.name === '5h' ? 0 : w.name === 'weekly' ? 1 : 2;
  };
  return wins
    .map(function (w, i) {
      return { w: w, i: i };
    })
    .sort(function (a, b) {
      return rank(a.w) - rank(b.w) || a.i - b.i;
    })
    .map(function (x) {
      return x.w;
    });
}

// A window's short label for one-line output (the names callers already know stay as they were).
function labelOf(w) {
  if (w.name === 'weekly') return '7d';
  if (w.name.indexOf('weekly:') === 0) return w.name.slice(7);
  return w.name;
}

// Remaining % across the windows that LIMIT the account (account-wide ones, plus any flagged active);
// when none is account-wide, across whatever windows exist. null = unknown.
function headroomOfWindows(wins) {
  if (!wins || !wins.length) return null;
  let pool = wins.filter(function (w) {
    return w.limiting;
  });
  if (!pool.length) pool = wins;
  return Math.min.apply(
    null,
    pool.map(function (w) {
      return 100 - w.pct;
    }),
  );
}

// The endpoint's JSON -> { windows, headroomPct, limitedScopes, fiveHour?, sevenDay?, sevenDayOpus?,
// sevenDaySonnet? } | null. The four legacy fields are kept for existing callers.
function parseUsage(data) {
  const wins = parseWindows(data);
  if (!wins.length) return null;
  const out = {};
  function pick(name, family) {
    const w = wins.filter(function (x) {
      return x.name === name;
    })[0];
    if (!w) return null;
    const o = { pct: w.pct, resetsAt: w.resetsAt };
    if (family) o.family = family;
    return o;
  }
  const f = pick('5h');
  const d = pick('weekly');
  const op = pick('weekly:opus', 'opus');
  const so = pick('weekly:sonnet', 'sonnet');
  if (f) out.fiveHour = f;
  if (d) out.sevenDay = d;
  if (op) out.sevenDayOpus = op;
  if (so) out.sevenDaySonnet = so;
  out.windows = wins;
  out.headroomPct = headroomOfWindows(wins);
  out.limitedScopes = wins
    .filter(function (w) {
      return w.pct >= 100;
    })
    .map(labelOf);
  return out;
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
        reason: await errorReasonOf(res),
      };
    const data = await res.json();
    const out = parseUsage(data);
    return { usage: out, httpStatus: res.status, retryAfterMs: null };
  } catch (e) {
    return { usage: null, httpStatus: null, retryAfterMs: null };
  }
}

// -> { fiveHour: {pct, resetsAt}, sevenDay: {pct, resetsAt}, sevenDayOpus?, sevenDaySonnet? } | null
async function fetchUsage(accessToken, opts) {
  return (await fetchUsageDetailed(accessToken, opts)).usage;
}

// The windows of a usage object: the parsed list, or (an older cached reading) the four legacy fields.
function windowsOf(usage) {
  if (!usage || typeof usage !== 'object') return [];
  if (Array.isArray(usage.windows)) {
    return usage.windows.filter(function (w) {
      return w && isPct(w.pct);
    });
  }
  const out = [];
  [
    ['5h', usage.fiveHour, null, true],
    ['weekly', usage.sevenDay, null, true],
    ['weekly:opus', usage.sevenDayOpus, 'opus', false],
    ['weekly:sonnet', usage.sevenDaySonnet, 'sonnet', false],
  ].forEach(function (r) {
    if (r[1] && isPct(r[1].pct))
      out.push({ name: r[0], pct: r[1].pct, resetsAt: r[1].resetsAt || null, scope: r[2], limiting: r[3] });
  });
  return out;
}

// Remaining % before the binding rate-limit window: the smallest remaining share across the windows
// that limit the account (see headroomOfWindows); null = unknown.
function headroom(usage) {
  return headroomOfWindows(windowsOf(usage));
}

// Model-scoped headroom (Traycer semantics): shared windows (5h, weekly) gate every model, while a
// model-scoped window (weekly:opus, weekly:fable, ...) gates only that model. An account at 100% Opus
// quota still has headroom for Sonnet. An unknown model is held against every scoped window.
function headroomForModel(usage, model) {
  const wins = windowsOf(usage);
  const shared = wins.filter(function (w) {
    return !w.scope;
  });
  const scoped = wins.filter(function (w) {
    return w.scope;
  });
  const m = slug(model);
  const family = model ? _tiers.familyOf(model) : null;
  const matched = scoped.filter(function (w) {
    return m.indexOf(w.scope) !== -1;
  });
  const used = model && (family || matched.length) ? matched : scoped;
  const pcts = shared.concat(used).map(function (w) {
    return w.pct;
  });
  if (!pcts.length) return null;
  return 100 - Math.max.apply(null, pcts);
}

// Which quota scopes are currently exhausted (pct >= 100), by short label ('5h', '7d', 'opus', ...).
function limitedScopes(usage) {
  const out = [];
  windowsOf(usage).forEach(function (w) {
    const l = labelOf(w);
    if (w.pct >= 100 && out.indexOf(l) === -1) out.push(l);
  });
  return out;
}

function fmt(usage) {
  if (!usage) return '?';
  const parts = windowsOf(usage).map(function (w) {
    return labelOf(w) + ' ' + Math.round(w.pct) + '%';
  });
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
    readAt: usageNow ? c.at : null,
  };
  if (c.throttle && typeof c.throttle.until === 'number' && nowMs < c.throttle.until) row.retryAt = c.throttle.until;
  return row;
}
function cacheState(c, nowMs, ttl) {
  if (!c || typeof c.at !== 'number' || c.at > nowMs) return 'miss';
  const t = c.throttle;
  if (t && typeof t.until === 'number' && nowMs < t.until && t.until - nowMs <= RETRY_AFTER_MAX_MS + THROTTLE_MAX_MS)
    return 'quiet';
  if (c.status === 'unsupported' && nowMs - c.at < UNSUPPORTED_TTL_MS) return 'fresh';
  // An entry an older build wrote has only the legacy keys (no `windows` list): it would hide every
  // window but the weekly one, so it is never served as a fresh reading.
  if (c.status === 'ok' && c.usage && typeof c.usage === 'object' && !Array.isArray(c.usage.windows)) return 'stale';
  return nowMs - c.at < ttl ? 'fresh' : 'stale';
}

// Usage per profile name -> { status: 'ok'|'no-creds'|'no-token'|'error'|'throttled'|'unsupported'|'expired'|'pending',
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

  // The credential this name would be read with now (live for the active account, else the saved one).
  function currentBlob(name) {
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
    return blob;
  }
  // A refusal or a quiet window belongs to the credential that earned it. After a renewed sign-in the
  // account must be asked again at once — a 17-strike hour-long wait for the OLD token must not hide it.
  function credentialChanged(name, c) {
    const tok = accessTokenOf(currentBlob(name));
    if (!tok) return false;
    const fp = tokenFp(tok);
    if (c.status === 'unsupported') return !c.fp || c.fp !== fp;
    if (c.throttle && c.throttle.fp) return c.throttle.fp !== fp;
    return !quietUntil(readThrottles(ctx)[fp], nowMs); // an older entry without a fingerprint
  }

  function serveFromCache(cache, name) {
    const c = cache[name];
    let st = cacheState(c, nowMs, ttl);
    if ((st === 'quiet' || (st === 'fresh' && c.status === 'unsupported')) && credentialChanged(name, c)) st = 'stale';
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
      let unsupportedFp = null;
      // For the ACTIVE account prefer the LIVE credential — Claude keeps it fresh,
      // while the stored snapshot may hold an already-expired access token.
      const blob = currentBlob(name);
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
            throttle = { until: tUntil, strikes: tw.strikes || 1, retryAfterMs: tw.retryAfterMs || null, fp: tfp };
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
              headroom: r.usage.headroomPct,
              lastGood: r.usage,
              lastGoodAt: nowMs,
              limitedScopes: limitedScopes(r.usage),
              readAt: nowMs,
            };
          } else if (isUnsupportedSignIn(r.httpStatus, r.reason, signInKind(blob))) {
            // The endpoint refuses this KIND of sign-in (no profile scope): not a rate limit, not an
            // expired token. Say so, and do not ask again until the credential changes.
            unsupportedFp = tfp;
            out[name] = {
              status: 'unsupported',
              note: UNSUPPORTED_NOTE,
              httpStatus: r.httpStatus,
              reason: r.reason || null,
              usage: null,
              headroom: null,
              lastGood: null,
              lastGoodAt: null,
              limitedScopes: [],
            };
          } else if (r.httpStatus === 401 || r.httpStatus === 403) {
            out[name] = {
              status: 'expired',
              httpStatus: r.httpStatus,
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
              (c && c.throttle && c.throttle.fp === tfp && c.throttle.strikes) || 0,
              (tthrottle[tfp] && tthrottle[tfp].strikes) || 0,
            );
            const strikes = prevStrikes + 1;
            const wait = throttleWindowMs(strikes, r.retryAfterMs, ttl);
            throttle = { until: nowMs + wait, strikes: strikes, retryAfterMs: r.retryAfterMs, fp: tfp };
            tthrottle[tfp] = throttle;
            tthrottleDirty = true;
            out[name] = {
              status: 'throttled',
              httpStatus: 429,
              reason: r.reason || null,
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
              httpStatus: r.httpStatus || null,
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
      if (unsupportedFp) cache[name].fp = unsupportedFp;
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
  const reset = windowsOf(lg).some(function (w) {
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
  parseUsage,
  parseWindows,
  windowsOf,
  signInKind,
  UNSUPPORTED_NOTE,
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
