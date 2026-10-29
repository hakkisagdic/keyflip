// Tests for the streaming migrate container (src/migrate-stream.js). The format
// exists because the legacy bundle built ONE JSON string: at ~830 MB export hit
// the heap limit, and encrypting it base64'd the ciphertext into a second giant
// string that exceeds V8's max string. These tests pin the container's promises:
//   - bytes round-trip exactly (including arbitrary binary and multibyte text),
//   - every encrypted record is authenticated and the chain rejects reorder,
//     tamper, truncation and trailing data,
//   - import merges as a union and --force overwrites, like the legacy path,
//   - unsafe project/session segments never escape ~/.claude/projects,
//   - a small legacy bundle still imports, an oversized one is refused cheaply.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

import * as migrate from '../src/migrate.js';
import * as provider from '../src/provider.js';
import * as profiles from '../src/profiles.js';
import * as sync from '../src/sync.js';
import * as stream from '../src/migrate-stream.js';
import { makeCtx, assertPrivateMode } from './helpers.js';

function ctxWithClaude() {
  const ctx = makeCtx();
  ctx.claudeDir = path.join(ctx.home, '.claude');
  fs.mkdirSync(ctx.claudeDir, { recursive: true });
  return ctx;
}
function seedAccount(ctx, name, email, blob) {
  ctx.store.setProfile(name, blob);
  profiles.write(ctx.configDir, {
    name: name,
    email: email,
    oauthAccount: { organizationUuid: 'org-' + name },
    userID: 'u' + name,
    savedAt: ctx.now(),
  });
}
function seedTranscript(ctx, project, id, content) {
  const dir = path.join(ctx.claudeDir, 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.jsonl');
  fs.writeFileSync(file, content);
  return file;
}
function txPath(ctx, project, id) {
  return path.join(ctx.claudeDir, 'projects', project, id + '.jsonl');
}
function lines(file) {
  return fs.readFileSync(file, 'utf8').split('\n');
}
function writeLines(file, ls) {
  fs.writeFileSync(file, ls.join('\n'));
}
async function exportPlan(ctx, opts) {
  const plan = migrate.planExport(ctx, opts || {});
  const out = path.join(ctx.home, 'bundle.kf');
  await stream.writeBundle({
    out: out,
    meta: plan.meta,
    files: plan.files,
    passphrase: opts && opts.passphrase,
    chunkSize: opts && opts.chunkSize,
  });
  return out;
}

// ---- round-trips -----------------------------------------------------------

test('unencrypted round-trip copies account, provider and byte-exact transcripts in tiny chunks', async function () {
  const src = ctxWithClaude();
  seedAccount(src, 'work', 'a@x.com', '{"token":"AAA"}');
  provider.add(src, 'relay', { baseUrl: 'https://relay.example', authScheme: 'api-key', key: 'sk-123' });
  const binary = Buffer.from(
    Array.from({ length: 512 }, function (_, i) {
      return i % 256;
    }),
  );
  const text = Buffer.from('héllo — 世界\n', 'utf8');
  seedTranscript(src, '-p', 'bin', binary);
  seedTranscript(src, '-p', 'multi', text);

  const plan = migrate.planExport(src, {});
  assert.strictEqual(plan.meta.counts.transcripts, 2);
  const out = path.join(src.home, 'bundle.kf');
  const wrote = await stream.writeBundle({ out: out, meta: plan.meta, files: plan.files, chunkSize: 7 });
  assert.strictEqual(wrote.bytes, binary.length + text.length);
  assertPrivateMode(out);

  const ls = lines(out);
  assert.strictEqual(ls[0], stream.MAGIC);
  const header = JSON.parse(ls[1]);
  assert.strictEqual(header.format, stream.FORMAT);
  assert.strictEqual(header.version, stream.VERSION);
  assert.strictEqual(header.encrypted, false);
  assert.strictEqual(header.transcripts, 2);
  assert.strictEqual(header.bytes, binary.length + text.length);
  assert.strictEqual(header.chunkSize, 7);

  const dst = ctxWithClaude();
  const res = await stream.importBundle({ ctx: dst, input: out });
  assert.deepStrictEqual(res.accounts.imported, ['work']);
  assert.deepStrictEqual(res.providers.imported, ['relay']);
  assert.strictEqual(res.transcripts.added, 2);
  assert.ok(fs.readFileSync(txPath(dst, '-p', 'bin')).equals(binary), 'binary transcript is byte-exact');
  assert.ok(fs.readFileSync(txPath(dst, '-p', 'multi')).equals(text), 'multibyte transcript is byte-exact');
  assert.strictEqual(dst.store.getProfile('work'), '{"token":"AAA"}');
  assert.strictEqual(dst.store.getProfile('provider__relay'), 'sk-123');
});

test('encrypted round-trip authenticates records and keeps secrets out of the clear', async function () {
  const src = ctxWithClaude();
  seedAccount(src, 'work', 'a@x.com', '{"token":"AAA"}');
  provider.add(src, 'relay', { baseUrl: 'https://relay.example', authScheme: 'api-key', key: 'sk-123' });
  seedTranscript(src, '-p', 's1', 'HELLO\n');

  const plan = migrate.planExport(src, {});
  const out = path.join(src.home, 'bundle.kf');
  await stream.writeBundle({
    out: out,
    meta: plan.meta,
    files: plan.files,
    passphrase: 'pw',
    chunkSize: 5,
  });
  const raw = fs.readFileSync(out, 'utf8');
  const header = JSON.parse(raw.split('\n')[1]);
  assert.strictEqual(header.encrypted, true);
  assert.strictEqual(header.alg, 'aes-256-gcm');
  assert.strictEqual(header.kdf, 'scrypt');
  assert.ok(header.salt, 'the KDF salt rides the header');
  // `{` cannot appear in base64, and base64 has no `-`; both secrets are inside ct.
  assert.strictEqual(raw.indexOf('{"token":"AAA"}'), -1);
  assert.strictEqual(raw.indexOf('sk-123'), -1);

  const dst = ctxWithClaude();
  const res = await stream.importBundle({ ctx: dst, input: out, passphrase: 'pw' });
  assert.strictEqual(res.transcripts.added, 1);
  assert.strictEqual(fs.readFileSync(txPath(dst, '-p', 's1'), 'utf8'), 'HELLO\n');
  assert.strictEqual(dst.store.getProfile('work'), '{"token":"AAA"}');
  assert.strictEqual(dst.store.getProfile('provider__relay'), 'sk-123');
});

test('an empty transcript imports as an empty file', async function () {
  const src = ctxWithClaude();
  seedTranscript(src, '-p', 'empty', Buffer.alloc(0));
  const out = await exportPlan(src);
  const dst = ctxWithClaude();
  const res = await stream.importBundle({ ctx: dst, input: out });
  assert.strictEqual(res.transcripts.added, 1);
  assert.strictEqual(fs.statSync(txPath(dst, '-p', 'empty')).size, 0);
});

// ---- passphrase and integrity ---------------------------------------------

test('an encrypted stream refuses a missing or wrong passphrase before writing anything', async function () {
  const src = ctxWithClaude();
  seedAccount(src, 'work', 'a@x.com', '{"token":"AAA"}');
  seedTranscript(src, '-p', 's1', 'HELLO\n');
  const out = await exportPlan(src, { passphrase: 'right' });

  const a = ctxWithClaude();
  await assert.rejects(stream.importBundle({ ctx: a, input: out }), /encrypted — pass --passphrase-file/);
  assert.deepStrictEqual(Object.keys(a.store.profiles), [], 'no account imported without the passphrase');
  assert.ok(!fs.existsSync(txPath(a, '-p', 's1')));

  const b = ctxWithClaude();
  await assert.rejects(
    stream.importBundle({ ctx: b, input: out, passphrase: 'wrong' }),
    /wrong passphrase|decryption failed/,
  );
  assert.ok(!fs.existsSync(txPath(b, '-p', 's1')));
});

test('a tampered transcript record fails authentication and installs no metadata', async function () {
  const src = ctxWithClaude();
  seedAccount(src, 'work', 'a@x.com', '{"token":"AAA"}');
  seedTranscript(src, '-p', 's1', 'HELLO\n'); // 6 bytes = one chunk at line 4
  const out = await exportPlan(src, { passphrase: 'pw', chunkSize: 16 });
  const ls = lines(out);
  // lines: magic, header, meta, tx, chunk, tx-end, end — tamper the chunk, not meta,
  // so the write ordering itself is under test.
  const rec = JSON.parse(ls[4]);
  const ct = Buffer.from(rec.ct, 'base64');
  ct[0] = ct[0] ^ 0xff;
  rec.ct = ct.toString('base64');
  ls[4] = JSON.stringify(rec);
  writeLines(out, ls);

  const dst = ctxWithClaude();
  await assert.rejects(
    stream.importBundle({ ctx: dst, input: out, passphrase: 'pw' }),
    /wrong passphrase|decryption failed/,
  );
  assert.ok(!fs.existsSync(txPath(dst, '-p', 's1')));
  assert.deepStrictEqual(Object.keys(dst.store.profiles), [], 'metadata is applied only after the stream verifies');
});

test('reordered records are rejected (sequence numbers are part of the AAD)', async function () {
  const src = ctxWithClaude();
  seedTranscript(src, '-p', 's1', 'A'.repeat(64));
  const out = await exportPlan(src, { chunkSize: 8 });
  const ls = lines(out);
  // lines: magic, header, meta, tx, chunk, chunk, …, tx-end, end
  const tmp = ls[4];
  ls[4] = ls[5];
  ls[5] = tmp;
  writeLines(out, ls);
  const dst = ctxWithClaude();
  await assert.rejects(stream.importBundle({ ctx: dst, input: out }), /out of order/);
});

test('a stream cut mid-transcript aborts with no partial or leftover file', async function () {
  const src = ctxWithClaude();
  seedTranscript(src, '-p', 's1', 'B'.repeat(128));
  const out = await exportPlan(src, { chunkSize: 8 });
  const ls = lines(out);
  // Keep magic, header, meta, tx and exactly one chunk — no tx-end, no end.
  writeLines(out, ls.slice(0, 5));
  const dst = ctxWithClaude();
  await assert.rejects(stream.importBundle({ ctx: dst, input: out }), /truncated/);
  const dir = path.join(dst.claudeDir, 'projects', '-p');
  assert.deepStrictEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [], 'no partial file and no temp leftover');
});

