'use strict';
// FLEET: multi-machine control plane over an encrypted shared rendezvous dir. Two machines are
// two makeCtx contexts (separate config dirs, separate credential stores) sharing one fleet dir
// + passphrase — exactly the real topology, just local.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fleet = require('../src/fleet');
const profiles = require('../src/profiles');
const { makeCtx } = require('./helpers');

const PASS = 'fleet-secret-passphrase';
function sharedDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kf-fleet-')); }
function machine(name, dir) {
  const ctx = makeCtx();
  ctx.claudeDir = path.join(ctx.home, '.claude');
  fs.mkdirSync(path.join(ctx.claudeDir, 'projects'), { recursive: true });
  fleet.setConfig(ctx, { name: name, dir: dir });
  return ctx;
}
function seedAccount(ctx, name, email, blob) {
  ctx.store.setProfile(name, blob);
  profiles.write(ctx.configDir, { name: name, email: email, oauthAccount: { organizationUuid: 'org-' + name }, userID: 'u' + name, savedAt: ctx.now() });
}
function busOf(ctx, dir) { return fleet.bus(ctx, { dir: dir, passphrase: PASS }); }

test('identity is stable + persisted per machine', function () {
  const ctx = makeCtx();
  const a = fleet.identity(ctx);
  assert.ok(a.machineId && a.name);
  assert.strictEqual(fleet.identity(ctx).machineId, a.machineId, 'same id on re-read');
});

test('publish + readFleet: each machine sees the others', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir), B = machine('beta', dir);
  seedAccount(A, 'work', 'a@x.com', '{"token":"AAA"}');
  seedAccount(B, 'home', 'b@x.com', '{"token":"BBB"}');
  fleet.publish(A, busOf(A, dir), {});
  fleet.publish(B, busOf(B, dir), {});
  const seenByA = fleet.readFleet(A, busOf(A, dir));
  assert.strictEqual(seenByA.length, 2);
  assert.deepStrictEqual(seenByA.map(function (s) { return s.name; }).sort(), ['alpha', 'beta']);
  assert.ok(seenByA.find(function (s) { return s.name === 'beta'; }).accounts.some(function (a) { return a.name === 'home'; }));
});

test('rendezvous files are ENCRYPTED (wrong passphrase cannot read)', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir);
  seedAccount(A, 'work', 'a@x.com', '{"token":"SECRET-AAA"}');
  fleet.publish(A, busOf(A, dir), { withSecrets: true });
  const raw = fs.readFileSync(path.join(dir, fleet.statusName(fleet.identity(A).machineId)), 'utf8');
  assert.strictEqual(raw.indexOf('SECRET-AAA'), -1, 'the credential is not on disk in cleartext');
  const wrong = fleet.bus(A, { dir: dir, passphrase: 'WRONG' });
  assert.deepStrictEqual(fleet.readFleet(A, wrong), [], 'a wrong passphrase decrypts nothing');
});

test('remote switch: A queues a switch for B; B drains + applies it', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir), B = machine('beta', dir);
  seedAccount(B, 'home', 'b@x.com', '{"claudeAiOauth":{"accessToken":"BBB"}}');
  seedAccount(B, 'work', 'bw@x.com', '{"claudeAiOauth":{"accessToken":"BW"}}');
  const bId = fleet.identity(B).machineId;
  fleet.queue(A, busOf(A, dir), bId, { type: 'switch', payload: { account: 'work' } });
  // B processes its inbox
  const cmds = fleet.readInbox(B, busOf(B, dir));
  assert.strictEqual(cmds.length, 1);
  const res = fleet.applyCommand(B, cmds[0], { allowSwitch: true });
  assert.ok(res.ok && /switched to work/.test(res.detail));
  const skipped = fleet.applyCommand(B, cmds[0], {}); // no consent
  assert.ok(!skipped.ok && /consent/.test(skipped.detail));
});

test('account distribution C->B, orchestrated from A', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir), B = machine('beta', dir), C = machine('gamma', dir);
  seedAccount(C, 'clientX', 'x@corp.com', '{"claudeAiOauth":{"accessToken":"CX-CRED"}}');
  // C publishes WITH secrets so its credentials are available to the fleet (encrypted)
  fleet.publish(C, busOf(C, dir), { withSecrets: true });
  // A reads C's published account and queues a save-account into B's inbox
  const cStatus = fleet.readFleet(A, busOf(A, dir)).find(function (s) { return s.name === 'gamma'; });
  const account = fleet.accountFrom(cStatus, 'clientX');
  assert.ok(account && account.cliCredentials.indexOf('CX-CRED') !== -1);
  fleet.queue(A, busOf(A, dir), fleet.identity(B).machineId, { type: 'save-account', payload: { account: account } });
  // B drains + saves it
  const cmd = fleet.readInbox(B, busOf(B, dir))[0];
  const res = fleet.applyCommand(B, cmd, { allowSave: true });
  assert.ok(res.ok, res.detail);
  assert.strictEqual(B.store.getProfile('clientX'), '{"claudeAiOauth":{"accessToken":"CX-CRED"}}', 'B now holds C\'s account');
});

