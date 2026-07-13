'use strict';
// J1: carry OTHER AI agents' home-level MEMORY / instruction files across machines (like
// keyflip does ~/.claude for Claude). v1 ships the SAFE slice — markdown/text instruction
// files under the user's home, existence-gated, opt-in (`--agents`). NO config/auth/secret
// files (those hold API keys/tokens — deferred; see docs/MULTI-AGENT-STATE.md). Project-level
// files (.cursorrules, copilot-instructions.md, CONVENTIONS.md) travel with their git repos.
const fs = require('fs');
const path = require('path');
const fsutil = require('./fsutil');

// Each root is relative to $HOME. A root can be a single file or a directory of memory files.
const REGISTRY = [
  { id: 'cursor', label: 'Cursor', roots: ['.cursor/rules'] },
  { id: 'gemini', label: 'Gemini CLI', roots: ['.gemini/GEMINI.md'] },
  { id: 'codex', label: 'Codex CLI', roots: ['.codex/AGENTS.md', '.codex/memories'] },
  // Copilot's memory is project-level (.github/copilot-instructions.md, AGENTS.md) and travels
  // with its git repo, so no home-level memory roots — but it DOES have home-level config below.
  { id: 'copilot', label: 'GitHub Copilot', roots: [] },
  { id: 'opencode', label: 'opencode', roots: [] },   // home-level memory NEEDS-VERIFICATION; config below
  { id: 'aider', label: 'Aider', roots: [] },          // memory is project CONVENTIONS.md (travels w/ git)
  // Windsurf (Codeium): global rules + memories live under ~/.codeium/windsurf/memories/
  // (global_rules.md + per-workspace memory .md files). Project rules (.windsurf/rules) travel w/ git.
  { id: 'windsurf', label: 'Windsurf', roots: ['.codeium/windsurf/memories'] },
  // Kiro (AWS): steering docs are project-level (.kiro/steering/*.md, travels w/ git); no standard
  // home-level memory. Home MCP config below.
  { id: 'kiro', label: 'Kiro', roots: [] },
];
// J1 config-tier: per-agent CONFIG files (MCP servers, settings). These CAN hold secrets, so
// they are ALWAYS run through the secret scanner + redacted before carrying — the structure
// travels, the keys don't (re-enter them on the new machine).
const CONFIG_REGISTRY = [
  { id: 'cursor', files: ['.cursor/mcp.json'] },
  { id: 'gemini', files: ['.gemini/settings.json'] },
  { id: 'codex', files: ['.codex/config.toml'] },
  { id: 'copilot', files: ['.copilot/config.json', '.copilot/mcp-config.json'] },
  { id: 'opencode', files: ['.config/opencode/opencode.json'] },
  { id: 'aider', files: ['.aider.conf.yml'] }, // YAML/env → secretscan uses line-based redaction
  { id: 'windsurf', files: ['.codeium/windsurf/mcp_config.json'] },
  { id: 'kiro', files: ['.kiro/settings/mcp.json'] }, // user-level MCP servers
];
const MEM_EXT = ['.md', '.mdc', '.txt'];

function isMemoryFile(name) { return MEM_EXT.indexOf(path.extname(name).toLowerCase()) !== -1; }
function walk(dir, budget, out) {
  if (budget.left <= 0) return;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (let i = 0; i < ents.length && budget.left > 0; i++) {
    const p = path.join(dir, ents[i].name);
    if (ents[i].isDirectory()) walk(p, budget, out);
    else if (ents[i].isFile() && isMemoryFile(ents[i].name)) { out.push(p); budget.left--; }
  }
}

// Collect present agents' memory files as [{ agent, rel, content }] (rel relative to $HOME).
// opts.only = array of agent ids to limit to (else all present).
function collectAgentMemory(ctx, opts) {
  opts = opts || {};
  const home = ctx.home;
  const only = opts.only && opts.only.length ? opts.only : null;
  const out = [];
  const budget = { left: 400 };
  REGISTRY.forEach(function (a) {
    if (only && only.indexOf(a.id) === -1) return;
    a.roots.forEach(function (root) {
      const abs = path.join(home, root);
      let st; try { st = fs.statSync(abs); } catch (e) { return; }
      const files = [];
      if (st.isDirectory()) walk(abs, budget, files);
      else if (st.isFile() && isMemoryFile(abs)) { files.push(abs); }
      files.forEach(function (f) {
        let content; try { content = fs.readFileSync(f, 'utf8'); } catch (e) { return; }
        out.push({ agent: a.id, rel: path.relative(home, f), content: content });
      });
    });
  });
  return out;
}

