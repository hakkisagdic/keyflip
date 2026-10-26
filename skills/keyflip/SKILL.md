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
  credential (secrets via file/stdin, never argv). `--dry-run` = report what it WOULD
  save (which account, new vs refreshed, whether the app jar has a usable session) and
  write NOTHING — use it to check before capturing, since a real `add` commits to the
  git-versioned state repo.
- **`keyflip login [name] --email <x>`** — signs in via the OFFICIAL `claude auth
  login` in an ISOLATED config dir (the user's current login is NOT disturbed) and
  captures the minted token. The only human step is approving in the browser. Note:
  OAuth uses the browser's current claude.ai session, so if the browser is signed
  into a different account, keyflip captures THAT and warns (mismatch) — the user
  must sign the browser into the target account first (see `keyflip browser`).
- **`keyflip login <name> --long-lived`** — mints a ONE-YEAR Claude Code token with the
  same official flow `claude setup-token` uses (one browser Authorize click; the browser
  must be signed into claude.ai as that account). Stored in the Keychain as
  `longlived__<name>`, never printed. A switch hands the CLI the normal login while it is
  alive or refreshable, and this token when that login is dead for good (expired, no
  refresh token). The token is INFERENCE-ONLY: chat/code/tools work; Remote Control and
  Claude in Chrome still need a full login. `keyflip verify` shows its remaining days.
  For an **enterprise / SSO** account add `--sso` (drives `claude auth login --sso`,
  handling the org picker); `--console` captures a Console (API) account. Both flags
  also work on `keyflip onboard` (they apply to every OAuth sign-in in that run).

**Browser / the Claude Chrome extension (macOS):** the extension has no login of
its own — it inherits the browser's claude.ai session. If that != the active
CLI/desktop account, the extension's native-messaging bridge refuses to connect
("user mismatch"). `keyflip browser status` shows the browser's claude.ai account
and flags a mismatch; `keyflip browser logout` clears it (reversible, quit the
browser first) so the user can sign in as the right account. `keyflip browser capture
[name]` SAVES the browser's current claude.ai session under that account (refusing a
browser that is signed in as a different one), and `keyflip browser sync [name]` does the
opposite — it RESTORES a saved session into the browser (quits and reopens it; defaults to
the active account), the same alignment `keyflip <name> --browser` does on a switch.
Sessions are also captured automatically during `onboard`/`login`. What `capture` saves is
what `keyflip chat --as <name>` reads, so it is the way to make another account's cloud
Chat history readable without switching to it.

