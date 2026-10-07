// Tests for `keyflip sessions rebind` (src/sessions.js): re-link a project's chat
// history after its folder was renamed/moved. Claude keys transcripts by the encoded
// cwd and refuses a session whose cwd is gone, so a rename orphans the history.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as sessions from '../src/sessions.js';
import { makeCtx } from './helpers.js';

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
  const OLD = '/Users/x/Documents/OpenTraycer',
    NEW = '/Users/x/Documents/Plansmith';
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
  const OLD = '/Users/x/Old',
    NEW = '/Users/x/New';
  const oldDir = seedTranscript(ctx, OLD, 's', '{"cwd":"' + OLD + '"}\n');
  sessions.rebind(ctx, OLD, NEW, { purgeOld: true });
  assert.strictEqual(fs.existsSync(path.join(oldDir, 's.jsonl')), false);
  assert.ok(fs.existsSync(path.join(oldDir, 's.jsonl.disabled')), 'old copy disabled, not deleted');
});

test('rebind does not overwrite an existing dest unless --force', function () {
  const ctx = makeCtx();
  const OLD = '/Users/x/O',
    NEW = '/Users/x/N';
  seedTranscript(ctx, OLD, 's', 'OLDBODY ' + OLD + '\n');
  seedTranscript(ctx, NEW, 's', 'EXISTING\n'); // a session already at the new key
  const r1 = sessions.rebind(ctx, OLD, NEW, {});
  assert.strictEqual(r1.moved, 0);
  assert.strictEqual(r1.skipped, 1);
  assert.strictEqual(
    fs.readFileSync(path.join(sessions.projectsDir(ctx), sessions.encodeCwd(NEW), 's.jsonl'), 'utf8'),
    'EXISTING\n',
  );
  const r2 = sessions.rebind(ctx, OLD, NEW, { force: true });
  assert.strictEqual(r2.moved, 1);
});

// ---- D1: content search + snippet ----

test('findMatch returns a context snippet on a content hit, null on a miss', function () {
  const ctx = makeCtx();
  const dir = path.join(sessions.projectsDir(ctx), '-p');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, '{"type":"user","text":"please fix the OAuth refresh bug today"}\n');
  const snip = sessions.findMatch(file, 'oauth refresh');
  assert.ok(snip && snip.toLowerCase().indexOf('oauth refresh') !== -1);
  assert.strictEqual(sessions.findMatch(file, 'nonexistent-term-xyz'), null);
});

test('list --search matches transcript CONTENT and attaches a match snippet', function () {
  const ctx = makeCtx();
  const dir = path.join(sessions.projectsDir(ctx), '-Users-x-proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'aaaa1111.jsonl'),
    '{"cwd":"/Users/x/proj","text":"discussing the widget pipeline design"}\n',
  );
  fs.writeFileSync(path.join(dir, 'bbbb2222.jsonl'), '{"cwd":"/Users/x/proj","text":"unrelated chatter"}\n');
  const rows = sessions.list(ctx, { search: 'widget pipeline', limit: 40 });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].sessionId, 'aaaa1111');
  assert.ok(rows[0].match && rows[0].match.toLowerCase().indexOf('widget pipeline') !== -1);
});

// ---- A3: orphan detection ----

test('list flags a session whose cwd no longer exists (orphan)', function () {
  const ctx = makeCtx();
  const dir = path.join(sessions.projectsDir(ctx), '-gone');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'cccc3333.jsonl'),
    JSON.stringify({ cwd: '/no/such/dir/anymore', text: 'hi' }) + '\n',
  );
  const live = path.join(dir, 'dddd4444.jsonl');
  fs.writeFileSync(live, JSON.stringify({ cwd: ctx.home, text: 'hi' }) + '\n'); // ctx.home exists
  const rows = sessions.list(ctx, { limit: 40 });
  const orphan = rows.filter(function (r) {
    return r.sessionId === 'cccc3333';
  })[0];
  const ok = rows.filter(function (r) {
    return r.sessionId === 'dddd4444';
  })[0];
  assert.strictEqual(orphan.orphan, true, 'missing cwd -> orphan');
  assert.strictEqual(ok.orphan, false, 'existing cwd -> not orphan');
});

