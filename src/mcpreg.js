'use strict';
// #15 Central MCP-server registry, projected into Claude Code (~/.claude.json)
// and the Claude Desktop app (claude_desktop_config.json). Define a server once,
// then enable/disable it per surface. Enable = upsert the entry (preserving all
// other keys); disable = delete it. A surface is only touched when its config
// exists. On Windows, stdio npx/node commands are wrapped as `cmd /c …` (except
// under WSL UNC paths). Anthropic surfaces only.
const fs = require('fs');
const path = require('path');
const { writeJsonStable } = require('./fsutil');
const claude = require('./claude');
const profiles = require('./profiles');

function regFile(ctx) { return path.join(ctx.configDir, 'mcp-registry.json'); }
function desktopConfigPath(ctx) { return ctx.appDataDir ? path.join(ctx.appDataDir, 'claude_desktop_config.json') : null; }

function readReg(ctx) {
  try { const o = JSON.parse(fs.readFileSync(regFile(ctx), 'utf8')); return (o && typeof o === 'object') ? o : {}; }
  catch (e) { return {}; }
}
function writeReg(ctx, reg) { writeJsonStable(regFile(ctx), reg, 0o600); }

function list(ctx) {
  const reg = readReg(ctx);
  return Object.keys(reg).sort().map(function (n) { return Object.assign({ name: n }, reg[n]); });
}

// Add/update a server definition. def: { command, args, env }.
function add(ctx, name, def) {
  if (!profiles.isValidName(name)) throw new Error("invalid MCP server name: '" + name + "'");
  if (!def || !def.command) throw new Error('an MCP server needs a command');
  const reg = readReg(ctx);
  reg[name] = { command: def.command, args: def.args || [], env: def.env || {} };
  writeReg(ctx, reg);
  return reg[name];
}

function remove(ctx, name) {
  const reg = readReg(ctx);
  delete reg[name];
  writeReg(ctx, reg);
  // also unhook from both surfaces
  ['claude-code', 'claude-desktop'].forEach(function (s) { try { setEnabled(ctx, name, s, false); } catch (e) { /* */ } });
}

// The server entry as a target app expects it, applying the Windows cmd-wrap.
function entryFor(ctx, def) {
  const isWin = ctx.platform === 'win32';
  const underWsl = require('./wsl').isWslPath(ctx.claudeDir || '');
  if (isWin && !underWsl && /^(npx|node|npm)$/.test(def.command)) {
    return { command: 'cmd', args: ['/c', def.command].concat(def.args || []), env: def.env || {} };
  }
  return { command: def.command, args: def.args || [], env: def.env || {} };
}

// enable/disable a registered server on a surface ('claude-code' | 'claude-desktop').
// Returns 'applied' | 'removed' | 'skipped-no-config'.
function setEnabled(ctx, name, surface, enabled) {
  const reg = readReg(ctx);
  const def = reg[name];
  if (enabled && !def) throw new Error("no such MCP server: '" + name + "'");
  if (surface === 'claude-code') {
    const cfg = claude.loadForWrite(ctx.claudeConfigPath); // {} if missing, throws if corrupt
    cfg.mcpServers = cfg.mcpServers || {};
    if (enabled) cfg.mcpServers[name] = entryFor(ctx, def); else delete cfg.mcpServers[name];
    claude.writeConfig(ctx.claudeConfigPath, cfg);
    return 'applied';
  }
  if (surface === 'claude-desktop') {
    const p = desktopConfigPath(ctx);
    if (!p) return 'skipped-no-config';
    if (enabled && !fs.existsSync(p)) return 'skipped-no-config'; // only sync when the app config exists
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')) || {}; } catch (e) { cfg = {}; }
    cfg.mcpServers = cfg.mcpServers || {};
    if (enabled) cfg.mcpServers[name] = entryFor(ctx, def); else delete cfg.mcpServers[name];
    writeJsonStable(p, cfg, 0o600);
    return 'applied';
  }
  throw new Error('surface must be claude-code | claude-desktop');
}

// Import servers already configured in the live files into the registry.
function importLive(ctx) {
  const imported = [];
  const cfg = claude.readConfig(ctx.claudeConfigPath) || {};
  Object.keys(cfg.mcpServers || {}).forEach(function (n) {
    if (profiles.isValidName(n)) { add(ctx, n, cfg.mcpServers[n]); imported.push(n); }
  });
  const p = desktopConfigPath(ctx);
  if (p && fs.existsSync(p)) {
    let d = {}; try { d = JSON.parse(fs.readFileSync(p, 'utf8')) || {}; } catch (e) { d = {}; }
    Object.keys(d.mcpServers || {}).forEach(function (n) {
      if (profiles.isValidName(n) && imported.indexOf(n) === -1) { add(ctx, n, d.mcpServers[n]); imported.push(n); }
    });
  }
  return imported;
}

module.exports = { list: list, add: add, remove: remove, setEnabled: setEnabled, importLive: importLive, readReg: readReg, entryFor: entryFor, desktopConfigPath: desktopConfigPath };
