# ccswitch — Claude Account Switcher

Switch between multiple **Anthropic / Claude Code** accounts with a click (or one command).
Log in to several accounts once, then hop between them without repeatedly logging in and out.

**Cross-platform:** macOS, Linux, and Windows. Pure Node.js, zero runtime dependencies.

[![CI](https://github.com/hakkisagdic/ccswitch/actions/workflows/ci.yml/badge.svg)](https://github.com/hakkisagdic/ccswitch/actions/workflows/ci.yml)

---

## Why it's safe

- **Your OAuth tokens stay in the OS credential store.** On macOS that's the Keychain; on Linux/Windows it's Claude's own `~/.claude/.credentials.json`. ccswitch copies tokens *between* those slots — it adds no new plaintext token file, and this repository contains **no credentials of any kind**.
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
curl -fsSL https://raw.githubusercontent.com/hakkisagdic/ccswitch/main/install.sh | bash
```

**Windows — PowerShell** (also creates a Start Menu / Desktop shortcut):

```powershell
irm https://raw.githubusercontent.com/hakkisagdic/ccswitch/main/install.ps1 | iex
```

**Via npm (any OS):**

```bash
npm install --global git+https://github.com/hakkisagdic/ccswitch.git
```

**From a clone:**

```bash
git clone https://github.com/hakkisagdic/ccswitch.git && cd ccswitch && ./install.sh   # or: .\install.ps1 on Windows
```

The installer places the code in `~/.local/share/ccswitch`, links `ccswitch` into `~/.local/bin`, and adds it to your `PATH`. Uninstall with `./uninstall.sh` (or `npm uninstall -g ccswitch`).

---

## First-time setup (find & save your accounts)

Nothing to configure by hand — ccswitch **detects the account you're currently logged in to** and names the profile from your email automatically.

1. In Claude, make sure you're logged in to your **first** account, then run `ccswitch add`.
2. In Claude, `/login` to your **second** account, then run `ccswitch add`.
3. Repeat for as many accounts as you like.

On macOS the first Keychain read shows an **“Always Allow”** prompt — approve it.

---

## Everyday use

Run `ccswitch` (or, on macOS/Windows, open the **“Claude Account Switcher”** launcher) and pick an account by number:

```
        Claude Account Switcher (ccswitch)
  Active: alice@example.com

  → [1] alice@example.com
    [2] bob@example.org

  [number] switch   [a] save current   [d] delete   [r] refresh   [q] quit
```

If Claude / Claude Code is open, ccswitch first asks **“Claude will be closed to switch — continue?”** On **yes** it closes Claude, switches, and reopens it (macOS); on **no** it cancels and changes nothing.

### CLI

```bash
ccswitch                       # interactive menu (↑/↓ + Enter)
ccswitch add [name] [--app]    # save the logged-in account(s) — CLI + desktop app
ccswitch <name|number>         # switch to that account (asks before closing Claude)
ccswitch <name> --restart      # ...close & reopen Claude without asking
ccswitch <name> --force        # ...swap without closing Claude (restart it yourself)
ccswitch next                  # rotate to the next saved account
ccswitch next --strategy best  # ...or pick by remaining quota (also: next-available)
ccswitch status                # which account each surface is on (CLI + desktop app)
ccswitch list [--usage]        # accounts; --usage adds each one's 5h/7d utilization
ccswitch run <name> [-- args]  # PARALLEL session: that account in THIS terminal only
ccswitch add <name> --token <file|->   # headless import of a raw credential
ccswitch export [file|-]       # back up accounts to a file (CONTAINS SECRETS)
ccswitch import <file|->       # restore accounts from an export (--force overwrites)
ccswitch remove <name|number>  # delete a saved account
ccswitch clean [--logout]      # reset ccswitch data; --logout also signs out everywhere
ccswitch upgrade               # update ccswitch itself (detects how it was installed)
```

Global flags: `--json` (machine-readable stdout — one JSON object, `schemaVersion: 1`,
human text to stderr; ideal for scripts/status lines) and `--debug` (verbose log).
`ccs` works as a short alias. A passive "new version available" notice appears at
most once a day (never blocks a command).

### Reliability guarantees

- Every mutation runs under a **cross-process lock** — two ccswitch invocations
  can't interleave a switch.
- A switch is **transactional**: the account pointer is rolled back if the live
  credential write fails, so a half-switched state never survives.
- Stored blobs are **validated** before restore; corrupt profiles are refused
  with a clean re-add message instead of being restored.
- Expiring OAuth tokens are **refreshed automatically** on switch (skipped when a
  live Claude session owns the credential; failures warn loudly).
- A locked macOS Keychain reads as **"keychain locked"** (not "no credentials"),
  with 5s timeouts; profile storage falls back to files so you can keep working.

### Parallel sessions (`run`)

`ccswitch run <name>` launches Claude Code as that account **in the current
terminal only** — every other terminal, the desktop app and VS Code keep their
current account, so two accounts can work side by side. Your `~/.claude`
customizations (settings, keybindings, CLAUDE.md, skills, commands, agents)
follow you in via symlinks (`--no-share` for a bare profile); conversation
history stays per-account. Everything after `--` is forwarded to `claude`
(e.g. `ccswitch run work -- --resume`). If the session refreshes the token,
ccswitch saves it back to the profile on exit.

> ⚠️ **Asks for confirmation first** (skip with `-y`): a token refresh inside a
> parallel session rotates that account's refresh token, which can log out
> *other live copies of the same account*.

### Headless import (`add --token`)

`ccswitch add <name> --token <file|->` saves a raw credentials JSON blob
(`{"claudeAiOauth":{...}}`) as an account without any login flow — for CI or
provisioning. The blob is read from a **file or stdin, never argv**. It asks
for confirmation on a TTY; piped/scripted use must pass `--force`, and
overwriting an existing account always requires `--force`.

### VS Code

The VS Code Claude Code extension shares the CLI's credential store, so every
ccswitch switch already applies to it (reload the window to pick it up). A thin
companion extension in [`vscode-ccswitch/`](vscode-ccswitch/) adds a status-bar
account indicator and a QuickPick switcher — see its README for local install.


### Seeing all your sessions after a switch (macOS)

The Claude **desktop app** keeps its "Recents" as a per-account index at
`~/Library/Application Support/Claude/claude-code-sessions/<accountUuid>/<orgUuid>/`,
so by default each account only shows the Code sessions you started under it.

On every switch (while the app is closed), ccswitch **consolidates** that index —
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
ccswitch therefore captures and swaps **both** — so `ccswitch <name>` can flip the
CLI *and* the desktop app to the same account, once each account's desktop login
has been captured.

The desktop app's login is **independent** from the CLI's — they can even be on
different accounts at the same time. `ccswitch add` captures **whatever is signed
in right now**: the CLI login and/or the desktop app's (auto-detected). So per
account: sign in (app and/or CLI), run `ccswitch add`, done. `ccswitch list`
shows what each account has captured (`[cli ✓|— | app ✓|—]`); if the app's account
can't be auto-identified, name it explicitly (`ccswitch add <name> --app`).

After that, `ccswitch <name>` (app closed → reopened) swaps the CLI creds **and**
the desktop-app login (token + session cookie), so both come up on the chosen
account — no manual re-login. `config.json` and the cookie DB are backed up first
(`~/.config/ccswitch/backups/`).

> Experimental: it rewrites the app's `config.json` login while the app is closed.
> If a saved token has fully expired the app may ask you to log in again; just
> re-`add` that account. Restore a backup if anything looks off.

> Switching should happen while Claude is closed, or Claude may overwrite the change on exit.
> - **Interactive** (menu, or `ccswitch <name>` in a terminal): if Claude is open you're **asked before it's closed** — answer *no* to cancel.
> - `--restart`: close & reopen Claude without asking (macOS).
> - `--force`: switch without closing Claude — restart it yourself afterward.
> - Non-interactive (piped/CI) with Claude open and no flag: refuses rather than closing your app unexpectedly.

---

## How it works

| Piece | macOS | Linux / Windows |
|------|-------|-----------------|
| Live login token | Keychain item `Claude Code-credentials` | `~/.claude/.credentials.json` |
| Saved profile tokens | Keychain items `ccswitch:<name>` | `~/.config/ccswitch/creds/<name>.cred` (0600) |
| Account identity | `oauthAccount` + `userID` in `~/.claude.json` | same |
| Profile metadata (no secrets) | `~/.config/ccswitch/<name>.json` (0600) | same |

The backend is auto-detected: if a credentials **file** already exists it's used (any OS); otherwise macOS uses the Keychain. A switch copies the saved token into the live slot **and** patches the two fields in `~/.claude.json`. When switching *away*, ccswitch first re-saves the current account's (possibly refreshed) token so nothing goes stale — including auto-saving a logged-in account you hadn't saved yet, so its token isn't lost.

### Security notes

- **Config integrity:** writes to `~/.claude.json` are atomic and preserve the file's mode; if that file exists but is not valid JSON, ccswitch refuses to touch it rather than risk clobbering your settings.
- **macOS Keychain:** tokens are written by feeding `security -i` on **stdin** (hex-encoded), so the secret never appears in the process table; `/usr/bin/security` is invoked by absolute path. (Only blobs too large for the stdin line-length budget fall back to an argv write.)
- **Exports:** `ccswitch export` files contain login secrets — they're written `0600` with a loud warning; pipe to `-` and encrypt (e.g. gpg) for transport, and delete after importing.
- Switch while Claude is closed. The macOS app/`--restart` quit and reopen it for you; elsewhere ccswitch warns if Claude is running and asks you to restart it after switching.

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

## Uninstall

```bash
./uninstall.sh            # macOS/Linux: remove CLI + app, keep saved profiles
./uninstall.sh --purge    # also delete saved profiles
npm uninstall -g ccswitch # if installed via npm (any OS)
```

---

## License

[MIT](LICENSE)

---

*Not affiliated with Anthropic. “Claude” and “Claude Code” are trademarks of Anthropic.*
