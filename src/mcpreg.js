// #15 Central MCP-server registry, projected into every agent that reads a plain JSON MCP
// config: Claude Code (~/.claude.json), Claude Desktop (claude_desktop_config.json), Cursor,
// Kiro, Gemini CLI, Command Code (~/.commandcode/mcp.json), Devin Desktop/Windsurf (an EXISTING
// file only — its location moved across renames) and opencode (which keeps servers under `mcp`,
// not `mcpServers`). Define a server once, then enable/disable it per surface. Enable = upsert
// the entry (preserving every other key); disable = delete it. A target is only CREATED when its
// agent is installed and its path is unambiguous; an agent whose format keyflip cannot write
// safely is listed by `surfaces()` as not projected, with the reason, instead of being written
// blind. On Windows, stdio npx/node commands are wrapped as `cmd /c …` (except under WSL UNC paths).
import fs from 'fs';
import path from 'path';
import { atomicWrite, writeJsonStable } from './fsutil.js';
import * as claude from './claude.js';
import * as profiles from './profiles.js';
import * as _wsl from './wsl.js';

function regFile(ctx) {
  return path.join(ctx.configDir, 'mcp-registry.json');
}
function desktopConfigPath(ctx) {
  return ctx.appDataDir ? path.join(ctx.appDataDir, 'claude_desktop_config.json') : null;
}

// Where each agent reads MCP servers, and which key shape it expects:
//   mcpServers → { name: { command, args, env } }
//   opencode   → { name: { type:'local', command:[cmd, ...args], environment } } under `mcp`
// `home` entries are relative to ctx.home; `agentDir(s)` say how a target is detected when its
// config file does not exist yet (so keyflip never invents a config for an app that isn't there).
const TARGETS = [
  { id: 'claude-code', app: 'Claude Code', shape: 'mcpServers', path: (ctx) => ctx.claudeConfigPath, always: true },
  {
    id: 'claude-desktop',
    app: 'Claude Desktop',
    shape: 'mcpServers',
    path: (ctx) => desktopConfigPath(ctx),
    existingOnly: true,
  },
  {
    id: 'cursor',
    app: 'Cursor',
    shape: 'mcpServers',
    home: '.cursor/mcp.json',
    // The MCP file lives in ~/.cursor, but a fresh install may not have created that dir yet;
    // the app's own data dir proves the agent is there.
    agentDirs: ['.cursor', '.config/Cursor', 'Library/Application Support/Cursor'],
  },
  {
    id: 'kiro',
    app: 'Kiro',
    shape: 'mcpServers',
    home: '.kiro/settings/mcp.json',
    agentDir: '.kiro',
  },
  {
    id: 'gemini',
    app: 'Gemini CLI',
    shape: 'mcpServers',
    home: '.gemini/settings.json',
    agentDir: '.gemini',
  },
  {
    // Command Code keeps its MCP servers at ~/.commandcode/mcp.json with the standard
    // `mcpServers` shape (verified against command-code@1.81.0, which also imports from
    // Claude/Cursor/Gemini). `cmd mcp add` writes the same file, so both stay in sync.
    id: 'command-code',
    app: 'Command Code',
    shape: 'mcpServers',
    home: '.commandcode/mcp.json',
    agentDir: '.commandcode',
  },
  {
    // Windsurf became Devin Desktop; the file moved and the old locations are still read by
    // existing installs. All three are plausible, so only an EXISTING file is ever edited —
    // keyflip will not guess which one a fresh install reads.
    id: 'devin',
    app: 'Devin Desktop / Windsurf',
    shape: 'mcpServers',
    homes: ['.config/devin/mcp_config.json', '.windsurf/mcp_config.json', '.codeium/windsurf/mcp_config.json'],
    agentDirs: ['.config/devin', '.windsurf', '.codeium/windsurf'],
    existingOnly: true,
  },
  {
    // opencode keeps its whole config in one file and names servers under `mcp`. The shipped
    // file is opencode.jsonc; a JSONC file with comments is not something keyflip can rewrite
    // without dropping the user's comments, so that case is reported, never touched.
    id: 'opencode',
    app: 'opencode',
    shape: 'opencode',
    home: '.config/opencode/opencode.json',
    agentDir: '.config/opencode',
    existingOnly: true,
  },
];

// Agents that take MCP servers but not through a file keyflip can write safely today. They are
// NAMED (with the reason) wherever surfaces are reported — a silent gap reads like coverage.
const NOT_PROJECTED = [
  {
    id: 'codex',
    app: 'Codex CLI',
    reason: 'MCP servers live in TOML ([mcp_servers] in ~/.codex/config.toml) and keyflip has no TOML writer',
  },
  {
    id: 'continue',
    app: 'Continue',
    reason:
      'its server list is an ARRAY under experimental.mcpServers — a shape keyflip has not verified against a live config',
  },
  {
    id: 'copilot',
    app: 'GitHub Copilot',
    reason: 'its MCP file is repo-scoped (.github/copilot/.mcp.json), not a user-level config',
  },
];

