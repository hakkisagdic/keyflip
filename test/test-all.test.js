// Tests for `keyflip test --all` and `doctor.runAll` (parallel provider health check).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import _child_process from 'child_process';
import { fileURLToPath } from 'url';
import * as doctor from '../src/doctor.js';
import * as provider from '../src/provider.js';
import { createContext } from '../src/context.js';
import { registerSecret } from '../src/redact.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');

function createTempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-testall-'));
  const claudeDir = path.join(home, '.claude');
  const configDir = path.join(home, '.config', 'keyflip');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  // Ensure FileStore is chosen on every OS (never touches the macOS Keychain).
  fs.writeFileSync(path.join(claudeDir, '.credentials.json'), '{}');
  // Pre-seed update cache so CLI runs never perform an external GitHub fetch.
  fs.writeFileSync(path.join(configDir, '.update-check.json'), JSON.stringify({ at: Date.now(), latest: null }));
  const ctx = createContext({ home: home, configDir: configDir, claudeDir: claudeDir });
  return { home: home, configDir: configDir, claudeDir: claudeDir, ctx: ctx };
}

function runCli(home, args) {
  return new Promise(function (resolve, reject) {
    const env = Object.assign({}, process.env, {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      KEYFLIP_CONFIG_DIR: path.join(home, '.config', 'keyflip'),
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      KEYFLIP_TEST_OFFLINE: '1',
      KEYFLIP_TEST_CLAUDE: 'stopped',
      KEYFLIP_VCS: 'off',
    });
    delete env.FORCE_COLOR;
    const child = _child_process.spawn(process.execPath, [BIN].concat(args), {
      env: env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', function (chunk) {
      stdout += chunk;
    });
    child.stderr.on('data', function (chunk) {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', function (code, signal) {
      resolve({ status: code, signal: signal, stdout: stdout, stderr: stderr });
    });
  });
}

function startStubServer(handler) {
  return new Promise(function (resolve, reject) {
    const server = http.createServer(function (req, res) {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', function (chunk) {
        body += chunk;
      });
      req.on('end', function () {
        handler(req, res, body);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', function () {
      const addr = server.address();
      resolve({
        server: server,
        baseUrl: 'http://127.0.0.1:' + addr.port,
        close: function () {
          return new Promise(function (resClose) {
            server.close(function () {
              resClose();
            });
          });
        },
      });
    });
  });
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

// ---- doctor.runAll unit tests ----

test('doctor.runAll returns [] for an empty provider list without calling testFn', async function () {
  let called = 0;
  const results = await doctor.runAll([], async function () {
    called++;
    return { ok: true };
  });
  assert.deepStrictEqual(results, []);
  assert.strictEqual(called, 0);
});

test('doctor.runAll bounds concurrency to at most 4 (explicit and default)', async function () {
  const names = ['p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07', 'p08', 'p09', 'p10'];

  for (const limit of [4, undefined]) {
    let inFlight = 0;
    let maxInFlight = 0;
    const results = await doctor.runAll(
      names,
      async function (name) {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await sleep(15);
        inFlight--;
        return { ok: true, httpStatus: 200, ms: 15, category: 'ok', tag: name };
      },
      limit,
    );
    assert.strictEqual(results.length, names.length);
    assert.ok(maxInFlight <= 4, 'concurrency exceeded 4: ' + maxInFlight);
    assert.ok(maxInFlight > 1, 'expected parallel execution (>1), got ' + maxInFlight);
    assert.deepStrictEqual(
      results.map(function (r) {
        return r.provider;
      }),
      names,
    );
  }
});

test('doctor.runAll preserves input order even when later providers finish first', async function () {
  const delays = { alpha: 60, beta: 5, gamma: 25 };
  const completionOrder = [];
  const results = await doctor.runAll(
    ['alpha', 'beta', 'gamma'],
    async function (name) {
      await sleep(delays[name]);
      completionOrder.push(name);
      return { ok: true, httpStatus: 200, ms: delays[name], category: 'ok' };
    },
    4,
  );
  assert.strictEqual(completionOrder[0], 'beta', 'beta should finish before alpha');
  assert.deepStrictEqual(
    results.map(function (r) {
      return r.provider;
    }),
    ['alpha', 'beta', 'gamma'],
  );
});

test('doctor.runAll isolates throws per provider and redacts secrets from reasons', async function () {
  const secret = ['fake', 'sec', 'runall', '7777'].join('-');
  registerSecret(secret);
  const results = await doctor.runAll(
    ['a', 'bad', 'c'],
    async function (name) {
      if (name === 'bad') throw new Error('boom ' + secret);
      return { ok: true, httpStatus: 200, ms: 1, category: 'ok' };
    },
    4,
  );
  assert.deepStrictEqual(
    results.map(function (r) {
      return r.provider;
    }),
    ['a', 'bad', 'c'],
  );
  assert.strictEqual(results[0].result.ok, true);
  assert.strictEqual(results[1].result.ok, false);
  assert.strictEqual(results[1].result.category, 'error');
  assert.match(results[1].result.reason, /boom/);
  assert.ok(!results[1].result.reason.includes(secret), 'secret leaked in error reason');
  assert.strictEqual(results[2].result.ok, true);
});

test('doctor.runAll preserves ok: null results (e.g. no-fetch)', async function () {
  const results = await doctor.runAll(['p1'], async function () {
    return { ok: null, category: 'no-fetch' };
  });
  assert.deepStrictEqual(results, [{ provider: 'p1', result: { ok: null, category: 'no-fetch' } }]);
});

// ---- CLI tests ----

test('CLI: keyflip test --all with zero providers exits non-zero and supports --json', async function () {
  const env = createTempHome();
  try {
    const r = await runCli(env.home, ['test', '--all']);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /no providers to test/i);

    const rj = await runCli(env.home, ['test', '--all', '--json']);
    assert.notStrictEqual(rj.status, 0);
    const parsed = JSON.parse(rj.stdout.trim());
    assert.strictEqual(parsed.schemaVersion, 1);
    assert.match(parsed.error.message, /no providers to test/i);
  } finally {
    fs.rmSync(env.home, { recursive: true, force: true });
  }
});

