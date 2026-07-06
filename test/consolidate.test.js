'use strict';
// Integration test for `keyflip consolidate` (gap #3/#4). The heavy merge logic is
// covered in appsessions.test.js; here we just lock the CLI dispatch + JSON contract
// against a temp HOME with the desktop app reported stopped. Cross-platform: with a
// Claude data dir (macOS/Windows) it returns a `consolidated` object; without one
// (Linux) it refuses with a clear platform message.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-consol-')); }
function run(home, args) {
  return require('child_process').spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      KEYFLIP_CONFIG_DIR: path.join(home, 'kfcfg'),
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      KEYFLIP_TEST_CLAUDE: 'stopped',
    }),
  });
}

test('consolidate is a recognized command (not "unknown")', function () {
  const r = run(tmp(), ['consolidate']);
  assert.ok(!/unknown command/i.test(r.stdout + r.stderr), 'consolidate should be dispatched');
});

test('consolidate --json returns a consolidated object, or the platform guard', function () {
  const r = run(tmp(), ['consolidate', '--json']);
  const out = r.stdout + r.stderr;
  if (/Application Support|AppData/.test(out) && /macOS\/Windows-only/.test(out)) {
    // no app data dir on this platform (Linux) — refused cleanly
    assert.notStrictEqual(r.status, 0);
    return;
  }
  if (/macOS\/Windows-only/.test(out)) { assert.notStrictEqual(r.status, 0); return; }
  // otherwise it ran: stdout carries exactly one JSON object with a consolidated field
  const line = r.stdout.trim().split('\n').filter(Boolean).pop();
  const obj = JSON.parse(line);
  assert.strictEqual(obj.schemaVersion, 1);
  assert.ok(obj.consolidated && typeof obj.consolidated.merged === 'number');
});
