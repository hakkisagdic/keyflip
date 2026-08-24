import assert from 'node:assert';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { MemoryStore } from '../src/stores/index.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-test-'));
}

// A hermetic context: temp home, in-memory credential store, fixed clock.
function makeCtx(overrides) {
  overrides = overrides || {};
  const home = overrides.home || tmpdir();
  const configDir = path.join(home, '.config', 'keyflip');
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
    now:
      overrides.now ||
      function () {
        return '2026-01-01T00:00:00.000Z';
      },
  };
}

function writeClaude(ctx, obj) {
  fs.writeFileSync(ctx.claudeConfigPath, JSON.stringify(obj, null, 2));
}

function assertPrivateMode(file, message) {
  const st = fs.statSync(file);
  const label = message || file;
  if (process.platform === 'win32') {
    assert.ok(st.isFile(), label + ' — expected a regular file');
    fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
    return;
  }
  const mode = st.mode & 0o777;
  assert.strictEqual(mode, 0o600, label + ' — expected 0600, got 0' + mode.toString(8));
}

export { tmpdir, makeCtx, writeClaude, assertPrivateMode };
