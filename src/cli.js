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
const oauth = require('./oauth');
const update = require('./update');
const transfer = require('./transfer');
const usagemod = require('./usage');
const session = require('./session');
const links = require('./links');
const autosw = require('./autoswitch');
const provider = require('./provider');
const doctor = require('./doctor');
const history = require('./history');
const backup = require('./backup');
const share = require('./share');
const skill = require('./skill');
const mcpreg = require('./mcpreg');
const desktopgw = require('./desktopgw');
const sync = require('./sync');
const sessions = require('./sessions');
const mcp = require('./mcp');
const proxy = require('./proxy');
const uninstallmod = require('./uninstall');
const exec = require('./exec');
const loginmod = require('./login');
const style = require('./style').make(process.stdout);

// Serialize every mutation across processes (double-fired alias, launcher app
// racing a terminal, two menus) so a switch can never interleave with another.
async function withLock(ctx, fn, resource) {
  const l = await lock.acquire(ctx.configDir, resource ? { resource: resource } : undefined);
  let ok = false;
  try { const r = await fn(); ok = true; return r; }
  finally {
    l.release();
    // H3: version every successful mutation (best-effort, secrets git-ignored). Single
    // funnel point — the command label is stashed on ctx by main().
    if (ok) { try { require('./vcs').autoCommit(ctx, ctx._vcsLabel || resource || 'update'); } catch (e) { /* never break a mutation on versioning */ } }
  }
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
  print('keyflip ' + VERSION + ' — switch between Anthropic / Claude Code accounts (macOS, Linux, Windows)');
  print('');
  print('  keyflip                       interactive menu (↑/↓ + Enter)');
  print('  keyflip onboard [--manual] [--sso] [--console]   full first-run: sign in per account →');
  print('                                 capture + point CLI + browser at it + sync chats, then ask for');
  print('                                 the next ("p" = add an API-key provider; --sso = enterprise SSO)');
  print('  keyflip setup                 lighter wizard: log in in Claude, keyflip auto-detects &');
  print('                                 captures each account (no browser drive)');
  print('  keyflip login [name] [--email x] [--fresh|--manual] [--sso] [--console]   sign in via the');
  print('                                 official flow and capture it (isolated — current login NOT');
  print('                                 disturbed; --fresh clears the browser first; --manual pastes');
  print('                                 the code/URL; --sso = enterprise SSO; --console = Console acct)');
  print('  keyflip add [name] [--app]    save the account(s) you are logged into — Claude Code');
  print('                                 AND the desktop app, auto-detected. Once per account.');
  print('                                 (--app: desktop app only; name it if undetected)');
  print('  keyflip <name|number>         switch to that account (asks before closing Claude;');
  print('                                 --restart = no prompt, --force = swap without closing,');
  print('                                 --browser = also align the browser + Chrome extension)');
  print('  keyflip next [--strategy best|next-available]');
  print('                                 rotate to the next account — or pick by remaining quota');
  print('  keyflip provider add <name> --base-url <url> [--key-file <f|->]');
  print('                                 save a 3rd-party endpoint (relay/gateway/Bedrock/OpenRouter)');
  print('  keyflip use <name>             route Claude Code to that provider (no restart);');
  print('                                 keyflip provider off = back to your subscription');
  print('  keyflip speedtest [name]       time a provider\'s endpoints, pick the fastest');
  print('  keyflip doctor                 diagnose config, login and endpoint reachability');
  print('  keyflip test <provider>        fire one real request to check a provider\'s auth');
  print('  keyflip usage --history        per-account usage trend + autoswitch/failover events');
  print('  keyflip backup [now|list|restore <n>|prune]   snapshot keyflip metadata (no secrets)');
  print('  keyflip history | undo | restore <ref>   git-versioned config: see/undo/roll back changes');
  print('  keyflip versioning [on|off]   toggle auto-versioning (ON by default; secrets never committed)');
  print('  keyflip share <name> [--no-secrets]   make a keyflip:// link; import with `keyflip import`');
  print('  keyflip mcpreg [add|list|enable|disable|import]   manage MCP servers across Claude Code + Desktop');
  print('  keyflip gateway use <provider> | off   route the Claude DESKTOP app through a provider gateway');
  print('  keyflip sync [push|pull|test] --url <webdav> --passphrase-file <f>   encrypted cross-device sync');
  print('  keyflip migrate export/import <file> [--passphrase-file <f>]   move ALL accounts+providers+');
  print('                                 session transcripts to a new machine and MERGE (also: push/pull --url)');
  print('                                 add --agents (memory) / --agent-config (MCP+settings, redacted) for other AI agents');
  print('  keyflip agents                 list other agents\' memory + config keyflip can carry (Cursor/Gemini/Codex)');
  print('  keyflip transfer serve [--receive] | pull [<host>] --code X | push <host> --code X   LIVE device-to-device over the LAN');
  print('                                 add --qr to `serve` to show a scannable QR of the pairing code');
  print('  keyflip consolidate [--watch]  sync every account\'s chat index so each shows ALL conversations');
  print('  keyflip sessions [--search T] [--here]   browse Claude Code conversations (all accounts)');
  print('  keyflip sessions rebind <old-path> <new-path>   re-link a project\'s chat history after you');
  print('                                 renamed/moved its folder (transcripts + desktop-app records)');
  print('  keyflip sessions archive <id|--older-than 30d> | unarchive <id> | archived');
  print('                                 move old transcripts into keyflip (gzipped) and back — declutter, reversible');
  print('  keyflip sessions assign <id> <account>   continue a session AS another account (resume --run) — no profile switch');
  print('  keyflip sessions distill <id> [--to-claude]   summarize a chat into a durable keepsake (via `claude -p`)');
  print('  keyflip sessions compact <id> [--apply]   shrink a transcript (elide bulky tool output; dry-run by default)');
  print('  keyflip memory [show <key>]    browse keyflip\'s distilled keepsakes (its own memory store)');
  print('  keyflip recall "<query>" [--semantic] [--answer]   search your chats (BM25; --semantic = embeddings; --answer = `claude -p` synthesis)');
  print('  keyflip settings [show | get <k> | set <k> <v>]   view/edit ~/.claude/settings.json (rides `migrate` to other machines)');
  print('  keyflip statusline install     show the active account + quota in the Claude Code prompt (status line)');
  print('  keyflip panel [--open]         open a local web dashboard: accounts, quotas, providers, sessions, keepsakes');
  print('  keyflip menubar [--install]    xbar/SwiftBar menu-bar plugin: glanceable account+quota, click-to-switch');
  print('  keyflip dream [--older-than 30d] [--archive] [--apply]   consolidate old chats: distill (+ archive) them');
  print('  keyflip dream schedule [--at 03:00] | unschedule | status   run the dream nightly (launchd/cron)');
  print('  keyflip resume <n|id> [--run] [--as <account>]   resume a session (in its dir; --as runs it under another account)');
  print('  keyflip send <id> "<message>" [--as <account>] [--fork]   inject a message into a session (steer/continue it headlessly)');
  print('  keyflip cowork [--search T]    browse Claude desktop Cowork sessions (all accounts)');
  print('  keyflip chat [--limit N | get <id>]   read claude.ai Chat of the active account (experimental)');
  print('  keyflip browser [status|logout|sync]   check/reset/restore the BROWSER claude.ai account so the Claude');
  print('                                 Chrome extension connects (it inherits the browser session)');
  print('  keyflip skill add <owner/repo|./dir|file.tgz>   install a skill; also: skill list|remove');
  print('  keyflip proxy start [--wire] | stop | status | stats');
  print('                                 command-started failover proxy (429/5xx → next account)');
  print('  keyflip status                which account each surface is on (CLI + desktop app)');
  print('  keyflip list [--usage]        saved accounts; --usage adds 5h/7d quota per account');
  print('  keyflip remove <name|number>  delete a saved account');
  print('  keyflip autoswitch            watch usage; auto-swap the CLI account at a threshold');
  print('                                 (--threshold 90 --interval 60 --strategy next-available)');
  print('  keyflip link [name|--remove]  map this directory to an account for `run`');
  print('  keyflip run <name> [-- args]  PARALLEL session: run Claude as that account in THIS');
  print('                                 terminal only (asks first; --no-share = bare profile)');
  print('  keyflip add <name> --token <file|->   headless import of a raw credential (asks first;');
  print('                                 --force for scripts; NEVER pass the token as an argument)');
  print('  keyflip export [file|-]       back up saved accounts to a file (contains secrets!)');
  print('  keyflip import <file|->       restore accounts from an export (--force overwrites)');
  print('  keyflip mcp [--setup]         MCP server over stdio for agents (--setup shows config)');
  print('  keyflip install-skill         install the Claude Code skill that teaches agents keyflip');
  print('  keyflip upgrade               update keyflip itself (auto-detects install method)');
  print('  keyflip reset [--soft] [--logout [--no-desktop]]   FACTORY reset: DELETE all keyflip data');
  print('                                 (--soft keeps accounts, clears only runtime state;');
  print('                                 --logout signs out CLI+browser+desktop, --no-desktop keeps desktop)');
  print('  keyflip uninstall [--purge]   remove keyflip from this machine (auto-detects install;');
  print('                                 --purge also deletes saved data + Keychain items)');
  print('');
  print('Global flags: --json (machine-readable stdout)   --debug (verbose log to stderr + file)');
  print('Tokens stay in the OS credential store; ~/.claude/projects history is account-independent.');
}

// Read a secret from the TTY without echoing it (prompt on stderr).
function promptHidden(question) {
  return new Promise(function (resolve) {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    let muted = false;
    const realWrite = rl._writeToOutput ? rl._writeToOutput.bind(rl) : null;
    rl._writeToOutput = function (s) { if (muted) { process.stderr.write('*'); } else if (realWrite) { realWrite(s); } };
    process.stderr.write(question);
    muted = true;
    rl.question('', function (a) { muted = false; process.stderr.write('\n'); rl.close(); resolve(a || ''); });
  });
}

function confirm(question) {
  return new Promise(function (resolve) {
    // Prompt goes to stderr so it never pollutes stdout (keeps the --json contract:
    // stdout carries only the single JSON object).
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, function (a) { rl.close(); resolve(/^y(es)?$/i.test((a || '').trim())); });
  });
}

// Read one line with the echo muted, reusing an EXISTING readline interface — so we
// never open a second reader on the same stdin (which would fight the caller's rl).
// Needs a terminal; callers (the onboard wizard) already guard on process.stdin.isTTY.
function askHidden(rl, question) {
  return new Promise(function (resolve) {
    const realWrite = rl._writeToOutput ? rl._writeToOutput.bind(rl) : null;
    let muted = false;
    rl._writeToOutput = function (s) { if (muted) { process.stderr.write('*'); } else if (realWrite) { realWrite(s); } };
    process.stderr.write(question);
    muted = true;
    rl.question('', function (a) { muted = false; rl._writeToOutput = realWrite; process.stderr.write('\n'); resolve(a || ''); });
  });
}

async function cmdSwitch(ctx, rest) {
  const arg = rest[0];
  if (!arg) return fail('usage: keyflip <name|number> [--restart|--force] [--browser]');
  const autoYes = rest.indexOf('--restart') !== -1 || rest.indexOf('-y') !== -1 || rest.indexOf('--yes') !== -1;
  const force = rest.indexOf('--force') !== -1;
  const syncBrowser = rest.indexOf('--browser') !== -1;
  const name = core.resolveProfile(ctx, arg);
  if (!name) return fail("no such profile: '" + arg + "' (see: keyflip list)");
  const em = profiles.email(ctx.configDir, name);
  if (em && em === core.currentEmail(ctx)) {
    print("'" + em + "' is already active.");
    jsonOut({ alreadyActive: { name: name, email: em } });
    return;
  }
  logmod.log('switch requested -> ' + name);

  const running = appctl.isClaudeRunning(ctx.platform);
  const manage = appctl.canManageApp(ctx.platform);

  async function refreshIfNeeded() {
    const r = await oauth.maybeRefreshProfile(ctx, name, {
      isRunning: function () { return appctl.isClaudeRunning(ctx.platform); },
      instances: function () { return appctl.claudeInstances(ctx.home); },
    });
    if (r.status === 'refreshed') print('  ↳ refreshed the saved OAuth token (was expiring).');
    else if (r.status === 'refresh-failed') print('  ⚠️ the saved token is expiring and could not be refreshed — you may be asked to log in.');
    else if (r.status === 'persist-failed') {
      print('  ⚠️ token refreshed but could NOT be saved — the stored refresh token is now STALE.');
      print("     Log into this account once and run 'keyflip add' to repair it.");
    }
    logmod.log('oauth refresh: ' + r.status);
  }

  async function emitSwitched(did, appl, cons) {
    logmod.log('switched -> ' + name + ' (cli=' + !!(did && did.cli) + ', app=' + !!(appl && appl.ok) + ')');
    // With --browser: also align the browser's claude.ai session (and thus the
    // Claude Chrome extension) to this account from a saved snapshot. Otherwise
    // just WARN when the browser is on a different account — the native-messaging
    // bridge won't connect on a mismatch.
    if (!JSON_MODE && ctx.platform === 'darwin') {
      try {
        if (syncBrowser) {
          const synced = await browserSync(ctx, name);
          if (synced.length) print('  ' + style.ok('↳') + ' synced the browser (' + synced.join(', ') + ') to this account — the Claude extension reconnects.');
          else print('  ' + style.dim('↳ no saved browser session for this account yet — capture one via `keyflip onboard`/`login` while the browser is signed into it.'));
        } else {
          const browser = require('./browser');
          const meta = profiles.read(ctx.configDir, name) || {};
          const wantOrg = meta.oauthAccount && meta.oauthAccount.organizationUuid;
          if (wantOrg) browser.installed(ctx.home).forEach(function (b) {
            const ck = browser.readClaudeCookies(b, {});
            if (ck && ck.org && ck.org !== wantOrg) {
              print('  ' + style.warn('⚠') + ' ' + b.name + ' claude.ai is a different account — the Claude browser extension won\'t connect here.');
              print('     Fix: ' + style.bold('keyflip ' + name + ' --browser') + ' to auto-sync it, or ' + style.bold('keyflip browser logout') + ' and sign in as ' + (em || name) + '.');
            }
          });
        }
      } catch (e) { /* best-effort — never block a switch on this */ }
    }
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
    // #8: the running desktop app can rewrite the shared login and silently undo an
    // in-place CLI swap. Warn (and point to --restart) when it's on a different account.
    const tug = desktopTugRisk(ctx, name);
    if (tug.risk) {
      print('  ' + style.warn('⚠') + ' Claude Desktop is running on a different account (' + tug.appLabel + ') and may rewrite this CLI login back to it.');
      print('     To make the switch stick: ' + style.bold('keyflip ' + name + ' --restart') + '  (moves the app too), or quit Claude Desktop.');
    }
    // #4: keep chats in sync across accounts. If only the CLI is up (desktop app
    // closed) this syncs now; if the app is open its store is locked, so defer.
    const cons = consolidateAndReport(ctx);
    if (cons && cons.reason) print('  ↳ ' + style.dim('chats will sync across accounts once Claude Desktop is closed (or run `keyflip consolidate`).'));
    await emitSwitched(did, null, null);
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
    await refreshIfNeeded();
    const did = core.performSwitch(ctx, name);
    if (!did.cli) print("  ↳ CLI login for this profile isn't captured — switched the desktop app only.");
    const appl = switchDesktopLogin(ctx, name);
    const cons = consolidateAndReport(ctx);
    print('Reopening Claude...'); appctl.openClaude(ctx.platform);
    print(style.ok('✅') + ' Switched to: ' + (em || name));
    await emitSwitched(did, appl, cons);
    return;
  }
  // App is open but we cannot auto-close it (Linux/Windows).
  if (running && !manage) {
    if (autoYes) {
      const did = core.performSwitch(ctx, name);
      print(style.ok('✅') + ' Switched to: ' + (em || name) + '. Restart Claude Code to apply.');
      await emitSwitched(did, null, null);
      return;
    }
    return fail('Claude / Claude Code is open — close it first (it cannot be auto-closed on this OS), or re-run with --force.');
  }
  // Not running: just swap.
  await refreshIfNeeded();
  const did = core.performSwitch(ctx, name);
  if (!did.cli) print("  ↳ CLI login for this profile isn't captured — switched the desktop app only.");
  const appl = switchDesktopLogin(ctx, name);
  const cons = consolidateAndReport(ctx);
  print(style.ok('✅') + ' Switched to: ' + (em || name) + (manage ? '' : '. Restart Claude Code to apply.'));
  await emitSwitched(did, appl, cons);
}

// Rotate to the next saved account after the currently active one (wraps around).
async function cmdNext(ctx, rest) {
  const list = core.listProfiles(ctx);
  if (list.length < 2) return fail('need at least 2 saved accounts to rotate (see: keyflip add)');
  let idx = -1;
  list.forEach(function (e, i) { if (e.active) idx = i; });
  // candidates in rotation order, starting right after the active account
  const candidates = [];
  for (let k = 1; k <= list.length; k++) {
    const e = list[(idx + k) % list.length];
    if (!e.active) candidates.push(e);
  }
  if (!candidates.length) return fail('no other account to rotate to');

  const si = rest.indexOf('--strategy');
  const strategy = si !== -1 ? rest[si + 1] : null;
  let target = candidates[0];
  if (strategy) {
    if (strategy !== 'best' && strategy !== 'next-available') {
      return fail("unknown strategy '" + strategy + "' — use: best | next-available");
    }
    const infos = await usagemod.usageForProfiles(ctx, candidates.map(function (e) { return e.name; }), {});
    const picked = usagemod.pickByStrategy(candidates, infos, strategy);
    if (!picked) return fail('no account matches strategy \'' + strategy + '\' (usage unknown or all rate-limited)');
    target = picked;
    const info = infos[target.name];
    print('Rotating to: ' + (target.email || target.name) +
      (info && typeof info.headroom === 'number' ? '  (' + usagemod.fmt(info.usage) + ', headroom ' + Math.round(info.headroom) + '%)' : ''));
  } else {
    print('Rotating to: ' + (target.email || target.name));
  }
  // Forward the switch-relevant flags (incl. single-dash -y) so `next -y` doesn't
  // re-prompt; drop --strategy (already consumed here).
  const SWITCH_FLAGS = ['-y', '--yes', '--restart', '--force'];
  const forward = rest.filter(function (a) {
    return SWITCH_FLAGS.indexOf(a) !== -1 || (a.indexOf('--') === 0 && a !== '--strategy');
  });
  return cmdSwitch(ctx, [target.name].concat(forward));
}

// Backup / machine migration: a versioned envelope of saved accounts.
function cmdExport(ctx, rest) {
  const target = rest.filter(function (a) { return a.indexOf('--') !== 0; })[0] || 'keyflip-export.json';
  const r = transfer.buildExport(ctx);
  if (!r.envelope.accounts.length) {
    return fail('nothing to export' + (r.skipped.length ? ' (credentials unreadable for: ' + r.skipped.join(', ') + ')' : ''));
  }
  const json = JSON.stringify(r.envelope, null, 2);
  if (target === '-') process.stdout.write(json + '\n');
  else {
    fs.writeFileSync(target, json + '\n', { mode: 0o600 });
    // writeFileSync's mode does NOT tighten a pre-existing file — chmod explicitly
    // so an export never inherits a looser (world/group-readable) prior mode.
    try { fs.chmodSync(target, 0o600); } catch (e) { /* non-POSIX FS */ }
    print('💾 exported ' + r.envelope.accounts.length + " account(s) to '" + target + "'.");
  }
  r.skipped.forEach(function (n) { print('  ⚠️ skipped (credentials unreadable): ' + n); });
  print(style.warn('⚠️  The export CONTAINS LOGIN SECRETS') + ' — store it safely (or pipe through gpg) and delete it after importing.');
  print('   Desktop-app logins are machine-bound and not included — run keyflip add on the new machine.');
  logmod.log('export: ' + r.envelope.accounts.length + ' account(s)');
}

async function cmdImport(ctx, rest) {
  const target = rest.filter(function (a) { return a.indexOf('--') !== 0; })[0];
  if (!target) return fail('usage: keyflip import <file|-|keyflip://…> [--force]');
  // #11: a keyflip:// share link — decode, PREVIEW, confirm, apply.
  if (/^keyflip:\/\//.test(target)) {
    let parsed;
    try { parsed = share.parse(target); } catch (e) { return fail(e.message); }
    print('This link will import:'); print('  ' + share.preview(parsed).replace(/\n/g, '\n  '));
    if (rest.indexOf('--force') === -1) {
      if (!process.stdin.isTTY) return fail('importing a share link non-interactively requires --force');
      const ok = await confirm('Import it? [y/N] ');
      if (!ok) { print('Cancelled.'); return; }
    }
    const r = share.apply(ctx, parsed);
    print(style.ok('✅') + ' imported ' + r.resource + ' "' + r.name + '"' + (r.note ? '\n  ↳ ' + r.note : ''));
    jsonOut({ imported: r });
    return;
  }
  let raw;
  try { raw = target === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(target, 'utf8'); }
  catch (e) { return fail('cannot read ' + target + ': ' + e.message); }
  let env;
  try { env = JSON.parse(raw); } catch (e) { return fail('that file is not valid JSON'); }
  const r = transfer.applyImport(ctx, env, { force: rest.indexOf('--force') !== -1 });
  print(style.ok('✅') + ' imported: ' + (r.imported.join(', ') || '(none)'));
  if (r.skipped.length) print('  ↳ already present, skipped (use --force to overwrite): ' + r.skipped.join(', '));
  logmod.log('import: ' + r.imported.length + ' account(s)');
}

// Watch the active account and auto-switch the CLI credential at a usage
// threshold (claude-swap PR #76 / issues #38, #50). The desktop app is never
// closed; Claude Code picks the new credential up on its next request.
async function cmdAutoswitch(ctx, rest) {
  function numFlag(flag, dflt) { const i = rest.indexOf(flag); const v = i !== -1 ? parseInt(rest[i + 1], 10) : NaN; return isNaN(v) ? dflt : v; }
  const threshold = Math.min(100, Math.max(50, numFlag('--threshold', 90)));
  const interval = Math.max(30, numFlag('--interval', 60));
  const si = rest.indexOf('--strategy');
  const strategy = si !== -1 ? rest[si + 1] : 'next-available';
  if (strategy !== 'best' && strategy !== 'next-available') return fail('unknown strategy — use: best | next-available');
  const autoYes = rest.indexOf('-y') !== -1 || rest.indexOf('--yes') !== -1;
  if (!autoYes) {
    if (!process.stdin.isTTY) return fail('autoswitch swaps accounts WITHOUT asking each time — re-run with -y to confirm.');
    print('Autoswitch will monitor the active account every ' + interval + 's and, at ' + threshold + '% usage,');
    print(style.warn('swap the CLI credential automatically WITHOUT asking') + ' (strategy: ' + strategy + ').');
    print('The desktop app is never closed. Stop anytime with Ctrl-C.');
    const ok = await confirm('Start? [y/N] ');
    if (!ok) { print('Cancelled.'); return; }
  }
  logmod.log('autoswitch started (threshold=' + threshold + ', strategy=' + strategy + ')');
  for (;;) {
    let r;
    try {
      r = await autosw.tick(ctx, {
        threshold: threshold, strategy: strategy,
        performSwitch: function (name) { return withLock(ctx, function () { return core.performSwitch(ctx, name); }); },
      });
    } catch (e) { r = { state: 'error', error: (e && e.message) || String(e) }; }
    const at = new Date().toTimeString().slice(0, 8);
    if (r.state === 'switched') {
      print('[' + at + '] ' + style.ok('⇄ switched: ') + (r.active.email || r.active.name) + ' → ' + (r.switchedTo.email || r.switchedTo.name) + ' (usage crossed ' + threshold + '%)');
      logmod.log('autoswitch: ' + r.active.name + ' -> ' + r.switchedTo.name);
    } else if (r.state === 'below') {
      print('[' + at + '] ' + (r.active.email || r.active.name) + ': ' + Math.round(100 - r.headroom) + '% used — ok');
    } else if (r.state === 'no-candidate') {
      print('[' + at + '] ' + style.warn('threshold crossed but no other account is available'));
    } else if (r.state === 'unknown') {
      print('[' + at + '] usage unknown (endpoint throttled or offline) — waiting');
    } else if (r.state === 'no-active') {
      print('[' + at + '] no active CLI account — waiting');
    } else if (r.state === 'error') {
      print('[' + at + '] ' + style.warn('tick failed: ' + r.error));
    }
    await sleep(interval * 1000);
  }
}

