import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { makeCtx, writeClaude, assertPrivateMode } from './helpers.js';
import * as limitsignal from '../src/limitsignal.js';
import * as livesince from '../src/livesince.js';
import * as autosw from '../src/autoswitch.js';
import * as failover from '../src/failover.js';
import * as core from '../src/core.js';
import * as breaker from '../src/breaker.js';
import * as backup from '../src/backup.js';
import * as vcs from '../src/vcs.js';
import * as mcp from '../src/mcp.js';
import * as logmod from '../src/log.js';
import { formatAutoswitchTickLine, cmdAutoswitch } from '../src/cli.js';

function login(ctx, email, uid, tok, org) {
  const oa = { emailAddress: email };
  if (org) oa.organizationUuid = org;
  writeClaude(ctx, { oauthAccount: oa, userID: uid });
  ctx.store.setLive(JSON.stringify({ claudeAiOauth: { accessToken: tok } }));
}

function writeTranscript(ctx, projSlug, fileName, lines, mtimeMs) {
  const dir = path.join(ctx.claudeDir, 'projects', projSlug);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, fileName);
  const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
  fs.writeFileSync(fp, body, 'utf8');
  if (mtimeMs !== undefined) {
    const d = new Date(mtimeMs);
    fs.utimesSync(fp, d, d);
  }
  return fp;
}

function sampleQuotaLimitsLine(overrides) {
  return Object.assign(
    {
      type: 'assistant',
      timestamp: '2026-11-12T10:00:45.961Z',
      sessionId: 'sess-1',
      entrypoint: 'claude-desktop',
      version: '2.1.321',
      isApiErrorMessage: true,
      error: 'rate_limit',
      apiErrorStatus: 429,
      apiError: 'usage_limit_reached',
      apiErrorParams: {
        rate_limit_info: {
          status: 'rejected',
          resetsAt: 1794808800, // 2026-11-16T06:00:00.000Z (Nov 16 9am Europe/Istanbul)
          rateLimitType: 'seven_day',
          overageStatus: 'rejected',
          isUsingOverage: false,
        },
      },
      quotaLimits: {
        status: 'rejected',
        resetsAt: 1794808800,
        rateLimitType: 'seven_day',
        unifiedRateLimitFallbackAvailable: false,
        overageStatus: 'rejected',
        isUsingOverage: false,
      },
      message: {
        model: '<synthetic>',
        role: 'assistant',
        content: [{ type: 'text', text: "You've hit your weekly limit · resets Nov 16 at 9am (Europe/Istanbul)" }],
      },
    },
    overrides || {},
  );
}

