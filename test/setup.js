// Preloaded into every test process (`node --import ./test/setup.js --test`, see package.json).
//
// The suite creates a fresh temp home per test — ~14k directories per run across ~50 call sites —
// and nothing removed them, so they piled up in the OS temp dir run after run. Rather than add a
// cleanup to every call site, give each test process a private temp root and remove it on exit:
// os.tmpdir() reads these variables on every call, so every mkdtemp in the tests, in the code
// under test and in the children they spawn lands inside it.
import fs from 'fs';
import os from 'os';
import path from 'path';

// realpath: on macOS os.tmpdir() is a symlinked path (/var → /private/var); code that resolves
// paths would otherwise disagree with the temp home it was handed.
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'keyflip-testrun-'));
process.env.TMPDIR = root; // POSIX
process.env.TEMP = root; // Windows
process.env.TMP = root;

process.on('exit', function () {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 2 });
  } catch (e) {
    /* best effort — a file still held open on Windows is not worth failing the run for */
  }
});
