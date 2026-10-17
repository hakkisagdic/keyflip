// Argument parsing + command dispatch. Thin wrapper over core/menu.
import fs from 'fs';
import path from 'path';
import { createContext } from './context.js';
import * as core from './core.js';
import * as claude from './claude.js';
import * as profiles from './profiles.js';
import * as appctl from './platform.js';
import * as appsessions from './appsessions.js';
import * as appauth from './appauth.js';
import * as lock from './lock.js';
import * as logmod from './log.js';
import * as oauth from './oauth.js';
import * as update from './update.js';
import * as transfer from './transfer.js';
import * as usagemod from './usage.js';
import * as verifymod from './verify.js';
import * as _switchplan from './switchplan.js';
import * as _switchfacts from './switchfacts.js';
import * as session from './session.js';
import * as links from './links.js';
import * as autosw from './autoswitch.js';
import * as provider from './provider.js';
import * as doctor from './doctor.js';
import * as history from './history.js';
import * as backup from './backup.js';
import * as share from './share.js';
import * as skill from './skill.js';
import * as mcpreg from './mcpreg.js';
import * as desktopgw from './desktopgw.js';
import * as importcreds from './importcreds.js';
import * as auditview from './auditview.js';
import * as cost from './cost.js';
import * as router from './router.js';
import * as sync from './sync.js';
import * as sessions from './sessions.js';
import * as mcp from './mcp.js';
import * as proxy from './proxy.js';
import * as uninstallmod from './uninstall.js';
import * as exec from './exec.js';
import * as loginmod from './login.js';
import * as _styleModule from './style.js';
import * as _browser from './browser.js';
import * as _cfg from './config.js';
import * as _svc from './autoswitchservice.js';
import * as _groups from './groups.js';
import * as _budget from './budget.js';
import * as _shellhook from './shellhook.js';
import * as _notify from './notify.js';
import * as _orchestrator from './orchestrator.js';
import * as _teampool from './teampool.js';
import * as _policy from './policy.js';
import * as _vault from './vault.js';
import * as _integrations from './integrations.js';
import * as _swarm from './swarm.js';
import * as _fleet from './fleet.js';
import * as _lic from './license.js';
import * as _tui from './tui.js';
import * as _brain from './brain.js';
import * as _codexbar from './codexbar.js';
import * as _surface from './surface.js';
import * as _agents from './agents.js';
import * as _migrate from './migrate.js';
import * as _qr from './qr.js';
import * as _lan from './lantransfer.js';
import * as _lanfleet from './lanfleet.js';
import * as _relayserver from './relayserver.js';
import * as _rt from './relaytransfer.js';
import * as _panel from './panel.js';
import * as _menubar from './menubar.js';
import * as _cowork from './cowork.js';
import * as _chat from './chat.js';
import * as _chatsession from './chatsession.js';
import * as _skillstore from './skillstore.js';
import * as _archive from './archive.js';
import * as _sessionmap from './sessionmap.js';
import * as attrib from './attrib.js';
import * as _threads from './threads.js';
import * as _schedule from './schedule.js';
import * as _settingsmod from './settings.js';
import * as _recall from './recall.js';
import * as _llm from './llm.js';
import * as _leakscan from './leakscan.js';
import * as _secretpolicy from './secretpolicy.js';
import * as _chains from './chains.js';
import * as _memory from './memory.js';
import * as _foreign from './foreign.js';
import * as _transcript from './transcript.js';
import * as _ctxsync from './ctxsync.js';
import * as _projctx from './projctx.js';
import * as _rules from './rulesmodel.js';
import * as _checkpoint from './checkpoint.js';
import * as _handoffmod from './handoff.js';
import * as _pii from './pii.js';
import * as _onboard from './onboard.js';
import * as _vcs from './vcs.js';
import * as _fsutil from './fsutil.js';
import _readline from 'readline';
import * as _provusage from './provusage.js';
import * as _sessionedit from './sessionedit.js';
import _child_process from 'child_process';
import * as _migrations from './migrations.js';
import * as _menu from './menu.js';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let style = _styleModule.make(process.stdout); // may be re-made in main() once config ui.color is known

// Serialize every mutation across processes (double-fired alias, launcher app
// racing a terminal, two menus) so a switch can never interleave with another.
async function withLock(ctx, fn, resource) {
  const l = await lock.acquire(ctx.configDir, resource ? { resource: resource } : undefined);
  let ok = false;
  try {
    const r = await fn();
    ok = true;
    return r;
  } finally {
    l.release();
    // H3: version every successful mutation (best-effort, secrets git-ignored). Single
    // funnel point — the command label is stashed on ctx by main().
    if (ok) {
      try {
        _vcs.autoCommit(ctx, ctx._vcsLabel || resource || 'update');
      } catch (e) {
        /* never break a mutation on versioning */
      }
    }
  }
}

let VERSION = '0.0.0';
try {
  VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
} catch (e) {
  /* ignore */
}

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
  try {
    return !!ctx.store.getProfile(name);
  } catch (e) {
    return null;
  }
}

function usage() {
  print('keyflip ' + VERSION + ' — switch between Anthropic / Claude Code accounts (macOS, Linux, Windows)');
  print('');
  print('  keyflip                       interactive menu (↑/↓ + Enter; [t] shows threads — read-only)');
  print('  keyflip onboard [--manual] [--sso] [--console]   full first-run: sign in per account →');
  print('                                 capture + point CLI + browser at it + sync chats, then ask for');
  print('                                 the next ("p" = add an API-key provider; --sso = enterprise SSO)');
  print('  keyflip setup                 lighter wizard: log in in Claude, keyflip auto-detects &');
  print('                                 captures each account (no browser drive)');
  print('  keyflip login [name] [--email x] [--fresh|--manual] [--sso] [--console]   sign in via the');
  print('                                 official flow and capture it (isolated — current login NOT');
  print('                                 disturbed; --fresh clears the browser first; --manual pastes');
  print('                                 the code/URL; --sso = enterprise SSO; --console = Console acct)');
  print('  keyflip logout [--browser] [--desktop] [--close]   sign OUT of the live session(s) — saved accounts kept');
  print('  keyflip add [name] [--app]    save the account(s) you are logged into — Claude Code');
  print('                                 AND the desktop app, auto-detected. Once per account.');
  print('                                 (--app: desktop app only; name it if undetected;');
  print('                                  --dry-run: show what WOULD be saved and touch nothing)');
  print('  keyflip <name|number>         switch to that account (asks before closing Claude;');
  print('                                 --restart = no prompt, --force = swap without closing,');
  print('                                 --browser = also align the browser + Chrome extension,');
  print('                                 --dry-run = show the plan and touch NOTHING; the switch');
  print('                                 then reads itself back (--no-verify skips that, and');
  print('                                 --rollback-on-fail puts the previous account back)');
  print('  keyflip next [--strategy best|next-available]');
  print('                                 rotate to the next account — or pick by remaining quota');
  print('  keyflip provider add <name> --base-url <url> [--key-file <f|->]');
  print('                                 save a 3rd-party endpoint (relay/gateway/Bedrock/OpenRouter)');
  print('  keyflip use <name>             route Claude Code to that provider (no restart);');
  print('                                 keyflip provider off = back to your subscription');
  print("  keyflip speedtest [name]       time a provider's endpoints, pick the fastest");
  print('  keyflip doctor [--history]    diagnose config, login and endpoint reachability');
  print('                                 (--history also scans every blob keyflip ever committed)');
  print("  keyflip test <provider>        fire one real request to check a provider's auth");
  print(
    '  keyflip chains [account] [--tighten [--apply]]   what each login is made of, who can renew each part, and what is stale/shared/world-readable',
  );
  print('  keyflip usage --history        per-account usage trend + autoswitch/failover events');
  print(
    '  keyflip usage --providers      usage/limits across OTHER AI tools (Codex/Gemini/Cursor/Copilot/OpenRouter…) — the multi-provider monitor',
  );
  print('  keyflip backup [now|list|restore <n>|prune]   snapshot keyflip metadata (no secrets)');
  print('  keyflip history | undo | restore <ref>   git-versioned config: see/undo/roll back changes');
  print('  keyflip versioning [on|off]   toggle auto-versioning (ON by default; secrets never committed)');
  print(
    '  keyflip scrub-history [--apply] [--include-tracked]   find (and remove) secrets still reachable in the state-repo history',
  );
  print(
    '  keyflip secrets [list|tolerate <path> [--kind K]|untolerate <path>]   which of those findings are EXPECTED (silences the alarm, never the clean-up)',
  );
  print('  keyflip share <name> [--no-secrets]   make a keyflip:// link; import with `keyflip import`');
  print('  keyflip mcpreg [add|list|enable|disable|import]   manage MCP servers across Claude Code + Desktop');
  print('  keyflip gateway use <provider> | off   route the Claude DESKTOP app through a provider gateway');
  print('  keyflip sync [push|pull|test] --url <webdav> --passphrase-file <f>   encrypted cross-device sync');
  print('  keyflip migrate export/import <file> [--passphrase-file <f>]   move ALL accounts+providers+');
  print('                                 session transcripts to a new machine and MERGE (also: push/pull --url)');
  print(
    '                                 add --agents (memory) / --agent-config (MCP+settings, redacted) for other AI agents',
  );
  print("  keyflip agents                 list other agents' memory + config keyflip can carry (Cursor/Gemini/Codex)");
  print(
    '  keyflip fleet init --dir <shared-folder> | discover | push | status | switch <machine> <acct> | send-account <acct> --to <machine> [--from <machine>] | collect | keys | trust <machine> | panel',
  );
  print('                                 discover = find keyflip machines on this LAN (no shared folder needed)');
  print(
    '                                 manage ALL your machines from one screen (encrypted shared folder): remote switch, collect/distribute accounts, chat status, signed origin-auth',
  );
  print(
    '  keyflip transfer serve [--receive] | pull [<host>] --code X | push <host> --code X   LIVE device-to-device over the LAN',
  );
  print('                                 add --qr to `serve` to show a scannable QR of the pairing code');
  print("  keyflip consolidate [--watch]  sync every account's chat index so each shows ALL conversations");
  print('  keyflip sessions [--search T] [--here]   browse Claude Code conversations (all accounts)');
  print("  keyflip sessions rebind <old-path> <new-path>   re-link a project's chat history after you");
  print('                                 renamed/moved its folder (transcripts + desktop-app records)');
  print('  keyflip sessions archive <id|--older-than 30d> | unarchive <id> | archived');
  print(
    '                                 move old transcripts into keyflip (gzipped) and back — declutter, reversible',
  );
  print("  keyflip sessions backups [--apply]      find rebind's .keyflip-bak duplicates; --apply removes only");
  print('                                 ones proven byte-identical AND re-landed under another project key');
  print('  keyflip sessions empty [--apply]        list project folders holding no files at all (--apply prunes;');
  print('                                 memory-only / sidecar-only keys are reported, never removed');
  print(
    '  keyflip sessions export <id> [--format md|html|json] [--out <file>]   export a chat as a clean, shareable doc',
  );
  print(
    "  keyflip foreign --list | <session-file> [--format md|html|json]   find/normalize ANOTHER agent's session (Cursor/opencode/Gemini/Qoder/Aider)",
  );
  print(
    '  keyflip sessions assign <id> <account>   continue a session AS another account (resume --run) — no profile switch',
  );
  print('  keyflip sessions attribute [--apply] [--min-confidence high|medium]  guess unassigned sessions from');
  print(
    "                                 keyflip's own switch timeline; --apply fills gaps only, never a stated assign",
  );
  print('  keyflip threads                  ONE name for the sessions that are the same task, across accounts');
  print('                                 (a thread stores POINTERS — ids/uuids — never a copy of your chat)');
  print('  keyflip threads create <slug> [--title "…"] | add <slug> <id> [--chat] [--account <name>]');
  print('  keyflip threads show <slug> [--timeline] [--md] [--mirror]   the whole thread as one merged view');
  print('  keyflip threads open <slug> [--run]   resume where the thread last stopped, as the account that owns it');
  print('  keyflip threads suggest            find work that is ALREADY split over 2+ accounts (no guessing ids)');
  print('  keyflip threads where <id> | remove <slug> <id> | drop <slug>   locate / unlink / forget the name');
  print('  keyflip sessions distill <id> [--to-claude]   summarize a chat into a durable keepsake (via `claude -p`)');
  print(
    '  keyflip sessions compact <id> [--apply]   shrink a transcript (elide bulky tool output; dry-run by default)',
  );
  print(
    "  keyflip memory [show <key>|audit [--apply|--drop-copies]]    browse keyflip's distilled keepsakes (audit = secret scan of them)",
  );
  print(
    '  keyflip recall "<query>" [--semantic] [--answer]   search your chats (BM25; --semantic = embeddings; --answer = `claude -p` synthesis)',
  );
  print(
    '  keyflip settings [show | get <k> | set <k> <v>]   view/edit ~/.claude/settings.json (rides `migrate` to other machines)',
  );
  print('  keyflip statusline install     show the active account + quota in the Claude Code prompt (status line)');
  print(
    '  keyflip panel [--open]         open a local web dashboard: accounts, quotas, providers, sessions, keepsakes',
  );
  print(
    '  keyflip menubar [--install]    menu-bar/tray plugin (macOS xbar/SwiftBar · Linux GNOME Argos/KDE kargos): glanceable account+quota, click-to-switch',
  );
  print('  keyflip dream [--older-than 30d] [--archive] [--apply]   consolidate old chats: distill (+ archive) them');
  print('  keyflip dream schedule [--at 03:00] | unschedule | status   run the dream nightly (launchd/cron)');
  print(
    '  keyflip resume <n|id> [--run] [--as <account>]   resume a session (in its dir; --as runs it under another account)',
  );
  print(
    '  keyflip send <id> "<message>" [--as <account>] [--fork]   inject a message into a session (steer/continue it headlessly)',
  );
  print('  keyflip cowork [--search T]    browse Claude desktop Cowork sessions (all accounts)');
  print('  keyflip chat [--as <acct>] [--limit N]        list claude.ai Chat (experimental)');
  print(
    '  keyflip chat get <short-id|title> [--as <acct>]  read one cloud conversation  (--flush: close/reopen the app to get a fresh cookie)',
  );
  print('  keyflip chat search "<words>" [--as <acct>]      find a cloud chat by title');
  print('  keyflip browser [status|logout|capture|sync]  BROWSER claude.ai account: capture saves it under an');
  print('                                 account (so `keyflip chat --as` can read it), sync restores one;');
  print('                                 logout clears it — the Chrome extension inherits this session');
  print('  keyflip skill add <owner/repo|./dir|file.tgz>   install a skill; also: skill list|remove');
  print('  keyflip proxy start [--wire] | stop | status | stats');
  print('                                 command-started failover proxy (429/5xx → next account)');
  print('  keyflip status                which account each surface is on (CLI + desktop app)');
  print('  keyflip verify [acct] [--usage|--live]  would switching there WORK right now? reads each');
  print('                                 surface back the way its own app does (token/cookie expiry, capture age)');
  print('  keyflip refresh [acct|--all]  revive stored OAuth tokens while no Claude is running them');
  print('                                 (run it on a schedule, not at switch time)');
  print('  keyflip refresh --schedule [--at 04:30] | --unschedule | --schedule-status');
  print('                                 put `refresh --all` on a nightly timer (launchd/cron): tokens');
  print('                                 expire on the calendar, not on the day you happen to switch');
  print('  keyflip list [--usage]        saved accounts; --usage adds 5h/7d quota per account');
  print('  keyflip remove <name|number>  delete a saved account');
  print('  keyflip autoswitch            watch usage; auto-swap the CLI account at a threshold');
  print('                                 (--threshold 90 --interval 60 --strategy next-available)');
  print('  keyflip autoswitch install [--interval 300]   run it UNATTENDED (launchd/cron) — no terminal to keep open');
  print(
    '                                 keyflip autoswitch <status|uninstall|--once>   check/stop the service; --once = one tick',
  );
  print('  keyflip link [name|--remove]  map this directory to an account for `run`');
  print(
    '  keyflip shell-init <bash|zsh|fish>   print a shell hook so `cd` auto-activates the pinned account (eval "$(keyflip shell-init zsh)")',
  );
  print(
    '  keyflip group [list|members <g>|tag <acct> <g…>|untag <acct> <g>]   tag accounts into pools; `next --group <g>` rotates within one',
  );
  print('  keyflip budget [status|set <acct> --5h N --7d N|clear <acct>]   usage ceilings + breach/near-breach alerts');
  print(
    '  keyflip llm [status|set --provider claude|ollama|openai [--model M] [--base-url U] [--key-env NAME]|test [--timeout ms]|off]   what runs dream/distill/recall, and whose quota it burns (keys are named, never stored)',
  );
  print(
    '  keyflip notify [status|set --webhook URL --events a,b,c|test|off]   push alerts on quota/switch/fleet-reply',
  );
  print(
    '  keyflip import-env [<file>] [--dry-run] [--env]   import provider endpoints from a .env file / the environment',
  );
  print('  keyflip log [--tail N] [--grep S] [--since ISO]   view the action/audit log');
  print(style.dim('  — orchestration / strategic layer —'));
  print(
    '  keyflip run-job "<prompt>" [--group g] [--strategy best]   run a prompt HEADLESS on the best-headroom account (isolated)',
  );
  print(
    '  keyflip jobs [list|run|clear] · keyflip fanout "<prompt>" --accounts a,b,c   job queue + same prompt across N accounts',
  );
  print('  keyflip cost [status|predict <acct>|by-project]   spend/utilization, time-to-limit, per-repo attribution');
  print(
    '  keyflip team <publish|pull|members|add-member|remove-member> --dir <shared> --pool <n> --passphrase-file <f>   encrypted team pool (roles)',
  );
  print(
    '  keyflip policy <list|allow|deny|remove|default|check> [--cwd D --account A]   constrain which account a directory may use',
  );
  print('  keyflip vault <status|use op|bw|vault|off>   store credentials in 1Password / Bitwarden / HashiCorp Vault');
  print(
    '  keyflip route <list|set <model> <provider>|clear|arbitrage on|off> · keyflip cache <status|purge>   model routing/arbitrage + response cache',
  );
  print('  keyflip post --to <webhook> [--status]   post status/events to a Slack/Discord/generic webhook');
  print(
    '  keyflip swarm <run|ping|drain --allow-exec|results|trust <machine>>   run a command across YOUR OWN enrolled fleet machines',
  );
  print('  keyflip config <get <key>|set <key> <val>|list|unset <key>>   centralized settings');
  print(
    '  keyflip surfaces [list]   detect which AI tools (Cursor/Gemini/Codex/Copilot/opencode/Aider) are present + their active account',
  );
  print(style.dim('  — context layer (portable project memory in .keyflip/) —'));
  print(
    '  keyflip context <init|status|show|decision add|task add|task set <id> <status>>   tool-independent project memory that travels with the repo',
  );
  print(
    '  keyflip context sync <status|mode <local|git|encrypted|company>|export|check>   what MAY leave the machine for a shared .keyflip/ package',
  );
  print(
    "  keyflip rules <show|import|emit --to claude|cursor|agents|gemini [--write]>   normalize this project's AI rule files into one model, re-emit per tool",
  );
  print('  keyflip checkpoint <list|create --summary "…"|latest|show <id>>   git-bound session-boundary snapshots');
  print(
    '  keyflip handoff [--to <claude|cursor|kiro|opencode|windsurf|generic>]   print a CONTINUE-PROMPT so a NEW tool can resume this project',
  );
  print(
    '  keyflip ui                    full-screen TUI: accounts, provider usage (u), fleet (f), + a command PALETTE (p) — no commands to memorize',
  );
  print(
    '  keyflip codexbar              bridge to a locally-installed CodexBar usage monitor (aligns tracked providers; reads no secrets)',
  );
  print(
    '  keyflip brain "<intent>"      OPT-IN: plain-language intent → a proposed plan of keyflip steps you approve one-by-one',
  );
  print(
    '                                 (needs KEYFLIP_BRAIN=1 + GEMINI_API_KEY; only PROPOSES — never runs anything on its own)',
  );
  print('  keyflip license <status|activate <file>>   offline license (open-core; paid tiers)');
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
    const rl = _readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    let muted = false;
    const realWrite = rl._writeToOutput ? rl._writeToOutput.bind(rl) : null;
    rl._writeToOutput = function (s) {
      if (muted) {
        process.stderr.write('*');
      } else if (realWrite) {
        realWrite(s);
      }
    };
    process.stderr.write(question);
    muted = true;
    rl.question('', function (a) {
      muted = false;
      process.stderr.write('\n');
      rl.close();
      resolve(a || '');
    });
  });
}

function confirm(question) {
  return new Promise(function (resolve) {
    // Prompt goes to stderr so it never pollutes stdout (keeps the --json contract:
    // stdout carries only the single JSON object).
    const rl = _readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, function (a) {
      rl.close();
      resolve(/^y(es)?$/i.test((a || '').trim()));
    });
  });
}

// Read one line with the echo muted, reusing an EXISTING readline interface — so we
// never open a second reader on the same stdin (which would fight the caller's rl).
// Needs a terminal; callers (the onboard wizard) already guard on process.stdin.isTTY.
function askHidden(rl, question) {
  return new Promise(function (resolve) {
    const realWrite = rl._writeToOutput ? rl._writeToOutput.bind(rl) : null;
    let muted = false;
    rl._writeToOutput = function (s) {
      if (muted) {
        process.stderr.write('*');
      } else if (realWrite) {
        realWrite(s);
      }
    };
    process.stderr.write(question);
    muted = true;
    rl.question('', function (a) {
      muted = false;
      rl._writeToOutput = realWrite;
      process.stderr.write('\n');
      resolve(a || '');
    });
  });
}

// ---- #38 SWITCH PREFLIGHT ---------------------------------------------------------------------
// The facts live in src/switchfacts.js (shared with the MCP switch tool, so an agent and a terminal
// read the same machine); everything below is the rendering and the recovery, which belong to the CLI.
const SWITCH_MODE_LABEL = {
  'already-active': 'nothing to do — this account is already active on every surface keyflip can see',
  'app-only': 'the CLI is already on this account; only the desktop app login would move',
  restart: 'full switch: Claude is quit, the logins move, Claude reopens',
  'in-place': 'full switch WITHOUT closing Claude (--force) — the app can still fight it',
  plain: 'full switch while Claude is closed',
  refuse: 'BLOCKED — this switch would not run as things stand',
};

// Render the plan. The labels are literal ("write:" / "skip:" / "warn:" / "block:") so `--dry-run`
// output is greppable and testable, and because a plan you have to interpret is a plan you distrust.
async function dryRunReport(ctx, name, em, opts) {
  const f = await _switchfacts.collect(ctx, name, opts);
  const plan = _switchplan.build(f, opts);
  print(
    style.bold('dry run') +
      ' — ' +
      style.dim('nothing was changed') +
      '  target: ' +
      style.bold(em || name) +
      '  ' +
      style.dim('(profile: ' + name + ')'),
  );
  print('  ' + (SWITCH_MODE_LABEL[plan.mode] || plan.mode));
  if (f.targetState)
    print(
      '  ' +
        style.dim('target reads as') +
        ': ' +
        (f.targetState === 'ok'
          ? style.ok(verifymod.HEADLINE[f.targetState])
          : f.targetState === 'warn'
            ? style.warn(verifymod.HEADLINE[f.targetState])
            : f.targetState === 'fail'
              ? style.err(verifymod.HEADLINE[f.targetState])
              : style.dim(verifymod.HEADLINE[f.targetState])) +
        (f.targetDetail ? ' — ' + f.targetDetail : ''),
    );
  plan.writes.forEach(function (w) {
    print('  ' + style.ok('write:') + ' ' + w);
  });
  plan.skips.forEach(function (s) {
    print('  ' + style.dim('skip:') + '  ' + s);
  });
  plan.warns.forEach(function (w) {
    print('  ' + style.warn('warn:') + '  ' + w);
  });
  plan.blockers.forEach(function (b) {
    print('  ' + style.err('block:') + '  ' + b);
  });
  if (plan.needsConfirm)
    print(
      '  ' +
        style.dim(
          'note:  this switch closes Claude, so the real run asks you to confirm first (--restart answers it).',
        ),
    );
  if (JSON_MODE)
    jsonOut({
      dryRun: true,
      target: name,
      email: em || null,
      mode: plan.mode,
      verify: { state: f.targetState, detail: f.targetDetail, checks: f.targetChecks },
      plan: {
        writes: plan.writes,
        skips: plan.skips,
        warns: plan.warns,
        blockers: plan.blockers,
        wouldQuit: plan.wouldQuit,
      },
    });
  else print(style.dim('  ↳ run the same command without --dry-run to actually switch.'));
  return plan.mode === 'refuse' ? 1 : 0;
}

// Put the machine back as far as keyflip CAN. `keyflip undo` does not apply here: it reverts the
// metadata git repo and never touches a credential store, so the only recovery is to switch back the
// way a switch works. Restoring the app login needs Claude closed, so it is quit and reopened — only
// on a platform where keyflip can do that; otherwise the CLI is restored and the user is told exactly
// what is left.
async function rollbackToPrevious(ctx, scope, targetName) {
  const done = { cli: null, app: null, notes: [] };
  if (scope.cli) {
    const emPrev = profiles.email(ctx.configDir, scope.cli);
    const did = core.performSwitch(ctx, scope.cli);
    done.cli = scope.cli;
    print(
      '  ↳ rolled the CLI back to ' +
        (emPrev || scope.cli) +
        (did && did.cli ? '' : ' (no captured login for it — best effort)'),
    );
  }
  if (scope.app) {
    let quitForThis = false;
    if (appctl.isClaudeRunning(ctx.platform) && appctl.canManageApp(ctx.platform)) {
      print('Quitting Claude to restore its login...');
      appctl.quitClaude(ctx.platform);
      await waitForQuit(ctx);
      quitForThis = true;
    }
    if (appctl.isClaudeRunning(ctx.platform)) {
      done.notes.push(
        "the desktop app is still on '" + targetName + "' — quit Claude and run: keyflip " + scope.app + ' --restart',
      );
    } else {
      const a = switchDesktopLogin(ctx, scope.app);
      if (a && a.ok) {
        done.app = scope.app;
        print('  ↳ rolled the desktop app login back to ' + scope.app + '.');
      } else done.notes.push('the desktop app login could not be restored (' + ((a && a.reason) || 'failed') + ')');
    }
    if (quitForThis) appctl.openClaude(ctx.platform);
  }
  return done;
}

async function cmdSwitch(ctx, rest) {
  const arg = rest[0];
  if (!arg)
    return fail(
      'usage: keyflip <name|number> [--restart|--force] [--browser] [--dry-run] [--no-verify] [--rollback-on-fail]',
    );
  const autoYes = rest.indexOf('--restart') !== -1 || rest.indexOf('-y') !== -1 || rest.indexOf('--yes') !== -1;
  const force = rest.indexOf('--force') !== -1;
  const syncBrowser = rest.indexOf('--browser') !== -1;
  // #38: --dry-run plans without touching anything; --no-verify skips the read-back that every switch
  // does by default; --rollback-on-fail opts into putting the previous account back when that
  // read-back says the switch did not produce a usable machine. (NOT --force, which already means
  // "swap in place without closing the app".)
  const dryRun = rest.indexOf('--dry-run') !== -1 || rest.indexOf('--plan') !== -1;
  const noVerify = rest.indexOf('--no-verify') !== -1;
  const rollbackOnFail = rest.indexOf('--rollback-on-fail') !== -1;
  const name = core.resolveProfile(ctx, arg);
  if (!name) return fail("no such profile: '" + arg + "' (see: keyflip list)");
  const em = profiles.email(ctx.configDir, name);

  // What was live BEFORE anything is written. This snapshot is the only recovery path there is —
  // `keyflip undo` reverts the metadata git repo, never a credential store — so it has to be taken
  // first, and it is what --rollback-on-fail works from.
  let prevCli = null;
  let prevApp = null;
  try {
    const curEmail = core.currentEmail(ctx);
    if (curEmail)
      profiles.list(ctx.configDir).forEach(function (n) {
        if (!prevCli && profiles.email(ctx.configDir, n) === curEmail) prevCli = n;
      });
  } catch (e) {
    /* best-effort: a rollback simply won't be offered */
  }
  try {
    prevApp = appActiveProfile(ctx);
  } catch (e) {
    /* ditto */
  }

  if (dryRun) return await dryRunReport(ctx, name, em, { autoYes: autoYes, force: force, browser: syncBrowser });

  // Did THIS switch reopen the desktop app? Only then is it worth waiting to see whether
  // the app came back signed in (see verifyAppRelogin).
  let appReopened = false;
  if (em && em === core.currentEmail(ctx)) {
    // "Already active" has to mean BOTH surfaces. The desktop app keeps its own
    // independent login, so a hand sign-in inside the app moves only the app while
    // the CLI still reads as active — that is a real pending switch, not a no-op.
    const appNow = appActiveProfile(ctx);
    if (appNow === null || appNow === name || !appauth.hasProfile(ctx, name)) {
      print("'" + em + "' is already active.");
      jsonOut({ alreadyActive: { name: name, email: em } });
      return;
    }
    print(
      '  ↳ the CLI is already on this account, but the desktop app is on ' +
        (appNow || "another account keyflip hasn't saved") +
        ' — switching the app login.',
    );
    const appRunning = appctl.isClaudeRunning(ctx.platform);
    if (appRunning) {
      if (!appctl.canManageApp(ctx.platform))
        return fail('Claude is open — close it first (it cannot be auto-closed on this OS), or --force.');
      if (!autoYes) {
        if (!process.stdin.isTTY)
          return fail('Claude is open. Re-run with --restart to close & reopen it, or quit it yourself first.');
        const ok = await confirm('Claude is open and will be closed to switch its login. Continue? [y/N] ');
        if (!ok) {
          print('Cancelled — nothing was changed.');
          return;
        }
      }
      print('Quitting Claude...');
      appctl.quitClaude(ctx.platform);
      await waitForQuit(ctx);
      // isClaudeRunning() also counts Claude *Code* CLI processes, so a busy terminal can
      // make the wait time out while the desktop app is still up. Ask the right question:
      // if the app itself is still alive, its login files are locked — say so instead of
      // failing with a bare "(failed)".
      if (appctl.isDesktopAppRunning(ctx.platform)) {
        return fail('Claude Desktop did not close, so nothing was changed — quit it with Cmd+Q and re-run.');
      }
    }
    preserveOutgoingAppLogin(ctx);
    const lagApp = switchDesktopLogin(ctx, name);
    const lagCons = consolidateAndReport(ctx);
    if (appRunning) {
      print('Reopening Claude...');
      appctl.openClaude(ctx.platform);
      appReopened = true;
    }
    if (!lagApp.ok) {
      return fail("the desktop app's login could not be switched (" + (lagApp.reason || 'failed') + ').');
    }
    print(style.ok('✅') + ' Switched to: ' + (em || name));
    await emitSwitched({ cli: false }, lagApp, lagCons);
    return;
  }
  // Policy engine: block a switch this directory isn't allowed to use (no-op until rules exist).
  if (!force) {
    try {
      _policy.enforce(ctx, { cwd: process.cwd(), account: name });
    } catch (e) {
      if (e && e.code === 'POLICY_DENIED') return fail(e.message + '  (override with --force)');
      throw e;
    }
  }
  logmod.log('switch requested -> ' + name);

  const running = appctl.isClaudeRunning(ctx.platform);
  const manage = appctl.canManageApp(ctx.platform);

  async function refreshIfNeeded() {
    const r = await oauth.maybeRefreshProfile(ctx, name, {
      isRunning: function () {
        return appctl.isClaudeRunning(ctx.platform);
      },
      instances: function () {
        return appctl.claudeInstances(ctx.home);
      },
    });
    if (r.status === 'refreshed') print('  ↳ refreshed the saved OAuth token (was expiring).');
    else if (r.status === 'refresh-failed')
      print('  ⚠️ the saved token is expiring and could not be refreshed — you may be asked to log in.');
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
          if (synced.length)
            print(
              '  ' +
                style.ok('↳') +
                ' synced the browser (' +
                synced.join(', ') +
                ') to this account — the Claude extension reconnects.',
            );
          else
            print(
              '  ' +
                style.dim(
                  '↳ no saved browser session for this account yet — capture one via `keyflip onboard`/`login` while the browser is signed into it.',
                ),
            );
        } else {
          const browser = _browser;
          const meta = profiles.read(ctx.configDir, name) || {};
          const wantOrg = meta.oauthAccount && meta.oauthAccount.organizationUuid;
          if (wantOrg)
            browser.installed(ctx.home).forEach(function (b) {
              const ck = browser.readClaudeCookies(b, {});
              if (ck && ck.org && ck.org !== wantOrg) {
                print(
                  '  ' +
                    style.warn('⚠') +
                    ' ' +
                    b.name +
                    " claude.ai is a different account — the Claude browser extension won't connect here.",
                );
                print(
                  '     Fix: ' +
                    style.bold('keyflip ' + name + ' --browser') +
                    ' to auto-sync it, or ' +
                    style.bold('keyflip browser logout') +
                    ' and sign in as ' +
                    (em || name) +
                    '.',
                );
              }
            });
        }
      } catch (e) {
        /* best-effort — never block a switch on this */
      }
    }
    // Did the app come back signed in? A saved session cookie the server has since
    // rotated leaves Claude on its sign-in screen after a switch that looked clean.
    let relogin = null;
    if (appReopened && appl && appl.ok) relogin = await verifyAppRelogin(ctx);
    if (relogin === false) {
      print(
        '  ' +
          style.warn('⚠') +
          " Claude reopened on its SIGN-IN screen: the saved session for '" +
          name +
          "' is no longer accepted by claude.ai.",
      );
      print(
        '     Fix: sign in once in Claude as ' +
          (em || name) +
          ' — the CLI, browser and captures stay switched — then refresh the capture: ' +
          style.bold('keyflip add ' + name),
      );
    }
    // ---- #38 read-back: prove the switch landed, instead of trusting that the writes returned ok.
    // Re-read the account we just moved to the way its own tools do (verify.js), and compare the CLI
    // credential on disk against the email it should now be. Observation only unless the user asked
    // for --rollback-on-fail.
    let vb = null;
    let cliNow = null;
    if (!noVerify) {
      try {
        const r = await verifymod.verifyAccount(ctx, name, {
          liveAccount: name, // the machine is supposed to BE on this account now
          currentEmail: function (c) {
            return core.currentEmail(c);
          },
        });
        vb = verifymod.brief(r);
        vb.checks = r.checks;
      } catch (e) {
        vb = null; // a broken verifier must never fail a switch that already worked
      }
      try {
        cliNow = core.currentEmail(ctx) || null;
      } catch (e) {
        cliNow = null;
      }
    }
    const cliMismatch = !!(em && cliNow && cliNow.toLowerCase() !== em.toLowerCase());
    if (!JSON_MODE && vb) {
      if (vb.state === 'ok' && !cliMismatch)
        print(
          '  ' +
            style.ok('✓') +
            ' ' +
            style.dim('verified: ' + vb.headline + (cliNow ? ' — the CLI reads as ' + cliNow : '')),
        );
      else {
        print(
          '  ' +
            (vb.state === 'warn' ? style.warn('·') : style.err('✗')) +
            ' read-back: ' +
            vb.headline +
            (vb.detail ? ' — ' + vb.detail : ''),
        );
        (vb.checks || [])
          .filter(function (c) {
            return c.state === 'fail' || c.state === 'warn';
          })
          .slice(0, 3)
          .forEach(function (c) {
            print(
              '      ' +
                (c.state === 'fail' ? style.err('✗') : style.warn('·')) +
                ' ' +
                c.name +
                (c.detail ? ' — ' + c.detail : ''),
            );
          });
      }
      if (cliMismatch)
        print(
          '  ' +
            style.err('✗') +
            ' the CLI credential on disk is ' +
            cliNow +
            ', not ' +
            em +
            ' — the switch did not land.',
        );
    }
    const scope = _switchplan.rollbackScope(
      {
        cli: prevCli,
        app: prevApp,
        target: name,
        appCaptured: !!prevApp && appauth.hasProfile(ctx, prevApp),
      },
      { cli: !!(did && did.cli), app: !!(appl && appl.ok) },
    );
    const dec = _switchplan.shouldRollback(
      { scope: scope, state: vb && vb.state, detail: vb && vb.detail, appSignedIn: relogin, cliMismatch: cliMismatch },
      { rollbackOnFail: rollbackOnFail },
    );
    let rolledBack = null;
    if (dec.do) {
      print('  ' + style.warn('↩') + ' rolling back: ' + dec.reason + '.');
      rolledBack = await rollbackToPrevious(ctx, scope, name);
      rolledBack.notes.forEach(function (n) {
        print('  ' + style.warn('⚠') + ' ' + n);
      });
      if (!rolledBack.cli && !rolledBack.app) print('  ' + style.err('✗') + ' nothing could be restored.');
      else print('  ' + style.dim('the switch was reverted as far as keyflip can — see the lines above.'));
    } else if (rollbackOnFail && dec.reason) print('  ' + style.warn('⚠') + ' not rolled back: ' + dec.reason + '.');
    jsonOut({
      switched: { name: name, email: em || null },
      cliSwitched: !!(did && did.cli),
      appSwitched: !!(appl && appl.ok),
      appSignedIn: relogin === null ? undefined : relogin,
      sessionsShared: (cons && cons.merged) || 0,
      verified: vb ? { state: vb.state, headline: vb.headline, detail: vb.detail || null } : null,
      cliEmailAfterSwitch: cliNow || undefined,
      rolledBackTo: rolledBack ? { cli: rolledBack.cli, app: rolledBack.app, notes: rolledBack.notes } : undefined,
    });
    // Opt-in switch notification — a no-op unless the user configured notify for the 'switch'
    // event (and a sink). Guarded + secret-stripped inside send(); never block a switch on it.
    try {
      await _notify.send(ctx, 'switch', { to: name, cli: !!(did && did.cli), app: !!(appl && appl.ok) });
    } catch (e) {
      /* notify must never affect the switch */
    }
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
      print(
        '  ' +
          style.warn('⚠') +
          ' Claude Desktop is running on a different account (' +
          tug.appLabel +
          ') and may rewrite this CLI login back to it.',
      );
      print(
        '     To make the switch stick: ' +
          style.bold('keyflip ' + name + ' --restart') +
          '  (moves the app too), or quit Claude Desktop.',
      );
    }
    // #4: keep chats in sync across accounts. If only the CLI is up (desktop app
    // closed) this syncs now; if the app is open its store is locked, so defer.
    const cons = consolidateAndReport(ctx);
    if (cons && cons.reason)
      print(
        '  ↳ ' +
          style.dim('chats will sync across accounts once Claude Desktop is closed (or run `keyflip consolidate`).'),
      );
    await emitSwitched(did, null, null);
    return;
  }
  // App is open and we can close it: confirm, then close -> switch -> reopen.
  if (running && manage) {
    if (!autoYes) {
      if (!process.stdin.isTTY) {
        return fail(
          'Claude / Claude Code is open. Re-run with --restart to close & reopen it, ' +
            '--force to switch without closing, or quit it yourself first.',
        );
      }
      const ok = await confirm('Claude / Claude Code is open and will be closed to switch. Continue? [y/N] ');
      if (!ok) {
        print('Cancelled — nothing was changed.');
        return;
      }
    }
    print('Quitting Claude...');
    appctl.quitClaude(ctx.platform);
    await waitForQuit(ctx);
    await refreshIfNeeded();
    const did = core.performSwitch(ctx, name);
    if (!did.cli) print("  ↳ CLI login for this profile isn't captured — switched the desktop app only.");
    preserveOutgoingAppLogin(ctx);
    const appl = switchDesktopLogin(ctx, name);
    const cons = consolidateAndReport(ctx);
    print('Reopening Claude...');
    appctl.openClaude(ctx.platform);
    appReopened = true;
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
    return fail(
      'Claude / Claude Code is open — close it first (it cannot be auto-closed on this OS), or re-run with --force.',
    );
  }
  // Not running: just swap.
  await refreshIfNeeded();
  const did = core.performSwitch(ctx, name);
  if (!did.cli) print("  ↳ CLI login for this profile isn't captured — switched the desktop app only.");
  preserveOutgoingAppLogin(ctx);
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
  list.forEach(function (e, i) {
    if (e.active) idx = i;
  });
  // candidates in rotation order, starting right after the active account
  const candidates = [];
  for (let k = 1; k <= list.length; k++) {
    const e = list[(idx + k) % list.length];
    if (!e.active) candidates.push(e);
  }
  // --group <g>: scope rotation to a pool (keyflip group tag …). Preserves rotation order.
  const gi = rest.indexOf('--group');
  if (gi !== -1 && rest[gi + 1]) {
    const grp = rest[gi + 1];
    const scoped = _groups.filterProfiles(ctx, candidates, grp);
    if (!scoped.length)
      return fail(
        "no other account in group '" + grp + "' to rotate to (tag one: keyflip group tag <account> " + grp + ')',
      );
    candidates.length = 0;
    Array.prototype.push.apply(candidates, scoped);
  }
  if (!candidates.length) return fail('no other account to rotate to');

  const si = rest.indexOf('--strategy');
  const strategy = si !== -1 ? rest[si + 1] : null;
  let target = candidates[0];
  if (strategy) {
    if (strategy !== 'best' && strategy !== 'next-available') {
      return fail("unknown strategy '" + strategy + "' — use: best | next-available");
    }
    const infos = await usagemod.usageForProfiles(
      ctx,
      candidates.map(function (e) {
        return e.name;
      }),
      {},
    );
    const picked = usagemod.pickByStrategy(candidates, infos, strategy);
    if (!picked) return fail("no account matches strategy '" + strategy + "' (usage unknown or all rate-limited)");
    target = picked;
    const info = infos[target.name];
    print(
      'Rotating to: ' +
        (target.email || target.name) +
        (info && typeof info.headroom === 'number'
          ? '  (' + usagemod.fmt(info.usage) + ', headroom ' + Math.round(info.headroom) + '%)'
          : ''),
    );
  } else {
    print('Rotating to: ' + (target.email || target.name));
  }
  // Forward the switch-relevant flags (incl. single-dash -y) so `next -y` doesn't
  // re-prompt; drop --strategy (already consumed here).
  const SWITCH_FLAGS = ['-y', '--yes', '--restart', '--force'];
  const forward = rest.filter(function (a, i) {
    if (rest[i - 1] === '--group') return false; // the group NAME value, not a flag
    return SWITCH_FLAGS.indexOf(a) !== -1 || (a.indexOf('--') === 0 && a !== '--strategy' && a !== '--group');
  });
  return cmdSwitch(ctx, [target.name].concat(forward));
}

// Backup / machine migration: a versioned envelope of saved accounts.
function cmdExport(ctx, rest) {
  const target =
    rest.filter(function (a) {
      return a.indexOf('--') !== 0;
    })[0] || 'keyflip-export.json';
  const r = transfer.buildExport(ctx);
  if (!r.envelope.accounts.length) {
    return fail(
      'nothing to export' + (r.skipped.length ? ' (credentials unreadable for: ' + r.skipped.join(', ') + ')' : ''),
    );
  }
  const json = JSON.stringify(r.envelope, null, 2);
  if (target === '-') process.stdout.write(json + '\n');
  else {
    fs.writeFileSync(target, json + '\n', { mode: 0o600 });
    // writeFileSync's mode does NOT tighten a pre-existing file — chmod explicitly
    // so an export never inherits a looser (world/group-readable) prior mode.
    try {
      fs.chmodSync(target, 0o600);
    } catch (e) {
      /* non-POSIX FS */
    }
    print('💾 exported ' + r.envelope.accounts.length + " account(s) to '" + target + "'.");
  }
  r.skipped.forEach(function (n) {
    print('  ⚠️ skipped (credentials unreadable): ' + n);
  });
  print(
    style.warn('⚠️  The export CONTAINS LOGIN SECRETS') +
      ' — store it safely (or pipe through gpg) and delete it after importing.',
  );
  print('   Desktop-app logins are machine-bound and not included — run keyflip add on the new machine.');
  logmod.log('export: ' + r.envelope.accounts.length + ' account(s)');
}

async function cmdImport(ctx, rest) {
  const target = rest.filter(function (a) {
    return a.indexOf('--') !== 0;
  })[0];
  if (!target) return fail('usage: keyflip import <file|-|keyflip://…> [--force]');
  // #11: a keyflip:// share link — decode, PREVIEW, confirm, apply.
  if (/^keyflip:\/\//.test(target)) {
    let parsed;
    try {
      parsed = share.parse(target);
    } catch (e) {
      return fail(e.message);
    }
    print('This link will import:');
    print('  ' + share.preview(parsed).replace(/\n/g, '\n  '));
    if (rest.indexOf('--force') === -1) {
      if (!process.stdin.isTTY) return fail('importing a share link non-interactively requires --force');
      const ok = await confirm('Import it? [y/N] ');
      if (!ok) {
        print('Cancelled.');
        return;
      }
    }
    const r = share.apply(ctx, parsed);
    print(style.ok('✅') + ' imported ' + r.resource + ' "' + r.name + '"' + (r.note ? '\n  ↳ ' + r.note : ''));
    jsonOut({ imported: r });
    return;
  }
  let raw;
  try {
    raw = target === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(target, 'utf8');
  } catch (e) {
    return fail('cannot read ' + target + ': ' + e.message);
  }
  let env;
  try {
    env = JSON.parse(raw);
  } catch (e) {
    return fail('that file is not valid JSON');
  }
  const r = transfer.applyImport(ctx, env, { force: rest.indexOf('--force') !== -1 });
  print(style.ok('✅') + ' imported: ' + (r.imported.join(', ') || '(none)'));
  if (r.skipped.length) print('  ↳ already present, skipped (use --force to overwrite): ' + r.skipped.join(', '));
  logmod.log('import: ' + r.imported.length + ' account(s)');
}

// Watch the active account and auto-switch the CLI credential at a usage
// threshold (claude-swap PR #76 / issues #38, #50). The desktop app is never
// closed; Claude Code picks the new credential up on its next request.
async function cmdAutoswitch(ctx, rest) {
  function numFlag(flag, dflt) {
    const i = rest.indexOf(flag);
    const v = i !== -1 ? parseInt(rest[i + 1], 10) : NaN;
    return isNaN(v) ? dflt : v;
  }
  // Defaults come from the stored config when a flag isn't given, so these settings aren't
  // advertised-but-inert: `keyflip config set autoswitch.<threshold|strategy|group> …`.
  const cfg = _cfg;
  const threshold = Math.min(100, Math.max(50, numFlag('--threshold', cfg.get(ctx, 'autoswitch.threshold'))));
  const interval = Math.max(30, numFlag('--interval', 60));
  const si = rest.indexOf('--strategy');
  const strategy = si !== -1 ? rest[si + 1] : cfg.get(ctx, 'autoswitch.strategy') || 'next-available';
  if (strategy !== 'best' && strategy !== 'next-available')
    return fail('unknown strategy — use: best | next-available');
  const gi = rest.indexOf('--group');
  const group = gi !== -1 && rest[gi + 1] ? rest[gi + 1] : cfg.get(ctx, 'autoswitch.group') || '';

  // One tick's print + opt-in notify, shared by the foreground loop and the scheduled `--once` run.
  function reportTick(r) {
    const at = new Date().toTimeString().slice(0, 8);
    if (r.state === 'switched') {
      print(
        '[' +
          at +
          '] ' +
          style.ok('⇄ switched: ') +
          (r.active.email || r.active.name) +
          ' → ' +
          (r.switchedTo.email || r.switchedTo.name) +
          ' (usage crossed ' +
          threshold +
          '%)',
      );
      logmod.log('autoswitch: ' + r.active.name + ' -> ' + r.switchedTo.name);
      _notify
        .send(ctx, 'switch', { from: r.active.name, to: r.switchedTo.name, reason: 'autoswitch', threshold: threshold })
        .catch(function () {});
    } else if (r.state === 'below') {
      print('[' + at + '] ' + (r.active.email || r.active.name) + ': ' + Math.round(100 - r.headroom) + '% used — ok');
    } else if (r.state === 'no-candidate') {
      print('[' + at + '] ' + style.warn('threshold crossed but no other account is available'));
      _notify
        .send(ctx, 'quota', {
          account: (r.active && r.active.name) || null,
          threshold: threshold,
          state: 'no-candidate',
        })
        .catch(function () {});
    } else if (r.state === 'unknown') {
      print('[' + at + '] usage unknown (endpoint throttled or offline) — waiting');
    } else if (r.state === 'no-active') {
      print('[' + at + '] no active CLI account — waiting');
    } else if (r.state === 'error') {
      print('[' + at + '] ' + style.warn('tick failed: ' + r.error));
    }
  }
  function oneTick() {
    return autosw
      .tick(ctx, {
        threshold: threshold,
        strategy: strategy,
        group: group || undefined,
        performSwitch: function (name) {
          return withLock(ctx, function () {
            return core.performSwitch(ctx, name);
          });
        },
      })
      .catch(function (e) {
        return { state: 'error', error: (e && e.message) || String(e) };
      });
  }

  // ---- unattended background SERVICE (launchd StartInterval / cron */N) ----
  const svcSub = rest[0];
  if (svcSub === 'install' || svcSub === 'uninstall' || svcSub === 'status') {
    const svc = _svc;
    if (svcSub === 'status') {
      const st = svc.status(ctx, { home: ctx.home });
      if (JSON_MODE) {
        jsonOut({ autoswitchService: st });
        return;
      }
      print(
        'Autoswitch service: ' +
          (st.installed
            ? style.ok('installed') + ' (' + st.kind + (st.path ? ', ' + st.path : '') + ')'
            : style.warn('not installed')),
      );
      if (!st.installed)
        print(
          style.dim(
            '  Install: keyflip autoswitch install [--interval 300] [--threshold N] [--strategy best|next-available] [--group G]',
          ),
        );
      return;
    }
    if (svcSub === 'uninstall') {
      const r = svc.uninstall(ctx, { home: ctx.home });
      if (JSON_MODE) {
        jsonOut({ autoswitchService: r });
        return;
      }
      if (r.kind === 'unsupported') return fail('the autoswitch service is macOS/Linux-only for now');
      print(style.ok('✅') + ' autoswitch service ' + (r.existed === false ? 'was not installed.' : 'uninstalled.'));
      return;
    }
    // install
    const svcInterval = Math.min(21600, Math.max(60, numFlag('--interval', 300)));
    const r = svc.install(ctx, {
      home: ctx.home,
      interval: svcInterval,
      threshold: threshold,
      strategy: strategy,
      group: group || undefined,
    });
    if (JSON_MODE) {
      jsonOut({ autoswitchService: r });
      return;
    }
    if (r.kind === 'unsupported') return fail('the autoswitch service is macOS/Linux-only for now');
    if (!r.ok) return fail('could not install the autoswitch service' + (r.detail ? ': ' + r.detail : ''));
    print(
      style.ok('✅') +
        ' autoswitch runs unattended now — every ' +
        (r.intervalSec || svcInterval) +
        's it checks the active account and, at ' +
        threshold +
        '% usage, rotates to the next (' +
        strategy +
        (group ? ', group ' + group : '') +
        ').',
    );
    print(
      style.dim(
        '  It never closes Claude; the swap is picked up on the next request. Stop it: keyflip autoswitch uninstall.',
      ),
    );
    logmod.log(
      'autoswitch service installed (interval=' + (r.intervalSec || svcInterval) + ', threshold=' + threshold + ')',
    );
    return;
  }

  // ---- one-shot tick (what the scheduled service runs): check once, act, exit ----
  if (rest.indexOf('--once') !== -1) {
    reportTick(await oneTick());
    return;
  }

  const autoYes = rest.indexOf('-y') !== -1 || rest.indexOf('--yes') !== -1;
  if (!autoYes) {
    if (!process.stdin.isTTY)
      return fail('autoswitch swaps accounts WITHOUT asking each time — re-run with -y to confirm.');
    print('Autoswitch will monitor the active account every ' + interval + 's and, at ' + threshold + '% usage,');
    print(
      style.warn('swap the CLI credential automatically WITHOUT asking') +
        ' (strategy: ' +
        strategy +
        (group ? ', group: ' + group : '') +
        ').',
    );
    print('The desktop app is never closed. Stop anytime with Ctrl-C.');
    const ok = await confirm('Start? [y/N] ');
    if (!ok) {
      print('Cancelled.');
      return;
    }
  }
  logmod.log(
    'autoswitch started (threshold=' + threshold + ', strategy=' + strategy + (group ? ', group=' + group : '') + ')',
  );
  print(
    style.dim(
      '  Tip: run it unattended instead — ' +
        style.bold('keyflip autoswitch install') +
        ' (launchd/cron, no terminal needed).',
    ),
  );
  for (;;) {
    reportTick(await oneTick());
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
  const arg = rest.filter(function (a) {
    return a.indexOf('-') !== 0;
  })[0];
  if (!arg) {
    const hit = links.lookup(ctx, process.cwd());
    // --porcelain: emit ONLY the pinned account name (or nothing) on stdout, for the shell hook
    // (`keyflip shell-init`) to eval safely. No decoration, so the hook can charset-validate it.
    if (rest.indexOf('--porcelain') !== -1) {
      if (hit) process.stdout.write(hit.name + '\n');
      return;
    }
    if (hit) print('linked: ' + hit.name + '  (via ' + hit.dir + ')');
    else print('this directory is not linked — link it with: keyflip link <name>');
    return;
  }
  const name = core.resolveProfile(ctx, arg);
  if (!name) return fail("no such account: '" + arg + "'");
  links.set(ctx, process.cwd(), name);
  print(style.ok('✅') + ' linked ' + process.cwd() + ' → ' + name + "  (used by 'keyflip run' here)");
}

// Account groups/tags: scope rotation/failover to a pool.
//   keyflip group [list] | members <g> | tag <account> <g...> | untag <account> <g>
function cmdGroup(ctx, rest) {
  const groups = _groups;
  const sub = rest[0];
  const args = rest.slice(1);
  switch (sub) {
    case undefined:
    case 'list': {
      const g = groups.listGroups(ctx);
      const names = Object.keys(g).sort();
      if (JSON_MODE) {
        jsonOut({ groups: g });
        return;
      }
      if (!names.length) {
        print('no groups yet — tag an account: keyflip group tag <account> <group>');
        return;
      }
      names.forEach(function (name) {
        print(style.bold(name) + '  ' + g[name].join(', '));
      });
      return;
    }
    case 'members': {
      const grp = args[0];
      if (!grp) return fail('usage: keyflip group members <group>');
      const m = groups.membersOf(ctx, grp);
      if (JSON_MODE) {
        jsonOut({ group: grp, members: m });
        return;
      }
      if (!m.length) print('no accounts in group: ' + grp);
      else
        m.forEach(function (n) {
          print(n);
        });
      return;
    }
    case 'tag': {
      const acct = args[0];
      const tags = args.slice(1).filter(function (a) {
        return a.indexOf('-') !== 0;
      });
      if (!acct || !tags.length) return fail('usage: keyflip group tag <account> <group...>');
      const name = core.resolveProfile(ctx, acct);
      if (!name) return fail("no such account: '" + acct + "'");
      let cur = groups.tagsFor(ctx, name);
      try {
        tags.forEach(function (t) {
          cur = groups.addTag(ctx, name, t);
        });
      } catch (e) {
        return fail(e.message);
      }
      if (JSON_MODE) {
        jsonOut({ account: name, tags: cur });
        return;
      }
      print(style.ok('✅') + ' ' + name + ' → ' + cur.join(', '));
      return;
    }
    case 'untag': {
      const acct = args[0],
        grp = args[1];
      if (!acct || !grp) return fail('usage: keyflip group untag <account> <group>');
      const name = core.resolveProfile(ctx, acct);
      if (!name) return fail("no such account: '" + acct + "'");
      let cur;
      try {
        cur = groups.removeTag(ctx, name, grp);
      } catch (e) {
        return fail(e.message);
      }
      if (JSON_MODE) {
        jsonOut({ account: name, tags: cur });
        return;
      }
      print(style.ok('✅') + ' ' + name + (cur.length ? ' → ' + cur.join(', ') : ' (no groups)'));
      return;
    }
    default:
      return fail(
        'unknown: keyflip group ' + sub + ' (use: list | members <g> | tag <account> <g...> | untag <account> <g>)',
      );
  }
}

// SPEND/QUOTA BUDGETS: per-account (or '*' default) usage ceilings + breach/near-breach alerts.
// Reads the usage cache (populated by `keyflip list --usage`) — never fetches.
function cmdBudget(ctx, rest) {
  const budget = _budget;
  const sub = rest[0] || 'status';
  const args = rest.slice(1);
  function fmtPct(v) {
    return v == null ? '?' : Math.round(v) + '%';
  }
  function fmtLimits(l) {
    const p = [];
    if (l && l.fiveHourPct != null) p.push('5h ' + l.fiveHourPct + '%');
    if (l && l.sevenDayPct != null) p.push('7d ' + l.sevenDayPct + '%');
    return p.length ? p.join(' · ') : '(none)';
  }
  function target(name) {
    return name === '*' || name === 'default' || name === 'defaults' ? '*' : core.resolveProfile(ctx, name) || name;
  }
  function intFlag() {
    for (let i = 0; i < arguments.length; i++) {
      const j = args.indexOf(arguments[i]);
      if (j !== -1) return parseInt(args[j + 1], 10);
    }
    return undefined;
  }
  switch (sub) {
    case 'status': {
      const s = budget.status(ctx);
      if (JSON_MODE) {
        jsonOut({ budget: s });
        return;
      }
      if (s.defaults && (s.defaults.fiveHourPct != null || s.defaults.sevenDayPct != null))
        print('defaults  ' + fmtLimits(s.defaults));
      if (!s.accounts.length) {
        print('No account budgets set — add one:  keyflip budget set <account> --5h 80 --7d 90');
        return;
      }
      s.accounts.forEach(function (a) {
        print(
          style.bold(a.name) +
            '  limits ' +
            fmtLimits(a.limits) +
            '  usage 5h ' +
            fmtPct(a.usage.fiveHour) +
            ' / 7d ' +
            fmtPct(a.usage.sevenDay),
        );
        a.alerts.forEach(function (al) {
          print(
            '   ' +
              (al.breached ? style.err('BREACH') : style.warn('warn  ')) +
              '  ' +
              al.metric +
              '  ' +
              Math.round(al.pct) +
              '% vs limit ' +
              al.limit +
              '%',
          );
        });
      });
      return;
    }
    case 'set': {
      const who = args.filter(function (a) {
        return a.indexOf('-') !== 0;
      })[0];
      if (!who) return fail('usage: keyflip budget set <account> --5h N --7d N   (account may be "*" for defaults)');
      const five = intFlag('--5h', '--five-hour'),
        seven = intFlag('--7d', '--seven-day');
      if (five === undefined && seven === undefined) return fail('give at least one ceiling: --5h N and/or --7d N');
      const limits = {};
      if (five !== undefined) limits.fiveHourPct = five;
      if (seven !== undefined) limits.sevenDayPct = seven;
      const name = target(who);
      let entry;
      try {
        entry = budget.setLimit(ctx, name, limits);
      } catch (e) {
        return fail(e.message);
      }
      if (JSON_MODE) {
        jsonOut({ set: { account: name, limits: entry } });
        return;
      }
      print(style.ok('✅') + ' budget for ' + name + ': ' + fmtLimits(entry || {}));
      return;
    }
    case 'clear': {
      const who = args.filter(function (a) {
        return a.indexOf('-') !== 0;
      })[0];
      if (!who) return fail('usage: keyflip budget clear <account>   (account may be "*" for defaults)');
      const name = target(who);
      let existed;
      try {
        existed = budget.clear(ctx, name);
      } catch (e) {
        return fail(e.message);
      }
      if (JSON_MODE) {
        jsonOut({ cleared: existed ? name : null });
        return;
      }
      print(existed ? '🗑  cleared budget for ' + name : 'no budget set for ' + name);
      return;
    }
    default:
      return fail('unknown: keyflip budget ' + sub + ' (use: status | set | clear)');
  }
}

// keyflip import-env [<file>] [--dry-run] [--env] — import provider endpoints from a .env file
// (default ./.env) or the process environment (--env). --dry-run lists candidates, keys REDACTED.
async function cmdImportEnv(ctx, rest) {
  const dry = rest.indexOf('--dry-run') !== -1;
  const useEnv = rest.indexOf('--env') !== -1;
  const file =
    rest.filter(function (a) {
      return a.indexOf('-') !== 0;
    })[0] || '.env';
  let res;
  try {
    res = useEnv ? importcreds.fromEnv(ctx, process.env) : importcreds.fromFile(ctx, file);
  } catch (e) {
    return fail(e.message);
  }
  const cands = res.candidates;
  if (!cands.length) {
    if (JSON_MODE) {
      jsonOut({ candidates: [] });
      return;
    }
    print('No importable credentials found' + (useEnv ? ' in the environment.' : ' in ' + res.path + '.'));
    return;
  }
  if (dry) {
    const sum = importcreds.summarize(cands);
    if (JSON_MODE) {
      jsonOut({ dryRun: true, candidates: sum });
      return;
    }
    print('Would import ' + cands.length + ' provider(s) (keys redacted):');
    sum.forEach(function (s) {
      print('  ' + s.name + '  ' + s.baseUrl + '  [' + s.authScheme + ']  key=' + s.key);
    });
    return;
  }
  const imported = [];
  cands.forEach(function (c) {
    provider.add(ctx, c.name, { baseUrl: c.baseUrl, authScheme: c.authScheme, key: c.key });
    logmod.log('import-env provider add ' + c.name);
    imported.push(importcreds.summarize([c])[0]);
  });
  if (JSON_MODE) {
    jsonOut({ imported: imported });
    return;
  }
  print(style.ok('✅') + ' imported ' + imported.length + ' provider(s):');
  imported.forEach(function (s) {
    print('  ' + s.name + '  ' + s.baseUrl + '  (key ' + s.key + ')');
  });
  print('Activate one with:  keyflip use <name>   (back to your subscription:  keyflip provider off)');
}

// Print the shell auto-activation hook (direnv-style for account pins). Clean stdout only.
function cmdShellInit(rest) {
  const shellhook = _shellhook;
  const shell = rest.filter(function (a) {
    return a.indexOf('-') !== 0;
  })[0];
  if (!shell) return fail('usage: keyflip shell-init <bash|zsh|fish>');
  if (!shellhook.isSupported(shell))
    return fail("unsupported shell: '" + shell + "' (supported: " + shellhook.supported().join(', ') + ')');
  process.stdout.write(shellhook.hook(shell));
}

// keyflip log — VIEW the action/audit log (<configDir>/logs/keyflip.log).
function cmdAuditLog(ctx, rest) {
  const ti = rest.indexOf('--tail');
  const limit = ti !== -1 ? parseInt(rest[ti + 1], 10) || 50 : 50;
  const gi = rest.indexOf('--grep');
  const grep = gi !== -1 ? rest[gi + 1] : null;
  const si = rest.indexOf('--since');
  const since = si !== -1 ? rest[si + 1] : null;
  const entries = auditview.tail(ctx, { limit: limit, grep: grep, since: since });
  if (JSON_MODE) {
    jsonOut({ log: auditview.path(ctx), entries: entries });
    return;
  }
  if (!entries.length) {
    print('(no matching log entries — ' + auditview.path(ctx) + ')');
    return;
  }
  entries.forEach(function (e) {
    print(e.ts + '  ' + e.msg);
  });
}

// Notifications / webhooks on key events (quota / switch / fleet-reply).
async function cmdNotify(ctx, rest) {
  const notify = _notify;
  const sub = rest[0];
  const args = rest.slice(1);
  if (sub === 'status' || sub === undefined) {
    const cfg = notify.getConfig(ctx);
    if (JSON_MODE) {
      jsonOut({ notify: cfg });
      return;
    }
    print('Notifications:');
    print('  webhook: ' + (cfg.webhook || style.dim('(none)')));
    print(
      '  desktop: ' +
        (cfg.desktop ? 'on' + (ctx.platform === 'darwin' ? '' : style.dim(' (macOS only — inactive here)')) : 'off'),
    );
    print('  events:  ' + (cfg.events.length ? cfg.events.join(', ') : style.dim('(none)')));
    return;
  }
  if (sub === 'set') {
    const patch = {};
    const wi = args.indexOf('--webhook');
    if (wi !== -1) patch.webhook = args[wi + 1] || null;
    const ei = args.indexOf('--events');
    if (ei !== -1)
      patch.events = String(args[ei + 1] || '')
        .split(',')
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean);
    if (args.indexOf('--desktop') !== -1) patch.desktop = true;
    if (args.indexOf('--no-desktop') !== -1) patch.desktop = false;
    if (!Object.keys(patch).length)
      return fail('nothing to set (use --webhook URL | --events a,b,c | --desktop | --no-desktop)');
    const cfg = notify.setConfig(ctx, patch);
    if (patch.webhook && !cfg.webhook) print(style.warn('⚠ ') + 'webhook ignored — must be an http(s) URL');
    if (JSON_MODE) {
      jsonOut({ notify: cfg });
      return;
    }
    print(style.ok('✅') + ' notifications updated.');
    return cmdNotify(ctx, ['status']);
  }
  if (sub === 'off') {
    const cfg = notify.setConfig(ctx, { webhook: null, desktop: false });
    if (JSON_MODE) {
      jsonOut({ notify: cfg });
      return;
    }
    print(style.ok('✅') + ' notifications off (webhook cleared, desktop disabled).');
    return;
  }
  if (sub === 'test') {
    const r = await notify.test(ctx);
    if (JSON_MODE) {
      jsonOut(r);
      return;
    }
    if (r.sent)
      print(
        style.ok('✅') +
          ' test notification sent (' +
          r.channels
            .filter(function (c) {
              return c.ok;
            })
            .map(function (c) {
              return c.channel;
            })
            .join(', ') +
          ')',
      );
    else {
      print(
        style.err('✗') +
          ' not sent: ' +
          (r.reason || 'unknown') +
          (r.channels.length
            ? '  [' +
              r.channels
                .map(function (c) {
                  return c.channel + ':' + (c.ok ? 'ok' : c.reason);
                })
                .join(', ') +
              ']'
            : ''),
      );
      process.exitCode = 1;
    }
    return;
  }
  return fail(
    'usage: keyflip notify [status | set --webhook URL --events a,b,c [--desktop|--no-desktop] | test | off]',
  );
}

// ===== Wave-2 (strategic): orchestrator / cost / team / policy / vault / integrations / router =====

// Headless job queue: run a prompt on the best available account, isolated.
async function cmdRunJob(ctx, rest) {
  const orchestrator = _orchestrator;
  const fv = function (n) {
    const i = rest.indexOf(n);
    return i !== -1 ? rest[i + 1] : undefined;
  };
  const group = fv('--group');
  const strategy = fv('--strategy') || 'best';
  const prompt = rest
    .filter(function (a, i) {
      return a.indexOf('-') !== 0 && rest[i - 1] !== '--group' && rest[i - 1] !== '--strategy';
    })
    .join(' ')
    .trim();
  if (!prompt) return fail('usage: keyflip run-job "<prompt>" [--group <g>] [--strategy best|next-available]');
  let job;
  try {
    job = orchestrator.enqueue(ctx, { prompt: prompt, cwd: process.cwd(), group: group });
  } catch (e) {
    return fail(e.message);
  }
  const done = await orchestrator.runJob(ctx, job, { strategy: strategy });
  if (JSON_MODE) {
    jsonOut({ job: done });
    return;
  }
  if (done.status === 'done') {
    print(style.ok('✅') + ' ran on ' + done.account);
    print(done.result || '');
  } else fail('job failed' + (done.account ? ' on ' + done.account : '') + ': ' + (done.error || 'unknown'));
}
async function cmdJobs(ctx, rest) {
  const orchestrator = _orchestrator;
  const sub = rest[0] || 'list';
  const fv = function (n) {
    const i = rest.indexOf(n);
    return i !== -1 ? rest[i + 1] : undefined;
  };
  if (sub === 'list') {
    const jobs = orchestrator.list(ctx);
    if (JSON_MODE) {
      jsonOut({ jobs: jobs });
      return;
    }
    if (!jobs.length) {
      print('no jobs — queue one:  keyflip run-job "<prompt>"');
      return;
    }
    jobs.forEach(function (j) {
      print(
        style.bold(j.id.slice(0, 8)) +
          '  ' +
          String(j.status).padEnd(7) +
          '  ' +
          (j.account || '-') +
          '  ' +
          String(j.prompt).replace(/\s+/g, ' ').slice(0, 60),
      );
    });
    return;
  }
  if (sub === 'run') {
    const done = await orchestrator.runNext(ctx, { strategy: fv('--strategy') || 'best' });
    if (JSON_MODE) {
      jsonOut({ job: done });
      return;
    }
    if (!done) {
      print('no queued jobs.');
      return;
    }
    if (done.status === 'done') {
      print(style.ok('✅') + ' ran ' + done.id.slice(0, 8) + ' on ' + done.account);
      print(done.result || '');
    } else fail('job ' + done.id.slice(0, 8) + ' failed: ' + (done.error || 'unknown'));
    return;
  }
  if (sub === 'clear') {
    let n;
    try {
      n = orchestrator.clear(ctx, { status: fv('--status') });
    } catch (e) {
      return fail(e.message);
    }
    if (JSON_MODE) {
      jsonOut({ cleared: n });
      return;
    }
    print('🗑  cleared ' + n + ' job' + (n === 1 ? '' : 's'));
    return;
  }
  return fail('unknown: keyflip jobs ' + sub + ' (use: list | run | clear)');
}
async function cmdFanout(ctx, rest) {
  const orchestrator = _orchestrator;
  const i = rest.indexOf('--accounts');
  const accountsArg = i !== -1 ? rest[i + 1] : undefined;
  const prompt = rest
    .filter(function (a, idx) {
      return a.indexOf('-') !== 0 && rest[idx - 1] !== '--accounts';
    })
    .join(' ')
    .trim();
  if (!prompt || !accountsArg) return fail('usage: keyflip fanout "<prompt>" --accounts a,b,c');
  const names = accountsArg
    .split(',')
    .map(function (s) {
      return s.trim();
    })
    .filter(Boolean)
    .map(function (a) {
      return core.resolveProfile(ctx, a) || a;
    });
  const results = await orchestrator.fanOut(ctx, prompt, names, { cwd: process.cwd() });
  if (JSON_MODE) {
    jsonOut({ results: results });
    return;
  }
  results.forEach(function (r) {
    print(style.bold('── ' + r.account + ' ──'));
    print(r.error ? style.err('error: ' + r.error) : r.result || '');
  });
}

// COST intelligence: unified spend, prediction, per-project attribution.
function cmdCost(ctx, rest) {
  const sub = rest[0] || 'status';
  const args = rest.slice(1);
  if (sub === 'status') {
    const u = cost.unified(ctx);
    if (JSON_MODE) {
      jsonOut(u);
      return;
    }
    (u.accounts || []).forEach(function (a) {
      const usd = a.measured ? '  ' + cost.fmtUsd(a.costUSD) : '';
      print(
        style.bold(String(a.name).padEnd(16)) +
          ' 5h ' +
          (a.fiveHourPct == null ? '?' : Math.round(a.fiveHourPct) + '%') +
          ' · 7d ' +
          (a.sevenDayPct == null ? '?' : Math.round(a.sevenDayPct) + '%') +
          usd,
      );
    });
    if (u.totals)
      print(
        style.dim(
          'totals: ' +
            (u.totals.accounts || 0) +
            ' account(s)' +
            (u.totals.costUSD != null ? ' · ' + cost.fmtUsd(u.totals.costUSD) : ''),
        ),
      );
    if (u.note) print(style.dim(u.note));
    return;
  }
  if (sub === 'predict') {
    const acct = args.filter(function (a) {
      return a.indexOf('-') !== 0;
    })[0];
    if (!acct) return fail('usage: keyflip cost predict <account>');
    const name = core.resolveProfile(ctx, acct);
    if (!name) return fail("no such account: '" + acct + "'");
    const p = cost.predict(ctx, name);
    if (JSON_MODE) {
      jsonOut(p);
      return;
    }
    (p.windows || []).forEach(function (w) {
      print(
        style.bold(w.metric) +
          '  ' +
          Math.round(w.pct || 0) +
          '%  rate ' +
          (w.ratePerHour == null ? '?' : w.ratePerHour + '%/h') +
          '  eta ' +
          cost.fmtEta(w.etaMinutes),
      );
    });
    return;
  }
  if (sub === 'by-project') {
    const li = args.indexOf('--limit');
    const r = cost.attribute(ctx, { maxSessions: li !== -1 ? parseInt(args[li + 1], 10) : undefined });
    if (JSON_MODE) {
      jsonOut(r);
      return;
    }
    (r.byCwd || []).forEach(function (b) {
      print(
        style.bold(
          String(b.cwd || '?')
            .slice(-40)
            .padEnd(40),
        ) +
          '  ' +
          b.sessions +
          ' sess · ' +
          ((b.tokens && b.tokens.total) || 0) +
          ' tok' +
          (b.costUSD != null ? '  ' + cost.fmtUsd(b.costUSD) + (b.estimate ? ' (est)' : '') : ''),
      );
    });
    if (r.note) print(style.dim(r.note));
    return;
  }
  return fail('unknown: keyflip cost ' + sub + ' (use: status | predict <acct> | by-project)');
}

// TEAM POOL: a shared, encrypted credential pool with role-scoped visibility.
const TEAM_VALUE_FLAGS = ['--dir', '--pool', '--passphrase-file', '--role', '--as', '--owner', '--account'];
function collectAccountFlags(rest) {
  const map = {};
  let any = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--account' && rest[i + 1]) {
      any = true;
      const spec = rest[i + 1];
      const c = spec.lastIndexOf(':');
      if (c > 0) map[spec.slice(0, c)] = spec.slice(c + 1);
      else map[spec] = 'member';
      i++;
    }
  }
  return any ? map : null;
}
async function cmdTeam(ctx, rest) {
  const teampool = _teampool;
  const sub = rest[0];
  if (sub === 'list' || sub === undefined) {
    const pools = teampool.list(ctx);
    if (JSON_MODE) {
      jsonOut({ pools: pools });
      return;
    }
    if (!pools.length) {
      print(
        style.dim(
          'No team pools yet. Publish one: keyflip team publish --dir <shared> --pool <name> --passphrase-file <f>',
        ),
      );
      return;
    }
    print(style.bold('Team pools:'));
    pools.forEach(function (p) {
      print(
        '  ' +
          style.bold(String(p.pool).padEnd(16)) +
          ' ' +
          style.dim(
            (p.role || '?') +
              ' · ' +
              (p.dir || '?') +
              ' · ' +
              String(p.at || '')
                .slice(0, 16)
                .replace('T', ' '),
          ),
      );
    });
    return;
  }
  const dir = flagVal(rest, '--dir');
  const pool = flagVal(rest, '--pool');
  const passphrase = readSecretArg(rest, '--passphrase-file');
  if (!dir) return fail('a shared pool directory is required: --dir <shared-folder>');
  if (!pool) return fail('a pool name is required: --pool <name>');
  if (!passphrase) return fail('a pool passphrase is required: --passphrase-file <file>');
  const base = { dir: dir, pool: pool, passphrase: passphrase };
  try {
    if (sub === 'publish') {
      const r = teampool.publish(
        ctx,
        Object.assign({}, base, { accounts: collectAccountFlags(rest), owner: flagVal(rest, '--owner') || undefined }),
      );
      if (JSON_MODE) {
        jsonOut({ teamPublish: r });
        return;
      }
      print(style.ok('🔒') + ' published pool ' + style.bold(r.pool) + ' → ' + style.bold(r.dir) + ' (encrypted).');
      r.accounts.forEach(function (a) {
        print('   ' + style.ok('•') + ' ' + a.name + ' ' + style.dim('(' + a.role + ')'));
      });
      return;
    }
    if (sub === 'pull') {
      const r = teampool.pull(
        ctx,
        Object.assign({}, base, {
          asRole: flagVal(rest, '--as') || flagVal(rest, '--role') || 'member',
          force: rest.indexOf('--force') !== -1,
        }),
      );
      if (JSON_MODE) {
        jsonOut({ teamPull: r });
        return;
      }
      print(
        style.ok('📥') +
          ' pulled ' +
          style.bold(r.pool) +
          ' as ' +
          style.bold(r.role) +
          ': imported ' +
          r.imported.length +
          ', skipped ' +
          r.skipped.length +
          ' (of ' +
          r.visible.length +
          ' visible).',
      );
      if (r.imported.length) print('   ' + style.dim('imported: ' + r.imported.join(', ')));
      return;
    }
    if (sub === 'members') {
      const ms = teampool.members(ctx, base);
      if (JSON_MODE) {
        jsonOut({ members: ms });
        return;
      }
      print(style.bold('Members of ' + pool + ':'));
      ms.forEach(function (m) {
        print('  ' + style.ok('●') + ' ' + m.id + ' ' + style.dim('(' + m.role + ')'));
      });
      return;
    }
    if (sub === 'add-member') {
      const id = positionals(rest.slice(1), TEAM_VALUE_FLAGS)[0];
      const role = flagVal(rest, '--role') || 'member';
      if (!id)
        return fail(
          'usage: keyflip team add-member <id> [--role owner|member] --dir <shared> --pool <name> --passphrase-file <f>',
        );
      teampool.addMember(ctx, Object.assign({}, base, { id: id, role: role }));
      if (JSON_MODE) {
        jsonOut({ members: teampool.members(ctx, base) });
        return;
      }
      print(style.ok('✅') + ' ' + style.bold(id) + ' is now a ' + role + ' of ' + style.bold(pool) + '.');
      return;
    }
    if (sub === 'remove-member') {
      const id = positionals(rest.slice(1), TEAM_VALUE_FLAGS)[0];
      if (!id) return fail('usage: keyflip team remove-member <id> --dir <shared> --pool <name> --passphrase-file <f>');
      teampool.removeMember(ctx, Object.assign({}, base, { id: id }));
      if (JSON_MODE) {
        jsonOut({ members: teampool.members(ctx, base) });
        return;
      }
      print(style.ok('✅') + ' removed ' + style.bold(id) + ' from ' + style.bold(pool) + '.');
      return;
    }
  } catch (e) {
    return fail(e.message);
  }
  return fail(
    'usage: keyflip team <list|publish|pull|members|add-member|remove-member> --dir <shared> --pool <name> --passphrase-file <f>',
  );
}

// POLICY engine: constrain which account a directory/repo may use.
function cmdPolicy(ctx, rest) {
  const policy = _policy;
  const sub = rest[0];
  const args = rest.slice(1);
  function multi(flag) {
    const out = [];
    for (let i = 0; i < args.length; i++) if (args[i] === flag && args[i + 1] != null) out.push(args[++i]);
    return out;
  }
  function one(flag) {
    const j = args.indexOf(flag);
    return j !== -1 ? args[j + 1] : undefined;
  }
  function label(b) {
    return []
      .concat(
        b.accounts || [],
        (b.groups || []).map(function (g) {
          return '@' + g;
        }),
      )
      .join(',');
  }
  switch (sub) {
    case undefined:
    case 'list': {
      const st = policy.get(ctx);
      if (JSON_MODE) {
        jsonOut(st);
        return;
      }
      print('default: ' + st.default);
      if (!st.rules.length) {
        print('no policy rules — add one:  keyflip policy allow --cwd <dir> --account <name>');
        return;
      }
      st.rules.forEach(function (r) {
        const scope =
          [r.match.cwdPrefix ? 'cwd:' + r.match.cwdPrefix : null, r.match.repo ? 'repo:' + r.match.repo : null]
            .filter(Boolean)
            .join(' ') || '(global)';
        const parts = [];
        if (r.allow) parts.push('allow ' + label(r.allow));
        if (r.deny) parts.push('deny ' + label(r.deny));
        print(style.bold(r.id) + '  ' + scope + '  ' + parts.join('  ') + (r.note ? '  # ' + r.note : ''));
      });
      return;
    }
    case 'allow':
    case 'deny': {
      const match = {};
      const cwd = one('--cwd');
      if (cwd) match.cwdPrefix = cwd;
      const repo = one('--repo');
      if (repo) match.repo = repo;
      const rule = { id: one('--id'), match: match, note: one('--note') };
      rule[sub] = { accounts: multi('--account'), groups: multi('--group') };
      let added;
      try {
        added = policy.addRule(ctx, rule);
      } catch (e) {
        return fail(e.message);
      }
      if (JSON_MODE) {
        jsonOut({ added: added });
        return;
      }
      print(style.ok('✅') + ' added ' + sub + ' rule ' + added.id);
      return;
    }
    case 'remove':
    case 'rm': {
      const id = args.filter(function (a) {
        return a.indexOf('-') !== 0;
      })[0];
      if (!id) return fail('usage: keyflip policy remove <id>');
      const ok = policy.removeRule(ctx, id);
      if (JSON_MODE) {
        jsonOut({ removed: ok ? id : null });
        return;
      }
      print(ok ? '🗑  removed rule ' + id : 'no rule with id: ' + id);
      return;
    }
    case 'default': {
      let set;
      try {
        set = policy.setDefault(ctx, args[0]);
      } catch (e) {
        return fail(e.message);
      }
      if (JSON_MODE) {
        jsonOut({ default: set });
        return;
      }
      print(style.ok('✅') + ' default policy = ' + set);
      return;
    }
    case 'check': {
      const acct =
        one('--account') ||
        args.filter(function (a) {
          return a.indexOf('-') !== 0;
        })[0];
      if (!acct) return fail('usage: keyflip policy check --account <name> [--cwd <dir>] [--repo <r>]');
      const name = core.resolveProfile(ctx, acct) || acct;
      const res = policy.evaluate(ctx, { account: name, cwd: one('--cwd') || process.cwd(), repo: one('--repo') });
      if (JSON_MODE) {
        jsonOut(res);
        return;
      }
      print((res.allowed ? style.ok('ALLOWED') : style.err('DENIED')) + '  ' + name + '  — ' + res.reason);
      return;
    }
    default:
      return fail(
        'unknown: keyflip policy ' + sub + ' (use: list | allow | deny | remove <id> | default <allow|deny> | check)',
      );
  }
}

// VAULT backend: store credentials in 1Password / Bitwarden / HashiCorp Vault.
function cmdVault(ctx, rest) {
  const vault = _vault;
  let out;
  try {
    out = vault.cli(ctx, rest);
  } catch (e) {
    return fail(e.message);
  }
  if (JSON_MODE) {
    jsonOut(out.data);
    return;
  }
  out.lines.forEach(function (l) {
    print(l);
  });
}

// Post status/events to a Slack/Discord/generic webhook.
async function cmdPost(ctx, rest) {
  const integrations = _integrations;
  const r = await integrations.cli(ctx, rest, {});
  if (r.error) return fail(r.error);
  if (JSON_MODE) {
    jsonOut(r);
    return;
  }
  if (r.ok) print(style.ok('✅') + ' ' + r.text);
  else fail(r.text);
}

// Model ROUTING / arbitrage + response CACHE.
function cmdRoute(ctx, rest) {
  const sub = rest[0];
  const args = rest.slice(1);
  switch (sub) {
    case 'list':
    case undefined: {
      const g = router.get(ctx);
      if (JSON_MODE) {
        jsonOut(g);
        return;
      }
      print('Model routes (arbitrage: ' + (g.arbitrage ? 'on' : 'off') + '):');
      const models = Object.keys(g.routes);
      if (!models.length) print('  (no pins — routing picks the cheapest provider that serves each model)');
      models.forEach(function (m) {
        print('  ' + m + ' → ' + g.routes[m]);
      });
      return;
    }
    case 'set': {
      if (!args[0] || !args[1]) return fail('usage: keyflip route set <model> <provider>');
      let r;
      try {
        r = router.setRoute(ctx, args[0], args[1]);
      } catch (e) {
        return fail(e.message);
      }
      if (JSON_MODE) {
        jsonOut(r);
        return;
      }
      print('📌 pinned ' + r.model + ' → ' + r.provider);
      return;
    }
    case 'clear': {
      if (!args[0]) return fail('usage: keyflip route clear <model>');
      const ok = router.clearRoute(ctx, args[0]);
      if (JSON_MODE) {
        jsonOut({ cleared: ok });
        return;
      }
      print(ok ? '🗑  cleared route: ' + args[0] : 'no route for ' + args[0]);
      return;
    }
    case 'arbitrage': {
      const on = args[0] === 'on' || args[0] === 'true';
      const off = args[0] === 'off' || args[0] === 'false';
      if (!on && !off) return fail('usage: keyflip route arbitrage <on|off>');
      const v = router.setArbitrage(ctx, on);
      if (JSON_MODE) {
        jsonOut({ arbitrage: v });
        return;
      }
      print('arbitrage: ' + (v ? 'on' : 'off'));
      return;
    }
    default:
      return fail(
        'unknown: keyflip route ' + sub + ' (use: list | set <model> <provider> | clear <model> | arbitrage <on|off>)',
      );
  }
}
function cmdCache(ctx, rest) {
  const sub = rest[0];
  const args = rest.slice(1);
  if (sub === 'status' || sub === undefined) {
    const s = router.cacheStatus(ctx);
    if (JSON_MODE) {
      jsonOut(s);
      return;
    }
    print('Response cache (' + s.dir + '):');
    print('  entries: ' + s.count + ' / ' + s.cap + '   ' + s.bytes + ' bytes');
    if (s.oldest) print('  oldest: ' + s.oldest + '   newest: ' + s.newest);
    return;
  }
  if (sub === 'purge') {
    let olderThanMs;
    const i = args.indexOf('--older-than-ms');
    if (i !== -1 && args[i + 1]) olderThanMs = Number(args[i + 1]);
    const r = router.cachePurge(ctx, { olderThanMs: olderThanMs });
    if (JSON_MODE) {
      jsonOut(r);
      return;
    }
    print('🗑  purged ' + r.removed + ' cache entr' + (r.removed === 1 ? 'y' : 'ies'));
    return;
  }
  return fail('unknown: keyflip cache ' + sub + ' (use: status | purge [--older-than-ms N])');
}

// ===== Wave-3: swarm / license / config / ui / surfaces =====

// SWARM: run ONE command across YOUR OWN enrolled fleet machines + reachability checks. Exec is
// CONSENT-GATED (a target only runs a queued command when its operator drains with --allow-exec);
// commands travel as an ARGV ARRAY spawned with NO shell — nothing to inject. Origin-authenticated.
async function cmdSwarm(ctx, rest) {
  const swarm = _swarm;
  const fleet = _fleet;
  const sub = rest[0];
  if (sub === 'run') {
    const to = flagVal(rest, '--to');
    const pos = positionals(rest.slice(1), ['--passphrase-file', '--to']);
    const command = pos[0];
    const args = pos.slice(1);
    if (!command) return fail('usage: keyflip swarm run <program> [args...] [--to <machine>] --passphrase-file <f>');
    const b = fleetBus(ctx, rest);
    if (!b) return;
    fleet.publish(ctx, b, {});
    let q;
    try {
      q = swarm.queueExec(ctx, b, { command: command, args: args, to: to });
    } catch (e) {
      return fail(e.message);
    }
    if (JSON_MODE) {
      jsonOut({ swarm: { group: q.group, command: q.command, args: q.args, targets: q.commands } });
      return;
    }
    print(
      style.ok('📨') +
        ' queued ' +
        style.bold(command + (args.length ? ' ' + args.join(' ') : '')) +
        ' → ' +
        style.bold(q.commands.length + ' machine(s)') +
        ' ' +
        style.dim('(group ' + q.group + ')'),
    );
    print(
      '   ' +
        style.dim(
          'Each target runs it only on `keyflip swarm drain --allow-exec`. Collect with `keyflip swarm results`.',
        ),
    );
    return;
  }
  if (sub === 'ping') {
    const to = flagVal(rest, '--to');
    const ti = rest.indexOf('--timeout');
    const pos = positionals(rest.slice(1), ['--passphrase-file', '--to', '--timeout']);
    const url = pos[0];
    if (!url)
      return fail(
        'usage: keyflip swarm ping <http(s)-url-you-control> [--to <machine>] [--timeout <s>] --passphrase-file <f>',
      );
    const b = fleetBus(ctx, rest);
    if (!b) return;
    fleet.publish(ctx, b, {});
    let q;
    try {
      q = swarm.ping(ctx, b, url, { to: to, timeout: ti !== -1 ? rest[ti + 1] : undefined });
    } catch (e) {
      return fail(e.message);
    }
    if (JSON_MODE) {
      jsonOut({ swarm: { group: q.group, ping: url, targets: q.commands } });
      return;
    }
    print(
      style.ok('📡') +
        ' queued a reachability check of ' +
        style.bold(url) +
        ' → ' +
        style.bold(q.commands.length + ' machine(s)') +
        ' ' +
        style.dim('(group ' + q.group + ')'),
    );
    return;
  }
  if (sub === 'drain') {
    const allowExec = rest.indexOf('--allow-exec') !== -1;
    const b = fleetBus(ctx, rest);
    if (!b) return;
    fleet.publish(ctx, b, {});
    let d;
    try {
      d = swarm.drainExec(ctx, b, { allowExec: allowExec });
    } catch (e) {
      return fail(e.message);
    }
    if (JSON_MODE) {
      jsonOut({ swarm: { drained: d.results } });
      return;
    }
    if (!d.results.length) {
      print(style.dim("No exec commands in this machine's inbox."));
      return;
    }
    if (!allowExec)
      print(
        style.warn('⚠') +
          ' exec is OFF by default — pass ' +
          style.bold('--allow-exec') +
          ' to actually run queued commands (they stay in the inbox until you do).',
      );
    d.results.forEach(function (r) {
      print('   ' + (r.ok ? style.ok('✓') : style.dim('•')) + ' ' + r.detail);
    });
    return;
  }
  if (sub === 'results') {
    const group = flagVal(rest, '--group');
    const prune = rest.indexOf('--prune') !== -1;
    const b = fleetBus(ctx, rest);
    if (!b) return;
    const reconcile = fleet.reconcileKeys(ctx, fleet.readFleet(ctx, b));
    const st = swarm.readState(ctx);
    const g = group || st.lastGroup;
    const results = swarm.aggregate(ctx, b, { group: g, reconcile: reconcile, prune: prune });
    if (JSON_MODE) {
      jsonOut({ swarm: { group: g || null, results: results } });
      return;
    }
    if (!results.length) {
      print(
        style.dim(
          'No results yet' + (g ? ' for group ' + g : '') + ' — targets must run `keyflip swarm drain --allow-exec`.',
        ),
      );
      return;
    }
    print(style.bold('Swarm results') + ' ' + style.dim('(' + results.length + '):'));
    results.forEach(function (r) {
      const mark =
        r.verified === false ? style.bad('✗ unverified') : r.ok ? style.ok('✓') : style.bad('✗ exit ' + r.code);
      print('  ' + mark + ' ' + style.bold(String(r.machine || '?').padEnd(14)) + ' ' + style.dim(r.command));
      if (r.stdout) print('      ' + r.stdout.replace(/\n/g, '\n      '));
      if (r.stderr) print('      ' + style.dim(r.stderr.replace(/\n/g, '\n      ')));
    });
    return;
  }
  if (sub === 'trust' || sub === 'untrust') {
    // Exec-trust allowlist: a machine may run exec HERE only if you explicitly trust it (never by
    // silent TOFU auto-pinning). Verify the fingerprint out-of-band before trusting — this grants RCE.
    const machineArg = positionals(rest.slice(1), ['--passphrase-file'])[0];
    if (!machineArg) return fail('usage: keyflip swarm ' + sub + ' <machine> --passphrase-file <f>');
    const b = fleetBus(ctx, rest);
    if (!b) return;
    const m = resolveMachine(fleet.readFleet(ctx, b), machineArg);
    if (m === 'ambiguous') return fail("'" + machineArg + "' matches more than one machine");
    if (!m) return fail("no fleet machine named '" + machineArg + "' (run `keyflip fleet status`)");
    if (sub === 'untrust') {
      const had = swarm.untrustExec(ctx, m.machineId);
      print(had ? '🗑  ' + m.name + ' is no longer trusted for exec here' : m.name + ' was not exec-trusted');
      return;
    }
    if (m.pubKey)
      print(
        '   ' +
          style.dim('key fingerprint: ') +
          style.bold(fleet.fingerprint(m.pubKey)) +
          style.dim('  — verify this is really YOUR machine before trusting it to run commands here.'),
      );
    swarm.trustExec(ctx, m.machineId);
    print(
      style.ok('✅') +
        ' now trusting ' +
        style.bold(m.name) +
        ' ' +
        style.dim('(' + m.machineId + ')') +
        ' to run exec commands on this machine.',
    );
    return;
  }
  if (sub === 'trusted') {
    const list = swarm.execTrustList(ctx);
    if (JSON_MODE) {
      jsonOut({ execTrust: list });
      return;
    }
    if (!list.length) {
      print(
        style.dim(
          'No machines are trusted for exec yet. Trust one: keyflip swarm trust <machine> --passphrase-file <f>',
        ),
      );
      return;
    }
    print(style.bold('Machines trusted to run exec here:'));
    list.forEach(function (id) {
      print('  ' + style.ok('●') + ' ' + id);
    });
    return;
  }
  return fail(
    'usage: keyflip swarm <run|ping|drain --allow-exec|results|trust <machine>|untrust <machine>|trusted> …  (runs on YOUR OWN enrolled fleet machines; exec is CONSENT-GATED + requires the sender be EXEC-TRUSTED; commands are an argv array, never a shell string)',
  );
}

// LICENSE: offline plan management (Ed25519-signed license, verified locally — no phone-home).
function cmdLicense(ctx, rest) {
  const lic = _lic;
  const sub = rest[0] || 'status';
  switch (sub) {
    case 'status': {
      const s = lic.status(ctx);
      const feats = lic.unlockedFeatures(ctx);
      if (JSON_MODE) {
        jsonOut({
          plan: lic.tier(ctx),
          tier: s.tier,
          email: s.email,
          expiry: s.expiry,
          valid: s.valid,
          reason: s.reason,
          features: feats,
        });
        return;
      }
      print(style.bold('plan: ') + lic.tier(ctx) + (s.valid ? '' : '  (' + s.reason + ')'));
      if (s.email) print('email:  ' + s.email);
      if (s.expiry) print('expiry: ' + s.expiry);
      print('features: ' + (feats.length ? feats.join(', ') : '(none — free)'));
      return;
    }
    case 'activate': {
      const file = rest.slice(1).filter(function (a) {
        return a.indexOf('-') !== 0;
      })[0];
      if (!file) return fail('usage: keyflip license activate <file>');
      let r;
      try {
        r = lic.activate(ctx, { file: file });
      } catch (e) {
        return fail(e.message);
      }
      if (JSON_MODE) {
        jsonOut(r);
        return;
      }
      print(
        style.ok('✅') +
          ' activated ' +
          r.tier +
          ' plan' +
          (r.email ? ' for ' + r.email : '') +
          (r.expiry ? ' (expires ' + r.expiry + ')' : ''),
      );
      return;
    }
    case 'deactivate': {
      const had = lic.deactivate(ctx);
      if (JSON_MODE) {
        jsonOut({ deactivated: had });
        return;
      }
      print(had ? '🗑  license removed — back to free' : 'no license was active.');
      return;
    }
    default:
      return fail('usage: keyflip license <status|activate <file>|deactivate>');
  }
}

// CONFIG (E4): one validated home for scattered toggles (<configDir>/config.json).
function cmdConfig(ctx, rest) {
  const config = _cfg;
  const sub = rest[0] || 'list';
  const args = rest.slice(1);
  switch (sub) {
    case 'list': {
      const eff = config.getAll(ctx),
        schema = config.describe();
      if (JSON_MODE) {
        jsonOut({ config: Object.assign({}, eff), schema: Object.assign({}, schema) });
        return;
      }
      Object.keys(schema)
        .sort()
        .forEach(function (key) {
          const s = schema[key];
          const meta =
            s.type +
            ', default ' +
            JSON.stringify(s.default) +
            (s.values ? ', one of: ' + s.values.join('|') : '') +
            (typeof s.min === 'number' ? ', ' + s.min + '..' + s.max : '');
          print(style.bold(key) + ' = ' + JSON.stringify(eff[key]) + '  ' + style.dim('(' + meta + ')'));
          print('    ' + style.dim(s.help));
        });
      return;
    }
    case 'get': {
      const key = args[0];
      if (!key) return fail('usage: keyflip config get <key>');
      let val;
      try {
        val = config.get(ctx, key);
      } catch (e) {
        return fail(e.message);
      }
      if (JSON_MODE) {
        jsonOut({ key: key, value: val });
        return;
      }
      print(JSON.stringify(val));
      return;
    }
    case 'set': {
      const key = args[0];
      if (!key || args.length < 2) return fail('usage: keyflip config set <key> <value>');
      let val;
      try {
        val = config.set(ctx, key, args[1]);
      } catch (e) {
        return fail(e.message);
      }
      if (JSON_MODE) {
        jsonOut({ set: { key: key, value: val } });
        return;
      }
      print(style.ok('✅') + ' ' + key + ' = ' + JSON.stringify(val));
      return;
    }
    case 'unset': {
      const key = args[0];
      if (!key) return fail('usage: keyflip config unset <key>');
      let had;
      try {
        had = config.unset(ctx, key);
      } catch (e) {
        return fail(e.message);
      }
      const def = config.get(ctx, key);
      if (JSON_MODE) {
        jsonOut({ unset: key, wasSet: had, value: def });
        return;
      }
      print(
        had
          ? style.ok('✅') + ' ' + key + ' reset to default ' + JSON.stringify(def)
          : key + ' is already at its default (' + JSON.stringify(def) + ')',
      );
      return;
    }
    default:
      return fail('unknown: keyflip config ' + sub + ' (use: list | get <key> | set <key> <value> | unset <key>)');
  }
}

// UI (E5): a self-contained full-screen TUI dashboard.
async function cmdUi(ctx, rest) {
  const tui = _tui;

  const view = rest.indexOf('--fleet') !== -1 ? 'fleet' : undefined;
  const loadUsage = async function (c) {
    const profs = core.listProfiles(c);
    const names = profs.map(function (p) {
      return p.name;
    });
    const activeName = (
      profs.filter(function (p) {
        return p.active;
      })[0] || {}
    ).name;
    try {
      return await usagemod.usageForProfiles(c, names, { liveFor: activeName });
    } catch (e) {
      return {};
    }
  };
  // Multi-provider usage (other AI tools) for the 'usage' view — best-effort, never blocks the UI.
  const loadProvUsage = async function (c) {
    try {
      return await _provusage.readAll(c, { fetch: typeof fetch !== 'undefined' ? fetch : undefined });
    } catch (e) {
      return [];
    }
  };
  const r = await tui.run(ctx, {
    view: view,
    provUsage: await loadProvUsage(ctx),
    onSwitch: function (name) {
      return withLock(ctx, function () {
        return core.performSwitch(ctx, name);
      });
    },
    onRefresh: async function (c, s) {
      return tui.buildState(c, { usage: await loadUsage(c), provUsage: await loadProvUsage(c), view: s.view });
    },
  });
  // The palette let the user PICK a command. Run the safe (read-only / no-arg) ones directly;
  // print the rest ready to paste (they need args or a confirmation the palette can't gather).
  if (r && r.command) {
    const cmd = r.command;
    if (cmd.safe) {
      print(style.dim('› keyflip ' + cmd.name));
      return dispatch(ctx, cmd.name, []);
    }
    print('Run this command (it needs arguments or a confirmation):');
    print('  ' + style.bold('keyflip ' + (cmd.usage || cmd.name)));
  }
}

// The opt-in "brain": a natural-language intent -> a proposed plan of keyflip commands (via Gemini),
// which you approve STEP BY STEP. It NEVER runs anything on its own; approved steps go through the
// normal dispatch (so destructive ones still re-confirm). OFF unless KEYFLIP_BRAIN=1 + GEMINI_API_KEY.
async function cmdBrain(ctx, rest) {
  const brain = _brain;
  if (!brain.enabled(ctx, {})) {
    return fail(
      'the brain is OFF. Turn it on with ' +
        style.bold('KEYFLIP_BRAIN=1') +
        ' and ' +
        style.bold('GEMINI_API_KEY=<your free Gemini key>') +
        '.\n  It only PROPOSES keyflip actions from plain-language intent — you approve each step; nothing runs on its own.',
    );
  }
  const intent = positionals(rest, []).join(' ').trim();
  if (!intent) return fail('usage: keyflip brain "<what you want, in plain language>"');
  if (!JSON_MODE) print(style.dim('Thinking… (Gemini proposes; nothing runs without your OK)'));
  let r;
  try {
    r = await brain.propose(ctx, intent, { fetch: typeof fetch !== 'undefined' ? fetch : undefined });
  } catch (e) {
    return fail((e && e.message) || String(e));
  }
  if (!r.ok)
    return fail(
      'could not build a plan: ' + (r.reason || 'unknown') + ' (the model may be unavailable or the key invalid).',
    );
  if (!r.plan.length) {
    print(
      'No actionable keyflip steps proposed for that.' +
        (r.dropped && r.dropped.length ? ' (ignored: ' + r.dropped.join(', ') + ')' : ''),
    );
    return;
  }
  if (JSON_MODE) {
    jsonOut({ brain: { intent: intent, plan: r.plan, dropped: r.dropped || [] } });
    return;
  }
  print(
    style.bold('Proposed plan') +
      ' (' +
      r.plan.length +
      ' step' +
      (r.plan.length === 1 ? '' : 's') +
      ') — you approve each:',
  );
  print(brain.formatPlan(r.plan));
  if (r.dropped && r.dropped.length)
    print(style.dim('  (ignored non-keyflip suggestions: ' + r.dropped.join(', ') + ')'));
  if (!process.stdin.isTTY) {
    print(style.dim('Non-interactive shell — not running. Re-run in a terminal to approve steps.'));
    return;
  }
  print('');
  let ran = 0;
  for (let i = 0; i < r.plan.length; i++) {
    const step = r.plan[i];
    const cmdline = 'keyflip ' + step.command + (step.args ? ' ' + step.args : '');
    const ok = await confirm(
      '  ' +
        (step.mutating ? style.warn('[mutating] ') : style.ok('[safe] ')) +
        style.bold(cmdline) +
        '  — run it? [y/N] ',
    );
    if (!ok) {
      print(style.dim('   skipped.'));
      continue;
    }
    const args = step.args ? step.args.split(/\s+/).filter(Boolean) : [];
    logmod.log('brain run: ' + step.command + (step.args ? ' ' + step.args : ''));
    try {
      await dispatch(ctx, step.command, args);
      ran++;
    } catch (e) {
      print(style.warn('   step failed: ' + ((e && e.message) || e)));
    }
  }
  print(style.dim('Done — ' + ran + ' of ' + r.plan.length + ' step(s) run.'));
}

// Bridge to a locally-installed CodexBar (the menu-bar usage monitor): show whether it's present
// and how its tracked providers line up with what keyflip can read. Complementary, not a dependency.
function cmdCodexbar(ctx, rest) {
  const codexbar = _codexbar;
  const det = codexbar.detect(ctx);
  const align = codexbar.align(ctx);
  if (JSON_MODE) {
    jsonOut({ codexbar: { detected: det, align: align } });
    return;
  }
  print(
    style.bold('CodexBar bridge') +
      ' ' +
      style.dim('(monitors usage; keyflip manages accounts — they complement each other)'),
  );
  if (!det.present) {
    print('  ' + style.dim('○') + ' CodexBar not detected (no ' + det.configPath + ').');
    print('  ' + style.dim('It is an optional macOS menu-bar usage monitor: https://github.com/steipete/CodexBar'));
    return;
  }
  print(
    '  ' +
      style.ok('●') +
      ' CodexBar config found' +
      (det.hasApp ? ' + app installed' : '') +
      '  ' +
      style.dim(det.configPath),
  );
  print('  Providers CodexBar tracks: ' + (align.codexbar.length ? align.codexbar.join(', ') : '(none read)'));
  print('  keyflip can read usage for: ' + (align.keyflip.length ? align.keyflip.join(', ') : '(none)'));
  if (align.both.length) print('  ' + style.ok('↔ both: ') + align.both.join(', '));
  if (align.onlyCodexbar.length) print('  ' + style.dim('only CodexBar: ' + align.onlyCodexbar.join(', ')));
  if (align.onlyKeyflip.length) print('  ' + style.dim('only keyflip: ' + align.onlyKeyflip.join(', ')));
  print('  ' + style.dim("keyflip never reads CodexBar's stored secrets — only its non-secret provider list."));
}

// SURFACES (E1): detect which OTHER AI tools are on this machine (read-only — never reads/moves a secret).
function cmdSurfaces(ctx, rest) {
  const surface = _surface;
  const all = surface.detectAll(ctx);
  if (JSON_MODE) {
    jsonOut({ surfaces: all });
    return;
  }
  print(
    style.bold('Credential surfaces on this machine') +
      ' ' +
      style.dim('(detection only — secrets are never read or moved):'),
  );
  all.forEach(function (s) {
    const mark = s.present ? style.ok('●') : style.dim('○');
    const who = s.activeAccount
      ? style.bold(s.activeAccount)
      : style.dim(s.present ? 'account in opaque/secret store' : 'not detected');
    print('  ' + mark + ' ' + s.label.padEnd(16) + ' ' + who + '  ' + style.dim('[' + s.kind + ']'));
  });
  print('');
  print(style.dim('Claude is managed by the other keyflip commands. Switching other tools is not supported yet.'));
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
    print(mcp.TOOLS.length + ' tools cover the full surface — accounts (status/list/switch/next/add/account_remove),');
    print('providers, sessions (sessions/resume/archive/distill), migrate + transfer, the FLEET control');
    print('plane (fleet_status/switch/send_account/collect/keys/trust), other-agent memory (agents),');
    print('diagnostics (doctor/usage_history), backup, skills, and the failover proxy.');
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
    print(
      st === 'current'
        ? style.ok('✓ up to date')
        : st === 'stale'
          ? style.warn('⚠ installed skill is out of date — run: keyflip install-skill --update')
          : 'not installed — run: keyflip install-skill',
    );
    jsonOut({ skillStatus: st });
    return;
  }
  let r;
  try {
    r = skill.install(ctx);
  } catch (e) {
    return fail(e.message);
  }
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
      const kv = rest[i + 1].split('=');
      models[kv[0]] = kv.slice(1).join('=');
    }
  }
  return models;
}
function collectFlagValues(rest, flag) {
  const out = [];
  for (let i = 0; i < rest.length; i++)
    if (rest[i] === flag && rest[i + 1] && rest[i + 1].indexOf('--') !== 0) out.push(rest[i + 1]);
  return out;
}

async function cmdProviderAdd(ctx, rest) {
  const name = rest.filter(function (a) {
    return a.indexOf('-') !== 0;
  })[0];
  const bi = rest.indexOf('--base-url');
  const baseUrl = bi !== -1 ? rest[bi + 1] : null;
  if (!name || !baseUrl)
    return fail(
      'usage: keyflip provider add <name> --base-url <url> [--auth-scheme bearer|api-key] [--model default=… --model haiku=…] [--endpoint <url>]… [--key-file <file|->]',
    );
  if (!/^https?:\/\//.test(baseUrl)) return fail('--base-url must be an http(s) URL');
  const asi = rest.indexOf('--auth-scheme');
  const authScheme = asi !== -1 ? rest[asi + 1] : 'bearer';
  // The API key is a secret: read it from a file/stdin (never argv, never `ps`).
  let key = null;
  const kfi = rest.indexOf('--key-file');
  if (kfi !== -1 && rest[kfi + 1]) {
    try {
      key = (rest[kfi + 1] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(rest[kfi + 1], 'utf8')).trim();
    } catch (e) {
      return fail('could not read --key-file: ' + e.message);
    }
  } else if (process.stdin.isTTY) {
    key = (await promptHidden('API key for ' + name + ' (leave blank for none): ')).trim() || null;
  }
  const meta = provider.add(ctx, name, {
    baseUrl: baseUrl,
    authScheme: authScheme,
    key: key,
    models: parseModels(rest),
    endpointCandidates: collectFlagValues(rest, '--endpoint'),
  });
  logmod.log('provider add ' + name);
  print(style.ok('✅') + " saved provider '" + name + "' -> " + meta.baseUrl + (key ? '' : '  (no key stored)'));
  print('Activate it with:  keyflip use ' + name + '    (back to your subscription:  keyflip provider off)');
}

function cmdProviderList(ctx) {
  const names = provider.list(ctx);
  const active = provider.readActive(ctx);
  if (JSON_MODE) {
    jsonOut({
      providers: names.map(function (n) {
        const m = provider.read(ctx, n);
        return { name: n, baseUrl: m && m.baseUrl, active: !!(active && active.name === n) };
      }),
      active: active ? active.name : null,
    });
    return;
  }
  print('Providers (' + provider.providersDir(ctx) + '):');
  if (!names.length) {
    print('  (none — add one with: keyflip provider add <name> --base-url …)');
  }
  names.forEach(function (n) {
    const m = provider.read(ctx, n);
    print(
      ' ' +
        (active && active.name === n ? '→' : ' ') +
        ' ' +
        n +
        '   ' +
        (m ? m.baseUrl : '?') +
        (active && active.name === n ? '   ← active' : ''),
    );
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
    case 'add':
      return withLock(
        ctx,
        function () {
          return cmdProviderAdd(ctx, args);
        },
        'provider',
      );
    case 'list':
    case undefined:
      return cmdProviderList(ctx);
    case 'use':
      return withLock(
        ctx,
        function () {
          return cmdProviderUse(ctx, args[0]);
        },
        'provider',
      );
    case 'off':
    case 'official':
      return withLock(
        ctx,
        function () {
          return cmdProviderUse(ctx, 'official');
        },
        'provider',
      );
    case 'remove':
    case 'rm':
      return withLock(
        ctx,
        async function () {
          if (!provider.exists(ctx, args[0])) return fail("no such provider: '" + (args[0] || '') + "'");
          // Removing a provider drops its stored API key/bearer — confirm unless forced.
          const forced = args.indexOf('--force') !== -1 || args.indexOf('-y') !== -1 || args.indexOf('--yes') !== -1;
          if (!forced && !JSON_MODE) {
            if (!process.stdin.isTTY)
              return fail("refusing to delete provider '" + args[0] + "' non-interactively — pass --force to confirm.");
            if (
              !(await confirm(
                'Delete provider ' + style.bold(args[0]) + '? Its stored key is removed for good. [y/N] ',
              ))
            ) {
              print('Cancelled.');
              return;
            }
          }
          provider.remove(ctx, args[0]);
          print('🗑  removed provider: ' + args[0]);
        },
        'provider',
      );
    default:
      return fail('unknown: keyflip provider ' + sub + ' (use: add | list | use | off | remove)');
  }
}

async function cmdSpeedtest(ctx, rest) {
  const name = rest.filter(function (a) {
    return a.indexOf('-') !== 0;
  })[0];
  const names = name ? [name] : provider.list(ctx);
  if (!names.length) return fail('no providers to test (add one: keyflip provider add …)');
  for (let i = 0; i < names.length; i++) {
    if (!provider.exists(ctx, names[i])) {
      fail("no such provider: '" + names[i] + "'");
      continue;
    }
    const r = await provider.speedtest(ctx, names[i]);
    print(names[i] + ':');
    r.results.forEach(function (x) {
      print('   ' + (x.ok ? String(x.ms) + 'ms ' + x.bucket : 'unreachable') + '   ' + x.url);
    });
    if (r.chosen) print('   → fastest: ' + r.chosen);
  }
}

// #12 usage trend + failover event history
async function cmdUsage(ctx, rest) {
  // --providers: usage/limits across the OTHER AI tools on this machine (Codex/Gemini/Cursor/…),
  // from provusage — the CodexBar-style multi-provider monitor (same data the TUI's `u` view shows).
  if (rest.indexOf('--providers') !== -1) {
    let list = [];
    try {
      list = await _provusage.readAll(ctx, { fetch: typeof fetch !== 'undefined' ? fetch : undefined });
    } catch (e) {
      list = [];
    }
    if (JSON_MODE) {
      jsonOut({ providerUsage: list });
      return;
    }
    if (!list.length) {
      print('No other AI providers detected on this machine.');
      return;
    }
    print(style.bold('Provider usage') + ' ' + style.dim('(other AI tools on this machine):'));
    list.forEach(function (p) {
      const w = (p.windows || [])[0];
      const pct = w && typeof w.usedPct === 'number' ? Math.round(w.usedPct) + '%' : p.status || '?';
      print(
        '  ' +
          (p.label || p.id).padEnd(14) +
          ' ' +
          pct +
          (w && w.name ? '  ' + w.name : '') +
          (w && w.human ? '  ' + w.human : '') +
          (p.status && p.status !== 'ok' ? '  ' + style.dim(p.status) : ''),
      );
    });
    return;
  }
  if (rest.indexOf('--history') === -1) {
    // no --history: behave like `list --usage`
    return cmdList(ctx, ['--usage'].concat(rest));
  }
  const li = rest.indexOf('--limit');
  const limit = li !== -1 ? parseInt(rest[li + 1], 10) || 50 : 50;
  const samples = history.readUsage(ctx, limit);
  const events = history.readEvents(ctx, limit);
  if (JSON_MODE) {
    jsonOut({ usage: samples, events: events });
    return;
  }
  print('Usage history (last ' + samples.length + ' samples):');
  samples.forEach(function (s) {
    print(
      '  ' +
        s.at +
        '  ' +
        s.account +
        '  ' +
        (s.status === 'ok' ? '5h ' + Math.round(s.fiveHour) + '% · 7d ' + Math.round(s.sevenDay) + '%' : s.status),
    );
  });
  if (events.length) {
    print('');
    print('Failover / autoswitch events:');
    events.forEach(function (e) {
      print(
        '  ' +
          e.at +
          '  ' +
          (e.kind || 'event') +
          ': ' +
          (e.from || '?') +
          ' → ' +
          (e.to || '?') +
          (e.reason ? '  (' + e.reason + ')' : ''),
      );
    });
  }
  if (!samples.length && !events.length) print('  (nothing recorded yet — run: keyflip list --usage)');
}

// #15 MCP registry
function readSecretArg(rest, flag) {
  const i = rest.indexOf(flag);
  if (i === -1 || !rest[i + 1]) return null;
  try {
    return (rest[i + 1] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(rest[i + 1], 'utf8')).trim();
  } catch (e) {
    return null;
  }
}
// Positional (non-flag) args, skipping value-taking flags AND the values they consume,
// so e.g. `--passphrase-file f` is never mistaken for the positional file/host. The
// lone `-` (stdin/stdout sentinel) is a positional, not a flag.
function positionals(args, valueFlags) {
  valueFlags = valueFlags || [];
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.length > 1 && a[0] === '-') {
      // a flag (--x or -x), not the `-` sentinel
      if (valueFlags.indexOf(a) !== -1) i++; // consume its value too
      continue;
    }
    out.push(a);
  }
  return out;
}
function cmdMcpreg(ctx, rest) {
  const sub = rest[0];
  const args = rest.slice(1);
  if (sub === 'add') {
    const name = args.filter(function (a) {
      return a.indexOf('-') !== 0;
    })[0];
    const sep = args.indexOf('--');
    if (!name || sep === -1) return fail('usage: keyflip mcpreg add <name> -- <command> [args…]');
    const cmdArr = args.slice(sep + 1);
    mcpreg.add(ctx, name, { command: cmdArr[0], args: cmdArr.slice(1) });
    print(
      style.ok('✅') + " registered MCP server '" + name + "'  (enable it: keyflip mcpreg enable " + name + ' --all)',
    );
    return;
  }
  if (sub === 'list' || sub === undefined) {
    const items = mcpreg.list(ctx);
    if (JSON_MODE) {
      jsonOut({ servers: items });
      return;
    }
    if (!items.length) {
      print('No MCP servers registered (add one: keyflip mcpreg add …).');
      return;
    }
    items.forEach(function (s) {
      print('  ' + s.name + '   ' + s.command + ' ' + (s.args || []).join(' '));
    });
    return;
  }
  if (sub === 'enable' || sub === 'disable') {
    const name = args.filter(function (a) {
      return a.indexOf('-') !== 0;
    })[0];
    if (!name) return fail('usage: keyflip mcpreg ' + sub + ' <name> [--code|--desktop|--all]');
    const surfaces = [];
    if (args.indexOf('--all') !== -1 || (args.indexOf('--code') === -1 && args.indexOf('--desktop') === -1)) {
      surfaces.push('claude-code', 'claude-desktop');
    } else {
      if (args.indexOf('--code') !== -1) surfaces.push('claude-code');
      if (args.indexOf('--desktop') !== -1) surfaces.push('claude-desktop');
    }
    surfaces.forEach(function (s) {
      const r = mcpreg.setEnabled(ctx, name, s, sub === 'enable');
      print(
        '  ' +
          s +
          ': ' +
          (r === 'skipped-no-config' ? 'skipped (app config not present)' : sub === 'enable' ? 'enabled' : 'disabled'),
      );
    });
    return;
  }
  if (sub === 'remove' || sub === 'rm') {
    mcpreg.remove(ctx, args[0]);
    print('🗑  removed MCP server: ' + args[0]);
    return;
  }
  if (sub === 'import') {
    const imp = mcpreg.importLive(ctx);
    print('imported ' + imp.length + ' server(s): ' + imp.join(', '));
    return;
  }
  return fail('usage: keyflip mcpreg [add|list|enable|disable|remove|import]');
}

// #17 Claude Desktop third-party gateway
function cmdGateway(ctx, rest) {
  const sub = rest[0];
  if (sub === 'use') {
    if (!provider.exists(ctx, rest[1])) return fail("no such provider: '" + (rest[1] || '') + "'");
    const r = desktopgw.use(ctx, rest[1]);
    print(
      style.ok('✅') +
        ' Claude desktop app -> gateway "' +
        rest[1] +
        '" (' +
        r.dirs +
        ' config dir(s)). Restart the app to apply.',
    );
    return;
  }
  if (sub === 'off' || sub === 'restore') {
    desktopgw.restore(ctx);
    print(style.ok('✅') + ' Claude desktop app restored to first-party (Anthropic). Restart the app.');
    return;
  }
  if (sub === 'status' || sub === undefined) {
    const a = desktopgw.active(ctx);
    print(a ? 'Desktop gateway: ' + a.provider : 'Desktop app: first-party (Anthropic)');
    return;
  }
  return fail('usage: keyflip gateway [use <provider>|off|status]');
}

// #18 encrypted WebDAV sync
async function cmdSync(ctx, rest) {
  const sub = rest[0];
  const ui = rest.indexOf('--url');
  const url = ui !== -1 ? rest[ui + 1] : null;
  const useri = rest.indexOf('--user');
  const user = useri !== -1 ? rest[useri + 1] : null;
  const o = {
    url: url,
    user: user,
    pass: readSecretArg(rest, '--pass-file'),
    passphrase: readSecretArg(rest, '--passphrase-file'),
  };
  if (sub === 'test') {
    if (!url) return fail('usage: keyflip sync test --url <webdav-url> [--user U --pass-file f]');
    const r = await sync.test(o);
    print(
      r.ok
        ? style.ok('✓') + ' reachable (http ' + r.httpStatus + ')'
        : style.err('✗') + ' ' + (r.reason || 'unreachable'),
    );
    return;
  }
  if (sub === 'push') {
    if (!url || !o.passphrase)
      return fail('usage: keyflip sync push --url <u> --passphrase-file <f> [--user U --pass-file f]');
    const r = await sync.push(ctx, o);
    print(style.ok('✅') + ' pushed ' + r.pushed + ' account(s), encrypted.');
    return;
  }
  if (sub === 'pull') {
    if (!url || !o.passphrase) return fail('usage: keyflip sync pull --url <u> --passphrase-file <f> [--force]');
    const p = await sync.pull(ctx, o);
    if (!p.found) return fail('no snapshot at that URL');
    print(
      'Remote snapshot: ' +
        p.meta.accounts +
        ' account(s), from "' +
        p.meta.device +
        '" at ' +
        p.meta.at +
        ' (schema v' +
        p.meta.schema +
        ')',
    );
    if (rest.indexOf('--force') === -1) {
      if (!process.stdin.isTTY) return fail('applying a pulled snapshot non-interactively requires --force');
      const ok = await confirm('Apply it? A safety backup will be taken first. [y/N] ');
      if (!ok) {
        print('Cancelled.');
        return;
      }
    }
    const res = sync.apply(ctx, p, { force: rest.indexOf('--force') !== -1 });
    print(
      style.ok('✅') +
        ' applied. imported: ' +
        (res.imported.join(', ') || '(none)') +
        (res.skipped.length ? '; skipped: ' + res.skipped.join(', ') : ''),
    );
    return;
  }
  return fail(
    'usage: keyflip sync [test|push|pull] --url <webdav-url> --passphrase-file <file> [--user U --pass-file f]',
  );
}

// E2: parse selective-bundle filters (which accounts/sessions/memory to include) shared by
// migrate export/push and transfer serve.
const BUNDLE_VALUE_FLAGS = [
  '--passphrase-file',
  '--url',
  '--user',
  '--pass-file',
  '--sessions',
  '--search',
  '--newer-than',
  '--older-than',
  '--limit',
];
function bundleFilterOpts(rest) {
  const o = {
    noSessions: rest.indexOf('--no-sessions') !== -1,
    noProviders: rest.indexOf('--no-providers') !== -1,
    noMemory: rest.indexOf('--no-memory') !== -1,
    noAccounts: rest.indexOf('--no-accounts') !== -1,
    noConfig: rest.indexOf('--no-config') !== -1,
  };
  const si = rest.indexOf('--sessions');
  if (si !== -1 && rest[si + 1])
    o.sessions = rest[si + 1]
      .split(',')
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
  const se = flagVal(rest, '--search');
  if (se) o.search = se;
  const nt = rest.indexOf('--newer-than');
  if (nt !== -1) o.newerThanDays = parseDays(rest[nt + 1]);
  const ot = rest.indexOf('--older-than');
  if (ot !== -1) o.olderThanDays = parseDays(rest[ot + 1]);
  // J1: --agents (all present) or --agents=cursor,gemini opts IN other agents' home-level
  // memory (default OFF; secrets never carried). The `=` form avoids a stray positional
  // being mistaken for the output path.
  const av = rest.filter(function (a) {
    return a === '--agents' || a.indexOf('--agents=') === 0;
  })[0];
  if (av) {
    o.agents = true;
    if (av.indexOf('=') !== -1)
      o.agentIds = av
        .slice(av.indexOf('=') + 1)
        .split(',')
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean);
  }
  // J1 config-tier: --agent-config carries other agents' config files, redacted by default.
  const acv = rest.filter(function (a) {
    return a === '--agent-config' || a.indexOf('--agent-config=') === 0;
  })[0];
  if (acv) {
    o.agentConfig = true;
    if (acv.indexOf('=') !== -1)
      o.agentIds = acv
        .slice(acv.indexOf('=') + 1)
        .split(',')
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean);
  }
  // Opt IN to carrying the REAL keys (not redacted). `migrate export` warns loudly if the bundle
  // is unencrypted (MCP hard-refuses); encrypt with --passphrase-file.
  if (rest.indexOf('--agent-config-secrets') !== -1) {
    o.agentConfig = true;
    o.agentConfigSecrets = true;
  }
  if (rest.indexOf('--only-sessions') !== -1) {
    o.noAccounts = true;
    o.noProviders = true;
    o.noMemory = true;
    o.noConfig = true;
  }
  if (rest.indexOf('--only-memory') !== -1) {
    o.noAccounts = true;
    o.noProviders = true;
    o.noSessions = true;
    o.noConfig = true;
  }
  if (rest.indexOf('--only-config') !== -1) {
    o.noAccounts = true;
    o.noProviders = true;
    o.noSessions = true;
    o.noMemory = true;
  }
  if (rest.indexOf('--only-agents') !== -1) {
    o.agents = true;
    o.noAccounts = true;
    o.noProviders = true;
    o.noSessions = true;
    o.noMemory = true;
    o.noConfig = true;
  }
  if (rest.indexOf('--only-agent-config') !== -1) {
    o.agentConfig = true;
    o.agents = false;
    o.noAccounts = true;
    o.noProviders = true;
    o.noSessions = true;
    o.noMemory = true;
    o.noConfig = true;
  }
  return o;
}

// J1: show which OTHER agents' home-level memory keyflip can carry (existence-gated).
function cmdAgents(ctx, rest) {
  const agents = _agents;
  const present = agents.presentAgents(ctx);
  const cfgPresent = agents.presentAgentConfig(ctx);
  const rows = agents.REGISTRY.map(function (a) {
    const files = present.indexOf(a.id) !== -1 ? agents.collectAgentMemory(ctx, { only: [a.id] }) : [];
    const cfg = cfgPresent.indexOf(a.id) !== -1 ? agents.collectAgentConfig(ctx, { only: [a.id] }) : [];
    const redactions = cfg.reduce(function (n, c) {
      return n + (c.redactions || 0);
    }, 0);
    return {
      id: a.id,
      label: a.label,
      roots: a.roots,
      present: present.indexOf(a.id) !== -1,
      files: files.length,
      config: cfg.length,
      redactions: redactions,
    };
  });
  if (JSON_MODE) {
    jsonOut({ agents: rows });
    return;
  }
  print(
    style.bold('Other agents keyflip can carry') +
      ' ' +
      style.dim('(memory = home-level markdown; config = MCP/settings, redacted):'),
  );
  rows.forEach(function (r) {
    const mark = r.present || r.config ? style.ok('●') : style.dim('○');
    const parts = [];
    if (r.present) parts.push(r.files + ' memory file(s)');
    if (r.config)
      parts.push(
        r.config +
          ' config file(s)' +
          (r.redactions ? ' (' + r.redactions + ' secret' + (r.redactions === 1 ? '' : 's') + ' redacted)' : ''),
      );
    const detail = parts.length ? parts.join(', ') : 'not found';
    print('  ' + mark + ' ' + r.label.padEnd(12) + ' ' + style.dim(detail));
  });
  const anyMem = rows.some(function (r) {
    return r.present;
  });
  const anyCfg = rows.some(function (r) {
    return r.config;
  });
  print('');
  if (anyMem)
    print(
      style.dim('Carry memory:  ') +
        style.bold('keyflip migrate export bundle.json --agents') +
        style.dim('  (or --agents=cursor,gemini)'),
    );
  if (anyCfg)
    print(
      style.dim('Carry config:  ') +
        style.bold('keyflip migrate export bundle.json --agent-config') +
        style.dim('  (secrets are ALWAYS redacted — re-enter keys on the new machine)'),
    );
  if (!anyMem && !anyCfg) print(style.dim('None detected on this machine. Auth/credential files are never carried.'));
}

// Move a whole machine's Claude world to another one: ALL accounts (secrets) +
// providers (keys) + every Claude Code session transcript in one bundle, and on
// the target MERGE (union) them with whatever is already there.
async function cmdMigrate(ctx, rest) {
  const migrate = _migrate;
  const sub = rest[0];
  const target = positionals(rest.slice(1), BUNDLE_VALUE_FLAGS)[0];
  const passphraseGiven = rest.indexOf('--passphrase-file') !== -1;
  const passphrase = readSecretArg(rest, '--passphrase-file'); // optional encryption
  // A passphrase-file that was asked for but is unreadable must NOT silently fall back
  // to writing/reading an UNENCRYPTED secrets bundle.
  if (passphraseGiven && !passphrase)
    return fail('cannot read the --passphrase-file (refusing to proceed unencrypted).');
  const force = rest.indexOf('--force') !== -1;

  if (sub === 'export') {
    const out = target || 'keyflip-migrate.json';
    const fopts = bundleFilterOpts(rest);
    const built = migrate.buildBundle(ctx, fopts);
    if (
      !built.counts.accounts &&
      !built.counts.transcripts &&
      !built.counts.providers &&
      !built.counts.memory &&
      !built.counts.config &&
      !built.counts.agents &&
      !built.counts.agentConfig
    ) {
      return fail('nothing to migrate (no accounts, providers, transcripts, or memory found).');
    }
    let json = JSON.stringify(built.bundle);
    if (passphrase) json = sync.encrypt(json, passphrase); // returns the JSON envelope string
    // When writing to stdout (`-`), the bundle IS the stdout payload — the human notes
    // must go to stderr so they don't corrupt a piped/redirected bundle.
    const note =
      out === '-' || JSON_MODE
        ? function (s) {
            process.stderr.write((s == null ? '' : s) + '\n');
          }
        : print;
    if (out === '-') process.stdout.write(json + '\n');
    else {
      fs.writeFileSync(out, json + '\n', { mode: 0o600 });
      try {
        fs.chmodSync(out, 0o600);
      } catch (e) {
        /* non-POSIX FS */
      }
      note('📦 migrate bundle written to ' + style.bold("'" + out + "'") + ':');
      note(
        '   ' +
          built.counts.accounts +
          ' account(s), ' +
          built.counts.providers +
          ' provider(s), ' +
          built.counts.transcripts +
          ' transcript(s), ' +
          built.counts.memory +
          ' memory file(s), ' +
          built.counts.config +
          ' config item(s)' +
          (built.counts.agents ? ', ' + built.counts.agents + ' agent-memory file(s)' : '') +
          (built.counts.agentConfig
            ? ', ' +
              built.counts.agentConfig +
              ' agent-config file(s) (' +
              (fopts.agentConfigSecrets ? 'WITH API keys' : 'redacted') +
              ')'
            : '') +
          '.',
      );
    }
    built.skippedAccounts.forEach(function (n) {
      note('  ⚠️ account skipped (credentials unreadable): ' + n);
    });
    // Only accounts (login secrets), providers (API keys), and an opt-in agent-config-with-keys
    // are sensitive; a redacted/memory/sessions-only bundle carries none, so don't cry wolf.
    // Warn whenever a raw (un-redacted) agent-config rides an unencrypted bundle — NOT gated on
    // the heuristic scanner's hit count, since it can miss a real key under a benign name.
    const agentSecretsCarried =
      fopts.agentConfigSecrets &&
      (built.bundle.agentConfig || []).some(function (c) {
        return c.redacted === false;
      });
    const hasSecrets = built.counts.accounts || built.counts.providers || agentSecretsCarried;
    if (passphrase) note(style.ok('🔒') + ' encrypted (AES-256-GCM); import with the same --passphrase-file.');
    else if (hasSecrets)
      note(
        style.warn(
          '⚠️  This bundle CONTAINS SECRETS' + (agentSecretsCarried ? ' (incl. agent API keys)' : ' (login tokens)'),
        ) + ' — encrypt it (--passphrase-file <f>) or pipe through gpg, and delete it after importing.',
      );
    else
      note(
        style.dim(
          '   No account/provider secrets in this bundle (memory/sessions only), but encrypt it anyway if it leaves your machine.',
        ),
      );
    note(
      '   Desktop-app login and browser sessions are machine-bound — re-capture them on the new machine (' +
        style.bold('keyflip onboard') +
        ').',
    );
    logmod.log('migrate export: ' + built.counts.accounts + ' acct, ' + built.counts.transcripts + ' tx');
    jsonOut({ migrateExport: { path: out === '-' ? null : out, encrypted: !!passphrase, counts: built.counts } });
    return;
  }

  if (sub === 'import') {
    if (!target) return fail('usage: keyflip migrate import <file|-> [--force] [--passphrase-file <f>]');
    let raw;
    try {
      raw = target === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(target, 'utf8');
    } catch (e) {
      return fail('cannot read ' + target + ': ' + e.message);
    }
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      return fail('that file is not valid JSON');
    }
    // Encrypted bundle? (sync.encrypt envelope) — decrypt with the passphrase.
    if (obj && obj.magic === 'keyflip-sync') {
      if (!passphrase) return fail('this bundle is encrypted — pass --passphrase-file <file>');
      let plain;
      try {
        plain = sync.decrypt(raw, passphrase);
      } catch (e) {
        return fail(e.message);
      }
      try {
        obj = JSON.parse(plain);
      } catch (e) {
        return fail('decrypted bundle is not valid JSON');
      }
    }
    let res;
    try {
      res = migrate.applyBundle(ctx, obj, { force: force });
    } catch (e) {
      return fail(e.message);
    }
    const tx = res.transcripts;
    print(style.ok('✅') + ' merged this machine with the bundle:');
    print(
      '  accounts:    imported ' +
        (res.accounts.imported.join(', ') || '(none)') +
        (res.accounts.skipped.length ? '; kept existing: ' + res.accounts.skipped.join(', ') : ''),
    );
    print(
      '  providers:   imported ' +
        (res.providers.imported.join(', ') || '(none)') +
        (res.providers.skipped.length ? '; kept existing: ' + res.providers.skipped.join(', ') : ''),
    );
    print(
      '  transcripts: ' +
        tx.added +
        ' added, ' +
        tx.kept +
        ' already here (kept)' +
        (tx.overwritten ? ', ' + tx.overwritten + ' overwritten' : '') +
        (tx.skipped ? ', ' + tx.skipped + ' skipped' : ''),
    );
    const mem = res.memory || { added: 0, kept: 0, overwritten: 0 };
    print(
      '  memory:      ' +
        mem.added +
        ' added, ' +
        mem.kept +
        ' already here (kept)' +
        (mem.overwritten ? ', ' + mem.overwritten + ' overwritten' : ''),
    );
    const cfg = res.config || { written: [], kept: [] };
    print(
      '  config:      ' +
        (cfg.written.length ? cfg.written.join(', ') : 'none new') +
        (cfg.kept.length ? '  (kept: ' + cfg.kept.join(', ') + ')' : ''),
    );
    const ag = res.agents || { added: 0, kept: 0, overwritten: 0 };
    if (ag.total)
      print(
        '  agents:      ' +
          ag.added +
          ' added, ' +
          ag.kept +
          ' already here (kept)' +
          (ag.overwritten ? ', ' + ag.overwritten + ' overwritten' : '') +
          (ag.skipped ? ', ' + ag.skipped + ' skipped' : ''),
      );
    const agc = res.agentConfig || { total: 0 };
    if (agc.total) {
      const withKeys = (obj.agentConfig || []).some(function (c) {
        return c && c.redacted === false;
      });
      print(
        '  agent-config:' +
          agc.added +
          ' added, ' +
          agc.kept +
          ' already here (kept)' +
          (agc.overwritten ? ', ' + agc.overwritten + ' overwritten' : '') +
          (agc.skipped ? ', ' + agc.skipped + ' skipped' : '') +
          '  ' +
          style.dim(withKeys ? '(WITH API keys — the sender opted in)' : '(secrets redacted)'),
      );
    }
    if ((res.accounts.skipped.length || res.providers.skipped.length || tx.kept) && !force) {
      print(style.dim('  (existing entries were kept — re-run with --force to overwrite them instead.)'));
    }
    // Best-effort: let the desktop app see the combined session set too.
    if (rest.indexOf('--no-consolidate') === -1) {
      const cons = consolidateAndReport(ctx);
      if (cons && cons.reason)
        print(
          '  ↳ ' +
            style.dim(
              'desktop chat sync deferred: ' + cons.reason + ' (run `keyflip consolidate` with the app closed).',
            ),
        );
    }
    jsonOut({ migrated: { accounts: res.accounts, providers: res.providers, transcripts: tx } });
    logmod.log('migrate import: +' + tx.added + ' tx, ' + res.accounts.imported.length + ' acct');
    return;
  }

  // Cloud relay (no-LAN path): move the bundle through a WebDAV server, reusing
  // sync's encrypted transport. Passphrase is REQUIRED (the payload has secrets).
  if (sub === 'push') {
    const ui = rest.indexOf('--url');
    const url = ui !== -1 ? rest[ui + 1] : null;
    const useri = rest.indexOf('--user');
    const user = useri !== -1 ? rest[useri + 1] : null;
    if (!url || !passphrase)
      return fail(
        'usage: keyflip migrate push --url <webdav-url> --passphrase-file <f> [--user U --pass-file f] [--no-sessions] [--no-providers]',
      );
    const o = Object.assign(bundleFilterOpts(rest), {
      url: url,
      user: user,
      pass: readSecretArg(rest, '--pass-file'),
      passphrase: passphrase,
    });
    let counts;
    try {
      counts = await migrate.pushBundle(ctx, o);
    } catch (e) {
      return fail(e.message);
    }
    print(
      style.ok('☁️') +
        ' pushed an encrypted bundle: ' +
        counts.accounts +
        ' account(s), ' +
        counts.providers +
        ' provider(s), ' +
        counts.transcripts +
        ' transcript(s), ' +
        counts.memory +
        ' memory file(s)' +
        (counts.agents ? ', ' + counts.agents + ' agent-memory file(s)' : '') +
        '.',
    );
    print(
      '   On the other machine: ' + style.bold('keyflip migrate pull --url <same-url> --passphrase-file <same-file>'),
    );
    jsonOut({ migratePush: { counts: counts } });
    logmod.log('migrate push: ' + counts.accounts + ' acct, ' + counts.transcripts + ' tx');
    return;
  }
  if (sub === 'pull') {
    const ui = rest.indexOf('--url');
    const url = ui !== -1 ? rest[ui + 1] : null;
    const useri = rest.indexOf('--user');
    const user = useri !== -1 ? rest[useri + 1] : null;
    if (!url || !passphrase)
      return fail(
        'usage: keyflip migrate pull --url <webdav-url> --passphrase-file <f> [--user U --pass-file f] [--force]',
      );
    const o = { url: url, user: user, pass: readSecretArg(rest, '--pass-file'), passphrase: passphrase };
    let pulled;
    try {
      pulled = await migrate.pullBundle(ctx, o);
    } catch (e) {
      return fail(e.message);
    }
    if (!pulled.found) return fail('no bundle at that URL');
    const b = pulled.bundle || {};
    const nAcc = (b.accounts || []).length,
      nProv = (b.providers || []).length,
      nTx = (b.transcripts || []).length,
      nMem = (b.memory || []).length;
    print(
      'Remote bundle: ' +
        nAcc +
        ' account(s), ' +
        nProv +
        ' provider(s), ' +
        nTx +
        ' transcript(s), ' +
        nMem +
        ' memory file(s)' +
        (b.exportedAt ? ' from ' + b.exportedAt : '') +
        '.',
    );
    if (!force) {
      if (!process.stdin.isTTY) return fail('merging a pulled bundle non-interactively requires --force');
      const ok = await confirm('Merge it into this machine? Existing entries are kept unless --force. [y/N] ');
      if (!ok) {
        print('Cancelled.');
        return;
      }
    }
    let res;
    // Take the mutation lock ONLY for the write — not across the network pull + prompt above.
    try {
      res = await withLock(ctx, function () {
        return migrate.applyBundle(ctx, b, { force: force });
      });
    } catch (e) {
      return fail(e.message);
    }
    const tx = res.transcripts;
    print(
      style.ok('✅') +
        ' merged: accounts +' +
        res.accounts.imported.length +
        ' (kept ' +
        res.accounts.skipped.length +
        '), providers +' +
        res.providers.imported.length +
        ', transcripts +' +
        tx.added +
        ' (kept ' +
        tx.kept +
        (tx.overwritten ? ', overwrote ' + tx.overwritten : '') +
        '), memory +' +
        (res.memory ? res.memory.added : 0) +
        ' (kept ' +
        (res.memory ? res.memory.kept : 0) +
        ')' +
        (res.agents && res.agents.total
          ? ', agent-memory +' + res.agents.added + ' (kept ' + res.agents.kept + ')'
          : '') +
        '.',
    );
    if (rest.indexOf('--no-consolidate') === -1) {
      const cons = consolidateAndReport(ctx);
      if (cons && cons.reason)
        print(
          '  ↳ ' +
            style.dim(
              'desktop chat sync deferred: ' + cons.reason + ' (run `keyflip consolidate` with the app closed).',
            ),
        );
    }
    jsonOut({ migratePull: { accounts: res.accounts, providers: res.providers, transcripts: tx } });
    logmod.log('migrate pull: +' + tx.added + ' tx, ' + res.accounts.imported.length + ' acct');
    return;
  }

  return fail(
    'usage: keyflip migrate [export <file> | import <file> | push --url … | pull --url …] [--passphrase-file <f>] [--force] [--no-sessions] [--no-providers]',
  );
}

// Roadmap #10(a): LIVE device-to-device transfer over the LAN. `serve` shows a
// one-time code and streams the encrypted bundle; `pull` (optionally discovering
// the peer via a UDP beacon) fetches + MERGES it. No file, no cloud.
// G6: render the pairing info as a scannable terminal QR (opt-in via --qr on `transfer serve`).
function printTransferQR(rest, host, port, code, fp) {
  if (rest.indexOf('--qr') === -1) return;
  if (!host || host.indexOf('<') === 0) {
    print('   ' + style.dim('(no LAN address detected — QR skipped)'));
    return;
  }
  try {
    const qr = _qr;
    const url = _lan.pairingUrl(host, port, code, fp);
    print('');
    print('   ' + style.dim('Scan on the other machine (' + url + '):'));
    print(qr.toText(qr.encode(url, { ecc: 'M' }), { quiet: 2 }));
  } catch (e) {
    print('   ' + style.dim('(QR unavailable: ' + (e && e.message) + ')'));
  }
}

async function cmdTransfer(ctx, rest) {
  const lan = _lan;
  const migrate = _migrate;
  const sub = rest[0];
  const pi = rest.indexOf('--port');
  const port = pi !== -1 ? parseInt(rest[pi + 1], 10) || lan.DEFAULT_PORT : lan.DEFAULT_PORT;

  if (sub === 'serve' && rest.indexOf('--receive') !== -1) {
    // E3: RECEIVE mode — wait for the OTHER machine to PUSH its bundle here, then MERGE it.
    const ti = rest.indexOf('--ttl');
    const ttlS = ti !== -1 ? Math.max(15, parseInt(rest[ti + 1], 10) || 120) : 300;
    const force = rest.indexOf('--force') !== -1;
    const handle = lan.serveReceive(ctx, {
      port: port,
      ttlMs: ttlS * 1000,
      discovery: rest.indexOf('--no-discovery') === -1,
      onBundle: function (bundle) {
        const res = migrate.applyBundle(ctx, bundle, { force: force });
        if (rest.indexOf('--no-consolidate') === -1 && !appctl.isClaudeRunning(ctx.platform)) {
          try {
            appsessions.consolidate(ctx);
          } catch (e) {
            /* best-effort */
          }
        }
        const tx = res.transcripts,
          mem = res.memory || { added: 0 },
          ag = res.agents || { added: 0 };
        print(
          '\n' +
            style.ok('✅') +
            ' received + merged: accounts +' +
            res.accounts.imported.length +
            ', providers +' +
            res.providers.imported.length +
            ', transcripts +' +
            tx.added +
            ', memory +' +
            mem.added +
            (ag.added ? ', agent-memory +' + ag.added : '') +
            '.',
        );
        return {
          accounts: res.accounts.imported.length,
          providers: res.providers.imported.length,
          transcripts: tx.added,
          memory: mem.added,
          agents: ag.added,
        };
      },
    });
    const addrs = handle.addresses.length ? handle.addresses : ['<this-machine-ip>'];
    print(style.bold('📥 keyflip transfer — waiting to RECEIVE on this machine.'));
    print('   One-time code: ' + style.bold(handle.code) + '   (peer fingerprint ' + handle.fingerprint + ')');
    print('   On the machine that HAS the data, run:');
    addrs.forEach(function (ip) {
      print('     ' + style.bold('keyflip transfer push ' + ip + ':' + handle.port + ' --code ' + handle.code));
    });
    printTransferQR(rest, addrs[0], handle.port, handle.code, handle.fingerprint);
    print('   ' + style.dim('Auto-closes after one transfer or ' + ttlS + 's; Ctrl-C to stop.'));
    logmod.log('transfer serve --receive on ' + handle.port);
    const r = await handle.wait;
    if (r.reason === 'received') {
      try {
        _vcs.autoCommit(ctx, 'transfer receive');
      } catch (e) {
        /* best-effort */
      }
    }
    print(
      r.reason === 'received' ? style.ok('✅') + ' done — listener closed.' : 'Listener closed (' + r.reason + ').',
    );
    return;
  }

  if (sub === 'push') {
    const host = positionals(rest.slice(1), ['--code', '--port'].concat(BUNDLE_VALUE_FLAGS))[0] || null;
    const ci = rest.indexOf('--code');
    const code = ci !== -1 ? rest[ci + 1] : null;
    if (!code) return fail('pass --code XXXX (the one-time code shown on the RECEIVING machine).');
    if (!host)
      return fail(
        'usage: keyflip transfer push <host:port> --code XXXX   (start `keyflip transfer serve --receive` on the target first)',
      );
    const built = migrate.buildBundle(ctx, bundleFilterOpts(rest));
    if (
      !built.counts.accounts &&
      !built.counts.transcripts &&
      !built.counts.providers &&
      !built.counts.memory &&
      !built.counts.config &&
      !built.counts.agents &&
      !built.counts.agentConfig
    )
      return fail('nothing to send (no accounts, providers, transcripts, or memory match the filters).');
    print(
      'Pushing ' +
        built.counts.accounts +
        ' account(s), ' +
        built.counts.transcripts +
        ' transcript(s), ' +
        built.counts.memory +
        ' memory file(s)' +
        (built.counts.agents ? ', ' + built.counts.agents + ' agent-memory file(s)' : '') +
        (built.counts.agentConfig ? ', ' + built.counts.agentConfig + ' agent-config file(s)' : '') +
        ' to ' +
        style.bold(host) +
        '…',
    );
    let resp;
    try {
      resp = await lan.push({ host: host, code: code, bundle: built.bundle });
    } catch (e) {
      return fail(e.message);
    }
    const s = (resp && resp.summary) || {};
    print(
      style.ok('✅') +
        ' pushed + merged on the peer: accounts +' +
        (s.accounts || 0) +
        ', providers +' +
        (s.providers || 0) +
        ', transcripts +' +
        (s.transcripts || 0) +
        ', memory +' +
        (s.memory || 0) +
        (s.agents ? ', agent-memory +' + s.agents : '') +
        '.',
    );
    jsonOut({ pushed: s });
    return;
  }

  // Host your OWN relay: a minimal, zero-dep, self-contained blob store so two machines can
  // transfer over the INTERNET without a Nextcloud/WebDAV account (no Docker, no daemon — it
  // runs in this terminal). keyflip's WebDAV client (PUT/GET/DELETE) talks to it directly.
  if (sub === 'relay') {
    const relayserver = _relayserver;
    const dir = flagVal(rest, '--dir') || path.join(ctx.configDir, 'relay-store');
    const host = flagVal(rest, '--host') || '127.0.0.1';
    const port = flagVal(rest, '--port') ? parseInt(flagVal(rest, '--port'), 10) || 8788 : 8788;
    const authUser = flagVal(rest, '--auth-user');
    const auth = authUser ? { user: authUser, pass: readSecretArg(rest, '--auth-pass-file') || '' } : null;
    const allowOpen = rest.indexOf('--allow-open') !== -1;
    let h;
    try {
      h = await relayserver.start({ dir: dir, host: host, port: port, auth: auth, allowUnauthenticated: allowOpen });
    } catch (e) {
      return fail(e.message);
    }
    const shownHost = host === '0.0.0.0' || host === '::' ? lan.lanAddresses()[0] || '<this-machine-ip>' : host;
    print(style.bold('🛰  keyflip relay — hosting a blob rendezvous on this machine.'));
    print(
      '   URL for both machines: ' +
        style.bold('http://' + shownHost + ':' + h.port + '/kf') +
        (auth ? '  ' + style.dim('(Basic auth on)') : ''),
    );
    print('   Store: ' + style.dim(dir) + '   ·   blobs auto-expire; picked-up blobs are deleted.');
    if (!auth && host !== '127.0.0.1')
      print(
        '   ' +
          style.warn(
            '⚠ open (no --auth-user) and reachable off-host — anyone who can reach it can read/write ciphertext blobs.',
          ),
      );
    print(
      '   Then: ' +
        style.bold('keyflip transfer serve --relay http://' + shownHost + ':' + h.port + '/kf') +
        (auth ? ' --user <u> --pass-file <f>' : ''),
    );
    print('   ' + style.dim('Ctrl-C to stop.'));
    logmod.log('relay hosting on ' + host + ':' + h.port);
    await new Promise(function () {}); // keep the process alive until Ctrl-C
    return;
  }

  // Internet RELAY transfer: same one-time-code UX, but the encrypted bundle goes THROUGH a
  // user-controlled relay (a synced folder path OR a WebDAV/relay URL) instead of a LAN socket.
  const relayArg = flagVal(rest, '--relay');
  if (sub === 'serve' && relayArg) {
    const rt = _rt;
    const pair = rt.genPairing();
    const ropts = {
      relay: relayArg,
      code: pair.code,
      user: flagVal(rest, '--user') || undefined,
      pass: readSecretArg(rest, '--pass-file') || undefined,
      fetch: typeof fetch !== 'undefined' ? fetch : undefined,
    };
    const ti = rest.indexOf('--ttl');
    const ttlS = ti !== -1 ? Math.max(15, parseInt(rest[ti + 1], 10) || 300) : 300;
    let res;
    try {
      res = await rt.push(ctx, Object.assign(bundleFilterOpts(rest), ropts));
    } catch (e) {
      return fail(e.message);
    }
    print(style.bold('🔗 keyflip transfer — uploaded an encrypted bundle to the relay.'));
    print(
      '   Bundle: ' +
        res.counts.accounts +
        ' account(s), ' +
        res.counts.providers +
        ' provider(s), ' +
        res.counts.transcripts +
        ' transcript(s), ' +
        res.counts.memory +
        ' memory file(s)' +
        (res.counts.agents ? ', ' + res.counts.agents + ' agent-memory file(s)' : '') +
        '.',
    );
    print(
      '   One-time code: ' +
        style.bold(pair.code) +
        '   ' +
        style.dim('(<rendezvous>-<key>; the relay never sees the key)'),
    );
    print(
      '   On the OTHER machine: ' +
        style.bold('keyflip transfer pull --relay ' + relayArg + ' --code ' + pair.code) +
        (ropts.user ? ' --user ' + ropts.user + ' --pass-file <f>' : ''),
    );
    if (JSON_MODE) {
      jsonOut({ relayServe: { slot: res.slot, counts: res.counts } });
    }
    print(
      '   ' + style.dim('Waiting for pickup (up to ' + ttlS + 's); it is deleted on pickup. Ctrl-C to stop waiting.'),
    );
    let picked = { pickedUp: false };
    try {
      const be = rt.resolveBackend(relayArg, ropts);
      picked = await rt.awaitPickup(be, pair.code, { ttlMs: ttlS * 1000 });
    } catch (e) {
      /* best-effort live signal */
    }
    print(
      picked.pickedUp
        ? style.ok('✅') + ' picked up + deleted from the relay.'
        : style.warn('… not picked up yet') + ' — the blob remains on the relay until it is pulled or expires.',
    );
    logmod.log('transfer relay-serve (pickedUp=' + picked.pickedUp + ')');
    return;
  }

  if (sub === 'serve') {
    const ti = rest.indexOf('--ttl');
    const ttlS = ti !== -1 ? Math.max(15, parseInt(rest[ti + 1], 10) || 120) : 120;
    let handle;
    try {
      handle = lan.serve(
        ctx,
        Object.assign(bundleFilterOpts(rest), {
          port: port,
          ttlMs: ttlS * 1000,
          discovery: rest.indexOf('--no-discovery') === -1,
        }),
      );
    } catch (e) {
      return fail(e.message);
    }
    const addrs = handle.addresses.length ? handle.addresses : ['<this-machine-ip>'];
    print(style.bold('🔗 keyflip transfer — serving on this machine.'));
    print(
      '   Bundle: ' +
        handle.counts.accounts +
        ' account(s), ' +
        handle.counts.providers +
        ' provider(s), ' +
        handle.counts.transcripts +
        ' transcript(s), ' +
        handle.counts.memory +
        ' memory file(s)' +
        (handle.counts.agents ? ', ' + handle.counts.agents + ' agent-memory file(s)' : '') +
        '.',
    );
    print('   One-time code: ' + style.bold(handle.code) + '   (peer fingerprint ' + handle.fingerprint + ')');
    print('   On the OTHER machine, run one of:');
    addrs.forEach(function (ip) {
      print('     ' + style.bold('keyflip transfer pull ' + ip + ':' + handle.port + ' --code ' + handle.code));
    });
    if (rest.indexOf('--no-discovery') === -1)
      print(
        '   …or just ' +
          style.bold('keyflip transfer pull --code ' + handle.code) +
          ' (auto-discovers this machine on the LAN).',
      );
    printTransferQR(rest, addrs[0], handle.port, handle.code, handle.fingerprint);
    print('   ' + style.dim('Auto-closes after one transfer or ' + ttlS + 's; Ctrl-C to stop.'));
    logmod.log('transfer serve on ' + handle.port);
    const r = await handle.wait;
    print(
      r.reason === 'transferred'
        ? style.ok('✅') + ' bundle sent — listener closed.'
        : 'Listener closed (' + r.reason + ').',
    );
    return;
  }

  if (sub === 'pull' && relayArg) {
    const rt = _rt;
    const code = flagVal(rest, '--code');
    const force = rest.indexOf('--force') !== -1;
    if (!code) return fail('pass --code <rendezvous>-<key> (the one-time code shown on the sending machine).');
    let r;
    try {
      r = await rt.pull(ctx, {
        relay: relayArg,
        code: code,
        user: flagVal(rest, '--user') || undefined,
        pass: readSecretArg(rest, '--pass-file') || undefined,
        fetch: typeof fetch !== 'undefined' ? fetch : undefined,
      });
    } catch (e) {
      return fail(e.message);
    }
    if (!r.found) return fail('no transfer at that relay for this code (already picked up, expired, or wrong code).');
    const b = r.bundle || {};
    const nAcc = (b.accounts || []).length,
      nProv = (b.providers || []).length,
      nTx = (b.transcripts || []).length,
      nMem = (b.memory || []).length;
    print(
      'Received bundle: ' +
        nAcc +
        ' account(s), ' +
        nProv +
        ' provider(s), ' +
        nTx +
        ' transcript(s), ' +
        nMem +
        ' memory file(s).',
    );
    if (!force) {
      if (!process.stdin.isTTY) return fail('merging requires confirmation — re-run with --force');
      const ok = await confirm('Merge it into this machine? Existing entries are kept unless --force. [y/N] ');
      if (!ok) {
        print('Cancelled (the blob stays on the relay).');
        return;
      }
    }
    let res;
    try {
      res = await withLock(ctx, function () {
        return _migrate.applyBundle(ctx, b, { force: force });
      });
    } catch (e) {
      return fail(e.message);
    }
    try {
      await r.cleanup();
    } catch (e) {
      /* one-shot delete is best-effort; the relay TTL sweeps it otherwise */
    }
    const tx = res.transcripts;
    print(
      style.ok('✅') +
        ' merged: accounts +' +
        res.accounts.imported.length +
        ' (kept ' +
        res.accounts.skipped.length +
        '), providers +' +
        res.providers.imported.length +
        ', transcripts +' +
        tx.added +
        ' (kept ' +
        tx.kept +
        (tx.overwritten ? ', overwrote ' + tx.overwritten : '') +
        '), memory +' +
        (res.memory ? res.memory.added : 0) +
        ' (kept ' +
        (res.memory ? res.memory.kept : 0) +
        ')' +
        (res.agents && res.agents.total
          ? ', agent-memory +' + res.agents.added + ' (kept ' + res.agents.kept + ')'
          : '') +
        '. ' +
        style.dim('(deleted from the relay)'),
    );
    if (rest.indexOf('--no-consolidate') === -1) {
      const cons = consolidateAndReport(ctx);
      if (cons && cons.reason)
        print(
          '  ↳ ' +
            style.dim(
              'desktop chat sync deferred: ' + cons.reason + ' (run `keyflip consolidate` with the app closed).',
            ),
        );
    }
    jsonOut({ transferred: { accounts: res.accounts, providers: res.providers, transcripts: tx } });
    logmod.log('transfer relay-pull: +' + tx.added + ' tx');
    return;
  }

  if (sub === 'pull') {
    let host = positionals(rest.slice(1), ['--code', '--port', '--ttl'])[0] || null;
    const ci = rest.indexOf('--code');
    const code = ci !== -1 ? rest[ci + 1] : null;
    const force = rest.indexOf('--force') !== -1;
    if (!code) return fail('pass --code XXXX (the one-time code shown on the other machine).');
    if (!host) {
      print('Looking for a keyflip transfer on the LAN…');
      let peers = [];
      try {
        peers = await lan.discover(3000);
      } catch (e) {
        peers = [];
      }
      if (!peers.length)
        return fail('no peer found — run `keyflip transfer serve` on the other machine, or pass its <host:port>.');
      if (peers.length > 1) {
        print('  found ' + peers.length + ' peers:');
        peers.forEach(function (p, i) {
          print('   ' + (i + 1) + ') ' + (p.name || '') + ' ' + p.host + ':' + p.port + ' (fp ' + (p.fp || '?') + ')');
        });
        return fail('multiple peers — re-run: keyflip transfer pull <host:port> --code ' + code);
      }
      host = peers[0].host + ':' + peers[0].port;
      print('  found ' + (peers[0].name || host) + ' (' + host + ', fp ' + (peers[0].fp || '?') + ').');
    }
    let bundle;
    try {
      bundle = await lan.pull({ host: host, code: code });
    } catch (e) {
      return fail(e.message);
    }
    const nAcc = (bundle.accounts || []).length,
      nProv = (bundle.providers || []).length,
      nTx = (bundle.transcripts || []).length,
      nMem = (bundle.memory || []).length;
    print(
      'Received bundle: ' +
        nAcc +
        ' account(s), ' +
        nProv +
        ' provider(s), ' +
        nTx +
        ' transcript(s), ' +
        nMem +
        ' memory file(s).',
    );
    if (!force) {
      if (!process.stdin.isTTY) return fail('merging requires confirmation — re-run with --force');
      const ok = await confirm('Merge it into this machine? Existing entries are kept unless --force. [y/N] ');
      if (!ok) {
        print('Cancelled.');
        return;
      }
    }
    let res;
    // Lock ONLY the write — not the network fetch + confirm prompt above.
    try {
      res = await withLock(ctx, function () {
        return _migrate.applyBundle(ctx, bundle, { force: force });
      });
    } catch (e) {
      return fail(e.message);
    }
    const tx = res.transcripts;
    print(
      style.ok('✅') +
        ' merged: accounts +' +
        res.accounts.imported.length +
        ' (kept ' +
        res.accounts.skipped.length +
        '), providers +' +
        res.providers.imported.length +
        ', transcripts +' +
        tx.added +
        ' (kept ' +
        tx.kept +
        (tx.overwritten ? ', overwrote ' + tx.overwritten : '') +
        '), memory +' +
        (res.memory ? res.memory.added : 0) +
        ' (kept ' +
        (res.memory ? res.memory.kept : 0) +
        ')' +
        (res.agents && res.agents.total
          ? ', agent-memory +' + res.agents.added + ' (kept ' + res.agents.kept + ')'
          : '') +
        '.',
    );
    if (rest.indexOf('--no-consolidate') === -1) {
      const cons = consolidateAndReport(ctx);
      if (cons && cons.reason)
        print(
          '  ↳ ' +
            style.dim(
              'desktop chat sync deferred: ' + cons.reason + ' (run `keyflip consolidate` with the app closed).',
            ),
        );
    }
    jsonOut({ transferred: { accounts: res.accounts, providers: res.providers, transcripts: tx } });
    logmod.log('transfer pull: +' + tx.added + ' tx');
    return;
  }

  return fail(
    'usage: keyflip transfer <subcommand>\n' +
      '  LAN (direct):   serve [--port N] [--ttl S] [--no-discovery]   ·   pull [<host:port>] --code XXXX [--force]\n' +
      '  Internet relay: serve --relay <dir|url> [--user U --pass-file f]   ·   pull --relay <dir|url> --code <rendezvous>-<key> [--user U --pass-file f] [--force]\n' +
      '  Host a relay:   relay [--dir D] [--host H] [--port P] [--auth-user U --auth-pass-file f] [--allow-open]\n' +
      '  Filters: [--no-sessions] [--no-providers]',
  );
}

// Command-activated failover proxy (never a resident daemon).
// G1: `keyflip panel` — a command-activated local web dashboard (loopback, read-only).
async function cmdPanel(ctx, rest) {
  const panel = _panel;
  // G8: export a SHARE-SAFE static snapshot instead of serving (no session content, no secrets).
  const ei = rest.indexOf('--export');
  if (ei !== -1) {
    const out = rest[ei + 1] && rest[ei + 1].indexOf('-') !== 0 ? rest[ei + 1] : 'keyflip-snapshot.html';
    const snap = panel.buildSnapshot(ctx, { anon: rest.indexOf('--anon') !== -1 });
    const html = panel.renderSnapshot(snap);
    try {
      fs.writeFileSync(out, html);
    } catch (e) {
      return fail('could not write ' + out + ': ' + (e && e.message));
    }
    if (JSON_MODE) {
      jsonOut({ snapshot: { path: out, anon: snap.anon, accounts: snap.accounts.length } });
      return;
    }
    print(
      style.ok('📸') +
        ' shared snapshot written to ' +
        style.bold("'" + out + "'") +
        ' ' +
        style.dim(
          '(' +
            snap.accounts.length +
            ' account(s), ' +
            (snap.activity ? snap.activity.total : 0) +
            ' sessions/26wk' +
            (snap.anon ? ', anonymized' : '') +
            ')',
        ),
    );
    print(
      '   ' +
        style.dim('Static + self-contained: no session content, no secrets. Open it in any browser or share the file.'),
    );
    logmod.log('panel export -> ' + out);
    return;
  }
  const pi = rest.indexOf('--port');
  const port = pi !== -1 ? parseInt(rest[pi + 1], 10) || 8899 : 8899;
  let h;
  try {
    h = await panel.serve(ctx, { port: port });
  } catch (e) {
    return fail(
      'could not start the panel: ' +
        (e && e.code === 'EADDRINUSE' ? 'port ' + port + ' is in use (try --port N)' : e && e.message),
    );
  }
  print(
    style.ok('✅') +
      ' keyflip panel on ' +
      style.bold(h.url) +
      '  ' +
      style.dim('(read-only, loopback only; Ctrl-C to stop)'),
  );
  if (rest.indexOf('--open') !== -1) {
    const opener = ctx.platform === 'darwin' ? 'open' : ctx.platform === 'win32' ? 'cmd' : 'xdg-open';
    try {
      exec.run(opener, ctx.platform === 'win32' ? ['/c', 'start', h.url] : [h.url]);
    } catch (e) {
      /* ignore */
    }
  }
  logmod.log('panel on ' + h.port);
  await new Promise(function () {
    /* serve until the process is killed (Ctrl-C) */
  });
}

// G4: emit xbar/SwiftBar plugin output (or install a wrapper into a plugin folder). Plain
// stdout so the menu-bar host renders it verbatim.
function cmdMenubar(ctx, rest) {
  const menubar = _menubar;
  if (rest.indexOf('--install') !== -1) return menubarInstall(ctx, rest);
  process.stdout.write(menubar.render(ctx, {}) + '\n');
}
function menubarInstall(ctx, rest) {
  const menubar = _menubar;
  const iv = flagVal(rest, '--interval') || '30s';
  const di = rest.indexOf('--dir');
  let dir = di !== -1 ? rest[di + 1] : null;
  // The plugin format (a script whose stdout is the menu, filename `keyflip.<interval>.sh`) is shared
  // by macOS xbar/SwiftBar AND Linux GNOME Argos / KDE kargos — the same render + script installs on
  // both; only the host + folder differ (resolved by the pure menubar.pluginTarget).
  let host = 'xbar/SwiftBar';
  if (!dir) {
    const tgt = menubar.pluginTarget(ctx.platform, ctx.home, process.env.XDG_CONFIG_HOME);
    if (!tgt)
      return fail(
        'no built-in menu-bar host on ' +
          ctx.platform +
          ' — pass --dir <a folder your tray tool watches>. `keyflip menubar` emits the xbar/Argos plugin format any compatible host can render.',
      );
    host = tgt.host;
    if (tgt.mustExist && !fs.existsSync(tgt.dir))
      return fail(
        'no ' +
          host +
          ' plugin folder found — pass --dir <your SwiftBar/xbar plugins folder>. (Then it refreshes every ' +
          iv +
          '.)',
      );
    dir = tgt.dir;
  }
  const ex = menubar.resolveExec({});
  const cmd =
    [ex.exec]
      .concat(ex.pre)
      .map(function (p) {
        return /\s/.test(p) ? '"' + p + '"' : p;
      })
      .join(' ') + ' menubar';
  const script =
    '#!/bin/bash\n# keyflip menu-bar plugin (' + host + '). Refreshes every ' + iv + '.\nexec ' + cmd + '\n';
  const file = path.join(dir, 'keyflip.' + iv + '.sh');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, script);
    fs.chmodSync(file, 0o755);
  } catch (e) {
    return fail('could not write the plugin: ' + (e && e.message));
  }
  if (JSON_MODE) {
    jsonOut({ menubarInstall: { path: file, interval: iv, host: host } });
    return;
  }
  print(style.ok('✅') + ' menu-bar plugin installed: ' + style.bold(file));
  print(
    '   ' + style.dim('Open ' + host + ' (or Refresh all) to see it. It re-runs `keyflip menubar` every ' + iv + '.'),
  );
}

async function cmdProxy(ctx, rest) {
  const sub = rest[0];
  const meta = proxy.readMeta(ctx);
  const running = proxy.isRunning(ctx);

  if (sub === 'start') {
    if (running) return fail('proxy already running on 127.0.0.1:' + meta.port + ' (pid ' + meta.pid + ')');
    const pi = rest.indexOf('--port');
    const port = pi !== -1 ? parseInt(rest[pi + 1], 10) : proxy.DEFAULT_PORT;
    const wire = rest.indexOf('--wire') !== -1;
    const r = proxy.start(ctx, { wire: wire, port: port });
    if (r.wireError) print(style.warn('⚠️ could not wire settings.json: ' + r.wireError));
    print(style.ok('✅') + ' proxy started on ' + r.url + ' (pid ' + r.pid + ')');
    print(
      wire && !r.wireError
        ? 'Wired: Claude Code now routes through it (ANTHROPIC_BASE_URL set). Stop with: keyflip proxy stop'
        : 'Point Claude Code at it:  export ANTHROPIC_BASE_URL=' + r.url + '   (or start with --wire)',
    );
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
    if (JSON_MODE) {
      jsonOut({ running: !!running, meta: meta });
      return;
    }
    if (!running) {
      print('proxy: not running (start it with: keyflip proxy start [--wire])');
      return;
    }
    print('proxy: running on ' + meta.url + ' (pid ' + meta.pid + ')' + (meta.wired ? ', wired' : ''));
    const st = proxy.stats(ctx);
    print(
      '  routed ' + st.total + ' request(s); accounts used: ' + (Object.keys(st.byAccount).join(', ') || 'none yet'),
    );
    return;
  }
  if (sub === 'stats') {
    const st = proxy.stats(ctx);
    if (JSON_MODE) {
      jsonOut(st);
      return;
    }
    print('Proxy usage (' + st.total + ' requests):');
    Object.keys(st.byAccount).forEach(function (a) {
      const x = st.byAccount[a];
      print('  ' + a + ': ' + x.requests + ' req, ' + x.inputTokens + ' in / ' + x.outputTokens + ' out tokens');
    });
    if (!st.total) print('  (nothing yet)');
    return;
  }
  return fail('usage: keyflip proxy [start [--port N] [--wire] | stop | status | stats]');
}

// The detached background server. Runs until killed.
async function proxyServe(ctx, rest) {
  const pi = rest.indexOf('--port');
  const port = pi !== -1 ? parseInt(rest[pi + 1], 10) : proxy.DEFAULT_PORT;
  logmod.log('proxy serving on ' + port);
  await proxy.serve(ctx, { port: port });
  return new Promise(function () {
    /* run forever until the process is killed */
  });
}

// Cowork sessions (desktop app agent-mode), cross-account, local & read-only.
function cmdCowork(ctx, rest) {
  const cowork = _cowork;
  if (!ctx.appDataDir) return fail('the Claude desktop app (macOS) is required for Cowork sessions');
  const sub = rest[0];
  if (sub === 'resume') {
    let row;
    try {
      row = cowork.find(ctx, rest[1]);
    } catch (e) {
      return fail(e.message);
    }
    if (!row) return fail('no such cowork session: ' + (rest[1] || ''));
    const rc = cowork.resumeCommand(row);
    if (!rc) return fail('this Cowork session has no underlying Claude Code session to resume');
    print('Resume it with:  cd ' + (rc.cwd || '<dir>') + ' && ' + rc.command + ' ' + rc.args.join(' '));
    return;
  }
  const rows = cowork.list(ctx, {
    search: flagVal(rest, '--search'),
    limit: parseInt(flagVal(rest, '--limit'), 10) || 40,
    includeArchived: rest.indexOf('--all') !== -1,
  });
  if (JSON_MODE) {
    jsonOut({
      cowork: rows.map(function (r) {
        return {
          sessionId: r.sessionId,
          title: r.title,
          account: r.account,
          cwd: r.cwd,
          lastActivityAt: r.lastActivityAt,
          cliSessionId: r.cliSessionId,
        };
      }),
    });
    return;
  }
  if (!rows.length) {
    print('No Cowork sessions found.');
    return;
  }
  rows.forEach(function (r, i) {
    print(
      '  [' +
        (i + 1) +
        '] ' +
        (r.title || r.sessionId.slice(0, 8)) +
        '   ' +
        style.dim(r.account || '?') +
        '   ' +
        String(r.lastActivityAt || '')
          .slice(0, 16)
          .replace('T', ' '),
    );
    if (r.initialMessage) print('        ' + style.dim('“' + r.initialMessage + '”'));
  });
  print('');
  print('Resume:  keyflip cowork resume <number|id>');
}

// EXPERIMENTAL: read claude.ai cloud Chat conversations (per active account).
async function cmdChat(ctx, rest) {
  const chat = _chat;
  // Reading claude.ai chats decrypts a claude.ai session cookie via the macOS keychain — it is
  // macOS-only for now. Gate on the PLATFORM (not just appDataDir, which is also set on Windows) so
  // Windows/Linux get a clear message instead of a confusing failure deep in the cookie decrypt.
  if (ctx.platform !== 'darwin')
    return fail(
      'reading claude.ai Chat is macOS-only for now (Windows/Linux cookie decryption is not wired up yet — see docs/PORTING.md).',
    );
  const sub = rest[0];
  const flushFirst = rest.indexOf('--flush') !== -1 || rest.indexOf('--restart') !== -1;
  const asArg = flagVal(rest, '--as');
  let as = null;
  if (asArg) {
    as = core.resolveProfile(ctx, asArg);
    if (!as) return fail("no such saved account: '" + asArg + "' (see: keyflip list)");
  }
  const opts = { account: as, limit: parseInt(flagVal(rest, '--limit'), 10) || 0 };
  // Until a session is found we only know WHICH account was asked for; chatsession then
  // reports the surface it actually read it from (the app, Chrome, a saved snapshot).
  let src = as ? "saved login of '" + as + "'" : 'the live login';

  // A cookie can be in memory rather than on disk, and the right source depends on the
  // build, so resolve it per read — a --flush retry then re-looks it up afterwards.
  function resolved() {
    const o = _chatsession.withSession(ctx, opts);
    if (o.sessionSource) src = o.sessionSource;
    return o;
  }

  // A cookie the app never wrote out is fixed by one clean quit — so close the app,
  // read, and put it back the way it was. Never done for --as (a saved snapshot
  // belongs to another account; closing this app would not refresh it).
  async function withFlush(read) {
    try {
      return await read();
    } catch (e) {
      const flushable =
        (e && (e.code === 'cookies-not-flushed' || e.code === 'no-session')) || /403/.test(String(e && e.message));
      if (!flushable || as || !appctl.canManageApp(ctx.platform)) throw e;
      if (!appctl.isClaudeRunning(ctx.platform)) throw e;
      if (!flushFirst) {
        if (!process.stdin.isTTY)
          throw new Error(e.message + ' (or re-run with --flush to let keyflip close and reopen the app for you)');
        const ok = await confirm(
          'The app has not flushed its session cookie yet. Briefly close & reopen Claude to read it? [y/N] ',
        );
        if (!ok) throw e;
      }
      print('Quitting Claude (so it writes its cookies out)...');
      appctl.quitClaude(ctx.platform);
      await waitForQuit(ctx);
      if (appctl.isDesktopAppRunning(ctx.platform)) {
        return fail('Claude did not close, so nothing was changed — quit it with Cmd+Q and retry.');
      }
      let out = null,
        err = null;
      try {
        out = await read();
      } catch (e2) {
        err = e2;
      }
      print('Reopening Claude...');
      appctl.openClaude(ctx.platform);
      if (err) throw err;
      return out;
    }
  }

  function showConversation(conv) {
    if (JSON_MODE) return jsonOut({ source: src, conversation: conv });
    print(conv.name || '(untitled)');
    print(style.dim('  ' + (conv.uuid || '') + '  ·  ' + src));
    (conv.chat_messages || []).forEach(function (m) {
      const text = (m.content || [])
        .filter(function (b) {
          return b.type === 'text';
        })
        .map(function (b) {
          return b.text;
        })
        .join('');
      print('  ' + (m.sender === 'human' ? '›' : '‹') + ' ' + text.replace(/\s+/g, ' ').slice(0, 200));
    });
  }

  function showConversations(r) {
    if (JSON_MODE) return jsonOut(Object.assign({ source: src }, r));
    print('claude.ai Chat conversations (' + src + '):');
    if (!r.conversations.length) {
      print('  (none — this account has no cloud Chat conversations)');
      return;
    }
    r.conversations.forEach(function (c) {
      print(
        '  ' +
          String(c.updatedAt || '')
            .slice(0, 16)
            .replace('T', ' ') +
          '  ' +
          c.name +
          '   ' +
          style.dim(c.uuid.slice(0, 8)),
      );
    });
    print('');
    print('Read one:  keyflip chat get <short-id-or-title>   Find:  keyflip chat search "<words>"');
  }

  try {
    if (sub === 'get') {
      if (!rest[1]) return fail('usage: keyflip chat get <conversation-id|short-id|title> [--as <account>]');
      showConversation(
        await withFlush(function () {
          return chat.get(ctx, rest[1], resolved());
        }),
      );
      return;
    }
    if (sub === 'search') {
      const term = rest[1] && rest[1].indexOf('-') === 0 ? '' : rest[1] || '';
      const r = await withFlush(function () {
        return chat.search(ctx, term, resolved());
      });
      if (JSON_MODE) return jsonOut(Object.assign({ source: src }, r));
      print('claude.ai Chat titles matching "' + term + '" (' + src + '):');
      if (!r.matches.length) {
        print('  none of the ' + r.scanned + ' most recent chats match');
        print('  (only TITLES are searched; for message bodies use: keyflip recall "<query>")');
        return;
      }
      r.matches.forEach(function (c) {
        print('  ' + c.name + '   ' + style.dim(c.uuid.slice(0, 8)));
      });
      print('');
      print('Read one:  keyflip chat get <short-id>');
      return;
    }
    showConversations(
      await withFlush(function () {
        return chat.list(ctx, resolved());
      }),
    );
  } catch (e) {
    return fail(e.message);
  }
}

// Skills marketplace: install arbitrary skills from GitHub/dir/archive.
async function cmdSkill(ctx, rest) {
  const skillstore = _skillstore;
  const sub = rest[0];
  const args = rest.slice(1);
  if (sub === 'add') {
    const src = args.filter(function (a) {
      return a.indexOf('-') !== 0;
    })[0];
    if (!src)
      return fail('usage: keyflip skill add <owner/repo[@ref][/subdir] | ./dir | file.tar.gz> [--link] [--force]');
    let r;
    try {
      r = await skillstore.add(ctx, src, {
        link: args.indexOf('--link') !== -1,
        force: args.indexOf('--force') !== -1,
      });
    } catch (e) {
      return fail(e.message);
    }
    print(
      style.ok('✅') +
        ' installed ' +
        r.length +
        ' skill(s): ' +
        r
          .map(function (s) {
            return s.name + ' (' + s.mode + ')';
          })
          .join(', '),
    );
    print('Claude Code picks them up next session.');
    return;
  }
  if (sub === 'list' || sub === undefined) {
    const items = skillstore.list(ctx);
    if (JSON_MODE) {
      jsonOut({ skills: items });
      return;
    }
    if (!items.length) {
      print('No keyflip-installed skills (add one: keyflip skill add owner/repo).');
      return;
    }
    items.forEach(function (s) {
      print('  ' + s.name + '   ' + (s.source || '') + '   [' + s.mode + ']');
    });
    return;
  }
  if (sub === 'remove' || sub === 'rm') {
    try {
      skillstore.remove(ctx, args[0]);
    } catch (e) {
      return fail(e.message);
    }
    print('🗑  removed skill: ' + args[0]);
    return;
  }
  return fail('usage: keyflip skill [add <src>|list|remove <name>]');
}

// Session manager: browse/search/resume Claude Code conversations (all accounts).
function flagVal(rest, flag) {
  const i = rest.indexOf(flag);
  return i !== -1 ? rest[i + 1] : null;
}
// `keyflip sessions rebind <old-path> <new-path>` — re-link a project's chat history
// after its folder was renamed/moved (Claude keys transcripts by the encoded cwd and
// refuses a session whose cwd is gone, so a rename orphans the whole history).
function fmtBytes(n) {
  n = n || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
// Parse "30d" / "4w" / "6m" / "90" (bare = days) -> number of days, or null.
function parseDays(s) {
  const m = /^(\d+)\s*(d|w|m|day|days|week|weeks|month|months)?$/i.exec(String(s || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 10),
    u = (m[2] || 'd').toLowerCase()[0];
  return u === 'w' ? n * 7 : u === 'm' ? n * 30 : n;
}

// `keyflip sessions archive <id> | --older-than <30d>` (B1/B2): gzip transcripts into
// keyflip's archive store and remove the live copies. Reversible via `unarchive`.
async function cmdSessionsArchive(ctx, rest) {
  const archive = _archive;
  const yes = rest.indexOf('-y') !== -1 || rest.indexOf('--force') !== -1;
  const oi = rest.indexOf('--older-than');
  let targets = [];
  if (oi !== -1) {
    const days = parseDays(rest[oi + 1]);
    if (!days) return fail('usage: keyflip sessions archive --older-than <30d|4w|90>');
    const cutoff = Date.now() - days * 86400000;
    targets = sessions
      .list(ctx, { limit: 100000 })
      .filter(function (r) {
        return r.mtimeMs < cutoff;
      })
      .map(function (r) {
        return { project: r.project, sessionId: r.sessionId };
      });
    if (!targets.length) return fail('no sessions older than ' + days + ' day(s).');
    print(
      'Archive ' +
        style.bold(String(targets.length)) +
        ' session(s) older than ' +
        days +
        ' day(s) — gzipped into keyflip (reversible: keyflip sessions unarchive).',
    );
  } else {
    const id = positionals(rest, [])[0];
    if (!id) return fail('usage: keyflip sessions archive <id> | --older-than <30d>');
    let row;
    try {
      row = sessions.find(ctx, id);
    } catch (e) {
      return fail(e.message);
    }
    if (!row) return fail("no live session matches '" + id + "'.");
    targets = [{ project: row.project, sessionId: row.sessionId }];
    print('Archive session ' + style.bold(row.sessionId.slice(0, 8)) + ' (' + (row.cwd || '?') + ').');
  }
  if (!yes) {
    if (!process.stdin.isTTY) return fail('re-run with -y to confirm.');
    if (!(await confirm('Proceed? [y/N] '))) {
      print('Cancelled.');
      return;
    }
  }
  let done = 0,
    savedIn = 0,
    savedGz = 0;
  await withLock(ctx, function () {
    targets.forEach(function (t) {
      const r = archive.archiveSession(ctx, t.project, t.sessionId);
      if (r.ok) {
        done++;
        savedIn += r.bytes;
        savedGz += r.gzBytes;
      }
    });
  });
  print(
    style.ok('✅') +
      ' archived ' +
      done +
      ' session(s)' +
      (savedIn ? ' (' + fmtBytes(savedIn) + ' → ' + fmtBytes(savedGz) + ' gzipped)' : '') +
      '.',
  );
  jsonOut({ archived: { count: done, bytes: savedIn, gzBytes: savedGz } });
}

async function cmdSessionsUnarchive(ctx, rest) {
  const archive = _archive;
  const id = positionals(rest, [])[0];
  if (!id) return fail('usage: keyflip sessions unarchive <id>   (list with: keyflip sessions archived)');
  const row = archive.findArchived(ctx, id);
  if (!row) return fail("no archived session matches '" + id + "'.");
  let r;
  await withLock(ctx, function () {
    r = archive.unarchiveSession(ctx, row.project, row.sessionId);
  });
  if (!r.ok) return fail('unarchive failed: ' + (r.reason || 'unknown'));
  print(style.ok('✅') + ' restored ' + row.sessionId.slice(0, 8) + ' → ' + r.dest);
  jsonOut({ unarchived: row.sessionId });
}

function cmdSessionsArchived(ctx) {
  const rows = _archive.listArchived(ctx);
  if (JSON_MODE) {
    jsonOut({
      archived: rows.map(function (r) {
        return { sessionId: r.sessionId, project: r.project, gzBytes: r.gzBytes, mtime: r.mtime };
      }),
    });
    return;
  }
  if (!rows.length) {
    print('No archived sessions. Archive some with: keyflip sessions archive --older-than 30d');
    return;
  }
  let total = 0;
  rows.forEach(function (r, i) {
    total += r.gzBytes;
    print(
      '  [' +
        (i + 1) +
        '] ' +
        r.sessionId.slice(0, 8) +
        '  ' +
        r.mtime.slice(0, 16).replace('T', ' ') +
        '  ' +
        fmtBytes(r.gzBytes) +
        '  ' +
        sessions.decodeProjectDir(r.project),
    );
  });
  print('\n' + rows.length + ' archived (' + fmtBytes(total) + ' gzipped). Restore: keyflip sessions unarchive <id>');
}

// A2: assign a session to a specific account, so `keyflip resume <id> --run` continues it
// AS that account (isolated) without switching the machine's active profile.
function cmdSessionsAssign(ctx, rest) {
  const sessionmap = _sessionmap;
  const pos = positionals(rest, []);
  const id = pos[0],
    acct = pos[1];
  if (!id || !acct) return fail('usage: keyflip sessions assign <id> <account>');
  let row;
  try {
    row = sessions.find(ctx, id);
  } catch (e) {
    return fail(e.message);
  }
  if (!row) return fail("no session matches '" + id + "'.");
  const name = core.resolveProfile(ctx, acct);
  if (!name) return fail("no such account: '" + acct + "' (see: keyflip list)");
  sessionmap.set(ctx, row.sessionId, name);
  // Provenance: this is the user's word, so an earlier guess for the same session is replaced —
  // otherwise the threads screen would keep calling a confirmed account a guess (and vice versa:
  // `sessions attribute` never relabels a guess as stated).
  attrib.recordStated(ctx, row.sessionId, { account: name, at: ctx.now() });
  print(
    style.ok('✅') +
      ' assigned session ' +
      style.bold(row.sessionId.slice(0, 8)) +
      ' → ' +
      style.bold(profiles.email(ctx.configDir, name) || name) +
      '.  Resume it there: ' +
      style.bold('keyflip resume ' + row.sessionId.slice(0, 8) + ' --run') +
      ' (no profile switch).',
  );
  jsonOut({ assigned: { session: row.sessionId, account: name } });
}
function cmdSessionsUnassign(ctx, rest) {
  const sessionmap = _sessionmap;
  const id = positionals(rest, [])[0];
  if (!id) return fail('usage: keyflip sessions unassign <id>');
  let row;
  try {
    row = sessions.find(ctx, id);
  } catch (e) {
    row = null;
  }
  const key = row ? row.sessionId : id;
  const had = sessionmap.unset(ctx, key);
  attrib.removeSource(ctx, key); // an unassigned session has no provenance either
  print(
    had ? style.ok('✅') + ' unassigned ' + key.slice(0, 8) + '.' : 'session ' + key.slice(0, 8) + ' was not assigned.',
  );
  jsonOut({ unassigned: key });
}

// #50: infer WHICH ACCOUNT each session was worked on from keyflip's own switch timeline, so
// `threads suggest` stops returning empty for a history that IS split across accounts. Dry-run by
// default: proposals are printed and nothing is written; --apply fills only the gaps (a stated
// `sessions assign` is never proposed over, and a guess is never stored as if it were the word).
function cmdSessionsAttribute(ctx, rest) {
  const apply = rest.indexOf('--apply') !== -1;
  const limit = parseInt(flagVal(rest, '--limit'), 10) || 200;
  const minConf = flagVal(rest, '--min-confidence');
  const rank = { low: 0, medium: 1, high: 2 };
  const floor = minConf && rank[minConf] != null ? rank[minConf] : 0;
  let r;
  try {
    r = attrib.proposals(ctx, { limit: limit });
  } catch (e) {
    return fail(e.message);
  }
  const usable = r.proposals.filter(function (p) {
    return rank[p.confidence] >= floor;
  });
  if (JSON_MODE) {
    const written = apply ? attrib.apply(ctx, usable, { at: ctx.now() }) : [];
    jsonOut({
      attribute: {
        dryRun: !apply,
        coverage: r.coverage,
        counts: Object.assign({}, r.counts, { filtered: r.proposals.length - usable.length }),
        proposals: usable,
        applied: written,
      },
    });
    return;
  }
  if (!r.coverage.switches) {
    print(
      style.warn('⚠') +
        " the action log holds no switch yet, so there is nothing to infer from. Switch once ('" +
        style.bold('keyflip <account>') +
        "') and retry.",
    );
    return;
  }
  print(
    style.bold('Switch timeline') +
      ': ' +
      r.coverage.switches +
      ' account change(s), earliest ' +
      style.dim(String(r.coverage.from).slice(0, 16) + 'Z') +
      (r.coverage.partial ? style.dim('  (older history is beyond the log read — treated as no evidence)') : ''),
  );
  print(
    style.dim(
      '  scanned ' +
        r.counts.scanned +
        ' session(s): ' +
        r.counts.stated +
        ' stated by hand, ' +
        r.counts.inferred +
        ' already attributed' +
        (r.counts.noEvidence ? ', ' + r.counts.noEvidence + ' with no evidence' : '') +
        (r.counts.unknownAccount ? ', ' + r.counts.unknownAccount + ' pointing at a removed account' : ''),
    ),
  );
  if (!usable.length) {
    print('');
    print(
      r.counts.proposed
        ? style.warn('⚠') + ' ' + r.counts.proposed + ' proposal(s) sit below --min-confidence ' + minConf + '.'
        : style.ok('✅') + ' nothing to attribute — every session in view is already assigned or undatable.',
    );
    return;
  }
  print('');
  usable.forEach(function (p) {
    const tag =
      p.confidence === 'high'
        ? style.ok(p.confidence)
        : p.confidence === 'medium'
          ? style.bold(p.confidence)
          : style.warn(p.confidence);
    const proj = (p.project || '').replace(/^-/, '/').replace(/-/g, '/');
    print(
      '  ' +
        style.bold(p.session.slice(0, 8)) +
        '  ' +
        style.dim(proj.length > 40 ? '…' + proj.slice(-39) : proj.padEnd(40).slice(0, 40)) +
        ' → ' +
        style.bold(p.account) +
        '  ' +
        tag +
        (p.spanning ? style.warn(' ⚠ spans a switch') : ''),
    );
    print('           ' + style.dim(p.why + '  ·  last write ' + String(p.lastActivity).slice(0, 16) + 'Z'));
  });
  print('');
  if (apply) {
    const written = attrib.apply(ctx, usable, { at: ctx.now() });
    print(
      style.ok('✅') +
        ' attributed ' +
        written.length +
        ' session(s). ' +
        style.dim(
          'Recorded as a GUESS, not as your word: ' +
            String(
              usable.filter(function (p) {
                return p.confidence !== 'high';
              }).length,
            ) +
            ' of them are uncertain — correct any of them with keyflip sessions assign <id> <account>.',
        ),
    );
    print(style.dim('  Next: keyflip threads suggest   (fragments are now visible)'));
  } else {
    print(
      style.warn('⚠') +
        ' nothing written — ' +
        style.bold(usable.length) +
        ' proposal(s) await: re-run with ' +
        style.bold('--apply') +
        ' (' +
        r.counts.high +
        ' high-confidence, ' +
        (r.counts.proposed - r.counts.high) +
        ' uncertain).',
    );
  }
}

// B3: compact a transcript — elide bulky tool output, keep the conversation. Dry-run by
// default (shows the size reduction); --apply rewrites it in place (git is the undo net).
async function cmdSessionsCompact(ctx, rest) {
  const id = positionals(rest, [])[0];
  if (!id) return fail('usage: keyflip sessions compact <id> [--apply]');
  let row;
  try {
    row = sessions.find(ctx, id);
  } catch (e) {
    return fail(e.message);
  }
  if (!row) return fail("no session matches '" + id + "'.");
  let content;
  try {
    content = fs.readFileSync(row.file, 'utf8');
  } catch (e) {
    return fail('cannot read the transcript.');
  }
  const r = sessions.compactTranscript(content, {});
  if (r.elided === 0) {
    print('Nothing to compact in ' + row.sessionId.slice(0, 8) + ' (no bulky tool output).');
    return;
  }
  const saved = r.before - r.after;
  print(
    'Compact ' +
      style.bold(row.sessionId.slice(0, 8)) +
      ': ' +
      fmtBytes(r.before) +
      ' → ' +
      fmtBytes(r.after) +
      '  (' +
      fmtBytes(saved) +
      ' saved, ' +
      r.elided +
      ' tool-output block(s) elided)' +
      (rest.indexOf('--apply') === -1 ? '  ' + style.dim('[dry run — add --apply to rewrite]') : ''),
  );
  if (rest.indexOf('--apply') === -1) {
    jsonOut({ compact: { before: r.before, after: r.after, elided: r.elided, applied: false } });
    return;
  }
  // The transcript lives in ~/.claude/projects (outside keyflip's git), so back the
  // original up next to it before rewriting — reversible without git.
  let bak = null;
  try {
    bak = row.file + '.precompact';
    fs.writeFileSync(bak, content);
  } catch (e) {
    bak = null;
  }
  try {
    fs.writeFileSync(row.file, r.compacted);
  } catch (e) {
    return fail('could not rewrite the transcript.');
  }
  print(style.ok('✅') + ' rewrote the transcript' + (bak ? ' (original backed up to ' + bak + ')' : '') + '.');
  jsonOut({ compact: { before: r.before, after: r.after, elided: r.elided, applied: true, backup: bak } });
}

// C2: install/remove the nightly `keyflip dream --apply` schedule (launchd on macOS, cron
// on Linux). Command-activated — the user runs it; nothing daemonizes on its own.
async function cmdDreamSchedule(ctx, rest) {
  const schedule = _schedule;
  const prov = _llm.resolve(ctx);
  const sub = rest[0];
  if (sub === 'status') {
    const st = schedule.status(ctx);
    if (JSON_MODE) {
      jsonOut({ dreamSchedule: Object.assign({}, st, { willUse: prov }) });
      return;
    }
    print(
      'Nightly dream: ' +
        (st.installed
          ? style.ok('scheduled') + ' (' + st.kind + (st.path ? ', ' + st.path : '') + ')'
          : style.warn('not scheduled')),
    );
    if (st.installed) {
      // The job resolves its provider when it RUNS, so this is the live truth, not the install-time
      // receipt. Show both when they differ — that is how a silent cost change becomes visible.
      print('  ' + style.dim('tonight it distills via ') + style.bold(prov.display) + style.dim(' — ' + prov.cost));
      if (st.recorded && st.recorded.provider && st.recorded.provider !== prov.provider)
        print(
          '  ' +
            style.warn('·') +
            ' installed expecting ' +
            st.recorded.provider +
            '; it now resolves to ' +
            prov.provider +
            '.',
        );
    }
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
  const ai = rest.indexOf('--at');
  const at = ai !== -1 ? rest[ai + 1] : '03:00';
  const oi = rest.indexOf('--older-than');
  const days = oi !== -1 ? parseDays(rest[oi + 1]) || 30 : 30;
  const archiveToo = rest.indexOf('--archive') !== -1;
  print(
    'This installs a ' +
      (ctx.platform === 'darwin' ? 'launchd agent' : 'crontab entry') +
      ' that runs ' +
      style.bold('keyflip dream --apply --older-than ' + days + 'd' + (archiveToo ? ' --archive' : '')) +
      ' daily at ' +
      at +
      '.',
  );
  print(
    style.dim(
      '  It distills old chats into keepsakes unattended, via ' +
        prov.display +
        ' — ' +
        prov.cost +
        '.' +
        (prov.provider === 'claude' ? ' Set `keyflip llm set --provider ollama` first to keep it off your plan.' : ''),
    ),
  );
  print(style.dim('  Remove with: keyflip dream unschedule.'));
  if (rest.indexOf('-y') === -1 && rest.indexOf('--force') === -1) {
    if (!process.stdin.isTTY) return fail('re-run with -y to confirm.');
    if (!(await confirm('Install the nightly schedule? [y/N] '))) {
      print('Cancelled.');
      return;
    }
  }
  const r = schedule.install(ctx, {
    at: at,
    days: days,
    archive: archiveToo,
    provider: prov.provider,
    model: prov.model,
  });
  if (!r.ok) return fail('could not schedule: ' + (r.reason || r.detail || 'unknown'));
  print(
    style.ok('✅') +
      ' scheduled nightly dream at ' +
      at +
      ' (' +
      r.kind +
      '). ' +
      style.dim('Status: keyflip dream status'),
  );
  jsonOut({
    dreamSchedule: { installed: true, at: at, kind: r.kind, provider: prov.provider, model: prov.model || null },
  });
}

// ---- #40 WHERE THE CHORES RUN ----------------------------------------------------------------------------------
// `dream`, `sessions distill` and `recall --answer` summarize old transcripts. That is bookkeeping,
// and by default it was billed to the Max plan the user pays to WORK — a nightly job quietly
// spending subscription quota nobody opted into. `keyflip llm` picks the provider (and says, in
// plain words, whose quota each choice burns) BEFORE the first call.
//
// SECURITY: an endpoint key is never stored. `llm.key_env` holds the NAME of an env var, and the
// value is read from the process environment only when a request is made. The state directory is a
// git repo; a key written there is a key pushed.
const LLM_KEYS = ['llm.provider', 'llm.model', 'llm.base_url', 'llm.key_env'];
function cmdLlm(ctx, rest) {
  const llm = _llm;
  const sub = rest[0] && rest[0].slice(0, 2) !== '--' ? rest[0] : 'status';
  const flag = function (name) {
    const i = rest.indexOf(name);
    return i !== -1 ? rest[i + 1] : undefined;
  };
  if (sub === 'set') {
    const want = [];
    const p = flag('--provider');
    if (p !== undefined) want.push(['llm.provider', p]);
    const m = flag('--model');
    if (m !== undefined) want.push(['llm.model', m]);
    const b = flag('--base-url');
    if (b !== undefined) want.push(['llm.base_url', b]);
    const k = flag('--key-env');
    if (k !== undefined) want.push(['llm.key_env', k]);
    if (!want.length)
      return fail(
        'usage: keyflip llm set [--provider claude|ollama|openai] [--model NAME] [--base-url URL] [--key-env VAR_NAME]',
      );
    const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (let i = 0; i < want.length; i++) {
      if (want[i][0] === 'llm.key_env' && want[i][1] && !envName.test(want[i][1]))
        return fail(
          "'" +
            want[i][1] +
            "' is not an env var NAME. Pass the NAME of the variable that holds the key (e.g. EVREN_KEY), never the key itself — keyflip stores the name and reads the value from your environment at call time.",
        );
      try {
        _cfg.set(ctx, want[i][0], want[i][1]);
      } catch (e) {
        return fail(want[i][0] + ': ' + e.message);
      }
    }
    const prov = llm.resolve(ctx);
    print(style.ok('✅') + ' chores now run via ' + style.bold(prov.display) + ' — ' + style.dim(prov.cost) + '.');
    if (prov.needsKey) {
      const set = !!process.env[prov.keyEnv];
      print(
        (set ? style.ok('✓') : style.warn('·')) +
          ' ' +
          (set
            ? 'the environment variable ' + prov.keyEnv + ' is present (its value was not read or stored)'
            : prov.keyEnv +
              ' is not set in this shell — export it before running a chore, or `keyflip llm set --key-env` another name'),
      );
    }
    if (!prov.baseUrl && prov.provider !== 'claude')
      print(style.warn('·') + ' no base_url — set one: `keyflip llm set --base-url https://gateway/v1`');
    jsonOut({
      llm: {
        set: want,
        provider: prov.provider,
        model: prov.model || null,
        base_url: prov.baseUrl || null,
        key_env: prov.keyEnv || null,
        cost: prov.cost,
      },
    });
    return;
  }
  if (sub === 'off' || sub === 'reset') {
    LLM_KEYS.forEach(function (k) {
      try {
        _cfg.unset(ctx, k);
      } catch (e) {
        /* unknown key — nothing to reset */
      }
    });
    print(style.ok('✅') + ' back to the default: chores distill via claude -p (they spend the active account).');
    jsonOut({ llm: { reset: true } });
    return;
  }
  if (sub === 'test') {
    const gate = llm.availability(ctx);
    const prov = gate.provider;
    if (!gate.ok) return fail('provider "' + prov.display + '" is not usable (' + gate.reason + ') — ' + gate.fix);
    if (prov.provider === 'claude' && !llm.available(ctx))
      return fail(
        'claude -p is not on PATH — install Claude Code, or point chores somewhere else: keyflip llm set --provider ollama',
      );
    print('Testing ' + style.bold(prov.display) + ' ' + style.dim('(' + prov.cost + ')') + '…');
    // A local model has to be loaded into RAM before it answers, which on a big one is minutes, not
    // seconds — so the self-test waits as long as a real chore call would, and says so.
    const ti = rest.indexOf('--timeout');
    const timeoutMs = ti !== -1 ? parseInt(rest[ti + 1], 10) || 180000 : 180000;
    return llm
      .complete(ctx, 'Reply with exactly: OK', 'keyflip llm self-test', {
        skipCheck: prov.provider === 'claude' ? true : false,
        timeoutMs: timeoutMs,
      })
      .then(function (r) {
        if (!r.ok)
          return fail(
            'the provider did not answer: ' +
              (r.reason || 'unknown') +
              (r.detail ? ' (' + r.detail + ')' : '') +
              (r.fix ? ' — ' + r.fix : '') +
              (/timed out/.test(r.detail || '')
                ? ' — a large local model spends minutes loading; retry with a bigger --timeout or a smaller --model'
                : ''),
          );
        print(
          style.ok('✅') +
            ' answered: ' +
            style.dim(
              String(r.text)
                .replace(/[\r\n]+/g, ' ')
                .slice(0, 120),
            ),
        );
        jsonOut({ llmTest: { ok: true, provider: r.provider, model: r.model || null, bytes: String(r.text).length } });
      });
  }
  // status (default)
  const prov = llm.resolve(ctx);
  const gate = llm.availability(ctx);
  const usable = gate.ok && (prov.provider !== 'claude' || llm.available(ctx));
  print(style.bold('keyflip llm') + ' — what runs the background chores (dream / sessions distill / recall --answer)');
  print(
    '  provider: ' +
      style.bold(prov.display) +
      (usable
        ? ' ' + style.ok('(usable)')
        : ' ' + style.warn('(not usable: ' + (gate.ok ? 'claude -p not on PATH' : gate.reason) + ')')),
  );
  print('  cost:     ' + style.dim(prov.cost));
  if (prov.needsKey) {
    const present = prov.keyEnv && process.env[prov.keyEnv] ? ' (present)' : ' (NOT SET in this shell)';
    print(
      '  key:      ' +
        (prov.keyEnv ? 'env var ' + prov.keyEnv + present : 'none named') +
        ' ' +
        style.dim('— keyflip stores the NAME only; its value never touches disk'),
    );
  }
  if (prov.provider === 'ollama')
    print('  ' + style.dim('ollama pull <model> first; `keyflip llm test` proves it answers'));
  print(
    '  ' +
      style.dim(
        'change: keyflip llm set --provider ollama | --provider openai --base-url https://gateway/v1 --key-env MY_KEY --model NAME',
      ),
  );
  print('  ' + style.dim('verify: keyflip llm test'));
  jsonOut({
    llm: {
      provider: prov.provider,
      model: prov.model || null,
      base_url: prov.baseUrl || null,
      key_env: prov.keyEnv || null,
      key_present: prov.needsKey ? !!process.env[prov.keyEnv] : null,
      needs_key: !!prov.needsKey,
      usable: usable,
      reason: gate.ok ? null : gate.reason,
      cost: prov.cost,
      display: prov.display,
    },
  });
}

// C1: "dreaming" — a background pass that consolidates OLD chats: distill each into a
// keepsake (B4) and optionally archive the bulk (B1). DRY-RUN by default (H2); --apply
// executes. Skips sessions already distilled. Uses `claude -p` (spends the active account).
async function cmdDream(ctx, rest) {
  // C2: schedule/unschedule the nightly unattended pass.
  if (rest[0] === 'schedule' || rest[0] === 'unschedule' || rest[0] === 'status') return cmdDreamSchedule(ctx, rest);
  const memory = _memory,
    llm = _llm,
    archive = _archive;
  // Which model would do the work, and whose quota it burns — decided BEFORE anything runs, because
  // a nightly chore on the subscription is exactly the cost nobody chose on purpose.
  const prov = llm.resolve(ctx);
  const oi = rest.indexOf('--older-than');
  const days = oi !== -1 ? parseDays(rest[oi + 1]) || 30 : 30;
  const li = rest.indexOf('--limit');
  const cap = li !== -1 ? parseInt(rest[li + 1], 10) || 20 : 20;
  const apply = rest.indexOf('--apply') !== -1;
  const doDistill = rest.indexOf('--no-distill') === -1;
  const doArchive = rest.indexOf('--archive') !== -1;
  const cutoff = Date.now() - days * 86400000;
  let targets = sessions.list(ctx, { limit: 100000 }).filter(function (r) {
    return r.mtimeMs < cutoff && !memory.has(ctx, r.sessionId);
  });
  if (!targets.length) {
    print('💤 Nothing to dream about — no un-distilled sessions older than ' + days + ' day(s).');
    jsonOut({ dream: { candidates: 0 } });
    return;
  }
  const batch = targets.slice(0, cap);
  print(
    style.bold('💤 dream') +
      ' — ' +
      targets.length +
      ' session(s) older than ' +
      days +
      'd' +
      (targets.length > cap ? ' (processing first ' + cap + ')' : '') +
      (apply ? '' : '   ' + style.dim('[dry run — add --apply to execute]')),
  );
  if (doDistill)
    print(
      '  ' +
        style.dim('distills via ') +
        style.bold(prov.display) +
        style.dim(' — ' + prov.cost + '. Change it with `keyflip llm`.'),
    );
  if (apply && doDistill) {
    const gate = llm.availability(ctx);
    if (!gate.ok) return fail('dream: ' + gate.reason + ' — ' + gate.fix);
    if (gate.provider.provider === 'claude' && !llm.available(ctx))
      return fail(
        'dream needs Claude Code on PATH to distill (`claude -p`), or a provider: `keyflip llm set --provider ollama`.',
      );
  }
  if (!apply) {
    batch.forEach(function (r) {
      print(
        '  • ' +
          r.sessionId.slice(0, 8) +
          '  ' +
          (r.cwd || '?') +
          '   → ' +
          (doDistill ? 'distill' : '') +
          (doArchive ? (doDistill ? ' + archive' : 'archive') : ''),
      );
    });
    print(
      '\n' +
        style.dim(
          'Re-run with --apply to write keepsakes' +
            (doArchive ? ' and archive the transcripts' : '') +
            '. (--archive to also stow the bulk.)',
        ),
    );
    jsonOut({
      dream: {
        candidates: targets.length,
        wouldProcess: batch.length,
        apply: false,
        provider: prov.provider,
        model: prov.model || null,
      },
    });
    return;
  }
  const INSTR =
    'Summarize this past coding-assistant conversation (a JSONL transcript) into a durable "keepsake" memory. Output terse markdown bullets under: Goal, Decisions, Built/Changed, Gotchas/Learnings, Open TODOs. Be specific; skip trivia; no preamble.';
  let distilled = 0,
    archived = 0,
    failed = 0;
  for (let i = 0; i < batch.length; i++) {
    const r = batch[i];
    if (doDistill) {
      let transcript;
      try {
        transcript = fs.readFileSync(r.file, 'utf8');
      } catch (e) {
        failed++;
        continue;
      }
      const res = await llm.complete(ctx, INSTR, transcript, { skipCheck: true });
      if (!res.ok) {
        failed++;
        print('  ' + style.warn('·') + ' skipped ' + r.sessionId.slice(0, 8) + ' (' + res.reason + ')');
        continue;
      }
      await withLock(ctx, function () {
        memory.save(ctx, r.sessionId, res.text, {
          session: r.sessionId,
          cwd: r.cwd || '',
          distilledAt: ctx.now(),
          distillProvider: res.provider,
          distillModel: res.model || '',
        });
      });
      distilled++;
      print('  ' + style.ok('✓') + ' distilled ' + r.sessionId.slice(0, 8));
    }
    if (doArchive) {
      await withLock(ctx, function () {
        const a = archive.archiveSession(ctx, r.project, r.sessionId);
        if (a.ok) archived++;
      });
    }
  }
  print(
    style.ok('✅') +
      ' dreamed: ' +
      distilled +
      ' keepsake(s)' +
      (doArchive ? ', ' + archived + ' archived' : '') +
      (failed ? ', ' + failed + ' skipped' : '') +
      '.  Browse: ' +
      style.bold('keyflip memory'),
  );
  jsonOut({
    dream: {
      distilled: distilled,
      archived: archived,
      failed: failed,
      apply: true,
      provider: prov.provider,
      model: prov.model || null,
    },
  });
}

// B4: distill a session into a durable "keepsake" (via `claude -p`) in keyflip's OWN
// memory store. --to-claude also writes it into ~/.claude project memory (opt-in, H1).
async function cmdSessionsDistill(ctx, rest) {
  const memory = _memory,
    llm = _llm;
  const id = positionals(rest, [])[0];
  if (!id) return fail('usage: keyflip sessions distill <id> [--to-claude] [--model <m>]');
  let row;
  try {
    row = sessions.find(ctx, id);
  } catch (e) {
    return fail(e.message);
  }
  if (!row) return fail("no session matches '" + id + "'.");
  const gate = llm.availability(ctx);
  if (!gate.ok) return fail('distill: ' + gate.reason + ' — ' + gate.fix);
  if (gate.provider.provider === 'claude' && !llm.available(ctx))
    return fail(
      'distill needs Claude Code on PATH — it summarizes via `claude -p`. (Or route chores off the subscription: `keyflip llm set --provider ollama`.)',
    );
  let transcript;
  try {
    transcript = fs.readFileSync(row.file, 'utf8');
  } catch (e) {
    return fail('cannot read the transcript.');
  }
  print(
    'Distilling ' +
      style.bold(row.sessionId.slice(0, 8)) +
      ' via ' +
      style.bold(gate.provider.display) +
      ' ' +
      style.dim('(' + gate.provider.cost + ')') +
      '…',
  );
  const modelI = rest.indexOf('--model');
  const model = modelI !== -1 ? rest[modelI + 1] : null;
  const INSTR =
    'Summarize this past coding-assistant conversation (a JSONL transcript) into a durable "keepsake" memory. Output terse markdown bullets under these headings: Goal, Decisions, Built/Changed, Gotchas/Learnings, Open TODOs. Be specific; skip anything trivial; no preamble.';
  const res = await llm.complete(ctx, INSTR, transcript, { model: model, skipCheck: true });
  if (!res.ok)
    return fail(
      'distill failed: ' +
        (res.reason || 'unknown') +
        (res.detail ? ' (' + String(res.detail).trim() + ')' : '') +
        (res.fix ? ' — ' + res.fix : ''),
    );
  let savedPath;
  await withLock(ctx, function () {
    savedPath = memory.save(ctx, row.sessionId, res.text, {
      session: row.sessionId,
      cwd: row.cwd || '',
      distilledAt: ctx.now(),
      // Provenance: which model wrote this keepsake, on whose bill. Auditable later, and the
      // reason `keyflip memory audit` can tell a local distill from a subscription one.
      distillProvider: res.provider,
      distillModel: res.model || '',
    });
  });
  print(style.ok('✅') + ' saved keepsake → ' + savedPath);
  if (rest.indexOf('--to-claude') !== -1) {
    try {
      const dest = path.join(sessions.projectsDir(ctx), row.project, 'memory');
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'keyflip-' + row.sessionId + '.md'), res.text + '\n');
      print('  ↳ also written into ~/.claude project memory (--to-claude).');
    } catch (e) {
      print('  ' + style.warn('·') + ' could not write to ~/.claude memory: ' + e.message);
    }
  }
  jsonOut({
    distilled: { session: row.sessionId, memory: savedPath, provider: res.provider, model: res.model || null },
  });
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
  const settingsmod = _settingsmod;
  const { writeJsonStable } = _fsutil;
  const file = ctx.claudeSettingsPath;
  let cur;
  try {
    cur = settingsmod.read(file);
  } catch (e) {
    return fail('~/.claude/settings.json is corrupt — fix it first.');
  }
  if (on) {
    const cmd = statuslineCommand();
    cur.statusLine = { type: 'command', command: cmd, padding: 0 };
    try {
      writeJsonStable(file, cur, 0o600);
    } catch (e) {
      return fail('could not write settings.json: ' + e.message);
    }
    print(
      style.ok('✅') +
        ' installed the keyflip status line (' +
        style.dim(cmd) +
        '). It shows the active account + quota; restart Claude Code to see it.',
    );
    jsonOut({ statusline: 'installed' });
  } else {
    if (cur.statusLine && /statusline/.test(String((cur.statusLine && cur.statusLine.command) || ''))) {
      delete cur.statusLine;
      try {
        writeJsonStable(file, cur, 0o600);
      } catch (e) {
        /* ignore */
      }
      print(style.ok('✅') + ' removed the keyflip status line.');
    } else {
      print('The keyflip status line is not installed.');
    }
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
    let prov = null;
    try {
      const a = provider.readActive(ctx);
      prov = a && a.name;
    } catch (e) {
      prov = null;
    }
    let quota = '';
    try {
      const cache = JSON.parse(fs.readFileSync(path.join(ctx.configDir, '.usage-cache.json'), 'utf8'));
      let name = null;
      profiles.list(ctx.configDir).forEach(function (n) {
        if (!name && profiles.email(ctx.configDir, n) === email) name = n;
      });
      const u = name && cache && cache[name] && cache[name].usage;
      if (u) {
        const hs = [];
        if (u.fiveHour && typeof u.fiveHour.pct === 'number') hs.push(100 - u.fiveHour.pct);
        if (u.sevenDay && typeof u.sevenDay.pct === 'number') hs.push(100 - u.sevenDay.pct);
        if (hs.length) quota = ' · ' + Math.max(0, Math.round(Math.min.apply(null, hs))) + '% left';
      }
    } catch (e) {
      /* no cache — omit quota */
    }
    line = '⚡ ' + email + (prov ? ' → ' + prov : '') + quota;
  } catch (e) {
    /* keep the fallback */
  }
  process.stdout.write(line);
}

// J3: `keyflip settings [show | get <key> | set <key> <value> | unset <key>]` — view/edit
// ~/.claude/settings.json (the file Claude Code hot-reloads). Dot-paths for nested keys.
function cmdSettings(ctx, rest) {
  const settings = _settingsmod;
  const { writeJsonStable } = _fsutil;
  const file = ctx.claudeSettingsPath;
  let cur;
  try {
    cur = settings.read(file);
  } catch (e) {
    return fail('~/.claude/settings.json is corrupt — fix it first (' + e.message + ').');
  }
  const sub = rest[0];
  if (sub === 'get') {
    if (!rest[1]) return fail('usage: keyflip settings get <key>');
    const v = settings.getPath(cur, rest[1]);
    if (JSON_MODE) {
      jsonOut({ key: rest[1], value: v === undefined ? null : v });
      return;
    }
    print(v === undefined ? '(not set)' : typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v));
    return;
  }
  if (sub === 'set' || sub === 'unset') {
    if (!rest[1]) return fail('usage: keyflip settings ' + sub + ' <key>' + (sub === 'set' ? ' <value>' : ''));
    if (sub === 'set') {
      const raw = rest.slice(2).join(' ');
      if (raw === '') return fail('usage: keyflip settings set <key> <value>');
      let val;
      try {
        val = JSON.parse(raw);
      } catch (e) {
        val = raw;
      } // JSON literal if valid, else a string
      settings.setPath(cur, rest[1], val);
    } else {
      settings.setPath(cur, rest[1], undefined);
    }
    try {
      writeJsonStable(file, cur, 0o600);
    } catch (e) {
      return fail('could not write settings.json: ' + e.message);
    }
    print(
      style.ok('✅') +
        ' ' +
        (sub === 'set' ? 'set' : 'unset') +
        ' ' +
        style.bold(rest[1]) +
        ' in ~/.claude/settings.json (Claude hot-reloads it; no restart).',
    );
    jsonOut({ settings: sub, key: rest[1] });
    return;
  }
  if (JSON_MODE) {
    jsonOut({ settings: cur });
    return;
  }
  print('~/.claude/settings.json:');
  print(JSON.stringify(cur, null, 2));
  print(
    '\nChange one: ' +
      style.bold('keyflip settings set <key> <value>') +
      '   (e.g. ' +
      style.bold('keyflip settings set model opus') +
      ', dot-paths for nesting). Carried across machines by `keyflip migrate`.',
  );
}

// I1: `keyflip recall "<query>"` — local BM25 semantic-ish recall over the distilled
// keepsakes (zero-dep, offline, private). Answers "where did I discuss X" across all chats.
async function cmdRecall(ctx, rest) {
  const recall = _recall;
  const li = rest.indexOf('--limit');
  const limit = li !== -1 ? parseInt(rest[li + 1], 10) || 10 : 10;
  const query = positionals(rest, []).join(' ');
  if (!query)
    return fail(
      'usage: keyflip recall "<query>" [--semantic] [--answer]   (searches your distilled keepsakes; make some with: keyflip dream --apply)',
    );

  // I2: --semantic uses an embedding endpoint (Ollama/hosted) for true vector search; falls
  // back to lexical (BM25) if no endpoint is reachable.
  if (rest.indexOf('--semantic') !== -1) {
    const sem = await recall.semanticSearch(ctx, query, { limit: limit });
    if (sem.ok) {
      if (!sem.hits.length) return print('No keepsakes matched "' + query + '" semantically.');
      print('Semantic recall for "' + style.bold(query) + '" — ' + sem.hits.length + ' keepsake(s):');
      sem.hits.forEach(function (h, i) {
        print(
          '  [' +
            (i + 1) +
            '] ' +
            h.session.slice(0, 8) +
            (h.cwd ? '  ' + style.dim(h.cwd) : '') +
            '   ' +
            style.dim('(' + Math.round(h.score * 100) / 100 + ')'),
        );
        print('      ' + style.dim('↳ ' + h.snippet));
      });
      if (JSON_MODE)
        jsonOut({
          recall: sem.hits.map(function (h) {
            return {
              key: h.key,
              session: h.session,
              cwd: h.cwd,
              score: Math.round(h.score * 1000) / 1000,
              snippet: h.snippet,
            };
          }),
        });
      return;
    }
    if (sem.reason === 'no-keepsakes')
      return print('No keepsakes yet — distill some chats first: keyflip dream --apply.');
    print(
      style.warn('·') + ' semantic search unavailable (' + sem.reason + ') — falling back to local lexical search.',
    );
  }

  // I3: --answer synthesizes a cited answer over the retrieved keepsakes, through the configured
  // provider (`keyflip llm`) — `claude -p` by default, which spends the subscription.
  if (rest.indexOf('--answer') !== -1) {
    const llm = _llm;
    const gate = llm.availability(ctx);
    const usable = gate.ok && (gate.provider.provider !== 'claude' || llm.available(ctx));
    if (!usable) {
      print(
        style.warn('·') +
          (gate.ok
            ? ' --answer needs Claude Code on PATH (`claude -p`) or a provider you set with `keyflip llm`; showing the ranked keepsakes instead.'
            : ' --answer provider is not usable (' +
              gate.reason +
              '): ' +
              gate.fix +
              ' — showing the ranked keepsakes instead.'),
      );
    } else {
      print(
        'Researching "' +
          style.bold(query) +
          '" across your keepsakes via ' +
          style.bold(gate.provider.display) +
          ' ' +
          style.dim('(' + gate.provider.cost + ')') +
          '…',
      );
      const a = await recall.answer(ctx, query, { limit: limit, skipCheck: true });
      if (!a.ok)
        return fail(
          a.reason === 'no-matches'
            ? 'no keepsakes matched "' + query + '".'
            : 'recall --answer failed: ' + (a.reason || 'unknown') + (a.fix ? ' — ' + a.fix : ''),
        );
      print('\n' + a.text + '\n');
      print(
        style.dim(
          'Sources: ' +
            a.hits
              .map(function (h) {
                return h.session.slice(0, 8);
              })
              .join(', '),
        ),
      );
      jsonOut({
        answer: a.text,
        provider: a.provider,
        model: a.model || null,
        sources: a.hits.map(function (h) {
          return h.session;
        }),
      });
      return;
    }
  }

  const hits = recall.search(ctx, query, { limit: limit });
  if (JSON_MODE) {
    jsonOut({
      recall: hits.map(function (h) {
        return {
          key: h.key,
          session: h.session,
          cwd: h.cwd,
          score: Math.round(h.score * 1000) / 1000,
          snippet: h.snippet,
        };
      }),
    });
    return;
  }
  if (!hits.length) {
    const n = recall.corpus(ctx).length;
    return print(
      n
        ? 'No keepsakes matched "' + query + '".'
        : 'No keepsakes yet to recall from — distill some chats first: keyflip dream --apply (or keyflip sessions distill <id>).',
    );
  }
  print('Recall for "' + style.bold(query) + '" — ' + hits.length + ' keepsake(s):');
  hits.forEach(function (h, i) {
    print(
      '  [' +
        (i + 1) +
        '] ' +
        h.session.slice(0, 8) +
        (h.cwd ? '  ' + style.dim(h.cwd) : '') +
        '   ' +
        style.dim('(' + Math.round(h.score * 100) / 100 + ')'),
    );
    print('      ' + style.dim('↳ ' + h.snippet));
  });
  print(
    '\nRead a keepsake: ' +
      style.bold('keyflip memory show <key>') +
      '   ·   resume its chat: ' +
      style.bold('keyflip resume <session> --run'),
  );
}

// `keyflip memory [list | show <key> | remove <key>]` — browse keyflip's distilled keepsakes.
function cmdMemory(ctx, rest) {
  const memory = _memory;
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
  // #41: keepsakes are distilled PROSE, and prose is where a pasted key survives ("Gotchas: my key is
  // sk-ant-…"). Audit them the way every outbound surface is scanned — report KIND, never content.
  if (sub === 'audit') {
    const leakscan = _leakscan;
    const apply = rest.indexOf('--apply') !== -1;
    // The .pre-scrub originals are the last copy of the UNREDACTED text — dropping one is only safe
    // once its keepsake is provably clean, which is what dropKeepsakeCopies checks per key.
    if (rest.indexOf('--drop-copies') !== -1) {
      const d = leakscan.dropKeepsakeCopies(ctx, memory);
      print(
        d.dropped.length
          ? style.ok('✅') +
              ' removed ' +
              d.dropped.length +
              ' un-redacted original(s) (' +
              d.bytes +
              ' bytes): ' +
              d.dropped.join(', ')
          : style.dim('nothing dropped — no .pre-scrub original whose keepsake is already clean.'),
      );
      d.kept.forEach(function (k) {
        print('  ' + style.warn('⚠') + ' kept ' + k.key + ' — ' + k.reason);
      });
      jsonOut({ memoryAudit: { dropped: d.dropped, kept: d.kept, bytes: d.bytes } });
      return;
    }
    const copies = leakscan.keepsakeCopies(ctx, memory);
    const audit = leakscan.keepsakeAudit(ctx, memory);
    if (!audit.leaks.length) {
      print(style.ok('✅') + ' ' + audit.audited + ' keepsake(s) audited — no secret shapes found.');
      if (copies.files.length)
        print(
          '  ' +
            style.warn('⚠') +
            ' but ' +
            copies.files.length +
            ' un-redacted original(s) are still on disk as .pre-scrub (0600) — confirm the redaction, then: keyflip memory audit --drop-copies',
        );
      jsonOut({
        memoryAudit: {
          audited: audit.audited,
          leaks: [],
          redacted: 0,
          pending_originals: copies.files.map((f) => f.key),
        },
      });
      return;
    }
    print(
      style.warn('⚠') +
        ' ' +
        audit.leaks.length +
        ' of ' +
        audit.audited +
        ' keepsake(s) hold secret-shaped text (' +
        audit.leaks.reduce(function (n, l) {
          return n + l.hits;
        }, 0) +
        ' match(es)):',
    );
    audit.leaks.forEach(function (l) {
      print('  • ' + l.key.slice(0, 12) + '  ' + style.dim(l.kinds.join(', ') + '  ·  ' + l.bytes + ' bytes'));
    });
    if (!apply) {
      print(
        '\n' +
          style.dim('Dry run. --apply redacts the matches in place and keeps each original as <key>.md.pre-scrub.'),
      );
      jsonOut({ memoryAudit: { audited: audit.audited, leaks: audit.leaks, apply: false } });
      return;
    }
    const r = leakscan.keepsakeScrub(ctx, memory);
    print(
      style.ok('✅') +
        ' redacted ' +
        r.total +
        ' match(es) across ' +
        r.redacted +
        ' keepsake(s); originals kept as .pre-scrub.',
    );
    print(
      style.dim(
        '  The originals still HOLD the secret (0600, never versioned): read them, then `keyflip memory audit --drop-copies`.',
      ),
    );
    print(
      style.dim(
        '  Note: a redacted keepsake is still in git history until you scrub it — keyflip doctor --history, then keyflip scrub-history.',
      ),
    );
    jsonOut({
      memoryAudit: { audited: audit.audited, leaks: audit.leaks, apply: true, redacted: r.redacted, matches: r.total },
    });
    return;
  }
  const rows = memory.list(ctx);
  if (JSON_MODE) {
    jsonOut({
      memory: rows.map(function (r) {
        return { key: r.key, bytes: r.bytes, mtime: r.mtime };
      }),
    });
    return;
  }
  if (!rows.length) {
    print('No keepsakes yet. Distill a session into one: keyflip sessions distill <id>');
    return;
  }
  rows.forEach(function (r, i) {
    print(
      '  [' +
        (i + 1) +
        '] ' +
        r.key.slice(0, 8) +
        '  ' +
        String(r.mtime || '')
          .slice(0, 16)
          .replace('T', ' ') +
        '  ' +
        fmtBytes(r.bytes),
    );
  });
  print('\nRead one: keyflip memory show <key>');
}

async function cmdSessionsRebind(ctx, rest) {
  const pos = positionals(rest, []);
  const oldCwd = pos[0],
    newCwd = pos[1];
  if (!oldCwd || !newCwd)
    return fail(
      "usage: keyflip sessions rebind <old-path> <new-path> [--purge-old] [--force]\n  (re-links a project's chat history after you renamed/moved its folder)",
    );
  const oldAbs = path.resolve(oldCwd),
    newAbs = path.resolve(newCwd);
  const force = rest.indexOf('--force') !== -1 || rest.indexOf('-y') !== -1;
  const purgeOld = rest.indexOf('--purge-old') !== -1;

  const oldDir = path.join(sessions.projectsDir(ctx), sessions.encodeCwd(oldAbs));
  if (!fs.existsSync(oldDir)) return fail("no chat history found for '" + oldAbs + "' (looked in " + oldDir + ').');
  const count = (function () {
    try {
      return fs.readdirSync(oldDir).filter(function (f) {
        return f.slice(-6) === '.jsonl';
      }).length;
    } catch (e) {
      return 0;
    }
  })();
  print(
    'Re-link ' + style.bold(String(count)) + ' session(s): ' + style.bold(oldAbs) + ' → ' + style.bold(newAbs) + '.',
  );
  print(
    style.dim(
      '  Copies transcripts to the new folder key and rewrites the old path inside them (old copies backed up).',
    ),
  );
  if (appctl.isClaudeRunning(ctx.platform))
    print(
      '  ' +
        style.warn('⚠') +
        " Claude is running — quit it first so it can't overwrite the fix (a restart is needed to see the change anyway).",
    );
  if (!force) {
    if (!process.stdin.isTTY) return fail('re-run with --force to confirm.');
    const ok = await confirm('Proceed? [y/N] ');
    if (!ok) {
      print('Cancelled.');
      return;
    }
  }
  const r = sessions.rebind(ctx, oldAbs, newAbs, { purgeOld: purgeOld, force: force });
  if (!r.ok) return fail('rebind did not run: ' + (r.reason || 'unknown'));
  print(
    style.ok('✅') +
      ' moved ' +
      r.moved +
      ' transcript(s)' +
      (r.skipped ? ', skipped ' + r.skipped + ' (already there — use --force)' : '') +
      ' → ' +
      r.newDir,
  );
  if (r.backup) print('  ↳ backup: ' + r.backup);
  if (r.sidecars) print('  ↳ carried ' + r.sidecars + ' per-session sidecar dir(s) (sub-agent runs).');
  if (r.memory && (r.memory.copied || r.memory.conflicts)) {
    print(
      '  ↳ memory notes: ' +
        r.memory.copied +
        ' carried over' +
        (r.memory.identical ? ', ' + r.memory.identical + ' already matched' : '') +
        (r.memory.conflicts
          ? style.warn(', ' + r.memory.conflicts + ' name clash(es) kept BOTH (see *.keyflip-conflict)')
          : ''),
    );
  }
  if (ctx.appDataDir && !appctl.isClaudeRunning(ctx.platform)) {
    const reg = sessions.rebindAppRegistry(ctx, oldAbs, newAbs);
    if (reg.patched) print('  ↳ patched ' + reg.patched + ' desktop-app session record(s).');
  }
  let configs = { patched: 0, files: [] };
  if (rest.indexOf('--skip-configs') === -1) {
    const extraFiles = [];
    for (let i = 0; i < rest.length - 1; i++) {
      if (rest[i] === '--extra-file') extraFiles.push(path.resolve(rest[i + 1]));
    }
    configs = sessions.rebindConfigPaths(ctx, oldAbs, newAbs, { extraFiles: extraFiles });
    if (configs.patched) {
      print('  ↳ rewrote the old path in ' + style.bold(String(configs.patched)) + ' config file(s):');
      configs.files.forEach(function (x) {
        print('      ' + style.dim(x.path + ' (' + x.hits + ')'));
      });
    }
  }
  print(
    '  ' +
      style.dim(
        'Restart Claude to see the history under the new folder' +
          (purgeOld ? ' (old copies disabled).' : '; old copies remain at the old key).'),
      ),
  );
  jsonOut({
    rebind: {
      moved: r.moved,
      skipped: r.skipped,
      sidecars: r.sidecars,
      memory: r.memory,
      oldDir: r.oldDir,
      newDir: r.newDir,
      configFilesPatched: configs.patched,
      configFiles: configs.files.map(function (x) {
        return x.path;
      }),
    },
  });
}

// FLEET: manage every associated keyflip from one screen — see them all, switch a remote
// machine's account, and collect/distribute accounts across the fleet, all through an
// encrypted shared rendezvous folder.
function fleetBus(ctx, rest) {
  const passphrase = readSecretArg(rest, '--passphrase-file');
  if (!passphrase) {
    fail('a fleet passphrase is required: --passphrase-file <file>');
    return null;
  }
  try {
    return _fleet.bus(ctx, { passphrase: passphrase });
  } catch (e) {
    fail(e.message);
    return null;
  }
}
function resolveMachine(statuses, arg) {
  const n = statuses.filter(function (s) {
    return s.name === arg;
  });
  if (n.length === 1) return n[0];
  const id = statuses.filter(function (s) {
    return s.machineId === arg || s.machineId.indexOf(arg) === 0;
  });
  return id.length === 1 ? id[0] : n.length > 1 ? 'ambiguous' : null;
}
async function cmdFleet(ctx, rest) {
  const fleet = _fleet;
  const sub = rest[0];

  if (sub === 'init') {
    const ni = rest.indexOf('--name');
    const di = rest.indexOf('--dir');
    const patch = {};
    if (di !== -1 && rest[di + 1]) patch.dir = path.resolve(rest[di + 1]);
    if (ni !== -1 && rest[ni + 1]) patch.name = rest[ni + 1];
    if (!patch.dir && !_fleet.identity(ctx).dir)
      return fail(
        'usage: keyflip fleet init --dir <shared-folder> [--name <this-machine>]\n  the folder must be reachable by every machine (a Dropbox/iCloud/synced dir).',
      );
    const id = fleet.setConfig(ctx, patch);
    if (JSON_MODE) {
      jsonOut({ fleet: { machineId: id.machineId, name: id.name, dir: id.dir } });
      return;
    }
    print(
      style.ok('✅') +
        ' this machine is ' +
        style.bold(id.name) +
        ' ' +
        style.dim('(' + id.machineId + ')') +
        ' in the fleet at ' +
        style.bold(id.dir),
    );
    print(
      '   ' +
        style.dim('Publish + check in with:  ') +
        style.bold('keyflip fleet push --passphrase-file <f>') +
        style.dim('   (same passphrase on every machine).'),
    );
    return;
  }

  // LAN discovery (#57): find keyflip machines on this network WITHOUT the shared folder. Public
  // identity only (machine id / name / key fingerprint) — no passphrase, so it runs before any
  // rendezvous is configured. Read-only: it never writes state.
  if (sub === 'discover') {
    const tIdx = rest.indexOf('--timeout');
    const timeoutMs = tIdx !== -1 ? Math.max(200, parseInt(rest[tIdx + 1], 10) || 3000) : 3000;
    const self = fleet.identity(ctx);
    const me = { machineId: self.machineId, name: self.name, fp: fleet.fingerprint(fleet.publicKey(ctx)) };
    if (!JSON_MODE) print(style.dim('listening for keyflip machines on the LAN for ' + timeoutMs + 'ms…'));
    let peers = [];
    try {
      peers = await _lanfleet.discover({ timeoutMs: timeoutMs, exclude: self.machineId });
    } catch (e) {
      peers = [];
    }
    if (JSON_MODE) {
      jsonOut({ fleetDiscover: { self: me, peers: peers, ms: timeoutMs } });
      return;
    }
    print(style.bold('On the LAN now:') + ' ' + style.dim('(announced as ' + self.name + ')'));
    if (!peers.length) {
      print('  ' + style.warn('no other keyflip machine answered in ' + timeoutMs + 'ms.'));
      print(
        '  ' +
          style.dim(
            'Same Wi-Fi/subnet? macOS may ask to allow incoming connections the first time. A VPN or a' +
              ' locked-down network can block multicast (falls back to a shared folder).',
          ),
      );
      return;
    }
    peers.forEach(function (p) {
      print(
        '  ' +
          style.ok('●') +
          ' ' +
          style.bold(p.name || p.machineId) +
          '  ' +
          style.dim(p.machineId.slice(0, 12) + '…' + (p.fp ? '  key ' + p.fp : '  (no key published yet)')) +
          '  ' +
          style.dim(p.host),
      );
    });
    print('');
    print(
      '  ' +
        style.dim(
          'Reachable, but a command still needs the fleet passphrase. Verify a peer out-of-band against' +
            ' the fingerprint it prints (`keyflip fleet keys`), then trust-on-first-use pins it.',
        ),
    );
    return;
  }

  const b = fleetBus(ctx, rest);
  if (!b) return;

  if (sub === 'push') {
    const withSecrets = rest.indexOf('--with-secrets') !== -1;
    const autoYes = rest.indexOf('-y') !== -1 || rest.indexOf('--yes') !== -1;
    const status = fleet.publish(ctx, b, { withSecrets: withSecrets });
    // Reconcile peer signing keys (TOFU: pin on first sight, flag any that CHANGED) before we trust
    // any queued command's origin.
    const reconcile = fleet.reconcileKeys(ctx, fleet.readFleet(ctx, b));
    // process my inbox: apply queued commands (origin-authenticated, then gated on consent)
    const inbox = fleet.readInbox(ctx, b);
    const results = [];
    const kept = []; // 'exec' commands are NOT handled here — they are consent-gated and belong to `keyflip swarm drain --allow-exec`; leave them in the inbox.
    for (let i = 0; i < inbox.length; i++) {
      const cmd = inbox[i];
      if (cmd && cmd.type === 'exec') {
        kept.push(cmd);
        results.push({ ok: false, applied: 'exec', detail: 'deferred → run `keyflip swarm drain --allow-exec`' });
        continue;
      }
      // Replay protection: never re-run a command we already applied, and drop stale/far-future
      // ones — the rendezvous is only semi-trusted, so a captured command could be re-injected.
      if (cmd && cmd.id && fleet.wasApplied(ctx, cmd.id)) {
        results.push({ ok: false, applied: cmd.type, detail: 'skipped (already applied)' });
        continue;
      }
      if (!fleet.commandFresh(ctx, cmd)) {
        results.push({ ok: false, applied: cmd && cmd.type, detail: 'skipped (expired)' });
        continue;
      }
      // Origin authentication: the command MUST carry a signature that verifies against the sender's
      // TOFU-pinned public key. This is what defeats a leaked passphrase — an attacker who can write
      // to the folder still cannot forge a command "from" a machine whose private key they lack.
      const origin = fleet.checkOrigin(ctx, cmd, reconcile);
      if (!origin.ok) {
        results.push({ ok: false, applied: cmd && cmd.type, detail: 'rejected: ' + origin.reason });
        continue;
      }
      let allow = {
        allowSwitch: false,
        allowSave: false,
        force: rest.indexOf('--force') !== -1,
        senderKey: origin.key,
        requireSignature: true,
      };
      if (cmd.type === 'note') {
        /* no consent */
      } else if (autoYes) {
        allow.allowSwitch = true;
        allow.allowSave = true;
      } else if (!JSON_MODE && process.stdin.isTTY) {
        const fromLabel = String(cmd.from || '?')
          .replace(/[^\w.-]/g, '')
          .slice(0, 40);
        const acctLabel = String(
          (cmd.payload &&
            (cmd.type === 'switch' ? cmd.payload.account : cmd.payload.account && cmd.payload.account.name)) ||
            '?',
        )
          .replace(/[^\w@.+-]/g, '')
          .slice(0, 60);
        const desc =
          cmd.type === 'switch'
            ? 'switch this machine to account "' + acctLabel + '"'
            : cmd.type === 'save-account'
              ? 'save account "' + acctLabel + '" (from ' + fromLabel + ')'
              : String(cmd.type).replace(/[^\w-]/g, '');
        const ok = await confirm(
          style.warn('⚠') + ' ' + style.ok('✓ verified') + ' ' + fromLabel + ' asks to ' + desc + ' — allow? [y/N] ',
        );
        allow.allowSwitch = allow.allowSave = ok;
      }
      const r = fleet.applyCommand(ctx, cmd, allow);
      if (r.ok && cmd.id) fleet.markApplied(ctx, cmd.id); // ledger EVERY applied command (incl. notes) so it can't be verbatim-replayed
      results.push(r);
    }
    // Keep exec commands for `swarm drain`; only clear the ones we consumed here.
    if (kept.length) {
      try {
        b.write(fleet.inboxName(b.machineId), kept);
      } catch (e) {
        /* leave inbox as-is */
      }
    } else if (inbox.length) {
      fleet.clearInbox(ctx, b);
    }
    if (reconcile.conflicts.length && !JSON_MODE)
      reconcile.conflicts.forEach(function (c) {
        print(
          style.warn('⚠ KEY CHANGED') +
            ' for ' +
            style.bold(c.name) +
            ' (' +
            c.machineId +
            ') — commands from it are being REJECTED. If this machine legitimately re-keyed, run `keyflip fleet trust ' +
            c.machineId +
            ' --passphrase-file <f>`.',
        );
      });
    if (JSON_MODE) {
      jsonOut({
        fleetPush: { machine: b.name, accounts: status.accounts.length, chats: status.chats.length, applied: results },
      });
      return;
    }
    print(
      style.ok('📡') +
        ' published ' +
        style.bold(b.name) +
        ': ' +
        status.accounts.length +
        ' account(s), ' +
        status.chats.length +
        ' chat(s)' +
        (withSecrets ? style.dim(' (with encrypted creds)') : '') +
        '.',
    );
    results.forEach(function (r) {
      print('   ' + (r.ok ? style.ok('✓') : style.dim('•')) + ' inbox: ' + r.applied + ' — ' + r.detail);
    });
    return;
  }

  if (sub === 'status') {
    const statuses = fleet.readFleet(ctx, b);
    const nr = fleet.newReplies(ctx, statuses);
    fleet.saveSeen(ctx, nr.snapshot);
    // --json must never leak credentials: project every status through the creds-free view.
    if (JSON_MODE) {
      jsonOut({ fleet: statuses.map(fleet.sanitizeStatus), newReplies: nr.newReplies });
      return;
    }
    if (!statuses.length) {
      print(style.dim('No machines have checked in yet. Run `keyflip fleet push --passphrase-file <f>` on each.'));
      return;
    }
    print(style.bold('Fleet') + ' ' + style.dim('(' + statuses.length + ' machine(s)):'));
    statuses.forEach(function (s) {
      const active = s.accounts.filter(function (a) {
        return a.active;
      })[0];
      const q = active && active.fiveHourPct != null ? ' · ' + Math.round(active.fiveHourPct) + '% 5h' : '';
      const waiting = (s.chats || []).filter(function (c) {
        return c.lastRole === 'user';
      }).length;
      print(
        '  ' +
          style.ok('●') +
          ' ' +
          style.bold(s.name.padEnd(14)) +
          ' ' +
          (s.activeEmail || 'not logged in') +
          q +
          '  ' +
          style.dim(
            s.accounts.length +
              ' acct · ' +
              (s.chats || []).length +
              ' chat' +
              (waiting ? ' · ' + waiting + ' waiting' : '') +
              ' · ' +
              String(s.at).slice(0, 16).replace('T', ' '),
          ),
      );
    });
    if (nr.newReplies.length) {
      print('');
      print(style.ok('✨ New replies since last check:'));
      nr.newReplies.forEach(function (r) {
        print(
          '   ' + style.bold(r.machine) + ' ' + style.dim(r.sessionId.slice(0, 8)) + '  “' + (r.lastText || '') + '”',
        );
      });
      // Opt-in fleet-reply notification (no-op unless configured). send() strips secrets from the
      // payload; carry only machine names + count, never the reply text.
      try {
        await _notify.send(ctx, 'fleet-reply', {
          count: nr.newReplies.length,
          machines: nr.newReplies.map(function (r) {
            return r.machine;
          }),
        });
      } catch (e) {
        /* never block fleet status on notify */
      }
    }
    return;
  }

  if (sub === 'switch') {
    const pos = positionals(rest.slice(1), ['--passphrase-file']);
    const machineArg = pos[0],
      account = pos[1];
    if (!machineArg || !account) return fail('usage: keyflip fleet switch <machine> <account> --passphrase-file <f>');
    const m = resolveMachine(fleet.readFleet(ctx, b), machineArg);
    if (m === 'ambiguous') return fail("'" + machineArg + "' matches more than one machine");
    if (!m) return fail("no fleet machine named '" + machineArg + "' (run `keyflip fleet status`)");
    fleet.publish(ctx, b, {}); // publish our status so the target can TOFU-pin our key and verify us
    const cmd = fleet.queue(ctx, b, m.machineId, { type: 'switch', payload: { account: account } });
    if (JSON_MODE) {
      jsonOut({ queued: { target: m.name, command: cmd } });
      return;
    }
    print(
      style.ok('📨') +
        ' queued a switch → ' +
        style.bold(m.name) +
        ' will move to ' +
        style.bold(account) +
        ' on its next ' +
        style.bold('keyflip fleet push') +
        '.',
    );
    return;
  }

  if (sub === 'send-account') {
    const pos = positionals(rest.slice(1), ['--passphrase-file', '--to', '--from']);
    const account = pos[0];
    const toArg = flagVal(rest, '--to');
    const fromArg = flagVal(rest, '--from');
    if (!account || !toArg)
      return fail(
        'usage: keyflip fleet send-account <account> --to <machine> [--from <machine>] --passphrase-file <f>',
      );
    const statuses = fleet.readFleet(ctx, b);
    const to = resolveMachine(statuses, toArg);
    if (!to || to === 'ambiguous') return fail("no single fleet machine named '" + toArg + "'");
    let acctObj = null;
    if (fromArg) {
      const from = resolveMachine(statuses, fromArg);
      if (!from || from === 'ambiguous') return fail("no single fleet machine named '" + fromArg + "'");
      acctObj = fleet.accountFrom(from, account);
      if (!acctObj)
        return fail(
          "'" +
            fromArg +
            "' has not published account '" +
            account +
            "' with credentials (it must `keyflip fleet push --with-secrets`).",
        );
    } else {
      const ex = transfer.buildExport(ctx).envelope.accounts.filter(function (a) {
        return a.name === account;
      })[0];
      if (!ex) return fail("no local account '" + account + "' (or its credentials are unreadable).");
      acctObj = ex;
    }
    fleet.publish(ctx, b, {}); // publish our status so the target can TOFU-pin our key and verify us
    const cmd = fleet.queue(ctx, b, to.machineId, { type: 'save-account', payload: { account: acctObj } });
    if (JSON_MODE) {
      jsonOut({ queued: { target: to.name, account: account, command: { id: cmd.id, type: cmd.type } } });
      return;
    }
    print(
      style.ok('📨') +
        ' queued ' +
        style.bold(account) +
        (fromArg ? ' (from ' + fromArg + ')' : '') +
        ' → ' +
        style.bold(to.name) +
        ' will save it on its next ' +
        style.bold('keyflip fleet push') +
        '.',
    );
    return;
  }

  if (sub === 'keys') {
    // Audit the TOFU signing-key store: fingerprints + whether each machine's published key still
    // matches its pin. The one read surface for the origin-auth trust state.
    const statuses = fleet.readFleet(ctx, b);
    const rep = fleet.keyReport(ctx, statuses);
    if (JSON_MODE) {
      jsonOut({ keys: rep });
      return;
    }
    if (!rep.length) {
      print(style.dim('No machine signing keys seen yet. Run `keyflip fleet push` on each machine.'));
      return;
    }
    print(
      style.bold('Fleet signing keys') +
        ' ' +
        style.dim('(TOFU-pinned; verify a CHANGED key out-of-band before `fleet trust`):'),
    );
    rep.forEach(function (r) {
      const mark = r.status === 'ok' ? style.ok('●') : r.status === 'CHANGED' ? style.bad('✗') : style.dim('○');
      print(
        '  ' +
          mark +
          ' ' +
          style.bold(String(r.name).padEnd(14)) +
          ' ' +
          (r.pinned || style.dim('(unpinned)')) +
          '  ' +
          style.dim(r.status) +
          (r.status === 'CHANGED' ? '  ' + style.warn('→ `keyflip fleet trust ' + r.machineId + '`') : ''),
      );
    });
    return;
  }

  if (sub === 'trust') {
    // Re-pin a machine's signing key AFTER a legitimate re-key (the only sanctioned way a pinned key
    // changes). Guarded by consent when the key actually differs from what we pinned before.
    const pos = positionals(rest.slice(1), ['--passphrase-file']);
    const machineArg = pos[0];
    if (!machineArg) return fail('usage: keyflip fleet trust <machine> --passphrase-file <f>');
    const m = resolveMachine(fleet.readFleet(ctx, b), machineArg);
    if (m === 'ambiguous') return fail("'" + machineArg + "' matches more than one machine");
    if (!m) return fail("no fleet machine named '" + machineArg + "' (run `keyflip fleet status`)");
    if (!m.pubKey) return fail("'" + m.name + "' has not published a signing key yet (it must `keyflip fleet push`).");
    const known = fleet.knownKeys(ctx);
    const pinned = known[m.machineId];
    if (pinned === m.pubKey) {
      if (!JSON_MODE) print(style.dim('Already trusting ' + m.name + "'s current key — nothing to do."));
      else jsonOut({ trusted: { machine: m.name, changed: false } });
      return;
    }
    if (pinned && !JSON_MODE && process.stdin.isTTY) {
      print(
        style.warn('⚠') +
          ' the pinned key for ' +
          style.bold(m.name) +
          ' has CHANGED. Only re-trust if you KNOW it legitimately re-keyed (a new install / reset). If not, this could be a key-substitution attack via the shared folder.',
      );
      print(
        '   ' +
          style.dim('new key fingerprint: ') +
          style.bold(fleet.fingerprint(m.pubKey)) +
          style.dim('  — verify this out-of-band with ' + m.name + "'s operator before trusting."),
      );
      if (!(await confirm('Re-trust ' + m.name + "'s new key? [y/N] "))) {
        print('Cancelled — the old key stays pinned; commands from ' + m.name + ' remain rejected.');
        return;
      }
    }
    fleet.trustKey(ctx, m.machineId, m.pubKey);
    if (JSON_MODE) {
      jsonOut({ trusted: { machine: m.name, machineId: m.machineId, changed: !!pinned } });
      return;
    }
    print(
      style.ok('✅') +
        ' now trusting ' +
        style.bold(m.name) +
        "'s " +
        (pinned ? 'NEW ' : '') +
        'signing key. Its commands will verify again.',
    );
    return;
  }

  if (sub === 'collect') {
    const statuses = fleet.readFleet(ctx, b);

    const seen = {};
    const toImport = [];
    statuses.forEach(function (s) {
      Object.keys(s.creds || {}).forEach(function (name) {
        if (seen[name]) return;
        seen[name] = 1;
        const a = fleet.accountFrom(s, name);
        if (a) toImport.push(a);
      });
    });
    if (!toImport.length)
      return fail(
        'no accounts published with credentials across the fleet (machines must `keyflip fleet push --with-secrets`).',
      );
    let res;
    try {
      res = await withLock(ctx, function () {
        return transfer.applyImport(
          ctx,
          { format: transfer.FORMAT, version: transfer.VERSION, accounts: toImport },
          { force: rest.indexOf('--force') !== -1 },
        );
      });
    } catch (e) {
      return fail(e.message);
    }
    if (JSON_MODE) {
      jsonOut({ collected: res });
      return;
    }
    print(
      style.ok('✅') +
        ' collected ' +
        res.imported.length +
        ' account(s) from the fleet: ' +
        (res.imported.join(', ') || '(none new)') +
        (res.skipped.length ? style.dim('  (kept: ' + res.skipped.join(', ') + ')') : ''),
    );
    return;
  }

  if (sub === 'panel') {
    const panel = _panel;
    const pi = rest.indexOf('--port');
    const port = pi !== -1 ? parseInt(rest[pi + 1], 10) || 8898 : 8898;
    // The panel is a display surface — strip credentials from every machine before they cross to HTTP.
    const getFleet = function () {
      const statuses = fleet.readFleet(ctx, b);
      const nr = fleet.newReplies(ctx, statuses);
      return { machines: statuses.map(fleet.sanitizeStatus), newReplies: nr.newReplies };
    };
    let h;
    try {
      h = await panel.serveFleet(ctx, { port: port, getFleet: getFleet });
    } catch (e) {
      return fail(
        'could not start the fleet panel: ' +
          (e && e.code === 'EADDRINUSE' ? 'port ' + port + ' in use (try --port N)' : e && e.message),
      );
    }
    print(
      style.ok('✅') +
        ' fleet dashboard on ' +
        style.bold(h.url) +
        '  ' +
        style.dim('(read-only, loopback; Ctrl-C to stop)'),
    );
    if (rest.indexOf('--open') !== -1) {
      const opener = ctx.platform === 'darwin' ? 'open' : ctx.platform === 'win32' ? 'cmd' : 'xdg-open';
      try {
        exec.run(opener, ctx.platform === 'win32' ? ['/c', 'start', h.url] : [h.url]);
      } catch (e) {
        /* ignore */
      }
    }
    await new Promise(function () {
      /* serve until Ctrl-C */
    });
    return;
  }

  return fail(
    'usage: keyflip fleet <init|push|status|switch|send-account|collect|keys|trust|panel> …  (see `keyflip fleet` help)',
  );
}

// Epic F: normalize ANOTHER agent's session file (JSONL, or an Aider .md) into keyflip's
// unified shape and render it with the same exporter. Point it at a file the user provides.
function cmdForeign(ctx, rest) {
  const foreign = _foreign;
  const transcript = _transcript;
  if (rest.indexOf('--list') !== -1) {
    const found = foreign.discover(ctx);
    if (JSON_MODE) {
      jsonOut({ foreign: found });
      return;
    }
    if (!found.length) {
      print(
        style.dim(
          "No other agents' sessions found in the known locations (Cursor / opencode / Gemini / Qoder). These paths are best-effort — point at a file directly: ",
        ) + style.bold('keyflip foreign <file>'),
      );
      return;
    }
    print(style.bold("Other agents' sessions on this machine") + ' ' + style.dim('(best-effort locations):'));
    found.slice(0, 60).forEach(function (f) {
      print(
        '  ' +
          style.ok('●') +
          ' ' +
          f.tool.padEnd(9) +
          ' ' +
          style.dim(f.mtime.slice(0, 16).replace('T', ' ')) +
          '  ' +
          f.path,
      );
    });
    print('');
    print(style.dim('View one:  ') + style.bold('keyflip foreign <path> [--format md|html|json]'));
    return;
  }
  const file = positionals(rest, ['--format', '--out'])[0];
  if (!file)
    return fail(
      "usage: keyflip foreign <session-file> [--format md|html|json] [--out <file|->]\n  reads another agent's session log (message-event JSONL, generic JSON, Cursor SQLite, or an Aider .md).",
    );
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch (e) {
    return fail('cannot read ' + file + ': ' + (e && e.message));
  } // Buffer (Cursor is binary)
  let norm;
  try {
    norm = foreign.normalize(file, raw);
  } catch (e) {
    return fail(e.message);
  }
  if (norm.warning && !JSON_MODE) print(style.warn('⚠ ') + norm.warning);
  const fmt = (flagVal(rest, '--format') || 'md').toLowerCase();
  let out, ext;
  if (fmt === 'html') {
    out = transcript.toHtml(norm, { id: norm.tool });
    ext = 'html';
  } else if (fmt === 'json') {
    out = JSON.stringify(norm, null, 2);
    ext = 'json';
  } else {
    out = transcript.toMarkdown(norm, { id: norm.tool });
    ext = 'md';
  }
  const outArg = flagVal(rest, '--out');
  if (outArg === '-') {
    process.stdout.write(out + (out.slice(-1) === '\n' ? '' : '\n'));
    return;
  }
  const dest = outArg || 'keyflip-foreign-' + norm.tool + '.' + ext;
  try {
    fs.writeFileSync(dest, out);
  } catch (e) {
    return fail('could not write ' + dest + ': ' + (e && e.message));
  }
  if (JSON_MODE) {
    jsonOut({ foreign: { tool: norm.tool, path: dest, format: fmt, messages: norm.counts.messages } });
    return;
  }
  print(
    style.ok('📄') +
      ' normalized a ' +
      style.bold(norm.tool) +
      ' session (' +
      norm.counts.messages +
      ' messages) → ' +
      style.bold("'" + dest + "'") +
      ' ' +
      style.dim('(' + fmt + ')'),
  );
}

// ===================== Wave 4: Context Layer (.keyflip/ portable project memory) =====================

// keyflip context <init | status | show | decision add | task add | task set <id> <status>>
//   plus  keyflip context sync <status|mode <m>|export|check>   (privacy-gated cross-machine sync)
// `.keyflip/` lives in the CURRENT project dir (not configDir) so it travels with the repo.
function cmdContext(ctx, rest) {
  const sub = rest[0];

  // ---- context sync … → ctxsync privacy layer ----
  if (sub === 'sync') {
    const ctxsync = _ctxsync;
    const args = rest.slice(1);
    const opts = {
      projectPath: process.cwd(),
      now: ctx.now,
      run: exec.run,
      passphrase: readSecretArg(args, '--passphrase-file'), // export in encrypted mode
      against: readSecretArg(args, '--against'), // check: a remote payload file to compare
    };
    const r = ctxsync.cli(args, opts);
    if (r.stdout != null) process.stdout.write(r.stdout + '\n'); // the export payload → real stdout
    (r.lines || []).forEach(print);
    if (r.code) process.exitCode = 1;
    return;
  }

  // ---- everything else → projctx store ----
  const projctx = _projctx;
  const pp = process.cwd();
  const opts = { now: ctx.now };
  const fv = function (n) {
    const i = rest.indexOf(n);
    return i !== -1 ? rest[i + 1] : undefined;
  };
  const arg = rest.slice(1);

  if (sub === undefined || sub === 'status' || sub === 'show') {
    if (!projctx.exists(pp)) return fail('no project context here — run: keyflip context init');
    if (JSON_MODE) {
      jsonOut(sub === 'show' ? projctx.pack(pp, opts) : projctx.read(pp, opts));
      return;
    }
    print(projctx.summary(pp, opts));
    if (sub === 'show') {
      print('');
      print(projctx.read(pp, opts).context || '(no context.md)');
    }
    return;
  }
  if (sub === 'init') {
    const c = projctx.init(pp, opts);
    if (JSON_MODE) {
      jsonOut(c);
      return;
    }
    print(style.ok('✅') + ' initialized .keyflip/ for ' + c.project.name);
    return;
  }
  if (sub === 'decision') {
    if (arg[0] !== 'add')
      return fail(
        'usage: keyflip context decision add "<title>" [--rationale <r>] [--alt <a>] [--do-not <d>] [--status decided|rejected|superseded]',
      );
    // Skip value-taking flags AND the values they consume, so e.g. `--status rejected "My decision"`
    // takes "My decision" as the title (not "rejected", the flag's value).
    const title = positionals(arg.slice(1), ['--rationale', '--alt', '--do-not', '--status'])[0];
    if (!title) return fail('usage: keyflip context decision add "<title>" [...]');
    if (!projctx.exists(pp)) projctx.init(pp, opts);
    let d;
    try {
      d = projctx.addDecision(
        pp,
        {
          title: title,
          rationale: fv('--rationale'),
          alternatives: fv('--alt') ? [fv('--alt')] : [],
          doNot: fv('--do-not') ? [fv('--do-not')] : [],
          status: fv('--status'),
        },
        opts,
      );
    } catch (e) {
      return fail(e.message);
    }
    if (JSON_MODE) {
      jsonOut(d);
      return;
    }
    print(style.ok('✅') + ' decision ' + d.id + ': ' + d.title);
    return;
  }
  if (sub === 'task') {
    if (arg[0] === 'add') {
      const title = positionals(arg.slice(1), [])[0];
      if (!title) return fail('usage: keyflip context task add "<title>"');
      if (!projctx.exists(pp)) projctx.init(pp, opts);
      const t = projctx.addTask(pp, { title: title }, opts);
      if (JSON_MODE) {
        jsonOut(t);
        return;
      }
      print(style.ok('✅') + ' task ' + t.id + ': ' + t.title + ' [' + t.status + ']');
      return;
    }
    if (arg[0] === 'set') {
      const id = arg[1],
        status = arg[2];
      if (!id || !status) return fail('usage: keyflip context task set <id> <todo|in_progress|blocked|done>');
      let t;
      try {
        t = projctx.updateTask(pp, id, { status: status }, opts);
      } catch (e) {
        return fail(e.message);
      }
      if (!t) return fail("no such task: '" + id + "'");
      if (JSON_MODE) {
        jsonOut(t);
        return;
      }
      print(style.ok('✅') + ' ' + t.id + ' → ' + t.status);
      return;
    }
    return fail('usage: keyflip context task <add "<title>" | set <id> <status>>');
  }
  return fail(
    'unknown: keyflip context ' +
      sub +
      ' (use: init | status | show | decision add | task add | task set <id> <status> | sync)',
  );
}

// keyflip rules <show | import | emit --to claude|cursor|agents|gemini|generic [--write]>
// Normalize this project's AI rule files into one model and re-emit per tool.
function cmdRules(ctx, rest) {
  const rules = _rules;
  const sub = rest[0];
  const projectPath = flagVal(rest, '--project') || process.cwd();
  const nowOpt = { now: ctx.now };
  if (!sub || sub === 'show') {
    const detected = rules.detectRuleFiles(projectPath);
    const model = rules.importRules(projectPath, nowOpt);
    if (JSON_MODE) {
      jsonOut({ rules: { detected: detected, model: model } });
      return;
    }
    if (!detected.length) {
      print(
        style.dim(
          'No AI rule files in ' +
            projectPath +
            ' (CLAUDE.md, .cursorrules, .cursor/rules/*, AGENTS.md, GEMINI.md, copilot-instructions.md).',
        ),
      );
      return;
    }
    print(style.bold('AI rule files in this project:'));
    detected.forEach(function (d) {
      print('  ' + style.ok('●') + ' ' + d.label.padEnd(16) + ' ' + style.dim(d.files.join(', ')));
    });
    const byKind = {};
    model.sections.forEach(function (s) {
      byKind[s.kind] = (byKind[s.kind] || 0) + 1;
    });
    print('');
    print(
      style.bold('Normalized model: ') +
        model.sections.length +
        ' section(s)  ' +
        style.dim(
          Object.keys(byKind)
            .map(function (k) {
              return k + ':' + byKind[k];
            })
            .join('  '),
        ),
    );
    const red = model.sources.reduce(function (n, s) {
      return n + s.redactions;
    }, 0);
    if (red) print(style.warn('⚠ ') + red + ' secret(s) redacted.');
    print(
      style.dim('Emit for one tool:  ') + style.bold('keyflip rules emit --to claude|cursor|agents|gemini [--write]'),
    );
    return;
  }
  if (sub === 'import') {
    const model = rules.importRules(projectPath, nowOpt);
    const dest = rules.saveModel(projectPath, model);
    if (JSON_MODE) {
      jsonOut({ rules: { saved: dest, sections: model.sections.length, sources: model.sources } });
      return;
    }
    print(
      style.ok('✓') +
        ' normalized ' +
        style.bold(String(model.sources.length)) +
        ' rule file(s) into ' +
        style.bold(model.sections.length + ' section(s)') +
        ' → ' +
        style.bold(dest),
    );
    return;
  }
  if (sub === 'emit') {
    const to = flagVal(rest, '--to');
    if (!to || !rules.EMIT_TARGETS[to])
      return fail('usage: keyflip rules emit --to claude|cursor|agents|gemini|generic [--write] [--out <file|->]');
    const model = rules.loadModel(projectPath) || rules.importRules(projectPath, nowOpt);
    const content = rules.emit(model, to);
    if (rest.indexOf('--write') !== -1) {
      const res = rules.writeTarget(projectPath, to, content);
      if (JSON_MODE) {
        jsonOut({ rules: { emitted: to, path: res.path, bytes: res.bytes } });
        return;
      }
      print(style.ok('📄') + ' wrote the ' + style.bold(to) + ' rule file → ' + style.bold(res.path));
      return;
    }
    const outArg = flagVal(rest, '--out');
    if (outArg && outArg !== '-') {
      fs.writeFileSync(outArg, content);
      print(style.ok('📄') + ' wrote ' + style.bold(outArg));
      return;
    }
    process.stdout.write(content.slice(-1) === '\n' ? content : content + '\n');
    return;
  }
  return fail('usage: keyflip rules <show | import | emit --to claude|cursor|agents|gemini [--write]>');
}

// keyflip checkpoint <list | create --summary "…" | latest | show <id>>
// Git-bound session-boundary snapshots stored in .keyflip/checkpoints/.
async function cmdCheckpoint(ctx, rest) {
  const checkpoint = _checkpoint;
  const projectPath = process.cwd();
  const sub = rest[0];

  function fmt(c) {
    const g = c.git || {};
    const lines = [
      style.bold(c.id) +
        '   ' +
        String(c.at || '')
          .replace('T', ' ')
          .replace(/\.\d+Z$/, 'Z'),
      '  git:      ' +
        (g.branch || '-') +
        (g.commit ? ' @ ' + g.commit : '') +
        (g.dirty && g.dirty.length ? '  (' + g.dirty.length + ' dirty)' : ''),
      '  provider: ' + (c.provider || '-'),
      '  parent:   ' + (c.parent || '(root)'),
      '  summary:  ' + (c.summary || ''),
    ];
    if (g.dirty && g.dirty.length)
      lines.push('  changed:  ' + g.dirty.slice(0, 20).join(', ') + (g.dirty.length > 20 ? ' …' : ''));
    return lines.join('\n');
  }

  if (sub === 'create' || sub === 'save') {
    const si = rest.indexOf('--summary');
    // Exclude --tasks-file (and its value) from the positional summary fallback, else
    // `checkpoint create --tasks-file foo.json` would record "foo.json" as the summary.
    const summary = si !== -1 ? rest[si + 1] || '' : positionals(rest.slice(1), ['--tasks-file']).join(' ');
    let tasksSnapshot;
    const tf = rest.indexOf('--tasks-file');
    if (tf !== -1 && rest[tf + 1]) {
      try {
        tasksSnapshot = JSON.parse(fs.readFileSync(rest[tf + 1], 'utf8'));
      } catch (e) {
        return fail('cannot read --tasks-file: ' + (e && e.message));
      }
    }
    let provider = null;
    try {
      const a = provider.readActive(ctx);
      provider = a ? a.name : 'official';
    } catch (e) {
      /* best-effort */
    }
    const cp = checkpoint.create(
      projectPath,
      { summary: summary, tasksSnapshot: tasksSnapshot, provider: provider },
      { now: ctx.now },
    );
    if (JSON_MODE) return jsonOut({ checkpoint: cp });
    print(
      style.ok('✅') +
        ' checkpoint ' +
        style.bold(cp.id) +
        ' saved' +
        (cp.git.branch ? ' @ ' + cp.git.branch + (cp.git.commit ? ' (' + cp.git.commit + ')' : '') : '') +
        '.',
    );
    if (cp.git.dirty.length) print(style.dim('  ' + cp.git.dirty.length + ' uncommitted file(s)'));
    if (cp.parent) print(style.dim('  parent: ' + cp.parent));
    return;
  }
  if (sub === 'latest') {
    const cp = checkpoint.latest(projectPath);
    if (JSON_MODE) return jsonOut({ checkpoint: cp });
    if (!cp) return print('No checkpoints yet — create one: keyflip checkpoint create --summary "…"');
    return print(fmt(cp));
  }
  if (sub === 'show' || sub === 'get') {
    const cp = checkpoint.get(projectPath, rest[1] || '');
    if (JSON_MODE) return jsonOut({ checkpoint: cp });
    if (!cp) return fail("no checkpoint '" + (rest[1] || '') + "' (see: keyflip checkpoint list).");
    return print(fmt(cp));
  }
  // default: list
  const rows = checkpoint.list(projectPath);
  if (JSON_MODE) return jsonOut({ checkpoints: rows });
  if (!rows.length) return print('No checkpoints yet. Create one: keyflip checkpoint create --summary "…"');
  rows.forEach(function (c, i) {
    const g = c.git || {};
    print(
      '  [' +
        (i + 1) +
        '] ' +
        style.bold(c.id) +
        '  ' +
        String(c.at || '')
          .slice(0, 16)
          .replace('T', ' ') +
        '  ' +
        (g.branch || '-') +
        (g.commit ? '@' + g.commit : '') +
        (c.summary ? '  ' + style.dim(c.summary.slice(0, 60)) : ''),
    );
  });
  print('\nShow one: keyflip checkpoint show <id>   ·   latest: keyflip checkpoint latest');
}

// keyflip handoff [--to <tool>] [--path <dir>] [--out <file|->]
// Print a target-aware CONTINUE-PROMPT so a NEW AI tool can resume this project from .keyflip/.
function cmdHandoff(ctx, rest) {
  const handoffmod = _handoffmod;
  if (rest.indexOf('--help') !== -1 || rest.indexOf('-h') !== -1) {
    return print(
      'usage: keyflip handoff [--to <claude|cursor|kiro|opencode|windsurf|generic>] [--path <dir>] [--out <file|->]\n' +
        '  Prints a CONTINUE-PROMPT (markdown) so a NEW AI tool can resume THIS project from .keyflip/\n' +
        '  (context.md, tasks.json, decisions.json, rules/, checkpoints/latest.json) without re-reading everything.',
    );
  }
  const to = flagVal(rest, '--to') || flagVal(rest, '--target');
  const projectPath = flagVal(rest, '--path') || '.';
  let r;
  try {
    r = handoffmod.handoff(projectPath, { target: to, now: ctx.now });
  } catch (e) {
    return fail(e.message);
  }
  if (JSON_MODE) {
    jsonOut({
      handoff: { target: r.target, providers: r.providers, files: r.files, project: r.project, prompt: r.text },
    });
    return;
  }
  const outArg = flagVal(rest, '--out');
  if (outArg && outArg !== '-') {
    try {
      fs.writeFileSync(outArg, r.text);
    } catch (e) {
      return fail('could not write ' + outArg + ': ' + (e && e.message));
    }
    print(style.ok('📄') + ' wrote a ' + style.bold(r.target) + ' continue-prompt → ' + style.bold("'" + outArg + "'"));
    return;
  }
  process.stdout.write(r.text); // to stdout so it can be piped straight into the next tool
}

// Export a session transcript as a clean, shareable markdown / HTML / json document.
function cmdSessionsExport(ctx, rest) {
  const transcript = _transcript;
  const id = positionals(rest, ['--format', '--out'])[0];
  if (!id) return fail('usage: keyflip sessions export <id> [--format md|html|json] [--out <file|->]');
  let row;
  try {
    row = sessions.find(ctx, id);
  } catch (e) {
    return fail(e.message);
  }
  if (!row) return fail("no session matches '" + id + "'.");
  let raw;
  try {
    raw = fs.readFileSync(row.file, 'utf8');
  } catch (e) {
    return fail('cannot read the transcript: ' + (e && e.message));
  }
  const parsed = transcript.parse(raw);
  const fmt = (flagVal(rest, '--format') || 'md').toLowerCase();
  let out, ext;
  if (fmt === 'html') {
    out = transcript.toHtml(parsed, { id: row.sessionId });
    ext = 'html';
  } else if (fmt === 'json') {
    out = JSON.stringify(parsed, null, 2);
    ext = 'json';
  } else {
    out = transcript.toMarkdown(parsed, { id: row.sessionId });
    ext = 'md';
  }
  const outArg = flagVal(rest, '--out');
  if (outArg === '-') {
    process.stdout.write(out + (out.slice(-1) === '\n' ? '' : '\n'));
    return;
  }
  const file = outArg || 'keyflip-session-' + row.sessionId.slice(0, 8) + '.' + ext;
  try {
    fs.writeFileSync(file, out);
  } catch (e) {
    return fail('could not write ' + file + ': ' + (e && e.message));
  }
  if (JSON_MODE) {
    jsonOut({ sessionExport: { path: file, format: fmt, messages: parsed.counts.messages } });
    return;
  }
  print(
    style.ok('📄') +
      ' exported ' +
      parsed.counts.messages +
      ' message(s) to ' +
      style.bold("'" + file + "'") +
      ' ' +
      style.dim('(' + fmt + ', ' + parsed.counts.user + ' you / ' + parsed.counts.assistant + ' Claude)'),
  );
}

// Resolve a session arg (a 1-based list index or a sessionId / prefix) to its row {sessionId, project}.
function resolveSessionArg(ctx, arg) {
  if (!arg) return null;
  const rows = sessions.list(ctx, { limit: 100000 });
  if (/^[0-9]{1,4}$/.test(arg)) return rows[parseInt(arg, 10) - 1] || null;
  return (
    rows.filter(function (r) {
      return r.sessionId === arg;
    })[0] ||
    rows.filter(function (r) {
      return r.sessionId.indexOf(arg) === 0;
    })[0] ||
    null
  );
}

// keyflip sessions delete <id|#> [--hard]   — archive-then-remove (recoverable) by default.
async function cmdSessionsDelete(ctx, rest) {
  const row = resolveSessionArg(ctx, rest[0]);
  if (!row) return fail('no such session (pass a list number or a session id — see `keyflip sessions`).');
  const hard = rest.indexOf('--hard') !== -1;
  // `let`, not `const`: a session written minutes ago has its --force/-y downgrade below, because
  // "skip the confirmation" is not the same claim as "this conversation is finished".
  let force = rest.indexOf('--force') !== -1 || rest.indexOf('-y') !== -1;
  // A session a live `claude --resume` process is writing is not "old history" — deleting it
  // yanks the file out from under a running conversation (and --force must not be able to do
  // that silently, because --force here only means "skip the prompt").
  if (row.liveReason === 'running' && rest.indexOf('--allow-running') === -1)
    return fail(
      'session ' +
        row.sessionId.slice(0, 8) +
        ' is in use by a running `claude --resume` process — end that session first, or pass --allow-running if you mean it.',
    );
  // Written minutes ago: --force/-y must not skip the prompt either, because "skip the
  // confirmation" is not the same as "I know this conversation is still being appended to".
  if (row.recentlyWritten && rest.indexOf('--allow-running') === -1) force = false;
  if (!force) {
    if (!process.stdin.isTTY && row.recentlyWritten)
      return fail(
        'session ' +
          row.sessionId.slice(0, 8) +
          ' was written minutes ago — needs a TTY to confirm, or --allow-running if you are sure.',
      );
    if (!process.stdin.isTTY) return fail('deleting a session needs confirmation — re-run with --force (or -y)');
    const q = hard
      ? 'PERMANENTLY delete session ' + row.sessionId.slice(0, 8) + ' (NOT recoverable)? [y/N] '
      : 'Delete session ' +
        row.sessionId.slice(0, 8) +
        '? It is archived first (recover with `keyflip sessions unarchive`). [y/N] ';
    if (!(await confirm(q))) {
      print('Cancelled.');
      return;
    }
  }
  const r = _sessionedit.deleteSession(ctx, { project: row.project, sessionId: row.sessionId, hard: hard });
  if (!r.ok) return fail('could not delete: ' + (r.reason || 'unknown'));
  if (JSON_MODE) {
    jsonOut({ deleted: r });
    return;
  }
  print(
    style.ok('✅') +
      (r.mode === 'archived'
        ? ' archived + removed session ' +
          style.bold(row.sessionId.slice(0, 8)) +
          ' ' +
          style.dim('(recover: keyflip sessions unarchive ' + row.sessionId + ')')
        : ' permanently deleted session ' + style.bold(row.sessionId.slice(0, 8)) + '.'),
  );
  logmod.log('sessions delete ' + row.sessionId + ' (' + r.mode + ')');
}

// keyflip sessions scrub <id|#> [--apply] [--categories a,b,c] [--llm-url URL] — redact PII from a transcript.
async function cmdSessionsScrub(ctx, rest) {
  const row = resolveSessionArg(ctx, rest[0]);
  if (!row) return fail('no such session (pass a list number or a session id).');
  const apply = rest.indexOf('--apply') !== -1;
  const catArg = flagVal(rest, '--categories');
  const pii = _pii;
  const opts = {
    project: row.project,
    sessionId: row.sessionId,
    apply: apply,
    categories: catArg
      ? catArg
          .split(',')
          .map(function (s) {
            return s.trim();
          })
          .filter(Boolean)
      : undefined,
    custom: pii.loadCustom(ctx),
  };
  const url = flagVal(rest, '--llm-url');
  if (url) opts.llm = { url: url, model: flagVal(rest, '--llm-model') || undefined };
  const r = _sessionedit.scrubSession(ctx, opts);
  if (!r.ok) return fail('could not scrub: ' + (r.reason || 'unknown'));
  if (JSON_MODE) {
    jsonOut({ scrub: r });
    return;
  }
  const total = Object.keys(r.redactions || {}).reduce(function (n, k) {
    return n + r.redactions[k];
  }, 0);
  const bykind =
    Object.keys(r.redactions || {})
      .map(function (k) {
        return k + ':' + r.redactions[k];
      })
      .join('  ') || '(none)';
  if (!apply) {
    print(
      style.bold('Dry run') +
        ' — ' +
        total +
        ' PII match(es) in ' +
        r.messagesScanned +
        ' message(s): ' +
        style.dim(bykind),
    );
    print('Apply the redaction (backs up first): ' + style.bold('keyflip sessions scrub ' + rest[0] + ' --apply'));
    return;
  }
  print(
    style.ok('🧹') +
      ' redacted ' +
      total +
      ' PII match(es) ' +
      style.dim(bykind) +
      ' — backup: ' +
      style.bold(r.backup || '(none)'),
  );
  logmod.log('sessions scrub ' + row.sessionId + ' applied (' + total + ')');
}

// keyflip sessions edit <id|#> <delete-message|redact-message|truncate-after> <index> [--apply]
async function cmdSessionsEdit(ctx, rest) {
  const row = resolveSessionArg(ctx, rest[0]);
  if (!row) return fail('no such session (pass a list number or a session id).');
  const type = rest[1];
  const index = parseInt(rest[2], 10);
  if (['delete-message', 'redact-message', 'truncate-after'].indexOf(type) === -1 || isNaN(index)) {
    return fail(
      'usage: keyflip sessions edit <id|#> <delete-message|redact-message|truncate-after> <index> [--apply] [--replacement <text>]',
    );
  }
  const apply = rest.indexOf('--apply') !== -1;
  const op = { type: type, index: index, apply: apply };
  const rep = flagVal(rest, '--replacement');
  if (rep) op.replacement = rep;
  const r = _sessionedit.editSession(ctx, { project: row.project, sessionId: row.sessionId, op: op });
  if (!r.ok) return fail('could not edit: ' + (r.reason || 'unknown'));
  if (JSON_MODE) {
    jsonOut({ edit: r });
    return;
  }
  if (!apply) {
    print(
      style.bold('Dry run') +
        ' — ' +
        type +
        ' @ ' +
        index +
        ': ' +
        r.before +
        ' → ' +
        r.after +
        ' event line(s). Add --apply (backs up first).',
    );
    return;
  }
  print(
    style.ok('✅') +
      ' ' +
      type +
      ' @ ' +
      index +
      ' applied' +
      (r.backup ? ' — backup: ' + style.bold(r.backup) : '') +
      '.',
  );
  logmod.log('sessions edit ' + row.sessionId + ' ' + type + '@' + index);
}

// keyflip sessions backups [--apply] — reclaim rebind's duplicate snapshots.
// Nothing else in keyflip ever shows `<key>.keyflip-bak` (list() filters it out on purpose),
// so without this command those copies are invisible AND permanent.
function cmdSessionsBackups(ctx, rest) {
  const apply = rest.indexOf('--apply') !== -1;
  const r = sessions.pruneBackups(ctx, { apply: apply });
  if (JSON_MODE) {
    jsonOut({ rebindBackups: r });
    return;
  }
  if (!r.keys.length) {
    print(style.ok('✅') + ' no rebind backups (' + style.bold('.keyflip-bak') + ') in the projects folder.');
    return;
  }
  r.keys.forEach(function (k) {
    const tag =
      k.status === 'redundant'
        ? style.ok('redundant')
        : k.status === 'empty'
          ? style.dim('empty folder')
          : style.warn('kept — ' + k.blockers.join(', '));
    print(
      '  ' +
        k.key +
        '  ' +
        style.dim(k.files + ' file(s), ' + fmtBytes(k.bytes)) +
        '  ' +
        tag +
        (k.status === 'redundant' && apply ? '  ' + style.dim('(removed)') : ''),
    );
  });
  print('');
  if (apply)
    print(
      style.ok('✅') +
        ' removed ' +
        r.removed +
        ' redundant backup(s) — ' +
        fmtBytes(r.removableBytes) +
        ' ' +
        style.dim('(undo with: keyflip undo)') +
        (r.kept ? ', ' + r.kept + ' kept (unproven)' : ''),
    );
  else
    print(
      r.removable
        ? style.warn('⚠') +
            ' ' +
            r.removable +
            ' backup(s) are provably redundant (' +
            fmtBytes(r.removableBytes) +
            '): ' +
            style.bold('keyflip sessions backups --apply') +
            '. ' +
            style.dim(
              'A backup is redundant only when the live key holds a byte-identical copy of every ' +
                'file AND that session id now exists in another project key.',
            )
        : style.ok('✅') + ' nothing removable — every backup still holds something unique.',
    );
}

// keyflip sessions empty [--apply] — prune project keys that contain no files at all.
function cmdSessionsEmpty(ctx, rest) {
  const apply = rest.indexOf('--apply') !== -1;
  const r = sessions.emptyProjects(ctx, { apply: apply });
  if (JSON_MODE) {
    jsonOut({ emptyProjects: r });
    return;
  }
  if (!r.empty && !r.notesOnly.length && !r.sidecarsOnly.length) {
    print(style.ok('✅') + ' no empty project folders.');
    return;
  }
  if (r.empty)
    print(
      (apply ? style.ok('✅') + ' removed ' + r.removed : style.warn('⚠') + ' ' + r.empty) +
        ' folder(s) with ZERO files inside' +
        (apply ? '' : ' — ' + style.bold('keyflip sessions empty --apply') + ' removes them'),
    );
  // Reported, never removed: these still hold content (notes / sub-agent runs).
  r.notesOnly.forEach(function (k) {
    print(
      '  ' +
        style.dim('memory-only key (kept): ') +
        k.key +
        ' ' +
        style.dim(k.files + ' file(s), ' + fmtBytes(k.bytes)),
    );
  });
  r.sidecarsOnly.forEach(function (k) {
    print(
      '  ' +
        style.dim('transcript-less sidecar (kept): ') +
        k.key +
        ' ' +
        style.dim(k.files + ' file(s), ' + fmtBytes(k.bytes)),
    );
  });
}

async function cmdSessions(ctx, rest) {
  if (rest[0] === 'rebind') return cmdSessionsRebind(ctx, rest.slice(1));
  if (rest[0] === 'backups') return cmdSessionsBackups(ctx, rest.slice(1));
  if (rest[0] === 'empty') return cmdSessionsEmpty(ctx, rest.slice(1));
  if (rest[0] === 'archive') return cmdSessionsArchive(ctx, rest.slice(1));
  if (rest[0] === 'unarchive') return cmdSessionsUnarchive(ctx, rest.slice(1));
  if (rest[0] === 'archived') return cmdSessionsArchived(ctx, rest.slice(1));
  if (rest[0] === 'distill') return cmdSessionsDistill(ctx, rest.slice(1));
  if (rest[0] === 'compact') return cmdSessionsCompact(ctx, rest.slice(1));
  if (rest[0] === 'assign')
    return withLock(ctx, function () {
      return cmdSessionsAssign(ctx, rest.slice(1));
    });
  if (rest[0] === 'unassign')
    return withLock(ctx, function () {
      return cmdSessionsUnassign(ctx, rest.slice(1));
    });
  if (rest[0] === 'attribute')
    return withLock(ctx, function () {
      return cmdSessionsAttribute(ctx, rest.slice(1));
    });
  if (rest[0] === 'export') return cmdSessionsExport(ctx, rest.slice(1));
  if (rest[0] === 'delete' || rest[0] === 'rm')
    return withLock(ctx, function () {
      return cmdSessionsDelete(ctx, rest.slice(1));
    });
  if (rest[0] === 'scrub')
    return withLock(ctx, function () {
      return cmdSessionsScrub(ctx, rest.slice(1));
    });
  if (rest[0] === 'edit')
    return withLock(ctx, function () {
      return cmdSessionsEdit(ctx, rest.slice(1));
    });
  const opts = {
    search: flagVal(rest, '--search'),
    cwd: rest.indexOf('--cwd') !== -1 ? (flagVal(rest, '--cwd') === undefined ? '.' : flagVal(rest, '--cwd')) : null,
    limit: parseInt(flagVal(rest, '--limit'), 10) || 40,
  };
  if (rest.indexOf('--here') !== -1) opts.cwd = '.';
  const rows = sessions.list(ctx, opts);
  if (JSON_MODE) {
    jsonOut({
      sessions: rows.map(function (r) {
        return {
          sessionId: r.sessionId,
          cwd: r.cwd,
          mtime: r.mtime,
          sizeBytes: r.sizeBytes,
          preview: r.preview,
          match: r.match || null,
          orphan: !!r.orphan,
          live: !!r.live,
          liveReason: r.liveReason || null,
          staleCwd: !!r.staleCwd,
          recentlyWritten: !!r.recentlyWritten,
        };
      }),
    });
    return;
  }
  if (!rows.length) {
    print('No sessions found' + (opts.search ? ' matching "' + opts.search + '"' : '') + '.');
    return;
  }
  let orphans = 0;
  let stale = 0;
  rows.forEach(function (r, i) {
    if (r.orphan) orphans++;
    if (r.staleCwd) stale++;
    print(
      '  [' +
        (i + 1) +
        '] ' +
        r.sessionId.slice(0, 8) +
        '  ' +
        r.mtime.slice(0, 16).replace('T', ' ') +
        '  ' +
        (r.cwd || '?') +
        (r.orphan ? '  ' + style.warn('⚠ folder missing') : '') +
        (r.orphan && r.recentlyWritten ? '  ' + style.warn('(written minutes ago — check nothing uses it)') : '') +
        // A gone cwd on a session that is RUNNING / in the desktop app's Recents / being written
        // is a stale path record, not an orphan. Say so — otherwise this list reads as
        // "safe to delete" for exactly the sessions someone is using right now.
        (r.staleCwd
          ? '  ' +
            style.dim(
              '(cwd gone, but ' +
                (r.liveReason === 'running'
                  ? 'a claude --resume process is using it'
                  : 'the Claude desktop app lists it') +
                ' — do not delete)',
            )
          : ''),
    );
    // On a search, show WHERE it matched (a content snippet); otherwise the first message.
    if (opts.search && r.match && r.match !== r.preview) print('        ' + style.dim('↳ ' + r.match));
    else if (r.preview) print('        ' + style.dim('“' + r.preview + '”'));
  });
  print('');
  if (orphans)
    print(
      style.warn('⚠') +
        ' ' +
        orphans +
        ' session(s) point at a folder that no longer exists — re-link with: ' +
        style.bold('keyflip sessions rebind <old-path> <new-path>'),
    );
  if (stale)
    print(
      style.dim(
        'ℹ ' +
          stale +
          ' session(s) record a folder that is gone while the session itself is live (pruned worktree or a rename the app still resolves). ' +
          'Not orphans — leave them alone, or rebind if you want the path tidied.',
      ),
    );
  print('Resume one with:  keyflip resume <number|id>   (add --run to launch it)');
}

// ---- #35 threads -------------------------------------------------------------
//
// A THREAD is keyflip's own store (`<configDir>/threads/<slug>.json`): one name for the sessions that
// are the SAME task, worked on across accounts. It holds POINTERS — a local session id, a claude.ai
// chat uuid — so the transcripts stay exactly where Claude Code wrote them and a thread is non-secret
// metadata: git-versioned with the rest of keyflip's state, and it rides `migrate`/`history`/`restore`.
// Only `threads mirror`, behind the `threads.mirror` config flag, puts conversation TEXT on disk, and
// that directory is a registered secret dir (0600, never versioned, never backed up).
const THREADS_VALUE_FLAGS = [
  '--title',
  '--notes',
  '--account',
  '--label',
  '--limit',
  '--max-mib',
  '--session',
  '--chat-id',
];
const THREADS_USAGE =
  'usage: keyflip threads [list] | create <slug> [--title "…"] | add <slug> <id> [--chat] | show <slug> | open <slug> | where <id> | suggest | mirror <slug> | drop <slug>';

// Resolve a thread or stop the command. Ambiguous prefixes and corrupt files THROW (the module
// refuses to write over damage); `fail` turns that into the usual exit 1 + machine-readable error.
function threadAt(ctx, selection) {
  if (!selection) {
    fail('which thread? ' + THREADS_USAGE);
    return null;
  }
  try {
    return _threads.read(ctx, selection);
  } catch (e) {
    fail(e.message);
    return null;
  }
}

function threadStamp(iso) {
  return String(iso || '?')
    .slice(0, 16)
    .replace('T', ' ');
}

// `--json` is the thread surface an agent pastes into a transcript, so it follows the rule keyflip
// learned with `keyflip_chains` and over MCP: a state-repo path comes back RELATIVE to the state dir and
// a transcript RELATIVE to ~/.claude/projects, never as `/Users/<name>/…`. The human-facing lines keep
// the absolute path, because there it is a file the user may want to open. Anything outside those two
// roots stays exactly as written — a resume command needs its cwd, and a working directory is not a
// secret.
function threadJsonForAgent(ctx, value) {
  if (typeof value === 'string') {
    if (value.charAt(0) !== '/') return value;
    const inState = path.relative(ctx.configDir, value);
    if (inState && inState.indexOf('..') !== 0) return inState;
    const inTranscripts = path.relative(sessions.projectsDir(ctx), value);
    if (inTranscripts && inTranscripts.indexOf('..') !== 0) return inTranscripts;
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(function (v) {
      return threadJsonForAgent(ctx, v);
    });
  }
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach(function (k) {
      out[k] = threadJsonForAgent(ctx, value[k]);
    });
    return out;
  }
  return value;
}

function threadsList(ctx) {
  const rows = _threads.summaries(ctx);
  const st = _threads.stats(ctx);
  if (JSON_MODE) {
    jsonOut(threadJsonForAgent(ctx, { threads: rows, stats: st }));
    return;
  }
  if (!rows.length) {
    print('No threads yet.');
    print('A thread gives one task a single name across accounts, so switching does not fragment it:');
    print('  ' + style.bold('keyflip threads create <slug> --title "…"') + ', then');
    print('  ' + style.bold('keyflip threads add <slug> <session-id>') + ' for every session that belongs to it.');
    print(
      style.dim('Not sure what is already split? ') +
        style.bold('keyflip threads suggest') +
        style.dim(' finds work two or more accounts have touched.'),
    );
    return;
  }
  rows.forEach(function (r, i) {
    print(
      '  [' +
        (i + 1) +
        '] ' +
        style.bold(r.slug) +
        '  ' +
        r.members +
        ' member(s): ' +
        r.sessions +
        ' session(s)' +
        (r.chats ? ', ' + r.chats + ' chat(s)' : '') +
        '  ' +
        style.dim(threadStamp(r.updatedAt)),
    );
    if (r.title && _threads.slugify(r.title) !== r.slug) print('        ' + style.dim('“' + r.title + '”'));
    print(
      '        ' +
        style.dim(
          r.accounts.length
            ? 'accounts: ' + r.accounts.join(', ') + (r.inferred ? '  (' + r.inferred + ' inferred)' : '')
            : 'no account attributed yet (`keyflip sessions attribute` to guess, `assign` to state)',
        ),
    );
    if (r.corrupt) print('        ' + style.warn('⚠ unreadable thread file: ' + r.file));
    else if (r.droppedMembers)
      print('        ' + style.warn('⚠ ' + r.droppedMembers + ' invalid member(s) ignored in ' + r.file));
  });
  print('');
  if (st.spanning.length)
    print(
      style.ok('✓') +
        ' ' +
        st.spanning.length +
        ' thread(s) span more than one account: ' +
        st.spanning.slice(0, 6).join(', ') +
        (st.spanning.length > 6 ? ', …' : ''),
    );
  if (st.noAccount)
    print(
      style.warn('⚠ ') +
        st.noAccount +
        ' member(s) of ' +
        st.noAccountSlugs.slice(0, 6).join(', ') +
        (st.noAccountSlugs.length > 6 ? ', …' : '') +
        ' have no account resolved — `threads open` would resume them as the CURRENT account.' +
        style.dim(
          '  Fix: keyflip sessions attribute   (or assign by hand: keyflip sessions assign <session-id> <account>)',
        ),
    );
  print(
    style.dim('Merged view: ') +
      style.bold('keyflip threads show <slug> --timeline') +
      style.dim('   ·   continue it: ') +
      style.bold('keyflip threads open <slug>'),
  );
  if (st.mirrorEnabled)
    print(
      style.dim(
        'ℹ threads.mirror is ON: merged conversation text may exist in ' +
          _threads.mirrorDir(ctx) +
          ' (' +
          st.mirrorFiles +
          ' file(s), 0600, never versioned or backed up). Off: keyflip config set threads.mirror false',
      ),
    );
}

// A thread is a POINTER, and only an exact id stays followable after a month of new sessions. Every
// other keyflip surface accepts a unique prefix — `threads suggest` prints 8-char ids itself — so a
// prefix is accepted here and expanded against the transcript index before it is written. Two outcomes
// the user has to decide about: several sessions share the prefix (refused, candidates listed — which
// conversation a thread means is not keyflip's guess), and nothing local matches (kept verbatim: work
// on the user's other machine is still that work, and dropping the pointer would lose it).
// Returns the member plus the resolution, so the caller can tell "expanded from a prefix" apart from
// "no transcript here" without re-searching. Undefined when the prefix was ambiguous (already reported).
function threadResolveMember(ctx, member, idx) {
  if (member.kind !== 'session')
    return { member: member, res: { matched: null, expanded: false, unknown: false, original: member.id } };
  const r = _threads.resolveSessionId(ctx, member.id, idx);
  if (r.ambiguous.length)
    return fail(
      '"' +
        member.id +
        '" is the start of ' +
        r.ambiguous.length +
        ' sessions (' +
        r.ambiguous
          .slice(0, 4)
          .map(function (id) {
            return id.slice(0, 8);
          })
          .join(', ') +
        (r.ambiguous.length > 4 ? ', …' : '') +
        ') — give a longer id',
    );
  const expanded = r.id !== member.id;
  member.id = r.id;
  // ONLY the project key is stored, never a label copied out of the transcript. The first user message
  // is where a pasted API key lives, and threads/*.json is git-versioned and rides along with
  // `migrate` — a pointer file that quotes conversation prose would break the one rule of this feature.
  // The preview still SHOWS in `threads show`, because expand() reads it live from the transcript.
  if (r.matched) member.project = r.matched.project;
  return {
    member: member,
    res: { matched: r.matched, expanded: expanded, unknown: !!r.unknown, original: r.original },
  };
}

function threadsCreate(ctx, rest) {
  const pos = positionals(rest, THREADS_VALUE_FLAGS);
  const slug = pos[0];
  const title = flagVal(rest, '--title');
  if (!slug && !title) return fail(THREADS_USAGE);
  let member = threadMemberFromFlags(rest);
  if (member) {
    const r = threadResolveMember(ctx, member, _threads.index(ctx));
    if (!r) return;
    member = r.member;
  }
  try {
    const t = _threads.create(ctx, {
      slug: slug,
      title: title || undefined,
      notes: flagVal(rest, '--notes') || '',
      member: member || undefined,
    });
    print(
      style.ok('✅') +
        ' created thread ' +
        style.bold(t.slug) +
        (t.title && t.title !== t.slug ? ' — ' + t.title : '') +
        '.',
    );
    print(
      style.dim('Add the sessions that belong to it: ') +
        style.bold('keyflip threads add ' + t.slug + ' <session-id>') +
        style.dim('   (ids: keyflip sessions --here)'),
    );
    jsonOut(threadJsonForAgent(ctx, { created: t }));
  } catch (e) {
    fail(e.message);
  }
}

// `--chat` / `--cloud` marks a claude.ai conversation uuid. A local session id and a chat uuid are
// BOTH UUIDs, so keyflip cannot tell them apart from the string alone — the flag is the only honest
// answer, and `threads show` then reads it through that account's cookie snapshot instead of claiming
// it can see a server-side conversation.
function threadMemberFromFlags(rest) {
  const pos = positionals(rest, THREADS_VALUE_FLAGS);
  const isChat = rest.indexOf('--chat') !== -1 || rest.indexOf('--cloud') !== -1;
  const explicit = flagVal(rest, isChat ? '--chat-id' : '--session');
  const id = explicit || pos[1] || null;
  const out = { kind: isChat ? 'chat' : 'session', id: id };
  const account = flagVal(rest, '--account');
  const label = flagVal(rest, '--label');
  if (account) out.account = account;
  if (label) out.label = label;
  return out.id ? out : null;
}

function threadsAdd(ctx, rest) {
  const pos = positionals(rest, THREADS_VALUE_FLAGS);
  const slug = pos[0];
  const t = threadAt(ctx, slug);
  if (!t) return;
  let member = threadMemberFromFlags(rest);
  if (!member) return fail('which session or chat? ' + THREADS_USAGE);
  if (member.account) {
    const name = core.resolveProfile(ctx, member.account);
    if (!name) return fail("no such account: '" + member.account + "' (see: keyflip list)");
    member.account = name;
  }
  // Fill in what is visible NOW — the exact id, the project key (a fast path back to the file) and a
  // label — and say out loud when the id resolves to nothing on this machine. A thread MAY name work
  // that lives on another computer, so that is a note, not a refusal.
  const idx = _threads.index(ctx);
  const r = threadResolveMember(ctx, member, idx);
  if (!r) return;
  member = r.member;
  if (member.kind === 'session') {
    if (r.res.unknown && !member.label) {
      print(
        style.dim(
          'ℹ no transcript for ' +
            member.id.slice(0, 8) +
            ' on this machine — added anyway. It will show as missing in `threads show` until that folder exists.',
        ),
      );
    } else if (r.res.expanded)
      print(style.dim('ℹ "' + r.res.original + '" expands to the full id ' + member.id + ' — the thread stores that.'));
    const already = _threads.threadsFor(ctx, 'session', member.id).filter(function (r) {
      return r.slug !== t.slug;
    });
    if (already.length)
      print(
        style.warn('⚠') +
          ' that session is already in ' +
          style.bold(already.length === 1 ? already[0].slug : already.length + ' threads') +
          ' — a thread is a name, not a container, so this is allowed. Re-check with: keyflip threads where ' +
          member.id.slice(0, 8),
      );
  } else if (!member.account) {
    print(
      style.dim(
        'ℹ a cloud chat with no --account is read with the LIVE desktop-app cookie. To pin it to a saved account ' +
          '(whose own cookie snapshot `keyflip chat get` uses): keyflip threads add ' +
          t.slug +
          ' ' +
          member.id.slice(0, 8) +
          ' --chat --account <name>',
      ),
    );
  }
  try {
    const out = _threads.addMember(ctx, t.slug, member);
    print(
      style.ok('✅') +
        ' ' +
        member.kind +
        ' ' +
        style.bold(member.id.slice(0, 8)) +
        (member.account ? ' as ' + (profiles.email(ctx.configDir, member.account) || member.account) : '') +
        ' is now part of ' +
        style.bold(t.slug) +
        ' (' +
        out.members.length +
        ' member(s)).',
    );
    jsonOut(
      threadJsonForAgent(ctx, {
        added: { thread: t.slug, member: out.members[out.members.length - 1] || member },
        thread: out,
      }),
    );
  } catch (e) {
    fail(e.message);
  }
}

function threadsRemove(ctx, rest) {
  const pos = positionals(rest, THREADS_VALUE_FLAGS);
  const slug = pos[0];
  const t = threadAt(ctx, slug);
  if (!t) return;
  if (!pos[1]) return fail('which member? usage: keyflip threads remove <slug> <id|kind:id>');
  try {
    const r = _threads.removeMember(ctx, t.slug, pos[1]);
    if (!r)
      return fail("no member of '" + t.slug + "' matches '" + pos[1] + "' (see: keyflip threads show " + t.slug + ')');
    print(
      style.ok('✅') +
        ' unlinked ' +
        style.bold(r.removed.kind + ':' + r.removed.id.slice(0, 8)) +
        ' from ' +
        style.bold(t.slug) +
        '. The conversation itself was not touched.',
    );
    jsonOut(threadJsonForAgent(ctx, { removed: r.removed, thread: r.thread }));
  } catch (e) {
    fail(e.message);
  }
}

function threadMembersOf(ctx, t, opts) {
  const idx = opts.idx || _threads.index(ctx);
  const assigned = opts.assigned || _threads.assignments(ctx);
  // `sources` is the provenance sidecar (#50), read once per command like the assignment map:
  // it is what lets a member print "inferred" instead of pretending a guess is the user's word.
  const sources = opts.sources || attrib.sources(ctx);
  return _threads.expand(ctx, t, { index: idx, assigned: assigned, sources: sources });
}

function printThreadMembers(exp) {
  exp.rows.forEach(function (r, i) {
    const who = r.account
      ? style.bold(r.account) + (r.provenance === 'inferred' ? style.dim(' (inferred)') : '')
      : style.dim('unassigned');
    const head =
      '  [' +
      (i + 1) +
      '] ' +
      style.bold(r.kind + ' ' + r.id.slice(0, 8)) +
      '  ' +
      who +
      '  ' +
      style.dim(threadStamp(r.mtime));
    print(head);
    if (!r.resolved) {
      print('        ' + style.warn('⚠ ' + r.reason));
      return;
    }
    if (r.label) print('        ' + style.dim('“' + String(r.label).slice(0, 90) + '”'));
    print(
      '        ' +
        style.dim((r.cwd || '?') + ' · ' + fmtBytes(r.sizeBytes) + (r.cwdGone ? '  ⚠ folder missing — rebind?' : '')),
    );
    print(
      '        ' +
        style.dim('resume: ') +
        style.bold('cd ' + (r.cwd || '.') + ' && ' + r.resume.command + ' ' + r.resume.args.join(' ')) +
        (r.account ? style.dim('   (or keyflip resume ' + r.id.slice(0, 8) + ' --run)') : ''),
    );
  });
  if (exp.missing)
    print(
      style.dim(
        '\nℹ ' +
          exp.missing +
          ' member(s) do not resolve here. A thread is a set of POINTERS, so that is normal for work done on another machine — it is not a missing conversation.',
      ),
    );
}

function threadsShow(ctx, rest) {
  const pos = positionals(rest, THREADS_VALUE_FLAGS);
  const t = threadAt(ctx, pos[0]);
  if (!t) return;
  const wantTimeline = rest.indexOf('--timeline') !== -1;
  const wantMd = rest.indexOf('--md') !== -1 || (rest.indexOf('--format') !== -1 && flagVal(rest, '--format') === 'md');
  const limit = parseInt(flagVal(rest, '--limit'), 10);
  const maxTotal = Number.isNaN(limit) ? 200 : Math.max(0, limit);
  const idx = _threads.index(ctx);
  const assigned = _threads.assignments(ctx);
  const opts = { index: idx, assigned: assigned, maxTotal: maxTotal || undefined };
  if (rest.indexOf('--max-mib') !== -1) {
    const n = parseInt(flagVal(rest, '--max-mib'), 10);
    if (!Number.isNaN(n) && n > 0) opts.maxBytes = Math.min(512, n) * 1024 * 1024;
  }
  const exp = threadMembersOf(ctx, t, { idx: idx, assigned: assigned });
  const tl = wantTimeline || wantMd || rest.indexOf('--mirror') !== -1 ? _threads.timeline(ctx, t, opts) : null;
  if (JSON_MODE) {
    const payload = { thread: t, members: exp.rows, accounts: exp.accounts, missing: exp.missing };
    if (tl) {
      payload.timeline = tl.messages.slice(0, maxTotal || tl.messages.length);
      payload.unavailable = tl.unavailable;
      payload.droppedFromStart = tl.droppedFromStart;
      payload.cappedMembers = tl.cappedMembers;
    }
    jsonOut(threadJsonForAgent(ctx, payload));
    return;
  }
  if (wantMd) {
    // --md is this command's machine-readable form: it prints ONLY the document, so it pipes into a
    // file, a clipboard, or an agent context without a human header glued to the front. The header and
    // the member table belong to the default output below.
    print(_threads.toMarkdown(ctx, t, Object.assign({}, opts, { expand: exp, timeline: tl })));
    return;
  }
  print(style.bold(t.slug) + (t.title && t.title !== t.slug ? ' — ' + t.title : ''));
  if (t.notes) print(style.dim(t.notes));
  print(
    style.dim(
      'created ' +
        threadStamp(t.createdAt) +
        ' · updated ' +
        threadStamp(t.updatedAt) +
        ' · ' +
        exp.rows.length +
        ' member(s) across ' +
        Object.keys(exp.accounts).length +
        ' account(s)',
    ),
  );
  if (t.droppedMembers)
    print(
      style.warn('⚠ ') +
        t.droppedMembers +
        ' invalid member(s) were ignored — the file may be hand-edited: ' +
        _threads.fileFor(ctx, t.slug),
    );
  print('');
  if (!exp.rows.length) {
    print(style.dim('This thread has no members yet.'));
    print(
      '  ' +
        style.bold('keyflip threads add ' + t.slug + ' <session-id>') +
        style.dim('   (ids: keyflip sessions --here)'),
    );
    return;
  }
  printThreadMembers(exp);
  if (!tl) {
    print('');
    print(
      style.dim('One merged, chronological view: ') +
        style.bold('keyflip threads show ' + t.slug + ' --timeline') +
        style.dim('   ·   continue: ') +
        style.bold('keyflip threads open ' + t.slug),
    );
    return;
  }
  print('');
  print(
    style.bold('Timeline') +
      style.dim(
        ' (' +
          tl.messages.length +
          ' turn(s)' +
          (tl.droppedFromStart ? ', oldest ' + tl.droppedFromStart + ' dropped' : '') +
          ')',
      ),
  );
  if (tl.cappedMembers)
    print(
      style.warn('⚠ ') +
        tl.cappedMembers +
        ' transcript(s) hit the read cap — raise it: keyflip config set threads.mergeMaxMiB <1-512>',
    );
  if (tl.unavailable.length)
    print(style.dim('ℹ ' + tl.unavailable.length + ' member(s) contribute no turns (see the warning above each).'));
  let lastFrom = null;
  tl.messages.forEach(function (m) {
    const key = m.from.kind + ':' + m.from.id;
    if (key !== lastFrom) {
      print('');
      print(
        style.dim(
          '↪ ' +
            (m.from.account ? m.from.account + ' · ' : '') +
            m.from.kind +
            ' ' +
            m.from.id.slice(0, 8) +
            ' — ' +
            (m.from.label || ''),
        ),
      );
      lastFrom = key;
    }
    print(
      '  ' +
        style.dim(
          String(m.ts || '')
            .slice(0, 16)
            .replace('T', ' '),
        ) +
        ' ' +
        (m.role === 'assistant' ? style.dim('▸ ') : style.bold('▪ ')) +
        String(m.text || '(tool use)')
          .replace(/\s+/g, ' ')
          .slice(0, 160),
    );
  });
  if (!tl.messages.length) print('  ' + style.dim('no local turns in this thread yet'));
  print('');
  print(style.dim('Full document: ') + style.bold('keyflip threads show ' + t.slug + ' --md'));
}

async function threadsOpen(ctx, rest) {
  const pos = positionals(rest, THREADS_VALUE_FLAGS);
  const t = threadAt(ctx, pos[0]);
  if (!t) return;
  const exp = threadMembersOf(ctx, t, {});
  const next = _threads.newest(exp.rows);
  if (!next) {
    return fail(
      'nothing in "' +
        t.slug +
        '" is resumable on this machine (' +
        exp.rows.length +
        ' member(s): ' +
        (exp.rows
          .map(function (r) {
            return r.kind + ':' + r.id.slice(0, 8);
          })
          .join(', ') || 'none') +
        ') — see keyflip threads show ' +
        t.slug,
    );
  }
  if (JSON_MODE) {
    jsonOut(
      threadJsonForAgent(ctx, {
        thread: t.slug,
        sessionId: next.id,
        account: next.account || null,
        cwd: next.cwd,
        mtime: next.mtime,
        command: 'cd ' + (next.cwd || '.') + ' && ' + next.resume.command + ' ' + next.resume.args.join(' '),
      }),
    );
    return;
  }
  const others = exp.rows.filter(function (r) {
    return r.kind === 'session' && r.resolved && r.id !== next.id;
  });
  print('Continuing ' + style.bold(t.slug) + ' at its last write:');
  print(
    '  ' +
      style.bold(next.id.slice(0, 8)) +
      '  ' +
      (next.account ? style.bold(next.account) : style.dim('unassigned')) +
      '  ' +
      style.dim(threadStamp(next.mtime)),
  );
  if (next.label) print('  ' + style.dim('“' + String(next.label).slice(0, 90) + '”'));
  print('  ' + style.dim('cd ') + (next.cwd || '.'));
  print('  ' + style.bold(next.resume.command + ' ' + next.resume.args.join(' ')));
  if (next.account)
    print(
      style.dim('  ↳ or let keyflip run it isolated as that account (your active profile stays put): ') +
        style.bold('keyflip resume ' + next.id.slice(0, 8) + ' --run'),
    );
  if (others.length)
    print(
      style.dim(
        '  ℹ ' +
          others.length +
          ' earlier session(s) in this thread: ' +
          others
            .slice(0, 4)
            .map(function (r) {
              return r.id.slice(0, 8) + (r.account ? '@' + r.account : '');
            })
            .join(', '),
      ),
    );
  if (rest.indexOf('--run') !== -1) {
    const sub = [next.id, '--run'];
    if (next.account) sub.push('--as', next.account);
    if (rest.indexOf('-y') !== -1 || rest.indexOf('--yes') !== -1 || rest.indexOf('--force') !== -1) sub.push('-y');
    return cmdResume(ctx, sub);
  }
  print(style.dim('(add --run to launch it now)'));
}

function threadsWhere(ctx, rest) {
  const pos = positionals(rest, THREADS_VALUE_FLAGS);
  const id = pos[0];
  if (!id) return fail('usage: keyflip threads where <session-id|chat-uuid|prefix>');
  const hits = _threads.threadsFor(ctx, null, id);
  const idx = _threads.index(ctx);
  const loc = _threads.locate(ctx, id, idx);
  const assigned = _threads.assignments(ctx);
  if (JSON_MODE) {
    jsonOut(
      threadJsonForAgent(ctx, {
        id: id,
        threads: hits.map(function (r) {
          return { slug: r.slug, title: r.title, updatedAt: r.updatedAt };
        }),
        transcriptOnDisk: loc ? loc.file : null,
        assignedTo: assigned.get(id) || null,
      }),
    );
    return;
  }
  if (!hits.length) {
    print('No thread contains ' + style.bold(id.slice(0, 8)) + '.');
    print(
      loc
        ? style.dim('The transcript is here (' + loc.file + ') and is ') +
            (assigned.get(id) ? style.bold('assigned to ' + assigned.get(id)) : style.dim('not assigned to an account'))
        : style.dim('No local transcript matches that id either.'),
    );
    print(style.dim('Put it in one: ') + style.bold('keyflip threads create <slug> --session ' + id));
    return;
  }
  hits.forEach(function (r) {
    print(
      '  ' +
        style.bold(r.slug) +
        (r.title && r.title !== r.slug ? ' — ' + r.title : '') +
        style.dim('  updated ' + threadStamp(r.updatedAt)),
    );
  });
  print('');
  print(
    style.dim(
      hits.length +
        ' thread(s) name ' +
        id.slice(0, 8) +
        (loc ? '; transcript: ' + loc.file : '; no local transcript') +
        (assigned.get(id) ? '; account: ' + assigned.get(id) : ''),
    ),
  );
}

function threadsSuggest(ctx, rest) {
  const limit = parseInt(flagVal(rest, '--limit'), 10);
  let rows = [];
  try {
    rows = _threads.candidates(ctx, Number.isNaN(limit) ? {} : { limit: limit });
  } catch (e) {
    return fail(e.message);
  }
  if (JSON_MODE) {
    jsonOut(threadJsonForAgent(ctx, { candidates: rows }));
    return;
  }
  if (!rows.length) {
    print(style.ok('✓') + ' nothing looks fragmented.');
    print(
      style.dim(
        'Checked the newest ' +
          (limit || 400) +
          ' session(s): no project folder holds transcripts assigned to two or more different accounts.',
      ),
    );
    print(
      style.dim(
        'If the split is on purpose (different projects, same account) this stays empty — an unassigned session is not a switch. Assign first: keyflip sessions assign <id> <account>   ·   or let keyflip guess: keyflip sessions attribute --apply',
      ),
    );
    return;
  }
  print(
    style.warn('⚠') +
      ' ' +
      rows.length +
      ' project folder(s) have work spread over 2+ accounts and no thread covering it yet:\n',
  );
  rows.forEach(function (r) {
    print('  ' + style.bold(r.cwd || r.project));
    print(
      '    ' +
        style.dim(
          r.sessions +
            ' session(s) by ' +
            r.accounts.join(' + ') +
            ' · ' +
            r.unthreaded +
            ' not yet in a thread · last ' +
            threadStamp(r.newest.mtime),
        ),
    );
    print(
      '    ' +
        style.dim('name it: ') +
        style.bold(
          'keyflip threads create ' + (r.suggestedSlug || 'work') + ' --session ' + r.newest.sessionId.slice(0, 8),
        ),
    );
    r.open
      .slice(1, 5)
      .map(function (s) {
        return 'keyflip threads add ' + (r.suggestedSlug || 'work') + ' ' + s.sessionId.slice(0, 8);
      })
      .forEach(function (c) {
        print('      ' + style.dim('then: ') + style.bold(c));
      });
    print('');
  });
  print(style.dim('Widen the scan with --limit <n> (it reads the session index, not your transcripts).'));
}

function threadsMirror(ctx, rest) {
  const pos = positionals(rest, THREADS_VALUE_FLAGS);
  const t = threadAt(ctx, pos[0]);
  if (!t) return;
  const opts = { force: rest.indexOf('--force') !== -1 };
  if (rest.indexOf('--max-mib') !== -1) {
    const n = parseInt(flagVal(rest, '--max-mib'), 10);
    if (!Number.isNaN(n) && n > 0) opts.maxBytes = Math.min(512, n) * 1024 * 1024;
  }
  const r = _threads.mirror(ctx, t, opts);
  if (JSON_MODE) {
    jsonOut(threadJsonForAgent(ctx, { mirror: r }));
    if (!r.ok) return;
  }
  if (!r.ok) {
    if (r.reason === 'disabled') {
      print(
        style.warn('⚠ ') +
          'the mirror is OFF — ' +
          r.detail +
          '\n  keyflip only stores pointers unless you allow text on disk: ' +
          style.bold(r.fix),
      );
      return;
    }
    print(
      style.warn('⚠ ') +
        r.detail +
        '\n  The merged text would land in a state repo that can reach a remote. ' +
        r.fix +
        (opts.force ? '' : '\n  Re-run with ' + style.bold('--force') + ' once you are sure nothing pushes it.'),
    );
    return;
  }
  print(
    style.ok('✅') +
      ' mirrored ' +
      style.bold(t.slug) +
      ' → ' +
      r.path +
      style.dim(' (' + fmtBytes(r.bytes) + ', ' + r.mode + ')'),
  );
  if (r.forced) print(style.warn('⚠ ') + 'written despite a configured git remote (--force).');
  print(style.dim('Remove the text again: ') + style.bold('keyflip threads unmirror ' + t.slug));
}

function threadsUnmirror(ctx, rest) {
  const pos = positionals(rest, THREADS_VALUE_FLAGS);
  const t = threadAt(ctx, pos[0]);
  if (!t) return;
  const r = _threads.unmirror(ctx, t);
  if (!r.ok) return fail('could not remove ' + r.path + ': ' + r.error);
  if (JSON_MODE) {
    jsonOut(threadJsonForAgent(ctx, { unmirrored: r }));
    return;
  }
  print(
    r.existed
      ? style.ok('✅') +
          ' removed the mirrored text for ' +
          style.bold(t.slug) +
          ' (' +
          r.path +
          '). The thread itself is unchanged.'
      : 'Nothing was mirrored for ' + style.bold(t.slug) + ' — no text on disk to remove.',
  );
}

async function threadsDrop(ctx, rest) {
  const pos = positionals(rest, THREADS_VALUE_FLAGS);
  const t = threadAt(ctx, pos[0]);
  if (!t) return;
  const autoYes = rest.indexOf('-y') !== -1 || rest.indexOf('--yes') !== -1 || rest.indexOf('--force') !== -1;
  if (!autoYes) {
    if (!process.stdin.isTTY)
      return fail(
        'dropping a thread needs confirmation — re-run with -y (it only forgets the NAME, never a conversation).',
      );
    print(
      'Forget the name ' +
        style.bold(t.slug) +
        style.dim(' (' + t.members.length + ' pointer(s))? No transcript, chat or account assignment is touched.'),
    );
    if (!(await confirm('Continue? [y/N] '))) {
      print('Cancelled.');
      return;
    }
  }
  const r = _threads.drop(ctx, t.slug);
  const mirrorFile = _threads.mirrorFileFor(ctx, t.slug);
  const mirrored = fs.existsSync(mirrorFile);
  print(style.ok('✅') + ' dropped thread ' + style.bold(t.slug) + ' — ' + r.members.length + ' pointer(s) forgotten.');
  if (mirrored)
    print(
      style.warn('⚠ ') +
        'its MIRRORED TEXT is still on disk at ' +
        mirrorFile +
        '\n  removing the name does not remove the conversation: ' +
        style.bold('keyflip threads unmirror ' + t.slug) +
        ' (or delete the file)',
    );
  print(style.dim('Undo through git: keyflip history | keyflip undo'));
  jsonOut({ dropped: { slug: t.slug, members: r.members.length, mirrorLeft: mirrored } });
}

async function cmdThreads(ctx, rest) {
  const sub = rest[0] && rest[0][0] !== '-' ? rest[0] : 'list';
  const args = rest[0] && rest[0][0] !== '-' ? rest.slice(1) : rest;
  switch (sub) {
    case 'list':
      return threadsList(ctx);
    case 'create':
      return threadsCreate(ctx, args);
    case 'add':
      return threadsAdd(ctx, args);
    case 'remove':
    case 'rm':
      return threadsRemove(ctx, args);
    case 'show':
    case 'get':
      return threadsShow(ctx, args);
    case 'open':
    case 'continue':
      return threadsOpen(ctx, args);
    case 'where':
      return threadsWhere(ctx, args);
    case 'suggest':
      return threadsSuggest(ctx, args);
    case 'mirror':
      return threadsMirror(ctx, args);
    case 'unmirror':
      return threadsUnmirror(ctx, args);
    case 'drop':
    case 'delete':
      return threadsDrop(ctx, args);
    default:
      return fail("unknown threads subcommand '" + rest[0] + "'. " + THREADS_USAGE);
  }
}

// E4: inject a message into a session non-interactively and print the reply —
// `claude -p "<message>" --resume <id>` in its project dir. Optionally AS another account
// (--as, or an assignment) and/or --fork (branch instead of appending). This is how you
// steer/continue a chat from another machine (keyflip carries the session; send drives it).
async function cmdSend(ctx, rest) {
  const sessionmap = _sessionmap;
  // Exclude the values of value-taking flags (--as/--message/-m) from positionals, else
  // e.g. `send <id> "hi" --as bob` would fold "bob" into the message body sent to Claude.
  const pos = positionals(rest, ['--as', '--message', '-m']);
  const id = pos[0];
  const mi = rest.indexOf('--message');
  const mm = rest.indexOf('-m');
  const message = mi !== -1 ? rest[mi + 1] : mm !== -1 ? rest[mm + 1] : pos.slice(1).join(' ');
  if (!id || !message) return fail('usage: keyflip send <id> "<message>" [--as <account>] [--fork]');
  let row;
  try {
    row = sessions.find(ctx, id);
  } catch (e) {
    return fail(e.message);
  }
  if (!row) return fail("no session matches '" + id + "'.");
  if (!_llm.available()) return fail('send needs Claude Code on PATH (`claude -p --resume`).');
  const sc = sessions.sendCommand(row, message, { fork: rest.indexOf('--fork') !== -1 });
  const cwd = row.cwd && fs.existsSync(row.cwd) ? row.cwd : process.cwd();

  // Which account to send as: explicit --as, else the session's assignment (A2), else current.
  const asI = rest.indexOf('--as');
  const asName = asI !== -1 ? rest[asI + 1] : sessionmap.get(ctx, row.sessionId);
  let env = process.env,
    em = null,
    resolved = null;
  if (asName) {
    resolved = core.resolveProfile(ctx, asName);
    if (!resolved) return fail("no such account: '" + asName + "'");
    em = profiles.email(ctx.configDir, resolved) || resolved;

    let dir;
    await withLock(ctx, function () {
      dir = session.prepareSession(ctx, resolved, { share: true, shareHistory: true });
    });
    env = session.sessionEnv(ctx, dir).env;
  }
  if (JSON_MODE) {
    jsonOut({
      send: { session: row.sessionId, as: resolved || null, cwd: cwd, command: sc.command + ' ' + sc.args.join(' ') },
    });
    return;
  }
  print(
    'Sending to ' +
      style.bold(row.sessionId.slice(0, 8)) +
      (em ? ' as ' + em : '') +
      (rest.indexOf('--fork') !== -1 ? ' ' + style.dim('(forked)') : '') +
      ' via ' +
      style.bold('claude -p') +
      ' ' +
      style.dim('(spends quota)') +
      '…\n',
  );
  const bin = process.env.KEYFLIP_CLAUDE_BIN || 'claude';
  const r = _child_process.spawnSync(bin, sc.args, { stdio: 'inherit', cwd: cwd, env: env });
  if (resolved)
    await withLock(ctx, function () {
      try {
        session.syncBack(ctx, resolved);
      } catch (e) {
        /* best-effort */
      }
    });
  process.exitCode = typeof r.status === 'number' ? r.status : 1;
}

async function cmdResume(ctx, rest) {
  const sessionmap = _sessionmap;
  // positionals() knows --as takes a value, so `resume --as bob 5` resolves to `5`, not `bob`.
  const arg = positionals(rest, ['--as'])[0];
  if (!arg) return fail('usage: keyflip resume <number|session-id> [--run] [--as <account>]');
  let row;
  if (/^[0-9]{1,3}$/.test(arg)) {
    row = sessions.list(ctx, { limit: 200 })[parseInt(arg, 10) - 1];
  } else {
    try {
      row = sessions.find(ctx, arg);
    } catch (e) {
      return fail(e.message);
    }
  }
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
    const cwd = rc.cwd && fs.existsSync(rc.cwd) ? rc.cwd : process.cwd();
    if (JSON_MODE) {
      jsonOut({ sessionId: row.sessionId, as: name, cwd: cwd, command: rc.command + ' ' + rc.args.join(' ') });
      return;
    }
    const autoYes = rest.indexOf('-y') !== -1 || rest.indexOf('--yes') !== -1 || rest.indexOf('--force') !== -1;
    if (!autoYes) {
      if (!process.stdin.isTTY) return fail('resuming as ' + em + ' launches a PARALLEL session — re-run with -y.');
      print(
        'Resume ' +
          row.sessionId.slice(0, 8) +
          ' as ' +
          style.bold(em) +
          ' — parallel (this terminal only); your active account stays unchanged.',
      );
      if (!(await confirm('Continue? [y/N] '))) {
        print('Cancelled.');
        return;
      }
    }

    let dir;
    await withLock(ctx, function () {
      dir = session.prepareSession(ctx, name, { share: true, shareHistory: true });
    });
    const se = session.sessionEnv(ctx, dir);
    print('Resuming as ' + em + ' (this terminal only)…');
    const bin = process.env.KEYFLIP_CLAUDE_BIN || 'claude';
    const r = _child_process.spawnSync(bin, rc.args, { stdio: 'inherit', cwd: cwd, env: se.env });
    await withLock(ctx, function () {
      try {
        session.syncBack(ctx, name);
      } catch (e) {
        /* best-effort */
      }
    });
    process.exitCode = typeof r.status === 'number' ? r.status : 1;
    return;
  }

  if (JSON_MODE) {
    jsonOut({
      sessionId: row.sessionId,
      cwd: rc.cwd,
      command: rc.command + ' ' + rc.args.join(' '),
      assignedTo: assigned || null,
    });
    return;
  }
  if (wantRun) {
    if (rc.cwd && !fs.existsSync(rc.cwd))
      print(style.warn('⚠️  original directory is gone: ' + rc.cwd + ' — launching in the current directory.'));
    const cwd = rc.cwd && fs.existsSync(rc.cwd) ? rc.cwd : process.cwd();
    const bin = process.env.KEYFLIP_CLAUDE_BIN || 'claude';
    const r = _child_process.spawnSync(bin, rc.args, { stdio: 'inherit', cwd: cwd });
    process.exitCode = typeof r.status === 'number' ? r.status : 1;
    return;
  }
  print('Resume this session with:');
  print('  cd ' + (rc.cwd || '<dir>') + ' && ' + rc.command + ' ' + rc.args.join(' '));
  if (assigned)
    print(
      '  ↳ assigned to ' +
        (profiles.email(ctx.configDir, assigned) || assigned) +
        ' — ' +
        style.bold('keyflip resume ' + row.sessionId.slice(0, 8) + ' --run') +
        ' launches it as that account (no profile switch).',
    );
  else print('(or re-run with --run to launch it now; --as <account> to run it under another account)');
}

// #6 backup
function cmdBackup(ctx, rest) {
  const sub = rest[0] || 'now';
  if (sub === 'now' || sub === 'create') {
    const r = backup.create(ctx);
    print(
      style.ok('✅') + ' backup ' + r.name + '  (' + r.files + ' files, ' + Math.round(r.sizeBytes / 1024) + ' KB)',
    );
    jsonOut({ created: r.name, files: r.files });
    return;
  }
  if (sub === 'list') {
    const all = backup.list(ctx);
    if (JSON_MODE) {
      jsonOut({ backups: all });
      return;
    }
    if (!all.length) {
      print('No backups yet — make one: keyflip backup now');
      return;
    }
    all.forEach(function (b, i) {
      print('  [' + (i + 1) + '] ' + b.name + '   ' + Math.round(b.sizeBytes / 1024) + ' KB   ' + (b.mtime || ''));
    });
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
    const keep = rest[1] ? parseInt(rest[1], 10) || backup.DEFAULT_KEEP : backup.DEFAULT_KEEP;
    const removed = backup.prune(ctx, keep);
    print('pruned ' + removed + ' old backup(s), kept ' + keep + '.');
    return;
  }
  return fail('usage: keyflip backup [now|list|restore <n>|prune [keep]]');
}

// #11 keyflip:// share URL
function cmdShare(ctx, rest) {
  const resource = provider.exists(ctx, rest[0])
    ? 'provider'
    : profiles.read(ctx.configDir, rest[0])
      ? 'account'
      : null;
  const name = rest[0];
  if (!name || !resource) return fail('usage: keyflip share <provider-or-account> [--no-secrets]');
  const url = share.build(ctx, resource, name, { noSecrets: rest.indexOf('--no-secrets') !== -1 });
  if (JSON_MODE) {
    jsonOut({ url: url, resource: resource });
    return;
  }
  if (resource === 'provider' && rest.indexOf('--no-secrets') === -1) {
    print(style.warn('⚠️  This link may carry the API key — treat it as a secret.'));
  }
  print(url);
}

// #44 — `keyflip secrets [list|tolerate|untolerate]`: manage what the history scan FINDS.
//
// The scan (#41) reports every secret-shaped object in the state repo's git history, and `doctor` marks
// that `✗` + "rotate the credential". Some of those findings are decisions, not accidents: a free-tier
// Google AI key sitting in the provider file it was written to is real, known, and not worth an alarm
// every time the user runs a diagnostic. `secrets tolerate` says so ONCE, in a versioned policy file,
// and three things follow: the finding stops being an alarm, the rotation advice stops being repeated,
// and — this is the part that is NOT an exemption — the path stays in `keyflip scrub-history`'s plan,
// because "unimportant" never means "fine to leave readable in an old commit".
//
// A rule names a PATH and/or a secret KIND, never a value. It cannot match on a value even by accident:
// that would put a fingerprint of a secret into the git-versioned state repo, the rule `chains` already
// holds. That is also why the note is redacted before it is stored.
async function cmdSecrets(ctx, rest) {
  const leakscan = _leakscan;
  const pol = _secretpolicy;
  const positional = [];
  const kinds = []; // --kind is repeatable: `--kind google-api-key --kind jwt`
  let note = null;
  let pathFlag = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--kind' || a === '--note' || a === '--path') {
      const v = rest[i + 1];
      if (v == null || v.charAt(0) === '-') continue; // a flag with no value is the flag being wrong, not a value
      i++;
      if (a === '--kind') kinds.push(v);
      else if (a === '--note') note = v;
      else pathFlag = v;
      continue;
    }
    if (a.charAt(0) === '-') continue;
    positional.push(a);
  }
  const verb = positional[0] || 'list';
  const wantRepo = function () {
    return _vcs.isRepo(ctx);
  };

  if (verb === 'tolerate' || verb === 'untolerate') {
    // `tolerate <path>`, `tolerate --path <path>`, or `--kind <kind>` alone (a kind that is ALWAYS fine,
    // anywhere) which becomes the explicit any-path rule.
    const target = pathFlag || positional[1] || (kinds.length && verb === 'tolerate' ? '*' : null);
    if (!target)
      return fail(
        'which path? ' +
          (verb === 'tolerate'
            ? 'keyflip secrets tolerate <path> [--kind <secret-kind>] — run keyflip secrets list to see them, or pass --kind alone for a kind that is always fine.'
            : 'keyflip secrets untolerate <path> — run keyflip secrets list to see the rules.'),
      );
    let action = null;
    if (verb === 'tolerate') {
      const r = pol.addRule(ctx, { path: target, kinds: kinds, note: note, now: ctx.now });
      if (!r.ok) return fail(r.reason);
      action = r.rule;
      print(
        style.ok('✅') +
          ' tolerated ' +
          style.bold(r.rule.path) +
          (r.rule.kinds.length
            ? style.dim(' (kind: ' + r.rule.kinds.join(', ') + ')')
            : style.dim(' (any kind on that path)')),
      );
      if (r.replaced) print(style.dim('  replaced the identical rule that was already there.'));
      if (r.noteRedacted)
        print(
          style.warn('⚠ ') +
            'the note was redacted before storing (' +
            r.noteRedacted +
            ' value(s)) — the policy file is git-versioned and never holds a secret.',
        );
    } else {
      const r = pol.removeRule(ctx, { path: target, kinds: kinds });
      if (!r.ok) return fail(r.reason);
      if (!r.removed.length) {
        print(style.dim('No rule on ') + style.bold(target) + ' — ' + r.reason + '.');
        jsonOut({ secrets: { action: verb, path: target, removed: [], rules: r.kept } });
        return;
      }
      action = { removed: r.removed };
      print(
        style.ok('✅') +
          ' removed ' +
          r.removed.length +
          ' rule(s) — ' +
          r.removed
            .map(function (x) {
              return x.path;
            })
            .join(', ') +
          ' — those findings are alarms again.',
      );
    }
    // The feedback that makes this trustworthy: what the change did to THIS scan, right now, before the
    // user has to run anything to find out. Read-only.
    const hist = wantRepo() ? leakscan.historyLeaks(ctx) : null;
    const cls = hist && hist.ok ? pol.classify(ctx, hist.leaks) : null;
    if (cls) {
      print(
        '  now silencing ' +
          style.bold(String(cls.tolerated.length)) +
          ' finding(s) over ' +
          pathsOf(cls.tolerated).length +
          ' path(s); ' +
          style.bold(String(cls.alarms.length)) +
          ' still an alarm.',
      );
      if (cls.broad.length)
        print(
          style.warn('⚠ ') +
            cls.broad.length +
            " broad rule(s) (a * or a trailing /), so they also cover anything NEW at that path — keyflip secrets list shows each one's reach.",
        );
      print(
        style.dim(
          '  keyflip scrub-history still removes every one of them — a toleration is an end to the ALARM, not an exemption from cleaning.',
        ),
      );
    }
    print(style.dim('  policy: ' + pol.FILE_NAME + ' in the state dir (versioned, value-free) · undo: keyflip undo'));
    jsonOut({
      secrets: {
        action: verb,
        rule: action,
        silenced: cls ? cls.tolerated.length : 0,
        silenced_paths: cls ? pathsOf(cls.tolerated) : [],
        alarms: cls ? cls.alarms.length : 0,
        still_scrubbed: cls ? pathsOf(cls.findings) : [],
      },
    });
    return;
  }

  // ---- list (default) ----
  const only = rest.indexOf('--alarms') !== -1;
  const policy = pol.load(ctx);
  const hist = wantRepo() ? leakscan.historyLeaks(ctx) : null;
  const cls = hist && hist.ok ? pol.classify(ctx, hist.leaks, { policy: policy }) : null;
  if (JSON_MODE) {
    jsonOut({
      secrets: {
        policy: {
          file: pol.FILE_NAME,
          exists: policy.exists,
          rules: policy.rules,
          dropped: policy.dropped,
          error: policy.error,
        },
        repo: wantRepo() ? undefined : 'no git repo in the state dir',
        history: hist ? historyJson(hist, cls) : null,
        alarms: cls ? cls.alarms.length : null,
        tolerated: cls ? cls.tolerated.length : null,
        keepsakes: keepsakeSummary(ctx),
      },
    });
    return;
  }
  print(
    style.bold('keyflip secrets') +
      ' — what the history scan found, and what keyflip has been told to expect' +
      style.dim('  (' + ctx.configDir + ')'),
  );
  if (hist === null)
    print(
      style.warn('⚠ ') +
        'the state dir is not a git repo — there is no history to judge. keyflip versioning on, then keyflip doctor --history.',
    );
  else if (!hist.ok) print(style.err('✗') + ' the history could not be read (' + hist.reason + ').');
  else {
    print(
      '  ' +
        style.dim(
          hist.scanned +
            ' blob(s) scanned' +
            (hist.skipped ? ', ' + hist.skipped + ' skipped as too large' : '') +
            (hist.truncated ? ' [capped — more objects exist]' : ''),
        ),
    );
    if (!hist.leaks.length)
      print(style.ok('✅') + ' no secret-shaped object and no secret-path capture is reachable in the history.');
    else {
      const rows = cls.findings.filter(function (f) {
        return !only || !f.tolerated;
      });
      rows.forEach(function (f) {
        print(
          '  ' +
            (f.tolerated ? style.dim('•') : style.err('✗')) +
            ' ' +
            (f.tolerated ? style.dim(f.file) : f.file) +
            style.dim(
              '  ·  ' +
                f.labels.join(', ') +
                (f.confidence === 'low' ? ' [weak match]' : '') +
                '  ·  ' +
                fmtBytes(f.bytes) +
                '  ·  ' +
                f.commits +
                ' commit(s)  ·  ' +
                (f.trackedNow ? 'still tracked' : 'history only'),
            ),
        );
        if (f.tolerated)
          print(
            '      ' +
              style.dim(
                '↳ tolerated by rule ' +
                  f.by +
                  (f.byNote ? ' — ' + f.byNote : '') +
                  '   (still scrubbed from history by keyflip scrub-history)',
              ),
          );
        else
          print(
            '      ' +
              style.dim(
                '↳ keyflip secrets tolerate ' +
                  JSON.stringify(f.file) +
                  (f.labels.length === 1 && f.labels[0] !== pol.PATH_ONLY_LABEL ? ' --kind ' + f.labels[0] : '') +
                  '   (if this one is expected)',
              ),
          );
      });
      print(
        '  ' +
          (cls.alarms.length ? style.err('✗ ') : style.ok('✓ ')) +
          cls.alarms.length +
          ' alarm(s), ' +
          style.dim(cls.tolerated.length + ' tolerated') +
          (only && cls.tolerated.length ? style.dim(' (' + cls.tolerated.length + ' hidden by --alarms)') : '') +
          ' — every one of them is still removed by keyflip scrub-history.',
      );
    }
  }
  print('');
  print(
    style.bold('policy') +
      (policy.exists ? style.dim('  (' + pol.FILE_NAME + ', versioned)') : style.dim('  (none yet)')),
  );
  if (policy.error)
    print(
      style.err('✗') +
        ' ' +
        pol.FILE_NAME +
        ' ' +
        policy.error +
        ' — keyflip applied NO rule, so the alarms above are complete.',
    );
  if (policy.dropped)
    print(
      style.warn('⚠ ') +
        policy.dropped +
        ' rule(s) in the file were not usable and were NOT applied — a rule needs a repo-relative path and known KIND(s).',
    );
  if (!policy.rules.length && !policy.error)
    print(style.dim('  no rule — every finding is an alarm. keyflip secrets tolerate <path> [--kind <kind>]'));
  else {
    const allLeaks = cls ? cls.findings : [];
    policy.rules.forEach(function (r) {
      const cov = pol.coverageOf(ctx, allLeaks, r);
      print(
        '  • ' +
          style.bold(r.path) +
          (r.kinds.length ? style.dim(' [' + r.kinds.join(', ') + ']') : style.dim(' [any kind]')) +
          style.dim(
            '  ·  ' +
              cov.findings +
              ' finding(s) over ' +
              cov.paths.length +
              ' path(s)' +
              (r.note ? '  ·  ' + r.note : ''),
          ),
      );
      if (r.path === '*' || r.path.indexOf('*') !== -1 || r.path.slice(-1) === '/')
        print(
          style.dim(
            '      ↳ a broad rule: it also covers anything NEW at that path. ' +
              (cov.paths.length > 1 ? 'Currently ' + cov.paths.join(', ') + '.' : 'That is fine while you mean it.'),
          ),
        );
    });
  }
  // Kept OUT of the policy on purpose, so say so rather than let the user think it is silenced.
  const keeps = keepsakeSummary(ctx);
  if (keeps.leaks)
    print(
      '\n  ' +
        style.warn('⚠ ') +
        keeps.leaks +
        ' keepsake(s) hold a secret shape. ' +
        style.bold('A policy never silences a keepsake') +
        " — that text is keyflip's own writing, it travels through recall/migrate/sync, and the fix is " +
        style.bold('keyflip memory audit --apply') +
        '.',
    );
}

function pathsOf(findings) {
  const out = [];
  findings.forEach(function (f) {
    if (out.indexOf(f.file) === -1) out.push(f.file);
  });
  return out;
}
// Counts only. A keepsake leak is reported next to the history findings so the user sees the whole
// picture in one command — and sees that `secrets tolerate` deliberately does not reach it.
function keepsakeSummary(ctx) {
  try {
    const a = _leakscan.keepsakeAudit(ctx, _memory);
    return { leaks: a.leaks.length, audited: a.audited };
  } catch (e) {
    return { leaks: 0, audited: 0 };
  }
}

// #13 diagnostics
// #41 — `keyflip scrub-history [--apply]`: remove secret-bearing paths from keyflip's OWN state-repo
// history. Untracking a file is not the same as removing it: every old commit still resolves the blob.
// DRY RUN by default; --apply refuses outright unless git-filter-repo exists (a hand-rolled rewrite
// can corrupt the repo) and always bundles the current history first.
async function cmdScrubHistory(ctx, rest) {
  const leakscan = _leakscan;
  const vcsmod = _vcs;
  if (!vcsmod.isRepo(ctx))
    return fail(
      'the state dir is not a git repo (' +
        ctx.configDir +
        ') — nothing versioned to scrub. Enable it with: keyflip versioning on',
    );
  const apply = rest.indexOf('--apply') !== -1;
  const yes = rest.indexOf('-y') !== -1 || rest.indexOf('--force') !== -1;
  // A leaked path that is STILL tracked is live state — scrubbing it deletes the working file too.
  // Opt-in only, so the default plan can never cost the user a file they are still using.
  const includeTracked = rest.indexOf('--include-tracked') !== -1;
  const mi = rest.indexOf('--max-blobs');
  const scanOpts = mi !== -1 ? { maxBlobs: parseInt(rest[mi + 1], 10) || undefined } : {};
  print(style.bold('keyflip scrub-history') + ' — ' + style.dim(ctx.configDir));
  const hist = leakscan.historyLeaks(ctx, scanOpts);
  if (!hist.ok) return fail('could not read the history (' + hist.reason + ').');
  // #44: the policy decides what is an ALARM in this report, never what is in the plan. A tolerated path
  // is scrubbed exactly like an alarming one — history cleanup is the thing toleration cannot opt out of.
  const pol = _secretpolicy.load(ctx);
  const cls = _secretpolicy.classify(ctx, hist.leaks, { policy: pol });
  print(
    '  scanned ' +
      style.bold(String(hist.scanned)) +
      ' blob(s)' +
      (hist.skipped ? ', skipped ' + hist.skipped + ' over the size cap' : '') +
      (hist.truncated ? ' ' + style.warn('[capped — more objects exist; raise --max-blobs]') : ''),
  );
  if (!hist.leaks.length) {
    print(style.ok('✅') + ' history is clean — no secret-shaped object and no secret-path capture is reachable.');
    jsonOut({ scrubHistory: { scanned: hist.scanned, leaks: [], plan: null, applied: false } });
    return;
  }
  const plan = leakscan.planScrub(ctx, hist.leaks, {
    now: ctx.now,
    includeTracked: includeTracked,
    policy: pol,
  });
  print(
    '  ' +
      (cls.alarms.length ? style.err('✗') : style.ok('✓')) +
      ' ' +
      hist.leaks.length +
      ' leaked object(s) across ' +
      (plan.paths.length + plan.skippedTracked.length) +
      ' path(s)' +
      (cls.tolerated.length ? style.dim(' — ' + cls.tolerated.length + ' tolerated, still scrubbed') : '') +
      ':',
  );
  cls.findings.forEach(function (l) {
    const tag = l.trackedNow ? 'still tracked' : 'history only';
    print(
      '    ' +
        (l.tolerated ? style.dim('•') : style.err('•')) +
        ' ' +
        (l.tolerated ? style.dim(l.file) : l.file) +
        style.dim(
          '  ·  ' +
            (l.kinds.length ? l.kinds.join(', ') : 'secret-path capture') +
            (l.confidence === 'low' ? ' [weak match]' : '') +
            '  ·  ' +
            fmtBytes(l.bytes) +
            '  ·  ' +
            l.commits +
            ' commit(s)  ·  ' +
            tag,
        ) +
        (l.tolerated ? style.dim('  ·  tolerated (' + l.by + ')') : ''),
    );
  });
  plan.warns.forEach(function (w) {
    print('  ' + style.warn('!') + ' ' + w);
  });
  if (plan.blockers.length) {
    plan.blockers.forEach(function (b) {
      print('  ' + style.err('✗') + ' ' + b);
    });
    jsonOut({
      scrubHistory: {
        scanned: hist.scanned,
        leaks: cls.findings,
        alarms: cls.alarms.length,
        tolerated: cls.tolerated.length,
        plan: plan,
        applied: false,
        blocked: true,
      },
    });
    return;
  }
  if (!apply) {
    print('\n' + style.dim('Dry run. --apply writes the bundle and rewrites history with git-filter-repo.'));
    jsonOut({
      scrubHistory: {
        scanned: hist.scanned,
        leaks: cls.findings,
        alarms: cls.alarms.length,
        tolerated: cls.tolerated.length,
        plan: plan,
        applied: false,
      },
    });
    return;
  }
  if (!yes && process.stdin.isTTY) {
    const ok = await confirm(
      'Rewrite ' +
        plan.paths.length +
        ' path(s) out of the state-repo history' +
        (plan.toleratedPaths.length
          ? ' (' + plan.toleratedPaths.length + ' tolerated by policy, still scrubbed)'
          : '') +
        '? [y/N] ',
    );
    if (!ok) {
      print('Cancelled — the history is untouched.');
      return;
    }
  } else if (!yes && !process.stdin.isTTY) {
    return fail('re-run with -y to confirm (this rewrites git history).');
  }
  const r = leakscan.applyScrub(ctx, hist.leaks, { now: ctx.now, includeTracked: includeTracked, policy: pol });
  if (!r.ok) return fail(r.reason + (r.restored ? ' — ' + r.restored : ''));
  print(
    style.ok('✅') +
      ' removed ' +
      r.removed.length +
      ' path(s) from history; backup bundle at ' +
      r.bundle +
      ' (0600).',
  );
  const after = leakscan.historyLeaks(ctx);
  const afterClass = after.ok ? _secretpolicy.classify(ctx, after.leaks, { policy: pol }) : null;
  print(
    after.ok && !after.leaks.length
      ? style.ok('✓') +
          ' re-scan is clean (' +
          after.scanned +
          ' blob(s)). Delete the bundle once you are sure you do not need it.'
      : style.warn('⚠') +
          ' re-scan still reports ' +
          after.leaks.length +
          ' object(s) — inspect before deleting the bundle.',
  );
  jsonOut({
    scrubHistory: {
      applied: true,
      removed: r.removed,
      removed_tolerated: plan.toleratedPaths,
      bundle: r.bundle,
      rescan: afterClass ? historyJson(after, afterClass) : historyJson(after),
    },
  });
}

// #39 — `keyflip chains [account] [--tighten [--apply]]`: what one account's login is actually MADE
// of, who can renew each piece, and where the chain therefore dies. Structural facts only: never
// reads a secret's content, never touches the Keychain, and writes nothing but a file mode under
// --tighten --apply. The value is the three failure modes that were otherwise invisible until a
// switch misbehaved: a capture is a copy of a store that kept MOVING; one browser profile / one app
// cookie jar can only ever hold ONE account; and a 644 cookie dump is readable by the whole machine.
async function cmdChains(ctx, rest) {
  const doTighten = rest.indexOf('--tighten') !== -1;
  const apply = rest.indexOf('--apply') !== -1;
  const only = rest.filter(function (a) {
    return a.length && a[0] !== '-';
  })[0];
  if (doTighten) {
    const t = _chains.tighten(ctx, { apply: apply });
    print(style.bold('keyflip chains --tighten') + ' — ' + style.dim(_chains.display(ctx, ctx.configDir)));
    if (!t.changed.length && !t.refused.length) {
      print(style.ok('✅') + ' no state-repo secret has a loose mode — nothing to do.');
      jsonOut({ chains: { tighten: t } });
      return;
    }
    t.changed.forEach(function (c) {
      print(
        '  ' +
          (apply ? style.ok('✓') : style.dim('•')) +
          ' ' +
          c.file +
          '  ' +
          c.from +
          ' → ' +
          c.to +
          (apply ? '' : style.dim('  (dry run)')),
      );
    });
    t.refused.forEach(function (r) {
      print('  ' + style.warn('!') + ' left alone: ' + r.file + ' — ' + r.reason);
    });
    if (!apply)
      print('\n' + style.dim('Dry run. --apply chmods these to 600 — nothing else, and never outside the state repo.'));
    else print(style.ok('✅') + ' tightened ' + t.changed.length + ' file(s); ' + t.remaining + ' still loose.');
    jsonOut({ chains: { tighten: t } });
    return;
  }

  // The scope belongs in the query, not in a post-hoc filter: chains(ctx, {account}) recomputes the
  // summary so a scoped report can never print whole-store counts it did not look at.
  const c = _chains.chains(ctx, only ? { account: only } : {});
  print(style.bold('keyflip chains') + ' — ' + style.dim(c.configDir));
  if (only && !c.accounts.length) print('  ' + style.warn('!') + ' no credentials are filed under "' + only + '"');
  const map = _chains.index(c.nodes);
  const nowMs = Date.parse(ctx.now()) || Date.now();
  const age = function (n) {
    if (!n.mtimeMs) return '';
    const days = Math.floor((nowMs - n.mtimeMs) / 86400000);
    return days <= 0 ? 'today' : days === 1 ? '1d' : days + 'd';
  };
  c.accounts.forEach(function (a) {
    print(
      '\n  ' +
        style.bold(a.account) +
        style.dim(
          '  ·  ' +
            a.present +
            ' held' +
            (a.missing ? ', ' + a.missing + ' not stored here' : '') +
            (a.unprobed ? ', ' + a.unprobed + ' in the Keychain (unprobed)' : '') +
            '  ·  renews with: ' +
            (a.renewableBy.join(' / ') || 'nothing') +
            '  ·  bottoms out at: ' +
            (a.roots.length ? a.roots.join(', ') : 'nothing traceable (a copy keyflip cannot interpret)'),
        ),
    );
    c.nodes
      .filter(function (n) {
        return n.account === a.account;
      })
      .forEach(function (n) {
        const state =
          n.exists === true
            ? [n.mode, fmtBytes(n.bytes), age(n)].filter(Boolean).join(' · ')
            : n.exists === null
              ? 'unprobed'
              : 'absent';
        const src = n.source && map[n.source] ? '← ' + n.source : '';
        print(
          '    • ' +
            (n.exists === true ? '' : n.exists === null ? style.dim('? ') : style.dim('– ')) +
            n.kind +
            '  ' +
            String(n.file) +
            style.dim('  ·  ' + state + (src ? '  ·  ' + src : '') + (n.secret ? '' : '  ·  not a credential')),
        );
      });
  });
  const shared = c.nodes.filter(function (n) {
    return n.account === null && n.secret && n.exists !== false && !n.synthetic;
  });
  if (shared.length) {
    print('\n  ' + style.dim('machine-wide stores (no single account owns these):'));
    shared.forEach(function (n) {
      print(
        '    • ' +
          n.kind +
          '  ' +
          String(n.file) +
          style.dim(
            '  ·  ' +
              (n.exists === null ? 'unprobed' : fmtBytes(n.bytes) + ' · ' + age(n)) +
              (n.note ? '  ·  ' + n.note : ''),
          ),
      );
    });
  }
  print('');
  if (!c.risks.length) {
    print(
      style.ok('✅') +
        ' every credential keyflip holds is filed under a known account, no older than its source, and private.',
    );
  } else {
    print(
      style.bold('  ' + c.risks.length + ' structural risk(s):') +
        ' ' +
        style.dim(c.summary.high + ' high, ' + c.summary.warn + ' advisory'),
    );
    c.risks.forEach(function (r) {
      print('    ' + (r.severity === 'high' ? style.err('✗') : style.warn('⚠')) + ' ' + r.kind + ': ' + r.detail);
      print('      ' + style.dim('↳ ' + r.fix));
    });
  }
  print(
    style.dim(
      '\n  Read-only: chains never opens a secret file (stats only) and never queries the Keychain, so a' +
        '\n  "keychain:" location is reported unprobed. Nothing here is written to the state repo.',
    ),
  );
  jsonOut({
    chains: {
      account: only || null,
      accounts: c.accounts,
      // Same reason as the MCP tool: this JSON gets pasted into agent chats and logged. The relative
      // path is the useful part; the absolute one maps the user's filesystem for no benefit.
      risks: c.risks.map(_chains.publicRisk),
      nodes: c.nodes.map(_chains.publicNode),
      summary: c.summary,
    },
  });
}

async function cmdDoctor(ctx, rest) {
  const r = await doctor.diagnose(ctx);
  // `--history` is opt-in because it walks every blob keyflip ever committed (a few seconds, read-only).
  const wantHistory = rest.indexOf('--history') !== -1;
  if (wantHistory && !JSON_MODE) print('  … scanning git history (' + ctx.configDir + ')');
  const hist = wantHistory ? _leakscan.historyLeaks(ctx) : null;
  // #44: the scan stays broad, the VERDICT is the policy's. A finding the user has ruled "expected here"
  // is reported and counted separately, so `doctor`'s headline can be honest ("no alarms") without the
  // scan ever getting narrower.
  const histClass = hist && hist.ok ? _secretpolicy.classify(ctx, hist.leaks) : null;
  if (JSON_MODE) {
    jsonOut({ ok: r.ok, checks: r.checks, history: hist ? historyJson(hist, histClass) : undefined });
    return;
  }
  print('keyflip doctor:');
  r.checks.forEach(function (c) {
    const mark =
      c.ok === false
        ? style.err('✗')
        : c.ok === 'warn'
          ? style.warn('⚠')
          : c.ok === true
            ? style.ok('✓')
            : style.dim('•');
    print('  ' + mark + ' ' + c.name + (c.detail ? '  — ' + c.detail : ''));
    if (c.fix && c.ok !== true) print('      ' + style.dim('↳ ' + c.fix));
  });
  const warns = r.checks.filter(function (c) {
    return c.ok === 'warn';
  }).length;
  if (hist) printHistoryLeaks(hist, histClass);
  print('');
  // A reachable secret outranks advisory noise: `--history` was asked for, so its ✗ is the headline.
  // Only an ALARM outranks it, though — a tolerated finding is the user's own recorded decision, and
  // re-alarming on it every run is precisely the noise that gets `doctor` skipped.
  const alarms = histClass ? histClass.alarms : hist ? hist.leaks : [];
  const tolerated = histClass ? histClass.tolerated : [];
  const historyOnly = alarms.filter(function (l) {
    return !l.trackedNow;
  }).length;
  print(
    !r.ok
      ? style.err('Some checks need attention (see ✗ above).')
      : alarms.length
        ? style.warn(
            alarms.length +
              ' secret-bearing object(s) still an ALARM in git history (' +
              historyOnly +
              ' of them untracked — safe to scrub)' +
              (tolerated.length ? ', ' + tolerated.length + ' more tolerated by policy' : '') +
              ' — keyflip scrub-history',
          )
        : warns
          ? style.warn(warns + ' advisory warning(s) (⚠).')
          : style.ok('All good.'),
  );
  if (histClass && tolerated.length && !alarms.length)
    print(
      style.dim(
        '  (' +
          tolerated.length +
          ' history finding(s) are tolerated by your policy and still get scrubbed by keyflip scrub-history — keyflip secrets list)',
      ),
    );
  if (histClass && histClass.policyError)
    print(style.err('✗') + ' ' + _secretpolicy.FILE_NAME + ': ' + histClass.policyError + ' — no rule was applied.');
}

// A history finding is reported as KIND + PATH, never content: the terminal, the log file and any
// agent reading this output must not become a copy of the secret they are being warned about.
// `cls` (a secretpolicy.classify() result) adds the toleration verdict — `tolerated` + which rule — so a
// machine reader can tell an alarm from a known-and-accepted finding without re-reading the policy.
function historyJson(hist, cls) {
  // classify() preserves leak order, so findings[i] IS leaks[i].
  return {
    ok: hist.ok,
    reason: hist.reason || null,
    scanned: hist.scanned,
    skipped: hist.skipped,
    truncated: !!hist.truncated,
    alarms: cls ? cls.alarms.length : hist.leaks.length,
    tolerated: cls ? cls.tolerated.length : 0,
    // A policy that could not be read applies nothing — the payload must say so, or a reader would
    // assume the small alarm count came from rules that did not load.
    policy_error: cls ? cls.policyError : null,
    rules_dropped: cls ? cls.dropped : 0,
    leaks: hist.leaks.map(function (l, i) {
      const f = cls && cls.findings[i] ? cls.findings[i] : null;
      return {
        file: l.file,
        blob: l.blob,
        bytes: l.bytes,
        kinds: l.kinds,
        secretPath: !!l.secretPath,
        confidence: l.confidence || 'high',
        trackedNow: !!l.trackedNow,
        commits: l.commits,
        tolerated: f ? !!f.tolerated : undefined,
        by: f && f.by ? f.by : undefined,
      };
    }),
  };
}

function printHistoryLeaks(hist, cls) {
  if (!hist.ok) {
    print('  ' + style.warn('⚠') + ' history scan  — could not run (' + hist.reason + ')');
    return;
  }
  const alarms = cls ? cls.alarms : hist.leaks;
  const tolerated = cls ? cls.tolerated.length : 0;
  print(
    '  ' +
      (alarms.length ? style.err('✗') : style.ok('✓')) +
      ' history scan  — ' +
      alarms.length +
      ' alarm(s)' +
      (tolerated ? style.dim(' (' + tolerated + ' tolerated by policy)') : '') +
      ' in ' +
      hist.scanned +
      ' blob(s) scanned' +
      (hist.skipped ? ' (' + hist.skipped + ' skipped as too large)' : '') +
      (hist.truncated ? ' [scan capped — more objects exist]' : ''),
  );
  const rows = cls ? cls.findings : hist.leaks.map((l) => Object.assign({}, l, { labels: l.kinds }));
  rows.slice(0, 12).forEach(function (l) {
    print(
      '      ' +
        (l.tolerated ? style.dim('·') : style.err('•')) +
        ' ' +
        style.dim(
          l.file +
            '  ·  ' +
            (l.labels ? l.labels.join(', ') : l.kinds.length ? l.kinds.join(', ') : 'secret-path capture') +
            (l.confidence === 'low' ? ' [weak match]' : '') +
            '  ·  ' +
            l.commits +
            ' commit(s) still hold it' +
            (l.trackedNow ? ' · still tracked today' : ''),
        ) +
        (l.tolerated ? style.dim('  ·  tolerated by ' + l.by) : ''),
    );
  });
  if (rows.length > 12) print('      ' + style.dim('… ' + (rows.length - 12) + ' more'));
  if (alarms.length)
    print(
      '      ' + style.dim('↳ keyflip scrub-history            (the plan; --apply rewrites it after a bundle backup)'),
    );
  if (tolerated)
    print(
      '      ' +
        style.dim(
          '↳ keyflip secrets list             (what is silenced, by which rule — and scrub-history still cleans all of it)',
        ),
    );
}

async function cmdTest(ctx, rest) {
  const name = rest.filter(function (a) {
    return a.indexOf('-') !== 0;
  })[0];
  if (!name)
    return fail('usage: keyflip test <provider>   (fires one minimal real request to check auth + reachability)');
  if (!provider.exists(ctx, name)) return fail("no such provider: '" + name + "'");
  const r = await doctor.testProvider(ctx, name);
  if (JSON_MODE) {
    jsonOut({ provider: name, result: r });
    return;
  }
  if (r.ok) print(style.ok('✓') + ' ' + name + ': ok (' + r.ms + 'ms, http ' + r.httpStatus + ')');
  else
    print(
      style.err('✗') +
        ' ' +
        name +
        ': ' +
        r.category +
        (r.httpStatus ? ' (http ' + r.httpStatus + ')' : '') +
        (r.reason ? ' — ' + r.reason : ''),
    );
}

// Parallel session: run Claude Code as <name> in THIS terminal only.
async function cmdRun(ctx, rest) {
  const sep = rest.indexOf('--');
  const fwd = sep === -1 ? [] : rest.slice(sep + 1);
  const own = sep === -1 ? rest : rest.slice(0, sep);
  const noShare = own.indexOf('--no-share') !== -1;
  const autoYes = own.indexOf('-y') !== -1 || own.indexOf('--yes') !== -1 || own.indexOf('--force') !== -1;
  const shareHistory = own.indexOf('--share-history') !== -1;
  let arg = own.filter(function (a) {
    return a.indexOf('-') !== 0;
  })[0];
  if (!arg) {
    const hit = links.lookup(ctx, process.cwd());
    if (hit) {
      arg = hit.name;
      print('Using linked account for this directory: ' + hit.name);
    } else
      return fail(
        'usage: keyflip run <name|number> [--no-share] [--share-history] [-y] [-- <claude args>]\n(or link this directory once:  keyflip link <name>)',
      );
  }
  const name = core.resolveProfile(ctx, arg);
  if (!name) return fail("no such account: '" + arg + "'");
  const em = profiles.email(ctx.configDir, name) || name;

  // Policy engine: `run` ACTIVATES an account in this directory (isolated session), so it must be
  // constrained the same as a switch (no-op until rules exist; --force overrides).
  if (own.indexOf('--force') === -1) {
    try {
      _policy.enforce(ctx, { cwd: process.cwd(), account: name });
    } catch (e) {
      if (e && e.code === 'POLICY_DENIED') return fail(e.message + '  (override with --force)');
      throw e;
    }
  }

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
    if (!ok) {
      print('Cancelled.');
      return;
    }
  }

  let dir;
  await withLock(ctx, function () {
    dir = session.prepareSession(ctx, name, { share: !noShare, shareHistory: shareHistory });
  });
  const se = session.sessionEnv(ctx, dir);
  se.scrubbed.forEach(function (k) {
    print('  ⚠️ ignoring ' + k + ' for this session (it would override the account).');
  });
  print('Launching Claude Code as ' + em + ' (this terminal only)…');
  logmod.log('run session: ' + name);
  const bin = process.env.KEYFLIP_CLAUDE_BIN || 'claude';
  const r = _child_process.spawnSync(bin, fwd, { stdio: 'inherit', env: se.env });
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
    return fail(
      'usage: keyflip add <name> --token <file|-> [--email a@b.c] [--force]\n(the raw credentials JSON is read from a file or stdin — NEVER pass it as an argument)',
    );
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return fail("'" + email + "' is not a valid email address");
  }
  let raw;
  try {
    raw = srcArg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(srcArg, 'utf8');
  } catch (e) {
    return fail('could not read the credential: ' + e.message);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return fail('that is not valid credentials JSON');
  }
  if (
    !parsed ||
    !parsed.claudeAiOauth ||
    typeof parsed.claudeAiOauth.accessToken !== 'string' ||
    !parsed.claudeAiOauth.accessToken.trim()
  ) {
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
    print(style.warn("⚠️  You are importing a RAW login credential for '" + name + "'."));
    print('   Only do this with a credential you exported yourself or fully trust —');
    print('   whoever holds this token has full access to the account.');
    const ok = await confirm('Import it? [y/N] ');
    if (!ok) {
      print('Cancelled — nothing was imported.');
      return;
    }
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
  if (method === 'checkout') {
    // npm link / install.sh --link: the running code IS the working tree, so it is
    // already "installed" — updating means pulling, which we never do on the user's behalf.
    const root = update.checkoutRoot(process.argv[1] || '');
    print('keyflip runs from a source checkout (' + root + ') — it already tracks that tree.');
    print('Update it with:  git -C ' + JSON.stringify(root) + ' pull --ff-only');
    return;
  }
  const spawn = update.upgradeSpawn(method);
  if (!spawn) {
    return fail(
      "couldn't detect how keyflip was installed — upgrade manually with either:\n  " +
        update.upgradeCommand('installer') +
        '\n  ' +
        update.upgradeCommand('npm'),
    );
  }
  print('Upgrading (' + method + '):  ' + update.upgradeCommand(method));
  const r = _child_process.spawnSync(spawn.cmd, spawn.args, { stdio: 'inherit' });
  if (r.error)
    return fail(
      'could not run the upgrade (' +
        spawn.cmd +
        ' not found?): ' +
        r.error.message +
        '\nRun manually:  ' +
        update.upgradeCommand(method),
    );
  if (r.status !== 0)
    return fail('upgrade failed (exit ' + r.status + ') — run manually:  ' + update.upgradeCommand(method));
  print(style.ok('✅') + ' Upgraded — run keyflip version to confirm.');
}

// One-line answer to "which account am I on?" (both surfaces).
function cmdStatus(ctx) {
  const cliEmail = core.currentEmail(ctx) || null;
  // One detection pass (may prompt the Keychain once) → match a saved profile by org,
  // and keep the raw detection so an UNSAVED account still shows an email/org, not "unknown".
  let appName = null,
    appEmail = null,
    appLabel = null,
    appDet = null;
  if (ctx.appDataDir) {
    appDet = appauth.detectAppAccount(ctx);
    if (appDet && appDet.org) {
      profiles.list(ctx.configDir).forEach(function (n) {
        if (appName) return;
        const m = profiles.read(ctx.configDir, n);
        if (m && m.oauthAccount && m.oauthAccount.organizationUuid === appDet.org) appName = n;
      });
    }
    appEmail = appName ? profiles.email(ctx.configDir, appName) || null : null;
    appLabel =
      appEmail ||
      appName ||
      (appDet && appDet.email) ||
      (appDet && appDet.org ? appDet.org.slice(0, 8) + '… (unsaved)' : null);
  }
  const activeProvider = provider.readActive(ctx);
  jsonOut({
    cli: cliEmail ? { email: cliEmail } : null,
    app: appName
      ? { name: appName, email: appEmail }
      : appLabel
        ? { name: null, email: (appDet && appDet.email) || null, org: (appDet && appDet.org) || null, saved: false }
        : null,
    provider: activeProvider ? activeProvider.name : null,
  });
  if (!JSON_MODE) {
    print(
      'Claude Code: ' +
        (cliEmail || 'not logged in') +
        (ctx.appDataDir
          ? '   ·   Desktop app: ' +
            (appLabel || 'unknown') +
            (!appLabel && appDet && appDetectHint(appDet.reason) ? '  (' + appDetectHint(appDet.reason) + ')' : '')
          : ''),
    );
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

// After a switch reopens Claude, confirm it actually came back signed in.
//
// The restore hands the app a saved cookie jar, and the app then calls /authorize WITH
// that session cookie to re-mint its token cache. If the server rotated or revoked the
// session since the capture, the app deletes the cookie on boot and sits on its sign-in
// screen — which looks like a clean switch from here. So poll the jar for a few seconds
// instead of assuming: true = still signed in, false = the app cleared it (or never got
// it), null = nothing to check on this platform.
async function verifyAppRelogin(ctx, opts) {
  opts = opts || {};
  if (!ctx.appDataDir) return null;
  const nap = opts.sleep || sleep;
  const probe =
    opts.session ||
    function () {
      try {
        return appauth.liveAppSession(ctx, {}).signedIn;
      } catch (e) {
        return null;
      }
    };
  const polls = typeof opts.polls === 'number' ? opts.polls : 4;
  const stepMs = typeof opts.stepMs === 'number' ? opts.stepMs : 1000;
  let last = null;
  for (let i = 0; i < polls; i++) {
    await nap(stepMs);
    last = probe();
    if (last === false) return false; // the app cleared the cookie — that IS the failure
    if (last === null) continue; // unreadable (locked jar?) — keep trying
  }
  return last === true;
}

// The saved profile the desktop app's OWN login currently matches (by org uuid).
// Returns the profile name, '' when the app is signed in on an account keyflip has
// never saved, or null when there is no app login to read (no app, signed out, or
// its state is unreadable) — null means "can't tell", so callers must not act on it.
function profileForOrg(ctx, org) {
  let found = '';
  profiles.list(ctx.configDir).forEach(function (n) {
    if (found) return;
    const m = profiles.read(ctx.configDir, n);
    if (m && m.oauthAccount && m.oauthAccount.organizationUuid === org) found = n;
  });
  return found;
}

function appActiveProfile(ctx) {
  if (!ctx.appDataDir) return null;
  let det = null;
  try {
    det = appauth.detectAppAccount(ctx);
  } catch (e) {
    return null;
  }
  if (!det || !det.org) return null;
  return profileForOrg(ctx, det.org);
}

// Before a switch overwrites the app's login, keep the account we are LEAVING
// recoverable: re-snapshot its token + its freshly-flushed Cookies DB into its own
// profile. A clean quit is exactly when Chromium writes sessionKey/cf_clearance to
// disk, so this is the moment a usable cookie exists — which is what later lets
// `keyflip chat --as <that account>` read its cloud chats without switching back.
// Only runs while the desktop app is CLOSED (its files are locked otherwise), and
// only on a CONFIRMED token decrypt: the allowlist-org fallback is a guess, and a
// wrong guess would overwrite a good capture with another account's blob (same rule
// `keyflip add` follows when it refuses to auto-name an unidentified app login).
function preserveOutgoingAppLogin(ctx) {
  if (!ctx.appDataDir || appctl.isDesktopAppRunning(ctx.platform)) return null;
  let det = null;
  try {
    det = appauth.detectAppAccount(ctx);
  } catch (e) {
    return null;
  }
  if (!det || det.reason || !det.org) return null;
  const cur = profileForOrg(ctx, det.org);
  if (!cur) return null; // an account keyflip never saved: nothing to update
  let r = null;
  try {
    r = appauth.snapshotToProfile(ctx, cur);
  } catch (e) {
    return null;
  }
  if (r && r.ok && r.cookies === 'ok')
    print("  ↳ kept '" + cur + "'s app login + session cookie fresh for later reads.");
  return r && r.ok ? r : null;
}

// Capture the desktop app's CURRENT login into a profile — fully independent of
// the CLI (which may be logged out or on another account). Creates the profile if
// needed: identifies the app's account by decrypting its token cache (org uuid),
// mapping it to the app's per-account folders, and best-effort finding the email.
// A human hint for WHY the desktop account couldn't be auto-identified.
function appDetectHint(reason) {
  if (reason === 'keychain-locked') return 'Unlock your login keychain (it holds the app key), then retry.';
  if (reason === 'no-token-cache' || reason === 'decrypt-failed' || reason === 'unresolved-org')
    return 'Open the Claude desktop app and confirm it is signed in, then retry.';
  if (reason === 'no-desktop-config') return 'The Claude desktop app is not set up on this machine.';
  return null;
}

// Returns { ok, name?, email?, needName?, reason? } — printing is the caller's job.
function captureApp(ctx, nameArg, opts) {
  const dryRun = !!(opts && opts.dryRun);
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
        if ((email && m.email === email) || (det.org && m.oauthAccount && m.oauthAccount.organizationUuid === det.org))
          name = n;
      });
      if (!name && email) name = core.autoName(ctx, email);
    }
    if (!name) return { ok: false, needName: true, reason: det.reason || null };
  }

  const existed = profiles.exists(ctx.configDir, name);
  // #52: a dry run must be PROVABLY write-free, so it stops before the first write and reports
  // what it WOULD do — the same contract `keyflip <account> --dry-run` already gives a switch.
  // The freshest evidence of the app's session (read-only) is what decides whether a real run
  // could capture a usable cookie, so plan on that rather than assuming success.
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      name: name,
      email: email,
      existed: existed,
      cookies: appauth.liveAppSession(ctx, {}).signedIn ? 'ok' : 'incomplete',
    };
  }
  if (!existed) {
    const oa = {};
    if (det.org) oa.organizationUuid = det.org;
    if (det.account) oa.accountUuid = det.account;
    if (email) oa.emailAddress = email;
    profiles.write(ctx.configDir, {
      name: name,
      email: email || '',
      oauthAccount: oa,
      appOnly: true,
      savedAt: ctx.now(),
    });
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
  const ok = await confirm(
    "Claude hasn't saved this fresh login to disk yet. Briefly close & reopen it to capture it? [y/N] ",
  );
  if (!ok) return 'incomplete';
  print('Quitting Claude...');
  appctl.quitClaude(ctx.platform);
  await waitForQuit(ctx);
  let status = 'incomplete';
  if (!appctl.isClaudeRunning(ctx.platform)) {
    const r = appauth.snapshotToProfile(ctx, name);
    status = (r.ok && r.cookies) || 'incomplete';
  }
  print('Reopening Claude...');
  appctl.openClaude(ctx.platform);
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
  if (rest.indexOf('--token') !== -1) {
    logmod.log('add invoked');
    return cmdAddToken(ctx, rest);
  }
  const appOnly = rest.indexOf('--app') !== -1;
  // #52: `add` writes to the git-versioned state repo and to a credential store, so like a switch
  // it must be plannable. --dry-run reports what it WOULD capture and stops before the first write
  // — INCLUDING the audit-log line, which is itself versioned into the state repo (same contract
  // as `keyflip <account> --dry-run`, which never logs `switch requested`).
  const dryRun = rest.indexOf('--dry-run') !== -1 || rest.indexOf('--plan') !== -1;
  if (!dryRun) logmod.log('add invoked');
  const nameArg = rest.filter(function (a) {
    return a.indexOf('--') !== 0;
  })[0];

  if (appOnly) {
    const r = captureApp(ctx, nameArg || null, { dryRun: dryRun });
    if (r.dryRun) {
      if (r.cookies !== 'ok') {
        print(
          style.warn('⚠') + ' the app jar holds no claude.ai session cookie right now — a capture would be INCOMPLETE.',
        );
        print(
          style.dim('   sign in once in Claude (a restore cannot mint that cookie), then re-run without --dry-run.'),
        );
        return;
      }
      print(style.bold('keyflip add --dry-run') + style.dim(' — nothing is written.'));
      print(
        '  Desktop app: signed in as ' +
          style.bold("'" + r.name + "'") +
          (r.email ? ' (' + r.email + ')' : '') +
          (r.existed ? style.dim(' — profile exists, would be refreshed') : style.dim(' — new profile')),
      );
      print(
        '  Would write: ' +
          style.dim('app/' + r.name + '.json + app/' + r.name + '.cookies') +
          style.dim(' (session cookie ' + r.cookies + ')'),
      );
      print(style.dim('  ↳ re-run the same command without --dry-run to capture it.'));
      jsonOut({ dryRun: true, surface: 'app', account: r.name, email: r.email, cookies: r.cookies });
      return;
    }
    if (r.ok) {
      print("💾 Desktop app login: captured as '" + r.name + "'" + (r.email ? ' (' + r.email + ')' : '') + '.');
      let ck = r.cookies;
      if (ck !== 'ok') ck = await repairCookieCapture(ctx, r.name);
      if (ck !== 'ok') warnIncompleteCookies(r.name);
      return;
    }
    if (r.needName)
      return fail(
        "Couldn't auto-identify the app's account. Name it:  keyflip add <name> --app" +
          (appDetectHint(r.reason) ? '\n  ↳ ' + appDetectHint(r.reason) : ''),
      );
    return fail(
      'Could not capture the desktop-app login: ' +
        (r.reason === 'macos-only' ? 'the desktop app store is macOS-only.' : r.reason),
    );
  }

  // Unified add: the CLI login is captured from a credential store, so a dry run reports it
  // (read-only) and never touches the store or the profile files.
  if (dryRun) {
    const cliEmail = core.currentEmail(ctx);
    const appRes = captureApp(ctx, cliEmail ? null : nameArg, { dryRun: true });
    if (!cliEmail && !appRes.ok) return fail('Nothing to capture. Log in in Claude first.');
    print(style.bold('keyflip add --dry-run') + style.dim(' — nothing is written.'));
    if (cliEmail) print('  Claude Code: would save the live CLI login for ' + style.bold(cliEmail));
    if (appRes.ok)
      print(
        '  Desktop app: would save ' +
          style.bold("'" + appRes.name + "'") +
          (appRes.email ? ' (' + appRes.email + ')' : '') +
          style.dim(' (session cookie ' + appRes.cookies + ')'),
      );
    else if (appRes.needName) print('  Desktop app: signed in, but its account could not be identified — name it.');
    print(style.dim('  ↳ re-run the same command without --dry-run to capture.'));
    jsonOut({
      dryRun: true,
      cli: cliEmail || null,
      app: appRes.ok ? { account: appRes.name, email: appRes.email, cookies: appRes.cookies } : null,
    });
    return;
  }

  let cliRes = null,
    cliErr = null;
  try {
    cliRes = core.addCurrent(ctx, nameArg);
  } catch (e) {
    cliErr = (e && e.message) || String(e);
  }
  if (cliRes) {
    print(
      cliRes.refreshed
        ? "↻ CLI login: '" + cliRes.email + "' already saved as '" + cliRes.name + "' — refreshed."
        : "💾 CLI login: saved '" + cliRes.email + "' as '" + cliRes.name + "'.",
    );
  }

  // Desktop app: pass the explicit name through only when the CLI didn't take it
  // (otherwise auto-detect, so we never mis-pair the app with the wrong account).
  const appRes = captureApp(ctx, cliRes ? null : nameArg);
  if (appRes.ok) {
    print(
      "💾 Desktop app login: captured as '" + appRes.name + "'" + (appRes.email ? ' (' + appRes.email + ')' : '') + '.',
    );
    let ck = appRes.cookies;
    if (ck !== 'ok') ck = await repairCookieCapture(ctx, appRes.name);
    if (ck !== 'ok') warnIncompleteCookies(appRes.name);
  }

  if (!cliRes && !appRes.ok) {
    if (appRes.needName) {
      return fail(
        "The desktop app is signed in, but I couldn't identify its account.\n" +
          'Name it yourself:  keyflip add <name> --app' +
          (appDetectHint(appRes.reason) ? '\n  ↳ ' + appDetectHint(appRes.reason) : ''),
      );
    }
    return fail('Nothing to capture. Log in in Claude first.' + (cliErr ? '\n(CLI: ' + cliErr + ')' : ''));
  }
  if (cliRes && appRes.needName) {
    print("↳ The desktop app is signed in but its account couldn't be identified. If it's a");
    print('  different account than the CLI, capture it with:  keyflip add <name> --app');
    if (appDetectHint(appRes.reason)) print('  ↳ ' + appDetectHint(appRes.reason));
  }
  const anyIncomplete = profiles.list(ctx.configDir).some(function (n) {
    return capturedCliSafe(ctx, n) === false || !appauth.hasProfile(ctx, n);
  });
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
  const name =
    rest.filter(function (a, i) {
      return a.indexOf('-') !== 0 && i !== emailValIdx;
    })[0] || null;
  if (name && !profiles.isValidName(name))
    return fail("invalid profile name: '" + name + "' (allowed: A-Z a-z 0-9 . _ -)");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("'" + email + "' is not a valid email address");

  // --fresh: clear the browser's claude.ai session first, so the OAuth page prompts
  // a genuine login as the account you want (OAuth reuses whatever the browser is
  // signed into — otherwise it silently captures THAT account, not the one you meant).
  if (fresh && ctx.platform === 'darwin') {
    const browser = _browser;
    browser.installed(ctx.home).forEach(function (b) {
      const cr = browser.clearClaudeCookies(b, {});
      if (cr.ok) print(style.dim('· cleared ' + b.name + ' claude.ai session (backup: ' + cr.backup + ')'));
      else if (cr.reason === 'browser-running')
        print(
          style.warn('⚠️') +
            ' quit ' +
            b.name +
            ' first for --fresh to take effect (its claude.ai session is still active).',
        );
    });
  }

  print(style.bold('keyflip login') + ' — sign in to a Claude account (your current login stays put).');
  print(
    'A browser will open. ' +
      (email ? 'Sign in as ' + style.bold(email) : 'Sign in to the account you want to add') +
      (manual
        ? ' — sign in however you like (email code, magic link); paste the code/URL when asked.\n'
        : ' and approve — then I capture it automatically.\n'),
  );

  if (manual && !process.stdin.isTTY)
    return fail('--manual is interactive — run it in a real terminal (it reads the pasted code from stdin).');

  let res;
  try {
    res = manual
      ? await loginmod.performLoginManual(ctx, { email: email, name: name, useConsole: useConsole, sso: sso })
      : loginmod.performLogin(ctx, { email: email, name: name, useConsole: useConsole, sso: sso, stdio: 'inherit' });
  } catch (e) {
    if (e.code === 'mismatch') {
      return fail(
        e.message +
          '.\nFix: log out of claude.com in that browser (' +
          style.bold('keyflip browser logout') +
          ", or 'switch account' on the login page), then retry:  keyflip login " +
          (name || (email ? email.split('@')[0] : '<name>')) +
          (email ? ' --email ' + email : '') +
          ' --fresh',
      );
    }
    return fail(e.message + (e.code === 'no-cred' ? ' — nothing saved. (Please report this.)' : ''));
  }
  logmod.log('login ' + res.status + ' ' + res.name);
  saveBrowserSession(ctx, res.name); // stash its browser session for later `browser sync`
  print(
    '\n' +
      style.ok('✅') +
      ' ' +
      res.status +
      " '" +
      style.bold(res.name) +
      "'" +
      (res.email ? ' (' + res.email + ')' : '') +
      ' — your current login is untouched. Switch with: ' +
      style.bold('keyflip ' + res.name),
  );
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
      if (r && r.email) {
        captured.add(r.email.toLowerCase());
        out.push({ name: r.name, email: r.email, surface: 'CLI' });
      }
    } catch (e) {
      logmod.log('setup: cli capture failed: ' + (e && e.message));
    }
  }
  if (ctx.appDataDir) {
    let appEmail = null;
    try {
      const d = appauth.detectAppAccount(ctx);
      appEmail = d && d.email;
    } catch (e) {
      /* ignore */
    }
    if (appEmail && !captured.has(String(appEmail).toLowerCase())) {
      const r = captureApp(ctx, null);
      if (r && r.ok) {
        captured.add(String(r.email || appEmail).toLowerCase());
        out.push({ name: r.name, email: r.email, surface: 'app' });
      }
    }
  }
  return out;
}

// Wait until either a brand-new login appears (polled every 1.5s) or the user
// presses Enter / types 'd'. Uses ONE shared readline (`rl`) for the whole wizard
// — creating a fresh interface per round breaks stdin on the second prompt.
// Resolves { found } | { rescan } | { done }.
function waitForNextLogin(ctx, captured, rl, isClosed) {
  const onboard = _onboard;
  return new Promise(function (resolve) {
    if (isClosed()) return resolve({ done: true });
    let settled = false;
    function finish(v) {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      rl.removeListener('line', onLine);
      rl.removeListener('close', onClose);
      resolve(v);
    }
    function onLine(a) {
      const s = (a || '').trim().toLowerCase();
      finish(s === 'd' || s === 'done' || s === 'q' || s === 'quit' ? { done: true } : { rescan: true });
    }
    function onClose() {
      finish({ done: true });
    }
    const timer = setInterval(function () {
      let found = null;
      try {
        found = onboard.firstNewLogin(ctx, captured);
      } catch (e) {
        /* ignore */
      }
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
    return fail(
      '`keyflip setup` is an interactive wizard — run it directly in a terminal.\n' +
        'Non-interactive: log in, then `keyflip add` (once per account).',
    );
  }
  const onboard = _onboard;
  const captured = onboard.capturedEmails(ctx);
  let total = captured.size;

  print(style.bold('keyflip setup') + ' — save all your Claude accounts, one login at a time.');
  print('For each account you log in once (Claude Code and/or the desktop app) and I capture it.');
  print(style.dim('Your chats in ~/.claude/projects are never touched; your live login is only read.') + '\n');
  if (captured.size) print('Already saved: ' + style.bold(String(captured.size)) + ' account(s).');

  const first = captureLive(ctx, captured);
  first.forEach(function (g) {
    total++;
    print(
      '  ' +
        style.ok('✅') +
        " saved '" +
        style.bold(g.name) +
        "'" +
        (g.email ? ' (' + g.email + ')' : '') +
        ' [' +
        g.surface +
        ']',
    );
  });
  if (!first.length && !captured.size) {
    print(
      'No account is logged in yet. In Claude Code run ' +
        style.bold('/login') +
        ' (or open the desktop app and sign in).',
    );
  }

  // One readline for the whole wizard (a fresh one per round breaks stdin).
  const rl = _readline.createInterface({ input: process.stdin, output: process.stderr });
  let rlClosed = false;
  rl.once('close', function () {
    rlClosed = true;
  });
  const isClosed = function () {
    return rlClosed;
  };
  try {
    for (;;) {
      print('\n' + style.bold('Add another account?') + ' Switch to the next one:');
      print(
        '  • Claude Code:  ' +
          style.bold('/logout') +
          ' then ' +
          style.bold('/login') +
          '    • or the desktop app: sign out, sign in',
      );
      print(
        "I'll capture it automatically — press " +
          style.bold('Enter') +
          ' to rescan now, or type ' +
          style.bold('d') +
          ' when done.',
      );
      const ev = await waitForNextLogin(ctx, captured, rl, isClosed);
      if (ev.done) break;
      const got = captureLive(ctx, captured);
      if (got.length) {
        got.forEach(function (g) {
          total++;
          print(
            '  ' +
              style.ok('✅') +
              " saved '" +
              style.bold(g.name) +
              "'" +
              (g.email ? ' (' + g.email + ')' : '') +
              ' [' +
              g.surface +
              ']',
          );
        });
      } else {
        const now = core.currentEmail(ctx);
        print(
          '  ' +
            style.warn('…') +
            ' no new account detected' +
            (now ? ' (still ' + now + ')' : ' (signed out)') +
            ' — did you ' +
            style.bold('/logout') +
            ' then ' +
            style.bold('/login') +
            '? Try again, or type ' +
            style.bold('d') +
            '.',
        );
      }
    }
  } finally {
    rl.close();
  }

  print('\n' + style.ok('✅') + ' Done — ' + style.bold(String(total)) + ' account(s) saved.');
  print(
    'Switch anytime:  ' +
      style.bold('keyflip') +
      ' (menu) or ' +
      style.bold('keyflip <name>') +
      '.   See all:  ' +
      style.bold('keyflip list --usage'),
  );
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
  if (!name) {
    print('  ' + style.warn('·') + ' cancelled (no name).');
    return null;
  }
  if (!profiles.isValidName(name)) {
    print('  ' + style.err('✗') + " invalid name '" + name + "'.");
    return null;
  }
  if (provider.exists(ctx, name)) {
    print('  ' + style.warn('·') + " a provider named '" + name + "' already exists — skipping.");
    return null;
  }
  const baseUrl = String(await ask('  Base URL (https://…): ')).trim();
  if (!/^https?:\/\//.test(baseUrl)) {
    print('  ' + style.err('✗') + ' the base URL must be an http(s) URL.');
    return null;
  }
  const schemeAns = String(
    await ask('  Auth header [Enter = bearer (ANTHROPIC_AUTH_TOKEN), a = api-key (ANTHROPIC_API_KEY)]: '),
  ).trim();
  const authScheme = /^a/i.test(schemeAns) ? 'api-key' : 'bearer';
  const key = (await askHidden(rl, '  API key (input hidden; blank = none): ')).trim() || null;
  let meta;
  try {
    meta = provider.add(ctx, name, { baseUrl: baseUrl, authScheme: authScheme, key: key });
  } catch (e) {
    print('  ' + style.err('✗') + ' ' + e.message);
    return null;
  }
  logmod.log('onboard provider add ' + name);
  print('  ' + style.ok('✅') + " saved provider '" + name + "' → " + meta.baseUrl + (key ? '' : '  (no key stored)'));
  const useAns = String(await ask('  Route Claude Code to it now? [y/N] ')).trim();
  if (/^y(es)?$/i.test(useAns)) {
    try {
      const r = provider.use(ctx, name);
      print(
        '  ' +
          style.ok('✅') +
          ' Claude Code now uses ' +
          name +
          ' (' +
          r.baseUrl +
          '). Back to a subscription anytime: keyflip provider off.',
      );
    } catch (e) {
      print('  ' + style.warn('⚠') + ' saved, but could not activate it: ' + e.message);
    }
  }
  return name;
}

async function cmdOnboard(ctx, rest) {
  logmod.log('onboard invoked');
  if (!process.stdin.isTTY)
    return fail(
      "`keyflip onboard` is an interactive wizard — run it in a terminal (ideally NOT inside the Claude desktop app, so aligning surfaces can't interrupt it).",
    );
  const manual = rest.indexOf('--manual') !== -1 || rest.indexOf('--paste') !== -1;
  // Enterprise/SSO: apply to every OAuth sign-in in this run (#7).
  const sso = rest.indexOf('--sso') !== -1;
  const useConsole = rest.indexOf('--console') !== -1;

  print(style.bold('keyflip onboard') + ' — set your accounts up across every surface, one sign-in at a time.');
  print(
    style.dim(
      'Per account: sign in once in the browser → keyflip captures it, points the CLI + browser at it, and syncs your chats. Then it asks if you want another.',
    ),
  );
  print(style.dim('The Claude desktop app keeps its OWN login — to capture that too, sign the app in when prompted.'));
  print(
    style.dim(
      'Not a subscription? Choose "p" to add an API-key provider endpoint (relay/gateway/Bedrock/OpenRouter) instead.',
    ) + '\n',
  );

  // terminal:true is REQUIRED so readline manages echo (via _writeToOutput) — that is
  // the only thing askHidden() can mute. Without it (e.g. `onboard 2>file`, stderr not a
  // TTY → readline defaults to terminal:false), the TTY driver echoes the typed provider
  // API key in cleartext and the mute never fires.
  const rl = _readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const ask = function (q) {
    return new Promise(function (r) {
      rl.question(q, r);
    });
  };
  const isDone = function (s) {
    return /^(d|done|q|quit|n|no)$/i.test(String(s || '').trim());
  };
  const isProvider = function (s) {
    return /^(p|provider)$/i.test(String(s || '').trim());
  };
  let count = 0,
    providers = 0;
  try {
    for (;;) {
      const ans = await ask(
        '\n' +
          style.bold(count === 0 && providers === 0 ? 'Add your first account' : 'Add another account') +
          '? [Enter = subscription sign-in, p = API-key provider, d = done] ',
      );
      if (isDone(ans)) {
        if (count > 0 || providers > 0) break;
        print('Add at least one account or provider (or Ctrl-C to quit).');
        continue;
      }
      if (isProvider(ans)) {
        if (await onboardProvider(ctx, ask, rl)) providers++;
        continue;
      }

      // Before each account AFTER the first: sign the browser OUT of the previous
      // account (quit it + clear its claude.ai session) so the next sign-in is a
      // fresh login — no manual "switch account" on the page.
      if (count > 0 && ctx.platform === 'darwin') {
        try {
          const browser = _browser;
          const napMs = function (ms) {
            return new Promise(function (r) {
              setTimeout(r, ms);
            });
          };
          let did = false;
          const list = browser.installed(ctx.home);
          for (let i = 0; i < list.length; i++) {
            const b = list[i];
            if (browser.isRunning(b)) {
              browser.quit(b, exec.run);
              for (let t = 0; t < 24 && browser.isRunning(b); t++) {
                await napMs(250);
              }
            }
            const cr = browser.clearClaudeCookies(b, { force: true });
            if (cr.ok) did = true;
          }
          if (did)
            print('  ' + style.dim('· signed the browser out of the previous account — the next sign-in is fresh.'));
        } catch (e) {
          /* best-effort */
        }
      }

      let res;
      try {
        print(
          '  Opening the browser — sign in as the account you want' +
            (manual ? ' (paste the code/URL when asked)…' : ' and approve…'),
        );
        res = manual
          ? await loginmod.performLoginManual(ctx, { sso: sso, useConsole: useConsole })
          : loginmod.performLogin(ctx, { sso: sso, useConsole: useConsole, stdio: 'inherit' });
      } catch (e) {
        print('  ' + style.err('✗') + " sign-in didn't complete: " + e.message);
        continue;
      }
      count++;
      print(
        '  ' + style.ok('✅') + ' captured ' + style.bold(res.name) + ' (' + (res.email || '?') + ') — CLI + browser.',
      );
      saveBrowserSession(ctx, res.name); // stash its browser session for later `browser sync`

      try {
        core.performSwitch(ctx, res.name);
        print('  ' + style.ok('✅') + ' CLI now on ' + res.name + '.');
      } catch (e) {
        print('  ' + style.warn('⚠') + " couldn't point the CLI at it: " + e.message);
      }

      // Desktop (Claude Desktop app): it keeps its OWN login that a browser sign-in
      // can't mint, so offer a guided capture — the user signs the app in, we snapshot.
      if (ctx.appDataDir) {
        const da = await ask(
          '  Capture the Claude Desktop app for this account too? Sign Claude Desktop into ' +
            style.bold(res.email || res.name) +
            ', then press Enter  [Enter = capture, s = skip] ',
        );
        if (!/^\s*s(kip)?\s*$/i.test(da)) {
          const ar = captureApp(ctx, null); // auto-detect whichever account the app is on now
          if (ar && ar.ok) print('  ' + style.ok('✅') + ' Claude Desktop captured (' + (ar.email || ar.name) + ').');
          else
            print(
              '  ' +
                style.warn('·') +
                ' desktop app not captured (' +
                ((ar && ar.reason) || 'is Claude Desktop signed into ' + (res.email || res.name) + '?') +
                ') — later: keyflip add --app',
            );
        }
        // Sync chats across accounts (only possible while the app is closed).
        if (!appctl.isClaudeRunning(ctx.platform)) consolidateAndReport(ctx);
      }
    }
  } finally {
    rl.close();
  }

  print(
    '\n' +
      style.ok('✅') +
      ' Onboarding done — ' +
      style.bold(String(count)) +
      ' account(s)' +
      (providers ? ' + ' + style.bold(String(providers)) + ' provider(s)' : '') +
      ' set up. Switch anytime: ' +
      style.bold('keyflip <name>') +
      '   ·   see all: ' +
      style.bold('keyflip list'),
  );
  jsonOut({ onboard: true, added: count, providers: providers });
}

// Sync the BROWSER (claude.ai session) to `name` — restore that account's saved
// session so the Claude extension reconnects as it. Quits the browser, writes the
// stored cookies, reopens. Returns the browsers actually synced. macOS only.
async function browserSync(ctx, name) {
  if (ctx.platform !== 'darwin') return [];
  const browser = _browser;
  const napMs = function (ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  };
  const synced = [];
  const list = browser.installed(ctx.home);
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const sql = browser.loadSession(ctx.configDir, name, b);
    if (!sql) continue; // no saved browser session for this account+browser
    const wasRunning = browser.isRunning(b);
    if (wasRunning) {
      browser.quit(b, exec.run);
      for (let t = 0; t < 24 && browser.isRunning(b); t++) {
        await napMs(250);
      }
    }
    // If it refused to quit, DON'T force-write its live Cookies DB — that corrupts it.
    if (browser.isRunning(b)) {
      print(
        '  ' +
          style.warn('⏭') +
          ' ' +
          b.name +
          ' is still open — quit it and re-run `keyflip browser sync ' +
          name +
          '`.',
      );
      continue;
    }
    const r = browser.restoreClaudeCookies(b, sql, { force: true });
    if (r.ok) {
      synced.push(b.name);
      if (wasRunning) exec.run('open', ['-a', b.proc]);
    }
  }
  return synced;
}

// Best-effort: stash the current browser session under `name` (called after a
// capture, when the browser IS on that account).
function saveBrowserSession(ctx, name) {
  if (ctx.platform !== 'darwin') return;
  try {
    const browser = _browser;
    browser.installed(ctx.home).forEach(function (b) {
      browser.saveSession(ctx.configDir, name, b, {});
    });
  } catch (e) {
    /* best-effort */
  }
}

// `keyflip browser capture <account>` — save the browser's CURRENT claude.ai session
// under a named account, which is what makes `keyflip chat --as <account>` able to read
// that account's cloud history later. Note this is the opposite direction of
// `keyflip browser sync`, which WRITES a saved session back into the browser.
//
// Guarded on purpose: filing one account's cookies under another account's name would
// silently poison every later read of it, so a browser whose claude.ai org is known and
// differs from the named account is skipped, never saved.
function browserCapture(ctx, name, opts) {
  opts = opts || {};
  const browser = _browser;
  const installed = opts.installed || browser.installed(ctx.home);
  const read =
    opts.readClaudeCookies ||
    function (b) {
      return browser.readClaudeCookies(b, opts.run ? { run: opts.run } : {});
    };
  const save =
    opts.saveSession ||
    function (n, b) {
      return browser.saveSession(ctx.configDir, n, b, {});
    };
  const emailOf =
    opts.emailOf ||
    function (n) {
      return n && profiles.email(ctx.configDir, n);
    };
  const orgOf =
    opts.orgOf ||
    function (n) {
      const m = n ? profiles.read(ctx.configDir, n) : null;
      return (m && m.oauthAccount && m.oauthAccount.organizationUuid) || null;
    };
  const labelOf =
    opts.labelOf ||
    function (org) {
      if (!org) return null;
      let lbl = null;
      profiles.list(ctx.configDir).forEach(function (n) {
        const m = profiles.read(ctx.configDir, n);
        if (m && m.oauthAccount && m.oauthAccount.organizationUuid === org) lbl = m.email || n;
      });
      return lbl;
    };
  const wantOrg = orgOf(name);
  const out = { name: name, email: emailOf(name), saved: [], skipped: [] };
  installed.forEach(function (b) {
    let ck = null;
    try {
      ck = read(b);
    } catch (e) {
      ck = null;
    }
    if (!ck || !ck.cookie) {
      out.skipped.push({ browser: b.name, reason: 'no-readable-session' });
      return;
    }
    if (ck.org && wantOrg && ck.org !== wantOrg) {
      out.skipped.push({
        browser: b.name,
        reason: 'other-account',
        signedInAs: labelOf(ck.org) || ck.org.slice(0, 8) + '…',
      });
      return;
    }
    if (save(name, b)) out.saved.push(b.name);
    else out.skipped.push({ browser: b.name, reason: 'snapshot-failed' });
  });
  return out;
}

// `keyflip browser [status|logout]` — Phase 2/3: see and reset the BROWSER's
// claude.ai session, which the Claude Chrome extension inherits. A mismatch
// between the browser account and the active CLI/desktop account is exactly why
// the "Claude browser" extension refuses to connect.
async function cmdBrowser(ctx, rest) {
  logmod.log('browser invoked');
  const browser = _browser;
  if (ctx.platform !== 'darwin')
    return fail('browser session management is macOS-only for now (cookie decryption differs on Windows/Linux).');
  const sub = rest[0] && rest[0].indexOf('-') !== 0 ? rest[0] : 'status';
  const bi = rest.indexOf('--browser');
  const only = bi !== -1 ? rest[bi + 1] : null;
  const force = rest.indexOf('--force') !== -1 || rest.indexOf('-y') !== -1;
  const list = browser.installed(ctx.home).filter(function (b) {
    return !only || b.id === only;
  });
  if (!list.length)
    return fail(
      only
        ? "no installed browser with id '" + only + "' (chrome|brave|edge|arc)"
        : 'no supported Chromium browser found (Chrome/Brave/Edge/Arc).',
    );

  // The account the native-messaging host (and thus the extension) must match.
  let activeOrg = null,
    activeLabel = null;
  const st = loginmod.parseAuthStatus(exec.run('claude', ['auth', 'status'], undefined, { timeoutMs: 8000 }).stdout);
  if (st) {
    activeOrg = st.orgId;
    activeLabel = st.email;
  }
  function labelForOrg(org) {
    if (!org) return null;
    let lbl = null;
    profiles.list(ctx.configDir).forEach(function (n) {
      const m = profiles.read(ctx.configDir, n);
      if (m && m.oauthAccount && m.oauthAccount.organizationUuid === org) lbl = m.email || n;
    });
    return lbl;
  }

  if (sub === 'status') {
    print(
      'Active account (CLI/desktop, what the extension must match): ' +
        style.bold(activeLabel || activeOrg || 'unknown'),
    );
    let anyMismatch = false;
    list.forEach(function (b) {
      const ck = browser.readClaudeCookies(b, {});
      if (!ck) {
        print(
          '  ' + b.name + ': ' + style.dim('not signed into claude.ai (or cookies unreadable — app-bound encryption?)'),
        );
        return;
      }
      const lbl = labelForOrg(ck.org) || (ck.org ? ck.org.slice(0, 8) + '…' : 'unknown');
      const match = ck.org && activeOrg && ck.org === activeOrg;
      if (!match) anyMismatch = true;
      print(
        '  ' +
          b.name +
          ': claude.ai = ' +
          style.bold(lbl) +
          '  ' +
          (match
            ? style.ok('✓ matches active')
            : style.warn('⚠ MISMATCH — the Claude browser extension will not connect')),
      );
    });
    if (anyMismatch)
      print(
        '\nFix: ' +
          style.bold('keyflip browser logout') +
          ' (clears the browser claude.ai session), then open claude.ai and sign in as ' +
          (activeLabel || 'the active account') +
          '.',
      );
    jsonOut({
      active: activeLabel || activeOrg,
      browsers: list.map(function (b) {
        const ck = browser.readClaudeCookies(b, {});
        return { id: b.id, org: ck && ck.org, match: !!(ck && ck.org && ck.org === activeOrg) };
      }),
    });
    return;
  }

  if (sub === 'logout') {
    print(
      'This clears the claude.ai session from: ' +
        list
          .map(function (b) {
            return b.name;
          })
          .join(', ') +
        '  (a backup of each Cookies DB is kept; other sites stay signed in).',
    );
    const running = list.filter(function (b) {
      return browser.isRunning(b);
    });
    if (running.length)
      print(
        style.warn('⚠️') +
          ' quit ' +
          running
            .map(function (b) {
              return b.name;
            })
            .join(', ') +
          ' first — the Cookies DB is locked while the browser is open' +
          (force ? ' (--force set: trying anyway).' : '.'),
      );
    if (!force) {
      if (!process.stdin.isTTY) return fail('re-run with --force to confirm (and quit the browser first).');
      const ok = await confirm('Proceed? [y/N] ');
      if (!ok) {
        print('Cancelled.');
        return;
      }
    }
    list.forEach(function (b) {
      const r = browser.clearClaudeCookies(b, { force: force });
      if (r.ok) print('  ' + style.ok('✅') + ' ' + b.name + ': claude.ai session cleared (backup: ' + r.backup + ').');
      else if (r.reason === 'browser-running')
        print('  ' + style.warn('⏭') + ' ' + b.name + ': still running — skipped (quit it, or --force).');
      else print('  ' + style.err('✗') + ' ' + b.name + ': ' + r.reason + (r.detail ? ' (' + r.detail + ')' : ''));
    });
    print(
      '\nNow open claude.ai in that browser and sign in as ' +
        style.bold(activeLabel || 'your active account') +
        ' — the extension will reconnect.',
    );
    return;
  }

  if (sub === 'capture') {
    // Save the browser's current claude.ai session UNDER an account (the active one by
    // default) so `keyflip chat --as <account>` can read its cloud history later.
    const who = rest[1] && rest[1].indexOf('-') !== 0 ? rest[1] : null;
    const name = who ? core.resolveProfile(ctx, who) : null;
    if (who && !name) return fail("no such saved account: '" + who + "' (see: keyflip list)");
    if (!name)
      return fail('which account? usage: keyflip browser capture <name>  (the browser must be signed in as it)');
    print('Saving the browser claude.ai session as ' + style.bold(profiles.email(ctx.configDir, name) || name) + ' …');
    const r = browserCapture(ctx, name, { installed: list });
    r.saved.forEach(function (n) {
      print(
        '  ' + style.ok('✅') + ' ' + n + ': claude.ai session saved — `keyflip chat --as ' + name + '` can read it.',
      );
    });
    r.skipped.forEach(function (s) {
      if (s.reason === 'other-account')
        print(
          '  ' +
            style.err('✗') +
            ' ' +
            s.browser +
            ' is signed into claude.ai as ' +
            style.bold(s.signedInAs) +
            ", not '" +
            name +
            "' — nothing saved (filing it under the wrong account would poison every later read).",
        );
      else if (s.reason === 'snapshot-failed')
        print('  ' + style.err('✗') + ' ' + s.browser + ': could not read its cookies into a snapshot.');
      else
        print(
          '  ' +
            style.warn('·') +
            ' ' +
            s.browser +
            ': no readable claude.ai session (sign into claude.ai there first).',
        );
    });
    if (!r.saved.length) return fail("nothing saved for '" + name + "'.");
    jsonOut({ browserCapture: name, saved: r.saved, skipped: r.skipped });
    return;
  }
  if (sub === 'sync') {
    // Restore the saved browser session for an account (the active one by default).
    const target = rest[1] && rest[1].indexOf('-') !== 0 ? core.resolveProfile(ctx, rest[1]) : null;
    const name =
      target ||
      (function () {
        let n = null;
        profiles.list(ctx.configDir).forEach(function (p) {
          if (!n && profiles.email(ctx.configDir, p) === core.currentEmail(ctx)) n = p;
        });
        return n;
      })();
    if (!name) return fail('which account? usage: keyflip browser sync <name>  (or switch to it first)');
    print(
      'Syncing the browser to ' +
        style.bold(profiles.email(ctx.configDir, name) || name) +
        ' (restores its saved claude.ai session, quits + reopens the browser)…',
    );
    const synced = await browserSync(ctx, name);
    if (synced.length)
      print(
        '  ' +
          style.ok('✅') +
          ' synced: ' +
          synced.join(', ') +
          ' — the Claude extension will reconnect as ' +
          (profiles.email(ctx.configDir, name) || name) +
          '.',
      );
    else
      print(
        '  ' +
          style.warn('·') +
          ' no saved browser session for ' +
          name +
          " yet (it's saved when you capture the account via onboard/login while the browser is on it).",
      );
    jsonOut({ browserSync: name, synced: synced });
    return;
  }
  return fail(
    'usage: keyflip browser [status|logout|capture <name>|sync [name]] [--browser chrome|brave|edge|arc] [--force]',
  );
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
  try {
    if (!appauth.cookiesLookLoggedIn(appauth.cookiesPath(ctx))) return { risk: false };
  } catch (e) {
    return { risk: false };
  }
  let appOrg = null;
  try {
    appOrg = appauth.detectActiveOrg(ctx);
  } catch (e) {
    return { risk: false };
  } // allowlist org, no Keychain access
  if (!appOrg) return { risk: false }; // can't tell the app's account -> don't cry wolf
  const meta = profiles.read(ctx.configDir, targetName) || {};
  const wantOrg = meta.oauthAccount && meta.oauthAccount.organizationUuid;
  if (!wantOrg) return { risk: false }; // target org unknown -> can't compare
  if (appOrg === wantOrg) return { risk: false }; // app already on the target account -> no conflict
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
// `keyflip refresh [--all] [--json]` — revive stored OAuth tokens BEFORE you need them.
// Switching is the wrong time to discover a token died: Anthropic rotates the refresh token on every
// use, so a capture that sat unused while the live session kept refreshing is now stale, and the
// only repair is either a refresh (which needs the credential to be idle) or a human login. This runs
// the same guarded refresh keyflip already does inside `switch`, but for every saved account at once,
// so an idle night can keep all of them alive.
async function cmdRefresh(ctx, rest) {
  // `main()` consumes the global `--json` before the command ever sees `rest`, so reading it off
  // `rest` here was always false — `keyflip refresh --all --json` printed human prose. JSON_MODE is
  // the only truth.
  const asJson = JSON_MODE;
  // #36: `--schedule [--at HH:MM]` / `--unschedule` / `--schedule-status` put this on the same
  // nightly timer as `dream` (launchd on macOS, cron on Linux), so a 6-day token cannot expire
  // while nobody is thinking about it. These are FLAGS, not subcommands: the first positional
  // argument here is an account name resolved by `core.resolveProfile`, so a bare `schedule`
  // would silently turn into "no saved account 'schedule'".
  const sched = rest.indexOf('--schedule') !== -1;
  const unsched = rest.indexOf('--unschedule') !== -1;
  const schedStatus = rest.indexOf('--schedule-status') !== -1;
  if (schedStatus) {
    const st = _schedule.status(ctx, { job: 'refresh' });
    if (asJson) {
      jsonOut({ refreshSchedule: st });
      return;
    }
    print(
      'Nightly token refresh: ' +
        (st.installed
          ? style.ok('scheduled') + ' (' + st.kind + (st.path ? ', ' + st.path : '') + ')'
          : style.warn('not scheduled')),
    );
    if (st.installed) {
      const at = st.recorded && st.recorded.at;
      print(
        '  ' +
          style.dim(
            'runs `keyflip refresh --all` daily at ' +
              (at ? String(at.h).padStart(2, '0') + ':' + String(at.m).padStart(2, '0') : 'its default hour'),
          ),
      );
      if (st.log) print('  ' + style.dim('output lands in ' + st.log));
      print(
        style.dim(
          '  While a Claude session is live the run refuses to rotate anything: it changes nothing and waits for the next idle night.',
        ),
      );
    }
    return;
  }
  if (unsched) {
    const r = _schedule.uninstall(ctx, { job: 'refresh' });
    if (!r.ok && r.kind === 'unsupported') return fail('scheduling is macOS/Linux-only for now.');
    print(style.ok('✅') + ' nightly token refresh ' + (r.existed === false ? 'was not scheduled.' : 'unscheduled.'));
    jsonOut({ refreshSchedule: { installed: false } });
    return;
  }
  if (sched) {
    const ai = rest.indexOf('--at');
    const at = ai !== -1 ? rest[ai + 1] : '04:30';
    if (!profiles.list(ctx.configDir).length)
      print(
        style.warn('·') + ' there are no saved accounts yet — the job has nothing to refresh until you capture one.',
      );
    print(
      'This installs a ' +
        (ctx.platform === 'darwin' ? 'launchd agent' : 'crontab entry') +
        ' that runs ' +
        style.bold('keyflip refresh --all') +
        ' daily at ' +
        at +
        '.',
    );
    print(
      style.dim(
        '  It rotates stored OAuth tokens for every account while nothing is using them. It calls no model and spends no quota.',
      ),
    );
    print(style.dim('  Remove with: keyflip refresh --unschedule.'));
    if (rest.indexOf('-y') === -1 && rest.indexOf('--force') === -1) {
      if (!process.stdin.isTTY) return fail('re-run with -y to confirm.');
      if (!(await confirm('Install the nightly token-refresh schedule? [y/N] '))) {
        print('Cancelled.');
        return;
      }
    }
    const r = _schedule.install(ctx, { job: 'refresh', at: at });
    if (!r.ok) return fail('could not schedule: ' + (r.reason || r.detail || 'unknown'));
    print(
      style.ok('✅') +
        ' scheduled nightly token refresh at ' +
        at +
        ' (' +
        r.kind +
        '). ' +
        style.dim('Status: keyflip refresh --schedule-status'),
    );
    if (r.log)
      print(
        style.dim('  It logs to ' + r.log + ' — an unattended job you cannot read after it ran cannot be debugged.'),
      );
    jsonOut({ refreshSchedule: { installed: true, at: at, kind: r.kind, log: r.log || null } });
    return;
  }
  const all = profiles.list(ctx.configDir);
  if (!all.length) return fail('no saved accounts.');
  const arg = rest.filter(function (a) {
    return a[0] !== '-';
  })[0];
  let names = all;
  if (arg && arg !== '--all') {
    const hit = core.resolveProfile(ctx, arg);
    if (!hit) return fail("no saved account '" + arg + "' — see: keyflip list");
    names = [hit];
  }
  // THE GUARD: rotating a refresh token under a live Claude session logs one surface out, so a
  // refresh is only safe while nothing is holding the credential.
  const running = appctl.isClaudeRunning(ctx.platform);
  const instances = appctl.claudeInstances(ctx.home);
  if (running || instances.length) {
    // A refusal must be readable by a machine too: this is the branch the nightly job takes whenever
    // the user works late, and "exit 0 + prose" is how a no-op gets mistaken for a renewal.
    if (asJson) {
      jsonOut({
        refreshed: [],
        refused: running ? 'claude-code-running' : 'claude-instances-active',
        instances: instances.length,
        changed: false,
      });
      return 0;
    }
    print(
      style.warn('·') +
        ' ' +
        (running ? 'Claude Code is running on this machine' : instances.length + ' Claude instance(s) active') +
        ' — refreshing now would rotate a token something is still using.',
    );
    print(style.dim('  nothing was changed. Run this when the CLI is idle (or it will happen on the next switch).'));
    return 0;
  }
  const results = [];
  for (let i = 0; i < names.length; i++) {
    const r = await oauth.maybeRefreshProfile(ctx, names[i], {
      isRunning: function () {
        return false;
      },
      instances: function () {
        return [];
      },
    });
    results.push({ account: names[i], status: r.status });
    logmod.log('oauth refresh --all ' + names[i] + ': ' + r.status);
  }
  if (asJson) {
    jsonOut({ refreshed: results });
    return 0;
  }
  const glyph = {
    refreshed: style.ok('✓'),
    fresh: style.ok('✓'),
    skipped: style.dim('—'),
    'refresh-failed': style.err('✗'),
    'persist-failed': style.err('✗'),
  };
  const text = {
    refreshed: 'token was expiring — refreshed and saved (the rotated refresh token is stored)',
    fresh: 'token still valid, nothing to do',
    skipped: 'no credential stored for this account',
    'refresh-failed': 'COULD NOT REFRESH — this account needs a real login',
    'persist-failed': 'refreshed but NOT saved — the stored refresh token is now STALE, re-capture it',
  };
  results.forEach(function (r) {
    print('   ' + (glyph[r.status] || ' ') + ' ' + style.bold(r.account) + ' — ' + text[r.status]);
  });
  const bad = results.filter(function (r) {
    return r.status === 'refresh-failed' || r.status === 'persist-failed';
  });
  print('');
  print(
    bad.length
      ? style.err(bad.length + ' account(s) cannot be revived by refresh alone') +
          ' — ' +
          bad
            .map(function (b) {
              return b.account;
            })
            .join(', ') +
          '. Verify with: keyflip verify'
      : style.ok('Every stored token is alive or was refreshed.') + '  Details: keyflip verify',
  );
  return 0;
}

// `keyflip verify [account] [--usage] [--live] [--json]` — read every captured surface back the way
// its own application would, and report whether a switch to that account would actually WORK today.
// Exit codes are not proof: a successful write of a dead cookie, an expired token, or a JSON shape
// the tool refuses to parse all look like success until the app shows a sign-in screen.
async function cmdVerify(ctx, rest) {
  const asJson = rest.indexOf('--json') !== -1;
  const wantUsage = rest.indexOf('--usage') !== -1;
  const wantLive = rest.indexOf('--live') !== -1;
  const arg = rest.filter(function (a) {
    return a[0] !== '-';
  })[0];

  const all = profiles.list(ctx.configDir);
  if (!all.length) return fail('no saved accounts to verify.');
  let names = all;
  if (arg) {
    let hit = core.resolveProfile(ctx, arg);
    if (!hit)
      hit =
        all.filter(function (n) {
          return profiles.email(ctx.configDir, n) === arg || n.indexOf(arg) === 0;
        })[0] || null;
    if (!hit) return fail("no saved account '" + arg + "' — see: keyflip list");
    names = [hit];
  }

  // Which account is the machine actually on? That is the only one live checks describe.
  let liveAccount = null;
  try {
    const cur = core.currentEmail(ctx);
    all.forEach(function (n) {
      if (!liveAccount && profiles.email(ctx.configDir, n) === cur) liveAccount = n;
    });
  } catch (e) {
    liveAccount = null;
  }

  const results = await verifymod.verifyAll(ctx, {
    accounts: names,
    usage: wantUsage,
    live: wantLive,
    liveAccount: liveAccount,
    currentEmail: function (c) {
      return core.currentEmail(c);
    },
  });

  if (asJson) return print(JSON.stringify({ liveAccount: liveAccount, accounts: results }, null, 2));

  const glyph = { ok: style.ok('✓'), warn: style.warn('·'), fail: style.err('✗'), none: style.dim('—') };
  results.forEach(function (r) {
    print(
      (r.account === liveAccount ? ' → ' : '   ') +
        style.bold(r.account) +
        '  ' +
        (r.state === 'ok'
          ? style.ok(verifymod.HEADLINE.ok)
          : r.state === 'warn'
            ? style.warn(verifymod.HEADLINE.warn)
            : r.state === 'fail'
              ? style.err(verifymod.HEADLINE.fail)
              : style.dim(verifymod.HEADLINE.none)),
    );
    r.checks.forEach(function (c) {
      print('      ' + (glyph[c.state] || ' ') + ' ' + c.name + (c.detail ? ' — ' + c.detail : ''));
    });
  });
  const dead = results.filter(function (r) {
    return r.state === 'fail' || r.state === 'none';
  });
  print('');
  if (!dead.length)
    print(
      style.ok('Every listed account can be switched to.') +
        '  (' +
        results.length +
        ' checked' +
        (liveAccount ? ', live: ' + liveAccount : '') +
        ')',
    );
  else {
    print(
      style.err(dead.length + ' account(s) would NOT switch cleanly:') +
        '  ' +
        dead
          .map(function (d) {
            return d.account;
          })
          .join(', '),
    );
    print(
      style.dim(
        '  ↳ an expired stored token revives with `keyflip refresh`; a dead app cookie needs one human sign-in — do it while another account still works.',
      ),
    );
  }
  return 0;
}

async function cmdConsolidate(ctx, rest) {
  if (!ctx.appDataDir) return fail('desktop chat sync is macOS/Windows-only (no Claude Desktop data dir here).');
  const watch = rest.indexOf('--watch') !== -1;
  const ii = rest.indexOf('--interval');
  const interval = ii !== -1 ? Math.max(5, parseInt(rest[ii + 1], 10) || 30) : 30;
  const autoYes = rest.indexOf('-y') !== -1 || rest.indexOf('--yes') !== -1;

  async function syncLocked() {
    const l = await lock.acquire(ctx.configDir);
    try {
      return appsessions.consolidate(ctx);
    } finally {
      l.release();
    }
  }

  if (watch) {
    print(
      'Watching — re-syncing chats across accounts every ' +
        interval +
        's while Claude Desktop is closed. Ctrl-C to stop.',
    );
    logmod.log('consolidate --watch started (' + interval + 's)');

    for (;;) {
      try {
        if (!appctl.isClaudeRunning(ctx.platform)) {
          const c = await syncLocked();
          if (c.ok && c.merged)
            print(
              '  ' +
                style.ok('↳') +
                ' ' +
                c.merged +
                ' new session pointer(s) synced (' +
                new Date().toISOString() +
                ').',
            );
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
    if (c.ok)
      print(
        style.ok('✅') +
          ' synced ' +
          (c.merged || 0) +
          ' session pointer(s) across accounts (Recents: ' +
          (c.code || 0) +
          ', Cowork: ' +
          (c.cowork || 0) +
          ').',
      );
    else print(style.warn('·') + ' nothing to sync' + (c.reason ? ' (' + c.reason + ')' : '') + '.');
    jsonOut({ consolidated: { merged: c.merged || 0, code: c.code || 0, cowork: c.cowork || 0 } });
    return;
  }
  // App is open — its session store is locked. Offer to bounce it, else defer.
  if (appctl.canManageApp(ctx.platform) && (autoYes || process.stdin.isTTY)) {
    if (!autoYes) {
      const ok = await confirm('Claude Desktop is open — close it to sync chats, then reopen it? [y/N] ');
      if (!ok) {
        print('Deferred — re-run with the app closed.');
        return;
      }
    }
    print('Quitting Claude...');
    appctl.quitClaude(ctx.platform);
    await waitForQuit(ctx);
    const c = await syncLocked();
    print(style.ok('✅') + ' synced ' + (c.merged || 0) + ' session pointer(s) across accounts.');
    print('Reopening Claude...');
    appctl.openClaude(ctx.platform);
    jsonOut({ consolidated: { merged: c.merged || 0, bounced: true } });
    return;
  }
  return fail(
    'Claude Desktop is open — close it and re-run `keyflip consolidate` (its session store is locked while it runs).',
  );
}

function sleep(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}
async function waitForQuit(ctx, timeoutMs) {
  const deadline = timeoutMs || 20000;
  let waited = 0;
  while (appctl.isClaudeRunning(ctx.platform) && waited < deadline) {
    await sleep(500);
    waited += 500;
  }
}

// Delete ALL of keyflip's saved data: every profile secret from the credential
// store, then the whole config dir. Shared by `clean` and `uninstall --purge`.
function wipeKeyflipData(ctx) {
  const names = profiles.list(ctx.configDir);
  names.forEach(function (n) {
    try {
      ctx.store.delProfile(n);
    } catch (e) {
      /* keychain locked / already gone */
    }
  });
  try {
    fs.rmSync(ctx.configDir, { recursive: true, force: true });
  } catch (e) {
    /* ignore */
  }
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
  const napMs = function (ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  };

  // CLI: with closeApps, first terminate every running Claude Code process, then
  // clear the live credential.
  if (opts.cli) {
    if (closeApps) {
      const insts = appctl.claudeInstances(ctx.home) || [];
      let killed = 0;
      insts.forEach(function (i) {
        try {
          process.kill(i.pid, 'SIGTERM');
          killed++;
        } catch (e) {
          /* already gone */
        }
      });
      if (killed) print('  ' + style.ok('✓') + ' closed ' + killed + ' running Claude Code process(es).');
    }
    loginmod.cliLogout(ctx);
    print('  ' + style.ok('✓') + ' signed out of Claude Code (CLI).');
    out.push('cli');
  }

  // Browser: with closeApps, quit each Chromium browser first (so its Cookies DB
  // unlocks), then clear its claude.ai session — the Claude extension logs out with
  // it. Without closeApps we refuse while it runs (clearing a live DB can corrupt it).
  if (opts.browser && ctx.platform === 'darwin') {
    const browser = _browser;
    const list = browser.installed(ctx.home);
    if (!list.length) print('  ' + style.dim('· no Chromium browser to sign out.'));
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (closeApps && browser.isRunning(b)) {
        browser.quit(b, exec.run);
        for (let t = 0; t < 24 && browser.isRunning(b); t++) {
          await napMs(250);
        } // let it exit
      }
      const r = browser.clearClaudeCookies(b, { force: closeApps || !!opts.forceBrowser });
      if (r.ok) {
        print(
          '  ' +
            style.ok('✓') +
            ' ' +
            (closeApps ? 'closed ' + b.name + ' + cleared its' : 'cleared ' + b.name) +
            ' claude.ai session.',
        );
        out.push('browser:' + b.id);
      } else if (r.reason === 'browser-running')
        print('  ' + style.warn('⏭') + ' ' + b.name + ' is running — quit it, then re-run to clear its session.');
      else print('  ' + style.warn('⚠️') + ' ' + b.name + ': ' + r.reason);
    }
  }

  // Desktop app: quit it, sign it out, and — for a full close — leave it CLOSED.
  if (opts.desktop && ctx.appDataDir) {
    const wasRunning = appctl.isClaudeRunning(ctx.platform);
    if (wasRunning && appctl.canManageApp(ctx.platform)) {
      appctl.quitClaude(ctx.platform);
      await waitForQuit(ctx);
    }
    if (!appctl.isClaudeRunning(ctx.platform)) {
      const r = appauth.signOutApp(ctx);
      if (r.ok) {
        print('  ' + style.ok('✓') + ' ' + (closeApps ? 'closed and ' : '') + 'signed out of the Claude desktop app.');
        out.push('desktop');
      }
      if (!closeApps && wasRunning && appctl.canManageApp(ctx.platform)) appctl.openClaude(ctx.platform);
    } else {
      print('  ' + style.warn('⚠️') + ' Close the Claude desktop app, then re-run to sign it out.');
    }
  }
  return out;
}

// `keyflip logout [--browser] [--desktop] [--close] [-y]` — sign OUT of the LIVE session(s) while
// KEEPING every saved account (a friendlier, discoverable front door than `reset --logout`).
async function cmdLogout(ctx, rest) {
  const browser = rest.indexOf('--browser') !== -1 || rest.indexOf('--all') !== -1;
  const desktop = rest.indexOf('--desktop') !== -1 || rest.indexOf('--all') !== -1;
  const closeApps = rest.indexOf('--close') !== -1;
  const forced = rest.indexOf('-y') !== -1 || rest.indexOf('--yes') !== -1 || rest.indexOf('--force') !== -1;
  const names = ['Claude Code (CLI)']
    .concat(browser ? ['browser claude.ai'] : [])
    .concat(desktop ? ['desktop app'] : []);
  if (!forced && !JSON_MODE) {
    if (!process.stdin.isTTY) return fail('refusing to log out non-interactively — pass -y.');
    print(
      'Sign out of the live ' +
        names.join(' + ') +
        ' session(s)? Your saved keyflip accounts are KEPT — switch back anytime.',
    );
    if (!(await confirm('Continue? [y/N] '))) {
      print('Cancelled.');
      return;
    }
  }
  const out = await withLock(ctx, function () {
    return logoutSurfaces(ctx, { cli: true, browser: browser, desktop: desktop, closeApps: closeApps });
  });
  if (JSON_MODE) {
    jsonOut({ loggedOut: out });
    return;
  }
  if (!out.length) print(style.dim('Nothing live to sign out.'));
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
    const derived = uninstallmod.derivedStatePaths(ctx).filter(function (d) {
      return fs.existsSync(d.path);
    });
    const active = provider.readActive(ctx);
    const provName = active && active.name;
    if (!derived.length && !proxyUp && !provName && !logout) {
      print('Nothing to reset — keyflip is already at a clean state.');
      jsonOut({ reset: 'soft', keptAccounts: names.length });
      return;
    }
    print('Soft reset — KEEP your ' + names.length + ' account(s); clear only runtime state:');
    if (derived.length)
      print(
        '  • clear: ' +
          derived
            .map(function (d) {
              return d.name;
            })
            .join(', '),
      );
    if (proxyUp) print('  • stop the running failover proxy');
    if (provName) print('  • route Claude Code back to your subscription (was provider ' + provName + ')');
    if (logout)
      print(
        '  • sign out of the live session: CLI' +
          (ctx.platform === 'darwin' ? ' + browser' : '') +
          (noDesktop ? '' : ' + desktop'),
      );
    if (!force) {
      if (!process.stdin.isTTY) return fail('Re-run with --force to confirm the soft reset.');
      const ok = await confirm('\nProceed? [y/N] ');
      if (!ok) {
        print('Cancelled — nothing was changed.');
        return;
      }
    }
    if (proxyUp) {
      try {
        await proxy.stop(ctx);
        print('  ✓ stopped the proxy.');
      } catch (e) {
        /* ignore */
      }
    }
    if (provName) {
      try {
        provider.useOfficial(ctx);
        print('  ✓ routed Claude Code back to your subscription.');
      } catch (e) {
        /* ignore */
      }
    }
    derived.forEach(function (d) {
      try {
        fs.rmSync(d.path, { recursive: true, force: true });
      } catch (e) {
        /* ignore */
      }
    });
    if (derived.length) print('  ✓ cleared runtime state.');
    let out = [];
    if (logout)
      out = await logoutSurfaces(ctx, { cli: true, browser: true, desktop: !noDesktop, force: force, closeApps: true });
    print(
      style.ok('✅') +
        ' Soft reset complete — your ' +
        names.length +
        ' account(s) are intact.' +
        (logout ? ' Signed out of: ' + (out.join(', ') || 'nothing') + '.' : ''),
    );
    jsonOut({ reset: 'soft', keptAccounts: names.length, loggedOut: out });
    return;
  }

  // DEFAULT = FACTORY reset: delete everything keyflip saved (app stays installed).
  let appCount = 0,
    backupCount = 0;
  try {
    appCount = fs.readdirSync(path.join(ctx.configDir, 'app')).length;
  } catch (e) {
    /* none */
  }
  try {
    backupCount = fs.readdirSync(path.join(ctx.configDir, 'backups')).length;
  } catch (e) {
    /* none */
  }
  if (!names.length && !appCount && !backupCount && !logout) {
    print('Nothing to reset — keyflip has no saved data.');
    jsonOut({ reset: 'factory', wiped: false });
    return;
  }
  print(style.warn('Factory reset') + ' — DELETES all keyflip data (keyflip stays installed):');
  print(
    '  • accounts: ' +
      (names.length ? names.join(', ') : 'none') +
      '  · captured app logins: ' +
      appCount +
      '  · backups: ' +
      backupCount +
      '  · Keychain keyflip:*',
  );
  print('  • providers, usage history, proxy/breaker state, caches, logs');
  if (logout)
    print(
      '  • SIGN OUT of the live session: CLI' +
        (ctx.platform === 'darwin' ? ' + browser' : '') +
        (noDesktop ? '  (leaving the desktop app signed in)' : ' + the desktop app'),
    );
  print(
    'Not deleted: ~/.claude/projects history' +
      (logout ? '.' : '; your live Claude login stays (add --logout to sign out).'),
  );
  print(style.dim('(Keep your accounts and only clear runtime glitches instead:  keyflip reset --soft)'));

  if (!force) {
    if (!process.stdin.isTTY)
      return fail(
        'Re-run with --force to confirm the factory reset — this DELETES your saved accounts (or use --soft to keep them).',
      );
    const ok = await confirm('\nDelete all keyflip data? [y/N] ');
    if (!ok) {
      print('Cancelled — nothing was changed.');
      return;
    }
  }
  if (proxyUp) {
    try {
      await proxy.stop(ctx);
      print('  ✓ stopped the proxy.');
    } catch (e) {
      /* ignore */
    }
  }
  const n = wipeKeyflipData(ctx);
  // Also sweep keyflip's stray artifacts OUTSIDE configDir (browser Cookies backups).
  if (ctx.platform === 'darwin') {
    try {
      const browser = _browser;
      browser.installed(ctx.home).forEach(function (b) {
        try {
          fs.rmSync(b.cookies + '.keyflip-bak', { force: true });
        } catch (e) {
          /* none */
        }
      });
    } catch (e) {
      /* best-effort */
    }
  }
  print('  ✓ deleted all keyflip data (' + n + ' account(s)) and swept stray backups.');
  let out = [];
  if (logout)
    out = await logoutSurfaces(ctx, { cli: true, browser: true, desktop: !noDesktop, force: force, closeApps: true });
  print(
    style.ok('✅') +
      ' Factory reset complete.' +
      (logout ? ' Signed out of: ' + (out.join(', ') || 'nothing') + '.' : ''),
  );
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
  let real = binPath;
  try {
    real = fs.realpathSync(binPath);
  } catch (e) {
    /* keep */
  }
  const method = uninstallmod.classifyInstall(real, ctx.platform);
  const plan = uninstallmod.planUninstall({ method: method, home: ctx.home, platform: ctx.platform });
  const names = profiles.list(ctx.configDir);

  print('Uninstall keyflip from this machine:');
  if (method === 'dev') {
    print(
      '  • running from a source checkout (' + path.dirname(path.dirname(real)) + ') — that folder is left untouched',
    );
  } else if (method === 'npm') {
    print('  • ' + plan.npm.cmd + ' ' + plan.npm.args.join(' '));
  } else {
    plan.files.forEach(function (f) {
      print('  • remove ' + f.label + ': ' + f.path);
    });
  }
  if (purge) {
    print('  • PURGE keyflip data: ' + names.length + ' account(s), providers, backups, Keychain keyflip:*');
  } else {
    print('  • keep saved keyflip data (accounts/providers/backups) — add --purge to delete it too');
  }
  print('Not touched: your Claude login (run `keyflip reset --logout` first to sign out), ~/.claude/projects.');
  if (method === 'dev' && !purge) {
    print('\nNothing to do (source checkout, no --purge).');
    jsonOut({ uninstalled: false, method: method, purged: false });
    return;
  }

  if (!force) {
    if (!process.stdin.isTTY) return fail('Re-run with --force to confirm the uninstall.');
    const ok = await confirm('\nProceed? [y/N] ');
    if (!ok) {
      print('Cancelled — nothing was changed.');
      return;
    }
  }

  // Data first, so it still succeeds even if removing our own files fails midway.
  if (purge) {
    const n = wipeKeyflipData(ctx);
    print('  ✓ purged keyflip data (' + n + ' account(s)).');
  }

  if (method === 'npm') {
    const r = _child_process.spawnSync(plan.npm.cmd, plan.npm.args, { stdio: 'inherit' });
    if (r.error || r.status !== 0)
      print(
        style.warn(
          '⚠️ could not auto-remove the npm package — run it yourself: ' + plan.npm.cmd + ' ' + plan.npm.args.join(' '),
        ),
      );
    else print('  ✓ removed the npm global package.');
  } else if (method !== 'dev') {
    const failed = [];
    plan.files.forEach(function (f) {
      try {
        fs.rmSync(f.path, { recursive: true, force: true });
      } catch (e) {
        failed.push(f.path);
      }
    });
    if (failed.length) print(style.warn('⚠️ could not remove (delete manually): ' + failed.join(', ')));
    else print('  ✓ removed keyflip program files' + (ctx.platform === 'darwin' ? ' and launcher app' : '') + '.');
    if (plan.pathNote) print('  • ' + plan.pathNote);
  }

  print(
    style.ok('✅') + ' keyflip uninstalled.' + (purge ? '' : ' (Saved data kept — re-run with --purge to remove it.)'),
  );
  jsonOut({ uninstalled: true, method: method, purged: purge });
}

async function cmdList(ctx, rest) {
  const list = core.listProfiles(ctx);
  // One detection pass → the saved profile the app is on (by org), plus a fallback
  // label so an UNSAVED signed-in account still shows an email/org, not "unknown".
  let appActive = null,
    appDet = null;
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
  const appFallbackLabel = appActive
    ? null
    : appDet && (appDet.email || (appDet.org ? appDet.org.slice(0, 8) + '… (unsaved)' : null));
  // "app ✓" below means a RESTORABLE capture exists. This is the other question: is the
  // app itself signed in right now? (It needs its session cookie to re-mint the token
  // cache at launch, so a capture can be perfect and the app still show sign-in.)
  let liveApp = null;
  if (ctx.appDataDir) {
    try {
      liveApp = appauth.liveAppSession(ctx, {});
    } catch (e) {
      liveApp = null;
    }
  }
  const withUsage = (rest || []).indexOf('--usage') !== -1;
  let infos = null;
  if (withUsage && list.length) {
    const activeEntry = list.filter(function (e) {
      return e.active;
    })[0];
    infos = await usagemod.usageForProfiles(
      ctx,
      list.map(function (e) {
        return e.name;
      }),
      { liveFor: activeEntry ? activeEntry.name : null, recordHistory: true },
    );
  }
  // Which account is each browser's claude.ai session on? The Claude Chrome
  // extension inherits that session, so this is the "browser (extension)" surface.
  // Best-effort, macOS only.
  const browserOrgs = {}; // org uuid -> [browser names]
  let browsersPresent = 0;
  if (ctx.platform === 'darwin') {
    try {
      const browser = _browser;
      const inst = browser.installed(ctx.home);
      browsersPresent = inst.length;
      inst.forEach(function (b) {
        const ck = browser.readClaudeCookies(b, {});
        if (ck && ck.org) {
          (browserOrgs[ck.org] = browserOrgs[ck.org] || []).push(b.name);
        }
      });
    } catch (e) {
      /* best-effort */
    }
  }
  function browserFor(name) {
    const m = profiles.read(ctx.configDir, name) || {};
    const org = m.oauthAccount && m.oauthAccount.organizationUuid;
    return org && browserOrgs[org] ? browserOrgs[org] : null;
  }

  if (JSON_MODE) {
    jsonOut({
      accounts: list.map(function (e) {
        const web = browserFor(e.name);
        return {
          index: e.index,
          name: e.name,
          email: e.email || null,
          cliCaptured: capturedCliSafe(ctx, e.name),
          appCaptured: appauth.hasProfile(ctx, e.name),
          browserSignedIn: !!web,
          browsers: web || undefined,
          activeCli: !!e.active,
          activeApp: e.name === appActive,
          usage: infos ? (infos[e.name] && infos[e.name].usage) || null : undefined,
          usageStatus: infos ? (infos[e.name] && infos[e.name].status) || null : undefined,
        };
      }),
      activeCli: core.currentEmail(ctx) || null,
      activeApp: appActive ? profiles.email(ctx.configDir, appActive) || appActive : null,
      appSessionLive: liveApp ? !!liveApp.signedIn : null,
      appSessionExpires: liveApp && liveApp.expiresAt ? liveApp.expiresAt : null,
    });
    return;
  }
  print('Saved accounts (' + ctx.configDir + '):');
  if (!list.length) {
    print("  (none yet — log in in Claude, then run 'keyflip add')");
  } else {
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
        usageCol = '   [' + (info.status === 'ok' ? usagemod.fmt(info.usage) : info.status || '?') + ']';
      }
      print(
        ' ' +
          (now.length ? '→' : ' ') +
          ' [' +
          e.index +
          '] ' +
          (e.email || e.name) +
          '   [cli ' +
          (cli === null ? '?' : cli ? '✓' : '—') +
          ' | app ' +
          (app ? '✓' : '—') +
          (anyBrowser ? ' | web ' + (web ? '✓' : '—') : '') +
          ']' +
          usageCol +
          (now.length ? '   ← active: ' + now.join(' + ') : ''),
      );
    });
  }
  print('');
  print(
    'Active — Claude Code: ' +
      (core.currentEmail(ctx) || 'not logged in') +
      (ctx.appDataDir
        ? '   ·   desktop app: ' +
          (appActive ? profiles.email(ctx.configDir, appActive) || appActive : appFallbackLabel || 'unknown') +
          (liveApp && !liveApp.signedIn
            ? style.dim('  (signed out on disk — it will open on its sign-in screen; see `keyflip doctor`)')
            : '')
        : ''),
  );
  if (browsersPresent > 0) {
    const orgs = Object.keys(browserOrgs);
    if (!orgs.length) {
      print('Browser (Claude extension): ' + style.dim('signed out of claude.ai'));
    } else {
      const orgLabel = function (o) {
        let lbl = o.slice(0, 8) + '…';
        profiles.list(ctx.configDir).forEach(function (n) {
          const m = profiles.read(ctx.configDir, n);
          if (m && m.oauthAccount && m.oauthAccount.organizationUuid === o) lbl = m.email || n;
        });
        return lbl;
      };
      const labels = orgs.map(function (o) {
        return orgLabel(o) + ' (' + browserOrgs[o].join(', ') + ')';
      });
      const activeEntry = list.filter(function (e) {
        return e.active;
      })[0];
      const activeOrg = activeEntry
        ? ((profiles.read(ctx.configDir, activeEntry.name) || {}).oauthAccount || {}).organizationUuid
        : null;
      const mismatch = activeOrg && orgs.indexOf(activeOrg) === -1;
      print(
        'Browser (Claude extension): ' +
          labels.join('; ') +
          (mismatch
            ? '   ' +
              style.warn(
                '⚠ differs from the active account — the extension may not connect (fix: keyflip browser logout)',
              )
            : ''),
      );
    }
  }
}

// H3: git-backed versioning of keyflip's config/state (never secrets). history/undo/restore.
async function cmdVersion(ctx, rest) {
  const vcs = _vcs;
  const sub = rest[0];
  if (sub === 'on' || sub === 'enable') {
    const ok = vcs.enable(ctx);
    print(
      ok
        ? style.ok('✅') +
            ' versioning ON — every change is committed to ' +
            ctx.configDir +
            '/.git (secrets excluded).'
        : style.warn('·') + ' could not enable versioning (is git installed?).',
    );
    return;
  }
  if (sub === 'off' || sub === 'disable') {
    vcs.disable(ctx);
    print(style.ok('✅') + ' versioning OFF (history kept; re-enable: keyflip versioning on).');
    return;
  }
  const enabled = vcs.isEnabled(ctx),
    repo = vcs.isRepo(ctx);
  if (JSON_MODE) {
    jsonOut({ versioning: { enabled: enabled, repo: repo, git: vcs.gitAvailable() } });
    return;
  }
  print(
    'Versioning: ' +
      (enabled ? style.ok('on') : style.warn('off')) +
      (repo ? '   (' + ctx.configDir + '/.git)' : vcs.gitAvailable() ? '' : '   (git not installed)'),
  );
  const hist = vcs.log(ctx, 8);
  if (hist.length) {
    print('Recent changes:');
    hist.forEach(function (h) {
      print('  ' + h.ref + '  ' + h.date.slice(0, 16).replace('T', ' ') + '  ' + h.subject.replace(/^keyflip: /, ''));
    });
    print(
      '\nUndo the last: ' +
        style.bold('keyflip undo') +
        '   ·   restore a point: ' +
        style.bold('keyflip restore <ref>'),
    );
  } else if (repo) print('  (no changes recorded yet)');
}

function cmdHistory(ctx, rest) {
  const vcs = _vcs;
  const n = parseInt(rest[0], 10) || 20;
  const hist = vcs.log(ctx, n);
  if (JSON_MODE) {
    jsonOut({ history: hist });
    return;
  }
  if (!hist.length) {
    print(vcs.isRepo(ctx) ? 'No changes recorded yet.' : 'Versioning is not set up yet (keyflip versioning on).');
    return;
  }
  hist.forEach(function (h) {
    print('  ' + h.ref + '  ' + h.date.slice(0, 16).replace('T', ' ') + '  ' + h.subject.replace(/^keyflip: /, ''));
  });
  print(
    '\nUndo the last: ' + style.bold('keyflip undo') + '   ·   restore a point: ' + style.bold('keyflip restore <ref>'),
  );
}

function cmdUndo(ctx) {
  const r = _vcs.undo(ctx);
  if (!r.ok)
    return fail(
      'cannot undo: ' + (r.reason === 'nothing-to-undo' ? 'no earlier state recorded' : r.reason || 'unknown'),
    );
  print(style.ok('✅') + ' undid the last change (a revert was recorded — see keyflip history).');
  jsonOut({ undone: true });
}

function cmdRestore(ctx, rest) {
  const ref = rest[0];
  if (!ref) return fail('usage: keyflip restore <ref>   (list refs with: keyflip history)');
  const r = _vcs.restore(ctx, ref);
  if (!r.ok)
    return fail('restore failed: ' + (r.reason || 'unknown') + (r.detail ? ' (' + String(r.detail).trim() + ')' : ''));
  print(style.ok('✅') + ' restored keyflip state to ' + ref + '.');
  jsonOut({ restored: ref });
}

/**
 * Main CLI entry point: parses arguments and dispatches to the appropriate command handler.
 * @param {string[]} argv - Command-line arguments (without node and script path).
 * @returns {Promise<void>}
 */
async function main(argv) {
  // Global flags, valid anywhere on the line.
  JSON_MODE = argv.indexOf('--json') !== -1;
  const debug = argv.indexOf('--debug') !== -1;
  argv = argv.filter(function (a) {
    return a !== '--json' && a !== '--debug';
  });

  const cmd = argv[0];
  const rest = argv.slice(1);
  const ctx = createContext();
  // Honor config ui.color=false (hard-disable color, like NO_COLOR). Re-made here because ctx —
  // and thus config — isn't available when the module-level `style` is first created. Only disables.
  try {
    if (_cfg.get(ctx, 'ui.color') === false) style = _styleModule.make(process.stdout, { color: false });
  } catch (e) {
    /* keep the default style */
  }
  logmod.init(ctx.configDir, debug);
  // H3: a descriptive label for the auto-version commit (argv holds no secrets by rule).
  ctx._vcsLabel =
    [cmd]
      .concat(
        rest
          .filter(function (a) {
            return a && a[0] !== '-';
          })
          .slice(0, 2),
      )
      .join(' ') || 'update';
  try {
    _migrations.runMigrations(ctx);
  } catch (e) {
    /* never blocks startup */
  }
  try {
    await dispatch(ctx, cmd, rest);
  } catch (e) {
    fail(e && e.message ? e.message : String(e));
  }
  // Passive update notice — after the command; never for --json/menu/upgrade/clean.
  // Skip the passive update fetch for machine/interactive/long-lived commands: it
  // would corrupt the MCP stdio stream, delay `run`/`mcp` exit on a slow network,
  // or print a stray line during a destructive/JSON op.
  const NO_NOTICE = [
    'menu',
    'menubar',
    'upgrade',
    'reset',
    'uninstall',
    'setup',
    'onboard',
    'login',
    'mcp',
    'run',
    'autoswitch',
    'install-skill',
    'statusline',
    'send',
    'panel',
    'agents',
    'foreign',
    'fleet',
    'swarm',
    'ui',
  ];
  const skipNotice = JSON_MODE || cmd === undefined || NO_NOTICE.indexOf(cmd) !== -1;
  if (!skipNotice) {
    try {
      await update.maybeNotify(ctx, VERSION);
    } catch (e) {
      /* ignore */
    }
  }
}

async function dispatch(ctx, cmd, rest) {
  // Paywall gate (a NO-OP unless KEYFLIP_LICENSING is enabled) — one central check maps the command to
  // its tier and blocks it with a clear upgrade message when the license is insufficient.
  try {
    _lic.requireForName(ctx, cmd);
  } catch (e) {
    if (e && e.code === 'LICENSE_REQUIRED') return fail(e.message);
    throw e;
  }
  {
    switch (cmd) {
      case undefined:
        if (!process.stdin.isTTY) {
          usage();
          return;
        }
        return _menu.runMenu(ctx);
      case 'menu': // hidden: used by the launcher app; same as bare `keyflip`
        return _menu.runMenu(ctx);
      case 'add':
        return withLock(ctx, function () {
          return cmdAdd(ctx, rest);
        });
      case 'setup':
        return withLock(ctx, function () {
          return cmdSetup(ctx, rest);
        });
      case 'onboard':
        return withLock(ctx, function () {
          return cmdOnboard(ctx, rest);
        });
      case 'login':
        return withLock(ctx, function () {
          return cmdLogin(ctx, rest);
        });
      case 'logout':
        return cmdLogout(ctx, rest);
      case 'list':
        return cmdList(ctx, rest);
      case 'status':
        return cmdStatus(ctx);
      case 'next':
        return withLock(ctx, function () {
          return cmdNext(ctx, rest);
        });
      case 'remove':
        return withLock(ctx, async function () {
          const n = core.resolveProfile(ctx, rest[0]);
          if (!n) return fail("no such account: '" + (rest[0] || '') + "'");
          // Never yank the account live Claude sessions are using out from under them.
          const em = profiles.email(ctx.configDir, n);
          if (em && em === core.currentEmail(ctx) && rest.indexOf('--force') === -1) {
            const live = appctl.claudeInstances(ctx.home);
            if (live.length) {
              return fail(
                "'" +
                  em +
                  "' is the account " +
                  live.length +
                  ' running Claude session(s) are using ' +
                  '(pid ' +
                  live
                    .map(function (i) {
                      return i.pid;
                    })
                    .join(', ') +
                  ') — close them first, or pass --force.',
              );
            }
          }
          // Deleting a credential is IRREVERSIBLE — confirm unless forced. Non-interactive without a
          // flag fails closed rather than silently destroying an account.
          const forced = rest.indexOf('--force') !== -1 || rest.indexOf('-y') !== -1 || rest.indexOf('--yes') !== -1;
          if (!forced && !JSON_MODE) {
            if (!process.stdin.isTTY)
              return fail(
                "refusing to delete '" +
                  n +
                  "'" +
                  (em ? ' (' + em + ')' : '') +
                  ' non-interactively — pass --force to confirm.',
              );
            if (
              !(await confirm(
                'Delete account ' +
                  style.bold(n) +
                  (em ? ' (' + em + ')' : '') +
                  '? Its saved credential is removed for good. [y/N] ',
              ))
            ) {
              print('Cancelled.');
              return;
            }
          }
          core.removeProfile(ctx, n);
          logmod.log('removed profile ' + n);
          print('🗑  removed: ' + n);
        });
      case 'provider':
        return cmdProvider(ctx, rest);
      case 'use':
        return withLock(
          ctx,
          function () {
            return cmdProviderUse(ctx, rest[0]);
          },
          'provider',
        );
      case 'speedtest':
        return cmdSpeedtest(ctx, rest);
      case 'doctor':
        return cmdDoctor(ctx, rest);
      case 'scrub-history':
        return cmdScrubHistory(ctx, rest);
      case 'secrets':
        // Reading the findings is read-only; writing a rule mutates versioned state, so it takes the
        // mutex and H3 commits the policy file right after (paths + kinds only, never a value).
        return ['tolerate', 'untolerate'].indexOf(rest[0]) !== -1
          ? withLock(
              ctx,
              function () {
                return cmdSecrets(ctx, rest);
              },
              'secrets',
            )
          : cmdSecrets(ctx, rest);
      case 'chains':
        return cmdChains(ctx, rest);
      case 'test':
        return cmdTest(ctx, rest);
      case 'usage':
        return cmdUsage(ctx, rest);
      case 'backup':
        return withLock(ctx, function () {
          return cmdBackup(ctx, rest);
        });
      case 'share':
        return cmdShare(ctx, rest);
      case 'mcpreg':
        return withLock(ctx, function () {
          return cmdMcpreg(ctx, rest);
        });
      case 'gateway':
        return withLock(
          ctx,
          function () {
            return cmdGateway(ctx, rest);
          },
          'claude-desktop',
        );
      case 'sync':
        return cmdSync(ctx, rest);
      case 'group':
      case 'groups':
        return rest[0] === 'tag' || rest[0] === 'untag'
          ? withLock(ctx, function () {
              return cmdGroup(ctx, rest);
            })
          : cmdGroup(ctx, rest);
      case 'budget':
        return rest[0] === 'set' || rest[0] === 'clear'
          ? withLock(ctx, function () {
              return cmdBudget(ctx, rest);
            })
          : cmdBudget(ctx, rest);
      case 'llm':
        // `set`/`off` write config.json; `status`/`test` do not.
        return rest[0] === 'set' || rest[0] === 'off' || rest[0] === 'reset'
          ? withLock(ctx, function () {
              return cmdLlm(ctx, rest);
            })
          : cmdLlm(ctx, rest);
      case 'import-env':
        return withLock(ctx, function () {
          return cmdImportEnv(ctx, rest);
        });
      case 'shell-init':
        return cmdShellInit(rest);
      case 'notify':
        return rest[0] === 'set' || rest[0] === 'off'
          ? withLock(ctx, function () {
              return cmdNotify(ctx, rest);
            })
          : cmdNotify(ctx, rest);
      case 'run-job':
        return cmdRunJob(ctx, rest);
      case 'jobs':
        return rest[0] === 'clear'
          ? withLock(ctx, function () {
              return cmdJobs(ctx, rest);
            })
          : cmdJobs(ctx, rest);
      case 'fanout':
      case 'fan-out':
        return cmdFanout(ctx, rest);
      case 'cost':
        return cmdCost(ctx, rest);
      case 'team':
        return cmdTeam(ctx, rest);
      case 'policy':
        return ['allow', 'deny', 'remove', 'rm', 'default'].indexOf(rest[0]) !== -1
          ? withLock(ctx, function () {
              return cmdPolicy(ctx, rest);
            })
          : cmdPolicy(ctx, rest);
      case 'vault':
        return rest[0] === 'use' || rest[0] === 'off'
          ? withLock(ctx, function () {
              return cmdVault(ctx, rest);
            })
          : cmdVault(ctx, rest);
      case 'post':
        return cmdPost(ctx, rest);
      case 'route':
        return rest[0] === 'set' || rest[0] === 'clear' || rest[0] === 'arbitrage'
          ? withLock(ctx, function () {
              return cmdRoute(ctx, rest);
            })
          : cmdRoute(ctx, rest);
      case 'cache':
        return rest[0] === 'purge'
          ? withLock(ctx, function () {
              return cmdCache(ctx, rest);
            })
          : cmdCache(ctx, rest);
      case 'swarm':
        return rest[0] === 'drain' || rest[0] === 'trust' || rest[0] === 'untrust'
          ? withLock(ctx, function () {
              return cmdSwarm(ctx, rest);
            })
          : cmdSwarm(ctx, rest);
      case 'license':
        return rest[0] === 'activate' || rest[0] === 'deactivate'
          ? withLock(ctx, function () {
              return cmdLicense(ctx, rest);
            })
          : cmdLicense(ctx, rest);
      case 'config':
        return rest[0] === 'set' || rest[0] === 'unset'
          ? withLock(
              ctx,
              function () {
                return cmdConfig(ctx, rest);
              },
              'config',
            )
          : cmdConfig(ctx, rest);
      case 'ui':
        return cmdUi(ctx, rest);
      case 'surfaces':
        return cmdSurfaces(ctx, rest);
      case 'codexbar':
        return cmdCodexbar(ctx, rest);
      case 'brain':
        return cmdBrain(ctx, rest);
      case 'versioning':
        return cmdVersion(ctx, rest);
      case 'history':
        return cmdHistory(ctx, rest);
      case 'log':
      case 'auditlog':
        return cmdAuditLog(ctx, rest);
      case 'undo':
        return withLock(
          ctx,
          function () {
            return cmdUndo(ctx);
          },
          'undo',
        );
      case 'restore':
        return withLock(
          ctx,
          function () {
            return cmdRestore(ctx, rest);
          },
          'restore',
        );
      case 'consolidate':
        return cmdConsolidate(ctx, rest);
      case 'refresh':
        return cmdRefresh(ctx, rest);
      case 'verify':
        return cmdVerify(ctx, rest);
      case 'memory':
        return rest[0] === 'remove' || rest[0] === 'rm'
          ? withLock(ctx, function () {
              return cmdMemory(ctx, rest);
            })
          : cmdMemory(ctx, rest);
      case 'dream':
        return cmdDream(ctx, rest);
      case 'recall':
        return cmdRecall(ctx, rest);
      case 'settings':
        return rest[0] === 'set' || rest[0] === 'unset'
          ? withLock(
              ctx,
              function () {
                return cmdSettings(ctx, rest);
              },
              'claude-settings',
            )
          : cmdSettings(ctx, rest);
      case 'statusline':
        return rest[0] === 'install' || rest[0] === 'uninstall' || rest[0] === 'remove'
          ? withLock(
              ctx,
              function () {
                return cmdStatusline(ctx, rest);
              },
              'claude-settings',
            )
          : cmdStatusline(ctx, rest);
      case 'panel':
        return cmdPanel(ctx, rest);
      case 'menubar':
        return cmdMenubar(ctx, rest);
      case 'foreign':
        return cmdForeign(ctx, rest);
      // ---- Wave 4: Context Layer (portable project memory in .keyflip/) ----
      case 'context':
      case 'ctx':
        // `.keyflip/` is project-dir state (not configDir). `context sync mode` is the one
        // mutation that touches configDir-independent files; cmdContext takes no configDir lock.
        return cmdContext(ctx, rest);
      case 'rules':
        return rest[0] === 'import' || (rest[0] === 'emit' && rest.indexOf('--write') !== -1)
          ? withLock(ctx, function () {
              return cmdRules(ctx, rest);
            })
          : cmdRules(ctx, rest);
      case 'checkpoint':
      case 'checkpoints':
        return rest[0] === 'create' || rest[0] === 'save'
          ? withLock(ctx, function () {
              return cmdCheckpoint(ctx, rest);
            })
          : cmdCheckpoint(ctx, rest);
      case 'handoff':
        return cmdHandoff(ctx, rest);
      case 'fleet':
        return rest[0] === 'push' || rest[0] === 'collect'
          ? withLock(ctx, function () {
              return cmdFleet(ctx, rest);
            })
          : cmdFleet(ctx, rest);
      case 'sessions':
        return cmdSessions(ctx, rest);
      case 'threads':
        // Browsing a thread is read-only; naming one, linking one, or writing its mirror takes the
        // mutex, so a thread file can never be half-written by a racing switch — and H3 versions the
        // pointer change right after (the mirror itself is git-ignored, so nothing but metadata lands).
        return ['create', 'add', 'remove', 'rm', 'drop', 'delete', 'mirror', 'unmirror'].indexOf(rest[0]) !== -1
          ? withLock(ctx, function () {
              return cmdThreads(ctx, rest);
            })
          : cmdThreads(ctx, rest);
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
        return withLock(ctx, function () {
          return cmdImport(ctx, rest);
        });
      case 'migrate':
        // `import` locks the whole (fast) file-read+apply; `pull` locks only its write
        // internally so the network fetch + confirm prompt don't hold the mutex.
        return rest[0] === 'import'
          ? withLock(ctx, function () {
              return cmdMigrate(ctx, rest);
            })
          : cmdMigrate(ctx, rest);
      case 'transfer':
        return cmdTransfer(ctx, rest); // `pull` locks only its write internally
      case 'agents':
        return cmdAgents(ctx, rest);
      case 'upgrade':
        return cmdUpgrade(ctx);
      case 'reset':
        return withLock(ctx, function () {
          return cmdReset(ctx, rest);
        });
      case 'uninstall':
        return withLock(ctx, function () {
          return cmdUninstall(ctx, rest);
        });
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
        if (core.resolveProfile(ctx, cmd))
          return withLock(ctx, function () {
            return cmdSwitch(ctx, [cmd].concat(rest));
          });
        process.stderr.write("keyflip: unknown command or account '" + cmd + "'\n\n");
        usage();
        process.exitCode = 1;
        return;
      }
    }
  }
}

export {
  main,
  usage,
  positionals,
  onboardProvider,
  desktopTugRisk,
  appActiveProfile,
  preserveOutgoingAppLogin,
  browserCapture,
  verifyAppRelogin,
};
