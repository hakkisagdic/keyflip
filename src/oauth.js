'use strict';
// Proactive OAuth refresh for stored profiles (ported from claude-swap's oauth.py).
// The credentials blob is JSON: { claudeAiOauth: { accessToken, refreshToken,
// expiresAt (ms), scopes } }. Anthropic ROTATES the refresh token on every
// refresh, so a refreshed blob that fails to persist leaves the stored one stale
// — callers must warn loudly in that case.
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // Claude Code's public client id
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

let VERSION = '0.0.0';
try { VERSION = require('../package.json').version; } catch (e) { /* ignore */ }

function parse(blob) {
  try {
    const d = JSON.parse(blob);
    return d && d.claudeAiOauth && typeof d.claudeAiOauth === 'object' ? d : null;
  } catch (e) { return null; }
}

// Expired or about to expire (within the buffer)? Unknown expiry -> false.
function isExpiring(blob, nowMs) {
  const d = parse(blob);
  if (!d) return false;
  const ea = d.claudeAiOauth.expiresAt;
  if (typeof ea !== 'number') return false;
  return (nowMs !== undefined ? nowMs : Date.now()) + EXPIRY_BUFFER_MS >= ea;
}

// POST the refresh grant; returns the updated blob string, or null on any failure.
async function refreshBlob(blob, opts) {
  opts = opts || {};
  const d = parse(blob);
  if (!d) return null;
  const rt = d.claudeAiOauth.refreshToken;
  if (!rt) return null;
  const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) return null;
  try {
    const res = await doFetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'ccswitch/' + VERSION },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: rt, client_id: OAUTH_CLIENT_ID }),
      signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(opts.timeoutMs || 10000) : undefined,
    });
    if (!res || !res.ok) return null;
    const j = await res.json();
    if (!j || !j.access_token) return null;
    const now = opts.nowMs !== undefined ? opts.nowMs : Date.now();
    d.claudeAiOauth.accessToken = j.access_token;
    if (typeof j.expires_in === 'number') d.claudeAiOauth.expiresAt = now + j.expires_in * 1000;
    if (j.refresh_token) d.claudeAiOauth.refreshToken = j.refresh_token;
    if (j.scope) d.claudeAiOauth.scopes = String(j.scope).split(' ');
    return JSON.stringify(d);
  } catch (e) { return null; }
}

// Refresh profile <name>'s stored token if it's expiring — but ONLY when no live
// Claude instance owns the credential (rotating the refresh token under a live
// session would log one of them out). Returns:
//   {status:'skipped'|'fresh'|'refreshed'|'refresh-failed'|'persist-failed'}
async function maybeRefreshProfile(ctx, name, opts) {
  opts = opts || {};
  const isRunning = opts.isRunning || function () { return false; };
  const instances = opts.instances || function () { return []; };
  if (isRunning() || instances().length) return { status: 'skipped' };
  let blob;
  try { blob = ctx.store.getProfile(name); } catch (e) { return { status: 'skipped' }; }
  if (!blob) return { status: 'skipped' };
  if (!isExpiring(blob, opts.nowMs)) return { status: 'fresh' };
  const fresh = await refreshBlob(blob, opts);
  if (!fresh) return { status: 'refresh-failed' };
  try { ctx.store.setProfile(name, fresh); }
  catch (e) { return { status: 'persist-failed' }; } // stored refresh token is now stale!
  return { status: 'refreshed' };
}

module.exports = {
  isExpiring: isExpiring,
  refreshBlob: refreshBlob,
  maybeRefreshProfile: maybeRefreshProfile,
  OAUTH_TOKEN_URL: OAUTH_TOKEN_URL,
  OAUTH_CLIENT_ID: OAUTH_CLIENT_ID,
};
