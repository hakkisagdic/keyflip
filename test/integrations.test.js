// CHAT INTEGRATIONS (Slack / Discord): outbound, per-platform formatting + posting.
// All IO/time is injected (opts.fetch / ctx.fetch / opts.clock) so nothing here
// touches the network. Covers happy paths (format + route + status) and hostile
// paths (secret leakage, prototype-pollution event names, bad webhooks, corrupt log).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import * as integrations from '../src/integrations.js';
import * as core from '../src/core.js';
import { makeCtx, writeClaude } from './helpers.js';
import _path from 'path';

// A fetch double that records every call and returns a canned response.
function fetchRecorder(response) {
  const calls = [];
  const fn = async function (url, init) {
    calls.push({ url: url, init: init });
    return response || { ok: true, status: 200 };
  };
  fn.calls = calls;
  return fn;
}
// Log in + save an account, then return to it as the active one.
function addAccount(ctx, email, userID, liveBlob) {
  writeClaude(ctx, { oauthAccount: { emailAddress: email }, userID: userID });
  ctx.store.setLive(liveBlob);
  return core.addCurrent(ctx);
}

// ---- detect: host -> platform ----
test('detect maps webhook hosts to platforms', function () {
  assert.strictEqual(integrations.detect('https://hooks.slack.com/services/T/B/xxx'), 'slack');
  assert.strictEqual(integrations.detect('https://mine.slack.com/hook'), 'slack');
  assert.strictEqual(integrations.detect('https://discord.com/api/webhooks/123/abc'), 'discord');
  assert.strictEqual(integrations.detect('https://ptb.discord.com/api/webhooks/1/x'), 'discord');
  assert.strictEqual(integrations.detect('https://discordapp.com/api/webhooks/1/x'), 'discord');
  assert.strictEqual(integrations.detect('https://example.com/generic'), 'generic');
  assert.strictEqual(integrations.detect('not a url'), 'generic');
  // A lookalike host must NOT be misdetected.
  assert.strictEqual(integrations.detect('https://slack.com.evil.example/x'), 'generic');
  assert.strictEqual(integrations.detect('https://notdiscord.com/x'), 'generic');
});

// ---- formatSlack ----
test('formatSlack returns a Block Kit message: header, summary, fields, footer', function () {
  const msg = integrations.formatSlack('switch', {
    message: 'switched work to home',
    from: 'work',
    to: 'home',
    at: '2026-01-01T00:00:00.000Z',
  });
  assert.ok(Array.isArray(msg.blocks));
  assert.strictEqual(msg.blocks[0].type, 'header');
  assert.strictEqual(msg.blocks[0].text.type, 'plain_text');
  assert.match(msg.blocks[0].text.text, /Account switched/);
  const section = msg.blocks.find(function (b) {
    return b.type === 'section' && b.text;
  });
  assert.match(section.text.text, /switched work to home/);
  const fieldBlock = msg.blocks.find(function (b) {
    return b.type === 'section' && b.fields;
  });
  assert.ok(
    fieldBlock.fields.some(function (f) {
      return /from/.test(f.text) && /work/.test(f.text);
    }),
  );
  const ctxBlock = msg.blocks[msg.blocks.length - 1];
  assert.strictEqual(ctxBlock.type, 'context');
  assert.match(ctxBlock.elements[0].text, /keyflip/);
  assert.match(ctxBlock.elements[0].text, /2026-01-01/); // timestamp from payload.at
});

test('formatSlack escapes mrkdwn metacharacters and strips control chars', function () {
  const msg = integrations.formatSlack('note', { message: 'a & b < c > d\nnewline' });
  const section = msg.blocks.find(function (b) {
    return b.type === 'section' && b.text;
  });
  assert.match(section.text.text, /&amp; b &lt; c &gt; d/);
  assert.strictEqual(section.text.text.indexOf('\n'), -1, 'newline stripped');
});

test('formatSlack on an unknown/hostile event name falls back to a default (no pollution)', function () {
  const msg = integrations.formatSlack('__proto__', { message: 'hi' });
  assert.strictEqual(msg.blocks[0].type, 'header');
  assert.ok(msg.blocks[0].text.text.length > 0);
  assert.strictEqual({}.polluted, undefined);
});

