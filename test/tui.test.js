'use strict';
// Tests for E5 (src/tui.js): the pure render/reducer/buildState/normalizeKey are exercised with
// no TTY, and run()'s loop is driven through a FAKE tty (an EventEmitter) so the interactive
// path (alt-screen, quit, Enter->switch) is covered without a real terminal or network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const tui = require('../src/tui');
const profiles = require('../src/profiles');
const { makeCtx } = require('./helpers');

function writeProfile(ctx, name, email) {
  profiles.write(ctx.configDir, { name: name, email: email });
  ctx.store.setProfile(name, JSON.stringify({ claudeAiOauth: { accessToken: 'tok-' + name } }));
}

function baseState(over) {
  return Object.assign({
    activeEmail: 'alice@x.com',
    accounts: [
      { name: 'alice', email: 'alice@x.com', active: true, fiveHourPct: 62, sevenDayPct: 28 },
      { name: 'bob', email: 'bob@y.com', active: false, fiveHourPct: 91, sevenDayPct: 44 },
      { name: 'carol', email: 'carol@z.com', active: false, fiveHourPct: null, sevenDayPct: null },
    ],
    providers: [{ name: 'relay', active: true }, { name: 'spare', active: false }],
    fleet: { configured: false, name: null, machineId: null, peers: [] },
    sel: 1, view: 'accounts', filter: '', filtering: false, pending: null, message: null, quit: false,
  }, over || {});
}

// A minimal fake TTY stream that behaves like process.stdin for run().
function fakeTTY() {
  const ee = new EventEmitter();
  ee.setMaxListeners(50);
  ee.isTTY = true;
  ee.raw = false;
  ee.setRawMode = function (v) { ee.raw = v; return ee; };
  ee.resume = function () {}; ee.pause = function () {};
  return ee;
}
function fakeOut() { return { data: '', columns: 80, rows: 24, write: function (s) { this.data += s; return true; } }; }
const tick = function (ms) { return new Promise(function (r) { setTimeout(r, ms || 5); }); };

// -------------------------------------------------------------------------
// render (pure)
// -------------------------------------------------------------------------
test('render: accounts, bars, providers, fleet summary and footer are all present', function () {
  const f = tui.render(baseState(), { width: 90, height: 24 });
  assert.ok(f.indexOf('alice@x.com') !== -1 && f.indexOf('bob@y.com') !== -1);
  assert.ok(f.indexOf('(active)') !== -1, 'active tag on the live account');
  assert.ok(f.indexOf('5h [') !== -1 && f.indexOf('7d [') !== -1, 'both usage bars render');
  assert.ok(f.indexOf('█') !== -1, 'bar has a filled segment');
  assert.ok(f.indexOf('Providers: ● relay') !== -1 && f.indexOf('○ spare') !== -1);
  assert.ok(f.indexOf('Fleet: not configured') !== -1, 'fleet summary line');
  assert.ok(f.indexOf('enter switch') !== -1 && f.indexOf('q quit') !== -1, 'footer keymap');
});

test('render: the selected row is marked with ❯ and unknown usage shows ? and dot bar', function () {
  const f = tui.render(baseState({ sel: 2 }), { width: 90, height: 24 });
  const carolLine = f.split('\n').filter(function (l) { return l.indexOf('carol@z.com') !== -1; })[0];
  assert.ok(carolLine.indexOf('❯') !== -1, 'carol is selected');
  assert.ok(f.indexOf('[············]') !== -1, 'unknown usage -> dotted bar');
  const dotBarLine = f.split('\n').filter(function (l) { return l.indexOf('[············]') !== -1; })[0];
  assert.ok(dotBarLine.indexOf('?') !== -1, 'unknown usage -> ? label');
});

test('render: frame is exactly `height` rows and every row fits `width` (color off)', function () {
  const W = 40, H = 20;
  const f = tui.render(baseState(), { width: W, height: H });
  const lines = f.split('\n');
  assert.strictEqual(lines.length, H, 'exactly height rows');
  lines.forEach(function (l) { assert.ok(Array.from(l).length <= W, 'row within width: ' + JSON.stringify(l)); });
});

