'use strict';
// Tests the arrow-key (raw keypress) menu using a mock TTY input/output.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const menu = require('../src/menu');
const core = require('../src/core');
const { makeCtx, writeClaude } = require('./helpers');

function mockIO() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.setRawMode = function () { return input; };
  input.resume = function () {};
  input.pause = function () {};
  let out = '';
  const output = { write: function (s) { out += s; return true; } };
  return { input: input, output: output, get: function () { return out; } };
}

function login(ctx, email, uid, tok) {
  writeClaude(ctx, { oauthAccount: { emailAddress: email }, userID: uid });
  ctx.store.setLive(tok);
}
function lastFrame(s) { const f = s.split('\x1b[2J'); return f[f.length - 1]; }

function twoAccounts() {
  const ctx = makeCtx(); // platform 'linux' -> canManageApp false, no app interaction
  login(ctx, 'alice@x.com', 'u1', 'ALICE'); core.addCurrent(ctx);
  login(ctx, 'bob@x.com', 'u2', 'BOB'); core.addCurrent(ctx); // bob is active
  return ctx;
}

test('keys menu pre-selects the first NON-active account (the one you would switch to)', async function () {
  const ctx = twoAccounts(); // active = bob; sorted [alice, bob]
  const io = mockIO();
  const done = menu.runMenuKeys(ctx, io);
  const f = lastFrame(io.get());
  assert.match(f, /\x1b\[7m❯ \[1\] alice@x\.com/);   // alice highlighted by default
  assert.match(f, /\[2\] bob@x\.com  ● cli/);    // bob marked active (CLI), not highlighted
  io.input.emit('keypress', 'q', { name: 'q' });
  await done;
});

test('keys menu: arrow down moves the highlight', async function () {
  const ctx = twoAccounts();
  const io = mockIO();
  const done = menu.runMenuKeys(ctx, io);
  io.input.emit('keypress', undefined, { name: 'down' }); // sel 0 -> 1
  assert.match(lastFrame(io.get()), /\x1b\[7m❯ \[2\] bob@x\.com/);
  io.input.emit('keypress', 'q', { name: 'q' });
  await done;
});

test('keys menu: Enter switches to the highlighted (default non-active) account', async function () {
  process.env.CCSWITCH_TEST_CLAUDE = 'stopped';
  try {
    const ctx = twoAccounts(); // active bob, default highlight alice
    const io = mockIO();
    const done = menu.runMenuKeys(ctx, io);
    io.input.emit('keypress', '\r', { name: 'return' });
    await done;
    assert.strictEqual(core.currentEmail(ctx), 'alice@x.com');
    assert.match(io.get(), /Switched to: alice@x\.com/);
  } finally {
    delete process.env.CCSWITCH_TEST_CLAUDE;
  }
});

test('keys menu: a number key switches to that account directly', async function () {
  process.env.CCSWITCH_TEST_CLAUDE = 'stopped';
  try {
    const ctx = twoAccounts(); // active bob
    const io = mockIO();
    const done = menu.runMenuKeys(ctx, io);
    io.input.emit('keypress', '1', { name: '1' }); // -> alice
    await done;
    assert.strictEqual(core.currentEmail(ctx), 'alice@x.com');
  } finally {
    delete process.env.CCSWITCH_TEST_CLAUDE;
  }
});

test('keys menu: Ctrl-D exits (does NOT open the delete flow)', async function () {
  const ctx = twoAccounts();
  const io = mockIO();
  const done = menu.runMenuKeys(ctx, io);
  io.input.emit('keypress', undefined, { name: 'd', ctrl: true });
  await done;
  assert.match(io.get(), /Bye\./);
  assert.doesNotMatch(io.get(), /Remove which/);
});

test('keys menu: Ctrl-A is ignored (does NOT open the add flow)', async function () {
  const ctx = twoAccounts();
  const io = mockIO();
  const done = menu.runMenuKeys(ctx, io);
  io.input.emit('keypress', undefined, { name: 'a', ctrl: true }); // ignored
  io.input.emit('keypress', 'q', { name: 'q' });                   // then quit
  await done;
  assert.doesNotMatch(io.get(), /Current account:|Save as/);
});

test('keys menu: q quits cleanly', async function () {
  const ctx = twoAccounts();
  const io = mockIO();
  const done = menu.runMenuKeys(ctx, io);
  io.input.emit('keypress', 'q', { name: 'q' });
  await done;
  assert.match(io.get(), /Bye\./);
});
