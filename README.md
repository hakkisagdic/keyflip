# keyflip

**English** | [Türkçe](README.tr.md)

Switch between multiple **Anthropic / Claude Code** accounts with a click (or one command).
Log in to several accounts once, then hop between them without repeatedly logging in and out.

**Cross-platform:** macOS, Linux, and Windows. Pure Node.js, zero runtime dependencies.

[![CI](https://github.com/hakkisagdic/keyflip/actions/workflows/ci.yml/badge.svg)](https://github.com/hakkisagdic/keyflip/actions/workflows/ci.yml)

> **Platform scope.** The core — account switch, providers, sessions, the
> failover proxy, skills, MCP — is **cross-platform** (macOS/Linux/Windows,
> CI-tested on all three). The **desktop-app** features (desktop login swap,
> Cowork, session consolidation, gateway) read the Claude desktop app's data:
> they run on **macOS and Windows** (Linux has no official desktop app).
> Auto-detecting the app's account now has a **Windows path too** (DPAPI +
> AES-GCM via `src/wincrypt.js`, fixture-tested; the exact real-install paths
> still need on-device validation). `keyflip chat`, which decrypts the app's
> **browser** cookies, is **macOS-only** for now — see [docs/PORTING.md](docs/PORTING.md).

---

## Why it's safe

- **Your OAuth tokens stay in the OS credential store.** On macOS that's the Keychain; on Linux/Windows it's Claude's own `~/.claude/.credentials.json`. keyflip copies tokens *between* those slots — it adds no new plaintext token file, and this repository contains **no credentials of any kind**.
- A switch changes only two things: the live credential slot and the account pointer in `~/.claude.json` (`oauthAccount` + `userID`).
- Your session history in `~/.claude/projects` is **account-independent** — it shows up under whichever account is active.

---

## Requirements

- **Node.js ≥ 18** (Claude Code already needs Node)
- The **Claude** app / Claude Code, logged in to the account(s) you want to save
- macOS, Linux, or Windows

---

## Install

**macOS / Linux — one line** (no npm, no sudo; fetches the sources and, on macOS, builds a launcher app):

```bash
curl -fsSL https://raw.githubusercontent.com/hakkisagdic/keyflip/main/install.sh | bash
```

**Windows — PowerShell** (also creates a Start Menu / Desktop shortcut):

```powershell
irm https://raw.githubusercontent.com/hakkisagdic/keyflip/main/install.ps1 | iex
```

**Via npm (any OS):**

```bash
npm install --global @hakkisagdic/keyflip          # from the npm registry
# or straight from git (no registry needed):
npm install --global git+https://github.com/hakkisagdic/keyflip.git
```

**From a clone:**

```bash
git clone https://github.com/hakkisagdic/keyflip.git && cd keyflip && ./install.sh   # or: .\install.ps1 on Windows
```

The installer places the code in `~/.local/share/keyflip`, links `keyflip` into `~/.local/bin`, and adds it to your `PATH`. Uninstall with `./uninstall.sh` (or `npm uninstall -g keyflip`).

---

## First-time setup (find & save your accounts)

The easy way — run the guided wizard and it captures every account for you:

```bash
keyflip setup
```

It saves whatever you're logged in to right now, then loops: sign out and into
your next account (`/logout` then `/login` in Claude Code, or the desktop app) and
keyflip **detects the new login automatically and saves it** — no keypress needed.
Type `d` when you're done. Profiles are named from your email automatically.

Prefer to do it by hand? `keyflip add` saves whatever you're logged in to right now
(one account at a time). On macOS the first Keychain read shows an **“Always
Allow”** prompt — approve it.

---

## Everyday use

Run `keyflip` (or, on macOS/Windows, open the **“Keyflip”** launcher) and pick an account by number:

```
        Keyflip (keyflip)
  Active: alice@example.com

  → [1] alice@example.com
    [2] bob@example.org

  [number] switch   [a] save current   [d] delete   [r] refresh   [q] quit
```

If Claude / Claude Code is open, keyflip first asks **“Claude will be closed to switch — continue?”** On **yes** it closes Claude, switches, and reopens it (macOS); on **no** it cancels and changes nothing.

### CLI

```bash
keyflip                       # interactive menu (↑/↓ + Enter)
keyflip onboard [--manual] [--sso] [--console]   # full first-run: sign in per account, point CLI+browser
                              #   at it, sync chats, ask for the next ("p" = API-key provider; --sso = enterprise)
keyflip setup                 # lighter: log in in Claude, keyflip auto-detects & captures
keyflip login [name] [--email x] [--sso] [--console]   # official browser flow, isolated + captured (--sso = enterprise)
keyflip add [name] [--app]    # save the logged-in account(s) — CLI + desktop app
keyflip browser [status|logout|sync]   # check/reset/restore the browser claude.ai account (extension)
keyflip <name|number>         # switch to that account (asks before closing Claude)
keyflip <name> --restart      # ...close & reopen Claude without asking
keyflip <name> --force        # ...swap without closing Claude (restart it yourself)
keyflip <name> --browser      # ...also align the browser + Chrome extension to this account
keyflip next                  # rotate to the next saved account
keyflip next --strategy best  # ...or pick by remaining quota (also: next-available)
keyflip provider add <name> --base-url <url> --key-file -   # save a 3rd-party endpoint
keyflip use <name>            # route Claude Code to a provider (keyflip provider off = back)
keyflip doctor                # health check: secrets-in-git, orphaned sessions, versioning, config, login, endpoints
keyflip backup now|list|restore <n>   # snapshot keyflip metadata (no secrets)
keyflip usage --history       # per-account usage trend + failover events
keyflip usage --providers     # usage/limits across OTHER AI tools on this machine (Codex/Gemini/Cursor/Copilot/OpenRouter + Claude) — the CodexBar-style monitor
keyflip status                # which account each surface is on (CLI + desktop app)
keyflip list [--usage]        # accounts; --usage adds each one's 5h/7d utilization
keyflip autoswitch            # watch usage; auto-swap the CLI account at a threshold
keyflip link [name|--remove]  # map this directory tree to an account for `run`
keyflip shell-init <bash|zsh|fish>   # print a shell hook so `cd` auto-activates the pinned account (eval "$(keyflip shell-init zsh)")
keyflip group [list|tag <acct> <g…>|untag <acct> <g>|members <g>]   # tag accounts into pools; `next --group <g>` rotates within one
keyflip budget [status|set <acct> --5h N --7d N|clear <acct>]   # usage-% ceilings + breach/near-breach alerts (reads the usage cache)
keyflip notify [status|set --webhook URL --events a,b,c|test|off]   # push alerts on quota/switch/fleet-reply (webhook + macOS banner)
keyflip import-env [<file>] [--dry-run] [--env]   # import provider endpoints from a .env file / the environment (keys never printed)
keyflip log [--tail N] [--grep S] [--since ISO]   # view the action/audit log
keyflip run-job "<prompt>" [--group g] [--strategy best]   # ORCHESTRATOR: run a prompt headless on the best-headroom account (isolated)
keyflip jobs [list|run|clear] · keyflip fanout "<prompt>" --accounts a,b,c   # job queue + run the same prompt across N accounts
keyflip cost [status|predict <acct>|by-project]   # spend/utilization, time-to-limit prediction, per-repo attribution
keyflip team <publish|pull|members|add-member|remove-member> --dir <shared> --pool <n> --passphrase-file <f>   # ENCRYPTED team pool with roles
keyflip policy <list|allow|deny|remove|default|check> [--cwd D --account A --group G]   # constrain which account a directory may use
keyflip vault <status|use op|bw|vault|off>   # store credentials in 1Password / Bitwarden / HashiCorp Vault
keyflip route <list|set <model> <provider>|clear|arbitrage on|off> · keyflip cache <status|purge>   # model routing/arbitrage + response cache
keyflip post --to <webhook> [--status]   # post status/events to Slack/Discord/generic webhook
keyflip swarm <run "<cmd>"|ping <url>|drain --allow-exec|results>   # run a command across YOUR OWN enrolled fleet machines (exec is consent-gated; argv-array, no shell)
keyflip config <list|get <k>|set <k> <v>|unset <k>>   # one validated home for settings (E4)
keyflip ui [--fleet]          # full-screen TUI: accounts · provider usage (u) · fleet (f) · a searchable COMMAND PALETTE (p) so nothing has to be memorized
keyflip codexbar              # bridge to a locally-installed CodexBar usage monitor: align its tracked providers with keyflip's (reads no secrets)
keyflip brain "<intent>"      # OPT-IN: turn plain language into a proposed plan of keyflip steps you approve one-by-one (Gemini; only PROPOSES, never runs on its own)
keyflip surfaces              # detect other AI tools on this machine (Cursor/Gemini/Codex/Copilot/opencode/Aider) — read-only
keyflip license <status|activate <file>|deactivate>   # offline plan (Ed25519-signed, no phone-home)
keyflip run <name> [-- args]  # PARALLEL session: that account in THIS terminal only
keyflip add <name> --token <file|->   # headless import of a raw credential
keyflip mcp [--setup]         # MCP server over stdio so agents can drive keyflip
keyflip panel [--open]         # local web dashboard: accounts+quotas, activity calendar, memory constellation, sessions
keyflip panel --export <f> [--anon]   # write a share-safe STATIC snapshot (no session content, no secrets)
keyflip menubar [--install]   # menu-bar/tray plugin — macOS xbar/SwiftBar, Linux GNOME Argos/KDE kargos: account+quota at a glance, click-to-switch
keyflip statusline install    # show active account + quota in the Claude Code prompt
keyflip install-skill         # install the Claude Code skill that teaches agents keyflip
keyflip export [file|-]       # back up accounts to a file (CONTAINS SECRETS)
keyflip import <file|->       # restore accounts from an export (--force overwrites)
keyflip migrate export <file> # bundle accounts + providers + transcripts + memory + config (MCP + settings)
                              #   select a subset: --sessions <id,id> / --search T / --newer-than 7d / --only-sessions
                              #   add --agents (memory) and/or --agent-config (MCP/settings, redacted) for other AI agents
                              #   or --agent-config-secrets to carry the REAL keys between your own machines (encrypt it!)
keyflip agents                # list other agents' memory + config keyflip can carry (Cursor/Gemini/Codex/Copilot/opencode/Aider; secrets redacted)
keyflip settings [show|get <k>|set <k> <v>]   # view/edit ~/.claude/settings.json (rides `migrate` to other machines)
keyflip migrate import <file> # MERGE that bundle into this machine (union; --force overwrites)
keyflip migrate push --url <webdav>   # relay the bundle to another machine via WebDAV (encrypted)
keyflip migrate pull --url <webdav>   # pull + MERGE it on the other machine (--force overwrites)
keyflip transfer serve [--qr] # LAN: show a one-time code (+ scannable QR) + stream the encrypted bundle to a peer
keyflip transfer pull --code X # LAN: auto-discover the peer, pull + MERGE (or pass <host:port>)
keyflip transfer serve --receive   # LAN: WAIT to receive a pushed bundle (reverse direction)
keyflip transfer push <host> --code X   # LAN: SEND your bundle to a listening machine (with E2 filters)
keyflip transfer serve --relay <dir|url>   # INTERNET: same code UX, bundle goes through a synced folder / WebDAV relay (not the LAN)
keyflip transfer pull --relay <dir|url> --code <rendezvous>-<key>   # INTERNET: pull + MERGE from the relay (one-shot; deleted on pickup)
keyflip transfer relay [--dir D --host H --port P --auth-user U --auth-pass-file f]   # host your OWN zero-dep relay (no server needed)
keyflip fleet init --dir <shared-folder>   # FLEET: link this machine into a control plane (encrypted shared/synced folder)
keyflip fleet push [--with-secrets]   # publish this machine's status (accounts+quota+chat state) + apply queued commands
keyflip fleet status | panel   # see EVERY machine on one screen — accounts, quota, "reply arrived?" (panel = web dashboard)
keyflip fleet switch <machine> <account>   # switch a REMOTE machine's account (applied on its next push)
keyflip fleet send-account <acct> --to <machine> [--from <machine>]   # distribute an account (e.g. C's account to B, from A)
keyflip fleet collect         # gather every account published across the fleet onto this machine
keyflip fleet keys            # audit every machine's signing-key fingerprint (ok / CHANGED / unpinned)
keyflip fleet trust <machine> # re-pin a machine's signing key AFTER a legitimate re-key (see "Fleet — origin authentication" below)
keyflip consolidate [--watch] # sync every account's chat index so each shows ALL conversations
keyflip remove <name|number>  # delete a saved account (confirms; --force to skip)
keyflip logout [--browser] [--desktop]   # sign OUT of the live session(s) — saved accounts are kept
keyflip history | undo | restore <ref>   # git-versioned config: inspect / undo / roll back any change (secrets never committed)
keyflip reset [--soft]        # FACTORY reset: DELETE all keyflip data (--soft keeps accounts)
keyflip uninstall [--purge]   # remove keyflip from this machine (--purge also deletes data)
keyflip upgrade               # update keyflip itself (detects how it was installed)
```

### Internet transfer — the relay (zero-knowledge)

`transfer serve`/`pull` also work **across the internet**, keeping the same one-time-code UX. Instead of
a direct LAN socket the encrypted bundle travels through a **relay you control**, auto-detected from
`--relay`: a **synced folder** (Dropbox/iCloud/Drive/Nextcloud) or a **WebDAV URL**. The relay is
**zero-knowledge** — it only ever holds ciphertext. The one-time code is `<rendezvous>-<key>`: the
`rendezvous` half is a public, random lookup handle (the relay slot); the `key` half is the AES
passphrase and **never reaches the relay**, a URL, or a log. The bundle is deleted on pickup (one-shot).

No relay of your own? keyflip can **host one for you** — a self-contained, zero-dependency blob store, no
Docker, no daemon: `keyflip transfer relay --host 0.0.0.0 --auth-user me --auth-pass-file pass.txt` on a
box both machines can reach, then point `--relay http://<that-host>:8788/kf --user me --pass-file pass.txt`
at it from each side. (It refuses to bind a public interface without auth unless you pass `--allow-open`.)

### Fleet — origin authentication

The fleet coordinates machines through an **encrypted shared folder**, so the passphrase alone can't
prove *who* queued a command. Each machine therefore owns an **Ed25519 signing key**: the private key
never leaves the machine (`0600`, never the shared folder, never argv); the public key is published in
its status. Every queued command is **signed** and bound to its recipient, and a receiver
**trust-on-first-use pins** each peer's public key — then **rejects** any command whose signature
doesn't verify, is addressed to another machine, or comes from a peer whose key **changed** (a
possible key-substitution attack). So even a leaked passphrase can't let a forger command a machine.
Audit the pins with `keyflip fleet keys`; after a machine legitimately re-keys (fresh install / reset)
re-pin its new key with `keyflip fleet trust <machine>` (it prints the new key's fingerprint to verify
out-of-band first).

