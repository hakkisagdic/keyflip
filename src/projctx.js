'use strict';
// Wave 4 Context Layer — the PROJECT-CONTEXT store. A tool-independent, portable project
// memory that lives in a `.keyflip/` folder in the PROJECT directory (NOT ctx.configDir) so it
// travels with the repo across AI tools/accounts/machines. Holds a NormalizedProjectContext:
//   .keyflip/project.json    { schemaVersion, projectId, name, description, stack[],
//                              repositories[{path,branch}], activeTaskId, lastProvider, updatedAt }
//   .keyflip/context.md      freeform project summary
//   .keyflip/decisions.json  { schemaVersion, decisions:[{id,title,rationale,alternatives[],
//                              status,doNot[],at}] }
//   .keyflip/tasks.json      { schemaVersion, tasks:[{id,title,status,relatedFiles[],
//                              completedSteps[],remainingSteps[],acceptanceCriteria[],knownIssues[],at}] }
//
// SECURITY IS CENTRAL: this is a SHARED, SYNCABLE context, so a secret must NEVER enter it. Every
// text field is run through secretscan redaction before it is written / packed / emitted, and
// `pack` carries only env-var NAMES + descriptions (extracted from any .env) — never values.
//
// The `context.js` name in the roadmap collides with the existing env-`ctx` factory, so the store
// ships as `projctx.js`; the user-facing command stays `keyflip context` and the MCP tools stay
// `keyflip_context_*`. Zero-dep: Node built-ins only. All IO/time/subprocess is injectable via
// opts (opts.now/opts.clock, opts.run) so tests need no network/subprocess/real time/real git.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWrite } = require('./fsutil');
const secretscan = require('./secretscan');

const SCHEMA_VERSION = 1;
const DECISION_STATUS = ['decided', 'rejected', 'superseded'];
const TASK_STATUS = ['todo', 'in_progress', 'blocked', 'done'];
const PROJECT_FIELDS = ['schemaVersion', 'projectId', 'name', 'description', 'stack', 'repositories', 'activeTaskId', 'lastProvider', 'updatedAt'];
const DECISION_FIELDS = ['id', 'title', 'rationale', 'alternatives', 'status', 'doNot', 'at'];
const TASK_FIELDS = ['id', 'title', 'status', 'relatedFiles', 'completedSteps', 'remainingSteps', 'acceptanceCriteria', 'knownIssues', 'at'];

// ---- paths -------------------------------------------------------------------
function base(projectPath) { return path.resolve(projectPath || process.cwd()); }
function dir(projectPath) { return path.join(base(projectPath), '.keyflip'); }
function projectFile(pp) { return path.join(dir(pp), 'project.json'); }
function contextFile(pp) { return path.join(dir(pp), 'context.md'); }
function decisionsFile(pp) { return path.join(dir(pp), 'decisions.json'); }
function tasksFile(pp) { return path.join(dir(pp), 'tasks.json'); }

// ---- tiny helpers ------------------------------------------------------------
function str(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }
function strArray(v) { return Array.isArray(v) ? v.filter(function (x) { return typeof x === 'string'; }) : []; }

// Injected clock: opts.now() or opts.clock() -> ISO string; else real time.
function nowIso(opts) {
  const f = opts && (opts.now || opts.clock);
  if (typeof f === 'function') { try { return str(f()); } catch (e) { /* fall through */ } }
  return new Date().toISOString();
}

function genId(prefix) {
  let rnd; try { rnd = crypto.randomBytes(6).toString('hex'); }
  catch (e) { rnd = String(Date.now()) + Math.floor(Math.random() * 1e6); }
  return prefix + '-' + rnd;
}
function genUuid() {
  try { return crypto.randomUUID(); }
  catch (e) { return 'proj-' + crypto.randomBytes(8).toString('hex'); }
}

