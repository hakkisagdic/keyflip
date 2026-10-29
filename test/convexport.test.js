// Conversation export: MD/HTML/JSON rendering with redaction, Obsidian ownership rules,
// and the handoff bundle. Synthetic conversations; no real credentials or transcripts.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { tmpdir } from './helpers.js';
import * as convexport from '../src/convexport.js';

function conv(overrides) {
  const messages = [
    { role: 'user', text: 'Please fix the failing CI job.', ts: '2026-01-01T10:00:00.000Z', tools: [] },
    {
      role: 'assistant',
      text: 'Reading the logs.\nAPI_KEY=sk-live-1234567890',
      ts: '2026-01-01T10:00:01.000Z',
      tools: ['Read', 'Bash'],
    },
  ];
  const c = Object.assign(
    {
      schemaVersion: 1,
      id: 'claude:local:abc12345',
      app: 'claude',
      surface: 'cli',
      title: 'Fix CI',
      cwd: '/work/proj',
      account: null,
      createdAt: '2026-01-01T10:00:00.000Z',
      updatedAt: '2026-01-01T10:00:01.000Z',
      messages: messages,
      counts: { messages: 2, user: 1, assistant: 1 },
      source: { path: '/tmp/fake.jsonl', mtimeMs: 1, size: 2 },
      hash: 'h1',
    },
    overrides || {},
  );
  return c;
}

test('markdown: frontmatter, roles, tool summary, and secret masking by default', function () {
  const r = convexport.render(conv(), { format: 'md', now: '2026-01-01T00:00:00.000Z' });
  assert.strictEqual(r.format, 'md');
  assert.strictEqual(r.redacted, 1);
  assert.match(r.content, /^---\nkeyflip_id: "claude:local:abc12345"/);
  assert.match(r.content, /redacted: true/);
  assert.match(r.content, /# Fix CI/);
  assert.match(r.content, /You/);
  assert.match(r.content, /used Read, Bash/);
  assert.ok(!/sk-live-1234567890/.test(r.content));
  assert.match(r.content, /API_KEY=/);

  const raw = convexport.render(conv(), { format: 'md', redact: false });
  assert.strictEqual(raw.redacted, 0);
  assert.match(raw.content, /sk-live-1234567890/);
});

test('JSON and HTML render the same conversation; HTML escapes markup', function () {
  const c = conv({
    messages: [
      { role: 'user', text: '<script>alert(1)</script>', ts: null, tools: [] },
      { role: 'assistant', text: 'ok', ts: null, tools: [] },
    ],
  });
  const json = JSON.parse(convexport.render(c, { format: 'json', now: '2026-01-01T00:00:00.000Z' }).content);
  assert.strictEqual(json.format, 'keyflip-conversation');
  assert.strictEqual(json.version, 1);
  assert.strictEqual(json.conversation.id, 'claude:local:abc12345');
  assert.strictEqual(json.exportedAt, '2026-01-01T00:00:00.000Z');

  const html = convexport.render(c, { format: 'html' }).content;
  assert.match(html, /<!doctype html>/i);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.throws(() => convexport.render(c, { format: 'pdf' }), /unknown format/);
});

test('exportOne refuses to overwrite unless forced and writes 0600', function () {
  const dir = tmpdir();
  const target = path.join(dir, 'one.md');
  const first = convexport.exportOne(conv(), { out: target });
  assert.strictEqual(first.file, target);
  assert.ok(fs.existsSync(target));
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);
  assert.throws(() => convexport.exportOne(conv({ title: 'Other' }), { out: target }), /refusing to overwrite/);
  convexport.exportOne(conv({ title: 'Other' }), { out: target, force: true });
  assert.match(fs.readFileSync(target, 'utf8'), /# Other/);

  // A trailing separator means "directory" even before it exists.
  const asDir = convexport.exportOne(conv(), { out: path.join(dir, 'nested') + path.sep });
  assert.strictEqual(path.dirname(asDir.file), path.join(dir, 'nested'));
});

test('Obsidian: writes once, skips unchanged, and never overwrites a user edit', function () {
  const out = tmpdir();
  const c = conv();
  const r1 = convexport.obsidianExport(null, [c], { out: out, now: '2026-01-01T00:00:00.000Z' });
  assert.strictEqual(r1.written, 1);
  assert.strictEqual(r1.conflicts, 0);
  assert.ok(fs.existsSync(r1.index));
  assert.match(fs.readFileSync(r1.index, 'utf8'), /\[\[.*\|Fix CI\]\]/);
  const noteFile = r1.rows[0].file;
  assert.ok(noteFile.indexOf(path.join(out, 'keyflip', 'Conversations')) === 0);
  const note = fs.readFileSync(noteFile, 'utf8');
  assert.match(note, /tags: \["keyflip", "keyflip\/claude", "keyflip\/cli"\]/);
  assert.match(note, /\[\[Conversations Index\|← all conversations\]\]/);
  const manifestFile = path.join(out, 'keyflip', '.conversations-manifest.json');
  assert.ok(fs.existsSync(manifestFile));
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(manifestFile).mode & 0o777, 0o600);

  const r2 = convexport.obsidianExport(null, [c], { out: out });
  assert.strictEqual(r2.skipped, 1);
  assert.strictEqual(r2.written, 0);

  fs.writeFileSync(noteFile, note + '\nmy own note\n');
  const r3 = convexport.obsidianExport(null, [c], { out: out, now: '2026-01-02T00:00:00.000Z' });
  assert.strictEqual(r3.conflicts, 1);
  assert.match(fs.readFileSync(noteFile, 'utf8'), /my own note/);
  const conflict = r3.rows[0].file;
  assert.notStrictEqual(conflict, noteFile);
  assert.match(conflict, /\(conflict .*\)\.md$/);
  // Ownership still points at the note path, not at our conflict copy.
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  assert.strictEqual(manifest.files[c.id].file, path.relative(out, noteFile));

  const r4 = convexport.obsidianExport(null, [c], { out: out, force: true });
  assert.strictEqual(r4.forced, 1);
  assert.ok(!/my own note/.test(fs.readFileSync(noteFile, 'utf8')));
});

