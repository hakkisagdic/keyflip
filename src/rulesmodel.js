'use strict';
// Context-Layer: NORMALIZE the many AI rule/instruction files (CLAUDE.md, .cursorrules,
// .cursor/rules/*, AGENTS.md, GEMINI.md, .github/copilot-instructions.md, opencode/aider) into
// ONE common model { schemaVersion, sections:[{kind, text, from}] }, then RE-EMIT that model as
// the file content any single tool expects. This is the JS realization of a TS design: plain
// objects + JSDoc-ish notes + runtime shape validation, zero-dependency (Node built-ins only).
//
// Security is central: this layer feeds a SHARED, syncable context, so EVERY imported and emitted
// text field is run through src/secretscan's redaction first — a token/key must never enter the
// model or an emitted file. Only env-VAR NAMES / ${REFS} survive (they point at a secret, they are
// not one). Project state (the cached model) lives in the PROJECT tree under `.keyflip/`, never in
// the global config dir. Pure-ish + injected: pass a projectPath (default process.cwd()) and
// opts.now (ISO clock) so tests need no real time / network / subprocess.
//
// @typedef {Object} RuleSection  { kind, text, from, rel?, heading? }
//   kind ∈ 'coding'|'architecture'|'security'|'workflow'|'general'
// @typedef {Object} RulesModel   { schemaVersion, generatedAt, sources:[{tool,rel,redactions}], sections:RuleSection[] }

const fs = require('fs');
const path = require('path');
const fsutil = require('./fsutil');
const secretscan = require('./secretscan');
const agents = require('./agents'); // reuse the canonical tool-id set + labels (CONFIG_REGISTRY/REGISTRY)

const SCHEMA_VERSION = 1;

// PROJECT-relative rule/instruction files per tool. Existence-gated: a repo without a given tool
// simply yields nothing. A `dirs` entry is walked for matching leaf files (Cursor's split rules).
// The tool ids mirror keyflip's agent registry (src/agents.js) so this stays in lockstep with the
// rest of the tool surface; 'claude'/'agents'/'generic' extend it with the project-level names.
const RULE_SOURCES = [
  { tool: 'claude',   files: ['CLAUDE.md', '.claude/CLAUDE.md'] },
  { tool: 'cursor',   files: ['.cursorrules'], dirs: [{ base: '.cursor/rules', match: /\.(?:mdc|md)$/i }] },
  { tool: 'agents',   files: ['AGENTS.md', '.codex/AGENTS.md'] },
  { tool: 'gemini',   files: ['GEMINI.md', '.gemini/GEMINI.md'] },
  { tool: 'copilot',  files: ['.github/copilot-instructions.md'] },
  { tool: 'opencode', files: ['.opencode/rules.md'] },
  { tool: 'aider',    files: ['CONVENTIONS.md'] },
];

// Emit targets: which single-tool file a model can be rendered back into. Filenames are fixed and
// always land INSIDE the project (guarded on write) — the target string can never pick the path.
const EMIT_TARGETS = Object.create(null);
EMIT_TARGETS.claude  = { filename: 'CLAUDE.md',    title: 'Project Rules', forTool: 'Claude Code' };
EMIT_TARGETS.cursor  = { filename: '.cursorrules', title: 'Project Rules', forTool: 'Cursor' };
EMIT_TARGETS.agents  = { filename: 'AGENTS.md',    title: 'Project Rules', forTool: 'AGENTS.md-compatible agents (Codex, opencode)' };
EMIT_TARGETS.gemini  = { filename: 'GEMINI.md',    title: 'Project Rules', forTool: 'Gemini CLI' };
EMIT_TARGETS.generic = { filename: 'RULES.md',     title: 'Project Rules', forTool: 'any AI assistant' };

