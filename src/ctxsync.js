'use strict';
// Context-sync PRIVACY MODES + CONFLICT DETECTION for the project-local `.keyflip/` context
// package. keyflip's Context Layer builds a SHARED, SYNCABLE bundle of project context (agent
// rule files, conversation summaries, code snippets, env-var NAMES) — so a secret must NEVER
// enter it. Two guarantees hold here: (1) a privacy MODE + POLICY decides what MAY leave the
// machine (local = never; git = plain in the repo; encrypted = passphrase-sealed; company =
// stripped to approved providers), and (2) EVERY text field is run through the secret scanner
// before it is packed/emitted, regardless of mode (defence in depth). Conflict detection uses a
// content-hash + parent-checkpoint model so two machines that edited the same base are flagged
// rather than silently overwriting each other.
//
// Design mirrors the TypeScript proposal but ships as zero-dep JS: plain objects, JSDoc-ish
// comments, and runtime shape validation. State lives in the PROJECT dir (`.keyflip/`), NOT
// ctx.configDir. All IO/time/subprocess is injectable (opts.now / opts.clock / opts.run /
// opts.fetch / opts.passphrase) so tests need no network, subprocess, real clock, or real git.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fsutil = require('./fsutil');
const secretscan = require('./secretscan');
const agents = require('./agents');

const SCHEMA_VERSION = 1;
const MAGIC = 'keyflip-ctxsync';
const SYNC_MAGIC = 'keyflip-sync'; // envelope shape emitted by src/sync.js encrypt()
const MODES = ['local', 'git', 'encrypted', 'company'];

// Per-mode DEFAULT policy. `local` never leaves the machine; `company` is the strictest share
// (no raw conversations, no source snippets, only explicitly-approved providers).
const DEFAULT_POLICIES = {
  local: { allowRawConversationSync: true, allowSourceCodeSnippets: true, allowCloudSync: false, allowedProviders: [] },
  git: { allowRawConversationSync: true, allowSourceCodeSnippets: true, allowCloudSync: false, allowedProviders: [] },
  encrypted: { allowRawConversationSync: true, allowSourceCodeSnippets: true, allowCloudSync: true, allowedProviders: [] },
  company: { allowRawConversationSync: false, allowSourceCodeSnippets: false, allowCloudSync: true, allowedProviders: [] },
};

// ---- paths -------------------------------------------------------------------
function keyflipDir(projectPath) { return path.join(projectPath || process.cwd(), '.keyflip'); }
function metaPath(projectPath) { return path.join(keyflipDir(projectPath), 'adapters', 'metadata.json'); }
function contextDir(projectPath) { return path.join(keyflipDir(projectPath), 'context'); }

// ---- injectable clock --------------------------------------------------------
function nowFn(opts) {
  if (opts && typeof opts.now === 'function') return opts.now;
  if (opts && typeof opts.clock === 'function') return opts.clock;
  return function () { return new Date().toISOString(); };
}