function targetById(id) {
  for (let i = 0; i < TARGETS.length; i++) if (TARGETS[i].id === id) return TARGETS[i];
  return null;
}
const TARGET_IDS = TARGETS.map((t) => t.id);

// Resolve a target to { file | reason }. reason is a status word the caller prints verbatim:
//   skipped-no-config | skipped-not-installed | skipped-jsonc
function resolve(ctx, t) {
  const exists = (p) => {
    try {
      return fs.existsSync(p);
    } catch (e) {
      return false;
    }
  };
  const agentPresent = () => {
    if (t.always) return true;
    const dirs = t.agentDirs || (t.agentDir ? [t.agentDir] : []);
    return dirs.some((d) => exists(path.join(ctx.home, d)));
  };
  if (t.homes) {
    for (let i = 0; i < t.homes.length; i++) {
      const p = path.join(ctx.home, t.homes[i]);
      if (exists(p)) return { file: p };
    }
    return { reason: agentPresent() ? 'skipped-no-config' : 'skipped-not-installed' };
  }
  const file = t.path ? t.path(ctx) : t.home ? path.join(ctx.home, t.home) : null;
  if (!file) return { reason: 'skipped-no-config' };
  if (exists(file)) return { file: file };
  // A JSONC file that cannot be rewritten without losing its comments is not "no config".
  if (t.shape === 'opencode' && exists(file.replace(/\.json$/, '.jsonc'))) return { reason: 'skipped-jsonc' };
  if (t.existingOnly) return { reason: agentPresent() ? 'skipped-no-config' : 'skipped-not-installed' };
  if (!agentPresent()) return { reason: 'skipped-not-installed' };
  return { file: file };
}

