# keyflip Roadmap

> Status: **mixed — shipped + planned.** Large parts of this file are now BUILT and in the
> current release (account switching, providers/proxy, sessions, backup, migrate + LAN/WebDAV
> transfer, the **fleet control plane with Ed25519 origin authentication**, foreign-session import,
> Windows app-auth crypto, …); items marked ✅/◑ are done/partial, and ⬜/"Deferred"/"NEEDS-VERIFICATION"
> are the remaining backlog, in roughly the order below. Prices, star counts and product details are a
> **mid‑2026 snapshot** and drift — treat them as directional, re‑verify before building against any
> specific number.
>
> Companion docs: [README.md](README.md) · [README.tr.md](README.tr.md) ·
> [skills/keyflip/SKILL.md](skills/keyflip/SKILL.md). When any item here ships,
> update all three (EN + TR + skill) in lockstep.

---

## 0. North Star — what keyflip is becoming

keyflip today (v1.5.0) is a **multi‑account switcher for Claude** with provider
profiles, a command‑activated failover proxy, an MCP server, and local
Cowork/Chat/session tooling.

Where it is going: **the universal control plane for every AI coding surface,
subscription, and API key on one machine** — one place to *hold* every login,
*route* every request, *stretch* every quota, and *present* it all cleanly.
Everything stays **command‑activated — never an always‑on background daemon**
(this is a hard product rule, applied to the proxy, the router, and the bridge).

**The one idea underneath everything: account switching.** keyflip's whole reason
to exist is holding *many* accounts and switching between them. Generalized, that
becomes **quota rotation** — for any tool with a capped/free tier (Copilot 2k/mo,
Trae 5k/mo, Antigravity 20/day, Claude 5h/7d…), holding N accounts and rotating
them gives **N× effective quota**. Every surface, plan and tool in this doc is
judged by that lens: *what is the account unit, and can keyflip swap it?* (The
switchability taxonomy A–E lives in §E1.)

Four pillars everything below hangs off:

| Pillar | One line | Epic |
|---|---|---|
| **HOLD** | Hold *multiple* accounts per surface (IDE / CLI / chat / extension) and **switch/rotate** them — subscriptions *and* API keys — for N× quota. | **E1** |
| **ROUTE** | Switch at the *request* level: send each request across accounts/providers/models with rules, fallback, fusion — one key, one declared model, keyflip decides. | **E3** |
| **BRIDGE** | Turn a subscription into an API endpoint (Copilot/ChatGPT — the "copilot api" project), then rotate a *pool* of subscriptions behind one key. | **E2** |
| **PRESENT** | One central settings store + per‑surface run‑mode & rotation policy, a real TUI account switcher, and full MCP parity. | **E4, E5** |

Guiding constraints (carried from the whole project, non‑negotiable):

- No secrets in the repo. OAuth tokens / API keys live only in the OS credential
  store. **Never** pass a secret via argv — `--key-file`/stdin only.
- Command‑activated, not daemonized. Everything the user starts, the user stops.
- `~/.claude/projects` history and the live login are never mutated except through
  explicit commands.
- Never delete/unpublish/switch without explicit consent.
- Subscription⇄API bridging (E2) is a **ToS gray area** — see §5. Ship it as an
  opt‑in, clearly‑labeled, self‑hosted‑only capability; never a default.

---

## 1. Phase 0 — competitor‑adoption backlog (already scoped)

The 19 items from the router/switcher deep‑scan (claude‑code‑router 35k★,
claude‑relay‑service 12k★, clother, ccconfig, config‑switcher). Kept as the
near‑term backlog; several are prerequisites for the big epics (E3 especially).

