// Resolve a claude.ai session cookie from ANY surface on this machine that has one.
//
// Why `chat.js` alone wasn't enough: Electron / Chromium keeps session cookies in memory
// and only flushes them on a clean quit — current Claude desktop builds don't write
// `sessionKey` to `<appData>/Cookies` at all, so reading only the app's DB failed both
// for the live account (while the app was open) and for `--as <other>` (the snapshot
// taken from that DB never had a `sessionKey` either).
//
// Meanwhile a Chromium browser DOES write `sessionKey`, and keyflip already snapshots
// those cookies as portable SQL (`browser-sessions/<account>__<browser>.sql`, the
// `browser sync` feature). Reloading that SQL into a throwaway SQLite file and
// decrypting with the browser's own Safe Storage / DPAPI key reads ANY captured account's
// cloud history without switching, clearing, or restoring anything.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { run } from './exec.js';
import * as chat from './chat.js';
import * as browser from './browser.js';

const SESSION_NAMES = ['sessionKey', 'sessionKeyV3'];

function hasSession(cookieString) {
  return SESSION_NAMES.some(function (n) {
    return String(cookieString || '').indexOf(n + '=') !== -1;
  });
}

// browser-sessions/<account>__<browserId>.sql, newest first.
function snapshotsFor(ctx, account) {
  const dir = path.join(ctx.configDir, 'browser-sessions');
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
  const rows = [];
  files.forEach(function (f) {
    const m = new RegExp('^' + account.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '__([a-zA-Z0-9_-]+)\\.sql$').exec(f);
    if (!m) return;
    const p = path.join(dir, f);
    let st = null;
    try {
      st = fs.statSync(p);
    } catch (e) {
      return;
    }
    rows.push({ file: p, browserId: m[1], mtime: st.mtime });
  });
  return rows.sort(function (a, b) {
    return b.mtime - a.mtime;
  });
}

// How old a saved session is, on the user's own clock — a UTC stamp makes a capture from
// ten minutes ago look stale.
function stampLocal(d) {
  const p = function (n) {
    return String(n).padStart(2, '0');
  };
  return (
    d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  );
}

function tableSchemaFrom(browserDb, runner) {
  if (!browserDb) return null;
  const tmp = path.join(os.tmpdir(), 'keyflip-schem-' + process.pid + '-' + Date.now() + '.db');
  try {
    fs.copyFileSync(browserDb, tmp);
  } catch (e) {
    return null;
  }
  try {
    const r = (runner || run)('sqlite3', [tmp, '.schema cookies']);
    if (!r || r.code !== 0) return null;
    return /CREATE TABLE/i.test(String(r.stdout)) ? r.stdout : null;
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (e) {
      /* */
    }
  }
}

// The snapshot stores whole INSERT statements. They are written with `.mode insert`,
// which has NO column list, so the table is rebuilt from the explicit column list if the
// file has one and otherwise from the live browser's own `cookies` schema (snapshots are
// machine-bound anyway — they only decrypt with that browser's key on this machine).
// Replay passes SQL via stdin directly to `sqlite3` (cross-platform: no POSIX `sh -c`).
function snapshotToCookieRows(sqlFile, b, runner) {
  let text = '';
  try {
    text = String(fs.readFileSync(sqlFile, 'utf8'));
  } catch (e) {
    return null;
  }
  const ins = /INSERT INTO\s*"?([A-Za-z_][A-Za-z_0-9]*)"?\s*(\(([^)]*)\))?\s*VALUES/is.exec(text);
  if (!ins) return null;
  const table = ins[1];
  const create = ins[3]
    ? 'CREATE TABLE ' + table + ' (' + ins[3].replace(/\s+/g, ' ') + ');'
    : tableSchemaFrom(b && b.cookies, runner);
  if (!create) return null;
  const tmp = path.join(os.tmpdir(), 'keyflip-snap-' + process.pid + '-' + Date.now() + '.db');
  try {
    let r = (runner || run)('sqlite3', [tmp, create]);
    if (!r || r.code !== 0) return null;
    r = (runner || run)('sqlite3', [tmp], text + '\n');
    if (!r || r.code !== 0) return null;
    r = (runner || run)('sqlite3', [
      '-separator',
      '\x01',
      chat.sqliteRoArg(tmp),
      'SELECT name,quote(encrypted_value) FROM ' + table + " WHERE host_key LIKE '%claude.ai';",
    ]);
    if (!r || r.code !== 0) return null;
    return r.stdout;
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (e) {
      /* */
    }
  }
}

