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

On macOS/Windows, choosing an account **quits Claude, switches, and reopens it**. On Linux it switches and asks you to restart Claude Code.

### CLI

```bash
ccswitch                       # interactive menu
ccswitch add [name]            # detect & save the logged-in account
ccswitch list                  # list saved accounts (* = active)
ccswitch switch <name|number>  # switch (add --restart to auto quit/reopen the app)
ccswitch remove <name|number>  # delete a saved account
ccswitch current               # show the active account
ccswitch version
```

> Switching should happen while Claude is closed, or Claude may overwrite the change on exit. The launcher and `--restart` handle this for you; the plain `switch` warns if Claude is running (override with `--force`).

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
- **macOS Keychain:** writing a token shells out to `security add-generic-password`, which (having no stdin option for the value) passes the token as a command-line argument — briefly visible in the process list during that call. On a single-user Mac this is low risk; on shared machines be aware of it.
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
