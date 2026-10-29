# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Declarative proxy routing: `proxy-routes.json`, rules, sticky sessions and a model chain.**
  The failover proxy can now decide *per request* instead of only reordering accounts.
  `~/.config/keyflip/proxy-routes.json` (optional; `keyflip proxy routes init` writes a valid
  starter) holds first-match `rules` whose `when` tests `model`, `path`, `header` (name → glob),
  `tokensGt` (a no-dependency ~chars/4 estimate, so "only huge requests" is expressible), `account`
  and `user` (globs `*`/`?`), and whose `use` picks an account and/or a model. A rule may only name
  an account that is usable right now — a cooldown or open breaker always wins and the reason says
  so. `sticky` keeps a conversation (`metadata.user_id`, or the opt-in `x-keyflip-session` header)
  on the account that last succeeded for `ttlSeconds` (in-process, bounded at 1000 conversations).
  `fallback` is `off` (commit the first response, never retry), `retry` (the existing failover) or
  `model-chain` (on 429/529/5xx degrade to the next model **on the same account** before spending
  another account's quota; a model problem is not an account failure, so no breaker is tripped).
  `transforms` set/remove request headers, override the body model and cap `max_tokens` (only ever
  lowered; a non-JSON body is forwarded untouched). `CUSTOM_ROUTER_PATH` (or `customRouter` in the
  file) is an async helper script fed `{model,path,user,tokens,accounts}` on stdin that answers
  `{account,model,reason}` — 1.5 s timeout, 64 KB cap, any failure falls back to the rules.
  The file hot-reloads on the next request (mtime+size), an invalid file is ignored with every
  problem named instead of breaking the proxy, and new debug headers `x-keyflip-model` /
  `x-keyflip-route` say what was sent and why. New: `keyflip proxy routes [init]` and
  `keyflip proxy explain [--model] [--tokens] [--path] [--user] [--run-hook]` (the decision for a
  hypothetical request, nothing sent); `proxy status`/`cooldown` show the routing policy. MCP:
  `keyflip_proxy_routes` and `keyflip_proxy_explain` (read-only; the explain tool never runs a
  custom hook).
- **The failover proxy now routes like a scheduler, not a first-failure switch.** Each account's
  failure is classified before anything moves: a 429 whose body says billing / credit / org-disabled
  is surfaced to the client instead of being masked by another account's quota; a rate-limit 429
  honors `Retry-After` (delta-seconds or HTTP-date) — if the wait fits `proxy.maxWaitSeconds`
  (default 10 s) the **same** account is retried once instead of spending another account's quota,
  otherwise traffic fails over immediately and the account is parked. Parking is per error kind
  (`proxy.cooldownQuotaSeconds` 300, `…ThrottledSeconds` 60, `…OverloadedSeconds` 30, `…AuthSeconds`
  900, `…ServerSeconds` 60, each `0` to disable) and lives in the existing `breakers.json` entry —
  no new state file. Ordering is deterministic: `proxy.priority` list first, then the active
  account, then least-recently-used (every real attempt records `lastUsedAt`); a cooling account is
  skipped, and when every account is parked the one that frees up first is offered with an explicit
  wait. Responses carry `x-keyflip-account`, `x-keyflip-attempts`, `x-keyflip-failover`,
  `x-keyflip-error-class` and `x-keyflip-cooldown` (`proxy.debugHeaders=false` turns them off).
  New: `keyflip cooldown` shows the live route order and each account's breaker/cooldown state,
  `keyflip cooldown clear <acct>|--all` releases them; `keyflip proxy status` prints the same
  readout. MCP: `keyflip_cooldowns` (read-only), `keyflip_cooldown_clear` (confirm-gated), and
  `keyflip_proxy_status` now includes the route. Seven new routing settings under `keyflip config`.
- **A provider preset catalog, so a third-party endpoint needs only a key.** `keyflip provider catalog`
  lists 19 built-in endpoints — Z.AI/GLM, Zhipu, Kimi, DeepSeek, MiniMax, Qwen/DashScope,
  Volcengine Ark, OpenRouter, OpenAI, Gemini, xAI, Mistral, Groq, Together, Fireworks, Anthropic
  and local Ollama / LM Studio / llama.cpp — each with the base URL from the vendor's own docs,
  model hints and a docs link. `keyflip provider add zai --key-file -` fills URL, auth scheme,
  models and compatibility from the preset (a bare `provider add` on a terminal opens a numbered,
  category-grouped picker; `--from <id>` saves a preset under your own name; `--base-url` still
  overrides). Each preset records `compat`: `anthropic` endpoints can be pointed at Claude Code
  directly, `openai` ones need an Anthropic-compatible gateway/shim — `provider use`/`provider list`
  now say so instead of silently breaking the CLI. `keyflip provider models <id|name>` asks the
  endpoint's `GET /v1/models` what it actually serves (8 s timeout, key never printed), because
  preset model names drift. Provider metadata is now `schemaVersion: 2` with a persisted `compat`.
  MCP: `keyflip_provider_catalog` (read-only), `keyflip_provider_models` (read-only network), and
  `keyflip_provider_add` accepts `catalog_id` (still confirm-gated; the key never crosses MCP).
- **One skill, every agent on the machine.** `keyflip skill add <src>` now installs into **every
  detected agent**, not just `~/.claude/skills`: `keyflip skill agents` lists the 72 HOME-level
  skill directories keyflip knows (with `●` for the tools actually present here), and
  `--agents claude,cursor` narrows it. Detection is by the tool's own home, so a tool you don't
  have is never given a directory, and a shared dir (`~/.agents/skills` serves Codex, Warp, Goose,
  Zed and more) is written once. New: `keyflip skill sync` re-applies each skill's recorded source
  (an archive with no re-fetchable origin says so), `keyflip skill list` shows `✓ ok / ✎ edited /
  ✗ missing` per target, and `keyflip install-skill` fans the bundled keyflip skill out to the
  other detected agents while Claude keeps its backup + drift check. A manifest
  (`~/.config/keyflip/installed-skills.json`) records a SHA-256 per target, so `sync` never
  overwrites a copy you edited and `remove` deletes nothing keyflip did not write; an existing
  skill keyflip did not install needs `--force`. Before any write the skill's text is scanned —
  **a skill carrying a credential is refused, not redacted**. `--link` symlinks, `--dry-run`
  reports the plan. The target table (and the shared-directory knowledge behind it) is adapted
  from RoleCraft's MIT agent registry — see CREDITS.md. MCP: `keyflip_skill_agents` (read-only),
  `keyflip_skill_sync` (confirm-gated), and `keyflip_skills` / `keyflip_skill_add` /
  `keyflip_skill_remove` now speak per-target state, target selection and `dry_run`.

### Fixed

- **`conv search --limit` is honored when the semantic side is missing.** Hybrid runs the lexical
  retriever wide (50 candidates) so rank fusion has room to work; with no vectors to fuse, that
  wide list was handed back as the page, so `--limit 3` printed 50 results. The fallback now cuts
  back to the page that was asked for (live: 3 results for `--limit 3`), and its `collapsed` count
  only names duplicates that were folded into the hits actually shown.

- **The conversation index can no longer claim chunks or vectors that are not on disk.**
  An index row copied from a colliding id, or whose chunk file was deleted, is now re-chunked
  instead of reused; a source with zero chunks on disk is never recorded as embedded (that used to
  leave a 0-byte vector file and a healthy-looking count); a torn chunk file is reconciled to what
  the disk actually holds before embedding, and `status` counts a vector only when its file is
  exactly `dim × count × 4` bytes. The build report gained a `rechunk` count, and `stats.chunks`
  now always equals the chunk lines on disk.

- **Codex Desktop rollouts no longer collapse into one index entry.** A continued rollout logs
  the parent thread as `session_id`, and Codex Desktop writes a *second* `session_meta` line that
  repeats the parent — the parser kept the last one, so a fork was filed under its parent's id.
  Two transcripts then shared one id: the second overwrote the first's chunk file while the
  manifest kept a single row, so the counts described a conversation that was not on disk. A
  rollout now keeps its own id (from its own `session_meta`, or from the file name for a fork
  whose name is `parent_own`); titles still resolve through the parent thread. Live: 4 colliding
  pairs became 4 extra conversations, and every index row now matches its own chunk file.

- **One id can no longer hold two conversations, and a row is only reused when its file is
  really there.** If two transcripts still resolve to the same id, the newcomer gets a stable,
  path-derived id and the build reports it (`duplicates` in the CLI and the MCP tool) instead of
  overwriting the first one. Every index row also stores the byte size of its chunk file, so a
  file that was replaced by a colliding source is re-chunked from its transcript rather than
  reused with a count that the disk does not back.

- **Hybrid search no longer ranks worse than plain BM25.** The rank fusion used RRF's classic
  k=60 — a constant meant for an ensemble of *many* result lists. With only two, it flattened the
  rank so hard that a document found deep in both lists outranked the top hit of either: a
  document at rank 20 in both beat a document at rank 1 in one. Measured over 1856 live
  conversations, hybrid search scored a hit@1 of 0.330 against BM25's 0.596, so the default mode
  of `conv search` was destroying the stronger retriever. The fusion now uses a small constant and
  weights the lexical list above the vector one, so a vector-only hit can never push a BM25 hit
  off the page. Hybrid now ties BM25 on hit@1/hit@5 (0.596/0.798 verbatim, 0.447/0.763
  paraphrased) instead of trailing it (0.330/0.587 and 0.395/0.684).

- **A deleted conversation now actually leaves the index.** The build treated an empty app list
  as a filter, so `keyflip conv index` (which passes `apps: []` when no `--app` is given) never
  took the "full discovery" path and kept the row, the chunk file and the vector of a
  transcript that was gone from disk. An empty app list is now no filter, so an unfiltered
  build drops what is no longer there; a filtered build (`--app`, `--limit-sources`) still
  leaves the rest alone.

### Changed

- **A chunk is now a question and the answer it got, and a duplicate paragraph fills one result
  slot.** The indexer packed messages into ~1,400-character windows and flushed as soon as the
  window filled, so a chunk could open with an `Assistant:` answer whose question sat in the
  previous chunk: 15,392 of 122,611 chunks (12.6%) on a live index were orphans like that, and a
  BM25 or vector match on one had no question terms to lean on. Chunking now works in turns — a
  user message plus everything said before the next question — and only breaks between turns; a
  turn too long to keep whole is split with overlap and every continuation keeps a short copy of
  its question. On the same index the orphaned-answer chunks fell to 15 of 117,033 (transcripts
  that genuinely start with an assistant turn). Forked and resumed sessions repeat earlier turns
  verbatim (19,389 duplicate chunk hashes on the live index), so `conv search` now shows that
  text once: the surviving hit lists the other conversations in `alsoIn`, `collapsed` counts the
  folded copies, and a page of 10 no longer spends 2.2 slots on the same paragraph. Measured on
  40 frozen paraphrase queries through the shipped search path, lexical quality held (hit@5
  0.625 → 0.60 and MRR 0.447 → 0.472 — one query either way at n=40; hit@1 0.30 → 0.35 when a
  hit naming the conversation in `alsoIn` counts, because 16 of the 40 targets are twins of
  another conversation). The manifest records a chunk scheme, so an existing index re-chunks
  itself on the next build instead of reusing windows cut the old way — and those new chunks need
  `keyflip conv index --embed` before semantic/hybrid search has vectors again.

- **Search over a 120k-chunk index is roughly 4× faster.** Lexical BM25 now reads a per-source
  token sidecar (`tokens/<key>.t32`: per-chunk `len` + `[token hash, tf]`, written with the chunks
  and derivable from them) instead of re-tokenizing ~150 MB of transcript text per query; snippets
  are built only for candidates that can reach the page, semantic search hydrates text only for its
  top hits, and hybrid runs lexical + semantic concurrently. Measured live (1850 conversations,
  121k chunks): lexical 4.2 s → 1.0 s, semantic minutes → 1.0 s, hybrid 4.2 s → 1.9 s. A missing or
  torn sidecar falls back to the text path, so an older index stays searchable and re-heals itself.

- **Incremental `keyflip conv index` passes no longer re-parse unchanged transcripts.** A source
  whose path, mtime and size match its manifest row reuses the row directly, so a no-op build is
  one `stat()` per source instead of re-reading every conversation (the previous code parsed all
  1850 of them, ~1 h, only to reuse the result). The post-parse mtime/hash checks remain for
  anything that did change. The manifest records which id scheme produced each row, so a change
  to how ids are derived re-parses the sources once instead of keeping ids that no longer belong
  to their transcript.

- **Semantic search is 2× faster and no longer allocates one object per chunk.** The vector scan
  read every float with `Buffer.readFloatLE` (~94 million calls on a 120k-chunk index), recomputed
  the query norm for every chunk, and then sorted all ~120k scored chunks to keep the best 200.
  It now reads the vector file through a `Float32Array` view, normalizes the query once per
  dimension, and keeps the best candidates in a bounded min-heap, so one query allocates a few
  hundred objects instead of 120k. The heap breaks ties by insertion order, which is the order a
  stable sort produced — two conversations with identical text still come back in index order,
  not in a random one. Both the lexical and the semantic path also stop hydrating once the page
  is full: reading a chunk file is a file read plus a JSON parse per line, and most of the top
  candidates belong to a conversation that is already on the page. Measured live (1856
  conversations, 122k chunks): semantic 610 ms → 304 ms per query. The ranking is unchanged —
  the hit lists of 147 live queries (109 verbatim, 38 paraphrased) are identical to before, and
  BM25 still scores hit@1 0.596 / hit@5 0.798.

### Added

- **Cursor is a first-class conversation source — one chat per composer, from three stores.**
  `keyflip conv` used to reach Cursor only through `keyflip foreign <file>`, where one
  `state.vscdb` became ONE giant conversation. `src/cursor.js` now reads the editor store chat by
  chat (`composerHeaders` on ≥3.12, `composerData:` KV rows before), treats
  `fullConversationHeadersOnly` as the render manifest (a bubble marked `isRenderable:false` is not
  in the transcript; a listed bubble whose text is gone is counted, not invented), keeps tool and
  thinking bubbles as tools (`toolFormerData` on new builds, `capabilities` on old) and derives the
  cwd from the project/workspace chain. It also reads the `cursor-agent` CLI store
  (`~/.cursor/chats/<md5>/<uuid>/store.db`, content-addressed `blobs` + a hex-JSON `meta` row) and
  its `agent-transcripts` mirror, recognising a session already read by its id so it is never
  indexed twice. Every store is opened through the zero-dependency `sqliteread.js` with the `-wal`
  overlay; a store past the read budget is a skipped source with a reason, and a store that yielded
  chats but whose `-wal` could not be replayed is a warning — separate fields in `conv index` and
  `keyflip_conv_index`, so an unreadable history never looks like an empty one. Cursor is not
  installed on the machine this was written on: 36 fixture tests pin the contract against the
  shipped format, not a captured live store.

- **`keyflip doctor` now inventories the background services, and tells installed apart from
  running.** keyflip can put four jobs on a timer — the nightly `dream`, the nightly token `refresh`,
  the expiry `daemon`, and the conversation index — and until now each one answered "is it
  scheduled?" from its own receipt. That question is not the useful one. A plist launchd stopped
  holding (a logout, a moved repo, an edited file) still reads as scheduled; a laptop asleep at
  04:30 never runs the nightly job and nothing notices; and every symptom arrives weeks later as a
  stale search answer or a dead token. `doctor` now asks three separate questions per job —
  **installed** (the file keyflip wrote is there), **loaded** (launchd or cron actually holds it) and
  **lastRun** (when its log last changed) — prints the whole inventory as one line
  (`2 of 4 scheduled — dream: off · refresh: nightly at 04:30 · spoke 9 h ago · daemon: off ·
  conv: every 30 min · spoke 13 min ago`), and warns when a job is installed but not held, or
  silent past twice the cadence it was
  installed with. A job younger than two cadences is not blamed for silence: its first tick is not
  due. A `KeepAlive` daemon has no cadence, so it is never aged against one — and it is labelled
  `always-on`, not `nightly`; the inventory's `mode` and `atLabel` are normalized views, so no
  report can print a receipt's `{h, m}` object where a time should be. A warning still names every
  job after the complaint, because "which ones do I have at all?" is the question being asked.
  An index older than a day
  with nothing refreshing it is called out on its own. `keyflip_doctor` returns the same inventory as
  structured `services` rows so an agent can check a service instead of trusting a receipt, and each
  job's own status view (`conv index --schedule-status`, `refresh --schedule-status`, `dream status`,
  `refresh --daemon-status`) now shows the same facts.
  Live on this machine: the conversation index job was installed
  (`keyflip conv index --schedule`, every 30 min) and verified end to end — launchd holds it, its
  first real pass parsed 19 conversations, reused 1837, re-embedded 19, dropped 11 that left disk and
  wrote its log in 103 s. `src/schedule.js` gained `launchdLoaded`, `lastRunAt`, `cadenceMsOf`,
  `modeOf`, `hhmm` and `inventory()`; `status()` gained `loaded` (with `askSystem: false` leaving it
  null = "not asked", so
  a hermetic test never claims an answer it did not get) and `lastRun`. Asking the system is opt-in per
  caller — `keyflip doctor` and the MCP server pass a runner, the test suite does not, and no suite
  spawns `crontab`/`launchctl`.
  Tests: 5 new in `test/schedule.test.js` (installed ≠ loaded ≠ not-asked, a log is the only evidence a
  job spoke, the inventory covers every job with what it does and how to install it, the two cadence
  normalizations, an interval job is
  aged against the interval it was installed with) and 9 in `test/doctor.test.js` — including one that
  pins the ISO-string clock, because subtracting a parsed date from `ctx.now()` is NaN and "spoke NaN d
  ago" still prints green.

