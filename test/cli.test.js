'use strict';
// Integration tests for the CLI: spawn `node bin/keyflip.js` against a temp HOME.
// A ~/.claude/.credentials.json is created so the file backend is used on every
// OS (no Keychain, no prompts). Runs identically on macOS/Linux/Windows CI.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');

function setupHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-cli-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"live":"TOKEN-1"}'); // forces FileStore
  fs.writeFileSync(path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'alice@example.com' }, userID: 'u1' }));
  return home;
}

function loginAs(home, email, userID, token) {
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ live: token }));
  fs.writeFileSync(path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email }, userID: userID }));
}

function run(home, args, extraEnv) {
  return require('child_process').spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      HOME: home,
      USERPROFILE: home, // Windows homedir
      XDG_CONFIG_HOME: path.join(home, '.config'),
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      KEYFLIP_TEST_CLAUDE: 'stopped', // never touch a real app; deterministic across machines
    }, extraEnv || {}),
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

test('switch changes the active account (via CLI, --force)', function () {
  const home = setupHome();
  run(home, ['add']);                                  // save alice
  loginAs(home, 'bob@example.com', 'u2', 'TOKEN-2');
  run(home, ['add']);                                  // save bob
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

test('reset --force (factory) deletes all saved keyflip data', function () {
  const home = setupHome();
  run(home, ['add']); // -> profile alice
  assert.match(run(home, ['list']).stdout, /alice@example\.com/);
  const r = run(home, ['reset', '--force']);
  assert.strictEqual(r.status, 0, r.stderr);
  const list = run(home, ['list']).stdout;
  assert.match(list, /none yet/);          // saved profiles gone
  assert.doesNotMatch(list, /\[1\]/);      // no numbered entries
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
  run(home, ['add']);                                   // save alice (current)
  loginAs(home, 'bob@example.com', 'u2', 'TOKEN-2');
  run(home, ['add']);                                   // save bob (current = bob)
  const r = run(home, ['alice'], { KEYFLIP_TEST_CLAUDE: 'running' });
  assert.notStrictEqual(r.status, 0);                   // must not silently close/switch
  const cur = run(home, ['list'], { KEYFLIP_TEST_CLAUDE: 'running' });
  assert.match(cur.stdout, /bob@example\.com/);         // still on bob — nothing changed
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
  const r = require('child_process').spawnSync(process.execPath, [BIN, 'menu'], {
    encoding: 'utf8',
    input: 'a\n', // enter "save current", then stdin closes mid sub-prompt
    env: Object.assign({}, process.env, {
      HOME: home, USERPROFILE: home,
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
  const ORG = '11111111-2222-3333-4444-555555555555', ACCT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const cfg = { 'oauth:tokenCacheV2': 'not-a-v10-blob' };
  cfg['dxt:allowlistLastUpdated:' + ORG] = '2026-07-05T00:00:00.000Z';
  seedApp(home, cfg, [
    { dir: path.join('claude-code-sessions', ACCT, ORG) },
    { dir: path.join('local-agent-mode-sessions', ACCT, ORG), file: 's.json', content: JSON.stringify({ oauthAccount: { emailAddress: 'desktopuser@x.com' } }) },
  ]);
  const r = run(home, ['status', '--json']);
  const app = JSON.parse(r.stdout).app;
  assert.ok(app, 'app block present');
  assert.strictEqual(app.email, 'desktopuser@x.com'); // recovered despite no decryptable token
  assert.strictEqual(app.saved, false);               // marked as an unsaved account
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
