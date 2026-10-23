// codex.test.js — the ChatGPT/Codex surface adapter: one auth.json shared by
// ChatGPT.app and the Codex CLI. All fixtures are synthetic JWTs in a temp HOME;
// no real credential is ever read, and assertions check that no token leaks.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import _child_process from 'child_process';
import { fileURLToPath } from 'url';
import {
  authPath,
  accountDir,
  identityFromAuth,
  needsRefresh,
  refreshAuth,
  refreshLive,
  listCaptures,
  resolveCapture,
  capture,
  removeCapture,
  status,
  switchTo,
  CLIENT_ID,
  TOKEN_URL,
} from '../src/codex.js';
import { tmpdir, makeCtx, assertPrivateMode } from './helpers.js';
import { TOOLS } from '../src/mcp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function jwt(payload) {
  return ['e30', b64url(payload), 'sig'].join('.');
}
function authFor(email, opts) {
  opts = opts || {};
  const exp = opts.exp || Math.floor(Date.now() / 1000) + 5 * 86400;
  const id = jwt({
    email: email,
    name: 'Tester',
    exp: exp,
    'https://api.openai.com/auth': {
      chatgpt_plan_type: opts.plan || 'plus',
      chatgpt_account_id: opts.accountId || 'acct-' + email.split('@')[0],
      chatgpt_user_id: 'user-' + email.split('@')[0],
    },
  });
  const access = jwt({
    exp: exp,
    'https://api.openai.com/auth': {
      chatgpt_plan_type: opts.plan || 'plus',
      chatgpt_account_id: opts.accountId || 'acct-' + email.split('@')[0],
      chatgpt_user_id: 'user-' + email.split('@')[0],
    },
  });
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: id,
      access_token: access,
      refresh_token: opts.refresh || 'rt-' + email.split('@')[0],
      account_id: opts.accountId || 'acct-' + email.split('@')[0],
    },
    last_refresh: '2026-01-01T00:00:00.000Z',
  };
}
function setup() {
  const ctx = makeCtx({ platform: 'darwin' });
  ctx.codexHome = path.join(ctx.home, '.codex');
  fs.mkdirSync(ctx.codexHome, { recursive: true });
  return ctx;
}
function writeLive(ctx, auth) {
  const p = authPath(ctx);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(auth, null, 2), { mode: 0o600 });
  return p;
}
function writeCapture(ctx, slug, auth) {
  const dir = accountDir(ctx, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(auth, null, 2), { mode: 0o600 });
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ schemaVersion: 1, tool: 'codex', slug: slug, email: '' }),
  );
}

test('identityFromAuth reads e-mail, plan and expiry without exposing tokens', function () {
  const auth = authFor('a@example.com', { plan: 'prolite' });
  const id = identityFromAuth(auth);
  assert.strictEqual(id.email, 'a@example.com');
  assert.strictEqual(id.plan, 'prolite');
  assert.strictEqual(id.authMode, 'chatgpt');
  assert.ok(id.expiresAt);
  assert.strictEqual(id.hasRefreshToken, true);
  const json = JSON.stringify(id);
  assert.ok(!json.includes(auth.tokens.access_token), 'no access token');
  assert.ok(!json.includes(auth.tokens.refresh_token), 'no refresh token');
  assert.ok(!json.includes(auth.tokens.id_token), 'no id token');
});

test('status reports the live identity, expiry and saved captures', function () {
  const ctx = setup();
  writeLive(ctx, authFor('live@example.com'));
  const st = status(ctx, { running: [] });
  assert.strictEqual(st.signedIn, true);
  assert.strictEqual(st.live.email, 'live@example.com');
  assert.strictEqual(st.live.hasRefreshToken, true);
  assert.deepStrictEqual(st.running, []);
  assert.ok(!JSON.stringify(st).includes('rt-live'), 'status never carries a refresh token');
});

