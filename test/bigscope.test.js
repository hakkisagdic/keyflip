'use strict';
// Batch E: MCP registry (#15), desktop gateway (#17), WSL helpers (#16), sync (#18).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const mcpreg = require('../src/mcpreg');
const desktopgw = require('../src/desktopgw');
const wsl = require('../src/wsl');
const sync = require('../src/sync');
const provider = require('../src/provider');
const { makeCtx } = require('./helpers');

function ctxDesktop() {
  const ctx = makeCtx();
  ctx.appDataDir = path.join(ctx.home, 'Library', 'Application Support', 'Claude');
  fs.mkdirSync(ctx.appDataDir, { recursive: true });
  return ctx;
}

// ---- #15 MCP registry ----
test('mcpreg enable projects into ~/.claude.json (preserving keys); disable removes it', function () {
  const ctx = makeCtx();
  fs.writeFileSync(ctx.claudeConfigPath, JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' }, userID: 'u' }));
  mcpreg.add(ctx, 'files', { command: 'npx', args: ['-y', 'server-filesystem'] });
  mcpreg.setEnabled(ctx, 'files', 'claude-code', true);
  let cfg = JSON.parse(fs.readFileSync(ctx.claudeConfigPath, 'utf8'));
  assert.strictEqual(cfg.mcpServers.files.command, 'npx');
  assert.strictEqual(cfg.oauthAccount.emailAddress, 'a@x.com'); // preserved
  mcpreg.setEnabled(ctx, 'files', 'claude-code', false);
  cfg = JSON.parse(fs.readFileSync(ctx.claudeConfigPath, 'utf8'));
  assert.strictEqual(cfg.mcpServers.files, undefined);
  assert.strictEqual(cfg.oauthAccount.emailAddress, 'a@x.com');
});

test('mcpreg desktop enable is skipped when the app config does not exist', function () {
  const ctx = makeCtx(); // no appDataDir
  mcpreg.add(ctx, 'x', { command: 'node', args: ['s.js'] });
  assert.strictEqual(mcpreg.setEnabled(ctx, 'x', 'claude-desktop', true), 'skipped-no-config');
});

test('entryFor wraps npx as cmd /c on Windows (not under WSL)', function () {
  const ctx = makeCtx(); ctx.platform = 'win32'; ctx.claudeDir = 'C:\\Users\\me\\.claude';
  const e = mcpreg.entryFor(ctx, { command: 'npx', args: ['-y', 'foo'] });
  assert.strictEqual(e.command, 'cmd');
  assert.deepStrictEqual(e.args, ['/c', 'npx', '-y', 'foo']);
});

// ---- #16 WSL ----
test('WSL path detection, distro extraction and command wrapping', function () {
  assert.strictEqual(wsl.isWslPath('\\\\wsl$\\Ubuntu\\home\\me\\.claude'), true);
  assert.strictEqual(wsl.isWslPath('\\\\wsl.localhost\\Debian\\x'), true);
  assert.strictEqual(wsl.isWslPath('C:\\Users\\me'), false);
  assert.strictEqual(wsl.distroOf('\\\\wsl$\\Ubuntu\\home'), 'Ubuntu');
  assert.strictEqual(wsl.samePath('C:/A/B', 'c:\\a\\b', 'win32'), true);
  assert.strictEqual(wsl.samePath('/A/B', '/a/b', 'linux'), false);
  const w = wsl.wrapExec('claude', ['--resume'], 'Ubuntu');
  assert.strictEqual(w.command, 'wsl.exe');
  assert.deepStrictEqual(w.args, ['-d', 'Ubuntu', '--', 'sh', '-lc', 'claude --resume']);
});

// ---- #17 desktop gateway ----
test('gateway use sets 3p in both dirs + writes profile; restore flips back to 1p', function () {
  const ctx = ctxDesktop();
  provider.add(ctx, 'gw', { baseUrl: 'https://gw/v1', key: 'k', authScheme: 'bearer', models: { default: 'm' } });
  desktopgw.use(ctx, 'gw');
  const main = path.join(ctx.appDataDir, 'claude_desktop_config.json');
  const cfg = JSON.parse(fs.readFileSync(main, 'utf8'));
  assert.strictEqual(cfg.deploymentMode, '3p');
  const prof = path.join(ctx.appDataDir, 'configLibrary', desktopgw.KEYFLIP_PROFILE_ID + '.json');
  assert.ok(fs.existsSync(prof));
  assert.strictEqual(JSON.parse(fs.readFileSync(prof, 'utf8')).inferenceGatewayBaseUrl, 'https://gw/v1');
  assert.strictEqual(desktopgw.active(ctx).provider, 'gw');

  desktopgw.restore(ctx);
  const cfg2 = JSON.parse(fs.readFileSync(main, 'utf8'));
  assert.strictEqual(cfg2.deploymentMode, '1p');
  assert.strictEqual(fs.existsSync(prof), false);
  assert.strictEqual(desktopgw.active(ctx), null);
});

// ---- #18 encrypted sync ----
test('encrypt/decrypt round-trips; wrong passphrase fails', function () {
  const blob = sync.encrypt('{"hello":"world"}', 'correct horse');
  assert.doesNotMatch(blob, /hello/);                       // ciphertext, not plaintext
  assert.strictEqual(sync.decrypt(blob, 'correct horse'), '{"hello":"world"}');
  assert.throws(function () { sync.decrypt(blob, 'wrong'); }, /decryption failed/);
});

test('sync push encrypts the bundle to WebDAV; pull decrypts + previews', async function () {
  const core = require('../src/core');
  const { writeClaude } = require('./helpers');
  const ctx = makeCtx();
  writeClaude(ctx, { oauthAccount: { emailAddress: 'a@x.com' }, userID: 'u' });
  ctx.store.setLive('{"claudeAiOauth":{"accessToken":"SECRET"}}');
  core.addCurrent(ctx);

  let stored = null;
  const fetchMock = async function (url, opt) {
    if (opt.method === 'PUT') { stored = opt.body; return { status: 201 }; }
    if (opt.method === 'GET') { return stored == null ? { status: 404 } : { status: 200, text: async function () { return stored; } }; }
    return { status: 200 };
  };
  const o = { url: 'https://dav/keyflip.enc', passphrase: 'pw', fetch: fetchMock, device: 'macbook' };
  await sync.push(ctx, o);
  assert.doesNotMatch(stored, /SECRET/);                    // token never stored in clear
  const pulled = await sync.pull(makeCtx(), Object.assign({}, o, { fetch: fetchMock }));
  assert.strictEqual(pulled.found, true);
  assert.strictEqual(pulled.meta.accounts, 1);
  assert.strictEqual(pulled.meta.device, 'macbook');
});