// Map the current directory (tree) to an account for `keyflip run`.
function cmdLink(ctx, rest) {
  if (rest.indexOf('--remove') !== -1) {
    if (links.remove(ctx, process.cwd())) print('🗑  unlinked ' + process.cwd());
    else print('this directory has no link.');
    return;
  }
  const arg = rest.filter(function (a) { return a.indexOf('-') !== 0; })[0];
  if (!arg) {
    const hit = links.lookup(ctx, process.cwd());
    if (hit) print('linked: ' + hit.name + '  (via ' + hit.dir + ')');
    else print('this directory is not linked — link it with: keyflip link <name>');
    return;
  }
  const name = core.resolveProfile(ctx, arg);
  if (!name) return fail("no such account: '" + arg + "'");
  links.set(ctx, process.cwd(), name);
  print(style.ok('✅') + ' linked ' + process.cwd() + ' → ' + name + "  (used by 'keyflip run' here)");
}

// MCP server (stdio) so agents can inspect/switch accounts themselves.
async function cmdMcp(ctx, rest) {
  if (rest.indexOf('--setup') !== -1) {
    print('Add keyflip as an MCP server:');
    print('');
    print('  Claude Code (CLI):');
    print('    claude mcp add keyflip -- keyflip mcp');
    print('');
    print('  Or in .mcp.json / mcp.json:');
    print(JSON.stringify({ mcpServers: { keyflip: { command: 'keyflip', args: ['mcp'] } } }, null, 2));
    print('');
    print('20 tools cover the full surface — accounts (status/list/switch/next), providers');
    print('(providers/provider_use/provider_add/test_provider), sessions (sessions/resume_command),');
    print('diagnostics (doctor/usage_history), backup, skills (skills/skill_add/skill_remove), and');
    print('the failover proxy (proxy_status/proxy_control).');
    print('Mutating tools require confirm=true — the agent is instructed to ask the user first.');
    return;
  }
  logmod.log('mcp server started');
  return mcp.serve(ctx);
}

// Install the bundled agent skill into ~/.claude/skills so Claude Code learns
// when and how to drive keyflip.
function cmdInstallSkill(ctx, rest) {
  rest = rest || [];
  if (rest.indexOf('--check') !== -1) {
    const st = skill.status(ctx);
    print(st === 'current' ? style.ok('✓ up to date') : (st === 'stale' ? style.warn('⚠ installed skill is out of date — run: keyflip install-skill --update') : 'not installed — run: keyflip install-skill'));
    jsonOut({ skillStatus: st });
    return;
  }
  let r;
  try { r = skill.install(ctx); } catch (e) { return fail(e.message); }
  print(style.ok('✅') + ' installed the keyflip skill to ' + r.dest + '  (' + r.mode + ')');
  if (r.mode === 'symlink') print('Symlinked — future keyflip upgrades update it automatically.');
  print('Claude Code picks it up next session (account switching, provider routing,');
  print('usage-aware rotation, parallel sessions and the MCP tools).');
}

// ---- provider profiles (third-party endpoints via settings.json env) --------
function parseModels(rest) {
  const models = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--model' && rest[i + 1] && rest[i + 1].indexOf('=') !== -1) {
      const kv = rest[i + 1].split('='); models[kv[0]] = kv.slice(1).join('=');
    }
  }
  return models;
}
function collectFlagValues(rest, flag) {
  const out = [];
  for (let i = 0; i < rest.length; i++) if (rest[i] === flag && rest[i + 1] && rest[i + 1].indexOf('--') !== 0) out.push(rest[i + 1]);
  return out;
}

async function cmdProviderAdd(ctx, rest) {
  const name = rest.filter(function (a) { return a.indexOf('-') !== 0; })[0];
  const bi = rest.indexOf('--base-url');
  const baseUrl = bi !== -1 ? rest[bi + 1] : null;
  if (!name || !baseUrl) return fail('usage: keyflip provider add <name> --base-url <url> [--auth-scheme bearer|api-key] [--model default=… --model haiku=…] [--endpoint <url>]… [--key-file <file|->]');
  if (!/^https?:\/\//.test(baseUrl)) return fail('--base-url must be an http(s) URL');
  const asi = rest.indexOf('--auth-scheme');
  const authScheme = asi !== -1 ? rest[asi + 1] : 'bearer';
  // The API key is a secret: read it from a file/stdin (never argv, never `ps`).
  let key = null;
  const kfi = rest.indexOf('--key-file');
  if (kfi !== -1 && rest[kfi + 1]) {
    try { key = (rest[kfi + 1] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(rest[kfi + 1], 'utf8')).trim(); }
    catch (e) { return fail('could not read --key-file: ' + e.message); }
  } else if (process.stdin.isTTY) {
    key = (await promptHidden('API key for ' + name + ' (leave blank for none): ')).trim() || null;
  }
  const meta = provider.add(ctx, name, {
    baseUrl: baseUrl, authScheme: authScheme, key: key,
    models: parseModels(rest), endpointCandidates: collectFlagValues(rest, '--endpoint'),
  });
  logmod.log('provider add ' + name);
  print(style.ok('✅') + " saved provider '" + name + "' -> " + meta.baseUrl + (key ? '' : '  (no key stored)'));
  print("Activate it with:  keyflip use " + name + "    (back to your subscription:  keyflip provider off)");
}

function cmdProviderList(ctx) {
  const names = provider.list(ctx);
  const active = provider.readActive(ctx);
  if (JSON_MODE) {
    jsonOut({ providers: names.map(function (n) { const m = provider.read(ctx, n); return { name: n, baseUrl: m && m.baseUrl, active: !!(active && active.name === n) }; }), active: active ? active.name : null });
    return;
  }
  print('Providers (' + provider.providersDir(ctx) + '):');
  if (!names.length) { print('  (none — add one with: keyflip provider add <name> --base-url …)'); }
  names.forEach(function (n) {
    const m = provider.read(ctx, n);
    print(' ' + (active && active.name === n ? '→' : ' ') + ' ' + n + '   ' + (m ? m.baseUrl : '?') +
      (active && active.name === n ? '   ← active' : ''));
  });
  print('');
  print('Active endpoint: ' + (active ? active.name : 'official (your Anthropic subscription / OAuth login)'));
}

async function cmdProviderUse(ctx, name) {
  if (!name) return fail('usage: keyflip use <provider-name>   (or: keyflip provider off)');
  if (name === 'official' || name === 'off') {
    provider.useOfficial(ctx);
    logmod.log('provider -> official');
    print(style.ok('✅') + ' switched Claude Code back to your Anthropic subscription (OAuth). No restart needed.');
    jsonOut({ provider: 'official' });
    return;
  }
  if (!provider.exists(ctx, name)) return fail("no such provider: '" + name + "' (see: keyflip provider list)");
  const r = provider.use(ctx, name);
  logmod.log('provider -> ' + name);
  print(style.ok('✅') + ' Claude Code now uses provider: ' + name + '  (' + r.baseUrl + '). No restart needed.');
  jsonOut({ provider: name, baseUrl: r.baseUrl });
}

async function cmdProvider(ctx, rest) {
  const sub = rest[0];
  const args = rest.slice(1);
  switch (sub) {
    case 'add': return withLock(ctx, function () { return cmdProviderAdd(ctx, args); }, 'provider');
    case 'list': case undefined: return cmdProviderList(ctx);
    case 'use': return withLock(ctx, function () { return cmdProviderUse(ctx, args[0]); }, 'provider');
    case 'off': case 'official': return withLock(ctx, function () { return cmdProviderUse(ctx, 'official'); }, 'provider');
    case 'remove': case 'rm':
      return withLock(ctx, function () {
        if (!provider.exists(ctx, args[0])) return fail("no such provider: '" + (args[0] || '') + "'");
        provider.remove(ctx, args[0]); print('🗑  removed provider: ' + args[0]);
      }, 'provider');
    default: return fail("unknown: keyflip provider " + sub + " (use: add | list | use | off | remove)");
  }
}

async function cmdSpeedtest(ctx, rest) {
  const name = rest.filter(function (a) { return a.indexOf('-') !== 0; })[0];
  const names = name ? [name] : provider.list(ctx);
  if (!names.length) return fail('no providers to test (add one: keyflip provider add …)');
  for (let i = 0; i < names.length; i++) {
    if (!provider.exists(ctx, names[i])) { fail("no such provider: '" + names[i] + "'"); continue; }
    const r = await provider.speedtest(ctx, names[i]);
    print(names[i] + ':');
    r.results.forEach(function (x) { print('   ' + (x.ok ? String(x.ms) + 'ms ' + x.bucket : 'unreachable') + '   ' + x.url); });
    if (r.chosen) print('   → fastest: ' + r.chosen);
  }
}

// #12 usage trend + failover event history
async function cmdUsage(ctx, rest) {
  if (rest.indexOf('--history') === -1) {
    // no --history: behave like `list --usage`
    return cmdList(ctx, ['--usage'].concat(rest));
  }
  const li = rest.indexOf('--limit');
  const limit = li !== -1 ? (parseInt(rest[li + 1], 10) || 50) : 50;
  const samples = history.readUsage(ctx, limit);
  const events = history.readEvents(ctx, limit);
  if (JSON_MODE) { jsonOut({ usage: samples, events: events }); return; }
  print('Usage history (last ' + samples.length + ' samples):');
  samples.forEach(function (s) {
    print('  ' + s.at + '  ' + s.account + '  ' + (s.status === 'ok' ? ('5h ' + Math.round(s.fiveHour) + '% · 7d ' + Math.round(s.sevenDay) + '%') : s.status));
  });
  if (events.length) {
    print('');
    print('Failover / autoswitch events:');
    events.forEach(function (e) { print('  ' + e.at + '  ' + (e.kind || 'event') + ': ' + (e.from || '?') + ' → ' + (e.to || '?') + (e.reason ? '  (' + e.reason + ')' : '')); });
  }
  if (!samples.length && !events.length) print('  (nothing recorded yet — run: keyflip list --usage)');
}

// #15 MCP registry
function readSecretArg(rest, flag) {
  const i = rest.indexOf(flag);
  if (i === -1 || !rest[i + 1]) return null;
  try { return (rest[i + 1] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(rest[i + 1], 'utf8')).trim(); }
  catch (e) { return null; }
}
// Positional (non-flag) args, skipping value-taking flags AND the values they consume,
// so e.g. `--passphrase-file f` is never mistaken for the positional file/host. The
// lone `-` (stdin/stdout sentinel) is a positional, not a flag.
function positionals(args, valueFlags) {
  valueFlags = valueFlags || [];
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.length > 1 && a[0] === '-') { // a flag (--x or -x), not the `-` sentinel
      if (valueFlags.indexOf(a) !== -1) i++; // consume its value too
      continue;
    }
    out.push(a);
  }
  return out;
}
function cmdMcpreg(ctx, rest) {
  const sub = rest[0]; const args = rest.slice(1);
  if (sub === 'add') {
    const name = args.filter(function (a) { return a.indexOf('-') !== 0; })[0];
    const sep = args.indexOf('--');
    if (!name || sep === -1) return fail('usage: keyflip mcpreg add <name> -- <command> [args…]');
    const cmdArr = args.slice(sep + 1);
    mcpreg.add(ctx, name, { command: cmdArr[0], args: cmdArr.slice(1) });
    print(style.ok('✅') + " registered MCP server '" + name + "'  (enable it: keyflip mcpreg enable " + name + " --all)");
    return;
  }
  if (sub === 'list' || sub === undefined) {
    const items = mcpreg.list(ctx);
    if (JSON_MODE) { jsonOut({ servers: items }); return; }
    if (!items.length) { print('No MCP servers registered (add one: keyflip mcpreg add …).'); return; }
    items.forEach(function (s) { print('  ' + s.name + '   ' + s.command + ' ' + (s.args || []).join(' ')); });
    return;
  }
  if (sub === 'enable' || sub === 'disable') {
    const name = args.filter(function (a) { return a.indexOf('-') !== 0; })[0];
    if (!name) return fail('usage: keyflip mcpreg ' + sub + ' <name> [--code|--desktop|--all]');
    const surfaces = [];
    if (args.indexOf('--all') !== -1 || (args.indexOf('--code') === -1 && args.indexOf('--desktop') === -1)) { surfaces.push('claude-code', 'claude-desktop'); }
    else { if (args.indexOf('--code') !== -1) surfaces.push('claude-code'); if (args.indexOf('--desktop') !== -1) surfaces.push('claude-desktop'); }
    surfaces.forEach(function (s) {
      const r = mcpreg.setEnabled(ctx, name, s, sub === 'enable');
      print('  ' + s + ': ' + (r === 'skipped-no-config' ? 'skipped (app config not present)' : (sub === 'enable' ? 'enabled' : 'disabled')));
    });
    return;
  }
  if (sub === 'remove' || sub === 'rm') { mcpreg.remove(ctx, args[0]); print('🗑  removed MCP server: ' + args[0]); return; }
  if (sub === 'import') { const imp = mcpreg.importLive(ctx); print('imported ' + imp.length + ' server(s): ' + imp.join(', ')); return; }
  return fail('usage: keyflip mcpreg [add|list|enable|disable|remove|import]');
}

// #17 Claude Desktop third-party gateway
function cmdGateway(ctx, rest) {
  const sub = rest[0];
  if (sub === 'use') {
    if (!provider.exists(ctx, rest[1])) return fail("no such provider: '" + (rest[1] || '') + "'");
    const r = desktopgw.use(ctx, rest[1]);
    print(style.ok('✅') + ' Claude desktop app -> gateway "' + rest[1] + '" (' + r.dirs + ' config dir(s)). Restart the app to apply.');
    return;
  }
  if (sub === 'off' || sub === 'restore') { desktopgw.restore(ctx); print(style.ok('✅') + ' Claude desktop app restored to first-party (Anthropic). Restart the app.'); return; }
  if (sub === 'status' || sub === undefined) { const a = desktopgw.active(ctx); print(a ? ('Desktop gateway: ' + a.provider) : 'Desktop app: first-party (Anthropic)'); return; }
  return fail('usage: keyflip gateway [use <provider>|off|status]');
}

// #18 encrypted WebDAV sync
async function cmdSync(ctx, rest) {
  const sub = rest[0];
  const ui = rest.indexOf('--url'); const url = ui !== -1 ? rest[ui + 1] : null;
  const useri = rest.indexOf('--user'); const user = useri !== -1 ? rest[useri + 1] : null;
  const o = { url: url, user: user, pass: readSecretArg(rest, '--pass-file'), passphrase: readSecretArg(rest, '--passphrase-file') };
  if (sub === 'test') { if (!url) return fail('usage: keyflip sync test --url <webdav-url> [--user U --pass-file f]'); const r = await sync.test(o); print(r.ok ? style.ok('✓') + ' reachable (http ' + r.httpStatus + ')' : style.err('✗') + ' ' + (r.reason || 'unreachable')); return; }
  if (sub === 'push') { if (!url || !o.passphrase) return fail('usage: keyflip sync push --url <u> --passphrase-file <f> [--user U --pass-file f]'); const r = await sync.push(ctx, o); print(style.ok('✅') + ' pushed ' + r.pushed + ' account(s), encrypted.'); return; }
  if (sub === 'pull') {
    if (!url || !o.passphrase) return fail('usage: keyflip sync pull --url <u> --passphrase-file <f> [--force]');
    const p = await sync.pull(ctx, o);
    if (!p.found) return fail('no snapshot at that URL');
    print('Remote snapshot: ' + p.meta.accounts + ' account(s), from "' + p.meta.device + '" at ' + p.meta.at + ' (schema v' + p.meta.schema + ')');
    if (rest.indexOf('--force') === -1) {
      if (!process.stdin.isTTY) return fail('applying a pulled snapshot non-interactively requires --force');
      const ok = await confirm('Apply it? A safety backup will be taken first. [y/N] ');
      if (!ok) { print('Cancelled.'); return; }
    }
    const res = sync.apply(ctx, p, { force: rest.indexOf('--force') !== -1 });
    print(style.ok('✅') + ' applied. imported: ' + (res.imported.join(', ') || '(none)') + (res.skipped.length ? '; skipped: ' + res.skipped.join(', ') : ''));
    return;
  }
  return fail('usage: keyflip sync [test|push|pull] --url <webdav-url> --passphrase-file <file> [--user U --pass-file f]');
}

// E2: parse selective-bundle filters (which accounts/sessions/memory to include) shared by
// migrate export/push and transfer serve.
const BUNDLE_VALUE_FLAGS = ['--passphrase-file', '--url', '--user', '--pass-file', '--sessions', '--search', '--newer-than', '--older-than', '--limit'];
function bundleFilterOpts(rest) {
  const o = {
    noSessions: rest.indexOf('--no-sessions') !== -1,
    noProviders: rest.indexOf('--no-providers') !== -1,
    noMemory: rest.indexOf('--no-memory') !== -1,
    noAccounts: rest.indexOf('--no-accounts') !== -1,
    noConfig: rest.indexOf('--no-config') !== -1,
  };
  const si = rest.indexOf('--sessions');
  if (si !== -1 && rest[si + 1]) o.sessions = rest[si + 1].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  const se = flagVal(rest, '--search'); if (se) o.search = se;
  const nt = rest.indexOf('--newer-than'); if (nt !== -1) o.newerThanDays = parseDays(rest[nt + 1]);
  const ot = rest.indexOf('--older-than'); if (ot !== -1) o.olderThanDays = parseDays(rest[ot + 1]);
  // J1: --agents (all present) or --agents=cursor,gemini opts IN other agents' home-level
  // memory (default OFF; secrets never carried). The `=` form avoids a stray positional
  // being mistaken for the output path.
  const av = rest.filter(function (a) { return a === '--agents' || a.indexOf('--agents=') === 0; })[0];
  if (av) {
    o.agents = true;
    if (av.indexOf('=') !== -1) o.agentIds = av.slice(av.indexOf('=') + 1).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }
  // J1 config-tier: --agent-config carries other agents' config files, redacted by default.
  const acv = rest.filter(function (a) { return a === '--agent-config' || a.indexOf('--agent-config=') === 0; })[0];
  if (acv) {
    o.agentConfig = true;
    if (acv.indexOf('=') !== -1) o.agentIds = acv.slice(acv.indexOf('=') + 1).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }
  // Opt IN to carrying the REAL keys (not redacted). The caller must encrypt the bundle; the
  // CLI refuses to write plaintext secrets to an unencrypted file.
  if (rest.indexOf('--agent-config-secrets') !== -1) { o.agentConfig = true; o.agentConfigSecrets = true; }
  if (rest.indexOf('--only-sessions') !== -1) { o.noAccounts = true; o.noProviders = true; o.noMemory = true; o.noConfig = true; }
  if (rest.indexOf('--only-memory') !== -1) { o.noAccounts = true; o.noProviders = true; o.noSessions = true; o.noConfig = true; }
  if (rest.indexOf('--only-config') !== -1) { o.noAccounts = true; o.noProviders = true; o.noSessions = true; o.noMemory = true; }
  if (rest.indexOf('--only-agents') !== -1) { o.agents = true; o.noAccounts = true; o.noProviders = true; o.noSessions = true; o.noMemory = true; o.noConfig = true; }
  if (rest.indexOf('--only-agent-config') !== -1) { o.agentConfig = true; o.agents = false; o.noAccounts = true; o.noProviders = true; o.noSessions = true; o.noMemory = true; o.noConfig = true; }
  return o;
}

// J1: show which OTHER agents' home-level memory keyflip can carry (existence-gated).
function cmdAgents(ctx, rest) {
  const agents = require('./agents');
  const present = agents.presentAgents(ctx);
  const cfgPresent = agents.presentAgentConfig(ctx);
  const rows = agents.REGISTRY.map(function (a) {
    const files = present.indexOf(a.id) !== -1 ? agents.collectAgentMemory(ctx, { only: [a.id] }) : [];
    const cfg = cfgPresent.indexOf(a.id) !== -1 ? agents.collectAgentConfig(ctx, { only: [a.id] }) : [];
    const redactions = cfg.reduce(function (n, c) { return n + (c.redactions || 0); }, 0);
    return { id: a.id, label: a.label, roots: a.roots, present: present.indexOf(a.id) !== -1, files: files.length, config: cfg.length, redactions: redactions };
  });
  if (JSON_MODE) { jsonOut({ agents: rows }); return; }
  print(style.bold('Other agents keyflip can carry') + ' ' + style.dim('(memory = home-level markdown; config = MCP/settings, redacted):'));
  rows.forEach(function (r) {
    const mark = (r.present || r.config) ? style.ok('●') : style.dim('○');
    const parts = [];
    if (r.present) parts.push(r.files + ' memory file(s)');
    if (r.config) parts.push(r.config + ' config file(s)' + (r.redactions ? ' (' + r.redactions + ' secret' + (r.redactions === 1 ? '' : 's') + ' redacted)' : ''));
    const detail = parts.length ? parts.join(', ') : 'not found';
    print('  ' + mark + ' ' + r.label.padEnd(12) + ' ' + style.dim(detail));
  });
  const anyMem = rows.some(function (r) { return r.present; });
  const anyCfg = rows.some(function (r) { return r.config; });
  print('');
  if (anyMem) print(style.dim('Carry memory:  ') + style.bold('keyflip migrate export bundle.json --agents') + style.dim('  (or --agents=cursor,gemini)'));
  if (anyCfg) print(style.dim('Carry config:  ') + style.bold('keyflip migrate export bundle.json --agent-config') + style.dim('  (secrets are ALWAYS redacted — re-enter keys on the new machine)'));
  if (!anyMem && !anyCfg) print(style.dim('None detected on this machine. Auth/credential files are never carried.'));
}

