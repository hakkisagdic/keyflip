// ChatGPT / Codex surface adapter.
//
// The ChatGPT desktop app (bundle com.openai.codex) and the Codex CLI share ONE
// credential file: $CODEX_HOME/auth.json, default ~/.codex/auth.json (mode 0600).
// There is no separate app cookie login to swap: the app's Cookies DB holds only
// Cloudflare/analytics cookies, and the real ChatGPT session is this file.
//
// Shape (observed, not guessed):
//   { auth_mode: 'chatgpt'|'apikey', OPENAI_API_KEY: null|string,
//     tokens: { id_token, access_token, refresh_token, account_id },
//     last_refresh: ISO }
// The id_token carries the e-mail + plan claims; the access_token's `exp` is the
// usable expiry (~10 days). Codex rotates both tokens when it refreshes, so:
//   * a capture stores the raw file byte-for-byte (0600) — switching writes it back;
//   * the background refresh only touches the LIVE file, and only while neither
//     ChatGPT.app nor the Codex CLI is running (they rewrite the file on exit);
//   * a capture is updated when it shares the exact refresh-token lineage that was
//     just rotated — never refreshed on its own, so two copies cannot fight.
// Secrets live under <configDir>/surfaces/codex/<slug>/ (git-ignored as a whole);
// meta.json is secret-free. Nothing here ever prints or returns a token.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { run as defaultRun } from './exec.js';
import { atomicWrite, writeJsonStable } from './fsutil.js';
import * as profiles from './profiles.js';

const SURFACE = 'codex';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
// Codex's public OAuth client id (present in the shipped binary; not a secret).
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000; // refresh when < 24h of access token left
const PROCESS_NAMES = ['ChatGPT', 'Codex', 'codex', 'codex-cli'];
const AUTH_BACKUPS_TO_KEEP = 10;

function err(message, code) {
  const e = /** @type {any} */ (new Error(message));
  e.code = code || 'CODEX';
  return e;
}

function depsOf(d) {
  d = d || {};
  return {
    run: d.run || defaultRun,
    now:
      typeof d.now === 'function'
        ? d.now
        : d.now
          ? function () {
              return String(d.now);
            }
          : null,
    running: Array.isArray(d.running) ? d.running : null,
    fetch: d.fetch || null,
  };
}

function nowIso(deps) {
  return deps.now ? deps.now() : new Date().toISOString();
}

// ---- locations ---------------------------------------------------------------------------

function codexHome(ctx) {
  if (ctx && ctx.codexHome) return ctx.codexHome;
  const env = (ctx && ctx.env) || process.env;
  if (env && env.CODEX_HOME) return env.CODEX_HOME;
  return path.join((ctx && ctx.home) || os.homedir(), '.codex');
}

function authPath(ctx) {
  return path.join(codexHome(ctx), 'auth.json');
}

function surfaceRoot(ctx) {
  return path.join(ctx.configDir, 'surfaces', SURFACE);
}

function accountDir(ctx, slug) {
  return path.join(surfaceRoot(ctx), slug);
}

// ---- small parsers -----------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f]/g;

function safeStr(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.replace(CTRL, '').trim();
  return s ? s.slice(0, max || 200) : null;
}

function normalizeEmail(v) {
  const s = safeStr(v, 320);
  return s ? s.toLowerCase() : null;
}

