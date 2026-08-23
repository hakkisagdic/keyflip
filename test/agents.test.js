// J1: carry OTHER agents' home-level memory (markdown) across machines. These tests cover
// existence-gating, the union merge, path-traversal refusal, memory-only filtering, and the
// migrate bundle wiring behind the opt-in --agents flag.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { makeCtx } from './helpers.js';
import * as agents from '../src/agents.js';
import * as migrate from '../src/migrate.js';

// migrate.buildBundle also scans transcripts (ctx.claudeDir/projects) — give it a real dir.
function ctxM(overrides) {
  const ctx = makeCtx(overrides);
  ctx.claudeDir = path.join(ctx.home, '.claude');
  fs.mkdirSync(path.join(ctx.claudeDir, 'projects'), { recursive: true });
  return ctx;
}

function seedCursor(ctx, body) {
  const dir = path.join(ctx.home, '.cursor', 'rules');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'style.mdc'), body || '# be terse');
}
function seedGemini(ctx, body) {
  const dir = path.join(ctx.home, '.gemini');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'GEMINI.md'), body || '# gemini rules');
}
function seedCodex(ctx) {
  const dir = path.join(ctx.home, '.codex', 'memories');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(ctx.home, '.codex', 'AGENTS.md'), '# agents');
  fs.writeFileSync(path.join(dir, 'note.md'), '# a memory');
}

test('collect: nothing present → empty (existence-gated)', function () {
  const ctx = makeCtx();
  assert.deepStrictEqual(agents.collectAgentMemory(ctx), []);
  assert.deepStrictEqual(agents.presentAgents(ctx), []);
});

test('collect: finds cursor rules, gemini file, codex dir+file', function () {
  const ctx = makeCtx();
  seedCursor(ctx); seedGemini(ctx); seedCodex(ctx);
  const got = agents.collectAgentMemory(ctx);
  const byAgent = got.reduce(function (m, x) { (m[x.agent] = m[x.agent] || []).push(x.rel); return m; }, {});
  assert.ok(byAgent.cursor.some(function (r) { return r.indexOf('style.mdc') !== -1; }));
  assert.ok(byAgent.gemini.some(function (r) { return r.indexOf('GEMINI.md') !== -1; }));
  assert.strictEqual(byAgent.codex.length, 2); // AGENTS.md + memories/note.md
  assert.deepStrictEqual(agents.presentAgents(ctx).sort(), ['codex', 'cursor', 'gemini']);
});

test('collect: --only filters to one agent', function () {
  const ctx = makeCtx();
  seedCursor(ctx); seedGemini(ctx);
  const got = agents.collectAgentMemory(ctx, { only: ['gemini'] });
  assert.ok(got.length >= 1);
  assert.ok(got.every(function (x) { return x.agent === 'gemini'; }));
});

test('collect: ignores non-memory files (e.g. secrets/config)', function () {
  const ctx = makeCtx();
  const dir = path.join(ctx.home, '.gemini');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'GEMINI.md'), '# rules');
  fs.writeFileSync(path.join(dir, 'oauth_creds.json'), '{"token":"sk-secret"}');
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
  const got = agents.collectAgentMemory(ctx);
  assert.ok(got.length >= 1);
  assert.ok(got.every(function (x) { return x.rel.indexOf('oauth') === -1 && x.rel.indexOf('settings.json') === -1; }));
});

test('merge: union — keeps existing, adds new', function () {
  const src = makeCtx(); seedGemini(src, '# source rules');
  const list = agents.collectAgentMemory(src);
  const dst = makeCtx();
  // pre-existing gemini file must NOT be clobbered without force
  const g = path.join(dst.home, '.gemini'); fs.mkdirSync(g, { recursive: true });
  fs.writeFileSync(path.join(g, 'GEMINI.md'), '# local rules');
  const r = agents.mergeAgentMemory(dst, list);
  assert.strictEqual(r.kept, 1);
  assert.strictEqual(r.added, 0);
  assert.strictEqual(fs.readFileSync(path.join(g, 'GEMINI.md'), 'utf8'), '# local rules');
});

