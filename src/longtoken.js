// `keyflip login <account> --long-lived` — a ONE-YEAR Claude Code credential, minted with the same
// official OAuth flow `claude setup-token` uses, so the CLI stops asking for a sign-in every time a
// six-day token dies unused.
//
// What Claude Code itself does (read out of the installed 2.1.x binary, not guessed):
//   authorize  https://claude.com/cai/oauth/authorize  code=true, client_id=<Claude Code's>,
//              scope=user:inference, PKCE S256, redirect_uri=http://localhost:<port>/callback
//   exchange   POST https://platform.claude.com/v1/oauth/token  grant_type=authorization_code
//              … expires_in=31536000   (the one difference from a normal login)
//   response   access_token, scope, expires_in, account{uuid,email_address}, organization{uuid}
//
// The trade-off, stated where it is decided: the token is INFERENCE-ONLY. Chatting, coding and tools
// work; claude.ai-only features (Remote Control, Claude in Chrome, profile/usage endpoints) need a
// full `claude auth login`. That is why a long-lived token is kept as a FALLBACK next to the normal
// login: the full login is used while it is alive, the one-year token takes over when it is not.
//
// SECURITY: the token never reaches stdout, argv, a log line or the git state repo. It goes from the
// HTTPS response straight into the credential store (Keychain on macOS, a 0600 file elsewhere).
// Only the identity (email/org) and the expiry DATE are ever returned to a caller.
import crypto from 'crypto';
import http from 'http';
import fs from 'fs';
import { OAUTH_TOKEN_URL, OAUTH_CLIENT_ID } from './oauth.js';

const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const SUCCESS_URL = 'https://platform.claude.com/oauth/code/success?app=claude-code';
const SCOPE = 'user:inference';
const LIFETIME_S = 31536000; // 365 days — the value Claude Code's setup-token sends
const WAIT_MS = 10 * 60 * 1000; // room for a magic-link sign-in before the Authorize click

let VERSION = '0.0.0';
try {
  VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
} catch (e) {
  /* ignore */
}

// The store slot that keeps an account's one-year token beside its normal login. Same scheme as
// `provider__<name>`: a keyflip-owned Keychain item, never a json file in the state repo.
function storeName(name) {
  return 'longlived__' + name;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pkce(rand) {
  const r = rand || crypto.randomBytes;
  const verifier = b64url(r(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier: verifier, challenge: challenge, state: b64url(r(32)) };
}

function redirectUri(port) {
  return 'http://localhost:' + port + '/callback';
}

// The URL the human opens. It carries the PKCE CHALLENGE and the state, never a secret.
function authorizeUrl(p) {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.append('code', 'true');
  u.searchParams.append('client_id', OAUTH_CLIENT_ID);
  u.searchParams.append('response_type', 'code');
  u.searchParams.append('redirect_uri', redirectUri(p.port));
  u.searchParams.append('scope', SCOPE);
  u.searchParams.append('code_challenge', p.challenge);
  u.searchParams.append('code_challenge_method', 'S256');
  u.searchParams.append('state', p.state);
  if (p.orgUUID) u.searchParams.append('orgUUID', p.orgUUID);
  if (p.email) u.searchParams.append('login_hint', p.email);
  return u.toString();
}

function parseBlob(blob) {
  try {
    const d = JSON.parse(blob);
    return d && d.claudeAiOauth && typeof d.claudeAiOauth === 'object' ? d.claudeAiOauth : null;
  } catch (e) {
    return null;
  }
}

// Shape, not a marker field: Claude Code rewrites its credential item in its own format, so a flag
// of ours would not survive. An inference-only scope with no refresh token IS a setup-token.
function isLongLived(blob) {
  const o = parseBlob(blob);
  if (!o) return false;
  const scopes = Array.isArray(o.scopes) ? o.scopes : [];
  return !o.refreshToken && scopes.indexOf(SCOPE) !== -1 && scopes.indexOf('user:profile') === -1;
}

// Usable right now: parses, has an access token, and is not past its expiry.
function isUsable(blob, nowMs) {
  const o = parseBlob(blob);
  if (!o || typeof o.accessToken !== 'string' || !o.accessToken) return false;
  if (typeof o.expiresAt !== 'number') return true;
  return o.expiresAt > (nowMs !== undefined ? nowMs : Date.now());
}

// Dead for good: expired and nothing can refresh it. A normal login that is merely expired but
// still holds a refresh token is NOT dead — `keyflip refresh` revives it, and it is the better token.
function isDead(blob, nowMs) {
  const o = parseBlob(blob);
  if (!o) return true;
  if (isUsable(blob, nowMs)) return false;
  return !(typeof o.refreshToken === 'string' && o.refreshToken.length > 0);
}

// The token response -> the credential blob Claude Code reads from its Keychain item. The refresh
// token is deliberately NOT kept even if one were returned: rotating it would trade the one-year
// lifetime for a normal six-day one, which is the whole problem this exists to remove.
function toBlob(j, opts) {
  opts = opts || {};
  const now = opts.now !== undefined ? opts.now : Date.now();
  const prev = (opts.prev && parseBlob(opts.prev)) || {};
  const scopes = j.scope ? String(j.scope).split(' ').filter(Boolean) : [SCOPE];
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: j.access_token,
      expiresAt: now + (typeof j.expires_in === 'number' ? j.expires_in : LIFETIME_S) * 1000,
      scopes: scopes,
      subscriptionType: prev.subscriptionType || null,
      rateLimitTier: prev.rateLimitTier || null,
    },
  });
}

