'use strict';
// H3: git-backed versioning of keyflip's OWN config/state/memory dir, so every mutation
// is inspectable (`keyflip history`) and reversible (`keyflip undo`/`restore`). Uses the
// system `git` binary (zero runtime dep) and DEGRADES TO A NO-OP if git is absent, the dir
// is gone, or versioning is disabled. Every call is best-effort and NEVER throws — a broken
// git must not break a keyflip operation.
//
// SECRETS ARE NEVER COMMITTED. A managed .gitignore excludes creds/, *.cred, browser
// sessions, and token-shaped files; secrets stay in the OS credential store. Git tracks
// only the no-secret set (the same metadata `keyflip backup` already snapshots).
const fs = require('fs');
const path = require('path');
const { run } = require('./exec');
const secretpaths = require('./secretpaths');

// The secret set comes from the SHARED source of truth (src/secretpaths.js) so vcs and
// backup can never drift; the rest is non-secret but not worth versioning.
const GITIGNORE = [
  '# keyflip: NEVER version secrets — they live in the OS credential store.',
].concat(secretpaths.gitignoreLines()).concat([
  '# rebuildable caches / self-referential snapshots (not versioned)',
  'embeddings.json',
  '.usage-cache.json',
  'backups/',
  'skill-backups/',
  '# transient runtime junk',
  '*.pid',
  '*.sock',
  'sockets/',
  '.DS_Store',
  '',
]).join('\n');

const IDENT = ['-c', 'user.email=keyflip@localhost', '-c', 'user.name=keyflip'];

function gitAvailable() { try { const r = run('git', ['--version']); return !!(r && r.code === 0); } catch (e) { return false; } }

// Versioning is ON by default; disabled by KEYFLIP_VCS=off (tests/CI), a `.noversion`
// marker in the config dir (user opt-out), or a missing git binary.
function isEnabled(ctx) {
  if (process.env.KEYFLIP_VCS === 'off') return false;
  try { if (fs.existsSync(path.join(ctx.configDir, '.noversion'))) return false; } catch (e) { /* ignore */ }
  return gitAvailable();
}

function isRepo(ctx) { try { return fs.existsSync(path.join(ctx.configDir, '.git')); } catch (e) { return false; } }
function dirExists(ctx) { try { return fs.existsSync(ctx.configDir); } catch (e) { return false; } }

function git(ctx, args, input) {
  try { return run('git', ['-C', ctx.configDir].concat(args), input, { timeoutMs: 20000 }); }
  catch (e) { return { code: 1, stdout: '', stderr: String(e && e.message) }; }
}

// Init the repo + write the managed .gitignore, idempotently. Does NOT create the config
// dir (so it never resurrects a dir that `reset` just deleted). Returns true if a repo exists.
function ensureRepo(ctx) {
  if (!isEnabled(ctx) || !dirExists(ctx)) return false;
  const gi = path.join(ctx.configDir, '.gitignore');
  // REFRESH the managed .gitignore every run (not just when absent) so an already-init'd
  // repo picks up newly-added secret patterns — otherwise a stale .gitignore keeps leaking.
  let refreshed = false;
  try {
    const cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : null;
    if (cur !== GITIGNORE) { fs.writeFileSync(gi, GITIGNORE); refreshed = true; }
  } catch (e) { /* ignore */ }
  if (!isRepo(ctx)) {
    const r = git(ctx, ['init', '-q']);
    if (!r || r.code !== 0) return false;
    git(ctx, ['config', 'user.email', 'keyflip@localhost']);
    git(ctx, ['config', 'user.name', 'keyflip']);
    commit(ctx, 'init keyflip versioning');
  } else if (refreshed) {
    // The .gitignore just changed on an existing repo — untrack anything now-ignored that
    // was committed before the rule existed (e.g. app/ oauth cache leaked by an older
    // keyflip). This stops FUTURE commits from carrying it; it does not scrub history.
    purgeIgnoredFromIndex(ctx);
  }
  return isRepo(ctx);
}

