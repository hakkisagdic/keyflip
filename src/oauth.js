// Proactive OAuth refresh for stored profiles (ported from claude-swap's oauth.py)
// plus the shared, guarded tokenkeeper core used by CLI, MCP, launchd/cron, switch, and usage.
//
// The credentials blob is JSON: { claudeAiOauth: { accessToken, refreshToken,
// expiresAt (ms), scopes } }. Anthropic ROTATES the refresh token on every
// refresh, so a refreshed blob that fails to persist leaves the stored one stale
// — callers must warn loudly in that case.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { atomicWrite } from './fsutil.js';
import * as profiles from './profiles.js';
import * as identity from './identity.js';
import * as lock from './lock.js';
import * as config from './config.js';
import * as notify from './notify.js';
import * as logmod from './log.js';

const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // Claude Code's public client id
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_LEAD_MINUTES = 60;
const REFRESH_STATE_FILE = 'refresh-state.json';
const DEFAULT_RETRY_DELAYS_MS = [2000, 8000];

let VERSION = '0.0.0';
try {
  VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
} catch (e) {
  /* ignore */
}

// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x1f\x7f]/g;
const TOKEN_LIKE_RE = /\bsk-ant-[A-Za-z0-9_-]+\b/g;

function sanitizeError(msg, secrets) {
  let s = String(msg == null ? '' : msg)
    .replace(CTRL_RE, ' ')
    .replace(TOKEN_LIKE_RE, '[redacted]')
    .trim();
  if (Array.isArray(secrets)) {
    secrets.forEach(function (sec) {
      if (typeof sec === 'string' && sec.length >= 4 && s.indexOf(sec) !== -1) {
        s = s.split(sec).join('[redacted]');
      }
    });
  }
  return s.slice(0, 120);
}

function parse(blob) {
  try {
    const d = JSON.parse(blob);
    return d && d.claudeAiOauth && typeof d.claudeAiOauth === 'object' ? d : null;
  } catch (e) {
    return null;
  }
}

function rtFingerprint(blob) {
  const d = parse(blob);
  const rt = d && d.claudeAiOauth && d.claudeAiOauth.refreshToken;
  if (typeof rt !== 'string' || !rt) return null;
  return crypto.createHash('sha256').update(rt).digest('hex').slice(0, 24);
}

// Expired or about to expire (within the 5-min buffer)? Unknown expiry -> false.
function isExpiring(blob, nowMs) {
  const d = parse(blob);
  if (!d) return false;
  const ea = d.claudeAiOauth.expiresAt;
  if (typeof ea !== 'number') return false;
  return (nowMs !== undefined ? nowMs : Date.now()) + EXPIRY_BUFFER_MS >= ea;
}

function leadMinutesOf(ctx, opts) {
  if (opts && typeof opts.leadMinutes === 'number' && Number.isFinite(opts.leadMinutes)) {
    return Math.max(5, Math.min(240, Math.trunc(opts.leadMinutes)));
  }
  try {
    const v = ctx && ctx.configDir ? config.get(ctx, 'refresh.leadMinutes') : DEFAULT_LEAD_MINUTES;
    if (typeof v === 'number' && Number.isFinite(v)) {
      return Math.max(5, Math.min(240, Math.trunc(v)));
    }
  } catch (e) {
    /* fall back */
  }
  return DEFAULT_LEAD_MINUTES;
}

function isDue(blob, nowMs, leadMinutes) {
  const d = parse(blob);
  if (!d) return false;
  const o = d.claudeAiOauth;
  if (!o || typeof o.refreshToken !== 'string' || !o.refreshToken) return false;
  const ea = o.expiresAt;
  if (typeof ea !== 'number') return false;
  const leadMs = (typeof leadMinutes === 'number' ? leadMinutes : DEFAULT_LEAD_MINUTES) * 60 * 1000;
  return (nowMs !== undefined ? nowMs : Date.now()) + leadMs >= ea;
}

function classifyHttpFailure(status, errCode) {
  const code = String(errCode || '').toLowerCase();
  if (status === 429 || (typeof status === 'number' && status >= 500)) {
    return 'transient';
  }
  if (/invalid_grant|invalid_request|unauthorized_client|invalid_client|revoked|refresh_token_expired/i.test(code)) {
    return 'dead';
  }
  if (status === 400 || status === 401) {
    return 'dead';
  }
  return 'transient';
}

