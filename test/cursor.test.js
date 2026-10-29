// The Cursor adapter (src/cursor.js): one `state.vscdb` is MANY chats, one `store.db` is one CLI
// session, and the JSONL under `projects/` repeats a chat the composer store already has. The tests
// are built around the things a file-per-chat reader gets wrong — turn order, which bubbles belong
// to the conversation at all, forks and subagents, and what a store this parser will not read has to
// report.
//
// Fixtures are REAL SQLite files written by the sqlite3 CLI, for the same reason the other SQLite
// suites are: a hand-made "database" would not exercise the page/overflow decoding keyflip depends
// on. Cursor itself is not installed on the machine these were written on, so every fixture follows
// the layout the shipped reverse-engineered parsers agree on (see the header of src/cursor.js) and
// the assertions pin the CONTRACT the adapter promises — tolerant reads, honest skips, no invented
// messages. Re-run them against a real install when one is available.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import cp from 'child_process';
import { SQLITE_SKIP } from './sqlite.js';
import { makeCtx } from './helpers.js';
import * as cursor from '../src/cursor.js';
import * as foreign from '../src/foreign.js';
import * as conversations from '../src/conversations.js';

function esc(s) {
  return String(s).replace(/'/g, "''");
}

const HEADERS_CREATE =
  'CREATE TABLE composerHeaders(composerId TEXT, workspaceId TEXT, createdAt INTEGER, ' +
  'lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt TEXT, value TEXT);';

// One editor store: the `cursorDiskKV` key/value rows, plus optionally the ≥3.12 `composerHeaders`
// table. `omitKV` builds a database that is only the headers table, which is how a half-migrated
// store can look.
function mkStore(rows, opts) {
  opts = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-cursor-'));
  const file = path.join(dir, 'state.vscdb');
  const sql = [];
  if (!opts.omitKV) sql.push('CREATE TABLE cursorDiskKV(key TEXT, value TEXT);');
  if (opts.headers) sql.push(HEADERS_CREATE);
  (rows || []).forEach(function (r) {
    sql.push("INSERT INTO cursorDiskKV VALUES('" + esc(r[0]) + "','" + esc(JSON.stringify(r[1])) + "');");
  });
  (opts.headers || []).forEach(function (h) {
    sql.push('INSERT INTO composerHeaders VALUES(' + h.map(sqlLit).join(',') + ');');
  });
  cp.execFileSync('sqlite3', [file], { input: sql.join('\n') + '\n' });
  return file;
}
function sqlLit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return "'" + esc(v) + "'";
}
function cd(id, o) {
  return ['composerData:' + id, o || {}];
}
function bd(composer, bubble, o) {
  return ['bubbleId:' + composer + ':' + bubble, o];
}

// A Cursor "base" for the editor: `ctx.cursorUserDir` is the `User` directory, so the platform hunt
// is not what is under test. Workspace stores come with the `workspace.json` VS Code writes.
function seededIde(globalRows, workspaces, globalOpts) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-cursor-ide-'));
  const user = path.join(tmp, 'User');
  const gs = path.join(user, 'globalStorage');
  fs.mkdirSync(gs, { recursive: true });
  if (globalRows || globalOpts) fs.copyFileSync(mkStore(globalRows, globalOpts), path.join(gs, 'state.vscdb'));
  (workspaces || []).forEach(function (w) {
    const dir = path.join(user, 'workspaceStorage', w.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(mkStore(w.rows, w.opts), path.join(dir, 'state.vscdb'));
    if (w.workspaceJson !== null)
      fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify(w.workspaceJson || { folder: w.folder }));
    if (w.mtimeMs) fs.utimesSync(path.join(dir, 'state.vscdb'), new Date(w.mtimeMs), new Date(w.mtimeMs));
  });
  const ctx = makeCtx();
  ctx.cursorUserDir = user;
  ctx.env = {};
  return { ctx: ctx, user: user, tmp: tmp, global: path.join(gs, 'state.vscdb') };
}

function chatBy(ctx, id) {
  const found = cursor.chats(ctx);
  return found.chats.filter(function (c) {
    return c.composerId === id;
  })[0];
}
function texts(chat) {
  return chat.messages.map(function (m) {
    return m.text;
  });
}

// ---- the editor store ------------------------------------------------------------------------

test(
  'one store is many chats: every composer with bubbles becomes its own conversation',
  { skip: SQLITE_SKIP },
  function () {
    const s = seededIde([
      cd('A', { name: 'Fix the parser', projectPath: '/work/app' }),
      bd('A', 'a1', { type: 1, text: 'the parser breaks on unicode', createdAt: 1767225600000 }),
      bd('A', 'a2', { type: 2, text: 'it reads a byte length as a char count', createdAt: 1767225610000 }),
      cd('B', { name: 'Ship it' }),
      bd('B', 'b1', { type: 1, text: 'write the changelog' }),
      bd('B', 'b2', { type: 2, text: 'done' }),
    ]);
    const out = cursor.chats(s.ctx);
    assert.strictEqual(out.chats.length, 2, 'two composers, two chats — not one merged conversation');
    assert.strictEqual(out.stores, 1);
    const a = chatBy(s.ctx, 'A');
    assert.strictEqual(a.title, 'Fix the parser');
    assert.strictEqual(a.cwd, '/work/app');
    assert.deepStrictEqual(
      a.messages.map(function (m) {
        return m.role;
      }),
      ['user', 'assistant'],
    );
    assert.strictEqual(a.createdAt, '2026-01-01T00:00:00.000Z', 'a ms epoch bubble becomes an ISO instant');
    assert.strictEqual(a.updatedAt, '2026-01-01T00:00:10.000Z');
  },
);