// ---- redaction (the security core) ------------------------------------------
// Scrub a single text field: line-based credential redaction (key=value / key: value) PLUS an
// inline token-shape sweep for secrets embedded in prose. Defence in depth — applied on WRITE and
// again on PACK, so a secret can neither be stored nor emitted.
function redactText(s) {
  const s0 = str(s);
  if (!s0) return s0;
  let out = secretscan.redactLines(s0).text;
  secretscan.SECRET_PATTERNS.forEach(function (p) {
    out = out.replace(new RegExp(p.re.source, 'g'), secretscan.REDACTED);
  });
  return out;
}
// Redact every string leaf of a value; prototype-pollution safe (drops __proto__/constructor keys).
function redactDeep(v) {
  if (typeof v === 'string') return redactText(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') {
    const o = {};
    Object.keys(v).forEach(function (k) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') return;
      o[k] = redactDeep(v[k]);
    });
    return o;
  }
  return v;
}

// ---- guarded JSON IO ---------------------------------------------------------
function readJson(file) {
  let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  try { return JSON.parse(raw); } catch (e) { return null; } // corrupt file = treat as absent (never throw a read)
}
function writeJson(file, obj) { atomicWrite(file, JSON.stringify(obj, null, 2) + '\n', 0o600); }

// Copy only known fields from base then patch (ignores prototype-polluting keys implicitly).
function mergeKnown(baseObj, patch, fields) {
  const out = {};
  fields.forEach(function (f) { if (baseObj && Object.prototype.hasOwnProperty.call(baseObj, f)) out[f] = baseObj[f]; });
  if (patch) fields.forEach(function (f) { if (Object.prototype.hasOwnProperty.call(patch, f) && patch[f] !== undefined) out[f] = patch[f]; });
  return out;
}

// ---- normalizers (runtime shape validation + redaction) ----------------------
function repoArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map(function (r) {
    if (!r || typeof r !== 'object') return null;
    return { path: redactText(r.path), branch: r.branch != null ? redactText(r.branch) : null };
  }).filter(Boolean);
}
function normalizeProject(input, pp, opts) {
  input = input || {};
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: str(input.projectId) || genUuid(),
    name: redactText(str(input.name) || path.basename(base(pp))),
    description: redactText(input.description),
    stack: strArray(input.stack).map(redactText),
    repositories: repoArray(input.repositories),
    activeTaskId: input.activeTaskId != null && input.activeTaskId !== '' ? str(input.activeTaskId) : null,
    lastProvider: input.lastProvider != null && input.lastProvider !== '' ? redactText(input.lastProvider) : null,
    updatedAt: nowIso(opts),
  };
}
function normalizeDecision(input, opts) {
  input = input || {};
  const status = input.status != null && input.status !== '' ? String(input.status) : 'decided';
  if (DECISION_STATUS.indexOf(status) === -1) throw new Error("invalid decision status: '" + status + "' (use " + DECISION_STATUS.join('|') + ')');
  return {
    id: str(input.id) || genId('dec'),
    title: redactText(input.title),
    rationale: redactText(input.rationale),
    alternatives: strArray(input.alternatives).map(redactText),
    status: status,
    doNot: strArray(input.doNot).map(redactText),
    at: input.at != null ? str(input.at) : nowIso(opts),
  };
}
function normalizeTask(input, opts) {
  input = input || {};
  const status = input.status != null && input.status !== '' ? String(input.status) : 'todo';
  if (TASK_STATUS.indexOf(status) === -1) throw new Error("invalid task status: '" + status + "' (use " + TASK_STATUS.join('|') + ')');
  return {
    id: str(input.id) || genId('task'),
    title: redactText(input.title),
    status: status,
    relatedFiles: strArray(input.relatedFiles).map(redactText),
    completedSteps: strArray(input.completedSteps).map(redactText),
    remainingSteps: strArray(input.remainingSteps).map(redactText),
    acceptanceCriteria: strArray(input.acceptanceCriteria).map(redactText),
    knownIssues: strArray(input.knownIssues).map(redactText),
    at: input.at != null ? str(input.at) : nowIso(opts),
  };
}