### Phase 0a — quick wins (low effort)
| # | Item | Feeds |
|---|---|---|
| 2 | Honor `Retry-After` + exponential backoff before failing over on 429 | E3 |
| 3 | Authoritative‑reset‑only 429 triage (don't fail over on billing/org‑disabled 429s) | E3 |
| 9 | Priority + LRU deterministic account ordering (`priority` field) | E3 |
| 10 | Route‑decision debug headers / `--verbose` (`x-keyflip-account`, `-route-reason`) | E3 |
| 14 | `keyflip test --all` parallel provider health check | — |
| 15 | `keyflip provider fork <src> <new>` duplicate a provider config | — |

### Phase 0b — provider ecosystem (the biggest gap vs competitors)
| # | Item | Feeds |
|---|---|---|
| 1 | **Built‑in preset catalog** (`src/catalog.json`): Z.AI/GLM, Kimi, MiniMax, DeepSeek, Qwen, OpenRouter, Ollama/LM Studio… base_url + tier models, so `keyflip provider add <id>` needs only the key | E1, E3 |
| 17 | Interactive provider picker (numbered, category‑grouped) — argument‑less `provider add` | E5 |
| 16 | `keyflip test`/`provider models` → query `/v1/models`, suggest a default model | — |

### Phase 0c — smart‑router substrate (→ folds into E3)
| # | Item |
|---|---|
| 4 | Declarative `proxy-routes.json` with mtime hot‑reload |
| 5 | Rule‑based routing engine + no‑dep token estimator |
| 6 | Fallback modes: `off` / `retry` / `model-chain` (incl. model degradation) |
| 7 | Per‑provider + per‑route body/header rewrites (transformers) |
| 8 | Sticky same‑conversation‑same‑account routing (`user_id` key + TTL map) |
| 19 | Custom router script hook (`CUSTOM_ROUTER_PATH`) |

### Phase 0d — reliability, cost & tier awareness
| # | Item |
|---|---|
| 11 | Per‑error‑type cooldown TTLs + `keyflip cooldown` / `reset` readout |
| 12 | Model‑eligibility filtering by subscription tier (Free≠Opus) before selecting an account |
| 13 | Fine‑grained cost accounting (cache tiers + 200k + fast‑mode multiplier) |
| 18 | Self‑updating model‑pricing table (LiteLLM prices, SHA‑256 verified, bundled fallback) |

---

## 2. The big epics

### E1 — Universal surface support (HOLD every credential)

**Goal:** do for *every* AI coding surface what keyflip already does for Claude —
**hold multiple accounts and switch between them.** Not a feature list of other
tools; the whole point is the switch. The same primitives (capture, switch, list,
doctor, backup, run‑isolated) generalized over a **surface registry**.

**Why this is the core value — quota rotation (the universal keyflip play).**
Every one of these surfaces has a *capped* tier: Copilot Free 2k completions/mo,
Trae Free 5k/mo, Antigravity 20 req/day, Kiro 50 credits/mo, Cursor/Windsurf free
tiers, Claude 5h/7d windows. Hold **N accounts** of the same tool and rotate them,
and the effective quota is **N×**. That is exactly the Claude play — generalized to
Copilot, Cursor, Trae, Gemini CLI, everything. So each catalog entry is judged by
one question: **what is the account unit, and can keyflip swap it?**

**Switchability taxonomy** (drives which adapters are cheap vs hard):

| Class | Credential shape | Switch = | Examples | keyflip effort |
|---|---|---|---|---|
| **A — file/token swap** | readable JSON/YAML/token file | capture N, restore one | Codex `auth.json`, Gemini `settings.json`, Copilot CLI `config.json`, opencode `auth.json`, Aider yaml/env, Cursor SQLite session | **low** (does this already) |
| **B — OS keychain** | macOS Keychain / libsecret / DPAPI | swap keychain item | Claude Code, Zed, Goose, Copilot‑CLI (default) | **medium** (already solved for Claude on macOS) |
| **C — cloud session/cookie** | server‑side session + cookie/token | swap cookie/token, re‑auth fragile | Claude desktop, chat apps, some IDEs | **high** (fragile — like today's Chat) |
| **D — bundled, vendor‑account switch** | one vendor login, keys bundled server‑side | switch the *vendor account* → resets its free quota | Trae (ByteDance), Qoder, Antigravity, Kiro | **the account is the vendor login** — rotate it for N× free quota |
| **E — BYO key (not an account)** | provider API key | this is a **provider profile**, already shipped | Cline, Aider, Continue, any BYOK tool | **done** (use `provider`) |

**Surface adapter model** (`src/surfaces/<id>.js`), each declaring:
```
{ id, kind: 'cli'|'ide'|'desktop'|'chat'|'extension',
  switchClass: 'A'|'B'|'C'|'D'|'E',
  accountUnit: 'github'|'google'|'bytedance'|'vendor'|'apikey'|...,
  credStore: 'keychain'|'file'|'sqlite'|'dpapi'|'oauth-token'|'cookie',
  path(ctx), read(ctx), swap(ctx, account), hotReload: bool, notes }
```

Work items (all framed as *switch multiple accounts of X*):
- **E1.1** Surface registry + adapter interface; migrate existing Claude Code +
  Claude‑desktop logic onto it (no behavior change). They become Class B/C rows.
- **E1.2** Class‑A CLI adapters (highest ROI, lowest effort — pure file swap):
  **Codex**, **Gemini CLI**, **Copilot CLI**, **opencode**, **Aider**, **Crush**,
  **Plandex**, **OpenHands**. Each = "hold & rotate multiple logins of this CLI."
- **E1.3** Class‑B (keychain) adapters: **Zed**, **Goose**, **Amazon Q** (AWS SSO
  cache). Reuse the Claude‑macOS keychain code.
- **E1.4** Class‑D vendor‑account rotation for the bundled IDEs (**Trae, Qoder,
  Antigravity, Kiro, Copilot**): the switch swaps the editor's stored login so a
  fresh account = a fresh free‑tier bucket. Scope read‑only first; verify a
  round‑trip before writing another app's store.
- **E1.5** `keyflip surfaces` — list every detected surface, which account each is
  on, remaining quota per account (so you can see when to rotate), health.
- **E1.6** Cross‑surface switch: `keyflip use <account> --surfaces codex,gemini`
  moves several surfaces to one identity at once; `keyflip next --surface trae`
  rotates just that surface to its next‑freshest account.
- **E1.7** Generalize `run` isolation (today `CLAUDE_CONFIG_DIR`) to per‑surface
  env‑var isolation, so one terminal can be pinned to one account of one surface
  while everything else stays put.

**Reality check:** Class C/D touch OS‑specific stores (Keychain, DPAPI, libsecret)
or cloud sessions. Staged approach as with Claude: switch where the format is open,
mark the rest "detected but manual," never write another app's secret store without
a verified round‑trip. Class D also raises ToS questions per vendor (multi‑account
free‑tier farming may violate a tool's terms) — surface that, same as §5.

---

### E2 — Subscription ⇄ API‑key bridge ("keyflip serve" / the *copilot api* project)

**Goal (the "very big" feature):** expose a **single local API key** from keyflip;
requests to it get **fulfilled out of a subscription's quota** — e.g. a GitHub
Copilot, ChatGPT, or Claude Max plan — instead of a metered API key. keyflip hands
out an OpenAI/Anthropic‑compatible endpoint; behind it, it spends whichever
*subscription* has headroom.

**Precedent (proves it's feasible):** [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api)
turns a GitHub Copilot subscription into an OpenAI **and** Anthropic‑compatible
server ("usable with Claude Code"): GitHub OAuth device‑flow token persisted to
`~/.local/share/copilot-api/github_token`, a short‑lived Copilot token
auto‑refreshed before expiry, endpoints `/v1/chat/completions` + `/v1/messages`
+ `/v1/models`, Individual/Business/Enterprise plans, and a **`GET /usage`**
quota endpoint. [caozhiyuan/copilot-api](https://github.com/caozhiyuan/copilot-api)
adds `/v1/responses` + third‑party providers. This is exactly the shape of the
user's "copilot api" project — E2 brings that capability *inside* keyflip.

> **⚠️ Load‑bearing compliance finding (verified mid‑2026):** the bridge target
> matters. **Copilot** bridges work by reverse‑engineering GitHub's internal
> endpoint — a gray area, "not GitHub‑supported," with account‑suspension risk on
> abuse, but functional. **Claude Pro/Max is different: Anthropic actively
> BLOCKS third‑party‑harness use of subscription OAuth as of 2026‑04‑04**
> (OpenClaw/OpenCode/NanoClaw were cut off; it's an enforced ToS violation, not
> just a gray area). **So E2 does NOT build a Claude‑subscription backend** — for
> Claude, keyflip uses only real API keys / Bedrock / Vertex. ChatGPT bridging
> sits between (exists, ToS‑risky, less aggressively enforced than Anthropic).

Architecture (reuses the E3/proxy machinery — command‑activated, localhost‑only):
- **E2.1 Bridge core:** `keyflip serve --wire` starts a local OpenAI/Anthropic‑
  compatible endpoint (same detached‑process + `/__keyflip_ping` identity model as
  the proxy). Emits a local key; nothing leaves 127.0.0.1 unless explicitly bound.
- **E2.2 Copilot backend (primary):** translate the emitted API contract ⇄ the
  Copilot backend, using the Copilot token captured by the E1 Copilot adapter;
  poll its `/usage` so keyflip's usage history and breaker treat it like any
  account. This is the flagship E2 backend.
- **E2.3 Other backends — scoped by compliance:** ChatGPT (Codex backend, ToS‑risky
  opt‑in); **NOT Claude subscription (blocked — see finding above)**; plus the
  *reverse* — front a real API key behind the local endpoint so a tool that only
  speaks one dialect can reach any provider (fully compliant, ship freely).
- **E2.4 Pool bridging:** combine E2 with E3 so one emitted key round‑robins /
  fails over across *several* eligible subscriptions (Copilot + ChatGPT) + API
  keys, each spent to its cap — "all memberships behind one API key."
- **E2.5 Accounting & guardrails:** per‑subscription token/quota accounting, a
  hard stop before a plan's cap, and clear ToS labeling (§5).

**Risk:** the item most in tension with provider ToS (§5). Ship opt‑in,
self‑host‑only, off by default, with a printed warning naming the specific
provider's stance on first `serve`.

---

### E3 — Embedded model router + fusion (9router / OpenFugu / OpenRouter‑Fusion class)

**Goal:** the user declares **one API key and one model** to their tool; keyflip
does all model management behind it — tiered fallback, rule routing, and
optionally *fusion/orchestration* across many models. Command‑activated, no daemon.

This is the natural growth of the existing failover proxy (`src/proxy.js`) plus
Phase‑0c. Build it as escalating **router modes**, cheapest/simplest first:

- **E3.0 Substrate** = Phase‑0c (routes.json + hot‑reload + rule engine + token
  estimator + transformers + sticky + custom hook). Everything below rides on it.
- **E3.1 Tiered fallback (9router‑style).** Ordered tiers: Tier‑1 subscription
  (Claude Max / Copilot via E2) → Tier‑2 cheap (GLM/MiniMax/DeepSeek) → Tier‑3
  free/local (Ollama, free provider keys). On limit/failure, drop a tier. Mirrors
  [decolua/9router](https://github.com/decolua/9router)'s model. *(Note: 9router
  advertises "RTK −40% tokens" — it already uses the user's own RTK compressor;
  keyflip's router can integrate RTK the same way as an optional pre‑pass.)*
- **E3.2 Rule routing.** Route by request shape: long‑context → a big‑context
  model, cheap/short → a small model, code vs prose, tool‑use, etc. (Phase‑0 #5.)
- **E3.3 Fusion mode (OpenRouter‑Fusion‑style).** Optional: fan the prompt to a
  **panel** of models in parallel, a judge synthesizes (consensus / contradictions
  / blind spots) into one answer. ~4–5× cost — strictly opt‑in per route, for
  high‑stakes prompts. Ref: [OpenRouter Fusion](https://openrouter.ai/docs/guides/features/plugins/fusion).
- **E3.4 Orchestrator mode (Fugu / OpenFugu‑style).** The most advanced: a
  coordinator decides **up front** which models to call and in what order, then
  combines — closer to [Sakana Fugu](https://sakana.ai/fugu) /
  [OpenFugu](https://github.com/trotsky1997/OpenFugu) than to Fusion's
  parallel‑then‑synthesize. Longer‑horizon; likely pluggable (bring‑your‑own
  orchestrator via the E3.0 custom hook) rather than a trained model we ship.
- **E3.5 `keyflip route`** front‑end: `keyflip route start --mode tier|rule|fusion|orchestrate`,
  `keyflip route explain` (dry‑run a request and print the decision), plus the
  debug headers from Phase‑0 #10.

**Distinction to keep straight** (informs which mode to reach for):
Fusion = ask several **in parallel**, then synthesize. Fugu = decide **up front**,
call in sequence, then combine. Tiered = one at a time, fall down the ladder on
failure. keyflip should offer all three under one `--mode` flag.

---

### E4 — Centralized settings & run‑mode manager

**Goal:** one place for every decision, including **how each surface comes up** —
in‑app, service mode, or command‑activated — so the scattered flags become a
single, inspectable configuration.

- **E4.1 One settings store:** `<configDir>/keyflip.config.json` (schema‑versioned,
  the same corruption‑safe read/write as everything else — `readJsonForWrite`,
  atomic + rollback). Absorbs today's scattered options (proxy defaults, breaker
  TTLs, autoswitch threshold, provider prefs, sync target…).
- **E4.2 Run‑mode per capability:** for the proxy, router (E3), and bridge (E2),
  declare a `runMode`: `command` (default — start/stop by hand), `wired`
  (auto‑wire the active tool when started), or `service` (opt‑in, user‑managed
  background start — still never a hidden daemon; the user installs it knowingly,
  e.g. a launchd/systemd unit keyflip can *generate* but not silently enable).
- **E4.3 Per‑surface policy:** which account each surface defaults to, whether a
  switch also restarts that surface, hot‑reload vs restart behavior (E1 metadata).
- **E4.4 `keyflip config`:** get/set/edit/validate/reset, `--json` for scripts,
  and a TUI editor (E5). Import/export a profile (no secrets) — reuses `share`.
- **E4.5 Precedence + doctor:** documented precedence (env > flag > config >
  default) and `keyflip doctor` validates the config and every declared run‑mode.

---

### E5 — TUI layer (present every screen properly)

**Goal:** all interactive screens (menu, account list, usage dashboard, provider
picker, route explainer, config editor) rendered through a proper terminal UI —
much nicer than today's line printing — **without breaking the zero‑dependency
rule**.

Recommendation (see §3.7): build a **small self‑contained ANSI/TUI helper module**
(`src/tui/`) on Node stdlib — alternate screen buffer (`\x1b[?1049h`), raw‑mode key
handling via `readline`, a tiny box/table/list/live‑update toolkit — rather than
adopting a heavy dependency (blessed is effectively unmaintained; Ink pulls in
React + a large tree). This keeps keyflip installable as a single dependency‑free
package while delivering a big visual upgrade. Reuse the existing `src/style.js`
color helper.

- **E5.1** ANSI core: alt‑screen, cursor, raw keys, resize (`SIGWINCH`), Windows
  terminal quirks, graceful fallback to plain mode when not a TTY / `NO_COLOR`.
- **E5.2** Widgets: selectable list/menu, table, key‑value panel, progress/spinner,
  live‑refresh region (`log-update`‑style, home‑grown).
- **E5.3** Screens: main menu (`menu.js` upgrade), `list --usage` dashboard,
  provider/catalog picker (Phase‑0 #17), `route explain`, `config` editor (E4.4).
- **E5.4** Everything degrades: every TUI screen has a `--json` / plain‑text twin
  so scripts and MCP are unaffected.

---

## 3. Reference catalogs

Comprehensive lists of the surfaces, plans, tools and extensions keyflip aims to
cover. **Snapshot, mid‑2026 — verify before building.** Items marked ⚠️ are ones I
could not fully verify and should be re‑checked.

### 3.1 AI IDEs / editors

Last column = **the account‑switching angle** (switch class from E1 + what rotating
multiple accounts buys). That is why each tool is here — not its feature set.

| Product | Vendor | Auth model | Free/capped tier | **keyflip account‑switch angle** |
|---|---|---|---|---|
| **Cursor** | Anysphere | Cursor login **or** BYO key | Free tier; Pro $20 | **A** — swap `~/.cursor/` session (SQLite, plaintext); rotate logins → N× free/fast‑request quota |
| **Windsurf → Devin Desktop** | Cognition | Account login (no BYO key) | Free tier | **C ⚠️** — cred path undocumented; rotate accounts for free credits (verify first). Rebranded 2026‑06‑02 |
| **Google Antigravity** | Google | Google account | **20 req/day** (cut from 250) | **D** — swap Google login → **N× the 20/day**; highest‑value rotation target |
| **AWS Kiro** | Amazon | GitHub/Google/AWS ID | 50 credits/mo | **D** — rotate login → N× 50 cr/mo |
| **Qoder** | Alibaba | Email/Google/GitHub; BYOK (Community) | Community free | **D** (or **E** if Community BYOK) — rotate accounts → N× free; BYOK path = provider profile |
| **Trae** | ByteDance | ByteDance account (bundled keys) | **Free 5k completions/mo** | **D** — swap ByteDance login → **N× 5k**; ⚠️ heavy telemetry + multi‑acct ToS |
| **Zed** | Zed Industries | BYO key **or** Claude Code (ACP) | Free; Pro $10 | **B/E** — OS‑keychain swap; mostly BYOK → provider profile |
| **GitHub Copilot** (VS Code/JetBrains) | GitHub/MS | GitHub login | Free 2k completions/mo | **D+B** — swap GitHub login → N× free/plan credits; **also E2 bridge** |
| **JetBrains AI + Junie** | JetBrains | JetBrains account; local/BYOK | AI Free 3 cr | **C** — swap JetBrains login → N× credits; BYOK path too |
| **Replit (Agent)** | Replit | Replit account | credit‑based | **C**, lower priority |
| **Cline / Kilo Code / Void / PearAI / Aide** | various OSS | **BYO key** | Free (BYO) | **E** — the "account" is the API key → already **provider profiles** (shipped) |
| ~~**Roo Code**~~ | RooCodeInc | — | — | **dropped** — shut down 2026‑05‑15 (→ Cline/Kilo) |
| ~~**Continue.dev**~~ | acq. Cursor | BYO/hosted | — | **reference only** — winding down (cloud data deleted 2026‑07‑15) |
| **Augment / Tabnine / Cody** | resp. | Account / SSO | mostly **no free tier** | **C**, lower priority — paid‑only ⇒ little rotation value |
| **Amazon Q Developer** | Amazon | AWS Builder ID | Free / Pro $19 | **B** — swap AWS SSO cache (`~/.aws/sso/cache/`) |
| **Bolt.new / v0 / Lovable** | resp. | Account (credits) | Free credits | **C/D** — rotate for free credits; web surface, low priority |

### 3.2 AI CLIs / terminal agents  *(credential paths matter for E1)*

| Tool | Vendor | Install | Auth | **Credential location** | Plans |
|---|---|---|---|---|---|
| **Claude Code** ✅ | Anthropic | `npm i -g @anthropic-ai/claude-code` | Claude.ai OAuth (Pro/Max/Team/Ent) **or** API key | **macOS Keychain** svc `Claude Code-credentials`; Linux/Win `~/.claude/.credentials.json` (0600); honors `CLAUDE_CONFIG_DIR` | Pro ~$17–20 / Max $100 / Max20 $200 / Console API |
| **Codex CLI** ✅ | OpenAI | `npm i -g @openai/codex` / brew / curl | ChatGPT OAuth (Plus/Pro/Business/Edu/Ent) **or** API key | **`~/.codex/auth.json`** (plaintext by default); `cli_auth_credentials_store=keyring` opts into OS store; `$CODEX_HOME` overrides | Included in ChatGPT paid plans, or API rates |
| **Gemini CLI** ✅ | Google | `npm i -g @google/gemini-cli` | OAuth browser login **or** `GEMINI_API_KEY` | **`~/.gemini/settings.json`**; key via env or `~/.env` | Free tier (→ "Antigravity CLI" after 2026‑06‑18 ⚠️) / API |
| **GitHub Copilot CLI** ✅ | GitHub | `npm i -g @github/copilot` | OAuth device flow | **`~/.copilot/config.json`** (keychain default, plaintext fallback); `COPILOT_HOME` overrides | Copilot plans (see 3.1) |
| **opencode** ✅ | SST | `npm i -g opencode-ai` / brew | `opencode auth login`; BYO keys | **`~/.local/share/opencode/auth.json`** (dedicated encrypted store) | Free (BYO) |
| **Aider** ✅ | open source | `pip`/`uv` | Provider API keys (env) | **plaintext `.aider.conf.yml`** (home/repo) or env vars — no encrypted store ⚠️ | Free (BYO) |
| **Amazon Q CLI** ✅ | Amazon | brew/download; `q login` | AWS Builder ID / IAM Identity Center | **`~/.aws/sso/cache/`** (tokens), `~/.aws/config` | Free / Pro (IAM IC SSO) |
| **Crush** ✅ | Charm | brew/go | BYO keys or `crush login` OAuth2 | **`~/.config/crush/crush.json`** (`CRUSH_GLOBAL_CONFIG` overrides) | Free (BYO) |
| **Goose** ✅ | Block | binary | BYO keys / OAuth | OS keychain **or** `~/.config/goose/secrets.yaml`; config `~/.config/goose/config.yaml` | Free (Apache‑2.0; Linux Foundation) |
| **Warp** ✅ | Warp | app | Warp account + BYO keys | `~/.warp/` (macOS `settings.toml`); Linux `~/.config/warp-terminal/` | Free 75cr / Build $20 / Max $200 / Business $50 |
| **OpenHands** ✅ | OpenHands | pip/docker | BYO keys + GitHub OAuth | **`~/.openhands/`** (`OH_PERSISTENCE_DIR`), FileSecretsStore | Free/OSS (self‑host) |
| **Plandex** ✅ | Plandex | binary | BYO keys | **`~/.plandex/`**; cloud service sunset 2026 | Free/OSS |
| **Codebuff** ✅ | CodebuffAI | npm | GitHub OAuth | `~/.codebuff/` ⚠️ (unverified) | Free (FreeBuff) + paid ⚠️ |

✅ = verified this pass. ⚠️ = re‑verify path/plan before building an adapter.
**Account‑switch angle (why these are here):** almost every CLI stores a plaintext
JSON/YAML token under `~/.config/<tool>` or `~/.<tool>` → **Class A**, a trivial
file swap, so keyflip can *hold and rotate multiple logins per CLI* exactly like it
does for Claude Code — N accounts = N× quota / rate‑limit headroom. Only Claude Code
(Keychain), Zed/Goose (OS keychain), Copilot CLI (keychain‑default) are **Class B**
(OS‑store handling, already solved for Claude on macOS). BYO‑key CLIs (Aider, Cline)
are **Class E** → provider profiles, already shipped.

### 3.3 Consumer chat / assistant apps  *(subscription surfaces; some are E2 bridge targets)*

| App | Vendor | Tiers (rough $/mo) |
|---|---|---|
| **ChatGPT** | OpenAI | Free / Plus $20 / Pro $200 (20× quota, Sora) / Team / Enterprise |
| **Claude.ai** | Anthropic | Free / Pro $20 / Max 5× $100 / Max 20× $200 / Team / Enterprise |
| **Gemini app** | Google | Free / AI Pro $19.99 / AI Ultra $250 |
| **Microsoft Copilot** | Microsoft | Free / Copilot Pro $20 / M365 Copilot (business) |
| **Perplexity** | Perplexity | Free / Pro $20 / Max $200 / Edu $4.99 |
| **Grok** | xAI | Free / SuperGrok $30 / Heavy $300 |
| **Mistral Le Chat** | Mistral | Free (mostly API/enterprise; thin consumer tier ⚠️) |
| **DeepSeek** | DeepSeek | Free chat only (+5M free API tokens; no paid consumer tier) |

**Account‑switch angle:** these are all **Class C** — the login is a server‑side
session + cookie (the exact surface keyflip's existing Chat/desktop switching
already touches for Claude.ai). Rotating multiple chat accounts → more message
quota (ChatGPT 160/3h, Claude 5h/7d windows, etc.). Same play, but Class C is the
**fragile** tier: cookies expire, re‑auth may be interactive, and ⚠️ several of
these (esp. Claude.ai) forbid automated multi‑account use — see §5. Ship read/switch
where a captured cookie round‑trips; never scrape or bypass a login wall.

### 3.4 Providers & token plans (API)

| Provider | Model families | Notes |
|---|---|---|
| **Anthropic API** | Claude Opus / Sonnet / Haiku | per‑MTok in/out; cache tiers; 200k tier |
| **OpenAI API** | GPT‑5.x, o‑series | usage‑based |
| **Google Gemini API** | Gemini (AI Studio + Vertex) | free tier + paid |
| **xAI Grok API** | Grok | usage‑based |
| **Mistral / DeepSeek / Groq / Together / Fireworks** | open + own | cheap/fast tiers — good E3 Tier‑2 |
| **OpenRouter** | 300+ models aggregated | **credit/prepaid**; Auto Router + **Fusion** (E3.3) |
| **Amazon Bedrock / Azure OpenAI** | multi | cloud‑billed; Claude Code supports natively |
| **China: Z.AI/GLM, Moonshot/Kimi, MiniMax, Qwen, Volcengine** | own | very cheap — prime E3 Tier‑2/catalog (Phase‑0 #1) |
| **Local: Ollama / LM Studio / llama.cpp** | open weights | free — E3 Tier‑3 |

> **Verified cheap Tier‑2 anchors (mid‑2026, per‑1M in/out — re‑verify, volatile):**
> DeepSeek V4 Flash **$0.14/$0.28** (cache‑hit input ~$0.003), Mistral Small 4
> **$0.15/$0.60**, Groq Llama‑3.1‑8B **$0.05/$0.08**, Together Llama‑3.3‑70B
> **~$1.04** flat. Near‑universal levers: **batch −50%**, **cached‑input −50%**.
> Frontier refs: GPT‑5.5 $5/$30, Claude Fable 5 $10/$50, Claude Opus $5/$25.
> **OpenRouter passes provider price through with no markup** (revenue = ~5.5%
> credit top‑up fee; BYOK = first ~1M req/mo free then 5%). These figures should
> feed Phase‑0 #18's self‑updating pricing table, not be hard‑coded.

> **Verified base URLs for the Phase‑0 #1 catalog (OpenAI/Anthropic‑compatible):**
> Anthropic `https://api.anthropic.com/v1` · OpenAI `https://api.openai.com/v1` ·
> Gemini `https://ai.google.dev` · xAI `https://api.x.ai/v1` · **GLM/Zhipu**
> `https://open.bigmodel.cn` (CN) / Z.AI (intl) · **Kimi/Moonshot**
> `https://api.moonshot.ai` · **MiniMax** `https://api.minimax.io` (intl) /
> `api.minimaxi.com` (CN) · **Qwen/Alibaba** `https://dashscope.aliyuncs.com`
> (CN) / `dashscope-intl.aliyuncs.com` · **Ollama** `http://localhost:11434/v1`
> · **LM Studio** `http://localhost:1234/v1` · **llama.cpp**
> `http://localhost:8080/v1`. ⚠️ China per‑model prices vary — resolve via a
> gateway or the provider directly.

### 3.5 Routers / gateways / fusion (prior art for E3)

| Project | What it is | Lesson for keyflip |
|---|---|---|
| **[9router](https://github.com/decolua/9router)** (19k★, JS) | 3‑tier fallback sub→cheap(GLM ~$0.6)→free(Kiro/Vertex); real‑time cross‑account quota; **RTK losslessly filters git‑diff/grep/ls/tree output** before send (−20–40% input) | E3.1 model; **RTK pre‑pass on tool output** |
| **[OmniRoute](https://github.com/diegosouzapw/OmniRoute)** / n9router | 9router forks, 231+ providers, TS rewrite of CLIProxyAPI | breadth of provider coverage |
| **claude‑code‑router** (musistudio) | routes.json + rule engine + **20+ transformers** normalizing provider dialects (field maps, tool‑call formats, streaming events) | E3.0 substrate + **E3.7 transformer pattern** |
| **LiteLLM proxy** | 140+ providers; **cooldown + order‑based deployment retry** (failed deployment pauses, retried at order+1) | E2 endpoint shape; **retry/cooldown logic (#11)**; pricing (#18) |
| **RouteLLM** (lmsys) | learned router: **95% GPT‑4 quality at 14% strong‑model calls** (~75% cost cut) — but needs training data | E3.2 idea; ⚠️ high setup cost |
| **OpenRouter Auto / [Fusion](https://openrouter.ai/docs/guides/features/plugins/fusion)** | parallel panel + judge synthesis (~4–5×) | **E3.3** |
| **[Sakana Fugu](https://sakana.ai/fugu)** / **[OpenFugu](https://github.com/trotsky1997/OpenFugu)** | orchestrator that decides up‑front which models to call in sequence | **E3.4** |
| **Portkey** (Apache‑2.0, 1600+ models) | **semantic (embedding) cache −30–50%**, 50+ guardrails, MCP gateway | **semantic cache** idea; observability + headers (#10) |

### 3.6 Subscription → API bridges (prior art for E2)

| Project | Bridges | Notes |
|---|---|---|
| **[ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api)** | Copilot → OpenAI **+ Anthropic** | GitHub OAuth device‑flow → token at `~/.local/share/copilot-api/github_token`; Copilot token auto‑refreshed; `/v1/chat/completions`+`/v1/messages`+`/v1/models`; **`GET /usage`** quota — closest emsal to "copilot api" ✅ |
| **[caozhiyuan/copilot-api](https://github.com/caozhiyuan/copilot-api)** | Copilot / Codex / 3rd‑party → OpenAI+Anthropic | adds `/v1/responses`; day/week/month usage dashboard; Node ≥22.13 |
| **yuchanns/copilot-openai-api** | Copilot chat/embeddings → OpenAI (FastAPI) | Python reference |
| **Copilot API Gateway** (VS Code ext) | Copilot → OpenAI/Anthropic/Gemini local HTTP | in‑editor variant |
| ChatGPT reverse proxies (raine/claude-code-proxy etc.) | ChatGPT/Kimi subscription → Anthropic‑compat | ToS‑risky; reference only |
| ~~Claude Pro/Max reverse proxies~~ | ~~subscription → API~~ | **❌ blocked & enforced by Anthropic since 2026‑04‑04 — do NOT build (§5)** |

### 3.7 TUI options (for E5)

| Option | Deps | Maintained (2026) | Fit | Verdict |
|---|---|---|---|---|
| **Raw ANSI + `node:readline` raw mode + alt‑screen** (home‑grown) | **0** | stdlib | single‑pane menus/tables/dashboards/progress | ✅ **recommended** — keeps zero‑dep promise |
| ansi‑escapes + log‑update (+readline) | **0 hard deps**, ~5–10 KB | active (log‑update updated ~weekly) | same, less hand‑rolling | ✅ acceptable fallback if hand‑rolling ANSI is too much |
| ~~blessed~~ → **neo‑blessed** | ~1 dep, ~50 KB | blessed **unmaintained**; neo‑blessed active | full‑screen widgets + mouse | ✗ only if we ever need mouse widgets |
| Ink (React for CLIs) | React + large tree | active | stateful multi‑screen | ✗ breaks zero‑dep |
| terminal‑kit | medium | active | curses‑like | ✗ dep weight |
| @clack/prompts / enquirer | small | active | prompts only, not full‑screen | maybe for one‑off prompts |

**Decision:** home‑grown `src/tui/` on stdlib (§E5), reusing `src/style.js`.
**Keyboard‑only by design — so mouse is a non‑issue.** keyflip's UI is menus,
lists and dashboards driven by arrow keys / Enter / hotkeys; we deliberately do
**not** want mouse. That sidesteps Node's Windows‑tty mouse limitation entirely
(one less thing to handle) and means we never need a mouse‑capable lib like
neo‑blessed. Real gotchas that remain: `process.stdout.on('resize')` lags a bit on
Windows, and always fall back to plain mode when `!process.stdout.isTTY` or
`NO_COLOR`.

---

## 4. Suggested sequencing

Rough milestone mapping (subject to change):

| Milestone | Content |
|---|---|
| **v1.6** | Phase 0a + 0b (quick wins + **provider catalog** #1/#17/#16) |
| **v1.7** | Phase 0c + 0d → **E3.0–E3.2** (routes.json, rule router, tiered fallback) |
| **v1.8** | **E1.1–E1.4** (surface registry + core CLI adapters) |
| **v1.9** | **E2.1–E2.3** (bridge core + Copilot/ChatGPT/Claude backends) |
| **v2.0** | **E4** (central settings + run‑mode) + **E5** (TUI) — the "one control plane" release |
| **later** | E3.3 fusion, E3.4 orchestrator, E2.4 pool bridging, more E1 IDE adapters |

Prereq order that matters: Phase‑0c (#4/#5) → E3 → E2.4; E1 Copilot adapter → E2.2;
E4 settings store should land before E5 so the TUI edits a real config.

---

## 5. Compliance & safety rails

- **E2 (subscription bridging) has provider‑specific ToS status — not one blanket
  rule:**
  - **Claude Pro/Max → prohibited & actively enforced.** Anthropic blocks
    third‑party‑harness use of subscription OAuth as of **2026‑04‑04** (OpenClaw /
    OpenCode / NanoClaw were cut off). keyflip will **not** build a Claude
    subscription backend; Claude routes only through real API keys / Bedrock /
    Vertex.
  - **GitHub Copilot → gray area, functional.** Reverse‑engineers an internal
    endpoint; "not GitHub‑supported"; account‑suspension risk on abuse. Shipped
    opt‑in with a warning.
  - **ChatGPT → gray area, less aggressively enforced than Anthropic.** Opt‑in,
    warned.
  keyflip ships E2 **opt‑in, off by default, self‑host/localhost‑only**, prints a
  one‑time warning **naming the specific provider's stance**, and never markets it
  as a way to resell or evade limits. Personal‑use convenience; the user owns the
  compliance decision.
- **Secrets:** every new capability inherits the existing rules — OS credential
  store only, never argv, `--key-file`/stdin, no secret through MCP, nothing in
  the repo, nothing in logs.
- **Command‑activated:** proxy, router (E3), and bridge (E2) are all started/stopped
  explicitly. E4's "service" run‑mode only ever *generates* a unit file the user
  installs knowingly — keyflip never enables a hidden background daemon.
- **No destructive defaults:** switching, deleting, logging out, unpublishing —
  all require explicit consent, always.
- **Docs stay in lockstep:** any shipped item updates README.md + README.tr.md +
  SKILL.md + MCP setup text together.

---

## E6 — Onboarding & surface-sync hardening (the 8 gaps)

Captured from live onboarding. All needed; phased because several need
Windows/enterprise devices to validate.

| # | Gap | Plan | Effort |
|---|---|---|---|
| **1 ✅ DONE** | **Browser sync on SWITCH.** `keyflip <name>` aligned CLI (+desktop) but left the browser/extension on the old account → "user mismatch". | Shipped: `snapshotClaudeCookies`/`restoreClaudeCookies` (sqlite `.mode insert`, encrypted bytes verbatim → works for app-bound v20). Sessions captured at onboard/login into `<cfg>/browser-sessions/<name>__<browser>.sql`; restored by `keyflip <name> --browser` (quit → replay → reopen, DB backup + closed-browser guard) or `keyflip browser sync [name]`. Non-`--browser` switch still just warns (now with the auto-sync hint). | high (fragile: cookie write, app-bound v20) |
| **2 ◑ WIRED** | **Windows / Linux onboard.** Browser+desktop steps are macOS-only. | Full port map written: **[docs/PORTING.md](docs/PORTING.md)**. **Windows crypto SHIPPED + WIRED (2026-07-07):** `src/wincrypt.js` (DPAPI master-key via PowerShell `ProtectedData.Unprotect` + `v10/v11` AES-256-GCM, fixture-tested) is now wired into `appauth.detectAppAccount` via a **win32 branch** (`decryptAppBlobWin`/`isEncBlob`) — reads `<appDataDir>/Local State` → `masterKey` → `decryptValue`; macOS Keychain path byte-identical; end-to-end fixture test with injected DPAPI. Switching/providers/migrate/etc already cross-platform; the file credential store already works everywhere. **Remaining (device-gated): confirm exact Windows Local State + token-cache paths on a real install; Linux libsecret cookie path.** | high (needs devices) |
| **3 ✅ DONE** | **`consolidate` needs the app closed.** Chats didn't sync while Claude Desktop was open. | Shipped `keyflip consolidate`: a one-shot offers to close→sync→reopen the app (TTY/`-y`), else defers with a clear message. | medium |
| **4 ✅ DONE** | **Sync isn't continuous.** New chats under B didn't appear under A until re-consolidated. | Shipped: every switch re-consolidates (incl. `--force`, deferring if the app is open); `keyflip consolidate --watch [--interval N]` re-syncs on an interval whenever the app is closed. | medium |
| **5 ✅ DONE** | **Desktop account "unknown".** captureApp failed when the app's account couldn't be identified. | `detectAppAccount` now ALWAYS returns `{org,account,email,reason}` and FALLS BACK to the config's allowlist org when the token can't be decrypted (no cache / keychain locked / decrypt-fail), recovers the account by org→folder match, and searches email in both per-account stores. `status`/`list` show the recovered email (or `<org>… (unsaved)`) instead of "unknown", and mark unsaved accounts in `--json` (`saved:false`). `add --app` prints a `reason`-specific hint (unlock keychain / open the app / not set up). Detection runs once per view (no double Keychain prompt). +6 tests. | medium |
| **6 ✅ DONE** | **Provider (API-key) accounts in onboard.** onboard only did OAuth subs. | The per-account prompt now offers `p` → inline provider capture (name → base URL → bearer/api-key → HIDDEN key via a reused readline → optional `keyflip use`). Key never on argv. Done-condition + summary count providers. `onboardProvider` extracted + unit-tested (5 tests: api-key, keyless bearer, bad URL, empty name, duplicate). | low |
| **7 ◑ WIRED** | **Enterprise / SSO + 2FA sign-in.** `--sso` existed on `login` but not onboard, and is untested end-to-end. | `login` already forwards `--sso`/`--console` to `claude auth login`; now `keyflip onboard [--sso] [--console]` does too (applies to every OAuth sign-in in the run). The org-picker/2FA is handled by `claude auth login` itself via `stdio:'inherit'`. Documented (help + SKILL + README EN/TR) + argv wiring locked by a unit test (`login.buildLoginArgs`). Validation checklist: **[docs/ENTERPRISE-SSO.md](docs/ENTERPRISE-SSO.md)**. **Remaining: live end-to-end validation on a real SSO org (device-gated).** | medium (needs an SSO org) |
| **8 ✅ DONE** | **macOS desktop↔CLI `~/.claude` tug-of-war.** The running desktop app can rewrite the CLI credential after an in-place switch. | New `platform.isDesktopAppRunning()` (app-only, distinct from the CLI). A `--force` swap now calls `desktopTugRisk(ctx, name)` and WARNS when the desktop app is running on a different account (points to `--restart`, which moves the app too). Pure risk helper + 5 tests; documented (SKILL + README EN/TR). | medium |
| **9 ✅ DONE** | **Move to a NEW machine with everything — and MERGE, not overwrite.** Today `export`/`import` moves accounts (secrets) but not transcripts/sessions; desktop logins must be re-captured; and import replaces rather than merges. The user wants: carry ALL accounts + ALL sessions/chats to the target machine, and on arrival **merge** them with whatever sessions already live there. | A single portable bundle: `keyflip migrate export <file>` = accounts (secrets, gpg-able) + `~/.claude/projects` transcripts + Cowork sessions + browser-session snapshots + provider/config metadata, with a manifest. `keyflip migrate import <file> [--merge]` = **union** by sessionId (never clobber a transcript that already exists; dedupe pointers via the existing consolidate logic), add-or-skip accounts (only overwrite with `--force`), re-run `consolidate` so every account sees the combined set. Desktop logins re-captured on the target (documented). Reuses `share`/`export` secret-handling + `appsessions.consolidate` for the merge. | high |

| **10 ✅ DONE** | **LIVE device-to-device transfer.** #9 moves a FILE by hand. The user also wants to pull accounts + chats **directly from the other computer** — "migrate from machine B" without manually copying a bundle. | Reuse the #9 bundle as the payload, add a transport: (a) **`keyflip transfer serve`** on the source = a short-lived, one-time-code + passphrase-gated localhost/LAN endpoint that streams `migrate.buildBundle`; **`keyflip transfer pull <host> --code`** on the target decrypts + `applyBundle` (merge). (b) Zero-config discovery on the LAN (mDNS/Bonjour) so `pull` finds the peer. (c) Or lean on the existing `sync push/pull` (WebDAV) as the "cloud relay" path — already encrypted; just document it as the no-LAN option. Security: ephemeral pairing code, passphrase-derived key (reuse `sync.encrypt`), never expose secrets on argv, bind to loopback/LAN only, auto-expire the listener. **Decision (2026-07-03): build BOTH.** **(c) WebDAV cloud-relay — ✅ DONE:** `keyflip migrate push/pull --url <webdav> --passphrase-file <f>` moves the full encrypted bundle (accounts+providers+transcripts) through a WebDAV server; pull previews + merges. **(a) LAN-direct — ✅ DONE:** `keyflip transfer serve` shows an 8-char one-time code (40-bit base32) + streams the code-encrypted bundle over HTTP; single-shot, rate-limited (5 bad codes), auto-expires (TTL). `keyflip transfer pull [<host:port>] --code XXXX` auto-discovers the peer via a zero-dep UDP-multicast beacon (advertises host/port/fingerprint, never the code) then MERGES. Live two-process loopback round-trip verified. mDNS/Bonjour interop optional/later. | high |

Order: **#1 ✅** → **#9 ✅** (file carry + merge) → **#3/#4 ✅** (sync continuity)
→ **#10 ✅** (live device-to-device: LAN + WebDAV relay) → **#5 ✅** (desktop
detection) → **#6 ✅** (provider in onboard) → **#8 ✅** (desktop↔CLI tug-of-war) → **#7 ◑** (SSO wired; live validation device-gated)
→ **#2** (Windows/Linux onboard) — device-gated, last.

**Non-device-gated roadmap is COMPLETE.** Remaining work is blocked on hardware/an SSO
org: #7 live validation (an SSO org) and #2 (Windows + Linux machines for browser/desktop
capture + DPAPI/libsecret cookie decryption).

### Post-review hardening (2026-07-06, applied)

A max-effort multi-agent adversarial review of the #1/#3/#4/#9/#10 changes ran (7
review dimensions × 3-skeptic verification). Confirmed findings FIXED:

- **HIGH — flag-value mis-parsed as the positional file/host.** `migrate export/import`
  and `transfer pull` picked the first non-`--` token, so `--passphrase-file <f>` before
  the file could **overwrite the passphrase file**, and `transfer pull --code X` treated
  the code as the host (discovery never ran). Fixed with a shared `positionals()` that
  skips value-flags + their values.
- **HIGH — `migrate export` silently wrote an UNENCRYPTED secrets bundle** when
  `--passphrase-file` was unreadable. Now fails loudly.
- **HIGH — LAN discovery beacon crash.** The beacon dgram socket had no `'error'`
  listener → an async socket error crashed foreground `transfer serve`. Handler added
  (+ `req` error handler on the serve HTTP side).
- **HIGH — `/ping`+beacon leaked a code-derived fingerprint** (16 bits of the 40-bit
  code's keyspace). The display fingerprint is now a random per-serve nonce; `/ping` no
  longer leaks bundle counts.
- **MEDIUM — `consolidate --watch` died on the first transient error** (lock contention
  etc.); now try/caught per tick. **`browserSync` force-wrote a still-running browser's
  Cookies DB** (corruption) and reported success; now skips if the browser won't quit.
  **`migrate export -`** mixed human notes into the piped bundle on stdout; notes now go
  to stderr, and export/push/pull emit `--json`. **`migrate/transfer pull` held the
  mutation lock across the network fetch + confirm prompt**; now locks only the write.
  **A single invalid account aborted the whole `applyBundle`** (losing providers +
  transcripts); accounts now import resiliently.
- **LOW — cheap hardening:** `saveSession` chmods 0600 on a pre-existing file;
  `isSafeSegment` rejects `:` (Windows drive/ADS).

Deferred (lower-risk, tracked): 40-bit code offline-brute-force margin (mitigated by
removing the fp leak; could widen to 10 chars); `--code` on argv (single-use, short TTL);
`login`/`onboard` could stash a mismatched browser session under a new account (needs the
account-match signal threaded through capture). 308 tests green (0 fail).

### Post-review hardening — round 2 (#5 + #6, applied)

A second adversarial review (3 dims × 2 skeptics) of the #5/#6 changes surfaced 5 real
defects, all FIXED:

- **HIGH — provider API key echoed in cleartext.** The onboard readline was created
  without `terminal:true`, so `askHidden()`'s echo-mute never fired when stderr wasn't a
  TTY (`onboard 2>file`) — the key leaked. Fixed (`terminal:true`, matching `promptHidden`).
- **MEDIUM — stale-org mislabel (2 manifestations).** `detectAppAccount` used the
  most-recent allowlist org unconditionally: (a) on a successful decrypt it could
  confidently name a *different* stale account for a brand-new one — now the allowlist org
  is used only if the decrypted token corroborates it, else `reason:'unresolved-org'`; and
  (b) `captureApp` auto-paired on that fallback org and could snapshot the live account's
  tokens into the WRONG profile — now it auto-identifies ONLY from a confirmed decrypt
  (`!det.reason`), else requires an explicit name.
- **LOW — wrong remediation hint.** `fromConfigOnly` masked `keychain-locked`/`decrypt-failed`
  as `no-token-cache`; now preserves the real reason so the hint is right.
- **LOW — signed-out app shown as an account.** `signOutApp` leaves the allowlist keys, so
  the config-only fallback presented a signed-out app as `<org>… (unsaved)`; detection now
  trusts the allowlist org only when the Cookies DB actually has a live session.

320 tests green (0 fail); +2 appauth unit tests (signed-out, unresolved-org).

### Post-review hardening — round 3 (final pre-commit sweep, applied)

A final comprehensive review (4 dims × 2 skeptics) of the WHOLE changeset returned
**FIXES-RECOMMENDED** — integration-clean (all callers consume the new detect shape; SSO
wiring plumbed; dispatch/lock scopes correct), with 2 LOW findings, both FIXED:

- **LOW — spurious tug-of-war warning for a running-but-signed-OUT app.** `desktopTugRisk`
  used raw `detectActiveOrg` (stale allowlist org) without the cookie corroboration that
  `detectAppAccount` already applies → a `--force` after sign-out could warn even though the
  app can't rewrite anything. Now gated on `cookiesLookLoggedIn()` (still no Keychain access).
  +1 test.
- **LOW — bilingual docs drift.** `onboard --sso/--console` was in the code + help but not
  the READMEs; added to README.md + README.tr.md.

327 tests green (0 fail). Changeset cleared for commit.

### Post-review hardening — round 4 (FLEET control plane + Windows app-auth, applied 2026-07-07)

A max-effort adversarial review of the NEW fleet/app-auth batch (6 security dimensions ×
3-lens verification, 88 agents) returned **23 CONFIRMED findings** (≥2/3 lenses). Deduped to
7 root causes — all FIXED, each with a regression test (`test/fleet.test.js`, +10 tests → 533
total, 0 fail):

- **P0 — credential leak to display surfaces.** `readFleet` returns full statuses incl. `.creds`
  (raw OAuth blobs, present only with `--with-secrets` for the relay). Every DISPLAY path forwarded
  them: panel `/api/fleet`, MCP `keyflip_fleet_status`, `fleet status --json`. Fix: `fleet.sanitizeStatus()`
  (creds-free projection) applied at all three boundaries; `readFleet` keeps creds ONLY for the
  server-side relay (`accountFrom`/collect/send-account); panel defensively strips too.
- **P1 — path traversal via peer machineId.** `<id>.status.enc`/`<id>.inbox.enc` filenames were
  built from an unvalidated peer id. Fix: `safeId` (`^[A-Za-z0-9._-]{1,64}$`, no `..`) enforced in
  `statusName`/`inboxName`/`queue`; `bus` write/read/remove require a plain basename; `readFleet`
  drops any status with an unsafe id **and** binds the claimed id to the filename stem (anti-spoof).
- **P1 — DNS-rebinding on the loopback panels.** No `Host` check. Fix: `loopbackOk()` rejects any
  non-loopback `Host` header on both `serve` and `serveFleet`.
- **P2 — `save-account` could overwrite keyflip's own state** (`fleet.json` etc.). Fix: `profiles.isValidName`
  now rejects `RESERVED_FILES`, so an inbound account named `fleet`/`fleet-seen`/`fleet-applied` is refused.
- **P2 — no replay protection.** A captured inbox command could be re-injected. Fix: a bounded applied-id
  ledger (`fleet-applied.json`) + a 7-day freshness window (`wasApplied`/`markApplied`/`commandFresh`),
  enforced in the push drain loop.
- **P2/P3 — crashes + ANSI injection from hostile peer status.** Fix: `normalizeStatus` type-checks,
  control-char-strips, and length-caps every peer field; `newReplies` guards non-array/non-object;
  the `note` detail and the confirm prompt strip control chars; per-file (8 MB) and per-roster (500)
  read caps blunt a resource-exhaustion peer.

533 tests green (0 fail); 55 MCP tools, 0 confirm-invariant violations. Fleet batch cleared for commit.

**Verified NON-issues (review watch list):** (a) `foreign.resumeCommand` shell-injection — the
`--run` path uses `spawnSync(bin, args[])` (argv array, **no shell**); the id is a literal argv, and
`foreign.resumeCommand` isn't wired to any exec. (b) `isEncBlob` v10→v11 widening — macOS still
decrypts via `getSafeStoragePassword` (v10 CBC); a v11 blob on macOS just falls back to the allowlist
org. **Residual RESOLVED (2026-07-07) — per-machine origin authentication shipped.** The fleet trust
boundary was the shared passphrase alone. Now each machine owns an **Ed25519 signing key** (private
key 0600 in configDir, never in the shared folder, never argv); the public key is published in its
status. `fleet.queue` **signs** every command; a receiver **trust-on-first-use pins** each peer's key
(`fleet-known.json`) and `fleet.checkOrigin` REJECTS any command whose signature doesn't verify against
the pinned key — so even a leaked passphrase + folder write can't forge a command *from* a machine
whose private key the attacker lacks. A pinned key that later CHANGES is flagged as possible key
substitution and its commands rejected until `keyflip fleet trust <machine>` (consent-gated) re-pins
the new key. Enforced in the CLI push drain BEFORE the consent prompt, and re-checked in
`applyCommand` (defence in depth). +7 regression tests (forgery / tamper / unsigned / key-change /
re-trust / end-to-end). MCP: `keyflip_fleet_trust` (MUT + `confirm`). 540 tests, 0 fail; 56 MCP tools,
0 invariant violations. TOFU's inherent first-sight limitation (an attacker who publishes *before* you
ever saw the real machine gets pinned) is documented — after first legitimate sight, substitution is
detected.

**Origin-auth adversarial review (2026-07-07, 4 dims × 3-lens, 50 agents) — 1 real defect, FIXED.**
The review confirmed ONE bug (surfaced through all 4 lenses): the signed canonical form omitted the
**recipient**, so a genuine signature was replayable cross-inbox (an attacker with the passphrase
could copy A's command "switch → work", signed for B, into C's inbox and C would verify it as
authentic). FIX: `signable()` now includes `to`; `queue()` binds `cmd.to = target` before signing;
`checkOrigin(ctx, …)` and `applyCommand` reject unless `cmd.to === this machine's id` — so a signature
is valid only for the one inbox it was issued to. Also hardened from the watch list: TOFU roster is a
null-prototype map + `MAX_KNOWN` cap (anti-pollution/DoS), notes are ledgered (no verbatim replay),
and `fleet trust` prints the new key's SHA-256 fingerprint for out-of-band verification. +2 regression
tests (cross-inbox replay rejected; prototype-safety/fingerprint). 542 tests, 0 fail.

---

## E7 — Chat/session/memory lifecycle & cross-machine/-account/-service management

**Vision (from the user):** the hardest thing about Claude Desktop and agent apps is
managing chats across multiple machines and accounts. keyflip becomes the control plane —
carry, search, repair, archive, distill, and remotely steer sessions + memory across
machines and accounts (Claude first; other AI services later, all MCP-exposed). Chats are
valuable; as they age we want to store them elsewhere or keep their *insights* as keepsakes,
maybe via a scheduled/background "dreaming" pass.

Every item ships an MCP tool too (project rule).

### A — Session portability & repair
- **A1 ✅ DONE** — `keyflip sessions rebind <old> <new>`: re-link a project's chat history
  after its folder was renamed/moved (transcripts moved to the new encoded-cwd key + old
  cwd rewritten inside; macOS desktop-app session records patched; old copies backed up).
  From the "Chat history folder rename issue" session. 6 tests.
- **A2 ✅ DONE** — `keyflip sessions assign <id> <account>`: make a session visible/resumable under a
  DIFFERENT account **without switching profiles** (transcripts are account-independent;
  this patches the desktop app's per-account index + consolidate). MCP: `keyflip_session_assign`.
- **A3 ✅ DONE** — Orphan detection: `keyflip sessions` flags sessions whose `cwd` no longer exists
  and suggests `rebind`; `keyflip sessions doctor` lists all orphans.

### B — Archival, compaction & distillation
- **B1 ✅ DONE** — `keyflip sessions archive <id | --older-than 30d>`: move transcripts out of
  `~/.claude/projects` into a keyflip archive store (declutter, keep retrievable);
  reversible `unarchive`.
- **B2 ✅ DONE** — Compress archived transcripts (gzip).
- **B3 ✅ DONE** — `keyflip sessions compact <id>`: shrink a transcript (drop tool-output noise /
  dedupe) while keeping the conversation.
- **B4 ✅ DONE** — `keyflip sessions distill <id>` ("keepsake"): summarize a session into key
  decisions/learnings via headless `claude -p`, save to a memory store — the insight
  survives even after the raw is archived/deleted.

### C — Background / scheduled ("dreaming mode")
- **C1 ✅ DONE** — `keyflip dream [--policy …]`: a background pass that archives + compacts +
  distills old sessions per a policy; on-demand + schedulable.
- **C2 ✅ DONE** — Schedule it (cron/launchd or the `schedule` skill) to run nightly, unattended.

### D — Unified search & management
- **D1 ✅ DONE** — Full-text CONTENT search across ALL sessions/accounts (today `sessions --search`
  matches the preview; extend to grep transcript bodies + rank by relevance/recency).
- **D2** — Unified session index across accounts + machines, with tags/labels.

### E — Cross-machine session/memory sync & remote control
- **E1 ✅ DONE** — Carry MEMORY + config in the migrate/transfer bundle (`~/.claude` memory/,
  CLAUDE.md, skills, settings) — "collect/distribute memory records across machines".
  Extends `migrate.buildBundle`/`applyBundle` (union-merge, never clobber).
- **E2 ✅ DONE** — Selective collect/distribute: pull specific sessions/memory FROM another machine
  or push TO it (not just the full bundle) — filters on the existing transfer transport.
- **E3 ✅ DONE** — Auto-connect to a machine in "listening" mode: the target runs `keyflip transfer
  serve` (waiting), and this machine auto-logs-it-in + sends selected sessions/login with no
  manual copy. Builds on #10's LAN transport.
- **E4 ✅ DONE** — Remote session control by INJECTING a message: append a prompt to a session from
  another machine (`claude -p --resume <id>` headless), so you steer/continue a session
  remotely via keyflip. (Claude's CLI supports headless resume-with-prompt.)

### F — Cross-service (Claude first, adapters later)
- **F1** — Provider-agnostic session model + read adapters for other services' stores
  (Copilot, Gemini, Codex).
- **F2** — Continue a session started elsewhere (e.g. Copilot) with Claude (normalize →
  Claude-resumable transcript).
- **F3** — All of the above exposed as MCP tools.

### Suggested order (implementable-now first; no hardware/SSO org needed)
**A1 ✅** → **E1** (memory in bundle) → **D1** (content search) → **B1/B2** (archive+compress)
→ **A3** (orphan detect + rebind hint) → **B4/C** (distill + dream — needs a `claude -p`
seam) → **A2** (assign) → **E4** (remote inject) → **E2/E3** (selective + auto-connect) →
**F** (cross-service, last).

### G — Visualization & UI surfaces (DRAFT — pending alignment)

**Architectural principle:** keyflip already emits `--json` on every read command and
ships an MCP server. So EVERY UI is a thin presentation/act layer over ONE contract — build
the data/act API once, and all surfaces below consume it. No UI gets its own logic.

Candidate surfaces (pick + prioritize together):
- **G1 ✅ DONE** — `keyflip panel` (local web dashboard).** The hub, command-activated (start/stop,
  never a daemon), bound to loopback. Account grid with live 5h/7d quota bars; which surface
  each account is on (CLI/desktop/browser/extension) + mismatch flags; provider + proxy live
  stats; session browser + content search; migrate/transfer status; distilled-memory browser.
  Read **and** act (switch/rotate/rebind/archive) via buttons → same CLI/MCP underneath.
- **G2 ◑ (v0.2 shipped) — VS Code / JetBrains extension.** `vscode-keyflip/`: status bar
  (active account · click-to-switch), command palette (switch with 5h/7d quota + capture state,
  open dashboard, show status), 60s network-free refresh. Testable core in `lib.js`
  (`test/vscode-lib.test.js`), bilingual README. **Remaining:** sessions tree view, inline
  tug-of-war / browser-mismatch warnings, renamed-folder → `rebind` prompt, JetBrains, marketplace.
- **G3 ✅ DONE** — Claude Code status line.** A `keyflip statusline` script showing active account +
  quota right in Claude Code's prompt. Cheapest, native, zero chrome.
- **G4 ✅ DONE (via xbar/SwiftBar) — menu-bar surface.** The daemon tension is resolved by NOT
  writing a resident process: `keyflip menubar` emits xbar/SwiftBar plugin format (title = active
  account + 5h quota; dropdown = accounts colour-coded by quota with click-to-switch, providers,
  open-dashboard/consolidate/refresh). xbar/SwiftBar is the resident host; keyflip stays a CLI
  it re-runs on an interval. `keyflip menubar --install [--dir <folder>] [--interval 30s]` drops a
  wrapper into the plugin folder (xbar default auto-detected; SwiftBar via `--dir`). Pure render,
  9 tests (`test/menubar.test.js`) incl. param-injection guard (labels can't inject xbar params).
  `src/menubar.js`. **Remaining:** native tray for Windows/Linux (device-gated; xbar is macOS).
- **G5 ◑ (sparklines + calendar + constellation done) — Data-viz inside the panel.**
  ✅ per-account 5h sparklines; ✅ **session-activity calendar heatmap** (GitHub-style, 26 weeks,
  `buildActivity`); ✅ **memory constellation** (keepsakes linked by shared top-terms, `buildMemoryGraph`)
  — both browser-verified, tested (`test/panel.test.js`). **Remaining:** headroom heatmap (partly
  redundant with the quota bars), cross-machine topology map (needs a multi-machine inventory that
  doesn't exist yet — device-gated). Panel now serves `no-store` HTML + ignores query strings.
- **G6 ✅ DONE — Visual pairing for LAN transfer (#10).** `keyflip transfer serve --qr` renders a
  scannable terminal QR of the `keyflip://transfer?host=…&code=…&fp=…` pairing URL. Ships a
  **zero-dep QR encoder** (`src/qr.js`: GF(256)/Reed-Solomon/BCH/masking, byte mode, versions 1-10,
  ECC L/M). Verified end-to-end: every primitive pinned to published ISO/IEC 18004 constants +
  RS-divisibility + format-info readback, AND the rendered QR decoded by the browser's native
  BarcodeDetector back to the exact payload (`test/qr.test.js`). Also on `serve --receive`.
- **G7 — Launcher extensions (Raycast/Alfred, macOS).** Fast switch/rotate/"which account"
  from the launcher.
- **G8 ✅ DONE — Shareable read-only snapshot.** `keyflip panel --export <file> [--anon]`
  writes a FULLY STATIC, self-contained HTML (server-side inline SVG — no script, no fetch,
  works offline): accounts + quota bars + sparklines, the activity calendar, providers.
  DELIBERATELY excludes all private content (session cwds/previews, keepsakes, the memory
  constellation); `--anon` also masks emails + account/provider names. Browser-verified;
  `test/panel.test.js` asserts no session/keepsake content ever leaks into the file.
- **G9 — TUI** (already in E5): `keyflip ui`, keyboard-only (no mouse), full-screen switcher +
  usage sparklines + session search.

Recommended core four to start: **G1 (panel)** + **G3 (status line, cheapest)** +
**G2 (VS Code)** + **G4 (tray, if we accept the daemon exception)**; G5/G6 as enhancers.

---

## H — Cross-cutting infrastructure principles (DECIDED 2026-07-06)

These apply to the WHOLE codebase, not one feature.

### H1 — keyflip owns its memory; Claude feedback is opt-in
- keyflip maintains its OWN memory store (`<configDir>/memory/`): it manages what it
  **compacts, archives, and distills** into durable keepsakes — independent of Claude's
  `~/.claude` memory.
- Feeding results BACK into Claude's `~/.claude` memory happens ONLY behind an explicit
  toggle/flag (e.g. `--to-claude` or a config setting). Default: keyflip curates its own
  layer and does NOT touch Claude's memory.

### H2 — consent flag before destructive / experimental actions
- Anything destructive (archive-that-deletes, compact-that-drops-raw, dream's auto-cleanup,
  writing into Claude's memory) is **dry-run / preview by default** and requires an explicit
  opt-in flag (`--apply` / `--force`) to actually mutate. Safe for experimentation.

### H3 — git-backed versioning everywhere (secrets EXCLUDED)  ·  **FOUNDATION ✅ DONE (2026-07-06)**
> Shipped `src/vcs.js` + auto-init + auto-commit at the `withLock` funnel (label = command
> name) + managed secret-excluding `.gitignore` + `keyflip history` / `undo` / `restore` /
> `versioning [on|off]`. ON by default; `KEYFLIP_VCS=off` disables (used by the test suite);
> `.noversion` marker = user opt-out. Best-effort (never breaks a mutation), degrades to no-op
> without `git`. Live-verified: mutations commit, secrets stay untracked, undo reverts. 5 tests.
> NEXT in H3: (2) migrate `backup`/`reset`/`sync` safety copies onto git (remove ad-hoc dirs);
> (3) gzip + version compacted/archived transcripts.

- keyflip's config/state/memory dir is a **git repo**; every mutation auto-commits with a
  descriptive message, so any change is inspectable (`keyflip history`) and reversible
  (`keyflip undo` / `restore <ref>`). Rollbacks become first-class.
- **HARD CONSTRAINT — never commit secrets.** A managed `.gitignore` excludes `creds/`,
  `*.cred`, `browser-sessions/*.sql`, and anything token-shaped. Git tracks only the
  no-secret set (profile metadata, provider meta, config, breakers, proxy/links, the memory
  store) — the SAME set `keyflip backup` already snapshots. Secrets stay in the OS store.
- Single integration point: mutations already funnel through `withLock` / the dispatcher —
  commit once there (with the command name as the message) rather than sprinkling commits.
- Composes with (and can subsume) the existing ad-hoc backups (`backups/`, `pre-sync-backups/`,
  `.keyflip-bak`). Raw `~/.claude/projects` transcripts live OUTSIDE this repo; keyflip's
  git tracks its own curated memory/metadata, not the raw bulk.

**Forks — DECIDED (2026-07-06):**
- **Default ON** — a real install auto-inits `configDir` as a git repo and commits every
  mutation. `keyflip version off` disables. (Tests opt out via `KEYFLIP_VCS=off`.)
- **Merge the ad-hoc backups INTO git** — end state removes `backups/` / `pre-sync-backups/`
  / `.keyflip-bak` in favor of git history. Sequencing: ADD git first (both coexist briefly),
  verify, THEN remove the ad-hoc paths — so we never lose the safety net mid-migration.
- **Track compacted + archived transcripts too** (not only distilled + metadata) — full,
  reversible history. Large `.jsonl` are gzipped before commit to bound repo growth. Raw
  live transcripts still live in `~/.claude/projects` (outside the repo) until archived.

H3(1) ✅ DONE: `src/vcs.js` foundation + auto-init + auto-commit at the `withLock` funnel +
managed secret-excluding `.gitignore` + `keyflip history`/`undo`/`restore`/`version`; then
keyflip `history`/`undo`/`restore`/`versioning` shipped; secrets git-ignored; `KEYFLIP_VCS=off` for tests; 5 vcs tests. NEXT: (2) migrate `backup`/`reset`/`sync` safety copies onto git; then (3) the memory/dream layer
on top (with H1/H2 toggles + git as the undo net).

### I — Semantic recall / RAG over your chats (NEW — user-proposed, ACCEPTED 2026-07-06)

**Idea (user):** put the chat corpus behind a RAG system — search *across* chats
semantically (not just literal jsonl grep), research the history of a topic, and get
synthesized answers. A real differentiator: big vendors don't give good cross-conversation
semantic recall over YOUR local data.

**Design that fits keyflip (zero-dep, local-first, command-activated):**
- **Index the DISTILLED KEEPSAKES, not raw transcripts.** distill (B4) already condenses
  each session to a small high-signal summary — a tiny, cheap corpus. This is what makes RAG
  affordable here, and ties directly into the dreaming layer (dream distills → same pass
  indexes).
- **Two-tier retrieval:**
  - **I1 ✅ DONE** — local lexical (default, zero-dep, offline, private):** BM25 + light query
    expansion over keepsakes (and optionally transcripts). No embeddings, no network, no cost.
    Already ~most of the value; the honest "works everywhere" baseline.
  - **I2 ✅ DONE** — optional embedding layer (opt-in):** embed keepsakes via a USER-CONFIGURED
    embedding provider — local **Ollama** (private + free) or a hosted key — into a SQLite
    table (system binary, no dep); brute-force cosine at query time (fine for thousands of
    vectors). NO bundled model, so zero-dep holds. Off by default.
  - **I3 ✅ DONE — RAG answer (opt-in):** at query time, re-rank + synthesize an answer over the
    retrieved chunks via `claude -p` (the seam already exists), with citations back to the
    source sessions. This is "research the history of X" with a real answer.
- **`keyflip recall "<query>"`** — the one command: lexical by default, `--semantic` for the
  embedding layer, `--answer` for the RAG synthesis. Exposed via MCP (`keyflip_recall`).
- Caveats to hold: true vectors need SOME model (external/local) → semantic is opt-in, not
  default; never send chat content to a third party without an explicit provider opt-in.

**Order:** I1 (local lexical over keepsakes) first — cheap, private, immediately useful and
composes with distill; then I2 (opt-in Ollama/hosted embeddings); then I3 (`claude -p` answer).

### J — Portable state: agent memory + MCP config + account settings (NEW — user 2026-07-06)

**Idea (user):** "I have 2 machines but everything for this project is on one, so I can't
work from the other." Extend the migrate/transfer bundle (E1) beyond Claude memory to carry
ALL the portable state that makes a machine ready:
- **J1 — other agent platforms' memory/config dirs**, not just Claude: a registry of known
  locations (Cursor, Copilot, Codex, Gemini, opencode, Aider…) → collect + union-merge like
  E1 does for `~/.claude`. Off-by-default per platform; opt-in list.
  **✅ v1 SHIPPED (2026-07-06):** `src/agents.js` registry (Cursor `~/.cursor/rules/`, Gemini
  `~/.gemini/GEMINI.md`, Codex `~/.codex/AGENTS.md`+`memories/`), existence-gated, **home-level
  MARKDOWN memory only — no config/auth/secrets**. Wired into the migrate/transfer bundle behind
  opt-in `--agents` (or `--agents=cursor,gemini`), union-merge with path-traversal + memory-shape
  guards. `keyflip agents` inspects; MCP `keyflip_agents` + `agents:true` on `keyflip_migrate_export`.
  Composes with the E2 bundle filters (`--only-agents`). 12 tests. See `docs/MULTI-AGENT-STATE.md`.
  **✅ CONFIG-TIER SHIPPED (2026-07-07):** carry other agents' CONFIG files too (Cursor
  `~/.cursor/mcp.json`, Gemini `~/.gemini/settings.json`, Codex `~/.codex/config.toml`) behind
  opt-in `--agent-config` (`--only-agent-config`). Built on a new reusable **`src/secretscan.js`**
  (known token shapes: sk-ant/sk/ghp_/AIza/xoxb/AKIA/Bearer/JWT/private-key + credential-shaped
  keys) that REDACTS every plaintext secret before it can travel — the structure moves, the keys
  don't (re-enter on the new machine). Redacted on collect AND re-redacted on merge (defence in
  depth); env-refs (`${VAR}`) preserved; `*_TOKENS` limits kept. `keyflip agents` shows config +
  redaction counts; MCP `agent_config:true` on export. **Opt-in carry (user choice):**
  `--agent-config-secrets` carries the REAL keys instead of redacting (per the user's own wish to
  move a full setup between their machines) — the CLI warns loudly and MCP hard-refuses unless the
  bundle is encrypted, and entries are tagged `redacted:false` so the merge writes them as-is
  rather than re-stripping. 15 tests incl. an adversarial fuzz + the invariant
  `scanText(redact(x))===[]`. **Residual limitation:** a secret under a benign key name with no
  known prefix can slip the scanner — so real transfers should still be encrypted.
  **Deferred:** Copilot/opencode/Aider (paths NEEDS-VERIFICATION on a real install).
- **J2 — MCP configuration.** Carry the MCP server config across machines: Claude Code's
  `mcpServers` (`~/.claude.json` / project `.mcp.json`) and Claude Desktop's
  `claude_desktop_config.json`. keyflip already has `mcpreg` (manage once, project into
  Code+Desktop) — extend the bundle to include the mcp registry so a new machine gets the
  same servers. Secrets in MCP env (API keys) handled like other secrets (gitignored / opt-in).
- **J3 — account settings: template + sync + edit.** "A new account always needs its settings
  redone." Capture an account's settings (`~/.claude/settings.json` + keyflip's per-account
  config) as a reusable TEMPLATE; `keyflip settings apply <template>` seeds a new account;
  `keyflip settings sync` keeps them aligned across machines; `keyflip settings edit/set <k> <v>`
  to change them. Composes with migrate/transfer (settings ride the bundle) and H3 (versioned).

**Order:** J2 ✅ + J3 ✅ + J1 v1 ✅ + J1 config-tier ✅ (MCP config in bundle + settings edit/carry +
multi-agent markdown memory + redacted agent config). Remaining: the
NEEDS-VERIFICATION agents (Copilot/opencode/Aider), plus epic F (cross-service SESSION
normalization) — all device-gated. See `docs/MULTI-AGENT-STATE.md`.

> NOTE: this sits AFTER epic I (RAG) in priority, per the user — continue the existing list
> (I1 next), then come back to J.

### K — FLEET: multi-machine control plane ✅ (2026-07-07)
"Manage every associated keyflip from one screen." keyflip isn't a daemon, so the fleet
coordinates through a **shared rendezvous folder** (Dropbox/iCloud/WebDAV/synced dir) where every
file is encrypted with the fleet passphrase (`sync.encrypt`). `src/fleet.js`:
- Stable per-machine identity (`fleet.json`, added to profiles RESERVED_FILES so it's never
  mistaken for an account); `keyflip fleet init --dir <folder>`.
- `fleet push [--with-secrets]` publishes this machine's STATUS (accounts + cached quota + recent
  chats with last-message **reply status**) and drains its INBOX, applying queued commands
  (consent-gated: switch / save-account).
- `fleet status` + web `fleet panel` (loopback, auto-refresh, mobile-responsive, browser-verified):
  every machine on one screen + a **"new reply since last check"** diff (`fleet-seen.json`).
- `fleet switch <machine> <account>` (remote switch), `fleet send-account <acct> --to <machine>
  [--from <machine>]` (distribute — A hands C's account to B via C's `--with-secrets` publish),
  `fleet collect` (gather all published accounts locally).
- Reuses `transfer.buildExport`/`applyImport` for account payloads + `sync.encrypt` for the bus.
- 8 tests (full A/B/C topology as separate ctxs sharing one dir). MCP: `keyflip_fleet_status`
  (read), `keyflip_fleet_switch` / `keyflip_fleet_send_account` (confirm-gated). Bilingual docs.
**Remaining (device-gated):** a background poll/notify daemon (no-daemon tension — today it's
pull-on-`push`); WebDAV rendezvous (dir works today; `sync.dav*` can back it).

### Session export ✅ (2026-07-07)
`keyflip sessions export <id> [--format md|html|json] [--out <file|->]` renders a Claude Code
transcript into a clean, shareable document: **markdown**, a **self-contained HTML chat view**
(no script/fetch, browser-verified), or normalized **json**. Tool output is summarized
("used Read, Grep"), not dumped; pure tool-result turns are elided; content is HTML-escaped.
`src/transcript.js` (parse/toMarkdown/toHtml), 6 tests, MCP `keyflip_sessions_export` (read-only,
returns the content), bilingual docs.

### Epic F v1 — foreign session import ◑ (2026-07-07)
`keyflip foreign <file>` + MCP `keyflip_foreign_export` (`src/foreign.js`): detect + normalize
ANOTHER agent's session-log FILE into keyflip's unified shape, then render with the Claude Code
exporter (md / self-contained HTML / json). Supported now:
- **message-event JSONL** (Claude Code / Gemini-style) — via the tested `transcript.parse`.
- **Cursor SQLite** (`cursorDiskKV`) — via a **from-scratch zero-dep SQLite reader**
  (`src/sqliteread.js`: header + table B-tree + record serial types + OVERFLOW-page chains),
  verified against real sqlite3-CLI fixtures (9 KB overflow value, 500 rows across pages,
  int/null/blob). Bubble→message mapping (order from the composer header list, role from `type`)
  is best-effort — Cursor's schema is NEEDS-VERIFICATION.
- **generic JSON** (opencode + others) — the largest array of `{role, text/content}` objects.
- **Aider** `.aider.chat.history.md` — best-effort markdown.
`keyflip foreign --list` discovers foreign sessions at known (best-effort, existence-gated)
locations — Cursor `state.vscdb`, opencode `.local/share/opencode`, Gemini `antigravity-cli/brain`
(logic fixture-tested; paths NEEDS-VERIFICATION). 15 tests. **Remaining:** Copilot (YAML — needs a
parser). See `docs/MULTI-AGENT-STATE.md`.

---

## Security review pass (2026-07-06, ultracode) — 17 confirmed defects fixed

Adversarial multi-agent review of the whole uncommitted session diff (~5000 lines) before the
bulk commit: 10 dimension finders → 3-lens adversarial verify (only ≥2/3-confirmed survived) →
synthesis. 22 raised, 19 survived, 17 distinct after de-dup. All fixed + regression-tested
(410 tests, 409 pass, 1 opt-in skip). Highlights:

**P0 (secret leakage / RCE)**
- **Secrets leaking into keyflip's own git.** The desktop-app OAuth token cache (`app/*.json`),
  the claude.ai `sessionKey` cookie DB (`app/*.cookies`), and `pre-sync-backups/*.json` (raw
  OAuth tokens) matched NO `.gitignore` rule, so `git add -A` in the autoCommit funnel committed
  them. Root cause: `vcs.js` GITIGNORE and `backup.js` SKIP were hand-maintained and had drifted.
  Fix: new **`src/secretpaths.js`** — a single source of truth for secret-bearing paths, consumed
  by both. `ensureRepo` now REFRESHES a stale `.gitignore` every run and `git rm --cached`s any
  now-ignored file an older keyflip had committed (history not scrubbed — working file untouched).
  This also closed the same leak in metadata backups (`app/` + `mcp-registry.json`).
- **Command injection via `older_than_days` → Linux cron `/bin/sh -c`** (MCP path; no server-side
  schema validation). Fix: `schedule.dreamCommand` coerces `days` to a bounded int at the source.

**P1**
- `keyflip_settings` show/get returned `env.ANTHROPIC_API_KEY`/`_AUTH_TOKEN` in plaintext over
  MCP → now redacted (`***redacted***`) via `settings.isCredentialKey`.
- `cmdSend`/`cmdResume` folded the `--as <account>` value into the message/session arg
  (`positionals` wasn't told `--as` takes a value) → fixed.
- Embedding cache (`recall.semanticSearch`) never invalidated on model/endpoint change → cache
  key + entry now carry the embedding `space` (model+url); `embed.cosine` refuses mismatched dims.
- **Symlink-following bundle-merge writes.** All four merge fns (transcripts/memory/config/agents)
  + archive validated only the LEXICAL path, so a pre-planted symlinked dir/leaf escaped root.
  Fix: new **`fsutil.safeDestUnder(root, dest)`** (realpath deepest-existing-ancestor + lstat
  leaf) gates every merge write, and writes go through `fsutil.atomicWrite` (rename = leaf-safe).
  `mergeMemory` also gained an `isMemoryRel` gate (blocks `settings.json`/dotfile injection).

**P2** — `embed` honors OpenAI `index` ordering; `sessionmap`/`memory` writes are now atomic
(torn write can't wipe all assignments / corrupt a keepsake); MCP `migrate_export` empty-check
counts memory/config; LAN receive/push summaries report providers+agents; stemmer `-es`
over-strip fixed (singular/plural converge); + test hardening (maxAttempts brute-force shutdown,
wire-encryption assertion, every gitignore secret pattern, absolute/nested + symlink traversal,
archive corrupt/0600). New modules: `src/secretpaths.js`; new helper: `fsutil.safeDestUnder`.

---

## Missing-feature audit (2026-07-07)

A 5-dimension audit (CLI↔MCP↔docs parity, roadmap-open, domain/competitor, reliability, UX-safety;
80 agents, each candidate verified against the code) found **67 real gaps**. The S-effort, high-value
ones were fixed this session:

**Fixed (this session):**
- **Safety:** `remove` + `provider remove` now confirm before an irreversible delete (fail-closed
  non-interactively); `fleet keys` (+ MCP `keyflip_fleet_keys`) audits the TOFU signing-key store
  (fingerprint + ok/CHANGED/unpinned/offline) — origin-auth trust was previously unauditable.
- **MCP CRUD parity:** `keyflip_account_remove`, `keyflip_provider_remove`, `keyflip_fleet_collect`
  (all MUT+confirm). CLI `logout` verb added (was MCP-only). 60 tools, 0 invariant violations.
- **Reliability:** `foreign` warns on an unflushed Cursor `-wal` instead of silently dropping the
  newest chats; Cursor discovery now lists Windows/Linux paths, not just macOS; `keyflip chat` gates
  on `platform!=='darwin'` (clear message on Windows vs a deep failure).
- **Docs lockstep:** fleet origin-auth prose (README EN/TR); opencode + the full 6-agent set named;
  `mcp --setup` prints the live tool count; new verbs in help; stale Windows/Copilot/roadmap notes
  corrected.

**MCP parity — ✅ DONE (2026-07-07):** the remaining CLI-only commands now ship MCP tools (77 total,
0 confirm-invariant violations): `keyflip_gateway_status/use/off`, `keyflip_mcpreg_list/set/enable/remove`,
`keyflip_speedtest` (read-only rank, `noPersist`), `keyflip_share`/`_share_apply`,
`keyflip_sync_test/push/pull`, `keyflip_links`/`_link`, `keyflip_transfer_pull`, `keyflip_autoswitch_tick`
(locks only the switch, mirroring the CLI). Secrets via `*_file` paths. +tests, bilingual docs. Only
long-lived interactive listeners (`transfer serve`, the TUI `menu`/`panel`, `onboard`, `setup`) stay
CLI-only by design.

**Remaining backlog (tracked, not yet built):**
- **Domain features (P2/M–L):** account groups/tags (scoped `next` rotation), spend/quota budgeting +
  alerts, import from `.env`/password managers, team/shared credential pool, shell auto-activation of
  a directory pin, biometric/session-TTL unlock.
- **Platform (device-gated):** Windows/Linux real-install validation of the app-auth crypto, native
  tray, browser-cookie decrypt, dream scheduling; SSO live end-to-end.
- **Epics (unbuilt, planned):** E1 universal surface support, E2 sub⇄API bridge (`keyflip serve`),
  E3 model router (`keyflip route`), E4 config store (`keyflip config`), E5 TUI (`keyflip ui`),
  G2 VS Code/JetBrains extension, full Cursor WAL-frame merge.

---

## Platform expansion program (2026-07 — 3 waves, all shipped + reviewed + hardened)

keyflip grew from an account-switcher into a full **AI-account control plane**. 19 new zero-dep modules
across 3 waves, each built in parallel then integrated (CLI + MCP + bilingual docs) and put through an
adversarial review (dimension-finders × 3-lens verify) + hardening. **124 MCP tools (0 confirm-invariant
violations); 946 tests, 0 fail.**

- **Wave 1 (foundation):** groups/tags (scoped rotation) · budget (usage-% ceilings + breach alerts) ·
  notify (webhook + macOS banner) · import-env (.env→providers) · shell-init (direnv-style auto-activate) ·
  WAL-merge (foreign now reads uncheckpointed Cursor chats) · audit-log viewer.
- **Wave 2 (strategic):** orchestrator (job queue → best-headroom headless run, fanout) · cost
  intelligence (spend/predict/by-project) · team pool (encrypted, role-scoped) · policy engine (which
  account a dir may use; enforced on switch/run/next/orchestrator) · vault backend (1Password/Bitwarden/
  Vault) · integrations (Slack/Discord post) · router (model arbitrage + response cache).
- **Wave 3 (platform):** swarm (own-fleet exec — consent + EXEC-TRUST allowlist + fail-closed origin) ·
  license (offline Ed25519 plan, no phone-home) · config store (E4) · TUI (E5, `keyflip ui`) · universal
  surface registry (E1, `keyflip surfaces`).
- **Also:** rebind now restores the desktop-app Code session's dropped `cliSessionId` (moved-folder
  rescue) · VS Code extension v0.3 (accounts tree, mismatch status bar, re-link command) · productization
  plan (`docs/PRODUCTIZATION.md`: open-core + offline license + Turkey MoR/PayTR payment).

**Reviews confirmed + fixed:** wave-1 (2) · wave-2 (7: policy-bypass on run/next/orchestrator, vault
op://, exec cwd, symlink fail-open, proto) · wave-3 (3: swarm TOFU→RCE, applyExec fail-open, surface
ANSI). E2 (`keyflip serve`) folded into the existing failover proxy; E3 covered by router.

**Still open (by design):** license paywall enforcement (wired at productization launch) · JetBrains
plugin · device-gated Windows/Linux real-install validation + native tray + SSO live · productization
infra (payment/issuer/site — needs the business decisions in PRODUCTIZATION.md).

---

## Wave 4 — Context Layer (AI Development Context Platform) — SHIPPED (2026-07, commit cbfa0bd)

**Delivered:** all 5 modules built (zero-dep, secret-scanned), fully wired, +76 tests (full suite 1021 pass / 0 fail):
- `projctx.js` (context.js was taken by the env-ctx factory) — `.keyflip/` store + NormalizedProjectContext; env-var NAMES only.
- `rulesmodel.js` — normalize CLAUDE.md/.cursorrules/.cursor/rules/AGENTS.md/GEMINI.md/copilot into one model, re-emit per tool.
- `checkpoint.js` — git-bound snapshots (branch/commit/dirty + summary + tasks + provider), chained by parent, `contentHash`.
- `handoff.js` — target-tailored CONTINUE-PROMPT (RO MCP tool `keyflip_handoff`).
- `ctxsync.js` — privacy modes local/git/encrypted/company + conflict detection; secret-scan in EVERY mode.
- CLI: `context <init|status|show|decision add|task add|task set>` + `context sync <status|mode|export|check>`, `rules`, `checkpoint`, `handoff`.
- MCP: 11 new tools (136 total, 0 readOnlyHint/confirm invariant violations). Registries: Windsurf + Kiro added to agents.js (memory+config); foreign.js session-import for both documented NEEDS-VERIFICATION (VS Code-fork globalStorage format unconfirmed — deferred rather than shipping broken discovery).
- Adversarial review: run wf_76aba2c1 (secret-leak / path / crypto / injection / MCP-invariant lenses).

### Post-Wave-4 session (2026-07) — SHIPPED

- **Payment issuer skeleton** (commit ad88039, `issuer/`) — Ed25519 license signer (byte-for-byte
  matched to src/license.js, round-trip proven), node:http webhook router (raw-body → verify → mint,
  idempotent), 4 PSP adapters (Stripe/Lemon Squeezy/iyzico/PayTR, timingSafeEqual, fail-closed),
  central config (region→provider, product→tier, secret ENV NAMES). 6-lens adversarial review: 0 real
  defects. Private key + state gitignored. +86 tests.
- **Half-wired cleanup**:
  - WIRED (f4885e9): `autoswitch.threshold` from config; notify emission on switch/quota/fleet-reply
    (the notify system was built but nothing ever called send()). +3 e2e tests.
  - WIRED (5f43af0): `autoswitch.strategy` + `autoswitch.group` from config — group scopes rotation to
    a tagged pool (new capability). +2 tests.
  - REMOVED (1ba2000, owner-approved): inert `ui.theme`, `security.relockMinutes` (un-implementable in
    a stateless CLI), and the dead `surface.js` snapshot cache. Config tests migrated to keep coverage.
- **STILL half-wired (flagged, awaiting wire-or-remove decision):** `ui.color` (style.js only honors
  NO_COLOR/TTY — redundant), `usage.cacheTtlSeconds` (usage.js uses a hardcoded TTL).

### Device-gated (built + synthetic-tested this session; LIVE hardware validation pending)
- **Linux app-auth** (commit 21e08f2): context.js sets appDataDir=$XDG_CONFIG_HOME/Claude; getSafeStoragePassword
  gets the libsecret key via secret-tool; detect reuses the shared v10 path; apply is file-copy. +3 tests.
  NEEDS-VERIFICATION: exact secret-tool schema; real Claude-app decrypt on Linux.
- **Windows app-auth**: already complete (DPAPI read via decryptAppBlobWin + file-copy apply). No gap.
- **Linux tray** (commit ea26faf): GNOME Argos / KDE kargos share xbar's plugin format → menubar.pluginTarget
  installs there. Windows has no zero-dep tray host (documented; --dir for any compatible tool). +1 test.
- **SSO**: code is WIRED (`--sso` → `claude auth login --sso`, isolated capture); only LIVE validation on a
  real SSO/2FA org remains (see docs/ENTERPRISE-SSO.md checklist) — org-gated, no code gap.
- Config wiring completed (commit 4ae944f): ui.color + usage.cacheTtlSeconds — every schema key now consumed.

### In progress
- JetBrains extension (new artifact; VS Code extension already shipped as vscode-keyflip v0.3.0) — building.

### Still needs the user's hardware (cannot verify in this environment)
- Linux/Windows app-auth against a real Claude desktop app; Linux tray rendering in Argos/kargos;
  SSO login on a real org; JetBrains plugin compiled + run in IntelliJ.

Original plan below (for reference):

### (planned) Wave 4 — Context Layer

Reframe: the real problem isn't switching Claude accounts, it's PROJECT MEMORY lost when the developer
changes AI TOOL (Kiro→Cursor→Claude Code→opencode), account, or machine. keyflip becomes a tool-agnostic
**AI Development Context Layer**: a portable, structured project memory that moves across tools/accounts/
machines. ~55% of the plumbing already exists (foreign import/normalize, agents config carry, secretscan,
migrate/transfer/sync, surface E1 registry, sessions distill/compact, cost attribution); Wave 4 adds the
differentiating layer. Zero-dep JS (the proposal's TS interfaces become JSDoc/schema-validated JS).

New modules (build on foreign.js/agents.js/surface.js/secretscan.js/migrate.js/vcs.js — modular, NOT a rewrite):
- **context.js** — the `.keyflip/` project-context store + NormalizedProjectContext (project.json, context.md,
  decisions.json, tasks.json). Schema-versioned; `pack` runs secretscan so NO secret ever enters the package.
- **rulesmodel.js** — normalize agent rule files (.cursorrules/CLAUDE.md/AGENTS.md/GEMINI.md/…) into ONE common
  rule model, then RE-EMIT per target tool (Cursor rules → common → CLAUDE.md).
- **checkpoint.js** — git-bound checkpoints (branch/commit/dirty-files + a session summary) — portable project
  state at session end.
- **handoff.js** — target-aware CONTINUE-PROMPT generator (from context+tasks+decisions+checkpoint).
- **ctxsync.js** — context-sync PRIVACY MODES (local / git / encrypted-cloud / company-policy w/ allowedProviders)
  + conflict detection (content hash + parent checkpoint) for the same context edited on 2 machines.
- Registries: add **Kiro** and **Windsurf** to agents.js + foreign.js; add the EXPORT side (foreign is import-only).

CLI: `keyflip context <init|status|pack|export --to <tool>|decision|task|checkpoint|handoff --to <tool>|sync>`.
MVP order (per the proposal): MVP1 Claude project-context + tasks + session summary + secret-filtered export;
MVP2 Cursor adapter + rules transform + continue-prompt + git checkpoints; MVP3 Kiro/opencode/Windsurf +
cloud sync + conflict + team/policy. Positioning: "AI coding tools change. Your project memory should not."

---

## Session 2026-07-13 — SHIPPED (control plane + monitoring + lifecycle + brain)

All items below are built, adversarially-reviewed, fixed, tested (full suite ~1275 pass / 0 fail; 145 MCP
tools, 0 readOnlyHint/confirm invariant violations), and committed to `main` (NOT pushed — awaiting the
owner's explicit "push"). Each was: build (often a fan-out Workflow) → adversarial review (secret-leak /
path / crypto / injection / MCP-invariant lenses) → fix confirmed findings → regression tests → bilingual
docs (README.md + README.tr.md + skills/keyflip/SKILL.md) in lockstep.

**The control-plane architecture (the core reframe).** The real UX deadlock: the human is simultaneously the
Claude-user AND the keyflip-operator on one machine, and the desktop app is a third party fighting over the
one credential slot — so "close Claude to operate + memorize commands." Dissolved in three layers, owner-
approved ("Hepsi, fazlı" + Brain autonomy = "suggest+approve"):
- **Phase 1 — Pilot** (`e8a0dd8`): `src/autoswitchservice.js` + `keyflip autoswitch install|status|uninstall`
  + `--once`. An UNATTENDED background service (launchd StartInterval / cron */N) runs a single autoswitch
  tick on an interval, so rotation happens on its own (the fix for "autoswitch never switches" — it was a
  foreground loop). MCP `keyflip_autoswitch_service`. Interval clamped 60s..6h; strategy/group whitelisted.
- **Phase 2 — Face** (`054cea7`): `src/commands.js` (an 83-command searchable catalog) drives a TUI **command
  palette** (`keyflip ui` → `p`) so nothing is memorized; a **provider-usage view** (`u`); and the CodexBar
  bridge. Safe read-only no-arg commands run on Enter; the rest print ready-to-paste.
- **Phase 3 — Brain** (`97428bf`): `src/brain.js` + `keyflip brain "<intent>"` — plain-language intent → a
  PROPOSED plan of keyflip commands (Gemini, zero-dep REST via fetch) the human approves step-by-step. OFF
  unless `KEYFLIP_BRAIN=1` + `GEMINI_API_KEY`. Propose-ONLY (no dispatch/spawn/tool.run); outbound context
  secret-scrubbed; the plan is validated against the catalog (only real commands, args ⇒ mutating). MCP
  `keyflip_brain_propose` (RO). Autonomy stays "suggest+approve" — never acts alone.

**Monitoring — the CodexBar capability, ported (no external dep).**
- `src/provusage.js` (`3edc7ce`): a zero-dep multi-provider usage/limit reader (Codex/Gemini/Cursor/Copilot/
  opencode/OpenRouter + Claude via usage.js), normalized to usage.js's shape. Approach adapted from CodexBar
  (github.com/steipete/CodexBar, MIT) — reimplemented, credited in CREDITS.md. Secret-safe (env NAMES only;
  fetch defaults null = fail-closed). NEEDS-VERIFICATION on a live install: the exact gemini/openrouter/
  cursor/copilot/opencode endpoints + shapes (codex is the verified real path).
- First-class surface (`64ac271`): `keyflip usage --providers` + MCP `keyflip_provider_usage` (was TUI-only).
- `src/codexbar.js` (`054cea7`): `keyflip codexbar` + MCP `keyflip_codexbar` — detect a locally-installed
  CodexBar and align its tracked providers with keyflip's. Reads only the non-secret provider list.

**Internet relay for `transfer` (`2e8c924`, MCP `33a562e`).** `keyflip transfer serve/pull --relay <dir|url>`
works across the internet with the same one-time-code UX: the encrypted bundle travels through a user-
controlled relay (a synced folder OR a WebDAV URL) — no keyflip server, no NAT traversal. ZERO-KNOWLEDGE:
the pairing is `<rendezvous>-<key>`; rendezvous is a public random slot handle, key is the AES passphrase
that never reaches the relay. `keyflip transfer relay` self-hosts a zero-dep blob relay (`src/relayserver.js`).
MCP `keyflip_transfer_relay_pull` (one-shot). Review fixed 2 HIGH: an unsalted-sha256 slot oracle (→ random
handle) and a leading-dot disk-exhaustion bypass.

**Session lifecycle — delete / PII scrub / edit (`c75d223`).** `src/sessionedit.js` + `src/pii.js`:
`keyflip sessions delete` (archive-then-remove by default, `--hard` permanent), `sessions scrub` (redact PII
— email/phone incl. TR, TCKN-checksum, Luhn card, IBAN mod-97, IP, secrets; incl. assistant THINKING blocks;
user-extensible `pii-patterns.json` + opt-in local-PII-LLM hook), `sessions edit` (delete/redact/truncate
message; valid JSONL). MCP `keyflip_session_delete|_scrub|_edit` + `keyflip_pii_scrub_text`. Review fixed 3
(2 HIGH PII leaks: card-next-to-IP over-match, thinking-block skip; + custom-pattern ReDoS).

**Context Layer (Wave 4) — see the SHIPPED note above (`cbfa0bd`, `f5338b4`).**
**Productization infra:** license env-gating (`d58897c`, OFF unless `KEYFLIP_LICENSING=1`) + the multi-
provider issuer skeleton (`ad88039`: Ed25519 signer matching license.js + Stripe/LemonSqueezy/iyzico/PayTR
webhook adapters + node:http relay). NOT built: the website + admin panel. Activation (real keypair →
PUBKEY_B64, PSP signup, product IDs) is an owner/business step.
**Half-wired cleanup:** wired autoswitch.threshold/strategy/group + notify emission + ui.color +
usage.cacheTtl (`f4885e9`, `5f43af0`, `4ae944f`); removed 3 inert settings (ui.theme, security.relockMinutes,
surface-snapshot) owner-approved (`1ba2000`).
**Extensions / device-gated (build-done, hardware-validation pending):** VS Code (prior) + JetBrains plugin
(`33e1cc7`); Linux app-auth + Linux tray (Argos/kargos) (`21e08f2`, `ea26faf`); SSO org-login wiring. All
need real hardware/accounts to validate (Linux/Win app-auth, `./gradlew test`/`runIde`, live SSO, live
Gemini brain round-trip, Windsurf/Kiro session-import formats).
