'use strict';
// Git-bound checkpoints: a portable snapshot of project state at a session boundary. A
// checkpoint records WHERE the repo was (branch/commit/dirty files), a redacted human summary,
// a snapshot of the agent's tasks, and the active provider, chained by `parent` to the previous
// checkpoint (a linked history). It lives in the PROJECT tree under `.keyflip/checkpoints/` (NOT
// the global config dir) so it travels with the repo and can be synced/inspected per project.
//
// SECURITY: this is SHARED, SYNCABLE context — a secret must never enter it. Every text field
// (summary, provider, git branch/commit/dirty paths, and every string inside tasksSnapshot) is
// run through src/secretscan redaction BEFORE it is hashed or written. Credential-shaped keys in
// the tasks snapshot are dropped entirely; token-shaped substrings anywhere are masked.
//
// ALL IO/time/subprocess is injected (opts.run / opts.now / opts.clock) so tests need no real
// git, no subprocess, and no real clock. Design ported from a TS proposal to zero-dep JS (plain
// objects + runtime shape guards); built-ins only.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWrite } = require('./fsutil');
const secretscan = require('./secretscan');

// ---- layout -----------------------------------------------------------------

function checkpointsDir(projectPath) {
  return path.join(projectPath || process.cwd(), '.keyflip', 'checkpoints');
}

// Sanitize a caller-supplied id into a safe single filename component (no traversal, no slashes).
// Returns '' when nothing safe survives, so callers fail closed instead of reading outside the dir.
function safeId(id) {
  const s = String(id == null ? '' : id).replace(/[^A-Za-z0-9._-]/g, '');
  if (!s || s === '.' || s === '..' || s.indexOf('..') !== -1) return '';
  return s.slice(0, 128);
}

// ---- redaction (secrets NEVER enter a checkpoint) ---------------------------

// Mask token-SHAPED secrets inside free prose while preserving the surrounding text (so a summary
// stays useful). Every SECRET_PATTERN is applied globally; the redaction placeholder itself matches
// none of them, so it is stable under re-runs.
function redactText(s) {
  let out = String(s == null ? '' : s);
  secretscan.SECRET_PATTERNS.forEach(function (p) {
    out = out.replace(new RegExp(p.re.source, 'g'), secretscan.REDACTED);
  });
  return out;
}

// Deep-redact an arbitrary (tool-supplied) value: credential-keyed values are dropped, string
// values are token-masked, and rebuilt objects are prototype-pollution-safe (Object.create(null),
// since the keys come from an untrusted snapshot).
function deepRedact(val, key) {
  if (Array.isArray(val)) return val.map(function (x) { return deepRedact(x, null); });
  if (val && typeof val === 'object') {
    const out = Object.create(null);
    Object.keys(val).forEach(function (k) { out[k] = deepRedact(val[k], k); });
    return out;
  }
  if (typeof val === 'string') {
    if (key != null && secretscan.isCredentialKey(key) && !secretscan.isEnvRefOrEmpty(val)) return secretscan.REDACTED;
    return redactText(val);
  }
  return val;
}

// ---- git (best-effort, fully injected — never throws) -----------------------

function safeRun(run, projectPath, args) {
  try { return run('git', ['-C', projectPath].concat(args), null, { timeoutMs: 20000 }); }
  catch (e) { return { code: 1, stdout: '', stderr: String(e && e.message) }; }
}
// Single-line git output (branch / short commit), or null when git is absent / not a repo.
function gitOut(run, projectPath, args) {
  const r = safeRun(run, projectPath, args);
  if (!r || r.code !== 0) return null;
  const s = String(r.stdout || '').trim();
  return s || null;
}
// Parse `git status --porcelain` into the list of changed paths. Handles the `orig -> new` rename
// form (keeps the new path) and git's quoting of paths with special characters.
function parseDirty(porcelain) {
  return String(porcelain || '').split('\n').map(function (line) {
    if (!line || line.length < 4) return null;
    let p = line.slice(3); // strip the 2-char XY status + its trailing space
    const arrow = p.indexOf(' -> ');
    if (arrow !== -1) p = p.slice(arrow + 4);
    return p.replace(/^"|"$/g, '').trim();
  }).filter(Boolean);
}
function readGit(run, projectPath) {
  const branch = gitOut(run, projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const commit = gitOut(run, projectPath, ['rev-parse', '--short', 'HEAD']);
  const st = safeRun(run, projectPath, ['status', '--porcelain']);
  const dirty = (st && st.code === 0) ? parseDirty(st.stdout) : [];
  return { branch: branch, commit: commit, dirty: dirty };
}

// ---- canonical hashing ------------------------------------------------------

// Deterministic, key-sorted serialization (own impl so hostile keys like "__proto__" in the tasks
// snapshot can never mutate a prototype during serialization). Independent of on-disk formatting.
function stableStringify(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + stableStringify(v[k]); }).join(',') + '}';
}
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

