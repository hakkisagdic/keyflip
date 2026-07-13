'use strict';
// MCP (Model Context Protocol) server over stdio, so agents can operate keyflip
// themselves. Implements the spec's base protocol: JSON-RPC 2.0, newline-delimited
// messages, initialize/initialized lifecycle, ping, tools/list + tools/call with
// JSON Schema inputs, tool annotations (readOnlyHint/destructiveHint) and
// structuredContent results.
//
// Safety model for agents: mutating tools REQUIRE `confirm: true`, and the tool
// descriptions instruct the agent to ask the human first. Switching never closes
// the desktop app from under the user (swap-in-place semantics; Claude Code picks
// the new credential up on its next request).
const readline = require('readline');
const core = require('./core');
const profiles = require('./profiles');
const appauth = require('./appauth');
const usage = require('./usage');
const lock = require('./lock');
const logmod = require('./log');
const provider = require('./provider');
const sessions = require('./sessions');
const doctor = require('./doctor');
const backup = require('./backup');
const history = require('./history');
const proxy = require('./proxy');
const browser = require('./browser');
const loginmod = require('./login');
const exec = require('./exec');
const appsessions = require('./appsessions');
const appctl = require('./platform');
const migrate = require('./migrate');
const sync = require('./sync');
const archive = require('./archive');
const vcs = require('./vcs');
const memorymod = require('./memory');
const llm = require('./llm');
const auditview = require('./auditview');
const fs = require('fs');

// Mutating tools all gate on confirm:true — the agent must ask the user first.
function needConfirm(args) {
  if (!args || args.confirm !== true) throw new Error('confirmation required: ask the user first, then call again with confirm=true');
}
const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const RO_NET = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const MUT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const confirmProp = { confirm: { type: 'boolean', description: 'Must be true — set it only after the user has agreed.' } };

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

let VERSION = '0.0.0';
try { VERSION = require('../package.json').version; } catch (e) { /* ignore */ }

// ---- tool implementations ----------------------------------------------------

function accountsPayload(ctx, infos) {
  const appActive = ctx.appDataDir ? appauth.activeProfileName(ctx) : null;
  return core.listProfiles(ctx).map(function (e) {
    let cli = null;
    try { cli = !!ctx.store.getProfile(e.name); } catch (err) { cli = null; }
    const out = {
      name: e.name,
      email: e.email || null,
      cliCaptured: cli,
      appCaptured: appauth.hasProfile(ctx, e.name),
      activeCli: !!e.active,
      activeApp: e.name === appActive,
    };
    if (infos && infos[e.name]) {
      out.usage = infos[e.name].usage;
      out.usageStatus = infos[e.name].status;
      out.headroomPct = infos[e.name].headroom;
    }
    return out;
  });
}