// Structured OAuth refresh: never includes a token in error/metadata fields.
// Returns { ok: true, blob, httpStatus } or { ok: false, kind: 'dead' | 'transient', httpStatus, error }.
async function refreshBlobDetailed(blob, opts) {
  opts = opts || {};
  const d = parse(blob);
  if (!d) return { ok: false, kind: 'dead', httpStatus: null, error: 'invalid_blob' };
  const rt = d.claudeAiOauth.refreshToken;
  const at = d.claudeAiOauth.accessToken;
  if (typeof rt !== 'string' || !rt) {
    return { ok: false, kind: 'dead', httpStatus: null, error: 'no_refresh_token' };
  }
  const doFetch = opts.fetch || (typeof fetch !== 'undefined' && !process.env.KEYFLIP_TEST_OFFLINE ? fetch : null);
  if (!doFetch) {
    return { ok: false, kind: 'transient', httpStatus: null, error: 'no_fetch' };
  }
  let res;
  try {
    res = await doFetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'keyflip/' + VERSION },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: rt, client_id: OAUTH_CLIENT_ID }),
      signal:
        typeof AbortSignal !== 'undefined' && AbortSignal.timeout
          ? AbortSignal.timeout(opts.timeoutMs || 10000)
          : undefined,
    });
  } catch (e) {
    const msg = sanitizeError((e && (e.code || e.message)) || 'network_error', [rt, at]);
    return { ok: false, kind: 'transient', httpStatus: null, error: msg || 'network_error' };
  }
  if (!res) {
    return { ok: false, kind: 'transient', httpStatus: null, error: 'empty_response' };
  }
  const status = typeof res.status === 'number' ? res.status : res.ok ? 200 : null;
  let j = null;
  try {
    if (typeof res.json === 'function') j = await res.json();
  } catch (e) {
    j = null;
  }
  if (!res.ok) {
    let rawErr = '';
    if (j && typeof j === 'object') {
      if (typeof j.error === 'string') rawErr = j.error;
      else if (j.error && typeof j.error.type === 'string') rawErr = j.error.type;
      else if (j.error && typeof j.error.message === 'string') rawErr = j.error.message;
      else if (typeof j.error_description === 'string') rawErr = j.error_description;
      else if (typeof j.message === 'string') rawErr = j.message;
    }
    if (!rawErr) rawErr = status != null ? 'http_' + status : 'http_error';
    const errClean = sanitizeError(rawErr, [rt, at]);
    const kind = classifyHttpFailure(status, errClean);
    return { ok: false, kind: kind, httpStatus: status, error: errClean };
  }
  if (!j || typeof j.access_token !== 'string' || !j.access_token) {
    return { ok: false, kind: 'transient', httpStatus: status, error: 'missing_access_token' };
  }
  const now = opts.nowMs !== undefined ? opts.nowMs : Date.now();
  d.claudeAiOauth.accessToken = j.access_token;
  if (typeof j.expires_in === 'number') d.claudeAiOauth.expiresAt = now + j.expires_in * 1000;
  if (j.refresh_token) d.claudeAiOauth.refreshToken = j.refresh_token;
  if (j.scope) d.claudeAiOauth.scopes = String(j.scope).split(' ');
  return { ok: true, blob: JSON.stringify(d), httpStatus: status || 200 };
}

// POST the refresh grant; returns the updated blob string, or null on any failure.
// When opts.detailed === true, returns the structured { ok, blob | kind, httpStatus, error } object.
async function refreshBlob(blob, opts) {
  opts = opts || {};
  if (opts.detailed === true) {
    return refreshBlobDetailed(blob, opts);
  }
  const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  const r = await refreshBlobDetailed(blob, Object.assign({}, opts, { fetch: doFetch }));
  return r.ok ? r.blob : null;
}

function readLongLivedBlob(ctx, name) {
  try {
    const raw = ctx.store.getProfile('longlived__' + name);
    const d = parse(raw);
    return d && d.claudeAiOauth && d.claudeAiOauth.accessToken ? d.claudeAiOauth : null;
  } catch (e) {
    return null;
  }
}

// Thin wrapper over refreshAccount mapping new statuses to legacy maybeRefreshProfile statuses,
// without any global isRunning/instances guard.
async function maybeRefreshProfile(ctx, name, opts) {
  opts = opts || {};
  const r = await refreshAccount(
    ctx,
    name,
    Object.assign(
      {
        sleep:
          opts.sleep ||
          function () {
            return Promise.resolve();
          },
        persistRetryDelayMs: opts.persistRetryDelayMs !== undefined ? opts.persistRetryDelayMs : 0,
      },
      opts,
    ),
  );
  if (r.status === 'refreshed') return { status: 'refreshed' };
  if (r.status === 'fresh') return { status: 'fresh' };
  if (r.status === 'held' || r.status === 'busy' || r.status === 'skipped') return { status: 'skipped' };
  if (r.status === 'long-lived') {
    return r.deadWithoutRefreshToken ? { status: 'refresh-failed' } : { status: 'long-lived' };
  }
  if (r.status === 'persist-failed') return { status: 'persist-failed' };
  return { status: 'refresh-failed' };
}

function refreshStatePath(ctxOrDir) {
  const dir = typeof ctxOrDir === 'string' ? ctxOrDir : ctxOrDir.configDir;
  return path.join(dir, REFRESH_STATE_FILE);
}

function sanitizeAccountStateEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const out = {
    lastAttemptAt: typeof entry.lastAttemptAt === 'string' ? entry.lastAttemptAt : null,
    lastSuccessAt: typeof entry.lastSuccessAt === 'string' ? entry.lastSuccessAt : null,
    lastResult: typeof entry.lastResult === 'string' ? entry.lastResult : null,
    lastError: typeof entry.lastError === 'string' ? sanitizeError(entry.lastError) : null,
    httpStatus: typeof entry.httpStatus === 'number' ? entry.httpStatus : null,
    consecutiveFailures:
      typeof entry.consecutiveFailures === 'number' && entry.consecutiveFailures >= 0
        ? Math.trunc(entry.consecutiveFailures)
        : 0,
    nextAttemptAt: typeof entry.nextAttemptAt === 'string' ? entry.nextAttemptAt : null,
    expiresAt: typeof entry.expiresAt === 'number' ? entry.expiresAt : null,
  };
  if (typeof entry.deadForExpiresAt === 'number' || entry.deadForExpiresAt === null) {
    out.deadForExpiresAt = entry.deadForExpiresAt;
  }
  if (typeof entry.alertedFor === 'string' && entry.alertedFor) {
    out.alertedFor = sanitizeError(entry.alertedFor);
  }
  return out;
}

function readRefreshState(ctxOrDir) {
  const p = refreshStatePath(ctxOrDir);
  const out = Object.create(null);
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    Object.keys(raw).forEach(function (k) {
      if (k === '__proto__' || k === 'prototype' || k === 'constructor') return;
      if (k === '_meta') {
        if (raw._meta && typeof raw._meta === 'object') {
          out._meta = {
            lastRunAt: typeof raw._meta.lastRunAt === 'string' ? raw._meta.lastRunAt : null,
          };
        }
        return;
      }
      const clean = sanitizeAccountStateEntry(raw[k]);
      if (clean) out[k] = clean;
    });
  } catch (e) {
    /* absent or unreadable -> empty */
  }
  return out;
}

function writeRefreshState(ctxOrDir, state) {
  const p = refreshStatePath(ctxOrDir);
  const out = {};
  Object.keys(state || {}).forEach(function (k) {
    if (k === '__proto__' || k === 'prototype' || k === 'constructor') return;
    if (k === '_meta') {
      if (state._meta && typeof state._meta === 'object' && typeof state._meta.lastRunAt === 'string') {
        out._meta = { lastRunAt: state._meta.lastRunAt };
      }
      return;
    }
    const clean = sanitizeAccountStateEntry(state[k]);
    if (clean) out[k] = clean;
  });
  atomicWrite(p, JSON.stringify(out, null, 2), 0o600);
}

function lastRefreshRunAt(ctxOrDir) {
  const st = readRefreshState(ctxOrDir);
  let latest = st._meta && st._meta.lastRunAt ? Date.parse(st._meta.lastRunAt) : 0;
  let latestIso = st._meta && st._meta.lastRunAt ? st._meta.lastRunAt : null;
  Object.keys(st).forEach(function (k) {
    if (k === '_meta') return;
    const at = st[k] && st[k].lastAttemptAt;
    const ms = at ? Date.parse(at) : 0;
    if (ms > latest) {
      latest = ms;
      latestIso = at;
    }
  });
  return latestIso;
}

function nowMsOf(_ctx, opts) {
  if (opts && typeof opts.nowMs === 'number') return opts.nowMs;
  return Date.now();
}

function defaultSleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function alertMessageFor(account, resultKind, errCode) {
  if (resultKind === 'recovered') {
    return 'keyflip: ' + account + ' token refresh recovered';
  }
  const detail =
    resultKind === 'dead'
      ? 'refresh token rejected'
      : resultKind === 'persist-failed'
        ? 'could not save refreshed token'
        : errCode || 'transient error';
  return 'keyflip: ' + account + ' token could not be refreshed (' + detail + ') — run: keyflip login ' + account;
}

async function emitRefreshAlert(ctx, account, resultKind, errCode, httpStatus, opts) {
  opts = opts || {};
  const msg = alertMessageFor(account, resultKind, errCode);
  logmod.log(
    'oauth refresh alert ' + account + ': ' + resultKind + (httpStatus != null ? ' httpStatus=' + httpStatus : ''),
  );
  const payload = {
    account: account,
    result: resultKind,
    status: resultKind,
    reason: errCode || resultKind,
    httpStatus: httpStatus != null ? httpStatus : null,
    message: msg,
  };
  if (typeof opts.notify === 'function') {
    try {
      await opts.notify(payload);
    } catch (e) {
      /* ignore custom notify errors */
    }
  }
  const runner = opts.run || opts.runner || opts.notifyRun || (ctx && ctx.run) || null;
  try {
    await notify.send(ctx, 'token-refresh', payload, {
      force: true,
      forceDesktop: true,
      run: runner || undefined,
      fetch: opts.notifyFetch,
    });
  } catch (e) {
    /* best effort */
  }
  return msg;
}

