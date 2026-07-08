'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const license = require('../src/license');
const { makeCtx } = require('./helpers');

// A throwaway Ed25519 keypair + its SPKI-DER base64 public key (same encoding
// the release build embeds). Tests pin it with setPublicKey so the whole
// mint -> verify path runs offline against a key we control.
function freshKeys() {
  const kp = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    pubB64: kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

// Fixed clocks so nothing depends on the wall clock.
const NOW = function () { return '2026-06-01T00:00:00.000Z'; };
const FUTURE = function () { return '2031-01-01T00:00:00.000Z'; };

function tmpFile(contents) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kf-lic-')), 'license.txt');
  fs.writeFileSync(p, contents);
  return p;
}

// ---- verify: happy paths -----------------------------------------------------

test('mint + verify a genuine license (round-trip)', function () {
  const k = freshKeys();
  license.setPublicKey(k.pubB64);
  const token = license.makeLicense(k.privateKey, { tier: 'pro', email: 'a@b.co', expiry: '2030-01-01T00:00:00.000Z', issued: '2026-01-01T00:00:00.000Z' });
  const v = license.verify(token, { now: NOW });
  assert.strictEqual(v.valid, true);
  assert.strictEqual(v.tier, 'pro');
  assert.strictEqual(v.email, 'a@b.co');
  assert.strictEqual(v.expiry, '2030-01-01T00:00:00.000Z');
  assert.strictEqual(v.reason, 'ok');
});

test('a null expiry never expires', function () {
  const k = freshKeys();
  license.setPublicKey(k.pubB64);
  const token = license.makeLicense(k.privateKey, { tier: 'team', email: 'x@y.z', expiry: null }, { now: NOW });
  const v = license.verify(token, { now: FUTURE });
  assert.strictEqual(v.valid, true);
  assert.strictEqual(v.tier, 'team');
  assert.strictEqual(v.expiry, null);
});

test('a free-tier license is valid but grants nothing paid', function () {
  const k = freshKeys();
  license.setPublicKey(k.pubB64);
  const token = license.makeLicense(k.privateKey, { tier: 'free', email: 'f@f.f', expiry: null }, { now: NOW });
  const v = license.verify(token, { now: NOW });
  assert.strictEqual(v.valid, true);
  assert.strictEqual(v.tier, 'free');
});

// ---- verify: hostile paths ---------------------------------------------------

test('an expired license is invalid but still reports its claimed tier', function () {
  const k = freshKeys();
  license.setPublicKey(k.pubB64);
  const token = license.makeLicense(k.privateKey, { tier: 'pro', email: 'a@b.co', expiry: '2027-01-01T00:00:00.000Z' }, { now: NOW });
  const v = license.verify(token, { now: FUTURE });
  assert.strictEqual(v.valid, false);
  assert.strictEqual(v.reason, 'expired');
  assert.strictEqual(v.tier, 'pro'); // claimed tier surfaced for messaging
});

test('a tampered payload fails the signature check', function () {
  const k = freshKeys();
  license.setPublicKey(k.pubB64);
  const token = license.makeLicense(k.privateKey, { tier: 'pro', email: 'a@b.co', expiry: null }, { now: NOW });
  // Forge an "enterprise" payload but keep the original signature.
  const forgedPayload = license.canonicalPayload({ tier: 'enterprise', email: 'a@b.co', expiry: null, issued: '2026-01-01T00:00:00.000Z' });
  const forged = Buffer.from(forgedPayload, 'utf8').toString('base64url') + '.' + token.split('.')[1];
  const v = license.verify(forged, { now: NOW });
  assert.strictEqual(v.valid, false);
  assert.strictEqual(v.reason, 'bad-signature');
  assert.strictEqual(v.tier, 'free');
});

test('a license signed by a DIFFERENT key is rejected', function () {
  const signer = freshKeys();
  const other = freshKeys();
  license.setPublicKey(other.pubB64); // trust a key that did NOT sign
  const token = license.makeLicense(signer.privateKey, { tier: 'team', email: 'a@b.co', expiry: null }, { now: NOW });
  const v = license.verify(token, { now: NOW });
  assert.strictEqual(v.valid, false);
  assert.strictEqual(v.reason, 'bad-signature');
});

test('malformed tokens are rejected without throwing', function () {
  const k = freshKeys();
  license.setPublicKey(k.pubB64);
  ['', 'not-a-token', 'only-one-part.', '.only-two', 'a.b.c', '@@@.@@@'].forEach(function (bad) {
    const v = license.verify(bad, { now: NOW });
    assert.strictEqual(v.valid, false, JSON.stringify(bad));
    assert.strictEqual(v.tier, 'free', JSON.stringify(bad));
  });
  assert.strictEqual(license.verify(null, { now: NOW }).valid, false);
  assert.strictEqual(license.verify(42, { now: NOW }).valid, false);
  assert.strictEqual(license.verify({}, { now: NOW }).valid, false);
});

