// Tests for the shared guarded OAuth refresh core (src/tokenkeeper.js / src/oauth.js),
// schedule (15m interval + RunAtLoad), usage 401 refresh-and-retry, MCP keyflip_refresh,
// doctor token renewal checks, and CLI status/list/refresh visibility.
// Uses fakes (makeCtx + MemoryStore, injected fetch/clock/sleep/runner/notify) and spawned CLI
// with temp HOME + KEYFLIP_CONFIG_DIR. Never touches the real machine.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { makeCtx, writeClaude } from './helpers.js';
import * as tokenkeeper from '../src/tokenkeeper.js';
import * as profiles from '../src/profiles.js';
import * as core from '../src/core.js';
import * as config from '../src/config.js';
import * as schedule from '../src/schedule.js';
import * as usage from '../src/usage.js';
import * as doctor from '../src/doctor.js';
import * as mcp from '../src/mcp.js';
import * as lock from '../src/lock.js';
import * as logmod from '../src/log.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'keyflip.js');
const T0 = Date.parse('2026-11-13T11:44:00.000Z');

function makeBlob(id, expiresAtMs, extra) {
  return JSON.stringify({
    claudeAiOauth: Object.assign(
      {
        accessToken: 'AT-' + id,
        refreshToken: 'RT-' + id,
        expiresAt: expiresAtMs,
        scopes: ['user:inference', 'user:profile'],
      },
      extra || {},
    ),
  });
}

function addSavedAccount(ctx, name, email, uid, blobStr) {
  writeClaude(ctx, { oauthAccount: { emailAddress: email, accountUuid: uid }, userID: uid });
  ctx.store.setLive(blobStr);
  core.addCurrent(ctx, name);
}

// 1. Inactive account with 50 min left (lead 60) -> refreshed; new access token, new expiresAt
//    AND the rotated refresh token are stored; state file updated; fetch called once with grant_type refresh_token.
test('1. inactive account with 50 min left (lead 60) is refreshed, rotated tokens stored, state updated', async function () {
  const ctx = makeCtx();
  addSavedAccount(ctx, 'yahoo', 'yahoo@example.com', 'u-yahoo', makeBlob('yahoo-old', T0 + 50 * 60 * 1000));
  addSavedAccount(ctx, 'gmail', 'gmail@example.com', 'u-gmail', makeBlob('gmail-live', T0 + 365 * 86400000));

  const fetchCalls = [];
  const fakeFetch = async function (url, init) {
    fetchCalls.push({ url: url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async function () {
        return {
          access_token: 'AT-yahoo-new',
          refresh_token: 'RT-yahoo-rotated',
          expires_in: 28800,
          scope: 'user:inference user:profile',
        };
      },
    };
  };

  const out = await tokenkeeper.refreshDue(ctx, {
    nowMs: T0,
    fetch: fakeFetch,
    sleep: async function () {},
  });

  assert.strictEqual(out.ok, true);
  assert.strictEqual(fetchCalls.length, 1, 'fetch called exactly once');
  assert.strictEqual(fetchCalls[0].url, tokenkeeper.OAUTH_TOKEN_URL);
  assert.strictEqual(fetchCalls[0].body.grant_type, 'refresh_token');
  assert.strictEqual(fetchCalls[0].body.refresh_token, 'RT-yahoo-old');
  assert.strictEqual(fetchCalls[0].body.client_id, tokenkeeper.OAUTH_CLIENT_ID);

  const yahooRes = out.results.find((r) => r.account === 'yahoo');
  assert.ok(yahooRes);
  assert.strictEqual(yahooRes.status, 'refreshed');

  const stored = JSON.parse(ctx.store.getProfile('yahoo')).claudeAiOauth;
  assert.strictEqual(stored.accessToken, 'AT-yahoo-new');
  assert.strictEqual(stored.refreshToken, 'RT-yahoo-rotated');
  assert.strictEqual(stored.expiresAt, T0 + 28800 * 1000);

  const st = tokenkeeper.readRefreshState(ctx);
  assert.ok(st.yahoo, 'refresh-state.json entry created for yahoo');
  assert.strictEqual(st.yahoo.lastResult, 'refreshed');
  assert.strictEqual(st.yahoo.lastAttemptAt, new Date(T0).toISOString());
  assert.strictEqual(st.yahoo.lastSuccessAt, new Date(T0).toISOString());
  assert.strictEqual(st.yahoo.consecutiveFailures, 0);
  assert.strictEqual(st.yahoo.expiresAt, T0 + 28800 * 1000);
});

// 2. Account with 3 h left -> 'fresh', fetch never called; leadMinutes config respected and validated.
test('2. account with 3 h left is fresh and fetch is never called; config refresh.leadMinutes validated 5..240', async function () {
  const ctx = makeCtx();
  addSavedAccount(ctx, 'yahoo', 'yahoo@example.com', 'u-yahoo', makeBlob('yahoo-3h', T0 + 3 * 3600 * 1000));
  addSavedAccount(ctx, 'gmail', 'gmail@example.com', 'u-gmail', makeBlob('gmail-live', T0 + 8 * 3600 * 1000));

  let fetchCalls = 0;
  const out = await tokenkeeper.refreshDue(ctx, {
    nowMs: T0,
    fetch: async function () {
      fetchCalls += 1;
      throw new Error('fetch should not be called');
    },
  });

  assert.strictEqual(fetchCalls, 0);
  const yahooRes = out.results.find((r) => r.account === 'yahoo');
  assert.strictEqual(yahooRes.status, 'fresh');

  // Config validation: 5..240 accepted, out of range rejected
  assert.throws(function () {
    config.set(ctx, 'refresh.leadMinutes', '4');
  }, /must be >= 5/);
  assert.throws(function () {
    config.set(ctx, 'refresh.leadMinutes', '241');
  }, /must be <= 240/);
  config.set(ctx, 'refresh.leadMinutes', '200');
  assert.strictEqual(config.get(ctx, 'refresh.leadMinutes'), 200);

  // With leadMinutes = 200 (3h 20m), 3h left IS due
  const out2 = await tokenkeeper.refreshDue(ctx, {
    nowMs: T0,
    fetch: async function () {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async function () {
          return { access_token: 'AT-yahoo-200', refresh_token: 'RT-yahoo-200', expires_in: 28800 };
        },
      };
    },
  });
  assert.strictEqual(fetchCalls, 1);
  assert.strictEqual(out2.results.find((r) => r.account === 'yahoo').status, 'refreshed');
});