test('capture stores the raw auth.json 0600 and a secret-free meta.json', function () {
  const ctx = setup();
  const live = authFor('a@example.com');
  writeLive(ctx, live);
  const r = capture(ctx, {});
  assert.strictEqual(r.slug, 'a');
  assert.strictEqual(r.email, 'a@example.com');
  const file = path.join(accountDir(ctx, 'a'), 'auth.json');
  assertPrivateMode(file);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), live);
  const metaText = fs.readFileSync(path.join(accountDir(ctx, 'a'), 'meta.json'), 'utf8');
  assert.ok(!/rt-a|access_token|id_token|refresh_token/.test(metaText), 'meta.json holds no secret');
  assertPrivateMode(path.join(accountDir(ctx, 'a'), 'meta.json'), 'meta.json is still a private file');
});

test('capturing the same account again reuses its slug instead of forking it', function () {
  const ctx = setup();
  writeLive(ctx, authFor('a@example.com'));
  capture(ctx, {});
  writeLive(ctx, authFor('a@example.com', { refresh: 'rt-rotated' }));
  const r = capture(ctx, {});
  assert.strictEqual(r.slug, 'a');
  assert.strictEqual(listCaptures(ctx).length, 1);
});

test('a legacy capture without meta.json is still listed and resolvable by e-mail', function () {
  const ctx = setup();
  const dir = accountDir(ctx, 'legacy');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(authFor('legacy@example.com')), { mode: 0o600 });
  const list = listCaptures(ctx);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].email, 'legacy@example.com');
  assert.strictEqual(resolveCapture(ctx, 'legacy@example.com'), 'legacy');
  assert.strictEqual(resolveCapture(ctx, 1), 'legacy');
});

test('switchTo --dry-run plans without writing or backing up', function () {
  const ctx = setup();
  writeLive(ctx, authFor('live@example.com'));
  writeCapture(ctx, 'a', authFor('a@example.com'));
  const before = fs.readFileSync(authPath(ctx), 'utf8');
  const r = switchTo(ctx, 'a', { dryRun: true, running: [] });
  assert.strictEqual(r.dryRun, true);
  assert.strictEqual(r.plan.target, 'a');
  assert.strictEqual(fs.readFileSync(authPath(ctx), 'utf8'), before);
  assert.ok(!fs.existsSync(path.join(ctx.configDir, 'backups')));
});

test('switchTo refuses while ChatGPT/Codex is running unless forced', function () {
  const ctx = setup();
  writeLive(ctx, authFor('live@example.com'));
  writeCapture(ctx, 'a', authFor('a@example.com'));
  assert.throws(function () {
    switchTo(ctx, 'a', { running: ['ChatGPT'] });
  }, /quit ChatGPT/);
});

test('switchTo writes the stored login, backs up the outgoing one and captures it', function () {
  const ctx = setup();
  const outgoing = authFor('live@example.com');
  writeLive(ctx, outgoing);
  const incoming = authFor('a@example.com');
  writeCapture(ctx, 'a', incoming);
  const r = switchTo(ctx, 'a', { running: [], force: true });
  assert.strictEqual(r.verified, true);
  assert.strictEqual(r.email, 'a@example.com');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(authPath(ctx), 'utf8')), incoming);
  assert.ok(r.backup && fs.existsSync(r.backup), 'outgoing auth.json backed up');
  assertPrivateMode(r.backup, 'backup is 0600');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(r.backup, 'utf8')), outgoing);
  assert.strictEqual(r.capturedOutgoing, 'live');
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(accountDir(ctx, 'live'), 'auth.json'), 'utf8')),
    outgoing,
  );
});

