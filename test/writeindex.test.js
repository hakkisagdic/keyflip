// Slice D1 tests for the write-input extractor and store (src/writeindex.js):
// Claude + sub-agent transcripts, Bash write classification, secret masking before hashing,
// 64 KiB head+tail truncation, deduplicated blobs, byte-offset checkpoints, idempotent
// re-indexing, project excludes, deleted-source retention, 2 GB warning, and CLI --writes.
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import _child_process from 'child_process';
import { fileURLToPath } from 'url';
import { makeCtx, assertPrivateMode } from './helpers.js';
import * as config from '../src/config.js';
import * as convindex from '../src/convindex.js';
import * as conversations from '../src/conversations.js';
import * as secretpaths from '../src/secretpaths.js';
import * as writeindex from '../src/writeindex.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');

function encodeProj(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

function writeJsonl(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

function writeClaudeSession(ctx, projCwd, sessionId, lines) {
  const file = path.join(ctx.home, '.claude', 'projects', encodeProj(projCwd), sessionId + '.jsonl');
  return writeJsonl(file, lines);
}

function writeSubagentSession(ctx, projCwd, sessionId, agentName, lines) {
  const file = path.join(ctx.home, '.claude', 'projects', encodeProj(projCwd), sessionId, 'subagents', agentName + '.jsonl');
  return writeJsonl(file, lines);
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(p));
    else if (ent.isFile()) out.push(p);
  }
  return out;
}

function assistantToolUse(id, name, input, extra) {
  return Object.assign(
    {
      type: 'assistant',
      timestamp: '2026-02-01T10:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: id, name: name, input: input }],
      },
    },
    extra || {},
  );
}

test('default OFF: config defaults, scheduled/plain convindex.build does not touch writes/, SECRET_DIRS + 0600', async function () {
  const ctx = makeCtx();
  ctx.env = {};
  assert.strictEqual(config.get(ctx, 'conv.writes.enabled'), false);
  assert.strictEqual(config.get(ctx, 'conv.writes.exclude'), '');
  assert.ok(secretpaths.SECRET_DIRS.indexOf('conv-index') !== -1, 'conv-index is in SECRET_DIRS');

  writeClaudeSession(ctx, '/work/proj', 'sess-off', [
    { type: 'user', cwd: '/work/proj', timestamp: '2026-02-01T09:59:00.000Z', message: { role: 'user', content: 'hi' } },
    assistantToolUse('tu-1', 'Write', { file_path: '/work/proj/a.txt', content: 'hello\n' }, { cwd: '/work/proj' }),
  ]);

  const offReport = await convindex.build(ctx, {});
  assert.strictEqual(offReport.ok, true);
  assert.strictEqual(offReport.writes, undefined);
  assert.strictEqual(fs.existsSync(writeindex.dirOf(ctx)), false, 'writes/ must not be created while disabled');
  assert.strictEqual(writeindex.status(ctx).exists, false);
  assert.strictEqual(writeindex.status(ctx).enabled, false);

  // Enabling via opts.writes creates the store with 0600 files
  const onReport = await convindex.build(ctx, { writes: true });
  assert.strictEqual(onReport.ok, true);
  assert.ok(onReport.writes);
  assert.strictEqual(onReport.writes.totalEvents, 1);
  assert.strictEqual(fs.existsSync(writeindex.dirOf(ctx)), true);
  for (const f of walkFiles(writeindex.dirOf(ctx))) {
    assertPrivateMode(f, 'writes store file ' + path.basename(f));
  }

  // Enabling via config also turns it on for plain convindex.build
  const ctx2 = makeCtx();
  ctx2.env = {};
  config.set(ctx2, 'conv.writes.enabled', 'true');
  writeClaudeSession(ctx2, '/work/proj', 'sess-cfg', [
    assistantToolUse('tu-2', 'Write', { file_path: '/work/proj/b.txt', content: 'world\n' }, { cwd: '/work/proj' }),
  ]);
  const cfgReport = await convindex.build(ctx2, {});
  assert.ok(cfgReport.writes);
  assert.strictEqual(cfgReport.writes.totalEvents, 1);
  assert.strictEqual(writeindex.status(ctx2).enabled, true);
});

