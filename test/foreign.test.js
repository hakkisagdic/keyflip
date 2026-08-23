// Epic F: normalize other agents' session logs into keyflip's unified shape (src/foreign.js).
import test from 'node:test';
import assert from 'node:assert';
import * as foreign from '../src/foreign.js';

const AIDER = [
  '# aider chat started at 2026-07-07 09:00:00',
  '',
  '> Aider v0.50',
  '> Added foo.py to the chat',
  '',
  '#### add a hello function to foo.py',
  '',
  'Sure — here is a hello():',
  '',
  '```python',
  'def hello(): return "hi"',
  '```',
  '',
  '> Applied edit to foo.py',
  '> Commit abc123 add hello',
  '',
  '#### now add a test',
  '',
  'Added a test in test_foo.py.',
].join('\n');

const JSONL = [
  '{"type":"user","cwd":"/p","message":{"role":"user","content":"explain closures"}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"A closure captures its scope."}]}}',
].join('\n');

test('detect: recognizes aider md, jsonl by extension and by content sniff', function () {
  assert.strictEqual(foreign.detect('.aider.chat.history.md', ''), 'aider');
  assert.strictEqual(foreign.detect('x.md', '# aider chat started at ...'), 'aider');
  assert.strictEqual(foreign.detect('gemini.jsonl', ''), 'jsonl');
  assert.strictEqual(foreign.detect('nohint', '{"type":"user","message":{"role":"user","content":"hi"}}'), 'jsonl');
  assert.strictEqual(foreign.detect('random.txt', 'just prose'), null);
});

test('parseAider: #### = user turns, > = summarized tool lines, other text = assistant', function () {
  const p = foreign.parseAider(AIDER);
  assert.strictEqual(p.counts.messages, 4);
  assert.strictEqual(p.counts.user, 2);
  assert.strictEqual(p.counts.assistant, 2);
  assert.strictEqual(p.messages[0].role, 'user');
  assert.strictEqual(p.messages[0].text, 'add a hello function to foo.py');
  assert.ok(p.messages[1].text.indexOf('def hello()') !== -1, 'code block preserved in the assistant turn');
  assert.deepStrictEqual(p.messages[1].tools, ['edit', 'commit'], 'aider status lines summarized as clean tool labels');
  assert.strictEqual(p.messages[1].text.indexOf('Applied edit'), -1, 'raw > status lines are NOT dumped into the text');
});

test('normalize: jsonl routes through the tested transcript parser', function () {
  const n = foreign.normalize('gemini.jsonl', JSONL);
  assert.strictEqual(n.tool, 'jsonl');
  assert.strictEqual(n.counts.messages, 2);
  assert.strictEqual(n.cwd, '/p');
  assert.strictEqual(n.messages[1].text, 'A closure captures its scope.');
});

test('normalize: aider file yields the unified shape tagged aider', function () {
  const n = foreign.normalize('.aider.chat.history.md', AIDER);
  assert.strictEqual(n.tool, 'aider');
  assert.ok(n.counts.messages === 4 && Array.isArray(n.messages));
});

test('normalize: an unrecognized format throws a clear error', function () {
  assert.throws(function () { foreign.normalize('notes.txt', 'just prose, not a session'); }, /unrecognized session format/);
});

test('the normalized shape feeds straight into the transcript exporter', function () {
  const transcript = _transcript;
  const n = foreign.normalize('.aider.chat.history.md', AIDER);
  const md = transcript.toMarkdown(n, { id: n.tool });
  assert.ok(md.indexOf('### You') !== -1 && md.indexOf('### Claude') !== -1);
  const html = transcript.toHtml(n, { id: n.tool });
  assert.ok(/^<!doctype html>/i.test(html) && html.indexOf('class="msg u"') !== -1);
});