function decodeJwt(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const b = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const obj = JSON.parse(Buffer.from(b, 'base64').toString('utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch (e) {
    return null;
  }
}

// Public identity from a parsed auth.json. Never includes a token.
function identityFromAuth(auth) {
  if (!auth || typeof auth !== 'object') return null;
  const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : {};
  const id = decodeJwt(tokens.id_token) || {};
  const access = decodeJwt(tokens.access_token) || {};
  const idAuth = id['https://api.openai.com/auth'] || {};
  const acAuth = access['https://api.openai.com/auth'] || {};
  const exp = Number(access.exp) || Number(id.exp) || 0;
  return {
    email: normalizeEmail(id.email),
    name: safeStr(id.name),
    accountId: safeStr(tokens.account_id) || safeStr(acAuth.chatgpt_account_id) || safeStr(idAuth.chatgpt_account_id),
    plan: safeStr(acAuth.chatgpt_plan_type) || safeStr(idAuth.chatgpt_plan_type),
    userId: safeStr(acAuth.chatgpt_user_id) || safeStr(idAuth.chatgpt_user_id),
    authMode: safeStr(auth.auth_mode),
    expiresAt: exp ? new Date(exp * 1000).toISOString() : null,
    hasRefreshToken: typeof tokens.refresh_token === 'string' && !!tokens.refresh_token,
    hasApiKey: typeof auth.OPENAI_API_KEY === 'string' && !!auth.OPENAI_API_KEY,
  };
}

// Read auth.json without ever throwing at the caller. `raw` stays in-process.
function readAuthFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { present: false, raw: null, auth: null, identity: null, error: null };
    return { present: false, raw: null, auth: null, identity: null, error: e.message };
  }
  let auth;
  try {
    auth = JSON.parse(raw);
  } catch (e) {
    return { present: true, raw: raw, auth: null, identity: null, error: 'auth.json is not valid JSON' };
  }
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    return { present: true, raw: raw, auth: null, identity: null, error: 'auth.json is not a JSON object' };
  }
  return { present: true, raw: raw, auth: auth, identity: identityFromAuth(auth), error: null };
}

function readMeta(ctx, slug) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(accountDir(ctx, slug), 'meta.json'), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch (e) {
    return null;
  }
}

// ---- process detection -------------------------------------------------------------------

// ChatGPT.app and the Codex CLI both own the file; either can rewrite it on exit.
function runningProcesses(ctx, deps) {
  if (deps.running) return deps.running.slice();
  const platform = (ctx && ctx.platform) || process.platform;
  const found = [];
  if (platform === 'win32') {
    PROCESS_NAMES.forEach(function (name) {
      const r = deps.run('tasklist', ['/FI', 'IMAGENAME eq ' + name + '.exe'], undefined, { timeoutMs: 5000 });
      if (r && r.code === 0 && new RegExp('\\b' + name + '\\.exe\\b', 'i').test(r.stdout || '')) found.push(name);
    });
    return found;
  }
  const pgrep = platform === 'darwin' ? '/usr/bin/pgrep' : 'pgrep';
  PROCESS_NAMES.forEach(function (name) {
    const r = deps.run(pgrep, ['-x', name], undefined, { timeoutMs: 5000 });
    if (r && r.code === 0) found.push(name);
  });
  return found;
}

// ---- expiry / refresh --------------------------------------------------------------------

function needsRefresh(auth, opts) {
  opts = opts || {};
  const id = identityFromAuth(auth);
  const thresholdMs = opts.thresholdMs === undefined ? REFRESH_THRESHOLD_MS : opts.thresholdMs;
  if (!id || !id.expiresAt) return { needs: false, reason: 'no-expiry', expiresAt: null, msLeft: null };
  if (id.authMode === 'apikey' || !id.hasRefreshToken) {
    return { needs: false, reason: 'not-refreshable', expiresAt: id.expiresAt, msLeft: null };
  }
  const nowMs = opts.now ? new Date(opts.now).getTime() : Date.now();
  const msLeft = new Date(id.expiresAt).getTime() - nowMs;
  return {
    needs: msLeft <= thresholdMs,
    reason: msLeft <= 0 ? 'expired' : msLeft <= thresholdMs ? 'expiring' : 'fresh',
    expiresAt: id.expiresAt,
    msLeft: msLeft,
  };
}

