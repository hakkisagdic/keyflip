// Source guard: a test file that runs the real /usr/bin/security itself (child_process, not a faked runner)
// must work on a throwaway keychain file it creates (`create-keychain`). Such a call without one would reach
// the login Keychain and could make macOS ask for the owner's password during `npm test` (the runtime guard in
// src/spawnguard.js cannot see a test's own execFileSync). This test turns red at the first offender.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const SELF = new Set(['guard-source.test.js', 'spawnguard.test.js']);

// A direct child_process call whose command is the security tool (a constant, a literal or a shell string).
const RUNS_SECURITY =
  /\b(?:execFileSync|execFile|spawnSync|spawn|execSync|exec)\(\s*(?:\bSEC\b|\bSECURITY\b|['"`](?:\/usr\/bin\/)?security\b|['"`][^'"`\n]*\/usr\/bin\/security)/;

function codeOnly(text) {
  return text
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

test('no test file runs the real security tool without creating its own throwaway keychain', function () {
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js') && !SELF.has(n))) {
    const code = codeOnly(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (RUNS_SECURITY.test(code) && !/create-keychain/.test(code)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], 'these tests may reach the login Keychain: ' + offenders.join(', '));
});

test('the source guard recognises an offender', function () {
  const bad = "import cp from 'child_process';\ncp.execFileSync('/usr/bin/security', ['find-generic-password']);";
  const code = codeOnly(bad);
  assert.ok(RUNS_SECURITY.test(code) && !/create-keychain/.test(code));
  assert.ok(!RUNS_SECURITY.test("const cfg = '{exec:/usr/bin/security find-generic-password}';"));
});
