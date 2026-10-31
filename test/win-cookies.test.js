// #110: End-to-end fixture tests for Windows Chromium/Electron cookie decryption (DPAPI + AES-256-GCM)
// across browser.js, chat.js, chatsession.js, and browserswitch.js. Runs on every OS (macOS, Linux,
// Windows) by injecting the DPAPI unprotect step while exercising real AES-256-GCM + SQLite cookie DBs.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import * as browser from '../src/browser.js';
import * as chat from '../src/chat.js';
import * as chatsession from '../src/chatsession.js';
import * as bs from '../src/browserswitch.js';
import { SQLITE_SKIP } from './sqlite.js';

const MASTER_KEY = crypto.randomBytes(32);
const HOST_HASH = crypto.createHash('sha256').update('.claude.ai', 'utf8').digest();

// Encrypt a cookie value the way Chromium 130+ / Electron 33+ does on Windows:
//   "v10" + 12B nonce + AES-256-GCM(SHA256(host_key) + utf8(value)) + 16B tag
function encWinCookie(value, key, opts) {
  opts = opts || {};
  const prefix = opts.prefix || 'v10';
  const body = opts.noDomainHash ? Buffer.from(value, 'utf8') : Buffer.concat([HOST_HASH, Buffer.from(value, 'utf8')]);
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key || MASTER_KEY, nonce);
  const ct = Buffer.concat([c.update(body), c.final()]);
  return Buffer.concat([Buffer.from(prefix, 'latin1'), nonce, ct, c.getAuthTag()]);
}

function writeLocalState(dir, tag) {
  fs.mkdirSync(dir, { recursive: true });
  const blob = Buffer.concat([Buffer.from('DPAPI', 'latin1'), Buffer.from(tag || 'WIN-KEY')]);
  const extra = arguments[2] || {};
  fs.writeFileSync(
    path.join(dir, 'Local State'),
    JSON.stringify(Object.assign({ os_crypt: { encrypted_key: blob.toString('base64') } }, extra)),
  );
}

function writeCookiesSqlite(file, rows, opts) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cols =
    'creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,' +
    ' encrypted_value BLOB NOT NULL, path TEXT NOT NULL, expires_utc INTEGER NOT NULL,' +
    ' is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL, last_access_utc INTEGER NOT NULL';
  const ins = Object.keys(rows)
    .map(function (name, i) {
      const blob = encWinCookie(rows[name], (opts && opts.key) || MASTER_KEY, opts);
      return (
        'INSERT INTO cookies VALUES(' +
        (i + 1) +
        ",'.claude.ai','" +
        name +
        "','',cast(X'" +
        blob.toString('hex') +
        "' as BLOB),'/'," +
        (i + 1) +
        ',1,1,' +
        (i + 1) +
        ');'
      );
    })
    .join('');
  execFileSync('sqlite3', [file, 'CREATE TABLE cookies(' + cols + ');' + ins]);
  return file;
}

function dpapiFor(expectedTag, key) {
  return function (blob) {
    if (expectedTag) assert.strictEqual(blob.toString(), expectedTag);
    return key || MASTER_KEY;
  };
}

test('browser.supported() enables macOS and Windows, while keeping Linux gated', function () {
  assert.strictEqual(browser.supported('darwin'), true);
  assert.strictEqual(browser.supported('win32'), true);
  assert.strictEqual(browser.supported('linux'), false);
});

