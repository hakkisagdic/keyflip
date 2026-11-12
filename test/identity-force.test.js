// P2 follow-up (12 Nov): the live CLI token was gmail's ONE-YEAR token (`keyflip login --long-lived`,
// scope `user:inference` only). The profile endpoint needs `user:profile` and answers it with a 403
// every time, so P2 could never verify it and the yahoo label stayed. Covered here:
//   - an inference-only token is never sent to the profile endpoint;
//   - `keyflip status --fix --force` relabels only on a fingerprint match to the account's LOGIN
//     capture (the longlived__<name> slot), refuses anything weaker, writes an audit line, and is
//     never taken by a tick or an MCP tool;
//   - the status line names the account by token, like `keyflip status`.
// Fixtures are synthetic (TOK-… strings): no real token, no keychain, no network.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { makeCtx, writeClaude } from './helpers.js';
import * as core from '../src/core.js';
import * as identity from '../src/identity.js';
import * as longtoken from '../src/longtoken.js';
import * as autosw from '../src/autoswitch.js';
import * as _mcp from '../src/mcp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');
const NOW = 1800000000000;

function full(access, refresh) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: access,
      refreshToken: refresh,
      scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
    },
  });
}
// What `keyflip login --long-lived` stores: inference-only, no refresh token.
function oneYear(access) {
  return JSON.stringify({ claudeAiOauth: { accessToken: access, expiresAt: NOW + 3e10, scopes: ['user:inference'] } });
}
function label(ctx, email, uid) {
  writeClaude(ctx, { oauthAccount: { emailAddress: email, accountUuid: 'uuid-' + email }, userID: uid });
}
// gmail and yahoo saved normally; gmail also has a one-year token from `keyflip login gmail --long-lived`,
// which is live (its normal login died, so the login put it in both slots); the label says yahoo.
function machine12Nov() {
  const ctx = makeCtx();
  label(ctx, 'me@gmail.com', 'u-g');
  ctx.store.setLive(full('TOK-GMAIL-1', 'RT-GMAIL-1'));
  core.addCurrent(ctx, 'gmail');
  label(ctx, 'me@yahoo.com', 'u-y');
  ctx.store.setLive(full('TOK-YAHOO-1', 'RT-YAHOO-1'));
  core.addCurrent(ctx, 'yahoo');
  const ll = oneYear('TOK-GMAIL-1Y');
  ctx.store.setProfile(longtoken.storeName('gmail'), ll);
  ctx.store.setProfile('gmail', ll);
  ctx.store.setLive(ll);
  label(ctx, 'me@yahoo.com', 'u-y');
  return ctx;
}
function countingFetch(calls) {
  return async function (url) {
    calls.push(url);
    return { ok: false, status: 403, headers: { get: () => null } };
  };
}

test('an inference-only live token is never sent to the profile endpoint (it needs user:profile)', async function () {
  const ctx = machine12Nov();
  const calls = [];
  const id = await identity.resolveLive(ctx, { fetch: countingFetch(calls), nowMs: NOW });
  assert.strictEqual(calls.length, 0, 'no request: the endpoint answers 403 to it by design');
  assert.strictEqual(id.profileScope, false);
  assert.deepStrictEqual(id.scopes, ['user:inference']);
  assert.strictEqual(id.name, 'gmail', 'the offline answer still names the token account');
  assert.strictEqual(id.verified, false);
  assert.strictEqual(id.mismatch, true);
  assert.strictEqual(identity.canAskProfile(full('A', 'B')), true);
  assert.strictEqual(
    identity.canAskProfile(JSON.stringify({ claudeAiOauth: { accessToken: 'A' } })),
    true,
    'no scopes listed: asked as before',
  );
  // and the ordinary repair still refuses: nothing verified it
  assert.strictEqual(identity.repairIfMismatched(ctx).repaired, false);
  assert.strictEqual(core.currentEmail(ctx), 'me@yahoo.com');
});

test('repairForced relabels to the profile whose LOGIN capture holds the live token; the login is untouched', function () {
  const ctx = machine12Nov();
  const live = ctx.store.getLive();
  const r = identity.repairForced(ctx);
  assert.strictEqual(r.repaired, true, JSON.stringify(r));
  assert.strictEqual(r.forced, true);
  assert.strictEqual(r.to, 'gmail');
  assert.strictEqual(r.fromEmail, 'me@yahoo.com');
  assert.strictEqual(r.evidence.slot, 'longlived__gmail');
  assert.match(r.evidence.fingerprint, /^[0-9a-f]{8}$/);
  assert.ok(JSON.stringify(r).indexOf('TOK-') === -1, 'no token in the result');
  assert.strictEqual(core.currentEmail(ctx), 'me@gmail.com');
  assert.strictEqual(JSON.parse(fs.readFileSync(ctx.claudeConfigPath, 'utf8')).userID, 'u-g', "gmail's userID");
  assert.strictEqual(ctx.store.getLive(), live, 'credential untouched');
  assert.strictEqual(identity.liveSync(ctx).mismatch, false);
  const again = identity.repairForced(ctx);
  assert.strictEqual(again.repaired, false);
  assert.strictEqual(again.already, true, 'idempotent');
});

