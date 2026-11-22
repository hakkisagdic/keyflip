import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as proxyroutes from '../src/proxyroutes.js';
import { makeCtx, tmpdir } from './helpers.js';

function writeRoutes(ctx, obj) {
  const file = proxyroutes.routesPath(ctx);
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
  proxyroutes.resetCache();
  return file;
}

function body(obj) {
  return Buffer.from(JSON.stringify(obj));
}

test('a missing file is "not configured", never an error', function () {
  const ctx = makeCtx();
  const l = proxyroutes.load(ctx);
  assert.strictEqual(l.exists, false);
  assert.strictEqual(l.configured, false);
  assert.deepStrictEqual(l.errors, []);
  assert.strictEqual(l.routes.fallback, 'retry');
  assert.strictEqual(l.routes.sticky.enabled, true);
});

test('validate accepts a real file and names every mistake', function () {
  const ok = proxyroutes.validate({
    version: 1,
    fallback: 'model-chain',
    sticky: { enabled: false, ttlSeconds: 60 },
    modelChain: ['claude-haiku-4-5'],
    rules: [
      { name: 'opus', when: { model: '*opus*' }, use: { account: 'a' } },
      { when: { tokensGt: 100, header: { 'x-agent': 'claude*' } }, use: { model: 'claude-sonnet-4-5' } },
    ],
    transforms: {
      setHeaders: { 'x-team': 'me' },
      removeHeaders: ['x-debug'],
      bodyModel: 'claude-haiku-4-5',
      maxTokens: 512,
    },
    customRouter: '~/router.js',
  });
  assert.deepStrictEqual(ok.errors, []);
  assert.strictEqual(ok.routes.fallback, 'model-chain');
  assert.strictEqual(ok.routes.rules.length, 2);
  assert.strictEqual(ok.routes.transforms.maxTokens, 512);

  const bad = proxyroutes.validate({
    fallback: 'sometimes',
    extra: 1,
    sticky: { ttlSeconds: 999999, nope: true },
    modelChain: ['not a model'],
    rules: [{ when: {}, use: {} }, { when: { header: { 'bad header': 'x' } }, use: { account: 'a' } }, 'nope'],
    transforms: { maxTokens: 0, setHeaders: { 'x y': '1' } },
  });
  const joined = bad.errors.join('\n');
  assert.match(joined, /unknown key: extra/);
  assert.match(joined, /fallback must be one of/);
  assert.match(joined, /sticky\.ttlSeconds must be an integer/);
  assert.match(joined, /unknown key: sticky\.nope/);
  assert.match(joined, /modelChain\[0\]/);
  assert.match(joined, /rules\[0\]\.when must be a non-empty object/);
  assert.match(joined, /rules\[1\]\.when\.header: invalid header name/);
  assert.match(joined, /rules\[2\] must be an object/);
  assert.match(joined, /transforms\.maxTokens/);
  assert.match(joined, /transforms\.setHeaders: invalid header name/);
  assert.deepStrictEqual(bad.routes.rules, [], 'a broken rule is never half-accepted');
});

test('a corrupt file is reported and defaults apply; an edit hot-reloads', function () {
  const ctx = makeCtx();
  writeRoutes(ctx, '{ not json');
  const bad = proxyroutes.load(ctx);
  assert.strictEqual(bad.exists, true);
  assert.match(bad.errors[0], /cannot read proxy-routes\.json/);
  assert.strictEqual(bad.routes.fallback, 'retry');

  const file = writeRoutes(ctx, { fallback: 'off' });
  const first = proxyroutes.load(ctx);
  assert.strictEqual(first.routes.fallback, 'off');
  assert.strictEqual(proxyroutes.load(ctx), first, 'an unchanged file is served from the mtime cache');

  writeRoutes(ctx, { fallback: 'model-chain' });
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later); // force a new mtime even on a coarse filesystem
  assert.strictEqual(proxyroutes.load(ctx).routes.fallback, 'model-chain');
});

test('estimateTokens counts text fields, and falls back to bytes/4', function () {
  assert.strictEqual(proxyroutes.estimateTokens(body({ system: 'abcd', messages: [{ content: 'efgh' }] })), 6);
  const withBlocks = body({
    messages: [{ content: [{ type: 'text', text: 'x'.repeat(400) }] }, { content: 'ignored-but-counted' }],
  });
  const n = proxyroutes.estimateTokens(withBlocks);
  assert.ok(n >= 100 && n <= 120, 'x*400 chars ≈ 100 tokens + overhead, got ' + n);
  assert.strictEqual(proxyroutes.estimateTokens(Buffer.from('y'.repeat(40))), 10);
  assert.strictEqual(proxyroutes.estimateTokens(Buffer.alloc(0)), 0);
});

