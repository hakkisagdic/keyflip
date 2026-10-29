// commandcode.test.js — the Command Code surface adapter (src/commandcode.js).
// One auth.json is shared by the CLI and the shipped VS Code extension, so these
// tests exercise a temp HOME, synthetic keys, and assert that no key ever leaks
// into meta.json, status() output or the public account list.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as cc from '../src/commandcode.js';
import { makeCtx, assertPrivateMode } from './helpers.js';

function authFor(name, opts) {
  opts = opts || {};
  const auth = {
    apiKey: 'cc-key-' + name,
    userId: opts.userId || 'user-' + name,
    userName: name,
    keyName: 'key-' + name,
    authenticatedAt: opts.authenticatedAt || '2026-01-01T00:00:00.000Z',
  };
  (opts.providers || []).forEach(function (p) {
    auth[p] = { type: 'api', key: 'sk-' + p + '-' + name };
  });
  return auth;
}

function ctxFor() {
  const ctx = makeCtx();
  ctx.commandCodeHome = path.join(ctx.home, '.commandcode');
  fs.mkdirSync(ctx.commandCodeHome, { recursive: true });
  return ctx;
}

function writeLive(ctx, auth) {
  const p = cc.authPath(ctx);
  fs.writeFileSync(p, JSON.stringify(auth, null, 2), { mode: 0o600 });
  return p;
}

function ticks() {
  let n = 0;
  return function () {
    n += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  };
}

function assertNoSecret(obj) {
  const text = JSON.stringify(obj);
  assert.strictEqual(text.indexOf('cc-key-'), -1, 'a Command Code apiKey leaked: ' + text);
  assert.strictEqual(text.indexOf('sk-'), -1, 'a provider key leaked: ' + text);
}

test('identityFromAuth reports user, key name and provider ids — never a key', function () {
  const id = cc.identityFromAuth(authFor('alpha', { providers: ['deepseek', 'groq'] }));
  assert.strictEqual(id.userName, 'alpha');
  assert.strictEqual(id.userId, 'user-alpha');
  assert.strictEqual(id.keyName, 'key-alpha');
  assert.strictEqual(id.hasApiKey, true);
  assert.deepStrictEqual(id.providers, ['deepseek', 'groq']);
  assertNoSecret(id);

  assert.strictEqual(cc.identityFromAuth(null), null);
  assert.strictEqual(cc.identityFromAuth([]), null);
  assert.deepStrictEqual(cc.identityFromAuth({ apiKey: 'x' }).providers, []);
});

test('readAuth: missing, corrupt, non-object and signed-in states', function () {
  const ctx = ctxFor();
  const file = cc.authPath(ctx);

  let r = cc.readAuth(file);
  assert.strictEqual(r.present, false);
  assert.strictEqual(r.raw, null);

  fs.writeFileSync(file, 'not json', { mode: 0o600 });
  r = cc.readAuth(file);
  assert.strictEqual(r.present, true);
  assert.strictEqual(r.auth, null);
  assert.match(r.error, /not valid JSON/);

  fs.writeFileSync(file, '[1,2]', { mode: 0o600 });
  r = cc.readAuth(file);
  assert.match(r.error, /not a JSON object/);

  writeLive(ctx, { userId: 'u1' });
  r = cc.readAuth(file);
  assert.strictEqual(r.present, true);
  assert.strictEqual(r.signedIn, false, 'a userId without an apiKey is not signed in');

  writeLive(ctx, authFor('alpha'));
  r = cc.readAuth(file);
  assert.strictEqual(r.signedIn, true);
  assert.strictEqual(r.identity.hasApiKey, true);
  assertNoSecret(r.identity);
});

test('capture: slug from userName, 0600 files, secret-free meta, idempotent re-capture', function () {
  const ctx = ctxFor();
  writeLive(ctx, authFor('Alpha User', { providers: ['deepseek'] }));

  const c = cc.capture(ctx, { now: ticks() });
  assert.strictEqual(c.slug, 'alpha-user');
  assertNoSecret(c.meta);
  assert.strictEqual(c.meta.providers[0], 'deepseek');

  assertPrivateMode(path.join(cc.accountDir(ctx, 'alpha-user'), 'auth.json'), 'captured auth.json');
  assertPrivateMode(path.join(cc.accountDir(ctx, 'alpha-user'), 'meta.json'), 'captured meta.json');
  const meta = JSON.parse(fs.readFileSync(path.join(cc.accountDir(ctx, 'alpha-user'), 'meta.json'), 'utf8'));
  assert.strictEqual(meta.schemaVersion, 1);
  assert.strictEqual(meta.userName, 'Alpha User');
  assert.strictEqual(meta.source, 'live');
  assertNoSecret(meta);

  const again = cc.capture(ctx);
  assert.strictEqual(again.slug, 'alpha-user', 'the same identity re-captures into the same slot');

  assert.deepStrictEqual(
    cc.listAccounts(ctx).map((a) => a.name),
    ['alpha-user'],
  );
  assertNoSecret(cc.listAccounts(ctx));
});