test('REGRESSION: repairForced refuses a match only label-based saving made (the normal slot)', function () {
  const ctx = machine12Nov();
  // The 12 Nov damage: gmail's token saved into YAHOO's normal slot. No login capture holds it.
  ctx.store.delProfile(longtoken.storeName('gmail'));
  ctx.store.setProfile('gmail', full('TOK-GMAIL-OLD', 'RT-GMAIL-OLD'));
  ctx.store.setProfile('yahoo', ctx.store.getLive());
  const r = identity.repairForced(ctx);
  assert.strictEqual(r.repaired, false);
  assert.match(r.reason, /login capture/);
  assert.strictEqual(core.currentEmail(ctx), 'me@yahoo.com', 'label unchanged');
});

test('repairForced refuses an ambiguous capture and never overrides the profile endpoint', function () {
  const amb = machine12Nov();
  amb.store.setProfile(longtoken.storeName('yahoo'), amb.store.getLive());
  const a = identity.repairForced(amb);
  assert.strictEqual(a.repaired, false);
  assert.match(a.reason, /gmail and yahoo|yahoo and gmail/);
  assert.strictEqual(core.currentEmail(amb), 'me@yahoo.com');

  const ver = machine12Nov();
  const cacheFile = path.join(ver.configDir, identity.CACHE_FILE);
  const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  c[identity.fingerprints(ver.store.getLive()).access] = {
    name: 'yahoo',
    email: 'me@yahoo.com',
    source: 'token-profile',
    at: NOW,
  };
  fs.writeFileSync(cacheFile, JSON.stringify(c));
  const v = identity.repairForced(ver);
  assert.strictEqual(v.repaired, false);
  assert.match(v.reason, /profile endpoint named/);
  assert.strictEqual(core.currentEmail(ver), 'me@yahoo.com');
});

test('the force is never automatic: an autoswitch tick and MCP keyflip_status leave the label alone', async function () {
  const ctx = machine12Nov();
  const usageFetch = async function (url) {
    if (url === identity.PROFILE_URL) throw new Error('the tick must not ask the endpoint about this token');
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ five_hour: { utilization: 10 } }),
    };
  };
  const r = await autosw.tick(ctx, { threshold: 95, fetch: usageFetch, nowMs: NOW, cacheTtlMs: 0 });
  assert.ok(!r.identityRepair, 'no repair from a tick');
  assert.strictEqual(core.currentEmail(ctx), 'me@yahoo.com');
  const t = _mcp.TOOLS.find(function (x) {
    return x.name === 'keyflip_status';
  });
  assert.deepStrictEqual(t.inputSchema.properties, {}, 'the MCP tool takes no fix/force argument');
  const s = await t.run(ctx, { fix: true, force: true });
  assert.strictEqual(s.cli.labelMismatch, true);
  assert.strictEqual(core.currentEmail(ctx), 'me@yahoo.com');
});

// ---- the CLI, spawned against a sandbox HOME (file store) ----
function sandbox() {
  const home = fs.mkdtempSync(path.join(path.dirname(makeCtx().home), 'kf-force-'));
  const env = Object.assign({}, process.env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    KEYFLIP_CONFIG_DIR: path.join(home, '.config', 'keyflip'),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    KEYFLIP_TEST_CLAUDE: 'stopped',
    KEYFLIP_APP_BUNDLE: path.join(home, 'no-such-Claude.app'),
  });
  const cfgDir = path.join(home, '.config', 'keyflip');
  const cj = path.join(home, '.claude.json');
  const cred = path.join(home, '.claude', '.credentials.json');
  fs.mkdirSync(path.dirname(cred), { recursive: true });
  const run = (args) => spawnSync(process.execPath, [BIN].concat(args), { encoding: 'utf8', env: env });
  const as = (email, uid, b) => {
    fs.writeFileSync(cj, JSON.stringify({ oauthAccount: { emailAddress: email }, userID: uid }));
    fs.writeFileSync(cred, b);
  };
  as('me@gmail.com', 'u-g', full('TOK-GMAIL-1', 'RT-GMAIL-1'));
  assert.strictEqual(run(['add', 'gmail']).status, 0);
  as('me@yahoo.com', 'u-y', full('TOK-YAHOO-1', 'RT-YAHOO-1'));
  assert.strictEqual(run(['add', 'yahoo']).status, 0);
  // `keyflip login gmail --long-lived`: the one-year token in its login slot (and the normal one).
  const ll = oneYear('TOK-GMAIL-1Y');
  fs.mkdirSync(path.join(cfgDir, 'creds'), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'creds', longtoken.storeName('gmail') + '.cred'), ll, { mode: 0o600 });
  fs.writeFileSync(path.join(cfgDir, 'creds', 'gmail.cred'), ll, { mode: 0o600 });
  as('me@yahoo.com', 'u-y', ll); // the 12 Nov state
  return { home: home, cfgDir: cfgDir, cj: cj, cred: cred, run: run, ll: ll };
}

