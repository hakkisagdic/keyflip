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
    description: 'Write a portable bundle of ALL accounts (secrets), providers (keys) and Claude Code session transcripts to `path`, to carry to another machine. Pass passphrase_file to encrypt it (AES-256-GCM) — STRONGLY recommended, the plaintext bundle contains login secrets. Set agents=true to ALSO carry OTHER AI agents\' home-level memory files (Cursor rules, Gemini GEMINI.md, Codex AGENTS.md/memories — markdown only, no secrets); narrow with agent_ids. Set agent_config=true to also carry those agents\' CONFIG files (MCP servers/settings) — ALWAYS secret-scanned + redacted, so keys never travel (re-enter them on the new machine). Desktop-app/browser logins are machine-bound and NOT included. Writes a secret file — ask the user, then confirm=true.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, passphrase_file: { type: 'string', description: 'File whose contents are the encryption passphrase. Omit to write an UNENCRYPTED bundle.' }, no_sessions: { type: 'boolean' }, no_providers: { type: 'boolean' }, agents: { type: 'boolean', description: 'Also carry other agents\' home-level memory (markdown, no secrets).' }, agent_config: { type: 'boolean', description: 'Also carry other agents\' config files (MCP/settings), secret-scanned + redacted.' }, agent_ids: { type: 'array', items: { type: 'string', enum: ['cursor', 'gemini', 'codex'] }, description: 'Limit agents/agent_config to these agent ids (default: all present).' }, confirm: confirmProp.confirm }, required: ['path', 'confirm'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async function (ctx, args) {
      needConfirm(args);
      const out = String(args.path);
      const pass = args.passphrase_file ? fs.readFileSync(String(args.passphrase_file), 'utf8').trim() : null;
      const built = migrate.buildBundle(ctx, { noSessions: !!args.no_sessions, noProviders: !!args.no_providers, agents: !!args.agents, agentConfig: !!args.agent_config, agentIds: Array.isArray(args.agent_ids) ? args.agent_ids : undefined });
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
];

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
