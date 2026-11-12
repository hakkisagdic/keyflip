// P2: the live CLI account is decided by the TOKEN, not by the ~/.claude.json label.
// The live machine had the gmail account's token under a yahoo label. Fixtures are synthetic
// (TOK-… strings) — no real token, no keychain, no network (the profile endpoint is a fake).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { makeCtx, writeClaude } from './helpers.js';
import * as core from '../src/core.js';
import * as profiles from '../src/profiles.js';
import * as identity from '../src/identity.js';
import * as autosw from '../src/autoswitch.js';
import * as history from '../src/history.js';
import * as _mcp from '../src/mcp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOW = 1800000000000;

function blob(access, refresh) {
  const o = { accessToken: access };
  if (refresh) o.refreshToken = refresh;
  return JSON.stringify({ claudeAiOauth: o });
}
function label(ctx, email, uid) {
  writeClaude(ctx, { oauthAccount: { emailAddress: email, accountUuid: 'uuid-' + email }, userID: uid });
}
// Two saved accounts, gmail and yahoo, each captured normally (label + token agree at capture time).
function machine() {
  const ctx = makeCtx();
  label(ctx, 'me@gmail.com', 'u-g');
  ctx.store.setLive(blob('TOK-GMAIL-1', 'RT-GMAIL-1'));
  core.addCurrent(ctx, 'gmail');
  label(ctx, 'me@yahoo.com', 'u-y');
  ctx.store.setLive(blob('TOK-YAHOO-1', 'RT-YAHOO-1'));
  core.addCurrent(ctx, 'yahoo');
  return ctx;
}
// The live state of 12 Nov: gmail's token is live, the label says yahoo.
function mislabelled() {
  const ctx = machine();
  ctx.store.setLive(blob('TOK-GMAIL-1', 'RT-GMAIL-1'));
  label(ctx, 'me@yahoo.com', 'u-y');
  return ctx;
}
function profileEndpoint(byToken, calls) {
  return async function (url, opts) {
    const tok = opts.headers.Authorization.replace('Bearer ', '');
    if (calls) calls.push({ url: url, tok: tok });
    if (url !== identity.PROFILE_URL) return { ok: false, status: 404, headers: { get: () => null } };
    const who = byToken[tok];
    if (!who) return { ok: false, status: 401, headers: { get: () => null } };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ account: { uuid: 'uuid-' + who, email: who }, organization: { uuid: 'org-' + who } }),
    };
  };
}

test('the token, not the label, names the live account (offline exact match)', function () {
  const ctx = mislabelled();
  // keyflip remembers the tokens it saves; drop that so the exact-match path is what answers.
  fs.rmSync(path.join(ctx.configDir, identity.CACHE_FILE), { force: true });
  const id = identity.liveSync(ctx);
  assert.strictEqual(id.name, 'gmail');
  assert.strictEqual(id.email, 'me@gmail.com');
  assert.strictEqual(id.source, 'token-match');
  assert.strictEqual(id.labelName, 'yahoo');
  assert.strictEqual(id.mismatch, true);
  // and it is cached by fingerprint — never by token
  const raw = fs.readFileSync(path.join(ctx.configDir, identity.CACHE_FILE), 'utf8');
  assert.ok(raw.indexOf('TOK-GMAIL') === -1 && raw.indexOf('RT-GMAIL') === -1, 'no token in the cache file');
  assert.strictEqual(identity.liveSync(ctx).source, 'token-cache');
});

test('list marks the TOKEN\'s account active, not the label\'s', function () {
  const ctx = mislabelled();
  const active = core.listProfiles(ctx).filter(function (e) {
    return e.active;
  });
  assert.deepStrictEqual(
    active.map(function (e) {
      return e.name;
    }),
    ['gmail'],
  );
});

test('REGRESSION: switching away saves the live token into ITS account, never into the label\'s', function () {
  const ctx = mislabelled();
  // Claude Code refreshed gmail's token since capture: the live blob differs from the stored one.
  // The fingerprint cache already knows the previous token; teach it the rotated one via the endpoint.
  ctx.store.setLive(blob('TOK-GMAIL-2', 'RT-GMAIL-2'));
  return identity
    .resolveLive(ctx, { fetch: profileEndpoint({ 'TOK-GMAIL-2': 'me@gmail.com' }) })
    .then(function (id) {
      assert.strictEqual(id.name, 'gmail');
      assert.strictEqual(id.source, 'token-profile');
      const yahooBefore = ctx.store.getProfile('yahoo');
      core.performSwitch(ctx, 'yahoo');
      assert.strictEqual(ctx.store.getProfile('yahoo'), yahooBefore, "yahoo's credential untouched");
      assert.strictEqual(ctx.store.getProfile('gmail'), blob('TOK-GMAIL-2', 'RT-GMAIL-2'), 'gmail got its rotated token');
      assert.strictEqual(profiles.email(ctx.configDir, 'gmail'), 'me@gmail.com', "gmail's meta not rewritten to yahoo");
      assert.strictEqual(profiles.email(ctx.configDir, 'yahoo'), 'me@yahoo.com');
    });
});