// 3. Already expired account with a refresh token -> refreshed.
test('3. already expired account with a refresh token is refreshed; long-lived account without refresh token is not-refreshable', async function () {
  const ctx = makeCtx();
  addSavedAccount(ctx, 'expiredAcct', 'exp@example.com', 'u-exp', makeBlob('exp-old', T0 - 2 * 3600 * 1000));
  addSavedAccount(
    ctx,
    'longLivedAcct',
    'll@example.com',
    'u-ll',
    JSON.stringify({
      claudeAiOauth: { accessToken: 'AT-ll-only', expiresAt: T0 + 300 * 86400000, scopes: ['user:inference'] },
    }),
  );
  addSavedAccount(ctx, 'liveAcct', 'live@example.com', 'u-live', makeBlob('live-tok', T0 + 8 * 3600 * 1000));

  let calls = 0;
  const out = await tokenkeeper.refreshDue(ctx, {
    nowMs: T0,
    fetch: async function () {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async function () {
          return { access_token: 'AT-exp-new', refresh_token: 'RT-exp-new', expires_in: 28800 };
        },
      };
    },
  });

  assert.strictEqual(calls, 1, 'only the refreshable expired account calls fetch');
  assert.strictEqual(out.results.find((r) => r.account === 'expiredAcct').status, 'refreshed');
  assert.strictEqual(out.results.find((r) => r.account === 'longLivedAcct').status, 'long-lived');
  assert.strictEqual(out.ok, true);
});

// 4. The live/held account is never refreshed and setLive is never called, while the other account
//    IS refreshed in the same run (Claude "running").
test('4. the live/held account is untouched and setLive is never called while the inactive account is refreshed', async function () {
  const ctx = makeCtx();
  const liveOriginalBlob = makeBlob('live-expiring', T0 - 1000); // even expired!
  const otherBlob = makeBlob('other-expiring', T0 + 10 * 60 * 1000);
  addSavedAccount(ctx, 'other', 'other@example.com', 'u-other', otherBlob);
  addSavedAccount(ctx, 'live', 'live@example.com', 'u-live', liveOriginalBlob);

  let setLiveCalled = 0;
  ctx.store.setLive = function () {
    setLiveCalled += 1;
    throw new Error('setLive must NEVER be called by tokenkeeper');
  };

  let fetchedRts = [];
  const out = await tokenkeeper.refreshDue(ctx, {
    nowMs: T0,
    fetch: async function (_url, init) {
      fetchedRts.push(JSON.parse(init.body).refresh_token);
      return {
        ok: true,
        status: 200,
        json: async function () {
          return { access_token: 'AT-other-fresh', refresh_token: 'RT-other-fresh', expires_in: 28800 };
        },
      };
    },
  });

  assert.strictEqual(setLiveCalled, 0, 'setLive was never called');
  assert.deepStrictEqual(fetchedRts, ['RT-other-expiring'], 'only the non-held account was refreshed');
  assert.strictEqual(out.results.find((r) => r.account === 'live').status, 'held');
  assert.strictEqual(out.results.find((r) => r.account === 'other').status, 'refreshed');
  assert.strictEqual(ctx.store.getProfile('live'), liveOriginalBlob, 'held profile blob is untouched');
  assert.strictEqual(ctx.store.getLive(), liveOriginalBlob, 'live blob is untouched');
});

// 5. A profile holding the same refresh token as the live blob is skipped.
test('5. a profile holding the same refresh token as the live blob is skipped even if inUseAccounts did not list it', async function () {
  const ctx = makeCtx();
  // Create profile 'clone' whose refreshToken equals the live blob's refreshToken,
  // but with a different accessToken and expiring soon.
  profiles.write(ctx.configDir, { name: 'clone', email: 'clone@example.com' });
  ctx.store.setProfile(
    'clone',
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'AT-clone-diff',
        refreshToken: 'RT-shared-with-live',
        expiresAt: T0 + 5 * 60 * 1000,
      },
    }),
  );
  ctx.store.setLive(
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'AT-live-diff',
        refreshToken: 'RT-shared-with-live',
        expiresAt: T0 + 5 * 60 * 1000,
      },
    }),
  );

  let fetchCalled = 0;
  const out = await tokenkeeper.refreshDue(ctx, {
    nowMs: T0,
    // Even if inUseAccounts returns empty, the refresh-token fingerprint guard must catch it.
    inUseAccounts: function () {
      return { names: [], why: {} };
    },
    fetch: async function () {
      fetchCalled += 1;
      throw new Error('must not refresh a profile sharing the live refresh token');
    },
  });

  assert.strictEqual(fetchCalled, 0);
  const res = out.results.find((r) => r.account === 'clone');
  assert.strictEqual(res.status, 'held');
  assert.match(res.reason || '', /live token/);
});

