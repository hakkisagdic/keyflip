// Regression tests for the CLI-argument-parsing fixes found in the max-effort review:
//  - `positionals()` must skip value-taking flags AND their values, so a flag value
//    (e.g. the --passphrase-file path) is never mistaken for the positional file/host.
//  - `migrate export` must never overwrite the passphrase file, must fail (not write
//    plaintext) when the passphrase file is unreadable, and must keep stdout clean on `-`.
//  - `transfer pull --code X` (no host) must run LAN discovery, not treat the code as a host.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { positionals } from '../src/cli.js';
import _child_process from 'child_process';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');
function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-migcli-'));
}
function run(home, args) {
  return _child_process.spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      KEYFLIP_CONFIG_DIR: path.join(home, 'kfcfg'),
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      KEYFLIP_TEST_CLAUDE: 'stopped',
    }),
  });
}
// A credentials FILE pins the store to the file backend: on macOS a home
// without it selects the Keychain, and a spawned CLI test must never write
// (or wait on) the developer's real login keychain.
function seedFileStore(home) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"test"}}');
}
function seed(home) {
  fs.mkdirSync(path.join(home, 'kfcfg', 'creds'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'projects', '-p'), { recursive: true });
  seedFileStore(home);
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
  assert.deepStrictEqual(positionals(['--code', 'ABCD2345'], VF), []); // code is a flag value, not the host
  assert.deepStrictEqual(positionals(['1.2.3.4:8787', '--code', 'X'], VF), ['1.2.3.4:8787']);
  assert.deepStrictEqual(positionals(['-', '--passphrase-file', 'p'], VF), ['-']); // `-` stays a positional
  assert.deepStrictEqual(positionals(['--force', 'file'], VF), ['file']); // non-value flag consumes nothing
});

// ---- CLI: migrate export never clobbers the passphrase file ----

