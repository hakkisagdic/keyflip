// `keyflip conv` end to end: dispatch, JSON contract, auto-build on first search, Obsidian
// export and a handoff bundle. A tiny synthetic transcript; no real data or network.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import http from 'http';
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

function run(h, args, extraEnv) {
  return _child_process.spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8',
    env: Object.assign(
      {},
      process.env,
      {
        HOME: h,
        USERPROFILE: h,
        XDG_CONFIG_HOME: path.join(h, '.config'),
        KEYFLIP_CONFIG_DIR: path.join(h, '.config', 'keyflip'),
        APPDATA: path.join(h, 'AppData', 'Roaming'),
        CODEX_HOME: path.join(h, '.codex'),
        KEYFLIP_TEST_CLAUDE: 'stopped',
      },
      extraEnv || {},
    ),
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

test('conv index help and pacing flags (--no-embed, --embed-pause-ms, --embed-batch, --max-embed)', async function () {
  const h = home();
  const dir = path.join(h, '.claude', 'projects', '-work-proj');
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(
      path.join(dir, 'extra-' + i + '.jsonl'),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-01-0' + (i + 2) + 'T10:00:00.000Z',
        message: { role: 'user', content: 'Extra conversation ' + i + ' ' + 'w'.repeat(200) },
      }) + '\n',
    );
  }
  const help = run(h, ['conv', '--help']);
  const helpText = (help.stdout || '') + (help.stderr || '');
  assert.match(helpText, /--embed-pause-ms/);
  assert.match(helpText, /--embed-batch/);
  assert.match(helpText, /--max-embed/);
  assert.match(helpText, /--no-embed/);
  assert.match(helpText, /--rebuild-profanity/);

  const lexOnly = run(h, ['conv', 'index', '--no-embed', '--json']);
  assert.strictEqual(lexOnly.status, 0, lexOnly.stderr);
  assert.strictEqual(json(lexOnly).embedded, 0);

  const batches = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
    });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      batches.push(parsed.input.length);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ embeddings: parsed.input.map(() => new Array(8).fill(0.5)) }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const embedUrl = 'http://127.0.0.1:' + port + '/api/embed';
  try {
    const r = await new Promise((resolve, reject) => {
      const child = _child_process.spawn(
        process.execPath,
        [BIN, 'conv', 'index', '--embed', '--embed-pause-ms', '20', '--embed-batch', '2', '--max-embed', '2', '--json'],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: Object.assign({}, process.env, {
            HOME: h,
            USERPROFILE: h,
            XDG_CONFIG_HOME: path.join(h, '.config'),
            KEYFLIP_CONFIG_DIR: path.join(h, '.config', 'keyflip'),
            APPDATA: path.join(h, 'AppData', 'Roaming'),
            CODEX_HOME: path.join(h, '.codex'),
            KEYFLIP_EMBED_URL: embedUrl,
            KEYFLIP_TEST_CLAUDE: 'stopped',
          }),
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => {
        stdout += d;
      });
      child.stderr.on('data', (d) => {
        stderr += d;
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ status: code, stdout: stdout, stderr: stderr }));
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const out = json(r);
    assert.strictEqual(out.embedded, 2);
    assert.strictEqual(out.embedding.remainingSources, 2);
    assert.ok(batches.every((n) => n <= 2));

    const stHuman = run(h, ['conv', 'status'], { KEYFLIP_EMBED_URL: embedUrl });
    assert.strictEqual(stHuman.status, 0, stHuman.stderr);
    assert.match(stHuman.stdout, /pending:\s+2 chunk\(s\) across 2 conversation\(s\)/);
    assert.match(stHuman.stdout, /profanity filter:\s+on\s+·\s+0 chunk\(s\) masked/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(h, { recursive: true, force: true });
  }
});

test('conv CLI: --rebuild-profanity, status output, lexical search miss, and config off round-trip', function (t) {
  const h = home();
  t.after(() => fs.rmSync(h, { recursive: true, force: true }));

  const dir = path.join(h, '.claude', 'projects', '-work-proj');
  const profFile = path.join(dir, 'sess-prof.jsonl');
  const rawContent =
    JSON.stringify({
      type: 'user',
      timestamp: '2026-01-02T10:00:00.000Z',
      cwd: '/work/proj',
      message: { role: 'user', content: 'Bu siktir hatayı kubernetes podunda gördüm.' },
    }) + '\n';
  fs.writeFileSync(profFile, rawContent);

  const built = run(h, ['conv', 'index', '--rebuild-profanity', '--json']);
  assert.strictEqual(built.status, 0, built.stderr);
  const report = json(built);
  assert.strictEqual(report.profanityFilter, 'on');
  assert.strictEqual(report.profanityMasked, 1);
  assert.strictEqual(fs.readFileSync(profFile, 'utf8'), rawContent, 'source transcript untouched');

  const stJson = json(run(h, ['conv', 'status', '--json']));
  assert.strictEqual(stJson.profanityFilter, 'on');
  assert.strictEqual(stJson.profanityMasked, 1);

  const stText = run(h, ['conv', 'status']);
  assert.strictEqual(stText.status, 0, stText.stderr);
  assert.match(stText.stdout, /profanity filter:\s+on\s+·\s+1 chunk\(s\) masked/);

  const miss = json(run(h, ['conv', 'search', 'siktir', '--lexical', '--json']));
  assert.strictEqual(miss.hits.length, 0);

  const pack = json(run(h, ['conv', 'context', 'kubernetes', '--lexical', '--json']));
  assert.match(pack.context, /\[…\]/);
  assert.ok(!/siktir/i.test(pack.context));

  assert.strictEqual(run(h, ['config', 'set', 'conv.profanityFilter', 'off']).status, 0);
  const rebuiltOff = json(run(h, ['conv', 'index', '--json']));
  assert.strictEqual(rebuiltOff.profanityFilter, 'off');
  assert.strictEqual(rebuiltOff.profanityMasked, 0);

  const foundOff = json(run(h, ['conv', 'search', 'siktir', '--lexical', '--json']));
  assert.strictEqual(foundOff.hits.length, 1);
});

