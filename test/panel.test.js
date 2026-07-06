'use strict';
// Tests for G1: the local web panel (src/panel.js). buildState is pure; serve is exercised
// over real loopback HTTP.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const panel = require('../src/panel');
const profiles = require('../src/profiles');
const memory = require('../src/memory');
const { makeCtx, writeClaude } = require('./helpers');

function get(url) {
  return new Promise(function (resolve, reject) {
    http.get(url, function (res) { let b = ''; res.on('data', function (d) { b += d; }); res.on('end', function () { resolve({ status: res.statusCode, body: b, type: res.headers['content-type'], headers: res.headers }); }); }).on('error', reject);
  });
}

test('buildState aggregates accounts (+cached quota), providers, sessions, keepsakes', function () {
  const ctx = makeCtx();
  writeClaude(ctx, { oauthAccount: { emailAddress: 'alice@x.com' }, userID: 'u1' });
  profiles.write(ctx.configDir, { name: 'alice', email: 'alice@x.com', oauthAccount: {}, savedAt: ctx.now() });
  fs.writeFileSync(path.join(ctx.configDir, '.usage-cache.json'), JSON.stringify({ alice: { at: 9e15, usage: { fiveHour: { pct: 40 }, sevenDay: { pct: 12 } } } }));
  memory.save(ctx, 'sess-1', 'a keepsake', { session: 'sess-1' });

  const s = panel.buildState(ctx);
  assert.strictEqual(s.accounts.length, 1);
  assert.strictEqual(s.accounts[0].email, 'alice@x.com');
  assert.strictEqual(s.accounts[0].fiveHourPct, 40, 'quota pulled from the cache (no network)');
  assert.strictEqual(s.keepsakes.length, 1);
  assert.ok(Array.isArray(s.providers) && Array.isArray(s.sessions));
});

test('G5: buildState attaches a per-account 5h trend from the usage history', function () {
  const ctx = makeCtx();
  profiles.write(ctx.configDir, { name: 'alice', email: 'a@x.com', oauthAccount: {}, savedAt: ctx.now() });
  const lines = [10, 25, 40, 55].map(function (p) { return JSON.stringify({ at: ctx.now(), account: 'alice', status: 'ok', fiveHour: p, sevenDay: 5 }); });
  fs.writeFileSync(path.join(ctx.configDir, 'usage-history.jsonl'), lines.join('\n') + '\n');
  const s = panel.buildState(ctx);
  const a = s.accounts.filter(function (x) { return x.name === 'alice'; })[0];
  assert.deepStrictEqual(a.trend, [10, 25, 40, 55], 'chronological 5h samples');
});

test('buildState never throws on an empty/broken config dir', function () {
  const ctx = makeCtx();
  const s = panel.buildState(ctx);
  assert.deepStrictEqual(s.accounts, []);
  assert.deepStrictEqual(s.keepsakes, []);
});

test('serve responds with HTML on / and JSON on /api/state (loopback)', async function () {
  const ctx = makeCtx();
  profiles.write(ctx.configDir, { name: 'work', email: 'w@x.com', oauthAccount: {}, savedAt: ctx.now() });
  const h = await panel.serve(ctx, { port: 0 });
  try {
    const page = await get(h.url + '/');
    assert.strictEqual(page.status, 200);
    assert.ok(/text\/html/.test(page.type));
    assert.ok(page.body.indexOf('keyflip panel') !== -1);
    const api = await get(h.url + '/api/state');
    assert.strictEqual(api.status, 200);
    const state = JSON.parse(api.body);
    assert.ok(state.accounts.some(function (a) { return a.email === 'w@x.com'; }));
    const nf = await get(h.url + '/nope');
    assert.strictEqual(nf.status, 404);
  } finally { h.server.close(); }
});

