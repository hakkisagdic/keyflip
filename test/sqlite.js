// Some suites build REAL SQLite fixtures by shelling out to the sqlite3 CLI — deliberately, because
// that is the same binary keyflip itself uses to copy and read a Chromium cookie jar, so a fixture
// written by hand would not be testing the code path. Where the binary is not installed (Windows CI
// runners, slim containers) those tests cannot run at all: they must skip with a reason, not fail
// with `spawnSync sqlite3 ENOENT`, which reads like a broken build on a machine that is fine.
//
// Usage: `test('…', { skip: SQLITE_SKIP }, function () { … })`.
import { execFileSync } from 'child_process';

function hasSqlite3() {
  try {
    execFileSync('sqlite3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

const SQLITE_SKIP = hasSqlite3() ? false : 'the sqlite3 CLI is not on PATH';

export { hasSqlite3, SQLITE_SKIP };
