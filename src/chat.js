// EXPERIMENTAL: read claude.ai "Chat" conversations — for the account the desktop
// app is currently signed into, OR for ANY captured account (chat.js can also read a
// saved desktop-app cookie snapshot, see cookieHeader's `account` option).
// Chat history is SERVER-SIDE, so this calls the (undocumented) claude.ai web API
// using a claude.ai session cookie, decrypted from a Cookies DB with the Electron
// safeStorage key (macOS Keychain PBKDF2+AES-128-CBC, or Windows Local State DPAPI+AES-256-GCM).
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
import * as _win from './wincrypt.js';

// The Electron safeStorage password (login Keychain), used to decrypt cookies on macOS.
function safeStoragePassword(ctx) {
  if (ctx && ctx.safeStoragePassword) return ctx.safeStoragePassword;
  const r = run('/usr/bin/security', ['find-generic-password', '-s', 'Claude Safe Storage', '-a', 'Claude Key', '-w']);
  return r.code === 0 ? r.stdout.replace(/\r?\n$/, '') : null;
}

// Resolve the desktop app's cookie decryption key:
//   win32  -> 32-byte Buffer (DPAPI-unprotected `os_crypt.encrypted_key` from Local State)
//   darwin -> string password from Keychain (`Claude Safe Storage`)
function desktopCookieKey(ctx, opts) {
  opts = opts || {};
  if (opts.masterKey && Buffer.isBuffer(opts.masterKey)) return opts.masterKey;
  if (ctx && Buffer.isBuffer(ctx.masterKey)) return ctx.masterKey;
  if (ctx && ctx.platform === 'win32') {
    const lsPath =
      opts.localStatePath || ctx.localStatePath || (ctx.appDataDir ? path.join(ctx.appDataDir, 'Local State') : null);
    return _win.masterKeyFromFile(lsPath, {
      unprotect: opts.dpapi || ctx.dpapi,
      run: opts.run,
    });
  }
  return safeStoragePassword(ctx);
}

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Decrypt one Chromium cookie `encrypted_value`:
//   • When `key` is a 32-byte Buffer (Windows DPAPI master key), uses AES-256-GCM (v10/v11).
//   • When `key` is a string password (macOS Keychain Safe Storage), uses PBKDF2 + AES-128-CBC (v10).
// Newer Chromium prepends a 32-byte domain hash to the plaintext; strip it when present.
function decryptCookie(encBuf, password, opts) {
  if (Buffer.isBuffer(password)) return _win.decryptCookie(encBuf, password, opts);
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

// SQLite read-only target: POSIX uses a `file:<tmp>?mode=ro` URI; Windows drive paths (`C:\...`)
// are passed directly (we already copied to an isolated temp file, and raw backslashes break `file:` URIs).
function sqliteRoArg(tmpPath) {
  if (process.platform === 'win32' || /^[A-Za-z]:[\\/]/.test(String(tmpPath))) return tmpPath;
  return 'file:' + tmpPath + '?mode=ro';
}

// Which Cookies DB to read for a claude.ai session:
//   no account          -> the LIVE desktop-app DB (`Network/Cookies` on Windows Electron if present, else `Cookies`)
//   account: '<name>'   -> that profile's saved snapshot (app/<name>.cookies), so a
//                          chat can be read WITHOUT switching surfaces.
function cookiesDbFor(ctx, opts) {
  const account = opts && opts.account;
  if (!account) {
    if (!ctx || !ctx.appDataDir) return null;
    if (ctx.platform === 'win32') {
      const netCk = path.join(ctx.appDataDir, 'Network', 'Cookies');
      if (fs.existsSync(netCk)) return netCk;
    }
    return path.join(ctx.appDataDir, 'Cookies');
  }
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
  const isWin = !!(ctx && ctx.platform === 'win32');
  const runner = opts.run || run;
  const key = desktopCookieKey(ctx, opts);
  if (!key)
    throw new Error(
      isWin
        ? 'cannot read the Claude desktop master key (Local State / DPAPI) — is the desktop app installed?'
        : 'cannot read the Electron safeStorage key (Keychain) — is the desktop app installed?',
    );
  const src = opts.cookiesFile || cookiesDbFor(ctx, opts);
  if (!src) throw new Error('no Claude desktop app data directory (macOS/Windows only)');
  const tmp = path.join(os.tmpdir(), 'keyflip-ck-' + process.pid + '-' + Date.now() + '.db');
  try {
    fs.copyFileSync(src, tmp);
  } catch (e) {
    throw new Error('no desktop Cookies DB at ' + src + ' — sign into the Claude desktop app first');
  }
  try {
    const r = runner('sqlite3', [
      '-separator',
      '\x01',
      sqliteRoArg(tmp),
      "SELECT name,quote(encrypted_value) FROM cookies WHERE host_key LIKE '%claude.ai';",
    ]);
    if (!r || r.code !== 0) {
      const missingCli = r && r.error && r.error.code === 'ENOENT';
      throw new Error(
        'could not read cookies (sqlite3): ' +
          (missingCli
            ? 'sqlite3 CLI is not in PATH' + (isWin ? ' (install with: winget install SQLite.SQLite)' : '')
            : (r && r.stderr) || (r && r.code)),
      );
    }
    const pairs = [];
    const names = Object.create(null);
    let org = null;
    let sawAppBound = false;
    String(r.stdout || '')
      .trim()
      .split('\n')
      .forEach(function (line) {
        const i = line.indexOf('\x01');
        if (i === -1) return;
        const name = line.slice(0, i);
        const hex = line.slice(i + 1).replace(/^X'|'$/g, '');
        const rawBuf = Buffer.from(hex, 'hex');
        const val = decryptCookie(rawBuf, key);
        if (val == null) {
          if (_win.isAppBoundCookie(rawBuf)) sawAppBound = true;
          return;
        }
        pairs.push(name + '=' + val);
        names[name] = true;
        if (name === 'lastActiveOrg') org = val;
      });
    if (!pairs.length) {
      if (sawAppBound)
        throw Object.assign(
          new Error(
            'cookies use Windows App-Bound Encryption (v20) and cannot be decrypted by a user process — use the Claude desktop app (v10) or a browser without v20 enforcement',
          ),
          { code: 'app-bound-cookies' },
        );
      throw new Error('no readable claude.ai cookies (not signed in?)');
    }
    // Chromium keeps the CURRENT session in memory and only writes it out on a clean
    // quit, so a live app's DB can hold no sessionKey at all. Say what to do about it
    // instead of letting the API answer 403 and looking like a broken login.
    if (!names.sessionKey && !names.sessionKeyV3) {
      const quitHint = isWin ? '(Alt+F4 / File → Exit)' : '(Cmd+Q)';
      throw Object.assign(
        new Error(
          'the Claude desktop app has not written its session cookie to disk yet (it is held in memory) — quit the app once ' +
            quitHint +
            ' and retry, or run `keyflip chat --flush`',
        ),
        { code: 'cookies-not-flushed' },
      );
    }
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

// --- Local Claude Code transcripts (disk-based) ---------------------------------

// Find all local Claude Code session transcripts under ~/.claude/projects/<cwd-slug>/*.jsonl
// Returns [{ id, title, cwd, updatedAt, messageCount, source: 'local' }]
function listLocal(opts) {
  opts = opts || {};
  const baseDir = opts.baseDir || path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(baseDir)) return [];

  const sessions = [];
  const cwdSlugs = fs.readdirSync(baseDir);

  cwdSlugs.forEach(function (cwdSlug) {
    const cwdPath = path.join(baseDir, cwdSlug);
    if (!fs.statSync(cwdPath).isDirectory()) return;

    // Read all JSONL files in this cwd directory
    const files = fs.readdirSync(cwdPath).filter(function (f) {
      return f.endsWith('.jsonl') && !f.endsWith('.meta.json');
    });

    files.forEach(function (file) {
      const uuid = file.replace('.jsonl', '');
      const jsonlPath = path.join(cwdPath, file);
      const metaPath = path.join(cwdPath, uuid + '.meta.json');

      // Read metadata if available
      let title = uuid.slice(0, 8); // fallback to short UUID
      let updatedAt = null;

      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          if (meta.title) title = meta.title;
          if (meta.updatedAt) updatedAt = meta.updatedAt;
        } catch (e) {
          // ignore malformed meta
        }
      }

      // Count messages by reading first/last lines of JSONL
      let messageCount = 0;
      try {
        const stats = fs.statSync(jsonlPath);
        if (stats.size > 0) {
          // Quick count: read file and count newlines (approximate but fast)
          const content = fs.readFileSync(jsonlPath, 'utf8');
          const lines = content.split('\n').filter(function (l) {
            return l.trim();
          });
          // Only count user/assistant messages (skip tool results)
          lines.forEach(function (line) {
            try {
              const j = JSON.parse(line);
              if ((j.type === 'user' || j.type === 'assistant') && j.message) {
                messageCount++;
              }
            } catch (e) {
              // skip parse errors
            }
          });
        }
        if (!updatedAt) updatedAt = stats.mtime.toISOString();
      } catch (e) {
        // ignore unreadable files
      }

      if (messageCount > 0) {
        sessions.push({
          id: uuid,
          title: title,
          cwd: cwdSlug,
          updatedAt: updatedAt,
          messageCount: messageCount,
          source: 'local',
        });
      }
    });
  });

  // Sort by most recent first
  sessions.sort(function (a, b) {
    if (!a.updatedAt) return 1;
    if (!b.updatedAt) return -1;
    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });

  return sessions;
}