test(
  'composerHeaders is read BY COLUMN NAME and carries what the composer document does not',
  {
    skip: SQLITE_SKIP,
  },
  function () {
    const s = seededIde(
      [
        cd('SUB', { fullConversationHeadersOnly: [{ bubbleId: 's1', type: 1 }] }),
        bd('SUB', 's1', { type: 1, text: 'child work' }),
        cd('ARCH', { fullConversationHeadersOnly: [{ bubbleId: 'r1', type: 1 }] }),
        bd('ARCH', 'r1', { type: 1, text: 'an archived chat' }),
      ],
      null,
      {
        headers: [
          [
            'SUB',
            'ws-9',
            1767225600000,
            1767225660000,
            0,
            1,
            1767225660000,
            null,
            JSON.stringify({ type: 'head', name: 'Subagent run' }),
          ],
          [
            'ARCH',
            'ws-9',
            1767225700000,
            1767225800000,
            1,
            0,
            1767225800000,
            null,
            JSON.stringify({ type: 'head', name: 'Old work', subtitle: 'secondary' }),
          ],
          // A header whose composerData row is missing entirely is still enumerated; with no bubbles it
          // is not a conversation, so it must be dropped rather than invented.
          ['GHOST', 'ws-9', 1767225000000, 1767225100000, 0, 0, 1767225100000, null, JSON.stringify({ type: 'head' })],
        ],
      },
    );
    const out = cursor.chats(s.ctx);
    assert.deepStrictEqual(
      out.chats
        .map(function (c) {
          return c.composerId;
        })
        .sort(),
      ['ARCH', 'SUB'],
      'a header with no readable messages is not a chat',
    );
    const sub = chatBy(s.ctx, 'SUB');
    assert.strictEqual(sub.isSubagent, true, 'the isSubagent column, not a guessed field');
    assert.strictEqual(sub.isArchived, false);
    assert.strictEqual(sub.workspaceId, 'ws-9');
    assert.strictEqual(sub.title, 'Subagent run', 'the head JSON inside the value column supplies the name');
    assert.strictEqual(sub.createdAt, '2026-01-01T00:00:00.000Z', 'and the createdAt column the clock');
    const arch = chatBy(s.ctx, 'ARCH');
    assert.strictEqual(arch.isArchived, true, 'archived chats stay indexed: they are history, not noise');
    assert.strictEqual(arch.title, 'Old work', 'name wins over subtitle');
  },
);

test(
  'the manifest is the conversation: unlisted bubbles are counted and dropped, never appended',
  {
    skip: SQLITE_SKIP,
  },
  function () {
    const s = seededIde([
      cd('A', {
        name: 'edited',
        fullConversationHeadersOnly: [
          { bubbleId: 'keep1', type: 1, createdAt: '2026-01-01T00:00:00Z' },
          { bubbleId: 'keep2', type: 2, createdAt: '2026-01-01T00:00:05Z' },
        ],
      }),
      bd('A', 'keep1', { type: 1, text: 'asked' }),
      bd('A', 'keep2', { type: 2, text: 'answered' }),
      // an edited-away / regenerated turn: the row is still on disk, the editor does not draw it
      bd('A', 'gone', { type: 2, text: 'the answer the user replaced' }),
    ]);
    const a = chatBy(s.ctx, 'A');
    assert.deepStrictEqual(texts(a), ['asked', 'answered'], 'a transcript that never happened is not shown');
    assert.strictEqual(a.unlisted, 1, 'but the count survives, so the user can see rows were left out');
  },
);

test(
  'grouping.isRenderable false is dropped, a header with no grouping is kept, a vanished bubble is counted',
  {
    skip: SQLITE_SKIP,
  },
  function () {
    const s = seededIde([
      cd('A', {
        fullConversationHeadersOnly: [
          { bubbleId: 'hidden', type: 1, grouping: { isRenderable: false, hasText: true } },
          { bubbleId: 'bare', type: 1 },
          { bubbleId: 'groupedTrue', type: 2, grouping: { isRenderable: true, hasText: true } },
          { bubbleId: 'vanished', type: 1, grouping: { isRenderable: true } },
        ],
      }),
      bd('A', 'hidden', { type: 1, text: 'not drawn by the editor' }),
      bd('A', 'bare', { type: 1, text: 'a build with no grouping field' }),
      bd('A', 'groupedTrue', { type: 2, text: 'drawn' }),
    ]);
    const a = chatBy(s.ctx, 'A');
    assert.deepStrictEqual(texts(a), ['a build with no grouping field', 'drawn']);
    assert.strictEqual(a.hidden, 1, 'un-renderable turns are counted, not silently lost');
    assert.strictEqual(a.missing, 1, 'the manifest listed a row the store no longer has');
    assert.strictEqual(a.unlisted, 0, 'and nothing was left out that the manifest does list');
  },
);

test('no manifest: bubbles keep their insertion order, not their key order', { skip: SQLITE_SKIP }, function () {
  // Inserted oldest-first (the rowid order the CLI appended them in) with bubble ids that sort the
  // other way, so a key sort (a → b → c) would read the chat backwards.
  const s = seededIde([
    bd('A', 'c', { type: 1, text: 'first' }),
    bd('A', 'b', { type: 1, text: 'second' }),
    bd('A', 'a', { type: 2, text: 'third' }),
    cd('A', {}),
  ]);
  const a = chatBy(s.ctx, 'A');
  assert.deepStrictEqual(texts(a), ['first', 'second', 'third'], 'rowid order is what txcript falls back to');
  assert.strictEqual(cursor.conversationOrder(require_store(s), 'A').hasManifest, false);
});

function require_store(s) {
  return cursor.parseStore(s.global, s.ctx);
}

test(
  'bubble types map to who spoke: 1 is you, 2 is the model, anything else is machine output',
  {
    skip: SQLITE_SKIP,
  },
  function () {
    const s = seededIde([
      cd('A', {}),
      bd('A', 't1', { type: 1, text: 'user typed' }),
      bd('A', 't2', { type: 2, text: 'model wrote' }),
      bd('A', 't3', { type: 3, text: 'a slash command' }),
      bd('A', 't9', { text: 'no type at all' }),
    ]);
    const a = chatBy(s.ctx, 'A');
    assert.deepStrictEqual(
      a.messages.map(function (m) {
        return m.role + ':' + m.text;
      }),
      ['user:user typed', 'assistant:model wrote', 'assistant:a slash command', 'assistant:no type at all'],
      'an unattested type is still the machine turn, never a dropped answer',
    );
  },
);

