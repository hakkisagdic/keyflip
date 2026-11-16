// Tests for src/kiroapikey.js. The login Keychain is faked in memory behind the
// `security` runner seam and the kfkc helper; kiro-cli is a stub shell script.
// No real key or real Keychain item is ever used: values are random per run.
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { run as realRun } from '../src/exec.js';
import { SECURITY } from '../src/stores/keychain.js';
import * as ak from '../src/kiroapikey.js';

const FAKE_HELPER = '/fake/kfkc';

function makeCtx() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-akey-'));
  return { home: home, platform: 'darwin', configDir: path.join(home, 'cfg'), now: () => '2026-11-17T12:00:00.000Z' };
}

function randomKey() {
  return 'tk_' + crypto.randomBytes(18).toString('hex');
}

// In-memory Keychain + argv log. `items` maps service -> value.
function makeEnv(items) {
  const argvLog = [];
  const run = function (cmd, args, input, opts) {
    argvLog.push([cmd].concat(args || []).join(' '));
    if (cmd === SECURITY) {
      if (args[0] === '-i') {
        const sm = /-s "([^"]*)"/.exec(input);
        const xm = /-X ([0-9a-f]+)/.exec(input);
        items[sm[1]] = Buffer.from(xm[1], 'hex').toString('utf8');
        return { code: 0, stdout: '', stderr: '', error: null, timedOut: false };
      }
      const svc = args[args.indexOf('-s') + 1];
      if (args[0] === 'find-generic-password') {
        if (!(svc in items)) return { code: 44, stdout: '', stderr: 'not found', error: null, timedOut: false };
        const out = args.indexOf('-w') !== -1 ? items[svc] + '\n' : 'keychain: attributes only\n';
        return { code: 0, stdout: out, stderr: '', error: null, timedOut: false };
      }
      if (args[0] === 'delete-generic-password') {
        delete items[svc];
        return { code: 0, stdout: '', stderr: '', error: null, timedOut: false };
      }
    }
    if (cmd === FAKE_HELPER) {
      const v = items[args[1]];
      return {
        code: v === undefined ? 4 : 0,
        stdout: 'x bytes=' + (v || '').length + ' sha=abcdef012345\n',
        stderr: '',
        error: null,
        timedOut: false,
      };
    }
    return realRun(cmd, args, input, opts);
  };
  return { run, argvLog, deps: { run: run, helper: FAKE_HELPER } };
}

function makeStub(dir) {
  const f = path.join(dir, 'kiro-cli-stub.sh');
  fs.writeFileSync(
    f,
    [
      '#!/bin/sh',
      'env | cut -d= -f1 > "$STUB_ENVLOG"',
      'if [ "$KIRO_API_KEY" != "$STUB_EXPECT" ]; then echo "invalid api key" >&2; exit 1; fi',
      'case "$STUB_MODE" in',
      '  reject) echo "401 unauthorized" >&2; exit 1;;',
      '  plan) echo "your plan is not eligible for api keys" >&2; exit 1;;',
      '  sleep) sleep 5;;',
      'esac',
      'echo OK',
      'echo "Credits used: 0.02"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return f;
}

function allFiles(dir) {
  const out = [];
  (function walk(d) {
    fs.readdirSync(d, { withFileTypes: true }).forEach(function (e) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    });
  })(dir);
  return out;
}

test('K1 add by service name: meta is 0600 and holds no value; list shows present and length', function () {
  const ctx = makeCtx();
  const svc = 'kf-test-' + crypto.randomBytes(6).toString('hex');
  const key = randomKey();
  const e = makeEnv({ [svc]: key });
  const r = ak.addByService(ctx, 'a1', svc, e.deps);
  assert.strictEqual(r.service, svc);
  assert.strictEqual(r.owned, false);
  const f = ak.metaFile(ctx, 'a1');
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(f, 'utf8').includes(key));
  const l = ak.listKeys(ctx, e.deps);
  assert.deepStrictEqual(
    l.map((x) => [x.account, x.service, x.present, x.bytes]),
    [['a1', svc, true, key.length]],
  );
  assert.ok(
    e.argvLog.every((a) => !a.includes(' -w') && !a.includes(' -g')),
    'add/list never read the value',
  );
});

