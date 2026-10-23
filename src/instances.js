// Generic multi-instance manager — isolated app instances per tool + account.
// Each instance gets:
// - Independent .app clone (APFS copy-on-write, near-zero disk overhead)
// - Isolated user data directory (cookies, sessions, configs)
// - Best-effort auto-update hardening (Info.plist keys only work when the app's updater
//   reads them; verified: ChatGPT bundles Sparkle, Claude ships Squirrel and ignores them)
// - Custom config env var for MCP/server isolation
//
// Tool adapters define per-app behavior. Currently supported: claude, kiro, chatgpt, cursor.
// Security: No secrets in git, 0600 permissions on sensitive dirs, zero-dep (macOS only).
import fs from 'fs';
import path from 'path';
import os from 'os';
import { run } from './exec.js';
import { atomicWrite } from './fsutil.js';

// A SHORT base on purpose. Kiro's main process puts a Unix-domain socket at
// <userData>/1.3.-main.sock, and macOS caps sun_path at 103 characters; under
// ~/Library/Application Support/keyflip-instances EVERY Kiro clone failed to start with
// `listen EINVAL` (even a 10-char account slug reached 104). ~/.keyflip-instances leaves
// ~65 characters for the slug, which covers normal account names.
const INSTANCES_BASE = path.join(os.homedir(), '.keyflip-instances');
const LEGACY_INSTANCES_BASE = path.join(os.homedir(), 'Library/Application Support/keyflip-instances');
let legacyChecked = false;
// Instances created before the move are still the user's data; keep them visible. Renaming is
// same-volume and atomic. If it fails (permissions, foreign mount) we do NOT delete anything.
function adoptLegacyBase() {
  if (legacyChecked) return;
  legacyChecked = true;
  try {
    if (!fs.existsSync(INSTANCES_BASE) && fs.existsSync(LEGACY_INSTANCES_BASE)) {
      fs.renameSync(LEGACY_INSTANCES_BASE, INSTANCES_BASE);
    }
  } catch (e) {
    /* best-effort: a failed move leaves the old tree untouched */
  }
}
const INFO_PLIST_PATH = 'Contents/Info.plist';

// --- Tool adapters ---
//
// Verification status (checked against real installs, 2026-10-21):
// - claude:  /Applications/Claude.app installed, Electron (ElectronAsarIntegrity present).
//            Ships Squirrel.framework, NOT Sparkle — Info.plist keys cannot stop its updater,
//            so disableAutoUpdate is false (it used to claim otherwise).
// - kiro:    /Applications/Kiro.app installed, bundle dev.kiro.desktop, Electron (ElectronAsarIntegrity)
// - chatgpt: /Applications/ChatGPT.app installed, bundle com.openai.codex, Electron +
//            Sparkle.framework (SUPublicEDKey present; SUFeedURL/SUEnableAutomaticChecks are
//            absent and get inserted). Plist hardening applies here, best-effort.
// - cursor:  standard path, NOT installed on the verification machine — createInstance()
//            fails with a clear error if the app is missing, so no silent wrong behavior.
//
// All four are Electron/Chromium apps, so --user-data-dir isolates cookies + sessions.
// configEnv is best-effort: `open` goes through LaunchServices, which may not inherit our
// environment, so the flag is the reliable isolation mechanism; the env var is only a hint.
const TOOL_ADAPTERS = {
  claude: {
    name: 'Claude',
    appName: 'Claude.app',
    baseAppPath: '/Applications/Claude.app',
    userDataFlag: '--user-data-dir',
    configEnv: 'CLAUDE_CONFIG_DIR',
    processPattern: 'Claude\\.app',
    supportsMultiInstance: true,
    // Squirrel updater, not Sparkle: Info.plist patching is inert. Claude does expose its own
    // config switch (`disableAutoUpdates` in userData/config.json), which is what we seed.
    disableAutoUpdate: false,
    autoUpdateConfig: { file: 'config.json', key: 'disableAutoUpdates', value: true },
  },
  kiro: {
    name: 'Kiro',
    appName: 'Kiro.app',
    baseAppPath: '/Applications/Kiro.app',
    userDataFlag: '--user-data-dir',
    configEnv: null, // no documented config-dir env for the desktop app
    processPattern: 'Kiro\\.app',
    supportsMultiInstance: true,
    // Kiro ships no Sparkle keys; its updater (if any) is not plist-controlled, so do not
    // pretend to disable it. An updated clone is harmless — it just replaces that clone's bundle.
    disableAutoUpdate: false,
  },
  chatgpt: {
    name: 'ChatGPT',
    appName: 'ChatGPT.app',
    baseAppPath: '/Applications/ChatGPT.app',
    userDataFlag: '--user-data-dir',
    configEnv: null,
    processPattern: 'ChatGPT\\.app',
    supportsMultiInstance: true,
    disableAutoUpdate: true, // Sparkle present; keys are inserted (best-effort)
  },
  cursor: {
    name: 'Cursor',
    appName: 'Cursor.app',
    baseAppPath: '/Applications/Cursor.app',
    userDataFlag: '--user-data-dir',
    configEnv: null, // VS Code-style apps take --extensions-dir / --user-data-dir per profile
    processPattern: 'Cursor\\.app',
    supportsMultiInstance: true,
    disableAutoUpdate: false, // Cursor updates via its own channel; not plist-controlled
  },
};

