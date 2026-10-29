// Cross-agent skill distribution: detection, fan-out, per-target hashes, sync that never clobbers a
// user's edit, credential refusal, and a remove that only touches what keyflip wrote.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { makeCtx } from './helpers.js';
import * as skillsync from '../src/skillsync.js';

function pkgWith(name, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-pkg-'));
  const d = path.join(root, name);
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: ' + name + '\n---\n' + (body || 'Drive keyflip.') + '\n');
  return root;
}
function have(ctx, tool) {
  fs.mkdirSync(path.join(ctx.home, tool), { recursive: true });
}
function read(p) {
  return fs.readFileSync(p, 'utf8');
}

test('only the tools whose home exists are targets; an unknown agent name is an error', async function () {
  const ctx = makeCtx();
  have(ctx, '.claude');
  have(ctx, '.cursor');
  assert.deepStrictEqual(
    skillsync
      .detectedTargets(ctx)
      .map(function (t) {
        return t.dir;
      })
      .sort(),
    ['.claude/skills', '.cursor/skills'],
  );
  // Naming an agent bypasses detection (the tool may live elsewhere), but a typo must not pass.
  const sel = skillsync.selectTargets(ctx, ['codex']);
  assert.deepStrictEqual(sel.unknown, []);
  assert.strictEqual(sel.targets[0].dir, '.agents/skills');
  const root = pkgWith('demo');
  assert.throws(function () {
    return skillsync.installResolved(ctx, root, 'dir:' + root, { agents: ['cursr'] });
  }, /unknown agent\(s\): cursr/);
});

test('add installs one skill into every detected agent and records a hash per target', async function () {
  const ctx = makeCtx();
  have(ctx, '.claude');
  have(ctx, '.cursor');
  const root = pkgWith('demo');
  const r = await skillsync.add(ctx, root, {});
  assert.strictEqual(r.installed.length, 1);
  assert.deepStrictEqual(
    r.installed[0].targets
      .map(function (t) {
        return t.dir;
      })
      .sort(),
    ['.claude/skills', '.cursor/skills'],
  );
  ['.claude', '.cursor'].forEach(function (tool) {
    assert.ok(fs.existsSync(path.join(ctx.home, tool, 'skills', 'demo', 'SKILL.md')));
  });
  const m = JSON.parse(read(skillsync.manifestPath(ctx)));
  assert.ok(m.demo.targets.claude.sha256);
  assert.strictEqual(m.demo.targets.claude.sha256, m.demo.targets.cursor.sha256);
  const listed = skillsync.list(ctx)[0];
  assert.strictEqual(listed.name, 'demo');
  assert.deepStrictEqual(
    listed.targets.map(function (t) {
      return t.state;
    }),
    ['ok', 'ok'],
  );
});

test('sync refreshes an untouched copy, leaves an edited one alone, and says so', async function () {
  const ctx = makeCtx();
  have(ctx, '.claude');
  have(ctx, '.cursor');
  const root = pkgWith('demo', 'v1');
  await skillsync.add(ctx, root, {});
  fs.writeFileSync(path.join(ctx.home, '.cursor', 'skills', 'demo', 'SKILL.md'), 'edited by me');
  fs.writeFileSync(path.join(root, 'demo', 'SKILL.md'), '---\nname: demo\n---\nv2\n');

  const rep = await skillsync.sync(ctx, {});
  assert.strictEqual(rep[0].name, 'demo');
  assert.strictEqual(rep[0].status, 'updated');
  const byId = {};
  rep[0].targets.forEach(function (t) {
    byId[t.id] = t.action;
  });
  assert.strictEqual(byId.claude, 'updated');
  assert.strictEqual(byId.cursor, 'left-edited');
  assert.match(read(path.join(ctx.home, '.claude', 'skills', 'demo', 'SKILL.md')), /v2/);
  assert.strictEqual(read(path.join(ctx.home, '.cursor', 'skills', 'demo', 'SKILL.md')), 'edited by me');

  // Second pass: nothing left to do, and the edit is still respected.
  const again = await skillsync.sync(ctx, {});
  assert.strictEqual(again[0].status, 'current');
  const listed = skillsync.list(ctx)[0];
  const states = {};
  listed.targets.forEach(function (t) {
    states[t.id] = t.state;
  });
  assert.strictEqual(states.claude, 'ok');
  assert.strictEqual(states.cursor, 'edited');
});

