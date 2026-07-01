'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const transfer = require('../src/transfer');
const core = require('../src/core');
const { makeCtx, writeClaude } = require('./helpers');

function login(ctx, email, uid, tok) {
  writeClaude(ctx, { oauthAccount: { emailAddress: email }, userID: uid });
  ctx.store.setLive(tok);
}

function seeded() {
  const ctx = makeCtx();
  login(ctx, 'alice@example.com', 'u1', '{"claudeAiOauth":{"accessToken":"A"}}'); core.addCurrent(ctx);
  login(ctx, 'bob@example.com', 'u2', '{"claudeAiOauth":{"accessToken":"B"}}'); core.addCurrent(ctx);
  return ctx;
}

test('export/import round-trips accounts onto a fresh machine', function () {
  const src = seeded();
  const { envelope, skipped } = transfer.buildExport(src);
  assert.strictEqual(envelope.format, 'ccswitch-export');
  assert.strictEqual(envelope.accounts.length, 2);
  assert.deepStrictEqual(skipped, []);

  const dst = makeCtx(); // "new machine"
  const r = transfer.applyImport(dst, JSON.parse(JSON.stringify(envelope)));
  assert.deepStrictEqual(r.imported.sort(), ['alice', 'bob']);
  assert.strictEqual(dst.store.getProfile('alice'), '{"claudeAiOauth":{"accessToken":"A"}}');
  assert.strictEqual(require('../src/profiles').email(dst.configDir, 'bob'), 'bob@example.com');
});

test('import validates everything before writing anything', function () {
  const dst = makeCtx();
  const bad = { format: 'ccswitch-export', version: 1, accounts: [
    { name: 'ok', email: 'ok@x.com', cliCredentials: '{"a":1}' },
    { name: 'bad name!', email: 'b@x.com', cliCredentials: '{"a":1}' },
  ] };
  assert.throws(function () { transfer.applyImport(dst, bad); }, /invalid name/);
  assert.strictEqual(dst.store.getProfile('ok'), null); // nothing was written

  assert.throws(function () { transfer.applyImport(dst, { format: 'nope' }); }, /not a ccswitch export/);
  assert.throws(function () { transfer.applyImport(dst, { format: 'ccswitch-export', version: 99, accounts: [{}] }); }, /unsupported export version/);
  const corrupt = { format: 'ccswitch-export', version: 1, accounts: [{ name: 'x', cliCredentials: '{"trunc' }] };
  assert.throws(function () { transfer.applyImport(dst, corrupt); }, /corrupt/);
});

test('import skips existing accounts unless --force', function () {
  const src = seeded();
  const { envelope } = transfer.buildExport(src);
  const r1 = transfer.applyImport(src, envelope); // same machine: both exist
  assert.deepStrictEqual(r1.imported, []);
  assert.deepStrictEqual(r1.skipped.sort(), ['alice', 'bob']);
  const r2 = transfer.applyImport(src, envelope, { force: true });
  assert.deepStrictEqual(r2.imported.sort(), ['alice', 'bob']);
});

test('CLI export writes a 0600 file and import restores it (spawned)', function (t) {
  if (process.platform === 'win32') return t.skip('mode bits are POSIX-only');
  const BIN = path.join(__dirname, '..', 'bin', 'ccswitch.js');
  function mkhome() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-xfer-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"live":"T1"}');
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' }, userID: 'u' }));
    return home;
  }
  function run(home, args) {
    return require('child_process').spawnSync(process.execPath, [BIN].concat(args), {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), APPDATA: path.join(home, 'AppData', 'Roaming'), CCSWITCH_TEST_CLAUDE: 'stopped' }),
    });
  }
  const A = mkhome();
  run(A, ['add']);
  const file = path.join(A, 'backup.json');
  const ex = run(A, ['export', file]);
  assert.strictEqual(ex.status, 0, ex.stderr);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(ex.stdout, /CONTAINS LOGIN SECRETS/);

  const B = mkhome(); // new machine, logged out CLI is fine for import
  const im = run(B, ['import', file]);
  assert.strictEqual(im.status, 0, im.stderr);
  assert.match(run(B, ['list']).stdout, /a@x\.com/);
});
