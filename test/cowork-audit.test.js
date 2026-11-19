// Unit, consolidation-dedupe, _audit_timestamp, and K9 exclusion tests for Claude Desktop Cowork audit.jsonl.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as cowork from '../src/cowork.js';
import * as conversations from '../src/conversations.js';
import * as convindex from '../src/convindex.js';
import * as transcript from '../src/transcript.js';
import { makeCtx } from './helpers.js';

test('transcript.parse falls back to _audit_timestamp when timestamp is absent', function () {
  const parsed = transcript.parse(
    [
      JSON.stringify({
        type: 'user',
        _audit_timestamp: '2026-11-15T12:00:00.000Z',
        cwd: '/work/cw',
        message: { role: 'user', content: 'Audit turn one.' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-15T12:00:05.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Reply one.' }] },
      }),
    ].join('\n'),
  );
  assert.strictEqual(parsed.counts.messages, 2);
  assert.strictEqual(parsed.messages[0].ts, '2026-11-15T12:00:00.000Z');
  assert.strictEqual(parsed.messages[1].ts, '2026-11-15T12:00:05.000Z');
});

test('cowork auditSources: reads audit.jsonl + sibling local_<id>.json, dedupes consolidated copies, skips skills-plugin, excludes K9 PII/noise', async function () {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-cw-audit-'));
  try {
    const appData = path.join(tmp, 'Library', 'Application Support', 'Claude');
    const ctx = makeCtx({ home: tmp, appDataDir: appData });
    const acct1 = path.join(appData, 'local-agent-mode-sessions', 'acct-aaa', 'org-111');
    const acct2 = path.join(appData, 'local-agent-mode-sessions', 'acct-bbb', 'org-222');
    const skillsPlugin = path.join(appData, 'local-agent-mode-sessions', 'skills-plugin', 'org-0');
    const sess1Dir = path.join(acct1, 'local_cw01');
    const sess2Dir = path.join(acct2, 'local_cw01');
    fs.mkdirSync(sess1Dir, { recursive: true });
    fs.mkdirSync(sess2Dir, { recursive: true });
    fs.mkdirSync(path.join(skillsPlugin, 'local_plugin'), { recursive: true });

    const secretEmail = 'private-owner@' + 'example.test';
    const metaBase = {
      sessionId: 'cw-session-1',
      title: 'Cowork Audit Title',
      cwd: '/work/cowork-proj',
      emailAddress: secretEmail,
      createdAt: 1762100000000,
    };
    fs.writeFileSync(
      path.join(acct1, 'local_cw01.json'),
      JSON.stringify(Object.assign({}, metaBase, { lastActivityAt: 1762100050000 })),
    );
    fs.writeFileSync(
      path.join(acct2, 'local_cw01.json'),
      JSON.stringify(Object.assign({}, metaBase, { lastActivityAt: 1762100900000 })),
    );

    const auditLines = [
      {
        type: 'system',
        _audit_timestamp: '2026-11-15T10:00:00.000Z',
        message: { role: 'system', content: 'PLANTED_CW_SYSTEM' },
      },
      {
        type: 'user',
        _audit_timestamp: '2026-11-15T10:00:01.000Z',
        _audit_hmac: 'hmac-ignored',
        cwd: '/work/cowork-proj',
        message: { role: 'user', content: 'cwm83marker Summarize audit trail.' },
      },
      {
        type: 'assistant',
        _audit_timestamp: '2026-11-15T10:00:02.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'PLANTED_CW_THINKING' },
            { type: 'text', text: 'Audited the workspace.' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
      {
        type: 'user',
        _audit_timestamp: '2026-11-15T10:00:03.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'PLANTED_CW_TOOL_RESULT' }] },
      },
    ];
    fs.writeFileSync(
      path.join(sess1Dir, 'audit.jsonl'),
      auditLines
        .slice(0, 2)
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n',
    );
    fs.writeFileSync(path.join(sess2Dir, 'audit.jsonl'), auditLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    // skills-plugin must never be indexed as a conversation
    fs.writeFileSync(
      path.join(skillsPlugin, 'local_plugin', 'audit.jsonl'),
      JSON.stringify({
        type: 'user',
        _audit_timestamp: '2026-11-15T10:00:00Z',
        message: { role: 'user', content: 'PLANTED_PLUGIN_BOOKKEEPING' },
      }) + '\n',
    );

    const audited = cowork.auditSources(ctx);
    assert.strictEqual(audited.length, 1, 'consolidated duplicate sessionId is deduplicated once');
    assert.strictEqual(audited[0].path, path.join(sess2Dir, 'audit.jsonl'));

    const disc = conversations.discover(ctx, {});
    assert.strictEqual(disc.length, 1);
    const conv = conversations.load(ctx, disc[0], {});
    assert.strictEqual(conv.id, 'cowork:cw-session-1');
    assert.strictEqual(conv.app, 'cowork');
    assert.strictEqual(conv.surface, 'desktop');
    assert.strictEqual(conv.title, 'Cowork Audit Title');
    assert.strictEqual(conv.cwd, '/work/cowork-proj');
    assert.strictEqual(conv.account, null, 'emailAddress must not leak into canonical account field');
    assert.deepStrictEqual(
      conv.messages.map((m) => m.role),
      ['user', 'assistant'],
    );
    assert.deepStrictEqual(conv.messages[1].tools, ['Bash']);
    assert.strictEqual(conv.messages[0].ts, '2026-11-15T10:00:01.000Z');

    const report = await convindex.build(ctx, { embed: false });
    assert.strictEqual(report.ok, true);
    const chunksDir = path.join(ctx.configDir, 'conv-index', 'chunks');
    const chunkText = fs
      .readdirSync(chunksDir)
      .map((f) => fs.readFileSync(path.join(chunksDir, f), 'utf8'))
      .join('\n');
    for (const planted of [
      'PLANTED_CW_SYSTEM',
      'PLANTED_CW_THINKING',
      'PLANTED_CW_TOOL_RESULT',
      'PLANTED_PLUGIN_BOOKKEEPING',
      secretEmail,
    ]) {
      assert.strictEqual(chunkText.indexOf(planted), -1, 'K9: ' + planted + ' excluded from chunks');
    }
    const hit = await convindex.search(ctx, 'cwm83marker', { apps: ['cowork'] });
    assert.strictEqual(hit.hits.length, 1);
    assert.strictEqual(hit.hits[0].title, 'Cowork Audit Title');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
