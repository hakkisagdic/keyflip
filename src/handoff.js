'use strict';
// Wave 4 (Context Layer): target-tool-aware CONTINUE-PROMPT generator. When a project moves to a NEW
// AI tool (Kiro → Cursor → Claude Code → opencode → Windsurf), the new tool starts blind. This turns
// the portable `.keyflip/` project memory (context.md + tasks.json + decisions.json + rules/ +
// checkpoints/latest.json) into a single markdown prompt that tells the incoming tool: which tools the
// project moved across, which files to read (instead of re-reading the whole repo), the ACTIVE task
// (done / remaining / known issues), the architecture decisions it must NOT silently change, and a
// target-appropriate closing instruction.
//
// continuePrompt(pkg, opts) is PURE (no IO, no clock, no secrets): pkg is the already-secret-scanned
// context package (from context.pack) and opts.checkpoint is the latest checkpoint (from
// checkpoint.latest). Every emitted text field is STILL defensively re-redacted through secretscan —
// this layer builds a shared, syncable artifact, so a leaked token here would travel to another
// machine/tool. Only env-var NAMES + descriptions are carried, never values. readProject()/handoff()
// do the filesystem read for the CLI + MCP; they alone touch disk.
const fs = require('fs');
const path = require('path');

// ---- known tools -------------------------------------------------------------------------------
// Prototype-pollution safe: these maps are keyed by tool/provider ids that can originate from a
// synced package or a CLI/MCP argument, so they must have a null prototype.
const PROVIDER_LABELS = Object.assign(Object.create(null), {
  claude: 'Claude Code', cursor: 'Cursor', kiro: 'Kiro', opencode: 'opencode',
  windsurf: 'Windsurf', gemini: 'Gemini CLI', copilot: 'GitHub Copilot',
  codex: 'Codex CLI', aider: 'Aider', generic: 'your AI tool',
});
const TARGETS = ['claude', 'cursor', 'kiro', 'opencode', 'windsurf', 'generic'];
// Per-target phrasing. `rulesHint` names where THIS tool expects its rules (re-emitted from
// .keyflip/rules/); `closing` is the final "how to proceed" instruction in the tool's own voice.
const VARIANTS = Object.assign(Object.create(null), {
  claude: {
    id: 'claude', label: 'Claude Code',
    rulesHint: '`CLAUDE.md` at the repo root and `.keyflip/rules/`',
    closing: 'You are Claude Code. Load CLAUDE.md, adopt the ACTIVE task and the locked decisions above, and continue from where the last tool stopped — do NOT re-read the whole repository or re-litigate settled decisions. If a decision blocks you, explain the trade-off to the user before changing it.',
  },
  cursor: {
    id: 'cursor', label: 'Cursor',
    rulesHint: '`.cursor/rules/` (re-emitted from `.keyflip/rules/`)',
    closing: 'You are Cursor. Apply the project rules, pick up the ACTIVE task, and respect the locked decisions. Keep edits scoped to the remaining items and surface — do not silently change — any decision you need to revisit.',
  },
  kiro: {
    id: 'kiro', label: 'Kiro',
    rulesHint: 'the steering docs under `.kiro/steering/` (from `.keyflip/rules/`)',
    closing: 'You are Kiro. Treat the decisions below as steering constraints, resume the ACTIVE task from where it stopped, and flag — never silently rewrite — any locked decision.',
  },
  opencode: {
    id: 'opencode', label: 'opencode',
    rulesHint: '`AGENTS.md` (from `.keyflip/rules/`)',
    closing: 'You are opencode. Read AGENTS.md and the context, take the ACTIVE task\'s remaining items, and hold the locked decisions unless the user agrees to change one.',
  },
  windsurf: {
    id: 'windsurf', label: 'Windsurf',
    rulesHint: '`.windsurf/rules/` (from `.keyflip/rules/`)',
    closing: 'You are Windsurf. Load the workspace rules, continue the ACTIVE task, and keep the locked decisions intact unless you first justify a change to the user.',
  },
  generic: {
    id: 'generic', label: 'your AI tool',
    rulesHint: 'the files under `.keyflip/rules/`',
    closing: 'Continue from the ACTIVE task above using the referenced files. Follow the project rules, keep the locked decisions unless you explain why one must change, and do NOT restart the project from scratch.',
  },
});

