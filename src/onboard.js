'use strict';
// Pure helpers for the guided account-capture wizard (`keyflip setup`). The
// interactive loop lives in cli.js; these compute "what's logged in now" vs
// "what's already saved", so the wizard can auto-detect a freshly logged-in
// account and capture it. No side effects, no prompting.
const core = require('./core');
const profiles = require('./profiles');
const appauth = require('./appauth');

// Emails of every account already saved (CLI or app), lowercased, blanks dropped.
function capturedEmails(ctx) {
  const set = new Set();
  profiles.list(ctx.configDir).forEach(function (n) {
    const e = profiles.email(ctx.configDir, n);
    if (e) set.add(String(e).toLowerCase());
  });
  return set;
}

// What's signed in right now on each surface. app is null off macOS / when the
// desktop app isn't signed in / can't be read.
function snapshotLogins(ctx) {
  const cli = core.currentEmail(ctx) || null;
  let app = null;
  if (ctx.appDataDir) {
    try { const d = appauth.detectAppAccount(ctx); if (d && d.email) app = d.email; } catch (e) { /* ignore */ }
  }
  return { cli: cli, app: app };
}

// The first surface whose current login is NOT in `captured` (a Set of lowercased
// emails) — i.e. an account the user just logged into that we haven't saved.
// Returns { surface: 'CLI'|'app', email } or null.
function firstNewLogin(ctx, captured) {
  const s = snapshotLogins(ctx);
  if (s.cli && !captured.has(s.cli.toLowerCase())) return { surface: 'CLI', email: s.cli };
  if (s.app && !captured.has(s.app.toLowerCase())) return { surface: 'app', email: s.app };
  return null;
}

module.exports = {
  capturedEmails: capturedEmails,
  snapshotLogins: snapshotLogins,
  firstNewLogin: firstNewLogin,
};
