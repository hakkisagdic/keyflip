import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as sessions from '../src/sessions.js';
import { makeCtx } from './helpers.js';

function seedSession(ctx, project, id, cwd, firstUserText, mtimeMs) {
  const dir = path.join(ctx.home, '.claude', 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.jsonl');
  const lines = [
    JSON.stringify({ type: 'queue-operation', sessionId: id, timestamp: '2026-07-01T00:00:00Z' }),
    JSON.stringify({ type: 'user', sessionId: id, cwd: cwd, message: { role: 'user', content: [{ type: 'text', text: firstUserText }] } }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  if (mtimeMs) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

test('list finds sessions across projects, newest first, with cwd + preview', function () {
  const ctx = makeCtx();
  seedSession(ctx, '-proj-a', '11111111-aaaa', '/proj/a', 'help me with auth', Date.now() - 100000);
  seedSession(ctx, '-proj-b', '22222222-bbbb', '/proj/b', 'fix the parser', Date.now());
  const rows = sessions.list(ctx, {});
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].sessionId, '22222222-bbbb'); // newest first
  assert.strictEqual(rows[0].cwd, '/proj/b');
  assert.match(rows[0].preview, /fix the parser/);
});

test('--search matches preview, cwd, id, and deep content', function () {
  const ctx = makeCtx();
  seedSession(ctx, '-p', 'aaaa1111', '/work/x', 'implement OAuth flow');
  seedSession(ctx, '-p', 'bbbb2222', '/work/y', 'unrelated');
  assert.strictEqual(sessions.list(ctx, { search: 'oauth' }).length, 1);
  assert.strictEqual(sessions.list(ctx, { search: '/work/y' }).length, 1);
  assert.strictEqual(sessions.list(ctx, { search: 'aaaa1111' }).length, 1);
  assert.strictEqual(sessions.list(ctx, { search: 'nomatch' }).length, 0);
});

test('--cwd filters to a directory', function () {
  const ctx = makeCtx();
  seedSession(ctx, '-a', 's1', '/here', 'x');
  seedSession(ctx, '-b', 's2', '/there', 'y');
  const rows = sessions.list(ctx, { cwd: '/here' });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].sessionId, 's1');
});

test('find resolves a unique id prefix and errors on ambiguity', function () {
  const ctx = makeCtx();
  seedSession(ctx, '-p', 'abc111', '/x', 'a');
  seedSession(ctx, '-p', 'abc222', '/x', 'b');
  seedSession(ctx, '-p', 'zzz999', '/x', 'c');
  assert.strictEqual(sessions.find(ctx, 'zzz999').sessionId, 'zzz999');
  assert.strictEqual(sessions.find(ctx, 'zzz').sessionId, 'zzz999');
  assert.throws(function () { sessions.find(ctx, 'abc'); }, /ambiguous/);
  assert.strictEqual(sessions.find(ctx, 'nope'), null);
});

test('resumeCommand builds `claude --resume <id>` in the original cwd', function () {
  const ctx = makeCtx();
  seedSession(ctx, '-p', 'sess-1', '/my/dir', 'go');
  const rc = sessions.resumeCommand(sessions.find(ctx, 'sess-1'));
  assert.deepStrictEqual(rc, { cwd: '/my/dir', command: 'claude', args: ['--resume', 'sess-1'] });
});

test('filenames that are not real session ids are ignored (argv-injection guard)', function () {
  const ctx = makeCtx();
  const dir = path.join(ctx.home, '.claude', 'projects', '-p');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '--inject.jsonl'), JSON.stringify({ type: 'user', cwd: '/x', message: { role: 'user', content: [{ type: 'text', text: 'a' }] } }) + '\n');
  fs.writeFileSync(path.join(dir, 'good-1234-uuid.jsonl'), JSON.stringify({ type: 'user', cwd: '/x', message: { role: 'user', content: [{ type: 'text', text: 'b' }] } }) + '\n');
  const ids = sessions.list(ctx, {}).map(function (r) { return r.sessionId; });
  assert.ok(ids.indexOf('good-1234-uuid') !== -1);
  assert.strictEqual(ids.indexOf('--inject'), -1); // dangerous name skipped
});

