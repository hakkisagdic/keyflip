'use strict';
// Portable, versioned export/import of saved accounts — for backups and moving to
// a new machine. The envelope contains CLI credential blobs (SECRETS — the file
// is written 0600 and callers must warn). Desktop-app logins are intentionally
// EXCLUDED: they're encrypted with a machine-specific safeStorage key and cannot
// work on another machine (re-run `ccswitch add` there instead).
const profiles = require('./profiles');

const FORMAT = 'ccswitch-export';
const VERSION = 1;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Build the envelope object. Profiles whose credentials can't be read (locked
// keychain) are reported in `skipped` rather than failing the whole export.
function buildExport(ctx) {
  const accounts = [];
  const skipped = [];
  profiles.list(ctx.configDir).forEach(function (name) {
    const meta = profiles.read(ctx.configDir, name);
    let blob = null;
    try { blob = ctx.store.getProfile(name); } catch (e) { blob = null; }
    if (!blob) { skipped.push(name); return; }
    accounts.push({
      name: name,
      email: (meta && meta.email) || '',
      oauthAccount: (meta && meta.oauthAccount) || {},
      userID: (meta && meta.userID) || '',
      cliCredentials: blob,
    });
  });
  return {
    envelope: { format: FORMAT, version: VERSION, exportedAt: ctx.now(), accounts: accounts },
    skipped: skipped,
  };
}

// Validate EVERYTHING first, then write — a bad envelope changes nothing.
// Returns { imported: [names], skipped: [names] } or throws with a clear reason.
function applyImport(ctx, envelope, opts) {
  opts = opts || {};
  if (!envelope || envelope.format !== FORMAT) throw new Error('not a ccswitch export file');
  if (envelope.version !== VERSION) throw new Error('unsupported export version ' + envelope.version + ' (this ccswitch understands v' + VERSION + ')');
  if (!Array.isArray(envelope.accounts) || !envelope.accounts.length) throw new Error('export contains no accounts');

  const seen = Object.create(null);
  envelope.accounts.forEach(function (a, i) {
    const where = 'account #' + (i + 1);
    if (!a || typeof a !== 'object') throw new Error(where + ' is invalid');
    if (!profiles.isValidName(a.name)) throw new Error(where + " has an invalid name: '" + a.name + "'");
    if (seen[a.name]) throw new Error("duplicate account name in export: '" + a.name + "'");
    seen[a.name] = true;
    if (a.email && !EMAIL_RE.test(a.email)) throw new Error(where + " has an invalid email: '" + a.email + "'");
    if (typeof a.cliCredentials !== 'string' || !a.cliCredentials.trim()) throw new Error(where + ' has no credentials');
    const t = a.cliCredentials.trim();
    if (t[0] === '{' || t[0] === '[') {
      try { JSON.parse(t); } catch (e) { throw new Error(where + ' credentials are corrupt (invalid JSON)'); }
    }
  });

  const imported = [];
  const skipped = [];
  envelope.accounts.forEach(function (a) {
    if (profiles.exists(ctx.configDir, a.name) && !opts.force) { skipped.push(a.name); return; }
    ctx.store.setProfile(a.name, a.cliCredentials);
    profiles.write(ctx.configDir, {
      name: a.name,
      email: a.email || '',
      oauthAccount: a.oauthAccount || {},
      userID: a.userID || '',
      savedAt: ctx.now(),
      importedAt: ctx.now(),
    });
    imported.push(a.name);
  });
  return { imported: imported, skipped: skipped };
}

module.exports = { buildExport: buildExport, applyImport: applyImport, FORMAT: FORMAT, VERSION: VERSION };
