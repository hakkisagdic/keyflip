// Integration tests for the CLI: spawn `node bin/keyflip.js` against a temp HOME.
// A ~/.claude/.credentials.json is created so the file backend is used on every
// OS (no Keychain, no prompts). Runs identically on macOS/Linux/Windows CI.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import _child_process from 'child_process';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');

// An Electron safeStorage blob: base64("v10" + AES-128-CBC(json)), IV = 16 spaces. The switch
// wiring test injects the password via KEYFLIP_SAFE_STORAGE_PW so no real Keychain is touched.
const SAFE_PW = 'unit-test-safe-storage';
function tokenBlob(text) {
  const key = crypto.pbkdf2Sync(SAFE_PW, 'saltysalt', 1003, 16, 'sha1');
  const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from('v10'), c.update(text), c.final()]).toString('base64');
}

function setupHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-cli-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"live":"TOKEN-1"}'); // forces FileStore
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'alice@example.com' }, userID: 'u1' }),
  );
  return home;
}

function loginAs(home, email, userID, token) {
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ live: token }));
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email }, userID: userID }),
  );
}

function run(home, args, extraEnv) {
  return _child_process.spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8',
    env: Object.assign(
      {},
      process.env,
      {
        HOME: home,
        USERPROFILE: home, // Windows homedir
        XDG_CONFIG_HOME: path.join(home, '.config'),
        // Windows otherwise resolves the state dir to %APPDATA%\keyflip, while every assertion
        // here reads under the temp home — pin it so the suite tests the same tree on every OS.
        KEYFLIP_CONFIG_DIR: path.join(home, '.config', 'keyflip'),
        APPDATA: path.join(home, 'AppData', 'Roaming'),
        KEYFLIP_TEST_CLAUDE: 'stopped', // never touch a real app; deterministic across machines
        // The app bundle path is machine-GLOBAL; point it at a nonexistent dir so an update on the
        // developer's machine can never leak an "app was UPDATED" line into these assertions.
        KEYFLIP_APP_BUNDLE: path.join(home, 'no-such-Claude.app'),
      },
      extraEnv || {},
    ),
  });
}

test('add detects & saves the logged-in account, list shows it', function () {
  const home = setupHome();
  let r = run(home, ['add']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /alice@example\.com/);
  r = run(home, ['list']);
  assert.match(r.stdout, /alice@example\.com/);
});

test('a switch re-snapshots the OUTGOING desktop account before overwriting it (#51)', function (t) {
  if (process.platform !== 'darwin') return t.skip('the desktop app store is macOS-only');
  const ORG_B = '11111111-2222-3333-4444-555555555555';
  const home = setupHome();
  run(home, ['add']); // save alice (CLI, active)
  loginAs(home, 'carol@example.com', 'u2', 'CAROL-TOKEN');
  run(home, ['add']); // save carol — a CLI switch TARGET

  // The desktop app is signed into BOB's org (an APP-ONLY profile, the way a real
  // "web-only" account is captured) with a fresh cookie that lives only in its jar.
  const appDir = path.join(home, 'Library', 'Application Support', 'Claude');
  fs.mkdirSync(appDir, { recursive: true });
  const cfg = { 'oauth:tokenCacheV2': tokenBlob(JSON.stringify({ subscriptionUUID: ORG_B })) };
  cfg['dxt:allowlistLastUpdated:' + ORG_B] = '2026-07-05T00:00:00.000Z';
  fs.writeFileSync(path.join(appDir, 'config.json'), JSON.stringify(cfg));
  fs.writeFileSync(path.join(appDir, 'Cookies'), 'sessionKey FRESH-BOB-COOKIE');
  const env = { KEYFLIP_SAFE_STORAGE_PW: SAFE_PW };
  assert.strictEqual(run(home, ['add', 'bob', '--app'], env).status, 0, 'capture bob as an app-only profile');

  // Make bob's app capture STALE — the switch must replace it with the live one.
  const appJson = path.join(home, '.config', 'keyflip', 'app', 'bob.json');
  fs.writeFileSync(appJson, JSON.stringify({ 'oauth:tokenCacheV2': 'STALE-BOB-BLOB' }));

  const sw = run(home, ['alice', '--force'], env);
  assert.strictEqual(sw.status, 0, sw.stderr);
  assert.match(sw.stdout, /kept 'bob's app login \+ session cookie fresh/, sw.stdout);

  const refreshed = JSON.parse(fs.readFileSync(appJson, 'utf8'));
  assert.notStrictEqual(refreshed['oauth:tokenCacheV2'], 'STALE-BOB-BLOB', 'the stale capture was replaced');
  assert.match(
    fs.readFileSync(path.join(home, '.config', 'keyflip', 'app', 'bob.cookies'), 'utf8'),
    /FRESH-BOB-COOKIE/,
    'and the freshly-flushed session cookie came with it',
  );
});

test('switch changes the active account (via CLI, --force)', function () {
  const home = setupHome();
  run(home, ['add']); // save alice
  loginAs(home, 'bob@example.com', 'u2', 'TOKEN-2');
  run(home, ['add']); // save bob
  const sw = run(home, ['alice', '--force']); // --force: Claude may be running on dev machines
  assert.strictEqual(sw.status, 0, sw.stderr);
  const cur = run(home, ['list']);
  assert.match(cur.stdout, /Claude Code: alice@example\.com/);
});

test('capture-app captures the desktop login for a named profile (macOS)', function (t) {
  if (process.platform !== 'darwin') return t.skip('the desktop app store is macOS-only');
  const home = setupHome();
  run(home, ['add']); // -> profile "alice"
  const appCfgDir = path.join(home, 'Library', 'Application Support', 'Claude');
  fs.mkdirSync(appCfgDir, { recursive: true });
  fs.writeFileSync(path.join(appCfgDir, 'config.json'), JSON.stringify({ 'oauth:tokenCacheV2': 'APP-TOKEN' }));
  const r = run(home, ['add', 'alice', '--app']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(home, '.config', 'keyflip', 'app', 'alice.json')), 'app token saved');
});

test('capture-app works with NO CLI login — creates an app-only account (macOS)', function (t) {
  if (process.platform !== 'darwin') return t.skip('the desktop app store is macOS-only');
  const home = setupHome();
  // CLI fully logged out:
  fs.rmSync(path.join(home, '.claude', '.credentials.json'), { force: true });
  fs.writeFileSync(path.join(home, '.claude.json'), '{}');
  const appCfgDir = path.join(home, 'Library', 'Application Support', 'Claude');
  fs.mkdirSync(appCfgDir, { recursive: true });
  fs.writeFileSync(path.join(appCfgDir, 'config.json'), JSON.stringify({ 'oauth:tokenCacheV2': 'YAHOO-APP-TOKEN' }));
  fs.writeFileSync(path.join(appCfgDir, 'Cookies'), 'sessionKey YAHOO-COOKIES');

  const r = run(home, ['add', 'yahoo', '--app']); // named (no auto-detect data in this fake env)
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(run(home, ['list']).stdout, /yahoo.*\[cli — \| app ✓\]/);

  // switching to an app-only profile must not fail on missing CLI creds
  const sw = run(home, ['yahoo', '--force']);
  assert.strictEqual(sw.status, 0, sw.stderr);
  assert.match(sw.stdout, /desktop app only|nothing to swap for the CLI/);
});

