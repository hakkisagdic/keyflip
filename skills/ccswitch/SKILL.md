---
name: ccswitch
description: >-
  Manage multiple Anthropic/Claude accounts on this machine with the ccswitch
  CLI: check which account is active, compare each account's remaining 5h/7d
  quota, switch or rotate accounts (with the user's consent), run a second
  account in parallel in one terminal, and diagnose login/quota problems.
  Use when the user mentions switching Claude accounts, hitting rate limits /
  usage caps, "which account am I on", account quotas, or parallel accounts.
---

# ccswitch — operating multiple Claude accounts

ccswitch swaps the machine's Claude credentials between saved accounts. It
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
4. If MCP tools named `ccswitch_*` are available, prefer them over shelling
   out; their semantics match the CLI (`ccswitch mcp --setup` shows setup).

## Read state (safe, no confirmation needed)

```bash
ccswitch status --json          # {"cli":{"email":...},"app":{"name":...,"email":...}}
ccswitch list --json            # accounts + cliCaptured/appCaptured/activeCli/activeApp
ccswitch list --usage --json    # + usage {fiveHour:{pct},sevenDay:{pct}}, usageStatus, headroomPct
```

`usageStatus` sentinels: `ok`, `expired` (token invalid — the account needs a
re-`add`), `throttled` (usage endpoint throttled this token — **unknown**, NOT
proof the account is rate-limited), `error` (network), `no-creds`/`no-token`.
`headroomPct` = remaining % before the binding 5h/7d window; `null` = unknown.

## Switching (get consent first)

```bash
ccswitch <name|number> --force     # swap in place; a running Claude Code picks it
                                   # up on its next request (keychain cache ~30s on macOS)
ccswitch <name> --restart          # also close & reopen the desktop app (full switch)
ccswitch next --strategy best            # rotate to the account with most headroom
ccswitch next --strategy next-available  # first account that isn't exhausted
```

Inside an active Claude Code conversation, prefer `--force` (in-place): the
session continues on the new account without closing anything. Use `--restart`
only when the user also wants the desktop app moved — it closes the app.

## When the user hits a rate limit

1. `ccswitch list --usage --json` — find candidates with `headroomPct > 0`.
2. Report the options and ask which account to switch to (or propose
   `next --strategy best`).
3. After consent: `ccswitch <name> --force` (or the `ccswitch_switch` MCP tool
   with `confirm: true`).
4. Long unattended runs: suggest `ccswitch autoswitch --threshold 90 -y`
   (auto-rotates the CLI credential at the threshold; never touches the app).

## Parallel accounts in one terminal

```bash
ccswitch run <name> -y -- --resume     # run Claude Code as <name> ONLY here
ccswitch run <name> --share-history -y # ...sharing conversation history too
ccswitch link <name>                   # map this directory tree to an account;
                                       # then plain `ccswitch run` here uses it
```

`run` isolates via `CLAUDE_CONFIG_DIR`; other terminals/the desktop app keep
their account. Warn the user: an in-session token refresh can log out other
live copies of the same account.

## Fixing problems

| Symptom | Fix |
|---|---|
| `usageStatus: "expired"` | log that account in once, then `ccswitch add` |
| account shows `[cli — ]` or `[app — ]` in `list` | that surface was never captured: `ccswitch add` (CLI and/or app auto-detected) or `ccswitch add <name> --app` |
| "keychain locked" errors | ask the user to unlock the login keychain; profile storage falls back to files automatically |
| switch says an account is in use by live sessions | those PIDs are real running Claudes — ask the user before `--force` |
| moving to a new machine | `ccswitch export -` (SECRETS — pipe through gpg) → `ccswitch import` there; desktop logins must be re-captured on the new machine |

Never print or log credential blobs, tokens, or export file contents.
