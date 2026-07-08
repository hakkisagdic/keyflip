'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const surface = require('../src/surface');
const { makeCtx } = require('./helpers');

function write(ctx, rel, data) {
  const abs = path.join(ctx.home, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  return abs;
}

// ---- registry shape ----
test('SURFACES covers exactly the CONFIG_REGISTRY tools, each with the required shape', function () {
  const ids = surface.SURFACES.map(function (s) { return s.id; }).sort();
  assert.deepStrictEqual(ids, ['aider', 'codex', 'copilot', 'cursor', 'gemini', 'opencode']);
  surface.SURFACES.forEach(function (s) {
    assert.strictEqual(typeof s.id, 'string');
    assert.strictEqual(typeof s.label, 'string');
    assert.ok(['file', 'keychain', 'env'].indexOf(s.kind) !== -1, s.id + ' kind');
    assert.strictEqual(typeof s.detect, 'function');
    assert.strictEqual(typeof s.list, 'function');
    assert.strictEqual(s.switchable, false);
  });
});

// ---- absent (pristine home): everything not detected ----
test('pristine home -> every surface present:false, no active account, not switchable', function () {
  const ctx = makeCtx();
  const all = surface.detectAll(ctx);
  assert.strictEqual(all.length, surface.SURFACES.length);
  all.forEach(function (s) {
    assert.strictEqual(s.present, false, s.id);
    assert.strictEqual(s.activeAccount, null, s.id);
    assert.deepStrictEqual(s.accounts, [], s.id);
    assert.strictEqual(s.switchable, false, s.id);
    assert.strictEqual(s.note, 'not detected', s.id);
  });
});

// ---- gemini happy path: active account read from the NON-SECRET identity file ----
test('gemini: reads active account + old accounts from google_accounts.json', function () {
  const ctx = makeCtx();
  write(ctx, '.gemini/google_accounts.json', JSON.stringify({ active: 'me@gmail.com', old: ['old1@gmail.com', 'old2@gmail.com'] }));
  const s = surface.detectOne(ctx, 'gemini');
  assert.strictEqual(s.present, true);
  assert.strictEqual(s.kind, 'file');
  assert.strictEqual(s.activeAccount, 'me@gmail.com');
  assert.deepStrictEqual(s.accounts, ['me@gmail.com', 'old1@gmail.com', 'old2@gmail.com']);
  assert.strictEqual(s.switchable, false);
  assert.match(s.note, /switch not supported/);
  // surface.list() mirrors detect().accounts
  assert.deepStrictEqual(surface.get('gemini').list(ctx), ['me@gmail.com', 'old1@gmail.com', 'old2@gmail.com']);
  // store reports the SECRET creds path (existence probed, contents never read)
  assert.strictEqual(s.store.kind, 'file');
  assert.strictEqual(s.store.secret, true);
  assert.strictEqual(s.store.location, '~/.gemini/oauth_creds.json');
  assert.strictEqual(s.store.exists, false); // we only wrote the identity file, not the creds file
});

test('gemini: never reads or leaks the secret oauth_creds.json', function () {
  const ctx = makeCtx();
  write(ctx, '.gemini/google_accounts.json', JSON.stringify({ active: 'me@gmail.com', old: [] }));
  write(ctx, '.gemini/oauth_creds.json', JSON.stringify({ access_token: 'SECRET-TOKEN-XYZ', refresh_token: 'SECRET-REFRESH' }));
  const s = surface.detectOne(ctx, 'gemini');
  assert.strictEqual(s.store.exists, true); // now the creds file exists (stat sees it)…
  assert.doesNotMatch(JSON.stringify(s), /SECRET-TOKEN|SECRET-REFRESH/); // …but its contents never appear
});

test('gemini present but identity unreadable -> present, null account, switch-not-supported note', function () {
  const ctx = makeCtx();
  write(ctx, '.gemini/settings.json', '{}'); // installed, but no google_accounts.json
  const s = surface.detectOne(ctx, 'gemini');
  assert.strictEqual(s.present, true);
  assert.strictEqual(s.activeAccount, null);
  assert.match(s.note, /opaque\/secret store|switch not supported/);
});

// ---- gemini hostile inputs: corrupt / wrong-typed / prototype-poisoning must never throw or leak ----
test('gemini: malformed identity JSON is handled safely (no throw, no active account)', function () {
  const ctx = makeCtx();
  write(ctx, '.gemini/google_accounts.json', 'not-json {{{');
  const s = surface.detectOne(ctx, 'gemini');
  assert.strictEqual(s.present, true);
  assert.strictEqual(s.activeAccount, null);
  assert.deepStrictEqual(s.accounts, []);
});

test('gemini: wrong-typed fields are rejected (active must be string, old must be array)', function () {
  const ctx = makeCtx();
  write(ctx, '.gemini/google_accounts.json', JSON.stringify({ active: 123, old: 'nope' }));
  const s = surface.detectOne(ctx, 'gemini');
  assert.strictEqual(s.activeAccount, null);
  assert.deepStrictEqual(s.accounts, []);
});

test('gemini: a __proto__ key in the identity file cannot pollute Object.prototype', function () {
  const ctx = makeCtx();
  write(ctx, '.gemini/google_accounts.json', '{"__proto__":{"polluted":"yes"},"active":"z@z.com","old":["a@a.com"]}');
  const s = surface.detectOne(ctx, 'gemini');
  assert.strictEqual(s.activeAccount, 'z@z.com');
  assert.deepStrictEqual(s.accounts, ['z@z.com', 'a@a.com']);
  assert.strictEqual({}.polluted, undefined);
  assert.strictEqual(Object.prototype.polluted, undefined);
});

// ---- opaque / secret-store surfaces: present but no identity, and secrets never read ----
test('codex: present via secret auth.json -> present, no active account, secret store', function () {
  const ctx = makeCtx();
  write(ctx, '.codex/auth.json', JSON.stringify({ OPENAI_API_KEY: 'sk-SECRET', tokens: { id_token: 'JWT-SECRET' } }));
  const s = surface.detectOne(ctx, 'codex');
  assert.strictEqual(s.present, true);
  assert.strictEqual(s.kind, 'file');
  assert.strictEqual(s.activeAccount, null); // identity is inside a secret file — never read
  assert.strictEqual(s.store.secret, true);
  assert.match(s.note, /switch not supported/);
  assert.doesNotMatch(JSON.stringify(s), /sk-SECRET|JWT-SECRET/);
});

test('cursor: present -> keychain kind, opaque store, no active account', function () {
  const ctx = makeCtx();
  write(ctx, '.cursor/mcp.json', '{}');
  const s = surface.detectOne(ctx, 'cursor');
  assert.strictEqual(s.present, true);
  assert.strictEqual(s.kind, 'keychain');
  assert.strictEqual(s.activeAccount, null);
  assert.strictEqual(s.store.exists, null); // opaque store: existence is unknown/not a single file
});

test('aider: env-kind surface detected from its config file', function () {
  const ctx = makeCtx();
  write(ctx, '.aider.conf.yml', 'model: gpt-4o\n');
  const s = surface.detectOne(ctx, 'aider');
  assert.strictEqual(s.present, true);
  assert.strictEqual(s.kind, 'env');
});

// ---- switch seam ----
test('switch() throws "not supported for <surface>" for a known surface', function () {
  const ctx = makeCtx();
  assert.throws(function () { surface.switch(ctx, 'gemini', 'me@gmail.com'); }, /switch not supported for gemini/);
});

test('switch() throws "unknown surface" for an unregistered id', function () {
  const ctx = makeCtx();
  assert.throws(function () { surface.switch(ctx, 'nope', 'x'); }, /unknown surface/);
});

test('detectOne returns null for an unknown surface id', function () {
  const ctx = makeCtx();
  assert.strictEqual(surface.detectOne(ctx, 'does-not-exist'), null);
  assert.strictEqual(surface.get('does-not-exist'), null);
  // hostile lookup keys must not resolve to inherited props
  assert.strictEqual(surface.get('__proto__'), null);
  assert.strictEqual(surface.get('constructor'), null);
});

// ---- snapshot cache (persist as <configDir>/surfaces.json) ----
test('writeSnapshot persists detection (0600) and readSnapshot round-trips it', function () {
  const ctx = makeCtx();
  write(ctx, '.gemini/google_accounts.json', JSON.stringify({ active: 'me@gmail.com', old: [] }));
  const snap = surface.writeSnapshot(ctx);
  assert.strictEqual(snap.at, '2026-01-01T00:00:00.000Z'); // ctx.now() injected
  assert.ok(Array.isArray(snap.surfaces) && snap.surfaces.length === surface.SURFACES.length);

  const p = surface.snapshotPath(ctx);
  assert.ok(fs.existsSync(p));
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(p).mode & 0o777, 0o600);

  const back = surface.readSnapshot(ctx);
  assert.strictEqual(back.at, snap.at);
  const g = back.surfaces.filter(function (s) { return s.id === 'gemini'; })[0];
  assert.strictEqual(g.activeAccount, 'me@gmail.com');
});

