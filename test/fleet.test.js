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

// ============================================================================
// Origin authentication (2026-07-07) — per-machine Ed25519 signing keys, TOFU-pinned.
// Closes the review's tracked residual: a leaked passphrase must NOT let a forger command a peer.
// ============================================================================
test('origin-auth: a machine keypair is generated once and stable; the public key is base64', function () {
  const A = machine('alpha', sharedDir());
  const k1 = fleet.machineKeys(A), k2 = fleet.machineKeys(A);
  assert.strictEqual(k1.publicB64, k2.publicB64, 'same key across calls');
  assert.ok(/^[A-Za-z0-9+/=]+$/.test(fleet.publicKey(A)), 'public key is single-line base64');
  assert.ok(k1.privatePem.indexOf('PRIVATE KEY') !== -1, 'private key stays PEM, local only');
});

test('origin-auth: queue signs; verifyCommand accepts the genuine command and rejects a tampered one', function () {
  const A = machine('alpha', sharedDir());
  const cmd = { id: '1', from: fleet.identity(A).machineId, at: A.now(), type: 'switch', payload: { account: 'work' } };
  fleet.signCommand(A, cmd);
  const pub = fleet.publicKey(A);
  assert.strictEqual(fleet.verifyCommand(cmd, pub), true, 'genuine signature verifies');
  cmd.payload.account = 'admin'; // tamper after signing
  assert.strictEqual(fleet.verifyCommand(cmd, pub), false, 'a tampered payload no longer verifies');
});

test('origin-auth: a genuine signed command from a pinned peer passes checkOrigin end-to-end', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir), B = machine('beta', dir);
  seedAccount(B, 'work', 'b@x.com', '{"claudeAiOauth":{"accessToken":"BW"}}');
  fleet.publish(A, busOf(A, dir), {}); // A publishes its pubKey
  const cmd = fleet.queue(A, busOf(A, dir), fleet.identity(B).machineId, { type: 'switch', payload: { account: 'work' } });
  const rec = fleet.reconcileKeys(B, fleet.readFleet(B, busOf(B, dir))); // B pins A's key (first sight)
  assert.ok(rec.firstSeen.indexOf(fleet.identity(A).machineId) !== -1);
  const origin = fleet.checkOrigin(B, cmd, rec);
  assert.ok(origin.ok, origin.reason);
  const res = fleet.applyCommand(B, cmd, { allowSwitch: true, senderKey: origin.key, requireSignature: true });
  assert.ok(res.ok && /switched to work/.test(res.detail), res.detail);
});

test('origin-auth: a FORGED command (attacker key, claims from=alpha) is REJECTED even with the passphrase', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir), B = machine('beta', dir), evil = machine('evil', dir);
  fleet.publish(A, busOf(A, dir), {}); // B will pin A's REAL key
  const forged = { id: 'deadbeef', from: fleet.identity(A).machineId, to: fleet.identity(B).machineId, at: A.now(), type: 'switch', payload: { account: 'work' } };
  fleet.signCommand(evil, forged); // attacker has the passphrase + folder write, but only THEIR key
  const rec = fleet.reconcileKeys(B, fleet.readFleet(B, busOf(B, dir)));
  const origin = fleet.checkOrigin(B, forged, rec);
  assert.ok(!origin.ok && /verify/.test(origin.reason), 'forgery does not verify against alpha\'s pinned key');
});

test('origin-auth: an UNSIGNED command is rejected', function () {
  const B = machine('beta', sharedDir());
  const origin = fleet.checkOrigin(B, { from: 'alpha-x', type: 'note', payload: {} }, { keys: { 'alpha-x': 'AAA' }, conflicts: [] });
  assert.ok(!origin.ok && /unsigned/.test(origin.reason));
});

test('origin-auth: applyCommand with requireSignature refuses a bad signature (defence in depth)', function () {
  const B = machine('beta', sharedDir());
  const res = fleet.applyCommand(B, { type: 'switch', payload: { account: 'x' }, sig: 'bogus' }, { allowSwitch: true, senderKey: fleet.publicKey(B), requireSignature: true });
  assert.ok(!res.ok && /unverified origin/.test(res.detail));
});

