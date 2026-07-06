# keyflip — Complete Use-Case & Scenario Catalog

> A comprehensive, self-contained tour of **every** keyflip workflow and its
> variations. Written to be dropped into NotebookLM (or any doc tool) as the source
> for a walkthrough video. Turkish mirror: [`USE-CASES.tr.md`](./USE-CASES.tr.md).

---

## 0. The mental model (read this first)

keyflip operates multiple Anthropic / Claude accounts on one machine. To use it well,
hold four ideas in your head:

**Four login surfaces.** An "account" can be logged in on up to four independent
surfaces, and keyflip's job is to keep them pointing at the same account:

| Surface | Where the login lives | Notes |
|---|---|---|
| **CLI** (Claude Code) | macOS Keychain `Claude Code-credentials`, else `~/.claude/.credentials.json` | The one most switches touch. |
| **Desktop app** (Claude.app) | app's own token + session cookie (machine-bound safeStorage) | Optional; captured separately. |
| **Browser** (claude.ai) | the browser's cookies | The **Claude Chrome extension has no login of its own** — it inherits this. |
| **Extension bridge** | native-messaging host | Refuses to connect if browser account ≠ CLI/desktop account ("user mismatch"). |

**Accounts vs. providers.** An **account** is an OAuth subscription (Pro/Max/Team).
A **provider** is a different *API endpoint* (relay, gateway, Bedrock, OpenRouter, a
custom base URL) that keyflip points Claude Code at by patching `settings.json`.
Switching accounts changes *who is billed*; switching providers changes *where
requests go*.

**Sessions are account-independent.** Chat transcripts live in `~/.claude/projects`
and belong to no account — they are always safe to keep, move, and merge.

**Safety rules keyflip always follows.** Never switches/logs-out/deletes without
consent; secrets go only to the OS credential store and never onto the command line;
mutations are serialized and transactional; `--json` gives machine-readable output.

---

## 1. First run — capturing your accounts

You can only switch between accounts keyflip has *captured*. Capturing reads a live
login and stores it. Pick the path that fits:

### 1.1 The full guided onboarding — `keyflip onboard`
**Goal:** set up several accounts from scratch, hands-off as much as possible.
```bash
keyflip onboard              # per account: sign in → capture (CLI + browser) →
                             # point the live CLI at it → optionally capture the
                             # desktop app → sync chats → "add another?" → repeat
keyflip onboard --manual     # same, but paste a login code/URL (e.g. email-code logins)
```
- Between accounts it signs the browser out of the previous one, so account #2 is a
  clean login (pressing Enter logs the first out).
- Interactive (needs a TTY). Run it in a normal terminal, ideally **not** inside the
  desktop app's own terminal.
- **Variation:** skip the desktop capture when prompted (type `s`) if you only use the CLI.

### 1.2 The lighter wizard — `keyflip setup`
**Goal:** capture the current login, then auto-detect each new one as you sign in.
```bash
keyflip setup                # captures now; then watches for /logout→/login (or the
                             # desktop app) and saves each new account until you type d
```

### 1.3 Capture whatever is logged in right now — `keyflip add`
**Goal:** one-shot, scriptable capture of the *current* login.
```bash
keyflip add                  # save the currently-logged-in account(s): CLI + desktop
keyflip add work             # ...naming it "work"
keyflip add work --app       # capture the DESKTOP APP login only
keyflip add work --token creds.json    # import a raw credential from a file
some-cmd | keyflip add work --token -   # ...or from stdin (secrets never on argv)
```

### 1.4 Official browser sign-in, isolated — `keyflip login`
**Goal:** add an account by signing in fresh, without disturbing your current login.
```bash
keyflip login                        # official `claude auth login` in an isolated dir
keyflip login work --email a@b.com   # pre-fill the email
keyflip login --fresh                # clear the browser's claude.ai first (avoid mismatch)
keyflip login --manual               # paste the code/URL yourself (email-code, SSO)
```
- The only human step is approving in the browser that opens.
- **Gotcha:** OAuth reuses the browser's current claude.ai session. If the browser is
  signed into a *different* account, keyflip captures THAT and warns. Fix with
  `--fresh` or `keyflip browser logout` first.

---

## 2. Seeing state (always safe, no consent needed)