// ---- project.json ------------------------------------------------------------
function defaultProject(pp, opts) {
  return normalizeProject({
    projectId: (opts && opts.projectId) || genUuid(),
    name: (opts && opts.name) || path.basename(base(pp)),
  }, pp, opts);
}
function saveProject(pp, project, opts) {
  const p = normalizeProject(project, pp, opts);
  writeJson(projectFile(pp), p);
  return p;
}
// Bump project.updatedAt after a decisions/tasks/context mutation. Best-effort, never throws.
function touch(pp, opts) {
  const existing = readJson(projectFile(pp));
  if (!existing) return;
  try { saveProject(pp, existing, opts); } catch (e) { /* ignore */ }
}

// ---- public API --------------------------------------------------------------
function exists(projectPath) {
  const pp = base(projectPath);
  try { return fs.statSync(projectFile(pp)).isFile(); } catch (e) { return false; }
}

function defaultContextMd(pp) {
  return '# ' + path.basename(base(pp)) + '\n\n' +
    '_Freeform project summary. Describe what this project is, its architecture, and anything a\n' +
    'new AI session should know before touching the code._\n';
}

// Create the `.keyflip/` folder + all four files (idempotent — never clobbers existing state).
function init(projectPath, opts) {
  const pp = base(projectPath);
  opts = opts || {};
  fs.mkdirSync(dir(pp), { recursive: true });
  if (!exists(pp)) {
    const project = defaultProject(pp, opts);
    const repo = detectRepo(pp, opts); // best-effort, injected subprocess, never throws
    if (repo) project.repositories = [repo];
    saveProject(pp, project, opts);
  }
  if (readJson(decisionsFile(pp)) == null) writeJson(decisionsFile(pp), { schemaVersion: SCHEMA_VERSION, decisions: [] });
  if (readJson(tasksFile(pp)) == null) writeJson(tasksFile(pp), { schemaVersion: SCHEMA_VERSION, tasks: [] });
  try { fs.accessSync(contextFile(pp)); } catch (e) { atomicWrite(contextFile(pp), defaultContextMd(pp), 0o600); }
  return read(pp, opts);
}

// Best-effort current-branch detection via the injected runner (default exec.run). Returns
// { path:'.', branch } or null. Zero secrets, never throws, and fully skippable in tests.
function detectRepo(projectPath, opts) {
  const run = (opts && opts.run) || require('./exec').run;
  try {
    const r = run('git', ['-C', base(projectPath), 'rev-parse', '--abbrev-ref', 'HEAD']);
    if (r && r.code === 0) {
      const branch = str(r.stdout).trim();
      if (branch) return { path: '.', branch: branch };
    }
  } catch (e) { /* no git / not a repo */ }
  return null;
}

// Assemble the NormalizedProjectContext (all four, null-safe — missing/corrupt files never throw).
function read(projectPath, opts) {
  const pp = base(projectPath);
  const project = readJson(projectFile(pp));
  const decisionsDoc = readJson(decisionsFile(pp)) || {};
  const tasksDoc = readJson(tasksFile(pp)) || {};
  let context = '';
  try { context = fs.readFileSync(contextFile(pp), 'utf8'); } catch (e) { context = ''; }
  return {
    schemaVersion: SCHEMA_VERSION,
    projectPath: pp,
    project: project || null,
    context: context,
    decisions: Array.isArray(decisionsDoc.decisions) ? decisionsDoc.decisions : [],
    tasks: Array.isArray(tasksDoc.tasks) ? tasksDoc.tasks : [],
    activeTaskId: (project && project.activeTaskId) || null,
  };
}

function setProject(projectPath, project, opts) {
  const pp = base(projectPath);
  const existing = readJson(projectFile(pp));
  const input = Object.assign({}, project);
  if (input.projectId == null && existing && existing.projectId) input.projectId = existing.projectId;
  return saveProject(pp, input, opts);
}
function patchProject(projectPath, patch, opts) {
  const pp = base(projectPath);
  const existing = readJson(projectFile(pp)) || defaultProject(pp, opts);
  return saveProject(pp, mergeKnown(existing, patch, PROJECT_FIELDS), opts);
}
function setContextMd(projectPath, md, opts) {
  const pp = base(projectPath);
  const text = redactText(md);
  fs.mkdirSync(dir(pp), { recursive: true });
  atomicWrite(contextFile(pp), text, 0o600);
  touch(pp, opts);
  return text;
}

