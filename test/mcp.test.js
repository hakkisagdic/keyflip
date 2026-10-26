// MCP server: spec lifecycle + tools over real stdio (spawned `keyflip mcp`).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import * as _child_process from 'child_process';
import { makeCtx } from './helpers.js';
import * as _mcp from '../src/mcp.js';
import * as _config from '../src/config.js';
import * as _memory from '../src/memory.js';
import * as _profiles from '../src/profiles.js';
import * as _provider from '../src/provider.js';
import * as _mcpreg from '../src/mcpreg.js';
import * as _sessionmap from '../src/sessionmap.js';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');

function mkhome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-mcp-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"TA"}}');
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'alice@example.com' }, userID: 'u1' }),
  );
  return home;
}
function cliRun(home, args, input) {
  return _child_process.spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8',
    input: input,
    env: Object.assign({}, process.env, {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      KEYFLIP_CONFIG_DIR: path.join(home, '.config', 'keyflip'),
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      KEYFLIP_TEST_CLAUDE: 'stopped',
    }),
  });
}

// Drive a full JSON-RPC conversation against a spawned server; resolves with
// the responses (by request id) once all expected ids have arrived.
function mcpSession(home, messages, expectIds) {
  return new Promise(function (resolve, reject) {
    const child = spawn(process.execPath, [BIN, 'mcp'], {
      env: Object.assign({}, process.env, {
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        KEYFLIP_CONFIG_DIR: path.join(home, '.config', 'keyflip'),
        APPDATA: path.join(home, 'AppData', 'Roaming'),
        KEYFLIP_TEST_CLAUDE: 'stopped',
      }),
    });
    const got = {};
    let buf = '';
    const timer = setTimeout(function () {
      child.kill();
      reject(new Error('mcp session timed out; got: ' + Object.keys(got)));
    }, 15000);
    child.stdout.on('data', function (d) {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined && msg.id !== null) got[msg.id] = msg;
        if (
          expectIds.every(function (id) {
            return got[id];
          })
        ) {
          clearTimeout(timer);
          child.kill();
          resolve(got);
        }
      }
    });
    child.on('error', function (e) {
      clearTimeout(timer);
      reject(e);
    });
    messages.forEach(function (m) {
      child.stdin.write(JSON.stringify(m) + '\n');
    });
  });
}

test('MCP lifecycle: initialize negotiates a supported protocol version and declares tools', async function () {
  const home = mkhome();
  const got = await mcpSession(
    home,
    [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'ping' },
    ],
    [1, 2, 3],
  );
  assert.strictEqual(got[1].result.protocolVersion, '2025-06-18');
  assert.strictEqual(got[1].result.serverInfo.name, 'keyflip');
  assert.ok(got[1].result.capabilities.tools);
  const names = got[2].result.tools.map(function (t) {
    return t.name;
  });
  // Full surface exposed (accounts + providers + sessions + diagnostics + backup + skills + proxy)
  [
    'keyflip_status',
    'keyflip_list',
    'keyflip_switch',
    'keyflip_switch_plan',
    'keyflip_verify',
    'keyflip_refresh',
    'keyflip_next',
    'keyflip_providers',
    'keyflip_provider_use',
    'keyflip_sessions',
    'keyflip_resume_command',
    'keyflip_doctor',
    'keyflip_usage_history',
    'keyflip_backups',
    'keyflip_backup_create',
    'keyflip_skills',
    'keyflip_skill_add',
    'keyflip_proxy_status',
    'keyflip_proxy_control',
    'keyflip_instances',
    'keyflip_instance_create',
    'keyflip_instance_launch',
    'keyflip_instance_focus',
    'keyflip_instance_kill',
    'keyflip_instance_harden',
    'keyflip_conv_list',
    'keyflip_conv_show',
    'keyflip_conv_search',
    'keyflip_conv_context',
    'keyflip_conv_status',
    'keyflip_conv_index',
    'keyflip_conv_export',
  ].forEach(function (n) {
    assert.ok(names.indexOf(n) !== -1, 'missing MCP tool: ' + n);
  });
  assert.ok(names.length >= 18, 'expected the full tool surface, got ' + names.length);
  // every mutating tool must gate on confirm
  got[2].result.tools.forEach(function (t) {
    if (t.annotations && t.annotations.readOnlyHint === false) {
      assert.ok(
        t.inputSchema.required && t.inputSchema.required.indexOf('confirm') !== -1,
        t.name + ' must require confirm',
      );
    }
  });
  const sw = got[2].result.tools.filter(function (t) {
    return t.name === 'keyflip_switch';
  })[0];
  assert.strictEqual(sw.annotations.destructiveHint, true);
  assert.ok(sw.inputSchema.required.indexOf('confirm') !== -1);
  assert.deepStrictEqual(got[3].result, {});
});

test('MCP: login/logout/browser tools are exposed, gated, and structured', async function () {
  const home = mkhome();
  const got = await mcpSession(
    home,
    [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'keyflip_browser_status', arguments: {} } },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'keyflip_logout', arguments: { confirm: false } },
      },
    ],
    [1, 2, 3, 4],
  );
  const names = got[2].result.tools.map(function (t) {
    return t.name;
  });
  [
    'keyflip_login',
    'keyflip_logout',
    'keyflip_browser_status',
    'keyflip_browser_logout',
    'keyflip_consolidate',
    'keyflip_consolidate_plan',
  ].forEach(function (n) {
    assert.ok(names.indexOf(n) !== -1, 'missing MCP tool: ' + n);
  });
  // browser_status is read-only and returns structured content (macOS-gated content is fine)
  assert.strictEqual(got[3].result.isError, false);
  assert.ok(got[3].result.structuredContent);
  // a mutating surface tool refuses without confirm
  assert.strictEqual(got[4].result.isError, true);
  assert.match(got[4].result.content[0].text, /confirm/i);
});

test('MCP tools: status/list read state; switch requires confirm and then switches', async function () {
  const home = mkhome();
  cliRun(home, ['add']); // alice
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"TB"}}');
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'bob@example.com' }, userID: 'u2' }),
  );
  cliRun(home, ['add']); // bob (active)

  const got = await mcpSession(
    home,
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'keyflip_status', arguments: {} } },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'keyflip_switch', arguments: { name: 'alice', confirm: false } },
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'keyflip_switch', arguments: { name: 'alice', confirm: true } },
      },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'keyflip_list', arguments: {} } },
    ],
    [1, 2, 3, 4, 5],
  );

  assert.strictEqual(got[2].result.structuredContent.cli.email, 'bob@example.com');
  assert.strictEqual(got[3].result.isError, true); // confirm=false refused
  assert.match(got[3].result.content[0].text, /confirmation required/);
  assert.strictEqual(got[4].result.isError, false);
  assert.strictEqual(got[4].result.structuredContent.switched.name, 'alice');
  const accounts = got[5].result.structuredContent.accounts;
  const alice = accounts.filter(function (a) {
    return a.name === 'alice';
  })[0];
  assert.strictEqual(alice.activeCli, true); // switch took effect
});

