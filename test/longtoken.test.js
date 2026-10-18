import test from 'node:test';
import assert from 'node:assert';
import http from 'http';
import * as longtoken from '../src/longtoken.js';
import * as oauth from '../src/oauth.js';
import * as core from '../src/core.js';
import * as loginmod from '../src/login.js';
import * as verify from '../src/verify.js';
import * as profiles from '../src/profiles.js';
import { makeCtx, writeClaude } from './helpers.js';

const NOW = 1800000000000;
const DAY = 86400000;

function full(opts) {
  opts = opts || {};
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: opts.at || 'FULL-AT',
      refreshToken: opts.rt === undefined ? 'FULL-RT' : opts.rt,
      expiresAt: opts.exp === undefined ? NOW + DAY : opts.exp,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
      rateLimitTier: 'tier-x',
    },
  });
}
function ll(exp) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'LL-AT',
      expiresAt: exp === undefined ? NOW + 300 * DAY : exp,
      scopes: ['user:inference'],
    },
  });
}
function tokenResponse(email, org) {
  return {
    access_token: 'MINTED-AT',
    expires_in: longtoken.LIFETIME_S,
    scope: 'user:inference',
    account: { uuid: 'acc-1', email_address: email },
    organization: { uuid: org || 'org-1' },
  };
}

test('authorizeUrl carries the setup-token parameters and no secret', function () {
  const p = longtoken.pkce();
  const u = new URL(longtoken.authorizeUrl({ port: 4321, challenge: p.challenge, state: p.state, email: 'a@x.io' }));
  assert.strictEqual(u.origin + u.pathname, longtoken.AUTHORIZE_URL);
  assert.strictEqual(u.searchParams.get('scope'), 'user:inference');
  assert.strictEqual(u.searchParams.get('client_id'), oauth.OAUTH_CLIENT_ID);
  assert.strictEqual(u.searchParams.get('redirect_uri'), 'http://localhost:4321/callback');
  assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
  assert.strictEqual(u.searchParams.get('code_challenge'), p.challenge);
  assert.strictEqual(u.searchParams.get('login_hint'), 'a@x.io');
  assert.ok(u.toString().indexOf(p.verifier) === -1, 'the PKCE verifier must never be in the URL');
});

test('isLongLived / isUsable / isDead classify blobs by shape and expiry', function () {
  assert.strictEqual(longtoken.isLongLived(ll()), true);
  assert.strictEqual(longtoken.isLongLived(full()), false);
  assert.strictEqual(longtoken.isUsable(ll(), NOW), true);
  assert.strictEqual(longtoken.isUsable(ll(NOW - 1), NOW), false);
  // expired but refreshable is NOT dead — refresh revives it, and it is the better token
  assert.strictEqual(longtoken.isDead(full({ exp: NOW - DAY }), NOW), false);
  // expired with Claude's empty refresh token IS dead
  assert.strictEqual(longtoken.isDead(full({ exp: NOW - DAY, rt: '' }), NOW), true);
  assert.strictEqual(longtoken.isDead('not json', NOW), true);
});

test('toBlob keeps a one-year expiry and the plan fields, and drops any refresh token', function () {
  const j = Object.assign(tokenResponse('a@x.io'), { refresh_token: 'SHOULD-NOT-SURVIVE' });
  const o = JSON.parse(longtoken.toBlob(j, { now: NOW, prev: full() })).claudeAiOauth;
  assert.strictEqual(o.accessToken, 'MINTED-AT');
  assert.strictEqual(o.expiresAt, NOW + longtoken.LIFETIME_S * 1000);
  assert.strictEqual(o.refreshToken, undefined);
  assert.deepStrictEqual(o.scopes, ['user:inference']);
  assert.strictEqual(o.subscriptionType, 'max');
});

