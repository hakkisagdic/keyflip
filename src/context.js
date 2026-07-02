'use strict';
// Bundles all environment-dependent bits (paths, platform, credential store, clock)
// into one object so the core logic can be unit-tested with fakes.
const os = require('os');
const path = require('path');
const { createStore } = require('./stores');

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
  const claudeDir = opts.claudeDir || process.env.CLAUDE_CONFIG_DIR ||
    path.join(home, '.claude');
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
    else if (platform === 'win32') { const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming'); appDataDir = path.join(appData, 'Claude'); }
    else appDataDir = null;
  }

  let account = opts.account;
  if (!account) {
    try { account = os.userInfo().username; } catch (e) { account = process.env.USER || process.env.USERNAME || 'user'; }
  }

  const store = opts.store || createStore({
    platform: platform,
    credsFilePath: credsFilePath,
    configDir: configDir,
    account: account,
  });

  const now = opts.now || function () { return new Date().toISOString(); };

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

module.exports = { createContext: createContext };