// ---- formatDiscord ----
test('formatDiscord returns an embed: title, color, description, fields, footer, timestamp', function () {
  const embed = integrations.formatDiscord('quota', { message: 'over quota', pct: 95, at: '2026-01-01T00:00:00.000Z' });
  assert.match(embed.title, /Quota alert/);
  assert.strictEqual(typeof embed.color, 'number');
  assert.strictEqual(embed.description, 'over quota');
  assert.ok(
    embed.fields.some(function (f) {
      return f.name === 'pct' && f.value === '95';
    }),
  );
  assert.match(embed.footer.text, /keyflip/);
  assert.strictEqual(embed.timestamp, '2026-01-01T00:00:00.000Z');
});

test('formatDiscord omits a non-ISO timestamp', function () {
  const embed = integrations.formatDiscord('note', { message: 'x', at: 'not-a-date' });
  assert.strictEqual('timestamp' in embed, false);
});

// ---- post: routing per platform ----
test('post sends Slack blocks to a Slack webhook', async function () {
  const ctx = makeCtx();
  const doFetch = fetchRecorder({ ok: true, status: 200 });
  const r = await integrations.post(
    ctx,
    { url: 'https://hooks.slack.com/services/x', event: 'note', payload: { message: 'hi' } },
    { fetch: doFetch },
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.platform, 'slack');
  const body = JSON.parse(doFetch.calls[0].init.body);
  assert.ok(Array.isArray(body.blocks));
  assert.strictEqual(doFetch.calls[0].init.method, 'POST');
});

test('post wraps a Discord embed under { embeds: [...] }', async function () {
  const ctx = makeCtx();
  const doFetch = fetchRecorder({ ok: true, status: 204 });
  const r = await integrations.post(
    ctx,
    { url: 'https://discord.com/api/webhooks/1/x', event: 'note', payload: { message: 'hi' } },
    { fetch: doFetch },
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.platform, 'discord');
  const body = JSON.parse(doFetch.calls[0].init.body);
  assert.ok(Array.isArray(body.embeds));
  assert.match(body.embeds[0].title, /keyflip|note|notification/i);
});

test('post uses the generic envelope for an unknown host', async function () {
  const ctx = makeCtx();
  const doFetch = fetchRecorder({ ok: true, status: 200 });
  const r = await integrations.post(
    ctx,
    { url: 'https://example.com/hook', event: 'switch', payload: { from: 'a', to: 'b' } },
    { fetch: doFetch },
  );
  assert.strictEqual(r.platform, 'generic');
  const body = JSON.parse(doFetch.calls[0].init.body);
  assert.strictEqual(body.event, 'switch');
  assert.deepStrictEqual(body.payload, { from: 'a', to: 'b' });
  assert.strictEqual(body.at, ctx.now());
});

// ---- post: secret stripping (the whole point) ----
test('post secret-strips the payload before it leaves the machine (every platform)', async function () {
  const ctx = makeCtx();
  const payload = {
    account: 'work',
    message: 'switching',
    accessToken: 'sk-super-secret',
    apiKey: 'AK-nope',
    credential: 'c-nope',
    password: 'p-nope',
    nested: { authorization: 'Bearer leak', ok: 'keep-me' },
  };
  for (const url of ['https://hooks.slack.com/x', 'https://discord.com/api/webhooks/1/x', 'https://example.com/x']) {
    const doFetch = fetchRecorder({ ok: true, status: 200 });
    await integrations.post(ctx, { url: url, event: 'switch', payload: payload }, { fetch: doFetch });
    const raw = doFetch.calls[0].init.body;
    ['sk-super-secret', 'AK-nope', 'c-nope', 'p-nope', 'Bearer leak'].forEach(function (s) {
      assert.strictEqual(raw.indexOf(s), -1, 'leaked ' + s + ' to ' + url);
    });
    assert.ok(
      raw.indexOf('keep-me') !== -1 || url.indexOf('slack') !== -1 || url.indexOf('discord') !== -1,
      'non-secret retained (generic)',
    );
  }
});

