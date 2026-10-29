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
- [ ] Adversarial review (secret-in-skill leak, path traversal into an agent's config dir, integrity
      spoofing, install-without-confirm) → fix → regression tests. *(tests exist for secret refusal,
      path check, edited-copy protection; an independent review is still open)*
- [ ] MCP-server distribution to other agents (today `mcpreg` projects into Claude Code + Desktop
      only); needs RoleCraft's per-agent `mcp` configPath/format table.

## C. Hardware / account validation — build-done, needs a real device/account

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

## D. Release

- [ ] **Push** the local commits to `origin` (owner's explicit go — nothing has been pushed).