test('rebindConfigPaths rewrites the old path across .claude.json, settings and commands, with backups', function () {
  const ctx = makeCtx();
  const oldCwd = '/Users/x/Documents/GitHub/proj';
  const newCwd = '/Users/x/Projects/GitHub/proj';
  // .claude.json: projects map KEY, githubRepoPaths, and an stdio MCP server pointing into the folder
  fs.writeFileSync(ctx.claudeConfigPath, JSON.stringify({
    projects: { [oldCwd]: { allowedTools: [] }, '/other': {} },
    githubRepoPaths: { 'me/proj': [oldCwd] },
    mcpServers: { local: { command: oldCwd + '/tools/bin/mcp', args: ['-c', oldCwd + '/tools/c.yaml'] } },
  }, null, 2));
  // settings.json permission rule + a slash-command script
  const claudeDir = path.join(ctx.home, '.claude');
  fs.mkdirSync(path.join(claudeDir, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(bash ' + oldCwd + '/deploy.sh *)'] } }, null, 2));
  fs.writeFileSync(path.join(claudeDir, 'commands', 'ship.md'), 'run: cd ' + oldCwd + '/apps/mobile && ./release.sh\n');

  const res = sessions.rebindConfigPaths(ctx, oldCwd, newCwd);
  assert.strictEqual(res.patched, 3, 'three config files rewritten');
  assert.ok(res.backedUp >= 3, 'each touched file backed up');

  const cfg = JSON.parse(fs.readFileSync(ctx.claudeConfigPath, 'utf8'));
  assert.ok(cfg.projects[newCwd], 'projects map KEY moved to new path');
  assert.ok(!cfg.projects[oldCwd], 'old projects key gone');
  assert.deepStrictEqual(cfg.githubRepoPaths['me/proj'], [newCwd]);
  assert.strictEqual(cfg.mcpServers.local.command, newCwd + '/tools/bin/mcp', 'MCP binary path rewritten');
  assert.ok(cfg.mcpServers.local.args[1].startsWith(newCwd), 'MCP arg path rewritten');
  assert.ok(fs.existsSync(ctx.claudeConfigPath + '.keyflip-bak'), 'backup exists');
  assert.ok(fs.readFileSync(path.join(claudeDir, 'commands', 'ship.md'), 'utf8').indexOf(newCwd) !== -1);
  assert.ok(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8').indexOf(oldCwd) === -1);
});

test('rebindConfigPaths honors dryRun and extraFiles, and no-ops when old===new', function () {
  const ctx = makeCtx();
  const oldCwd = '/a/b/proj', newCwd = '/c/d/proj';
  fs.writeFileSync(ctx.claudeConfigPath, JSON.stringify({ projects: { [oldCwd]: {} } }));
  const extra = path.join(ctx.home, 'wiki.config');
  fs.writeFileSync(extra, 'VAULT="' + oldCwd + '/docs"\n');

  // dryRun: reports the hit but writes nothing (no backup, file unchanged)
  const dry = sessions.rebindConfigPaths(ctx, oldCwd, newCwd, { dryRun: true, extraFiles: [extra] });
  assert.ok(dry.patched >= 2, 'reports both files');
  assert.strictEqual(dry.backedUp, 0, 'dryRun writes nothing');
  assert.ok(fs.readFileSync(extra, 'utf8').indexOf(oldCwd) !== -1, 'extra file untouched in dryRun');
  assert.ok(!fs.existsSync(extra + '.keyflip-bak'));

  // real run with extraFiles rewrites the app-specific config too
  const res = sessions.rebindConfigPaths(ctx, oldCwd, newCwd, { extraFiles: [extra] });
  assert.ok(res.patched >= 2);
  assert.ok(fs.readFileSync(extra, 'utf8').indexOf(newCwd) !== -1, 'extra file rewritten');

  // no-op when paths equal
  assert.strictEqual(sessions.rebindConfigPaths(ctx, newCwd, newCwd).patched, 0);
});