// The canonical portable-memory files an incoming tool should read (relative to the project root).
const DEFAULT_FILES = [
  { path: '.keyflip/context.md', note: 'project overview & architecture' },
  { path: '.keyflip/tasks.json', note: 'current task list & status' },
  { path: '.keyflip/decisions.json', note: 'locked architecture decisions (with rationale)' },
  { path: '.keyflip/rules/', note: 'coding rules to follow' },
  { path: '.keyflip/checkpoints/latest.json', note: 'last session checkpoint (branch, dirty files, summary)' },
];

// ---- small pure helpers ------------------------------------------------------------------------
function str(x) { return x == null ? '' : String(x); }
function clip(s, n) { s = str(s).replace(/\r/g, ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }
function asArray(x) { return Array.isArray(x) ? x : (x == null ? [] : [x]); }
function firstDefined() { for (let i = 0; i < arguments.length; i++) if (arguments[i] != null && arguments[i] !== '') return arguments[i]; return undefined; }

// Coerce a list ITEM (string | { text|title|name|label|summary } | anything) into one clean line.
function lineOf(item) {
  if (item == null) return '';
  if (typeof item === 'string') return item.replace(/\s+/g, ' ').trim();
  if (typeof item === 'object') {
    const v = firstDefined(item.text, item.title, item.name, item.label, item.summary, item.description);
    if (v != null) return lineOf(v);
    try { return JSON.stringify(item); } catch (e) { return ''; }
  }
  return str(item).trim();
}

// Defensive secret redaction over an arbitrary prose field. The package is already scanned, but this
// is a SHARED, SYNCABLE artifact — a token that slipped through upstream must never be emitted here.
// Two passes: line-based (KEY=secret / key: value config lines) then a token-shape sweep anywhere in
// the text. `scan` is injectable so tests can assert against the real module. NEVER logs the input.
function redactText(s, scan) {
  scan = scan || require('./secretscan');
  let out = str(s);
  if (!out) return '';
  try { out = scan.redactLines(out).text; } catch (e) { /* line pass is best-effort */ }
  const pats = scan.SECRET_PATTERNS || [];
  for (let i = 0; i < pats.length; i++) {
    try { out = out.replace(new RegExp(pats[i].re.source, 'g'), scan.REDACTED); } catch (e) { /* skip a bad pattern */ }
  }
  return out;
}
// Redact + collapse + clip in one step (list lines / titles).
function safeLine(x, scan, max) { return clip(redactText(lineOf(x), scan), max || 500); }

// ---- extraction (tolerant of several upstream field shapes) ------------------------------------
function normalizeTarget(t) {
  let s = str(t).toLowerCase().trim();
  if (s === 'claude-code' || s === 'claudecode' || s === 'claude_code' || s === 'cc') s = 'claude';
  if (s === 'oc') s = 'opencode';
  if (Object.prototype.hasOwnProperty.call(VARIANTS, s)) return s;
  return 'generic';
}

// Per-target phrasing (a frozen copy so a caller can't mutate the shared table).
function targetVariants(target) {
  return Object.freeze(Object.assign({}, VARIANTS[normalizeTarget(target)]));
}

function providerLabel(id) {
  const k = str(id).toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, k)) return PROVIDER_LABELS[k];
  // Unknown ids can be package/argument supplied — redact + cap before showing.
  return clip(redactText(k, null).replace(/[`\n]/g, ''), 40) || 'unknown';
}

function projectName(pkg, scan) {
  const p = (pkg && pkg.project) || {};
  return safeLine(firstDefined(p.name, pkg && pkg.name, p.title), scan, 120) || 'this project';
}

// The ordered list of tools the project has moved across + the most recent one. Sources (in order
// of trust): the checkpoint's own history, then the package's, then a single lastProvider/current.
function providerTrail(pkg, checkpoint) {
  pkg = pkg || {}; checkpoint = checkpoint || {};
  const proj = pkg.project || {};
  const raw = []
    .concat(asArray(checkpoint.providers), asArray(checkpoint.history), asArray(checkpoint.trail))
    .concat(asArray(pkg.providers), asArray(proj.providers), asArray(pkg.toolHistory))
    .map(function (x) { return str(typeof x === 'object' && x ? firstDefined(x.provider, x.tool, x.id, x.name) : x).toLowerCase().trim(); })
    .filter(Boolean);
  const last = str(firstDefined(
    checkpoint.provider, checkpoint.tool, checkpoint.lastProvider,
    pkg.lastProvider, proj.lastProvider, proj.currentProvider, raw[raw.length - 1]
  )).toLowerCase().trim();
  if (last) raw.push(last);
  const seen = Object.create(null); const trail = [];
  raw.forEach(function (id) { if (id && !seen[id]) { seen[id] = 1; trail.push(id); } });
  return { trail: trail, last: last || (trail.length ? trail[trail.length - 1] : '') };
}

// The single ACTIVE task, normalized to { title, completed[], remaining[], knownIssues[] } or null.
function activeTask(pkg, checkpoint) {
  pkg = pkg || {}; checkpoint = checkpoint || {};
  let t = checkpoint.task || null;
  const tasks = pkg.tasks;
  if (!t && tasks) {
    if (Array.isArray(tasks)) {
      t = tasks.find(function (x) { return x && /^(active|in[_-]?progress|current|doing|wip)$/i.test(str(x.status || x.state)); })
        || tasks.find(function (x) { return x && (x.active === true); }) || tasks[0] || null;
    } else if (typeof tasks === 'object') {
      t = tasks.active || tasks.current || (Array.isArray(tasks.list) ? tasks.list[0] : null) || null;
    }
  }
  if (!t || typeof t !== 'object') return null;
  return {
    title: firstDefined(t.title, t.name, t.summary, t.text, 'Active task'),
    completed: asArray(firstDefined(t.completed, t.done, t.doneItems, [])),
    remaining: asArray(firstDefined(t.remaining, t.todo, t.next, t.remainingItems, t.steps, [])),
    knownIssues: asArray(firstDefined(t.knownIssues, t.issues, t.blockers, t.watchOut, t.risks, [])),
  };
}

// Locked architecture decisions → [{ title, decision, rationale }].
function collectDecisions(pkg) {
  pkg = pkg || {};
  let list = pkg.decisions;
  if (list && !Array.isArray(list) && Array.isArray(list.decisions)) list = list.decisions;
  return asArray(list).map(function (d) {
    if (typeof d === 'string') return { title: '', decision: d, rationale: '' };
    d = d || {};
    return {
      title: firstDefined(d.title, d.name, d.id, d.summary, ''),
      decision: firstDefined(d.decision, d.what, d.text, d.summary, d.title, ''),
      rationale: firstDefined(d.rationale, d.why, d.reason, d.because, ''),
    };
  }).filter(function (d) { return lineOf(d.decision) || lineOf(d.title); });
}

// Env is carried as NAMES + descriptions ONLY — never values. Drop anything value-shaped defensively.
function collectEnv(pkg) {
  pkg = pkg || {};
  const src = firstDefined(pkg.env, pkg.envVars, (pkg.project && pkg.project.env), []);
  return asArray(src).map(function (e) {
    if (typeof e === 'string') return { name: e, description: '' };
    e = e || {};
    return { name: firstDefined(e.name, e.key, e.var, ''), description: firstDefined(e.description, e.desc, e.note, '') };
  }).filter(function (e) { return lineOf(e.name); });
}

// ---- the prompt (PURE) -------------------------------------------------------------------------
/**
 * Build a target-tool-aware CONTINUE-PROMPT (markdown) from a context package.
 * @param {object} pkg  context package from context.pack (already secret-scanned).
 * @param {object} [opts]
 * @param {object} [opts.checkpoint]  latest checkpoint from checkpoint.latest.
 * @param {('claude'|'cursor'|'kiro'|'opencode'|'windsurf'|'generic')} [opts.target='generic']
 * @param {function} [opts.now]  injected ISO clock () => string (for a deterministic timestamp).
 * @param {object} [opts.secretscan]  injected redactor (defaults to require('./secretscan')).
 * @returns {string} markdown prompt (no IO, no secrets).
 */
function continuePrompt(pkg, opts) {
  opts = opts || {};
  pkg = pkg || {};
  const scan = opts.secretscan || require('./secretscan');
  const v = VARIANTS[normalizeTarget(opts.target)];
  const cp = opts.checkpoint || null;
  const name = projectName(pkg, scan);
  const trailInfo = providerTrail(pkg, cp);
  const L = []; // output lines

  L.push('# Continue this project — ' + name);
  L.push('');
  L.push('> Portable project memory generated by keyflip. You are picking up work that moved between AI tools — do NOT start over or re-read the whole codebase.');
  L.push('');

  // Who / where.
  L.push('**You are now:** ' + v.label);
  if (trailInfo.trail.length > 1) {
    L.push('**This project has moved across:** ' + trailInfo.trail.map(providerLabel).join(' → '));
  } else if (trailInfo.trail.length === 1) {
    L.push('**Recorded tool for this project:** ' + providerLabel(trailInfo.trail[0]) + ' _(first hand-off)_');
  }
  if (trailInfo.last) {
    const at = cp && cp.at ? ' _(checkpoint ' + safeLine(cp.at, scan, 40) + ')_' : '';
    L.push('**Last active in:** ' + providerLabel(trailInfo.last) + at);
  }
  const branch = cp && firstDefined(cp.branch, cp.gitBranch);
  const commit = cp && firstDefined(cp.commit, cp.gitCommit, cp.sha);
  if (branch || commit) {
    L.push('**Git state at last checkpoint:** ' + [branch ? 'branch `' + safeLine(branch, scan, 80) + '`' : '', commit ? 'commit `' + safeLine(commit, scan, 40) + '`' : ''].filter(Boolean).join(', '));
  }
  L.push('');

  // Optional one-paragraph orientation (never a substitute for reading context.md).
  const summary = firstDefined(pkg.summary, pkg.project && pkg.project.description, cp && cp.summary);
  if (summary) {
    L.push('## Summary');
    L.push(clip(redactText(lineOf(summary), scan), 1200));
    L.push('');
  }

  // 1. Files to read.
  L.push('## 1. Read these first (instead of re-reading the repo)');
  L.push('The portable memory lives in `.keyflip/`. Read, in order:');
  const files = Array.isArray(pkg.files) && pkg.files.length
    ? pkg.files.map(function (f) { return typeof f === 'string' ? { path: f, note: '' } : { path: firstDefined(f && f.path, f && f.name, ''), note: firstDefined(f && f.note, f && f.description, '') }; }).filter(function (f) { return f.path; })
    : DEFAULT_FILES;
  files.forEach(function (f) {
    const p = safeLine(f.path, scan, 200);
    const note = f.note ? ' — ' + safeLine(f.note, scan, 160) : '';
    L.push('- `' + p + '`' + note);
  });
  L.push('- Your own rules: ' + v.rulesHint + '.');
  L.push('');

  // 2. Active task.
  L.push('## 2. Active task');
  const task = activeTask(pkg, cp);
  if (task) {
    L.push('### ' + safeLine(task.title, scan, 200));
    const done = task.completed.map(function (x) { return safeLine(x, scan); }).filter(Boolean);
    const rem = task.remaining.map(function (x) { return safeLine(x, scan); }).filter(Boolean);
    const iss = task.knownIssues.map(function (x) { return safeLine(x, scan); }).filter(Boolean);
    if (done.length) { L.push(''); L.push('**Done so far:**'); done.forEach(function (x) { L.push('- [x] ' + x); }); }
    if (rem.length) { L.push(''); L.push('**Remaining:**'); rem.forEach(function (x) { L.push('- [ ] ' + x); }); }
    else if (!done.length) { L.push(''); L.push('_No sub-items recorded — see `.keyflip/tasks.json`._'); }
    if (iss.length) { L.push(''); L.push('**Known issues / watch out:**'); iss.forEach(function (x) { L.push('- ' + x); }); }
  } else {
    L.push('_No active task recorded. Read `.keyflip/tasks.json` and ask the user what to pick up._');
  }
  L.push('');

  // 3. Locked decisions.
  L.push('## 3. Architecture decisions — do NOT change these without explaining why');
  const decisions = collectDecisions(pkg);
  if (decisions.length) {
    L.push('These were decided deliberately. If you need to change one, STOP and explain the trade-off to the user first.');
    decisions.forEach(function (d) {
      const title = safeLine(d.title, scan, 160);
      const what = safeLine(d.decision, scan, 600);
      const why = safeLine(d.rationale, scan, 600);
      let line = '- ' + (title ? '**' + title + '**: ' : '') + what;
      if (why) line += ' _(why: ' + why + ')_';
      L.push(line);
    });
  } else {
    L.push('_No locked decisions recorded yet — read `.keyflip/decisions.json` before making structural changes._');
  }
  L.push('');

  // 4. Environment (names only).
  const env = collectEnv(pkg);
  if (env.length) {
    L.push('## 4. Environment variables (NAMES only — values are NOT carried; set them locally)');
    env.forEach(function (e) {
      const n = safeLine(e.name, scan, 120);
      const d = e.description ? ' — ' + safeLine(e.description, scan, 200) : '';
      L.push('- `' + n + '`' + d);
    });
    L.push('');
  }

  // 5. Closing (target-specific).
  L.push('## ' + (env.length ? '5' : '4') + '. How to proceed (' + v.label + ')');
  L.push(v.closing);
  L.push('');

  const stamp = (typeof opts.now === 'function' && opts.now()) || pkg.generatedAt || (cp && cp.at) || null;
  L.push('---');
  L.push('_Generated by keyflip context layer' + (stamp ? ' · ' + safeLine(stamp, scan, 40) : '') + ' · target: ' + v.id + '._');

  return L.join('\n') + '\n';
}

// ---- filesystem read for CLI + MCP -------------------------------------------------------------
function readJsonSafe(p) {
  let raw; try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function readTextSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; }
}
function listRules(dir) {
  const out = [];
  (function walk(d, depth) {
    if (depth > 4) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (let i = 0; i < ents.length && out.length < 200; i++) {
      const p = path.join(d, ents[i].name);
      if (ents[i].isDirectory()) walk(p, depth + 1);
      else if (ents[i].isFile()) out.push(p);
    }
  })(dir, 0);
  return out;
}

// Read a project's `.keyflip/` into { pkg, checkpoint, files } for continuePrompt(). Tolerant: every
// file is optional (guarded parse), so a half-initialized project still yields a useful prompt.
function readProject(projectPath, opts) {
  opts = opts || {};
  const root = path.resolve(projectPath || process.cwd());
  const base = path.join(root, '.keyflip');
  const project = readJsonSafe(path.join(base, 'project.json')) || {};
  const context = readTextSafe(path.join(base, 'context.md'));
  const decisions = readJsonSafe(path.join(base, 'decisions.json'));
  const tasks = readJsonSafe(path.join(base, 'tasks.json'));
  const env = readJsonSafe(path.join(base, 'env.json'));
  const checkpoint = readJsonSafe(path.join(base, 'checkpoints', 'latest.json'));
  const rulesFiles = listRules(path.join(base, 'rules'));
  const present = [];
  DEFAULT_FILES.forEach(function (f) {
    const abs = path.join(root, f.path);
    let ok = false; try { ok = fs.existsSync(abs); } catch (e) { ok = false; }
    if (ok) present.push(f.path);
  });
  const pkg = {
    schema: project.schema || 1,
    project: project,
    name: project.name,
    summary: firstDefined(project.summary, project.description),
    context: context,
    decisions: decisions,
    tasks: tasks,
    env: firstDefined(env, project.env),
    providers: firstDefined(project.providers, project.toolHistory),
    lastProvider: firstDefined(project.lastProvider, project.currentProvider),
    rules: rulesFiles.map(function (p) { return path.relative(root, p); }),
    generatedAt: project.generatedAt,
  };
  return { pkg: pkg, checkpoint: checkpoint, files: present, root: root };
}

// Convenience for the CLI/MCP: read `.keyflip/` and render the continue-prompt in one call.
// Returns { text, target, providers, last, files, project }.
function handoff(projectPath, opts) {
  opts = opts || {};
  const loaded = readProject(projectPath, opts);
  const target = normalizeTarget(firstDefined(opts.target, opts.to, 'generic'));
  const text = continuePrompt(loaded.pkg, {
    checkpoint: loaded.checkpoint, target: target, now: opts.now, secretscan: opts.secretscan,
  });
  const trail = providerTrail(loaded.pkg, loaded.checkpoint);
  return {
    text: text, target: target, providers: trail.trail, last: trail.last,
    files: loaded.files, project: projectName(loaded.pkg, opts.secretscan),
  };
}

// ---- self-contained MCP tool (read-only) -------------------------------------------------------
const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const mcpTools = [
  {
    name: 'keyflip_handoff',
    title: 'Generate a CONTINUE-PROMPT to resume this project in another AI tool',
    description: 'Turn the portable `.keyflip/` project memory (context.md, tasks.json, decisions.json, rules/, checkpoints/latest.json) into a single markdown CONTINUE-PROMPT so a NEW AI tool can resume work WITHOUT re-reading the whole codebase. It states which tools the project moved across, the files to read, the active task (done/remaining/known issues), the locked architecture decisions, and a target-appropriate closing instruction. `to` tailors the phrasing (claude|cursor|kiro|opencode|windsurf|generic). Read-only: reads .keyflip/ and returns the prompt text; carries only env-var NAMES, never secret values.',
    inputSchema: { type: 'object', properties: {
      to: { type: 'string', enum: TARGETS, description: 'Target AI tool the prompt is written FOR (default generic).' },
      projectPath: { type: 'string', description: 'Project root holding .keyflip/ (default: server cwd).' },
    }, additionalProperties: false },
    annotations: RO,
    run: async function (ctx, args) {
      const r = handoff((args && args.projectPath) || process.cwd(), { target: args && args.to, now: ctx && ctx.now });
      return { target: r.target, providers: r.providers, last: r.last, files: r.files, project: r.project, prompt: r.text };
    },
  },
];

module.exports = {
  continuePrompt: continuePrompt,
  targetVariants: targetVariants,
  providerTrail: providerTrail,
  activeTask: activeTask,
  collectDecisions: collectDecisions,
  collectEnv: collectEnv,
  redactText: redactText,
  normalizeTarget: normalizeTarget,
  readProject: readProject,
  handoff: handoff,
  mcpTools: mcpTools,
  TARGETS: TARGETS,
  DEFAULT_FILES: DEFAULT_FILES,
  PROVIDER_LABELS: PROVIDER_LABELS,
};
