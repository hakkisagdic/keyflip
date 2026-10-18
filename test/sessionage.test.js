// Tests for src/sessionage.js: the sign-in AGE of every claude.ai session keyflip holds, and the
// server's "too old" verdict (session_stale_relogin) read from Claude's log. Everything runs on
// fixtures — fake sqlite runners, literal log text, a temp config dir — so no real jar, log or
// cookie value is ever touched.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as sa from '../src/sessionage.js';
import * as plan from '../src/switchplan.js';

const DAY = 86400000;
// Chromium time (µs since 1601) for an epoch-ms instant.
function chrome(ms) {
  return String((ms + 11644473600 * 1000) * 1000);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kf-age-'));
}

test('chromeToMs converts Chromium microseconds and rejects zero/garbage', function () {
  const t = Date.UTC(2026, 9, 18, 19, 10, 9);
  assert.strictEqual(sa.chromeToMs(chrome(t)), t);
  assert.strictEqual(sa.chromeToMs('0'), null);
  assert.strictEqual(sa.chromeToMs('nope'), null);
});

test('splitValues keeps strings (with commas and quotes) and never keeps blob bytes', function () {
  const v = sa.splitValues("13300000000000000,'.claude.ai','', 'a,b''c', X'DEADBEEF',NULL,42");
  assert.deepStrictEqual(v, ['13300000000000000', '.claude.ai', '', "a,b'c", '<blob>', 'NULL', '42']);
});

test('sqlTimes reads the newest claude.ai session cookie out of a saved browser snapshot', function () {
  const old = Date.UTC(2026, 9, 1);
  const neu = Date.UTC(2026, 9, 7, 10, 8, 4);
  const row = function (created, host, name, expires) {
    return (
      'INSERT INTO cookies VALUES(' +
      chrome(created) +
      ",'" +
      host +
      "','','" +
      name +
      "','',X'00AA','/'," +
      chrome(expires) +
      ',1,1);'
    );
  };
  const sql = [
    'BEGIN TRANSACTION;',
    row(old, '.claude.ai', 'sessionKey', old + 28 * DAY),
    row(neu, '.claude.ai', 'sessionKey', neu + 28 * DAY),
    row(neu + DAY, '.claude.ai', 'lastActiveOrg', neu + 300 * DAY), // not a session cookie
    row(neu + DAY, '.example.com', 'sessionKey', neu + 300 * DAY), // not claude.ai
    'COMMIT;',
  ].join('\n');
  const t = sa.sqlTimes(sql);
  assert.strictEqual(t.signedInAt, neu);
  assert.strictEqual(t.expiresAt, neu + 28 * DAY);
  assert.strictEqual(sa.sqlTimes('BEGIN;\nCOMMIT;'), null, 'no session row = signed out');
  assert.strictEqual(sa.sqlTimes(''), undefined);
});

test('jarTimes queries a COPY of the jar and keeps unreadable apart from signed out', function () {
  const dir = tmpDir();
  const jar = path.join(dir, 'Cookies');
  fs.writeFileSync(jar, 'fixture');
  const signed = Date.UTC(2026, 9, 18, 19, 6, 24);
  const calls = [];
  const runner = function (out) {
    return function (cmd, args) {
      calls.push(args);
      if (args[1] && /^\.backup/.test(args[1])) return { code: 1 }; // force the plain-copy fallback
      return out;
    };
  };
  const t = sa.jarTimes(jar, {
    run: runner({ code: 0, stdout: chrome(signed) + '\t' + chrome(signed + 28 * DAY) + '\n' }),
  });
  assert.strictEqual(t.signedInAt, signed);
  assert.strictEqual(t.expiresAt, signed + 28 * DAY);
  const q = calls[calls.length - 1];
  assert.match(q[2], /^file:.*keyflip-age-.*\?mode=ro$/, 'the query must run on a read-only temp copy');
  assert.notStrictEqual(q[2].indexOf(jar), 0);
  assert.doesNotMatch(q[3], /\bvalue\b|encrypted_value/, 'a cookie VALUE is never selected');
  assert.strictEqual(sa.jarTimes(jar, { run: runner({ code: 0, stdout: '' }) }), null);
  assert.strictEqual(sa.jarTimes(jar, { run: runner({ code: 1, stdout: '' }) }), undefined);
  assert.strictEqual(sa.jarTimes(path.join(dir, 'missing')), undefined);
  // The temp copies are gone again.
  assert.deepStrictEqual(
    fs.readdirSync(os.tmpdir()).filter(function (f) {
      return /^keyflip-age-/.test(f);
    }),
    [],
  );
});

