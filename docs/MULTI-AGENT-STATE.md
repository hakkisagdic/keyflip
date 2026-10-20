# Multi-agent memory / config / sessions — spec (epics J1 + F)

> From a keyflip research pass (2026-07-06). Paths marked **NEEDS-VERIFICATION** were not
> confirmed on a real install and must be checked before shipping that tier. keyflip rules
> hold: zero-dep, **secrets never in git**, opt-in per tool.

## J1 — carry other agents' MEMORY + config across machines

Per-tool registry (home-level unless noted). keyflip's `agents` bundle carries the **memory /
instruction files** (markdown, no secrets); config files that hold secrets are opt-in + gitignored.

| Tool | Memory (instructions) | Config | Secrets (NEVER commit) | Confidence |
|---|---|---|---|---|
| **Cursor** | `~/.cursor/rules/` (+ project `.cursor/rules/`, legacy `.cursorrules`) | `~/.cursor/mcp.json` | `mcp.json` if it inlines keys (use `${env:VAR}`) | HIGH |
| **Gemini CLI** | `~/.gemini/GEMINI.md` | `~/.gemini/settings.json`, `*/mcp_config.json` | `~/.gemini/oauth_creds.json` | HIGH |
| **Copilot CLI** | `.github/copilot-instructions.md`, `AGENTS.md` (project-level) | `~/.copilot/config.json`, `mcp-config.json` | `~/.copilot/data.db` (token), `mcp-config.json` | HIGH (files) / MED (db) |
| **Codex CLI** | `~/.codex/AGENTS.md`, `~/.codex/memories/*.md` | `~/.codex/config.toml` | `~/.codex/auth.json` | MED (Codex deprecated) |
| **opencode** | NEEDS-VERIFICATION (instruction location) | `~/.config/opencode/opencode.json` | `~/.local/share/opencode/auth.json` | MED |
| **Aider** | `CONVENTIONS.md` (project, via `.aider.conf.yml read:`) | `.aider.conf.yml` | `.env` | MED |

**keyflip J1 v1 (SHIPPED):** the **home-level markdown memory** only — `~/.cursor/rules/`,
`~/.gemini/GEMINI.md`, `~/.codex/AGENTS.md` + `~/.codex/memories/` — existence-gated, opt-in via
`keyflip migrate export … --agents` (and `transfer`/`push`). Project-level files (`.cursorrules`,
`copilot-instructions.md`, `CONVENTIONS.md`) travel with their git repos, so they're out of scope.
Config files (secrets) are deferred (opt-in + secret-scan first — see below).

Surface: `src/agents.js` (`REGISTRY`, `collectAgentMemory`, `mergeAgentMemory`, `presentAgents`) →
`keyflip agents` (inspect, read-only), `--agents`/`--agents=cursor,gemini`/`--only-agents` bundle
filters, MCP `keyflip_agents` + `agents:true`/`agent_ids` on `keyflip_migrate_export`. Merge is
union (kept unless `--force`), guarded against path-traversal and non-markdown writes. Only `.md`
/`.mdc`/`.txt` are ever collected or written — auth/config JSON can never ride along.

**Secret safety:** before carrying any *config* file, scan for plaintext keys (`sk-`, `Bearer `,
`"token"`, `_API_KEY`) and refuse/warn; recommend `${env:VAR}` refs. gitignore: `oauth_creds.json`,
`auth.json`, `*.env`, `data.db`, any mcp config with inline keys.

**CONFIG-TIER SHIPPED (2026-07-07):** `src/secretscan.js` (reusable scanner/redactor) + `agents.js`
`CONFIG_REGISTRY` (Cursor `~/.cursor/mcp.json`, Gemini `~/.gemini/settings.json`, Codex
`~/.codex/config.toml`). `collectAgentConfig` redacts on the way out, `mergeAgentConfig` re-redacts
on the way in (defence in depth) + refuses unknown paths + symlink-guards. Behind opt-in
`--agent-config` / `--only-agent-config` and MCP `agent_config:true`. Known token shapes +
credential-key-name redaction; `${VAR}` refs and `*_TOKENS` limits preserved. Residual gap: a secret
under a benign key with no known prefix can slip — encrypt real transfers.

## F — read/normalize other tools' SESSION stores

**v1 SHIPPED (2026-07-07):** `src/foreign.js` — `keyflip foreign <file>` + MCP `keyflip_foreign_export`.
Detects + normalizes a session-log FILE into keyflip's unified conversation shape (the same
`transcript.parse` output), then renders it as markdown/HTML/json via the Claude Code exporter.
Supported now (zero-dep, tolerant): **message-event JSONL** (Claude Code, and Gemini-style
`transcript.jsonl`) via the tested `transcript.parse`; **Cursor SQLite** (`cursorDiskKV`) via a
**from-scratch zero-dep SQLite reader** `src/sqliteread.js` (header + table B-tree + record serial
types + overflow-page chains — verified against real sqlite3 fixtures), with a best-effort
bubble→message mapping (order from the composer header list, role from `type`); **generic JSON**
(opencode + others — largest array of `{role, text/content}` objects); **Aider**
`.aider.chat.history.md` via a best-effort markdown parser. The Cursor/JSON/Aider mappings are
NEEDS-VERIFICATION against a real install — the SQLite *reader* itself is fixture-verified.
**Copilot** (YAML) now ships too — parsed via the from-scratch zero-dep `src/yamlread.js` and wired
into `detect()`/`normalize()` (23/23 tests). Each parser is isolated behind `detect()`, so adding a
source later is one function + a fixture test.

## ⚠️ Kiro token refresh limitation (platform constraint)

