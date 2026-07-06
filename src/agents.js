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
];
// J1 config-tier: per-agent CONFIG files (MCP servers, settings). These CAN hold secrets, so
// they are ALWAYS run through the secret scanner + redacted before carrying — the structure
// travels, the keys don't (re-enter them on the new machine).
const CONFIG_REGISTRY = [
  { id: 'cursor', files: ['.cursor/mcp.json'] },
  { id: 'gemini', files: ['.gemini/settings.json'] },
  { id: 'codex', files: ['.codex/config.toml'] },
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

// J1 config-tier: collect present agents' config files, ALWAYS redacted (secrets never carried).
// Returns [{ agent, rel, content (redacted), redactions }]. opts.only limits agent ids.
function collectAgentConfig(ctx, opts) {
  opts = opts || {};
  const secretscan = require('./secretscan');
  const only = opts.only && opts.only.length ? opts.only : null;
  const out = [];
  CONFIG_REGISTRY.forEach(function (a) {
    if (only && only.indexOf(a.id) === -1) return;
    a.files.forEach(function (rel) {
      const abs = path.join(ctx.home, rel);
      let raw; try { if (!fs.statSync(abs).isFile()) return; raw = fs.readFileSync(abs, 'utf8'); } catch (e) { return; }
      const red = secretscan.redactConfig(raw);
      out.push({ agent: a.id, rel: rel, content: red.text, redactions: red.count });
    });
  });
  return out;
}

// UNION-merge agent config under $HOME. Keeps existing unless force; path-guarded to stay under
// home; re-redacts on the way in (defence in depth — never trust a bundle to be clean).
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
    const safe = secretscan.redactConfig(m.content).text; // re-redact incoming, always
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
