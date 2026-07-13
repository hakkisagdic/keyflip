'use strict';
// Wave-4 Context Layer CLI arg-parsing regressions (found by the adversarial review):
//   - `context decision/task add` must not grab a preceding flag's VALUE as the title.
//   - `checkpoint create` must not fold the --tasks-file path (or its value) into the summary.
// These run the real CLI in a throwaway project dir so `.keyflip/` is created in tmp, never the repo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');

function tmpEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-ctxcli-home-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-ctxcli-proj-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return { home: home, proj: proj };
}
// Run the CLI in `proj` as cwd (so context/checkpoint write .keyflip/ there), isolated HOME/config.
function run(env, args) {
  return require('child_process').spawnSync(process.execPath, [BIN].concat(args), {
    cwd: env.proj,
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      HOME: env.home, USERPROFILE: env.home,
      XDG_CONFIG_HOME: path.join(env.home, '.config'),
      KEYFLIP_CONFIG_DIR: path.join(env.home, '.config', 'keyflip'),
      APPDATA: path.join(env.home, 'AppData', 'Roaming'),
      KEYFLIP_TEST_CLAUDE: 'stopped',
      KEYFLIP_VCS: 'off',
    }),
  });
}

test('context decision add: a leading value-flag does not steal the title', function () {
  const env = tmpEnv();
  assert.strictEqual(run(env, ['context', 'init']).status, 0);
  const r = run(env, ['context', 'decision', 'add', '--status', 'rejected', 'My real decision', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout.trim());
  assert.strictEqual(o.title, 'My real decision', 'title is the positional, not the --status value');
  assert.strictEqual(o.status, 'rejected', '--status still parsed');
});

test('context decision add: title before flags still works', function () {
  const env = tmpEnv();
  run(env, ['context', 'init']);
  const r = run(env, ['context', 'decision', 'add', 'Use Postgres', '--rationale', 'ACID', '--do-not', 'SQLite in prod', '--json']);
  const o = JSON.parse(r.stdout.trim());
  assert.strictEqual(o.title, 'Use Postgres');
});

test('context task add: title is the positional, not a preceding flag value', function () {
  const env = tmpEnv();
  run(env, ['context', 'init']);
  const r = run(env, ['context', 'task', 'add', 'Wire the webhook', '--json']);
  const o = JSON.parse(r.stdout.trim());
  assert.strictEqual(o.title, 'Wire the webhook');
});

test('checkpoint create: --tasks-file path is not recorded as the summary', function () {
  const env = tmpEnv();
  fs.writeFileSync(path.join(env.proj, 't.json'), '{}');
  const r = run(env, ['checkpoint', 'create', '--tasks-file', 't.json', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout.trim());
  assert.strictEqual(o.checkpoint.summary, '', 'no --summary given → empty, NOT the tasks-file path');
});

test('checkpoint create: a real summary is kept and the --tasks-file path is not appended', function () {
  const env = tmpEnv();
  fs.writeFileSync(path.join(env.proj, 't.json'), '{}');
  const r = run(env, ['checkpoint', 'create', 'shipped auth', '--tasks-file', 't.json', '--json']);
  const o = JSON.parse(r.stdout.trim());
  assert.strictEqual(o.checkpoint.summary, 'shipped auth', 'positional summary kept, path excluded');
});
