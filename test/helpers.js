'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const { MemoryStore } = require('../src/stores');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-test-'));
}

// A hermetic context: temp home, in-memory credential store, fixed clock.
function makeCtx(overrides) {
  overrides = overrides || {};
  const home = overrides.home || tmpdir();
  const configDir = path.join(home, '.config', 'ccswitch');
  const claudeConfigPath = path.join(home, '.claude.json');
  const credsFilePath = path.join(home, '.claude', '.credentials.json');
  fs.mkdirSync(configDir, { recursive: true });
  return {
    home: home,
    platform: overrides.platform || 'linux',
    configDir: configDir,
    claudeConfigPath: claudeConfigPath,
    credsFilePath: credsFilePath,
    account: 'tester',
    store: overrides.store || new MemoryStore(),
    now: overrides.now || function () { return '2026-01-01T00:00:00.000Z'; },
  };
}

function writeClaude(ctx, obj) {
  fs.writeFileSync(ctx.claudeConfigPath, JSON.stringify(obj, null, 2));
}

module.exports = { tmpdir: tmpdir, makeCtx: makeCtx, writeClaude: writeClaude };