Global flags: `--json` (machine-readable stdout — one JSON object, `schemaVersion: 1`,
human text to stderr; ideal for scripts/status lines) and `--debug` (verbose log).
`ccs` works as a short alias. A passive "new version available" notice appears at
most once a day (never blocks a command).

### Reliability guarantees

- Every mutation runs under a **cross-process lock** — two keyflip invocations
  can't interleave a switch.
- A switch is **transactional**: the account pointer is rolled back if the live
  credential write fails, so a half-switched state never survives.
- Stored blobs are **validated** before restore; corrupt profiles are refused
  with a clean re-add message instead of being restored.
- Expiring OAuth tokens are **refreshed automatically** on switch (skipped when a
  live Claude session owns the credential; failures warn loudly).
- A locked macOS Keychain reads as **"keychain locked"** (not "no credentials"),
  with 5s timeouts; profile storage falls back to files so you can keep working.

### Third-party endpoints — providers (`provider`, `use`)

Accounts are your Anthropic **subscriptions** (OAuth). **Providers** point Claude
Code at a *different API endpoint* — a relay, a corporate gateway, AWS Bedrock,
OpenRouter, anything Anthropic-compatible — by patching the `env` block of
`~/.claude/settings.json`, which Claude Code **hot-reloads, so no restart is
needed**.