// ---- G5: session-activity calendar heatmap ----
test('G5: buildActivity buckets sessions per UTC day, Sunday-aligned, window-scoped total', function () {
  const ctx = makeCtx();
  ctx.now = function () { return '2026-07-07T12:00:00.000Z'; }; // a Tuesday
  const rows = [
    { mtime: '2026-07-07T09:00:00Z' }, { mtime: '2026-07-07T23:00:00Z' }, // 2 today
    { mtime: '2026-06-30T10:00:00Z' },                                      // 1 last week
    { mtime: '2019-01-01T00:00:00Z' },                                      // outside the 26-week window
    { mtime: 'not-a-date' }, { },                                           // ignored
  ];
  const a = panel.buildActivity(ctx, rows);
  assert.strictEqual(a.weeks, 26);
  assert.strictEqual(a.max, 2);
  assert.strictEqual(a.total, 3, 'total counts only sessions inside the shown window (2019 excluded)');
  assert.strictEqual(a.days[a.days.length - 1].date, '2026-07-07', 'last cell is today');
  assert.strictEqual(a.days[a.days.length - 1].count, 2);
  assert.strictEqual(a.days[0].date.slice(0, 4) <= '2026', true);
  // first day is a Sunday (UTC)
  assert.strictEqual(new Date(a.days[0].date + 'T00:00:00Z').getUTCDay(), 0, 'grid starts on a Sunday');
  const jun30 = a.days.filter(function (d) { return d.date === '2026-06-30'; })[0];
  assert.ok(jun30 && jun30.count === 1);
});

test('G5: buildActivity on empty input yields a zeroed grid, never throws', function () {
  const ctx = makeCtx();
  ctx.now = function () { return '2026-07-07T12:00:00.000Z'; };
  const a = panel.buildActivity(ctx, []);
  assert.strictEqual(a.total, 0);
  assert.strictEqual(a.max, 0);
  assert.ok(a.days.length >= 26 * 7, 'a full grid of empty days');
  assert.ok(a.days.every(function (d) { return d.count === 0; }));
});

// ---- G5: memory constellation ----
test('G5: buildMemoryGraph links keepsakes that share >=2 top terms', function () {
  const ctx = makeCtx();
  memory.save(ctx, 'aaaa1111', 'oauth token refresh retry backoff oauth token', { session: 'aaaa1111' });
  memory.save(ctx, 'bbbb2222', 'oauth token rotation retry retry logic token', { session: 'bbbb2222' });
  memory.save(ctx, 'cccc3333', 'css grid dashboard layout responsive design', { session: 'cccc3333' });
  const g = panel.buildMemoryGraph(ctx);
  assert.strictEqual(g.nodes.length, 3);
  // the two oauth keepsakes share oauth/token/retry -> an edge; the css one is isolated
  const keyed = g.nodes.map(function (n) { return n.key; });
  const ai = keyed.indexOf('aaaa1111'), bi = keyed.indexOf('bbbb2222'), ci = keyed.indexOf('cccc3333');
  const linked = function (x, y) { return g.edges.some(function (e) { return (e.a === x && e.b === y) || (e.a === y && e.b === x); }); };
  assert.ok(linked(ai, bi), 'oauth keepsakes are linked');
  assert.ok(!linked(ai, ci) && !linked(bi, ci), 'the css keepsake is isolated');
  assert.ok(g.nodes[ai < bi ? ai : bi].terms.length >= 2, 'nodes carry their top terms');
});

test('G5: buildState exposes activity + memoryGraph; renderPage renders both', function () {
  const ctx = makeCtx();
  memory.save(ctx, 'k1', 'oauth token refresh', {});
  const s = panel.buildState(ctx);
  assert.ok(s.activity && Array.isArray(s.activity.days));
  assert.ok(s.memoryGraph && Array.isArray(s.memoryGraph.nodes));
  const html = panel.renderPage();
  assert.ok(html.indexOf('Session activity') !== -1 && html.indexOf('Memory constellation') !== -1);
  assert.ok(html.indexOf('function calendar') !== -1 && html.indexOf('function memgraph') !== -1);
});

test('G5: serve ignores query strings and sends no-store HTML (never a stale panel)', async function () {
  const ctx = makeCtx();
  const h = await panel.serve(ctx, { port: 0 });
  try {
    const page = await get(h.url + '/?cachebust=123'); // a query string must still route to the page
    assert.strictEqual(page.status, 200);
    assert.ok(/text\/html/.test(page.type));
    assert.ok(/no-store/.test(page.headers['cache-control'] || ''), 'HTML is served no-store');
    const api = await get(h.url + '/api/state?x=1');
    assert.strictEqual(api.status, 200);
    JSON.parse(api.body);
  } finally { h.server.close(); }
});

