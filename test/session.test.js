'use strict';
// Parallel session mode (`ccswitch run`) + headless token import (`add --token`).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const session = require('../src/session');
const core = require('../src/core');
const { makeCtx, writeClaude, tmpdir } = require('./helpers');

const BLOB = JSON.stringify({ claudeAiOauth: { accessToken: 'AT', refreshToken: 'RT', expiresAt: 9999999999999 } });

function seeded() {
  const ctx = makeCtx();
  writeClaude(ctx, { oauthAccount: { emailAddress: 'a@x.com' }, userID: 'u1' });
  ctx.store.setLive(BLOB);
  core.addCurrent(ctx); // -> 'a'
  return ctx;
}

test('prepareSession seeds credentials + minimal .claude.json in an isolated dir', function () {
  const ctx = seeded();
  const dir = session.prepareSession(ctx, 'a', { share: false });
  assert.strictEqual(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8'), BLOB);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'));
  assert.strictEqual(cfg.hasCompletedOnboarding, true);
  assert.strictEqual(cfg.oauthAccount.emailAddress, 'a@x.com');
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(path.join(dir, '.credentials.json')).mode & 0o777, 0o600);
  }
});

test('sharing mirrors ~/.claude items via manifest-tracked links and never clobbers', function (t) {
  if (process.platform === 'win32') return t.skip('symlink semantics differ on Windows');
  const ctx = seeded();
  const src = path.join(ctx.home, '.claude');
  fs.mkdirSync(path.join(src, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(src, 'settings.json'), '{"theme":"dark"}');
  fs.writeFileSync(path.join(src, 'CLAUDE.md'), 'my rules');

  const dir = session.prepareSession(ctx, 'a', { share: true });
  assert.ok(fs.lstatSync(path.join(dir, 'settings.json')).isSymbolicLink());
  assert.strictEqual(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), '{"theme":"dark"}');
  assert.ok(fs.lstatSync(path.join(dir, 'skills')).isSymbolicLink());

  // user's own file in the session dir must never be replaced
  fs.rmSync(path.join(dir, 'CLAUDE.md'), { force: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'session-local rules');
  session.syncShared(ctx, dir, true);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), 'session-local rules');

  // --no-share removes ONLY manifest-created links, keeps user files
  session.syncShared(ctx, dir, false);
  assert.ok(!fs.existsSync(path.join(dir, 'settings.json')));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), 'session-local rules');
});

test('sessionEnv sets CLAUDE_CONFIG_DIR and scrubs auth-override vars', function () {
  const ctx = seeded();
  const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-x', CLAUDE_CODE_OAUTH_TOKEN: 't' };
  const se = session.sessionEnv(ctx, '/tmp/sess', base);
  assert.strictEqual(se.env.CLAUDE_CONFIG_DIR, '/tmp/sess');
  assert.strictEqual(se.env.ANTHROPIC_API_KEY, undefined);
  assert.strictEqual(se.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.deepStrictEqual(se.scrubbed.sort(), ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
  assert.strictEqual(se.env.PATH, '/bin');
});

test('syncBack persists a rotated in-session token to the profile (and only then)', function () {
  const ctx = seeded();
  const dir = session.prepareSession(ctx, 'a', { share: false });
  assert.strictEqual(session.syncBack(ctx, 'a'), false); // unchanged
  const rotated = JSON.stringify({ claudeAiOauth: { accessToken: 'AT2', refreshToken: 'RT2' } });
  fs.writeFileSync(path.join(dir, '.credentials.json'), rotated);
  assert.strictEqual(session.syncBack(ctx, 'a'), true);
  assert.strictEqual(ctx.store.getProfile('a'), rotated);
  fs.writeFileSync(path.join(dir, '.credentials.json'), 'garbage');
  assert.strictEqual(session.syncBack(ctx, 'a'), false); // corrupt never persisted
  assert.strictEqual(ctx.store.getProfile('a'), rotated);
});

// ---- spawned CLI: run + add --token guards ----
const BIN = path.join(__dirname, '..', 'bin', 'ccswitch.js');
function mkhome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-run-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), BLOB);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' }, userID: 'u1' }));
  return home;
}
function run(home, args, extraEnv, input) {
  return require('child_process').spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8', input: input,
    env: Object.assign({}, process.env, {
      HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      CCSWITCH_TEST_CLAUDE: 'stopped',
    }, extraEnv || {}),
  });
}

test('run without -y refuses in a non-interactive shell (risk confirmation)', function () {
  const home = mkhome();
  run(home, ['add']);
  const r = run(home, ['run', 'a']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /PARALLEL session/);
});

test('run -y launches with CLAUDE_CONFIG_DIR and syncs a rotated token back', function () {
  const home = mkhome();
  run(home, ['add']);
  // fake `claude`: prints its config dir and rotates the session credential
  const probe = path.join(home, 'probe.js');
  fs.writeFileSync(probe, [
    "const fs=require('fs'),path=require('path');",
    "const d=process.env.CLAUDE_CONFIG_DIR;",
    "console.log('CFGDIR='+d);",
    "fs.writeFileSync(path.join(d,'.credentials.json'), JSON.stringify({claudeAiOauth:{accessToken:'ROTATED',refreshToken:'R2'}}));",
  ].join('\n'));
  const r = run(home, ['run', 'a', '-y', '--', probe], { CCSWITCH_CLAUDE_BIN: process.execPath });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /CFGDIR=.*sessions/);
  assert.match(r.stdout, /token rotated — saved back/);
  // stored profile updated (file backend)
  const cred = fs.readFileSync(path.join(home, '.config', 'ccswitch', 'creds', 'a.cred'), 'utf8');
  assert.match(cred, /ROTATED/);
});

test('add --token imports from a file with --force, refuses piped stdin without it', function () {
  const home = mkhome();
  const tokFile = path.join(home, 'tok.json');
  fs.writeFileSync(tokFile, JSON.stringify({ claudeAiOauth: { accessToken: 'IMPORTED' } }));
  const ok = run(home, ['add', 'imported', '--token', tokFile, '--force', '--email', 'imp@x.com']);
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.match(run(home, ['list']).stdout, /imp@x\.com/);

  const piped = run(home, ['add', 'other', '--token', '-'], {}, JSON.stringify({ claudeAiOauth: { accessToken: 'X' } }));
  assert.notStrictEqual(piped.status, 0);
  assert.match(piped.stderr, /--force/);

  const bad = run(home, ['add', 'bad', '--token', tokFile]); // no --force, non-TTY
  assert.notStrictEqual(bad.status, 0);

  const invalid = path.join(home, 'bad.json');
  fs.writeFileSync(invalid, '{"nope":1}');
  const inv = run(home, ['add', 'x', '--token', invalid, '--force']);
  assert.notStrictEqual(inv.status, 0);
  assert.match(inv.stderr, /claudeAiOauth\.accessToken/);
});
