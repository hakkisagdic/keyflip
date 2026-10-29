// WHICH ACCOUNT WORKED ON THIS CONVERSATION? The conversation layer answers it from two sources:
// the user's word (`keyflip sessions assign`) and keyflip's own switch timeline. The tests pin
// the parts that could hurt:
//   • a stated assignment is never overruled by a guess;
//   • each surface reads ITS OWN timeline (a Kiro switch must not move a Claude session);
//   • a tool keyflip does not manage accounts for gets NO account, not a made-up one;
//   • an account that is no longer saved is never named;
//   • a guess is always labelled as a guess.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as convaccounts from '../src/convaccounts.js';
import * as attrib from '../src/attrib.js';
import * as profiles from '../src/profiles.js';
import * as sessionmap from '../src/sessionmap.js';
import * as auditview from '../src/auditview.js';
import { makeCtx } from './helpers.js';

const SID = 'aaaaaaaa-1111-4111-8111-111111111111';

function writeLog(ctx, lines) {
  const dir = path.join(ctx.configDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(auditview.path(ctx), lines.join('\n') + '\n', { mode: 0o600 });
}

function seedKiro(ctx, slug) {
  const dir = path.join(ctx.configDir, 'surfaces', 'kiro', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ name: slug, email: slug + '@example.com' }));
}

function seedCodex(ctx, slug) {
  const dir = path.join(ctx.configDir, 'surfaces', 'codex', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ email: slug + '@example.com' }));
}

function conv(app, id, from, to) {
  return { app: app, id: id, createdAt: from, updatedAt: to };
}

// ---- the surface timelines --------------------------------------------------------------

test('a Kiro switch is not a Claude switch — each surface reads its own timeline', function () {
  assert.strictEqual(attrib.surfaceSwitchName('kiro -> freeskynet', 'kiro'), 'freeskynet');
  assert.strictEqual(attrib.surfaceSwitchName('codex -> ozguraric', 'codex'), 'ozguraric');
  // The global (Claude) reader must NOT pick up a surface switch: that would move every
  // Claude Code session to a Kiro account name.
  assert.strictEqual(attrib.switchName('kiro -> freeskynet'), null);
  assert.strictEqual(attrib.switchName('codex -> ozguraric'), null);
  // And a surface reader must not pick up another surface's switch.
  assert.strictEqual(attrib.surfaceSwitchName('codex -> ozguraric', 'kiro'), null);
  assert.strictEqual(attrib.surfaceSwitchName('active -> gmail', 'kiro'), null);
});

test('each surface timeline holds only its own switches', function () {
  const ctx = makeCtx();
  writeLog(ctx, [
    '2026-10-14T09:00:00.000Z active -> gmail',
    '2026-10-14T10:00:00.000Z kiro -> freeskynet',
    '2026-10-14T11:00:00.000Z codex -> ozguraric',
  ]);
  assert.deepStrictEqual(
    attrib.surfaceTimeline(ctx, 'kiro').boundaries.map(function (b) {
      return b.name;
    }),
    ['freeskynet'],
  );
  assert.deepStrictEqual(
    attrib.surfaceTimeline(ctx, 'codex').boundaries.map(function (b) {
      return b.name;
    }),
    ['ozguraric'],
  );
  assert.deepStrictEqual(
    attrib.timeline(ctx).boundaries.map(function (b) {
      return b.name;
    }),
    ['gmail'],
  );
});

// ---- attribution -------------------------------------------------------------------------

test('a Claude Code conversation inside one window is attributed to that account', function () {
  const ctx = makeCtx();
  profiles.write(ctx.configDir, { name: 'gmail', email: 'g@example.com' });
  writeLog(ctx, ['2026-10-14T09:00:00.000Z active -> gmail', '2026-10-14T12:00:00.000Z active -> yahoo']);
  const a = convaccounts.explain(
    ctx,
    conv('claude', 'claude:local:' + SID, '2026-10-14T10:00:00.000Z', '2026-10-14T10:30:00.000Z'),
  );
  assert.strictEqual(a.account, 'gmail');
  assert.strictEqual(a.source, 'inferred');
  assert.strictEqual(a.confidence, 'high');
});

