import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as provider from '../src/provider.js';
import * as settings from '../src/settings.js';
import { makeCtx } from './helpers.js';
import _child_process from 'child_process';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function ctxWithSettings() {
  const ctx = makeCtx();
  ctx.claudeSettingsPath = path.join(ctx.home, '.claude', 'settings.json');
  return ctx;
}

// ---- #4 settings helpers ----
test('credential-shaped keys are detected but plural *_TOKENS limits are not', function () {
  ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MY_SECRET', 'FOO_TOKEN', 'DB_PASSWORD'].forEach(function (k) {
    assert.strictEqual(settings.isCredentialKey(k), true, k);
  });
  ['MAX_OUTPUT_TOKENS', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_MAX_TOKENS'].forEach(function (k) {
    assert.strictEqual(settings.isCredentialKey(k), false, k);
  });
});

test('deepMerge merges nested objects and null deletes a key', function () {
  const r = settings.deepMerge({ env: { A: 1, B: 2 }, x: 1 }, { env: { B: 9, C: 3 }, x: null });
  assert.deepStrictEqual(r, { env: { A: 1, B: 9, C: 3 } });
});

// ---- #1 provider switching ----
test('provider add stores metadata on disk and the key in the credential store (not the file)', function () {
  const ctx = ctxWithSettings();
  provider.add(ctx, 'relay', {
    baseUrl: 'https://relay.example/v1',
    key: 'sk-secret',
    authScheme: 'bearer',
    models: { default: 'claude-x' },
  });
  const meta = JSON.parse(fs.readFileSync(provider.metaPath(ctx, 'relay'), 'utf8'));
  assert.strictEqual(meta.baseUrl, 'https://relay.example/v1');
  assert.doesNotMatch(JSON.stringify(meta), /sk-secret/); // key NOT in the file
  assert.strictEqual(ctx.store.getProfile('provider__relay'), 'sk-secret'); // key IS in the store
});

test('use injects the managed env block; off removes exactly those keys, keeping user env', function () {
  const ctx = ctxWithSettings();
  // user already has their own settings + an env var
  fs.mkdirSync(path.dirname(ctx.claudeSettingsPath), { recursive: true });
  fs.writeFileSync(ctx.claudeSettingsPath, JSON.stringify({ theme: 'dark', env: { MY_VAR: '1' }, hooks: { x: 1 } }));

  provider.add(ctx, 'relay', {
    baseUrl: 'https://relay.example/v1',
    key: 'sk-1',
    authScheme: 'bearer',
    models: { haiku: 'h-model' },
  });
  provider.use(ctx, 'relay');
  let cfg = JSON.parse(fs.readFileSync(ctx.claudeSettingsPath, 'utf8'));
  assert.strictEqual(cfg.env.ANTHROPIC_BASE_URL, 'https://relay.example/v1');
  assert.strictEqual(cfg.env.ANTHROPIC_AUTH_TOKEN, 'sk-1');
  assert.strictEqual(cfg.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'h-model');
  assert.strictEqual(cfg.env.MY_VAR, '1'); // user env preserved
  assert.strictEqual(cfg.theme, 'dark'); // user settings preserved
  assert.deepStrictEqual(cfg.hooks, { x: 1 });
  assert.strictEqual(provider.readActive(ctx).name, 'relay');

  provider.useOfficial(ctx);
  cfg = JSON.parse(fs.readFileSync(ctx.claudeSettingsPath, 'utf8'));
  assert.strictEqual(cfg.env && cfg.env.ANTHROPIC_BASE_URL, undefined); // managed keys gone
  assert.strictEqual(cfg.env.MY_VAR, '1'); // user env still there
  assert.strictEqual(provider.readActive(ctx), null);
});

test("switching between two providers does not leak the first one's keys", function () {
  const ctx = ctxWithSettings();
  provider.add(ctx, 'a', { baseUrl: 'https://a/v1', key: 'ka', authScheme: 'api-key' });
  provider.add(ctx, 'b', { baseUrl: 'https://b/v1', key: 'kb', authScheme: 'bearer' });
  provider.use(ctx, 'a');
  provider.use(ctx, 'b');
  const cfg = JSON.parse(fs.readFileSync(ctx.claudeSettingsPath, 'utf8'));
  assert.strictEqual(cfg.env.ANTHROPIC_BASE_URL, 'https://b/v1');
  assert.strictEqual(cfg.env.ANTHROPIC_AUTH_TOKEN, 'kb');
  assert.strictEqual(cfg.env.ANTHROPIC_API_KEY, undefined); // a's api-key scheme not left behind
});

// ---- #14 speedtest ----
test('speedtest picks the fastest reachable endpoint and updates base_url', async function () {
  const ctx = ctxWithSettings();
  provider.add(ctx, 'multi', {
    baseUrl: 'https://slow/v1',
    endpointCandidates: ['https://slow/v1', 'https://fast/v1'],
  });
  let t = 0;
  const clock = function () {
    return t;
  };
  const fetchMock = async function (url) {
    // fast responds after 100ms, slow after 900ms
    t += url.indexOf('fast') !== -1 ? 100 : 900;
    return { ok: true, status: 200 };
  };
  const r = await provider.speedtest(ctx, 'multi', { fetch: fetchMock, clock: clock });
  assert.strictEqual(r.chosen, 'https://fast/v1');
  assert.strictEqual(provider.read(ctx, 'multi').baseUrl, 'https://fast/v1');
});

test('speedtest noPersist ranks without mutating base_url (read-only MCP diagnostic)', async function () {
  const ctx = ctxWithSettings();
  provider.add(ctx, 'multi', {
    baseUrl: 'https://slow/v1',
    endpointCandidates: ['https://slow/v1', 'https://fast/v1'],
  });
  let t = 0;
  const clock = function () {
    return t;
  };
  const fetchMock = async function (url) {
    t += url.indexOf('fast') !== -1 ? 100 : 900;
    return { ok: true, status: 200 };
  };
  const r = await provider.speedtest(ctx, 'multi', { fetch: fetchMock, clock: clock, noPersist: true });
  assert.strictEqual(r.fastest, 'https://fast/v1', 'still reports the fastest');
  assert.strictEqual(r.persisted, false);
  assert.strictEqual(provider.read(ctx, 'multi').baseUrl, 'https://slow/v1', 'base_url is NOT changed');
});

// ---- spawned CLI ----
test('CLI: provider add (key via stdin) -> use -> status -> off', function () {
  const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-prov-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"T"}}');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } }));
  function run(args, input) {
    return _child_process.spawnSync(process.execPath, [BIN].concat(args), {
      encoding: 'utf8',
      input: input,
      env: Object.assign({}, process.env, {
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        CCSWITCH_TEST_CLAUDE: 'stopped',
        KEYFLIP_TEST_CLAUDE: 'stopped',
      }),
    });
  }
  let r = run(['provider', 'add', 'relay', '--base-url', 'https://relay.example/v1', '--key-file', '-'], 'sk-piped\n');
  assert.strictEqual(r.status, 0, r.stderr);
  r = run(['use', 'relay']);
  assert.strictEqual(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.strictEqual(cfg.env.ANTHROPIC_AUTH_TOKEN, 'sk-piped');
  assert.match(run(['status']).stdout, /provider "relay"/);
  r = run(['provider', 'off']);
  assert.strictEqual(r.status, 0, r.stderr);
  const cfg2 = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.strictEqual(cfg2.env && cfg2.env.ANTHROPIC_BASE_URL, undefined);
});