// UNION-merge agent memory under $HOME. Never clobber unless force; reject anything that
// escapes $HOME (path-traversal guard).
function mergeAgentMemory(ctx, list, opts) {
  opts = opts || {};
  const home = ctx.home;
  let added = 0, kept = 0, overwritten = 0, skipped = 0;
  (list || []).forEach(function (m) {
    if (!m || typeof m.content !== 'string' || typeof m.rel !== 'string') { skipped++; return; }
    const dest = path.resolve(home, m.rel);
    if (!isMemoryFile(dest)) { skipped++; return; } // only ever write memory-shaped files
    if (!fsutil.safeDestUnder(home, dest).ok) { skipped++; return; } // lexical + symlink escape guard
    const exists = fs.existsSync(dest);
    if (exists && !opts.force) { kept++; return; }
    try { fsutil.atomicWrite(dest, m.content); if (exists) overwritten++; else added++; }
    catch (e) { skipped++; }
  });
  return { added: added, kept: kept, overwritten: overwritten, skipped: skipped, total: (list || []).length };
}

function presentAgents(ctx) {
  return REGISTRY.filter(function (a) {
    return a.roots.some(function (r) { try { return fs.existsSync(path.join(ctx.home, r)); } catch (e) { return false; } });
  }).map(function (a) { return a.id; });
}

// J1 config-tier: collect present agents' config files. By DEFAULT every secret is redacted
// (structure travels, keys don't). The user can opt to carry the real keys with opts.redact
// === false — the caller MUST then ensure the bundle is encrypted (CLI enforces this).
// Returns [{ agent, rel, content, redactions, redacted }]. opts.only limits agent ids.
function collectAgentConfig(ctx, opts) {
  opts = opts || {};
  const redact = opts.redact !== false; // default: redact
  const secretscan = require('./secretscan');
  const only = opts.only && opts.only.length ? opts.only : null;
  const out = [];
  CONFIG_REGISTRY.forEach(function (a) {
    if (only && only.indexOf(a.id) === -1) return;
    a.files.forEach(function (rel) {
      const abs = path.join(ctx.home, rel);
      let raw; try { if (!fs.statSync(abs).isFile()) return; raw = fs.readFileSync(abs, 'utf8'); } catch (e) { return; }
      const red = secretscan.redactConfig(raw); // count = secrets present, regardless of mode
      out.push({ agent: a.id, rel: rel, content: redact ? red.text : raw, redactions: red.count, redacted: redact });
    });
  });
  return out;
}

// UNION-merge agent config under $HOME. Keeps existing unless force; path-guarded to stay under
// home. Re-redacts incoming by DEFAULT (defence in depth — never trust a bundle to be clean),
// EXCEPT entries the sender intentionally carried with secrets (redacted === false).
function mergeAgentConfig(ctx, list, opts) {
  opts = opts || {};
  const secretscan = require('./secretscan');
  const home = ctx.home;
  let added = 0, kept = 0, overwritten = 0, skipped = 0;
  (list || []).forEach(function (m) {
    if (!m || typeof m.content !== 'string' || typeof m.rel !== 'string') { skipped++; return; }
    // only write to a known config location for a known agent (no arbitrary paths)
    const known = CONFIG_REGISTRY.some(function (a) { return a.files.indexOf(m.rel) !== -1; });
    if (!known) { skipped++; return; }
    const dest = path.resolve(home, m.rel);
    if (!fsutil.safeDestUnder(home, dest).ok) { skipped++; return; }
    const exists = fs.existsSync(dest);
    if (exists && !opts.force) { kept++; return; }
    // Honor an intentional secret-carry (redacted===false); otherwise re-redact defensively.
    const safe = (m.redacted === false) ? m.content : secretscan.redactConfig(m.content).text;
    try { fsutil.atomicWrite(dest, safe); if (exists) overwritten++; else added++; }
    catch (e) { skipped++; }
  });
  return { added: added, kept: kept, overwritten: overwritten, skipped: skipped, total: (list || []).length };
}

function presentAgentConfig(ctx) {
  return CONFIG_REGISTRY.filter(function (a) {
    return a.files.some(function (r) { try { return fs.existsSync(path.join(ctx.home, r)); } catch (e) { return false; } });
  }).map(function (a) { return a.id; });
}

module.exports = {
  REGISTRY: REGISTRY, CONFIG_REGISTRY: CONFIG_REGISTRY,
  collectAgentMemory: collectAgentMemory, mergeAgentMemory: mergeAgentMemory,
  collectAgentConfig: collectAgentConfig, mergeAgentConfig: mergeAgentConfig,
  presentAgents: presentAgents, presentAgentConfig: presentAgentConfig, isMemoryFile: isMemoryFile,
};