// Classification order = tie-break priority: security wins ties (fail safe), then architecture,
// workflow, coding; anything without a signal is 'general'. Heading matches count triple (a
// heading is a strong topic signal). Regexes carry /g and are only used with String.match (which
// ignores lastIndex), so they are safe to share across calls.
const KIND_ORDER = ['general', 'architecture', 'coding', 'security', 'workflow'];
const KIND_LABEL = { general: 'General', architecture: 'Architecture', coding: 'Coding & Style', security: 'Security', workflow: 'Workflow & Process' };
const KIND_RULES = [
  { kind: 'security', re: /\b(?:secret|secrets|password|passwd|credential|credentials|api[ _-]?key|access[ _-]?token|auth|authentication|authorization|oauth|encrypt|encryption|decrypt|sanitiz\w*|injection|xss|csrf|ssrf|vulnerab\w*|exploit|threat|owasp|pii|privacy|redact\w*|leak\w*)\b/gi },
  { kind: 'architecture', re: /\b(?:architect\w*|directory structure|folder structure|module\w*|package structure|layer\w*|design pattern\w*|data model|schema|component\w*|boundary|boundaries|dependency injection|monorepo|microservice\w*|api design|interface\w*)\b/gi },
  { kind: 'workflow', re: /\b(?:workflow\w*|commit\w*|pull request\w*|PRs?|merge|branch\w*|rebase|ci\/cd|pipeline\w*|deploy\w*|release\w*|changelog|code review\w*|semver|versioning)\b/gi },
  { kind: 'coding', re: /\b(?:coding|code style|style guide|lint\w*|eslint|prettier|format\w*|naming|indent\w*|whitespace|semicolon\w*|typescript|docstring\w*|jsdoc|convention\w*|camel[ _-]?case|snake[ _-]?case|kebab[ _-]?case)\b/gi },
];

function toolLabelMap() {
  const m = Object.create(null);
  agents.REGISTRY.forEach(function (a) { m[a.id] = a.label; });
  return m;
}
const AGENT_LABEL = toolLabelMap();
function toolLabel(tool) {
  return AGENT_LABEL[tool] || ({ claude: 'Claude Code', agents: 'AGENTS.md / Codex', generic: 'Generic' })[tool] || String(tool);
}

// ---- redaction (defence in depth over free-form rule text) --------------------------------------
// secretscan.redactConfig handles JSON/`key=value` config; rule files are prose, so we ALSO sweep
// the whole text for known token SHAPES (a raw `sk-ant-…` pasted into a markdown paragraph). Then a
// line-based pass catches credential-KEYED lines (`api_key: …`) even when the value isn't a known
// shape. ${VAR}/$VAR/%VAR% references and placeholders are preserved (they are not secrets).
function redactText(text) {
  let s = String(text == null ? '' : text);
  let count = 0;
  secretscan.SECRET_PATTERNS.forEach(function (p) {
    const re = new RegExp(p.re.source, 'g');
    s = s.replace(re, function () { count++; return secretscan.REDACTED; });
  });
  const lined = secretscan.redactLines(s); // credential-keyed lines whose value isn't a token shape
  return { text: lined.text, count: count + lined.count };
}

// ---- source collection --------------------------------------------------------------------------
function walkRules(dir, matchRe, budget, out) {
  if (budget.left <= 0) return;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (let i = 0; i < ents.length && budget.left > 0; i++) {
    const p = path.join(dir, ents[i].name);
    if (ents[i].isDirectory()) walkRules(p, matchRe, budget, out);
    else if (ents[i].isFile() && matchRe.test(ents[i].name)) { out.push(p); budget.left--; }
  }
}

// Present rule files as [{ tool, rel, abs, text }] (rel relative to base). Directory sources are
// walked and sorted for a stable order.
function collectSources(base, opts) {
  opts = opts || {};
  const out = [];
  const budget = { left: 200 };
  RULE_SOURCES.forEach(function (src) {
    (src.files || []).forEach(function (rel) {
      const abs = path.join(base, rel);
      let text; try { if (!fs.statSync(abs).isFile()) return; text = fs.readFileSync(abs, 'utf8'); } catch (e) { return; }
      out.push({ tool: src.tool, rel: rel, abs: abs, text: text });
    });
    (src.dirs || []).forEach(function (d) {
      const found = [];
      walkRules(path.join(base, d.base), d.match, budget, found);
      found.sort();
      found.forEach(function (abs) {
        let text; try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { return; }
        out.push({ tool: src.tool, rel: path.relative(base, abs), abs: abs, text: text });
      });
    });
  });
  return out;
}

