// #40 COST GATE: dream / distill / recall --answer must be routable AWAY from the subscription.
// src/llm.js is the seam — these tests pin the resolution order, the config-level gates, the
// OpenAI/Ollama wire shapes, and above all that an endpoint key is never stored, returned, or
// echoed (the keyflip state dir is a git repo).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import { makeCtx } from './helpers.js';
import * as llm from '../src/llm.js';
import * as config from '../src/config.js';

// A poster that records the request and answers like the endpoint under test.
function poster(responder) {
  const calls = [];
  const fn = function (url, body, headers, timeoutMs) {
    calls.push({ url: url, body: body, headers: headers || {}, timeoutMs: timeoutMs });
    const r = responder(url, body, headers);
    return r && r.then ? r : Promise.resolve(r);
  };
  return { fn: fn, calls: calls };
}

test('the default provider is claude -p, and it says so in cost terms', function () {
  const ctx = makeCtx();
  const p = llm.resolve(ctx);
  assert.strictEqual(p.provider, 'claude');
  assert.match(p.cost, /quota/i, 'a user must be able to see what it burns');
  assert.strictEqual(p.needsKey, false);
  // Nothing configured => the pre-provider behavior, exactly.
  assert.strictEqual(llm.available(ctx, { run: () => ({ code: 0 }) }), true);
  assert.strictEqual(llm.available(ctx, { run: () => ({ code: 127 }) }), false);
});

test('provider=ollama brings its own local endpoint + model defaults', function () {
  const ctx = makeCtx();
  config.set(ctx, 'llm.provider', 'ollama');
  const p = llm.resolve(ctx);
  assert.strictEqual(p.provider, 'ollama');
  assert.strictEqual(p.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.ok(p.model, 'ollama needs a model name to be usable out of the box');
  assert.match(p.cost, /local/i);
  // Local = no key, and usable without network knowledge.
  assert.strictEqual(llm.availability(ctx).ok, true);
  assert.strictEqual(llm.available(ctx), true, 'ollama must not require claude on PATH');
});

test('an endpoint provider is gated on what it actually needs', function () {
  const ctx = makeCtx();
  config.set(ctx, 'llm.provider', 'openai');
  let g = llm.availability(ctx);
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.reason, 'no-base-url');
  assert.match(g.fix, /keyflip llm set --base-url/);

  config.set(ctx, 'llm.base_url', 'https://gateway.example.com/v1');
  g = llm.availability(ctx);
  assert.strictEqual(g.reason, 'no-key-env', 'an endpoint that needs a key must say so before the call');

  config.set(ctx, 'llm.key_env', 'MY_GATEWAY_KEY');
  g = llm.availability(ctx);
  assert.strictEqual(g.reason, 'key-env-unset');
  assert.match(g.fix, /export MY_GATEWAY_KEY/, 'the fix names the variable, never a value');
  assert.strictEqual(llm.available(ctx), false);

  g = llm.availability(ctx, { env: { MY_GATEWAY_KEY: 'sk-super-secret' } });
  assert.strictEqual(g.ok, true, 'with the env var present, it is usable');
  assert.strictEqual(llm.available(ctx, { env: { MY_GATEWAY_KEY: 'sk-super-secret' } }), true);
});