```bash
keyflip provider add openrouter --base-url https://openrouter.ai/api/v1 --key-file -   # key on stdin
keyflip use openrouter          # route Claude Code to it
keyflip provider off            # back to your subscription (OAuth)
keyflip provider list           # what's saved / active
keyflip speedtest openrouter    # time the endpoints, use the fastest
keyflip test openrouter         # one real request: is auth working?
keyflip doctor                  # health check: secrets-in-git + orphans + versioning + config + login + endpoints
```

- The **API key is a secret** → stored in the OS credential store, never in the
  metadata file and never on the command line (read it from stdin/a file).
- Switching only touches the keys keyflip manages; your own `settings.json`
  (hooks, plugins, model overrides, other env) is preserved, and `provider off`
  removes *exactly* what was injected.
- `keyflip gateway use <provider>` does the same for the Claude **desktop app**
  (restart the app to apply); `keyflip gateway off` restores it.

### Find & resume past conversations (`sessions`, `resume`)

Your Claude Code transcripts (`~/.claude/projects`) are account-independent, so
keyflip can browse and search all of them in one place and resume any one in its
original directory.

```bash
keyflip sessions --search "oauth"     # search all Claude Code conversations (preview, cwd, id)
keyflip sessions --here               # only sessions started in this directory
keyflip resume 3                      # print the resume command for list item #3
keyflip resume <id> --run             # launch `claude --resume <id>` in its dir
keyflip sessions rebind <old> <new>   # re-link a project's chat history after you renamed/moved its folder
keyflip sessions assign <id> <account>   # continue a session under another account (resume --run) — without switching profiles
keyflip send <id> "<message>" [--as <account>] [--fork]   # inject a message into a session (steer/continue it headlessly)
keyflip sessions archive <id|--older-than 30d>   # move old transcripts into keyflip (gzipped); unarchive restores them
keyflip sessions distill <id>   # summarize a chat into a durable keepsake (via `claude -p`); browse with `keyflip memory`
keyflip sessions compact <id> [--apply]   # shrink a transcript: elide bulky tool output, keep the conversation (dry-run default)
keyflip sessions scrub <id> [--apply] [--categories …] [--llm-url URL]   # redact PII (email/phone/TCKN/card/IBAN/IP/secrets + custom + optional local LLM) — dry-run default, backs up on --apply
keyflip sessions delete <id> [--hard]   # delete a conversation — archives first (recoverable) by default; --hard is a permanent unlink
keyflip sessions edit <id> <delete-message|redact-message|truncate-after> <n> [--apply]   # surgical JSONL edits (backs up; keeps the file valid)
keyflip sessions export <id> [--format md|html|json]   # export a chat as a clean, shareable doc (offline review / archive)
keyflip foreign <session-file> [--format md|html|json]   # normalize ANOTHER agent's session (JSONL / Cursor SQLite / opencode+generic JSON / Copilot YAML / Aider MD) into the same view
keyflip handoff [--to claude|cursor|kiro|opencode|windsurf|generic] [--out CONTINUE.md]   # emit a CONTINUE-PROMPT so a NEW AI tool resumes THIS project from .keyflip/ (context, tasks, decisions, rules, last checkpoint) without re-reading everything
keyflip dream [--older-than 30d] [--archive] [--apply]   # "dreaming": distill (+ archive) old chats in one pass; dry-run by default
keyflip recall "<query>" [--answer]   # search ALL your chats (BM25; --semantic=embeddings; --answer = a cited synthesis via `claude -p`)
keyflip dream schedule [--at 03:00] | unschedule | status   # run the dream nightly, unattended (launchd/cron)
keyflip cowork --search "exam"        # browse Claude desktop Cowork sessions (all accounts)
keyflip chat                          # list the active account's claude.ai Chat (experimental)
keyflip chat get <id>                 # read one cloud conversation
```

