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
const res = spawnSync(process.execPath, ['--import', './test/setup.js', '--test', ...extraArgs, ...files], {
  stdio: 'inherit',
});

process.exit(res.status ?? 1);