test('`add` on a mislabelled login refreshes the token\'s profile and leaves both metas alone', function () {
  const ctx = mislabelled();
  ctx.store.setLive(blob('TOK-GMAIL-1', 'RT-GMAIL-3')); // same access token, newer refresh token
  const r = core.addCurrent(ctx);
  assert.strictEqual(r.name, 'gmail');
  assert.strictEqual(r.labelMismatch, true);
  assert.strictEqual(JSON.parse(ctx.store.getProfile('yahoo')).claudeAiOauth.accessToken, 'TOK-YAHOO-1');
  assert.strictEqual(profiles.email(ctx.configDir, 'yahoo'), 'me@yahoo.com');
});

test('a rotated token is resolved by the profile endpoint ONCE, then from the fingerprint cache', async function () {
  const ctx = mislabelled();
  ctx.store.setLive(blob('TOK-GMAIL-9', 'RT-GMAIL-9'));
  assert.strictEqual(identity.liveSync(ctx).source, 'label', 'offline it is unknown — label fallback, flagged');
  const calls = [];
  const f = profileEndpoint({ 'TOK-GMAIL-9': 'me@gmail.com' }, calls);
  const a = await identity.resolveLive(ctx, { fetch: f });
  const b = await identity.resolveLive(ctx, { fetch: f });
  assert.strictEqual(a.name, 'gmail');
  assert.strictEqual(a.mismatch, true);
  assert.strictEqual(b.source, 'token-cache');
  assert.strictEqual(calls.length, 1, 'one request per token');
  assert.strictEqual(calls[0].url, identity.PROFILE_URL);
});

test('an endpoint failure is remembered for a while (no hammering) and falls back to the label', async function () {
  const ctx = mislabelled();
  ctx.store.setLive(blob('TOK-UNKNOWN'));
  const calls = [];
  const f = profileEndpoint({}, calls); // 401 for everything
  const a = await identity.resolveLive(ctx, { fetch: f, nowMs: NOW });
  const b = await identity.resolveLive(ctx, { fetch: f, nowMs: NOW + 60000 });
  assert.strictEqual(a.source, 'label');
  assert.strictEqual(b.source, 'label');
  assert.strictEqual(calls.length, 1);
});

test('two profiles holding ONE token: offline refuses to guess; the endpoint names the owner and the damaged one', async function () {
  const ctx = machine();
  // What label-based saving did: yahoo's profile was overwritten with gmail's login.
  ctx.store.setProfile('yahoo', blob('TOK-GMAIL-1', 'RT-GMAIL-1'));
  ctx.store.setLive(blob('TOK-GMAIL-1', 'RT-GMAIL-1'));
  label(ctx, 'me@yahoo.com', 'u-y');
  fs.rmSync(path.join(ctx.configDir, identity.CACHE_FILE), { force: true });
  const off = identity.liveSync(ctx);
  assert.strictEqual(off.source, 'label');
  assert.deepStrictEqual(off.sharedBy.sort(), ['gmail', 'yahoo']);
  const on = await identity.resolveLive(ctx, { fetch: profileEndpoint({ 'TOK-GMAIL-1': 'me@gmail.com' }) });
  assert.strictEqual(on.name, 'gmail');
  assert.deepStrictEqual(on.wrongCredentialIn, ['yahoo']);
});

test('repairPointer fixes the label without touching the credential', function () {
  const ctx = mislabelled();
  const live = ctx.store.getLive();
  const r = identity.repairIfMismatched(ctx);
  assert.strictEqual(r.repaired, true);
  assert.strictEqual(r.to, 'gmail');
  assert.strictEqual(core.currentEmail(ctx), 'me@gmail.com');
  assert.strictEqual(JSON.parse(fs.readFileSync(ctx.claudeConfigPath, 'utf8')).userID, 'u-g', "gmail's userID, not yahoo's");
  assert.strictEqual(ctx.store.getLive(), live);
  assert.strictEqual(identity.repairIfMismatched(ctx).repaired, false, 'idempotent');
});