test('the manifest type wins over the bubble type when the two disagree', { skip: SQLITE_SKIP }, function () {
  const s = seededIde([
    cd('A', { fullConversationHeadersOnly: [{ bubbleId: 'b1', type: 1 }] }),
    bd('A', 'b1', { type: 2, text: 'what the row says it is' }),
  ]);
  assert.strictEqual(chatBy(s.ctx, 'A').messages[0].role, 'user', 'the editor rendered it as the user turn');
});

test(
  'text arrives as a string, as content blocks, or nested — all of them are read',
  {
    skip: SQLITE_SKIP,
  },
  function () {
    const s = seededIde([
      cd('A', {}),
      bd('A', 'b1', { type: 2, content: [{ type: 'text', text: 'para one' }, { text: 'para two' }] }),
      bd('A', 'b2', { type: 2, content: { text: 'nested object' } }),
    ]);
    const a = chatBy(s.ctx, 'A');
    assert.strictEqual(a.messages[0].text, 'para one\npara two');
    assert.strictEqual(a.messages[1].text, 'nested object');
  },
);

test(
  'capabilityType says what a bubble is: 30 thinking, 15 a tool call with its name',
  {
    skip: SQLITE_SKIP,
  },
  function () {
    const s = seededIde([
      cd('A', {
        _v: 3,
        fullConversationHeadersOnly: [{ bubbleId: 'th' }, { bubbleId: 'tl' }, { bubbleId: 'to' }],
      }),
      bd('A', 'th', { type: 2, capabilityType: 30, thinking: { text: 'let me check the tests first' } }),
      bd('A', 'tl', {
        type: 2,
        capabilityType: 15,
        toolFormerData: { name: 'run_terminal_command_v2', args: { cmd: 'npm test' } },
      }),
      // a tool turn with no prose is still a turn the agent took
      bd('A', 'to', { type: 2, capabilityType: 15, toolFormerData: { name: 'read_file_v2' }, text: '' }),
    ]);
    const a = chatBy(s.ctx, 'A');
    assert.deepStrictEqual(texts(a), ['let me check the tests first', '', '']);
    assert.deepStrictEqual(
      a.messages.map(function (m) {
        return m.tools.join(',');
      }),
      // The thinking bubble has no tool; the two tool bubbles are indexed BY TOOL NAME, which is what
      // `conv search "edited X"` can then find.
      ['', 'run_terminal_command_v2', 'read_file_v2'],
    );
  },
);

test(
  'a signature-only thinking bubble is not a message, and neither is an empty bubble',
  {
    skip: SQLITE_SKIP,
  },
  function () {
    const s = seededIde([
      cd('A', {}),
      bd('A', 'x1', { type: 2, capabilityType: 30, thinking: { signature: 'opaque' } }),
      bd('A', 'x2', { type: 2, text: '   ' }),
      bd('A', 'x3', { type: 1, text: 'the only real turn' }),
    ]);
    const a = chatBy(s.ctx, 'A');
    assert.deepStrictEqual(texts(a), ['the only real turn']);
  },
);

test(
  'pre-_v3 composers keep the tool payload in capabilities[].data.bubbleDataMap, sometimes as a string',
  {
    skip: SQLITE_SKIP,
  },
  function () {
    const s = seededIde([
      cd('A', {
        _v: 2,
        capabilities: [
          { capabilityType: 15, data: { bubbleDataMap: JSON.stringify({ b7: { name: 'str_replace_edit' } }) } },
          { capabilityType: 15, data: { bubbleDataMap: { b8: { name: 'codebase_search' } } } },
        ],
      }),
      bd('A', 'b7', { type: 2, text: '' }),
      bd('A', 'b8', { type: 2, text: '' }),
      bd('A', 'b9', { type: 1, text: 'asked' }),
    ]);
    const a = chatBy(s.ctx, 'A');
    assert.deepStrictEqual(
      a.messages.map(function (m) {
        return m.tools.join(',');
      }),
      ['str_replace_edit', 'codebase_search', ''],
      'the map is keyed by bubble id, in manifest-free rowid order',
    );
  },
);

test(
  'a tool turn with no name falls back to the numeric id table, then to a labelled unknown',
  {
    skip: SQLITE_SKIP,
  },
  function () {
    const s = seededIde([
      cd('A', { _v: 3 }),
      bd('A', 'n1', { type: 2, text: '', toolFormerData: { tool: 15 } }),
      bd('A', 'n2', { type: 2, text: '', toolFormerData: { tool: 40 } }),
      bd('A', 'n3', { type: 2, text: '', toolFormerData: { tool: 777 } }),
      bd('A', 'n4', { type: 2, capabilityType: 15, text: '' }),
    ]);
    const a = chatBy(s.ctx, 'A');
    assert.deepStrictEqual(
      a.messages.map(function (m) {
        return m.tools.join(',');
      }),
      ['run_terminal_command_v2', 'read_file_v2', 'cursor-tool-777', 'tool'],
      'an unmapped id is labelled as one, never dropped and never guessed',
    );
  },
);

test('timestamps: milliseconds, seconds and ISO strings all land on one clock', function () {
  assert.strictEqual(cursor.toIso(1767225600000), '2026-01-01T00:00:00.000Z');
  assert.strictEqual(cursor.toIso(1767225600), '2026-01-01T00:00:00.000Z', 'a bare seconds value is not a 1970 date');
  assert.strictEqual(cursor.toIso('2026-01-01T00:00:00.000Z'), '2026-01-01T00:00:00.000Z');
  assert.strictEqual(cursor.toIso('1767225600000'), '2026-01-01T00:00:00.000Z', 'a numeric string is still a number');
  assert.strictEqual(cursor.toIso('yesterday'), null, 'unreadable is unreadable, not guessed');
  assert.strictEqual(cursor.toIso(null), null);
  assert.strictEqual(cursor.toIso(NaN), null);
});