// Move a whole machine's Claude world to another one: ALL accounts (secrets) +
// providers (keys) + every Claude Code session transcript in one bundle, and on
// the target MERGE (union) them with whatever is already there.
async function cmdMigrate(ctx, rest) {
  const migrate = require('./migrate');
  const sub = rest[0];
  const target = positionals(rest.slice(1), BUNDLE_VALUE_FLAGS)[0];
  const passphraseGiven = rest.indexOf('--passphrase-file') !== -1;
  const passphrase = readSecretArg(rest, '--passphrase-file'); // optional encryption
  // A passphrase-file that was asked for but is unreadable must NOT silently fall back
  // to writing/reading an UNENCRYPTED secrets bundle.
  if (passphraseGiven && !passphrase) return fail('cannot read the --passphrase-file (refusing to proceed unencrypted).');
  const force = rest.indexOf('--force') !== -1;

  if (sub === 'export') {
    const out = target || 'keyflip-migrate.json';
    const fopts = bundleFilterOpts(rest);
    const built = migrate.buildBundle(ctx, fopts);
    if (!built.counts.accounts && !built.counts.transcripts && !built.counts.providers && !built.counts.memory && !built.counts.config && !built.counts.agents && !built.counts.agentConfig) {
      return fail('nothing to migrate (no accounts, providers, transcripts, or memory found).');
    }
    let json = JSON.stringify(built.bundle);
    if (passphrase) json = sync.encrypt(json, passphrase); // returns the JSON envelope string
    // When writing to stdout (`-`), the bundle IS the stdout payload — the human notes
    // must go to stderr so they don't corrupt a piped/redirected bundle.
    const note = (out === '-' || JSON_MODE) ? function (s) { process.stderr.write((s == null ? '' : s) + '\n'); } : print;
    if (out === '-') process.stdout.write(json + '\n');
    else {
      fs.writeFileSync(out, json + '\n', { mode: 0o600 });
      try { fs.chmodSync(out, 0o600); } catch (e) { /* non-POSIX FS */ }
      note('📦 migrate bundle written to ' + style.bold("'" + out + "'") + ':');
      note('   ' + built.counts.accounts + ' account(s), ' + built.counts.providers + ' provider(s), ' + built.counts.transcripts + ' transcript(s), ' + built.counts.memory + ' memory file(s), ' + built.counts.config + ' config item(s)' + (built.counts.agents ? ', ' + built.counts.agents + ' agent-memory file(s)' : '') + (built.counts.agentConfig ? ', ' + built.counts.agentConfig + ' agent-config file(s) (' + (fopts.agentConfigSecrets ? 'WITH API keys' : 'redacted') + ')' : '') + '.');
    }
    built.skippedAccounts.forEach(function (n) { note('  ⚠️ account skipped (credentials unreadable): ' + n); });
    // Only accounts (login secrets), providers (API keys), and an opt-in agent-config-with-keys
    // are sensitive; a redacted/memory/sessions-only bundle carries none, so don't cry wolf.
    const agentSecretsCarried = fopts.agentConfigSecrets && (built.bundle.agentConfig || []).some(function (c) { return c.redacted === false && c.redactions > 0; });
    const hasSecrets = built.counts.accounts || built.counts.providers || agentSecretsCarried;
    if (passphrase) note(style.ok('🔒') + ' encrypted (AES-256-GCM); import with the same --passphrase-file.');
    else if (hasSecrets) note(style.warn('⚠️  This bundle CONTAINS SECRETS' + (agentSecretsCarried ? ' (incl. agent API keys)' : ' (login tokens)')) + ' — encrypt it (--passphrase-file <f>) or pipe through gpg, and delete it after importing.');
    else note(style.dim('   No account/provider secrets in this bundle (memory/sessions only), but encrypt it anyway if it leaves your machine.'));
    note('   Desktop-app login and browser sessions are machine-bound — re-capture them on the new machine (' + style.bold('keyflip onboard') + ').');
    logmod.log('migrate export: ' + built.counts.accounts + ' acct, ' + built.counts.transcripts + ' tx');
    jsonOut({ migrateExport: { path: out === '-' ? null : out, encrypted: !!passphrase, counts: built.counts } });
    return;
  }

  if (sub === 'import') {
    if (!target) return fail('usage: keyflip migrate import <file|-> [--force] [--passphrase-file <f>]');
    let raw;
    try { raw = target === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(target, 'utf8'); }
    catch (e) { return fail('cannot read ' + target + ': ' + e.message); }
    let obj;
    try { obj = JSON.parse(raw); } catch (e) { return fail('that file is not valid JSON'); }
    // Encrypted bundle? (sync.encrypt envelope) — decrypt with the passphrase.
    if (obj && obj.magic === 'keyflip-sync') {
      if (!passphrase) return fail('this bundle is encrypted — pass --passphrase-file <file>');
      let plain;
      try { plain = sync.decrypt(raw, passphrase); } catch (e) { return fail(e.message); }
      try { obj = JSON.parse(plain); } catch (e) { return fail('decrypted bundle is not valid JSON'); }
    }
    let res;
    try { res = migrate.applyBundle(ctx, obj, { force: force }); }
    catch (e) { return fail(e.message); }
    const tx = res.transcripts;
    print(style.ok('✅') + ' merged this machine with the bundle:');
    print('  accounts:    imported ' + (res.accounts.imported.join(', ') || '(none)') + (res.accounts.skipped.length ? '; kept existing: ' + res.accounts.skipped.join(', ') : ''));
    print('  providers:   imported ' + (res.providers.imported.join(', ') || '(none)') + (res.providers.skipped.length ? '; kept existing: ' + res.providers.skipped.join(', ') : ''));
    print('  transcripts: ' + tx.added + ' added, ' + tx.kept + ' already here (kept)' + (tx.overwritten ? ', ' + tx.overwritten + ' overwritten' : '') + (tx.skipped ? ', ' + tx.skipped + ' skipped' : ''));
    const mem = res.memory || { added: 0, kept: 0, overwritten: 0 };
    print('  memory:      ' + mem.added + ' added, ' + mem.kept + ' already here (kept)' + (mem.overwritten ? ', ' + mem.overwritten + ' overwritten' : ''));
    const cfg = res.config || { written: [], kept: [] };
    print('  config:      ' + (cfg.written.length ? cfg.written.join(', ') : 'none new') + (cfg.kept.length ? '  (kept: ' + cfg.kept.join(', ') + ')' : ''));
    const ag = res.agents || { added: 0, kept: 0, overwritten: 0 };
    if (ag.total) print('  agents:      ' + ag.added + ' added, ' + ag.kept + ' already here (kept)' + (ag.overwritten ? ', ' + ag.overwritten + ' overwritten' : '') + (ag.skipped ? ', ' + ag.skipped + ' skipped' : ''));
    const agc = res.agentConfig || { total: 0 };
    if (agc.total) {
      const withKeys = (obj.agentConfig || []).some(function (c) { return c && c.redacted === false; });
      print('  agent-config:' + agc.added + ' added, ' + agc.kept + ' already here (kept)' + (agc.overwritten ? ', ' + agc.overwritten + ' overwritten' : '') + (agc.skipped ? ', ' + agc.skipped + ' skipped' : '') + '  ' + style.dim(withKeys ? '(WITH API keys — the sender opted in)' : '(secrets redacted)'));
    }
    if ((res.accounts.skipped.length || res.providers.skipped.length || tx.kept) && !force) {
      print(style.dim('  (existing entries were kept — re-run with --force to overwrite them instead.)'));
    }
    // Best-effort: let the desktop app see the combined session set too.
    if (rest.indexOf('--no-consolidate') === -1) {
      const cons = consolidateAndReport(ctx);
      if (cons && cons.reason) print('  ↳ ' + style.dim('desktop chat sync deferred: ' + cons.reason + ' (run `keyflip consolidate` with the app closed).'));
    }
    jsonOut({ migrated: { accounts: res.accounts, providers: res.providers, transcripts: tx } });
    logmod.log('migrate import: +' + tx.added + ' tx, ' + res.accounts.imported.length + ' acct');
    return;
  }

  // Cloud relay (no-LAN path): move the bundle through a WebDAV server, reusing
  // sync's encrypted transport. Passphrase is REQUIRED (the payload has secrets).
  if (sub === 'push') {
    const ui = rest.indexOf('--url'); const url = ui !== -1 ? rest[ui + 1] : null;
    const useri = rest.indexOf('--user'); const user = useri !== -1 ? rest[useri + 1] : null;
    if (!url || !passphrase) return fail('usage: keyflip migrate push --url <webdav-url> --passphrase-file <f> [--user U --pass-file f] [--no-sessions] [--no-providers]');
    const o = Object.assign(bundleFilterOpts(rest), { url: url, user: user, pass: readSecretArg(rest, '--pass-file'), passphrase: passphrase });
    let counts;
    try { counts = await migrate.pushBundle(ctx, o); } catch (e) { return fail(e.message); }
    print(style.ok('☁️') + ' pushed an encrypted bundle: ' + counts.accounts + ' account(s), ' + counts.providers + ' provider(s), ' + counts.transcripts + ' transcript(s), ' + counts.memory + ' memory file(s)' + (counts.agents ? ', ' + counts.agents + ' agent-memory file(s)' : '') + '.');
    print('   On the other machine: ' + style.bold('keyflip migrate pull --url <same-url> --passphrase-file <same-file>'));
    jsonOut({ migratePush: { counts: counts } });
    logmod.log('migrate push: ' + counts.accounts + ' acct, ' + counts.transcripts + ' tx');
    return;
  }
  if (sub === 'pull') {
    const ui = rest.indexOf('--url'); const url = ui !== -1 ? rest[ui + 1] : null;
    const useri = rest.indexOf('--user'); const user = useri !== -1 ? rest[useri + 1] : null;
    if (!url || !passphrase) return fail('usage: keyflip migrate pull --url <webdav-url> --passphrase-file <f> [--user U --pass-file f] [--force]');
    const o = { url: url, user: user, pass: readSecretArg(rest, '--pass-file'), passphrase: passphrase };
    let pulled;
    try { pulled = await migrate.pullBundle(ctx, o); } catch (e) { return fail(e.message); }
    if (!pulled.found) return fail('no bundle at that URL');
    const b = pulled.bundle || {};
    const nAcc = (b.accounts || []).length, nProv = (b.providers || []).length, nTx = (b.transcripts || []).length, nMem = (b.memory || []).length;
    print('Remote bundle: ' + nAcc + ' account(s), ' + nProv + ' provider(s), ' + nTx + ' transcript(s), ' + nMem + ' memory file(s)' + (b.exportedAt ? ' from ' + b.exportedAt : '') + '.');
    if (!force) {
      if (!process.stdin.isTTY) return fail('merging a pulled bundle non-interactively requires --force');
      const ok = await confirm('Merge it into this machine? Existing entries are kept unless --force. [y/N] ');
      if (!ok) { print('Cancelled.'); return; }
    }
    let res;
    // Take the mutation lock ONLY for the write — not across the network pull + prompt above.
    try { res = await withLock(ctx, function () { return migrate.applyBundle(ctx, b, { force: force }); }); } catch (e) { return fail(e.message); }
    const tx = res.transcripts;
    print(style.ok('✅') + ' merged: accounts +' + res.accounts.imported.length + ' (kept ' + res.accounts.skipped.length + '), providers +' + res.providers.imported.length + ', transcripts +' + tx.added + ' (kept ' + tx.kept + (tx.overwritten ? ', overwrote ' + tx.overwritten : '') + '), memory +' + (res.memory ? res.memory.added : 0) + ' (kept ' + (res.memory ? res.memory.kept : 0) + ')' + (res.agents && res.agents.total ? ', agent-memory +' + res.agents.added + ' (kept ' + res.agents.kept + ')' : '') + '.');
    if (rest.indexOf('--no-consolidate') === -1) { const cons = consolidateAndReport(ctx); if (cons && cons.reason) print('  ↳ ' + style.dim('desktop chat sync deferred: ' + cons.reason + ' (run `keyflip consolidate` with the app closed).')); }
    jsonOut({ migratePull: { accounts: res.accounts, providers: res.providers, transcripts: tx } });
    logmod.log('migrate pull: +' + tx.added + ' tx, ' + res.accounts.imported.length + ' acct');
    return;
  }

  return fail('usage: keyflip migrate [export <file> | import <file> | push --url … | pull --url …] [--passphrase-file <f>] [--force] [--no-sessions] [--no-providers]');
}

// Roadmap #10(a): LIVE device-to-device transfer over the LAN. `serve` shows a
// one-time code and streams the encrypted bundle; `pull` (optionally discovering
// the peer via a UDP beacon) fetches + MERGES it. No file, no cloud.
// G6: render the pairing info as a scannable terminal QR (opt-in via --qr on `transfer serve`).
function printTransferQR(rest, host, port, code, fp) {
  if (rest.indexOf('--qr') === -1) return;
  if (!host || host.indexOf('<') === 0) { print('   ' + style.dim('(no LAN address detected — QR skipped)')); return; }
  try {
    const qr = require('./qr');
    const url = require('./lantransfer').pairingUrl(host, port, code, fp);
    print('');
    print('   ' + style.dim('Scan on the other machine (' + url + '):'));
    print(qr.toText(qr.encode(url, { ecc: 'M' }), { quiet: 2 }));
  } catch (e) { print('   ' + style.dim('(QR unavailable: ' + (e && e.message) + ')')); }
}

async function cmdTransfer(ctx, rest) {
  const lan = require('./lantransfer');
  const migrate = require('./migrate');
  const sub = rest[0];
  const pi = rest.indexOf('--port'); const port = pi !== -1 ? (parseInt(rest[pi + 1], 10) || lan.DEFAULT_PORT) : lan.DEFAULT_PORT;

  if (sub === 'serve' && rest.indexOf('--receive') !== -1) {
    // E3: RECEIVE mode — wait for the OTHER machine to PUSH its bundle here, then MERGE it.
    const ti = rest.indexOf('--ttl'); const ttlS = ti !== -1 ? Math.max(15, parseInt(rest[ti + 1], 10) || 120) : 300;
    const force = rest.indexOf('--force') !== -1;
    const handle = lan.serveReceive(ctx, {
      port: port, ttlMs: ttlS * 1000, discovery: rest.indexOf('--no-discovery') === -1,
      onBundle: function (bundle) {
        const res = migrate.applyBundle(ctx, bundle, { force: force });
        if (rest.indexOf('--no-consolidate') === -1 && !appctl.isClaudeRunning(ctx.platform)) { try { appsessions.consolidate(ctx); } catch (e) { /* best-effort */ } }
        const tx = res.transcripts, mem = res.memory || { added: 0 }, ag = res.agents || { added: 0 };
        print('\n' + style.ok('✅') + ' received + merged: accounts +' + res.accounts.imported.length + ', providers +' + res.providers.imported.length + ', transcripts +' + tx.added + ', memory +' + mem.added + (ag.added ? ', agent-memory +' + ag.added : '') + '.');
        return { accounts: res.accounts.imported.length, providers: res.providers.imported.length, transcripts: tx.added, memory: mem.added, agents: ag.added };
      },
    });
    const addrs = handle.addresses.length ? handle.addresses : ['<this-machine-ip>'];
    print(style.bold('📥 keyflip transfer — waiting to RECEIVE on this machine.'));
    print('   One-time code: ' + style.bold(handle.code) + '   (peer fingerprint ' + handle.fingerprint + ')');
    print('   On the machine that HAS the data, run:');
    addrs.forEach(function (ip) { print('     ' + style.bold('keyflip transfer push ' + ip + ':' + handle.port + ' --code ' + handle.code)); });
    printTransferQR(rest, addrs[0], handle.port, handle.code, handle.fingerprint);
    print('   ' + style.dim('Auto-closes after one transfer or ' + ttlS + 's; Ctrl-C to stop.'));
    logmod.log('transfer serve --receive on ' + handle.port);
    const r = await handle.wait;
    if (r.reason === 'received') { try { require('./vcs').autoCommit(ctx, 'transfer receive'); } catch (e) { /* best-effort */ } }
    print(r.reason === 'received' ? style.ok('✅') + ' done — listener closed.' : 'Listener closed (' + r.reason + ').');
    return;
  }

  if (sub === 'push') {
    const host = positionals(rest.slice(1), ['--code', '--port'].concat(BUNDLE_VALUE_FLAGS))[0] || null;
    const ci = rest.indexOf('--code'); const code = ci !== -1 ? rest[ci + 1] : null;
    if (!code) return fail('pass --code XXXX (the one-time code shown on the RECEIVING machine).');
    if (!host) return fail('usage: keyflip transfer push <host:port> --code XXXX   (start `keyflip transfer serve --receive` on the target first)');
    const built = migrate.buildBundle(ctx, bundleFilterOpts(rest));
    if (!built.counts.accounts && !built.counts.transcripts && !built.counts.providers && !built.counts.memory && !built.counts.config && !built.counts.agents && !built.counts.agentConfig) return fail('nothing to send (no accounts, providers, transcripts, or memory match the filters).');
    print('Pushing ' + built.counts.accounts + ' account(s), ' + built.counts.transcripts + ' transcript(s), ' + built.counts.memory + ' memory file(s)' + (built.counts.agents ? ', ' + built.counts.agents + ' agent-memory file(s)' : '') + (built.counts.agentConfig ? ', ' + built.counts.agentConfig + ' agent-config file(s)' : '') + ' to ' + style.bold(host) + '…');
    let resp;
    try { resp = await lan.push({ host: host, code: code, bundle: built.bundle }); } catch (e) { return fail(e.message); }
    const s = (resp && resp.summary) || {};
    print(style.ok('✅') + ' pushed + merged on the peer: accounts +' + (s.accounts || 0) + ', providers +' + (s.providers || 0) + ', transcripts +' + (s.transcripts || 0) + ', memory +' + (s.memory || 0) + (s.agents ? ', agent-memory +' + s.agents : '') + '.');
    jsonOut({ pushed: s });
    return;
  }

  if (sub === 'serve') {
    const ti = rest.indexOf('--ttl'); const ttlS = ti !== -1 ? Math.max(15, parseInt(rest[ti + 1], 10) || 120) : 120;
    let handle;
    try {
      handle = lan.serve(ctx, Object.assign(bundleFilterOpts(rest), { port: port, ttlMs: ttlS * 1000, discovery: rest.indexOf('--no-discovery') === -1 }));
    } catch (e) { return fail(e.message); }
    const addrs = handle.addresses.length ? handle.addresses : ['<this-machine-ip>'];
    print(style.bold('🔗 keyflip transfer — serving on this machine.'));
    print('   Bundle: ' + handle.counts.accounts + ' account(s), ' + handle.counts.providers + ' provider(s), ' + handle.counts.transcripts + ' transcript(s), ' + handle.counts.memory + ' memory file(s)' + (handle.counts.agents ? ', ' + handle.counts.agents + ' agent-memory file(s)' : '') + '.');
    print('   One-time code: ' + style.bold(handle.code) + '   (peer fingerprint ' + handle.fingerprint + ')');
    print('   On the OTHER machine, run one of:');
    addrs.forEach(function (ip) { print('     ' + style.bold('keyflip transfer pull ' + ip + ':' + handle.port + ' --code ' + handle.code)); });
    if (rest.indexOf('--no-discovery') === -1) print('   …or just ' + style.bold('keyflip transfer pull --code ' + handle.code) + ' (auto-discovers this machine on the LAN).');
    printTransferQR(rest, addrs[0], handle.port, handle.code, handle.fingerprint);
    print('   ' + style.dim('Auto-closes after one transfer or ' + ttlS + 's; Ctrl-C to stop.'));
    logmod.log('transfer serve on ' + handle.port);
    const r = await handle.wait;
    print(r.reason === 'transferred' ? style.ok('✅') + ' bundle sent — listener closed.' : 'Listener closed (' + r.reason + ').');
    return;
  }

  if (sub === 'pull') {
    let host = positionals(rest.slice(1), ['--code', '--port', '--ttl'])[0] || null;
    const ci = rest.indexOf('--code'); const code = ci !== -1 ? rest[ci + 1] : null;
    const force = rest.indexOf('--force') !== -1;
    if (!code) return fail('pass --code XXXX (the one-time code shown on the other machine).');
    if (!host) {
      print('Looking for a keyflip transfer on the LAN…');
      let peers = [];
      try { peers = await lan.discover(3000); } catch (e) { peers = []; }
      if (!peers.length) return fail('no peer found — run `keyflip transfer serve` on the other machine, or pass its <host:port>.');
      if (peers.length > 1) {
        print('  found ' + peers.length + ' peers:');
        peers.forEach(function (p, i) { print('   ' + (i + 1) + ') ' + (p.name || '') + ' ' + p.host + ':' + p.port + ' (fp ' + (p.fp || '?') + ')'); });
        return fail('multiple peers — re-run: keyflip transfer pull <host:port> --code ' + code);
      }
      host = peers[0].host + ':' + peers[0].port;
      print('  found ' + (peers[0].name || host) + ' (' + host + ', fp ' + (peers[0].fp || '?') + ').');
    }
    let bundle;
    try { bundle = await lan.pull({ host: host, code: code }); } catch (e) { return fail(e.message); }
    const nAcc = (bundle.accounts || []).length, nProv = (bundle.providers || []).length, nTx = (bundle.transcripts || []).length, nMem = (bundle.memory || []).length;
    print('Received bundle: ' + nAcc + ' account(s), ' + nProv + ' provider(s), ' + nTx + ' transcript(s), ' + nMem + ' memory file(s).');
    if (!force) {
      if (!process.stdin.isTTY) return fail('merging requires confirmation — re-run with --force');
      const ok = await confirm('Merge it into this machine? Existing entries are kept unless --force. [y/N] ');
      if (!ok) { print('Cancelled.'); return; }
    }
    let res;
    // Lock ONLY the write — not the network fetch + confirm prompt above.
    try { res = await withLock(ctx, function () { return require('./migrate').applyBundle(ctx, bundle, { force: force }); }); } catch (e) { return fail(e.message); }
    const tx = res.transcripts;
    print(style.ok('✅') + ' merged: accounts +' + res.accounts.imported.length + ' (kept ' + res.accounts.skipped.length + '), providers +' + res.providers.imported.length + ', transcripts +' + tx.added + ' (kept ' + tx.kept + (tx.overwritten ? ', overwrote ' + tx.overwritten : '') + '), memory +' + (res.memory ? res.memory.added : 0) + ' (kept ' + (res.memory ? res.memory.kept : 0) + ')' + (res.agents && res.agents.total ? ', agent-memory +' + res.agents.added + ' (kept ' + res.agents.kept + ')' : '') + '.');
    if (rest.indexOf('--no-consolidate') === -1) { const cons = consolidateAndReport(ctx); if (cons && cons.reason) print('  ↳ ' + style.dim('desktop chat sync deferred: ' + cons.reason + ' (run `keyflip consolidate` with the app closed).')); }
    jsonOut({ transferred: { accounts: res.accounts, providers: res.providers, transcripts: tx } });
    logmod.log('transfer pull: +' + tx.added + ' tx');
    return;
  }

  return fail('usage: keyflip transfer [serve [--port N] [--ttl S] [--no-discovery] | pull [<host:port>] --code XXXX [--force]] [--no-sessions] [--no-providers]');
}

// Command-activated failover proxy (never a resident daemon).
// G1: `keyflip panel` — a command-activated local web dashboard (loopback, read-only).
async function cmdPanel(ctx, rest) {
  const panel = require('./panel');
  // G8: export a SHARE-SAFE static snapshot instead of serving (no session content, no secrets).
  const ei = rest.indexOf('--export');
  if (ei !== -1) {
    const out = rest[ei + 1] && rest[ei + 1].indexOf('-') !== 0 ? rest[ei + 1] : 'keyflip-snapshot.html';
    const snap = panel.buildSnapshot(ctx, { anon: rest.indexOf('--anon') !== -1 });
    const html = panel.renderSnapshot(snap);
    try { fs.writeFileSync(out, html); } catch (e) { return fail('could not write ' + out + ': ' + (e && e.message)); }
    if (JSON_MODE) { jsonOut({ snapshot: { path: out, anon: snap.anon, accounts: snap.accounts.length } }); return; }
    print(style.ok('📸') + ' shared snapshot written to ' + style.bold("'" + out + "'") + ' ' + style.dim('(' + snap.accounts.length + ' account(s), ' + (snap.activity ? snap.activity.total : 0) + ' sessions/26wk' + (snap.anon ? ', anonymized' : '') + ')'));
    print('   ' + style.dim('Static + self-contained: no session content, no secrets. Open it in any browser or share the file.'));
    logmod.log('panel export -> ' + out);
    return;
  }
  const pi = rest.indexOf('--port'); const port = pi !== -1 ? (parseInt(rest[pi + 1], 10) || 8899) : 8899;
  let h;
  try { h = await panel.serve(ctx, { port: port }); }
  catch (e) { return fail('could not start the panel: ' + (e && e.code === 'EADDRINUSE' ? 'port ' + port + ' is in use (try --port N)' : (e && e.message))); }
  print(style.ok('✅') + ' keyflip panel on ' + style.bold(h.url) + '  ' + style.dim('(read-only, loopback only; Ctrl-C to stop)'));
  if (rest.indexOf('--open') !== -1) {
    const opener = ctx.platform === 'darwin' ? 'open' : ctx.platform === 'win32' ? 'cmd' : 'xdg-open';
    try { exec.run(opener, ctx.platform === 'win32' ? ['/c', 'start', h.url] : [h.url]); } catch (e) { /* ignore */ }
  }
  logmod.log('panel on ' + h.port);
  await new Promise(function () { /* serve until the process is killed (Ctrl-C) */ });
}

// G4: emit xbar/SwiftBar plugin output (or install a wrapper into a plugin folder). Plain
// stdout so the menu-bar host renders it verbatim.
function cmdMenubar(ctx, rest) {
  const menubar = require('./menubar');
  if (rest.indexOf('--install') !== -1) return menubarInstall(ctx, rest);
  process.stdout.write(menubar.render(ctx, {}) + '\n');
}
function menubarInstall(ctx, rest) {
  const menubar = require('./menubar');
  const iv = flagVal(rest, '--interval') || '30s';
  const di = rest.indexOf('--dir'); let dir = di !== -1 ? rest[di + 1] : null;
  // Default to xbar's plugin folder if present (SwiftBar's is user-configured — pass --dir).
  const xbar = path.join(ctx.home, 'Library', 'Application Support', 'xbar', 'plugins');
  if (!dir) { if (fs.existsSync(xbar)) dir = xbar; else return fail('no xbar plugin folder found — pass --dir <your SwiftBar/xbar plugins folder>. (Then it refreshes every ' + iv + '.)'); }
  const ex = menubar.resolveExec({});
  const cmd = [ex.exec].concat(ex.pre).map(function (p) { return /\s/.test(p) ? '"' + p + '"' : p; }).join(' ') + ' menubar';
  const script = '#!/bin/bash\n# keyflip menu-bar plugin (xbar/SwiftBar). Refreshes every ' + iv + '.\nexec ' + cmd + '\n';
  const file = path.join(dir, 'keyflip.' + iv + '.sh');
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, script); fs.chmodSync(file, 0o755); }
  catch (e) { return fail('could not write the plugin: ' + (e && e.message)); }
  if (JSON_MODE) { jsonOut({ menubarInstall: { path: file, interval: iv } }); return; }
  print(style.ok('✅') + ' menu-bar plugin installed: ' + style.bold(file));
  print('   ' + style.dim('Open xbar/SwiftBar (or Refresh all) to see it. It re-runs `keyflip menubar` every ' + iv + '.'));
}