```bash
keyflip status               # which account each surface is on (CLI + desktop app)
keyflip status --json        # {"cli":{"email":…},"app":{"name":…,"email":…}}
keyflip list                 # all captured accounts, which is active on each surface
keyflip list --usage         # + each account's 5h / 7d quota utilization
keyflip list --usage --json  # machine-readable usage + headroomPct + usageStatus
keyflip doctor               # config + login + endpoint reachability report
```
- `list` shows a **web** column and a browser/extension footer, warning on a mismatch.
- `usageStatus` sentinels: `ok`, `expired` (re-`add` the account), `throttled`
  (**unknown**, not proof of a rate-limit), `error`, `no-creds`/`no-token`.

---

## 3. Switching accounts (needs consent — it changes billing)

```bash
keyflip work                 # switch to "work" (asks before closing Claude)
keyflip 2                    # switch by list number
keyflip work --force         # swap in place; a running Claude Code picks it up next request
keyflip work --restart       # also close & reopen the desktop app (full switch)
keyflip work --browser       # ALSO align the browser + Chrome extension to this account
keyflip next                 # rotate to the next saved account
keyflip next --strategy best            # pick the account with the most headroom
keyflip next --strategy next-available  # first account that isn't exhausted
```
- **Inside a live Claude Code chat:** prefer `--force` — the session continues on the
  new account without closing anything.
- **`--browser`** restores that account's saved browser session (captured during
  onboard/login), quitting + reopening the browser so the extension reconnects.
- Every switch also re-syncs chats across accounts (deferred if the desktop app is open).

---

## 4. Hitting a rate limit / usage cap

```bash
keyflip list --usage --json                 # 1) find candidates with headroomPct > 0
keyflip work --force                         # 2) after consent, switch to a fresh one
keyflip next --strategy best                 # ...or let keyflip choose the best
keyflip autoswitch --threshold 90 -y         # long unattended runs: auto-rotate the CLI
                                             #   credential at 90% (never touches the app)
```
- `autoswitch` skips accounts whose **circuit breaker** is open (repeatedly failing)
  and logs every failover.
- For request-level failover (mid-request 429/5xx), see the proxy (§10).

---

## 5. Browser & the Claude Chrome extension (macOS)

The extension inherits the browser's claude.ai session; a mismatch blocks it.
```bash
keyflip browser status               # the browser's claude.ai account + mismatch flag
keyflip browser logout               # clear the claude.ai session (reversible; quit browser first)
keyflip browser sync                 # restore the ACTIVE account's saved browser session
keyflip browser sync work            # ...restore a specific account's session
keyflip browser status --browser brave   # target one browser (chrome|brave|edge|arc)
```
- Sessions are captured automatically during `onboard`/`login` while the browser is on
  that account; `browser sync` and `<name> --browser` replay them.

---

## 6. Providers — third-party endpoints (relays, gateways, Bedrock, OpenRouter)

Use when you want a custom base URL / API key instead of the OAuth subscription.
```bash
keyflip provider add relay --base-url https://relay.example --key-file key.txt
cat key.txt | keyflip provider add relay --base-url https://relay.example --key-file -
keyflip provider add relay --base-url … --auth-scheme api-key --model haiku=claude-haiku-4-5
keyflip use relay            # route Claude Code to it (no restart — settings hot-reload)
keyflip provider off         # back to the OAuth subscription
keyflip provider list        # which providers exist / which is active
keyflip speedtest relay      # pick the fastest of a provider's candidate endpoints
keyflip test relay           # one real request → auth ok? (auth/network/4xx/5xx)
keyflip gateway use relay     # route the DESKTOP APP through a provider (restart app)
keyflip gateway off | status
```
- Switching a provider does **not** change the OAuth account; `provider off` restores it.
- Never put a key in argv — always `--key-file <file|->`.

---

## 7. Running a second account in parallel (one terminal)

```bash
keyflip run work -y -- --resume         # run Claude Code as "work" ONLY in this terminal
keyflip run work --share-history -y     # ...sharing conversation history too
keyflip run work --no-share             # isolate history as well
keyflip link work                       # map THIS directory tree to "work";
keyflip run                             #   then plain `run` here uses it
keyflip link --remove                   # unmap
```
- Isolates via `CLAUDE_CONFIG_DIR`; other terminals and the desktop app keep their
  account. **Warning:** an in-session token refresh can log out other live copies of
  the same account.

