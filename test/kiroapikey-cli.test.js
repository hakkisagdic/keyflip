// End-to-end checks of `keyflip kiro apikey` through the real CLI binary. Uses the real
// login Keychain with random service names (created and removed here); the key values are
// random per run. kiro-cli is a stub script. darwin only.
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import _child_process from 'child_process';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');
const SEC = '/usr/bin/security';
const skip = process.platform !== 'darwin';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-akcli-'));
  return { dir, cfg: path.join(dir, 'cfg') };
}
function kf(sb, args, input, extraEnv) {
  return _child_process.spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8',
    input: input,
    env: Object.assign({}, process.env, { KEYFLIP_CONFIG_DIR: sb.cfg, KEYFLIP_VCS: 'off' }, extraEnv || {}),
  });
}
function rnd(p) {
  return p + crypto.randomBytes(8).toString('hex');
}
function addItem(svc, val) {
  _child_process.execFileSync(SEC, ['add-generic-password', '-s', svc, '-a', 'kf-test', '-w', val]);
}
function hasItem(svc) {
  return _child_process.spawnSync(SEC, ['find-generic-password', '-s', svc]).status === 0;
}
function delItem(svc) {
  _child_process.spawnSync(SEC, ['delete-generic-password', '-s', svc]);
}
function walk(d, out) {
  out = out || [];
  if (!fs.existsSync(d)) return out;
  fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  });
  return out;
}

test('CLI K1/K2/K3/K4/K7/K8 end to end on the real Keychain', { skip }, function () {
  const sb = sandbox();
  const foreign = rnd('kf-test-foreign-');
  const hold = rnd('kiro-api-hold:kf-test-');
  const key = 'tk_' + crypto.randomBytes(18).toString('hex');
  const key2 = 'tk_' + crypto.randomBytes(18).toString('hex');
  const outs = [];
  const take = (r) => outs.push(r.stdout + '\n' + r.stderr);
  addItem(foreign, key);
  addItem(hold, key);
  try {
    // K1
    let r = kf(sb, ['kiro', 'apikey', 'add', 'a1', '--keychain-service', foreign]);
    take(r);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /added/);
    const meta = path.join(sb.cfg, 'kiro-apikey', 'a1.json');
    assert.strictEqual(fs.statSync(meta).mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(meta, 'utf8').includes(key));
    r = kf(sb, ['kiro', 'apikey', 'list']);
    take(r);
    assert.ok(r.stdout.includes('a1') && r.stdout.includes(foreign) && /present: yes/.test(r.stdout));
    assert.match(r.stdout, new RegExp('length: ' + key.length));
    // K2
    r = kf(sb, ['kiro', 'apikey', 'add', 'a9', '--keychain-service', rnd('kf-test-absent-')]);
    take(r);
    assert.notStrictEqual(r.status, 0);
    assert.ok(!fs.existsSync(path.join(sb.cfg, 'kiro-apikey', 'a9.json')));
    // K3
    r = kf(sb, ['kiro', 'apikey', 'add', 'h', '--keychain-service', hold]);
    take(r);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /refused|reserved/);
    assert.ok(hasItem(hold));
    assert.ok(!fs.existsSync(path.join(sb.cfg, 'kiro-apikey', 'h.json')));
    // K4
    r = kf(sb, ['kiro', 'apikey', 'add', 'a2', '--key-file', '-'], key2 + '\n');
    take(r);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(hasItem('keyflip:kiro-apikey:a2'));
    // K6 via CLI + JSON, K5
    const stub = path.join(sb.dir, 'stub.sh');
    fs.writeFileSync(
      stub,
      '#!/bin/sh\nenv | cut -d= -f1 > "' +
        sb.dir +
        '/envnames"\n' +
        'case "$STUB_MODE" in reject) echo "401 unauthorized" >&2; exit 1;; plan) echo "plan not eligible" >&2; exit 1;; sleep) sleep 5;; esac\n' +
        'if [ "$KIRO_API_KEY" != "' +
        key +
        '" ]; then echo "bad key $KIRO_API_KEY" >&2; exit 1; fi\necho OK\n',
      { mode: 0o755 },
    );
    const env = { KEYFLIP_KIRO_CLI: stub, AWS_PROFILE: 'x', KIRO_OTHER: 'y' };
    r = kf(sb, ['kiro', 'apikey', 'test', 'a1'], undefined, env);
    take(r);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS/);
    const names = fs.readFileSync(path.join(sb.dir, 'envnames'), 'utf8').split('\n');
    assert.ok(names.includes('KIRO_API_KEY') && !names.includes('AWS_PROFILE') && !names.includes('KIRO_OTHER'));
    for (const [mode, cat] of [
      ['reject', 'rejected'],
      ['plan', 'plan not eligible'],
    ]) {
      r = kf(sb, ['kiro', 'apikey', 'test', 'a1', '--json'], undefined, Object.assign({ STUB_MODE: mode }, env));
      take(r);
      assert.notStrictEqual(r.status, 0);
      assert.strictEqual(JSON.parse(r.stdout.trim().split('\n').pop()).test.category, cat);
    }
    r = kf(
      sb,
      ['kiro', 'apikey', 'test', 'a1', '--json', '--timeout', '1'],
      undefined,
      Object.assign({ STUB_MODE: 'sleep' }, env),
    );
    take(r);
    assert.strictEqual(JSON.parse(r.stdout.trim().split('\n').pop()).test.category, 'timeout');
    // wrong key value -> stub echoes it back; must be redacted
    r = kf(sb, ['kiro', 'apikey', 'test', 'a2', '--json'], undefined, env);
    take(r);
    assert.ok(!r.stdout.includes(key2) && !r.stderr.includes(key2));
    // key missing
    delItem(foreign);
    r = kf(sb, ['kiro', 'apikey', 'test', 'a1', '--json'], undefined, env);
    take(r);
    assert.strictEqual(JSON.parse(r.stdout.trim().split('\n').pop()).test.category, 'key missing');
    addItem(foreign, key);
    // K7
    r = kf(sb, ['kiro', 'apikey', 'remove', 'a1', '--delete-item']);
    take(r);
    assert.notStrictEqual(r.status, 0);
    assert.ok(hasItem(foreign));
    r = kf(sb, ['kiro', 'apikey', 'remove', 'a1']);
    take(r);
    assert.strictEqual(r.status, 0);
    assert.ok(hasItem(foreign), 'foreign item survives remove');
    r = kf(sb, ['kiro', 'apikey', 'remove', 'a2', '--delete-item']);
    take(r);
    assert.strictEqual(r.status, 0);
    assert.ok(!hasItem('keyflip:kiro-apikey:a2'));
    assert.ok(hasItem(hold), 'hold item untouched');
    // K8
    const all = outs.concat(walk(sb.cfg).map((f) => fs.readFileSync(f, 'utf8')));
    all.forEach((s) => assert.ok(!s.includes(key) && !s.includes(key2), 'leak'));
  } finally {
    delItem(foreign);
    delItem(hold);
    delItem('keyflip:kiro-apikey:a2');
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});
