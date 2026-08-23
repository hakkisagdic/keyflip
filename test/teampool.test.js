// TEAM POOL: a shared, ENCRYPTED credential pool with role-scoped visibility. An OWNER
// machine and a MEMBER machine are two makeCtx contexts (separate config dirs + credential
// stores) sharing one pool dir + passphrase — the real topology, run locally.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as teampool from '../src/teampool.js';
import * as profiles from '../src/profiles.js';
import * as sync from '../src/sync.js';
import { makeCtx } from './helpers.js';

const PASS = 'team-pool-secret-passphrase';
function sharedDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kf-pool-')); }
function seed(ctx, name, email, blob) {
  ctx.store.setProfile(name, blob);
  profiles.write(ctx.configDir, { name: name, email: email, oauthAccount: { organizationUuid: 'org-' + name }, userID: 'u-' + name, savedAt: ctx.now() });
}
function opts(dir, extra) { return Object.assign({ dir: dir, pool: 'acme', passphrase: PASS }, extra || {}); }

// ---------------------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------------------
test('publish writes an ENCRYPTED pool file (0600) with no plaintext credentials on disk', function () {
  const dir = sharedDir();
  const A = makeCtx();
  seed(A, 'work', 'w@x.com', '{"claudeAiOauth":{"accessToken":"TOP-SECRET-AAA"}}');
  const r = teampool.publish(A, opts(dir));
  const file = teampool.poolFile(dir, 'acme');
  assert.ok(fs.existsSync(file), 'pool file exists');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'pool file is 0600');
  const raw = fs.readFileSync(file, 'utf8');
  assert.strictEqual(raw.indexOf('TOP-SECRET-AAA'), -1, 'the credential is not on disk in cleartext');
  assert.strictEqual(raw.indexOf('w@x.com'), -1, 'metadata is encrypted too');
  assert.deepStrictEqual(r.accounts, [{ name: 'work', role: 'member' }]);
  assert.deepStrictEqual(r.members, [{ id: 'owner', role: 'owner' }], 'a fresh pool seeds the publisher as sole owner');
});

test('read returns a creds-free view; loadRaw internals stay encrypted at rest', function () {
  const dir = sharedDir();
  const A = makeCtx();
  seed(A, 'work', 'w@x.com', '{"claudeAiOauth":{"accessToken":"SECRET-BBB"}}');
  teampool.publish(A, opts(dir));
  const view = teampool.read(A, opts(dir));
  assert.strictEqual(view.pool, 'acme');
  assert.strictEqual(JSON.stringify(view).indexOf('SECRET-BBB'), -1, 'read() never surfaces credentials');
  assert.deepStrictEqual(view.accounts, [{ name: 'work', email: 'w@x.com', role: 'member' }]);
  assert.strictEqual(teampool.read(A, opts(dir, { pool: 'nope' })), null, 'reading a missing pool returns null');
});

test('pull imports the visible accounts onto a fresh machine, reusing applyImport', function () {
  const dir = sharedDir();
  const A = makeCtx();
  seed(A, 'work', 'w@x.com', '{"claudeAiOauth":{"accessToken":"CRED-W"}}');
  seed(A, 'home', 'h@x.com', '{"claudeAiOauth":{"accessToken":"CRED-H"}}');
  teampool.publish(A, opts(dir)); // both default to role 'member'

  const B = makeCtx(); // teammate, empty machine
  const r = teampool.pull(B, opts(dir, { asRole: 'member' }));
  assert.deepStrictEqual(r.imported.sort(), ['home', 'work']);
  assert.deepStrictEqual(r.visible.sort(), ['home', 'work']);
  assert.strictEqual(B.store.getProfile('work'), '{"claudeAiOauth":{"accessToken":"CRED-W"}}', 'credential restored on the teammate');
  assert.strictEqual(profiles.email(B.configDir, 'home'), 'h@x.com', 'metadata restored too');

  // Re-pull skips existing accounts unless force.
  const again = teampool.pull(B, opts(dir, { asRole: 'member' }));
  assert.deepStrictEqual(again.imported, []);
  assert.deepStrictEqual(again.skipped.sort(), ['home', 'work']);
  const forced = teampool.pull(B, opts(dir, { asRole: 'member', force: true }));
  assert.deepStrictEqual(forced.imported.sort(), ['home', 'work']);
});

