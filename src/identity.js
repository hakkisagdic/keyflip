// P2: WHICH account is the live CLI login — decided by the credential itself, not by the
// ~/.claude.json label.
//
// The label (oauthAccount.emailAddress) is derived metadata. It drifted on this machine: the live
// credential was the gmail account's token while the label said yahoo, so `status`, `list`, MCP and
// autoswitch all reported the wrong account, read gmail's usage as yahoo's — and the pre-switch
// "preserve the outgoing token" step saved gmail's token INTO yahoo's profile.
//
// Resolution order (first hit wins):
//   1. token-cache  — a fingerprint of the live access token seen before (local file, no secrets)
//   2. token-match  — exactly ONE saved profile holds the same access or refresh token (offline)
//   3. token-profile — the OAuth profile endpoint, asked with the live token (async callers only)
//   4. label        — ~/.claude.json, flagged as such
// Only the endpoint's answer is VERIFIED. The offline answers (cache of a keyflip save, exact match)
// trust keyflip's own store — and the store is exactly what label-based saving damaged (gmail's
// token saved under yahoo's name), so an offline verdict never repairs a label or names a profile to
// overwrite. resolveLive asks the endpoint once per token until it has a verified answer.
// Fingerprints are truncated SHA-256 of a token: never the token, never reversible, never versioned
// (the cache file is gitignored and skipped by backups).
//
// The endpoint needs the `user:profile` scope. An inference-only token (`keyflip login --long-lived`,
// `claude setup-token`: scope `user:inference`) gets a 403 there every time, so it is not asked at
// all and the answer stays offline. For that case the owner has `keyflip status --fix --force`
// (repairForced): it accepts a fingerprint match to the account's LOGIN capture, never anything weaker.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as profiles from './profiles.js';
import * as claude from './claude.js';
import * as longtoken from './longtoken.js';
import { atomicWrite } from './fsutil.js';

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const PROFILE_SCOPE = 'user:profile';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const CACHE_FILE = '.identity-cache.json';
const CACHE_MAX = 64;
const MISS_TTL_MS = 10 * 60 * 1000; // re-ask the endpoint about an unknown token at most this often

let VERSION = '0.0.0';
try {
  VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
} catch (e) {
  /* ignore */
}

function oauthOf(blob) {
  try {
    const o = JSON.parse(blob).claudeAiOauth;
    return o && typeof o === 'object' ? o : null;
  } catch (e) {
    return null;
  }
}
function fp(s) {
  return typeof s === 'string' && s ? crypto.createHash('sha256').update(s).digest('hex').slice(0, 24) : null;
}
function fingerprints(blob) {
  const o = oauthOf(blob);
  return { access: o ? fp(o.accessToken) : null, refresh: o ? fp(o.refreshToken) : null };
}
// The scopes a credential was granted (metadata, not a secret), or null when it does not say.
function scopesOf(blob) {
  const o = oauthOf(blob);
  return o && Array.isArray(o.scopes)
    ? o.scopes.filter(function (s) {
        return typeof s === 'string';
      })
    : null;
}
// Can the profile endpoint answer for this credential? Only with `user:profile`; a credential that
// does not list its scopes is asked as before.
function canAskProfile(blob) {
  const s = scopesOf(blob);
  return !s || s.indexOf(PROFILE_SCOPE) !== -1;
}

function cachePath(ctx) {
  return path.join(ctx.configDir, CACHE_FILE);
}
function readCache(ctx) {
  const c = Object.create(null);
  try {
    const j = JSON.parse(fs.readFileSync(cachePath(ctx), 'utf8'));
    if (j && typeof j === 'object' && !Array.isArray(j)) Object.assign(c, j);
  } catch (e) {
    /* none */
  }
  return c;
}
function writeCache(ctx, c) {
  const keys = Object.keys(c).sort(function (a, b) {
    return (c[b].at || 0) - (c[a].at || 0);
  });
  const out = {};
  keys.slice(0, CACHE_MAX).forEach(function (k) {
    out[k] = c[k];
  });
  try {
    atomicWrite(cachePath(ctx), JSON.stringify(out), 0o600);
  } catch (e) {
    /* best effort */
  }
}
function nowOf(opts) {
  return opts && opts.nowMs !== undefined ? opts.nowMs : Date.now();
}

