import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as provider from '../src/provider.js';
import * as settings from '../src/settings.js';
import { makeCtx, assertPrivateMode } from './helpers.js';
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

// ---- #15 provider fork ----
test('provider fork copies metadata (mode 0600) and stored key by default (K1)', function () {
  let now = '2026-01-01T00:00:00.000Z';
  const ctx = makeCtx({
    now: function () {
      return now;
    },
  });
  const syntheticKey = ['sk', 'fork', 'secret', 'one'].join('-');
  provider.add(ctx, 'src', {
    baseUrl: 'https://relay.example/v1',
    key: syntheticKey,
    authScheme: 'api-key',
    compat: 'openai',
    models: { default: 'm1', haiku: 'm2' },
    endpointCandidates: ['https://relay.example/v1', 'https://alt.example/v1'],
  });

  now = '2026-01-02T00:00:00.000Z';
  const r = provider.fork(ctx, 'src', 'dest');
  assert.strictEqual(r.keyCopied, true);
  assert.strictEqual(r.meta.name, 'dest');
  assert.strictEqual(r.meta.savedAt, '2026-01-02T00:00:00.000Z');
  assert.strictEqual(r.meta.baseUrl, 'https://relay.example/v1');
  assert.strictEqual(r.meta.authScheme, 'api-key');
  assert.strictEqual(r.meta.compat, 'openai');
  assert.deepStrictEqual(r.meta.models, { default: 'm1', haiku: 'm2' });
  assert.deepStrictEqual(r.meta.endpointCandidates, ['https://relay.example/v1', 'https://alt.example/v1']);

  const destFile = provider.metaPath(ctx, 'dest');
  assertPrivateMode(destFile);
  const rawDest = fs.readFileSync(destFile, 'utf8');
  assert.strictEqual(rawDest.indexOf(syntheticKey), -1, 'key must not appear in metadata file');
  assert.strictEqual(ctx.store.getProfile(provider.keyStoreName('dest')), syntheticKey);
});

test('provider fork with { noKey: true } copies metadata only and skips stored key (K2)', function () {
  const ctx = ctxWithSettings();
  const syntheticKey = ['sk', 'fork', 'secret', 'two'].join('-');
  provider.add(ctx, 'src', {
    baseUrl: 'https://relay.example/v1',
    key: syntheticKey,
    authScheme: 'bearer',
    models: { default: 'm1' },
  });

  const r = provider.fork(ctx, 'src', 'destNoKey', { noKey: true });
  assert.strictEqual(r.keyCopied, false);
  assert.strictEqual(r.meta.name, 'destNoKey');
  assert.strictEqual(r.meta.baseUrl, 'https://relay.example/v1');
  assert.strictEqual(r.meta.authScheme, 'bearer');
  assert.deepStrictEqual(r.meta.models, { default: 'm1' });
  assertPrivateMode(provider.metaPath(ctx, 'destNoKey'));
  assert.strictEqual(ctx.store.getProfile(provider.keyStoreName('destNoKey')), null);
});

test('provider fork when source has no stored key returns keyCopied=false (K3)', function () {
  const ctx = ctxWithSettings();
  provider.add(ctx, 'nokey', {
    baseUrl: 'https://nokey.example/v1',
    authScheme: 'bearer',
  });

  const r = provider.fork(ctx, 'nokey', 'nokeyCopy');
  assert.strictEqual(r.keyCopied, false);
  assertPrivateMode(provider.metaPath(ctx, 'nokeyCopy'));
  assert.strictEqual(ctx.store.getProfile(provider.keyStoreName('nokeyCopy')), null);
});

test('provider fork leaves source, active provider, and settings.json untouched (K4)', function () {
  const ctx = ctxWithSettings();
  const syntheticKey = ['sk', 'fork', 'active', 'four'].join('-');
  provider.add(ctx, 'src', {
    baseUrl: 'https://relay.example/v1',
    key: syntheticKey,
    authScheme: 'bearer',
    models: { sonnet: 's1' },
  });
  provider.use(ctx, 'src');

  const srcBytesBefore = fs.readFileSync(provider.metaPath(ctx, 'src'), 'utf8');
  const activeBytesBefore = fs.readFileSync(provider.activePath(ctx), 'utf8');
  const settingsBytesBefore = fs.readFileSync(ctx.claudeSettingsPath, 'utf8');
  const srcKeyBefore = ctx.store.getProfile(provider.keyStoreName('src'));

  provider.fork(ctx, 'src', 'dest');

  assert.strictEqual(fs.readFileSync(provider.metaPath(ctx, 'src'), 'utf8'), srcBytesBefore);
  assert.strictEqual(fs.readFileSync(provider.activePath(ctx), 'utf8'), activeBytesBefore);
  assert.strictEqual(fs.readFileSync(ctx.claudeSettingsPath, 'utf8'), settingsBytesBefore);
  assert.strictEqual(ctx.store.getProfile(provider.keyStoreName('src')), srcKeyBefore);
});

test('provider fork refuses missing source and writes nothing (K5)', function () {
  const ctx = ctxWithSettings();
  assert.throws(function () {
    provider.fork(ctx, 'nope', 'dest');
  }, /no such provider/);
  assert.strictEqual(provider.exists(ctx, 'dest'), false);
  assert.strictEqual(ctx.store.getProfile(provider.keyStoreName('dest')), null);
});