function hit(port, query) {
  return new Promise(function (resolve, reject) {
    http
      .get('http://127.0.0.1:' + port + '/callback?' + query, function (res) {
        res.resume();
        res.on('end', function () {
          resolve({ status: res.statusCode, location: res.headers.location });
        });
      })
      .on('error', reject);
  });
}

test('listen rejects a wrong state without consuming the wait, and reports a denial', async function () {
  const l = longtoken.listen('GOOD', { waitMs: 5000 });
  try {
    const port = await l.ready;
    const bad = await hit(port, 'state=EVIL&code=c');
    assert.strictEqual(bad.status, 400);
    const denied = hit(port, 'state=GOOD&error=access_denied');
    await assert.rejects(l.got, function (e) {
      return e.code === 'denied';
    });
    assert.strictEqual((await denied).status, 400);
  } finally {
    l.close();
  }
});

// Drive the whole ceremony: `open` plays the browser and follows the redirect_uri.
function browserThatAuthorizes(code) {
  return function (url) {
    const u = new URL(url);
    const port = new URL(u.searchParams.get('redirect_uri')).port;
    setImmediate(function () {
      hit(port, 'state=' + encodeURIComponent(u.searchParams.get('state')) + '&code=' + code).catch(function () {});
    });
  };
}
function fakeFetch(body, calls, ok) {
  return async function (url, init) {
    calls.push({ url: url, body: JSON.parse(init.body) });
    return {
      ok: ok !== false,
      status: ok === false ? 400 : 200,
      json: async function () {
        return body;
      },
    };
  };
}

test('mint exchanges the code for a one-year token and returns identity + expiry only', async function () {
  const calls = [];
  const printed = [];
  const r = await longtoken.mint({
    email: 'a@x.io',
    org: 'org-1',
    open: browserThatAuthorizes('THE-CODE'),
    print: function (m) {
      printed.push(m);
    },
    fetch: fakeFetch(tokenResponse('a@x.io'), calls),
    now: NOW,
  });
  assert.strictEqual(r.email, 'a@x.io');
  assert.strictEqual(r.expiresAt, new Date(NOW + longtoken.LIFETIME_S * 1000).toISOString());
  assert.strictEqual(calls[0].url, oauth.OAUTH_TOKEN_URL);
  assert.strictEqual(calls[0].body.grant_type, 'authorization_code');
  assert.strictEqual(calls[0].body.code, 'THE-CODE');
  assert.strictEqual(calls[0].body.expires_in, 31536000);
  assert.ok(calls[0].body.code_verifier, 'PKCE verifier is sent to the token endpoint');
  assert.strictEqual(JSON.parse(r.blob).claudeAiOauth.accessToken, 'MINTED-AT');
  assert.ok(printed.join('\n').indexOf('MINTED-AT') === -1, 'the token is never printed');
});

test('mint refuses a token for a different account before anything is stored', async function () {
  await assert.rejects(
    longtoken.mint({
      email: 'a@x.io',
      open: browserThatAuthorizes('C'),
      fetch: fakeFetch(tokenResponse('someone-else@x.io'), []),
      now: NOW,
    }),
    function (e) {
      return e.code === 'mismatch' && e.actual === 'someone-else@x.io';
    },
  );
});

test('mint surfaces an exchange failure', async function () {
  await assert.rejects(
    longtoken.mint({ open: browserThatAuthorizes('C'), fetch: fakeFetch({}, [], false), now: NOW }),
    function (e) {
      return e.code === 'exchange-failed';
    },
  );
});

