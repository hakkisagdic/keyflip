# keyflip

**English** | [Türkçe](README.tr.md)

Switch between multiple **Anthropic / Claude Code** accounts with a click (or one command).
Log in to several accounts once, then hop between them without repeatedly logging in and out.

**Cross-platform:** macOS, Linux, and Windows. Pure Node.js, zero runtime dependencies.

[![CI](https://github.com/hakkisagdic/keyflip/actions/workflows/ci.yml/badge.svg)](https://github.com/hakkisagdic/keyflip/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/keyflip)](https://www.npmjs.com/package/keyflip)
[![Node.js](https://img.shields.io/node/v/keyflip)](https://nodejs.org)
[![License: MIT](https://img.shields.io/github/license/hakkisagdic/keyflip)](https://github.com/hakkisagdic/keyflip/blob/main/LICENSE)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](https://github.com/hakkisagdic/keyflip)
[![GitHub stars](https://img.shields.io/github/stars/hakkisagdic/keyflip)](https://github.com/hakkisagdic/keyflip/stargazers)

> **Platform scope.** The core — account switch, providers, sessions, the
> failover proxy, skills, MCP — is **cross-platform** (macOS/Linux/Windows,
> CI-tested on all three). The **desktop-app** features (desktop login swap,
> Cowork, session consolidation, gateway) read the Claude desktop app's data:
> they run on **macOS and Windows** (Linux has no official desktop app).
> Auto-detecting the app's account now has a **Windows path too** (DPAPI +
> AES-GCM via `src/wincrypt.js`, fixture-tested; the exact real-install paths
> still need on-device validation). `keyflip chat`, which decrypts a **browser**
> cookie (the desktop app's, or a browser signed into claude.ai), is **macOS-only**
> for now — see [docs/PORTING.md](docs/PORTING.md).

---

## Why it's safe

- **Your OAuth tokens stay in the OS credential store.** On macOS that's the Keychain; on Linux/Windows it's Claude's own `~/.claude/.credentials.json`. keyflip copies tokens *between* those slots — it adds no new plaintext token file, and this repository contains **no credentials of any kind**.
- A switch changes only two things: the live credential slot and the account pointer in `~/.claude.json` (`oauthAccount` + `userID`).
- Your session history in `~/.claude/projects` is **account-independent** — it shows up under whichever account is active.

---

## Passkeys & device-bound credentials

Claude (web and the desktop app) now offers **passkey (WebAuthn) sign-in**. What that means for keyflip:

- **A passkey replaces the login step, not the session.** After WebAuthn the client still receives ordinary session credentials — exactly what keyflip saves and swaps. Adding a passkey does not invalidate existing profiles or saved logins.
- **Synced passkeys follow your Apple ID.** On macOS, passkeys created in Safari/Chrome live in iCloud Keychain and already work on every Mac signed into the same Apple ID. keyflip never exports WebAuthn credentials — no transfer is needed or offered. Touch ID is only the local unlock: biometric data never leaves the device and is never part of a capture.
- **Device-bound passkeys and hardware security keys cannot be moved.** If an account is bound to one, the only way onto a new machine is an interactive login there.
- **Desktop-app logins stay machine-specific.** The app's cookies are encrypted with that machine's Safe Storage key, which is why `keyflip transfer` deliberately excludes them (re-run `keyflip add` on each machine instead).

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

  [number] switch   [a] save current   [d] delete   [t] threads   [r] refresh   [q] quit
```

`[t]` opens the **threads** screen: the same task, named, when it is spread over two accounts' sessions
because quota ran out mid-work. It lists every thread with its members — which account each one belongs
to, where its transcript is, how fresh it is, and the exact `cd … && claude --resume …` line that would
continue it — plus `[s]`, which *looks for* split work instead of asking you to remember it. It is
read-only on purpose: it never reads a transcript body, never writes, never spends quota, and printing a
thread's name is the only way to change one (`keyflip threads create|add|open …`). An unassigned member
is flagged with the fix, because a session keyflip cannot attribute would resume as the *current*
account — that is how a task silently fragments.

If Claude / Claude Code is open, keyflip first asks **“Claude will be closed to switch — continue?”** On **yes** it closes Claude, switches, and reopens it (macOS); on **no** it cancels and changes nothing.

### CLI

```bash
keyflip                       # interactive menu (↑/↓ + Enter)
keyflip onboard [--manual] [--sso] [--console]   # full first-run: sign in per account, point CLI+browser
                              #   at it, sync chats, ask for the next ("p" = API-key provider; --sso = enterprise)
keyflip setup                 # lighter: log in in Claude, keyflip auto-detects & captures
keyflip login [name] [--email x] [--sso] [--console]   # official browser flow, isolated + captured (--sso = enterprise)
keyflip add [name] [--app] [--dry-run]   # save the logged-in account(s) — CLI + desktop app (--dry-run = plan only)
keyflip browser [status|logout|sync]   # check/reset/restore the browser claude.ai account (extension)
keyflip <name|number>         # switch EVERY surface to that account — CLI, desktop app and the
                              # browser's claude.ai session (so the Chrome extension too); a surface
                              # with no saved login is skipped and named, the rest still switch
keyflip <name> --only cli     # ...just these surfaces: cli | app | browser (comma-separated)
keyflip <name> --restart      # ...close & reopen Claude without asking
keyflip <name> --force        # ...swap without closing Claude (restart it yourself)
keyflip <name> --browser      # ...also close an open browser that won't restore its tabs (by
                              # default such a browser is skipped, never closed behind your back)
keyflip <name> --dry-run      # ...show the PLAN first: what would be written, what blocks it, and
                              # whether that account can even authenticate — changes NOTHING
keyflip <name> --no-verify    # ...skip the read-back every switch does by default (see `verify`)
keyflip <name> --rollback-on-fail  # ...and if that read-back says the switch didn't land a usable
                              # account, put the previous one back (opt-in: it re-writes credentials)
keyflip next                  # rotate to the next saved account
keyflip next --strategy best  # ...or pick by remaining quota (also: next-available)
keyflip provider add <name> --base-url <url> --key-file -   # save a 3rd-party endpoint
keyflip use <name>            # route Claude Code to a provider (keyflip provider off = back)
keyflip doctor                # health check: secrets-in-git, orphaned sessions, versioning, config, login, endpoints, desktop app session
                              #   add --history to also scan every blob keyflip ever committed for a reachable secret
keyflip backup now|list|restore <n>   # snapshot keyflip metadata (no secrets)
keyflip usage --history       # per-account usage trend + failover events
keyflip usage --providers     # usage/limits across OTHER AI tools on this machine (Codex/Gemini/Cursor/Copilot/OpenRouter + Claude) — the CodexBar-style monitor
keyflip api status            # the monthly Claude API credit a Max/Team plan grants its linked Console org
                              #   (Admin key reads usage; the balance shown is an estimate)
keyflip status                # which account each surface is on (CLI + desktop app)
keyflip verify [acct] [--usage] [--live]   # would switching there WORK right now? reads the stored/live
                              # token expiry, the app cookie capture (its session cookie + its expiry),
                              # the token cache and the browser capture age — never a secret value
keyflip refresh [acct|--all]  # revive stored OAuth tokens; refuses while a Claude is running them
                              # (rotating one under a live session logs a surface out)
keyflip refresh --schedule [--at 04:30] | --unschedule | --schedule-status
keyflip freshness [--json]    # how old every saved login is: CLI token + claude.ai sign-ins (alias: age)                              # put `refresh --all` on a nightly timer (launchd/cron) — tokens expire on
                              # the calendar, not on the day you switch; run it unattended while idle
keyflip chains [acct] [--tighten [--apply]]   # what one login is MADE of: which store each capture was
                              # copied from, who can renew each part (the tool / keyflip on switch / a fresh
                              # capture / only a human), and what is stale, shared or world-readable.
                              # Stats only — it never reads a secret and never queries the Keychain
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
keyflip fleet discover   # find other keyflip machines on this LAN (UDP multicast; no shared folder needed)
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
keyflip doctor --history      # is a secret still readable from an OLD commit? (scan every blob; reports kind, never content)
keyflip scrub-history [--apply]  # remove them from history (dry-run first; bundle backup + git-filter-repo; --include-tracked to touch live files)
keyflip secrets list | tolerate <path> [--kind K] | untolerate <path>  # which findings are EXPECTED (a free/rotated/dead key): ends the alarm and the rotation nag, never the clean-up
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

### Fleet — adding a machine (pairing, no silent trust)

A machine is **never trusted on first sight**. Publishing into the folder only makes a peer
*visible* (`pending` on `push`, `unpinned` in `fleet keys`); its commands are ignored until its key
is pinned. Two ways to pin:

- **`keyflip fleet invite` / `keyflip fleet join <host-id> --code <code>`** — the inviter mints a
  one-time code (shown once, ~15 min) and writes an invite file **encrypted with that code**; the
  joiner opens it with the code, pins the inviter, and writes a code-encrypted join back; the
  inviter's next `fleet push --accept-join <host-id> --code-file <f>` pins the joiner. Both ends pin
  only a key proven by the code — a leaked passphrase alone can't add a machine.
- **`keyflip fleet trust <machine>`** — after comparing the fingerprints by hand (`fleet keys`).

A pinned key that later **CHANGES** is a conflict (possible key-substitution) and is never
overwritten silently.

### Fleet — finding the other machines (LAN discovery)

The rendezvous folder works anywhere, but it needs a path set up on every machine and a sync
round-trip before peers show up. On one network there is a faster way: `keyflip fleet discover`
sends and listens for a **UDP multicast beacon** and lists the keyflip machines that answer — no
shared folder configured yet, no passphrase. It also **announces this machine** while it listens
(ON by default; `keyflip fleet announce off` or `--no-announce` opts out). The beacon carries
**public identity only** (machine id, display name, and the short SHA-256 fingerprint of the Ed25519
signing key) — never the passphrase, a private key, or a command — so the listing is safe to print.
A discovered peer is only *reachable*: acting on one still needs the passphrase AND a pinned key
(pair it as above). A network that blocks multicast simply reports "found nobody", and the shared
folder stays the fallback.

### Fleet — origin authentication

The fleet coordinates machines through an **encrypted shared folder**, so the passphrase alone can't
prove *who* queued a command. Each machine therefore owns an **Ed25519 signing key**: the private key
never leaves the machine (`0600`, never the shared folder, never argv); the public key is published in
its status. Every queued command is **signed** and bound to its recipient, and a receiver **rejects**
any command whose signature doesn't verify, is addressed to another machine, or comes from a peer
whose key **changed** (a possible key-substitution attack). A peer's key is pinned only by the
**invite/join pairing** (see above) or an explicit `fleet trust` — never on first sight — so a leaked
passphrase can neither forge a command NOR add a machine. Audit the pins with `keyflip fleet keys`;
after a machine legitimately re-keys (fresh install / reset) re-pin its new key with
`keyflip fleet trust <machine>` (it prints the new key's fingerprint to verify out-of-band first).

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
keyflip doctor                  # health check: secrets-in-git + orphans + versioning + config + login + endpoints + desktop app session + is the desktop app really signed in
```

- The **API key is a secret** → stored in the OS credential store, never in the
  metadata file and never on the command line (read it from stdin/a file).
- Switching only touches the keys keyflip manages; your own `settings.json`
  (hooks, plugins, model overrides, other env) is preserved, and `provider off`
  removes *exactly* what was injected.
- `keyflip gateway use <provider>` does the same for the Claude **desktop app**
  (restart the app to apply); `keyflip gateway off` restores it.

### The monthly API credit (`api`)

Since 7 Oct 2026 a Claude **Max** or **Team** subscription also carries a monthly
**Claude Platform (Console) API credit**: Max 5x $100, Max 20x $200, Team per seat
(capped at $500). The claude.ai account links exactly **one Console organization**
(claude.ai → Settings → Billing → API credits → *Link organization*); the credit
refreshes each billing cycle, never rolls over, and is spent before prepaid funds.

`keyflip api` follows that credit for every account you save:

```bash
keyflip api add hakkisagdic --plan max20x --cycle-day 8 --admin-key-file -   # Admin key on stdin
keyflip api orgs hakkisagdic      # the orgs that admin key can see (pick the linked one)
keyflip api status                # per org: grant, spent this cycle, what is left
keyflip api status --json --offline
keyflip api set hakkisagdic --balance 137.42   # manual mode: record what the Console shows
keyflip api remove hakkisagdic
```

- The **Admin API key is a secret** (`sk-ant-admin01-…`, Console → Settings → API
  Keys) → stored in the OS credential store (`keyflip:admin-key` / `api:<account>`),
  never in the metadata file, never on the command line. It is sent to exactly one
  host: `api.anthropic.com`.
- The Console shows the true remaining balance, but **no API reads it** — so
  `status` reads the Admin **cost report** for the current cycle and subtracts:
  *the number shown is an estimate* (grant − spent), labelled as one. Plan grants
  are known (`--plan`); a **Team** org must be told its grant once (`--grant`).
- **Individual orgs have no Admin API at all** ("The Admin API is unavailable for
  individual accounts" — the admin-keys page 404s there), so those accounts run in
  **manual mode**: `api add` without `--admin-key-file`, then read the Credits
  balance in the Console and record it with `api set <account> --balance <usd>`.
  Each reading is one entry in `api-accounts.json` (a number and a timestamp —
  never a secret, capped at 200); `status` prints the last balance, the trend
  since the previous reading and the reset date, no network needed. Re-adding
  the account later (e.g. to attach a key) keeps the readings.
- `--cycle-day` is the day of month the credit lands (default `1`); set it to the
  account's subscription renewal day and the cycle window is always right.

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
keyflip sessions attribute            # guess each UNASSIGNED session's account from keyflip's own switch timeline (dry run; --apply to write)
keyflip threads                        # ONE name for the sessions that are the same task, ACROSS accounts (pointers, never a copy)
keyflip threads suggest                # find work that is ALREADY split over 2+ accounts — no guessing ids
keyflip threads create <slug> --title "…"   # then: keyflip threads add <slug> <session-id|--chat uuid> [--account <name>]
keyflip threads show <slug> [--timeline] [--md]   # the thread as one merged, chronological view (--md = the document only)
keyflip threads open <slug> [--run]    # resume where the thread last stopped, as the account that owns it
keyflip threads where <id> | remove <slug> <id> | drop <slug> -y   # locate / unlink / forget the NAME (transcripts are untouched)
keyflip threads mirror <slug> | unmirror <slug>   # opt-in: write the merged conversation text to thread-mirror/ (needs `config set threads.mirror true`)
keyflip send <id> "<message>" [--as <account>] [--fork]   # inject a message into a session (steer/continue it headlessly)
keyflip sessions archive <id|--older-than 30d>   # move old transcripts into keyflip (gzipped); unarchive restores them
keyflip sessions distill <id>   # summarize a chat into a durable keepsake (via the chore model — see `keyflip llm`); browse with `keyflip memory`
keyflip sessions compact <id> [--apply]   # shrink a transcript: elide bulky tool output, keep the conversation (dry-run default)
keyflip sessions scrub <id> [--apply] [--categories …] [--llm-url URL]   # redact PII (email/phone/TCKN/card/IBAN/IP/secrets + custom + optional local LLM) — dry-run default, backs up on --apply
keyflip sessions delete <id> [--hard]   # delete a conversation — archives first (recoverable) by default; --hard is a permanent unlink
                                    # refuses a session a running `claude --resume` process holds (--allow-running overrides)
keyflip sessions backups [--apply]  # find rebind's hidden .keyflip-bak duplicates; --apply removes ONLY the ones
                                    # proven redundant (byte-identical in the live key AND the session id re-landed elsewhere)
keyflip sessions empty [--apply]    # list project folders holding zero files; --apply prunes them. memory-only and
                                    # sidecar-only keys are reported by kind and never removed
keyflip sessions edit <id> <delete-message|redact-message|truncate-after> <n> [--apply]   # surgical JSONL edits (backs up; keeps the file valid)
keyflip sessions export <id> [--format md|html|json]   # export a chat as a clean, shareable doc (offline review / archive)
keyflip foreign <session-file> [--format md|html|json]   # normalize ANOTHER agent's session (message-event JSONL — Claude Code/opencode/Gemini/Qoder CLI — / Cursor SQLite / generic JSON / Copilot YAML / Aider MD) into the same view
keyflip handoff [--to claude|cursor|kiro|opencode|windsurf|generic] [--out CONTINUE.md]   # emit a CONTINUE-PROMPT so a NEW AI tool resumes THIS project from .keyflip/ (context, tasks, decisions, rules, last checkpoint) without re-reading everything
keyflip dream [--older-than 30d] [--archive] [--apply]   # "dreaming": distill (+ archive) old chats in one pass; dry-run by default
keyflip recall "<query>" [--answer]   # search ALL your chats (BM25; --semantic=embeddings; --answer = a cited synthesis by the chore model)
keyflip dream schedule [--at 03:00] | unschedule | status   # run the dream nightly, unattended (launchd/cron)
keyflip llm [status|set --provider claude|ollama|openai [--model M] [--base-url U] [--key-env NAME]|test [--timeout ms]|off]   # which model runs those chores — and whose quota it burns
keyflip cowork --search "exam"        # browse Claude desktop Cowork sessions (all accounts)
keyflip chat                          # list claude.ai Chat (experimental) — `--as <acct>` reads another account
keyflip chat get <short-id|title>     # read one cloud conversation (the short id from any listing works)
keyflip chat search "<words>"         # find a cloud chat by title
```

**What can be browsed across accounts:** Claude Code sessions and **Cowork**
sessions are stored locally per account — keyflip reads and (on switch)
consolidates both so every account sees them all. **claude.ai Chat** lives in the
cloud, server-side per account, and `keyflip chat` reads it with a **claude.ai
session cookie**. It is **experimental** (undocumented API) and cookie-bound:

- The session is found for you, and every listing prints where it came from: the
  desktop app's own cookie, else a browser signed into claude.ai (current desktop
  builds keep `sessionKey` in memory and only write analytics cookies, so the app's
  on-disk jar is often *not* the usable one), else that account's saved snapshot.
- `--as <account>` reads ANOTHER saved account's chats from its **captured browser
  session** (`~/.config/keyflip/browser-sessions/<name>__<browser>.sql`, then the
  app snapshot at `app/<name>.cookies`) without switching anything — so you can
  search and read the other account's cloud history from here. If it reports no
  saved session, sign into claude.ai in a browser as that account and run
  `keyflip browser capture <account>` once (`browser sync` is the opposite — it puts a
  saved session back into the browser). Every keyflip switch also refreshes the login
  *and cookie* of the account it leaves.
- A **403 means the Cloudflare clearance went stale** — not that you are logged out.
  `keyflip chat --flush` closes and reopens the app once, then retries.
- Search matches chat **titles**; message bodies are in your local transcripts — use
  `keyflip recall "<query>"` for full-text.
- Cookies are machine-bound (the browser's own safeStorage key): a snapshot decrypts
  only on the machine and browser that captured it. Use `keyflip transfer` for the
  portable credentials.

(App preferences, `design/`, worktrees etc. are global/empty — nothing per-account to migrate there.)

### Which model runs the chores (`llm`)

`dream`, `sessions distill` and `recall --answer` are housekeeping, not the work you are paying a
subscription for — yet by default they shell `claude -p`, which burns the **active account's** quota,
and a nightly `dream schedule` will keep doing that unattended at 03:00. `keyflip llm` makes the
choice explicit and reversible:

```bash
keyflip llm                                   # who runs the chores, and what it costs
keyflip llm set --provider ollama --model qwen2.5:7b-instruct   # local, free, nothing leaves the machine
keyflip llm set --provider openai --base-url https://your-gateway/v1 --key-env GW_KEY --model NAME
keyflip llm test                              # one tiny call, to prove it answers before a batch runs
keyflip llm off                               # back to the default (`claude -p`)
```

- Providers: `claude` (the Claude Code CLI, active-account quota), `ollama` (local, defaults to
  `http://127.0.0.1:11434/v1`), `openai` (any OpenAI-compatible endpoint — a gateway on an API key).
- **An endpoint key is never stored.** `--key-env` takes the *name* of an environment variable and
  keyflip reads its value from your shell at call time. The state directory is a git repo, so a
  stored key would be a leaked key; a key-shaped value passed to `--key-env` is refused outright.
- Every chore prints `distills via <provider> <model> — <cost>` **before** it spends anything, and
  the keepsakes it writes record which model produced them. `dream schedule` receipts the provider it
  was installed with, and `keyflip doctor` warns if that ever diverges — or if a nightly job is still
  running on the subscription.
- One-off reroute without touching shared state: `KEYFLIP_LLM_PROVIDER=ollama keyflip dream --apply`
  (also `KEYFLIP_LLM_MODEL`, `KEYFLIP_LLM_BASE_URL`, `KEYFLIP_LLM_KEY_ENV`) — what a cron entry uses.
- `ollama pull <model>` first (or point `--model` at one you already have); `keyflip llm test` proves
  the endpoint answers. A cold local model spends minutes loading weights, so the self-test waits 3
  minutes — raise it with `keyflip llm test --timeout 300000` or pick a smaller model.

### Nothing expires on its own (`refresh --schedule`)

An Anthropic OAuth token lives about six days, and it expires on the **calendar** — not on the day you
happen to switch. That gap is why a switch can "succeed" and still open a sign-in screen: the stored
token died quietly weeks earlier, and `keyflip refresh` only works while the credential is idle. So the
repair is scheduled rather than remembered:

```bash
keyflip refresh --schedule                      # launchd (macOS) / crontab (Linux), default 04:30
keyflip refresh --schedule --at 05:15
keyflip refresh --schedule-status               # what runs, when, and where its output lands
keyflip refresh --unschedule
```

- It runs `keyflip refresh --all`: every saved account's token is renewed while nothing is using it. It
  calls **no model and spends no quota** — unlike the nightly `dream`, which is why it has its own
  launchd label, its own crontab marker and its own receipt file. The two jobs never overwrite
  each other, and 04:30 is deliberately not the dream's 03:00.
- **If a Claude session is live, the run changes nothing.** Rotating a refresh token under a session
  that still holds it logs a surface out, so the job declines and waits for the next idle night; in
  `--json` that refusal is `{refused, changed:false}` rather than a paragraph behind an exit 0.
- Its output goes to `~/Library/Logs/refresh-keyflip.log` and the plist sets `AbandonProcessGroup`, so
  the job can be read after it ran and its detached children are not killed at exit. launchd's `PATH`
  is `/usr/bin:/bin:/usr/sbin:/sbin`, so the schedule stores an absolute interpreter + script path —
  an fnm-installed `keyflip` would otherwise never be found.
- `keyflip doctor` has a **token renewal** row: it warns while accounts hold unrenewed tokens and goes
  green once something is scheduled. Over MCP: `keyflip_refresh_schedule` (`action=status|install|
  remove`, confirm-gated). See `keyflip chains` for the parts of a login that a scheduled refresh
  *cannot* save — a desktop-app session cookie needs a human, and no timer changes that.

### How old is each sign-in? (`keyflip freshness`)

The other half of a login cannot be renewed: the claude.ai `sessionKey` that the desktop app and the
browser hold lasts a fixed **28 days from the moment a human signed in**, and claude.ai may refuse an
older one sooner with "Sign in again". No refresh call exists for it. What keyflip can do is measure it
and warn before it bites:

```bash
keyflip freshness            # per account: cli token, app sign-in, each browser sign-in — age + days left
keyflip freshness --json     # the same, machine-readable (alias: keyflip age)
```

- Ages come from the cookie jar's creation/expiry **timestamps** (read from a private copy of the jar);
  no cookie value is ever read or printed.
- When the app answers a restored sign-in with "Sign in again" (`session_stale_relogin` in Claude's
  `main.log`), keyflip notices it right after the switch and in the nightly `refresh` run, records how old
  that sign-in was under `freshness/` in the state dir, and warns from then on at the youngest age that
  was ever refused. The threshold is learned from your own machine, not hardcoded.
- The same measurement appears as a `keyflip doctor` row (**claude.ai sign-in age**) and in the switch
  plan, which warns when the account you are switching to has an aging saved app sign-in.
- The fix is always the same, and only a human can do it: sign in once in Claude as that account, then
  `keyflip add <account> --app`.

### Is a secret still readable in the past? (`doctor --history`, `scrub-history`)

keyflip versions its state directory with git, so every config change is recoverable — and so, once, was
every secret that slipped past an ignore rule. Checking what is tracked **today** is not enough:
`git rm --cached` stops future commits from carrying a file, but the commit that already recorded it
still resolves the old blob in full. That residual is what has to be provably clean before keyflip starts
mirroring chat transcripts, because transcripts are where people paste keys.

```bash
keyflip doctor --history          # scan every blob ever committed; report KIND, never content
keyflip scrub-history             # the plan: which path, which kind, how many commits hold it
keyflip scrub-history --apply     # bundle backup → git-filter-repo → re-scan as proof
keyflip memory audit [--apply]    # the same scan over keyflip's distilled keepsakes
```

- **A report is never a copy.** A finding carries the path, the secret *kind* (`anthropic-api-key`, `jwt`,
  `private-key-block`…), the blob id, its size and how many commits still hold it — so the terminal, the
  log file and any agent reading the output stay clean.
- **A capture under a secret path counts even when its bytes match no known shape**, because a format the
  scanner does not recognize is still a credential file.
- **A path still tracked today is left alone** unless you pass `--include-tracked`: dropping a live file
  from history also drops it from the working tree. And a match resting only on the generic long-hex
  shape is marked `[weak match]` — a 64-hex `userID` is an identifier, not a reason to destroy a file.
- `--apply` **refuses** if `git-filter-repo` is not installed (a hand-rolled partial rewrite can corrupt
  the repo), writes a `git bundle` of the current history first and refuses to continue if that bundle
  does not verify, then re-scans and says whether the history is provably clean.
- Two things it cannot do for you: the bundle holds the secrets until you move or delete it, and **the
  credentials themselves must be rotated** — a removed secret that is still valid is not a fixed secret.
- `memory audit --apply` redacts in place and keeps each original as `<key>.md.pre-scrub` (0600, and
  `pre-scrub` is a registered secret extension, so that copy is never versioned or backed up). A redacted
  keepsake is still in git history until `scrub-history` runs.
- Over MCP: read-only `keyflip_history_audit` + `keyflip_memory_audit`, and confirm-gated
  `keyflip_history_scrub` + `keyflip_memory_redact`.

#### "I already know about that one" — the toleration policy (`secrets`)

Not every finding is a problem. A free Google AI key, a JWT whose session expired weeks ago, a capture of a
throwaway account — all genuinely secrets, none worth an alarm. And the same ✗ reprinted on every scan for a
thing the user already decided is exactly the noise that trains everyone to skim past the finding that *is*
a problem. `keyflip secrets` is how you say "expected" once, in a file, instead of in every scan.

```bash
keyflip secrets list                 # every finding and every rule, plus what each rule silences
keyflip secrets list --alarms        # only what is still an alarm
keyflip secrets tolerate "surfaces/codex/x/auth.json" --kind jwt --note "session expired"
keyflip secrets tolerate --kind google-api-key   # a kind that is fine wherever it turns up
keyflip secrets untolerate <path>    # the alarm comes back
```

- **A toleration ends the ALARM, never the clean-up.** A tolerated path stays in `scrub-history`'s plan and is
  still removed from history; what stops is the ✗ and the rotation advice. There is deliberately no option that
  means "leave this secret in the past" — that is not a policy, it is a leak with a config file.
- **A rule names a path and a kind, never a value** — matching on a value would put a fingerprint of the secret
  into the git-versioned state repo. `--note` text is redacted before it is stored, and `secrets-policy.json`
  itself is *not* a secret path, so it travels with `keyflip backup` and is reversible with `keyflip undo`.
- **Refused by design:** an unknown `--kind` (it would silence nothing, and the surviving alarm would look like
  a bug), and a bare `*` with no kind — that is not a policy, that is the scanner being switched off. `*` never
  crosses a directory boundary, and a `*`/trailing-`/` rule is printed with its **reach**, because it also
  covers anything NEW at that path.
- **It fails closed.** A corrupt or unreadable policy applies no rules, says so, and every finding stays an
  alarm; malformed rules are dropped but counted.
- **Keepsakes are never silenced.** `memory audit` has no policy: a distilled "my key is sk-ant-…" is text
  keyflip wrote *about* you, not a file you chose to keep.
- `doctor --history` counts alarms, not findings, and adds a dim line for what your policy silenced — so a
  clean headline can always be explained. Over MCP: `keyflip_secrets_policy` (read-only) and
  `keyflip_secrets_tolerate` (`action=tolerate|untolerate`, confirm-gated).

### What is one login actually made of? (`chains`)

An account is never one file. It is a live credential **plus every copy keyflip has taken from it**:
an OAuth profile, the desktop app's token cache *and* its session cookie, a browser cookie snapshot, a
provider API key, a third-party capture under `surfaces/`. Those copies form a graph, and three
properties of that graph decide whether a switch will work — none of which any earlier command could
see, because each looks at one file while the truth lives in the relationships between them:

- **Renewal.** The app's `oauth:tokenCache` is *derived*: the app re-mints it by calling `/authorize`
  with its `sessionKey` cookie. So the cookie is the chain's real root, and nothing renews it but a
  human. A token blob can look perfectly healthy while the account behind it is dead — which is
  exactly what "I switched and the app just shows the sign-in screen" is.
- **Staleness.** A capture is a copy of a store that kept moving. If the source's mtime is newer than
  the capture's, restoring it restores the past.
- **Sharing.** One browser profile, or one app cookie jar, holds exactly **one** account's session.
  Every capture taken from the same store competes with all the others: logging into Chrome as one
  account silently makes that account's snapshot of the others untrue.

```bash
keyflip chains                 # the whole map, plus every structural finding
keyflip chains work            # one account: what it holds, who renews it, where it bottoms out
keyflip chains --tighten       # what is world-readable in the state repo (dry run)
keyflip chains --tighten --apply   # chmod 600 those files, then re-scan as proof
```

- **It never reads a secret.** The map is built from paths and `stat()` results — size, mtime, mode.
  It also never spawns `security … -w`, because printing a Keychain item is the only way to prove it
  exists; those locations are reported as `exists: null` (unprobed) instead. And it writes **nothing**
  into the git-versioned state repo, so it cannot leave a fingerprint of a value in history.
- **Findings, not complaints.** Each risk names its own fix (`re-capture it while that account is
  logged in`, `keyflip add <name>`, `keyflip chains --tighten`), and `high` items sort first. Only a
  secret keyflip itself left readable beyond your owner can turn the `doctor` row red — four accounts
  sharing one Chrome profile is structural reality, and a permanent ✗ over it would train you to
  ignore the ✗.
- **`--tighten` is bounded on purpose**: files inside the state repo, in the secret path set only.
  Chrome's own cookie DB being 644 is normal (macOS protects it above the filesystem layer), so it is
  never touched and never warned about.
- The CLI `--json` and the MCP results carry repo-relative or `~/`-relative paths only
  (`publicNode`/`publicRisk` strip the absolute ones), so pasting the map into an agent transcript
  does not map your filesystem for it.
- Over MCP: read-only `keyflip_chains` (+ optional `account`), confirm-gated `keyflip_chains_tighten`.
  `keyflip doctor` gained a **credential chains** row that runs this map on every diagnosis.

### One task across accounts (`threads`)

A quota runs out mid-task, you switch, and the same job is suddenly three objects: a Claude Code
session under gmail, another under yahoo, and a claude.ai chat nobody can point at. `keyflip threads`
gives that work **one name**. A thread is a *pointer file*, `~/.config/keyflip/threads/<slug>.json`,
listing session ids and chat uuids plus the account each belongs to — it is not a container, so
switching accounts stops fragmenting the work, and `keyflip chat`'s piece-by-piece reach becomes one
named task.

```bash
keyflip threads suggest                    # what is ALREADY split over 2+ accounts, per project folder
keyflip threads create dugum-acmak --title "Düğüm açmak" --session 1a2b3c4d
keyflip threads add dugum-acmak 9f8e7d6c --account yahoo   # a prefix is fine — it stores the full id
keyflip threads add dugum-acmak 3b0c…e1a4 --chat            # a claude.ai chat is a member too
keyflip threads show dugum-acmak --timeline                # one chronological conversation, with provenance
keyflip threads open dugum-acmak            # where the work last stopped, as the account that owns it
keyflip threads where 1a2b3c4d              # which threads contain this session
keyflip threads drop dugum-acmak -y    # forgets the NAME; every transcript and assignment stays
```

- **Pointers, never copies.** The transcript stays where Claude wrote it. Nothing duplicates, and
  deleting, corrupting or migrating a thread cannot lose a message — only a name. `keyflip threads
  show --md` prints the merged document without writing anything.
- **`[t]` in the menu is the same store, read-only.** The account switcher has a threads screen: every
  thread, its members, which account each belongs to, where its transcript is, how fresh it is, and the
  exact `cd … && claude --resume …` line that continues it — plus `[s]` for split work it can *find*. It
  never reads a transcript body, never writes, never spends quota; naming and un-naming stay on the CLI,
  because a thread is the one thing an account switch can silently fragment.
- **It finds the split instead of making you enumerate it.** `suggest` groups recent sessions per
  project folder and reports the folders where **two or more named accounts** worked, minus what a
  thread already covers — so the list shrinks as you name your work. One account plus unassigned
  sessions is *not* reported: that is an account nobody assigned, not a switch (assign it with
  `keyflip sessions assign <id> <account>`).
- **`sessions attribute` guesses the account instead of making you assign every session by hand.** It
  reconstructs your switch timeline from keyflip's own action log (account names + timestamps only —
  it reads no transcript) and proposes the account each unassigned session was worked on: `high` when
  the session's whole span sits inside one account's window, `low` and **flagged** when it crosses a
  switch. Nothing is written without `--apply`, and an applied guess is stored as a guess — the
  threads screen shows it as `yahoo (inferred)` until you confirm it with `sessions assign`.
- **The merge says where it stopped being complete.** Each turn keeps its member and account
  (`↪ from yahoo · session 9f8e7d6c`); undated turns stay a front group rather than being sorted
  between decisions; a cloud chat contributes no turns offline and is listed under `unavailable` with
  the `keyflip chat get …` command that would read it; and a member cut off by `threads.mergeMaxMiB`
  (default 8 — transcripts here run to 24 MB) is counted as capped, not silently short.
- **Conversation text on disk is opt-in and doubly gated.** `threads mirror` only writes
  `~/.config/keyflip/thread-mirror/<slug>.md` when `keyflip config set threads.mirror true` **and** the
  call agree; that directory is a registered secret dir (0600, never versioned, never backed up, never
  synced, excluded from `migrate`), and the mirror still refuses if the state repo has a git remote.
  Nothing copies transcript prose into a pointer file, either — the first prompt of a session is where
  a pasted API key lives.
- **Names are filenames, so they are normalized.** `düğüm` → `dugum`, `../secrets/x` cannot escape
  `threads/`, and an ambiguous prefix is refused rather than guessed. A corrupt or hand-edited thread
  is reported by `list` and blocks a write; `keyflip doctor` has a **threads** row for unreadable
  files, members with no resolvable account, and the mirror being on.
- Over MCP: read-only `keyflip_threads` (list / `slug` / `timeline` / `suggest` / reverse `id`) plus
  confirm-gated `keyflip_thread_create|add|remove|drop|mirror`. MCP results **and** every `--json` payload
  come back with paths relative to the state repo or `~/.claude/projects` — never the user's home path,
  because that output is meant to be pasted into an agent transcript. A resume command's `cwd` stays
  absolute (running it needs that, and a working directory is not a secret), and the human output keeps
  real paths so you can open them.

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

**The full CLI surface is exposed as 160+ MCP tools**, so an agent can do
everything without shelling out — accounts (`keyflip_status/list/switch/next/add/account_remove`),
providers (`keyflip_providers`, `keyflip_provider_use/add/remove`, `keyflip_test_provider`,
`keyflip_speedtest`), the **fleet** control plane (`keyflip_fleet_status/switch/send_account/collect/keys/trust`),
sessions (`keyflip_sessions`, `keyflip_resume_command`, archive/distill/compact), **one named task
across accounts** (`keyflip_threads` is read-only: list / `slug` / `timeline` / `suggest` / reverse `id`
lookup; `keyflip_thread_create|add|remove|drop|mirror` mutate and require `confirm`), **switch preflight**
(`keyflip_switch_plan` + `keyflip_verify` are read-only: the exact writes, blockers, quota state and
rollback scope before anything moves), **chore cost** (`keyflip_llm` — which model `dream`/`distill`/
`recall --answer` will use and whose quota that burns; `keyflip_recall` with `answer: true` returns a
cited synthesis), **history hygiene** (`keyflip_history_audit` + `keyflip_memory_audit` are read-only
scans of every blob keyflip ever committed and of its keepsakes; `keyflip_history_scrub` +
`keyflip_memory_redact` mutate, and are confirm-gated; `keyflip_secrets_policy` reads and
`keyflip_secrets_tolerate` writes the value-free "this finding is expected" policy that mutes the alarm
without exempting the path from the scrub), **credential chains** (`keyflip_chains` is a
read-only map of which store each capture was copied from, who can renew each part, and what is stale,
shared or world-readable — paths and stats, never a value; `keyflip_chains_tighten` chmods and is
confirm-gated), migrate + LAN
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

A saved *capture* is not the same as a *live login*, and the difference shows: if
claude.ai has rotated or revoked that session since it was captured, the app deletes the
cookie on launch and opens on its **sign-in screen** — even though its token cache is
intact and decryptable. Nothing automated can fix that (only a sign-in mints the
cookie), so keyflip reports it instead of looking healthy: `keyflip list` marks the app
`(signed out on disk…)` while its capture is still `app ✓`, `keyflip doctor` runs a
**desktop app session** check (and shows the cookie's expiry when it is there), and
after a switch that reopens Claude, keyflip waits a few seconds and warns if the app came
back signed out. The fix in every case is one sign-in in the app plus `keyflip add
<name>`; the CLI, the browser session and every other capture stay switched.

One specific and easy-to-blame cause: the app **updated itself**. Squirrel/ShipIt swaps
the bundle and relaunches the app, and on that relaunch Chromium may not have flushed the
`claude.ai` session cookie back to disk yet — so the live jar reads as signed out while
your saved capture is perfectly fine, and it *looks* like logins stopped working with no
change on keyflip's side. `keyflip doctor` dates the installed bundle and says so
("the app was UPDATED <date> (vX)…) instead of implying a broken capture. `keyflip add
--dry-run` shows what a capture *would* save and whether the app's jar currently holds a
usable session, without writing anything.

> Experimental: it rewrites the app's `config.json` login while the app is closed.
> If a saved token has fully expired the app may ask you to log in again; just
> re-`add` that account. Restore a backup if anything looks off.

> Switching should happen while Claude is closed, or Claude may overwrite the change on exit.
> - **Interactive** (menu, or `keyflip <name>` in a terminal): if Claude is open you're **asked before it's closed** — answer *no* to cancel.
> - `--restart`: close & reopen Claude without asking (macOS).
> - `--force`: switch without closing Claude — restart it yourself afterward. If the **desktop app** is running on another account it can rewrite the shared login and undo the swap; `--force` warns you and suggests `--restart`.
> - `--dry-run`: prints the plan (which surfaces would be written, what blocks it, whether that account can still authenticate) and writes nothing — safe with Claude open.
> - Every switch then **reads itself back**: it re-checks the account it just moved to (token expiry, the app's session cookie, the CLI identity on disk) and tells you `usable now` / `usable, decaying` / `NOT usable` instead of trusting a clean exit. `--no-verify` skips it; `--rollback-on-fail` additionally puts the previous account back when the read-back says the switch didn't land — opt-in, because a rollback re-writes credential stores and `keyflip undo` cannot help (it only reverts keyflip's metadata repo).
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

2. **GitHub Actions matrix** (`.github/workflows/ci.yml`) runs the suite on **`ubuntu-latest` + `macos-latest` + `windows-latest`** across **Node 20 / 22** — real different OSes and versions, on every push. That is the "simulate different versions" part, for free.

Add more Node versions or OS images by editing the `matrix` in the workflow.

### Code style and `git blame`

`npm run lint` (eslint) and `npm run format:check` (prettier) both gate the
`lint & format` job, and the pre-commit hook runs `eslint --fix` + `prettier
--write` over staged files. Run `npm run format` before pushing if you have
been editing outside the hook.

The repository was brought under prettier in a single sweep, which would
otherwise make `git blame` credit that one commit for most lines in the tree.
The sweep is recorded in `.git-blame-ignore-revs`. GitHub honours that file
automatically; locally you opt in once per clone:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

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

## Website

The `/website` directory contains the project's marketing and documentation site, built with Astro. It is a standalone sub-project with its own `package.json`. See [`website/README.md`](website/README.md) for development and deployment instructions.

---

## License

[MIT](LICENSE)

---

*Not affiliated with Anthropic. “Claude” and “Claude Code” are trademarks of Anthropic.*
