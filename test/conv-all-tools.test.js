// End-to-end CLI acceptance tests for K1 (cap fix + fair multi-app budget + truncated count)
// and K5 (all 5 new readers searchable via `conv index --no-embed` -> `conv search` -> `conv show`).
import test from 'node:test';
import assert from 'node:assert';
import cp from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');

function hasSqlite3() {
  const probe = cp.spawnSync('sqlite3', ['-version']);
  return !probe.error && probe.status === 0;
}

function runCli(h, args, extraEnv) {
  return cp.spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8',
    env: Object.assign(
      {},
      process.env,
      {
        HOME: h,
        USERPROFILE: h,
        XDG_CONFIG_HOME: path.join(h, '.config'),
        XDG_DATA_HOME: path.join(h, '.local', 'share'),
        KEYFLIP_CONFIG_DIR: path.join(h, '.config', 'keyflip'),
        APPDATA: path.join(h, 'AppData', 'Roaming'),
        CODEX_HOME: path.join(h, '.codex'),
        KEYFLIP_TEST_CLAUDE: 'stopped',
      },
      extraEnv || {},
    ),
  });
}

function lastJson(r) {
  return JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop());
}

function sqlQuote(v) {
  return v == null ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'";
}

function seedOpencodeDb(home, marker, title, updatedMs) {
  const ocDir = path.join(home, '.local', 'share', 'opencode');
  fs.mkdirSync(ocDir, { recursive: true });
  const db = path.join(ocDir, 'opencode.db');
  const sql = [
    'CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);',
    'CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);',
    'CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);',
    'INSERT INTO session VALUES(' +
      [
        sqlQuote('ses_k_1'),
        sqlQuote('p1'),
        'NULL',
        sqlQuote('slug-1'),
        sqlQuote('/work/oc'),
        sqlQuote(title),
        updatedMs - 2000,
        updatedMs,
      ].join(',') +
      ');',
    'INSERT INTO message VALUES(' +
      [
        sqlQuote('m1'),
        sqlQuote('ses_k_1'),
        updatedMs - 1500,
        updatedMs - 1500,
        sqlQuote(JSON.stringify({ role: 'user' })),
      ].join(',') +
      ');',
    'INSERT INTO message VALUES(' +
      [
        sqlQuote('m2'),
        sqlQuote('ses_k_1'),
        updatedMs - 500,
        updatedMs - 500,
        sqlQuote(JSON.stringify({ role: 'assistant' })),
      ].join(',') +
      ');',
    'INSERT INTO part VALUES(' +
      [
        sqlQuote('p1'),
        sqlQuote('m1'),
        sqlQuote('ses_k_1'),
        updatedMs - 1400,
        updatedMs - 1400,
        sqlQuote(JSON.stringify({ type: 'text', text: marker + ' question from opencode' })),
      ].join(',') +
      ');',
    'INSERT INTO part VALUES(' +
      [
        sqlQuote('p2'),
        sqlQuote('m2'),
        sqlQuote('ses_k_1'),
        updatedMs - 400,
        updatedMs - 400,
        sqlQuote(JSON.stringify({ type: 'text', text: 'Answer from opencode reader.' })),
      ].join(',') +
      ');',
  ].join('\n');
  cp.execFileSync('sqlite3', [db], { input: sql + '\n' });
  return db;
}

