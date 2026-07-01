'use strict';
// REAL-keychain end-to-end test against a throwaway keychain. Opt-in only:
// runs when CCSWITCH_REAL_KEYCHAIN=1 on macOS (a dedicated CI job sets it), so
// local `npm test` never touches any keychain.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const KeychainStore = require('../src/stores/keychain');

const ENABLED = process.platform === 'darwin' && process.env.CCSWITCH_REAL_KEYCHAIN === '1';

test('real keychain round-trip (throwaway keychain)', function (t) {
  if (!ENABLED) return t.skip('set CCSWITCH_REAL_KEYCHAIN=1 on macOS to run');
  const kcPath = path.join(os.tmpdir(), 'ccswitch-test-' + process.pid + '.keychain-db');
  execFileSync('/usr/bin/security', ['create-keychain', '-p', 'testpw', kcPath]);
  try {
    execFileSync('/usr/bin/security', ['unlock-keychain', '-p', 'testpw', kcPath]);
    const s = new KeychainStore({ account: 'ccswitch-test', keychainPath: kcPath });

    // stdin/hex write path + read-back
    s.setProfile('e2e', '{"claudeAiOauth":{"accessToken":"secret-123"}}');
    assert.strictEqual(s.getProfile('e2e'), '{"claudeAiOauth":{"accessToken":"secret-123"}}');

    // update in place (-U) and delete
    s.setProfile('e2e', 'v2');
    assert.strictEqual(s.getProfile('e2e'), 'v2');
    s.delProfile('e2e');
    assert.strictEqual(s.getProfile('e2e'), null); // exit 44 -> miss

    // oversized blob takes the argv fallback path
    const big = 'x'.repeat(4000);
    s.setProfile('big', big);
    assert.strictEqual(s.getProfile('big'), big);
  } finally {
    try { execFileSync('/usr/bin/security', ['delete-keychain', kcPath]); } catch (e) { /* ignore */ }
  }
});