// 6. 400 invalid_grant -> 'dead', one notification (desktop runner called once with the account name
//    and "keyflip login <name>"), a second run does not notify again and does not call fetch again
//    until the stored blob changes; after a new blob it tries again.
test('6. 400 invalid_grant marks dead, notifies once via desktop runner on darwin (never on linux), suppresses retries until stored blob changes', async function () {
  const ctx = makeCtx({ platform: 'darwin' });
  addSavedAccount(ctx, 'yahoo', 'yahoo@example.com', 'u-yahoo', makeBlob('yahoo-dead', T0 - 60000));
  addSavedAccount(ctx, 'gmail', 'gmail@example.com', 'u-gmail', makeBlob('gmail-live', T0 + 8 * 3600000));

  let fetchCalls = 0;
  const runnerCalls = [];
  const notifyPayloads = [];
  const fakeRunner = function (cmd, args) {
    runnerCalls.push({ cmd: cmd, args: args });
    return { code: 0, stdout: '' };
  };
  const deadFetch = async function () {
    fetchCalls += 1;
    return {
      ok: false,
      status: 400,
      json: async function () {
        return { error: 'invalid_grant', error_description: 'Refresh token revoked AT-yahoo-dead RT-yahoo-dead' };
      },
    };
  };

  // Run 1: 400 invalid_grant -> 'dead' + 1 alert
  const run1 = await tokenkeeper.refreshDue(ctx, {
    nowMs: T0,
    fetch: deadFetch,
    run: fakeRunner,
    notify: function (p) {
      notifyPayloads.push(p);
    },
  });
  assert.strictEqual(run1.ok, false);
  const r1 = run1.results.find((r) => r.account === 'yahoo');
  assert.strictEqual(r1.status, 'dead');
  assert.strictEqual(r1.error, 'invalid_grant');
  assert.strictEqual(fetchCalls, 1);
  assert.strictEqual(notifyPayloads.length, 1);
  const osascriptCalls1 = runnerCalls.filter((c) => c.cmd === '/usr/bin/osascript');
  assert.strictEqual(osascriptCalls1.length, 1, 'desktop runner called once on darwin');
  const scriptArg = osascriptCalls1[0].args.join(' ');
  assert.ok(scriptArg.indexOf('yahoo') !== -1, 'notification mentions account name');
  assert.ok(scriptArg.indexOf('keyflip login yahoo') !== -1, 'notification includes keyflip login <name>');

  // Verify on linux that osascript is NEVER called even when a runner is present
  const linuxCtx = makeCtx({ platform: 'linux' });
  const linuxRunnerCalls = [];
  linuxCtx.run = function (cmd, args) {
    linuxRunnerCalls.push({ cmd: cmd, args: args });
    return { code: 0, stdout: '' };
  };
  addSavedAccount(linuxCtx, 'yahoo', 'yahoo@example.com', 'u-yahoo', makeBlob('yahoo-linux-dead', T0 - 60000));
  addSavedAccount(linuxCtx, 'gmail', 'gmail@example.com', 'u-gmail', makeBlob('gmail-linux-live', T0 + 8 * 3600000));
  await tokenkeeper.refreshDue(linuxCtx, {
    nowMs: T0,
    fetch: deadFetch,
    run: linuxCtx.run,
  });
  assert.strictEqual(
    linuxRunnerCalls.filter((c) => c.cmd === '/usr/bin/osascript').length,
    0,
    'never calls osascript on linux',
  );
  fetchCalls = 1; // reset counter for darwin ctx checks below

  // Run 2 (15 min later, same stored blob): no fetch, no duplicate notification
  const run2 = await tokenkeeper.refreshDue(ctx, {
    nowMs: T0 + 15 * 60 * 1000,
    fetch: deadFetch,
    run: fakeRunner,
    notify: function (p) {
      notifyPayloads.push(p);
    },
  });
  assert.strictEqual(run2.results.find((r) => r.account === 'yahoo').status, 'dead');
  assert.strictEqual(fetchCalls, 1, 'fetch not called again while blob is unchanged');
  assert.strictEqual(
    runnerCalls.filter((c) => c.cmd === '/usr/bin/osascript').length,
    1,
    'desktop notification not sent a second time',
  );

  // User re-logs in yahoo (stored blob expiresAt changes) -> next run tries again and recovers
  ctx.store.setProfile('yahoo', makeBlob('yahoo-relogged', T0 + 20 * 60 * 1000));
  const run3 = await tokenkeeper.refreshDue(ctx, {
    nowMs: T0 + 16 * 60 * 1000,
    fetch: async function () {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async function () {
          return { access_token: 'AT-yahoo-revived', refresh_token: 'RT-yahoo-revived', expires_in: 28800 };
        },
      };
    },
    run: fakeRunner,
    notify: function (p) {
      notifyPayloads.push(p);
    },
  });
  assert.strictEqual(fetchCalls, 2, 'fetch called again after stored blob changed');
  assert.strictEqual(run3.results.find((r) => r.account === 'yahoo').status, 'refreshed');
  assert.ok(
    notifyPayloads.some((p) => p.result === 'recovered'),
    'recovery after an alert notifies once',
  );
});