async function cmdProxy(ctx, rest) {
  const proxy = require('./proxy');
  const sub = rest[0];
  const meta = proxy.readMeta(ctx);
  const running = proxy.isRunning(ctx);

  if (sub === 'start') {
    if (running) return fail('proxy already running on 127.0.0.1:' + meta.port + ' (pid ' + meta.pid + ')');
    const pi = rest.indexOf('--port'); const port = pi !== -1 ? parseInt(rest[pi + 1], 10) : proxy.DEFAULT_PORT;
    const wire = rest.indexOf('--wire') !== -1;
    const r = proxy.start(ctx, { wire: wire, port: port });
    if (r.wireError) print(style.warn('⚠️ could not wire settings.json: ' + r.wireError));
    print(style.ok('✅') + ' proxy started on ' + r.url + ' (pid ' + r.pid + ')');
    print(wire && !r.wireError ? 'Wired: Claude Code now routes through it (ANTHROPIC_BASE_URL set). Stop with: keyflip proxy stop'
               : 'Point Claude Code at it:  export ANTHROPIC_BASE_URL=' + r.url + '   (or start with --wire)');
    print('Requests failover across your accounts on 429/5xx; stop it with: keyflip proxy stop');
    return;
  }
  if (sub === 'stop') {
    const r = await proxy.stop(ctx);
    if (r.running === false) return print('proxy is not running.');
    print(style.ok('✅') + ' proxy stopped.' + (r.wired ? ' Unwired settings.json.' : ''));
    return;
  }
  if (sub === 'status' || sub === undefined) {
    if (JSON_MODE) { jsonOut({ running: !!running, meta: meta }); return; }
    if (!running) { print('proxy: not running (start it with: keyflip proxy start [--wire])'); return; }
    print('proxy: running on ' + meta.url + ' (pid ' + meta.pid + ')' + (meta.wired ? ', wired' : ''));
    const st = proxy.stats(ctx);
    print('  routed ' + st.total + ' request(s); accounts used: ' + (Object.keys(st.byAccount).join(', ') || 'none yet'));
    return;
  }
  if (sub === 'stats') {
    const st = proxy.stats(ctx);
    if (JSON_MODE) { jsonOut(st); return; }
    print('Proxy usage (' + st.total + ' requests):');
    Object.keys(st.byAccount).forEach(function (a) { const x = st.byAccount[a]; print('  ' + a + ': ' + x.requests + ' req, ' + x.inputTokens + ' in / ' + x.outputTokens + ' out tokens'); });
    if (!st.total) print('  (nothing yet)');
    return;
  }
  return fail('usage: keyflip proxy [start [--port N] [--wire] | stop | status | stats]');
}

// The detached background server. Runs until killed.
async function proxyServe(ctx, rest) {
  const proxy = require('./proxy');
  const pi = rest.indexOf('--port'); const port = pi !== -1 ? parseInt(rest[pi + 1], 10) : proxy.DEFAULT_PORT;
  logmod.log('proxy serving on ' + port);
  await proxy.serve(ctx, { port: port });
  return new Promise(function () { /* run forever until the process is killed */ });
}

// Cowork sessions (desktop app agent-mode), cross-account, local & read-only.
function cmdCowork(ctx, rest) {
  const cowork = require('./cowork');
  if (!ctx.appDataDir) return fail('the Claude desktop app (macOS) is required for Cowork sessions');
  const sub = rest[0];
  if (sub === 'resume') {
    let row; try { row = cowork.find(ctx, rest[1]); } catch (e) { return fail(e.message); }
    if (!row) return fail('no such cowork session: ' + (rest[1] || ''));
    const rc = cowork.resumeCommand(row);
    if (!rc) return fail('this Cowork session has no underlying Claude Code session to resume');
    print('Resume it with:  cd ' + (rc.cwd || '<dir>') + ' && ' + rc.command + ' ' + rc.args.join(' '));
    return;
  }
  const rows = cowork.list(ctx, { search: flagVal(rest, '--search'), limit: parseInt(flagVal(rest, '--limit'), 10) || 40, includeArchived: rest.indexOf('--all') !== -1 });
  if (JSON_MODE) { jsonOut({ cowork: rows.map(function (r) { return { sessionId: r.sessionId, title: r.title, account: r.account, cwd: r.cwd, lastActivityAt: r.lastActivityAt, cliSessionId: r.cliSessionId }; }) }); return; }
  if (!rows.length) { print('No Cowork sessions found.'); return; }
  rows.forEach(function (r, i) {
    print('  [' + (i + 1) + '] ' + (r.title || r.sessionId.slice(0, 8)) + '   ' + style.dim(r.account || '?') + '   ' + String(r.lastActivityAt || '').slice(0, 16).replace('T', ' '));
    if (r.initialMessage) print('        ' + style.dim('“' + r.initialMessage + '”'));
  });
  print('');
  print('Resume:  keyflip cowork resume <number|id>');
}

// EXPERIMENTAL: read claude.ai cloud Chat conversations (per active account).
async function cmdChat(ctx, rest) {
  const chat = require('./chat');
  if (!ctx.appDataDir) return fail('reading claude.ai Chat needs the desktop app (its session cookie) — macOS only');
  const sub = rest[0];
  try {
    if (sub === 'get') {
      if (!rest[1]) return fail('usage: keyflip chat get <conversation-id>');
      const conv = await chat.get(ctx, rest[1]);
      if (JSON_MODE) { jsonOut({ conversation: conv }); return; }
      print(conv.name || '(untitled)');
      (conv.chat_messages || []).forEach(function (m) {
        const text = (m.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
        print('  ' + (m.sender === 'human' ? '›' : '‹') + ' ' + text.replace(/\s+/g, ' ').slice(0, 200));
      });
      return;
    }
    const r = await chat.list(ctx, { limit: parseInt(flagVal(rest, '--limit'), 10) || 30 });
    if (JSON_MODE) { jsonOut(r); return; }
    print('claude.ai Chat conversations (active account):');
    if (!r.conversations.length) { print('  (none — this account has no cloud Chat conversations)'); return; }
    r.conversations.forEach(function (c) { print('  ' + String(c.updatedAt || '').slice(0, 16).replace('T', ' ') + '  ' + c.name + '   ' + style.dim(c.uuid.slice(0, 8))); });
    print('');
    print('Read one:  keyflip chat get <id>');
  } catch (e) { return fail(e.message); }
}

// Skills marketplace: install arbitrary skills from GitHub/dir/archive.
async function cmdSkill(ctx, rest) {
  const skillstore = require('./skillstore');
  const sub = rest[0]; const args = rest.slice(1);
  if (sub === 'add') {
    const src = args.filter(function (a) { return a.indexOf('-') !== 0; })[0];
    if (!src) return fail('usage: keyflip skill add <owner/repo[@ref][/subdir] | ./dir | file.tar.gz> [--link] [--force]');
    let r;
    try { r = await skillstore.add(ctx, src, { link: args.indexOf('--link') !== -1, force: args.indexOf('--force') !== -1 }); }
    catch (e) { return fail(e.message); }
    print(style.ok('✅') + ' installed ' + r.length + ' skill(s): ' + r.map(function (s) { return s.name + ' (' + s.mode + ')'; }).join(', '));
    print('Claude Code picks them up next session.');
    return;
  }
  if (sub === 'list' || sub === undefined) {
    const items = skillstore.list(ctx);
    if (JSON_MODE) { jsonOut({ skills: items }); return; }
    if (!items.length) { print('No keyflip-installed skills (add one: keyflip skill add owner/repo).'); return; }
    items.forEach(function (s) { print('  ' + s.name + '   ' + (s.source || '') + '   [' + s.mode + ']'); });
    return;
  }
  if (sub === 'remove' || sub === 'rm') {
    try { skillstore.remove(ctx, args[0]); } catch (e) { return fail(e.message); }
    print('🗑  removed skill: ' + args[0]);
    return;
  }
  return fail('usage: keyflip skill [add <src>|list|remove <name>]');
}

// Session manager: browse/search/resume Claude Code conversations (all accounts).
function flagVal(rest, flag) { const i = rest.indexOf(flag); return i !== -1 ? rest[i + 1] : null; }
// `keyflip sessions rebind <old-path> <new-path>` — re-link a project's chat history
// after its folder was renamed/moved (Claude keys transcripts by the encoded cwd and
// refuses a session whose cwd is gone, so a rename orphans the whole history).
function fmtBytes(n) { n = n || 0; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }
// Parse "30d" / "4w" / "6m" / "90" (bare = days) -> number of days, or null.
function parseDays(s) {
  const m = /^(\d+)\s*(d|w|m|day|days|week|weeks|month|months)?$/i.exec(String(s || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 10), u = (m[2] || 'd').toLowerCase()[0];
  return u === 'w' ? n * 7 : u === 'm' ? n * 30 : n;
}

// `keyflip sessions archive <id> | --older-than <30d>` (B1/B2): gzip transcripts into
// keyflip's archive store and remove the live copies. Reversible via `unarchive`.
async function cmdSessionsArchive(ctx, rest) {
  const archive = require('./archive');
  const yes = rest.indexOf('-y') !== -1 || rest.indexOf('--force') !== -1;
  const oi = rest.indexOf('--older-than');
  let targets = [];
  if (oi !== -1) {
    const days = parseDays(rest[oi + 1]);
    if (!days) return fail('usage: keyflip sessions archive --older-than <30d|4w|90>');
    const cutoff = Date.now() - days * 86400000;
    targets = sessions.list(ctx, { limit: 100000 }).filter(function (r) { return r.mtimeMs < cutoff; })
      .map(function (r) { return { project: r.project, sessionId: r.sessionId }; });
    if (!targets.length) return fail('no sessions older than ' + days + ' day(s).');
    print('Archive ' + style.bold(String(targets.length)) + ' session(s) older than ' + days + ' day(s) — gzipped into keyflip (reversible: keyflip sessions unarchive).');
  } else {
    const id = positionals(rest, [])[0];
    if (!id) return fail('usage: keyflip sessions archive <id> | --older-than <30d>');
    let row; try { row = sessions.find(ctx, id); } catch (e) { return fail(e.message); }
    if (!row) return fail("no live session matches '" + id + "'.");
    targets = [{ project: row.project, sessionId: row.sessionId }];
    print('Archive session ' + style.bold(row.sessionId.slice(0, 8)) + ' (' + (row.cwd || '?') + ').');
  }
  if (!yes) {
    if (!process.stdin.isTTY) return fail('re-run with -y to confirm.');
    if (!(await confirm('Proceed? [y/N] '))) { print('Cancelled.'); return; }
  }
  let done = 0, savedIn = 0, savedGz = 0;
  await withLock(ctx, function () {
    targets.forEach(function (t) {
      const r = archive.archiveSession(ctx, t.project, t.sessionId);
      if (r.ok) { done++; savedIn += r.bytes; savedGz += r.gzBytes; }
    });
  });
  print(style.ok('✅') + ' archived ' + done + ' session(s)' + (savedIn ? ' (' + fmtBytes(savedIn) + ' → ' + fmtBytes(savedGz) + ' gzipped)' : '') + '.');
  jsonOut({ archived: { count: done, bytes: savedIn, gzBytes: savedGz } });
}

async function cmdSessionsUnarchive(ctx, rest) {
  const archive = require('./archive');
  const id = positionals(rest, [])[0];
  if (!id) return fail('usage: keyflip sessions unarchive <id>   (list with: keyflip sessions archived)');
  const row = archive.findArchived(ctx, id);
  if (!row) return fail("no archived session matches '" + id + "'.");
  let r;
  await withLock(ctx, function () { r = archive.unarchiveSession(ctx, row.project, row.sessionId); });
  if (!r.ok) return fail('unarchive failed: ' + (r.reason || 'unknown'));
  print(style.ok('✅') + ' restored ' + row.sessionId.slice(0, 8) + ' → ' + r.dest);
  jsonOut({ unarchived: row.sessionId });
}

function cmdSessionsArchived(ctx) {
  const rows = require('./archive').listArchived(ctx);
  if (JSON_MODE) { jsonOut({ archived: rows.map(function (r) { return { sessionId: r.sessionId, project: r.project, gzBytes: r.gzBytes, mtime: r.mtime }; }) }); return; }
  if (!rows.length) { print('No archived sessions. Archive some with: keyflip sessions archive --older-than 30d'); return; }
  let total = 0;
  rows.forEach(function (r, i) { total += r.gzBytes; print('  [' + (i + 1) + '] ' + r.sessionId.slice(0, 8) + '  ' + r.mtime.slice(0, 16).replace('T', ' ') + '  ' + fmtBytes(r.gzBytes) + '  ' + sessions.decodeProjectDir(r.project)); });
  print('\n' + rows.length + ' archived (' + fmtBytes(total) + ' gzipped). Restore: keyflip sessions unarchive <id>');
}

// A2: assign a session to a specific account, so `keyflip resume <id> --run` continues it
// AS that account (isolated) without switching the machine's active profile.
function cmdSessionsAssign(ctx, rest) {
  const sessionmap = require('./sessionmap');
  const pos = positionals(rest, []);
  const id = pos[0], acct = pos[1];
  if (!id || !acct) return fail('usage: keyflip sessions assign <id> <account>');
  let row; try { row = sessions.find(ctx, id); } catch (e) { return fail(e.message); }
  if (!row) return fail("no session matches '" + id + "'.");
  const name = core.resolveProfile(ctx, acct);
  if (!name) return fail("no such account: '" + acct + "' (see: keyflip list)");
  sessionmap.set(ctx, row.sessionId, name);
  print(style.ok('✅') + ' assigned session ' + style.bold(row.sessionId.slice(0, 8)) + ' → ' + style.bold(profiles.email(ctx.configDir, name) || name) +
    '.  Resume it there: ' + style.bold('keyflip resume ' + row.sessionId.slice(0, 8) + ' --run') + ' (no profile switch).');
  jsonOut({ assigned: { session: row.sessionId, account: name } });
}
function cmdSessionsUnassign(ctx, rest) {
  const sessionmap = require('./sessionmap');
  const id = positionals(rest, [])[0];
  if (!id) return fail('usage: keyflip sessions unassign <id>');
  let row; try { row = sessions.find(ctx, id); } catch (e) { row = null; }
  const key = row ? row.sessionId : id;
  const had = sessionmap.unset(ctx, key);
  print(had ? style.ok('✅') + ' unassigned ' + key.slice(0, 8) + '.' : 'session ' + key.slice(0, 8) + ' was not assigned.');
  jsonOut({ unassigned: key });
}

// B3: compact a transcript — elide bulky tool output, keep the conversation. Dry-run by
// default (shows the size reduction); --apply rewrites it in place (git is the undo net).
async function cmdSessionsCompact(ctx, rest) {
  const id = positionals(rest, [])[0];
  if (!id) return fail('usage: keyflip sessions compact <id> [--apply]');
  let row; try { row = sessions.find(ctx, id); } catch (e) { return fail(e.message); }
  if (!row) return fail("no session matches '" + id + "'.");
  let content; try { content = fs.readFileSync(row.file, 'utf8'); } catch (e) { return fail('cannot read the transcript.'); }
  const r = sessions.compactTranscript(content, {});
  if (r.elided === 0) { print('Nothing to compact in ' + row.sessionId.slice(0, 8) + ' (no bulky tool output).'); return; }
  const saved = r.before - r.after;
  print('Compact ' + style.bold(row.sessionId.slice(0, 8)) + ': ' + fmtBytes(r.before) + ' → ' + fmtBytes(r.after) +
    '  (' + fmtBytes(saved) + ' saved, ' + r.elided + ' tool-output block(s) elided)' +
    (rest.indexOf('--apply') === -1 ? '  ' + style.dim('[dry run — add --apply to rewrite]') : ''));
  if (rest.indexOf('--apply') === -1) { jsonOut({ compact: { before: r.before, after: r.after, elided: r.elided, applied: false } }); return; }
  // The transcript lives in ~/.claude/projects (outside keyflip's git), so back the
  // original up next to it before rewriting — reversible without git.
  let bak = null;
  try { bak = row.file + '.precompact'; fs.writeFileSync(bak, content); } catch (e) { bak = null; }
  try { fs.writeFileSync(row.file, r.compacted); } catch (e) { return fail('could not rewrite the transcript.'); }
  print(style.ok('✅') + ' rewrote the transcript' + (bak ? ' (original backed up to ' + bak + ')' : '') + '.');
  jsonOut({ compact: { before: r.before, after: r.after, elided: r.elided, applied: true, backup: bak } });
}

// C2: install/remove the nightly `keyflip dream --apply` schedule (launchd on macOS, cron
// on Linux). Command-activated — the user runs it; nothing daemonizes on its own.
async function cmdDreamSchedule(ctx, rest) {
  const schedule = require('./schedule');
  const sub = rest[0];
  if (sub === 'status') {
    const st = schedule.status(ctx);
    if (JSON_MODE) { jsonOut({ dreamSchedule: st }); return; }
    print('Nightly dream: ' + (st.installed ? style.ok('scheduled') + ' (' + st.kind + (st.path ? ', ' + st.path : '') + ')' : style.warn('not scheduled')));
    return;
  }
  if (sub === 'unschedule') {
    const r = schedule.uninstall(ctx);
    if (!r.ok && r.kind === 'unsupported') return fail('scheduling is macOS/Linux-only for now.');
    print(style.ok('✅') + ' nightly dream ' + (r.existed === false ? 'was not scheduled.' : 'unscheduled.'));
    jsonOut({ dreamSchedule: { installed: false } });
    return;
  }
  // schedule
  const ai = rest.indexOf('--at'); const at = ai !== -1 ? rest[ai + 1] : '03:00';
  const oi = rest.indexOf('--older-than'); const days = oi !== -1 ? (parseDays(rest[oi + 1]) || 30) : 30;
  const archiveToo = rest.indexOf('--archive') !== -1;
  print('This installs a ' + (ctx.platform === 'darwin' ? 'launchd agent' : 'crontab entry') + ' that runs ' +
    style.bold('keyflip dream --apply --older-than ' + days + 'd' + (archiveToo ? ' --archive' : '')) + ' daily at ' + at + '.');
  print(style.dim('  It distills old chats into keepsakes (spends the active account\'s quota) unattended. Remove with: keyflip dream unschedule.'));
  if (rest.indexOf('-y') === -1 && rest.indexOf('--force') === -1) {
    if (!process.stdin.isTTY) return fail('re-run with -y to confirm.');
    if (!(await confirm('Install the nightly schedule? [y/N] '))) { print('Cancelled.'); return; }
  }
  const r = schedule.install(ctx, { at: at, days: days, archive: archiveToo });
  if (!r.ok) return fail('could not schedule: ' + (r.reason || r.detail || 'unknown'));
  print(style.ok('✅') + ' scheduled nightly dream at ' + at + ' (' + r.kind + '). ' + style.dim('Status: keyflip dream status'));
  jsonOut({ dreamSchedule: { installed: true, at: at, kind: r.kind } });
}

// C1: "dreaming" — a background pass that consolidates OLD chats: distill each into a
// keepsake (B4) and optionally archive the bulk (B1). DRY-RUN by default (H2); --apply
// executes. Skips sessions already distilled. Uses `claude -p` (spends the active account).
async function cmdDream(ctx, rest) {
  // C2: schedule/unschedule the nightly unattended pass.
  if (rest[0] === 'schedule' || rest[0] === 'unschedule' || rest[0] === 'status') return cmdDreamSchedule(ctx, rest);
  const memory = require('./memory'), llm = require('./llm'), archive = require('./archive');
  const oi = rest.indexOf('--older-than'); const days = oi !== -1 ? (parseDays(rest[oi + 1]) || 30) : 30;
  const li = rest.indexOf('--limit'); const cap = li !== -1 ? (parseInt(rest[li + 1], 10) || 20) : 20;
  const apply = rest.indexOf('--apply') !== -1;
  const doDistill = rest.indexOf('--no-distill') === -1;
  const doArchive = rest.indexOf('--archive') !== -1;
  const cutoff = Date.now() - days * 86400000;
  let targets = sessions.list(ctx, { limit: 100000 }).filter(function (r) { return r.mtimeMs < cutoff && !memory.has(ctx, r.sessionId); });
  if (!targets.length) { print('💤 Nothing to dream about — no un-distilled sessions older than ' + days + ' day(s).'); jsonOut({ dream: { candidates: 0 } }); return; }
  const batch = targets.slice(0, cap);
  print(style.bold('💤 dream') + ' — ' + targets.length + ' session(s) older than ' + days + 'd' + (targets.length > cap ? ' (processing first ' + cap + ')' : '') +
    (apply ? '' : '   ' + style.dim('[dry run — add --apply to execute]')));
  if (apply && doDistill && !llm.available()) return fail('dream needs Claude Code on PATH to distill (`claude -p`).');
  if (!apply) {
    batch.forEach(function (r) { print('  • ' + r.sessionId.slice(0, 8) + '  ' + (r.cwd || '?') + '   → ' + (doDistill ? 'distill' : '') + (doArchive ? (doDistill ? ' + archive' : 'archive') : '')); });
    print('\n' + style.dim('Re-run with --apply to write keepsakes' + (doArchive ? ' and archive the transcripts' : '') + '. (--archive to also stow the bulk.)'));
    jsonOut({ dream: { candidates: targets.length, wouldProcess: batch.length, apply: false } });
    return;
  }
  const INSTR = 'Summarize this past coding-assistant conversation (a JSONL transcript) into a durable "keepsake" memory. Output terse markdown bullets under: Goal, Decisions, Built/Changed, Gotchas/Learnings, Open TODOs. Be specific; skip trivia; no preamble.';
  let distilled = 0, archived = 0, failed = 0;
  for (let i = 0; i < batch.length; i++) {
    const r = batch[i];
    if (doDistill) {
      let transcript; try { transcript = fs.readFileSync(r.file, 'utf8'); } catch (e) { failed++; continue; }
      const res = llm.summarize(INSTR, transcript, { skipCheck: true });
      if (!res.ok) { failed++; print('  ' + style.warn('·') + ' skipped ' + r.sessionId.slice(0, 8) + ' (' + res.reason + ')'); continue; }
      await withLock(ctx, function () { memory.save(ctx, r.sessionId, res.text, { session: r.sessionId, cwd: r.cwd || '', distilledAt: ctx.now() }); });
      distilled++; print('  ' + style.ok('✓') + ' distilled ' + r.sessionId.slice(0, 8));
    }
    if (doArchive) { await withLock(ctx, function () { const a = archive.archiveSession(ctx, r.project, r.sessionId); if (a.ok) archived++; }); }
  }
  print(style.ok('✅') + ' dreamed: ' + distilled + ' keepsake(s)' + (doArchive ? ', ' + archived + ' archived' : '') + (failed ? ', ' + failed + ' skipped' : '') + '.  Browse: ' + style.bold('keyflip memory'));
  jsonOut({ dream: { distilled: distilled, archived: archived, failed: failed, apply: true } });
}

// B4: distill a session into a durable "keepsake" (via `claude -p`) in keyflip's OWN
// memory store. --to-claude also writes it into ~/.claude project memory (opt-in, H1).
async function cmdSessionsDistill(ctx, rest) {
  const memory = require('./memory'), llm = require('./llm');
  const id = positionals(rest, [])[0];
  if (!id) return fail('usage: keyflip sessions distill <id> [--to-claude] [--model <m>]');
  let row; try { row = sessions.find(ctx, id); } catch (e) { return fail(e.message); }
  if (!row) return fail("no session matches '" + id + "'.");
  if (!llm.available()) return fail('distill needs Claude Code on PATH — it summarizes via `claude -p`.');
  let transcript; try { transcript = fs.readFileSync(row.file, 'utf8'); } catch (e) { return fail('cannot read the transcript.'); }
  print('Distilling ' + style.bold(row.sessionId.slice(0, 8)) + ' via ' + style.bold('claude -p') + ' ' + style.dim("(spends the ACTIVE account's quota)") + '…');
  const modelI = rest.indexOf('--model'); const model = modelI !== -1 ? rest[modelI + 1] : null;
  const INSTR = 'Summarize this past coding-assistant conversation (a JSONL transcript) into a durable "keepsake" memory. Output terse markdown bullets under these headings: Goal, Decisions, Built/Changed, Gotchas/Learnings, Open TODOs. Be specific; skip anything trivial; no preamble.';
  const res = llm.summarize(INSTR, transcript, { model: model, skipCheck: true });
  if (!res.ok) return fail('distill failed: ' + (res.reason || 'unknown') + (res.detail ? ' (' + String(res.detail).trim() + ')' : ''));
  let savedPath;
  await withLock(ctx, function () {
    savedPath = memory.save(ctx, row.sessionId, res.text, { session: row.sessionId, cwd: row.cwd || '', distilledAt: ctx.now() });
  });
  print(style.ok('✅') + ' saved keepsake → ' + savedPath);
  if (rest.indexOf('--to-claude') !== -1) {
    try {
      const dest = path.join(sessions.projectsDir(ctx), row.project, 'memory');
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'keyflip-' + row.sessionId + '.md'), res.text + '\n');
      print('  ↳ also written into ~/.claude project memory (--to-claude).');
    } catch (e) { print('  ' + style.warn('·') + ' could not write to ~/.claude memory: ' + e.message); }
  }
  jsonOut({ distilled: { session: row.sessionId, memory: savedPath } });
}

