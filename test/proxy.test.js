import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as proxy from '../src/proxy.js';
import * as proxyroutes from '../src/proxyroutes.js';
import * as breaker from '../src/breaker.js';
import * as config from '../src/config.js';
import * as core from '../src/core.js';
import { makeCtx, writeClaude } from './helpers.js';
import _http from 'http';

function twoAccounts() {
  const ctx = makeCtx();
  function login(email, uid, tok) {
    writeClaude(ctx, { oauthAccount: { emailAddress: email }, userID: uid });
    ctx.store.setLive(JSON.stringify({ claudeAiOauth: { accessToken: tok } }));
  }
  login('a@x.com', 'u1', 'TA');
  core.addCurrent(ctx);
  login('b@x.com', 'u2', 'TB');
  core.addCurrent(ctx); // b active
  return ctx;
}

// Minimal fake ServerResponse capturing what the client received.
function fakeRes() {
  return {
    statusCode: null,
    headers: null,
    chunks: [],
    writeHead: function (s, h) {
      this.statusCode = s;
      this.headers = h;
    },
    write: function (c) {
      this.chunks.push(Buffer.from(c));
    },
    end: function (c) {
      if (c != null) this.chunks.push(Buffer.from(c));
      this.ended = true;
    },
    body: function () {
      return Buffer.concat(this.chunks).toString('utf8');
    },
  };
}

test('candidates put the active account first, then healthy others', function () {
  const ctx = twoAccounts();
  const names = proxy.candidates(ctx).map(function (e) {
    return e.name;
  });
  assert.strictEqual(names[0], 'b'); // active first
  assert.ok(names.indexOf('a') !== -1);
});

test('a 429 on the active account fails over to the next before any client byte', async function () {
  const ctx = twoAccounts();
  const seen = [];
  const forward = async function (up, reqInfo) {
    seen.push(up.authVal);
    if (up.authVal === 'Bearer TB') return { status: 429, headers: {}, body: Buffer.from('rate limited') };
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"usage":{"input_tokens":5,"output_tokens":7},"model":"claude-x"}'),
    };
  };
  const res = fakeRes();
  const r = await proxy.handleRequest(
    ctx,
    { method: 'POST', path: '/v1/messages', headers: {}, body: Buffer.from('{}') },
    res,
    { forward: forward },
  );
  assert.strictEqual(res.statusCode, 200); // client got the SUCCESS, not the 429
  assert.strictEqual(r.account, 'a'); // failed over to a
  assert.deepStrictEqual(seen, ['Bearer TB', 'Bearer TA']); // tried active then next
  // breaker: b recorded a failure (one 429 is below the open threshold, but counted)
  assert.ok((breaker.readAll(ctx).b || {}).failures >= 1);
});

test('usage tokens are recorded for stats', async function () {
  const ctx = twoAccounts();
  const forward = async function () {
    return {
      status: 200,
      headers: {},
      body: Buffer.from('{"usage":{"input_tokens":10,"output_tokens":20},"model":"m"}'),
    };
  };
  await proxy.handleRequest(
    ctx,
    { method: 'POST', path: '/v1/messages', headers: {}, body: Buffer.from('{}') },
    fakeRes(),
    { forward: forward },
  );
  const st = proxy.stats(ctx);
  assert.strictEqual(st.total, 1);
  const acct = Object.keys(st.byAccount)[0];
  assert.strictEqual(st.byAccount[acct].inputTokens, 10);
  assert.strictEqual(st.byAccount[acct].outputTokens, 20);
});