function getAdapter(tool) {
  const adapter = TOOL_ADAPTERS[tool];
  if (!adapter) {
    throw new Error(`Unsupported tool: ${tool}. Available: ${Object.keys(TOOL_ADAPTERS).join(', ')}`);
  }
  return adapter;
}

// --- Instance paths ---

function instancesDir() {
  adoptLegacyBase();
  return INSTANCES_BASE;
}

function instanceDir(tool, accountSlug) {
  adoptLegacyBase();
  return path.join(INSTANCES_BASE, tool, accountSlug);
}

// --- Auto-update policy ---
//
// An isolated clone is only useful if a self-update does not replace its bundle underneath a
// signed-in session. There is no universal switch, so the adapter decides:
//   claude  → the app's own config.json key `disableAutoUpdates` (seeded on create)
//   chatgpt → the Info.plist Sparkle keys inserted on create
//   others  → nothing keyflip can flip; report it instead of pretending
function readConfigUpdateState(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return {
      state: 'enabled',
      present: false,
      path: file,
      reason: 'config.json absent (the app default is auto-updates on)',
    };
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (_) {
    return { state: 'invalid', present: true, path: file, reason: 'config.json is not valid JSON' };
  }
  // Claude resolves `autoUpdate.disabled ?? disableAutoUpdates` — mirror that precedence.
  const value =
    cfg && cfg.autoUpdate && cfg.autoUpdate.disabled !== undefined
      ? cfg.autoUpdate.disabled
      : cfg && cfg.disableAutoUpdates;
  return { state: value === true ? 'disabled' : 'enabled', present: true, path: file };
}

function readSparkleUpdateState(plistPath) {
  if (!fs.existsSync(plistPath)) {
    return { state: 'unknown', path: plistPath, reason: 'Info.plist missing' };
  }
  const r = run('plutil', ['-p', plistPath]);
  if (r.code !== 0) {
    return { state: 'unknown', path: plistPath, reason: 'Info.plist unreadable' };
  }
  // Both keys are required: checks explicitly off AND an empty feed.
  const checksOff = /"SUEnableAutomaticChecks"\s*=>\s*false/.test(r.stdout);
  const feedEmpty = /"SUFeedURL"\s*=>\s*""/.test(r.stdout);
  return { state: checksOff && feedEmpty ? 'disabled' : 'enabled', path: plistPath };
}

function updateMechanism(appPath) {
  if (!appPath) return null;
  if (fs.existsSync(path.join(appPath, 'Contents/Frameworks/Sparkle.framework'))) return 'sparkle';
  if (fs.existsSync(path.join(appPath, 'Contents/Frameworks/Squirrel.framework'))) return 'squirrel';
  return null;
}

