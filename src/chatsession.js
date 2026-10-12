// Where a claude.ai SESSION actually lives — the routing layer in front of chat.js.
//
// chat.js was written against one source: the Claude desktop app's Cookies DB. That
// stopped being enough. Current desktop builds keep their claude.ai `sessionKey` in
// MEMORY and only persist analytics/Cloudflare cookies, so the app's on-disk jar can
// look signed-in yet carry no session at all. The browser that logged into claude.ai
// does persist it (Chrome here), and keyflip already saves per-account snapshots of
// those cookies as portable SQL (browser-sessions/<account>__<browser>.sql, the
// encrypted_value bytes verbatim).
//
// So a session is looked for, in order, in:
//   live account   : desktop app DB -> any installed browser's claude.ai cookies
//   --as <account> : that account's saved BROWSER snapshot (decrypts with that
//                    browser's own key on THIS machine, touches no browser) ->
//                    that account's saved desktop-app cookie snapshot
//
// Nothing here writes: `keyflip chat --as <account>` reads the other account's cloud
// history without switching, clearing, or restoring anything.
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
    const m = new RegExp('^' + account.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '__([a-z]+)\\.sql$').exec(f);
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

// The snapshot stores whole INSERT statements. They are written with `.mode insert`,
// which has NO column list, so the table is rebuilt from the explicit column list if the
// file has one and otherwise from the live browser's own `cookies` schema (snapshots are
// machine-bound anyway — they only decrypt with that browser's key on this machine). Then
// the rows read back exactly like a live cookie DB.
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
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
    if (r.code !== 0) return null;
    r = (runner || run)('sh', ['-c', 'sqlite3 ' + shq(tmp) + ' < ' + shq(sqlFile)]);
    if (r.code !== 0) return null;
    r = (runner || run)('sqlite3', [
      '-separator',
      '\x01',
      'file:' + tmp + '?mode=ro',
      'SELECT name,quote(encrypted_value) FROM ' + table + " WHERE host_key LIKE '%claude.ai';",
    ]);
    if (r.code !== 0) return null;
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
  const browsers = opts.browsers || browser.installed(ctx.home);
  const readCookies =
    opts.readBrowserCookies ||
    function (b) {
      return browser.readClaudeCookies(b, { run: opts.run });
    };
  const keyFor =
    opts.browserKey ||
    function (b) {
      return browser.safeKey(b, opts.run);
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
      notes.push('the saved ' + b.name + ' session has no claude.ai login cookie');
    }
    // The desktop app's own snapshot still works on builds that persist it.
    try {
      const ch = chat.cookieHeader(ctx, { account: account });
      return { cookie: ch.cookie, org: ch.org, source: "saved desktop-app login of '" + account + "'" };
    } catch (e) {
      if (e && e.code !== 'cookies-not-flushed' && !/no saved desktop-app cookie/.test(String(e.message))) throw e;
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
    const ch = chat.cookieHeader(ctx);
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
  throw Object.assign(
    new Error(
      'no claude.ai session cookie found on this machine — the desktop app has not written one' +
        (appErr && appErr.code === 'cookies-not-flushed' ? ' (it is held in memory: quit it with Cmd+Q once)' : '') +
        ' and no installed browser is signed into claude.ai. Open claude.ai in a browser (or use `keyflip chat --flush`), then retry.',
    ),
    { code: 'no-session' },
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
