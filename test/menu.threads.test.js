// #42 — the interactive menu's THREADS screen. The menu is what performs an account switch, and a switch
// is what fragments a named task across two accounts' sessions, so the screen that shows the fragmentation
// has to live where the switch happens. What these tests own is that it is READ-ONLY: it prints the
// command that would change a thread, it never runs one.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { PassThrough } from 'stream';
import * as menu from '../src/menu.js';
import * as threads from '../src/threads.js';
import * as sessionmap from '../src/sessionmap.js';
import * as profiles from '../src/profiles.js';
import { makeCtx } from './helpers.js';

const ID_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const ID_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const CHAT_1 = 'dddddddd-4444-4444-8444-444444444444';

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
      message: { role: t.role, content: [{ type: 'text', text: t.text }] },
    });
  });
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  if (mtimeMs) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

// Two named accounts, one task split between them.
function workspace(ctx) {
  profiles.write(ctx.configDir, { name: 'gmail', email: 'g@example.com' });
  profiles.write(ctx.configDir, { name: 'yahoo', email: 'y@example.com' });
  seed(ctx, '-proj-work', ID_A, '/proj/work', [
    { role: 'user', text: 'design the session store', ts: '2026-10-14T09:00:00.000Z' },
  ]);
  seed(ctx, '-proj-work', ID_B, '/proj/work', [
    { role: 'user', text: 'quota ran out, continue on yahoo', ts: '2026-10-14T11:00:00.000Z' },
  ]);
  sessionmap.set(ctx, ID_A, 'gmail');
  sessionmap.set(ctx, ID_B, 'yahoo');
}

function tick(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms || 5);
  });
}

// LINE mode (piped stdin). Every answer goes in ONE chunk and stdin is then closed — that is the shape a
// script or a pipe produces, and the menu has to keep the later answers (see queueFor in src/menu.js).
// EOF is the menu's documented "cancelled" path, so a wrong answer count fails an assertion instead of
// hanging the runner.
async function drive(ctx, answers) {
  const input = new PassThrough();
  let out = '';
  const io = {
    input: input,
    out: {
      write: function (s) {
        out += s;
        return true;
      },
    },
  };
  const done = menu.runMenuLine(ctx, io);
  input.write(answers.join('\n') + '\n');
  input.end();
  await done;
  return out;
}

// Keys mode: `{key}` is a raw keypress on the account list, `{line}` answers the sub-prompt that
// [t]/[a]/[d] open with (lineAction hands a real readline to the screen, so it reads stdin lines).
async function keysDrive(ctx, steps) {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = function () {
    return input;
  };
  let out = '';
  const output = {
    write: function (s) {
      out += s;
      return true;
    },
  };
  const done = menu.runMenuKeys(ctx, { input: input, output: output });
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    await tick();
    // Order matters: a sub-prompt must be answered BEFORE the next keypress reaches the account list.
    if (st.line != null) input.write(st.line + '\n');
    else input.emit('keypress', st.str || '', { name: st.key });
  }
  return done.then(function () {
    return out;
  });
}

// Everything threads/ holds, byte for byte — the read-only claim is checked against this, not against a
// hand-picked field: a screen that "only" rewrites one file's mtime is still a mutation.
function snapshotThreads(ctx) {
  let names = [];
  try {
    names = fs.readdirSync(threads.dir(ctx));
  } catch (e) {
    names = [];
  }
  return (
    names.sort().join(',') +
    '|' +
    names
      .sort()
      .map(function (n) {
        return n + ':' + fs.readFileSync(path.join(threads.dir(ctx), n), 'utf8');
      })
      .join('|')
  );
}

test('the menu advertises the threads screen in both modes', async function () {
  const ctx = makeCtx();
  const line = await drive(ctx, ['q']);
  assert.match(line, /\[t\] threads/, 'line mode lists it');
  assert.match(line, /Choose:/);
  const keys = await keysDrive(ctx, [{ key: 'q' }]);
  assert.match(keys, /\[a\] add · \[d\] delete · \[t\] threads/, 'and so does the arrow-key footer');
  assert.match(keys, /Bye\./);
});

test('[t] lists threads with their accounts and member counts, and back costs nothing', async function () {
  const ctx = makeCtx();
  workspace(ctx);
  threads.create(ctx, {
    slug: 'threads-design',
    title: 'Threads design, take two',
    member: { kind: 'session', id: ID_A },
  });
  threads.addMember(ctx, 'threads-design', { kind: 'session', id: ID_B });
  threads.addMember(ctx, 'threads-design', { kind: 'chat', id: CHAT_1, account: 'yahoo' });

  const before = snapshotThreads(ctx);
  const out = await drive(ctx, ['t', '', 'q']);
  assert.match(out, /══ Threads ══ {2}1 thread\(s\), 3 member\(s\): 2 session\(s\), 1 cloud chat\(s\)/);
  assert.match(out, /\[1\] threads-design {2}3 member\(s\): 2 session\(s\), 1 chat\(s\)/);
  assert.match(out, /“Threads design, take two”/, 'a title that is not just the slug is shown');
  assert.match(out, /accounts: gmail, yahoo/);
  assert.match(out, /✓ 1 thread\(s\) span more than one account: threads-design/);
  assert.strictEqual(snapshotThreads(ctx), before, 'opening and leaving the screen writes nothing');
  assert.strictEqual(threads.summaries(ctx).length, 1, 'and creates nothing either');
});