// ---- guarded IO --------------------------------------------------------------
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}
function readFileSafe(p) {
  try { if (!fs.statSync(p).isFile()) return null; return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
}

// ---- validation --------------------------------------------------------------
function validateMode(mode) {
  if (MODES.indexOf(mode) === -1) throw new Error('unknown context-sync mode "' + String(mode) + '" (use: ' + MODES.join('|') + ')');
  return mode;
}
// Coerce an untrusted policy blob into a well-typed policy (booleans + a string array). Never
// trusts incoming types — a hostile payload cannot smuggle a truthy object where a bool is meant.
function normalizePolicy(policy) {
  policy = policy || {};
  const providers = Array.isArray(policy.allowedProviders)
    ? policy.allowedProviders.filter(function (p) { return typeof p === 'string' && p; }).map(String)
    : [];
  return {
    allowRawConversationSync: policy.allowRawConversationSync === true,
    allowSourceCodeSnippets: policy.allowSourceCodeSnippets === true,
    allowCloudSync: policy.allowCloudSync === true,
    allowedProviders: providers,
  };
}

// ---- secret scrubbing (defence in depth) ------------------------------------
// Redact any secret-shaped token found INSIDE a free-text string, leaving the surrounding prose
// intact. Counts each redaction so callers can report "N secrets stripped".
function redactText(s, counter) {
  let out = String(s == null ? '' : s);
  secretscan.SECRET_PATTERNS.forEach(function (p) {
    out = out.replace(new RegExp(p.re.source, 'g'), function () { if (counter) counter.n++; return secretscan.REDACTED; });
  });
  return out;
}
// Deep-rebuild a value with every string secret-scanned. A credential-KEYED value (e.g. a field
// literally named `token`) whose value isn't an env-ref/placeholder is dropped wholesale. The
// rebuild also DROPS prototype-pollution keys, so a hostile imported payload cannot poison
// Object.prototype through this data. Returns fresh PLAIN objects (deepStrictEqual-friendly).
function scrub(value, counter, key) {
  if (Array.isArray(value)) return value.map(function (v) { return scrub(v, counter, key); });
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach(function (k) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') return; // pollution guard
      out[k] = scrub(value[k], counter, k);
    });
    return out;
  }
  if (typeof value === 'string') {
    if (key != null && secretscan.isCredentialKey(key) && !secretscan.isEnvRefOrEmpty(value)) { if (counter) counter.n++; return secretscan.REDACTED; }
    return redactText(value, counter);
  }
  return value;
}

// ---- package shape -----------------------------------------------------------
function asArray(v) { return Array.isArray(v) ? v : []; }
// Coerce an arbitrary (possibly injected/untrusted) package into the canonical shape. This is a
// WHITELIST: only known fields survive, everything is String()-coerced, and env-var VALUES are
// dropped on the floor — the context carries variable NAMES + descriptions, never their values.
function normalizeInputPkg(pkg) {
  pkg = pkg || {};
  return {
    schemaVersion: SCHEMA_VERSION,
    project: String(pkg.project || ''),
    rules: asArray(pkg.rules).map(function (r) {
      r = r || {};
      return { tool: String(r.tool || ''), rel: String(r.rel || ''), content: String(r.content || '') };
    }),
    conversations: asArray(pkg.conversations).map(function (c) {
      c = c || {};
      return {
        id: String(c.id || ''),
        tool: String(c.tool || ''),
        summary: c.summary != null ? String(c.summary) : null,
        messages: asArray(c.messages).map(function (m) { m = m || {}; return { role: String(m.role || ''), text: String(m.text || '') }; }),
      };
    }),
    snippets: asArray(pkg.snippets).map(function (s) {
      s = s || {};
      return { path: String(s.path || ''), lang: String(s.lang || ''), code: String(s.code || '') };
    }),
    envVars: asArray(pkg.envVars).map(function (e) {
      e = e || {};
      return { name: String(e.name || e.key || ''), description: e.description != null ? String(e.description) : '' };
    }),
  };
}

