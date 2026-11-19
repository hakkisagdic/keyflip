// Unit, K8 (read-only/no-locks/byte-identical), and K9 (allowlist/exclusion) tests for
// src/opencode.js against synthetic SQLite databases built with the local sqlite3 CLI.
import test from 'node:test';
import assert from 'node:assert';
import cp from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as opencode from '../src/opencode.js';
import * as conversations from '../src/conversations.js';
import * as convindex from '../src/convindex.js';
import { makeCtx } from './helpers.js';

function hasSqlite3() {
  const probe = cp.spawnSync('sqlite3', ['-version']);
  return !probe.error && probe.status === 0;
}

function sqlQuote(v) {
  if (v == null) return 'NULL';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function jstr(o) {
  return sqlQuote(JSON.stringify(o));
}

function buildSql(stmts) {
  return stmts.join('\n') + '\n';
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function makeOpencodeSchemaSql() {
  return [
    'CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);',
    'CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);',
    'CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);',
    'CREATE TABLE credential(id TEXT PRIMARY KEY, provider TEXT, token TEXT);',
    'CREATE TABLE account(id TEXT PRIMARY KEY, email TEXT, access_token TEXT);',
  ];
}

test('opencode.peekJsonType identifies safe top-level types and bails on escaped strings', function () {
  assert.strictEqual(opencode.peekJsonType('{"type":"tool","callID":"c1"}'), 'tool');
  assert.strictEqual(opencode.peekJsonType('{"id":"p1","messageID":"m1","type":"reasoning","text":"x"}'), 'reasoning');
  assert.strictEqual(opencode.peekJsonType('{"type":"text","text":"hello"}'), 'text');
  assert.strictEqual(opencode.peekJsonType('{"text":"contains \\"type\\":\\"tool\\"","type":"text"}'), null);
  assert.strictEqual(opencode.peekJsonType('{"metadata":{"nested":1},"type":"tool"}'), null);
});

test(
  'opencode.db: reads top-level user/assistant text parts in time_created order, follows text overflow, excludes K9 secrets & noise',
  { skip: hasSqlite3() ? false : 'sqlite3 CLI not installed' },
  async function () {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-oc-'));
    try {
      const ctx = makeCtx({ home: tmp });
      ctx.env = {};
      const ocDir = path.join(tmp, '.local', 'share', 'opencode');
      fs.mkdirSync(ocDir, { recursive: true });
      const dbFile = path.join(ocDir, 'opencode.db');

      const tokCred = 'sk-oc-' + 'cred-secret-77';
      const tokAcct = 'oauth-oc-' + 'acct-token-88';
      const tokChild = 'PLANTED_CHILD_SESSION_91';
      const tokTool = 'PLANTED_TOOL_OVERFLOW_92_' + 'X'.repeat(9000);
      const tokReason = 'PLANTED_REASONING_OVERFLOW_93_' + 'Y'.repeat(9000);
      const tokPatch = 'PLANTED_PATCH_94';
      const tokSynth = 'PLANTED_SYNTHETIC_95';
      const tokIgnored = 'PLANTED_IGNORED_96';
      const longUserText = 'markerv5opencode ' + 'overflow-text-'.repeat(700); // > 9 KB -> forces SQLite overflow pages

      const sql = buildSql(
        makeOpencodeSchemaSql().concat([
          'INSERT INTO credential VALUES(' +
            sqlQuote('c1') +
            ',' +
            sqlQuote('anthropic') +
            ',' +
            sqlQuote(tokCred) +
            ');',
          'INSERT INTO account VALUES(' +
            sqlQuote('a1') +
            ',' +
            sqlQuote('acct@' + 'example.test') +
            ',' +
            sqlQuote(tokAcct) +
            ');',

          // Older session first in table, newer second in table -> discover must order newest-first (ses_new first)
          'INSERT INTO session VALUES(' +
            [
              sqlQuote('ses_old'),
              sqlQuote('p1'),
              'NULL',
              sqlQuote('old-slug'),
              sqlQuote('/work/oc-old'),
              sqlQuote('Older Opencode Session'),
              1760000000000,
              1760000010000,
            ].join(',') +
            ');',
          'INSERT INTO session VALUES(' +
            [
              sqlQuote('ses_new'),
              sqlQuote('p1'),
              sqlQuote(''),
              sqlQuote('new-slug'),
              sqlQuote('/work/oc-new'),
              sqlQuote('Newer Opencode Session'),
              1761000000000,
              1761000500000,
            ].join(',') +
            ');',
          // Child/subagent session -> must be skipped
          'INSERT INTO session VALUES(' +
            [
              sqlQuote('ses_child'),
              sqlQuote('p1'),
              sqlQuote('ses_new'),
              sqlQuote('child-slug'),
              sqlQuote('/work/oc-new'),
              sqlQuote('Child Subagent Session'),
              1761000100000,
              1761000600000,
            ].join(',') +
            ');',

          // Insert assistant BEFORE user so time_created sort is proven
          'INSERT INTO message VALUES(' +
            [sqlQuote('m_asst'), sqlQuote('ses_new'), 1761000020000, 1761000020000, jstr({ role: 'assistant' })].join(
              ',',
            ) +
            ');',
          'INSERT INTO message VALUES(' +
            [sqlQuote('m_user'), sqlQuote('ses_new'), 1761000010000, 1761000010000, jstr({ role: 'user' })].join(',') +
            ');',
          'INSERT INTO message VALUES(' +
            [sqlQuote('m_old'), sqlQuote('ses_old'), 1760000001000, 1760000001000, jstr({ role: 'user' })].join(',') +
            ');',
          'INSERT INTO message VALUES(' +
            [sqlQuote('m_child'), sqlQuote('ses_child'), 1761000200000, 1761000200000, jstr({ role: 'user' })].join(
              ',',
            ) +
            ');',

          // Parts for ses_new
          'INSERT INTO part VALUES(' +
            [
              sqlQuote('p_user_1'),
              sqlQuote('m_user'),
              sqlQuote('ses_new'),
              1761000010001,
              1761000010001,
              jstr({ type: 'text', text: longUserText }),
            ].join(',') +
            ');',
          'INSERT INTO part VALUES(' +
            [
              sqlQuote('p_synth'),
              sqlQuote('m_user'),
              sqlQuote('ses_new'),
              1761000010002,
              1761000010002,
              jstr({ type: 'text', text: tokSynth, synthetic: true }),
            ].join(',') +
            ');',
          'INSERT INTO part VALUES(' +
            [
              sqlQuote('p_ignored'),
              sqlQuote('m_user'),
              sqlQuote('ses_new'),
              1761000010003,
              1761000010003,
              jstr({ type: 'text', text: tokIgnored, ignored: true }),
            ].join(',') +
            ');',

          // Parts out of time order within m_asst + non-text overflow parts
          'INSERT INTO part VALUES(' +
            [
              sqlQuote('p_asst_2'),
              sqlQuote('m_asst'),
              sqlQuote('ses_new'),
              1761000020020,
              1761000020020,
              jstr({ type: 'text', text: 'Second assistant paragraph.' }),
            ].join(',') +
            ');',
          'INSERT INTO part VALUES(' +
            [
              sqlQuote('p_tool'),
              sqlQuote('m_asst'),
              sqlQuote('ses_new'),
              1761000020005,
              1761000020005,
              jstr({ type: 'tool', output: tokTool }),
            ].join(',') +
            ');',
          'INSERT INTO part VALUES(' +
            [
              sqlQuote('p_reason'),
              sqlQuote('m_asst'),
              sqlQuote('ses_new'),
              1761000020006,
              1761000020006,
              jstr({ id: 'p_reason', type: 'reasoning', text: tokReason }),
            ].join(',') +
            ');',
          'INSERT INTO part VALUES(' +
            [
              sqlQuote('p_patch'),
              sqlQuote('m_asst'),
              sqlQuote('ses_new'),
              1761000020007,
              1761000020007,
              jstr({ type: 'patch', hash: tokPatch }),
            ].join(',') +
            ');',
          'INSERT INTO part VALUES(' +
            [
              sqlQuote('p_asst_1'),
              sqlQuote('m_asst'),
              sqlQuote('ses_new'),
              1761000020010,
              1761000020010,
              jstr({ type: 'text', text: 'First assistant paragraph.' }),
            ].join(',') +
            ');',

          // Older session + child session text parts
          'INSERT INTO part VALUES(' +
            [
              sqlQuote('p_old'),
              sqlQuote('m_old'),
              sqlQuote('ses_old'),
              1760000001001,
              1760000001001,
              jstr({ type: 'text', text: 'Legacy opencode question.' }),
            ].join(',') +
            ');',
          'INSERT INTO part VALUES(' +
            [
              sqlQuote('p_child'),
              sqlQuote('m_child'),
              sqlQuote('ses_child'),
              1761000200001,
              1761000200001,
              jstr({ type: 'text', text: tokChild }),
            ].join(',') +
            ');',
        ]),
      );
      cp.execFileSync('sqlite3', [dbFile], { input: sql });

      const disc = conversations.discover(ctx, {});
      assert.strictEqual(disc.length, 2, 'only two top-level sessions are discovered');
      assert.deepStrictEqual(
        disc.map((s) => s.sessionId),
        ['ses_new', 'ses_old'],
        'sessions ordered newest-first by time_updated',
      );
      assert.strictEqual(disc.storeIssues.length, 0);

      const convNew = conversations.load(ctx, disc[0], {});
      assert.strictEqual(convNew.id, 'opencode:ses_new');
      assert.strictEqual(convNew.app, 'opencode');
      assert.strictEqual(convNew.surface, 'cli');
      assert.strictEqual(convNew.title, 'Newer Opencode Session');
      assert.strictEqual(convNew.cwd, '/work/oc-new');
      assert.strictEqual(convNew.source.subId, 'ses_new');
      assert.deepStrictEqual(
        convNew.messages.map((m) => m.role),
        ['user', 'assistant'],
        'user precedes assistant by time_created despite opposite SQLite insert order',
      );
      assert.strictEqual(convNew.messages[0].text, longUserText.trim(), 'full overflow text preserved');
      assert.strictEqual(
        convNew.messages[1].text,
        'First assistant paragraph.\nSecond assistant paragraph.',
        'parts within message sorted by time_created',
      );

      // K8: Build index while holding another open r+ file descriptor on opencode.db; verify byte-identical & no -wal/-shm
      const beforeSha = sha256(dbFile);
      const beforeMtime = fs.statSync(dbFile).mtimeMs;
      const heldFd = fs.openSync(dbFile, 'r+');
      let buildReport;
      try {
        buildReport = await convindex.build(ctx, { embed: false });
      } finally {
        fs.closeSync(heldFd);
      }
      assert.strictEqual(buildReport.ok, true);
      assert.strictEqual(buildReport.stats.sources, 2);
      assert.strictEqual(sha256(dbFile), beforeSha, 'K8: opencode.db bytes unchanged');
      assert.strictEqual(fs.statSync(dbFile).mtimeMs, beforeMtime, 'K8: opencode.db mtime unchanged');
      assert.strictEqual(fs.existsSync(dbFile + '-wal'), false, 'K8: no -wal sidecar created');
      assert.strictEqual(fs.existsSync(dbFile + '-shm'), false, 'K8: no -shm sidecar created');

      // K9: Check all indexed chunk files on disk for zero leakage of planted secret/non-text values
      const chunksDir = path.join(ctx.configDir, 'conv-index', 'chunks');
      const chunkFiles = fs.readdirSync(chunksDir);
      assert.strictEqual(chunkFiles.length, 2);
      const allChunkContent = chunkFiles.map((f) => fs.readFileSync(path.join(chunksDir, f), 'utf8')).join('\n');
      for (const secret of [
        tokCred,
        tokAcct,
        'acct@' + 'example.test',
        tokChild,
        'PLANTED_TOOL_OVERFLOW_92',
        'PLANTED_REASONING_OVERFLOW_93',
        tokPatch,
        tokSynth,
        tokIgnored,
      ]) {
        assert.strictEqual(allChunkContent.indexOf(secret), -1, 'K9: ' + secret + ' must not enter indexed chunks');
      }

      const build2 = await convindex.build(ctx, { embed: false });
      assert.strictEqual(build2.changed, 0, 'incremental rebuild reuses both opencode sessions');

      const hit = await convindex.search(ctx, 'markerv5opencode', { apps: ['opencode'] });
      assert.strictEqual(hit.hits.length, 1);
      assert.strictEqual(hit.hits[0].id, 'opencode:ses_new');
    } finally {
      opencode.storeCache.clear();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
);

test(
  'opencode.db: corrupt database surfaces in storeIssues without hiding other apps, and WAL frames replay cleanly',
  { skip: hasSqlite3() ? false : 'sqlite3 CLI not installed' },
  function () {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-oc-err-'));
    try {
      const ctx = makeCtx({ home: tmp });
      ctx.env = {};
      const ocDir = path.join(tmp, '.local', 'share', 'opencode');
      fs.mkdirSync(ocDir, { recursive: true });
      const badDb = path.join(ocDir, 'opencode.db');
      fs.writeFileSync(badDb, 'not a sqlite database at all');

      // Seed a Claude transcript too — broken opencode DB must not hide Claude
      const claudeDir = path.join(tmp, '.claude', 'projects', '-p');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeDir, 'c1.jsonl'),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'Claude still works.' } }) + '\n',
      );

      const disc = conversations.discover(ctx, {});
      assert.strictEqual(disc.filter((s) => s.app === 'claude').length, 1);
      assert.strictEqual(disc.storeIssues.length, 1);
      assert.strictEqual(disc.storeIssues[0].app, 'opencode');
      assert.strictEqual(disc.storeIssues[0].path, badDb);

      // `--app claude` should NOT inherit opencode's storeIssue
      const claudeOnly = conversations.discover(ctx, { apps: ['claude'] });
      assert.strictEqual(claudeOnly.storeIssues.length, 0);

      // Test WAL overlay recovery without mutating the main DB file
      opencode.storeCache.clear();
      fs.rmSync(badDb, { force: true });
      cp.execFileSync('sqlite3', [badDb], {
        input:
          'PRAGMA journal_mode=WAL;\n' +
          makeOpencodeSchemaSql().join('\n') +
          "\nINSERT INTO session VALUES('ses_wal','p',NULL,'s','/work/wal','WAL Title',1762000000000,1762000005000);\n" +
          "INSERT INTO message VALUES('m1','ses_wal',1762000001000,1762000001000,'{\"role\":\"user\"}');\n" +
          'INSERT INTO part VALUES(\'p1\',\'m1\',\'ses_wal\',1762000001001,1762000001001,\'{"type":"text","text":"Hello from WAL"}\');\n',
      });
      const discWal = conversations.discover(ctx, { apps: ['opencode'] });
      assert.strictEqual(discWal.length, 1);
      assert.strictEqual(discWal[0].sessionId, 'ses_wal');
      const conv = conversations.load(ctx, discWal[0], {});
      assert.strictEqual(conv.messages[0].text, 'Hello from WAL');
    } finally {
      opencode.storeCache.clear();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
);