test('browser.catalog(win32) resolves %LOCALAPPDATA% User Data, Network/Cookies, and multi-profile Local State', function () {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-wincat-'));
  const localAppData = path.join(home, 'AppData', 'Local');
  const chromeData = path.join(localAppData, 'Google', 'Chrome', 'User Data');
  writeLocalState(chromeData, 'CHROME-KEY', {
    profile: {
      info_cache: {
        Default: { name: 'Person 1' },
        'Profile 2': { name: 'Work' },
      },
    },
  });

  const c = browser.catalog(home, { platform: 'win32', localAppData: localAppData });
  assert.strictEqual(c.chrome.platform, 'win32');
  assert.strictEqual(c.chrome.proc, 'chrome.exe');
  assert.strictEqual(c.chrome.cookies, path.join(chromeData, 'Default', 'Network', 'Cookies'));
  assert.strictEqual(c.chrome.profileDir, path.join(chromeData, 'Default'));
  assert.strictEqual(c.chrome.localState, path.join(chromeData, 'Local State'));

  const p2 = c['chrome-Profile-2'];
  assert.ok(p2, 'named Windows Chrome profile is discovered');
  assert.strictEqual(p2.name, 'Chrome (Work)');
  assert.strictEqual(p2.cookies, path.join(chromeData, 'Profile 2', 'Network', 'Cookies'));
  assert.strictEqual(c.edge.proc, 'msedge.exe');
  assert.strictEqual(c.brave.proc, 'brave.exe');

  const gotKey = browser.safeKey(c.chrome, { unprotect: dpapiFor('CHROME-KEY') });
  assert.ok(Buffer.isBuffer(gotKey) && gotKey.equals(MASTER_KEY));
  fs.rmSync(home, { recursive: true, force: true });
});

test('browser process controls on win32 use tasklist, graceful taskkill, and cmd start', function () {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-winproc-'));
  const b = browser.catalog(home, { platform: 'win32', localAppData: path.join(home, 'Local') }).edge;
  const calls = [];
  const runner = function (cmd, args) {
    calls.push({ cmd: cmd, args: args });
    if (cmd === 'tasklist')
      return { code: 0, stdout: 'msedge.exe                   12340 Console                    1    150,000 K\r\n' };
    return { code: 0, stdout: '' };
  };
  assert.strictEqual(browser.isRunning(b, runner), true);
  assert.strictEqual(
    browser.isRunning(b, function () {
      return { code: 0, stdout: 'INFO: No tasks are running which match the specified criteria.\r\n' };
    }),
    false,
  );
  browser.quit(b, runner);
  browser.reopen(b, runner);
  assert.strictEqual(calls[0].cmd, 'tasklist');
  assert.deepStrictEqual(calls[1], { cmd: 'taskkill', args: ['/IM', 'msedge.exe'] });
  assert.deepStrictEqual(calls[2], { cmd: 'cmd', args: ['/c', 'start', '', 'msedge.exe'] });
  fs.rmSync(home, { recursive: true, force: true });
});

test(
  'chat.cookieHeader on win32 decrypts Claude Desktop Network/Cookies via Local State DPAPI + AES-256-GCM',
  { skip: SQLITE_SKIP },
  function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-winchat-'));
    const appDataDir = path.join(root, 'Roaming', 'Claude');
    const configDir = path.join(root, 'Roaming', 'keyflip');
    fs.mkdirSync(configDir, { recursive: true });
    writeLocalState(appDataDir, 'CLAUDE-APP-KEY');
    writeCookiesSqlite(path.join(appDataDir, 'Network', 'Cookies'), {
      sessionKey: 'sk-ant-sid01-WINDOWS-LIVE-SESSION-TOKEN-1234567890',
      lastActiveOrg: 'org-win-live',
      cf_clearance: 'cf-ok',
    });

    // Also write a saved account snapshot under app/work.cookies
    const snapDir = path.join(configDir, 'app');
    fs.mkdirSync(snapDir, { recursive: true });
    writeCookiesSqlite(path.join(snapDir, 'work.cookies'), {
      sessionKey: 'sk-ant-sid01-WINDOWS-SAVED-WORK-SESSION-9999999999',
      lastActiveOrg: 'org-win-work',
    });

    const ctx = {
      platform: 'win32',
      home: root,
      appDataDir: appDataDir,
      configDir: configDir,
      dpapi: dpapiFor('CLAUDE-APP-KEY'),
    };

    const live = chat.cookieHeader(ctx);
    assert.strictEqual(live.org, 'org-win-live');
    assert.match(live.cookie, /sessionKey=sk-ant-sid01-WINDOWS-LIVE-SESSION-TOKEN-1234567890/);

    const saved = chat.cookieHeader(ctx, { account: 'work' });
    assert.strictEqual(saved.org, 'org-win-work');
    assert.match(saved.cookie, /sessionKey=sk-ant-sid01-WINDOWS-SAVED-WORK-SESSION-9999999999/);

    fs.rmSync(root, { recursive: true, force: true });
  },
);

