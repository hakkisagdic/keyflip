// Container v3 and the migrate safety flags (work item 20261117-keyflip-migrate-v3).
// Everything runs in a temporary HOME with a file credential store; nothing touches the
// real keychain. Secrets in fixtures are made up (CANARY-<uuid>, example-*).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import _child_process from 'child_process';
import { fileURLToPath } from 'url';
import * as container from '../src/migrate-container.js';
import * as stream from '../src/migrate-stream.js';
import * as migrateMod from '../src/migrate.js';
import * as profiles from '../src/profiles.js';
import * as provider from '../src/provider.js';
import { makeCtx } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');
const V3 = path.join(__dirname, 'vectors', 'container-v3');
const V2 = path.join(__dirname, 'vectors', 'container-v2');
const VECTOR_PASS = 'example-vector-passphrase';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-v3-'));
}
function envFor(home) {
  return Object.assign({}, process.env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    KEYFLIP_CONFIG_DIR: path.join(home, 'kfcfg'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    KEYFLIP_TEST_CLAUDE: 'stopped',
  });
}
function run(home, args, extra) {
  return _child_process.spawnSync(
    process.execPath,
    [BIN].concat(args),
    Object.assign({ encoding: 'utf8', env: envFor(home) }, extra || {}),
  );
}
// A credentials FILE pins the store to the file backend (never the developer's keychain).
function seedFileStore(home) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"test"}}');
}
function seed(home, secret) {
  fs.mkdirSync(path.join(home, 'kfcfg', 'creds'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'projects', '-p'), { recursive: true });
  seedFileStore(home);
  fs.writeFileSync(
    path.join(home, 'kfcfg', 'alice.json'),
    '{"name":"alice","email":"alice@example.com","oauthAccount":{}}',
  );
  fs.writeFileSync(path.join(home, 'kfcfg', 'creds', 'alice.cred'), JSON.stringify({ t: secret || 'example-secret' }));
  fs.writeFileSync(path.join(home, '.claude', 'projects', '-p', 's1.jsonl'), 'chat\n');
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'notes from source\n');
}
function emptyTarget() {
  const home = tmp();
  fs.mkdirSync(path.join(home, 'kfcfg'), { recursive: true });
  seedFileStore(home);
  return home;
}
function passFile(home, text) {
  const f = path.join(home, 'pass.txt');
  fs.writeFileSync(f, (text || 'example-pass') + '\n');
  return f;
}
// Digest of every file under home, EXCEPT what any keyflip command creates on its own: the action
// log and the dot-files of the config dir (git history, migration and update-check state).
function snapshot(home) {
  const out = [];
  (function walk(d) {
    fs.readdirSync(d, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .forEach(function (e) {
        const p = path.join(d, e.name);
        const inCfg = path.dirname(p) === path.join(home, 'kfcfg');
        if (inCfg && (e.name === 'logs' || e.name[0] === '.')) return; // keyflip's own bookkeeping
        if (e.name === 'pass.txt' && path.dirname(p) === home) return;
        if (e.isDirectory()) {
          out.push('d ' + path.relative(home, p));
          walk(p);
        } else
          out.push(
            'f ' + path.relative(home, p) + ' ' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),
          );
      });
  })(home);
  return out.join('\n');
}
function exportBundle(src, name, extra) {
  const bundle = path.join(src, name || 'bundle.kf');
  const r = run(src, ['migrate', 'export', bundle, '--passphrase-file', passFile(src)].concat(extra || []));
  assert.strictEqual(r.status, 0, r.stderr);
  return bundle;
}

// ---- K1 / K11: header and module hygiene ----

test('K1 v3 header: magic, kdf N=2^17, bundleId, tool, toolVersion; no fromHome/fromUser in the clear', function () {
  const src = tmp();
  seed(src);
  const bundle = exportBundle(src);
  const raw = fs.readFileSync(bundle, 'utf8');
  const lines = raw.split('\n');
  assert.strictEqual(lines[0], 'KEYFLIP-MIGRATE-STREAM/3');
  const h = JSON.parse(lines[1]);
  assert.strictEqual(h.kdf.N, 131072);
  assert.strictEqual(h.version, 3);
  assert.match(h.bundleId, /^[0-9a-f]{32}$/);
  assert.strictEqual(h.tool, 'keyflip');
  assert.ok(h.toolVersion);
  assert.strictEqual(raw.indexOf('fromHome'), -1);
  assert.strictEqual(raw.indexOf('fromUser'), -1);
  assert.strictEqual(raw.indexOf(src), -1, 'the source home path is not in the file');
});

