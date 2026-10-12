// EXPERIMENTAL: read claude.ai "Chat" conversations — for the account the desktop
// app is currently signed into, OR for ANY captured account (chat.js can also read a
// saved desktop-app cookie snapshot, see cookieHeader's `account` option).
// Chat history is SERVER-SIDE, so this calls the (undocumented) claude.ai web API
// using a claude.ai session cookie, decrypted from a Cookies DB with the Electron
// safeStorage key.
//
// Caveats (documented for the user): unofficial API that can change; requires a
// FRESH Cloudflare clearance cookie (cf_clearance/__cf_bm) — it works reliably
// right after using the desktop app, and may return 403 when those are stale;
// read-only. Cookies are machine-bound: the snapshot of ANOTHER account can only be
// read on the machine it was captured on, and only until Cloudflare rotates it.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { run } from './exec.js';

// The Electron safeStorage password (login Keychain), used to decrypt cookies.
function safeStoragePassword(ctx) {
  if (ctx && ctx.safeStoragePassword) return ctx.safeStoragePassword;
  const r = run('/usr/bin/security', ['find-generic-password', '-s', 'Claude Safe Storage', '-a', 'Claude Key', '-w']);
  return r.code === 0 ? r.stdout.replace(/\r?\n$/, '') : null;
}

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Decrypt one Chromium cookie encrypted_value (macOS v10 scheme). Newer Chromium
// prepends a 32-byte domain hash to the plaintext; strip it if the remainder is
// printable. Returns null on non-printable/garbage.
function decryptCookie(encBuf, password) {
  try {
    if (encBuf.slice(0, 3).toString() !== 'v10') return null;
    const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
    const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    const p = Buffer.concat([d.update(encBuf.slice(3)), d.final()]);
    const stripped = p.slice(32).toString('utf8');
    const whole = p.toString('utf8');
    const val = /^[\x20-\x7e]+$/.test(stripped) ? stripped : whole;
    return /^[\x20-\x7e]+$/.test(val) ? val : null;
  } catch (e) {
    return null;
  }
}

// Which Cookies DB to read for a claude.ai session:
//   no account          -> the LIVE desktop-app DB
//   account: '<name>'   -> that profile's saved snapshot (app/<name>.cookies), so a
//                          chat can be read WITHOUT switching surfaces. The snapshot
//                          is only as fresh as the last time that account's app login
//                          was flushed to disk (a clean quit, or a keyflip switch).
function cookiesDbFor(ctx, opts) {
  const account = opts && opts.account;
  if (!account) return ctx.appDataDir ? path.join(ctx.appDataDir, 'Cookies') : null;
  const snap = path.join(ctx.configDir, 'app', account + '.cookies');
  if (!fs.existsSync(snap))
    throw new Error(
      "no saved desktop-app cookie for '" +
        account +
        "' — sign the app into it once (or switch to it and back), then run `keyflip add " +
        account +
        ' --app`',
    );
  return snap;
}

// Build the claude.ai cookie header from a desktop-app Cookies DB.
function cookieHeader(ctx, opts) {
  opts = opts || {};
  const password = safeStoragePassword(ctx);
  if (!password) throw new Error('cannot read the Electron safeStorage key (Keychain) — is the desktop app installed?');
  const src = opts.cookiesFile || cookiesDbFor(ctx, opts);
  if (!src) throw new Error('no Claude desktop app data directory (macOS only)');
  const tmp = path.join(os.tmpdir(), 'keyflip-ck-' + process.pid + '-' + Date.now() + '.db');
  try {
    fs.copyFileSync(src, tmp);
  } catch (e) {
    throw new Error('no desktop Cookies DB at ' + src + ' — sign into the Claude desktop app first');
  }
  try {
    const r = run('sqlite3', [
      '-separator',
      '\x01',
      'file:' + tmp + '?mode=ro',
      "SELECT name,quote(encrypted_value) FROM cookies WHERE host_key LIKE '%claude.ai';",
    ]);
    if (r.code !== 0) throw new Error('could not read cookies (sqlite3): ' + (r.stderr || r.code));
    const pairs = [];
    const names = Object.create(null);
    let org = null;
    r.stdout
      .trim()
      .split('\n')
      .forEach(function (line) {
        const i = line.indexOf('\x01');
        if (i === -1) return;
        const name = line.slice(0, i);
        const hex = line.slice(i + 1).replace(/^X'|'$/g, '');
        const val = decryptCookie(Buffer.from(hex, 'hex'), password);
        if (val == null) return;
        pairs.push(name + '=' + val);
        names[name] = true;
        if (name === 'lastActiveOrg') org = val;
      });
    if (!pairs.length) throw new Error('no readable claude.ai cookies (not signed in?)');
    // Chromium keeps the CURRENT session in memory and only writes it out on a clean
    // quit, so a live app's DB can hold no sessionKey at all. Say what to do about it
    // instead of letting the API answer 403 and looking like a broken login.
    if (!names.sessionKey && !names.sessionKeyV3)
      throw Object.assign(
        new Error(
          'the Claude desktop app has not written its session cookie to disk yet (it is held in memory) — quit the app once (Cmd+Q) and retry, or run `keyflip chat --flush`',
        ),
        { code: 'cookies-not-flushed' },
      );
    return { cookie: pairs.join('; '), org: org, names: names };
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (e) {
      /* */
    }
  }
}

