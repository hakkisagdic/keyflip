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
// re-synced each launch). A manifest records what keyflip created so cleanup
// never touches user data. Account-scoped things (projects/, sessions/,
// .claude.json, .credentials.json) are deliberately NOT shared.
import fs from 'fs';
import path from 'path';
import * as profiles from './profiles.js';
import * as claudeCfg from './claude.js';
import { atomicWrite } from './fsutil.js';

const SHARED_ITEMS = ['settings.json', 'keybindings.json', 'CLAUDE.md', 'skills', 'commands', 'agents'];
const SHARE_MANIFEST = '.keyflip-shared.json';

// Env vars that make claude bypass account OAuth entirely — scrubbed from the
// session launch env (running account N is an explicit request for account N).
const AUTH_OVERRIDE_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
];

// Multi-provider launch specs (Traycer-compatible `launchCommand` model):
// each surface defines its isolated home/config env var, binary name, and
// shell env vars that must be explicitly unset so leaked API keys never
// override the isolated OAuth profile.
const SURFACE_LAUNCH_SPECS = Object.freeze({
  claude: Object.freeze({
    id: 'claude',
    configEnv: 'CLAUDE_CONFIG_DIR',
    bin: 'claude',
    unsetVars: Object.freeze(AUTH_OVERRIDE_ENV_VARS.slice()),
  }),
  codex: Object.freeze({
    id: 'codex',
    configEnv: 'CODEX_HOME',
    bin: 'codex',
    unsetVars: Object.freeze(['OPENAI_API_KEY', 'OPENAI_BASE_URL']),
  }),
  grok: Object.freeze({
    id: 'grok',
    configEnv: 'GROK_HOME',
    bin: 'grok',
    unsetVars: Object.freeze(['XAI_API_KEY', 'GROK_API_KEY']),
  }),
  'command-code': Object.freeze({
    id: 'command-code',
    configEnv: 'COMMAND_CODE_HOME',
    bin: 'cmd',
    unsetVars: Object.freeze(['COMMAND_CODE_API_KEY']),
  }),
});

function sessionDir(ctx, name) {
  return path.join(ctx.configDir, 'sessions', name);
}

function surfaceProfileDir(ctx, surfaceId, name) {
  if (!surfaceId || surfaceId === 'claude' || surfaceId === 'claude-code') return sessionDir(ctx, name);
  return path.join(ctx.configDir, 'surfaces', surfaceId, name);
}

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, SHARE_MANIFEST), 'utf8')).created || [];
  } catch (e) {
    return [];
  }
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
    } catch (e) {
      /* already gone */
    }
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
      } catch (e) {
        /* best-effort */
      }
    });
  }
  writeManifest(dir, created);
  return created;
}

