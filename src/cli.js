'use strict';
// Argument parsing + command dispatch. Thin wrapper over core/menu.
const fs = require('fs');
const path = require('path');
const { createContext } = require('./context');
const core = require('./core');
const claude = require('./claude');
const profiles = require('./profiles');
const appctl = require('./platform');
const appsessions = require('./appsessions');
const appauth = require('./appauth');

let VERSION = '0.0.0';
try { VERSION = require('../package.json').version; } catch (e) { /* ignore */ }

function print(s) { process.stdout.write((s == null ? '' : s) + '\n'); }
function fail(msg) { process.stderr.write('❌ ' + msg + '\n'); process.exitCode = 1; }

function usage() {
  print('ccswitch ' + VERSION + ' — switch between Anthropic / Claude Code accounts (macOS, Linux, Windows)');
  print('');
  print('  ccswitch                       open the interactive menu (same as the app)');
  print('  ccswitch add [name]            detect the logged-in (CLI) account and save it (auto-named)');
  print('  ccswitch capture-app [name]    capture the desktop app\'s current login (macOS). Works without');
  print('                                 a CLI login: creates the account entry, auto-detecting it when');
  print('                                 possible — otherwise pass a name. Run once per account.');
  print('  ccswitch switch <name|number>  switch accounts   [--restart quits/reopens Claude, --force]');
  print('  ccswitch list                  list saved accounts (* = active)');
  print('  ccswitch remove <name|number>  delete a saved account');
  print('  ccswitch clean [--logout]      reset ccswitch\'s saved data (asks to confirm; --force skips).');
  print('                                 Add --logout to ALSO sign out of Claude Code + the desktop app.');
  print('  ccswitch current               show the active account');
  print('  ccswitch consolidate           merge the desktop app\'s Code sessions from all');
  print('                                 accounts into the active one (macOS; runs on switch too)');
  print('  ccswitch version');
  print('');
  print('How it works: OAuth tokens stay in the OS credential store (macOS Keychain, or');
  print("~/.claude/.credentials.json elsewhere); only the pointer in ~/.claude.json and the");
  print('live credential are swapped. Session history in ~/.claude/projects is account-independent.');
}

function confirm(question) {
  return new Promise(function (resolve) {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, function (a) { rl.close(); resolve(/^y(es)?$/i.test((a || '').trim())); });
  });
}

async function cmdSwitch(ctx, rest) {
  const arg = rest[0];
  if (!arg) return fail('usage: ccswitch switch <name|number> [--restart|--force]');
  const autoYes = rest.indexOf('--restart') !== -1 || rest.indexOf('-y') !== -1 || rest.indexOf('--yes') !== -1;
  const force = rest.indexOf('--force') !== -1;
  const name = core.resolveProfile(ctx, arg);
  if (!name) return fail("no such profile: '" + arg + "' (see: ccswitch list)");
  const em = profiles.email(ctx.configDir, name);
  if (em && em === core.currentEmail(ctx)) { print("'" + em + "' is already active."); return; }

  const running = appctl.isClaudeRunning(ctx.platform);
  const manage = appctl.canManageApp(ctx.platform);

  // --force: swap in place without closing the app.
  if (running && force) {
    const did = core.performSwitch(ctx, name);
    if (!did.cli) print("  ↳ CLI login for this profile isn't captured — nothing to swap for the CLI.");
    print('✅ Switched to: ' + (em || name) + '. Restart Claude to apply.');
    return;
  }
  // App is open and we can close it: confirm, then close -> switch -> reopen.
  if (running && manage) {
    if (!autoYes) {
      if (!process.stdin.isTTY) {
        return fail('Claude / Claude Code is open. Re-run with --restart to close & reopen it, ' +
          '--force to switch without closing, or quit it yourself first.');
      }
      const ok = await confirm('Claude / Claude Code is open and will be closed to switch. Continue? [y/N] ');
      if (!ok) { print('Cancelled — nothing was changed.'); return; }
    }
    print('Quitting Claude...'); appctl.quitClaude(ctx.platform); await waitForQuit(ctx);
    const did = core.performSwitch(ctx, name);
    if (!did.cli) print("  ↳ CLI login for this profile isn't captured — switched the desktop app only.");
    switchDesktopLogin(ctx, name);
    consolidateAndReport(ctx);
    print('Reopening Claude...'); appctl.openClaude(ctx.platform);
    print('✅ Switched to: ' + (em || name));
    return;
  }
  // App is open but we cannot auto-close it (Linux/Windows).
  if (running && !manage) {
    if (autoYes) {
      core.performSwitch(ctx, name);
      print('✅ Switched to: ' + (em || name) + '. Restart Claude Code to apply.');
      return;
    }
    return fail('Claude / Claude Code is open — close it first (it cannot be auto-closed on this OS), or re-run with --force.');
  }
  // Not running: just swap.
  const did = core.performSwitch(ctx, name);
  if (!did.cli) print("  ↳ CLI login for this profile isn't captured — switched the desktop app only.");
  switchDesktopLogin(ctx, name);
  consolidateAndReport(ctx);
  print('✅ Switched to: ' + (em || name) + (manage ? '' : '. Restart Claude Code to apply.'));
}

