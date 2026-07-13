---
name: keyflip
description: >-
  Manage multiple Anthropic/Claude accounts on this machine with the keyflip
  CLI: check which account is active, compare each account's remaining 5h/7d
  quota, switch or rotate accounts (with the user's consent), run a second
  account in parallel in one terminal, and diagnose login/quota problems.
  Use when the user mentions switching Claude accounts, hitting rate limits /
  usage caps, "which account am I on", account quotas, or parallel accounts.
---

# keyflip — operating multiple Claude accounts

keyflip swaps the machine's Claude credentials between saved accounts. It
manages BOTH login surfaces: the Claude Code CLI credential (Keychain on macOS,
`~/.claude/.credentials.json` elsewhere) and the desktop app's login (token +
session cookie). Chat/session history in `~/.claude/projects` is
account-independent and always safe.

## Ground rules

1. **Never switch accounts without the user's explicit consent.** A switch
   changes who gets billed and rate-limited mid-conversation.
2. Prefer `--json` for anything you parse: one JSON object on stdout
   (`schemaVersion: 1`), human text on stderr, errors as `{"error":{...}}`
   with exit 1.
3. Mutations are already serialized (cross-process lock) and transactional —
   do not retry a failed switch blindly; read the error, it says what to do.
4. If MCP tools named `keyflip_*` are available, prefer them over shelling
   out; their semantics match the CLI (`keyflip mcp --setup` shows setup).

## Capturing accounts (onboarding)

To save accounts, the user must be logged into each one; keyflip reads the live
login and stores it. Two ways:

- **`keyflip onboard`** — the full guided first-run: per account it drives a browser
  sign-in, captures it (CLI + browser), points the live CLI at it, offers to capture
  the Claude Desktop app too (the user signs the app in, keyflip snapshots it), syncs
  all chats, then asks for the next. At the per-account prompt, choosing **`p`** adds an
  **API-key provider** endpoint inline (name → base URL → bearer/api-key → hidden key →
  optionally route to it) instead of an OAuth subscription. Superset of `setup`;
  interactive (TTY) — tell the user to run it themselves, ideally NOT inside the desktop app.
- **`keyflip setup`** — a lighter wizard: it captures the current login, then
  auto-detects each new account as the user signs into it (`/logout`→`/login`, or
  the desktop app) and saves it, until they type `d`. Interactive (TTY).
- **`keyflip add [name]`** — captures whatever is logged in right now (one account).
  Scriptable. `--app` = desktop app only. `--token <file|->` imports a raw
  credential (secrets via file/stdin, never argv).