// ---- decisions ---------------------------------------------------------------
function readDecisions(pp) {
  const doc = readJson(decisionsFile(pp));
  return Array.isArray(doc && doc.decisions) ? doc.decisions.slice() : [];
}
function writeDecisions(pp, list) { writeJson(decisionsFile(pp), { schemaVersion: SCHEMA_VERSION, decisions: list }); }
function addDecision(projectPath, decision, opts) {
  const pp = base(projectPath);
  const rec = normalizeDecision(decision, opts);
  const list = readDecisions(pp);
  list.push(rec);
  writeDecisions(pp, list);
  touch(pp, opts);
  return rec;
}
function updateDecision(projectPath, id, patch, opts) {
  const pp = base(projectPath);
  const list = readDecisions(pp);
  let updated = null;
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].id === str(id)) {
      const merged = mergeKnown(list[i], patch, DECISION_FIELDS);
      merged.id = list[i].id; // id is immutable
      updated = normalizeDecision(merged, opts);
      list[i] = updated;
      break;
    }
  }
  if (!updated) return null;
  writeDecisions(pp, list);
  touch(pp, opts);
  return updated;
}
function removeDecision(projectPath, id, opts) {
  const pp = base(projectPath);
  const list = readDecisions(pp);
  const kept = list.filter(function (d) { return !(d && d.id === str(id)); });
  if (kept.length === list.length) return false;
  writeDecisions(pp, kept);
  touch(pp, opts);
  return true;
}

// ---- tasks -------------------------------------------------------------------
function readTasks(pp) {
  const doc = readJson(tasksFile(pp));
  return Array.isArray(doc && doc.tasks) ? doc.tasks.slice() : [];
}
function writeTasks(pp, list) { writeJson(tasksFile(pp), { schemaVersion: SCHEMA_VERSION, tasks: list }); }
function addTask(projectPath, task, opts) {
  const pp = base(projectPath);
  const rec = normalizeTask(task, opts);
  const list = readTasks(pp);
  list.push(rec);
  writeTasks(pp, list);
  touch(pp, opts);
  return rec;
}
function updateTask(projectPath, id, patch, opts) {
  const pp = base(projectPath);
  const list = readTasks(pp);
  let updated = null;
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].id === str(id)) {
      const merged = mergeKnown(list[i], patch, TASK_FIELDS);
      merged.id = list[i].id; // id is immutable
      updated = normalizeTask(merged, opts);
      list[i] = updated;
      break;
    }
  }
  if (!updated) return null;
  writeTasks(pp, list);
  touch(pp, opts);
  return updated;
}
function removeTask(projectPath, id, opts) {
  const pp = base(projectPath);
  const list = readTasks(pp);
  const kept = list.filter(function (t) { return !(t && t.id === str(id)); });
  if (kept.length === list.length) return false;
  writeTasks(pp, kept);
  // If the removed task was the active one, clear the pointer.
  const proj = readJson(projectFile(pp));
  if (proj && proj.activeTaskId === str(id)) saveProject(pp, mergeKnown(proj, { activeTaskId: null }, PROJECT_FIELDS), opts);
  else touch(pp, opts);
  return true;
}
// Point project.activeTaskId at a task (null/'' clears it). Throws if the id is unknown.
function setActiveTask(projectPath, taskId, opts) {
  const pp = base(projectPath);
  const project = readJson(projectFile(pp)) || defaultProject(pp, opts);
  let next = null;
  if (taskId != null && taskId !== '') {
    next = str(taskId);
    const known = readTasks(pp).some(function (t) { return t && t.id === next; });
    if (!known) throw new Error("no such task: '" + next + "'");
  }
  return saveProject(pp, mergeKnown(project, { activeTaskId: next }, PROJECT_FIELDS), opts);
}