test(
  'chat.cookieHeader on win32 reports Alt+F4 when cookies are unflushed and flags v20 App-Bound cookies',
  { skip: SQLITE_SKIP },
  function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-winerr-'));
    const appDataDir = path.join(root, 'Claude');
    writeLocalState(appDataDir, 'CLAUDE-KEY');
    writeCookiesSqlite(path.join(appDataDir, 'Network', 'Cookies'), {
      lastActiveOrg: 'org-only',
    });
    const ctx = {
      platform: 'win32',
      home: root,
      appDataDir: appDataDir,
      configDir: path.join(root, 'cfg'),
      dpapi: dpapiFor('CLAUDE-KEY'),
    };
    assert.throws(
      function () {
        chat.cookieHeader(ctx);
      },
      function (e) {
        assert.strictEqual(e.code, 'cookies-not-flushed');
        assert.match(e.message, /Alt\+F4/);
        return true;
      },
    );

    // Overwrite with v20 App-Bound encrypted cookies -> clear diagnostic code
    fs.rmSync(path.join(appDataDir, 'Network', 'Cookies'), { force: true });
    writeCookiesSqlite(path.join(appDataDir, 'Network', 'Cookies'), { sessionKey: 'sk-ant-v20' }, { prefix: 'v20' });
    assert.throws(
      function () {
        chat.cookieHeader(ctx);
      },
      function (e) {
        assert.strictEqual(e.code, 'app-bound-cookies');
        assert.match(e.message, /App-Bound Encryption \(v20\)/);
        return true;
      },
    );
    fs.rmSync(root, { recursive: true, force: true });
  },
);

test(
  'chatsession.findSession on win32 falls back to live Edge/Chrome and replays saved .sql snapshots without sh',
  { skip: SQLITE_SKIP },
  function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-winsess-'));
    const localAppData = path.join(root, 'AppData', 'Local');
    const configDir = path.join(root, 'AppData', 'Roaming', 'keyflip');
    fs.mkdirSync(configDir, { recursive: true });

    const edgeKey = crypto.randomBytes(32);
    const edgeData = path.join(localAppData, 'Microsoft', 'Edge', 'User Data');
    writeLocalState(edgeData, 'EDGE-KEY');
    const edgeCookies = path.join(edgeData, 'Default', 'Network', 'Cookies');
    writeCookiesSqlite(
      edgeCookies,
      {
        sessionKey: 'sk-ant-sid01-EDGE-LIVE-WIN32-TOKEN-ABCDEF123456',
        lastActiveOrg: 'org-edge-win',
      },
      { key: edgeKey },
    );

    const ctx = {
      platform: 'win32',
      home: root,
      localAppData: localAppData,
      appDataDir: path.join(root, 'AppData', 'Roaming', 'Claude'), // missing DB -> falls back to browser
      configDir: configDir,
      dpapi: dpapiFor('EDGE-KEY', edgeKey),
    };

    // 1) Live browser fallback on win32
    const live = chatsession.findSession(ctx);
    assert.strictEqual(live.org, 'org-edge-win');
    assert.match(live.cookie, /sessionKey=sk-ant-sid01-EDGE-LIVE-WIN32-TOKEN-ABCDEF123456/);
    assert.strictEqual(live.source, 'Edge (live browser session)');

    // 2) Capture snapshot and read back via `--as yahoo` after clearing live Edge cookies
    const installed = browser.installed(root, { platform: 'win32', localAppData: localAppData });
    assert.strictEqual(installed.length, 1);
    assert.strictEqual(installed[0].id, 'edge');
    assert.strictEqual(browser.saveSession(configDir, 'yahoo', installed[0], {}), true);

    // Wipe live cookies rows (keep schema!) so `--as yahoo` must prove snapshot replay + DPAPI decrypt
    execFileSync('sqlite3', [edgeCookies, 'DELETE FROM cookies;']);
    const fromSnap = chatsession.findSession(ctx, { account: 'yahoo' });
    assert.strictEqual(fromSnap.org, 'org-edge-win');
    assert.match(fromSnap.cookie, /sessionKey=sk-ant-sid01-EDGE-LIVE-WIN32-TOKEN-ABCDEF123456/);
    assert.match(fromSnap.source, /^saved Edge session of 'yahoo'/);

    fs.rmSync(root, { recursive: true, force: true });
  },
);