test(
  'K1: 5,200 newer Kiro sessions never starve smaller tools; tight --limit-sources prints truncated count and preserves every app',
  { skip: hasSqlite3() ? false : 'sqlite3 CLI not installed' },
  function () {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-k1-'));
    try {
      const kiroCli = path.join(h, '.kiro', 'sessions', 'cli');
      const qoderProj = path.join(h, '.qoder', 'projects', '-work-q');
      const copilotDir = path.join(h, '.copilot', 'session-state', 'cp-k1');
      const grokDir = path.join(h, '.grok', 'sessions', '%2Fwork%2Fg', 'g-k1');
      const ccDir = path.join(h, '.commandcode', 'projects', '-work-cc');
      [kiroCli, qoderProj, copilotDir, grokDir, ccDir].forEach((d) => fs.mkdirSync(d, { recursive: true }));

      const baseMs = Date.UTC(2026, 10, 15, 12, 0, 0);
      const kiroLine = JSON.stringify({ kind: 'Prompt', data: { content: [{ kind: 'text', data: 'hi' }] } }) + '\n';
      for (let i = 0; i < 5200; i++) {
        const f = path.join(kiroCli, 'k' + String(i).padStart(4, '0') + '.jsonl');
        fs.writeFileSync(f, kiroLine);
      }

      const oldTime = new Date(baseMs - 3600 * 1000);
      const qoderFile = path.join(qoderProj, 'q1.jsonl');
      fs.writeFileSync(
        qoderFile,
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'Qoder prompt' } }) + '\n',
      );
      fs.utimesSync(qoderFile, oldTime, oldTime);

      const cpFile = path.join(copilotDir, 'events.jsonl');
      fs.writeFileSync(cpFile, JSON.stringify({ type: 'user.message', data: { content: 'Copilot prompt' } }) + '\n');
      fs.utimesSync(cpFile, oldTime, oldTime);

      const gFile = path.join(grokDir, 'chat_history.jsonl');
      fs.writeFileSync(gFile, JSON.stringify({ type: 'user', content: 'Grok prompt' }) + '\n');
      fs.utimesSync(gFile, oldTime, oldTime);

      const ccFile = path.join(ccDir, 'cc1.jsonl');
      fs.writeFileSync(
        ccFile,
        JSON.stringify({ sessionId: 'cc1', role: 'user', content: [{ type: 'text', text: 'Command Code prompt' }] }) +
          '\n',
      );
      fs.utimesSync(ccFile, oldTime, oldTime);

      seedOpencodeDb(h, 'k1oc', 'Opencode K1', oldTime.getTime());

      const idx = runCli(h, ['conv', 'index', '--no-embed', '--json']);
      assert.strictEqual(idx.status, 0, idx.stderr);

      const st = lastJson(runCli(h, ['conv', 'status', '--json']));
      assert.strictEqual(st.candidateSources, 5205);
      assert.strictEqual(st.truncated, 0);
      assert.strictEqual(st.stats.byApp.kiro.sources, 5200);
      for (const app of ['qoder', 'copilot', 'grok', 'opencode', 'command-code']) {
        assert.strictEqual(st.stats.byApp[app].sources, 1, app + ' must not be starved by 5,200 Kiro files');
      }

      const cfg2 = path.join(h, 'cfg-limited');
      const capped = runCli(h, ['conv', 'index', '--no-embed', '--limit-sources', '100'], {
        KEYFLIP_CONFIG_DIR: cfg2,
      });
      assert.strictEqual(capped.status, 0, capped.stderr);
      assert.match(capped.stdout, /5,?105\s+source\(s\)\s+truncated/i);

      const st2 = lastJson(runCli(h, ['conv', 'status', '--json'], { KEYFLIP_CONFIG_DIR: cfg2 }));
      assert.strictEqual(st2.stats.sources, 100);
      for (const app of ['kiro', 'qoder', 'copilot', 'grok', 'opencode', 'command-code']) {
        assert.ok(st2.stats.byApp[app] && st2.stats.byApp[app].sources >= 1, app + ' survives tight 100-source cap');
      }
    } finally {
      fs.rmSync(h, { recursive: true, force: true });
    }
  },
);

