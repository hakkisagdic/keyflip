// #40 through the REAL CLI: `keyflip llm` must report and change which model runs the chores, and
// the chores must say what they are about to spend before they spend it. Spawned like
// test/cli.test.js (temp HOME + FileStore), so config.json writes are observable byte-for-byte.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import _child_process from 'child_process';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');

function mkhome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-llm-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 86400000 } }),
  );
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'alice@example.com' }, userID: 'u1' }),
  );
  // A `claude` on PATH, so "is the claude provider usable" has one answer here instead of depending
  // on whether the machine running the suite happens to have Claude Code installed.
  const bin = path.join(home, 'stubbin');
  fs.mkdirSync(bin, { recursive: true });
  const stub = path.join(bin, 'claude');
  fs.writeFileSync(stub, '#!/bin/sh\necho stub 1.0\n');
  fs.chmodSync(stub, 0o755);
  run(home, ['add']);
  return home;
}

function run(home, args, env) {
  return _child_process.spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8',
    timeout: 30000, // a chore call here is config reads + the stub; a hang must fail the test, not the suite
    env: Object.assign(
      {},
      process.env,
      {
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        KEYFLIP_CONFIG_DIR: path.join(home, '.config', 'keyflip'),
        APPDATA: path.join(home, 'AppData', 'Roaming'),
        KEYFLIP_TEST_CLAUDE: 'stopped',
        PATH: path.join(home, 'stubbin') + ':' + process.env.PATH,
      },
      env || {},
    ),
  });
}
const json = (out) => JSON.parse(out.slice(out.indexOf('{')));

