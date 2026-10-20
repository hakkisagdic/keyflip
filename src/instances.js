// Generic multi-instance manager — isolated app instances per tool + account.
// Each instance gets:
// - Independent .app clone (APFS copy-on-write, near-zero disk overhead)
// - Isolated user data directory (cookies, sessions, configs)
// - Auto-update disabled (prevents breaking the clone on app updates)
// - Custom config env var for MCP/server isolation
//
// Tool adapters define per-app behavior. Currently supported: claude, cursor (planned).
// Security: No secrets in git, 0600 permissions on sensitive dirs, zero-dep (macOS only).
import fs from 'fs';
import path from 'path';
import os from 'os';
import { run } from './exec.js';
import { atomicWrite } from './fsutil.js';

const INSTANCES_BASE = path.join(os.homedir(), 'Library/Application Support/keyflip-instances');
const INFO_PLIST_PATH = 'Contents/Info.plist';

// --- Tool adapters ---

const TOOL_ADAPTERS = {
  claude: {
    name: 'Claude',
    appName: 'Claude.app',
    baseAppPath: '/Applications/Claude.app',
    userDataFlag: '--user-data-dir',
    configEnv: 'CLAUDE_CONFIG_DIR',
    processPattern: 'Claude\\.app',
    supportsMultiInstance: true,
    disableAutoUpdate: true,
  },
  // cursor: {
  //   name: 'Cursor',
  //   appName: 'Cursor.app',
  //   baseAppPath: '/Applications/Cursor.app',
  //   userDataFlag: '--user-data-dir',
  //   configEnv: 'CURSOR_CONFIG_DIR',
  //   processPattern: 'Cursor\\.app',
  //   supportsMultiInstance: true,
  //   disableAutoUpdate: false, // Cursor doesn't auto-update aggressively
  // },
};

function getAdapter(tool) {
  const adapter = TOOL_ADAPTERS[tool];
  if (!adapter) {
    throw new Error(
      `Unsupported tool: ${tool}. Available: ${Object.keys(TOOL_ADAPTERS).join(', ')}`,
    );
  }
  return adapter;
}

// --- Instance paths ---

function instancesDir() {
  return INSTANCES_BASE;
}

function instanceDir(tool, accountSlug) {
  return path.join(INSTANCES_BASE, tool, accountSlug);
}

function pidFile(tool, accountSlug) {
  return path.join(instanceDir(tool, accountSlug), 'instance.pid');
}

// --- Profile discovery & metadata ---

function listInstances(tool) {
  const toolDir = path.join(INSTANCES_BASE, tool);
  if (!fs.existsSync(toolDir)) return [];

  const entries = fs.readdirSync(toolDir);
  return entries
    .filter((name) => {
      const p = path.join(toolDir, name);
      return fs.statSync(p).isDirectory();
    })
    .map((slug) => {
      const dir = path.join(toolDir, slug);
      const metaPath = path.join(dir, 'profile.json');
      let meta = {};
      try {
        if (fs.existsSync(metaPath)) {
          meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        }
      } catch (_) {
        // ignore corrupt meta
      }

      const adapter = getAdapter(tool);
      const pid = findRunningPid(tool, slug);

      return {
        tool: tool,
        slug: slug,
        dir: dir,
        appPath: path.join(dir, adapter.appName),
        userDataDir: path.join(dir, 'User Data'),
        configDir: path.join(dir, 'Config'),
        createdAt: meta.createdAt || null,
        autoUpdateDisabled: meta.autoUpdateDisabled || false,
        running: pid !== null,
        pid: pid,
      };
    });
}

function getInstance(tool, accountSlug) {
  const dir = instanceDir(tool, accountSlug);
  if (!fs.existsSync(dir)) return null;

  const instances = listInstances(tool);
  return instances.find((p) => p.slug === accountSlug) || null;
}

// --- PID tracking ---