test('a 4xx that is not auth is committed (not retried)', async function () {
  const ctx = twoAccounts();
  let calls = 0;
  const forward = async function () {
    calls++;
    return { status: 400, headers: {}, body: Buffer.from('bad request') };
  };
  const res = fakeRes();
  await proxy.handleRequest(ctx, { method: 'POST', path: '/v1/messages', headers: {}, body: Buffer.from('{}') }, res, {
    forward: forward,
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(calls, 1); // NOT retried
});

test('all-accounts-failing yields 502', async function () {
  const ctx = twoAccounts();
  const forward = async function () {
    return { status: 500, headers: {}, body: Buffer.from('boom') };
  };
  const res = fakeRes();
  const r = await proxy.handleRequest(
    ctx,
    { method: 'POST', path: '/v1/messages', headers: {}, body: Buffer.from('{}') },
    res,
    { forward: forward },
  );
  // last candidate's 500 is committed (nothing left to fail over to) OR 502; either way not a 200
  assert.notStrictEqual(res.statusCode, 200);
  assert.ok(r.status === 500 || r.status === 502);
});

test('a retryable status committed as a last resort records a FAILURE, not a success', async function () {
  const ctx = twoAccounts();
  // both accounts 429 -> the last one is committed; that must count as a failure
  const forward = async function () {
    return { status: 429, headers: {}, body: Buffer.from('busy') };
  };
  const res = fakeRes();
  await proxy.handleRequest(ctx, { method: 'POST', path: '/v1/messages', headers: {}, body: Buffer.from('{}') }, res, {
    forward: forward,
  });
  const all = breaker.readAll(ctx);
  // both accounts should have recorded failures (never a phantom success)
  assert.ok((all.a || {}).failures >= 1);
  assert.ok((all.b || {}).failures >= 1);
});

test('a persistently-429 single account eventually trips its breaker open', async function () {
  const ctx = makeCtx();
  writeClaude(ctx, { oauthAccount: { emailAddress: 'solo@x.com' }, userID: 'u' });
  ctx.store.setLive('{"claudeAiOauth":{"accessToken":"T"}}');
  core.addCurrent(ctx);
  const forward = async function () {
    return { status: 429, headers: {}, body: Buffer.from('busy') };
  };
  for (let i = 0; i < 4; i++)
    await proxy.handleRequest(
      ctx,
      { method: 'POST', path: '/v1/messages', headers: {}, body: Buffer.from('{}') },
      fakeRes(),
      { forward: forward },
    );
  assert.strictEqual(breaker.state(ctx, 'solo'), 'open'); // no longer force-closed by its own 429s
});

test('extractUsage parses both plain JSON and SSE output_tokens', function () {
  const j = proxy.extractUsage(Buffer.from('{"usage":{"input_tokens":3,"output_tokens":9}}'));
  assert.strictEqual(j.inputTokens, 3);
  assert.strictEqual(j.outputTokens, 9);
  const sse = proxy.extractUsage(
    Buffer.from(
      'event: message_start\ndata: {"message":{"usage":{"input_tokens":4,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"usage":{"output_tokens":50}}\n\n',
    ),
  );
  assert.strictEqual(sse.inputTokens, 4);
  assert.strictEqual(sse.outputTokens, 50); // last output_tokens wins
});

test('a real server starts on localhost and forwards via injected forward', async function () {
  const ctx = twoAccounts();
  const forward = async function () {
    return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":true}') };
  };
  const s = await proxy.serve(ctx, { port: 0, forward: forward });
  try {
    const http = _http;
    const body = await new Promise(function (resolve, reject) {
      const req = http.request(
        { hostname: '127.0.0.1', port: s.port, path: '/v1/messages', method: 'POST' },
        function (res) {
          let d = '';
          res.on('data', function (c) {
            d += c;
          });
          res.on('end', function () {
            resolve(d);
          });
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    assert.match(body, /"ok":true/);
    assert.notStrictEqual(s.port, proxy.DEFAULT_PORT); // port 0 = OS-assigned, never the default
  } finally {
    s.server.close();
  }
});

test('serve rejects (not crashes) when the port is already taken', async function () {
  const ctx = twoAccounts();
  const first = await proxy.serve(ctx, { port: 0 });
  try {
    await assert.rejects(proxy.serve(ctx, { port: first.port }), { code: 'EADDRINUSE' });
  } finally {
    first.server.close();
  }
});

// ---- routing substrate: Retry-After, triage, priority/LRU, cooldowns, headers ----

function threeAccounts() {
  const ctx = makeCtx();
  function login(email, uid, tok) {
    writeClaude(ctx, { oauthAccount: { emailAddress: email }, userID: uid });
    ctx.store.setLive(JSON.stringify({ claudeAiOauth: { accessToken: tok } }));
  }
  login('a@x.com', 'u1', 'TA');
  core.addCurrent(ctx);
  login('b@x.com', 'u2', 'TB');
  core.addCurrent(ctx);
  login('c@x.com', 'u3', 'TC');
  core.addCurrent(ctx); // c active
  return ctx;
}

function names(list) {
  return list.map(function (e) {
    return e.name;
  });
}

function ok(body) {
  return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(body || '{}') };
}

function send(ctx, forward, extra) {
  const res = fakeRes();
  const sleeps = [];
  return proxy
    .handleRequest(ctx, { method: 'POST', path: '/v1/messages', headers: {}, body: Buffer.from('{}') }, res, {
      forward: forward,
      sleep: function (ms) {
        sleeps.push(ms);
        return Promise.resolve();
      },
      ...(extra || {}),
    })
    .then(function (r) {
      return { r: r, res: res, sleeps: sleeps };
    });
}

test('retryAfterMs parses delta-seconds, HTTP-date, junk and caps at 24h', function () {
  assert.strictEqual(proxy.retryAfterMs({ 'Retry-After': '3' }, 0), 3000);
  assert.strictEqual(proxy.retryAfterMs({ 'retry-after': '1.5' }, 0), 1500);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.strictEqual(proxy.retryAfterMs({ 'retry-after': 'Thu, 01 Jan 2026 00:00:05 GMT' }, now), 5000);
  assert.strictEqual(proxy.retryAfterMs({ 'retry-after': 'soon' }, now), null);
  assert.strictEqual(proxy.retryAfterMs({}, now), null);
  assert.strictEqual(proxy.retryAfterMs({ 'retry-after': '999999999' }, now), 24 * 60 * 60 * 1000);
});

test('classify separates billing from throttling, and auth/overload/server', function () {
  const billing = Buffer.from('{"error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}');
  assert.strictEqual(proxy.classify(429, {}, billing), 'billing');
  assert.strictEqual(proxy.classify(429, {}, Buffer.from('{"error":{"message":"organization disabled"}}')), 'billing');
  assert.strictEqual(proxy.classify(429, {}, Buffer.from('{"error":{"message":"rate limit exceeded"}}')), 'throttled');
  assert.strictEqual(proxy.classify(429, {}, null), 'throttled');
  assert.strictEqual(proxy.classify(401, {}, null), 'auth');
  assert.strictEqual(proxy.classify(403, {}, null), 'auth');
  assert.strictEqual(proxy.classify(529, {}, null), 'overloaded');
  assert.strictEqual(proxy.classify(500, {}, null), 'server');
  assert.strictEqual(proxy.classify(400, {}, null), 'none');
});

test('a short Retry-After is waited out and the SAME account retried', async function () {
  const ctx = twoAccounts(); // active b
  const seen = [];
  let n = 0;
  const out = await send(ctx, async function (up) {
    seen.push(up.authVal);
    n++;
    if (n === 1)
      return { status: 429, headers: { 'retry-after': '2' }, body: Buffer.from('{"error":{"message":"rate limit"}}') };
    return ok('{"ok":true}');
  });
  assert.deepStrictEqual(seen, ['Bearer TB', 'Bearer TB']); // no failover
  assert.deepStrictEqual(out.sleeps, [2000]);
  assert.strictEqual(out.res.statusCode, 200);
  assert.strictEqual(out.r.account, 'b');
  assert.strictEqual(out.res.headers['x-keyflip-attempts'], '2');
  assert.strictEqual(out.res.headers['x-keyflip-account'], 'b');
  assert.ok(!out.res.headers['x-keyflip-failover']);
});

test('a Retry-After longer than the wait budget fails over immediately and parks the account', async function () {
  const ctx = twoAccounts();
  const seen = [];
  const out = await send(ctx, async function (up) {
    seen.push(up.authVal);
    if (up.authVal === 'Bearer TB')
      return { status: 429, headers: { 'retry-after': '120' }, body: Buffer.from('busy') };
    return ok('{"ok":true}');
  });
  assert.deepStrictEqual(seen, ['Bearer TB', 'Bearer TA']);
  assert.deepStrictEqual(out.sleeps, []); // never waited
  assert.strictEqual(out.res.headers['x-keyflip-failover'], 'b');
  const cd = breaker.cooldownOf(ctx, 'b');
  assert.strictEqual(cd.active, true);
  assert.strictEqual(cd.kind, 'throttled');
  assert.ok(cd.remainingMs >= 119000, 'cooldown honors the authoritative Retry-After');
});

test('a billing 429 is surfaced, never masked by failing over (#3)', async function () {
  const ctx = twoAccounts();
  let calls = 0;
  const out = await send(ctx, async function () {
    calls++;
    return {
      status: 429,
      headers: {},
      body: Buffer.from('{"error":{"type":"billing_error","message":"Your credit balance is too low"}}'),
    };
  });
  assert.strictEqual(calls, 1); // did NOT try the other account
  assert.strictEqual(out.res.statusCode, 429);
  assert.strictEqual(out.res.headers['x-keyflip-error-class'], 'billing');
  assert.ok(breaker.cooldownOf(ctx, 'b').active); // parked under the quota TTL
  assert.strictEqual(breaker.cooldownOf(ctx, 'b').kind, 'billing');
});

test('priority list defines the order; otherwise active first then least-recently-used', function () {
  const ctx = threeAccounts(); // c active
  assert.deepStrictEqual(names(proxy.candidates(ctx)), ['c', 'a', 'b']); // unordered tie -> name
  config.set(ctx, 'proxy.priority', 'a');
  assert.deepStrictEqual(names(proxy.candidates(ctx)), ['a', 'c', 'b']);
  config.unset(ctx, 'proxy.priority');
  breaker.recordSuccess(ctx, 'a', { nowMs: 1000 });
  breaker.recordSuccess(ctx, 'b', { nowMs: 2000 });
  assert.deepStrictEqual(names(proxy.candidates(ctx)), ['c', 'a', 'b']); // a used less recently
  breaker.recordSuccess(ctx, 'a', { nowMs: 3000 });
  assert.deepStrictEqual(names(proxy.candidates(ctx)), ['c', 'b', 'a']); // LRU flips
});

test('a cooling account is skipped; if all are cooling the soonest comes back with a wait hint', function () {
  const ctx = twoAccounts();
  breaker.markCooldown(ctx, 'b', 60000, 'throttled');
  assert.deepStrictEqual(names(proxy.candidates(ctx)), ['a']);
  breaker.markCooldown(ctx, 'a', 30000, 'server');
  const all = proxy.candidates(ctx);
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].name, 'a'); // frees up first
  assert.ok(all[0].waitMs > 20000 && all[0].waitMs <= 30000);
});

test('routeState reports the order, cooldowns and policy; clearCooldowns resets them', function () {
  const ctx = twoAccounts();
  breaker.markCooldown(ctx, 'a', 30000, 'throttled');
  const st = proxy.routeState(ctx);
  assert.deepStrictEqual(st.order, ['b']);
  const a = st.accounts.filter(function (x) {
    return x.name === 'a';
  })[0];
  assert.strictEqual(a.coolingSeconds, 30);
  assert.strictEqual(a.cooldownKind, 'throttled');
  assert.deepStrictEqual(st.policy.priority, []);
  assert.strictEqual(st.policy.cooldownSeconds.throttled, 60);
  assert.deepStrictEqual(proxy.clearCooldowns(ctx), ['a']);
  assert.strictEqual(breaker.cooldownOf(ctx, 'a').active, false);
});

test('debug headers can be turned off in config', async function () {
  const ctx = twoAccounts();
  config.set(ctx, 'proxy.debugHeaders', false);
  const out = await send(ctx, async function () {
    return ok('{}');
  });
  assert.strictEqual(out.res.headers['x-keyflip-account'], undefined);
});

// ---- declarative routing (proxy-routes.json): rules, sticky, fallback, transforms ----

function routesFile(ctx, obj) {
  fs.writeFileSync(path.join(ctx.configDir, 'proxy-routes.json'), JSON.stringify(obj));
  proxyroutes.resetCache();
}

// Like send(), but the request body is JSON so a model/token rule can match.
function sendBody(ctx, forward, reqBody, extra) {
  extra = extra || {};
  const opts = Object.assign({}, extra);
  delete opts.reqHeaders;
  const res = fakeRes();
  const sleeps = [];
  return proxy
    .handleRequest(
      ctx,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: extra.reqHeaders || {},
        body: Buffer.from(JSON.stringify(reqBody)),
      },
      res,
      Object.assign(
        {
          forward: forward,
          sleep: function (ms) {
            sleeps.push(ms);
            return Promise.resolve();
          },
        },
        opts,
      ),
    )
    .then(function (r) {
      return { r: r, res: res, sleeps: sleeps };
    });
}

test('fallback:off commits the first retryable response instead of failing over', async function () {
  const ctx = twoAccounts();
  routesFile(ctx, { fallback: 'off' });
  const seen = [];
  const out = await sendBody(
    ctx,
    async function (up) {
      seen.push(up.authVal);
      return { status: 429, headers: {}, body: Buffer.from('busy') };
    },
    { model: 'm' },
  );
  assert.deepStrictEqual(seen, ['Bearer TB']);
  assert.strictEqual(out.res.statusCode, 429);
  assert.strictEqual(out.res.headers['x-keyflip-attempts'], '1');
  assert.strictEqual(out.res.headers['x-keyflip-failover'], undefined);
});

test('fallback:model-chain degrades the model on the same account before failing over', async function () {
  const ctx = twoAccounts();
  routesFile(ctx, { fallback: 'model-chain', modelChain: ['claude-haiku-4-5'] });
  const models = [];
  const out = await sendBody(
    ctx,
    async function (up, req) {
      const j = JSON.parse(req.body.toString());
      models.push(j.model);
      if (j.model === 'claude-sonnet-4-5') return { status: 429, headers: {}, body: Buffer.from('busy') };
      return ok('{"ok":true}');
    },
    { model: 'claude-sonnet-4-5', max_tokens: 100 },
  );
  assert.deepStrictEqual(models, ['claude-sonnet-4-5', 'claude-haiku-4-5']);
  assert.strictEqual(out.res.statusCode, 200);
  assert.strictEqual(out.res.headers['x-keyflip-model'], 'claude-haiku-4-5');
  assert.strictEqual(out.res.headers['x-keyflip-account'], 'b', 'same account, not another one');
  assert.strictEqual(out.r.account, 'b');
  assert.strictEqual(breaker.cooldownOf(ctx, 'b').active, false, 'a model problem is not an account failure');
});

test('a rule sends a matching request to its account before the active one', async function () {
  const ctx = threeAccounts(); // c active
  routesFile(ctx, { rules: [{ name: 'sonnet-to-a', when: { model: '*sonnet*' }, use: { account: 'a' } }] });
  const seen = [];
  const out = await sendBody(
    ctx,
    async function (up) {
      seen.push(up.authVal);
      return ok('{}');
    },
    { model: 'claude-sonnet-4-5' },
  );
  assert.deepStrictEqual(seen, ['Bearer TA']);
  assert.strictEqual(out.r.account, 'a');
  assert.strictEqual(out.res.headers['x-keyflip-route'], 'rule #1 (sonnet-to-a)');
});

test('transforms rewrite outgoing headers and only lower max_tokens', async function () {
  const ctx = twoAccounts();
  routesFile(ctx, {
    transforms: {
      setHeaders: { 'x-team': 'pay' },
      removeHeaders: ['x-drop'],
      bodyModel: 'claude-haiku-4-5',
      maxTokens: 50,
    },
  });
  let got = null;
  const out = await sendBody(
    ctx,
    async function (up, req) {
      got = req;
      return ok('{}');
    },
    { model: 'claude-sonnet-4-5', max_tokens: 500 },
    { reqHeaders: { 'x-drop': '1' } },
  );
  assert.strictEqual(got.headers['x-team'], 'pay');
  assert.strictEqual(got.headers['x-drop'], undefined);
  const j = JSON.parse(got.body.toString());
  assert.strictEqual(j.model, 'claude-haiku-4-5');
  assert.strictEqual(j.max_tokens, 50);
  assert.strictEqual(out.r.model, 'claude-haiku-4-5');
});

test('a successful request pins its conversation (sticky) for the TTL', async function () {
  const ctx = twoAccounts();
  proxyroutes.resetCache();
  const out = await sendBody(
    ctx,
    async function () {
      return ok('{}');
    },
    { model: 'm', metadata: { user_id: 'conv-1' } },
  );
  assert.strictEqual(out.r.account, 'b');
  const ex = await proxy.explain(ctx, { model: 'm', user: 'conv-1' });
  assert.strictEqual(ex.decision.reason, 'sticky conversation -> b');
  assert.deepStrictEqual(ex.order, ['b', 'a']);
  proxyroutes.stickyReset();
});

test('explain reports the rule decision, the resulting order, and never sends anything', async function () {
  const ctx = threeAccounts();
  routesFile(ctx, { rules: [{ when: { tokensGt: 1000 }, use: { account: 'a' } }] });
  const ex = await proxy.explain(ctx, { model: 'claude-x', tokens: 2000 });
  assert.strictEqual(ex.decision.account, 'a');
  assert.strictEqual(ex.decision.reason, 'rule #1');
  assert.deepStrictEqual(ex.order, ['a', 'c', 'b']);
  assert.deepStrictEqual(ex.defaultOrder, ['c', 'a', 'b']);
  assert.strictEqual(ex.routes.exists, true);
  assert.strictEqual(ex.routes.rules.length, 1);
});

test('routeState carries the routing file, its errors included', async function () {
  const ctx = twoAccounts();
  routesFile(ctx, { rules: [{ when: { model: '*' }, use: { account: 'a' } }] });
  let st = proxy.routeState(ctx);
  assert.strictEqual(st.routes.exists, true);
  assert.strictEqual(st.routes.rules.length, 1);
  assert.deepStrictEqual(st.routes.errors, []);
  fs.writeFileSync(path.join(ctx.configDir, 'proxy-routes.json'), '{ oops');
  proxyroutes.resetCache();
  st = proxy.routeState(ctx);
  assert.match(st.routes.errors[0], /cannot read proxy-routes\.json/);
  assert.strictEqual(st.routes.fallback, 'retry', 'an invalid file falls back to the defaults');
});