---

## 8. Finding & resuming past conversations (local, account-independent)

```bash
keyflip sessions                       # list all Claude Code conversations, all accounts
keyflip sessions --search "oauth"      # search transcripts
keyflip sessions --here                # only sessions started in this directory
keyflip resume 3                       # print the resume command for list item 3
keyflip resume <id> --run              # launch `claude --resume <id>` in its original dir
keyflip cowork                         # browse Claude desktop Cowork sessions (all accounts)
keyflip cowork --search T | --all
keyflip chat                           # list claude.ai cloud Chats (EXPERIMENTAL)
keyflip chat get <id>                  # read one conversation
```
- `resume` is project-scoped — it handles the `cd` to the transcript's original dir.
- `chat` needs a fresh Cloudflare cookie (works right after using the app) and only
  sees the desktop app's account; a 403 means "open the app once and retry".

---

## 9. Keeping chats in sync across accounts

```bash
keyflip consolidate                    # every account's chat index shows ALL conversations
keyflip consolidate --watch            # re-sync on an interval whenever the app is closed
keyflip consolidate --watch --interval 60
```
- The desktop app's store is locked while it runs, so a one-shot offers to
  close→sync→reopen the app (`-y` to skip the prompt).
- Also runs automatically on every switch.

---

## 10. Request-level failover proxy (started on demand, never a daemon)

```bash
keyflip proxy start --wire             # start localhost proxy + wire Claude Code to it
keyflip proxy status                   # is it up? on what port? per-account totals
keyflip proxy stats                    # request/token totals by account
keyflip proxy stop                     # stop it and unwire settings.json
```
- While up it routes each request to the active account and **fails over to the next
  healthy account on 429/5xx** before the client sees a byte. Ideal for long unattended
  runs where mid-request limits are likely.

---

## 11. Backup & restore (keyflip's own metadata; no secrets)

```bash
keyflip backup now                     # snapshot keyflip metadata (accounts list, config)
keyflip backup list
keyflip backup restore 1               # restore by number or name (takes a safety backup first)
keyflip backup prune 5                 # keep only the newest 5
```

---

## 12. Moving to another machine (accounts + chats)

Four transports, same encrypted bundle. Pick by what's available:

### 12.1 By file — `keyflip migrate`
```bash
keyflip migrate export bundle.json --passphrase-file pass.txt   # ALL accounts +
                                     # providers + every session transcript, encrypted
keyflip migrate import bundle.json --passphrase-file pass.txt   # MERGE on the new machine
keyflip migrate import bundle.json --force                      # ...overwrite existing entries
keyflip migrate export bundle.json --no-sessions --no-providers # accounts only
```
- **MERGE = union:** anything already on the target is **kept, never clobbered**,
  unless `--force`. So you combine with the sessions already there.

### 12.2 By cloud relay (no LAN) — WebDAV
```bash
keyflip migrate push --url https://dav.example/kf.enc --passphrase-file pass.txt   # source
keyflip migrate pull --url https://dav.example/kf.enc --passphrase-file pass.txt   # target (previews + merges)
```

### 12.3 Live, device-to-device over the LAN — `keyflip transfer`
```bash
# On the SOURCE machine:
keyflip transfer serve                 # shows a one-time code + the command to run
# On the TARGET machine (auto-discovers the peer via a UDP beacon):
keyflip transfer pull --code K7Q29FMR
keyflip transfer pull 192.168.1.20:8787 --code K7Q29FMR   # ...or dial the host directly
keyflip transfer serve --ttl 300 --no-discovery           # longer window, no beacon
```
- The bundle is encrypted with the code; the listener is single-shot, rate-limited, and
  auto-expires. No file, no cloud.

### 12.4 Accounts only — `keyflip export/import`
```bash
keyflip export - | gpg -c > accounts.gpg      # accounts + tokens (SECRETS)
gpg -d accounts.gpg | keyflip import -
```
- **Note:** desktop-app and browser logins are machine-bound — re-capture them on the
  new machine with `keyflip onboard`.

---

## 13. Cross-device sync (keep two machines in step)