Kiro uses AWS SSO OAuth with **single-use refresh tokens**. When either the CLI or IDE refreshes its
token, the other surface's refresh token is **automatically invalidated**. If both surfaces attempt
to refresh concurrently, AWS detects "token reuse" and **revokes the entire token family**, forcing
a human re-login.

**What this means for keyflip:**
- ✅ keyflip can capture and switch Kiro accounts across CLI + IDE surfaces
- ❌ keyflip **cannot** implement background auto-refresh for Kiro without risking session invalidation
- ✅ Safe approach: only refresh reactively after a 401 error, and check disk first to see if the
  other surface already refreshed

This is an **AWS/Kiro platform limitation**, not a keyflip bug. Separate client registrations for
CLI and IDE would be required to enable independent refresh chains — that change must come from the
Kiro team.

Unified shape: `{ tool, sessionId, created_at, updated_at, resumable, resumeCommand, messages[], metadata }`.

| Tool | Session path | Format | Resumable | Feasibility |
|---|---|---|---|---|
| **Copilot** | `~/.copilot/session-state/<id>/` (workspace.yaml + checkpoints/index.md) | YAML+MD | ✅ `copilot --resume=<id>` | easiest |
| **Gemini** | `~/.gemini/antigravity-cli/brain/<UUID>/…/transcript.jsonl` (+ conversations/<UUID>.db) | JSONL | ✅ | easy |
| **Cursor** | `~/.cursor/chats/*store.db` (`cursorDiskKV`: `composerData:*`, `bubbleId:*`) | SQLite | ✅ `cursor agent --resume <id>` | medium |
| **opencode** | `~/.local/share/opencode/project/*/storage/` (`ses_*`) | JSON/JSONL (NEEDS-VERIFICATION) | ✅ `opencode --session <id>` | medium |
| **Aider** | `.aider.chat.history.md` per repo | Markdown | ⚠️ partial (no session ids) | hardest |

Normalization is per-tool (SQLite/YAML/JSONL parsers). Ship order: Copilot → Gemini → Cursor →
opencode → Aider. Reuse keyflip's `sessions`/`recall` once normalized into the unified shape.

Per-tool **resume** commands are now mapped in code (`foreign.resumeCommand(tool,id)`):
`cursor agent --resume <id>` · `copilot --resume=<id>` · `opencode --session <id>` ·
`claude --resume <id>` (jsonl/Claude/Gemini) · Aider → none (no session-resume CLI). These are
surfaced to the user as printable commands, never shell-executed by keyflip.

### Verification checklist (run on a machine with these tools)
- opencode: instruction-file location + `storage/` message schema (the `--session` resume is mapped).
- Copilot: `data.db` token extraction (or skip — carry only the memory md).
- Aider: confirmed no `--resume`/session-list exists (resumeCommand returns null).
- Cursor: `cursorDiskKV` bubble ordering for a faithful transcript.

## G — background token refresh daemon (SHIPPED 2026-10-20)

**Architecture:** Continuous background daemon (`keyflip refresh --daemon-start`) runs as launchd
KeepAlive agent (macOS) or @reboot crontab entry (Linux), checking credential expiry every 5 minutes.

**Per-tool refresh strategies:**

| Tool | Strategy | Mechanism | Lifetime | Notes |
|---|---|---|---|---|
| **Antigravity** | Proactive | Google OAuth refresh_token → access_token | ~1 hour | Uses public client credentials; exponential backoff on failure (1→5→15 min, max 3 retries) |
| **ChatGPT** | Proactive | Session token → bearer via `/api/auth/session` | ~7 days | Bearer short-lived, session token ~3 months; backoff same as Antigravity |
| **Kiro** | Reactive-only | SHA256 hash of refresh_token | N/A | NO proactive refresh (AWS SSO single-use tokens); detects IDE/CLI rotation via hash change |
| **Claude Desktop** | Reactive-only | AES-128-CBC decryption of cookie DB | ~30 days | Keychain "Claude Safe Storage" → PBKDF2-HMAC-SHA1 (saltysalt, 1003 iter) → decrypt cookies SQLite; cannot refresh without human re-login |

**Security model:**
- Only reads/writes 0600 files under `~/.config/keyflip/surfaces/`
- No tokens passed on command lines; Keychain access uses stdin-based helpers
- Claude cookie decryption: IV = 16 space chars, prefix strip for Chromium ≥ v130 (32-byte host-binding)
- Metrics file (`refresh-metrics.json`) contains counts/timestamps only — never tokens or secrets

**Error handling:**
- Exponential backoff: 1min → 5min → 15min between retry attempts
- Max 3 consecutive failures before giving up until next successful refresh
- Persistent metrics tracking: total checks, refreshes, failures per account
- Daemon continues operating even when individual tool refreshes fail

**Observability:**
- Logs to `~/Library/Logs/refresh-keyflip.log` (macOS launchd)
- `keyflip refresh --metrics` shows per-account statistics
- Kiro hash changes logged with old/new hash prefixes for debugging
- Claude session extraction failures logged but don't stop daemon

**Complementary to nightly scheduler:**
The existing `keyflip refresh --schedule` runs `refresh --all` once daily as a batch job. The daemon
provides continuous monitoring between scheduled runs, catching tokens that expire unexpectedly or
detecting platform-initiated rotations (Kiro IDE/CLI, Claude Desktop re-auth).

**Limitations:**
- Claude Desktop: Cannot proactively refresh; requires human re-login every ~30 days
- Kiro: Hash detection only; cannot prevent AWS SSO revocation if refresh_token used elsewhere
- Linux: @reboot cron may not run if system doesn't boot (laptop asleep); launchd KeepAlive more reliable