test('capture: explicit name is validated and a name cannot be taken over by another identity', function () {
  const ctx = ctxFor();
  writeLive(ctx, authFor('alpha'));
  assert.strictEqual(cc.capture(ctx, { name: 'work' }).slug, 'work');
  assert.throws(() => cc.capture(ctx, { name: 'bad name!' }), /invalid account name/);

  writeLive(ctx, authFor('beta'));
  assert.throws(() => cc.capture(ctx, { name: 'work' }), /already exists/);
  assert.strictEqual(cc.capture(ctx).slug, 'beta', 'no explicit name → auto slug for the new identity');
});

test('capture: refuses a missing or corrupt live login', function () {
  const ctx = ctxFor();
  assert.throws(() => cc.capture(ctx), /is missing/);

  fs.writeFileSync(cc.authPath(ctx), '{oops', { mode: 0o600 });
  assert.throws(() => cc.capture(ctx), /unreadable\/corrupt/);

  writeLive(ctx, { userId: 'u1' });
  assert.throws(() => cc.capture(ctx), /has no Command Code login/);
});

test('status: identity, config provider/model, accounts and the env override flag', function () {
  const ctx = ctxFor();
  writeLive(ctx, authFor('alpha'));
  cc.capture(ctx);
  fs.writeFileSync(cc.configPath(ctx), JSON.stringify({ provider: 'deepseek', model: 'deepseek-chat' }), {
    mode: 0o600,
  });

  const prev = process.env.COMMAND_CODE_API_KEY;
  try {
    delete process.env.COMMAND_CODE_API_KEY;
    let s = cc.status(ctx);
    assert.strictEqual(s.surface, 'command-code');
    assert.strictEqual(s.signedIn, true);
    assert.strictEqual(s.identity.userName, 'alpha');
    assert.strictEqual(s.provider, 'deepseek');
    assert.strictEqual(s.model, 'deepseek-chat');
    assert.strictEqual(s.envOverride, false);
    assert.deepStrictEqual(
      s.accounts.map((a) => a.name),
      ['alpha'],
    );
    assert.ok(s.bin && typeof s.bin.onPath === 'boolean');
    assertNoSecret(s);

    process.env.COMMAND_CODE_API_KEY = 'sk-env';
    s = cc.status(ctx);
    assert.strictEqual(s.envOverride, true, 'an exported env key overrides auth.json and must be reported');
    assertNoSecret(s);
  } finally {
    if (prev === undefined) delete process.env.COMMAND_CODE_API_KEY;
    else process.env.COMMAND_CODE_API_KEY = prev;
  }
});

test('switchTo: dry-run never writes, a real switch captures the outgoing account, backs up and verifies', function () {
  const ctx = ctxFor();
  const now = ticks();
  writeLive(ctx, authFor('alpha'));
  cc.capture(ctx, { now: now });
  writeLive(ctx, authFor('beta'));
  cc.capture(ctx, { now: now });

  const betaRaw = fs.readFileSync(cc.authPath(ctx), 'utf8');

  const plan = cc.switchTo(ctx, 'alpha', { dryRun: true, now: now });
  assert.strictEqual(plan.dryRun, true);
  assert.strictEqual(plan.plan.userName, 'alpha');
  assert.strictEqual(fs.readFileSync(cc.authPath(ctx), 'utf8'), betaRaw, 'dry-run must not touch auth.json');

  const r = cc.switchTo(ctx, 'alpha', { now: now });
  assert.strictEqual(r.dryRun, false);
  assert.strictEqual(r.slug, 'alpha');
  assert.strictEqual(r.verified, true);
  assert.strictEqual(r.capturedOutgoing, 'beta', 'the account being replaced is captured before the write');
  assert.ok(r.backup && fs.statSync(r.backup).isFile());

  const live = cc.readAuth(cc.authPath(ctx));
  assert.strictEqual(live.identity.userName, 'alpha');
  assert.strictEqual(live.identity.hasApiKey, true);
  assertPrivateMode(cc.authPath(ctx), 'live auth.json after switch');

  assert.deepStrictEqual(
    cc.listAccounts(ctx).map((a) => a.name),
    ['alpha', 'beta'],
  );
});

