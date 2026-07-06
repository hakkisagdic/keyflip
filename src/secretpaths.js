'use strict';
// SINGLE SOURCE OF TRUTH for secret-bearing paths under keyflip's config dir.
// Consumed by BOTH vcs.js (the managed .gitignore) and backup.js (the backup SKIP set)
// so the two can never drift apart. That drift is exactly what let the desktop-app OAuth
// token cache and the claude.ai `sessionKey` cookie leak into keyflip's own git history
// (and into metadata backups): `app/` was git-ignored in neither place, and
// `pre-sync-backups/` (raw tokens) was skipped by backup.js but not by vcs. ADD A NEW
// SECRET FILE OR DIR HERE — nowhere else — and every consumer picks it up.

// Directories (relative to configDir) that hold secrets or per-account secret snapshots.
// NEVER git-versioned, NEVER copied into a metadata backup.
const SECRET_DIRS = [
  'creds',            // *.cred OS-credential-store fallbacks
  'browser-sessions', // captured browser cookie DBs (*.sql)
  'app',              // desktop-app oauth token cache (app/<name>.json) + cookies (app/<name>.cookies)
  'pre-sync-backups', // pre-overwrite snapshots that contain raw OAuth access/refresh tokens
];
// Secret-shaped files, by extension (no leading dot).
const SECRET_FILE_EXTS = ['cred', 'cookies', 'key', 'token', 'pem', 'sql'];
// Secret-shaped files, by exact basename.
const SECRET_FILE_NAMES = ['.credentials.json', 'mcp-registry.json'];

// A basename is secret if it carries a secret extension, matches a secret name, or is a
// legacy/stray `<something>credentials.json`.
function isSecretFile(name) {
  const lower = String(name).toLowerCase();
  const ext = lower.indexOf('.') === -1 ? '' : lower.slice(lower.lastIndexOf('.') + 1);
  if (SECRET_FILE_EXTS.indexOf(ext) !== -1) return true;
  if (SECRET_FILE_NAMES.indexOf(lower) !== -1) return true;
  if (/credentials\.json$/.test(lower)) return true;
  return false;
}

// gitignore glob lines for the secret set: dirs as `d/`, extensions as `*.e`, names verbatim.
function gitignoreLines() {
  return SECRET_DIRS.map(function (d) { return d + '/'; })
    .concat(SECRET_FILE_EXTS.map(function (e) { return '*.' + e; }))
    .concat(SECRET_FILE_NAMES);
}

module.exports = {
  SECRET_DIRS: SECRET_DIRS,
  SECRET_FILE_EXTS: SECRET_FILE_EXTS,
  SECRET_FILE_NAMES: SECRET_FILE_NAMES,
  isSecretFile: isSecretFile,
  gitignoreLines: gitignoreLines,
};
