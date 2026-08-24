// Tests for the CodexBar bridge (src/codexbar.js). Fully hermetic: a temp home + injected env, an
// injected provusage/surface registry for align(), and fixtures we write ourselves. Two invariants
// get special attention: unknown/junk config shapes must degrade to [] (never throw), and a secret
// carried in the config must NEVER appear in any output.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import * as codexbar from '../src/codexbar.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-codexbar-'));
}

// ctx with a hermetic home + explicit (empty) env so XDG never leaks from the real process.
function makeCtx(overrides) {
  overrides = overrides || {};
  return {
    home: overrides.home || tmpHome(),
    platform: overrides.platform || 'darwin',
    env: overrides.env || {},
  };
}

// Write CodexBar's config.json into ctx's config dir (default XDG location under home).
function writeConfig(ctx, obj) {
  const cp = codexbar.configPath(ctx);
  fs.mkdirSync(path.dirname(cp), { recursive: true });
  fs.writeFileSync(cp, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  return cp;
}

// A fake registry pair for align() so the assertions don't depend on the real provider set.
const FAKE_DEPS = {
  provusage: { PROVIDERS: [{ id: 'codex' }, { id: 'gemini' }, { id: 'claude' }] },
  surface: { SURFACES: [{ id: 'cursor' }, { id: 'copilot' }, { id: 'codex' }] },
};

// ---- configPath ----
test('configPath defaults to home/.config/codexbar/config.json', function () {
  const ctx = makeCtx();
  assert.strictEqual(codexbar.configPath(ctx), path.join(ctx.home, '.config', 'codexbar', 'config.json'));
});

test('configPath honours XDG_CONFIG_HOME from ctx.env', function () {
  const xdg = tmpHome();
  const ctx = makeCtx({ env: { XDG_CONFIG_HOME: xdg } });
  assert.strictEqual(codexbar.configPath(ctx), path.join(xdg, 'codexbar', 'config.json'));
});

// ---- detect ----
test('detect: absent when no config file exists', function () {
  const ctx = makeCtx();
  const d = codexbar.detect(ctx);
  assert.strictEqual(d.present, false);
  assert.strictEqual(d.configPath, codexbar.configPath(ctx));
});

test('detect: present once the config file exists', function () {
  const ctx = makeCtx();
  writeConfig(ctx, { providers: ['codex'] });
  const d = codexbar.detect(ctx);
  assert.strictEqual(d.present, true);
});

test('detect: hasApp reported only on macOS, omitted elsewhere', function () {
  const mac = codexbar.detect(makeCtx({ platform: 'darwin' }));
  assert.strictEqual(typeof mac.hasApp, 'boolean'); // best-effort bool on darwin
  const linux = codexbar.detect(makeCtx({ platform: 'linux' }));
  assert.ok(!('hasApp' in linux), 'hasApp is macOS-only');
});

// ---- readConfig ----
test('readConfig parses a valid fixture', function () {
  const ctx = makeCtx();
  writeConfig(ctx, { providers: ['codex', 'gemini'], theme: 'dark' });
  const cfg = codexbar.readConfig(ctx);
  assert.deepStrictEqual(cfg.providers, ['codex', 'gemini']);
  assert.strictEqual(cfg.theme, 'dark');
});

test('readConfig returns null when the file is missing', function () {
  assert.strictEqual(codexbar.readConfig(makeCtx()), null);
});

test('readConfig returns null on a corrupt (non-JSON) file — never throws', function () {
  const ctx = makeCtx();
  writeConfig(ctx, '{ this is not json ]]');
  assert.strictEqual(codexbar.readConfig(ctx), null);
});

// ---- trackedProviders ----
test('readConfig scrubs secrets under bare key/value fields AND inside arrays (regression)', function () {
  const ctx = makeCtx();
  const TOK = 'sk-ant-api03-AbCdEf1234567890AbCdEf1234567890wxyz';
  writeConfig(ctx, {
    providers: { openai: { key: TOK }, anthropic: { value: TOK } },
    notes: ['Authorization: Bearer ' + TOK],
  });
  const out = JSON.stringify(codexbar.readConfig(ctx));
  assert.strictEqual(
    out.indexOf(TOK),
    -1,
    'no token may survive under a bare key/value field or inside an array string',
  );
  assert.ok(out.indexOf('openai') !== -1, 'the non-secret provider structure is still there');
});

test('trackedProviders extracts ids from an array-of-strings config', function () {
  const ctx = makeCtx();
  writeConfig(ctx, { providers: ['codex', 'gemini', 'cursor'] });
  assert.deepStrictEqual(codexbar.trackedProviders(ctx), ['codex', 'gemini', 'cursor']);
});

test('trackedProviders extracts ids from array-of-objects, skipping disabled', function () {
  const ctx = makeCtx();
  writeConfig(ctx, { providers: [{ id: 'codex', enabled: true }, { id: 'gemini', enabled: false }, { id: 'cursor' }] });
  assert.deepStrictEqual(codexbar.trackedProviders(ctx), ['codex', 'cursor']);
});

test('trackedProviders extracts ids from an object map, skipping disabled', function () {
  const ctx = makeCtx();
  writeConfig(ctx, { providers: { codex: { enabled: true }, gemini: false, cursor: {} } });
  assert.deepStrictEqual(codexbar.trackedProviders(ctx).sort(), ['codex', 'cursor']);
});

test('trackedProviders returns [] on junk shapes', function () {
  const ctx = makeCtx();
  writeConfig(ctx, { somethingElse: 42, providers: 12345 });
  assert.deepStrictEqual(codexbar.trackedProviders(ctx), []);
});

test('trackedProviders returns [] when config is missing', function () {
  assert.deepStrictEqual(codexbar.trackedProviders(makeCtx()), []);
});

// ---- align ----
test('align computes both / onlyCodexbar / onlyKeyflip against injected registries', function () {
  const ctx = makeCtx();
  writeConfig(ctx, { providers: ['codex', 'gemini', 'chatgpt'] });
  const a = codexbar.align(ctx, FAKE_DEPS);
  assert.deepStrictEqual(a.codexbar, ['codex', 'gemini', 'chatgpt']);
  // keyflip = union of provusage + surface ids (deduped): codex,gemini,claude,cursor,copilot
  assert.deepStrictEqual(a.keyflip, ['codex', 'gemini', 'claude', 'cursor', 'copilot']);
  assert.deepStrictEqual(a.both, ['codex', 'gemini']);
  assert.deepStrictEqual(a.onlyCodexbar, ['chatgpt']);
  assert.deepStrictEqual(a.onlyKeyflip.sort(), ['claude', 'copilot', 'cursor']);
});

test('align with no CodexBar config -> everything is onlyKeyflip', function () {
  const a = codexbar.align(makeCtx(), FAKE_DEPS);
  assert.deepStrictEqual(a.codexbar, []);
  assert.deepStrictEqual(a.both, []);
  assert.deepStrictEqual(a.onlyCodexbar, []);
  assert.deepStrictEqual(a.onlyKeyflip, ['codex', 'gemini', 'claude', 'cursor', 'copilot']);
});

test('align works against the REAL provusage/surface registries (no deps injected)', function () {
  const ctx = makeCtx();
  writeConfig(ctx, { providers: ['codex'] });
  const a = codexbar.align(ctx);
  assert.ok(Array.isArray(a.keyflip) && a.keyflip.length > 0);
  assert.ok(a.both.indexOf('codex') !== -1, 'codex is known to both');
});

// ---- SECRET SAFETY (the load-bearing invariant) ----
test('a fake api key in the config is NOT surfaced in any output', function () {
  const ctx = makeCtx();
  const SECRET = 'sk-fake-DEADBEEF-should-never-appear';
  writeConfig(ctx, {
    apiKey: SECRET,
    providers: [{ id: 'codex', token: SECRET, api_key: SECRET }, { id: 'gemini' }],
    auth: { bearer: SECRET },
    credentials: { openai: SECRET },
  });

  const cfg = codexbar.readConfig(ctx);
  const tracked = codexbar.trackedProviders(ctx);
  const aligned = codexbar.align(ctx, FAKE_DEPS);
  const blob = JSON.stringify([cfg, tracked, aligned]);

  assert.strictEqual(blob.indexOf(SECRET), -1, 'secret value must never appear in any output');
  // ...but the non-secret provider ids still come through.
  assert.deepStrictEqual(tracked, ['codex', 'gemini']);
  // secret-shaped keys are stripped from the returned config
  assert.ok(!('apiKey' in cfg));
  assert.ok(!('auth' in cfg));
  assert.ok(!('credentials' in cfg));
});