test('pick: normal login while alive or refreshable, the one-year token when it is dead', function () {
  const ctx = makeCtx();
  ctx.store.setProfile(longtoken.storeName('a'), ll());
  ctx.store.setProfile('a', full());
  assert.strictEqual(longtoken.pick(ctx.store, 'a', NOW).source, 'profile');
  ctx.store.setProfile('a', full({ exp: NOW - DAY })); // expired, still refreshable
  assert.strictEqual(longtoken.pick(ctx.store, 'a', NOW).source, 'profile');
  ctx.store.setProfile('a', full({ exp: NOW - DAY, rt: '' })); // dead
  const p = longtoken.pick(ctx.store, 'a', NOW);
  assert.strictEqual(p.source, 'long-lived');
  assert.strictEqual(p.blob, ll());
  ctx.store.setProfile(longtoken.storeName('a'), ll(NOW - 1)); // the fallback expired too
  assert.strictEqual(longtoken.pick(ctx.store, 'a', NOW).source, 'profile');
});

function seedAccount(ctx, name, email, blob) {
  ctx.store.setProfile(name, blob);
  profiles.write(ctx.configDir, {
    name: name,
    email: email,
    userID: 'u-' + name,
    oauthAccount: { emailAddress: email, organizationUuid: 'org-1' },
    savedAt: ctx.now(),
  });
}

test('a switch to an account whose login is dead installs its one-year token', function () {
  const ctx = makeCtx();
  writeClaude(ctx, { oauthAccount: { emailAddress: 'b@x.io' }, userID: 'u-b' });
  ctx.store.setLive(full({ at: 'B-LIVE' }));
  seedAccount(ctx, 'b', 'b@x.io', full({ at: 'B-LIVE' }));
  seedAccount(ctx, 'a', 'a@x.io', full({ exp: Date.now() - DAY, rt: '' }));
  ctx.store.setProfile(longtoken.storeName('a'), ll(Date.now() + 300 * DAY));
  const r = core.performSwitch(ctx, 'a');
  assert.strictEqual(r.cli, true);
  assert.strictEqual(JSON.parse(ctx.store.getLive()).claudeAiOauth.accessToken, 'LL-AT');
});

test('an account with ONLY a one-year token still counts as having a CLI login', function () {
  const ctx = makeCtx();
  writeClaude(ctx, { oauthAccount: { emailAddress: 'b@x.io' }, userID: 'u-b' });
  ctx.store.setLive(full({ at: 'B-LIVE' }));
  seedAccount(ctx, 'b', 'b@x.io', full({ at: 'B-LIVE' }));
  seedAccount(ctx, 'a', 'a@x.io', full());
  ctx.store.delProfile('a');
  ctx.store.setProfile(longtoken.storeName('a'), ll(Date.now() + 300 * DAY));
  assert.strictEqual(core.performSwitch(ctx, 'a').cli, true);
  assert.strictEqual(JSON.parse(ctx.store.getLive()).claudeAiOauth.accessToken, 'LL-AT');
});

test('removeProfile also deletes the one-year token', function () {
  const ctx = makeCtx();
  seedAccount(ctx, 'a', 'a@x.io', full());
  ctx.store.setProfile(longtoken.storeName('a'), ll());
  core.removeProfile(ctx, 'a');
  assert.strictEqual(ctx.store.getProfile(longtoken.storeName('a')), null);
});

test('maybeRefreshProfile reports long-lived instead of failing when the fallback covers it', async function () {
  const ctx = makeCtx();
  seedAccount(ctx, 'a', 'a@x.io', full({ exp: NOW - DAY, rt: '' }));
  assert.strictEqual((await oauth.maybeRefreshProfile(ctx, 'a', { nowMs: NOW })).status, 'refresh-failed');
  ctx.store.setProfile(longtoken.storeName('a'), ll());
  assert.strictEqual((await oauth.maybeRefreshProfile(ctx, 'a', { nowMs: NOW })).status, 'long-lived');
  // a refreshable login whose refresh merely failed is NOT papered over
  ctx.store.setProfile('a', full({ exp: NOW - DAY }));
  const r = await oauth.maybeRefreshProfile(ctx, 'a', {
    nowMs: NOW,
    fetch: async function () {
      return { ok: false };
    },
  });
  assert.strictEqual(r.status, 'refresh-failed');
});

