// The canonical conversation layer: one shape for every local AI tool, harness noise stripped,
// ids/prefixes resolvable. Fixtures are synthetic — no real transcripts, no credentials.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { makeCtx } from './helpers.js';
import * as conversations from '../src/conversations.js';

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
    { type: 'assistant', message: { role: 'assistant', content: 'Ready.' } },
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