test('K1 (D1 scope): Bash heredocs, redirects, tee, sed -i, python/node writes vs non-writing commands', async function () {
  const ctx = makeCtx();
  ctx.env = {};
  const lines20 = Array.from({ length: 20 }, (_, i) => (i === 7 ? 'line-8 MAVIKEDI-4711 secret-marker' : 'line-' + (i + 1)));
  const heredoc20 = 'cat > /work/proj/notes.md <<EOF\n' + lines20.join('\n') + '\nEOF';

  writeClaudeSession(ctx, '/work/proj', 'sess-k1', [
    {
      type: 'user',
      cwd: '/work/proj',
      timestamp: '2026-02-01T10:00:00.000Z',
      message: { role: 'user', content: 'Create notes and run checks' },
    },
    assistantToolUse('b-heredoc', 'Bash', { command: heredoc20 }, { timestamp: '2026-02-01T10:00:01.000Z' }),
    assistantToolUse(
      'b-append',
      'Bash',
      { command: "cat <<'EOF' >> sub/more.md\nfirst appended\nsecond appended\nEOF" },
      { timestamp: '2026-02-01T10:00:02.000Z' },
    ),
    assistantToolUse(
      'b-tee',
      'Bash',
      { command: "cat <<'EOF' | tee piped.txt\nalpha\nbeta\nEOF" },
      { timestamp: '2026-02-01T10:00:03.000Z' },
    ),
    assistantToolUse('b-sed-mac', 'Bash', { command: "sed -i '' 's/a/b/g' notes.md" }, { timestamp: '2026-02-01T10:00:04.000Z' }),
    assistantToolUse('b-sed-gnu', 'Bash', { command: "sed -i 's/x/y/' sub/more.md" }, { timestamp: '2026-02-01T10:00:05.000Z' }),
    assistantToolUse(
      'b-python',
      'Bash',
      { command: 'python3 -c "open(\'py-out.txt\', \'w\').write(\'hello\\n\')"' },
      { timestamp: '2026-02-01T10:00:06.000Z' },
    ),
    assistantToolUse(
      'b-node',
      'Bash',
      { command: 'node -e "require(\'fs\').writeFileSync(\'node-out.txt\', \'hi\\n\')"' },
      { timestamp: '2026-02-01T10:00:07.000Z' },
    ),
    assistantToolUse(
      'b-dyn',
      'Bash',
      { command: 'cat > "$TARGET_FILE" <<EOF\ndyn line\nEOF' },
      { timestamp: '2026-02-01T10:00:08.000Z' },
    ),
    // Non-writing Bash commands and non-writing tools that MUST be ignored
    assistantToolUse(
      'b-git',
      'Bash',
      {
        command: 'git commit -m "$(cat <<\'EOF\'\nfeat: mention > fake.txt and sed -i in commit message\nEOF\n)"',
      },
      { timestamp: '2026-02-01T10:00:09.000Z' },
    ),
    assistantToolUse(
      'b-gh',
      'Bash',
      { command: 'gh pr create --title "t" --body "$(cat <<\'EOF\'\nbody with > fake2.txt\nEOF\n)"' },
      { timestamp: '2026-02-01T10:00:10.000Z' },
    ),
    assistantToolUse('b-devnull-err', 'Bash', { command: 'npm test 2>/dev/null' }, { timestamp: '2026-02-01T10:00:11.000Z' }),
    assistantToolUse('b-devnull-out', 'Bash', { command: 'ls >/dev/null 2>&1' }, { timestamp: '2026-02-01T10:00:12.000Z' }),
    assistantToolUse(
      'b-py-read',
      'Bash',
      { command: 'python3 -c "print(open(\'notes.md\').read())"' },
      { timestamp: '2026-02-01T10:00:13.000Z' },
    ),
    assistantToolUse(
      'b-node-read',
      'Bash',
      { command: 'node -e "console.log([1,2].filter(x => x > 1))"' },
      { timestamp: '2026-02-01T10:00:14.000Z' },
    ),
    assistantToolUse('t-read', 'Read', { file_path: '/work/proj/notes.md' }, { timestamp: '2026-02-01T10:00:15.000Z' }),
    assistantToolUse('t-grep', 'Grep', { pattern: 'MAVIKEDI', path: '/work/proj' }, { timestamp: '2026-02-01T10:00:16.000Z' }),
    assistantToolUse('t-glob', 'Glob', { pattern: '*.md' }, { timestamp: '2026-02-01T10:00:17.000Z' }),
    assistantToolUse('t-web', 'WebFetch', { url: 'https://example.com', prompt: 'get' }, { timestamp: '2026-02-01T10:00:18.000Z' }),
    assistantToolUse('t-task', 'Task', { description: 'run', prompt: 'do work' }, { timestamp: '2026-02-01T10:00:19.000Z' }),
  ]);

  const r = await convindex.build(ctx, { writes: true });
  assert.strictEqual(r.ok, true);

  const notesEvents = writeindex.readEvents(ctx, '/work/proj/notes.md');
  assert.strictEqual(notesEvents.length, 2, 'notes.md has heredoc write + sed -i');
  const heredocEv = notesEvents[0];
  assert.strictEqual(heredocEv.session, 'sess-k1');
  assert.strictEqual(heredocEv.tool, 'Bash');
  assert.strictEqual(heredocEv.kind, 'write');
  assert.strictEqual(heredocEv.replayable, true);
  assert.strictEqual(heredocEv.lines, 20);
  const heredocBody = writeindex.readBlob(ctx, heredocEv.blob);
  assert.match(heredocBody, /MAVIKEDI-4711/);
  assert.strictEqual(heredocBody, lines20.join('\n') + '\n');
  assert.strictEqual(notesEvents[1].kind, 'sed');
  assert.strictEqual(notesEvents[1].replayable, false);

  const moreEvents = writeindex.readEvents(ctx, '/work/proj/sub/more.md');
  assert.strictEqual(moreEvents.length, 2, 'sub/more.md resolved against cwd');
  assert.strictEqual(moreEvents[0].kind, 'append');
  assert.strictEqual(moreEvents[0].replayable, true);
  assert.strictEqual(moreEvents[0].lines, 2);
  assert.strictEqual(moreEvents[1].kind, 'sed');
  assert.strictEqual(moreEvents[1].replayable, false);

  const teeEvents = writeindex.readEvents(ctx, '/work/proj/piped.txt');
  assert.strictEqual(teeEvents.length, 1);
  assert.strictEqual(teeEvents[0].kind, 'write');
  assert.strictEqual(teeEvents[0].replayable, true);
  assert.strictEqual(teeEvents[0].lines, 2);
  assert.strictEqual(writeindex.readBlob(ctx, teeEvents[0].blob), 'alpha\nbeta\n');

  const pyEvents = writeindex.readEvents(ctx, '/work/proj/py-out.txt');
  assert.strictEqual(pyEvents.length, 1);
  assert.strictEqual(pyEvents[0].kind, 'python');
  assert.strictEqual(pyEvents[0].replayable, false);

  const nodeEvents = writeindex.readEvents(ctx, '/work/proj/node-out.txt');
  assert.strictEqual(nodeEvents.length, 1);
  assert.strictEqual(nodeEvents[0].kind, 'node');
  assert.strictEqual(nodeEvents[0].replayable, false);

  const dynEvents = writeindex.readEvents(ctx, writeindex.UNRESOLVED_PATH);
  assert.strictEqual(dynEvents.length, 1);
  assert.strictEqual(dynEvents[0].path, '(bash:belirsiz)');
  assert.strictEqual(writeindex.readBlob(ctx, dynEvents[0].blob), 'dyn line\n');

  const allPaths = writeindex.listPaths(ctx).map((p) => p.path);
  assert.strictEqual(allPaths.includes('/work/proj/fake.txt'), false, 'git commit heredoc is not a file write');
  assert.strictEqual(allPaths.includes('/work/proj/fake2.txt'), false, 'gh pr heredoc is not a file write');
  assert.strictEqual(allPaths.includes('/dev/null'), false, '/dev/null is never indexed');
  const allEvents = writeindex.readAllEvents(ctx);
  assert.strictEqual(allEvents.length, 8, 'only the 8 real write events were stored');
  assert.ok(allEvents.every((ev) => ['Bash'].includes(ev.tool)));
});