// Assemble the raw context package for a project. Existence-gated + zero-dep. Sources:
//   - rules: each tool's rule/config file (agents.CONFIG_REGISTRY paths) resolved UNDER the
//     project, secret-scanned via secretscan.redactConfig on the way in.
//   - conversations/snippets/envVars: JSON under `.keyflip/context/`, plus anything injected via
//     opts (opts.conversations / opts.snippets / opts.envVars).
//   - opts.sessionFiles: foreign session logs normalized through src/foreign.js into conversations.
// A fully-injected opts.pkg short-circuits the scan (used by tests + programmatic callers).
function buildPackage(projectPath, opts) {
  opts = opts || {};
  if (opts.pkg) return normalizeInputPkg(opts.pkg);
  const root = projectPath || process.cwd();
  const pkg = { project: path.basename(root), rules: [], conversations: [], snippets: [], envVars: [] };

  agents.CONFIG_REGISTRY.forEach(function (a) {
    a.files.forEach(function (rel) {
      const raw = readFileSafe(path.join(root, rel));
      if (raw == null) return;
      const red = secretscan.redactConfig(raw); // structure travels, keys don't
      pkg.rules.push({ tool: a.id, rel: rel, content: red.text });
    });
  });

  const conv = readJsonSafe(path.join(contextDir(root), 'conversations.json'));
  if (Array.isArray(conv)) pkg.conversations = pkg.conversations.concat(conv);
  const snip = readJsonSafe(path.join(contextDir(root), 'snippets.json'));
  if (Array.isArray(snip)) pkg.snippets = pkg.snippets.concat(snip);
  const env = readJsonSafe(path.join(contextDir(root), 'env.json'));
  if (Array.isArray(env)) pkg.envVars = pkg.envVars.concat(env);

  if (Array.isArray(opts.conversations)) pkg.conversations = pkg.conversations.concat(opts.conversations);
  if (Array.isArray(opts.snippets)) pkg.snippets = pkg.snippets.concat(opts.snippets);
  if (Array.isArray(opts.envVars)) pkg.envVars = pkg.envVars.concat(opts.envVars);

  asArray(opts.sessionFiles).forEach(function (f) {
    const raw = readFileSafe(f);
    if (raw == null) return;
    let n; try { n = require('./foreign').normalize(f, raw); } catch (e) { return; }
    pkg.conversations.push({
      id: path.basename(f), tool: n.tool || 'unknown', summary: null,
      messages: (n.messages || []).map(function (m) { return { role: m.role, text: m.text }; }),
    });
  });

  return normalizeInputPkg(pkg);
}

// ---- mode + policy store -----------------------------------------------------
function defaultMeta() {
  return { schemaVersion: SCHEMA_VERSION, mode: 'local', policy: normalizePolicy(DEFAULT_POLICIES.local), contentHash: null, parent: null, updatedAt: null };
}
// Read the stored mode/policy/checkpoint. A missing/corrupt file is a legit "never configured"
// state → the local default (fail closed: nothing syncs until a mode is explicitly chosen).
function getMode(projectPath, opts) {
  const m = readJsonSafe(metaPath(projectPath));
  if (!m || typeof m !== 'object') return defaultMeta();
  const mode = MODES.indexOf(m.mode) !== -1 ? m.mode : 'local';
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: mode,
    policy: normalizePolicy(m.policy),
    contentHash: m.contentHash != null ? String(m.contentHash) : null,
    parent: m.parent != null ? String(m.parent) : null,
    updatedAt: m.updatedAt != null ? String(m.updatedAt) : null,
  };
}
function writeMeta(projectPath, meta) {
  fsutil.atomicWrite(metaPath(projectPath), JSON.stringify(meta, null, 2) + '\n', 0o600);
  return meta;
}
// Set the privacy mode. Policy = the mode's default, with opts.policy merged over it. Switching
// TO company preserves an existing allowedProviders list unless the caller overrides it (so a
// mode flip doesn't silently forget which providers were approved). The checkpoint carries over.
function setMode(projectPath, mode, opts) {
  validateMode(mode);
  opts = opts || {};
  const cur = getMode(projectPath, opts);
  const over = opts.policy || {};
  const policy = normalizePolicy(Object.assign({}, DEFAULT_POLICIES[mode], over));
  if (mode === 'company' && !('allowedProviders' in over) && cur.policy.allowedProviders.length) {
    policy.allowedProviders = cur.policy.allowedProviders.slice();
  }
  return writeMeta(projectPath, {
    schemaVersion: SCHEMA_VERSION, mode: mode, policy: policy,
    contentHash: cur.contentHash || null, parent: cur.parent || null, updatedAt: nowFn(opts)(),
  });
}

