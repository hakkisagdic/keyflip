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
import readline from 'readline';
import * as core from './core.js';
import * as profiles from './profiles.js';
import * as instances from './instances.js';
import * as appauth from './appauth.js';
import * as verifymod from './verify.js';
import * as oauth from './oauth.js';
import * as _switchplan from './switchplan.js';
import * as _switchfacts from './switchfacts.js';
import * as usage from './usage.js';
import * as lock from './lock.js';
import * as logmod from './log.js';
import * as provider from './provider.js';
import * as sessions from './sessions.js';
import * as doctor from './doctor.js';
import * as backup from './backup.js';
import * as history from './history.js';
import * as proxy from './proxy.js';
import * as browser from './browser.js';
import * as loginmod from './login.js';
import * as exec from './exec.js';
import * as appsessions from './appsessions.js';
import * as appctl from './platform.js';
import * as migrate from './migrate.js';
import * as sync from './sync.js';
import * as archive from './archive.js';
import * as vcs from './vcs.js';
import * as memorymod from './memory.js';
import * as llm from './llm.js';
import * as auditview from './auditview.js';
import fs from 'fs';
import * as _transcript from './transcript.js';
import * as _foreign from './foreign.js';
import * as _chat from './chat.js';
import * as _chatsession from './chatsession.js';
import * as _fleet from './fleet.js';
import * as _rt from './relaytransfer.js';
import * as _svc from './autoswitchservice.js';
import * as _agents from './agents.js';
import _path from 'path';
import * as _pii from './pii.js';
import * as _session from './session.js';
import * as _sessionmap from './sessionmap.js';
import * as _attrib from './attrib.js';
import * as _threads from './threads.js';
import * as _secretpolicy from './secretpolicy.js';
import * as _schedule from './schedule.js';
import * as _settings from './settings.js';
import * as _recall from './recall.js';
import * as _projctx from './projctx.js';
import * as _rules from './rulesmodel.js';
import * as _policy from './policy.js';
import * as _cowork from './cowork.js';
import * as _skillstore from './skillstore.js';
import * as _desktopgw from './desktopgw.js';
import * as _mcpreg from './mcpreg.js';
import * as _share from './share.js';
import * as _links from './links.js';
import * as _lantransfer from './lantransfer.js';
import * as _lanfleet from './lanfleet.js';
import * as _autoswitch from './autoswitch.js';
import * as _budget from './budget.js';
import * as _notify from './notify.js';
import * as _cost from './cost.js';
import * as _router from './router.js';
import * as _provusage from './provusage.js';
import * as _brain from './brain.js';
import * as _sessionedit from './sessionedit.js';
import _child_process from 'child_process';
import * as _checkpoint from './checkpoint.js';
import * as _ctxsync from './ctxsync.js';
import * as _leakscan from './leakscan.js';
import * as _chains from './chains.js';
import * as _orchestrator from './orchestrator.js';
import * as _integrations from './integrations.js';
import * as _vault from './vault.js';
import * as _license from './license.js';
import * as _surface from './surface.js';
import * as _handoff from './handoff.js';
import * as _transfer from './transfer.js';
import * as _groups from './groups.js';
import * as _importcreds from './importcreds.js';
import * as _shellhook from './shellhook.js';
import * as _teampool from './teampool.js';
import * as _swarm from './swarm.js';
import * as _config from './config.js';
import * as _codexbar from './codexbar.js';
import * as _codex from './codex.js';
import * as _fsutil from './fsutil.js';
import * as _secretmask from './secretscan.js';
import * as _conversations from './conversations.js';
import * as _convindex from './convindex.js';
import * as _convexport from './convexport.js';

// Mutating tools all gate on confirm:true — the agent must ask the user first.
function needConfirm(args) {
  if (!args || args.confirm !== true)
    throw new Error('confirmation required: ask the user first, then call again with confirm=true');
}
const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const RO_NET = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const MUT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const confirmProp = {
  confirm: { type: 'boolean', description: 'Must be true — set it only after the user has agreed.' },
};

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

let VERSION = '0.0.0';
try {
  VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
} catch (e) {
  /* ignore */
}

// ---- tool implementations ----------------------------------------------------