// Refresh a single account if due, respecting held/live/lock/backoff/persist verification.
async function refreshOneInternal(ctx, name, inUse, liveRtFp, state, opts) {
  opts = opts || {};
  const leadMinutes = leadMinutesOf(ctx, opts);
  const leadMs = leadMinutes * 60 * 1000;
  let nowMs = nowMsOf(ctx, opts);

  // 1. Check held status before touching the store/lock.
  const heldWhy = inUse && inUse.why ? inUse.why[name] : null;
  if (heldWhy) {
    const ignoreLabelOnly =
      opts.forSwitch === true && (heldWhy === 'the live login' || heldWhy === 'the live login (by its label)');
    if (!ignoreLabelOnly) {
      logmod.log('oauth refresh ' + name + ': held');
      return {
        account: name,
        status: 'held',
        result: 'held',
        reason: heldWhy,
      };
    }
  }

  // 2. First read (unlocked) to quickly classify fresh / long-lived / held-by-live-rt / backoff.
  let blob1 = null;
  try {
    blob1 = ctx.store.getProfile(name);
  } catch (e) {
    blob1 = null;
  }
  const d1 = parse(blob1);
  const o1 = d1 ? d1.claudeAiOauth : null;
  if (!o1 || typeof o1.refreshToken !== 'string' || !o1.refreshToken) {
    const ll = readLongLivedBlob(ctx, name);
    if (!o1 && !ll) {
      logmod.log('oauth refresh ' + name + ': skipped');
      return {
        account: name,
        status: 'skipped',
        result: 'skipped',
      };
    }
    const llValid = Boolean(ll && ll.accessToken && (typeof ll.expiresAt !== 'number' || ll.expiresAt > nowMs));
    const hasLongLived = Boolean(
      (o1 && typeof o1.accessToken === 'string' && o1.accessToken && o1.refreshToken === undefined) || llValid,
    );
    const exp =
      o1 && typeof o1.expiresAt === 'number'
        ? o1.expiresAt
        : ll && typeof ll.expiresAt === 'number'
          ? ll.expiresAt
          : null;
    if (hasLongLived) {
      logmod.log('oauth refresh ' + name + ': long-lived');
      return {
        account: name,
        status: 'long-lived',
        result: 'long-lived',
        expiresAt: exp,
      };
    }
    const deadWithoutRt = Boolean(
      o1 && o1.refreshToken === '' && typeof o1.expiresAt === 'number' && o1.expiresAt <= nowMs,
    );
    logmod.log('oauth refresh ' + name + ': not-refreshable');
    return {
      account: name,
      status: 'long-lived',
      result: 'not-refreshable',
      notRefreshable: true,
      deadWithoutRefreshToken: deadWithoutRt,
      expiresAt: exp,
    };
  }

  if (liveRtFp && rtFingerprint(blob1) === liveRtFp) {
    logmod.log('oauth refresh ' + name + ': held');
    return {
      account: name,
      status: 'held',
      result: 'held',
      reason: 'holds the live token',
      expiresAt: typeof o1.expiresAt === 'number' ? o1.expiresAt : null,
    };
  }

  const ea1 = typeof o1.expiresAt === 'number' ? o1.expiresAt : null;
  if (ea1 !== null && nowMs + leadMs < ea1) {
    logmod.log('oauth refresh ' + name + ': fresh');
    return {
      account: name,
      status: 'fresh',
      result: 'fresh',
      expiresAt: ea1,
      expiresInMs: ea1 - nowMs,
    };
  }

  const prev = state[name] || null;
  // Dead suppression: do not retry or re-alert until stored blob's expiresAt changes.
  if (
    !opts.force &&
    prev &&
    prev.lastResult === 'dead' &&
    prev.deadForExpiresAt !== undefined &&
    prev.deadForExpiresAt === ea1
  ) {
    logmod.log('oauth refresh ' + name + ': dead (cached)');
    return {
      account: name,
      status: 'dead',
      result: 'dead',
      error: prev.lastError || 'invalid_grant',
      httpStatus: prev.httpStatus || null,
      expiresAt: ea1,
      cached: true,
    };
  }

  // Transient backoff check: respect nextAttemptAt unless already expired and lastAttempt > 5m ago.
  if (!opts.force && prev && prev.lastResult === 'transient' && prev.nextAttemptAt) {
    const nextMs = Date.parse(prev.nextAttemptAt);
    const lastAttemptMs = prev.lastAttemptAt ? Date.parse(prev.lastAttemptAt) : 0;
    const alreadyExpired = ea1 !== null && nowMs >= ea1;
    const expiredOverride = alreadyExpired && (!lastAttemptMs || nowMs - lastAttemptMs >= 5 * 60 * 1000);
    if (!expiredOverride && Number.isFinite(nextMs) && nowMs < nextMs) {
      logmod.log('oauth refresh ' + name + ': transient (backoff)');
      return {
        account: name,
        status: 'transient',
        result: 'transient',
        backoff: true,
        error: prev.lastError || 'transient_error',
        httpStatus: prev.httpStatus || null,
        nextAttemptAt: prev.nextAttemptAt,
        expiresAt: ea1,
      };
    }
  }

  // 3. Acquire cross-process lock (unless lockHeld: true).
  let lockHandle = null;
  if (!opts.lockHeld) {
    const acquireFn = opts.acquireLock || lock.acquire;
    try {
      lockHandle = await acquireFn(ctx.configDir, {
        timeoutMs: opts.lockTimeoutMs !== undefined ? opts.lockTimeoutMs : 1500,
      });
    } catch (e) {
      logmod.log('oauth refresh ' + name + ': busy');
      return {
        account: name,
        status: 'busy',
        result: 'busy',
        expiresAt: ea1,
      };
    }
  }

  try {
    // 4. Re-read blob and live blob after taking the lock.
    let blob2 = null;
    try {
      blob2 = ctx.store.getProfile(name);
    } catch (e) {
      blob2 = null;
    }
    const d2 = parse(blob2);
    const o2 = d2 ? d2.claudeAiOauth : null;
    if (!o2 || typeof o2.refreshToken !== 'string' || !o2.refreshToken) {
      return {
        account: name,
        status: 'long-lived',
        result: 'long-lived',
        expiresAt: o2 && typeof o2.expiresAt === 'number' ? o2.expiresAt : null,
      };
    }
    let liveNowFp = liveRtFp;
    try {
      const liveNow = ctx.store.getLive();
      if (liveNow) liveNowFp = rtFingerprint(liveNow);
    } catch (e) {
      /* ignore */
    }
    if (liveNowFp && rtFingerprint(blob2) === liveNowFp) {
      logmod.log('oauth refresh ' + name + ': held');
      return {
        account: name,
        status: 'held',
        result: 'held',
        reason: 'holds the live token',
        expiresAt: typeof o2.expiresAt === 'number' ? o2.expiresAt : null,
      };
    }
    nowMs = nowMsOf(ctx, opts);
    const ea2 = typeof o2.expiresAt === 'number' ? o2.expiresAt : null;
    if (ea2 !== null && nowMs + leadMs < ea2) {
      logmod.log('oauth refresh ' + name + ': fresh');
      return {
        account: name,
        status: 'fresh',
        result: 'fresh',
        expiresAt: ea2,
        expiresInMs: ea2 - nowMs,
      };
    }

    // 5. Perform refresh with up to 2 within-run retries on transient failures.
    const sleep = opts.sleep || defaultSleep;
    const retryDelays = Array.isArray(opts.retryDelaysMs) ? opts.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS;
    let attempt = 0;
    let res = await refreshBlobDetailed(blob2, {
      fetch: opts.fetch,
      nowMs: nowMs,
      timeoutMs: opts.timeoutMs,
    });
    while (!res.ok && res.kind === 'transient' && attempt < 2) {
      const delay = retryDelays[attempt] !== undefined ? retryDelays[attempt] : 2000;
      await sleep(delay);
      attempt += 1;
      nowMs = nowMsOf(ctx, opts);
      res = await refreshBlobDetailed(blob2, {
        fetch: opts.fetch,
        nowMs: nowMs,
        timeoutMs: opts.timeoutMs,
      });
    }

    const nowIso = new Date(nowMs).toISOString();

    if (res.ok) {
      const freshParsed = parse(res.blob);
      const freshOauth = freshParsed && freshParsed.claudeAiOauth ? freshParsed.claudeAiOauth : null;
      const secretsToRedact = [
        o2.refreshToken,
        o2.accessToken,
        freshOauth && freshOauth.refreshToken,
        freshOauth && freshOauth.accessToken,
      ];
      // 6. Save atomically and verify with read-back (retry up to 3 times).
      let persisted = false;
      let persistErr = null;
      for (let w = 0; w <= 3; w++) {
        if (w > 0) {
          await sleep(opts.persistRetryDelayMs !== undefined ? opts.persistRetryDelayMs : 25 * w);
        }
        try {
          ctx.store.setProfile(name, res.blob);
          const readBack = ctx.store.getProfile(name);
          if (readBack === res.blob) {
            persisted = true;
            break;
          }
          persistErr = new Error('read-back verification mismatch');
        } catch (e) {
          persistErr = e;
        }
      }

      if (!persisted) {
        const fails = ((prev && prev.consecutiveFailures) || 0) + 1;
        const errClean = sanitizeError((persistErr && persistErr.message) || 'persist_failed', secretsToRedact);
        const alertKey = 'persist-failed:' + String(ea2);
        const shouldAlert = !prev || prev.alertedFor !== alertKey;
        state[name] = {
          lastAttemptAt: nowIso,
          lastSuccessAt: (prev && prev.lastSuccessAt) || null,
          lastResult: 'persist-failed',
          lastError: errClean,
          httpStatus: res.httpStatus || 200,
          consecutiveFailures: fails,
          nextAttemptAt: null,
          expiresAt: ea2,
          alertedFor: alertKey,
        };
        state._dirty = true;
        logmod.log('oauth refresh ' + name + ': persist-failed httpStatus=' + (res.httpStatus || 200));
        if (shouldAlert) {
          await emitRefreshAlert(ctx, name, 'persist-failed', errClean, res.httpStatus || 200, opts);
        }
        return {
          account: name,
          status: 'persist-failed',
          result: 'persist-failed',
          error: errClean,
          httpStatus: res.httpStatus || 200,
          expiresAt: ea2,
        };
      }

      const newEa = freshOauth && typeof freshOauth.expiresAt === 'number' ? freshOauth.expiresAt : null;
      const hadAlert = Boolean(prev && prev.alertedFor);
      state[name] = {
        lastAttemptAt: nowIso,
        lastSuccessAt: nowIso,
        lastResult: 'refreshed',
        lastError: null,
        httpStatus: res.httpStatus || 200,
        consecutiveFailures: 0,
        nextAttemptAt: null,
        expiresAt: newEa,
      };
      state._dirty = true;
      logmod.log('oauth refresh ' + name + ': refreshed httpStatus=' + (res.httpStatus || 200));
      if (hadAlert) {
        logmod.log('oauth refresh ' + name + ': recovered httpStatus=' + (res.httpStatus || 200));
        await emitRefreshAlert(ctx, name, 'recovered', null, res.httpStatus || 200, opts);
      }
      return {
        account: name,
        status: 'refreshed',
        result: 'refreshed',
        httpStatus: res.httpStatus || 200,
        expiresAt: newEa,
        expiresInMs: newEa !== null ? newEa - nowMs : null,
        retries: attempt,
      };
    }

    // 7. Refresh failed: classify dead vs transient, update state, alert if needed.
    const fails = ((prev && prev.consecutiveFailures) || 0) + 1;
    if (res.kind === 'dead') {
      const alertKey = 'dead:' + String(ea2);
      const shouldAlert = !prev || prev.alertedFor !== alertKey;
      state[name] = {
        lastAttemptAt: nowIso,
        lastSuccessAt: (prev && prev.lastSuccessAt) || null,
        lastResult: 'dead',
        lastError: res.error || 'invalid_grant',
        httpStatus: res.httpStatus != null ? res.httpStatus : null,
        consecutiveFailures: fails,
        nextAttemptAt: null,
        expiresAt: ea2,
        deadForExpiresAt: ea2,
        alertedFor: alertKey,
      };
      state._dirty = true;
      logmod.log('oauth refresh ' + name + ': dead httpStatus=' + (res.httpStatus != null ? res.httpStatus : 'none'));
      if (shouldAlert) {
        await emitRefreshAlert(ctx, name, 'dead', res.error || 'invalid_grant', res.httpStatus, opts);
      }
      return {
        account: name,
        status: 'dead',
        result: 'dead',
        error: res.error || 'invalid_grant',
        httpStatus: res.httpStatus != null ? res.httpStatus : null,
        expiresAt: ea2,
      };
    }

    // Transient failure: exponential backoff (5, 10, 20, 40, capped at 60 min).
    const backoffMin = Math.min(60, 5 * Math.pow(2, Math.max(0, fails - 1)));
    const nextAttemptAt = new Date(nowMs + backoffMin * 60 * 1000).toISOString();
    const alertKey = 'transient:' + String(ea2);
    const shouldAlert = fails >= 3 && (!prev || prev.alertedFor !== alertKey);
    state[name] = {
      lastAttemptAt: nowIso,
      lastSuccessAt: (prev && prev.lastSuccessAt) || null,
      lastResult: 'transient',
      lastError: res.error || 'transient_error',
      httpStatus: res.httpStatus != null ? res.httpStatus : null,
      consecutiveFailures: fails,
      nextAttemptAt: nextAttemptAt,
      expiresAt: ea2,
    };
    if (shouldAlert || (prev && prev.alertedFor === alertKey)) {
      state[name].alertedFor = alertKey;
    }
    state._dirty = true;
    logmod.log(
      'oauth refresh ' + name + ': transient httpStatus=' + (res.httpStatus != null ? res.httpStatus : 'none'),
    );
    if (shouldAlert) {
      await emitRefreshAlert(ctx, name, 'transient', res.error || 'transient_error', res.httpStatus, opts);
    }
    return {
      account: name,
      status: 'transient',
      result: 'transient',
      error: res.error || 'transient_error',
      httpStatus: res.httpStatus != null ? res.httpStatus : null,
      consecutiveFailures: fails,
      nextAttemptAt: nextAttemptAt,
      expiresAt: ea2,
    };
  } finally {
    if (typeof lockHandle === 'function') lockHandle();
    else if (lockHandle && typeof lockHandle.release === 'function') lockHandle.release();
  }
}