**What can be browsed across accounts:** Claude Code sessions and **Cowork**
sessions are stored locally per account — keyflip reads and (on switch)
consolidates both so every account sees them all. **claude.ai Chat** lives in the
cloud; `keyflip chat` reads it through the desktop app's own session cookie —
this is **experimental** (undocumented API) and needs a fresh Cloudflare cookie,
so it works right after using the app and may otherwise return a 403. It only
sees whichever account the desktop app is currently signed into. (App preferences,
`design/`, worktrees etc. are global/empty — nothing per-account to migrate there.)

## Context Layer — portable project memory (`.keyflip/`)

AI coding tools change; your project memory shouldn't. The Context Layer keeps a small,
tool-independent **`.keyflip/`** folder in your project directory that travels with the repo
across tools, accounts and machines. **Secrets never enter it** — every text field passes
through keyflip's secret scanner before it is written or packaged, and only environment-variable
**names** are carried, never their values. Files are written `0600`.

### Project context (`keyflip context`)

- `project.json` — id, name, description, stack, repositories, active task, last provider
- `context.md` — a freeform project summary for the next AI session
- `decisions.json` — architectural/product decisions (with rationale, alternatives, explicit "do NOT" notes)
- `tasks.json` — tasks with status, related files, done/remaining steps, acceptance criteria, known issues