const TOOLS = [
  {
    name: 'keyflip_status',
    title: 'Active Claude account',
    description: 'Which Claude account is active on each surface (Claude Code CLI and the desktop app). Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    run: async function (ctx) {
      const appName = ctx.appDataDir ? appauth.activeProfileName(ctx) : null;
      return {
        cli: core.currentEmail(ctx) ? { email: core.currentEmail(ctx) } : null,
        app: appName ? { name: appName, email: profiles.email(ctx.configDir, appName) || null } : null,
      };
    },
  },
  {
    name: 'keyflip_list',
    title: 'List saved Claude accounts',
    description: 'Saved Claude accounts with what is captured for each ([cli|app]) and which is active. Set include_usage=true to add each account\'s 5h/7d utilization and remaining headroom (network call, ~1s per account). Read-only.',
    inputSchema: {
      type: 'object',
      properties: { include_usage: { type: 'boolean', description: 'Also fetch per-account usage/quota.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    run: async function (ctx, args) {
      let infos = null;
      if (args && args.include_usage) {
        const list = core.listProfiles(ctx);
        const active = list.filter(function (e) { return e.active; })[0];
        infos = await usage.usageForProfiles(ctx, list.map(function (e) { return e.name; }),
          { liveFor: active ? active.name : null });
      }
      return { accounts: accountsPayload(ctx, infos) };
    },
  },
  {
    name: 'keyflip_switch',
    title: 'Switch Claude account',
    description: 'Switch the Claude Code CLI credential to a saved account (in place — the desktop app is NOT closed; a running Claude Code picks the new account up on its next request, so the user\'s current conversation continues on the new account). IMPORTANT: this changes which account is billed and rate-limited. Ask the user before calling, then set confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Account name (from keyflip_list).' },
        confirm: { type: 'boolean', description: 'Must be true — set it only after the user has agreed to the switch.' },
      },
      required: ['name', 'confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: async function (ctx, args) {
      if (args.confirm !== true) {
        throw new Error('confirmation required: ask the user first, then call again with confirm=true');
      }
      const name = core.resolveProfile(ctx, String(args.name));
      if (!name) throw new Error("no such account: '" + args.name + "' (use keyflip_list)");
      const em = profiles.email(ctx.configDir, name);
      if (em && em === core.currentEmail(ctx)) return { alreadyActive: { name: name, email: em } };
      require('./policy').enforce(ctx, { cwd: process.cwd(), account: name }); // org policy: agents can't dodge it
      const l = await lock.acquire(ctx.configDir);
      try {
        const did = core.performSwitch(ctx, name);
        logmod.log('mcp switch -> ' + name);
        return { switched: { name: name, email: em || null }, cliSwitched: did.cli,
          note: 'Desktop app not touched; a running Claude Code applies the new account on its next request.' };
      } finally { l.release(); }
    },
  },
  {
    name: 'keyflip_next',
    title: 'Rotate to another Claude account',
    description: 'Rotate the CLI credential to the next saved account, optionally by remaining quota (strategy "best" = most headroom, "next-available" = first not rate-limited). Same in-place semantics as keyflip_switch. Ask the user before calling, then set confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        strategy: { type: 'string', enum: ['best', 'next-available'], description: 'Optional quota-aware selection.' },
        confirm: { type: 'boolean', description: 'Must be true — set it only after the user has agreed.' },
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    run: async function (ctx, args) {
      if (args.confirm !== true) {
        throw new Error('confirmation required: ask the user first, then call again with confirm=true');
      }
      const list = core.listProfiles(ctx);
      if (list.length < 2) throw new Error('need at least 2 saved accounts');
      let idx = -1;
      list.forEach(function (e, i) { if (e.active) idx = i; });
      const candidates = [];
      for (let k = 1; k <= list.length; k++) {
        const e = list[(idx + k) % list.length];
        if (!e.active) candidates.push(e);
      }
      let target = candidates[0];
      if (args.strategy) {
        const infos = await usage.usageForProfiles(ctx, candidates.map(function (e) { return e.name; }), {});
        target = usage.pickByStrategy(candidates, infos, args.strategy);
        if (!target) throw new Error("no account matches strategy '" + args.strategy + "'");
      }
      require('./policy').enforce(ctx, { cwd: process.cwd(), account: target.name }); // org policy applies to rotation too
      const l = await lock.acquire(ctx.configDir);
      try {
        const did = core.performSwitch(ctx, target.name);
        logmod.log('mcp next -> ' + target.name);
        return { switched: { name: target.name, email: target.email || null }, cliSwitched: did.cli };
      } finally { l.release(); }
    },
  },

  // ---- providers (third-party endpoints) ----
  {
    name: 'keyflip_providers', title: 'List provider endpoints',
    description: 'Saved third-party API endpoints (relays/gateways/Bedrock/OpenRouter) and which one Claude Code is currently routed through. Read-only; never returns keys.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO,
    run: async function (ctx) {
      const active = provider.readActive(ctx);
      return { providers: provider.list(ctx).map(function (n) { const m = provider.read(ctx, n); return { name: n, baseUrl: m && m.baseUrl, active: !!(active && active.name === n) }; }), active: active ? active.name : 'official' };
    },
  },
  {
    name: 'keyflip_provider_use', title: 'Route Claude Code to a provider',
    description: 'Point Claude Code at a saved provider endpoint (or "official" to return to the Anthropic subscription) by patching settings.json env — Claude hot-reloads, no restart. Ask the user first, then confirm=true.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Provider name, or "official".' }, confirm: confirmProp.confirm }, required: ['name', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      if (args.name === 'official' || args.name === 'off') { provider.useOfficial(ctx); return { provider: 'official' }; }
      if (!provider.exists(ctx, args.name)) throw new Error("no such provider: '" + args.name + "'");
      const r = provider.use(ctx, args.name); return { provider: args.name, baseUrl: r.baseUrl };
    },
  },
  {
    name: 'keyflip_provider_add', title: 'Save a provider endpoint',
    description: 'Save a third-party endpoint. NOTE: the API key is a secret and must NOT be passed through MCP — omit it here and tell the user to run `keyflip provider add <name> --base-url <url> --key-file -` (key on stdin). This tool stores only the non-secret metadata. Ask the user first, then confirm=true.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, base_url: { type: 'string' }, auth_scheme: { type: 'string', enum: ['bearer', 'api-key'] }, confirm: confirmProp.confirm }, required: ['name', 'base_url', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      provider.add(ctx, args.name, { baseUrl: args.base_url, authScheme: args.auth_scheme || 'bearer' });
      return { saved: args.name, note: 'No key stored. Run `keyflip provider add ' + args.name + ' --base-url ' + args.base_url + ' --key-file -` to add the key securely.' };
    },
  },
  {
    name: 'keyflip_test_provider', title: 'Test a provider endpoint',
    description: 'Fire one minimal real request to a provider to check auth + reachability. Read-only (no state change).',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false }, annotations: RO_NET,
    run: async function (ctx, args) { return { name: args.name, result: await doctor.testProvider(ctx, args.name) }; },
  },

  // ---- sessions ----
  {
    name: 'keyflip_sessions', title: 'Browse Claude Code conversations',
    description: 'List/search past Claude Code conversations across ALL accounts (transcripts in ~/.claude/projects). `search` matches transcript CONTENT and returns a match snippet; `orphan` flags a session whose working dir is gone (fix with keyflip_sessions_rebind). Read-only.',
    inputSchema: { type: 'object', properties: { search: { type: 'string' }, cwd: { type: 'string', description: 'Only sessions started in this directory.' }, limit: { type: 'integer' } }, additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) {
      const rows = sessions.list(ctx, { search: args && args.search, cwd: args && args.cwd, limit: (args && args.limit) || 40 });
      return { sessions: rows.map(function (r) { return { sessionId: r.sessionId, cwd: r.cwd, mtime: r.mtime, preview: r.preview, match: r.match || null, orphan: !!r.orphan }; }) };
    },
  },
  {
    name: 'keyflip_resume_command', title: 'Get a session resume command',
    description: 'Return the exact command to resume a past conversation in its original directory (does NOT run it). Read-only.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Session id or unique prefix.' } }, required: ['id'], additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) {
      const row = sessions.find(ctx, String(args.id)); if (!row) throw new Error('no such session: ' + args.id);
      const rc = sessions.resumeCommand(row); return { cwd: rc.cwd, command: rc.command + ' ' + rc.args.join(' ') };
    },
  },
  {
    name: 'keyflip_sessions_export', title: 'Export a conversation as markdown/HTML',
    description: 'Render a past Claude Code conversation into a clean, shareable document — markdown (default), a self-contained HTML chat view, or normalized json. Tool output is summarized ("used Read, Grep"), not dumped. Read-only: returns the rendered content (does not write a file).',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Session id or unique prefix.' }, format: { type: 'string', enum: ['md', 'html', 'json'] } }, required: ['id'], additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) {
      const transcript = require('./transcript');
      const row = sessions.find(ctx, String(args.id)); if (!row) throw new Error('no such session: ' + args.id);
      let raw; try { raw = fs.readFileSync(row.file, 'utf8'); } catch (e) { throw new Error('cannot read the transcript: ' + (e && e.message)); }
      const parsed = transcript.parse(raw);
      const fmt = args.format === 'html' ? 'html' : args.format === 'json' ? 'json' : 'md';
      const content = fmt === 'html' ? transcript.toHtml(parsed, { id: row.sessionId }) : fmt === 'json' ? JSON.stringify(parsed, null, 2) : transcript.toMarkdown(parsed, { id: row.sessionId });
      return { format: fmt, counts: parsed.counts, content: content };
    },
  },
  {
    name: 'keyflip_foreign_export', title: 'Normalize ANOTHER agent\'s session log',
    description: 'Read another AI agent\'s session log FILE at `path` (message-event JSONL, generic JSON, a Cursor SQLite store, or an Aider .aider.chat.history.md) and normalize it into keyflip\'s unified conversation shape, then render it as markdown/HTML/json — the same view as Claude Code sessions. Read-only. (Copilot YAML is not yet supported; the Cursor/JSON/Aider mappings are best-effort — confirm against a real install.)',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, format: { type: 'string', enum: ['md', 'html', 'json'] } }, required: ['path'], additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) {
      const foreign = require('./foreign'); const transcript = require('./transcript');
      let raw; try { raw = fs.readFileSync(String(args.path)); } catch (e) { throw new Error('cannot read ' + args.path + ': ' + (e && e.message)); } // Buffer (Cursor is binary)
      const norm = foreign.normalize(String(args.path), raw); // throws on unrecognized format
      const fmt = args.format === 'html' ? 'html' : args.format === 'json' ? 'json' : 'md';
      const content = fmt === 'html' ? transcript.toHtml(norm, { id: norm.tool }) : fmt === 'json' ? JSON.stringify(norm, null, 2) : transcript.toMarkdown(norm, { id: norm.tool });
      return { tool: norm.tool, format: fmt, counts: norm.counts, content: content };
    },
  },

  {
    name: 'keyflip_cowork', title: 'Browse Cowork sessions',
    description: 'List/search Claude desktop Cowork (agent-mode) sessions across ALL accounts — title, first message, account, and the underlying Claude Code session. Read-only, local.',
    inputSchema: { type: 'object', properties: { search: { type: 'string' }, limit: { type: 'integer' } }, additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) {
      if (!ctx.appDataDir) return { cowork: [], note: 'desktop app not present (macOS only)' };
      const rows = require('./cowork').list(ctx, { search: args && args.search, limit: (args && args.limit) || 40 });
      return { cowork: rows.map(function (r) { return { sessionId: r.sessionId, title: r.title, account: r.account, cwd: r.cwd, lastActivityAt: r.lastActivityAt, cliSessionId: r.cliSessionId }; }) };
    },
  },
  {
    name: 'keyflip_chat', title: 'Read claude.ai Chat (experimental)',
    description: 'List the active account\'s claude.ai cloud Chat conversations (or fetch one with id). EXPERIMENTAL: uses the desktop app session cookie against the undocumented claude.ai API; needs a fresh Cloudflare cookie (works right after using the app) and may fail with 403 otherwise. Read-only.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Omit to list; set to fetch one conversation.' }, limit: { type: 'integer' } }, additionalProperties: false }, annotations: RO_NET,
    run: async function (ctx, args) {
      if (!ctx.appDataDir) throw new Error('reading claude.ai Chat needs the desktop app (macOS)');
      const chat = require('./chat');
      return (args && args.id) ? { conversation: await chat.get(ctx, args.id) } : await chat.list(ctx, { limit: (args && args.limit) || 30 });
    },
  },

  // ---- diagnostics / usage ----
  {
    name: 'keyflip_doctor', title: 'Diagnose config + connectivity',
    description: 'Health report: Claude config dir, login present, desktop app data, and each provider endpoint reachability. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO_NET,
    run: async function (ctx) { return await doctor.diagnose(ctx); },
  },
  {
    name: 'keyflip_usage_history', title: 'Usage trend + failover events',
    description: 'Recent per-account 5h/7d usage samples and autoswitch/failover events. Read-only.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) { const n = (args && args.limit) || 50; return { usage: history.readUsage(ctx, n), events: history.readEvents(ctx, n) }; },
  },

  // ---- backup ----
  {
    name: 'keyflip_backups', title: 'List backups',
    description: 'List keyflip metadata backups (newest first). Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO,
    run: async function (ctx) { return { backups: backup.list(ctx).map(function (b) { return { name: b.name, sizeBytes: b.sizeBytes, mtime: b.mtime }; }) }; },
  },
  {
    name: 'keyflip_backup_create', title: 'Create a backup',
    description: 'Snapshot keyflip metadata (no secrets). Ask the user first, then confirm=true.',
    inputSchema: { type: 'object', properties: confirmProp, required: ['confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const r = backup.create(ctx); return { created: r.name, files: r.files }; },
  },
  {
    name: 'keyflip_backup_restore', title: 'Restore a backup',
    description: 'Restore a backup by name or 1-based index (takes a pre-restore safety backup first). Ask the user first, then confirm=true.',
    inputSchema: { type: 'object', properties: { which: { type: 'string' }, confirm: confirmProp.confirm }, required: ['which', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); return backup.restore(ctx, args.which); },
  },

  // ---- skills marketplace ----
  {
    name: 'keyflip_skills', title: 'List installed skills',
    description: 'Skills keyflip installed into ~/.claude/skills. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO,
    run: async function (ctx) { return { skills: require('./skillstore').list(ctx) }; },
  },
  {
    name: 'keyflip_skill_add', title: 'Install a skill',
    description: 'Install a skill from a GitHub repo (owner/repo[@ref][/subdir]), a local directory, or a .tar.gz/.zip. Installs code the agent will run — ask the user first, then confirm=true.',
    inputSchema: { type: 'object', properties: { source: { type: 'string' }, confirm: confirmProp.confirm }, required: ['source', 'confirm'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    run: async function (ctx, args) { needConfirm(args); return { installed: await require('./skillstore').add(ctx, String(args.source), {}) }; },
  },
  {
    name: 'keyflip_skill_remove', title: 'Remove an installed skill',
    description: 'Remove a keyflip-installed skill (never the user\'s own). Ask the user first, then confirm=true.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, confirm: confirmProp.confirm }, required: ['name', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); require('./skillstore').remove(ctx, args.name); return { removed: args.name }; },
  },

  // ---- failover proxy ----
  {
    name: 'keyflip_proxy_status', title: 'Failover proxy status',
    description: 'Is the local failover proxy running? On what port, wired? Per-account request/token totals. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO,
    run: async function (ctx) {
      const meta = proxy.readMeta(ctx);
      const running = !!(meta && meta.pid && (function () { try { process.kill(meta.pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } })());
      return { running: running, port: meta && meta.port, wired: !!(meta && meta.wired), stats: proxy.stats(ctx) };
    },
  },
  {
    name: 'keyflip_proxy_control', title: 'Start/stop the failover proxy',
    description: 'Start or stop the command-activated localhost failover proxy (routes each request to the active account, fails over on 429/5xx). action="start"|"stop"; wire=true also sets ANTHROPIC_BASE_URL. Starting spawns a background process — ask the user first, then confirm=true.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['start', 'stop'] }, wire: { type: 'boolean' }, port: { type: 'integer' }, confirm: confirmProp.confirm }, required: ['action', 'confirm'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    run: async function (ctx, args) {
      needConfirm(args);
      if (args.action === 'start') { const r = proxy.start(ctx, { wire: !!args.wire, port: args.port }); return { started: !r.already, url: r.url, wired: r.wired, port: r.port }; }
      return proxy.stop(ctx);
    },
  },

  // ---- account login (add) ----
  {
    name: 'keyflip_login', title: 'Sign in and capture a Claude account',
    description: 'Add an account: sign in via the OFFICIAL browser flow in an ISOLATED config (the current login is NOT disturbed) and save the minted token as a keyflip profile. A HUMAN must approve in the browser that opens. The OAuth reuses the browser\'s current claude.ai session, so if the browser is signed into a different account this captures THAT and returns a "mismatch" error — clear it first with keyflip_browser_logout. Interactive + mutating — ask the user, then confirm=true. name/email are optional.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' }, confirm: confirmProp.confirm }, required: ['confirm'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async function (ctx, args) {
      needConfirm(args);
      try {
        const res = loginmod.performLogin(ctx, { email: args.email, name: args.name, stdio: 'ignore' });
        return { status: res.status, name: res.name, email: res.email };
      } catch (e) { throw new Error(e.code === 'mismatch' ? (e.message + ' — clear the browser with keyflip_browser_logout, then retry') : e.message); }
    },
  },
  {
    name: 'keyflip_logout', title: 'Sign out of live surfaces',
    description: 'Sign the machine OUT of the live Claude session on the selected surfaces — "cli" (Claude Code) and/or "browser" (claude.ai cookies, macOS). Saved keyflip profiles are KEPT (switch back anytime). Does NOT touch the desktop app. Mutating — ask the user, then confirm=true. surfaces defaults to ["cli"].',
    inputSchema: { type: 'object', properties: { surfaces: { type: 'array', items: { type: 'string', enum: ['cli', 'browser'] } }, confirm: confirmProp.confirm }, required: ['confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const surfaces = Array.isArray(args.surfaces) && args.surfaces.length ? args.surfaces : ['cli'];
      const out = [];
      if (surfaces.indexOf('cli') !== -1) { loginmod.cliLogout(ctx); out.push('cli'); }
      if (surfaces.indexOf('browser') !== -1 && ctx.platform === 'darwin') {
        browser.installed(ctx.home).forEach(function (b) { const r = browser.clearClaudeCookies(b, {}); if (r.ok) out.push('browser:' + b.id); });
      }
      return { loggedOut: out };
    },
  },

  // ---- browser session (Claude Chrome extension) ----
  {
    name: 'keyflip_consolidate', title: 'Sync chats across accounts',
    description: 'Merge the Claude desktop app\'s session stores so EVERY account sees all conversations (Cowork + Claude Code sessions). Requires the Claude desktop app to be CLOSED (it writes the app\'s store) — returns {ok:false, reason:"Claude still running"} otherwise. Mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { confirm: confirmProp.confirm }, required: ['confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      if (appctl.isClaudeRunning(ctx.platform)) return { ok: false, reason: 'Claude still running — close the desktop app first' };
      const c = appsessions.consolidate(ctx);
      return { ok: !!c.ok, merged: c.merged || 0, reason: c.reason || null };
    },
  },
  {
    name: 'keyflip_browser_status', title: 'Browser claude.ai account (Chrome extension)',
    description: 'macOS only. Which claude.ai account each Chromium browser (Chrome/Brave/Edge/Arc) is signed into, and whether it MATCHES the active CLI/desktop account. The Claude Chrome extension inherits the browser session, so a mismatch means its browser features cannot connect ("user mismatch"). Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO,
    run: async function (ctx) {
      if (ctx.platform !== 'darwin') return { supported: false, reason: 'macOS-only' };
      const st = loginmod.parseAuthStatus(exec.run('claude', ['auth', 'status'], undefined, { timeoutMs: 8000 }).stdout);
      const activeOrg = st && st.orgId;
      const browsers = browser.installed(ctx.home).map(function (b) {
        const ck = browser.readClaudeCookies(b, {});
        return { id: b.id, name: b.name, signedIn: !!ck, org: (ck && ck.org) || null, matchesActive: !!(ck && ck.org && activeOrg && ck.org === activeOrg) };
      });
      return { active: (st && st.email) || activeOrg || null, browsers: browsers };
    },
  },
  {
    name: 'keyflip_browser_logout', title: 'Clear the browser claude.ai session',
    description: 'macOS only. Clears the claude.ai cookies from Chromium browsers so the user can sign in as the right account and the Claude extension reconnects. Backs up each Cookies DB (reversible) and REFUSES while the browser is running (the user must quit it first). Mutating — ask the user, then confirm=true. Optional browserId=chrome|brave|edge|arc.',
    inputSchema: { type: 'object', properties: { browserId: { type: 'string' }, confirm: confirmProp.confirm }, required: ['confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      if (ctx.platform !== 'darwin') throw new Error('browser logout is macOS-only');
      const list = browser.installed(ctx.home).filter(function (b) { return !args.browserId || b.id === args.browserId; });
      if (!list.length) throw new Error('no matching installed browser (chrome|brave|edge|arc)');
      return { results: list.map(function (b) { const r = browser.clearClaudeCookies(b, {}); return { id: b.id, ok: !!r.ok, reason: r.reason || null, backup: r.backup || null }; }) };
    },
  },

  // ---- cross-machine migration ----
  {
    name: 'keyflip_migrate_export', title: 'Bundle accounts + sessions for another machine',
    description: 'Write a portable bundle of ALL accounts (secrets), providers (keys) and Claude Code session transcripts to `path`, to carry to another machine. Pass passphrase_file to encrypt it (AES-256-GCM) — STRONGLY recommended, the plaintext bundle contains login secrets. Set agents=true to ALSO carry OTHER AI agents\' home-level memory files (Cursor rules, Gemini GEMINI.md, Codex AGENTS.md/memories — markdown only, no secrets); narrow with agent_ids. Set agent_config=true to also carry those agents\' CONFIG files (MCP servers/settings) — secret-scanned + redacted by default, so keys never travel (re-enter them on the new machine). Set agent_config_secrets=true to carry the REAL keys instead — this REQUIRES passphrase_file (refused otherwise, so keys are never written in plaintext). Desktop-app/browser logins are machine-bound and NOT included. Writes a secret file — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, passphrase_file: { type: 'string', description: 'File whose contents are the encryption passphrase. Omit to write an UNENCRYPTED bundle.' }, no_sessions: { type: 'boolean' }, no_providers: { type: 'boolean' }, agents: { type: 'boolean', description: 'Also carry other agents\' home-level memory (markdown, no secrets).' }, agent_config: { type: 'boolean', description: 'Also carry other agents\' config files (MCP/settings), secret-scanned + redacted.' }, agent_config_secrets: { type: 'boolean', description: 'Carry the REAL agent-config keys (not redacted). Requires passphrase_file.' }, agent_ids: { type: 'array', items: { type: 'string', enum: ['cursor', 'gemini', 'codex', 'copilot', 'opencode', 'aider'] }, description: 'Limit agents/agent_config to these agent ids (default: all present).' }, confirm: confirmProp.confirm }, required: ['path', 'confirm'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async function (ctx, args) {
      needConfirm(args);
      const out = String(args.path);
      const pass = args.passphrase_file ? fs.readFileSync(String(args.passphrase_file), 'utf8').trim() : null;
      // On the programmatic path there is no human to heed a warning, so carrying real keys
      // to a plaintext file is a hard error — require encryption.
      if (args.agent_config_secrets && !pass) throw new Error('agent_config_secrets carries real API keys — pass passphrase_file to encrypt the bundle (or use agent_config for a redacted copy)');
      const built = migrate.buildBundle(ctx, { noSessions: !!args.no_sessions, noProviders: !!args.no_providers, agents: !!args.agents, agentConfig: !!(args.agent_config || args.agent_config_secrets), agentConfigSecrets: !!args.agent_config_secrets, agentIds: Array.isArray(args.agent_ids) ? args.agent_ids : undefined });
      if (!built.counts.accounts && !built.counts.transcripts && !built.counts.providers && !built.counts.agents && !built.counts.agentConfig && !built.counts.memory && !built.counts.config) throw new Error('nothing to migrate (no accounts, providers, transcripts, memory, config, or agents found)');
      let json = JSON.stringify(built.bundle);
      if (pass) json = sync.encrypt(json, pass);
      fs.writeFileSync(out, json + '\n', { mode: 0o600 });
      try { fs.chmodSync(out, 0o600); } catch (e) { /* non-POSIX FS */ }
      logmod.log('mcp migrate export -> ' + out);
      return { path: out, encrypted: !!pass, counts: built.counts, skippedAccounts: built.skippedAccounts };
    },
  },
  {
    name: 'keyflip_migrate_import', title: 'Merge a migration bundle into this machine',
    description: 'Merge a bundle from keyflip_migrate_export into THIS machine: accounts, providers and session transcripts are UNIONed — anything already here is KEPT, never clobbered, unless force=true. Pass passphrase_file if the bundle is encrypted. After merging it re-syncs the desktop app chat index (unless the app is open). Mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, passphrase_file: { type: 'string' }, force: { type: 'boolean' }, no_consolidate: { type: 'boolean' }, confirm: confirmProp.confirm }, required: ['path', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const raw = fs.readFileSync(String(args.path), 'utf8');
      let obj;
      try { obj = JSON.parse(raw); } catch (e) { throw new Error('that file is not valid JSON'); }
      if (obj && obj.magic === 'keyflip-sync') {
        const pass = args.passphrase_file ? fs.readFileSync(String(args.passphrase_file), 'utf8').trim() : null;
        if (!pass) throw new Error('this bundle is encrypted — pass passphrase_file');
        obj = JSON.parse(sync.decrypt(raw, pass));
      }
      const l = await lock.acquire(ctx.configDir);
      let res;
      try { res = migrate.applyBundle(ctx, obj, { force: !!args.force }); } finally { l.release(); }
      if (!args.no_consolidate && !appctl.isClaudeRunning(ctx.platform)) { try { appsessions.consolidate(ctx); } catch (e) { /* best-effort */ } }
      logmod.log('mcp migrate import: +' + res.transcripts.added + ' tx');
      return { accounts: res.accounts, providers: res.providers, transcripts: res.transcripts, memory: res.memory, agents: res.agents, agentConfig: res.agentConfig };
    },
  },
  {
    name: 'keyflip_migrate_push', title: 'Relay a migration bundle via WebDAV',
    description: 'Push the full encrypted bundle (accounts+providers+transcripts+memory) to a WebDAV URL, to pull on another machine. Passphrase REQUIRED (payload has secrets). Mutating (writes secrets to a remote) — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, passphrase_file: { type: 'string' }, user: { type: 'string' }, pass_file: { type: 'string' }, confirm: confirmProp.confirm }, required: ['url', 'passphrase_file', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const o = { url: String(args.url), user: args.user, passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim(),
        pass: args.pass_file ? fs.readFileSync(String(args.pass_file), 'utf8').trim() : null };
      const counts = await migrate.pushBundle(ctx, o);
      return { pushed: counts };
    },
  },
  {
    name: 'keyflip_migrate_pull', title: 'Pull + merge a WebDAV migration bundle',
    description: 'Pull the encrypted bundle from a WebDAV URL and MERGE it into this machine (union; existing kept unless force). Passphrase REQUIRED. Mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, passphrase_file: { type: 'string' }, user: { type: 'string' }, pass_file: { type: 'string' }, force: { type: 'boolean' }, confirm: confirmProp.confirm }, required: ['url', 'passphrase_file', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const o = { url: String(args.url), user: args.user, passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim(),
        pass: args.pass_file ? fs.readFileSync(String(args.pass_file), 'utf8').trim() : null };
      const pulled = await migrate.pullBundle(ctx, o);
      if (!pulled.found) throw new Error('no bundle at that URL');
      const l = await lock.acquire(ctx.configDir);
      let res; try { res = migrate.applyBundle(ctx, pulled.bundle, { force: !!args.force }); } finally { l.release(); }
      return { merged: res };
    },
  },
  {
    name: 'keyflip_fleet_status', title: 'See every associated machine (the fleet)',
    description: 'Read the FLEET: every associated keyflip machine that has checked in to the shared encrypted rendezvous — its accounts (+cached quota), active account, and recent chats with reply status (assistant = replied, user = waiting). Also flags chats that got a NEW reply since the last check. Read-only. Requires the fleet passphrase_file.',
    inputSchema: { type: 'object', properties: { passphrase_file: { type: 'string' } }, required: ['passphrase_file'], additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) {
      const fleet = require('./fleet');
      const b = fleet.bus(ctx, { passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim() });
      const statuses = fleet.readFleet(ctx, b); const nr = fleet.newReplies(ctx, statuses); fleet.saveSeen(ctx, nr.snapshot);
      // Read-only status must never surface credentials into the model/transcript — creds-free view.
      return { machines: statuses.map(fleet.sanitizeStatus), newReplies: nr.newReplies };
    },
  },
  {
    name: 'keyflip_fleet_switch', title: 'Queue an account switch on a remote machine',
    description: 'Queue a command telling ANOTHER fleet machine to switch to a given saved account — it applies on that machine\'s next `keyflip fleet push` (with the user\'s consent there). Mutating (writes to the shared rendezvous) — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { machine: { type: 'string', description: 'Target machine name or id.' }, account: { type: 'string' }, passphrase_file: { type: 'string' }, confirm: confirmProp.confirm }, required: ['machine', 'account', 'passphrase_file', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const fleet = require('./fleet');
      const b = fleet.bus(ctx, { passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim() });
      const m = fleet.readFleet(ctx, b).filter(function (s) { return s.name === args.machine || s.machineId === args.machine || s.machineId.indexOf(String(args.machine)) === 0; });
      if (m.length !== 1) throw new Error("no single fleet machine named '" + args.machine + "'");
      fleet.publish(ctx, b, {}); // publish our status so the target can TOFU-pin our key and verify us
      const cmd = fleet.queue(ctx, b, m[0].machineId, { type: 'switch', payload: { account: String(args.account) } });
      return { queued: { target: m[0].name, account: args.account, id: cmd.id } };
    },
  },
  {
    name: 'keyflip_fleet_send_account', title: 'Distribute an account to a remote machine',
    description: 'Queue a command handing a saved account (yours, or with from=<machine> one that machine published with credentials) to ANOTHER fleet machine — it saves it on its next `keyflip fleet push`. This is how machine A gives machine B an account that lives on machine C. Mutating (writes login secrets to the encrypted rendezvous) — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { account: { type: 'string' }, to: { type: 'string' }, from: { type: 'string', description: 'Relay: pull the account from this machine\'s published creds instead of your own.' }, passphrase_file: { type: 'string' }, confirm: confirmProp.confirm }, required: ['account', 'to', 'passphrase_file', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const fleet = require('./fleet'); const transfer = require('./transfer');
      const b = fleet.bus(ctx, { passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim() });
      const statuses = fleet.readFleet(ctx, b);
      const to = statuses.filter(function (s) { return s.name === args.to || s.machineId === args.to; })[0];
      if (!to) throw new Error("no fleet machine named '" + args.to + "'");
      let acct;
      if (args.from) { const from = statuses.filter(function (s) { return s.name === args.from || s.machineId === args.from; })[0]; acct = from && fleet.accountFrom(from, String(args.account)); if (!acct) throw new Error("'" + args.from + "' has not published account '" + args.account + "' with credentials"); }
      else { acct = transfer.buildExport(ctx).envelope.accounts.filter(function (a) { return a.name === String(args.account); })[0]; if (!acct) throw new Error("no local account '" + args.account + "'"); }
      fleet.publish(ctx, b, {}); // publish our status so the target can TOFU-pin our key and verify us
      const cmd = fleet.queue(ctx, b, to.machineId, { type: 'save-account', payload: { account: acct } });
      return { queued: { target: to.name, account: args.account, id: cmd.id } };
    },
  },
  {
    name: 'keyflip_fleet_trust', title: 'Re-pin a fleet machine\'s signing key after a legitimate re-key',
    description: 'Origin authentication: each fleet machine signs its commands with an Ed25519 key; a receiver trust-on-first-use PINS each peer\'s public key and REJECTS commands if that key later changes (a possible key-substitution attack via the shared folder). Use this ONLY when a machine legitimately re-keyed (fresh install / reset) and you want to trust its NEW key so its commands verify again. This overrides a security safety flag — confirm with the user that the change is expected. Mutating (updates the local pinned-key store) — confirm=true.',
    inputSchema: { type: 'object', properties: { machine: { type: 'string', description: 'Machine name or id whose current published key to (re)pin.' }, passphrase_file: { type: 'string' }, confirm: confirmProp.confirm }, required: ['machine', 'passphrase_file', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const fleet = require('./fleet');
      const b = fleet.bus(ctx, { passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim() });
      const m = fleet.readFleet(ctx, b).filter(function (s) { return s.name === args.machine || s.machineId === args.machine; })[0];
      if (!m) throw new Error("no fleet machine named '" + args.machine + "'");
      if (!m.pubKey) throw new Error("'" + args.machine + "' has not published a signing key yet");
      const pinned = fleet.knownKeys(ctx)[m.machineId];
      fleet.trustKey(ctx, m.machineId, m.pubKey);
      return { trusted: { machine: m.name, machineId: m.machineId, changed: !!pinned && pinned !== m.pubKey } };
    },
  },
  {
    name: 'keyflip_fleet_keys', title: 'Audit fleet machine signing keys (origin-auth trust state)',
    description: 'List every fleet machine\'s TOFU-pinned Ed25519 signing-key fingerprint and whether the machine\'s currently-published key still MATCHES the pin (status: ok / CHANGED = possible key substitution / unpinned / offline). Read-only — use to audit the origin-auth trust store before trusting or acting on a machine.',
    inputSchema: { type: 'object', properties: { passphrase_file: { type: 'string' } }, required: ['passphrase_file'], additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) {
      const fleet = require('./fleet');
      const b = fleet.bus(ctx, { passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim() });
      return { keys: fleet.keyReport(ctx, fleet.readFleet(ctx, b)) };
    },
  },
  {
    name: 'keyflip_fleet_collect', title: 'Gather every account published across the fleet onto this machine',
    description: 'Import EVERY account that fleet machines have published WITH credentials (via `fleet push --with-secrets`) onto THIS machine, deduped by name. Existing accounts are kept unless force=true. Mutating (writes login secrets locally) — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { passphrase_file: { type: 'string' }, force: { type: 'boolean' }, confirm: confirmProp.confirm }, required: ['passphrase_file', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const fleet = require('./fleet'); const transfer = require('./transfer');
      const b = fleet.bus(ctx, { passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim() });
      const seen = Object.create(null); const toImport = [];
      fleet.readFleet(ctx, b).forEach(function (s) { Object.keys((s.creds) || {}).forEach(function (name) { if (seen[name]) return; seen[name] = 1; const a = fleet.accountFrom(s, name); if (a) toImport.push(a); }); });
      if (!toImport.length) throw new Error('no accounts published with credentials across the fleet (machines must `keyflip fleet push --with-secrets`)');
      const l = await lock.acquire(ctx.configDir);
      let res; try { res = transfer.applyImport(ctx, { format: transfer.FORMAT, version: transfer.VERSION, accounts: toImport }, { force: !!args.force }); } finally { l.release(); }
      return { collected: res };
    },
  },
  {
    name: 'keyflip_account_remove', title: 'Delete a saved account',
    description: 'Permanently delete a saved account and its stored credential from THIS machine. IRREVERSIBLE — the credential cannot be recovered. Refuses if the account is the active one that a running Claude session is using (close it first, or force=true). Mutating + destructive — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Account name (from keyflip_list).' }, force: { type: 'boolean', description: 'Delete even if it is the active account in use.' }, confirm: confirmProp.confirm }, required: ['name', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const name = core.resolveProfile(ctx, String(args.name));
      if (!name) throw new Error("no such account: '" + args.name + "' (use keyflip_list)");
      const em = profiles.email(ctx.configDir, name);
      if (!args.force && em && em === core.currentEmail(ctx)) {
        const live = appctl.claudeInstances(ctx.home);
        if (live.length) throw new Error("'" + em + "' is the active account " + live.length + ' running Claude session(s) are using — close them first, or set force=true');
      }
      const l = await lock.acquire(ctx.configDir);
      try { core.removeProfile(ctx, name); } finally { l.release(); }
      return { removed: name };
    },
  },
  {
    name: 'keyflip_provider_remove', title: 'Delete a saved provider',
    description: 'Permanently delete a saved provider endpoint and its stored API key/bearer from THIS machine. IRREVERSIBLE. Mutating + destructive — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Provider name (from keyflip_providers).' }, confirm: confirmProp.confirm }, required: ['name', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const provider = require('./provider');
      if (!provider.exists(ctx, String(args.name))) throw new Error("no such provider: '" + args.name + "' (use keyflip_providers)");
      const l = await lock.acquire(ctx.configDir);
      try { provider.remove(ctx, String(args.name)); } finally { l.release(); }
      return { removed: String(args.name) };
    },
  },

  // ---- CLI<->MCP parity tools (2026-07-07 audit): gateway / mcpreg / speedtest / share / sync / link / transfer ----
  {
    name: 'keyflip_gateway_status', title: 'Is the Claude DESKTOP app routed through a provider?',
    description: 'Report whether the Claude DESKTOP app is currently pointed at a third-party gateway/provider vs first-party Anthropic. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO,
    run: async function (ctx) { const g = require('./desktopgw').active(ctx); return { gateway: g ? g.provider : null, firstParty: !g }; },
  },
  {
    name: 'keyflip_gateway_use', title: 'Route the Claude desktop app through a provider',
    description: 'Point the Claude DESKTOP app at a saved provider (gateway); takes effect after the app restarts. Mutating (rewrites the desktop app config) — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { provider: { type: 'string' }, confirm: confirmProp.confirm }, required: ['provider', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); if (!provider.exists(ctx, String(args.provider))) throw new Error("no such provider: '" + args.provider + "'"); const l = await lock.acquire(ctx.configDir); let r; try { r = require('./desktopgw').use(ctx, String(args.provider)); } finally { l.release(); } return { gateway: String(args.provider), dirs: r.dirs, note: 'restart the desktop app to apply' }; },
  },
  {
    name: 'keyflip_gateway_off', title: 'Restore the Claude desktop app to first-party',
    description: 'Restore the Claude DESKTOP app to first-party (Anthropic), undoing a gateway; takes effect after the app restarts. Mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { confirm: confirmProp.confirm }, required: ['confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const l = await lock.acquire(ctx.configDir); try { require('./desktopgw').restore(ctx); } finally { l.release(); } return { restored: true, note: 'restart the desktop app to apply' }; },
  },
  {
    name: 'keyflip_mcpreg_list', title: 'List registered third-party MCP servers',
    description: 'List the MCP servers keyflip has registered (that it can enable/disable in Claude Code / Desktop configs). Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO,
    run: async function (ctx) { return { servers: require('./mcpreg').list(ctx) }; },
  },
  {
    name: 'keyflip_mcpreg_set', title: 'Register/update a third-party MCP server',
    description: 'Register (or update) a named MCP server definition (command + args + env) in keyflip\'s registry so it can be enabled on Claude Code / Desktop. Mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, env: { type: 'object', additionalProperties: { type: 'string' } }, confirm: confirmProp.confirm }, required: ['name', 'command', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const l = await lock.acquire(ctx.configDir); let e; try { e = require('./mcpreg').add(ctx, String(args.name), { command: String(args.command), args: args.args || [], env: args.env || {} }); } finally { l.release(); } return { registered: String(args.name), entry: e }; },
  },
  {
    name: 'keyflip_mcpreg_enable', title: 'Enable/disable a registered MCP server on a surface',
    description: 'Enable or disable a registered MCP server on a surface — "claude-code" or "claude-desktop". Mutating (writes the target app config) — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, surface: { type: 'string', enum: ['claude-code', 'claude-desktop'] }, enabled: { type: 'boolean' }, confirm: confirmProp.confirm }, required: ['name', 'surface', 'enabled', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const l = await lock.acquire(ctx.configDir); let r; try { r = require('./mcpreg').setEnabled(ctx, String(args.name), String(args.surface), !!args.enabled); } finally { l.release(); } return { name: String(args.name), surface: String(args.surface), enabled: !!args.enabled, result: r }; },
  },
  {
    name: 'keyflip_mcpreg_remove', title: 'Remove a registered MCP server',
    description: 'Remove a registered MCP server from keyflip\'s registry and unhook it from both surfaces. Mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, confirm: confirmProp.confirm }, required: ['name', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const l = await lock.acquire(ctx.configDir); try { require('./mcpreg').remove(ctx, String(args.name)); } finally { l.release(); } return { removed: String(args.name) }; },
  },
  {
    name: 'keyflip_speedtest', title: 'Rank a provider\'s endpoints by latency (read-only)',
    description: 'Measure and RANK a provider\'s candidate endpoints by latency WITHOUT changing anything (read-only diagnostic; does NOT switch the active baseUrl — run `keyflip speedtest` on the CLI to also apply the fastest). Returns per-endpoint ms + the fastest URL.',
    inputSchema: { type: 'object', properties: { provider: { type: 'string' } }, required: ['provider'], additionalProperties: false }, annotations: RO_NET,
    run: async function (ctx, args) { const r = await provider.speedtest(ctx, String(args.provider), { noPersist: true }); return { results: r.results, fastest: r.fastest }; },
  },
  {
    name: 'keyflip_share', title: 'Build a keyflip:// share link',
    description: 'Build a keyflip:// import link for a saved provider or account. For a provider, no_secrets=true omits the API key (pointer only); account links are ALWAYS pointer-only (never carry the OAuth token). Read-only (builds a string).',
    inputSchema: { type: 'object', properties: { resource: { type: 'string', enum: ['provider', 'account'] }, name: { type: 'string' }, no_secrets: { type: 'boolean' } }, required: ['resource', 'name'], additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) { return { url: require('./share').build(ctx, String(args.resource), String(args.name), { noSecrets: !!args.no_secrets }) }; },
  },
  {
    name: 'keyflip_share_apply', title: 'Import from a keyflip:// share link',
    description: 'Parse and APPLY a keyflip:// import link (saves the provider, or creates a pointer-only account). Mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, confirm: confirmProp.confirm }, required: ['url', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const share = require('./share'); const parsed = share.parse(String(args.url)); const l = await lock.acquire(ctx.configDir); let r; try { r = share.apply(ctx, parsed); } finally { l.release(); } return { imported: r }; },
  },
  {
    name: 'keyflip_sync_test', title: 'Test a WebDAV sync endpoint',
    description: 'Check that a WebDAV URL is reachable for encrypted account sync. Read-only network probe. pass_file (optional) is a FILE holding the WebDAV password — never pass secrets inline.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, user: { type: 'string' }, pass_file: { type: 'string' } }, required: ['url'], additionalProperties: false }, annotations: RO_NET,
    run: async function (ctx, args) { const pass = args.pass_file ? fs.readFileSync(String(args.pass_file), 'utf8').trim() : null; return await sync.test({ url: String(args.url), user: args.user || null, pass: pass }); },
  },
  {
    name: 'keyflip_sync_push', title: 'Push encrypted accounts to WebDAV',
    description: 'Encrypt this machine\'s accounts (passphrase from passphrase_file) and PUT them to a WebDAV URL. Secrets are only ever read from files, never argv. Mutating (writes to the remote) — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, passphrase_file: { type: 'string' }, user: { type: 'string' }, pass_file: { type: 'string' }, confirm: confirmProp.confirm }, required: ['url', 'passphrase_file', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const o = { url: String(args.url), user: args.user || null, pass: args.pass_file ? fs.readFileSync(String(args.pass_file), 'utf8').trim() : null, passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim() }; return await sync.push(ctx, o); },
  },
  {
    name: 'keyflip_sync_pull', title: 'Pull + merge encrypted accounts from WebDAV',
    description: 'GET the encrypted snapshot from a WebDAV URL, decrypt it (passphrase_file), and MERGE locally (a safety backup of current credentials is written first; existing accounts kept unless force=true). Mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, passphrase_file: { type: 'string' }, user: { type: 'string' }, pass_file: { type: 'string' }, force: { type: 'boolean' }, confirm: confirmProp.confirm }, required: ['url', 'passphrase_file', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const o = { url: String(args.url), user: args.user || null, pass: args.pass_file ? fs.readFileSync(String(args.pass_file), 'utf8').trim() : null, passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim() }; const p = await sync.pull(ctx, o); if (!p.found) throw new Error('no snapshot at that URL'); const l = await lock.acquire(ctx.configDir); let res; try { res = sync.apply(ctx, p, { force: !!args.force }); } finally { l.release(); } return { remote: p.meta, applied: res }; },
  },
  {
    name: 'keyflip_links', title: 'List directory→account pins',
    description: 'List the directory→account pins (used by `keyflip run` to auto-select an account per directory). Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO,
    run: async function (ctx) { return { links: require('./links').readAll(ctx) }; },
  },
  {
    name: 'keyflip_link', title: 'Pin a directory to an account',
    description: 'Pin a directory (absolute path) to a saved account so `keyflip run` there uses it. Set remove=true to unpin (account not needed then). Mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { dir: { type: 'string' }, account: { type: 'string' }, remove: { type: 'boolean' }, confirm: confirmProp.confirm }, required: ['dir', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const links = require('./links'); const dir = String(args.dir); const l = await lock.acquire(ctx.configDir); try { if (args.remove) { return { unlinked: links.remove(ctx, dir) ? dir : null }; } const name = core.resolveProfile(ctx, String(args.account || '')); if (!name) throw new Error("no such account: '" + args.account + "'"); links.set(ctx, dir, name); return { linked: { dir: dir, account: name } }; } finally { l.release(); } },
  },
  {
    name: 'keyflip_transfer_pull', title: 'Pull + merge a bundle from a LAN peer',
    description: 'Pull the full bundle (accounts + providers + transcripts + memory) from a machine running `keyflip transfer serve`, using its one-time code, and MERGE it (existing entries kept unless force=true). host is "<host:port>" shown on the serving machine. Mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { host: { type: 'string' }, code: { type: 'string' }, force: { type: 'boolean' }, confirm: confirmProp.confirm }, required: ['host', 'code', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const bundle = await require('./lantransfer').pull({ host: String(args.host), code: String(args.code) }); const l = await lock.acquire(ctx.configDir); let res; try { res = require('./migrate').applyBundle(ctx, bundle, { force: !!args.force }); } finally { l.release(); } return { merged: { accounts: res.accounts, providers: res.providers, transcripts: res.transcripts } }; },
  },
  {
    name: 'keyflip_transfer_relay_pull', title: 'Pull + merge a bundle via the internet relay',
    description: 'One-shot pull of a bundle a peer uploaded with `keyflip transfer serve --relay`, THROUGH a user-controlled relay (a synced-folder path OR a WebDAV URL — no LAN needed), using the one-time code shown on the sending machine ("<rendezvous>-<key>"). Decrypts with the code, MERGES it (existing entries kept unless force=true), then deletes the blob from the relay (one-shot). The relay is zero-knowledge — the key half never reaches it. Mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { relay: { type: 'string', description: 'A synced-folder path or a WebDAV URL.' }, code: { type: 'string', description: 'The "<rendezvous>-<key>" one-time code shown on the sender.' }, user: { type: 'string', description: 'WebDAV username (URL relay).' }, pass_file: { type: 'string', description: 'File holding the WebDAV password (URL relay) — never the literal secret.' }, force: { type: 'boolean' }, confirm: confirmProp.confirm }, required: ['relay', 'code', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const rt = require('./relaytransfer');
      const r = await rt.pull(ctx, { relay: String(args.relay), code: String(args.code), user: args.user, pass: args.pass_file ? fs.readFileSync(String(args.pass_file), 'utf8').trim() : undefined, fetch: (typeof fetch !== 'undefined' ? fetch : undefined) });
      if (!r.found) throw new Error('no transfer at that relay for this code (already picked up, expired, or wrong code)');
      const l = await lock.acquire(ctx.configDir);
      let res; try { res = require('./migrate').applyBundle(ctx, r.bundle, { force: !!args.force }); } finally { l.release(); }
      try { await r.cleanup(); } catch (e) { /* one-shot delete is best-effort; the relay TTL sweeps it otherwise */ }
      return { merged: { accounts: res.accounts, providers: res.providers, transcripts: res.transcripts } };
    },
  },
  {
    name: 'keyflip_autoswitch_tick', title: 'Evaluate usage once and auto-switch if over threshold',
    description: 'Run ONE autoswitch evaluation: check the active account\'s usage headroom and, if it is at/over the threshold, switch the CLI to the next available account. Returns the decision (state / headroom / switchedTo). Mutating (MAY switch the active account) — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { threshold: { type: 'number', description: 'Utilization % at which to switch (default 90).' }, confirm: confirmProp.confirm }, required: ['confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      // Mirror the CLI: lock ONLY the switch, not the (network) usage evaluation.
      const opts = { performSwitch: function (name) { return (async function () { const l = await lock.acquire(ctx.configDir); try { return core.performSwitch(ctx, name); } finally { l.release(); } })(); } };
      if (args.threshold !== undefined) opts.threshold = args.threshold;
      return await require('./autoswitch').tick(ctx, opts);
    },
  },
  {
    name: 'keyflip_autoswitch_service', title: 'Run autoswitch unattended (background service)',
    description: 'Install/remove/inspect the UNATTENDED autoswitch service (launchd on macOS, cron on Linux) that runs `keyflip autoswitch --once` on an interval — so account rotation happens on its own without a terminal open (the fix for "autoswitch never runs"). action="status" (read) | "install" | "remove". install schedules automatic account switching at the threshold — for install/remove, ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['status', 'install', 'remove'] }, interval: { type: 'integer', description: 'Seconds between checks (default 300, clamped 60..21600).' }, threshold: { type: 'integer', description: 'Utilization % to switch at.' }, strategy: { type: 'string', enum: ['best', 'next-available'] }, group: { type: 'string' }, confirm: confirmProp.confirm }, required: ['action', 'confirm'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async function (ctx, args) {
      const svc = require('./autoswitchservice');
      if (args.action === 'status') return { autoswitchService: svc.status(ctx, { home: ctx.home }) };
      needConfirm(args);
      if (args.action === 'remove') return { removed: svc.uninstall(ctx, { home: ctx.home }) };
      const r = svc.install(ctx, { home: ctx.home, interval: args.interval, threshold: args.threshold, strategy: args.strategy, group: args.group });
      if (!r.ok) throw new Error('could not install the autoswitch service: ' + (r.reason || r.detail || 'unknown'));
      return { installed: r };
    },
  },

  // ---- Wave-1 features (2026-07-07): groups / budget / import-env / shell-init / audit-log / notify ----
  {
    name: 'keyflip_groups', title: 'List account groups/tags',
    description: 'Account groups (tags) used to SCOPE rotation and failover to a pool. With no args returns { groups: {group->members}, tags: {account->tags} }; with group="<g>" returns that group\'s members. Read-only.',
    inputSchema: { type: 'object', properties: { group: { type: 'string' } }, additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) { const groups = require('./groups'); if (args && args.group) return { group: String(args.group), members: groups.membersOf(ctx, String(args.group)) }; return { groups: groups.listGroups(ctx), tags: groups.readAll(ctx) }; },
  },
  {
    name: 'keyflip_group_tag', title: 'Tag an account into a group',
    description: 'Add one or more group tags to an account so group-scoped rotation (`keyflip next --group <g>`) and failover can target it. Mutating — ask the user first, then confirm=true.',
    inputSchema: { type: 'object', properties: { account: { type: 'string' }, groups: { type: 'array', items: { type: 'string' } }, confirm: confirmProp.confirm }, required: ['account', 'groups', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const g = require('./groups'); const name = core.resolveProfile(ctx, String(args.account)); if (!name) throw new Error("no such account: '" + args.account + "'"); const tags = Array.isArray(args.groups) ? args.groups : []; if (!tags.length) throw new Error('provide at least one group'); const l = await lock.acquire(ctx.configDir); try { let cur = g.tagsFor(ctx, name); tags.forEach(function (t) { cur = g.addTag(ctx, name, String(t)); }); return { account: name, tags: cur }; } finally { l.release(); } },
  },
  {
    name: 'keyflip_group_untag', title: 'Remove an account from a group',
    description: 'Remove a group tag from an account. Mutating — ask the user first, then confirm=true.',
    inputSchema: { type: 'object', properties: { account: { type: 'string' }, group: { type: 'string' }, confirm: confirmProp.confirm }, required: ['account', 'group', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const g = require('./groups'); const name = core.resolveProfile(ctx, String(args.account)); if (!name) throw new Error("no such account: '" + args.account + "'"); const l = await lock.acquire(ctx.configDir); try { return { account: name, tags: g.removeTag(ctx, name, String(args.group)) }; } finally { l.release(); } },
  },
  {
    name: 'keyflip_budget_status', title: 'Usage budgets + breach alerts',
    description: 'Report per-account usage BUDGETS (5-hour / 7-day % ceilings, per account or a "*" default that covers every account) alongside current cached usage, flagging every account/window at/over its ceiling ("breach") or within 10% ("warn"). Reads keyflip\'s usage cache — does NOT fetch (run keyflip_usage_history first to refresh). Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO,
    run: async function (ctx) { return require('./budget').status(ctx); },
  },
  {
    name: 'keyflip_budget_set', title: 'Set a usage-budget ceiling',
    description: 'Set/merge a usage-budget ceiling for an account: five_hour_pct and/or seven_day_pct (0-100). Use account "*" for the default covering every account. Pass null for a window to remove just that ceiling; omit to leave unchanged. Mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { account: { type: 'string' }, five_hour_pct: { type: ['number', 'null'] }, seven_day_pct: { type: ['number', 'null'] }, confirm: confirmProp.confirm }, required: ['account', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const budget = require('./budget'); const raw = String(args.account); const name = (raw === '*' || raw === 'default' || raw === 'defaults') ? '*' : (core.resolveProfile(ctx, raw) || raw); const limits = {}; if (args.five_hour_pct !== undefined) limits.fiveHourPct = args.five_hour_pct; if (args.seven_day_pct !== undefined) limits.sevenDayPct = args.seven_day_pct; const l = await lock.acquire(ctx.configDir); try { return { set: { account: name, limits: budget.setLimit(ctx, name, limits) } }; } finally { l.release(); } },
  },
  {
    name: 'keyflip_budget_clear', title: 'Clear an account\'s usage budget',
    description: 'Remove ALL usage-budget ceilings for an account (or the "*" defaults). Mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { account: { type: 'string' }, confirm: confirmProp.confirm }, required: ['account', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const budget = require('./budget'); const raw = String(args.account); const name = (raw === '*' || raw === 'default' || raw === 'defaults') ? '*' : (core.resolveProfile(ctx, raw) || raw); const l = await lock.acquire(ctx.configDir); try { return { cleared: budget.clear(ctx, name) ? name : null }; } finally { l.release(); } },
  },
  {
    name: 'keyflip_import_env', title: 'Import providers from a .env / environment',
    description: 'Detect Anthropic/OpenAI credentials in a .env file (pass `path`) or the current process environment (omit `path`) and save each as a keyflip provider endpoint. Returns what was imported with every key REDACTED — keys are never echoed back. Mutating — ask the user first, then confirm=true.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path to a .env file. Omit to import from the current environment.' }, confirm: confirmProp.confirm }, required: ['confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const importcreds = require('./importcreds'); const res = args.path ? importcreds.fromFile(ctx, String(args.path)) : importcreds.fromEnv(ctx, process.env); const l = await lock.acquire(ctx.configDir); try { return importcreds.apply(ctx, res.candidates); } finally { l.release(); } },
  },
  {
    name: 'keyflip_shell_init', title: 'Shell auto-activation hook',
    description: 'Return the shell snippet (bash/zsh/fish) for direnv-style account auto-activation: once added to the shell rc file, cd-ing into a directory pinned with `keyflip link` auto-switches the CLI to that account. Install: `eval "$(keyflip shell-init zsh)"` (fish: `keyflip shell-init fish | source`). Read-only — returns text only.',
    inputSchema: { type: 'object', properties: { shell: { type: 'string', enum: ['bash', 'zsh', 'fish'] } }, required: ['shell'], additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) { const shellhook = require('./shellhook'); return { shell: String(args.shell), snippet: shellhook.hook(String(args.shell)) }; },
  },
  {
    name: 'keyflip_audit_log', title: 'Action / audit log',
    description: 'Recent entries from keyflip\'s action log (account switches, adds, cleans, errors) at <configDir>/logs/keyflip.log. Filters: grep (case-insensitive substring on the message) and since (ISO; entries at/after it). Newest last. Read-only.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', description: 'Max entries (newest). Default 50.' }, grep: { type: 'string' }, since: { type: 'string', description: 'ISO timestamp.' } }, additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) { args = args || {}; return { entries: auditview.tail(ctx, { limit: args.limit, grep: args.grep, since: args.since }) }; },
  },
  {
    name: 'keyflip_notify_status', title: 'Notification settings',
    description: 'Show keyflip\'s outbound notification config: webhook URL (if any), enabled events (quota/switch/fleet-reply/…), and whether macOS desktop banners are on. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO,
    run: async function (ctx) { const c = require('./notify').getConfig(ctx); return { webhook: c.webhook, events: c.events, desktop: c.desktop }; },
  },
  {
    name: 'keyflip_notify_set', title: 'Configure notifications',
    description: 'Set the notification webhook (http(s) only), the enabled event list, and/or the macOS desktop-banner toggle. keyflip POSTs a NON-SECRET summary { event, payload, at } on each enabled event. Pass webhook:null to clear it. Mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { webhook: { type: ['string', 'null'] }, events: { type: 'array', items: { type: 'string' } }, desktop: { type: 'boolean' }, confirm: confirmProp.confirm }, required: ['confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const patch = {}; if ('webhook' in args) patch.webhook = args.webhook == null ? null : String(args.webhook); if (Array.isArray(args.events)) patch.events = args.events; if (typeof args.desktop === 'boolean') patch.desktop = args.desktop; const l = await lock.acquire(ctx.configDir); try { return { notify: require('./notify').setConfig(ctx, patch) }; } finally { l.release(); } },
  },
  {
    name: 'keyflip_notify_test', title: 'Send a test notification',
    description: 'Fire a synthetic "test" event through the configured sinks (webhook POST and/or macOS banner) so the user can verify wiring. Outbound side effect — ask the user first, then confirm=true.',
    inputSchema: { type: 'object', properties: { confirm: confirmProp.confirm }, required: ['confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); return await require('./notify').test(ctx); },
  },
  // ---- Wave-2 (strategic): cost / team pool / router+cache (orchestrator/policy/integrations/vault appended after the array) ----
  {
    name: 'keyflip_cost_status', title: 'Aggregate account spend / utilization',
    description: 'Aggregate cost/utilization across all saved accounts from keyflip\'s usage cache. Reports 5h/7d rate-limit utilization for every account; reports per-token spend (costUSD) ONLY when the cache carries token totals — the OAuth usage API is percentage-based, so a dollar figure is never inferred from a percentage. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO,
    run: async function (ctx) { return require('./cost').unified(ctx); },
  },
  {
    name: 'keyflip_cost_predict', title: 'Project time-to-limit for an account',
    description: 'From the recorded usage trend, project time-to-limit for the 5h and 7d rate windows of one account: current pct, rate-per-hour, and ETA minutes (null when unknown — never fabricated). Read-only.',
    inputSchema: { type: 'object', properties: { account: { type: 'string' } }, required: ['account'], additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) { const name = core.resolveProfile(ctx, String(args.account)); if (!name) throw new Error("no such account: '" + args.account + "'"); return require('./cost').predict(ctx, name); },
  },
  {
    name: 'keyflip_cost_by_project', title: 'Per-project token + cost attribution',
    description: 'Scan local ~/.claude/projects transcripts and attribute token usage + estimated cost per working directory / repo. Token counts are MEASURED; costUSD is an ESTIMATE from a dated static pricing snapshot. Work is capped. Read-only.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } }, additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) { return require('./cost').attribute(ctx, { maxSessions: args && args.limit }); },
  },
  {
    name: 'keyflip_team_members', title: 'List team-pool members and account visibility',
    description: 'Read a shared, encrypted TEAM credential pool: its MEMBERS (id + role) and a CREDS-FREE summary of which accounts it holds + the minimum role each requires. Read-only. Requires the pool passphrase_file.',
    inputSchema: { type: 'object', properties: { dir: { type: 'string' }, pool: { type: 'string' }, passphrase_file: { type: 'string' } }, required: ['dir', 'pool', 'passphrase_file'], additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) { const teampool = require('./teampool'); const view = teampool.read(ctx, { dir: String(args.dir), pool: String(args.pool), passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim() }); if (!view) throw new Error("no such pool '" + args.pool + "'"); return { pool: view.pool, members: view.members, accounts: view.accounts, at: view.at }; },
  },
  {
    name: 'keyflip_team_publish', title: 'Publish accounts to a shared team pool',
    description: 'Build an ENCRYPTED team credential pool from THIS machine\'s saved accounts into a shared folder, tagging each account with the minimum role allowed to pull it. `accounts` optionally selects names + per-account roles; omit to publish every local account as "member". Mutating (writes encrypted login secrets to a shared folder) — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { dir: { type: 'string' }, pool: { type: 'string' }, passphrase_file: { type: 'string' }, accounts: { type: 'object', additionalProperties: { type: 'string', enum: ['owner', 'member'] } }, owner: { type: 'string' }, confirm: confirmProp.confirm }, required: ['dir', 'pool', 'passphrase_file', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const teampool = require('./teampool'); return { published: teampool.publish(ctx, { dir: String(args.dir), pool: String(args.pool), passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim(), accounts: args.accounts || undefined, owner: args.owner ? String(args.owner) : undefined }) }; },
  },
  {
    name: 'keyflip_team_pull', title: 'Pull role-visible accounts from a team pool',
    description: 'Import from a shared encrypted team pool ONLY the accounts your role (as: owner|member, default member) may see. Existing accounts skipped unless force=true. Mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { dir: { type: 'string' }, pool: { type: 'string' }, passphrase_file: { type: 'string' }, as: { type: 'string', enum: ['owner', 'member'] }, force: { type: 'boolean' }, confirm: confirmProp.confirm }, required: ['dir', 'pool', 'passphrase_file', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const teampool = require('./teampool'); return { pulled: teampool.pull(ctx, { dir: String(args.dir), pool: String(args.pool), passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim(), asRole: args.as ? String(args.as) : 'member', force: !!args.force }) }; },
  },
  {
    name: 'keyflip_team_member_add', title: 'Add or update a team-pool member',
    description: 'Add a member (or change role: owner|member) in a shared encrypted team pool. Mutating (rewrites the encrypted pool) — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { dir: { type: 'string' }, pool: { type: 'string' }, passphrase_file: { type: 'string' }, id: { type: 'string' }, role: { type: 'string', enum: ['owner', 'member'] }, confirm: confirmProp.confirm }, required: ['dir', 'pool', 'passphrase_file', 'id', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const teampool = require('./teampool'); return { members: teampool.addMember(ctx, { dir: String(args.dir), pool: String(args.pool), passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim(), id: String(args.id), role: args.role ? String(args.role) : 'member' }) }; },
  },
  {
    name: 'keyflip_team_member_remove', title: 'Remove a team-pool member',
    description: 'Remove a member from a shared encrypted team pool (last owner cannot be removed). Mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { dir: { type: 'string' }, pool: { type: 'string' }, passphrase_file: { type: 'string' }, id: { type: 'string' }, confirm: confirmProp.confirm }, required: ['dir', 'pool', 'passphrase_file', 'id', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const teampool = require('./teampool'); return { members: teampool.removeMember(ctx, { dir: String(args.dir), pool: String(args.pool), passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim(), id: String(args.id) }) }; },
  },
  {
    name: 'keyflip_route_list', title: 'List model routes',
    description: 'Model→provider routing pins and whether arbitrage (always-cheapest) mode is on. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO,
    run: async function (ctx) { return require('./router').get(ctx); },
  },
  {
    name: 'keyflip_cache_status', title: 'Response cache status',
    description: 'Response-cache stats: entry count, cap, total bytes and oldest/newest timestamps. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO,
    run: async function (ctx) { return require('./router').cacheStatus(ctx); },
  },
  {
    name: 'keyflip_route_set', title: 'Pin a model to a provider',
    description: 'Pin a model onto a configured provider (overrides cheapest-provider selection unless arbitrage is on). Ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { model: { type: 'string' }, provider: { type: 'string' }, confirm: confirmProp.confirm }, required: ['model', 'provider', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); return require('./router').setRoute(ctx, String(args.model), String(args.provider)); },
  },
  {
    name: 'keyflip_route_clear', title: 'Clear a model route',
    description: 'Remove the routing pin for a model (falls back to cheapest). Ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { model: { type: 'string' }, confirm: confirmProp.confirm }, required: ['model', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); return { cleared: require('./router').clearRoute(ctx, String(args.model)) }; },
  },
  {
    name: 'keyflip_route_arbitrage', title: 'Toggle always-cheapest routing',
    description: 'Turn model-cost ARBITRAGE on/off — when on, routing always picks the cheapest configured provider that serves a model (overriding pins). Ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { on: { type: 'boolean' }, confirm: confirmProp.confirm }, required: ['on', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); return { arbitrage: require('./router').setArbitrage(ctx, !!args.on) }; },
  },
  {
    name: 'keyflip_cache_purge', title: 'Purge the response cache',
    description: 'Delete cached responses — all, or only those older than older_than_ms. Ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { older_than_ms: { type: 'number' }, confirm: confirmProp.confirm }, required: ['confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); return require('./router').cachePurge(ctx, { olderThanMs: typeof args.older_than_ms === 'number' ? args.older_than_ms : undefined }); },
  },
  // ---- Wave-3: swarm (own-fleet exec) + config (settings) ----
  {
    name: 'keyflip_swarm_run', title: 'Run one command across YOUR OWN enrolled fleet machines',
    description: 'Queue an exec command onto YOUR OWN fleet machines (the ones you enrolled in your encrypted rendezvous — NOT a tool for reaching third-party targets). The command travels as an ARGV ARRAY (command + args[]) spawned with NO shell (no injection surface). With no `to`, it fans out to every checked-in machine. Nothing runs until each target drains WITH CONSENT (`keyflip swarm drain --allow-exec`, off by default). Collect with keyflip_swarm_results. Mutating (writes signed commands to the shared rendezvous) — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, to: { type: 'string' }, passphrase_file: { type: 'string' }, confirm: confirmProp.confirm }, required: ['command', 'passphrase_file', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const fleet = require('./fleet'); const swarm = require('./swarm'); const b = fleet.bus(ctx, { passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim() }); fleet.publish(ctx, b, {}); const q = swarm.queueExec(ctx, b, { command: String(args.command), args: Array.isArray(args.args) ? args.args : [], to: args.to }); return { queued: { group: q.group, command: q.command, args: q.args, targets: q.commands } }; },
  },
  {
    name: 'keyflip_swarm_ping', title: 'Queue a reachability check from YOUR fleet to a URL you control',
    description: 'Queue a reachability check: each targeted fleet machine curls an http(s) URL YOU control and reports the HTTP status (the URL is a distinct argv token, no shell). Same consent gate as swarm_run — runs only on `keyflip swarm drain --allow-exec`. Mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, to: { type: 'string' }, timeout: { type: 'number' }, passphrase_file: { type: 'string' }, confirm: confirmProp.confirm }, required: ['url', 'passphrase_file', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const fleet = require('./fleet'); const swarm = require('./swarm'); const b = fleet.bus(ctx, { passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim() }); fleet.publish(ctx, b, {}); const q = swarm.ping(ctx, b, String(args.url), { to: args.to, timeout: args.timeout }); return { queued: { group: q.group, ping: String(args.url), targets: q.commands } }; },
  },
  {
    name: 'keyflip_swarm_results', title: 'Collect results published by your fleet for a swarm run',
    description: 'Aggregate the results your fleet machines published for a swarm run/ping, addressed to THIS machine. Each result\'s signed origin is verified against the sender\'s TOFU-pinned key. Output is size-capped + control-char scrubbed. Defaults to the most recent group. Read-only.',
    inputSchema: { type: 'object', properties: { group: { type: 'string' }, passphrase_file: { type: 'string' } }, required: ['passphrase_file'], additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) { const fleet = require('./fleet'); const swarm = require('./swarm'); const b = fleet.bus(ctx, { passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim() }); const reconcile = fleet.reconcileKeys(ctx, fleet.readFleet(ctx, b)); const group = args.group || swarm.readState(ctx).lastGroup; return { group: group || null, results: swarm.aggregate(ctx, b, { group: group, reconcile: reconcile }) }; },
  },
  {
    name: 'keyflip_config_list', title: 'List keyflip settings',
    description: 'All keyflip settings with their effective value (stored override or built-in default) plus the schema (type/default/bounds/help). Read-only. No secrets.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO,
    run: async function (ctx) { const config = require('./config'); return { config: Object.assign({}, config.getAll(ctx)), schema: Object.assign({}, config.describe()) }; },
  },
  {
    name: 'keyflip_config_get', title: 'Read one keyflip setting',
    description: 'Read a single setting by key (e.g. "autoswitch.threshold"); returns its effective value. Unknown keys error. Read-only.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) { const config = require('./config'); return { key: String(args.key), value: config.get(ctx, String(args.key)) }; },
  },
  {
    name: 'keyflip_codexbar', title: 'CodexBar bridge (provider alignment)',
    description: 'Detect a locally-installed CodexBar (the menu-bar AI-usage monitor) and align its tracked providers with what keyflip can read. Complementary: CodexBar monitors usage, keyflip manages accounts. Reads only CodexBar\'s non-secret provider list — never its stored tokens. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO,
    run: async function (ctx) { const cb = require('./codexbar'); return { detected: cb.detect(ctx), align: cb.align(ctx) }; },
  },
  {
    name: 'keyflip_provider_usage', title: 'Usage/limits across other AI providers',
    description: 'Read usage + limit windows across the OTHER AI coding tools on this machine (Codex, Gemini, Cursor, Copilot, opencode, OpenRouter, …) plus Claude — a CodexBar-style multi-provider monitor. Each provider is normalized to { status, windows:[{name,usedPct,resetsAt,human}] }. Reads only usage numbers/reset times (any API key is referenced by env NAME only, never its value). Absent providers are skipped. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO,
    run: async function (ctx) { return { providers: await require('./provusage').readAll(ctx, { fetch: (typeof fetch !== 'undefined' ? fetch : undefined) }) }; },
  },
  {
    name: 'keyflip_brain_propose', title: 'Propose a plan of keyflip steps (opt-in)',
    description: 'Turn a plain-language intent into a PROPOSED plan of keyflip commands (via Gemini). PROPOSE-ONLY — it never executes anything; it returns validated steps (each tagged safe/mutating) for the human to approve and run. OFF unless KEYFLIP_BRAIN=1 and GEMINI_API_KEY are set (returns enabled:false otherwise). All outbound context is secret-scrubbed; the API key is never returned. Read-only.',
    inputSchema: { type: 'object', properties: { intent: { type: 'string' } }, required: ['intent'], additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) { return require('./brain').propose(ctx, String(args.intent == null ? '' : args.intent), {}); },
  },
  {
    name: 'keyflip_config_set', title: 'Change a keyflip setting',
    description: 'Set a setting to a new value (validated + coerced against the schema; unknown key / wrong type / out-of-range are rejected). Changes future keyflip behavior. Ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' }, confirm: confirmProp.confirm }, required: ['key', 'value', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const config = require('./config'); const value = config.set(ctx, String(args.key), args.value); logmod.log('mcp config set ' + String(args.key)); return { set: { key: String(args.key), value: value } }; },
  },
  {
    name: 'keyflip_config_unset', title: 'Reset a keyflip setting to default',
    description: 'Remove a stored override so the setting reverts to its built-in default. Ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, confirm: confirmProp.confirm }, required: ['key', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const config = require('./config'); const had = config.unset(ctx, String(args.key)); logmod.log('mcp config unset ' + String(args.key)); return { unset: String(args.key), wasSet: had, value: config.get(ctx, String(args.key)) }; },
  },
  {
    name: 'keyflip_agents', title: 'List other agents\' memory + config keyflip can carry',
    description: 'Report which OTHER AI agents have files on THIS machine that keyflip can carry across machines: MEMORY (Cursor `~/.cursor/rules/`, Gemini `~/.gemini/GEMINI.md`, Codex `~/.codex/AGENTS.md`+`memories/` — markdown, no secrets) and CONFIG (`~/.cursor/mcp.json`, `~/.gemini/settings.json`, `~/.codex/config.toml` — carried ONLY secret-scanned + redacted). Read-only; feed into keyflip_migrate_export with agents=true and/or agent_config=true.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO,
    run: async function (ctx) {
      const agents = require('./agents');
      const present = agents.presentAgents(ctx);
      const cfgPresent = agents.presentAgentConfig(ctx);
      const rows = agents.REGISTRY.map(function (a) {
        const files = present.indexOf(a.id) !== -1 ? agents.collectAgentMemory(ctx, { only: [a.id] }) : [];
        const cfg = cfgPresent.indexOf(a.id) !== -1 ? agents.collectAgentConfig(ctx, { only: [a.id] }) : [];
        const redactions = cfg.reduce(function (n, c) { return n + (c.redactions || 0); }, 0);
        return { id: a.id, label: a.label, roots: a.roots, present: present.indexOf(a.id) !== -1, files: files.length, config: cfg.length, redactions: redactions };
      });
      return { agents: rows, present: present, configPresent: cfgPresent };
    },
  },

  // ---- session lifecycle: rebind, archive ----
  {
    name: 'keyflip_sessions_rebind', title: 'Re-link chat history after a folder rename',
    description: 'Re-link a project\'s Claude Code chat history after its folder was renamed/moved: copies transcripts to the new folder key, rewrites the old cwd inside them, patches the desktop-app session records (macOS). Old copies are backed up. Mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { old_path: { type: 'string' }, new_path: { type: 'string' }, purge_old: { type: 'boolean' }, force: { type: 'boolean' }, confirm: confirmProp.confirm }, required: ['old_path', 'new_path', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const path = require('path');
      const oldAbs = path.resolve(String(args.old_path)), newAbs = path.resolve(String(args.new_path));
      const r = sessions.rebind(ctx, oldAbs, newAbs, { purgeOld: !!args.purge_old, force: !!args.force });
      if (!r.ok) throw new Error('rebind did not run: ' + (r.reason || 'unknown'));
      let patched = 0;
      if (ctx.appDataDir && !appctl.isClaudeRunning(ctx.platform)) { try { patched = sessions.rebindAppRegistry(ctx, oldAbs, newAbs).patched; } catch (e) { /* best-effort */ } }
      return { moved: r.moved, skipped: r.skipped, appRecordsPatched: patched, newDir: r.newDir };
    },
  },
  {
    name: 'keyflip_sessions_archive', title: 'Archive (gzip) old transcripts',
    description: 'Move Claude Code transcripts out of ~/.claude/projects into keyflip\'s gzipped archive store (declutters; reversible via keyflip_sessions_unarchive). Give session_id for one, or older_than_days for a bulk sweep. Mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, older_than_days: { type: 'integer' }, confirm: confirmProp.confirm }, required: ['confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      let targets = [];
      if (args.older_than_days) {
        const ms = Date.now() - args.older_than_days * 86400000;
        targets = sessions.list(ctx, { limit: 100000 }).filter(function (r) { return r.mtimeMs < ms; }).map(function (r) { return { project: r.project, sessionId: r.sessionId }; });
      } else if (args.session_id) {
        const row = sessions.find(ctx, String(args.session_id));
        if (!row) throw new Error("no live session matches '" + args.session_id + "'");
        targets = [{ project: row.project, sessionId: row.sessionId }];
      } else { throw new Error('give session_id or older_than_days'); }
      const l = await lock.acquire(ctx.configDir);
      let done = 0, bytes = 0, gz = 0;
      try { targets.forEach(function (t) { const r = archive.archiveSession(ctx, t.project, t.sessionId); if (r.ok) { done++; bytes += r.bytes; gz += r.gzBytes; } }); } finally { l.release(); }
      return { archived: done, bytes: bytes, gzBytes: gz };
    },
  },
  {
    name: 'keyflip_session_delete', title: 'Delete a conversation',
    description: 'Delete a Claude Code transcript. DEFAULT is archive-then-remove (recoverable via keyflip_sessions_unarchive); hard=true PERMANENTLY unlinks it (NOT recoverable). Ask the user first, then confirm=true.',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, hard: { type: 'boolean', description: 'true = permanent unlink (irreversible); default archives first.' }, confirm: confirmProp.confirm }, required: ['session_id', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const row = sessions.find(ctx, String(args.session_id));
      if (!row) throw new Error("no live session matches '" + args.session_id + "'");
      const l = await lock.acquire(ctx.configDir);
      try { const r = require('./sessionedit').deleteSession(ctx, { project: row.project, sessionId: row.sessionId, hard: !!args.hard }); if (!r.ok) throw new Error('delete failed: ' + (r.reason || 'unknown')); return { deleted: r }; }
      finally { l.release(); }
    },
  },
  {
    name: 'keyflip_session_scrub', title: 'Redact PII from a conversation',
    description: 'Redact PII (email, phone incl. TR, TCKN, credit card [Luhn], IBAN, IP, secrets, custom patterns) from a transcript\'s human-visible text — including assistant THINKING blocks. confirm=false PREVIEWS (dry-run counts, writes nothing); confirm=true APPLIES the redaction after backing the file up. Ask the user before applying.',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, categories: { type: 'array', items: { type: 'string' }, description: 'Subset of PII categories (default: all but address).' }, llm_url: { type: 'string', description: 'Optional local PII-LLM endpoint (opt-in).' }, confirm: confirmProp.confirm }, required: ['session_id', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      const row = sessions.find(ctx, String(args.session_id));
      if (!row) throw new Error("no live session matches '" + args.session_id + "'");
      const pii = require('./pii');
      const opts = { project: row.project, sessionId: row.sessionId, apply: args.confirm === true, categories: Array.isArray(args.categories) ? args.categories : undefined, custom: pii.loadCustom(ctx) };
      if (args.llm_url) opts.llm = { url: String(args.llm_url) };
      const doIt = function () { return require('./sessionedit').scrubSession(ctx, opts); };
      let r;
      if (args.confirm === true) { const l = await lock.acquire(ctx.configDir); try { r = doIt(); } finally { l.release(); } }
      else { r = doIt(); }
      if (!r.ok) throw new Error('scrub failed: ' + (r.reason || 'unknown'));
      return { applied: r.applied, redactions: r.redactions, messagesScanned: r.messagesScanned, backup: r.backup || null, preview: r.applied ? undefined : 'dry-run — call with confirm=true to apply' };
    },
  },
  {
    name: 'keyflip_session_edit', title: 'Surgically edit a conversation',
    description: 'Edit a transcript at the JSONL level, keeping it valid: op="delete-message" drops event N, "redact-message" replaces event N\'s visible text, "truncate-after" drops everything after event N. confirm=false PREVIEWS; confirm=true APPLIES after backing up. Ask the user before applying.',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, op: { type: 'string', enum: ['delete-message', 'redact-message', 'truncate-after'] }, index: { type: 'integer' }, replacement: { type: 'string' }, confirm: confirmProp.confirm }, required: ['session_id', 'op', 'index', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      const row = sessions.find(ctx, String(args.session_id));
      if (!row) throw new Error("no live session matches '" + args.session_id + "'");
      const op = { type: String(args.op), index: args.index | 0, apply: args.confirm === true };
      if (args.replacement != null) op.replacement = String(args.replacement);
      const doIt = function () { return require('./sessionedit').editSession(ctx, { project: row.project, sessionId: row.sessionId, op: op }); };
      let r;
      if (args.confirm === true) { const l = await lock.acquire(ctx.configDir); try { r = doIt(); } finally { l.release(); } }
      else { r = doIt(); }
      if (!r.ok) throw new Error('edit failed: ' + (r.reason || 'unknown'));
      return r;
    },
  },
  {
    name: 'keyflip_pii_scrub_text', title: 'Redact PII from a string',
    description: 'Redact PII from an arbitrary text string (not a file) and return the cleaned text + per-category counts. Categories: email, phone (incl. TR), tckn, passport, creditCard (Luhn), iban, ipv4/ipv6, secret; address is opt-in. Read-only — transforms the given text, touches nothing on disk.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, categories: { type: 'array', items: { type: 'string' } } }, required: ['text'], additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) {
      const pii = require('./pii');
      const opts = { custom: pii.loadCustom(ctx) };
      if (Array.isArray(args.categories)) opts.categories = args.categories;
      return pii.scrub(String(args.text == null ? '' : args.text), opts);
    },
  },
  {
    name: 'keyflip_sessions_unarchive', title: 'Restore an archived transcript',
    description: 'Restore a gzipped archived transcript back into ~/.claude/projects (byte-exact). Mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, confirm: confirmProp.confirm }, required: ['session_id', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const row = archive.findArchived(ctx, String(args.session_id));
      if (!row) throw new Error("no archived session matches '" + args.session_id + "'");
      const l = await lock.acquire(ctx.configDir);
      let r; try { r = archive.unarchiveSession(ctx, row.project, row.sessionId); } finally { l.release(); }
      if (!r.ok) throw new Error('unarchive failed: ' + (r.reason || 'unknown'));
      return { unarchived: row.sessionId, dest: r.dest };
    },
  },
  {
    name: 'keyflip_send', title: 'Inject a message into a session',
    description: 'Continue a past session by sending it a message headlessly (`claude -p "<message>" --resume <id>`) and return the reply — this is how you steer/continue a chat (e.g. from another machine). Optionally as another account (account=) and/or fork=true (branch instead of appending). SPENDS the selected account\'s quota + appends a turn — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, message: { type: 'string' }, account: { type: 'string' }, fork: { type: 'boolean' }, confirm: confirmProp.confirm }, required: ['session_id', 'message', 'confirm'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async function (ctx, args) {
      needConfirm(args);
      const row = sessions.find(ctx, String(args.session_id));
      if (!row) throw new Error("no session matches '" + args.session_id + "'");
      if (!llm.available()) throw new Error('send needs Claude Code on PATH (`claude -p --resume`)');
      const cwd = (row.cwd && fs.existsSync(row.cwd)) ? row.cwd : process.cwd();
      const sc = sessions.sendCommand(row, String(args.message), { fork: !!args.fork });
      let env = process.env, resolved = null;
      if (args.account) {
        resolved = core.resolveProfile(ctx, String(args.account));
        if (!resolved) throw new Error("no such account: '" + args.account + "'");
        const session = require('./session');
        const l = await lock.acquire(ctx.configDir);
        let dir; try { dir = session.prepareSession(ctx, resolved, { share: true, shareHistory: true }); } finally { l.release(); }
        env = session.sessionEnv(ctx, dir).env;
      }
      const r = require('child_process').spawnSync(process.env.KEYFLIP_CLAUDE_BIN || 'claude', sc.args, { cwd: cwd, env: env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      if (resolved) { const l2 = await lock.acquire(ctx.configDir); try { require('./session').syncBack(ctx, resolved); } catch (e) { /* best-effort */ } finally { l2.release(); } }
      if (r.status !== 0) throw new Error('claude exited ' + r.status + (r.stderr ? ': ' + String(r.stderr).trim().slice(0, 200) : ''));
      return { session: row.sessionId, as: resolved || null, reply: String(r.stdout || '').trim() };
    },
  },
  {
    name: 'keyflip_sessions_assign', title: 'Assign a session to a different account',
    description: 'Assign a session to a specific account so `keyflip resume <id> --run` continues it AS that account (isolated) WITHOUT switching the machine\'s active profile (transcripts are account-independent). Pass account to assign, or omit account to UNassign. Mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, account: { type: 'string' }, confirm: confirmProp.confirm }, required: ['session_id', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const sessionmap = require('./sessionmap');
      const row = sessions.find(ctx, String(args.session_id));
      if (!row) throw new Error("no session matches '" + args.session_id + "'");
      const l = await lock.acquire(ctx.configDir);
      try {
        if (!args.account) { sessionmap.unset(ctx, row.sessionId); return { unassigned: row.sessionId }; }
        const name = core.resolveProfile(ctx, String(args.account));
        if (!name) throw new Error("no such account: '" + args.account + "'");
        sessionmap.set(ctx, row.sessionId, name);
        return { assigned: { session: row.sessionId, account: name } };
      } finally { l.release(); }
    },
  },
  {
    name: 'keyflip_sessions_archived', title: 'List archived transcripts',
    description: 'List transcripts that have been archived (gzipped) into keyflip. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO,
    run: async function (ctx) { return { archived: archive.listArchived(ctx).map(function (r) { return { sessionId: r.sessionId, project: r.project, gzBytes: r.gzBytes, mtime: r.mtime }; }) }; },
  },
  {
    name: 'keyflip_browser_sync', title: 'Align the browser to an account\'s saved session',
    description: 'macOS only. Restore an account\'s saved claude.ai browser session (captured during onboard/login) into the browser so the Claude extension reconnects as that account. Quits + reopens the browser. name defaults to the active account. Mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, confirm: confirmProp.confirm }, required: ['confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      if (ctx.platform !== 'darwin') throw new Error('browser sync is macOS-only');
      const name = args.name ? core.resolveProfile(ctx, String(args.name)) : (function () { let n = null; profiles.list(ctx.configDir).forEach(function (p) { if (!n && profiles.email(ctx.configDir, p) === core.currentEmail(ctx)) n = p; }); return n; })();
      if (!name) throw new Error('which account? pass name');
      const napMs = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
      const synced = [];
      const list = browser.installed(ctx.home);
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        const sql = browser.loadSession(ctx.configDir, name, b);
        if (!sql) continue;
        const wasRunning = browser.isRunning(b);
        if (wasRunning) { browser.quit(b, exec.run); for (let t = 0; t < 24 && browser.isRunning(b); t++) { await napMs(250); } }
        if (browser.isRunning(b)) continue; // refused to quit -> don't corrupt a live DB
        const r = browser.restoreClaudeCookies(b, sql, { force: true });
        if (r.ok) { synced.push(b.name); if (wasRunning) exec.run('open', ['-a', b.proc]); }
      }
      return { synced: synced, account: name };
    },
  },

  // ---- git-backed versioning (H3) ----
  // ---- distilled memory (B4) ----
  {
    name: 'keyflip_sessions_distill', title: 'Distill a chat into a durable keepsake',
    description: 'Summarize a past conversation into a durable "keepsake" (goal/decisions/learnings/TODOs) via headless `claude -p`, saved to keyflip\'s OWN memory store. SPENDS the active account\'s quota. Set to_claude=true to ALSO write it into ~/.claude project memory (opt-in). Mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, to_claude: { type: 'boolean' }, model: { type: 'string' }, confirm: confirmProp.confirm }, required: ['session_id', 'confirm'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async function (ctx, args) {
      needConfirm(args);
      const path = require('path');
      const row = sessions.find(ctx, String(args.session_id));
      if (!row) throw new Error("no session matches '" + args.session_id + "'");
      if (!llm.available()) throw new Error('distill needs Claude Code on PATH (summarizes via `claude -p`)');
      const transcript = fs.readFileSync(row.file, 'utf8');
      const INSTR = 'Summarize this past coding-assistant conversation (a JSONL transcript) into a durable "keepsake" memory. Output terse markdown bullets under these headings: Goal, Decisions, Built/Changed, Gotchas/Learnings, Open TODOs. Be specific; skip anything trivial; no preamble.';
      const res = llm.summarize(INSTR, transcript, { model: args.model, skipCheck: true });
      if (!res.ok) throw new Error('distill failed: ' + (res.reason || 'unknown'));
      const l = await lock.acquire(ctx.configDir);
      let saved; try { saved = memorymod.save(ctx, row.sessionId, res.text, { session: row.sessionId, cwd: row.cwd || '', distilledAt: ctx.now() }); } finally { l.release(); }
      if (args.to_claude) { try { const d = path.join(sessions.projectsDir(ctx), row.project, 'memory'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'keyflip-' + row.sessionId + '.md'), res.text + '\n'); } catch (e) { /* best-effort */ } }
      return { session: row.sessionId, memory: saved, toClaude: !!args.to_claude };
    },
  },
  {
    name: 'keyflip_sessions_compact', title: 'Compact a transcript (elide tool output)',
    description: 'Shrink a transcript by eliding bulky tool output while keeping the conversation (stays valid/resumable). DRY-RUN (returns the size reduction) unless apply=true, which rewrites it in place (original backed up next to it). apply=true is mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, apply: { type: 'boolean' }, confirm: confirmProp.confirm }, required: ['session_id', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const row = sessions.find(ctx, String(args.session_id));
      if (!row) throw new Error("no session matches '" + args.session_id + "'");
      const content = fs.readFileSync(row.file, 'utf8');
      const r = sessions.compactTranscript(content, {});
      if (!args.apply) return { before: r.before, after: r.after, elided: r.elided, applied: false };
      let bak = null; try { bak = row.file + '.precompact'; fs.writeFileSync(bak, content); } catch (e) { bak = null; }
      fs.writeFileSync(row.file, r.compacted);
      return { before: r.before, after: r.after, elided: r.elided, applied: true, backup: bak };
    },
  },
  {
    name: 'keyflip_dream', title: 'Consolidate old chats into keepsakes',
    description: '"Dreaming": distill OLD un-distilled sessions into durable keepsakes (via `claude -p`; SPENDS the active account\'s quota) and optionally archive the bulk. DRY-RUN (returns the candidate list) unless apply=true. older_than_days default 30, limit default 20; archive=true also stows the raw transcripts. apply=true is mutating + spends quota — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { older_than_days: { type: 'integer' }, limit: { type: 'integer' }, apply: { type: 'boolean' }, archive: { type: 'boolean' }, confirm: confirmProp.confirm }, required: ['confirm'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async function (ctx, args) {
      needConfirm(args);
      const days = (args && args.older_than_days) || 30, cap = (args && args.limit) || 20;
      const cutoff = Date.now() - days * 86400000;
      const targets = sessions.list(ctx, { limit: 100000 }).filter(function (r) { return r.mtimeMs < cutoff && !memorymod.has(ctx, r.sessionId); });
      const batch = targets.slice(0, cap);
      if (!args || !args.apply) return { candidates: targets.length, wouldProcess: batch.map(function (r) { return r.sessionId; }), apply: false };
      if (!llm.available()) throw new Error('dream needs Claude Code on PATH (`claude -p`)');
      const INSTR = 'Summarize this past coding-assistant conversation (a JSONL transcript) into a durable "keepsake" memory. Output terse markdown bullets under: Goal, Decisions, Built/Changed, Gotchas/Learnings, Open TODOs. Be specific; skip trivia; no preamble.';
      let distilled = 0, archived = 0, failed = 0;
      for (let i = 0; i < batch.length; i++) {
        const r = batch[i];
        let transcript; try { transcript = fs.readFileSync(r.file, 'utf8'); } catch (e) { failed++; continue; }
        const res = llm.summarize(INSTR, transcript, { skipCheck: true });
        if (!res.ok) { failed++; continue; }
        const l = await lock.acquire(ctx.configDir); try { memorymod.save(ctx, r.sessionId, res.text, { session: r.sessionId, cwd: r.cwd || '', distilledAt: ctx.now() }); } finally { l.release(); }
        distilled++;
        if (args.archive) { const l2 = await lock.acquire(ctx.configDir); try { if (archive.archiveSession(ctx, r.project, r.sessionId).ok) archived++; } finally { l2.release(); } }
      }
      return { distilled: distilled, archived: archived, failed: failed, apply: true };
    },
  },
  {
    name: 'keyflip_dream_schedule', title: 'Schedule the nightly dream',
    description: 'Install/remove/inspect a schedule (launchd on macOS, cron on Linux) that runs `keyflip dream --apply` unattended nightly. action="status" (read) | "install" | "remove". install runs old-chat distillation on a timer (spends quota) — for install/remove, ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['status', 'install', 'remove'] }, at: { type: 'string', description: 'HH:MM, default 03:00' }, older_than_days: { type: 'integer' }, archive: { type: 'boolean' }, confirm: confirmProp.confirm }, required: ['action', 'confirm'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async function (ctx, args) {
      const schedule = require('./schedule');
      if (args.action === 'status') return { schedule: schedule.status(ctx) };
      needConfirm(args);
      if (args.action === 'remove') return { removed: schedule.uninstall(ctx) };
      const r = schedule.install(ctx, { at: args.at || '03:00', days: args.older_than_days || 30, archive: !!args.archive });
      if (!r.ok) throw new Error('could not schedule: ' + (r.reason || r.detail || 'unknown'));
      return { scheduled: r };
    },
  },
  {
    name: 'keyflip_statusline', title: 'Claude Code status line (active account + quota)',
    description: 'Install/remove/inspect the keyflip status line in Claude Code — it shows the active account, provider, and cached quota in the prompt. action="status"|"install"|"remove". install/remove edit settings.json — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['status', 'install', 'remove'] }, confirm: confirmProp.confirm }, required: ['action', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      const settings = require('./settings'); const fsutil = require('./fsutil');
      const file = ctx.claudeSettingsPath;
      let cur; try { cur = settings.read(file); } catch (e) { throw new Error('~/.claude/settings.json is corrupt'); }
      const installed = !!(cur.statusLine && /statusline/.test(String((cur.statusLine && cur.statusLine.command) || '')));
      if (args.action === 'status') return { installed: installed, command: cur.statusLine && cur.statusLine.command };
      needConfirm(args);
      if (args.action === 'install') {
        const w = exec.run('which', ['keyflip']);
        const cmd = (w && w.code === 0 && String(w.stdout).trim()) ? 'keyflip statusline' : (process.env.KEYFLIP_STATUSLINE_BIN || 'keyflip') + ' statusline';
        cur.statusLine = { type: 'command', command: cmd, padding: 0 };
      } else if (installed) { delete cur.statusLine; }
      const l = await lock.acquire(ctx.configDir);
      try { fsutil.writeJsonStable(file, cur, 0o600); } finally { l.release(); }
      return { statusline: args.action };
    },
  },
  {
    name: 'keyflip_settings', title: 'View/edit Claude Code settings',
    description: 'Read or change ~/.claude/settings.json (the file Claude Code hot-reloads — no restart). action="show"/"get" read; "set"/"unset" write. key is a dot-path (e.g. "env.ANTHROPIC_MODEL"); value is parsed as a JSON literal if valid, else a string. These settings ride `keyflip migrate` to other machines. set/unset are mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['show', 'get', 'set', 'unset'] }, key: { type: 'string' }, value: { type: 'string' }, confirm: confirmProp.confirm }, required: ['action', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      const settings = require('./settings'); const fsutil = require('./fsutil');
      const file = ctx.claudeSettingsPath;
      let cur; try { cur = settings.read(file); } catch (e) { throw new Error('~/.claude/settings.json is corrupt'); }
      // NEVER return provider API keys / auth tokens (which `keyflip provider use` writes
      // into env) in plaintext over MCP — they would land in the agent + the transcript.
      if (args.action === 'show') {
        const safe = Object.assign({}, cur);
        if (safe.env && typeof safe.env === 'object') {
          const e = {}; Object.keys(safe.env).forEach(function (k) { e[k] = settings.isCredentialKey(k) ? '***redacted***' : safe.env[k]; });
          safe.env = e;
        }
        return { settings: safe };
      }
      if (args.action === 'get') {
        if (!args.key) throw new Error('key required');
        const v = settings.getPath(cur, String(args.key));
        const leaf = String(args.key).split('.').pop();
        if (v !== undefined && v !== null && settings.isCredentialKey(leaf)) return { key: args.key, value: '***redacted***', redacted: true };
        return { key: args.key, value: v === undefined ? null : v };
      }
      needConfirm(args);
      if (!args.key) throw new Error('key required');
      if (args.action === 'set') { let val; try { val = JSON.parse(String(args.value)); } catch (e) { val = String(args.value); } settings.setPath(cur, String(args.key), val); }
      else { settings.setPath(cur, String(args.key), undefined); }
      const l = await lock.acquire(ctx.configDir);
      try { fsutil.writeJsonStable(file, cur, 0o600); } finally { l.release(); }
      return { settings: args.action, key: args.key };
    },
  },
  {
    name: 'keyflip_recall', title: 'Semantic recall over your chat keepsakes',
    description: 'Search your distilled keepsakes for a topic across ALL past chats — "where did I discuss X". Default is local BM25 (offline); set semantic=true to use an embedding endpoint (Ollama/hosted) for true vector search (falls back to lexical if none). Returns ranked keepsakes with a snippet + source session. Read-only.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' }, semantic: { type: 'boolean' } }, required: ['query'], additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) {
      const recall = require('./recall');
      const limit = (args && args.limit) || 10;
      if (args && args.semantic) {
        const sem = await recall.semanticSearch(ctx, String(args.query), { limit: limit });
        if (sem.ok) return { mode: 'semantic', recall: sem.hits.map(function (h) { return { key: h.key, session: h.session, cwd: h.cwd, score: Math.round(h.score * 1000) / 1000, snippet: h.snippet }; }) };
        // fall through to lexical, note why
        const lex = recall.search(ctx, String(args.query), { limit: limit });
        return { mode: 'lexical', semanticUnavailable: sem.reason, recall: lex.map(function (h) { return { key: h.key, session: h.session, cwd: h.cwd, score: Math.round(h.score * 1000) / 1000, snippet: h.snippet }; }) };
      }
      const hits = recall.search(ctx, String(args.query), { limit: limit });
      return { mode: 'lexical', recall: hits.map(function (h) { return { key: h.key, session: h.session, cwd: h.cwd, score: Math.round(h.score * 1000) / 1000, snippet: h.snippet }; }) };
    },
  },
  {
    name: 'keyflip_memory', title: 'Browse keyflip\'s distilled keepsakes',
    description: 'keyflip\'s OWN memory store (distilled session keepsakes, independent of ~/.claude memory). Omit key to list; pass key to read one. Read-only.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) {
      if (args && args.key) { const txt = memorymod.read(ctx, String(args.key)); if (txt == null) throw new Error("no keepsake '" + args.key + "'"); return { key: args.key, content: txt }; }
      return { memory: memorymod.list(ctx).map(function (r) { return { key: r.key, bytes: r.bytes, mtime: r.mtime }; }) };
    },
  },
  {
    name: 'keyflip_history', title: 'keyflip change history (git)',
    description: 'Recent versioned changes to keyflip\'s config/state (git-backed; secrets never committed). Read-only.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) { return { versioning: vcs.isEnabled(ctx), history: vcs.log(ctx, (args && args.limit) || 20) }; },
  },
  {
    name: 'keyflip_undo', title: 'Undo the last keyflip change',
    description: 'Revert keyflip\'s config/state to before the most recent change (a git revert; reversible). Mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: confirmProp, required: ['confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const r = vcs.undo(ctx); if (!r.ok) throw new Error('cannot undo: ' + (r.reason || 'unknown')); return { undone: true }; },
  },
  {
    name: 'keyflip_restore', title: 'Restore keyflip state to a past ref',
    description: 'Roll keyflip\'s config/state back to a past ref from keyflip_history. Mutating — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' }, confirm: confirmProp.confirm }, required: ['ref', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const r = vcs.restore(ctx, String(args.ref)); if (!r.ok) throw new Error('restore failed: ' + (r.reason || 'unknown')); return { restored: args.ref }; },
  },

  // ==================== Wave 4: Context Layer (portable project memory in .keyflip/) ====================
  {
    name: 'keyflip_context_read', title: 'Read the project context',
    description: 'Read the portable project memory (.keyflip/) for a project directory — project facts, freeform context.md, decisions, tasks, and the NAMES of required environment variables (never their values). `path` defaults to the server cwd. Every text field is secret-redacted. Read-only.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Project directory (default: cwd).' } }, additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) {
      const projctx = require('./projctx');
      const pp = (args && args.path) || process.cwd();
      return projctx.pack(pp, { now: ctx.now });
    },
  },
  {
    name: 'keyflip_context_task_set', title: 'Set a project task status',
    description: 'Update a task\'s status in the project context (.keyflip/tasks.json). status ∈ todo|in_progress|blocked|done. Ask the user first, then set confirm=true.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Project directory (default: cwd).' }, id: { type: 'string' }, status: { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done'] }, confirm: confirmProp.confirm }, required: ['id', 'status', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const projctx = require('./projctx');
      const pp = (args && args.path) || process.cwd();
      const t = projctx.updateTask(pp, String(args.id), { status: String(args.status) }, { now: ctx.now });
      if (!t) throw new Error("no such task: '" + args.id + "'");
      return { updated: { id: t.id, title: t.title, status: t.status } };
    },
  },
  {
    name: 'keyflip_context_decision_add', title: 'Record a project decision',
    description: 'Append an architectural/product decision to the project context (.keyflip/decisions.json) so future AI sessions in ANY tool inherit it. All text is secret-redacted before it is stored. Ask the user first, then set confirm=true.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Project directory (default: cwd).' }, title: { type: 'string' }, rationale: { type: 'string' }, alternatives: { type: 'array', items: { type: 'string' } }, do_not: { type: 'array', items: { type: 'string' } }, status: { type: 'string', enum: ['decided', 'rejected', 'superseded'] }, confirm: confirmProp.confirm }, required: ['title', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const projctx = require('./projctx');
      const pp = (args && args.path) || process.cwd();
      const d = projctx.addDecision(pp, { title: args.title, rationale: args.rationale, alternatives: args.alternatives, doNot: args.do_not, status: args.status }, { now: ctx.now });
      return { added: { id: d.id, title: d.title, status: d.status } };
    },
  },
  {
    name: 'keyflip_rules_show', title: 'Show normalized project AI rules',
    description: 'Detect this project\'s AI rule/instruction files (CLAUDE.md, .cursorrules, .cursor/rules/*, AGENTS.md, GEMINI.md, .github/copilot-instructions.md) and normalize them into ONE common model — sections tagged coding/architecture/security/workflow/general, provenance kept. Secrets are redacted. Read-only.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Project directory (default: current working directory).' } }, additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) {
      const rules = require('./rulesmodel');
      const base = (args && args.path) || process.cwd();
      const model = rules.importRules(base, { now: ctx.now });
      return { detected: rules.detectRuleFiles(base), schemaVersion: model.schemaVersion, sources: model.sources, sections: model.sections };
    },
  },
  {
    name: 'keyflip_rules_emit', title: 'Emit project AI rules for one tool',
    description: 'Render the normalized rule model as the file content ONE tool expects (to=claude→CLAUDE.md, cursor→.cursorrules, agents→AGENTS.md, gemini→GEMINI.md, generic→RULES.md). ALWAYS returns the content (secrets redacted). Pass confirm=false to PREVIEW only; pass confirm=true to WRITE the file into the project — ask the user before writing.',
    inputSchema: { type: 'object', properties: { to: { type: 'string', enum: ['claude', 'cursor', 'agents', 'gemini', 'generic'] }, path: { type: 'string', description: 'Project directory (default: cwd).' }, confirm: confirmProp.confirm }, required: ['to', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      const rules = require('./rulesmodel');
      const base = (args && args.path) || process.cwd();
      const model = rules.loadModel(base) || rules.importRules(base, { now: ctx.now });
      const content = rules.emit(model, args.to);
      if (args.confirm !== true) return { target: args.to, wrote: false, preview: true, content: content, note: 'preview only — call again with confirm=true to write ' + rules.EMIT_TARGETS[args.to].filename + ' into the project' };
      const res = rules.writeTarget(base, args.to, content);
      return { target: args.to, wrote: true, path: res.path, bytes: res.bytes, content: content };
    },
  },
  {
    name: 'keyflip_checkpoint_list', title: 'List project checkpoints',
    description: 'List git-bound checkpoints for a project (newest first). Each is a session-boundary snapshot: git branch/short-commit/dirty files, a summary, an optional task snapshot, and the active provider, chained by parent id. `path` defaults to the current directory. Read-only, local.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Project directory (defaults to cwd).' } }, additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) { return { checkpoints: require('./checkpoint').list((args && args.path) || process.cwd()) }; },
  },
  {
    name: 'keyflip_checkpoint_latest', title: 'Latest project checkpoint',
    description: 'The most recent git-bound checkpoint for a project (or null if none). `path` defaults to the current directory. Read-only, local.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Project directory (defaults to cwd).' } }, additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) { return { checkpoint: require('./checkpoint').latest((args && args.path) || process.cwd()) }; },
  },
  {
    name: 'keyflip_checkpoint_create', title: 'Create a project checkpoint',
    description: 'Snapshot project state at a session boundary: reads git (branch / short commit / dirty files), records a summary + optional task snapshot + active provider, and chains it to the previous checkpoint. Secrets are REDACTED before anything is written (summary prose, provider, git paths, and every field of tasks_snapshot). Writes .keyflip/checkpoints/<id>.json + latest.json in the project tree. Ask the user first, then set confirm=true.',
    inputSchema: { type: 'object', properties: {
      path: { type: 'string', description: 'Project directory (defaults to cwd).' },
      summary: { type: 'string', description: 'Human summary of the session (secrets are masked).' },
      provider: { type: 'string', description: 'Active provider/account name.' },
      tasks_snapshot: { description: 'Arbitrary JSON snapshot of the agent tasks (secrets are redacted; credential-keyed values dropped).' },
      confirm: confirmProp.confirm,
    }, required: ['confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const out = require('./checkpoint').create((args && args.path) || process.cwd(),
        { summary: args.summary, provider: args.provider, tasksSnapshot: args.tasks_snapshot },
        { now: ctx.now });
      return { checkpoint: out };
    },
  },
  {
    name: 'keyflip_ctxsync_status', title: 'Context-sync privacy mode',
    description: 'The project\'s context-sync privacy mode (local|git|encrypted|company) and policy — what MAY leave the machine for the shared .keyflip/ context package — plus the current checkpoint. Read-only.',
    inputSchema: { type: 'object', properties: { projectPath: { type: 'string', description: 'Project root (default: server working dir).' } }, additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) {
      return require('./ctxsync').status((args && args.projectPath) || process.cwd(), { now: ctx.now });
    },
  },
  {
    name: 'keyflip_ctxsync_mode', title: 'Set context-sync privacy mode',
    description: 'Change the project\'s context-sync privacy mode. "local" never leaves the machine; "git" ships plain in the repo; "encrypted" is passphrase-sealed; "company" strips raw conversations + source snippets and shares only approved providers. This changes what context may leave the machine — ask the user first, then set confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['local', 'git', 'encrypted', 'company'], description: 'The privacy mode to set.' },
        projectPath: { type: 'string', description: 'Project root (default: server working dir).' },
        confirm: confirmProp.confirm,
      },
      required: ['mode', 'confirm'], additionalProperties: false,
    }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const m = require('./ctxsync').setMode((args && args.projectPath) || process.cwd(), String(args.mode), { now: ctx.now });
      return { mode: m.mode, policy: m.policy, checkpoint: { contentHash: m.contentHash, parent: m.parent, updatedAt: m.updatedAt } };
    },
  },
];