test('describe grades fresh / aging / expiring / expired', function () {
  const now = Date.UTC(2026, 9, 18);
  const at = function (ageDays, life) {
    return sa.describe(
      { signedInAt: now - ageDays * DAY, expiresAt: now - ageDays * DAY + (life || 28) * DAY },
      {
        now: now,
        staleAfterDays: 7,
      },
    );
  };
  assert.strictEqual(at(1).state, 'fresh');
  assert.strictEqual(at(8).state, 'aging', 'older than an age the server refused before');
  assert.strictEqual(at(24).state, 'expiring');
  assert.strictEqual(at(29).state, 'expired');
  assert.strictEqual(
    sa.describe({ signedInAt: now - 8 * DAY, expiresAt: now + 20 * DAY }, { now: now }).state,
    'fresh',
    'without a learned threshold nothing is called aging',
  );
  assert.strictEqual(at(3).daysLeft, 25);
  assert.strictEqual(sa.describe(null), null);
});

test('fmt shows minutes, hours and days from the real sign-in time', function () {
  const now = Date.UTC(2026, 9, 18, 12);
  const d = function (ms) {
    return { signedInAt: new Date(now - ms).toISOString(), ageDays: 0, daysLeft: 28 };
  };
  assert.strictEqual(sa.fmt(d(20 * 60000), now), 'signed in 20m ago, 28d left');
  assert.strictEqual(sa.fmt(d(3 * 3600000), now), 'signed in 3h ago, 28d left');
  assert.strictEqual(sa.fmt(Object.assign(d(8 * DAY), { daysLeft: -1 }), now), 'signed in 8d ago, EXPIRED');
  assert.strictEqual(sa.fmt(null), 'no claude.ai session');
});

// Real line shapes from Claude Desktop's main.log (org uuids made up).
const ORG = '11111111-2222-3333-4444-555555555555';
const REFUSE = [
  '2026-10-18 22:07:53 [info] oauth failed: authorize returned 403 <json error=permission_error code=session_stale_relogin len=238>',
  '2026-10-18 22:07:53 [info] oauth authorize rejected with session_stale_relogin; sessionKey is valid but too old for the requested scope expansion',
  '2026-10-18 22:07:53 [info] [oauth-v2] fresh exchange failed for orgId=' + ORG + ' (session_stale_relogin)',
];
const CLEAR = [
  '2026-10-18 22:10:09 [info] [oauth] clearing latched session_stale_relogin failures',
  '2026-10-18 22:10:09 [info] [sessions-bridge] sessionKey rotated; restarting bridge after session_stale_relogin park',
];
const ctxLog = { platform: 'darwin', home: '/nonexistent', claudeLogPath: '/fixture/main.log' };

test('staleRelogin: a refusal latches, a later clear releases it', function () {
  const s = sa.staleRelogin(ctxLog, { text: REFUSE.join('\n') });
  assert.strictEqual(s.stale, true);
  assert.strictEqual(s.org, ORG);
  assert.strictEqual(s.at, new Date(2026, 9, 18, 22, 7, 53).toISOString(), 'log stamps are local time');
  assert.strictEqual(sa.staleRelogin(ctxLog, { text: REFUSE.concat(CLEAR).join('\n') }).stale, false);
});

test('staleRelogin follows LOG ORDER, not timestamps: a clear then a refusal in the same second is stale', function () {
  const sameSecond = CLEAR.concat(
    REFUSE.map(function (l) {
      return l.replace('22:07:53', '22:10:09');
    }),
  );
  assert.strictEqual(sa.staleRelogin(ctxLog, { text: sameSecond.join('\n') }).stale, true);
});

test('staleRelogin ignores lines before `since`, and reports "not checked" without a log', function () {
  const since = new Date(2026, 9, 18, 22, 9, 0).getTime();
  assert.strictEqual(sa.staleRelogin(ctxLog, { text: REFUSE.join('\n'), since: since }).stale, false);
  const none = sa.staleRelogin({ platform: 'linux', home: '/x' }, {});
  assert.strictEqual(none.checked, false);
  assert.strictEqual(none.stale, false);
});

function seedProfile(dir, name, org) {
  fs.writeFileSync(
    path.join(dir, name + '.json'),
    JSON.stringify({ oauthAccount: { emailAddress: name + '@example.com', organizationUuid: org } }),
  );
}