```bash
keyflip context init                              # create .keyflip/
keyflip context status                            # quick summary
keyflip context decision add "Use Postgres" --rationale "ACID + team familiarity" --do-not "SQLite in prod"
keyflip context task add "Wire the payments webhook"
keyflip context task set <id> in_progress         # todo | in_progress | blocked | done
keyflip context show --json                       # the full, secret-redacted context package
```

MCP: `keyflip_context_read` (read-only), plus `keyflip_context_task_set` and `keyflip_context_decision_add` (mutating — require `confirm: true`).

### Unify AI rule files (`keyflip rules`)

Every AI tool wants its instructions in a different file — `CLAUDE.md`, `.cursorrules`, `.cursor/rules/*`,
`AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`. `keyflip rules` reads whatever is present,
**normalizes** them into one common model (each section classified coding / architecture / security /
workflow / general, provenance kept), and **re-emits** that model as the file any single tool expects.

```bash
keyflip rules show                     # detect rule files + preview the normalized model
keyflip rules import                   # cache the model at .keyflip/rules.json
keyflip rules emit --to claude         # print CLAUDE.md content built from every tool's rules
keyflip rules emit --to cursor --write # write .cursorrules into the project
```

Targets: `claude` (CLAUDE.md), `cursor` (.cursorrules), `agents` (AGENTS.md), `gemini` (GEMINI.md), `generic` (RULES.md). Every imported and emitted line passes through the secret scanner — a key pasted into a rule file is **redacted** before it enters the shared model or any generated file. MCP: `keyflip_rules_show` (read-only), `keyflip_rules_emit` (returns the content; writes the file only with `confirm=true`).

### Checkpoints — git-bound session snapshots

Capture a project at a session boundary so you (or the next agent) can pick up exactly where you left off.
A checkpoint records the git branch, short commit, and dirty (uncommitted) files, plus a human summary,
an optional task snapshot, and the active provider — chained (`parent`) into a history under
`.keyflip/checkpoints/`, so it travels with the repo.

```bash
keyflip checkpoint create --summary "finished auth refactor; tests green"
keyflip checkpoint list             # newest first
keyflip checkpoint latest           # the most recent one
keyflip checkpoint show <id>        # full detail for one checkpoint
```

- **Secret-safe:** every text field (summary, provider, git paths, and every value inside the task snapshot) is scanned and redacted before it is hashed or written — API keys and tokens never enter a checkpoint.
- **Read-only:** `checkpoint show` and the MCP `keyflip_checkpoint_*` tools only *read* a checkpoint. keyflip never runs git or changes your working tree — you decide what to do with the recorded state.
- **Content hash:** each checkpoint carries a `contentHash` (sha256 of its canonical body) for later conflict detection across machines.

MCP: `keyflip_checkpoint_list`, `keyflip_checkpoint_latest` (read-only), `keyflip_checkpoint_create` (mutating — requires confirmation).

### Handoff — a continue-prompt for the next tool

When a project changes AI tool (Kiro → Cursor → Claude Code → opencode → Windsurf),
`keyflip handoff --to <tool>` turns the portable `.keyflip/` memory into a single markdown prompt:
which tools the project moved across, the files to read, the active task (done / remaining / known
issues), the decisions the new tool must NOT change without explaining, and a target-appropriate
closing instruction. Secret-safe — every field is re-scanned, only env-var **names** travel. Also the
read-only MCP tool `keyflip_handoff`.

### Context-sync privacy modes

The Context Layer can build a shareable `.keyflip/` package for a project. A privacy **mode** decides
what may leave the machine, and **every text field is secret-scanned before it is packed — in every mode**
(defence in depth): a token or key can never enter the shared context.

| Mode | What ships |
| --- | --- |
| `local` | Nothing — never leaves the machine (default). |
| `git` | Plain in the repo (the repo carries `.keyflip/`). |
| `encrypted` | Passphrase-sealed (AES-256-GCM) for cloud/WebDAV. |
| `company` | Raw conversations + source snippets stripped; only approved providers shared. |

```bash
keyflip context sync status                              # current mode + policy + checkpoint
keyflip context sync mode company                        # switch privacy mode
keyflip context sync export --passphrase-file pass.txt   # emit the sync payload (stdout)
keyflip context sync check --against incoming.json       # dry-run: what ships, secrets scrubbed, conflicts
```

Env-var **values are never carried** — only the variable name and a description. Conflict detection compares a content hash against a parent checkpoint: if two machines edited the same base, `check` flags a conflict and offers `use-new` / `use-old` / `merge` / `two-branches`. Agents read the mode via `keyflip_ctxsync_status` and change it (with confirmation) via `keyflip_ctxsync_mode`.

### Install skills, and the failover proxy

