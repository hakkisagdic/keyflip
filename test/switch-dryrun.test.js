// #38 SWITCH PREFLIGHT through the real CLI: `--dry-run` must change nothing, must plan what the
// switch will change, and every switch must now read itself back instead of trusting its own writes.
// Spawned like test/cli.test.js (temp HOME + FileStore, so no Keychain and no real app is touched).
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

// A token shaped like the real thing: verify.js reads expiry + the presence of a refresh token, so a
// synthetic "TOKEN-1" blob would honestly report NOT usable. These tests are about the plumbing, so
// they start from captures that can actually pass.
function blob(minsLeft, withRefresh) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'AT-' + minsLeft,
      refreshToken: withRefresh === false ? '' : 'RT-1',
      expiresAt: Date.now() + minsLeft * 60000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'default-claude',
    },
  });
}

function setupHome(minsLeft) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-dryrun-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), blob(minsLeft || 120, true));
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'alice@example.com' }, userID: 'u1' }),
  );
  return home;
}

function loginAs(home, email, userID, token) {
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), token);
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email }, userID: userID }),
  );
}

// Where FileStore keeps an account's captured blob (configDir/creds/<name>.cred). Sabotaging this is
// how a real capture goes stale, so it drives the read-back honestly instead of faking a verdict.
function captureOf(home, name) {
  const dir = path.join(home, '.config', 'keyflip', 'creds');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name + '.cred');
}

function run(home, args, extraEnv) {
  return _child_process.spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8',
    env: Object.assign(
      {},
      process.env,
      {
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        KEYFLIP_CONFIG_DIR: path.join(home, '.config', 'keyflip'), // same tree on every OS
        APPDATA: path.join(home, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
        KEYFLIP_TEST_CLAUDE: 'stopped',
      },
      extraEnv || {},
    ),
  });
}

// Two saved accounts — and the machine left on ALICE, so "switch to bob" is a real switch and not
// the already-active no-op.
function twoAccounts() {
  const home = setupHome(120);
  assert.strictEqual(run(home, ['add']).status, 0);
  loginAs(home, 'bob@example.com', 'u2', blob(240, true));
  assert.strictEqual(run(home, ['add']).status, 0);
  loginAs(home, 'alice@example.com', 'u1', blob(120, true));
  return home;
}

// Byte-for-byte snapshot of everything a switch writes. The state repo's own .git objects and the
// activity log are deliberately excluded: keyflip logs every command (including a dry run) and
// versions its metadata repo, and neither is a credential write.
function snapshotTree(home) {
  const out = {};
  const skip = function (p) {
    return p.indexOf('/.git/') !== -1 || /\.log$/i.test(p) || p.indexOf('pre-sync-backups') !== -1;
  };
  const walk = function (dir, rel) {
    fs.readdirSync(dir).forEach(function (f) {
      const p = path.join(dir, f);
      const r = path.join(rel, f);
      if (skip(p)) return;
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p, r);
      else out[r] = fs.readFileSync(p).toString('hex');
    });
  };
  ['.claude', path.join('.config', 'keyflip')].forEach(function (d) {
    const p = path.join(home, d);
    if (fs.existsSync(p)) walk(p, d);
  });
  const live = path.join(home, '.claude.json');
  if (fs.existsSync(live)) out['.claude.json'] = fs.readFileSync(live).toString('hex');
  return out;
}

test('--dry-run plans the switch and changes absolutely nothing', function () {
  const home = twoAccounts();
  const before = snapshotTree(home);
  const r = run(home, ['bob', '--dry-run']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry run/, 'it must announce itself as a dry run');
  assert.match(r.stdout, /nothing was changed/);
  assert.match(r.stdout, /write:/);
  assert.match(r.stdout, /bob@example\.com/);
  assert.deepStrictEqual(snapshotTree(home), before, 'dry run mutated a file it should never touch');
});

test('--dry-run on the account that is already active promises no writes', function () {
  const home = twoAccounts();
  const before = snapshotTree(home);
  const r = run(home, ['alice', '--dry-run']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /already active/);
  assert.doesNotMatch(r.stdout, /write:/, 'an already-active account must not plan any write');
  assert.deepStrictEqual(snapshotTree(home), before);
});

