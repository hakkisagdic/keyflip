'use strict';
// Wave 4 (Context Layer): handoff.js — target-aware CONTINUE-PROMPT generator. Covers the happy path
// (tool trail, active task, locked decisions, per-target phrasing, files list), the pure/deterministic
// contract, and the SECURITY invariant: a secret that leaked into the package must NEVER reach the
// emitted prompt (defence-in-depth re-redaction).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const handoff = require('../src/handoff');
const secretscan = require('../src/secretscan');

const NOW = function () { return '2026-07-12T10:00:00.000Z'; };

function samplePkg() {
  return {
    schema: 1,
    project: { name: 'Zirve', providers: ['kiro', 'cursor'], lastProvider: 'claude', description: 'A billing service.' },
    decisions: [
      { title: 'Postgres over Mongo', decision: 'Use PostgreSQL as the primary store', rationale: 'relational invoices' },
      { title: 'No ORM', decision: 'Hand-written SQL only' },
    ],
    tasks: [
      { status: 'done', title: 'scaffold' },
      { status: 'in_progress', title: 'invoice export', completed: ['schema done'], remaining: ['CSV writer', 'PDF writer'], knownIssues: ['timezone off-by-one'] },
    ],
    env: [{ name: 'DATABASE_URL', description: 'Postgres DSN' }, 'STRIPE_API_KEY'],
    generatedAt: '2026-07-01T00:00:00.000Z',
  };
}

test('continuePrompt: happy path — trail, active task, decisions, files, target voice', function () {
  const md = handoff.continuePrompt(samplePkg(), { target: 'claude', checkpoint: { provider: 'claude', branch: 'feat/export', at: '2026-07-11T09:00:00Z' }, now: NOW });
  assert.ok(md.startsWith('# Continue this project — Zirve'), 'titled with project name');
  assert.ok(md.indexOf('Kiro → Cursor → Claude Code') !== -1, 'tool trail rendered with labels');
  assert.ok(md.indexOf('**You are now:** Claude Code') !== -1, 'target label');
  assert.ok(md.indexOf('### invoice export') !== -1, 'active (in_progress) task chosen, not the done one');
  assert.ok(md.indexOf('scaffold') === -1, 'the completed task is not surfaced as active');
  assert.ok(md.indexOf('- [x] schema done') !== -1, 'completed items as checked boxes');
  assert.ok(md.indexOf('- [ ] CSV writer') !== -1 && md.indexOf('- [ ] PDF writer') !== -1, 'remaining as unchecked boxes');
  assert.ok(md.indexOf('timezone off-by-one') !== -1, 'known issues surfaced');
  assert.ok(md.indexOf('**Postgres over Mongo**') !== -1 && md.indexOf('why: relational invoices') !== -1, 'decision + rationale');
  assert.ok(md.indexOf('do NOT change these without explaining') !== -1, 'decisions are marked immutable');
  assert.ok(md.indexOf('`.keyflip/context.md`') !== -1 && md.indexOf('`.keyflip/checkpoints/latest.json`') !== -1, 'canonical files listed');
  assert.ok(md.indexOf('CLAUDE.md') !== -1, 'claude rules hint');
  assert.ok(md.indexOf('You are Claude Code.') !== -1, 'target-specific closing');
  assert.ok(md.indexOf('branch `feat/export`') !== -1, 'checkpoint git branch shown');
  assert.ok(md.indexOf('DATABASE_URL') !== -1, 'env var NAME carried');
  assert.ok(md.trim().endsWith('_'), 'ends with the generated-by footer');
});

test('continuePrompt: is PURE + deterministic (same input -> same output, no now() -> stable stamp)', function () {
  const a = handoff.continuePrompt(samplePkg(), { target: 'cursor' });
  const b = handoff.continuePrompt(samplePkg(), { target: 'cursor' });
  assert.strictEqual(a, b, 'deterministic without an injected clock (uses pkg.generatedAt)');
  assert.ok(a.indexOf('2026-07-01') !== -1, 'falls back to pkg.generatedAt for the stamp');
});