test('an unknown tier is refused even with a genuine signature', function () {
  const k = freshKeys();
  license.setPublicKey(k.pubB64);
  const token = license.makeLicense(k.privateKey, { tier: 'ultra', email: 'a@b.co', expiry: null }, { now: NOW });
  const v = license.verify(token, { now: NOW });
  assert.strictEqual(v.valid, false);
  assert.strictEqual(v.reason, 'unknown-tier');
});

test('the placeholder public key verifies nothing (fail-closed default)', function () {
  const k = freshKeys();
  const token = license.makeLicense(k.privateKey, { tier: 'pro', email: 'a@b.co', expiry: null }, { now: NOW });
  license.setPublicKey(license.PUBKEY_B64); // the un-replaced placeholder
  const v = license.verify(token, { now: NOW });
  assert.strictEqual(v.valid, false);
  assert.strictEqual(v.reason, 'no-pubkey');
});

// ---- state: activate / status / tier ----------------------------------------

test('activate stores a verified license 0600 and status/tier read it back', function () {
  const k = freshKeys();
  license.setPublicKey(k.pubB64);
  const ctx = makeCtx({ now: NOW });
  const token = license.makeLicense(k.privateKey, { tier: 'pro', email: 'a@b.co', expiry: '2030-01-01T00:00:00.000Z' }, { now: NOW });

  const r = license.activate(ctx, { token: token });
  assert.strictEqual(r.tier, 'pro');
  assert.strictEqual(r.valid, true);

  const p = license.licensePath(ctx);
  assert.ok(fs.existsSync(p));
  const mode = fs.statSync(p).mode & 0o777;
  assert.strictEqual(mode, 0o600, 'license.json must be 0600, got ' + mode.toString(8));

  const s = license.status(ctx);
  assert.strictEqual(s.tier, 'pro');
  assert.strictEqual(s.email, 'a@b.co');
  assert.strictEqual(s.valid, true);
  assert.strictEqual(license.tier(ctx), 'pro');
});

test('activate reads a token from a FILE (raw and JSON-wrapped)', function () {
  const k = freshKeys();
  license.setPublicKey(k.pubB64);
  const token = license.makeLicense(k.privateKey, { tier: 'team', email: 'a@b.co', expiry: null }, { now: NOW });

  const ctx1 = makeCtx({ now: NOW });
  license.activate(ctx1, { file: tmpFile(token + '\n') }); // raw + trailing newline
  assert.strictEqual(license.tier(ctx1), 'team');

  const ctx2 = makeCtx({ now: NOW });
  license.activate(ctx2, { file: tmpFile(JSON.stringify({ token: token }, null, 2)) }); // JSON wrapper
  assert.strictEqual(license.tier(ctx2), 'team');
});

test('activate refuses an invalid/expired license and writes nothing', function () {
  const k = freshKeys();
  license.setPublicKey(k.pubB64);
  const ctx = makeCtx({ now: FUTURE });
  const token = license.makeLicense(k.privateKey, { tier: 'pro', email: 'a@b.co', expiry: '2027-01-01T00:00:00.000Z' }, { now: NOW });
  assert.throws(function () { license.activate(ctx, { token: token }); }, /not valid/);
  assert.strictEqual(fs.existsSync(license.licensePath(ctx)), false);
  assert.strictEqual(license.tier(ctx), 'free');
});

test('an expired stored license collapses to free (checked at read time)', function () {
  const k = freshKeys();
  license.setPublicKey(k.pubB64);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-exp-'));
  const ctxNow = makeCtx({ home: home, now: NOW });
  const token = license.makeLicense(k.privateKey, { tier: 'pro', email: 'a@b.co', expiry: '2030-01-01T00:00:00.000Z' }, { now: NOW });
  license.activate(ctxNow, { token: token });
  assert.strictEqual(license.tier(ctxNow), 'pro');

  // Same stored file, but the clock has moved past expiry.
  const ctxLater = makeCtx({ home: home, now: FUTURE });
  assert.strictEqual(license.tier(ctxLater), 'free');
  const s = license.status(ctxLater);
  assert.strictEqual(s.valid, false);
  assert.strictEqual(s.reason, 'expired');
  assert.strictEqual(s.tier, 'pro'); // still shows what they had
});

test('no license, corrupt file, and deactivate all resolve to free', function () {
  const ctx = makeCtx({ now: NOW });
  assert.strictEqual(license.tier(ctx), 'free');
  assert.strictEqual(license.status(ctx).reason, 'no-license');

  fs.writeFileSync(license.licensePath(ctx), '{ this is not json');
  assert.strictEqual(license.tier(ctx), 'free'); // corrupt -> free, no throw

  const k = freshKeys();
  license.setPublicKey(k.pubB64);
  const token = license.makeLicense(k.privateKey, { tier: 'pro', email: 'a@b.co', expiry: null }, { now: NOW });
  license.activate(ctx, { token: token });
  assert.strictEqual(license.tier(ctx), 'pro');
  assert.strictEqual(license.deactivate(ctx), true);
  assert.strictEqual(license.tier(ctx), 'free');
  assert.strictEqual(license.deactivate(ctx), false); // nothing left
});