test('MCP preflight: switch_plan/verify are read-only, refresh gates on confirm, and no secret leaks', async function () {
  // A blob verify.js can honestly read: expiry + a refresh token are what it inspects (never values).
  const mk = function (access, minsLeft) {
    return JSON.stringify({
      claudeAiOauth: {
        accessToken: access,
        refreshToken: 'RT-DO-NOT-LEAK',
        expiresAt: Date.now() + minsLeft * 60000,
        scopes: ['user:inference'],
        subscriptionType: 'max',
        rateLimitTier: 'default-claude',
      },
    });
  };
  const home = mkhome();
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), mk('AT-ALICE-SECRET', 43200)); // 30 days
  cliRun(home, ['add']); // alice (active)
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), mk('AT-BOB-SECRET', 2880));
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'bob@example.com' }, userID: 'u2' }),
  );
  cliRun(home, ['add']); // bob
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), mk('AT-ALICE-SECRET', 43200));
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'alice@example.com' }, userID: 'u1' }),
  );

  // Byte-for-byte "nothing moved": the state repo's .git and its activity log are excluded because
  // keyflip logs and versions metadata, and neither is a credential write.
  const snap = function () {
    const out = {};
    const walk = function (dir, rel) {
      fs.readdirSync(dir).forEach(function (f) {
        const p = path.join(dir, f);
        const r = path.join(rel, f);
        if (p.indexOf('/.git/') !== -1 || /\.log$/i.test(p) || p.indexOf('pre-sync-backups') !== -1) return;
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p, r);
        else out[r] = fs.readFileSync(p).toString('hex');
      });
    };
    ['.claude', path.join('.config', 'keyflip')].forEach(function (d) {
      const p = path.join(home, d);
      if (fs.existsSync(p)) walk(p, d);
    });
    const live = path.join(home, '.claude.json');
    if (fs.existsSync(live)) out['.claude.json'] = fs.readFileSync(live).toString('hex');
    return out;
  };
  const before = snap();

  const got = await mcpSession(
    home,
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'keyflip_switch_plan', arguments: { name: 'bob' } },
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'keyflip_switch_plan', arguments: { name: 'nobody' } },
      },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'keyflip_verify', arguments: {} } },
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'keyflip_refresh', arguments: { account: 'alice', confirm: false } },
      },
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'keyflip_refresh', arguments: { account: 'alice', confirm: true } },
      },
    ],
    [1, 2, 3, 4, 5, 6, 7],
  );

  const tools = got[2].result.tools;
  const by = function (n) {
    return tools.filter(function (t) {
      return t.name === n;
    })[0];
  };
  // Declared, and declared with the right safety shape: planning/verification need no confirmation,
  // refreshing stored credentials does.
  ['keyflip_switch_plan', 'keyflip_verify', 'keyflip_refresh'].forEach(function (n) {
    assert.ok(by(n), 'missing MCP tool: ' + n);
  });
  assert.strictEqual(by('keyflip_switch_plan').annotations.readOnlyHint, true);
  assert.deepStrictEqual(by('keyflip_switch_plan').inputSchema.required, ['name']);
  assert.strictEqual(by('keyflip_verify').annotations.readOnlyHint, true);
  assert.strictEqual(by('keyflip_refresh').annotations.readOnlyHint, false);
  assert.ok(by('keyflip_refresh').inputSchema.required.indexOf('confirm') !== -1);

  // The plan: real mode + real writes, and the account it describes.
  const sc3 = got[3].result;
  assert.strictEqual(sc3.isError, false, JSON.stringify(sc3));
  const plan = sc3.structuredContent;
  assert.strictEqual(plan.target, 'bob');
  assert.strictEqual(plan.email, 'bob@example.com');
  assert.ok(['plain', 'restart', 'in-place', 'app-only'].indexOf(plan.mode) !== -1, 'mode: ' + plan.mode);
  assert.ok(Array.isArray(plan.plan.writes) && plan.plan.writes.length, 'a real switch must promise a write');
  assert.strictEqual(plan.surfaces.activeCliProfile, 'alice');
  assert.strictEqual(plan.verify.state, 'ok'); // bob's capture is 2 days out

  // An unknown account is an error, not an empty plan.
  assert.strictEqual(got[4].result.isError, true);
  assert.match(got[4].result.content[0].text, /no such account/);

  // Verify covers every saved account and rolls each one up in the CLI's own words.
  const sc5 = got[5].result.structuredContent;
  assert.strictEqual(sc5.liveAccount, 'alice'); // the machine is on alice's credential
  assert.strictEqual(sc5.accounts.length, 2);
  const bob = sc5.accounts.filter(function (a) {
    return a.account === 'bob';
  })[0];
  assert.strictEqual(bob.state, 'ok');
  assert.strictEqual(bob.headline, 'usable now');
  assert.ok(
    bob.checks.some(function (c) {
      return c.name === 'cli token (stored)';
    }),
  );
  // Only the live account gets the live-token check — otherwise every account would describe the machine.
  assert.ok(
    !bob.checks.some(function (c) {
      return c.name === 'cli token (live)';
    }),
  );

  // Refresh: refuses without confirm, and on a token 30 days out it does not touch the network.
  assert.strictEqual(got[6].result.isError, true);
  assert.match(got[6].result.content[0].text, /confirmation required/);
  assert.strictEqual(got[7].result.isError, false, JSON.stringify(got[7].result));
  assert.strictEqual(got[7].result.structuredContent.refreshed[0].status, 'fresh');

  // The whole point of the read-only half: the machine is exactly as it was.
  assert.deepStrictEqual(snap(), before, 'switch_plan/verify/refresh(fresh) must write no credential');

  // And no tool result — text or structured — may carry a credential value.
  const all = JSON.stringify([sc3, sc5, got[7].result.structuredContent]);
  ['AT-ALICE-SECRET', 'AT-BOB-SECRET', 'RT-DO-NOT-LEAK'].forEach(function (secret) {
    assert.ok(all.indexOf(secret) === -1, 'a tool result leaked a credential value');
  });
});