function accountsPayload(ctx, infos) {
  const appActive = ctx.appDataDir ? appauth.activeProfileName(ctx) : null;
  return core.listProfiles(ctx).map(function (e) {
    let cli = null;
    try {
      cli = !!ctx.store.getProfile(e.name);
    } catch (err) {
      cli = null;
    }
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

// One thread member from MCP args, exactly as the CLI builds it: `session_id` and `chat_id` are both
// UUID-shaped so the parameter NAME is the kind — there is no way to tell them apart from the string.
// A prefix is expanded to the full id before it is written, because a thread is a pointer and a fuzzy
// pointer cannot be followed later; an id with no local transcript is kept as given (it may be work on
// another machine) and only the account name is validated against the saved profiles.
function threadMemberFromArgs(ctx, args, optional) {
  if (args.session_id && args.chat_id) throw new Error('one member per call: pass session_id OR chat_id, not both');
  const raw = args.session_id || args.chat_id;
  if (!raw) {
    if (optional) return null;
    throw new Error('which member? pass session_id or chat_id');
  }
  let account = null;
  if (args.account) {
    account = core.resolveProfile(ctx, String(args.account));
    if (!account) throw new Error("no such account: '" + args.account + "'");
  }
  if (args.chat_id) {
    const id = String(args.chat_id);
    if (!_threads.CHAT_ID_RE.test(id)) throw new Error('that does not look like a claude.ai chat uuid: ' + id);
    const m = { kind: 'chat', id: id };
    if (account) m.account = account;
    if (args.label) m.label = String(args.label);
    return m;
  }
  const idx = _threads.index(ctx);
  const r = _threads.resolveSessionId(ctx, String(args.session_id), idx);
  if (r.ambiguous.length)
    throw new Error(
      '"' +
        args.session_id +
        '" is the start of ' +
        r.ambiguous.length +
        ' sessions (' +
        r.ambiguous
          .slice(0, 4)
          .map(function (id) {
            return id.slice(0, 8);
          })
          .join(', ') +
        ') — pass a longer session_id',
    );
  const m = { kind: 'session', id: r.id };
  if (account) m.account = account;
  // The project key is a fast path back to the file; NO transcript prose is stored, because an MCP
  // caller could add a member whose first prompt holds a pasted key and threads/*.json is versioned.
  // `keyflip_threads` returns the live preview separately.
  if (r.matched) m.project = r.matched.project;
  if (args.label) m.label = String(args.label);
  return m;
}

// An MCP result gets copied into an agent transcript, and the rule keyflip learned with `keyflip_chains`
// is that a state-repo path never travels as `/Users/<name>/…`: it is reported relative to the state
// dir, and a transcript relative to ~/.claude/projects. The resume command keeps its absolute cwd —
// running it genuinely needs that, and a working directory is not a secret.
function statePathForAgent(ctx, p) {
  if (!p) return p;
  const rel = _path.relative(ctx.configDir, String(p));
  // POSIX separators regardless of OS: this value is pasted into transcripts, and the contract
  // (same as `keyflip chains`) is a repo-relative path, never a Windows `threads\design.json`.
  return rel && rel.indexOf('..') !== 0 ? rel.split(_path.sep).join('/') : String(p);
}
function transcriptForAgent(ctx, p) {
  if (!p) return p;
  const rel = _path.relative(sessions.projectsDir(ctx), String(p));
  return rel && rel.indexOf('..') !== 0 ? rel : _path.basename(String(p));
}

// ---- unified conversation layer (every tool's chats) --------------------------------------
// Filters are shared by list/search/context/export so an agent can narrow once and reuse the
// same vocabulary. Durations use convindex.parseSince (`7d`, `12h`, `2026-10-01`).
function convFilters(args) {
  const a = args || {};
  let apps = null;
  if (a.app) {
    apps = (Array.isArray(a.app) ? a.app : String(a.app).split(','))
      .map(function (s) {
        return String(s).trim().toLowerCase();
      })
      .filter(Boolean);
  }
  let sinceMs = null;
  if (a.since) {
    sinceMs = _convindex.parseSince(a.since);
    if (!sinceMs) throw new Error("invalid since '" + a.since + "' (use 7d, 12h or 2026-10-01)");
  }
  return { apps: apps, cwd: a.cwd ? String(a.cwd) : null, sinceMs: sinceMs, q: a.search ? String(a.search) : null };
}
// Resolve an id/prefix/title from the index manifest (cheap) and load the real conversation.
function convByRef(ctx, ref) {
  const cat = _convindex.catalog(ctx, {});
  const m = _conversations.matchRef(cat.conversations, ref);
  if (!m.match) {
    const e = new Error(
      m.reason === 'ambiguous'
        ? "'" + ref + "' matches several conversations — use more of the id"
        : "no conversation matching '" + ref + "'",
    );
    e.candidates = m.candidates || [];
    throw e;
  }
  return m.match.path ? _conversations.loadPath(ctx, m.match.path, {}) : _conversations.get(ctx, m.match.id, {});
}
// Conversation text goes into an agent transcript, so credential-shaped lines are masked unless
// the caller explicitly opts out (`redact:false`). Same rule as every export path in the CLI.
function convRedactText(text, opts) {
  if (opts && opts.redact === false) return { text: text, count: 0 };
  const r = _secretmask.redactLines(text);
  return { text: r.text, count: r.count };
}
function convSlim(r) {
  return {
    id: r.id,
    app: r.app || null,
    surface: r.surface || null,
    title: r.title,
    cwd: r.cwd || null,
    account: r.account || null,
    createdAt: r.createdAt || null,
    updatedAt: r.updatedAt || null,
    messages: (r.counts && r.counts.messages) || 0,
  };
}
function convHint() {
  return {
    browse: 'keyflip_conv_list',
    read: 'keyflip_conv_show',
    ask: 'keyflip_conv_context (a ready RAG block)',
    build: 'keyflip_conv_index with confirm=true',
  };
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
    description:
      "Saved Claude accounts with what is captured for each ([cli|app]) and which is active. Set include_usage=true to add each account's 5h/7d utilization and remaining headroom (network call, ~1s per account). Read-only.",
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
        const active = list.filter(function (e) {
          return e.active;
        })[0];
        infos = await usage.usageForProfiles(
          ctx,
          list.map(function (e) {
            return e.name;
          }),
          { liveFor: active ? active.name : null },
        );
      }
      return { accounts: accountsPayload(ctx, infos) };
    },
  },

  // ---- generic multi-instance management ----
  {
    name: 'keyflip_instances',
    title: 'List AI tool instances',
    description:
      'List isolated multi-instances (each runs in its own APFS-cloned app with independent user data). Supported tools: claude, kiro, chatgpt, cursor. Omit `tool` to list every tool. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          description: 'Tool name (claude | kiro | chatgpt | cursor). Omit to list all tools.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    run: async function (ctx, args) {
      const tool = args && args.tool ? String(args.tool) : null;
      const all = tool ? instances.listInstances(tool) : instances.listAllInstances();
      return {
        instances: all.map(function (inst) {
          // Get LIVE update state instead of stale metadata
          const updateInfo = instances.updateState(inst.tool, inst.userDataDir, inst.appPath);
          return {
            tool: inst.tool,
            account: inst.slug,
            appPath: inst.appPath,
            userDataDir: inst.userDataDir,
            configDir: inst.configDir,
            running: inst.running,
            pid: inst.pid || null,
            createdAt: inst.createdAt || null,
            // Live update state (not stale metadata)
            autoUpdate: {
              state: updateInfo.state, // 'disabled' | 'enabled' | 'uncontrollable' | 'invalid'
              mechanism: updateInfo.mechanism || null, // 'config' | 'plist' | 'none'
              control: updateInfo.control || null, // path to config/plist being checked
              reason: updateInfo.reason || null,
            },
          };
        }),
        supportedTools: Object.keys(instances.TOOL_ADAPTERS),
      };
    },
  },
  {
    name: 'keyflip_instance_create',
    title: 'Create a new AI tool instance',
    description:
      'Create an isolated app clone for a specific AI tool and account. Uses APFS copy-on-write for near-zero disk overhead. Ask the user first, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Tool name (claude | kiro | chatgpt | cursor).' },
        account: { type: 'string', description: 'Account slug/identifier.' },
        confirm: { type: 'boolean', description: 'Must be true — set it only after the user has agreed.' },
      },
      required: ['tool', 'account', 'confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async function (ctx, args) {
      needConfirm(args);
      const tool = String(args.tool);
      const account = String(args.account);
      const result = instances.createInstance(tool, account);
      return {
        created: {
          tool: result.tool,
          account: result.slug,
          appPath: result.appPath,
          userDataDir: result.userDataDir,
          configDir: result.configDir,
        },
      };
    },
  },
  {
    name: 'keyflip_instance_launch',
    title: 'Launch an AI tool instance',
    description:
      'Launch a specific isolated instance of an AI tool. Closes all other instances first to avoid deep link routing traps. Ask the user first, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Tool name (claude | kiro | chatgpt | cursor).' },
        account: { type: 'string', description: 'Account slug/identifier.' },
        confirm: { type: 'boolean', description: 'Must be true — set it only after the user has agreed.' },
      },
      required: ['tool', 'account', 'confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: async function (ctx, args) {
      needConfirm(args);
      const tool = String(args.tool);
      const account = String(args.account);
      instances.launchInstance(tool, account);
      return { launched: { tool: tool, account: account } };
    },
  },
  {
    name: 'keyflip_instance_focus',
    title: 'Focus a running AI tool instance',
    description:
      'Bring a specific running AI tool instance window to the front using AppleScript. Fails if the instance is not running. Ask the user first, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Tool name (claude | kiro | chatgpt | cursor).' },
        account: { type: 'string', description: 'Account slug/identifier.' },
        confirm: { type: 'boolean', description: 'Must be true — set it only after the user has agreed.' },
      },
      required: ['tool', 'account', 'confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async function (ctx, args) {
      needConfirm(args);
      const tool = String(args.tool);
      const account = String(args.account);
      instances.focusInstance(tool, account);
      return { focused: { tool: tool, account: account } };
    },
  },
  {
    name: 'keyflip_instance_kill',
    title: 'Kill an AI tool instance',
    description: 'Terminate a specific running AI tool instance by PID. Ask the user first, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Tool name (claude | kiro | chatgpt | cursor).' },
        account: { type: 'string', description: 'Account slug/identifier.' },
        confirm: { type: 'boolean', description: 'Must be true — set it only after the user has agreed.' },
      },
      required: ['tool', 'account', 'confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: async function (ctx, args) {
      needConfirm(args);
      const tool = String(args.tool);
      const account = String(args.account);
      instances.killInstance(tool, account);
      return { killed: { tool: tool, account: account } };
    },
  },

  {
    name: 'keyflip_instance_harden',
    title: 'Disable auto-updates for an AI tool instance',
    description:
      'Apply the auto-update switch the app actually exposes (Claude: disableAutoUpdates in userData/config.json; ChatGPT: Sparkle Info.plist keys), then read the live state back. Tools with no such switch are reported as uncontrollable rather than faked. Ask the user first, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Tool name (claude | kiro | chatgpt | cursor).' },
        account: { type: 'string', description: 'Account slug/identifier.' },
        confirm: { type: 'boolean', description: 'Must be true — set it only after the user has agreed.' },
      },
      required: ['tool', 'account', 'confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async function (ctx, args) {
      needConfirm(args);
      const tool = String(args.tool);
      const account = String(args.account);
      const state = instances.hardenInstance(tool, account);
      return {
        hardened: { tool: tool, account: account, state: state.state, method: state.control || null },
      };
    },
  },

  {
    name: 'keyflip_switch_plan',
    title: 'Plan a switch without performing it',
    description:
      "The dry run of `keyflip <account>`, which moves EVERY surface by default: which surfaces a switch WOULD write (CLI credential, desktop-app login, each browser's claude.ai session, chat pointers), which it would skip and why (no saved browser session, a browser that would lose its tabs if closed), what would block it (Claude running and not closable, an org policy for this directory, a missing capture), and — the part no earlier command answered — whether that account can still authenticate at all. Read-only: it writes nothing, takes no lock and needs no confirmation, so call it freely before asking the user to approve a switch.",
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Account name (from keyflip_list).' } },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    run: async function (ctx, args) {
      const name = core.resolveProfile(ctx, String(args.name));
      if (!name) throw new Error("no such account: '" + args.name + "' (use keyflip_list)");
      const f = await _switchfacts.collect(ctx, name, {});
      const plan = _switchplan.build(f, {});
      return {
        target: name,
        email: f.email || null,
        mode: plan.mode,
        wouldQuitClaude: !!plan.wouldQuit,
        needsConfirmation: !!plan.needsConfirm,
        plan: { writes: plan.writes, skips: plan.skips, warns: plan.warns, blockers: plan.blockers },
        verify: { state: f.targetState, headline: verifymod.HEADLINE[f.targetState] || null, detail: f.targetDetail },
        surfaces: {
          cliCaptured: f.cliCaptured,
          appCaptured: f.appCaptured,
          browserCaptured: f.browserCaptured,
          browsers: f.browsers || [],
          claudeRunning: f.appRunning,
          activeCliProfile: f.activeCliProfile,
          appActiveProfile: f.appActiveProfile,
        },
      };
    },
  },
  {
    name: 'keyflip_switch',
    title: 'Switch Claude account',
    description:
      'Switch the active Claude account (CLI credential + desktop-app login) to a saved profile. Other tools have their own flows: keyflip_instances / keyflip_instance_* manage isolated desktop instances for claude, kiro, chatgpt and cursor; keyflip_chatgpt* manage the ONE shared ChatGPT.app/Codex CLI login. The desktop app is NOT closed automatically; a running Claude app picks up the new account on its next request. IMPORTANT: this changes which account is billed and rate-limited. Ask the user before calling, then set confirm=true. Call keyflip_switch_plan FIRST when it is not obvious that the target works — a clean return value has repeatedly hidden a switch that did not produce a usable machine, so this one reads itself back: `verified` says usable now / usable, decaying / NOT usable.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Account name (from keyflip_list).' },
        confirm: {
          type: 'boolean',
          description: 'Must be true — set it only after the user has agreed to the switch.',
        },
      },
      required: ['name', 'confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: async function (ctx, args) {
      if (args.confirm !== true) {
        throw new Error(
          'confirmation required: ask the user first, then call again with confirm=true (keyflip_switch_plan answers without switching)',
        );
      }
      const name = core.resolveProfile(ctx, String(args.name));
      if (!name) throw new Error("no such account: '" + args.name + "' (use keyflip_list)");
      const em = profiles.email(ctx.configDir, name);
      if (em && em === core.currentEmail(ctx)) return { alreadyActive: { name: name, email: em } };
      _policy.enforce(ctx, { cwd: process.cwd(), account: name }); // org policy: agents can't dodge it
      const l = await lock.acquire(ctx.configDir);
      let did;
      try {
        did = core.performSwitch(ctx, name);
        logmod.log('mcp switch -> ' + name);
      } finally {
        l.release();
      }
      // Read it back instead of trusting the write: what is now on disk, and which identity the CLI
      // actually holds. Structural only — verify.js never returns a credential value.
      let verified = null;
      try {
        const r = await verifymod.verifyAccount(ctx, name, {
          liveAccount: name,
          currentEmail: function (c) {
            return core.currentEmail(c);
          },
        });
        const b = verifymod.brief(r);
        verified = { state: b.state, headline: b.headline, detail: b.detail || null };
      } catch (e) {
        verified = null; // a broken verifier must not fail a switch that already worked
      }
      let cliEmail = null;
      try {
        cliEmail = core.currentEmail(ctx) || null;
      } catch (e) {
        cliEmail = null;
      }

      // Smart suggestions: check what the agent should offer after a switch
      const suggestions = [];

      // 1. Chat consolidation — if desktop apps are closed and multiple accounts have chats
      let consolidateRan = false;
      try {
        // consolidate writes Claude's own session stores, so only the Claude app must be closed.
        // Other tools' instances do not touch these files.
        const anyAppRunning = appctl.isClaudeRunning(ctx.platform);

        if (!anyAppRunning) {
          const allProfiles = profiles.list(ctx.configDir);
          const multiAccount = allProfiles.length > 1;
          if (multiAccount) {
            // Auto-run consolidate when safe (apps closed + multiple accounts)
            try {
              const consResult = appsessions.consolidate(ctx);
              consolidateRan = true;

              // Build tool-aware description
              const toolsMentioned = [];
              if (consResult.code > 0) toolsMentioned.push('Claude Code');
              if (consResult.cowork > 0) toolsMentioned.push('Cowork');
              const toolList = toolsMentioned.length > 0 ? toolsMentioned.join(', ') : 'Claude';

              suggestions.push({
                type: 'consolidate_auto',
                priority: 'high',
                title: 'Chat history synced automatically',
                description: `Merged ${consResult.merged || 0} chat sessions across ${allProfiles.length} accounts for ${toolList} while the Claude app was closed.`,
                command: null, // Already ran, no user action needed
                autoSafe: true,
                executed: true,
              });
            } catch (e) {
              // Consolidate failed - offer manual retry
              suggestions.push({
                type: 'consolidate_failed',
                priority: 'high',
                title: 'Chat sync failed (retry manually)',
                description: `Automatic consolidate failed: ${e.message}. Run \`keyflip consolidate\` manually with desktop apps closed.`,
                command: 'keyflip consolidate',
                autoSafe: false,
              });
            }
          }
        } else {
          suggestions.push({
            type: 'consolidate_deferred',
            priority: 'medium',
            title: 'Chat sync deferred (Claude app is open)',
            description:
              'Close the Claude desktop app and run `keyflip consolidate` to sync Claude/Cowork chat history across accounts.',
            command: 'keyflip consolidate',
            autoSafe: false,
          });
        }
      } catch (_) {
        // Ignore errors in suggestion generation
      }

      // 2. Token refresh check — if switching to an account that hasn't been used recently
      try {
        const tokenPath = _path.join(ctx.configDir, 'creds', name + '.cred');
        if (fs.existsSync(tokenPath)) {
          const cred = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
          if (cred.expires_at) {
            const expiresAt = new Date(cred.expires_at).getTime();
            const hoursLeft = (expiresAt - Date.now()) / (1000 * 60 * 60);
            if (hoursLeft < 24 && hoursLeft > 0) {
              suggestions.push({
                type: 'refresh_token',
                priority: 'high',
                title: 'Token expiring soon',
                description: `This account's token expires in ~${Math.round(hoursLeft)}h. Run \`keyflip refresh ${name}\` to refresh it now.`,
                command: `keyflip refresh ${name}`,
                autoSafe: true,
              });
            }
          }
        }
      } catch (_) {
        // Ignore errors
      }

      // 3. Multi-instance suggestion — if this tool supports isolated instances
      try {
        const instanceList = instances.listInstances('claude');
        const hasInstance = instanceList.some((i) => i.slug === name);
        if (!hasInstance && profiles.list(ctx.configDir).length > 1) {
          suggestions.push({
            type: 'multi_instance',
            priority: 'low',
            title: 'Consider isolated instance for persistent sessions',
            description:
              'Create an isolated Claude instance to avoid ~30-day cookie expiry. Each instance runs independently with its own session.',
            command: `keyflip instance create claude ${name}`,
            autoSafe: false,
          });
        }
      } catch (_) {
        // Ignore errors
      }

      return {
        switched: { name: name, email: em || null },
        cliSwitched: did.cli,
        verified: verified,
        cliEmailAfterSwitch: cliEmail,
        note: 'Desktop apps not touched; running AI tools apply the new account on their next request.',
        suggestions: suggestions.length > 0 ? suggestions : undefined,
        autoConsolidate: consolidateRan ? true : undefined, // Signal that consolidate ran automatically
      };
    },
  },
  {
    name: 'keyflip_verify',
    title: 'Check whether an account can still be switched to',
    description:
      'Read each captured surface back the way its own application does — stored vs live CLI token (expiry, and whether a refresh token exists at all), the desktop-app token cache, the app session cookie AND its expiry, the browser capture age — and roll each account up to usable now / usable, decaying / NOT usable / nothing captured. Answers "would switching there actually work" BEFORE a switch strands a session. Read-only: reports presence, expiry and age, never a token or cookie value. Set include_usage=true to also ask the server (one network call per account) whether the stored credential can still read quota.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'One account name (from keyflip_list). Omit to check all.' },
        include_usage: { type: 'boolean', description: 'Also probe the server for each account (network).' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    run: async function (ctx, args) {
      const all = profiles.list(ctx.configDir);
      if (!all.length) return { accounts: [], note: 'nothing captured yet — run keyflip add' };
      let names = all;
      if (args && args.account) {
        const hit = core.resolveProfile(ctx, String(args.account));
        if (!hit) throw new Error("no such account: '" + args.account + "' (use keyflip_list)");
        names = [hit];
      }
      // Only the account the machine is ACTUALLY on has a live credential worth describing.
      let liveAccount = null;
      try {
        const cur = core.currentEmail(ctx);
        all.forEach(function (n) {
          if (!liveAccount && profiles.email(ctx.configDir, n) === cur) liveAccount = n;
        });
      } catch (e) {
        liveAccount = null;
      }
      const results = await verifymod.verifyAll(ctx, {
        accounts: names,
        usage: !!(args && args.include_usage),
        liveAccount: liveAccount,
        currentEmail: function (c) {
          return core.currentEmail(c);
        },
      });
      return {
        liveAccount: liveAccount,
        accounts: results.map(function (r) {
          const b = verifymod.brief(r);
          return {
            account: r.account,
            email: profiles.email(ctx.configDir, r.account) || null,
            state: r.state,
            headline: b.headline,
            detail: b.detail || null,
            checks: r.checks,
          };
        }),
      };
    },
  },
  {
    name: 'keyflip_refresh',
    title: 'Revive stored OAuth tokens',
    description:
      "Refresh stored OAuth tokens proactively so a saved account does not quietly die while idle — the same guarded refresh a switch performs. Refuses to rotate a token whose account has a LIVE session: Anthropic rotates the refresh token on each use, so refreshing under a running Claude logs that surface out. Requires confirm=true (it rewrites stored credentials). A 'persist-failed' status means refreshed but NOT saved: the stored token is now stale and needs a real login plus keyflip add.",
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'One account name. Omit (or all=true) for every saved account.' },
        all: { type: 'boolean', description: 'true = sweep every saved account.' },
        confirm: { type: 'boolean', description: 'Must be true — this rewrites stored credentials.' },
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    run: async function (ctx, args) {
      if (args && args.confirm !== true)
        throw new Error(
          'confirmation required: this rewrites stored credentials — ask the user, then set confirm=true',
        );
      let names = profiles.list(ctx.configDir);
      if (args && args.account) {
        const hit = core.resolveProfile(ctx, String(args.account));
        if (!hit) throw new Error("no such account: '" + args.account + "' (use keyflip_list)");
        names = [hit];
      }
      if (!names.length) return { refreshed: [], note: 'no saved account to refresh' };
      const out = [];
      for (let i = 0; i < names.length; i++) {
        const n = names[i];
        // The same guard the CLI uses: never rotate a token a live session is holding.
        const r = await oauth.maybeRefreshProfile(ctx, n, {
          isRunning: function () {
            return appctl.isClaudeRunning(ctx.platform);
          },
          instances: function () {
            return appctl.claudeInstances(ctx.home);
          },
        });
        out.push({ account: n, status: r.status });
      }
      logmod.log(
        'mcp refresh -> ' +
          out
            .map(function (o) {
              return o.account + ':' + o.status;
            })
            .join(', '),
      );
      return { refreshed: out };
    },
  },
  {
    name: 'keyflip_chatgpt',
    title: 'ChatGPT/Codex account status',
    description:
      'Report the live ChatGPT.app / Codex CLI login and every saved one. Both apps share ONE credential file (~/.codex/auth.json), so this is the only surface for them; identity comes from the token claims, expiry is the access-token exp, and a save is listed even when it predates keyflip metadata. Never returns a token. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) {
      return _codex.status(ctx);
    },
  },
  {
    name: 'keyflip_chatgpt_capture',
    title: 'Save the live ChatGPT/Codex login',
    description:
      'Copy the live ~/.codex/auth.json into a saved, secret-free-metadata capture under the keyflip config dir (0600; never git-versioned). The slug defaults to the e-mail local part; pass name to override. Ask the user before writing, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Optional slug (default: e-mail local part).' },
        confirm: { type: 'boolean', description: 'Must be true — set it only after the user has agreed.' },
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async function (ctx, args) {
      needConfirm(args);
      const r = _codex.capture(ctx, { name: args && args.name ? String(args.name) : undefined });
      return { account: r };
    },
  },
  {
    name: 'keyflip_chatgpt_switch',
    title: 'Switch ChatGPT/Codex account',
    description:
      'Write a saved login back to ~/.codex/auth.json, which BOTH ChatGPT.app and the Codex CLI read. Refuses while either is running unless force=true; backs up the outgoing auth.json first and captures it so it is not lost; reads the file back and checks the identity. This changes which account is billed. Ask the user first, then confirm=true. dry_run=true plans without writing.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Saved slug, 1-based number, or e-mail (from keyflip_chatgpt).' },
        dry_run: { type: 'boolean', description: 'Plan only; write nothing.' },
        force: {
          type: 'boolean',
          description: 'Switch even while ChatGPT/Codex is running (they may overwrite it on exit).',
        },
        confirm: { type: 'boolean', description: 'Must be true — set it only after the user has agreed.' },
      },
      required: ['account', 'confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: async function (ctx, args) {
      needConfirm(args);
      if (args.dry_run === true) {
        return { switch: _codex.switchTo(ctx, String(args.account), { dryRun: true }) };
      }
      const l = await lock.acquire(ctx.configDir);
      try {
        return { switch: _codex.switchTo(ctx, String(args.account), { force: args.force === true }) };
      } finally {
        l.release();
      }
    },
  },
  {
    name: 'keyflip_chatgpt_refresh',
    title: 'Refresh the live ChatGPT/Codex token',
    description:
      'Rotate the live ~/.codex/auth.json access token through the documented refresh_token grant. Only runs when less than 24h remain (force=true overrides), and never while ChatGPT/Codex is running — a running app owns the file and would overwrite the rotation. Saved captures sharing the same refresh-token lineage are updated too. Ask the user first, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Refresh even when the current token is not near expiry.' },
        confirm: { type: 'boolean', description: 'Must be true — set it only after the user has agreed.' },
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    run: async function (ctx, args) {
      needConfirm(args);
      const l = await lock.acquire(ctx.configDir);
      try {
        return { refresh: await _codex.refreshLive(ctx, { force: args.force === true }) };
      } finally {
        l.release();
      }
    },
  },
  {
    name: 'keyflip_next',
    title: 'Rotate to another Claude account',
    description:
      'Rotate the CLI credential to the next saved account, optionally by remaining quota (strategy "best" = most headroom, "next-available" = first not rate-limited). Same in-place semantics as keyflip_switch. Ask the user before calling, then set confirm=true.',
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
      list.forEach(function (e, i) {
        if (e.active) idx = i;
      });
      const candidates = [];
      for (let k = 1; k <= list.length; k++) {
        const e = list[(idx + k) % list.length];
        if (!e.active) candidates.push(e);
      }
      let target = candidates[0];
      if (args.strategy) {
        const infos = await usage.usageForProfiles(
          ctx,
          candidates.map(function (e) {
            return e.name;
          }),
          {},
        );
        target = usage.pickByStrategy(candidates, infos, args.strategy);
        if (!target) throw new Error("no account matches strategy '" + args.strategy + "'");
      }
      _policy.enforce(ctx, { cwd: process.cwd(), account: target.name }); // org policy applies to rotation too
      const l = await lock.acquire(ctx.configDir);
      try {
        const did = core.performSwitch(ctx, target.name);
        logmod.log('mcp next -> ' + target.name);
        return { switched: { name: target.name, email: target.email || null }, cliSwitched: did.cli };
      } finally {
        l.release();
      }
    },
  },

  // ---- providers (third-party endpoints) ----
  {
    name: 'keyflip_providers',
    title: 'List provider endpoints',
    description:
      'Saved third-party API endpoints (relays/gateways/Bedrock/OpenRouter) and which one Claude Code is currently routed through. Read-only; never returns keys.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) {
      const active = provider.readActive(ctx);
      return {
        providers: provider.list(ctx).map(function (n) {
          const m = provider.read(ctx, n);
          return { name: n, baseUrl: m && m.baseUrl, active: !!(active && active.name === n) };
        }),
        active: active ? active.name : 'official',
      };
    },
  },
  {
    name: 'keyflip_provider_use',
    title: 'Route Claude Code to a provider',
    description:
      'Point Claude Code at a saved provider endpoint (or "official" to return to the Anthropic subscription) by patching settings.json env — Claude hot-reloads, no restart. Ask the user first, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Provider name, or "official".' },
        confirm: confirmProp.confirm,
      },
      required: ['name', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      if (args.name === 'official' || args.name === 'off') {
        provider.useOfficial(ctx);
        return { provider: 'official' };
      }
      if (!provider.exists(ctx, args.name)) throw new Error("no such provider: '" + args.name + "'");
      const r = provider.use(ctx, args.name);
      return { provider: args.name, baseUrl: r.baseUrl };
    },
  },
  {
    name: 'keyflip_provider_add',
    title: 'Save a provider endpoint',
    description:
      'Save a third-party endpoint. NOTE: the API key is a secret and must NOT be passed through MCP — omit it here and tell the user to run `keyflip provider add <name> --base-url <url> --key-file -` (key on stdin). This tool stores only the non-secret metadata. Ask the user first, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        base_url: { type: 'string' },
        auth_scheme: { type: 'string', enum: ['bearer', 'api-key'] },
        confirm: confirmProp.confirm,
      },
      required: ['name', 'base_url', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      provider.add(ctx, args.name, { baseUrl: args.base_url, authScheme: args.auth_scheme || 'bearer' });
      return {
        saved: args.name,
        note:
          'No key stored. Run `keyflip provider add ' +
          args.name +
          ' --base-url ' +
          args.base_url +
          ' --key-file -` to add the key securely.',
      };
    },
  },
  {
    name: 'keyflip_test_provider',
    title: 'Test a provider endpoint',
    description:
      'Fire one minimal real request to a provider to check auth + reachability. Read-only (no state change).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: RO_NET,
    run: async function (ctx, args) {
      return { name: args.name, result: await doctor.testProvider(ctx, args.name) };
    },
  },

  // ---- sessions ----
  {
    name: 'keyflip_sessions',
    title: 'Browse Claude Code conversations',
    description:
      'List/search past Claude Code conversations across ALL accounts (transcripts in ~/.claude/projects). `search` matches transcript CONTENT and returns a match snippet. `orphan` = the recorded working dir is gone AND no live signal exists; a session a running `claude --resume` process or the Claude desktop app still uses comes back as `staleCwd` + `live:true` instead, so it is NEVER offered for deletion or rebind-by-alarm. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string' },
        cwd: { type: 'string', description: 'Only sessions started in this directory.' },
        limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      const rows = sessions.list(ctx, {
        search: args && args.search,
        cwd: args && args.cwd,
        limit: (args && args.limit) || 40,
      });
      return {
        sessions: rows.map(function (r) {
          return {
            sessionId: r.sessionId,
            cwd: r.cwd,
            mtime: r.mtime,
            preview: r.preview,
            match: r.match || null,
            orphan: !!r.orphan,
            live: !!r.live,
            liveReason: r.liveReason || null,
            staleCwd: !!r.staleCwd,
            recentlyWritten: !!r.recentlyWritten,
          };
        }),
      };
    },
  },
  {
    name: 'keyflip_resume_command',
    title: 'Get a session resume command',
    description:
      'Return the exact command to resume a past conversation in its original directory (does NOT run it). Read-only.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Session id or unique prefix.' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      const row = sessions.find(ctx, String(args.id));
      if (!row) throw new Error('no such session: ' + args.id);
      const rc = sessions.resumeCommand(row);
      return { cwd: rc.cwd, command: rc.command + ' ' + rc.args.join(' ') };
    },
  },
  {
    name: 'keyflip_sessions_export',
    title: 'Export a conversation as markdown/HTML',
    description:
      'Render a past Claude Code conversation into a clean, shareable document — markdown (default), a self-contained HTML chat view, or normalized json. Tool output is summarized ("used Read, Grep"), not dumped. Read-only: returns the rendered content (does not write a file).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session id or unique prefix.' },
        format: { type: 'string', enum: ['md', 'html', 'json'] },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      const transcript = _transcript;
      const row = sessions.find(ctx, String(args.id));
      if (!row) throw new Error('no such session: ' + args.id);
      let raw;
      try {
        raw = fs.readFileSync(row.file, 'utf8');
      } catch (e) {
        throw new Error('cannot read the transcript: ' + (e && e.message));
      }
      const parsed = transcript.parse(raw);
      const fmt = args.format === 'html' ? 'html' : args.format === 'json' ? 'json' : 'md';
      const content =
        fmt === 'html'
          ? transcript.toHtml(parsed, { id: row.sessionId })
          : fmt === 'json'
            ? JSON.stringify(parsed, null, 2)
            : transcript.toMarkdown(parsed, { id: row.sessionId });
      return { format: fmt, counts: parsed.counts, content: content };
    },
  },
  {
    name: 'keyflip_foreign_export',
    title: "Normalize ANOTHER agent's session log",
    description:
      "Read another AI agent's session log FILE at `path` (message-event JSONL, generic JSON, a Cursor SQLite store, or an Aider .aider.chat.history.md) and normalize it into keyflip's unified conversation shape, then render it as markdown/HTML/json — the same view as Claude Code sessions. Read-only. (Copilot YAML is not yet supported; the Cursor/JSON/Aider mappings are best-effort — confirm against a real install.)",
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, format: { type: 'string', enum: ['md', 'html', 'json'] } },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      const foreign = _foreign;
      const transcript = _transcript;
      let raw;
      try {
        raw = fs.readFileSync(String(args.path));
      } catch (e) {
        throw new Error('cannot read ' + args.path + ': ' + (e && e.message));
      } // Buffer (Cursor is binary)
      const norm = foreign.normalize(String(args.path), raw); // throws on unrecognized format
      const fmt = args.format === 'html' ? 'html' : args.format === 'json' ? 'json' : 'md';
      const content =
        fmt === 'html'
          ? transcript.toHtml(norm, { id: norm.tool })
          : fmt === 'json'
            ? JSON.stringify(norm, null, 2)
            : transcript.toMarkdown(norm, { id: norm.tool });
      return { tool: norm.tool, format: fmt, counts: norm.counts, content: content };
    },
  },

  // ---- unified conversation layer: every local AI tool's chats ----
  {
    name: 'keyflip_conv_list',
    title: 'List conversations from every local AI tool',
    description:
      'Browse the chats keyflip can read on this machine — Claude Code, Codex/ChatGPT, Kiro, Gemini/Antigravity and foreign agents (Qoder, Cursor, opencode, Copilot, Aider) — in ONE normalized shape: id, app, surface, title, cwd, message count, dates. `search` filters TITLES only; use keyflip_conv_search for content. When the index exists this reads its manifest and is instant; otherwise it parses transcripts live (slow, reported as indexed:false). Read-only, local.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Title substring filter (not content).' },
        app: { type: 'string', description: 'Comma-separated app ids, e.g. "claude,codex".' },
        cwd: { type: 'string', description: 'Only conversations whose working dir contains this path.' },
        since: { type: 'string', description: 'Only conversations updated within e.g. 7d, 24h, or since 2026-10-01.' },
        limit: { type: 'integer', description: 'Default 20, max 500.' },
      },
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      const f = convFilters(args);
      const cat = _convindex.catalog(ctx, f);
      const limit = Math.max(1, Math.min(500, Number(args && args.limit) || 20));
      return {
        indexed: cat.indexed,
        builtAt: cat.builtAt || null,
        total: cat.conversations.length,
        conversations: cat.conversations.slice(0, limit).map(convSlim),
        stats: cat.stats || null,
        errors: (cat.errors || []).slice(0, 5).map(function (e) {
          return { app: e.app || null, error: e.error };
        }),
        note: cat.indexed ? null : 'no index yet — this pass parsed every transcript; keyflip_conv_index makes it fast',
        hints: convHint(),
      };
    },
  },
  {
    name: 'keyflip_conv_show',
    title: 'Read one conversation in full',
    description:
      'Load one conversation by id, unique id prefix, or unique title, and return it rendered as markdown (default), self-contained HTML, or normalized JSON. Tool calls are summarized, not dumped. `max_chars` caps the returned content (default 60000) — read a narrower slice or export the file for a huge chat. Credential-shaped lines are masked by default; pass redact:false only when the user asked for exact fidelity. Read-only, local.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Conversation id, unique prefix, or unique title.' },
        format: { type: 'string', enum: ['md', 'html', 'json'] },
        max_chars: { type: 'integer', description: 'Default 60000, max 400000.' },
        redact: { type: 'boolean', description: 'Default true; false keeps secret shapes verbatim.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      const conv = convByRef(ctx, String(args.id));
      const format = args.format === 'html' ? 'html' : args.format === 'json' ? 'json' : 'md';
      const r = _convexport.render(conv, { format: format, redact: args.redact !== false });
      const cap = Math.max(1000, Math.min(400000, Number(args.max_chars) || 60000));
      const truncated = r.content.length > cap;
      return {
        id: conv.id,
        app: conv.app,
        surface: conv.surface,
        title: conv.title,
        cwd: conv.cwd || null,
        updatedAt: conv.updatedAt || null,
        counts: conv.counts,
        format: format,
        redacted: r.redacted || 0,
        truncated: truncated,
        content: truncated ? r.content.slice(0, cap) + '\n…[truncated by keyflip]' : r.content,
      };
    },
  },
  {
    name: 'keyflip_conv_search',
    title: 'Search every conversation (BM25, embeddings, hybrid)',
    description:
      'Search the CONTENT of every local conversation keyflip has indexed. Modes: lexical (BM25, always available), semantic (needs embeddings), hybrid (reciprocal-rank fusion; falls back to lexical with a warning when no vectors exist). Filters narrow by app/cwd/since. Snippets are masked for credential shapes by default. Results are chunk-level, one per conversation by default, so raise limit to page. Never uploads anything; embeddings run locally (Ollama) or at the URL the user configured. Read-only: it does NOT build an index — if none exists, ask the user and call keyflip_conv_index with confirm=true. Hints return the id to read with keyflip_conv_show and the query to feed keyflip_conv_context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        mode: { type: 'string', enum: ['lexical', 'semantic', 'hybrid'] },
        limit: { type: 'integer', description: 'Default 10, max 100.' },
        per_conv: { type: 'integer', description: 'Chunks per conversation, default 1, max 20.' },
        app: { type: 'string' },
        cwd: { type: 'string' },
        since: { type: 'string' },
        redact: { type: 'boolean', description: 'Default true; false returns raw snippets.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      const q = String(args.query || '').trim();
      if (!q) throw new Error('query is required');
      const mode = ['lexical', 'semantic', 'hybrid'].indexOf(args.mode) !== -1 ? args.mode : 'hybrid';
      const st = _convindex.status(ctx);
      if (!st.exists) {
        throw new Error(
          'no conversation index yet: ask the user, then call keyflip_conv_index with confirm=true (or run `keyflip conv index`) — this tool never builds one on its own',
        );
      }
      if (mode !== 'lexical' && !st.vectorChunks) {
        if (mode === 'semantic')
          throw new Error(
            'no embeddings yet: mode=semantic needs keyflip_conv_index with embed=true, or use mode=lexical',
          );
      }
      const f = convFilters(args);
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 10));
      const r = await _convindex.search(ctx, q, {
        mode: mode,
        apps: f.apps,
        sinceMs: f.sinceMs,
        cwd: f.cwd,
        limit: limit,
        perConv: Math.max(1, Math.min(20, Number(args.per_conv) || 1)),
      });
      if (!r.ok) {
        const why =
          r.reason === 'no-index'
            ? 'no index yet — call keyflip_conv_index with confirm=true'
            : r.reason === 'embed-failed'
              ? 'embedding endpoint failed: ' +
                (r.detail || 'unknown') +
                ' — use mode=lexical, or start Ollama / set KEYFLIP_EMBED_URL'
              : 'search failed: ' + (r.reason || 'unknown');
        throw new Error(why);
      }
      return {
        query: q,
        mode: r.mode || (r.semanticCoverage ? 'hybrid' : 'lexical'),
        count: r.hits.length,
        hits: r.hits.map(function (h) {
          const snip = convRedactText(h.snippet || '', args);
          return {
            id: h.id,
            app: h.app || null,
            title: h.title,
            cwd: h.cwd || null,
            updatedAt: h.updatedAt || null,
            chunk: h.chunk,
            role: h.role || null,
            ts: h.ts || null,
            score: Math.round((h.score || 0) * 1000) / 1000,
            snippet: snip.text,
            redacted: snip.count || 0,
          };
        }),
        warning: r.semanticError
          ? r.semanticError === 'no-vectors'
            ? 'no embeddings yet — ranked lexically; keyflip_conv_index with embed=true enables semantic/hybrid'
            : 'vectors unavailable (' + r.semanticError + ') — lexical ranking only'
          : null,
        hints: {
          read: 'keyflip_conv_show { id }',
          context: 'keyflip_conv_context { query } for a ready-to-paste RAG block',
        },
      };
    },
  },
  {
    name: 'keyflip_conv_context',
    title: 'Build a RAG context block from past chats',
    description:
      "Retrieve the most relevant chunks across every local conversation and return ONE portable, char-budgeted context block with stable headings, source ids, cwd and dates. This is the tool to call when the user asks 'what did we decide about X?' or wants a new agent to continue prior work: pass the block to the model as context. `expand` includes neighbouring chunks so a decision is not cut mid-thread. `redact` (default true) masks credential-shaped lines. Local only — never uploaded. Read-only: does NOT build an index; ask the user and call keyflip_conv_index with confirm=true.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        budget: { type: 'integer', description: 'Character budget, default 12000, max 200000.' },
        expand: { type: 'integer', description: 'Neighbouring chunks per hit, default 1, max 5.' },
        mode: { type: 'string', enum: ['lexical', 'semantic', 'hybrid'] },
        app: { type: 'string' },
        cwd: { type: 'string' },
        since: { type: 'string' },
        redact: { type: 'boolean', description: 'Default true.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      const q = String(args.query || '').trim();
      if (!q) throw new Error('query is required');
      const mode = ['lexical', 'semantic', 'hybrid'].indexOf(args.mode) !== -1 ? args.mode : 'hybrid';
      const st = _convindex.status(ctx);
      if (!st.exists) {
        throw new Error(
          'no conversation index yet: ask the user, then call keyflip_conv_index with confirm=true (or run `keyflip conv index`)',
        );
      }
      if (mode === 'semantic' && !st.vectorChunks)
        throw new Error('no embeddings yet: pass embed=true to keyflip_conv_index, or use mode=lexical');
      const f = convFilters(args);
      const r = await _convindex.search(ctx, q, {
        mode: mode,
        apps: f.apps,
        sinceMs: f.sinceMs,
        cwd: f.cwd,
        limit: 12,
        perConv: 1,
      });
      if (!r.ok) {
        throw new Error(
          r.reason === 'embed-failed'
            ? 'embedding endpoint failed: ' + (r.detail || 'unknown') + ' — use mode=lexical'
            : 'search failed: ' + (r.reason || 'unknown'),
        );
      }
      const pack = _convindex.contextPack(ctx, q, r.hits || [], {
        budget: Math.max(500, Math.min(200000, Number(args.budget) || 12000)),
        expand: Math.max(0, Math.min(5, args.expand == null ? 1 : Number(args.expand))),
      });
      const red = convRedactText(pack, args);
      return {
        query: q,
        mode: r.mode || (r.semanticCoverage ? 'hybrid' : 'lexical'),
        sources: (r.hits || []).map(function (h) {
          return { id: h.id, app: h.app || null, title: h.title, updatedAt: h.updatedAt || null, score: h.score };
        }),
        redacted: red.count || 0,
        chars: red.text.length,
        context: red.text,
        warning: r.semanticError
          ? r.semanticError === 'no-vectors'
            ? 'no embeddings yet — ranked lexically; keyflip_conv_index with embed=true enables semantic/hybrid'
            : 'vectors unavailable (' + r.semanticError + ') — lexical ranking only'
          : null,
      };
    },
  },
  {
    name: 'keyflip_conv_status',
    title: 'Conversation index status',
    description:
      'What keyflip can search on this machine: index location, build time, conversation/message/chunk counts per app, embedding model+host and vector coverage. `exists:false` means keyflip_conv_search/context will refuse until keyflip_conv_index runs. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) {
      const st = _convindex.status(ctx);
      return Object.assign({}, st, {
        dir: statePathForAgent(ctx, st.dir),
        hints: st.exists ? convHint() : { build: 'keyflip_conv_index with confirm=true' },
      });
    },
  },
  {
    name: 'keyflip_conv_index',
    title: 'Build/refresh the conversation index',
    description:
      "Parse every local conversation once into chunk files keyflip owns (configDir/conv-index, never versioned or backed up) so search and RAG context are instant. Incremental: unchanged files are reused by mtime+hash, appended chats reuse their vector prefix. `embed:true` also computes local embeddings (Ollama nomic-embed-text by default, or KEYFLIP_EMBED_URL) — a FIRST full embedding pass over a large corpus takes many minutes and can outlive an MCP request; for that, tell the user to run `keyflip conv index --embed` in a terminal. Filter with app/limit_sources for a quick slice. Writes only keyflip's own index; no conversation is modified. Ask the user first, then set confirm=true.",
    inputSchema: {
      type: 'object',
      properties: {
        embed: { type: 'boolean', description: 'Also compute embeddings (needed for semantic/hybrid).' },
        force: { type: 'boolean', description: 'Re-parse even when mtime+size are unchanged.' },
        app: { type: 'string', description: 'Comma-separated app ids for a partial build.' },
        limit_sources: { type: 'integer', description: 'Parse at most N sources (quick slice).' },
        confirm: confirmProp.confirm,
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const f = convFilters(args);
      const ls = Number(args.limit_sources) || null;
      const report = await _convindex.build(ctx, {
        apps: f.apps,
        limitSources: ls,
        embed: !!args.embed,
        force: !!args.force,
      });
      const st = _convindex.status(ctx);
      return {
        ok: report.ok,
        indexed: report.indexed,
        reused: report.reused,
        changed: report.changed,
        removed: report.removed,
        empty: report.empty,
        skipped: report.skipped,
        embedded: report.embedded,
        embedding: report.embedding || null,
        stats: st.stats || report.stats || null,
        vectorChunks: st.vectorChunks || 0,
        coverage: st.coverage || 0,
        errors: (report.errors || []).slice(0, 5),
        note: report.embedding
          ? report.embedding.error
            ? 'embeddings failed: ' + report.embedding.error + ' — lexical search still works'
            : 'semantic + hybrid search are available'
          : 'no vectors yet — rerun with embed=true for semantic/hybrid',
      };
    },
  },
  {
    name: 'keyflip_conv_export',
    title: 'Export conversations or hand one to another AI tool',
    description:
      "Write conversation documents OUTSIDE keyflip's stores: (1) one conversation with `id` to a file, (2) `all:true` to a folder as md/html/json, (3) `obsidian:true` into an Obsidian vault (`out`) — notes get YAML frontmatter, tags and an index, and keyflip only overwrites a note whose content still matches what it wrote last time (a user edit becomes a conflict copy, never a silent overwrite), (4) `target` with `id` writes a handoff bundle (conversation.json + CONTINUE.md + README.md) for claude/codex/kiro/opencode/windsurf/generic. No target tool's live store is modified; no native import exists. Credential-shaped lines are masked unless redact:false. Large vaults: use limit/offset. Ask the user before writing, then set confirm=true.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'One conversation; required for target bundles.' },
        all: { type: 'boolean', description: 'Export every conversation matching the filters.' },
        obsidian: { type: 'boolean', description: 'Write an ownership-tracked Obsidian vault.' },
        target: { type: 'string', description: 'Handoff target: claude, codex, kiro, opencode, windsurf, generic.' },
        out: { type: 'string', description: 'Destination file or folder (required for all/obsidian/target).' },
        format: { type: 'string', enum: ['md', 'html', 'json'] },
        redact: { type: 'boolean', description: 'Default true.' },
        force: { type: 'boolean', description: 'Overwrite existing files (Obsidian: also user edits).' },
        limit: { type: 'integer', description: 'Max conversations per call, default 200.' },
        offset: { type: 'integer', description: 'Skip this many conversations (stable updatedAt order).' },
        confirm: confirmProp.confirm,
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const opts = { redact: args.redact !== false, force: !!args.force, now: ctx.now ? ctx.now() : undefined };
      const format = args.format === 'html' ? 'html' : args.format === 'json' ? 'json' : 'md';
      const out = args.out ? String(args.out) : null;

      if (args.target) {
        if (!args.id) throw new Error('target bundles need one conversation: pass id');
        if (!out) throw new Error('target bundles need a destination folder: pass out');
        const conv = convByRef(ctx, String(args.id));
        return _convexport.writeBundle(conv, String(args.target), Object.assign({}, opts, { out: out }));
      }

      const f = convFilters(args);
      const cap = Math.max(1, Math.min(5000, Number(args.limit) || 200));
      const offset = Math.max(0, Number(args.offset) || 0);

      if (args.obsidian) {
        if (!out) throw new Error('Obsidian export needs a vault folder: pass out');
        const rows = _convindex.catalog(ctx, f).conversations;
        const slice = rows.slice(offset, offset + cap);
        if (!slice.length) throw new Error('no conversations match those filters');
        const srcs = _conversations.discover(ctx, {});
        const byPath = Object.create(null);
        srcs.forEach(function (s) {
          byPath[_path.resolve(s.path)] = s;
        });
        function* loadRows() {
          for (const row of slice) {
            const src = row.path ? byPath[_path.resolve(row.path)] : null;
            if (!src) continue;
            try {
              yield _conversations.load(ctx, src, {});
            } catch {
              /* one unreadable source must not abort the vault */
            }
          }
        }
        const report = _convexport.obsidianExport(ctx, loadRows(), Object.assign({}, opts, { out: out }));
        return Object.assign({}, report, {
          total: rows.length,
          exported: slice.length,
          remaining: Math.max(0, rows.length - offset - slice.length),
          next_offset: offset + slice.length < rows.length ? offset + slice.length : null,
        });
      }

      if (args.id) {
        const conv = convByRef(ctx, String(args.id));
        return _convexport.exportOne(conv, Object.assign({}, opts, { out: out, format: format }));
      }

      if (!args.all) throw new Error('choose one: id (one conversation), all:true (bulk), obsidian:true, or target');
      const dest = out || _path.join(process.cwd(), 'keyflip-conversations');
      const rows = _convindex.catalog(ctx, f).conversations;
      const slice = rows.slice(offset, offset + cap);
      if (!slice.length) throw new Error('no conversations match those filters');
      const srcs = _conversations.discover(ctx, {});
      const byPath = Object.create(null);
      srcs.forEach(function (s) {
        byPath[_path.resolve(s.path)] = s;
      });
      const files = [];
      const errors = [];
      for (const row of slice) {
        const src = row.path ? byPath[_path.resolve(row.path)] : null;
        if (!src) {
          errors.push({ id: row.id, error: 'source is gone' });
          continue;
        }
        try {
          files.push(
            _convexport.exportOne(
              _conversations.load(ctx, src, {}),
              Object.assign({}, opts, {
                out: dest + _path.sep,
                format: format,
              }),
            ),
          );
        } catch (e) {
          errors.push({ id: row.id, error: (e && e.message) || String(e) });
        }
      }
      return {
        dir: dest,
        exported: files.length,
        total: rows.length,
        remaining: Math.max(0, rows.length - offset - slice.length),
        next_offset: offset + slice.length < rows.length ? offset + slice.length : null,
        files: files,
        errors: errors.slice(0, 10),
      };
    },
  },

  {
    name: 'keyflip_cowork',
    title: 'Browse Cowork sessions',
    description:
      'List/search Claude desktop Cowork (agent-mode) sessions across ALL accounts — title, first message, account, and the underlying Claude Code session. Read-only, local.',
    inputSchema: {
      type: 'object',
      properties: { search: { type: 'string' }, limit: { type: 'integer' } },
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      if (!ctx.appDataDir) return { cowork: [], note: 'desktop app not present (macOS only)' };
      const rows = _cowork.list(ctx, { search: args && args.search, limit: (args && args.limit) || 40 });
      return {
        cowork: rows.map(function (r) {
          return {
            sessionId: r.sessionId,
            title: r.title,
            account: r.account,
            cwd: r.cwd,
            lastActivityAt: r.lastActivityAt,
            cliSessionId: r.cliSessionId,
          };
        }),
      };
    },
  },
  {
    name: 'keyflip_chat',
    title: 'Read claude.ai Chat (any captured account)',
    description:
      "List, search or read claude.ai cloud Chat conversations. With no arguments: the newest chats of the LIVE account. With `search`: chats whose TITLE matches. With `id`: one conversation — the short id shown in listings, a full uuid, or a unique title all work. With `account`: another saved account's chats, read from its captured claude.ai session WITHOUT switching anything. The session is found automatically (desktop app cookie, then a signed-in browser, then that account's saved browser snapshot) and reported as `via`. EXPERIMENTAL: uses the undocumented claude.ai API with a session cookie, so it needs a fresh Cloudflare clearance — may return 403 when stale; if an account has no saved session the error says to run `keyflip browser capture <account>` (capture SAVES a browser session under an account; `browser sync` restores one into the browser). Read-only.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Conversation uuid, short id (uuid prefix) or title.' },
        search: { type: 'string', description: 'Filter the listing by title substring.' },
        account: {
          type: 'string',
          description:
            'Read another saved account via its captured claude.ai session (from keyflip_list); default = live login.',
        },
        limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
    annotations: RO_NET,
    run: async function (ctx, args) {
      const a = args || {};
      const opts = {};
      if (a.account) {
        const name = core.resolveProfile(ctx, a.account);
        if (!name) throw new Error("no such saved account: '" + a.account + "' (see keyflip_list)");
        opts.account = name;
      }
      if (a.limit) opts.limit = a.limit;
      // Where the session actually lives is chatsession's job (app build-dependent: the
      // desktop app may keep it in memory while a browser has it on disk).
      const o = _chatsession.withSession(ctx, opts);
      if (a.id) return { via: o.sessionSource, conversation: await _chat.get(ctx, a.id, o) };
      if (a.search) return Object.assign({ via: o.sessionSource }, await _chat.search(ctx, a.search, o));
      return Object.assign({ via: o.sessionSource }, await _chat.list(ctx, o));
    },
  },

  // ---- diagnostics / usage ----
  {
    name: 'keyflip_doctor',
    title: 'Diagnose config + connectivity',
    description:
      'Health report: Claude config dir, login present, desktop app data, live auto-update state of the base app and every isolated instance, and each provider endpoint reachability. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO_NET,
    run: async function (ctx) {
      return await doctor.diagnose(ctx);
    },
  },
  {
    name: 'keyflip_usage_history',
    title: 'Usage trend + failover events',
    description: 'Recent per-account 5h/7d usage samples and autoswitch/failover events. Read-only.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false },
    annotations: RO,
    run: async function (ctx, args) {
      const n = (args && args.limit) || 50;
      return { usage: history.readUsage(ctx, n), events: history.readEvents(ctx, n) };
    },
  },

  // ---- backup ----
  {
    name: 'keyflip_backups',
    title: 'List backups',
    description: 'List keyflip metadata backups (newest first). Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) {
      return {
        backups: backup.list(ctx).map(function (b) {
          return { name: b.name, sizeBytes: b.sizeBytes, mtime: b.mtime };
        }),
      };
    },
  },
  {
    name: 'keyflip_backup_create',
    title: 'Create a backup',
    description: 'Snapshot keyflip metadata (no secrets). Ask the user first, then confirm=true.',
    inputSchema: { type: 'object', properties: confirmProp, required: ['confirm'], additionalProperties: false },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const r = backup.create(ctx);
      return { created: r.name, files: r.files };
    },
  },
  {
    name: 'keyflip_backup_restore',
    title: 'Restore a backup',
    description:
      'Restore a backup by name or 1-based index (takes a pre-restore safety backup first). Ask the user first, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: { which: { type: 'string' }, confirm: confirmProp.confirm },
      required: ['which', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      return backup.restore(ctx, args.which);
    },
  },

  // ---- skills marketplace ----
  {
    name: 'keyflip_skills',
    title: 'List installed skills',
    description: 'Skills keyflip installed into ~/.claude/skills. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) {
      return { skills: _skillstore.list(ctx) };
    },
  },
  {
    name: 'keyflip_skill_add',
    title: 'Install a skill',
    description:
      'Install a skill from a GitHub repo (owner/repo[@ref][/subdir]), a local directory, or a .tar.gz/.zip. Installs code the agent will run — ask the user first, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: { source: { type: 'string' }, confirm: confirmProp.confirm },
      required: ['source', 'confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    run: async function (ctx, args) {
      needConfirm(args);
      return { installed: await _skillstore.add(ctx, String(args.source), {}) };
    },
  },
  {
    name: 'keyflip_skill_remove',
    title: 'Remove an installed skill',
    description: "Remove a keyflip-installed skill (never the user's own). Ask the user first, then confirm=true.",
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, confirm: confirmProp.confirm },
      required: ['name', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      _skillstore.remove(ctx, args.name);
      return { removed: args.name };
    },
  },

  // ---- failover proxy ----
  {
    name: 'keyflip_proxy_status',
    title: 'Failover proxy status',
    description:
      'Is the local failover proxy running? On what port, wired? Per-account request/token totals. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) {
      const meta = proxy.readMeta(ctx);
      const running = !!(
        meta &&
        meta.pid &&
        (function () {
          try {
            process.kill(meta.pid, 0);
            return true;
          } catch (e) {
            return e && e.code === 'EPERM';
          }
        })()
      );
      return { running: running, port: meta && meta.port, wired: !!(meta && meta.wired), stats: proxy.stats(ctx) };
    },
  },
  {
    name: 'keyflip_proxy_control',
    title: 'Start/stop the failover proxy',
    description:
      'Start or stop the command-activated localhost failover proxy (routes each request to the active account, fails over on 429/5xx). action="start"|"stop"; wire=true also sets ANTHROPIC_BASE_URL. Starting spawns a background process — ask the user first, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop'] },
        wire: { type: 'boolean' },
        port: { type: 'integer' },
        confirm: confirmProp.confirm,
      },
      required: ['action', 'confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    run: async function (ctx, args) {
      needConfirm(args);
      if (args.action === 'start') {
        const r = proxy.start(ctx, { wire: !!args.wire, port: args.port });
        return { started: !r.already, url: r.url, wired: r.wired, port: r.port };
      }
      return proxy.stop(ctx);
    },
  },

  // ---- account login (add) ----
  {
    name: 'keyflip_login',
    title: 'Sign in and capture a Claude account',
    description:
      'Add an account: sign in via the OFFICIAL browser flow in an ISOLATED config (the current login is NOT disturbed) and save the minted token as a keyflip profile. A HUMAN must approve in the browser that opens. The OAuth reuses the browser\'s current claude.ai session, so if the browser is signed into a different account this captures THAT and returns a "mismatch" error — clear it first with keyflip_browser_logout. Interactive + mutating — ask the user, then confirm=true. name/email are optional.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, email: { type: 'string' }, confirm: confirmProp.confirm },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async function (ctx, args) {
      needConfirm(args);
      try {
        const res = loginmod.performLogin(ctx, { email: args.email, name: args.name, stdio: 'ignore' });
        return { status: res.status, name: res.name, email: res.email };
      } catch (e) {
        throw new Error(
          e.code === 'mismatch'
            ? e.message + ' — clear the browser with keyflip_browser_logout, then retry'
            : e.message,
        );
      }
    },
  },
  {
    name: 'keyflip_logout',
    title: 'Sign out of live surfaces',
    description:
      'Sign the machine OUT of the live Claude session on the selected surfaces — "cli" (Claude Code) and/or "browser" (claude.ai cookies, macOS). Saved keyflip profiles are KEPT (switch back anytime). Does NOT touch the desktop app. Mutating — ask the user, then confirm=true. surfaces defaults to ["cli"].',
    inputSchema: {
      type: 'object',
      properties: {
        surfaces: { type: 'array', items: { type: 'string', enum: ['cli', 'browser'] } },
        confirm: confirmProp.confirm,
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const surfaces = Array.isArray(args.surfaces) && args.surfaces.length ? args.surfaces : ['cli'];
      const out = [];
      if (surfaces.indexOf('cli') !== -1) {
        loginmod.cliLogout(ctx);
        out.push('cli');
      }
      if (surfaces.indexOf('browser') !== -1 && ctx.platform === 'darwin') {
        browser.installed(ctx.home).forEach(function (b) {
          const r = browser.clearClaudeCookies(b, {});
          if (r.ok) out.push('browser:' + b.id);
        });
      }
      return { loggedOut: out };
    },
  },

  // ---- browser session (Claude Chrome extension) ----
  {
    name: 'keyflip_consolidate',
    title: 'Sync chats across accounts',
    description:
      "Merge the Claude desktop app's session stores — the base app AND every non-running keyflip instance clone — so EVERY account sees all conversations (Cowork + Claude Code sessions). Filename collisions between accounts are resolved with a transcript-derived name instead of dropping a pointer. Requires the base Claude desktop app to be CLOSED; a clone counted by a live instance.pid is skipped and reported. Mutating — ask the user, then confirm=true.",
    inputSchema: {
      type: 'object',
      properties: { confirm: confirmProp.confirm },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      if (appctl.isClaudeRunning(ctx.platform))
        return { ok: false, reason: 'Claude still running — close the desktop app first' };
      const c = appsessions.consolidate(ctx);
      return {
        ok: !!c.ok,
        merged: c.merged || 0,
        code: c.code || 0,
        cowork: c.cowork || 0,
        instances: c.instances || 0,
        skippedRunning: c.skippedRunning || 0,
        runningLabels: c.runningLabels || [],
        reason: c.reason || null,
      };
    },
  },
  {
    name: 'keyflip_browser_status',
    title: 'Browser claude.ai account (Chrome extension)',
    description:
      'macOS only. Which claude.ai account each Chromium browser (Chrome/Brave/Edge/Arc) is signed into, and whether it MATCHES the active CLI/desktop account. The Claude Chrome extension inherits the browser session, so a mismatch means its browser features cannot connect ("user mismatch"). Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) {
      if (ctx.platform !== 'darwin') return { supported: false, reason: 'macOS-only' };
      const st = loginmod.parseAuthStatus(
        exec.run('claude', ['auth', 'status'], undefined, { timeoutMs: 8000 }).stdout,
      );
      const activeOrg = st && st.orgId;
      const browsers = browser.installed(ctx.home).map(function (b) {
        const ck = browser.readClaudeCookies(b, {});
        return {
          id: b.id,
          name: b.name,
          signedIn: !!ck,
          org: (ck && ck.org) || null,
          matchesActive: !!(ck && ck.org && activeOrg && ck.org === activeOrg),
        };
      });
      return { active: (st && st.email) || activeOrg || null, browsers: browsers };
    },
  },
  {
    name: 'keyflip_browser_logout',
    title: 'Clear the browser claude.ai session',
    description:
      'macOS only. Clears the claude.ai cookies from Chromium browsers so the user can sign in as the right account and the Claude extension reconnects. Backs up each Cookies DB (reversible) and REFUSES while the browser is running (the user must quit it first). Mutating — ask the user, then confirm=true. Optional browserId=chrome|brave|edge|arc.',
    inputSchema: {
      type: 'object',
      properties: { browserId: { type: 'string' }, confirm: confirmProp.confirm },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      if (ctx.platform !== 'darwin') throw new Error('browser logout is macOS-only');
      const list = browser.installed(ctx.home).filter(function (b) {
        return !args.browserId || b.id === args.browserId;
      });
      if (!list.length) throw new Error('no matching installed browser (chrome|brave|edge|arc)');
      return {
        results: list.map(function (b) {
          const r = browser.clearClaudeCookies(b, {});
          return { id: b.id, ok: !!r.ok, reason: r.reason || null, backup: r.backup || null };
        }),
      };
    },
  },

  // ---- cross-machine migration ----
  {
    name: 'keyflip_migrate_export',
    title: 'Bundle accounts + sessions for another machine',
    description:
      "Write a portable bundle of ALL accounts (secrets), providers (keys) and Claude Code session transcripts to `path`, to carry to another machine. Pass passphrase_file to encrypt it (AES-256-GCM) — STRONGLY recommended, the plaintext bundle contains login secrets. Set agents=true to ALSO carry OTHER AI agents' home-level memory files (Cursor rules, Gemini GEMINI.md, Codex AGENTS.md/memories — markdown only, no secrets); narrow with agent_ids. Set agent_config=true to also carry those agents' CONFIG files (MCP servers/settings) — secret-scanned + redacted by default, so keys never travel (re-enter them on the new machine). Set agent_config_secrets=true to carry the REAL keys instead — this REQUIRES passphrase_file (refused otherwise, so keys are never written in plaintext). Desktop-app/browser logins are machine-bound and NOT included. Writes a secret file — ask the user, then confirm=true.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        passphrase_file: {
          type: 'string',
          description: 'File whose contents are the encryption passphrase. Omit to write an UNENCRYPTED bundle.',
        },
        no_sessions: { type: 'boolean' },
        no_providers: { type: 'boolean' },
        agents: { type: 'boolean', description: "Also carry other agents' home-level memory (markdown, no secrets)." },
        agent_config: {
          type: 'boolean',
          description: "Also carry other agents' config files (MCP/settings), secret-scanned + redacted.",
        },
        agent_config_secrets: {
          type: 'boolean',
          description: 'Carry the REAL agent-config keys (not redacted). Requires passphrase_file.',
        },
        agent_ids: {
          type: 'array',
          items: { type: 'string', enum: ['cursor', 'gemini', 'codex', 'copilot', 'opencode', 'aider'] },
          description: 'Limit agents/agent_config to these agent ids (default: all present).',
        },
        confirm: confirmProp.confirm,
      },
      required: ['path', 'confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async function (ctx, args) {
      needConfirm(args);
      const out = String(args.path);
      const pass = args.passphrase_file ? fs.readFileSync(String(args.passphrase_file), 'utf8').trim() : null;
      // On the programmatic path there is no human to heed a warning, so carrying real keys
      // to a plaintext file is a hard error — require encryption.
      if (args.agent_config_secrets && !pass)
        throw new Error(
          'agent_config_secrets carries real API keys — pass passphrase_file to encrypt the bundle (or use agent_config for a redacted copy)',
        );
      const built = migrate.buildBundle(ctx, {
        noSessions: !!args.no_sessions,
        noProviders: !!args.no_providers,
        agents: !!args.agents,
        agentConfig: !!(args.agent_config || args.agent_config_secrets),
        agentConfigSecrets: !!args.agent_config_secrets,
        agentIds: Array.isArray(args.agent_ids) ? args.agent_ids : undefined,
      });
      if (
        !built.counts.accounts &&
        !built.counts.transcripts &&
        !built.counts.providers &&
        !built.counts.agents &&
        !built.counts.agentConfig &&
        !built.counts.memory &&
        !built.counts.config
      )
        throw new Error('nothing to migrate (no accounts, providers, transcripts, memory, config, or agents found)');
      let json = JSON.stringify(built.bundle);
      if (pass) json = sync.encrypt(json, pass);
      fs.writeFileSync(out, json + '\n', { mode: 0o600 });
      try {
        fs.chmodSync(out, 0o600);
      } catch (e) {
        /* non-POSIX FS */
      }
      logmod.log('mcp migrate export -> ' + out);
      return { path: out, encrypted: !!pass, counts: built.counts, skippedAccounts: built.skippedAccounts };
    },
  },
  {
    name: 'keyflip_migrate_import',
    title: 'Merge a migration bundle into this machine',
    description:
      'Merge a bundle from keyflip_migrate_export into THIS machine: accounts, providers and session transcripts are UNIONed — anything already here is KEPT, never clobbered, unless force=true. Pass passphrase_file if the bundle is encrypted. After merging it re-syncs the desktop app chat index (unless the app is open). Mutating — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        passphrase_file: { type: 'string' },
        force: { type: 'boolean' },
        no_consolidate: { type: 'boolean' },
        confirm: confirmProp.confirm,
      },
      required: ['path', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const raw = fs.readFileSync(String(args.path), 'utf8');
      let obj;
      try {
        obj = JSON.parse(raw);
      } catch (e) {
        throw new Error('that file is not valid JSON');
      }
      if (obj && obj.magic === 'keyflip-sync') {
        const pass = args.passphrase_file ? fs.readFileSync(String(args.passphrase_file), 'utf8').trim() : null;
        if (!pass) throw new Error('this bundle is encrypted — pass passphrase_file');
        obj = JSON.parse(sync.decrypt(raw, pass));
      }
      const l = await lock.acquire(ctx.configDir);
      let res;
      try {
        res = migrate.applyBundle(ctx, obj, { force: !!args.force });
      } finally {
        l.release();
      }
      if (!args.no_consolidate && !appctl.isClaudeRunning(ctx.platform)) {
        try {
          appsessions.consolidate(ctx);
        } catch (e) {
          /* best-effort */
        }
      }
      logmod.log('mcp migrate import: +' + res.transcripts.added + ' tx');
      return {
        accounts: res.accounts,
        providers: res.providers,
        transcripts: res.transcripts,
        memory: res.memory,
        agents: res.agents,
        agentConfig: res.agentConfig,
      };
    },
  },
  {
    name: 'keyflip_migrate_push',
    title: 'Relay a migration bundle via WebDAV',
    description:
      'Push the full encrypted bundle (accounts+providers+transcripts+memory) to a WebDAV URL, to pull on another machine. Passphrase REQUIRED (payload has secrets). Mutating (writes secrets to a remote) — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        passphrase_file: { type: 'string' },
        user: { type: 'string' },
        pass_file: { type: 'string' },
        confirm: confirmProp.confirm,
      },
      required: ['url', 'passphrase_file', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const o = {
        url: String(args.url),
        user: args.user,
        passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim(),
        pass: args.pass_file ? fs.readFileSync(String(args.pass_file), 'utf8').trim() : null,
      };
      const counts = await migrate.pushBundle(ctx, o);
      return { pushed: counts };
    },
  },
  {
    name: 'keyflip_migrate_pull',
    title: 'Pull + merge a WebDAV migration bundle',
    description:
      'Pull the encrypted bundle from a WebDAV URL and MERGE it into this machine (union; existing kept unless force). Passphrase REQUIRED. Mutating — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        passphrase_file: { type: 'string' },
        user: { type: 'string' },
        pass_file: { type: 'string' },
        force: { type: 'boolean' },
        confirm: confirmProp.confirm,
      },
      required: ['url', 'passphrase_file', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const o = {
        url: String(args.url),
        user: args.user,
        passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim(),
        pass: args.pass_file ? fs.readFileSync(String(args.pass_file), 'utf8').trim() : null,
      };
      const pulled = await migrate.pullBundle(ctx, o);
      if (!pulled.found) throw new Error('no bundle at that URL');
      const l = await lock.acquire(ctx.configDir);
      let res;
      try {
        res = migrate.applyBundle(ctx, pulled.bundle, { force: !!args.force });
      } finally {
        l.release();
      }
      return { merged: res };
    },
  },
  {
    name: 'keyflip_fleet_status',
    title: 'See every associated machine (the fleet)',
    description:
      'Read the FLEET: every associated keyflip machine that has checked in to the shared encrypted rendezvous — its accounts (+cached quota), active account, and recent chats with reply status (assistant = replied, user = waiting). Also flags chats that got a NEW reply since the last check. Read-only. Requires the fleet passphrase_file.',
    inputSchema: {
      type: 'object',
      properties: { passphrase_file: { type: 'string' } },
      required: ['passphrase_file'],
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      const fleet = _fleet;
      const b = fleet.bus(ctx, { passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim() });
      const statuses = fleet.readFleet(ctx, b);
      const nr = fleet.newReplies(ctx, statuses);
      fleet.saveSeen(ctx, nr.snapshot);
      // Read-only status must never surface credentials into the model/transcript — creds-free view.
      return { machines: statuses.map(fleet.sanitizeStatus), newReplies: nr.newReplies };
    },
  },
  {
    name: 'keyflip_fleet_push',
    title: 'Check in with the fleet (publish status, process the inbox)',
    description:
      "Publish THIS machine's status (accounts, active account, recent chats) to the shared encrypted rendezvous and process whatever other machines queued for it — the same operation as `keyflip fleet push`. Publishing is safe. Queued switch/save-account commands are origin-verified but stay SKIPPED unless apply=true, which mutates this machine (ask the user first). with_secrets additionally puts this machine's account credentials into the encrypted rendezvous so another machine can receive them — only with explicit consent. Mutating (writes the rendezvous; may apply commands) — confirm=true.",
    inputSchema: {
      type: 'object',
      properties: {
        passphrase_file: { type: 'string' },
        with_secrets: {
          type: 'boolean',
          description: 'Also publish account credentials (encrypted) for relay. Ask the user first.',
        },
        apply: {
          type: 'boolean',
          description: 'Apply queued switch/save-account commands. Ask the user first; false leaves them skipped.',
        },
        confirm: confirmProp.confirm,
      },
      required: ['passphrase_file', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const fleet = _fleet;
      const b = fleet.bus(ctx, { passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim() });
      const status = fleet.publish(ctx, b, { withSecrets: !!args.with_secrets });
      const reconcile = fleet.reconcileKeys(ctx, fleet.readFleet(ctx, b));
      const outcome = await fleet.processInbox(ctx, b, {
        reconcile: reconcile,
        allowSwitch: !!args.apply,
        allowSave: !!args.apply,
      });
      // Counts only — never echo the status (or creds, with with_secrets) back into the transcript.
      return {
        published: {
          machine: b.name,
          accounts: status.accounts.length,
          chats: (status.chats || []).length,
          withSecrets: !!args.with_secrets,
        },
        applied: outcome.results,
        pending: reconcile.pending,
        conflicts: reconcile.conflicts,
      };
    },
  },
  {
    name: 'keyflip_fleet_switch',
    title: 'Queue an account switch on a remote machine',
    description:
      "Queue a command telling ANOTHER fleet machine to switch to a given saved account — it applies on that machine's next `keyflip fleet push` (with the user's consent there). Mutating (writes to the shared rendezvous) — ask the user, then confirm=true.",
    inputSchema: {
      type: 'object',
      properties: {
        machine: { type: 'string', description: 'Target machine name or id.' },
        account: { type: 'string' },
        passphrase_file: { type: 'string' },
        confirm: confirmProp.confirm,
      },
      required: ['machine', 'account', 'passphrase_file', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const fleet = _fleet;
      const b = fleet.bus(ctx, { passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim() });
      const m = fleet.readFleet(ctx, b).filter(function (s) {
        return (
          s.name === args.machine || s.machineId === args.machine || s.machineId.indexOf(String(args.machine)) === 0
        );
      });
      if (m.length !== 1) throw new Error("no single fleet machine named '" + args.machine + "'");
      fleet.publish(ctx, b, {}); // publish our status so the target can TOFU-pin our key and verify us
      const cmd = fleet.queue(ctx, b, m[0].machineId, { type: 'switch', payload: { account: String(args.account) } });
      return { queued: { target: m[0].name, account: args.account, id: cmd.id } };
    },
  },
  {
    name: 'keyflip_fleet_send_account',
    title: 'Distribute an account to a remote machine',
    description:
      'Queue a command handing a saved account (yours, or with from=<machine> one that machine published with credentials) to ANOTHER fleet machine — it saves it on its next `keyflip fleet push`. This is how machine A gives machine B an account that lives on machine C. Mutating (writes login secrets to the encrypted rendezvous) — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string' },
        to: { type: 'string' },
        from: {
          type: 'string',
          description: "Relay: pull the account from this machine's published creds instead of your own.",
        },
        passphrase_file: { type: 'string' },
        confirm: confirmProp.confirm,
      },
      required: ['account', 'to', 'passphrase_file', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const fleet = _fleet;
      const transfer = _transfer;
      const b = fleet.bus(ctx, { passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim() });
      const statuses = fleet.readFleet(ctx, b);
      const to = statuses.filter(function (s) {
        return s.name === args.to || s.machineId === args.to;
      })[0];
      if (!to) throw new Error("no fleet machine named '" + args.to + "'");
      let acct;
      if (args.from) {
        const from = statuses.filter(function (s) {
          return s.name === args.from || s.machineId === args.from;
        })[0];
        acct = from && fleet.accountFrom(from, String(args.account));
        if (!acct)
          throw new Error("'" + args.from + "' has not published account '" + args.account + "' with credentials");
      } else {
        acct = transfer.buildExport(ctx).envelope.accounts.filter(function (a) {
          return a.name === String(args.account);
        })[0];
        if (!acct) throw new Error("no local account '" + args.account + "'");
      }
      fleet.publish(ctx, b, {}); // publish our status so the target can TOFU-pin our key and verify us
      const cmd = fleet.queue(ctx, b, to.machineId, { type: 'save-account', payload: { account: acct } });
      return { queued: { target: to.name, account: args.account, id: cmd.id } };
    },
  },
  {
    name: 'keyflip_fleet_trust',
    title: "Re-pin a fleet machine's signing key after a legitimate re-key",
    description:
      "Origin authentication: each fleet machine signs its commands with an Ed25519 key; a receiver trust-on-first-use PINS each peer's public key and REJECTS commands if that key later changes (a possible key-substitution attack via the shared folder). Use this ONLY when a machine legitimately re-keyed (fresh install / reset) and you want to trust its NEW key so its commands verify again. This overrides a security safety flag — confirm with the user that the change is expected. Mutating (updates the local pinned-key store) — confirm=true.",
    inputSchema: {
      type: 'object',
      properties: {
        machine: { type: 'string', description: 'Machine name or id whose current published key to (re)pin.' },
        passphrase_file: { type: 'string' },
        confirm: confirmProp.confirm,
      },
      required: ['machine', 'passphrase_file', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const fleet = _fleet;
      const b = fleet.bus(ctx, { passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim() });
      const m = fleet.readFleet(ctx, b).filter(function (s) {
        return s.name === args.machine || s.machineId === args.machine;
      })[0];
      if (!m) throw new Error("no fleet machine named '" + args.machine + "'");
      if (!m.pubKey) throw new Error("'" + args.machine + "' has not published a signing key yet");
      const pinned = fleet.knownKeys(ctx)[m.machineId];
      fleet.trustKey(ctx, m.machineId, m.pubKey);
      return { trusted: { machine: m.name, machineId: m.machineId, changed: !!pinned && pinned !== m.pubKey } };
    },
  },
  {
    name: 'keyflip_fleet_keys',
    title: 'Audit fleet machine signing keys (origin-auth trust state)',
    description:
      "List every fleet machine's pinned Ed25519 signing-key fingerprint and whether the machine's currently-published key still MATCHES the pin (status: ok / CHANGED = possible key substitution / unpinned = publishing but NOT trusted yet / offline). Read-only — use to audit the origin-auth trust store before trusting or acting on a machine. A NEW peer is never auto-pinned (it appears as `unpinned` and its commands are ignored); trust it deliberately via `keyflip fleet invite`/`join --code` or `keyflip_fleet_trust` after comparing fingerprints out-of-band.",
    inputSchema: {
      type: 'object',
      properties: { passphrase_file: { type: 'string' } },
      required: ['passphrase_file'],
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      const fleet = _fleet;
      const b = fleet.bus(ctx, { passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim() });
      return { keys: fleet.keyReport(ctx, fleet.readFleet(ctx, b)) };
    },
  },
  {
    name: 'keyflip_fleet_discover',
    title: 'Find keyflip machines on this LAN (no shared folder needed)',
    description:
      'Listen for the UDP multicast beacon other keyflip machines announce and report the peers on the same network — the shared rendezvous folder is NOT required. While listening this also ANNOUNCES this machine (ON by default; the user can turn it off with `keyflip fleet announce off`). Carries public identity only (machine id, display name, and the short SHA-256 fingerprint of the Ed25519 signing key) — never a passphrase, private key or command, so the result is safe to print. A discovered peer is only REACHABLE: acting on one needs the fleet passphrase, and its key must be pinned — NEW peers are never auto-trusted (they show as `pending`), so pairing is a deliberate `keyflip fleet invite` / `fleet join --code` (CLI-only: the one-time code is a secret a human must relay, never routed through this tool) or an explicit `keyflip_fleet_trust` after comparing fingerprints.',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_ms: { type: 'integer', description: 'How long to listen (default 3000, min 200).' },
      },
      additionalProperties: false,
    },
    annotations: RO_NET,
    run: async function (ctx, args) {
      const fleet = _fleet;
      const self = fleet.identity(ctx);
      const me = { machineId: self.machineId, name: self.name, fp: fleet.fingerprint(fleet.publicKey(ctx)) };
      const ms = Number(args.timeout_ms) > 0 ? Math.max(200, Number(args.timeout_ms)) : 3000;
      const peers = await _lanfleet.discover({ timeoutMs: ms, exclude: self.machineId });
      return { self: me, peers: peers, ms: ms };
    },
  },
  {
    name: 'keyflip_fleet_collect',
    title: 'Gather every account published across the fleet onto this machine',
    description:
      'Import EVERY account that fleet machines have published WITH credentials (via `fleet push --with-secrets`) onto THIS machine, deduped by name. Existing accounts are kept unless force=true. Mutating (writes login secrets locally) — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: { passphrase_file: { type: 'string' }, force: { type: 'boolean' }, confirm: confirmProp.confirm },
      required: ['passphrase_file', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const fleet = _fleet;
      const transfer = _transfer;
      const b = fleet.bus(ctx, { passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim() });
      const seen = Object.create(null);
      const toImport = [];
      fleet.readFleet(ctx, b).forEach(function (s) {
        Object.keys(s.creds || {}).forEach(function (name) {
          if (seen[name]) return;
          seen[name] = 1;
          const a = fleet.accountFrom(s, name);
          if (a) toImport.push(a);
        });
      });
      if (!toImport.length)
        throw new Error(
          'no accounts published with credentials across the fleet (machines must `keyflip fleet push --with-secrets`)',
        );
      const l = await lock.acquire(ctx.configDir);
      let res;
      try {
        res = transfer.applyImport(
          ctx,
          { format: transfer.FORMAT, version: transfer.VERSION, accounts: toImport },
          { force: !!args.force },
        );
      } finally {
        l.release();
      }
      return { collected: res };
    },
  },
  {
    name: 'keyflip_account_remove',
    title: 'Delete a saved account',
    description:
      'Permanently delete a saved account and its stored credential from THIS machine. IRREVERSIBLE — the credential cannot be recovered. Refuses if the account is the active one that a running Claude session is using (close it first, or force=true). Mutating + destructive — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Account name (from keyflip_list).' },
        force: { type: 'boolean', description: 'Delete even if it is the active account in use.' },
        confirm: confirmProp.confirm,
      },
      required: ['name', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const name = core.resolveProfile(ctx, String(args.name));
      if (!name) throw new Error("no such account: '" + args.name + "' (use keyflip_list)");
      const em = profiles.email(ctx.configDir, name);
      if (!args.force && em && em === core.currentEmail(ctx)) {
        const live = appctl.claudeInstances(ctx.home);
        if (live.length)
          throw new Error(
            "'" +
              em +
              "' is the active account " +
              live.length +
              ' running Claude session(s) are using — close them first, or set force=true',
          );
      }
      const l = await lock.acquire(ctx.configDir);
      try {
        core.removeProfile(ctx, name);
      } finally {
        l.release();
      }
      return { removed: name };
    },
  },
  {
    name: 'keyflip_provider_remove',
    title: 'Delete a saved provider',
    description:
      'Permanently delete a saved provider endpoint and its stored API key/bearer from THIS machine. IRREVERSIBLE. Mutating + destructive — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Provider name (from keyflip_providers).' },
        confirm: confirmProp.confirm,
      },
      required: ['name', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);

      if (!provider.exists(ctx, String(args.name)))
        throw new Error("no such provider: '" + args.name + "' (use keyflip_providers)");
      const l = await lock.acquire(ctx.configDir);
      try {
        provider.remove(ctx, String(args.name));
      } finally {
        l.release();
      }
      return { removed: String(args.name) };
    },
  },

  // ---- CLI<->MCP parity tools (2026-07-07 audit): gateway / mcpreg / speedtest / share / sync / link / transfer ----
  {
    name: 'keyflip_gateway_status',
    title: 'Is the Claude DESKTOP app routed through a provider?',
    description:
      'Report whether the Claude DESKTOP app is currently pointed at a third-party gateway/provider vs first-party Anthropic. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) {
      const g = _desktopgw.active(ctx);
      return { gateway: g ? g.provider : null, firstParty: !g };
    },
  },
  {
    name: 'keyflip_gateway_use',
    title: 'Route the Claude desktop app through a provider',
    description:
      'Point the Claude DESKTOP app at a saved provider (gateway); takes effect after the app restarts. Mutating (rewrites the desktop app config) — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: { provider: { type: 'string' }, confirm: confirmProp.confirm },
      required: ['provider', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      if (!provider.exists(ctx, String(args.provider))) throw new Error("no such provider: '" + args.provider + "'");
      const l = await lock.acquire(ctx.configDir);
      let r;
      try {
        r = _desktopgw.use(ctx, String(args.provider));
      } finally {
        l.release();
      }
      return { gateway: String(args.provider), dirs: r.dirs, note: 'restart the desktop app to apply' };
    },
  },
  {
    name: 'keyflip_gateway_off',
    title: 'Restore the Claude desktop app to first-party',
    description:
      'Restore the Claude DESKTOP app to first-party (Anthropic), undoing a gateway; takes effect after the app restarts. Mutating — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: { confirm: confirmProp.confirm },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const l = await lock.acquire(ctx.configDir);
      try {
        _desktopgw.restore(ctx);
      } finally {
        l.release();
      }
      return { restored: true, note: 'restart the desktop app to apply' };
    },
  },
  {
    name: 'keyflip_mcpreg_list',
    title: 'List registered third-party MCP servers',
    description:
      'List the MCP servers keyflip has registered (that it can enable/disable in Claude Code / Desktop configs). Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) {
      return { servers: _mcpreg.list(ctx) };
    },
  },
  {
    name: 'keyflip_mcpreg_set',
    title: 'Register/update a third-party MCP server',
    description:
      "Register (or update) a named MCP server definition (command + args + env) in keyflip's registry so it can be enabled on Claude Code / Desktop. Mutating — ask the user, then confirm=true.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        env: { type: 'object', additionalProperties: { type: 'string' } },
        confirm: confirmProp.confirm,
      },
      required: ['name', 'command', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const l = await lock.acquire(ctx.configDir);
      let e;
      try {
        e = _mcpreg.add(ctx, String(args.name), {
          command: String(args.command),
          args: args.args || [],
          env: args.env || {},
        });
      } finally {
        l.release();
      }
      return { registered: String(args.name), entry: e };
    },
  },
  {
    name: 'keyflip_mcpreg_enable',
    title: 'Enable/disable a registered MCP server on a surface',
    description:
      'Enable or disable a registered MCP server on a surface — "claude-code" or "claude-desktop". Mutating (writes the target app config) — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        surface: { type: 'string', enum: ['claude-code', 'claude-desktop'] },
        enabled: { type: 'boolean' },
        confirm: confirmProp.confirm,
      },
      required: ['name', 'surface', 'enabled', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const l = await lock.acquire(ctx.configDir);
      let r;
      try {
        r = _mcpreg.setEnabled(ctx, String(args.name), String(args.surface), !!args.enabled);
      } finally {
        l.release();
      }
      return { name: String(args.name), surface: String(args.surface), enabled: !!args.enabled, result: r };
    },
  },
  {
    name: 'keyflip_mcpreg_remove',
    title: 'Remove a registered MCP server',
    description:
      "Remove a registered MCP server from keyflip's registry and unhook it from both surfaces. Mutating — ask the user, then confirm=true.",
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, confirm: confirmProp.confirm },
      required: ['name', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const l = await lock.acquire(ctx.configDir);
      try {
        _mcpreg.remove(ctx, String(args.name));
      } finally {
        l.release();
      }
      return { removed: String(args.name) };
    },
  },
  {
    name: 'keyflip_speedtest',
    title: "Rank a provider's endpoints by latency (read-only)",
    description:
      "Measure and RANK a provider's candidate endpoints by latency WITHOUT changing anything (read-only diagnostic; does NOT switch the active baseUrl — run `keyflip speedtest` on the CLI to also apply the fastest). Returns per-endpoint ms + the fastest URL.",
    inputSchema: {
      type: 'object',
      properties: { provider: { type: 'string' } },
      required: ['provider'],
      additionalProperties: false,
    },
    annotations: RO_NET,
    run: async function (ctx, args) {
      const r = await provider.speedtest(ctx, String(args.provider), { noPersist: true });
      return { results: r.results, fastest: r.fastest };
    },
  },
  {
    name: 'keyflip_share',
    title: 'Build a keyflip:// share link',
    description:
      'Build a keyflip:// import link for a saved provider or account. For a provider, no_secrets=true omits the API key (pointer only); account links are ALWAYS pointer-only (never carry the OAuth token). Read-only (builds a string).',
    inputSchema: {
      type: 'object',
      properties: {
        resource: { type: 'string', enum: ['provider', 'account'] },
        name: { type: 'string' },
        no_secrets: { type: 'boolean' },
      },
      required: ['resource', 'name'],
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      return { url: _share.build(ctx, String(args.resource), String(args.name), { noSecrets: !!args.no_secrets }) };
    },
  },
  {
    name: 'keyflip_share_apply',
    title: 'Import from a keyflip:// share link',
    description:
      'Parse and APPLY a keyflip:// import link (saves the provider, or creates a pointer-only account). Mutating — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, confirm: confirmProp.confirm },
      required: ['url', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const share = _share;
      const parsed = share.parse(String(args.url));
      const l = await lock.acquire(ctx.configDir);
      let r;
      try {
        r = share.apply(ctx, parsed);
      } finally {
        l.release();
      }
      return { imported: r };
    },
  },
  {
    name: 'keyflip_sync_test',
    title: 'Test a WebDAV sync endpoint',
    description:
      'Check that a WebDAV URL is reachable for encrypted account sync. Read-only network probe. pass_file (optional) is a FILE holding the WebDAV password — never pass secrets inline.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, user: { type: 'string' }, pass_file: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    },
    annotations: RO_NET,
    run: async function (ctx, args) {
      const pass = args.pass_file ? fs.readFileSync(String(args.pass_file), 'utf8').trim() : null;
      return await sync.test({ url: String(args.url), user: args.user || null, pass: pass });
    },
  },
  {
    name: 'keyflip_sync_push',
    title: 'Push encrypted accounts to WebDAV',
    description:
      "Encrypt this machine's accounts (passphrase from passphrase_file) and PUT them to a WebDAV URL. Secrets are only ever read from files, never argv. Mutating (writes to the remote) — ask the user, then confirm=true.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        passphrase_file: { type: 'string' },
        user: { type: 'string' },
        pass_file: { type: 'string' },
        confirm: confirmProp.confirm,
      },
      required: ['url', 'passphrase_file', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const o = {
        url: String(args.url),
        user: args.user || null,
        pass: args.pass_file ? fs.readFileSync(String(args.pass_file), 'utf8').trim() : null,
        passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim(),
      };
      return await sync.push(ctx, o);
    },
  },
  {
    name: 'keyflip_sync_pull',
    title: 'Pull + merge encrypted accounts from WebDAV',
    description:
      'GET the encrypted snapshot from a WebDAV URL, decrypt it (passphrase_file), and MERGE locally (a safety backup of current credentials is written first; existing accounts kept unless force=true). Mutating — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        passphrase_file: { type: 'string' },
        user: { type: 'string' },
        pass_file: { type: 'string' },
        force: { type: 'boolean' },
        confirm: confirmProp.confirm,
      },
      required: ['url', 'passphrase_file', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const o = {
        url: String(args.url),
        user: args.user || null,
        pass: args.pass_file ? fs.readFileSync(String(args.pass_file), 'utf8').trim() : null,
        passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim(),
      };
      const p = await sync.pull(ctx, o);
      if (!p.found) throw new Error('no snapshot at that URL');
      const l = await lock.acquire(ctx.configDir);
      let res;
      try {
        res = sync.apply(ctx, p, { force: !!args.force });
      } finally {
        l.release();
      }
      return { remote: p.meta, applied: res };
    },
  },
  {
    name: 'keyflip_links',
    title: 'List directory→account pins',
    description:
      'List the directory→account pins (used by `keyflip run` to auto-select an account per directory). Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) {
      return { links: _links.readAll(ctx) };
    },
  },
  {
    name: 'keyflip_link',
    title: 'Pin a directory to an account',
    description:
      'Pin a directory (absolute path) to a saved account so `keyflip run` there uses it. Set remove=true to unpin (account not needed then). Mutating — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string' },
        account: { type: 'string' },
        remove: { type: 'boolean' },
        confirm: confirmProp.confirm,
      },
      required: ['dir', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const links = _links;
      const dir = String(args.dir);
      const l = await lock.acquire(ctx.configDir);
      try {
        if (args.remove) {
          return { unlinked: links.remove(ctx, dir) ? dir : null };
        }
        const name = core.resolveProfile(ctx, String(args.account || ''));
        if (!name) throw new Error("no such account: '" + args.account + "'");
        links.set(ctx, dir, name);
        return { linked: { dir: dir, account: name } };
      } finally {
        l.release();
      }
    },
  },
  {
    name: 'keyflip_transfer_pull',
    title: 'Pull + merge a bundle from a LAN peer',
    description:
      'Pull the full bundle (accounts + providers + transcripts + memory) from a machine running `keyflip transfer serve`, using its one-time code, and MERGE it (existing entries kept unless force=true). host is "<host:port>" shown on the serving machine. Mutating — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        code: { type: 'string' },
        force: { type: 'boolean' },
        confirm: confirmProp.confirm,
      },
      required: ['host', 'code', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const bundle = await _lantransfer.pull({ host: String(args.host), code: String(args.code) });
      const l = await lock.acquire(ctx.configDir);
      let res;
      try {
        res = migrate.applyBundle(ctx, bundle, { force: !!args.force });
      } finally {
        l.release();
      }
      return { merged: { accounts: res.accounts, providers: res.providers, transcripts: res.transcripts } };
    },
  },
  {
    name: 'keyflip_transfer_relay_pull',
    title: 'Pull + merge a bundle via the internet relay',
    description:
      'One-shot pull of a bundle a peer uploaded with `keyflip transfer serve --relay`, THROUGH a user-controlled relay (a synced-folder path OR a WebDAV URL — no LAN needed), using the one-time code shown on the sending machine ("<rendezvous>-<key>"). Decrypts with the code, MERGES it (existing entries kept unless force=true), then deletes the blob from the relay (one-shot). The relay is zero-knowledge — the key half never reaches it. Mutating — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        relay: { type: 'string', description: 'A synced-folder path or a WebDAV URL.' },
        code: { type: 'string', description: 'The "<rendezvous>-<key>" one-time code shown on the sender.' },
        user: { type: 'string', description: 'WebDAV username (URL relay).' },
        pass_file: {
          type: 'string',
          description: 'File holding the WebDAV password (URL relay) — never the literal secret.',
        },
        force: { type: 'boolean' },
        confirm: confirmProp.confirm,
      },
      required: ['relay', 'code', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const rt = _rt;
      const r = await rt.pull(ctx, {
        relay: String(args.relay),
        code: String(args.code),
        user: args.user,
        pass: args.pass_file ? fs.readFileSync(String(args.pass_file), 'utf8').trim() : undefined,
        fetch: typeof fetch !== 'undefined' ? fetch : undefined,
      });
      if (!r.found)
        throw new Error('no transfer at that relay for this code (already picked up, expired, or wrong code)');
      const l = await lock.acquire(ctx.configDir);
      let res;
      try {
        res = migrate.applyBundle(ctx, r.bundle, { force: !!args.force });
      } finally {
        l.release();
      }
      try {
        await r.cleanup();
      } catch (e) {
        /* one-shot delete is best-effort; the relay TTL sweeps it otherwise */
      }
      return { merged: { accounts: res.accounts, providers: res.providers, transcripts: res.transcripts } };
    },
  },
  {
    name: 'keyflip_autoswitch_tick',
    title: 'Evaluate usage once and auto-switch if over threshold',
    description:
      "Run ONE autoswitch evaluation: check the active account's usage headroom and, if it is at/over the threshold, switch the CLI to the next available account. Returns the decision (state / headroom / switchedTo). Mutating (MAY switch the active account) — ask the user, then confirm=true.",
    inputSchema: {
      type: 'object',
      properties: {
        threshold: { type: 'number', description: 'Utilization % at which to switch (default 90).' },
        confirm: confirmProp.confirm,
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      // Mirror the CLI: lock ONLY the switch, not the (network) usage evaluation.
      const opts = {
        performSwitch: function (name) {
          return (async function () {
            const l = await lock.acquire(ctx.configDir);
            try {
              return core.performSwitch(ctx, name);
            } finally {
              l.release();
            }
          })();
        },
      };
      if (args.threshold !== undefined) opts.threshold = args.threshold;
      return await _autoswitch.tick(ctx, opts);
    },
  },
  {
    name: 'keyflip_autoswitch_service',
    title: 'Run autoswitch unattended (background service)',
    description:
      'Install/remove/inspect the UNATTENDED autoswitch service (launchd on macOS, cron on Linux) that runs `keyflip autoswitch --once` on an interval — so account rotation happens on its own without a terminal open (the fix for "autoswitch never runs"). action="status" (read) | "install" | "remove". install schedules automatic account switching at the threshold — for install/remove, ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'install', 'remove'] },
        interval: { type: 'integer', description: 'Seconds between checks (default 300, clamped 60..21600).' },
        threshold: { type: 'integer', description: 'Utilization % to switch at.' },
        strategy: { type: 'string', enum: ['best', 'next-available'] },
        group: { type: 'string' },
        confirm: confirmProp.confirm,
      },
      required: ['action', 'confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async function (ctx, args) {
      const svc = _svc;
      if (args.action === 'status') return { autoswitchService: svc.status(ctx, { home: ctx.home }) };
      needConfirm(args);
      if (args.action === 'remove') return { removed: svc.uninstall(ctx, { home: ctx.home }) };
      const r = svc.install(ctx, {
        home: ctx.home,
        interval: args.interval,
        threshold: args.threshold,
        strategy: args.strategy,
        group: args.group,
      });
      if (!r.ok) throw new Error('could not install the autoswitch service: ' + (r.reason || r.detail || 'unknown'));
      return { installed: r };
    },
  },

  // ---- Wave-1 features (2026-07-07): groups / budget / import-env / shell-init / audit-log / notify ----
  {
    name: 'keyflip_groups',
    title: 'List account groups/tags',
    description:
      'Account groups (tags) used to SCOPE rotation and failover to a pool. With no args returns { groups: {group->members}, tags: {account->tags} }; with group="<g>" returns that group\'s members. Read-only.',
    inputSchema: { type: 'object', properties: { group: { type: 'string' } }, additionalProperties: false },
    annotations: RO,
    run: async function (ctx, args) {
      const groups = _groups;
      if (args && args.group) return { group: String(args.group), members: groups.membersOf(ctx, String(args.group)) };
      return { groups: groups.listGroups(ctx), tags: groups.readAll(ctx) };
    },
  },
  {
    name: 'keyflip_group_tag',
    title: 'Tag an account into a group',
    description:
      'Add one or more group tags to an account so group-scoped rotation (`keyflip next --group <g>`) and failover can target it. Mutating — ask the user first, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string' },
        groups: { type: 'array', items: { type: 'string' } },
        confirm: confirmProp.confirm,
      },
      required: ['account', 'groups', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const g = _groups;
      const name = core.resolveProfile(ctx, String(args.account));
      if (!name) throw new Error("no such account: '" + args.account + "'");
      const tags = Array.isArray(args.groups) ? args.groups : [];
      if (!tags.length) throw new Error('provide at least one group');
      const l = await lock.acquire(ctx.configDir);
      try {
        let cur = g.tagsFor(ctx, name);
        tags.forEach(function (t) {
          cur = g.addTag(ctx, name, String(t));
        });
        return { account: name, tags: cur };
      } finally {
        l.release();
      }
    },
  },
  {
    name: 'keyflip_group_untag',
    title: 'Remove an account from a group',
    description: 'Remove a group tag from an account. Mutating — ask the user first, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: { account: { type: 'string' }, group: { type: 'string' }, confirm: confirmProp.confirm },
      required: ['account', 'group', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const g = _groups;
      const name = core.resolveProfile(ctx, String(args.account));
      if (!name) throw new Error("no such account: '" + args.account + "'");
      const l = await lock.acquire(ctx.configDir);
      try {
        return { account: name, tags: g.removeTag(ctx, name, String(args.group)) };
      } finally {
        l.release();
      }
    },
  },
  {
    name: 'keyflip_budget_status',
    title: 'Usage budgets + breach alerts',
    description:
      'Report per-account usage BUDGETS (5-hour / 7-day % ceilings, per account or a "*" default that covers every account) alongside current cached usage, flagging every account/window at/over its ceiling ("breach") or within 10% ("warn"). Reads keyflip\'s usage cache — does NOT fetch (run keyflip_usage_history first to refresh). Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) {
      return _budget.status(ctx);
    },
  },
  {
    name: 'keyflip_budget_set',
    title: 'Set a usage-budget ceiling',
    description:
      'Set/merge a usage-budget ceiling for an account: five_hour_pct and/or seven_day_pct (0-100). Use account "*" for the default covering every account. Pass null for a window to remove just that ceiling; omit to leave unchanged. Mutating — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string' },
        five_hour_pct: { type: ['number', 'null'] },
        seven_day_pct: { type: ['number', 'null'] },
        confirm: confirmProp.confirm,
      },
      required: ['account', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const budget = _budget;
      const raw = String(args.account);
      const name = raw === '*' || raw === 'default' || raw === 'defaults' ? '*' : core.resolveProfile(ctx, raw) || raw;
      const limits = {};
      if (args.five_hour_pct !== undefined) limits.fiveHourPct = args.five_hour_pct;
      if (args.seven_day_pct !== undefined) limits.sevenDayPct = args.seven_day_pct;
      const l = await lock.acquire(ctx.configDir);
      try {
        return { set: { account: name, limits: budget.setLimit(ctx, name, limits) } };
      } finally {
        l.release();
      }
    },
  },
  {
    name: 'keyflip_budget_clear',
    title: "Clear an account's usage budget",
    description:
      'Remove ALL usage-budget ceilings for an account (or the "*" defaults). Mutating — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: { account: { type: 'string' }, confirm: confirmProp.confirm },
      required: ['account', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const budget = _budget;
      const raw = String(args.account);
      const name = raw === '*' || raw === 'default' || raw === 'defaults' ? '*' : core.resolveProfile(ctx, raw) || raw;
      const l = await lock.acquire(ctx.configDir);
      try {
        return { cleared: budget.clear(ctx, name) ? name : null };
      } finally {
        l.release();
      }
    },
  },
  {
    name: 'keyflip_import_env',
    title: 'Import providers from a .env / environment',
    description:
      'Detect Anthropic/OpenAI credentials in a .env file (pass `path`) or the current process environment (omit `path`) and save each as a keyflip provider endpoint. Returns what was imported with every key REDACTED — keys are never echoed back. Mutating — ask the user first, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to a .env file. Omit to import from the current environment.' },
        confirm: confirmProp.confirm,
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const importcreds = _importcreds;
      const res = args.path ? importcreds.fromFile(ctx, String(args.path)) : importcreds.fromEnv(ctx, process.env);
      const l = await lock.acquire(ctx.configDir);
      try {
        return importcreds.apply(ctx, res.candidates);
      } finally {
        l.release();
      }
    },
  },
  {
    name: 'keyflip_shell_init',
    title: 'Shell auto-activation hook',
    description:
      'Return the shell snippet (bash/zsh/fish) for direnv-style account auto-activation: once added to the shell rc file, cd-ing into a directory pinned with `keyflip link` auto-switches the CLI to that account. Install: `eval "$(keyflip shell-init zsh)"` (fish: `keyflip shell-init fish | source`). Read-only — returns text only.',
    inputSchema: {
      type: 'object',
      properties: { shell: { type: 'string', enum: ['bash', 'zsh', 'fish'] } },
      required: ['shell'],
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      const shellhook = _shellhook;
      return { shell: String(args.shell), snippet: shellhook.hook(String(args.shell)) };
    },
  },
  {
    name: 'keyflip_audit_log',
    title: 'Action / audit log',
    description:
      "Recent entries from keyflip's action log (account switches, adds, cleans, errors) at <configDir>/logs/keyflip.log. Filters: grep (case-insensitive substring on the message) and since (ISO; entries at/after it). Newest last. Read-only.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max entries (newest). Default 50.' },
        grep: { type: 'string' },
        since: { type: 'string', description: 'ISO timestamp.' },
      },
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      args = args || {};
      return { entries: auditview.tail(ctx, { limit: args.limit, grep: args.grep, since: args.since }) };
    },
  },
  {
    name: 'keyflip_notify_status',
    title: 'Notification settings',
    description:
      "Show keyflip's outbound notification config: webhook URL (if any), enabled events (quota/switch/fleet-reply/…), and whether macOS desktop banners are on. Read-only.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) {
      const c = _notify.getConfig(ctx);
      return { webhook: c.webhook, events: c.events, desktop: c.desktop };
    },
  },
  {
    name: 'keyflip_notify_set',
    title: 'Configure notifications',
    description:
      'Set the notification webhook (http(s) only), the enabled event list, and/or the macOS desktop-banner toggle. keyflip POSTs a NON-SECRET summary { event, payload, at } on each enabled event. Pass webhook:null to clear it. Mutating — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        webhook: { type: ['string', 'null'] },
        events: { type: 'array', items: { type: 'string' } },
        desktop: { type: 'boolean' },
        confirm: confirmProp.confirm,
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const patch = {};
      if ('webhook' in args) patch.webhook = args.webhook == null ? null : String(args.webhook);
      if (Array.isArray(args.events)) patch.events = args.events;
      if (typeof args.desktop === 'boolean') patch.desktop = args.desktop;
      const l = await lock.acquire(ctx.configDir);
      try {
        return { notify: _notify.setConfig(ctx, patch) };
      } finally {
        l.release();
      }
    },
  },
  {
    name: 'keyflip_notify_test',
    title: 'Send a test notification',
    description:
      'Fire a synthetic "test" event through the configured sinks (webhook POST and/or macOS banner) so the user can verify wiring. Outbound side effect — ask the user first, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: { confirm: confirmProp.confirm },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      return await _notify.test(ctx);
    },
  },
  // ---- Wave-2 (strategic): cost / team pool / router+cache (orchestrator/policy/integrations/vault appended after the array) ----
  {
    name: 'keyflip_cost_status',
    title: 'Aggregate account spend / utilization',
    description:
      "Aggregate cost/utilization across all saved accounts from keyflip's usage cache. Reports 5h/7d rate-limit utilization for every account; reports per-token spend (costUSD) ONLY when the cache carries token totals — the OAuth usage API is percentage-based, so a dollar figure is never inferred from a percentage. Read-only.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) {
      return _cost.unified(ctx);
    },
  },
  {
    name: 'keyflip_cost_predict',
    title: 'Project time-to-limit for an account',
    description:
      'From the recorded usage trend, project time-to-limit for the 5h and 7d rate windows of one account: current pct, rate-per-hour, and ETA minutes (null when unknown — never fabricated). Read-only.',
    inputSchema: {
      type: 'object',
      properties: { account: { type: 'string' } },
      required: ['account'],
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      const name = core.resolveProfile(ctx, String(args.account));
      if (!name) throw new Error("no such account: '" + args.account + "'");
      return _cost.predict(ctx, name);
    },
  },
  {
    name: 'keyflip_cost_by_project',
    title: 'Per-project token + cost attribution',
    description:
      'Scan local ~/.claude/projects transcripts and attribute token usage + estimated cost per working directory / repo. Token counts are MEASURED; costUSD is an ESTIMATE from a dated static pricing snapshot. Work is capped. Read-only.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } }, additionalProperties: false },
    annotations: RO,
    run: async function (ctx, args) {
      return _cost.attribute(ctx, { maxSessions: args && args.limit });
    },
  },
  {
    name: 'keyflip_team_members',
    title: 'List team-pool members and account visibility',
    description:
      'Read a shared, encrypted TEAM credential pool: its MEMBERS (id + role) and a CREDS-FREE summary of which accounts it holds + the minimum role each requires. Read-only. Requires the pool passphrase_file.',
    inputSchema: {
      type: 'object',
      properties: { dir: { type: 'string' }, pool: { type: 'string' }, passphrase_file: { type: 'string' } },
      required: ['dir', 'pool', 'passphrase_file'],
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      const teampool = _teampool;
      const view = teampool.read(ctx, {
        dir: String(args.dir),
        pool: String(args.pool),
        passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim(),
      });
      if (!view) throw new Error("no such pool '" + args.pool + "'");
      return { pool: view.pool, members: view.members, accounts: view.accounts, at: view.at };
    },
  },
  {
    name: 'keyflip_team_publish',
    title: 'Publish accounts to a shared team pool',
    description:
      'Build an ENCRYPTED team credential pool from THIS machine\'s saved accounts into a shared folder, tagging each account with the minimum role allowed to pull it. `accounts` optionally selects names + per-account roles; omit to publish every local account as "member". Mutating (writes encrypted login secrets to a shared folder) — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string' },
        pool: { type: 'string' },
        passphrase_file: { type: 'string' },
        accounts: { type: 'object', additionalProperties: { type: 'string', enum: ['owner', 'member'] } },
        owner: { type: 'string' },
        confirm: confirmProp.confirm,
      },
      required: ['dir', 'pool', 'passphrase_file', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const teampool = _teampool;
      return {
        published: teampool.publish(ctx, {
          dir: String(args.dir),
          pool: String(args.pool),
          passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim(),
          accounts: args.accounts || undefined,
          owner: args.owner ? String(args.owner) : undefined,
        }),
      };
    },
  },
  {
    name: 'keyflip_team_pull',
    title: 'Pull role-visible accounts from a team pool',
    description:
      'Import from a shared encrypted team pool ONLY the accounts your role (as: owner|member, default member) may see. Existing accounts skipped unless force=true. Mutating — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string' },
        pool: { type: 'string' },
        passphrase_file: { type: 'string' },
        as: { type: 'string', enum: ['owner', 'member'] },
        force: { type: 'boolean' },
        confirm: confirmProp.confirm,
      },
      required: ['dir', 'pool', 'passphrase_file', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const teampool = _teampool;
      return {
        pulled: teampool.pull(ctx, {
          dir: String(args.dir),
          pool: String(args.pool),
          passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim(),
          asRole: args.as ? String(args.as) : 'member',
          force: !!args.force,
        }),
      };
    },
  },
  {
    name: 'keyflip_team_member_add',
    title: 'Add or update a team-pool member',
    description:
      'Add a member (or change role: owner|member) in a shared encrypted team pool. Mutating (rewrites the encrypted pool) — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string' },
        pool: { type: 'string' },
        passphrase_file: { type: 'string' },
        id: { type: 'string' },
        role: { type: 'string', enum: ['owner', 'member'] },
        confirm: confirmProp.confirm,
      },
      required: ['dir', 'pool', 'passphrase_file', 'id', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const teampool = _teampool;
      return {
        members: teampool.addMember(ctx, {
          dir: String(args.dir),
          pool: String(args.pool),
          passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim(),
          id: String(args.id),
          role: args.role ? String(args.role) : 'member',
        }),
      };
    },
  },
  {
    name: 'keyflip_team_member_remove',
    title: 'Remove a team-pool member',
    description:
      'Remove a member from a shared encrypted team pool (last owner cannot be removed). Mutating — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string' },
        pool: { type: 'string' },
        passphrase_file: { type: 'string' },
        id: { type: 'string' },
        confirm: confirmProp.confirm,
      },
      required: ['dir', 'pool', 'passphrase_file', 'id', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const teampool = _teampool;
      return {
        members: teampool.removeMember(ctx, {
          dir: String(args.dir),
          pool: String(args.pool),
          passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim(),
          id: String(args.id),
        }),
      };
    },
  },
  {
    name: 'keyflip_route_list',
    title: 'List model routes',
    description: 'Model→provider routing pins and whether arbitrage (always-cheapest) mode is on. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) {
      return _router.get(ctx);
    },
  },
  {
    name: 'keyflip_cache_status',
    title: 'Response cache status',
    description: 'Response-cache stats: entry count, cap, total bytes and oldest/newest timestamps. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) {
      return _router.cacheStatus(ctx);
    },
  },
  {
    name: 'keyflip_route_set',
    title: 'Pin a model to a provider',
    description:
      'Pin a model onto a configured provider (overrides cheapest-provider selection unless arbitrage is on). Ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: { model: { type: 'string' }, provider: { type: 'string' }, confirm: confirmProp.confirm },
      required: ['model', 'provider', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      return _router.setRoute(ctx, String(args.model), String(args.provider));
    },
  },
  {
    name: 'keyflip_route_clear',
    title: 'Clear a model route',
    description: 'Remove the routing pin for a model (falls back to cheapest). Ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: { model: { type: 'string' }, confirm: confirmProp.confirm },
      required: ['model', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      return { cleared: _router.clearRoute(ctx, String(args.model)) };
    },
  },
  {
    name: 'keyflip_route_arbitrage',
    title: 'Toggle always-cheapest routing',
    description:
      'Turn model-cost ARBITRAGE on/off — when on, routing always picks the cheapest configured provider that serves a model (overriding pins). Ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: { on: { type: 'boolean' }, confirm: confirmProp.confirm },
      required: ['on', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      return { arbitrage: _router.setArbitrage(ctx, !!args.on) };
    },
  },
  {
    name: 'keyflip_cache_purge',
    title: 'Purge the response cache',
    description:
      'Delete cached responses — all, or only those older than older_than_ms. Ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: { older_than_ms: { type: 'number' }, confirm: confirmProp.confirm },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      return _router.cachePurge(ctx, {
        olderThanMs: typeof args.older_than_ms === 'number' ? args.older_than_ms : undefined,
      });
    },
  },
  // ---- Wave-3: swarm (own-fleet exec) + config (settings) ----
  {
    name: 'keyflip_swarm_run',
    title: 'Run one command across YOUR OWN enrolled fleet machines',
    description:
      'Queue an exec command onto YOUR OWN fleet machines (the ones you enrolled in your encrypted rendezvous — NOT a tool for reaching third-party targets). The command travels as an ARGV ARRAY (command + args[]) spawned with NO shell (no injection surface). With no `to`, it fans out to every checked-in machine. Nothing runs until each target drains WITH CONSENT (`keyflip swarm drain --allow-exec`, off by default). Collect with keyflip_swarm_results. Mutating (writes signed commands to the shared rendezvous) — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        to: { type: 'string' },
        passphrase_file: { type: 'string' },
        confirm: confirmProp.confirm,
      },
      required: ['command', 'passphrase_file', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const fleet = _fleet;
      const swarm = _swarm;
      const b = fleet.bus(ctx, { passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim() });
      fleet.publish(ctx, b, {});
      const q = swarm.queueExec(ctx, b, {
        command: String(args.command),
        args: Array.isArray(args.args) ? args.args : [],
        to: args.to,
      });
      return { queued: { group: q.group, command: q.command, args: q.args, targets: q.commands } };
    },
  },
  {
    name: 'keyflip_swarm_ping',
    title: 'Queue a reachability check from YOUR fleet to a URL you control',
    description:
      'Queue a reachability check: each targeted fleet machine curls an http(s) URL YOU control and reports the HTTP status (the URL is a distinct argv token, no shell). Same consent gate as swarm_run — runs only on `keyflip swarm drain --allow-exec`. Mutating — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        to: { type: 'string' },
        timeout: { type: 'number' },
        passphrase_file: { type: 'string' },
        confirm: confirmProp.confirm,
      },
      required: ['url', 'passphrase_file', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const fleet = _fleet;
      const swarm = _swarm;
      const b = fleet.bus(ctx, { passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim() });
      fleet.publish(ctx, b, {});
      const q = swarm.ping(ctx, b, String(args.url), { to: args.to, timeout: args.timeout });
      return { queued: { group: q.group, ping: String(args.url), targets: q.commands } };
    },
  },
  {
    name: 'keyflip_swarm_results',
    title: 'Collect results published by your fleet for a swarm run',
    description:
      "Aggregate the results your fleet machines published for a swarm run/ping, addressed to THIS machine. Each result's signed origin is verified against the sender's TOFU-pinned key. Output is size-capped + control-char scrubbed. Defaults to the most recent group. Read-only.",
    inputSchema: {
      type: 'object',
      properties: { group: { type: 'string' }, passphrase_file: { type: 'string' } },
      required: ['passphrase_file'],
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      const fleet = _fleet;
      const swarm = _swarm;
      const b = fleet.bus(ctx, { passphrase: fs.readFileSync(String(args.passphrase_file), 'utf8').trim() });
      const reconcile = fleet.reconcileKeys(ctx, fleet.readFleet(ctx, b));
      const group = args.group || swarm.readState(ctx).lastGroup;
      return { group: group || null, results: swarm.aggregate(ctx, b, { group: group, reconcile: reconcile }) };
    },
  },
  {
    name: 'keyflip_config_list',
    title: 'List keyflip settings',
    description:
      'All keyflip settings with their effective value (stored override or built-in default) plus the schema (type/default/bounds/help). Read-only. No secrets.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) {
      const config = _config;
      return { config: Object.assign({}, config.getAll(ctx)), schema: Object.assign({}, config.describe()) };
    },
  },
  {
    name: 'keyflip_config_get',
    title: 'Read one keyflip setting',
    description:
      'Read a single setting by key (e.g. "autoswitch.threshold"); returns its effective value. Unknown keys error. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      const config = _config;
      return { key: String(args.key), value: config.get(ctx, String(args.key)) };
    },
  },
  {
    name: 'keyflip_codexbar',
    title: 'CodexBar bridge (provider alignment)',
    description:
      "Detect a locally-installed CodexBar (the menu-bar AI-usage monitor) and align its tracked providers with what keyflip can read. Complementary: CodexBar monitors usage, keyflip manages accounts. Reads only CodexBar's non-secret provider list — never its stored tokens. Read-only.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) {
      const cb = _codexbar;
      return { detected: cb.detect(ctx), align: cb.align(ctx) };
    },
  },
  {
    name: 'keyflip_provider_usage',
    title: 'Usage/limits across other AI providers',
    description:
      'Read usage + limit windows across the OTHER AI coding tools on this machine (Codex, Gemini, Cursor, Copilot, opencode, OpenRouter, …) plus Claude — a CodexBar-style multi-provider monitor. Each provider is normalized to { status, windows:[{name,usedPct,resetsAt,human}] }. Reads only usage numbers/reset times (any API key is referenced by env NAME only, never its value). Absent providers are skipped. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) {
      return { providers: await _provusage.readAll(ctx, { fetch: typeof fetch !== 'undefined' ? fetch : undefined }) };
    },
  },
  {
    name: 'keyflip_brain_propose',
    title: 'Propose a plan of keyflip steps (opt-in)',
    description:
      'Turn a plain-language intent into a PROPOSED plan of keyflip commands (via Gemini). PROPOSE-ONLY — it never executes anything; it returns validated steps (each tagged safe/mutating) for the human to approve and run. OFF unless KEYFLIP_BRAIN=1 and GEMINI_API_KEY are set (returns enabled:false otherwise). All outbound context is secret-scrubbed; the API key is never returned. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { intent: { type: 'string' } },
      required: ['intent'],
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      return _brain.propose(ctx, String(args.intent == null ? '' : args.intent), {});
    },
  },
  {
    name: 'keyflip_config_set',
    title: 'Change a keyflip setting',
    description:
      'Set a setting to a new value (validated + coerced against the schema; unknown key / wrong type / out-of-range are rejected). Changes future keyflip behavior. Ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' }, value: { type: 'string' }, confirm: confirmProp.confirm },
      required: ['key', 'value', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const config = _config;
      const value = config.set(ctx, String(args.key), args.value);
      logmod.log('mcp config set ' + String(args.key));
      return { set: { key: String(args.key), value: value } };
    },
  },
  {
    name: 'keyflip_config_unset',
    title: 'Reset a keyflip setting to default',
    description:
      'Remove a stored override so the setting reverts to its built-in default. Ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' }, confirm: confirmProp.confirm },
      required: ['key', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const config = _config;
      const had = config.unset(ctx, String(args.key));
      logmod.log('mcp config unset ' + String(args.key));
      return { unset: String(args.key), wasSet: had, value: config.get(ctx, String(args.key)) };
    },
  },
  {
    name: 'keyflip_llm',
    title: 'Which model runs the background chores, and what it costs',
    description:
      "Resolve keyflip's headless-LLM provider — the thing that summarizes chats for `dream`/`distill`/`recall --answer` — as { provider, model, base_url, key_env (NAME only), usable, cost }. Default is claude -p, which spends the ACTIVE account's quota; ollama is local and free, openai-compatible uses an endpoint key read from an env var at call time (keyflip stores the name, never the key). Set it with keyflip_config_set on llm.provider / llm.model / llm.base_url / llm.key_env. Read-only; probe=true additionally sends one tiny 'say OK' completion to test the endpoint, which costs one request and touches the network.",
    inputSchema: {
      type: 'object',
      properties: {
        probe: { type: 'boolean', description: 'true = make one small completion call to prove the endpoint answers.' },
        provider: {
          type: 'string',
          description:
            'test THIS provider without changing shared state (claude | ollama | openai) — the same one-off override KEYFLIP_LLM_PROVIDER gives a terminal.',
        },
        model: { type: 'string', description: 'with provider: the model name to probe (e.g. a local ollama tag).' },
        base_url: { type: 'string', description: 'with provider=openai: the endpoint to probe.' },
        key_env: {
          type: 'string',
          description: 'with provider=openai: NAME of the env var holding the key — never the key.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    run: async function (ctx, args) {
      const want = {
        provider: args && args.provider,
        model: args && args.model,
        base_url: args && args.base_url,
        key_env: args && args.key_env,
      };
      const p = llm.resolve(ctx, want);
      const gate = llm.availability(ctx, want);
      const out = {
        provider: p.provider,
        model: p.model || null,
        base_url: p.baseUrl || null,
        key_env: p.keyEnv || null, // the NAME; the value is never read into a result
        cost: p.cost,
        usable: gate.ok && (p.provider !== 'claude' || llm.available(ctx)),
        reason: gate.ok ? null : gate.reason,
        fix: gate.ok ? null : gate.fix,
        // What an agent should say to the user before running a chore: this is a quota decision.
        configured_for: args && args.provider ? 'one-off probe only — shared config unchanged' : 'keyflip llm (config)',
      };
      if (args && args.probe) {
        if (!gate.ok) {
          out.probe = { ok: false, reason: gate.reason, fix: gate.fix };
          return out;
        }
        // A cold local model spends minutes loading weights, so a probe waits like a real call.
        const r = await llm.complete(ctx, 'Reply with exactly: OK', 'ping', {
          skipCheck: true,
          timeoutMs: 180000,
          provider: want.provider,
          model: want.model,
          base_url: want.base_url,
          key_env: want.key_env,
        });
        out.probe = {
          ok: !!r.ok,
          reason: r.ok ? null : r.reason,
          detail: r.ok ? null : r.detail || null,
          provider: r.provider,
          model: r.model || null,
          bytes: r.ok ? String(r.text || '').length : 0,
        };
      }
      return out;
    },
  },
  {
    name: 'keyflip_agents',
    title: "List other agents' memory + config keyflip can carry",
    description:
      'Report which OTHER AI agents have files on THIS machine that keyflip can carry across machines: MEMORY (Cursor `~/.cursor/rules/`, Gemini `~/.gemini/GEMINI.md`, Codex `~/.codex/AGENTS.md`+`memories/` — markdown, no secrets) and CONFIG (`~/.cursor/mcp.json`, `~/.gemini/settings.json`, `~/.codex/config.toml` — carried ONLY secret-scanned + redacted). Read-only; feed into keyflip_migrate_export with agents=true and/or agent_config=true.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) {
      const agents = _agents;
      const present = agents.presentAgents(ctx);
      const cfgPresent = agents.presentAgentConfig(ctx);
      const rows = agents.REGISTRY.map(function (a) {
        const files = present.indexOf(a.id) !== -1 ? agents.collectAgentMemory(ctx, { only: [a.id] }) : [];
        const cfg = cfgPresent.indexOf(a.id) !== -1 ? agents.collectAgentConfig(ctx, { only: [a.id] }) : [];
        const redactions = cfg.reduce(function (n, c) {
          return n + (c.redactions || 0);
        }, 0);
        return {
          id: a.id,
          label: a.label,
          roots: a.roots,
          present: present.indexOf(a.id) !== -1,
          files: files.length,
          config: cfg.length,
          redactions: redactions,
        };
      });
      return { agents: rows, present: present, configPresent: cfgPresent };
    },
  },

  // ---- session lifecycle: rebind, archive ----
  {
    name: 'keyflip_sessions_rebind',
    title: 'Re-link chat history after a folder rename',
    description:
      "Re-link a project's Claude Code chat history after its folder was renamed/moved: copies transcripts to the new folder key, rewrites the old cwd inside them, patches the desktop-app session records (macOS), and rewrites the old path across config surfaces that transcripts don't cover — ~/.claude.json (projects map, githubRepoPaths, stdio MCP server paths), settings*.json permission rules, commands/* slash-command scripts, and the desktop app config. Old copies are backed up (.keyflip-bak). Pass extra_files to also rewrite app-specific configs (e.g. a tool's own config). Mutating — ask the user, then confirm=true.",
    inputSchema: {
      type: 'object',
      properties: {
        old_path: { type: 'string' },
        new_path: { type: 'string' },
        purge_old: { type: 'boolean' },
        force: { type: 'boolean' },
        skip_configs: {
          type: 'boolean',
          description: 'Only rebind transcripts + app registry; leave config files untouched.',
        },
        extra_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional config files to rewrite oldPath->newPath in (absolute paths).',
        },
        confirm: confirmProp.confirm,
      },
      required: ['old_path', 'new_path', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const path = _path;
      const oldAbs = path.resolve(String(args.old_path)),
        newAbs = path.resolve(String(args.new_path));
      const r = sessions.rebind(ctx, oldAbs, newAbs, { purgeOld: !!args.purge_old, force: !!args.force });
      if (!r.ok) throw new Error('rebind did not run: ' + (r.reason || 'unknown'));
      let patched = 0;
      if (ctx.appDataDir && !appctl.isClaudeRunning(ctx.platform)) {
        try {
          patched = sessions.rebindAppRegistry(ctx, oldAbs, newAbs).patched;
        } catch (e) {
          /* best-effort */
        }
      }
      let configs = { patched: 0, files: [] };
      if (!args.skip_configs) {
        try {
          configs = sessions.rebindConfigPaths(ctx, oldAbs, newAbs, {
            extraFiles: Array.isArray(args.extra_files) ? args.extra_files : [],
          });
        } catch (e) {
          /* best-effort */
        }
      }
      return {
        moved: r.moved,
        skipped: r.skipped,
        appRecordsPatched: patched,
        configFilesPatched: configs.patched,
        configFiles: configs.files.map(function (x) {
          return x.path;
        }),
        newDir: r.newDir,
      };
    },
  },
  {
    name: 'keyflip_sessions_archive',
    title: 'Archive (gzip) old transcripts',
    description:
      "Move Claude Code transcripts out of ~/.claude/projects into keyflip's gzipped archive store (declutters; reversible via keyflip_sessions_unarchive). Give session_id for one, or older_than_days for a bulk sweep. Mutating — ask the user, then confirm=true.",
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        older_than_days: { type: 'integer' },
        confirm: confirmProp.confirm,
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      let targets = [];
      if (args.older_than_days) {
        const ms = Date.now() - args.older_than_days * 86400000;
        targets = sessions
          .list(ctx, { limit: 100000 })
          .filter(function (r) {
            return r.mtimeMs < ms;
          })
          .map(function (r) {
            return { project: r.project, sessionId: r.sessionId };
          });
      } else if (args.session_id) {
        const row = sessions.find(ctx, String(args.session_id));
        if (!row) throw new Error("no live session matches '" + args.session_id + "'");
        targets = [{ project: row.project, sessionId: row.sessionId }];
      } else {
        throw new Error('give session_id or older_than_days');
      }
      const l = await lock.acquire(ctx.configDir);
      let done = 0,
        bytes = 0,
        gz = 0;
      try {
        targets.forEach(function (t) {
          const r = archive.archiveSession(ctx, t.project, t.sessionId);
          if (r.ok) {
            done++;
            bytes += r.bytes;
            gz += r.gzBytes;
          }
        });
      } finally {
        l.release();
      }
      return { archived: done, bytes: bytes, gzBytes: gz };
    },
  },
  {
    name: 'keyflip_session_delete',
    title: 'Delete a conversation',
    description:
      'Delete a Claude Code transcript. DEFAULT is archive-then-remove (recoverable via keyflip_sessions_unarchive); hard=true PERMANENTLY unlinks it (NOT recoverable). Ask the user first, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        hard: { type: 'boolean', description: 'true = permanent unlink (irreversible); default archives first.' },
        confirm: confirmProp.confirm,
      },
      required: ['session_id', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const row = sessions.find(ctx, String(args.session_id));
      if (!row) throw new Error("no live session matches '" + args.session_id + "'");
      const l = await lock.acquire(ctx.configDir);
      try {
        const r = _sessionedit.deleteSession(ctx, {
          project: row.project,
          sessionId: row.sessionId,
          hard: !!args.hard,
        });
        if (!r.ok) throw new Error('delete failed: ' + (r.reason || 'unknown'));
        return { deleted: r };
      } finally {
        l.release();
      }
    },
  },
  {
    name: 'keyflip_session_scrub',
    title: 'Redact PII from a conversation',
    description:
      "Redact PII (email, phone incl. TR, TCKN, credit card [Luhn], IBAN, IP, secrets, custom patterns) from a transcript's human-visible text — including assistant THINKING blocks. confirm=false PREVIEWS (dry-run counts, writes nothing); confirm=true APPLIES the redaction after backing the file up. Ask the user before applying.",
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        categories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Subset of PII categories (default: all but address).',
        },
        llm_url: { type: 'string', description: 'Optional local PII-LLM endpoint (opt-in).' },
        confirm: confirmProp.confirm,
      },
      required: ['session_id', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      const row = sessions.find(ctx, String(args.session_id));
      if (!row) throw new Error("no live session matches '" + args.session_id + "'");
      const pii = _pii;
      const opts = {
        project: row.project,
        sessionId: row.sessionId,
        apply: args.confirm === true,
        categories: Array.isArray(args.categories) ? args.categories : undefined,
        custom: pii.loadCustom(ctx),
      };
      if (args.llm_url) opts.llm = { url: String(args.llm_url) };
      const doIt = function () {
        return _sessionedit.scrubSession(ctx, opts);
      };
      let r;
      if (args.confirm === true) {
        const l = await lock.acquire(ctx.configDir);
        try {
          r = doIt();
        } finally {
          l.release();
        }
      } else {
        r = doIt();
      }
      if (!r.ok) throw new Error('scrub failed: ' + (r.reason || 'unknown'));
      return {
        applied: r.applied,
        redactions: r.redactions,
        messagesScanned: r.messagesScanned,
        backup: r.backup || null,
        preview: r.applied ? undefined : 'dry-run — call with confirm=true to apply',
      };
    },
  },
  {
    name: 'keyflip_session_edit',
    title: 'Surgically edit a conversation',
    description:
      'Edit a transcript at the JSONL level, keeping it valid: op="delete-message" drops event N, "redact-message" replaces event N\'s visible text, "truncate-after" drops everything after event N. confirm=false PREVIEWS; confirm=true APPLIES after backing up. Ask the user before applying.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        op: { type: 'string', enum: ['delete-message', 'redact-message', 'truncate-after'] },
        index: { type: 'integer' },
        replacement: { type: 'string' },
        confirm: confirmProp.confirm,
      },
      required: ['session_id', 'op', 'index', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      const row = sessions.find(ctx, String(args.session_id));
      if (!row) throw new Error("no live session matches '" + args.session_id + "'");
      const op = { type: String(args.op), index: args.index | 0, apply: args.confirm === true };
      if (args.replacement != null) op.replacement = String(args.replacement);
      const doIt = function () {
        return _sessionedit.editSession(ctx, { project: row.project, sessionId: row.sessionId, op: op });
      };
      let r;
      if (args.confirm === true) {
        const l = await lock.acquire(ctx.configDir);
        try {
          r = doIt();
        } finally {
          l.release();
        }
      } else {
        r = doIt();
      }
      if (!r.ok) throw new Error('edit failed: ' + (r.reason || 'unknown'));
      return r;
    },
  },
  {
    name: 'keyflip_pii_scrub_text',
    title: 'Redact PII from a string',
    description:
      'Redact PII from an arbitrary text string (not a file) and return the cleaned text + per-category counts. Categories: email, phone (incl. TR), tckn, passport, creditCard (Luhn), iban, ipv4/ipv6, secret; address is opt-in. Read-only — transforms the given text, touches nothing on disk.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, categories: { type: 'array', items: { type: 'string' } } },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      const pii = _pii;
      const opts = { custom: pii.loadCustom(ctx) };
      if (Array.isArray(args.categories)) opts.categories = args.categories;
      return pii.scrub(String(args.text == null ? '' : args.text), opts);
    },
  },
  {
    name: 'keyflip_sessions_unarchive',
    title: 'Restore an archived transcript',
    description:
      'Restore a gzipped archived transcript back into ~/.claude/projects (byte-exact). Mutating — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' }, confirm: confirmProp.confirm },
      required: ['session_id', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const row = archive.findArchived(ctx, String(args.session_id));
      if (!row) throw new Error("no archived session matches '" + args.session_id + "'");
      const l = await lock.acquire(ctx.configDir);
      let r;
      try {
        r = archive.unarchiveSession(ctx, row.project, row.sessionId);
      } finally {
        l.release();
      }
      if (!r.ok) throw new Error('unarchive failed: ' + (r.reason || 'unknown'));
      return { unarchived: row.sessionId, dest: r.dest };
    },
  },
  {
    name: 'keyflip_send',
    title: 'Inject a message into a session',
    description:
      'Continue a past session by sending it a message headlessly (`claude -p "<message>" --resume <id>`) and return the reply — this is how you steer/continue a chat (e.g. from another machine). Optionally as another account (account=) and/or fork=true (branch instead of appending). SPENDS the selected account\'s quota + appends a turn — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        message: { type: 'string' },
        account: { type: 'string' },
        fork: { type: 'boolean' },
        confirm: confirmProp.confirm,
      },
      required: ['session_id', 'message', 'confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async function (ctx, args) {
      needConfirm(args);
      const row = sessions.find(ctx, String(args.session_id));
      if (!row) throw new Error("no session matches '" + args.session_id + "'");
      if (!llm.available()) throw new Error('send needs Claude Code on PATH (`claude -p --resume`)');
      const cwd = row.cwd && fs.existsSync(row.cwd) ? row.cwd : process.cwd();
      const sc = sessions.sendCommand(row, String(args.message), { fork: !!args.fork });
      let env = process.env,
        resolved = null;
      if (args.account) {
        resolved = core.resolveProfile(ctx, String(args.account));
        if (!resolved) throw new Error("no such account: '" + args.account + "'");
        const session = _session;
        const l = await lock.acquire(ctx.configDir);
        let dir;
        try {
          dir = session.prepareSession(ctx, resolved, { share: true, shareHistory: true });
        } finally {
          l.release();
        }
        env = session.sessionEnv(ctx, dir).env;
      }
      const r = _child_process.spawnSync(process.env.KEYFLIP_CLAUDE_BIN || 'claude', sc.args, {
        cwd: cwd,
        env: env,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
      if (resolved) {
        const l2 = await lock.acquire(ctx.configDir);
        try {
          _session.syncBack(ctx, resolved);
        } catch (e) {
          /* best-effort */
        } finally {
          l2.release();
        }
      }
      if (r.status !== 0)
        throw new Error('claude exited ' + r.status + (r.stderr ? ': ' + String(r.stderr).trim().slice(0, 200) : ''));
      return { session: row.sessionId, as: resolved || null, reply: String(r.stdout || '').trim() };
    },
  },
  {
    name: 'keyflip_sessions_assign',
    title: 'Assign a session to a different account',
    description:
      "Assign a session to a specific account so `keyflip resume <id> --run` continues it AS that account (isolated) WITHOUT switching the machine's active profile (transcripts are account-independent). Pass account to assign, or omit account to UNassign. Mutating — ask the user, then confirm=true.",
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' }, account: { type: 'string' }, confirm: confirmProp.confirm },
      required: ['session_id', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const sessionmap = _sessionmap;
      const row = sessions.find(ctx, String(args.session_id));
      if (!row) throw new Error("no session matches '" + args.session_id + "'");
      const l = await lock.acquire(ctx.configDir);
      try {
        if (!args.account) {
          sessionmap.unset(ctx, row.sessionId);
          _attrib.removeSource(ctx, row.sessionId); // no assignment → no provenance either
          return { unassigned: row.sessionId };
        }
        const name = core.resolveProfile(ctx, String(args.account));
        if (!name) throw new Error("no such account: '" + args.account + "'");
        sessionmap.set(ctx, row.sessionId, name);
        // Same rule as the CLI: the user's word replaces any earlier guess, so threads can tell
        // them apart instead of presenting a guess as a fact.
        _attrib.recordStated(ctx, row.sessionId, { account: name });
        return { assigned: { session: row.sessionId, account: name } };
      } finally {
        l.release();
      }
    },
  },
  {
    name: 'keyflip_sessions_attribute',
    title: 'Infer which account each unassigned session belongs to',
    description:
      "Threads only see fragmentation once sessions are attributed to accounts, and assigning them by hand is tedious. This reconstructs keyflip's OWN switch timeline from its action log (secret-free: account names + timestamps) and proposes the account each unassigned session was worked on, with the evidence for it. Confidence: `high` = its whole logged span sits inside one account's window; `medium` = the span is thin (no start timestamp, or it opens before the logged history) but visible time is all one account; `low` = it spans a switch, so the account holding the most logged time wins and it is flagged. Sessions the user already assigned are counted, never proposed over, and nothing is written unless apply:true (then confirm:true too). An account that is no longer a saved profile is never proposed — resume would point at credentials that do not exist. Use `threads suggest` afterwards to find the fragments this exposes.",
    inputSchema: {
      type: 'object',
      properties: {
        apply: {
          type: 'boolean',
          description: 'Write the proposals into the session→account map (default false: print only).',
        },
        min_confidence: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Only propose at or above this confidence (default low = everything).',
        },
        limit: { type: 'integer', description: 'How many recent sessions to examine (default 200).' },
        confirm: {
          type: 'boolean',
          description:
            'Required by the tool contract; only CONSULTED when apply:true (must then be true, set after the user agreed). A dry run may pass false.',
        },
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      // The tool contract requires `confirm` on every mutating tool; it is only CONSULTED when it
      // would actually write, so a dry run (apply omitted) still puts nothing on disk.
      if (args.apply) needConfirm(args);
      const rank = { low: 0, medium: 1, high: 2 };
      const floor = args.min_confidence && rank[args.min_confidence] != null ? rank[args.min_confidence] : 0;
      const l = await lock.acquire(ctx.configDir);
      try {
        const r = _attrib.proposals(ctx, { limit: parseInt(args.limit, 10) || 200 });
        const usable = r.proposals.filter(function (p) {
          return rank[p.confidence] >= floor;
        });
        const written = args.apply ? _attrib.apply(ctx, usable) : [];
        return {
          dry_run: !args.apply,
          coverage: r.coverage,
          counts: Object.assign({}, r.counts, { filtered: r.proposals.length - usable.length }),
          proposals: usable,
          applied: written,
        };
      } finally {
        l.release();
      }
    },
  },

  // ---- #35 threads: one name for the sessions that are the same task, across accounts ----
  {
    name: 'keyflip_threads',
    title: 'Browse threads (one task across accounts)',
    description:
      "Read-only view of keyflip threads — named groups of POINTERS to the Claude Code sessions and cloud chats that are the same task, spread over several accounts as quotas ran out. A thread stores ids and labels only, never a conversation copy, so it is versioned and migratable. `slug` returns that thread expanded against this machine (which transcripts exist, where, which account, resume command) plus `missing` for pointers that resolve to nothing here; `timeline:true` merges the members' turns chronologically with per-member provenance, reading each transcript under `keyflip config threads.mergeMaxMiB` (transcripts reach tens of MB); cloud chat members contribute NO turns offline — they are server-side and only `keyflip chat get` can read them. `suggest:true` instead finds work that is ALREADY split over 2+ accounts and unthreaded. Never writes.",
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Thread slug (or a unique prefix / title match). Omit for the list.' },
        timeline: { type: 'boolean', description: "With slug: merge the members' turns into one chronological view." },
        limit: { type: 'integer', description: 'Max turns to return with timeline (default 200).' },
        id: { type: 'string', description: 'Which threads contain this session id / chat uuid (or a prefix).' },
        suggest: { type: 'boolean', description: 'Return the split-across-accounts candidates instead of the list.' },
      },
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      args = args || {};
      if (args.suggest)
        return {
          candidates: _threads.candidates(ctx, {}).map(function (r) {
            return {
              project: r.project,
              cwd: r.cwd,
              accounts: r.accounts,
              suggestedSlug: r.suggestedSlug,
              sessionCount: r.sessions,
              unthreaded: r.unthreaded,
              sessions: r.open.map(function (s) {
                return { sessionId: s.sessionId, account: s.account, mtime: s.mtime, preview: s.preview };
              }),
            };
          }),
        };
      if (args.id) {
        const hits = _threads.threadsFor(ctx, null, String(args.id));
        return {
          id: String(args.id),
          threads: hits.map(function (r) {
            return { slug: r.slug, title: r.title, updatedAt: r.updatedAt };
          }),
        };
      }
      if (!args.slug) {
        return {
          threads: _threads.summaries(ctx).map(function (r) {
            const o = Object.assign({}, r);
            o.file = statePathForAgent(ctx, o.file);
            return o;
          }),
          stats: _threads.stats(ctx),
        };
      }
      const t = _threads.read(ctx, String(args.slug));
      const idx = _threads.index(ctx);
      const assigned = _threads.assignments(ctx);
      const exp = _threads.expand(ctx, t, { index: idx, assigned: assigned });
      const out = {
        thread: Object.assign({}, t, { file: statePathForAgent(ctx, t.file) }),
        members: exp.rows.map(function (r) {
          const o = Object.assign({}, r);
          if (o.file) {
            o.transcript = transcriptForAgent(ctx, o.file);
            delete o.file;
          }
          return o;
        }),
        accounts: exp.accounts,
        missing: exp.missing,
      };
      if (args.timeline) {
        const maxTotal = parseInt(args.limit, 10);
        const tl = _threads.timeline(ctx, t, {
          index: idx,
          assigned: assigned,
          maxTotal: Number.isNaN(maxTotal) ? 200 : Math.max(0, maxTotal),
        });
        out.timeline = tl.messages.map(function (m) {
          const o = Object.assign({}, m);
          if (o.file) {
            o.transcript = transcriptForAgent(ctx, o.file);
            delete o.file;
          }
          return o;
        });
        out.unavailable = tl.unavailable;
        out.droppedFromStart = tl.droppedFromStart;
        out.cappedMembers = tl.cappedMembers;
      }
      return out;
    },
  },
  {
    name: 'keyflip_thread_create',
    title: 'Name a thread',
    description:
      'Create a thread: a single name for the sessions/chats that are the same task, so an account switch stops fragmenting the work. Writes <configDir>/threads/<slug>.json — pointers and labels only, no conversation content. Give `session_id` or `chat_id` to start it with that member. Mutating — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: 'Lowercase-kebab name. Optional — `title` is folded into a slug when it is omitted.',
        },
        title: { type: 'string', description: 'Human title (accent-folded Turkish/English both fine).' },
        notes: { type: 'string', description: 'Why this thread exists / what to continue. Max 4000 chars.' },
        session_id: { type: 'string', description: 'Optional first member: a Claude Code session id.' },
        chat_id: { type: 'string', description: 'Optional first member: a claude.ai chat uuid.' },
        account: { type: 'string', description: 'Account that member belongs to (names a saved keyflip account).' },
        confirm: confirmProp.confirm,
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const member = threadMemberFromArgs(ctx, args, true);
      const l = await lock.acquire(ctx.configDir);
      try {
        return {
          created: _threads.create(ctx, { slug: args.slug, title: args.title, notes: args.notes, member: member }),
        };
      } finally {
        l.release();
      }
    },
  },
  {
    name: 'keyflip_thread_add',
    title: 'Link a session or chat into a thread',
    description:
      'Add one pointer to an existing thread — a local Claude Code session by `session_id`, or a cloud claude.ai chat by `chat_id`. Idempotent: re-adding the same member refreshes its label/account instead of duplicating. A session may belong to several threads (a thread is a name, not a container). The conversation itself is never touched or copied. Mutating — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Target thread (slug, unique prefix, or title match).' },
        session_id: { type: 'string', description: 'Session id or unique prefix (local transcript).' },
        chat_id: { type: 'string', description: 'Cloud chat uuid — use this for a claude.ai conversation.' },
        account: {
          type: 'string',
          description:
            'Account to attribute. For a session this is only a fallback (the live `sessions assign` map wins); for a chat it decides which cookie snapshot reads it.',
        },
        label: { type: 'string', description: 'Short note on what this member covers.' },
        confirm: confirmProp.confirm,
      },
      required: ['slug', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const member = threadMemberFromArgs(ctx, args, false);
      const l = await lock.acquire(ctx.configDir);
      try {
        const t = _threads.read(ctx, String(args.slug));
        return { added: _threads.addMember(ctx, t.slug, member), thread: t.slug };
      } finally {
        l.release();
      }
    },
  },
  {
    name: 'keyflip_thread_remove',
    title: 'Unlink one member from a thread',
    description:
      'Remove ONE pointer from a thread (`id` may be "session:<id>", "chat:<id>", a full id, or a unique prefix). The conversation and its transcript are untouched — only the link goes away. Mutating — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        id: { type: 'string', description: 'Member id, optionally prefixed with "session:" / "chat:".' },
        confirm: confirmProp.confirm,
      },
      required: ['slug', 'id', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const l = await lock.acquire(ctx.configDir);
      try {
        const t = _threads.read(ctx, String(args.slug));
        const r = _threads.removeMember(ctx, t.slug, String(args.id));
        if (!r) throw new Error("no member of '" + t.slug + "' matches '" + args.id + "'");
        return { removed: r.removed, thread: t.slug, members: r.thread.members.length };
      } finally {
        l.release();
      }
    },
  },
  {
    name: 'keyflip_thread_drop',
    title: 'Forget a thread name',
    description:
      'Delete a thread FILE. This deletes a NAME, never a conversation: every session/chat it points at stays exactly where it is, and the removal is recoverable through keyflip history/undo. If the opt-in transcript mirror has a file for this slug it SURVIVES the drop (the mirror dir is separate) — `remove_mirror:true` deletes that text too. Mutating — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        remove_mirror: { type: 'boolean', description: 'Also delete the mirrored conversation text, if any.' },
        confirm: confirmProp.confirm,
      },
      required: ['slug', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const l = await lock.acquire(ctx.configDir);
      try {
        const t = _threads.read(ctx, String(args.slug));
        const mirrorPath = _threads.mirrorFileFor(ctx, t.slug);
        const hadMirror = fs.existsSync(mirrorPath);
        const r = _threads.drop(ctx, t.slug);
        const out = { dropped: t.slug, members: (r.members || []).length };
        if (args.remove_mirror && hadMirror)
          out.mirrorRemoved = statePathForAgent(ctx, _threads.unmirror(ctx, t).path || mirrorPath);
        else if (hadMirror)
          out.mirrorStillThere =
            statePathForAgent(ctx, mirrorPath) +
            ' — the conversation text outlives the name; call again with remove_mirror:true (or keyflip threads unmirror ' +
            t.slug +
            ')';
        return out;
      } finally {
        l.release();
      }
    },
  },
  {
    name: 'keyflip_thread_mirror',
    title: "Write a thread's merged text to disk",
    description:
      'The one place keyflip puts CONVERSATION TEXT into the state dir: renders the thread\'s merged markdown to <configDir>/thread-mirror/<slug>.md (0600). Two gates, both required — `keyflip config set threads.mirror true` AND this call — and it REFUSES when the state repo has a git remote configured, because "git-ignored" is only a promise about `git add -A`. The file is git-ignored and never backed up; `keyflip threads show <slug> --md` gives the same markdown without ever writing it, which is the better default. Mutating — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        confirm: confirmProp.confirm,
      },
      required: ['slug', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const l = await lock.acquire(ctx.configDir);
      try {
        const t = _threads.read(ctx, String(args.slug));
        // No `force`: an agent calling this must not walk past the "this state repo has a remote" gate
        // — that check exists precisely because nobody was watching when the file got written.
        const r = _threads.mirror(ctx, t, {});
        if (!r.ok) throw new Error((r.detail || r.reason || 'the mirror was refused') + (r.fix ? ' — ' + r.fix : ''));
        return Object.assign({}, r, { path: statePathForAgent(ctx, r.path) });
      } finally {
        l.release();
      }
    },
  },

  {
    name: 'keyflip_sessions_archived',
    title: 'List archived transcripts',
    description: 'List transcripts that have been archived (gzipped) into keyflip. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) {
      return {
        archived: archive.listArchived(ctx).map(function (r) {
          return { sessionId: r.sessionId, project: r.project, gzBytes: r.gzBytes, mtime: r.mtime };
        }),
      };
    },
  },
  {
    name: 'keyflip_browser_sync',
    title: "Align the browser to an account's saved session",
    description:
      "macOS only. Restore an account's saved claude.ai browser session (captured during onboard/login) into the browser so the Claude extension reconnects as that account. Quits + reopens the browser. name defaults to the active account. Mutating — ask the user, then confirm=true.",
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, confirm: confirmProp.confirm },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      if (ctx.platform !== 'darwin') throw new Error('browser sync is macOS-only');
      const name = args.name
        ? core.resolveProfile(ctx, String(args.name))
        : (function () {
            let n = null;
            profiles.list(ctx.configDir).forEach(function (p) {
              if (!n && profiles.email(ctx.configDir, p) === core.currentEmail(ctx)) n = p;
            });
            return n;
          })();
      if (!name) throw new Error('which account? pass name');
      const napMs = function (ms) {
        return new Promise(function (r) {
          setTimeout(r, ms);
        });
      };
      const synced = [];
      const list = browser.installed(ctx.home);
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        const sql = browser.loadSession(ctx.configDir, name, b);
        if (!sql) continue;
        const wasRunning = browser.isRunning(b);
        if (wasRunning) {
          browser.quit(b, exec.run);
          for (let t = 0; t < 24 && browser.isRunning(b); t++) {
            await napMs(250);
          }
        }
        if (browser.isRunning(b)) continue; // refused to quit -> don't corrupt a live DB
        const r = browser.restoreClaudeCookies(b, sql, { force: true });
        if (r.ok) {
          synced.push(b.name);
          if (wasRunning) exec.run('open', ['-a', b.proc]);
        }
      }
      return { synced: synced, account: name };
    },
  },

  // ---- git-backed versioning (H3) ----
  // ---- distilled memory (B4) ----
  {
    name: 'keyflip_sessions_distill',
    title: 'Distill a chat into a durable keepsake',
    description:
      'Summarize a past conversation into a durable "keepsake" (goal/decisions/learnings/TODOs) through keyflip\'s configured LLM provider — `keyflip llm` picks it: the default `claude -p` SPENDS the active account\'s quota, while provider=ollama runs locally for free and provider=openai uses an endpoint key. The result records which provider/model wrote it. Set to_claude=true to ALSO write it into ~/.claude project memory (opt-in). Mutating — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        to_claude: { type: 'boolean' },
        model: { type: 'string' },
        confirm: confirmProp.confirm,
      },
      required: ['session_id', 'confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async function (ctx, args) {
      needConfirm(args);
      const path = _path;
      const row = sessions.find(ctx, String(args.session_id));
      if (!row) throw new Error("no session matches '" + args.session_id + "'");
      const gate = llm.availability(ctx);
      if (!gate.ok) throw new Error('distill has no usable provider: ' + gate.reason + ' — ' + gate.fix);
      if (gate.provider.provider === 'claude' && !llm.available(ctx))
        throw new Error('distill needs Claude Code on PATH — or set a provider: keyflip llm set --provider ollama');
      const transcript = fs.readFileSync(row.file, 'utf8');
      const INSTR =
        'Summarize this past coding-assistant conversation (a JSONL transcript) into a durable "keepsake" memory. Output terse markdown bullets under these headings: Goal, Decisions, Built/Changed, Gotchas/Learnings, Open TODOs. Be specific; skip anything trivial; no preamble.';
      const res = await llm.complete(ctx, INSTR, transcript, { model: args.model, skipCheck: true });
      if (!res.ok) throw new Error('distill failed: ' + (res.reason || 'unknown') + (res.fix ? ' — ' + res.fix : ''));
      const l = await lock.acquire(ctx.configDir);
      let saved;
      try {
        saved = memorymod.save(ctx, row.sessionId, res.text, {
          session: row.sessionId,
          cwd: row.cwd || '',
          distilledAt: ctx.now(),
          distillProvider: res.provider,
          distillModel: res.model || '',
        });
      } finally {
        l.release();
      }
      if (args.to_claude) {
        try {
          const d = path.join(sessions.projectsDir(ctx), row.project, 'memory');
          fs.mkdirSync(d, { recursive: true });
          fs.writeFileSync(path.join(d, 'keyflip-' + row.sessionId + '.md'), res.text + '\n');
        } catch (e) {
          /* best-effort */
        }
      }
      return {
        session: row.sessionId,
        memory: saved,
        toClaude: !!args.to_claude,
        provider: res.provider,
        model: res.model || null,
        cost: res.cost,
      };
    },
  },
  {
    name: 'keyflip_sessions_compact',
    title: 'Compact a transcript (elide tool output)',
    description:
      'Shrink a transcript by eliding bulky tool output while keeping the conversation (stays valid/resumable). DRY-RUN (returns the size reduction) unless apply=true, which rewrites it in place (original backed up next to it). apply=true is mutating — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' }, apply: { type: 'boolean' }, confirm: confirmProp.confirm },
      required: ['session_id', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const row = sessions.find(ctx, String(args.session_id));
      if (!row) throw new Error("no session matches '" + args.session_id + "'");
      const content = fs.readFileSync(row.file, 'utf8');
      const r = sessions.compactTranscript(content, {});
      if (!args.apply) return { before: r.before, after: r.after, elided: r.elided, applied: false };
      let bak = null;
      try {
        bak = row.file + '.precompact';
        fs.writeFileSync(bak, content);
      } catch (e) {
        bak = null;
      }
      fs.writeFileSync(row.file, r.compacted);
      return { before: r.before, after: r.after, elided: r.elided, applied: true, backup: bak };
    },
  },
  {
    name: 'keyflip_dream',
    title: 'Consolidate old chats into keepsakes',
    description:
      '"Dreaming": distill OLD un-distilled sessions into durable keepsakes (via `claude -p`; SPENDS the active account\'s quota) and optionally archive the bulk. DRY-RUN (returns the candidate list) unless apply=true. older_than_days default 30, limit default 20; archive=true also stows the raw transcripts. apply=true is mutating + spends quota — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        older_than_days: { type: 'integer' },
        limit: { type: 'integer' },
        apply: { type: 'boolean' },
        archive: { type: 'boolean' },
        confirm: confirmProp.confirm,
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async function (ctx, args) {
      needConfirm(args);
      const days = (args && args.older_than_days) || 30,
        cap = (args && args.limit) || 20;
      const cutoff = Date.now() - days * 86400000;
      const targets = sessions.list(ctx, { limit: 100000 }).filter(function (r) {
        return r.mtimeMs < cutoff && !memorymod.has(ctx, r.sessionId);
      });
      const batch = targets.slice(0, cap);
      const prov = llm.resolve(ctx);
      if (!args || !args.apply)
        return {
          candidates: targets.length,
          wouldProcess: batch.map(function (r) {
            return r.sessionId;
          }),
          apply: false,
          provider: prov.provider,
          model: prov.model || null,
          cost: prov.cost,
        };
      const gate = llm.availability(ctx);
      if (!gate.ok) throw new Error('dream has no usable provider: ' + gate.reason + ' — ' + gate.fix);
      if (gate.provider.provider === 'claude' && !llm.available(ctx))
        throw new Error(
          'dream needs Claude Code on PATH (`claude -p`), or a provider: keyflip llm set --provider ollama',
        );
      const INSTR =
        'Summarize this past coding-assistant conversation (a JSONL transcript) into a durable "keepsake" memory. Output terse markdown bullets under: Goal, Decisions, Built/Changed, Gotchas/Learnings, Open TODOs. Be specific; skip trivia; no preamble.';
      let distilled = 0,
        archived = 0,
        failed = 0;
      for (let i = 0; i < batch.length; i++) {
        const r = batch[i];
        let transcript;
        try {
          transcript = fs.readFileSync(r.file, 'utf8');
        } catch (e) {
          failed++;
          continue;
        }
        const res = await llm.complete(ctx, INSTR, transcript, { skipCheck: true });
        if (!res.ok) {
          failed++;
          continue;
        }
        const l = await lock.acquire(ctx.configDir);
        try {
          memorymod.save(ctx, r.sessionId, res.text, {
            session: r.sessionId,
            cwd: r.cwd || '',
            distilledAt: ctx.now(),
            distillProvider: res.provider,
            distillModel: res.model || '',
          });
        } finally {
          l.release();
        }
        distilled++;
        if (args.archive) {
          const l2 = await lock.acquire(ctx.configDir);
          try {
            if (archive.archiveSession(ctx, r.project, r.sessionId).ok) archived++;
          } finally {
            l2.release();
          }
        }
      }
      return {
        distilled: distilled,
        archived: archived,
        failed: failed,
        apply: true,
        provider: prov.provider,
        model: prov.model || null,
        cost: prov.cost,
      };
    },
  },
  {
    name: 'keyflip_dream_schedule',
    title: 'Schedule the nightly dream',
    description:
      'Install/remove/inspect a schedule (launchd on macOS, cron on Linux) that runs `keyflip dream --apply` unattended nightly. action="status" (read) | "install" | "remove". install runs old-chat distillation on a timer (spends quota) — for install/remove, ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'install', 'remove'] },
        at: { type: 'string', description: 'HH:MM, default 03:00' },
        older_than_days: { type: 'integer' },
        archive: { type: 'boolean' },
        confirm: confirmProp.confirm,
      },
      required: ['action', 'confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async function (ctx, args) {
      const schedule = _schedule;
      const prov = llm.resolve(ctx);
      if (args.action === 'status')
        return {
          schedule: schedule.status(ctx),
          willUse: { provider: prov.provider, model: prov.model || null, cost: prov.cost },
        };
      needConfirm(args);
      if (args.action === 'remove') return { removed: schedule.uninstall(ctx) };
      const r = schedule.install(ctx, {
        at: args.at || '03:00',
        days: args.older_than_days || 30,
        archive: !!args.archive,
        provider: prov.provider,
        model: prov.model,
      });
      if (!r.ok) throw new Error('could not schedule: ' + (r.reason || r.detail || 'unknown'));
      return { scheduled: r, provider: prov.provider, cost: prov.cost };
    },
  },
  {
    name: 'keyflip_refresh_schedule',
    title: 'Schedule the nightly token refresh',
    description:
      'Install/remove/inspect a schedule (launchd on macOS, cron on Linux) that runs `keyflip refresh --all` unattended nightly, so stored OAuth tokens are renewed before they expire rather than discovered dead at switch time. action="status" (read) | "install" | "remove". It rotates tokens for every saved account but calls NO model and spends no quota; while a Claude session is live each run declines to change anything. For install/remove, ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'install', 'remove'] },
        at: { type: 'string', description: 'HH:MM, default 04:30 (deliberately not the dream hour)' },
        confirm: confirmProp.confirm,
      },
      required: ['action', 'confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async function (ctx, args) {
      const schedule = _schedule;
      if (args.action === 'status') return { schedule: schedule.status(ctx, { job: 'refresh' }) };
      needConfirm(args);
      if (args.action === 'remove') return { removed: schedule.uninstall(ctx, { job: 'refresh' }) };
      const r = schedule.install(ctx, { job: 'refresh', at: args.at || '04:30' });
      if (!r.ok) throw new Error('could not schedule: ' + (r.reason || r.detail || 'unknown'));
      return { scheduled: r, spendsQuota: false };
    },
  },
  {
    name: 'keyflip_statusline',
    title: 'Claude Code status line (active account + quota)',
    description:
      'Install/remove/inspect the keyflip status line in Claude Code — it shows the active account, provider, and cached quota in the prompt. action="status"|"install"|"remove". install/remove edit settings.json — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['status', 'install', 'remove'] }, confirm: confirmProp.confirm },
      required: ['action', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      const settings = _settings;
      const fsutil = _fsutil;
      const file = ctx.claudeSettingsPath;
      let cur;
      try {
        cur = settings.read(file);
      } catch (e) {
        throw new Error('~/.claude/settings.json is corrupt');
      }
      const installed = !!(
        cur.statusLine && /statusline/.test(String((cur.statusLine && cur.statusLine.command) || ''))
      );
      if (args.action === 'status') return { installed: installed, command: cur.statusLine && cur.statusLine.command };
      needConfirm(args);
      if (args.action === 'install') {
        const w = exec.run('which', ['keyflip']);
        const cmd =
          w && w.code === 0 && String(w.stdout).trim()
            ? 'keyflip statusline'
            : (process.env.KEYFLIP_STATUSLINE_BIN || 'keyflip') + ' statusline';
        cur.statusLine = { type: 'command', command: cmd, padding: 0 };
      } else if (installed) {
        delete cur.statusLine;
      }
      const l = await lock.acquire(ctx.configDir);
      try {
        fsutil.writeJsonStable(file, cur, 0o600);
      } finally {
        l.release();
      }
      return { statusline: args.action };
    },
  },
  {
    name: 'keyflip_settings',
    title: 'View/edit Claude Code settings',
    description:
      'Read or change ~/.claude/settings.json (the file Claude Code hot-reloads — no restart). action="show"/"get" read; "set"/"unset" write. key is a dot-path (e.g. "env.ANTHROPIC_MODEL"); value is parsed as a JSON literal if valid, else a string. These settings ride `keyflip migrate` to other machines. set/unset are mutating — ask the user, then confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['show', 'get', 'set', 'unset'] },
        key: { type: 'string' },
        value: { type: 'string' },
        confirm: confirmProp.confirm,
      },
      required: ['action', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      const settings = _settings;
      const fsutil = _fsutil;
      const file = ctx.claudeSettingsPath;
      let cur;
      try {
        cur = settings.read(file);
      } catch (e) {
        throw new Error('~/.claude/settings.json is corrupt');
      }
      // NEVER return provider API keys / auth tokens (which `keyflip provider use` writes
      // into env) in plaintext over MCP — they would land in the agent + the transcript.
      if (args.action === 'show') {
        const safe = Object.assign({}, cur);
        if (safe.env && typeof safe.env === 'object') {
          const e = {};
          Object.keys(safe.env).forEach(function (k) {
            e[k] = settings.isCredentialKey(k) ? '***redacted***' : safe.env[k];
          });
          safe.env = e;
        }
        return { settings: safe };
      }
      if (args.action === 'get') {
        if (!args.key) throw new Error('key required');
        const v = settings.getPath(cur, String(args.key));
        const leaf = String(args.key).split('.').pop();
        if (v !== undefined && v !== null && settings.isCredentialKey(leaf))
          return { key: args.key, value: '***redacted***', redacted: true };
        return { key: args.key, value: v === undefined ? null : v };
      }
      needConfirm(args);
      if (!args.key) throw new Error('key required');
      if (args.action === 'set') {
        let val;
        try {
          val = JSON.parse(String(args.value));
        } catch (e) {
          val = String(args.value);
        }
        settings.setPath(cur, String(args.key), val);
      } else {
        settings.setPath(cur, String(args.key), undefined);
      }
      const l = await lock.acquire(ctx.configDir);
      try {
        fsutil.writeJsonStable(file, cur, 0o600);
      } finally {
        l.release();
      }
      return { settings: args.action, key: args.key };
    },
  },
  {
    name: 'keyflip_recall',
    title: 'Semantic recall over your chat keepsakes',
    description:
      'Search your distilled keepsakes for a topic across ALL past chats — "where did I discuss X". Default is local BM25 (offline); set semantic=true to use an embedding endpoint (Ollama/hosted) for true vector search (falls back to lexical if none). set answer=true to synthesize a CITED answer over the retrieved keepsakes through keyflip\'s configured LLM provider (`keyflip llm`: default claude -p spends the active account, ollama is local/free) — one model call, no writes. Returns ranked keepsakes with a snippet + source session. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer' },
        semantic: { type: 'boolean' },
        answer: {
          type: 'boolean',
          description: 'true = synthesize a cited answer (one LLM call, provider = keyflip llm).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      const recall = _recall;
      const limit = (args && args.limit) || 10;
      if (args && args.answer) {
        const ans = await recall.answer(ctx, String(args.query), { limit: (args.limit && args.limit) || 6 });
        if (ans.ok)
          return {
            mode: 'answer',
            answer: ans.text,
            provider: ans.provider,
            model: ans.model || null,
            sources: ans.hits.map(function (h) {
              return { session: h.session, cwd: h.cwd, snippet: h.snippet };
            }),
          };
        // No answer (nothing matched / no provider) — still hand back the ranked keepsakes.
        const fallback = recall.search(ctx, String(args.query), { limit: limit });
        return {
          mode: 'lexical',
          answerUnavailable: ans.reason + (ans.fix ? ' — ' + ans.fix : ''),
          recall: fallback.map(function (h) {
            return {
              key: h.key,
              session: h.session,
              cwd: h.cwd,
              score: Math.round(h.score * 1000) / 1000,
              snippet: h.snippet,
            };
          }),
        };
      }
      if (args && args.semantic) {
        const sem = await recall.semanticSearch(ctx, String(args.query), { limit: limit });
        if (sem.ok)
          return {
            mode: 'semantic',
            recall: sem.hits.map(function (h) {
              return {
                key: h.key,
                session: h.session,
                cwd: h.cwd,
                score: Math.round(h.score * 1000) / 1000,
                snippet: h.snippet,
              };
            }),
          };
        // fall through to lexical, note why
        const lex = recall.search(ctx, String(args.query), { limit: limit });
        return {
          mode: 'lexical',
          semanticUnavailable: sem.reason,
          recall: lex.map(function (h) {
            return {
              key: h.key,
              session: h.session,
              cwd: h.cwd,
              score: Math.round(h.score * 1000) / 1000,
              snippet: h.snippet,
            };
          }),
        };
      }
      const hits = recall.search(ctx, String(args.query), { limit: limit });
      return {
        mode: 'lexical',
        recall: hits.map(function (h) {
          return {
            key: h.key,
            session: h.session,
            cwd: h.cwd,
            score: Math.round(h.score * 1000) / 1000,
            snippet: h.snippet,
          };
        }),
      };
    },
  },
  {
    name: 'keyflip_memory',
    title: "Browse keyflip's distilled keepsakes",
    description:
      "keyflip's OWN memory store (distilled session keepsakes, independent of ~/.claude memory). Omit key to list; pass key to read one. Read-only.",
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, additionalProperties: false },
    annotations: RO,
    run: async function (ctx, args) {
      if (args && args.key) {
        const txt = memorymod.read(ctx, String(args.key));
        if (txt == null) throw new Error("no keepsake '" + args.key + "'");
        return { key: args.key, content: txt };
      }
      return {
        memory: memorymod.list(ctx).map(function (r) {
          return { key: r.key, bytes: r.bytes, mtime: r.mtime };
        }),
      };
    },
  },
  {
    name: 'keyflip_history',
    title: 'keyflip change history (git)',
    description: "Recent versioned changes to keyflip's config/state (git-backed; secrets never committed). Read-only.",
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false },
    annotations: RO,
    run: async function (ctx, args) {
      return { versioning: vcs.isEnabled(ctx), history: vcs.log(ctx, (args && args.limit) || 20) };
    },
  },
  {
    name: 'keyflip_undo',
    title: 'Undo the last keyflip change',
    description:
      "Revert keyflip's config/state to before the most recent change (a git revert; reversible). Mutating — ask the user, then confirm=true.",
    inputSchema: { type: 'object', properties: confirmProp, required: ['confirm'], additionalProperties: false },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const r = vcs.undo(ctx);
      if (!r.ok) throw new Error('cannot undo: ' + (r.reason || 'unknown'));
      return { undone: true };
    },
  },
  {
    name: 'keyflip_restore',
    title: 'Restore keyflip state to a past ref',
    description:
      "Roll keyflip's config/state back to a past ref from keyflip_history. Mutating — ask the user, then confirm=true.",
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, confirm: confirmProp.confirm },
      required: ['ref', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const r = vcs.restore(ctx, String(args.ref));
      if (!r.ok) throw new Error('restore failed: ' + (r.reason || 'unknown'));
      return { restored: args.ref };
    },
  },

  // ==================== Wave 4: Context Layer (portable project memory in .keyflip/) ====================
  {
    name: 'keyflip_context_read',
    title: 'Read the project context',
    description:
      'Read the portable project memory (.keyflip/) for a project directory — project facts, freeform context.md, decisions, tasks, and the NAMES of required environment variables (never their values). `path` defaults to the server cwd. Every text field is secret-redacted. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Project directory (default: cwd).' } },
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      const projctx = _projctx;
      const pp = (args && args.path) || process.cwd();
      return projctx.pack(pp, { now: ctx.now });
    },
  },
  {
    name: 'keyflip_context_task_set',
    title: 'Set a project task status',
    description:
      "Update a task's status in the project context (.keyflip/tasks.json). status ∈ todo|in_progress|blocked|done. Ask the user first, then set confirm=true.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project directory (default: cwd).' },
        id: { type: 'string' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done'] },
        confirm: confirmProp.confirm,
      },
      required: ['id', 'status', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const projctx = _projctx;
      const pp = (args && args.path) || process.cwd();
      const t = projctx.updateTask(pp, String(args.id), { status: String(args.status) }, { now: ctx.now });
      if (!t) throw new Error("no such task: '" + args.id + "'");
      return { updated: { id: t.id, title: t.title, status: t.status } };
    },
  },
  {
    name: 'keyflip_context_decision_add',
    title: 'Record a project decision',
    description:
      'Append an architectural/product decision to the project context (.keyflip/decisions.json) so future AI sessions in ANY tool inherit it. All text is secret-redacted before it is stored. Ask the user first, then set confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project directory (default: cwd).' },
        title: { type: 'string' },
        rationale: { type: 'string' },
        alternatives: { type: 'array', items: { type: 'string' } },
        do_not: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', enum: ['decided', 'rejected', 'superseded'] },
        confirm: confirmProp.confirm,
      },
      required: ['title', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const projctx = _projctx;
      const pp = (args && args.path) || process.cwd();
      const d = projctx.addDecision(
        pp,
        {
          title: args.title,
          rationale: args.rationale,
          alternatives: args.alternatives,
          doNot: args.do_not,
          status: args.status,
        },
        { now: ctx.now },
      );
      return { added: { id: d.id, title: d.title, status: d.status } };
    },
  },
  {
    name: 'keyflip_rules_show',
    title: 'Show normalized project AI rules',
    description:
      "Detect this project's AI rule/instruction files (CLAUDE.md, .cursorrules, .cursor/rules/*, AGENTS.md, GEMINI.md, .github/copilot-instructions.md) and normalize them into ONE common model — sections tagged coding/architecture/security/workflow/general, provenance kept. Secrets are redacted. Read-only.",
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Project directory (default: current working directory).' } },
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      const rules = _rules;
      const base = (args && args.path) || process.cwd();
      const model = rules.importRules(base, { now: ctx.now });
      return {
        detected: rules.detectRuleFiles(base),
        schemaVersion: model.schemaVersion,
        sources: model.sources,
        sections: model.sections,
      };
    },
  },
  {
    name: 'keyflip_rules_emit',
    title: 'Emit project AI rules for one tool',
    description:
      'Render the normalized rule model as the file content ONE tool expects (to=claude→CLAUDE.md, cursor→.cursorrules, agents→AGENTS.md, gemini→GEMINI.md, generic→RULES.md). ALWAYS returns the content (secrets redacted). Pass confirm=false to PREVIEW only; pass confirm=true to WRITE the file into the project — ask the user before writing.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', enum: ['claude', 'cursor', 'agents', 'gemini', 'generic'] },
        path: { type: 'string', description: 'Project directory (default: cwd).' },
        confirm: confirmProp.confirm,
      },
      required: ['to', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      const rules = _rules;
      const base = (args && args.path) || process.cwd();
      const model = rules.loadModel(base) || rules.importRules(base, { now: ctx.now });
      const content = rules.emit(model, args.to);
      if (args.confirm !== true)
        return {
          target: args.to,
          wrote: false,
          preview: true,
          content: content,
          note:
            'preview only — call again with confirm=true to write ' +
            rules.EMIT_TARGETS[args.to].filename +
            ' into the project',
        };
      const res = rules.writeTarget(base, args.to, content);
      return { target: args.to, wrote: true, path: res.path, bytes: res.bytes, content: content };
    },
  },
  {
    name: 'keyflip_checkpoint_list',
    title: 'List project checkpoints',
    description:
      'List git-bound checkpoints for a project (newest first). Each is a session-boundary snapshot: git branch/short-commit/dirty files, a summary, an optional task snapshot, and the active provider, chained by parent id. `path` defaults to the current directory. Read-only, local.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Project directory (defaults to cwd).' } },
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      return { checkpoints: _checkpoint.list((args && args.path) || process.cwd()) };
    },
  },
  {
    name: 'keyflip_checkpoint_latest',
    title: 'Latest project checkpoint',
    description:
      'The most recent git-bound checkpoint for a project (or null if none). `path` defaults to the current directory. Read-only, local.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Project directory (defaults to cwd).' } },
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      return { checkpoint: _checkpoint.latest((args && args.path) || process.cwd()) };
    },
  },
  {
    name: 'keyflip_checkpoint_create',
    title: 'Create a project checkpoint',
    description:
      'Snapshot project state at a session boundary: reads git (branch / short commit / dirty files), records a summary + optional task snapshot + active provider, and chains it to the previous checkpoint. Secrets are REDACTED before anything is written (summary prose, provider, git paths, and every field of tasks_snapshot). Writes .keyflip/checkpoints/<id>.json + latest.json in the project tree. Ask the user first, then set confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project directory (defaults to cwd).' },
        summary: { type: 'string', description: 'Human summary of the session (secrets are masked).' },
        provider: { type: 'string', description: 'Active provider/account name.' },
        tasks_snapshot: {
          description:
            'Arbitrary JSON snapshot of the agent tasks (secrets are redacted; credential-keyed values dropped).',
        },
        confirm: confirmProp.confirm,
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const out = _checkpoint.create(
        (args && args.path) || process.cwd(),
        { summary: args.summary, provider: args.provider, tasksSnapshot: args.tasks_snapshot },
        { now: ctx.now },
      );
      return { checkpoint: out };
    },
  },
  {
    name: 'keyflip_ctxsync_status',
    title: 'Context-sync privacy mode',
    description:
      "The project's context-sync privacy mode (local|git|encrypted|company) and policy — what MAY leave the machine for the shared .keyflip/ context package — plus the current checkpoint. Read-only.",
    inputSchema: {
      type: 'object',
      properties: { projectPath: { type: 'string', description: 'Project root (default: server working dir).' } },
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      return _ctxsync.status((args && args.projectPath) || process.cwd(), { now: ctx.now });
    },
  },
  {
    name: 'keyflip_ctxsync_mode',
    title: 'Set context-sync privacy mode',
    description:
      'Change the project\'s context-sync privacy mode. "local" never leaves the machine; "git" ships plain in the repo; "encrypted" is passphrase-sealed; "company" strips raw conversations + source snippets and shares only approved providers. This changes what context may leave the machine — ask the user first, then set confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['local', 'git', 'encrypted', 'company'],
          description: 'The privacy mode to set.',
        },
        projectPath: { type: 'string', description: 'Project root (default: server working dir).' },
        confirm: confirmProp.confirm,
      },
      required: ['mode', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const m = _ctxsync.setMode((args && args.projectPath) || process.cwd(), String(args.mode), { now: ctx.now });
      return {
        mode: m.mode,
        policy: m.policy,
        checkpoint: { contentHash: m.contentHash, parent: m.parent, updatedAt: m.updatedAt },
      };
    },
  },

  // ---- #41: "is a secret still readable in the PAST?" ----
  {
    name: 'keyflip_history_audit',
    title: 'Scan old commits for leaked secrets',
    description:
      'Walk EVERY blob keyflip ever committed to its state repo and report which ones still hold a secret shape or a secret-path capture — the case the live-file checks cannot see: a file untracked TODAY is still fully readable from an older commit. Returns file + secret KIND + blob sha + how many commits still hold it + whether the path is still tracked; it NEVER returns content, so reading this result does not make a copy of the secret. Run it before letting keyflip mirror chat transcripts (transcripts are full of pasted keys). Findings the user has recorded as expected (keyflip_secrets_policy) come back with tolerated=true and are counted separately — they are STILL scrubbed by keyflip_history_scrub, they just stop being an alarm. Read-only; can take a few seconds. CLI twin: keyflip doctor --history.',
    inputSchema: {
      type: 'object',
      properties: {
        max_blobs: {
          type: 'integer',
          description: 'Cap how many blobs are read (default 5000). A capped scan says truncated=true.',
        },
      },
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      const leakscan = _leakscan;
      if (!vcs.isRepo(ctx)) return { ok: false, reason: 'no-repo', fix: 'keyflip versioning on' };
      const hist = leakscan.historyLeaks(ctx, { maxBlobs: (args && args.max_blobs) || undefined });
      if (!hist.ok) return { ok: false, reason: hist.reason };
      const cls = _secretpolicy.classify(ctx, hist.leaks);
      const scrubbable = [];
      const trackedNow = [];
      hist.leaks.forEach(function (l) {
        const into = l.trackedNow ? trackedNow : scrubbable;
        if (into.indexOf(l.file) === -1) into.push(l.file);
      });
      return {
        ok: true,
        scanned: hist.scanned,
        skipped: hist.skipped,
        truncated: !!hist.truncated,
        leak_count: hist.leaks.length,
        // #44: ALARM vs TOLERATED is the difference between "the user must act" and "the user already
        // decided". Do not treat them as one list, and do not tell them to rotate a tolerated key.
        alarm_count: cls.alarms.length,
        tolerated_count: cls.tolerated.length,
        policy_error: cls.policyError,
        rules_dropped: cls.dropped,
        // Split by whether the path is LIVE: scrubbing a tracked path deletes the working file too,
        // so the agent must not treat these two lists as the same decision.
        scrubbable_paths: scrubbable,
        tracked_paths: trackedNow,
        leaks: cls.findings.map(function (l) {
          return {
            file: l.file,
            blob: l.blob,
            kinds: l.labels,
            confidence: l.confidence,
            tracked_now: !!l.trackedNow,
            commits: l.commits,
            tolerated: !!l.tolerated,
            by: l.by || null,
          };
        }),
        fix: !cls.alarms.length
          ? cls.tolerated.length
            ? 'every finding is tolerated by policy — nothing to explain; keyflip scrub-history still removes them from history if you want the blobs gone'
            : 'history is clean'
          : 'keyflip scrub-history (dry-run plan), then keyflip_history_scrub with confirm=true; for a finding the user knows is expected, keyflip_secrets_tolerate instead of repeating the alarm',
      };
    },
  },
  {
    name: 'keyflip_memory_audit',
    title: 'Audit distilled keepsakes for secrets',
    description:
      "Scan keyflip's own distilled memory (configDir/memory/*.md — what recall, distill, migrate and sync all carry) for secret shapes. A summarized chat can innocently preserve 'my API key is sk-ant-…', and then it propagates to every machine. Returns keepsake key + which KINDS matched + hit count, never the text. Read-only. CLI twin: keyflip memory audit.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) {
      const a = _leakscan.keepsakeAudit(ctx, memorymod);
      const copies = _leakscan.keepsakeCopies(ctx, memorymod);
      return {
        audited: a.audited,
        leak_count: a.leaks.length,
        leaks: a.leaks.map(function (l) {
          return { key: l.key, kinds: l.kinds, hits: l.hits, bytes: l.bytes };
        }),
        // The un-redacted originals a previous --apply left behind: invisible to `keyflip memory`,
        // and still readable secrets, so an agent must be able to see that they exist.
        pending_originals: copies.files.map(function (f) {
          return { key: f.key, bytes: f.bytes };
        }),
        fix: a.leaks.length
          ? 'keyflip memory audit --apply, or keyflip_memory_redact with confirm=true (then keyflip_history_scrub — the keepsake is also in git history)'
          : copies.files.length
            ? 'keyflip memory audit --drop-copies, once the user has confirmed the redaction lost nothing'
            : 'keepsakes are clean',
      };
    },
  },
  {
    name: 'keyflip_history_scrub',
    title: 'Remove leaked secrets from the state-repo history',
    description:
      "Rewrite keyflip's OWN state-repo history with git filter-repo so the paths keyflip_history_audit flagged no longer resolve from any commit. Guardrails, in order: it REFUSES unless git-filter-repo is installed (a hand-rolled partial rewrite can corrupt the repo); it writes a `git bundle` of the current history FIRST, outside the repo at 0600, and refuses to continue if that backup fails; and by default it leaves alone any path that is STILL TRACKED, because dropping a live file from history also drops it from the working tree (pass include_tracked only when the user means it). After the rewrite it re-scans and reports whether the history is provably clean. NOTE the backup bundle contains the secrets until the user moves or deletes it, and the credentials must be rotated anyway. This rewrites git history: call keyflip_history_audit first, show the user what will go, then set confirm=true.",
    inputSchema: {
      type: 'object',
      properties: {
        include_tracked: {
          type: 'boolean',
          description:
            'true also scrubs paths still tracked today (deletes the live file). Default false — history-only.',
        },
        confirm: confirmProp.confirm,
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const leakscan = _leakscan;
      if (!vcs.isRepo(ctx))
        return { applied: false, reason: 'no-repo — nothing versioned to scrub (keyflip versioning on)' };
      const wantTracked = !!(args && args.include_tracked);
      const hist = leakscan.historyLeaks(ctx);
      if (!hist.ok) return { applied: false, reason: 'could not read the history (' + hist.reason + ')' };
      const plan = leakscan.planScrub(ctx, hist.leaks, { now: ctx.now, includeTracked: wantTracked });
      if (plan.mode !== 'filter-repo')
        return {
          applied: false,
          blockers: plan.blockers,
          warns: plan.warns,
          paths: plan.paths,
          left_alone_tracked: plan.skippedTracked,
          tolerated_still_scrubbed: plan.toleratedPaths,
        };
      const r = leakscan.applyScrub(ctx, hist.leaks, { now: ctx.now, includeTracked: wantTracked });
      if (!r.ok) return { applied: false, reason: r.reason, bundle: r.bundle || null, restored: r.restored || null };
      const after = leakscan.historyLeaks(ctx);
      const clsAfter = _secretpolicy.classify(ctx, after.leaks || []);
      return {
        applied: true,
        removed: r.removed,
        bundle: r.bundle,
        rescan_clean: !!(after.ok && !after.leaks.length),
        remaining_leaks: after.leaks ? after.leaks.length : null,
        remaining_alarms: clsAfter.alarms.length,
        note: 'commit ids changed; the bundle still contains the secrets until it is moved off or deleted; rotate the credentials themselves — except any path the user tolerates in keyflip_secrets_policy, which needs no rotation and was still removed from history',
      };
    },
  },
  {
    name: 'keyflip_memory_redact',
    title: 'Redact secrets out of keepsakes',
    description:
      "Replace the secret shapes keyflip_memory_audit found inside the keepsake files themselves, in place, and keep each original beside it as <key>.md.pre-scrub (0600; 'pre-scrub' is a registered secret extension, so the copy is never git-versioned or backed up). Counts only — no content in the return value. This does NOT touch git history: a redacted keepsake is still readable from its old commit until keyflip_history_scrub runs. Pass drop_copies:true (still confirm-gated) once the user has actually read the redacted keepsake, because that is the only step that removes the raw secret from the disk — until then the .pre-scrub IS the leak, and keyflip doctor reports it as 'keepsake originals'. Ask the user, then set confirm=true.",
    inputSchema: {
      type: 'object',
      properties: {
        confirm: confirmProp.confirm,
        drop_copies: {
          type: 'boolean',
          description:
            'true also removes each .pre-scrub original whose keepsake is now provably clean. That is the step that actually gets the secret off the disk — but the copy is the LAST version of that text, so show the user the redacted keepsake first.',
        },
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const r = _leakscan.keepsakeScrub(ctx, memorymod);
      const after = _leakscan.keepsakeAudit(ctx, memorymod);
      const out = {
        redacted: r.redacted,
        keys: r.files,
        matches: r.total,
        originals: 'kept as <key>.md.pre-scrub (0600, never versioned) — delete them once confirmed',
        rescan_leaks: after.leaks.length,
      };
      if (args && args.drop_copies) {
        const d = _leakscan.dropKeepsakeCopies(ctx, memorymod);
        out.dropped_originals = d.dropped;
        out.kept_originals = d.kept;
        out.bytes_removed = d.bytes;
      }
      return out;
    },
  },
  {
    name: 'keyflip_secrets_policy',
    title: 'Which history findings are expected',
    description:
      "Read keyflip's secrets policy: the list of history-scan findings the user has recorded as EXPECTED rather than alarming (a free-tier API key parked where it belongs is the typical case). Returns the rules — each one a repo-relative PATH and/or a secret KIND, never a value — plus how many current findings each silences and how many are still alarms. A tolerated finding is NOT exempted from cleaning: keyflip_history_scrub still removes it from git history, the policy only stops the alarm and the rotation advice. Read-only. Keepsakes (memory/*.md) are never silenced. CLI twin: keyflip secrets list.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) {
      const pol = _secretpolicy.load(ctx);
      const hist = vcs.isRepo(ctx) ? _leakscan.historyLeaks(ctx) : null;
      const cls = hist && hist.ok ? _secretpolicy.classify(ctx, hist.leaks, { policy: pol }) : null;
      return {
        file: _secretpolicy.FILE_NAME,
        relative_to: 'the state dir',
        exists: pol.exists,
        rules: pol.rules.map(function (r) {
          const cov = cls ? _secretpolicy.coverageOf(ctx, cls.findings, r) : { findings: 0, paths: [] };
          return {
            path: r.path,
            kinds: r.kinds.length ? r.kinds : ['any kind'],
            note: r.note || null,
            added_at: r.addedAt || null,
            silences_findings: cov.findings,
            silences_paths: cov.paths,
            broad: r.path === '*' || r.path.indexOf('*') !== -1 || r.path.slice(-1) === '/',
          };
        }),
        rules_dropped: pol.dropped,
        policy_error: pol.error,
        alarms: cls ? cls.alarms.length : null,
        tolerated: cls ? cls.tolerated.length : null,
        history_scanned: !!(hist && hist.ok),
        known_kinds: _secretpolicy.KNOWN_LABELS,
        note_on_scope:
          "a rule silences the ALARM only. Every tolerated path stays in keyflip_history_scrub's plan, because a secret that is merely unimportant is still readable from an old commit.",
        fix: pol.error
          ? 'the policy file could not be read, so NO rule is in effect — fix ' +
            _secretpolicy.FILE_NAME +
            ' in the state dir'
          : 'keyflip_secrets_tolerate to record one, keyflip secrets list to see the findings',
      };
    },
  },
  {
    name: 'keyflip_secrets_tolerate',
    title: 'Record a finding as expected (or undo that)',
    description:
      'Write the secrets policy. action="add" records a repo-relative path (as keyflip_history_audit reports it, e.g. "providers/foo.json") and optionally the secret KIND(s) it covers — "*" for any path is only allowed together with a kind, so a rule can never switch the scan off. action="remove" drops the rule(s) on that path and its findings are alarms again. WHY THIS IS NOT SUPPRESSION: the path stays in the scrub plan and keyflip still cleans it out of git history; what stops is the repeated ✗ in keyflip doctor --history and the "rotate the credential" advice, which is noise for a key the user knowingly left in place. Rules are keyed on path + kind and NEVER on a secret value, and the note is redacted before it is stored, so the versioned policy file holds no fingerprint of anything. This writes versioned state (keyflip undo reverts it). Ask the user which findings they consider expected — do not tolerate a secret on your own initiative, and never for a keepsake.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove'] },
        path: {
          type: 'string',
          description:
            'Repo-relative path exactly as keyflip_history_audit reported it, or "*" when --kinds names a secret kind that is always fine. Trailing "/" = everything under a directory; "*" inside a segment is a wildcard.',
        },
        kinds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Secret KIND(s) the rule covers, from known_kinds in keyflip_secrets_policy (e.g. ["google-api-key"]). Omit = any kind found on that path.',
        },
        note: { type: 'string', description: 'Why this one is expected, for whoever reads the policy later.' },
        confirm: confirmProp.confirm,
      },
      required: ['action', 'path', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const action = args && args.action;
      const pathArg = args && args.path;
      const kinds = Array.isArray(args && args.kinds) ? args.kinds : [];
      const before = _secretpolicy.load(ctx);
      const r =
        action === 'add'
          ? _secretpolicy.addRule(ctx, { path: pathArg, kinds: kinds, note: args && args.note, now: ctx.now })
          : action === 'remove'
            ? _secretpolicy.removeRule(ctx, { path: pathArg, kinds: kinds })
            : null;
      if (!r) return { ok: false, reason: 'action must be "add" or "remove"' };
      if (!r.ok) return { ok: false, reason: r.reason, rules: before.rules };
      // Say what the change DID, from the same scan — an agent must be able to see the breadth it just
      // bought, not only that a rule was written.
      const hist = vcs.isRepo(ctx) ? _leakscan.historyLeaks(ctx) : null;
      const cls = hist && hist.ok ? _secretpolicy.classify(ctx, hist.leaks) : null;
      return {
        ok: true,
        action: action,
        rule: action === 'add' ? r.rule : { removed: r.removed },
        replaced: r.replaced || null,
        note_redacted: r.noteRedacted || 0,
        alarms_now: cls ? cls.alarms.length : null,
        tolerated_now: cls ? cls.tolerated.length : null,
        // Every finding, silenced or not, is what keyflip_history_scrub will remove. Naming them here is
        // the proof that a toleration is not suppression.
        still_scrubbed: cls ? cls.findings.map((f) => f.file) : [],
        rules_total: cls ? cls.rules.length : 0,
        fix: 'keyflip secrets list shows the findings and the rule that covers each one',
      };
    },
  },
];

