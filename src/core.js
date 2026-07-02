'use strict';
// Account-switching logic. Pure with respect to `ctx` (see context.js): every
// side effect goes through ctx.store / ctx paths, so tests inject fakes.
const claude = require('./claude');
const profiles = require('./profiles');

function currentEmail(ctx) {
  const acc = claude.currentAccount(claude.readConfig(ctx.claudeConfigPath));
  return acc ? acc.email : '';
}

// Save the live (currently-logged-in) account into profile <name>.
function saveAs(ctx, name) {
  if (!profiles.isValidName(name)) {
    throw new Error("invalid profile name: '" + name + "' (allowed: A-Z a-z 0-9 . _ -)");
  }
  const blob = ctx.store.getLive();
  if (!blob) throw new Error('No live Claude session found. Log in first (Claude /login).');
  ctx.store.setProfile(name, blob);
  const cfg = claude.readConfig(ctx.claudeConfigPath) || {};
  const oa = cfg.oauthAccount || {};
  profiles.write(ctx.configDir, {
    name: name,
    email: oa.emailAddress || '',
    userID: cfg.userID || '',
    oauthAccount: oa,
    savedAt: ctx.now(),
  });
  return name;
}

// Pick a profile name that is either free or already belongs to `email`,
// appending -2, -3, ... so we never overwrite a *different* account.
function uniqueName(ctx, base, email) {
  let candidate = base;
  let n = 1;
  while (profiles.exists(ctx.configDir, candidate) && profiles.email(ctx.configDir, candidate) !== email) {
    n += 1;
    candidate = base + '-' + n;
  }
  return candidate;
}

// "Find & save": detect the logged-in account and store it, auto-naming from the
// email. If it's already saved (matched by email), refresh its tokens instead.
function addCurrent(ctx, nameOverride) {
  const email = currentEmail(ctx);
  if (!email) {
    throw new Error('No logged-in account detected (~/.claude.json has no account). Log in in Claude first.');
  }
  const existing = profiles.list(ctx.configDir);
  for (let i = 0; i < existing.length; i++) {
    if (profiles.email(ctx.configDir, existing[i]) === email) {
      saveAs(ctx, existing[i]);
      return { name: existing[i], email: email, refreshed: true };
    }
  }

  let name;
  if (nameOverride) {
    if (!profiles.isValidName(nameOverride)) {
      throw new Error("invalid profile name: '" + nameOverride + "' (allowed: A-Z a-z 0-9 . _ -)");
    }
    if (profiles.exists(ctx.configDir, nameOverride) && profiles.email(ctx.configDir, nameOverride) !== email) {
      throw new Error("profile '" + nameOverride + "' already exists for " +
        profiles.email(ctx.configDir, nameOverride) + '; choose another name.');
    }
    name = nameOverride;
  } else {
    let base = profiles.sanitizeName(email);
    if (profiles.exists(ctx.configDir, base) && profiles.email(ctx.configDir, base) !== email) {
      const dom = (email.split('@')[1] || '').split('.')[0];
      if (dom) base = base + '-' + dom;
    }
    name = uniqueName(ctx, base, email);
  }
  saveAs(ctx, name);
  return { name: name, email: email, refreshed: false };
}

// A stored credential must at least be a non-empty string, and if it looks like
// JSON it must parse — a truncated blob is refused instead of restored.
function validateBlob(name, blob) {
  if (typeof blob !== 'string' || !blob.trim()) {
    throw new Error("profile '" + name + "' credential data is empty — remove it and run 'ccswitch add' again");
  }
  const t = blob.trim();
  if (t[0] === '{' || t[0] === '[') {
    try { JSON.parse(t); } catch (e) {
      throw new Error("profile '" + name + "' credential data is unreadable (corrupt/truncated) — remove it and run 'ccswitch add' again");
    }
  }
}