test('1. limitsignal: finds quotaLimits line; ignores non-rate-limit, old lines, .live-since.json, past resetsAt, old mtime; never returns text', function () {
  const ctx = makeCtx();
  login(ctx, 'work@x.com', 'u1', 'AT-work', 'org-work');
  core.addCurrent(ctx);

  const nowMs = Date.parse('2026-11-12T10:05:00.000Z');
  writeTranscript(
    ctx,
    'proj-a',
    's1.jsonl',
    [
      { type: 'user', timestamp: '2026-11-12T10:00:00.000Z', message: { content: 'hello' } },
      sampleQuotaLimitsLine({
        timestamp: '2026-11-12T10:01:00.000Z',
        error: 'authentication_failed',
        apiError: 'invalid_token',
        apiErrorStatus: 401,
        quotaLimits: undefined,
        apiErrorParams: undefined,
      }),
      sampleQuotaLimitsLine({
        timestamp: '2026-11-12T10:02:00.000Z',
        error: 'server_error',
        apiError: 'internal_error',
        apiErrorStatus: 500,
        quotaLimits: undefined,
        apiErrorParams: undefined,
      }),
      sampleQuotaLimitsLine(),
    ],
    nowMs - 10 * 1000,
  );

  const hit = limitsignal.recentLimitHit(ctx, { nowMs });
  assert.ok(hit, 'should find the qualifying rate_limit line');
  assert.deepStrictEqual(hit, {
    at: '2026-11-12T10:00:45.961Z',
    resetsAt: new Date(1794808800 * 1000).toISOString(),
    kind: 'seven_day',
    entrypoint: 'claude-desktop',
    source: 'quotaLimits',
  });
  assert.strictEqual('text' in hit, false, 'must never return message text');
  assert.strictEqual('message' in hit, false, 'must never return message object');

  // Line older than the 15-min window is ignored
  const afterWindowMs = Date.parse('2026-11-12T10:20:00.000Z');
  assert.strictEqual(limitsignal.recentLimitHit(ctx, { nowMs: afterWindowMs }), null);

  // File whose mtime is outside the window is skipped even if a line inside has a recent timestamp
  const ctxOldMtime = makeCtx();
  writeTranscript(ctxOldMtime, 'proj-a', 's1.jsonl', [sampleQuotaLimitsLine()], nowMs - 20 * 60 * 1000);
  assert.strictEqual(limitsignal.recentLimitHit(ctxOldMtime, { nowMs }), null);

  // Line whose resetsAt is already in the past is ignored
  const ctxPastReset = makeCtx();
  writeTranscript(
    ctxPastReset,
    'proj-a',
    's1.jsonl',
    [
      sampleQuotaLimitsLine({
        quotaLimits: {
          status: 'rejected',
          resetsAt: Math.floor((nowMs - 60 * 1000) / 1000),
          rateLimitType: 'five_hour',
        },
      }),
    ],
    nowMs,
  );
  assert.strictEqual(limitsignal.recentLimitHit(ctxPastReset, { nowMs }), null);

  // Line older than .live-since.json is ignored
  livesince.writeLiveSince(ctx, { nowMs: Date.parse('2026-11-12T10:01:00.000Z') });
  assertPrivateMode(livesince.liveSincePath(ctx), '.live-since.json must be 0600');
  assert.strictEqual(limitsignal.recentLimitHit(ctx, { nowMs }), null);

  // core.performSwitch writes .live-since.json
  login(ctx, 'second@x.com', 'u2', 'AT-second', 'org-second');
  core.addCurrent(ctx);
  core.performSwitch(ctx, 'work', { reason: 'test-switch', nowMs: nowMs + 1000 });
  assert.strictEqual(livesince.readLiveSince(ctx), nowMs + 1000, 'core.performSwitch must write .live-since.json');

  // > 256 KB transcript: line before the last 256 KB is ignored; line inside the last 256 KB is found
  const ctxTail = makeCtx();
  const fillerLine = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(1024) } });
  const fillerLines = Array.from({ length: 280 }, () => fillerLine);
  writeTranscript(
    ctxTail,
    'proj-tail',
    'huge.jsonl',
    [sampleQuotaLimitsLine({ timestamp: '2026-11-12T10:03:00.000Z' }), ...fillerLines],
    nowMs,
  );
  assert.strictEqual(limitsignal.recentLimitHit(ctxTail, { nowMs }), null, 'line beyond 256 KB tail is not read');
  writeTranscript(
    ctxTail,
    'proj-tail',
    'huge.jsonl',
    [...fillerLines, sampleQuotaLimitsLine({ timestamp: '2026-11-12T10:03:00.000Z' })],
    nowMs,
  );
  assert.strictEqual(limitsignal.recentLimitHit(ctxTail, { nowMs }).at, '2026-11-12T10:03:00.000Z');
});

