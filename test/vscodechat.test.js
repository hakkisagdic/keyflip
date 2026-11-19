// Unit, discovery, deduplication, prototype-guard, and K9 exclusion tests for src/vscodechat.js.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as vscodechat from '../src/vscodechat.js';
import * as conversations from '../src/conversations.js';
import * as convindex from '../src/convindex.js';
import { makeCtx } from './helpers.js';

test('vscodechat: replays MFi kind 0/1/2/3 patches, guards __proto__, and strips K9 thinking/tool output', async function () {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-vs-patch-'));
  try {
    const ctx = makeCtx({ home: tmp });
    const lines = [
      JSON.stringify({
        kind: 0,
        v: {
          sessionId: 'vs-sess-1',
          customTitle: 'Initial Title',
          creationDate: 1762000000000,
          requests: [
            {
              requestId: 'r0',
              timestamp: 1762000001000,
              message: { text: 'vsz41marker Explain patch truncation.' },
              response: [{ kind: 'thinking', value: 'PLANTED_THINKING_0' }, { value: 'Draft wrong answer' }],
            },
          ],
        },
      }),
      // kind: 1 update title & malicious prototype-pollution paths (must be ignored safely)
      JSON.stringify({ kind: 1, k: ['customTitle'], v: 'Final Replayed Title' }),
      JSON.stringify({ kind: 1, k: ['__proto__', 'pollutedProp'], v: 'pwned' }),
      JSON.stringify({ kind: 1, k: ['constructor', 'prototype', 'pollutedProp'], v: 'pwned' }),
      // kind: 1 add removable property then kind: 3 delete it
      JSON.stringify({ kind: 1, k: ['tempNote'], v: 'ephemeral' }),
      JSON.stringify({ kind: 3, k: ['tempNote'] }),
      // kind: 2 truncate response at i=1 to replace 'Draft wrong answer' + add toolInvocationSerialized
      JSON.stringify({
        kind: 2,
        k: ['requests', 0, 'response'],
        i: 1,
        v: [
          { kind: 'markdownContent', content: { value: 'Truncate resets index i before pushing.' } },
          {
            kind: 'toolInvocationSerialized',
            toolId: 'run_in_terminal',
            resultDetails: 'PLANTED_TOOL_OUTPUT_STDOUT',
            pastTenseMessage: { value: 'PLANTED_PAST_TENSE' },
            invocationMessage: { value: 'PLANTED_INVOCATION' },
          },
        ],
      }),
      // kind: 2 push second request + a hidden request that must be skipped
      JSON.stringify({
        kind: 2,
        k: ['requests'],
        v: [
          {
            requestId: 'r1',
            timestamp: 1762000020000,
            message: { parts: [{ text: 'Follow-up ' }, { text: 'question.' }] },
            response: ['Final string reply.'],
          },
          {
            requestId: 'r_hidden',
            isHidden: true,
            message: { text: 'PLANTED_HIDDEN_REQ' },
            response: [{ value: 'PLANTED_HIDDEN_RESP' }],
          },
        ],
      }),
    ];

    const parsed = vscodechat.parseChatSession(lines.join('\n'));
    assert.strictEqual({}.pollutedProp, undefined, 'Object.prototype must never be polluted');
    assert.strictEqual(parsed.sessionId, 'vs-sess-1');
    assert.strictEqual(parsed.title, 'Final Replayed Title');
    assert.strictEqual(parsed.counts.messages, 4);
    assert.deepStrictEqual(
      parsed.messages.map((m) => m.role),
      ['user', 'assistant', 'user', 'assistant'],
    );
    assert.strictEqual(parsed.messages[0].text, 'vsz41marker Explain patch truncation.');
    assert.strictEqual(parsed.messages[1].text, 'Truncate resets index i before pushing.');
    assert.strictEqual(parsed.messages[1].text.indexOf('Draft wrong answer'), -1);
    assert.deepStrictEqual(parsed.messages[1].tools, ['run_in_terminal']);
    assert.strictEqual(parsed.messages[2].text, 'Follow-up \nquestion.');
    assert.strictEqual(parsed.messages[3].text, 'Final string reply.');

    // Wire end-to-end into workspaceStorage + workspace.json + emptyWindowChatSessions dedupe
    const uDir = path.join(tmp, 'Library', 'Application Support', 'Code', 'User');
    const wsDir = path.join(uDir, 'workspaceStorage', 'hash1');
    const wsChats = path.join(wsDir, 'chatSessions');
    const emptyChats = path.join(uDir, 'globalStorage', 'emptyWindowChatSessions');
    fs.mkdirSync(wsChats, { recursive: true });
    fs.mkdirSync(emptyChats, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'workspace.json'), JSON.stringify({ folder: 'file:///work/vscode-proj' }));
    const wsFile = path.join(wsChats, 'vs-sess-1.jsonl');
    const emptyFile = path.join(emptyChats, 'vs-sess-1.jsonl');
    fs.writeFileSync(wsFile, lines.join('\n') + '\n');
    fs.writeFileSync(
      emptyFile,
      JSON.stringify({ kind: 0, v: { sessionId: 'vs-sess-1', customTitle: 'Stale Copy', requests: [] } }) + '\n',
    );
    const old = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(emptyFile, old, old);

    const disc = conversations.discover(ctx, {});
    assert.strictEqual(disc.length, 1, 'duplicate emptyWindow copy deduped in favor of newer workspace copy');
    const conv = conversations.load(ctx, disc[0], {});
    assert.strictEqual(conv.id, 'vscode-chat:vs-sess-1');
    assert.strictEqual(conv.app, 'vscode-chat');
    assert.strictEqual(conv.surface, 'desktop');
    assert.strictEqual(conv.title, 'Final Replayed Title');
    assert.strictEqual(conv.cwd, '/work/vscode-proj');

    const report = await convindex.build(ctx, { embed: false });
    assert.strictEqual(report.ok, true);
    const chunksDir = path.join(ctx.configDir, 'conv-index', 'chunks');
    const chunkText = fs
      .readdirSync(chunksDir)
      .map((f) => fs.readFileSync(path.join(chunksDir, f), 'utf8'))
      .join('\n');
    for (const planted of [
      'PLANTED_THINKING_0',
      'PLANTED_TOOL_OUTPUT_STDOUT',
      'PLANTED_PAST_TENSE',
      'PLANTED_INVOCATION',
      'PLANTED_HIDDEN_REQ',
      'PLANTED_HIDDEN_RESP',
    ]) {
      assert.strictEqual(chunkText.indexOf(planted), -1, 'K9: ' + planted + ' excluded from chunks');
    }
    const hit = await convindex.search(ctx, 'vsz41marker', { apps: ['vscode-chat'] });
    assert.strictEqual(hit.hits.length, 1);
    assert.strictEqual(hit.hits[0].title, 'Final Replayed Title');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