// Live update state for one app (base install or instance clone), read on demand so doctor
// never trusts the creation-time metadata.
function updateState(tool, userDataDir, appPath) {
  const mechanism = updateMechanism(appPath);
  if (tool === 'claude' && userDataDir) {
    return Object.assign(
      { mechanism: mechanism || 'squirrel', control: 'config' },
      readConfigUpdateState(path.join(userDataDir, 'config.json')),
    );
  }
  if (tool === 'chatgpt' && appPath) {
    return Object.assign(
      { mechanism: mechanism || 'sparkle', control: 'plist' },
      readSparkleUpdateState(path.join(appPath, INFO_PLIST_PATH)),
    );
  }
  return {
    state: mechanism ? 'uncontrollable' : 'unknown',
    mechanism: mechanism || 'unknown',
    control: null,
    path: appPath || null,
    reason: mechanism ? 'no keyflip switch for this updater' : 'no recognized updater framework',
  };
}

// Write the app's own switch into a userData/config.json that may not exist yet. Electron apps
// create this file on first launch, so an empty/absent file is the normal pre-launch state.
function seedConfigSwitch(adapter, userDataDir) {
  const cfgPath = path.join(userDataDir, adapter.autoUpdateConfig.file);
  let cfg = {};
  try {
    if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (_) {
    cfg = {}; // unreadable config: start clean rather than refusing to harden
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
  cfg[adapter.autoUpdateConfig.key] = adapter.autoUpdateConfig.value;
  // Claude's nested `autoUpdate.disabled` wins over the flat key; flip it too when present so the
  // switch is actually effective, while leaving the rest of that object untouched.
  if (cfg.autoUpdate && typeof cfg.autoUpdate === 'object' && !Array.isArray(cfg.autoUpdate)) {
    cfg.autoUpdate.disabled = adapter.autoUpdateConfig.value;
  }
  atomicWrite(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 0o600);
  return cfgPath;
}

// The Info.plist keys above are sealed by the app's code signature, so patching them makes the
// clone unlaunchable (`launchd job spawn failed`, POSIX 163). Re-signing only the OUTER bundle
// ad-hoc is enough and leaves Apple's nested helpers untouched; the entitlements must not contain
// Apple-issued identifiers (application-identifier/team-id/aps/keychain groups) or AMFI rejects
// the signature. disable-library-validation is required because the main binary now has a
// different signer from the bundled Electron/Codex frameworks it loads.
const ADHOC_ENTITLEMENTS =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
  '<plist version="1.0"><dict>\n' +
  '<key>com.apple.security.cs.allow-jit</key><true/>\n' +
  '<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>\n' +
  '<key>com.apple.security.cs.disable-library-validation</key><true/>\n' +
  '<key>com.apple.security.network.client</key><true/>\n' +
  '<key>com.apple.security.device.audio-input</key><true/>\n' +
  '<key>com.apple.security.device.camera</key><true/>\n' +
  '<key>com.apple.security.automation.apple-events</key><true/>\n' +
  '<key>com.apple.security.files.user-selected.read-write</key><true/>\n' +
  '<key>com.apple.security.personal-information.calendars</key><true/>\n' +
  '</dict></plist>\n';

function resignAdhoc(appPath, instanceDir) {
  const entPath = path.join(instanceDir, '.sign-entitlements.plist');
  try {
    atomicWrite(entPath, ADHOC_ENTITLEMENTS, 0o600);
    const r = run(
      'codesign',
      ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', entPath, appPath],
      null,
      { timeoutMs: 120000 },
    );
    return r.code === 0;
  } catch (e) {
    return false;
  } finally {
    try {
      fs.unlinkSync(entPath);
    } catch (_) {
      /* ignore */
    }
  }
}

// Patch the plist AND keep the clone launchable. If signing fails, put the original plist back:
// the untouched clone still verifies and starts, it just keeps its updater (honest but useful).
function hardenPlistKeepingSignature(appPath, baseApp, instanceDir) {
  if (!hardenPlist(appPath)) return false;
  if (resignAdhoc(appPath, instanceDir)) return true;
  try {
    fs.copyFileSync(path.join(baseApp, INFO_PLIST_PATH), path.join(appPath, INFO_PLIST_PATH));
  } catch (_) {
    /* If the restore fails the caller still reports the live plist state honestly. */
  }
  return false;
}

// Best-effort Sparkle hardening. The base plist often has NO SUEnableAutomaticChecks key
// (verified on Claude + Kiro), so -replace alone fails; fall back to insert.
function hardenPlist(appPath) {
  const plistPath = path.join(appPath, INFO_PLIST_PATH);
  if (!fs.existsSync(plistPath)) return false;
  const setKey = (key, type, value) => {
    const replaced = run('plutil', ['-replace', key, type, value, plistPath]);
    if (replaced.code === 0) return true;
    const inserted = run('plutil', ['-insert', key, type, value, plistPath]);
    return inserted.code === 0;
  };
  const okChecks = setKey('SUEnableAutomaticChecks', '-bool', 'false');
  const okFeed = setKey('SUFeedURL', '-string', '');
  return okChecks || okFeed;
}

// Apply whatever switch this adapter has to an existing instance, then re-read the live state so
// callers (doctor, CLI) report what actually landed instead of what was intended.
function hardenInstance(tool, accountSlug, base) {
  const adapter = getAdapter(tool);
  const instance = getInstance(tool, accountSlug, base);
  if (!instance) {
    throw new Error(`No instance found for ${tool}/${accountSlug}`);
  }
  // A running app owns config.json in memory and rewrites it on exit; writing underneath it would
  // look hardened now and silently revert later. Only config-controlled tools need the guard.
  if (adapter.autoUpdateConfig && instance.running) {
    throw new Error(
      `Instance ${tool}/${accountSlug} is running — quit it first with ` +
        `\`keyflip instance kill ${tool} ${accountSlug}\`, then re-run harden`,
    );
  }
  if (adapter.autoUpdateConfig) seedConfigSwitch(adapter, instance.userDataDir);
  if (adapter.disableAutoUpdate) hardenPlistKeepingSignature(instance.appPath, adapter.baseAppPath, instance.dir);
  const state = updateState(tool, instance.userDataDir, instance.appPath);
  // Keep profile.json honest: in old instances it echoed the adapter flag, not the live state.
  try {
    const metaPath = path.join(instance.dir, 'profile.json');
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) || {};
    } catch (_) {
      meta = {};
    }
    meta.autoUpdateDisabled = state.state === 'disabled';
    meta.autoUpdateMethod = state.control || null;
    atomicWrite(metaPath, JSON.stringify(meta, null, 2) + '\n', 0o600);
  } catch (_) {
    // metadata is advisory
  }
  return state;
}