```bash
keyflip skill add anthropics/skills   # install any skill from GitHub / ./dir / file.tgz
keyflip skill list | keyflip skill remove <name>   # only touches keyflip-installed skills

keyflip proxy start --wire            # start a localhost failover proxy + wire Claude to it
keyflip proxy status | keyflip proxy stats
keyflip proxy stop                    # stop it (and unwire)
```

The **proxy** is command-started (never an always-on daemon): while running it
routes each API request to your active account and, on a `429`/`5xx` before any
byte reaches the client, **fails over to the next healthy account and retries** —
request-level failover beyond what usage-threshold `autoswitch` can do. It binds
`127.0.0.1` only.

### Auto-switch on usage (`autoswitch`)

`keyflip autoswitch --threshold 90 --interval 60 --strategy next-available`
watches the active account and, when its 5h/7d utilization crosses the
threshold, **swaps the CLI credential automatically** to the chosen account —
without closing anything (Claude Code picks the new account up on its next
request). It confirms once at start (`-y` for scripts) and never touches the
desktop app. Pair with `keyflip link <name>` to pin directories to accounts:
`keyflip run` with no name uses the nearest linked ancestor directory.

**Run it unattended** so you don't have to keep a terminal open (and so rotation
actually happens while you work in Claude): `keyflip autoswitch install` registers
a background service (launchd `StartInterval` on macOS, cron `*/N` on Linux) that
runs a single `keyflip autoswitch --once` check on an interval. `keyflip autoswitch
status` shows whether it's active; `keyflip autoswitch uninstall` stops it.
Defaults (threshold/strategy/group/interval) come from `keyflip config` if flags
aren't given. MCP: `keyflip_autoswitch_service` (`action=status|install|remove`).

### For agents: MCP server & skill

Agents shouldn't have to guess the CLI — keyflip speaks **MCP**:

```bash
claude mcp add keyflip -- keyflip mcp     # or see: keyflip mcp --setup
```

**The full CLI surface is exposed as 130+ MCP tools**, so an agent can do
everything without shelling out — accounts (`keyflip_status/list/switch/next/add/account_remove`),
providers (`keyflip_providers`, `keyflip_provider_use/add/remove`, `keyflip_test_provider`,
`keyflip_speedtest`), the **fleet** control plane (`keyflip_fleet_status/switch/send_account/collect/keys/trust`),
sessions (`keyflip_sessions`, `keyflip_resume_command`, archive/distill/compact), migrate + LAN
(`keyflip_migrate_*`, `keyflip_transfer_pull`), WebDAV sync (`keyflip_sync_test/push/pull`),
`keyflip://` links (`keyflip_share/share_apply`), desktop gateway (`keyflip_gateway_*`), MCP-server
registry (`keyflip_mcpreg_*`), directory pins (`keyflip_link/links`), diagnostics
(`keyflip_doctor`, `keyflip_usage_history`), backups, skills, and the failover proxy. Every tool has a proper JSON Schema and read-only/
destructive annotations; **mutating tools require `confirm: true`** and their
descriptions tell the agent to ask the user first. Secrets are never accepted
through MCP — e.g. adding a provider key is deferred to `--key-file` on the CLI.

There's also a bundled **Claude Code skill** that teaches the agent when and
how to use all of this (rate-limit playbook, sentinels, parallel sessions):

```bash
keyflip panel [--open]         # local web dashboard: accounts+quotas, activity calendar, memory constellation, sessions
keyflip panel --export <f> [--anon]   # write a share-safe STATIC snapshot (no session content, no secrets)
keyflip menubar [--install]   # menu-bar/tray plugin — macOS xbar/SwiftBar, Linux GNOME Argos/KDE kargos: account+quota at a glance, click-to-switch
keyflip statusline install    # show active account + quota in the Claude Code prompt
keyflip install-skill      # copies it to ~/.claude/skills/keyflip
```

### Parallel sessions (`run`)

`keyflip run <name>` launches Claude Code as that account **in the current
terminal only** — every other terminal, the desktop app and VS Code keep their
current account, so two accounts can work side by side. Your `~/.claude`
customizations (settings, keybindings, CLAUDE.md, skills, commands, agents)
follow you in via symlinks (`--no-share` for a bare profile); conversation
history stays per-account. Everything after `--` is forwarded to `claude`
(e.g. `keyflip run work -- --resume`). If the session refreshes the token,
keyflip saves it back to the profile on exit.

> ⚠️ **Asks for confirmation first** (skip with `-y`): a token refresh inside a
> parallel session rotates that account's refresh token, which can log out
> *other live copies of the same account*.

### Headless import (`add --token`)

`keyflip add <name> --token <file|->` saves a raw credentials JSON blob
(`{"claudeAiOauth":{...}}`) as an account without any login flow — for CI or
provisioning. The blob is read from a **file or stdin, never argv**. It asks
for confirmation on a TTY; piped/scripted use must pass `--force`, and
overwriting an existing account always requires `--force`.

### VS Code

The VS Code Claude Code extension shares the CLI's credential store, so every
keyflip switch already applies to it (reload the window to pick it up). A thin
companion extension in [`vscode-keyflip/`](vscode-keyflip/) adds a status-bar
account indicator (with 5h/7d quota in the switcher), a QuickPick account switcher,
a one-click **Open Dashboard** (`keyflip panel`), and a status view — see its
[README](vscode-keyflip/README.md) ([TR](vscode-keyflip/README.tr.md)) for local install.