test('role-scoped visibility: a member sees only member-tagged accounts; an owner sees all', function () {
  const dir = sharedDir();
  const A = makeCtx();
  seed(A, 'shared', 's@x.com', '{"claudeAiOauth":{"accessToken":"SHARED"}}');
  seed(A, 'secret', 'x@corp.com', '{"claudeAiOauth":{"accessToken":"OWNER-ONLY"}}');
  teampool.publish(A, opts(dir, { accounts: { shared: 'member', secret: 'owner' } }));

  const member = makeCtx();
  const rm = teampool.pull(member, opts(dir, { asRole: 'member' }));
  assert.deepStrictEqual(rm.visible, ['shared'], 'a member cannot see the owner-only account');
  assert.strictEqual(member.store.getProfile('secret'), null, 'owner-only credential was NOT imported');

  const owner = makeCtx();
  const ro = teampool.pull(owner, opts(dir, { asRole: 'owner' }));
  assert.deepStrictEqual(ro.visible.sort(), ['secret', 'shared'], 'an owner sees everything');
  assert.strictEqual(owner.store.getProfile('secret'), '{"claudeAiOauth":{"accessToken":"OWNER-ONLY"}}');
});

test('pull as member imports nothing (and does not throw) when every account is owner-only', function () {
  const dir = sharedDir();
  const A = makeCtx();
  seed(A, 'secret', 'x@corp.com', '{"claudeAiOauth":{"accessToken":"ONLY"}}');
  teampool.publish(A, opts(dir, { accounts: { secret: 'owner' } }));
  const member = makeCtx();
  const r = teampool.pull(member, opts(dir, { asRole: 'member' }));
  assert.deepStrictEqual(r.imported, []);
  assert.deepStrictEqual(r.visible, []);
});

// ---------------------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------------------
test('members: add / list / remove; re-publish PRESERVES the roster', function () {
  const dir = sharedDir();
  const A = makeCtx();
  seed(A, 'work', 'w@x.com', '{"t":1}');
  teampool.publish(A, opts(dir, { owner: 'alice@x.com' }));
  assert.deepStrictEqual(teampool.members(A, opts(dir)), [{ id: 'alice@x.com', role: 'owner' }]);

  teampool.addMember(A, opts(dir, { id: 'bob@x.com', role: 'member' }));
  teampool.addMember(A, opts(dir, { id: 'carol@x.com', role: 'owner' }));
  const ms = teampool.members(A, opts(dir));
  assert.deepStrictEqual(ms, [
    { id: 'alice@x.com', role: 'owner' },
    { id: 'bob@x.com', role: 'member' },
    { id: 'carol@x.com', role: 'owner' },
  ]);

  // addMember upserts (changes a role, no duplicate).
  teampool.addMember(A, opts(dir, { id: 'bob@x.com', role: 'owner' }));
  assert.strictEqual(teampool.members(A, opts(dir)).find(function (m) { return m.id === 'bob@x.com'; }).role, 'owner');

  // Re-publishing the accounts must keep the roster intact.
  seed(A, 'extra', 'e@x.com', '{"t":2}');
  teampool.publish(A, opts(dir));
  assert.strictEqual(teampool.members(A, opts(dir)).length, 3, 're-publish preserves members');
  assert.deepStrictEqual(teampool.read(A, opts(dir)).accounts.map(function (a) { return a.name; }).sort(), ['extra', 'work']);

  const left = teampool.removeMember(A, opts(dir, { id: 'bob@x.com' }));
  assert.ok(!left.some(function (m) { return m.id === 'bob@x.com'; }), 'bob was removed');
});