// ---- classification + sectioning ----------------------------------------------------------------
// Classify one chunk into a kind by weighted keyword hits (heading x3). Ties resolve by KIND_RULES
// order (security first). No signal -> 'general'.
function classify(text, heading) {
  const body = String(text || '');
  const head = String(heading || '');
  let best = 'general', bestScore = 0;
  KIND_RULES.forEach(function (r) {
    const b = body.match(r.re); const h = head.match(r.re);
    const score = (b ? b.length : 0) + (h ? h.length * 3 : 0);
    if (score > bestScore) { bestScore = score; best = r.kind; }
  });
  return best;
}

// Split markdown into [{ heading, body }] at ATX headings (`#`..`######`). Content before the first
// heading is a preamble section (heading:null). Empty input -> [].
function splitSections(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const headRe = /^#{1,6}\s+(.+?)\s*$/;
  const sections = [];
  let cur = { heading: null, lines: [] };
  const flush = function () { if (cur.heading !== null || cur.lines.some(function (l) { return l.trim(); })) sections.push(cur); };
  lines.forEach(function (line) {
    const m = line.match(headRe);
    if (m) { flush(); cur = { heading: m[1], lines: [] }; }
    else cur.lines.push(line);
  });
  flush();
  return sections.map(function (s) { return { heading: s.heading, body: s.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() }; });
}

// ---- import: files -> common model --------------------------------------------------------------
/** importRules(projectPath?, opts?) -> RulesModel (all text already redacted). */
function importRules(projectPath, opts) {
  opts = opts || {};
  const base = projectPath || opts.cwd || process.cwd();
  const now = (opts.now && opts.now()) || new Date().toISOString();
  const sections = [];
  const sourceList = [];
  collectSources(base, opts).forEach(function (src) {
    const red = redactText(src.text); // redact ONCE over the whole file, before sectioning
    sourceList.push({ tool: src.tool, rel: src.rel, redactions: red.count });
    splitSections(red.text).forEach(function (sec) {
      if (!sec.body && !sec.heading) return;
      sections.push({ kind: classify(sec.body, sec.heading), from: src.tool, rel: src.rel, heading: sec.heading, text: sec.body });
    });
  });
  return { schemaVersion: SCHEMA_VERSION, generatedAt: now, sources: sourceList, sections: sections };
}

// ---- detect: which tools have rule files present ------------------------------------------------
/** detectRuleFiles(projectPath?, opts?) -> [{ tool, label, files:[rel], count }]. */
function detectRuleFiles(projectPath, opts) {
  const base = projectPath || (opts && opts.cwd) || process.cwd();
  const byTool = Object.create(null);
  collectSources(base, opts || {}).forEach(function (src) {
    (byTool[src.tool] = byTool[src.tool] || []).push(src.rel);
  });
  return Object.keys(byTool).map(function (t) { return { tool: t, label: toolLabel(t), files: byTool[t], count: byTool[t].length }; });
}

// ---- runtime shape validation -------------------------------------------------------------------
function assertModel(model) {
  if (!model || typeof model !== 'object') throw new Error('invalid rules model: not an object');
  if (!Array.isArray(model.sections)) throw new Error('invalid rules model: sections must be an array');
  model.sections.forEach(function (s, i) {
    if (!s || typeof s !== 'object') throw new Error('invalid rules model: section ' + i + ' is not an object');
    if (typeof s.text !== 'string') throw new Error('invalid rules model: section ' + i + ' has no text string');
  });
  return true;
}

