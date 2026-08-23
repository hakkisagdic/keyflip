// status / next / --json / --debug / styling behaviors via the spawned CLI.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import _child_process from 'child_process';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');

function setupHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-flags-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"live":"TOKEN-1"}');
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
  return _child_process.spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      KEYFLIP_CONFIG_DIR: path.join(home, '.config', 'keyflip'), // deterministic across OSes (Windows uses APPDATA otherwise)
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      KEYFLIP_TEST_CLAUDE: 'stopped',
    }, extraEnv || {}),
  });
}

test('status prints the CLI account; --json emits schemaVersion object on stdout', function () {
  const home = setupHome();
  const human = run(home, ['status']);
  assert.strictEqual(human.status, 0, human.stderr);
  assert.match(human.stdout, /Claude Code: alice@example\.com/);

  const j = run(home, ['status', '--json']);
  const obj = JSON.parse(j.stdout.trim());
  assert.strictEqual(obj.schemaVersion, 1);
  assert.strictEqual(obj.cli.email, 'alice@example.com');
});

test('list --json emits accounts with capture/active flags and nothing else on stdout', function () {
  const home = setupHome();
  run(home, ['add']);
  const j = run(home, ['list', '--json']);
  const obj = JSON.parse(j.stdout.trim()); // throws if stdout isn't pure JSON
  assert.strictEqual(obj.schemaVersion, 1);
  assert.strictEqual(obj.accounts.length, 1);
  assert.strictEqual(obj.accounts[0].email, 'alice@example.com');
  assert.strictEqual(obj.accounts[0].cliCaptured, true);
  assert.strictEqual(obj.accounts[0].activeCli, true);
});

test('switch --json reports what was switched; errors become {error} with exit 1', function () {
  const home = setupHome();
  run(home, ['add']);
  loginAs(home, 'bob@example.com', 'u2', 'TOKEN-2');
  run(home, ['add']);
  const j = run(home, ['alice', '--force', '--json']);
  assert.strictEqual(j.status, 0, j.stderr);
  const obj = JSON.parse(j.stdout.trim());
  assert.strictEqual(obj.switched.name, 'alice');
  assert.strictEqual(obj.cliSwitched, true);

  const bad = run(home, ['no-such-profile-xyz', '--json']);
  assert.strictEqual(bad.status, 1);
});

test('next rotates to the other account (wrap-around)', function () {
  const home = setupHome();
  run(home, ['add']);                                   // alice
  loginAs(home, 'bob@example.com', 'u2', 'TOKEN-2');
  run(home, ['add']);                                   // bob (active)
  let r = run(home, ['next', '--force']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(run(home, ['status']).stdout, /alice@example\.com/); // bob -> alice
  r = run(home, ['next', '--force']);
  assert.match(run(home, ['status']).stdout, /bob@example\.com/);   // alice -> bob (wrap)
});

test('next with fewer than 2 accounts fails cleanly', function () {
  const home = setupHome();
  run(home, ['add']);
  const r = run(home, ['next', '--force']);
  assert.notStrictEqual(r.status, 0);
});

test('a read-only run creates no log dir; a mutation writes the action log', function () {
  const home = setupHome();
  run(home, ['list']);
  const logDir = path.join(home, '.config', 'keyflip', 'logs');
  assert.ok(!fs.existsSync(logDir), 'no logs for read-only run');
  run(home, ['add']);
  assert.ok(fs.existsSync(path.join(logDir, 'keyflip.log')), 'mutation logged');
});

test('--debug echoes records to stderr', function () {
  const home = setupHome();
  const r = run(home, ['add', '--debug']);
  assert.match(r.stderr, /\[debug\]/);
});

test('piped (non-TTY) output contains no ANSI colors', function () {
  const home = setupHome();
  run(home, ['add']);
  const r = run(home, ['list']);
  assert.doesNotMatch(r.stdout, /\x1b\[/);
});
