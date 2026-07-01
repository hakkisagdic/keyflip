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
  print('  ccswitch                       interactive menu (↑/↓ + Enter)');
  print('  ccswitch add [name]            save the account(s) you are logged into — Claude Code');
  print('                                 AND the desktop app, auto-detected. Once per account.');
  print('  ccswitch <name|number>         switch to that account (asks before closing Claude;');
  print('                                 --restart = no prompt, --force = swap without closing)');
  print('  ccswitch list                  saved accounts (* active, [cli|app] = what\'s captured)');
  print('  ccswitch remove <name|number>  delete a saved account');
  print('  ccswitch clean [--logout]      reset ccswitch data; --logout also signs out of');
  print('                                 Claude Code + the desktop app (asks to confirm)');
  print('');
  print('Also available: switch, capture-app, save, consolidate, current, version.');
  print('Tokens stay in the OS credential store; ~/.claude/projects history is account-independent.');
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
// Returns { ok, name?, email?, needName?, reason? } — printing is the caller's job.
function captureApp(ctx, nameArg) {
  if (!ctx.appDataDir) return { ok: false, reason: 'macos-only' };
  let name = nameArg || null;
  if (name && !profiles.isValidName(name)) return { ok: false, reason: "invalid profile name: '" + name + "'" };

  const det = appauth.detectAppAccount(ctx) || {};
  const email = det.email || null;

  if (!name) {
    profiles.list(ctx.configDir).forEach(function (n) {
      if (name) return;
      const m = profiles.read(ctx.configDir, n);
      if (!m) return;
      if ((email && m.email === email) ||
          (det.org && m.oauthAccount && m.oauthAccount.organizationUuid === det.org)) name = n;
    });
    if (!name && email) name = core.uniqueName(ctx, profiles.sanitizeName(email), email);
    if (!name) return { ok: false, needName: true };
  }

  if (!profiles.exists(ctx.configDir, name)) {
    const oa = {};
    if (det.org) oa.organizationUuid = det.org;
    if (det.account) oa.accountUuid = det.account;
    if (email) oa.emailAddress = email;
    profiles.write(ctx.configDir, { name: name, email: email || '', oauthAccount: oa, appOnly: true, savedAt: ctx.now() });
  }
  const r = appauth.snapshotToProfile(ctx, name);
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, name: name, email: email };
}

// Unified `add`: capture EVERYTHING that's currently logged in — the Claude Code
// (CLI) account and/or the desktop app's account — creating profiles as needed.
function cmdAdd(ctx, rest) {
  const nameArg = rest[0];
  let cliRes = null, cliErr = null;
  try { cliRes = core.addCurrent(ctx, nameArg); } catch (e) { cliErr = (e && e.message) || String(e); }
  if (cliRes) {
    print(cliRes.refreshed ? "↻ CLI login: '" + cliRes.email + "' already saved as '" + cliRes.name + "' — refreshed."
                           : "💾 CLI login: saved '" + cliRes.email + "' as '" + cliRes.name + "'.");
  }

  // Desktop app: pass the explicit name through only when the CLI didn't take it
  // (otherwise auto-detect, so we never mis-pair the app with the wrong account).
  const appRes = captureApp(ctx, cliRes ? null : nameArg);
  if (appRes.ok) {
    print("💾 Desktop app login: captured as '" + appRes.name + "'" + (appRes.email ? ' (' + appRes.email + ')' : '') + '.');
  } else if (appRes.needName) {
    print("↳ The desktop app is signed in, but I couldn't identify its account.");
    print("  If it's a different account than the CLI, capture it with:  ccswitch add <name>  (while the CLI is logged out)");
  }

  if (!cliRes && !appRes.ok && !appRes.needName) {
    return fail('Nothing to capture. Log in in Claude first.' + (cliErr ? '\n(CLI: ' + cliErr + ')' : ''));
  }
  const anyIncomplete = profiles.list(ctx.configDir).some(function (n) { return !ctx.store.getProfile(n) || !appauth.hasProfile(ctx, n); });
  if (anyIncomplete) print("Tip: 'ccswitch list' shows what each account has captured ([cli|app]).");
}

function cmdCaptureApp(ctx, rest) { // kept as an explicit/advanced alias
  const r = captureApp(ctx, rest[0] || null);
  if (r.ok) { print("✅ Captured the desktop app's current login as '" + r.name + "'" + (r.email ? ' (' + r.email + ')' : '') + '.'); return; }
  if (r.needName) return fail("Couldn't auto-identify the app's account. Name it yourself:  ccswitch capture-app <name>");
  return fail('Could not capture the desktop-app login: ' + (r.reason === 'macos-only' ? 'the desktop app store is macOS-only.' : r.reason));
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
      case 'add':
      case 'capture':
        return cmdAdd(ctx, rest);
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
      default: {
        // `ccswitch <name|number>` is a direct switch — no need to type "switch".
        if (core.resolveProfile(ctx, cmd)) return cmdSwitch(ctx, [cmd].concat(rest));
        process.stderr.write("ccswitch: unknown command or account '" + cmd + "'\n\n");
        usage();
        process.exitCode = 1;
        return;
      }
    }
  } catch (e) {
    fail(e && e.message ? e.message : String(e));
  }
}

module.exports = { main: main, usage: usage };