test('recordStale learns the youngest refused age, idempotently, in a subdirectory', function () {
  const dir = tmpDir();
  assert.strictEqual(sa.staleAfterDays(dir), null);
  sa.recordStale(dir, { at: '2026-10-13T15:16:30.000Z', profile: 'yahoo', ageDays: 7.9 });
  sa.recordStale(dir, { at: '2026-10-13T15:16:30.000Z', profile: 'yahoo', ageDays: 7.9 }); // same event
  sa.recordStale(dir, { at: '2026-10-02T03:18:23.000Z', profile: 'yahoo', ageDays: 7.7 });
  sa.recordStale(dir, { at: 'x', profile: 'yahoo', ageDays: NaN }); // ignored
  assert.strictEqual(sa.readObservations(dir).length, 2);
  assert.strictEqual(sa.staleAfterDays(dir), 7.7);
  assert.strictEqual(path.dirname(sa.freshnessFile(dir)), path.join(dir, 'freshness'));
  // Never a top-level <configDir>/*.json — that would be a phantom account.
  assert.deepStrictEqual(
    fs.readdirSync(dir).filter(function (f) {
      return /\.json$/.test(f);
    }),
    [],
  );
});

test('noteStale records the refused sign-in age and skips a refusal older than the sign-in', function () {
  const dir = tmpDir();
  seedProfile(dir, 'yahoo', ORG);
  const ctx = { configDir: dir, platform: 'darwin', home: dir, appDataDir: null };
  const at = '2026-10-18T19:07:53.000Z';
  const signed = Date.parse(at) - 7.75 * DAY;
  const obs = sa.noteStale(ctx, { stale: true, at: at, org: ORG }, { times: { signedInAt: signed } });
  assert.deepStrictEqual(obs, { at: at, profile: 'yahoo', ageDays: 7.8 });
  assert.strictEqual(sa.staleAfterDays(dir), 7.8);
  assert.strictEqual(
    sa.noteStale(ctx, { stale: true, at: at, org: ORG }, { times: { signedInAt: Date.parse(at) + 1000 } }),
    null,
  );
  assert.strictEqual(sa.noteStale(ctx, { stale: false }), null);
});

test('report lists every saved sign-in with its age and maps a stale org to its account', function () {
  const dir = tmpDir();
  seedProfile(dir, 'yahoo', ORG);
  const now = Date.UTC(2026, 9, 18, 20);
  const signed = now - 3 * DAY;
  fs.mkdirSync(path.join(dir, 'browser-sessions'));
  fs.writeFileSync(
    path.join(dir, 'browser-sessions', 'yahoo__chrome.sql'),
    'INSERT INTO cookies VALUES(' +
      chrome(signed) +
      ",'.claude.ai','','sessionKey','',X'00','/'," +
      chrome(signed + 28 * DAY) +
      ',1,1);\n',
  );
  const r = sa.report(
    { configDir: dir, home: dir, platform: 'darwin', appDataDir: null },
    { now: now, stale: { stale: true, at: '2026-10-18T19:07:53.000Z', org: ORG, checked: true } },
  );
  assert.strictEqual(r.accounts.length, 1);
  const a = r.accounts[0];
  assert.strictEqual(a.name, 'yahoo');
  assert.strictEqual(a.app, null, 'no app capture = no app entry');
  assert.strictEqual(a.browsers[0].browser, 'Chrome');
  assert.strictEqual(a.browsers[0].ageDays, 3);
  assert.strictEqual(a.browsers[0].state, 'fresh');
  assert.strictEqual(r.stale.profile, 'yahoo');
  assert.strictEqual(r.live.app, null);
  assert.strictEqual(sa.worst([{ state: 'fresh' }, { state: 'expiring' }, { state: 'aging' }]), 'expiring');
});

test('the switch plan warns about an old saved app sign-in, but only when the app moves', function () {
  const base = {
    target: 'gmail',
    email: 'me@gmail.com',
    activeCliEmail: 'me@yahoo.com',
    appCaptured: true,
    cliCaptured: true,
    targetState: 'ok',
    appSignIn: { ageDays: 9, daysLeft: 19, state: 'aging' },
  };
  assert.match(
    plan.build(base, {}).warns.join(' '),
    /9 day\(s\) old and is older than a sign-in claude.ai has refused/,
  );
  const exp = plan.build(Object.assign({}, base, { appSignIn: { ageDays: 25, daysLeft: 3, state: 'expiring' } }), {});
  assert.match(exp.warns.join(' '), /expires in 3 day\(s\)/);
  const fresh = plan.build(Object.assign({}, base, { appSignIn: { ageDays: 1, daysLeft: 27, state: 'fresh' } }), {});
  assert.strictEqual(fresh.warns.length, 0);
  const cliOnly = plan.build(base, { surfaces: { cli: true, app: false, browser: false, only: true } });
  assert.doesNotMatch(cliOnly.warns.join(' '), /saved app sign-in/, '--only cli leaves the app alone');
});