// Wave-2 modules that ship their own self-contained MCP tool objects (annotations + confirm-gating
// inlined). Appended here so each module owns its tool definitions. Order is display-only.
[
  require('./orchestrator').mcpTools,
  require('./policy').mcpTools,
  require('./integrations').mcpTools,
  require('./vault').tools,
  require('./license').mcpTools,
  require('./surface').mcpTools,
  require('./handoff').mcpTools,   // Wave 4: keyflip_handoff (RO continue-prompt)
].forEach(function (arr) { (Array.isArray(arr) ? arr : []).forEach(function (t) { if (t && t.name) TOOLS.push(t); }); });

// ---- JSON-RPC / MCP plumbing ---------------------------------------------------

function toolDescriptor(t) {
  return { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations };
}

async function handle(ctx, msg) {
  // A message without an id is a NOTIFICATION — the spec forbids replying to it,
  // whatever its method. Process nothing that needs a response and stay silent.
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } };
  }
  const id = msg.id;
  if (id === undefined) return null;                 // notification → no response ever
  if (id === null) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'request id must not be null' } };

  const respond = function (result) { return { jsonrpc: '2.0', id: id, result: result }; };
  const rpcError = function (code, message) { return { jsonrpc: '2.0', id: id, error: { code: code, message: message } }; };

  switch (msg.method) {
    case 'initialize': {
      const requested = msg.params && msg.params.protocolVersion;
      const version = SUPPORTED_VERSIONS.indexOf(requested) !== -1 ? requested : PROTOCOL_VERSION;
      return respond({
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'keyflip', title: 'Keyflip', version: VERSION },
        instructions: 'Manage the machine\'s saved Claude accounts. Use keyflip_status/keyflip_list to inspect; ' +
          'keyflip_switch/keyflip_next change the active account and REQUIRE confirm=true after asking the user. ' +
          'Switching is in-place: the desktop app is never closed, and a running Claude Code continues on the new account.',
      });
    }
    case 'ping':
      return respond({});
    case 'tools/list':
      return respond({ tools: TOOLS.map(toolDescriptor) });
    case 'tools/call': {
      const params = msg.params || {};
      const tool = TOOLS.filter(function (t) { return t.name === params.name; })[0];
      if (!tool) return rpcError(-32602, 'unknown tool: ' + params.name);
      try {
        // Paywall gate (NO-OP unless KEYFLIP_LICENSING is enabled): map the tool to its tier + block if insufficient.
        require('./license').requireForName(ctx, tool.name);
        const result = await tool.run(ctx, params.arguments || {});
        return respond({
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: false,
        });
      } catch (e) {
        return respond({ content: [{ type: 'text', text: (e && e.message) || String(e) }], isError: true });
      }
    }
    default:
      return rpcError(-32601, 'method not found: ' + msg.method);
  }
}