// Drop from the git index any tracked file the current .gitignore now excludes.
function purgeIgnoredFromIndex(ctx) {
  const ls = git(ctx, ['ls-files', '-i', '-c', '--exclude-standard']);
  if (!ls || ls.code !== 0) return;
  const files = String(ls.stdout || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!files.length) return;
  git(ctx, ['rm', '--cached', '-q', '--'].concat(files));
}

// Stage everything (minus .gitignore'd secrets) and commit IF something changed. Best-effort.
function commit(ctx, message) {
  if (!isEnabled(ctx) || !isRepo(ctx)) return false;
  const add = git(ctx, ['add', '-A']);
  if (!add || add.code !== 0) return false;
  const st = git(ctx, ['status', '--porcelain']);
  if (!st || !String(st.stdout || '').trim()) return false; // nothing to commit
  const r = git(ctx, IDENT.concat(['commit', '-q', '-m', 'keyflip: ' + String(message || 'update')]));
  return !!(r && r.code === 0);
}

// List the files git currently TRACKS (relative to configDir). Used by `keyflip doctor` to
// verify no secret ever slipped into version control. Empty if not a repo.
function tracked(ctx) {
  if (!isRepo(ctx)) return [];
  const r = git(ctx, ['ls-files']);
  if (!r || r.code !== 0) return [];
  return String(r.stdout || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
}

// Auto-version hook for the mutation funnel: ensure the repo, then commit with a label.
function autoCommit(ctx, label) {
  try { if (!isEnabled(ctx)) return false; ensureRepo(ctx); return commit(ctx, label); }
  catch (e) { return false; }
}

// Recent history (newest first): [{ ref, subject, date }].
function log(ctx, n) {
  if (!isRepo(ctx)) return [];
  const r = git(ctx, ['log', '--pretty=%h\x01%s\x01%cI', '-n', String(n || 20)]);
  if (!r || r.code !== 0) return [];
  return String(r.stdout || '').trim().split('\n').filter(Boolean).map(function (line) {
    const p = line.split('\x01');
    return { ref: p[0], subject: p[1] || '', date: p[2] || '' };
  });
}

// Undo the most recent change (a NEW commit that reverses it — history is preserved).
function undo(ctx) {
  if (!isEnabled(ctx)) return { ok: false, reason: 'versioning-disabled' };
  if (!isRepo(ctx)) return { ok: false, reason: 'not-a-repo' };
  const count = git(ctx, ['rev-list', '--count', 'HEAD']);
  if (!count || parseInt(String(count.stdout || '0').trim(), 10) < 2) return { ok: false, reason: 'nothing-to-undo' };
  const r = git(ctx, IDENT.concat(['revert', '--no-edit', 'HEAD']));
  return { ok: !!(r && r.code === 0), detail: r && r.stderr };
}

// Restore the tracked files to a past ref (checkout the tree, then commit the result).
function restore(ctx, ref) {
  if (!isEnabled(ctx)) return { ok: false, reason: 'versioning-disabled' };
  if (!isRepo(ctx)) return { ok: false, reason: 'not-a-repo' };
  const co = git(ctx, ['checkout', String(ref), '--', '.']);
  if (!co || co.code !== 0) return { ok: false, reason: 'bad-ref', detail: co && co.stderr };
  commit(ctx, 'restore ' + String(ref));
  return { ok: true };
}

// User opt-out / opt-in (a marker file; git history is kept either way).
function disable(ctx) { try { fs.mkdirSync(ctx.configDir, { recursive: true }); fs.writeFileSync(path.join(ctx.configDir, '.noversion'), ''); return true; } catch (e) { return false; } }
function enable(ctx) { try { fs.rmSync(path.join(ctx.configDir, '.noversion'), { force: true }); } catch (e) { /* ignore */ } return ensureRepo(ctx); }

module.exports = {
  GITIGNORE: GITIGNORE,
  gitAvailable: gitAvailable,
  isEnabled: isEnabled,
  isRepo: isRepo,
  ensureRepo: ensureRepo,
  commit: commit,
  autoCommit: autoCommit,
  log: log,
  tracked: tracked,
  undo: undo,
  restore: restore,
  disable: disable,
  enable: enable,
};
