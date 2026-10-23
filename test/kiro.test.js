// Tests for the Kiro adapter (src/kiro.js). The live Keychain, kiro-cli and the
// IDE's files can't be exercised here, so the runner is faked: `security` reads
// from an in-memory map, the helper writes to it (value on stdin), and whoami
// maps the stored access token back to an account.
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as kiro from '../src/kiro.js';

function makeCtx() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-kiro-'));
  return {
    home: home,
    platform: 'darwin',
    configDir: path.join(home, 'cfg'),
    now: function () {
      return '2026-10-19T12:00:00.000Z';
    },
  };
}

function fixture(email) {
  const hash = crypto.createHash('sha1').update(email).digest('hex');
  return {
    email: email,
    hash: hash,
    cliToken: JSON.stringify({
      access_token: 'AT-' + email,
      expires_at: '2026-11-01T00:00:00.000Z',
      refresh_token: 'RT-' + email,
      region: 'us-east-1',
      start_url: 'https://example.awsapps.com/start',
      oauth_flow: 'device',
      scopes: ['codewhisperer:completions'],
    }),
    cliReg: JSON.stringify({
      client_id: 'CID-' + email,
      client_secret: 'CS-' + email,
      client_secret_expires_at: 0,
      region: 'us-east-1',
    }),
    ideToken: JSON.stringify(
      {
        accessToken: 'IDE-AT-' + email,
        refreshToken: 'IDE-RT-' + email,
        expiresAt: '2026-11-02T00:00:00.000Z',
        clientIdHash: hash,
        authMethod: 'IdC',
        provider: 'Enterprise',
        region: 'us-east-1',
      },
      null,
      2,
    ),
    ideReg: JSON.stringify(
      { clientId: 'IDE-CID-' + email, clientSecret: 'IDE-CS-' + email, expiresAt: '2027-01-01T00:00:00.000Z' },
      null,
      2,
    ),
  };
}

function seedLive(ctx, state, fx) {
  state.kv[kiro.CLI_TOKEN_SVC] = fx.cliToken;
  state.kv[kiro.CLI_REG_SVC] = fx.cliReg;
  state.emailByToken.set(JSON.parse(fx.cliToken).access_token, fx.email);
  const dir = path.dirname(kiro.ideTokenPath(ctx));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(kiro.ideTokenPath(ctx), fx.ideToken, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, fx.hash + '.json'), fx.ideReg, { mode: 0o600 });
}

function fakeState(initial) {
  const kv = Object.assign({}, initial || {});
  const calls = [];
  const emailByToken = new Map();
  let failSet = null;
  const run = function (cmd, args, input) {
    calls.push({ cmd: cmd, args: args, input: input });
    if (cmd === '/usr/bin/security' && args[0] === 'find-generic-password') {
      const svc = args[args.indexOf('-s') + 1];
      if (!(svc in kv)) return { code: 44, stdout: '', stderr: 'not found' };
      return { code: 0, stdout: kv[svc] + '\n', stderr: '' };
    }
    if (cmd === '/fake/kfkc' && args[0] === 'set') {
      if (failSet && failSet(args[1], input)) return { code: 3, stdout: '', stderr: 'simulated failure' };
      if (!(args[1] in kv)) return { code: 3, stdout: '', stderr: 'item not found' };
      kv[args[1]] = input;
      return { code: 0, stdout: 'set ' + args[1] + ' (' + input.length + ' bytes)\n', stderr: '' };
    }
    if (cmd === '/fake/kiro-cli') {
      const tok = kv[kiro.CLI_TOKEN_SVC] ? JSON.parse(kv[kiro.CLI_TOKEN_SVC]) : null;
      const email = tok && emailByToken.get(tok.access_token);
      if (!email) return { code: 1, stdout: '', stderr: 'not logged in' };
      return { code: 0, stdout: 'Logged in.\nEmail: ' + email + '\n', stderr: '' };
    }
    if (cmd === '/usr/bin/pgrep') return { code: 1, stdout: '', stderr: '' };
    throw new Error('unexpected command: ' + cmd + ' ' + args.join(' '));
  };
  return {
    kv: kv,
    calls: calls,
    emailByToken: emailByToken,
    run: run,
    setFail: function (fn) {
      failSet = fn;
    },
  };
}

