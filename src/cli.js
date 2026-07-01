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
const lock = require('./lock');
const logmod = require('./log');
const style = require('./style').make(process.stdout);

// Serialize every mutation across processes (double-fired alias, launcher app
// racing a terminal, two menus) so a switch can never interleave with another.
async function withLock(ctx, fn) {
  const l = await lock.acquire(ctx.configDir);
  try { return await fn(); } finally { l.release(); }
}

let VERSION = '0.0.0';
try { VERSION = require('../package.json').version; } catch (e) { /* ignore */ }

// --json mode: stdout carries exactly one JSON object; human text goes to stderr.
let JSON_MODE = false;
const JSON_SCHEMA_VERSION = 1;

function print(s) {
  (JSON_MODE ? process.stderr : process.stdout).write((s == null ? '' : s) + '\n');
}
function jsonOut(obj) {
  if (!JSON_MODE) return;
  process.stdout.write(JSON.stringify(Object.assign({ schemaVersion: JSON_SCHEMA_VERSION }, obj)) + '\n');
}
function fail(msg) {
  logmod.log('error: ' + msg);
  if (JSON_MODE) jsonOut({ error: { message: String(msg) } });
  process.stderr.write(style.err('❌ ') + msg + '\n');
  process.exitCode = 1;
}

// True/false when readable; null when the keychain is locked/unavailable.
function capturedCliSafe(ctx, name) {
  try { return !!ctx.store.getProfile(name); } catch (e) { return null; }
}

function usage() {
  print('ccswitch ' + VERSION + ' — switch between Anthropic / Claude Code accounts (macOS, Linux, Windows)');
  print('');
  print('  ccswitch                       interactive menu (↑/↓ + Enter)');
  print('  ccswitch add [name] [--app]    save the account(s) you are logged into — Claude Code');
  print('                                 AND the desktop app, auto-detected. Once per account.');
  print('                                 (--app: desktop app only; name it if undetected)');
  print('  ccswitch <name|number>         switch to that account (asks before closing Claude;');
  print('                                 --restart = no prompt, --force = swap without closing)');
  print('  ccswitch next                  rotate to the next saved account');
  print('  ccswitch status                which account each surface is on (CLI + desktop app)');
  print('  ccswitch list                  saved accounts (* active, [cli|app] = what\'s captured)');
  print('  ccswitch remove <name|number>  delete a saved account');
  print('  ccswitch clean [--logout]      reset ccswitch data; --logout also signs out of');
  print('                                 Claude Code + the desktop app (asks to confirm)');
  print('');
  print('Global flags: --json (machine-readable stdout)   --debug (verbose log to stderr + file)');
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
  if (!arg) return fail('usage: ccswitch <name|number> [--restart|--force]');
  const autoYes = rest.indexOf('--restart') !== -1 || rest.indexOf('-y') !== -1 || rest.indexOf('--yes') !== -1;
  const force = rest.indexOf('--force') !== -1;
  const name = core.resolveProfile(ctx, arg);
  if (!name) return fail("no such profile: '" + arg + "' (see: ccswitch list)");
  const em = profiles.email(ctx.configDir, name);
  if (em && em === core.currentEmail(ctx)) {
    print("'" + em + "' is already active.");
    jsonOut({ alreadyActive: { name: name, email: em } });
    return;
  }
  logmod.log('switch requested -> ' + name);

  const running = appctl.isClaudeRunning(ctx.platform);
  const manage = appctl.canManageApp(ctx.platform);

  function emitSwitched(did, appl, cons) {
    logmod.log('switched -> ' + name + ' (cli=' + !!(did && did.cli) + ', app=' + !!(appl && appl.ok) + ')');
    jsonOut({
      switched: { name: name, email: em || null },
      cliSwitched: !!(did && did.cli),
      appSwitched: !!(appl && appl.ok),
      sessionsShared: (cons && cons.merged) || 0,
    });
  }

  // --force: swap in place without closing the app.
  if (running && force) {
    const did = core.performSwitch(ctx, name);
    if (!did.cli) print("  ↳ CLI login for this profile isn't captured — nothing to swap for the CLI.");
    print(style.ok('✅') + ' Switched to: ' + (em || name) + '. Restart Claude to apply.');
    emitSwitched(did, null, null);
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
    const appl = switchDesktopLogin(ctx, name);
    const cons = consolidateAndReport(ctx);
    print('Reopening Claude...'); appctl.openClaude(ctx.platform);
    print(style.ok('✅') + ' Switched to: ' + (em || name));
    emitSwitched(did, appl, cons);
    return;
  }
  // App is open but we cannot auto-close it (Linux/Windows).
  if (running && !manage) {
    if (autoYes) {
      const did = core.performSwitch(ctx, name);
      print(style.ok('✅') + ' Switched to: ' + (em || name) + '. Restart Claude Code to apply.');
      emitSwitched(did, null, null);
      return;
    }
    return fail('Claude / Claude Code is open — close it first (it cannot be auto-closed on this OS), or re-run with --force.');
  }
  // Not running: just swap.
  const did = core.performSwitch(ctx, name);
  if (!did.cli) print("  ↳ CLI login for this profile isn't captured — switched the desktop app only.");
  const appl = switchDesktopLogin(ctx, name);
  const cons = consolidateAndReport(ctx);
  print(style.ok('✅') + ' Switched to: ' + (em || name) + (manage ? '' : '. Restart Claude Code to apply.'));
  emitSwitched(did, appl, cons);
}