function readReg(ctx) {
  try {
    const o = JSON.parse(fs.readFileSync(regFile(ctx), 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch (e) {
    return {};
  }
}
function writeReg(ctx, reg) {
  writeJsonStable(regFile(ctx), reg, 0o600);
}

function list(ctx) {
  const reg = readReg(ctx);
  return Object.keys(reg)
    .sort()
    .map(function (n) {
      return Object.assign({ name: n }, reg[n]);
    });
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
  // also unhook from every surface this machine has
  TARGETS.forEach(function (t) {
    try {
      setEnabled(ctx, name, t.id, false);
    } catch (e) {
      /* a surface whose config is corrupt/absent: leave it alone */
    }
  });
}

// The server entry as a target app expects it, applying the Windows cmd-wrap.
function entryFor(ctx, def) {
  const isWin = ctx.platform === 'win32';
  const underWsl = _wsl.isWslPath(ctx.claudeDir || '');
  if (isWin && !underWsl && /^(npx|node|npm)$/.test(def.command)) {
    return { command: 'cmd', args: ['/c', def.command].concat(def.args || []), env: def.env || {} };
  }
  return { command: def.command, args: def.args || [], env: def.env || {} };
}

// The same entry in the target's own shape (opencode wants one argv array and `environment`).
function storedEntry(ctx, shape, def) {
  const e = entryFor(ctx, def);
  if (shape === 'opencode') {
    const local = { type: 'local', command: [e.command].concat(e.args || []) };
    if (e.env && Object.keys(e.env).length) local.environment = e.env;
    return local;
  }
  return e;
}

// Strict read of a target config: {} when missing, THROW when it exists but is not a JSON
// object — rewriting a corrupt config as {} would destroy every other server it holds.
function readTarget(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return {};
    throw e;
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(file + ' exists but is not valid JSON — refusing to overwrite it (fix or remove it first)');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(file + ' must contain a JSON object — refusing to overwrite it');
  }
  return obj;
}

function writeTarget(file, obj) {
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch (e) {
    /* new file */
  }
  // Deliberately NOT key-sorted: these are other apps' config files (a whole settings document
  // in Gemini's case) and reordering their keys would bury a one-line change in a full rewrite.
  atomicWrite(file, JSON.stringify(obj, null, 2) + '\n', mode);
}

function bucket(cfg, shape) {
  const key = shape === 'opencode' ? 'mcp' : 'mcpServers';
  if (!cfg[key] || typeof cfg[key] !== 'object' || Array.isArray(cfg[key])) cfg[key] = {};
  return cfg[key];
}

// enable/disable a registered server on one surface id. Returns
// 'applied' | 'skipped-no-config' | 'skipped-not-installed' | 'skipped-jsonc'.
function setEnabled(ctx, name, surface, enabled) {
  const t = targetById(surface);
  if (!t) throw new Error("unknown MCP surface: '" + surface + "' (known: " + TARGET_IDS.join(', ') + ', or all)');
  const reg = readReg(ctx);
  const def = reg[name];
  if (enabled && !def) throw new Error("no such MCP server: '" + name + "'");
  if (t.id === 'claude-code') {
    const cfg = claude.loadForWrite(ctx.claudeConfigPath); // {} if missing, throws if corrupt
    cfg.mcpServers = cfg.mcpServers || {};
    if (enabled) cfg.mcpServers[name] = entryFor(ctx, def);
    else delete cfg.mcpServers[name];
    claude.writeConfig(ctx.claudeConfigPath, cfg);
    return 'applied';
  }
  const r = resolve(ctx, t);
  if (!r.file) return r.reason;
  const cfg = readTarget(r.file);
  const servers = bucket(cfg, t.shape);
  if (enabled) servers[name] = storedEntry(ctx, t.shape, def);
  else delete servers[name];
  writeTarget(r.file, cfg);
  return 'applied';
}

// Every surface keyflip knows about, whether it is on this machine, and which registered
// servers it currently carries. Read-only.
function surfaces(ctx) {
  const reg = readReg(ctx);
  const names = Object.keys(reg).sort();
  const rows = TARGETS.map(function (t) {
    const r = resolve(ctx, t);
    const row = { id: t.id, app: t.app, shape: t.shape, path: r.file || resolvePathForDisplay(ctx, t) };
    if (!r.file) {
      row.state = r.reason.slice('skipped-'.length); // 'no-config' | 'not-installed' | 'jsonc'
      row.supported = true; // supported, just not usable on this machine right now
      return row;
    }
    row.supported = true;
    // 'ready' means the file is on disk; 'will-create' means the agent is installed and enable
    // would write it. They are different facts and the report must not blur them.
    if (!fs.existsSync(r.file)) {
      row.state = 'will-create';
      return row;
    }
    row.state = 'ready';
    try {
      const cfg = readTarget(r.file);
      const s = bucket(Object.assign({}, cfg), t.shape);
      row.servers = names.filter((n) => Object.prototype.hasOwnProperty.call(s, n));
    } catch (e) {
      row.state = 'unreadable';
      row.error = e.message;
    }
    return row;
  });
  NOT_PROJECTED.forEach(function (n) {
    rows.push({ id: n.id, app: n.app, supported: false, state: 'not-projected', reason: n.reason });
  });
  return rows;
}

// The path a target WOULD use, for messages about a config that is not there yet.
function resolvePathForDisplay(ctx, t) {
  if (t.homes) return path.join(ctx.home, t.homes[0]);
  if (t.home) return path.join(ctx.home, t.home);
  return t.path ? t.path(ctx) : null;
}

// Import servers already configured in the live files into the registry.
function importLive(ctx) {
  const imported = [];
  TARGETS.forEach(function (t) {
    const r = resolve(ctx, t);
    if (!r.file) return;
    let cfg;
    try {
      cfg = readTarget(r.file);
    } catch (e) {
      return; // corrupt or unreadable: import is a convenience, not a repair
    }
    const s = (t.shape === 'opencode' ? cfg.mcp : cfg.mcpServers) || {};
    if (typeof s !== 'object' || Array.isArray(s)) return;
    Object.keys(s).forEach(function (n) {
      if (!profiles.isValidName(n) || imported.indexOf(n) !== -1) return;
      const raw = s[n];
      const def = t.shape === 'opencode' ? fromOpencode(raw) : raw;
      if (!def || !def.command) return;
      add(ctx, n, def);
      imported.push(n);
    });
  });
  return imported;
}

function fromOpencode(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.command) || !raw.command.length) return null;
  return {
    command: raw.command[0],
    args: raw.command.slice(1),
    env: raw.environment && typeof raw.environment === 'object' ? raw.environment : {},
  };
}

// The entry for keyflip's OWN MCP server, in absolute paths. A bare `keyflip` command only works for
// launchers whose $PATH happens to include it — a GUI app (Claude Desktop/Code) inherits launchd's
// minimal PATH and reports "Executable not found in $PATH", and an fnm node switch silently drops a
// global install. The node binary running THIS process plus the script it is running always exist.
function selfEntry() {
  let bin = process.argv[1] || '';
  try {
    bin = fs.realpathSync(bin);
  } catch (e) {
    /* keep the raw path */
  }
  return { command: process.execPath, args: [bin, 'mcp'], env: {} };
}

export {
  list,
  add,
  remove,
  setEnabled,
  importLive,
  readReg,
  entryFor,
  desktopConfigPath,
  selfEntry,
  surfaces,
  TARGET_IDS,
  NOT_PROJECTED,
};