- **Every conversation now says which account worked on it — and how that is known.** The
  conversation layer knew the app, the surface and the timestamps, but on a machine with two
  accounts per surface the first question was unanswered: "which of my accounts wrote this?"
  `keyflip conv list` prints the account (`[yahoo]`), `--account <name>` narrows `conv list` and
  `conv search` to one account's chats, and `keyflip conv show <id>` states it with its reason.
  The answer comes from two sources in strict order: what the USER said
  (`keyflip sessions assign <session> <account>`) always wins, and only where nothing was stated
  does keyflip infer it from its own action log — `active -> <profile>` for Claude Code, and the
  newly logged `kiro -> <slug>` / `codex -> <slug>` boundaries for those surfaces. Each surface
  keeps its OWN timeline, so a Kiro switch can never relabel a Claude session. The label always
  travels with the answer (`accountSource` stated|inferred, `accountConfidence`
  high|medium|low|none) — in the CLI, in the index manifest, and in the MCP payloads, where a
  bare `account` with no source would let an agent act on a guess as if it were the user's word.
  A conversation older than every logged switch, an account you deleted, or a tool keyflip holds
  no accounts for (Qoder, Gemini) gets NO account rather than a plausible one, and a rebuild never
  relabels an inference as a stated fact. Live: 88 of 120 Claude Code conversations attributed
  (57 stated by hand + 31 inferred — 30 high, 1 low; `hakkisagdic` 65, `yahoo` 23); Kiro/Codex
  fill in from the next real switch, since no such boundary is in the log yet. A one-message
  chat — whose life is a single instant — now resolves to the account live at that instant instead
  of reporting no evidence.

- **`keyflip conv index --schedule` — the conversation index keeps itself current.** Until now the
  index only moved when someone ran `conv index`, kept a `--watch` loop alive in a terminal, or an
  agent called `keyflip_conv_index` — so "search my chats" quietly answered from yesterday. It is
  now a scheduled job like the nightly token refresh: a launchd agent on macOS, a crontab line on
  Linux. It runs on an **interval** (default every 30 minutes), not at a wall-clock hour, because a
  daily index would be a day behind. The pass is incremental — an unchanged transcript costs one
  `stat()`, and only new or changed chunks are embedded — so a tick costs seconds. It runs the
  **local** embedding model: no cloud model, no quota. `--schedule-status` shows the state,
  `--unschedule` removes it, and `--watch` stays as the foreground equivalent. MCP adds the
  confirm-gated `keyflip_conv_index_schedule` (`action:"status"|"install"|"remove"`, `interval` in
  minutes); the cadence is restricted to values that mean the same thing in launchd and cron.