// POST the refresh_token grant and write the merged auth.json (0600).
// Returns the public outcome only; the caller gets the previous refresh token in
// `previousRefreshToken` solely to propagate the same lineage to captures.
async function refreshAuth(opts) {
  opts = opts || {};
  const file = opts.authPath;
  if (!file) throw err('refreshAuth needs authPath', 'CODEX_REFRESH');
  const read = opts.auth ? { auth: opts.auth } : readAuthFile(file);
  const auth = read.auth;
  if (!auth || typeof auth !== 'object')
    throw err('cannot refresh: ' + file + ' is missing or unreadable', 'CODEX_REFRESH');
  const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : {};
  if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) {
    throw err('cannot refresh: auth.json holds no refresh_token (API-key or signed-out login)', 'CODEX_NO_REFRESH');
  }
  const fetchFn = opts.fetch || globalThis.fetch;
  if (typeof fetchFn !== 'function') throw err('cannot refresh: no fetch available', 'CODEX_NO_FETCH');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: CLIENT_ID,
  });
  let resp;
  try {
    resp = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
  } catch (e) {
    throw err('token refresh request failed: ' + (e && e.message ? e.message : String(e)), 'CODEX_REFRESH');
  }
  let payload;
  try {
    payload = await resp.json();
  } catch (e) {
    payload = null;
  }
  if (!resp.ok || !payload || typeof payload.access_token !== 'string' || !payload.access_token) {
    const detail =
      payload && (payload.error || payload.error_description)
        ? ': ' +
          safeStr(
            String(payload.error || '') +
              (payload.error_description ? (payload.error ? ': ' : '') + String(payload.error_description) : ''),
            200,
          )
        : '';
    throw err('token refresh rejected (HTTP ' + resp.status + ')' + detail, 'CODEX_REFRESH');
  }
  const merged = Object.assign({}, auth, {
    tokens: Object.assign({}, tokens, {
      access_token: payload.access_token,
      refresh_token:
        typeof payload.refresh_token === 'string' && payload.refresh_token
          ? payload.refresh_token
          : tokens.refresh_token,
      id_token: typeof payload.id_token === 'string' && payload.id_token ? payload.id_token : tokens.id_token,
    }),
    last_refresh: opts.now || new Date().toISOString(),
  });
  atomicWrite(file, JSON.stringify(merged, null, 2), 0o600);
  const id = identityFromAuth(merged);
  return {
    ok: true,
    auth: merged,
    expiresAt: id ? id.expiresAt : null,
    rotatedRefreshToken: typeof payload.refresh_token === 'string' && payload.refresh_token !== tokens.refresh_token,
    previousRefreshToken: tokens.refresh_token,
  };
}

// The daemon path: refresh ONLY the live file, never a dormant capture, and never
// while an owner process is running. A capture whose refresh token is the exact
// one just rotated is updated in place so the saved copy stays usable.
async function refreshLive(ctx, opts) {
  opts = opts || {};
  const deps = depsOf(opts);
  const file = authPath(ctx);
  const live = readAuthFile(file);
  if (!live.present) return { ok: false, skipped: 'no-live-auth', path: file };
  if (!live.auth) return { ok: false, skipped: 'unreadable', path: file, error: live.error };
  const due = needsRefresh(live.auth, { now: opts.now, thresholdMs: opts.thresholdMs });
  if (!opts.force && !due.needs) {
    return {
      ok: true,
      skipped: 'not-due',
      path: file,
      reason: due.reason,
      expiresAt: due.expiresAt,
      msLeft: due.msLeft,
    };
  }
  const running = runningProcesses(ctx, deps);
  if (running.length) {
    return { ok: false, skipped: 'running', path: file, running: running };
  }
  const r = await refreshAuth({ authPath: file, auth: live.auth, fetch: deps.fetch, now: nowIso(deps) });
  const updatedCaptures = [];
  const oldToken = r.previousRefreshToken;
  listCaptureSlugs(ctx).forEach(function (slug) {
    const captured = readAuthFile(path.join(accountDir(ctx, slug), 'auth.json'));
    const t = captured.auth && captured.auth.tokens;
    if (!t || t.refresh_token !== oldToken) return;
    try {
      atomicWrite(path.join(accountDir(ctx, slug), 'auth.json'), JSON.stringify(r.auth, null, 2), 0o600);
      const prev = readMeta(ctx, slug) || {};
      const id = identityFromAuth(r.auth);
      writeJsonStable(path.join(accountDir(ctx, slug), 'meta.json'), {
        schemaVersion: 1,
        tool: SURFACE,
        slug: slug,
        email: prev.email || (id && id.email) || '',
        accountId: prev.accountId || (id && id.accountId) || null,
        plan: prev.plan || (id && id.plan) || null,
        authMode: (id && id.authMode) || prev.authMode || null,
        capturedAt: prev.capturedAt || nowIso(deps),
        updatedAt: nowIso(deps),
        expiresAt: id ? id.expiresAt : null,
        source: prev.source || 'live',
      });
      updatedCaptures.push(slug);
    } catch (e) {
      /* a read-only or half-written capture must not undo a good live refresh */
    }
  });
  return {
    ok: true,
    refreshed: true,
    path: file,
    expiresAt: r.expiresAt,
    rotatedRefreshToken: r.rotatedRefreshToken,
    updatedCaptures: updatedCaptures,
  };
}