// #40 over MCP: an agent deciding whether to run a chore needs the COST, not just the command.
test('MCP keyflip_llm: read-only cost answer, and an override that writes nothing', async function () {
  const t = toolByName('keyflip_llm');
  assert.strictEqual(t.annotations.readOnlyHint, true);
  assert.ok(
    !t.inputSchema.required || t.inputSchema.required.indexOf('confirm') === -1,
    'a read must not demand confirmation',
  );
  const ctx = makeCtx();
  const cfgPath = path.join(ctx.configDir, 'config.json');
  const before = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : '';

  const r = await t.run(ctx, {});
  assert.strictEqual(r.provider, 'claude', 'the default is the subscription path, stated plainly');
  assert.match(r.cost, /ACTIVE Claude account/);
  assert.strictEqual(r.configured_for, 'keyflip llm (config)');

  // A one-off override: an agent can price an alternative without editing shared state.
  const o = await t.run(ctx, { provider: 'ollama', model: 'llama3.2:3b' });
  assert.strictEqual(o.provider, 'ollama');
  assert.strictEqual(o.model, 'llama3.2:3b');
  assert.match(o.base_url, /127\.0\.0\.1:11434/, 'the provider default endpoint is applied');
  assert.strictEqual(o.usable, true, 'a local provider needs no key and no PATH check');
  assert.match(o.cost, /locally/);
  assert.strictEqual(o.configured_for, 'one-off probe only — shared config unchanged');
  const after = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : '';
  assert.strictEqual(after, before, 'the override left the state repo byte-identical');

  // An endpoint without a named key is refused BEFORE any request is made, with the fix.
  const g = await t.run(ctx, { provider: 'openai', base_url: 'https://gw.example.com/v1' });
  assert.strictEqual(g.usable, false);
  assert.strictEqual(g.reason, 'no-key-env');
  assert.match(g.fix, /--key-env/);

  // The key is referenced by NAME only — presence is reported, the value never is.
  const p = await t.run(ctx, { provider: 'openai', base_url: 'https://gw.example.com/v1', key_env: 'GW_KEY' });
  assert.strictEqual(p.key_env, 'GW_KEY');
  assert.strictEqual(p.reason, 'key-env-unset', 'not exported in this shell => not usable, no call attempted');
  assert.ok(JSON.stringify(p).indexOf('Bearer') === -1);
});

// #41 — the agent must be able to ASK "is a secret still in my past?" without being handed the secret,
// and must not be able to rewrite git history without saying so explicitly.
test('MCP keyflip_history_audit / keyflip_memory_audit: read-only, and value-free by construction', async function () {
  const audit = toolByName('keyflip_history_audit');
  const ma = toolByName('keyflip_memory_audit');
  [audit, ma].forEach(function (t) {
    assert.ok(t, 'missing tool ' + t);
    assert.strictEqual(t.annotations.readOnlyHint, true, 'a scan must be a read');
    assert.ok(
      !t.inputSchema.required || t.inputSchema.required.indexOf('confirm') === -1,
      'a read must not demand confirmation',
    );
  });

  // No versioned state yet => an honest "could not look", not a crash and not a false clean.
  const empty = makeCtx();
  const none = await audit.run(empty, {});
  assert.strictEqual(none.ok, false);
  assert.strictEqual(none.reason, 'no-repo');
  assert.match(none.fix, /versioning/);

  // A real repo with a leak that is no longer tracked today.
  const ctx = makeCtx();
  const g = function (args) {
    return _child_process.execFileSync('git', ['-C', ctx.configDir].concat(args), { encoding: 'utf8' });
  };
  const FAKE = 'sk-ant-api03-' + 'AbCdEfGhIjKlMnOpQrStUvWx'.repeat(2);
  g(['init', '-q']);
  fs.writeFileSync(path.join(ctx.configDir, 'old-notes.md'), 'key: ' + FAKE + '\n');
  g(['-c', 'user.email=t@x', '-c', 'user.name=t', 'add', '-A', '-f']);
  g(['-c', 'user.email=t@x', '-c', 'user.name=t', 'commit', '-q', '-m', 'leak']);
  fs.rmSync(path.join(ctx.configDir, 'old-notes.md'));
  g(['rm', '--cached', '-q', '-f', 'old-notes.md']);
  g(['-c', 'user.email=t@x', '-c', 'user.name=t', 'commit', '-q', '-m', 'untrack']);

  const r = await audit.run(ctx, {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.leak_count >= 1, true, 'the untracked-but-still-reachable blob is found');
  assert.deepStrictEqual(r.scrubbable_paths, ['old-notes.md'], 'history-only => safe to scrub');
  assert.deepStrictEqual(r.tracked_paths, [], 'no live file is on the chopping block');
  assert.strictEqual(r.leaks[0].confidence, 'high');
  // The result is what an agent will paste into a chat log — it must not carry the secret.
  assert.strictEqual(JSON.stringify(r).indexOf(FAKE), -1, 'no value in the tool result');

  // Keepsake audit: the same rule for keyflip's distilled memory.
  const home = makeCtx();
  const clean = await ma.run(home, {});
  assert.strictEqual(clean.audited, 0);
  assert.strictEqual(clean.leak_count, 0);
  _memory.save(home, 's1', 'my key is ' + FAKE + '\n');
  const hit = await ma.run(home, {});
  assert.strictEqual(hit.leak_count, 1);
  assert.ok(hit.leaks[0].kinds.indexOf('anthropic-api-key') !== -1);
  assert.strictEqual(JSON.stringify(hit).indexOf(FAKE), -1);
  assert.strictEqual(hit.leaks[0].file, undefined, 'not even the absolute path of the keepsake');
  assert.match(hit.fix, /keyflip_memory_redact/);
});

test('MCP keyflip_history_scrub / keyflip_memory_redact: confirm-gated, and refuse what they cannot do safely', async function () {
  const scrub = toolByName('keyflip_history_scrub');
  const red = toolByName('keyflip_memory_redact');
  const ma = toolByName('keyflip_memory_audit');
  [scrub, red].forEach(function (t) {
    assert.strictEqual(t.annotations.readOnlyHint, false);
    assert.ok(t.inputSchema.required.indexOf('confirm') !== -1, 'a rewrite must require confirm');
  });
  const ctx = makeCtx();
  await assert.rejects(
    async function () {
      return scrub.run(ctx, {});
    },
    /confirmation required/,
    'no silent history rewrite',
  );
  await assert.rejects(async function () {
    return red.run(ctx, {});
  }, /confirmation required/);
  // Even confirmed, a repo that does not exist is refused rather than "fixed" by force.
  const r = await scrub.run(ctx, { confirm: true });
  assert.strictEqual(r.applied, false);
  assert.match(r.reason, /no-repo/);
  // A confirmed redact with nothing to redact is a no-op, not an error.
  const q = await red.run(ctx, { confirm: true });
  assert.strictEqual(q.redacted, 0);
  assert.strictEqual(q.rescan_leaks, 0);

  // ...and the loop closes: a redact leaves an UN-redacted original, the audit must show it exists,
  // and drop_copies removes it only once the keepsake itself is provably clean.
  const home = makeCtx();
  const KEY = 'sk-ant-api03-' + 'AbCdEfGhIjKlMnOpQrStUvWx'.repeat(2);
  _memory.save(home, 'k9', 'key: ' + KEY + '\n');
  const r2 = await red.run(home, { confirm: true });
  assert.strictEqual(r2.redacted, 1);
  assert.ok(/pre-scrub/.test(r2.originals));
  const pend = await ma.run(home, {});
  assert.deepStrictEqual(
    pend.pending_originals.map(function (p) {
      return p.key;
    }),
    ['k9'],
    'the audit names what is still readable on disk',
  );
  assert.ok(pend.pending_originals[0].bytes > 0);
  assert.match(pend.fix, /--drop-copies/);
  const d = await red.run(home, { confirm: true, drop_copies: true });
  assert.deepStrictEqual(d.dropped_originals, ['k9']);
  assert.strictEqual(fs.existsSync(path.join(home.configDir, 'memory', 'k9.md.pre-scrub')), false);
  assert.strictEqual(JSON.stringify(d).indexOf(KEY), -1, 'and no value in any of it');
});

test('MCP new tools work: providers (read) + provider_use requires confirm', async function () {
  const home = mkhome();
  cliRun(home, ['add']); // an account so ctx is valid
  cliRun(home, ['provider', 'add', 'relay', '--base-url', 'https://relay/v1', '--key-file', '-'], 'k\n');
  const got = await mcpSession(
    home,
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'keyflip_providers', arguments: {} } },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'keyflip_provider_use', arguments: { name: 'relay', confirm: false } },
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'keyflip_provider_use', arguments: { name: 'relay', confirm: true } },
      },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'keyflip_sessions', arguments: { limit: 1 } } },
    ],
    [1, 2, 3, 4, 5],
  );
  assert.ok(
    got[2].result.structuredContent.providers.some(function (p) {
      return p.name === 'relay';
    }),
  );
  assert.strictEqual(got[3].result.isError, true); // confirm=false refused
  assert.strictEqual(got[4].result.structuredContent.provider, 'relay'); // switched
  assert.ok(Array.isArray(got[5].result.structuredContent.sessions)); // read-only tool works
});

