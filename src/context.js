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

  let configDir = opts.configDir || process.env.CCSWITCH_CONFIG_DIR;
  if (!configDir) {
    if (platform === 'win32') {
      const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      configDir = path.join(appData, 'ccswitch');
    } else {
      const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
      configDir = path.join(xdg, 'ccswitch');
    }
  }

  const claudeConfigPath = opts.claudeConfigPath || path.join(home, '.claude.json');
  const credsFilePath = opts.credsFilePath || path.join(home, '.claude', '.credentials.json');

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
    claudeConfigPath: claudeConfigPath,
    credsFilePath: credsFilePath,
    account: account,
    store: store,
    now: now,
  };
}

module.exports = { createContext: createContext };