// The label's view: ~/.claude.json's email and the saved profile carrying it.
function labelOf(ctx) {
  const acc = claude.currentAccount(claude.readConfig(ctx.claudeConfigPath));
  const email = acc ? acc.email : '';
  let name = null;
  if (email)
    profiles.list(ctx.configDir).forEach(function (n) {
      if (!name && profiles.email(ctx.configDir, n) === email) name = n;
    });
  return { email: email || null, name: name };
}

// Saved profiles whose stored credential (the normal login or its one-year token) carries the live
// access or refresh token. Reads the store once per profile; called only on a cache miss.
function holdersOf(ctx, live) {
  const out = [];
  if (!live.access && !live.refresh) return out;
  profiles.list(ctx.configDir).forEach(function (n) {
    [n, longtoken.storeName(n)].some(function (storeName) {
      let b = null;
      try {
        b = ctx.store.getProfile(storeName);
      } catch (e) {
        b = null;
      }
      if (!b) return false;
      const f = fingerprints(b);
      const hit = (live.access && f.access === live.access) || (live.refresh && f.refresh === live.refresh);
      if (hit) out.push(n);
      return hit;
    });
  });
  return out;
}

// Does profile `name` (normal login or one-year token) still hold the live token?
function holds(ctx, name, live) {
  return [name, longtoken.storeName(name)].some(function (storeName) {
    let b = null;
    try {
      b = ctx.store.getProfile(storeName);
    } catch (e) {
      b = null;
    }
    if (!b) return false;
    const f = fingerprints(b);
    return !!((live.access && f.access === live.access) || (live.refresh && f.refresh === live.refresh));
  });
}

// An identity from the profile endpoint -> the saved profile it belongs to.
function profileFor(ctx, id) {
  const names = profiles.list(ctx.configDir);
  const metas = names.map(function (n) {
    return { name: n, meta: profiles.read(ctx.configDir, n) || {} };
  });
  function oa(m) {
    return (m.meta && m.meta.oauthAccount) || {};
  }
  let hit = null;
  if (id.accountUuid)
    hit = metas.find(function (m) {
      return oa(m).accountUuid && oa(m).accountUuid === id.accountUuid;
    });
  if (!hit && id.email) {
    const e = String(id.email).toLowerCase();
    hit = metas.find(function (m) {
      return String(m.meta.email || oa(m).emailAddress || '').toLowerCase() === e;
    });
  }
  if (!hit && id.org) {
    const byOrg = metas.filter(function (m) {
      return oa(m).organizationUuid === id.org;
    });
    if (byOrg.length === 1) hit = byOrg[0];
  }
  return hit ? hit.name : null;
}

// GET /api/oauth/profile with the live token -> { accountUuid, email, org } | { httpStatus }.
async function fetchProfile(token, opts) {
  opts = opts || {};
  // The test suite sets KEYFLIP_TEST_OFFLINE so a spawned CLI never sends a fixture token to
  // Anthropic; tests that exercise the endpoint inject their own fetch.
  const doFetch = opts.fetch || (typeof fetch !== 'undefined' && !process.env.KEYFLIP_TEST_OFFLINE ? fetch : null);
  if (!doFetch || !token) return { identity: null, httpStatus: null };
  try {
    const res = await doFetch(PROFILE_URL, {
      headers: {
        Authorization: 'Bearer ' + token,
        'anthropic-beta': OAUTH_BETA_HEADER,
        'User-Agent': 'keyflip/' + VERSION,
      },
      signal:
        typeof AbortSignal !== 'undefined' && AbortSignal.timeout
          ? AbortSignal.timeout(opts.timeoutMs || 5000)
          : undefined,
    });
    if (!res || !res.ok) return { identity: null, httpStatus: (res && res.status) || null };
    const j = await res.json();
    const acc = (j && j.account) || {};
    const org = (j && j.organization) || {};
    const id = {
      accountUuid: typeof acc.uuid === 'string' ? acc.uuid : null,
      email:
        typeof acc.email === 'string' ? acc.email : typeof acc.email_address === 'string' ? acc.email_address : null,
      org: typeof org.uuid === 'string' ? org.uuid : null,
    };
    return { identity: id.accountUuid || id.email ? id : null, httpStatus: res.status };
  } catch (e) {
    return { identity: null, httpStatus: null };
  }
}