test(
  'a bubble timestamp falls back through the manifest, timingInfo and the composer clock',
  {
    skip: SQLITE_SKIP,
  },
  function () {
    const s = seededIde([
      cd('A', {
        lastUpdatedAt: 1767225900000,
        // Every bubble is in the manifest, as a live composer has it; only `m` carries the
        // manifest-side clock, which is what the other two must fall through past.
        fullConversationHeadersOnly: [
          { bubbleId: 'm', createdAt: 1767225600000 },
          { bubbleId: 'ti' },
          { bubbleId: 'none' },
        ],
      }),
      bd('A', 'm', { type: 1, text: 'manifest clock' }),
      bd('A', 'ti', { type: 1, text: 'fractional ms', timingInfo: { start: 1767225700000.4 } }),
      bd('A', 'none', { type: 1, text: 'no clock of its own' }),
    ]);
    const a = chatBy(s.ctx, 'A');
    assert.strictEqual(a.messages[0].ts, '2026-01-01T00:00:00.000Z');
    assert.strictEqual(a.messages[1].ts, '2026-01-01T00:01:40.000Z', 'timingInfo is milliseconds, not seconds');
    assert.strictEqual(a.messages[2].ts, '2026-01-01T00:05:00.000Z', 'else the composer last-updated time');
  },
);

test(
  'cwd: the composer path, the workspace URI, the agent location, then the git repo',
  {
    skip: SQLITE_SKIP,
  },
  function () {
    const s = seededIde(
      [
        cd('ABS', { projectPath: '/work/app' }),
        bd('ABS', 'p', { type: 1, text: 'a projectPath chat' }),
        cd('URI', { workspaceIdentifier: { uri: { fsPath: 'file:///Users/dev/caf%C3%A9' } } }),
        bd('URI', 'u', { type: 1, text: 'a workspaceIdentifier chat' }),
        cd('AGENT', { agentLocation: { environment: { uri: { fsPath: '/work/agent' } } } }),
        bd('AGENT', 'g', { type: 1, text: 'an agent-location chat' }),
        cd('GIT', { trackedGitRepos: [{ repoPath: '/work/repo' }] }),
        bd('GIT', 'r', { type: 1, text: 'a tracked-repo chat' }),
        cd('NONE', {}),
        bd('NONE', 'n1', { type: 1, text: 'no project recorded' }),
      ],
      [
        {
          id: 'w1',
          folder: 'file:///Users/dev/repo',
          rows: [cd('W', { name: 'in a workspace' }), bd('W', 'w1', { type: 1, text: 'workspace chat' })],
        },
      ],
    );
    assert.strictEqual(chatBy(s.ctx, 'ABS').cwd, '/work/app');
    assert.strictEqual(chatBy(s.ctx, 'URI').cwd, '/Users/dev/café', 'a file URI is percent-decoded');
    assert.strictEqual(chatBy(s.ctx, 'AGENT').cwd, '/work/agent');
    assert.strictEqual(chatBy(s.ctx, 'GIT').cwd, '/work/repo');
    assert.strictEqual(chatBy(s.ctx, 'NONE').cwd, null, 'a global store invents no project path');
    assert.strictEqual(chatBy(s.ctx, 'W').cwd, '/Users/dev/repo', 'a workspace store lends its own folder');
  },
);

test('remote workspace URIs are reported as the location they name, not resolved locally', function () {
  assert.strictEqual(
    cursor.uriToPath('vscode-remote://wsl+ubuntu/home/me/proj'),
    'vscode-remote://wsl+ubuntu/home/me/proj',
  );
  assert.strictEqual(cursor.uriToPath('file:///C:/work/app'), 'C:/work/app');
  assert.strictEqual(cursor.uriToPath('/plain/path'), '/plain/path');
  assert.strictEqual(cursor.uriToPath(null), null);
});

test(
  'the same composer in the global and a workspace store is one chat, from the newest store',
  {
    skip: SQLITE_SKIP,
  },
  function () {
    const now = Date.now();
    const s = seededIde(
      [cd('A', { name: 'older copy' }), bd('A', 'b1', { type: 1, text: 'same chat, stale file' })],
      [
        {
          id: 'w1',
          folder: 'file:///work/x',
          rows: [cd('A', { name: 'newer copy' }), bd('A', 'b1', { type: 1, text: 'same chat, fresh file' })],
          mtimeMs: now + 60000,
        },
      ],
    );
    const out = cursor.chats(s.ctx);
    assert.strictEqual(out.chats.length, 1, 'deduped by composer id, not by file');
    assert.strictEqual(out.chats[0].title, 'newer copy');
    assert.ok(/workspaceStorage/.test(out.chats[0].source.path), 'and it came from the store that is newer');
  },
);

test(
  'a store where only the workspace copy has the bubbles still yields the chat once',
  {
    skip: SQLITE_SKIP,
  },
  function () {
    const now = Date.now();
    const s = seededIde(
      [cd('A', { name: 'header only here' })],
      [
        {
          id: 'w1',
          folder: 'file:///work/x',
          // older file, but the only one carrying the messages
          rows: [cd('A', { name: 'with messages' }), bd('A', 'b1', { type: 1, text: 'the real transcript' })],
          mtimeMs: now - 60000,
        },
      ],
    );
    const out = cursor.chats(s.ctx);
    assert.strictEqual(out.chats.length, 1);
    assert.strictEqual(out.chats[0].messages.length, 1, 'an empty copy must not claim the id and hide the chat');
  },
);

test(
  'ids are folded before they become keys, and no composer id can pollute a prototype',
  {
    skip: SQLITE_SKIP,
  },
  function () {
    assert.strictEqual(cursor.safeId('0f6c0e2b-9d3f-4a1e-8b2c-1a2b3c4d5e6f'), '0f6c0e2b-9d3f-4a1e-8b2c-1a2b3c4d5e6f');
    assert.strictEqual(cursor.safeId('a\nb/../c'), 'a-b-..-c', 'newlines and path separators cannot survive');
    assert.strictEqual(cursor.safeId('x'.repeat(300)).length, 120, 'and an id is not a free-form blob');
    assert.strictEqual(cursor.safeId(''), 'unknown');
    const s = seededIde([
      cd('__proto__', { name: 'polluter', fullConversationHeadersOnly: [{ bubbleId: 'b1', type: 1 }] }),
      bd('__proto__', 'b1', { type: 1, text: 'a legal id, just awkward for JS' }),
      cd('has\nnewline', { name: 'cr' }),
      bd('has\nnewline', 'b1\nx', { type: 1, text: 'a bubble id with a newline in it, observed in the wild' }),
    ]);
    assert.strictEqual({}.name, undefined, 'Object.prototype was not touched');
    const out = cursor.chats(s.ctx);
    const byId = {};
    out.chats.forEach(function (c) {
      byId[c.id] = c;
    });
    assert.strictEqual(out.chats.length, 2, 'both are chats: the adapter addresses rows by their RAW id');
    assert.ok(byId['__proto__'], 'the raw id still addresses the row; only the reported key is folded');
    assert.strictEqual(byId['has-newline'].messages[0].id, 'b1-x', 'bubble ids fold the same way');
  },
);