test('K2 add with a missing service fails and records nothing', function () {
  const ctx = makeCtx();
  const e = makeEnv({});
  assert.throws(() => ak.addByService(ctx, 'a1', 'kf-test-absent', e.deps), /no Keychain item/);
  assert.ok(!fs.existsSync(ak.metaFile(ctx, 'a1')));
  assert.throws(() => ak.addByService(ctx, '../x', 'kf-test-absent', e.deps), /invalid account name/);
});

test('K3 the hold prefix is refused by add, test and remove --delete-item', function () {
  const ctx = makeCtx();
  const svc = 'kiro-api-hold:something';
  const items = { [svc]: randomKey() };
  const e = makeEnv(items);
  assert.throws(() => ak.addByService(ctx, 'h', svc, e.deps), /refused/);
  // a hand-edited meta pointing at the hold item is still refused
  fs.mkdirSync(ak.metaDir(ctx), { recursive: true });
  fs.writeFileSync(ak.metaFile(ctx, 'h'), JSON.stringify({ account: 'h', service: svc, owned: true }));
  assert.throws(() => ak.testKey(ctx, 'h', {}, e.deps), /refused/);
  assert.throws(() => ak.removeKey(ctx, 'h', { deleteItem: true }, e.deps), /refused/);
  assert.ok(svc in items, 'the item is untouched');
  assert.ok(!e.argvLog.some((a) => a.includes(svc)), 'the hold item was never even queried');
});

test('K4 add from stdin creates a keyflip-owned item; no value in argv, meta or errors', function () {
  const ctx = makeCtx();
  const key = randomKey();
  const items = {};
  const e = makeEnv(items);
  const r = ak.addByValue(ctx, 'a2', key + '\n', e.deps);
  assert.strictEqual(r.service, 'keyflip:kiro-apikey:a2');
  assert.strictEqual(r.owned, true);
  assert.strictEqual(items['keyflip:kiro-apikey:a2'], key);
  assert.ok(!e.argvLog.join('\n').includes(key), 'value never in argv');
  assert.ok(!fs.readFileSync(ak.metaFile(ctx, 'a2'), 'utf8').includes(key));
  assert.throws(() => ak.addByValue(ctx, 'a3', '\n', e.deps), /empty/);
});

function stubEnv(dir, key, mode) {
  return {
    PATH: process.env.PATH,
    HOME: dir,
    STUB_EXPECT: key,
    STUB_MODE: mode || 'ok',
    STUB_ENVLOG: path.join(dir, 'envlog'),
    AWS_PROFILE: 'leak',
    KIRO_OTHER: 'leak',
  };
}

test('K5 test PASS: key reaches the child as KIRO_API_KEY only, other KIRO_/AWS_ cleared', function () {
  const ctx = makeCtx();
  const key = randomKey();
  const svc = 'kf-test-' + crypto.randomBytes(6).toString('hex');
  const e = makeEnv({ [svc]: key });
  ak.addByService(ctx, 'a1', svc, e.deps);
  const stub = makeStub(ctx.home);
  const r = ak.testKey(
    ctx,
    'a1',
    { timeoutS: 20 },
    Object.assign({}, e.deps, { kiroCli: stub, env: stubEnv(ctx.home, key) }),
  );
  assert.strictEqual(r.pass, true);
  assert.match(r.credits, /Credits used/);
  const names = fs.readFileSync(path.join(ctx.home, 'envlog'), 'utf8').split('\n');
  assert.ok(names.includes('KIRO_API_KEY'));
  assert.ok(!names.includes('AWS_PROFILE') && !names.includes('KIRO_OTHER'));
  assert.ok(
    !e.argvLog
      .filter((a) => a.includes('kiro-cli-stub'))
      .join('')
      .includes(key),
  );
});

test('K6 test categories: rejected, plan not eligible, timeout, key missing', function () {
  const ctx = makeCtx();
  const key = randomKey();
  const svc = 'kf-test-' + crypto.randomBytes(6).toString('hex');
  const items = { [svc]: key };
  const e = makeEnv(items);
  ak.addByService(ctx, 'a1', svc, e.deps);
  const stub = makeStub(ctx.home);
  const cat = function (mode) {
    return ak.testKey(
      ctx,
      'a1',
      { timeoutS: 1 },
      Object.assign({}, e.deps, { kiroCli: stub, env: stubEnv(ctx.home, key, mode) }),
    );
  };
  assert.strictEqual(cat('reject').category, 'rejected');
  assert.strictEqual(cat('plan').category, 'plan not eligible');
  assert.strictEqual(cat('sleep').category, 'timeout');
  assert.strictEqual(cat('reject').pass, false);
  delete items[svc];
  const miss = ak.testKey(ctx, 'a1', {}, Object.assign({}, e.deps, { kiroCli: stub }));
  assert.strictEqual(miss.category, 'key missing');
  assert.strictEqual(miss.pass, false);
});