// G3: a status line for Claude Code — shows the active account (+ provider, + cached quota)
// right in the prompt. `keyflip statusline` (no args) EMITS the line (Claude calls it, so it
// must be fast + never throw + read no network). install/uninstall wire it into settings.json.
function statuslineCommand() {
  const w = exec.run('which', ['keyflip']);
  if (w && w.code === 0 && String(w.stdout).trim()) return 'keyflip statusline';
  return process.execPath + ' ' + path.join(__dirname, '..', 'bin', 'keyflip.js') + ' statusline';
}
function statuslineInstall(ctx, on) {
  const settingsmod = require('./settings'); const { writeJsonStable } = require('./fsutil');
  const file = ctx.claudeSettingsPath;
  let cur; try { cur = settingsmod.read(file); } catch (e) { return fail('~/.claude/settings.json is corrupt — fix it first.'); }
  if (on) {
    const cmd = statuslineCommand();
    cur.statusLine = { type: 'command', command: cmd, padding: 0 };
    try { writeJsonStable(file, cur, 0o600); } catch (e) { return fail('could not write settings.json: ' + e.message); }
    print(style.ok('✅') + ' installed the keyflip status line (' + style.dim(cmd) + '). It shows the active account + quota; restart Claude Code to see it.');
    jsonOut({ statusline: 'installed' });
  } else {
    if (cur.statusLine && /statusline/.test(String((cur.statusLine && cur.statusLine.command) || ''))) {
      delete cur.statusLine; try { writeJsonStable(file, cur, 0o600); } catch (e) { /* ignore */ }
      print(style.ok('✅') + ' removed the keyflip status line.');
    } else { print('The keyflip status line is not installed.'); }
    jsonOut({ statusline: 'uninstalled' });
  }
}
function cmdStatusline(ctx, rest) {
  if (rest[0] === 'install') return statuslineInstall(ctx, true);
  if (rest[0] === 'uninstall' || rest[0] === 'remove') return statuslineInstall(ctx, false);
  // EMIT the line (called by Claude Code). Fast, cache-only, never throws.
  let line = '⚡ keyflip';
  try {
    const email = core.currentEmail(ctx) || 'not logged in';
    let prov = null; try { const a = provider.readActive(ctx); prov = a && a.name; } catch (e) { prov = null; }
    let quota = '';
    try {
      const cache = JSON.parse(fs.readFileSync(path.join(ctx.configDir, '.usage-cache.json'), 'utf8'));
      let name = null; profiles.list(ctx.configDir).forEach(function (n) { if (!name && profiles.email(ctx.configDir, n) === email) name = n; });
      const u = name && cache && cache[name] && cache[name].usage;
      if (u) {
        const hs = [];
        if (u.fiveHour && typeof u.fiveHour.pct === 'number') hs.push(100 - u.fiveHour.pct);
        if (u.sevenDay && typeof u.sevenDay.pct === 'number') hs.push(100 - u.sevenDay.pct);
        if (hs.length) quota = ' · ' + Math.max(0, Math.round(Math.min.apply(null, hs))) + '% left';
      }
    } catch (e) { /* no cache — omit quota */ }
    line = '⚡ ' + email + (prov ? ' → ' + prov : '') + quota;
  } catch (e) { /* keep the fallback */ }
  process.stdout.write(line);
}

// J3: `keyflip settings [show | get <key> | set <key> <value> | unset <key>]` — view/edit
// ~/.claude/settings.json (the file Claude Code hot-reloads). Dot-paths for nested keys.
function cmdSettings(ctx, rest) {
  const settings = require('./settings');
  const { writeJsonStable } = require('./fsutil');
  const file = ctx.claudeSettingsPath;
  let cur; try { cur = settings.read(file); } catch (e) { return fail('~/.claude/settings.json is corrupt — fix it first (' + e.message + ').'); }
  const sub = rest[0];
  if (sub === 'get') {
    if (!rest[1]) return fail('usage: keyflip settings get <key>');
    const v = settings.getPath(cur, rest[1]);
    if (JSON_MODE) { jsonOut({ key: rest[1], value: v === undefined ? null : v }); return; }
    print(v === undefined ? '(not set)' : (typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)));
    return;
  }
  if (sub === 'set' || sub === 'unset') {
    if (!rest[1]) return fail('usage: keyflip settings ' + sub + ' <key>' + (sub === 'set' ? ' <value>' : ''));
    if (sub === 'set') {
      const raw = rest.slice(2).join(' ');
      if (raw === '') return fail('usage: keyflip settings set <key> <value>');
      let val; try { val = JSON.parse(raw); } catch (e) { val = raw; } // JSON literal if valid, else a string
      settings.setPath(cur, rest[1], val);
    } else { settings.setPath(cur, rest[1], undefined); }
    try { writeJsonStable(file, cur, 0o600); } catch (e) { return fail('could not write settings.json: ' + e.message); }
    print(style.ok('✅') + ' ' + (sub === 'set' ? 'set' : 'unset') + ' ' + style.bold(rest[1]) + ' in ~/.claude/settings.json (Claude hot-reloads it; no restart).');
    jsonOut({ settings: sub, key: rest[1] });
    return;
  }
  if (JSON_MODE) { jsonOut({ settings: cur }); return; }
  print('~/.claude/settings.json:');
  print(JSON.stringify(cur, null, 2));
  print('\nChange one: ' + style.bold('keyflip settings set <key> <value>') + '   (e.g. ' + style.bold('keyflip settings set model opus') + ', dot-paths for nesting). Carried across machines by `keyflip migrate`.');
}

// I1: `keyflip recall "<query>"` — local BM25 semantic-ish recall over the distilled
// keepsakes (zero-dep, offline, private). Answers "where did I discuss X" across all chats.
async function cmdRecall(ctx, rest) {
  const recall = require('./recall');
  const li = rest.indexOf('--limit'); const limit = li !== -1 ? (parseInt(rest[li + 1], 10) || 10) : 10;
  const query = positionals(rest, []).join(' ');
  if (!query) return fail('usage: keyflip recall "<query>" [--semantic] [--answer]   (searches your distilled keepsakes; make some with: keyflip dream --apply)');

  // I2: --semantic uses an embedding endpoint (Ollama/hosted) for true vector search; falls
  // back to lexical (BM25) if no endpoint is reachable.
  if (rest.indexOf('--semantic') !== -1) {
    const sem = await recall.semanticSearch(ctx, query, { limit: limit });
    if (sem.ok) {
      if (!sem.hits.length) return print('No keepsakes matched "' + query + '" semantically.');
      print('Semantic recall for "' + style.bold(query) + '" — ' + sem.hits.length + ' keepsake(s):');
      sem.hits.forEach(function (h, i) { print('  [' + (i + 1) + '] ' + h.session.slice(0, 8) + (h.cwd ? '  ' + style.dim(h.cwd) : '') + '   ' + style.dim('(' + (Math.round(h.score * 100) / 100) + ')')); print('      ' + style.dim('↳ ' + h.snippet)); });
      if (JSON_MODE) jsonOut({ recall: sem.hits.map(function (h) { return { key: h.key, session: h.session, cwd: h.cwd, score: Math.round(h.score * 1000) / 1000, snippet: h.snippet }; }) });
      return;
    }
    if (sem.reason === 'no-keepsakes') return print('No keepsakes yet — distill some chats first: keyflip dream --apply.');
    print(style.warn('·') + ' semantic search unavailable (' + sem.reason + ') — falling back to local lexical search.');
  }

  // I3: --answer synthesizes a cited answer over the retrieved keepsakes via `claude -p`.
  if (rest.indexOf('--answer') !== -1) {
    const llm = require('./llm');
    if (!llm.available()) { print(style.warn('·') + ' --answer needs Claude Code on PATH (`claude -p`); showing the ranked keepsakes instead.'); }
    else {
      print('Researching "' + style.bold(query) + '" across your keepsakes via ' + style.bold('claude -p') + ' ' + style.dim('(spends the active account)') + '…');
      const a = recall.answer(ctx, query, { limit: limit, skipCheck: true });
      if (!a.ok) return fail(a.reason === 'no-matches' ? 'no keepsakes matched "' + query + '".' : 'recall --answer failed: ' + (a.reason || 'unknown'));
      print('\n' + a.text + '\n');
      print(style.dim('Sources: ' + a.hits.map(function (h) { return h.session.slice(0, 8); }).join(', ')));
      jsonOut({ answer: a.text, sources: a.hits.map(function (h) { return h.session; }) });
      return;
    }
  }

  const hits = recall.search(ctx, query, { limit: limit });
  if (JSON_MODE) { jsonOut({ recall: hits.map(function (h) { return { key: h.key, session: h.session, cwd: h.cwd, score: Math.round(h.score * 1000) / 1000, snippet: h.snippet }; }) }); return; }
  if (!hits.length) {
    const n = recall.corpus(ctx).length;
    return print(n ? 'No keepsakes matched "' + query + '".' : 'No keepsakes yet to recall from — distill some chats first: keyflip dream --apply (or keyflip sessions distill <id>).');
  }
  print('Recall for "' + style.bold(query) + '" — ' + hits.length + ' keepsake(s):');
  hits.forEach(function (h, i) {
    print('  [' + (i + 1) + '] ' + h.session.slice(0, 8) + (h.cwd ? '  ' + style.dim(h.cwd) : '') + '   ' + style.dim('(' + (Math.round(h.score * 100) / 100) + ')'));
    print('      ' + style.dim('↳ ' + h.snippet));
  });
  print('\nRead a keepsake: ' + style.bold('keyflip memory show <key>') + '   ·   resume its chat: ' + style.bold('keyflip resume <session> --run'));
}

// `keyflip memory [list | show <key> | remove <key>]` — browse keyflip's distilled keepsakes.
function cmdMemory(ctx, rest) {
  const memory = require('./memory');
  const sub = rest[0];
  if (sub === 'show' || sub === 'get' || sub === 'cat') {
    const txt = memory.read(ctx, rest[1] || '');
    if (txt == null) return fail("no keepsake '" + (rest[1] || '') + "' (see: keyflip memory).");
    process.stdout.write(txt.slice(-1) === '\n' ? txt : txt + '\n');
    return;
  }
  if (sub === 'remove' || sub === 'rm') {
    if (!rest[1]) return fail('usage: keyflip memory remove <key>');
    memory.remove(ctx, rest[1]);
    print(style.ok('✅') + ' removed keepsake ' + rest[1] + '.');
    return;
  }
  const rows = memory.list(ctx);
  if (JSON_MODE) { jsonOut({ memory: rows.map(function (r) { return { key: r.key, bytes: r.bytes, mtime: r.mtime }; }) }); return; }
  if (!rows.length) { print('No keepsakes yet. Distill a session into one: keyflip sessions distill <id>'); return; }
  rows.forEach(function (r, i) { print('  [' + (i + 1) + '] ' + r.key.slice(0, 8) + '  ' + String(r.mtime || '').slice(0, 16).replace('T', ' ') + '  ' + fmtBytes(r.bytes)); });
  print('\nRead one: keyflip memory show <key>');
}

async function cmdSessionsRebind(ctx, rest) {
  const pos = positionals(rest, []);
  const oldCwd = pos[0], newCwd = pos[1];
  if (!oldCwd || !newCwd) return fail("usage: keyflip sessions rebind <old-path> <new-path> [--purge-old] [--force]\n  (re-links a project's chat history after you renamed/moved its folder)");
  const oldAbs = path.resolve(oldCwd), newAbs = path.resolve(newCwd);
  const force = rest.indexOf('--force') !== -1 || rest.indexOf('-y') !== -1;
  const purgeOld = rest.indexOf('--purge-old') !== -1;

  const oldDir = path.join(sessions.projectsDir(ctx), sessions.encodeCwd(oldAbs));
  if (!fs.existsSync(oldDir)) return fail("no chat history found for '" + oldAbs + "' (looked in " + oldDir + ").");
  const count = (function () { try { return fs.readdirSync(oldDir).filter(function (f) { return f.slice(-6) === '.jsonl'; }).length; } catch (e) { return 0; } })();
  print('Re-link ' + style.bold(String(count)) + ' session(s): ' + style.bold(oldAbs) + ' → ' + style.bold(newAbs) + '.');
  print(style.dim('  Copies transcripts to the new folder key and rewrites the old path inside them (old copies backed up).'));
  if (appctl.isClaudeRunning(ctx.platform)) print('  ' + style.warn('⚠') + ' Claude is running — quit it first so it can\'t overwrite the fix (a restart is needed to see the change anyway).');
  if (!force) {
    if (!process.stdin.isTTY) return fail('re-run with --force to confirm.');
    const ok = await confirm('Proceed? [y/N] ');
    if (!ok) { print('Cancelled.'); return; }
  }
  const r = sessions.rebind(ctx, oldAbs, newAbs, { purgeOld: purgeOld, force: force });
  if (!r.ok) return fail('rebind did not run: ' + (r.reason || 'unknown'));
  print(style.ok('✅') + ' moved ' + r.moved + ' transcript(s)' + (r.skipped ? ', skipped ' + r.skipped + ' (already there — use --force)' : '') + ' → ' + r.newDir);
  if (r.backup) print('  ↳ backup: ' + r.backup);
  if (ctx.appDataDir && !appctl.isClaudeRunning(ctx.platform)) {
    const reg = sessions.rebindAppRegistry(ctx, oldAbs, newAbs);
    if (reg.patched) print('  ↳ patched ' + reg.patched + ' desktop-app session record(s).');
  }
  print('  ' + style.dim('Restart Claude to see the history under the new folder' + (purgeOld ? ' (old copies disabled).' : '; old copies remain at the old key).')));
  jsonOut({ rebind: { moved: r.moved, skipped: r.skipped, oldDir: r.oldDir, newDir: r.newDir } });
}

async function cmdSessions(ctx, rest) {
  if (rest[0] === 'rebind') return cmdSessionsRebind(ctx, rest.slice(1));
  if (rest[0] === 'archive') return cmdSessionsArchive(ctx, rest.slice(1));
  if (rest[0] === 'unarchive') return cmdSessionsUnarchive(ctx, rest.slice(1));
  if (rest[0] === 'archived') return cmdSessionsArchived(ctx, rest.slice(1));
  if (rest[0] === 'distill') return cmdSessionsDistill(ctx, rest.slice(1));
  if (rest[0] === 'compact') return cmdSessionsCompact(ctx, rest.slice(1));
  if (rest[0] === 'assign') return withLock(ctx, function () { return cmdSessionsAssign(ctx, rest.slice(1)); });
  if (rest[0] === 'unassign') return withLock(ctx, function () { return cmdSessionsUnassign(ctx, rest.slice(1)); });
  const opts = {
    search: flagVal(rest, '--search'),
    cwd: rest.indexOf('--cwd') !== -1 ? (flagVal(rest, '--cwd') === undefined ? '.' : flagVal(rest, '--cwd')) : null,
    limit: parseInt(flagVal(rest, '--limit'), 10) || 40,
  };
  if (rest.indexOf('--here') !== -1) opts.cwd = '.';
  const rows = sessions.list(ctx, opts);
  if (JSON_MODE) { jsonOut({ sessions: rows.map(function (r) { return { sessionId: r.sessionId, cwd: r.cwd, mtime: r.mtime, sizeBytes: r.sizeBytes, preview: r.preview, match: r.match || null, orphan: !!r.orphan }; }) }); return; }
  if (!rows.length) { print('No sessions found' + (opts.search ? ' matching "' + opts.search + '"' : '') + '.'); return; }
  let orphans = 0;
  rows.forEach(function (r, i) {
    if (r.orphan) orphans++;
    print('  [' + (i + 1) + '] ' + r.sessionId.slice(0, 8) + '  ' + r.mtime.slice(0, 16).replace('T', ' ') + '  ' + (r.cwd || '?') + (r.orphan ? '  ' + style.warn('⚠ folder missing') : ''));
    // On a search, show WHERE it matched (a content snippet); otherwise the first message.
    if (opts.search && r.match && r.match !== r.preview) print('        ' + style.dim('↳ ' + r.match));
    else if (r.preview) print('        ' + style.dim('“' + r.preview + '”'));
  });
  print('');
  if (orphans) print(style.warn('⚠') + ' ' + orphans + ' session(s) point at a folder that no longer exists — re-link with: ' + style.bold('keyflip sessions rebind <old-path> <new-path>'));
  print('Resume one with:  keyflip resume <number|id>   (add --run to launch it)');
}

// E4: inject a message into a session non-interactively and print the reply —
// `claude -p "<message>" --resume <id>` in its project dir. Optionally AS another account
// (--as, or an assignment) and/or --fork (branch instead of appending). This is how you
// steer/continue a chat from another machine (keyflip carries the session; send drives it).
async function cmdSend(ctx, rest) {
  const sessionmap = require('./sessionmap');
  // Exclude the values of value-taking flags (--as/--message/-m) from positionals, else
  // e.g. `send <id> "hi" --as bob` would fold "bob" into the message body sent to Claude.
  const pos = positionals(rest, ['--as', '--message', '-m']);
  const id = pos[0];
  const mi = rest.indexOf('--message'); const mm = rest.indexOf('-m');
  const message = mi !== -1 ? rest[mi + 1] : (mm !== -1 ? rest[mm + 1] : pos.slice(1).join(' '));
  if (!id || !message) return fail('usage: keyflip send <id> "<message>" [--as <account>] [--fork]');
  let row; try { row = sessions.find(ctx, id); } catch (e) { return fail(e.message); }
  if (!row) return fail("no session matches '" + id + "'.");
  if (!require('./llm').available()) return fail('send needs Claude Code on PATH (`claude -p --resume`).');
  const sc = sessions.sendCommand(row, message, { fork: rest.indexOf('--fork') !== -1 });
  const cwd = (row.cwd && fs.existsSync(row.cwd)) ? row.cwd : process.cwd();

  // Which account to send as: explicit --as, else the session's assignment (A2), else current.
  const asI = rest.indexOf('--as');
  const asName = asI !== -1 ? rest[asI + 1] : sessionmap.get(ctx, row.sessionId);
  let env = process.env, em = null, resolved = null;
  if (asName) {
    resolved = core.resolveProfile(ctx, asName);
    if (!resolved) return fail("no such account: '" + asName + "'");
    em = profiles.email(ctx.configDir, resolved) || resolved;
    const session = require('./session');
    let dir; await withLock(ctx, function () { dir = session.prepareSession(ctx, resolved, { share: true, shareHistory: true }); });
    env = session.sessionEnv(ctx, dir).env;
  }
  if (JSON_MODE) { jsonOut({ send: { session: row.sessionId, as: resolved || null, cwd: cwd, command: sc.command + ' ' + sc.args.join(' ') } }); return; }
  print('Sending to ' + style.bold(row.sessionId.slice(0, 8)) + (em ? ' as ' + em : '') + (rest.indexOf('--fork') !== -1 ? ' ' + style.dim('(forked)') : '') + ' via ' + style.bold('claude -p') + ' ' + style.dim('(spends quota)') + '…\n');
  const bin = process.env.KEYFLIP_CLAUDE_BIN || 'claude';
  const r = require('child_process').spawnSync(bin, sc.args, { stdio: 'inherit', cwd: cwd, env: env });
  if (resolved) await withLock(ctx, function () { try { require('./session').syncBack(ctx, resolved); } catch (e) { /* best-effort */ } });
  process.exitCode = typeof r.status === 'number' ? r.status : 1;
}

async function cmdResume(ctx, rest) {
  const sessionmap = require('./sessionmap');
  // positionals() knows --as takes a value, so `resume --as bob 5` resolves to `5`, not `bob`.
  const arg = positionals(rest, ['--as'])[0];
  if (!arg) return fail('usage: keyflip resume <number|session-id> [--run] [--as <account>]');
  let row;
  if (/^[0-9]{1,3}$/.test(arg)) { row = sessions.list(ctx, { limit: 200 })[parseInt(arg, 10) - 1]; }
  else { try { row = sessions.find(ctx, arg); } catch (e) { return fail(e.message); } }
  if (!row) return fail('no such session: ' + arg);
  const rc = sessions.resumeCommand(row);
  const wantRun = rest.indexOf('--run') !== -1;

  // A2: resume AS a specific account (explicit --as, or a saved assignment when --run) —
  // isolated via CLAUDE_CONFIG_DIR so the machine's ACTIVE profile is NOT changed.
  const asI = rest.indexOf('--as');
  const explicitAs = asI !== -1 ? rest[asI + 1] : null;
  const assigned = sessionmap.get(ctx, row.sessionId);
  const asName = explicitAs || (wantRun ? assigned : null);
  if (asName) {
    const name = core.resolveProfile(ctx, asName);
    if (!name) return fail("no such account: '" + asName + "'");
    const em = profiles.email(ctx.configDir, name) || name;
    const cwd = (rc.cwd && fs.existsSync(rc.cwd)) ? rc.cwd : process.cwd();
    if (JSON_MODE) { jsonOut({ sessionId: row.sessionId, as: name, cwd: cwd, command: rc.command + ' ' + rc.args.join(' ') }); return; }
    const autoYes = rest.indexOf('-y') !== -1 || rest.indexOf('--yes') !== -1 || rest.indexOf('--force') !== -1;
    if (!autoYes) {
      if (!process.stdin.isTTY) return fail('resuming as ' + em + ' launches a PARALLEL session — re-run with -y.');
      print('Resume ' + row.sessionId.slice(0, 8) + ' as ' + style.bold(em) + ' — parallel (this terminal only); your active account stays unchanged.');
      if (!(await confirm('Continue? [y/N] '))) { print('Cancelled.'); return; }
    }
    const session = require('./session');
    let dir; await withLock(ctx, function () { dir = session.prepareSession(ctx, name, { share: true, shareHistory: true }); });
    const se = session.sessionEnv(ctx, dir);
    print('Resuming as ' + em + ' (this terminal only)…');
    const bin = process.env.KEYFLIP_CLAUDE_BIN || 'claude';
    const r = require('child_process').spawnSync(bin, rc.args, { stdio: 'inherit', cwd: cwd, env: se.env });
    await withLock(ctx, function () { try { session.syncBack(ctx, name); } catch (e) { /* best-effort */ } });
    process.exitCode = typeof r.status === 'number' ? r.status : 1;
    return;
  }

  if (JSON_MODE) { jsonOut({ sessionId: row.sessionId, cwd: rc.cwd, command: rc.command + ' ' + rc.args.join(' '), assignedTo: assigned || null }); return; }
  if (wantRun) {
    if (rc.cwd && !fs.existsSync(rc.cwd)) print(style.warn('⚠️  original directory is gone: ' + rc.cwd + ' — launching in the current directory.'));
    const cwd = (rc.cwd && fs.existsSync(rc.cwd)) ? rc.cwd : process.cwd();
    const bin = process.env.KEYFLIP_CLAUDE_BIN || 'claude';
    const r = require('child_process').spawnSync(bin, rc.args, { stdio: 'inherit', cwd: cwd });
    process.exitCode = typeof r.status === 'number' ? r.status : 1;
    return;
  }
  print('Resume this session with:');
  print('  cd ' + (rc.cwd || '<dir>') + ' && ' + rc.command + ' ' + rc.args.join(' '));
  if (assigned) print('  ↳ assigned to ' + (profiles.email(ctx.configDir, assigned) || assigned) + ' — ' + style.bold('keyflip resume ' + row.sessionId.slice(0, 8) + ' --run') + ' launches it as that account (no profile switch).');
  else print('(or re-run with --run to launch it now; --as <account> to run it under another account)');
}

// #6 backup
function cmdBackup(ctx, rest) {
  const sub = rest[0] || 'now';
  if (sub === 'now' || sub === 'create') {
    const r = backup.create(ctx);
    print(style.ok('✅') + ' backup ' + r.name + '  (' + r.files + ' files, ' + Math.round(r.sizeBytes / 1024) + ' KB)');
    jsonOut({ created: r.name, files: r.files });
    return;
  }
  if (sub === 'list') {
    const all = backup.list(ctx);
    if (JSON_MODE) { jsonOut({ backups: all }); return; }
    if (!all.length) { print('No backups yet — make one: keyflip backup now'); return; }
    all.forEach(function (b, i) { print('  [' + (i + 1) + '] ' + b.name + '   ' + Math.round(b.sizeBytes / 1024) + ' KB   ' + (b.mtime || '')); });
    return;
  }
  if (sub === 'restore') {
    if (!rest[1]) return fail('usage: keyflip backup restore <number|name>');
    const r = backup.restore(ctx, rest[1]);
    print(style.ok('✅') + ' restored ' + r.name + ' (' + r.files + ' files). A pre-restore safety backup was taken.');
    jsonOut({ restored: r.name });
    return;
  }
  if (sub === 'prune') {
    const keep = rest[1] ? (parseInt(rest[1], 10) || backup.DEFAULT_KEEP) : backup.DEFAULT_KEEP;
    const removed = backup.prune(ctx, keep);
    print('pruned ' + removed + ' old backup(s), kept ' + keep + '.');
    return;
  }
  return fail('usage: keyflip backup [now|list|restore <n>|prune [keep]]');
}

