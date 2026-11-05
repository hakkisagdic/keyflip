// The canonical conversation layer: one shape for every local AI tool, harness noise stripped,
// ids/prefixes resolvable. Fixtures are synthetic — no real transcripts, no credentials.
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { makeCtx } from './helpers.js';
import * as conversations from '../src/conversations.js';
import * as transcript from '../src/transcript.js';

function ctxFor() {
  const ctx = makeCtx();
  // Never read the real machine's CODEX_HOME while testing.
  ctx.env = {};
  return ctx;
}

function writeClaude(ctx, id, lines) {
  const dir = path.join(ctx.home, '.claude', 'projects', '-work-proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path.join(dir, id + '.jsonl');
}

function writeCodex(ctx, name, lines) {
  const dir = path.join(ctx.home, '.codex', 'sessions', '2026', '01', '01');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function loadAll(ctx) {
  return conversations.discover(ctx, { foreign: false }).map((s) => conversations.load(ctx, s, {}));
}

test('Claude transcript: harness wrappers are stripped, machine turns dropped, tools kept', function () {
  const ctx = ctxFor();
  writeClaude(ctx, 'sess-1', [
    {
      type: 'user',
      timestamp: '2026-01-01T10:00:00.000Z',
      cwd: '/work/proj',
      message: { role: 'user', content: '<system-reminder>secret context</system-reminder>Refactor the parser.' },
    },
    {
      type: 'assistant',
      timestamp: '2026-01-01T10:00:01.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading the file.' },
          { type: 'tool_use', name: 'Read', input: { path: 'x' } },
        ],
      },
    },
    {
      type: 'user',
      timestamp: '2026-01-01T10:00:02.000Z',
      message: { role: 'user', content: '<task-notification>background job finished</task-notification>' },
    },
    {
      type: 'user',
      timestamp: '2026-01-01T10:00:03.000Z',
      message: { role: 'user', content: '<skill-format>true</skill-format>Now check the tests.' },
    },
    {
      type: 'user',
      timestamp: '2026-01-01T10:00:04.000Z',
      // The host repeats the id on the CLOSING tag; the old regex left the whole block in place.
      message: { role: 'user', content: '<pasted_content id="c1">hello paste</pasted_content id="c1">' },
    },
  ]);
  const convs = loadAll(ctx);
  assert.strictEqual(convs.length, 1);
  const c = convs[0];
  assert.strictEqual(c.id, 'claude:local:sess-1');
  assert.strictEqual(c.app, 'claude');
  assert.strictEqual(c.cwd, '/work/proj');
  assert.strictEqual(c.title, 'Refactor the parser.');
  assert.strictEqual(c.counts.messages, 4);
  assert.strictEqual(c.counts.user, 3);
  assert.strictEqual(c.counts.assistant, 1);
  assert.strictEqual(c.messages[0].text, 'Refactor the parser.');
  assert.strictEqual(c.messages[1].tools[0], 'Read');
  assert.strictEqual(c.messages[2].text, 'Now check the tests.');
  assert.strictEqual(c.messages[3].text, 'hello paste');
  const joined = c.messages.map((m) => m.text).join('\n');
  assert.ok(!/<(pasted_content|skill-format|system-reminder|task-notification)/.test(joined), joined);
  // Hash is a pure function of the kept messages: a second load agrees.
  assert.strictEqual(conversations.load(ctx, conversations.discover(ctx, { foreign: false })[0], {}).hash, c.hash);
});

test('title falls back past a continuation preamble to the first human sentence', function () {
  const ctx = ctxFor();
  writeClaude(ctx, 'sess-2', [
    {
      type: 'user',
      message: { role: 'user', content: 'This session is being continued from a previous conversation.' },
    },
    {
      type: 'assistant',
      message: { role: 'assistant', content: 'Ready.' },
    },
    { type: 'user', message: { role: 'user', content: 'Fix the flaky CI job.' } },
  ]);
  const c = loadAll(ctx)[0];
  assert.strictEqual(c.title, 'Fix the flaky CI job.');
});