// 7. 503 then 503 then 200 within one run -> refreshed with 2 retries (sleep injected);
//    3 transient runs in a row -> alert on the 3rd; nextAttemptAt backoff respected;
//    expired token overrides the backoff after 5 min.
test('7. within-run transient retries (503, 503, 200), 3rd consecutive transient alert, backoff, and 5-min expired override', async function () {
  const ctx = makeCtx();
  // Expiring in 45 min (not yet expired, within 60-min lead window)
  addSavedAccount(ctx, 'yahoo', 'yahoo@example.com', 'u-yahoo', makeBlob('yahoo-tr', T0 + 45 * 60 * 1000));
  addSavedAccount(ctx, 'gmail', 'gmail@example.com', 'u-gmail', makeBlob('gmail-live', T0 + 8 * 3600000));

  const sleeps = [];
  let seq = 0;
  const outRetry = await tokenkeeper.refreshDue(ctx, {
    nowMs: T0,
    sleep: async function (ms) {
      sleeps.push(ms);
    },
    fetch: async function () {
      seq += 1;
      if (seq <= 2) {
        return {
          ok: false,
          status: 503,
          json: async function () {
            return { error: 'service_unavailable' };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        json: async function () {
          return { access_token: 'AT-yahoo-ok', refresh_token: 'RT-yahoo-ok', expires_in: 2700 };
        },
      };
    },
  });
  assert.strictEqual(seq, 3, '2 retries after initial 503 -> 3 calls total');
  assert.deepStrictEqual(sleeps, [2000, 8000], 'injected sleep called with 2s and 8s backoff');
  assert.strictEqual(outRetry.results.find((r) => r.account === 'yahoo').status, 'refreshed');

  // Now test 3 transient runs in a row -> alert on the 3rd, backoff respected, expired override after 5 min.
  // Reset yahoo's expiresAt to T0 + 50 min (not yet expired).
  ctx.store.setProfile('yahoo', makeBlob('yahoo-tr2', T0 + 50 * 60 * 1000));
  tokenkeeper.writeRefreshState(ctx, {});

  let fetchCalls = 0;
  const alerts = [];
  const always503 = async function () {
    fetchCalls += 1;
    return {
      ok: false,
      status: 503,
      json: async function () {
        return { error: 'overloaded' };
      },
    };
  };

  // Run 1 at T0: fails (3 attempts within run), consecutiveFailures = 1, nextAttemptAt = T0 + 5m, no alert
  await tokenkeeper.refreshDue(ctx, {
    nowMs: T0,
    sleep: async function () {},
    fetch: always503,
    notify: (p) => alerts.push(p),
    run: () => ({ code: 0 }),
  });
  assert.strictEqual(fetchCalls, 3);
  assert.strictEqual(alerts.length, 0, 'no alert on 1st transient run');
  let st = tokenkeeper.readRefreshState(ctx).yahoo;
  assert.strictEqual(st.consecutiveFailures, 1);
  assert.strictEqual(st.nextAttemptAt, new Date(T0 + 5 * 60 * 1000).toISOString());

  // Run at T0 + 2m (before 5m backoff, not expired): skipped by backoff, fetch not called
  await tokenkeeper.refreshDue(ctx, {
    nowMs: T0 + 2 * 60 * 1000,
    sleep: async function () {},
    fetch: always503,
    notify: (p) => alerts.push(p),
    run: () => ({ code: 0 }),
  });
  assert.strictEqual(fetchCalls, 3, 'nextAttemptAt backoff respected when not expired');

  // Run 2 at T0 + 5m: fails, consecutiveFailures = 2, nextAttemptAt = T0 + 5m + 10m = T0 + 15m, no alert
  await tokenkeeper.refreshDue(ctx, {
    nowMs: T0 + 5 * 60 * 1000,
    sleep: async function () {},
    fetch: always503,
    notify: (p) => alerts.push(p),
    run: () => ({ code: 0 }),
  });
  assert.strictEqual(fetchCalls, 6);
  assert.strictEqual(alerts.length, 0, 'no alert on 2nd transient run');
  st = tokenkeeper.readRefreshState(ctx).yahoo;
  assert.strictEqual(st.consecutiveFailures, 2);
  assert.strictEqual(st.nextAttemptAt, new Date(T0 + 15 * 60 * 1000).toISOString());

  // Run 3 at T0 + 15m: fails, consecutiveFailures = 3 -> ALERT emitted! nextAttemptAt = +20m (T0 + 35m)
  await tokenkeeper.refreshDue(ctx, {
    nowMs: T0 + 15 * 60 * 1000,
    sleep: async function () {},
    fetch: always503,
    notify: (p) => alerts.push(p),
    run: () => ({ code: 0 }),
  });
  assert.strictEqual(fetchCalls, 9);
  assert.strictEqual(alerts.length, 1, 'alert emitted on 3rd consecutive transient failure');
  st = tokenkeeper.readRefreshState(ctx).yahoo;
  assert.strictEqual(st.consecutiveFailures, 3);
  assert.strictEqual(st.nextAttemptAt, new Date(T0 + 35 * 60 * 1000).toISOString());

  // Now simulate token ALREADY expired (expiresAt = T0 + 50m): at T0 + 51m, nextAttemptAt is
  // set to a future backoff (e.g. T0 + 90m), but once > 5m has elapsed since lastAttemptAt,
  // the expired token overrides the backoff!
  st.lastAttemptAt = new Date(T0 + 50 * 60 * 1000).toISOString();
  st.nextAttemptAt = new Date(T0 + 110 * 60 * 1000).toISOString(); // 60m backoff into the future
  tokenkeeper.writeRefreshState(ctx, { yahoo: st });

  // At T0 + 53m (only 3m since lastAttemptAt): still backed off
  await tokenkeeper.refreshDue(ctx, {
    nowMs: T0 + 53 * 60 * 1000,
    sleep: async function () {},
    fetch: always503,
    run: () => ({ code: 0 }),
  });
  assert.strictEqual(fetchCalls, 9, 'expired token still waits at least 5m since last attempt');

  // At T0 + 56m (6m since lastAttemptAt, token is expired, even though nextAttemptAt is T0 + 110m): overrides backoff!
  await tokenkeeper.refreshDue(ctx, {
    nowMs: T0 + 56 * 60 * 1000,
    sleep: async function () {},
    fetch: always503,
    run: () => ({ code: 0 }),
  });
  assert.strictEqual(fetchCalls, 12, 'expired token overrides nextAttemptAt backoff after 5 min');
});

// 8. setProfile throws twice then succeeds -> refreshed; always throws -> 'persist-failed' + alert.
test('8. setProfile throws twice then succeeds -> refreshed; always throws -> persist-failed + alert', async function () {
  const ctx = makeCtx();
  addSavedAccount(ctx, 'yahoo', 'yahoo@example.com', 'u-yahoo', makeBlob('yahoo-p1', T0 + 10 * 60 * 1000));
  addSavedAccount(ctx, 'gmail', 'gmail@example.com', 'u-gmail', makeBlob('gmail-live', T0 + 8 * 3600000));

  const realSetProfile = ctx.store.setProfile.bind(ctx.store);
  let writeAttempts = 0;
  ctx.store.setProfile = function (name, val) {
    if (name === 'yahoo') {
      writeAttempts += 1;
      if (writeAttempts <= 2) throw new Error('Keychain temporary error');
    }
    return realSetProfile(name, val);
  };

  const out1 = await tokenkeeper.refreshDue(ctx, {
    nowMs: T0,
    sleep: async function () {},
    persistRetryDelayMs: 0,
    fetch: async function () {
      return {
        ok: true,
        status: 200,
        json: async function () {
          return { access_token: 'AT-yahoo-saved', refresh_token: 'RT-yahoo-saved', expires_in: 28800 };
        },
      };
    },
  });
  assert.strictEqual(writeAttempts, 3, 'retried setProfile after 2 failures and succeeded on 3rd');
  assert.strictEqual(out1.results.find((r) => r.account === 'yahoo').status, 'refreshed');
  assert.strictEqual(JSON.parse(ctx.store.getProfile('yahoo')).claudeAiOauth.refreshToken, 'RT-yahoo-saved');

  // Now always throws -> 'persist-failed' + alert
  realSetProfile('yahoo', makeBlob('yahoo-p2', T0 + 10 * 60 * 1000));
  ctx.store.setProfile = function (name, val) {
    if (name === 'yahoo') throw new Error('Keychain locked permanently');
    return realSetProfile(name, val);
  };

  const alerts = [];
  const out2 = await tokenkeeper.refreshDue(ctx, {
    nowMs: T0 + 1000,
    sleep: async function () {},
    persistRetryDelayMs: 0,
    notify: (p) => alerts.push(p),
    run: () => ({ code: 0 }),
    fetch: async function () {
      return {
        ok: true,
        status: 200,
        json: async function () {
          return { access_token: 'AT-yahoo-lost', refresh_token: 'RT-yahoo-lost', expires_in: 28800 };
        },
      };
    },
  });
  assert.strictEqual(out2.ok, false);
  assert.strictEqual(out2.results.find((r) => r.account === 'yahoo').status, 'persist-failed');
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].result, 'persist-failed');
});

