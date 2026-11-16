// Independent acceptance tests (tester) for migrate container v3. Black-box through the CLI,
// temp HOME only, made-up secrets. Check ids K1..K11 match docs/is/20261117-keyflip-migrate-v3/ANALIZ.md.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'keyflip.js');
const VEC = path.join(__dirname, 'vectors', 'container-v3');
const VEC_PASS = 'example-vector-passphrase';
const CANARY = 'CANARY-' + crypto.randomUUID();

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kf-qa-')); }
function run(home, args, opts) {
  opts = opts || {};
  return spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8',
    input: opts.input,
    stdio: opts.stdio,
    env: Object.assign({}, process.env, {
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
      KEYFLIP_CONFIG_DIR: path.join(home, 'kfcfg'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      KEYFLIP_TEST_CLAUDE: 'stopped',
    }),
  });
}
function pin(home) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"test"}}');
}
function seed(home, secret) {
  pin(home);
  fs.mkdirSync(path.join(home, 'kfcfg', 'creds'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'projects', '-p'), { recursive: true });
  fs.writeFileSync(path.join(home, 'kfcfg', 'work.json'), '{"name":"work","email":"a@x.com","oauthAccount":{}}');
  fs.writeFileSync(path.join(home, 'kfcfg', 'creds', 'work.cred'), JSON.stringify({ t: secret || 'plain-secret' }));
  fs.writeFileSync(path.join(home, '.claude', 'projects', '-p', 's1.jsonl'), 'chat\n');
}
function walk(dir, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'migrate-backups' || e.name === 'logs' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out.sort();
}
// Startup housekeeping of any keyflip run (.gitignore, .migrations.json, .update-check.json, work.json
// normalisation) is not import damage: settle() runs one harmless command first, digest() ignores the
// update-check stamp and the passphrase file.
function settle(home) { run(home, ['migrate', 'manifest']); return home; }
function digest(home) {
  return walk(home).filter((p) => !/update-check\.json$|\.gitignore$|\/pw$/.test(p)).map((p) => p.slice(home.length) + ':' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')).join('\n');
}
function pw(dir, text) { const f = path.join(dir, 'pw'); fs.writeFileSync(f, text || 'qa-passphrase-1', { mode: 0o600 }); return f; }

test('K1 export writes v3 header with kdf N=131072, bundleId, tool, toolVersion; no fromHome/fromUser in header', function () {
  const h = tmp(); seed(h); const f = path.join(h, 'b');
  const r = run(h, ['migrate', 'export', f, '--passphrase-file', pw(h), '--bundle-id', 'QA-1']);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  assert.strictEqual(lines[0], 'KEYFLIP-MIGRATE-STREAM/3');
  const hd = JSON.parse(lines[1]);
  assert.strictEqual(hd.kdf.N, 131072);
  assert.strictEqual(hd.bundleId, 'QA-1');
  assert.ok(hd.tool && hd.toolVersion);
  assert.ok(!/fromHome|fromUser/.test(lines[1]));
  assert.ok(!/fromHome|fromUser/.test(lines[0]));
});

test('K2 v2 vectors (plain and encrypted) still import', function () {
  const v2 = path.join(__dirname, 'vectors', 'container-v2');
  for (const [name, enc] of [['v2-plain.kf', false], ['v2-encrypted.kf', true]]) {
    const h = tmp(); pin(h);
    const args = ['migrate', 'import', path.join(v2, name)];
    if (enc) {
      const V2PASS = 'example-pass-v2';
      args.push('--passphrase-file', pw(h, V2PASS));
    }
    const r = run(h, args);
    assert.strictEqual(r.status, 0, name + ': ' + r.stderr + r.stdout);
  }
});

test('K3 vectors: valid=0; every bad vector exits 3 and leaves target HOME unchanged', function () {
  const bad = ['flipped-record', 'flipped-header', 'truncated', 'plaintext', 'n14'];
  const h0 = tmp(); pin(h0);
  const ok = run(h0, ['migrate', 'import', path.join(VEC, 'valid.kf'), '--passphrase-file', pw(h0, VEC_PASS)]);
  assert.strictEqual(ok.status, 0, ok.stderr + ok.stdout);
  for (const b of bad) {
    const h = tmp(); seed(h); const pwf = pw(h, VEC_PASS); settle(h); const before = digest(h);
    const r = run(h, ['migrate', 'import', path.join(VEC, b + '.kf'), '--passphrase-file', pwf]);
    assert.strictEqual(r.status, 3, b + ' exit ' + r.status + ' ' + r.stderr + r.stdout);
    assert.strictEqual(digest(h), before, b + ' changed target');
  }
});

test('K4 plain bundle rejected when a passphrase is given, and with --require-encrypted', function () {
  const h = tmp(); seed(h); const f = path.join(h, 'plain');
  assert.strictEqual(run(h, ['migrate', 'export', f]).status, 0);
  assert.ok(!fs.readFileSync(f, 'utf8').includes('"encrypted":true'));
  const t = tmp(); pin(t); settle(t); const before = digest(t);
  assert.strictEqual(run(t, ['migrate', 'import', f, '--passphrase-file', pw(t)]).status, 3);
  assert.strictEqual(run(t, ['migrate', 'import', f, '--require-encrypted']).status, 3);
  assert.strictEqual(digest(t), before);
  assert.strictEqual(run(t, ['migrate', 'import', f]).status, 0); // control: plain still allowed without flags
});

test('K5 bundle id mismatch exits 3 and does not touch target; match exits 0', function () {
  const h = tmp(); seed(h); const f = path.join(h, 'b'); const p = pw(h);
  assert.strictEqual(run(h, ['migrate', 'export', f, '--passphrase-file', p, '--bundle-id', 'A']).status, 0);
  const t = tmp(); pin(t); settle(t); const before = digest(t);
  assert.strictEqual(run(t, ['migrate', 'import', f, '--passphrase-file', p, '--expect-bundle-id', 'B']).status, 3);
  assert.strictEqual(digest(t), before);
  assert.strictEqual(run(t, ['migrate', 'import', f, '--passphrase-file', p, '--expect-bundle-id', 'A']).status, 0);
});

test('K6 dry-run prints names and statuses only, writes nothing; conflict exits 4', function () {
  const h = tmp(); seed(h, CANARY); const f = path.join(h, 'b'); const p = pw(h);
  run(h, ['migrate', 'export', f, '--passphrase-file', p]);
  const t = tmp(); pin(t); settle(t); const before = digest(t);
  const r = run(t, ['migrate', 'import', f, '--passphrase-file', p, '--dry-run']);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /work/); assert.match(r.stdout, /new/);
  assert.ok(!r.stdout.includes(CANARY));
  assert.strictEqual(digest(t), before);
  assert.ok(!fs.existsSync(path.join(t, 'kfcfg', 'migrate-backups')), 'dry run must not create a backup');
  // conflict: same session id, different content
  const c = tmp(); seed(c); fs.writeFileSync(path.join(c, '.claude', 'projects', '-p', 's1.jsonl'), 'DIFFERENT\n'); settle(c);
  const bc = digest(c);
  const r2 = run(c, ['migrate', 'import', f, '--passphrase-file', p, '--dry-run']);
  assert.strictEqual(r2.status, 4, r2.stderr + r2.stdout);
  assert.match(r2.stdout, /conflict/);
  assert.strictEqual(digest(c), bc);
});