test('merge: force overwrites', function () {
  const src = makeCtx(); seedGemini(src, '# source rules');
  const list = agents.collectAgentMemory(src);
  const dst = makeCtx();
  const g = path.join(dst.home, '.gemini'); fs.mkdirSync(g, { recursive: true });
  fs.writeFileSync(path.join(g, 'GEMINI.md'), '# local rules');
  const r = agents.mergeAgentMemory(dst, list, { force: true });
  assert.strictEqual(r.overwritten, 1);
  assert.strictEqual(fs.readFileSync(path.join(g, 'GEMINI.md'), 'utf8'), '# source rules');
});

test('merge: adds fresh files into new machine', function () {
  const src = makeCtx(); seedCursor(src); seedCodex(src);
  const list = agents.collectAgentMemory(src);
  const dst = makeCtx();
  const r = agents.mergeAgentMemory(dst, list);
  assert.ok(r.added >= 3);
  assert.ok(fs.existsSync(path.join(dst.home, '.cursor', 'rules', 'style.mdc')));
  assert.ok(fs.existsSync(path.join(dst.home, '.codex', 'AGENTS.md')));
});

test('merge: refuses path traversal outside home', function () {
  const dst = makeCtx();
  const r = agents.mergeAgentMemory(dst, [
    { agent: 'evil', rel: '../../etc/passwd.md', content: 'x' },
    { agent: 'evil', rel: '../escape.md', content: 'x' },
  ]);
  assert.strictEqual(r.added, 0);
  assert.strictEqual(r.skipped, 2);
  assert.ok(!fs.existsSync(path.join(path.dirname(dst.home), 'escape.md')));
});

test('merge: refuses to write non-memory-shaped paths', function () {
  const dst = makeCtx();
  const r = agents.mergeAgentMemory(dst, [{ agent: 'x', rel: '.gemini/oauth_creds.json', content: '{}' }]);
  assert.strictEqual(r.skipped, 1);
  assert.ok(!fs.existsSync(path.join(dst.home, '.gemini', 'oauth_creds.json')));
});

test('bundle: --agents off by default (no agents field content)', function () {
  const ctx = ctxM(); seedCursor(ctx);
  const built = migrate.buildBundle(ctx, {});
  assert.deepStrictEqual(built.bundle.agents, []);
  assert.strictEqual(built.counts.agents, 0);
});

test('bundle: --agents opts in; applyBundle merges on target', function () {
  const src = ctxM(); seedCursor(src, '# terse please'); seedGemini(src);
  const built = migrate.buildBundle(src, { agents: true, noAccounts: true, noSessions: true, noProviders: true, noMemory: true, noConfig: true });
  assert.ok(built.counts.agents >= 2);
  const dst = ctxM();
  const res = migrate.applyBundle(dst, built.bundle, {});
  assert.ok(res.agents.added >= 2);
  assert.ok(fs.existsSync(path.join(dst.home, '.cursor', 'rules', 'style.mdc')));
  assert.strictEqual(fs.readFileSync(path.join(dst.home, '.cursor', 'rules', 'style.mdc'), 'utf8'), '# terse please');
});

test('bundle: agentIds narrows which agents travel', function () {
  const src = ctxM(); seedCursor(src); seedGemini(src);
  const built = migrate.buildBundle(src, { agents: true, agentIds: ['gemini'], noAccounts: true, noSessions: true, noProviders: true, noMemory: true, noConfig: true });
  assert.ok(built.bundle.agents.every(function (x) { return x.agent === 'gemini'; }));
});

// SECURITY (review P1 #7): mergeAgentMemory must not follow a pre-planted symlink out of $HOME.
import os from 'os';
test('mergeAgentMemory refuses a symlinked leaf (no clobber through a symlink, even with force)', function () {
  const dst = makeCtx();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-ag-'));
  const victim = path.join(outside, 'victim.mdc');
  fs.writeFileSync(victim, 'ORIGINAL');
  fs.mkdirSync(path.join(dst.home, '.cursor', 'rules'), { recursive: true });
  fs.symlinkSync(victim, path.join(dst.home, '.cursor', 'rules', 'style.mdc'), 'file');
  const r = agents.mergeAgentMemory(dst, [{ agent: 'cursor', rel: '.cursor/rules/style.mdc', content: 'PWNED' }], { force: true });
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'ORIGINAL');
  assert.ok(r.skipped >= 1);
});