// Read a local transcript file and parse it into chat messages
// Returns { messages: [{role, text, ts}], cwd, counts }
async function getLocal(uuid, opts) {
  opts = opts || {};
  const baseDir = opts.baseDir || path.join(os.homedir(), '.claude', 'projects');

  // Search for the JSONL file across all cwd directories
  let jsonlPath = null;
  let cwdSlug = null;

  if (fs.existsSync(baseDir)) {
    const cwdSlugs = fs.readdirSync(baseDir);
    for (let i = 0; i < cwdSlugs.length; i++) {
      const slug = cwdSlugs[i];
      const candidate = path.join(baseDir, slug, uuid + '.jsonl');
      if (fs.existsSync(candidate)) {
        jsonlPath = candidate;
        cwdSlug = slug;
        break;
      }
    }
  }

  if (!jsonlPath) {
    throw new Error("no local transcript found for '" + uuid + "' in " + baseDir);
  }

  // Read and parse the JSONL
  const jsonl = fs.readFileSync(jsonlPath, 'utf8');
  // Import transcript parser dynamically (avoid circular dependency)
  const transcriptMod = await import('./transcript.js');
  const parsed = transcriptMod.parse(jsonl);

  return {
    messages: parsed.messages,
    cwd: cwdSlug,
    counts: parsed.counts,
    source: 'local',
  };
}

export {
  list,
  get,
  search,
  resolveConversation,
  cookieHeader,
  cookiesDbFor,
  desktopCookieKey,
  decryptCookie,
  sqliteRoArg,
  activeOrg,
  headers,
  listLocal,
  getLocal,
};
