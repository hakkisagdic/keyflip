// NOTIFY: event-driven webhook + macOS desktop notifications. All IO is injected
// (opts.fetch / opts.run) so nothing here touches the network or spawns osascript.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as notify from '../src/notify.js';
import { makeCtx } from './helpers.js';

// A fetch double that records every call and returns a canned response.
function fetchRecorder(response) {
  const calls = [];
  const fn = async function (url, init) { calls.push({ url: url, init: init }); return response || { ok: true, status: 200 }; };
  fn.calls = calls;
  return fn;
}
// An exec.run double (matches src/exec.run's { code, stdout, stderr, error } shape).
function runRecorder(result) {
  const calls = [];
  const fn = function (cmd, args, input, opts) { calls.push({ cmd: cmd, args: args, input: input, opts: opts }); return result || { code: 0, stdout: '', stderr: '', error: null }; };
  fn.calls = calls;
  return fn;
}

// ---- config: defaults, merge, sanitize, persistence ----
test('getConfig returns safe defaults when no file exists', function () {
  const ctx = makeCtx();
  const cfg = notify.getConfig(ctx);
  assert.strictEqual(cfg.webhook, null);
  assert.strictEqual(cfg.desktop, false);
  assert.deepStrictEqual(cfg.events, notify.KNOWN_EVENTS);
});

test('setConfig merges patches without dropping other fields, and persists 0600', function () {
  const ctx = makeCtx();
  notify.setConfig(ctx, { webhook: 'https://hook.example/x' });
  notify.setConfig(ctx, { events: ['quota', 'switch'] });
  const cfg = notify.setConfig(ctx, { desktop: true });
  assert.strictEqual(cfg.webhook, 'https://hook.example/x'); // survived the later patches
  assert.deepStrictEqual(cfg.events, ['quota', 'switch']);
  assert.strictEqual(cfg.desktop, true);
  // round-trips through disk
  assert.deepStrictEqual(notify.getConfig(ctx), cfg);
  const mode = fs.statSync(notify.notifyPath(ctx)).mode & 0o777;
  assert.strictEqual(mode, 0o600);
});

test('setConfig with webhook:null clears the webhook', function () {
  const ctx = makeCtx();
  notify.setConfig(ctx, { webhook: 'https://hook.example/x' });
  const cfg = notify.setConfig(ctx, { webhook: null });
  assert.strictEqual(cfg.webhook, null);
});

test('non-http(s) webhooks are rejected (no file://, data://, javascript:)', function () {
  const ctx = makeCtx();
  ['file:///etc/passwd', 'data:text/plain,hi', 'javascript:alert(1)', 'ftp://x/y', 'not a url', ''].forEach(function (bad) {
    const cfg = notify.setConfig(ctx, { webhook: bad });
    assert.strictEqual(cfg.webhook, null, bad);
  });
  assert.strictEqual(notify.setConfig(ctx, { webhook: 'http://ok.example/h' }).webhook, 'http://ok.example/h');
});

test('events are validated + deduped; hostile names dropped', function () {
  const ctx = makeCtx();
  const cfg = notify.setConfig(ctx, { events: ['quota', 'quota', '__proto__', '../evil', 'has space', '', 'custom-1', 'a'.repeat(200)] });
  assert.deepStrictEqual(cfg.events, ['quota', 'custom-1']);
});

test('getConfig never throws on a corrupt file (returns defaults); setConfig refuses to clobber it', function () {
  const ctx = makeCtx();
  fs.writeFileSync(notify.notifyPath(ctx), '{ this is not json');
  const cfg = notify.getConfig(ctx);
  assert.strictEqual(cfg.webhook, null);
  assert.deepStrictEqual(cfg.events, notify.KNOWN_EVENTS);
  assert.throws(function () { notify.setConfig(ctx, { desktop: true }); }, /not valid JSON|refusing/i);
});