// ---- filtering ---------------------------------------------------------------
// Strip a package to what `policy` permits, then ALWAYS secret-scan every text field regardless
// of mode. Returns a fresh package. `counter` (optional) accumulates the redaction count.
function filterForSync(pkg, policy, counter) {
  policy = normalizePolicy(policy);
  counter = counter || { n: 0 };
  const out = normalizeInputPkg(pkg);
  if (!policy.allowRawConversationSync) {
    // Drop the raw transcript; keep the id/tool/summary so the context still references it.
    out.conversations = out.conversations.map(function (c) { return { id: c.id, tool: c.tool, summary: c.summary, messages: [] }; });
  }
  if (!policy.allowSourceCodeSnippets) out.snippets = [];
  // Defence in depth: a secret must never enter the shared context, even when the policy permits
  // raw content — so scrub happens on EVERY export path, not just the "strict" modes.
  return scrub(out, counter);
}
// company mode: keep only content whose provider/tool is on the approved list. envVars (names
// only) and snippets are not provider-scoped, so they pass this stage untouched.
function filterByProviders(pkg, allowedProviders) {
  const set = Object.create(null); // keyed by tool-supplied provider ids
  (allowedProviders || []).forEach(function (p) { set[p] = true; });
  const out = normalizeInputPkg(pkg);
  out.rules = out.rules.filter(function (r) { return set[r.tool]; });
  out.conversations = out.conversations.filter(function (c) { return set[c.tool]; });
  return out;
}

// ---- content hash + checkpoint ----------------------------------------------
// Deterministic SHA-256 over the key-sorted canonical JSON of the package content. Two machines
// with the same logical context produce the same hash (the basis for conflict detection).
function contentHash(pkg) {
  const canon = JSON.stringify(fsutil.sortKeys(normalizeInputPkg(pkg)));
  return crypto.createHash('sha256').update(canon).digest('hex');
}
// Best-effort current git commit of the project (informational checkpoint annotation). Only runs
// when a runner is injected/available; never throws. Kept out of the hermetic code paths.
function gitHead(projectPath, opts) {
  const run = (opts && opts.run) || require('./exec').run;
  if (typeof run !== 'function') return null;
  try { const r = run('git', ['-C', projectPath || process.cwd(), 'rev-parse', 'HEAD']); if (r && r.code === 0) return String(r.stdout || '').trim() || null; } catch (e) { /* no git / not a repo */ }
  return null;
}
// Advance the stored checkpoint after a successful sync: the old contentHash becomes the parent
// of the new one. Used to keep the conflict-detection lineage coherent across syncs.
function recordCheckpoint(projectPath, hash, opts) {
  const cur = getMode(projectPath, opts);
  return writeMeta(projectPath, {
    schemaVersion: SCHEMA_VERSION, mode: cur.mode, policy: cur.policy,
    contentHash: String(hash), parent: cur.contentHash || null, updatedAt: nowFn(opts)(),
  });
}

// ---- export ------------------------------------------------------------------
// Produce the sync payload for the project's current (or opts.mode-overridden) mode:
//   local     -> throws (nothing ever syncs)
//   git       -> plain JSON (the repo carries `.keyflip/`)
//   encrypted -> require('./sync').encrypt(JSON, passphrase)  (passphrase-sealed for the cloud)
//   company   -> plain JSON, pre-filtered to allowedProviders
// Returns { mode, encrypted, contentHash, redactions, payload } where payload is the string to
// write/transmit. The embedded meta (contentHash/parent/updatedAt) lets the receiver detect a
// conflict against its own checkpoint.
function exportPackage(projectPath, opts) {
  opts = opts || {};
  const meta = getMode(projectPath, opts);
  const mode = opts.mode ? validateMode(opts.mode) : meta.mode;
  if (mode === 'local') throw new Error('context-sync mode is "local" — nothing is exported. Switch first: keyflip context sync mode <git|encrypted|company>');
  const policy = normalizePolicy(opts.policy || meta.policy);

  let pkg = buildPackage(projectPath, opts);
  if (mode === 'company') pkg = filterByProviders(pkg, policy.allowedProviders);
  const counter = { n: 0 };
  const filtered = filterForSync(pkg, policy, counter);
  const hash = contentHash(filtered);

  const envelope = {
    magic: MAGIC,
    schemaVersion: SCHEMA_VERSION,
    mode: mode,
    meta: { contentHash: hash, parent: meta.contentHash || null, updatedAt: nowFn(opts)(), ref: gitHead(projectPath, opts) },
    policy: policy,
    pkg: filtered,
  };
  const json = JSON.stringify(envelope);

  if (mode === 'encrypted') {
    if (!opts.passphrase) throw new Error('encrypted mode requires a passphrase (--passphrase-file)');
    return { mode: mode, encrypted: true, contentHash: hash, redactions: counter.n, payload: require('./sync').encrypt(json, opts.passphrase) };
  }
  return { mode: mode, encrypted: false, contentHash: hash, redactions: counter.n, payload: json };
}