test('MCP: unknown method -> -32601, unknown tool -> -32602, parse error -> -32700', async function () {
  const home = mkhome();
  const got = await new Promise(function (resolve, reject) {
    const child = spawn(process.execPath, [BIN, 'mcp'], {
      env: Object.assign({}, process.env, {
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        KEYFLIP_CONFIG_DIR: path.join(home, '.config', 'keyflip'),
        APPDATA: path.join(home, 'AppData', 'Roaming'),
        KEYFLIP_TEST_CLAUDE: 'stopped',
      }),
    });
    const lines = [];
    const timer = setTimeout(function () {
      child.kill();
      reject(new Error('timeout'));
    }, 15000);
    child.stdout.on('data', function (d) {
      String(d)
        .split('\n')
        .forEach(function (l) {
          if (l.trim()) lines.push(JSON.parse(l));
        });
      if (lines.length >= 3) {
        clearTimeout(timer);
        child.kill();
        resolve(lines);
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nope/nope' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope' } }) + '\n');
    child.stdin.write('this is not json\n');
  });
  const byId = {};
  got.forEach(function (m) {
    byId[m.id] = m;
  });
  assert.strictEqual(byId[1].error.code, -32601);
  assert.strictEqual(byId[2].error.code, -32602);
  assert.ok(
    got.some(function (m) {
      return m.error && m.error.code === -32700;
    }),
  );
});

test('notifications get NO response; id:null is rejected; a batch returns an array', async function () {
  const mcp = _mcp;
  const ctx = {
    configDir: '/tmp/nope',
    appDataDir: null,
    home: '/tmp',
    store: {
      getProfile: function () {
        return null;
      },
      getLive: function () {
        return null;
      },
    },
  };

  // notification (no id) -> null (no reply)
  assert.strictEqual(await mcp.handle(ctx, { jsonrpc: '2.0', method: 'ping' }), null);
  assert.strictEqual(await mcp.handle(ctx, { jsonrpc: '2.0', method: 'tools/list' }), null);
  // id:null -> invalid request
  const nul = await mcp.handle(ctx, { jsonrpc: '2.0', id: null, method: 'ping' });
  assert.strictEqual(nul.error.code, -32600);
  // a request still gets a reply
  const ok = await mcp.handle(ctx, { jsonrpc: '2.0', id: 9, method: 'ping' });
  assert.deepStrictEqual(ok, { jsonrpc: '2.0', id: 9, result: {} });
});

test('MCP handles a JSON-RPC batch, dropping the notifications from the reply array', async function () {
  const home = mkhome();
  const got = await new Promise(function (resolve, reject) {
    const child = spawn(process.execPath, [BIN, 'mcp'], {
      env: Object.assign({}, process.env, {
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        KEYFLIP_CONFIG_DIR: path.join(home, '.config', 'keyflip'),
        APPDATA: path.join(home, 'AppData', 'Roaming'),
        KEYFLIP_TEST_CLAUDE: 'stopped',
      }),
    });
    let buf = '';
    const timer = setTimeout(function () {
      child.kill();
      reject(new Error('timeout'));
    }, 15000);
    child.stdout.on('data', function (d) {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        clearTimeout(timer);
        child.kill();
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
    child.stdin.write(
      JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' }, // no reply
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ]) + '\n',
    );
  });
  assert.ok(Array.isArray(got));
  assert.strictEqual(got.length, 2); // the notification produced no entry
  assert.deepStrictEqual(
    got
      .map(function (m) {
        return m.id;
      })
      .sort(),
    [1, 2],
  );
});

test('install-skill copies the bundled skill into ~/.claude/skills', function () {
  const home = mkhome();
  const r = cliRun(home, ['install-skill']);
  assert.strictEqual(r.status, 0, r.stderr);
  const dest = path.join(home, '.claude', 'skills', 'keyflip', 'SKILL.md');
  assert.ok(fs.existsSync(dest));
  assert.match(fs.readFileSync(dest, 'utf8'), /^---\r?\nname: keyflip/);
});