test('CLI: keyflip test rejects bare usage and --all combined with a provider name', async function () {
  const env = createTempHome();
  try {
    for (const args of [['test'], ['test', '--all', 'alpha'], ['test', 'alpha', '--all']]) {
      const r = await runCli(env.home, args);
      assert.strictEqual(r.status, 1, 'expected exit 1 for: ' + args.join(' '));
      assert.match(r.stderr, /usage: keyflip test <provider> \| --all/);
    }
  } finally {
    fs.rmSync(env.home, { recursive: true, force: true });
  }
});

test('CLI: keyflip test --all prints sorted order, summary, exit code 1 on failure, and redacts keys', async function () {
  const env = createTempHome();
  const alphaKey = ['fake', 'tok', 'alpha', '9999'].join('-');
  const betaKey = ['fake', 'tok', 'beta', '8888'].join('-');
  let stub = null;
  try {
    stub = await startStubServer(function (req, res) {
      if (req.method === 'POST' && req.url === '/alpha/v1/messages') {
        if (req.headers.authorization !== 'Bearer ' + alphaKey) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end('{"error":"bad auth"}');
          return;
        }
        setTimeout(function () {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        }, 40);
        return;
      }
      if (req.method === 'POST' && req.url === '/beta/v1/messages') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":"unauthorized"}');
        return;
      }
      res.writeHead(404);
      res.end();
    });

    // Add in reverse alphabetical order to verify provider.list sorting drives output order.
    provider.add(env.ctx, 'beta', { baseUrl: stub.baseUrl + '/beta', key: betaKey, authScheme: 'bearer' });
    provider.add(env.ctx, 'alpha', { baseUrl: stub.baseUrl + '/alpha', key: alphaKey, authScheme: 'bearer' });

    const r = await runCli(env.home, ['test', '--all']);
    assert.strictEqual(r.status, 1, r.stderr);
    const lines = r.stdout.trimEnd().split('\n');
    assert.strictEqual(lines.length, 3, 'stdout lines: ' + r.stdout);
    assert.match(lines[0], /^✓ alpha: ok \(\d+ms, http 200\)$/);
    assert.strictEqual(lines[1], '✗ beta: auth (http 401)');
    assert.strictEqual(lines[2], '1 ok, 1 failed');
    assert.ok(!r.stdout.includes(alphaKey) && !r.stderr.includes(alphaKey), 'alpha key must not appear in output');
    assert.ok(!r.stdout.includes(betaKey) && !r.stderr.includes(betaKey), 'beta key must not appear in output');

    const rj = await runCli(env.home, ['test', '--all', '--json']);
    assert.strictEqual(rj.status, 1, rj.stderr);
    const json = JSON.parse(rj.stdout.trim());
    assert.strictEqual(json.schemaVersion, 1);
    assert.strictEqual(json.ok, 1);
    assert.strictEqual(json.failed, 1);
    assert.strictEqual(json.results.length, 2);
    assert.strictEqual(json.results[0].provider, 'alpha');
    assert.strictEqual(json.results[0].result.ok, true);
    assert.strictEqual(json.results[0].result.httpStatus, 200);
    assert.strictEqual(json.results[1].provider, 'beta');
    assert.strictEqual(json.results[1].result.ok, false);
    assert.strictEqual(json.results[1].result.category, 'auth');
    assert.strictEqual(json.results[1].result.httpStatus, 401);
    assert.ok(!rj.stdout.includes(alphaKey) && !rj.stderr.includes(alphaKey));
    assert.ok(!rj.stdout.includes(betaKey) && !rj.stderr.includes(betaKey));
  } finally {
    if (stub) await stub.close();
    fs.rmSync(env.home, { recursive: true, force: true });
  }
});

