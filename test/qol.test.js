'use strict';
// Batch D: backup (#6), keyflip:// share/import (#11), skill freshness (#10).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const backup = require('../src/backup');
const share = require('../src/share');
const skill = require('../src/skill');
const provider = require('../src/provider');
const profiles = require('../src/profiles');
const { makeCtx } = require('./helpers');

// ---- #6 backup ----
test('backup snapshots metadata (not creds), lists, prunes, and restores with a safety copy', function () {
  const ctx = makeCtx();
  profiles.write(ctx.configDir, { name: 'alice', email: 'a@x.com' });
  fs.mkdirSync(path.join(ctx.configDir, 'creds'), { recursive: true });
  fs.writeFileSync(path.join(ctx.configDir, 'creds', 'alice.cred'), 'SECRET');

  let n = 0;
  ctx.now = function () { return '2026-07-02T09:00:0' + (n++) + '.000Z'; }; // distinct stamps
  const b1 = backup.create(ctx);
  assert.ok(b1.files >= 1);
  // creds must NOT be in the backup (secrets excluded)
  assert.strictEqual(fs.existsSync(path.join(b1.path, 'creds')), false);
  assert.ok(fs.existsSync(path.join(b1.path, 'alice.json')));

  const list = backup.list(ctx);
  assert.ok(list.length >= 1);

  // mutate then restore
  fs.rmSync(profiles.metaPath ? profiles.metaPath(ctx.configDir, 'alice') : path.join(ctx.configDir, 'alice.json'), { force: true });
  const r = backup.restore(ctx, 1);
  assert.ok(fs.existsSync(path.join(ctx.configDir, 'alice.json')));      // restored
  assert.ok(backup.list(ctx).some(function (b) { return /pre-restore/.test(b.name); })); // safety backup taken
});

test('backup prune keeps only the newest N', function () {
  const ctx = makeCtx();
  profiles.write(ctx.configDir, { name: 'a', email: 'a@x.com' });
  let n = 0; ctx.now = function () { return '2026-07-02T10:00:' + String(n++).padStart(2, '0') + '.000Z'; };
  for (let i = 0; i < 5; i++) backup.create(ctx, { keep: 100 });
  backup.prune(ctx, 2);
  assert.strictEqual(backup.list(ctx).length, 2);
});

// ---- #11 share ----
test('share build->parse round-trips a provider; preview redacts the key', function () {
  const ctx = makeCtx();
  provider.add(ctx, 'relay', { baseUrl: 'https://relay/v1', key: 'sk-abcd1234', authScheme: 'bearer', models: { default: 'm' } });
  const url = share.build(ctx, 'provider', 'relay');
  assert.match(url, /^keyflip:\/\/v1\/import\?resource=provider&name=relay&config=/);
  const parsed = share.parse(url);
  assert.strictEqual(parsed.config.baseUrl, 'https://relay/v1');
  assert.strictEqual(parsed.config.key, 'sk-abcd1234');
  assert.match(share.preview(parsed), /\*\*\*1234/);       // redacted in preview
  assert.doesNotMatch(share.preview(parsed), /sk-abcd1234/);
});

test('share --no-secrets omits the key; apply recreates the provider', function () {
  const ctx = makeCtx();
  provider.add(ctx, 'relay', { baseUrl: 'https://relay/v1', key: 'sk-x', authScheme: 'bearer' });
  const url = share.build(ctx, 'provider', 'relay', { noSecrets: true });
  const parsed = share.parse(url);
  assert.strictEqual(parsed.config.key, undefined);
  const dst = makeCtx();
  share.apply(dst, parsed);
  assert.ok(provider.exists(dst, 'relay'));
  assert.strictEqual(provider.read(dst, 'relay').baseUrl, 'https://relay/v1');
});

test('account share is pointer-only (never carries the OAuth token)', function () {
  const ctx = makeCtx();
  profiles.write(ctx.configDir, { name: 'alice', email: 'a@x.com', oauthAccount: { emailAddress: 'a@x.com' } });
  ctx.store.setProfile('alice', 'SECRET-TOKEN');
  const url = share.build(ctx, 'account', 'alice');
  assert.doesNotMatch(share.b64urlDecode(url.split('config=')[1]), /SECRET-TOKEN/);
});

test('parse rejects a non-keyflip or malformed link', function () {
  assert.throws(function () { share.parse('https://evil/'); }, /keyflip/);
  assert.throws(function () { share.parse('keyflip://v1/import?resource=bogus&name=x&config=e30'); }, /resource/);
});

// ---- #10 skill freshness ----
test('skill fingerprint is content-sensitive and detects drift', function () {
  const src = skill.sourceDir();
  const fp1 = skill.fingerprint(src);
  assert.match(fp1, /^[0-9a-f]{64}$/);
  const ctx = makeCtx();
  const r = skill.install(ctx);
  assert.strictEqual(skill.status(ctx), 'current');
  // drift: edit the installed copy (resolve through the symlink target safely)
  const real = fs.realpathSync(r.dest);
  // install into a copy dir to mutate without touching the package source
  const copy = path.join(ctx.home, 'copyskill');
  fs.cpSync(real, copy, { recursive: true });
  fs.appendFileSync(path.join(copy, 'SKILL.md'), '\nextra\n');
  assert.notStrictEqual(skill.fingerprint(copy), fp1);
});
