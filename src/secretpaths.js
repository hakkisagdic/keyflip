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
  'creds', // *.cred OS-credential-store fallbacks
  'browser-sessions', // captured browser cookie DBs (*.sql)
  'app', // desktop-app oauth token cache (app/<name>.json) + cookies (app/<name>.cookies)
  'pre-sync-backups', // pre-overwrite snapshots that contain raw OAuth access/refresh tokens
  // Third-party tool captures (surfaces/<tool>/<account>/auth.json, extension leveldb, …).
  // Their basenames look innocent (auth.json, CURRENT, 000003.log), so the DIR has to be the
  // secret boundary — otherwise a capture is git-tracked and backed up like plain metadata.
  'surfaces',
  // #35: the merged CONVERSATION TEXT of a thread (`keyflip threads mirror`, opt-in). Like `surfaces`,
  // the basename is innocent (`<slug>.md`) and the file sits inside the git-versioned state dir, so the
  // DIR is the boundary. Thread POINTERS stay versioned on purpose; their transcripts never do.
  'thread-mirror',
];
// Secret-shaped files, by extension (no leading dot).
// `pre-scrub` is the reversible-copy suffix `memory audit --apply` leaves behind: a redacted keepsake
// keeps its ORIGINAL (secret intact) next to it, so that file is exactly as secret as the one it came
// from — and it sits inside the git-versioned config dir, so it must be ignored or it becomes a leak.
const SECRET_FILE_EXTS = ['cred', 'cookies', 'key', 'token', 'pem', 'sql', 'pre-scrub'];
// Secret-shaped files, by exact basename. `auth.json` is the credential file of Codex/OpenAI and
// opencode (surface.js already declares it `secret: true`), so it must never be versioned either.
const SECRET_FILE_NAMES = ['.credentials.json', 'mcp-registry.json', 'auth.json'];

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
  return SECRET_DIRS.map(function (d) {
    return d + '/';
  })
    .concat(
      SECRET_FILE_EXTS.map(function (e) {
        return '*.' + e;
      }),
    )
    .concat(SECRET_FILE_NAMES);
}

export { SECRET_DIRS, SECRET_FILE_EXTS, SECRET_FILE_NAMES, isSecretFile, gitignoreLines };
