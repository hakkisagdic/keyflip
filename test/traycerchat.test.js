// Unit, discovery, allow-list privacy, corrupt-file, and E2E index/search tests for src/traycerchat.js.
import test from 'node:test';
import assert from 'node:assert';
import cp from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import * as traycerchat from '../src/traycerchat.js';
import * as conversations from '../src/conversations.js';
import * as convaccounts from '../src/convaccounts.js';
import { makeCtx } from './helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');

function runCli(home, args) {
  return cp.spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      KEYFLIP_CONFIG_DIR: path.join(home, '.config', 'keyflip'),
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      CODEX_HOME: path.join(home, '.codex'),
      KEYFLIP_TEST_CLAUDE: 'stopped',
    }),
  });
}

function lastJson(res) {
  return JSON.parse(res.stdout.trim().split('\n').filter(Boolean).pop());
}

test('traycerchat: parses role-marked and unmarked plain text transcripts with bounds', function () {
  const marked = [
    '# Exported Traycer Epic Chat',
    '',
    'User: tyz11marker Outline the migration plan.',
    'Keep steps read-only.',
    '',
    'Assistant: Step 1: inspect epic transcripts.',
    'Step 2: verify allow-list.',
    '',
    '### User',
    'What about rollback?',
    '',
    '[Assistant] Keep an unchanged snapshot.',
    '',
    'System: INTERNAL_SYSTEM_NOTE',
  ].join('\n');

  const p1 = traycerchat.parseTranscript(marked, { epicId: 'epic-1', fileUuid: 'u-1', title: 'Plan' });
  assert.strictEqual(p1.counts.messages, 4);
  assert.deepStrictEqual(
    p1.messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant'],
  );
  assert.strictEqual(p1.messages[0].text, 'tyz11marker Outline the migration plan.\nKeep steps read-only.');
  assert.strictEqual(p1.messages[1].text, 'Step 1: inspect epic transcripts.\nStep 2: verify allow-list.');
  assert.strictEqual(p1.messages[2].text, 'What about rollback?');
  assert.strictEqual(p1.messages[3].text, 'Keep an unchanged snapshot.');

  const plain = 'Unmarked plain transcript line one.\nPlain line two tyz22plain.';
  const p2 = traycerchat.parseTranscript(plain, { epicId: 'epic-1', fileUuid: 'u-2', title: 'Plain' });
  assert.strictEqual(p2.counts.messages, 1);
  assert.strictEqual(p2.messages[0].role, 'assistant');
  assert.strictEqual(p2.messages[0].text, plain);

  const oversized = 'A'.repeat(210000);
  const p3 = traycerchat.parseTranscript(oversized);
  assert.strictEqual(p3.counts.messages, 1);
  assert.strictEqual(p3.messages[0].text.length, 200000);

  const corruptBuf = Buffer.from('valid prefix\x00corrupt binary payload', 'utf8');
  assert.strictEqual(traycerchat.parseTranscript(corruptBuf).counts.messages, 0);
  assert.strictEqual(traycerchat.parseTranscript('   \n\t\n  ').counts.messages, 0);
});