function pidFile(tool, accountSlug, base) {
  return path.join(base || instancesDir(), tool, accountSlug, 'instance.pid');
}

// --- Profile discovery & metadata ---

function listInstances(tool, base) {
  getAdapter(tool); // reject unknown tools instead of silently returning []
  const toolDir = path.join(base || instancesDir(), tool);
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
      const pid = findRunningPid(tool, slug, base);

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

function getInstance(tool, accountSlug, base) {
  const dir = path.join(base || instancesDir(), tool, accountSlug);
  if (!fs.existsSync(dir)) return null;

  const instances = listInstances(tool, base);
  return instances.find((p) => p.slug === accountSlug) || null;
}

// Every instance across every known adapter — what `keyflip instance list` and the MCP
// `keyflip_instances` tool render when no tool is given.
function listAllInstances(base) {
  const all = [];
  Object.keys(TOOL_ADAPTERS).forEach((tool) => {
    try {
      all.push(...listInstances(tool, base));
    } catch (_) {
      // an adapter whose dir is unreadable must not hide the others
    }
  });
  return all;
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

function readPid(tool, accountSlug, base) {
  const p = pidFile(tool, accountSlug, base);
  try {
    if (fs.existsSync(p)) {
      return parseInt(fs.readFileSync(p, 'utf8').trim(), 10);
    }
  } catch (_) {
    // ignore
  }
  return null;
}

function clearPid(tool, accountSlug, base) {
  const p = pidFile(tool, accountSlug, base);
  try {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  } catch (_) {
    // ignore
  }
}

function findRunningPid(tool, accountSlug, base) {
  const pid = readPid(tool, accountSlug, base);
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
  clearPid(tool, accountSlug, base);
  return null;
}

// --- Instance creation ---

function ensureBaseApp(adapter) {
  if (!fs.existsSync(adapter.baseAppPath)) {
    throw new Error(`${adapter.appName} not found at ${adapter.baseAppPath}. Please install it first.`);
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

  // Seed the app's own update switch before first launch (Claude: userData/config.json).
  if (adapter.autoUpdateConfig) {
    console.log('[instances] Disabling auto-updates via the app config...');
    seedConfigSwitch(adapter, userDataDir);
  }

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

  // Best-effort auto-update hardening by patching Info.plist. Only apps whose updater reads
  // these keys (Sparkle) are affected; Squirrel-based apps ignore them.
  if (adapter.disableAutoUpdate) {
    console.log('[instances] Hardening auto-update keys (best-effort)...');
    if (!hardenPlistKeepingSignature(appClone, baseApp, dir)) {
      console.warn('[instances] Could not disable auto-updates (non-fatal: this clone may update itself)');
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

  // Read the live switch rather than echoing adapter intent: plutil/config writes can fail.
  const liveUpdate = updateState(tool, userDataDir, appClone);

  // Write instance metadata
  const meta = {
    tool: tool,
    slug: accountSlug,
    createdAt: new Date().toISOString(),
    baseApp: baseApp,
    autoUpdateDisabled: liveUpdate.state === 'disabled',
    autoUpdateMethod: liveUpdate.control || null,
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

  // Launch with --user-data-dir and (when the tool defines one) a config env var
  const launchArgs = ['-a', instance.appPath, '--args', `${adapter.userDataFlag}=${instance.userDataDir}`];

  const env = Object.assign({}, process.env);
  if (adapter.configEnv) env[adapter.configEnv] = instance.configDir;

  // run(cmd, args, input, opts): the third slot is stdin, not options — passing { env } there threw
  // ("options.stdio[0] must be a string or Buffer") on every launch.
  const result = run('open', launchArgs, undefined, { env: env });

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

// Every live process whose command line points into this instance dir. Killing only the PID that
// `open` started left Electron helpers behind (ChatGPT's crashpad handlers and its global
// bare-modifier-monitor survived indefinitely), so cleanup must be by instance path — the one
// string every process of that clone shares. Exact substring match, no regex from user data.
function pidsForDir(dir) {
  const r = run('ps', ['-axo', 'pid=,command=']);
  if (r.code !== 0) return [];
  const needle = dir + path.sep; // boundary-safe: "work" must not match "work2"
  const out = [];
  String(r.stdout)
    .split('\n')
    .forEach(function (line) {
      if (line.indexOf(needle) === -1) return;
      const pid = parseInt(line.trim().split(/\s+/)[0], 10);
      if (pid > 0 && pid !== process.pid) out.push(pid);
    });
  return out;
}

function killInstance(tool, accountSlug) {
  const instance = getInstance(tool, accountSlug);
  if (!instance) {
    throw new Error(`No instance found for ${tool}/${accountSlug}`);
  }

  const adapter = getAdapter(tool);
  const pids = pidsForDir(instance.dir);
  if (!instance.running && !pids.length) {
    console.log(`[instances] Instance ${tool}/${accountSlug} is not running`);
    return;
  }

  console.log(`[instances] Killing ${adapter.name} instance for ${accountSlug}...`);

  if (pids.indexOf(instance.pid) === -1 && instance.pid) pids.push(instance.pid);
  pids.forEach(function (pid) {
    try {
      run('kill', [String(pid)]);
    } catch (_) {
      /* already gone */
    }
  });

  // Children may take a moment to unwind; anything still holding the clone gets SIGKILL.
  setTimeout(function () {
    const left = pidsForDir(instance.dir);
    left.forEach(function (pid) {
      try {
        run('kill', ['-9', String(pid)]);
      } catch (_) {
        /* ignore */
      }
    });
    clearPid(tool, accountSlug);
    if (left.length) console.log(`[instances] Force-killed ${left.length} leftover process(es)`);
    console.log(
      '[instances] Instance killed' + (instance.pid ? ` (PID: ${instance.pid})` : ' (cleaned up leftover processes)'),
    );
  }, 2000);
  // The pending timer keeps the CLI alive until the sweep completes; the caller prints success
  // after this function returns (the process exits only once the timer has fired).
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
  listAllInstances,
  getInstance,
  createInstance,
  ensureInstance,
  hasInstance,
  launchInstance,
  focusInstance,
  killInstance,
  killAllToolInstances,
  updateState,
  hardenInstance,
  TOOL_ADAPTERS,
};