test('needsRefresh compares the access-token expiry against a threshold', function () {
  const now = '2026-01-01T00:00:00.000Z';
  const fresh = authFor('a@example.com', { exp: Math.floor(new Date('2026-01-10T00:00:00Z').getTime() / 1000) });
  assert.strictEqual(needsRefresh(fresh, { now: now }).needs, false);
  const soon = authFor('a@example.com', { exp: Math.floor(new Date('2026-01-01T02:00:00Z').getTime() / 1000) });
  const due = needsRefresh(soon, { now: now });
  assert.strictEqual(due.needs, true);
  assert.strictEqual(due.reason, 'expiring');
  const gone = authFor('a@example.com', { exp: Math.floor(new Date('2025-12-31T00:00:00Z').getTime() / 1000) });
  assert.strictEqual(needsRefresh(gone, { now: now }).reason, 'expired');
  const apiKey = { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test', tokens: null };
  assert.strictEqual(needsRefresh(apiKey, { now: now }).needs, false);
});

test('refreshAuth posts the documented grant and writes the rotated tokens', async function () {
  const ctx = setup();
  const before = authFor('a@example.com', { refresh: 'rt-old' });
  const p = writeLive(ctx, before);
  const nextAccess = jwt({ exp: Math.floor(new Date('2026-02-01T00:00:00Z').getTime() / 1000) });
  const nextId = jwt({ email: 'a@example.com' });
  let seen = null;
  const fetch = async function (url, init) {
    seen = { url: url, init: init };
    return {
      ok: true,
      status: 200,
      json: async function () {
        return { access_token: nextAccess, refresh_token: 'rt-new', id_token: nextId };
      },
    };
  };
  const r = await refreshAuth({ authPath: p, fetch: fetch, now: '2026-01-01T00:00:00.000Z' });
  assert.strictEqual(seen.url, TOKEN_URL);
  const body = new URLSearchParams(seen.init.body);
  assert.strictEqual(body.get('grant_type'), 'refresh_token');
  assert.strictEqual(body.get('refresh_token'), 'rt-old');
  assert.strictEqual(body.get('client_id'), CLIENT_ID);
  assert.strictEqual(seen.init.method, 'POST');
  const written = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(written.tokens.access_token, nextAccess);
  assert.strictEqual(written.tokens.refresh_token, 'rt-new');
  assert.strictEqual(written.last_refresh, '2026-01-01T00:00:00.000Z');
  assert.strictEqual(r.previousRefreshToken, 'rt-old');
  assertPrivateMode(p);
});

test('refreshAuth leaves the file untouched when the server rejects the grant', async function () {
  const ctx = setup();
  const p = writeLive(ctx, authFor('a@example.com'));
  const before = fs.readFileSync(p, 'utf8');
  const fetch = async function () {
    return {
      ok: false,
      status: 400,
      json: async function () {
        return { error: 'invalid_grant', error_description: 'refresh token revoked' };
      },
    };
  };
  await assert.rejects(function () {
    return refreshAuth({ authPath: p, fetch: fetch });
  }, /HTTP 400.*invalid_grant/);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), before);
});

test('refreshLive skips a fresh token without calling the network', async function () {
  const ctx = setup();
  writeLive(ctx, authFor('a@example.com'));
  let called = false;
  const r = await refreshLive(ctx, {
    running: [],
    now: '2026-01-01T00:00:00.000Z',
    fetch: async function () {
      called = true;
      throw new Error('must not be called');
    },
  });
  assert.strictEqual(r.skipped, 'not-due');
  assert.strictEqual(called, false);
});

test('refreshLive never rotates under a running ChatGPT/Codex', async function () {
  const ctx = setup();
  writeLive(ctx, authFor('a@example.com', { exp: Math.floor(new Date('2026-01-01T01:00:00Z').getTime() / 1000) }));
  let called = false;
  const r = await refreshLive(ctx, {
    running: ['ChatGPT'],
    now: '2026-01-01T00:00:00.000Z',
    fetch: async function () {
      called = true;
      throw new Error('must not be called');
    },
  });
  assert.strictEqual(r.skipped, 'running');
  assert.strictEqual(called, false);
});