test('traycerchat: allow-lists only epic-chat-transcripts/*.txt, tolerates missing/corrupt files, and indexes/searches', async function () {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-traycer-'));
  try {
    const ctx = makeCtx({ home: tmp });
    ctx.env = {};

    // Missing ~/.traycer yields empty list without throwing
    assert.deepStrictEqual(traycerchat.discover(ctx), []);

    const epicId = '11111111-1111-4111-8111-111111111111';
    const fileUuid = '22222222-2222-4222-8222-222222222222';
    const epicDir = path.join(tmp, '.traycer', 'epic-chat-transcripts', epicId);
    const authDir = path.join(tmp, '.traycer', 'host', 'auth');
    const dbDir = path.join(tmp, '.traycer', 'host', 'chat-search');
    const epicsDir = path.join(tmp, '.traycer', 'epics', epicId);
    [epicDir, authDir, dbDir, epicsDir].forEach((d) => fs.mkdirSync(d, { recursive: true }));

    // Plant forbidden files that must NEVER be discovered or indexed
    fs.writeFileSync(path.join(authDir, 'session.txt'), 'FORBIDDEN_TRAYCER_HOST_AUTH');
    fs.writeFileSync(path.join(dbDir, 'chat-search.db'), 'SQLite format 3\x00FORBIDDEN_CHAT_DB');
    fs.writeFileSync(path.join(epicsDir, 'status.txt'), 'FORBIDDEN_EPIC_STATUS');
    fs.writeFileSync(path.join(epicDir, 'credentials-leak.txt'), 'FORBIDDEN_CREDENTIALS_FILE');
    fs.writeFileSync(path.join(epicDir, 'auth.txt'), 'FORBIDDEN_AUTH_FILE');
    fs.writeFileSync(path.join(epicDir, 'profile.enc'), 'FORBIDDEN_ENC_FILE');
    fs.writeFileSync(path.join(epicDir, 'corrupt-33333333.txt'), Buffer.from('bad\x00binary\x00data'));

    const transcriptFile = path.join(epicDir, 'T-' + fileUuid + '.txt');
    fs.writeFileSync(
      transcriptFile,
      ['User: trc99marker Check Traycer epic transcript indexing.', 'Assistant: Indexed read-only.'].join('\n') + '\n',
    );

    const disc = traycerchat.discover(ctx);
    assert.strictEqual(disc.length, 2, 'only non-credential .txt files inside epic-chat-transcripts');
    const validDisc = disc.find((d) => d.fileUuid === fileUuid);
    assert.ok(validDisc);
    assert.strictEqual(validDisc.title, 'T');

    const convs = conversations.discover(ctx, {});
    const traycerSrcs = convs.filter((s) => s.app === 'traycer');
    assert.strictEqual(traycerSrcs.length, 2);

    const conv = conversations.load(ctx, validDisc, {});
    assert.strictEqual(conv.id, 'traycer:' + epicId + ':' + fileUuid);
    assert.strictEqual(conv.app, 'traycer');
    assert.strictEqual(conv.surface, 'desktop');
    assert.strictEqual(conv.title, 'T');
    assert.strictEqual(convaccounts.explain(ctx, conv).account, null);

    // End-to-end CLI index, status, and search
    const idx = runCli(tmp, ['conv', 'index', '--no-embed', '--json']);
    assert.strictEqual(idx.status, 0, idx.stderr);

    const st = lastJson(runCli(tmp, ['conv', 'status', '--json']));
    assert.strictEqual(st.stats.byApp.traycer.sources, 1, 'corrupt file yields 0 messages and is omitted from index');

    const sr = runCli(tmp, ['conv', 'search', 'trc99marker', '--json']);
    assert.strictEqual(sr.status, 0, sr.stderr);
    const searchJson = lastJson(sr);
    assert.strictEqual(searchJson.hits.length, 1);
    assert.strictEqual(searchJson.hits[0].app, 'traycer');
    assert.strictEqual(searchJson.hits[0].id, 'traycer:' + epicId + ':' + fileUuid);

    const srHuman = runCli(tmp, ['conv', 'search', 'trc99marker']);
    assert.strictEqual(srHuman.status, 0, srHuman.stderr);
    assert.match(srHuman.stdout, /\btraycer\b/);

    const chunksDir = path.join(tmp, '.config', 'keyflip', 'conv-index', 'chunks');
    const chunkText = fs
      .readdirSync(chunksDir)
      .map((f) => fs.readFileSync(path.join(chunksDir, f), 'utf8'))
      .join('\n');
    for (const forbidden of [
      'FORBIDDEN_TRAYCER_HOST_AUTH',
      'FORBIDDEN_CHAT_DB',
      'FORBIDDEN_EPIC_STATUS',
      'FORBIDDEN_CREDENTIALS_FILE',
      'FORBIDDEN_AUTH_FILE',
      'FORBIDDEN_ENC_FILE',
    ]) {
      assert.strictEqual(chunkText.indexOf(forbidden), -1, forbidden + ' must never be indexed');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
