'use strict';
// Tests for `keyflip sessions rebind` (src/sessions.js): re-link a project's chat
// history after its folder was renamed/moved. Claude keys transcripts by the encoded
// cwd and refuses a session whose cwd is gone, so a rename orphans the history.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sessions = require('../src/sessions');
const { makeCtx } = require('./helpers');

function seedTranscript(ctx, cwd, id, content) {
  const dir = path.join(sessions.projectsDir(ctx), sessions.encodeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.jsonl'), content);
  return dir;
}

test('encodeCwd replaces both "/" and "." with "-" (matches Claude Code)', function () {
  assert.strictEqual(sessions.encodeCwd('/Users/x/Documents/Plansmith'), '-Users-x-Documents-Plansmith');
  assert.strictEqual(sessions.encodeCwd('/Users/x/proj/.claude-worktrees/wt'), '-Users-x-proj--claude-worktrees-wt');
});

test('rebind copies transcripts to the new folder key and rewrites the old cwd inside', function () {
  const ctx = makeCtx();
  const OLD = '/Users/x/Documents/OpenTraycer', NEW = '/Users/x/Documents/Plansmith';
  seedTranscript(ctx, OLD, 'sess-1', '{"cwd":"' + OLD + '","type":"user"}\n{"cwd":"' + OLD + '/apps"}\n');

  const r = sessions.rebind(ctx, OLD, NEW, {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.moved, 1);
  const dest = path.join(sessions.projectsDir(ctx), sessions.encodeCwd(NEW), 'sess-1.jsonl');
  const out = fs.readFileSync(dest, 'utf8');
  assert.ok(out.indexOf(NEW) !== -1, 'new cwd is written');
  assert.strictEqual(out.indexOf(OLD), -1, 'no stale old cwd remains');
  assert.ok(out.indexOf(NEW + '/apps') !== -1, 'nested path refs are rewritten too');
  assert.ok(fs.existsSync(r.backup), 'the old dir is backed up first');
});

test('rebind refuses when the old project has no history / same path', function () {
  const ctx = makeCtx();
  assert.strictEqual(sessions.rebind(ctx, '/no/such/old', '/some/new', {}).reason, 'no-old-project');
  seedTranscript(ctx, '/a/b', 'x', 'y\n');
  assert.strictEqual(sessions.rebind(ctx, '/a/b', '/a/b', {}).reason, 'same-path');
});

test('rebind --purge-old disables the old copies (reversible .disabled)', function () {
  const ctx = makeCtx();
  const OLD = '/Users/x/Old', NEW = '/Users/x/New';
  const oldDir = seedTranscript(ctx, OLD, 's', '{"cwd":"' + OLD + '"}\n');
  sessions.rebind(ctx, OLD, NEW, { purgeOld: true });
  assert.strictEqual(fs.existsSync(path.join(oldDir, 's.jsonl')), false);
  assert.ok(fs.existsSync(path.join(oldDir, 's.jsonl.disabled')), 'old copy disabled, not deleted');
});

test('rebind does not overwrite an existing dest unless --force', function () {
  const ctx = makeCtx();
  const OLD = '/Users/x/O', NEW = '/Users/x/N';
  seedTranscript(ctx, OLD, 's', 'OLDBODY ' + OLD + '\n');
  seedTranscript(ctx, NEW, 's', 'EXISTING\n'); // a session already at the new key
  const r1 = sessions.rebind(ctx, OLD, NEW, {});
  assert.strictEqual(r1.moved, 0);
  assert.strictEqual(r1.skipped, 1);
  assert.strictEqual(fs.readFileSync(path.join(sessions.projectsDir(ctx), sessions.encodeCwd(NEW), 's.jsonl'), 'utf8'), 'EXISTING\n');
  const r2 = sessions.rebind(ctx, OLD, NEW, { force: true });
  assert.strictEqual(r2.moved, 1);
});

// ---- D1: content search + snippet ----

test('findMatch returns a context snippet on a content hit, null on a miss', function () {
  const ctx = makeCtx();
  const dir = path.join(sessions.projectsDir(ctx), '-p'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, '{"type":"user","text":"please fix the OAuth refresh bug today"}\n');
  const snip = sessions.findMatch(file, 'oauth refresh');
  assert.ok(snip && snip.toLowerCase().indexOf('oauth refresh') !== -1);
  assert.strictEqual(sessions.findMatch(file, 'nonexistent-term-xyz'), null);
});

test('list --search matches transcript CONTENT and attaches a match snippet', function () {
  const ctx = makeCtx();
  const dir = path.join(sessions.projectsDir(ctx), '-Users-x-proj'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'aaaa1111.jsonl'), '{"cwd":"/Users/x/proj","text":"discussing the widget pipeline design"}\n');
  fs.writeFileSync(path.join(dir, 'bbbb2222.jsonl'), '{"cwd":"/Users/x/proj","text":"unrelated chatter"}\n');
  const rows = sessions.list(ctx, { search: 'widget pipeline', limit: 40 });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].sessionId, 'aaaa1111');
  assert.ok(rows[0].match && rows[0].match.toLowerCase().indexOf('widget pipeline') !== -1);
});