function identity(j) {
  return {
    email: (j && j.account && j.account.email_address) || null,
    accountUuid: (j && j.account && j.account.uuid) || null,
    org: (j && j.organization && j.organization.uuid) || null,
  };
}

// One loopback listener for the browser's redirect. Binds 127.0.0.1 only (never the LAN), checks the
// state, and hands the open response back so the page can be redirected AFTER the exchange.
function listen(state, opts) {
  opts = opts || {};
  const H = opts.http || http;
  let resolveCode, rejectCode;
  const got = new Promise(function (res, rej) {
    resolveCode = res;
    rejectCode = rej;
  });
  got.catch(function () {
    /* handled by whoever awaits `got`; this only silences an early, not-yet-awaited rejection */
  });
  const handler = function (req, res) {
    let u;
    try {
      u = new URL(req.url, 'http://localhost');
    } catch (e) {
      res.writeHead(400);
      res.end();
      return;
    }
    if (u.pathname !== '/callback') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (u.searchParams.get('state') !== state) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('keyflip: state mismatch — this was not the sign-in keyflip started. Close this tab.');
      return;
    }
    const err = u.searchParams.get('error');
    const code = u.searchParams.get('code');
    if (err || !code) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('keyflip: the authorization was not granted (' + (err || 'no code') + '). You can close this tab.');
      rejectCode(
        Object.assign(new Error('authorization was not granted (' + (err || 'no code') + ')'), {
          code: 'denied',
        }),
      );
      return;
    }
    resolveCode({ code: code, res: res });
  };
  // The redirect says `localhost`, which a browser may resolve to ::1 first. Listen on both loopback
  // addresses with the same port (the IPv6 one is best-effort: no IPv6 loopback, no problem).
  const server = H.createServer(handler);
  let server6 = null;
  const ready = new Promise(function (res, rej) {
    server.once('error', rej);
    server.listen(opts.port || 0, '127.0.0.1', function () {
      const port = server.address().port;
      try {
        server6 = H.createServer(handler);
        // If ::1 cannot bind, 'error' fires instead of the listen callback — carry on with IPv4.
        server6.once('error', function () {
          server6 = null;
          res(port);
        });
        server6.listen(port, '::1', function () {
          res(port);
        });
      } catch (e) {
        res(port);
      }
    });
  });
  const timer = setTimeout(function () {
    rejectCode(Object.assign(new Error('no authorization arrived within the time limit'), { code: 'timeout' }));
  }, opts.waitMs || WAIT_MS);
  if (timer.unref) timer.unref();
  return {
    ready: ready,
    got: got,
    close: function () {
      clearTimeout(timer);
      [server, server6].forEach(function (s) {
        try {
          if (s) s.close();
          // A browser keeps its socket alive after the redirect; do not let it hold the CLI open.
          if (s && typeof s.closeAllConnections === 'function') s.closeAllConnections();
        } catch (e) {
          /* already closed */
        }
      });
    },
  };
}

async function exchange(code, p, opts) {
  opts = opts || {};
  const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) throw Object.assign(new Error('no fetch available in this Node'), { code: 'no-fetch' });
  const res = await doFetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'keyflip/' + VERSION },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri(p.port),
      client_id: OAUTH_CLIENT_ID,
      code_verifier: p.verifier,
      state: p.state,
      expires_in: LIFETIME_S,
    }),
    signal:
      typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(opts.timeoutMs || 30000)
        : undefined,
  });
  if (!res || !res.ok)
    throw Object.assign(new Error('token exchange failed (http ' + ((res && res.status) || '?') + ')'), {
      code: 'exchange-failed',
    });
  const j = await res.json();
  if (!j || !j.access_token)
    throw Object.assign(new Error('token exchange returned no access token'), { code: 'exchange-failed' });
  return j;
}