test('members: cannot remove the last owner, and removing a non-member errors', function () {
  const dir = sharedDir();
  const A = makeCtx();
  seed(A, 'work', 'w@x.com', '{"t":1}');
  teampool.publish(A, opts(dir, { owner: 'solo@x.com' }));
  teampool.addMember(A, opts(dir, { id: 'guest@x.com', role: 'member' }));
  assert.throws(function () { teampool.removeMember(A, opts(dir, { id: 'solo@x.com' })); }, /last owner/);
  assert.throws(function () { teampool.removeMember(A, opts(dir, { id: 'ghost@x.com' })); }, /no such member/);
});

// ---------------------------------------------------------------------------------------
// Hostile / robustness
// ---------------------------------------------------------------------------------------
test('an unsafe pool name is rejected (path traversal / separators)', function () {
  const dir = sharedDir();
  const A = makeCtx();
  seed(A, 'work', 'w@x.com', '{"t":1}');
  assert.throws(function () { teampool.publish(A, opts(dir, { pool: '../evil' })); }, /invalid pool name/);
  assert.throws(function () { teampool.poolFile(dir, 'a/b'); }, /invalid pool name/);
  assert.throws(function () { teampool.poolFile(dir, '..'); }, /invalid pool name/);
  assert.strictEqual(teampool.isValidPool('acme.1_x-2'), true);
  assert.strictEqual(teampool.isValidPool('../x'), false);
  assert.strictEqual(teampool.isValidPool('a/b'), false);
});

test('a wrong passphrase cannot read and never clobbers the pool on re-publish', function () {
  const dir = sharedDir();
  const A = makeCtx();
  seed(A, 'work', 'w@x.com', '{"claudeAiOauth":{"accessToken":"KEEP-ME"}}');
  teampool.publish(A, opts(dir));
  assert.throws(function () { teampool.read(A, opts(dir, { passphrase: 'WRONG' })); }, /decrypt|passphrase/i);
  // Re-publishing with the wrong passphrase must fail rather than overwrite the pool.
  seed(A, 'work', 'w@x.com', '{"claudeAiOauth":{"accessToken":"NEW"}}');
  assert.throws(function () { teampool.publish(A, opts(dir, { passphrase: 'WRONG' })); }, /decrypt|passphrase/i);
  // The original pool (right passphrase) is intact.
  const raw = teampool.pull(makeCtx(), opts(dir, { asRole: 'owner' }));
  assert.deepStrictEqual(raw.visible, ['work']);
});

test('a missing passphrase throws everywhere (the pool carries secrets)', function () {
  const dir = sharedDir();
  const A = makeCtx();
  seed(A, 'work', 'w@x.com', '{"t":1}');
  assert.throws(function () { teampool.publish(A, { dir: dir, pool: 'acme' }); }, /passphrase/);
  assert.throws(function () { teampool.read(A, { dir: dir, pool: 'acme' }); }, /passphrase/);
  assert.throws(function () { teampool.pull(A, { dir: dir, pool: 'acme' }); }, /passphrase/);
});

test('invalid member id / role are rejected before any write', function () {
  const dir = sharedDir();
  const A = makeCtx();
  seed(A, 'work', 'w@x.com', '{"t":1}');
  teampool.publish(A, opts(dir));
  assert.throws(function () { teampool.addMember(A, opts(dir, { id: '../evil', role: 'member' })); }, /invalid member id/);
  assert.throws(function () { teampool.addMember(A, opts(dir, { id: '__proto__', role: 'member' })); }, /invalid member id/);
  assert.throws(function () { teampool.addMember(A, opts(dir, { id: 'ok@x.com', role: 'admin' })); }, /invalid role/);
  assert.throws(function () { teampool.publish(A, opts(dir, { accounts: { work: 'superuser' } })); }, /invalid role/);
  assert.strictEqual(teampool.isValidMember('a.b_c@x.com'), true);
  assert.strictEqual(teampool.isValidMember('constructor'), false);
});