test('render: color mode wraps the selected row in inverse video and dims chrome', function () {
  const f = tui.render(baseState({ sel: 1 }), { width: 60, height: 20, color: true });
  assert.ok(f.indexOf('\x1b[7m') !== -1, 'inverse video present for selection');
  assert.ok(f.indexOf('\x1b[2m') !== -1, 'dim present for chrome');
});

test('render: fleet view shows the machine + peers detail', function () {
  const st = baseState({ view: 'fleet', fleet: { configured: true, name: 'laptop', machineId: 'laptop-ab12', peers: [{ name: 'desktop', activeEmail: 'x@y.com', accounts: 3 }] } });
  const f = tui.render(st, { width: 90, height: 24 });
  assert.ok(f.indexOf('Fleet') !== -1 && f.indexOf('This machine: laptop') !== -1);
  assert.ok(f.indexOf('desktop') !== -1 && f.indexOf('x@y.com') !== -1 && f.indexOf('3 acct') !== -1);
});

test('render (hostile): control chars / ANSI / newlines / overlong labels cannot break the frame', function () {
  const st = baseState({
    activeEmail: 'ok',
    accounts: [{ name: 'x', email: 'a@x.com\n\x1b[31mHACK\x00' + 'y'.repeat(300), active: false, fiveHourPct: 50, sevenDayPct: 10 }],
    providers: [], fleet: { configured: false }, sel: 0,
  });
  const W = 40, H = 18;
  const f = tui.render(st, { width: W, height: H, color: false });
  const lines = f.split('\n');
  assert.strictEqual(lines.length, H);
  lines.forEach(function (l) {
    assert.ok(Array.from(l).length <= W, 'clipped to width');
    assert.strictEqual(l.indexOf('\x1b'), -1, 'no ESC survived (no ANSI injection)');
    assert.strictEqual(l.indexOf('\x00'), -1, 'no NUL survived');
  });
});

// -------------------------------------------------------------------------
// reducer (pure)
// -------------------------------------------------------------------------
test('reducer: up/down move and clamp within the visible list, without mutating input', function () {
  const s0 = baseState({ sel: 0 });
  const up = tui.reducer(s0, 'up');
  assert.strictEqual(up.sel, 0, 'clamped at top');
  assert.strictEqual(s0.sel, 0, 'input state untouched');
  assert.notStrictEqual(up, s0, 'returns a new object');
  let s = tui.reducer(s0, 'down'); assert.strictEqual(s.sel, 1);
  s = tui.reducer(s, 'down'); assert.strictEqual(s.sel, 2);
  s = tui.reducer(s, 'down'); assert.strictEqual(s.sel, 2, 'clamped at bottom');
});

test('reducer: enter on a non-active account emits a switch effect; on the active one, a message', function () {
  const onBob = tui.reducer(baseState({ sel: 1 }), 'enter');
  assert.deepStrictEqual(onBob.pending, { type: 'switch', name: 'bob' });
  const onActive = tui.reducer(baseState({ sel: 0 }), 'enter');
  assert.strictEqual(onActive.pending, null);
  assert.ok(/already active/.test(onActive.message || ''));
});

test('reducer: r -> refresh effect, f toggles the fleet view, q/escape/ctrl-c quit', function () {
  assert.deepStrictEqual(tui.reducer(baseState(), 'r').pending, { type: 'refresh' });
  assert.strictEqual(tui.reducer(baseState({ view: 'accounts' }), 'f').view, 'fleet');
  assert.strictEqual(tui.reducer(baseState({ view: 'fleet' }), 'f').view, 'accounts');
  assert.strictEqual(tui.reducer(baseState(), 'q').quit, true);
  assert.strictEqual(tui.reducer(baseState(), 'escape').quit, true);
  assert.strictEqual(tui.reducer(baseState(), 'quit').quit, true);
});

test('reducer: digit jumps to that 1-based visible index (out of range is ignored)', function () {
  assert.strictEqual(tui.reducer(baseState({ sel: 0 }), '3').sel, 2);
  assert.strictEqual(tui.reducer(baseState({ sel: 1 }), '9').sel, 1, 'out of range keeps sel');
});

