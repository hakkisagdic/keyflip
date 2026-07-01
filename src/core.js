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
// Transactional: the config pointer is written first and rolled back if the live
// credential write fails, so a half-switched state never survives.
function applyProfile(ctx, name) {
  const meta = profiles.read(ctx.configDir, name);
  if (!meta) throw new Error("no such profile: '" + name + "'");
  const blob = ctx.store.getProfile(name);
  if (!blob) throw new Error("profile '" + name + "' has no stored credentials");
  validateBlob(name, blob);
  const cfg = claude.loadForWrite(ctx.claudeConfigPath); // {} if missing, throws if corrupt
  const prevCfg = JSON.parse(JSON.stringify(cfg));
  if (meta.oauthAccount) cfg.oauthAccount = meta.oauthAccount;
  if (meta.userID) cfg.userID = meta.userID;
  claude.writeConfig(ctx.claudeConfigPath, cfg);
  try {
    ctx.store.setLive(blob);
  } catch (e) {
    try { claude.writeConfig(ctx.claudeConfigPath, prevCfg); } catch (e2) { /* best effort */ }
    const err = new Error('switch failed while writing the live credential (rolled back): ' +
      ((e && e.message) || e));
    err.code = (e && e.code) || 'ESWITCH';
    throw err;
  }
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