// SECURITY (review P1 #4): keyflip_settings show/get must NOT return provider API keys /
// auth tokens (which `provider use` writes into env) in plaintext over MCP.
test('keyflip_settings redacts credential env on show/get (never leaks a key to the agent)', async function () {
  const mcp = _mcp;
  const ctx = makeCtx();
  ctx.claudeSettingsPath = path.join(ctx.home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(ctx.claudeSettingsPath), { recursive: true });
  fs.writeFileSync(
    ctx.claudeSettingsPath,
    JSON.stringify({
      env: { ANTHROPIC_API_KEY: 'sk-SECRET-123', ANTHROPIC_MODEL: 'opus', MAX_OUTPUT_TOKENS: '8000' },
    }),
  );
  const tool = mcp.TOOLS.filter(function (t) {
    return t.name === 'keyflip_settings';
  })[0];
  assert.ok(tool, 'keyflip_settings tool exists');

  const shown = await tool.run(ctx, { action: 'show' });
  assert.strictEqual(shown.settings.env.ANTHROPIC_API_KEY, '***redacted***', 'the API key is masked on show');
  assert.strictEqual(shown.settings.env.ANTHROPIC_MODEL, 'opus', 'non-secret settings pass through');
  assert.strictEqual(shown.settings.env.MAX_OUTPUT_TOKENS, '8000', 'MAX_OUTPUT_TOKENS is not treated as a secret');
  assert.strictEqual(JSON.stringify(shown).indexOf('sk-SECRET-123'), -1, 'the raw key appears nowhere in the result');

  const got = await tool.run(ctx, { action: 'get', key: 'env.ANTHROPIC_API_KEY' });
  assert.strictEqual(got.value, '***redacted***');
  assert.strictEqual(got.redacted, true);
  const gotOk = await tool.run(ctx, { action: 'get', key: 'env.ANTHROPIC_MODEL' });
  assert.strictEqual(gotOk.value, 'opus', 'a non-secret get is returned verbatim');
});

// ---- 2026-07-07 CLI<->MCP parity tools ----
function toolByName(n) {
  return _mcp.TOOLS.find(function (t) {
    return t.name === n;
  });
}

test('parity MCP: gateway_status reports first-party when no gateway is set', async function () {
  const r = await toolByName('keyflip_gateway_status').run(makeCtx());
  assert.strictEqual(r.firstParty, true);
  assert.strictEqual(r.gateway, null);
});

test('parity MCP: mcpreg set/list/remove round-trips (and gates on confirm)', async function () {
  const ctx = makeCtx();
  await assert.rejects(function () {
    return toolByName('keyflip_mcpreg_set').run(ctx, { name: 'ctx7', command: 'npx' });
  }, /confirmation required/);
  await toolByName('keyflip_mcpreg_set').run(ctx, {
    name: 'ctx7',
    command: 'npx',
    args: ['-y', 'ctx7'],
    confirm: true,
  });
  assert.ok(JSON.stringify((await toolByName('keyflip_mcpreg_list').run(ctx)).servers).indexOf('ctx7') !== -1);
  await toolByName('keyflip_mcpreg_remove').run(ctx, { name: 'ctx7', confirm: true });
  assert.strictEqual(JSON.stringify((await toolByName('keyflip_mcpreg_list').run(ctx)).servers).indexOf('ctx7'), -1);
});

test('parity MCP: link/links pin and list a directory→account', async function () {
  const ctx = makeCtx();
  const profiles = _profiles;
  ctx.store.setProfile('work', '{"t":1}');
  profiles.write(ctx.configDir, { name: 'work', email: 'w@x.com', oauthAccount: {}, savedAt: ctx.now() });
  await assert.rejects(function () {
    return toolByName('keyflip_link').run(ctx, { dir: '/tmp/proj', account: 'work' });
  }, /confirmation required/);
  const r = await toolByName('keyflip_link').run(ctx, { dir: '/tmp/proj', account: 'work', confirm: true });
  assert.strictEqual(r.linked.account, 'work');
  assert.ok(JSON.stringify((await toolByName('keyflip_links').run(ctx)).links).indexOf('work') !== -1);
});

test('parity MCP: share builds a pointer link and share_apply imports the provider', async function () {
  const provider = _provider;
  const ctxA = makeCtx();
  provider.add(ctxA, 'relay', {
    baseUrl: 'https://api.example.com',
    authScheme: 'bearer',
    models: {},
    endpointCandidates: [],
  });
  const built = await toolByName('keyflip_share').run(ctxA, { resource: 'provider', name: 'relay', no_secrets: true });
  assert.match(built.url, /^keyflip:\/\/v1\/import\?/);
  const ctxB = makeCtx();
  await assert.rejects(function () {
    return toolByName('keyflip_share_apply').run(ctxB, { url: built.url });
  }, /confirmation required/);
  const r = await toolByName('keyflip_share_apply').run(ctxB, { url: built.url, confirm: true });
  assert.strictEqual(r.imported.name, 'relay');
  assert.ok(provider.exists(ctxB, 'relay'));
});
// #39 — the credential-chain tools, reached through the real registry (so this also proves the
// Wave-2 splice in src/mcp.js actually mounted them).
test('chains MCP: keyflip_chains maps read-only, keyflip_chains_tighten is confirm-gated', async function (t) {
  if (process.platform === 'win32') return t.skip('POSIX permissions not applicable on Windows');
  const ctx = makeCtx();
  const map = toolByName('keyflip_chains');
  const tighten = toolByName('keyflip_chains_tighten');
  assert.ok(map && tighten, 'both tools are registered');
  assert.strictEqual(map.annotations.readOnlyHint, true);
  assert.strictEqual(tighten.annotations.readOnlyHint, false);

  fs.mkdirSync(path.join(ctx.configDir, 'browser-sessions'), { recursive: true });
  const loose = path.join(ctx.configDir, 'browser-sessions', 'work__chrome.sql');
  fs.writeFileSync(loose, 'cookies');
  fs.chmodSync(loose, 0o644);

  const out = await map.run(ctx, {});
  assert.ok(
    out.nodes.some(function (n) {
      return n.id === 'login:claude-web';
    }),
    'the human root is part of the map',
  );
  assert.ok(
    out.risks.some(function (r) {
      return r.kind === 'loose-mode';
    }),
    'and so is the exposure',
  );
  // An MCP result is written into an agent transcript: paths stay relative, values never appear.
  assert.strictEqual(JSON.stringify(out).indexOf(ctx.configDir), -1, 'no absolute state-repo path');
  assert.ok(
    out.nodes.every(function (n) {
      return n.abs === undefined;
    }),
  );

  const scoped = await map.run(ctx, { account: 'work' });
  assert.ok(scoped.summary.nodes <= out.summary.nodes);

  await assert.rejects(function () {
    return tighten.run(ctx, {});
  }, /confirmation required/);
  assert.strictEqual(fs.statSync(loose).mode & 0o777, 0o644, 'refused means nothing was changed');

  const fixed = await tighten.run(ctx, { confirm: true });
  assert.strictEqual(fixed.remaining, 0);
  assert.strictEqual(fs.statSync(loose).mode & 0o777, 0o600, 'the chmod really landed');
});