test('structured file-writing tools: Write, Edit, MultiEdit, NotebookEdit', async function () {
  const ctx = makeCtx();
  ctx.env = {};
  writeClaudeSession(ctx, '/work/proj', 'sess-tools', [
    { type: 'user', cwd: '/work/proj', message: { role: 'user', content: 'edit files' } },
    assistantToolUse('t-w', 'Write', { file_path: 'new.js', content: 'const a = 1;\n' }, { timestamp: '2026-02-01T11:00:01.000Z' }),
    assistantToolUse(
      't-e',
      'Edit',
      { file_path: 'new.js', old_string: 'const a = 1;', new_string: 'const a = 2;', replace_all: false },
      { timestamp: '2026-02-01T11:00:02.000Z' },
    ),
    assistantToolUse(
      't-m',
      'MultiEdit',
      {
        file_path: 'new.js',
        edits: [
          { old_string: 'const a = 2;', new_string: 'const a = 3;' },
          { old_string: '3', new_string: '4' },
        ],
      },
      { timestamp: '2026-02-01T11:00:03.000Z' },
    ),
    assistantToolUse(
      't-nb',
      'NotebookEdit',
      { notebook_path: 'nb.ipynb', new_source: 'print("ok")\n' },
      { timestamp: '2026-02-01T11:00:04.000Z' },
    ),
  ]);

  const r = await convindex.build(ctx, { writes: true });
  assert.strictEqual(r.ok, true);

  const jsEvents = writeindex.readEvents(ctx, '/work/proj/new.js');
  assert.strictEqual(jsEvents.length, 3);
  assert.strictEqual(jsEvents[0].tool, 'Write');
  assert.strictEqual(jsEvents[0].kind, 'write');
  assert.strictEqual(jsEvents[0].replayable, true);
  assert.strictEqual(writeindex.readBlob(ctx, jsEvents[0].blob), 'const a = 1;\n');

  assert.strictEqual(jsEvents[1].tool, 'Edit');
  assert.strictEqual(jsEvents[1].kind, 'edit');
  assert.strictEqual(jsEvents[1].replayable, true);
  assert.strictEqual(writeindex.readBlob(ctx, jsEvents[1].oldBlob), 'const a = 1;');
  assert.strictEqual(writeindex.readBlob(ctx, jsEvents[1].blob), 'const a = 2;');

  assert.strictEqual(jsEvents[2].tool, 'MultiEdit');
  assert.strictEqual(jsEvents[2].kind, 'multiedit');
  assert.strictEqual(jsEvents[2].replayable, true);
  assert.strictEqual(jsEvents[2].edits.length, 2);
  assert.strictEqual(writeindex.readBlob(ctx, jsEvents[2].edits[0].oldBlob), 'const a = 2;');
  assert.strictEqual(writeindex.readBlob(ctx, jsEvents[2].edits[0].blob), 'const a = 3;');
  assert.ok(writeindex.readBlob(ctx, jsEvents[2].blob).includes('const a = 3;'));

  const nbEvents = writeindex.readEvents(ctx, '/work/proj/nb.ipynb');
  assert.strictEqual(nbEvents.length, 1);
  assert.strictEqual(nbEvents[0].tool, 'NotebookEdit');
  assert.strictEqual(nbEvents[0].kind, 'notebook-edit');
  assert.strictEqual(nbEvents[0].replayable, false);
  assert.strictEqual(writeindex.readBlob(ctx, nbEvents[0].blob), 'print("ok")\n');
});

