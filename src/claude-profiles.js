// Claude Desktop multi-profile manager — isolated instances per account using --user-data-dir.
// Each profile gets:
// - Independent .app clone (APFS copy-on-write, near-zero disk overhead)
// - Isolated user data directory (cookies, sessions, MCP config)
// - Auto-update disabled (prevents breaking the clone on Claude updates)
// - Custom CLAUDE_CONFIG_DIR for MCP server isolation
//
// Security: No secrets in git, 0600 permissions on sensitive dirs, zero-dep (uses macOS tools only).
import fs from 'fs';
import path from 'path';
import os from 'os';
import { run } from './exec.js';
import { atomicWrite } from './fsutil.js';

const PROFILES_BASE = path.join(os.homedir(), 'Library/Application Support/Claude-Profiles');
const BASE_APP = '/Applications/Claude.app';
const INFO_PLIST_PATH = 'Contents/Info.plist';

// --- Profile discovery & metadata ---

function profilesDir() {
  return PROFILES_BASE;
}

function profileDir(accountSlug) {
  return path.join(PROFILES_BASE, accountSlug);
}

function listProfiles() {
  if (!fs.existsSync(PROFILES_BASE)) return [];

  const entries = fs.readdirSync(PROFILES_BASE);
  return entries
    .filter((name) => {
      const p = path.join(PROFILES_BASE, name);
      return fs.statSync(p).isDirectory();
    })
    .map((slug) => {
      const dir = path.join(PROFILES_BASE, slug);
      const metaPath = path.join(dir, 'profile.json');
      let meta = {};
      try {
        if (fs.existsSync(metaPath)) {
          meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        }
      } catch (_) {
        // ignore corrupt meta
      }

      // Check if instance is running
      const pid = findRunningPid(slug);

      return {
        slug: slug,
        dir: dir,
        appPath: path.join(dir, 'Claude.app'),
        userDataDir: path.join(dir, 'User Data'),
        configDir: path.join(dir, 'Config'),
        createdAt: meta.createdAt || null,
        autoUpdateDisabled: meta.autoUpdateDisabled || false,
        running: pid !== null,
        pid: pid,
      };
    });
}

function getProfile(accountSlug) {
  const dir = profileDir(accountSlug);
  if (!fs.existsSync(dir)) return null;

  const profiles = listProfiles();
  return profiles.find((p) => p.slug === accountSlug) || null;
}

// --- PID tracking ---

function pidFile(accountSlug) {
  return path.join(profileDir(accountSlug), 'instance.pid');
}

function writePid(accountSlug, pid) {
  const p = pidFile(accountSlug);
  try {
    fs.writeFileSync(p, String(pid), { mode: 0o600 });
  } catch (_) {
    // ignore
  }
}

function readPid(accountSlug) {
  const p = pidFile(accountSlug);
  try {
    if (fs.existsSync(p)) {
      return parseInt(fs.readFileSync(p, 'utf8').trim(), 10);
    }
  } catch (_) {
    // ignore
  }
  return null;
}

function clearPid(accountSlug) {
  const p = pidFile(accountSlug);
  try {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  } catch (_) {
    // ignore
  }
}

function findRunningPid(accountSlug) {
  const pid = readPid(accountSlug);
  if (!pid) return null;

  // Check if process is actually alive
  try {
    const result = run('kill', ['-0', String(pid)]);
    if (result.code === 0) {
      return pid;
    }
  } catch (_) {
    // process not found
  }

  // Stale PID file
  clearPid(accountSlug);
  return null;
}

// --- Profile creation ---

function ensureBaseApp() {
  if (!fs.existsSync(BASE_APP)) {
    throw new Error(`Claude.app not found at ${BASE_APP}. Please install Claude Desktop first.`);
  }
  return BASE_APP;
}