// ---- post: hostile inputs ----
test('post rejects a non-http(s) webhook without calling fetch', async function () {
  const ctx = makeCtx();
  const doFetch = fetchRecorder();
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url', '']) {
    const r = await integrations.post(ctx, { url: bad, event: 'note', payload: { message: 'x' } }, { fetch: doFetch });
    assert.strictEqual(r.ok, false, bad);
    assert.strictEqual(r.reason, 'bad-webhook', bad);
  }
  assert.strictEqual(doFetch.calls.length, 0);
});

test('post catches a network error and a non-2xx response', async function () {
  const ctx = makeCtx();
  const boom = async function () {
    throw new Error('ECONNREFUSED');
  };
  const r1 = await integrations.post(
    ctx,
    { url: 'https://hooks.slack.com/x', event: 'note', payload: {} },
    { fetch: boom },
  );
  assert.strictEqual(r1.ok, false);
  assert.match(r1.reason, /ECONNREFUSED/);
  const r2 = await integrations.post(
    ctx,
    { url: 'https://hooks.slack.com/x', event: 'note', payload: {} },
    { fetch: fetchRecorder({ ok: false, status: 500 }) },
  );
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.httpStatus, 500);
  assert.strictEqual(r2.reason, 'http-500');
});

test('post uses opts.clock for the timestamp when provided', async function () {
  const ctx = makeCtx();
  const doFetch = fetchRecorder({ ok: true, status: 200 });
  const r = await integrations.post(
    ctx,
    { url: 'https://example.com/x', event: 'note', payload: {} },
    {
      fetch: doFetch,
      clock: function () {
        return '2030-05-05T05:05:05.000Z';
      },
    },
  );
  assert.strictEqual(r.at, '2030-05-05T05:05:05.000Z');
  assert.strictEqual(JSON.parse(doFetch.calls[0].init.body).at, '2030-05-05T05:05:05.000Z');
});

// ---- delivery log: non-secret, bounded, 0600 ----
test('post records a NON-SECRET delivery log (no url, no payload) at 0600', async function () {
  const ctx = makeCtx();
  const doFetch = fetchRecorder({ ok: true, status: 200 });
  await integrations.post(
    ctx,
    { url: 'https://hooks.slack.com/secret-token-abc', event: 'switch', payload: { accessToken: 'sk-leak' } },
    { fetch: doFetch },
  );
  const raw = fs.readFileSync(integrations.statePath(ctx), 'utf8');
  assert.strictEqual(raw.indexOf('secret-token-abc'), -1, 'webhook token not logged');
  assert.strictEqual(raw.indexOf('sk-leak'), -1, 'payload secret not logged');
  const log = integrations.history(ctx);
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].platform, 'slack');
  assert.strictEqual(log[0].event, 'switch');
  assert.strictEqual(log[0].ok, true);
  const mode = fs.statSync(integrations.statePath(ctx)).mode & 0o777;
  assert.strictEqual(mode, 0o600);
});

test('the delivery log is bounded to 50 entries (newest first)', async function () {
  const ctx = makeCtx();
  const doFetch = fetchRecorder({ ok: true, status: 200 });
  for (let i = 0; i < 55; i++) {
    await integrations.post(ctx, { url: 'https://example.com/x', event: 'e' + i, payload: {} }, { fetch: doFetch });
  }
  const log = integrations.history(ctx);
  assert.strictEqual(log.length, 50);
  assert.strictEqual(log[0].event, 'e54'); // newest first
});

test('a corrupt delivery log neither throws nor is clobbered by post', async function () {
  const ctx = makeCtx();
  fs.writeFileSync(integrations.statePath(ctx), '{ not json');
  const doFetch = fetchRecorder({ ok: true, status: 200 });
  const r = await integrations.post(
    ctx,
    { url: 'https://example.com/x', event: 'note', payload: {} },
    { fetch: doFetch },
  );
  assert.strictEqual(r.ok, true); // delivery still succeeds
  assert.deepStrictEqual(integrations.history(ctx), []); // unreadable -> empty, not thrown
  assert.strictEqual(fs.readFileSync(integrations.statePath(ctx), 'utf8'), '{ not json'); // not clobbered
});