function depsFor(state, extra) {
  return Object.assign(
    {
      run: state.run,
      kiroCli: '/fake/kiro-cli',
      helper: '/fake/kfkc',
      running: [],
      now: function () {
        return '2026-10-19T12:00:00.000Z';
      },
    },
    extra || {},
  );
}

test('parseWhoami reads the email line and ignores the rest', function () {
  const out = 'Logged in with IAM Identity Center.\nEmail: FreeSkynet2026@Proton.me\n\nProfile:\nfoo\n';
  assert.strictEqual(kiro.parseWhoami(out), 'freeskynet2026@proton.me');
  assert.strictEqual(kiro.parseWhoami('not logged in'), null);
});

test('parseUsageLine reads the usage breakdown out of a nested log line', function () {
  const line =
    '2026-10-19 INFO ' +
    JSON.stringify({
      clientName: 'kiro',
      commandName: 'GetUsageLimits',
      input: { origin: 'AI_EDITOR' },
      output: {
        nextDateReset: '2026-11-01T00:00:00.000Z',
        usageBreakdownList: [
          {
            currentUsageWithPrecision: 12508.72,
            currentOveragesWithPrecision: 2508.72,
            usageLimitWithPrecision: 10000,
            unit: 'INVOCATIONS',
            nextDateReset: '2026-11-01T00:00:00.000Z',
          },
        ],
        subscriptionInfo: { type: 'Q_DEVELOPER_STANDALONE_POWER' },
        userInfo: { userId: 'd-1.abc' },
      },
      metadata: { httpStatusCode: 200 },
    });
  const u = kiro.parseUsageLine(line);
  assert.ok(u);
  assert.strictEqual(u.userId, 'd-1.abc');
  assert.strictEqual(u.current, 12508.72);
  assert.strictEqual(u.limit, 10000);
  assert.strictEqual(u.overage, 2508.72);
  assert.strictEqual(u.unit, 'INVOCATIONS');
  assert.strictEqual(u.resetAt, '2026-11-01T00:00:00.000Z');
  assert.strictEqual(u.subscriptionType, 'Q_DEVELOPER_STANDALONE_POWER');
  assert.strictEqual(kiro.parseUsageLine('no json here'), null);
});

test('capture writes 0600 surface files and a secret-free meta', function () {
  const ctx = makeCtx();
  const state = fakeState();
  const fx = fixture('live@example.com');
  seedLive(ctx, state, fx);

  const res = kiro.captureAccount(ctx, depsFor(state));
  assert.strictEqual(res.slug, 'live');
  assert.deepStrictEqual(res.captured, { cli: true, ide: true });
  const dir = kiro.accountDir(ctx, 'live');
  ['cli-token.json', 'cli-registration.json', 'ide-token.json', 'ide-registration.json', 'meta.json'].forEach(
    function (f) {
      // NTFS cannot express POSIX mode bits, so the mode assertion is POSIX-only (the file
      // contents below still prove the capture wrote what it promised).
      if (process.platform === 'win32') return;
      const st = fs.statSync(path.join(dir, f));
      assert.strictEqual(st.mode & 0o777, 0o600, f);
    },
  );
  assert.strictEqual(fs.readFileSync(path.join(dir, 'cli-token.json'), 'utf8'), fx.cliToken);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ide-token.json'), 'utf8'), fx.ideToken);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const text = JSON.stringify(meta);
  assert.ok(!text.includes('AT-'), 'meta must not contain an access token');
  assert.ok(!text.includes('RT-'), 'meta must not contain a refresh token');
  assert.ok(!text.includes('CS-'), 'meta must not contain a client secret');
  assert.strictEqual(meta.email, 'live@example.com');
  assert.strictEqual(meta.cli.expiresAt, '2026-11-01T00:00:00.000Z');
  assert.strictEqual(meta.ide.hash, fx.hash);
  assert.ok(meta.cli.registration);
  assert.ok(meta.ide.registration);
});