// ---- emit: common model -> a target tool's file content -----------------------------------------
/** emit(model, target, opts?) -> string content (re-redacted; pure, no IO). */
function emit(model, target, opts) {
  opts = opts || {};
  assertModel(model);
  const t = EMIT_TARGETS[target];
  if (!t) throw new Error("unknown emit target: '" + target + "' (use claude|cursor|agents|gemini|generic)");
  const byKind = Object.create(null);
  KIND_ORDER.forEach(function (k) { byKind[k] = []; });
  (model.sections || []).forEach(function (s) {
    const k = (s && KIND_ORDER.indexOf(s.kind) !== -1) ? s.kind : 'general';
    byKind[k].push(s);
  });
  const srcNames = (model.sources || []).map(function (x) { return x.rel; });
  const out = [];
  out.push('# ' + t.title + ' — for ' + t.forTool);
  out.push('');
  out.push('<!-- Generated by `keyflip rules emit`' + (srcNames.length ? ' from: ' + srcNames.join(', ') : '') +
    '. Secrets are redacted — never paste credentials here; reference them by env-var name (${VAR}). -->');
  KIND_ORDER.forEach(function (k) {
    const list = byKind[k];
    if (!list.length) return;
    out.push('');
    out.push('## ' + KIND_LABEL[k]);
    list.forEach(function (s) {
      out.push('');
      const prov = '<!-- source: ' + (s.from || 'unknown') + (s.rel ? ' (' + s.rel + ')' : '') + ' -->';
      out.push(s.heading ? ('### ' + s.heading + ' ' + prov) : prov);
      if (s.text) { out.push(''); out.push(s.text); }
    });
  });
  const content = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trimEnd() + '\n';
  return redactText(content).text; // defence in depth: never emit a secret even if one slipped in
}

// ---- project `.keyflip/` state (cached model) ---------------------------------------------------
function rulesDir(projectPath) { return path.join(projectPath || process.cwd(), '.keyflip'); }
function rulesFile(projectPath) { return path.join(rulesDir(projectPath), 'rules.json'); }

/** saveModel(projectPath, model, opts?) -> absolute path written (0600, atomic, mkdir -p). */
function saveModel(projectPath, model, opts) {
  assertModel(model);
  const dest = rulesFile(projectPath);
  fsutil.atomicWrite(dest, JSON.stringify(model, null, 2) + '\n', 0o600);
  return dest;
}

/** loadModel(projectPath) -> RulesModel | null (guarded parse; a corrupt cache yields null). */
function loadModel(projectPath) {
  let raw; try { raw = fs.readFileSync(rulesFile(projectPath), 'utf8'); } catch (e) { return null; }
  let m; try { m = JSON.parse(raw); } catch (e) { return null; }
  try { assertModel(m); } catch (e) { return null; }
  return m;
}

// ---- emit -> file (guarded write, for CLI --write and MCP emit+confirm) --------------------------
/** writeTarget(projectPath, target, content, opts?) -> { path, bytes }. Refuses to escape the project. */
function writeTarget(projectPath, target, content, opts) {
  const t = EMIT_TARGETS[target];
  if (!t) throw new Error("unknown emit target: '" + target + "'");
  const base = projectPath || process.cwd();
  const dest = path.resolve(base, t.filename);
  const guard = fsutil.safeDestUnder(base, dest);
  if (!guard.ok) throw new Error('refusing to write outside the project (' + guard.reason + ')');
  fsutil.atomicWrite(dest, content, 0o600);
  return { path: dest, bytes: Buffer.byteLength(content, 'utf8') };
}

module.exports = {
  SCHEMA_VERSION: SCHEMA_VERSION,
  RULE_SOURCES: RULE_SOURCES,
  EMIT_TARGETS: EMIT_TARGETS,
  KIND_ORDER: KIND_ORDER,
  redactText: redactText,
  classify: classify,
  splitSections: splitSections,
  collectSources: collectSources,
  importRules: importRules,
  detectRuleFiles: detectRuleFiles,
  emit: emit,
  assertModel: assertModel,
  toolLabel: toolLabel,
  rulesDir: rulesDir,
  rulesFile: rulesFile,
  saveModel: saveModel,
  loadModel: loadModel,
  writeTarget: writeTarget,
};