test('1b. limitsignal: parses text-only forms with Intl in IANA timezone and desktop account attribution', function () {
  const ctx = makeCtx();
  login(ctx, 'work@x.com', 'u1', 'AT-work', 'org-work');
  core.addCurrent(ctx); // saved as 'work'
  login(ctx, 'personal@x.com', 'u2', 'AT-personal', 'org-personal');
  core.addCurrent(ctx); // saved as 'personal' (now active)

  const nowMs = Date.parse('2026-11-12T10:05:00.000Z');

  // 1) "resets 3pm (Europe/Istanbul)" on 2026-11-12T10:00:45.961Z (13:00:45 Istanbul, UTC+3)
  // -> 2026-11-12 15:00 Europe/Istanbul = 2026-11-12T12:00:00.000Z
  writeTranscript(
    ctx,
    'proj-text',
    't1.jsonl',
    [
      {
        type: 'assistant',
        timestamp: '2026-11-12T10:00:45.961Z',
        entrypoint: 'cli',
        isApiErrorMessage: true,
        error: 'rate_limit',
        message: {
          content: [{ type: 'text', text: "You've hit your session limit · resets 3pm (Europe/Istanbul)" }],
        },
      },
    ],
    nowMs,
  );
  const hitSession = limitsignal.recentLimitHit(ctx, { nowMs });
  assert.deepStrictEqual(hitSession, {
    at: '2026-11-12T10:00:45.961Z',
    resetsAt: '2026-11-12T12:00:00.000Z',
    kind: 'five_hour',
    entrypoint: 'cli',
    source: 'text',
  });

  // Also check 3:30pm and Nov 16 at 9am directly via parseResetText and recentLimitHit
  const lineMs = Date.parse('2026-11-12T10:00:45.961Z');
  assert.strictEqual(limitsignal.parseResetText('resets 3:30pm (Europe/Istanbul)', lineMs), '2026-11-12T12:30:00.000Z');
  assert.strictEqual(
    limitsignal.parseResetText("You've hit your weekly limit · resets Nov 16 at 9am (Europe/Istanbul)", lineMs),
    '2026-11-16T06:00:00.000Z',
  );

  // 2) Newer line with "resets Nov 16 at 9am (Europe/Istanbul)" and entrypoint claude-desktop
  writeTranscript(
    ctx,
    'proj-text',
    't2.jsonl',
    [
      {
        type: 'assistant',
        timestamp: '2026-11-12T10:02:00.000Z',
        entrypoint: 'claude-desktop',
        isApiErrorMessage: true,
        error: 'rate_limit',
        message: {
          content: [{ type: 'text', text: "You've hit your weekly limit · resets Nov 16 at 9am (Europe/Istanbul)" }],
        },
      },
    ],
    nowMs,
  );

  // When desktop app is on a DIFFERENT account ('work') than active CLI ('personal'), the claude-desktop line is ignored
  // and recentLimitHit falls back to the CLI line in t1.jsonl!
  const hitDiffApp = limitsignal.recentLimitHit(ctx, {
    nowMs,
    appAccount: () => 'work',
  });
  assert.strictEqual(hitDiffApp.entrypoint, 'cli');
  assert.strictEqual(hitDiffApp.kind, 'five_hour');

  // When desktop app is on the SAME account ('personal') or unknown (null), the newer claude-desktop line wins
  const hitSameApp = limitsignal.recentLimitHit(ctx, {
    nowMs,
    appAccount: () => 'personal',
  });
  assert.deepStrictEqual(hitSameApp, {
    at: '2026-11-12T10:02:00.000Z',
    resetsAt: '2026-11-16T06:00:00.000Z',
    kind: 'seven_day',
    entrypoint: 'claude-desktop',
    source: 'text',
  });
  const hitUnknownApp = limitsignal.recentLimitHit(ctx, {
    nowMs,
    appAccount: () => null,
  });
  assert.strictEqual(hitUnknownApp.at, '2026-11-12T10:02:00.000Z');

  // Also check backup & vcs exclusion of .live-since.json
  assert.strictEqual(backup.VOLATILE_FILE ? backup.VOLATILE_FILE.test('.live-since.json') : true, true);
  assert.ok(vcs.GITIGNORE.includes('.live-since.json'), '.live-since.json must be in vcs.GITIGNORE');
});

function usageFetchBy(byTok) {
  return async (url, opts) => {
    const tok = opts.headers.Authorization.replace('Bearer ', '');
    const v = byTok[tok];
    if (v === 429 || v === 401 || v === undefined) {
      return {
        ok: false,
        status: v === undefined ? 401 : v,
        headers: { get: (h) => (h === 'retry-after' ? '3600' : null) },
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ five_hour: { utilization: v, resets_at: '2026-11-12T15:00:00Z' } }),
    };
  };
}

function fakeFailover() {
  const st = { engaged: null, log: [], lastEngage: null, lastRelease: null };
  return {
    st,
    api: {
      state: () => st.engaged,
      engage: async (info) => {
        st.lastEngage = info;
        st.log.push('engage:' + info.from);
        st.engaged = {
          engaged: true,
          from: info.from,
          reason: info.reason,
          recoverAt: info.recoverAt || null,
          manual: !!info.manual,
        };
        return { ok: true, state: st.engaged };
      },
      release: async (info) => {
        st.lastRelease = info;
        st.log.push('release:' + info.to);
        st.engaged = null;
        return { ok: true };
      },
    },
  };
}