// ---- A3: orphan detection ----

test('list flags a session whose cwd no longer exists (orphan)', function () {
  const ctx = makeCtx();
  const dir = path.join(sessions.projectsDir(ctx), '-gone'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cccc3333.jsonl'), '{"cwd":"/no/such/dir/anymore","text":"hi"}\n');
  const live = path.join(dir, 'dddd4444.jsonl');
  fs.writeFileSync(live, '{"cwd":"' + ctx.home + '","text":"hi"}\n'); // ctx.home exists
  const rows = sessions.list(ctx, { limit: 40 });
  const orphan = rows.filter(function (r) { return r.sessionId === 'cccc3333'; })[0];
  const ok = rows.filter(function (r) { return r.sessionId === 'dddd4444'; })[0];
  assert.strictEqual(orphan.orphan, true, 'missing cwd -> orphan');
  assert.strictEqual(ok.orphan, false, 'existing cwd -> not orphan');
});

// ---- E4: send (inject a message into a session) ----

test('sendCommand builds `claude -p <message> --resume <id>` (+ --fork-session)', function () {
  const s = require('../src/sessions');
  const row = { sessionId: 'abc12345', cwd: '/proj' };
  const sc = s.sendCommand(row, 'please add a test');
  assert.strictEqual(sc.command, 'claude');
  assert.deepStrictEqual(sc.args, ['-p', 'please add a test', '--resume', 'abc12345']);
  assert.strictEqual(sc.cwd, '/proj');
  assert.ok(s.sendCommand(row, 'x', { fork: true }).args.indexOf('--fork-session') !== -1);
});

// ---- B3: compact (elide bulky tool output, keep the conversation) ----

test('compactTranscript elides long tool output but keeps message text + valid JSONL', function () {
  const bigOutput = 'X'.repeat(5000);
  const longMessage = 'a genuinely long assistant message '.repeat(100); // > threshold but NOT tool output
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'do the thing' } }),
    JSON.stringify({ type: 'tool_result', tool_use_id: 't1', content: bigOutput }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: longMessage } }),
  ].join('\n');
  const r = require('../src/sessions').compactTranscript(lines, {});
  assert.ok(r.elided >= 1, 'at least the tool output is elided');
  assert.ok(r.after < r.before, 'smaller after');
  const out = r.compacted.split('\n');
  // tool output truncated
  assert.ok(JSON.parse(out[1]).content.indexOf('elided by keyflip compact') !== -1);
  // conversation preserved: user + assistant message text intact
  assert.strictEqual(JSON.parse(out[0]).message.content, 'do the thing');
  assert.strictEqual(JSON.parse(out[2]).message.content, longMessage, 'message text is NOT truncated');
});

test('compactTranscript is a no-op with nothing bulky, and keeps unparseable lines', function () {
  const s = require('../src/sessions');
  const clean = JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\nnot-json-line\n';
  const r = s.compactTranscript(clean, {});
  assert.strictEqual(r.elided, 0);
  assert.strictEqual(r.compacted, clean, 'unchanged, unparseable line preserved');
});

test('rebindAppRegistry rewrites cwd/originCwd and clears transcriptUnavailable', function () {
  const ctx = makeCtx();
  ctx.appDataDir = path.join(ctx.home, 'appdata');
  const OLD = '/Users/x/Old', NEW = '/Users/x/New';
  const dir = path.join(ctx.appDataDir, 'claude-code-sessions', 'acct', 'org');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'local_1.json'), JSON.stringify({ cwd: OLD, originCwd: OLD + '/sub', transcriptUnavailable: true, cliSessionId: 'abc' }));
  fs.writeFileSync(path.join(dir, 'local_2.json'), JSON.stringify({ cwd: '/unrelated' })); // untouched

  const reg = sessions.rebindAppRegistry(ctx, OLD, NEW);
  assert.strictEqual(reg.patched, 1);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'local_1.json'), 'utf8'));
  assert.strictEqual(rec.cwd, NEW);
  assert.strictEqual(rec.originCwd, NEW + '/sub');
  assert.strictEqual('transcriptUnavailable' in rec, false, 'unavailable flag cleared');
  assert.strictEqual(rec.cliSessionId, 'abc', 'the transcript link is preserved');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'local_2.json'), 'utf8')).cwd, '/unrelated');
});
