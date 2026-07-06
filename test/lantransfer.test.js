'use strict';
// Tests for LAN device-to-device transfer (src/lantransfer.js). The code helpers are
// pure; the serve→pull path is exercised over real loopback HTTP (bind 127.0.0.1, no
// multicast beacon) so we cover the actual wire format + code gate.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const lan = require('../src/lantransfer');
const profiles = require('../src/profiles');
const { makeCtx } = require('./helpers');

function ctxWithClaude() {
  const ctx = makeCtx();
  ctx.claudeDir = path.join(ctx.home, '.claude');
  fs.mkdirSync(ctx.claudeDir, { recursive: true });
  return ctx;
}
function seedAccount(ctx, name, email, blob) {
  ctx.store.setProfile(name, blob);
  profiles.write(ctx.configDir, { name: name, email: email, oauthAccount: {}, userID: '', savedAt: ctx.now() });
}
function seedTranscript(ctx, project, id, content) {
  const dir = path.join(ctx.claudeDir, 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.jsonl'), content);
}

test('genCode is 8 base32 chars with no confusable characters', function () {
  for (let i = 0; i < 50; i++) {
    const c = lan.genCode();
    assert.strictEqual(c.length, 8);
    assert.match(c, /^[A-HJ-NP-Z2-9]{8}$/); // no 0,O,1,I
  }
});

test('normCode strips spaces/dashes and uppercases; codeEqual is lenient + constant', function () {
  assert.strictEqual(lan.normCode(' k7q2-9fmr '), 'K7Q29FMR');
  assert.ok(lan.codeEqual('k7q2-9fmr', 'K7Q29FMR'));
  assert.ok(!lan.codeEqual('K7Q29FMR', 'K7Q29FMX'));
  assert.ok(!lan.codeEqual('', '')); // empty never matches
});

test('fingerprint is a stable 4-hex-char digest of the normalized code', function () {
  assert.strictEqual(lan.fingerprint('k7q2-9fmr'), lan.fingerprint('K7Q29FMR'));
  assert.match(lan.fingerprint('ABCDEFGH'), /^[0-9A-F]{4}$/);
});

test('splitHostPort parses host and host:port', function () {
  assert.deepStrictEqual(lan.splitHostPort('1.2.3.4', 8787), { host: '1.2.3.4', port: 8787 });
  assert.deepStrictEqual(lan.splitHostPort('1.2.3.4:9000', 8787), { host: '1.2.3.4', port: 9000 });
});

test('serve → pull round-trips the bundle over loopback with the right code', async function () {
  const src = ctxWithClaude();
  seedAccount(src, 'work', 'a@x.com', '{"token":"AAA"}');
  seedTranscript(src, '-p', 's1', 'HELLO\n');

  const h = lan.serve(src, { host: '127.0.0.1', port: 0, discovery: false, ttlMs: 10000 });
  await new Promise(function (r) { setTimeout(r, 50); }); // let it bind (port 0 -> real port)
  try {
    const bundle = await lan.pull({ host: '127.0.0.1:' + h.port, code: h.code });
    assert.strictEqual(bundle.accounts[0].cliCredentials, '{"token":"AAA"}');
    assert.strictEqual(bundle.transcripts[0].content, 'HELLO\n');
  } finally { h.close('test-done'); }
  const done = await h.wait;
  assert.ok(done.reason === 'transferred' || done.reason === 'test-done');
});

test('pull with the WRONG code is rejected', async function () {
  const src = ctxWithClaude();
  seedAccount(src, 'work', 'a@x.com', '{"token":"AAA"}');
  const h = lan.serve(src, { host: '127.0.0.1', port: 0, discovery: false, ttlMs: 10000 });
  await new Promise(function (r) { setTimeout(r, 50); });
  try {
    await assert.rejects(function () { return lan.pull({ host: '127.0.0.1:' + h.port, code: 'WRONGCOD' }); }, /rejected/);
  } finally { h.close('test-done'); }
});

test('serve refuses when there is nothing to transfer', function () {
  const empty = ctxWithClaude();
  assert.throws(function () { lan.serve(empty, { host: '127.0.0.1', port: 0, discovery: false }); }, /nothing to transfer/);
});

test('serve accepts an agents-ONLY bundle (regression: empty-check must include agents)', async function () {
  const src = ctxWithClaude();
  // no accounts / transcripts / memory / config — ONLY another agent's home-level memory
  const rules = path.join(src.home, '.cursor', 'rules');
  fs.mkdirSync(rules, { recursive: true });
  fs.writeFileSync(path.join(rules, 'style.mdc'), '# be terse');
  const h = lan.serve(src, { host: '127.0.0.1', port: 0, discovery: false, ttlMs: 10000,
    agents: true, noAccounts: true, noSessions: true, noProviders: true, noMemory: true, noConfig: true });
  await new Promise(function (r) { setTimeout(r, 50); });
  try {
    assert.ok(h.counts.agents >= 1, 'the served bundle carries the agent memory');
    const bundle = await lan.pull({ host: '127.0.0.1:' + h.port, code: h.code });
    assert.ok((bundle.agents || []).some(function (a) { return a.rel.indexOf('style.mdc') !== -1; }));
  } finally { h.close('test-done'); }
});

test('serve fingerprint is a RANDOM per-serve nonce, not derived from the code', function () {
  const src = ctxWithClaude();
  seedAccount(src, 'work', 'a@x.com', '{"token":"AAA"}');
  // Same code both times: if fp were derived from the code it would be identical.
  const a = lan.serve(src, { host: '127.0.0.1', port: 0, discovery: false, code: 'FIXEDCOD' });
  const b = lan.serve(src, { host: '127.0.0.1', port: 0, discovery: false, code: 'FIXEDCOD' });
  try {
    assert.notStrictEqual(a.fingerprint, lan.fingerprint('FIXEDCOD'), 'fp must not be the code digest');
    assert.notStrictEqual(a.fingerprint, b.fingerprint, 'two serves with the same code get different fps');
  } finally { a.close('t'); b.close('t'); }
});

// ---- E3: push -> serveReceive (reverse direction) ----

test('E3: push -> serveReceive round-trips a bundle over loopback', async function () {
  let received = null;
  const h = lan.serveReceive({}, { host: '127.0.0.1', port: 0, discovery: false, ttlMs: 10000,
    onBundle: function (b) { received = b; return { accounts: (b.accounts || []).length, transcripts: 0, memory: 0 }; } });
  await new Promise(function (r) { setTimeout(r, 60); });
  try {
    const resp = await lan.push({ host: '127.0.0.1:' + h.port, code: h.code, bundle: { format: 'keyflip-migrate', accounts: [{ name: 'work' }], transcripts: [] } });
    assert.strictEqual(resp.ok, true);
    assert.strictEqual(resp.summary.accounts, 1);
    assert.ok(received && received.accounts[0].name === 'work', 'the receiver got the pushed bundle');
  } finally { h.close('test-done'); }
  const done = await h.wait;
  assert.ok(done.reason === 'received' || done.reason === 'test-done');
});

test('E3: push with the WRONG code is rejected', async function () {
  const h = lan.serveReceive({}, { host: '127.0.0.1', port: 0, discovery: false, ttlMs: 10000, onBundle: function () { return {}; } });
  await new Promise(function (r) { setTimeout(r, 60); });
  try {
    await assert.rejects(function () { return lan.push({ host: '127.0.0.1:' + h.port, code: 'WRONGCOD', bundle: {} }); }, /rejected/);
  } finally { h.close('t'); }
});

// SECURITY (review #15): the maxAttempts rate-limiter is the online-guessing defense. Exercise
// the SHUTDOWN, not just a single rejection, so removing the counter would fail a test.
test('serve shuts down after maxAttempts bad codes (blunts online code guessing)', async function () {
  const src = ctxWithClaude();
  seedAccount(src, 'work', 'a@x.com', '{"token":"AAA"}');
  const h = lan.serve(src, { host: '127.0.0.1', port: 0, discovery: false, ttlMs: 10000, maxAttempts: 2 });
  await new Promise(function (r) { setTimeout(r, 50); });
  await assert.rejects(function () { return lan.pull({ host: '127.0.0.1:' + h.port, code: 'BADCODE1' }); }, /rejected/);
  await assert.rejects(function () { return lan.pull({ host: '127.0.0.1:' + h.port, code: 'BADCODE2' }); }, /rejected/);
  const done = await h.wait;
  assert.strictEqual(done.reason, 'too many bad codes');
});

// SECURITY (review reinstated): nothing sensitive crosses the wire in the clear — the served
// body is the encrypted envelope, and only the code decrypts it back to the secret.
test('the served bundle is encrypted on the wire (raw body never contains the plaintext secret)', async function () {
  const sync = require('../src/sync');
  const http = require('http');
  const src = ctxWithClaude();
  seedAccount(src, 'work', 'a@x.com', '{"token":"SUPERSECRET-OAUTH"}');
  const h = lan.serve(src, { host: '127.0.0.1', port: 0, discovery: false, ttlMs: 10000 });
  await new Promise(function (r) { setTimeout(r, 50); });
  const raw = await new Promise(function (resolve, reject) {
    const payload = JSON.stringify({ code: h.code });
    const req = http.request({ host: '127.0.0.1', port: h.port, path: '/pull', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      function (res) { let b = ''; res.on('data', function (d) { b += d; }); res.on('end', function () { resolve(b); }); });
    req.on('error', reject); req.end(payload);
  });
  assert.strictEqual(raw.indexOf('SUPERSECRET-OAUTH'), -1, 'the secret must NOT appear in cleartext on the wire');
  assert.strictEqual(raw.indexOf('AAA'), -1);
  // …but the code decrypts it back to the real bundle carrying the secret.
  assert.ok(sync.decrypt(raw, h.code).indexOf('SUPERSECRET-OAUTH') !== -1, 'decrypts with the code');
});

// G6: pairing URL that the QR encodes for `transfer serve --qr`.
test('pairingUrl builds a keyflip://transfer link with host, port, code and fingerprint', function () {
  assert.strictEqual(lan.pairingUrl('10.0.0.9', 8899, 'K7Q29FMR', 'A3F2'),
    'keyflip://transfer?host=10.0.0.9:8899&code=K7Q29FMR&fp=A3F2');
  assert.strictEqual(lan.pairingUrl('10.0.0.9', 8899, 'K7Q29FMR'),
    'keyflip://transfer?host=10.0.0.9:8899&code=K7Q29FMR', 'fp is optional');
});