// Compact, sortable, filesystem-safe prefix from an ISO timestamp (2026-07-12T10:00:00.000Z ->
// 20260712T100000). Falls back to 'cp' for a non-ISO clock.
function compactStamp(iso) {
  const s = String(iso).replace(/[-:]/g, '').replace(/\..*$/, '').replace(/[^0-9A-Za-z]/g, '');
  return s.slice(0, 16) || 'cp';
}

// ---- reads (READ-ONLY, guarded) ---------------------------------------------

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return null; } // absent or corrupt -> treat as "not present"
}

// The most recent checkpoint (the pointer at latest.json), or null.
function latest(projectPath) {
  return readJson(path.join(checkpointsDir(projectPath), 'latest.json'));
}

// A checkpoint by id, or null. id is sanitized; a traversal attempt yields null.
function get(projectPath, id) {
  const sid = safeId(id);
  if (!sid) return null;
  return readJson(path.join(checkpointsDir(projectPath), sid + '.json'));
}

// All checkpoints for a project, newest first. Skips latest.json (a duplicate pointer) and any
// unparseable file.
function list(projectPath) {
  const dir = checkpointsDir(projectPath);
  let files;
  try { files = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  files.forEach(function (f) {
    if (f === 'latest.json' || f.slice(-5) !== '.json') return;
    const cp = readJson(path.join(dir, f));
    if (cp && cp.id) out.push(cp);
  });
  out.sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); });
  return out;
}

// RESTORE IS READ-ONLY: it returns the recorded checkpoint (so a caller can show/diff/replay it)
// and NEVER touches git or the working tree. With no id it returns the latest.
function restore(projectPath, id) {
  return id ? get(projectPath, id) : latest(projectPath);
}

// ---- create (the only mutation) ---------------------------------------------

// create(projectPath, { summary, tasksSnapshot, provider }, opts) -> the written checkpoint.
// opts.run (default ./exec.run) reads git; opts.now / opts.clock (default real clock) stamp `at`.
// Writes .keyflip/checkpoints/<id>.json AND latest.json (both 0600, atomic). `parent` links to the
// previous latest, forming a chain. Every text field is redacted before hashing/writing.
function create(projectPath, data, opts) {
  projectPath = projectPath || process.cwd();
  data = data || {};
  opts = opts || {};
  const run = opts.run || require('./exec').run;
  const nowFn = typeof opts.now === 'function' ? opts.now
    : (typeof opts.clock === 'function' ? opts.clock
      : function () { return new Date().toISOString(); });
  const at = String(nowFn());

  const prev = latest(projectPath);
  const parent = prev && prev.id ? String(prev.id) : null;

  const rawGit = readGit(run, projectPath);
  const git = {
    branch: rawGit.branch == null ? null : redactText(rawGit.branch),
    commit: rawGit.commit == null ? null : redactText(rawGit.commit),
    dirty: (rawGit.dirty || []).map(redactText),
  };

  const provider = data.provider == null ? null : redactText(String(data.provider));
  const summary = data.summary == null ? '' : redactText(String(data.summary));
  const tasksSnapshot = data.tasksSnapshot === undefined ? null : deepRedact(data.tasksSnapshot, null);

  // The hashed body is everything EXCEPT id + contentHash (which are derived from it).
  const body = { at: at, provider: provider, git: git, summary: summary, tasksSnapshot: tasksSnapshot, parent: parent };
  const contentHash = sha256(stableStringify(body));
  const id = compactStamp(at) + '-' + contentHash.slice(0, 8);

  const cp = { id: id, at: at, provider: provider, git: git, summary: summary, tasksSnapshot: tasksSnapshot, contentHash: contentHash, parent: parent };

  const dir = checkpointsDir(projectPath);
  const json = JSON.stringify(cp, null, 2) + '\n';
  atomicWrite(path.join(dir, safeId(id) + '.json'), json, 0o600); // mkdir -p happens in atomicWrite
  atomicWrite(path.join(dir, 'latest.json'), json, 0o600);
  return cp;
}

module.exports = {
  create: create,
  list: list,
  latest: latest,
  get: get,
  restore: restore,
  // exposed for reuse / wiring / tests
  checkpointsDir: checkpointsDir,
  safeId: safeId,
  redactText: redactText,
  deepRedact: deepRedact,
  stableStringify: stableStringify,
};