// ---- send: enablement gate ----
test('send does nothing (and never calls fetch) for a disabled event', async function () {
  const ctx = makeCtx();
  notify.setConfig(ctx, { webhook: 'https://hook.example/x', events: ['switch'] });
  const doFetch = fetchRecorder();
  const r = await notify.send(ctx, 'quota', { pct: 95 }, { fetch: doFetch });
  assert.strictEqual(r.sent, false);
  assert.strictEqual(r.reason, 'event-disabled');
  assert.strictEqual(doFetch.calls.length, 0);
});

test('send returns no-sink when the event is enabled but nothing is configured', async function () {
  const ctx = makeCtx();
  notify.setConfig(ctx, { events: ['quota'] }); // no webhook, desktop off
  const r = await notify.send(ctx, 'quota', { pct: 95 }, { fetch: fetchRecorder() });
  assert.strictEqual(r.sent, false);
  assert.strictEqual(r.reason, 'no-sink');
});

// ---- send: webhook ----
test('send POSTs { event, payload, at } as JSON to the webhook', async function () {
  const ctx = makeCtx();
  notify.setConfig(ctx, { webhook: 'https://hook.example/x', events: ['switch'] });
  const doFetch = fetchRecorder({ ok: true, status: 200 });
  const r = await notify.send(ctx, 'switch', { from: 'work', to: 'home' }, { fetch: doFetch });
  assert.strictEqual(r.sent, true);
  assert.strictEqual(doFetch.calls.length, 1);
  const call = doFetch.calls[0];
  assert.strictEqual(call.url, 'https://hook.example/x');
  assert.strictEqual(call.init.method, 'POST');
  assert.strictEqual(call.init.headers['content-type'], 'application/json');
  const body = JSON.parse(call.init.body);
  assert.strictEqual(body.event, 'switch');
  assert.deepStrictEqual(body.payload, { from: 'work', to: 'home' });
  assert.strictEqual(body.at, ctx.now());
});

test('a non-2xx webhook response counts as a failed delivery', async function () {
  const ctx = makeCtx();
  notify.setConfig(ctx, { webhook: 'https://hook.example/x', events: ['quota'] });
  const doFetch = fetchRecorder({ ok: false, status: 500 });
  const r = await notify.send(ctx, 'quota', { pct: 99 }, { fetch: doFetch });
  assert.strictEqual(r.sent, false);
  assert.strictEqual(r.reason, 'delivery-failed');
  assert.strictEqual(r.channels[0].httpStatus, 500);
});

test('a thrown fetch (network error) is caught, not propagated', async function () {
  const ctx = makeCtx();
  notify.setConfig(ctx, { webhook: 'https://hook.example/x', events: ['quota'] });
  const boom = async function () { throw new Error('ECONNREFUSED'); };
  const r = await notify.send(ctx, 'quota', { pct: 99 }, { fetch: boom });
  assert.strictEqual(r.sent, false);
  assert.strictEqual(r.channels[0].ok, false);
  assert.match(r.channels[0].reason, /ECONNREFUSED/);
});

// ---- send: secret stripping (the whole point) ----
test('secret-looking keys are stripped from the payload before it leaves the machine', async function () {
  const ctx = makeCtx();
  notify.setConfig(ctx, { webhook: 'https://hook.example/x', events: ['switch'] });
  const doFetch = fetchRecorder({ ok: true, status: 200 });
  const payload = {
    account: 'work',
    accessToken: 'sk-super-secret',
    apiKey: 'AK-nope',
    credential: 'c-nope',
    password: 'p-nope',
    refreshToken: 'r-nope',
    nested: { authorization: 'Bearer leak', ok: 'keep-me', deeper: { sessionKey: 'nope', level: 3 } },
  };
  const r = await notify.send(ctx, 'switch', payload, { fetch: doFetch });
  assert.strictEqual(r.sent, true);
  const rawBody = doFetch.calls[0].init.body;
  // Not a single secret VALUE appears anywhere in the serialized request.
  ['sk-super-secret', 'AK-nope', 'c-nope', 'p-nope', 'r-nope', 'Bearer leak', 'nope'].forEach(function (s) {
    assert.strictEqual(rawBody.indexOf(s), -1, 'leaked: ' + s);
  });
  const body = JSON.parse(rawBody);
  assert.strictEqual(body.payload.account, 'work');       // non-secret retained
  assert.strictEqual(body.payload.nested.ok, 'keep-me');  // non-secret retained (nested)
  assert.strictEqual(body.payload.nested.deeper.level, 3);
  assert.strictEqual('accessToken' in body.payload, false);
});