// 9. Lock busy -> 'busy', no fetch, no alert; lockHeld:true does not try to take the lock;
//    re-read after lock sees updated blob.
test('9. lock busy returns busy with no fetch and no alert; lockHeld:true skips acquiring lock; re-read after lock detects concurrent refresh', async function () {
  const ctx = makeCtx();
  addSavedAccount(ctx, 'yahoo', 'yahoo@example.com', 'u-yahoo', makeBlob('yahoo-lock', T0 + 10 * 60 * 1000));
  addSavedAccount(ctx, 'gmail', 'gmail@example.com', 'u-gmail', makeBlob('gmail-live', T0 + 8 * 3600000));

  // Hold the cross-process lock
  const lockHandle = await lock.acquire(ctx.configDir, { timeoutMs: 100 });
  let fetchCalled = 0;
  const alerts = [];
  try {
    const busyOut = await tokenkeeper.refreshDue(ctx, {
      nowMs: T0,
      lockTimeoutMs: 20,
      notify: (p) => alerts.push(p),
      fetch: async function () {
        fetchCalled += 1;
        throw new Error('must not fetch when lock is busy');
      },
    });
    assert.strictEqual(busyOut.ok, true, 'busy is not a failure');
    assert.strictEqual(busyOut.results.find((r) => r.account === 'yahoo').status, 'busy');
    assert.strictEqual(fetchCalled, 0);
    assert.strictEqual(alerts.length, 0);

    // With lockHeld: true while the lock is already held, it does NOT try to acquire the lock and succeeds!
    const heldLockOut = await tokenkeeper.refreshAccount(ctx, 'yahoo', {
      nowMs: T0,
      lockHeld: true,
      fetch: async function () {
        fetchCalled += 1;
        return {
          ok: true,
          status: 200,
          json: async function () {
            return { access_token: 'AT-yahoo-under-lock', refresh_token: 'RT-yahoo-under-lock', expires_in: 28800 };
          },
        };
      },
    });
    assert.strictEqual(heldLockOut.status, 'refreshed');
    assert.strictEqual(fetchCalled, 1);
  } finally {
    lockHandle.release();
  }

  // Test re-read after acquiring lock: if another process refreshed the blob before lock was acquired,
  // re-reading sees the fresh blob and does not call fetch.
  ctx.store.setProfile('yahoo', makeBlob('yahoo-due', T0 + 5 * 60 * 1000));
  let fetchAfterLock = 0;
  const rereadOut = await tokenkeeper.refreshAccount(ctx, 'yahoo', {
    nowMs: T0,
    acquireLock: function () {
      // Simulate concurrent process updating the profile right before we get the lock
      ctx.store.setProfile('yahoo', makeBlob('yahoo-already-refreshed', T0 + 7 * 3600 * 1000));
      return function () {};
    },
    fetch: async function () {
      fetchAfterLock += 1;
      throw new Error('should see fresh blob after lock re-read');
    },
  });
  assert.strictEqual(rereadOut.status, 'fresh');
  assert.strictEqual(fetchAfterLock, 0);
});

