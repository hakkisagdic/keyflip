// Session SOURCING for claude.ai Chat (chatsession.js): the reader in chat.js only knew
// one place to look, and current desktop builds keep their claude.ai `sessionKey` in
// memory — so these tests cover where a session is really found: a saved browser snapshot
// for another account (in the exact `.mode insert` shape keyflip writes, with no column
// list), the live app DB when it has a session, the browser fallback when it does not, and
// the guidance when nothing holds one. No Keychain and no network: the browser cookie key
// and fetch are injected.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import * as chatsession from '../src/chatsession.js';

const PW = 'unit-test-password';
const KEY = crypto.pbkdf2Sync(PW, 'saltysalt', 1003, 16, 'sha1');

function enc(plaintext) {
  const d = crypto.createCipheriv('aes-128-cbc', KEY, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from('v10'), d.update(plaintext), d.final()]);
}

// A stand-in for an installed Chromium browser: a Cookies DB with the browser's own
// `cookies` schema, so a snapshot taken from it needs that schema to be reloaded.
function browserDb(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-chatsess-'));
  const file = path.join(dir, 'Cookies');
  const cols =
    'creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,' +
    ' encrypted_value BLOB NOT NULL, path TEXT NOT NULL, expires_utc INTEGER NOT NULL,' +
    ' is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL, last_access_utc INTEGER NOT NULL';
  const ins = Object.keys(rows)
    .map(function (name, i) {
      return (
        'INSERT INTO cookies VALUES(' +
        i +
        ",'.claude.ai','" +
        name +
        "','',cast(X'" +
        enc(rows[name]).toString('hex') +
        "' as BLOB),'/'," +
        i +
        ',0,0,' +
        i +
        ');'
      );
    })
    .join('');
  execFileSync('sqlite3', [file, 'CREATE TABLE cookies(' + cols + ');' + ins]);
  return { id: 'chrome', name: 'Chrome', cookies: file };
}

// Exactly what `keyflip browser sync` stashes: whole INSERT statements, no column list.
function snapshotFile(b, configDir, account) {
  const sql = execFileSync(
    'sqlite3',
    ['-cmd', '.mode insert cookies', b.cookies, "SELECT * FROM cookies WHERE host_key LIKE '%claude.ai';"],
    { encoding: 'utf8' },
  ).trim();
  const dir = path.join(configDir, 'browser-sessions');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, account + '__' + b.id + '.sql');
  fs.writeFileSync(p, sql, { mode: 0o600 });
  return p;
}

function ctxWith(appCookies, extra) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-chatsess-'));
  const configDir = path.join(root, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const ctx = Object.assign({ configDir: configDir, home: root, safeStoragePassword: PW, platform: 'darwin' }, extra);
  if (appCookies) {
    const app = path.join(root, 'Claude');
    fs.mkdirSync(app, { recursive: true });
    ctx.appDataDir = app;
    fs.copyFileSync(browserDb(appCookies).cookies, path.join(app, 'Cookies'));
  }
  return ctx;
}

test('hasSession recognizes either session cookie name', function () {
  assert.ok(chatsession.hasSession('a=1; sessionKey=xyz'));
  assert.ok(chatsession.hasSession('sessionKeyV3=xyz'));
  assert.ok(!chatsession.hasSession('a=1; __cf_bm=xyz'), 'analytics cookies are not a session');
  assert.ok(!chatsession.hasSession(''));
});

test('--as reads another account from its saved BROWSER snapshot, untouched', function () {
  const b = browserDb({ sessionKey: 'SESSION-Y', lastActiveOrg: 'org-yahoo' });
  const ctx = ctxWith({ sessionKey: 'SESSION-LIVE', lastActiveOrg: 'org-live' });
  snapshotFile(b, ctx.configDir, 'yahoo');
  const s = chatsession.findSession(ctx, {
    account: 'yahoo',
    browsers: [b],
    browserKey: function () {
      return PW;
    },
  });
  assert.match(s.cookie, /sessionKey=SESSION-Y/);
  assert.strictEqual(s.org, 'org-yahoo', 'the org follows the snapshot, not the live login');
  assert.match(s.source, /^saved Chrome session of 'yahoo'/);
  assert.match(s.source, /\d{4}-\d\d-\d\d \d\d:\d\d/, 'says how stale the saved session is');
});

test('--as on an account with no saved session says how to get one', function () {
  const ctx = ctxWith({ sessionKey: 'SESSION-LIVE' });
  assert.throws(
    function () {
      chatsession.findSession(ctx, { account: 'nevercaptured', browsers: [] });
    },
    function (e) {
      assert.strictEqual(e.code, 'no-session');
      assert.match(e.message, /keyflip browser sync nevercaptured/);
      return true;
    },
  );
});