test('readSnapshot returns null when absent, and treats a corrupt cache as absent', function () {
  const ctx = makeCtx();
  assert.strictEqual(surface.readSnapshot(ctx), null); // none yet
  fs.writeFileSync(surface.snapshotPath(ctx), 'not json {{{');
  assert.strictEqual(surface.readSnapshot(ctx), null); // corrupt -> absent, never throws
});

test('detectAll is pure: it never writes the snapshot file', function () {
  const ctx = makeCtx();
  surface.detectAll(ctx);
  assert.strictEqual(fs.existsSync(surface.snapshotPath(ctx)), false);
});

// ---- MCP tool (read-only) ----
test('keyflip_surfaces MCP tool is read-only and returns detection with no secrets', async function () {
  const ctx = makeCtx();
  write(ctx, '.gemini/google_accounts.json', JSON.stringify({ active: 'me@gmail.com', old: [] }));
  write(ctx, '.codex/auth.json', JSON.stringify({ OPENAI_API_KEY: 'sk-SECRET' }));
  const tool = surface.mcpTools[0];
  assert.strictEqual(tool.name, 'keyflip_surfaces');
  assert.strictEqual(tool.annotations.readOnlyHint, true);
  assert.strictEqual(tool.annotations.destructiveHint, false);
  const out = await tool.run(ctx, {});
  assert.ok(Array.isArray(out.surfaces));
  const g = out.surfaces.filter(function (s) { return s.id === 'gemini'; })[0];
  assert.strictEqual(g.activeAccount, 'me@gmail.com');
  assert.doesNotMatch(JSON.stringify(out), /sk-SECRET/);
});