test('chat-status: a session whose last message is the assistant is "replied"', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir);
  const pdir = path.join(A.claudeDir, 'projects', '-p'); fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, 'sReplied.jsonl'),
    '{"type":"user","cwd":"/p","message":{"role":"user","content":"do X"}}\n' +
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n');
  fs.writeFileSync(path.join(pdir, 'sWaiting.jsonl'),
    '{"type":"user","cwd":"/p","message":{"role":"user","content":"are you there?"}}\n');
  const st = fleet.buildStatus(A, {});
  const replied = st.chats.find(function (c) { return c.sessionId === 'sReplied'; });
  const waiting = st.chats.find(function (c) { return c.sessionId === 'sWaiting'; });
  assert.strictEqual(replied.replied, true);
  assert.strictEqual(waiting.replied, false);
});

test('newReplies flags a chat that got a reply since the last snapshot', function () {
  const ctx = makeCtx();
  const s1 = [{ machineId: 'm1', name: 'beta', chats: [{ sessionId: 's', mtime: '2026-07-07T10:00:00Z', lastRole: 'user', replied: false, lastText: 'q' }] }];
  const first = fleet.newReplies(ctx, s1);
  assert.strictEqual(first.newReplies.length, 0);
  fleet.saveSeen(ctx, first.snapshot);
  const s2 = [{ machineId: 'm1', name: 'beta', chats: [{ sessionId: 's', mtime: '2026-07-07T10:05:00Z', lastRole: 'assistant', replied: true, lastText: 'answer' }] }];
  const second = fleet.newReplies(ctx, s2);
  assert.strictEqual(second.newReplies.length, 1);
  assert.strictEqual(second.newReplies[0].machine, 'beta');
});

test('fleet.json does not pollute the account list (RESERVED)', function () {
  const ctx = makeCtx();
  profiles.write(ctx.configDir, { name: 'real', email: 'r@x.com', oauthAccount: {}, savedAt: ctx.now() });
  ctx.store.setProfile('real', '{"token":"x"}');
  fleet.setConfig(ctx, { name: 'thismachine', dir: '/tmp/x' });
  fleet.saveSeen(ctx, { k: 'v' });
  const names = require('../src/core').listProfiles(ctx).map(function (p) { return p.name; });
  assert.ok(names.indexOf('fleet') === -1 && names.indexOf('fleet-seen') === -1, 'fleet.json/fleet-seen.json are not accounts');
  assert.ok(names.indexOf('real') !== -1);
});

// ============================================================================
// Post-review hardening (2026-07-07) — regression tests. Each guards a CONFIRMED
// finding from the fleet adversarial review (23 findings, 3-lens verified).
// ============================================================================
const sync = require('../src/sync');
function writeRaw(dir, name, obj) { fs.writeFileSync(path.join(dir, name), sync.encrypt(JSON.stringify(obj), PASS), { mode: 0o600 }); }

test('P0 cred leak: readFleet keeps creds for relay, sanitizeStatus strips them for display', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir);
  seedAccount(A, 'work', 'a@x.com', '{"claudeAiOauth":{"accessToken":"TOP-SECRET"}}');
  fleet.publish(A, busOf(A, dir), { withSecrets: true });
  const raw = fleet.readFleet(A, busOf(A, dir))[0];
  assert.ok(raw.creds && raw.creds.work && raw.creds.work.cliCredentials.indexOf('TOP-SECRET') !== -1, 'relay path still sees creds');
  const shown = fleet.sanitizeStatus(raw);
  assert.strictEqual(shown.creds, undefined, 'display projection has NO creds');
  assert.strictEqual(JSON.stringify(shown).indexOf('TOP-SECRET'), -1, 'no secret anywhere in the display JSON');
  assert.ok(shown.name === 'alpha' && Array.isArray(shown.accounts), 'display fields preserved');
});

test('P1 path traversal: a peer status claiming a ../ machineId is dropped by readFleet', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir);
  writeRaw(dir, 'evil.status.enc', { machineId: '../../../../etc/passwd', name: 'evil', accounts: [], chats: [] });
  const seen = fleet.readFleet(A, busOf(A, dir));
  assert.ok(!seen.some(function (s) { return s.name === 'evil'; }), 'traversal machineId never enters the roster');
});