// Load a saved profile: write its token to the live store and patch the pointer.
//
// Ordering is credential-FIRST, pointer-second:
//   * The credential (Keychain / creds file) is Claude Code's actual login; the
//     ~/.claude.json pointer is derived metadata Claude re-syncs from the token.
//     So a crash between the two writes leaves the *credential* authoritative and
//     the pointer merely lagging (Claude reconciles it) — never the reverse, which
//     would let a later "save the current account" grab the wrong token.
//   * If the pointer write fails, we roll the credential back to what it was.
function applyProfile(ctx, name) {
  const meta = profiles.read(ctx.configDir, name);
  if (!meta) throw new Error("no such profile: '" + name + "'");
  const blob = ctx.store.getProfile(name);
  if (!blob) throw new Error("profile '" + name + "' has no stored credentials");
  validateBlob(name, blob);
  const cfg = claude.loadForWrite(ctx.claudeConfigPath); // {} if missing, throws if corrupt
  // Point ~/.claude.json at the target account. An empty {} oauthAccount (e.g. a
  // --token import with no identity) is NOT a valid pointer — clear the stale keys
  // so we never leave a mixed identity (new account's token + old account's userID).
  const hasOauth = meta.oauthAccount && Object.keys(meta.oauthAccount).length > 0;
  if (hasOauth) cfg.oauthAccount = meta.oauthAccount; else delete cfg.oauthAccount;
  if (meta.userID) cfg.userID = meta.userID; else delete cfg.userID;

  let prevBlob;
  try { prevBlob = ctx.store.getLive(); } // captured for rollback if the pointer write fails
  catch (e) { prevBlob = undefined; }     // can't read previous (locked keychain) — no rollback possible

  ctx.store.setLive(blob); // credential first (Claude's real login)
  try {
    claude.writeConfig(ctx.claudeConfigPath, cfg);
  } catch (e) {
    if (prevBlob !== undefined && prevBlob !== null) {
      try { ctx.store.setLive(prevBlob); } catch (e2) { /* best effort */ }
    }
    const err = new Error('switch failed while writing the account pointer (credential rolled back): ' +
      ((e && e.message) || e));
    err.code = (e && e.code) || 'ESWITCH';
    throw err;
  }
  // Claude Code reads the Keychain before the credentials file — after a file
  // write, clear any stale Keychain copy so it can't resurrect the old account.
  try { require('./stores').reconcileStaleKeychain(ctx); } catch (e) { /* best effort */ }
}

// Before switching away, preserve the live account's (possibly rotated) token:
//  - if it already has a matching profile, re-save it there;
//  - otherwise auto-save it under a derived name so it is never lost.
function refreshCurrent(ctx, targetName) {
  const cur = currentEmail(ctx);
  if (!cur) return;
  const names = profiles.list(ctx.configDir);
  for (let i = 0; i < names.length; i++) {
    if (profiles.email(ctx.configDir, names[i]) === cur) {
      if (names[i] !== targetName) {
        try { saveAs(ctx, names[i]); } catch (e) { /* non-fatal */ }
      }
      return;
    }
  }
  // Current account isn't saved yet — capture it so its token survives the switch.
  try { addCurrent(ctx); } catch (e) { /* non-fatal */ }
}

function doSwitch(ctx, name) {
  refreshCurrent(ctx, name);
  applyProfile(ctx, name);
}

// Switch as far as the profile allows: swap the CLI creds when they were captured
// for this profile; otherwise leave the CLI alone (app-only profile). Returns
// { cli: <whether the CLI login was switched> }.
function performSwitch(ctx, name) {
  const hasCli = !!ctx.store.getProfile(name);
  if (hasCli) doSwitch(ctx, name);
  else refreshCurrent(ctx, name); // still preserve the current CLI account's tokens
  return { cli: hasCli };
}

function listProfiles(ctx) {
  const cur = currentEmail(ctx);
  return profiles.list(ctx.configDir).map(function (name, i) {
    const email = profiles.email(ctx.configDir, name);
    return { index: i + 1, name: name, email: email, active: !!email && email === cur };
  });
}

// Resolve a user argument to a profile name.
//  - a pure number is the 1-based menu index (matches what `list` shows);
//  - anything else must be an exact profile name.
function resolveProfile(ctx, arg) {
  if (arg == null) return null;
  arg = String(arg);
  const names = profiles.list(ctx.configDir);
  if (/^[0-9]+$/.test(arg)) {
    const i = parseInt(arg, 10);
    return (i >= 1 && i <= names.length) ? names[i - 1] : null;
  }
  return names.indexOf(arg) !== -1 ? arg : null;
}

function removeProfile(ctx, name) {
  ctx.store.delProfile(name);
  profiles.remove(ctx.configDir, name);
}

module.exports = {
  currentEmail: currentEmail,
  saveAs: saveAs,
  uniqueName: uniqueName,
  addCurrent: addCurrent,
  applyProfile: applyProfile,
  refreshCurrent: refreshCurrent,
  doSwitch: doSwitch,
  performSwitch: performSwitch,
  listProfiles: listProfiles,
  resolveProfile: resolveProfile,
  removeProfile: removeProfile,
};