function finish(r, label) {
  r.labelEmail = label.email;
  r.labelName = label.name;
  if (!r.source) {
    // Unresolved: the label is all there is, and it is reported as such.
    r.name = label.name;
    r.email = label.email;
    r.source = r.hasLive ? 'label' : null;
  }
  r.mismatch = !!(
    r.source &&
    r.source !== 'label' &&
    ((r.name && label.name && r.name !== label.name) ||
      (r.email && label.email && String(r.email).toLowerCase() !== String(label.email).toLowerCase()))
  );
  return r;
}

// Offline (sync): cache, then an exact token match. Never touches the network.
// -> { name, email, source, hasLive, labelName, labelEmail, mismatch, sharedBy? }
function liveSync(ctx, opts) {
  opts = opts || {};
  const label = labelOf(ctx);
  let live = null;
  try {
    live = ctx.store.getLive();
  } catch (e) {
    return finish({ name: null, email: null, source: null, hasLive: null, unreadable: true }, label);
  }
  if (!live) return finish({ name: null, email: null, source: null, hasLive: false }, label);
  const f = fingerprints(live);
  const r = { name: null, email: null, source: null, hasLive: true };
  if (!f.access && !f.refresh) return finish(r, label); // an opaque/non-OAuth credential
  const cache = readCache(ctx);
  const hit = f.access ? cache[f.access] : null;
  // A token saved under two names decides nothing: only the endpoint can say whose it is.
  if (hit && hit.shared) {
    r.sharedBy = hit.shared;
    return finish(r, label);
  }
  if (hit && hit.source === 'token-profile' && hit.name && profiles.exists(ctx.configDir, hit.name)) {
    r.name = hit.name;
    r.email = hit.email || profiles.email(ctx.configDir, hit.name) || null;
    r.source = 'token-cache';
    r.verified = true;
    if (Array.isArray(hit.wrongIn) && hit.wrongIn.length) r.wrongCredentialIn = hit.wrongIn.slice();
    return finish(r, label);
  }
  if (hit && !hit.name && hit.source === 'token-profile' && hit.email) {
    // The endpoint named an account keyflip has no profile for (yet: a profile saved for it since).
    const named = profileFor(ctx, { accountUuid: hit.accountUuid || null, email: hit.email, org: null });
    r.email = hit.email;
    r.source = 'token-cache';
    r.verified = true;
    if (named) r.name = named;
    else {
      r.unsaved = true;
      r.accountUuid = hit.accountUuid || null;
      r.org = hit.org || null;
    }
    return finish(r, label);
  }
  // An unverified cache entry (a keyflip save) counts only while that profile still holds the token:
  // then writing the live token there is a no-op, never an overwrite.
  if (hit && hit.name && hit.source !== 'token-profile' && profiles.exists(ctx.configDir, hit.name)) {
    if (holds(ctx, hit.name, f)) {
      r.name = hit.name;
      r.email = hit.email || profiles.email(ctx.configDir, hit.name) || null;
      r.source = 'token-cache';
      r.verified = false;
      return finish(r, label);
    }
  }
  if (hit && hit.offlineMiss && nowOf(opts) - (hit.at || 0) < MISS_TTL_MS) {
    if (hit.sharedBy) r.sharedBy = hit.sharedBy;
    return finish(r, label);
  }
  const holders = holdersOf(ctx, f);
  if (holders.length === 1) {
    r.name = holders[0];
    r.email = profiles.email(ctx.configDir, holders[0]) || null;
    r.source = 'token-match';
    r.verified = false;
    if (f.access) {
      cache[f.access] = { name: r.name, email: r.email, source: 'token-match', at: nowOf(opts) };
      writeCache(ctx, cache);
    }
    return finish(r, label);
  }
  // Two profiles holding one token means one of them was overwritten with the other's login — the
  // exact damage label-based saving did. Only the endpoint can say which one it really is.
  if (holders.length > 1) r.sharedBy = holders;
  if (f.access) {
    cache[f.access] = Object.assign(
      { offlineMiss: true, at: nowOf(opts) },
      holders.length > 1 ? { sharedBy: holders } : {},
    );
    writeCache(ctx, cache);
  }
  return finish(r, label);
}