test('CLI: `status --fix` explains the 403 and points at --force; `--fix --force` repairs and audits it', function () {
  const sb = sandbox();
  const st = JSON.parse(sb.run(['status', '--json']).stdout);
  assert.strictEqual(st.cli.email, 'me@gmail.com');
  assert.strictEqual(st.cli.labelMismatch, true);
  assert.deepStrictEqual(st.cli.tokenScopes, ['user:inference']);
  assert.strictEqual(st.cli.profileEndpoint, 'no-profile-scope');
  const human = sb.run(['status']).stdout;
  assert.match(human, /keyflip status --fix --force/);
  assert.match(human, /inference-only/);

  const refused = JSON.parse(sb.run(['status', '--fix', '--json']).stdout);
  assert.match(refused.identityRepaired.error, /403/);
  assert.match(refused.identityRepaired.error, /--fix --force/);
  assert.strictEqual(JSON.parse(fs.readFileSync(sb.cj, 'utf8')).oauthAccount.emailAddress, 'me@yahoo.com');

  const alone = sb.run(['status', '--force']);
  assert.notStrictEqual(alone.status, 0, '--force without --fix is refused');
  assert.strictEqual(JSON.parse(fs.readFileSync(sb.cj, 'utf8')).oauthAccount.emailAddress, 'me@yahoo.com');

  const forced = sb.run(['status', '--fix', '--force', '--json']);
  assert.strictEqual(forced.status, 0, forced.stderr);
  const j = JSON.parse(forced.stdout);
  assert.strictEqual(j.identityRepaired.forced, true);
  assert.strictEqual(j.identityRepaired.name, 'gmail');
  assert.strictEqual(j.identityRepaired.from, 'me@yahoo.com');
  assert.strictEqual(j.identityRepaired.evidence.slot, 'longlived__gmail');
  assert.strictEqual(j.cli.labelMismatch, false);
  const cfg = JSON.parse(fs.readFileSync(sb.cj, 'utf8'));
  assert.strictEqual(cfg.oauthAccount.emailAddress, 'me@gmail.com');
  assert.strictEqual(cfg.userID, 'u-g');
  assert.strictEqual(fs.readFileSync(sb.cred, 'utf8'), sb.ll, 'the login itself untouched');
  const log = fs.readFileSync(path.join(sb.cfgDir, 'logs', 'keyflip.log'), 'utf8');
  const line = log.split('\n').find(function (l) {
    return /FORCED label repair/.test(l);
  });
  assert.ok(line, 'an audit line');
  assert.match(line, /me@yahoo\.com -> gmail <me@gmail\.com>/);
  assert.match(line, /longlived__gmail/);
  assert.match(line, /user:inference/);
  assert.ok(log.indexOf('TOK-') === -1, 'no token in the audit log');
  // A second run has nothing to fix and writes no second audit line.
  const again = JSON.parse(sb.run(['status', '--fix', '--force', '--json']).stdout);
  assert.strictEqual(again.identityRepaired, undefined);
  assert.strictEqual(fs.readFileSync(path.join(sb.cfgDir, 'logs', 'keyflip.log'), 'utf8').split('FORCED').length, 2);
});

test('CLI: the status line names the account by TOKEN, flags a wrong label, and reads that account’s quota', function () {
  const sb = sandbox();
  fs.writeFileSync(
    path.join(sb.cfgDir, '.usage-cache.json'),
    JSON.stringify({
      gmail: { usage: { fiveHour: { pct: 30 }, sevenDay: { pct: 10 } } },
      yahoo: { usage: { fiveHour: { pct: 90 }, sevenDay: { pct: 50 } } },
    }),
  );
  const line = sb.run(['statusline']).stdout;
  assert.match(line, /^⚡ me@gmail\.com/, line);
  assert.match(line, /label≠token/);
  assert.match(line, /70% left/, "gmail's quota, not yahoo's");
  assert.doesNotMatch(line, /yahoo/);
  assert.doesNotMatch(line, /\n/);
  // Once the label is fixed, the flag goes.
  assert.strictEqual(sb.run(['status', '--fix', '--force']).status, 0);
  const fixed = sb.run(['statusline']).stdout;
  assert.strictEqual(fixed, '⚡ me@gmail.com · 70% left');
  // A live token no saved account holds: the label is all there is, and the line says so.
  fs.writeFileSync(sb.cred, full('TOK-UNKNOWN', 'RT-UNKNOWN'));
  const unknown = sb.run(['statusline']).stdout;
  assert.match(unknown, /^⚡ me@gmail\.com \(label\?\)/, unknown);
});
