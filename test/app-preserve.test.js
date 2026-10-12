// Switch-time preservation of the account you are LEAVING: its desktop-app login and
// freshly-flushed session cookie are re-snapshotted into its own profile, which is what
// later lets `keyflip chat --as <that account>` read its cloud history. Two invariants
// are tested here: it only fires on a CONFIRMED token decrypt (a mislabelled snapshot
// would overwrite a good capture with the wrong account's blob), and never while the
// app is open (its files are locked).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as cli from '../src/cli.js';
import * as profiles from '../src/profiles.js';
import { makeCtx } from './helpers.js';

const PW = 'unit-test-safe-storage';
const ORG = '11111111-2222-3333-4444-555555555555';

// An Electron safeStorage blob: base64("v10" + AES-128-CBC(json)), IV = 16 spaces.
function tokenBlob(text) {
  const key = crypto.pbkdf2Sync(PW, 'saltysalt', 1003, 16, 'sha1');
  const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from('v10'), c.update(text), c.final()]).toString('base64');
}

function darwinCtx(token) {
  const ctx = makeCtx({ platform: 'darwin' });
  ctx.safeStoragePassword = PW; // never touch the real Keychain in tests
  const ad = path.join(ctx.home, 'Library', 'Application Support', 'Claude');
  fs.mkdirSync(ad, { recursive: true });
  const cfg = { 'oauth:tokenCacheV2': token };
  cfg['dxt:allowlistLastUpdated:' + ORG] = '2026-07-05T00:00:00.000Z';
  fs.writeFileSync(path.join(ad, 'config.json'), JSON.stringify(cfg));
  fs.writeFileSync(path.join(ad, 'Cookies'), 'sessionKey YAHOO-COOKIE');
  ctx.appDataDir = ad;
  profiles.write(ctx.configDir, {
    name: 'yahoo',
    email: 'y@example.com',
    oauthAccount: { organizationUuid: ORG },
    savedAt: ctx.now(),
  });
  return ctx;
}
const appJson = function (ctx) {
  return path.join(ctx.configDir, 'app', 'yahoo.json');
};
const appCookies = function (ctx) {
  return path.join(ctx.configDir, 'app', 'yahoo.cookies');
};

test('a switch keeps the outgoing account readable: token + session cookie refreshed', function () {
  process.env.KEYFLIP_TEST_CLAUDE = 'stopped';
  const ctx = darwinCtx(tokenBlob(JSON.stringify({ subscriptionUUID: ORG })));
  fs.mkdirSync(path.dirname(appJson(ctx)), { recursive: true });
  fs.writeFileSync(appJson(ctx), JSON.stringify({ 'oauth:tokenCacheV2': 'OLD-STALE-BLOB' }));

  const r = cli.preserveOutgoingAppLogin(ctx);
  assert.ok(r && r.ok, 'a confirmed decrypt identifies the outgoing account');
  const live = JSON.parse(fs.readFileSync(path.join(ctx.appDataDir, 'config.json'), 'utf8'));
  assert.strictEqual(
    JSON.parse(fs.readFileSync(appJson(ctx), 'utf8'))['oauth:tokenCacheV2'],
    live['oauth:tokenCacheV2'],
    'the live token replaced the stale capture',
  );
  assert.match(
    fs.readFileSync(appCookies(ctx), 'utf8'),
    /sessionKey YAHOO-COOKIE/,
    'the flushed cookie came along too',
  );
});

test('an inferred (undecryptable) app account never overwrites a saved capture', function () {
  process.env.KEYFLIP_TEST_CLAUDE = 'stopped';
  const ctx = darwinCtx('not-a-v10-blob'); // detectAppAccount falls back to the allowlist guess
  fs.mkdirSync(path.dirname(appJson(ctx)), { recursive: true });
  fs.writeFileSync(appJson(ctx), JSON.stringify({ 'oauth:tokenCacheV2': 'GOOD-CAPTURE' }));

  assert.strictEqual(cli.preserveOutgoingAppLogin(ctx), null);
  assert.match(
    fs.readFileSync(appJson(ctx), 'utf8'),
    /GOOD-CAPTURE/,
    'left alone — a guess is not worth a clobbered capture',
  );
});

test('nothing is preserved while the app is open (its login files are locked)', function () {
  process.env.KEYFLIP_TEST_CLAUDE = 'running';
  const ctx = darwinCtx(tokenBlob(JSON.stringify({ subscriptionUUID: ORG })));
  assert.strictEqual(cli.preserveOutgoingAppLogin(ctx), null);
  assert.strictEqual(fs.existsSync(appJson(ctx)), false);
  process.env.KEYFLIP_TEST_CLAUDE = 'stopped';
});

test('an app login keyflip has never saved is skipped, not guessed into a profile', function () {
  process.env.KEYFLIP_TEST_CLAUDE = 'stopped';
  const ctx = darwinCtx(tokenBlob(JSON.stringify({ subscriptionUUID: ORG })));
  fs.rmSync(path.join(ctx.configDir, 'yahoo.json'), { force: true }); // no profile owns this org
  profiles.write(ctx.configDir, { name: 'other', email: 'o@example.com', oauthAccount: {}, savedAt: ctx.now() });
  assert.strictEqual(cli.appActiveProfile(ctx), ''); // org resolves to no profile
  assert.strictEqual(cli.preserveOutgoingAppLogin(ctx), null);
  assert.strictEqual(
    fs.existsSync(appJson(ctx)),
    false,
    'nothing was captured into a profile that is not this account',
  );
});

