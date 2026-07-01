'use strict';
// Argument parsing + command dispatch. Thin wrapper over core/menu.
const { createContext } = require('./context');
const core = require('./core');
const profiles = require('./profiles');
const appctl = require('./platform');

let VERSION = '0.0.0';
try { VERSION = require('../package.json').version; } catch (e) { /* ignore */ }

function print(s) { process.stdout.write((s == null ? '' : s) + '\n'); }
function fail(msg) { process.stderr.write('❌ ' + msg + '\n'); process.exitCode = 1; }

function usage() {
  print('ccswitch ' + VERSION + ' — switch between Anthropic / Claude Code accounts (macOS, Linux, Windows)');
  print('');
  print('  ccswitch                       open the interactive menu (same as the app)');
  print('  ccswitch add [name]            detect the logged-in account and save it (auto-named)');
  print('  ccswitch switch <name|number>  switch accounts   [--restart quits/reopens Claude, --force]');
  print('  ccswitch list                  list saved accounts (* = active)');
  print('  ccswitch remove <name|number>  delete a saved account');
  print('  ccswitch current               show the active account');
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
    core.doSwitch(ctx, name);
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
    core.doSwitch(ctx, name);
    print('Reopening Claude...'); appctl.openClaude(ctx.platform);
    print('✅ Switched to: ' + (em || name));
    return;
  }
  // App is open but we cannot auto-close it (Linux/Windows).
  if (running && !manage) {
    if (autoYes) {
      core.doSwitch(ctx, name);
      print('✅ Switched to: ' + (em || name) + '. Restart Claude Code to apply.');
      return;
    }
    return fail('Claude / Claude Code is open — close it first (it cannot be auto-closed on this OS), or re-run with --force.');
  }
  // Not running: just swap.
  core.doSwitch(ctx, name);
  print('✅ Switched to: ' + (em || name) + (manage ? '' : '. Restart Claude Code to apply.'));
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function waitForQuit(ctx, timeoutMs) {
  const deadline = timeoutMs || 20000;
  let waited = 0;
  while (appctl.isClaudeRunning(ctx.platform) && waited < deadline) { await sleep(500); waited += 500; }
}

function cmdList(ctx) {
  const list = core.listProfiles(ctx);
  print('Saved accounts (' + ctx.configDir + '):');
  if (!list.length) { print("  (none yet — run 'ccswitch add' while logged in)"); }
  else {
    list.forEach(function (e) {
      print(' ' + (e.active ? '*' : ' ') + ' [' + e.index + '] ' + (e.email || '?') + '  (' + e.name + ')');
    });
  }
  print('');
  print('Active account: ' + (core.currentEmail(ctx) || 'unknown'));
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
      case 'capture': {
        const r = core.addCurrent(ctx, rest[0]);
        print(r.refreshed ? "↻ '" + r.email + "' already saved as '" + r.name + "' — refreshed."
                          : "💾 saved '" + r.email + "' as '" + r.name + "'.");
        return;
      }
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