test('--dry-run --json gives the plan as data, human text kept off stdout', function () {
  const home = twoAccounts();
  const before = snapshotTree(home);
  const r = run(home, ['bob', '--dry-run', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.dryRun, true);
  assert.strictEqual(j.target, 'bob');
  assert.ok(Array.isArray(j.plan.writes) && j.plan.writes.length, JSON.stringify(j));
  assert.match(j.plan.writes.join(' '), /CLI login/);
  assert.ok(j.verify && ['ok', 'warn', 'fail', 'none'].indexOf(j.verify.state) !== -1, JSON.stringify(j.verify));
  assert.doesNotMatch(r.stdout, /dry run —/, 'stdout must carry exactly the JSON object');
  assert.match(r.stderr, /dry run/, 'human lines go to stderr in --json mode');
  assert.deepStrictEqual(snapshotTree(home), before);
});

test('a switch reads itself back: a live capture reports usable, and --no-verify stays quiet', function () {
  const home = twoAccounts();
  const sw = run(home, ['bob', '--force']);
  assert.strictEqual(sw.status, 0, sw.stderr);
  assert.match(sw.stdout, /Switched to: bob@example\.com/);
  assert.match(sw.stdout, /verified: usable now/, 'post-switch read-back must run by default');

  const quiet = run(home, ['alice', '--force', '--no-verify']);
  assert.strictEqual(quiet.status, 0, quiet.stderr);
  assert.doesNotMatch(quiet.stdout, /verified:|read-back:/);

  // And a dead capture is reported as one, right after the switch that "succeeded".
  loginAs(home, 'carol@example.com', 'u3', blob(120, true));
  assert.strictEqual(run(home, ['add']).status, 0);
  fs.writeFileSync(captureOf(home, 'carol'), blob(-99999, false));
  // Leave carol before switching to her: `keyflip add` leaves the machine on the new account, and an
  // already-active account short-circuits before any switching (or reading back) happens.
  loginAs(home, 'alice@example.com', 'u1', blob(120, true));
  const dead = run(home, ['carol', '--force']);
  assert.match(dead.stdout, /read-back: NOT usable|verified: NOT usable/, dead.stdout);
});

test('--dry-run on a decaying account warns before the machine moves', function () {
  const home = setupHome(3); // 3 minutes of token left: expiring, still refreshable
  assert.strictEqual(run(home, ['add']).status, 0);
  loginAs(home, 'bob@example.com', 'u2', blob(240, true));
  assert.strictEqual(run(home, ['add']).status, 0);
  // Sabotage the stored capture (not the live one) so the target itself reads as decaying.
  fs.writeFileSync(captureOf(home, 'alice'), blob(2, true));
  const r = run(home, ['alice', '--dry-run']);
  assert.match(r.stdout, /decaying|NOT usable/, r.stdout);
  // A decaying-but-refreshable token is described as what it is: refreshed during the switch.
  assert.match(r.stdout, /refreshes it during the switch/, r.stdout);
  assert.doesNotMatch(r.stdout, /cannot be refreshed/, r.stdout);
  // The live machine did not move: still bob, and the plan only *would* have written.
  assert.match(run(home, ['list']).stdout, /Claude Code: bob@example\.com/);
});

test('--rollback-on-fail is opt-in and says what it restored (or why it cannot)', function () {
  const home = twoAccounts();
  // Nothing is actually broken here, so the flag must stay silent: no rollback lines on a good switch.
  const good = run(home, ['bob', '--force', '--rollback-on-fail']);
  assert.strictEqual(good.status, 0, good.stderr);
  assert.doesNotMatch(good.stdout, /rolling back/, good.stdout);

  // A target whose stored token is dead AND whose refresh token is empty cannot be revived by
  // refresh; the read-back says NOT usable, and the only saved account to go back to is alice.
  const back = run(home, ['alice', '--force', '--rollback-on-fail']);
  assert.strictEqual(back.status, 0, back.stderr);
  assert.match(back.stdout, /verified: usable now/, 'switching back to a live account verifies clean');
  assert.doesNotMatch(back.stdout, /rolling back/);
  // Sabotage AFTER that switch: a switch re-saves the account it LEAVES (refreshCurrent), so writing
  // a dead capture while bob is still live would just get overwritten with bob's working token.
  fs.writeFileSync(captureOf(home, 'bob'), blob(-10, false));
  const bad = run(home, ['bob', '--force', '--rollback-on-fail']);
  assert.match(bad.stdout, /rolling back:/, bad.stdout);
  assert.match(bad.stdout, /rolled the CLI back to alice@example\.com/, bad.stdout);
  assert.match(run(home, ['list']).stdout, /Claude Code: alice@example\.com/);
});

test('--only picks the surfaces a switch moves, and rejects anything it does not know', function () {
  const home = twoAccounts();
  const bad = run(home, ['bob', '--only', 'fridge']);
  assert.notStrictEqual(bad.status, 0);
  assert.match(bad.stderr + bad.stdout, /--only takes cli, app or browser/);

  // The plan says what --only leaves out, and writes nothing.
  const before = snapshotTree(home);
  const plan = run(home, ['bob', '--only', 'cli', '--dry-run']);
  assert.strictEqual(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /write: +the CLI login/);
  assert.match(plan.stdout, /desktop app login — left out by --only/);
  assert.match(plan.stdout, /browser claude.ai session — left out by --only/);
  assert.deepStrictEqual(snapshotTree(home), before);

  // --only cli moves the CLI credential in place and nothing else.
  const sw = run(home, ['bob', '--only=cli']);
  assert.strictEqual(sw.status, 0, sw.stderr);
  assert.match(sw.stdout, /Switched the CLI to: bob@example\.com/);
  assert.doesNotMatch(sw.stdout, /Quitting Claude|desktop app's login/);
  assert.match(run(home, ['list']).stdout, /Claude Code: bob@example\.com/);
  // …and saying it again is a no-op that says so.
  const again = run(home, ['bob', '--only', 'cli']);
  assert.strictEqual(again.status, 0, again.stderr);
  assert.match(again.stdout, /The CLI is already on 'bob@example\.com'/);

  // --only browser with no Chromium jar on this (temp) HOME: explicit, non-zero, nothing written.
  const b4 = snapshotTree(home);
  const br = run(home, ['alice', '--only', 'browser']);
  if (process.platform === 'darwin' || process.platform === 'win32') {
    assert.strictEqual(br.status, 1, br.stdout + br.stderr);
    assert.match(br.stdout, /No Chromium browser with a claude.ai cookie jar/);
  } else assert.match(br.stderr, /macOS and Windows only/);
  assert.deepStrictEqual(snapshotTree(home), b4);
});
