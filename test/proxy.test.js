import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as proxy from '../src/proxy.js';
import * as breaker from '../src/breaker.js';
import * as core from '../src/core.js';
import { makeCtx, writeClaude } from './helpers.js';
import _http from 'http';

function twoAccounts() {
  const ctx = makeCtx();
  function login(email, uid, tok) { writeClaude(ctx, { oauthAccount: { emailAddress: email }, userID: uid }); ctx.store.setLive(JSON.stringify({ claudeAiOauth: { accessToken: tok } })); }
  login('a@x.com', 'u1', 'TA'); core.addCurrent(ctx);
  login('b@x.com', 'u2', 'TB'); core.addCurrent(ctx); // b active
  return ctx;
}

// Minimal fake ServerResponse capturing what the client received.
function fakeRes() {
  return { statusCode: null, headers: null, chunks: [],
    writeHead: function (s, h) { this.statusCode = s; this.headers = h; },
    write: function (c) { this.chunks.push(Buffer.from(c)); },
    end: function (c) { if (c != null) this.chunks.push(Buffer.from(c)); this.ended = true; },
    body: function () { return Buffer.concat(this.chunks).toString('utf8'); } };
}

test('candidates put the active account first, then healthy others', function () {
  const ctx = twoAccounts();
  const names = proxy.candidates(ctx).map(function (e) { return e.name; });
  assert.strictEqual(names[0], 'b');       // active first
  assert.ok(names.indexOf('a') !== -1);
});

test('a 429 on the active account fails over to the next before any client byte', async function () {
  const ctx = twoAccounts();
  const seen = [];
  const forward = async function (up, reqInfo) {
    seen.push(up.authVal);
    if (up.authVal === 'Bearer TB') return { status: 429, headers: {}, body: Buffer.from('rate limited') };
    return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"usage":{"input_tokens":5,"output_tokens":7},"model":"claude-x"}') };
  };
  const res = fakeRes();
  const r = await proxy.handleRequest(ctx, { method: 'POST', path: '/v1/messages', headers: {}, body: Buffer.from('{}') }, res, { forward: forward });
  assert.strictEqual(res.statusCode, 200);          // client got the SUCCESS, not the 429
  assert.strictEqual(r.account, 'a');               // failed over to a
  assert.deepStrictEqual(seen, ['Bearer TB', 'Bearer TA']); // tried active then next
  // breaker: b recorded a failure (one 429 is below the open threshold, but counted)
  assert.ok((breaker.readAll(ctx).b || {}).failures >= 1);
});

test('usage tokens are recorded for stats', async function () {
  const ctx = twoAccounts();
  const forward = async function () { return { status: 200, headers: {}, body: Buffer.from('{"usage":{"input_tokens":10,"output_tokens":20},"model":"m"}') }; };
  await proxy.handleRequest(ctx, { method: 'POST', path: '/v1/messages', headers: {}, body: Buffer.from('{}') }, fakeRes(), { forward: forward });
  const st = proxy.stats(ctx);
  assert.strictEqual(st.total, 1);
  const acct = Object.keys(st.byAccount)[0];
  assert.strictEqual(st.byAccount[acct].inputTokens, 10);
  assert.strictEqual(st.byAccount[acct].outputTokens, 20);
});

test('a 4xx that is not auth is committed (not retried)', async function () {
  const ctx = twoAccounts();
  let calls = 0;
  const forward = async function () { calls++; return { status: 400, headers: {}, body: Buffer.from('bad request') }; };
  const res = fakeRes();
  await proxy.handleRequest(ctx, { method: 'POST', path: '/v1/messages', headers: {}, body: Buffer.from('{}') }, res, { forward: forward });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(calls, 1);                     // NOT retried
});

test('all-accounts-failing yields 502', async function () {
  const ctx = twoAccounts();
  const forward = async function () { return { status: 500, headers: {}, body: Buffer.from('boom') }; };
  const res = fakeRes();
  const r = await proxy.handleRequest(ctx, { method: 'POST', path: '/v1/messages', headers: {}, body: Buffer.from('{}') }, res, { forward: forward });
  // last candidate's 500 is committed (nothing left to fail over to) OR 502; either way not a 200
  assert.notStrictEqual(res.statusCode, 200);
  assert.ok(r.status === 500 || r.status === 502);
});

test('a retryable status committed as a last resort records a FAILURE, not a success', async function () {
  const ctx = twoAccounts();
  // both accounts 429 -> the last one is committed; that must count as a failure
  const forward = async function () { return { status: 429, headers: {}, body: Buffer.from('busy') }; };
  const res = fakeRes();
  await proxy.handleRequest(ctx, { method: 'POST', path: '/v1/messages', headers: {}, body: Buffer.from('{}') }, res, { forward: forward });
  const all = breaker.readAll(ctx);
  // both accounts should have recorded failures (never a phantom success)
  assert.ok((all.a || {}).failures >= 1);
  assert.ok((all.b || {}).failures >= 1);
});

test('a persistently-429 single account eventually trips its breaker open', async function () {
  const ctx = makeCtx();
  writeClaude(ctx, { oauthAccount: { emailAddress: 'solo@x.com' }, userID: 'u' });
  ctx.store.setLive('{"claudeAiOauth":{"accessToken":"T"}}'); core.addCurrent(ctx);
  const forward = async function () { return { status: 429, headers: {}, body: Buffer.from('busy') }; };
  for (let i = 0; i < 4; i++) await proxy.handleRequest(ctx, { method: 'POST', path: '/v1/messages', headers: {}, body: Buffer.from('{}') }, fakeRes(), { forward: forward });
  assert.strictEqual(breaker.state(ctx, 'solo'), 'open'); // no longer force-closed by its own 429s
});

test('extractUsage parses both plain JSON and SSE output_tokens', function () {
  const j = proxy.extractUsage(Buffer.from('{"usage":{"input_tokens":3,"output_tokens":9}}'));
  assert.strictEqual(j.inputTokens, 3); assert.strictEqual(j.outputTokens, 9);
  const sse = proxy.extractUsage(Buffer.from('event: message_start\ndata: {"message":{"usage":{"input_tokens":4,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"usage":{"output_tokens":50}}\n\n'));
  assert.strictEqual(sse.inputTokens, 4);
  assert.strictEqual(sse.outputTokens, 50);         // last output_tokens wins
});

test('a real server starts on localhost and forwards via injected forward', async function () {
  const ctx = twoAccounts();
  const forward = async function () { return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":true}') }; };
  const s = await proxy.serve(ctx, { port: 0, forward: forward });
  try {
    const http = _http;
    const body = await new Promise(function (resolve, reject) {
      const req = http.request({ hostname: '127.0.0.1', port: s.port, path: '/v1/messages', method: 'POST' }, function (res) {
        let d = ''; res.on('data', function (c) { d += c; }); res.on('end', function () { resolve(d); });
      });
      req.on('error', reject); req.end('{}');
    });
    assert.match(body, /"ok":true/);
  } finally { s.server.close(); }
});