```bash
keyflip sync test --url https://dav.example/kf --user u --pass-file p.txt
keyflip sync push --url … --passphrase-file pass.txt      # encrypted push
keyflip sync pull --url … --passphrase-file pass.txt      # preview + apply (safety backup first)
# Or, zero-config: point KEYFLIP_CONFIG_DIR at a Dropbox/iCloud folder.
```

---

## 14. Sharing an account/provider pointer

```bash
keyflip share relay                    # → a keyflip:// link (provider, with key)
keyflip share relay --no-secrets       # ...omit the key
keyflip share work                     # account link is POINTER-ONLY (never the token)
keyflip import 'keyflip://…'           # preview + confirm + apply
```

---

## 15. Skills & MCP (teach agents keyflip)

```bash
keyflip install-skill                  # install the Claude Code skill that teaches agents keyflip
keyflip skill add owner/repo           # install any skill from GitHub (or ./dir, or file.tgz)
keyflip skill list | remove <name>     # only removes skills keyflip installed
keyflip mcp --setup                    # show how to register keyflip's MCP server
keyflip mcpreg add ctx -- some-server  # manage MCP servers once, project into Code + Desktop
keyflip mcpreg list | enable | disable | remove | import
```
- **Via MCP tools** (prefer over shelling out): `keyflip_status`, `keyflip_list`,
  `keyflip_switch`, `keyflip_next`, `keyflip_login`, `keyflip_logout`,
  `keyflip_browser_status/_logout`, `keyflip_consolidate`,
  `keyflip_migrate_export/_import`, providers, backups, sessions, proxy… Mutating tools
  require `confirm: true`.

---

## 16. Cleanup, reset & uninstall (destructive — always confirmed)

```bash
keyflip reset --soft                   # clear ONLY runtime state (usage history, breakers,
                                       # proxy state, caches, logs); KEEPS accounts
keyflip reset                          # FACTORY reset: DELETE all keyflip data (accounts,
                                       # providers, backups). App stays installed.
keyflip reset --logout                 # ...also sign out the live surfaces
keyflip reset --force --logout         # TOTAL zero: close all Claude Codes + logout, close
                                       # Chrome + extension logout, close desktop app + logout,
                                       # delete all backups + all auth
keyflip reset --logout --no-desktop    # log out CLI + browser but leave the desktop app alone
keyflip uninstall                      # remove keyflip from this machine (keeps your data)
keyflip uninstall --purge              # ...also delete all keyflip data
```
- `reset`/`uninstall` never touch `~/.claude/projects` (your transcripts). `uninstall`
  won't delete a source checkout. They prompt unless `--force`.

---

## 17. Cross-cutting variations

- **`--json`** on read commands → exactly one JSON object on stdout (`schemaVersion: 1`),
  human text on stderr, errors as `{"error":{…}}` with exit 1. Use it for scripting.
- **`-y` / `--yes`** → skip confirmation prompts (for automation).
- **`--force`** → skip a destructive command's prompt, or overwrite on import/merge.
- **`KEYFLIP_CONFIG_DIR`** → relocate keyflip's config (e.g. onto a synced folder).
- **`CLAUDE_CONFIG_DIR`** → what `run` isolates per-terminal.
- **Secrets** → always via `--key-file`/`--token`/`--pass-file`/`--passphrase-file`
  (a file or `-` for stdin); never as a command-line argument.

---

## 18. Suggested video arc (for NotebookLM)

1. **The problem** — one machine, many Claude accounts, four surfaces that drift apart.
2. **Capture** — `keyflip onboard` sets up two accounts hands-off.
3. **See** — `keyflip list --usage` shows who's active and who has quota left.
4. **Switch** — hit a rate limit → `keyflip next --strategy best` → back to work.
5. **Full alignment** — `keyflip work --browser` lines up CLI + app + browser + extension.
6. **Never lose a chat** — `keyflip consolidate` and `keyflip resume` across accounts.
7. **Move machines** — `keyflip transfer serve` / `pull` carries everything over the LAN
   and MERGES with what's already there.
8. **Clean exit** — `keyflip reset --soft` vs the factory `reset` vs `uninstall`.

---

*Every command has `--help`-level usage baked in; run it with no/invalid args to see
the exact flags. This catalog reflects keyflip's full surface as of this writing.*