// #11 keyflip:// share URL
function cmdShare(ctx, rest) {
  const resource = provider.exists(ctx, rest[0]) ? 'provider' : (profiles.read(ctx.configDir, rest[0]) ? 'account' : null);
  const name = rest[0];
  if (!name || !resource) return fail("usage: keyflip share <provider-or-account> [--no-secrets]");
  const url = share.build(ctx, resource, name, { noSecrets: rest.indexOf('--no-secrets') !== -1 });
  if (JSON_MODE) { jsonOut({ url: url, resource: resource }); return; }
  if (resource === 'provider' && rest.indexOf('--no-secrets') === -1) {
    print(style.warn('⚠️  This link may carry the API key — treat it as a secret.'));
  }
  print(url);
}

// #13 diagnostics
async function cmdDoctor(ctx, rest) {
  const r = await doctor.diagnose(ctx);
  if (JSON_MODE) { jsonOut({ ok: r.ok, checks: r.checks }); return; }
  print('keyflip doctor:');
  r.checks.forEach(function (c) {
    print('  ' + (c.ok === false ? style.err('✗') : (c.ok === true ? style.ok('✓') : '•')) + ' ' + c.name + (c.detail ? '  — ' + c.detail : ''));
  });
  print('');
  print(r.ok ? style.ok('All good.') : style.warn('Some checks need attention (see ✗ above).'));
}

async function cmdTest(ctx, rest) {
  const name = rest.filter(function (a) { return a.indexOf('-') !== 0; })[0];
  if (!name) return fail('usage: keyflip test <provider>   (fires one minimal real request to check auth + reachability)');
  if (!provider.exists(ctx, name)) return fail("no such provider: '" + name + "'");
  const r = await doctor.testProvider(ctx, name);
  if (JSON_MODE) { jsonOut({ provider: name, result: r }); return; }
  if (r.ok) print(style.ok('✓') + ' ' + name + ': ok (' + r.ms + 'ms, http ' + r.httpStatus + ')');
  else print(style.err('✗') + ' ' + name + ': ' + r.category + (r.httpStatus ? ' (http ' + r.httpStatus + ')' : '') + (r.reason ? ' — ' + r.reason : ''));
}

// Parallel session: run Claude Code as <name> in THIS terminal only.
async function cmdRun(ctx, rest) {
  const sep = rest.indexOf('--');
  const fwd = sep === -1 ? [] : rest.slice(sep + 1);
  const own = sep === -1 ? rest : rest.slice(0, sep);
  const noShare = own.indexOf('--no-share') !== -1;
  const autoYes = own.indexOf('-y') !== -1 || own.indexOf('--yes') !== -1 || own.indexOf('--force') !== -1;
  const shareHistory = own.indexOf('--share-history') !== -1;
  let arg = own.filter(function (a) { return a.indexOf('-') !== 0; })[0];
  if (!arg) {
    const hit = links.lookup(ctx, process.cwd());
    if (hit) { arg = hit.name; print('Using linked account for this directory: ' + hit.name); }
    else return fail('usage: keyflip run <name|number> [--no-share] [--share-history] [-y] [-- <claude args>]\n(or link this directory once:  keyflip link <name>)');
  }
  const name = core.resolveProfile(ctx, arg);
  if (!name) return fail("no such account: '" + arg + "'");
  const em = profiles.email(ctx.configDir, name) || name;

  // Risky: an in-session token refresh rotates this account's refresh token,
  // which can log out OTHER live copies of the same account. Ask first.
  if (!autoYes) {
    if (!process.stdin.isTTY) {
      return fail('run launches a PARALLEL session for ' + em + ' — re-run with -y to confirm.');
    }
    print('Parallel session: ' + em + ' will run ONLY in this terminal — every other');
    print('terminal, the desktop app and VS Code keep their current account.');
    print(style.warn('⚠️  If Claude refreshes the token in-session, OTHER live copies of this'));
    print(style.warn('   same account may get logged out.'));
    const ok = await confirm('Continue? [y/N] ');
    if (!ok) { print('Cancelled.'); return; }
  }

  let dir;
  await withLock(ctx, function () { dir = session.prepareSession(ctx, name, { share: !noShare, shareHistory: shareHistory }); });
  const se = session.sessionEnv(ctx, dir);
  se.scrubbed.forEach(function (k) { print('  ⚠️ ignoring ' + k + ' for this session (it would override the account).'); });
  print('Launching Claude Code as ' + em + ' (this terminal only)…');
  logmod.log('run session: ' + name);
  const bin = process.env.KEYFLIP_CLAUDE_BIN || 'claude';
  const r = require('child_process').spawnSync(bin, fwd, { stdio: 'inherit', env: se.env });
  await withLock(ctx, function () {
    if (session.syncBack(ctx, name)) print('  ↳ session token rotated — saved back to the profile.');
  });
  if (r.error) return fail('could not launch ' + bin + ': ' + r.error.message);
  process.exitCode = typeof r.status === 'number' ? r.status : 1;
}

// Headless account import from a RAW credentials blob (file or stdin).
async function cmdAddToken(ctx, rest) {
  const force = rest.indexOf('--force') !== -1 || rest.indexOf('-y') !== -1;
  const ti = rest.indexOf('--token');
  const srcArg = ti !== -1 && rest[ti + 1] && rest[ti + 1].indexOf('--') !== 0 ? rest[ti + 1] : null;
  const ei = rest.indexOf('--email');
  const email = ei !== -1 ? rest[ei + 1] : null;
  // The profile name is the first positional — excluding BOTH the --token value
  // and the --email value (so `--email a@b.c` can't be misparsed as the name).
  // Guard the -1 case: a missing flag must NOT exclude index 0 (the name).
  const tokValIdx = ti !== -1 ? ti + 1 : -1;
  const emailValIdx = ei !== -1 ? ei + 1 : -1;
  const name = rest.filter(function (a, i) {
    return a.indexOf('-') !== 0 && i !== tokValIdx && i !== emailValIdx;
  })[0];
  if (!name || !profiles.isValidName(name) || !srcArg) {
    return fail('usage: keyflip add <name> --token <file|-> [--email a@b.c] [--force]\n(the raw credentials JSON is read from a file or stdin — NEVER pass it as an argument)');
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return fail("'" + email + "' is not a valid email address");
  }
  let raw;
  try { raw = srcArg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(srcArg, 'utf8'); }
  catch (e) { return fail('could not read the credential: ' + e.message); }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return fail('that is not valid credentials JSON'); }
  if (!parsed || !parsed.claudeAiOauth || typeof parsed.claudeAiOauth.accessToken !== 'string' ||
      !parsed.claudeAiOauth.accessToken.trim()) {
    return fail('credentials JSON must contain a non-empty claudeAiOauth.accessToken');
  }
  if (profiles.exists(ctx.configDir, name) && !force) {
    return fail("'" + name + "' already exists — pass --force to overwrite its credentials.");
  }
  // Risky import: confirm on a TTY; piped stdin cannot prompt, so require --force.
  if (!force) {
    if (!process.stdin.isTTY) {
      return fail('importing a raw credential non-interactively requires --force (make sure you trust its source).');
    }
    print(style.warn('⚠️  You are importing a RAW login credential for \'' + name + '\'.'));
    print('   Only do this with a credential you exported yourself or fully trust —');
    print('   whoever holds this token has full access to the account.');
    const ok = await confirm('Import it? [y/N] ');
    if (!ok) { print('Cancelled — nothing was imported.'); return; }
  }
  ctx.store.setProfile(name, raw.trim());
  profiles.write(ctx.configDir, {
    name: name,
    email: email || '',
    oauthAccount: email ? { emailAddress: email } : {},
    userID: '',
    savedAt: ctx.now(),
    tokenImport: true,
  });
  logmod.log('token import: ' + name);
  print(style.ok('✅') + " imported '" + name + "'" + (email ? ' (' + email + ')' : '') + '.');
}

// Self-upgrade: re-run whichever installer put this copy here (platform-aware).
async function cmdUpgrade(ctx) {
  if (JSON_MODE) return fail('upgrade is interactive and streams installer output — do not run it with --json');
  const method = update.detectInstallMethod(process.argv[1] || '');
  const spawn = update.upgradeSpawn(method);
  if (!spawn) {
    return fail("couldn't detect how keyflip was installed — upgrade manually with either:\n  " +
      update.upgradeCommand('installer') + '\n  ' + update.upgradeCommand('npm'));
  }
  print('Upgrading (' + method + '):  ' + update.upgradeCommand(method));
  const r = require('child_process').spawnSync(spawn.cmd, spawn.args, { stdio: 'inherit' });
  if (r.error) return fail('could not run the upgrade (' + spawn.cmd + ' not found?): ' + r.error.message +
    '\nRun manually:  ' + update.upgradeCommand(method));
  if (r.status !== 0) return fail('upgrade failed (exit ' + r.status + ') — run manually:  ' + update.upgradeCommand(method));
  print(style.ok('✅') + ' Upgraded — run keyflip version to confirm.');
}

// One-line answer to "which account am I on?" (both surfaces).
function cmdStatus(ctx) {
  const cliEmail = core.currentEmail(ctx) || null;
  // One detection pass (may prompt the Keychain once) → match a saved profile by org,
  // and keep the raw detection so an UNSAVED account still shows an email/org, not "unknown".
  let appName = null, appEmail = null, appLabel = null, appDet = null;
  if (ctx.appDataDir) {
    appDet = appauth.detectAppAccount(ctx);
    if (appDet && appDet.org) {
      profiles.list(ctx.configDir).forEach(function (n) {
        if (appName) return;
        const m = profiles.read(ctx.configDir, n);
        if (m && m.oauthAccount && m.oauthAccount.organizationUuid === appDet.org) appName = n;
      });
    }
    appEmail = appName ? (profiles.email(ctx.configDir, appName) || null) : null;
    appLabel = appEmail || appName || (appDet && appDet.email) ||
      (appDet && appDet.org ? appDet.org.slice(0, 8) + '… (unsaved)' : null);
  }
  const activeProvider = provider.readActive(ctx);
  jsonOut({
    cli: cliEmail ? { email: cliEmail } : null,
    app: appName ? { name: appName, email: appEmail } : (appLabel ? { name: null, email: (appDet && appDet.email) || null, org: (appDet && appDet.org) || null, saved: false } : null),
    provider: activeProvider ? activeProvider.name : null,
  });
  if (!JSON_MODE) {
    print('Claude Code: ' + (cliEmail || 'not logged in') +
      (ctx.appDataDir ? '   ·   Desktop app: ' + (appLabel || 'unknown') +
        (!appLabel && appDet && appDetectHint(appDet.reason) ? '  (' + appDetectHint(appDet.reason) + ')' : '') : ''));
    if (activeProvider) print('Endpoint: provider "' + activeProvider.name + '" (overrides the account for API calls)');
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
// A human hint for WHY the desktop account couldn't be auto-identified.
function appDetectHint(reason) {
  if (reason === 'keychain-locked') return 'Unlock your login keychain (it holds the app key), then retry.';
  if (reason === 'no-token-cache' || reason === 'decrypt-failed' || reason === 'unresolved-org') return 'Open the Claude desktop app and confirm it is signed in, then retry.';
  if (reason === 'no-desktop-config') return 'The Claude desktop app is not set up on this machine.';
  return null;
}

// Returns { ok, name?, email?, needName?, reason? } — printing is the caller's job.
function captureApp(ctx, nameArg) {
  if (!ctx.appDataDir) return { ok: false, reason: 'macos-only' };
  let name = nameArg || null;
  if (name && !profiles.isValidName(name)) return { ok: false, reason: "invalid profile name: '" + name + "'" };

  const det = appauth.detectAppAccount(ctx) || {};
  const email = det.email || null;

  if (!name) {
    // Auto-identify ONLY from a CONFIRMED decrypt (det.reason == null). On any fallback
    // the org/email are guesses from possibly-stale config — auto-pairing them to a
    // profile could snapshot the LIVE account's tokens into the WRONG profile, so we
    // require an explicit name instead.
    if (!det.reason) {
      profiles.list(ctx.configDir).forEach(function (n) {
        if (name) return;
        const m = profiles.read(ctx.configDir, n);
        if (!m) return;
        if ((email && m.email === email) ||
            (det.org && m.oauthAccount && m.oauthAccount.organizationUuid === det.org)) name = n;
      });
      if (!name && email) name = core.autoName(ctx, email);
    }
    if (!name) return { ok: false, needName: true, reason: det.reason || null };
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
  print('   to it will NOT work. Quit Claude fully, reopen it, and run:  keyflip add');
}

// Unified `add`: capture EVERYTHING that's currently logged in — the Claude Code
// (CLI) account and/or the desktop app's account — creating profiles as needed.
// `--app` limits it to the desktop app (use with a name when auto-detect can't
// identify which account the app is signed into).
async function cmdAdd(ctx, rest) {
  logmod.log("add invoked");
  if (rest.indexOf('--token') !== -1) return cmdAddToken(ctx, rest);
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
    if (r.needName) return fail("Couldn't auto-identify the app's account. Name it:  keyflip add <name> --app" + (appDetectHint(r.reason) ? '\n  ↳ ' + appDetectHint(r.reason) : ''));
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
        'Name it yourself:  keyflip add <name> --app' + (appDetectHint(appRes.reason) ? '\n  ↳ ' + appDetectHint(appRes.reason) : ''));
    }
    return fail('Nothing to capture. Log in in Claude first.' + (cliErr ? '\n(CLI: ' + cliErr + ')' : ''));
  }
  if (cliRes && appRes.needName) {
    print("↳ The desktop app is signed in but its account couldn't be identified. If it's a");
    print('  different account than the CLI, capture it with:  keyflip add <name> --app');
    if (appDetectHint(appRes.reason)) print('  ↳ ' + appDetectHint(appRes.reason));
  }
  const anyIncomplete = profiles.list(ctx.configDir).some(function (n) { return capturedCliSafe(ctx, n) === false || !appauth.hasProfile(ctx, n); });
  if (anyIncomplete) print("Tip: 'keyflip list' shows what each account has captured ([cli|app]).");
}

// `keyflip login [name] [--email x] [--console] [--sso]` — sign in to an account
// via the OFFICIAL `claude auth login`, in an ISOLATED CLAUDE_CONFIG_DIR so the
// user's real login is never disturbed, then capture the freshly-minted token as
// a keyflip profile. The only human step is approving in the browser.
async function cmdLogin(ctx, rest) {
  logmod.log('login invoked');
  if (JSON_MODE) return fail('login is interactive (opens a browser) — do not run it with --json');
  const ei = rest.indexOf('--email');
  const email = ei !== -1 ? rest[ei + 1] : null;
  const useConsole = rest.indexOf('--console') !== -1;
  const sso = rest.indexOf('--sso') !== -1;
  const fresh = rest.indexOf('--fresh') !== -1;
  const manual = rest.indexOf('--manual') !== -1 || rest.indexOf('--paste') !== -1;
  const emailValIdx = ei !== -1 ? ei + 1 : -1;
  const name = rest.filter(function (a, i) { return a.indexOf('-') !== 0 && i !== emailValIdx; })[0] || null;
  if (name && !profiles.isValidName(name)) return fail("invalid profile name: '" + name + "' (allowed: A-Z a-z 0-9 . _ -)");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("'" + email + "' is not a valid email address");

  // --fresh: clear the browser's claude.ai session first, so the OAuth page prompts
  // a genuine login as the account you want (OAuth reuses whatever the browser is
  // signed into — otherwise it silently captures THAT account, not the one you meant).
  if (fresh && ctx.platform === 'darwin') {
    const browser = require('./browser');
    browser.installed(ctx.home).forEach(function (b) {
      const cr = browser.clearClaudeCookies(b, {});
      if (cr.ok) print(style.dim('· cleared ' + b.name + ' claude.ai session (backup: ' + cr.backup + ')'));
      else if (cr.reason === 'browser-running') print(style.warn('⚠️') + ' quit ' + b.name + ' first for --fresh to take effect (its claude.ai session is still active).');
    });
  }

  print(style.bold('keyflip login') + ' — sign in to a Claude account (your current login stays put).');
  print('A browser will open. ' + (email ? 'Sign in as ' + style.bold(email) : 'Sign in to the account you want to add') +
    (manual ? ' — sign in however you like (email code, magic link); paste the code/URL when asked.\n' : ' and approve — then I capture it automatically.\n'));

  if (manual && !process.stdin.isTTY) return fail('--manual is interactive — run it in a real terminal (it reads the pasted code from stdin).');

  let res;
  try {
    res = manual
      ? await loginmod.performLoginManual(ctx, { email: email, name: name, useConsole: useConsole, sso: sso })
      : loginmod.performLogin(ctx, { email: email, name: name, useConsole: useConsole, sso: sso, stdio: 'inherit' });
  } catch (e) {
    if (e.code === 'mismatch') {
      return fail(e.message + '.\nFix: log out of claude.com in that browser (' + style.bold('keyflip browser logout') +
        ", or 'switch account' on the login page), then retry:  keyflip login " + (name || (email ? email.split('@')[0] : '<name>')) + (email ? ' --email ' + email : '') + ' --fresh');
    }
    return fail(e.message + (e.code === 'no-cred' ? ' — nothing saved. (Please report this.)' : ''));
  }
  logmod.log('login ' + res.status + ' ' + res.name);
  saveBrowserSession(ctx, res.name); // stash its browser session for later `browser sync`
  print('\n' + style.ok('✅') + ' ' + res.status + " '" + style.bold(res.name) + "'" + (res.email ? ' (' + res.email + ')' : '') +
    ' — your current login is untouched. Switch with: ' + style.bold('keyflip ' + res.name));
  jsonOut({ login: true, name: res.name, email: res.email, refreshed: res.status === 'refreshed' });
}

// Capture whatever accounts are logged in RIGHT NOW (Claude Code CLI + desktop app)
// that aren't already saved. Mutates `captured` (a Set of lowercased emails) and
// returns the freshly-saved ones: [{ name, email, surface }].
function captureLive(ctx, captured) {
  const out = [];
  const cliEmail = core.currentEmail(ctx);
  if (cliEmail && !captured.has(cliEmail.toLowerCase())) {
    try {
      const r = core.addCurrent(ctx, null);
      if (r && r.email) { captured.add(r.email.toLowerCase()); out.push({ name: r.name, email: r.email, surface: 'CLI' }); }
    } catch (e) { logmod.log('setup: cli capture failed: ' + (e && e.message)); }
  }
  if (ctx.appDataDir) {
    let appEmail = null;
    try { const d = appauth.detectAppAccount(ctx); appEmail = d && d.email; } catch (e) { /* ignore */ }
    if (appEmail && !captured.has(String(appEmail).toLowerCase())) {
      const r = captureApp(ctx, null);
      if (r && r.ok) { captured.add(String(r.email || appEmail).toLowerCase()); out.push({ name: r.name, email: r.email, surface: 'app' }); }
    }
  }
  return out;
}

// Wait until either a brand-new login appears (polled every 1.5s) or the user
// presses Enter / types 'd'. Uses ONE shared readline (`rl`) for the whole wizard
// — creating a fresh interface per round breaks stdin on the second prompt.
// Resolves { found } | { rescan } | { done }.
function waitForNextLogin(ctx, captured, rl, isClosed) {
  const onboard = require('./onboard');
  return new Promise(function (resolve) {
    if (isClosed()) return resolve({ done: true });
    let settled = false;
    function finish(v) {
      if (settled) return; settled = true;
      clearInterval(timer);
      rl.removeListener('line', onLine);
      rl.removeListener('close', onClose);
      resolve(v);
    }
    function onLine(a) {
      const s = (a || '').trim().toLowerCase();
      finish(s === 'd' || s === 'done' || s === 'q' || s === 'quit' ? { done: true } : { rescan: true });
    }
    function onClose() { finish({ done: true }); }
    const timer = setInterval(function () {
      let found = null;
      try { found = onboard.firstNewLogin(ctx, captured); } catch (e) { /* ignore */ }
      if (found) finish({ found: found });
    }, 1500);
    rl.on('line', onLine);
    rl.once('close', onClose);
  });
}

// `keyflip setup` — guided wizard that walks the user through logging into each
// account and captures it automatically. Solves the painful manual add-per-account.
async function cmdSetup(ctx, rest) {
  logmod.log('setup invoked');
  if (!process.stdin.isTTY) {
    return fail('`keyflip setup` is an interactive wizard — run it directly in a terminal.\n' +
      'Non-interactive: log in, then `keyflip add` (once per account).');
  }
  const onboard = require('./onboard');
  const captured = onboard.capturedEmails(ctx);
  let total = captured.size;

  print(style.bold('keyflip setup') + ' — save all your Claude accounts, one login at a time.');
  print('For each account you log in once (Claude Code and/or the desktop app) and I capture it.');
  print(style.dim('Your chats in ~/.claude/projects are never touched; your live login is only read.') + '\n');
  if (captured.size) print('Already saved: ' + style.bold(String(captured.size)) + ' account(s).');

  const first = captureLive(ctx, captured);
  first.forEach(function (g) { total++; print('  ' + style.ok('✅') + " saved '" + style.bold(g.name) + "'" + (g.email ? ' (' + g.email + ')' : '') + ' [' + g.surface + ']'); });
  if (!first.length && !captured.size) {
    print('No account is logged in yet. In Claude Code run ' + style.bold('/login') + ' (or open the desktop app and sign in).');
  }

  // One readline for the whole wizard (a fresh one per round breaks stdin).
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stderr });
  let rlClosed = false;
  rl.once('close', function () { rlClosed = true; });
  const isClosed = function () { return rlClosed; };
  try {
    for (;;) {
      print('\n' + style.bold('Add another account?') + ' Switch to the next one:');
      print('  • Claude Code:  ' + style.bold('/logout') + ' then ' + style.bold('/login') + '    • or the desktop app: sign out, sign in');
      print("I'll capture it automatically — press " + style.bold('Enter') + ' to rescan now, or type ' + style.bold('d') + ' when done.');
      const ev = await waitForNextLogin(ctx, captured, rl, isClosed);
      if (ev.done) break;
      const got = captureLive(ctx, captured);
      if (got.length) {
        got.forEach(function (g) { total++; print('  ' + style.ok('✅') + " saved '" + style.bold(g.name) + "'" + (g.email ? ' (' + g.email + ')' : '') + ' [' + g.surface + ']'); });
      } else {
        const now = core.currentEmail(ctx);
        print('  ' + style.warn('…') + ' no new account detected' + (now ? ' (still ' + now + ')' : ' (signed out)') +
          ' — did you ' + style.bold('/logout') + ' then ' + style.bold('/login') + '? Try again, or type ' + style.bold('d') + '.');
      }
    }
  } finally { rl.close(); }

  print('\n' + style.ok('✅') + ' Done — ' + style.bold(String(total)) + ' account(s) saved.');
  print('Switch anytime:  ' + style.bold('keyflip') + ' (menu) or ' + style.bold('keyflip <name>') + '.   See all:  ' + style.bold('keyflip list --usage'));
  jsonOut({ setup: true, saved: total });
}