test(
  'chatsession.findSession on win32 surfaces v20 App-Bound Encryption when Chrome cookies are v20-only',
  { skip: SQLITE_SKIP },
  function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-winv20-'));
    const localAppData = path.join(root, 'AppData', 'Local');
    const chromeData = path.join(localAppData, 'Google', 'Chrome', 'User Data');
    writeLocalState(chromeData, 'CHROME-KEY');
    writeCookiesSqlite(
      path.join(chromeData, 'Default', 'Network', 'Cookies'),
      { sessionKey: 'sk-ant-v20-locked', lastActiveOrg: 'org-v20' },
      { prefix: 'v20' },
    );
    const ctx = {
      platform: 'win32',
      home: root,
      localAppData: localAppData,
      appDataDir: path.join(root, 'NoClaudeApp'),
      configDir: path.join(root, 'cfg'),
      dpapi: dpapiFor('CHROME-KEY'),
    };
    assert.throws(
      function () {
        chatsession.findSession(ctx);
      },
      function (e) {
        assert.strictEqual(e.code, 'app-bound-cookies');
        assert.match(e.message, /Chrome holds Windows v20 App-Bound cookies/);
        return true;
      },
    );
    fs.rmSync(root, { recursive: true, force: true });
  },
);

test('browserswitch.restoresTabs and align work with Windows <Profile>/Network/Cookies layout', async function () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-winbs-'));
  const localAppData = path.join(root, 'AppData', 'Local');
  const configDir = path.join(root, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'work.json'),
    JSON.stringify({ email: 'work@example.com', oauthAccount: { organizationUuid: 'org-work' } }),
  );

  const profileDir = path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default');
  const netDir = path.join(profileDir, 'Network');
  fs.mkdirSync(netDir, { recursive: true });
  fs.writeFileSync(path.join(netDir, 'Cookies'), 'dummy-sqlite');
  fs.writeFileSync(path.join(profileDir, 'Preferences'), JSON.stringify({ session: { restore_on_startup: 1 } }));

  const edge = browser.catalog(root, { platform: 'win32', localAppData: localAppData }).edge;
  assert.strictEqual(bs.restoresTabs(edge), true, 'finds Preferences in <Profile>, parent of Network/Cookies');

  fs.mkdirSync(path.join(configDir, 'browser-sessions'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'browser-sessions', 'work__edge.sql'), "INSERT INTO cookies VALUES('x');");

  let running = true;
  const cmds = [];
  const runner = function (cmd, args) {
    cmds.push(cmd + ' ' + (args || []).join(' '));
    if (cmd === 'tasklist') {
      return { code: 0, stdout: running ? 'msedge.exe 4242' : 'INFO: No tasks' };
    }
    if (cmd === 'taskkill') {
      running = false;
      return { code: 0, stdout: '' };
    }
    return { code: 0, stdout: '' };
  };

  const res = await bs.align(
    { platform: 'win32', home: root, localAppData: localAppData, configDir: configDir },
    'work',
    {
      run: runner,
      sleep: async function () {},
    },
  );
  assert.deepStrictEqual(res.synced, ['Edge']);
  assert.ok(
    cmds.some(function (c) {
      return c.indexOf('taskkill /IM msedge.exe') === 0;
    }),
    'quits Edge with graceful taskkill',
  );
  assert.ok(
    cmds.some(function (c) {
      return c.indexOf('cmd /c start  msedge.exe') === 0;
    }),
    'reopens Edge via cmd /c start',
  );
  fs.rmSync(root, { recursive: true, force: true });
});