test('K2: tool outputs (tool_result and toolUseResult) are NEVER stored', async function () {
  const ctx = makeCtx();
  ctx.env = {};
  writeClaudeSession(ctx, '/work/proj', 'sess-k2', [
    assistantToolUse('t-1', 'Write', { file_path: '/work/proj/out.txt', content: 'clean content\n' }, { cwd: '/work/proj' }),
    {
      type: 'user',
      cwd: '/work/proj',
      timestamp: '2026-02-01T12:00:01.000Z',
      toolUseResult: { stdout: 'SADECEKCIKTI-99' },
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't-1', content: 'SADECEKCIKTI-99' }],
      },
    },
    {
      type: 'user',
      cwd: '/work/proj',
      timestamp: '2026-02-01T12:00:02.000Z',
      message: { role: 'user', content: 'SADECEKCIKTI-99' },
    },
  ]);

  await convindex.build(ctx, { writes: true });
  const files = walkFiles(writeindex.dirOf(ctx));
  assert.ok(files.length > 0);
  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8');
    assert.strictEqual(raw.indexOf('SADECEKCIKTI-99'), -1, 'tool output leaked into ' + f);
  }
});

test('K3: secrets masked before storage & hashing; secret-file bodies skipped', async function () {
  const ctx = makeCtx();
  ctx.env = {};
  const fakeAnthropic = 'sk-ant-' + 'aBcdEfGhIjKlMnOpQrStUvWxYzAbCd';
  const fakePassword = 'hunter2xyz';
  const rawEnvSecret = 'RAW_ENV_SECRET_42';

  writeClaudeSession(ctx, '/work/proj', 'sess-k3', [
    assistantToolUse(
      't-conf',
      'Write',
      {
        file_path: '/work/proj/app.conf',
        content: 'TOKEN_A=' + fakeAnthropic + '\nAPI_KEY=' + fakePassword + '\nPLAIN=ok\n',
      },
      { cwd: '/work/proj', timestamp: '2026-02-01T13:00:01.000Z' },
    ),
    assistantToolUse(
      't-env',
      'Write',
      { file_path: '/work/proj/.env', content: 'SECRET=' + rawEnvSecret + '\n' },
      { cwd: '/work/proj', timestamp: '2026-02-01T13:00:02.000Z' },
    ),
    assistantToolUse(
      't-key',
      'Write',
      { file_path: '/work/proj/cert.key', content: rawEnvSecret + '\n' },
      { cwd: '/work/proj', timestamp: '2026-02-01T13:00:03.000Z' },
    ),
    assistantToolUse(
      't-example',
      'Write',
      { file_path: '/work/proj/.env.example', content: 'PORT=3000\n' },
      { cwd: '/work/proj', timestamp: '2026-02-01T13:00:04.000Z' },
    ),
  ]);

  await convindex.build(ctx, { writes: true });

  for (const f of walkFiles(writeindex.dirOf(ctx))) {
    assert.strictEqual(f.indexOf(fakeAnthropic), -1);
    assert.strictEqual(f.indexOf(fakePassword), -1);
    assert.strictEqual(f.indexOf(rawEnvSecret), -1);
    const body = fs.readFileSync(f, 'utf8');
    assert.strictEqual(body.indexOf(fakeAnthropic), -1, 'anthropic key leaked in ' + f);
    assert.strictEqual(body.indexOf(fakePassword), -1, 'key=value secret leaked in ' + f);
    assert.strictEqual(body.indexOf(rawEnvSecret), -1, 'secret-file content leaked in ' + f);
  }

  const confEvents = writeindex.readEvents(ctx, '/work/proj/app.conf');
  assert.strictEqual(confEvents.length, 1);
  assert.strictEqual(confEvents[0].secretFile, false);
  assert.ok(confEvents[0].redacted >= 2);
  const blobText = writeindex.readBlob(ctx, confEvents[0].blob);
  assert.match(blobText, /«keyflip_redacted»/);
  assert.match(blobText, /PLAIN=ok/);
  const expectedMaskedHash = crypto.createHash('sha256').update(blobText, 'utf8').digest('hex');
  assert.strictEqual(confEvents[0].blob, expectedMaskedHash, 'blob hash must be computed over MASKED body');

  const envEvents = writeindex.readEvents(ctx, '/work/proj/.env');
  assert.strictEqual(envEvents.length, 1);
  assert.strictEqual(envEvents[0].secretFile, true);
  assert.strictEqual(envEvents[0].blob, null);

  const keyEvents = writeindex.readEvents(ctx, '/work/proj/cert.key');
  assert.strictEqual(keyEvents.length, 1);
  assert.strictEqual(keyEvents[0].secretFile, true);
  assert.strictEqual(keyEvents[0].blob, null);

  const exampleEvents = writeindex.readEvents(ctx, '/work/proj/.env.example');
  assert.strictEqual(exampleEvents.length, 1);
  assert.strictEqual(exampleEvents[0].secretFile, false);
  assert.strictEqual(writeindex.readBlob(ctx, exampleEvents[0].blob), 'PORT=3000\n');
});

