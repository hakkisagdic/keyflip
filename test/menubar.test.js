'use strict';
// Tests for G4: the xbar/SwiftBar menu-bar plugin output (src/menubar.js). render() is pure
// given a state + exec, so we inject both and assert the emitted plugin format.
const test = require('node:test');
const assert = require('node:assert');
const menubar = require('../src/menubar');

const EXEC = { exec: 'keyflip', pre: [] }; // predictable action lines (no `which` lookup)
function render(state) { return menubar.render({}, { state: state, exec: EXEC }); }

const STATE = {
  activeEmail: 'alice@studio.dev', activeProvider: null,
  accounts: [
    { name: 'alice', email: 'alice@studio.dev', active: true, fiveHourPct: 62, sevenDayPct: 28 },
    { name: 'work', email: 'alice@bigcorp.com', active: false, fiveHourPct: 91, sevenDayPct: 44 },
  ],
  providers: [],
};

test('title shows the active account short name + 5h quota', function () {
  const first = render(STATE).split('\n')[0];
  assert.strictEqual(first, '⚡ alice 62%');
});

test('active account is marked and NOT clickable; others get a switch action', function () {
  const out = render(STATE);
  const lines = out.split('\n');
  const activeLine = lines.filter(function (l) { return l.indexOf('✓ alice@studio.dev') !== -1; })[0];
  const workLine = lines.filter(function (l) { return l.indexOf('alice@bigcorp.com') !== -1; })[0];
  assert.ok(activeLine && activeLine.indexOf('shell=') === -1, 'active account has no switch action');
  assert.ok(workLine.indexOf('shell=keyflip param1=work param2=--restart') !== -1, 'inactive account switches on click');
  assert.ok(workLine.indexOf('terminal=false') !== -1 && workLine.indexOf('refresh=true') !== -1);
});

test('quota is colour-coded (>=90 red, >=70 orange, else green)', function () {
  const out = render(STATE);
  assert.ok(/alice@studio\.dev.*color=green/.test(out), '62% -> green');
  assert.ok(/alice@bigcorp\.com.*color=red/.test(out), '91% -> red');
  const orange = render({ accounts: [{ name: 'x', email: 'x@y.com', active: false, fiveHourPct: 75 }], providers: [] });
  assert.ok(/color=orange/.test(orange), '75% -> orange');
});

test('providers section renders when present, with the active one dotted', function () {
  const out = render(Object.assign({}, STATE, { activeProvider: 'relay', providers: [{ name: 'relay', active: true }, { name: 'spare', active: false }] }));
  assert.ok(out.split('\n')[0].indexOf('›relay') !== -1, 'active provider shown in the title');
  assert.ok(out.indexOf('● relay') !== -1 && out.indexOf('○ spare') !== -1);
});

test('empty accounts show a helpful add prompt, not a broken menu', function () {
  const out = render({ accounts: [], providers: [] });
  assert.ok(out.indexOf('No saved accounts') !== -1);
  assert.ok(out.indexOf('shell=keyflip param1=add') !== -1);
});

test('always emits the quick actions', function () {
  const out = render(STATE);
  assert.ok(out.indexOf('Open dashboard | shell=keyflip param1=panel param2=--open') !== -1);
  assert.ok(out.indexOf('Sync all chats (consolidate) | shell=keyflip param1=consolidate') !== -1);
  assert.ok(out.indexOf('Refresh | refresh=true') !== -1);
});

test('a malicious account label cannot inject xbar params (| and newlines stripped)', function () {
  const out = render({ accounts: [{ name: 'evil', email: 'a@x.com | color=red bash=/bin/rm\nmore', active: false, fiveHourPct: 10 }], providers: [] });
  const line = out.split('\n').filter(function (l) { return l.indexOf('a@x.com') !== -1; })[0];
  // xbar only parses params AFTER the first `|`. The label must contribute no `|` and no
  // newline, so it can't start a params section — the injected text is inert menu-title text.
  assert.strictEqual(line.indexOf('\n'), -1, 'newline stripped (cannot spill into a new item)');
  const barIdx = line.indexOf('|');
  assert.strictEqual((line.match(/\|/g) || []).length, 1, 'exactly one params delimiter (label added none)');
  assert.ok(line.slice(barIdx).indexOf('bash=/bin/rm') === -1, 'no injected action in the PARAMS section');
});

test('resolveExec: a .js checkout runs via node; an installed binary runs directly', function () {
  const asJs = menubar.resolveExec({ run: function () { return { code: 1, stdout: '' }; } }); // no `which` hit
  assert.strictEqual(asJs.exec, process.execPath);
  assert.ok(asJs.pre.length === 1 && asJs.pre[0].slice(-3) === '.js');
  const asBin = menubar.resolveExec({ run: function () { return { code: 0, stdout: '/usr/local/bin/keyflip\n' }; } });
  assert.strictEqual(asBin.exec, '/usr/local/bin/keyflip');
  assert.deepStrictEqual(asBin.pre, []);
});

const path = require('path');
test('pluginTarget resolves the menu-bar host + folder per platform (xbar / Argos / none)', function () {
  const mac = menubar.pluginTarget('darwin', '/Users/me', undefined);
  assert.strictEqual(mac.host, 'xbar/SwiftBar');
  assert.strictEqual(mac.dir, path.join('/Users/me', 'Library', 'Application Support', 'xbar', 'plugins'));
  assert.strictEqual(mac.mustExist, true, 'macOS requires an existing xbar/SwiftBar folder');

  const lin = menubar.pluginTarget('linux', '/home/me', undefined);
  assert.strictEqual(lin.host, 'Argos/kargos');
  assert.strictEqual(lin.dir, path.join('/home/me', '.config', 'argos'), 'Linux → ~/.config/argos (created if absent)');
  assert.strictEqual(lin.mustExist, false);

  const linXdg = menubar.pluginTarget('linux', '/home/me', '/custom/xdg');
  assert.strictEqual(linXdg.dir, path.join('/custom/xdg', 'argos'), 'Linux honors $XDG_CONFIG_HOME');

  assert.strictEqual(menubar.pluginTarget('win32', 'C:\\Users\\me', undefined), null, 'no built-in host on Windows');
});
