// commands.js — a machine-readable CATALOG of the keyflip CLI surface.
//
// One entry per user-facing command, derived from src/cli.js: the printed help
// lines in usage() and every `case` in the dispatch() switch. A TUI command
// PALETTE consumes this so commands are searchable instead of memorized.
//
// This module is PURE DATA + pure functions — it reads no files, no env, no
// home dir, and never touches (or stores) a secret. That makes it hermetic by
// construction: tests can require it with zero setup. Hidden/internal dispatch
// cases (`menu`, `__proxy-serve`) are intentionally excluded; the bare
// `keyflip <name|number>` account switch is surfaced as the synthetic entry
// "switch".
//
// Entry shape:
//   { name, group, usage, desc, aliases?, safe }
//   safe === true ONLY for read-only / no-arg commands that are safe to run
//   directly from a menu (status, list, usage, doctor, surfaces, sessions, ui…).
//   Anything mutating or requiring args is safe: false.

// Ordered group list. Every entry.group MUST be one of these.
const GROUPS = [
  'accounts',
  'providers',
  'sessions',
  'context',
  'transfer',
  'fleet',
  'orchestration',
  'cost',
  'policy',
  'config',
  'ui',
  'agents',
  'maintenance',
];

const CATALOG = [
  // ---- accounts ----
  {
    name: 'add',
    group: 'accounts',
    safe: false,
    usage: 'keyflip add [name] [--app] [--token <file|->]',
    desc: "Save the account(s) you're logged into — Claude Code and the desktop app.",
  },
  {
    name: 'setup',
    group: 'accounts',
    safe: false,
    usage: 'keyflip setup',
    desc: 'Lighter wizard: log in in Claude and auto-detect/capture each account.',
  },
  {
    name: 'onboard',
    group: 'accounts',
    safe: false,
    usage: 'keyflip onboard [--manual] [--sso] [--console]',
    desc: 'Full first-run: sign in per account, capture, point CLI+browser at it, sync chats.',
  },
  {
    name: 'login',
    group: 'accounts',
    safe: false,
    usage: 'keyflip login [name] [--email x] [--fresh|--manual] [--sso] [--console]',
    desc: 'Sign in via the official flow and capture it (isolated; current login untouched).',
  },
  {
    name: 'logout',
    group: 'accounts',
    safe: false,
    usage: 'keyflip logout [--browser] [--desktop] [--close]',
    desc: 'Sign out of the live session(s); saved accounts are kept.',
  },
  {
    name: 'list',
    group: 'accounts',
    safe: true,
    usage: 'keyflip list [--usage]',
    desc: 'List saved accounts; --usage adds 5h/7d quota per account.',
  },
  {
    name: 'status',
    group: 'accounts',
    safe: true,
    usage: 'keyflip status',
    desc: 'Show which account each surface is on (CLI + desktop app).',
  },
  {
    name: 'switch',
    group: 'accounts',
    safe: false,
    usage: 'keyflip <name|number> [--restart|--force] [--browser]',
    desc: 'Switch to that account (aligns CLI + desktop, optionally the browser).',
  },
  {
    name: 'next',
    group: 'accounts',
    safe: false,
    usage: 'keyflip next [--strategy best|next-available] [--group <g>]',
    desc: 'Rotate to the next account — or pick by remaining quota.',
  },
  {
    name: 'remove',
    group: 'accounts',
    safe: false,
    usage: 'keyflip remove <name|number> [--force]',
    desc: 'Delete a saved account (its credential is removed for good).',
  },
  {
    name: 'browser',
    group: 'accounts',
    safe: false,
    usage: 'keyflip browser [status|logout|sync]',
    desc: 'Check/reset/restore the browser claude.ai account so the Chrome extension connects.',
  },

  // ---- providers ----
  {
    name: 'provider',
    group: 'providers',
    safe: false,
    usage: 'keyflip provider add <name> --base-url <url> [--key-file <f|->] | list | off',
    desc: 'Manage 3rd-party endpoints (relay/gateway/Bedrock/OpenRouter).',
  },
  {
    name: 'use',
    group: 'providers',
    safe: false,
    usage: 'keyflip use <name>',
    desc: 'Route Claude Code to that provider (no restart); provider off returns to your subscription.',
  },
  {
    name: 'gateway',
    group: 'providers',
    safe: false,
    usage: 'keyflip gateway use <provider> | off',
    desc: 'Route the Claude desktop app through a provider gateway.',
  },
  {
    name: 'speedtest',
    group: 'providers',
    safe: false,
    usage: 'keyflip speedtest [name]',
    desc: "Time a provider's endpoints and pick the fastest.",
  },
  {
    name: 'test',
    group: 'providers',
    safe: false,
    usage: 'keyflip test <provider>',
    desc: "Fire one real request to check a provider's auth.",
  },
  {
    name: 'import-env',
    group: 'providers',
    safe: false,
    usage: 'keyflip import-env [<file>] [--dry-run] [--env]',
    desc: 'Import provider endpoints from a .env file or the environment.',
  },

  // ---- sessions ----
  {
    name: 'sessions',
    group: 'sessions',
    safe: true,
    usage: 'keyflip sessions [--search T] [--here] | rebind | archive | export | assign | distill | compact',
    desc: 'Browse Claude Code conversations across all accounts.',
  },
  {
    name: 'resume',
    group: 'sessions',
    safe: false,
    usage: 'keyflip resume <n|id> [--run] [--as <account>]',
    desc: 'Resume a session in its dir; --as runs it under another account.',
  },
  {
    name: 'send',
    group: 'sessions',
    safe: false,
    usage: 'keyflip send <id> "<message>" [--as <account>] [--fork]',
    desc: 'Inject a message into a session to steer/continue it headlessly.',
  },
  {
    name: 'cowork',
    group: 'sessions',
    safe: true,
    usage: 'keyflip cowork [--search T]',
    desc: 'Browse Claude desktop Cowork sessions across all accounts.',
  },
  {
    name: 'chat',
    group: 'sessions',
    safe: true,
    usage: 'keyflip chat [--limit N | get <id>]',
    desc: 'Read claude.ai Chat of the active account (experimental).',
  },
  {
    name: 'consolidate',
    group: 'sessions',
    safe: false,
    usage: 'keyflip consolidate [--watch]',
    desc: "Sync every account's chat index so each shows all conversations.",
  },
  {
    name: 'dream',
    group: 'sessions',
    safe: false,
    usage: 'keyflip dream [--older-than 30d] [--archive] [--apply] | schedule',
    desc: 'Consolidate old chats: distill (and optionally archive) them.',
  },
  {
    name: 'recall',
    group: 'sessions',
    safe: false,
    usage: 'keyflip recall "<query>" [--semantic] [--answer]',
    desc: 'Search your chats (BM25; --semantic embeddings; --answer synthesis).',
  },
  {
    name: 'foreign',
    group: 'sessions',
    safe: false,
    usage: 'keyflip foreign --list | <session-file> [--format md|html|json]',
    desc: "Find/normalize another agent's session (Cursor/opencode/Gemini/Aider).",
  },

  // ---- context (portable project memory in .keyflip/) ----
  {
    name: 'context',
    group: 'context',
    safe: true,
    aliases: ['ctx'],
    usage: 'keyflip context <init|status|show|decision add|task add|task set <id> <status>|sync ...>',
    desc: 'Tool-independent project memory that travels with the repo.',
  },
  {
    name: 'rules',
    group: 'context',
    safe: false,
    usage: 'keyflip rules <show|import|emit --to claude|cursor|agents|gemini [--write]>',
    desc: "Normalize this project's AI rule files into one model and re-emit per tool.",
  },
  {
    name: 'checkpoint',
    group: 'context',
    safe: true,
    aliases: ['checkpoints'],
    usage: 'keyflip checkpoint <list|create --summary "…"|latest|show <id>>',
    desc: 'Git-bound session-boundary snapshots.',
  },
  {
    name: 'handoff',
    group: 'context',
    safe: true,
    usage: 'keyflip handoff [--to <claude|cursor|kiro|opencode|windsurf|generic>]',
    desc: 'Print a continue-prompt so a new tool can resume this project.',
  },
  {
    name: 'memory',
    group: 'context',
    safe: true,
    usage: 'keyflip memory [show <key>]',
    desc: "Browse keyflip's distilled keepsakes (its own memory store).",
  },

  // ---- transfer ----
  {
    name: 'share',
    group: 'transfer',
    safe: false,
    usage: 'keyflip share <name> [--no-secrets]',
    desc: 'Make a keyflip:// link; import it with keyflip import.',
  },
  {
    name: 'sync',
    group: 'transfer',
    safe: false,
    usage: 'keyflip sync [push|pull|test] --url <webdav> --passphrase-file <f>',
    desc: 'Encrypted cross-device sync.',
  },
  {
    name: 'export',
    group: 'transfer',
    safe: false,
    usage: 'keyflip export [file|-]',
    desc: 'Back up saved accounts to a file (contains secrets).',
  },
  {
    name: 'import',
    group: 'transfer',
    safe: false,
    usage: 'keyflip import <file|->',
    desc: 'Restore accounts from an export (--force overwrites).',
  },
  {
    name: 'migrate',
    group: 'transfer',
    safe: false,
    usage: 'keyflip migrate export/import <file> [--passphrase-file <f>] [--agents] [--agent-config]',
    desc: 'Move all accounts+providers+transcripts to a new machine and merge.',
  },
  {
    name: 'transfer',
    group: 'transfer',
    safe: false,
    usage: 'keyflip transfer serve [--receive] [--qr] | pull [<host>] --code X | push <host> --code X',
    desc: 'Live device-to-device account transfer over the LAN.',
  },

  // ---- fleet ----
  {
    name: 'fleet',
    group: 'fleet',
    safe: false,
    usage:
      'keyflip fleet init --dir <f> | push | status | switch <machine> <acct> | send-account | collect | keys | trust <machine> | panel',
    desc: 'Manage all your machines from one screen (encrypted shared folder).',
  },
  {
    name: 'swarm',
    group: 'fleet',
    safe: false,
    usage: 'keyflip swarm <run|ping|drain --allow-exec|results|trust <machine>>',
    desc: 'Run a command across your own enrolled fleet machines.',
  },
  {
    name: 'team',
    group: 'fleet',
    safe: false,
    usage: 'keyflip team <publish|pull|members|add-member|remove-member> --dir <f> --pool <n> --passphrase-file <f>',
    desc: 'Encrypted team pool with roles.',
  },

  // ---- orchestration / strategic layer ----
  {
    name: 'run-job',
    group: 'orchestration',
    safe: false,
    usage: 'keyflip run-job "<prompt>" [--group g] [--strategy best]',
    desc: 'Run a prompt headless on the best-headroom account (isolated).',
  },
  {
    name: 'jobs',
    group: 'orchestration',
    safe: true,
    usage: 'keyflip jobs [list|run|clear]',
    desc: 'Manage the headless job queue.',
  },
  {
    name: 'fanout',
    group: 'orchestration',
    safe: false,
    aliases: ['fan-out'],
    usage: 'keyflip fanout "<prompt>" --accounts a,b,c',
    desc: 'Run the same prompt across N accounts.',
  },
  {
    name: 'route',
    group: 'orchestration',
    safe: true,
    usage: 'keyflip route <list|set <model> <provider>|clear|arbitrage on|off>',
    desc: 'Model routing/arbitrage across providers.',
  },
  {
    name: 'cache',
    group: 'orchestration',
    safe: true,
    usage: 'keyflip cache <status|purge>',
    desc: 'Response cache: show status or purge.',
  },
  {
    name: 'proxy',
    group: 'orchestration',
    safe: false,
    usage: 'keyflip proxy start [--wire] | stop | status | stats',
    desc: 'Command-started failover proxy (429/5xx routes to the next account).',
  },
  {
    name: 'autoswitch',
    group: 'orchestration',
    safe: false,
    usage:
      'keyflip autoswitch [--threshold 90 --interval 60 --strategy next-available] | install | status | uninstall | --once',
    desc: 'Watch usage and auto-swap the CLI account at a threshold.',
  },
  {
    name: 'run',
    group: 'orchestration',
    safe: false,
    usage: 'keyflip run <name> [-- args]',
    desc: 'Parallel session: run Claude as that account in this terminal only.',
  },

  // ---- cost ----
  {
    name: 'usage',
    group: 'cost',
    safe: true,
    usage: 'keyflip usage [--history]',
    desc: 'Per-account usage; --history adds trend + autoswitch/failover events.',
  },
  {
    name: 'cost',
    group: 'cost',
    safe: true,
    usage: 'keyflip cost [status|predict <acct>|by-project]',
    desc: 'Spend/utilization, time-to-limit, per-repo attribution.',
  },
  {
    name: 'budget',
    group: 'cost',
    safe: true,
    usage: 'keyflip budget [status|set <acct> --5h N --7d N|clear <acct>]',
    desc: 'Usage ceilings with breach/near-breach alerts.',
  },

  // ---- policy ----
  {
    name: 'policy',
    group: 'policy',
    safe: true,
    usage: 'keyflip policy <list|allow|deny|remove|default|check> [--cwd D --account A]',
    desc: 'Constrain which account a directory may use.',
  },
  {
    name: 'group',
    group: 'policy',
    safe: true,
    aliases: ['groups'],
    usage: 'keyflip group [list|members <g>|tag <acct> <g…>|untag <acct> <g>]',
    desc: 'Tag accounts into pools; next --group rotates within one.',
  },
  {
    name: 'link',
    group: 'policy',
    safe: false,
    usage: 'keyflip link [name|--remove]',
    desc: 'Map this directory to an account for run.',
  },

  // ---- config ----
  {
    name: 'config',
    group: 'config',
    safe: true,
    usage: 'keyflip config <get <key>|set <key> <val>|list|unset <key>>',
    desc: 'Centralized keyflip settings.',
  },
  {
    name: 'settings',
    group: 'config',
    safe: true,
    usage: 'keyflip settings [show | get <k> | set <k> <v>]',
    desc: 'View/edit ~/.claude/settings.json (rides migrate to other machines).',
  },
  {
    name: 'notify',
    group: 'config',
    safe: true,
    usage: 'keyflip notify [status|set --webhook URL --events a,b,c|test|off]',
    desc: 'Push alerts on quota/switch/fleet-reply.',
  },
  {
    name: 'post',
    group: 'config',
    safe: false,
    usage: 'keyflip post --to <webhook> [--status]',
    desc: 'Post status/events to a Slack/Discord/generic webhook.',
  },
  {
    name: 'vault',
    group: 'config',
    safe: true,
    usage: 'keyflip vault <status|use op|bw|vault|off>',
    desc: 'Store credentials in 1Password / Bitwarden / HashiCorp Vault.',
  },
  {
    name: 'mcpreg',
    group: 'config',
    safe: true,
    usage: 'keyflip mcpreg [add|list|enable|disable|import]',
    desc: 'Manage MCP servers across Claude Code + Desktop.',
  },
  {
    name: 'shell-init',
    group: 'config',
    safe: false,
    usage: 'keyflip shell-init <bash|zsh|fish>',
    desc: 'Print a shell hook so cd auto-activates the pinned account.',
  },

  // ---- ui ----
  {
    name: 'ui',
    group: 'ui',
    safe: true,
    usage: 'keyflip ui',
    desc: 'Full-screen TUI dashboard (accounts + usage + fleet).',
  },
  {
    name: 'panel',
    group: 'ui',
    safe: false,
    usage: 'keyflip panel [--open]',
    desc: 'Open a local web dashboard: accounts, quotas, providers, sessions, keepsakes.',
  },
  {
    name: 'menubar',
    group: 'ui',
    safe: false,
    usage: 'keyflip menubar [--install]',
    desc: 'Menu-bar/tray plugin (macOS xbar/SwiftBar, Linux Argos/kargos): glanceable account+quota.',
  },
  {
    name: 'statusline',
    group: 'ui',
    safe: false,
    usage: 'keyflip statusline install|uninstall',
    desc: 'Show the active account + quota in the Claude Code prompt (status line).',
  },

  // ---- agents (other AI tools) ----
  {
    name: 'agents',
    group: 'agents',
    safe: true,
    usage: 'keyflip agents',
    desc: "List other agents' memory + config keyflip can carry (Cursor/Gemini/Codex).",
  },
  {
    name: 'surfaces',
    group: 'agents',
    safe: true,
    usage: 'keyflip surfaces [list]',
    desc: 'Detect which AI tools are present + their active account.',
  },
  {
    name: 'skill',
    group: 'agents',
    safe: false,
    usage: 'keyflip skill add <owner/repo|./dir|file.tgz> | list | remove',
    desc: 'Install/manage Claude Code skills.',
  },
  {
    name: 'mcp',
    group: 'agents',
    safe: false,
    usage: 'keyflip mcp [--setup]',
    desc: 'MCP server over stdio for agents (--setup shows the config).',
  },
  {
    name: 'install-skill',
    group: 'agents',
    safe: false,
    usage: 'keyflip install-skill',
    desc: 'Install the Claude Code skill that teaches agents keyflip.',
  },

  // ---- maintenance ----
  {
    name: 'doctor',
    group: 'maintenance',
    safe: true,
    usage: 'keyflip doctor',
    desc: 'Diagnose config, login and endpoint reachability.',
  },
  {
    name: 'backup',
    group: 'maintenance',
    safe: false,
    usage: 'keyflip backup [now|list|restore <n>|prune]',
    desc: 'Snapshot keyflip metadata (no secrets).',
  },
  {
    name: 'versioning',
    group: 'maintenance',
    safe: true,
    usage: 'keyflip versioning [on|off]',
    desc: 'Toggle auto-versioning of config (on by default; secrets never committed).',
  },
  {
    name: 'history',
    group: 'maintenance',
    safe: true,
    usage: 'keyflip history',
    desc: 'Show the git-versioned config change history.',
  },
  {
    name: 'log',
    group: 'maintenance',
    safe: true,
    aliases: ['auditlog'],
    usage: 'keyflip log [--tail N] [--grep S] [--since ISO]',
    desc: 'View the action/audit log.',
  },
  { name: 'undo', group: 'maintenance', safe: false, usage: 'keyflip undo', desc: 'Undo the last config change.' },
  {
    name: 'restore',
    group: 'maintenance',
    safe: false,
    usage: 'keyflip restore <ref>',
    desc: 'Roll config back to a specific ref.',
  },
  {
    name: 'license',
    group: 'maintenance',
    safe: true,
    usage: 'keyflip license <status|activate <file>>',
    desc: 'Offline license (open-core; paid tiers).',
  },
  {
    name: 'upgrade',
    group: 'maintenance',
    safe: false,
    usage: 'keyflip upgrade',
    desc: 'Update keyflip itself (auto-detects the install method).',
  },
  {
    name: 'reset',
    group: 'maintenance',
    safe: false,
    usage: 'keyflip reset [--soft] [--logout [--no-desktop]]',
    desc: 'Factory reset: delete all keyflip data.',
  },
  {
    name: 'uninstall',
    group: 'maintenance',
    safe: false,
    usage: 'keyflip uninstall [--purge]',
    desc: 'Remove keyflip from this machine (auto-detects the install).',
  },
  {
    name: 'version',
    group: 'maintenance',
    safe: true,
    aliases: ['--version', '-v'],
    usage: 'keyflip version',
    desc: 'Print the keyflip version.',
  },
  {
    name: 'help',
    group: 'maintenance',
    safe: true,
    aliases: ['--help', '-h'],
    usage: 'keyflip help',
    desc: 'Show the full command reference.',
  },
];