function byId(list, id) {
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

// -> { cookie, org, source } or null; never throws for "not found" reasons.
function findSession(ctx, opts) {
  opts = opts || {};
  const account = opts.account || null;
  const unprotect = opts.dpapi || (ctx && ctx.dpapi);
  const browsers =
    opts.browsers ||
    browser.installed(ctx.home, {
      platform: ctx && ctx.platform,
      localAppData: (opts && opts.localAppData) || (ctx && ctx.localAppData),
    });
  const appBoundBrowsers = [];
  const readCookies =
    opts.readBrowserCookies ||
    function (b) {
      return browser.readClaudeCookies(b, {
        run: opts.run,
        unprotect: unprotect,
        onAppBound: function (br) {
          appBoundBrowsers.push(br.name);
        },
      });
    };
  const keyFor =
    opts.browserKey ||
    function (b) {
      return browser.safeKey(b, { run: opts.run, unprotect: unprotect });
    };

  if (account) {
    const notes = [];
    const snaps = snapshotsFor(ctx, account);
    for (let i = 0; i < snaps.length; i++) {
      const s = snaps[i];
      const b = byId(browsers, s.browserId);
      if (!b) {
        notes.push(s.browserId + ' is not installed here (cookies are machine-bound)');
        continue;
      }
      const rows = snapshotToCookieRows(s.file, b, opts.run);
      if (!rows) {
        notes.push('could not read the saved ' + b.name + ' session');
        continue;
      }
      const key = keyFor(b);
      const parsed = key ? browser.parseCookieRows(rows, key) : null;
      if (parsed && hasSession(parsed.cookie))
        return {
          cookie: parsed.cookie,
          org: parsed.org,
          source: 'saved ' + b.name + " session of '" + account + "' (" + stampLocal(s.mtime) + ')',
        };
      if (browser.hasAppBoundRows(rows)) {
        notes.push(
          'the saved ' + b.name + ' session uses Windows App-Bound Encryption (v20, unreadable outside ' + b.name + ')',
        );
      } else {
        notes.push('the saved ' + b.name + ' session has no claude.ai login cookie');
      }
    }
    // The desktop app's own snapshot still works on builds that persist it.
    try {
      const ch = chat.cookieHeader(ctx, {
        account: account,
        dpapi: unprotect,
        localStatePath: opts.localStatePath,
        masterKey: opts.masterKey,
        run: opts.run,
      });
      return { cookie: ch.cookie, org: ch.org, source: "saved desktop-app login of '" + account + "'" };
    } catch (e) {
      if (
        e &&
        e.code !== 'cookies-not-flushed' &&
        e.code !== 'app-bound-cookies' &&
        !/no saved desktop-app cookie/.test(String(e.message))
      )
        throw e;
      notes.push('desktop-app snapshot: ' + e.message);
    }
    throw Object.assign(
      new Error(
        "no readable claude.ai session for '" +
          account +
          "' — " +
          (notes.join('; ') || 'nothing saved') +
          '. Fix: sign into claude.ai in a browser as ' +
          account +
          ' and run `keyflip browser capture ' +
          account +
          '` once — that SAVES the session for later reading (`keyflip browser sync` is the opposite: it restores a saved session into the browser).',
      ),
      { code: 'no-session' },
    );
  }

  // Live account: the app first (unchanged behaviour when it works)...
  let appErr = null;
  try {
    const ch = chat.cookieHeader(ctx, {
      dpapi: unprotect,
      localStatePath: opts.localStatePath,
      masterKey: opts.masterKey,
      run: opts.run,
    });
    return { cookie: ch.cookie, org: ch.org, source: 'the Claude desktop app' };
  } catch (e) {
    appErr = e;
  }
  // ...then any browser that actually holds the claude.ai session.
  for (let i = 0; i < browsers.length; i++) {
    const b = browsers[i];
    let ck = null;
    try {
      ck = readCookies(b);
    } catch (e) {
      continue;
    }
    if (ck && hasSession(ck.cookie))
      return { cookie: ck.cookie, org: ck.org, source: b.name + ' (live browser session)' };
  }
  const isWin = !!(ctx && ctx.platform === 'win32');
  const quitHint = isWin ? 'Alt+F4 / File → Exit' : 'Cmd+Q';
  const appBoundHint = appBoundBrowsers.length
    ? ' (' +
      appBoundBrowsers.join(', ') +
      ' holds Windows v20 App-Bound cookies that cannot be decrypted outside the browser — sign into the Claude desktop app instead)'
    : '';
  throw Object.assign(
    new Error(
      'no claude.ai session cookie found on this machine — the desktop app has not written one' +
        (appErr && appErr.code === 'cookies-not-flushed'
          ? ' (it is held in memory: quit it with ' + quitHint + ' once)'
          : '') +
        ' and no installed browser has a readable claude.ai session' +
        appBoundHint +
        '. Open claude.ai in a browser (or use `keyflip chat --flush`), then retry.',
    ),
    {
      code:
        appBoundBrowsers.length && (!appErr || appErr.code !== 'cookies-not-flushed')
          ? 'app-bound-cookies'
          : 'no-session',
    },
  );
}

function withSession(ctx, opts) {
  opts = opts || {};
  if (opts.cookieHeaderOverride) return opts;
  const s = findSession(ctx, opts);
  return Object.assign({}, opts, { cookieHeaderOverride: { cookie: s.cookie, org: s.org }, sessionSource: s.source });
}

async function list(ctx, opts) {
  return chat.list(ctx, withSession(ctx, opts));
}
async function get(ctx, id, opts) {
  return chat.get(ctx, id, withSession(ctx, opts));
}
async function search(ctx, term, opts) {
  return chat.search(ctx, term, withSession(ctx, opts));
}

export { findSession, withSession, hasSession, snapshotsFor, snapshotToCookieRows, list, get, search };