test('stripSecrets does not mutate the caller object and neutralizes __proto__ keys', function () {
  const original = { keep: 1, token: 'x', child: { password: 'y', keep2: 2 } };
  const cleaned = notify.stripSecrets(original);
  assert.strictEqual(original.token, 'x', 'input untouched');
  assert.strictEqual(cleaned.token, undefined);
  assert.strictEqual(cleaned.child.password, undefined);
  assert.strictEqual(cleaned.keep, 1);
  // A JSON.parse'd object can carry an own "__proto__" key — it must not pollute.
  const hostile = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}');
  const c2 = notify.stripSecrets(hostile);
  assert.strictEqual(({}).polluted, undefined, 'Object.prototype not polluted');
  assert.strictEqual(c2.safe, 1);
});

// ---- send: desktop (macOS) ----
test('desktop notification runs osascript with an escaped, single-line script', async function () {
  const ctx = makeCtx({ platform: 'darwin' });
  notify.setConfig(ctx, { desktop: true, events: ['switch'] });
  const run = runRecorder({ code: 0 });
  const r = await notify.send(ctx, 'switch', { message: 'He said "hi"\nthen left \\o/' }, { run: run });
  assert.strictEqual(r.sent, true);
  assert.strictEqual(run.calls.length, 1);
  assert.strictEqual(run.calls[0].cmd, '/usr/bin/osascript');
  const script = run.calls[0].args[1];
  assert.match(script, /display notification/);
  assert.match(script, /with title "keyflip"/);
  assert.strictEqual(script.indexOf('\n'), -1, 'newline was stripped (no AppleScript injection)');
  assert.ok(script.indexOf('\\"hi\\"') !== -1, 'inner quotes escaped');
});

test('desktop is skipped (not sent) off macOS', async function () {
  const ctx = makeCtx({ platform: 'linux' });
  notify.setConfig(ctx, { desktop: true, events: ['switch'] });
  const run = runRecorder({ code: 0 });
  const r = await notify.send(ctx, 'switch', { message: 'hi' }, { run: run });
  assert.strictEqual(r.sent, false);
  assert.strictEqual(run.calls.length, 0);
  assert.strictEqual(r.channels[0].reason, 'not-macos');
});

test('with both sinks, a webhook failure still yields sent:true if desktop succeeds', async function () {
  const ctx = makeCtx({ platform: 'darwin' });
  notify.setConfig(ctx, { webhook: 'https://hook.example/x', desktop: true, events: ['quota'] });
  const boom = async function () { throw new Error('offline'); };
  const run = runRecorder({ code: 0 });
  const r = await notify.send(ctx, 'quota', { pct: 100 }, { fetch: boom, run: run });
  assert.strictEqual(r.sent, true);
  assert.strictEqual(r.channels.length, 2);
  assert.ok(r.channels.some(function (c) { return c.channel === 'desktop' && c.ok; }));
});

// ---- test() ----
test('test() forces delivery even when "test" is not in the enabled events', async function () {
  const ctx = makeCtx();
  notify.setConfig(ctx, { webhook: 'https://hook.example/x', events: ['quota'] }); // 'test' NOT enabled
  const doFetch = fetchRecorder({ ok: true, status: 200 });
  const r = await notify.test(ctx, { fetch: doFetch });
  assert.strictEqual(r.sent, true);
  assert.strictEqual(doFetch.calls.length, 1);
  assert.strictEqual(JSON.parse(doFetch.calls[0].init.body).event, 'test');
});

test('test() reports no-sink when nothing is configured', async function () {
  const ctx = makeCtx();
  const r = await notify.test(ctx, { fetch: fetchRecorder() });
  assert.strictEqual(r.sent, false);
  assert.strictEqual(r.reason, 'no-sink');
});