test(
  'a store this reader cannot open is reported as skipped, never thrown and never an empty history',
  {
    skip: SQLITE_SKIP,
  },
  function () {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-cursor-bad-'));
    const user = path.join(tmp, 'User');
    const gs = path.join(user, 'globalStorage');
    fs.mkdirSync(gs, { recursive: true });
    fs.writeFileSync(path.join(gs, 'state.vscdb'), 'this is not a database at all');
    const ctx = makeCtx();
    ctx.cursorUserDir = user;
    ctx.env = {};
    const out = cursor.chats(ctx);
    assert.strictEqual(out.chats.length, 0);
    assert.strictEqual(out.skipped.length, 1, 'and the caller is told why nothing was found');
    assert.match(out.skipped[0].reason, /not a SQLite database/);
  },
);

test('a SQLite file without a cursorDiskKV table is not a Cursor store', { skip: SQLITE_SKIP }, function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-cursor-other-'));
  const file = path.join(dir, 'state.vscdb');
  cp.execFileSync('sqlite3', [file], { input: 'CREATE TABLE otherStuff(key TEXT, value TEXT);' });
  assert.throws(function () {
    cursor.parseStore(file);
  }, /no such table/);
  // …and through the normal entry point the same file is a skip with a reason, not a crash and not
  // "this machine has no Cursor history".
  const user = path.join(dir, 'User');
  fs.mkdirSync(path.join(user, 'globalStorage'), { recursive: true });
  fs.copyFileSync(file, path.join(user, 'globalStorage', 'state.vscdb'));
  const ctx = makeCtx();
  ctx.cursorUserDir = user;
  ctx.env = {};
  const out = cursor.chats(ctx);
  assert.strictEqual(out.chats.length, 0);
  assert.strictEqual(out.skipped.length, 1);
  assert.match(out.skipped[0].reason, /no such table/);
});

test('a torn value row loses that row, not the chat', { skip: SQLITE_SKIP }, function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-cursor-torn-'));
  const file = path.join(dir, 'state.vscdb');
  cp.execFileSync('sqlite3', [file], {
    input:
      'CREATE TABLE cursorDiskKV(key TEXT, value TEXT);\n' +
      'INSERT INTO cursorDiskKV VALUES(\'composerData:A\',\'{"name":"half a row"\');\n' +
      'INSERT INTO cursorDiskKV VALUES(\'bubbleId:A:b1\',\'{"type":1,"text":"still here"}\');\n' +
      "INSERT INTO cursorDiskKV VALUES('bubbleId:A:b2','{broken}');\n",
  });
  const store = cursor.parseStore(file);
  const chat = cursor.chatOf(store, 'A', {});
  assert.strictEqual(chat.messages.length, 1, 'the good bubble survives');
  assert.strictEqual(chat.messages[0].text, 'still here');
});

test(
  'a store past the read budget is skipped WITH ITS NUMBERS, and loadChat refuses it too',
  {
    skip: SQLITE_SKIP,
  },
  function () {
    const rows = [];
    for (let i = 0; i < 40; i++) {
      rows.push(cd('C' + i, { name: 'chat ' + i }));
      rows.push(bd('C' + i, 'b1', { type: 1, text: 'first turn of ' + i }));
    }
    const file = mkStore(rows);
    const user = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kf-cursor-budget-')), 'User');
    fs.mkdirSync(path.join(user, 'globalStorage'), { recursive: true });
    fs.copyFileSync(file, path.join(user, 'globalStorage', 'state.vscdb'));
    const ctx = makeCtx();
    ctx.cursorUserDir = user;
    ctx.env = {};
    const capped = Object.assign({}, ctx, { cursor: { maxScanRows: 50 } });
    const out = cursor.chats(capped);
    assert.strictEqual(out.chats.length, 0, 'a partial index is worse than none: it would delete the rest');
    assert.strictEqual(out.skipped.length, 1);
    assert.match(out.skipped[0].reason, /read budget/);
    assert.match(out.skipped[0].reason, /50 rows/, 'and the report says how far it got');
    // the row cap is the same story through the pipeline entry point
    const src = conversations.discover(capped, {}).filter(function (x) {
      return x.app === 'cursor';
    });
    assert.strictEqual(src.length, 0);
    assert.strictEqual(conversations.discover(capped, {}).storeIssues.length, 1, 'reported once, as a store skip');
    assert.match(conversations.discover(capped, {}).storeIssues[0].error, /read budget/);
  },
);

test('an unreadable -wal is a warning about the newest chats, not a skip', { skip: SQLITE_SKIP }, function () {
  const file = mkStore([cd('A', { name: 'checkpointed' }), bd('A', 'b1', { type: 1, text: 'what is on disk' })]);
  // A sidecar a real reader could not replay: a foreign/oversized log, as a crashed editor leaves.
  fs.writeFileSync(file + '-wal', Buffer.concat([Buffer.alloc(32, 0xab), Buffer.from('not a wal frame')]));
  const user = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kf-cursor-wal-')), 'User');
  fs.mkdirSync(path.join(user, 'globalStorage'), { recursive: true });
  fs.copyFileSync(file, path.join(user, 'globalStorage', 'state.vscdb'));
  fs.copyFileSync(file + '-wal', path.join(user, 'globalStorage', 'state.vscdb-wal'));
  const ctx = makeCtx();
  ctx.cursorUserDir = user;
  ctx.env = {};
  const out = cursor.chats(ctx);
  assert.strictEqual(out.chats.length, 1, 'the checkpointed history is still indexed');
  assert.strictEqual(out.skipped.length, 0);
  assert.strictEqual(out.warnings.length, 1);
  assert.match(out.warnings[0].reason, /unflushed -wal/);
  assert.match(out.warnings[0].reason, /quit Cursor/i, 'and the fix is named');
  assert.ok(out.warnings[0].file, 'with the file it applies to');
});

