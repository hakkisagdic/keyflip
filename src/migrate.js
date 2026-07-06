'use strict';
// Cross-machine migration. Bundle EVERYTHING portable — saved accounts (secrets),
// providers (with keys), and every Claude Code session transcript — into one file,
// and MERGE it into another machine. The merge is a UNION: it never clobbers a
// transcript or account that already exists on the target (unless --force), so you
// can carry your sessions to a new machine and combine them with whatever is
// already there.
//
// NOT portable (machine-bound, re-captured on the target — we say so): the
// desktop-app login (safeStorage key) and browser cookie snapshots (browser Safe
// Storage key). Accounts + transcripts + providers are what actually move.
const fs = require('fs');
const path = require('path');
const transfer = require('./transfer');
const provider = require('./provider');
const fsutil = require('./fsutil');

const FORMAT = 'keyflip-migrate';

// A memory rel path is legitimate only where collectMemory produces one: a top-level
// markdown/text file (CLAUDE.md, RTK.md, MEMORY.md…) OR anything under a project's
// memory dir. This blocks a hostile bundle from landing e.g. `settings.json` or a
// dotfile at the ~/.claude root via the memory merge.
function isMemoryRel(rel) {
  const norm = String(rel).split(path.sep).join('/');
  if (norm.indexOf('..') !== -1) return false;
  if (/^[^/]+\.(md|mdc|txt)$/i.test(norm)) return true;
  if (/^projects\/[^/]+\/memory\/[^\0]+$/.test(norm)) return true;
  return false;
}
const VERSION = 1;
const PROVIDER_KEY = function (name) { return 'provider__' + name; };

function projectsDir(ctx) { return path.join(ctx.claudeDir, 'projects'); }

// A single path segment that must stay under projects/ — reject traversal from an
// untrusted bundle (no separators, no '..', no NUL).
function isSafeSegment(s) {
  return typeof s === 'string' && s.length > 0 &&
    s.indexOf('/') === -1 && s.indexOf('\\') === -1 && s.indexOf('\0') === -1 &&
    s.indexOf(':') === -1 && // Windows drive letter / NTFS alternate-data-stream
    s !== '..' && s !== '.';
}