// Rotate to the next saved account after the currently active one (wraps around).
async function cmdNext(ctx, rest) {
  const list = core.listProfiles(ctx);
  if (list.length < 2) return fail('need at least 2 saved accounts to rotate (see: ccswitch add)');
  let idx = -1;
  list.forEach(function (e, i) { if (e.active) idx = i; });
  const target = list[(idx + 1) % list.length];
  if (target.active) return fail('no other account to rotate to');
  print('Rotating to: ' + (target.email || target.name));
  return cmdSwitch(ctx, [target.name].concat(rest.filter(function (a) { return a.indexOf('--') === 0; })));
}

// One-line answer to "which account am I on?" (both surfaces).
function cmdStatus(ctx) {
  const cliEmail = core.currentEmail(ctx) || null;
  const appName = ctx.appDataDir ? appauth.activeProfileName(ctx) : null;
  const appEmail = appName ? (profiles.email(ctx.configDir, appName) || null) : null;
  jsonOut({
    cli: cliEmail ? { email: cliEmail } : null,
    app: appName ? { name: appName, email: appEmail } : null,
  });
  if (!JSON_MODE) {
    print('Claude Code: ' + (cliEmail || 'not logged in') +
      (ctx.appDataDir ? '   ·   Desktop app: ' + (appEmail || appName || 'unknown') : ''));
  }
}

function switchDesktopLogin(ctx, name) {
  // Only touch config.json while the app is closed.
  if (appctl.isClaudeRunning(ctx.platform)) return { ok: false };
  const a = appauth.applyFromProfile(ctx, name);
  if (a.ok) print('  ↳ switched the Claude desktop-app login too.');
  else if (a.reason && a.reason !== 'no saved desktop login for this profile') {
    print('  ⚠️ desktop app NOT switched: ' + a.reason);
  }
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
  return { ok: true, name: name, email: email, cookies: r.cookies };
}

// A fresh login may only exist in the app's memory — Chromium flushes cookies on
// a clean quit. Fix an incomplete capture by briefly closing the app.
async function repairCookieCapture(ctx, name) {
  if (!appctl.canManageApp(ctx.platform) || !appctl.isClaudeRunning(ctx.platform)) return 'incomplete';
  if (!process.stdin.isTTY) return 'incomplete';
  const ok = await confirm("Claude hasn't saved this fresh login to disk yet. Briefly close & reopen it to capture it? [y/N] ");
  if (!ok) return 'incomplete';
  print('Quitting Claude...'); appctl.quitClaude(ctx.platform); await waitForQuit(ctx);
  let status = 'incomplete';
  if (!appctl.isClaudeRunning(ctx.platform)) {
    const r = appauth.snapshotToProfile(ctx, name);
    status = (r.ok && r.cookies) || 'incomplete';
  }
  print('Reopening Claude...'); appctl.openClaude(ctx.platform);
  return status;
}

function warnIncompleteCookies(name) {
  print("⚠️  The login cookie isn't captured for '" + name + "' yet, so switching the desktop app");
  print('   to it will NOT work. Quit Claude fully, reopen it, and run:  ccswitch add');
}

// Unified `add`: capture EVERYTHING that's currently logged in — the Claude Code
// (CLI) account and/or the desktop app's account — creating profiles as needed.
// `--app` limits it to the desktop app (use with a name when auto-detect can't
// identify which account the app is signed into).
async function cmdAdd(ctx, rest) {
  logmod.log("add invoked");
  const appOnly = rest.indexOf('--app') !== -1;
  const nameArg = rest.filter(function (a) { return a.indexOf('--') !== 0; })[0];

  if (appOnly) {
    const r = captureApp(ctx, nameArg || null);
    if (r.ok) {
      print("💾 Desktop app login: captured as '" + r.name + "'" + (r.email ? ' (' + r.email + ')' : '') + '.');
      let ck = r.cookies;
      if (ck !== 'ok') ck = await repairCookieCapture(ctx, r.name);
      if (ck !== 'ok') warnIncompleteCookies(r.name);
      return;
    }
    if (r.needName) return fail("Couldn't auto-identify the app's account. Name it:  ccswitch add <name> --app");
    return fail('Could not capture the desktop-app login: ' + (r.reason === 'macos-only' ? 'the desktop app store is macOS-only.' : r.reason));
  }

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
    let ck = appRes.cookies;
    if (ck !== 'ok') ck = await repairCookieCapture(ctx, appRes.name);
    if (ck !== 'ok') warnIncompleteCookies(appRes.name);
  }

  if (!cliRes && !appRes.ok) {
    if (appRes.needName) {
      return fail("The desktop app is signed in, but I couldn't identify its account.\n" +
        'Name it yourself:  ccswitch add <name> --app');
    }
    return fail('Nothing to capture. Log in in Claude first.' + (cliErr ? '\n(CLI: ' + cliErr + ')' : ''));
  }
  if (cliRes && appRes.needName) {
    print("↳ The desktop app is signed in but its account couldn't be identified. If it's a");
    print('  different account than the CLI, capture it with:  ccswitch add <name> --app');
  }
  const anyIncomplete = profiles.list(ctx.configDir).some(function (n) { return capturedCliSafe(ctx, n) === false || !appauth.hasProfile(ctx, n); });
  if (anyIncomplete) print("Tip: 'ccswitch list' shows what each account has captured ([cli|app]).");
}

