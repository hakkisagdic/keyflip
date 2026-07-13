'use strict';
// Tests for session (transcript) lifecycle mutations (src/sessionedit.js): recoverable + hard
// delete, PII scrub (dry-run vs apply), and surgical edits (delete / redact / truncate). Every
// mutating op must keep the .jsonl valid JSONL, back up before writing, and refuse path traversal.
// pii.js is built in parallel, so we inject a hermetic fake via ctx.pii that honours its contract
// (scrub(text,opts) -> {text,counts}).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const sessionedit = require('../src/sessionedit');
const archive = require('../src/archive');
const { makeCtx } = require('./helpers');

// A stand-in for pii.js honouring the { text, counts } contract: redacts emails + phones.
const fakePii = {
  CATEGORIES: ['email', 'phone'],
  scrub: function (text, opts) {
    const counts = {};
    let out = String(text)
      .replace(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, function () { counts.email = (counts.email || 0) + 1; return '[EMAIL]'; })
      .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, function () { counts.phone = (counts.phone || 0) + 1; return '[PHONE]'; });
    return { text: out, counts: counts };
  },
};

function ctx() {
  const c = makeCtx();
  c.pii = fakePii;
  return c;
}

// Seed a realistic transcript: a bookkeeping line, a user turn with an email + phone, an assistant
// turn carrying a tool_use (structural json that must survive), and a summary line.
function seed(c, project, id) {
  const dir = path.join(c.home, '.claude', 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.jsonl');
  const lines = [
    JSON.stringify({ type: 'queue-operation', sessionId: id, timestamp: '2026-07-01T00:00:00Z' }),
    JSON.stringify({ type: 'user', sessionId: id, cwd: '/work/x', timestamp: '2026-07-01T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'Email me at jane.doe@example.com or call 555-123-4567 thanks' }] } }),
    JSON.stringify({ type: 'assistant', sessionId: id, message: { role: 'assistant', content: [{ type: 'text', text: 'Sure, noted.' }, { type: 'tool_use', id: 'toolu_ABC123', name: 'Read', input: { file_path: '/x' } }] } }),
    JSON.stringify({ type: 'summary', summary: 'Reach bob@corp.io for details', text: 'plain field, no pii here' }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function eachLineIsJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  raw.split('\n').forEach(function (l) { if (l.trim()) JSON.parse(l); /* throws if invalid */ });
  return raw;
}

// --- delete ----------------------------------------------------------------

test('deleteSession archives by default and removes the original (recoverable)', function () {
  const c = ctx();
  const file = seed(c, '-p', 'sess-del');
  const r = sessionedit.deleteSession(c, { project: '-p', sessionId: 'sess-del' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.mode, 'archived');
  assert.strictEqual(fs.existsSync(file), false, 'original transcript removed');
  const gz = path.join(archive.store(c), '-p', 'sess-del.jsonl.gz');
  assert.ok(fs.existsSync(gz), 'gzipped archive stored (recoverable)');
  // and it is truly recoverable
  assert.ok(zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8').indexOf('jane.doe@example.com') !== -1);
});

test('deleteSession hard permanently unlinks and does NOT archive', function () {
  const c = ctx();
  const file = seed(c, '-p', 'sess-hard');
  const r = sessionedit.deleteSession(c, { project: '-p', sessionId: 'sess-hard', hard: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.mode, 'deleted');
  assert.ok(r.bytes > 0);
  assert.strictEqual(fs.existsSync(file), false, 'transcript unlinked');
  assert.strictEqual(fs.existsSync(path.join(archive.store(c), '-p', 'sess-hard.jsonl.gz')), false, 'no archive copy for a hard delete');
});

test('deleteSession on a missing session returns not-found (no throw)', function () {
  const c = ctx();
  assert.strictEqual(sessionedit.deleteSession(c, { project: '-p', sessionId: 'ghost' }).reason, 'not-found');
  assert.strictEqual(sessionedit.deleteSession(c, { project: '-p', sessionId: 'ghost', hard: true }).reason, 'not-found');
});

// --- scrub -----------------------------------------------------------------

test('scrubSession dry-run reports counts and writes nothing', function () {
  const c = ctx();
  const file = seed(c, '-p', 'scrub-dry');
  const before = fs.readFileSync(file, 'utf8');
  const r = sessionedit.scrubSession(c, { project: '-p', sessionId: 'scrub-dry', apply: false });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.applied, false);
  assert.strictEqual(r.redactions.email, 2, 'jane + bob');
  assert.strictEqual(r.redactions.phone, 1);
  assert.strictEqual(r.messagesScanned, 3, 'user, assistant, summary (queue-op has no visible text)');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'file untouched on dry-run');
  assert.strictEqual(fs.existsSync(file + '.bak'), false, 'no backup on dry-run');
});

test('scrubSession apply also redacts PII inside assistant thinking blocks (regression)', function () {
  const c = ctx();
  const dir = path.join(c.home, '.claude', 'projects', '-p');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'think.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'thinking', thinking: "the user's email is jane.doe@example.com, note it" },
    { type: 'text', text: 'Sent to jane.doe@example.com' },
  ] } }) + '\n');
  const r = sessionedit.scrubSession(c, { project: '-p', sessionId: 'think', apply: true });
  assert.strictEqual(r.applied, true);
  const after = fs.readFileSync(file, 'utf8');
  // The email appears in BOTH the thinking block and the text block; both must be redacted
  // (fakePii replaces each with [EMAIL]). Before the fix, thinking was skipped -> 1 placeholder
  // and the raw email survived in the thinking block.
  assert.strictEqual(after.indexOf('jane.doe@example.com'), -1, 'email must be gone from BOTH thinking and text');
  assert.strictEqual((after.match(/\[EMAIL\]/g) || []).length, 2, 'both the thinking and text emails redacted');
  assert.strictEqual(r.redactions.email, 2);
  assert.ok(after.trim().split('\n').every(function (l) { try { JSON.parse(l); return true; } catch (e) { return false; } }), 'still valid JSONL');
});

test('scrubSession apply redacts visible text, keeps every line valid JSON, preserves structure, and backs up', function () {
  const c = ctx();
  const file = seed(c, '-p', 'scrub-go');
  const original = fs.readFileSync(file, 'utf8');
  const r = sessionedit.scrubSession(c, { project: '-p', sessionId: 'scrub-go', apply: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.applied, true);
  // backup exists, is the original, and is 0600
  assert.ok(r.backup && fs.existsSync(r.backup), 'backup written');
  assert.strictEqual(fs.readFileSync(r.backup, 'utf8'), original, 'backup is the original bytes');
  assert.strictEqual(fs.statSync(r.backup).mode & 0o777, 0o600, 'backup not world/group readable');
  // every line still valid JSON
  const raw = eachLineIsJson(file);
  // PII gone from visible text, placeholders in
  assert.strictEqual(raw.indexOf('jane.doe@example.com'), -1);
  assert.strictEqual(raw.indexOf('555-123-4567'), -1);
  assert.strictEqual(raw.indexOf('bob@corp.io'), -1);
  assert.ok(raw.indexOf('[EMAIL]') !== -1 && raw.indexOf('[PHONE]') !== -1);
  // structural fields survive: the tool_use id and name are untouched
  assert.ok(raw.indexOf('toolu_ABC123') !== -1, 'tool_use id preserved');
  assert.ok(raw.indexOf('"file_path":"/x"') !== -1, 'tool input json preserved');
  // written file is 0600
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});

test('scrubSession on a missing session returns not-found', function () {
  const c = ctx();
  assert.strictEqual(sessionedit.scrubSession(c, { project: '-p', sessionId: 'nope', apply: true }).reason, 'not-found');
});

// --- edit ------------------------------------------------------------------

test('editSession delete-message drops the Nth event line and keeps valid JSONL', function () {
  const c = ctx();
  const file = seed(c, '-p', 'edit-del');
  const dry = sessionedit.editSession(c, { project: '-p', sessionId: 'edit-del', op: { type: 'delete-message', index: 0 } });
  assert.strictEqual(dry.applied, false);
  assert.strictEqual(dry.before, 4);
  assert.strictEqual(dry.after, 3);
  assert.strictEqual(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 4, 'dry-run wrote nothing');

  const r = sessionedit.editSession(c, { project: '-p', sessionId: 'edit-del', op: { type: 'delete-message', index: 0, apply: true } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.applied, true);
  assert.ok(fs.existsSync(r.backup), 'backed up before mutate');
  const raw = eachLineIsJson(file);
  assert.strictEqual(raw.split('\n').filter(Boolean).length, 3);
  assert.strictEqual(raw.indexOf('queue-operation'), -1, 'the deleted event is gone');
});

test('editSession redact-message replaces visible text only, keeps structure + valid JSONL', function () {
  const c = ctx();
  const file = seed(c, '-p', 'edit-red');
  const r = sessionedit.editSession(c, { project: '-p', sessionId: 'edit-red', op: { type: 'redact-message', index: 1, apply: true } });
  assert.strictEqual(r.ok, true);
  assert.ok(fs.existsSync(r.backup));
  const raw = eachLineIsJson(file);
  assert.strictEqual(raw.indexOf('jane.doe@example.com'), -1);
  assert.ok(raw.indexOf('[REDACTED]') !== -1);
  // parse the user line and confirm the structure (content array/text block) is intact
  const userLine = JSON.parse(raw.split('\n').filter(Boolean)[1]);
  assert.strictEqual(userLine.message.content[0].type, 'text');
  assert.strictEqual(userLine.message.content[0].text, '[REDACTED]');
  assert.strictEqual(userLine.type, 'user'); // structural field untouched
});

test('editSession redact-message honours a custom replacement', function () {
  const c = ctx();
  const file = seed(c, '-p', 'edit-red2');
  sessionedit.editSession(c, { project: '-p', sessionId: 'edit-red2', op: { type: 'redact-message', index: 3, replacement: 'XX', apply: true } });
  const raw = eachLineIsJson(file);
  const sumLine = JSON.parse(raw.split('\n').filter(Boolean)[3]);
  assert.strictEqual(sumLine.summary, 'XX');
  assert.strictEqual(sumLine.text, 'XX');
});

test('editSession truncate-after drops every event past N and keeps valid JSONL', function () {
  const c = ctx();
  const file = seed(c, '-p', 'edit-trunc');
  const r = sessionedit.editSession(c, { project: '-p', sessionId: 'edit-trunc', op: { type: 'truncate-after', index: 1, apply: true } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.after, 2);
  assert.ok(fs.existsSync(r.backup));
  const raw = eachLineIsJson(file);
  const kept = raw.split('\n').filter(Boolean);
  assert.strictEqual(kept.length, 2);
  assert.strictEqual(JSON.parse(kept[0]).type, 'queue-operation');
  assert.strictEqual(JSON.parse(kept[1]).type, 'user');
});

test('editSession rejects a bad op and an out-of-range index', function () {
  const c = ctx();
  seed(c, '-p', 'edit-bad');
  assert.strictEqual(sessionedit.editSession(c, { project: '-p', sessionId: 'edit-bad', op: { type: 'nope', index: 0 } }).reason, 'bad-op');
  assert.strictEqual(sessionedit.editSession(c, { project: '-p', sessionId: 'edit-bad', op: { type: 'delete-message', index: 99 } }).reason, 'index-out-of-range');
  assert.strictEqual(sessionedit.editSession(c, { project: '-p', sessionId: 'edit-bad', op: { type: 'delete-message', index: -1 } }).reason, 'index-out-of-range');
});

// --- security --------------------------------------------------------------

test('path-traversal in project or sessionId is refused', function () {
  const c = ctx();
  seed(c, '-p', 'safe-id');
  const bad = [
    { project: '../evil', sessionId: 'safe-id' },
    { project: '-p', sessionId: '../../etc/passwd' },
    { project: 'a/b', sessionId: 'safe-id' },
    { project: '-p', sessionId: '-flag' }, // leading dash -> not a valid id
  ];
  bad.forEach(function (args) {
    assert.strictEqual(sessionedit.deleteSession(c, args).ok, false, JSON.stringify(args));
    assert.strictEqual(sessionedit.scrubSession(c, Object.assign({ apply: true }, args)).ok, false, JSON.stringify(args));
    assert.strictEqual(sessionedit.editSession(c, Object.assign({ op: { type: 'delete-message', index: 0, apply: true } }, args)).ok, false, JSON.stringify(args));
  });
});