- **`keyflip chatgpt backups` — undo a bad ChatGPT/Codex switch.** Every switch and token refresh
  already copied the live `~/.codex/auth.json` to `<configDir>/backups/`; now they are listable by
  account e-mail/plan/expiry (never a token) and restorable by number, file name or unique prefix.
  A restore backs up the login it replaces first, so it is itself reversible, refuses while
  ChatGPT/Codex runs unless `--force`, and reads the file back byte-for-byte. `--dry-run` plans;
  MCP adds read-only `keyflip_chatgpt_backups` and confirm-gated `keyflip_chatgpt_restore`.

- **Embedding passes survive a flaky local endpoint.** Each batch is retried up to three times
  with backoff before its source is given up, and a failing source is skipped instead of aborting
  the run — only three consecutive source failures (the endpoint is actually down) stop it. The
  report counts `embedding.errors` and stays `ok:false`, so an incomplete pass is never reported
  as complete, while the chunks remain searchable lexically.

- **`keyflip doctor` now reports expired ChatGPT/Codex captures, and so does the refresh daemon.**
  A stored login whose access token has expired AND has nothing left to rotate (no refresh token,
  or apikey mode) will not work at switch time — `doctor`'s **chatgpt/codex captures** check fails
  with the exact slugs, expiry times and the one human fix (`keyflip chatgpt capture <slug>` after
  signing in once). Captures that are merely due for refresh stay a warning: the daemon rotates
  those on its own while ChatGPT/Codex is not running. The daemon's tick logs the dead-capture set
  once per SET (a small marker file in the state dir), not once per tick, and clears the note when
  the set empties.

- **`keyflip consolidate --dry-run` + read-only `keyflip_consolidate_plan` (MCP).** The chat-index
  merge now computes its plan without writing: how many session pointers each account folder (base
  app + non-running instance clones) would gain, the first 50 destinations as store-relative paths,
  and which running clones would be skipped. A dry run only READS the stores, so it works while the
  desktop app is open — plan first, then close Claude for the actual merge. `--json` carries
  `wouldMerge`/`wouldCode`/`wouldCowork` + the plan; the MCP side keeps the repo's invariant that
  every mutating tool requires `confirm` by exposing planning as a separate read-only tool.

- **`keyflip conv index --watch` keeps the index current.** An incremental pass every N minutes
  (default 30, `--interval N`): new transcripts indexed, gone ones dropped, and with `--embed` only
  conversations that actually changed get their new chunks embedded — idle ticks cost one manifest
  read, not an embedding pass. The embed-less report also stopped claiming "no vectors" when an
  earlier `--embed` pass left them: it now states the real coverage left by the last pass.

- **`keyflip conv` — every local AI tool's chats in one searchable shape.** A canonical conversation
  layer reads Claude Code, Codex/ChatGPT rollouts (`.jsonl` and `.zst`), Kiro (CLI + IDE) and the
  foreign adapters (Qoder, Cursor, opencode, Gemini/Antigravity, Copilot, Aider) into one form
  (`id/app/surface/title/cwd` + `{role,text,ts,tools}` messages), stripping host harness noise
  (`<system-reminder>`, `<task-notification>`, command plumbing, malformed `<pasted_content>` tags).
  Sources are strictly read-only. `list` browses (id prefix/app/age/count/title, filters `--app`,
  `--since`, `--cwd`); `index` builds an incremental chunk index keyflip owns in the secret-dir
  `~/.config/keyflip/conv-index` (0600, never versioned/backed up; mtime+size+hash reuse, prefix
  vector reuse for appended chats, filtered builds keep the rest, full builds drop gone sources);
  `search` ranks with BM25, or embeddings (local Ollama `nomic-embed-text` by default, or
  `KEYFLIP_EMBED_URL` with remote text secret-redacted first) or reciprocal-rank-fusion hybrid — and
  labels the result honestly (`lexical` + note when no vectors exist, instead of a silent "hybrid";
  no query-vector round-trip is spent when nothing is embedded); `context` returns a char-budgeted
  RAG block with cited sources and neighbouring chunks (`--expand`, `--budget`); `show` reads one
  conversation; `export` writes MD/self-contained HTML/canonical JSON, or an **Obsidian vault**
  (`keyflip/Conversations` + index note + hidden hash manifest: keyflip's own notes update in place,
  a user edit becomes a `… (conflict <ts>).md` copy, a renamed note is removed only while still
  byte-identical, ownership never points at a conflict copy); `transfer` writes a 0600 handoff bundle
  (`conversation.json` + per-target `CONTINUE.md` + README) for claude/codex/kiro/cursor/opencode/windsurf/gemini/copilot/aider/generic and states plainly that no target has a documented import. Exports mask credential-shaped
  lines by default (`--no-redact` for fidelity), refuse overwrite without `--force`, and writes are
  0600. `search`/`context` auto-build the index once on first use.

- **MCP: conversation tools.** Read-only `keyflip_conv_list`, `keyflip_conv_show`, `keyflip_conv_search`,
  `keyflip_conv_context` and `keyflip_conv_status` never build the index and mask snippets/context for
  credential shapes before anything reaches an agent transcript; `keyflip_conv_index` and
  `keyflip_conv_export` (single file, bulk with `limit`/`offset`, Obsidian, or a `target` bundle) are
  confirm-gated. The index path is reported relative to the state dir, never as a home path.

- **`recall`'s BM25 now lives in one shared module** (`src/bm25.js`) used by both the keepsake search
  and the conversation index, so stemming and scoring behave identically everywhere.

- **`keyflip chatgpt` (alias `codex`) — save, switch and refresh the ChatGPT.app + Codex CLI login.**
  Both surfaces authenticate with the same `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`, 0600), so
  one adapter covers them. `status` reports the live e-mail/plan/expiry without printing a token;
  `capture` saves the live bytes plus a secret-free `meta.json` under
  `~/.config/keyflip/surfaces/codex/<slug>/`; `switch` backs up the live file, captures the outgoing
  login, writes the stored bytes and reads them back (raw content + e-mail identity), refusing while
  ChatGPT/Codex runs unless `--force`; `refresh` rotates one-shot; `list`/`remove` round it out.
  Captures without `meta.json` (from the earlier account work) still resolve from their stored JWT.
  MCP: `keyflip_chatgpt` (read-only status), `keyflip_chatgpt_capture`, `keyflip_chatgpt_switch`,
  `keyflip_chatgpt_refresh` (all confirm-gated; never return a credential).

- **The refresh daemon now rotates the live ChatGPT/Codex login.** Within 24 hours of access-token
  expiry it refreshes `auth.json` against `https://auth.openai.com/oauth/token` — never while
  ChatGPT/Codex is running. Rotation is lineage-safe: a saved capture holding the exact refresh token
  that was just spent is updated too, while dormant captures are never refreshed independently, so one
  account cannot end up with two competing refresh tokens. A failed refresh leaves the file untouched
  and reports the provider error.

### Changed

- **`keyflip consolidate` now unions the base Claude Desktop store with every instance clone.**
  Recents (`claude-code-sessions`) and Cowork (`local-agent-mode-sessions`) pointers are merged across
  `~/.keyflip-instances/<tool>/<slug>/User Data/` as well as the base app, so a chat opened in one
  clone appears in all of them. A clone whose `instance.pid` is alive is skipped and reported;
  `--no-instances` limits a pass to the base app. Each store is backed up separately (clone backups are
  named per tool/slug) and the merge still only adds files.

- **The old ChatGPT cookie refresh strategy was removed; it could never have worked.** ChatGPT's
  on-disk cookie jar holds only Cloudflare/analytics entries, not a credential. The strategy now reads
  the real shared `auth.json`, and refresh metrics live under the active config dir instead of a
  hard-coded home path.

### Fixed

- **Consolidation no longer drops a session when two accounts use the same `local_*.json` filename.**
  The app names index files by its own local id, and two account folders can legitimately use the same
  name for different transcripts; the old `existsSync` check skipped one of them. keyflip now falls
  back to `local_<cliSessionId>.json` (with a numeric suffix on a true collision) and still respects a
  `deleted_<id>` tombstone.

- **The stale “repair with `codesign --force --deep --sign -`” troubleshooting line is gone.** Current
  keyflip re-signs the outer bundle ad-hoc after patching `Info.plist` and restores the original plist
  if signing fails; the README (EN/TR) now says to re-run `keyflip instance harden` or recreate the
  clone, and warns that `--deep` rewrites Apple's nested helpers.

## [1.5.7] - 2026-10-23

### Added

- **Generic multi-instance management (`keyflip instance`).** Create isolated app clones for AI tools using APFS copy-on-write for near-zero disk overhead. Each instance runs independently with its own user data directory, solving the ~30-day cookie expiry problem. Commands: `list`, `create`, `launch`, `focus`, `kill`, `harden`, `enable-all`. Adapters ship for `claude`, `kiro`, `chatgpt` (verified against the real app bundles on macOS) and `cursor` (standard path; app not present on the verification machine). macOS-only due to APFS requirement. MCP endpoints: `keyflip_instances`, `keyflip_instance_create`, `keyflip_instance_launch`, `keyflip_instance_focus`, `keyflip_instance_kill`, `keyflip_instance_harden`. Backward compatible with old `keyflip claude-profiles` commands via compatibility wrapper.

