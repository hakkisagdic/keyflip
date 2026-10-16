// #35 THREADS — keyflip's own pointer store: one name for the sessions/chats that are the same task,
// spread over accounts. These tests are the contract for the parts that could hurt:
//   • a thread file is a FILENAME the user typed — it can never escape threads/;
//   • pointers are versioned, the mirrored PROSE is not (secretpaths is the only thing standing
//     between a merged transcript and `keyflip migrate`);
//   • a corrupt or hand-edited file is REPORTED, never silently treated as empty;
//   • reads are streamed and capped, because real transcripts here run to 24 MB.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as threads from '../src/threads.js';
import * as sessions from '../src/sessions.js';
import * as sessionmap from '../src/sessionmap.js';
import * as profiles from '../src/profiles.js';
import * as secretpaths from '../src/secretpaths.js';
import * as config from '../src/config.js';
import * as backup from '../src/backup.js';
import * as migrate from '../src/migrate.js';
import * as transfer from '../src/transfer.js';
import { makeCtx, assertPrivateMode } from './helpers.js';

const ID_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const ID_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const ID_C = 'cccccccc-3333-4333-8333-333333333333';
const CHAT_1 = 'dddddddd-4444-4444-8444-444444444444';

// A transcript the way Claude Code writes one: one JSON record per line, the cwd on the first turn.
function seed(ctx, project, id, cwd, turns, mtimeMs) {
  const dir = path.join(ctx.home, '.claude', 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.jsonl');
  const lines = turns.map(function (t, i) {
    return JSON.stringify({
      type: t.role,
      sessionId: id,
      cwd: i === 0 ? cwd : undefined,
      timestamp: t.ts,
      message: {
        role: t.role,
        content:
          t.role === 'assistant'
            ? [
                { type: 'text', text: t.text },
                { type: 'tool_use', name: t.tool || 'Read' },
              ]
            : [{ type: 'text', text: t.text }],
      },
    });
  });
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  if (mtimeMs) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

// Two accounts, one task split between them, plus an unrelated session.
function splitWorkspace(ctx) {
  profiles.write(ctx.configDir, { name: 'gmail', email: 'g@example.com' });
  profiles.write(ctx.configDir, { name: 'yahoo', email: 'y@example.com' });
  seed(ctx, '-proj-work', ID_A, '/proj/work', [
    { role: 'user', text: 'design the session store', ts: '2026-10-14T09:00:00.000Z' },
    { role: 'assistant', text: 'pointers, never copies', ts: '2026-10-14T09:05:00.000Z' },
  ]);
  seed(ctx, '-proj-work', ID_B, '/proj/work', [
    { role: 'user', text: 'quota ran out, continue on yahoo', ts: '2026-10-14T11:00:00.000Z' },
    { role: 'assistant', text: 'continuing the threads design', ts: '2026-10-14T11:02:00.000Z' },
  ]);
  seed(ctx, '-proj-other', ID_C, '/proj/other', [
    { role: 'user', text: 'unrelated work', ts: '2026-10-13T08:00:00.000Z' },
  ]);
  sessionmap.set(ctx, ID_A, 'gmail');
  sessionmap.set(ctx, ID_B, 'yahoo');
}

// ---- names are filenames ------------------------------------------------------

test('slugify folds Turkish and accented titles instead of mangling them', function () {
  // A naive [^a-z0-9] fold renders "düğüm" as "d-g-m" — the word is gone. NFD + diacritic strip keeps it.
  assert.strictEqual(threads.slugify('Düğüm Açmak'), 'dugum-acmak');
  assert.strictEqual(threads.slugify('İki Hesap Arasında'), 'iki-hesap-arasinda');
  assert.strictEqual(threads.slugify('café — résumé'), 'cafe-resume');
  assert.strictEqual(threads.slugify('x'.repeat(90)).length, 48, 'a slug is capped, not unlimited');
});

test('a thread name cannot escape threads/ — traversal is folded away, an empty result is refused', function () {
  const ctx = makeCtx();
  const escaped = threads.fileFor(ctx, '../../keys');
  assert.strictEqual(path.basename(escaped), 'keys.json');
  assert.strictEqual(path.dirname(escaped), threads.dir(ctx), 'still inside threads/');
  const mirror = threads.mirrorFileFor(ctx, '../secrets/x');
  assert.strictEqual(path.basename(mirror), 'secrets-x.md', 'the path separator folds into the name');
  assert.strictEqual(path.dirname(mirror), threads.mirrorDir(ctx), 'and stays inside thread-mirror/');
  assert.throws(function () {
    threads.fileFor(ctx, '...');
  }, /invalid thread name/);
  assert.throws(function () {
    threads.fileFor(ctx, '***');
  }, /invalid thread name/);
});

// ---- the store itself ---------------------------------------------------------

test('create → read → list round-trips a thread, and the file is 0600', function () {
  const ctx = makeCtx();
  const t = threads.create(ctx, { slug: 'logan-sync', title: 'LogAnalyzer sync', notes: 'quota split' });
  assert.strictEqual(t.slug, 'logan-sync');
  assert.strictEqual(threads.dir(ctx).indexOf(ctx.configDir), 0);
  assertPrivateMode(threads.fileFor(ctx, 'logan-sync'));
  const back = threads.read(ctx, 'logan-sync');
  assert.strictEqual(back.title, 'LogAnalyzer sync');
  assert.strictEqual(back.notes, 'quota split');
  assert.deepStrictEqual(
    threads.list(ctx).map(function (r) {
      return r.slug;
    }),
    ['logan-sync'],
  );
  // a title alone is enough — the slug is folded from it
  const byTitle = threads.create(ctx, { title: 'Düğüm tasarımı' });
  assert.strictEqual(byTitle.slug, 'dugum-tasarimi');
  assert.throws(
    function () {
      threads.create(ctx, { slug: 'logan-sync' });
    },
    /already exists/,
    'an existing name is never silently overwritten',
  );
  assert.throws(function () {
    threads.create(ctx, {});
  }, /needs a name/);
});

test('read accepts a unique slug prefix or a title, and refuses to guess an ambiguous one', function () {
  const ctx = makeCtx();
  threads.create(ctx, { slug: 'keyflip-threads', title: 'Threads feature' });
  threads.create(ctx, { slug: 'keyflip-vcs', title: 'Versioning' });
  assert.strictEqual(threads.read(ctx, 'keyflip-vcs').slug, 'keyflip-vcs');
  assert.strictEqual(threads.read(ctx, 'keyflip-v').slug, 'keyflip-vcs', 'a unique PREFIX works');
  assert.strictEqual(threads.read(ctx, 'Threads feature').slug, 'keyflip-threads', 'a title works');
  assert.throws(
    function () {
      threads.read(ctx, 'keyflip');
    },
    /several threads/,
    'an ambiguous prefix is an error, never a coin flip',
  );
  assert.strictEqual(threads.read(ctx, 'nope'), null);
});

test('a corrupt thread file is reported by list and blocks a write by read', function () {
  const ctx = makeCtx();
  fs.mkdirSync(threads.dir(ctx), { recursive: true });
  fs.writeFileSync(path.join(threads.dir(ctx), 'broken.json'), '{ not json', { mode: 0o600 });
  const rows = threads.list(ctx);
  assert.strictEqual(rows.length, 1, 'list never hides a thread the user cannot otherwise discover');
  assert.strictEqual(rows[0].corrupt, true);
  assert.match(rows[0].error, /not valid JSON/);
  assert.throws(
    function () {
      threads.read(ctx, 'broken');
    },
    /not valid JSON/,
    'damage must not be mistaken for emptiness before writing',
  );
  assert.deepStrictEqual(threads.stats(ctx).corrupt, ['broken']);
});

test('a hand-edited member is dropped but COUNTED, and never written back', function () {
  const ctx = makeCtx();
  fs.mkdirSync(threads.dir(ctx), { recursive: true });
  fs.writeFileSync(
    path.join(threads.dir(ctx), 'mixed.json'),
    JSON.stringify({
      slug: 'mixed',
      members: [
        { kind: 'session', id: ID_A },
        { kind: 'wat', id: ID_B }, // unknown kind
        { kind: 'session', id: '../outside' }, // id that could become a path
        { kind: 'session', id: ID_A }, // a duplicate pointer
      ],
      bogusTopKey: 'should not survive a save',
    }),
  );
  const row = threads.list(ctx)[0];
  assert.strictEqual(row.members.length, 1, 'only the pointer keyflip can vouch for');
  assert.strictEqual(row.droppedMembers, 3, 'the damage is counted, not silent');
  const saved = threads.update(ctx, 'mixed', { title: 'renamed' });
  assert.deepStrictEqual(saved.members.length, 1);
  assert.strictEqual(saved.bogusTopKey, undefined, 'a key normalize did not vouch for is not persisted');
  const onDisk = JSON.parse(fs.readFileSync(threads.fileFor(ctx, 'mixed'), 'utf8'));
  assert.strictEqual(onDisk.droppedMembers, undefined, 'derived damage is never frozen into the file');
  assert.strictEqual(onDisk.bogusTopKey, undefined);
});

// ---- members: idempotent add, exact remove, name-only drop --------------------

test('addMember is idempotent: re-adding refreshes the label, keeps addedAt, never doubles', function () {
  const ctx = makeCtx();
  splitWorkspace(ctx);
  threads.create(ctx, { slug: 'design' });
  const first = threads.addMember(ctx, 'design', { kind: 'session', id: ID_A });
  assert.strictEqual(first.members.length, 1);
  const addedAt = first.members[0].addedAt;
  const again = threads.addMember(ctx, 'design', { kind: 'session', id: ID_A, label: 'renamed label' });
  assert.strictEqual(again.members.length, 1, 'the same pointer twice is still one pointer');
  assert.strictEqual(again.members[0].addedAt, addedAt, 'the original add time survives a refresh');
  assert.strictEqual(again.members[0].label, 'renamed label');
  assert.throws(
    function () {
      threads.addMember(ctx, 'design', { kind: 'session', id: 'not an id!' });
    },
    /valid session id|member/,
    'a malformed member is refused, not stored',
  );
});

test('removeMember matches kind:id, a full id or a unique prefix — and never touches the transcript', function () {
  const ctx = makeCtx();
  splitWorkspace(ctx);
  threads.create(ctx, { slug: 'design' });
  threads.addMember(ctx, 'design', { kind: 'session', id: ID_A });
  threads.addMember(ctx, 'design', { kind: 'chat', id: CHAT_1, account: 'yahoo' });
  const r = threads.removeMember(ctx, 'design', 'chat:' + CHAT_1.slice(0, 8));
  assert.strictEqual(r.removed.kind, 'chat');
  assert.strictEqual(threads.read(ctx, 'design').members.length, 1);
  assert.strictEqual(threads.removeMember(ctx, 'design', 'nothing'), null, 'a miss is a null, not a crash');
  // an id shared by two members of DIFFERENT kinds must be disambiguated by the caller
  threads.addMember(ctx, 'design', { kind: 'chat', id: 'aaaaaaaa-1111-4111-8111-111111111111' });
  assert.throws(function () {
    threads.removeMember(ctx, 'design', 'aaaaaaaa');
  }, /several members/);
  assert.ok(
    fs.existsSync(path.join(ctx.home, '.claude', 'projects', '-proj-work', ID_A + '.jsonl')),
    'the conversation is intact',
  );
});

test('drop deletes the NAME; the transcript and the account assignment stay', function () {
  const ctx = makeCtx();
  splitWorkspace(ctx);
  threads.create(ctx, { slug: 'design', member: { kind: 'session', id: ID_A } });
  const dropped = threads.drop(ctx, 'design');
  assert.strictEqual(dropped.slug, 'design');
  assert.strictEqual(fs.existsSync(threads.fileFor(ctx, 'design')), false);
  assert.ok(fs.existsSync(path.join(ctx.home, '.claude', 'projects', '-proj-work', ID_A + '.jsonl')));
  assert.strictEqual(sessionmap.get(ctx, ID_A), 'gmail', 'a thread is not the owner of the assignment');
});

test('a thread stores POINTERS — never conversation prose, even when the first prompt is a pasted key', function () {
  const ctx = makeCtx();
  splitWorkspace(ctx);
  const secretId = 'dddddddd-5555-4555-8555-555555555555';
  seed(ctx, '-proj-secret', secretId, '/proj/secret', [
    { role: 'user', text: 'here is my token sk-ant-secretsupersecret', ts: '2026-10-14T12:00:00.000Z' },
  ]);
  const t = threads.create(ctx, { slug: 'with-secret', member: { kind: 'session', id: secretId } });
  threads.addMember(ctx, 'with-secret', { kind: 'session', id: ID_A });
  const onDisk = fs.readFileSync(threads.fileFor(ctx, 'with-secret'), 'utf8');
  assert.strictEqual(onDisk.indexOf('sk-ant-secretsupersecret'), -1, 'a transcript never rides into the pointer file');
  assert.strictEqual(onDisk.indexOf('here is my token'), -1);
  assert.ok(
    t.members.every(function (m) {
      return !m.label;
    }),
    'and no label is auto-copied from a transcript — the preview is read live by expand()',
  );
  // The display still has the preview, so nothing is lost by refusing to store it.
  const exp = threads.expand(ctx, threads.read(ctx, 'with-secret'));
  assert.match(exp.rows[0].preview || exp.rows[1].preview, /token/);
  // A label the USER typed is their own words and is kept.
  threads.addMember(ctx, 'with-secret', { kind: 'session', id: ID_A, label: 'the auth refactor' });
  assert.strictEqual(
    threads.read(ctx, 'with-secret').members.find(function (m) {
      return m.id === ID_A;
    }).label,
    'the auth refactor',
  );
});

// ---- resolving pointers -------------------------------------------------------

test('index skips a .keyflip-bak rollback copy so a session is not double-counted', function () {
  const ctx = makeCtx();
  seed(ctx, '-proj-work', ID_A, '/proj/work', [{ role: 'user', text: 'live', ts: '2026-10-14T09:00:00.000Z' }]);
  seed(ctx, '-proj-work.keyflip-bak', ID_A, '/proj/work', [
    { role: 'user', text: 'backup', ts: '2026-10-01T09:00:00.000Z' },
  ]);
  const idx = threads.index(ctx);
  assert.strictEqual(idx.size, 1);
  assert.strictEqual(idx.get(ID_A).project, '-proj-work', 'the live key wins');
});

test('resolveSessionId expands a unique prefix, refuses a shared one, keeps a foreign id', function () {
  const ctx = makeCtx();
  splitWorkspace(ctx);
  const idx = threads.index(ctx);
  const exact = threads.resolveSessionId(ctx, ID_A, idx);
  assert.strictEqual(exact.id, ID_A);
  assert.strictEqual(exact.matched.project, '-proj-work');
  const prefix = threads.resolveSessionId(ctx, ID_B.slice(0, 8), idx);
  assert.strictEqual(prefix.id, ID_B, 'the thread must store the FULL id — a fuzzy pointer cannot be followed later');
  assert.strictEqual(prefix.original, ID_B.slice(0, 8));
  assert.strictEqual(prefix.matched.project, '-proj-work');
  // 'c' is a prefix of only ID_C; 'cc' also only ID_C — build a real collision instead.
  seed(ctx, '-proj-collide', 'cccc0001-1111-4111-8111-111111111111', '/proj/collide', [
    { role: 'user', text: 'x', ts: '2026-10-14T09:00:00.000Z' },
  ]);
  seed(ctx, '-proj-collide', 'cccc0002-1111-4111-8111-111111111111', '/proj/collide', [
    { role: 'user', text: 'y', ts: '2026-10-14T09:00:00.000Z' },
  ]);
  const clash = threads.resolveSessionId(ctx, 'cccc000', threads.index(ctx));
  assert.strictEqual(clash.matched, null);
  assert.strictEqual(clash.ambiguous.length, 2, 'which session a thread means is the user’s call, not keyflip’s');
  const foreign = threads.resolveSessionId(ctx, 'eeeeeeee-9999-4999-8999-999999999999', idx);
  assert.strictEqual(foreign.unknown, true);
  assert.strictEqual(
    foreign.id,
    'eeeeeeee-9999-4999-8999-999999999999',
    'work on another machine is still work — keep the pointer',
  );
});

test('accountOf reads the live map: a re-assignment beats the label stored at add time', function () {
  const ctx = makeCtx();
  splitWorkspace(ctx);
  const t = threads.create(ctx, { slug: 'design', member: { kind: 'session', id: ID_A, account: 'yahoo' } });
  assert.strictEqual(threads.accountOf(ctx, t.members[0], threads.assignments(ctx)), 'gmail');
  sessionmap.set(ctx, ID_A, 'second');
  assert.strictEqual(
    threads.accountOf(ctx, t.members[0], threads.assignments(ctx)),
    'second',
    'the map is re-read, not cached in the thread',
  );
  // A chat has no local transcript to ask: its stored account is the only answer.
  const chat = { kind: 'chat', id: CHAT_1 };
  assert.strictEqual(threads.accountOf(ctx, chat, new Map()), null);
  assert.strictEqual(threads.accountOf(ctx, { kind: 'chat', id: CHAT_1, account: 'yahoo' }, new Map()), 'yahoo');
});

test('expand reports a pointer that resolves to NOTHING instead of hiding it', function () {
  const ctx = makeCtx();
  splitWorkspace(ctx);
  const t = threads.create(ctx, { slug: 'design' });
  threads.addMember(ctx, 'design', { kind: 'session', id: ID_A });
  threads.addMember(ctx, 'design', {
    kind: 'session',
    id: 'eeeeeeee-9999-4999-8999-999999999999',
    project: '-proj-gone',
  });
  threads.addMember(ctx, 'design', { kind: 'chat', id: CHAT_1, account: 'yahoo' });
  const exp = threads.expand(ctx, threads.read(ctx, 'design'));
  assert.strictEqual(exp.rows.length, 3);
  assert.strictEqual(exp.missing, 2, 'one foreign session + one server-side chat');
  const live = exp.rows.filter(function (r) {
    return r.resolved;
  });
  assert.strictEqual(live.length, 1);
  assert.strictEqual(live[0].cwd, '/proj/work', 'the transcript’s own cwd, not the lossy dir name');
  assert.match(live[0].resume.command, /claude/);
  assert.strictEqual(live[0].account, 'gmail');
  const foreign = exp.rows.find(function (r) {
    return r.id.indexOf('eeeeeeee') === 0;
  });
  assert.match(foreign.reason, /no transcript on this machine/);
  assert.match(foreign.reason, /last seen in -proj-gone/);
  const chat = exp.rows.find(function (r) {
    return r.kind === 'chat';
  });
  assert.match(chat.reason, /keyflip chat get/);
  assert.deepStrictEqual(exp.accounts, { gmail: 1, unassigned: 1, yahoo: 1 });
});

test('newest picks the most recently written member — that is where the work stopped', function () {
  const ctx = makeCtx();
  splitWorkspace(ctx);
  fs.utimesSync(
    path.join(ctx.home, '.claude', 'projects', '-proj-work', ID_A + '.jsonl'),
    new Date(500),
    new Date(500),
  );
  fs.utimesSync(
    path.join(ctx.home, '.claude', 'projects', '-proj-work', ID_B + '.jsonl'),
    new Date(900),
    new Date(900),
  );
  const t = threads.create(ctx, { slug: 'design' });
  threads.addMember(ctx, 'design', { kind: 'session', id: ID_A });
  threads.addMember(ctx, 'design', { kind: 'session', id: ID_B });
  threads.addMember(ctx, 'design', { kind: 'chat', id: CHAT_1, account: 'yahoo' });
  assert.strictEqual(
    threads.newest(threads.expand(ctx, threads.read(ctx, 'design')).rows).id,
    ID_B,
    'a chat cannot be "where work stopped"',
  );
  assert.strictEqual(threads.newest([{ kind: 'session', id: ID_A, resolved: false }]), null);
});

// ---- the merged conversation --------------------------------------------------

test('timeline merges members chronologically and keeps undated turns as a front group', function () {
  const ctx = makeCtx();
  splitWorkspace(ctx);
  seed(ctx, '-proj-undated', 'ffffffff-6666-4666-8666-666666666666', '/proj/undated', [
    { role: 'user', text: 'no timestamp at all' },
  ]);
  const t = threads.create(ctx, { slug: 'design' });
  threads.addMember(ctx, 'design', { kind: 'session', id: ID_B }); // 11:00, 11:02
  threads.addMember(ctx, 'design', { kind: 'session', id: ID_A }); // 09:00, 09:05
  threads.addMember(ctx, 'design', { kind: 'session', id: 'ffffffff-6666-4666-8666-666666666666' });
  const tl = threads.timeline(ctx, threads.read(ctx, 'design'));
  assert.strictEqual(tl.messages.length, 5);
  assert.strictEqual(tl.messages[0].ts, null, 'undated preamble sorts FIRST, never smuggled between decisions');
  assert.strictEqual(tl.messages[1].ts, '2026-10-14T09:00:00.000Z');
  assert.strictEqual(tl.messages[tl.messages.length - 1].from.id, ID_B);
  assert.strictEqual(tl.sources, 3);
  // The undated session was never assigned, and timeline says so instead of inventing an account —
  // that unassigned bucket is exactly what `threads list` warns about.
  assert.deepStrictEqual(Object.keys(tl.accounts).sort(), ['gmail', 'unassigned', 'yahoo']);
  assert.strictEqual(tl.accounts.unassigned, 1);
});

test('a cloud chat contributes NO turns offline — it lands in unavailable with the command that would', function () {
  const ctx = makeCtx();
  splitWorkspace(ctx);
  const t = threads.create(ctx, { slug: 'design', member: { kind: 'chat', id: CHAT_1, account: 'yahoo' } });
  threads.addMember(ctx, 'design', { kind: 'session', id: ID_A });
  const tl = threads.timeline(ctx, threads.read(ctx, t.slug));
  assert.strictEqual(tl.unavailable.length, 1);
  assert.match(tl.unavailable[0].reason, /keyflip chat get/);
  assert.strictEqual(tl.messages.length, 2, 'only the local session spoke');
  assert.strictEqual(tl.sources, 1);
});

test('caps say so out loud: maxTotal drops the OLDEST end, a byte cap marks the member', function () {
  const ctx = makeCtx();
  splitWorkspace(ctx);
  threads.create(ctx, { slug: 'design' });
  threads.addMember(ctx, 'design', { kind: 'session', id: ID_A });
  threads.addMember(ctx, 'design', { kind: 'session', id: ID_B });
  const design = () => threads.read(ctx, 'design');
  const capped = threads.timeline(ctx, design(), { maxTotal: 3 });
  assert.strictEqual(capped.messages.length, 3);
  assert.strictEqual(capped.droppedFromStart, 1, 'the recent tail is what continuing the work needs');
  assert.strictEqual(capped.messages[capped.messages.length - 1].ts, '2026-10-14T11:02:00.000Z');
  // A real transcript here is 24 MB and a thread merges several, so reads stream and stop — reporting
  // the stop rather than ending politely.
  const big = 'gggggggg-7777-4777-8777-777777777777';
  const many = [];
  for (let i = 0; i < 400; i++)
    many.push({
      role: i % 2 ? 'assistant' : 'user',
      text: 'line ' + i + ' ' + 'z'.repeat(2000),
      ts: '2026-10-14T1' + (i % 6) + ':00:00.000Z',
    });
  seed(ctx, '-proj-big', big, '/proj/big', many);
  threads.addMember(ctx, 'design', { kind: 'session', id: big });
  const byBytes = threads.timeline(ctx, design(), { maxBytes: 64 * 1024 });
  assert.ok(byBytes.cappedMembers >= 1, 'a transcript that hit the byte cap is COUNTED as capped');
  const byTurns = threads.timeline(ctx, design(), { maxMessages: 3 });
  assert.ok(byTurns.cappedMembers >= 1, 'and so is one that hit the turn cap');
});

test('threads.mergeMaxMiB wires the config key into the merge cap', function () {
  const ctx = makeCtx();
  splitWorkspace(ctx);
  assert.strictEqual(config.get(ctx, 'threads.mergeMaxMiB'), 8, 'default 8 MiB per member');
  config.set(ctx, 'threads.mergeMaxMiB', 1);
  const big = 'hhhhhhhh-8888-4888-8888-888888888888';
  const many = [];
  for (let i = 0; i < 600; i++)
    many.push({ role: 'user', text: 'pad ' + 'p'.repeat(4000), ts: '2026-10-14T09:0' + (i % 6) + ':00.000Z' });
  seed(ctx, '-proj-huge', big, '/proj/huge', many);
  const t = threads.create(ctx, { slug: 'design', member: { kind: 'session', id: big } });
  const tl = threads.timeline(ctx, t);
  assert.strictEqual(tl.cappedMembers, 1, '1 MiB configured really becomes the read cap');
  config.set(ctx, 'threads.mergeMaxMiB', 512);
  assert.strictEqual(threads.timeline(ctx, t).cappedMembers, 0, 'a raised cap reads the whole transcript');
});

test('toMarkdown shows the account switch INSIDE the conversation, with a resume command per member', function () {
  const ctx = makeCtx();
  splitWorkspace(ctx);
  threads.create(ctx, { slug: 'design', title: 'Threads design', notes: 'one name, two accounts' });
  threads.addMember(ctx, 'design', { kind: 'session', id: ID_A });
  threads.addMember(ctx, 'design', { kind: 'session', id: ID_B });
  threads.addMember(ctx, 'design', { kind: 'chat', id: CHAT_1, account: 'yahoo' });
  // Read it back: a thread is the FILE, and a stale in-memory copy would document the wrong thing.
  const md = threads.toMarkdown(ctx, threads.read(ctx, 'design'));
  assert.ok(md.startsWith('# Thread `design`'));
  assert.match(md, /## Members/);
  assert.ok(
    md.indexOf('`cd /proj/work && claude --resume ' + ID_A + '`') !== -1,
    'a resume line carries the FULL id and the real cwd, not the 8-char label shown above it',
  );
  assert.match(md, /server-side conversation/);
  assert.match(md, /↪ from gmail · session/);
  assert.match(md, /↪ from yahoo · session/);
  assert.ok(md.indexOf('↪ from gmail') < md.indexOf('↪ from yahoo'), 'the provenance dividers follow the merged order');
  assert.match(md, /Merged by keyflip from 2 transcript\(s\)\. Read-only; nothing uploaded\./);
  assert.strictEqual(md.indexOf('sk-ant'), -1);
});

// ---- finding the splits -------------------------------------------------------

test('candidates needs TWO NAMED accounts in one folder, and shrinks as work gets named', function () {
  const ctx = makeCtx();
  splitWorkspace(ctx);
  let c = threads.candidates(ctx, {});
  assert.strictEqual(c.length, 1, '-proj-work is gmail + yahoo');
  assert.strictEqual(c[0].project, '-proj-work');
  assert.deepStrictEqual(c[0].accounts, ['gmail', 'yahoo']);
  assert.strictEqual(c[0].sessions, 2, 'sessions COUNTS every session in the split folder');
  assert.strictEqual(c[0].unthreaded, 2);
  assert.strictEqual(c[0].open.length, 2, 'and open lists the ones no thread names yet');
  // The suggested slug is the working directory's own name — what the user sees in their shell, not
  // Claude's encoded folder with its leading dash.
  assert.strictEqual(c[0].suggestedSlug, 'work');
  assert.strictEqual(c[0].cwd, '/proj/work');
  // One account + unassigned sessions is not fragmentation, it is an account nobody assigned.
  sessionmap.unset(ctx, ID_B);
  assert.deepStrictEqual(threads.candidates(ctx, {}), [], 'one named account is not a split');
  sessionmap.set(ctx, ID_B, 'yahoo');
  // Naming the work takes it off the list.
  threads.create(ctx, { slug: 'design' });
  threads.addMember(ctx, 'design', { kind: 'session', id: ID_A });
  c = threads.candidates(ctx, {});
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].sessions, 2, 'the folder still holds two accounts of work');
  assert.strictEqual(c[0].unthreaded, 1, 'the threaded session dropped out, the unthreaded one is still open');
  assert.strictEqual(c[0].open.length, 1);
  threads.addMember(ctx, 'design', { kind: 'session', id: ID_B });
  assert.deepStrictEqual(threads.candidates(ctx, {}), [], 'fully named work stops being a suggestion');
  // ID_C lives alone in -proj-other with one account — never a candidate.
  sessionmap.set(ctx, ID_C, 'gmail');
  assert.deepStrictEqual(threads.candidates(ctx, {}).length, 0);
});

// ---- the opt-in mirror --------------------------------------------------------

test('the mirror dir is a registered secret dir and the pointer dir is NOT', function () {
  // If this link breaks, every merged transcript silently enters the repo `keyflip migrate` carries
  // between machines — so it is asserted, not assumed.
  assert.ok(secretpaths.SECRET_DIRS.indexOf(threads.MIRROR_DIR_NAME) !== -1, 'thread-mirror/ is secret');
  assert.strictEqual(secretpaths.SECRET_DIRS.indexOf(threads.DIR_NAME), -1, 'threads/ must stay versionable');
  const lines = secretpaths.gitignoreLines();
  assert.ok(lines.indexOf('thread-mirror/') !== -1, 'the mirror is git-ignored by name');
  assert.strictEqual(
    lines.filter(function (l) {
      return l === 'threads/' || l === 'threads/*.json';
    }).length,
    0,
    'and no rule may swallow the pointers',
  );
});

test('mirror needs BOTH gates: the config flag and the explicit call', function () {
  const ctx = makeCtx();
  splitWorkspace(ctx);
  const t = threads.create(ctx, { slug: 'design', member: { kind: 'session', id: ID_A } });
  assert.strictEqual(threads.mirrorEnabled(ctx), false);
  const off = threads.mirror(ctx, t);
  assert.strictEqual(off.ok, false);
  assert.strictEqual(off.reason, 'disabled');
  assert.match(off.fix, /config set threads\.mirror true/);
  assert.strictEqual(fs.existsSync(threads.mirrorFileFor(ctx, 'design')), false, 'a refused mirror writes nothing');
  config.set(ctx, 'threads.mirror', true);
  assert.strictEqual(threads.mirrorEnabled(ctx), true);
  const on = threads.mirror(ctx, t);
  assert.strictEqual(on.ok, true);
  assertPrivateMode(threads.mirrorFileFor(ctx, 'design'));
  assert.match(fs.readFileSync(on.path, 'utf8'), /# Thread `design`/);
  const r = threads.unmirror(ctx, t);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.existed, true);
  assert.strictEqual(fs.existsSync(threads.mirrorFileFor(ctx, 'design')), false);
  assert.strictEqual(threads.unmirror(ctx, t).existed, false, 'removing what is not there is not an error');
  assert.ok(fs.existsSync(threads.fileFor(ctx, 'design')), 'unmirror deletes TEXT, not the thread');
});

test('stats reports what exists without reading a single transcript', function () {
  const ctx = makeCtx();
  splitWorkspace(ctx);
  const a = threads.create(ctx, { slug: 'design' });
  threads.addMember(ctx, 'design', { kind: 'session', id: ID_A });
  threads.addMember(ctx, 'design', { kind: 'session', id: ID_B });
  const b = threads.create(ctx, { slug: 'loose', member: { kind: 'session', id: ID_C } });
  assert.ok(a && b);
  const st = threads.stats(ctx);
  assert.strictEqual(st.threads, 2);
  assert.strictEqual(st.members, 3);
  assert.strictEqual(st.sessions, 3);
  assert.strictEqual(st.chats, 0);
  assert.deepStrictEqual(st.spanning, ['design']);
  assert.strictEqual(st.noAccount, 1, 'ID_C is not assigned anywhere');
  assert.deepStrictEqual(st.noAccountSlugs, ['loose']);
  assert.strictEqual(st.mirrorEnabled, false);
  assert.strictEqual(st.mirrorFiles, 0);
  threads.mirror(ctx, threads.read(ctx, 'design'), {}); // off → no file
  assert.strictEqual(threads.stats(ctx).mirrorFiles, 0);
});

// ---- no carrier takes the prose ----------------------------------------------

test('a mirrored thread travels in no backup, no migrate bundle and no sync envelope', function () {
  // The docs promise this three ways — never backed up, never synced, `migrate` does not carry it — and
  // each is a DIFFERENT code path: backup's SECRET_DIRS skip, migrate's curated bundle, sync's
  // account-only envelope. Checking one would leave two claims unchecked, so all three are read back.
  // The probe strings are mirror-only (`# Thread` + the provenance line): a transcript turn legitimately
  // does travel in a migrate bundle, so searching for the prose itself would prove nothing.
  const ctx = makeCtx();
  splitWorkspace(ctx);
  threads.create(ctx, { slug: 'design' });
  threads.addMember(ctx, 'design', { kind: 'session', id: ID_A });
  config.set(ctx, 'threads.mirror', true);
  const mirrored = threads.mirror(ctx, threads.read(ctx, 'design'));
  assert.strictEqual(mirrored.ok, true);
  const doc = fs.readFileSync(mirrored.path, 'utf8');
  assert.match(doc, /# Thread `design`/);
  const probes = ['# Thread `design`', '↪ from gmail', '↪ from yahoo'];

  // 1. `keyflip backup` walks the config dir and skips SECRET_DIRS — the pointers survive, the text does not.
  const bk = backup.create(ctx);
  const walked = [];
  (function visit(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return visit(p);
      walked.push(path.relative(bk.path, p));
      if (path.extname(e.name) === '.json' || path.extname(e.name) === '.md') {
        probes.forEach(function (s) {
          assert.strictEqual(fs.readFileSync(p, 'utf8').indexOf(s), -1, p + ' must not hold ' + s);
        });
      }
    });
  })(bk.path);
  assert.ok(
    walked.some(function (f) {
      return f === path.join('threads', 'design.json');
    }),
    'the pointer file IS backed up — it is versionable state, not prose',
  );
  assert.strictEqual(
    walked.some(function (f) {
      return f.indexOf('thread-mirror') !== -1;
    }),
    false,
    'the mirror dir never enters a backup',
  );

  // 2. `keyflip migrate` builds a CURATED bundle (accounts, transcripts, providers, memory, five named
  // config files) — it never walks the config dir, so nothing under thread-mirror/ can ride along.
  ctx.claudeDir = path.join(ctx.home, '.claude'); // migrate reads the transcript root off ctx
  const bundleObj = migrate.buildBundle(ctx, {}).bundle;
  const bundle = JSON.stringify(bundleObj);
  probes.forEach(function (s) {
    assert.strictEqual(bundle.indexOf(s), -1, 'a migrate bundle must not carry mirror prose (' + s + ')');
  });
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(bundleObj, 'threads'),
    false,
    'nor the thread POINTERS — the bundle is a curated shape, so a thread stays on the machine that named it',
  );

  // 3. `keyflip sync push` sends only the account envelope.
  const envelope = JSON.stringify(transfer.buildExport(ctx).envelope);
  probes.forEach(function (s) {
    assert.strictEqual(envelope.indexOf(s), -1, 'a sync payload must not carry mirror prose');
  });
});
