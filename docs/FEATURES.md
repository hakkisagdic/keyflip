# keyflip feature and test matrix

> What keyflip does, which tests cover each feature, and how far that coverage goes.
> Snapshot of 12 Nov 2026: `origin/main` b91805f plus the `fix/autoswitch-failover` landing
> (P0–P5 and the review fixes). Built from an offline inventory of the CLI dispatch, the MCP tool
> table, the launchd jobs on the owner's Mac and the test suite. No account was switched and no
> real token was read to make it.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| `tested` | Behaviour covered end to end (module and the surface that exposes it, or a CLI/MCP-level test). |
| `partly-tested` | The module is tested, but the CLI/MCP wiring, the interactive path or the real app/OS is not. |
| `untested` | No test exercises it (at most a tool-listing test that sees its name). |
| `broken` | Known to fail at runtime on the owner's machine, whatever the tests say. |
| `dead` | Code nothing reaches. |

"Fixed 12 Nov" marks rows the P0–P5 landing changed. Their tests are offline (fakes, sandbox HOME);
the live checks still owed are listed at the end.

## Test suite

| Run | Result |
| --- | --- |
| `npm test` (`node ./test/run.js`), b91805f, sandbox HOME, `KEYFLIP_TEST_CLAUDE=stopped` | 2058 tests: 2056 pass, 0 fail, 2 skipped, ~300 s |
| Same, `fix/autoswitch-failover` after the review fixes | 2145 tests: 2143 pass, 0 fail, 2 skipped, ~215 s |

Skipped: `keychain.real.test.js` (real Keychain round-trip, opt-in `KEYFLIP_REAL_KEYCHAIN=1`) and the
fish-parser case of `shellhook.test.js`. On some hosts the multicast case of `lanfleet.test.js` is
skipped as well.

Hermeticity: run the suite with `HOME` pointing at a sandbox. Without one, `login.test.js` and
`onboard.test.js` start the CLI against the real HOME (they write `~/.config/keyflip/logs/keyflip.log`
and commit `keyflip: setup` / `keyflip: onboard` to the config repo), and `refresh.js` writes
`refresh-metrics.json` under `os.homedir()` when no config dir is given. The suite sets
`KEYFLIP_TEST_OFFLINE=1`, so fixture tokens never reach the OAuth profile endpoint.

## Background jobs and runtime state

| Surface | Feature | What | Tests | Status |
| --- | --- | --- | --- | --- |
| launchd | `com.keyflip.autoswitch` | Every 120 s, `autoswitch --once -y`: one tick of switching, failover and Desktop follow-up. | autoswitchservice (P0 argv, refusal, last exit), autoswitch-surfaces | `tested` — fixed 12 Nov. Before: exit 127 on all 1016 runs since 10 Nov (fnm per-shell shim, no node on launchd PATH, no log, threshold 100). Now `<absolute node> <absolute script>`, PATH + log in the plist, install refuses an unrunnable argv, `status` reads the last exit code. |
| launchd | `com.keyflip.refresh` (04:30) | Nightly `refresh --all` of saved OAuth tokens. | schedule, oauth, refresh-held | `partly-tested` — fixed 12 Nov (b8fa733). It used to skip every run because "Claude Code is running" (always true on this Mac), so it let the yahoo login die on 3 Nov. It now renews every account nothing is using. Not yet seen live. |
| launchd | `com.keyflip.refresh-daemon` | 5-minute daemon (`bin/keyflip-refresh.js`); proactive only for antigravity and codex. | refresh (9, incl. daemon boot) | `tested` — runs from the global npm copy (pid up since 31 Oct). By design it does not renew Claude tokens. |
| launchd | `com.keyflip.conv-index` (30 min) | `conv index --embed` (BM25 + ollama bge-m3). | convindex, conv-cli, schedule | `tested` — exits 0. Rounds take over 10 min and re-embed 100–186 conversations each time (possible churn). Two sources over 160 MB are skipped. |
| launchd | `com.keyflip.dream` (03:00) | Nightly distil/archive of old chats. | schedule, memory | `tested` — not installed. With `llm.provider=claude` it would spend the active account's quota. |
| launchd (polyctl, outside this repo) | `dev.polyctl.quota-guard` | `quota_guard.py` runs `keyflip usage --json` every 1800 s and stops agents when every account hits 100 % weekly. | none | `broken` — it reads `sevenDayPct` / `sevenDay.utilization`, while keyflip writes `sevenDay.pct`, so the guard is blind (line 41; fix: `.get("pct")`). Since P1 it costs at most one request per window. |
| runtime | `.usage-cache.json`, `.usage-throttle.json` | The machine-wide usage cache and 429 windows (per account and per token fingerprint). | usage, usage-throttle | `tested` — fixed 12 Nov |
| runtime | `.identity-cache.json` | Token fingerprint → account; only `token-profile` (endpoint) entries count as verified. | identity | `tested` — fixed 12 Nov |
| runtime | `.desktop-restart.json`, `.failover-state.json` | A pending Desktop restart, an engaged API failover. Kept out of git and backups. | desktoprestart, failover | `tested` — fixed 12 Nov |