- **Auto-update state is controllable, recorded and checked.** Claude ships Squirrel, so the old Info.plist hardening never affected it; `instance create` now writes Claude's own `"disableAutoUpdates": true` into the clone's `User Data/config.json` before first launch (mirroring the app's `autoUpdate.disabled ?? disableAutoUpdates` precedence) and records the live state read back after the write, not adapter intent. ChatGPT keeps its best-effort Sparkle hardening; Kiro/Cursor expose no switch. New `keyflip instance harden [tool] [account]` re-applies the switch to existing clones (MCP: `keyflip_instance_harden`, confirm-gated). `keyflip doctor` gained a `desktop auto-updates` row that reads the base app and every instance live: a controllable clone still ON is a warning with the harden fix, while a base app that updates itself or a tool with no switch is reported without nagging.

- **Background token refresh daemon (`keyflip refresh --daemon-start`).** Runs continuously as a
  launchd KeepAlive agent (macOS) or @reboot crontab entry (Linux), checking credential expiry every
  5 minutes. Proactively refreshes Antigravity (Google OAuth) and ChatGPT (session token → bearer
  conversion) before they expire. Kiro uses reactive-only hash comparison to detect IDE/CLI rotation
  — proactive refresh is forbidden due to single-use refresh_token race conditions. Claude Desktop
  session extraction from encrypted cookie database using AES-128-CBC decryption (Keychain "Claude
  Safe Storage" key, PBKDF2-HMAC-SHA1 derivation). Manage with `--daemon-start`, `--daemon-stop`,
  `--daemon-status`. Logs to `~/Library/Logs/refresh-keyflip.log` (macOS). Complements the existing
  nightly `--schedule` timer that runs `refresh --all` once per day.

- **Error handling with retry logic and metrics tracking.** Failed refreshes use exponential backoff
  (1min → 5min → 15min, max 3 retries). Persistent metrics file at
  `~/.config/keyflip/refresh-metrics.json` tracks checks, refreshes, failures per account. View with
  `keyflip refresh --metrics`. Daemon continues operating even when individual tool refreshes fail.

- **Kiro reactive hash change detection.** When Kiro CLI or IDE rotates the refresh token, daemon
  detects the SHA256 hash change and logs a warning with old/new hash prefixes. No action required —
  this is expected behavior during normal Kiro re-authentication. Hash history stored in
  `~/.config/keyflip/surfaces/kiro/<account>/refresh_token_hash.json`.

- **Claude Desktop session extraction.** Extracts `sessionKey` cookie from Claude's encrypted SQLite
  database (`~/Library/Application Support/Claude/Cookies`) using Keychain-stored AES key. Decryption
  uses PBKDF2-HMAC-SHA1 (saltysalt, 1003 iterations) + AES-128-CBC (IV: 16 spaces). Session has ~30
  day lifetime; daemon monitors for changes but cannot proactively refresh (requires human
  re-login). Extracted sessions tracked via hash comparison similar to Kiro.

- **`keyflip antigravity` — save, switch and inspect Antigravity (formerly Gemini CLI) accounts.**
  Antigravity stores its OAuth token in the macOS Keychain under service "gemini", account
  "antigravity". The adapter captures the current login into a slug directory (`token.json` secret +
  `meta.json` public), switches by writing the stored token back to the keychain, and lists all saved
  accounts. Supports `status`, `list`, `capture`, `switch`, `remove` subcommands with `--dry-run`
  and `--force` flags. macOS-only for now.

- **`migrate push`/`pull` now stream large bundles over WebDAV, removing the 256 MB in-memory cap.**
  Small bundles (≤256 MB) still use the legacy in-memory path for cross-version compatibility with
  older clients. Large bundles build to a temp file, encrypt, and stream-upload via `davPutFile`,
  while `pullBundle` downloads to a temp file and decrypts in-place. The CLI cleans up temp files
  after apply, even on failure. This enables migrating multi-gigabyte transcript sets through cloud
  storage without hitting V8's string limit or OOM.

- **`migrate export`/`import` stream the transcript tier, ending the large-history OOM (issue #1).**
  The bundle used to embed every transcript in ONE JSON string: around 830 MB `JSON.stringify`
  exhausted the heap, and encrypting it then base64-encoded the whole ciphertext into a second giant
  string past V8's max-string limit. Bundles are now a record stream (`KEYFLIP-MIGRATE-STREAM/2`,
  one JSON line per record): the small metadata tier first, then each transcript copied in 128 KiB
  chunks, so memory stays flat — measured 308 MB export / 316 MB import peak RSS on an encrypted
  2 GB, 4-session set (the bundle itself was 3.6 GB). With `--passphrase-file` every record is
  sealed on its own with AES-256-GCM under one scrypt-derived key and bound to the previous tag +
  sequence in the AAD, so tampering, reordering, truncation and trailing data all fail; a missing
  `end` record is an error. Import stays a union (`--force` overwrites) and renames each session
  only after its declared byte count agrees. Small legacy bundles (plain or `keyflip-sync`) still
  import; a legacy file above 256 MB is refused with a pointer to re-export on the source machine.
  `migrate push`/`pull` still build one in-memory payload, so `push` refuses a transcript set above
  256 MB and points at the streaming file export, and `pull` refuses a remote bundle whose
  `content-length` exceeds the same cap.

- **`keyflip kiro` — save, switch and inspect Kiro accounts across its CLI and IDE (macOS).** Kiro
  keeps two independent login stores: the CLI's Keychain items (`kirocli:odic:token`,
  `kirocli:odic:device-registration`) and the IDE's `~/.aws/sso/cache/kiro-auth-token.json` plus its
  registration file. `capture` saves both (or `--cli-only` / `--ide-only`), `switch` writes both and
  reads every byte back, rolling the touched surfaces back if the identity check fails, `usage` reads
  the agent's own usage log (plan, limit, overage, reset date), `import` migrates the legacy
  `keyflip:surface:kiro:*` Keychain captures, and `status`/`list`/`remove` round it out. Saved bundles
  live under `~/.config/keyflip/surfaces/kiro/<account>/` at mode 0600 with a secret-free `meta.json`
  (expiries, sizes, registration state and the account label — never a token or credential
  fingerprint). A Kiro switch refuses
  while Kiro or the CLI is running unless `--force`; `--dry-run` performs no reads that could refresh
  a token. The Keychain is written through a small compiled helper that takes the secret on stdin
  (`SecItemUpdate`, so the item's ACL is preserved) — never in argv and never through a file; the
  helper retries with an older installed SDK when the default one cannot link. Note: the CLI and IDE
  share one refresh chain per account, so switching the CLI can rotate the IDE's token too; a
  post-switch capture records that.

- **Per-profile Chromium support — each account can keep its own browser profile.** One Chromium
  profile holds exactly one claude.ai account, so two live accounts needed two profiles, which
  keyflip could not see. `browser.catalog()` now expands each browser into one entry per profile
  from `Local State` (`Default` keeps the bare id `chrome`, so every existing capture still
  resolves; others become `chrome-Profile-2`), the switch leg restores each profile from its own
  snapshot, and several profiles of one browser quit and reopen that browser only once. Capture age
  and days-left per surface already came from `keyflip freshness`.

- **`keyflip_fleet_push` — an agent can check in with the fleet over MCP.** One confirm-gated tool
  publishes this machine's encrypted status and processes the inbox, with two independent consent
  flags: `with_secrets` decides whether credentials are published, and `apply` decides whether queued
  switch / save-account commands are honoured (`false` reports them as skipped, which stays the safe
  default). The inbox gate now lives in one shared `fleet.processInbox` used by both the CLI and MCP,
  so the two paths cannot drift; the MCP result carries counts and per-command outcomes, never
  credentials.

### Changed

- **Chat consolidation is explicitly Claude-Desktop-only.** Kiro stores chat state in one IDE
  profile keyed by workspace (`workspaceStorage/<hash>/state.vscdb` and
  `globalStorage/kiro.kiroagent/artifacts/sess_*`), not by account, so switching credentials leaves
  the local history in place. ChatGPT keeps conversations server-side per account (like claude.ai
  Chat) and shares one local data root, so there is no per-account index to merge. The README,
  Turkish README and agent skill now say this instead of leaving “Kiro/ChatGPT consolidation” as an
  open gap; only Claude Desktop writes the per-account Recents folders that `consolidate` joins.

### Fixed

- **`keyflip instance launch` now actually starts the app.** The launch passed `{ env }` in
  `exec.run`'s stdin slot instead of its options slot, so every tool failed with
  “options.stdio[0] must be a string or Buffer” before `open` was even called. Found by the first
  live GUI launch test.

- **Kiro clones launch: instance storage moved to a short path.** Kiro's main process creates a
  Unix-domain socket at `<user-data-dir>/1.3.-main.sock`, and macOS caps `sun_path` at 103
  characters. Under `~/Library/Application Support/keyflip-instances` every Kiro clone died with
  `listen EINVAL`, even with a short account slug. Instances now live in
  `~/.keyflip-instances/` (with an automatic same-volume move of the old tree on first use), which
  leaves room for normal account names. Verified by creating and launching real Kiro and ChatGPT
  clones, checking the `--user-data-dir` in `ps`, and killing them again.

- **ChatGPT clones stay launchable after Sparkle hardening.** The Sparkle keys live in
  `Info.plist`, which is sealed by the code signature; patching it produced a clone that
  LaunchServices refused to start (`launchd job spawn failed`). `create`/`harden` now re-sign the
  outer bundle ad-hoc with a minimal entitlement set (nested Apple-signed helpers untouched); if
  signing fails, the original plist is restored so the clone still starts, and the live update
  state is reported honestly.

- **`instance kill` no longer leaves helper processes behind.** Killing only the PID that `open`
  started left ChatGPT's crashpad handlers and its global `bare-modifier-monitor` running. The
  kill now terminates every process whose command line points into that instance directory, then
  SIGKILLs anything left after a two-second grace period.

- **The fleet no longer reports a machine as its own untrusted peer.** `fleet push` compared every
  published status against the pinned keys without skipping the local machine, so each push warned
  "new machine `<self>` is publishing but NOT trusted" and `keys` counted a phantom pending
  entry. `reconcileKeys` now skips the local `machineId`; a Docker simulation asserts a machine never
  flags itself.

- **Windows CI is green again.** The suite had been failing on `windows-latest` since before 1.5.4
  (19 tests, node 20 and 22 alike), so a red CI built nothing. The failures were two kinds: tests
  that assert real POSIX mode bits (`chmod 600`, world-readable detection) now skip on Windows —
  NTFS cannot express them — while genuine portability bugs were fixed in the code: the loose-mode
  risk scan keys on the real OS as well as `ctx.platform` (a 666-on-NTFS secret is not an exposure),
  `secrets tolerate` accepts a pasted `C:/…` path, agent-facing thread paths stay POSIX-separated,
  `llm` finds the `claude.cmd` shim, and the CLI-spawning tests pin `KEYFLIP_CONFIG_DIR` instead of
  assuming `~/.config/keyflip`.

### Tooling

- **Live fleet discovery tests (`test/fleet-discovery.test.js`).** Two real `keyflip --json fleet
  discover` processes start at once with separate HOMEs and find each other over actual multicast
  (each excludes its own machine id), and `--no-announce` is proven silent while still hearing an
  announcer. The Tailscale fallback runs the production code path with a fake `tailscale`
  executable on PATH (including failure and malformed JSON), because Tailscale is not installed
  on the test host. The fallback mapping moved into pure `lanfleet.peersFromTailscale`, which now
  drops offline/addressless peers and deduplicates hostnames that sanitise to one machine id.

- **Docker fleet simulation (`test/fleet-docker/`).** Three keyflip machines in containers share one
  rendezvous volume and exercise the real CLI end to end: encrypted status at rest (no plaintext
  account data, mode 0600, wrong passphrase sees nothing), invite/join plus explicit trust pinning,
  the keys audit, consent-gated switch apply and replay protection, and rejection of both an unpinned
  sender and a peer whose key changed. `./run-simulation.sh` runs 10 checks and exits non-zero on
  failure; `--keep` preserves the containers for inspection. Scope limits are documented: LAN
  multicast discovery and token-bearing `send-account` are not simulated.

## [1.5.6] - 2026-10-19

### Added

- **`keyflip login <account> --long-lived` — a ONE-YEAR CLI token per account.** Mints it with the
  same official OAuth flow `claude setup-token` uses (one browser Authorize click), stores it in the
  credential store as `longlived__<account>` and NEVER prints it. A switch hands the CLI the normal
  login while it is alive or refreshable, and the one-year token when that login is dead for good —
  the failure mode where `keyflip verify` said "needs a real login" and nothing else could help.
  `verify`, `refresh --all` and `doctor` now report it; removing an account removes its token too.
  Trade-off, printed at mint time: the token is INFERENCE-ONLY — chat, code and tools work; Remote
  Control and Claude in Chrome still need a full `keyflip login`. Verified live: Claude Code accepts
  the inference-only credential from the Keychain item.
- **`keyflip mcp --register` — self-registration with absolute paths.** A bare `keyflip` command in
  an MCP server entry only works for launchers whose `$PATH` includes it; GUI apps (Claude
  Desktop/Code) inherit launchd's minimal PATH, and an fnm node switch silently drops global bins —
  both produced "Executable not found in $PATH". `--register` writes the running node binary +
  script paths into Claude Code and the desktop config; `--setup` now prints the same absolute
  entry.

### Changed

- **`keyflip <account>` now moves EVERY surface by default — CLI, desktop app AND the browser's
  claude.ai session** (and with it the Claude Chrome extension), from saved snapshots. Switching
  used to leave the browser on the old account unless you remembered `--browser`. A surface that
  cannot move is skipped and named (`⏭ browser Chrome NOT switched: …`) while the others still
  switch. An open browser that would not restore its tabs after a quit is left alone rather than
  closed behind your back; `--browser` (or `--only browser`) is the consent to close it. Before a
  browser is restored, the session it is LEAVING is re-snapshotted under its own account, so the
  outgoing account's capture stays fresh. `--dry-run` and the MCP `keyflip_switch_plan` show the
  per-browser decision.

### Added

- **`keyflip freshness` (alias `age`) — how old every saved login is, before it bites.** Each
  account gets three rows: the CLI token (renewable — `keyflip refresh` / `--schedule` already
  keep it alive), the desktop app's saved claude.ai sign-in, and each browser's saved sign-in.
  A claude.ai `sessionKey` lasts a fixed 28 days from the moment a human signed in and **cannot be
  renewed by any program**, so these rows report the sign-in age and days left (read from the
  cookie jar's creation/expiry timestamps — never a cookie value). The server can also refuse an
  older sign-in early with "Sign in again" (`session_stale_relogin` in Claude's `main.log`):
  keyflip now detects that refusal after a switch and during the nightly refresh, records the
  refused age under `freshness/` in the state dir, and from then on warns ahead of the youngest
  age that was ever refused — the threshold is learned, not guessed. The same age shows up as a
  `keyflip doctor` row ("claude.ai sign-in age") and as a switch-plan warning when the target's
  saved app sign-in is aging; a switch that lands on the refusal says so and names the fix
  (sign in once, then `keyflip add <account> --app`).
- **`keyflip <account> --only cli|app|browser`** (comma-separated) switches just those surfaces:
  `--only cli` swaps the credential in place without closing Claude, `--only app` moves only the
  desktop login, `--only browser` only the claude.ai session.
- **`keyflip fleet invite` / `fleet join <host-id> --code <code>` — pair a new machine with a
  one-time code, no silent trust.** Adding a machine is now a deliberate, two-sided act: `invite`
  mints a short one-time code (shown once, ~15 min) and drops an invite file encrypted **with that
  code** (never cleartext); `join --code` opens it, pins the inviter's real key, and writes a
  code-encrypted join back; the inviter's next `fleet push --accept-join <host-id> --code-file <f>`
  pins the joiner. Both ends only ever pin a key that was proven by the code — a leaked passphrase
  alone cannot add a machine.
- **`keyflip fleet discover` now announces this machine while it listens** (ON by default;
  `keyflip fleet announce on|off` to change, `--no-announce` for one run), so two machines
  discovering at the same time see each other.

### Security

- **Fleet no longer trusts a machine on first sight.** `reconcileKeys` used to pin any peer that
  published a status and had a valid key — classic TOFU — which meant anyone holding the passphrase
  and write access to the rendezvous folder could add a machine, have it auto-trusted, and have its
  commands accepted. Now a new peer is merely **reported** (`pending` on push, `unpinned` in
  `fleet keys`) and its commands are **rejected**: pinning happens only through the invite/join
  pairing above or an explicit `keyflip fleet trust` after an out-of-band fingerprint check. A pinned
  key that CHANGES is still a conflict (possible substitution), never silently overwritten.

- **`keyflip api` — the monthly Claude API credit a Max/Team plan grants its linked Console org.**
  Since 7 Oct 2026 Max 5x carries $100 and Max 20x $200 a month of Claude Platform credit
  (Team per seat, capped at $500), granted to the one Console organization the claude.ai
  account links in Settings → Billing → API credits. `api add <account>` saves the org's
  **Admin** API key (`sk-ant-admin01-…`) to the OS credential store (`keyflip:admin-key` /
  `api:<account>` — never the metadata file, never argv, and it goes to exactly one host,
  `api.anthropic.com`) with the plan, the cycle anchor day and an optional grant override in
  the commit-safe `api-accounts.json`. `api status` reads the Admin **cost report** over the
  current cycle and prints grant − spent per org, labelled as the estimate it is: the true
  balance lives in the Console and no API reads it (`/v1/organizations/balance` 404s), so an
  admin key reads what it can — the money spent — and the plan's grant fills the rest. `api
  orgs` lists the orgs a key can see (the linked one is yours to pick), `api test` fires the
  read once, `api remove` drops key and metadata together. A Team org must be told its grant
  once (`--grant`, it is per seat); `--cycle-day` is the day the credit lands each month
  (default `1`). Individual Console orgs have no Admin API to talk to ("The Admin API is
  unavailable for individual accounts"), so `api add` also works **without a key**: such an
  account runs in manual mode and `api set <account> --balance <usd>` records the balance
  the Console Credits page shows — one capped entry per reading in `api-accounts.json`,
  never a secret — while `status` prints the last balance with its trend, no network needed,
  and re-adding the account keeps the readings. Like `provusage`, the reader is
  zero-dependency and fail-closed: no fetch is injected, no request leaves, and the key never
  appears in a result, an error, or a log.

## [1.5.5] - 2026-10-17

### Added

- **`keyflip fleet discover` — find your other keyflip machines on the LAN, no shared folder.**
  Fleet's transport is a synced rendezvous folder, which needs a path set up on every machine and a
  sync round-trip before peers appear; on one network that is friction for nothing. `discover` sends
  and listens for a zero-dependency UDP multicast beacon (the same group as `transfer`, its own tag
  so the two never confuse each other) and lists who answered. The beacon carries **public identity
  only** — machine id, display name, and the short SHA-256 fingerprint of the Ed25519 signing key —
  never the fleet passphrase, a private key, or a command, so the output is safe to print and gives
  nothing away. A discovered peer is only *reachable*: acting on one still needs the passphrase, and
  a key is still pinned by TOFU (`fleet keys` / `fleet trust`) after an out-of-band fingerprint
  comparison. A network that blocks multicast degrades to "found nobody" and the shared folder stays
  the fallback. Exposed to agents as `keyflip_fleet_discover`. A hostile datagram can never inject an
  id that reaches a bus filename (the id charset is the same one the filenames enforce), and nothing
  is written on a discovery.
- **`keyflip add --dry-run`** — `add` writes to the git-versioned state repo and to a credential
  store, so it now gets the same "plan first, then write" contract a switch already had: the dry run
  reports what it WOULD capture (which account, whether the profile is new or refreshed, and whether
  the app's cookie jar actually holds a usable session) and stops before the first write — including
  the audit-log line. A dry run whose app jar has no `sessionKey` yet says so, because that capture
  would be incomplete and a switch to it would land on the sign-in screen.

### Fixed

- **`doctor` now explains the post-update sign-out instead of implying a broken capture.** When the
  Claude desktop app updates itself (Squirrel/ShipIt swaps the bundle and relaunches it), Chromium may
  not have flushed the `claude.ai` session cookie back to disk on that relaunch, so the LIVE jar reads
  as signed-out while keyflip's saved capture is intact — exactly how a working setup starts "not
  letting me log in any more" with no code change on our side. The check dates the installed bundle
  and, when it was written in the last few days, reports "the app was UPDATED <date> (vX) and its jar
  holds no session cookie yet" with the fix "sign in once, then `keyflip add`". Provenance, not a
  guess: the version and mtime come from `Info.plist` and the app binary, and a stale bundle never
  claims a recent update.

## [1.5.4] - 2026-10-16

### Added

- **`keyflip sessions attribute [--apply] [--min-confidence high|medium]`** — threads only see work
  that is split across accounts once sessions are attributed to one, so an unassigned history makes
  `threads suggest` return nothing and the `[t]` menu screen look empty. Asking the user to run
  `sessions assign` for every session is the tedious half of the feature. This reconstructs keyflip's
  own switch timeline from its action log (secret-free: account names + timestamps, no transcript is
  read) and proposes the account each unassigned session was worked on, with the evidence: `high`
  when the session's whole logged span sits inside one account's window, `medium` when the span is
  thin (no start timestamp, or it opens before the logged history) but all visible time is one
  account, `low` — and flagged as *spanning* — when it crosses a switch, in which case the account
  holding the most logged time is chosen and said so. Nothing is written without `--apply`; an
  account that is no longer a saved profile is reported, never proposed; sessions the user already
  assigned are counted, never proposed over.
  **Provenance is recorded, not assumed:** every applied inference goes to
  `<configDir>/session-accounts-source.json` (a reserved state file, 0600, names + timestamps only)
  so the threads screen prints `yahoo (inferred)` instead of presenting a guess as a fact, and
  `keyflip sessions assign` overwrites a guess with the user's word. A switch now also records one
  canonical `active -> <name>` line from `core.performSwitch`, so every path — CLI, menu, TUI, MCP,
  fleet, autoswitch — lands on the timeline that this reads. Exposed to agents as
  `keyflip_sessions_attribute`. To see which account a session is really tied to, run
  `keyflip doctor` or `keyflip list`: no credential value is ever echoed.

## [1.5.3] - 2026-10-16

### Added

- **`keyflip verify [account] [--usage] [--live]`** — answers "would switching there actually work",
  which no earlier command did. Every failure of a switch is a *silent* one: a stored access token
  expired 115 days ago, a desktop-app cookie capture whose `sessionKey` expired last month, a
  capture written in a shape the tool refuses to parse. Those all follow successful writes, so exit
  codes cannot catch them — `src/verify.js` re-reads each surface the way its own application does
  (stored vs **live** credential, the app token cache, the cookie DB's session cookie *and its
  expiry*, browser capture age) and rolls the account up to ok / warn / fail / none. It reports
  presence, expiry and age only — never a token or cookie value, and a test asserts that.
- **`keyflip refresh [account|--all]`** — the same guarded OAuth refresh `switch` already performs,
  now runnable for every saved account at once, so an idle machine can keep all of them alive
  instead of discovering a dead capture mid-task. It refuses outright while Claude Code or the
  desktop app is running: Anthropic rotates the refresh token on each use, so rotating one under a
  live session logs a surface out. `persist-failed` (refreshed but not saved = the stored token is
  now stale) stays as loud as it was.
- **Switch preflight: `keyflip <account> --dry-run`, a read-back after every switch, and opt-in
  `--rollback-on-fail`.** `src/switchplan.js` turns the live facts (which surfaces are captured, is
  Claude running, can keyflip close it, does a policy allow this directory, and what `verify` says
  about the target) into a plan of writes / skips / warnings / blockers, rendered before anything
  happens — and it is pure by construction, so a dry run provably cannot write. A refusal empties the
  write list rather than leaving half a plan. Then `cmdSwitch` no longer trusts its own successful
  writes: it re-reads the account it moved to and prints `verified: usable now` or the failing
  checks, and `--rollback-on-fail` re-applies the previous profile when the read-back shows the
  machine did not land (app on its sign-in screen, dead capture, or the CLI credential still the old
  account). Rollback is deliberately opt-in and scope-limited: `keyflip undo` reverts only the
  metadata git repo and never a credential store, so only accounts that were themselves saved
  profiles can be restored — and `rollbackScope()` says so instead of half-restoring.
- **The same preflight for agents: `keyflip_switch_plan`, `keyflip_verify`, `keyflip_refresh` over
  MCP.** `src/switchfacts.js` is the single read-only fact collector both surfaces use, so an agent
  and a terminal cannot get different stories about the same machine. Planning is its own
  `readOnlyHint: true` tool rather than a `dry_run` flag on `keyflip_switch`, because every mutating
  MCP tool must require `confirm` (enforced by `test/mcp.test.js`) — an agent can now ask "would this
  switch land, and is that account still usable?" without asking permission to read. `keyflip_switch`
  itself returns the read-back (`verified`, `cliEmailAfterSwitch`), and `keyflip_refresh` performs the
  guarded token refresh with the same refuse-while-running rule.
- **`keyflip llm` — the chores' cost is now a choice, stated before it is spent.** `dream`,
  `sessions distill` and `recall --answer` all shelled `claude -p`, so housekeeping burned the **active
  subscription account's** quota — and `dream schedule` repeated that nightly, unattended. `src/llm.js`
  resolves a provider (`claude` / `ollama` / any OpenAI-compatible `openai` endpoint) from
  `opts > KEYFLIP_LLM_* env > config.json`, and every chore prints
  `distills via <provider> <model> — <cost>` before its first call. An endpoint key is never stored:
  `llm.key_env` holds the *name* of an environment variable, read from the process environment at call
  time only, so nothing key-shaped can land in the git-versioned state dir, a log line or an error —
  and a value that looks like a key rather than a name is refused by `llm set --key-env`. Provenance
  follows the work: keepsakes record `distillProvider`/`distillModel`, the `dream schedule` receipt
  records the provider it was installed with, and a new `keyflip doctor` check ("chore provider")
  warns when a nightly job sits on the subscription, or when the live config diverged from that receipt.
  Over MCP: read-only `keyflip_llm` (with an optional `probe`) and `keyflip_recall {answer:true}`.
- **`keyflip doctor --history` + `keyflip scrub-history` — a secret you untracked is not a secret you
  removed.** The old "secrets in git" check only looked at what is tracked *now*, so an account capture
  that predated a `.gitignore` rule stayed fully readable from the commit that recorded it, and the
  repair (`git rm --cached`) looked like it had worked. `src/leakscan.js` walks **every blob keyflip
  ever committed** and reports file + secret KIND + blob id + how many commits still hold it — never the
  content, so the report cannot become another copy of the leak. A capture under a secret path counts
  even when its bytes match no known shape. `scrub-history` is a dry run by default; `--apply` refuses
  unless `git-filter-repo` is installed (no hand-rolled rewrites), writes a `git bundle` backup first
  and refuses to continue if that bundle does not verify, then re-scans and reports whether the history
  is provably clean. Paths **still tracked today are left alone** unless `--include-tracked`, because
  dropping a live file from history also drops it from the working tree — and a match resting only on
  the generic long-hex shape is labelled `[weak match]`, so an identifier such as a 64-hex `userID` can
  never masquerade as a credential worth destroying a file for. `keyflip memory audit [--apply]` runs
  the same scanner over keyflip's own keepsakes (a summarized chat can innocently preserve "my key is
  sk-ant-…") and redacts in place, keeping each original as `<key>.md.pre-scrub` — which is why
  `pre-scrub` joined the secret-extension set: a reversible copy of a secret is exactly as secret as
  the file it came from, and must never be versioned or backed up. Over MCP: read-only
  `keyflip_history_audit` and `keyflip_memory_audit`, confirm-gated `keyflip_history_scrub` and
  `keyflip_memory_redact`.
- **`keyflip secrets list|tolerate|untolerate` — a finding the user already decided about stops being an
  alarm, and keeps being cleaned up.** The scan is honest, which means it is sometimes repetitive: a free
  Google AI key, a JWT whose session expired weeks ago, a throwaway account's capture are all genuinely
  secrets and none of them want rotation advice. Reprinting ✗ over a settled decision is not safety, it is
  the noise that gets the one real leak skimmed past. `src/secretpolicy.js` stores that decision once — a
  rule is a **path + secret KIND**, never a value, because a value in the policy would put a fingerprint of
  the secret into the git-versioned state repo (the same rule `chains` already holds), and `--note` text is
  redacted through the secret scanner before it is written. Crucially the policy is an **ALARM control, not
  a cleanliness control**: a tolerated path stays in `planScrub`'s `paths` and is still removed by
  `scrub-history --apply`; what ends is the rotation warning and the ✗ in `doctor --history`, whose headline
  now counts alarms and adds a dim line naming what the policy silenced. There is no "keep this secret in
  history" option — that is a leak with a config file. Refused by construction: an unknown `--kind` (it
  would silence nothing and the surviving alarm would read like a bug), a bare `*` with no kinds (that is the
  scanner switched off), and any value-shaped note. `*` cannot cross a directory, broad rules are printed
  with their **reach** because they also cover anything new at that path, a corrupt policy **fails closed**
  (no rules applied, `policy_error`, every finding still alarming, dropped rules counted), and keepsakes are
  never silenced — a distilled "my key is sk-ant-…" is text keyflip wrote *about* the user, not config they
  chose to keep. `secrets-policy.json` is deliberately not a secret path, so it rides along with `keyflip
  backup` and is reversible with `keyflip undo`. Over MCP: read-only `keyflip_secrets_policy` +
  confirm-gated `keyflip_secrets_tolerate`, and `keyflip_history_audit` now separates `alarm_count` from
  `tolerated_count` so an agent cannot report a clean repo it merely silenced. Tests assert the scrub still
  contains the tolerated path, that no secret value or absolute keepsake path appears in any payload, and
  that `untolerate` brings the alarm back.
- **`keyflip threads` — one name for the same task when it is spread over two accounts.** A quota runs
  out mid-task, the switch happens, and the work is suddenly two Claude Code sessions with unrelated
  ids plus a cloud chat nobody can point at — `keyflip chat` can reach the other account, but only
  piece by piece, and nothing says "these three are one job". `src/threads.js` is keyflip's own store
  for that: `~/.config/keyflip/threads/<slug>.json` holds **POINTERS** (session ids, claude.ai chat
  uuids, the account each belongs to), never a copy of the conversation. The transcripts stay exactly
  where Claude put them, so nothing duplicates, and a thread that is deleted, corrupted or carried to
  another machine cannot lose a single message — only a name. `create / add / remove / drop / list /
  show / open / where / suggest / mirror / unmirror`, and:
  - **`threads suggest` finds the fragmentation instead of asking for it.** It groups recent sessions by
    project folder and keeps the folders where **two or more NAMED accounts** worked, minus sessions a
    thread already covers, so the list shrinks as work gets named — and one account plus unassigned
    sessions is deliberately *not* reported (that is an account nobody assigned, not a split). An
    unassigned session is never treated as a switch.
  - **Ids you can actually paste.** `suggest` and `list` print 8-char ids; `resolveSessionId()` expands
    a unique prefix to the full id at write time and refuses an ambiguous one, so a thread never stores
    a dead pointer. (This was found by a test, not by review: the CLI used to write the short id
    straight into the pointer file, where it resolved to nothing.)
  - **One merged timeline, honestly labelled.** Turns sort chronologically across members; a member with
    no timestamps becomes a front *group* rather than being smuggled between decisions; provenance
    dividers show `↪ from gmail · session aaaaaaaa`, so the account switch is visible *inside* the
    conversation; a cloud chat contributes no turns offline and lands in `unavailable` with the
    `keyflip chat get …` command that would. Caps announce themselves (`cappedMembers`,
    `droppedFromStart` — going over `maxTotal` drops the OLDEST end, because the recent tail is what
    continuing the work needs) and reads stream under `threads.mergeMaxMiB` (default 8), since real
    transcripts here run to 24 MB and a thread merges several.
  - **`threads open` resumes where the work stopped, as the account that owns it** — `newest()` only
    considers transcripts, and a member whose account cannot be resolved is warned about rather than
    resumed under whatever happens to be active.
  - **The prose stays opt-in, and provable.** `threads mirror` writes the merged conversation to
    `~/.config/keyflip/thread-mirror/<slug>.md` only when BOTH the `threads.mirror` config flag (default
    **off**) and the call say yes; the directory is registered in `secretpaths.SECRET_DIRS`, so it is
    0600 and git-ignored, and `privacyCheck` still refuses when the state repo has a git remote
    (`--force` overrides). Three carriers were then read back rather than assumed, because each is a
    different code path: `keyflip backup` **does** walk `configDir` and skips it only via `SECRET_DIRS`,
    while `migrate` and `sync` send a curated payload that has no thread keys at all — so the pointers
    stay on the machine that named them and their prose cannot leave. A test asserts the mirror dir is a
    secret dir and the pointer dir is NOT (the mirror is the only thing between a merged transcript and a
    versioned file), and the same test walks a real backup for the mirror-only strings. Nothing
    auto-copies transcript text into a pointer either: `threads add` stores the project key only, and the
    preview is read live — a thread whose first prompt was a pasted API key must not put that key into a
    versioned file.
  - Names are filenames, so they are normalized, not trusted: `../secrets/x` cannot escape `threads/`,
    and a slug keeps its word — NFD + diacritic folding plus `ı→i`, because these threads are titled in
    Turkish and a naive `[^a-z0-9]` fold renders "düğüm" as "d-g-m".
  - A corrupt or hand-edited file is **reported**, never treated as empty (`list` shows it, `read`
    refuses to write over it, dropped members are counted and never persisted). `keyflip doctor` gained a
    `threads` row for the three silent failures: unreadable files, members with no resolvable account,
    and the mirror being on. Over MCP: read-only `keyflip_threads` (show / `timeline` / `suggest` /
    reverse `id` lookup) plus confirm-gated `keyflip_thread_create|add|remove|drop|mirror`; their
    payloads report the pointer file relative to the state dir and the transcript relative to
    `~/.claude/projects`, the way `keyflip_chains` does, because the result is copied into an agent
    transcript — and the CLI's `--json` now follows the same rule (it used to print `/Users/<name>/…`),
    while the human output keeps real paths so they can be opened, and a resume command's `cwd` stays
    absolute because running it needs it. `threads show --md` prints ONLY the markdown document, so it
    pipes into a file or an agent context without a human header glued to the front.
- **The account switcher can now show a thread: `keyflip menu` → `[t]`.** A thread only earns its keep at
  the moment an account is about to change, and that moment is the menu, not a terminal running
  `keyflip threads list`. The screen is deliberately **read-only**: every thread with its members — which
  named account each belongs to, where its transcript is, how fresh it is, and the exact
  `cd … && claude --resume …` line that continues it — plus `[s]`, which *looks for* split work instead of
  making the user enumerate it, and a header that counts the members which would silently resume as the
  **current** account. It never reads a transcript body, never writes, never spends quota; creating,
  adding and dropping stay CLI/MCP, because naming a task is the user's call. Building it surfaced a real
  input bug: piping answers to the menu lost every line after the first, because `rl.question` drops a
  `line` event that arrives while no question is pending and a piped chunk delivers them all at once.
  `src/menu.js` now shares one queued reader between the account list and its sub-screens, so
  `printf 't\ns\n\nq\n' | keyflip menu` walks the whole screen. Tests drive both input modes (queued lines
  and keypresses) and byte-compare the `threads/` directory before and after, so "read-only" is an
  assertion rather than a comment.
- **`keyflip chains [account] [--tighten [--apply]]` — what one "login" is actually made of, and who
  can keep it alive.** An account is never one file: it is a live credential plus every copy keyflip
  has taken from it (an OAuth profile, the desktop app's token cache *and* its session cookie, a
  browser cookie snapshot, a provider key, a third-party `surfaces/` capture). `src/chains.js` maps
  that graph from **paths and file stats only** — it never reads a secret's content, never spawns
  `security … -w` (a Keychain item is therefore reported `exists: null`, unprobed, rather than
  fetched), and writes nothing into the state repo, so it cannot leave a fingerprint of a value in
  git. Three failures that were otherwise only visible *after* a switch misbehaved become plain:
  **renewal** (the app's `oauth:tokenCache` is derived from its `sessionKey` cookie, so the cookie is
  the chain's root and nothing renews it but a human — "switched account opens the onboarding screen"
  while every token blob looks healthy); **staleness** (a capture whose source store has a newer
  mtime is a copy of the past — on a real machine, eight captures were 48–198 h behind their
  sources); and **sharing** (one browser profile or one app cookie jar holds exactly one account, so
  four captures taken from `Chrome/Default/Cookies` contend by construction). It also reports
  captures filed under an account with no profile (`keyflip list` can never show them), profiles with
  nothing to restore, and secret files inside the state repo whose mode grants access beyond the
  owner — the one finding class `--tighten --apply` fixes with a re-scan that proves the chmod
  landed. Modes of stores keyflip does *not* own are deliberately not flagged: Chrome's own cookie DB
  being 644 is normal, and a permanent warning over it would train everyone to ignore warnings.
  `keyflip doctor` gained a "credential chains" row that only goes red for the fixable exposure.
  Over MCP: read-only `keyflip_chains` and confirm-gated `keyflip_chains_tighten`; both the CLI
  `--json` and the MCP payload strip absolute paths (`publicNode`/`publicRisk`) so a transcript of
  the map stays safe to paste into a chat.
- **`keyflip refresh --schedule [--at 04:30] | --unschedule | --schedule-status` — the tokens renew
  themselves, on the machine's own clock.** `refresh --all` already existed, but "run it when the CLI
  is idle" is advice nobody follows at 04:30, and an Anthropic token expires on the calendar rather
  than on the day you happen to switch. `src/schedule.js` became a two-JOB scheduler (`JOBS.dream` /
  `JOBS.refresh`) instead of a dream-only module: each job carries its own launchd label, its own
  managed crontab marker, its own receipt file, its own plist and log path, so installing or removing
  one can never clobber the other — while `jobOf()` defaults to `dream`, leaving every call site and
  test written before this unchanged. The refresh argv is FIXED (`refresh --all`): nothing from `opts`
  reaches the Linux `/bin/sh -c` cron line, so this job cannot be steered the way `older_than_days`
  once could, and its default hour is deliberately 04:30 rather than the dream's 03:00. The plist now
  declares two things learned the hard way: `AbandonProcessGroup` (launchd otherwise kills the job's
  whole process group when the job exits — that is what murdered the detached workers a scheduled
  dream used to start) and `StandardOutPath`/`StandardErrorPath` into `~/Library/Logs/<job>-keyflip.log`,
  because an unattended job nobody can read after it ran is a job nobody can debug. launchd's PATH is
  `/usr/bin:/bin:/usr/sbin:/sbin`, which is not where an fnm-installed `keyflip` lives, so the argv is
  asserted as a whole now: `test/schedule.test.js` parses `ProgramArguments` and requires
  `[node, <keyflip.js>, refresh, --all]` — a grep for the string "refresh --all" passed on a plist that
  could not run. `--json` is read from `JSON_MODE` (a command-local `rest.indexOf('--json')` can never
  see it: `main()` consumes the global flag first), and the refuse-while-running path emits
  `{refused, instances, changed:false}` instead of prose, since exit 0 plus a paragraph is how a no-op
  gets mistaken for a renewal. Receipts are metadata-only and now git-ignored: a receipt that travelled
  with the state repo to a second machine would make `doctor` report a nightly job that is not scheduled
  there. The new `token renewal` doctor row (warn: N accounts and nothing renews their tokens; green:
  renewed nightly at 04:30) reads the receipt, so `doctor` stays offline and hermetic. Over MCP:
  `keyflip_refresh_schedule` — its own tool rather than a `job` flag on `keyflip_dream_schedule`,
  because that tool's "spends your quota" wording would be a lie about a job that calls no model — and
  confirm-gated like every mutating tool. Verified on the machine it was built on, not by exit code:
  `launchctl print gui/501/com.keyflip.refresh` reports `runs = 1`, `last exit code = 0`,
  `properties = abandon process group | inferred program`, and the log holds the guard's own refusal —
  "Claude Code is running on this machine … nothing was changed" — which is the designed outcome for a
  night the user was still working.

### Fixed

- **A keyflip state file was listed as a saved account.** `profiles.list()` decides "is this an account?"
  by taking every top-level `<configDir>/*.json` and subtracting `RESERVED_FILES`, and
  `refresh-schedule.json` — written by the new `refresh --schedule` — had been added to the git-ignore
  list and never to that one. So the machine running the feature listed `refresh-schedule` as an account
  in `keyflip list`, in the interactive menu, and in every count; worse, `isValidName()` did not reject
  the name, so an account called that could overwrite the receipt. `dream-schedule`, `refresh-schedule`
  and `secrets-policy` are reserved now, with the invariant written above the list, and the new test
  imports the filenames **from the modules that write them** (`schedule.RECORD_NAME`,
  `secretpolicy.FILE_NAME`) and iterates the whole reserved list — the drift fails in the commit that
  would cause it instead of on the user's machine.
- **`surfaces/` captures were versioned and backed up.** The secret set in
  `src/secretpaths.js` listed `creds/`, `app/`, `browser-sessions/` and
  `pre-sync-backups/`, but not the directory third-party tool captures live in.
  Because those files have innocent basenames (`auth.json`, `CURRENT`, `000003.log`),
  neither the managed `.gitignore`, nor `keyflip backup`, nor `keyflip doctor`'s
  "secrets in git" check caught a Codex/ChatGPT capture: its OAuth tokens and API key
  were committed to the state repo and reported as clean. `surfaces/` is now a secret
  directory, `auth.json` is a secret basename, and `ensureRepo`'s existing stale-ignore
  purge removes any already-tracked copy on the next command.

  Correction to the first version of this entry (and to commit `0b1cbba`): it also
  claimed the tokens had been copied into metadata backups. `backup.js` really does
  walk any directory missing from `SECRET_DIRS`, so the exposure was latent — but on
  the machine where this was found, both backups predate the capture and contain zero
  `surfaces/` files. The backup risk is a code property, not an observed leak.
- Three defects in the new `threads` layer, all found by **running** it rather than reading it:
  - `keyflip threads add <id>` died with `Assignment to constant variable.` on **every id that resolved**
    (`src/cli.js` declared `const member` and then reassigned it to the expanded member). The unit and
    MCP layers both call the module, so only the CLI path hit it; `test/cli.test.js` now drives the real
    binary over a throwaway `HOME`, including that "expands to the full id" line, so the regression is
    covered at the layer that missed it.
  - `threads.read()` returned two different shapes depending on **how the name matched** — the exact-slug
    path gave the bare record, the prefix path gave a `list()` row — so `keyflip threads show <exact-slug>`
    printed `undefined` for `thread.file`. Both now return the same row.
  - The doctor `threads` row spelled the mirror directory as an absolute path, and `doctor --json` /
    `keyflip_doctor` are built to be pasted into an agent transcript. It now names the directory
    (`thread-mirror/`), and the mirror status clause rides on the **warning** row too — a warning that
    hides "you have conversation text on disk" is a leak the user stops seeing.

### Added

- `test/backup.test.js`: a metadata backup must carry `accounts.json` and never a
  surface capture, an app cookie file or an `auth.json`.

## [1.5.2] - 2026-10-13

Everything that has shipped since 1.5.0, which was the last published release
(1.5.1 was never tagged). The entries before this release were not tracked here,
and the 1.5.2 entry that used to sit in this file described the tooling work that
is now folded into the Tooling section below, under a wrong date.

### Added — accounts and surfaces

- `keyflip onboard`: guided multi-surface first run — sign in, capture the CLI and
  browser, point the live CLI at that account, capture the desktop app, sync chats.
  It signs the browser out of the previous account between captures, so account #2
  is a clean login. `keyflip setup` is the lighter wizard; `login --manual` takes a
  pasted code or redirect URL for email-code and magic-link sign-ins; `login --fresh`
  and cross-surface logout came with it.
- The **browser** (and with it the Claude Chrome extension, which has no login of its
  own) is a first-class surface: `keyflip list` shows it per account, `--browser`
  aligns it on a switch, and `browser capture|status|logout|sync` manage it.
- The **Claude desktop app** login can be captured and switched: on macOS (token cache
  plus the session cookie in the app's own jar), on Linux, and the Windows app-auth
  crypto foundation (DPAPI + AES-256-GCM) with the non-crypto parts.
- `keyflip reset` and `keyflip uninstall`; `reset --logout` closes every surface for a
  total zero. `keyflip consolidate` syncs chats across accounts (also `keyflip_consolidate`).

### Added — reading conversations

- `keyflip chat` reads claude.ai cloud Chat history, resolves the 8-char id a listing
  prints (or a unique title) to a conversation, and `--as <account>` reads another
  account from its saved session — no switching required.
- `keyflip foreign --list` discovers other agents' session logs (Cursor, opencode,
  Gemini, Qoder, Copilot, Aider) and normalizes one into the same view, through
  from-scratch zero-dependency SQLite and YAML readers.
- `keyflip sessions export <id>` writes a chat as clean markdown / HTML / JSON; session
  lifecycle commands delete, PII-scrub and surgically edit; `sessions rebind` follows a
  moved project folder, including the Claude config surfaces that name it.
- `keyflip doctor` state-hygiene checks: secrets tracked in git, orphaned sessions,
  rebind backups, empty project folders, versioning, quota headroom, settings.json.

### Added — automation, control plane, companions

- `keyflip autoswitch` — an unattended background service that rotates the CLI account at
  a usage threshold, honouring `autoswitch.strategy` / `autoswitch.group`.
- `keyflip usage --providers`: usage and limits across the other AI tools on the machine.
  Also cost intelligence, groups, budgets, notifications, `shell-init` so `cd` activates
  the pinned account, `.env` import, WAL-merge reading, and an audit log.
- Fleet: a multi-machine control plane with per-machine Ed25519 origin authentication
  (TOFU-pinned), cross-machine migration, QR pairing, dashboards, and the zero-knowledge
  self-hostable internet relay (`keyflip transfer relay`, `keyflip_transfer_relay_pull`).
  `--agent-config-secrets` opts in to carrying real keys between your own machines.
- MCP parity with the CLI — 50+ tools covering gateway, mcpreg, speedtest, share, sync,
  link and transfer.
- Companions: a VS Code view (accounts tree, mismatch status bar, re-link), an IntelliJ
  Platform plugin, a menu-bar plugin (xbar/SwiftBar) with Linux tray via Argos/kargos, a
  TUI, and a command palette.
- Context Layer: portable project memory in `.keyflip/`. Opt-in Gemini "brain"
  (suggest-and-approve). `install --link` developer mode for a checkout install.
- Productization groundwork, off by default: a multi-provider license issuer skeleton
  (Ed25519 + payment-provider webhooks) and env-gated paywall enforcement behind
  `KEYFLIP_LICENSING`.

### Changed

- **Breaking:** `keyflip reset` is now a FACTORY reset (it deletes all data), and the
  `clean` command is dropped — `reset` is the one wipe and also sweeps stray backups.

### Fixed

- A saved desktop-app *capture* is now told apart from a *live login*: `list` marks an app
  that will open on its sign-in screen, `doctor` gained a desktop-app-session check, and a
  switch that reopens Claude verifies the app came back signed in instead of claiming a
  clean switch.
- Project keys are encoded the way Claude actually encodes them, orphan and deletion claims
  are provable rather than asserted, and `rebind` no longer drops the `cliSessionId` that a
  desktop-app Code session needs to reopen after a folder move.
- Store folders that are not accounts (`skills-plugin/…`, anything not UUID-named) are no
  longer read or written by consolidate, and a `deleted_<id>` tombstone keeps a deleted
  session deleted. Foreign-session discovery no longer lists `auth.json`-style credential
  files as chats.
- Never force-clear a running browser's Cookies DB during a logout; warn on an unflushed
  Cursor `-wal` instead of silently dropping the recent chats; proxy accepts port 0 and
  rejects on listen errors; auto-named profiles disambiguate by domain instead of colliding
  on the local part.
- The redaction module that a `secrets*` gitignore rule had silently excluded from the
  package is restored; the half-connected config and notify plumbing is wired; three
  advertised-but-inert settings were removed and the last two wired.
- Multiple adversarial-review fixes across the fleet, vault, policy, swarm and parser work
  (cross-inbox signature replay, policy bypass, WAL-merge DoS cap, MCP lock races, among
  others).

### Tooling

- The whole codebase moved from CommonJS to ES Modules; ESLint, Prettier, Husky and
  lint-staged; TypeScript type-checking through JSDoc annotations (`tsc --noEmit`);
  `.nvmrc`; a coverage script; CI matrix (macOS/Linux/Windows × Node 20/22) with lint,
  format, type-check, test and security-audit gates.
- Architecture and labels documentation; the EN and TR READMEs aligned section for section.
- For this release: every test process now runs inside a private temp root it removes on
  exit (the suite was leaving ~14k directories per run), the suites that build real SQLite
  cookie jars skip instead of failing where the `sqlite3` CLI is absent, and the GitHub
  Actions and dev dependencies Dependabot had been asking for are applied, including the
  patched `brace-expansion` that clears the high-severity audit gate.

## [1.5.0] - 2026-07-02

Earlier history is not recorded in this file.

[Unreleased]: https://github.com/hakkisagdic/keyflip/compare/v1.5.7...HEAD
[1.5.7]: https://github.com/hakkisagdic/keyflip/compare/v1.5.6...v1.5.7
[1.5.2]: https://github.com/hakkisagdic/keyflip/compare/v1.5.0...v1.5.2
[1.5.0]: https://github.com/hakkisagdic/keyflip/releases/tag/v1.5.0