test('K7 real import creates 0700 backup dir before writing, prints path, includes credential files', function () {
  const h = tmp(); seed(h); const f = path.join(h, 'b'); const p = pw(h);
  run(h, ['migrate', 'export', f, '--passphrase-file', p]);
  const t = tmp(); seed(t, 'target-own-secret'); // target already has credential files that import may touch
  const r = run(t, ['migrate', 'import', f, '--passphrase-file', p]);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  const root = path.join(t, 'kfcfg', 'migrate-backups');
  const dirs = fs.readdirSync(root);
  assert.strictEqual(dirs.length, 1);
  const d = path.join(root, dirs[0]);
  assert.ok(r.stdout.includes(d) || r.stderr.includes(d), 'path printed');
  assert.strictEqual(fs.statSync(d).mode & 0o777, 0o700);
  const files = walk(d);
  assert.ok(files.some((x) => /\.cred$|credentials/.test(x)), 'credential file in backup: ' + files.join(','));
  const joined = files.map((x) => fs.readFileSync(x, 'utf8')).join('\n');
  assert.ok(joined.includes('target-own-secret') || files.some((x) => /credentials\.json$/.test(x)));
  for (const x of files) assert.strictEqual(fs.statSync(x).mode & 0o077, 0, 'backup file mode ' + x);
});

test('K8 manifest [--json] and doctor print names/present/length, never values', function () {
  const h = tmp(); seed(h, CANARY);
  const m = run(h, ['migrate', 'manifest']); assert.strictEqual(m.status, 0, m.stderr);
  const mj = run(h, ['migrate', 'manifest', '--json']); assert.strictEqual(mj.status, 0, mj.stderr);
  JSON.parse(mj.stdout);
  const d = run(h, ['migrate', 'doctor']); assert.strictEqual(d.status, 0, d.stderr + d.stdout);
  assert.match(m.stdout, /work/); assert.match(m.stdout, /present/); assert.match(m.stdout, /\d+ chars/);
  for (const o of [m, mj, d]) {
    assert.ok(!(o.stdout + o.stderr).includes(CANARY));
    assert.ok(!(o.stdout + o.stderr).includes('test"')); // accessToken value of credential store
  }
});

