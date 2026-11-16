// Cross-platform test runner for Node >= 20 (Ubuntu, macOS, Windows).
//
// Why this exists instead of bare `node --test`:
// 1. Bare `node --test` walks the whole repo and picks up Gradle's generated
//    HTML test report (`jetbrains-keyflip/build/reports/tests/test/js/report.js`)
//    whenever the JetBrains plugin has been built locally.
// 2. Quoted globs (`"test/*.test.js"`) fail on Node 20 (built-in glob support in
//    `node --test` landed in Node 21+), and unquoted globs are not expanded by
//    `cmd.exe` on Windows (`npm test` runs scripts under `cmd /d /s /c`).
// 3. Passing directories (`test/`) throws `ERR_UNSUPPORTED_DIR_IMPORT` on Node 24.
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DIRS = ['test', 'issuer', path.join('issuer', 'adapters')];
const files = [];

for (const dir of DIRS) {
  if (!fs.existsSync(dir)) continue;
  const entries = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .sort();
  for (const entry of entries) {
    files.push(path.join(dir, entry));
  }
}

const extraArgs = process.argv.slice(2);

// Safety net for the whole run: the offline flag arms src/spawnguard.js in every test process and in
// every CLI a test spawns; a PATH shim directory (osascript, open, security stand-ins that only write a
// line to a log) catches bare-name calls; test/final-no-real-spawns.js fails the run if the log is not
// empty, so a test that would have reached a real desktop tool cannot go unnoticed.
const guardRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'keyflip-spawnguard-'));
const shimDir = path.join(guardRoot, 'bin');
const logFile = path.join(guardRoot, 'real-spawns.log');
fs.mkdirSync(shimDir);
fs.writeFileSync(logFile, '');
if (process.platform !== 'win32') {
  for (const name of ['osascript', 'open', 'security']) {
    const shim = path.join(shimDir, name);
    fs.writeFileSync(shim, '#!/bin/sh\necho "shim ' + name + ' $*" >> "$KEYFLIP_SPAWN_LOG"\nexit 0\n');
    fs.chmodSync(shim, 0o755);
  }
}
const env = Object.assign({}, process.env, {
  KEYFLIP_TEST_OFFLINE: '1',
  KEYFLIP_SPAWN_LOG: logFile,
  PATH: shimDir + path.delimiter + (process.env.PATH || ''),
});

const res = spawnSync(process.execPath, ['--import', './test/setup.js', '--test', ...extraArgs, ...files], {
  stdio: 'inherit',
  env,
});
let status = res.status ?? 1;
const fin = spawnSync(process.execPath, ['--test', path.join('test', 'final-no-real-spawns.js')], {
  stdio: 'inherit',
  env,
});
if (fin.status !== 0) status = fin.status ?? 1;
try {
  fs.rmSync(guardRoot, { recursive: true, force: true });
} catch {
  /* best effort */
}
process.exit(status);