test('K4: 5 MB Write input is capped to <= 64 KiB head+tail with truncation marker', async function () {
  const ctx = makeCtx();
  ctx.env = {};
  const headMark = 'HEAD_MARK_START\n';
  const tailMark = '\nTAIL_MARK_END\n';
  const totalBytes = 5 * 1024 * 1024;
  const bigContent = headMark + 'x'.repeat(totalBytes - headMark.length - tailMark.length) + tailMark;

  writeClaudeSession(ctx, '/work/proj', 'sess-k4', [
    assistantToolUse('t-big', 'Write', { file_path: '/work/proj/big.txt', content: bigContent }, { cwd: '/work/proj' }),
  ]);

  const r = await convindex.build(ctx, { writes: true });
  assert.strictEqual(r.ok, true);

  const events = writeindex.readEvents(ctx, '/work/proj/big.txt');
  assert.strictEqual(events.length, 1);
  const ev = events[0];
  assert.strictEqual(ev.truncated, true);
  assert.ok(ev.truncatedBytes > 0);
  const blobText = writeindex.readBlob(ctx, ev.blob);
  assert.ok(Buffer.byteLength(blobText, 'utf8') <= 64 * 1024 + 64, 'blob must be capped around 64 KiB + marker');
  assert.ok(blobText.startsWith(headMark), 'head preserved');
  assert.ok(blobText.endsWith(tailMark), 'tail preserved');
  assert.ok(
    blobText.includes('«keyflip_truncated ' + ev.truncatedBytes + ' bytes»'),
    'truncation marker present with exact byte count',
  );
});