test('switchTo resolves by name, index and userName, and refuses unknown or corrupt captures', function () {
  const ctx = ctxFor();
  writeLive(ctx, authFor('alpha'));
  cc.capture(ctx);
  writeLive(ctx, authFor('beta'));
  cc.capture(ctx);

  assert.strictEqual(cc.resolveAccount(ctx, 'ALPHA'), 'alpha');
  assert.strictEqual(cc.resolveAccount(ctx, 'user-beta'), 'beta');
  assert.strictEqual(cc.resolveAccount(ctx, '1'), 'alpha');
  assert.strictEqual(cc.resolveAccount(ctx, '3'), null);
  assert.strictEqual(cc.resolveAccount(ctx, 'nope'), null);
  assert.throws(() => cc.switchTo(ctx, 'nope'), /no such Command Code account/);

  fs.rmSync(path.join(cc.accountDir(ctx, 'alpha'), 'auth.json'));
  assert.throws(() => cc.switchTo(ctx, 'alpha'), /no readable auth\.json/);
});

test('backups: listed newest-first, restorable by index and prefix', function () {
  const ctx = ctxFor();
  const now = ticks();
  writeLive(ctx, authFor('alpha'));
  cc.capture(ctx, { now: now });
  writeLive(ctx, authFor('beta'));
  cc.capture(ctx, { now: now });
  writeLive(ctx, authFor('gamma'));
  cc.capture(ctx, { now: now });

  cc.switchTo(ctx, 'alpha', { now: now }); // backs up gamma
  cc.switchTo(ctx, 'beta', { now: now }); // backs up alpha
  const backups = cc.listBackups(ctx);
  assert.strictEqual(backups.length, 2);
  assert.strictEqual(backups[0].userName, 'alpha', 'newest backup first');
  assert.strictEqual(backups[1].userName, 'gamma');
  assertNoSecret(backups);
  backups.forEach((b) => assertPrivateMode(b.path, 'backup ' + b.file));

  assert.strictEqual(cc.resolveBackup(ctx, '1').file, backups[0].file);
  assert.strictEqual(cc.resolveBackup(ctx, backups[1].file).file, backups[1].file);
  assert.strictEqual(cc.resolveBackup(ctx, 'zzz'), null);
  assert.throws(() => cc.restoreBackup(ctx, 'zzz'), /no such Command Code backup/);

  const r = cc.restoreBackup(ctx, '1', { now: now });
  assert.strictEqual(r.restored, backups[0].file);
  assert.strictEqual(cc.readAuth(cc.authPath(ctx)).identity.userName, 'alpha');

  const plan = cc.restoreBackup(ctx, '2', { dryRun: true, now: now });
  assert.strictEqual(plan.dryRun, true);
});

test('backups: retention keeps only the newest BACKUP_KEEP files', function () {
  const ctx = ctxFor();
  let n = 0;
  const now = function () {
    n += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  };
  writeLive(ctx, authFor('alpha'));
  cc.capture(ctx, { now: now });
  writeLive(ctx, authFor('beta'));
  cc.capture(ctx, { now: now });

  // Each switch backs up what is live. Alternate between the two captures.
  for (let i = 0; i < 12; i += 1) cc.switchTo(ctx, i % 2 === 0 ? 'alpha' : 'beta', { now: now });
  const backups = cc.listBackups(ctx);
  assert.strictEqual(backups.length, 10);

  // Removing the live file mid-way must not break backup creation.
  const r = cc.restoreBackup(ctx, '1', { now: now });
  assert.ok(r.restored);
});

test('removeAccount: requires --force and removes only that capture', function () {
  const ctx = ctxFor();
  writeLive(ctx, authFor('alpha'));
  cc.capture(ctx);
  writeLive(ctx, authFor('beta'));
  cc.capture(ctx);

  assert.throws(() => cc.removeAccount(ctx, 'alpha'), /without --force/);
  assert.ok(cc.loadBundle(ctx, 'alpha'), 'nothing removed without force');

  assert.deepStrictEqual(cc.removeAccount(ctx, 'beta', { force: true }), { removed: 'beta' });
  assert.strictEqual(cc.loadBundle(ctx, 'beta'), null);
  assert.ok(cc.loadBundle(ctx, 'alpha'));
  assert.throws(() => cc.removeAccount(ctx, 'beta', { force: true }), /no such Command Code account/);
});
