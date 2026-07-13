'use strict';
// Context-Layer: normalize AI rule/instruction files into one model and re-emit per tool
// (src/rulesmodel.js). Covers happy path (detect/import/classify/emit/round-trip + .keyflip cache)
// and HOSTILE input — a leaked secret in ANY source must never reach the model or an emitted file.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rules = require('../src/rulesmodel');
const secretscan = require('../src/secretscan');

function tmpProject() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kf-rules-')); }
function write(base, rel, content) {
  const abs = path.join(base, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
const NOW = function () { return '2026-07-12T00:00:00.000Z'; };

// Real-shaped tokens used to prove redaction. None of these may appear in any output.
const SECRETS = {
  anthropic: 'sk-ant-api03-' + 'A'.repeat(40),
  github: 'ghp_' + 'b'.repeat(36),
  aws: 'AKIA' + 'C'.repeat(16),
  google: 'AIza' + 'D'.repeat(35),
};

test('detectRuleFiles: reports every tool that has a rule file present, and nothing on an empty repo', function () {
  const base = tmpProject();
  assert.deepStrictEqual(rules.detectRuleFiles(base), [], 'empty project -> no tools');
  write(base, 'CLAUDE.md', '# Rules\nBe careful.');
  write(base, '.cursorrules', 'follow the style guide');
  write(base, '.cursor/rules/style.mdc', '# Formatting\nuse prettier');
  write(base, 'AGENTS.md', '# Agents\nrun tests');
  write(base, 'GEMINI.md', '# Gemini\nbe concise');
  write(base, '.github/copilot-instructions.md', '# Copilot\nno secrets');
  const detected = rules.detectRuleFiles(base);
  const tools = detected.map(function (d) { return d.tool; }).sort();
  assert.deepStrictEqual(tools, ['agents', 'claude', 'copilot', 'cursor', 'gemini']);
  const cursor = detected.filter(function (d) { return d.tool === 'cursor'; })[0];
  assert.ok(cursor.files.indexOf('.cursorrules') !== -1 && cursor.files.indexOf(path.join('.cursor', 'rules', 'style.mdc')) !== -1, 'both the flat file and the split rule dir are found');
  assert.ok(cursor.label && typeof cursor.label === 'string', 'tool carries a human label (reused from agents.REGISTRY)');
});

test('importRules: builds the common model with provenance and per-file redaction counts', function () {
  const base = tmpProject();
  write(base, 'CLAUDE.md', '# Coding\nUse prettier and eslint; naming is camelCase.\n\n# Security\nNever commit a secret or api key.');
  write(base, 'AGENTS.md', '# Architecture\nThe module layout has a data model layer and component boundaries.');
  const model = rules.importRules(base, { now: NOW });
  assert.strictEqual(model.schemaVersion, rules.SCHEMA_VERSION);
  assert.strictEqual(model.generatedAt, '2026-07-12T00:00:00.000Z', 'time is injected via opts.now');
  assert.ok(model.sections.length >= 3);
  // provenance preserved
  assert.ok(model.sections.every(function (s) { return s.from === 'claude' || s.from === 'agents'; }));
  const kindsFrom = function (tool, heading) { return model.sections.filter(function (s) { return s.from === tool && s.heading === heading; })[0]; };
  assert.strictEqual(kindsFrom('claude', 'Coding').kind, 'coding');
  assert.strictEqual(kindsFrom('claude', 'Security').kind, 'security');
  assert.strictEqual(kindsFrom('agents', 'Architecture').kind, 'architecture');
});

test('classify: heuristic maps headings/bodies to the right kind, general as fallback', function () {
  assert.strictEqual(rules.classify('rotate the oauth token, never leak a credential', 'Security'), 'security');
  assert.strictEqual(rules.classify('run eslint and prettier; keep naming consistent', 'Code Style'), 'coding');
  assert.strictEqual(rules.classify('the service is split into a data model and component layers', 'Architecture'), 'architecture');
  assert.strictEqual(rules.classify('squash commits, open a pull request, wait for code review', 'Git Workflow'), 'workflow');
  assert.strictEqual(rules.classify('please be nice and helpful', 'Notes'), 'general');
});

test('splitSections: splits on ATX headings, keeps a preamble, drops empty input', function () {
  const secs = rules.splitSections('intro line\n\n# One\nbody one\n## Two\nbody two');
  assert.deepStrictEqual(secs.map(function (s) { return s.heading; }), [null, 'One', 'Two']);
  assert.strictEqual(secs[0].body, 'intro line');
  assert.deepStrictEqual(rules.splitSections(''), []);
  assert.deepStrictEqual(rules.splitSections('   \n\n'), []);
});

test('emit: renders each target with its title and groups sections by kind', function () {
  const base = tmpProject();
  write(base, 'CLAUDE.md', '# Coding\nUse eslint.\n# Security\nNo secrets in code.');
  const model = rules.importRules(base, { now: NOW });
  ['claude', 'cursor', 'agents', 'gemini', 'generic'].forEach(function (target) {
    const content = rules.emit(model, target);
    assert.ok(content.indexOf(rules.EMIT_TARGETS[target].forTool) !== -1, target + ' names its tool');
    assert.ok(content.indexOf('## Coding & Style') !== -1 && content.indexOf('## Security') !== -1, target + ' groups by kind');
    assert.ok(content.indexOf('Use eslint.') !== -1, target + ' carries the section text');
    assert.ok(content.indexOf('source: claude') !== -1, target + ' keeps provenance');
  });
  assert.throws(function () { rules.emit(model, 'nope'); }, /unknown emit target/);
});

test('round-trip: import CLAUDE.md -> emit agents preserves the substance', function () {
  const base = tmpProject();
  write(base, 'CLAUDE.md', '# Workflow\nOpen a pull request for every change.\n# Coding\nPrefer small functions and run prettier.');
  const model = rules.importRules(base, { now: NOW });
  const agentsMd = rules.emit(model, 'agents');
  assert.ok(agentsMd.indexOf('Open a pull request for every change.') !== -1);
  assert.ok(agentsMd.indexOf('run prettier') !== -1);
  assert.ok(agentsMd.indexOf('## Workflow & Process') !== -1 && agentsMd.indexOf('## Coding & Style') !== -1);
});

test('HOSTILE: a leaked secret in ANY source never reaches the model or an emitted file', function () {
  const base = tmpProject();
  write(base, 'CLAUDE.md', '# Setup\nUse the key ' + SECRETS.anthropic + ' and token ' + SECRETS.github + '.');
  write(base, '.cursorrules', 'aws=' + SECRETS.aws + '\napi_key: ' + SECRETS.google);
  write(base, 'AGENTS.md', '# Env\nRead the key from ${ANTHROPIC_API_KEY} — never inline it.');
  const model = rules.importRules(base, { now: NOW });
  const modelBlob = JSON.stringify(model);
  Object.keys(SECRETS).forEach(function (k) {
    assert.strictEqual(modelBlob.indexOf(SECRETS[k]), -1, 'raw ' + k + ' secret must NOT be in the model');
  });
  assert.ok(modelBlob.indexOf(secretscan.REDACTED) !== -1, 'secrets are replaced with the redaction marker');
  assert.ok(modelBlob.indexOf('${ANTHROPIC_API_KEY}') !== -1, 'env-var references are preserved (not a secret)');
  // every emit target must also be clean
  ['claude', 'cursor', 'agents', 'gemini', 'generic'].forEach(function (target) {
    const content = rules.emit(model, target);
    Object.keys(SECRETS).forEach(function (k) {
      assert.strictEqual(content.indexOf(SECRETS[k]), -1, 'emit(' + target + ') leaked ' + k);
    });
  });
  // secretscan agrees there are no token shapes left anywhere
  assert.deepStrictEqual(secretscan.scanText(rules.emit(model, 'claude')), []);
});

test('redactText: token shapes and credential-keyed lines redacted; env refs/placeholders kept', function () {
  const r = rules.redactText('token=' + SECRETS.github + '\npassword: hunter2plaintext\napi_key: ${MY_KEY}\nnote: a normal line\nraw ' + SECRETS.aws);
  assert.strictEqual(r.text.indexOf(SECRETS.github), -1, 'token shape redacted');
  assert.strictEqual(r.text.indexOf(SECRETS.aws), -1, 'raw secret in prose redacted');
  assert.strictEqual(r.text.indexOf('hunter2plaintext'), -1, 'credential-keyed line redacted even without a token shape');
  assert.ok(r.text.indexOf('${MY_KEY}') !== -1, 'env ref survives');
  assert.ok(r.text.indexOf('a normal line') !== -1, 'ordinary prose untouched');
  assert.ok(r.count >= 3, 'counted github token + aws key + password line');
});

test('.keyflip cache: saveModel/loadModel round-trips atomically at 0600 under the project', function () {
  const base = tmpProject();
  write(base, 'GEMINI.md', '# Rules\nbe concise');
  const model = rules.importRules(base, { now: NOW });
  const dest = rules.saveModel(base, model);
  assert.strictEqual(dest, path.join(base, '.keyflip', 'rules.json'));
  assert.ok(fs.existsSync(dest), 'cache file written under .keyflip/');
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(dest).mode & 0o777, 0o600, 'cache is 0600');
  }
  const loaded = rules.loadModel(base);
  assert.deepStrictEqual(loaded, model, 'model round-trips through the cache');
  // a corrupt cache yields null rather than throwing
  fs.writeFileSync(dest, 'not json {');
  assert.strictEqual(rules.loadModel(base), null);
  assert.strictEqual(rules.loadModel(tmpProject()), null, 'absent cache -> null');
});