test('verify reports the one-year token when the normal login is dead, never its value', function () {
  const ctx = makeCtx();
  seedAccount(ctx, 'a', 'a@x.io', full({ exp: NOW - DAY, rt: '' }));
  assert.strictEqual(verify.checkCliToken(ctx, 'a', { now: NOW }).state, 'fail');
  ctx.store.setProfile(longtoken.storeName('a'), ll());
  const c = verify.checkCliToken(ctx, 'a', { now: NOW });
  assert.strictEqual(c.state, 'ok');
  assert.strictEqual(c.longLived, true);
  assert.match(c.detail, /one-year/);
  assert.ok(JSON.stringify(c).indexOf('LL-AT') === -1);
});

function fakeMint(email) {
  return async function (o) {
    assert.ok(!o.email || o.email === email, 'expected identity is passed to mint');
    return {
      email: email,
      org: 'org-1',
      expiresAt: new Date(NOW + 365 * DAY).toISOString(),
      blob: ll(NOW + 365 * DAY),
    };
  };
}

test('performLongLived files the token beside a live login and leaves that login alone', async function () {
  const ctx = makeCtx();
  writeClaude(ctx, { oauthAccount: { emailAddress: 'b@x.io' }, userID: 'u-b' });
  ctx.store.setLive(full({ at: 'B-LIVE' }));
  seedAccount(ctx, 'a', 'a@x.io', full());
  const r = await loginmod.performLongLived(ctx, { name: 'a', mint: fakeMint('a@x.io'), now: NOW });
  assert.strictEqual(r.status, 'updated');
  assert.strictEqual(r.replacedProfile, false);
  assert.strictEqual(r.replacedLive, false);
  assert.strictEqual(ctx.store.getProfile(longtoken.storeName('a')), ll(NOW + 365 * DAY));
  assert.strictEqual(JSON.parse(ctx.store.getProfile('a')).claudeAiOauth.accessToken, 'FULL-AT');
  assert.strictEqual(JSON.parse(ctx.store.getLive()).claudeAiOauth.accessToken, 'B-LIVE');
});

test('performLongLived replaces a dead login, and the dead live credential of the active account', async function () {
  const ctx = makeCtx();
  writeClaude(ctx, { oauthAccount: { emailAddress: 'a@x.io' }, userID: 'u-a' });
  ctx.store.setLive(full({ exp: NOW - DAY, rt: '' }));
  seedAccount(ctx, 'a', 'a@x.io', full({ exp: NOW - DAY, rt: '' }));
  const r = await loginmod.performLongLived(ctx, { name: 'a', mint: fakeMint('a@x.io'), now: NOW });
  assert.strictEqual(r.replacedProfile, true);
  assert.strictEqual(r.replacedLive, true);
  assert.strictEqual(JSON.parse(ctx.store.getLive()).claudeAiOauth.accessToken, 'LL-AT');
});

test('performLongLived creates the account from the token identity when none is saved', async function () {
  const ctx = makeCtx();
  const r = await loginmod.performLongLived(ctx, { mint: fakeMint('new@x.io'), now: NOW });
  assert.strictEqual(r.status, 'added');
  assert.strictEqual(profiles.email(ctx.configDir, r.name), 'new@x.io');
  assert.strictEqual(JSON.parse(ctx.store.getProfile(r.name)).claudeAiOauth.accessToken, 'LL-AT');
});

test('performLongLived refuses --email that contradicts the named account', async function () {
  const ctx = makeCtx();
  seedAccount(ctx, 'a', 'a@x.io', full());
  await assert.rejects(
    loginmod.performLongLived(ctx, { name: 'a', email: 'b@x.io', mint: fakeMint('b@x.io'), now: NOW }),
    function (e) {
      return e.code === 'name-taken';
    },
  );
  assert.strictEqual(ctx.store.getProfile(longtoken.storeName('a')), null);
});