test('auto names disambiguate two accounts by domain, and an explicit clash is refused', function () {
  const ctx = makeCtx();
  const state = fakeState();
  const a = fixture('jane@gmail.com');
  seedLive(ctx, state, a);
  assert.strictEqual(kiro.captureAccount(ctx, depsFor(state)).slug, 'jane');

  const b = fixture('jane@hotmail.com');
  seedLive(ctx, state, b);
  assert.strictEqual(kiro.captureAccount(ctx, depsFor(state)).slug, 'jane-hotmail');

  const third = fixture('jane@yahoo.com');
  seedLive(ctx, state, third);
  assert.throws(function () {
    kiro.captureAccount(ctx, depsFor(state, { name: 'jane' }));
  }, /already exists for jane@gmail\.com/);
});

test('resolveAccount accepts an index, a name and an email', function () {
  const ctx = makeCtx();
  const state = fakeState();
  seedLive(ctx, state, fixture('one@example.com'));
  kiro.captureAccount(ctx, depsFor(state));
  seedLive(ctx, state, fixture('two@example.com'));
  kiro.captureAccount(ctx, depsFor(state));
  assert.strictEqual(kiro.resolveAccount(ctx, '1'), 'one');
  assert.strictEqual(kiro.resolveAccount(ctx, '2'), 'two');
  assert.strictEqual(kiro.resolveAccount(ctx, 'two'), 'two');
  assert.strictEqual(kiro.resolveAccount(ctx, 'one@example.com'), 'one');
  assert.strictEqual(kiro.resolveAccount(ctx, 'nope'), null);
});

test('switch writes both surfaces via stdin (never argv) and preserves the outgoing account', function () {
  const ctx = makeCtx();
  const state = fakeState();
  const a = fixture('a@example.com');
  const b = fixture('b@example.com');
  seedLive(ctx, state, a);
  kiro.captureAccount(ctx, depsFor(state));
  seedLive(ctx, state, b);
  kiro.captureAccount(ctx, depsFor(state));

  const res = kiro.switchAccount(ctx, 'a', depsFor(state));
  assert.strictEqual(res.target, 'a');
  assert.strictEqual(res.verified, true);
  assert.strictEqual(res.capturedOutgoing, 'b');
  assert.deepStrictEqual(res.wrote, ['cli-token', 'cli-registration', 'ide-token', 'ide-registration']);
  assert.strictEqual(state.kv[kiro.CLI_TOKEN_SVC], a.cliToken);
  assert.strictEqual(state.kv[kiro.CLI_REG_SVC], a.cliReg);
  assert.strictEqual(fs.readFileSync(kiro.ideTokenPath(ctx), 'utf8'), a.ideToken);
  assert.strictEqual(
    fs.readFileSync(path.join(path.dirname(kiro.ideTokenPath(ctx)), a.hash + '.json'), 'utf8'),
    a.ideReg,
  );

  const sets = state.calls.filter(function (c) {
    return c.cmd === '/fake/kfkc';
  });
  assert.strictEqual(sets.length, 2);
  sets.forEach(function (c) {
    assert.strictEqual(c.args.length, 2, 'the value must not be an argv element');
    assert.ok(c.input === a.cliToken || c.input === a.cliReg);
    assert.ok(c.args.indexOf(a.cliToken) === -1);
    assert.ok(c.args.indexOf(a.cliReg) === -1);
  });

  // The outgoing account was refreshed from the live store before the flip.
  const bTok = fs.readFileSync(path.join(kiro.accountDir(ctx, 'b'), 'cli-token.json'), 'utf8');
  assert.strictEqual(bTok, b.cliToken);
});