## Accounts, switching and quota (CLI)

| Surface | Feature | What | Tests | Status |
| --- | --- | --- | --- | --- |
| cli | `keyflip autoswitch install / status / uninstall` | Installs, inspects or removes the unattended service (launchd StartInterval, cron on Linux). Interval clamped 60–21600 s, threshold 50–100. | autoswitchservice (16), autoswitch-surfaces | `tested` — fixed 12 Nov (P0). It also prefers the installing code over a stale PATH copy and says so. |
| cli | `keyflip autoswitch --once` | One tick: identity, usage, switch at the threshold (95 % by default, P3), failover (P4), Desktop follow-up (P5). | autoswitch (10), failover (22), identity, usage-throttle, reliability2, autoswitch-surfaces, desktoprestart (CLI `--once`) | `tested` — fixed 12 Nov |
| cli | `keyflip autoswitch` (foreground loop) | `-y` loop every `--interval` s (min 30) with the same tick. | autoswitch tick tests, notify | `partly-tested` — the loop and confirm gate in `cmdAutoswitch` have no test. |
| cli | `keyflip status [--fix [--force]]` | Which account each surface is on. The CLI account is decided by the live token; `--fix` repairs a wrong label only after the profile endpoint confirms it. An inference-only token (`login --long-lived`, scope `user:inference`) is never sent to the endpoint: it needs `user:profile` and answers 403. For that case `--fix --force` relabels only on a fingerprint match to the account's login capture (`longlived__<name>`), writes an audit line to `logs/keyflip.log` and a history event, and is never taken by a tick or MCP. | cli.flags, cli, identity (CLI status/--fix), identity-force (7), provider | `tested` — fixed 12 Nov (P2); `--force` new 12 Nov (follow-up). The live endpoint response shape is not yet verified. |
| cli | `keyflip list` | Saved accounts with active and capture flags. | cli, cli.flags | `tested` — "active" now follows the token. |
| cli | `keyflip list --usage` / `keyflip usage [--history / --providers]` | 5 h / 7 d quota per account; trend and events; other tools' limits. | usage (10), usage-throttle, provusage (19), reliability2 | `tested` — fixed 12 Nov (P1): Retry-After honoured, exponential back-off, one poll per window machine-wide (cross-process lock). |
| cli | `keyflip <name/number>` (switch) | Switches CLI, desktop app and browser; `--restart`, `--force`, `--only`, `--dry-run`, `--rollback-on-fail`; reads itself back. | cli, switch-dryrun (7), core, desktop-tug (6), app-preserve (11), cli.flags | `partly-tested` — now asks the profile endpoint before preserving the outgoing token. The real desktop app path is untested (tests use `KEYFLIP_TEST_CLAUDE`). `--force` still leaves Desktop on the old login until a restart. |
| cli | `keyflip next [--strategy] [--group]` | Rotates, or picks by remaining quota. | cli.flags, usage, groups (11) | `partly-tested` |
| cli | `keyflip add [name] [--app] [--dry-run]` / `add <name> --token` | Saves the logged-in account(s); headless token import. | cli, session, core (8), appauth (30), identity | `tested` |
| cli | `keyflip setup` / `keyflip onboard` | Interactive first-run wizards. | onboard (6), onboard-provider (5) | `partly-tested` — helpers and the non-TTY refusal only (that test touches the real HOME). |
| cli | `keyflip login [...]` | Official sign-in in an isolated config; `--long-lived` mints a one-year token. | login (8), longtoken (17), oauth (7) | `partly-tested` — the interactive flow is untested; `--json login` runs against the real HOME. |
| cli | `keyflip logout` | Signs out of live sessions, keeps saved accounts. | cli | `tested` |
| cli | `keyflip remove <name> [--force]` | Deletes a saved account and its credential. | cli, core, longtoken | `tested` |
| cli | `keyflip enable / disable <account>` | Excludes an account from autoswitch and the proxy. | autoswitch, proxy (effect only) | `untested` — no CLI test; not in help or the catalog. |
| cli | `keyflip browser [status/logout/capture/sync]` | The browser's claude.ai account. | browser (18), browserswitch (10), app-preserve, win-cookies (8) | `partly-tested` — no CLI test. |
| cli | `keyflip verify [acct] [--usage] [--live]` | Reads each surface back the way its app would. | verify (11), longtoken, switch-dryrun | `partly-tested` |
| cli | `keyflip freshness / age` | Age of every saved login and "Sign in again" detection. | verify, sessionage (13) | `partly-tested` |
| cli | `keyflip refresh [...]` / schedule / daemon / metrics | Renews stored OAuth tokens; nightly job or 5-min daemon. | refresh (9), schedule, oauth, longtoken, refresh-held | `partly-tested` — fixed 12 Nov (b8fa733). `refresh.js` writes metrics under `os.homedir()` without a config dir. |
| cli | `keyflip tier / tiers` | Plan per account and routable model families. | cli, tiers (7) | `tested` |
| cli | `keyflip cooldown [clear/reset]` | Parked accounts and the proxy's try order. | cli, proxy | `tested` |
| cli | `keyflip run <name>` | Claude as that account in this terminal (isolated config), token synced back. | session, autoswitch | `tested` |
| cli | `keyflip launch-cmd` | Prints an isolated launch command (POSIX/PowerShell). | session | `partly-tested` — not in help or the catalog. |
| cli | `keyflip link` / `keyflip shell-init` | Directory → account pins; cd hook. | autoswitch, shellhook (14) | `partly-tested` |
| cli | `keyflip group / policy` | Account pools; directory → account rules. | groups (11), policy (26), autoswitch | `partly-tested` — no CLI test. |
| cli | `keyflip budget` | Usage ceilings with alerts. | budget (29) | `partly-tested` |
| cli | `keyflip cost [...]` | Spend, time-to-limit, per-repo cost, rate cards, price table. | cli (rates, prices), cost (36), prices (16) | `tested` — status/predict/by-project have no CLI test. |
| cli | `keyflip api <add/set/orgs/status/list/remove/test>` | Monthly Console API credit per org. | apicredits (15) | `partly-tested` — no CLI test, not in the catalog. It enforces no spend cap (the P4 cap lives in keysmith). |