// ---- import ------------------------------------------------------------------
function validateEnvelope(env) {
  if (!env || typeof env !== 'object') throw new Error('not a keyflip context-sync payload');
  if (env.magic !== MAGIC) throw new Error('not a keyflip context-sync payload');
  if (env.schemaVersion !== SCHEMA_VERSION) throw new Error('unsupported context-sync schema v' + String(env.schemaVersion));
  if (MODES.indexOf(env.mode) === -1) throw new Error('payload has an unknown mode "' + String(env.mode) + '"');
  if (!env.meta || typeof env.meta !== 'object' || typeof env.meta.contentHash !== 'string') throw new Error('payload is missing its checkpoint metadata');
  if (!env.pkg || typeof env.pkg !== 'object') throw new Error('payload is missing its context package');
}
// Parse/decrypt + validate a payload into { mode, meta, policy, pkg }. Encrypted payloads (the
// src/sync.js envelope) require opts.passphrase. The package is RE-normalized and RE-scrubbed on
// the way in (never trust a bundle to be clean) and rebuilt without prototype-pollution keys.
function importPackage(payload, opts) {
  opts = opts || {};
  let outer;
  try { outer = JSON.parse(String(payload)); } catch (e) { throw new Error('not a keyflip context-sync payload'); }
  let envelope;
  if (outer && outer.magic === MAGIC) {
    envelope = outer;
  } else if (outer && outer.magic === SYNC_MAGIC) {
    if (!opts.passphrase) throw new Error('this payload is encrypted — a passphrase is required to import it');
    const inner = require('./sync').decrypt(String(payload), opts.passphrase); // throws on wrong passphrase
    try { envelope = JSON.parse(inner); } catch (e) { throw new Error('decrypted payload is not valid JSON'); }
  } else {
    throw new Error('not a keyflip context-sync payload');
  }
  validateEnvelope(envelope);
  const counter = { n: 0 };
  const pkg = scrub(normalizeInputPkg(envelope.pkg), counter);
  return {
    mode: envelope.mode,
    policy: normalizePolicy(envelope.policy),
    meta: {
      contentHash: String(envelope.meta.contentHash),
      parent: envelope.meta.parent != null ? String(envelope.meta.parent) : null,
      updatedAt: envelope.meta.updatedAt != null ? String(envelope.meta.updatedAt) : null,
    },
    pkg: pkg,
    redactions: counter.n,
  };
}