// ---- captures ----------------------------------------------------------------------------

function listCaptureSlugs(ctx) {
  let entries;
  try {
    entries = fs.readdirSync(surfaceRoot(ctx), { withFileTypes: true });
  } catch (e) {
    return [];
  }
  return entries
    .filter(function (e) {
      return e.isDirectory() && e.name[0] !== '.';
    })
    .map(function (e) {
      return e.name;
    });
}

// Meta is optional: captures made before this adapter existed only have auth.json,
// and the identity is still recoverable from the stored JWT.
function captureInfo(ctx, slug) {
  const dir = accountDir(ctx, slug);
  const meta = readMeta(ctx, slug) || {};
  const stored = readAuthFile(path.join(dir, 'auth.json'));
  const id = stored.identity || {};
  let capturedAt = meta.capturedAt || null;
  if (!capturedAt) {
    try {
      capturedAt = fs.statSync(path.join(dir, 'auth.json')).mtime.toISOString();
    } catch (e) {
      capturedAt = null;
    }
  }
  const due = stored.auth ? needsRefresh(stored.auth) : { needs: false, reason: 'missing', expiresAt: null };
  return {
    tool: SURFACE,
    slug: slug,
    email: normalizeEmail(meta.email) || id.email || '',
    accountId: meta.accountId || id.accountId || null,
    plan: meta.plan || id.plan || null,
    authMode: meta.authMode || id.authMode || null,
    capturedAt: capturedAt,
    expiresAt: id.expiresAt || meta.expiresAt || null,
    usable: !!(stored.auth && (id.hasApiKey || id.hasRefreshToken || id.expiresAt)),
    needsRefresh: due.needs,
    refreshReason: due.reason,
    bytes: stored.raw ? Buffer.byteLength(stored.raw) : 0,
  };
}

function listCaptures(ctx) {
  return listCaptureSlugs(ctx)
    .map(function (slug) {
      return captureInfo(ctx, slug);
    })
    .sort(function (a, b) {
      return a.slug.localeCompare(b.slug);
    });
}

function resolveCapture(ctx, arg) {
  if (arg == null) return null;
  const accounts = listCaptures(ctx);
  const s = String(arg);
  if (/^[0-9]+$/.test(s)) {
    const i = parseInt(s, 10);
    return i >= 1 && i <= accounts.length ? accounts[i - 1].slug : null;
  }
  for (let i = 0; i < accounts.length; i++) if (accounts[i].slug === s) return accounts[i].slug;
  const lower = s.toLowerCase();
  for (let i = 0; i < accounts.length; i++) if (accounts[i].slug.toLowerCase() === lower) return accounts[i].slug;
  const email = normalizeEmail(s);
  for (let i = 0; i < accounts.length; i++)
    if (accounts[i].email && accounts[i].email === email) return accounts[i].slug;
  return null;
}