test(
  'a live editor store is read through its -wal, so the newest chat is not missing',
  { skip: SQLITE_SKIP },
  function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-cursor-livewal-'));
    const file = path.join(dir, 'state.vscdb');
    cp.execFileSync('sqlite3', [file], {
      input:
        'PRAGMA journal_mode=WAL;\n' +
        'CREATE TABLE cursorDiskKV(key TEXT, value TEXT);\n' +
        'INSERT INTO cursorDiskKV VALUES(\'composerData:A\',\'{"name":"live"}\');\n' +
        'INSERT INTO cursorDiskKV VALUES(\'bubbleId:A:b1\',\'{"type":1,"text":"committed"}\');\n' +
        'INSERT INTO cursorDiskKV VALUES(\'bubbleId:A:b2\',\'{"type":2,"text":"still in the wal"}\');\n' +
        'PRAGMA wal_checkpoint(TRUNCATE);\n',
    });
    const store = cursor.parseStore(file);
    const chat = cursor.chatOf(store, 'A', {});
    assert.strictEqual(chat.messages.length, 2, 'both rows are readable whichever file they live in');
    assert.strictEqual(chat.messages[1].text, 'still in the wal');
  },
);

test('the editor and agent roots honour Cursor’s own environment overrides', function () {
  const ctx = {
    home: '/home/me',
    env: { CURSOR_DESKTOP_USER_DIR: '/elsewhere/User', CURSOR_DATA_DIR: '/elsewhere/.cursor' },
  };
  assert.strictEqual(cursor.ideUserDirs(ctx)[0], '/elsewhere/User', 'the override is the User directory itself');
  assert.ok(cursor.ideUserDirs(ctx).length > 1, 'and the platform defaults stay behind it as fallbacks');
  assert.strictEqual(cursor.agentRoots(ctx)[0], '/elsewhere/.cursor');
  assert.deepStrictEqual(
    cursor.agentRoots({ home: '/home/me', env: { XDG_CONFIG_HOME: '/xdg' } }).slice(0, 1),
    [path.join('/xdg', 'cursor')],
    'XDG first, then the home default',
  );
  assert.ok(cursor.agentRoots({ home: '/home/me', env: {} }).includes(path.join('/home/me', '.cursor')));
  // A root that does not exist is not an error: the store list is existence-gated.
  assert.deepStrictEqual(cursor.storePaths({ home: '/no/such/home', env: {} }), []);
  assert.deepStrictEqual(cursor.agentStorePaths({ home: '/no/such/home', env: {} }), []);
});

test('the store cache returns the same parse for an unchanged file', { skip: SQLITE_SKIP }, function () {
  const file = mkStore([cd('A', { name: 'once' }), bd('A', 'b1', { type: 1, text: 'hello' })]);
  const first = cursor.parseStore(file);
  const second = cursor.parseStore(file);
  assert.strictEqual(first, second, 'a 100 MB store is scanned once, not once per chat');
  fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.notStrictEqual(cursor.parseStore(file), second, 'a new mtime means re-read it');
});

// ---- the cursor-agent CLI store ----------------------------------------------------------------

const NOISE = Buffer.alloc(32, 0xff);

// A content-addressed blob: protobuf framing (field 1 = a 32-byte id of its own, field 2 = the
// parent id) with the message JSON after it, exactly the shape txcript reads.
function blobRow(parentId, doc) {
  const json = Buffer.from(JSON.stringify(doc), 'utf8');
  const parts = [Buffer.from([0x0a, 0x20]), NOISE];
  if (parentId) parts.push(Buffer.from([0x12, 0x20]), Buffer.from(parentId, 'hex'));
  parts.push(json);
  const data = Buffer.concat(parts);
  return { id: crypto.createHash('sha256').update(data).digest('hex'), data: data };
}

function mkAgentSession(root, sessionId, blobs, metaRecord, metaJson) {
  const bucket = path.join(root, 'chats', crypto.createHash('md5').update('/work/app').digest('hex'));
  const dir = path.join(bucket, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'store.db');
  const sql = ['CREATE TABLE blobs(id TEXT, data BLOB);', 'CREATE TABLE meta(key TEXT, value TEXT);'];
  blobs.forEach(function (b) {
    sql.push("INSERT INTO blobs VALUES('" + b.id + "', x'" + b.data.toString('hex').toUpperCase() + "');");
  });
  if (metaRecord)
    sql.push(
      "INSERT INTO meta VALUES('0', '" + esc(Buffer.from(JSON.stringify(metaRecord), 'utf8').toString('hex')) + "');",
    );
  cp.execFileSync('sqlite3', [file], { input: sql.join('\n') + '\n' });
  if (metaJson) fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(metaJson));
  return file;
}

const SESSION = '2b1f6a0e-7f79-4b0e-9a4f-6d5d0d3a1e22';