// ---- gating ------------------------------------------------------------------

test('gate/requireTier enforce the tier ladder', function () {
  const k = freshKeys();
  license.setPublicKey(k.pubB64);

  // free: no license
  const free = makeCtx({ now: NOW });
  assert.strictEqual(license.gate(free, 'fleet'), false);
  assert.strictEqual(license.gate(free, 'nonexistent-free-feature'), true); // unlisted = free
  assert.throws(function () { license.requireTier(free, 'fleet'); }, function (e) {
    return e.code === 'LICENSE_REQUIRED' && /pro plan/.test(e.message) && e.requiredTier === 'pro';
  });

  // pro: unlocks pro features, not team
  const pro = makeCtx({ now: NOW });
  license.activate(pro, { token: license.makeLicense(k.privateKey, { tier: 'pro', email: 'a@b.co', expiry: null }, { now: NOW }) });
  ['fleet', 'cost', 'budget', 'notify', 'autoswitch', 'router', 'cache', 'jobs', 'orchestrator'].forEach(function (f) {
    assert.strictEqual(license.gate(pro, f), true, 'pro should unlock ' + f);
  });
  ['teampool', 'policy', 'vault', 'swarm'].forEach(function (f) {
    assert.strictEqual(license.gate(pro, f), false, 'pro must NOT unlock ' + f);
  });
  assert.doesNotThrow(function () { license.requireTier(pro, 'fleet'); });
  assert.throws(function () { license.requireTier(pro, 'vault'); }, function (e) {
    return e.code === 'LICENSE_REQUIRED' && /team plan/.test(e.message);
  });

  // enterprise: unlocks everything (above team)
  const ent = makeCtx({ now: NOW });
  license.activate(ent, { token: license.makeLicense(k.privateKey, { tier: 'enterprise', email: 'a@b.co', expiry: null }, { now: NOW }) });
  ['fleet', 'vault', 'policy', 'teampool', 'swarm'].forEach(function (f) {
    assert.strictEqual(license.gate(ent, f), true, 'enterprise should unlock ' + f);
  });
});

test('unlockedFeatures reflects the effective tier', function () {
  const k = freshKeys();
  license.setPublicKey(k.pubB64);
  const team = makeCtx({ now: NOW });
  license.activate(team, { token: license.makeLicense(k.privateKey, { tier: 'team', email: 'a@b.co', expiry: null }, { now: NOW }) });
  const feats = license.unlockedFeatures(team);
  assert.ok(feats.indexOf('vault') !== -1 && feats.indexOf('fleet') !== -1);
  assert.strictEqual(license.unlockedFeatures(makeCtx({ now: NOW })).length, 0); // free unlocks nothing
});

// ---- MCP tools ---------------------------------------------------------------

function toolNamed(n) { return license.mcpTools.filter(function (t) { return t.name === n; })[0]; }

test('MCP license_status is read-only and reports the plan', async function () {
  const k = freshKeys();
  license.setPublicKey(k.pubB64);
  const ctx = makeCtx({ now: NOW });
  license.activate(ctx, { token: license.makeLicense(k.privateKey, { tier: 'pro', email: 'a@b.co', expiry: null }, { now: NOW }) });
  const tool = toolNamed('keyflip_license_status');
  assert.strictEqual(tool.annotations.readOnlyHint, true);
  const out = await tool.run(ctx, {});
  assert.strictEqual(out.plan, 'pro');
  assert.strictEqual(out.valid, true);
  assert.ok(out.features.indexOf('fleet') !== -1);
});

test('MCP license_activate requires confirm and then activates from a file', async function () {
  const k = freshKeys();
  license.setPublicKey(k.pubB64);
  const ctx = makeCtx({ now: NOW });
  const token = license.makeLicense(k.privateKey, { tier: 'team', email: 'a@b.co', expiry: null }, { now: NOW });
  const file = tmpFile(token);
  const tool = toolNamed('keyflip_license_activate');
  assert.strictEqual(tool.annotations.readOnlyHint, false);
  assert.ok(tool.inputSchema.required.indexOf('confirm') !== -1);

  await assert.rejects(function () { return tool.run(ctx, { file: file, confirm: false }); }, /confirmation required/);
  assert.strictEqual(license.tier(ctx), 'free'); // nothing happened without confirm

  const out = await tool.run(ctx, { file: file, confirm: true });
  assert.strictEqual(out.activated, true);
  assert.strictEqual(out.tier, 'team');
  assert.strictEqual(license.tier(ctx), 'team');
});
