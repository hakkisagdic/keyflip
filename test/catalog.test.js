// #1 (Phase 0b): the bundled provider catalog. Pure data + one models probe, so
// these tests pin: every preset is usable as-is (id/URL/compat), the URL the
// probe derives, the auth header it sends, that a key never comes back in the
// result, and that `provider add <id>` needs nothing but a key.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import _child_process from 'child_process';
import { fileURLToPath } from 'url';
import * as catalog from '../src/catalog.js';
import * as provider from '../src/provider.js';
import { makeCtx } from './helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');

function fakeFetch(res) {
  const calls = [];
  const fn = async function (url, opts) {
    calls.push({ url: url, opts: opts });
    return {
      ok: (res.status || 200) < 400,
      status: res.status || 200,
      text: async function () {
        return typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
      },
    };
  };
  fn.calls = calls;
  return fn;
}

test('catalog: every preset has a unique id, an http(s) URL and a known compat', function () {
  const rows = catalog.list();
  assert.ok(rows.length >= 15, 'expected the full preset table, got ' + rows.length);
  const seen = {};
  rows.forEach(function (e) {
    assert.match(e.id, /^[a-z0-9][a-z0-9._-]*$/, 'bad id ' + e.id);
    assert.strictEqual(seen[e.id], undefined, 'duplicate id ' + e.id);
    seen[e.id] = true;
    assert.match(e.baseUrl, /^https?:\/\//, e.id + ' needs an http(s) base URL');
    assert.ok(e.compat === 'anthropic' || e.compat === 'openai', e.id + ' has compat ' + e.compat);
    assert.ok(e.authScheme === 'bearer' || e.authScheme === 'api-key', e.id + ' has authScheme ' + e.authScheme);
    assert.ok(e.name && e.category, e.id + ' needs a name and a category');
  });
  // The one endpoint Claude Code can be pointed at with no shim must be here.
  assert.strictEqual(catalog.get('zai').compat, 'anthropic');
  // And the OpenAI-API side must be labelled as such, not silently offered.
  assert.strictEqual(catalog.get('openai').compat, 'openai');
  assert.strictEqual(catalog.get('nope'), null);
  assert.strictEqual(catalog.get('ZAI').id, 'zai', 'lookup is case-insensitive');
});

test('catalog: modelsUrl derives /models from a /v1 base or /v1/models from a host', function () {
  assert.strictEqual(catalog.modelsUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/models');
  assert.strictEqual(catalog.modelsUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1/models');
  assert.strictEqual(catalog.modelsUrl('https://api.anthropic.com'), 'https://api.anthropic.com/v1/models');
  assert.strictEqual(catalog.modelsUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1/models');
});

test('catalog: authHeaders follows the scheme and never invents a key', function () {
  assert.deepStrictEqual(catalog.authHeaders({ authScheme: 'bearer' }, null), {});
  assert.deepStrictEqual(catalog.authHeaders({ authScheme: 'bearer', compat: 'openai' }, 'k'), {
    authorization: 'Bearer k',
  });
  assert.deepStrictEqual(catalog.authHeaders({ authScheme: 'api-key', compat: 'anthropic' }, 'k'), {
    'x-api-key': 'k',
    'anthropic-version': '2023-06-01',
  });
});

test('catalog: fetchModels parses data[].id and returns no key', async function () {
  const ctx = makeCtx();
  const fetchMock = fakeFetch({ status: 200, body: { data: [{ id: 'glm-4.6' }, { id: 'glm-4.5-air' }] } });
  const r = await catalog.fetchModels(
    ctx,
    { baseUrl: 'https://api.z.ai/api/anthropic', authScheme: 'bearer', compat: 'anthropic' },
    { fetch: fetchMock, key: 'sk-live-secret' },
  );
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.models, ['glm-4.6', 'glm-4.5-air']);
  assert.strictEqual(fetchMock.calls[0].url, 'https://api.z.ai/api/anthropic/v1/models');
  assert.strictEqual(fetchMock.calls[0].opts.headers.authorization, 'Bearer sk-live-secret');
  assert.strictEqual(JSON.stringify(r).indexOf('sk-live-secret'), -1, 'the key must not be echoed back');
});

test('catalog: fetchModels reports auth/reachability failures instead of throwing', async function () {
  const ctx = makeCtx();
  const unauthorized = await catalog.fetchModels(
    ctx,
    { baseUrl: 'https://api.z.ai/api/anthropic' },
    { fetch: fakeFetch({ status: 401, body: { error: 'no' } }), key: 'k' },
  );
  assert.strictEqual(unauthorized.ok, false);
  assert.strictEqual(unauthorized.status, 401);
  const down = await catalog.fetchModels(
    ctx,
    { baseUrl: 'https://api.z.ai/api/anthropic' },
    {
      fetch: async function () {
        throw new Error('ECONNREFUSED');
      },
    },
  );
  assert.strictEqual(down.ok, false);
  assert.match(down.error, /ECONNREFUSED/);
  // An unknown-shape body is not a crash either.
  const odd = await catalog.fetchModels(
    ctx,
    { baseUrl: 'https://x/v1' },
    { fetch: fakeFetch({ status: 200, body: 'nope' }) },
  );
  assert.strictEqual(odd.ok, false);
  assert.match(odd.error, /no model list/);
});

test('provider add with a catalog id persists baseUrl/compat/models from the preset', function () {
  const ctx = makeCtx();
  const preset = catalog.get('zai');
  const meta = provider.add(ctx, 'zai', {
    baseUrl: preset.baseUrl,
    authScheme: preset.authScheme,
    compat: preset.compat,
    models: preset.models,
  });
  const disk = JSON.parse(fs.readFileSync(provider.metaPath(ctx, 'zai'), 'utf8'));
  assert.strictEqual(disk.baseUrl, 'https://api.z.ai/api/anthropic');
  assert.strictEqual(disk.compat, 'anthropic');
  assert.strictEqual(disk.models.default, preset.models.default);
  assert.strictEqual(meta.schemaVersion, 2);
});

// ---- CLI: the catalog is reachable without a saved account and needs only a key ----

function run(home, args, stdin) {
  const res = _child_process.spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8',
    input: stdin || '',
    env: Object.assign({}, process.env, {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      KEYFLIP_CONFIG_DIR: path.join(home, '.config', 'keyflip'),
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      KEYFLIP_TEST_CLAUDE: 'stopped',
    }),
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

test('CLI: provider catalog --json lists the presets; add <id> needs only a key', function () {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-catalog-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"live":"TOKEN"}');

  const cat = run(home, ['provider', 'catalog', '--json']);
  assert.strictEqual(cat.code, 0, cat.err);
  const rows = JSON.parse(cat.out).catalog;
  assert.ok(
    rows.some(function (e) {
      return e.id === 'zai' && /^https:\/\//.test(e.baseUrl);
    }),
  );
  assert.ok(cat.out.indexOf('sk-') === -1 || !/key/i.test(cat.out), 'the catalog is non-secret');

  const add = run(home, ['provider', 'add', 'zai', '--key-file', '-'], 'sk-catalog-secret\n');
  assert.strictEqual(add.code, 0, add.err + add.out);
  assert.match(add.out, /api\.z\.ai/);
  const meta = JSON.parse(fs.readFileSync(path.join(home, '.config', 'keyflip', 'providers', 'zai.json'), 'utf8'));
  assert.strictEqual(meta.baseUrl, 'https://api.z.ai/api/anthropic');
  assert.strictEqual(meta.compat, 'anthropic');
  assert.strictEqual(meta.models.default, 'glm-4.6');
  assert.strictEqual(JSON.stringify(meta).indexOf('sk-catalog-secret'), -1, 'key never lands in the metadata file');

  // A preset under a custom name, with the OpenAI-API warning surfaced.
  const from = run(home, ['provider', 'add', 'my-router', '--from', 'openrouter', '--key-file', '-'], 'sk-or\n');
  assert.strictEqual(from.code, 0, from.err + from.out);
  assert.match(from.out, /OpenAI chat API/);
  const m2 = JSON.parse(fs.readFileSync(path.join(home, '.config', 'keyflip', 'providers', 'my-router.json'), 'utf8'));
  assert.strictEqual(m2.compat, 'openai');
  assert.match(m2.baseUrl, /openrouter\.ai/);
});

// spawnSync blocks the event loop, which would starve an in-process fake server;
// the models test needs the async form.
function runAsync(home, args, stdin) {
  return new Promise(function (resolve) {
    const child = _child_process.spawn(process.execPath, [BIN].concat(args), {
      env: Object.assign({}, process.env, {
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        KEYFLIP_CONFIG_DIR: path.join(home, '.config', 'keyflip'),
        APPDATA: path.join(home, 'AppData', 'Roaming'),
        KEYFLIP_TEST_CLAUDE: 'stopped',
      }),
    });
    let out = '',
      err = '';
    child.stdout.on('data', function (d) {
      out += d;
    });
    child.stderr.on('data', function (d) {
      err += d;
    });
    child.on('close', function (code) {
      resolve({ code: code, out: out, err: err });
    });
    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

test('CLI: provider models asks the saved endpoint and shows what it serves', async function () {
  const http = await import('http');
  const got = [];
  const srv = http.createServer(function (req, res) {
    got.push({ url: req.url, auth: req.headers.authorization || null });
    res.writeHead(req.url === '/v1/models' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'local-a' }, { id: 'local-b' }] }));
  });
  await new Promise(function (r) {
    srv.listen(0, '127.0.0.1', r);
  });
  const port = srv.address().port;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-catalog-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"live":"TOKEN"}');
  try {
    const add = await runAsync(
      home,
      ['provider', 'add', 'local', '--base-url', 'http://127.0.0.1:' + port + '/v1', '--key-file', '-'],
      'sk-local\n',
    );
    assert.strictEqual(add.code, 0, add.err);
    const res = await runAsync(home, ['provider', 'models', 'local', '--json']);
    assert.strictEqual(res.code, 0, res.err);
    const parsed = JSON.parse(res.out);
    assert.deepStrictEqual(parsed.result.models, ['local-a', 'local-b']);
    assert.strictEqual(parsed.url, 'http://127.0.0.1:' + port + '/v1/models');
    assert.strictEqual(got[0].url, '/v1/models');
    assert.strictEqual(got[0].auth, 'Bearer sk-local');
    assert.strictEqual(res.out.indexOf('sk-local'), -1, 'never print the key');
  } finally {
    await new Promise(function (r) {
      srv.close(r);
    });
  }
});

test('CLI: provider add rejects an unknown preset id and a missing base_url', function () {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-catalog-'));
  const bad = run(home, ['provider', 'add', 'not-a-preset', '--key-file', '-'], 'k\n');
  assert.notStrictEqual(bad.code, 0);
  assert.match(bad.err + bad.out, /--base-url|usage/i);
});
