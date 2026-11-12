// The nightly `refresh --all` refused EVERYTHING whenever any Claude process ran — on a machine that
// always runs agents it never refreshed anything, and the yahoo login died on 3 Nov. Now only the
// accounts something is USING are left alone. No network: tokens are far from expiry ('fresh').
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { makeCtx, writeClaude } from './helpers.js';
import * as core from '../src/core.js';
import * as identity from '../src/identity.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'keyflip.js');
function blob(tok) {
  return JSON.stringify({
    claudeAiOauth: { accessToken: 'AT-' + tok, refreshToken: 'RT-' + tok, expiresAt: Date.now() + 30 * 86400000 },
  });
}

test('inUseAccounts: the live login (token and label), holders of the live token, running parallel sessions', function () {
  const ctx = makeCtx();
  const add = (email, uid, tok, name) => {
    writeClaude(ctx, { oauthAccount: { emailAddress: email }, userID: uid });
    ctx.store.setLive(blob(tok));
    core.addCurrent(ctx, name);
  };
  add('a@x.com', 'u1', 'a', 'a');
  add('b@x.com', 'u2', 'b', 'b');
  add('c@x.com', 'u3', 'c', 'c');
  add('d@x.com', 'u4', 'd', 'd');
  // live = d's token under c's label (a mislabel): both are in use
  writeClaude(ctx, { oauthAccount: { emailAddress: 'c@x.com' }, userID: 'u3' });
  ctx.store.setLive(blob('d'));
  // b runs in a parallel session (its own CLAUDE_CONFIG_DIR); a's session file is stale (dead pid)
  const sess = (n, pid) => {
    const dir = path.join(ctx.configDir, 'sessions', n, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, pid + '.json'), JSON.stringify({ pid: pid }));
  };
  sess('b', 4242);
  sess('a', 999);
  const r = identity.inUseAccounts(ctx, { pidAlive: (pid) => pid === 4242 });
  assert.deepStrictEqual(r.names.sort(), ['b', 'c', 'd']);
  assert.ok(/parallel session/.test(r.why.b));
});

function home() {
  const h = makeCtx().home;
  fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
  return h;
}
function run(h, args) {
  return spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      HOME: h,
      USERPROFILE: h,
      XDG_CONFIG_HOME: path.join(h, '.config'),
      KEYFLIP_CONFIG_DIR: path.join(h, '.config', 'keyflip'),
      KEYFLIP_TEST_CLAUDE: 'running', // "Claude Code is running on this machine" — the nightly reality
      KEYFLIP_APP_BUNDLE: path.join(h, 'no-such-Claude.app'),
    }),
  });
}
function loginAs(h, email, uid, b) {
  fs.writeFileSync(path.join(h, '.claude', '.credentials.json'), b);
  fs.writeFileSync(
    path.join(h, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email }, userID: uid }),
  );
}

test('CLI `refresh --all` with Claude running refreshes every account EXCEPT the live one', function () {
  const h = home();
  loginAs(h, 'alice@x.com', 'u1', blob('alice'));
  assert.strictEqual(run(h, ['add', 'alice']).status, 0);
  loginAs(h, 'bob@x.com', 'u2', blob('bob'));
  assert.strictEqual(run(h, ['add', 'bob']).status, 0); // bob is live
  const r = run(h, ['refresh', '--all', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepStrictEqual(j.heldBack, ['bob']);
  assert.deepStrictEqual(j.refreshed, [{ account: 'alice', status: 'fresh' }]);
  const human = run(h, ['refresh', '--all']);
  assert.ok(/leaving bob \(the live login\) alone; refreshing the others/.test(human.stdout), human.stdout);
});

test('CLI `refresh --all` with only the live account saved still refuses, and says which', function () {
  const h = home();
  loginAs(h, 'alice@x.com', 'u1', blob('alice'));
  assert.strictEqual(run(h, ['add', 'alice']).status, 0);
  const j = JSON.parse(run(h, ['refresh', '--all', '--json']).stdout);
  assert.strictEqual(j.refused, 'claude-code-running');
  assert.deepStrictEqual(j.heldBack, ['alice']);
  assert.deepStrictEqual(j.refreshed, []);
});