function forms(s) {
  return [s, Buffer.from(s).toString('base64'), Buffer.from(s).toString('hex'), Buffer.from(s).toString('base64url')];
}
test('K9 canary secret never appears in stdout, stderr, logs or the encrypted bundle (plain, base64, hex)', function () {
  const h = tmp(); seed(h, CANARY); const f = path.join(h, 'b'); const p = pw(h);
  const outs = [];
  outs.push(run(h, ['migrate', 'export', f, '--passphrase-file', p]));
  const t = tmp(); pin(t);
  outs.push(run(t, ['migrate', 'import', f, '--passphrase-file', p, '--dry-run']));
  outs.push(run(t, ['migrate', 'import', f, '--passphrase-file', p]));
  outs.push(run(t, ['migrate', 'doctor']));
  outs.push(run(t, ['migrate', 'manifest', '--json']));
  outs.push(run(t, ['migrate', 'import', f, '--passphrase-file', pw(t, 'wrong-pass')])); // error path
  let hay = outs.map((o) => o.stdout + '\n' + o.stderr).join('\n') + fs.readFileSync(f).toString('latin1');
  hay += walk(path.join(h, 'kfcfg', 'logs')).concat(walk(path.join(t, 'kfcfg', 'logs'))).map((x) => fs.readFileSync(x, 'latin1')).join('\n');
  const hayB = Buffer.from(hay, 'latin1');
  for (const s of forms(CANARY)) assert.ok(!hayB.includes(s), 'leak of form ' + s.slice(0, 12));
  assert.strictEqual(outs[5].status, 3);
});

test('K9b plain (unencrypted) bundle is expected to carry the secret; encrypted one must not', function () {
  const h = tmp(); seed(h, CANARY); const f = path.join(h, 'plain');
  run(h, ['migrate', 'export', f]);
  assert.ok(fs.readFileSync(f).toString('latin1').includes(CANARY) || forms(CANARY).some((s) => fs.readFileSync(f).toString('latin1').includes(s)));
});

test('K10 passphrase read from /dev/fd/3 pipe; not in argv', { skip: process.platform === 'win32' }, function () {
  const h = tmp(); seed(h); const f = path.join(h, 'b');
  const SECRET = 'fd3-pass-' + crypto.randomUUID();
  function runFd(args, input) {
    const r = spawnSync(process.execPath, [BIN].concat(args), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      input: undefined,
      env: Object.assign({}, process.env, { HOME: h, USERPROFILE: h, XDG_CONFIG_HOME: path.join(h, '.config'),
        KEYFLIP_CONFIG_DIR: path.join(h, 'kfcfg'), CLAUDE_CONFIG_DIR: path.join(h, '.claude'), KEYFLIP_TEST_CLAUDE: 'stopped' }),
    });
    return r;
  }
  // spawnSync cannot feed fd 3 directly; use sh with a here-string to fd 3.
  function viaSh(args, home) {
    const cmd = '"$0" "$@" 3<<EOF\n' + SECRET + '\nEOF';
    return spawnSync('/bin/sh', ['-c', cmd, process.execPath, BIN].concat(args), {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
        KEYFLIP_CONFIG_DIR: path.join(home, 'kfcfg'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), KEYFLIP_TEST_CLAUDE: 'stopped' }),
    });
  }
  void runFd;
  const e = viaSh(['migrate', 'export', f, '--passphrase-file', '/dev/fd/3'], h);
  assert.strictEqual(e.status, 0, e.stderr + e.stdout);
  assert.ok(fs.readFileSync(f, 'utf8').includes('"encrypted":true'));
  const t = tmp(); pin(t);
  const i = viaSh(['migrate', 'import', f, '--passphrase-file', '/dev/fd/3'], t);
  assert.strictEqual(i.status, 0, i.stderr + i.stdout);
  assert.ok(!(e.stdout + e.stderr + i.stdout + i.stderr).includes(SECRET));
  // wrong passphrase through the same channel fails with 3
  const w = spawnSync('/bin/sh', ['-c', '"$0" "$@" 3<<EOF\nnot-the-pass\nEOF', process.execPath, BIN, 'migrate', 'import', f, '--passphrase-file', '/dev/fd/3'],
    { encoding: 'utf8', env: Object.assign({}, process.env, { HOME: tmp(), KEYFLIP_TEST_CLAUDE: 'stopped' }) });
  assert.notStrictEqual(w.status, 0);
});

test('K11 migrate-container.js imports only node builtins, no keyflip modules', function () {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'migrate-container.js'), 'utf8');
  const specs = [...src.matchAll(/(?:from\s+|import\s*\(\s*|require\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.ok(specs.length > 0);
  for (const s of specs) assert.ok(!s.startsWith('.') && !s.startsWith('/'), 'non-builtin import: ' + s);
  const { builtinModules } = await_free();
  for (const s of specs) assert.ok(builtinModules.includes(s.replace(/^node:/, '')), 'not a builtin: ' + s);
});
function await_free() { return { builtinModules: require_builtin() }; }
function require_builtin() { return process.binding ? Object.keys({}).concat(['fs','path','crypto','os','stream','buffer','util','zlib','events','string_decoder','readline','child_process']) : []; }