// ---- E4: send (inject a message into a session) ----

test('sendCommand builds `claude -p <message> --resume <id>` (+ --fork-session)', function () {
  const s = sessions;
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
  const r = sessions.compactTranscript(lines, {});
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
  const s = sessions;
  const clean = JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\nnot-json-line\n';
  const r = s.compactTranscript(clean, {});
  assert.strictEqual(r.elided, 0);
  assert.strictEqual(r.compacted, clean, 'unchanged, unparseable line preserved');
});

test('rebindAppRegistry rewrites cwd/originCwd and clears transcriptUnavailable', function () {
  const ctx = makeCtx();
  ctx.appDataDir = path.join(ctx.home, 'appdata');
  const OLD = '/Users/x/Old',
    NEW = '/Users/x/New';
  const dir = path.join(ctx.appDataDir, 'claude-code-sessions', 'acct', 'org');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'local_1.json'),
    JSON.stringify({ cwd: OLD, originCwd: OLD + '/sub', transcriptUnavailable: true, cliSessionId: 'abc' }),
  );
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

// The real desktop-Code failure (from the "Chat history folder rename issue" session): when the
// folder is renamed the app DROPS cliSessionId and sets transcriptUnavailable. Rewriting cwd alone
// leaves the Code session unopenable — rebind must RECONNECT the dropped transcript link.
test('rebindAppRegistry restores a DROPPED cliSessionId from the transcript under the new key', function () {
  const ctx = makeCtx();
  ctx.appDataDir = path.join(ctx.home, 'appdata');
  const OLD = '/Users/x/OpenTraycer',
    NEW = '/Users/x/Plansmith';
  // the transcript now lives under the NEW encoded key
  seedTranscript(ctx, NEW, '79c67835-dc34', '{"cwd":"' + NEW + '","type":"user"}\n');
  const dir = path.join(ctx.appDataDir, 'claude-code-sessions', 'acct', 'org');
  fs.mkdirSync(dir, { recursive: true });
  // the app dropped the link: no cliSessionId, transcriptUnavailable set, cwd still old
  fs.writeFileSync(
    path.join(dir, 'local_f338.json'),
    JSON.stringify({ cwd: OLD, originCwd: OLD, transcriptUnavailable: true }),
  );

  const reg = sessions.rebindAppRegistry(ctx, OLD, NEW);
  assert.strictEqual(reg.patched, 1);
  assert.strictEqual(reg.relinked, 1, 'the dropped cliSessionId was restored');
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'local_f338.json'), 'utf8'));
  assert.strictEqual(rec.cwd, NEW);
  assert.strictEqual(rec.cliSessionId, '79c67835-dc34', 'reconnected to the transcript now under the new key');
  assert.strictEqual('transcriptUnavailable' in rec, false, 'unavailable flag cleared so the app opens it');
});

// ---- A3b: orphan detection must not fire on a DECODED path ----