// ---- J1 config-tier (redacted agent config) ----
import * as secretscan from '../src/secretscan.js';
function seedCursorMcp(ctx, body) {
  const dir = path.join(ctx.home, '.cursor'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mcp.json'), body);
}
test('collectAgentConfig carries config REDACTED (secrets stripped, structure kept)', function () {
  const ctx = makeCtx();
  seedCursorMcp(ctx, JSON.stringify({ mcpServers: { r: { command: 'node', env: { ANTHROPIC_API_KEY: 'sk-ant-api03-SECRET1234567890abcdefgh', ANTHROPIC_MODEL: 'opus' } } } }));
  const got = agents.collectAgentConfig(ctx);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].agent, 'cursor');
  assert.ok(got[0].redactions >= 1, 'reported the redaction');
  assert.strictEqual(secretscan.scanText(got[0].content).length, 0, 'no secret survives');
  assert.ok(got[0].content.indexOf('sk-ant-api03-SECRET') === -1, 'raw key gone');
  assert.ok(got[0].content.indexOf('opus') !== -1, 'non-secret setting kept');
});

test('collectAgentConfig existence-gated + --only filter', function () {
  const ctx = makeCtx();
  assert.deepStrictEqual(agents.collectAgentConfig(ctx), []);
  seedCursorMcp(ctx, '{"a":1}');
  assert.deepStrictEqual(agents.presentAgentConfig(ctx), ['cursor']);
  assert.strictEqual(agents.collectAgentConfig(ctx, { only: ['gemini'] }).length, 0);
});

test('mergeAgentConfig re-redacts incoming, refuses unknown paths, unions', function () {
  const dst = makeCtx();
  // a HOSTILE bundle: an unknown path + a config that still contains a secret (must be re-redacted)
  const r = agents.mergeAgentConfig(dst, [
    { agent: 'evil', rel: '../../etc/evil.json', content: '{"x":1}' },
    { agent: 'cursor', rel: '.cursor/mcp.json', content: JSON.stringify({ env: { API_KEY: 'sk-ant-api03-STILLSECRET1234567890abcd' } }) },
  ]);
  assert.strictEqual(r.skipped, 1, 'unknown path refused');
  assert.strictEqual(r.added, 1);
  const landed = fs.readFileSync(path.join(dst.home, '.cursor', 'mcp.json'), 'utf8');
  assert.strictEqual(secretscan.scanText(landed).length, 0, 'incoming secret re-redacted on write');
  assert.ok(!fs.existsSync(path.join(path.dirname(dst.home), 'etc', 'evil.json')));
});

test('bundle: --agent-config opts in; applyBundle merges redacted config on target', function () {
  const src = ctxM();
  seedCursorMcp(src, JSON.stringify({ mcpServers: { r: { env: { OPENAI_API_KEY: 'sk-proj-SECRET1234567890abcdefgh' } } } }));
  const built = migrate.buildBundle(src, { agentConfig: true, noAccounts: true, noSessions: true, noProviders: true, noMemory: true, noConfig: true });
  assert.ok(built.counts.agentConfig >= 1);
  // the secret must already be gone from the BUNDLE itself
  assert.ok(JSON.stringify(built.bundle.agentConfig).indexOf('sk-proj-SECRET') === -1);
  const dst = ctxM();
  const res = migrate.applyBundle(dst, built.bundle, {});
  assert.ok(res.agentConfig.added >= 1);
  const landed = fs.readFileSync(path.join(dst.home, '.cursor', 'mcp.json'), 'utf8');
  assert.strictEqual(secretscan.scanText(landed).length, 0);
});