// ---- browser-session capture: the other thing that makes an account's cloud Chat
// readable later (`keyflip chat --as <name>` reads these snapshots).

const CHROME = { id: 'chrome', name: 'Chrome' };
const OTHER_ORG = '99999999-8888-7777-6666-555555555555';

function captureCtx() {
  const ctx = darwinCtx(tokenBlob(JSON.stringify({ subscriptionUUID: ORG })));
  profiles.write(ctx.configDir, {
    name: 'elsewhere',
    email: 'elsewhere@example.com',
    oauthAccount: { organizationUuid: OTHER_ORG },
    savedAt: ctx.now(),
  });
  return ctx;
}

test('browser capture saves the claude.ai session under the account it belongs to', function () {
  const ctx = captureCtx();
  const saved = [];
  const r = cli.browserCapture(ctx, 'yahoo', {
    installed: [CHROME],
    readClaudeCookies: function () {
      return { cookie: 'sessionKey=S; lastActiveOrg=' + ORG, org: ORG };
    },
    saveSession: function (name, b) {
      saved.push(name + '/' + b.id);
      return true;
    },
  });
  assert.deepStrictEqual(saved, ['yahoo/chrome']);
  assert.deepStrictEqual(r.saved, ['Chrome']);
  assert.strictEqual(r.skipped.length, 0);
});

test('browser capture refuses to file a session under the WRONG account', function () {
  // The whole point of a saved session is that it is read back as that account later;
  // mislabelled cookies would silently poison every `chat --as` read.
  const ctx = captureCtx();
  let savedCalls = 0;
  const r = cli.browserCapture(ctx, 'yahoo', {
    installed: [CHROME],
    readClaudeCookies: function () {
      return { cookie: 'sessionKey=S', org: OTHER_ORG };
    },
    saveSession: function () {
      savedCalls++;
      return true;
    },
  });
  assert.strictEqual(savedCalls, 0, 'nothing was written');
  assert.deepStrictEqual(r.saved, []);
  assert.strictEqual(r.skipped[0].reason, 'other-account');
  assert.strictEqual(r.skipped[0].signedInAs, 'elsewhere@example.com', 'says who is actually in there');
});

test('a browser with no readable claude.ai session is reported, not guessed', function () {
  const ctx = captureCtx();
  const r = cli.browserCapture(ctx, 'yahoo', {
    installed: [CHROME],
    readClaudeCookies: function () {
      return null; // app-bound cookie encryption, or simply not signed in
    },
    saveSession: function () {
      assert.fail('must not save when nothing could be read');
    },
  });
  assert.deepStrictEqual(r.saved, []);
  assert.strictEqual(r.skipped[0].reason, 'no-readable-session');
});

// ---- did the app actually come back signed in after the switch reopened it? ----
// A restored jar is only half the story: the app trades its session cookie for a fresh
// token cache at launch, and if claude.ai has since rotated that session the app deletes
// the cookie and shows its sign-in screen. verifyAppRelogin is what stops keyflip from
// calling that a clean switch.
function reloginOpts(probe, calls) {
  return {
    polls: 4,
    stepMs: 1,
    sleep: async function (ms) {
      calls.push(ms);
    },
    session: probe,
  };
}

test('verifyAppRelogin: a cookie the app cleared is reported at once, not as a clean switch', async function () {
  const ctx = makeCtx({ platform: 'darwin' });
  ctx.appDataDir = path.join(ctx.home, 'Library', 'Application Support', 'Claude');
  const calls = [];
  const r = await cli.verifyAppRelogin(
    ctx,
    reloginOpts(() => false, calls),
  );
  assert.strictEqual(r, false);
  assert.strictEqual(calls.length, 1, 'stops polling on the first cleared reading');
});

test('verifyAppRelogin: a session that survives the app boot passes', async function () {
  const ctx = makeCtx({ platform: 'darwin' });
  ctx.appDataDir = path.join(ctx.home, 'Library', 'Application Support', 'Claude');
  const calls = [];
  assert.strictEqual(
    await cli.verifyAppRelogin(
      ctx,
      reloginOpts(() => true, calls),
    ),
    true,
  );
  assert.strictEqual(calls.length, 4, 'waits out the settle window on success');
});

test('verifyAppRelogin: an unreadable jar is retried instead of guessed at', async function () {
  const ctx = makeCtx({ platform: 'darwin' });
  ctx.appDataDir = path.join(ctx.home, 'Library', 'Application Support', 'Claude');
  let n = 0;
  const calls = [];
  const r = await cli.verifyAppRelogin(
    ctx,
    reloginOpts(function () {
      n++;
      return n < 3 ? null : true; // locked/being-written, then readable
    }, calls),
  );
  assert.strictEqual(r, true);
  assert.strictEqual(n, 4, 'the two unreadable readings did not end the poll');
});

test('verifyAppRelogin: nothing to check where there is no desktop app', async function () {
  const calls = [];
  assert.strictEqual(
    await cli.verifyAppRelogin(
      makeCtx({ platform: 'linux' }),
      reloginOpts(() => true, calls),
    ),
    null,
  );
  assert.strictEqual(calls.length, 0);
});