test('targetVariants: per-tool phrasing, alias + unknown handling', function () {
  assert.strictEqual(handoff.targetVariants('cursor').label, 'Cursor');
  assert.strictEqual(handoff.targetVariants('claude-code').label, 'Claude Code', 'alias maps to claude');
  assert.strictEqual(handoff.targetVariants('kiro').id, 'kiro');
  assert.strictEqual(handoff.targetVariants('windsurf').label, 'Windsurf');
  assert.strictEqual(handoff.targetVariants('nonsense').id, 'generic', 'unknown -> generic');
  assert.ok(/opencode/.test(handoff.continuePrompt({}, { target: 'opencode' })), 'opencode voice');
  assert.ok(handoff.targetVariants('kiro').closing.indexOf('steering') !== -1, 'kiro closing mentions steering');
});

test('targetVariants: returned object is frozen (shared table cannot be mutated)', function () {
  const v = handoff.targetVariants('claude');
  assert.throws(function () { 'use strict'; v.label = 'hacked'; }, TypeError);
  assert.strictEqual(handoff.targetVariants('claude').label, 'Claude Code', 'table intact');
});

test('providerTrail: dedups + orders, current appended last', function () {
  const t = handoff.providerTrail({ providers: ['kiro', 'cursor'] }, { provider: 'claude', history: ['kiro'] });
  assert.deepStrictEqual(t.trail, ['kiro', 'cursor', 'claude']);
  assert.strictEqual(t.last, 'claude');
});

test('continuePrompt: no active task + no decisions -> graceful guidance, no crash', function () {
  const md = handoff.continuePrompt({ project: { name: 'Empty' } }, { target: 'generic' });
  assert.ok(md.indexOf('No active task recorded') !== -1);
  assert.ok(md.indexOf('No locked decisions recorded') !== -1);
  assert.ok(md.indexOf('do NOT restart the project') !== -1, 'generic closing');
});

test('continuePrompt: tolerates null pkg / null opts', function () {
  const md = handoff.continuePrompt(null, null);
  assert.ok(md.indexOf('Continue this project') !== -1);
  assert.ok(md.indexOf('your AI tool') !== -1, 'defaults to the generic target');
});

// ---- SECURITY: a leaked secret must never reach the emitted prompt ------------------------------
test('SECURITY: secrets that slipped into the package are redacted out of the prompt', function () {
  const LEAKS = {
    anthropic: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    github: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    aws: 'AKIAIOSFODNN7EXAMPLE',
    google: 'AIzaSyD-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456',
  };
  const pkg = {
    project: { name: 'Proj ' + LEAKS.anthropic, description: 'db pass leaked: ' + LEAKS.aws },
    summary: 'context with a token ' + LEAKS.github + ' inline',
    decisions: [{ title: 'auth', decision: 'store token ' + LEAKS.google, rationale: 'because ' + LEAKS.anthropic }],
    tasks: [{ status: 'active', title: 'task ' + LEAKS.github, completed: ['did ' + LEAKS.aws], remaining: ['do ' + LEAKS.google], knownIssues: ['key ' + LEAKS.anthropic] }],
    env: [{ name: 'X', description: 'value is ' + LEAKS.github }],
  };
  const md = handoff.continuePrompt(pkg, { target: 'claude', now: NOW });
  Object.keys(LEAKS).forEach(function (k) {
    assert.strictEqual(md.indexOf(LEAKS[k]), -1, 'secret (' + k + ') must not appear in the prompt');
  });
  // the scanner confirms nothing secret-shaped survives anywhere in the output
  assert.deepStrictEqual(secretscan.scanText(md), [], 'no secret shape anywhere in the emitted prompt');
  assert.ok(md.indexOf(secretscan.REDACTED) !== -1, 'redaction placeholder used in place of the tokens');
});

test('SECURITY: env carries NAMES only — never a value, even if a value field is present', function () {
  const md = handoff.continuePrompt({ env: [{ name: 'STRIPE_SECRET', value: 'sk_live_ABCDEFGHIJKLMNOP', description: 'billing' }] }, {});
  assert.ok(md.indexOf('STRIPE_SECRET') !== -1, 'name kept');
  assert.strictEqual(md.indexOf('sk_live_ABCDEFGHIJKLMNOP'), -1, 'value never emitted');
});