test('2. tick: usage unknown (throttled) + hit -> switches to candidate with headroom, or engages failover when none has headroom; no hit -> unknown', async function () {
  const nowMs = Date.parse('2026-11-12T10:01:12.000Z');

  // Case A: usage unknown (429) + hit + another account (yahoo) with headroom -> switched to yahoo
  const ctx1 = makeCtx();
  login(ctx1, 'yahoo@x.com', 'u1', 'AT-yahoo');
  core.addCurrent(ctx1);
  login(ctx1, 'gmail@x.com', 'u2', 'AT-gmail');
  core.addCurrent(ctx1); // gmail is active
  writeTranscript(ctx1, 'proj-1', 's1.jsonl', [sampleQuotaLimitsLine()], nowMs);

  const fo1 = fakeFailover();
  const rSwitch = await autosw.tick(ctx1, {
    threshold: 95,
    fetch: usageFetchBy({ 'AT-gmail': 429, 'AT-yahoo': 30 }),
    nowMs,
    cacheTtlMs: 0,
    failover: fo1.api,
  });
  assert.strictEqual(rSwitch.state, 'switched');
  assert.strictEqual(rSwitch.basis, 'limit-signal');
  assert.strictEqual(rSwitch.switchedTo.name, 'yahoo');
  assert.ok(rSwitch.limitHit);
  assert.strictEqual(rSwitch.limitHit.kind, 'seven_day');
  assert.deepStrictEqual(fo1.st.log, [], 'failover not engaged when another account had headroom');
  assert.strictEqual(
    breaker.cooldownOf(ctx1, 'gmail', { nowMs: nowMs + 1000 }).active,
    true,
    'exhausted active account placed in quota cooldown until resetsAt',
  );

  // Case B: usage unknown (429) + hit + no candidate with headroom -> failover.engage called once with recoverAt = resetsAt
  const ctx2 = makeCtx();
  login(ctx2, 'yahoo@x.com', 'u1', 'AT-yahoo');
  core.addCurrent(ctx2);
  login(ctx2, 'gmail@x.com', 'u2', 'AT-gmail');
  core.addCurrent(ctx2);
  writeTranscript(ctx2, 'proj-1', 's1.jsonl', [sampleQuotaLimitsLine()], nowMs);

  const fo2 = fakeFailover();
  const rEngage = await autosw.tick(ctx2, {
    threshold: 95,
    fetch: usageFetchBy({ 'AT-gmail': 429, 'AT-yahoo': 98 }),
    nowMs,
    timeZone: 'Europe/Istanbul',
    cacheTtlMs: 0,
    failover: fo2.api,
  });
  assert.strictEqual(rEngage.state, 'failover-engaged');
  assert.strictEqual(rEngage.basis, 'limit-signal');
  assert.deepStrictEqual(fo2.st.log, ['engage:gmail']);
  assert.strictEqual(fo2.st.lastEngage.recoverAt, new Date(1794808800 * 1000).toISOString());
  assert.strictEqual(
    fo2.st.lastEngage.reason,
    'Claude Code hit the weekly limit at 13:00 (resets Nov 16 09:00) and no other account has headroom',
  );

  // Case B2: candidate whose usage is unknown (429) must NOT be chosen on the strength of the limit signal alone
  const ctx2b = makeCtx();
  login(ctx2b, 'yahoo@x.com', 'u1', 'AT-yahoo');
  core.addCurrent(ctx2b);
  login(ctx2b, 'gmail@x.com', 'u2', 'AT-gmail');
  core.addCurrent(ctx2b);
  writeTranscript(ctx2b, 'proj-1', 's1.jsonl', [sampleQuotaLimitsLine()], nowMs);
  const fo2b = fakeFailover();
  const rUnknownCand = await autosw.tick(ctx2b, {
    threshold: 95,
    fetch: usageFetchBy({ 'AT-gmail': 429, 'AT-yahoo': 429 }),
    nowMs,
    cacheTtlMs: 0,
    failover: fo2b.api,
  });
  assert.strictEqual(rUnknownCand.state, 'no-candidate');
  assert.strictEqual(rUnknownCand.switchedTo, null);
  assert.deepStrictEqual(rUnknownCand.unknownCandidates, ['yahoo']);

  // Case C: usage unknown (429) + no hit -> 'unknown', engage not called
  const ctx3 = makeCtx();
  login(ctx3, 'gmail@x.com', 'u2', 'AT-gmail');
  core.addCurrent(ctx3);
  const fo3 = fakeFailover();
  const rUnknown = await autosw.tick(ctx3, {
    threshold: 95,
    fetch: usageFetchBy({ 'AT-gmail': 429 }),
    nowMs,
    cacheTtlMs: 0,
    failover: fo3.api,
  });
  assert.strictEqual(rUnknown.state, 'unknown');
  assert.deepStrictEqual(fo3.st.log, []);
});