test('autoswitch reads the TOKEN account\'s usage, repairs the label, and records it', async function () {
  const ctx = mislabelled();
  const seen = [];
  const usageFetch = async function (url, opts) {
    const tok = opts.headers.Authorization.replace('Bearer ', '');
    seen.push(tok);
    const pct = { 'TOK-GMAIL-1': 40, 'TOK-YAHOO-1': 5 }[tok];
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ five_hour: { utilization: pct } }),
    };
  };
  const r = await autosw.tick(ctx, { threshold: 95, fetch: usageFetch, nowMs: NOW, cacheTtlMs: 0 });
  assert.strictEqual(r.active.name, 'gmail');
  assert.strictEqual(r.state, 'below');
  assert.strictEqual(r.headroom, 60, "gmail's own usage, read with gmail's token");
  assert.ok(r.identityRepair && r.identityRepair.to === 'gmail');
  assert.strictEqual(core.currentEmail(ctx), 'me@gmail.com');
  const ev = history.readEvents(ctx).filter(function (e) {
    return e.kind === 'identity-repair';
  });
  assert.strictEqual(ev.length, 1);
});

test('MCP keyflip_status reports the token account and flags the label', async function () {
  const ctx = mislabelled();
  const t = _mcp.TOOLS.find(function (x) {
    return x.name === 'keyflip_status';
  });
  const r = await t.run(ctx, {});
  assert.strictEqual(r.cli.email, 'me@gmail.com');
  assert.strictEqual(r.cli.name, 'gmail');
  assert.strictEqual(r.cli.labelEmail, 'me@yahoo.com');
  assert.strictEqual(r.cli.labelMismatch, true);
});

test('CLI `status` shows the token account, warns about the label, and `--fix` repairs it', function () {
  const home = fs.mkdtempSync(path.join(path.dirname(makeCtx().home), 'kf-id-'));
  const env = Object.assign({}, process.env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    KEYFLIP_CONFIG_DIR: path.join(home, '.config', 'keyflip'),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    KEYFLIP_TEST_CLAUDE: 'stopped',
    KEYFLIP_APP_BUNDLE: path.join(home, 'no-such-Claude.app'),
  });
  const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');
  const run = (args) => spawnSync(process.execPath, [BIN].concat(args), { encoding: 'utf8', env: env });
  const cj = path.join(home, '.claude.json');
  const cred = path.join(home, '.claude', '.credentials.json');
  fs.mkdirSync(path.dirname(cred), { recursive: true });
  const as = (email, uid, b) => {
    fs.writeFileSync(cj, JSON.stringify({ oauthAccount: { emailAddress: email }, userID: uid }));
    fs.writeFileSync(cred, b);
  };
  as('me@gmail.com', 'u-g', blob('TOK-GMAIL-1', 'RT-GMAIL-1'));
  assert.strictEqual(run(['add', 'gmail']).status, 0);
  as('me@yahoo.com', 'u-y', blob('TOK-YAHOO-1', 'RT-YAHOO-1'));
  assert.strictEqual(run(['add', 'yahoo']).status, 0);
  as('me@yahoo.com', 'u-y', blob('TOK-GMAIL-1', 'RT-GMAIL-1')); // the 12 Nov state
  const st = run(['status', '--json']);
  const j = JSON.parse(st.stdout);
  assert.strictEqual(j.cli.email, 'me@gmail.com');
  assert.strictEqual(j.cli.labelMismatch, true);
  const human = run(['status']);
  assert.ok(/live token belongs to me@gmail\.com/.test(human.stdout), human.stdout);
  assert.ok(/keyflip status --fix/.test(human.stdout));
  const fixed = run(['status', '--fix', '--json']);
  assert.strictEqual(JSON.parse(fixed.stdout).cli.labelMismatch, false);
  assert.strictEqual(JSON.parse(fs.readFileSync(cj, 'utf8')).oauthAccount.emailAddress, 'me@gmail.com');
  assert.strictEqual(fs.readFileSync(cred, 'utf8'), blob('TOK-GMAIL-1', 'RT-GMAIL-1'), 'the login itself untouched');
});

test('REGRESSION: switching to the LABEL\'s account is a real switch, not "already active"', async function () {
  const ctx = mislabelled(); // gmail's token live, label yahoo
  assert.strictEqual(core.isActive(ctx, 'gmail'), true);
  assert.strictEqual(core.isActive(ctx, 'yahoo'), false, 'the label alone does not make yahoo active');
  const t = _mcp.TOOLS.find((x) => x.name === 'keyflip_switch');
  const r = await t.run(ctx, { name: 'yahoo', confirm: true });
  assert.ok(!r.alreadyActive, 'not short-circuited by the stale label');
  assert.strictEqual(r.switched.name, 'yahoo');
  assert.strictEqual(JSON.parse(ctx.store.getLive()).claudeAiOauth.accessToken, 'TOK-YAHOO-1');
  assert.strictEqual(JSON.parse(ctx.store.getProfile('gmail')).claudeAiOauth.accessToken, 'TOK-GMAIL-1');
});