test('redactText: injectable scanner, never throws on non-strings', function () {
  assert.strictEqual(handoff.redactText(null, secretscan), '');
  assert.strictEqual(handoff.redactText(12345, secretscan), '12345');
  assert.ok(handoff.redactText('token sk-ant-api03-XXXXXXXXXXXXXXXXXXXX end', secretscan).indexOf('sk-ant') === -1);
});

// ---- prototype-pollution safety ----------------------------------------------------------------
test('prototype-pollution safe: __proto__ target/provider never resolves via the prototype', function () {
  assert.strictEqual(handoff.normalizeTarget('__proto__'), 'generic');
  assert.strictEqual(handoff.targetVariants('constructor').id, 'generic');
  // a hostile provider id in the trail is redacted/escaped, never a live label lookup
  const md = handoff.continuePrompt({ providers: ['__proto__'], lastProvider: 'cursor' }, {});
  assert.ok(md.indexOf('Cursor') !== -1);
});

// ---- filesystem read (CLI/MCP entry) -----------------------------------------------------------
function seedProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-handoff-'));
  const base = path.join(root, '.keyflip');
  fs.mkdirSync(path.join(base, 'checkpoints'), { recursive: true });
  fs.mkdirSync(path.join(base, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(base, 'project.json'), JSON.stringify({ name: 'Zirve', providers: ['cursor'], lastProvider: 'claude' }));
  fs.writeFileSync(path.join(base, 'context.md'), '# Zirve\nbilling');
  fs.writeFileSync(path.join(base, 'decisions.json'), JSON.stringify([{ title: 'PG', decision: 'Postgres', rationale: 'relational' }]));
  fs.writeFileSync(path.join(base, 'tasks.json'), JSON.stringify([{ status: 'active', title: 'export', remaining: ['csv'] }]));
  fs.writeFileSync(path.join(base, 'checkpoints', 'latest.json'), JSON.stringify({ provider: 'claude', branch: 'main' }));
  fs.writeFileSync(path.join(base, 'rules', 'style.md'), 'be terse');
  return root;
}

test('readProject + handoff: read .keyflip/ from disk and render for a target', function () {
  const root = seedProject();
  const r = handoff.handoff(root, { to: 'cursor', now: NOW });
  assert.strictEqual(r.target, 'cursor');
  assert.strictEqual(r.project, 'Zirve');
  assert.deepStrictEqual(r.providers, ['cursor', 'claude']);
  assert.ok(r.files.indexOf('.keyflip/context.md') !== -1, 'reports present files');
  assert.ok(r.text.indexOf('### export') !== -1, 'active task from tasks.json');
  assert.ok(r.text.indexOf('**PG**: Postgres') !== -1, 'decision from decisions.json');
  assert.ok(r.text.indexOf('You are Cursor.') !== -1, 'target voice');
});

test('readProject: a half-initialized / missing .keyflip still yields a usable prompt', function () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-empty-'));
  const r = handoff.handoff(root, { to: 'generic' });
  assert.ok(r.text.indexOf('No active task recorded') !== -1);
  assert.deepStrictEqual(r.files, [], 'nothing present');
});

test('readProject: a corrupt JSON file is skipped, not fatal', function () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-corrupt-'));
  const base = path.join(root, '.keyflip');
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'tasks.json'), '{ not valid json');
  fs.writeFileSync(path.join(base, 'project.json'), JSON.stringify({ name: 'X' }));
  const r = handoff.handoff(root, {});
  assert.strictEqual(r.project, 'X');
  assert.ok(r.text.indexOf('No active task recorded') !== -1, 'corrupt tasks.json -> no crash');
});

// ---- MCP tool ----------------------------------------------------------------------------------
test('mcpTools: keyflip_handoff is read-only and returns the prompt text', async function () {
  const tool = handoff.mcpTools[0];
  assert.strictEqual(tool.name, 'keyflip_handoff');
  assert.strictEqual(tool.annotations.readOnlyHint, true);
  assert.strictEqual(tool.annotations.destructiveHint, false);
  assert.deepStrictEqual(tool.inputSchema.properties.to.enum, handoff.TARGETS);
  const root = seedProject();
  const res = await tool.run({ now: NOW }, { to: 'kiro', projectPath: root });
  assert.strictEqual(res.target, 'kiro');
  assert.ok(res.prompt.indexOf('You are Kiro.') !== -1);
  assert.ok(res.prompt.indexOf('### export') !== -1);
});