test('K11 migrate-container.js imports only Node built-ins', function () {
  const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrate-container.js'), 'utf8');
  const specs = [];
  text.replace(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm, function (m, s) {
    specs.push(s);
    return m;
  });
  assert.deepStrictEqual(specs, ['crypto']);
  assert.ok(!/require\(/.test(text));
});

// ---- container unit ----

test('container: fromHome/fromUser ride inside the encrypted first record only', async function () {
  const src = makeCtx();
  src.claudeDir = path.join(src.home, '.claude');
  fs.mkdirSync(src.claudeDir, { recursive: true });
  fs.writeFileSync(path.join(src.claudeDir, 'CLAUDE.md'), 'x\n');
  const migrate = await import('../src/migrate.js');
  const plan = migrate.planExport(src, {});
  const out = path.join(src.home, 'b.kf');
  await stream.writeBundle({
    out,
    meta: plan.meta,
    files: plan.files,
    passphrase: 'pw',
    fromHome: '/home/alice',
    fromUser: 'alice',
  });
  const raw = fs.readFileSync(out, 'utf8');
  assert.strictEqual(raw.indexOf('/home/alice'), -1);
  const dst = makeCtx();
  dst.claudeDir = path.join(dst.home, '.claude');
  const res = await stream.importBundle({ ctx: dst, input: out, passphrase: 'pw' });
  assert.strictEqual(res.source.fromHome, '/home/alice');
  assert.strictEqual(res.source.fromUser, 'alice');
  assert.match(res.source.bundleId, /^[0-9a-f]{32}$/);
});

test('container: KDF range is enforced; N=2^15 is accepted, 2^14 and 2^21 are refused', function () {
  const mk = function (kdfN) {
    return container.createWriter({ passphrase: 'pw', kdfN: kdfN, tool: 'keyflip', toolVersion: '1' });
  };
  const w = mk(32768);
  const lines = w.headerText.split('\n');
  const r = container.openReader(lines[0], lines[1], { passphrase: 'pw' });
  assert.strictEqual(r.version, 3);
  const w14 = mk(16384);
  const l14 = w14.headerText.split('\n');
  assert.throws(() => container.openReader(l14[0], l14[1], { passphrase: 'pw' }), { code: 'STREAM_KDF' });
  assert.throws(() => mk(2097152), { code: 'STREAM_KDF' }); // over the 256 MiB scrypt cap
});

test('container: a bundle id has to be a short plain token', function () {
  assert.throws(() => container.createWriter({ passphrase: null, bundleId: 'a b' }), { code: 'USAGE' });
  assert.throws(() => container.createWriter({ passphrase: null, bundleId: 'x'.repeat(65) }), { code: 'USAGE' });
  assert.doesNotThrow(() => container.createWriter({ passphrase: null, bundleId: 'Okay_id-1.2' }));
});

test('container: BlobTracker checks declared size and sha256', function () {
  const data = Buffer.from('blob bytes');
  const sha = crypto.createHash('sha256').update(data).digest('hex');
  const t = new container.BlobTracker();
  t.start({ name: 'a', bytes: data.length, sha256: sha });
  t.chunk({ n: data.length, data: data.toString('base64') });
  assert.deepStrictEqual(t.end(), { name: 'a', bytes: data.length });
  assert.deepStrictEqual(t.finish(), { blobs: 1, bytes: data.length });
  const bad = new container.BlobTracker();
  bad.start({ name: 'a', bytes: data.length, sha256: '0'.repeat(64) });
  bad.chunk({ data: data.toString('base64') });
  assert.throws(() => bad.end(), { code: 'STREAM_DATA' });
  const short = new container.BlobTracker();
  short.start({ name: 'a', bytes: 99, sha256: sha });
  short.chunk({ data: data.toString('base64') });
  assert.throws(() => short.end(), { code: 'STREAM_DATA' });
});

// ---- K2: v2 bundles still import ----

test('K2 v2 bundles (encrypted and plain, written by keyflip 1.6.1) import', async function () {
  for (const [file, pass] of [
    ['v2-encrypted.kf', 'example-pass-v2'],
    ['v2-plain.kf', null],
  ]) {
    const dst = makeCtx();
    dst.claudeDir = path.join(dst.home, '.claude');
    const res = await stream.importBundle({ ctx: dst, input: path.join(V2, file), passphrase: pass });
    assert.deepStrictEqual(res.accounts.imported, ['alice'], file);
    assert.strictEqual(res.transcripts.added, 1, file);
    assert.strictEqual(
      fs.readFileSync(path.join(dst.claudeDir, 'projects', '-demo', 's1.jsonl'), 'utf8'),
      'hello v2\n',
    );
    assert.strictEqual(res.source.fromHome, null, 'a v2 bundle has no source fields');
  }
});

test('K2 v2 import via the CLI', function () {
  const dst = emptyTarget();
  const f = passFile(dst, 'example-pass-v2');
  const r = run(dst, [
    'migrate',
    'import',
    path.join(V2, 'v2-encrypted.kf'),
    '--passphrase-file',
    f,
    '--no-consolidate',
  ]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /accounts:\s+imported alice/);
});

// ---- K3: vectors ----

test('K3 vectors: valid imports (0); every damaged one exits 3 and leaves the target untouched', function () {
  const ok = emptyTarget();
  const r0 = run(ok, [
    'migrate',
    'import',
    path.join(V3, 'valid.kf'),
    '--passphrase-file',
    passFile(ok, VECTOR_PASS),
    '--no-consolidate',
  ]);
  assert.strictEqual(r0.status, 0, r0.stderr);
  assert.strictEqual(fs.readFileSync(path.join(ok, '.claude', 'NOTES.md'), 'utf8'), 'vector notes\n');
  assert.strictEqual(
    fs.readFileSync(path.join(ok, '.claude', 'projects', 'example-project', 'session-two.jsonl'), 'utf8'),
    'second transcript line\n',
  );

  ['flipped-record', 'flipped-header', 'truncated', 'plaintext', 'n14'].forEach(function (name) {
    const dst = emptyTarget();
    const before = snapshot(dst);
    const pf = passFile(dst, VECTOR_PASS);
    const r = run(dst, ['migrate', 'import', path.join(V3, name + '.kf'), '--passphrase-file', pf, '--no-consolidate']);
    assert.strictEqual(r.status, 3, name + ': ' + r.stdout + r.stderr);
    assert.strictEqual(snapshot(dst), before, name + ' changed the target');
    fs.rmSync(dst, { recursive: true, force: true });
  });
});

test('K3 a wrong passphrase is the same refusal (3) as tampering', function () {
  const dst = emptyTarget();
  const before = snapshot(dst);
  const r = run(dst, [
    'migrate',
    'import',
    path.join(V3, 'valid.kf'),
    '--passphrase-file',
    passFile(dst, 'not-the-passphrase'),
    '--no-consolidate',
  ]);
  assert.strictEqual(r.status, 3, r.stderr);
  assert.strictEqual(snapshot(dst), before);
});

test('an encrypted bundle without any passphrase is a missing precondition (5)', function () {
  const dst = emptyTarget();
  const r = run(dst, ['migrate', 'import', path.join(V3, 'valid.kf'), '--no-consolidate']);
  assert.strictEqual(r.status, 5, r.stderr);
});

// ---- K4: downgrade ----

test('K4 a plain bundle is refused when a passphrase is given, and with --require-encrypted', function () {
  const dst = emptyTarget();
  const before = snapshot(dst);
  const plain = path.join(V3, 'plaintext.kf');
  const a = run(dst, ['migrate', 'import', plain, '--passphrase-file', passFile(dst), '--no-consolidate']);
  assert.strictEqual(a.status, 3, a.stderr);
  const b = run(dst, ['migrate', 'import', plain, '--require-encrypted', '--no-consolidate']);
  assert.strictEqual(b.status, 3, b.stderr);
  const c = run(dst, ['migrate', 'import', path.join(V2, 'v2-plain.kf'), '--require-encrypted', '--no-consolidate']);
  assert.strictEqual(c.status, 3, c.stderr);
  assert.strictEqual(snapshot(dst), before);
  // without either flag a plain bundle is still accepted (existing behaviour)
  const d = run(dst, ['migrate', 'import', plain, '--no-consolidate']);
  assert.strictEqual(d.status, 0, d.stderr);
});

// ---- K5: bundle id ----

test('K5 --bundle-id / --expect-bundle-id', function () {
  const src = tmp();
  seed(src);
  const bundle = exportBundle(src, 'a.kf', ['--bundle-id', 'trip-A']);
  assert.strictEqual(JSON.parse(fs.readFileSync(bundle, 'utf8').split('\n')[1]).bundleId, 'trip-A');

  const dst = emptyTarget();
  const before = snapshot(dst);
  const pf = passFile(dst);
  const bad = run(dst, [
    'migrate',
    'import',
    bundle,
    '--passphrase-file',
    pf,
    '--expect-bundle-id',
    'trip-B',
    '--no-consolidate',
  ]);
  assert.strictEqual(bad.status, 3, bad.stderr);
  assert.strictEqual(snapshot(dst), before);
  const v2 = run(dst, [
    'migrate',
    'import',
    path.join(V2, 'v2-plain.kf'),
    '--expect-bundle-id',
    'trip-A',
    '--no-consolidate',
  ]);
  assert.strictEqual(v2.status, 3, 'a v2 bundle has no id');
  const good = run(dst, [
    'migrate',
    'import',
    bundle,
    '--passphrase-file',
    pf,
    '--expect-bundle-id',
    'trip-A',
    '--no-consolidate',
  ]);
  assert.strictEqual(good.status, 0, good.stderr);
});

test('K5 a bad --bundle-id is a usage error (2)', function () {
  const src = tmp();
  seed(src);
  const r = run(src, [
    'migrate',
    'export',
    path.join(src, 'x.kf'),
    '--passphrase-file',
    passFile(src),
    '--bundle-id',
    'has space',
  ]);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.ok(!fs.existsSync(path.join(src, 'x.kf')));
});

// ---- K6: dry run ----

test('K6 --dry-run prints names and statuses and writes nothing; a conflict exits 4', function () {
  const src = tmp();
  seed(src);
  const bundle = exportBundle(src);

  const empty = emptyTarget();
  const before = snapshot(empty);
  const r = run(empty, [
    'migrate',
    'import',
    bundle,
    '--passphrase-file',
    passFile(empty),
    '--dry-run',
    '--no-consolidate',
  ]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /alice \(new\)/);
  assert.match(r.stdout, /CLAUDE\.md \(new\)/);
  assert.match(r.stdout, /transcripts: 1 new, 0 exists-kept, 0 conflict/);
  assert.strictEqual(snapshot(empty), before);

  // the same machine: everything is already here and identical -> exists-kept, exit 0
  const same = run(src, [
    'migrate',
    'import',
    bundle,
    '--passphrase-file',
    path.join(src, 'pass.txt'),
    '--dry-run',
    '--no-consolidate',
  ]);
  assert.strictEqual(same.status, 0, same.stderr);
  assert.match(same.stdout, /alice \(exists-kept\)/);
  assert.match(same.stdout, /transcripts: 0 new, 1 exists-kept, 0 conflict/);

  // a different file at the same place -> conflict, exit 4, still nothing written
  const dst = emptyTarget();
  fs.mkdirSync(path.join(dst, '.claude', 'projects', '-p'), { recursive: true });
  fs.writeFileSync(path.join(dst, '.claude', 'projects', '-p', 's1.jsonl'), 'a different chat\n');
  fs.writeFileSync(path.join(dst, '.claude', 'CLAUDE.md'), 'target notes\n');
  const snap = snapshot(dst);
  const c = run(dst, [
    'migrate',
    'import',
    bundle,
    '--passphrase-file',
    passFile(dst),
    '--dry-run',
    '--no-consolidate',
  ]);
  assert.strictEqual(c.status, 4, c.stdout + c.stderr);
  assert.match(c.stdout, /CLAUDE\.md \(conflict\)/);
  assert.match(c.stdout, /transcripts: 0 new, 0 exists-kept, 1 conflict/);
  assert.strictEqual(snapshot(dst), snap);
});

test('K6 --dry-run still verifies the bundle (a tampered one exits 3)', function () {
  const dst = emptyTarget();
  const r = run(dst, [
    'migrate',
    'import',
    path.join(V3, 'flipped-record.kf'),
    '--passphrase-file',
    passFile(dst, VECTOR_PASS),
    '--dry-run',
  ]);
  assert.strictEqual(r.status, 3, r.stderr);
});

// ---- K7: backup before the first write ----

test('K7 a real import first copies the files it could touch (credentials too) to a 0700 dir', function () {
  const src = tmp();
  seed(src);
  const bundle = exportBundle(src);

  const dst = emptyTarget();
  fs.mkdirSync(path.join(dst, 'kfcfg', 'creds'), { recursive: true });
  fs.writeFileSync(
    path.join(dst, 'kfcfg', 'alice.json'),
    '{"name":"alice","email":"old@example.com","oauthAccount":{}}',
  );
  fs.writeFileSync(path.join(dst, 'kfcfg', 'creds', 'alice.cred'), '{"t":"old-target-secret"}');
  fs.mkdirSync(path.join(dst, '.claude', 'projects', '-p'), { recursive: true });
  fs.writeFileSync(path.join(dst, '.claude', 'projects', '-p', 's1.jsonl'), 'old chat\n');
  const r = run(dst, ['migrate', 'import', bundle, '--passphrase-file', passFile(dst), '--force', '--no-consolidate']);
  assert.strictEqual(r.status, 0, r.stderr);
  const m = r.stdout.match(/safety copy of the files this import could touch: (\S+)/);
  assert.ok(m, 'the path is printed: ' + r.stdout);
  const dir = m[1];
  assert.ok(dir.startsWith(path.join(dst, 'kfcfg', 'migrate-backups')));
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
  assert.strictEqual(
    fs.readFileSync(path.join(dir, 'kfcfg', 'creds', 'alice.cred'), 'utf8'),
    '{"t":"old-target-secret"}',
  );
  assert.strictEqual(fs.readFileSync(path.join(dir, '.claude', 'projects', '-p', 's1.jsonl'), 'utf8'), 'old chat\n');
  if (process.platform !== 'win32')
    assert.strictEqual(fs.statSync(path.join(dir, 'kfcfg', 'creds', 'alice.cred')).mode & 0o777, 0o600);
  // and the import really replaced them
  assert.strictEqual(fs.readFileSync(path.join(dst, '.claude', 'projects', '-p', 's1.jsonl'), 'utf8'), 'chat\n');
});

test('K7 a refused import creates no backup directory', function () {
  const dst = emptyTarget();
  run(dst, [
    'migrate',
    'import',
    path.join(V3, 'flipped-record.kf'),
    '--passphrase-file',
    passFile(dst, VECTOR_PASS),
    '--no-consolidate',
  ]);
  assert.ok(!fs.existsSync(path.join(dst, 'kfcfg', 'migrate-backups')));
});

// ---- K8: manifest and doctor ----

test('K8 manifest and doctor print names, present/missing and lengths; no values', function () {
  const home = tmp();
  const canary = 'CANARY-' + crypto.randomUUID();
  seed(home, canary);
  fs.writeFileSync(path.join(home, 'kfcfg', 'bob.json'), '{"name":"bob","email":"bob@example.com","oauthAccount":{}}'); // no credentials
  const m = run(home, ['migrate', 'manifest']);
  assert.strictEqual(m.status, 0, m.stderr);
  assert.match(m.stdout, /alice: present \(\d+ chars\)/);
  assert.match(m.stdout, /bob: missing/);
  assert.match(m.stdout, /CLAUDE\.md: present/);
  assert.match(m.stdout, /transcripts: 1/);
  assert.ok(!m.stdout.includes(canary));
  const mj = run(home, ['--json', 'migrate', 'manifest']);
  const parsed = JSON.parse(mj.stdout.trim().split('\n').pop());
  assert.strictEqual(parsed.migrateManifest.accounts.find((a) => a.name === 'alice').present, true);
  assert.ok(!mj.stdout.includes(canary));

  const d = run(home, ['migrate', 'doctor']);
  assert.strictEqual(d.status, 5, 'bob has no credentials -> a precondition is missing');
  assert.match(d.stdout, /account alice: present/);
  assert.match(d.stdout, /account bob: missing/);
  assert.ok(!d.stdout.includes(canary) && !d.stderr.includes(canary));

  fs.rmSync(path.join(home, 'kfcfg', 'bob.json'));
  const ok = run(home, ['migrate', 'doctor']);
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
});

// ---- K9: canary ----

test('K9 a canary secret never appears (plain, base64, hex) in output, log or bundle', function () {
  const src = tmp();
  const canary = 'CANARY-' + crypto.randomUUID();
  seed(src, canary);
  const bundle = path.join(src, 'canary.kf');
  const pf = passFile(src);
  const outs = [];
  const take = function (r) {
    outs.push(r.stdout, r.stderr);
    return r;
  };
  take(run(src, ['migrate', 'export', bundle, '--passphrase-file', pf]));
  const dst = emptyTarget();
  const dpf = passFile(dst);
  take(run(dst, ['migrate', 'import', bundle, '--passphrase-file', dpf, '--dry-run']));
  take(run(dst, ['migrate', 'import', bundle, '--passphrase-file', dpf, '--no-consolidate']));
  take(run(dst, ['migrate', 'import', bundle, '--passphrase-file', dpf, '--expect-bundle-id', 'other']));
  take(run(dst, ['migrate', 'doctor']));
  take(run(dst, ['migrate', 'manifest', '--json']));
  take(run(src, ['migrate', 'doctor']));

  const hay = [Buffer.from(outs.join('\n'))];
  hay.push(fs.readFileSync(bundle));
  [src, dst].forEach(function (h) {
    const logs = path.join(h, 'kfcfg', 'logs');
    if (fs.existsSync(logs)) fs.readdirSync(logs).forEach((f) => hay.push(fs.readFileSync(path.join(logs, f))));
  });
  const all = Buffer.concat(hay).toString('latin1');
  const forms = [canary, Buffer.from(canary).toString('base64'), Buffer.from(canary).toString('hex')];
  forms.forEach(function (f) {
    assert.strictEqual(all.includes(f), false, 'leaked form ' + f.slice(0, 12));
  });
  // sanity: the import itself did carry the secret to the target's credential file
  assert.ok(fs.readFileSync(path.join(dst, 'kfcfg', 'creds', 'alice.cred'), 'utf8').includes(canary));
});

// ---- K10: passphrase only on fd 3 ----

function runWithFd3(home, args, secret) {
  return new Promise(function (resolve) {
    // Node's stdio: 'pipe' uses a Unix socketpair on POSIX; on Linux opening /dev/fd/3 on a
    // socket fails with ENXIO (parent gets ECONNRESET). Piping through `cat | (...)` puts a
    // real kernel pipe(2) on fd 3, matching shell `3< <(...)` without putting secret in argv.
    const child = _child_process.spawn(
      'sh',
      ['-c', 'cat | (exec "$0" "$@" 3<&0 </dev/null)', process.execPath, BIN].concat(args),
      {
        env: envFor(home),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.stdin.on('error', () => {});
    child.stdin.end(secret + '\n');
    child.on('close', (status) => resolve({ status, stdout: out, stderr: err, argv: args }));
  });
}

test('K10 the passphrase can come from /dev/fd/3 and appears in no argv or output', async function () {
  if (process.platform === 'win32') return;
  const secret = 'example-fd3-' + crypto.randomUUID();
  const src = tmp();
  seed(src);
  const bundle = path.join(src, 'fd.kf');
  const e = await runWithFd3(src, ['migrate', 'export', bundle, '--passphrase-file', '/dev/fd/3'], secret);
  assert.strictEqual(e.status, 0, e.stderr);
  const dst = emptyTarget();
  const i = await runWithFd3(
    dst,
    ['migrate', 'import', bundle, '--passphrase-file', '/dev/fd/3', '--no-consolidate'],
    secret,
  );
  assert.strictEqual(i.status, 0, i.stderr);
  [e, i].forEach(function (r) {
    assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret));
    assert.ok(!r.argv.join(' ').includes(secret));
  });
  assert.ok(!fs.readFileSync(bundle, 'latin1').includes(secret));
});

// ---- regression: transfer / legacy ----

test('a legacy one-string bundle still imports, and is refused as plain when a passphrase is given', async function () {
  const migrate = await import('../src/migrate.js');
  const src = makeCtx();
  src.claudeDir = path.join(src.home, '.claude');
  fs.mkdirSync(src.claudeDir, { recursive: true });
  fs.writeFileSync(path.join(src.claudeDir, 'CLAUDE.md'), 'legacy\n');
  const built = migrate.buildBundle(src, { noSessions: true });
  const file = path.join(src.home, 'legacy.json');
  fs.writeFileSync(file, JSON.stringify(built.bundle));
  const dst = makeCtx();
  dst.claudeDir = path.join(dst.home, '.claude');
  await assert.rejects(stream.importBundle({ ctx: dst, input: file, passphrase: 'pw' }), { code: 'STREAM_PLAINTEXT' });
  await assert.rejects(stream.importBundle({ ctx: dst, input: file, requireEncrypted: true }), {
    code: 'STREAM_PLAINTEXT',
  });
  const res = await stream.importBundle({ ctx: dst, input: file });
  assert.strictEqual(res.memory.added, 1);
});

// Review fix: on macOS the secrets live in the Keychain, not creds/*.cred.
test('safety copy holds the old Keychain-held secrets before a --force import', function () {
  const src = makeCtx();
  src.store.setProfile('work', '{"token":"NEW-CANARY"}');
  fs.mkdirSync(src.claudeDir, { recursive: true });
  profiles.write(src.configDir, { name: 'work', email: 'a@x.com', oauthAccount: {}, savedAt: src.now() });
  provider.add(src, 'relay', { baseUrl: 'https://relay.example', authScheme: 'api-key', key: 'sk-new' });
  const bundle = migrateMod.buildBundle(src, {}).bundle;

  const dst = makeCtx();
  dst.store.type = 'keychain'; // mimic the Hybrid store: no creds/*.cred files exist
  dst.store.setProfile('work', '{"token":"OLD-CANARY"}');
  profiles.write(dst.configDir, { name: 'work', email: 'old@x.com', oauthAccount: {}, savedAt: dst.now() });
  provider.add(dst, 'relay', { baseUrl: 'https://relay.example', authScheme: 'api-key', key: 'sk-old' });
  assert.ok(!fs.existsSync(path.join(dst.configDir, 'creds')));

  const backup = migrateMod.createImportBackup(dst, { force: true });
  backup.start(bundle);
  migrateMod.applyBundle(dst, bundle, { force: true });
  assert.strictEqual(dst.store.getProfile('work'), '{"token":"NEW-CANARY"}');
  const w = path.join(backup.dir, 'store', 'work.cred');
  assert.strictEqual(fs.readFileSync(w, 'utf8'), '{"token":"OLD-CANARY"}');
  assert.strictEqual(fs.readFileSync(path.join(backup.dir, 'store', 'provider__relay.cred'), 'utf8'), 'sk-old');
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(w).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(path.join(backup.dir, 'store')).mode & 0o777, 0o700);
  }
});

test('--force with an unreadable store stops (NEED_STORE) before any write', function () {
  const src = makeCtx();
  src.store.setProfile('work', 'x');
  profiles.write(src.configDir, { name: 'work', email: 'a@x.com', oauthAccount: {}, savedAt: src.now() });
  const bundle = migrateMod.buildBundle(src, {}).bundle;
  const dst = makeCtx();
  dst.store.getProfile = function () {
    const e = new Error('keychain locked');
    e.code = 'EKEYCHAIN';
    throw e;
  };
  const backup = migrateMod.createImportBackup(dst, { force: true });
  assert.throws(
    function () {
      backup.start(bundle);
    },
    function (e) {
      return e.code === 'NEED_STORE';
    },
  );
  assert.ok(!fs.existsSync(path.join(dst.configDir, 'work.json')));
});