test('capture-app without a name and no detectable identity gives a helpful error', function (t) {
  if (process.platform !== 'darwin') return t.skip('the desktop app store is macOS-only');
  const home = setupHome();
  fs.writeFileSync(path.join(home, '.claude.json'), '{}');
  const appCfgDir = path.join(home, 'Library', 'Application Support', 'Claude');
  fs.mkdirSync(appCfgDir, { recursive: true });
  fs.writeFileSync(path.join(appCfgDir, 'config.json'), JSON.stringify({ 'oauth:tokenCacheV2': 'TOK' }));
  const r = run(home, ['add', '--app']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /add <name> --app/);
});

test('add --dry-run plans the app capture and writes NOTHING (#52)', function (t) {
  if (process.platform !== 'darwin') return t.skip('the desktop app store is macOS-only');
  const home = setupHome();
  const appCfgDir = path.join(home, 'Library', 'Application Support', 'Claude');
  fs.mkdirSync(appCfgDir, { recursive: true });
  fs.writeFileSync(path.join(appCfgDir, 'config.json'), JSON.stringify({ 'oauth:tokenCacheV2': 'APP-TOKEN' }));
  fs.writeFileSync(path.join(appCfgDir, 'Cookies'), 'sessionKey LIVE-COOKIES');

  const r = run(home, ['add', 'yahoo', '--app', '--dry-run']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /nothing is written/);
  assert.match(r.stdout, /'yahoo'/, 'names the account it would save');
  // Provably write-free: no profile, no app capture, and no state commit happened.
  const cfg = path.join(home, '.config', 'keyflip');
  assert.strictEqual(fs.existsSync(path.join(cfg, 'yahoo.json')), false, 'no profile written');
  assert.strictEqual(fs.existsSync(path.join(cfg, 'app', 'yahoo.json')), false, 'no app capture written');
  assert.strictEqual(fs.existsSync(path.join(cfg, 'app', 'yahoo.cookies')), false, 'no cookie snapshot written');
  assert.doesNotMatch(run(home, ['list']).stdout, /yahoo/, 'and the dry run did not create an account');

  // The real run then does capture it.
  const real = run(home, ['add', 'yahoo', '--app']);
  assert.strictEqual(real.status, 0, real.stderr);
  assert.match(run(home, ['list']).stdout, /yahoo/);
});

test('add --dry-run warns when the app jar has no session cookie yet', function (t) {
  if (process.platform !== 'darwin') return t.skip('the desktop app store is macOS-only');
  const home = setupHome();
  const appCfgDir = path.join(home, 'Library', 'Application Support', 'Claude');
  fs.mkdirSync(appCfgDir, { recursive: true });
  fs.writeFileSync(path.join(appCfgDir, 'config.json'), JSON.stringify({ 'oauth:tokenCacheV2': 'APP-TOKEN' }));
  fs.writeFileSync(path.join(appCfgDir, 'Cookies'), 'lastActiveOrg NO-SESSION-HERE');
  const r = run(home, ['add', 'yahoo', '--app', '--dry-run']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /no claude\.ai session cookie/);
  assert.match(r.stdout, /INCOMPLETE/);
  assert.strictEqual(fs.existsSync(path.join(home, '.config', 'keyflip', 'yahoo.json')), false);
});

test('reset --force (factory) deletes all saved keyflip data', function () {
  const home = setupHome();
  run(home, ['add']); // -> profile alice
  assert.match(run(home, ['list']).stdout, /alice@example\.com/);
  const r = run(home, ['reset', '--force']);
  assert.strictEqual(r.status, 0, r.stderr);
  const list = run(home, ['list']).stdout;
  assert.match(list, /none yet/); // saved profiles gone
  assert.doesNotMatch(list, /\[1\]/); // no numbered entries
  assert.match(list, /Claude Code: alice@example\.com/); // live login untouched
});

test('reset --logout --force signs out of Claude Code (and the desktop app on macOS)', function () {
  const home = setupHome(); // ~/.claude.json (alice) + ~/.claude/.credentials.json (live)
  run(home, ['add']);
  const appCfgDir = path.join(home, 'Library', 'Application Support', 'Claude');
  fs.mkdirSync(appCfgDir, { recursive: true });
  const cfgFile = path.join(appCfgDir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ 'oauth:tokenCacheV2': 'TOK', keep: 1 }));

  const r = run(home, ['reset', '--logout', '--force']);
  assert.strictEqual(r.status, 0, r.stderr);
  // Claude Code signed out: live creds file removed, account cleared from ~/.claude.json
  assert.strictEqual(fs.existsSync(path.join(home, '.claude', '.credentials.json')), false);
  const cj = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.ok(!cj.oauthAccount && !cj.userID, 'account cleared');
  // Desktop app signed out (macOS only — appDataDir is null elsewhere)
  if (process.platform === 'darwin') {
    const appcfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.strictEqual('oauth:tokenCacheV2' in appcfg, false);
    assert.strictEqual(appcfg.keep, 1); // unrelated keys preserved
  }
});

test('plain reset --force does NOT sign out (live creds kept)', function () {
  const home = setupHome();
  run(home, ['add']);
  run(home, ['reset', '--force']);
  assert.ok(fs.existsSync(path.join(home, '.claude', '.credentials.json')), 'live creds untouched');
});

test('reset without --force in a non-interactive shell refuses', function () {
  const home = setupHome();
  run(home, ['add']);
  const r = run(home, ['reset']); // no TTY, no --force
  assert.notStrictEqual(r.status, 0);
  assert.match(run(home, ['list']).stdout, /\[1\] alice@example\.com/); // still saved
});

test('an unknown command exits non-zero', function () {
  const home = setupHome();
  const r = run(home, ['definitely-not-a-command']);
  assert.strictEqual(r.status, 1);
});