function writePid(tool, accountSlug, pid) {
  const p = pidFile(tool, accountSlug);
  try {
    fs.writeFileSync(p, String(pid), { mode: 0o600 });
  } catch (_) {
    // ignore
  }
}

function readPid(tool, accountSlug) {
  const p = pidFile(tool, accountSlug);
  try {
    if (fs.existsSync(p)) {
      return parseInt(fs.readFileSync(p, 'utf8').trim(), 10);
    }
  } catch (_) {
    // ignore
  }
  return null;
}

function clearPid(tool, accountSlug) {
  const p = pidFile(tool, accountSlug);
  try {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  } catch (_) {
    // ignore
  }
}

function findRunningPid(tool, accountSlug) {
  const pid = readPid(tool, accountSlug);
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
  clearPid(tool, accountSlug);
  return null;
}

// --- Instance creation ---

function ensureBaseApp(adapter) {
  if (!fs.existsSync(adapter.baseAppPath)) {
    throw new Error(
      `${adapter.appName} not found at ${adapter.baseAppPath}. Please install it first.`,
    );
  }
  return adapter.baseAppPath;
}

function createInstance(tool, accountSlug) {
  const adapter = getAdapter(tool);
  const baseApp = ensureBaseApp(adapter);
  const dir = instanceDir(tool, accountSlug);

  if (fs.existsSync(dir)) {
    throw new Error(`Instance already exists for ${tool}/${accountSlug} at ${dir}`);
  }

  console.log(`[instances] Creating ${adapter.name} instance for ${accountSlug}...`);

  // Create instance directory structure
  fs.mkdirSync(dir, { recursive: true });
  const userDataDir = path.join(dir, 'User Data');
  const configDir = path.join(dir, 'Config');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });

  // Clone app using APFS copy-on-write (-c flag)
  const appClone = path.join(dir, adapter.appName);
  console.log(`[instances] Cloning ${adapter.appName} (APFS clone, near-zero disk cost)...`);
  const cpResult = run('cp', ['-cR', baseApp, appClone]);
  if (cpResult.code !== 0) {
    // Fallback to regular copy if -c not supported
    console.warn('[instances] APFS clone failed, falling back to regular copy...');
    const cpFallback = run('cp', ['-R', baseApp, appClone]);
    if (cpFallback.code !== 0) {
      throw new Error(`Failed to clone ${adapter.appName}: ${cpFallback.stderr}`);
    }
  }

  // Disable auto-update by patching Info.plist (if supported)
  if (adapter.disableAutoUpdate) {
    const plistPath = path.join(appClone, INFO_PLIST_PATH);
    if (fs.existsSync(plistPath)) {
      console.log('[instances] Disabling auto-update...');
      try {
        // Use plutil to modify plist
        run('plutil', [
          '-replace',
          'SUEnableAutomaticChecks',
          '-bool',
          'false',
          plistPath,
        ]);
        run('plutil', [
          '-replace',
          'SUPublicEDKey',
          '-string',
          '',
          plistPath,
        ]);
      } catch (_) {
        console.warn('[instances] Failed to disable auto-update via plutil');
        // Non-fatal: instance still works, just might auto-update
      }
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

  // Write instance metadata
  const meta = {
    tool: tool,
    slug: accountSlug,
    createdAt: new Date().toISOString(),
    baseApp: baseApp,
    autoUpdateDisabled: adapter.disableAutoUpdate,
    userDataDir: userDataDir,
    configDir: configDir,
  };
  atomicWrite(path.join(dir, 'profile.json'), JSON.stringify(meta, null, 2) + '\n', 0o600);

  console.log(`[instances] ✅ Instance created for ${tool}/${accountSlug}`);
  console.log(`  Location: ${dir}`);
  console.log(`  App clone: ${appClone}`);
  console.log(`  User data: ${userDataDir}`);
  console.log(`  Config: ${configDir}`);

  return {
    tool: tool,
    slug: accountSlug,
    dir: dir,
    appPath: appClone,
    userDataDir: userDataDir,
    configDir: configDir,
  };
}

// --- Instance management ---

function killAllToolInstances(tool) {
  const adapter = getAdapter(tool);
  console.log(`[instances] Closing all ${adapter.name} instances...`);
  try {
    run('pkill', ['-f', adapter.processPattern]);
  } catch (_) {
    // No instances running
  }
}

function launchInstance(tool, accountSlug) {
  const adapter = getAdapter(tool);
  const instance = getInstance(tool, accountSlug);
  if (!instance) {
    throw new Error(`No instance found for ${tool}/${accountSlug}. Create it first.`);
  }

  // Close all other instances of this tool first (deep link trap avoidance)
  killAllToolInstances(tool);

  console.log(`[instances] Launching ${adapter.name} for ${accountSlug}...`);

  // Launch with --user-data-dir and config env var
  const launchArgs = [
    '-a',
    instance.appPath,
    '--args',
    `${adapter.userDataFlag}=${instance.userDataDir}`,
  ];

  const result = run('open', launchArgs, {
    env: Object.assign({}, process.env, {
      [adapter.configEnv]: instance.configDir,
    }),
  });

  if (result.code !== 0) {
    throw new Error(`Failed to launch ${adapter.name}: ${result.stderr}`);
  }

  // Find the new PID after a short delay
  setTimeout(() => {
    const pgrepResult = run('pgrep', ['-f', adapter.processPattern]);
    if (pgrepResult.code === 0 && pgrepResult.stdout.trim()) {
      const pid = parseInt(pgrepResult.stdout.trim().split('\n')[0], 10);
      writePid(tool, accountSlug, pid);
      console.log(`[instances] Instance started (PID: ${pid})`);
    }
  }, 2000);

  return true;
}

function focusInstance(tool, accountSlug) {
  const instance = getInstance(tool, accountSlug);
  if (!instance) {
    throw new Error(`No instance found for ${tool}/${accountSlug}`);
  }

  if (!instance.running || !instance.pid) {
    throw new Error(`Instance ${tool}/${accountSlug} is not running`);
  }

  const adapter = getAdapter(tool);
  console.log(`[instances] Focusing ${adapter.name} instance for ${accountSlug}...`);

  // Use AppleScript to bring window to front
  try {
    run('osascript', [
      '-e',
      `tell application "System Events" to set frontmost of first process whose unix id is ${instance.pid} to true`,
    ]);
  } catch (_) {
    console.warn('[instances] Failed to focus window');
  }
}

function killInstance(tool, accountSlug) {
  const instance = getInstance(tool, accountSlug);
  if (!instance) {
    throw new Error(`No instance found for ${tool}/${accountSlug}`);
  }

  if (!instance.running) {
    console.log(`[instances] Instance ${tool}/${accountSlug} is not running`);
    return;
  }

  const adapter = getAdapter(tool);
  console.log(`[instances] Killing ${adapter.name} instance for ${accountSlug}...`);

  try {
    run('kill', [String(instance.pid)]);
    clearPid(tool, accountSlug);
    console.log(`[instances] Instance killed (PID: ${instance.pid})`);
  } catch (_) {
    console.error('[instances] Failed to kill instance');
    clearPid(tool, accountSlug);
  }
}

// --- Integration helpers ---

function hasInstance(tool, accountSlug) {
  return fs.existsSync(instanceDir(tool, accountSlug));
}

function ensureInstance(tool, accountSlug) {
  if (!hasInstance(tool, accountSlug)) {
    console.log(`[instances] Instance not found for ${tool}/${accountSlug}, creating...`);
    return createInstance(tool, accountSlug);
  }
  return getInstance(tool, accountSlug);
}

export {
  instancesDir,
  listInstances,
  getInstance,
  createInstance,
  ensureInstance,
  hasInstance,
  launchInstance,
  focusInstance,
  killInstance,
  killAllToolInstances,
  TOOL_ADAPTERS,
};
