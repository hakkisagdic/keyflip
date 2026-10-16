import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { tmpdir } from './helpers.js';
import {
  tokenCheck,
  rollup,
  verifyAccount,
  chromiumTimeUsToMs,
  sessionCookieInfo,
  checkAppCookies,
  CAPTURE_FAIL_DAYS,
} from '../src/verify.js';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const SECRET = 'sk-ant-ThisValueMustNeverAppearAnywhere';

// One OAuth blob shaped exactly like Claude's own (note: Claude really does store an EMPTY
// refreshToken once it has rotated one away — that is the state that makes gmail unrecoverable).
function blob(opts) {
  opts = opts || {};
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: SECRET,
      refreshToken: 'rt' in opts ? opts.rt : 'rt-stored-value',
      expiresAt: 'expiresAt' in opts ? opts.expiresAt : NOW + 5 * 60 * MIN,
      refreshTokenExpiresAt: opts.rte,
      scopes: ['user:inference'],
    },
  });
}
function state(res) {
  return res.state;
}

test('tokenCheck: no credential is "none", corrupt JSON is a fail', function () {
  assert.equal(tokenCheck('cli token (stored)', null, { now: NOW }).state, 'none');
  assert.equal(tokenCheck('cli token (stored)', 'not json', { now: NOW }).state, 'fail');
});

test('tokenCheck: a live token is ok, one inside the expiry buffer is a warn', function () {
  assert.equal(state(tokenCheck('t', blob(), { now: NOW })), 'ok');
  // 4 minutes out, but inside the 5-minute buffer oauth.isExpiring uses.
  assert.equal(state(tokenCheck('t', blob({ expiresAt: NOW + 4 * MIN }), { now: NOW })), 'warn');
});

test('tokenCheck: expired WITH a refresh token is revivable (warn), without one is fatal (fail)', function () {
  const dead = tokenCheck('t', blob({ expiresAt: NOW - 115 * DAY }), { now: NOW });
  assert.equal(dead.state, 'warn');
  assert.match(dead.detail, /keyflip refresh/);
  assert.equal(dead.refreshable, true);
  // The gmail case: Claude wrote an empty refreshToken, so nothing can revive it.
  const gone = tokenCheck('t', blob({ expiresAt: NOW - 115 * DAY, rt: '' }), { now: NOW });
  assert.equal(gone.state, 'fail');
  assert.match(gone.detail, /needs a real login/);
  assert.equal(gone.refreshable, false);
});

test('tokenCheck: an EXPIRED refresh token is as dead as none at all', function () {
  const r = tokenCheck('t', blob({ expiresAt: NOW - DAY, rte: NOW - 1000 }), { now: NOW });
  assert.equal(r.state, 'fail');
  assert.match(r.detail, /refresh token expired/);
});

test('tokenCheck reports age in days once a token has been dead for days, not 166272 minutes', function () {
  const r = tokenCheck('t', blob({ expiresAt: NOW - 115 * DAY, rt: '' }), { now: NOW });
  assert.match(r.detail, /115 days/);
  assert.doesNotMatch(r.detail, /16[0-9]{4} min/);
});

test('NO check ever carries a credential VALUE — only shape, expiry and presence', function () {
  const r = tokenCheck('t', blob({ expiresAt: NOW - DAY }), { now: NOW });
  const line = JSON.stringify(r);
  assert.doesNotMatch(line, /sk-ant/);
  assert.doesNotMatch(line, /rt-stored-value/);
});

test('rollup: the worst state wins; "none" cannot outrank a real problem', function () {
  const c = function (s) {
    return { state: s };
  };
  assert.equal(rollup([c('ok'), c('none'), c('warn')]), 'warn');
  assert.equal(rollup([c('ok'), c('warn'), c('fail')]), 'fail');
  assert.equal(rollup([c('ok'), c('none')]), 'ok');
  assert.equal(rollup([c('none'), c('none')]), 'none');
});

test('chromiumTimeUsToMs converts the 1601 epoch, and treats 0 as "no expiry"', function () {
  // 2026-11-04T00:00:00Z in Chromium microseconds.
  const us = (Date.UTC(2026, 10, 4) / 1000 + 11644473600) * 1000000;
  assert.equal(chromiumTimeUsToMs(us), Date.UTC(2026, 10, 4));
  assert.equal(chromiumTimeUsToMs(0), null);
  assert.equal(chromiumTimeUsToMs('nonsense'), null);
});

// A "cookies DB" that sqlite cannot open must degrade to a presence-only judgement, never a crash
// and never a false "signed in".
test('sessionCookieInfo returns null when the DB cannot be read', function () {
  const home = tmpdir();
  const f = path.join(home, 'Cookies');
  fs.writeFileSync(f, 'this is not a sqlite database');
  assert.equal(sessionCookieInfo(f, { run: () => ({ code: 1, stdout: '', stderr: '' }) }), null);
  assert.equal(sessionCookieInfo(path.join(home, 'nope'), {}), null);
});

test('checkAppCookies: an unreadable capture past the fail window is not reported as usable', function () {
  const home = tmpdir();
  const configDir = path.join(home, '.config', 'keyflip');
  fs.mkdirSync(path.join(configDir, 'app'), { recursive: true });
  const f = path.join(configDir, 'app', 'old.cookies');
  fs.writeFileSync(f, 'not readable by sqlite');
  const old = NOW - (CAPTURE_FAIL_DAYS + 4) * DAY;
  fs.utimesSync(f, new Date(old), new Date(old));
  const r = checkAppCookies({ configDir: configDir }, 'old', { now: NOW, run: () => ({ code: 1, stdout: '' }) });
  assert.equal(r.state, 'fail');
  assert.match(r.detail, /could not be read/);
});

test('verifyAccount runs the whole sweep offline and inserts the live token only for the live account', async function () {
  const home = tmpdir();
  const configDir = path.join(home, '.config', 'keyflip');
  fs.mkdirSync(path.join(configDir, 'app'), { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'app', 'a.json'),
    JSON.stringify({ 'oauth:tokenCache': 'encrypted-blob', 'oauth:tokenCacheV2': 'encrypted-blob' }),
  );
  const store = {
    getProfile: function (n) {
      return n === 'a' ? blob({ expiresAt: NOW - DAY }) : null;
    },
    getLive: function () {
      return blob();
    },
  };
  const ctx = { home: home, configDir: configDir, platform: 'linux', store: store };

  const live = await verifyAccount(ctx, 'a', { now: NOW, store: store, liveAccount: 'a' });
  const names = live.checks.map(function (c) {
    return c.name;
  });
  assert.ok(names.indexOf('cli token (live)') !== -1, 'live token checked for the live account');
  assert.equal(
    live.checks.find(function (c) {
      return c.name === 'cli token (stored)';
    }).state,
    'warn',
  );
  assert.equal(live.state, 'warn');

  const other = await verifyAccount(ctx, 'b', { now: NOW, store: store, liveAccount: 'a' });
  assert.equal(
    other.checks.some(function (c) {
      return c.name === 'cli token (live)';
    }),
    false,
    'another account must not inherit the machine live credential',
  );
  assert.equal(other.state, 'none');
  assert.doesNotMatch(JSON.stringify(other), /sk-ant/);
});