- **`keyflip login [name] --email <x>`** — signs in via the OFFICIAL `claude auth
  login` in an ISOLATED config dir (the user's current login is NOT disturbed) and
  captures the minted token. The only human step is approving in the browser. Note:
  OAuth uses the browser's current claude.ai session, so if the browser is signed
  into a different account, keyflip captures THAT and warns (mismatch) — the user
  must sign the browser into the target account first (see `keyflip browser`).
  For an **enterprise / SSO** account add `--sso` (drives `claude auth login --sso`,
  handling the org picker); `--console` captures a Console (API) account. Both flags
  also work on `keyflip onboard` (they apply to every OAuth sign-in in that run).

**Browser / the Claude Chrome extension (macOS):** the extension has no login of
its own — it inherits the browser's claude.ai session. If that != the active
CLI/desktop account, the extension's native-messaging bridge refuses to connect
("user mismatch"). `keyflip browser status` shows the browser's claude.ai account
and flags a mismatch; `keyflip browser logout` clears it (reversible, quit the
browser first) so the user can sign in as the right account. `keyflip browser sync
[name]` restores a previously-captured session for that account into the browser
(defaults to the active account) — the same alignment `keyflip <name> --browser` does
on a switch. Sessions are captured automatically during `onboard`/`login`.

**Via MCP:** almost everything here is also an MCP tool — `keyflip_login`, `keyflip_logout`,
`keyflip_browser_status`/`_logout`/`_sync`, `keyflip_consolidate`, `keyflip_switch`/`_next`,
`keyflip_list`/`_status`, providers, backups; session lifecycle: `keyflip_sessions` (search
returns content snippets + an `orphan` flag), `keyflip_sessions_rebind` (folder-rename fix),
`keyflip_sessions_archive`/`_unarchive`/`_archived`, `keyflip_sessions_export` (a chat → clean
markdown/HTML/json for sharing), `keyflip_foreign_export` (normalize ANOTHER agent's session
log — JSONL / Cursor SQLite / opencode+generic JSON / Copilot YAML / Aider MD — into the same view
via from-scratch zero-dep SQLite + YAML readers); cross-machine: `keyflip_migrate_export`/
`_import`/`_push`/`_pull` (export takes `agents:true` to also carry other agents' memory) and
`keyflip_agents` (inspect); git versioning: `keyflip_history`/`_undo`/`_restore`. The mutating
ones require `confirm: true`; `keyflip_login` opens a browser for the human. Only the
TTY-interactive wizards (`onboard`/`setup`) and the foreground `transfer serve` stay CLI-only.

## Read state (safe, no confirmation needed)

```bash
keyflip status --json          # {"cli":{"email":...},"app":{"name":...,"email":...}}
keyflip list --json            # accounts + cliCaptured/appCaptured/activeCli/activeApp
keyflip list --usage --json    # + usage {fiveHour:{pct},sevenDay:{pct}}, usageStatus, headroomPct
```

`usageStatus` sentinels: `ok`, `expired` (token invalid — the account needs a
re-`add`), `throttled` (usage endpoint throttled this token — **unknown**, NOT
proof the account is rate-limited), `error` (network), `no-creds`/`no-token`.
`headroomPct` = remaining % before the binding 5h/7d window; `null` = unknown.

## Switching (get consent first)

```bash
keyflip <name|number> --force     # swap in place; a running Claude Code picks it
                                   # up on its next request (keychain cache ~30s on macOS)
keyflip <name> --restart          # also close & reopen the desktop app (full switch)
keyflip <name> --browser          # also align the browser's claude.ai session (and thus
                                   # the Claude Chrome extension) to this account, from a
                                   # saved snapshot — captured during onboard/login
keyflip next --strategy best            # rotate to the account with most headroom
keyflip next --strategy next-available  # first account that isn't exhausted
```

Inside an active Claude Code conversation, prefer `--force` (in-place): the
session continues on the new account without closing anything. Use `--restart`
only when the user also wants the desktop app moved — it closes the app.

**Desktop↔CLI tug-of-war (macOS):** a `--force` swap only moves the CLI credential.
If the Claude **desktop app** is running on a *different* account, it can rewrite the
shared login and silently undo the switch — `--force` prints a warning when it detects
this. To make the switch stick, use `--restart` (moves the app too) or quit the app.

## When the user hits a rate limit

1. `keyflip list --usage --json` — find candidates with `headroomPct > 0`.
2. Report the options and ask which account to switch to (or propose
   `next --strategy best`).
3. After consent: `keyflip <name> --force` (or the `keyflip_switch` MCP tool
   with `confirm: true`).
4. Long unattended runs: suggest `keyflip autoswitch --threshold 90 -y`
   (auto-rotates the CLI credential at the threshold; never touches the app).

## Third-party endpoints (providers) — relays, gateways, Bedrock, OpenRouter

Accounts are OAuth subscriptions; **providers** point Claude Code at a different
API endpoint by patching `~/.claude/settings.json` env (Claude hot-reloads it —
no restart). Use when the user wants a relay/gateway/custom base URL, or is out of
subscription quota but has an API key.

```bash
keyflip provider add <name> --base-url <url> --key-file <file|->  # key via stdin, never argv
keyflip use <name>            # route Claude Code to it (no restart)
keyflip provider off          # back to the subscription (OAuth)
keyflip provider list         # which providers exist / which is active
keyflip speedtest <name>      # pick the fastest of a provider's endpoints
keyflip test <name>           # one real request → auth ok? (auth/network/4xx/5xx)
keyflip doctor                # health check: secrets-in-git, orphaned sessions, versioning, config, login, endpoints (MCP: keyflip_doctor)
```

`status` shows the active provider. Switching a provider does NOT change the OAuth
account; `keyflip provider off` restores it. Never put an API key in argv — use
`--key-file -` (stdin) or a file.

## Reliability, history, backup, sharing, sync

- `keyflip autoswitch --threshold 90 -y` skips accounts whose circuit breaker is
  open (repeatedly failing) and logs every failover. It is a FOREGROUND loop —
  for real unattended rotation (no terminal to keep open) install it as a service:
  `keyflip autoswitch install [--interval 300]` (launchd/cron runs `--once` on a
  timer), `keyflip autoswitch status|uninstall`. Defaults come from `keyflip config`.
  MCP: `keyflip_autoswitch_service` (action=status|install|remove; install/remove
  need confirm). This is the fix when a user says "autoswitch never switches" —
  they were running the foreground loop only in a terminal that wasn't open.
- `keyflip usage --history` — per-account 5h/7d trend + failover events.
- `keyflip usage --providers` — usage/limits across the OTHER AI tools on this machine (Codex/Gemini/
  Cursor/Copilot/opencode/OpenRouter + Claude), from provusage (the CodexBar-style monitor). MCP:
  `keyflip_provider_usage` (read-only; reads only usage numbers + reset times, never a token value).
- `keyflip backup now|list|restore <n>` — snapshots keyflip metadata (no secrets);
  restore takes a safety backup first.
- `keyflip share <provider> [--no-secrets]` → a `keyflip://` link; `keyflip import
  '<url>'` previews + confirms. Account links are pointer-only (never the token).
- `keyflip sync push|pull --url <webdav> --passphrase-file <f>` — encrypted
  cross-device sync. Or point `KEYFLIP_CONFIG_DIR` at a Dropbox/iCloud folder.
- `keyflip migrate export <file> [--passphrase-file <f>]` — bundle EVERYTHING
  portable (all accounts + providers + every Claude Code session transcript **+ your
  `~/.claude` MEMORY**: CLAUDE.md and `projects/*/memory/*`) to carry to a new machine;
  encrypt with `--passphrase-file`. `keyflip migrate import <file> [--force]
  [--passphrase-file <f>]` **MERGES** it into the target: accounts, providers,
  transcripts AND memory are UNIONed — anything already there is kept (never clobbered)
  unless `--force`. Trim/select what goes in the bundle (also on `migrate push` and `transfer
  serve`): `--no-memory`/`--no-sessions`/`--no-providers`/`--no-accounts`, or select transcripts
  with `--sessions <id,id>` / `--search "<term>"` / `--newer-than <7d>` / `--older-than <30d>`,
  or `--only-sessions` / `--only-memory` / `--only-config` / `--only-agents` for a single-kind bundle. The bundle
  also carries **portable CONFIG** (J): keyflip's **MCP registry**, Claude Code's `settings.json`,
  and Claude Desktop's MCP config — so a new machine is ready (`--no-config` to exclude).
- `keyflip agents` — list which **other AI agents** have MEMORY and/or CONFIG on this machine
  that keyflip can carry (Cursor `~/.cursor/rules/`+`mcp.json`, Gemini `~/.gemini/GEMINI.md`+`settings.json`,
  Codex `~/.codex/AGENTS.md`+`memories/`+`config.toml`). Add `--agents` (or `--agents=cursor,gemini`)
  to carry MEMORY (**markdown ONLY**, no secrets), and/or `--agent-config` to carry CONFIG (MCP
  servers/settings) — config is **secret-scanned + redacted by default** (`src/secretscan.js`) so keys
  don't travel; the structure moves and you re-enter keys on the new machine (`${ENV}` refs are kept).
  Re-redacted again on import (defence in depth). To move a full setup between YOUR OWN machines,
  `--agent-config-secrets` carries the REAL keys — but only with encryption (CLI warns; MCP
  `agent_config_secrets` refuses without `passphrase_file`). Both off by default; work on `migrate
  export`/`push`/`transfer`. (MCP: `keyflip_agents` to inspect; `agents`/`agent_config`/`agent_config_secrets` on `keyflip_migrate_export`.)
- `keyflip settings [show | get <key> | set <key> <value> | unset <key>]` — view/edit
  `~/.claude/settings.json` (dot-paths for nesting, e.g. `set env.ANTHROPIC_MODEL opus`; Claude
  hot-reloads it). These settings ride `migrate`/`transfer` to other machines. (MCP: `keyflip_settings`.)
- `keyflip statusline install` — show the active account (+ provider, + cached quota) right in the
  Claude Code prompt. `keyflip statusline` (no args) emits the line; `uninstall` removes it. Fast,
  cache-only (no network). (MCP: `keyflip_statusline`.)
- `keyflip menubar` — emit menu-bar/tray plugin output (active account + 5h quota in the title;
  dropdown of accounts colour-coded by quota with **click-to-switch**, providers, open-dashboard).
  `keyflip menubar --install [--dir <plugins-folder>] [--interval 30s]` drops a wrapper into the host's
  plugin folder. The plugin format is shared, so it installs on **macOS xbar/SwiftBar** (xbar's folder
  auto-detected; SwiftBar via `--dir`) AND **Linux GNOME Argos / KDE kargos** (`$XDG_CONFIG_HOME/argos`).
  No daemon in keyflip — the host re-runs it on an interval. CLI-only (it IS the machine-readable surface).
- `keyflip panel [--open]` — a command-activated LOCAL web dashboard (loopback only, read-only, not a
  daemon): account grid with quota bars + 5h usage sparklines, a **session-activity calendar heatmap**
  (GitHub-style, 26 weeks) and a **memory constellation** (keepsakes linked by shared terms), providers,
  recent sessions (folder-gone flagged), keepsakes.
  Ctrl-C stops it. It's a human UI over the same data the read MCP tools expose, so it stays CLI-only.
  `keyflip panel --export <file> [--anon]` writes a **share-safe STATIC snapshot** (self-contained
  HTML, no script/fetch/secrets; accounts+quota+activity+providers ONLY — no session content;
  `--anon` masks emails/names). For "here's my account/quota picture" without exposing anything private.
- **VS Code companion** (`vscode-keyflip/`, not an MCP surface): status-bar account indicator, a
  QuickPick switcher (with 5h/7d quota), Open Dashboard, and a status view — all shelling out to the
  `keyflip` CLI with `--json`. Local `.vsix` install (no marketplace yet). Bilingual README.
  Desktop-app/browser logins are machine-bound — re-capture via `onboard`.
  Via MCP: `keyflip_migrate_export` / `keyflip_migrate_import` (both need `confirm:true`).
  No-LAN relay: `keyflip migrate push --url <webdav> --passphrase-file <f>` on the
  source, `keyflip migrate pull --url <same> --passphrase-file <f> [--force]` on the
  target — same encrypted bundle, moved through a WebDAV server (always encrypted;
  pull previews + merges).
- `keyflip transfer serve` (source) ↔ `keyflip transfer pull [<host:port>] --code XXXX`
  (target) — LIVE device-to-device transfer over the LAN, no file or cloud. `serve`
  shows a one-time code (add `--qr` for a scannable terminal QR of the `keyflip://transfer?…`
  pairing URL — zero-dep encoder, decoder-verified) and streams the encrypted bundle only to a
  peer presenting it (single-shot, auto-expires, rate-limited); `pull` auto-discovers the peer via
  a UDP beacon when no host is given, then MERGES (same union semantics; `--force` overwrites).
  **Reverse (push):** `keyflip transfer serve --receive` on the TARGET waits with a code, and
  `keyflip transfer push <host:port> --code XXXX` on the SOURCE sends (with the E2 filters) to
  it — for "send my sessions to my other, listening machine". LAN transfer is TTY/foreground so
  it stays CLI-only; the MCP path for cross-machine is `keyflip_migrate_push`/`_pull` (WebDAV).
  **INTERNET (relay):** `keyflip transfer serve --relay <dir|url>` ↔ `keyflip transfer pull --relay
  <dir|url> --code <rendezvous>-<key>` keeps the same one-time-code UX but routes the encrypted bundle
  through a **user-controlled, zero-knowledge relay** (a synced folder OR a WebDAV URL, auto-detected).
  The code is two parts: `rendezvous` is the public relay slot; `key` is the AES passphrase that NEVER
  reaches the relay. One-shot (deleted on pickup). No relay of your own? `keyflip transfer relay
  [--dir D --host H --port P --auth-user U --auth-pass-file f] [--allow-open]` hosts a self-contained,
  zero-dep blob store (no Docker/daemon; refuses a public bind without auth unless `--allow-open`).
- **FLEET — one screen for every machine.** `keyflip fleet init --dir <shared-folder>` links this
  machine into a control plane through an **encrypted shared folder** (Dropbox/iCloud/synced dir;
  same fleet passphrase everywhere). `keyflip fleet push [--with-secrets]` publishes this machine's
  status (accounts + cached quota + recent chats with **reply status**: assistant=replied,
  user=waiting) AND applies commands queued for it (consent-gated). `keyflip fleet status` (or the
  web `fleet panel`) shows EVERY machine on one screen + flags chats that got a **new reply** since
  last check. `keyflip fleet switch <machine> <account>` queues a remote switch; `keyflip fleet
  send-account <acct> --to <machine> [--from <machine>]` distributes an account — so from machine A
  you can hand machine C's account to machine B; `keyflip fleet collect` gathers every published
  account locally. Everything in the rendezvous is encrypted (nothing plaintext at rest).
  **Origin authentication:** each machine owns an Ed25519 signing key (private key 0600, local only,
  never in the shared folder). Commands are signed; a receiver **trust-on-first-use pins** each peer's
  public key and REJECTS any command whose signature doesn't verify — so even a leaked passphrase can't
  let a forger command a machine. If a peer's key later CHANGES it's flagged as possible key
  substitution and its commands are rejected until `keyflip fleet trust <machine>` re-pins the new key
  (consent-gated). (MCP: `keyflip_fleet_status` / `keyflip_fleet_keys` (read), `keyflip_fleet_switch` /
  `keyflip_fleet_send_account` / `keyflip_fleet_collect` / `keyflip_fleet_trust` (need `confirm:true`).)
- `keyflip consolidate [--watch]` — sync every account's chat index so each shows
  ALL conversations. The desktop app's store is locked while it runs, so a one-shot
  offers to close→sync→reopen the app; `--watch` re-syncs on an interval whenever the
  app is closed. Also runs automatically on a switch. (MCP: `keyflip_consolidate`.)
- `keyflip history` / `keyflip undo` / `keyflip restore <ref>` — keyflip's config/state dir
  is a git repo; every mutation auto-commits (**secrets are git-ignored** — creds/*.cred,
  browser sessions, tokens stay in the OS store), so any change is inspectable and
  reversible. `keyflip versioning [on|off]` toggles it (ON by default; needs `git`).
- `keyflip mcpreg` — manage MCP servers once, project into Claude Code + Desktop.
- `keyflip gateway use <provider>` — route the Claude **desktop app** through a
  provider gateway (restart the app to apply).

**These all have MCP tools too** (2026-07 parity pass) — an agent can do everything the CLI can:
`keyflip_gateway_status` / `keyflip_gateway_use` / `keyflip_gateway_off`; `keyflip_mcpreg_list` /
`keyflip_mcpreg_set` / `keyflip_mcpreg_enable` / `keyflip_mcpreg_remove`; `keyflip_speedtest` (RANK
a provider's endpoints, read-only — does not change the active URL); `keyflip_share` /
`keyflip_share_apply` (build/import `keyflip://` links); `keyflip_sync_test` / `keyflip_sync_push` /
`keyflip_sync_pull` (encrypted WebDAV account sync); `keyflip_links` / `keyflip_link` (directory→account
pins); `keyflip_transfer_pull` (pull+merge a bundle from a LAN peer running `transfer serve`); and
`keyflip_autoswitch_tick` (one usage-check that may switch at the threshold). Every mutating one needs
`confirm:true`; secrets (WebDAV/passphrase) are passed as `*_file` paths, never inline.

## Groups, budgets, notifications, shell activation, audit log

- **Groups/tags** — `keyflip group tag <acct> <g…>` pools accounts; `keyflip next --group <g>` rotates
  ONLY within that pool (failover/rotation scoping). (MCP: `keyflip_groups` (read), `keyflip_group_tag`
  / `keyflip_group_untag` need `confirm`.)
- **Budgets** — `keyflip budget set <acct> --5h N --7d N` (or `*` for a default over every account)
  sets usage-% ceilings; `keyflip budget status` flags each account at/over its ceiling (breach) or
  within 10% (warn), reading the usage cache (refresh with `keyflip list --usage`). (MCP:
  `keyflip_budget_status` (read), `keyflip_budget_set` / `keyflip_budget_clear` need `confirm`.)
- **Notifications** — `keyflip notify set --webhook URL --events quota,switch,fleet-reply` POSTs a
  NON-SECRET `{event,payload,at}` on those events (+ optional macOS banner). `keyflip notify test`
  verifies wiring. (MCP: `keyflip_notify_status` (read), `keyflip_notify_set` / `keyflip_notify_test`.)
- **Shell auto-activation** — `eval "$(keyflip shell-init zsh)"` makes `cd` into a `keyflip link`-pinned
  directory auto-switch the account (direnv-style; re-switches only when the pin changes). (MCP:
  `keyflip_shell_init` returns the snippet.)
- **`.env` import** — `keyflip import-env [file] [--dry-run]` detects Anthropic/OpenAI creds in a .env
  file or the environment and saves them as providers (keys never printed). (MCP: `keyflip_import_env`.)
- **Audit log** — `keyflip log [--tail N] [--grep S] [--since ISO]` views the action log (switches/
  adds/errors) at `<configDir>/logs/keyflip.log`. (MCP: `keyflip_audit_log` (read).)
- **Cursor WAL** — `keyflip foreign` now replays a Cursor `-wal` sibling so RECENT chats aren't missed.

## Orchestration, cost, teams, policy, routing (strategic layer)

- **Orchestrator (job queue)** — `keyflip run-job "<prompt>" [--group g]` runs a prompt HEADLESS on the
  best-headroom account in an isolated config dir; `keyflip jobs [list|run|clear]`; `keyflip fanout
  "<prompt>" --accounts a,b,c` runs the same prompt across N accounts. This is authorized distributed
  execution on YOUR OWN accounts/machines — respect each account's ToS + rate limits. (MCP: `keyflip_jobs`
  (read), `keyflip_job_enqueue` / `keyflip_job_run` / `keyflip_fanout` need `confirm`; run/fanout spend quota.)
- **Cost intelligence** — `keyflip cost status` (utilization + $ where token totals are known — never
  inferred from a %), `keyflip cost predict <acct>` (time-to-limit), `keyflip cost by-project` (per-repo
  token/cost). (MCP: `keyflip_cost_status` / `_cost_predict` / `_cost_by_project`, all read-only.)
- **Team pool** — `keyflip team publish/pull --dir <shared> --pool <n> --passphrase-file <f>`: an ENCRYPTED
  shared credential pool with roles (owner sees all; member sees member-tagged). (MCP: `keyflip_team_members`
  (read), `keyflip_team_publish` / `_team_pull` / `_team_member_add` / `_team_member_remove` need `confirm`.)
- **Policy engine** — `keyflip policy allow|deny --cwd <dir> --account <a> [--group g]` constrains which
  account a directory/repo may use; ENFORCED on `keyflip <switch>` (override with `--force`). (MCP:
  `keyflip_policy_list` / `_policy_check` (read), `_policy_add` / `_policy_remove` need `confirm`.)
- **Vault backend** — `keyflip vault use op|bw|vault` stores credentials in 1Password / Bitwarden /
  HashiCorp Vault instead of the OS keychain. (MCP: `keyflip_vault_status` (read), `_vault_use` / `_vault_off`.)
- **Routing + cache** — `keyflip route set <model> <provider>` / `route arbitrage on` picks the cheapest
  provider per model; `keyflip cache status|purge` manages the response cache. (MCP: `keyflip_route_list` /
  `_cache_status` (read), `_route_set` / `_route_clear` / `_cache_purge` need `confirm`.)
- **Chat integrations** — `keyflip post --to <webhook> --status` posts a non-secret status to Slack/Discord.
  (MCP: `keyflip_post_status` needs `confirm`.)
- **Swarm** — `keyflip swarm run "<cmd>" --passphrase-file <f>` queues a command onto YOUR OWN enrolled
  fleet machines. Exec is defence-in-depth gated: it runs ONLY when the target operator (1) drains WITH
  CONSENT (`keyflip swarm drain --allow-exec`, off by default) AND (2) has EXEC-TRUSTED the sender
  (`keyflip swarm trust <machine>` — a curated allowlist; TOFU-pinning alone never grants exec, so a
  leaked passphrase can't enroll a rogue machine into RCE). Commands are an argv array (no shell),
  origin-authenticated (fail-closed). Authorized distributed ops on machines you enrolled — NOT a tool
  for third-party targets. `keyflip swarm ping <your-url>` = reachability. (MCP:
  `keyflip_swarm_run`/`_swarm_ping` need `confirm`, `keyflip_swarm_results` (read); the consent-gated
  exec drain + exec-trust are CLI-only.)
- **Settings (E4)** — `keyflip config set <key> <value>` is the one validated home for toggles.
  (MCP: `keyflip_config_list`/`_config_get` (read), `_config_set`/`_config_unset` need `confirm`.)
- **TUI (E5)** — `keyflip ui` is a full-screen dashboard: accounts, provider usage (`u`, from provusage —
  the multi-provider CodexBar-style monitor), fleet (`f`), and a searchable **command palette** (`p`) over
  the whole CLI surface so the user never has to memorize commands (safe read-only ones run on Enter; the
  rest are printed ready to paste). Interactive, CLI-only.
- **CodexBar bridge** — `keyflip codexbar` detects a locally-installed CodexBar (the menu-bar usage monitor)
  and aligns its tracked providers with what keyflip can read. Complementary (CodexBar monitors, keyflip
  manages); reads only CodexBar's non-secret provider list, never its stored tokens.
- **Brain (opt-in)** — `keyflip brain "<intent>"` turns plain-language intent into a PROPOSED plan of
  keyflip commands (via Gemini) that the human approves one step at a time. It is PROPOSE-ONLY (never
  executes; approved steps go through normal dispatch, so destructive ones still re-confirm) and OFF
  unless `KEYFLIP_BRAIN=1` + `GEMINI_API_KEY` are set. Outbound context is secret-scrubbed; only real
  catalog commands survive validation, and any step carrying args is treated as mutating. MCP:
  `keyflip_brain_propose` (read-only — returns the plan, runs nothing).
- **Surfaces (E1)** — `keyflip surfaces` detects other AI tools (Cursor/Gemini/Codex/Copilot/opencode/
  Aider) and their active account where readable — DETECTION ONLY, never reads/moves a secret. (MCP:
  `keyflip_surfaces` (read).)
- **License** — `keyflip license status|activate <file>` is offline plan management (Ed25519-signed,
  verified locally, no phone-home). Paywall enforcement is NOT wired yet (ships at productization).
  (MCP: `keyflip_license_status` (read), `keyflip_license_activate` needs `confirm`.)

## Finding & resuming past conversations

Transcripts live in `~/.claude/projects` and are account-independent.

```bash
keyflip sessions [--search "oauth"] [--here]   # list/search conversations, all accounts;
                                       #   --search matches transcript CONTENT + shows a snippet; flags
                                       #   sessions whose folder is gone (⚠) and suggests rebind
keyflip sessions rebind <old> <new>   # re-link a project's chat history after renaming/moving its folder
keyflip sessions assign <id> <account>   # continue a session AS another account (resume --run runs it isolated) — NO profile switch
keyflip resume <id> --as <account>    # ...or one-off: resume this session under another account without switching profiles
keyflip send <id> "<message>" [--as <account>] [--fork]   # inject a message into a session headlessly (steer/continue it; e.g. from another machine)
keyflip sessions archive <id|--older-than 30d>   # move old transcripts into keyflip (gzipped), declutter ~/.claude
keyflip sessions unarchive <id>       # restore an archived transcript (byte-exact); `sessions archived` lists them
keyflip sessions distill <id> [--to-claude]   # summarize a chat into a durable keepsake (via `claude -p`; spends the active account)
keyflip sessions compact <id> [--apply]   # shrink a transcript (elide bulky tool output, keep the conversation; dry-run default)
keyflip sessions scrub <id> [--apply] [--categories a,b] [--llm-url URL]   # redact PII from a transcript (incl. assistant THINKING blocks); dry-run default, backs up on --apply
keyflip sessions delete <id> [--hard]   # delete a conversation: archives first (recoverable) by default; --hard = permanent unlink
keyflip sessions edit <id> <delete-message|redact-message|truncate-after> <n> [--apply]   # surgical JSONL edits (backs up; keeps the file valid)
keyflip memory [show <key>]           # browse keyflip's own distilled keepsakes (independent of ~/.claude memory)
keyflip recall "<query>" [--semantic] [--answer]  # recall across ALL your chats (BM25 default; --semantic = embeddings via Ollama/hosted; --answer = a CITED synthesis via `claude -p`)
keyflip dream [--older-than 30d] [--archive] [--apply]   # "dreaming": distill (+ optionally archive) old chats in one pass; DRY-RUN by default
keyflip dream schedule [--at 03:00] | unschedule | status   # run the dream nightly, unattended (launchd on macOS, cron on Linux)
keyflip resume <number|id>            # print the resume command for its original dir
keyflip resume <id> --run             # launch `claude --resume <id>` in that dir
keyflip cowork [--search T]           # browse Claude desktop Cowork sessions (all accounts)
keyflip chat [get <id>]               # read the active account's claude.ai Chat (EXPERIMENTAL)
keyflip handoff [--to claude|cursor|kiro|opencode|windsurf|generic] [--out CONTINUE.md]   # emit a CONTINUE-PROMPT so a NEW AI tool resumes this project from .keyflip/ without re-reading everything
```

`cowork` and Claude Code `sessions` are LOCAL and reliable. `chat` reads
claude.ai's cloud history via the desktop app's session cookie — it's
experimental: it needs a fresh Cloudflare cookie (works right after the app was
used) and only sees the account the desktop app is signed into; if it 403s, tell
the user to open the Claude app once and retry.

## Context Layer — portable project memory (`.keyflip/`)

Tool-independent project memory kept in a `.keyflip/` folder in the PROJECT dir (not the config
dir), so it moves with the repo across AI tools/accounts/machines. **Secret-safe:** every text field
is redacted before write/pack, and only env-var NAMES are carried (never values). Files are `0600`.

**Project context** — read it at the START of a session to inherit prior decisions/tasks:
- `keyflip context init` — create `.keyflip/` (project.json, context.md, decisions.json, tasks.json)
- `keyflip context status` / `keyflip context show [--json]` — summary / full secret-redacted package
- `keyflip context decision add "<title>" [--rationale] [--alt] [--do-not] [--status decided|rejected|superseded]` — record a durable choice (add a `--do-not` so future sessions don't re-try a rejected approach)
- `keyflip context task add "<title>"` / `keyflip context task set <id> <todo|in_progress|blocked|done>`
- MCP: `keyflip_context_read` (RO), `keyflip_context_task_set`, `keyflip_context_decision_add` (mutating — ask, then `confirm: true`).

**Unify AI rule files** — normalize this project's rule files into one model, re-emit per tool:
- `keyflip rules show` — detect CLAUDE.md / .cursorrules / .cursor/rules/* / AGENTS.md / GEMINI.md / copilot-instructions.md and preview the normalized model
- `keyflip rules import` — cache the model at `.keyflip/rules.json`
- `keyflip rules emit --to claude|cursor|agents|gemini|generic [--write]` — build one tool's file (stdout without `--write`; `--write` saves it — ask first)
- MCP: `keyflip_rules_show` (RO), `keyflip_rules_emit` (returns content; writes only with `confirm=true`). Secrets always redacted; only `${VAR}` references survive.

**Checkpoints** (git-bound session snapshots, chained by `parent` in `.keyflip/checkpoints/`):
- `keyflip checkpoint create --summary "<what you did>"` (optionally `--tasks-file tasks.json`) at a session boundary
- `keyflip checkpoint list` / `latest` / `show <id>`
- MCP: `keyflip_checkpoint_list` / `_latest` (RO); `keyflip_checkpoint_create` (mutating, `confirm: true`). Secrets redacted from every field; `show`/restore is READ-ONLY — keyflip never runs git or edits the tree, you read `git.branch`/`git.commit`/`git.dirty` and act yourself. Each has a `contentHash` for cross-machine conflict detection.

**Hand-off** — when the user moves a project to a different AI tool (or a fresh session that shouldn't re-read the repo), run `keyflip handoff --to <tool>` (or the `keyflip_handoff` MCP tool, RO). It reads `.keyflip/` and produces a self-contained CONTINUE-PROMPT (tool trail, files to read, active task, locked decisions, closing instruction); paste/pipe it into the new tool. Never emits secrets — only env-var names.

**Context-sync privacy** — `keyflip context sync <status|mode|export|check>` sets a project's `.keyflip/` sharing mode (`local`/`git`/`encrypted`/`company`); every field is secret-scanned before export, env-var values never leave the machine, and conflict detection flags divergent edits. Agents: `keyflip_ctxsync_status` (read) / `keyflip_ctxsync_mode` (change, needs `confirm`).

Never paste secrets into any field; use the `.env` mechanism so only the variable NAME travels.

## Installing skills & the failover proxy

```bash
keyflip skill add owner/repo          # install any skill from GitHub (or ./dir, or file.tgz)
keyflip skill list | remove <name>    # only removes skills keyflip installed

keyflip proxy start --wire            # command-started localhost proxy; wires Claude Code to it
keyflip proxy status | stats          # is it up? per-account request/token totals
keyflip proxy stop                    # stops it and unwires
```

The proxy is **explicitly started/stopped** (never an always-on daemon). While up,
it routes every request to the active account and **fails over to the next healthy
account on 429/5xx** before the client sees a byte — request-level failover that
`autoswitch` (usage-poll based) can't give. Suggest it for long unattended runs
where mid-request rate-limits are likely.

## Parallel accounts in one terminal

```bash
keyflip run <name> -y -- --resume     # run Claude Code as <name> ONLY here
keyflip run <name> --share-history -y # ...sharing conversation history too
keyflip link <name>                   # map this directory tree to an account;
                                       # then plain `keyflip run` here uses it
```

`run` isolates via `CLAUDE_CONFIG_DIR`; other terminals/the desktop app keep
their account. Warn the user: an in-session token refresh can log out other
live copies of the same account.

## Fixing problems

| Symptom | Fix |
|---|---|
| `usageStatus: "expired"` | log that account in once, then `keyflip add` |
| account shows `[cli — ]` or `[app — ]` in `list` | that surface was never captured: `keyflip add` (CLI and/or app auto-detected) or `keyflip add <name> --app` |
| "keychain locked" errors | ask the user to unlock the login keychain; profile storage falls back to files automatically |
| switch says an account is in use by live sessions | those PIDs are real running Claudes — ask the user before `--force` |
| moving to a new machine | `keyflip migrate export bundle --passphrase-file f` (accounts + providers + all session transcripts) → `keyflip migrate import bundle --passphrase-file f` there — it MERGES with the sessions already on that machine (`--force` to overwrite). (`export`/`import` move accounts only.) Desktop-app/browser logins are machine-bound — re-capture via `keyflip onboard` |
| chat history lost after renaming/moving a project folder ("working directory no longer exists") | `keyflip sessions rebind <old-path> <new-path>` — copies the transcripts to the new folder key, rewrites the old cwd inside them, and patches the desktop-app session records (run with Claude closed; restart it after). Old copies are backed up. |
| also carry my OTHER agents' memory/config to the new machine | `keyflip agents` to see what's present, then `keyflip migrate export bundle --agents` (memory, markdown-only) and/or `--agent-config` (MCP/settings, **secret-scanned + redacted**) → import as usual. Carries Cursor/Gemini/Codex/Copilot/opencode/Aider; auth/credential files never travel and config keys are redacted (re-enter on the target). |
| keyflip is misbehaving but accounts are fine | `keyflip reset --soft` — clears only runtime state (usage history, breakers, proxy state, caches, logs) and routes back to the subscription; **keeps saved accounts**. Confirm first (`--force` to skip). |
| user wants a full wipe / remove keyflip | **`keyflip reset`** is a FACTORY reset — DELETES all keyflip data (accounts, providers, backups), app stays installed. `--logout [--no-desktop]` also signs out the live surfaces. `keyflip uninstall` removes the app (`--purge` also deletes data). All destructive — get consent, they prompt unless `--force`. |

`reset` / `clean` / `uninstall` never touch the live Claude login (only `clean
--logout` does) or `~/.claude/projects`. `uninstall` won't delete a source checkout.
Never print or log credential blobs, tokens, or export file contents.