test('reducer: / opens filter mode; typing filters; enter commits; escape cancels', function () {
  let s = tui.reducer(baseState({ sel: 0 }), '/');
  assert.strictEqual(s.filtering, true);
  s = tui.reducer(s, 'b'); // type 'b'
  assert.strictEqual(s.filter, 'b');
  assert.deepStrictEqual(tui.visible(s).map(function (a) { return a.name; }), ['bob'], 'only bob matches');
  s = tui.reducer(s, 'enter');
  assert.strictEqual(s.filtering, false, 'enter commits the filter');
  assert.strictEqual(s.filter, 'b', 'committed filter kept');
  const cancelled = tui.reducer(tui.reducer(baseState(), '/'), 'escape');
  assert.strictEqual(cancelled.filtering, false);
  assert.strictEqual(cancelled.filter, '', 'escape clears the filter');
});

test('reducer (hostile): in filter mode, q/r/f are typed as text — not commands — and backspace deletes', function () {
  let s = tui.reducer(baseState(), '/');
  s = tui.reducer(s, 'q'); s = tui.reducer(s, 'r'); s = tui.reducer(s, 'f');
  assert.strictEqual(s.quit, false, 'q does not quit while filtering');
  assert.strictEqual(s.filter, 'qrf');
  s = tui.reducer(s, 'backspace');
  assert.strictEqual(s.filter, 'qr');
});

// -------------------------------------------------------------------------
// buildState (injected usage snapshot — no network)
// -------------------------------------------------------------------------
test('buildState: maps profiles + an injected usage snapshot into account bars', function () {
  const ctx = makeCtx();
  writeProfile(ctx, 'a', 'a@x.com');
  writeProfile(ctx, 'b', 'b@y.com');
  const usage = { a: { status: 'ok', usage: { fiveHour: { pct: 42 }, sevenDay: { pct: 12 } } } };
  const st = tui.buildState(ctx, { usage: usage });
  const a = st.accounts.filter(function (x) { return x.name === 'a'; })[0];
  const b = st.accounts.filter(function (x) { return x.name === 'b'; })[0];
  assert.strictEqual(a.fiveHourPct, 42);
  assert.strictEqual(a.sevenDayPct, 12);
  assert.strictEqual(b.fiveHourPct, null, 'no snapshot entry -> unknown');
  assert.strictEqual(st.sel, 0, 'defaults selection to the first non-active account');
  assert.strictEqual(st.view, 'accounts');
});

test('buildState: fleet summary reflects the local rendezvous config (no file created if absent)', function () {
  const ctx = makeCtx();
  const st1 = tui.buildState(ctx, { usage: {} });
  assert.strictEqual(st1.fleet.configured, false);
  assert.ok(!fs.existsSync(path.join(ctx.configDir, 'fleet.json')), 'buildState never creates fleet.json');
  fs.writeFileSync(path.join(ctx.configDir, 'fleet.json'), JSON.stringify({ dir: '/shared', name: 'lap' }));
  const st2 = tui.buildState(ctx, { usage: {} });
  assert.strictEqual(st2.fleet.configured, true);
  assert.strictEqual(st2.fleet.name, 'lap');
});

test('buildState (hostile): a __proto__ usage key cannot pollute the account lookup', function () {
  const ctx = makeCtx();
  writeProfile(ctx, 'a', 'a@x.com');
  const usage = JSON.parse('{"__proto__":{"usage":{"fiveHour":{"pct":99}}},"a":{"usage":{"fiveHour":{"pct":5}}}}');
  const st = tui.buildState(ctx, { usage: usage });
  assert.strictEqual(({}).polluted, undefined);
  const a = st.accounts.filter(function (x) { return x.name === 'a'; })[0];
  assert.strictEqual(a.fiveHourPct, 5);
});