test('Codex rollout: session_meta names the id/cwd and consecutive echoes collapse', function () {
  const ctx = ctxFor();
  writeCodex(ctx, 'rollout-2026-01-01T10-00-00-abc12345.jsonl', [
    {
      type: 'session_meta',
      timestamp: '2026-01-01T10:00:00.000Z',
      payload: { session_id: 'abc12345', cwd: '/work/codex', originator: 'codex_cli' },
    },
    {
      type: 'response_item',
      timestamp: '2026-01-01T10:00:01.000Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Ship the release.' }] },
    },
    {
      type: 'response_item',
      // app event stream repeats the same turn: must not become two messages
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Ship the release.' }] },
    },
    {
      type: 'response_item',
      timestamp: '2026-01-01T10:00:02.000Z',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }],
      },
    },
  ]);
  const convs = loadAll(ctx);
  assert.strictEqual(convs.length, 1);
  const c = convs[0];
  assert.strictEqual(c.id, 'codex:abc12345');
  assert.strictEqual(c.surface, 'cli');
  assert.strictEqual(c.cwd, '/work/codex');
  assert.strictEqual(c.counts.messages, 2);
  assert.strictEqual(c.title, 'Ship the release.');
});

test('Codex rollout: a resumed thread keeps its own id, not the parent session_id', function () {
  const ctx = ctxFor();
  const head = (own) => ({
    type: 'session_meta',
    timestamp: '2026-01-01T10:00:00.000Z',
    payload: { session_id: 'parent0001', id: own, cwd: '/work/codex', originator: 'codex_cli' },
  });
  const turn = (text) => ({
    type: 'response_item',
    timestamp: '2026-01-01T10:00:01.000Z',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });
  writeCodex(ctx, 'rollout-2026-01-01T10-00-00-own00001.jsonl', [head('own00001'), turn('First segment.')]);
  writeCodex(ctx, 'rollout-2026-01-01T11-00-00-own00002.jsonl', [head('own00002'), turn('Second segment.')]);
  const ids = loadAll(ctx)
    .map((c) => c.id)
    .sort();
  assert.deepStrictEqual(ids, ['codex:own00001', 'codex:own00002']);
});

test('Codex Desktop: a fork and a parent echoed in a second session_meta keep their own id', function () {
  const ctx = ctxFor();
  const PARENT = '11111111-1111-4111-8111-111111111111';
  const FORK = '22222222-2222-4222-8222-222222222222';
  const OWN = '44444444-4444-4444-8444-444444444444';
  const RESUMED = '33333333-3333-4333-8333-333333333333';
  const meta = (id, sid) => ({
    type: 'session_meta',
    timestamp: '2026-10-01T10:00:00.000Z',
    payload: { id: id, session_id: sid, cwd: '/work/codex', originator: 'codex_desktop' },
  });
  const turn = (text) => ({
    type: 'response_item',
    timestamp: '2026-10-01T10:00:01.000Z',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: text }] },
  });
  // A fork: the file is named parent_own and its session_meta only knows the parent.
  writeCodex(ctx, 'rollout-2026-10-19T11-26-02-' + PARENT + '_' + FORK + '.jsonl', [
    meta(PARENT, PARENT),
    turn('Fork.'),
  ]);
  // A resumed rollout: two session_meta lines, the second repeats the parent thread.
  writeCodex(ctx, 'rollout-2026-10-16T09-40-34-' + RESUMED + '.jsonl', [
    meta(OWN, RESUMED),
    meta(RESUMED, RESUMED),
    turn('Resumed.'),
  ]);
  // The parent's own rollout: the only id it has is the parent thread.
  writeCodex(ctx, 'rollout-2026-10-16T08-38-34-' + RESUMED + '.jsonl', [meta(RESUMED, RESUMED), turn('Parent.')]);

  const ids = loadAll(ctx)
    .map((c) => c.id)
    .sort();
  assert.deepStrictEqual(ids, ['codex:' + FORK, 'codex:' + RESUMED, 'codex:' + OWN].sort());
  assert.strictEqual(new Set(ids).size, 3, 'three rollouts, three conversations');
});