test('origin-auth: a pinned key that CHANGES is flagged as a conflict and its commands rejected until trusted', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir), B = machine('beta', dir);
  const aId = fleet.identity(A).machineId;
  fleet.publish(A, busOf(A, dir), {});
  let rec = fleet.reconcileKeys(B, fleet.readFleet(B, busOf(B, dir)));
  assert.strictEqual(rec.conflicts.length, 0, 'first sight pins cleanly');
  // A re-keys (fresh install / reset): drop its key file and republish with a new key.
  fs.unlinkSync(path.join(A.configDir, 'fleet-key.json'));
  fleet.publish(A, busOf(A, dir), {});
  const cmd = fleet.queue(A, busOf(A, dir), fleet.identity(B).machineId, { type: 'note', payload: { text: 'hi' } });
  rec = fleet.reconcileKeys(B, fleet.readFleet(B, busOf(B, dir)));
  assert.strictEqual(rec.conflicts.length, 1, 'the key change is flagged');
  assert.ok(!fleet.checkOrigin(B, cmd, rec).ok, 'commands from a changed-key peer are rejected');
  // Explicit re-trust (the only sanctioned way a pinned key changes) restores verification.
  const newKey = fleet.readFleet(B, busOf(B, dir)).find(function (s) { return s.name === 'alpha'; }).pubKey;
  fleet.trustKey(B, aId, newKey);
  const rec2 = fleet.reconcileKeys(B, fleet.readFleet(B, busOf(B, dir)));
  assert.strictEqual(rec2.conflicts.length, 0, 'no conflict after trust');
  assert.ok(fleet.checkOrigin(B, cmd, rec2).ok, 'commands verify again once the new key is trusted');
});

test('origin-auth: a command signed FOR one machine is REJECTED when replayed into another inbox (recipient binding)', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir), B = machine('beta', dir), C = machine('gamma', dir);
  seedAccount(B, 'work', 'b@x.com', '{"claudeAiOauth":{"accessToken":"BW"}}');
  seedAccount(C, 'work', 'c@x.com', '{"claudeAiOauth":{"accessToken":"CW"}}');
  fleet.publish(A, busOf(A, dir), {});
  // A legitimately queues a switch FOR B; an attacker (has the passphrase) lifts these exact bytes.
  const cmd = fleet.queue(A, busOf(A, dir), fleet.identity(B).machineId, { type: 'switch', payload: { account: 'work' } });
  // Replayed verbatim into C's inbox: C pins A's real key, the signature is genuine — but it was
  // addressed to B, so C must reject it.
  const recC = fleet.reconcileKeys(C, fleet.readFleet(C, busOf(C, dir)));
  const onC = fleet.checkOrigin(C, cmd, recC);
  assert.ok(!onC.ok && /addressed/.test(onC.reason), 'a command signed for B is not valid on C');
  assert.ok(!fleet.applyCommand(C, cmd, { allowSwitch: true, senderKey: recC.keys[fleet.identity(A).machineId], requireSignature: true }).ok, 'applyCommand also refuses the wrong recipient');
  // Rewriting cmd.to = C to dodge the recipient check breaks the signature instead.
  const tampered = Object.assign({}, cmd, { to: fleet.identity(C).machineId });
  assert.ok(!fleet.checkOrigin(C, tampered, recC).ok, 'rewriting the recipient invalidates the signature');
  // Sanity: the untouched command IS valid on its intended target B.
  const recB = fleet.reconcileKeys(B, fleet.readFleet(B, busOf(B, dir)));
  assert.ok(fleet.checkOrigin(B, cmd, recB).ok, 'the same command is valid on its intended target B');
});

test('origin-auth hardening: TOFU roster is prototype-pollution safe; fingerprint is stable hex', function () {
  const A = machine('alpha', sharedDir());
  const pub = fleet.publicKey(A);
  const rec = fleet.reconcileKeys(A, [{ machineId: '__proto__', pubKey: pub }, { machineId: 'constructor', pubKey: pub }]);
  assert.strictEqual(Object.getPrototypeOf(rec.keys), null, 'the known-keys map has a null prototype');
  assert.strictEqual({}.polluted, undefined, 'Object.prototype is not polluted by a hostile machineId');
  const fp = fleet.fingerprint(pub);
  assert.ok(/^[0-9a-f:]+$/.test(fp), 'fingerprint is hex');
  assert.strictEqual(fp, fleet.fingerprint(pub), 'fingerprint is stable');
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