test("the user's word wins over the timeline and is labelled as stated", function () {
  const ctx = makeCtx();
  profiles.write(ctx.configDir, { name: 'gmail', email: 'g@example.com' });
  profiles.write(ctx.configDir, { name: 'yahoo', email: 'y@example.com' });
  writeLog(ctx, ['2026-10-14T09:00:00.000Z active -> gmail']);
  sessionmap.set(ctx, SID, 'yahoo');
  const a = convaccounts.explain(
    ctx,
    conv('claude', 'claude:local:' + SID, '2026-10-14T10:00:00.000Z', '2026-10-14T10:30:00.000Z'),
  );
  assert.strictEqual(a.account, 'yahoo');
  assert.strictEqual(a.source, 'stated');
  assert.strictEqual(a.confidence, 'high');
});

test('a Kiro conversation is attributed from the KIRO timeline, not from the Claude one', function () {
  const ctx = makeCtx();
  profiles.write(ctx.configDir, { name: 'gmail', email: 'g@example.com' });
  seedKiro(ctx, 'freeskynet');
  writeLog(ctx, ['2026-10-14T09:00:00.000Z active -> gmail', '2026-10-14T10:00:00.000Z kiro -> freeskynet']);
  const a = convaccounts.explain(
    ctx,
    conv('kiro', 'kiro:cli:abc', '2026-10-14T10:10:00.000Z', '2026-10-14T10:40:00.000Z'),
  );
  assert.strictEqual(a.account, 'freeskynet');
  assert.strictEqual(a.source, 'inferred');
});

test('a Codex conversation is attributed from the CODEX timeline', function () {
  const ctx = makeCtx();
  seedCodex(ctx, 'ozguraric');
  writeLog(ctx, ['2026-10-14T10:00:00.000Z codex -> ozguraric']);
  const a = convaccounts.explain(
    ctx,
    conv('codex', 'codex:xyz', '2026-10-14T10:10:00.000Z', '2026-10-14T10:40:00.000Z'),
  );
  assert.strictEqual(a.account, 'ozguraric');
  assert.strictEqual(a.source, 'inferred');
});

test('a tool keyflip does not manage accounts for gets NO account', function () {
  const ctx = makeCtx();
  writeLog(ctx, ['2026-10-14T10:00:00.000Z active -> gmail']);
  const a = convaccounts.explain(ctx, conv('qoder', 'qoder:1', '2026-10-14T10:10:00.000Z', '2026-10-14T10:40:00.000Z'));
  assert.strictEqual(a.account, null);
  assert.ok(a.why.indexOf('qoder') !== -1, a.why);
});

test('an account that is no longer saved is never named', function () {
  const ctx = makeCtx();
  writeLog(ctx, ['2026-10-14T10:00:00.000Z kiro -> deleted-account']);
  const a = convaccounts.explain(
    ctx,
    conv('kiro', 'kiro:cli:abc', '2026-10-14T10:10:00.000Z', '2026-10-14T10:40:00.000Z'),
  );
  assert.strictEqual(a.account, null);
  assert.ok(a.why.indexOf('no longer saved') !== -1, a.why);
});

test('a conversation older than the whole log has no evidence — never a guess', function () {
  const ctx = makeCtx();
  profiles.write(ctx.configDir, { name: 'gmail', email: 'g@example.com' });
  writeLog(ctx, ['2026-10-14T09:00:00.000Z active -> gmail']);
  const a = convaccounts.explain(
    ctx,
    conv('claude', 'claude:local:' + SID, '2026-10-13T09:00:00.000Z', '2026-10-13T10:00:00.000Z'),
  );
  assert.strictEqual(a.account, null);
  assert.strictEqual(a.confidence, null);
});

// ---- the manifest fields -----------------------------------------------------------------

