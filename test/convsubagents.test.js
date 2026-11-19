// Tests for Claude Code and Qoder sub-agent transcript readers, status/search separation,
// sourceKey stability, deletion cleanup, unknown account reporting, and secret/noise filtering.
import test from 'node:test';
import assert from 'node:assert';
import cp from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import * as conversations from '../src/conversations.js';
import * as convindex from '../src/convindex.js';
import * as convaccounts from '../src/convaccounts.js';
import * as convexport from '../src/convexport.js';
import * as foreign from '../src/foreign.js';
import * as profiles from '../src/profiles.js';
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

function writeJsonl(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('Claude sub-agents: separate counts, search label, unknown account, noise/secret guard, idempotent & deletion', async function () {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-sub-claude-'));
  try {
    const ctx = makeCtx({ home: tmp });
    ctx.env = {};

    // Seed a switch timeline to prove sub-agents stay unattributed ("unknown") rather than guessing.
    profiles.write(ctx.configDir, { name: 'workacct' });
    const logDir = path.join(ctx.configDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'keyflip.log'), '2026-10-14T09:00:00.000Z active -> workacct\n', {
      mode: 0o600,
    });

    const claudeProj = path.join(tmp, '.claude', 'projects', '-work-subproj');
    writeJsonl(path.join(claudeProj, 'sess-1.jsonl'), [
      {
        type: 'user',
        timestamp: '2026-10-14T10:00:00.000Z',
        cwd: '/work/subproj',
        message: { role: 'user', content: 'Parent session prompt one.' },
      },
      {
        type: 'assistant',
        timestamp: '2026-10-14T10:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Parent session reply one.' }] },
      },
    ]);
    writeJsonl(path.join(claudeProj, 'sess-2.jsonl'), [
      {
        type: 'user',
        timestamp: '2026-10-14T10:05:00.000Z',
        cwd: '/work/subproj',
        message: { role: 'user', content: 'Parent session prompt two.' },
      },
    ]);

    // First index WITHOUT subagents folder to capture baseline parent stats.
    const baseIdx = runCli(tmp, ['conv', 'index', '--no-embed', '--json']);
    assert.strictEqual(baseIdx.status, 0, baseIdx.stderr);
    const stBefore = lastJson(runCli(tmp, ['conv', 'status', '--json']));
    assert.strictEqual(stBefore.stats.byApp.claude.sources, 2);
    const parentSnapshot = Object.assign({}, stBefore.stats.byApp.claude);

    // Add 3 sub-agent transcripts under sess-1 (all carry sessionId: 'sess-1', the parent id).
    const subDir = path.join(claudeProj, 'sess-1', 'subagents');
    const splitSecret = 'sk-ant-' + 'api03-' + 'z'.repeat(24);
    writeJsonl(path.join(subDir, 'agent-a1.jsonl'), [
      {
        parentUuid: null,
        isSidechain: true,
        agentId: 'a1',
        sessionId: 'sess-1',
        timestamp: '2026-10-14T10:01:00.000Z',
        cwd: '/work/subproj',
        type: 'user',
        message: { role: 'user', content: '<environment_context>DROP_SUBAGENT_INJECTED</environment_context>' },
      },
      {
        parentUuid: 'u1',
        isSidechain: true,
        agentId: 'a1',
        sessionId: 'sess-1',
        timestamp: '2026-10-14T10:01:02.000Z',
        cwd: '/work/subproj',
        type: 'user',
        message: {
          role: 'user',
          content: '<system-reminder>DROP_SUBAGENT_REMINDER</system-reminder>Inspect module A.',
        },
      },
      {
        parentUuid: 'u2',
        isSidechain: true,
        agentId: 'a1',
        sessionId: 'sess-1',
        timestamp: '2026-10-14T10:01:05.000Z',
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Checked module A.' }] },
      },
    ]);
    writeJsonl(path.join(subDir, 'agent-a2.jsonl'), [
      {
        parentUuid: null,
        isSidechain: true,
        agentId: 'a2',
        sessionId: 'sess-1',
        timestamp: '2026-10-14T10:02:00.000Z',
        cwd: '/work/subproj',
        type: 'user',
        message: { role: 'user', content: 'Investigate sub91unique token failure.' },
      },
      {
        parentUuid: 'u3',
        isSidechain: true,
        agentId: 'a2',
        sessionId: 'sess-1',
        timestamp: '2026-10-14T10:02:05.000Z',
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Found root cause in retry loop.' }] },
      },
    ]);
    const a3Path = writeJsonl(path.join(subDir, 'agent-a3.jsonl'), [
      {
        parentUuid: null,
        isSidechain: true,
        agentId: 'a3',
        sessionId: 'sess-1',
        timestamp: '2026-10-14T10:03:00.000Z',
        cwd: '/work/subproj',
        type: 'user',
        message: { role: 'user', content: 'Check secret handling in sub-agent.' },
      },
      {
        parentUuid: 'u4',
        isSidechain: true,
        agentId: 'a3',
        sessionId: 'sess-1',
        timestamp: '2026-10-14T10:03:05.000Z',
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'api_key: ' + splitSecret }] },
      },
    ]);

    const idx2 = runCli(tmp, ['conv', 'index', '--no-embed', '--json']);
    assert.strictEqual(idx2.status, 0, idx2.stderr);

    // Check 1: parent count & stats completely unchanged; sub-agents counted separately.
    const stAfter = lastJson(runCli(tmp, ['conv', 'status', '--json']));
    assert.deepStrictEqual(stAfter.stats.byApp.claude, parentSnapshot);
    assert.strictEqual(stAfter.stats.byApp['claude (subagent)'].sources, 3);
    assert.strictEqual(stAfter.stats.byApp['claude (subagent)'].surface, 'subagent');

    const stHuman = runCli(tmp, ['conv', 'status']);
    assert.strictEqual(stHuman.status, 0, stHuman.stderr);
    assert.match(stHuman.stdout, /claude\s+2 conv/);
    assert.match(stHuman.stdout, /claude \(subagent\)\s+3 conv/);

    // Check 2: search returns only the sub-agent hit labelled claude (subagent), never the parent.
    const srJson = lastJson(runCli(tmp, ['conv', 'search', 'sub91unique', '--json']));
    assert.strictEqual(srJson.hits.length, 1);
    assert.strictEqual(srJson.hits[0].id, 'claude:subagent:sess-1:a2');
    assert.strictEqual(srJson.hits[0].app, 'claude');
    assert.strictEqual(srJson.hits[0].surface, 'subagent');
    assert.strictEqual(srJson.hits[0].parentId, 'sess-1');

    const srHuman = runCli(tmp, ['conv', 'search', 'sub91unique']);
    assert.strictEqual(srHuman.status, 0, srHuman.stderr);
    assert.match(srHuman.stdout, /claude \(subagent\)/);

    const srNoSub = lastJson(runCli(tmp, ['conv', 'search', 'sub91unique', '--no-subagents', '--json']));
    assert.strictEqual(srNoSub.hits.length, 0);

    // Sub-agent account must report unknown even with a Claude switch boundary, and secrets/noise redact cleanly.
    const shHuman = runCli(tmp, ['conv', 'show', 'claude:subagent:sess-1:a1']);
    assert.strictEqual(shHuman.status, 0, shHuman.stderr);
    assert.match(shHuman.stdout, /account: unknown/);
    assert.strictEqual(shHuman.stdout.indexOf('DROP_SUBAGENT_INJECTED'), -1);
    assert.strictEqual(shHuman.stdout.indexOf('DROP_SUBAGENT_REMINDER'), -1);

    const subA3 = conversations.get(ctx, 'claude:subagent:sess-1:a3');
    assert.strictEqual(subA3.parentId, 'sess-1');
    assert.strictEqual(convaccounts.explain(ctx, subA3).account, null);
    const rendered = convexport.render(subA3, { format: 'md', redact: true });
    assert.strictEqual(rendered.content.indexOf(splitSecret), -1, 'split secret must be redacted on export');
    const remoteSafe = convindex.safeForEmbedding(subA3.messages[1].text, { remote: true });
    assert.strictEqual(remoteSafe.indexOf(splitSecret), -1, 'split secret must be redacted for remote embedding');

    // Check 8: second index reuses all 5 sources with 0 duplicates; deleting a sub-agent removes it cleanly.
    const idxRepeat = lastJson(runCli(tmp, ['conv', 'index', '--no-embed', '--json']));
    assert.strictEqual(idxRepeat.reused, 5);
    assert.strictEqual(idxRepeat.indexed, 0);
    assert.strictEqual(idxRepeat.duplicates, 0);

    fs.rmSync(a3Path);
    const idxDeleted = lastJson(runCli(tmp, ['conv', 'index', '--no-embed', '--json']));
    assert.strictEqual(idxDeleted.removed, 1);
    const stDeleted = lastJson(runCli(tmp, ['conv', 'status', '--json']));
    assert.strictEqual(stDeleted.stats.byApp.claude.sources, 2);
    assert.strictEqual(stDeleted.stats.byApp['claude (subagent)'].sources, 2);
    assert.strictEqual(fs.existsSync(convindex.chunkPath(ctx, 'claude:subagent:sess-1:a3')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Qoder sub-agents: separate count, no double listing by foreign.js, labelled search hit', function () {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-sub-qoder-'));
  try {
    const qProj = path.join(tmp, '.qoder', 'projects', '-work-qd');
    const qSubDir = path.join(qProj, 'qd-1', 'subagents');
    const qMemDir = path.join(qProj, 'qd-1', 'memory');
    const qCompDir = path.join(qProj, 'qd-1', 'compression-v2');
    [qSubDir, qMemDir, qCompDir].forEach((d) => fs.mkdirSync(d, { recursive: true }));

    writeJsonl(path.join(qProj, 'qd-1.jsonl'), [
      {
        type: 'user',
        timestamp: '2026-10-14T11:00:00.000Z',
        cwd: '/work/qd',
        message: { role: 'user', content: 'Qoder main session prompt.' },
      },
      {
        type: 'assistant',
        timestamp: '2026-10-14T11:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Qoder main reply.' }] },
      },
    ]);
    // Sibling Qoder sidecar files that must not become conversations.
    fs.writeFileSync(path.join(qProj, 'qd-1', 'state.json'), JSON.stringify({ step: 3 }));
    fs.writeFileSync(path.join(qCompDir, 'snap.json'), JSON.stringify({ summary: 'ignored' }));
    fs.writeFileSync(path.join(qMemDir, 'notes.jsonl'), JSON.stringify({ note: 'ignored' }) + '\n');

    writeJsonl(path.join(qSubDir, 'agent-x.jsonl'), [
      {
        parentUuid: null,
        isSidechain: true,
        agentId: 'x',
        sessionId: 'qd-1',
        timestamp: '2026-10-14T11:01:00.000Z',
        cwd: '/work/qd',
        type: 'user',
        message: { role: 'user', content: 'Resolve qdsub77marker dependency issue.' },
      },
      {
        parentUuid: 'qu1',
        isSidechain: true,
        agentId: 'x',
        sessionId: 'qd-1',
        timestamp: '2026-10-14T11:01:05.000Z',
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Updated lockfile.' }] },
      },
    ]);

    // foreign.discover must still list ONLY the main Qoder session, never the sub-agent.
    const foreignList = foreign.discover({ home: tmp });
    assert.deepStrictEqual(
      foreignList.map((f) => f.tool + ':' + path.basename(f.path)),
      ['qoder:qd-1.jsonl'],
    );

    const idx = runCli(tmp, ['conv', 'index', '--no-embed', '--json']);
    assert.strictEqual(idx.status, 0, idx.stderr);

    const st = lastJson(runCli(tmp, ['conv', 'status', '--json']));
    assert.strictEqual(st.stats.byApp.qoder.sources, 1);
    assert.strictEqual(st.stats.byApp['qoder (subagent)'].sources, 1);

    const srJson = lastJson(runCli(tmp, ['conv', 'search', 'qdsub77marker', '--json']));
    assert.strictEqual(srJson.hits.length, 1);
    assert.strictEqual(srJson.hits[0].id, 'qoder:subagent:qd-1:x');
    assert.strictEqual(srJson.hits[0].app, 'qoder');
    assert.strictEqual(srJson.hits[0].surface, 'subagent');
    assert.strictEqual(srJson.hits[0].parentId, 'qd-1');

    const srHuman = runCli(tmp, ['conv', 'search', 'qdsub77marker']);
    assert.strictEqual(srHuman.status, 0, srHuman.stderr);
    assert.match(srHuman.stdout, /qoder \(subagent\)/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