test('provider fork refuses existing destination and src === dest without overwriting (K6)', function () {
  const ctx = ctxWithSettings();
  const srcKey = ['sk', 'fork', 'src', 'six'].join('-');
  const destKey = ['sk', 'fork', 'dest', 'six'].join('-');
  provider.add(ctx, 'src', { baseUrl: 'https://src.example/v1', key: srcKey });
  provider.add(ctx, 'dest', { baseUrl: 'https://dest.example/v1', key: destKey });

  const destBytesBefore = fs.readFileSync(provider.metaPath(ctx, 'dest'), 'utf8');
  const srcBytesBefore = fs.readFileSync(provider.metaPath(ctx, 'src'), 'utf8');

  assert.throws(function () {
    provider.fork(ctx, 'src', 'dest');
  }, /already exists/);
  assert.strictEqual(fs.readFileSync(provider.metaPath(ctx, 'dest'), 'utf8'), destBytesBefore);
  assert.strictEqual(ctx.store.getProfile(provider.keyStoreName('dest')), destKey);

  assert.throws(function () {
    provider.fork(ctx, 'src', 'src');
  }, /already exists/);
  assert.strictEqual(fs.readFileSync(provider.metaPath(ctx, 'src'), 'utf8'), srcBytesBefore);
  assert.strictEqual(ctx.store.getProfile(provider.keyStoreName('src')), srcKey);
});

test('provider fork refuses invalid destination names and rolls back meta if setProfile throws (K7)', function () {
  const ctx = ctxWithSettings();
  const srcKey = ['sk', 'fork', 'src', 'seven'].join('-');
  provider.add(ctx, 'src', { baseUrl: 'https://src.example/v1', key: srcKey });

  ['../escape', '-bad', '.hidden', '__proto__', '', 'a/b'].forEach(function (bad) {
    assert.throws(function () {
      provider.fork(ctx, 'src', bad);
    }, /invalid provider name/);
  });
  assert.deepStrictEqual(provider.list(ctx), ['src']);

  const origSetProfile = ctx.store.setProfile.bind(ctx.store);
  ctx.store.setProfile = function (name, val) {
    if (name === provider.keyStoreName('boom')) {
      throw new Error('store write failed');
    }
    return origSetProfile(name, val);
  };

  assert.throws(function () {
    provider.fork(ctx, 'src', 'boom');
  }, /store write failed/);
  assert.strictEqual(fs.existsSync(provider.metaPath(ctx, 'boom')), false);
});

test('CLI: provider fork copies key or skips with --no-key, never prints key, refuses invalid calls (K8)', function () {
  const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-prov-fork-'));
  const cliKey = ['sk', 'fork', 'cli', 'secret', '99'].join('-');
  try {
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
          KEYFLIP_TEST_OFFLINE: '1',
        }),
      });
    }

    let r = run(
      ['provider', 'add', 'relay', '--base-url', 'https://relay.example/v1', '--key-file', '-'],
      cliKey + '\n',
    );
    assert.strictEqual(r.status, 0, r.stderr);

    r = run(['provider', 'fork', 'relay', 'relay-copy']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /forked provider relay -> relay-copy \(key copied\)/);
    assert.strictEqual((r.stdout + r.stderr).indexOf(cliKey), -1, 'CLI output must not print the key');

    const copyMetaFile = path.join(home, '.config', 'keyflip', 'providers', 'relay-copy.json');
    assertPrivateMode(copyMetaFile);
    assert.strictEqual(fs.readFileSync(copyMetaFile, 'utf8').indexOf(cliKey), -1);

    r = run(['use', 'relay-copy']);
    assert.strictEqual(r.status, 0, r.stderr);
    const cfgCopy = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    assert.strictEqual(cfgCopy.env.ANTHROPIC_AUTH_TOKEN, cliKey);

    r = run(['provider', 'fork', 'relay', 'relay-nokey', '--no-key', '--json']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual((r.stdout + r.stderr).indexOf(cliKey), -1, 'CLI --json output must not print the key');
    const jsonOut = JSON.parse(r.stdout);
    assert.deepStrictEqual(
      {
        from: jsonOut.from,
        to: jsonOut.to,
        baseUrl: jsonOut.baseUrl,
        keyCopied: jsonOut.keyCopied,
      },
      {
        from: 'relay',
        to: 'relay-nokey',
        baseUrl: 'https://relay.example/v1',
        keyCopied: false,
      },
    );
    assert.match(r.stderr, /no key copied/);

    r = run(['use', 'relay-nokey']);
    assert.strictEqual(r.status, 0, r.stderr);
    const cfgNoKey = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    assert.strictEqual(cfgNoKey.env.ANTHROPIC_BASE_URL, 'https://relay.example/v1');
    assert.strictEqual(cfgNoKey.env.ANTHROPIC_AUTH_TOKEN, undefined);

    [
      ['provider', 'fork', 'relay', 'relay-copy'],
      ['provider', 'fork', 'missing', 'relay-new'],
      ['provider', 'fork', 'relay', '../bad'],
      ['provider', 'fork', 'relay'],
      ['provider', 'fork', 'relay', 'relay-x', '--bogus'],
    ].forEach(function (args) {
      const bad = run(args);
      assert.notStrictEqual(bad.status, 0, 'expected non-zero exit for: ' + args.join(' '));
      assert.strictEqual((bad.stdout + bad.stderr).indexOf(cliKey), -1, 'refusal output must not print key');
    });
    assert.strictEqual(fs.existsSync(path.join(home, '.config', 'keyflip', 'providers', 'relay-new.json')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