// Collect every Claude Code transcript as { project, sessionId, content }.
function collectTranscripts(ctx) {
  const out = [];
  const root = projectsDir(ctx);
  let projects;
  try { projects = fs.readdirSync(root); } catch (e) { return out; }
  projects.forEach(function (proj) {
    const dir = path.join(root, proj);
    let stat; try { stat = fs.statSync(dir); } catch (e) { return; }
    if (!stat.isDirectory()) return;
    let files; try { files = fs.readdirSync(dir); } catch (e) { return; }
    files.forEach(function (f) {
      if (f.slice(-6) !== '.jsonl') return;
      const sessionId = f.slice(0, -6);
      let content; try { content = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { return; }
      out.push({ project: proj, sessionId: sessionId, content: content });
    });
  });
  return out;
}

// E2: select a SUBSET of transcripts for a partial bundle — by session id/prefix, content
// search, or age. No filter set → all of them (collectTranscripts). Filters compose (AND).
function collectTranscriptsFiltered(ctx, opts) {
  opts = opts || {};
  const ids = (opts.sessions && opts.sessions.length) ? opts.sessions : null;
  const hasFilter = ids || opts.search || opts.newerThanDays || opts.olderThanDays;
  if (!hasFilter) return collectTranscripts(ctx);
  const sessions = require('./sessions');
  const now = opts.now || Date.now();
  const rows = sessions.list(ctx, { search: opts.search, limit: 100000 }).filter(function (r) {
    if (ids && !ids.some(function (p) { return r.sessionId === p || r.sessionId.indexOf(p) === 0; })) return false;
    if (opts.newerThanDays && r.mtimeMs < now - opts.newerThanDays * 86400000) return false;
    if (opts.olderThanDays && r.mtimeMs >= now - opts.olderThanDays * 86400000) return false;
    return true;
  });
  const out = [];
  rows.forEach(function (r) {
    let content; try { content = fs.readFileSync(r.file, 'utf8'); } catch (e) { return; }
    out.push({ project: r.project, sessionId: r.sessionId, content: content });
  });
  return out;
}

function claudeDir(ctx) { return ctx.claudeDir || path.join(ctx.home, '.claude'); }

// Enumerate files under a dir (bounded), returning absolute paths.
function walkFiles(dir, budget) {
  const out = []; let left = budget || 300;
  (function rec(d) {
    if (left <= 0) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (let i = 0; i < ents.length && left > 0; i++) {
      const p = path.join(d, ents[i].name);
      if (ents[i].isDirectory()) rec(p);
      else if (ents[i].isFile()) { out.push(p); left--; }
    }
  })(dir);
  return out;
}

// Collect user MEMORY + instruction files (markdown/text — no secrets): ~/.claude/*.md
// (CLAUDE.md, RTK.md, …) and every projects/*/memory/** file. Returns [{ rel, content }]
// with rel relative to ~/.claude. This is what "carry my memories across machines" moves.
function collectMemory(ctx) {
  const root = claudeDir(ctx);
  const out = [];
  const push = function (abs) {
    let content; try { content = fs.readFileSync(abs, 'utf8'); } catch (e) { return; }
    out.push({ rel: path.relative(root, abs), content: content });
  };
  let top; try { top = fs.readdirSync(root); } catch (e) { top = []; }
  top.forEach(function (f) { if (f.slice(-3) === '.md') { try { if (fs.statSync(path.join(root, f)).isFile()) push(path.join(root, f)); } catch (e) { /* ignore */ } } });
  const proj = path.join(root, 'projects');
  let dirs; try { dirs = fs.readdirSync(proj); } catch (e) { dirs = []; }
  dirs.forEach(function (d) { walkFiles(path.join(proj, d, 'memory'), 200).forEach(push); });
  return out;
}

// UNION-merge memory/instruction files under ~/.claude. Never clobber unless force; a
// bundle entry that would escape ~/.claude is skipped (path-traversal guard).
function mergeMemory(ctx, list, opts) {
  opts = opts || {};
  const root = claudeDir(ctx);
  let added = 0, kept = 0, overwritten = 0, skipped = 0;
  (list || []).forEach(function (m) {
    if (!m || typeof m.content !== 'string' || typeof m.rel !== 'string') { skipped++; return; }
    if (!isMemoryRel(m.rel)) { skipped++; return; } // only legitimate memory locations (no config injection)
    const dest = path.resolve(root, m.rel);
    if (!fsutil.safeDestUnder(root, dest).ok) { skipped++; return; } // lexical + symlink escape guard
    const exists = fs.existsSync(dest);
    if (exists && !opts.force) { kept++; return; }
    try { fsutil.atomicWrite(dest, m.content); if (exists) overwritten++; else added++; }
    catch (e) { skipped++; }
  });
  return { added: added, kept: kept, overwritten: overwritten, skipped: skipped, total: (list || []).length };
}

function readFileOrNull(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }

// J2/J3: portable CONFIG that makes a new machine ready — keyflip's MCP registry
// (command/args/env per server; env may hold secrets, so the bundle must be encrypted),
// Claude Code's settings.json/settings.local.json, and Claude Desktop's MCP config.
function collectConfig(ctx) {
  const cfg = {};
  const reg = readFileOrNull(path.join(ctx.configDir, 'mcp-registry.json')); if (reg) cfg.mcpRegistry = reg;
  const cd = claudeDir(ctx);
  const s = readFileOrNull(path.join(cd, 'settings.json')); if (s) cfg.claudeSettings = s;
  const sl = readFileOrNull(path.join(cd, 'settings.local.json')); if (sl) cfg.claudeSettingsLocal = sl;
  if (ctx.appDataDir) { const dc = readFileOrNull(path.join(ctx.appDataDir, 'claude_desktop_config.json')); if (dc) cfg.desktopMcp = dc; }
  return cfg;
}

// Merge config into the target: settings files are union (kept unless --force); the MCP
// registry is merged SERVER-BY-SERVER (add new servers, keep existing unless --force).
function mergeConfig(ctx, config, opts) {
  opts = opts || {};
  config = config || {};
  const out = { written: [], kept: [] };
  const put = function (abs, content, label) {
    if (content == null) return;
    if (!fsutil.safeDestUnder(path.dirname(abs), abs).ok) return; // never follow a symlinked config leaf
    const exists = fs.existsSync(abs);
    if (exists && !opts.force) { out.kept.push(label); return; }
    try { fsutil.atomicWrite(abs, content, 0o600); out.written.push(label); }
    catch (e) { /* skip */ }
  };
  if (config.mcpRegistry != null) {
    const dest = path.join(ctx.configDir, 'mcp-registry.json');
    let merged = {}; try { merged = JSON.parse(fs.readFileSync(dest, 'utf8')) || {}; } catch (e) { merged = {}; }
    let incoming = {}; try { incoming = JSON.parse(config.mcpRegistry) || {}; } catch (e) { incoming = {}; }
    let added = 0;
    Object.keys(incoming).forEach(function (k) { if (!merged[k] || opts.force) { merged[k] = incoming[k]; added++; } });
    if (added && fsutil.safeDestUnder(path.dirname(dest), dest).ok) { try { fsutil.atomicWrite(dest, JSON.stringify(merged, null, 2), 0o600); out.written.push('mcp-registry(+' + added + ')'); } catch (e) { /* skip */ } }
    else out.kept.push('mcp-registry');
  }
  const cd = claudeDir(ctx);
  put(path.join(cd, 'settings.json'), config.claudeSettings, 'claude-settings');
  put(path.join(cd, 'settings.local.json'), config.claudeSettingsLocal, 'claude-settings-local');
  if (ctx.appDataDir) put(path.join(ctx.appDataDir, 'claude_desktop_config.json'), config.desktopMcp, 'desktop-mcp');
  return out;
}

// Collect providers with their stored key (SECRET — the bundle carries it).
function collectProviders(ctx) {
  return provider.list(ctx).map(function (name) {
    const meta = provider.read(ctx, name) || {};
    let key = null;
    try { key = ctx.store.getProfile(PROVIDER_KEY(name)); } catch (e) { key = null; }
    return { name: name, meta: meta, key: key };
  });
}

// Assemble the portable bundle. Returns { bundle, skippedAccounts, counts }.
function buildBundle(ctx, opts) {
  opts = opts || {};
  const ex = transfer.buildExport(ctx);
  const accounts = opts.noAccounts ? [] : ex.envelope.accounts;                 // E2: --only-* filters
  const transcripts = opts.noSessions ? [] : collectTranscriptsFiltered(ctx, opts);
  const providers = opts.noProviders ? [] : collectProviders(ctx);
  const memory = opts.noMemory ? [] : collectMemory(ctx);
  const config = opts.noConfig ? {} : collectConfig(ctx);
  const agents = opts.agents ? require('./agents').collectAgentMemory(ctx, { only: opts.agentIds }) : []; // J1: opt-in
  const agentConfig = opts.agentConfig ? require('./agents').collectAgentConfig(ctx, { only: opts.agentIds }) : []; // J1 config-tier (redacted)
  const bundle = {
    format: FORMAT,
    version: VERSION,
    exportedAt: ctx.now(),
    accounts: accounts,
    providers: providers,
    transcripts: transcripts,
    memory: memory,
    config: config,
    agents: agents,
    agentConfig: agentConfig,
  };
  return {
    bundle: bundle,
    skippedAccounts: opts.noAccounts ? [] : ex.skipped,
    counts: { accounts: accounts.length, providers: providers.length, transcripts: transcripts.length, memory: memory.length, config: Object.keys(config).length, agents: agents.length, agentConfig: agentConfig.length },
  };
}

// UNION-merge transcripts into ~/.claude/projects. Never clobber an existing file
// unless force. This is the MERGE with the target machine's own sessions.
function mergeTranscripts(ctx, list, opts) {
  opts = opts || {};
  const root = projectsDir(ctx);
  let added = 0, kept = 0, overwritten = 0, skipped = 0;
  (list || []).forEach(function (t) {
    if (!t || typeof t.content !== 'string' || !isSafeSegment(t.project) || !isSafeSegment(t.sessionId)) { skipped++; return; }
    const dir = path.join(root, t.project);
    const file = path.join(dir, t.sessionId + '.jsonl');
    if (!fsutil.safeDestUnder(root, file).ok) { skipped++; return; } // symlinked-project-dir escape guard
    const exists = fs.existsSync(file);
    if (exists && !opts.force) { kept++; return; }
    try {
      fsutil.atomicWrite(file, t.content);
      if (exists) overwritten++; else added++;
    } catch (e) { skipped++; }
  });
  return { added: added, kept: kept, overwritten: overwritten, skipped: skipped, total: (list || []).length };
}

// Apply a bundle: union-merge accounts (via transfer), providers, and transcripts.
// Validates the bundle envelope first; account validation is transfer's.
function applyBundle(ctx, bundle, opts) {
  opts = opts || {};
  if (!bundle || bundle.format !== FORMAT) throw new Error('not a keyflip migrate bundle');
  if (bundle.version !== VERSION) throw new Error('unsupported migrate bundle version ' + bundle.version + ' (this keyflip understands v' + VERSION + ')');

  // Accounts: reuse transfer.applyImport's union semantics + validation by wrapping
  // them in an export envelope. Empty is allowed for a sessions-only migration.
  // transfer.applyImport validates ALL accounts up-front and throws on any bad one; a
  // single corrupt account must NOT abort the provider + transcript merge, so on a
  // whole-batch failure we retry account-by-account and skip only the bad ones.
  let accounts = { imported: [], skipped: [] };
  if (Array.isArray(bundle.accounts) && bundle.accounts.length) {
    try {
      accounts = transfer.applyImport(ctx, {
        format: transfer.FORMAT, version: transfer.VERSION, accounts: bundle.accounts,
      }, { force: opts.force });
    } catch (e) {
      bundle.accounts.forEach(function (a) {
        try {
          const r = transfer.applyImport(ctx, { format: transfer.FORMAT, version: transfer.VERSION, accounts: [a] }, { force: opts.force });
          accounts.imported.push.apply(accounts.imported, r.imported);
          accounts.skipped.push.apply(accounts.skipped, r.skipped);
        } catch (e2) { accounts.skipped.push((a && a.name) || '(invalid account)'); }
      });
    }
  }

  // Providers: add-or-skip (union); overwrite only with force.
  const providers = { imported: [], skipped: [] };
  (bundle.providers || []).forEach(function (p) {
    if (!p || !p.name || !p.meta || !p.meta.baseUrl) { return; }
    if (provider.exists(ctx, p.name) && !opts.force) { providers.skipped.push(p.name); return; }
    try {
      provider.add(ctx, p.name, {
        baseUrl: p.meta.baseUrl,
        authScheme: p.meta.authScheme,
        models: p.meta.models,
        endpointCandidates: p.meta.endpointCandidates,
        key: p.key || undefined,
      });
      providers.imported.push(p.name);
    } catch (e) { providers.skipped.push(p.name); }
  });

  // Transcripts: the actual session MERGE.
  const transcripts = mergeTranscripts(ctx, bundle.transcripts, opts);
  // Memory + instruction files (union-merge under ~/.claude).
  const memory = mergeMemory(ctx, bundle.memory, opts);
  // Portable config (MCP registry + Claude/Desktop settings).
  const config = mergeConfig(ctx, bundle.config, opts);
  // J1: other agents' home-level memory (only if the bundle carried any).
  const agents = (bundle.agents && bundle.agents.length)
    ? require('./agents').mergeAgentMemory(ctx, bundle.agents, opts)
    : { added: 0, kept: 0, overwritten: 0, skipped: 0, total: 0 };
  // J1 config-tier: other agents' redacted config (re-redacted on the way in).
  const agentConfig = (bundle.agentConfig && bundle.agentConfig.length)
    ? require('./agents').mergeAgentConfig(ctx, bundle.agentConfig, opts)
    : { added: 0, kept: 0, overwritten: 0, skipped: 0, total: 0 };

  return { accounts: accounts, providers: providers, transcripts: transcripts, memory: memory, config: config, agents: agents, agentConfig: agentConfig };
}

// --- cloud relay (option c): move the bundle over WebDAV, reusing sync's
// encrypted transport. The payload carries secrets, so a passphrase is REQUIRED.
async function pushBundle(ctx, o) {
  o = o || {};
  if (!o.passphrase) throw new Error('a passphrase is required (the bundle carries login secrets)');
  const sync = require('./sync');
  const built = buildBundle(ctx, o);
  if (!built.counts.accounts && !built.counts.transcripts && !built.counts.providers && !built.counts.memory && !built.counts.config && !built.counts.agents && !built.counts.agentConfig) throw new Error('nothing to migrate (no accounts, providers, transcripts, or memory found)');
  await sync.davPut(o, sync.encrypt(JSON.stringify(built.bundle), o.passphrase));
  return built.counts;
}
async function pullBundle(ctx, o) {
  o = o || {};
  if (!o.passphrase) throw new Error('a passphrase is required');
  const sync = require('./sync');
  const raw = await sync.davGet(o);
  if (raw == null) return { found: false };
  let bundle;
  try { bundle = JSON.parse(sync.decrypt(raw, o.passphrase)); } catch (e) { throw new Error(e.message); }
  return { found: true, bundle: bundle };
}

module.exports = {
  FORMAT: FORMAT,
  VERSION: VERSION,
  buildBundle: buildBundle,
  applyBundle: applyBundle,
  pushBundle: pushBundle,
  pullBundle: pullBundle,
  mergeTranscripts: mergeTranscripts,
  collectTranscripts: collectTranscripts,
  collectTranscriptsFiltered: collectTranscriptsFiltered,
  collectProviders: collectProviders,
  collectMemory: collectMemory,
  mergeMemory: mergeMemory,
  collectConfig: collectConfig,
  mergeConfig: mergeConfig,
  isSafeSegment: isSafeSegment,
};