// 10. No token string ('AT-', 'RT-' fixture values) ever appears in refresh-state.json,
//     in captured stdout/stderr of a spawned `keyflip refresh --all --json` / `keyflip list --json` /
//     `keyflip status --json`, or in notification text.
test('10. no token string (AT-*, RT-*) ever appears in refresh-state.json, CLI JSON outputs, or notifications', async function () {
  const ctx = makeCtx();
  const h = ctx.home;
  const cfgDir = path.join(h, '.config', 'keyflip');
  fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
  fs.mkdirSync(cfgDir, { recursive: true });

  const runCli = function (args) {
    return spawnSync(process.execPath, [BIN].concat(args), {
      encoding: 'utf8',
      env: Object.assign({}, process.env, {
        HOME: h,
        USERPROFILE: h,
        XDG_CONFIG_HOME: path.join(h, '.config'),
        KEYFLIP_CONFIG_DIR: cfgDir,
        KEYFLIP_TEST_CLAUDE: 'running',
        KEYFLIP_TEST_OFFLINE: '1',
        KEYFLIP_APP_BUNDLE: path.join(h, 'no-such-Claude.app'),
      }),
    });
  };
  const writeLive = function (email, uid, b) {
    fs.writeFileSync(path.join(h, '.claude', '.credentials.json'), b);
    fs.writeFileSync(
      path.join(h, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: email }, userID: uid }),
    );
  };

  writeLive('yahoo@example.com', 'u-y', makeBlob('SECRET-YAHOO-1', Date.now() + 3 * 3600000));
  assert.strictEqual(runCli(['add', 'yahoo']).status, 0);
  writeLive('gmail@example.com', 'u-g', makeBlob('SECRET-GMAIL-1', Date.now() + 3 * 3600000));
  assert.strictEqual(runCli(['add', 'gmail']).status, 0);

  // Trigger a failure alert with token strings embedded in server error to verify sanitization
  const alerts = [];
  const runnerCmds = [];
  addSavedAccount(ctx, 'yahoo', 'yahoo@example.com', 'u-y', makeBlob('SECRET-YAHOO-2', T0 - 1000));
  addSavedAccount(ctx, 'gmail', 'gmail@example.com', 'u-g', makeBlob('SECRET-GMAIL-2', T0 + 3600000));
  await tokenkeeper.refreshDue(ctx, {
    nowMs: T0,
    notify: (p) => alerts.push(p),
    run: (cmd, args) => {
      runnerCmds.push({ cmd, args });
      return { code: 0 };
    },
    fetch: async function () {
      return {
        ok: false,
        status: 400,
        json: async function () {
          return { error: 'invalid_grant AT-SECRET-YAHOO-2 RT-SECRET-YAHOO-2' };
        },
      };
    },
  });

  const stateRaw = fs.readFileSync(tokenkeeper.refreshStatePath(ctx), 'utf8');
  // Copy refresh-state.json into the spawned CLI's configDir as well so status/list/refresh read it
  fs.writeFileSync(path.join(cfgDir, 'refresh-state.json'), stateRaw, { mode: 0o600 });

  const rRefresh = runCli(['refresh', '--all', '--json']);
  const rList = runCli(['list', '--json']);
  const rStatus = runCli(['status', '--json']);

  const combined = [
    stateRaw,
    rRefresh.stdout,
    rRefresh.stderr,
    rList.stdout,
    rList.stderr,
    rStatus.stdout,
    rStatus.stderr,
    JSON.stringify(alerts),
    JSON.stringify(runnerCmds),
  ].join('\n');

  assert.strictEqual(/AT-[A-Za-z0-9_-]+/.test(combined), false, 'no AT-* token string leaked anywhere');
  assert.strictEqual(/RT-[A-Za-z0-9_-]+/.test(combined), false, 'no RT-* token string leaked anywhere');
});

