// Black-box acceptance tests for `keyflip browser sync|status|capture` (work item
// 20261116-tarayici-oturumu). The real CLI runs against a temp HOME with fixture browser dirs, a fake
// `claude` on PATH and fixture cookie values only. A closed browser (Brave) is used wherever the
// command may legitimately touch the browser; Chrome is only used in the no --yes path.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'keyflip.js');
const SECRET = 'FIXTURE-COOKIE-VALUE-9f3a';
const ORG = { alpha: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', beta: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb' };

const DESK_UUID = 'dddddddd-3333-4333-8333-dddddddddddd'; // the Desktop folder is an account UUID, never a profile name

function sh(cmd, args, input) {
  return spawnSync(cmd, args, { encoding: 'utf8', input: input });
}

function mkHome(o) {
  o = o || {};
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-bsync-'));
  const cfg = path.join(home, '.config', 'keyflip');
  fs.mkdirSync(cfg, { recursive: true });
  ['alpha', 'beta'].forEach(function (n) {
    fs.writeFileSync(
      path.join(cfg, n + '.json'),
      JSON.stringify({
        name: n,
        email: n + '@example.com',
        schemaVersion: 1,
        oauthAccount: { emailAddress: n + '@example.com', organizationUuid: ORG[n] },
      }),
    );
  });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"live":"x"}');
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: o.cli + '@example.com', organizationUuid: ORG[o.cli] } }),
  );
  // fake `claude auth status`
  const bin = path.join(home, 'fakebin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'claude'),
    '#!/bin/sh\necho \'{"loggedIn":true,"email":"' + o.cli + '@example.com","orgId":"' + ORG[o.cli] + '"}\'\n',
    { mode: 0o755 },
  );
  if (o.desktop) {
    const app = path.join(home, 'Library', 'Application Support', 'Claude');
    fs.mkdirSync(path.join(app, 'claude-code-sessions', DESK_UUID, ORG[o.desktop]), { recursive: true });
    const k = {};
    k['dxt:allowlistLastUpdated:' + ORG[o.desktop]] = '2026-11-16T10:00:00Z';
    fs.writeFileSync(path.join(app, 'config.json'), JSON.stringify(k));
    fs.writeFileSync(path.join(app, 'Cookies'), 'sessionKey');
  }
  return { home: home, cfg: cfg, bin: bin };
}

function addBrowser(h, dir, withCookie) {
  const d = path.join(h.home, 'Library', 'Application Support', dir, 'Default');
  fs.mkdirSync(d, { recursive: true });
  const db = path.join(d, 'Cookies');
  const sql =
    'CREATE TABLE cookies (creation_utc INTEGER, host_key TEXT, top_frame_site_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, last_access_utc INTEGER, has_expires INTEGER, is_persistent INTEGER, priority INTEGER, samesite INTEGER, source_scheme INTEGER, source_port INTEGER, last_update_utc INTEGER, source_type INTEGER, has_cross_site_ancestor INTEGER);' +
    (withCookie
      ? "INSERT INTO cookies (creation_utc,host_key,name,value,encrypted_value,path) VALUES (1,'.claude.ai','stale','old',X'00','/');"
      : '');
  assert.strictEqual(sh('sqlite3', [db, sql]).status, 0);
  return db;
}

function saveSnap(h, name, id) {
  const dir = path.join(h.cfg, 'browser-sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, name + '__' + id + '.sql'),
    "INSERT INTO cookies (creation_utc,host_key,name,value,encrypted_value,path) VALUES (2,'.claude.ai','sessionKey','" +
      SECRET +
      "',X'00','/');\n",
  );
}

function kf(h, args) {
  return spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8',
    stdin: 'ignore',
    env: Object.assign({}, process.env, {
      HOME: h.home,
      USERPROFILE: h.home,
      PATH: h.bin + ':' + process.env.PATH,
      XDG_CONFIG_HOME: path.join(h.home, '.config'),
      KEYFLIP_CONFIG_DIR: h.cfg,
      KEYFLIP_TEST_CLAUDE: 'stopped',
      KEYFLIP_APP_BUNDLE: path.join(h.home, 'no-such-Claude.app'),
    }),
    input: '',
  });
}

function noSecret(r) {
  if (process.env.KF_DEBUG) console.log('---', r.status, '\n' + r.stdout + r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes(SECRET), 'cookie value leaked');
  assert.ok(!/sessionKey=/.test(r.stdout + r.stderr), 'sessionKey= leaked');
}

const DARWIN_SKIP = process.platform !== 'darwin' && 'macOS-only: cookie DB paths and Keychain';
const chromeUp = process.platform === 'darwin' && sh('/usr/bin/pgrep', ['-x', 'Google Chrome']).status === 0;
const braveUp = process.platform === 'darwin' && sh('/usr/bin/pgrep', ['-x', 'Brave Browser']).status === 0;