// `keyflip onboard` — the full guided first-run. For each account: drive a browser
// sign-in, capture it (CLI + browser), point the live CLI at it, sync all chats,
// then ask if you want to add another. A superset of `setup`. NB: the Claude desktop
// app has its OWN login (a separate token) that a browser sign-in can't mint, so
// onboard automates CLI + browser + chat-sync and GUIDES the optional desktop step.
// Inline provider (API-key endpoint) capture for the onboard wizard. Returns the
// provider name on success, or null if cancelled/failed. Reuses the wizard's rl.
async function onboardProvider(ctx, ask, rl) {
  const name = String(await ask('  Provider name (e.g. relay, openrouter, bedrock): ')).trim();
  if (!name) { print('  ' + style.warn('·') + ' cancelled (no name).'); return null; }
  if (!profiles.isValidName(name)) { print('  ' + style.err('✗') + " invalid name '" + name + "'."); return null; }
  if (provider.exists(ctx, name)) { print('  ' + style.warn('·') + " a provider named '" + name + "' already exists — skipping."); return null; }
  const baseUrl = String(await ask('  Base URL (https://…): ')).trim();
  if (!/^https?:\/\//.test(baseUrl)) { print('  ' + style.err('✗') + ' the base URL must be an http(s) URL.'); return null; }
  const schemeAns = String(await ask('  Auth header [Enter = bearer (ANTHROPIC_AUTH_TOKEN), a = api-key (ANTHROPIC_API_KEY)]: ')).trim();
  const authScheme = /^a/i.test(schemeAns) ? 'api-key' : 'bearer';
  const key = (await askHidden(rl, '  API key (input hidden; blank = none): ')).trim() || null;
  let meta;
  try { meta = provider.add(ctx, name, { baseUrl: baseUrl, authScheme: authScheme, key: key }); }
  catch (e) { print('  ' + style.err('✗') + ' ' + e.message); return null; }
  logmod.log('onboard provider add ' + name);
  print('  ' + style.ok('✅') + " saved provider '" + name + "' → " + meta.baseUrl + (key ? '' : '  (no key stored)'));
  const useAns = String(await ask('  Route Claude Code to it now? [y/N] ')).trim();
  if (/^y(es)?$/i.test(useAns)) {
    try { const r = provider.use(ctx, name); print('  ' + style.ok('✅') + ' Claude Code now uses ' + name + ' (' + r.baseUrl + '). Back to a subscription anytime: keyflip provider off.'); }
    catch (e) { print('  ' + style.warn('⚠') + ' saved, but could not activate it: ' + e.message); }
  }
  return name;
}

async function cmdOnboard(ctx, rest) {
  logmod.log('onboard invoked');
  if (!process.stdin.isTTY) return fail('`keyflip onboard` is an interactive wizard — run it in a terminal (ideally NOT inside the Claude desktop app, so aligning surfaces can\'t interrupt it).');
  const manual = rest.indexOf('--manual') !== -1 || rest.indexOf('--paste') !== -1;
  // Enterprise/SSO: apply to every OAuth sign-in in this run (#7).
  const sso = rest.indexOf('--sso') !== -1;
  const useConsole = rest.indexOf('--console') !== -1;

  print(style.bold('keyflip onboard') + ' — set your accounts up across every surface, one sign-in at a time.');
  print(style.dim('Per account: sign in once in the browser → keyflip captures it, points the CLI + browser at it, and syncs your chats. Then it asks if you want another.'));
  print(style.dim('The Claude desktop app keeps its OWN login — to capture that too, sign the app in when prompted.'));
  print(style.dim('Not a subscription? Choose "p" to add an API-key provider endpoint (relay/gateway/Bedrock/OpenRouter) instead.') + '\n');

  // terminal:true is REQUIRED so readline manages echo (via _writeToOutput) — that is
  // the only thing askHidden() can mute. Without it (e.g. `onboard 2>file`, stderr not a
  // TTY → readline defaults to terminal:false), the TTY driver echoes the typed provider
  // API key in cleartext and the mute never fires.
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const ask = function (q) { return new Promise(function (r) { rl.question(q, r); }); };
  const isDone = function (s) { return /^(d|done|q|quit|n|no)$/i.test(String(s || '').trim()); };
  const isProvider = function (s) { return /^(p|provider)$/i.test(String(s || '').trim()); };
  let count = 0, providers = 0;
  try {
    for (;;) {
      const ans = await ask('\n' + style.bold(count === 0 && providers === 0 ? 'Add your first account' : 'Add another account') + '? [Enter = subscription sign-in, p = API-key provider, d = done] ');
      if (isDone(ans)) { if (count > 0 || providers > 0) break; print('Add at least one account or provider (or Ctrl-C to quit).'); continue; }
      if (isProvider(ans)) { if (await onboardProvider(ctx, ask, rl)) providers++; continue; }

      // Before each account AFTER the first: sign the browser OUT of the previous
      // account (quit it + clear its claude.ai session) so the next sign-in is a
      // fresh login — no manual "switch account" on the page.
      if (count > 0 && ctx.platform === 'darwin') {
        try {
          const browser = require('./browser');
          const napMs = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
          let did = false;
          const list = browser.installed(ctx.home);
          for (let i = 0; i < list.length; i++) {
            const b = list[i];
            if (browser.isRunning(b)) { browser.quit(b, exec.run); for (let t = 0; t < 24 && browser.isRunning(b); t++) { await napMs(250); } }
            const cr = browser.clearClaudeCookies(b, { force: true });
            if (cr.ok) did = true;
          }
          if (did) print('  ' + style.dim('· signed the browser out of the previous account — the next sign-in is fresh.'));
        } catch (e) { /* best-effort */ }
      }

      let res;
      try {
        print('  Opening the browser — sign in as the account you want' + (manual ? ' (paste the code/URL when asked)…' : ' and approve…'));
        res = manual ? await loginmod.performLoginManual(ctx, { sso: sso, useConsole: useConsole })
                     : loginmod.performLogin(ctx, { sso: sso, useConsole: useConsole, stdio: 'inherit' });
      } catch (e) {
        print('  ' + style.err('✗') + ' sign-in didn\'t complete: ' + e.message);
        continue;
      }
      count++;
      print('  ' + style.ok('✅') + ' captured ' + style.bold(res.name) + ' (' + (res.email || '?') + ') — CLI + browser.');
      saveBrowserSession(ctx, res.name); // stash its browser session for later `browser sync`

      try { core.performSwitch(ctx, res.name); print('  ' + style.ok('✅') + ' CLI now on ' + res.name + '.'); }
      catch (e) { print('  ' + style.warn('⚠') + ' couldn\'t point the CLI at it: ' + e.message); }

      // Desktop (Claude Desktop app): it keeps its OWN login that a browser sign-in
      // can't mint, so offer a guided capture — the user signs the app in, we snapshot.
      if (ctx.appDataDir) {
        const da = await ask('  Capture the Claude Desktop app for this account too? Sign Claude Desktop into ' + style.bold(res.email || res.name) + ', then press Enter  [Enter = capture, s = skip] ');
        if (!/^\s*s(kip)?\s*$/i.test(da)) {
          const ar = captureApp(ctx, null); // auto-detect whichever account the app is on now
          if (ar && ar.ok) print('  ' + style.ok('✅') + ' Claude Desktop captured (' + (ar.email || ar.name) + ').');
          else print('  ' + style.warn('·') + ' desktop app not captured (' + ((ar && ar.reason) || 'is Claude Desktop signed into ' + (res.email || res.name) + '?') + ') — later: keyflip add --app');
        }
        // Sync chats across accounts (only possible while the app is closed).
        if (!appctl.isClaudeRunning(ctx.platform)) consolidateAndReport(ctx);
      }
    }
  } finally { rl.close(); }

  print('\n' + style.ok('✅') + ' Onboarding done — ' + style.bold(String(count)) + ' account(s)' +
    (providers ? ' + ' + style.bold(String(providers)) + ' provider(s)' : '') + ' set up. Switch anytime: ' +
    style.bold('keyflip <name>') + '   ·   see all: ' + style.bold('keyflip list'));
  jsonOut({ onboard: true, added: count, providers: providers });
}

// Sync the BROWSER (claude.ai session) to `name` — restore that account's saved
// session so the Claude extension reconnects as it. Quits the browser, writes the
// stored cookies, reopens. Returns the browsers actually synced. macOS only.
async function browserSync(ctx, name) {
  if (ctx.platform !== 'darwin') return [];
  const browser = require('./browser');
  const napMs = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const synced = [];
  const list = browser.installed(ctx.home);
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const sql = browser.loadSession(ctx.configDir, name, b);
    if (!sql) continue; // no saved browser session for this account+browser
    const wasRunning = browser.isRunning(b);
    if (wasRunning) { browser.quit(b, exec.run); for (let t = 0; t < 24 && browser.isRunning(b); t++) { await napMs(250); } }
    // If it refused to quit, DON'T force-write its live Cookies DB — that corrupts it.
    if (browser.isRunning(b)) { print('  ' + style.warn('⏭') + ' ' + b.name + ' is still open — quit it and re-run `keyflip browser sync ' + name + '`.'); continue; }
    const r = browser.restoreClaudeCookies(b, sql, { force: true });
    if (r.ok) { synced.push(b.name); if (wasRunning) exec.run('open', ['-a', b.proc]); }
  }
  return synced;
}

// Best-effort: stash the current browser session under `name` (called after a
// capture, when the browser IS on that account).
function saveBrowserSession(ctx, name) {
  if (ctx.platform !== 'darwin') return;
  try {
    const browser = require('./browser');
    browser.installed(ctx.home).forEach(function (b) { browser.saveSession(ctx.configDir, name, b, {}); });
  } catch (e) { /* best-effort */ }
}

// `keyflip browser [status|logout]` — Phase 2/3: see and reset the BROWSER's
// claude.ai session, which the Claude Chrome extension inherits. A mismatch
// between the browser account and the active CLI/desktop account is exactly why
// the "Claude browser" extension refuses to connect.
async function cmdBrowser(ctx, rest) {
  logmod.log('browser invoked');
  const browser = require('./browser');
  if (ctx.platform !== 'darwin') return fail('browser session management is macOS-only for now (cookie decryption differs on Windows/Linux).');
  const sub = rest[0] && rest[0].indexOf('-') !== 0 ? rest[0] : 'status';
  const bi = rest.indexOf('--browser');
  const only = bi !== -1 ? rest[bi + 1] : null;
  const force = rest.indexOf('--force') !== -1 || rest.indexOf('-y') !== -1;
  const list = browser.installed(ctx.home).filter(function (b) { return !only || b.id === only; });
  if (!list.length) return fail(only ? "no installed browser with id '" + only + "' (chrome|brave|edge|arc)" : 'no supported Chromium browser found (Chrome/Brave/Edge/Arc).');

  // The account the native-messaging host (and thus the extension) must match.
  let activeOrg = null, activeLabel = null;
  const st = loginmod.parseAuthStatus(exec.run('claude', ['auth', 'status'], undefined, { timeoutMs: 8000 }).stdout);
  if (st) { activeOrg = st.orgId; activeLabel = st.email; }
  function labelForOrg(org) {
    if (!org) return null;
    let lbl = null;
    profiles.list(ctx.configDir).forEach(function (n) { const m = profiles.read(ctx.configDir, n); if (m && m.oauthAccount && m.oauthAccount.organizationUuid === org) lbl = m.email || n; });
    return lbl;
  }

  if (sub === 'status') {
    print('Active account (CLI/desktop, what the extension must match): ' + style.bold(activeLabel || activeOrg || 'unknown'));
    let anyMismatch = false;
    list.forEach(function (b) {
      const ck = browser.readClaudeCookies(b, {});
      if (!ck) { print('  ' + b.name + ': ' + style.dim('not signed into claude.ai (or cookies unreadable — app-bound encryption?)')); return; }
      const lbl = labelForOrg(ck.org) || (ck.org ? ck.org.slice(0, 8) + '…' : 'unknown');
      const match = ck.org && activeOrg && ck.org === activeOrg;
      if (!match) anyMismatch = true;
      print('  ' + b.name + ': claude.ai = ' + style.bold(lbl) + '  ' +
        (match ? style.ok('✓ matches active') : style.warn('⚠ MISMATCH — the Claude browser extension will not connect')));
    });
    if (anyMismatch) print('\nFix: ' + style.bold('keyflip browser logout') + ' (clears the browser claude.ai session), then open claude.ai and sign in as ' + (activeLabel || 'the active account') + '.');
    jsonOut({ active: activeLabel || activeOrg, browsers: list.map(function (b) { const ck = browser.readClaudeCookies(b, {}); return { id: b.id, org: ck && ck.org, match: !!(ck && ck.org && ck.org === activeOrg) }; }) });
    return;
  }

  if (sub === 'logout') {
    print('This clears the claude.ai session from: ' + list.map(function (b) { return b.name; }).join(', ') +
      '  (a backup of each Cookies DB is kept; other sites stay signed in).');
    const running = list.filter(function (b) { return browser.isRunning(b); });
    if (running.length) print(style.warn('⚠️') + ' quit ' + running.map(function (b) { return b.name; }).join(', ') + ' first — the Cookies DB is locked while the browser is open' + (force ? ' (--force set: trying anyway).' : '.'));
    if (!force) {
      if (!process.stdin.isTTY) return fail('re-run with --force to confirm (and quit the browser first).');
      const ok = await confirm('Proceed? [y/N] ');
      if (!ok) { print('Cancelled.'); return; }
    }
    list.forEach(function (b) {
      const r = browser.clearClaudeCookies(b, { force: force });
      if (r.ok) print('  ' + style.ok('✅') + ' ' + b.name + ': claude.ai session cleared (backup: ' + r.backup + ').');
      else if (r.reason === 'browser-running') print('  ' + style.warn('⏭') + ' ' + b.name + ': still running — skipped (quit it, or --force).');
      else print('  ' + style.err('✗') + ' ' + b.name + ': ' + r.reason + (r.detail ? ' (' + r.detail + ')' : ''));
    });
    print('\nNow open claude.ai in that browser and sign in as ' + style.bold(activeLabel || 'your active account') + ' — the extension will reconnect.');
    return;
  }

  if (sub === 'sync') {
    // Restore the saved browser session for an account (the active one by default).
    const target = (rest[1] && rest[1].indexOf('-') !== 0) ? core.resolveProfile(ctx, rest[1]) : null;
    const name = target || (function () { let n = null; profiles.list(ctx.configDir).forEach(function (p) { if (!n && profiles.email(ctx.configDir, p) === core.currentEmail(ctx)) n = p; }); return n; })();
    if (!name) return fail('which account? usage: keyflip browser sync <name>  (or switch to it first)');
    print('Syncing the browser to ' + style.bold(profiles.email(ctx.configDir, name) || name) + ' (restores its saved claude.ai session, quits + reopens the browser)…');
    const synced = await browserSync(ctx, name);
    if (synced.length) print('  ' + style.ok('✅') + ' synced: ' + synced.join(', ') + ' — the Claude extension will reconnect as ' + (profiles.email(ctx.configDir, name) || name) + '.');
    else print('  ' + style.warn('·') + ' no saved browser session for ' + name + ' yet (it\'s saved when you capture the account via onboard/login while the browser is on it).');
    jsonOut({ browserSync: name, synced: synced });
    return;
  }
  return fail('usage: keyflip browser [status|logout|sync [name]] [--browser chrome|brave|edge|arc] [--force]');
}

// #8 desktop↔CLI tug-of-war: is the RUNNING desktop app on a DIFFERENT account than
// the one we just switched the CLI to? If so it can rewrite the shared login and undo
// an in-place (--force) swap. Uses detectActiveOrg (the config allowlist org) — NOT the
// token-decrypting detectAppAccount — so a fast --force never triggers a Keychain
// prompt. Pure; returns { risk, appLabel } (tests assert on it).
function desktopTugRisk(ctx, targetName) {
  if (ctx.platform !== 'darwin' || !ctx.appDataDir) return { risk: false };
  if (!appctl.isDesktopAppRunning(ctx.platform)) return { risk: false }; // app not running -> can't overwrite
  // A running-but-signed-OUT app can't rewrite anything; signOutApp leaves the stale
  // allowlist org, so corroborate with the live session cookie (still no Keychain access).
  try { if (!appauth.cookiesLookLoggedIn(appauth.cookiesPath(ctx))) return { risk: false }; } catch (e) { return { risk: false }; }
  let appOrg = null;
  try { appOrg = appauth.detectActiveOrg(ctx); } catch (e) { return { risk: false }; } // allowlist org, no Keychain access
  if (!appOrg) return { risk: false }; // can't tell the app's account -> don't cry wolf
  const meta = profiles.read(ctx.configDir, targetName) || {};
  const wantOrg = meta.oauthAccount && meta.oauthAccount.organizationUuid;
  if (!wantOrg) return { risk: false };            // target org unknown -> can't compare
  if (appOrg === wantOrg) return { risk: false };  // app already on the target account -> no conflict
  // Label the app account from a saved profile if one matches, else the org prefix.
  let appLabel = appOrg.slice(0, 8) + '…';
  profiles.list(ctx.configDir).forEach(function (n) {
    const m = profiles.read(ctx.configDir, n);
    if (m && m.oauthAccount && m.oauthAccount.organizationUuid === appOrg) appLabel = m.email || n;
  });
  return { risk: true, appLabel: appLabel };
}

function consolidateAndReport(ctx) {
  // Never write into the app's session store while it is still open.
  if (appctl.isClaudeRunning(ctx.platform)) return { ok: false, merged: 0, reason: 'Claude still running' };
  const c = appsessions.consolidate(ctx);
  if (c.ok && c.merged) print('  ↳ shared ' + c.merged + ' session pointer(s) so every account shows them all.');
  return c;
}

