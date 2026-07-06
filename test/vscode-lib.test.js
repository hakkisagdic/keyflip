'use strict';
// Tests for the VS Code extension's pure core (vscode-keyflip/lib.js) — parsing + view-model
// shaping. The vscode glue in extension.js is not unit-tested (needs the extension host), so
// keeping the real logic here means it IS covered by `node --test`.
const test = require('node:test');
const assert = require('node:assert');
const lib = require('../vscode-keyflip/lib');

test('parseJson: reads a clean single-object body', function () {
  assert.deepStrictEqual(lib.parseJson('{"cli":{"email":"a@x.com"}}\n'), { cli: { email: 'a@x.com' } });
});

test('parseJson: falls back to the last JSON line when stderr-ish noise leaks in', function () {
  assert.deepStrictEqual(lib.parseJson('some human line\n{"ok":1}\n'), { ok: 1 });
});

test('parseJson: null on empty / unparseable', function () {
  assert.strictEqual(lib.parseJson(''), null);
  assert.strictEqual(lib.parseJson('not json at all'), null);
  assert.strictEqual(lib.parseJson(undefined), null);
});

test('quotaLabel: shows 5h utilization when ok, hides it when not ok', function () {
  assert.strictEqual(lib.quotaLabel({ fiveHour: { pct: 42.4 } }, 'ok'), '5h 42%');
  assert.strictEqual(lib.quotaLabel({ sevenDay: { pct: 10 } }, 'ok'), '7d 10%');
  assert.strictEqual(lib.quotaLabel({ fiveHour: { pct: 42 } }, 'expired'), '', 'expired -> no misleading number');
  assert.strictEqual(lib.quotaLabel(null, 'ok'), '');
  assert.strictEqual(lib.quotaLabel({}, 'ok'), '');
});

test('statusView: builds the status-bar text + tooltip', function () {
  const v = lib.statusView({ cli: { email: 'alice@example.com' }, app: { email: 'alice@example.com' }, provider: 'relay' });
  assert.strictEqual(v.text, '$(account) alice');
  assert.ok(v.tooltip.indexOf('CLI: alice@example.com') !== -1);
  assert.ok(v.tooltip.indexOf('Desktop app: alice@example.com') !== -1);
  assert.ok(v.tooltip.indexOf('Provider: relay') !== -1);
  assert.ok(v.tooltip.indexOf('Click to switch') !== -1);
});

test('statusView: not-logged-in state', function () {
  const v = lib.statusView({ cli: null, app: null, provider: null });
  assert.strictEqual(v.text, '$(account) not logged in');
  assert.ok(v.tooltip.indexOf('CLI: —') !== -1);
  assert.ok(v.tooltip.indexOf('Provider') === -1, 'no provider line when none active');
});

test('accountItems: marks the active account, shows capture + quota', function () {
  const items = lib.accountItems({ accounts: [
    { name: 'work', email: 'w@x.com', cliCaptured: true, appCaptured: false, activeCli: true, usage: { fiveHour: { pct: 30 } }, usageStatus: 'ok' },
    { name: 'personal', email: 'p@x.com', cliCaptured: true, appCaptured: true, activeCli: false, usageStatus: 'expired' },
  ] });
  assert.strictEqual(items.length, 2);
  assert.ok(items[0].label.indexOf('$(check)') !== -1, 'active account is checked');
  assert.strictEqual(items[0].active, true);
  assert.ok(items[0].description.indexOf('cli ✓') !== -1 && items[0].description.indexOf('app —') !== -1);
  assert.ok(items[0].description.indexOf('5h 30%') !== -1, 'quota shown for the active account');
  assert.ok(items[1].description.indexOf('5h') === -1, 'expired account shows no quota number');
  assert.strictEqual(items[0].name, 'work');
});

test('accountItems: empty list -> []', function () {
  assert.deepStrictEqual(lib.accountItems({}), []);
  assert.deepStrictEqual(lib.accountItems({ accounts: [] }), []);
  assert.deepStrictEqual(lib.accountItems(null), []);
});
