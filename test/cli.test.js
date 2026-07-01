'use strict';
// Integration tests for the CLI: spawn `node bin/ccswitch.js` against a temp HOME.
// A ~/.claude/.credentials.json is created so the file backend is used on every
// OS (no Keychain, no prompts). Runs identically on macOS/Linux/Windows CI.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin', 'ccswitch.js');

function setupHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-cli-'));
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
      CCSWITCH_TEST_CLAUDE: 'stopped', // never touch a real app; deterministic across machines
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
  const sw = run(home, ['switch', 'alice', '--force']); // --force: Claude may be running on dev machines
  assert.strictEqual(sw.status, 0, sw.stderr);
  const cur = run(home, ['current']);
  assert.match(cur.stdout, /alice@example\.com/);
});

test('capture-app captures the desktop login for a named profile (macOS)', function (t) {
  if (process.platform !== 'darwin') return t.skip('the desktop app store is macOS-only');
  const home = setupHome();
  run(home, ['add']); // -> profile "alice"
  const appCfgDir = path.join(home, 'Library', 'Application Support', 'Claude');
  fs.mkdirSync(appCfgDir, { recursive: true });
  fs.writeFileSync(path.join(appCfgDir, 'config.json'), JSON.stringify({ 'oauth:tokenCacheV2': 'APP-TOKEN' }));
  const r = run(home, ['capture-app', 'alice']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(home, '.config', 'ccswitch', 'app', 'alice.json')), 'app token saved');
});

test('clean --force deletes all saved ccswitch data', function () {
  const home = setupHome();
  run(home, ['add']); // -> profile alice
  assert.match(run(home, ['list']).stdout, /alice@example\.com/);
  const r = run(home, ['clean', '--force']);
  assert.strictEqual(r.status, 0, r.stderr);
  const list = run(home, ['list']).stdout;
  assert.match(list, /none yet/);          // saved profiles gone
  assert.doesNotMatch(list, /\[1\]/);      // no numbered entries
  assert.match(list, /Active account: alice@example\.com/); // live login untouched
});

test('clean without --force in a non-interactive shell refuses', function () {
  const home = setupHome();
  run(home, ['add']);
  const r = run(home, ['clean']); // no TTY, no --force
  assert.notStrictEqual(r.status, 0);
  assert.match(run(home, ['list']).stdout, /\[1\] alice@example\.com/); // still saved
});

test('an unknown command exits non-zero', function () {
  const home = setupHome();
  const r = run(home, ['definitely-not-a-command']);
  assert.strictEqual(r.status, 1);
});

test('version prints and exits 0', function () {
  const home = setupHome();
  const r = run(home, ['version']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /ccswitch \d+\.\d+\.\d+/);
});

test('switch refuses to auto-close a running Claude without confirmation (non-interactive)', function () {
  const home = setupHome();
  run(home, ['add']);                                   // save alice (current)
  loginAs(home, 'bob@example.com', 'u2', 'TOKEN-2');
  run(home, ['add']);                                   // save bob (current = bob)
  const r = run(home, ['switch', 'alice'], { CCSWITCH_TEST_CLAUDE: 'running' });
  assert.notStrictEqual(r.status, 0);                   // must not silently close/switch
  const cur = run(home, ['current'], { CCSWITCH_TEST_CLAUDE: 'running' });
  assert.match(cur.stdout, /bob@example\.com/);         // still on bob — nothing changed
});

test('switch --restart proceeds while Claude is running (closes/reopens, or swaps where it cannot)', function () {
  const home = setupHome();
  run(home, ['add']);
  loginAs(home, 'bob@example.com', 'u2', 'TOKEN-2');
  run(home, ['add']);
  const r = run(home, ['switch', 'alice', '--restart'], { CCSWITCH_TEST_CLAUDE: 'running' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(run(home, ['current']).stdout, /alice@example\.com/);
});

test('switch --force swaps in place without closing a running Claude', function () {
  const home = setupHome();
  run(home, ['add']);
  loginAs(home, 'bob@example.com', 'u2', 'TOKEN-2');
  run(home, ['add']);
  const r = run(home, ['switch', 'alice', '--force'], { CCSWITCH_TEST_CLAUDE: 'running' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(run(home, ['current']).stdout, /alice@example\.com/);
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