function headers(cookie) {
  return {
    cookie: cookie,
    'user-agent': BROWSER_UA,
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'anthropic-client-platform': 'web_claude_ai',
    referer: 'https://claude.ai/',
    origin: 'https://claude.ai',
  };
}

async function api(path_, cookie, opts) {
  opts = opts || {};
  const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) throw new Error('no fetch available');
  const res = await doFetch('https://claude.ai' + path_, {
    headers: headers(cookie),
    signal:
      typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(opts.timeoutMs || 15000)
        : undefined,
  });
  if (res.status === 403)
    throw new Error(
      'claude.ai returned 403 — the Cloudflare clearance cookie is stale; open the Claude desktop app (or claude.ai) once, then retry',
    );
  if (res.status === 401) throw new Error('claude.ai returned 401 — the session is not authenticated');
  if (!res.ok) throw new Error('claude.ai API ' + path_ + ' -> HTTP ' + res.status);
  return res.json();
}

// Resolve the active org (the account the live cookie belongs to).
async function activeOrg(ctx, cookie, opts) {
  const orgs = await api('/api/organizations', cookie, opts);
  const list = Array.isArray(orgs) ? orgs : [];
  return { uuid: (list[0] && list[0].uuid) || null, name: (list[0] && list[0].name) || null };
}

// List Chat conversations (for the live account, or opts.account's snapshot).
async function list(ctx, opts) {
  opts = opts || {};
  const ch = opts.cookieHeaderOverride || cookieHeader(ctx, opts); // test seam
  const org = opts.org || ch.org || (await activeOrg(ctx, ch.cookie, opts)).uuid;
  if (!org) throw new Error('could not determine the active claude.ai organization');
  const convs = await api(
    '/api/organizations/' + org + '/chat_conversations?limit=' + (opts.limit || 30),
    ch.cookie,
    opts,
  );
  return {
    org: org,
    conversations: (Array.isArray(convs) ? convs : []).map(function (c) {
      return {
        uuid: c.uuid,
        name: c.name || c.summary || '(untitled)',
        updatedAt: c.updated_at,
        createdAt: c.created_at,
      };
    }),
  };
}

// claude.ai only accepts the FULL conversation uuid, but every listing prints an
// 8-char prefix — so resolve a prefix (or a chat's title) back to a real uuid.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function resolveConversation(ctx, id, opts) {
  opts = opts || {};
  const needle = String(id || '').trim();
  if (!needle) throw new Error('no conversation given');
  if (UUID_RE.test(needle)) return { uuid: needle, name: null };
  const r = await list(ctx, Object.assign({}, opts, { limit: opts.resolveLimit || 200 }));
  const low = needle.toLowerCase();
  const byId = r.conversations.filter(function (c) {
    return c.uuid.toLowerCase().indexOf(low) === 0;
  });
  if (byId.length === 1) return byId[0];
  if (byId.length > 1)
    throw new Error(
      "'" +
        needle +
        "' matches several chats: " +
        byId
          .map(function (c) {
            return c.uuid.slice(0, 8);
          })
          .join(', '),
    );
  const exact = r.conversations.filter(function (c) {
    return String(c.name || '').toLowerCase() === low;
  });
  if (exact.length === 1) return exact[0];
  const like = r.conversations.filter(function (c) {
    return (
      String(c.name || '')
        .toLowerCase()
        .indexOf(low) !== -1
    );
  });
  if (like.length === 1) return like[0];
  if (like.length > 1)
    throw new Error("'" + needle + '\' matches several chats — see: keyflip chat search "' + needle + '"');
  throw new Error(
    "no chat found for '" +
      needle +
      "' — looked up by uuid prefix or title in the newest " +
      (opts.resolveLimit || 200) +
      ' chats (widen with `keyflip chat --limit 500`, find by words with `keyflip chat search "<words>"`)',
  );
}

// Title search over the account's chats. Message BODIES are not searched (that would
// mean fetching every conversation); for full-text over your local transcripts use
// `keyflip recall "<query>"`.
async function search(ctx, term, opts) {
  opts = opts || {};
  const r = await list(ctx, Object.assign({ limit: 200 }, opts));
  const low = String(term || '')
    .trim()
    .toLowerCase();
  return {
    org: r.org,
    scanned: r.conversations.length,
    matches: !low
      ? r.conversations
      : r.conversations.filter(function (c) {
          return (
            String(c.name || '')
              .toLowerCase()
              .indexOf(low) !== -1
          );
        }),
  };
}

// Fetch one conversation's messages. `id` may be a full uuid, a uuid prefix, or a
// unique chat title.
async function get(ctx, id, opts) {
  opts = opts || {};
  const ch = opts.cookieHeaderOverride || cookieHeader(ctx, opts);
  const org = opts.org || ch.org || (await activeOrg(ctx, ch.cookie, opts)).uuid;
  const resolved =
    opts.noResolve || opts.resolve === false || UUID_RE.test(String(id))
      ? { uuid: String(id) }
      : await resolveConversation(ctx, id, Object.assign({}, opts, { cookieHeaderOverride: ch, org: org }));
  const conv = await api(
    '/api/organizations/' + org + '/chat_conversations/' + resolved.uuid + '?tree=True&rendering_mode=messages',
    ch.cookie,
    opts,
  );
  return conv;
}

export { list, get, search, resolveConversation, cookieHeader, cookiesDbFor, decryptCookie, activeOrg, headers };