// #36: the token-refresh schedule is its OWN MCP tool. Folding it into `keyflip_dream_schedule` with
// a `job` property would put that tool's cost promise ("spends your quota") on a job that calls no
// model, and an agent reading the description would be lied to.
test('#36 MCP: keyflip_refresh_schedule maps status read-only and gates install/remove on confirm', async function () {
  const t = toolByName('keyflip_refresh_schedule');
  assert.ok(t, 'the refresh job is reachable from an agent, not just the CLI');
  assert.strictEqual(t.annotations.readOnlyHint, false, 'it can write a schedule');
  assert.ok(t.inputSchema.required.indexOf('confirm') !== -1, 'a mutating tool must require confirm');
  assert.ok(t.inputSchema.properties.at, 'it takes a time');
  assert.strictEqual(t.inputSchema.additionalProperties, false, 'no unknown argument can slip into a cron line');
  const st = await t.run(makeCtx(), { action: 'status' });
  assert.strictEqual(st.schedule.job, 'refresh');
  assert.strictEqual(st.schedule.installed, false);
  await assert.rejects(function () {
    return t.run(makeCtx(), { action: 'install' });
  }, /confirmation required/);
  await assert.rejects(function () {
    return t.run(makeCtx(), { action: 'remove' });
  }, /confirmation required/);
  // Deliberately NOT executed: schedule.install() resolves the runner from ctx/opts, and an MCP call
  // has neither — running it here would edit the real machine's crontab. The gate is the contract.
});

// #35 — the thread tools, reached through the real registry. Two things are proven here that the
// threads unit tests cannot: that the tools are actually mounted (a spliced-out tool is invisible to
// an agent), and that an MCP payload obeys the rule `keyflip_chains` established — a state-repo path
// travels relative, never as `/Users/<name>/…`, because this JSON is copied into an agent transcript.
const THREAD_TOOLS = [
  'keyflip_threads',
  'keyflip_thread_create',
  'keyflip_thread_add',
  'keyflip_thread_remove',
  'keyflip_thread_drop',
  'keyflip_thread_mirror',
];

test('#35 MCP: the thread tools are registered, gated, and path-safe', async function () {
  const ctx = makeCtx();
  const proj = path.join(os.tmpdir(), 'keyflip-mcp-threads-' + process.pid);
  const enc = proj.replace(/[^a-zA-Z0-9]/g, '-');
  const pdir = path.join(ctx.home, '.claude', 'projects', enc);
  fs.mkdirSync(pdir, { recursive: true });
  const ID_A = 'aaaaaaaa-1111-4111-8111-111111111111';
  const ID_B = 'bbbbbbbb-2222-4222-8222-222222222222';
  function write(id, turns) {
    fs.writeFileSync(
      path.join(pdir, id + '.jsonl'),
      turns
        .map(function (t, i) {
          return JSON.stringify({
            type: t.role,
            sessionId: id,
            cwd: i === 0 ? proj : undefined,
            timestamp: t.ts,
            message: { role: t.role, content: [{ type: 'text', text: t.text }] },
          });
        })
        .join('\n') + '\n',
      { mode: 0o600 },
    );
  }
  write(ID_A, [{ role: 'user', text: 'design the thread store sk-ant-SECRETXYZ', ts: '2026-10-14T09:00:00.000Z' }]);
  write(ID_B, [{ role: 'user', text: 'quota ran out, continue on the other account', ts: '2026-10-14T12:00:00.000Z' }]);
  _profiles.write(ctx.configDir, { name: 'gmail', email: 'g@example.com' });
  _profiles.write(ctx.configDir, { name: 'yahoo', email: 'y@example.com' });
  _sessionmap.set(ctx, ID_A, 'gmail');
  _sessionmap.set(ctx, ID_B, 'yahoo');

  const read = toolByName('keyflip_threads');
  assert.ok(read, 'all six tools mounted: ' + JSON.stringify(THREAD_TOOLS.map(toolByName).filter(Boolean)));
  assert.strictEqual(
    THREAD_TOOLS.filter(function (n) {
      return !toolByName(n);
    }).length,
    0,
  );
  assert.strictEqual(read.annotations.readOnlyHint, true, 'listing threads never writes');
  [
    'keyflip_thread_create',
    'keyflip_thread_add',
    'keyflip_thread_remove',
    'keyflip_thread_drop',
    'keyflip_thread_mirror',
  ].forEach(function (n) {
    const t = toolByName(n);
    assert.strictEqual(t.annotations.readOnlyHint, false, n + ' writes state');
    assert.ok((t.inputSchema.required || []).indexOf('confirm') !== -1, n + ' requires confirm');
    assert.strictEqual(t.inputSchema.additionalProperties, false, n + ' rejects unknown arguments');
  });

  // Discovery, which is the answer to "why is my work in two places?" — asked BEFORE the work gets
  // named, because naming it is what takes it off the list.
  const suggested = await read.run(ctx, { suggest: true });
  assert.strictEqual(suggested.candidates.length, 1, 'the split project is found without being told');
  assert.deepStrictEqual(suggested.candidates[0].accounts, ['gmail', 'yahoo']);
  assert.strictEqual(suggested.candidates[0].unthreaded, 2);
  assert.strictEqual(
    suggested.candidates[0].suggestedSlug,
    'keyflip-mcp-threads-' + process.pid,
    'the suggestion is the folder name the user knows, not the encoded project dir',
  );

  // Refused means NOTHING was written — checked on disk, not in the reply.
  await assert.rejects(function () {
    return toolByName('keyflip_thread_create').run(ctx, { slug: 'design' });
  }, /confirmation required/);
  assert.strictEqual(fs.existsSync(path.join(ctx.configDir, 'threads')), false, 'no threads dir from a refused call');

  // An 8-char id is what `suggest` prints, so create must expand it into a real pointer.
  await toolByName('keyflip_thread_create').run(ctx, {
    slug: 'design',
    title: 'Threads design',
    session_id: ID_A.slice(0, 8),
    confirm: true,
  });
  await toolByName('keyflip_thread_add').run(ctx, { slug: 'design', session_id: ID_B.slice(0, 8), confirm: true });
  const onDisk = JSON.parse(fs.readFileSync(path.join(ctx.configDir, 'threads', 'design.json'), 'utf8'));
  assert.deepStrictEqual(
    onDisk.members.map(function (m) {
      return m.id;
    }),
    [ID_A, ID_B],
    'prefixes became full ids — a dead pointer would resume nothing',
  );
  assert.ok(
    onDisk.members.every(function (m) {
      return !m.label;
    }),
    'no transcript prose is stored: the pointer file is git-versioned and rides with `migrate`',
  );
  assert.strictEqual(
    fs.readFileSync(path.join(ctx.configDir, 'threads', 'design.json'), 'utf8').indexOf('sk-ant-SECRETXYZ'),
    -1,
  );

  // Bad input is rejected rather than guessed at.
  await assert.rejects(function () {
    return toolByName('keyflip_thread_add').run(ctx, {
      slug: 'design',
      session_id: ID_A,
      account: 'ghost',
      confirm: true,
    });
  }, /no such account/);
  await assert.rejects(function () {
    return toolByName('keyflip_thread_add').run(ctx, { slug: 'design', chat_id: 'not-a-uuid', confirm: true });
  }, /claude\.ai chat uuid/);
  await assert.rejects(function () {
    return toolByName('keyflip_thread_add').run(ctx, {
      slug: 'design',
      session_id: ID_A,
      chat_id: ID_B,
      confirm: true,
    });
  }, /one member per call/);

  const view = await read.run(ctx, { slug: 'design', timeline: true });
  assert.strictEqual(view.members.length, 2);
  assert.strictEqual(view.timeline.length, 2, 'both transcripts spoke, in merged order');
  assert.strictEqual(view.timeline[0].from.account, 'gmail', 'the account switch is visible inside the merge');
  assert.strictEqual(view.timeline[1].from.account, 'yahoo');
  // Path hygiene, asserted the same way as `keyflip_chains`.
  const blob = JSON.stringify(view);
  assert.strictEqual(blob.indexOf(ctx.configDir), -1, 'the state repo never travels as an absolute path');
  assert.strictEqual(blob.indexOf(path.join(ctx.home, '.claude', 'projects')), -1, 'nor does the transcript root');
  assert.strictEqual(view.thread.file, 'threads/design.json', 'the pointer file is relative to the state dir');
  assert.ok(view.members[0].transcript.indexOf(enc) === 0, 'a transcript is relative to ~/.claude/projects');
  assert.strictEqual(view.members[0].resume.cwd, proj, 'the resume command keeps the real cwd — it needs it');

  const byId = await read.run(ctx, { id: ID_B.slice(0, 8) });
  assert.strictEqual(byId.threads[0].slug, 'design', 'a session id points back at its thread');

  // The mirror is the one call that puts conversation TEXT on disk, so it stays doubly gated: the
  // tool needs `confirm`, and the config flag has to say yes as well.
  await assert.rejects(function () {
    return toolByName('keyflip_thread_mirror').run(ctx, { slug: 'design', confirm: true });
  }, /threads\.mirror is off/);
  assert.strictEqual(fs.existsSync(path.join(ctx.configDir, 'thread-mirror')), false, 'refused means nothing written');
  _config.set(ctx, 'threads.mirror', true);
  const mirrored = await toolByName('keyflip_thread_mirror').run(ctx, { slug: 'design', confirm: true });
  assert.strictEqual(mirrored.path, 'thread-mirror/design.md', 'and the path it reports is relative');
  if (process.platform !== 'win32')
    assert.strictEqual(fs.statSync(path.join(ctx.configDir, 'thread-mirror', 'design.md')).mode & 0o777, 0o600);

  await toolByName('keyflip_thread_remove').run(ctx, {
    slug: 'design',
    id: 'session:' + ID_B.slice(0, 8),
    confirm: true,
  });
  const dropped = await toolByName('keyflip_thread_drop').run(ctx, { slug: 'design', confirm: true });
  assert.strictEqual(dropped.dropped, 'design');
  assert.strictEqual(fs.existsSync(path.join(ctx.configDir, 'threads', 'design.json')), false, 'the name is gone');
  assert.ok(fs.existsSync(path.join(pdir, ID_A + '.jsonl')), 'the transcript was never touched');
  assert.ok(fs.existsSync(path.join(pdir, ID_B + '.jsonl')));
  assert.ok(_sessionmap.get(ctx, ID_A), 'and the account assignment stayed');
});

