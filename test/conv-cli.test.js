// `keyflip conv` end to end: dispatch, JSON contract, auto-build on first search, Obsidian
// export and a handoff bundle. A tiny synthetic transcript; no real data or network.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import _child_process from 'child_process';
import { fileURLToPath } from 'url';
import * as commands from '../src/commands.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');

function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-conv-'));
  const dir = path.join(h, '.claude', 'projects', '-work-proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'sess-cli.jsonl'),
    [
      {
        type: 'user',
        timestamp: '2026-01-01T10:00:00.000Z',
        cwd: '/work/proj',
        message: { role: 'user', content: 'Check the database migration plan.' },
      },
      {
        type: 'assistant',
        timestamp: '2026-01-01T10:00:01.000Z',
        message: { role: 'assistant', content: 'Run it in dry-run mode first.' },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
  );
  return h;
}

function run(h, args) {
  return _child_process.spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      HOME: h,
      USERPROFILE: h,
      XDG_CONFIG_HOME: path.join(h, '.config'),
      KEYFLIP_CONFIG_DIR: path.join(h, '.config', 'keyflip'),
      APPDATA: path.join(h, 'AppData', 'Roaming'),
      CODEX_HOME: path.join(h, '.codex'),
      KEYFLIP_TEST_CLAUDE: 'stopped',
    }),
  });
}

function json(r) {
  const line = r.stdout.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(line);
}

test('conv is a registered, safe command with a tool-agnostic description', function () {
  const row = commands.CATALOG.filter(function (c) {
    return c.name === 'conv';
  })[0];
  assert.ok(row, 'conv missing from the command catalog');
  assert.strictEqual(row.safe, true);
  assert.match(row.desc, /every local AI tool/i);
});

test('search auto-builds the index once, then list/search/context/show work', function () {
  const h = home();
  const first = run(h, ['conv', 'search', 'database migration', '--json']);
  assert.strictEqual(first.status, 0, first.stderr);
  const s = json(first);
  assert.strictEqual(s.mode, 'lexical'); // no vectors: honest label
  assert.strictEqual(s.hits.length, 1);
  assert.strictEqual(s.hits[0].id, 'claude:local:sess-cli');

  const st = json(run(h, ['conv', 'status', '--json']));
  assert.strictEqual(st.exists, true);
  assert.strictEqual(st.stats.sources, 1);
  assert.strictEqual(st.vectorChunks, 0);

  const list = json(run(h, ['conv', 'list', '--json']));
  assert.strictEqual(list.indexed, true);
  assert.strictEqual(list.conversations.length, 1);
  assert.strictEqual(list.conversations[0].title, 'Check the database migration plan.');

  const pack = json(run(h, ['conv', 'context', 'database', '--json', '--budget', '2000']));
  assert.match(pack.context, /^# Conversation context/);
  assert.match(pack.context, /dry-run/);

  const shown = run(h, ['conv', 'show', 'sess-cli', '--format', 'md']);
  assert.strictEqual(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /Check the database migration plan/);
  assert.match(shown.stdout, /Run it in dry-run mode first/);
});

test('export --all --obsidian and transfer write files the user can open', function () {
  const h = home();
  const vault = path.join(h, 'vault');
  const exp = run(h, ['conv', 'export', '--all', '--obsidian', '--out', vault, '--json']);
  assert.strictEqual(exp.status, 0, exp.stderr);
  const report = json(exp);
  assert.strictEqual(report.written, 1);
  assert.ok(fs.existsSync(report.index));
  assert.ok(fs.existsSync(report.rows[0].file));

  const out = path.join(h, 'handoff');
  const tr = run(h, ['conv', 'transfer', 'sess-cli', '--to', 'claude', '--out', out, '--json']);
  assert.strictEqual(tr.status, 0, tr.stderr);
  const bundle = json(tr);
  assert.strictEqual(bundle.target, 'claude');
  ['conversation.json', 'CONTINUE.md', 'README.md'].forEach(function (f) {
    assert.ok(fs.existsSync(path.join(out, f)), 'missing ' + f);
  });
  assert.match(fs.readFileSync(path.join(out, 'CONTINUE.md'), 'utf8'), /Continue this conversation/);
});

test('an unknown subcommand falls back to list rather than "unknown command"', function () {
  const h = home();
  const r = run(h, ['conv', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = json(r);
  assert.strictEqual(out.conversations.length, 1);
});

test('conv index --watch reports changes on stdout as JSON and stays incremental', async function () {
  const h = home();
  const r = await new Promise(function (resolve) {
    const p = _child_process.spawn(process.execPath, [BIN, 'conv', 'index', '--watch', '--interval', '1', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, {
        HOME: h,
        USERPROFILE: h,
        XDG_CONFIG_HOME: path.join(h, '.config'),
        KEYFLIP_CONFIG_DIR: path.join(h, '.config', 'keyflip'),
        APPDATA: path.join(h, 'AppData', 'Roaming'),
        CODEX_HOME: path.join(h, '.codex'),
        KEYFLIP_TEST_CLAUDE: 'stopped',
      }),
    });
    let out = '';
    p.stdout.on('data', function (d) {
      out += d;
    });
    // The FIRST tick indexes the seeded transcript and must report it. We do not wait a full
    // interval for a second tick: the incremental re-pickup is proven by the follow-up build.
    setTimeout(function () {
      p.kill();
      resolve(out);
    }, 8000);
  });
  const line = r.trim().split('\n').filter(Boolean).pop();
  const report = JSON.parse(line);
  assert.strictEqual(report.watched, true);
  assert.strictEqual(report.report.ok, true);
  assert.strictEqual(report.report.changed, 1);

  // A turn appended AFTER the watcher ran is picked up by the next incremental pass...
  const dir = path.join(h, '.claude', 'projects', '-work-proj');
  fs.appendFileSync(
    path.join(dir, 'sess-cli.jsonl'),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'A totally new topic appeared: zeppelin maintenance.' },
    }) + '\n',
  );
  const again = json(run(h, ['conv', 'index', '--json']));
  assert.strictEqual(again.changed, 1); // only the appended conversation
  // ...and search finds it immediately.
  const found = run(h, ['conv', 'search', 'zeppelin maintenance', '--json']);
  assert.strictEqual(found.status, 0, found.stderr);
  assert.strictEqual(json(found).hits.length, 1);
});