function createProfile(accountSlug) {
  const baseApp = ensureBaseApp();
  const dir = profileDir(accountSlug);

  if (fs.existsSync(dir)) {
    throw new Error(`Profile already exists for ${accountSlug} at ${dir}`);
  }

  console.log(`[claude-profiles] Creating profile for ${accountSlug}...`);

  // Create profile directory structure
  fs.mkdirSync(dir, { recursive: true });
  const userDataDir = path.join(dir, 'User Data');
  const configDir = path.join(dir, 'Config');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });

  // Clone Claude.app using APFS copy-on-write (-c flag)
  const appClone = path.join(dir, 'Claude.app');
  console.log('[claude-profiles] Cloning Claude.app (APFS clone, near-zero disk cost)...');
  const cpResult = run('cp', ['-cR', baseApp, appClone]);
  if (cpResult.code !== 0) {
    // Fallback to regular copy if -c not supported
    console.warn('[claude-profiles] APFS clone failed, falling back to regular copy...');
    const cpFallback = run('cp', ['-R', baseApp, appClone]);
    if (cpFallback.code !== 0) {
      throw new Error(`Failed to clone Claude.app: ${cpFallback.stderr}`);
    }
  }

  // Disable auto-update by patching Info.plist
  const plistPath = path.join(appClone, INFO_PLIST_PATH);
  if (fs.existsSync(plistPath)) {
    console.log('[claude-profiles] Disabling auto-update...');
    try {
      // Use plutil to modify plist
      run('plutil', ['-replace', 'SUEnableAutomaticChecks', '-bool', 'false', plistPath]);
      run('plutil', ['-replace', 'SUPublicEDKey', '-string', '', plistPath]);
    } catch (_) {
      console.warn('[claude-profiles] Failed to disable auto-update via plutil');
      // Non-fatal: profile still works, just might auto-update
    }
  }

  // Set permissions
  try {
    fs.chmodSync(dir, 0o700);
    fs.chmodSync(userDataDir, 0o700);
    fs.chmodSync(configDir, 0o700);
  } catch (_) {
    // ignore
  }

  // Write profile metadata
  const meta = {
    slug: accountSlug,
    createdAt: new Date().toISOString(),
    baseApp: baseApp,
    autoUpdateDisabled: true,
    userDataDir: userDataDir,
    configDir: configDir,
  };
  atomicWrite(path.join(dir, 'profile.json'), JSON.stringify(meta, null, 2) + '\n', 0o600);

  console.log(`[claude-profiles] ✅ Profile created for ${accountSlug}`);
  console.log(`  Location: ${dir}`);
  console.log(`  App clone: ${appClone}`);
  console.log(`  User data: ${userDataDir}`);
  console.log(`  Config: ${configDir}`);

  return {
    slug: accountSlug,
    dir: dir,
    appPath: appClone,
    userDataDir: userDataDir,
    configDir: configDir,
  };
}

// --- Instance management ---

function killAllClaudeInstances() {
  console.log('[claude-profiles] Closing all Claude instances...');
  try {
    run('pkill', ['-f', 'Claude\\.app']);
  } catch (err) {
    // No instances running
  }
}

function launchProfile(profile, accountSlug) {
  // Close all other Claude instances first (deep link trap avoidance)
  killAllClaudeInstances();

  console.log(`[claude-profiles] Launching Claude for ${accountSlug}...`);

  // Launch with --user-data-dir and CLAUDE_CONFIG_DIR
  const result = run('open', ['-a', profile.appPath, '--args', '--user-data-dir=' + profile.userDataDir], undefined, {
    env: Object.assign({}, process.env, {
      CLAUDE_CONFIG_DIR: profile.configDir,
    }),
  });

  if (result.code !== 0) {
    throw new Error(`Failed to launch Claude: ${result.stderr}`);
  }

  // Find the new PID after a short delay
  setTimeout(() => {
    const pgrepResult = run('pgrep', ['-f', 'Claude\\.app']);
    if (pgrepResult.code === 0 && pgrepResult.stdout.trim()) {
      const pid = parseInt(pgrepResult.stdout.trim().split('\n')[0], 10);
      writePid(accountSlug, pid);
      console.log(`[claude-profiles] Instance started (PID: ${pid})`);
    }
  }, 2000);

  return true;
}

function focusProfile(profile) {
  if (!profile.running || !profile.pid) {
    throw new Error(`Profile ${profile.slug} is not running`);
  }

  console.log(`[claude-profiles] Focusing Claude instance for ${profile.slug}...`);

  // Use AppleScript to bring window to front
  try {
    run('osascript', [
      '-e',
      `tell application "System Events" to set frontmost of first process whose unix id is ${profile.pid} to true`,
    ]);
  } catch (_) {
    console.warn('[claude-profiles] Failed to focus window');
  }
}

function killProfile(accountSlug) {
  const profile = getProfile(accountSlug);
  if (!profile) {
    throw new Error(`No profile found for ${accountSlug}`);
  }

  if (!profile.running) {
    console.log(`[claude-profiles] Profile ${accountSlug} is not running`);
    return;
  }

  console.log(`[claude-profiles] Killing Claude instance for ${accountSlug}...`);

  try {
    run('kill', [String(profile.pid)]);
    clearPid(accountSlug);
    console.log(`[claude-profiles] Instance killed (PID: ${profile.pid})`);
  } catch (_) {
    console.error('[claude-profiles] Failed to kill instance');
    clearPid(accountSlug);
  }
}

// --- Integration helpers ---

function hasProfile(accountSlug) {
  return fs.existsSync(profileDir(accountSlug));
}

function ensureProfile(ctx, accountSlug) {
  if (!hasProfile(accountSlug)) {
    console.log(`[claude-profiles] Profile not found for ${accountSlug}, creating...`);
    return createProfile(accountSlug);
  }
  return getProfile(accountSlug);
}

export {
  profilesDir,
  listProfiles,
  getProfile,
  createProfile,
  ensureProfile,
  hasProfile,
  launchProfile,
  focusProfile,
  killProfile,
  killAllClaudeInstances,
};