function slugFor(ctx, name, email) {
  const base = profiles.sanitizeName(name || email || 'codex');
  const accounts = listCaptures(ctx);
  let candidate = base;
  for (let n = 2; ; n++) {
    const hit = accounts.filter(function (a) {
      return a.slug === candidate;
    })[0];
    if (!hit) return candidate;
    if (email && hit.email && hit.email === email) return candidate; // same account, refresh in place
    candidate = base + '-' + n;
  }
}

// Capture the live auth.json. `name` overrides the slug; otherwise the e-mail
// local part wins (matching the existing hasanugur / ozguraric captures).
function capture(ctx, opts) {
  opts = opts || {};
  const deps = depsOf(opts);
  const live = readAuthFile(authPath(ctx));
  if (!live.present) {
    throw err(
      'no live ChatGPT/Codex login at ' + authPath(ctx) + ' — sign in with ChatGPT.app or run `codex login` first.',
      'CODEX_NO_LIVE',
    );
  }
  if (!live.auth) throw err('live auth.json is unreadable: ' + (live.error || 'unknown error'), 'CODEX_CORRUPT');
  const id = live.identity || {};
  const email = normalizeEmail(opts.email) || id.email;
  if (!opts.name && !email) {
    throw err(
      'could not detect the account e-mail from auth.json; pass a name: keyflip chatgpt capture <name>',
      'CODEX_NO_EMAIL',
    );
  }
  const slug = slugFor(ctx, opts.name, email);
  const dir = accountDir(ctx, slug);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch (e) {
    /* best effort */
  }
  atomicWrite(path.join(dir, 'auth.json'), live.raw, 0o600);
  const prev = readMeta(ctx, slug) || {};
  const at = nowIso(deps);
  const meta = {
    schemaVersion: 1,
    tool: SURFACE,
    slug: slug,
    email: email || prev.email || '',
    accountId: id.accountId || prev.accountId || null,
    plan: id.plan || prev.plan || null,
    authMode: id.authMode || prev.authMode || null,
    capturedAt: prev.capturedAt || at,
    updatedAt: at,
    expiresAt: id.expiresAt || null,
    source: opts.source || prev.source || 'live',
  };
  writeJsonStable(path.join(dir, 'meta.json'), meta);
  return {
    slug: slug,
    email: meta.email,
    plan: meta.plan,
    capturedAt: meta.capturedAt,
    expiresAt: meta.expiresAt,
    source: meta.source,
  };
}

function removeCapture(ctx, slug) {
  const dir = accountDir(ctx, slug);
  if (!fs.existsSync(dir)) throw err('no capture for ' + SURFACE + '/' + slug, 'CODEX_NOT_FOUND');
  fs.rmSync(dir, { recursive: true, force: true });
  return { removed: slug };
}

// ---- live status -------------------------------------------------------------------------

function status(ctx, opts) {
  const deps = depsOf(opts);
  const file = authPath(ctx);
  const live = readAuthFile(file);
  const id = live.identity;
  const due = live.auth ? needsRefresh(live.auth) : null;
  return {
    tool: SURFACE,
    path: file,
    signedIn: !!(live.present && live.auth),
    live:
      live.present && live.auth
        ? {
            email: id.email,
            accountId: id.accountId,
            plan: id.plan,
            authMode: id.authMode,
            expiresAt: id.expiresAt,
            hasRefreshToken: id.hasRefreshToken,
            needsRefresh: due ? due.needs : false,
            refreshReason: due ? due.reason : 'unreadable',
          }
        : null,
    error: live.error || null,
    running: runningProcesses(ctx, deps),
    accounts: listCaptures(ctx),
  };
}

// ---- switching ---------------------------------------------------------------------------

