'use strict';
// Cross-platform "write a file as safely as we can".
// POSIX: temp + atomic rename. Windows: rename onto an open/existing file can
// fail (EPERM/EACCES/EBUSY), so fall back to an in-place write.
const fs = require('fs');
const path = require('path');

function atomicWrite(filePath, data, mode) {
  mode = mode || 0o600;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp-' + process.pid; // unique -> never inherits a stale file's mode
  try { fs.rmSync(tmp, { force: true }); } catch (e) { /* ignore */ }
  fs.writeFileSync(tmp, data, { mode: mode });
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    // Windows: destination held open by Claude, or replace-existing not permitted.
    try {
      fs.writeFileSync(filePath, data, { mode: mode });
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch (e2) { /* ignore */ }
    }
  }
  try { fs.chmodSync(filePath, mode); } catch (e) { /* best effort (e.g. Windows) */ }
}

module.exports = { atomicWrite: atomicWrite };