// The whole ceremony. opts: { email, org (expected), open(url), print(msg), fetch, http, now, waitMs }
// Resolves { email, org, expiresAt (ISO), blob } — `blob` is for the CALLER TO STORE, never to print.
async function mint(opts) {
  opts = opts || {};
  const p = pkce(opts.rand);
  const l = listen(p.state, opts);
  try {
    p.port = await l.ready;
    const url = authorizeUrl({ port: p.port, challenge: p.challenge, state: p.state, email: opts.email });
    if (opts.print) opts.print(url);
    if (opts.open) opts.open(url);
    const hit = await l.got;
    // Finish the browser's response BEFORE close() tears the sockets down, or the tab never gets it.
    const reply = function (status, headers, body) {
      return new Promise(function (resolve) {
        hit.res.once('finish', resolve);
        hit.res.once('close', resolve);
        hit.res.writeHead(status, Object.assign({ Connection: 'close' }, headers));
        hit.res.end(body);
      });
    };
    let j;
    try {
      j = await exchange(hit.code, p, opts);
    } catch (e) {
      await reply(
        500,
        { 'content-type': 'text/plain' },
        'keyflip: the token exchange failed. Nothing was saved. You can close this tab.',
      );
      throw e;
    }
    await reply(302, { Location: SUCCESS_URL });
    const id = identity(j);
    // The browser signs in as whoever claude.ai already knows — refuse a token for the wrong person
    // before it is stored anywhere, exactly like `keyflip login --email` does.
    const want = (opts.email || '').toLowerCase();
    if ((want && id.email && id.email.toLowerCase() !== want) || (opts.org && id.org && opts.org !== id.org)) {
      throw Object.assign(
        new Error(
          'the browser authorized ' + (id.email || 'another account') + ', not ' + (opts.email || 'this account'),
        ),
        { code: 'mismatch', actual: id.email },
      );
    }
    const now = opts.now !== undefined ? opts.now : Date.now();
    const blob = toBlob(j, { now: now, prev: opts.prev });
    return {
      email: id.email,
      org: id.org,
      expiresAt: new Date(parseBlob(blob).expiresAt).toISOString(),
      blob: blob,
    };
  } finally {
    l.close();
  }
}

// What the CLI should actually be handed for <name>: its normal login while that is alive or
// refreshable, the one-year token when the normal login is dead. Returns { blob, source } with
// source 'profile' | 'long-lived' | 'none'. Never throws (a locked store reads as "nothing extra").
function pick(store, name, nowMs) {
  let blob = null,
    ll = null;
  try {
    blob = store.getProfile(name);
  } catch (e) {
    blob = null;
  }
  try {
    ll = store.getProfile(storeName(name));
  } catch (e) {
    ll = null;
  }
  const llOk = !!ll && isUsable(ll, nowMs);
  if (blob && !isDead(blob, nowMs)) return { blob: blob, source: 'profile', fallback: llOk };
  if (llOk) return { blob: ll, source: 'long-lived', fallback: true };
  return { blob: blob, source: blob ? 'profile' : 'none', fallback: false };
}

// The stored one-year token's expiry, for reports. Never the value.
function info(store, name, nowMs) {
  let ll = null;
  try {
    ll = store.getProfile(storeName(name));
  } catch (e) {
    return null;
  }
  const o = ll && parseBlob(ll);
  if (!o) return null;
  const now = nowMs !== undefined ? nowMs : Date.now();
  const left = typeof o.expiresAt === 'number' ? (o.expiresAt - now) / 86400000 : null;
  return {
    expiresAt: typeof o.expiresAt === 'number' ? new Date(o.expiresAt).toISOString() : null,
    daysLeft: left === null ? null : Math.floor(left),
    usable: isUsable(ll, now),
  };
}

export {
  AUTHORIZE_URL,
  SUCCESS_URL,
  SCOPE,
  LIFETIME_S,
  storeName,
  pkce,
  authorizeUrl,
  redirectUri,
  isLongLived,
  isUsable,
  isDead,
  toBlob,
  identity,
  listen,
  exchange,
  mint,
  pick,
  info,
};