test(
  'K5: copilot, grok, opencode, vscode-chat, and cowork index, search (--app), and show end to end',
  { skip: hasSqlite3() ? false : 'sqlite3 CLI not installed' },
  function () {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-k5-'));
    try {
      // 1. Copilot CLI
      const cpDir = path.join(h, '.copilot', 'session-state', 'cp-k5');
      fs.mkdirSync(cpDir, { recursive: true });
      fs.writeFileSync(path.join(cpDir, 'workspace.yaml'), 'id: cp-k5\nname: Copilot K5 Session\ncwd: /work/cp\n');
      fs.writeFileSync(
        path.join(cpDir, 'events.jsonl'),
        [
          { type: 'session.start', data: { sessionId: 'cp-k5', context: { cwd: '/work/cp' } } },
          { type: 'user.message', data: { content: 'k5copilotq91 how do retries work?' } },
          { type: 'assistant.message', data: { content: 'Use bounded jitter.', toolRequests: [{ name: 'bash' }] } },
        ]
          .map((x) => JSON.stringify(x))
          .join('\n') + '\n',
      );

      // 2. Grok
      const gDir = path.join(h, '.grok', 'sessions', '%2Fwork%2Fgrok', 'g-k5');
      fs.mkdirSync(gDir, { recursive: true });
      fs.writeFileSync(
        path.join(gDir, 'summary.json'),
        JSON.stringify({ info: { id: 'g-k5', cwd: '/work/grok' }, session_summary: 'Grok K5 Session' }),
      );
      fs.writeFileSync(
        path.join(gDir, 'chat_history.jsonl'),
        [
          { type: 'user', content: [{ type: 'text', text: 'k5grokx82 optimize queue' }] },
          { type: 'assistant', content: 'Batch items by window.' },
        ]
          .map((x) => JSON.stringify(x))
          .join('\n') + '\n',
      );

      // 3. opencode
      seedOpencodeDb(h, 'k5opencodev73', 'Opencode K5 Session', Date.UTC(2026, 10, 15, 11, 0, 0));

      // 4. VS Code chatSessions
      const vsDir = path.join(
        h,
        'Library',
        'Application Support',
        'Code',
        'User',
        'workspaceStorage',
        'ws1',
        'chatSessions',
      );
      fs.mkdirSync(vsDir, { recursive: true });
      fs.writeFileSync(
        path.join(h, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage', 'ws1', 'workspace.json'),
        JSON.stringify({ folder: 'file:///work/vscode' }),
      );
      fs.writeFileSync(
        path.join(vsDir, 'vs-k5.jsonl'),
        [
          {
            kind: 0,
            v: {
              sessionId: 'vs-k5',
              customTitle: 'VSCode K5 Session',
              creationDate: 1762000000000,
              requests: [
                {
                  message: { text: 'k5vscodez64 inspect patch stream' },
                  response: [{ value: 'Replay kind 0/1/2 lines.' }],
                },
              ],
            },
          },
        ]
          .map((x) => JSON.stringify(x))
          .join('\n') + '\n',
      );

      // 5. Claude Desktop Cowork audit.jsonl
      const cwParent = path.join(
        h,
        'Library',
        'Application Support',
        'Claude',
        'local-agent-mode-sessions',
        'acct-1',
        'org-1',
      );
      const cwDir = path.join(cwParent, 'local_cwk5');
      fs.mkdirSync(cwDir, { recursive: true });
      fs.writeFileSync(
        path.join(cwParent, 'local_cwk5.json'),
        JSON.stringify({
          sessionId: 'cw-k5',
          title: 'Cowork K5 Session',
          cwd: '/work/cowork',
          createdAt: 1762100000000,
        }),
      );
      fs.writeFileSync(
        path.join(cwDir, 'audit.jsonl'),
        [
          {
            type: 'user',
            _audit_timestamp: '2026-11-15T10:00:01.000Z',
            message: { role: 'user', content: 'k5coworkm55 check audit log' },
          },
          {
            type: 'assistant',
            _audit_timestamp: '2026-11-15T10:00:02.000Z',
            message: { role: 'assistant', content: [{ type: 'text', text: 'Audit log verified.' }] },
          },
        ]
          .map((x) => JSON.stringify(x))
          .join('\n') + '\n',
      );

      const idx = runCli(h, ['conv', 'index', '--no-embed', '--json']);
      assert.strictEqual(idx.status, 0, idx.stderr);

      const st = lastJson(runCli(h, ['conv', 'status', '--json']));
      const expected = [
        { app: 'copilot', marker: 'k5copilotq91', title: 'Copilot K5 Session' },
        { app: 'grok', marker: 'k5grokx82', title: 'Grok K5 Session' },
        { app: 'opencode', marker: 'k5opencodev73', title: 'Opencode K5 Session' },
        { app: 'vscode-chat', marker: 'k5vscodez64', title: 'VSCode K5 Session' },
        { app: 'cowork', marker: 'k5coworkm55', title: 'Cowork K5 Session' },
      ];
      for (const spec of expected) {
        assert.strictEqual(st.stats.byApp[spec.app].sources, 1, spec.app + ' should have 1 indexed source');
        const sr = runCli(h, ['conv', 'search', spec.marker, '--app', spec.app, '--json']);
        assert.strictEqual(sr.status, 0, sr.stderr);
        const searchJson = lastJson(sr);
        assert.strictEqual(searchJson.hits.length, 1, spec.app + ' search should return 1 hit');
        assert.strictEqual(searchJson.hits[0].app, spec.app);
        assert.strictEqual(searchJson.hits[0].title, spec.title);

        const sh = runCli(h, ['conv', 'show', searchJson.hits[0].id, '--json']);
        assert.strictEqual(sh.status, 0, sh.stderr);
        const showJson = lastJson(sh);
        assert.strictEqual(showJson.conversation.title, spec.title);
        assert.deepStrictEqual(
          showJson.conversation.messages.map((m) => m.role),
          ['user', 'assistant'],
        );
      }
    } finally {
      fs.rmSync(h, { recursive: true, force: true });
    }
  },
);