// Name -> entry index, on a null-prototype object so inherited keys
// ('__proto__', 'constructor', 'toString', …) can never resolve to an entry.
const INDEX = Object.create(null);
for (let i = 0; i < CATALOG.length; i++) {
  const e = CATALOG[i];
  INDEX[e.name] = e;
  if (Array.isArray(e.aliases)) {
    for (let j = 0; j < e.aliases.length; j++) INDEX[e.aliases[j]] = e;
  }
}

// get(name) -> entry | null. Null-proto safe: unknown names and inherited
// property names (e.g. '__proto__') return null.
function get(name) {
  if (typeof name !== 'string') return null;
  const hit = INDEX[name];
  return hit || null;
}

// search(query) -> filtered CATALOG. Case-insensitive substring match over
// name + aliases + desc. Empty / whitespace-only query returns all entries.
function search(query) {
  const q = (typeof query === 'string' ? query : '').trim().toLowerCase();
  if (!q) return CATALOG.slice();
  return CATALOG.filter(function (e) {
    if (e.name.toLowerCase().indexOf(q) !== -1) return true;
    if (e.desc.toLowerCase().indexOf(q) !== -1) return true;
    if (Array.isArray(e.aliases)) {
      for (let j = 0; j < e.aliases.length; j++) {
        if (String(e.aliases[j]).toLowerCase().indexOf(q) !== -1) return true;
      }
    }
    return false;
  });
}

// byGroup() -> { group: [entries] }, ordered by GROUPS, only groups with entries.
function byGroup() {
  const out = Object.create(null);
  for (let g = 0; g < GROUPS.length; g++) {
    const group = GROUPS[g];
    const entries = CATALOG.filter(function (e) {
      return e.group === group;
    });
    if (entries.length) out[group] = entries;
  }
  return out;
}

export { CATALOG, GROUPS, search, byGroup, get };