test('CLI: keyflip test --all exits 0 when every provider succeeds (human and --json)', async function () {
  const env = createTempHome();
  const k1 = ['fake', 'tok', 'one', '1111'].join('-');
  const k2 = ['fake', 'tok', 'two', '2222'].join('-');
  let stub = null;
  try {
    stub = await startStubServer(function (req, res) {
      if (req.method === 'POST' && (req.url === '/one/v1/messages' || req.url === '/two/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(404);
      res.end();
    });

    provider.add(env.ctx, 'one', { baseUrl: stub.baseUrl + '/one', key: k1, authScheme: 'bearer' });
    provider.add(env.ctx, 'two', { baseUrl: stub.baseUrl + '/two', key: k2, authScheme: 'bearer' });

    const r = await runCli(env.home, ['test', '--all']);
    assert.strictEqual(r.status, 0, r.stderr);
    const lines = r.stdout.trimEnd().split('\n');
    assert.strictEqual(lines.length, 3);
    assert.match(lines[0], /^✓ one: ok \(\d+ms, http 200\)$/);
    assert.match(lines[1], /^✓ two: ok \(\d+ms, http 200\)$/);
    assert.strictEqual(lines[2], '2 ok, 0 failed');

    const rj = await runCli(env.home, ['test', '--all', '--json']);
    assert.strictEqual(rj.status, 0, rj.stderr);
    const json = JSON.parse(rj.stdout.trim());
    assert.strictEqual(json.schemaVersion, 1);
    assert.strictEqual(json.results.length, 2);
    assert.strictEqual(json.ok, 2);
    assert.strictEqual(json.failed, 0);
  } finally {
    if (stub) await stub.close();
    fs.rmSync(env.home, { recursive: true, force: true });
  }
});

test('CLI: single keyflip test <name> preserves existing output and exit behavior', async function () {
  const env = createTempHome();
  const okKey = ['fake', 'tok', 'single', '3333'].join('-');
  const badKey = ['fake', 'tok', 'bad', '4444'].join('-');
  let stub = null;
  try {
    stub = await startStubServer(function (req, res) {
      if (req.method === 'POST' && req.url === '/alpha/v1/messages') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      if (req.method === 'POST' && req.url === '/beta/v1/messages') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":"unauthorized"}');
        return;
      }
      res.writeHead(404);
      res.end();
    });

    provider.add(env.ctx, 'alpha', { baseUrl: stub.baseUrl + '/alpha', key: okKey, authScheme: 'bearer' });
    provider.add(env.ctx, 'beta', { baseUrl: stub.baseUrl + '/beta', key: badKey, authScheme: 'bearer' });

    const rOk = await runCli(env.home, ['test', 'alpha']);
    assert.strictEqual(rOk.status, 0, rOk.stderr);
    assert.match(rOk.stdout, /^✓ alpha: ok \(\d+ms, http 200\)\n$/);

    const rBad = await runCli(env.home, ['test', 'beta']);
    assert.strictEqual(rBad.status, 0, rBad.stderr);
    assert.strictEqual(rBad.stdout, '✗ beta: auth (http 401)\n');

    const rJson = await runCli(env.home, ['test', 'alpha', '--json']);
    assert.strictEqual(rJson.status, 0, rJson.stderr);
    const json = JSON.parse(rJson.stdout.trim());
    assert.strictEqual(json.schemaVersion, 1);
    assert.strictEqual(json.provider, 'alpha');
    assert.strictEqual(json.result.ok, true);
    assert.strictEqual(json.result.httpStatus, 200);
    assert.strictEqual(json.result.category, 'ok');
    assert.strictEqual(json.results, undefined);
  } finally {
    if (stub) await stub.close();
    fs.rmSync(env.home, { recursive: true, force: true });
  }
});