## Failover, providers and Desktop (CLI)

| Surface | Feature | What | Tests | Status |
| --- | --- | --- | --- | --- |
| cli | `keyflip failover setup / status / on / off` | P4: keysmith's own alias `claude-failover` (claude-failover-api → kiro-emu → agy) and the cap keysmith enforces on its paid leg ($25 over 12 Nov..9 Dec). keyflip reads both from keysmith's config and never creates an alias or writes a cap; setup mints a key scoped to the alias and its legs (kept in the store) and saves a provider profile (not activated). Engages only when every other account is known to be out and the running gateway reports a cap of at most `failover.capUsd` on the paid leg. While engaged it checks the gateway on every tick and fails back when an account recovers or the binding window resets. | failover (21), desktoprestart | `tested` — aligned with keysmith 12 Nov (follow-up). No keysmith restart needed: the gateway picks up the new key itself. |
| cli | Claude Desktop follow-up (P5) | Restarts Desktop only while it is idle (Desktop Claude Code sessions, agent-session writes in the last 60 s, CPU < 20 %), with a notification. Only the main app counts as running; a running keyflip clone defers the restart; a refused quit is retried after 30 min; a pending restart expires after 12 h and follows the CLI's current account. | desktoprestart (22) | `partly-tested` — new 12 Nov. Never run against the real app. |
| cli | `keyflip gateway use / off / restore / status` | Points Claude Desktop at a provider (3p mode) or back (1p). | bigscope, review-fixes, mcp (status) | `partly-tested` — no CLI test; takes effect after a Desktop restart. |
| cli | `keyflip provider ...` / `keyflip use <name>` | Third-party endpoints with keys in the credential store; Claude Code env block in settings.json. | provider, catalog (10), onboard-provider, review-fixes | `tested` |
| cli | `keyflip speedtest` / `keyflip test <provider>` | Endpoint latency; one real auth request. | provider, reliability2 | `partly-tested` |
| cli | `keyflip import-env` | Provider endpoints from a .env file or the environment. | importcreds (29) | `partly-tested` |
| cli | `keyflip proxy start/stop/status/stats/routes/explain` | Local failover proxy (429/5xx → next account, Retry-After honoured, breakers, routes). | proxy (35), proxyroutes (13), cli (routes) | `tested` — start/stop/status/stats have no CLI test. Its default port 8787 collides with the keysmith gateway. |
| cli | `keyflip route / cache` | Model routing, arbitrage, response cache. | router (21) | `partly-tested` |
| cli | `keyflip llm` | Which model runs the chores, and on whose quota. | llm-cli (6), llm-provider (10) | `tested` |
| cli | `keyflip notify` / `keyflip post` | Webhook / desktop alerts; status posts. | notify (18), notify-wiring (3), integrations (23) | `tested` — off on this Mac. Failover and Desktop restarts fall back to a macOS banner. |
| cli | `keyflip vault` | 1Password / Bitwarden / HashiCorp Vault backends. | vault (20) | `partly-tested` |

