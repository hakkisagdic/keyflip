// Run by test/run.js AFTER the whole suite (not named *.test.js, so the suite does not pick it up).
// It fails if any test, or any CLI a test spawned, reached a real osascript/open/say/terminal-notifier
// call or a real webhook POST (the guard in src/spawnguard.js refused it and logged it) or a PATH-shim
// stand-in (osascript, open, security) ran. A passing run proves nothing touched the developer's desktop.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

test('the suite made no real desktop or network side-effect calls', function (t) {
  const file = process.env.KEYFLIP_SPAWN_LOG;
  if (!file) {
    t.skip('no KEYFLIP_SPAWN_LOG: run through `npm test`');
    return;
  }
  const lines = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(function (l) {
      return l.trim() !== '';
    });
  assert.deepEqual(lines, [], 'real side effects were attempted during the suite:\n' + lines.join('\n'));
});