test('complete() routes a claude-provider call through `claude -p` with the transcript on stdin', async function () {
  const ctx = makeCtx();
  let seen = null;
  const run = function (cmd, args, input) {
    seen = { cmd: cmd, args: args, input: input };
    return { code: 0, stdout: 'SUMMARY\n' };
  };
  const r = await llm.complete(ctx, 'INSTRUCTION', 'THE TRANSCRIPT', { run: run, skipCheck: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.provider, 'claude');
  assert.strictEqual(seen.cmd, 'claude');
  assert.strictEqual(seen.args[0], '-p');
  assert.strictEqual(seen.input, 'THE TRANSCRIPT', 'the body never rides in argv');
});

test('complete() posts OpenAI-shaped messages and reads the answer back', async function () {
  const ctx = makeCtx();
  config.set(ctx, 'llm.provider', 'ollama');
  config.set(ctx, 'llm.model', 'qwen2.5:7b-instruct');
  const post = poster(() => ({ choices: [{ message: { content: '  distilled text  ' } }] }));
  const r = await llm.complete(ctx, 'SYSTEM INSTRUCTION', 'BODY', { post: post.fn, skipCheck: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, 'distilled text', 'output is trimmed');
  assert.strictEqual(r.provider, 'ollama');
  assert.strictEqual(r.model, 'qwen2.5:7b-instruct');
  assert.strictEqual(post.calls.length, 1);
  const call = post.calls[0];
  assert.strictEqual(call.url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.strictEqual(call.body.model, 'qwen2.5:7b-instruct');
  assert.strictEqual(call.body.messages[0].role, 'system');
  assert.strictEqual(call.body.messages[0].content, 'SYSTEM INSTRUCTION');
  assert.strictEqual(call.body.messages[1].content, 'BODY');
  assert.deepStrictEqual(call.headers, {}, 'a local ollama endpoint gets no Authorization header');
  assert.match(r.cost, /local/i, 'the result keeps saying what it cost');
});

test('an OpenAI-compatible endpoint authenticates from the named env var — and the key never escapes', async function () {
  const ctx = makeCtx();
  config.set(ctx, 'llm.provider', 'openai');
  config.set(ctx, 'llm.base_url', 'https://gateway.example.com/v1/');
  config.set(ctx, 'llm.key_env', 'GATEWAY_KEY');
  const SECRET = 'sk-abcdef-0123456789-DO-NOT-LEAK';
  const post = poster(() => ({ choices: [{ message: { content: 'ok' } }] }));
  const r = await llm.complete(ctx, 'SYS', 'BODY', {
    post: post.fn,
    env: { GATEWAY_KEY: SECRET },
    skipCheck: true,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(post.calls[0].headers.authorization, 'Bearer ' + SECRET, 'sent as a header, not in the body');
  assert.strictEqual(post.calls[0].url, 'https://gateway.example.com/v1/chat/completions', 'trailing slash normalized');
  const leaked = JSON.stringify(r);
  assert.ok(leaked.indexOf(SECRET) === -1, 'a result must never carry the key back to the caller/agent');
  // and nothing was written to the state repo
  const cfg = fs.readFileSync(ctx.configDir + '/config.json', 'utf8');
  assert.ok(cfg.indexOf(SECRET) === -1, 'the key is never stored in config.json');
  assert.match(cfg, /GATEWAY_KEY/, 'only the NAME is stored');
});

test('an unreachable or failing endpoint returns a clean reason — with no key in the detail', async function () {
  const ctx = makeCtx();
  config.set(ctx, 'llm.provider', 'openai');
  config.set(ctx, 'llm.base_url', 'https://gateway.example.com/v1');
  config.set(ctx, 'llm.key_env', 'GATEWAY_KEY');
  const SECRET = 'sk-never-in-an-error';
  const bad = poster(() => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:1')));
  const r = await llm.complete(ctx, 'S', 'B', { post: bad.fn, env: { GATEWAY_KEY: SECRET }, skipCheck: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'endpoint-failed');
  assert.match(r.detail, /ECONNREFUSED/);
  assert.ok(JSON.stringify(r).indexOf(SECRET) === -1);
  const empty = poster(() => ({ choices: [{ message: { content: '   ' } }] }));
  const r2 = await llm.complete(ctx, 'S', 'B', { post: empty.fn, env: { GATEWAY_KEY: SECRET }, skipCheck: true });
  assert.strictEqual(r2.reason, 'empty-output');
});

test('extractText understands the shapes actually seen in the wild', function () {
  assert.strictEqual(llm.extractText({ choices: [{ message: { content: 'a' } }] }), 'a');
  assert.strictEqual(llm.extractText({ choices: [{ text: 'b' }] }), 'b');
  assert.strictEqual(llm.extractText({ response: 'c' }), 'c', 'ollama /api/generate');
  assert.strictEqual(llm.extractText({ message: { content: 'd' } }), 'd');
  assert.strictEqual(llm.extractText({ nonsense: 1 }), null);
  assert.strictEqual(llm.extractText(null), null);
});

test('KEYFLIP_LLM_* env overrides config, so a cron job can reroute without editing shared state', function () {
  const ctx = makeCtx();
  config.set(ctx, 'llm.provider', 'ollama');
  assert.strictEqual(llm.resolve(ctx).provider, 'ollama');
  assert.strictEqual(llm.resolve(ctx, { env: { KEYFLIP_LLM_PROVIDER: 'claude' } }).provider, 'claude');
  assert.strictEqual(
    llm.resolve(ctx, { env: { KEYFLIP_LLM_BASE_URL: 'http://elsewhere:9/v1' } }).baseUrl,
    'http://elsewhere:9/v1',
  );
  // an explicit opt wins over both
  assert.strictEqual(llm.resolve(ctx, { env: { KEYFLIP_LLM_MODEL: 'a' }, model: 'b' }).model, 'b');
});

test('an unknown provider name degrades to claude instead of throwing', function () {
  const ctx = makeCtx();
  // config.set validates enums, so an unknown name can only arrive from the env override path.
  const p = llm.resolve(ctx, { env: { KEYFLIP_LLM_PROVIDER: 'gpt-whatever' } });
  assert.strictEqual(p.provider, 'claude');
});