test('K5: identical content across sessions is stored as one blob file with two events', async function () {
  const ctx = makeCtx();
  ctx.env = {};
  const sharedBody = 'export const VERSION = 1;\n';

  writeClaudeSession(ctx, '/work/proj', 'sess-a', [
    assistantToolUse(
      'tu-shared',
      'Write',
      { file_path: '/work/proj/shared.txt', content: sharedBody },
      { cwd: '/work/proj', timestamp: '2026-02-01T14:00:01.000Z' },
    ),
  ]);
  writeClaudeSession(ctx, '/work/proj', 'sess-b', [
    assistantToolUse(
      'tu-shared',
      'Write',
      { file_path: '/work/proj/shared.txt', content: sharedBody },
      { cwd: '/work/proj', timestamp: '2026-02-01T14:00:02.000Z' },
    ),
  ]);

  const r = await convindex.build(ctx, { writes: true });
  assert.strictEqual(r.writes.totalBlobs, 1);
  assert.strictEqual(walkFiles(writeindex.blobsDir(ctx)).length, 1);

  const events = writeindex.readEvents(ctx, '/work/proj/shared.txt');
  assert.strictEqual(events.length, 2);
  assert.notStrictEqual(events[0].id, events[1].id);
  assert.deepStrictEqual(
    events.map((e) => e.session).sort(),
    ['sess-a', 'sess-b'],
  );
  assert.strictEqual(events[0].blob, events[1].blob);
});

test('K7: sub-agent transcripts covered with subagent flags while excluded from conv index', async function () {
  const ctx = makeCtx();
  ctx.env = {};

  writeClaudeSession(ctx, '/work/proj', 'sess-main', [
    { type: 'user', cwd: '/work/proj', timestamp: '2026-02-01T15:00:00.000Z', message: { role: 'user', content: 'start' } },
    assistantToolUse(
      'tu-main',
      'Write',
      { file_path: '/work/proj/joint.js', content: '// main\n' },
      { sessionId: 'sess-main', cwd: '/work/proj', timestamp: '2026-02-01T15:00:01.000Z' },
    ),
  ]);
  writeSubagentSession(ctx, '/work/proj', 'sess-main', 'agent-w1', [
    assistantToolUse(
      'tu-sub',
      'Write',
      { file_path: '/work/proj/joint.js', content: '// worker 1\n' },
      { sessionId: 'sess-main', agentId: 'w1', cwd: '/work/proj', timestamp: '2026-02-01T15:00:02.000Z' },
    ),
  ]);

  await convindex.build(ctx, { writes: true });

  const events = writeindex.readEvents(ctx, '/work/proj/joint.js');
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].session, 'sess-main');
  assert.strictEqual(events[0].subagent, false);
  assert.strictEqual(events[0].agent, null);
  assert.strictEqual(events[1].session, 'sess-main');
  assert.strictEqual(events[1].subagent, true);
  assert.strictEqual(events[1].agent, 'w1');

  assert.strictEqual(conversations.list(ctx).conversations.length, 1, 'sub-agent omitted from conversations.list');
  assert.strictEqual(convindex.catalog(ctx, {}).conversations.length, 1, 'sub-agent omitted from convindex catalog');
});

