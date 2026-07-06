'use strict';
// Regression tests for the CLI-argument-parsing fixes found in the max-effort review:
//  - `positionals()` must skip value-taking flags AND their values, so a flag value
//    (e.g. the --passphrase-file path) is never mistaken for the positional file/host.
//  - `migrate export` must never overwrite the passphrase file, must fail (not write
//    plaintext) when the passphrase file is unreadable, and must keep stdout clean on `-`.
//  - `transfer pull --code X` (no host) must run LAN discovery, not treat the code as a host.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { positionals } = require('../src/cli');

const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-migcli-')); }
function run(home, args) {
  return require('child_process').spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      KEYFLIP_CONFIG_DIR: path.join(home, 'kfcfg'),
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      KEYFLIP_TEST_CLAUDE: 'stopped',
    }),
  });
}
function seed(home) {
  fs.mkdirSync(path.join(home, 'kfcfg', 'creds'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'projects', '-p'), { recursive: true });
  fs.writeFileSync(path.join(home, 'kfcfg', 'work.json'), '{"name":"work","email":"a@x.com","oauthAccount":{}}');
  fs.writeFileSync(path.join(home, 'kfcfg', 'creds', 'work.cred'), '{"t":1}');
  fs.writeFileSync(path.join(home, '.claude', 'projects', '-p', 's1.jsonl'), 'chat\n');
}

// ---- unit: positionals ----

test('positionals skips value-flags and their values, keeps `-` as positional', function () {
  const VF = ['--passphrase-file', '--url', '--code'];
  assert.deepStrictEqual(positionals(['--passphrase-file', 'p.txt'], VF), []);
  assert.deepStrictEqual(positionals(['bundle.json', '--passphrase-file', 'p.txt'], VF), ['bundle.json']);
  assert.deepStrictEqual(positionals(['--passphrase-file', 'p.txt', 'bundle.json'], VF), ['bundle.json']);
  assert.deepStrictEqual(positionals(['--code', 'ABCD2345'], VF), []);      // code is a flag value, not the host
  assert.deepStrictEqual(positionals(['1.2.3.4:8787', '--code', 'X'], VF), ['1.2.3.4:8787']);
  assert.deepStrictEqual(positionals(['-', '--passphrase-file', 'p'], VF), ['-']); // `-` stays a positional
  assert.deepStrictEqual(positionals(['--force', 'file'], VF), ['file']);   // non-value flag consumes nothing
});

// ---- CLI: migrate export never clobbers the passphrase file ----

test('migrate export --passphrase-file <f> (no output arg) does NOT overwrite <f>', function () {
  const home = tmp(); seed(home);
  const pf = path.join(home, 'pass.txt');
  fs.writeFileSync(pf, 'MYSECRETPASS\n');
  const r = run(home, ['migrate', 'export', '--passphrase-file', pf]);
  assert.strictEqual(fs.readFileSync(pf, 'utf8'), 'MYSECRETPASS\n', 'passphrase file must be untouched');
  const bundle = path.join(process.cwd(), 'keyflip-migrate.json'); // default lands in cwd
  // The default bundle may land in cwd; assert the command succeeded and the passphrase survived.
  assert.strictEqual(r.status, 0);
  try { fs.rmSync(bundle, { force: true }); } catch (e) { /* ignore */ }
  fs.rmSync(home, { recursive: true, force: true });
});

test('migrate export with an UNREADABLE passphrase file fails and writes no plaintext', function () {
  const home = tmp(); seed(home);
  const out = path.join(home, 'out.json');
  const r = run(home, ['migrate', 'export', out, '--passphrase-file', path.join(home, 'nope', 'missing')]);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /refusing to proceed unencrypted/);
  assert.strictEqual(fs.existsSync(out), false, 'no unencrypted bundle may be written');
  fs.rmSync(home, { recursive: true, force: true });
});

test('migrate export - writes ONLY the bundle to stdout (notes go to stderr)', function () {
  const home = tmp(); seed(home);
  const pf = path.join(home, 'pass.txt'); fs.writeFileSync(pf, 'pw\n');
  const r = run(home, ['migrate', 'export', '-', '--passphrase-file', pf]);
  assert.strictEqual(r.status, 0);
  const obj = JSON.parse(r.stdout); // must be pure JSON, no human notes mixed in
  assert.strictEqual(obj.magic, 'keyflip-sync');
  fs.rmSync(home, { recursive: true, force: true });
});

// ---- CLI: transfer pull --code (no host) runs discovery, not code-as-host ----

test('transfer pull --code X (no host) attempts LAN discovery instead of dialing the code', function () {
  const home = tmp(); seed(home);
  const r = run(home, ['transfer', 'pull', '--code', 'ABCD2345']);
  const out = r.stdout + r.stderr;
  assert.match(out, /Looking for a keyflip transfer|no peer found/);
  assert.doesNotMatch(out, /ABCD2345.*could not reach|reach the peer: .*ABCD2345/); // code was NOT used as a host
  fs.rmSync(home, { recursive: true, force: true });
});
