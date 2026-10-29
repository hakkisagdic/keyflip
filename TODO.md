# keyflip — open work (actionable backlog)

The historical "what shipped" record lives in [roadmap.md](roadmap.md). This file is the
forward-looking, checkable task list. Check items off as they land.

---

## A. Productization — NOT built yet

The paywall (`license.js`, env-gated OFF via `KEYFLIP_LICENSING`) and the payment **issuer skeleton**
(`issuer/`: Ed25519 signer + Stripe/LemonSqueezy/iyzico/PayTR webhook adapters + node:http relay) exist.
These do not:

- [x] **Website** — marketing/landing + docs + checkout flow (per the 4-provider decision in
      `docs/PRODUCTIZATION.md`: iyzico + PayTR local, Lemon Squeezy + Stripe global).
      The site, its docs (EN/TR) and both locale trees are live; the paid side now reads from
      ONE file, `website/src/checkout.config.json` (price, checkout link per provider/cycle,
      customer portal), and the pricing page grows its buttons from it — an empty URL hides the
      button instead of linking to a 404, and `salesOpen` flips the "coming soon" state off.
      `/license` (EN/TR) explains activation: save the emailed token, `keyflip license activate
      <file>`, `keyflip license status`, plus the customer-portal links and the honest limit of
      an offline license (an activated one cannot be revoked from a server).
      **Left for the owner:** fill the real checkout/portal URLs in that config and flip
      `salesOpen` once the payment accounts exist.
- [x] **Admin panel** — license/customer management (issue, revoke, look up; webhook event log).
      `issuer/admin.js` + `issuer/store.js`: a JSON API under `/admin/api/*` and a single-page panel
      at `/admin`, both behind a constant-time bearer token that fails closed (503) when unset. The
      store cannot hold a token; the minted one is returned once and never persisted. Revoke records
      the revocation — it cannot un-activate an already-activated offline license, so reissue (with a
      shorter expiry) is the real enforcement path.