// 11. Schedule: old nightly plist + old record -> status.outdated true, doctor warns;
//     after schedule.install(ctx, { job: 'refresh' }) with injected runner -> outdated false,
//     plist has StartInterval 900 and RunAtLoad true, and runner saw launchctl unload then launchctl load;
//     cron line is */15; doctor flags stale/dead.
test('11. outdated nightly plist + record flagged by schedule.status and doctor; schedule.install upgrades to StartInterval 900 + RunAtLoad true with unload then load', async function () {
  const ctx = makeCtx({ platform: 'darwin' });
  const home = ctx.home;
  const rec = [];
  const cronState = { text: '' };
  const runner = function (cmd, args, input) {
    rec.push({ cmd, args, input });
    if (cmd === 'which') return { code: 0, stdout: '/usr/local/bin/keyflip\n' };
    if (cmd === 'crontab' && args[0] === '-l') return { code: 0, stdout: cronState.text };
    if (cmd === 'crontab' && args[0] === '-') {
      cronState.text = input;
      return { code: 0 };
    }
    if (cmd === 'launchctl' && args[0] === 'list') {
      return { code: 0, stdout: '"Label" = "com.keyflip.refresh";\n' };
    }
    return { code: 0, stdout: '' };
  };
  ctx.run = runner;

  profiles.write(ctx.configDir, { name: 'yahoo', email: 'yahoo@example.com' });

  // Pre-seed an old nightly plist with StartCalendarInterval + old refresh-schedule.json with `at` and no `interval`
  const pPath = schedule.plistPath(home, { job: 'refresh' });
  fs.mkdirSync(path.dirname(pPath), { recursive: true });
  fs.writeFileSync(
    pPath,
    '<plist><dict><key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer></dict><key>RunAtLoad</key><false/></dict></plist>',
  );
  schedule.writeRecord(
    ctx,
    { installedAt: '2026-01-01T00:00:00.000Z', job: 'refresh', kind: 'launchd', at: { h: 4, m: 30 } },
    { job: 'refresh' },
  );

  // Before install: status.outdated is true, interval is null, and doctor warns about old nightly schedule
  const stBefore = schedule.status(ctx, { job: 'refresh' });
  assert.strictEqual(stBefore.outdated, true, 'old nightly plist + record reported as outdated');
  assert.strictEqual(stBefore.interval, null, 'never claims 15 min when outdated');

  const diagOld = await doctor.diagnose(ctx);
  const rowOld = diagOld.checks.find((c) => c.name === 'token renewal');
  assert.ok(rowOld);
  assert.strictEqual(rowOld.ok, 'warn');
  assert.strictEqual(rowOld.detail, 'refresh job is the old nightly schedule (tokens live ~8 h)');
  assert.strictEqual(rowOld.fix, 'keyflip refresh --schedule -y');

  // Install new refresh schedule with injected runner
  rec.length = 0;
  const inst = schedule.install(ctx, { job: 'refresh', run: runner });
  assert.strictEqual(inst.ok, true);
  assert.strictEqual(inst.interval, 15);

  const launchctlCalls = rec.filter((c) => c.cmd === 'launchctl');
  assert.strictEqual(launchctlCalls.length, 2, 'runner saw two launchctl calls');
  assert.deepStrictEqual(launchctlCalls[0].args, ['unload', pPath], 'first launchctl unload');
  assert.deepStrictEqual(launchctlCalls[1].args, ['load', pPath], 'then launchctl load');

  const stAfter = schedule.status(ctx, { job: 'refresh' });
  assert.strictEqual(stAfter.outdated, false, 'outdated is false after install');
  assert.strictEqual(stAfter.interval, 15, 'interval is 15 after install');

  const plist = fs.readFileSync(pPath, 'utf8');
  assert.ok(plist.indexOf('<key>StartInterval</key>\n    <integer>900</integer>') !== -1, 'StartInterval is 900s');
  assert.ok(plist.indexOf('<key>RunAtLoad</key><true/>') !== -1, 'RunAtLoad is true');
  assert.strictEqual(plist.indexOf('StartCalendarInterval'), -1, 'old nightly StartCalendarInterval removed');
  assert.ok(plist.indexOf('<string>--due</string>') !== -1, 'runs refresh --all --due');

  const cLine = schedule.cronLine({ job: 'refresh', run: runner });
  assert.ok(/^\*\/15 \* \* \* \* /.test(cLine), 'cron line starts with */15 * * * *: ' + cLine);
  assert.ok(/refresh --all --due/.test(cLine), 'cron line runs refresh --all --due');

  // Doctor checks: stale (>1h) and dead account
  tokenkeeper.writeRefreshState(ctx, {
    _meta: { lastRunAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString() },
    yahoo: {
      lastAttemptAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      lastResult: 'dead',
      lastError: 'invalid_grant',
    },
  });
  const diag = await doctor.diagnose(ctx);
  const row = diag.checks.find((c) => c.name === 'token renewal');
  assert.ok(row);
  assert.strictEqual(row.ok, false, 'dead account makes token renewal check fail');
  assert.match(row.detail, /yahoo refresh dead/);
});

// 12. list/status rendering shows the expiry and last result lines above.
test('12. formatTokenStatusLine renders valid OAuth, expired failed OAuth, and long-lived tokens', function () {
  const nowMs = Date.parse('2026-11-13T11:44:00.000Z');

  // 1) Active/valid OAuth token with recent refresh
  const okLine = tokenkeeper.formatTokenStatusLine(
    {
      account: 'yahoo',
      tokenKind: 'oauth',
      tokenExpiresAtMs: Date.parse('2026-11-13T18:42:00.000Z'),
      lastRefresh: {
        at: '2026-11-13T11:44:00.000Z',
        result: 'refreshed',
        error: null,
      },
    },
    { nowMs: nowMs, utc: true },
  );
  assert.strictEqual(okLine, 'token: expires 18:42 (in 6h58m) · refreshed 11:44 ✓');

  // 2) Expired OAuth token with dead refresh token
  const deadLine = tokenkeeper.formatTokenStatusLine(
    {
      account: 'yahoo',
      tokenKind: 'oauth',
      tokenExpiresAtMs: Date.parse('2026-11-13T08:44:00.000Z'),
      lastRefresh: {
        at: '2026-11-13T11:44:00.000Z',
        result: 'dead',
        error: 'invalid_grant',
      },
    },
    { nowMs: nowMs, utc: true },
  );
  assert.strictEqual(
    deadLine,
    'token: EXPIRED 3h ago · refresh failed 11:44 (refresh token rejected) — run: keyflip login yahoo',
  );

  // 3) Long-lived token
  const llLine = tokenkeeper.formatTokenStatusLine(
    {
      account: 'hakkisagdic',
      tokenKind: 'long-lived',
      tokenExpiresAtMs: Date.parse('2027-10-18T00:00:00.000Z'),
      lastRefresh: { at: null, result: null, error: null },
    },
    { nowMs: nowMs, utc: true },
  );
  assert.strictEqual(llLine, 'token: long-lived until 2027-10-18 · no refresh needed');
});

