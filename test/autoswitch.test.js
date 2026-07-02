'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const autosw = require('../src/autoswitch');
const links = require('../src/links');
const core = require('../src/core');
const { makeCtx, writeClaude, tmpdir } = require('./helpers');

function login(ctx, email, uid, tok) {
  writeClaude(ctx, { oauthAccount: { emailAddress: email }, userID: uid });
  ctx.store.setLive(JSON.stringify({ claudeAiOauth: { accessToken: tok } }));
}
function twoAccounts() {
  const ctx = makeCtx();
  login(ctx, 'a@x.com', 'u1', 'TA'); core.addCurrent(ctx);
  login(ctx, 'b@x.com', 'u2', 'TB'); core.addCurrent(ctx); // b active
  return ctx;
}
function usageFetch(pctByToken) {
  return async function (url, opts) {
    const tok = opts.headers.Authorization.replace('Bearer ', '');
    const pct = pctByToken[tok];
    if (pct === undefined) return { ok: false, status: 401 };
    return { ok: true, status: 200, json: async function () { return { five_hour: { utilization: pct } }; } };
  };
}

test('autoswitch tick stays put below the threshold', async function () {
  const ctx = twoAccounts();
  const r = await autosw.tick(ctx, { threshold: 90, fetch: usageFetch({ TB: 50, TA: 10 }), nowMs: 1, cacheTtlMs: 0 });
  assert.strictEqual(r.state, 'below');
  assert.strictEqual(core.currentEmail(ctx), 'b@x.com'); // unchanged
});

test('autoswitch tick switches when the threshold is crossed', async function () {
  const ctx = twoAccounts(); // active b (TB)
  const r = await autosw.tick(ctx, { threshold: 90, fetch: usageFetch({ TB: 95, TA: 10 }), nowMs: 1, cacheTtlMs: 0 });
  assert.strictEqual(r.state, 'switched');
  assert.strictEqual(r.switchedTo.name, 'a');
  assert.strictEqual(core.currentEmail(ctx), 'a@x.com'); // CLI credential swapped
});

test('autoswitch tick reports no-candidate when every alternative is exhausted', async function () {
  const ctx = twoAccounts();
  const r = await autosw.tick(ctx, { threshold: 90, strategy: 'best', fetch: usageFetch({ TB: 99 }), nowMs: 1, cacheTtlMs: 0 });
  // candidate 'a' returns 401 -> unknown -> 'best' finds nothing
  assert.strictEqual(r.state, 'no-candidate');
  assert.strictEqual(core.currentEmail(ctx), 'b@x.com');
});

test('autoswitch tick treats throttled/unknown usage as unknown (never switches blind)', async function () {
  const ctx = twoAccounts();
  const f429 = async function () { return { ok: false, status: 429 }; };
  const r = await autosw.tick(ctx, { threshold: 90, fetch: f429, nowMs: 1, cacheTtlMs: 0 });
  assert.strictEqual(r.state, 'unknown');
});

test('autoswitch does NOT ping-pong when the only alternative is also over threshold', async function () {
  const ctx = twoAccounts(); // active b
  // active b=95 (over), candidate a=92 (also over) -> must stay put, not switch
  const r = await autosw.tick(ctx, { threshold: 90, fetch: usageFetch({ TB: 95, TA: 92 }), nowMs: 1, cacheTtlMs: 0 });
  assert.strictEqual(r.state, 'no-candidate');
  assert.strictEqual(core.currentEmail(ctx), 'b@x.com');
});

test('autoswitch reports no-candidate when the alternative is app-only (no CLI creds)', async function () {
  const ctx = twoAccounts();               // a and b both have CLI creds
  ctx.store.delProfile('a');               // make 'a' app-only (no CLI credential)
  const r = await autosw.tick(ctx, { threshold: 90, fetch: usageFetch({ TB: 99, TA: 5 }), nowMs: 1, cacheTtlMs: 0 });
  assert.strictEqual(r.state, 'no-candidate'); // a is filtered out; no other candidate
  assert.strictEqual(core.currentEmail(ctx), 'b@x.com');
});

// ---- directory links ----
test('link set/lookup resolves through ancestors; remove unlinks', function () {
  const ctx = makeCtx();
  const repo = path.join(tmpdir(), 'repo');
  const deep = path.join(repo, 'src', 'lib');
  fs.mkdirSync(deep, { recursive: true });
  links.set(ctx, repo, 'work');
  assert.strictEqual(links.lookup(ctx, deep).name, 'work');   // ancestor walk
  assert.strictEqual(links.lookup(ctx, repo).name, 'work');
  assert.strictEqual(links.lookup(ctx, tmpdir()), null);
  assert.strictEqual(links.remove(ctx, repo), true);
  assert.strictEqual(links.lookup(ctx, deep), null);
  assert.strictEqual(links.remove(ctx, repo), false);
});

test('run --share-history shares projects/ into the session (opt-in)', function (t) {
  if (process.platform === 'win32') return t.skip('symlink semantics differ on Windows');
  const session = require('../src/session');
  const ctx = makeCtx();
  login(ctx, 'a@x.com', 'u1', 'TA'); core.addCurrent(ctx);
  fs.mkdirSync(path.join(ctx.home, '.claude', 'projects'), { recursive: true });
  const plain = session.prepareSession(ctx, 'a', { share: true });
  assert.ok(!fs.existsSync(path.join(plain, 'projects')), 'projects NOT shared by default');
  const withHist = session.prepareSession(ctx, 'a', { share: true, shareHistory: true });
  assert.ok(fs.lstatSync(path.join(withHist, 'projects')).isSymbolicLink(), 'projects shared with --share-history');
});