test('writeTarget: writes the target file inside the project and refuses to escape', function () {
  const base = tmpProject();
  write(base, 'CLAUDE.md', '# Coding\nuse eslint');
  const model = rules.importRules(base, { now: NOW });
  const res = rules.writeTarget(base, 'agents', rules.emit(model, 'agents'));
  assert.strictEqual(res.path, path.join(base, 'AGENTS.md'));
  assert.ok(fs.readFileSync(res.path, 'utf8').indexOf('use eslint') !== -1);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(res.path).mode & 0o777, 0o600);
  // a pre-planted symlink for a target filename must NOT be followed out of the project
  const outside = path.join(tmpProject(), 'stolen.md');
  try {
    fs.symlinkSync(outside, path.join(base, 'GEMINI.md'));
    assert.throws(function () { rules.writeTarget(base, 'gemini', 'x'); }, /refusing to write outside/);
    assert.ok(!fs.existsSync(outside), 'symlink target was never written through');
  } catch (e) { if (e.code !== 'EPERM' && e.code !== 'EACCES' && !/refusing/.test(e.message)) throw e; }
  assert.throws(function () { rules.writeTarget(base, 'bogus', 'x'); }, /unknown emit target/);
});

test('assertModel: rejects malformed models', function () {
  assert.throws(function () { rules.assertModel(null); }, /not an object/);
  assert.throws(function () { rules.assertModel({}); }, /sections must be an array/);
  assert.throws(function () { rules.assertModel({ sections: [{ from: 'x' }] }); }, /no text string/);
  assert.ok(rules.assertModel({ sections: [{ kind: 'general', text: 'ok', from: 'claude' }] }));
});