test('switch --dry-run writes nothing and does not spawn kiro-cli', function () {
  const ctx = makeCtx();
  const state = fakeState();
  const a = fixture('a@example.com');
  const b = fixture('b@example.com');
  seedLive(ctx, state, a);
  kiro.captureAccount(ctx, depsFor(state));
  seedLive(ctx, state, b);
  kiro.captureAccount(ctx, depsFor(state));

  const beforeCli = state.kv[kiro.CLI_TOKEN_SVC];
  const beforeIde = fs.readFileSync(kiro.ideTokenPath(ctx), 'utf8');
  const beforeCalls = state.calls.length;
  const res = kiro.switchAccount(ctx, 'a', depsFor(state, { dryRun: true }));
  assert.strictEqual(res.dryRun, true);
  const fresh = state.calls.slice(beforeCalls);
  assert.strictEqual(
    fresh.filter(function (c) {
      return c.cmd === '/fake/kfkc' || c.cmd === '/fake/kiro-cli';
    }).length,
    0,
  );
  assert.strictEqual(state.kv[kiro.CLI_TOKEN_SVC], beforeCli);
  assert.strictEqual(fs.readFileSync(kiro.ideTokenPath(ctx), 'utf8'), beforeIde);
});

test('switch refuses to flip while Kiro is running unless --force', function () {
  const ctx = makeCtx();
  const state = fakeState();
  seedLive(ctx, state, fixture('a@example.com'));
  kiro.captureAccount(ctx, depsFor(state));
  assert.throws(function () {
    kiro.switchAccount(ctx, 'a', depsFor(state, { running: ['Kiro', 'kiro_cli_desktop'] }));
  }, /quit Kiro and kiro_cli_desktop/);
  const res = kiro.switchAccount(ctx, 'a', depsFor(state, { running: ['Kiro'], force: true, noVerify: true }));
  assert.strictEqual(res.target, 'a');
});

test('switch rolls the CLI back when a later write fails', function () {
  const ctx = makeCtx();
  const state = fakeState();
  const a = fixture('a@example.com');
  const b = fixture('b@example.com');
  seedLive(ctx, state, a);
  kiro.captureAccount(ctx, depsFor(state));
  seedLive(ctx, state, b);
  kiro.captureAccount(ctx, depsFor(state));

  state.setFail(function (svc, input) {
    return svc === kiro.CLI_REG_SVC && input.indexOf('CID-a@') !== -1;
  });
  assert.throws(function () {
    kiro.switchAccount(ctx, 'a', depsFor(state));
  }, /rolled back/);
  assert.strictEqual(state.kv[kiro.CLI_TOKEN_SVC], b.cliToken);
  assert.strictEqual(state.kv[kiro.CLI_REG_SVC], b.cliReg);
  assert.strictEqual(fs.readFileSync(kiro.ideTokenPath(ctx), 'utf8'), b.ideToken);
});

test('an IDE-only capture switches without judging it against the CLI identity', function () {
  const ctx = makeCtx();
  const state = fakeState();
  const a = fixture('a@example.com');
  const b = fixture('b@example.com');
  seedLive(ctx, state, a);
  kiro.captureAccount(ctx, depsFor(state));
  seedLive(ctx, state, b);
  kiro.captureAccount(ctx, depsFor(state));
  fs.rmSync(path.join(kiro.accountDir(ctx, 'a'), 'cli-token.json'));
  fs.rmSync(path.join(kiro.accountDir(ctx, 'a'), 'cli-registration.json'));

  const res = kiro.switchAccount(ctx, 'a', depsFor(state));
  assert.strictEqual(res.verified, false);
  assert.deepStrictEqual(res.wrote, ['ide-token', 'ide-registration']);
  assert.strictEqual(fs.readFileSync(kiro.ideTokenPath(ctx), 'utf8'), a.ideToken);
  // The CLI keeps the outgoing login instead of failing the IDE switch.
  assert.strictEqual(state.kv[kiro.CLI_TOKEN_SVC], b.cliToken);
  assert.strictEqual(state.kv[kiro.CLI_REG_SVC], b.cliReg);
});