function seededAgent(opts) {
  opts = opts || {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-cursor-agent-'));
  const root = path.join(tmp, '.cursor');
  fs.mkdirSync(root, { recursive: true });
  const user = blobRow(null, {
    role: 'user',
    content: [{ type: 'text', text: '<user_query>fix the flaky test</user_query>' }],
    createdAt: 1767225600000,
  });
  const asst = blobRow(user.id, {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'the retry is the culprit[REDACTED]' },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'Shell', args: { cmd: 'npm test' } },
    ],
    createdAt: 1767225610000,
    providerOptions: { cursor: { modelName: 'composer-2.5' } },
  });
  const graph = blobRow(asst.id, null); // internal turn graph: no JSON, no message
  const injected = blobRow(null, {
    role: 'user',
    content: '<user_info>Platform: darwin</user_info>',
    createdAt: 1767225590000,
  });
  const last = blobRow(asst.id, {
    role: 'assistant',
    content: [{ type: 'text', text: 'it was the retry count' }],
    createdAt: 1767225620000,
  });
  const all = opts.blobs || [user, asst, graph, injected, last];
  const file = mkAgentSession(
    root,
    SESSION,
    all,
    opts.meta === null
      ? null
      : Object.assign(
          {
            agentId: 'ag1',
            name: 'Flaky test work',
            workspacePath: '/work/app',
            createdAt: 1767225500000,
            lastUsedModel: 'composer-2.5',
          },
          opts.meta || {},
        ),
    opts.metaJson === null
      ? null
      : Object.assign(
          {
            schemaVersion: 1,
            title: 'Fix the flaky test',
            createdAtMs: 1767225550000,
            updatedAtMs: 1767225620000,
            hasConversation: true,
          },
          opts.metaJson || {},
        ),
  );
  const ctx = makeCtx();
  ctx.cursorHome = root;
  ctx.env = {};
  return {
    ctx: ctx,
    root: root,
    file: file,
    ids: { user: user.id, asst: asst.id, last: last.id, graph: graph.id, injected: injected.id },
    blobs: all,
  };
}

function agentBy(ctx) {
  return cursor.agentChats(ctx).chats[0];
}

test(
  'a CLI session is read as one conversation, on its own clocks',
  {
    skip: SQLITE_SKIP,
  },
  function () {
    // The fixture inserts in the order the CLI would have written the rows, and the blobs carry the
    // per-message `createdAt` the client wrote; the session is ordered on those, not on the rowids.
    const s = seededAgent();
    const out = cursor.agentChats(s.ctx);
    assert.strictEqual(out.stores, 1);
    assert.strictEqual(out.chats.length, 1);
    const chat = agentBy(s.ctx);
    assert.strictEqual(chat.composerId, SESSION, 'the session directory name is the id the CLI resumes with');
    assert.strictEqual(chat.title, 'Fix the flaky test', 'meta.json is the title source');
    assert.strictEqual(chat.cwd, '/work/app', 'and the meta record’s workspacePath is the cwd');
    assert.deepStrictEqual(
      texts(chat),
      ['fix the flaky test', 'the retry is the culprit', 'it was the retry count'],
      '<user_query> unwrapped, [REDACTED] dropped, editor-injected context dropped, graph blob carries no text',
    );
    assert.strictEqual(chat.messages[1].tools.join(','), 'Shell', 'a tool-call block names the tool');
    assert.strictEqual(chat.messages[1].machine, undefined, 'reasoning is the agent’s scratchpad, not tool output');
    assert.strictEqual(
      chat.createdAt,
      '2025-12-31T23:58:20.000Z',
      'the meta record predates the first prompt: a session exists before its first message',
    );
    assert.strictEqual(chat.updatedAt, '2026-01-01T00:00:20.000Z');
    assert.strictEqual(chat.unlisted, 0, 'every message blob was reachable; the graph blob is not a lost turn');
  },
);

test(
  'a blob no graph edge reaches is still a message — a second root must not be lost',
  {
    skip: SQLITE_SKIP,
  },
  function () {
    // A resumed CLI session starts a second root, and the shipped readers that traverse the reference
    // graph from one root never reach it. keyflip reads every JSON blob, so the branch survives, on its
    // own clock — between the answer it follows and the one it precedes.
    const base = seededAgent();
    const s = seededAgent({
      blobs: base.blobs.concat([
        blobRow(null, {
          role: 'assistant',
          content: [{ type: 'text', text: 'a branch Cursor replaced' }],
          createdAt: 1767225615000,
        }),
      ]),
    });
    const chat = agentBy(s.ctx);
    assert.deepStrictEqual(texts(chat), [
      'fix the flaky test',
      'the retry is the culprit',
      'a branch Cursor replaced',
      'it was the retry count',
    ]);
    assert.strictEqual(chat.unlisted, 0, 'the graph-less blob is not reported as a lost turn');
  },
);

test(
  'a session with no reference graph keeps rowid order, like txcript’s fallback',
  {
    skip: SQLITE_SKIP,
  },
  function () {
    const a = blobRow(null, { role: 'user', content: 'asked first', createdAt: 1767225600000 });
    const b = blobRow(null, { role: 'assistant', content: 'answered second', createdAt: 1767225610000 });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-cursor-agent2-'));
    const root = path.join(tmp, '.cursor');
    mkAgentSession(root, 'sess-nograph', [a, b], { workspacePath: '/work/app' }, null);
    const ctx = makeCtx();
    ctx.cursorHome = root;
    ctx.env = {};
    const chat = cursor.agentChats(ctx).chats[0];
    assert.deepStrictEqual(texts(chat), ['asked first', 'answered second']);
    assert.strictEqual(chat.title, null, 'no meta.json: the agent name is the title');
    assert.strictEqual(chat.messages[0].role, 'user');
  },
);

test(
  'a tool-result blob is the machine’s turn, and a plain-string content is read',
  {
    skip: SQLITE_SKIP,
  },
  function () {
    const s = seededAgent({
      blobs: [
        blobRow(null, { role: 'user', content: 'run it', createdAt: 1767225600000 }),
        blobRow(null, {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: 'c1', toolName: 'Shell', result: '2 tests failed', isError: true },
          ],
          createdAt: 1767225610000,
        }),
      ],
    });
    const chat = agentBy(s.ctx);
    assert.deepStrictEqual(
      chat.messages.map(function (m) {
        return m.role + ':' + m.text;
      }),
      ['user:run it', 'assistant:2 tests failed'],
      'a tool result is reported as machine output, not as something the user said',
    );
    // The payload is flagged so the conversation index can cap it: Cursor has no other place to
    // keep a tool's output, and an unflagged 40 KB dump would be indexed verbatim.
    assert.strictEqual(chat.messages[1].machine, true);
    assert.strictEqual(chat.messages[0].machine, undefined, 'a user turn is never machine output');
  },
);