// 13. Usage: inactive account 401 + expired blob with refresh token -> core called once with refreshFetch
//     (never the usage fetch), usage retried, status ok.
test('13. usageForProfiles refreshes an expired non-live account on 401 once via refreshAccount/refreshFetch and retries usage read', async function () {
  const ctx = makeCtx();
  addSavedAccount(ctx, 'yahoo', 'yahoo@example.com', 'u-yahoo', makeBlob('yahoo-expired', T0 - 60000));
  addSavedAccount(ctx, 'gmail', 'gmail@example.com', 'u-gmail', makeBlob('gmail-live', T0 + 8 * 3600000));

  let tokenFetchCalls = 0;
  let usageFetchCalls = 0;
  const refreshFetch = async function (url, init) {
    tokenFetchCalls += 1;
    assert.strictEqual(url, tokenkeeper.OAUTH_TOKEN_URL);
    assert.strictEqual(JSON.parse(init.body).refresh_token, 'RT-yahoo-expired');
    return {
      ok: true,
      status: 200,
      json: async function () {
        return {
          access_token: 'AT-yahoo-fresh',
          refresh_token: 'RT-yahoo-fresh',
          expires_in: 28800,
        };
      },
    };
  };

  const res = await usage.usageForProfiles(ctx, ['yahoo'], {
    liveFor: 'gmail',
    nowMs: T0,
    refreshFetch: refreshFetch,
    fetch: async function (url, init) {
      assert.strictEqual(url, usage.USAGE_URL, 'usage fetch must never be called for the token endpoint');
      usageFetchCalls += 1;
      const auth = init && init.headers && init.headers.Authorization;
      if (auth === 'Bearer AT-yahoo-expired') {
        return { status: 401, ok: false, headers: { get: () => null }, json: async () => ({}) };
      }
      if (auth === 'Bearer AT-yahoo-fresh') {
        return {
          status: 200,
          ok: true,
          headers: { get: () => null },
          json: async () => ({
            five_hour: { utilization: 22, resets_at: '2026-11-13T16:00:00Z' },
            seven_day: { utilization: 40, resets_at: '2026-11-18T00:00:00Z' },
          }),
        };
      }
      throw new Error('unexpected Authorization header: ' + auth);
    },
  });

  assert.strictEqual(tokenFetchCalls, 1, 'token endpoint called once via default refreshAccount + refreshFetch');
  assert.strictEqual(usageFetchCalls, 2, 'usage endpoint called twice (initial 401 + retry 200)');
  assert.strictEqual(res.yahoo.status, 'ok');
  assert.strictEqual(res.yahoo.usage.fiveHour.pct, 22);
});

// 14. MCP keyflip_refresh refreshes the non-held account while isClaudeRunning would be true.
test('14. MCP keyflip_refresh refreshes the non-held account even while Claude is running', async function () {
  const prevEnv = process.env.KEYFLIP_TEST_CLAUDE;
  process.env.KEYFLIP_TEST_CLAUDE = 'running';
  try {
    const ctx = makeCtx();
    addSavedAccount(ctx, 'yahoo', 'yahoo@example.com', 'u-yahoo', makeBlob('yahoo-due', Date.now() + 20 * 60 * 1000));
    addSavedAccount(ctx, 'gmail', 'gmail@example.com', 'u-gmail', makeBlob('gmail-live', Date.now() + 8 * 3600000));

    let fetchCalls = 0;
    ctx.fetch = async function () {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async function () {
          return { access_token: 'AT-yahoo-mcp-new', refresh_token: 'RT-yahoo-mcp-new', expires_in: 28800 };
        },
      };
    };

    const tool = mcp.TOOLS.find((t) => t.name === 'keyflip_refresh');
    assert.ok(tool);
    const out = await tool.run(ctx, { all: true, confirm: true });
    assert.strictEqual(fetchCalls, 1);
    const yahooEntry = out.refreshed.find((r) => r.account === 'yahoo');
    const gmailEntry = out.refreshed.find((r) => r.account === 'gmail');
    assert.strictEqual(yahooEntry.status, 'refreshed');
    assert.strictEqual(gmailEntry.status, 'held');
    assert.deepStrictEqual(out.heldBack, ['gmail']);
  } finally {
    if (prevEnv === undefined) delete process.env.KEYFLIP_TEST_CLAUDE;
    else process.env.KEYFLIP_TEST_CLAUDE = prevEnv;
  }
});

// 15. H1: src/log.js initialised with a temp config dir records account name + result + httpStatus
//     to keyflip.log (never "[object Object]" and never any AT-/RT- fixture value).
test('15. keyflip.log records oauth refresh attempts and results with no AT-/RT- fixture values', async function () {
  const ctx = makeCtx();
  logmod.init(ctx.configDir);

  addSavedAccount(ctx, 'yahoo', 'yahoo@example.com', 'u-yahoo', makeBlob('yahoo-log-1', T0 + 20 * 60 * 1000));
  addSavedAccount(ctx, 'deadacct', 'dead@example.com', 'u-dead', makeBlob('dead-log-1', T0 - 60000));
  addSavedAccount(ctx, 'gmail', 'gmail@example.com', 'u-gmail', makeBlob('gmail-log-live', T0 + 8 * 3600000));

  await tokenkeeper.refreshDue(ctx, {
    nowMs: T0,
    sleep: async function () {},
    notify: function () {},
    fetch: async function (_url, init) {
      const rt = JSON.parse(init.body).refresh_token;
      if (rt === 'RT-yahoo-log-1') {
        return {
          ok: true,
          status: 200,
          json: async function () {
            return { access_token: 'AT-yahoo-log-2', refresh_token: 'RT-yahoo-log-2', expires_in: 28800 };
          },
        };
      }
      return {
        ok: false,
        status: 400,
        json: async function () {
          return { error: 'invalid_grant', error_description: 'revoked AT-dead-log-1 RT-dead-log-1' };
        },
      };
    },
  });

  const logFile = path.join(ctx.configDir, 'logs', 'keyflip.log');
  const logText = fs.readFileSync(logFile, 'utf8');
  assert.ok(logText.indexOf('oauth refresh yahoo: refreshed') !== -1, 'logs refreshed account: ' + logText);
  assert.ok(
    logText.indexOf('oauth refresh deadacct: dead httpStatus=400') !== -1,
    'logs dead account with httpStatus=400: ' + logText,
  );
  assert.strictEqual(logText.indexOf('[object Object]'), -1, 'never logs [object Object]');
  assert.strictEqual(/AT-[A-Za-z0-9_-]+/.test(logText), false, 'no AT-* fixture token in keyflip.log');
  assert.strictEqual(/RT-[A-Za-z0-9_-]+/.test(logText), false, 'no RT-* fixture token in keyflip.log');
});
