// Cross-agent MCP projection: one registry, every agent config keyflip can write safely.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as mcpreg from '../src/mcpreg.js';
import { makeCtx, assertPrivateMode } from './helpers.js';

function write(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return file;
}
function read(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('cursor: creates ~/.cursor/mcp.json when Cursor is installed, keeps other keys, disable deletes only ours', function () {
  const ctx = makeCtx();
  fs.mkdirSync(path.join(ctx.home, '.cursor'), { recursive: true });
  const file = path.join(ctx.home, '.cursor', 'mcp.json');
  mcpreg.add(ctx, 'files', { command: 'npx', args: ['-y', 'server-filesystem'] });
  assert.strictEqual(mcpreg.setEnabled(ctx, 'files', 'cursor', true), 'applied');
  let cfg = read(file);
  assert.deepStrictEqual(cfg.mcpServers.files, { command: 'npx', args: ['-y', 'server-filesystem'], env: {} });
  assertPrivateMode(file);
  // A neighbour key survives an enable and a disable.
  mcpreg.add(ctx, 'other', { command: 'node', args: ['x.js'] });
  mcpreg.setEnabled(ctx, 'other', 'cursor', true);
  mcpreg.setEnabled(ctx, 'files', 'cursor', false);
  cfg = read(file);
  assert.strictEqual(cfg.mcpServers.files, undefined);
  assert.strictEqual(cfg.mcpServers.other.command, 'node');
});

test('kiro: never invents a config for an agent that is not on this machine', function () {
  const ctx = makeCtx();
  mcpreg.add(ctx, 'files', { command: 'node', args: ['s.js'] });
  assert.strictEqual(mcpreg.setEnabled(ctx, 'files', 'kiro', true), 'skipped-not-installed');
  assert.strictEqual(fs.existsSync(path.join(ctx.home, '.kiro', 'settings', 'mcp.json')), false);
  // Installed → the documented user-scope file is created.
  fs.mkdirSync(path.join(ctx.home, '.kiro'), { recursive: true });
  assert.strictEqual(mcpreg.setEnabled(ctx, 'files', 'kiro', true), 'applied');
  assert.strictEqual(read(path.join(ctx.home, '.kiro', 'settings', 'mcp.json')).mcpServers.files.command, 'node');
});

test('gemini: an existing settings.json survives with every unrelated key', function () {
  const ctx = makeCtx();
  const file = write(path.join(ctx.home, '.gemini', 'settings.json'), {
    theme: 'Default',
    security: { auth: { selectedType: 'oauth-personal' } },
    mcpServers: { existing: { command: 'uvx', args: ['x'] } },
  });
  mcpreg.add(ctx, 'keyflip', { command: '/usr/bin/node', args: ['/opt/keyflip/bin/keyflip.js', 'mcp'] });
  assert.strictEqual(mcpreg.setEnabled(ctx, 'keyflip', 'gemini', true), 'applied');
  const cfg = read(file);
  assert.strictEqual(cfg.theme, 'Default');
  assert.strictEqual(cfg.security.auth.selectedType, 'oauth-personal');
  assert.strictEqual(cfg.mcpServers.existing.command, 'uvx');
  assert.deepStrictEqual(cfg.mcpServers.keyflip.args, ['/opt/keyflip/bin/keyflip.js', 'mcp']);
});

test('opencode: servers go under mcp in its own shape, and a JSONC file is reported, never rewritten', function () {
  const ctx = makeCtx();
  const dir = path.join(ctx.home, '.config', 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  const file = write(path.join(dir, 'opencode.json'), { $schema: 'https://opencode.ai/config.json', model: 'x' });
  mcpreg.add(ctx, 'files', { command: 'npx', args: ['-y', 'server-filesystem'] });
  assert.strictEqual(mcpreg.setEnabled(ctx, 'files', 'opencode', true), 'applied');
  let cfg = read(file);
  assert.strictEqual(cfg.model, 'x');
  assert.deepStrictEqual(cfg.mcp.files, { type: 'local', command: ['npx', '-y', 'server-filesystem'] });
  mcpreg.setEnabled(ctx, 'files', 'opencode', false);
  cfg = read(file);
  assert.deepStrictEqual(cfg.mcp, {});

  // Same machine, only opencode.jsonc: keyflip cannot rewrite it without dropping comments.
  const ctx2 = makeCtx();
  const dir2 = path.join(ctx2.home, '.config', 'opencode');
  fs.mkdirSync(dir2, { recursive: true });
  const jsonc = path.join(dir2, 'opencode.jsonc');
  fs.writeFileSync(jsonc, '{\n  // mine\n  "model": "x"\n}\n');
  mcpreg.add(ctx2, 'files', { command: 'npx', args: ['-y', 'x'] });
  assert.strictEqual(mcpreg.setEnabled(ctx2, 'files', 'opencode', true), 'skipped-jsonc');
  assert.strictEqual(fs.readFileSync(jsonc, 'utf8'), '{\n  // mine\n  "model": "x"\n}\n');
  assert.strictEqual(fs.existsSync(path.join(dir2, 'opencode.json')), false);
});

test('devin/windsurf: only an EXISTING file is edited, whichever version wrote it', function () {
  const ctx = makeCtx();
  fs.mkdirSync(path.join(ctx.home, '.windsurf'), { recursive: true });
  mcpreg.add(ctx, 'files', { command: 'node', args: ['s.js'] });
  assert.strictEqual(mcpreg.setEnabled(ctx, 'files', 'devin', true), 'skipped-no-config');
  const legacy = write(path.join(ctx.home, '.codeium', 'windsurf', 'mcp_config.json'), { mcpServers: {} });
  assert.strictEqual(mcpreg.setEnabled(ctx, 'files', 'devin', true), 'applied');
  assert.strictEqual(read(legacy).mcpServers.files.command, 'node');
});

test('a corrupt foreign config aborts instead of being overwritten', function () {
  const ctx = makeCtx();
  const dir = path.join(ctx.home, '.cursor');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, '{ not json');
  mcpreg.add(ctx, 'files', { command: 'node', args: ['s.js'] });
  assert.throws(function () {
    mcpreg.setEnabled(ctx, 'files', 'cursor', true);
  }, /not valid JSON/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ not json');
});

test('an unknown surface is refused by name, and the error lists what is known', function () {
  const ctx = makeCtx();
  mcpreg.add(ctx, 'files', { command: 'node', args: ['s.js'] });
  assert.throws(function () {
    mcpreg.setEnabled(ctx, 'files', 'claude-web', true);
  }, /unknown MCP surface.*cursor/);
});

test('surfaces(): ready rows name their servers; unwritable agents are listed WITH a reason', function () {
  const ctx = makeCtx();
  const cursor = write(path.join(ctx.home, '.cursor', 'mcp.json'), { mcpServers: { mine: { command: 'node' } } });
  assert.ok(cursor);
  mcpreg.add(ctx, 'mine', { command: 'node', args: [] });
  const rows = mcpreg.surfaces(ctx);
  const byId = {};
  rows.forEach(function (r) {
    byId[r.id] = r;
  });
  assert.strictEqual(byId.cursor.state, 'ready');
  assert.deepStrictEqual(byId.cursor.servers, ['mine']);
  assert.strictEqual(byId.kiro.state, 'not-installed');
  assert.strictEqual(byId.opencode.state, 'not-installed');
  // Installed but with no config yet is its own state — the file does not exist, so it must not
  // be reported as if it did.
  fs.mkdirSync(path.join(ctx.home, '.kiro'), { recursive: true });
  assert.strictEqual(mcpreg.surfaces(ctx).filter((r) => r.id === 'kiro')[0].state, 'will-create');
  mcpreg.setEnabled(ctx, 'mine', 'kiro', true);
  assert.strictEqual(mcpreg.surfaces(ctx).filter((r) => r.id === 'kiro')[0].state, 'ready');
  ['codex', 'continue', 'copilot'].forEach(function (id) {
    assert.strictEqual(byId[id].supported, false);
    assert.ok(byId[id].reason && byId[id].reason.length > 10, id + ' must say why');
  });
});

test('remove() unhooks every surface it was projected into', function () {
  const ctx = makeCtx();
  const cur = write(path.join(ctx.home, '.cursor', 'mcp.json'), { mcpServers: {} });
  const gem = write(path.join(ctx.home, '.gemini', 'settings.json'), { mcpServers: {} });
  mcpreg.add(ctx, 'gone', { command: 'node', args: ['s.js'] });
  mcpreg.setEnabled(ctx, 'gone', 'cursor', true);
  mcpreg.setEnabled(ctx, 'gone', 'gemini', true);
  mcpreg.remove(ctx, 'gone');
  assert.strictEqual(read(cur).mcpServers.gone, undefined);
  assert.strictEqual(read(gem).mcpServers.gone, undefined);
  assert.strictEqual(mcpreg.list(ctx).length, 0);
});

test('importLive() reads mcpServers and opencode’s mcp shape into one registry', function () {
  const ctx = makeCtx();
  write(path.join(ctx.home, '.cursor', 'mcp.json'), {
    mcpServers: { ctx7: { command: 'npx', args: ['-y', 'ctx7'] } },
  });
  write(path.join(ctx.home, '.config', 'opencode', 'opencode.json'), {
    mcp: { files: { type: 'local', command: ['node', 'files.js'], environment: { ROOT: '/tmp' } } },
  });
  const got = mcpreg.importLive(ctx);
  assert.deepStrictEqual(got.sort(), ['ctx7', 'files']);
  const reg = mcpreg.readReg(ctx);
  assert.deepStrictEqual(reg.files, { command: 'node', args: ['files.js'], env: { ROOT: '/tmp' } });
  assert.strictEqual(reg.ctx7.command, 'npx');
});

test('command-code: creates ~/.commandcode/mcp.json only when the tool is installed, 0600', function () {
  const ctx = makeCtx();
  mcpreg.add(ctx, 'files', { command: 'node', args: ['s.js'] });
  assert.strictEqual(mcpreg.setEnabled(ctx, 'files', 'command-code', true), 'skipped-not-installed');
  assert.strictEqual(fs.existsSync(path.join(ctx.home, '.commandcode', 'mcp.json')), false);
  fs.mkdirSync(path.join(ctx.home, '.commandcode'), { recursive: true });
  assert.strictEqual(mcpreg.surfaces(ctx).filter((r) => r.id === 'command-code')[0].state, 'will-create');
  assert.strictEqual(mcpreg.setEnabled(ctx, 'files', 'command-code', true), 'applied');
  const file = path.join(ctx.home, '.commandcode', 'mcp.json');
  assert.deepStrictEqual(read(file).mcpServers.files, { command: 'node', args: ['s.js'], env: {} });
  assertPrivateMode(file);
  assert.strictEqual(mcpreg.surfaces(ctx).filter((r) => r.id === 'command-code')[0].state, 'ready');
  mcpreg.setEnabled(ctx, 'files', 'command-code', false);
  assert.deepStrictEqual(read(file).mcpServers, {});
});

test('command-code: an unparseable mcp.json aborts instead of being replaced by {}', function () {
  const ctx = makeCtx();
  const dir = path.join(ctx.home, '.commandcode');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, '{ broken');
  mcpreg.add(ctx, 'files', { command: 'node', args: ['s.js'] });
  assert.throws(function () {
    mcpreg.setEnabled(ctx, 'files', 'command-code', true);
  }, /not valid JSON/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ broken');
});