// ---- conflict detection ------------------------------------------------------
function compareTs(a, b) {
  if (!a && !b) return null;
  if (!a) return 'remote';
  if (!b) return 'local';
  if (a === b) return 'same';
  return a > b ? 'local' : 'remote';
}
// Compare two checkpoints ({contentHash, parent, updatedAt}). Same content = no conflict; a
// fast-forward (one side's parent IS the other side's hash) = no conflict; SAME parent but
// DIFFERENT hash = both edited the same base independently = CONFLICT. `newer` (from updatedAt)
// hints which side is more recent for resolution.
function detectConflict(localMeta, remoteMeta) {
  localMeta = localMeta || {};
  remoteMeta = remoteMeta || {};
  const lh = localMeta.contentHash || null, rh = remoteMeta.contentHash || null;
  const lp = localMeta.parent || null, rp = remoteMeta.parent || null;
  const newer = compareTs(localMeta.updatedAt, remoteMeta.updatedAt);
  if (!lh || !rh) return { conflict: false, reason: 'incomplete-checkpoint', newer: newer };
  if (lh === rh) return { conflict: false, reason: 'identical', newer: newer };
  if (lp && lp === rh) return { conflict: false, reason: 'local-ahead', newer: newer };   // remote is an ancestor of local
  if (rp && rp === lh) return { conflict: false, reason: 'remote-ahead', newer: newer };   // local is an ancestor of remote
  if (lp && rp && lp === rp) return { conflict: true, reason: 'diverged-from-common-parent', newer: newer };
  return { conflict: true, reason: (lp || rp) ? 'divergent-history' : 'no-common-parent', newer: newer };
}
// The resolution options a UI/agent can offer when detectConflict reports a conflict.
function resolutions() {
  return [
    { id: 'use-new', label: 'Use the incoming version', description: 'Take the remote context and overwrite the local one.' },
    { id: 'use-old', label: 'Keep the local version', description: 'Discard the incoming context; keep what is on this machine.' },
    { id: 'merge', label: 'Merge both', description: 'Union the non-conflicting context from both sides into one checkpoint.' },
    { id: 'two-branches', label: 'Keep both as branches', description: 'Preserve both checkpoints as separate branches to reconcile later.' },
  ];
}

// ---- read-only summaries -----------------------------------------------------
function status(projectPath, opts) {
  const m = getMode(projectPath, opts);
  return {
    mode: m.mode,
    policy: m.policy,
    checkpoint: { contentHash: m.contentHash, parent: m.parent, updatedAt: m.updatedAt },
    wouldSync: m.mode !== 'local',
    cloudAllowed: m.policy.allowCloudSync,
  };
}
// Dry-run summary for `check`: what WOULD be shared (counts) and how many secrets got scrubbed,
// without emitting anything. Never throws — build errors are reported in the result.
function inspect(projectPath, opts) {
  const m = getMode(projectPath, opts);
  let pkg = null, redactions = 0, error = null;
  try {
    pkg = buildPackage(projectPath, opts);
    if (m.mode === 'company') pkg = filterByProviders(pkg, m.policy.allowedProviders);
    const counter = { n: 0 };
    pkg = filterForSync(pkg, m.policy, counter);
    redactions = counter.n;
  } catch (e) { error = e.message; }
  return {
    mode: m.mode,
    policy: m.policy,
    wouldSync: m.mode !== 'local',
    counts: {
      conversations: pkg ? pkg.conversations.length : 0,
      snippets: pkg ? pkg.snippets.length : 0,
      rules: pkg ? pkg.rules.length : 0,
      envVars: pkg ? pkg.envVars.length : 0,
    },
    secretsRedacted: redactions,
    error: error,
  };
}