test('2b. H4: a fresh reading below the threshold overrules the limit signal and logs one line; a reading >= threshold or from last-good cache does not', async function () {
  const nowMs = Date.parse('2026-11-12T10:01:12.000Z');

  // Outcome 1: fresh reading (status: 'ok', basis: 'live') has seven_day = 24% (< 95%) -> ignore hit and log
  const ctxFresh = makeCtx();
  logmod.init(ctxFresh.configDir, false);
  login(ctxFresh, 'yahoo@x.com', 'u1', 'AT-yahoo');
  core.addCurrent(ctxFresh);
  login(ctxFresh, 'gmail@x.com', 'u2', 'AT-gmail');
  core.addCurrent(ctxFresh); // gmail is active
  writeTranscript(ctxFresh, 'proj-1', 's1.jsonl', [sampleQuotaLimitsLine()], nowMs);

  const rIgnored = await autosw.tick(ctxFresh, {
    threshold: 95,
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        five_hour: { utilization: 10, resets_at: '2026-11-12T15:00:00Z' },
        seven_day: { utilization: 24, resets_at: '2026-11-16T06:00:00Z' },
      }),
    }),
    nowMs,
    cacheTtlMs: 0,
  });
  assert.strictEqual(rIgnored.state, 'below');
  assert.strictEqual(rIgnored.switchedTo, null);
  assert.strictEqual(rIgnored.limitHit, undefined);
  assert.strictEqual(rIgnored.limitSignalIgnored, 'limit signal ignored: a fresh reading shows 24% (seven_day)');
  const logRaw = fs.readFileSync(path.join(ctxFresh.configDir, 'logs', 'keyflip.log'), 'utf8');
  assert.ok(
    logRaw.includes('limit signal ignored: a fresh reading shows 24% (seven_day)'),
    'must log the ignored limit signal line',
  );

  // Outcome 2a: fresh reading shows seven_day = 100% (>= 95%) -> hit is NOT ignored
  const ctxOver = makeCtx();
  login(ctxOver, 'yahoo@x.com', 'u1', 'AT-yahoo');
  core.addCurrent(ctxOver);
  login(ctxOver, 'gmail@x.com', 'u2', 'AT-gmail');
  core.addCurrent(ctxOver);
  writeTranscript(ctxOver, 'proj-1', 's1.jsonl', [sampleQuotaLimitsLine()], nowMs);

  const rHonoured = await autosw.tick(ctxOver, {
    threshold: 95,
    fetch: async (url, opts) => {
      const tok = opts.headers.Authorization.replace('Bearer ', '');
      const pct = tok === 'AT-gmail' ? 100 : 20;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          five_hour: { utilization: 10, resets_at: '2026-11-12T15:00:00Z' },
          seven_day: { utilization: pct, resets_at: '2026-11-16T06:00:00Z' },
        }),
      };
    },
    nowMs,
    cacheTtlMs: 0,
  });
  assert.strictEqual(rHonoured.state, 'switched');
  assert.strictEqual(rHonoured.switchedTo.name, 'yahoo');
  assert.strictEqual(rHonoured.basis, 'limit-signal');
  assert.strictEqual(rHonoured.limitSignalIgnored, undefined);

  // Outcome 2b: throttled reading served from a last-good cache (not fresh) -> hit is NOT ignored
  const ctxStale = makeCtx();
  login(ctxStale, 'yahoo@x.com', 'u1', 'AT-yahoo');
  core.addCurrent(ctxStale);
  login(ctxStale, 'gmail@x.com', 'u2', 'AT-gmail');
  core.addCurrent(ctxStale);
  // Seed a last-good reading 60s before the hit
  await autosw.tick(ctxStale, {
    threshold: 95,
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        five_hour: { utilization: 10, resets_at: '2026-11-12T15:00:00Z' },
        seven_day: { utilization: 24, resets_at: '2026-11-16T06:00:00Z' },
      }),
    }),
    nowMs: nowMs - 60 * 1000,
    cacheTtlMs: 0,
  });
  // Now the usage endpoint answers 429 for gmail while a limit hit is in the transcript
  writeTranscript(ctxStale, 'proj-1', 's1.jsonl', [sampleQuotaLimitsLine()], nowMs);
  const rStale = await autosw.tick(ctxStale, {
    threshold: 95,
    fetch: usageFetchBy({ 'AT-gmail': 429, 'AT-yahoo': 20 }),
    nowMs,
    cacheTtlMs: 0,
  });
  assert.strictEqual(rStale.state, 'switched');
  assert.strictEqual(rStale.switchedTo.name, 'yahoo');
  assert.strictEqual(rStale.basis, 'limit-signal');
  assert.strictEqual(rStale.limitSignalIgnored, undefined);
});

function setupFailoverReady(ctx) {
  const ksPath = path.join(ctx.home, 'keysmith-config.json');
  fs.writeFileSync(
    ksPath,
    JSON.stringify({
      aliases: { 'claude-failover': ['claude-failover-api/claude-opus-5-5', 'kiro-emu/claude-opus-4-6'] },
      limits: {
        spend: { 'claude-failover-api': { usd: 25, since: '2026-11-12', until: '2026-12-09' } },
      },
    }),
  );
  ctx.store.setProfile('provider__keysmith-failover', 'ks_live_testkey');
  fs.mkdirSync(path.join(ctx.configDir, 'providers'), { recursive: true });
  fs.writeFileSync(
    path.join(ctx.configDir, 'providers', 'keysmith-failover.json'),
    JSON.stringify({ name: 'keysmith-failover', baseUrl: 'http://127.0.0.1:8787', authScheme: 'bearer' }),
  );
  ctx.claudeSettingsPath = path.join(ctx.claudeDir, 'settings.json');
  return ksPath;
}