**Via MCP:** almost everything here is also an MCP tool — `keyflip_login`, `keyflip_logout`,
`keyflip_browser_status`/`_logout`/`_sync`, `keyflip_chatgpt` (read-only status) and
`keyflip_chatgpt_capture`/`_switch`/`_refresh` (need `confirm`), `keyflip_consolidate` (plan first with the read-only `keyflip_consolidate_plan` — it works while the desktop app is open), `keyflip_switch`/`_next`,
`keyflip_switch_plan` (read-only: the dry run, no confirm needed), `keyflip_verify` (per-account
liveness), `keyflip_refresh` (guarded token revival), `keyflip_refresh_schedule`
(`action=status|install|remove` for the nightly `refresh --all`; install/remove need `confirm`),
`keyflip_llm` (read-only: which model the chores will use
and whose quota it burns, `probe:true` to test it), `keyflip_recall` (`answer:true` = a cited
synthesis), **history hygiene** (`keyflip_history_audit` / `keyflip_memory_audit` read-only scans of
every blob the state repo ever committed and of the keepsakes; `keyflip_history_scrub` /
`keyflip_memory_redact` mutate and need `confirm`; `keyflip_secrets_policy` reads and
`keyflip_secrets_tolerate` writes the "this finding is expected" policy — see the toleration rule below),
**credential chains** (`keyflip_chains` read-only:
which store each capture was copied from, who can renew each part, what is stale/shared/loose;
`keyflip_chains_tighten` chmods and needs `confirm`), **threads** (`keyflip_threads` read-only:
list / `slug` / `timeline` / `suggest` / reverse `id`; `keyflip_thread_create|add|remove|drop|mirror`
need `confirm` — see the threads section), `keyflip_list`/`_status`, providers, backups;
session lifecycle: `keyflip_sessions` (search
returns content snippets + an `orphan` flag), `keyflip_sessions_rebind` (folder-rename fix),
`keyflip_sessions_archive`/`_unarchive`/`_archived`, `keyflip_sessions_export` (a chat → clean
markdown/HTML/json for sharing), `keyflip_foreign_export` (normalize ANOTHER agent's session
log — message-event JSONL (Claude Code, opencode, Gemini, **Qoder CLI**) / Cursor SQLite /
generic JSON / Copilot YAML / Aider MD — into the same view
via from-scratch zero-dep SQLite + YAML readers); conversation layer:
`keyflip_conv_list`/`_show`/`_search`/`_context`/`_status` read EVERY local tool's chats
(Claude Code, Codex, Kiro, Gemini, Qoder, Cursor, opencode, Copilot, Aider) in one shape and
never build the index themselves — `keyflip_conv_index` and `keyflip_conv_export` (single file,
bulk, Obsidian vault, or a `target` handoff bundle) need `confirm` (see the conversations
section below); cross-machine: `keyflip_migrate_export`/
`_import`/`_push`/`_pull` (export takes `agents:true` to also carry other agents' memory) and
`keyflip_agents` (inspect); git versioning: `keyflip_history`/`_undo`/`_restore`. The mutating
ones require `confirm: true`; `keyflip_login` opens a browser for the human. Only the
TTY-interactive screens stay CLI-only: the `onboard`/`setup` wizards, the foreground `transfer serve`,
and `keyflip menu` — whose `[t]` threads screen is read-only, so it is worth pointing a human at, but it
takes no `--json` and an agent must not drive it.

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

**A saved capture is not a live login.** The Claude desktop app's real session is a
claude.ai `sessionKey` cookie in its own jar, and only a human sign-in can mint it. When
claude.ai rotates or revokes a captured session the app opens on its sign-in screen even
though keyflip's capture is intact, so keyflip reports it rather than looking healthy:
`list` marks the app `(signed out on disk…)`, `list --json` carries `appSessionLive` /
`appSessionExpires`, and `doctor`'s **desktop app session** check warns with the fix.
Do NOT re-switch or re-`add` hoping to repair it — ask the user to sign in once in Claude
(their login, never yours), then `keyflip add <name>` to refresh the capture.

One common cause to name specifically: the app **auto-updated** (Squirrel/ShipIt swapped the
bundle and relaunched it) and Chromium had not flushed the session cookie to disk yet, so the
live jar reads signed-out while the capture is fine. `doctor` dates the installed bundle and
says "the app was UPDATED <date>" in that case — that is a post-update timing gap, still fixed
by one human sign-in, NOT a broken capture. `keyflip add --dry-run` shows whether the jar
currently holds a usable session without writing anything.

## Conversations across every tool (read, search, RAG context)

`keyflip conv*` tools read the LOCAL transcripts of every AI coding tool on this machine —
Claude Code, Codex/ChatGPT, Kiro (CLI + IDE), Gemini/Antigravity, Qoder, Cursor, opencode,
Copilot, Aider — normalized into one shape, harness noise stripped. Use them when the user asks
"what did we decide about X?", "find the chat where Y", or wants a new agent to continue old work.

- **`keyflip_conv_list`** — browse (title/`search` filter only, `app`, `cwd`, `since`, `limit`).
  Instant when the index exists; otherwise it parses live and says `indexed:false`.
- **`keyflip_conv_search`** — content search, `mode` lexical|semantic|hybrid. It refuses with a
  clear error when there is no index (read-only tools never build one — ask the user, then
  `keyflip_conv_index` with `confirm=true`), and the result honestly says `lexical` + a
  `warning` when no embeddings exist. Snippets are credential-masked by default.
- **`keyflip_conv_context`** — the RAG block to paste into a prompt: char-budgeted
  (`budget`, default 12000), sources cited with id/app/cwd/date, `expand` pulls neighbouring
  chunks so a decision is not cut mid-thread. Prefer this over dumping a whole transcript.
- **`keyflip_conv_show`** — one conversation rendered md/html/json (`max_chars` caps it).
- **`keyflip_conv_status`** — what is indexed, per-app counts, embedding coverage.
- **`keyflip_conv_index` / `keyflip_conv_export`** — confirm-gated writes. A first full
  embedding pass can take many minutes and may outlive an MCP request: for that, tell the user
  to run `keyflip conv index --embed` in a terminal. Export modes: one `id` to a file, `all`
  with `limit`/`offset` paging, `obsidian:true` into a vault (user-edited notes become conflict
  copies, never overwritten), or a `target` handoff bundle for
  claude/codex/kiro/cursor/opencode/windsurf/gemini/copilot/aider/generic — no target tool has a
  native import, the bundle is context to attach.

Privacy rules that apply to you: nothing is uploaded (embeddings are local Ollama by default or
the user's `KEYFLIP_EMBED_URL`, with remote text redacted first), the index lives in the
secret-dir `conv-index` and its path is reported relative to the state dir, and conversation
text reaches your transcript only after credential-shaped lines are masked (unless the user
explicitly passes `redact:false`).

## Switching (get consent first)

```bash
keyflip <name> --dry-run         # the PLAN only: which surfaces would be written, what blocks the
                                   # switch, and whether that account can still authenticate at all
keyflip <name|number> --force     # swap in place; a running Claude Code picks it
                                   # up on its next request (keychain cache ~30s on macOS)
keyflip <name> --restart          # also close & reopen the desktop app (full switch)
keyflip <name>                    # moves EVERY surface by default: CLI, desktop app AND the
                                   # browser's claude.ai session (so the Claude Chrome extension),
                                   # from saved snapshots; a surface it can't move is named, not hidden
keyflip <name> --only cli|app|browser   # just those surfaces (comma-separated)
keyflip <name> --browser          # also close an open browser that won't restore its tabs
                                   # (skipped by default rather than closed behind the user's back)
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

**A `--restart` switch is verified, not assumed.** After reopening Claude, keyflip waits
a few seconds and reads the app's cookie jar; if it came back signed out it prints a
`⚠ Claude reopened on its SIGN-IN screen` warning (`appSignedIn: false` in `--json`)
instead of reporting a clean switch. Report that warning to the user — do not retry the
switch, it will fail the same way (see "A saved capture is not a live login" above).

**Every switch reads itself back, and a clean exit is not a success.** `keyflip <name>`
re-checks the account it just moved to and prints `✓ verified: usable now` or
`· read-back: NOT usable — <which check>` (`verified: {state, headline, detail}` plus
`cliEmailAfterSwitch` in `--json`). A successful write and a usable machine are different
facts: an expired token, a dead cookie capture, or a CLI credential that is still the old
account all follow exit code 0. Run `keyflip <name> --dry-run` (or the read-only
`keyflip_switch_plan` MCP tool) BEFORE you ask for consent — it names the writes, the
blockers and the target's state without touching anything, so you can tell the user "this
switch would leave every surface signed out" instead of discovering it afterwards.
`--no-verify` skips the read-back; `--rollback-on-fail` puts the previous account back when
it fails (opt-in: it re-writes credential stores, and only when the account it left was
itself a saved profile — `keyflip undo` reverts metadata, never credentials).

## When the user hits a rate limit

1. `keyflip list --usage --json` — find candidates with `headroomPct > 0`.
2. Report the options and ask which account to switch to (or propose
   `next --strategy best`). Before you offer one, `keyflip <name> --dry-run`
   (MCP: `keyflip_switch_plan`) — an account with headroom but a dead capture
   is not an option, and the plan says which is which.
3. After consent: `keyflip <name> --force` (or the `keyflip_switch` MCP tool
   with `confirm: true`). Read `verified` in the result before telling the user
   the switch worked.
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
keyflip doctor                # health check: secrets-in-git, orphaned sessions, versioning, config, login, endpoints, desktop app session, live auto-update state of the app + clones (MCP: keyflip_doctor)
keyflip doctor --history      # + scan every blob the state repo ever committed: a secret in an OLD commit (MCP: keyflip_history_audit)
keyflip scrub-history [--apply]  # remove them from history (dry run by default; git-filter-repo + bundle backup)
keyflip secrets [list [--alarms]] | tolerate <path> [--kind K] [--note "..."] | untolerate <path>   # which findings the user has declared EXPECTED: mutes the alarm + rotation nag, never the scrub (MCP: keyflip_secrets_policy / _tolerate)
keyflip chains [account] [--tighten [--apply]]   # what each login is MADE of: which store each capture came from, who can renew each part, what is stale / shares one store / is world-readable (MCP: keyflip_chains)
keyflip refresh [account|--all] [--json]   # revive stored OAuth tokens; REFUSES (changed:false) while a Claude session holds one
keyflip refresh --schedule [--at 04:30] | --unschedule | --schedule-status   # the same revival nightly, unattended (launchd/cron) — calls no model, spends no quota
keyflip freshness [--json]    # (alias: age) how old each saved login is: cli token (renewable) + app/browser claude.ai sign-in (fixed 28 days, human-only) + any "Sign in again" (session_stale_relogin) refusal — learns the refused age, reads timestamps never cookie values
```

`status` shows the active provider. Switching a provider does NOT change the OAuth
account; `keyflip provider off` restores it. Never put an API key in argv — use
`--key-file -` (stdin) or a file.

## ChatGPT + Codex (one shared login)

ChatGPT.app and the Codex CLI authenticate with the same `~/.codex/auth.json`
(or `$CODEX_HOME/auth.json`, mode 0600). The app's cookies are NOT a credential —
they hold only Cloudflare/analytics entries.

```bash
keyflip chatgpt status          # live e-mail/plan/expiry + saved accounts, never a token value
keyflip chatgpt list
keyflip chatgpt capture [name]  # auto-named from the id_token e-mail
keyflip chatgpt switch <name|n|email> [--dry-run] [--force] [--no-verify]
keyflip chatgpt refresh [--force]   # one-shot; --force ignores the 24h threshold
keyflip chatgpt remove <name> --force
```

`codex` is an alias. Captures live under `~/.config/keyflip/surfaces/codex/<slug>/`
(`auth.json` 0600 + secret-free `meta.json`). A switch refuses while ChatGPT/Codex
runs unless `--force`, backs up the live file, captures the outgoing login
best-effort, writes the stored bytes and verifies by raw read-back + e-mail identity.
The refresh daemon rotates the **live** file within 24 hours of expiry — never while
the app runs — and updates a capture only when it holds the exact refresh token that
was just spent (lineage-safe; dormant captures never refresh independently). A failed
refresh leaves the file untouched. MCP: `keyflip_chatgpt` (read) plus confirm-gated
`keyflip_chatgpt_capture` / `_switch` / `_refresh`; none returns a token.

## Isolated app instances (one desktop app per account, macOS)

`keyflip instance list|create|launch|focus|kill|enable-all|harden` manages APFS
clones of claude / kiro / chatgpt / cursor, each with its own `--user-data-dir`.
MCP: `keyflip_instances` (read) and the `keyflip_instance_*` tools (confirm=true).
A clone that can self-update may replace its bundle under a signed-in account;
`create` writes the app's own switch where one exists (Claude: `disableAutoUpdates`
in `User Data/config.json`; ChatGPT: Sparkle Info.plist), and
`keyflip instance harden` re-applies it. `keyflip doctor` reports the live state —
a controllable clone still ON is a warning; Kiro/Cursor have no switch and are
reported as such. A clone isolates the app *profile* (cookies/cache/window state),
not every credential: Claude is fully clone-isolated (`CLAUDE_CONFIG_DIR` + user
data), but ChatGPT/Codex (`~/.codex/auth.json`), Kiro (Keychain + `~/.aws/sso/cache`),
Antigravity and Qoder keep a global login — switch it first (`keyflip chatgpt` /
`keyflip kiro`) before using that clone for another account.

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
  it stays CLI-only; the MCP path for cross-machine is `keyflip_migrate_push`/`_pull` (WebDAV) and
  `keyflip_transfer_relay_pull` (one-shot pull of a `serve --relay` bundle via a synced folder / WebDAV
  URL, using the "<rendezvous>-<key>" code; mutating, confirm-gated, deletes the blob on pickup).
  **INTERNET (relay):** `keyflip transfer serve --relay <dir|url>` ↔ `keyflip transfer pull --relay
  <dir|url> --code <rendezvous>-<key>` keeps the same one-time-code UX but routes the encrypted bundle
  through a **user-controlled, zero-knowledge relay** (a synced folder OR a WebDAV URL, auto-detected).
  The code is two parts: `rendezvous` is the public relay slot; `key` is the AES passphrase that NEVER
  reaches the relay. One-shot (deleted on pickup). No relay of your own? `keyflip transfer relay
  [--dir D --host H --port P --auth-user U --auth-pass-file f] [--allow-open]` hosts a self-contained,
  zero-dep blob store (no Docker/daemon; refuses a public bind without auth unless `--allow-open`).
- **FLEET — one screen for every machine.** `keyflip fleet init --dir <shared-folder>` links this
  machine into a control plane through an **encrypted shared folder** (Dropbox/iCloud/synced dir;
  same fleet passphrase everywhere). Before any folder is set up, `keyflip fleet discover` finds the
  other keyflip machines **on the same LAN** via a UDP multicast beacon (public identity + key
  fingerprint only — no passphrase, safe to print; MCP `keyflip_fleet_discover`). It also ANNOUNCES
  this machine while listening (ON by default; `fleet announce off` to opt out). If multicast finds
  nobody it falls back to `tailscale status --json` and lists online tailnet peers (marked
  `[Tailscale]`). A discovered peer is only reachable — acting on it needs the passphrase AND a
  **pinned** key. **Adding a machine is
  deliberate and two-sided:** never trust a peer on first sight. Pair with `keyflip fleet invite`
  (mints a one-time code, shown once) + `fleet join <host-id> --code <code>` on the other machine +
  `fleet push --accept-join <host-id> --code-file <f>` here; or `fleet trust <machine>` after
  comparing fingerprints. A peer that only publishes shows as `pending`/`unpinned` and its commands
  are IGNORED — offer pairing, don't just trust it.
  `keyflip fleet push [--with-secrets]` publishes this machine's
  status (accounts + cached quota + recent chats with **reply status**: assistant=replied,
  user=waiting) AND applies commands queued for it (consent-gated). An agent can do the same over MCP
  with `keyflip_fleet_push`: `with_secrets` and `apply` are SEPARATE consents, and omitting `apply`
  reports queued switch/save commands as skipped. `keyflip fleet status` (or the
  web `fleet panel`) shows EVERY machine on one screen + flags chats that got a **new reply** since
  last check. `keyflip fleet switch <machine> <account>` queues a remote switch; `keyflip fleet
  send-account <acct> --to <machine> [--from <machine>]` distributes an account — so from machine A
  you can hand machine C's account to machine B; `keyflip fleet collect` gathers every published
  account locally. Everything in the rendezvous is encrypted (nothing plaintext at rest).
  **Origin authentication:** each machine owns an Ed25519 signing key (private key 0600, local only,
  never in the shared folder). Commands are signed; a receiver REJECTS any command whose signature
  doesn't verify against the sender's PINNED key — and a key is pinned only by the invite/join pairing
  above or an explicit `fleet trust`, never on first sight (so a leaked passphrase can neither forge a
  command nor add a machine). If a peer's key later CHANGES it's flagged as possible key
  substitution and its commands are rejected until `keyflip fleet trust <machine>` re-pins the new key
  (consent-gated). (MCP: `keyflip_fleet_status` / `keyflip_fleet_keys` (read), `keyflip_fleet_push` /
  `keyflip_fleet_switch` / `keyflip_fleet_send_account` / `keyflip_fleet_collect` / `keyflip_fleet_trust`
  (need `confirm:true`; push also needs `passphrase_file`).)
- `keyflip consolidate [--watch] [--no-instances]` — union every account's chat index so each shows
  ALL conversations. It covers Claude Desktop's Recents AND Cowork stores in the base app **and in
  every non-running instance clone** (`User Data/…`); a live `instance.pid` is skipped and reported,
  and `--no-instances` limits the pass to the base app. Two accounts can use the same `local_*.json`
  filename for different transcripts — keyflip then falls back to `local_<cliSessionId>.json` rather
  than dropping one, and a `deleted_<id>` tombstone still wins. The desktop app's store is locked
  while it runs, so a one-shot offers to close→sync→reopen the app; `--watch` re-syncs on an interval
  whenever the app is closed. Also runs automatically on a switch. (MCP: `keyflip_consolidate`.)
  Kiro's chat state is keyed by workspace and ChatGPT's conversations are server-side per account, so
  neither has a per-account chat index to merge — but their **logins** are managed
  (`keyflip kiro`, `keyflip chatgpt`).
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
- **Foreign sessions** — `keyflip foreign --list` discovers Cursor / opencode / Gemini /
  **Qoder CLI** (`~/.qoder/projects/<key>/<id>.jsonl`, its `subagents/` and `memory/` sidecars are not
  sessions) / Copilot logs, newest-first, with its own file budget per tool so one chatty tool cannot
  bury the rest. Anything credential-shaped (`auth.json`, `credentials.json`, `oauth*`) is never
  listed — do not hand a live token to the renderer. `keyflip foreign` replays a Cursor `-wal` sibling
  so RECENT chats aren't missed, and warns when it cannot. An unrecognized format is an error, not an
  empty chat.

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
keyflip sessions attribute [--apply] [--min-confidence high|medium]   # INFER which account each unassigned session was worked on, from keyflip's own switch timeline (dry-run default; --apply fills gaps only)
keyflip resume <id> --as <account>    # ...or one-off: resume this session under another account without switching profiles
keyflip send <id> "<message>" [--as <account>] [--fork]   # inject a message into a session headlessly (steer/continue it; e.g. from another machine)
keyflip sessions archive <id|--older-than 30d>   # move old transcripts into keyflip (gzipped), declutter ~/.claude
keyflip sessions unarchive <id>       # restore an archived transcript (byte-exact); `sessions archived` lists them
keyflip sessions distill <id> [--to-claude]   # summarize a chat into a durable keepsake (by the chore model — see `keyflip llm`)
keyflip sessions compact <id> [--apply]   # shrink a transcript (elide bulky tool output, keep the conversation; dry-run default)
keyflip sessions scrub <id> [--apply] [--categories a,b] [--llm-url URL]   # redact PII from a transcript (incl. assistant THINKING blocks); dry-run default, backs up on --apply
keyflip sessions delete <id> [--hard]   # delete a conversation: archives first (recoverable) by default; --hard = permanent unlink
keyflip sessions edit <id> <delete-message|redact-message|truncate-after> <n> [--apply]   # surgical JSONL edits (backs up; keeps the file valid)
keyflip memory [show <key>|audit [--apply]]   # browse keyflip's own distilled keepsakes (independent of ~/.claude memory); `audit` = secret scan of them (MCP: keyflip_memory_audit/_redact)
keyflip recall "<query>" [--semantic] [--answer]  # recall across ALL your chats (BM25 default; --semantic = embeddings via Ollama/hosted; --answer = a CITED synthesis by the chore model)
keyflip dream [--older-than 30d] [--archive] [--apply]   # "dreaming": distill (+ optionally archive) old chats in one pass; DRY-RUN by default
keyflip dream schedule [--at 03:00] | unschedule | status   # run the dream nightly, unattended (launchd on macOS, cron on Linux)
keyflip llm [status|set --provider claude|ollama|openai [--model M] [--base-url U] [--key-env NAME]|test [--timeout ms]|off]   # which model runs dream/distill/recall, and whose quota it burns
keyflip resume <number|id>            # print the resume command for its original dir
keyflip resume <id> --run             # launch `claude --resume <id>` in that dir
keyflip cowork [--search T]           # browse Claude desktop Cowork sessions (all accounts)
keyflip chat [--as <acct>] [--limit N]  # list claude.ai cloud Chats (EXPERIMENTAL)
keyflip chat get <short-id|title> [--as <acct>]   # read ONE — the short id from any listing works, so does a unique title
keyflip chat search "<words>" [--as <acct>]        # find a cloud chat by TITLE
keyflip handoff [--to claude|cursor|kiro|opencode|windsurf|generic] [--out CONTINUE.md]   # emit a CONTINUE-PROMPT so a NEW AI tool resumes this project from .keyflip/ without re-reading everything
keyflip mcp                              # the same thing as MCP tools for agents: keyflip_chat (id/search/account)
keyflip threads suggest                  # when one TASK is split over 2+ accounts — see "One named task across accounts"
```

**Chores cost something — name the cost before running one.** `dream --apply`, `sessions distill` and
`recall --answer` call a model. On the default provider that is `claude -p`, which spends the **active
account's subscription quota**, so a batch over 40 old transcripts is a real bill on the user's plan —
and a `dream schedule` job repeats it nightly, unattended. Read `keyflip llm` (MCP: `keyflip_llm`,
read-only) and tell the user which provider and which quota the run will use; `ollama` answers locally
for free, and provider `openai` routes any OpenAI-compatible gateway on an API key. To price an
alternative **without** editing shared state, call `keyflip_llm` with `provider`/`model` (plus
`base_url`/`key_env` for a gateway) and optionally `probe:true` for one tiny completion — the result
says `configured_for: one-off probe only — shared config unchanged`. Never pass an endpoint key as a
command or tool argument: `llm.key_env` stores only the **name** of an environment
variable and keyflip reads its value at call time. A local model needs minutes to load cold, so a
probe waits (CLI: `keyflip llm test --timeout 300000`). Each chore prints `distills via …` before its first
call, keepsakes record the model that produced them, and `keyflip doctor` warns when a scheduled job's
provider diverged from its install receipt.

**A secret you untracked is not a secret you removed.** keyflip's state dir is a git repo, so a capture
that predates an ignore rule stays fully readable from the commit that recorded it — and `keyflip doctor`
without `--history` only sees what is tracked *today*. Before mirroring transcripts, carrying state to
another machine, or sharing the config dir, call `keyflip_history_audit` (CLI: `keyflip doctor
--history`): it reports path + secret KIND + blob + how many commits hold it and NEVER the content, so
its output is safe to put in a chat. `keyflip_memory_audit` does the same for the keepsakes that
`distill` wrote (a summary can innocently preserve "my key is sk-ant-…"). To repair: show the user the
dry-run plan (`keyflip scrub-history`), then call `keyflip_history_scrub` with `confirm: true` — it
writes a `git bundle` backup, needs `git-filter-repo`, and re-scans to prove the result. Two things you
must tell the user, because the tool cannot do them: the bundle contains the secrets until they move or
delete it, and the credential itself still has to be rotated. Never scrub a path that is still tracked
(`tracked_paths` in the audit) unless the user accepts that the live file is deleted too — that is
`include_tracked`, not a default. And never print a keepsake's raw text into chat to "show" it;
`keyflip memory audit` gives you the kind without the value.

**Never tolerate a finding on your own initiative (CLI: `keyflip secrets tolerate`; MCP:
`keyflip_secrets_tolerate`).** A toleration is the user's decision that a secret is expected and not worth
an alarm — "this Google AI key is free and I don't care" is that decision, "the scrub is annoying" is not.
So: report every finding once, and only write a rule after the user says, in words, that this one does not
matter. When you do, scope it to the KIND as well as the path (`--kind jwt`, not a bare path), because a
path-only or trailing-`/` rule also silences anything NEW that lands there — and say so. Two properties to
keep straight when you explain it: a toleration ends the **alarm and the rotation advice only**, the path
stays in `keyflip_history_scrub`'s plan and is still removed from history; and it can never touch a keepsake
(`keyflip_memory_audit` has no policy). Don't offer to "skip the scan", and don't treat `alarms: 0` as "no
secrets" — read `tolerated_count` with it; a policy that failed to parse reports `policy_error` and leaves
every finding alarming, which is the intended direction of failure.

**When a switch "succeeded" but the account is not really there, call `keyflip_chains` (CLI:
`keyflip chains [account]`) before asking the user to log in again.** It answers the structural
question the other commands cannot: which store each capture was copied from, who can renew each part,
and what is wrong with the graph. Read the findings this way:

- `stale-snapshot` — the capture is older than the store it came from, so restoring it restores the
  past. Re-capture only while that account is actually logged in; do not "fix" it by switching to it.
- `shared-source` (high) — several captures come from one single-tenant store (a browser profile, the
  desktop app's cookie jar). Only one of those accounts can be live at a time; the others are
  guaranteed stale. Tell the user which one is currently in that store.
- A chain whose roots are `login:claude-web` / `login:claude-app` bottoms out in a human. The app's
  `oauth:tokenCache` is derived from its `sessionKey` cookie, so a healthy-looking token blob does NOT
  mean the account is alive — `refresh` cannot outlive those roots, and neither can you.
- `loose-mode` (high) — a secret inside the state repo is readable beyond its owner. `keyflip_chains`
  reports it; `keyflip_chains_tighten` with `confirm: true` (CLI: `chains --tighten --apply`) chmods
  exactly those files to 600 and re-scans to prove it. Never chmod anything else, and never "inspect" a
  capture by reading it — the map is built from paths and stats, and that is the deal.
- `orphan-capture` / `uncaptured-account` — the file and the profile disagree, so `keyflip list` will
  never show that capture, or switching there has nothing to restore.

`keyflip doctor` runs this map on every diagnosis, so a plain health check already says whether the
account graph is sound.

**Renewal is a calendar problem, so offer the schedule rather than the advice.** A stored token dies
after roughly six days whether or not anyone switches to it, and `refresh` only works while the
credential is idle — "run it when the CLI is free" is not something a user does at 04:30. If `doctor`
says `token renewal … nothing renews their tokens` (or `chains` shows `stale-snapshot` on OAuth
profiles), propose `keyflip refresh --schedule` (MCP: `keyflip_refresh_schedule`, `action:"install"`
with `confirm: true` after you ask). It costs nothing to run: the job calls no model and spends no
quota, unlike the nightly `dream`, which is why it has its own launchd label, crontab marker and
receipt file — installing one job never overwrites the other, and both can coexist. Two rules for
reading it:

- A refusal is normal and means **nothing changed**, not that it failed: `{"refused":
  "claude-code-running","changed":false}` (CLI prints the prose). Never report a refused run as a
  renewal, and never "fix" it by killing the user's session.
- `keyflip refresh --schedule-status` reports what is *scheduled*, `keyflip verify` reports what is
  *alive today*. They can disagree — a job installed yesterday cannot revive a token that died last
  week, and only a human login can do that (`chains` names those roots).
- The receipts (`dream-schedule.json`, `refresh-schedule.json`) are machine-local and git-ignored; do
  not treat a receipt on a second machine as proof of a job there, and do not commit them.

`cowork` and Claude Code `sessions` are LOCAL and reliable. `chat` reads
claude.ai's CLOUD history — it is experimental and cookie-bound:

- keyflip FINDS the session itself and prints where it read from (`Chrome (live browser
  session)`, `the Claude desktop app`, `saved Chrome session of 'yahoo' (…)`). Current
  desktop builds keep `sessionKey` only in memory, so the app's on-disk jar is often not
  the usable one — a browser signed into claude.ai usually is.
- It needs a *fresh* Cloudflare clearance. A 403 means stale, not
  logged out: `keyflip chat --flush` closes and reopens the app once so Chromium
  writes its cookies out, then retries.
- **`--as <account>` reads ANOTHER saved account's chats without switching anything** —
  from that account's captured browser session
  (`~/.config/keyflip/browser-sessions/<name>__<browser>.sql`), then its app-cookie
  snapshot. So you CAN search and read a non-active account's cloud history. If it says
  there is no saved session, have the user sign into claude.ai in a browser as that
  account and run `keyflip browser capture <account>` once — capture SAVES a session
  under an account, `browser sync` RESTORES one into the browser; never call sync to
  "refresh" a capture. Every `keyflip <name>` switch also refreshes the app login it leaves.
- Cookies are machine-bound (they decrypt with that browser's own key): a snapshot only
  decrypts on the machine + browser that captured it.
  Chats that never went through the desktop app are not in this list — claude.ai cloud
  Chat is server-side per account and cannot be merged across accounts locally.
- `search` matches TITLES only. For message BODIES across all your local transcripts,
  use `keyflip recall "<query>"`.

## One named task across accounts (`threads`)

A quota runs out mid-task, the user switches, and the same job becomes three objects: a session under
gmail, a session under yahoo, a claude.ai chat. `keyflip threads` gives them **one name**, and that is
the whole product — use it whenever work is split, instead of narrating ids.

```bash
keyflip threads suggest                    # what is ALREADY split over 2+ named accounts, per project folder
keyflip threads create <slug> --title "…" [--session <id>]   # Turkish titles slugify: "Düğüm açmak" → dugum-acmak
keyflip threads add <slug> <session-id|--chat uuid> [--account <name>]   # one member per call; 8-char prefixes OK
keyflip threads show <slug> [--timeline] [--md]   # merged chronological view / --md = the document only
keyflip threads open <slug> [--run]        # resume where the thread last stopped, as the account that owns it
keyflip threads where <id> | remove <slug> <id> | drop <slug> -y   # locate / unlink / forget the NAME
keyflip threads mirror <slug> | unmirror <slug>   # writes conversation TEXT — needs `config set threads.mirror true`
```

- **Run `suggest` (MCP `keyflip_threads` with `suggest: true`) before asking the user which sessions
  belong together.** It finds folders where two or more *named* accounts worked and drops what a thread
  already covers, so the list shrinks as work gets named. It deliberately ignores "one account plus
  unassigned sessions" — that is a missing `keyflip sessions assign`, not a switch, so offer that
  instead of inventing a thread.
- **A thread is pointers only.** `threads/<slug>.json` holds kind + id + account + project + addedAt and
  NEVER prose: the first prompt of a session is where a pasted API key lives, so copying it into a
  pointer file would put a secret into the git-versioned state repo. Deleting or dropping a thread
  cannot lose a message — `drop` forgets the name and leaves every transcript and assignment alone.
- **Prefixes are expanded at write time** into the full session id, and an ambiguous prefix is refused
  rather than guessed. `--chat`/`--cloud` is REQUIRED for a claude.ai uuid: a local session id and a
  chat uuid are both UUIDs, so the flag is the only honest way to tell them apart. A cloud chat
  contributes no turns offline — `show` lists it under `unavailable` with the `keyflip chat get …`
  command that would read it. Say that rather than presenting a half-empty merge as the whole story.
- **Never enable the mirror on your own.** `threads mirror` writes conversation text to
  `thread-mirror/` and is gated twice: `keyflip config set threads.mirror true` AND the call. That dir
  is a registered secret dir (0600, never versioned/backed up/synced) and the mirror still refuses when
  the state repo has a git remote. Ask the user before turning it on; `show --md` prints the same
  document without writing anything and is the default answer.
- MCP: read-only `keyflip_threads`; `keyflip_thread_create|add|remove|drop|mirror` mutate and require
  `confirm: true`. MCP results AND every `keyflip threads … --json` payload carry state-repo- or
  `~/.claude/projects`-relative paths and no values, so they are safe to keep in a transcript — the one
  absolute path is a resume `cwd`, which needs it. Prefer MCP or `--json` over the human output.
- `keyflip doctor` has a **threads** row: unreadable files, members with no resolvable account, and
  whether the mirror is on. Fix a no-account member with `keyflip sessions assign <id> <account>`.
- **`suggest` returning nothing is usually an assignment gap, not a clean history.** It only reports a
  folder whose sessions belong to **two or more NAMED** accounts; while nothing is assigned, nothing can
  look fragmented. `keyflip doctor`'s **threads** row and the menu's `[t]` header both count the members
  that would resume as the *current* account — if that number is the whole store, say THAT, and offer
  `keyflip sessions assign <id> <account>`, before claiming the work was never split.
- **Before a bulk `sessions assign`, run `keyflip sessions attribute` (MCP `keyflip_sessions_attribute`).**
  It infers each UNASSIGNED session's account from keyflip's own switch timeline — the action log, which
  is secret-free (account names + timestamps, no transcript is read) — and prints the evidence with a
  confidence. Dry-run by default; `--apply` (MCP: `apply:true` + `confirm:true`) fills only the gaps: a
  session the user already assigned is never proposed over, and an account that is no longer a saved
  profile is reported rather than proposed. Treat `medium`/`low`/spanning rows as guesses to confirm,
  not facts — an applied guess is recorded in `session-accounts-source.json` (a reserved state file),
  so the threads screen prints `yahoo (inferred)` until the user confirms it with `sessions assign`.

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