// ---- statusMessage ----
test('statusMessage summarizes the active account, count, and headroom (non-secret)', function () {
  const ctx = makeCtx();
  addAccount(ctx, 'alice@example.com', 'u-a', 'LIVE-A');
  addAccount(ctx, 'bob@example.com', 'u-b', 'LIVE-B'); // bob now active
  // Seed the usage cache the way usage.js writes it.
  fs.writeFileSync(
    _path.join(ctx.configDir, '.usage-cache.json'),
    JSON.stringify({
      bob: { at: Date.now(), status: 'ok', usage: { fiveHour: { pct: 30 }, sevenDay: { pct: 10 } } },
    }),
  );
  const s = integrations.statusMessage(ctx);
  assert.strictEqual(s.active, 'bob@example.com');
  assert.strictEqual(s.activeName, 'bob');
  assert.strictEqual(s.accounts, 2);
  assert.strictEqual(s.headroomPct, 70); // 100 - max(30,10)
  assert.match(s.usage, /5h 30%/);
  assert.strictEqual(s.at, ctx.now());
  // No secret material leaks into the summary.
  assert.strictEqual(JSON.stringify(s).indexOf('LIVE-'), -1);
});

test('statusMessage is safe with no accounts / no usage cache', function () {
  const ctx = makeCtx();
  const s = integrations.statusMessage(ctx);
  assert.strictEqual(s.active, null);
  assert.strictEqual(s.accounts, 0);
  assert.strictEqual(s.headroomPct, null);
  assert.strictEqual(s.usage, null);
});

// ---- CLI ----
test('cli --to ... --status posts the current status', async function () {
  const ctx = makeCtx();
  addAccount(ctx, 'alice@example.com', 'u-a', 'LIVE-A');
  const doFetch = fetchRecorder({ ok: true, status: 200 });
  const r = await integrations.cli(ctx, ['--to', 'https://hooks.slack.com/x', '--status'], { fetch: doFetch });
  assert.strictEqual(r.ok, true);
  assert.match(r.text, /posted status to slack/);
  const body = JSON.parse(doFetch.calls[0].init.body);
  assert.ok(Array.isArray(body.blocks));
});

test('cli --message posts a note', async function () {
  const ctx = makeCtx();
  const doFetch = fetchRecorder({ ok: true, status: 200 });
  const r = await integrations.cli(ctx, ['--to', 'https://example.com/x', '--message', 'hello team'], {
    fetch: doFetch,
  });
  assert.strictEqual(r.ok, true);
  const body = JSON.parse(doFetch.calls[0].init.body);
  assert.strictEqual(body.event, 'note');
  assert.deepStrictEqual(body.payload, { message: 'hello team' });
});

test('cli without --to returns a usage error and posts nothing', async function () {
  const ctx = makeCtx();
  const doFetch = fetchRecorder();
  const r = await integrations.cli(ctx, ['--status'], { fetch: doFetch });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /usage: keyflip post/);
  assert.strictEqual(doFetch.calls.length, 0);
});

// ---- MCP tool ----
test('keyflip_post_status requires confirm and posts via ctx.fetch', async function () {
  const ctx = makeCtx();
  addAccount(ctx, 'alice@example.com', 'u-a', 'LIVE-A');
  const tool = integrations.mcpTools.find(function (t) {
    return t.name === 'keyflip_post_status';
  });
  assert.ok(tool);
  assert.strictEqual(tool.annotations.readOnlyHint, false);
  assert.ok(tool.inputSchema.required.indexOf('confirm') !== -1);
  // No confirm -> refuses, no network.
  const doFetch = fetchRecorder({ ok: true, status: 200 });
  ctx.fetch = doFetch;
  await assert.rejects(function () {
    return tool.run(ctx, { url: 'https://hooks.slack.com/x' });
  }, /confirmation required/);
  assert.strictEqual(doFetch.calls.length, 0);
  // With confirm -> posts.
  const out = await tool.run(ctx, { url: 'https://hooks.slack.com/x', confirm: true });
  assert.strictEqual(out.posted.platform, 'slack');
  assert.strictEqual(out.status.active, 'alice@example.com');
  assert.strictEqual(doFetch.calls.length, 1);
});

test('keyflip_post_status rejects a bad webhook url', async function () {
  const ctx = makeCtx();
  const tool = integrations.mcpTools.find(function (t) {
    return t.name === 'keyflip_post_status';
  });
  await assert.rejects(function () {
    return tool.run(ctx, { url: 'file:///etc/passwd', confirm: true });
  }, /valid http\(s\) webhook/);
});