// Seed (or refresh) the session profile from the stored account. Returns the dir.
function prepareSession(ctx, name, opts) {
  opts = opts || {};
  const blob = ctx.store.getProfile(name);
  if (!blob)
    throw new Error("profile '" + name + "' has no stored CLI credentials — run 'keyflip add' while logged into it");
  try {
    const d = JSON.parse(blob);
    if (!d || !d.claudeAiOauth) throw 0;
  } catch (e) {
    throw new Error("profile '" + name + "' credentials are unreadable — re-add the account");
  }

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
// Supports optional per-session `envOverrides` (string to set, null to unset).
// Returns { env, scrubbed } — scrubbed lists removed override vars for warning.
function sessionEnv(ctx, dir, baseEnv, opts) {
  opts = opts || {};
  const surfaceKey = opts.surface && SURFACE_LAUNCH_SPECS[opts.surface] ? opts.surface : 'claude';
  const spec = SURFACE_LAUNCH_SPECS[surfaceKey];
  const env = Object.assign({}, baseEnv || process.env);
  const scrubbed = [];
  spec.unsetVars.forEach(function (k) {
    if (env[k] !== undefined) {
      scrubbed.push(k);
      delete env[k];
    }
  });
  if (opts.envOverrides && typeof opts.envOverrides === 'object') {
    Object.keys(opts.envOverrides).forEach(function (k) {
      const val = opts.envOverrides[k];
      if (val === null) {
        if (env[k] !== undefined && scrubbed.indexOf(k) === -1) scrubbed.push(k);
        delete env[k];
      } else if (typeof val === 'string') {
        env[k] = val;
      }
    });
  }
  env[spec.configEnv] = dir;
  return { env: env, scrubbed: scrubbed };
}

function posixQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/**
 * Generate a copyable shell launch command (POSIX + PowerShell) for an isolated
 * profile without mutating the ambient terminal login (Traycer `launchCommand` model).
 * @param {object} ctx - Keyflip context.
 * @param {string} name - Account/profile name.
 * @param {object} [opts] - Options ({ surface, prepare, share, shareHistory, envOverrides }).
 */
function launchCommand(ctx, name, opts) {
  opts = opts || {};
  const rawSurface = opts.surface === 'claude-code' ? 'claude' : opts.surface || 'claude';
  const spec = SURFACE_LAUNCH_SPECS[rawSurface];
  if (!spec) {
    throw new Error(
      "unsupported launch-cmd surface: '" +
        rawSurface +
        "' (supported: " +
        Object.keys(SURFACE_LAUNCH_SPECS).join(', ') +
        ')',
    );
  }
  if (!profiles.isValidName(name)) {
    throw new Error("invalid profile name: '" + name + "'");
  }
  let dir = surfaceProfileDir(ctx, spec.id, name);
  if (opts.prepare && spec.id === 'claude') {
    dir = prepareSession(ctx, name, { share: opts.share !== false, shareHistory: !!opts.shareHistory });
  }
  const unsetList = spec.unsetVars.slice();
  const setPairs = [{ key: spec.configEnv, value: dir }];
  if (opts.envOverrides && typeof opts.envOverrides === 'object') {
    Object.keys(opts.envOverrides).forEach(function (k) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return;
      const v = opts.envOverrides[k];
      if (v === null) {
        if (unsetList.indexOf(k) === -1) unsetList.push(k);
      } else if (typeof v === 'string') {
        setPairs.push({ key: k, value: v });
      }
    });
  }
  const posixUnset = unsetList.length ? 'unset ' + unsetList.join(' ') + '; ' : '';
  const posixEnv = setPairs
    .map(function (p) {
      return p.key + '=' + posixQuote(p.value);
    })
    .join(' ');
  const posix = posixUnset + posixEnv + ' ' + spec.bin;

  const psUnset = unsetList.length
    ? 'Remove-Item ' +
      unsetList
        .map(function (u) {
          return 'Env:' + u;
        })
        .join(',') +
      ' -ErrorAction SilentlyContinue; '
    : '';
  const psEnv = setPairs
    .map(function (p) {
      return '$env:' + p.key + '=' + psQuote(p.value) + '; ';
    })
    .join('');
  const powershell = psUnset + psEnv + spec.bin;

  return {
    surface: spec.id,
    account: name,
    configEnv: spec.configEnv,
    configDir: dir,
    unsetVars: unsetList,
    posix: posix,
    powershell: powershell,
  };
}

// After the session exits: if Claude rotated the token in-session, persist the
// fresh credentials back into the stored profile so it never goes stale.
function syncBack(ctx, name) {
  const p = path.join(sessionDir(ctx, name), '.credentials.json');
  let blob;
  try {
    blob = fs.readFileSync(p, 'utf8');
  } catch (e) {
    return false;
  } // migrated to keychain or gone
  try {
    const d = JSON.parse(blob);
    if (!d || !d.claudeAiOauth || !d.claudeAiOauth.accessToken) return false;
  } catch (e) {
    return false;
  }
  let prev = null;
  try {
    prev = ctx.store.getProfile(name);
  } catch (e) {
    prev = null;
  }
  if (blob === prev) return false;
  try {
    ctx.store.setProfile(name, blob);
    return true;
  } catch (e) {
    return false;
  }
}

export {
  prepareSession,
  sessionEnv,
  launchCommand,
  syncBack,
  sessionDir,
  surfaceProfileDir,
  syncShared,
  SHARED_ITEMS,
  AUTH_OVERRIDE_ENV_VARS,
  SURFACE_LAUNCH_SPECS,
};
