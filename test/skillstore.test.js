import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as skillstore from '../src/skillstore.js';
import { makeCtx } from './helpers.js';
import _os from 'os';
import _child_process from 'child_process';

function makeSkillDir(base, name, body) {
  const d = path.join(base, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), body || ('---\nname: ' + name + '\n---\nhi'));
  return d;
}

test('add from a local directory installs every SKILL.md dir + records a manifest', async function () {
  const ctx = makeCtx();
  const src = path.join(ctx.home, 'pack');
  makeSkillDir(src, 'alpha');
  makeSkillDir(src, 'beta');
  const r = await ctx && await skillstore.add(ctx, src, {});
  assert.strictEqual(r.length, 2);
  assert.ok(fs.existsSync(path.join(ctx.home, '.claude', 'skills', 'alpha', 'SKILL.md')));
  const list = skillstore.list(ctx);
  assert.deepStrictEqual(list.map(function (s) { return s.name; }).sort(), ['alpha', 'beta']);
});

test('findSkillDirs locates a skill at the archive root and nested', function () {
  const base = path.join(makeCtx().home, 'x');
  makeSkillDir(base, 'root-skill');
  makeSkillDir(path.join(base, 'nested'), 'deep');
  const dirs = skillstore.findSkillDirs(base);
  assert.strictEqual(dirs.length, 2);
});

test('parseGithub handles owner/repo, refs and subdirs', function () {
  assert.deepStrictEqual(skillstore.parseGithub('anthropics/skills'), { owner: 'anthropics', repo: 'skills', ref: 'HEAD', subdir: '' });
  const g = skillstore.parseGithub('owner/repo@v1/path/to/skill');
  assert.strictEqual(g.ref, 'v1'); assert.strictEqual(g.subdir, 'path/to/skill');
  assert.strictEqual(skillstore.parseGithub('not a repo'), null);
});

test('remove only removes keyflip-installed skills (never the user\'s own)', async function () {
  const ctx = makeCtx();
  // a user-owned skill keyflip did NOT install
  const own = path.join(ctx.home, '.claude', 'skills', 'mine');
  fs.mkdirSync(own, { recursive: true }); fs.writeFileSync(path.join(own, 'SKILL.md'), 'x');
  assert.throws(function () { skillstore.remove(ctx, 'mine'); }, /not installed by keyflip/);
  assert.ok(fs.existsSync(own)); // untouched

  const src = path.join(ctx.home, 'pack'); makeSkillDir(src, 'installed');
  await skillstore.add(ctx, src, {});
  skillstore.remove(ctx, 'installed');
  assert.strictEqual(fs.existsSync(path.join(ctx.home, '.claude', 'skills', 'installed')), false);
});

test('add refuses to clobber a pre-existing non-keyflip skill without --force', async function () {
  const ctx = makeCtx();
  const clash = path.join(ctx.home, '.claude', 'skills', 'alpha');
  fs.mkdirSync(clash, { recursive: true }); fs.writeFileSync(path.join(clash, 'SKILL.md'), 'USER');
  const src = path.join(ctx.home, 'pack'); makeSkillDir(src, 'alpha');
  await assert.rejects(function () { return skillstore.add(ctx, src, {}); }, /already exists/);
  assert.strictEqual(fs.readFileSync(path.join(clash, 'SKILL.md'), 'utf8'), 'USER'); // preserved
});

test('add from a GitHub tarball (mocked fetch) installs the skill', async function () {
  const ctx = makeCtx();
  // build a real .tar.gz that codeload-style wraps in repo-ref/
  const staging = fs.mkdtempSync(path.join(_os.tmpdir(), 'kf-stage-'));
  const inner = path.join(staging, 'skills-main');
  makeSkillDir(inner, 'fromgh');
  const tgz = path.join(staging, 'repo.tar.gz');
  _child_process.execFileSync('tar', ['-czf', tgz, '-C', staging, 'skills-main']);
  const bytes = fs.readFileSync(tgz);
  const fetchMock = async function (url) {
    assert.match(url, /codeload\.github\.com\/owner\/skills\/tar\.gz\/HEAD/);
    return { ok: true, status: 200, arrayBuffer: async function () { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
  };
  const r = await skillstore.add(ctx, 'owner/skills', { fetch: fetchMock });
  assert.ok(r.some(function (s) { return s.name === 'fromgh'; }));
  assert.ok(fs.existsSync(path.join(ctx.home, '.claude', 'skills', 'fromgh', 'SKILL.md')));
});

test('a GitHub subdir with ../ is rejected (path traversal)', async function () {
  const ctx = makeCtx();
  const staging = fs.mkdtempSync(path.join(_os.tmpdir(), 'kf-trav-'));
  const inner = path.join(staging, 'repo-main'); fs.mkdirSync(inner, { recursive: true });
  const tgz = path.join(staging, 'r.tar.gz');
  _child_process.execFileSync('tar', ['-czf', tgz, '-C', staging, 'repo-main']);
  const bytes = fs.readFileSync(tgz);
  const fetchMock = async function () { return { ok: true, status: 200, arrayBuffer: async function () { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } }; };
  await assert.rejects(function () { return skillstore.add(ctx, 'owner/repo/../../../../etc', { fetch: fetchMock }); }, /traversal/);
});