// Async: liveSync, then the profile endpoint when still unresolved (network: false skips it).
async function resolveLive(ctx, opts) {
  opts = opts || {};
  const s = liveSync(ctx, opts);
  // A verified answer (the endpoint's, cached by fingerprint) is final; anything else — the label,
  // or an offline match that trusts keyflip's own store — is checked with the endpoint once.
  if (s.verified || !s.hasLive || opts.network === false) return s;
  let live = null;
  try {
    live = ctx.store.getLive();
  } catch (e) {
    return s;
  }
  const o = oauthOf(live);
  const f = fingerprints(live);
  if (!o || !o.accessToken || !f.access) return s;
  // An inference-only token gets a 403 from the profile endpoint by design: asking is a wasted request.
  if (!canAskProfile(live)) return Object.assign(s, { profileScope: false, scopes: scopesOf(live) });
  const cache = readCache(ctx);
  const prev = cache[f.access];
  if (prev && prev.endpointMiss && nowOf(opts) - (prev.at || 0) < MISS_TTL_MS) return s;
  const r = await fetchProfile(o.accessToken, opts);
  if (!r.identity) {
    cache[f.access] = Object.assign({}, prev || {}, { endpointMiss: true, httpStatus: r.httpStatus, at: nowOf(opts) });
    writeCache(ctx, cache);
    return Object.assign(s, { endpointStatus: r.httpStatus });
  }
  const name = profileFor(ctx, r.identity);
  // Every OTHER profile holding this token stores this account's login under its own name — the
  // damage label-based saving did. Switching "to" one of them would put this account live again.
  const wrongIn = holdersOf(ctx, f).filter(function (n) {
    return n !== name;
  });
  cache[f.access] = {
    name: name,
    email: r.identity.email,
    accountUuid: r.identity.accountUuid,
    org: r.identity.org,
    source: 'token-profile',
    at: nowOf(opts),
  };
  if (wrongIn.length) cache[f.access].wrongIn = wrongIn;
  writeCache(ctx, cache);
  const label = labelOf(ctx);
  const out = { name: name, email: r.identity.email, source: 'token-profile', hasLive: true, verified: true };
  if (s.sharedBy) out.sharedBy = s.sharedBy;
  if (wrongIn.length) out.wrongCredentialIn = wrongIn;
  if (!name) {
    out.unsaved = true; // a real account keyflip has no profile for
    out.accountUuid = r.identity.accountUuid;
    out.org = r.identity.org;
  }
  return finish(out, label);
}

// Remember that `blob` is `name`'s credential (called when keyflip itself saves one). The same
// token saved under a second name is recorded as SHARED — ambiguous, never a verdict.
function noteSaved(ctx, name, blob, opts) {
  const f = fingerprints(blob);
  if (!f.access) return;
  const cache = readCache(ctx);
  const prev = cache[f.access];
  if (prev && prev.source === 'token-profile' && !prev.name && prev.email) {
    // The endpoint named this account before it had a profile; this save is that profile.
    if (String(profiles.email(ctx.configDir, name) || '').toLowerCase() === String(prev.email).toLowerCase()) {
      cache[f.access] = Object.assign({}, prev, { name: name });
      writeCache(ctx, cache);
    }
    return;
  }
  if (prev && prev.source !== 'token-profile' && ((prev.name && prev.name !== name) || prev.shared)) {
    const names = (prev.shared || [prev.name]).filter(function (n) {
      return n && n !== name;
    });
    cache[f.access] = { shared: names.concat([name]).sort(), at: nowOf(opts) };
  } else if (!prev || prev.source !== 'token-profile') {
    cache[f.access] = {
      name: name,
      email: profiles.email(ctx.configDir, name) || null,
      source: 'saved',
      at: nowOf(opts),
    };
  }
  writeCache(ctx, cache);
}