test('refreshLive rotates the live file and updates only the matching capture lineage', async function () {
  const ctx = setup();
  const expSoon = Math.floor(new Date('2026-01-01T01:00:00Z').getTime() / 1000);
  const live = authFor('a@example.com', { exp: expSoon, refresh: 'rt-shared' });
  writeLive(ctx, live);
  writeCapture(ctx, 'a', authFor('a@example.com', { exp: expSoon, refresh: 'rt-shared' }));
  writeCapture(ctx, 'b', authFor('b@example.com', { exp: expSoon, refresh: 'rt-other' }));
  const nextAccess = jwt({ exp: Math.floor(new Date('2026-02-01T00:00:00Z').getTime() / 1000) });
  const fetch = async function () {
    return {
      ok: true,
      status: 200,
      json: async function () {
        return { access_token: nextAccess, refresh_token: 'rt-shared-2' };
      },
    };
  };
  const r = await refreshLive(ctx, { running: [], now: '2026-01-01T00:00:00.000Z', fetch: fetch });
  assert.strictEqual(r.refreshed, true);
  assert.deepStrictEqual(r.updatedCaptures, ['a']);
  const liveAfter = JSON.parse(fs.readFileSync(authPath(ctx), 'utf8'));
  assert.strictEqual(liveAfter.tokens.refresh_token, 'rt-shared-2');
  const aAfter = JSON.parse(fs.readFileSync(path.join(accountDir(ctx, 'a'), 'auth.json'), 'utf8'));
  assert.strictEqual(aAfter.tokens.refresh_token, 'rt-shared-2');
  const bAfter = JSON.parse(fs.readFileSync(path.join(accountDir(ctx, 'b'), 'auth.json'), 'utf8'));
  assert.strictEqual(bAfter.tokens.refresh_token, 'rt-other');
});

test('removeCapture deletes only the saved copy', function () {
  const ctx = setup();
  writeCapture(ctx, 'a', authFor('a@example.com'));
  const r = removeCapture(ctx, 'a');
  assert.strictEqual(r.removed, 'a');
  assert.ok(!fs.existsSync(accountDir(ctx, 'a')));
});

// ---- MCP wiring ---------------------------------------------------------------------------

function mcpTool(name) {
  return TOOLS.filter(function (t) {
    return t.name === name;
  })[0];
}

test('MCP: keyflip_chatgpt* tools are mounted, read-only status works, writes gate on confirm', async function () {
  const statusTool = mcpTool('keyflip_chatgpt');
  assert.ok(statusTool, 'keyflip_chatgpt exists');
  assert.strictEqual(statusTool.annotations.readOnlyHint, true);
  const ctx = setup();
  writeLive(ctx, authFor('a@example.com'));
  const st = await statusTool.run(ctx, {});
  assert.strictEqual(st.tool, 'codex');
  assert.strictEqual(st.live.email, 'a@example.com');
  assert.ok(!JSON.stringify(st).includes('rt-a'), 'MCP status never returns a token');

  const cap = mcpTool('keyflip_chatgpt_capture');
  const sw = mcpTool('keyflip_chatgpt_switch');
  const rf = mcpTool('keyflip_chatgpt_refresh');
  assert.ok(cap && sw && rf, 'capture/switch/refresh are mounted');
  await assert.rejects(function () {
    return cap.run(ctx, {});
  }, /confirmation required/);
  await assert.rejects(function () {
    return sw.run(ctx, { account: 'a' });
  }, /confirmation required/);
  await assert.rejects(function () {
    return rf.run(ctx, {});
  }, /confirmation required/);
});

// ---- CLI wiring ---------------------------------------------------------------------------

const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');
function runCli(home, args) {
  return _child_process.spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      KEYFLIP_CONFIG_DIR: path.join(home, 'kfcfg'),
      CODEX_HOME: path.join(home, '.codex'),
    }),
  });
}

test('chatgpt/codex are recognized CLI commands with an empty, secret-free status', function () {
  const home = tmpdir();
  for (const name of ['chatgpt', 'codex']) {
    const r = runCli(home, [name, 'status', '--json']);
    assert.ok(!/unknown command/i.test(r.stdout + r.stderr), name + ' should be dispatched');
    const line = r.stdout.trim().split('\n').filter(Boolean).pop();
    const obj = JSON.parse(line);
    assert.strictEqual(obj.surface, 'codex');
    assert.strictEqual(obj.signedIn, false);
    assert.deepStrictEqual(obj.accounts, []);
  }
  const l = runCli(home, ['chatgpt', 'list', '--json']);
  assert.deepStrictEqual(JSON.parse(l.stdout.trim().split('\n').pop()).accounts, []);
});