test('Kiro CLI: Prompt/AssistantMessage blocks become user/assistant turns', function () {
  const ctx = ctxFor();
  const dir = path.join(ctx.home, '.kiro', 'sessions', 'cli');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'k1.json'),
    JSON.stringify({ session_id: 'k1', title: 'Kiro task', cwd: '/work/kiro', created_at: '2026-01-01T09:00:00Z' }),
  );
  fs.writeFileSync(
    path.join(dir, 'k1.jsonl'),
    [
      { kind: 'Prompt', data: { timestamp: '2026-01-01T09:00:01Z', content: [{ kind: 'text', data: 'Add a test.' }] } },
      {
        kind: 'AssistantMessage',
        data: {
          timestamp: '2026-01-01T09:00:02Z',
          content: [
            { kind: 'text', data: 'Writing it.' },
            { kind: 'toolUse', data: { name: 'fs_write' } },
          ],
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
  );
  const c = loadAll(ctx)[0];
  assert.strictEqual(c.id, 'kiro:cli:k1');
  assert.strictEqual(c.app, 'kiro');
  assert.strictEqual(c.title, 'Kiro task');
  assert.strictEqual(c.cwd, '/work/kiro');
  assert.deepStrictEqual(
    c.messages.map((m) => m.role),
    ['user', 'assistant'],
  );
  assert.deepStrictEqual(c.messages[1].tools, ['fs_write']);
});

test('Command Code: title comes from the .meta.json sidecar and the surface is cli', function () {
  const ctx = ctxFor();
  const dir = path.join(ctx.home, '.commandcode', 'projects', '-work-proj');
  fs.mkdirSync(dir, { recursive: true });
  const id = 'sess-cc-1';
  const lines = [
    { sessionId: id, role: 'user', content: [{ type: 'text', text: 'Refactor the parser.' }] },
    {
      sessionId: id,
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading the file.' },
        { type: 'tool-call', toolCallId: 't1', toolName: 'Read', input: { path: 'x' } },
      ],
    },
    { sessionId: id, role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', output: 'body' }] },
  ];
  fs.writeFileSync(path.join(dir, id + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, id + '.meta.json'), JSON.stringify({ title: 'Command Code task' }));
  // Must never be listed as a session of its own.
  fs.writeFileSync(path.join(dir, id + '.checkpoints.jsonl'), JSON.stringify(lines[0]) + '\n');

  const convs = conversations.discover(ctx, { foreign: true }).map((s) => conversations.load(ctx, s, {}));
  assert.strictEqual(convs.length, 1);
  const c = convs[0];
  assert.ok(c.id.indexOf('foreign:command-code:') === 0, c.id);
  assert.strictEqual(c.app, 'command-code');
  assert.strictEqual(c.surface, 'cli');
  assert.strictEqual(c.title, 'Command Code task');
  assert.deepStrictEqual(
    c.messages.map((m) => m.role),
    ['user', 'assistant'],
  );
  assert.deepStrictEqual(c.messages[1].tools, ['Read']);
});

test('Command Code v3: the session header supplies cwd for the conversation', function () {
  const ctx = ctxFor();
  const dir = path.join(ctx.home, '.commandcode', 'projects', '-work-cc');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'session', version: 3, id: 'v3-1', timestamp: '2026-10-19T12:00:00.000Z', cwd: '/work/cc' },
    {
      type: 'message',
      timestamp: '2026-10-19T12:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'Ship it.' }] },
    },
    {
      type: 'message',
      timestamp: '2026-10-19T12:00:02.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    },
  ];
  fs.writeFileSync(path.join(dir, 'v3-1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const c = conversations.discover(ctx, { foreign: true }).map((s) => conversations.load(ctx, s, {}))[0];
  assert.strictEqual(c.app, 'command-code');
  assert.strictEqual(c.surface, 'cli');
  assert.strictEqual(c.cwd, '/work/cc');
  assert.strictEqual(c.title, 'Ship it.');
  assert.strictEqual(c.counts.messages, 2);
});

test('matchRef accepts a full id, a unique prefix, and a unique title; ambiguity is refused', function () {
  const rows = [
    { id: 'claude:local:aaaa1111', title: 'Fix CI' },
    { id: 'claude:local:aaaa2222', title: 'Write docs' },
    { id: 'codex:bbbb3333', title: 'Fix CI too' },
  ];
  assert.strictEqual(conversations.matchRef(rows, 'claude:local:aaaa1111').match.id, 'claude:local:aaaa1111');
  assert.strictEqual(conversations.matchRef(rows, 'aaaa2').match.id, 'claude:local:aaaa2222');
  assert.strictEqual(conversations.matchRef(rows, 'Write docs').match.id, 'claude:local:aaaa2222');
  const amb = conversations.matchRef(rows, 'aaaa');
  assert.strictEqual(amb.match, null);
  assert.strictEqual(amb.reason, 'ambiguous');
  assert.strictEqual(amb.candidates.length, 2);
  assert.strictEqual(conversations.matchRef(rows, 'nope').reason, 'not-found');
});

test('a missing source is a CONV_SOURCE_GONE error, not an empty conversation', function () {
  const ctx = ctxFor();
  const gone = path.join(ctx.home, 'gone.jsonl');
  assert.throws(
    () => conversations.loadPath(ctx, gone, {}),
    (e) => e && e.code === 'CONV_SOURCE_GONE',
  );
});

test('transcript.parse and streaming parsers bound per-message text, message count, and total text bytes while convHash streams without full-array JSON.stringify', function () {
  // MEDIUM 1: transcript.parse must clamp message text at MAX_MESSAGE_CHARS (200k) during feedLine
  // rather than holding unbounded strings in memory.
  const hugeText = 'x'.repeat(350000);
  const parsed = transcript.parse(
    JSON.stringify({
      type: 'user',
      timestamp: '2026-10-01T10:00:00.000Z',
      message: { role: 'user', content: hugeText },
    }) + '\n',
  );
  assert.strictEqual(parsed.messages.length, 1);
  assert.strictEqual(parsed.messages[0].text.length, 200000, 'transcript.parse must clamp message text to 200k chars');

  // Streaming parser must also stop accumulating messages past maxMessages / maxTextBytes.
  const p = transcript.createParser({ maxMessages: 3, maxTextBytes: 500 });
  for (let i = 0; i < 10; i++) {
    p.feedLine(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'turn-' + i + '-' + 'a'.repeat(200) },
      }),
    );
  }
  const bounded = p.finish();
  assert.ok(bounded.messages.length <= 3, 'createParser must respect maxMessages during streaming');

  // convHash must match SHA-1(JSON.stringify(messages)) without calling JSON.stringify on the whole array.
  const ctx = ctxFor();
  const file = writeClaude(ctx, 'hash-check', [
    { type: 'user', message: { role: 'user', content: 'First message' } },
    { type: 'assistant', message: { role: 'assistant', content: 'Second message' } },
  ]);
  const conv = conversations.loadPath(ctx, file, {});
  const expected = crypto.createHash('sha1').update(JSON.stringify(conv.messages)).digest('hex');
  assert.strictEqual(conv.hash, expected);
});