// Wave-2 modules that ship their own self-contained MCP tool objects (annotations + confirm-gating
// inlined). Appended here so each module owns its tool definitions. Order is display-only.
[
  _orchestrator.mcpTools,
  _policy.mcpTools,
  _integrations.mcpTools,
  _vault.tools,
  _license.mcpTools,
  _surface.mcpTools,
  _chains.mcpTools, // #39: keyflip_chains (RO map) + keyflip_chains_tighten (confirm-gated chmod)
  _handoff.mcpTools, // Wave 4: keyflip_handoff (RO continue-prompt)
].forEach(function (arr) {
  (Array.isArray(arr) ? arr : []).forEach(function (t) {
    if (t && t.name) TOOLS.push(t);
  });
});

// ---- JSON-RPC / MCP plumbing ---------------------------------------------------

function toolDescriptor(t) {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  };
}

async function handle(ctx, msg) {
  // A message without an id is a NOTIFICATION — the spec forbids replying to it,
  // whatever its method. Process nothing that needs a response and stay silent.
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } };
  }
  const id = msg.id;
  if (id === undefined) return null; // notification → no response ever
  if (id === null) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'request id must not be null' } };

  const respond = function (result) {
    return { jsonrpc: '2.0', id: id, result: result };
  };
  const rpcError = function (code, message) {
    return { jsonrpc: '2.0', id: id, error: { code: code, message: message } };
  };

  switch (msg.method) {
    case 'initialize': {
      const requested = msg.params && msg.params.protocolVersion;
      const version = SUPPORTED_VERSIONS.indexOf(requested) !== -1 ? requested : PROTOCOL_VERSION;
      return respond({
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'keyflip', title: 'Keyflip', version: VERSION },
        instructions:
          "Manage the machine's saved Claude accounts. Use keyflip_status/keyflip_list to inspect; " +
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
      const tool = TOOLS.filter(function (t) {
        return t.name === params.name;
      })[0];
      if (!tool) return rpcError(-32602, 'unknown tool: ' + params.name);
      try {
        // Paywall gate (NO-OP unless KEYFLIP_LICENSING is enabled): map the tool to its tier + block if insufficient.
        _license.requireForName(ctx, tool.name);
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
    if (!parsed.length)
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request (empty batch)' } };
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
  const send = function (obj) {
    try {
      output.write(JSON.stringify(obj) + '\n');
    } catch (e) {
      /* peer gone */
    }
  };

  rl.on('line', function (line) {
    line = line.trim();
    if (!line) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    // Each step handles its own errors and the trailing .catch guarantees the
    // chain always resolves — one failing request can never silently stall the rest.
    chain = chain
      .then(function () {
        return Promise.resolve(handleEnvelope(ctx, parsed))
          .then(function (res) {
            if (res) send(res);
          })
          .catch(function (e) {
            const rid = parsed && !Array.isArray(parsed) && parsed.id !== undefined ? parsed.id : null;
            send({ jsonrpc: '2.0', id: rid, error: { code: -32603, message: (e && e.message) || 'internal error' } });
          });
      })
      .catch(function () {
        /* never leave the chain rejected */
      });
  });
  return new Promise(function (resolve) {
    rl.on('close', function () {
      chain.then(resolve, resolve);
    });
  });
}

export { serve, handle, TOOLS, PROTOCOL_VERSION };