function backupLiveAuth(ctx, live, deps) {
  const dir = path.join(ctx.configDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = String(nowIso(deps)).replace(/[-:]/g, '').replace(/\..*$/, '');
  const base = 'codex-auth-' + stamp;
  let name = base + '.json';
  let dest = path.join(dir, name);
  for (let n = 2; fs.existsSync(dest); n++) {
    name = base + '.' + n + '.json';
    dest = path.join(dir, name);
  }
  atomicWrite(dest, live.raw, 0o600);
  pruneAuthBackups(ctx);
  return dest;
}

function pruneAuthBackups(ctx, keep) {
  keep = keep === undefined ? AUTH_BACKUPS_TO_KEEP : keep;
  const dir = path.join(ctx.configDir, 'backups');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return 0;
  }
  const all = names
    .filter(function (n) {
      return /^codex-auth-.*\.json$/.test(n);
    })
    .sort()
    .reverse();
  all.slice(keep).forEach(function (n) {
    try {
      fs.rmSync(path.join(dir, n), { force: true });
    } catch (e) {
      /* ignore */
    }
  });
  return Math.max(0, all.length - keep);
}

// Every auth.json snapshot written before a switch/refresh, newest first. Identity only —
// the file contents never leave this module. The list is what a human needs to undo a bad
// switch: which account it held, when, and whether it still carries a refresh token.
function listBackups(ctx) {
  const dir = path.join(ctx.configDir, 'backups');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
  return names
    .filter(function (n) {
      return /^codex-auth-.*\.json$/.test(n);
    })
    .sort()
    .reverse()
    .map(function (n) {
      const file = path.join(dir, n);
      const r = readAuthFile(file);
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch (e) {
        /* raced */
      }
      return {
        file: n,
        path: file,
        bytes: size,
        email: r.identity ? r.identity.email : null,
        plan: r.identity ? r.identity.plan : null,
        expiresAt: r.identity ? r.identity.expiresAt : null,
        hasRefreshToken: !!(r.identity && r.identity.hasRefreshToken),
        valid: !!(r.present && r.auth),
      };
    });
}

// Resolve a backup by exact name, unique prefix, or 1-based index from `listBackups`.
function resolveBackup(ctx, ref) {
  const all = listBackups(ctx);
  const needle = String(ref == null ? '' : ref).trim();
  if (!needle) return null;
  if (/^\d+$/.test(needle)) {
    const i = parseInt(needle, 10) - 1;
    return all[i] || null;
  }
  const exact = all.find(function (b) {
    return b.file === needle;
  });
  if (exact) return exact;
  const hits = all.filter(function (b) {
    return b.file.indexOf(needle) === 0 || b.file.indexOf('codex-auth-' + needle) === 0;
  });
  return hits.length === 1 ? hits[0] : null;
}

// Write a backup back to the live auth.json. The CURRENT live file is backed up first, so a
// restore is itself reversible. Refuses while ChatGPT/Codex runs unless forced: the app owns
// auth.json and rewrites it on exit.
function restoreBackup(ctx, ref, opts) {
  opts = opts || {};
  const deps = depsOf(opts);
  const b = resolveBackup(ctx, ref);
  if (!b) return { ok: false, reason: 'not-found', backups: listBackups(ctx) };
  const stored = readAuthFile(b.path);
  if (!stored.present || !stored.auth) return { ok: false, reason: 'corrupt', file: b.file };
  const running = runningProcesses(ctx, deps);
  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      plan: {
        file: b.file,
        email: b.email,
        plan: b.plan,
        expiresAt: b.expiresAt,
        path: authPath(ctx),
        running: running,
      },
    };
  }
  if (running.length && !opts.force) return { ok: false, reason: 'running', running: running, file: b.file };
  const live = readAuthFile(authPath(ctx));
  const saved = live.present && live.raw ? backupLiveAuth(ctx, live, deps) : null;
  atomicWrite(authPath(ctx), stored.raw, 0o600);
  const readback = readAuthFile(authPath(ctx));
  return {
    ok: true,
    restored: b.file,
    email: readback.identity ? readback.identity.email : null,
    plan: readback.identity ? readback.identity.plan : null,
    expiresAt: readback.identity ? readback.identity.expiresAt : null,
    verified: !!(readback.present && readback.auth && readback.raw === stored.raw),
    previous: saved,
    path: authPath(ctx),
  };
}