// Shared guarded refresh core: walks saved accounts (or opts.accounts) and refreshes every
// due OAuth account that is not currently in use or sharing the live refresh token.
async function refreshDue(ctx, opts) {
  opts = opts || {};
  const names = Array.isArray(opts.accounts) ? opts.accounts.slice() : profiles.list(ctx.configDir);

  let inUse;
  const inUseFn = opts.inUseAccounts || identity.inUseAccounts;
  try {
    inUse = inUseFn(ctx, opts.identityOpts) || { names: [], why: Object.create(null) };
  } catch (e) {
    logmod.log('oauth refresh: inUseAccounts failed, skipping all accounts');
    return {
      ok: true,
      refused: 'in-use-check-failed',
      results: [],
      refreshed: [],
      heldBack: names.slice(),
      heldWhy: Object.create(null),
    };
  }
  if (!inUse.why) {
    const why = Object.create(null);
    (inUse.names || []).forEach(function (n) {
      why[n] = 'the live login';
    });
    inUse = { names: inUse.names || [], why: why };
  }

  let liveRtFp = null;
  try {
    const liveBlob = ctx.store.getLive();
    if (liveBlob) liveRtFp = rtFingerprint(liveBlob);
  } catch (e) {
    liveRtFp = null;
  }

  const state = readRefreshState(ctx);
  const results = [];
  for (let i = 0; i < names.length; i++) {
    const r = await refreshOneInternal(ctx, names[i], inUse, liveRtFp, state, opts);
    results.push(r);
  }

  if (state._dirty || opts.recordRun) {
    delete state._dirty;
    state._meta = { lastRunAt: new Date(nowMsOf(ctx, opts)).toISOString() };
    try {
      writeRefreshState(ctx, state);
    } catch (e) {
      /* best effort */
    }
  }

  const heldBack = [];
  const heldWhy = Object.create(null);
  const nonHeld = [];
  results.forEach(function (r) {
    if (r.status === 'held') {
      heldBack.push(r.account);
      heldWhy[r.account] = r.reason || 'the live login';
    } else {
      nonHeld.push(r);
    }
  });

  const hasFatal = results.some(function (r) {
    return r.status === 'dead' || r.status === 'persist-failed';
  });

  return {
    ok: !hasFatal,
    results: results,
    refreshed: nonHeld,
    heldBack: heldBack,
    heldWhy: heldWhy,
  };
}

