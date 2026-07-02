'use strict';
// MCP server: spec lifecycle + tools over real stdio (spawned `ccswitch mcp`).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'ccswitch.js');

function mkhome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-mcp-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"TA"}}');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'alice@example.com' }, userID: 'u1' }));
  return home;
}
function cliRun(home, args, input) {
  return require('child_process').spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8', input: input,
    env: Object.assign({}, process.env, {
      HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      CCSWITCH_CONFIG_DIR: path.join(home, '.config', 'ccswitch'), APPDATA: path.join(home, 'AppData', 'Roaming'),
      CCSWITCH_TEST_CLAUDE: 'stopped',
    }),
  });
}

// Drive a full JSON-RPC conversation against a spawned server; resolves with
// the responses (by request id) once all expected ids have arrived.
function mcpSession(home, messages, expectIds) {
  return new Promise(function (resolve, reject) {
    const child = spawn(process.execPath, [BIN, 'mcp'], {
      env: Object.assign({}, process.env, {
        HOME: home, USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
      CCSWITCH_CONFIG_DIR: path.join(home, '.config', 'ccswitch'), APPDATA: path.join(home, 'AppData', 'Roaming'),
        CCSWITCH_TEST_CLAUDE: 'stopped',
      }),
    });
    const got = {};
    let buf = '';
    const timer = setTimeout(function () { child.kill(); reject(new Error('mcp session timed out; got: ' + Object.keys(got))); }, 15000);
    child.stdout.on('data', function (d) {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined && msg.id !== null) got[msg.id] = msg;
        if (expectIds.every(function (id) { return got[id]; })) {
          clearTimeout(timer); child.kill(); resolve(got);
        }
      }
    });
    child.on('error', function (e) { clearTimeout(timer); reject(e); });
    messages.forEach(function (m) { child.stdin.write(JSON.stringify(m) + '\n'); });
  });
}

test('MCP lifecycle: initialize negotiates a supported protocol version and declares tools', async function () {
  const home = mkhome();
  const got = await mcpSession(home, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'ping' },
  ], [1, 2, 3]);
  assert.strictEqual(got[1].result.protocolVersion, '2025-06-18');
  assert.strictEqual(got[1].result.serverInfo.name, 'ccswitch');
  assert.ok(got[1].result.capabilities.tools);
  const names = got[2].result.tools.map(function (t) { return t.name; }).sort();
  assert.deepStrictEqual(names, ['ccswitch_list', 'ccswitch_next', 'ccswitch_status', 'ccswitch_switch']);
  const sw = got[2].result.tools.filter(function (t) { return t.name === 'ccswitch_switch'; })[0];
  assert.strictEqual(sw.annotations.destructiveHint, true);
  assert.ok(sw.inputSchema.required.indexOf('confirm') !== -1);
  assert.deepStrictEqual(got[3].result, {});
});

test('MCP tools: status/list read state; switch requires confirm and then switches', async function () {
  const home = mkhome();
  cliRun(home, ['add']);                                     // alice
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"TB"}}');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'bob@example.com' }, userID: 'u2' }));
  cliRun(home, ['add']);                                     // bob (active)

  const got = await mcpSession(home, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ccswitch_status', arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ccswitch_switch', arguments: { name: 'alice', confirm: false } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ccswitch_switch', arguments: { name: 'alice', confirm: true } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ccswitch_list', arguments: {} } },
  ], [1, 2, 3, 4, 5]);

  assert.strictEqual(got[2].result.structuredContent.cli.email, 'bob@example.com');
  assert.strictEqual(got[3].result.isError, true);                       // confirm=false refused
  assert.match(got[3].result.content[0].text, /confirmation required/);
  assert.strictEqual(got[4].result.isError, false);
  assert.strictEqual(got[4].result.structuredContent.switched.name, 'alice');
  const accounts = got[5].result.structuredContent.accounts;
  const alice = accounts.filter(function (a) { return a.name === 'alice'; })[0];
  assert.strictEqual(alice.activeCli, true);                             // switch took effect
});

test('MCP: unknown method -> -32601, unknown tool -> -32602, parse error -> -32700', async function () {
  const home = mkhome();
  const got = await new Promise(function (resolve, reject) {
    const child = spawn(process.execPath, [BIN, 'mcp'], {
      env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
      CCSWITCH_CONFIG_DIR: path.join(home, '.config', 'ccswitch'), APPDATA: path.join(home, 'AppData', 'Roaming'), CCSWITCH_TEST_CLAUDE: 'stopped' }),
    });
    const lines = [];
    const timer = setTimeout(function () { child.kill(); reject(new Error('timeout')); }, 15000);
    child.stdout.on('data', function (d) {
      String(d).split('\n').forEach(function (l) { if (l.trim()) lines.push(JSON.parse(l)); });
      if (lines.length >= 3) { clearTimeout(timer); child.kill(); resolve(lines); }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nope/nope' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope' } }) + '\n');
    child.stdin.write('this is not json\n');
  });
  const byId = {}; got.forEach(function (m) { byId[m.id] = m; });
  assert.strictEqual(byId[1].error.code, -32601);
  assert.strictEqual(byId[2].error.code, -32602);
  assert.ok(got.some(function (m) { return m.error && m.error.code === -32700; }));
});

test('notifications get NO response; id:null is rejected; a batch returns an array', async function () {
  const mcp = require('../src/mcp');
  const ctx = { configDir: '/tmp/nope', appDataDir: null, home: '/tmp', store: { getProfile: function () { return null; }, getLive: function () { return null; } } };

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
      env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
      CCSWITCH_CONFIG_DIR: path.join(home, '.config', 'ccswitch'), APPDATA: path.join(home, 'AppData', 'Roaming'), CCSWITCH_TEST_CLAUDE: 'stopped' }),
    });
    let buf = '';
    const timer = setTimeout(function () { child.kill(); reject(new Error('timeout')); }, 15000);
    child.stdout.on('data', function (d) {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl !== -1) { clearTimeout(timer); child.kill(); resolve(JSON.parse(buf.slice(0, nl))); }
    });
    child.stdin.write(JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' }, // no reply
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]) + '\n');
  });
  assert.ok(Array.isArray(got));
  assert.strictEqual(got.length, 2); // the notification produced no entry
  assert.deepStrictEqual(got.map(function (m) { return m.id; }).sort(), [1, 2]);
});

test('install-skill copies the bundled skill into ~/.claude/skills', function () {
  const home = mkhome();
  const r = cliRun(home, ['install-skill']);
  assert.strictEqual(r.status, 0, r.stderr);
  const dest = path.join(home, '.claude', 'skills', 'ccswitch', 'SKILL.md');
  assert.ok(fs.existsSync(dest));
  assert.match(fs.readFileSync(dest, 'utf8'), /^---\r?\nname: ccswitch/);
});