test('publish of an unknown local account fails cleanly; empty selection is refused', function () {
  const dir = sharedDir();
  const A = makeCtx();
  seed(A, 'work', 'w@x.com', '{"t":1}');
  assert.throws(function () { teampool.publish(A, opts(dir, { accounts: ['work', 'ghost'] })); }, /no such local account/);
  const Empty = makeCtx();
  assert.throws(function () { teampool.publish(Empty, opts(dir)); }, /no accounts to publish/);
});

test('a decrypted pool coerces hostile shapes: bad account names dropped, unknown role tags RESTRICT', function () {
  const dir = sharedDir();
  const A = makeCtx();
  // Hand-craft a malicious plaintext pool and encrypt it with the real passphrase (models a
  // teammate/attacker who holds the shared passphrase and writes directly to the folder).
  const evil = {
    format: 'keyflip-pool', version: 1, pool: 'acme',
    members: [{ id: 'ok@x.com', role: 'owner' }, { id: '../evil', role: 'owner' }, { id: 'dup@x.com', role: 'member' }, { id: 'dup@x.com', role: 'owner' }],
    accounts: {
      good: { email: 'g@x.com', role: 'member', cliCredentials: '{"t":1}' },
      __proto__: { email: 'p@x.com', role: 'member', cliCredentials: '{"t":2}' },
      'bad name!': { role: 'member', cliCredentials: '{"t":3}' },
      tampered: { email: 't@x.com', role: 'superadmin', cliCredentials: '{"t":4}' },
      nocreds: { email: 'n@x.com', role: 'member' },
    },
    at: '2026-07-09T00:00:00Z',
  };
  fs.writeFileSync(teampool.poolFile(dir, 'acme'), sync.encrypt(JSON.stringify(evil), PASS), { mode: 0o600 });

  const view = teampool.read(A, opts(dir));
  assert.strictEqual({}.polluted, undefined, 'Object.prototype is not polluted by a "__proto__" account key');
  const names = view.accounts.map(function (a) { return a.name; });
  assert.deepStrictEqual(names.sort(), ['good', 'tampered'], 'reserved/invalid/creds-less accounts are dropped');
  assert.strictEqual(view.accounts.find(function (a) { return a.name === 'tampered'; }).role, 'owner', 'an unknown role tag is clamped to owner (restrict, never over-share)');
  assert.deepStrictEqual(view.members.map(function (m) { return m.id; }).sort(), ['dup@x.com', 'ok@x.com'], 'unsafe member id dropped, duplicate collapsed');

  // A member therefore sees the 'good' account but NOT the clamped 'tampered' one.
  const member = makeCtx();
  const r = teampool.pull(member, opts(dir, { asRole: 'member' }));
  assert.deepStrictEqual(r.visible, ['good']);
});

test('local registry records pools (non-secret) and list() returns them', function () {
  const dir = sharedDir();
  const A = makeCtx();
  seed(A, 'work', 'w@x.com', '{"t":1}');
  teampool.publish(A, opts(dir));
  const l = teampool.list(A);
  assert.strictEqual(l.length, 1);
  assert.strictEqual(l[0].pool, 'acme');
  assert.strictEqual(l[0].role, 'owner');
  const state = fs.readFileSync(teampool.statePath(A), 'utf8');
  assert.strictEqual(state.indexOf('cliCredentials'), -1, 'the registry holds no credentials');
  // A pull on another machine records it as the pulled role.
  const B = makeCtx();
  teampool.pull(B, opts(dir, { asRole: 'member' }));
  assert.strictEqual(teampool.list(B)[0].role, 'member');
});