// config.json only exists once something has been written — an untouched home reads as {}.
function cfg(home) {
  const p = path.join(home, '.config', 'keyflip', 'config.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

// One old transcript, so `dream` has a candidate to plan — the provider/cost line is part of the
// DRY RUN, which is the whole point (see the bill before it is spent).
function seedOldSession(home, id) {
  const dir = path.join(home, '.claude', 'projects', '-work');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.jsonl');
  const lines = [
    JSON.stringify({ type: 'queue-operation', sessionId: id, timestamp: '2026-07-01T00:00:00Z' }),
    JSON.stringify({
      type: 'user',
      sessionId: id,
      cwd: '/work',
      message: { role: 'user', content: [{ type: 'text', text: 'wire up the oauth refresh retry' }] },
    }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const old = Date.now() - 60 * 86400000;
  fs.utimesSync(file, new Date(old), new Date(old));
  return file;
}

test('keyflip llm defaults to claude and says whose quota that is', function () {
  const home = mkhome();
  const r = run(home, ['llm']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /provider: claude/);
  assert.match(r.stdout, /quota/i, 'it must name the quota it burns');
  assert.match(r.stdout, /dream/, 'and the commands it runs');
  const j = json(run(home, ['llm', '--json']).stdout);
  assert.strictEqual(j.llm.provider, 'claude');
  assert.strictEqual(j.llm.usable, true);
  assert.strictEqual(j.llm.needs_key, false);
  assert.strictEqual(j.llm.key_present, null, 'no key involved');
});

test('keyflip llm set --provider ollama moves the chores off the subscription', function () {
  const home = mkhome();
  const r = run(home, ['llm', 'set', '--provider', 'ollama', '--model', 'qwen2.5:7b-instruct']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /ollama qwen2\.5:7b-instruct/);
  assert.match(r.stdout, /local/i);
  const cfgFile = cfg(home);
  assert.strictEqual(cfgFile['llm.provider'], 'ollama');
  assert.strictEqual(cfgFile['llm.model'], 'qwen2.5:7b-instruct');
  // and the read-back agrees, without a shell variable in sight
  const j = json(run(home, ['llm', '--json']).stdout);
  assert.strictEqual(j.llm.provider, 'ollama');
  assert.strictEqual(j.llm.base_url, 'http://127.0.0.1:11434/v1', 'the provider default is applied');
});

test('an endpoint key is stored as a NAME only — and a key-shaped value is refused', function () {
  const home = mkhome();
  // The dangerous input: someone pastes the KEY where the NAME belongs.
  const bad = run(home, ['llm', 'set', '--provider', 'openai', '--key-env', 'sk-ant-api03-SUPERSECRETVALUE']);
  assert.notStrictEqual(bad.status, 0, 'a key value must not be accepted as an env name');
  assert.match(bad.stderr + bad.stdout, /NAME/, 'and the error must explain why');
  const cfgBad = fs.readFileSync(path.join(home, '.config', 'keyflip', 'config.json'), 'utf8');
  assert.ok(cfgBad.indexOf('SUPERSECRETVALUE') === -1, 'the secret must not reach disk');

  const good = run(home, [
    'llm',
    'set',
    '--provider',
    'openai',
    '--base-url',
    'https://gw.example.com/v1',
    '--key-env',
    'GW_KEY',
  ]);
  assert.strictEqual(good.status, 0, good.stderr);
  assert.match(good.stdout, /GW_KEY is not set in this shell/, 'presence is reported, the value never is');
  const cfg = fs.readFileSync(path.join(home, '.config', 'keyflip', 'config.json'), 'utf8');
  assert.match(cfg, /GW_KEY/);
  assert.ok(cfg.indexOf('Bearer') === -1);

  // With the variable actually exported, status flips to present — still printing no value.
  const withKey = run(home, ['llm', '--json'], { GW_KEY: 'sk-real-value-DO-NOT-PRINT' });
  const j = json(withKey.stdout);
  assert.strictEqual(j.llm.key_env, 'GW_KEY');
  assert.strictEqual(j.llm.key_present, true);
  assert.ok(withKey.stdout.indexOf('DO-NOT-PRINT') === -1, 'the value never appears in output');
});

test('a chore announces its provider + cost before it runs, and llm off puts it back', function () {
  const home = mkhome();
  seedOldSession(home, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  // dream is a dry run by default, so this is a pure read — but the cost line must already be there.
  const d = run(home, ['dream']);
  assert.strictEqual(d.status, 0, d.stderr);
  assert.match(d.stdout, /1 session\(s\) older than 30d/);
  assert.match(d.stdout, /distills via claude/, 'the plan names the model it would use');
  assert.match(d.stdout, /quota/i, 'and who pays for it');
  const dj = json(run(home, ['dream', '--json']).stdout);
  assert.strictEqual(dj.dream.provider, 'claude');
  assert.strictEqual(dj.dream.candidates, 1);

  run(home, ['llm', 'set', '--provider', 'ollama']);
  assert.match(run(home, ['dream']).stdout, /distills via ollama/);

  const off = run(home, ['llm', 'off']);
  assert.strictEqual(off.status, 0, off.stderr);
  assert.match(off.stdout, /claude -p/);
  assert.strictEqual(json(run(home, ['llm', '--json']).stdout).llm.provider, 'claude');
});

test('KEYFLIP_LLM_PROVIDER reroutes without touching shared state (the cron escape hatch)', function () {
  const home = mkhome();
  const before = fs.existsSync(path.join(home, '.config', 'keyflip', 'config.json'))
    ? fs.readFileSync(path.join(home, '.config', 'keyflip', 'config.json'), 'utf8')
    : '';
  const j = json(run(home, ['llm', '--json'], { KEYFLIP_LLM_PROVIDER: 'ollama' }).stdout);
  assert.strictEqual(j.llm.provider, 'ollama');
  assert.strictEqual(cfg(home)['llm.provider'], undefined, 'the override left no trace in config');
  const after = fs.existsSync(path.join(home, '.config', 'keyflip', 'config.json'))
    ? fs.readFileSync(path.join(home, '.config', 'keyflip', 'config.json'), 'utf8')
    : '';
  assert.strictEqual(after, before, 'reading a chore provider must not dirty the shared state repo');
});

// A cold local model takes MINUTES to load, so `llm test` must wait — and say how long it waited
// instead of reporting a slow model as a broken one. An endpoint that accepts and never answers
// proves the flag actually reaches the request.
test('llm test --timeout bounds the wait and names the load-time fix', async function () {
  const http = await import('http');
  const home = mkhome();
  const silent = http.createServer(function () {
    /* accept, then never respond — the cold-load case */
  });
  // listen() is async: address() is null until the socket is actually bound.
  await new Promise(function (res) {
    silent.listen(0, '127.0.0.1', res);
  });
  try {
    const port = silent.address().port;
    const r = run(home, ['llm', 'test', '--timeout', '400'], {
      KEYFLIP_LLM_PROVIDER: 'openai',
      KEYFLIP_LLM_BASE_URL: 'http://127.0.0.1:' + port + '/v1',
      KEYFLIP_LLM_KEY_ENV: 'TEST_GW',
      TEST_GW: 'sk-value-DO-NOT-PRINT',
    });
    const out = r.stdout + r.stderr;
    assert.notStrictEqual(r.status, 0, 'a silent endpoint fails the self-test');
    assert.match(out, /timed out after 400ms/, 'the --timeout value is what bounded the wait');
    assert.match(out, /--timeout|smaller --model/, 'and it names the remedy for a slow local model');
    assert.ok(out.indexOf('DO-NOT-PRINT') === -1, 'the key value never reaches the error text');
  } finally {
    // close() alone would keep the test process alive on the socket the CLI opened and never closed.
    if (silent.closeAllConnections) silent.closeAllConnections();
    await new Promise(function (res) {
      silent.close(res);
    });
  }
});