test('P1 path traversal: statusName/inboxName/queue reject an unsafe machine id', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir);
  assert.throws(function () { fleet.statusName('../x'); }, /unsafe/);
  assert.throws(function () { fleet.inboxName('a/b'); }, /unsafe/);
  assert.throws(function () { fleet.queue(A, busOf(A, dir), '../../evil', { type: 'note' }); }, /invalid target/);
  assert.strictEqual(fleet.safeId('good-id.1'), true);
  assert.strictEqual(fleet.safeId('../evil'), false);
  assert.strictEqual(fleet.safeId('a/b'), false);
});

test('P1 spoofing: a status whose filename stem != claimed machineId is dropped (identity binding)', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir);
  writeRaw(dir, 'spoof.status.enc', { machineId: 'realmachine', name: 'impostor', accounts: [], chats: [] });
  const seen = fleet.readFleet(A, busOf(A, dir));
  assert.ok(!seen.some(function (s) { return s.name === 'impostor'; }), 'a machine cannot publish under another id');
});

test('P2 RESERVED overwrite: an inbound save-account named "fleet" is rejected (cannot clobber fleet.json)', function () {
  assert.strictEqual(profiles.isValidName('fleet'), false);
  assert.strictEqual(profiles.isValidName('fleet-seen'), false);
  assert.strictEqual(profiles.isValidName('normalname'), true);
  const B = machine('beta', sharedDir());
  const res = fleet.applyCommand(B, { type: 'save-account', payload: { account: { name: 'fleet', cliCredentials: '{"x":1}' } } }, { allowSave: true });
  assert.ok(!res.ok, 'save-account of a reserved name fails');
  assert.strictEqual(B.store.getProfile('fleet') || null, null, 'no reserved profile was written');
});

test('P2 replay: an already-applied command id is remembered and a stale command is rejected', function () {
  const ctx = makeCtx();
  ctx.now = function () { return '2026-07-07T12:00:00Z'; };
  assert.strictEqual(fleet.wasApplied(ctx, 'abc'), false);
  fleet.markApplied(ctx, 'abc');
  assert.strictEqual(fleet.wasApplied(ctx, 'abc'), true, 'applied id persists');
  assert.strictEqual(fleet.commandFresh(ctx, { at: '2026-07-07T11:59:00Z' }), true, 'a fresh command passes');
  assert.strictEqual(fleet.commandFresh(ctx, { at: '2026-06-01T00:00:00Z' }), false, 'a week-old command is expired');
  assert.strictEqual(fleet.commandFresh(ctx, { at: '2027-01-01T00:00:00Z' }), false, 'a far-future command is rejected');
});

test('robustness: normalizeStatus coerces hostile peer fields (non-array chats, control chars)', function () {
  const n = fleet.normalizeStatus({ machineId: 'm1', name: 'ok\x1b[31mRED', chats: 'not-an-array', accounts: null, activeEmail: 42 });
  assert.strictEqual(n.name.indexOf('\x1b'), -1, 'ANSI/control chars stripped from name');
  assert.ok(Array.isArray(n.chats) && n.chats.length === 0, 'non-array chats coerced to []');
  assert.ok(Array.isArray(n.accounts), 'null accounts coerced to []');
  assert.strictEqual(fleet.normalizeStatus(null), null);
  assert.strictEqual(fleet.normalizeStatus({ name: 'no-id' }), null, 'a status without a safe machineId is dropped');
});

test('robustness: newReplies never crashes on malformed statuses', function () {
  const ctx = makeCtx();
  assert.doesNotThrow(function () {
    fleet.newReplies(ctx, [null, 'str', { machineId: 'm', chats: 'nope' }, { machineId: 'm2', chats: [null, { sessionId: 's', mtime: 1, replied: true }] }]);
  });
});

test('P3 ANSI: applyCommand strips control chars from a note detail', function () {
  const ctx = makeCtx();
  const r = fleet.applyCommand(ctx, { type: 'note', payload: { text: 'hi\x1b[2Jthere\x07' } }, {});
  assert.ok(r.ok);
  assert.strictEqual(/[\x00-\x1f\x7f]/.test(r.detail), false, 'no control chars survive into the printed detail');
});

test('P1 DNS-rebinding: the fleet panel rejects a non-loopback Host header', async function () {
  const http = require('http');
  const A = machine('alpha', sharedDir());
  const panel = require('../src/panel');
  const h = await panel.serveFleet(A, { port: 0, getFleet: function () { return { machines: [], newReplies: [] }; } });
  function get(hostHeader) {
    return new Promise(function (resolve) {
      const req = http.request({ host: '127.0.0.1', port: h.port, path: '/api/fleet', method: 'GET', headers: { host: hostHeader } }, function (res) { res.resume(); resolve(res.statusCode); });
      req.end();
    });
  }
  try {
    assert.strictEqual(await get('evil.example.com'), 403, 'a rebinding Host is forbidden');
    assert.strictEqual(await get('127.0.0.1:' + h.port), 200, 'a loopback Host is allowed');
  } finally { h.server.close(); }
});
