// Tester checks for work item 20261117-test-anahtar-zinciri (K1, K4, K7 and the KEYFLIP_KEYCHAIN_FILE review item).
// Nothing here reaches the login Keychain: the only `security` used is a stand-in script that echoes its argv.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXEC = path.join(ROOT, 'src', 'exec.js');
const darwin = process.platform === 'darwin';

function tmp() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'kf-tester-'));
}

// A stand-in named "security" that prints its arguments; run with the guard OFF (a real, non-test process).
function standIn(dir) {
  const d = path.join(dir, 'bin');
  fs.mkdirSync(d);
  const p = path.join(d, 'security');
  fs.writeFileSync(p, '#!/bin/sh\necho "ARGS: $*"\n', { mode: 0o755 });
  return p;
}
function cleanEnv(extra) {
  const e = Object.assign({}, process.env, extra);
  delete e.NODE_TEST_CONTEXT;
  delete e.KEYFLIP_TEST_OFFLINE;
  delete e.KEYFLIP_KEYCHAIN_FILE;
  return Object.assign(e, extra);
}
function execRun(env, script) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: cleanEnv(env) });
}

test('K1: the guard refuses a bare-keychain security call by absolute path and logs it for the final check', function () {
  const d = tmp();
  try {
    const log = path.join(d, 'spawn.log');
    fs.writeFileSync(log, '');
    const r = execRun(
      { KEYFLIP_TEST_OFFLINE: '1', KEYFLIP_SPAWN_LOG: log },
      "import {run} from '" + EXEC + "'; const x = run('/usr/bin/security', ['list-keychains']); console.log(JSON.stringify(x));",
    );
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.notEqual(out.code, 0, 'call must be refused');
    const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
    assert.ok(lines.length >= 1 && /keychain/.test(lines[0]), 'refusal logged: ' + lines.join('|'));
    // the final check test fails on any non-empty log
    const fin = spawnSync(process.execPath, ['--test', path.join(ROOT, 'test', 'final-no-real-spawns.js')], {
      encoding: 'utf8',
      env: cleanEnv({ KEYFLIP_SPAWN_LOG: log }),
    });
    assert.notEqual(fin.status, 0, 'final-no-real-spawns must be red');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('review: KEYFLIP_KEYCHAIN_FILE from outside the temp dir is not honoured in a real (guard-off) run', function () {
  const d = tmp();
  try {
    const sec = standIn(d);
    const evil = '/var/attacker/evil.keychain-db';
    const r = execRun(
      { KEYFLIP_KEYCHAIN_FILE: evil },
      "import {run} from '" + EXEC + "'; const x = run('" + sec + "', ['find-generic-password','-s','svc']); console.log(x.stdout);",
    );
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(evil), 'attacker keychain file was appended to a real call: ' + r.stdout.trim());
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('K7: the cleanup script names only a1,a2,a9,h and never queries kiro-api:* or kiro-api-hold:*', function () {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'cleanup-old-test-keychain-items.sh'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.match(code, /for name in a1 a2 a9 h; do/);
  assert.match(code, /svc="keyflip:kiro-apikey:\$name"/);
  assert.doesNotMatch(code, /kiro-api:|kiro-api-hold|dump-keychain|list-keychains|find-generic-password[^\n]*(-w|-g)\b/);
  // every security call uses "$svc" only
  const calls = code.match(/"\$SEC" [a-z-]+ [^\n]*/g) || [];
  assert.ok(calls.length >= 2);
  calls.forEach((c) => assert.match(c, /-s "\$svc"/));
});

test('K7 run: --dry-run with a stand-in security touches only the four names', { skip: process.platform === 'win32' }, function () {
  const d = tmp();
  try {
    const log = path.join(d, 'calls.log');
    const sec = path.join(d, 'security');
    fs.writeFileSync(sec, '#!/bin/sh\necho "$*" >> "' + log + '"\nexit 1\n', { mode: 0o755 });
    const script = fs.readFileSync(path.join(ROOT, 'scripts', 'cleanup-old-test-keychain-items.sh'), 'utf8').replace('SEC=/usr/bin/security', 'SEC=' + sec);
    const copy = path.join(d, 'c.sh');
    fs.writeFileSync(copy, script);
    const r = spawnSync('sh', [copy, '--dry-run'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(calls, ['a1', 'a2', 'a9', 'h'].map((n) => 'find-generic-password -s keyflip:kiro-apikey:' + n));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('K4: the fixed-path helper is not rebuilt for the same source and is rebuilt once when the source changes', { skip: !darwin }, function () {
  const d = tmp();
  try {
    const kc = path.join(d, 'k.keychain-db');
    spawnSync('/usr/bin/security', ['create-keychain', '-p', 'x', kc]);
    const env = { KEYFLIP_CONFIG_DIR: path.join(d, 'cfg'), KEYFLIP_VCS: 'off', KEYFLIP_KEYCHAIN_FILE: kc, KEYFLIP_HELPER_DIR: path.join(d, 'h') };
    const add = (n) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'keyflip.js'), 'kiro', 'apikey', 'add', n, '--key-file', '-', '--no-length'], { encoding: 'utf8', input: 'tk_x\n', env: Object.assign({}, process.env, env) });
    let r = add('t1');
    assert.equal(r.status, 0, r.stderr);
    const bin = path.join(d, 'h', 'kfkc');
    const m1 = fs.statSync(bin).mtimeMs;
    r = add('t2');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.statSync(bin).mtimeMs, m1, 'rebuilt for the same source');
    fs.appendFileSync(path.join(d, 'h', 'kfkc.c'), '\n// changed\n');
    r = add('t3');
    assert.equal(r.status, 0, r.stderr);
    const m2 = fs.statSync(bin).mtimeMs;
    assert.ok(m2 > m1, 'not rebuilt after the source changed');
    r = add('t4');
    assert.equal(fs.statSync(bin).mtimeMs, m2, 'rebuilt a second time');
    spawnSync('/usr/bin/security', ['delete-keychain', kc]);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