test('the conversation key comes from metadata, then the opt-in header', function () {
  assert.strictEqual(proxyroutes.userKeyOf({ body: body({ metadata: { user_id: 'conv-1' } }) }), 'conv-1');
  assert.strictEqual(proxyroutes.userKeyOf({ body: body({ metadata: { session_id: 's-1' } }) }), 's-1');
  assert.strictEqual(proxyroutes.userKeyOf({ headers: { 'x-keyflip-session': 'h-1' } }), 'h-1');
  assert.strictEqual(proxyroutes.userKeyOf({ body: body({}), headers: {} }), null);
});

test('rules: first match wins and every guard is evaluated', function () {
  const ctx = makeCtx();
  const { routes } = proxyroutes.validate({
    rules: [
      { name: 'opus', when: { model: '*opus*' }, use: { account: 'a' } },
      { name: 'big', when: { tokensGt: 1000, path: '/v1/*' }, use: { account: 'b' } },
      { name: 'agent', when: { header: { 'x-agent': 'claude*' }, user: 'conv-*' }, use: { model: 'm-2' } },
    ],
  });
  const facts = { model: 'claude-opus-4', path: '/v1/messages', tokens: 5, headers: {}, user: null };
  assert.deepStrictEqual(proxyroutes.pickRule(routes, facts), {
    account: 'a',
    model: null,
    reason: 'rule #1 (opus)',
    ruleIndex: 0,
  });
  assert.strictEqual(
    proxyroutes.pickRule(routes, Object.assign({}, facts, { model: 'claude-sonnet-4-5', tokens: 2000 })).account,
    'b',
  );
  assert.strictEqual(
    proxyroutes.pickRule(routes, Object.assign({}, facts, { model: 'x', tokens: 2000, path: '/other' })),
    null,
  );
  const agent = proxyroutes.pickRule(
    routes,
    Object.assign({}, facts, { model: 'x', headers: { 'X-Agent': 'claude-code' }, user: 'conv-9' }),
  );
  assert.strictEqual(agent.model, 'm-2');
  assert.strictEqual(proxyroutes.matchWhen({ account: 'a' }, { account: 'b' }), false);
});

test('sticky: bounded, expires on TTL, and resets', function () {
  proxyroutes.stickyReset();
  assert.strictEqual(proxyroutes.stickyGet('k', 60000, 1000), null);
  assert.strictEqual(proxyroutes.stickySet('k', 'a', 60000, 1000), true);
  assert.strictEqual(proxyroutes.stickyGet('k', 60000, 2000), 'a');
  assert.strictEqual(proxyroutes.stickyGet('k', 60000, 1000 + 60001), null, 'expired entries are dropped');
  assert.strictEqual(proxyroutes.stickySet('k', 'a', 0, 1000), false, 'ttl 0 disables stickiness');
  for (let i = 0; i < 1005; i++) proxyroutes.stickySet('c' + i, 'a', 60000, 1000);
  assert.strictEqual(proxyroutes.stickySize(), 1000, 'the map never grows past its cap');
  proxyroutes.stickyReset();
  assert.strictEqual(proxyroutes.stickySize(), 0);
});

test('transforms are bounded: headers, model, and max_tokens is only ever lowered', function () {
  const ctx = makeCtx();
  const { routes } = proxyroutes.validate({
    transforms: { setHeaders: { 'x-team': 'pay' }, removeHeaders: ['X-DROP'], bodyModel: 'm-cheap', maxTokens: 100 },
  });
  const r = proxyroutes.applyTransforms(
    { headers: { 'x-drop': '1', keep: '2' }, body: body({ model: 'm-big', max_tokens: 500 }) },
    routes,
  );
  assert.strictEqual(r.info.headers['x-team'], 'pay');
  assert.deepStrictEqual(Object.keys(r.info.headers), ['keep', 'x-team']);
  const j = JSON.parse(r.info.body.toString());
  assert.strictEqual(j.model, 'm-cheap');
  assert.strictEqual(j.max_tokens, 100);
  assert.deepStrictEqual(r.notes, []);

  const lower = proxyroutes.applyTransforms({ headers: {}, body: body({ max_tokens: 20 }) }, routes);
  assert.strictEqual(JSON.parse(lower.info.body.toString()).max_tokens, 20, 'a smaller client cap is kept');

  const raw = proxyroutes.applyTransforms({ headers: {}, body: Buffer.from('not json') }, routes);
  assert.strictEqual(raw.info.body.toString(), 'not json');
  assert.match(raw.notes[0], /not JSON/);
  assert.strictEqual(proxyroutes.withModel(Buffer.from('not json'), 'm'), null);
});