test('a stream missing only its end record is rejected as truncated', async function () {
  const src = ctxWithClaude();
  seedTranscript(src, '-p', 's1', 'C\n');
  const out = await exportPlan(src, {});
  const ls = lines(out);
  writeLines(out, ls.slice(0, -2)); // drop the end record + trailing empty element
  const dst = ctxWithClaude();
  await assert.rejects(stream.importBundle({ ctx: dst, input: out }), /no end record/);
});

test('trailing data after the end record is rejected', async function () {
  const src = ctxWithClaude();
  seedTranscript(src, '-p', 's1', 'D\n');
  const out = await exportPlan(src, {});
  const ls = lines(out).filter(function (l) {
    return l !== '';
  });
  ls.push(JSON.stringify({ seq: 99, type: 'chunk' }));
  writeLines(out, ls);
  const dst = ctxWithClaude();
  await assert.rejects(stream.importBundle({ ctx: dst, input: out }), /trailing data after the end record/);
});

test('header totals are checked against what actually arrived', async function () {
  const src = ctxWithClaude();
  seedTranscript(src, '-p', 's1', 'E\n');
  const out = await exportPlan(src, {});
  const ls = lines(out);
  const header = JSON.parse(ls[1]);
  header.transcripts = 99;
  ls[1] = JSON.stringify(header);
  writeLines(out, ls);
  const dst = ctxWithClaude();
  await assert.rejects(stream.importBundle({ ctx: dst, input: out }), /header says 99 transcripts/);
});