test(
  'K1: sync without --yes on a RUNNING Chrome prints the plan, exits != 0, Chrome PID unchanged',
  { skip: DARWIN_SKIP || !chromeUp },
  function () {
    const h = mkHome({ cli: 'alpha' });
    addBrowser(h, path.join('Google', 'Chrome'), true);
    saveSnap(h, 'alpha', 'chrome');
    const before = sh('/usr/bin/pgrep', ['-x', 'Google Chrome']).stdout;
    const r = kf(h, ['browser', 'sync', 'alpha']);
    const after = sh('/usr/bin/pgrep', ['-x', 'Google Chrome']).stdout;
    assert.notStrictEqual(r.status, 0, 'must exit non-zero');
    assert.match(r.stdout, /Plan:.*Chrome.*QUIT and reopened/);
    assert.match(r.stdout + r.stderr, /nothing was changed/i);
    assert.strictEqual(before, after, 'Chrome PID changed');
    noSecret(r);
  },
);

test(
  'K2: --yes prints the plan first, restores, then prints a verification line',
  { skip: DARWIN_SKIP || braveUp },
  function () {
    const h = mkHome({ cli: 'alpha' });
    const db = addBrowser(h, path.join('BraveSoftware', 'Brave-Browser'), true);
    saveSnap(h, 'alpha', 'brave');
    const r = kf(h, ['browser', 'sync', 'alpha', '--yes']);
    const out = r.stdout;
    const iPlan = out.indexOf('Plan:');
    const iDone = out.search(/restored for|NOT synced/);
    const iVer = out.search(/browser session is|could not verify/);
    assert.ok(iPlan !== -1 && iDone > iPlan && iVer > iDone, 'order plan < restore < verify\n' + out);
    const rows = sh('sqlite3', [db, "SELECT name FROM cookies WHERE host_key LIKE '%claude.ai'"]).stdout;
    assert.match(rows, /sessionKey/);
    noSecret(r);
  },
);

test(
  'K7: after a restore the cookie cannot be read back: not reported as success (verified:false)',
  { skip: DARWIN_SKIP || braveUp },
  function () {
    const h = mkHome({ cli: 'alpha' });
    addBrowser(h, path.join('BraveSoftware', 'Brave-Browser'), true);
    saveSnap(h, 'alpha', 'brave');
    const r = kf(h, ['--json', 'browser', 'sync', 'alpha', '--yes']);
    assert.ok(!/browser session is alpha/.test(r.stdout), 'claimed success');
    let j = null;
    try {
      j = JSON.parse(r.stdout.trim().split('\n').pop());
    } catch {
      /* checked below */
    }
    assert.ok(j, 'json parsed: ' + r.stdout);
    assert.strictEqual(j.verified, false);
    noSecret(r);
  },
);

test('K4: CLI on alpha, desktop on beta: status names both, warns, --for picks the target', { skip: DARWIN_SKIP }, function () {
  const h = mkHome({ cli: 'alpha', desktop: 'beta' });
  addBrowser(h, path.join('BraveSoftware', 'Brave-Browser'), false);
  const r = kf(h, ['browser', 'status']);
  assert.match(r.stdout, /CLI account:.*alpha@example\.com/);
  assert.match(r.stdout, /Desktop account:.*beta@example\.com/);
  assert.match(r.stdout, /DIFFERENT/);
  const t = function (f) {
    const x = kf(h, ['--json', 'browser', 'status', '--for', f]);
    return JSON.parse(x.stdout.trim().split('\n').pop());
  };
  assert.strictEqual(t('desktop').target, 'beta');
  assert.strictEqual(t('cli').target, 'alpha');
  assert.strictEqual(t('beta').target, 'beta');
  noSecret(r);
});

test('K4b: sync with differing surfaces and no --for does not guess and exits != 0', { skip: DARWIN_SKIP }, function () {
  const h = mkHome({ cli: 'alpha', desktop: 'beta' });
  addBrowser(h, path.join('BraveSoftware', 'Brave-Browser'), true);
  saveSnap(h, 'alpha', 'brave');
  saveSnap(h, 'beta', 'brave');
  const r = kf(h, ['browser', 'sync', '--yes']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stdout, /--for/);
  assert.ok(!/restored for/.test(r.stdout));
});

test(
  'K5c: sync with an unknown positional account fails and leaves the cookie DB untouched',
  { skip: DARWIN_SKIP },
  function () {
    const h = mkHome({ cli: 'alpha' });
    const db = addBrowser(h, path.join('BraveSoftware', 'Brave-Browser'), true);
    saveSnap(h, 'alpha', 'brave');
    const r = kf(h, ['browser', 'sync', 'betta', '--yes']);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /no such saved account/);
    const rows = sh('sqlite3', [db, "SELECT name FROM cookies WHERE host_key LIKE '%claude.ai'"]).stdout.trim();
    assert.strictEqual(rows, 'stale', 'cookie DB must be untouched');
  },
);