// Point ~/.claude.json at `name`'s identity WITHOUT touching the credential — for when the token
// is right and the label is wrong. Same fields applyProfile writes.
function repairPointer(ctx, name) {
  const meta = profiles.read(ctx.configDir, name);
  if (!meta) throw new Error("no such profile: '" + name + "'");
  const cfg = claude.loadForWrite(ctx.claudeConfigPath);
  const hasOauth = meta.oauthAccount && Object.keys(meta.oauthAccount).length > 0;
  if (hasOauth) cfg.oauthAccount = meta.oauthAccount;
  else if (meta.email) cfg.oauthAccount = { emailAddress: meta.email };
  if (meta.userID) cfg.userID = meta.userID;
  else delete cfg.userID; // never leave the other account's userID beside this one's identity
  claude.writeConfig(ctx.claudeConfigPath, cfg);
  return { name: name, email: meta.email || null };
}

// Re-check (offline) and repair only if the label still disagrees with the token — meant to run
// under the switch lock, so a switch that landed in between is never undone.
function repairIfMismatched(ctx) {
  const id = liveSync(ctx);
  if (!id.mismatch || !id.name) return { repaired: false };
  // Only the endpoint's answer may rewrite the label: an offline match trusts a store that may itself
  // hold one account's token under another's name, and would turn a RIGHT label wrong.
  if (!id.verified) return { repaired: false, unverified: true };
  const r = repairPointer(ctx, id.name);
  return { repaired: true, from: id.labelName || id.labelEmail, to: r.name, email: r.email };
}

// The saved profiles whose LOGIN capture holds the live token. `longlived__<name>` is written only by
// `keyflip login <name> --long-lived`, and that login refuses a token the OAuth exchange names as
// anyone but <name> — unlike the normal slot, which label-based saving could fill with another
// account's login (the 12 Nov damage). -> [{ name, slot }]
function loginCapturesOf(ctx, live) {
  const out = [];
  if (!live.access && !live.refresh) return out;
  profiles.list(ctx.configDir).forEach(function (n) {
    const slot = longtoken.storeName(n);
    let b = null;
    try {
      b = ctx.store.getProfile(slot);
    } catch (e) {
      b = null;
    }
    if (!b) return;
    const f = fingerprints(b);
    if ((live.access && f.access === live.access) || (live.refresh && f.refresh === live.refresh))
      out.push({ name: n, slot: slot });
  });
  return out;
}

// `keyflip status --fix --force` — the owner's override for when the profile endpoint cannot say whose
// the live token is (an inference-only token gets a 403 there by design). The label is rewritten only
// to the ONE profile whose login capture holds the live token, and never against an endpoint answer.
// The credential is not touched. Only the CLI calls this, on an explicit --fix --force: no tick, MCP
// tool or switch does. -> { repaired, forced, from, fromEmail, to, email, evidence } | { repaired: false, reason }
function repairForced(ctx) {
  let live = null;
  try {
    live = ctx.store.getLive();
  } catch (e) {
    return { repaired: false, reason: 'the credential store could not be read (keychain locked?)' };
  }
  if (!live) return { repaired: false, reason: 'no live login' };
  const f = fingerprints(live);
  if (!f.access && !f.refresh) return { repaired: false, reason: 'the live credential is not an OAuth login' };
  const id = liveSync(ctx);
  const caps = loginCapturesOf(ctx, f);
  if (!caps.length)
    return {
      repaired: false,
      reason:
        "the live token is no saved account's login capture (keyflip login <name> --long-lived), so nothing proves whose it is",
    };
  if (caps.length > 1)
    return {
      repaired: false,
      reason:
        'the live token is the login capture of ' +
        caps
          .map(function (c) {
            return c.name;
          })
          .join(' and ') +
        ' — ambiguous, nothing repaired',
    };
  const name = caps[0].name;
  if (id.verified && (id.unsaved || (id.name && id.name !== name)))
    return {
      repaired: false,
      reason: 'the profile endpoint named ' + (id.name || id.email) + ', not ' + name + ' — refusing to override it',
    };
  const meta = profiles.read(ctx.configDir, name) || {};
  const oaEmail = meta.oauthAccount && meta.oauthAccount.emailAddress;
  const email = meta.email || oaEmail || '';
  if (!email || (oaEmail && meta.email && String(oaEmail).toLowerCase() !== String(meta.email).toLowerCase()))
    return { repaired: false, reason: "profile '" + name + "' does not name one account (its email fields disagree)" };
  const label = labelOf(ctx);
  const evidence = { slot: caps[0].slot, fingerprint: String(f.access || f.refresh).slice(0, 8) };
  if (label.email && String(label.email).toLowerCase() === String(email).toLowerCase())
    return { repaired: false, already: true, to: name, email: email, evidence: evidence };
  const r = repairPointer(ctx, name);
  return {
    repaired: true,
    forced: true,
    from: label.name || label.email,
    fromEmail: label.email,
    to: r.name,
    email: r.email,
    evidence: evidence,
  };
}