- [ ] **Issuer activation** (owner/business step, not code).
      **Code side is DONE:** the real Ed25519 keypair exists (private key at
      `issuer/private/issuer.key`, `0600`, gitignored — **back it up, encrypted, off this
      machine; if it is lost no license can ever be signed again**) and its **public** half is
      embedded in `src/license.js` `PUBKEY_B64`, so a license the issuer signs verifies green
      in a shipped client with no code change and no release. `issuer/issuer.config.json` now
      ships its product slots as explicit `REPLACE_…` placeholders: an unfilled slot is REFUSED
      (never guessed), the issuer prints `{"evt":"config","ready":false}` at startup, and an
      unmapped webhook records the product id in the event log so the owner knows exactly what
      to paste.
      **Still the owner's business steps:** sign up with the PSPs (iyzico / PayTR / Lemon
      Squeezy / Stripe), replace every `REPLACE_…` key in `issuer/issuer.config.json` with the
      real product/price id, fill the checkout URLs in `website/src/checkout.config.json` and
      set `salesOpen: true` — then flip `KEYFLIP_LICENSING=1`.
      The step-by-step runbook (with the rotation rule) is in
      [`issuer/README.md`](issuer/README.md#turning-the-switch-on--the-activation-runbook).

## B. RoleCraft integration — cross-agent skill/role + MCP distribution (NEW)

Absorb the capability of **RoleCraft** (github.com/sametcelikbicak/rolecraft — zero-dep JS CLI, MIT):
install/sync AI-agent **skills (SKILL.md) + MCP servers** across **all detected agents** (82+ targets:
Cursor, Gemini, Codex, Copilot, opencode, Windsurf, Kiro, Aider, …), not just Claude Code — so every
account's assets travel everywhere. Port the approach (zero-dep, MIT-attributed in `CREDITS.md`), the
same way `provusage.js` ported CodexBar. Goal (owner's words): "convert all assets of all accounts."

- [x] Read RoleCraft's real surface (targets registry, SKILL.md schema, security scan, lockfile,
      `agents-xml`); decide port vs adapter. Confirm the target-agent config-dir map against
      keyflip's existing `agents.js` REGISTRY + `surface.js` SURFACES.
- [x] New `src/skillsync.js`: install a skill to N detected agents from any source (local/GitHub/
      archive), with SHA-256 per target in `~/.config/keyflip/installed-skills.json`, security
      scan via `secretscan.js` — never install a skill carrying a secret.
- [x] CLI: `keyflip skill add <src> [--agents a,b] [--link|--force|--dry-run]`, `skill sync`,
      `skill list`, `skill remove`, `skill agents`; `install-skill` fans the bundled skill out.
      Bilingual docs (README EN/TR + USE-CASES + SKILL + website EN/TR).
- [x] MCP tools for agents (mutating → confirm-gated), in lockstep with docs:
      `keyflip_skill_agents` (RO), `keyflip_skill_add`/`_sync`/`_remove` (confirm), per-target state.
- [x] Adversarial review (secret-in-skill leak, path traversal into an agent's config dir, integrity
      spoofing, install-without-confirm) → fix → regression tests. All five findings are closed and
      pinned: the scan now reads **hidden files too** (a `.env` no longer slips through), any symlink
      refuses the install (a copy would leave a link pointing outside the agent's dir), `sync`/`remove`
      resolve the target through keyflip's own table (a poisoned manifest entry is
      `skipped-unknown-target`, never followed) and validate the name, the fingerprint (v2) covers
      every file including hidden ones so an edit cannot pass as "ok" (v1 rows from older manifests are
      still read), and `add`/`remove` now prompt on a TTY and require `--yes` otherwise. `.git` is
      neither scanned, copied nor hashed. `test/skillsync.test.js` carries the regressions.
- [x] MCP-server distribution to other agents. `mcpreg` now projects one registry into Claude
      Code/Desktop, Cursor (`~/.cursor/mcp.json`), Kiro (`~/.kiro/settings/mcp.json`), Gemini CLI
      (`~/.gemini/settings.json`), Devin/Windsurf (an EXISTING `mcp_config.json` among the three
      locations the rename left behind) and opencode (`opencode.json`, `mcp` key,
      `{type:'local',command:[argv],environment}`). Paths/formats were taken from the agents' own
      docs and schema (Kiro MCP docs, Gemini CLI docs, opencode `config.json` `McpLocalConfig`,
      Devin Desktop MCP docs) rather than guessed. Safety rules inherited from the Claude path: a
      config that exists but does not parse aborts (never `{}`), only the named entry is touched, a
      file is CREATED only when the agent dir exists and the path is unambiguous, `opencode.jsonc`
      with comments is reported (`skipped-jsonc`) instead of rewritten, writes keep the original
      mode (0600 for new files). Codex (TOML `[mcp_servers]`), Continue (array under
      `experimental.mcpServers`) and Copilot (repo-scoped) are listed as **not projected with the
      reason** in `keyflip mcpreg surfaces` and the MCP tool. Tests: `test/mcpreg.test.js` +
      CLI/MCP parity in `test/mcp.test.js`.

## C. Command Code — one login for the CLI and the VS Code extension (shipped)

`cmd` (npm `command-code`) has accounts on every surface; it keeps **one** `~/.commandcode/auth.json`
that both the CLI and the shipped VS Code extension read, so a switch flips both.

- [x] Credential adapter `src/commandcode.js` + `keyflip commandcode status|list|capture|switch|
      backups|restore|remove` (alias `command-code`): capture to `~/.config/keyflip/surfaces/
      command-code/<slug>/` (auth.json 0600 + secret-free meta.json), outgoing-account capture and a
      timestamped backup before every switch, atomic 0600 write verified by byte-identical read-back
      *and* userId/userName identity, 10-backup retention, `remove` requires `--force`. The live env
      var `COMMAND_CODE_API_KEY` and a `cmd` binary on another fnm/nvm Node version are both reported
      because they defeat a switch. Live `status` verified on this machine.
- [x] Conversations: `foreign`/`conv` read `~/.commandcode/projects/<slug>/*.jsonl` in **both** live
      formats — v1 flat (`sessionId`/`role`/`content`) and v3 (`{type:'session'}` header + `{type:
      'message',message:{…}}`, blocks `text`/`thinking`/`tool_use`/`tool_result`), title from
      `<id>.meta.json`, `.checkpoints.jsonl` sidecars skipped, resume `cmd --resume <id>`. Verified on
      the real install: 19/19 session files parse, 16 carry a cwd.
- [x] `surface.js` / `agents.js` detection row (switchable, secret store `~/.commandcode/auth.json`),
      `mcpreg` projection to `~/.commandcode/mcp.json` (`mcpServers`), 4 MCP tools
      (`keyflip_commandcode` RO + `_capture`/`_switch`/`_remove` confirm-gated), EN/TR docs,
      CHANGELOG, SKILL, website CLI reference, tests.
- [ ] Live write path (capture/switch on a second real account) — only read-only `status` has been
      run here; the first real capture is the owner's.

## D. Hardware / account validation — build-done, needs a real device/account

Everything below is BUILT + unit-tested; it just cannot be validated in this environment.

- [ ] **Linux app-auth** live test (`secret-tool`/libsecret cookie path; shared v10 blob).
- [ ] **Windows app-auth** live test — confirm exact `Local State` + token-cache paths on a real install.
- [ ] **Linux tray** (GNOME Argos / KDE kargos) — render/click on a real desktop.
- [ ] **SSO org-login** live round-trip (`claude auth login --sso` against a real enterprise org).
- [ ] **Gemini brain** live round-trip — real `GEMINI_API_KEY`, verify a real plan comes back.
- [ ] **JetBrains plugin** — `./gradlew test` + `runIde` (generate `gradle-wrapper.jar` once); verify
      the Terminal API + status-bar/widget signatures on the target IntelliJ version.
- [ ] **provusage** live-API provider shapes — gemini/openrouter/cursor/copilot/opencode endpoints +
      response shapes (codex is the verified real path).
- [ ] **Windsurf / Kiro** session-import format (`foreign.js` NEEDS-VERIFICATION) — confirm their
      on-disk chat/session store, then wire the import.

## E. Release

- [x] **Push** — `main` tracks `origin/main` and is in sync; every landed commit is on the remote.
      New work is committed and pushed per feature, not batched.