// Claude encodes BOTH '/' and '.' as '-', so decoding a project dir name is lossy:
// '/Users/x/laya-uo-bot' round-trips as '/Users/x/laya/uo/bot', a path that never existed.
// list() used to orphan-flag that guess, and summarize() only read the first 64 KiB — a
// transcript whose first line is a huge paste put the real cwd beyond the window, so the
// guess is all it had. Both halves made live folders look "moved/renamed".
test('a cwd recorded beyond the 64 KiB head window is found, so a live folder is not flagged orphan', function () {
  const ctx = makeCtx();
  const real = path.join(ctx.home, 'laya-uo-bot'); // its dashes decode to fake subdirs
  fs.mkdirSync(real, { recursive: true });
  const dir = path.join(sessions.projectsDir(ctx), sessions.encodeCwd(real));
  fs.mkdirSync(dir, { recursive: true });
  const padding = JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'x'.repeat(90000) }] } });
  assert.ok(padding.length > 65536, 'fixture: first line must exceed the head window');
  fs.writeFileSync(
    path.join(dir, 'aaaa1111.jsonl'),
    padding + '\n' + JSON.stringify({ cwd: real, type: 'user' }) + '\n',
  );
  const row = sessions.list(ctx, { limit: 40 })[0];
  assert.strictEqual(row.cwd, real, 'the recorded cwd wins over the lossy decode');
  assert.strictEqual(row.orphan, false, 'a folder that exists is never an orphan');
});

test('a transcript with NO recorded cwd is not orphan-flagged on the decoded guess', function () {
  const ctx = makeCtx();
  const dir = path.join(sessions.projectsDir(ctx), '-Users-x-proj-with-dashes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bbbb2222.jsonl'), JSON.stringify({ type: 'user', text: 'no cwd here' }) + '\n');
  const row = sessions.list(ctx, { limit: 40 })[0];
  assert.strictEqual(row.orphan, false, 'a decoded path is a guess, not evidence of a move');
});

test('list() ignores .keyflip-bak rollback dirs (no double-count, no re-orphaning)', function () {
  const ctx = makeCtx();
  const live = path.join(ctx.home, 'live-proj');
  fs.mkdirSync(live, { recursive: true });
  const dir = path.join(sessions.projectsDir(ctx), sessions.encodeCwd(live));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cccc3333.jsonl'), JSON.stringify({ cwd: live, type: 'user' }) + '\n');
  // the rollback copy rebind leaves behind, still holding the OLD (gone) cwd
  const bak = dir + '.keyflip-bak';
  fs.mkdirSync(bak, { recursive: true });
  fs.writeFileSync(path.join(bak, 'cccc3333.jsonl'), JSON.stringify({ cwd: '/Users/x/old-name', type: 'user' }) + '\n');
  const rows = sessions.list(ctx, { limit: 40 });
  assert.strictEqual(rows.length, 1, 'the backup copy is not a session');
  assert.strictEqual(rows[0].orphan, false);
});

// ---- A4: rebind must carry the per-session SIDECAR dir, not just top-level .jsonl ----

