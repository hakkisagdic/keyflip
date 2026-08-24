// EXPERIMENTAL: read claude.ai "Chat" conversations for the account the desktop
// app is currently signed into. Chat history is SERVER-SIDE, so this calls the
// (undocumented) claude.ai web API using the app's own session cookie, decrypted
// from the Cookies DB with the Electron safeStorage key.
//
// Caveats (documented for the user): unofficial API that can change; requires a
// FRESH Cloudflare clearance cookie (cf_clearance/__cf_bm) — it works reliably
// right after using the desktop app, and may return 403 when those are stale;
// read-only; only sees whichever account the live cookie belongs to.
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

// Build the claude.ai cookie header from the desktop app's Cookies DB.
function cookieHeader(ctx) {
  const password = safeStoragePassword(ctx);
  if (!password) throw new Error('cannot read the Electron safeStorage key (Keychain) — is the desktop app installed?');
  const src = path.join(ctx.appDataDir, 'Cookies');
  const tmp = path.join(os.tmpdir(), 'keyflip-ck-' + process.pid + '.db');
  try {
    fs.copyFileSync(src, tmp);
  } catch (e) {
    throw new Error('no desktop Cookies DB — sign into the Claude desktop app first');
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
        if (name === 'lastActiveOrg') org = val;
      });
    if (!pairs.length) throw new Error('no readable claude.ai cookies (not signed in?)');
    return { cookie: pairs.join('; '), org: org };
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

// List Chat conversations for the active account.
async function list(ctx, opts) {
  opts = opts || {};
  const ch = opts.cookieHeaderOverride || cookieHeader(ctx); // test seam
  const org = ch.org || (await activeOrg(ctx, ch.cookie, opts)).uuid;
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

// Fetch one conversation's messages.
async function get(ctx, id, opts) {
  opts = opts || {};
  const ch = cookieHeader(ctx);
  const org = ch.org || (await activeOrg(ctx, ch.cookie, opts)).uuid;
  const conv = await api(
    '/api/organizations/' + org + '/chat_conversations/' + id + '?tree=True&rendering_mode=messages',
    ch.cookie,
    opts,
  );
  return conv;
}

export { list, get, cookieHeader, decryptCookie, activeOrg, headers };