## Other tools' accounts and instances (CLI)

| Surface | Feature | What | Tests | Status |
| --- | --- | --- | --- | --- |
| cli | `keyflip kiro [...]` | Kiro CLI (Keychain) and IDE sessions. | kiro (14) | `partly-tested` — CLI wiring untested. |
| cli | `keyflip chatgpt / codex [...]` | ChatGPT.app and Codex CLI (`~/.codex/auth.json`). | codex (18) | `tested` |
| cli | `keyflip commandcode [...]` | Command Code CLI and VS Code login. | commandcode (11) | `partly-tested` |
| cli | `keyflip grok / qwen / kimi / hermes [...]` | Generic CLI-surface capture and switch. | surface | `partly-tested` — not in help or the catalog. |
| cli | `keyflip antigravity / agy [...]` | Antigravity CLI capture and switch. | none (refresh tests only touch its strategy entry) | `untested` |
| cli | `keyflip instance / inst [...]` | APFS-cloned per-account app copies. | instance-integration (12), doctor | `partly-tested` — launch/focus/kill/enable-all untested. One clone (kiro/kiro-2) exists, stopped, with a stale pid. |
| cli | `keyflip claude-profiles / clp` | Compatibility alias onto instances. | none | `untested` |
| src | `src/claude-profiles.js` | Older per-account Desktop profile manager. | none | `dead` — nothing imports it. |

## Conversations, sessions and memory (CLI)

| Surface | Feature | What | Tests | Status |
| --- | --- | --- | --- | --- |
| cli | `keyflip sessions [...]` | Browse and maintain Claude Code transcripts (rebind, archive, distill, compact, assign, export, delete, scrub, edit). | sessions (8), rebind (22), sessions-liveness (14), archive (5), sessionedit (13), attrib (17), pii (23), transcript (7) | `partly-tested` — only `sessions assign` runs through the CLI. |
| cli | `keyflip threads [...]` | One name for the same task across accounts. | cli (end to end), threads (25), menu.threads (9) | `tested` |
| cli | `keyflip resume` | Resume in the original directory, optionally as another account. | sessions, sessionmap (3) | `partly-tested` |
| cli | `keyflip send` | Inject a message headlessly. | none (`sendCommand`) | `untested` |
| cli | `keyflip cowork` | Desktop Cowork sessions across accounts. | cowork-chat (8) | `tested` |
| cli | `keyflip chat [...]` | claude.ai Chat (cookie-based, experimental). | chat (11), chatsession (10), cli | `partly-tested` |
| cli | `keyflip consolidate` | Sync every account's chat index. | consolidate (3), appsessions (16) | `tested` |
| cli | `keyflip dream [...]` | Distil and archive old chats; nightly job. | llm-cli, schedule (25), archive | `tested` |
| cli | `keyflip recall` | Search distilled chats (BM25, embeddings, synthesis). | recall (9), bm25 (4) | `partly-tested` |
| cli | `keyflip conv / conversations [...]` | Every local AI tool's chats: browse, search, RAG context, export, handoff, index. | conv-cli (5), convindex (46), convexport (7), convaccounts (14), conversations (14), schedule | `tested` |
| conv | Codex rollout id (`codexOwnId`) | A Codex conversation id. | conversations, convindex | `tested` — fixed 12 Nov (651c5fc). It used to take any UUID in the absolute path, so rollouts collided when a parent directory held one; now it reads the file name only. |
| cli | `keyflip foreign` | Another agent's session file, normalised. | foreign (20), cursor (36) | `partly-tested` |
| cli | `keyflip context / ctx [...]` | Tool-independent project memory in `.keyflip/`. | context-cli (5), ctxsync (24), projctx (14) | `tested` |
| cli | `keyflip rules` | Normalise and re-emit AI rule files. | rulesmodel (11) | `partly-tested` |
| cli | `keyflip checkpoint` | Session-boundary snapshots tied to git. | checkpoint (13), context-cli | `tested` |
| cli | `keyflip handoff` | Continue-prompt for another tool. | handoff (15) | `partly-tested` |
| cli | `keyflip memory [...]` | Keepsakes; secret audit. | memory (4), leakscan (11) | `partly-tested` |