test('collectAgentConfig({redact:false}) carries the REAL keys (opt-in), tagged redacted:false', function () {
  const ctx = makeCtx();
  seedCursorMcp(ctx, JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant-api03-REALKEY1234567890abcdefgh' } }));
  const got = agents.collectAgentConfig(ctx, { redact: false });
  assert.strictEqual(got[0].redacted, false);
  assert.ok(got[0].redactions >= 1, 'still reports how many secrets it is carrying');
  assert.ok(got[0].content.indexOf('sk-ant-api03-REALKEY') !== -1, 'the real key is carried');
});

test('mergeAgentConfig honors an intentional secret-carry (redacted:false) but re-redacts the default', function () {
  const dst1 = makeCtx();
  agents.mergeAgentConfig(dst1, [{ agent: 'cursor', rel: '.cursor/mcp.json', redacted: false, content: JSON.stringify({ env: { API_KEY: 'sk-ant-api03-KEEPME1234567890abcdefg' } }) }]);
  assert.ok(fs.readFileSync(path.join(dst1.home, '.cursor', 'mcp.json'), 'utf8').indexOf('sk-ant-api03-KEEPME') !== -1, 'opted-in secret written as-is');

  const dst2 = makeCtx();
  agents.mergeAgentConfig(dst2, [{ agent: 'cursor', rel: '.cursor/mcp.json', redacted: true, content: JSON.stringify({ env: { API_KEY: 'sk-ant-api03-STRIPME1234567890abcd' } }) }]);
  assert.strictEqual(secretscan.scanText(fs.readFileSync(path.join(dst2.home, '.cursor', 'mcp.json'), 'utf8')).length, 0, 'default entry re-redacted');
});

test('bundle: --agent-config-secrets carries real keys; default redacts', function () {
  const src = ctxM();
  seedCursorMcp(src, JSON.stringify({ env: { OPENAI_API_KEY: 'sk-proj-REALSECRET1234567890abcd' } }));
  const withKeys = migrate.buildBundle(src, { agentConfig: true, agentConfigSecrets: true, noAccounts: true, noSessions: true, noProviders: true, noMemory: true, noConfig: true });
  assert.ok(JSON.stringify(withKeys.bundle.agentConfig).indexOf('sk-proj-REALSECRET') !== -1, 'opt-in carries the key');
  const redacted = migrate.buildBundle(src, { agentConfig: true, noAccounts: true, noSessions: true, noProviders: true, noMemory: true, noConfig: true });
  assert.ok(JSON.stringify(redacted.bundle.agentConfig).indexOf('sk-proj-REALSECRET') === -1, 'default redacts');
});

test('config-tier: Copilot config (JSON) is collected + redacted', function () {
  const ctx = makeCtx();
  const dir = path.join(ctx.home, '.copilot'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ github: { token: 'ghp_SECRET1234567890abcdefghij' }, model: 'gpt-4o' }));
  assert.ok(agents.presentAgentConfig(ctx).indexOf('copilot') !== -1);
  const got = agents.collectAgentConfig(ctx, { only: ['copilot'] });
  assert.ok(got.length >= 1 && got[0].redactions >= 1);
  assert.strictEqual(secretscan.scanText(got[0].content).length, 0);
  assert.ok(got[0].content.indexOf('gpt-4o') !== -1);
});

test('config-tier: opencode (JSON) + aider (YAML) config are detected + redacted', function () {
  const ctx = makeCtx();
  fs.mkdirSync(path.join(ctx.home, '.config', 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(ctx.home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ apiKey: 'sk-ant-api03-SECRET1234567890abcd', model: 'x' }));
  fs.writeFileSync(path.join(ctx.home, '.aider.conf.yml'), 'openai-api-key: sk-proj-SECRET1234567890abcd\nmodel: gpt-4o\n');
  const present = agents.presentAgentConfig(ctx);
  assert.ok(present.indexOf('opencode') !== -1 && present.indexOf('aider') !== -1);
  const cfg = agents.collectAgentConfig(ctx, { only: ['opencode', 'aider'] });
  cfg.forEach(function (c) { assert.strictEqual(secretscan.scanText(c.content).length, 0, c.agent + ' redacted'); });
});