// ---- CLI (pure) --------------------------------------------------------------
// Handle `context sync <sub>` and return { code, lines, stdout? } WITHOUT touching process I/O,
// so the cli.js wiring stays a thin printer and this stays unit-testable. `opts` carries the
// resolved projectPath / passphrase / against-payload / clock / runner.
function cli(rest, opts) {
  opts = opts || {};
  rest = rest || [];
  const projectPath = opts.projectPath || process.cwd();
  const lines = [];
  const emit = function (s) { lines.push(s == null ? '' : String(s)); };
  const policyLine = function (p) { return 'policy: raw-conversations=' + p.allowRawConversationSync + ' source-snippets=' + p.allowSourceCodeSnippets + ' cloud=' + p.allowCloudSync + (p.allowedProviders.length ? ' providers=' + p.allowedProviders.join(',') : ''); };
  const sub = rest[0];

  if (sub === undefined || sub === 'status') {
    const s = status(projectPath, opts);
    emit('context-sync mode: ' + s.mode + (s.wouldSync ? '' : '  (nothing syncs — local only)'));
    emit(policyLine(s.policy));
    emit('checkpoint: ' + (s.checkpoint.contentHash ? s.checkpoint.contentHash.slice(0, 12) + (s.checkpoint.parent ? ' (parent ' + s.checkpoint.parent.slice(0, 12) + ')' : '') : '(none yet)'));
    return { code: 0, lines: lines };
  }
  if (sub === 'mode') {
    const target = rest[1];
    if (!target) { emit('context-sync mode: ' + getMode(projectPath, opts).mode); return { code: 0, lines: lines }; }
    if (MODES.indexOf(target) === -1) { emit('unknown mode "' + target + '" (use: ' + MODES.join('|') + ')'); return { code: 1, lines: lines }; }
    const m = setMode(projectPath, target, opts);
    emit('context-sync mode -> ' + m.mode);
    emit(policyLine(m.policy));
    return { code: 0, lines: lines };
  }
  if (sub === 'export') {
    try {
      const r = exportPackage(projectPath, opts);
      emit('# ' + r.mode + ' export' + (r.encrypted ? ' (encrypted)' : '') + ' · ' + r.contentHash.slice(0, 12) + ' · ' + r.redactions + ' secret(s) scrubbed');
      return { code: 0, lines: lines, stdout: r.payload };
    } catch (e) { emit(e.message); return { code: 1, lines: lines }; }
  }
  if (sub === 'check') {
    const ins = inspect(projectPath, opts);
    emit('mode: ' + ins.mode + (ins.wouldSync ? '' : '  (local only — nothing would sync)'));
    emit(policyLine(ins.policy));
    emit('would share: ' + ins.counts.conversations + ' conversation(s), ' + ins.counts.snippets + ' snippet(s), ' + ins.counts.rules + ' rule file(s), ' + ins.counts.envVars + ' env-var name(s)');
    emit(ins.secretsRedacted + ' secret(s) would be scrubbed before sharing');
    if (ins.error) emit('error: ' + ins.error);
    if (opts.against) {
      try {
        const remote = importPackage(opts.against, opts);
        const c = detectConflict(getMode(projectPath, opts), remote.meta);
        emit('conflict vs incoming: ' + (c.conflict ? 'YES' : 'no') + ' (' + c.reason + ')');
        if (c.conflict) resolutions().forEach(function (r) { emit('  - ' + r.id + ': ' + r.label); });
      } catch (e) { emit('could not read the incoming payload: ' + e.message); return { code: 1, lines: lines }; }
    }
    return { code: ins.error ? 1 : 0, lines: lines };
  }
  emit('usage: keyflip context sync <status|mode <' + MODES.join('|') + '>|export --passphrase-file <f>|check>');
  return { code: 1, lines: lines };
}

module.exports = {
  SCHEMA_VERSION: SCHEMA_VERSION,
  MAGIC: MAGIC,
  MODES: MODES,
  DEFAULT_POLICIES: DEFAULT_POLICIES,
  keyflipDir: keyflipDir,
  metaPath: metaPath,
  contextDir: contextDir,
  validateMode: validateMode,
  normalizePolicy: normalizePolicy,
  scrub: scrub,
  normalizeInputPkg: normalizeInputPkg,
  buildPackage: buildPackage,
  getMode: getMode,
  setMode: setMode,
  recordCheckpoint: recordCheckpoint,
  filterForSync: filterForSync,
  filterByProviders: filterByProviders,
  contentHash: contentHash,
  exportPackage: exportPackage,
  importPackage: importPackage,
  detectConflict: detectConflict,
  resolutions: resolutions,
  status: status,
  inspect: inspect,
  cli: cli,
};