async function refreshAccount(ctx, name, opts) {
  const out = await refreshDue(
    ctx,
    Object.assign({}, opts, {
      accounts: [name],
    }),
  );
  if (out.refused) {
    return { account: name, status: 'skipped', result: 'skipped', reason: out.refused };
  }
  return out.results[0] || { account: name, status: 'skipped', result: 'skipped' };
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function fmtHHMM(msOrIso, useUtc) {
  const ms = typeof msOrIso === 'number' ? msOrIso : Date.parse(msOrIso);
  if (!Number.isFinite(ms)) return '??:??';
  const d = new Date(ms);
  if (useUtc) return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

// Compact duration for status/list lines: '6h58m', '3h', '45m', '12d'.
function formatDurationCompact(ms) {
  const totalMin = Math.max(0, Math.round(Math.abs(ms) / 60000));
  if (totalMin >= 60 * 48) {
    return Math.floor(totalMin / 1440) + 'd';
  }
  if (totalMin >= 60) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m > 0 ? h + 'h' + m + 'm' : h + 'h';
  }
  return totalMin + 'm';
}

// Space-separated duration for `keyflip refresh`: 'expires in 3h 0m' or 'expires in 45m'.
function formatExpiresIn(ms) {
  const totalMin = Math.max(0, Math.round(Math.abs(ms) / 60000));
  if (totalMin >= 60) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h + 'h ' + m + 'm';
  }
  return totalMin + 'm';
}