test('the manifest fields carry the account, its source and its confidence', function () {
  const ctx = makeCtx();
  profiles.write(ctx.configDir, { name: 'gmail', email: 'g@example.com' });
  writeLog(ctx, ['2026-10-14T09:00:00.000Z active -> gmail']);
  const acc = convaccounts.attributor(ctx);
  const fields = acc.fields(
    conv('claude', 'claude:local:' + SID, '2026-10-14T10:00:00.000Z', '2026-10-14T10:30:00.000Z'),
  );
  assert.deepStrictEqual(fields, { account: 'gmail', accountSource: 'inferred', accountConfidence: 'high' });
});

test('an account the parser already knows is kept as stated', function () {
  const ctx = makeCtx();
  const acc = convaccounts.attributor(ctx);
  const fields = acc.fields({
    app: 'claude',
    id: 'claude:chat:1',
    account: 'gmail',
    createdAt: '2026-10-14T10:00:00.000Z',
    updatedAt: '2026-10-14T10:30:00.000Z',
  });
  assert.deepStrictEqual(fields, { account: 'gmail', accountSource: 'stated', accountConfidence: 'high' });
});

// ---- the rebuild invariant -----------------------------------------------------------------
// The manifest row holds the PREVIOUS pass's answer. If the next build read that answer as
// "the source names this account", every inference would silently become the user's word after
// one rebuild — and the second build is what `conv index --schedule` runs every 30 minutes.

test('a stored row is re-attributed, never relabelled as stated', function () {
  const ctx = makeCtx();
  profiles.write(ctx.configDir, { name: 'gmail', email: 'g@example.com' });
  writeLog(ctx, ['2026-10-14T09:00:00.000Z active -> gmail']);
  const acc = convaccounts.attributor(ctx);
  const fresh = acc.fields(
    conv('claude', 'claude:local:' + SID, '2026-10-14T10:00:00.000Z', '2026-10-14T10:30:00.000Z'),
  );
  assert.deepStrictEqual(fresh, { account: 'gmail', accountSource: 'inferred', accountConfidence: 'high' });

  // The row as the index stored it: the answer AND its label.
  const stored = Object.assign(
    {},
    conv('claude', 'claude:local:' + SID, '2026-10-14T10:00:00.000Z', '2026-10-14T10:30:00.000Z'),
    fresh,
  );
  const again = acc.fields(stored);
  assert.deepStrictEqual(
    again,
    { account: 'gmail', accountSource: 'inferred', accountConfidence: 'high' },
    "the second pass must not turn the inference into the user's word",
  );
});

test('a stored row whose account was deleted loses it instead of keeping a dead name', function () {
  const ctx = makeCtx();
  profiles.write(ctx.configDir, { name: 'gmail', email: 'g@example.com' });
  writeLog(ctx, ['2026-10-14T09:00:00.000Z active -> gmail']);
  const acc = convaccounts.attributor(ctx);
  const stored = Object.assign(
    {},
    conv('claude', 'claude:local:' + SID, '2026-10-14T10:00:00.000Z', '2026-10-14T10:30:00.000Z'),
    { account: 'gmail', accountSource: 'inferred', accountConfidence: 'high' },
  );
  // The profile is gone; the switch line is still in the log.
  fs.rmSync(path.join(ctx.configDir, 'gmail.json'), { force: true });
  const after = convaccounts.attributor(ctx).fields(stored);
  assert.strictEqual(after.account, null, 'a deleted account must not be named');
  assert.strictEqual(after.accountSource, null);
});

test('a source-named account survives the rebuild', function () {
  const ctx = makeCtx();
  const acc = convaccounts.attributor(ctx);
  const parserKnown = {
    app: 'claude',
    id: 'claude:chat:1',
    account: 'gmail',
    createdAt: '2026-10-14T10:00:00.000Z',
    updatedAt: '2026-10-14T10:30:00.000Z',
  };
  // Stored as the index stores it: the resolved account plus the source's own value.
  const stored = Object.assign({}, parserKnown, {
    accountSource: 'stated',
    accountConfidence: 'high',
    parserAccount: 'gmail',
  });
  const again = convaccounts.attributor(ctx).fields(stored);
  assert.deepStrictEqual(again, { account: 'gmail', accountSource: 'stated', accountConfidence: 'high' });
});
