// Cross-agent skill distribution: detection, fan-out, per-target hashes, sync that never clobbers a
// user's edit, credential refusal, and a remove that only touches what keyflip wrote.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { makeCtx } from './helpers.js';
import _child_process from 'child_process';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');
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

// ---- adversarial review (TODO §B): a skill is code the agent will run, so the tree it ships
// is inspected whole — hidden files included, links included, and the manifest is not trusted.

test('a credential hidden in .env is refused, not overlooked', function () {
  const ctx = makeCtx();
  have(ctx, '.claude');
  const root = pkgWith('hidden');
  fs.writeFileSync(path.join(root, 'hidden', '.env'), 'ANTHROPIC_API_KEY=sk-ant-api03-' + 'A'.repeat(24) + '\n');
  assert.throws(function () {
    return skillsync.installResolved(ctx, root, 'dir:' + root, {});
  }, /refusing to install 'hidden'.*anthropic-api-key/);
  assert.ok(!fs.existsSync(path.join(ctx.home, '.claude', 'skills', 'hidden')));
});

test('a credential whose value has no known shape is refused too (key name + entropy)', function () {
  const ctx = makeCtx();
  have(ctx, '.claude');
  const root = pkgWith('envfile');
  fs.writeFileSync(
    path.join(root, 'envfile', '.env'),
    'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY\n',
  );
  assert.throws(function () {
    return skillsync.installResolved(ctx, root, 'dir:' + root, {});
  }, /refusing to install 'envfile'.*credential-value:AWS_SECRET_ACCESS_KEY/);
  assert.ok(!fs.existsSync(path.join(ctx.home, '.claude', 'skills', 'envfile')));
});

test('a placeholder value is not a credential (a skill may document one)', function () {
  const ctx = makeCtx();
  have(ctx, '.claude');
  const root = pkgWith('doc');
  fs.writeFileSync(
    path.join(root, 'doc', '.env.example'),
    'ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}\nAWS_SECRET_ACCESS_KEY=your-key-here\n',
  );
  const r = skillsync.installResolved(ctx, root, 'dir:' + root, {});
  assert.strictEqual(r.installed.length, 1);
});

test('a skill that links outside itself is refused (it would point the agent at ~/.ssh)', function () {
  const ctx = makeCtx();
  have(ctx, '.claude');
  const outside = path.join(ctx.home, 'secret.txt');
  fs.writeFileSync(outside, 'my private key');
  const root = pkgWith('linky');
  fs.symlinkSync(outside, path.join(root, 'linky', 'notes.md'));
  assert.throws(function () {
    return skillsync.installResolved(ctx, root, 'dir:' + root, {});
  }, /refusing to install 'linky'.*links outside the skill/);
  assert.ok(!fs.existsSync(path.join(ctx.home, '.claude', 'skills', 'linky')));
});

test('a link inside a skill is refused — a skill must be self-contained', async function () {
  const ctx = makeCtx();
  have(ctx, '.claude');
  const root = pkgWith('inner');
  fs.writeFileSync(path.join(root, 'inner', 'notes.md'), 'real notes');
  fs.symlinkSync('./notes.md', path.join(root, 'inner', 'ref.md'));
  assert.throws(function () {
    return skillsync.installResolved(ctx, root, 'dir:' + root, {});
  }, /refusing to install 'inner'.*is a link/);
  assert.ok(!fs.existsSync(path.join(ctx.home, '.claude', 'skills', 'inner')));
});