function switchDesktopLogin(ctx, name) {
  // Only touch config.json while the app is closed.
  if (appctl.isClaudeRunning(ctx.platform)) return { ok: false };
  const a = appauth.applyFromProfile(ctx, name);
  if (a.ok) print('  ↳ switched the Claude desktop-app login too.');
  return a;
}

// Capture the desktop app's CURRENT login into a profile — fully independent of
// the CLI (which may be logged out or on another account). Creates the profile if
// needed: identifies the app's account by decrypting its token cache (org uuid),
// mapping it to the app's per-account folders, and best-effort finding the email.
function cmdCaptureApp(ctx, rest) {
  if (!ctx.appDataDir) return fail('The desktop app store is macOS-only.');
  let name = rest[0] || null;
  if (name && !profiles.isValidName(name)) return fail("invalid profile name: '" + name + "'");

  const det = appauth.detectAppAccount(ctx) || {};
  const email = det.email || null;

  if (!name) {
    // 1) an existing profile with the detected email or org
    profiles.list(ctx.configDir).forEach(function (n) {
      if (name) return;
      const m = profiles.read(ctx.configDir, n);
      if (!m) return;
      if ((email && m.email === email) ||
          (det.org && m.oauthAccount && m.oauthAccount.organizationUuid === det.org)) name = n;
    });
    // 2) a fresh profile named from the detected email
    if (!name && email) name = core.uniqueName(ctx, profiles.sanitizeName(email), email);
    if (!name) {
      return fail("Couldn't auto-identify the app's account (no email found in its data).\n" +
        'Give the account a name yourself:  ccswitch capture-app <name>   (e.g. ccswitch capture-app yahoo)');
    }
  }

  if (!profiles.exists(ctx.configDir, name)) {
    const oa = {};
    if (det.org) oa.organizationUuid = det.org;
    if (det.account) oa.accountUuid = det.account;
    if (email) oa.emailAddress = email;
    profiles.write(ctx.configDir, { name: name, email: email || '', oauthAccount: oa, appOnly: true, savedAt: ctx.now() });
  }
  const r = appauth.snapshotToProfile(ctx, name);
  if (!r.ok) return fail('Could not capture the desktop-app login: ' + r.reason);
  print("✅ Captured the desktop app's current login as '" + name + "'" + (email ? ' (' + email + ')' : '') + '.');
  if (!ctx.store.getProfile(name)) {
    print("  ↳ Claude Code (CLI) login for this account isn't captured yet — when the CLI is");
    print("    logged into it, run 'ccswitch add' to complete the pair.");
  }
  print('Repeat for your other account(s), then switch with: ccswitch switch <name>');
}

function consolidateAndReport(ctx) {
  // Never write into the app's session store while it is still open.
  if (appctl.isClaudeRunning(ctx.platform)) return { ok: false, merged: 0, reason: 'Claude still running' };
  const c = appsessions.consolidate(ctx);
  if (c.ok && c.merged) print('  ↳ shared ' + c.merged + ' session pointer(s) so every account shows them all.');
  return c;
}

function reportConsolidate(ctx) {
  const c = appsessions.consolidate(ctx);
  if (!c.ok) { print('Nothing to consolidate: ' + c.reason); return c; }
  if (!c.merged) { print('Already consolidated — every account already has all Code sessions.'); return c; }
  print('✅ Shared ' + c.merged + ' session pointer(s) across your accounts' + (c.backup ? ' (backup: ' + c.backup + ')' : '') + '.');
  return c;
}