function okGatewayFetch() {
  return async (url) => {
    if (/\/v1\/keysmith\/usage/.test(url)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          summary: {},
          spend: [
            {
              kind: 'adapter',
              target: 'claude-failover-api',
              spent: 0,
              cap: 25,
              exceeded: false,
              window: { since: '2026-11-12', until: '2026-12-09' },
              windowStatus: 'open',
            },
          ],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'claude-failover' }] }) };
  };
}

test('3. manual: engage({manual:true}) stays engaged across recovered headroom and passed recoverAt; release writes .live-since.json and prevents re-engaging on old hit', async function () {
  const ctx = makeCtx();
  login(ctx, 'gmail@x.com', 'u1', 'AT-gmail');
  core.addCurrent(ctx);
  const ksPath = setupFailoverReady(ctx);

  const hitTime = Date.parse('2026-11-12T10:00:45.961Z');
  const engageTime = Date.parse('2026-11-12T10:01:00.000Z');
  writeTranscript(ctx, 'proj-1', 's1.jsonl', [sampleQuotaLimitsLine()], hitTime);

  const eng = await failover.engage(
    ctx,
    {
      from: 'gmail',
      manual: true,
      reason: 'turned on by hand',
      recoverAt: '2026-11-12T10:02:00.000Z',
    },
    { fetch: okGatewayFetch(), keysmithConfig: ksPath, nowMs: engageTime },
  );
  assert.strictEqual(eng.ok, true);
  assert.strictEqual(eng.state.manual, true);

  let releaseCalls = 0;
  const adapter = {
    state: () => failover.state(ctx),
    check: async () => ({ ok: true }),
    engage: async (info) => failover.engage(ctx, info, { fetch: okGatewayFetch(), keysmithConfig: ksPath }),
    release: async (info) => {
      releaseCalls++;
      return failover.release(ctx, info, {});
    },
  };

  // Tick where the account shows 80% headroom (20% used) AND recoverAt has passed -> stays engaged!
  const afterRecoverMs = Date.parse('2026-11-12T10:05:00.000Z');
  const rStay = await autosw.tick(ctx, {
    threshold: 95,
    fetch: usageFetchBy({ 'AT-gmail': 20 }),
    nowMs: afterRecoverMs,
    cacheTtlMs: 0,
    failover: adapter,
  });
  assert.strictEqual(rStay.state, 'failover');
  assert.strictEqual(releaseCalls, 0, 'manual engage must NOT auto-release on recovered headroom or recoverAt');
  assert.ok(failover.state(ctx), 'failover state remains engaged on disk');

  // Release (`off`) writes .live-since.json
  const offTime = Date.parse('2026-11-12T10:06:00.000Z');
  const rel = await failover.release(ctx, { reason: 'turned off by hand', nowMs: offTime });
  assert.strictEqual(rel.ok, true);
  assert.strictEqual(failover.state(ctx), null);
  assert.strictEqual(limitsignal.readLiveSince(ctx), offTime);

  // Subsequent tick with unknown usage ignores the old hit (which was at 10:00:45, before 10:06:00)
  let engageCalls = 0;
  adapter.engage = async () => {
    engageCalls++;
    return { ok: true };
  };
  const rAfterOff = await autosw.tick(ctx, {
    threshold: 95,
    fetch: usageFetchBy({ 'AT-gmail': 429 }),
    nowMs: offTime + 30 * 1000,
    cacheTtlMs: 0,
    maxStaleMs: 0,
    failover: adapter,
  });
  assert.strictEqual(rAfterOff.state, 'unknown');
  assert.strictEqual(engageCalls, 0, 'old limit hit before .live-since.json must not re-engage failover');
});