test('Obsidian: a renamed note is removed only while it is still ours', function () {
  const out = tmpdir();
  const first = convexport.obsidianExport(null, [conv()], { out: out });
  const oldFile = first.rows[0].file;
  const renamed = convexport.obsidianExport(null, [conv({ title: 'Fix CI properly' })], { out: out });
  assert.strictEqual(renamed.renamed, 1);
  assert.strictEqual(renamed.stale.length, 0);
  assert.ok(!fs.existsSync(oldFile));

  // Now the user edits the note, then the title changes again: keep their file, report it.
  const secondOld = renamed.rows[0].file;
  fs.writeFileSync(secondOld, fs.readFileSync(secondOld, 'utf8') + '\nan edit\n');
  const third = convexport.obsidianExport(null, [conv({ title: 'Fix CI again' })], { out: out });
  assert.strictEqual(third.renamed, 0);
  assert.strictEqual(third.stale.length, 1);
  assert.match(third.stale[0].reason, /edited by the user/);
  assert.ok(fs.existsSync(secondOld));
});

test('transfer bundle names the target, keeps the transcript, and redacts in one pass', function () {
  const out = tmpdir();
  const r = convexport.writeBundle(conv(), 'chatgpt', { out: out, now: '2026-01-01T00:00:00.000Z' });
  assert.strictEqual(r.target, 'codex'); // alias
  assert.strictEqual(r.redacted, 1);
  assert.deepStrictEqual(
    r.files.map((f) => path.basename(f)),
    ['conversation.json', 'CONTINUE.md', 'README.md'],
  );
  for (const f of r.files) {
    assert.ok(fs.existsSync(f));
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  }
  const md = fs.readFileSync(path.join(out, 'CONTINUE.md'), 'utf8');
  assert.match(md, /Continue this conversation in Codex CLI \/ ChatGPT desktop/);
  assert.match(md, /secrets redacted: 1/);
  assert.ok(!/sk-live-1234567890/.test(md));
  assert.match(fs.readFileSync(path.join(out, 'README.md'), 'utf8'), /Native import available: no/);

  const json = JSON.parse(fs.readFileSync(path.join(out, 'conversation.json'), 'utf8'));
  assert.strictEqual(json.target, 'codex');
  assert.strictEqual(json.redactedSecrets, 1);

  assert.throws(() => convexport.writeBundle(conv(), 'claude', { out: out }), /refusing to overwrite/);
  const again = convexport.writeBundle(conv(), 'claude', { out: out, force: true });
  assert.strictEqual(again.target, 'claude');
  assert.match(fs.readFileSync(path.join(out, 'CONTINUE.md'), 'utf8'), /Claude Code/);
});

test('an unknown target falls back to generic instead of echoing the input into a prompt', function () {
  const out = tmpdir();
  const r = convexport.writeBundle(conv(), 'not-a-real-tool <script>', { out: out });
  assert.strictEqual(r.target, 'generic');
  assert.ok(!/<script>/.test(fs.readFileSync(path.join(out, 'CONTINUE.md'), 'utf8')));
  const caps = convexport.capabilities().map((c) => c.id);
  assert.ok(caps.indexOf('claude') !== -1 && caps.indexOf('windsurf') !== -1);
});