// Compute token expiry & last-refresh visibility metadata for an account (never returns any token).
function tokenStatusForAccount(ctx, name, opts) {
  opts = opts || {};
  const nowMs = nowMsOf(ctx, opts);
  let rawBlob = null;
  if (opts.isLive || (opts.liveAccount && opts.liveAccount === name)) {
    try {
      rawBlob = ctx.store.getLive();
    } catch (e) {
      rawBlob = null;
    }
  }
  if (!rawBlob) {
    try {
      rawBlob = ctx.store.getProfile(name);
    } catch (e) {
      rawBlob = null;
    }
  }
  const d = parse(rawBlob);
  let o = d ? d.claudeAiOauth : null;
  const ll = readLongLivedBlob(ctx, name);

  let tokenKind = 'none';
  let expiresAtMs = null;
  let refreshable = false;

  if (o && typeof o.accessToken === 'string' && o.accessToken) {
    if (typeof o.refreshToken === 'string' && o.refreshToken) {
      tokenKind = 'oauth';
      expiresAtMs = typeof o.expiresAt === 'number' ? o.expiresAt : null;
      refreshable = true;
    } else if (
      typeof o.expiresAt === 'number' &&
      o.expiresAt <= nowMs &&
      ll &&
      ll.accessToken &&
      (typeof ll.expiresAt !== 'number' || ll.expiresAt > nowMs)
    ) {
      // Dead normal login covered by a valid one-year token.
      tokenKind = 'long-lived';
      expiresAtMs = typeof ll.expiresAt === 'number' ? ll.expiresAt : null;
    } else if (o.refreshToken === '') {
      // OAuth login whose refresh token was cleared/exhausted.
      tokenKind = 'oauth';
      expiresAtMs = typeof o.expiresAt === 'number' ? o.expiresAt : null;
      refreshable = false;
    } else {
      tokenKind = 'long-lived';
      expiresAtMs = typeof o.expiresAt === 'number' ? o.expiresAt : null;
    }
  } else if (ll && ll.accessToken) {
    tokenKind = 'long-lived';
    expiresAtMs = typeof ll.expiresAt === 'number' ? ll.expiresAt : null;
  }

  const stAll = opts.refreshState || (ctx && ctx.configDir ? readRefreshState(ctx) : {});
  const st = stAll && stAll[name] ? stAll[name] : null;
  const lastRefresh =
    st && st.lastAttemptAt
      ? {
          at: st.lastAttemptAt,
          result: st.lastResult || null,
          error: st.lastError || null,
        }
      : {
          at: null,
          result: null,
          error: null,
        };

  return {
    account: name,
    tokenExpiresAt: expiresAtMs !== null ? new Date(expiresAtMs).toISOString() : null,
    tokenExpiresAtMs: expiresAtMs,
    tokenKind: tokenKind,
    refreshable: refreshable,
    lastRefresh: lastRefresh,
  };
}