function switchTo(ctx, target, opts) {
  opts = opts || {};
  const deps = depsOf(opts);
  const slug = resolveCapture(ctx, target);
  if (!slug)
    throw err("no such ChatGPT/Codex account: '" + target + "' (see `keyflip chatgpt list`)", 'CODEX_NOT_FOUND');
  const stored = readAuthFile(path.join(accountDir(ctx, slug), 'auth.json'));
  if (!stored.present || !stored.auth) {
    throw err(
      "the capture for '" + slug + "' has no readable auth.json; re-run `keyflip chatgpt capture`",
      'CODEX_CORRUPT',
    );
  }
  const meta = readMeta(ctx, slug) || {};
  const storedId = stored.identity || {};
  const expectedEmail = normalizeEmail(meta.email) || storedId.email;
  const file = authPath(ctx);
  const live = readAuthFile(file);
  const liveId = live.identity || {};
  const running = runningProcesses(ctx, deps);
  const plan = {
    target: slug,
    email: expectedEmail || '',
    path: file,
    live: { email: liveId.email || '', authMode: liveId.authMode || null, expiresAt: liveId.expiresAt || null },
    write: { expiresAt: storedId.expiresAt, bytes: Buffer.byteLength(stored.raw) },
    running: running,
  };
  if (opts.dryRun) return { dryRun: true, plan: plan };

  if (running.length && !opts.force) {
    throw err(
      'quit ' +
        running.join(' and ') +
        ' before switching (they own ' +
        file +
        '), or pass --force. ' +
        'ChatGPT/Codex rewrites the file on exit and can undo the swap.',
      'CODEX_RUNNING',
    );
  }

  // Preserve the outgoing login first: its refresh token may have rotated since
  // it was last captured, and switching away must not lose a working account.
  let capturedOutgoing = null;
  if (live.present && live.auth) {
    try {
      capturedOutgoing = capture(ctx, { email: liveId.email, source: 'live-outgoing', deps: deps }).slug;
    } catch (e) {
      /* non-fatal: the switch is still what the user asked for */
    }
  }

  const backup = live.present && live.raw ? backupLiveAuth(ctx, live, deps) : null;
  atomicWrite(file, stored.raw, 0o600);

  let verified = false;
  if (opts.noVerify !== true) {
    const after = readAuthFile(file);
    if (!after.present || after.raw !== stored.raw) {
      throw err(
        'post-switch check failed: ' +
          file +
          ' did not read back identically' +
          (backup ? ' (backup: ' + backup + ')' : ''),
        'CODEX_VERIFY',
      );
    }
    const afterEmail = after.identity && after.identity.email;
    if (expectedEmail && afterEmail && afterEmail !== expectedEmail) {
      throw err(
        'post-switch check failed: auth.json reports ' +
          afterEmail +
          ', expected ' +
          expectedEmail +
          (backup ? ' (backup: ' + backup + ')' : ''),
        'CODEX_VERIFY',
      );
    }
    verified = true;
  }

  return {
    slug: slug,
    email: expectedEmail || '',
    backup: backup,
    capturedOutgoing: capturedOutgoing,
    verified: verified,
    expiresAt: storedId.expiresAt,
    dryRun: false,
  };
}

export {
  SURFACE,
  TOKEN_URL,
  CLIENT_ID,
  REFRESH_THRESHOLD_MS,
  codexHome,
  authPath,
  surfaceRoot,
  accountDir,
  identityFromAuth,
  needsRefresh,
  refreshAuth,
  refreshLive,
  listCaptures,
  resolveCapture,
  capture,
  removeCapture,
  status,
  switchTo,
  runningProcesses,
  pruneAuthBackups,
  listBackups,
  resolveBackup,
  restoreBackup,
};