// Process one parsed message (or a JSON-RPC batch array) and return the response
// to write, or null when there is nothing to send (all-notification batch, or a
// lone notification).
async function handleEnvelope(ctx, parsed) {
  if (Array.isArray(parsed)) {
    if (!parsed.length) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request (empty batch)' } };
    const responses = [];
    for (let i = 0; i < parsed.length; i++) {
      const r = await handle(ctx, parsed[i]);
      if (r) responses.push(r);
    }
    return responses.length ? responses : null;
  }
  return handle(ctx, parsed);
}

// Newline-delimited JSON-RPC over stdio (the MCP stdio transport). Requests are
// processed STRICTLY IN ORDER (promise queue): this server mutates machine state,
// so a client sending dependent calls back-to-back must never observe reordering
// (e.g. a `list` overtaking the `switch` before it).
function serve(ctx, io) {
  io = io || {};
  const input = io.input || process.stdin;
  const output = io.output || process.stdout;
  const rl = readline.createInterface({ input: input, terminal: false });
  let chain = Promise.resolve();
  // Safe write: a broken stdout must not throw into the queue and poison it.
  const send = function (obj) { try { output.write(JSON.stringify(obj) + '\n'); } catch (e) { /* peer gone */ } };

  rl.on('line', function (line) {
    line = line.trim();
    if (!line) return;
    let parsed;
    try { parsed = JSON.parse(line); }
    catch (e) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
    // Each step handles its own errors and the trailing .catch guarantees the
    // chain always resolves — one failing request can never silently stall the rest.
    chain = chain.then(function () {
      return Promise.resolve(handleEnvelope(ctx, parsed)).then(function (res) {
        if (res) send(res);
      }).catch(function (e) {
        const rid = (parsed && !Array.isArray(parsed) && parsed.id !== undefined) ? parsed.id : null;
        send({ jsonrpc: '2.0', id: rid, error: { code: -32603, message: (e && e.message) || 'internal error' } });
      });
    }).catch(function () { /* never leave the chain rejected */ });
  });
  return new Promise(function (resolve) { rl.on('close', function () { chain.then(resolve, resolve); }); });
}

module.exports = { serve: serve, handle: handle, TOOLS: TOOLS, PROTOCOL_VERSION: PROTOCOL_VERSION };