test('a transcript that vanishes between plan and write aborts the export with no partial bundle', async function () {
  const src = ctxWithClaude();
  const file = seedTranscript(src, '-p', 'gone', 'F\n');
  const plan = migrate.planExport(src, {});
  fs.rmSync(file);
  const out = path.join(src.home, 'bundle.kf');
  await assert.rejects(stream.writeBundle({ out: out, meta: plan.meta, files: plan.files }), /ENOENT|no such file/i);
  assert.strictEqual(fs.existsSync(out), false, 'no bundle was published');
  const leftovers = fs.readdirSync(src.home).filter(function (f) {
    return f.indexOf('bundle.kf') === 0;
  });
  assert.deepStrictEqual(leftovers, [], 'the temp file was removed');
});

// ---- merge semantics -------------------------------------------------------

test('import is a union by default and --force overwrites, exactly like the legacy merge', async function () {
  const src = ctxWithClaude();
  seedTranscript(src, '-p', 'shared', 'FROM-SOURCE\n');
  seedTranscript(src, '-p', 'only-source', 'S\n');
  const out = await exportPlan(src, {});

  const dst = ctxWithClaude();
  seedTranscript(dst, '-p', 'shared', 'FROM-TARGET\n');
  seedTranscript(dst, '-p', 'only-target', 'T\n');

  let res = await stream.importBundle({ ctx: dst, input: out });
  assert.strictEqual(res.transcripts.added, 1);
  assert.strictEqual(res.transcripts.kept, 1);
  assert.strictEqual(fs.readFileSync(txPath(dst, '-p', 'shared'), 'utf8'), 'FROM-TARGET\n');
  assert.strictEqual(fs.readFileSync(txPath(dst, '-p', 'only-source'), 'utf8'), 'S\n');
  assert.strictEqual(fs.readFileSync(txPath(dst, '-p', 'only-target'), 'utf8'), 'T\n');

  // Both bundle sessions exist on the target after the first (union) pass, so
  // --force rewrites both: the one that was already here and the one just added.
  res = await stream.importBundle({ ctx: dst, input: out, force: true });
  assert.strictEqual(res.transcripts.added, 0);
  assert.strictEqual(res.transcripts.overwritten, 2);
  assert.strictEqual(fs.readFileSync(txPath(dst, '-p', 'shared'), 'utf8'), 'FROM-SOURCE\n');
});