// -------------------------------------------------------------------------
// prefs persistence + normalizeKey
// -------------------------------------------------------------------------
test('prefs: save/load round-trips the view and buildState honors it; corrupt file is ignored', function () {
  const ctx = makeCtx();
  assert.strictEqual(tui.savePrefs(ctx, { view: 'fleet', bogus: 1 }), true);
  assert.deepStrictEqual(tui.loadPrefs(ctx), { view: 'fleet' }, 'only known keys persisted');
  assert.strictEqual(tui.buildState(ctx, { usage: {} }).view, 'fleet', 'initial view from prefs');
  fs.writeFileSync(path.join(ctx.configDir, '.tui.json'), '{ not json');
  assert.deepStrictEqual(tui.loadPrefs(ctx), {}, 'corrupt prefs -> empty, never throws');
});

test('normalizeKey: specials map to tokens, chords are ignored, printable chars pass through', function () {
  assert.strictEqual(tui.normalizeKey(null, { name: 'up' }), 'up');
  assert.strictEqual(tui.normalizeKey('\r', { name: 'return' }), 'enter');
  assert.strictEqual(tui.normalizeKey(null, { name: 'escape' }), 'escape');
  assert.strictEqual(tui.normalizeKey('c', { ctrl: true, name: 'c' }), 'quit');
  assert.strictEqual(tui.normalizeKey('a', { ctrl: true, name: 'a' }), null, 'ctrl-chord ignored');
  assert.strictEqual(tui.normalizeKey('a', {}), 'a', 'plain char passes');
  assert.strictEqual(tui.normalizeKey('ab', {}), null, 'multi-char noise ignored');
});

// -------------------------------------------------------------------------
// run (thin loop, driven via the fake TTY)
// -------------------------------------------------------------------------
test('run: without a TTY it prints a friendly message and resolves (never hangs on raw mode)', async function () {
  const out = fakeOut();
  const r = await tui.run(makeCtx(), { input: { isTTY: false }, output: out });
  assert.strictEqual(r.tty, false);
  assert.ok(/TTY/.test(out.data) && /keyflip menu/.test(out.data));
});

test('run: enters/leaves the alt-screen and quits on q', async function () {
  const ctx = makeCtx();
  const input = fakeTTY(); const out = fakeOut();
  const done = tui.run(ctx, { input: input, output: out, usage: {} });
  await tick();
  assert.ok(out.data.indexOf('\x1b[?1049h') !== -1, 'entered alt-screen');
  assert.strictEqual(input.raw, true, 'raw mode enabled');
  input.emit('keypress', 'q', { name: 'q' });
  const r = await done;
  assert.strictEqual(r.tty, true);
  assert.ok(out.data.indexOf('\x1b[?1049l') !== -1, 'left alt-screen on exit');
  assert.strictEqual(input.raw, false, 'raw mode restored');
});

test('run: Enter switches the selected account through the injected onSwitch', async function () {
  const ctx = makeCtx();
  writeProfile(ctx, 'alice', 'alice@x.com');
  writeProfile(ctx, 'bob', 'bob@y.com');
  const input = fakeTTY(); const out = fakeOut();
  let switched = null;
  const done = tui.run(ctx, { input: input, output: out, usage: {}, onSwitch: function (n) { switched = n; return Promise.resolve(); } });
  await tick();
  input.emit('keypress', null, { name: 'down' });  // sel 0 (alice) -> 1 (bob)
  input.emit('keypress', '\r', { name: 'return' }); // switch bob
  await tick(20);
  input.emit('keypress', 'q', { name: 'q' });
  await done;
  assert.strictEqual(switched, 'bob');
  assert.ok(out.data.indexOf('Switched to bob') !== -1, 'success message drawn');
});

test('run: r triggers a refresh via the injected onRefresh', async function () {
  const ctx = makeCtx();
  const input = fakeTTY(); const out = fakeOut();
  let refreshed = 0;
  const done = tui.run(ctx, { input: input, output: out, usage: {}, onRefresh: function (c, s) { refreshed++; return tui.buildState(c, { usage: {}, view: s.view }); } });
  await tick();
  input.emit('keypress', 'r', { name: 'r' });
  await tick(20);
  input.emit('keypress', 'q', { name: 'q' });
  await done;
  assert.strictEqual(refreshed, 1);
  assert.ok(out.data.indexOf('refreshed') !== -1);
});
