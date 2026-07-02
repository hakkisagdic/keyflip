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
const mcp = require('./mcp');
const style = require('./style').make(process.stdout);

// Serialize every mutation across processes (double-fired alias, launcher app
// racing a terminal, two menus) so a switch can never interleave with another.
async function withLock(ctx, fn, resource) {
  const l = await lock.acquire(ctx.configDir, resource ? { resource: resource } : undefined);
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
  print('keyflip ' + VERSION + ' — switch between Anthropic / Claude Code accounts (macOS, Linux, Windows)');
  print('');
  print('  keyflip                       interactive menu (↑/↓ + Enter)');
  print('  keyflip add [name] [--app]    save the account(s) you are logged into — Claude Code');
  print('                                 AND the desktop app, auto-detected. Once per account.');
  print('                                 (--app: desktop app only; name it if undetected)');
  print('  keyflip <name|number>         switch to that account (asks before closing Claude;');
  print('                                 --restart = no prompt, --force = swap without closing)');
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
  print('  keyflip clean [--logout]      reset keyflip data; --logout also signs out of');
  print('                                 Claude Code + the desktop app (asks to confirm)');
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

async function cmdSwitch(ctx, rest) {
  const arg = rest[0];
  if (!arg) return fail('usage: keyflip <name|number> [--restart|--force]');
  const autoYes = rest.indexOf('--restart') !== -1 || rest.indexOf('-y') !== -1 || rest.indexOf('--yes') !== -1;
  const force = rest.indexOf('--force') !== -1;
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
    await refreshIfNeeded();
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
  await refreshIfNeeded();
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

function cmdImport(ctx, rest) {
  const target = rest.filter(function (a) { return a.indexOf('--') !== 0; })[0];
  if (!target) return fail('usage: keyflip import <file|-> [--force]');
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
    print('Tools: keyflip_status, keyflip_list (include_usage), keyflip_switch, keyflip_next.');
    print('Mutating tools require confirm=true — the agent is instructed to ask the user first.');
    return;
  }
  logmod.log('mcp server started');
  return mcp.serve(ctx);
}

// Install the bundled agent skill into ~/.claude/skills so Claude Code learns
// when and how to drive keyflip.
function cmdInstallSkill(ctx) {
  const src = path.join(__dirname, '..', 'skills', 'keyflip');
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) return fail('bundled skill not found (reinstall keyflip)');
  const dest = path.join(ctx.home, '.claude', 'skills', 'keyflip');
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  print(style.ok('✅') + ' installed the keyflip skill to ' + dest);
  print('Claude Code will pick it up on the next session (it teaches account switching,');
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
  const appName = ctx.appDataDir ? appauth.activeProfileName(ctx) : null;
  const appEmail = appName ? (profiles.email(ctx.configDir, appName) || null) : null;
  const activeProvider = provider.readActive(ctx);
  jsonOut({
    cli: cliEmail ? { email: cliEmail } : null,
    app: appName ? { name: appName, email: appEmail } : null,
    provider: activeProvider ? activeProvider.name : null,
  });
  if (!JSON_MODE) {
    print('Claude Code: ' + (cliEmail || 'not logged in') +
      (ctx.appDataDir ? '   ·   Desktop app: ' + (appEmail || appName || 'unknown') : ''));
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
    if (r.needName) return fail("Couldn't auto-identify the app's account. Name it:  keyflip add <name> --app");
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
        'Name it yourself:  keyflip add <name> --app');
    }
    return fail('Nothing to capture. Log in in Claude first.' + (cliErr ? '\n(CLI: ' + cliErr + ')' : ''));
  }
  if (cliRes && appRes.needName) {
    print("↳ The desktop app is signed in but its account couldn't be identified. If it's a");
    print('  different account than the CLI, capture it with:  keyflip add <name> --app');
  }
  const anyIncomplete = profiles.list(ctx.configDir).some(function (n) { return capturedCliSafe(ctx, n) === false || !appauth.hasProfile(ctx, n); });
  if (anyIncomplete) print("Tip: 'keyflip list' shows what each account has captured ([cli|app]).");
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

  if (!hasSaved && !logout) { print('Nothing to clean — keyflip has no saved data.'); return; }

  const managesApp = !!ctx.appDataDir;
  print('This will:');
  if (hasSaved) {
    print("  • delete keyflip's saved data — accounts: " + (names.length ? names.join(', ') : 'none') +
      '; captured desktop logins: ' + appCount + '; backups: ' + backupCount + '; Keychain keyflip:*');
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
    print('  ✓ keyflip saved data removed.');
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

async function cmdList(ctx, rest) {
  const list = core.listProfiles(ctx);
  const appActive = ctx.appDataDir ? appauth.activeProfileName(ctx) : null;
  const withUsage = (rest || []).indexOf('--usage') !== -1;
  let infos = null;
  if (withUsage && list.length) {
    const activeEntry = list.filter(function (e) { return e.active; })[0];
    infos = await usagemod.usageForProfiles(ctx, list.map(function (e) { return e.name; }),
      { liveFor: activeEntry ? activeEntry.name : null, recordHistory: true });
  }
  if (JSON_MODE) {
    jsonOut({
      accounts: list.map(function (e) {
        return {
          index: e.index, name: e.name, email: e.email || null,
          cliCaptured: capturedCliSafe(ctx, e.name),
          appCaptured: appauth.hasProfile(ctx, e.name),
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
    list.forEach(function (e) {
      const cli = capturedCliSafe(ctx, e.name);
      const app = appauth.hasProfile(ctx, e.name);
      const now = [];
      if (e.active) now.push('CLI');
      if (e.name === appActive) now.push('app');
      let usageCol = '';
      if (infos) {
        const info = infos[e.name] || {};
        usageCol = '   [' + (info.status === 'ok' ? usagemod.fmt(info.usage) : (info.status || '?')) + ']';
      }
      print(' ' + (now.length ? '→' : ' ') + ' [' + e.index + '] ' + (e.email || e.name) +
        '   [cli ' + (cli === null ? '?' : (cli ? '✓' : '—')) + ' | app ' + (app ? '✓' : '—') + ']' + usageCol +
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
  const NO_NOTICE = ['menu', 'upgrade', 'clean', 'mcp', 'run', 'autoswitch', 'install-skill'];
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
      case 'mcp':
        return cmdMcp(ctx, rest);
      case 'install-skill':
        return cmdInstallSkill(ctx);
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
      case 'upgrade':
        return cmdUpgrade(ctx);
      case 'clean':
        return withLock(ctx, function () { return cmdClean(ctx, rest); });
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

module.exports = { main: main, usage: usage };