// Render the human token status fragment, e.g.:
//   token: expires 18:42 (in 6h58m) · refreshed 11:44 ✓
//   token: EXPIRED 3h ago · refresh failed 11:44 (refresh token rejected) — run: keyflip login yahoo
//   token: long-lived until 2027-10-18 · no refresh needed
function formatTokenStatusLine(info, opts) {
  opts = opts || {};
  if (!info || info.tokenKind === 'none') {
    return 'token: none';
  }
  const nowMs = opts.nowMs !== undefined ? opts.nowMs : Date.now();
  const useUtc = Boolean(opts.utc);
  const expMs =
    typeof info.tokenExpiresAtMs === 'number'
      ? info.tokenExpiresAtMs
      : info.tokenExpiresAt
        ? Date.parse(info.tokenExpiresAt)
        : null;

  if (info.tokenKind === 'long-lived') {
    if (expMs !== null && Number.isFinite(expMs)) {
      if (expMs <= nowMs) {
        return (
          'token: long-lived EXPIRED ' +
          formatDurationCompact(nowMs - expMs) +
          ' ago' +
          (info.account ? ' — run: keyflip login --long-lived ' + info.account : '')
        );
      }
      const dateStr = new Date(expMs).toISOString().slice(0, 10);
      return 'token: long-lived until ' + dateStr + ' · no refresh needed';
    }
    return 'token: long-lived · no refresh needed';
  }

  // OAuth token
  let head;
  const isExpired = expMs !== null && Number.isFinite(expMs) && expMs <= nowMs;
  if (expMs === null || !Number.isFinite(expMs)) {
    head = 'token: oauth';
  } else if (isExpired) {
    head = 'token: EXPIRED ' + formatDurationCompact(nowMs - expMs) + ' ago';
  } else {
    head = 'token: expires ' + fmtHHMM(expMs, useUtc) + ' (in ' + formatDurationCompact(expMs - nowMs) + ')';
  }

  const lr = info.lastRefresh || {};
  let tail = '';
  if (lr.result === 'refreshed' && lr.at) {
    tail = ' · refreshed ' + fmtHHMM(lr.at, useUtc) + ' ✓';
  } else if (lr.result === 'dead' || lr.result === 'persist-failed' || lr.result === 'transient') {
    const atStr = lr.at ? ' ' + fmtHHMM(lr.at, useUtc) : '';
    const detail =
      lr.result === 'dead'
        ? 'refresh token rejected'
        : lr.result === 'persist-failed'
          ? 'could not save refreshed token'
          : lr.error || 'transient error';
    const loginHint =
      (lr.result === 'dead' || lr.result === 'persist-failed' || isExpired) && info.account
        ? ' — run: keyflip login ' + info.account
        : '';
    tail = ' · refresh failed' + atStr + ' (' + detail + ')' + loginHint;
  } else if (isExpired && info.account) {
    tail = ' — run: keyflip login ' + info.account;
  }

  return head + tail;
}

export {
  isExpiring,
  isDue,
  leadMinutesOf,
  refreshBlob,
  refreshBlobDetailed,
  maybeRefreshProfile,
  refreshDue,
  refreshAccount,
  readRefreshState,
  writeRefreshState,
  refreshStatePath,
  lastRefreshRunAt,
  tokenStatusForAccount,
  formatTokenStatusLine,
  formatDurationCompact,
  formatExpiresIn,
  OAUTH_TOKEN_URL,
  OAUTH_CLIENT_ID,
  EXPIRY_BUFFER_MS,
  DEFAULT_LEAD_MINUTES,
  REFRESH_STATE_FILE,
};