test('keyflip <name> switches directly (no "switch" keyword)', function () {
  const home = setupHome();
  run(home, ['add']);
  loginAs(home, 'bob@example.com', 'u2', 'TOKEN-2');
  run(home, ['add']);
  const r = run(home, ['alice', '--force']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(run(home, ['list']).stdout, /Claude Code: alice@example\.com/);
});

// The desktop app has its OWN login, so signing into another account by hand inside
// the app leaves the CLI on the old account. `keyflip <that-account>` must not call
// that "already active" — it still has a real switch to do (the app login).
test('switch to an already-active CLI account still flips a lagging desktop app (macOS)', function (t) {
  if (process.platform !== 'darwin') return t.skip('the desktop app store is macOS-only');
  const home = setupHome();
  run(home, ['add']); // profile "alice"; the CLI stays on alice throughout
  const appCfgDir = path.join(home, 'Library', 'Application Support', 'Claude');
  fs.mkdirSync(appCfgDir, { recursive: true });
  const YAHOO_ORG = '11111111-2222-3333-4444-555555555555';
  const ALICE_ORG = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  function appSignedInAs(token, org) {
    const cfg = { 'oauth:tokenCacheV2': token };
    cfg['dxt:allowlistLastUpdated:' + org] = '2026-07-05T00:00:00.000Z';
    fs.writeFileSync(path.join(appCfgDir, 'config.json'), JSON.stringify(cfg));
    fs.writeFileSync(path.join(appCfgDir, 'Cookies'), 'sessionKey ' + token);
  }
  appSignedInAs('ALICE-APP', ALICE_ORG);
  assert.strictEqual(run(home, ['add', 'alice', '--app']).status, 0); // alice's app login saved
  appSignedInAs('YAHOO-APP', YAHOO_ORG);
  assert.strictEqual(run(home, ['add', 'yahoo', '--app']).status, 0); // ...then a manual app sign-in

  assert.match(run(home, ['list']).stdout, /desktop app: yahoo/);
  const sw = run(home, ['alice', '--restart']);
  assert.strictEqual(sw.status, 0, sw.stderr);
  assert.match(sw.stdout, /the desktop app is on yahoo/);
  assert.match(sw.stdout, /switched the Claude desktop-app login/);
  assert.match(fs.readFileSync(path.join(appCfgDir, 'config.json'), 'utf8'), /ALICE-APP/);
});

// The gap this closes: `app ✓` describes a restorable CAPTURE. The app can still be
// signed out — it re-mints its token cache from a claude.ai session cookie, so with the
// cookie gone from its jar it opens on the sign-in screen while every keyflip report
// looked healthy. list/doctor must show the live state too.
test('list and doctor tell when the desktop app is signed out on disk (macOS)', function (t) {
  if (process.platform !== 'darwin') return t.skip('the desktop app store is macOS-only');
  const home = setupHome();
  run(home, ['add']);
  const appCfgDir = path.join(home, 'Library', 'Application Support', 'Claude');
  fs.mkdirSync(appCfgDir, { recursive: true });
  fs.writeFileSync(path.join(appCfgDir, 'config.json'), JSON.stringify({ 'oauth:tokenCacheV2': 'ALICE-APP' }));
  fs.writeFileSync(path.join(appCfgDir, 'Cookies'), 'sessionKey ALICE-APP');
  assert.strictEqual(run(home, ['add', 'alice', '--app']).status, 0);

  const jar = path.join(appCfgDir, 'Cookies');
  assert.doesNotMatch(run(home, ['list']).stdout, /signed out on disk/, 'while the cookie is there');
  fs.writeFileSync(jar, 'lastActiveOrg ALICE'); // the app cleared its session cookie
  const list = run(home, ['list']);
  assert.strictEqual(list.status, 0, 'being signed out of the app is not an error');
  assert.match(list.stdout, /desktop app: [^\n]*signed out on disk/);
  assert.match(list.stdout, /app ✓/, 'the saved capture is still there — that is not what broke');
  const j = JSON.parse(run(home, ['list', '--json']).stdout);
  assert.strictEqual(j.appSessionLive, false);
  const doc = run(home, ['doctor']);
  assert.match(doc.stdout, /desktop app session.*sign-in screen/s);
  assert.match(doc.stdout, /sign in once/);
});

// The gap this closes: the cookie jar can hold a valid sessionKey (the swap landed) but the
// server calls it too old for the app's scope expansion — the "Sign in again" banner. list/status
// must treat that as signed-out and name the fix, not claim the app is healthy.
test('list and status call out a latched session_stale_relogin (macOS)', function (t) {
  if (process.platform !== 'darwin') return t.skip('the desktop app store is macOS-only');
  const home = setupHome();
  run(home, ['add']); // profile "alice"
  const appCfgDir = path.join(home, 'Library', 'Application Support', 'Claude');
  fs.mkdirSync(appCfgDir, { recursive: true });
  const ALICE_ORG = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const cfg = { 'oauth:tokenCacheV2': 'ALICE-APP' };
  cfg['dxt:allowlistLastUpdated:' + ALICE_ORG] = '2026-07-05T00:00:00.000Z';
  fs.writeFileSync(path.join(appCfgDir, 'config.json'), JSON.stringify(cfg));
  fs.writeFileSync(path.join(appCfgDir, 'Cookies'), 'sessionKey ALICE-APP');
  assert.strictEqual(run(home, ['add', 'alice', '--app']).status, 0);

  // Fake the log so staleRelogin sees the refusal.
  const logDir = path.join(home, 'Library', 'Logs', 'Claude');
  fs.mkdirSync(logDir, { recursive: true });
  const logLines = [
    '2026-10-20 15:23:40 INFO  authorize failed for orgId=' + ALICE_ORG + ' code=session_stale_relogin',
    '2026-10-20 15:23:40 WARN  session_stale_relogin latched',
  ];
  fs.writeFileSync(path.join(logDir, 'main.log'), logLines.join('\n') + '\n');

  const list = run(home, ['list']);
  assert.strictEqual(list.status, 0, 'a stale latch is not an error exit');
  assert.match(list.stdout, /claude\.ai refused the saved sign-in/, 'human output names the refusal');
  assert.match(list.stdout, /Fix: sign in once in Claude/, 'human output gives the fix');
  const j = JSON.parse(run(home, ['list', '--json']).stdout);
  assert.strictEqual(j.appSessionLive, false, 'JSON says the app session is NOT live');
  assert.ok(j.appStaleRelogin && j.appStaleRelogin.at, 'JSON carries the stale verdict');
  assert.strictEqual(j.appStaleRelogin.org, ALICE_ORG);

  const st = run(home, ['status']);
  assert.strictEqual(st.status, 0);
  assert.match(st.stdout, /claude\.ai refused the saved sign-in/, 'status also names the refusal');
  const sj = JSON.parse(run(home, ['status', '--json']).stdout);
  assert.ok(sj.appStaleRelogin && sj.appStaleRelogin.at, 'status JSON carries the stale verdict');
});

test('chat --as rejects an unknown account before touching any cookie', function (t) {
  if (process.platform !== 'darwin') return t.skip('claude.ai Chat reading is macOS-only');
  const home = setupHome();
  run(home, ['add']);
  const r = run(home, ['chat', 'get', 'deadbeef', '--as', 'nosuchaccount']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /no such saved account/);
});

test('unified add captures the desktop login too when only the app is signed in (macOS)', function (t) {
  if (process.platform !== 'darwin') return t.skip('the desktop app store is macOS-only');
  const home = setupHome();
  fs.rmSync(path.join(home, '.claude', '.credentials.json'), { force: true }); // CLI logged out
  fs.writeFileSync(path.join(home, '.claude.json'), '{}');
  const appCfgDir = path.join(home, 'Library', 'Application Support', 'Claude');
  fs.mkdirSync(appCfgDir, { recursive: true });
  fs.writeFileSync(path.join(appCfgDir, 'config.json'), JSON.stringify({ 'oauth:tokenCacheV2': 'APP-TOK' }));
  const r = run(home, ['add', 'yahoo']); // name flows to the app capture since the CLI is out
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Desktop app login: captured as 'yahoo'/);
  assert.match(run(home, ['list']).stdout, /yahoo.*app ✓/);
});