test('K8: idempotent re-indexing, byte-offset append resume, file shrink reset, deleted-source retention & 2 GB warning', async function () {
  const ctx = makeCtx();
  ctx.env = {};
  const sessFile = writeClaudeSession(ctx, '/work/proj', 'sess-k8', [
    { type: 'user', cwd: '/work/proj', timestamp: '2026-02-01T16:00:00.000Z', message: { role: 'user', content: 'go' } },
    assistantToolUse(
      'tu-1',
      'Write',
      { file_path: '/work/proj/first.txt', content: 'one\n' },
      { cwd: '/work/proj', timestamp: '2026-02-01T16:00:01.000Z' },
    ),
  ]);

  const r1 = await convindex.build(ctx, { writes: true });
  assert.strictEqual(r1.writes.indexed, 1);
  assert.strictEqual(r1.writes.eventsAdded, 1);

  const r2 = await convindex.build(ctx, { writes: true });
  assert.strictEqual(r2.writes.reused, 1);
  assert.strictEqual(r2.writes.indexed, 0);
  assert.strictEqual(r2.writes.eventsAdded, 0);

  const r3 = await convindex.build(ctx, { writes: true });
  assert.strictEqual(r3.writes.reused, 1);
  assert.strictEqual(r3.writes.indexed, 0);
  assert.strictEqual(r3.writes.eventsAdded, 0);

  const r4 = await convindex.build(ctx, { writes: true, force: true });
  assert.strictEqual(r4.writes.totalEvents, 1);
  assert.strictEqual(r4.writes.totalBlobs, 1);

  // Append a Write with NO cwd on the new line and a relative file_path — must use checkpointed cwd
  fs.appendFileSync(
    sessFile,
    JSON.stringify(
      assistantToolUse(
        'tu-2',
        'Write',
        { file_path: 'added.txt', content: 'two\n' },
        { timestamp: '2026-02-01T16:00:02.000Z' },
      ),
    ) + '\n',
  );
  const rApp = await convindex.build(ctx, { writes: true });
  assert.strictEqual(rApp.writes.appended, 1);
  assert.strictEqual(rApp.writes.eventsAdded, 1);
  assert.strictEqual(writeindex.readEvents(ctx, '/work/proj/first.txt').length, 1);
  assert.strictEqual(writeindex.readEvents(ctx, '/work/proj/added.txt').length, 1);

  // Shrink / rewrite the file smaller -> resets from offset 0 without duplicating tu-1
  writeJsonl(sessFile, [
    assistantToolUse(
      'tu-1',
      'Write',
      { file_path: '/work/proj/first.txt', content: 'one\n' },
      { cwd: '/work/proj', timestamp: '2026-02-01T16:00:01.000Z' },
    ),
  ]);
  const rShrink = await convindex.build(ctx, { writes: true });
  assert.strictEqual(rShrink.writes.indexed, 1);
  assert.strictEqual(writeindex.readEvents(ctx, '/work/proj/first.txt').length, 1);

  // Delete source file -> events & blobs must be retained
  fs.rmSync(sessFile);
  await convindex.build(ctx, { writes: true });
  const retained = writeindex.readEvents(ctx, '/work/proj/first.txt');
  assert.strictEqual(retained.length, 1);
  assert.strictEqual(writeindex.readBlob(ctx, retained[0].blob), 'one\n');

  // 2 GB warning threshold check (parameterized via warnBytes for tests)
  const warnReport = writeindex.build(ctx, { warnBytes: 100 });
  assert.ok(warnReport.warnings.some((w) => /2 GB/.test(w)));
  assert.strictEqual(writeindex.status(ctx, { warnBytes: 100 }).overWarnLimit, true);
});

test('conv.writes.exclude skips excluded projects and CLI --writes builds writes store', async function () {
  const ctx = makeCtx();
  ctx.env = {};
  config.set(ctx, 'conv.writes.exclude', '/work/skip-me, secret-proj');

  writeClaudeSession(ctx, '/work/keep-me', 's-keep', [
    assistantToolUse('t-keep', 'Write', { file_path: '/work/keep-me/ok.txt', content: 'keep\n' }, { cwd: '/work/keep-me' }),
  ]);
  writeClaudeSession(ctx, '/work/skip-me', 's-skip', [
    assistantToolUse('t-skip', 'Write', { file_path: '/work/skip-me/no.txt', content: 'skip\n' }, { cwd: '/work/skip-me' }),
  ]);
  writeClaudeSession(ctx, '/work/client/secret-proj', 's-sec', [
    assistantToolUse(
      't-sec',
      'Write',
      { file_path: '/work/client/secret-proj/no2.txt', content: 'secret\n' },
      { cwd: '/work/client/secret-proj' },
    ),
  ]);

  await convindex.build(ctx, { writes: true });
  const paths = writeindex.listPaths(ctx).map((p) => p.path);
  assert.deepStrictEqual(paths, ['/work/keep-me/ok.txt']);

  // End-to-end CLI invocation with --writes in an isolated temp HOME
  const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-writes-cli-'));
  const cfgDir = path.join(cliHome, '.config', 'keyflip');
  const cliSess = path.join(cliHome, '.claude', 'projects', encodeProj('/work/cli-proj'), 'sess-cli.jsonl');
  writeJsonl(cliSess, [
    { type: 'user', cwd: '/work/cli-proj', message: { role: 'user', content: 'write a file' } },
    assistantToolUse(
      'tu-cli',
      'Write',
      { file_path: '/work/cli-proj/cli.txt', content: 'from-cli\n' },
      { cwd: '/work/cli-proj' },
    ),
  ]);

  const res = _child_process.spawnSync(process.execPath, [BIN, 'conv', 'index', '--writes', '--json'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      HOME: cliHome,
      USERPROFILE: cliHome,
      XDG_CONFIG_HOME: path.join(cliHome, '.config'),
      KEYFLIP_CONFIG_DIR: cfgDir,
      APPDATA: path.join(cliHome, 'AppData', 'Roaming'),
      CODEX_HOME: path.join(cliHome, '.codex'),
      KEYFLIP_TEST_CLAUDE: 'stopped',
    }),
  });
  assert.strictEqual(res.status, 0, res.stderr);
  const lastLine = res.stdout.trim().split('\n').filter(Boolean).pop();
  const parsed = JSON.parse(lastLine);
  assert.strictEqual(parsed.ok, true);
  assert.ok(parsed.writes, 'CLI --writes populates report.writes even when conv.writes.enabled is false');
  assert.strictEqual(parsed.writes.totalEvents, 1);
  assert.strictEqual(parsed.writes.totalBlobs, 1);
});