// `keyflip consolidate [--watch [--interval N]]` — sync every account's chat
// index so each one shows ALL conversations (gap #3/#4). The desktop app's store
// is locked while it runs, so a one-shot offers to bounce the app; --watch re-syncs
// on an interval whenever the app is closed (a foreground watcher, Ctrl-C to stop).
async function cmdConsolidate(ctx, rest) {
  if (!ctx.appDataDir) return fail('desktop chat sync is macOS/Windows-only (no Claude Desktop data dir here).');
  const watch = rest.indexOf('--watch') !== -1;
  const ii = rest.indexOf('--interval');
  const interval = ii !== -1 ? Math.max(5, parseInt(rest[ii + 1], 10) || 30) : 30;
  const autoYes = rest.indexOf('-y') !== -1 || rest.indexOf('--yes') !== -1;

  async function syncLocked() {
    const l = await lock.acquire(ctx.configDir);
    try { return appsessions.consolidate(ctx); } finally { l.release(); }
  }

  if (watch) {
    print('Watching — re-syncing chats across accounts every ' + interval + 's while Claude Desktop is closed. Ctrl-C to stop.');
    logmod.log('consolidate --watch started (' + interval + 's)');
    // eslint-disable-next-line no-constant-condition
    for (;;) {
      try {
        if (!appctl.isClaudeRunning(ctx.platform)) {
          const c = await syncLocked();
          if (c.ok && c.merged) print('  ' + style.ok('↳') + ' ' + c.merged + ' new session pointer(s) synced (' + new Date().toISOString() + ').');
        }
      } catch (e) {
        // A transient failure (lock contention, a mid-write app) must NOT kill the
        // watcher — its contract is to keep re-syncing until Ctrl-C.
        logmod.log('consolidate --watch tick failed: ' + (e && e.message));
      }
      await sleep(interval * 1000);
    }
  }

  // one-shot
  if (!appctl.isClaudeRunning(ctx.platform)) {
    const c = await syncLocked();
    if (c.ok) print(style.ok('✅') + ' synced ' + (c.merged || 0) + ' session pointer(s) across accounts (Recents: ' + (c.code || 0) + ', Cowork: ' + (c.cowork || 0) + ').');
    else print(style.warn('·') + ' nothing to sync' + (c.reason ? ' (' + c.reason + ')' : '') + '.');
    jsonOut({ consolidated: { merged: c.merged || 0, code: c.code || 0, cowork: c.cowork || 0 } });
    return;
  }
  // App is open — its session store is locked. Offer to bounce it, else defer.
  if (appctl.canManageApp(ctx.platform) && (autoYes || process.stdin.isTTY)) {
    if (!autoYes) {
      const ok = await confirm('Claude Desktop is open — close it to sync chats, then reopen it? [y/N] ');
      if (!ok) { print('Deferred — re-run with the app closed.'); return; }
    }
    print('Quitting Claude...'); appctl.quitClaude(ctx.platform); await waitForQuit(ctx);
    const c = await syncLocked();
    print(style.ok('✅') + ' synced ' + (c.merged || 0) + ' session pointer(s) across accounts.');
    print('Reopening Claude...'); appctl.openClaude(ctx.platform);
    jsonOut({ consolidated: { merged: c.merged || 0, bounced: true } });
    return;
  }
  return fail('Claude Desktop is open — close it and re-run `keyflip consolidate` (its session store is locked while it runs).');
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function waitForQuit(ctx, timeoutMs) {
  const deadline = timeoutMs || 20000;
  let waited = 0;
  while (appctl.isClaudeRunning(ctx.platform) && waited < deadline) { await sleep(500); waited += 500; }
}

// Delete ALL of keyflip's saved data: every profile secret from the credential
// store, then the whole config dir. Shared by `clean` and `uninstall --purge`.
function wipeKeyflipData(ctx) {
  const names = profiles.list(ctx.configDir);
  names.forEach(function (n) { try { ctx.store.delProfile(n); } catch (e) { /* keychain locked / already gone */ } });
  try { fs.rmSync(ctx.configDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  return names.length;
}

// Sign the machine OUT of Claude across every surface selected in `opts`
// (cli / browser / desktop). Shared by `reset --logout`.
// Never wipes saved keyflip profiles — only clears the LIVE sessions. Returns the
// surfaces actually signed out.
async function logoutSurfaces(ctx, opts) {
  opts = opts || {};
  const out = [];
  const closeApps = !!opts.closeApps;
  const napMs = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // CLI: with closeApps, first terminate every running Claude Code process, then
  // clear the live credential.
  if (opts.cli) {
    if (closeApps) {
      const insts = appctl.claudeInstances(ctx.home) || [];
      let killed = 0;
      insts.forEach(function (i) { try { process.kill(i.pid, 'SIGTERM'); killed++; } catch (e) { /* already gone */ } });
      if (killed) print('  ' + style.ok('✓') + ' closed ' + killed + ' running Claude Code process(es).');
    }
    loginmod.cliLogout(ctx);
    print('  ' + style.ok('✓') + ' signed out of Claude Code (CLI).'); out.push('cli');
  }

  // Browser: with closeApps, quit each Chromium browser first (so its Cookies DB
  // unlocks), then clear its claude.ai session — the Claude extension logs out with
  // it. Without closeApps we refuse while it runs (clearing a live DB can corrupt it).
  if (opts.browser && ctx.platform === 'darwin') {
    const browser = require('./browser');
    const list = browser.installed(ctx.home);
    if (!list.length) print('  ' + style.dim('· no Chromium browser to sign out.'));
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (closeApps && browser.isRunning(b)) {
        browser.quit(b, exec.run);
        for (let t = 0; t < 24 && browser.isRunning(b); t++) { await napMs(250); } // let it exit
      }
      const r = browser.clearClaudeCookies(b, { force: closeApps || !!opts.forceBrowser });
      if (r.ok) { print('  ' + style.ok('✓') + ' ' + (closeApps ? 'closed ' + b.name + ' + cleared its' : 'cleared ' + b.name) + ' claude.ai session.'); out.push('browser:' + b.id); }
      else if (r.reason === 'browser-running') print('  ' + style.warn('⏭') + ' ' + b.name + ' is running — quit it, then re-run to clear its session.');
      else print('  ' + style.warn('⚠️') + ' ' + b.name + ': ' + r.reason);
    }
  }

  // Desktop app: quit it, sign it out, and — for a full close — leave it CLOSED.
  if (opts.desktop && ctx.appDataDir) {
    const wasRunning = appctl.isClaudeRunning(ctx.platform);
    if (wasRunning && appctl.canManageApp(ctx.platform)) { appctl.quitClaude(ctx.platform); await waitForQuit(ctx); }
    if (!appctl.isClaudeRunning(ctx.platform)) {
      const r = appauth.signOutApp(ctx);
      if (r.ok) { print('  ' + style.ok('✓') + ' ' + (closeApps ? 'closed and ' : '') + 'signed out of the Claude desktop app.'); out.push('desktop'); }
      if (!closeApps && wasRunning && appctl.canManageApp(ctx.platform)) appctl.openClaude(ctx.platform);
    } else { print('  ' + style.warn('⚠️') + ' Close the Claude desktop app, then re-run to sign it out.'); }
  }
  return out;
}

// `keyflip reset` — FACTORY reset: DELETE all keyflip data (saved accounts,
// providers, backups, history, runtime state) while keeping keyflip installed.
// `--soft` keeps your accounts and only clears runtime state (proxy/breaker/cache/
// logs) + routes Claude Code back to the subscription. `--logout [--no-desktop]`
// also signs OUT of the live surfaces (CLI + browser + desktop).
async function cmdReset(ctx, rest) {
  logmod.log('reset invoked');
  const force = rest.indexOf('--force') !== -1 || rest.indexOf('-y') !== -1 || rest.indexOf('--yes') !== -1;
  const logout = rest.indexOf('--logout') !== -1 || rest.indexOf('--signout') !== -1;
  const noDesktop = rest.indexOf('--no-desktop') !== -1;
  const soft = rest.indexOf('--soft') !== -1;
  const names = profiles.list(ctx.configDir);
  const proxyUp = proxy.isRunning(ctx);

  if (soft) {
    // Gentle: KEEP accounts; clear only runtime state + route back to subscription.
    const derived = uninstallmod.derivedStatePaths(ctx).filter(function (d) { return fs.existsSync(d.path); });
    const active = provider.readActive(ctx);
    const provName = active && active.name;
    if (!derived.length && !proxyUp && !provName && !logout) {
      print('Nothing to reset — keyflip is already at a clean state.');
      jsonOut({ reset: 'soft', keptAccounts: names.length }); return;
    }
    print('Soft reset — KEEP your ' + names.length + ' account(s); clear only runtime state:');
    if (derived.length) print('  • clear: ' + derived.map(function (d) { return d.name; }).join(', '));
    if (proxyUp) print('  • stop the running failover proxy');
    if (provName) print('  • route Claude Code back to your subscription (was provider ' + provName + ')');
    if (logout) print('  • sign out of the live session: CLI' + (ctx.platform === 'darwin' ? ' + browser' : '') + (noDesktop ? '' : ' + desktop'));
    if (!force) {
      if (!process.stdin.isTTY) return fail('Re-run with --force to confirm the soft reset.');
      const ok = await confirm('\nProceed? [y/N] '); if (!ok) { print('Cancelled — nothing was changed.'); return; }
    }
    if (proxyUp) { try { await proxy.stop(ctx); print('  ✓ stopped the proxy.'); } catch (e) { /* ignore */ } }
    if (provName) { try { provider.useOfficial(ctx); print('  ✓ routed Claude Code back to your subscription.'); } catch (e) { /* ignore */ } }
    derived.forEach(function (d) { try { fs.rmSync(d.path, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
    if (derived.length) print('  ✓ cleared runtime state.');
    let out = [];
    if (logout) out = await logoutSurfaces(ctx, { cli: true, browser: true, desktop: !noDesktop, force: force, closeApps: true });
    print(style.ok('✅') + ' Soft reset complete — your ' + names.length + ' account(s) are intact.' + (logout ? ' Signed out of: ' + (out.join(', ') || 'nothing') + '.' : ''));
    jsonOut({ reset: 'soft', keptAccounts: names.length, loggedOut: out });
    return;
  }

  // DEFAULT = FACTORY reset: delete everything keyflip saved (app stays installed).
  let appCount = 0, backupCount = 0;
  try { appCount = fs.readdirSync(path.join(ctx.configDir, 'app')).length; } catch (e) { /* none */ }
  try { backupCount = fs.readdirSync(path.join(ctx.configDir, 'backups')).length; } catch (e) { /* none */ }
  if (!names.length && !appCount && !backupCount && !logout) {
    print('Nothing to reset — keyflip has no saved data.');
    jsonOut({ reset: 'factory', wiped: false }); return;
  }
  print(style.warn('Factory reset') + ' — DELETES all keyflip data (keyflip stays installed):');
  print('  • accounts: ' + (names.length ? names.join(', ') : 'none') + '  · captured app logins: ' + appCount + '  · backups: ' + backupCount + '  · Keychain keyflip:*');
  print('  • providers, usage history, proxy/breaker state, caches, logs');
  if (logout) print('  • SIGN OUT of the live session: CLI' + (ctx.platform === 'darwin' ? ' + browser' : '') + (noDesktop ? '  (leaving the desktop app signed in)' : ' + the desktop app'));
  print('Not deleted: ~/.claude/projects history' + (logout ? '.' : '; your live Claude login stays (add --logout to sign out).'));
  print(style.dim('(Keep your accounts and only clear runtime glitches instead:  keyflip reset --soft)'));

  if (!force) {
    if (!process.stdin.isTTY) return fail('Re-run with --force to confirm the factory reset — this DELETES your saved accounts (or use --soft to keep them).');
    const ok = await confirm('\nDelete all keyflip data? [y/N] '); if (!ok) { print('Cancelled — nothing was changed.'); return; }
  }
  if (proxyUp) { try { await proxy.stop(ctx); print('  ✓ stopped the proxy.'); } catch (e) { /* ignore */ } }
  const n = wipeKeyflipData(ctx);
  // Also sweep keyflip's stray artifacts OUTSIDE configDir (browser Cookies backups).
  if (ctx.platform === 'darwin') {
    try {
      const browser = require('./browser');
      browser.installed(ctx.home).forEach(function (b) { try { fs.rmSync(b.cookies + '.keyflip-bak', { force: true }); } catch (e) { /* none */ } });
    } catch (e) { /* best-effort */ }
  }
  print('  ✓ deleted all keyflip data (' + n + ' account(s)) and swept stray backups.');
  let out = [];
  if (logout) out = await logoutSurfaces(ctx, { cli: true, browser: true, desktop: !noDesktop, force: force, closeApps: true });
  print(style.ok('✅') + ' Factory reset complete.' + (logout ? ' Signed out of: ' + (out.join(', ') || 'nothing') + '.' : ''));
  jsonOut({ reset: 'factory', wiped: true, accountsDeleted: n, loggedOut: out });
}

// `keyflip uninstall` — remove keyflip from this machine (npm-global or install.sh
// layout, auto-detected). Keeps saved data unless --purge. Never touches the live
// Claude login (use `reset --logout` first) or a source checkout.
async function cmdUninstall(ctx, rest) {
  logmod.log('uninstall invoked');
  const force = rest.indexOf('--force') !== -1 || rest.indexOf('-y') !== -1 || rest.indexOf('--yes') !== -1;
  const purge = rest.indexOf('--purge') !== -1;
  const binPath = process.argv[1] || '';
  let real = binPath; try { real = fs.realpathSync(binPath); } catch (e) { /* keep */ }
  const method = uninstallmod.classifyInstall(real, ctx.platform);
  const plan = uninstallmod.planUninstall({ method: method, home: ctx.home, platform: ctx.platform });
  const names = profiles.list(ctx.configDir);

  print('Uninstall keyflip from this machine:');
  if (method === 'dev') {
    print('  • running from a source checkout (' + path.dirname(path.dirname(real)) + ') — that folder is left untouched');
  } else if (method === 'npm') {
    print('  • ' + plan.npm.cmd + ' ' + plan.npm.args.join(' '));
  } else {
    plan.files.forEach(function (f) { print('  • remove ' + f.label + ': ' + f.path); });
  }
  if (purge) {
    print('  • PURGE keyflip data: ' + names.length + ' account(s), providers, backups, Keychain keyflip:*');
  } else {
    print('  • keep saved keyflip data (accounts/providers/backups) — add --purge to delete it too');
  }
  print('Not touched: your Claude login (run `keyflip reset --logout` first to sign out), ~/.claude/projects.');
  if (method === 'dev' && !purge) { print('\nNothing to do (source checkout, no --purge).'); jsonOut({ uninstalled: false, method: method, purged: false }); return; }

  if (!force) {
    if (!process.stdin.isTTY) return fail('Re-run with --force to confirm the uninstall.');
    const ok = await confirm('\nProceed? [y/N] ');
    if (!ok) { print('Cancelled — nothing was changed.'); return; }
  }

  // Data first, so it still succeeds even if removing our own files fails midway.
  if (purge) { const n = wipeKeyflipData(ctx); print('  ✓ purged keyflip data (' + n + ' account(s)).'); }

  if (method === 'npm') {
    const r = require('child_process').spawnSync(plan.npm.cmd, plan.npm.args, { stdio: 'inherit' });
    if (r.error || r.status !== 0) print(style.warn('⚠️ could not auto-remove the npm package — run it yourself: ' + plan.npm.cmd + ' ' + plan.npm.args.join(' ')));
    else print('  ✓ removed the npm global package.');
  } else if (method !== 'dev') {
    const failed = [];
    plan.files.forEach(function (f) { try { fs.rmSync(f.path, { recursive: true, force: true }); } catch (e) { failed.push(f.path); } });
    if (failed.length) print(style.warn('⚠️ could not remove (delete manually): ' + failed.join(', ')));
    else print('  ✓ removed keyflip program files' + (ctx.platform === 'darwin' ? ' and launcher app' : '') + '.');
    if (plan.pathNote) print('  • ' + plan.pathNote);
  }

  print(style.ok('✅') + ' keyflip uninstalled.' + (purge ? '' : ' (Saved data kept — re-run with --purge to remove it.)'));
  jsonOut({ uninstalled: true, method: method, purged: purge });
}

async function cmdList(ctx, rest) {
  const list = core.listProfiles(ctx);
  // One detection pass → the saved profile the app is on (by org), plus a fallback
  // label so an UNSAVED signed-in account still shows an email/org, not "unknown".
  let appActive = null, appDet = null;
  if (ctx.appDataDir) {
    appDet = appauth.detectAppAccount(ctx);
    if (appDet && appDet.org) {
      profiles.list(ctx.configDir).forEach(function (n) {
        if (appActive) return;
        const m = profiles.read(ctx.configDir, n);
        if (m && m.oauthAccount && m.oauthAccount.organizationUuid === appDet.org) appActive = n;
      });
    }
  }
  const appFallbackLabel = appActive ? null : (appDet && (appDet.email || (appDet.org ? appDet.org.slice(0, 8) + '… (unsaved)' : null)));
  const withUsage = (rest || []).indexOf('--usage') !== -1;
  let infos = null;
  if (withUsage && list.length) {
    const activeEntry = list.filter(function (e) { return e.active; })[0];
    infos = await usagemod.usageForProfiles(ctx, list.map(function (e) { return e.name; }),
      { liveFor: activeEntry ? activeEntry.name : null, recordHistory: true });
  }
  // Which account is each browser's claude.ai session on? The Claude Chrome
  // extension inherits that session, so this is the "browser (extension)" surface.
  // Best-effort, macOS only.
  const browserOrgs = {}; // org uuid -> [browser names]
  let browsersPresent = 0;
  if (ctx.platform === 'darwin') {
    try {
      const browser = require('./browser');
      const inst = browser.installed(ctx.home);
      browsersPresent = inst.length;
      inst.forEach(function (b) {
        const ck = browser.readClaudeCookies(b, {});
        if (ck && ck.org) { (browserOrgs[ck.org] = browserOrgs[ck.org] || []).push(b.name); }
      });
    } catch (e) { /* best-effort */ }
  }
  function browserFor(name) {
    const m = profiles.read(ctx.configDir, name) || {};
    const org = m.oauthAccount && m.oauthAccount.organizationUuid;
    return (org && browserOrgs[org]) ? browserOrgs[org] : null;
  }

  if (JSON_MODE) {
    jsonOut({
      accounts: list.map(function (e) {
        const web = browserFor(e.name);
        return {
          index: e.index, name: e.name, email: e.email || null,
          cliCaptured: capturedCliSafe(ctx, e.name),
          appCaptured: appauth.hasProfile(ctx, e.name),
          browserSignedIn: !!web,
          browsers: web || undefined,
          activeCli: !!e.active,
          activeApp: e.name === appActive,
          usage: infos ? ((infos[e.name] && infos[e.name].usage) || null) : undefined,
          usageStatus: infos ? ((infos[e.name] && infos[e.name].status) || null) : undefined,
        };
      }),
      activeCli: core.currentEmail(ctx) || null,
      activeApp: appActive ? (profiles.email(ctx.configDir, appActive) || appActive) : null,
    });
    return;
  }
  print('Saved accounts (' + ctx.configDir + '):');
  if (!list.length) { print("  (none yet — log in in Claude, then run 'keyflip add')"); }
  else {
    const anyBrowser = browsersPresent > 0;
    list.forEach(function (e) {
      const cli = capturedCliSafe(ctx, e.name);
      const app = appauth.hasProfile(ctx, e.name);
      const web = browserFor(e.name);
      const now = [];
      if (e.active) now.push('CLI');
      if (e.name === appActive) now.push('app');
      if (web) now.push('browser');
      let usageCol = '';
      if (infos) {
        const info = infos[e.name] || {};
        usageCol = '   [' + (info.status === 'ok' ? usagemod.fmt(info.usage) : (info.status || '?')) + ']';
      }
      print(' ' + (now.length ? '→' : ' ') + ' [' + e.index + '] ' + (e.email || e.name) +
        '   [cli ' + (cli === null ? '?' : (cli ? '✓' : '—')) + ' | app ' + (app ? '✓' : '—') +
        (anyBrowser ? ' | web ' + (web ? '✓' : '—') : '') + ']' + usageCol +
        (now.length ? '   ← active: ' + now.join(' + ') : ''));
    });
  }
  print('');
  print('Active — Claude Code: ' + (core.currentEmail(ctx) || 'not logged in') +
    (ctx.appDataDir ? '   ·   desktop app: ' + (appActive ? profiles.email(ctx.configDir, appActive) || appActive : (appFallbackLabel || 'unknown')) : ''));
  if (browsersPresent > 0) {
    const orgs = Object.keys(browserOrgs);
    if (!orgs.length) {
      print('Browser (Claude extension): ' + style.dim('signed out of claude.ai'));
    } else {
      const orgLabel = function (o) {
        let lbl = o.slice(0, 8) + '…';
        profiles.list(ctx.configDir).forEach(function (n) { const m = profiles.read(ctx.configDir, n); if (m && m.oauthAccount && m.oauthAccount.organizationUuid === o) lbl = m.email || n; });
        return lbl;
      };
      const labels = orgs.map(function (o) { return orgLabel(o) + ' (' + browserOrgs[o].join(', ') + ')'; });
      const activeEntry = list.filter(function (e) { return e.active; })[0];
      const activeOrg = activeEntry ? ((profiles.read(ctx.configDir, activeEntry.name) || {}).oauthAccount || {}).organizationUuid : null;
      const mismatch = activeOrg && orgs.indexOf(activeOrg) === -1;
      print('Browser (Claude extension): ' + labels.join('; ') +
        (mismatch ? '   ' + style.warn('⚠ differs from the active account — the extension may not connect (fix: keyflip browser logout)') : ''));
    }
  }
}

// H3: git-backed versioning of keyflip's config/state (never secrets). history/undo/restore.
async function cmdVersion(ctx, rest) {
  const vcs = require('./vcs');
  const sub = rest[0];
  if (sub === 'on' || sub === 'enable') {
    const ok = vcs.enable(ctx);
    print(ok ? style.ok('✅') + ' versioning ON — every change is committed to ' + ctx.configDir + '/.git (secrets excluded).'
             : style.warn('·') + ' could not enable versioning (is git installed?).');
    return;
  }
  if (sub === 'off' || sub === 'disable') { vcs.disable(ctx); print(style.ok('✅') + ' versioning OFF (history kept; re-enable: keyflip versioning on).'); return; }
  const enabled = vcs.isEnabled(ctx), repo = vcs.isRepo(ctx);
  if (JSON_MODE) { jsonOut({ versioning: { enabled: enabled, repo: repo, git: vcs.gitAvailable() } }); return; }
  print('Versioning: ' + (enabled ? style.ok('on') : style.warn('off')) +
    (repo ? '   (' + ctx.configDir + '/.git)' : vcs.gitAvailable() ? '' : '   (git not installed)'));
  const hist = vcs.log(ctx, 8);
  if (hist.length) {
    print('Recent changes:');
    hist.forEach(function (h) { print('  ' + h.ref + '  ' + h.date.slice(0, 16).replace('T', ' ') + '  ' + h.subject.replace(/^keyflip: /, '')); });
    print('\nUndo the last: ' + style.bold('keyflip undo') + '   ·   restore a point: ' + style.bold('keyflip restore <ref>'));
  } else if (repo) print('  (no changes recorded yet)');
}

function cmdHistory(ctx, rest) {
  const vcs = require('./vcs');
  const n = parseInt(rest[0], 10) || 20;
  const hist = vcs.log(ctx, n);
  if (JSON_MODE) { jsonOut({ history: hist }); return; }
  if (!hist.length) { print(vcs.isRepo(ctx) ? 'No changes recorded yet.' : 'Versioning is not set up yet (keyflip versioning on).'); return; }
  hist.forEach(function (h) { print('  ' + h.ref + '  ' + h.date.slice(0, 16).replace('T', ' ') + '  ' + h.subject.replace(/^keyflip: /, '')); });
  print('\nUndo the last: ' + style.bold('keyflip undo') + '   ·   restore a point: ' + style.bold('keyflip restore <ref>'));
}

function cmdUndo(ctx) {
  const r = require('./vcs').undo(ctx);
  if (!r.ok) return fail('cannot undo: ' + (r.reason === 'nothing-to-undo' ? 'no earlier state recorded' : r.reason || 'unknown'));
  print(style.ok('✅') + ' undid the last change (a revert was recorded — see keyflip history).');
  jsonOut({ undone: true });
}

function cmdRestore(ctx, rest) {
  const ref = rest[0];
  if (!ref) return fail('usage: keyflip restore <ref>   (list refs with: keyflip history)');
  const r = require('./vcs').restore(ctx, ref);
  if (!r.ok) return fail('restore failed: ' + (r.reason || 'unknown') + (r.detail ? ' (' + String(r.detail).trim() + ')' : ''));
  print(style.ok('✅') + ' restored keyflip state to ' + ref + '.');
  jsonOut({ restored: ref });
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
  // H3: a descriptive label for the auto-version commit (argv holds no secrets by rule).
  ctx._vcsLabel = [cmd].concat(rest.filter(function (a) { return a && a[0] !== '-'; }).slice(0, 2)).join(' ') || 'update';
  try { require('./migrations').runMigrations(ctx); } catch (e) { /* never blocks startup */ }
  try {
    await dispatch(ctx, cmd, rest);
  } catch (e) {
    fail(e && e.message ? e.message : String(e));
  }
  // Passive update notice — after the command; never for --json/menu/upgrade/clean.
  // Skip the passive update fetch for machine/interactive/long-lived commands: it
  // would corrupt the MCP stdio stream, delay `run`/`mcp` exit on a slow network,
  // or print a stray line during a destructive/JSON op.
  const NO_NOTICE = ['menu', 'menubar', 'upgrade', 'reset', 'uninstall', 'setup', 'onboard', 'login', 'mcp', 'run', 'autoswitch', 'install-skill', 'statusline', 'send', 'panel', 'agents'];
  const skipNotice = JSON_MODE || cmd === undefined || NO_NOTICE.indexOf(cmd) !== -1;
  if (!skipNotice) { try { await update.maybeNotify(ctx, VERSION); } catch (e) { /* ignore */ } }
}

async function dispatch(ctx, cmd, rest) {
  {
    switch (cmd) {
      case undefined:
        if (!process.stdin.isTTY) { usage(); return; }
        return require('./menu').runMenu(ctx);
      case 'menu': // hidden: used by the launcher app; same as bare `keyflip`
        return require('./menu').runMenu(ctx);
      case 'add':
        return withLock(ctx, function () { return cmdAdd(ctx, rest); });
      case 'setup':
        return withLock(ctx, function () { return cmdSetup(ctx, rest); });
      case 'onboard':
        return withLock(ctx, function () { return cmdOnboard(ctx, rest); });
      case 'login':
        return withLock(ctx, function () { return cmdLogin(ctx, rest); });
      case 'list':
        return cmdList(ctx, rest);
      case 'status':
        return cmdStatus(ctx);
      case 'next':
        return withLock(ctx, function () { return cmdNext(ctx, rest); });
      case 'remove':
        return withLock(ctx, function () {
          const n = core.resolveProfile(ctx, rest[0]);
          if (!n) return fail("no such account: '" + (rest[0] || '') + "'");
          // Never yank the account live Claude sessions are using out from under them.
          const em = profiles.email(ctx.configDir, n);
          if (em && em === core.currentEmail(ctx) && rest.indexOf('--force') === -1) {
            const live = appctl.claudeInstances(ctx.home);
            if (live.length) {
              return fail("'" + em + "' is the account " + live.length + ' running Claude session(s) are using ' +
                '(pid ' + live.map(function (i) { return i.pid; }).join(', ') + ') — close them first, or pass --force.');
            }
          }
          core.removeProfile(ctx, n);
          logmod.log('removed profile ' + n);
          print('🗑  removed: ' + n);
        });
      case 'provider':
        return cmdProvider(ctx, rest);
      case 'use':
        return withLock(ctx, function () { return cmdProviderUse(ctx, rest[0]); }, 'provider');
      case 'speedtest':
        return cmdSpeedtest(ctx, rest);
      case 'doctor':
        return cmdDoctor(ctx, rest);
      case 'test':
        return cmdTest(ctx, rest);
      case 'usage':
        return cmdUsage(ctx, rest);
      case 'backup':
        return withLock(ctx, function () { return cmdBackup(ctx, rest); });
      case 'share':
        return cmdShare(ctx, rest);
      case 'mcpreg':
        return withLock(ctx, function () { return cmdMcpreg(ctx, rest); });
      case 'gateway':
        return withLock(ctx, function () { return cmdGateway(ctx, rest); }, 'claude-desktop');
      case 'sync':
        return cmdSync(ctx, rest);
      case 'versioning':
        return cmdVersion(ctx, rest);
      case 'history': case 'log':
        return cmdHistory(ctx, rest);
      case 'undo':
        return withLock(ctx, function () { return cmdUndo(ctx); }, 'undo');
      case 'restore':
        return withLock(ctx, function () { return cmdRestore(ctx, rest); }, 'restore');
      case 'consolidate':
        return cmdConsolidate(ctx, rest);
      case 'memory':
        return (rest[0] === 'remove' || rest[0] === 'rm')
          ? withLock(ctx, function () { return cmdMemory(ctx, rest); })
          : cmdMemory(ctx, rest);
      case 'dream':
        return cmdDream(ctx, rest);
      case 'recall':
        return cmdRecall(ctx, rest);
      case 'settings':
        return (rest[0] === 'set' || rest[0] === 'unset')
          ? withLock(ctx, function () { return cmdSettings(ctx, rest); }, 'claude-settings')
          : cmdSettings(ctx, rest);
      case 'statusline':
        return (rest[0] === 'install' || rest[0] === 'uninstall' || rest[0] === 'remove')
          ? withLock(ctx, function () { return cmdStatusline(ctx, rest); }, 'claude-settings')
          : cmdStatusline(ctx, rest);
      case 'panel':
        return cmdPanel(ctx, rest);
      case 'menubar':
        return cmdMenubar(ctx, rest);
      case 'sessions':
        return cmdSessions(ctx, rest);
      case 'resume':
        return cmdResume(ctx, rest);
      case 'send':
        return cmdSend(ctx, rest);
      case 'cowork':
        return cmdCowork(ctx, rest);
      case 'chat':
        return cmdChat(ctx, rest);
      case 'browser':
        return cmdBrowser(ctx, rest);
      case 'skill':
        return cmdSkill(ctx, rest);
      case 'proxy':
        return cmdProxy(ctx, rest);
      case '__proxy-serve': // hidden: the detached background server process
        return proxyServe(ctx, rest);
      case 'mcp':
        return cmdMcp(ctx, rest);
      case 'install-skill':
        return cmdInstallSkill(ctx, rest);
      case 'autoswitch':
        return cmdAutoswitch(ctx, rest);
      case 'link':
        return cmdLink(ctx, rest);
      case 'run':
        return cmdRun(ctx, rest);
      case 'export':
        return cmdExport(ctx, rest);
      case 'import':
        return withLock(ctx, function () { return cmdImport(ctx, rest); });
      case 'migrate':
        // `import` locks the whole (fast) file-read+apply; `pull` locks only its write
        // internally so the network fetch + confirm prompt don't hold the mutex.
        return rest[0] === 'import'
          ? withLock(ctx, function () { return cmdMigrate(ctx, rest); })
          : cmdMigrate(ctx, rest);
      case 'transfer':
        return cmdTransfer(ctx, rest); // `pull` locks only its write internally
      case 'agents':
        return cmdAgents(ctx, rest);
      case 'upgrade':
        return cmdUpgrade(ctx);
      case 'reset':
        return withLock(ctx, function () { return cmdReset(ctx, rest); });
      case 'uninstall':
        return withLock(ctx, function () { return cmdUninstall(ctx, rest); });
      case 'version':
      case '--version':
      case '-v':
        print('keyflip ' + VERSION);
        return;
      case 'help':
      case '--help':
      case '-h':
        usage();
        return;
      default: {
        // `keyflip <name|number>` switches directly.
        if (core.resolveProfile(ctx, cmd)) return withLock(ctx, function () { return cmdSwitch(ctx, [cmd].concat(rest)); });
        process.stderr.write("keyflip: unknown command or account '" + cmd + "'\n\n");
        usage();
        process.exitCode = 1;
        return;
      }
    }
  }
}

module.exports = { main: main, usage: usage, positionals: positionals, onboardProvider: onboardProvider, desktopTugRisk: desktopTugRisk };