test('a thread number resolves its members on THIS machine: resume command, folder, and the honest reason when one is missing', async function () {
  const ctx = makeCtx();
  workspace(ctx);
  threads.create(ctx, { slug: 'design', member: { kind: 'session', id: ID_A } });
  threads.addMember(ctx, 'design', { kind: 'session', id: 'eeeeeeee-5555-4555-8555-555555555555' });
  threads.addMember(ctx, 'design', { kind: 'chat', id: CHAT_1, account: 'yahoo' });

  const before = snapshotThreads(ctx);
  const out = await drive(ctx, ['t', '1', '', 'q']);
  assert.match(out, /\[sess\] aaaaaaaa/);
  assert.match(out, /\/proj\/work/, 'the folder comes from the transcript, not the encoded project dir name');
  assert.match(out, /--resume/, 'the resume line is shown so it can be copied');
  assert.match(out, /\[sess\] eeeeeeee[\s\S]{0,200}no transcript on this machine/, 'a dead pointer says so');
  assert.match(
    out,
    /\[chat\] dddddddd[\s\S]{0,200}keyflip chat get/,
    'a cloud chat is server-side, and says how to read it',
  );
  assert.match(
    out,
    /1 session pointer\(s\) resolve to nothing on this machine/,
    'a missing SESSION is counted, a server-side chat is not',
  );
  assert.match(out, /merged read: keyflip threads show design --timeline/);
  assert.ok(!/“/.test(out), 'a thread with no title prints no invented quote line');
  assert.strictEqual(snapshotThreads(ctx), before, 'showing members is not a mutation');
});

test('an unattributed member is flagged with the command that fixes it — that is the wrong-account bug', async function () {
  const ctx = makeCtx();
  profiles.write(ctx.configDir, { name: 'gmail', email: 'g@example.com' });
  seed(ctx, '-proj-loose', ID_B, '/proj/loose', [
    { role: 'user', text: 'never assigned', ts: '2026-10-14T12:00:00.000Z' },
  ]);
  threads.create(ctx, { slug: 'loose', member: { kind: 'session', id: ID_B } });
  const out = await drive(ctx, ['t', '1', '', 'q']);
  assert.match(out, /1 member\(s\) unassigned/);
  assert.match(out, /⚠ 1 member\(s\) would resume as the CURRENT account \(loose\)/);
  assert.match(out, /fix: keyflip sessions assign <session-id> <account>/);
  assert.match(out, /\[sess\] bbbbbbbb {2}⚠ unassigned/);
  assert.match(out, /\/proj\/loose/, 'the pointer still resolves — it is the ACCOUNT that is missing');
});

test('[s] reports split work as a suggestion only — the screen never creates a thread for you', async function () {
  const ctx = makeCtx();
  workspace(ctx);
  const before = snapshotThreads(ctx);
  const out = await drive(ctx, ['t', 's', '', 'q']);
  assert.match(out, /\/proj\/work/);
  assert.match(out, /gmail \+ yahoo · 2 session\(s\), 2 not in any thread yet/);
  assert.match(out, /keyflip threads create work --title/);
  assert.match(out, /This screen does not create threads/);
  assert.strictEqual(snapshotThreads(ctx), before, 'a suggestion is not a write');
  assert.strictEqual(threads.summaries(ctx).length, 0);
});

test('no threads yet is a hint, not an error — and the empty store still gets the suggest path', async function () {
  const ctx = makeCtx();
  workspace(ctx);
  const out = await drive(ctx, ['t', 's', '', 'q']);
  assert.match(out, /None yet\. A thread gives one task a single name across accounts/);
  assert.match(out, /keyflip threads create <slug> --title/);
  assert.match(out, /gmail \+ yahoo/, 'the empty list still lets you look for what should be named');
  assert.strictEqual(fs.existsSync(threads.dir(ctx)), false, 'and it never creates the threads dir');
});

test('a corrupt thread file is reported, not hidden — and opening it cannot overwrite it', async function () {
  const ctx = makeCtx();
  fs.mkdirSync(threads.dir(ctx), { recursive: true });
  const broken = path.join(threads.dir(ctx), 'broken.json');
  fs.writeFileSync(broken, '{not json', { mode: 0o600 });
  const rawBefore = fs.readFileSync(broken, 'utf8');
  const out = await drive(ctx, ['t', '1', '', 'q']);
  assert.match(out, /\[1\] broken/);
  assert.match(out, /⚠ unreadable thread file/);
  assert.match(out, /is not valid JSON/, 'the detail view refuses instead of pretending the thread is empty');
  assert.strictEqual(fs.readFileSync(broken, 'utf8'), rawBefore);
});

test('bad input on the threads screen returns to its own prompt — never an accidental switch, never an exit', async function () {
  const ctx = makeCtx();
  workspace(ctx);
  threads.create(ctx, { slug: 'design', member: { kind: 'session', id: ID_A } });
  const before = snapshotThreads(ctx);
  const out = await drive(ctx, ['t', '99', 'x', '', 'q']);
  assert.strictEqual(out.split('Invalid choice.').length - 1, 2, 'both bad answers are rejected in place');
  assert.strictEqual(out.split('══ Threads ══').length - 1, 3, 'once per answer, then the account menu');
  assert.match(out, /Threads: /);
  assert.ok(!/Switched to:/.test(out), 'a stray number cannot switch accounts');
  assert.strictEqual(snapshotThreads(ctx), before);
});

test('keys mode: [t] opens the same read-only screen and Enter returns to the account list', async function () {
  const ctx = makeCtx();
  workspace(ctx);
  threads.create(ctx, { slug: 'design', member: { kind: 'session', id: ID_A } });
  const before = snapshotThreads(ctx);
  const out = await keysDrive(ctx, [{ key: 't' }, { line: '' }, { key: 'q', str: 'q' }]);
  assert.match(out, /══ Threads ══ {2}1 thread\(s\), 1 member\(s\)/);
  assert.match(out, /\[1\] design/);
  assert.match(out, /Bye\./, 'and it exits from the account menu afterwards');
  assert.strictEqual(snapshotThreads(ctx), before);
});