// The account a saved profile's stored token REALLY belongs to, when the profile endpoint has said
// so and it is another account: profile `name` then holds someone else's login (switching to it
// would put that account live). null when unknown or when it is `name`'s own.
function wrongOwnerOf(ctx, name) {
  let b = null;
  try {
    b = ctx.store.getProfile(name);
  } catch (e) {
    b = null;
  }
  if (!b) return null;
  const f = fingerprints(b);
  if (!f.access) return null;
  const hit = readCache(ctx)[f.access];
  if (!hit || hit.source !== 'token-profile') return null;
  if (hit.name && hit.name !== name) return hit.name;
  if (
    !hit.name &&
    hit.email &&
    String(hit.email).toLowerCase() !== String(profiles.email(ctx.configDir, name) || '').toLowerCase()
  )
    return hit.email;
  return null;
}

// Accounts whose stored refresh token something is USING right now, so rotating it would log that
// thing out: the live login (by token AND by label — both, when they disagree), any saved profile
// holding the live token, and accounts with a running parallel session (`keyflip run`, which
// gives each its own CLAUDE_CONFIG_DIR under <configDir>/sessions/<name>/).
// -> { names: [...], why: { name: reason } }
function inUseAccounts(ctx, opts) {
  opts = opts || {};
  const alive =
    opts.pidAlive ||
    function (pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return !!(e && e.code === 'EPERM');
      }
    };
  const why = Object.create(null);
  let id = null;
  try {
    id = liveSync(ctx, opts);
  } catch (e) {
    id = null;
  }
  if (id && id.name) why[id.name] = 'the live login';
  if (id && id.labelName && !why[id.labelName]) why[id.labelName] = 'the live login (by its label)';
  (id && id.sharedBy ? id.sharedBy : []).forEach(function (n) {
    if (!why[n]) why[n] = 'holds the live token';
  });
  let live = null;
  try {
    live = ctx.store.getLive();
  } catch (e) {
    live = null;
  }
  if (live) {
    holdersOf(ctx, fingerprints(live)).forEach(function (n) {
      if (!why[n]) why[n] = 'holds the live token';
    });
  }
  const base = path.join(ctx.configDir, 'sessions');
  let dirs = [];
  try {
    dirs = fs.readdirSync(base);
  } catch (e) {
    dirs = [];
  }
  dirs.forEach(function (n) {
    if (why[n] || !profiles.exists(ctx.configDir, n)) return;
    let files = [];
    try {
      files = fs.readdirSync(path.join(base, n, 'sessions'));
    } catch (e) {
      return;
    }
    const running = files.some(function (f) {
      if (!/^[0-9]+\.json$/.test(f)) return false;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(base, n, 'sessions', f), 'utf8'));
        return !!(j && j.pid && alive(j.pid));
      } catch (e) {
        return false;
      }
    });
    if (running) why[n] = 'a parallel session (keyflip run) is using it';
  });
  return { names: Object.keys(why), why: why };
}

export {
  wrongOwnerOf,
  inUseAccounts,
  repairIfMismatched,
  repairForced,
  loginCapturesOf,
  scopesOf,
  canAskProfile,
  liveSync,
  resolveLive,
  noteSaved,
  repairPointer,
  fingerprints,
  profileFor,
  fetchProfile,
  labelOf,
  PROFILE_URL,
  PROFILE_SCOPE,
  CACHE_FILE,
};