test('--as names the browser when its snapshot was taken on another machine', function () {
  const b = browserDb({ sessionKey: 'SESSION-Y', lastActiveOrg: 'org-yahoo' });
  const ctx = ctxWith(null);
  snapshotFile(b, ctx.configDir, 'yahoo');
  assert.throws(function () {
    // The snapshot says Chrome, but Chrome is not installed here — cookies cannot be
    // decrypted without that browser's own key on this machine.
    chatsession.findSession(ctx, {
      account: 'yahoo',
      browsers: [],
      browserKey: function () {
        return PW;
      },
    });
  }, /is not installed here/);
});

test('the live app cookie is preferred while it is actually on disk', function () {
  const ctx = ctxWith({ sessionKey: 'SESSION-APP', lastActiveOrg: 'org-app' });
  const s = chatsession.findSession(ctx, {
    browsers: [],
    readBrowserCookies: function () {
      return { cookie: 'sessionKey=FROM-BROWSER', org: 'org-browser' };
    },
  });
  assert.match(s.cookie, /sessionKey=SESSION-APP/);
  assert.strictEqual(s.org, 'org-app');
  assert.strictEqual(s.source, 'the Claude desktop app');
});

test('when the app keeps its session in memory, the browser that has it is used', function () {
  // The common case on current desktop builds: the app's jar is readable but holds no
  // sessionKey, and Chrome (which does persist it) can carry the read.
  const ctx = ctxWith({ lastActiveOrg: 'org-app', __cf_bm: 'noise' });
  const s = chatsession.findSession(ctx, {
    browsers: [{ id: 'chrome', name: 'Chrome' }],
    readBrowserCookies: function () {
      return { cookie: 'sessionKey=FROM-BROWSER; lastActiveOrg=org-chrome', org: 'org-chrome' };
    },
  });
  assert.match(s.cookie, /FROM-BROWSER/);
  assert.strictEqual(s.org, 'org-chrome');
  assert.strictEqual(s.source, 'Chrome (live browser session)');
});

test('nothing holds a session -> tell the user what to open', function () {
  const ctx = ctxWith({ lastActiveOrg: 'org-app' });
  assert.throws(
    function () {
      chatsession.findSession(ctx, {
        browsers: [{ id: 'chrome', name: 'Chrome' }],
        readBrowserCookies: function () {
          return null;
        },
      });
    },
    function (e) {
      assert.strictEqual(e.code, 'no-session');
      assert.match(e.message, /Cmd\+Q/);
      assert.match(e.message, /claude\.ai in a browser/);
      return true;
    },
  );
});

test('withSession feeds the resolved cookie to chat.js and keeps the source label', function () {
  const ctx = ctxWith({ lastActiveOrg: 'org-app' });
  const o = chatsession.withSession(ctx, {
    limit: 7,
    browsers: [{ id: 'chrome', name: 'Chrome' }],
    readBrowserCookies: function () {
      return { cookie: 'sessionKey=FROM-BROWSER', org: 'org-chrome' };
    },
  });
  assert.strictEqual(o.limit, 7, 'the other options still reach chat.js');
  assert.strictEqual(o.cookieHeaderOverride.cookie, 'sessionKey=FROM-BROWSER');
  assert.strictEqual(o.sessionSource, 'Chrome (live browser session)');
});

test('withSession leaves an explicit override alone (tests, and callers that already resolved)', function () {
  const o = chatsession.withSession({}, { cookieHeaderOverride: { cookie: 'given=1', org: 'org-given' } });
  assert.strictEqual(o.cookieHeaderOverride.cookie, 'given=1');
  assert.strictEqual(o.sessionSource, undefined);
});

test('list() runs through the sourced session, so an account flag reaches the right org', async function () {
  const b = browserDb({ sessionKey: 'SESSION-Y', lastActiveOrg: 'org-yahoo' });
  const ctx = ctxWith(null);
  snapshotFile(b, ctx.configDir, 'yahoo');
  let asked = null;
  const r = await chatsession.list(ctx, {
    account: 'yahoo',
    browsers: [b],
    browserKey: function () {
      return PW;
    },
    fetch: async function (url) {
      asked = url;
      return { ok: true, status: 200, json: async () => [] };
    },
  });
  assert.strictEqual(r.org, 'org-yahoo');
  assert.match(asked, /organizations\/org-yahoo\/chat_conversations/);
});
