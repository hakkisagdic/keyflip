'use strict';
// Tests for the PROJECT-CONTEXT store (src/projctx.js). Happy paths + hostile secret-leakage:
// a secret placed in ANY text field (project/context/decision/task) or an .env value MUST NOT
// reach the stored files or the packed package. Fully hermetic — injected clock + runner, no
// network / subprocess / real git. Run: KEYFLIP_VCS=off node --test test/projctx.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ctxstore = require('../src/projctx');

function tmpProject() { return fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-projctx-')); }
const CLOCK = '2026-07-12T00:00:00.000Z';
const OPTS = { now: function () { return CLOCK; }, run: function () { return { code: 1, stdout: '', stderr: '' }; } };

// A handful of real-shaped secrets used across the leakage tests.
const SECRETS = {
  anthropic: 'sk-ant-' + 'A'.repeat(48),
  github: 'ghp_' + 'b'.repeat(36),
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij',
  aws: 'AKIA' + 'C'.repeat(16),
};
function assertNoSecrets(blob) {
  const s = String(blob);
  Object.keys(SECRETS).forEach(function (k) {
    assert.ok(s.indexOf(SECRETS[k]) === -1, 'secret ' + k + ' leaked into output');
  });
}

test('init creates .keyflip with all four files and is null-safe/read-safe', function () {
  const pp = tmpProject();
  assert.strictEqual(ctxstore.exists(pp), false);
  // read on a bare dir must not throw
  const empty = ctxstore.read(pp, OPTS);
  assert.strictEqual(empty.project, null);
  assert.deepStrictEqual(empty.decisions, []);
  assert.deepStrictEqual(empty.tasks, []);
  assert.strictEqual(empty.context, '');

  const c = ctxstore.init(pp, OPTS);
  assert.strictEqual(ctxstore.exists(pp), true);
  assert.ok(fs.existsSync(path.join(pp, '.keyflip', 'project.json')));
  assert.ok(fs.existsSync(path.join(pp, '.keyflip', 'context.md')));
  assert.ok(fs.existsSync(path.join(pp, '.keyflip', 'decisions.json')));
  assert.ok(fs.existsSync(path.join(pp, '.keyflip', 'tasks.json')));
  assert.strictEqual(c.project.schemaVersion, ctxstore.SCHEMA_VERSION);
  assert.strictEqual(c.project.name, path.basename(pp));
  assert.ok(c.project.projectId);
  assert.strictEqual(c.project.updatedAt, CLOCK);
  // injected runner reported "not a repo" -> no repositories
  assert.deepStrictEqual(c.project.repositories, []);
});

test('init is idempotent — does not clobber existing state', function () {
  const pp = tmpProject();
  ctxstore.init(pp, OPTS);
  ctxstore.patchProject(pp, { name: 'MyApp', stack: ['node', 'sqlite'] }, OPTS);
  const id = ctxstore.read(pp, OPTS).project.projectId;
  ctxstore.addTask(pp, { id: 't1', title: 'first' }, OPTS);

  ctxstore.init(pp, OPTS); // second init must be a no-op on content
  const c = ctxstore.read(pp, OPTS);
  assert.strictEqual(c.project.name, 'MyApp');
  assert.deepStrictEqual(c.project.stack, ['node', 'sqlite']);
  assert.strictEqual(c.project.projectId, id);
  assert.strictEqual(c.tasks.length, 1);
});

test('detectRepo uses the injected runner (no real git)', function () {
  const pp = tmpProject();
  const runOK = function (cmd, args) {
    assert.strictEqual(cmd, 'git');
    assert.ok(args.indexOf('rev-parse') !== -1);
    return { code: 0, stdout: 'feature/x\n', stderr: '' };
  };
  const c = ctxstore.init(pp, { now: OPTS.now, run: runOK });
  assert.deepStrictEqual(c.project.repositories, [{ path: '.', branch: 'feature/x' }]);
});

test('setProject / patchProject round-trip and preserve projectId + injected updatedAt', function () {
  const pp = tmpProject();
  ctxstore.init(pp, OPTS);
  const id = ctxstore.read(pp, OPTS).project.projectId;

  ctxstore.setProject(pp, {
    name: 'Zirve', description: 'billing service', stack: ['go', 'postgres'],
    repositories: [{ path: '.', branch: 'main' }], lastProvider: 'anthropic',
  }, OPTS);
  const p = ctxstore.read(pp, OPTS).project;
  assert.strictEqual(p.name, 'Zirve');
  assert.strictEqual(p.description, 'billing service');
  assert.deepStrictEqual(p.stack, ['go', 'postgres']);
  assert.deepStrictEqual(p.repositories, [{ path: '.', branch: 'main' }]);
  assert.strictEqual(p.lastProvider, 'anthropic');
  assert.strictEqual(p.projectId, id, 'projectId preserved when not supplied');

  ctxstore.patchProject(pp, { description: 'billing + invoicing' }, OPTS);
  const p2 = ctxstore.read(pp, OPTS).project;
  assert.strictEqual(p2.description, 'billing + invoicing');
  assert.strictEqual(p2.name, 'Zirve', 'patch leaves untouched fields');
  assert.strictEqual(p2.projectId, id);
});

test('setContextMd stores freeform text', function () {
  const pp = tmpProject();
  ctxstore.init(pp, OPTS);
  ctxstore.setContextMd(pp, '## Architecture\nA monolith with a worker.', OPTS);
  assert.strictEqual(ctxstore.read(pp, OPTS).context, '## Architecture\nA monolith with a worker.');
});

test('decisions: add / update / remove', function () {
  const pp = tmpProject();
  ctxstore.init(pp, OPTS);
  const d = ctxstore.addDecision(pp, {
    id: 'd1', title: 'Use Postgres', rationale: 'ACID + team familiarity',
    alternatives: ['MySQL', 'Mongo'], doNot: ['do not use SQLite in prod'],
  }, OPTS);
  assert.strictEqual(d.status, 'decided');
  assert.strictEqual(d.at, CLOCK);

  const u = ctxstore.updateDecision(pp, 'd1', { status: 'superseded' }, OPTS);
  assert.strictEqual(u.status, 'superseded');
  assert.strictEqual(u.title, 'Use Postgres', 'unpatched fields kept');
  assert.strictEqual(ctxstore.updateDecision(pp, 'nope', { status: 'rejected' }, OPTS), null);

  assert.strictEqual(ctxstore.removeDecision(pp, 'd1', OPTS), true);
  assert.strictEqual(ctxstore.removeDecision(pp, 'd1', OPTS), false);
  assert.strictEqual(ctxstore.read(pp, OPTS).decisions.length, 0);
});

test('decisions reject an invalid status', function () {
  const pp = tmpProject();
  ctxstore.init(pp, OPTS);
  assert.throws(function () { ctxstore.addDecision(pp, { title: 'x', status: 'maybe' }, OPTS); }, /invalid decision status/);
});

test('tasks: add / update status / remove / setActiveTask', function () {
  const pp = tmpProject();
  ctxstore.init(pp, OPTS);
  ctxstore.addTask(pp, { id: 't1', title: 'wire CLI', remainingSteps: ['a', 'b'] }, OPTS);
  ctxstore.addTask(pp, { id: 't2', title: 'wire MCP' }, OPTS);
  assert.strictEqual(ctxstore.read(pp, OPTS).tasks[0].status, 'todo');

  ctxstore.updateTask(pp, 't1', { status: 'in_progress', completedSteps: ['a'] }, OPTS);
  const t = ctxstore.read(pp, OPTS).tasks.filter(function (x) { return x.id === 't1'; })[0];
  assert.strictEqual(t.status, 'in_progress');
  assert.deepStrictEqual(t.completedSteps, ['a']);

  assert.throws(function () { ctxstore.updateTask(pp, 't1', { status: 'wat' }, OPTS); }, /invalid task status/);

  ctxstore.setActiveTask(pp, 't1', OPTS);
  assert.strictEqual(ctxstore.read(pp, OPTS).activeTaskId, 't1');
  assert.throws(function () { ctxstore.setActiveTask(pp, 'ghost', OPTS); }, /no such task/);

  // removing the active task clears the pointer
  ctxstore.removeTask(pp, 't1', OPTS);
  const after = ctxstore.read(pp, OPTS);
  assert.strictEqual(after.tasks.length, 1);
  assert.strictEqual(after.activeTaskId, null);

  ctxstore.setActiveTask(pp, null, OPTS); // clear is a no-op-safe
  assert.strictEqual(ctxstore.read(pp, OPTS).activeTaskId, null);
});

test('pack assembles all four sections + env var NAMES', function () {
  const pp = tmpProject();
  ctxstore.init(pp, OPTS);
  ctxstore.patchProject(pp, { name: 'App', stack: ['node'] }, OPTS);
  ctxstore.setContextMd(pp, 'summary', OPTS);
  ctxstore.addDecision(pp, { id: 'd1', title: 'A', rationale: 'r' }, OPTS);
  ctxstore.addTask(pp, { id: 't1', title: 'T' }, OPTS);
  fs.writeFileSync(path.join(pp, '.env'), [
    '# Postgres connection', 'DATABASE_URL=postgres://u:p@h/db',
    'PORT=8080',
  ].join('\n'));

  const pkg = ctxstore.pack(pp, OPTS);
  assert.strictEqual(pkg.schemaVersion, ctxstore.SCHEMA_VERSION);
  assert.strictEqual(pkg.generatedAt, CLOCK);
  assert.strictEqual(pkg.project.name, 'App');
  assert.strictEqual(pkg.context, 'summary');
  assert.strictEqual(pkg.decisions.length, 1);
  assert.strictEqual(pkg.tasks.length, 1);
  const names = pkg.requiredEnvironmentVariables.map(function (e) { return e.name; });
  assert.deepStrictEqual(names, ['DATABASE_URL', 'PORT']);
  const dbvar = pkg.requiredEnvironmentVariables.filter(function (e) { return e.name === 'DATABASE_URL'; })[0];
  assert.strictEqual(dbvar.description, 'Postgres connection');
});

test('SECURITY: a secret in ANY text field never reaches storage or the package', function () {
  const pp = tmpProject();
  ctxstore.init(pp, OPTS);
  ctxstore.setProject(pp, { name: 'App', description: 'prod key ' + SECRETS.anthropic }, OPTS);
  ctxstore.setContextMd(pp, 'deploy with token ' + SECRETS.github + ' — do not commit', OPTS);
  ctxstore.addDecision(pp, {
    id: 'd1', title: 'Auth', rationale: 'signed with ' + SECRETS.jwt,
    doNot: ['never paste ' + SECRETS.aws],
  }, OPTS);
  ctxstore.addTask(pp, { id: 't1', title: 'deploy', knownIssues: ['leftover key ' + SECRETS.anthropic] }, OPTS);

  // (a) the stored files on disk carry no secret
  ['project.json', 'context.md', 'decisions.json', 'tasks.json'].forEach(function (f) {
    assertNoSecrets(fs.readFileSync(path.join(pp, '.keyflip', f), 'utf8'));
  });
  // (b) the assembled read carries no secret
  assertNoSecrets(JSON.stringify(ctxstore.read(pp, OPTS)));
  // (c) the package carries no secret
  const pkg = ctxstore.pack(pp, OPTS);
  assertNoSecrets(JSON.stringify(pkg));
  // and the redaction marker is present where a secret was
  assert.ok(JSON.stringify(pkg).indexOf('keyflip_redacted') !== -1, 'expected a redaction marker');
});

test('SECURITY: .env VALUES never enter the package — only names + isSecret', function () {
  const pp = tmpProject();
  ctxstore.init(pp, OPTS);
  fs.writeFileSync(path.join(pp, '.env'), [
    '# Anthropic key for prod',
    'API_KEY=' + SECRETS.anthropic,
    'export AWS_ACCESS_KEY_ID=' + SECRETS.aws,
    'PORT=3000',
  ].join('\n'));
  fs.writeFileSync(path.join(pp, '.env.local'), 'SESSION_TOKEN=' + SECRETS.jwt + '\n');

  const pkg = ctxstore.pack(pp, OPTS);
  assertNoSecrets(JSON.stringify(pkg)); // no value leaked

  const byName = {};
  pkg.requiredEnvironmentVariables.forEach(function (e) { byName[e.name] = e; });
  assert.ok(byName.API_KEY && byName.API_KEY.isSecret === true, 'API_KEY flagged secret');
  assert.strictEqual(byName.API_KEY.description, 'Anthropic key for prod');
  assert.ok(byName.AWS_ACCESS_KEY_ID && byName.AWS_ACCESS_KEY_ID.isSecret === true, 'AWS key by value shape');
  assert.ok(byName.SESSION_TOKEN && byName.SESSION_TOKEN.isSecret === true, 'token by key name');
  assert.ok(byName.PORT && byName.PORT.isSecret === false, 'PORT is not secret');
});

test('summary is a short redacted string', function () {
  const pp = tmpProject();
  ctxstore.init(pp, OPTS);
  ctxstore.patchProject(pp, { name: 'App', description: 'svc ' + SECRETS.github, stack: ['go'] }, OPTS);
  ctxstore.addTask(pp, { id: 't1', title: 'x', status: 'in_progress' }, OPTS);
  ctxstore.addDecision(pp, { id: 'd1', title: 'y' }, OPTS);
  const s = ctxstore.summary(pp, OPTS);
  assert.ok(/Tasks: 1/.test(s));
  assert.ok(/Decisions: 1/.test(s));
  assert.ok(/Stack: go/.test(s));
  assertNoSecrets(s);
});

test('prototype-pollution: a hostile __proto__ key in stored JSON cannot pollute', function () {
  const pp = tmpProject();
  ctxstore.init(pp, OPTS);
  // hand-craft a malicious decisions.json
  fs.writeFileSync(path.join(pp, '.keyflip', 'decisions.json'), JSON.stringify({
    schemaVersion: 1,
    decisions: [{ id: 'd1', title: 'ok', __proto__: { polluted: true } }],
  }));
  const pkg = ctxstore.pack(pp, OPTS);
  assert.strictEqual({}.polluted, undefined, 'Object.prototype must not be polluted');
  assert.strictEqual(pkg.decisions[0].polluted, undefined);
  assert.strictEqual(pkg.decisions[0].title, 'ok');
});

test('files are written 0600 (POSIX)', function (t) {
  if (process.platform === 'win32') return t.skip('POSIX perms only');
  const pp = tmpProject();
  ctxstore.init(pp, OPTS);
  ['project.json', 'decisions.json', 'tasks.json', 'context.md'].forEach(function (f) {
    assert.strictEqual(fs.statSync(path.join(pp, '.keyflip', f)).mode & 0o777, 0o600, f + ' should be 0600');
  });
});