test('decide: a rule naming a parked account is reported, not honored', async function () {
  const { routes } = proxyroutes.validate({ rules: [{ name: 'r', when: { model: '*' }, use: { account: 'zzz' } }] });
  const d = await proxyroutes.decide(
    routes,
    { model: 'm', path: '/', tokens: 0, headers: {} },
    { accounts: ['a', 'b'] },
  );
  assert.strictEqual(d.account, null);
  assert.strictEqual(d.matched, 'rule #1 (r)');
  assert.match(d.reason, /"zzz", which is not usable now/);
});

test('decide: sticky beats the default order but never a cooldown', async function () {
  proxyroutes.stickyReset();
  const { routes } = proxyroutes.validate({});
  proxyroutes.stickySet('conv-1', 'b', 60000, 1000);
  const d = await proxyroutes.decide(
    routes,
    { model: 'm', path: '/', tokens: 0, headers: {}, user: 'conv-1' },
    { accounts: ['a', 'b'], nowMs: 2000, skipHook: true },
  );
  assert.strictEqual(d.account, 'b');
  assert.strictEqual(d.reason, 'sticky conversation -> b');
  const parked = await proxyroutes.decide(
    routes,
    { model: 'm', path: '/', tokens: 0, headers: {}, user: 'conv-1' },
    { accounts: ['a'], nowMs: 2000, skipHook: true },
  );
  assert.strictEqual(parked.account, null, 'a sticky name that is cooling does not override the usable set');
  proxyroutes.stickyReset();
});

function hookScript(code) {
  const file = path.join(tmpdir(), 'router.js');
  fs.writeFileSync(file, code);
  return file;
}

test('custom router: a script may pick the account/model; bad ones fail soft', async function () {
  const { routes } = proxyroutes.validate({
    customRouter: hookScript(
      'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);' +
        'process.stdout.write(JSON.stringify({account:j.accounts[1],model:"m-cheap",reason:"cheap"}))});',
    ),
  });
  const d = await proxyroutes.decide(
    routes,
    { model: 'm', path: '/v1/messages', tokens: 10, headers: {} },
    { accounts: ['a', 'b'], nowMs: 1000 },
  );
  assert.strictEqual(d.account, 'b');
  assert.strictEqual(d.model, 'm-cheap');
  assert.match(d.reason, /cheap \(file\)/);

  const junk = await proxyroutes.runCustomRouter(hookScript('process.stdout.write("hello")'), {});
  assert.match(junk.error, /printed no JSON/);
  const boom = await proxyroutes.runCustomRouter(hookScript('process.exit(3)'), {});
  assert.match(boom.error, /exited with code 3/);
  const slow = await proxyroutes.runCustomRouter(hookScript('setInterval(()=>{},1000)'), {}, { timeoutMs: 50 });
  assert.match(slow.error, /timed out/);
});

test('an env override wins over the file, and skipHook never spawns it', async function () {
  const { routes } = proxyroutes.validate({ customRouter: '/from/file.js' });
  const prev = process.env.CUSTOM_ROUTER_PATH;
  process.env.CUSTOM_ROUTER_PATH = '~/from-env.js';
  try {
    const h = proxyroutes.hookCommand(routes.customRouter);
    assert.strictEqual(h.source, 'env');
    assert.ok(path.isAbsolute(h.cmd), 'a ~ path is expanded');
    assert.match(h.cmd, /from-env\.js$/);
    assert.deepStrictEqual(proxyroutes.hookCommand(null), h);
  } finally {
    if (prev === undefined) delete process.env.CUSTOM_ROUTER_PATH;
    else process.env.CUSTOM_ROUTER_PATH = prev;
  }
  const d = await proxyroutes.decide(
    { routes: routes, sticky: routes.sticky, rules: [], customRouter: hookScript('process.stdout.write("{}")') },
    { model: 'm', path: '/', tokens: 0, headers: {} },
    { accounts: ['a'], skipHook: true },
  );
  assert.strictEqual(d.account, null);
  assert.strictEqual(d.hookError, null, 'skipHook does not run (and does not report) the hook');
});

test('describe reports the file, its errors and the effective policy', function () {
  const ctx = makeCtx();
  let d = proxyroutes.describe(ctx);
  assert.strictEqual(d.exists, false);
  assert.strictEqual(d.fallback, 'retry');
  assert.deepStrictEqual(d.rules, []);
  assert.strictEqual(d.customRouter, null);

  writeRoutes(ctx, {
    rules: [{ name: 'x', when: { model: '*' }, use: { account: 'a' } }],
    transforms: { maxTokens: 10 },
  });
  d = proxyroutes.describe(ctx);
  assert.strictEqual(d.exists, true);
  assert.strictEqual(d.rules.length, 1);
  assert.strictEqual(d.rules[0].name, 'x');
  assert.strictEqual(d.transforms.maxTokens, 10);
});