test('a skill carrying a credential is refused before anything is written', function () {
  const ctx = makeCtx();
  have(ctx, '.claude');
  const root = pkgWith('leaky', 'ANTHROPIC_API_KEY=sk-ant-api03-' + 'A'.repeat(24));
  assert.throws(function () {
    return skillsync.installResolved(ctx, root, 'dir:' + root, {});
  }, /refusing to install 'leaky'.*anthropic-api-key/);
  assert.ok(!fs.existsSync(path.join(ctx.home, '.claude', 'skills', 'leaky')));
});

test('an existing skill keyflip did not install needs --force', function () {
  const ctx = makeCtx();
  have(ctx, '.claude');
  const dest = path.join(ctx.home, '.claude', 'skills', 'demo');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'SKILL.md'), 'mine');
  const root = pkgWith('demo');
  assert.throws(function () {
    return skillsync.installResolved(ctx, root, 'dir:' + root, {});
  }, /already exists in \.claude\/skills/);
  assert.strictEqual(read(path.join(dest, 'SKILL.md')), 'mine');
  skillsync.installResolved(ctx, root, 'dir:' + root, { force: true });
  assert.match(read(path.join(dest, 'SKILL.md')), /name: demo/);
});

test('dry run reports the plan and writes nothing', function () {
  const ctx = makeCtx();
  have(ctx, '.claude');
  const root = pkgWith('demo');
  const r = skillsync.installResolved(ctx, root, 'dir:' + root, { dryRun: true });
  assert.strictEqual(r.installed[0].targets[0].dryRun, true);
  assert.ok(!fs.existsSync(path.join(ctx.home, '.claude', 'skills', 'demo')));
  assert.ok(!fs.existsSync(skillsync.manifestPath(ctx)));
});

test('remove deletes only what keyflip recorded, per agent, never the user’s own skill', async function () {
  const ctx = makeCtx();
  have(ctx, '.claude');
  have(ctx, '.cursor');
  const root = pkgWith('demo');
  await skillsync.add(ctx, root, {});
  const mine = path.join(ctx.home, '.claude', 'skills', 'mine');
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, 'SKILL.md'), 'mine');

  const one = skillsync.remove(ctx, 'demo', { agents: ['cursor'] });
  assert.deepStrictEqual(one.removed, ['cursor']);
  assert.ok(!fs.existsSync(path.join(ctx.home, '.cursor', 'skills', 'demo')));
  assert.ok(fs.existsSync(path.join(ctx.home, '.claude', 'skills', 'demo', 'SKILL.md')));

  assert.throws(function () {
    return skillsync.remove(ctx, 'mine');
  }, /not installed by keyflip/);
  const rest = skillsync.remove(ctx, 'demo');
  assert.deepStrictEqual(rest.removed, ['claude']);
  assert.ok(!fs.existsSync(path.join(ctx.home, '.claude', 'skills', 'demo')));
  assert.ok(fs.existsSync(path.join(mine, 'SKILL.md')));
  assert.deepStrictEqual(skillsync.list(ctx), []);
});

test('a Claude-only manifest from an older keyflip still lists and removes', function () {
  const ctx = makeCtx();
  const dir = path.join(ctx.home, '.claude', 'skills', 'keyflip');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: keyflip\n---\nold\n');
  fs.writeFileSync(
    skillsync.manifestPath(ctx),
    JSON.stringify({
      keyflip: { source: 'dir:/x', installedAt: 't', mode: 'copy', sha256: skillsync.fingerprint(dir) },
    }),
  );
  const listed = skillsync.list(ctx)[0];
  assert.strictEqual(listed.targets[0].id, 'claude');
  assert.strictEqual(listed.targets[0].dir, '.claude/skills');
  assert.strictEqual(listed.targets[0].state, 'ok');
  assert.deepStrictEqual(skillsync.remove(ctx, 'keyflip').removed, ['claude']);
});

test('install-skill fan-out skips ~/.claude/skills and writes the bundled skill to other agents', function () {
  const ctx = makeCtx();
  have(ctx, '.claude');
  assert.strictEqual(skillsync.installBundled(ctx, {}).installed.length, 0); // no agent besides Claude
  have(ctx, '.kiro');
  const r = skillsync.installBundled(ctx, {});
  assert.strictEqual(r.installed[0].name, 'keyflip');
  assert.deepStrictEqual(
    r.installed[0].targets.map(function (t) {
      return t.dir;
    }),
    ['.kiro/skills'],
  );
  assert.ok(fs.existsSync(path.join(ctx.home, '.kiro', 'skills', 'keyflip', 'SKILL.md')));
  // Claude stays with skill.js's install (backup + --check), so this must not create it.
  assert.ok(!fs.existsSync(path.join(ctx.home, '.claude', 'skills', 'keyflip')));
});