test('G5: SVG self-closed tags in the client script keep a space before "/>" (regression: unquoted attr + /> broke self-close)', function () {
  const html = panel.renderPage();
  // the exact bug: `stroke-width="+n+"/>"` parses the value as "2/" and nests the lines.
  assert.strictEqual(html.indexOf('e.weight)+"/>"'), -1, 'line must not self-close without a leading space');
  assert.ok(html.indexOf('e.weight)+" />"') !== -1, 'line self-closes as " />"');
  assert.strictEqual(html.indexOf('height=11/>'), -1, 'legend rects must not self-close without a leading space');
  assert.ok(html.indexOf('height=11 />') !== -1, 'legend rects self-close as " />"');
});

// ---- G8: share-safe static snapshot ----
test('G8: buildSnapshot excludes all private content (sessions, keepsakes, memory graph)', function () {
  const ctx = makeCtx();
  writeClaude(ctx, { oauthAccount: { emailAddress: 'alice@x.com' }, userID: 'u1' });
  profiles.write(ctx.configDir, { name: 'work', email: 'alice@x.com', oauthAccount: {}, savedAt: ctx.now(), active: true });
  fs.writeFileSync(path.join(ctx.configDir, '.usage-cache.json'), JSON.stringify({ work: { at: 9e15, usage: { fiveHour: { pct: 55 } } } }));
  memory.save(ctx, 'secret-topic', 'confidential oauth token stuff', {});
  const snap = panel.buildSnapshot(ctx, {});
  assert.ok(snap.accounts.length >= 1);
  assert.strictEqual(snap.accounts[0].label, 'alice@x.com');
  assert.strictEqual(snap.accounts[0].fiveHourPct, 55);
  assert.ok('activity' in snap && 'providers' in snap);
  // the private fields must not exist on the snapshot at all
  assert.strictEqual(snap.sessions, undefined);
  assert.strictEqual(snap.keepsakes, undefined);
  assert.strictEqual(snap.memoryGraph, undefined);
});

test('G8: renderSnapshot is a static, self-contained page with no script/fetch and no private content', function () {
  const ctx = makeCtx();
  profiles.write(ctx.configDir, { name: 'work', email: 'alice@x.com', oauthAccount: {}, savedAt: ctx.now(), active: true });
  fs.writeFileSync(path.join(ctx.configDir, '.usage-cache.json'), JSON.stringify({ work: { at: 9e15, usage: { fiveHour: { pct: 55 } } } }));
  memory.save(ctx, 'k', 'confidential-keepsake-term', {});
  const html = panel.renderSnapshot(panel.buildSnapshot(ctx, {}));
  assert.ok(/^<!doctype html>/i.test(html));
  assert.strictEqual(html.indexOf('<script'), -1, 'no client script in a shared snapshot');
  assert.strictEqual(html.indexOf('/api/state'), -1, 'no network fetch');
  assert.strictEqual(html.indexOf('confidential-keepsake-term'), -1, 'keepsake content never leaks');
  assert.ok(html.indexOf('Accounts') !== -1 && html.indexOf('5h 55%') !== -1 && html.indexOf('shared snapshot') !== -1);
});

test('G8: --anon masks emails and account/provider names', function () {
  const ctx = makeCtx();
  profiles.write(ctx.configDir, { name: 'work', email: 'alice@bigcorp.com', oauthAccount: {}, savedAt: ctx.now(), active: true });
  const snap = panel.buildSnapshot(ctx, { anon: true });
  assert.strictEqual(snap.anon, true);
  assert.strictEqual(snap.activeEmail, null, 'active email hidden when anonymized');
  assert.ok(snap.accounts[0].label.indexOf('alice@bigcorp.com') === -1, 'full email masked');
  const html = panel.renderSnapshot(snap);
  assert.strictEqual(html.indexOf('alice@bigcorp.com'), -1);
  assert.ok(html.indexOf('anonymized') !== -1);
});