test('an edit inside a HIDDEN file is detected — the hash covers what the agent reads', async function () {
  const ctx = makeCtx();
  have(ctx, '.claude');
  const root = pkgWith('demo');
  fs.mkdirSync(path.join(root, 'demo', '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'demo', '.claude', 'settings.json'), '{"a":1}');
  await skillsync.add(ctx, root, {});
  assert.strictEqual(skillsync.list(ctx)[0].targets[0].state, 'ok');
  fs.writeFileSync(path.join(ctx.home, '.claude', 'skills', 'demo', '.claude', 'settings.json'), '{"a":2}');
  assert.strictEqual(skillsync.list(ctx)[0].targets[0].state, 'edited');
});

test('a poisoned manifest cannot make sync write outside the agent skill dirs', async function () {
  const ctx = makeCtx();
  have(ctx, '.claude');
  const victim = path.join(ctx.home, '.ssh');
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'id_rsa'), 'PRIVATE KEY');
  const root = pkgWith('demo', 'v2');
  // The manifest claims the skill lives in ~/.ssh — keyflip never writes there.
  fs.writeFileSync(
    skillsync.manifestPath(ctx),
    JSON.stringify({
      demo: {
        source: 'dir:' + root,
        installedAt: 't',
        mode: 'copy',
        sha256: skillsync.fingerprint(path.join(root, 'demo')),
        fp: 2,
        targets: { evil: { dir: '.ssh', sha256: 'x', mode: 'copy', fp: 2 } },
      },
    }),
  );
  const rep = await skillsync.sync(ctx, {});
  assert.strictEqual(rep[0].targets[0].action, 'skipped-unknown-target');
  assert.strictEqual(fs.readFileSync(path.join(victim, 'id_rsa'), 'utf8'), 'PRIVATE KEY');
  assert.ok(!fs.existsSync(path.join(victim, 'demo')));
});

test('a poisoned manifest cannot make remove delete outside the agent skill dirs', function () {
  const ctx = makeCtx();
  have(ctx, '.claude');
  const victim = path.join(ctx.home, '.ssh');
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'id_rsa'), 'PRIVATE KEY');
  const root = pkgWith('demo');
  fs.writeFileSync(
    skillsync.manifestPath(ctx),
    JSON.stringify({
      demo: {
        source: 'dir:' + root,
        installedAt: 't',
        mode: 'copy',
        sha256: 'x',
        targets: { evil: { dir: '.ssh', sha256: 'x', mode: 'copy' } },
      },
    }),
  );
  const r = skillsync.remove(ctx, 'demo');
  assert.deepStrictEqual(r.removed, []);
  assert.match(r.skipped[0], /unknown target dir \.ssh/);
  assert.strictEqual(fs.readFileSync(path.join(victim, 'id_rsa'), 'utf8'), 'PRIVATE KEY');
  assert.ok(!fs.existsSync(path.join(victim, 'demo')));
});

test('a manifest name that is not a plain skill name is refused', function () {
  const ctx = makeCtx();
  have(ctx, '.claude');
  const root = pkgWith('demo');
  fs.writeFileSync(
    skillsync.manifestPath(ctx),
    JSON.stringify({
      '../../etc': {
        source: 'dir:' + root,
        installedAt: 't',
        mode: 'copy',
        sha256: 'x',
        targets: { claude: { dir: '.claude/skills', sha256: 'x', mode: 'copy' } },
      },
    }),
  );
  assert.throws(function () {
    return skillsync.remove(ctx, '../../etc');
  }, /not a plain skill name/);
  assert.deepStrictEqual(skillsync.list(ctx)[0].targets[0].state, 'unsafe-name');
});

test('add writes nothing when the plan is not approved', async function () {
  const ctx = makeCtx();
  have(ctx, '.claude');
  const root = pkgWith('demo');
  const r = await skillsync.add(ctx, root, {
    approve: async function () {
      return false;
    },
  });
  assert.deepStrictEqual(r.installed, []);
  assert.strictEqual(r.skipped[0].reason, 'not approved');
  assert.ok(!fs.existsSync(path.join(ctx.home, '.claude', 'skills', 'demo')));
});

test('the CLI asks before it writes into an agent skill dir (--yes is the non-interactive way)', function () {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-skill-cli-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const src = pkgWith('demo');
  const env = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    KEYFLIP_CONFIG_DIR: path.join(home, '.config', 'keyflip'),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    KEYFLIP_TEST_CLAUDE: 'stopped',
  };
  const no = _child_process.spawnSync(process.execPath, [BIN, 'skill', 'add', src], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, env),
  });
  assert.strictEqual(no.status, 1);
  assert.match(no.stderr, /--yes/);
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'skills', 'demo')));

  const yes = _child_process.spawnSync(process.execPath, [BIN, 'skill', 'add', src, '--yes'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, env),
  });
  assert.strictEqual(yes.status, 0, yes.stderr);
  assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'demo', 'SKILL.md')));
});