// --- Cursor SQLite + generic JSON (epic F extensions) ---
import cp from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as _transcript from '../src/transcript.js';
let HAS_SQLITE = false;
try { cp.execFileSync('sqlite3', ['--version'], { stdio: 'ignore' }); HAS_SQLITE = true; } catch (e) { HAS_SQLITE = false; }
function mkdb(sql) { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kf-fdb-')), 'x.db'); cp.execFileSync('sqlite3', [f], { input: sql }); return fs.readFileSync(f); }
function j(o) { return JSON.stringify(o).replace(/'/g, "''"); }

test('detect: a SQLite file is recognized as cursor from its magic header', function (t) {
  if (!HAS_SQLITE) return t.skip('sqlite3 CLI not installed');
  const buf = mkdb('CREATE TABLE cursorDiskKV(key TEXT, value TEXT);\n');
  assert.strictEqual(foreign.detect('state.vscdb', buf), 'cursor');
});

test('parseCursor: bubbles ordered by the composer header list; roles from type', function (t) {
  if (!HAS_SQLITE) return t.skip('sqlite3 CLI not installed');
  const sql = 'CREATE TABLE cursorDiskKV(key TEXT, value TEXT);\n' +
    "INSERT INTO cursorDiskKV VALUES('composerData:C1','" + j({ fullConversationHeadersOnly: [{ bubbleId: 'b1' }, { bubbleId: 'b2' }, { bubbleId: 'b3' }] }) + "');\n" +
    "INSERT INTO cursorDiskKV VALUES('bubbleId:C1:b2','" + j({ type: 2, text: 'the fix' }) + "');\n" +
    "INSERT INTO cursorDiskKV VALUES('bubbleId:C1:b1','" + j({ type: 1, text: 'my bug' }) + "');\n" +
    "INSERT INTO cursorDiskKV VALUES('bubbleId:C1:b3','" + j({ type: 1, text: 'thanks' }) + "');\n";
  const n = foreign.normalize('state.vscdb', mkdb(sql));
  assert.strictEqual(n.tool, 'cursor');
  assert.deepStrictEqual(n.messages.map(function (m) { return m.role + ':' + m.text; }), ['user:my bug', 'assistant:the fix', 'user:thanks'], 'order + roles honored');
});

test('parseJson: finds the largest array of message-like objects (opencode/generic)', function () {
  const doc = JSON.stringify({ session: 'ses_x', meta: { model: 'x' }, parts: [
    { role: 'user', text: 'hello' },
    { role: 'assistant', content: [{ type: 'text', text: 'hi back' }] },
    { role: 'user', text: '' },
  ] });
  const n = foreign.normalize('storage.json', doc);
  assert.strictEqual(n.tool, 'json');
  assert.strictEqual(n.counts.messages, 2, 'empty-text message dropped');
  assert.strictEqual(n.messages[0].text, 'hello');
  assert.strictEqual(n.messages[1].text, 'hi back');
});

test('discover: finds foreign sessions at the known locations, existence-gated', function () {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-disc-'));
  // empty machine -> nothing
  assert.deepStrictEqual(foreign.discover({ home: home }), []);
  // seed the known locations
  const cur = path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage');
  const oc = path.join(home, '.local', 'share', 'opencode', 'project', 'p', 'storage');
  const gm = path.join(home, '.gemini', 'antigravity-cli', 'brain', 'U1');
  [cur, oc, gm].forEach(function (d) { fs.mkdirSync(d, { recursive: true }); });
  fs.writeFileSync(path.join(cur, 'state.vscdb'), 'SQLite format 3\0');
  fs.writeFileSync(path.join(oc, 'ses_1.json'), '{}');
  fs.writeFileSync(path.join(gm, 'transcript.jsonl'), '{}');
  const found = foreign.discover({ home: home });
  const tools = found.map(function (f) { return f.tool; }).sort();
  assert.deepStrictEqual(tools, ['cursor', 'gemini', 'opencode']);
  assert.ok(found.every(function (f) { return f.path && f.mtime; }));
});

test('parseYaml (Copilot/generic): extracts the conversation array from YAML', function () {
  const y = ['session: abc', 'model: gpt-4o', 'history:',
    '  - role: user', '    text: reverse a list?',
    '  - role: assistant', '    text: "use [::-1]"',
    '  - role: user', '    text: thanks'].join('\n');
  const n = foreign.normalize('workspace.yaml', y);
  assert.strictEqual(n.tool, 'copilot');
  assert.strictEqual(n.counts.messages, 3);
  assert.deepStrictEqual(n.messages.map(function (m) { return m.role; }), ['user', 'assistant', 'user']);
  assert.strictEqual(n.messages[1].text, 'use [::-1]');
});

test('detect: .yaml / workspace.yaml -> yaml (copilot)', function () {
  assert.strictEqual(foreign.detect('workspace.yaml', 'session: x\n'), 'yaml');
  assert.strictEqual(foreign.detect('x.yml', 'a: 1\n'), 'yaml');
});

test('resumeCommand: documented per-tool resume commands (best-effort)', function () {
  assert.strictEqual(foreign.resumeCommand('cursor', 'C1'), 'cursor agent --resume C1');
  assert.strictEqual(foreign.resumeCommand('copilot', 'abc'), 'copilot --resume=abc');
  assert.strictEqual(foreign.resumeCommand('opencode', 'ses_1'), 'opencode --session ses_1');
  assert.strictEqual(foreign.resumeCommand('jsonl', 'x'), 'claude --resume x');
  assert.strictEqual(foreign.resumeCommand('aider', 'x'), null, 'aider has no resume id');
  assert.strictEqual(foreign.resumeCommand('cursor', null), null, 'no id -> null');
});

// Post-audit reliability: a WAL-mode Cursor DB keeps recent writes in a sibling -wal file this
// zero-dep reader can't replay — normalize() must WARN rather than silently drop the newest chats.
test('foreign: a non-empty -wal sibling triggers a stale-data warning', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-wal-'));
  const db = path.join(dir, 'state.vscdb');
  cp.execFileSync('sqlite3', [db], { input: "CREATE TABLE cursorDiskKV(key TEXT, value BLOB); INSERT INTO cursorDiskKV VALUES('composerData:x', '" + j({ conversation: [{ type: 1, text: 'hi' }] }) + "');" });
  const buf = fs.readFileSync(db);
  assert.strictEqual(foreign.normalize(db, buf).warning, undefined, 'no warning when fully checkpointed');
  fs.writeFileSync(db + '-wal', Buffer.alloc(5000, 1)); // simulate an unflushed WAL
  const w = foreign.normalize(db, buf).warning;
  assert.ok(w && /wal/i.test(w), 'warns about the unflushed WAL');
  assert.ok(/quit cursor/i.test(w), 'tells the user how to checkpoint it');
});