test(
  'K5: account with no saved session: nothing restored, two steps printed, exit != 0',
  { skip: DARWIN_SKIP },
  function () {
    const h = mkHome({ cli: 'alpha' });
    const db = addBrowser(h, path.join('BraveSoftware', 'Brave-Browser'), true);
    const r = kf(h, ['browser', 'sync', '--for', 'beta', '--yes']);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stdout, /no saved browser session for/);
    assert.match(r.stdout, /1\. .*sign into claude\.ai/i);
    assert.match(r.stdout, /2\. .*keyflip browser capture --account/);
    const rows = sh('sqlite3', [db, "SELECT name FROM cookies WHERE host_key LIKE '%claude.ai'"]).stdout.trim();
    assert.strictEqual(rows, 'stale', 'cookie DB must be untouched');
  },
);

test('K5b: another account snapshot is never loaded for the target', { skip: DARWIN_SKIP }, function () {
  const h = mkHome({ cli: 'alpha' });
  const db = addBrowser(h, path.join('BraveSoftware', 'Brave-Browser'), true);
  saveSnap(h, 'alpha', 'brave'); // alpha has one, beta does not
  const r = kf(h, ['browser', 'sync', 'beta', '--yes']);
  assert.notStrictEqual(r.status, 0);
  assert.ok(!/sessionKey/.test(sh('sqlite3', [db, 'SELECT name FROM cookies']).stdout));
});

test(
  'K6: capture --account with an unreadable/other-account browser saves nothing and exits != 0',
  { skip: DARWIN_SKIP },
  function () {
    const h = mkHome({ cli: 'alpha' });
    addBrowser(h, path.join('BraveSoftware', 'Brave-Browser'), true); // no readable claude session
    const r = kf(h, ['browser', 'capture', '--account', 'beta']);
    assert.notStrictEqual(r.status, 0);
    assert.ok(!fs.existsSync(path.join(h.cfg, 'browser-sessions', 'beta__brave.sql')));
    noSecret(r);
  },
);

test(
  'K6b: list shows web check for an account with a saved session, dash for one without',
  { skip: DARWIN_SKIP },
  function () {
    const h = mkHome({ cli: 'alpha' });
    addBrowser(h, path.join('BraveSoftware', 'Brave-Browser'), false);
    saveSnap(h, 'beta', 'brave');
    const r = kf(h, ['list']);
    const line = function (n) {
      return r.stdout.split('\n').filter(function (l) {
        return l.indexOf(n + '@example.com') !== -1 || new RegExp('\\b' + n + '\\b').test(l);
      })[0];
    };
    assert.match(line('beta'), /web ✓/, r.stdout);
    assert.match(line('alpha'), /web —/, r.stdout);
  },
);

test(
  'K3: MCP keyflip_browser_sync without confirm leaves a running Chrome alone, with a plan; description says restart',
  { skip: DARWIN_SKIP || !chromeUp },
  async function () {
    const h = mkHome({ cli: 'alpha' });
    addBrowser(h, path.join('Google', 'Chrome'), true);
    saveSnap(h, 'alpha', 'chrome');
    const before = sh('/usr/bin/pgrep', ['-x', 'Google Chrome']).stdout;
    const msgs = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'keyflip_browser_sync', arguments: { name: 'alpha' } },
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'keyflip_browser_sync', arguments: { name: 'alpha', confirm: false } },
      },
    ];
    const r = spawnSync(process.execPath, [BIN, 'mcp'], {
      encoding: 'utf8',
      input:
        msgs
          .map(function (m) {
            return JSON.stringify(m);
          })
          .join('\n') + '\n',
      timeout: 20000,
      env: Object.assign({}, process.env, {
        HOME: h.home,
        USERPROFILE: h.home,
        PATH: h.bin + ':' + process.env.PATH,
        XDG_CONFIG_HOME: path.join(h.home, '.config'),
        KEYFLIP_CONFIG_DIR: h.cfg,
        KEYFLIP_TEST_CLAUDE: 'stopped',
      }),
    });
    const after = sh('/usr/bin/pgrep', ['-x', 'Google Chrome']).stdout;
    const by = {};
    r.stdout
      .split('\n')
      .filter(Boolean)
      .forEach(function (l) {
        const m = JSON.parse(l);
        if (m.id) by[m.id] = m;
      });
    const tool = by[2].result.tools.filter(function (t) {
      return t.name === 'keyflip_browser_sync';
    })[0];
    assert.match(tool.description, /restart/i);
    assert.strictEqual(before, after, 'Chrome PID changed');
    [3, 4].forEach(function (i) {
      const t = JSON.stringify(by[i]);
      assert.ok(!/"synced":\[\\?"/.test(t), 'nothing synced: ' + t);
      assert.ok(!t.includes(SECRET));
    });
    if (process.env.KF_DEBUG) console.log(JSON.stringify(by[3]).slice(0, 600));
  },
);