### Seeing all your sessions after a switch (macOS)

The Claude **desktop app** keeps its "Recents" as a per-account index at
`~/Library/Application Support/Claude/claude-code-sessions/<accountUuid>/<orgUuid>/`,
so by default each account only shows the Code sessions you started under it.

On every switch (while the app is closed), keyflip **consolidates** that index —
copying the Code-session pointers from your other accounts into the active one, so
its Recents shows them all. It backs up the store first and only ever *adds* files
(never deletes).

> Your `~/.claude/projects` transcripts are account-independent already; this just
> makes the app's list surface them. **Cloud "Chat" conversations (claude.ai) are
> not touched** — they live server-side per account and can't be merged locally.

### Switching the desktop app's login too (macOS, experimental)

The Claude **desktop app** has its own login, separate from the CLI. Its *actual*
session is the claude.ai cookie in its `Cookies` DB (the `oauth:tokenCache` blobs
in `config.json` are just a cache the app re-derives from that cookie on launch).
keyflip therefore captures and swaps **both** — so `keyflip <name>` can flip the
CLI *and* the desktop app to the same account, once each account's desktop login
has been captured.

The desktop app's login is **independent** from the CLI's — they can even be on
different accounts at the same time. `keyflip add` captures **whatever is signed
in right now**: the CLI login and/or the desktop app's (auto-detected). So per
account: sign in (app and/or CLI), run `keyflip add`, done. `keyflip list`
shows what each account has captured (`[cli ✓|— | app ✓|—]`); if the app's account
can't be auto-identified, name it explicitly (`keyflip add <name> --app`).

After that, `keyflip <name>` (app closed → reopened) swaps the CLI creds **and**
the desktop-app login (token + session cookie), so both come up on the chosen
account — no manual re-login. `config.json` and the cookie DB are backed up first
(`~/.config/keyflip/backups/`).

> Experimental: it rewrites the app's `config.json` login while the app is closed.
> If a saved token has fully expired the app may ask you to log in again; just
> re-`add` that account. Restore a backup if anything looks off.

> Switching should happen while Claude is closed, or Claude may overwrite the change on exit.
> - **Interactive** (menu, or `keyflip <name>` in a terminal): if Claude is open you're **asked before it's closed** — answer *no* to cancel.
> - `--restart`: close & reopen Claude without asking (macOS).
> - `--force`: switch without closing Claude — restart it yourself afterward. If the **desktop app** is running on another account it can rewrite the shared login and undo the swap; `--force` warns you and suggests `--restart`.
> - Non-interactive (piped/CI) with Claude open and no flag: refuses rather than closing your app unexpectedly.

---

## Alternatives & how keyflip compares

The Claude tooling space is crowded, but most tools do **one** of these jobs;
keyflip combines them in a single CLI+MCP tool with **no GUI and no always-on
daemon**, and it's the rare one that also swaps the **desktop app's** login.

