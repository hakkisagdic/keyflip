// Independent checks for the review fix: Keychain-held secrets are backed up before a --force import.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as stream from '../src/migrate-stream.js';
import * as migrateMod from '../src/migrate.js';
import * as profiles from '../src/profiles.js';
import * as provider from '../src/provider.js';
import { makeCtx } from './helpers.js';

async function makeBundle() {
  const src = makeCtx();
  src.store.setProfile('work', '{"token":"NEW-CANARY"}');
  profiles.write(src.configDir, { name: 'work', email: 'a@x.com', oauthAccount: {}, savedAt: src.now() });
  provider.add(src, 'relay', { baseUrl: 'https://relay.example', authScheme: 'api-key', key: 'sk-new' });
  const plan = migrateMod.planExport(src, {});
  const out = path.join(src.home, 'b.kf');
  await stream.writeBundle({ out, meta: plan.meta, files: plan.files });
  return out;
}
function keychainDst() {
  const dst = makeCtx();
  dst.store.type = 'keychain';
  dst.store.setProfile('work', '{"token":"OLD-CANARY"}');
  profiles.write(dst.configDir, { name: 'work', email: 'old@x.com', oauthAccount: {}, savedAt: dst.now() });
  provider.add(dst, 'relay', { baseUrl: 'https://relay.example', authScheme: 'api-key', key: 'sk-old' });
  return dst;
}

test('QA: streamed --force import on a keychain-type store keeps the old secrets in <backup>/store (0600/0700)', async function () {
  const out = await makeBundle();
  const dst = keychainDst();
  assert.ok(!fs.existsSync(path.join(dst.configDir, 'creds')));
  const backup = migrateMod.createImportBackup(dst, { force: true });
  await stream.importBundle({ ctx: dst, input: out, force: true, backup });
  assert.strictEqual(dst.store.getProfile('work'), '{"token":"NEW-CANARY"}');
  const sd = path.join(backup.dir, 'store');
  assert.strictEqual(fs.readFileSync(path.join(sd, 'work.cred'), 'utf8'), '{"token":"OLD-CANARY"}');
  assert.strictEqual(fs.readFileSync(path.join(sd, 'provider__relay.cred'), 'utf8'), 'sk-old');
  assert.strictEqual(fs.statSync(sd).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(path.join(sd, 'work.cred')).mode & 0o777, 0o600);
});

test('QA: --force with an unreadable store aborts before any write; nothing changes', async function () {
  const out = await makeBundle();
  const dst = keychainDst();
  const real = dst.store.getProfile.bind(dst.store);
  dst.store.getProfile = function () {
    const e = new Error('locked');
    e.code = 'EKEYCHAIN';
    throw e;
  };
  const backup = migrateMod.createImportBackup(dst, { force: true });
  await assert.rejects(stream.importBundle({ ctx: dst, input: out, force: true, backup }), function (e) {
    return e.code === 'NEED_STORE';
  });
  dst.store.getProfile = real;
  assert.strictEqual(dst.store.getProfile('work'), '{"token":"OLD-CANARY"}');
  assert.strictEqual(profiles.read(dst.configDir, 'work').email, 'old@x.com');
});

test('QA: without --force an unreadable store does not block (conflicts are refused later)', async function () {
  const dst = makeCtx();
  dst.store.getProfile = function () {
    const e = new Error('locked');
    e.code = 'EKEYCHAIN';
    throw e;
  };
  const backup = migrateMod.createImportBackup(dst, { force: false });
  assert.doesNotThrow(function () {
    backup.start({ accounts: [{ name: 'work' }], providers: [] });
  });
});
