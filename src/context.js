// @ts-check
// Bundles all environment-dependent bits (paths, platform, credential store, clock)
// into one object so the core logic can be unit-tested with fakes.
import os from 'os';
import path from 'path';
import { createStore } from './stores/index.js';

/**
 * @typedef {Object} CredentialStore
 * @property {() => (string | null)} getLive - Get the live credential blob.
 * @property {(blob: string) => void} setLive - Set the live credential blob.
 * @property {(name: string) => (string | null)} getProfile - Get a profile's credential blob.
 * @property {(name: string, blob: string) => void} setProfile - Set a profile's credential blob.
 * @property {(name: string) => void} delProfile - Delete a profile's credentials.
 */

/**
 * @typedef {Object} KeyflipContext
 * @property {string} home - User home directory.
 * @property {string} platform - Operating system platform (darwin/linux/win32).
 * @property {string} configDir - Keyflip config directory path.
 * @property {string} claudeDir - Claude config directory path.
 * @property {string} claudeConfigPath - Path to .claude.json config file.
 * @property {string} credsFilePath - Path to .credentials.json file.
 * @property {string} claudeSettingsPath - Path to Claude settings.json.
 * @property {string | null} appDataDir - Claude desktop app data directory.
 * @property {string} account - Current system account name.
 * @property {CredentialStore} store - Credential store instance.
 * @property {() => string} now - Function returning current ISO timestamp.
 */

/**
 * @typedef {Object} CreateContextOptions
 * @property {string} [home] - Override home directory.
 * @property {string} [platform] - Override platform.
 * @property {string} [configDir] - Override keyflip config directory.
 * @property {string} [claudeDir] - Override Claude config directory.
 * @property {string} [claudeConfigPath] - Override path to .claude.json.
 * @property {string} [credsFilePath] - Override credentials file path.
 * @property {string} [claudeSettingsPath] - Override Claude settings path.
 * @property {string | null} [appDataDir] - Override app data directory.
 * @property {string} [account] - Override account name.
 * @property {CredentialStore} [store] - Override credential store.
 * @property {() => string} [now] - Override clock function.
 */

/**
 * Create the application context object bundling all environment-dependent paths,
 * platform info, credential store, and clock for use by core logic and tests.
 * @param {CreateContextOptions} [opts] - Optional overrides for testing.
 * @returns {KeyflipContext} The application context object.
 */
function createContext(opts) {
  opts = opts || {};
  const home = opts.home || os.homedir();
  const platform = opts.platform || process.platform;

  let configDir = opts.configDir || process.env.KEYFLIP_CONFIG_DIR;
  if (!configDir) {
    if (platform === 'win32') {
      const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      configDir = path.join(appData, 'keyflip');
    } else {
      const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
      configDir = path.join(xdg, 'keyflip');
    }
  }

  // Where Claude Code keeps its own config/credentials. Resolution order:
  //   explicit opts (tests) -> CLAUDE_CONFIG_DIR (Claude's own override) -> default.
  // When CLAUDE_CONFIG_DIR points at a relocated home's .claude dir, Claude puts
  // .claude.json in the PARENT (like a real Linux home), so mirror that.
  const claudeDir = opts.claudeDir || process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const claudeHome = path.basename(claudeDir) === '.claude' ? path.dirname(claudeDir) : claudeDir;
  const claudeConfigPath = opts.claudeConfigPath || path.join(claudeHome, '.claude.json');
  const credsFilePath = opts.credsFilePath || path.join(claudeDir, '.credentials.json');
  const claudeSettingsPath = opts.claudeSettingsPath || path.join(claudeDir, 'settings.json');

  // The Claude desktop app's data dir (holds its account-keyed session index).
  // The Claude desktop app's data dir. macOS + Windows have the app; Linux has
  // no official desktop app. On Windows the local index features (Cowork/session
  // consolidation, gateway, MCP-registry projection) work; the cookie/token
  // DECRYPTION features (auto-detect account, Chat) are macOS-only for now
  // (Windows encrypts with DPAPI, a different scheme).
  let appDataDir = opts.appDataDir;
  if (appDataDir === undefined) {
    if (platform === 'darwin') appDataDir = path.join(home, 'Library', 'Application Support', 'Claude');
    else if (platform === 'win32') {
      const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      appDataDir = path.join(appData, 'Claude');
    }
    // Linux: Electron's default userData is $XDG_CONFIG_HOME/<App> (falling back to ~/.config/<App>).
    // The token blobs use the SAME v10 safeStorage format as macOS; only the key source differs
    // (libsecret via secret-tool instead of the Keychain) — see appauth.getSafeStoragePassword.
    else if (platform === 'linux') {
      const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
      appDataDir = path.join(xdg, 'Claude');
    } else appDataDir = null;
  }

  let account = opts.account;
  if (!account) {
    try {
      account = os.userInfo().username;
    } catch (e) {
      account = process.env.USER || process.env.USERNAME || 'user';
    }
  }

  const store =
    opts.store ||
    createStore({
      platform: platform,
      credsFilePath: credsFilePath,
      configDir: configDir,
      account: account,
    });

  const now =
    opts.now ||
    function () {
      return new Date().toISOString();
    };

  return {
    home: home,
    platform: platform,
    configDir: configDir,
    claudeDir: claudeDir,
    claudeConfigPath: claudeConfigPath,
    credsFilePath: credsFilePath,
    claudeSettingsPath: claudeSettingsPath,
    appDataDir: appDataDir,
    account: account,
    store: store,
    now: now,
  };
}

export { createContext };
