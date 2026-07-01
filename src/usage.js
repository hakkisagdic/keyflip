'use strict';
// Per-account usage/quota via the OAuth usage API (ported from claude-swap):
// GET https://api.anthropic.com/api/oauth/usage with the account's Bearer token.
// Best-effort with a short cache; degraded states are explicit sentinels so the
// UI can render "?" instead of lying.
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./fsutil');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const CACHE_TTL_MS = 60 * 1000;

let VERSION = '0.0.0';
try { VERSION = require('../package.json').version; } catch (e) { /* ignore */ }

function accessTokenOf(blob) {
  try { return JSON.parse(blob).claudeAiOauth.accessToken || null; } catch (e) { return null; }
}

// -> { fiveHour: {pct, resetsAt}, sevenDay: {pct, resetsAt} } | null
async function fetchUsage(accessToken, opts) {
  opts = opts || {};
  const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch || !accessToken) return null;
  try {
    const res = await doFetch(USAGE_URL, {
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'anthropic-beta': OAUTH_BETA_HEADER,
        'User-Agent': 'ccswitch/' + VERSION,
      },
      signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(opts.timeoutMs || 5000) : undefined,
    });
    if (!res || !res.ok) return null;
    const data = await res.json();
    const out = {};
    if (data.five_hour && typeof data.five_hour.utilization === 'number') {
      out.fiveHour = { pct: data.five_hour.utilization, resetsAt: data.five_hour.resets_at || null };
    }
    if (data.seven_day && typeof data.seven_day.utilization === 'number') {
      out.sevenDay = { pct: data.seven_day.utilization, resetsAt: data.seven_day.resets_at || null };
    }
    return (out.fiveHour || out.sevenDay) ? out : null;
  } catch (e) { return null; }
}

// Remaining % before the binding rate-limit window; null = unknown.
function headroom(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const pcts = [];
  [usage.fiveHour, usage.sevenDay].forEach(function (w) {
    if (w && typeof w.pct === 'number') pcts.push(w.pct);
  });
  if (!pcts.length) return null;
  return 100 - Math.max.apply(null, pcts);
}

function fmt(usage) {
  if (!usage) return '?';
  const parts = [];
  if (usage.fiveHour) parts.push('5h ' + Math.round(usage.fiveHour.pct) + '%');
  if (usage.sevenDay) parts.push('7d ' + Math.round(usage.sevenDay.pct) + '%');
  return parts.join(' · ') || '?';
}

function cachePath(ctx) { return path.join(ctx.configDir, '.usage-cache.json'); }

// Usage per profile name -> { status: 'ok'|'no-creds'|'no-token'|'error',
// usage, headroom }. Serves a 60s cache to keep list/strategy calls cheap.
async function usageForProfiles(ctx, names, opts) {
  opts = opts || {};
  const nowMs = opts.nowMs !== undefined ? opts.nowMs : Date.now();
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cachePath(ctx), 'utf8')); } catch (e) { /* none */ }
  const out = {};
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const c = cache[name];
    if (c && c.at && nowMs - c.at < (opts.cacheTtlMs || CACHE_TTL_MS)) {
      out[name] = { status: c.status, usage: c.usage || null, headroom: headroom(c.usage) };
      continue;
    }
    let blob = null;
    try { blob = ctx.store.getProfile(name); } catch (e) { blob = null; }
    if (!blob) { out[name] = { status: 'no-creds', usage: null, headroom: null }; }
    else {
      const token = accessTokenOf(blob);
      if (!token) { out[name] = { status: 'no-token', usage: null, headroom: null }; }
      else {
        const u = await fetchUsage(token, opts);
        out[name] = u ? { status: 'ok', usage: u, headroom: headroom(u) }
                      : { status: 'error', usage: null, headroom: null };
      }
    }
    cache[name] = { at: nowMs, status: out[name].status, usage: out[name].usage };
  }
  try { atomicWrite(cachePath(ctx), JSON.stringify(cache), 0o600); } catch (e) { /* best effort */ }
  return out;
}

// Rotation strategies over the non-active candidates (in rotation order):
//  - 'best'           -> most headroom among accounts with known usage
//  - 'next-available' -> first with headroom > 0 (unknown counts as available)
// Returns the chosen candidate or null.
function pickByStrategy(candidates, infos, strategy) {
  if (!candidates.length) return null;
  if (strategy === 'best') {
    let best = null, bestH = -Infinity;
    candidates.forEach(function (c) {
      const info = infos[c.name];
      if (info && typeof info.headroom === 'number' && info.headroom > bestH) { best = c; bestH = info.headroom; }
    });
    return best; // null when no candidate has known usage
  }
  if (strategy === 'next-available') {
    for (let i = 0; i < candidates.length; i++) {
      const info = infos[candidates[i].name];
      if (!info || info.headroom === null || info.headroom > 0) return candidates[i];
    }
    return null;
  }
  return null;
}

module.exports = {
  fetchUsage: fetchUsage,
  headroom: headroom,
  fmt: fmt,
  usageForProfiles: usageForProfiles,
  pickByStrategy: pickByStrategy,
  accessTokenOf: accessTokenOf,
  USAGE_URL: USAGE_URL,
};