test('a broken or empty CLI store is a skip with a reason, never a crash', { skip: SQLITE_SKIP }, function () {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-cursor-agent-bad-'));
  const root = path.join(tmp, '.cursor');
  const dir = path.join(root, 'chats', 'deadbeef', 'sess-bad');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.db'), 'not a database');
  fs.mkdirSync(path.join(root, 'chats', 'deadbeef', 'sess-empty'), { recursive: true });
  fs.writeFileSync(path.join(root, 'chats', 'deadbeef', 'sess-empty', 'store.db'), '');
  const ctx = makeCtx();
  ctx.cursorHome = root;
  ctx.env = {};
  const out = cursor.agentChats(ctx);
  assert.strictEqual(out.chats.length, 0);
  assert.strictEqual(out.skipped.length, 1, 'a zero-length file is not even opened, so it is not a "failure"');
  assert.match(out.skipped[0].reason, /not a SQLite database/);
});

// ---- the transcript mirror ---------------------------------------------------------------------

test('the JSONL mirror fills only the sessions the stores do not have', { skip: SQLITE_SKIP }, function () {
  const s = seededAgent();
  const mirrorDir = path.join(s.root, 'projects', '-work-app', 'agent-transcripts', SESSION);
  fs.mkdirSync(mirrorDir, { recursive: true });
  fs.writeFileSync(
    path.join(mirrorDir, SESSION + '.jsonl'),
    [
      JSON.stringify({ role: 'user', message: { content: 'asked' } }),
      JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'text', text: 'answered' }, { type: 'image' }] },
      }),
      JSON.stringify({ role: 'system', message: { content: 'not a turn' } }),
      '{ torn line',
    ].join('\n') + '\n',
  );
  // a subagent transcript one level deeper is not a separate user chat
  fs.mkdirSync(path.join(mirrorDir, 'sub'), { recursive: true });
  fs.writeFileSync(
    path.join(mirrorDir, 'sub', 'sub.jsonl'),
    JSON.stringify({ role: 'user', message: { content: 'nested' } }),
  );
  const found = cursor.transcriptPaths(s.ctx, new Set());
  assert.deepStrictEqual(
    found.map(function (t) {
      return t.sessionId;
    }),
    [SESSION],
    'only the top-level <uuid>/<uuid>.jsonl is a session',
  );
  assert.strictEqual(
    cursor.transcriptPaths(s.ctx, new Set([SESSION])).length,
    0,
    'and a known id is not offered twice',
  );

  const chat = cursor.transcriptChat(found[0] && Object.assign({ path: found[0].file, composerId: SESSION }, found[0]));
  assert.deepStrictEqual(texts(chat), ['asked', 'answered'], 'a non-turn role and a torn line are not messages');
  assert.strictEqual(chat.messages[0].ts, null, 'transcripts carry no per-line clock');
  assert.ok(chat.updatedAt, 'and the file mtime stands in for it, never the moment of the scan');

  const rows = cursor.discover(s.ctx);
  const asRows = rows.filter(function (r) {
    return r.kind === 'cursor-transcript';
  });
  assert.strictEqual(asRows.length, 0, 'the agent store already has this session id, so the mirror is skipped');
});

// ---- the pipeline ------------------------------------------------------------------------------

test(
  'conversations.discover gives one row per composer, agent session or mirror, with its kind',
  {
    skip: SQLITE_SKIP,
  },
  function () {
    const ide = seededIde([
      cd('A', { name: 'editor chat', projectPath: '/work/app' }),
      bd('A', 'b1', { type: 1, text: 'the parser breaks on unicode' }),
    ]);
    const agent = seededAgent();
    // a second root, so one ctx sees both products
    ide.ctx.cursorHome = agent.root;
    const rows = conversations.discover(ide.ctx, {});
    const cur = rows.filter(function (r) {
      return r.app === 'cursor';
    });
    assert.deepStrictEqual(
      cur
        .map(function (r) {
          return r.kind + ':' + r.surface;
        })
        .sort(),
      ['cursor-agent:cli', 'cursor-composer:local'],
      'the editor composer and the CLI session are separate sources',
    );
    const convs = cur.map(function (r) {
      return conversations.load(ide.ctx, r, {});
    });
    const byId = {};
    convs.forEach(function (c) {
      byId[c.id] = c;
    });
    assert.ok(byId['cursor:local:A'], 'the composer id is the identity, so a rebuild reuses its vectors');
    assert.ok(byId['cursor:cli:' + SESSION], 'and so is the session id');
    assert.strictEqual(byId['cursor:local:A'].app, 'cursor');
    assert.strictEqual(byId['cursor:local:A'].counts.messages, 1);
    assert.strictEqual(byId['cursor:cli:' + SESSION].cwd, '/work/app');
    assert.ok(
      !convs.some(function (c) {
        return /^foreign:cursor:/.test(c.id);
      }),
      'the old file-as-one-chat foreign row is gone, so no chat is indexed twice',
    );
  },
);

test('a titleless composer is still findable by its first prompt', { skip: SQLITE_SKIP }, function () {
  const s = seededIde([
    cd('A', {}),
    bd('A', 'b1', { type: 1, text: 'why does the build fail on Linux only?' }),
    bd('A', 'b2', { type: 2, text: 'path separators' }),
  ]);
  const srcs = conversations.discover(s.ctx, {}).filter(function (x) {
    return x.app === 'cursor';
  });
  const conv = conversations.load(s.ctx, srcs[0], {});
  assert.match(conv.title, /build fail on Linux/, 'titleless composers are still findable');
  assert.strictEqual(conv.surface, 'local');
});

test(
  'foreign single-file parsing still works on a Cursor store, for `keyflip foreign <path>`',
  {
    skip: SQLITE_SKIP,
  },
  function () {
    const file = mkStore([cd('A', { name: 'hand-picked' }), bd('A', 'b1', { type: 1, text: 'hello' })]);
    const norm = foreign.normalize(file, fs.readFileSync(file));
    assert.strictEqual(norm.tool, 'cursor');
    assert.strictEqual(norm.messages.length, 1);
  },
);