// #44 — the policy tools. The invariant is the whole feature: an agent must be able to stop the ALARM on
// a secret the user calls unimportant, and must NOT be able to use that to leave the blob in history or
// to be handed a value.
test('MCP keyflip_secrets_policy / keyflip_secrets_tolerate: read vs confirm-gated write, and no exemption from cleaning', async function () {
  const read = toolByName('keyflip_secrets_policy');
  const write = toolByName('keyflip_secrets_tolerate');
  const audit = toolByName('keyflip_history_audit');
  assert.strictEqual(read.annotations.readOnlyHint, true, 'reading a policy is a read');
  assert.ok(!read.inputSchema.required || read.inputSchema.required.indexOf('confirm') === -1);
  assert.strictEqual(write.annotations.readOnlyHint, false, 'writing one is a mutation');
  assert.deepStrictEqual(write.inputSchema.required, ['action', 'path', 'confirm']);

  const ctx = makeCtx();
  await assert.rejects(function () {
    return write.run(ctx, { action: 'add', path: 'providers/gmail.json' });
  }, /confirmation required/);

  // A leak in a real repo, untracked today — the case the live checks cannot see.
  const g = function (args) {
    return _child_process.execFileSync('git', ['-C', ctx.configDir].concat(args), { encoding: 'utf8' });
  };
  const id = ['-c', 'user.email=t@keyflip.test', '-c', 'user.name=t'];
  const GOOGLE = 'AIza' + 'Simulated-Not-A-Real-Google-Key-00000';
  g(['init', '-q']);
  fs.writeFileSync(path.join(ctx.configDir, 'providers-gmail.json'), '{"apiKey":"' + GOOGLE + '"}');
  g(id.concat(['add', '-A', '-f']));
  g(id.concat(['commit', '-q', '-m', 'leak']));
  fs.rmSync(path.join(ctx.configDir, 'providers-gmail.json'));
  g(['rm', '--cached', '-q', '-f', 'providers-gmail.json']);
  g(id.concat(['commit', '-q', '-m', 'untrack']));

  const first = await audit.run(ctx, {});
  assert.strictEqual(first.alarm_count >= 1, true, 'before: it alarms');
  assert.strictEqual(first.tolerated_count, 0);
  assert.match(first.fix, /keyflip_secrets_tolerate/, 'and the agent is told the alternative to nagging');

  const added = await write.run(ctx, {
    action: 'add',
    path: 'providers-gmail.json',
    kinds: ['google-api-key'],
    note: 'free tier, key is ' + GOOGLE,
    confirm: true,
  });
  assert.strictEqual(added.ok, true, added.reason);
  assert.strictEqual(added.alarms_now, 0, 'after: nothing alarms');
  assert.strictEqual(added.note_redacted >= 1, true, 'the note was sanitized on the way in');
  assert.deepStrictEqual(added.still_scrubbed, ['providers-gmail.json'], 'and the path is STILL on the scrub list');

  const pol = await read.run(ctx, {});
  assert.strictEqual(pol.file, 'secrets-policy.json', 'reported relative to the state dir, never a home path');
  assert.strictEqual(pol.exists, true);
  assert.strictEqual(pol.rules.length, 1);
  assert.strictEqual(pol.rules[0].path, 'providers-gmail.json');
  assert.deepStrictEqual(pol.rules[0].kinds, ['google-api-key']);
  assert.strictEqual(pol.rules[0].silences_paths.length, 1);
  assert.match(pol.note_on_scope, /silences the ALARM only/, 'the payload teaches the difference');
  assert.match(pol.note_on_scope, /stays in keyflip_history_scrub's plan/);
  assert.deepStrictEqual(pol.known_kinds.indexOf('google-api-key') !== -1, true);
  assert.strictEqual(JSON.stringify(pol).indexOf(GOOGLE), -1, 'no value in the result an agent pastes');
  assert.strictEqual(fs.readFileSync(path.join(ctx.configDir, 'secrets-policy.json'), 'utf8').indexOf(GOOGLE), -1);

  // A rule that would silence everything is refused even with confirm=true: a hole is not a preference.
  const hole = await write.run(ctx, { action: 'add', path: '*', confirm: true });
  assert.strictEqual(hole.ok, false);
  assert.match(hole.reason, /switched off/);
  const bad = await write.run(ctx, { action: 'add', path: 'x.json', kinds: ['not-a-kind'], confirm: true });
  assert.strictEqual(bad.ok, false, 'an unknown KIND would match nothing forever');

  const second = await audit.run(ctx, {});
  assert.strictEqual(second.alarm_count, 0);
  assert.match(second.fix, /tolerated by policy/, 'and the audit now tells the agent there is nothing to explain');

  const removed = await write.run(ctx, { action: 'remove', path: 'providers-gmail.json', confirm: true });
  assert.strictEqual(removed.ok, true);
  assert.strictEqual(removed.rule.removed.length, 1);
  assert.strictEqual(removed.alarms_now, 1, 'untolerating is instant and complete');
});

test('mcp --register wires keyflip with absolute paths a GUI launcher can run', function () {
  const ctx = makeCtx();
  fs.writeFileSync(ctx.claudeConfigPath, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  const e = _mcpreg.selfEntry();
  assert.ok(path.isAbsolute(e.command), 'the node binary is an absolute path');
  assert.ok(path.isAbsolute(e.args[0]), 'the keyflip script is an absolute path');
  assert.deepStrictEqual(e.args.slice(1), ['mcp']);
  _mcpreg.add(ctx, 'keyflip', e);
  assert.strictEqual(_mcpreg.setEnabled(ctx, 'keyflip', 'claude-code', true), 'applied');
  const cfg = JSON.parse(fs.readFileSync(ctx.claudeConfigPath, 'utf8'));
  assert.deepStrictEqual(cfg.mcpServers.keyflip, e);
  assert.deepStrictEqual(cfg.mcpServers.other, { command: 'x' }, 'other servers are untouched');
});

// ---- unified conversation layer -------------------------------------------------------------
function seedConversation(home) {
  const dir = path.join(home, '.claude', 'projects', '-work-proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'sess-mcp.jsonl'),
    [
      {
        type: 'user',
        timestamp: '2026-01-01T10:00:00.000Z',
        cwd: '/work/proj',
        message: { role: 'user', content: 'Index the MCP conversations safely.' },
      },
      {
        type: 'assistant',
        timestamp: '2026-01-01T10:00:01.000Z',
        message: { role: 'assistant', content: 'The database migration is a dry run first.' },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
  );
}

function call(id, name, args) {
  return { jsonrpc: '2.0', id: id, method: 'tools/call', params: { name: name, arguments: args } };
}

test('MCP conversation tools: read-only tools never build, index needs confirm', async function () {
  const home = mkhome();
  seedConversation(home);
  const noIndex = await mcpSession(home, [call(1, 'keyflip_conv_search', { query: 'database' })], [1]);
  assert.strictEqual(noIndex[1].result.isError, true);
  assert.match(noIndex[1].result.content[0].text, /no conversation index/i);

  const guarded = await mcpSession(home, [call(1, 'keyflip_conv_index', {})], [1]);
  assert.strictEqual(guarded[1].result.isError, true);
  assert.match(guarded[1].result.content[0].text, /confirm/i);

  const built = await mcpSession(home, [call(1, 'keyflip_conv_index', { confirm: true, limit_sources: 5 })], [1]);
  const r = built[1].result.structuredContent;
  assert.strictEqual(r.ok, true);
  assert.ok(r.indexed >= 1);
  assert.ok(r.stats.sources >= 1);
  assert.strictEqual(r.coverage, 0);
});

test('MCP conversation tools: list, search, context, show, and a handoff bundle', async function () {
  const home = mkhome();
  seedConversation(home);
  const out = path.join(home, 'handoff-out');
  const got = await mcpSession(
    home,
    [
      call(1, 'keyflip_conv_index', { confirm: true }),
      call(2, 'keyflip_conv_list', { limit: 5 }),
      call(3, 'keyflip_conv_search', { query: 'database migration', limit: 3 }),
      call(4, 'keyflip_conv_context', { query: 'database migration', budget: 2000 }),
      call(5, 'keyflip_conv_show', { id: 'sess-mcp', max_chars: 2000 }),
      call(6, 'keyflip_conv_export', { confirm: true, id: 'sess-mcp', target: 'claude', out: out }),
    ],
    [2, 3, 4, 5, 6],
  );
  const list = got[2].result.structuredContent;
  assert.strictEqual(list.indexed, true);
  assert.strictEqual(list.total, 1);
  assert.strictEqual(list.conversations[0].id, 'claude:local:sess-mcp');
  assert.strictEqual(list.conversations[0].messages, 2);

  const search = got[3].result.structuredContent;
  assert.strictEqual(search.mode, 'lexical'); // no vectors: never claim hybrid
  assert.strictEqual(search.count, 1);
  assert.strictEqual(search.hits[0].id, 'claude:local:sess-mcp');

  const ctxRes = got[4].result.structuredContent;
  assert.match(ctxRes.context, /^# Conversation context/);
  assert.match(ctxRes.context, /database migration/i);
  assert.ok(ctxRes.sources.length >= 1);

  const show = got[5].result.structuredContent;
  assert.strictEqual(show.id, 'claude:local:sess-mcp');
  assert.match(show.content, /Index the MCP conversations safely/);
  assert.strictEqual(show.truncated, false);

  const bundle = got[6].result.structuredContent;
  assert.strictEqual(bundle.target, 'claude');
  assert.ok(fs.existsSync(path.join(out, 'CONTINUE.md')));
  assert.ok(fs.existsSync(path.join(out, 'conversation.json')));
});

test('MCP keyflip_consolidate: plan is read-only; apply is gated', async function () {
  const home = mkhome();
  const got = await mcpSession(
    home,
    [call(1, 'keyflip_consolidate_plan', {}), call(2, 'keyflip_consolidate', {})],
    [1, 2],
  );
  // The plan tool answers without confirm: ok/reason shape, never an MCP error.
  assert.strictEqual(got[1].result.isError, false);
  const plan = got[1].result.structuredContent;
  assert.strictEqual(plan.dryRun, true);
  assert.strictEqual(typeof plan.wouldMerge, 'number');
  assert.ok(Array.isArray(plan.plan));
  assert.match(plan.note, /nothing was written/);
  // The apply refuses without confirm.
  assert.strictEqual(got[2].result.isError, true);
  assert.match(got[2].result.content[0].text, /confirm/i);
});