test('a deleted source is still listed, searched and shown from the index; no label leaks', function () {
  const h = home();
  const file = path.join(h, '.claude', 'projects', '-work-proj', 'sess-cli.jsonl');
  assert.strictEqual(run(h, ['conv', 'index', '--no-embed', '--json']).status, 0);
  fs.rmSync(file);
  const rebuilt = run(h, ['conv', 'index', '--no-embed', '--json']);
  assert.strictEqual(rebuilt.status, 0, rebuilt.stderr);

  const outs = [
    run(h, ['conv', 'list', '--json']),
    run(h, ['conv', 'search', 'database migration', '--json']),
    run(h, ['conv', 'status', '--json']),
    run(h, ['conv', 'context', 'database', '--json']),
  ];
  outs.forEach(function (o) {
    assert.strictEqual(o.status, 0, o.stderr);
    assert.ok(o.stdout.indexOf('sourceGoneAt') === -1, 'no internal field in output');
  });
  assert.strictEqual(json(outs[0]).conversations.length, 1);
  assert.strictEqual(json(outs[1]).hits[0].id, 'claude:local:sess-cli');

  const shown = run(h, ['conv', 'show', 'sess-cli', '--format', 'md']);
  assert.strictEqual(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /Check the database migration plan/);
  assert.match(shown.stdout, /dry-run mode first/);
  assert.match(shown.stdout, /shown from the index/);
  assert.ok(shown.stdout.indexOf('sourceGoneAt') === -1);
  const plain = run(h, ['conv', 'show', 'sess-cli']);
  assert.match(plain.stdout, /shown from the index/);
  const js = json(run(h, ['conv', 'show', 'sess-cli', '--json']));
  assert.strictEqual(js.conversation.fromIndex, true);

  const out = path.join(h, 'exp');
  const ex = run(h, ['conv', 'export', '--all', '--out', out, '--json']);
  assert.strictEqual(ex.status, 0, ex.stderr);
  assert.strictEqual(json(ex).files.length, 1);
  const vault = path.join(h, 'vault');
  const ob = run(h, ['conv', 'export', '--all', '--obsidian', '--out', vault, '--json']);
  assert.strictEqual(json(ob).written, 1);
});

test('conv forget refuses without --confirm, and with it removes only the index entry', function () {
  const h = home();
  const file = path.join(h, '.claude', 'projects', '-work-proj', 'sess-cli.jsonl');
  assert.strictEqual(run(h, ['conv', 'index', '--no-embed', '--json']).status, 0);
  const dry = run(h, ['conv', 'forget', 'sess-cli']);
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Would remove/);
  assert.strictEqual(json(run(h, ['conv', 'list', '--json'])).conversations.length, 1);
  const done = run(h, ['conv', 'forget', 'sess-cli', '--confirm']);
  assert.strictEqual(done.status, 0, done.stderr);
  assert.match(done.stdout, /removed from the index/);
  assert.strictEqual(json(run(h, ['conv', 'list', '--json'])).conversations.length, 0);
  assert.ok(fs.existsSync(file), 'the source file is untouched');
  const missing = run(h, ['conv', 'forget', 'sess-cli', '--confirm']);
  assert.notStrictEqual(missing.status, 0);
});

test('conv.keepDeleted accepts on/off through config set', function () {
  const h = home();
  const set = run(h, ['config', 'set', 'conv.keepDeleted', 'off']);
  assert.strictEqual(set.status, 0, set.stderr + set.stdout);
  const file = path.join(h, '.claude', 'projects', '-work-proj', 'sess-cli.jsonl');
  run(h, ['conv', 'index', '--no-embed', '--json']);
  fs.rmSync(file);
  run(h, ['conv', 'index', '--no-embed', '--json']);
  assert.strictEqual(json(run(h, ['conv', 'list', '--json'])).conversations.length, 0);
});