test('K7 remove keeps a foreign item; --delete-item deletes only a keyflip-owned one', function () {
  const ctx = makeCtx();
  const svc = 'kf-test-' + crypto.randomBytes(6).toString('hex');
  const items = { [svc]: randomKey() };
  const e = makeEnv(items);
  ak.addByService(ctx, 'a1', svc, e.deps);
  ak.addByValue(ctx, 'a2', randomKey(), e.deps);
  assert.throws(() => ak.removeKey(ctx, 'a1', { deleteItem: true }, e.deps), /refused/);
  assert.ok(fs.existsSync(ak.metaFile(ctx, 'a1')), 'refusal leaves the reference');
  assert.ok(svc in items);
  const r1 = ak.removeKey(ctx, 'a1', {}, e.deps);
  assert.strictEqual(r1.itemDeleted, false);
  assert.ok(svc in items, 'foreign item stays');
  assert.ok(!fs.existsSync(ak.metaFile(ctx, 'a1')));
  // an owned-looking meta whose service lacks the keyflip prefix is still refused
  fs.writeFileSync(ak.metaFile(ctx, 'a4'), JSON.stringify({ account: 'a4', service: svc, owned: true }));
  assert.throws(() => ak.removeKey(ctx, 'a4', { deleteItem: true }, e.deps), /refused/);
  assert.ok(svc in items);
  const r2 = ak.removeKey(ctx, 'a2', { deleteItem: true }, e.deps);
  assert.strictEqual(r2.itemDeleted, true);
  assert.ok(!('keyflip:kiro-apikey:a2' in items));
});

test('K8 leak guard: the value appears in no result, error text, config file or logged argv', function () {
  const ctx = makeCtx();
  const key = randomKey();
  const svc = 'kf-test-' + crypto.randomBytes(6).toString('hex');
  const items = { [svc]: key };
  const e = makeEnv(items);
  const seen = [];
  const take = (x) => seen.push(typeof x === 'string' ? x : JSON.stringify(x));
  take(ak.addByService(ctx, 'a1', svc, e.deps));
  take(ak.addByValue(ctx, 'a2', key, e.deps));
  take(ak.listKeys(ctx, e.deps));
  const stub = makeStub(ctx.home);
  ['ok', 'reject', 'plan', 'sleep'].forEach(function (mode) {
    take(
      ak.testKey(
        ctx,
        'a1',
        { timeoutS: 1 },
        Object.assign({}, e.deps, { kiroCli: stub, env: stubEnv(ctx.home, mode === 'reject' ? 'other' : key, mode) }),
      ),
    );
  });
  // a stub that echoes the key on failure must be redacted out of the result
  const echo = path.join(ctx.home, 'echo.sh');
  fs.writeFileSync(echo, '#!/bin/sh\necho "bad key $KIRO_API_KEY" >&2\nexit 1\n', { mode: 0o755 });
  const echoed = ak.testKey(
    ctx,
    'a1',
    { timeoutS: 5 },
    Object.assign({}, e.deps, { kiroCli: echo, env: { PATH: process.env.PATH } }),
  );
  take(echoed);
  assert.ok(echoed.detail.includes('[REDACTED]'));
  [
    () => ak.addByService(ctx, 'a9', 'missing', e.deps),
    () => ak.removeKey(ctx, 'a1', { deleteItem: true }, e.deps),
  ].forEach(function (f) {
    try {
      f();
    } catch (err) {
      take(err.message);
    }
  });
  take(e.argvLog.join('\n'));
  allFiles(ctx.configDir).forEach((f) => take(fs.readFileSync(f, 'utf8')));
  seen.forEach(function (s) {
    assert.ok(!s.includes(key), 'value leaked');
  });
});

test('parseArgs keeps flag values out of positionals', function () {
  const o = ak.parseArgs(['add', 'a1', '--keychain-service', 'svc', '--timeout', '5', '--delete-item']);
  assert.deepStrictEqual(o.positional, ['add', 'a1']);
  assert.strictEqual(o.keychainService, 'svc');
  assert.strictEqual(o.timeoutS, 5);
  assert.strictEqual(o.deleteItem, true);
});