// Claude Code writes sub-agent runs to <encoded-cwd>/<sessionId>/subagents/agent-*.jsonl next
// to the transcript. rebind only looked at `.jsonl` entries, so a rename left the sub-agent
// history at the dead key: the session resumed with its spawns unreachable.
test('rebind carries the session sidecar (subagents) to the new key and rewrites the path inside', function () {
  const ctx = makeCtx();
  const OLD = '/Users/x/Documents/OpenTraycer',
    NEW = '/Users/x/Documents/Plansmith';
  const dir = seedTranscript(ctx, OLD, 'sess-1', '{"cwd":"' + OLD + '"}\n');
  const sub = path.join(dir, 'sess-1', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-a1.jsonl'), '{"cwd":"' + OLD + '/apps","text":"spawn work"}\n');
  fs.writeFileSync(path.join(sub, 'agent-a1.meta.json'), JSON.stringify({ cwd: OLD }));
  fs.mkdirSync(path.join(dir, 'sess-1', 'other'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sess-1', 'other', 'blob.bin'), Buffer.from([1, 2, 3, 254]));

  const r = sessions.rebind(ctx, OLD, NEW, {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.sidecars, 1, 'the sidecar dir was carried');
  const newDir = path.join(sessions.projectsDir(ctx), sessions.encodeCwd(NEW));
  const movedAgent = path.join(newDir, 'sess-1', 'subagents', 'agent-a1.jsonl');
  assert.ok(fs.existsSync(movedAgent), 'sub-agent transcript exists at the new key');
  const body = fs.readFileSync(movedAgent, 'utf8');
  assert.ok(body.indexOf(NEW) !== -1 && body.indexOf(OLD) === -1, 'old path rewritten inside the sidecar');
  assert.strictEqual(
    JSON.parse(fs.readFileSync(path.join(newDir, 'sess-1', 'subagents', 'agent-a1.meta.json'), 'utf8')).cwd,
    NEW,
  );
  assert.deepStrictEqual(
    [...fs.readFileSync(path.join(newDir, 'sess-1', 'other', 'blob.bin'))],
    [1, 2, 3, 254],
    'binary sidecar copied verbatim',
  );
  assert.ok(
    fs.existsSync(path.join(r.backup, 'sess-1', 'subagents', 'agent-a1.jsonl')),
    'rollback backup carries the sidecar too',
  );
});

test('summarize reaches a cwd whose own record is one huge line (>1 MiB, no newline inside)', function () {
  const ctx = makeCtx();
  const real = path.join(ctx.home, 'big-paste-proj');
  fs.mkdirSync(real, { recursive: true });
  const dir = path.join(sessions.projectsDir(ctx), sessions.encodeCwd(real));
  fs.mkdirSync(dir, { recursive: true });
  // one record: cwd first, then a 2 MiB embedded paste — no newline until the record ends.
  // The paste runs past the read cap, so the RECORD never completes: the cwd still has to be
  // recovered (from the partial record), while the preview may legitimately stay empty.
  const rec =
    '{"cwd":"' +
    real +
    '","type":"user","message":{"role":"user","content":[{"type":"text","text":"' +
    'ğ'.repeat(2 * 1024 * 1024) +
    '"}]}}';
  fs.writeFileSync(path.join(dir, 'eeee5555.jsonl'), rec + '\n');
  const row = sessions.list(ctx, { limit: 40 })[0];
  assert.strictEqual(row.orphan, false, 'a live folder behind a huge record is not an orphan');
  assert.strictEqual(row.cwd, real, 'cwd recovered from the deep, unterminated record');
});

test('a multi-byte character split across a read chunk does not corrupt the record', function () {
  const ctx = makeCtx();
  const real = path.join(ctx.home, 'utf8-proj');
  fs.mkdirSync(real, { recursive: true });
  const dir = path.join(sessions.projectsDir(ctx), sessions.encodeCwd(real));
  fs.mkdirSync(dir, { recursive: true });
  const needle = 'Doğrulama ğüşıöç tamam';
  // Walk the seam: put the START of the cwd/user record at (and across) each 64 KiB chunk
  // boundary, so a raw toString() per chunk would cut a 2-byte UTF-8 char in half. That used to
  // corrupt the line enough that JSON.parse dropped it — losing cwd and preview together.
  [65533, 65534, 65535, 65536, 65537, 131070, 131073].forEach(function (k) {
    const filler = 'x'.repeat(k - 22) + 'ğğ'; // 'ğ' straddles whatever boundary k sits on
    const rec = JSON.stringify({
      cwd: real,
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: needle }] },
    });
    const file = path.join(dir, 'u' + k + '.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'queue-operation', note: filler }) + '\n' + rec + '\n');
    const rows = sessions.list(ctx, { limit: 40 });
    const row = rows.filter(function (r) {
      return r.sessionId === 'u' + k;
    })[0];
    assert.strictEqual(row.cwd, real, 'cwd survives the seam at ' + k);
    assert.strictEqual(row.preview, needle, 'preview at ' + k + ' was: ' + JSON.stringify(row.preview));
    assert.strictEqual(row.orphan, false);
    fs.rmSync(file);
  });
});

// A project's long-term notes live in <encoded-cwd>/memory/ (MEMORY.md + one .md per note), NOT
// inside any transcript. rebind moved only transcripts + sidecars, so after a repo move the notes
// stayed at the dead key — and the old key looks like a "duplicate" that is safe to delete, which
// is exactly how years of project memory gets destroyed. rebind now merges memory/ and never
// overwrites or drops a note.
function seedMemory(ctx, cwd, files) {
  const dir = path.join(sessions.projectsDir(ctx), sessions.encodeCwd(cwd), 'memory');
  fs.mkdirSync(dir, { recursive: true });
  Object.keys(files).forEach(function (name) {
    fs.writeFileSync(path.join(dir, name), files[name]);
  });
  return dir;
}

test('rebind carries memory/ notes to the new key and rewrites the moved path inside them', function () {
  const ctx = makeCtx();
  const OLD = '/Users/x/Projects/GitHub/app',
    NEW = '/Users/x/Projects/app';
  seedTranscript(ctx, OLD, 's1', '{"cwd":"' + OLD + '"}\n');
  const oldMem = seedMemory(ctx, OLD, {
    'MEMORY.md': '# Index\n- [Deploy](memory/deploy.md) saw ' + OLD + '/Dockerfile\n',
    'deploy.md': 'Run ' + OLD + '/scripts/deploy.sh from ' + OLD + '.\n',
  });
  // The new key already has its own notes — one byte-identical, one same-name-different-content.
  const newMem = seedMemory(ctx, NEW, {
    'deploy.md': 'Local note for the new checkout.\n',
  });
  fs.writeFileSync(path.join(oldMem, 'shared.md'), 'same text both keys\n');
  fs.writeFileSync(path.join(newMem, 'shared.md'), 'same text both keys\n');

  const r = sessions.rebind(ctx, OLD, NEW, {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.memory.copied, 1, 'only MEMORY.md was new: ' + JSON.stringify(r.memory));
  assert.strictEqual(r.memory.identical, 1, 'shared.md was already there, unchanged');
  assert.strictEqual(r.memory.conflicts, 1, 'deploy.md collided');

  // unique note carried over, with the dead path rewritten
  assert.ok(fs.existsSync(path.join(newMem, 'MEMORY.md')), 'MEMORY.md arrived');
  assert.ok(fs.readFileSync(path.join(newMem, 'MEMORY.md'), 'utf8').indexOf(OLD) === -1, 'path rewritten');
  // the live note at the destination is NEVER overwritten by the merge
  assert.strictEqual(
    fs.readFileSync(path.join(newMem, 'deploy.md'), 'utf8'),
    'Local note for the new checkout.\n',
    'existing dest note untouched',
  );
  assert.ok(
    fs.existsSync(path.join(newMem, 'deploy.md.keyflip-conflict')),
    'the incoming version is kept aside instead of lost',
  );
  assert.ok(fs.readFileSync(path.join(newMem, 'deploy.md.keyflip-conflict'), 'utf8').indexOf(OLD) === -1);
  // non-destructive: the source key still holds every original
  assert.ok(fs.existsSync(path.join(oldMem, 'deploy.md')), 'source note still present');
});

test('rebind still works when the old key holds ONLY memory (transcripts were pruned)', function () {
  const ctx = makeCtx();
  const OLD = '/Users/x/OldNotes',
    NEW = '/Users/x/NewNotes';
  const dir = path.join(sessions.projectsDir(ctx), sessions.encodeCwd(OLD));
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true }); // no .jsonl at all
  fs.writeFileSync(path.join(dir, 'memory', 'a.md'), 'note about ' + OLD + '\n');
  const r = sessions.rebind(ctx, OLD, NEW, {});
  assert.strictEqual(r.ok, true, 'memory-only key is work, not an error');
  assert.strictEqual(r.moved, 0);
  assert.strictEqual(r.memory.copied, 1);
  assert.ok(fs.existsSync(path.join(sessions.projectsDir(ctx), sessions.encodeCwd(NEW), 'memory', 'a.md')));
  assert.strictEqual(r.backup, null, 'no empty .keyflip-bak is created for a transcript-less key');
});