test('4. lost: check fails 3 retries (2000, 5000, 10000) -> failover-degraded, notify once, hold during grace, release after grace, passing check clears lostSince; markLost when not engaged is a no-op', async function () {
  const ctx = makeCtx();
  login(ctx, 'gmail@x.com', 'u1', 'AT-gmail');
  core.addCurrent(ctx);
  const ksPath = setupFailoverReady(ctx);

  const t0 = Date.parse('2026-11-12T10:00:00.000Z');
  // H2: markLost when not engaged writes nothing and returns null
  assert.strictEqual(failover.markLost(ctx, t0), null);
  assert.strictEqual(failover.state(ctx), null);
  assert.strictEqual(fs.existsSync(path.join(ctx.configDir, failover.STATE_FILE)), false);

  await failover.engage(
    ctx,
    { from: 'gmail', manual: true, reason: 'turned on by hand' },
    { fetch: okGatewayFetch(), keysmithConfig: ksPath, nowMs: t0 },
  );

  let checkOk = false;
  let releasedInfo = null;
  const notes = [];
  const sleeps = [];
  const adapter = {
    state: () => failover.state(ctx),
    notify: async (ev, msg) => notes.push({ ev, msg }),
    markLost: (at) => failover.markLost(ctx, at),
    clearLost: () => failover.clearLost(ctx),
    check: async () => (checkOk ? { ok: true } : { ok: false, reason: 'ECONNREFUSED' }),
    engage: async () => ({ ok: true }),
    release: async (info) => {
      releasedInfo = info;
      return failover.release(ctx, info, { nowMs: t0 + 305 * 1000 });
    },
  };

  // Tick 1: fails initial + 3 retries -> sleep 2000, 5000, 10000; degraded; release NOT called; notify once
  const r1 = await autosw.tick(ctx, {
    threshold: 95,
    fetch: usageFetchBy({ 'AT-gmail': 429 }),
    nowMs: t0,
    cacheTtlMs: 0,
    failover: adapter,
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.strictEqual(r1.state, 'failover-degraded');
  assert.deepStrictEqual(sleeps, [2000, 5000, 10000]);
  assert.strictEqual(releasedInfo, null);
  assert.strictEqual(failover.state(ctx).lostSince, new Date(t0).toISOString());
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(notes[0].msg, 'The failover gateway is not answering — holding the failover for up to 5 min');

  // Tick 2: within grace (120 s later), still failing -> degraded, no second notify
  const r2 = await autosw.tick(ctx, {
    threshold: 95,
    fetch: usageFetchBy({ 'AT-gmail': 429 }),
    nowMs: t0 + 120 * 1000,
    cacheTtlMs: 0,
    failover: adapter,
    sleep: async () => {},
  });
  assert.strictEqual(r2.state, 'failover-degraded');
  assert.strictEqual(releasedInfo, null);
  assert.strictEqual(notes.length, 1);

  // Passing check clears lostSince
  checkOk = true;
  const rRecovered = await autosw.tick(ctx, {
    threshold: 95,
    fetch: usageFetchBy({ 'AT-gmail': 429 }),
    nowMs: t0 + 180 * 1000,
    cacheTtlMs: 0,
    failover: adapter,
    sleep: async () => {},
  });
  assert.strictEqual(rRecovered.state, 'failover');
  assert.strictEqual(rRecovered.gatewayBack, true);
  assert.strictEqual(failover.state(ctx).lostSince, undefined);

  // Now fail again and exceed the 300 s grace period -> release({ lost: true })
  checkOk = false;
  const tOutage2 = t0 + 200 * 1000;
  const rDeg2 = await autosw.tick(ctx, {
    threshold: 95,
    fetch: usageFetchBy({ 'AT-gmail': 429 }),
    nowMs: tOutage2,
    cacheTtlMs: 0,
    failover: adapter,
    sleep: async () => {},
  });
  assert.strictEqual(rDeg2.state, 'failover-degraded');
  assert.strictEqual(notes.length, 2, 'new outage notifies once');

  const rLost = await autosw.tick(ctx, {
    threshold: 95,
    fetch: usageFetchBy({ 'AT-gmail': 429 }),
    nowMs: tOutage2 + 301 * 1000,
    cacheTtlMs: 0,
    failover: adapter,
    sleep: async () => {},
  });
  assert.strictEqual(rLost.state, 'failover-lost');
  assert.ok(releasedInfo);
  assert.strictEqual(releasedInfo.lost, true);
  assert.strictEqual(failover.state(ctx), null);
  // H2: markLost after release does not resurrect state
  assert.strictEqual(failover.markLost(ctx, tOutage2 + 400 * 1000), null);
  assert.strictEqual(failover.state(ctx), null);
});

test('5. MCP keyflip_failover: status is read-only (confirm optional in schema); on/off require confirm=true', async function () {
  const ctx = makeCtx();
  login(ctx, 'gmail@x.com', 'u1', 'AT-gmail');
  core.addCurrent(ctx);
  const ksPath = setupFailoverReady(ctx);
  ctx.keysmithConfig = ksPath;
  ctx.fetch = okGatewayFetch();

  const tool = mcp.TOOLS.find((t) => t.name === 'keyflip_failover');
  assert.ok(tool, 'keyflip_failover MCP tool must be registered');
  assert.deepStrictEqual(tool.inputSchema.required, ['action']);

  // status is read-only and works without confirm
  const st0 = await tool.run(ctx, { action: 'status' });
  assert.strictEqual(st0.failover.enabled, true);
  assert.strictEqual(st0.failover.engaged, false);
  assert.strictEqual(st0.failover.gateway.ok, true);

  // on/off without confirm throws
  await assert.rejects(() => tool.run(ctx, { action: 'on' }), /confirm/i);
  await assert.rejects(() => tool.run(ctx, { action: 'off' }), /confirm/i);
  assert.strictEqual(failover.state(ctx), null, 'refused call must not mutate state');

  // on with confirm=true engages with manual=true
  const onRes = await tool.run(ctx, { action: 'on', confirm: true });
  assert.strictEqual(onRes.failover.ok, true);
  assert.strictEqual(onRes.failover.state.manual, true);
  assert.strictEqual(failover.state(ctx).manual, true);

  const st1 = await tool.run(ctx, { action: 'status' });
  assert.strictEqual(st1.failover.engaged, true);
  assert.strictEqual(st1.failover.state.manual, true);

  // off with confirm=true releases and writes .live-since.json
  const offRes = await tool.run(ctx, { action: 'off', confirm: true });
  assert.strictEqual(offRes.failover.ok, true);
  assert.strictEqual(failover.state(ctx), null);
  assert.ok(livesince.readLiveSince(ctx), 'release must write .live-since.json');
});

test('6. cmdAutoswitch log line for limit-signal engage and switch (formatter + cmdAutoswitch --once)', async function () {
  const limitHit = {
    at: '2026-11-12T10:00:45.961Z',
    resetsAt: '2026-11-16T06:00:00.000Z',
    kind: 'seven_day',
  };
  assert.strictEqual(
    formatAutoswitchTickLine(
      {
        state: 'failover-engaged',
        active: { name: 'gmail', email: 'gmail@x.com' },
        switchedTo: null,
        limitHit,
      },
      { at: '13:01:12', timeZone: 'Europe/Istanbul' },
    ),
    '[13:01:12] Claude Code hit the weekly limit (resets Nov 16 09:00) — no account with headroom — API failover engaged',
  );
  assert.strictEqual(
    formatAutoswitchTickLine(
      {
        state: 'switched',
        active: { name: 'gmail', email: 'gmail@x.com' },
        switchedTo: { name: 'yahoo', email: 'yahoo@x.com' },
        limitHit,
      },
      { at: '13:01:12', timeZone: 'Europe/Istanbul' },
    ),
    '[13:01:12] Claude Code hit the weekly limit (resets Nov 16 09:00) — switched to yahoo',
  );

  // Also test via cmdAutoswitch(ctx, ['--once']) with injected fetch and Europe/Istanbul timeZone
  const ctx = makeCtx();
  login(ctx, 'gmail@x.com', 'u1', 'AT-gmail');
  core.addCurrent(ctx);
  const ksPath = setupFailoverReady(ctx);
  const nowMs = Date.parse('2026-11-12T10:01:12.000Z');
  livesince.writeLiveSince(ctx, { nowMs: Date.parse('2026-11-12T09:50:00.000Z') });
  writeTranscript(ctx, 'proj-cli', 'session.jsonl', [sampleQuotaLimitsLine({ entrypoint: 'cli' })], nowMs);

  const gwFetch = okGatewayFetch();
  ctx.keysmithConfig = ksPath;
  ctx.nowMs = nowMs;
  ctx.timeZone = 'Europe/Istanbul';
  ctx.fetch = async (url, opts) => {
    if (String(url).indexOf('127.0.0.1:8787') !== -1) return gwFetch(url, opts);
    return {
      ok: false,
      status: 429,
      headers: { get: (h) => (h === 'retry-after' ? '3600' : null) },
    };
  };

  const printed = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    printed.push(String(chunk));
    return true;
  };
  try {
    await cmdAutoswitch(ctx, ['--once']);
  } finally {
    process.stdout.write = origWrite;
  }

  const outText = printed.join('');
  assert.match(
    outText,
    /\[\d{2}:\d{2}:\d{2}\] Claude Code hit the weekly limit \(resets Nov 16 09:00\) — no account with headroom — API failover engaged/,
  );
  const st = failover.state(ctx);
  assert.ok(st && st.engaged, 'failover must be engaged after cmdAutoswitch --once');
  assert.strictEqual(st.recoverAt, '2026-11-16T06:00:00.000Z');
});