| Project | Stars | Type | What it does | keyflip also… |
|---|---|---|---|---|
| [farion1231/cc-switch](https://github.com/farion1231/cc-switch) | 112k | Rust/Tauri **GUI** | All-in-one provider + MCP + skills manager for 7 AI CLIs | …does providers/MCP/skills **in CLI+MCP**, plus OAuth account & desktop-app switching |
| [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) | 35k | TS router | Routes requests to different models/providers (rules, transformers) | …has a **command-started** failover proxy (not an always-on router) |
| [Wei-Shaw/claude-relay-service](https://github.com/Wei-Shaw/claude-relay-service) | 12k | Hosted relay | Self-hosted multi-account relay + dashboard | …pools/rotates accounts **locally**, no server to run |
| [realiti4/claude-swap](https://github.com/realiti4/claude-swap) | 712 | Python CLI | Switch Claude Code **accounts** (our original inspiration) | …+ providers, proxy, desktop app, sessions, MCP |
| [jolehuit/clother](https://github.com/jolehuit/clother) | 371 | Go CLI | Multi-provider switch | …+ accounts, proxy, sessions, desktop, MCP |
| [guyskk/claude-code-config-switcher](https://github.com/guyskk/claude-code-config-switcher) | 83 | Go CLI | Provider switch (Kimi/GLM/MiniMax…) | …+ everything above |
| [Danielmelody/ccconfig](https://github.com/Danielmelody/ccconfig) | 62 | JS CLI | Quick provider switch | …+ everything above |
| [yaakua/cc-copilot](https://github.com/yaakua/cc-copilot.com) | 56 | TS GUI | Desktop GUI: projects + providers + sessions | …CLI+MCP, agent-drivable |

**keyflip's niche:** OAuth **account** switching **+** third-party **provider**
routing **+** a **failover proxy** **+** **desktop-app** login swap **+**
session/Cowork/Chat browsing **+** a full **MCP** surface + agent skill — one
dependency-free tool, tokenless-published with provenance. It's brand new (no
mindshare yet); the giants above have far more users, and keyflip's desktop-app
crypto features are macOS-first (see *Platform scope* above).

---

## How it works

| Piece | macOS | Linux / Windows |
|------|-------|-----------------|
| Live login token | Keychain item `Claude Code-credentials` | `~/.claude/.credentials.json` |
| Saved profile tokens | Keychain items `keyflip:<name>` | `~/.config/keyflip/creds/<name>.cred` (0600) |
| Account identity | `oauthAccount` + `userID` in `~/.claude.json` | same |
| Profile metadata (no secrets) | `~/.config/keyflip/<name>.json` (0600) | same |

The backend is auto-detected: if a credentials **file** already exists it's used (any OS); otherwise macOS uses the Keychain. A switch copies the saved token into the live slot **and** patches the two fields in `~/.claude.json`. When switching *away*, keyflip first re-saves the current account's (possibly refreshed) token so nothing goes stale — including auto-saving a logged-in account you hadn't saved yet, so its token isn't lost.

### Security notes

- **Config integrity:** writes to `~/.claude.json` are atomic and preserve the file's mode; if that file exists but is not valid JSON, keyflip refuses to touch it rather than risk clobbering your settings.
- **macOS Keychain:** tokens are written by feeding `security -i` on **stdin** (hex-encoded), so the secret never appears in the process table; `/usr/bin/security` is invoked by absolute path. (Only blobs too large for the stdin line-length budget fall back to an argv write.)
- **Exports:** `keyflip export` files contain login secrets — they're written `0600` with a loud warning; pipe to `-` and encrypt (e.g. gpg) for transport, and delete after importing.
- Switch while Claude is closed. The macOS app/`--restart` quit and reopen it for you; elsewhere keyflip warns if Claude is running and asks you to restart it after switching.

---

## Testing & CI — how "all versions" is covered

You don't need to own every OS. Two layers:

1. **Hermetic unit tests** (`node --test`, in `test/`). The credential store and `~/.claude.json` are abstracted behind a context object, so tests inject an in-memory store and a temp home directory. The logic is OS/version-independent, so these tests exercise it identically everywhere.

   ```bash
   npm test
   ```

2. **GitHub Actions matrix** (`.github/workflows/ci.yml`) runs the suite on **`ubuntu-latest` + `macos-latest` + `windows-latest`** across **Node 18 / 20 / 22** — real different OSes and versions, on every push. That is the "simulate different versions" part, for free.

Add more Node versions or OS images by editing the `matrix` in the workflow.

---

## Troubleshooting

- **Corporate proxy / TLS interception:** token refresh and usage checks hit
  Anthropic over HTTPS with Node's bundled CAs. Behind a MITM proxy, point Node
  at your CA bundle: `export NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem`.
- **`[throttled]` in `list --usage`:** the usage *endpoint* throttled that
  token — it does **not** mean the account is rate-limited. Try again later.
- **`[expired]`:** the stored token can't authenticate anymore — log that
  account in once and run `keyflip add`.
- **"keychain locked":** unlock the login keychain; keyflip's own profile
  storage falls back to files automatically so you can keep working.

---

## Reset & uninstall

```bash
keyflip reset                # FACTORY reset — DELETE all keyflip data (accounts,
                             #   providers, backups, history), keeping keyflip installed.
                             #   Your live Claude login is NOT touched; ~/.claude/projects kept.
keyflip reset --soft         # keep accounts; clear only runtime state (history, breakers,
                             #   proxy state, caches, logs) + route Claude Code back to the sub
keyflip reset --logout       # (factory or --soft) also CLOSE + sign OUT every live surface:
                             #   CLI (kills running Claude Codes), browser (quits it + clears
                             #   claude.ai/extension), desktop app (quits, stays closed) — total zero
keyflip reset --logout --no-desktop   # ...but leave the desktop app signed in (e.g.
                             #   when you're using it right now)

keyflip uninstall            # remove keyflip from this machine, keep saved data
keyflip uninstall --purge    # ...and delete saved data + Keychain items too
```

`uninstall` auto-detects how keyflip was installed (the `install.sh` layout or an
npm global) and removes the right things; it never touches your live Claude login
(run `keyflip reset --logout` first if you also want to sign out) or a source
checkout. The shell script still works too:

```bash
./uninstall.sh               # macOS/Linux: remove CLI + app, keep saved profiles
./uninstall.sh --purge       # also delete saved profiles
npm uninstall -g keyflip     # if installed via npm (any OS)
```

---

## Publishing (maintainers)

Releases publish to npm via **Trusted Publishing (OIDC)** — no `NPM_TOKEN`
secret lives in this repo (GitHub Actions proves its identity to npm with a
short-lived token; provenance is attached automatically).

One-time bootstrap (a package must exist before its trusted publisher can be
configured):

1. **First publish, manually** from your machine — this uses your interactive
   `npm login`, not a stored token:
   ```bash
   npm login
   npm publish --access public        # creates @hakkisagdic/keyflip
   ```
2. On **npmjs.com** → the package → **Settings → Trusted Publisher → GitHub
   Actions**, enter: user `hakkisagdic`, repository `keyflip`, workflow
   `publish.yml`. Save.
3. From then on it's fully automated & tokenless: bump `version` in
   `package.json`, then
   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
   `release.yml` verifies the tag, tests, and cuts a GitHub Release; publishing
   that Release fires `publish.yml`, which publishes to npm over OIDC.

---

## License

[MIT](LICENSE)

---

*Not affiliated with Anthropic. “Claude” and “Claude Code” are trademarks of Anthropic.*