test('unsafe project/session segments are skipped and never escape ~/.claude/projects', async function () {
  const src = ctxWithClaude();
  const payload = path.join(src.home, 'payload');
  fs.writeFileSync(payload, 'PWNED\n');
  const out = path.join(src.home, 'evil.kf');
  const meta = migrate.planExport(src, {}).meta;
  await stream.writeBundle({
    out: out,
    meta: meta,
    files: [
      { project: '../../evil', sessionId: 'x', file: payload, bytes: 6 },
      { project: '-ok', sessionId: '../escape', file: payload, bytes: 6 },
      { project: '-ok', sessionId: 'good', file: payload, bytes: 6 },
    ],
  });
  const dst = ctxWithClaude();
  const res = await stream.importBundle({ ctx: dst, input: out });
  assert.strictEqual(res.transcripts.added, 1);
  assert.strictEqual(res.transcripts.skipped, 2);
  assert.ok(!fs.existsSync(path.join(dst.home, 'evil')));
  assert.ok(!fs.existsSync(path.join(dst.claudeDir, 'projects', 'escape.jsonl')));
  assert.strictEqual(fs.readFileSync(txPath(dst, '-ok', 'good'), 'utf8'), 'PWNED\n');
});

// ---- legacy compatibility --------------------------------------------------

function legacyBundle(src) {
  return migrate.buildBundle(src, {}).bundle;
}

test('a small legacy plain bundle still imports through the streaming reader', async function () {
  const src = ctxWithClaude();
  seedAccount(src, 'work', 'a@x.com', '{"token":"OLD"}');
  seedTranscript(src, '-p', 'legacy', 'L\n');
  const out = path.join(src.home, 'legacy.json');
  fs.writeFileSync(out, JSON.stringify(legacyBundle(src)));

  const dst = ctxWithClaude();
  const res = await stream.importBundle({ ctx: dst, input: out });
  assert.deepStrictEqual(res.accounts.imported, ['work']);
  assert.strictEqual(res.transcripts.added, 1);
  assert.strictEqual(fs.readFileSync(txPath(dst, '-p', 'legacy'), 'utf8'), 'L\n');
});

test('a small legacy encrypted bundle still imports with its passphrase', async function () {
  const src = ctxWithClaude();
  seedAccount(src, 'work', 'a@x.com', '{"token":"OLD"}');
  seedTranscript(src, '-p', 'legacy', 'L\n');
  const out = path.join(src.home, 'legacy.enc');
  fs.writeFileSync(out, sync.encrypt(JSON.stringify(legacyBundle(src)), 'pw'));

  const dst = ctxWithClaude();
  await assert.rejects(stream.importBundle({ ctx: dst, input: out }), /encrypted — pass --passphrase-file/);
  const res = await stream.importBundle({ ctx: dst, input: out, passphrase: 'pw' });
  assert.strictEqual(res.transcripts.added, 1);
  assert.strictEqual(dst.store.getProfile('work'), '{"token":"OLD"}');
});

test(
  'an oversized legacy file is refused before it is read into one string',
  { skip: process.platform === 'win32' },
  async function () {
    const src = ctxWithClaude();
    const out = path.join(src.home, 'huge.json');
    const fd = fs.openSync(out, 'w');
    try {
      fs.ftruncateSync(fd, stream.LEGACY_MAX + 1); // sparse: costs no real disk
    } finally {
      fs.closeSync(fd);
    }
    const dst = ctxWithClaude();
    await assert.rejects(stream.importBundle({ ctx: dst, input: out }), /would be parsed as one string/);
  },
);

test('a directory is refused with a clear message, not EISDIR', async function () {
  const src = ctxWithClaude();
  await assert.rejects(stream.importBundle({ ctx: src, input: src.home }), /is a directory/);
});

// ---- line reader -----------------------------------------------------------

test('linesOf survives CRLF split across chunks, multibyte splits, and enforces maxLine', async function () {
  const chunks = [
    Buffer.from('ab\r'),
    Buffer.from('\ncd'),
    Buffer.from([0xc3]), // first byte of é
    Buffer.from([0xa9]),
    Buffer.from('\n'),
  ];
  const got = [];
  for await (const line of stream.linesOf(Readable.from(chunks), 1024)) got.push(line);
  assert.deepStrictEqual(got, ['ab', 'cdé']);

  await assert.rejects(async function () {
    for await (const line of stream.linesOf(Readable.from([Buffer.from('x'.repeat(20))]), 8)) void line;
  }, /legacy one-string format/);
});