## Sync, fleet and maintenance (CLI)

| Surface | Feature | What | Tests | Status |
| --- | --- | --- | --- | --- |
| cli | `keyflip share / export / import` | keyflip:// links; account backup and restore. | qol, transfer | `tested` |
| cli | `keyflip sync [push/pull/test]` | Encrypted WebDAV sync. | bigscope, review-fixes | `partly-tested` |
| cli | `keyflip migrate [...]` | Move everything to a new machine. | migrate-cli (7), migrate (21), migrate-stream (18) | `tested` |
| cli | `keyflip transfer [...]` | Live LAN / relay transfer. | lantransfer (14), relaytransfer (11), relayserver (16), qr (13), migrate-cli | `partly-tested` |
| cli | `keyflip fleet [...]` | Manage all machines: discovery, pairing, remote switch. | fleet (33), fleet-discovery (4), fleet-push (3), lanfleet (10) | `tested` |
| cli | `keyflip swarm / team [...]` | Commands across fleet machines; encrypted team pool. | swarm (19), teampool (14) | `partly-tested` |
| cli | `keyflip ui / panel / menubar / statusline / menu` | TUI, web dashboard, menu-bar plugin, status line, menu. | tui (23), panel (14), menubar (9), cli (statusline), menu.keys (7), menu.threads (9) | `partly-tested` — statusline end to end; the others at module level. The status line writes an absolute fnm node path. Since 12 Nov (follow-up) it names the account by token like `status` (identity-force), marks a label fallback `(label?)` and a wrong label `⚠ label≠token`. |
| cli | `keyflip agents / surfaces` | Other agents' memory/config; installed AI tools. | cli, agents (24), surface (19) | `tested` |
| cli | `keyflip skill [...]` / `install-skill` | Skills into every agent. | skillsync (20), skillstore (7), qol | `tested` — install-skill has no CLI test. |
| cli | `keyflip mcpreg [...]` | One MCP registry written into every agent. | mcp, mcpreg (13), bigscope, review-fixes | `tested` |
| cli | `keyflip mcp [--setup/--register]` | stdio MCP server (194 tools in `src/mcp.js`, 212 with module tools). | mcp (30) and module tests | `partly-tested` — 93 of 194 tool names appear in tests. |
| cli | `keyflip codexbar` / `keyflip brain` | CodexBar bridge; opt-in Gemini planner. | codexbar (18), brain (30) | `partly-tested` — not in the catalog. |
| cli | `keyflip doctor / scrub-history / secrets / chains` | Diagnosis (now includes the autoswitch service), history scrub, tolerated findings, credential map. | doctor (41), cli, secretpolicy (13), leakscan, chains (20) | `tested` — chains has no CLI test. |
| cli | `keyflip backup / versioning / history / undo / restore / log` | Metadata snapshots, git-versioned config, audit log. | backup, qol, review-fixes, vcs (9), auditview (15) | `partly-tested` |
| cli | `keyflip config` / `keyflip settings` | keyflip settings; `~/.claude/settings.json`. | config (21), cli, settings (3) | `partly-tested` |
| cli | `keyflip license` / `keyflip upgrade` | Offline open-core license (gate off unless `KEYFLIP_LICENSING`); self-update. | license (21), update (5) | `partly-tested` |
| cli | `keyflip reset` / `keyflip uninstall` | Factory reset; remove keyflip. | cli, uninstall (12) | `tested` |
| cli | `version / help / unknown command` | Version, usage, exit 1 on an unknown word. | cli, instance-integration | `tested` |
| src | `src/commands.js` CATALOG | 97 commands for the `ui` palette. | commands (12) | `partly-tested` — drifted from dispatch (missing: api, brain, codexbar, antigravity/agy, grok/qwen/kimi/hermes, instance/inst, claude-profiles/clp, enable, disable, launch-cmd); the test spot-checks 13 names. |