test('version prints and exits 0', function () {
  const home = setupHome();
  const r = run(home, ['version']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /keyflip \d+\.\d+\.\d+/);
});

test('switch refuses to auto-close a running Claude without confirmation (non-interactive)', function () {
  const home = setupHome();
  run(home, ['add']); // save alice (current)
  loginAs(home, 'bob@example.com', 'u2', 'TOKEN-2');
  run(home, ['add']); // save bob (current = bob)
  const r = run(home, ['alice'], { KEYFLIP_TEST_CLAUDE: 'running' });
  assert.notStrictEqual(r.status, 0); // must not silently close/switch
  const cur = run(home, ['list'], { KEYFLIP_TEST_CLAUDE: 'running' });
  assert.match(cur.stdout, /bob@example\.com/); // still on bob — nothing changed
});

test('switch --restart proceeds while Claude is running (closes/reopens, or swaps where it cannot)', function () {
  const home = setupHome();
  run(home, ['add']);
  loginAs(home, 'bob@example.com', 'u2', 'TOKEN-2');
  run(home, ['add']);
  const r = run(home, ['alice', '--restart'], { KEYFLIP_TEST_CLAUDE: 'running' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(run(home, ['list']).stdout, /Claude Code: alice@example\.com/);
});

test('switch --force swaps in place without closing a running Claude', function () {
  const home = setupHome();
  run(home, ['add']);
  loginAs(home, 'bob@example.com', 'u2', 'TOKEN-2');
  run(home, ['add']);
  const r = run(home, ['alice', '--force'], { KEYFLIP_TEST_CLAUDE: 'running' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(run(home, ['list']).stdout, /Claude Code: alice@example\.com/);
});

test('statusline emits the active account; install wires it into settings.json (G3)', function () {
  const home = setupHome();
  const emit = run(home, ['statusline']);
  assert.strictEqual(emit.status, 0, emit.stderr);
  assert.match(emit.stdout, /alice@example\.com/);
  assert.doesNotMatch(emit.stdout, /\n/, 'the status line is a single line (no trailing newline)');
  run(home, ['statusline', 'install']);
  const s = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.ok(s.statusLine && /statusline/.test(s.statusLine.command), 'settings.statusLine wired');
  run(home, ['statusline', 'uninstall']);
  const s2 = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.strictEqual('statusLine' in s2, false, 'uninstall removes it');
});

test('menu survives EOF during a sub-prompt (no crash)', function () {
  const home = setupHome();
  const r = _child_process.spawnSync(process.execPath, [BIN, 'menu'], {
    encoding: 'utf8',
    input: 'a\n', // enter "save current", then stdin closes mid sub-prompt
    env: Object.assign({}, process.env, {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      APPDATA: path.join(home, 'AppData', 'Roaming'),
    }),
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch((r.stdout || '') + (r.stderr || ''), /Cannot read properties of null/);
});

// ---- #5: harden desktop-app account detection (macOS-only paths) ----

// Write a fake Claude desktop app data dir under HOME so the CLI's macOS appDataDir
// (~/Library/Application Support/Claude) is populated deterministically.
function seedApp(home, cfg, tree, signedOut) {
  const ad = path.join(home, 'Library', 'Application Support', 'Claude');
  fs.mkdirSync(ad, { recursive: true });
  fs.writeFileSync(path.join(ad, 'config.json'), JSON.stringify(cfg));
  // A live session cookie means the app is signed in — detection's config-only fallback
  // trusts the allowlist org only when this is present (a signed-OUT app must not show
  // a stale account). Omit it (signedOut=true) to represent a signed-out app.
  if (!signedOut) fs.writeFileSync(path.join(ad, 'Cookies'), 'sessionKey LIVE');
  (tree || []).forEach(function (t) {
    fs.mkdirSync(path.join(ad, t.dir), { recursive: true });
    if (t.file) fs.writeFileSync(path.join(ad, t.dir, t.file), t.content || '');
  });
  return ad;
}

test('status recovers the desktop account from config when the token cannot be decrypted', function (t) {
  if (process.platform !== 'darwin') return t.skip('the desktop app store is macOS-only');
  const home = setupHome();
  const ORG = '11111111-2222-3333-4444-555555555555',
    ACCT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const cfg = { 'oauth:tokenCacheV2': 'not-a-v10-blob' };
  cfg['dxt:allowlistLastUpdated:' + ORG] = '2026-07-05T00:00:00.000Z';
  seedApp(home, cfg, [
    { dir: path.join('claude-code-sessions', ACCT, ORG) },
    {
      dir: path.join('local-agent-mode-sessions', ACCT, ORG),
      file: 's.json',
      content: JSON.stringify({ oauthAccount: { emailAddress: 'desktopuser@x.com' } }),
    },
  ]);
  const r = run(home, ['status', '--json']);
  const app = JSON.parse(r.stdout).app;
  assert.ok(app, 'app block present');
  assert.strictEqual(app.email, 'desktopuser@x.com'); // recovered despite no decryptable token
  assert.strictEqual(app.saved, false); // marked as an unsaved account
  // Human output shows the email, not "unknown".
  assert.match(run(home, ['status']).stdout, /desktopuser@x\.com/);
});

test('add --app gives a clear, actionable hint when the account cannot be identified', function (t) {
  if (process.platform !== 'darwin') return t.skip('the desktop app store is macOS-only');
  const home = setupHome();
  seedApp(home, { 'oauth:tokenCacheV2': 'not-a-v10-blob' }); // no allowlist -> unidentifiable
  const r = run(home, ['add', '--app']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /Open the Claude desktop app and confirm it is signed in/);
});

// Post-audit safety: destructive `remove` must not silently delete non-interactively (no undo).
test('remove is confirm-gated: refuses non-interactively without --force, but --force deletes', function () {
  const home = setupHome();
  run(home, ['add']); // saves "alice"
  const refused = run(home, ['remove', 'alice']);
  assert.match(
    (refused.stderr || '') + (refused.stdout || ''),
    /refusing to delete|--force/i,
    'refuses without a flag',
  );
  assert.doesNotMatch(run(home, ['list']).stdout, /none yet/i, 'account still saved after a refused delete');
  const forced = run(home, ['remove', 'alice', '--force']);
  assert.strictEqual(forced.status, 0);
  assert.match(run(home, ['list']).stdout, /none yet/i, 'saved account gone after --force');
});

// Reverse-parity fix: a `logout` verb exists (previously MCP-only) and keeps saved accounts.
test('logout verb exists, is confirm-gated, and KEEPS saved accounts', function () {
  const home = setupHome();
  run(home, ['add']); // "alice"
  const refused = run(home, ['logout']);
  assert.match(
    (refused.stderr || '') + (refused.stdout || ''),
    /refusing to log out|-y/i,
    'refuses non-interactively without -y',
  );
  const done = run(home, ['logout', '-y']);
  assert.strictEqual(done.status, 0, 'logout -y succeeds');
  assert.match(run(home, ['list']).stdout, /alice/, 'saved account is kept after logout');
});

// #35 threads, driven through the REAL binary. The unit tests prove the module and the MCP tests prove
// the agent surface; only this layer catches a CLI wiring bug — and it did: `threads add <prefix>` threw
// "Assignment to constant variable" because threadsAdd reassigned a const, which neither layer could
// see. The flow below is the one the README documents, in the order a user types it.
test('threads CLI: suggest → create → add by prefix → merged --md → opt-in mirror → drop, end to end', function () {
  // realpath for the same reason test/setup.js does it: on macOS os.tmpdir() is a symlinked path, and
  // the transcript's encoded project folder is derived from the cwd STRING the CLI resolves.
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'keyflip-cli-threads-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"live":"TOKEN-1"}');
  const cfg = path.join(home, '.config', 'keyflip');
  const ID_A = '1a2b3c4d-1111-4111-8111-111111111111';
  const ID_B = '9f8e7d6c-2222-4222-8222-222222222222';
  const proj = path.join(home, 'work', 'billing');
  const pdir = path.join(home, '.claude', 'projects', proj.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(pdir, { recursive: true });
  const write = function (id, turns) {
    fs.writeFileSync(
      path.join(pdir, id + '.jsonl'),
      turns
        .map(function (t, i) {
          return JSON.stringify({
            type: t.role,
            sessionId: id,
            cwd: i === 0 ? proj : undefined,
            timestamp: t.ts,
            message: { role: t.role, content: [{ type: 'text', text: t.text }] },
          });
        })
        .join('\n') + '\n',
      { mode: 0o600 },
    );
  };
  // The first prompt holds a pasted key — that is exactly where one lands in real life.
  write(ID_A, [{ role: 'user', text: 'fatura akışını kur sk-ant-PASTEDKEY', ts: '2026-10-14T09:00:00.000Z' }]);
  write(ID_B, [{ role: 'user', text: 'kota bitti, yahoo ile devam', ts: '2026-10-14T13:00:00.000Z' }]);
  const tokenFile = function (name) {
    const p = path.join(home, name + '.json');
    fs.writeFileSync(
      p,
      JSON.stringify({ claudeAiOauth: { accessToken: 'AT-' + name, refreshToken: 'RT', expiresAt: 1 } }),
    );
    return p;
  };
  for (const a of ['gmail', 'yahoo'])
    assert.strictEqual(run(home, ['add', a, '--token', tokenFile(a), '--force']).status, 0, 'saved ' + a);
  assert.strictEqual(run(home, ['sessions', 'assign', ID_A, 'gmail']).status, 0);
  assert.strictEqual(run(home, ['sessions', 'assign', ID_B, 'yahoo']).status, 0);

  const suggested = run(home, ['threads', 'suggest']);
  assert.strictEqual(suggested.status, 0, suggested.stderr);
  assert.match(suggested.stdout, /work.billing|billing/, 'the split folder is named');
  assert.match(suggested.stdout, /2 session\(s\)/, 'and sizes it');
  assert.ok(
    suggested.stdout.indexOf(ID_A.slice(0, 8)) !== -1 || suggested.stdout.indexOf(ID_B.slice(0, 8)) !== -1,
    'it prints SHORT ids — which is exactly why `add` has to expand them',
  );

  const created = run(home, ['threads', 'create', 'fatura', '--title', 'Düğüm açmak', '--session', ID_A.slice(0, 8)]);
  assert.strictEqual(created.status, 0, created.stderr);
  const added = run(home, ['threads', 'add', 'fatura', ID_B.slice(0, 8), '--account', 'yahoo']);
  assert.strictEqual(added.status, 0, added.stderr + added.stdout);
  assert.match(added.stdout, /expands to the full id/, 'it says so out loud');
  const pf = path.join(cfg, 'threads', 'fatura.json');
  const pointer = fs.readFileSync(pf, 'utf8');
  assert.ok(pointer.indexOf(ID_A) !== -1 && pointer.indexOf(ID_B) !== -1, 'both pointers are stored as FULL ids');
  assert.strictEqual(pointer.indexOf('sk-ant-PASTEDKEY'), -1, 'a thread is a POINTER file; prose never rides into it');
  assert.strictEqual(pointer.indexOf('fatura akışını'), -1, 'not even the preview label — expand() reads that live');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(pf).mode & 0o777, 0o600);

  // `--json` is the surface that gets pasted into an agent transcript, so keyflip's own paths come back
  // relative there — the state dir for pointers, ~/.claude/projects for transcripts — exactly as the MCP
  // tools and `keyflip chains` do. What stays absolute is a resume command's cwd, which needs it.
  const listJson = JSON.parse(run(home, ['threads', 'list', '--json']).stdout);
  assert.strictEqual(listJson.threads[0].file, 'threads/fatura.json', 'relative to the state dir (POSIX)');
  const showJson = JSON.parse(run(home, ['threads', 'show', 'fatura', '--json']).stdout);
  assert.strictEqual(showJson.thread.file, 'threads/fatura.json');
  assert.notStrictEqual(showJson.members[0].file.charAt(0), '/', 'a transcript path is relative too…');
  assert.match(showJson.members[0].file, new RegExp(ID_A + '\\.jsonl$'), '…and still names the session it points at');
  assert.strictEqual(JSON.stringify(showJson).indexOf(cfg), -1, 'never the state dir, which is a home path');

  const md = run(home, ['threads', 'show', 'fatura', '--md']);
  assert.strictEqual(md.status, 0, md.stderr);
  assert.ok(md.stdout.startsWith('# Thread `fatura`'), '--md prints ONLY the document, so it pipes');
  assert.match(md.stdout, /↪ from gmail/, 'the account switch is visible inside the merged conversation');
  assert.match(md.stdout, /↪ from yahoo/);
  assert.match(
    md.stdout,
    /sk-ant-PASTEDKEY|fatura akışını/,
    'the document is the transcript, key and all — which is why it is opt-in',
  );

  const refused = run(home, ['threads', 'mirror', 'fatura']);
  assert.match(refused.stdout + refused.stderr, /threads\.mirror is off/, 'the mirror needs the config flag too');
  assert.strictEqual(
    fs.existsSync(path.join(cfg, 'thread-mirror', 'fatura.md')),
    false,
    'refused means nothing written',
  );
  assert.strictEqual(run(home, ['config', 'set', 'threads.mirror', 'true']).status, 0);
  assert.strictEqual(run(home, ['threads', 'mirror', 'fatura']).status, 0);
  const mf = path.join(cfg, 'thread-mirror', 'fatura.md');
  assert.ok(fs.existsSync(mf), 'the merged text is on disk once both gates say yes');
  assert.ok(fs.readFileSync(mf, 'utf8').indexOf('sk-ant-PASTEDKEY') !== -1);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(mf).mode & 0o777, 0o600);

  const noConfirm = run(home, ['threads', 'drop', 'fatura']);
  assert.notStrictEqual(noConfirm.status, 0, 'forgetting a name needs confirmation');
  const dropped = run(home, ['threads', 'drop', 'fatura', '-y']);
  assert.strictEqual(dropped.status, 0, dropped.stderr + dropped.stdout);
  assert.strictEqual(fs.existsSync(pf), false, 'the NAME is gone');
  assert.ok(fs.existsSync(path.join(pdir, ID_A + '.jsonl')), 'the transcripts were never touched');
  assert.ok(fs.existsSync(path.join(pdir, ID_B + '.jsonl')));
  assert.match(
    run(home, ['threads', 'suggest']).stdout,
    /2 session\(s\)/,
    'the split is findable again — the assignments survived',
  );
});

// #44 — the findings-management command. Two halves, both worth proving at the CLI: the refusals that
// keep a policy from becoming silent suppression, and the one property the user actually asked for
// ("alarm verme, ama geçmişten temizle").
test('secrets CLI: a rule is refused when it would leave a hole, and a note is redacted before it is stored', function () {
  const home = setupHome();
  const cfg = path.join(home, '.config', 'keyflip');
  const GOOGLE = 'AIza' + 'Simulated-Not-A-Real-Google-Key-00000';

  // No versioned state yet => an honest "there is no history to judge", not a crash and not a false clean.
  const none = run(home, ['secrets']);
  assert.strictEqual(none.status, 0, none.stderr);
  assert.match(none.stdout, /not a git repo/);

  const typo = run(home, ['secrets', 'tolerate', 'providers/gmail.json', '--kind', 'google-api-ky']);
  assert.notStrictEqual(typo.status, 0, 'a KIND keyflip does not scan for would match nothing, forever');
  assert.match(typo.stderr, /unknown secret kind/);

  const blanket = run(home, ['secrets', 'tolerate', '*']);
  assert.notStrictEqual(blanket.status, 0);
  assert.match(blanket.stderr, /switched off/, '"*" with no kind is the scan turned off, not a policy');

  const out = run(home, [
    'secrets',
    'tolerate',
    'providers/gmail.json',
    '--kind',
    'google-api-key',
    '--note',
    'free tier, the key is ' + GOOGLE,
    '--json',
  ]);
  assert.strictEqual(out.status, 0, out.stderr + out.stdout);
  const j = JSON.parse(out.stdout);
  assert.strictEqual(j.secrets.action, 'tolerate');
  assert.strictEqual(j.secrets.rule.path, 'providers/gmail.json');
  assert.deepStrictEqual(j.secrets.rule.kinds, ['google-api-key']);
  assert.ok(j.secrets.rule.note.indexOf('keyflip_redacted') !== -1, 'the note came back redacted');

  const raw = fs.readFileSync(path.join(cfg, 'secrets-policy.json'), 'utf8');
  assert.strictEqual(raw.indexOf(GOOGLE), -1, 'never the value — this file is git-versioned');
  assert.strictEqual(JSON.stringify(j).indexOf(GOOGLE), -1, 'and not in the payload an agent pastes either');
  if (process.platform !== 'win32')
    assert.strictEqual(fs.statSync(path.join(cfg, 'secrets-policy.json')).mode & 0o777, 0o600);

  const listed = run(home, ['secrets', 'list', '--json']);
  assert.strictEqual(listed.status, 0, listed.stderr);
  const lj = JSON.parse(listed.stdout);
  assert.strictEqual(lj.secrets.policy.rules.length, 1);
  // Whether the state dir is a repo yet depends on autoCommit having run, so the assertion is about the
  // SHAPE: a history is either judged or honestly absent, never silently "clean".
  assert.ok(Array.isArray(lj.secrets.history ? lj.secrets.history.leaks : []), 'a leak array, or no history at all');
  assert.strictEqual(lj.secrets.tolerated, lj.secrets.history ? lj.secrets.history.tolerated : null);

  const back = run(home, ['secrets', 'untolerate', 'providers/gmail.json']);
  assert.strictEqual(back.status, 0, back.stderr);
  assert.match(back.stdout, /alarms again/);
  assert.strictEqual(
    JSON.parse(run(home, ['secrets', 'list', '--json']).stdout).secrets.policy.rules.length,
    0,
    'and the file really says so',
  );
});

test('secrets + doctor + scrub-history: a tolerated finding stops being an alarm and is STILL scrubbed', function (t) {
  let hasGit = true;
  try {
    _child_process.execFileSync('git', ['--version']);
  } catch (e) {
    hasGit = false;
  }
  if (!hasGit) return t.skip('git not installed');
  const home = setupHome();
  const cfg = path.join(home, '.config', 'keyflip');
  fs.mkdirSync(cfg, { recursive: true });
  const g = function (args) {
    return _child_process.execFileSync('git', ['-C', cfg].concat(args), { encoding: 'utf8' });
  };
  const id = ['-c', 'user.email=t@keyflip.test', '-c', 'user.name=t'];
  const GOOGLE = 'AIza' + 'Simulated-Not-A-Real-Google-Key-00000';
  g(['init', '-q']);
  fs.writeFileSync(path.join(cfg, 'providers-gmail.json'), '{"apiKey":"' + GOOGLE + '"}\n');
  g(id.concat(['add', '-A', '-f']));
  g(id.concat(['commit', '-q', '-m', 'a free-tier key, parked where it belongs']));
  // The "fix" everyone believes is enough: untrack it. The blob is still reachable.
  fs.rmSync(path.join(cfg, 'providers-gmail.json'));
  g(['rm', '--cached', '-q', '-f', 'providers-gmail.json']);
  g(id.concat(['commit', '-q', '-m', 'untrack it']));

  const before = run(home, ['secrets']);
  assert.strictEqual(before.status, 0, before.stderr);
  assert.match(before.stdout, /1 alarm\(s\)/, 'before: it is an alarm');
  assert.match(before.stdout, /providers-gmail\.json/);
  assert.match(before.stdout, /google-api-key/, 'named by KIND, never by value');
  assert.strictEqual(before.stdout.indexOf(GOOGLE), -1);

  const tol = run(home, [
    'secrets',
    'tolerate',
    'providers-gmail.json',
    '--kind',
    'google-api-key',
    '--note',
    'free tier',
  ]);
  assert.strictEqual(tol.status, 0, tol.stderr);
  assert.match(tol.stdout, /silencing 1 finding/);
  assert.match(tol.stdout, /0 still an alarm/);
  assert.match(tol.stdout, /scrub-history still removes/, 'and the command says out loud that it is not an exemption');

  const after = run(home, ['secrets', 'list']);
  assert.match(after.stdout, /✓ 0 alarm\(s\)/, 'after: nothing alarms');
  assert.match(after.stdout, /1 tolerated/);
  assert.match(after.stdout, /tolerated by rule/, 'with the reason on the line itself');

  // doctor's headline is the one the user reads every day.
  const doc = run(home, ['doctor', '--history']);
  assert.strictEqual(doc.status, 0, doc.stderr);
  assert.match(doc.stdout, /✓ history scan {2}— 0 alarm\(s\) \(1 tolerated by policy\)/);
  assert.strictEqual(doc.stdout.indexOf(GOOGLE), -1, 'a diagnostic is not allowed to print the secret');

  // THE POINT: the plan still contains the path.
  const plan = run(home, ['scrub-history']);
  assert.strictEqual(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /providers-gmail\.json/, 'a tolerated path is still on the chopping block');
  assert.match(plan.stdout, /TOLERATED by the secrets policy/);
  assert.strictEqual(plan.stdout.indexOf('rotated'), -1, 'and no rotation advice for a key the user decided about');
  const planJson = JSON.parse(run(home, ['scrub-history', '--json']).stdout);
  assert.ok(planJson.scrubHistory.plan.paths.indexOf('providers-gmail.json') !== -1);
  assert.deepStrictEqual(planJson.scrubHistory.plan.toleratedPaths, ['providers-gmail.json']);
  assert.strictEqual(planJson.scrubHistory.tolerated, 1);
  assert.strictEqual(planJson.scrubHistory.alarms, 0);

  // Undoing the decision brings the alarm back — nothing about toleration is sticky or invisible.
  run(home, ['secrets', 'untolerate', 'providers-gmail.json']);
  assert.match(run(home, ['doctor', '--history']).stdout, /✗ history scan {2}— 1 alarm/);
});

test('cooldown lists parked accounts and clears them', function () {
  const home = setupHome();
  assert.strictEqual(run(home, ['add']).status, 0);
  const cfg = path.join(home, '.config', 'keyflip');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'breakers.json'), // what a 429 in the proxy leaves behind
    JSON.stringify({
      alice: {
        state: 'closed',
        failures: 0,
        successes: 0,
        openedAt: 0,
        cooldownUntil: Date.now() + 60000,
        cooldownKind: 'throttled',
        lastUsedAt: Date.now(),
      },
    }),
  );
  const listed = run(home, ['cooldown', '--json']);
  assert.strictEqual(listed.status, 0, listed.stderr);
  const o = JSON.parse(listed.stdout);
  const alice = o.accounts.filter(function (a) {
    return a.name === 'alice';
  })[0];
  assert.ok(alice.coolingSeconds > 0, 'the cooldown is visible');
  assert.strictEqual(alice.cooldownKind, 'throttled');
  assert.deepStrictEqual(o.order, ['alice'], 'the sole account is offered after its cooldown');
  assert.ok(o.waitSeconds > 0, 'with the wait made explicit');

  const cleared = run(home, ['cooldown', 'clear', '--all', '--json']);
  assert.deepStrictEqual(JSON.parse(cleared.stdout).cleared, ['alice']);
  const after = JSON.parse(run(home, ['cooldown', '--json']).stdout);
  assert.strictEqual(after.accounts[0].coolingSeconds, 0);
  assert.strictEqual(after.waitSeconds, 0, 'no wait once cleared');
  assert.deepStrictEqual(after.order, ['alice'], 'cleared account is tried again');
});

test('proxy routes init writes a valid file; routes and explain read it back', function () {
  const home = setupHome();
  assert.strictEqual(run(home, ['add']).status, 0);
  let r = run(home, ['proxy', 'routes', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  let j = JSON.parse(r.stdout);
  assert.strictEqual(j.exists, false, 'no file yet — the defaults apply');
  assert.strictEqual(j.fallback, 'retry');

  r = run(home, ['proxy', 'routes', 'init']);
  assert.strictEqual(r.status, 0, r.stderr);
  const file = path.join(home, '.config', 'keyflip', 'proxy-routes.json');
  assert.ok(fs.existsSync(file));
  r = run(home, ['proxy', 'routes', '--json']);
  j = JSON.parse(r.stdout);
  assert.strictEqual(j.exists, true);
  assert.deepStrictEqual(j.errors, [], 'the template it writes is valid');
  assert.deepStrictEqual(j.rules, [], 'and ships no half-configured rule');

  // It never clobbers routing a user already wrote; --force is explicit.
  fs.writeFileSync(file, JSON.stringify({ fallback: 'off' }));
  r = run(home, ['proxy', 'routes', 'init']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /already exists/);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).fallback, 'off');

  // routes.json is config, not an account.
  assert.match(run(home, ['list']).stdout, /alice@example\.com/);
  assert.doesNotMatch(run(home, ['list']).stdout, /proxy-routes/);

  r = run(home, ['proxy', 'explain', '--json', '--model', 'claude-sonnet-4-5', '--tokens', '2000']);
  assert.strictEqual(r.status, 0, r.stderr);
  const e = JSON.parse(r.stdout);
  assert.strictEqual(e.input.model, 'claude-sonnet-4-5');
  assert.strictEqual(e.input.tokens, 2000);
  assert.strictEqual(e.decision.reason, 'default order');
  assert.deepStrictEqual(e.order, ['alice']);
  assert.strictEqual(e.routes.fallback, 'off');
});

test('tier shows/pins a plan, explain honors it, and auto clears it', function () {
  const home = setupHome();
  assert.strictEqual(run(home, ['add']).status, 0);

  // The captured blob in this harness carries no subscriptionType -> unknown.
  let j = JSON.parse(run(home, ['tier', '--json']).stdout);
  assert.strictEqual(j.accounts.length, 1);
  assert.strictEqual(j.accounts[0].tier, null);
  assert.strictEqual(j.accounts[0].known, false);
  assert.strictEqual(j.filter, true);

  assert.strictEqual(run(home, ['tier', 'alice', 'free']).status, 0);
  j = JSON.parse(run(home, ['tier', '--json']).stdout);
  assert.strictEqual(j.accounts[0].tier, 'free');
  assert.strictEqual(j.accounts[0].source, 'override');

  // A Free plan cannot use Opus: nothing is eligible, and explain says who was skipped.
  const opus = JSON.parse(run(home, ['proxy', 'explain', '--json', '--model', 'claude-opus-4-8']).stdout);
  assert.deepStrictEqual(opus.order, []);
  assert.deepStrictEqual(
    opus.skipped.map(function (s) {
      return s.name;
    }),
    ['alice'],
  );

  // Sonnet is fine on Free.
  const sonnet = JSON.parse(run(home, ['proxy', 'explain', '--json', '--model', 'claude-sonnet-4-5']).stdout);
  assert.deepStrictEqual(sonnet.order, ['alice']);
  assert.deepStrictEqual(sonnet.skipped, []);

  // A typo is refused and changes nothing.
  const bad = run(home, ['tier', 'alice', 'ultra']);
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /unknown tier/);
  assert.strictEqual(JSON.parse(run(home, ['tier', '--json']).stdout).accounts[0].tier, 'free');

  // 'auto' clears the override, and an unknown tier never blocks routing.
  assert.strictEqual(run(home, ['tier', 'alice', 'auto']).status, 0);
  j = JSON.parse(run(home, ['tier', '--json']).stdout);
  assert.strictEqual(j.accounts[0].tier, null);
  const again = JSON.parse(run(home, ['proxy', 'explain', '--json', '--model', 'claude-opus-4-8']).stdout);
  assert.deepStrictEqual(again.order, ['alice']);
});

test('cost rates prints the table, one model card, and flags an unknown model', function () {
  const home = setupHome();
  const all = run(home, ['cost', 'rates', '--json']);
  assert.strictEqual(all.status, 0, all.stderr);
  const j = JSON.parse(all.stdout);
  assert.ok(j.models.length >= 5);
  const opus = j.models.find(function (m) {
    return m.id === 'claude-opus-4-8';
  });
  assert.strictEqual(opus.inputPerMTok, 5);
  assert.strictEqual(opus.longContext.inputMult, 2);
  assert.strictEqual(opus.fast, 6);

  const one = JSON.parse(run(home, ['cost', 'rates', '--json', 'claude-haiku-4-5']).stdout);
  assert.strictEqual(one.id, 'claude-haiku-4-5');
  assert.strictEqual(one.longContext, null);

  const txt = run(home, ['cost', 'rates', 'claude-opus-4-8']);
  assert.strictEqual(txt.status, 0, txt.stderr);
  assert.match(txt.stdout, /long context/);
  assert.match(txt.stdout, /fast mode/);

  const unknown = JSON.parse(run(home, ['cost', 'rates', '--json', 'mystery-9']).stdout);
  assert.strictEqual(unknown.fallback, true);
});

test('cost prices refreshes the price table, honors the pin, and clears it', async function () {
  const http = await import('http');
  const payload = {
    'claude-opus-4-8': {
      litellm_provider: 'anthropic',
      mode: 'chat',
      max_input_tokens: 200000,
      input_cost_per_token: 0.000009,
      output_cost_per_token: 0.000045,
    },
    'claude-sonnet-4-6': {
      litellm_provider: 'anthropic',
      mode: 'chat',
      max_input_tokens: 200000,
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015,
    },
    'claude-haiku-4-5': {
      litellm_provider: 'anthropic',
      mode: 'chat',
      max_input_tokens: 200000,
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000005,
    },
    'claude-new-9': {
      litellm_provider: 'anthropic',
      mode: 'chat',
      max_input_tokens: 200000,
      input_cost_per_token: 0.000004,
      output_cost_per_token: 0.00002,
    },
    'claude-old-1': {
      litellm_provider: 'anthropic',
      mode: 'chat',
      max_input_tokens: 200000,
      input_cost_per_token: 0.000015,
      output_cost_per_token: 0.000075,
    },
  };
  const srv = http.createServer(function (req, res) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise(function (r) {
    srv.listen(0, '127.0.0.1', r);
  });
  const port = srv.address().port;
  const url = 'http://127.0.0.1:' + port + '/prices.json';
  const home = setupHome();
  const spawn = function (args, env) {
    return new Promise(function (resolve) {
      const child = _child_process.spawn(process.execPath, [BIN].concat(args), {
        env: Object.assign(
          {},
          process.env,
          {
            HOME: home,
            USERPROFILE: home,
            XDG_CONFIG_HOME: path.join(home, '.config'),
            KEYFLIP_CONFIG_DIR: path.join(home, '.config', 'keyflip'),
            APPDATA: path.join(home, 'AppData', 'Roaming'),
            KEYFLIP_TEST_CLAUDE: 'stopped',
            KEYFLIP_APP_BUNDLE: path.join(home, 'no-such-Claude.app'),
            KEYFLIP_PRICES_URL: url,
          },
          env || {},
        ),
      });
      let out = '';
      let err = '';
      child.stdout.on('data', function (d) {
        out += d;
      });
      child.stderr.on('data', function (d) {
        err += d;
      });
      child.on('close', function (code) {
        resolve({ code: code, out: out, err: err });
      });
    });
  };
  try {
    // Nothing cached yet: the bundled table is in use.
    const before = JSON.parse(run(home, ['cost', 'prices', '--json']).stdout);
    assert.strictEqual(before.source, 'bundled');
    assert.strictEqual(before.models, 0);

    const refreshed = await spawn(['cost', 'prices', '--refresh', '--json']);
    assert.strictEqual(refreshed.code, 0, refreshed.err);
    const j = JSON.parse(refreshed.out);
    assert.strictEqual(j.ok, true, refreshed.out);
    assert.strictEqual(j.models, 5);
    assert.match(j.digest, /^[a-f0-9]{64}$/);

    // The cost engine now prices from the live table.
    const opus = JSON.parse(run(home, ['cost', 'rates', '--json', 'claude-opus-4-8']).stdout);
    assert.strictEqual(opus.inputPerMTok, 9);
    const status = JSON.parse(run(home, ['cost', 'prices', '--json']).stdout);
    assert.strictEqual(status.source, 'cache');
    assert.strictEqual(status.digest, j.digest);

    // A pin that does not match refuses the refresh and keeps the cache.
    const refused = await spawn(['cost', 'prices', '--refresh', '--pin', 'a'.repeat(64), '--json']);
    assert.strictEqual(refused.code, 1);
    const refusedJson = JSON.parse(refused.out);
    assert.strictEqual(refusedJson.ok, false);
    assert.match(refusedJson.error, /sha-256 mismatch/);
    assert.strictEqual(JSON.parse(run(home, ['cost', 'prices', '--json']).stdout).digest, j.digest);

    // The matching pin is accepted.
    const pinned = await spawn(['cost', 'prices', '--refresh', '--pin', j.digest, '--json']);
    assert.strictEqual(pinned.code, 0, pinned.err);

    // Clearing drops the cache; the bundled table takes over again.
    const cleared = JSON.parse(run(home, ['cost', 'prices', '--clear', '--json']).stdout);
    assert.strictEqual(cleared.cleared, true);
    assert.strictEqual(JSON.parse(run(home, ['cost', 'prices', '--json']).stdout).source, 'bundled');
    assert.strictEqual(JSON.parse(run(home, ['cost', 'rates', '--json', 'claude-opus-4-8']).stdout).inputPerMTok, 5);
  } finally {
    await new Promise(function (r) {
      srv.close(r);
    });
  }
});

test('cost prices reports a failed refresh instead of pretending it worked', function () {
  const home = setupHome();
  const res = run(home, ['cost', 'prices', '--refresh', '--json'], {
    KEYFLIP_PRICES_URL: 'http://127.0.0.1:1/prices.json',
  });
  assert.strictEqual(res.status, 1);
  const j = JSON.parse(res.stdout);
  assert.strictEqual(j.ok, false);
  assert.ok(j.error, 'the failure is explained');
  // Nothing was cached by the failed refresh.
  assert.strictEqual(JSON.parse(run(home, ['cost', 'prices', '--json']).stdout).source, 'bundled');
});