test('edge cases: cd tracking, nested python open(), partial EOF line recovery, boundary secret redaction', async function () {
  const ctx = makeCtx();
  ctx.env = {};
  const boundarySecret = 'sk-ant-' + 'ZzYyXxWwVvUuTtSsRrQqPpOoNnMmLl';
  const boundaryContent =
    'A'.repeat(48 * 1024 - 10) + boundarySecret + 'B'.repeat(20 * 1024);

  const line1 = JSON.stringify(
    assistantToolUse(
      'tu-cd',
      'Bash',
      { command: 'cd /work/other && cat > rel.txt <<EOF\nvia cd\nEOF' },
      { cwd: '/work/proj', timestamp: '2026-02-01T17:00:01.000Z' },
    ),
  );
  const line2 = JSON.stringify(
    assistantToolUse(
      'tu-py-nested',
      'Bash',
      { command: 'python3 -c "open(os.path.join(\'a\', \'b.txt\'), \'w\').write(\'x\')"' },
      { cwd: '/work/proj', timestamp: '2026-02-01T17:00:02.000Z' },
    ),
  );
  const line3 = JSON.stringify(
    assistantToolUse(
      'tu-bnd',
      'Write',
      { file_path: '/work/proj/bnd.txt', content: boundaryContent },
      { cwd: '/work/proj', timestamp: '2026-02-01T17:00:03.000Z' },
    ),
  );

  // Seed line1 + line2 + first half of line3 (no trailing newline yet)
  const sessFile = path.join(ctx.home, '.claude', 'projects', encodeProj('/work/proj'), 'sess-edge.jsonl');
  fs.mkdirSync(path.dirname(sessFile), { recursive: true });
  const splitAt = Math.floor(line3.length / 2);
  fs.writeFileSync(sessFile, line1 + '\n' + line2 + '\n' + line3.slice(0, splitAt));

  const first = writeindex.build(ctx, {});
  assert.strictEqual(first.totalEvents, 2);
  assert.strictEqual(writeindex.readEvents(ctx, '/work/other/rel.txt').length, 1);
  assert.strictEqual(writeindex.readEvents(ctx, writeindex.UNRESOLVED_PATH).length, 1);
  assert.strictEqual(writeindex.readEvents(ctx, '/work/proj/bnd.txt').length, 0);

  // Finish writing line3 and re-run — must resume from last newline and mask boundarySecret cleanly
  fs.appendFileSync(sessFile, line3.slice(splitAt) + '\n');
  const second = writeindex.build(ctx, {});
  assert.strictEqual(second.appended, 1);
  assert.strictEqual(second.eventsAdded, 1);
  assert.strictEqual(second.totalEvents, 3);

  const bndEvents = writeindex.readEvents(ctx, '/work/proj/bnd.txt');
  assert.strictEqual(bndEvents.length, 1);
  const bndBlob = writeindex.readBlob(ctx, bndEvents[0].blob);
  assert.strictEqual(bndBlob.indexOf(boundarySecret), -1, 'boundary secret must never leak');
  assert.match(bndBlob, /«keyflip_truncated \d+ bytes»/);
});