test('streamed foreign .md fallback enforces the 160 MB MAX_FILE_BYTES cap instead of reading the whole file into memory', function () {
  // MEDIUM 2: A foreign .md or .jsonl file whose header is not aider/jsonl/commandcode must NOT bypass
  // the 160 MB whole-file cap via fs.readFileSync(filePath).
  const ctx = ctxFor();
  const dir = path.join(ctx.home, '.aider');
  fs.mkdirSync(dir, { recursive: true });
  const bigMd = path.join(dir, 'non-aider.md');
  const fd = fs.openSync(bigMd, 'w');
  try {
    // Write a non-Aider header followed by >160 MB (161 MB total)
    fs.writeSync(fd, Buffer.from('# Plain markdown file that is not an aider header\n\n'));
    const chunk = Buffer.alloc(16 * 1024 * 1024, 0x61); // 16 MB of 'a'
    chunk[chunk.length - 1] = 0x0a;
    for (let i = 0; i < 10; i++) fs.writeSync(fd, chunk);
    fs.writeSync(fd, Buffer.alloc(2 * 1024 * 1024, 0x61));
  } finally {
    fs.closeSync(fd);
  }
  try {
    const size = fs.statSync(bigMd).size;
    assert.ok(size > 160 * 1024 * 1024);
    assert.throws(
      () =>
        conversations.load(
          ctx,
          { kind: 'foreign', app: 'aider', tool: 'aider', surface: 'cli', path: bigMd, size: size, mtimeMs: 0 },
          {},
        ),
      /larger than 160 MB/,
      'non-streaming foreign fallback must reject files >160 MB',
    );
  } finally {
    fs.rmSync(bigMd, { force: true });
  }
});

