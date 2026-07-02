'use strict';
// MCP (Model Context Protocol) server over stdio, so agents can operate ccswitch
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
    name: 'ccswitch_status',
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
    name: 'ccswitch_list',
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
    name: 'ccswitch_switch',
    title: 'Switch Claude account',
    description: 'Switch the Claude Code CLI credential to a saved account (in place — the desktop app is NOT closed; a running Claude Code picks the new account up on its next request, so the user\'s current conversation continues on the new account). IMPORTANT: this changes which account is billed and rate-limited. Ask the user before calling, then set confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Account name (from ccswitch_list).' },
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
      if (!name) throw new Error("no such account: '" + args.name + "' (use ccswitch_list)");
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
    name: 'ccswitch_next',
    title: 'Rotate to another Claude account',
    description: 'Rotate the CLI credential to the next saved account, optionally by remaining quota (strategy "best" = most headroom, "next-available" = first not rate-limited). Same in-place semantics as ccswitch_switch. Ask the user before calling, then set confirm=true.',
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
        serverInfo: { name: 'ccswitch', title: 'Claude Account Switcher', version: VERSION },
        instructions: 'Manage the machine\'s saved Claude accounts. Use ccswitch_status/ccswitch_list to inspect; ' +
          'ccswitch_switch/ccswitch_next change the active account and REQUIRE confirm=true after asking the user. ' +
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