## MCP tools

"listed" means the tool appears only in the `tools/list` lifecycle test. "gate" means the test stops at
the `confirm` gate or its preview. Every mutating tool requires `confirm: true`. An offline drill with
`{}` arguments (spawn and network blocked) gave 68 ok, 119 stopped at the gate, 17 argument errors,
3 blocked, 5 input errors and 0 crashes.

| Surface | Feature | What | Tests | Status |
| --- | --- | --- | --- | --- |
| mcp | `keyflip_status` | Active account per surface, by token; `identityVerified`, `labelMismatch`. | mcp, identity | `tested` — fixed 12 Nov |
| mcp | `keyflip_list` | Saved accounts, capture flags, active (by token), optional usage. | mcp, usage | `tested` — fixed 12 Nov |
| mcp | `keyflip_switch` | Switch the CLI (and record the Desktop follow-up). | mcp, identity, desktoprestart | `tested` — fixed 12 Nov: asks the endpoint first, says Desktop follows through an idle restart. |
| mcp | `keyflip_switch_plan` | Dry run of a switch. | mcp, switchfacts, sessionage | `tested` |
| mcp | `keyflip_next` | Rotate, optionally by quota. | listed; usage, policy | `partly-tested` |
| mcp | `keyflip_autoswitch_tick` | One tick (switch / failover / Desktop record). Threshold clamped 50–100. | failover (MCP clamp), autoswitch | `tested` — fixed 12 Nov |
| mcp | `keyflip_autoswitch_service` | Install / remove / inspect the service. | autoswitchservice (module) | `partly-tested` — fixed 12 Nov in the module; the tool itself is not called by a test. |
| mcp | `keyflip_verify` / `keyflip_refresh` | Read-back; proactive token refresh. | mcp, longtoken, oauth | `tested` |
| mcp | `keyflip_enable` / `keyflip_launch_cmd` | Re-enable an account; launch command. | mcp, autoswitch, session | `tested` |
| mcp | `keyflip_disable` | Disable an account. | mcp (gate) | `partly-tested` |
| mcp | `keyflip_account_remove` | Delete a saved account. | core, longtoken (module) | `partly-tested` |
| mcp | `keyflip_login` | Official sign-in in an isolated config. | listed | `untested` |
| mcp | `keyflip_logout` | Sign out of live sessions. | mcp (gate), browser | `partly-tested` |
| mcp | `keyflip_browser_status` | claude.ai account per browser. | mcp, login, exec | `tested` |
| mcp | `keyflip_browser_logout` / `keyflip_browser_sync` | Clear or restore claude.ai cookies. | browser (module) | `partly-tested` |
| mcp | `keyflip_tiers` / `keyflip_tier_set` | Plan per account; override. | listed; tiers, proxy | `partly-tested` |
| mcp | `keyflip_links` | Directory → account pins. | mcp | `tested` |
| mcp | `keyflip_link` | Pin a directory. | mcp (gate) | `partly-tested` |
| mcp | `keyflip_groups` / `keyflip_group_tag` / `keyflip_group_untag` | Account pools. | groups (module) | `partly-tested` |
| mcp | `keyflip_import_env` | Import credentials from .env / environment. | importcreds (module) | `partly-tested` |
| mcp | `keyflip_cooldowns` / `keyflip_cooldown_clear` | Parked accounts. | listed; proxy | `partly-tested` |
| mcp | `keyflip_usage_history` | Usage samples and autoswitch/failover events. | listed; reliability2 | `partly-tested` |
| mcp | `keyflip_budget_status` / `_set` / `_clear` | Usage ceilings. | budget (module) | `partly-tested` |
| mcp | `keyflip_provider_usage` / `keyflip_codexbar` | Other tools' limits; CodexBar. | provusage, codexbar (module) | `partly-tested` |
| mcp | `keyflip_statusline` | Claude Code status line. | exec, foundations (module) | `partly-tested` |
| mcp | `keyflip_post_status` | Status to a webhook. | integrations | `tested` |
| mcp | `keyflip_cost_status` / `_predict` / `_by_project` / `_rates` / `_prices` / `_prices_refresh` | Cost and price data. | cost, prices (module); some listed | `partly-tested` |
| mcp | `keyflip_providers` / `keyflip_provider_catalog` / `keyflip_provider_use` / `keyflip_provider_add` | Provider endpoints. | mcp, provider, catalog | `tested` |
| mcp | `keyflip_provider_models` / `keyflip_provider_remove` / `keyflip_test_provider` / `keyflip_speedtest` | Models, delete, auth test, latency. | module tests only | `partly-tested` |
| mcp | `keyflip_proxy_status` / `_routes` / `_explain` | Proxy state and routing. | listed; proxy, proxyroutes | `partly-tested` |
| mcp | `keyflip_proxy_control` | Start/stop the proxy. | listed | `untested` |
| mcp | `keyflip_route_list` / `_set` / `_clear` / `_arbitrage`, `keyflip_cache_status` / `_purge` | Routing and response cache. | router (module) | `partly-tested` |
| mcp | `keyflip_llm` | Chore LLM and cost (spawns a `claude` probe even with `{}`). | mcp, llm-provider | `tested` |
| mcp | `keyflip_vault_status` | Secret backend in use. | vault | `tested` |
| mcp | `keyflip_vault_use` / `keyflip_vault_off` | Change the secret backend. | vault (gate) | `partly-tested` |
| mcp | `keyflip_gateway_status` | Desktop on a gateway or first-party. | mcp, bigscope | `tested` |
| mcp | `keyflip_gateway_use` / `keyflip_gateway_off` | Desktop to a gateway or back (after a restart). | bigscope, review-fixes (module) | `partly-tested` |
| mcp | `keyflip_chatgpt` / `keyflip_chatgpt_backups` | Codex/ChatGPT login status; backups. | codex | `tested` |
| mcp | `keyflip_chatgpt_capture` / `_switch` / `_refresh` / `_restore` | Codex/ChatGPT login changes. | codex (gate) | `partly-tested` |
| mcp | `keyflip_commandcode` / `_capture` / `_switch` / `_remove` | Command Code login. | commandcode (module) | `partly-tested` |
| mcp | `keyflip_cli_surface` / `_capture` / `_switch` / `_remove` | Grok / Qwen / Kimi / Hermes logins. | mcp, surface | `tested` |
| mcp | `keyflip_surfaces` | Installed AI tools. | surface | `tested` |
| mcp | `keyflip_instances` / `keyflip_instance_create` / `keyflip_instance_harden` | List, create, harden clones. | instance-integration, doctor | `partly-tested` |
| mcp | `keyflip_instance_launch` / `_focus` / `_kill` | Launch, focus, kill a clone. | listed | `untested` |
| mcp | `keyflip_conv_list` / `_show` / `_search` / `_context` / `_index` / `_export` | Conversations across tools (`_show` with `{}` errors on `undefined`). | mcp, convindex, convexport | `tested` |
| mcp | `keyflip_conv_status` / `keyflip_conv_index_schedule` | Index status; schedule. | listed / gate; schedule | `partly-tested` |
| mcp | `keyflip_cowork` / `keyflip_chat` / `keyflip_recall` / `keyflip_foreign_export` | Cowork, claude.ai chat, recall, foreign sessions. | module tests | `partly-tested` |
| mcp | `keyflip_sessions` | Past Claude Code conversations. | mcp, attrib, rebind | `tested` |
| mcp | `keyflip_resume_command`, `keyflip_sessions_export` / `_rebind` / `_archive` / `_archived` / `_unarchive`, `keyflip_session_delete` / `_scrub` / `_edit`, `keyflip_pii_scrub_text`, `keyflip_send`, `keyflip_sessions_assign` / `_attribute` / `_distill` / `_compact`, `keyflip_dream` / `_schedule` | Session maintenance. | module tests only | `partly-tested` |
| mcp | `keyflip_threads` / `keyflip_thread_create` / `_add` / `_remove` / `_drop` / `_mirror` | Threads. | mcp (#35), threads | `tested` |
| mcp | `keyflip_consolidate_plan` | Dry run of consolidate. | mcp, appsessions | `tested` |
| mcp | `keyflip_consolidate` | Merge Desktop session stores. | mcp (gate) | `partly-tested` |
| mcp | `keyflip_handoff` | Continue-prompt. | handoff | `tested` |
| mcp | `keyflip_memory`, `keyflip_context_read` / `_task_set` / `_decision_add`, `keyflip_rules_show` / `_emit`, `keyflip_checkpoint_list` / `_latest` / `_create`, `keyflip_ctxsync_mode`, `keyflip_brain_propose`, `keyflip_agents` | Project memory and rules. | module tests only | `partly-tested` |
| mcp | `keyflip_ctxsync_status` | Context-sync privacy mode. | none | `untested` |
| mcp | `keyflip_skills` / `keyflip_skill_add` / `_sync` / `_remove` | Skills. | listed; skillsync | `partly-tested` |
| mcp | `keyflip_skill_agents` | Agent skill directories. | listed | `untested` |
| mcp | `keyflip_mcpreg_list` / `_set` / `_enable` / `_remove` | MCP registry. | mcp (parity), mcpreg | `tested` |
| mcp | `keyflip_fleet_push` | Publish status, process the inbox. | fleet-push | `tested` |
| mcp | `keyflip_fleet_status` / `_switch` / `_send_account` / `_trust` / `_keys` / `_discover` / `_collect` | Fleet. | fleet, transfer (module); UDP blocked in the drill | `partly-tested` |
| mcp | `keyflip_swarm_run` / `_ping` / `_results`, `keyflip_team_members` / `_publish` / `_pull` / `_member_add` / `_member_remove` | Swarm and team pool. | swarm, teampool (module) | `partly-tested` |
| mcp | `keyflip_migrate_export` / `_import` / `_push` / `_pull`, `keyflip_transfer_pull` / `_relay_pull` | Migration and transfer. | migrate, lantransfer, relaytransfer (module) | `partly-tested` |
| mcp | `keyflip_share` | keyflip:// link. | mcp (parity), qol | `tested` |
| mcp | `keyflip_share_apply` | Apply a link. | mcp (gate) | `partly-tested` |
| mcp | `keyflip_sync_test` | WebDAV reachability. | none | `untested` |
| mcp | `keyflip_sync_push` / `keyflip_sync_pull` | Encrypted WebDAV sync. | bigscope (module) | `partly-tested` |
| mcp | `keyflip_jobs` / `keyflip_job_enqueue` / `keyflip_job_run` | Headless job queue (only rejection paths of `job_run`). | orchestrator | `tested` |
| mcp | `keyflip_fanout` | Same prompt across accounts. | orchestrator (gate) | `partly-tested` |
| mcp | `keyflip_policy_list` / `keyflip_policy_check` | Policy read. | policy | `tested` |
| mcp | `keyflip_policy_add` / `keyflip_policy_remove` | Policy write. | policy (gate) | `partly-tested` |
| mcp | `keyflip_history_audit` / `keyflip_memory_audit` / `keyflip_history_scrub` / `keyflip_memory_redact` / `keyflip_secrets_policy` / `keyflip_secrets_tolerate` / `keyflip_chains` | Secret audit and scrub; credential map. | mcp, leakscan, secretpolicy, chains | `tested` |
| mcp | `keyflip_chains_tighten` / `keyflip_audit_log` | chmod secret files; action log. | chains (gate), auditview | `partly-tested` |
| mcp | `keyflip_doctor`, `keyflip_backups` / `_backup_create` / `_backup_restore`, `keyflip_config_list` / `_set` / `_unset`, `keyflip_settings` (write path), `keyflip_notify_status` / `_set` / `_test`, `keyflip_history` / `keyflip_undo` / `keyflip_restore`, `keyflip_shell_init`, `keyflip_refresh_schedule` | Maintenance. | module tests; some listed or gate | `partly-tested` |
| mcp | `keyflip_config_get` | Read one setting. | none | `untested` |
| mcp | `keyflip_license_status` | License and enforcement state. | license | `tested` |
| mcp | `keyflip_license_activate` | Activate a license file. | license (gate + file) | `partly-tested` |

## Live checks still owed (owner only)

The landing was verified offline. Only the owner can check these, because they need a real switch,
a real login or a real Desktop:

1. A real switch at 95 %: the service log (`~/Library/Logs/autoswitch-keyflip.log`) shows the switch,
   Claude Code keeps working, and Claude Desktop restarts onto the new account only when it is idle.
2. The profile endpoint's answer: `keyflip status --json` shows `identityVerified: true` for a full
   login. The 12 Nov live token was gmail's one-year inference-only token, which the endpoint refuses
   (403, no `user:profile`); its label was fixed with `keyflip status --fix --force` (follow-up).
3. The failover: `keyflip failover setup`, then `keyflip failover status` should say ready and show
   the cap as reported by the running gateway (done 12 Nov, follow-up).
