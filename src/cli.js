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

async function cmdSwitch(ctx, rest) {
  const arg = rest[0];
  if (!arg) return fail('usage: ccswitch switch <name|number> [--restart]');
  const restart = rest.indexOf('--restart') !== -1;
  const force = rest.indexOf('--force') !== -1;
  const name = core.resolveProfile(ctx, arg);
  if (!name) return fail("no such profile: '" + arg + "' (see: ccswitch list)");
  const em = profiles.email(ctx.configDir, name);
  const cur = core.currentEmail(ctx);
  if (em && em === cur) { print("'" + em + "' is already active."); return; }

  if (restart && appctl.canManageApp(ctx.platform)) {
    const running = appctl.isClaudeRunning(ctx.platform);
    if (running) { print('Quitting Claude...'); appctl.quitClaude(ctx.platform); await waitForQuit(ctx); }
    core.doSwitch(ctx, name);
    if (running) { print('Reopening Claude...'); appctl.openClaude(ctx.platform); }
    print('✅ Switched to: ' + (em || name));
    return;
  }

  if (appctl.isClaudeRunning(ctx.platform) && !force) {
    return fail('Claude is running — quit it first, then switch is safe. Or re-run with --force' +
      (appctl.canManageApp(ctx.platform) ? ', or use --restart / the app to do it automatically.' : '.'));
  }
  core.doSwitch(ctx, name);
  print('✅ Switched to: ' + (em || name) + '. Restart Claude Code to apply.');
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
