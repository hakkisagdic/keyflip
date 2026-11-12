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
// Fingerprints are truncated SHA-256 of a token: never the token, never reversible, never versioned
// (the cache file is gitignored and skipped by backups).
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as profiles from './profiles.js';
import * as claude from './claude.js';
import * as longtoken from './longtoken.js';
import { atomicWrite } from './fsutil.js';

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
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
  const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
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
  if (hit && hit.name && profiles.exists(ctx.configDir, hit.name)) {
    r.name = hit.name;
    r.email = hit.email || profiles.email(ctx.configDir, hit.name) || null;
    r.source = 'token-cache';
    return finish(r, label);
  }
  if (hit && !hit.name && hit.source === 'token-profile' && hit.email) {
    // The endpoint named an account keyflip has no profile for.
    r.email = hit.email;
    r.source = 'token-cache';
    r.unsaved = true;
    return finish(r, label);
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
    cache[f.access] = Object.assign({ offlineMiss: true, at: nowOf(opts) }, holders.length > 1 ? { sharedBy: holders } : {});
    writeCache(ctx, cache);
  }
  return finish(r, label);
}

// Async: liveSync, then the profile endpoint when still unresolved (network: false skips it).
async function resolveLive(ctx, opts) {
  opts = opts || {};
  const s = liveSync(ctx, opts);
  if (s.source !== 'label' || opts.network === false) return s;
  let live = null;
  try {
    live = ctx.store.getLive();
  } catch (e) {
    return s;
  }
  const o = oauthOf(live);
  const f = fingerprints(live);
  if (!o || !o.accessToken || !f.access) return s;
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
  cache[f.access] = {
    name: name,
    email: r.identity.email,
    accountUuid: r.identity.accountUuid,
    org: r.identity.org,
    source: 'token-profile',
    at: nowOf(opts),
  };
  writeCache(ctx, cache);
  const label = labelOf(ctx);
  const out = { name: name, email: r.identity.email, source: 'token-profile', hasLive: true };
  if (s.sharedBy) {
    out.sharedBy = s.sharedBy;
    // The other holders store THIS account's token under their own name.
    out.wrongCredentialIn = s.sharedBy.filter(function (n) {
      return n !== name;
    });
  }
  if (!name) out.unsaved = true; // a real account keyflip has no profile for
  return finish(out, label);
}

// Remember that `blob` is `name`'s credential (called when keyflip itself saves one). The same
// token saved under a second name is recorded as SHARED — ambiguous, never a verdict.
function noteSaved(ctx, name, blob, opts) {
  const f = fingerprints(blob);
  if (!f.access) return;
  const cache = readCache(ctx);
  const prev = cache[f.access];
  if (prev && prev.source !== 'token-profile' && ((prev.name && prev.name !== name) || prev.shared)) {
    const names = (prev.shared || [prev.name]).filter(function (n) {
      return n && n !== name;
    });
    cache[f.access] = { shared: names.concat([name]).sort(), at: nowOf(opts) };
  } else if (!prev || prev.source !== 'token-profile') {
    cache[f.access] = { name: name, email: profiles.email(ctx.configDir, name) || null, source: 'saved', at: nowOf(opts) };
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
  const r = repairPointer(ctx, id.name);
  return { repaired: true, from: id.labelName || id.labelEmail, to: r.name, email: r.email };
}

export {
  repairIfMismatched,
  liveSync,
  resolveLive,
  noteSaved,
  repairPointer,
  fingerprints,
  profileFor,
  fetchProfile,
  labelOf,
  PROFILE_URL,
  CACHE_FILE,
};
