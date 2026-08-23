// Skills marketplace: install ARBITRARY skills (not just keyflip's own) into
// ~/.claude/skills from a GitHub repo, a local directory, or a .tar.gz/.zip
// archive. A manifest records what keyflip installed so `remove` never touches
// the user's own skills. Archive extraction is isolated + path-traversal-guarded.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeJsonStable } from './fsutil.js';
import { run } from './exec.js';

function skillsDir(ctx) { return path.join(ctx.claudeDir || path.join(ctx.home, '.claude'), 'skills'); }
function manifestPath(ctx) { return path.join(ctx.configDir, 'installed-skills.json'); }

function readManifest(ctx) {
  try { const o = JSON.parse(fs.readFileSync(manifestPath(ctx), 'utf8')); return (o && typeof o === 'object') ? o : {}; }
  catch (e) { return {}; }
}
function writeManifest(ctx, m) { writeJsonStable(manifestPath(ctx), m, 0o600); }

// Find directories that contain a SKILL.md (a valid skill), bounded depth.
function findSkillDirs(root, depth) {
  depth = depth === undefined ? 3 : depth;
  const found = [];
  function walk(dir, d) {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    if (entries.some(function (e) { return e.isFile() && e.name === 'SKILL.md'; })) { found.push(dir); return; } // a skill dir isn't nested
    if (d <= 0) return;
    // isDirectory() is false for symlinks (Dirent), so a symlinked dir is never
    // followed — blocks symlink-loop recursion and symlink-to-/etc escapes.
    entries.forEach(function (e) { if (e.isDirectory() && e.name[0] !== '.') walk(path.join(dir, e.name), d - 1); });
  }
  walk(root, depth);
  return found;
}

function safeSkillName(dir) {
  const n = path.basename(dir);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n) ? n : null;
}

// Install every skill dir found under `srcRoot`. mode: 'symlink' | 'copy'.
function installFromDir(ctx, srcRoot, source, opts) {
  opts = opts || {};
  const dirs = findSkillDirs(srcRoot);
  if (!dirs.length) throw new Error('no SKILL.md found under ' + srcRoot + ' — not a skill');
  const dest = skillsDir(ctx);
  fs.mkdirSync(dest, { recursive: true });
  const manifest = readManifest(ctx);
  const installed = [];
  dirs.forEach(function (d) {
    const name = safeSkillName(d);
    if (!name) return;
    const target = path.join(dest, name);
    if (fs.existsSync(target) && !manifest[name] && !opts.force) {
      throw new Error("a skill '" + name + "' already exists (not installed by keyflip) — pass --force to overwrite");
    }
    try { fs.rmSync(target, { recursive: true, force: true }); } catch (e) { /* */ }
    let mode = 'copy';
    if (opts.link) { try { fs.symlinkSync(fs.realpathSync(d), target, 'dir'); mode = 'symlink'; } catch (e) { fs.cpSync(d, target, { recursive: true }); } }
    else { fs.cpSync(d, target, { recursive: true }); }
    manifest[name] = { source: source, installedAt: ctx.now(), mode: mode };
    installed.push({ name: name, mode: mode });
  });
  writeManifest(ctx, manifest);
  return installed;
}

// Extract a .tar.gz / .tgz / .tar / .zip into a fresh temp dir using the system
// `tar` (bsdtar autodetects zip on macOS/Windows). Returns the temp dir path.
function extractArchive(file) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-skill-'));
  let r = run('tar', ['-xf', file, '-C', tmp]);           // bsdtar handles gz+zip
  if (r.code !== 0) r = run('tar', ['-xzf', file, '-C', tmp]); // GNU tar gz
  if (r.code !== 0) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* */ } throw new Error('could not extract ' + file + ' (need tar): ' + (r.stderr || r.code)); }
  return tmp;
}

// owner/repo[@ref][/subdir]  ->  codeload tarball URL + optional subdir
function parseGithub(src) {
  // ref (after @) is a single path segment (no '/') so a trailing /subdir is
  // parsed separately; branch names containing '/' + a subdir aren't supported.
  const m = /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:@([\w.-]+))?(?:\/(.+))?$/.exec(src);
  if (!m) return null;
  return { owner: m[1], repo: m[2], ref: m[3] || 'HEAD', subdir: m[4] || '' };
}

// Resolve a source to a local root dir, downloading/extracting if needed.
async function resolveSource(src, opts) {
  opts = opts || {};
  // local directory
  try { if (fs.statSync(src).isDirectory()) return { root: src, cleanup: null, source: 'dir:' + path.resolve(src) }; } catch (e) { /* not a dir */ }
  // local archive
  if (/\.(tgz|tar\.gz|tar|zip)$/i.test(src) && fs.existsSync(src)) {
    const dir = extractArchive(src);
    return { root: dir, cleanup: dir, source: 'archive:' + path.basename(src) };
  }
  // github
  const gh = parseGithub(src);
  if (gh) {
    const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('no network available to fetch ' + src);
    const url = 'https://codeload.github.com/' + gh.owner + '/' + gh.repo + '/tar.gz/' + gh.ref;
    const res = await doFetch(url);
    if (!res || !res.ok) throw new Error('GitHub download failed (http ' + (res && res.status) + ') for ' + gh.owner + '/' + gh.repo);
    const buf = Buffer.from(await res.arrayBuffer());
    // Unpredictable temp dir (avoids a symlink-predates-write overwrite on shared hosts).
    const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-gh-'));
    const tmpFile = path.join(dlDir, 'repo.tar.gz');
    fs.writeFileSync(tmpFile, buf);
    const dir = extractArchive(tmpFile);
    try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch (e) { /* */ }
    // codeload wraps everything in <repo>-<ref>/; descend into it (+ subdir)
    let inner = dir;
    try { const only = fs.readdirSync(dir).filter(function (n) { return fs.statSync(path.join(dir, n)).isDirectory(); }); if (only.length === 1) inner = path.join(dir, only[0]); } catch (e) { /* */ }
    if (gh.subdir) {
      const wrapRoot = inner;
      inner = path.resolve(wrapRoot, gh.subdir);
      // The subdir must stay INSIDE the extracted repo — reject ../ escapes.
      if (inner !== wrapRoot && inner.indexOf(wrapRoot + path.sep) !== 0) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* */ }
        throw new Error('invalid subdir in ' + src + ' (path traversal)');
      }
    }
    return { root: inner, cleanup: dir, source: 'github:' + gh.owner + '/' + gh.repo + (gh.subdir ? '/' + gh.subdir : '') };
  }
  throw new Error("don't know how to install '" + src + "' — use owner/repo, a local dir, or a .tar.gz/.zip");
}

async function add(ctx, src, opts) {
  opts = opts || {};
  const resolved = await resolveSource(src, opts);
  try {
    return installFromDir(ctx, resolved.root, resolved.source, { link: opts.link, force: opts.force });
  } finally {
    if (resolved.cleanup) { try { fs.rmSync(resolved.cleanup, { recursive: true, force: true }); } catch (e) { /* */ } }
  }
}

function list(ctx) {
  const m = readManifest(ctx);
  return Object.keys(m).sort().map(function (n) { return Object.assign({ name: n }, m[n]); });
}

function remove(ctx, name) {
  const m = readManifest(ctx);
  if (!m[name]) throw new Error("'" + name + "' was not installed by keyflip (refusing to remove it)");
  try { fs.rmSync(path.join(skillsDir(ctx), name), { recursive: true, force: true }); } catch (e) { /* */ }
  delete m[name]; writeManifest(ctx, m);
}

export { add, list, remove, findSkillDirs, parseGithub, installFromDir, resolveSource, skillsDir };