test('migrate export --passphrase-file <f> (no output arg) does NOT overwrite <f>', function () {
  const home = tmp();
  seed(home);
  const pf = path.join(home, 'pass.txt');
  fs.writeFileSync(pf, 'MYSECRETPASS\n');
  const r = run(home, ['migrate', 'export', '--passphrase-file', pf]);
  assert.strictEqual(fs.readFileSync(pf, 'utf8'), 'MYSECRETPASS\n', 'passphrase file must be untouched');
  const bundle = path.join(process.cwd(), 'keyflip-migrate.json'); // default lands in cwd
  // The default bundle may land in cwd; assert the command succeeded and the passphrase survived.
  assert.strictEqual(r.status, 0);
  try {
    fs.rmSync(bundle, { force: true });
  } catch (e) {
    /* ignore */
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test('migrate export with an UNREADABLE passphrase file fails and writes no plaintext', function () {
  const home = tmp();
  seed(home);
  const out = path.join(home, 'out.json');
  const r = run(home, ['migrate', 'export', out, '--passphrase-file', path.join(home, 'nope', 'missing')]);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /refusing to proceed unencrypted/);
  assert.strictEqual(fs.existsSync(out), false, 'no unencrypted bundle may be written');
  fs.rmSync(home, { recursive: true, force: true });
});

test('migrate export - writes ONLY the streaming bundle to stdout (notes go to stderr)', function () {
  const home = tmp();
  seed(home);
  const pf = path.join(home, 'pass.txt');
  fs.writeFileSync(pf, 'pw\n');
  const r = run(home, ['migrate', 'export', '-', '--passphrase-file', pf]);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.split('\n')[0], 'KEYFLIP-MIGRATE-STREAM/2');
  const header = JSON.parse(r.stdout.split('\n')[1]);
  assert.strictEqual(header.format, 'keyflip-migrate-stream');
  assert.strictEqual(header.version, 2);
  assert.strictEqual(header.encrypted, true);
  assert.ok(header.salt, 'encrypted header carries the KDF salt');
  assert.strictEqual(header.transcripts, 1);
  // The human notes (summary, warnings) must not corrupt a piped bundle.
  assert.ok(r.stdout.indexOf('migrate bundle written') === -1, 'no notes on stdout');
  assert.ok(r.stderr.indexOf('migrate bundle written') === -1, 'stdout mode writes no file to report');
  const record = JSON.parse(r.stdout.split('\n')[2]);
  assert.ok(record.ct && record.iv && record.tag, 'each record is individually encrypted');
  fs.rmSync(home, { recursive: true, force: true });
});

test('migrate export - --json keeps stdout a pure bundle and puts the JSON summary on stderr', function () {
  const home = tmp();
  seed(home);
  const pf = path.join(home, 'pass.txt');
  fs.writeFileSync(pf, 'pw\n');
  const r = run(home, ['migrate', 'export', '-', '--passphrase-file', pf, '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  // stdout must be nothing but the stream: every line is the magic or one JSON value,
  // and the summary object must never trail the bundle (the importer rejects trailing data).
  const lines = r.stdout.split('\n').filter(function (l) {
    return l.trim() !== '';
  });
  assert.strictEqual(lines[0], 'KEYFLIP-MIGRATE-STREAM/2');
  lines.slice(1).forEach(function (l) {
    JSON.parse(l); // throws on any non-JSON line
  });
  assert.strictEqual(r.stdout.indexOf('migrateExport'), -1, 'the summary must not be inside the bundle');
  // ...and it is available as one parseable JSON line on stderr.
  const summary = r.stderr.split('\n').find(function (l) {
    try {
      return !!JSON.parse(l).migrateExport;
    } catch (e) {
      return false;
    }
  });
  assert.ok(summary, 'stderr carries the JSON summary: ' + r.stderr);
  const parsed = JSON.parse(summary);
  assert.strictEqual(parsed.migrateExport.path, null);
  assert.strictEqual(parsed.migrateExport.encrypted, true);
  assert.strictEqual(parsed.migrateExport.counts.transcripts, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('migrate export <file> → import on a fresh home restores the account and transcript', function () {
  const src = tmp();
  seed(src);
  const pf = path.join(src, 'pass.txt');
  fs.writeFileSync(pf, 'pw\n');
  const bundle = path.join(src, 'bundle.kf');
  const exp = run(src, ['migrate', 'export', bundle, '--passphrase-file', pf]);
  assert.strictEqual(exp.status, 0, exp.stderr);
  assert.strictEqual(fs.readFileSync(bundle, 'utf8').split('\n')[0], 'KEYFLIP-MIGRATE-STREAM/2');
  // The login secret must not appear in an encrypted bundle in the clear.
  assert.strictEqual(fs.readFileSync(bundle, 'utf8').indexOf('{"t":1}'), -1);

  const dst = tmp();
  fs.mkdirSync(path.join(dst, 'kfcfg'), { recursive: true });
  seedFileStore(dst);
  const dpf = path.join(dst, 'pass.txt');
  fs.writeFileSync(dpf, 'pw\n');
  const imp = run(dst, ['migrate', 'import', bundle, '--passphrase-file', dpf, '--no-consolidate']);
  assert.strictEqual(imp.status, 0, imp.stderr);
  assert.match(imp.stdout, /accounts:\s+imported work/);
  assert.match(imp.stdout, /transcripts: 1 added/);
  assert.strictEqual(fs.readFileSync(path.join(dst, '.claude', 'projects', '-p', 's1.jsonl'), 'utf8'), 'chat\n');
  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(dst, { recursive: true, force: true });
});

// ---- CLI: transfer pull --code (no host) runs discovery, not code-as-host ----

test('transfer pull --code X (no host) attempts LAN discovery instead of dialing the code', function () {
  const home = tmp();
  seed(home);
  const r = run(home, ['transfer', 'pull', '--code', 'ABCD2345']);
  const out = r.stdout + r.stderr;
  assert.match(out, /Looking for a keyflip transfer|no peer found/);
  assert.doesNotMatch(out, /ABCD2345.*could not reach|reach the peer: .*ABCD2345/); // code was NOT used as a host
  fs.rmSync(home, { recursive: true, force: true });
});