test('import decodes the legacy hex IDE capture and keeps raw CLI JSON', function () {
  const ctx = makeCtx();
  const fx = fixture('legacy@example.com');
  const legacy = {};
  legacy['keyflip:surface:kiro:legacy:token'] = fx.cliToken;
  legacy['keyflip:surface:kiro:legacy:device-registration'] = fx.cliReg;
  legacy['keyflip:surface:kiro-ide:legacy:token'] = Buffer.from(fx.ideToken, 'utf8').toString('hex');
  legacy['keyflip:surface:kiro-ide:legacy:device-registration'] = Buffer.from(fx.ideReg, 'utf8').toString('hex');
  const state = fakeState(legacy);

  const res = kiro.importLegacy(ctx, ['legacy'], depsFor(state));
  assert.strictEqual(res.imported.length, 1);
  assert.strictEqual(res.imported[0].source, 'legacy-keychain');
  const dir = kiro.accountDir(ctx, 'legacy');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'cli-token.json'), 'utf8'), fx.cliToken);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ide-token.json'), 'utf8'), fx.ideToken);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.strictEqual(meta.email, '');
  assert.strictEqual(meta.ide.hash, fx.hash);

  const again = kiro.importLegacy(ctx, ['legacy'], depsFor(state));
  assert.deepStrictEqual(again.skipped, [{ name: 'legacy', reason: 'already-exists' }]);
});

test('latestUsage reads the newest IDE log and usage() does not guess attribution', function () {
  const ctx = makeCtx();
  const logDir = path.join(
    ctx.home,
    'Library',
    'Application Support',
    'Kiro',
    'logs',
    'session',
    'window1',
    'exthost',
    'kiro.kiroAgent',
  );
  fs.mkdirSync(logDir, { recursive: true });
  const usage = {
    output: {
      usageBreakdownList: [{ currentUsageWithPrecision: 42.5, usageLimitWithPrecision: 100, unit: 'INVOCATIONS' }],
      userInfo: { userId: 'd-1.xyz' },
    },
  };
  fs.writeFileSync(path.join(logDir, 'q-client.log'), 'noise\n' + JSON.stringify(usage) + '\n');

  const state = fakeState();
  seedLive(ctx, state, fixture('live@example.com'));
  kiro.captureAccount(ctx, depsFor(state));

  const u = kiro.latestUsage(ctx, depsFor(state));
  assert.ok(u);
  assert.strictEqual(u.userId, 'd-1.xyz');
  assert.strictEqual(u.current, 42.5);
  const r = kiro.usage(ctx, 'live', depsFor(state));
  assert.strictEqual(r.account.name, 'live');
  assert.strictEqual(r.attributed, false);
});

test('status exposes expiries and never token material', function () {
  const ctx = makeCtx();
  const state = fakeState();
  const fx = fixture('live@example.com');
  seedLive(ctx, state, fx);
  kiro.captureAccount(ctx, depsFor(state));
  const st = kiro.status(ctx, depsFor(state));
  assert.strictEqual(st.live.email, 'live@example.com');
  assert.strictEqual(st.live.cli.expiresAt, '2026-11-01T00:00:00.000Z');
  assert.strictEqual(st.live.ide.hash, fx.hash);
  assert.strictEqual(st.accounts.length, 1);
  const text = JSON.stringify(st);
  assert.ok(!text.includes('AT-'));
  assert.ok(!text.includes('RT-'));
  assert.ok(!text.includes('CS-'));
});

test('ensureHelper compiles once and skips the compiler while the binary exists', function () {
  const ctx = makeCtx();
  let compiles = 0;
  const run = function (cmd, args) {
    if (cmd === 'xcrun')
      return { code: 0, stdout: '/Library/Developer/CommandLineTools/SDKs/MacOSX27.0.sdk\n', stderr: '' };
    assert.strictEqual(cmd, 'cc');
    compiles += 1;
    const bin = args[args.indexOf('-o') + 1];
    fs.writeFileSync(bin, 'binary', { mode: 0o700 });
    return { code: 0, stdout: '', stderr: '' };
  };
  const first = kiro.ensureHelper(ctx, { run: run });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(compiles, 1);
  const src = fs.readFileSync(path.join(kiro.surfaceRoot(ctx), '.bin', 'kfkc.c'), 'utf8');
  assert.ok(src.indexOf('SecItemUpdate') !== -1);
  const second = kiro.ensureHelper(ctx, { run: run });
  assert.strictEqual(second.ok, true);
  assert.strictEqual(compiles, 1);
});