function consolidateAndReport(ctx) {
  // Never write into the app's session store while it is still open.
  if (appctl.isClaudeRunning(ctx.platform)) return { ok: false, merged: 0, reason: 'Claude still running' };
  const c = appsessions.consolidate(ctx);
  if (c.ok && c.merged) print('  ↳ shared ' + c.merged + ' session pointer(s) so every account shows them all.');
  return c;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function waitForQuit(ctx, timeoutMs) {
  const deadline = timeoutMs || 20000;
  let waited = 0;
  while (appctl.isClaudeRunning(ctx.platform) && waited < deadline) { await sleep(500); waited += 500; }
}

async function cmdClean(ctx, rest) {
  logmod.log("clean invoked");
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
  const appActive = ctx.appDataDir ? appauth.activeProfileName(ctx) : null;
  if (JSON_MODE) {
    jsonOut({
      accounts: list.map(function (e) {
        return {
          index: e.index, name: e.name, email: e.email || null,
          cliCaptured: capturedCliSafe(ctx, e.name),
          appCaptured: appauth.hasProfile(ctx, e.name),
          activeCli: !!e.active,
          activeApp: e.name === appActive,
        };
      }),
      activeCli: core.currentEmail(ctx) || null,
      activeApp: appActive ? (profiles.email(ctx.configDir, appActive) || appActive) : null,
    });
    return;
  }
  print('Saved accounts (' + ctx.configDir + '):');
  if (!list.length) { print("  (none yet — log in in Claude, then run 'ccswitch add')"); }
  else {
    list.forEach(function (e) {
      const cli = capturedCliSafe(ctx, e.name);
      const app = appauth.hasProfile(ctx, e.name);
      const now = [];
      if (e.active) now.push('CLI');
      if (e.name === appActive) now.push('app');
      print(' ' + (now.length ? '→' : ' ') + ' [' + e.index + '] ' + (e.email || e.name) +
        '   [cli ' + (cli === null ? '?' : (cli ? '✓' : '—')) + ' | app ' + (app ? '✓' : '—') + ']' +
        (now.length ? '   ← active: ' + now.join(' + ') : ''));
    });
  }
  print('');
  print('Active — Claude Code: ' + (core.currentEmail(ctx) || 'not logged in') +
    (ctx.appDataDir ? '   ·   desktop app: ' + (appActive ? profiles.email(ctx.configDir, appActive) || appActive : 'unknown') : ''));
}

async function main(argv) {
  // Global flags, valid anywhere on the line.
  JSON_MODE = argv.indexOf('--json') !== -1;
  const debug = argv.indexOf('--debug') !== -1;
  argv = argv.filter(function (a) { return a !== '--json' && a !== '--debug'; });

  const cmd = argv[0];
  const rest = argv.slice(1);
  const ctx = createContext();
  logmod.init(ctx.configDir, debug);
  try {
    switch (cmd) {
      case undefined:
        if (!process.stdin.isTTY) { usage(); return; }
        return require('./menu').runMenu(ctx);
      case 'menu': // hidden: used by the launcher app; same as bare `ccswitch`
        return require('./menu').runMenu(ctx);
      case 'add':
        return withLock(ctx, function () { return cmdAdd(ctx, rest); });
      case 'list':
        return cmdList(ctx);
      case 'status':
        return cmdStatus(ctx);
      case 'next':
        return withLock(ctx, function () { return cmdNext(ctx, rest); });
      case 'remove':
        return withLock(ctx, function () {
          const n = core.resolveProfile(ctx, rest[0]);
          if (!n) return fail("no such account: '" + (rest[0] || '') + "'");
          core.removeProfile(ctx, n);
          print('🗑  removed: ' + n);
        });
      case 'clean':
        return withLock(ctx, function () { return cmdClean(ctx, rest); });
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
        // `ccswitch <name|number>` switches directly.
        if (core.resolveProfile(ctx, cmd)) return withLock(ctx, function () { return cmdSwitch(ctx, [cmd].concat(rest)); });
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