async function cmdConsolidate(ctx, rest) {
  const autoYes = rest.indexOf('--restart') !== -1 || rest.indexOf('-y') !== -1 || rest.indexOf('--yes') !== -1;
  const force = rest.indexOf('--force') !== -1; // merge in place, don't close the app
  const running = appctl.isClaudeRunning(ctx.platform);
  const manage = appctl.canManageApp(ctx.platform);

  if (running && manage && !force) {
    if (!autoYes) {
      if (!process.stdin.isTTY) {
        return fail('Claude is open. Re-run with --restart to close & reopen it automatically, ' +
          '--force to merge without closing (then restart Claude yourself), or quit Claude first.');
      }
      const ok = await confirm('Claude will be closed, your sessions consolidated, and Claude reopened. Continue? [y/N] ');
      if (!ok) { print('Cancelled — nothing was changed.'); return; }
    }
    print('Quitting Claude...'); appctl.quitClaude(ctx.platform); await waitForQuit(ctx);
    if (appctl.isClaudeRunning(ctx.platform)) return fail('Claude did not quit; aborting so nothing is written into a live store.');
    const c = reportConsolidate(ctx);
    print('Reopening Claude...'); appctl.openClaude(ctx.platform);
    if (c.ok && c.merged) print('Done — all your Code sessions are now in Recents.');
    return;
  }

  // App not running, or --force (merge in place), or a platform we can't manage.
  const c = reportConsolidate(ctx);
  if (c.ok && c.merged) {
    print(running ? '↪ Fully quit and reopen Claude to see them all in Recents.'
                  : '↪ Open Claude to see them all in Recents.');
    print('(Cloud "Chat" conversations stay per-account and are not touched.)');
  }
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function waitForQuit(ctx, timeoutMs) {
  const deadline = timeoutMs || 20000;
  let waited = 0;
  while (appctl.isClaudeRunning(ctx.platform) && waited < deadline) { await sleep(500); waited += 500; }
}

async function cmdClean(ctx, rest) {
  const force = rest.indexOf('--force') !== -1 || rest.indexOf('-y') !== -1 || rest.indexOf('--yes') !== -1;
  const logout = rest.indexOf('--logout') !== -1 || rest.indexOf('--signout') !== -1 || rest.indexOf('--all') !== -1;
  const names = profiles.list(ctx.configDir);
  let appCount = 0, backupCount = 0;
  try { appCount = fs.readdirSync(path.join(ctx.configDir, 'app')).length; } catch (e) { /* none */ }
  try { backupCount = fs.readdirSync(path.join(ctx.configDir, 'backups')).length; } catch (e) { /* none */ }
  const hasSaved = names.length || appCount || backupCount;

  if (!hasSaved && !logout) { print('Nothing to clean — ccswitch has no saved data.'); return; }

  const managesApp = !!ctx.appDataDir;
  print('This will:');
  if (hasSaved) {
    print("  • delete ccswitch's saved data — accounts: " + (names.length ? names.join(', ') : 'none') +
      '; captured desktop logins: ' + appCount + '; backups: ' + backupCount + '; Keychain ccswitch:*');
  }
  if (logout) {
    print('  • SIGN OUT of Claude Code (CLI)' + (managesApp ? ' AND the Claude desktop app' : '') + ' — you will log in again next time');
    if (managesApp && appctl.isClaudeRunning(ctx.platform) && appctl.canManageApp(ctx.platform)) {
      print('  • CLOSE and reopen the desktop app (this window will close if you run it from inside Claude)');
    }
  }
  print('Not affected: your chats/sessions in ~/.claude/projects.');

  if (!force) {
    if (!process.stdin.isTTY) return fail('Re-run with --force to confirm' + (logout ? ' the sign-out.' : '.'));
    const ok = await confirm('\nProceed? [y/N] ');
    if (!ok) { print('Cancelled — nothing was changed.'); return; }
  }

  if (hasSaved) {
    names.forEach(function (n) { try { ctx.store.delProfile(n); } catch (e) { /* keychain */ } });
    try { fs.rmSync(ctx.configDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    print('  ✓ ccswitch saved data removed.');
  }

  if (logout) {
    try { ctx.store.delLive(); } catch (e) { /* already gone */ }
    try {
      const c = claude.readConfig(ctx.claudeConfigPath);
      if (c && (c.oauthAccount || c.userID)) { delete c.oauthAccount; delete c.userID; claude.writeConfig(ctx.claudeConfigPath, c); }
    } catch (e) { /* ignore */ }
    print('  ✓ signed out of Claude Code (CLI).');

    if (ctx.appDataDir) {
      const wasRunning = appctl.isClaudeRunning(ctx.platform);
      if (wasRunning && appctl.canManageApp(ctx.platform)) {
        print('  Closing the desktop app to sign it out...');
        appctl.quitClaude(ctx.platform);
        await waitForQuit(ctx);
      }
      if (!appctl.isClaudeRunning(ctx.platform)) {
        const r = appauth.signOutApp(ctx);
        if (r.ok) print('  ✓ signed out of the Claude desktop app.');
        if (wasRunning && appctl.canManageApp(ctx.platform)) { appctl.openClaude(ctx.platform); }
      } else {
        print('  ⚠️ Close the Claude desktop app, then re-run to sign it out.');
      }
    }
  }
  print('✅ Done.');
}

function cmdList(ctx) {
  const list = core.listProfiles(ctx);
  print('Saved accounts (' + ctx.configDir + '):');
  if (!list.length) { print("  (none yet — 'ccswitch add' for the CLI login, 'ccswitch capture-app' for the desktop app)"); }
  else {
    list.forEach(function (e) {
      const cli = !!ctx.store.getProfile(e.name);
      const app = appauth.hasProfile(ctx, e.name);
      print(' ' + (e.active ? '*' : ' ') + ' [' + e.index + '] ' + (e.email || e.name) + '  (' + e.name + ')' +
        '   [cli ' + (cli ? '✓' : '—') + ' | app ' + (app ? '✓' : '—') + ']');
    });
  }
  print('');
  print('Active CLI account: ' + (core.currentEmail(ctx) || 'not logged in'));
}

async function main(argv) {
  const cmd = argv[0];
  const rest = argv.slice(1);
  const ctx = createContext();
  try {
    switch (cmd) {
      case undefined:
        if (!process.stdin.isTTY) { usage(); return; }
        return require('./menu').runMenu(ctx);
      case 'menu':
        return require('./menu').runMenu(ctx);
      case 'add': {
        const r = core.addCurrent(ctx, rest[0]);
        print(r.refreshed ? "↻ '" + r.email + "' already saved as '" + r.name + "' — refreshed."
                          : "💾 saved '" + r.email + "' as '" + r.name + "'.");
        return;
      }
      case 'capture-app':
      case 'app-capture':
        return cmdCaptureApp(ctx, rest);
      case 'save':
        if (!rest[0]) return fail('usage: ccswitch save <name>');
        core.saveAs(ctx, rest[0]);
        print("💾 saved as '" + rest[0] + "'");
        return;
      case 'switch':
      case 'use':
        return cmdSwitch(ctx, rest);
      case 'list':
      case 'ls':
        return cmdList(ctx);
      case 'current':
      case 'who':
        print('Active account: ' + (core.currentEmail(ctx) || 'unknown'));
        return;
      case 'remove':
      case 'rm':
      case 'delete': {
        const n = core.resolveProfile(ctx, rest[0]);
        if (!n) return fail("no such profile: '" + (rest[0] || '') + "'");
        core.removeProfile(ctx, n);
        print('🗑  removed: ' + n);
        return;
      }
      case 'consolidate':
      case 'merge':
        return cmdConsolidate(ctx, rest);
      case 'clean':
      case 'reset':
        return cmdClean(ctx, rest);
      case 'version':
      case '--version':
      case '-v':
        print('ccswitch ' + VERSION);
        return;
      case 'help':
      case '--help':
      case '-h':
        usage();
        return;
      default:
        process.stderr.write("ccswitch: unknown command '" + cmd + "'\n\n");
        usage();
        process.exitCode = 1;
        return;
    }
  } catch (e) {
    fail(e && e.message ? e.message : String(e));
  }
}

module.exports = { main: main, usage: usage };
