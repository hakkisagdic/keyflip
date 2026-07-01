'use strict';
// Parallel session mode (ported from claude-swap's session.py): run Claude Code
// as a stored account in THIS terminal only, by pointing CLAUDE_CONFIG_DIR at a
// per-account profile under <configDir>/sessions/<name>/. The default ~/.claude
// login — and every other terminal, the desktop app, the VS Code extension —
// stays untouched.
//
// The profile is seeded with a plaintext .credentials.json: that's Claude's
// stable fallback (its only mechanism on Linux); on macOS Claude migrates it
// into its own keychain entry (hashed from the CLAUDE_CONFIG_DIR value) on
// first write.
//
// Sharing: settings.json, keybindings.json, CLAUDE.md, skills/, commands/ and
// agents/ follow the user into the session via symlinks (copies on Windows,
// re-synced each launch). A manifest records what ccswitch created so cleanup
// never touches user data. Account-scoped things (projects/, sessions/,
// .claude.json, .credentials.json) are deliberately NOT shared.
const fs = require('fs');
const path = require('path');
const profiles = require('./profiles');
const claudeCfg = require('./claude');
const { atomicWrite } = require('./fsutil');

const SHARED_ITEMS = ['settings.json', 'keybindings.json', 'CLAUDE.md', 'skills', 'commands', 'agents'];
const SHARE_MANIFEST = '.ccswitch-shared.json';

// Env vars that make claude bypass account OAuth entirely — scrubbed from the
// session launch env (running account N is an explicit request for account N).
const AUTH_OVERRIDE_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
];

function sessionDir(ctx, name) { return path.join(ctx.configDir, 'sessions', name); }

function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, SHARE_MANIFEST), 'utf8')).created || []; }
  catch (e) { return []; }
}
function writeManifest(dir, created) {
  atomicWrite(path.join(dir, SHARE_MANIFEST), JSON.stringify({ created: created }, null, 2), 0o600);
}

// Mirror the user's customizations into the session profile. Only ever creates
// (and later removes) entries listed in the manifest — never user data.
// `extra` adds opt-in items (e.g. 'projects' for --share-history, issue #74:
// two accounts sharing the same conversation history).
function syncShared(ctx, dir, share, extra) {
  const items = SHARED_ITEMS.concat(extra || []);
  const src = path.join(ctx.home, '.claude');
  const prev = readManifest(dir);
  // remove what we created before (re-synced below when share is on)
  prev.forEach(function (n) {
    const p = path.join(dir, n);
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink() || ctx.platform === 'win32') fs.rmSync(p, { recursive: true, force: true });
    } catch (e) { /* already gone */ }
  });
  const created = [];
  if (share) {
    items.forEach(function (n) {
      const from = path.join(src, n);
      const to = path.join(dir, n);
      if (!fs.existsSync(from) || fs.existsSync(to)) return; // never clobber user files
      try {
        if (ctx.platform === 'win32') fs.cpSync(from, to, { recursive: true });
        else fs.symlinkSync(from, to);
        created.push(n);
      } catch (e) { /* best-effort */ }
    });
  }
  writeManifest(dir, created);
  return created;
}

// Seed (or refresh) the session profile from the stored account. Returns the dir.
function prepareSession(ctx, name, opts) {
  opts = opts || {};
  const blob = ctx.store.getProfile(name);
  if (!blob) throw new Error("profile '" + name + "' has no stored CLI credentials — run 'ccswitch add' while logged into it");
  try {
    const d = JSON.parse(blob);
    if (!d || !d.claudeAiOauth) throw 0;
  } catch (e) { throw new Error("profile '" + name + "' credentials are unreadable — re-add the account"); }

  const dir = sessionDir(ctx, name);
  fs.mkdirSync(dir, { recursive: true });
  atomicWrite(path.join(dir, '.credentials.json'), blob, 0o600);

  // Minimal .claude.json so the session skips onboarding and knows its account.
  const meta = profiles.read(ctx.configDir, name) || {};
  const cfgPath = path.join(dir, '.claude.json');
  const existing = claudeCfg.readConfig(cfgPath) || {};
  existing.hasCompletedOnboarding = true;
  if (meta.oauthAccount) existing.oauthAccount = meta.oauthAccount;
  if (meta.userID) existing.userID = meta.userID;
  claudeCfg.writeConfig(cfgPath, existing);

  syncShared(ctx, dir, opts.share !== false, opts.shareHistory ? ['projects'] : []);
  return dir;
}

// Launch env: point Claude at the session profile and scrub auth overrides.
// Returns { env, scrubbed } — scrubbed lists removed override vars for warning.
function sessionEnv(ctx, dir, baseEnv) {
  const env = Object.assign({}, baseEnv || process.env);
  const scrubbed = [];
  AUTH_OVERRIDE_ENV_VARS.forEach(function (k) {
    if (env[k] !== undefined) { scrubbed.push(k); delete env[k]; }
  });
  env.CLAUDE_CONFIG_DIR = dir;
  return { env: env, scrubbed: scrubbed };
}

// After the session exits: if Claude rotated the token in-session, persist the
// fresh credentials back into the stored profile so it never goes stale.
function syncBack(ctx, name) {
  const p = path.join(sessionDir(ctx, name), '.credentials.json');
  let blob;
  try { blob = fs.readFileSync(p, 'utf8'); } catch (e) { return false; } // migrated to keychain or gone
  try {
    const d = JSON.parse(blob);
    if (!d || !d.claudeAiOauth || !d.claudeAiOauth.accessToken) return false;
  } catch (e) { return false; }
  let prev = null;
  try { prev = ctx.store.getProfile(name); } catch (e) { prev = null; }
  if (blob === prev) return false;
  try { ctx.store.setProfile(name, blob); return true; } catch (e) { return false; }
}

module.exports = {
  prepareSession: prepareSession,
  sessionEnv: sessionEnv,
  syncBack: syncBack,
  sessionDir: sessionDir,
  syncShared: syncShared,
  SHARED_ITEMS: SHARED_ITEMS,
  AUTH_OVERRIDE_ENV_VARS: AUTH_OVERRIDE_ENV_VARS,
};