test('forEachLine records a warning when a line exceeds MAX_LINE_CHARS instead of dropping it silently', function () {
  // LOW 1: Oversized lines dropped by forEachLine must be surfaced in conv.warnings.
  const ctx = ctxFor();
  const file = writeClaude(ctx, 'oversized-line', [
    { type: 'user', message: { role: 'user', content: 'Normal first turn.' } },
    { type: 'assistant', message: { role: 'assistant', content: 'X'.repeat(5000) } },
    { type: 'user', message: { role: 'user', content: 'Normal third turn.' } },
  ]);
  const conv = conversations.loadPath(ctx, file, { maxLineChars: 1000 });
  assert.strictEqual(conv.counts.messages, 2, 'the oversized middle line was skipped');
  assert.ok(Array.isArray(conv.warnings) && conv.warnings.length === 1, 'warning recorded on conversation');
  assert.match(conv.warnings[0].error, /oversized line|exceeded/i);
});

test('forEachLine streams an actual >160 MB JSONL session and UTF-8 across chunk boundaries', function () {
  // LOW 2: Prove that a session >160 MB (which the old whole-file readText rejected) is streamed
  // and indexed cleanly with bounded memory.
  const ctx = ctxFor();
  const dir = path.join(ctx.home, '.claude', 'projects', '-work-proj');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'over-160mb.jsonl');
  const fd = fs.openSync(file, 'w');
  try {
    const firstLine =
      JSON.stringify({
        type: 'user',
        timestamp: '2026-10-01T10:00:00.000Z',
        cwd: '/work/large',
        message: { role: 'user', content: 'Turn #0: ğüşıöçĞÜŞİÖÇ start of >160MB session' },
      }) + '\n';
    fs.writeSync(fd, Buffer.from(firstLine, 'utf8'));
    // Write 161 MB of valid JSONL tool/progress lines (ignored by transcript parser) so the file
    // genuinely exceeds the 160 MB MAX_FILE_BYTES limit while keeping test execution fast.
    const fillerLine =
      JSON.stringify({
        type: 'progress',
        data: 'ğüşıöçĞÜŞİÖÇ'.repeat(4000),
      }) + '\n';
    const fillerBuf = Buffer.from(fillerLine.repeat(180), 'utf8'); // ~16.5 MB per write
    for (let i = 0; i < 10; i++) fs.writeSync(fd, fillerBuf);
    const lastLine =
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-10-01T10:05:00.000Z',
        cwd: '/work/large',
        message: { role: 'assistant', content: 'Turn #last: ğüşıöçĞÜŞİÖÇ end of >160MB session' },
      }) + '\n';
    fs.writeSync(fd, Buffer.from(lastLine, 'utf8'));
  } finally {
    fs.closeSync(fd);
  }
  try {
    const size = fs.statSync(file).size;
    assert.ok(size > 160 * 1024 * 1024, 'fixture must be >160 MB, got ' + size);
    const conv = conversations.loadPath(ctx, file, {});
    assert.strictEqual(conv.id, 'claude:local:over-160mb');
    assert.strictEqual(conv.counts.messages, 2);
    assert.match(conv.messages[0].text, /^Turn #0: ğüşıöçĞÜŞİÖÇ/);
    assert.match(conv.messages[1].text, /^Turn #last: ğüşıöçĞÜŞİÖÇ/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});