// ---- .env NAMES only ---------------------------------------------------------
// Extract required environment variables from any top-level `.env*` file BY NAME ONLY. The value is
// read solely to decide isSecret, then discarded — it never reaches the returned object. The name is
// validated against a strict identifier shape so a token can't masquerade as one. Comment lines
// become the description of the following var (redacted). Result is a null-proto-built, sorted list.
function scanEnvVars(projectPath) {
  const pp = base(projectPath);
  const acc = Object.create(null);
  let names; try { names = fs.readdirSync(pp); } catch (e) { return []; }
  names.filter(function (n) { return /^\.env(\.[A-Za-z0-9_.\-]+)?$/.test(n); }).sort().forEach(function (n) {
    const file = path.join(pp, n);
    let raw; try { if (!fs.statSync(file).isFile()) return; raw = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
    let pendingComment = '';
    str(raw).split('\n').forEach(function (line) {
      const t = line.trim();
      if (!t) { pendingComment = ''; return; }
      if (t[0] === '#') { pendingComment = t.replace(/^#+\s*/, ''); return; }
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) { pendingComment = ''; return; }
      const name = m[1];
      const val = m[2].trim().replace(/^["']|["']$/g, ''); // used ONLY for the secret check, never stored
      const isSecret = secretscan.isCredentialKey(name) || secretscan.looksSecret(val);
      const desc = redactText(pendingComment);
      if (!acc[name]) acc[name] = { name: name, description: desc, isSecret: isSecret };
      else { if (isSecret) acc[name].isSecret = true; if (!acc[name].description && desc) acc[name].description = desc; }
      pendingComment = '';
    });
  });
  return Object.keys(acc).sort().map(function (k) { return acc[k]; });
}

// Build the single context PACKAGE — project + context + decisions + tasks + requiredEnvironmentVariables.
// Every text field is redacted again here (defence in depth) so the package can NEVER leak a secret.
function pack(projectPath, opts) {
  const pp = base(projectPath);
  const c = read(pp, opts);
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: nowIso(opts),
    project: c.project ? redactDeep(c.project) : null,
    context: redactText(c.context),
    decisions: (c.decisions || []).map(redactDeep),
    tasks: (c.tasks || []).map(redactDeep),
    activeTaskId: c.activeTaskId || null,
    requiredEnvironmentVariables: scanEnvVars(pp),
  };
}

function countBy(arr, key) {
  const m = Object.create(null);
  (arr || []).forEach(function (x) { if (!x) return; const k = String(x[key]); m[k] = (m[k] || 0) + 1; });
  return m;
}

// A short, human, redacted summary of the project's memory.
function summary(projectPath, opts) {
  const pp = base(projectPath);
  const c = read(pp, opts);
  const p = c.project;
  const lines = [];
  const name = (p && p.name) || path.basename(pp);
  lines.push(name + (p && p.description ? ' — ' + p.description : ''));
  if (p && Array.isArray(p.stack) && p.stack.length) lines.push('Stack: ' + p.stack.join(', '));
  const byStatus = countBy(c.tasks, 'status');
  lines.push('Tasks: ' + c.tasks.length + ' (' + (byStatus.in_progress || 0) + ' in progress, ' +
    (byStatus.todo || 0) + ' todo, ' + (byStatus.blocked || 0) + ' blocked, ' + (byStatus.done || 0) + ' done)');
  lines.push('Decisions: ' + c.decisions.length);
  if (c.activeTaskId) {
    const at = c.tasks.filter(function (t) { return t && t.id === c.activeTaskId; })[0];
    lines.push('Active task: ' + (at ? at.title : c.activeTaskId));
  }
  return redactText(lines.join('\n'));
}

module.exports = {
  SCHEMA_VERSION: SCHEMA_VERSION,
  DECISION_STATUS: DECISION_STATUS,
  TASK_STATUS: TASK_STATUS,
  dir: dir,
  init: init,
  exists: exists,
  read: read,
  setProject: setProject,
  patchProject: patchProject,
  setContextMd: setContextMd,
  addDecision: addDecision,
  updateDecision: updateDecision,
  removeDecision: removeDecision,
  addTask: addTask,
  updateTask: updateTask,
  removeTask: removeTask,
  setActiveTask: setActiveTask,
  scanEnvVars: scanEnvVars,
  pack: pack,
  summary: summary,
  // exported for tests / reuse
  redactText: redactText,
  detectRepo: detectRepo,
};
