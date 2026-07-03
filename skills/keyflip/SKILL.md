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

- **`keyflip setup`** — an interactive wizard: it captures the current login, then
  auto-detects each new account as the user signs into it (`/logout`→`/login`, or
  the desktop app) and saves it, until they type `d`. **Recommend this to the user
  for first-time / multi-account setup**, but it needs a real terminal (TTY) — do
  NOT try to drive it non-interactively; tell the user to run it themselves.
- **`keyflip add [name]`** — captures whatever is logged in right now (one account).
  Scriptable. `--app` = desktop app only. `--token <file|->` imports a raw
  credential (secrets via file/stdin, never argv).
- **`keyflip login [name] --email <x>`** — signs in via the OFFICIAL `claude auth
  login` in an ISOLATED config dir (the user's current login is NOT disturbed) and
  captures the minted token. The only human step is approving in the browser. Note:
  OAuth uses the browser's current claude.ai session, so if the browser is signed
  into a different account, keyflip captures THAT and warns (mismatch) — the user
  must sign the browser into the target account first (see `keyflip browser`).

**Browser / the Claude Chrome extension (macOS):** the extension has no login of
its own — it inherits the browser's claude.ai session. If that != the active
CLI/desktop account, the extension's native-messaging bridge refuses to connect
("user mismatch"). `keyflip browser status` shows the browser's claude.ai account
and flags a mismatch; `keyflip browser logout` clears it (reversible, quit the
browser first) so the user can sign in as the right account.

**Via MCP:** these are also tools — `keyflip_login` (add an account by browser
sign-in), `keyflip_logout` (sign out of cli/browser surfaces), `keyflip_browser_status`
(read the browser/extension account), `keyflip_browser_logout` (reset it). The
mutating ones require `confirm: true`; `keyflip_login` opens a browser for the human.

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
keyflip next --strategy best            # rotate to the account with most headroom
keyflip next --strategy next-available  # first account that isn't exhausted
```

Inside an active Claude Code conversation, prefer `--force` (in-place): the
session continues on the new account without closing anything. Use `--restart`
only when the user also wants the desktop app moved — it closes the app.

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
keyflip doctor                # config + login + endpoint reachability report
```

`status` shows the active provider. Switching a provider does NOT change the OAuth
account; `keyflip provider off` restores it. Never put an API key in argv — use
`--key-file -` (stdin) or a file.

## Reliability, history, backup, sharing, sync

- `keyflip autoswitch --threshold 90 -y` skips accounts whose circuit breaker is
  open (repeatedly failing) and logs every failover.
- `keyflip usage --history` — per-account 5h/7d trend + failover events.
- `keyflip backup now|list|restore <n>` — snapshots keyflip metadata (no secrets);
  restore takes a safety backup first.
- `keyflip share <provider> [--no-secrets]` → a `keyflip://` link; `keyflip import
  '<url>'` previews + confirms. Account links are pointer-only (never the token).
- `keyflip sync push|pull --url <webdav> --passphrase-file <f>` — encrypted
  cross-device sync. Or point `KEYFLIP_CONFIG_DIR` at a Dropbox/iCloud folder.
- `keyflip mcpreg` — manage MCP servers once, project into Claude Code + Desktop.
- `keyflip gateway use <provider>` — route the Claude **desktop app** through a
  provider gateway (restart the app to apply).

## Finding & resuming past conversations

Transcripts live in `~/.claude/projects` and are account-independent.

```bash
keyflip sessions [--search "oauth"] [--here]   # list/search conversations, all accounts
keyflip resume <number|id>            # print the resume command for its original dir
keyflip resume <id> --run             # launch `claude --resume <id>` in that dir
keyflip cowork [--search T]           # browse Claude desktop Cowork sessions (all accounts)
keyflip chat [get <id>]               # read the active account's claude.ai Chat (EXPERIMENTAL)
```

`cowork` and Claude Code `sessions` are LOCAL and reliable. `chat` reads
claude.ai's cloud history via the desktop app's session cookie — it's
experimental: it needs a fresh Cloudflare cookie (works right after the app was
used) and only sees the account the desktop app is signed into; if it 403s, tell
the user to open the Claude app once and retry.

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
| moving to a new machine | `keyflip export -` (SECRETS — pipe through gpg) → `keyflip import` there; desktop logins must be re-captured on the new machine |
| keyflip is misbehaving but accounts are fine | `keyflip reset --soft` — clears only runtime state (usage history, breakers, proxy state, caches, logs) and routes back to the subscription; **keeps saved accounts**. Confirm first (`--force` to skip). |
| user wants a full wipe / remove keyflip | **`keyflip reset`** is a FACTORY reset — DELETES all keyflip data (accounts, providers, backups), app stays installed. `--logout [--no-desktop]` also signs out the live surfaces. `keyflip clean` is the same wipe (compat). `keyflip uninstall` removes the app (`--purge` also deletes data). All destructive — get consent, they prompt unless `--force`. |

`reset` / `clean` / `uninstall` never touch the live Claude login (only `clean
--logout` does) or `~/.claude/projects`. `uninstall` won't delete a source checkout.
Never print or log credential blobs, tokens, or export file contents.
