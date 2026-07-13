# keyflip — open work (actionable backlog)

The historical "what shipped" record lives in [roadmap.md](roadmap.md). This file is the
forward-looking, checkable task list. Check items off as they land.

---

## A. Productization — NOT built yet

The paywall (`license.js`, env-gated OFF via `KEYFLIP_LICENSING`) and the payment **issuer skeleton**
(`issuer/`: Ed25519 signer + Stripe/LemonSqueezy/iyzico/PayTR webhook adapters + node:http relay) exist.
These do not:

- [ ] **Website** — marketing/landing + docs + checkout flow (per the 4-provider decision in
      `docs/PRODUCTIZATION.md`: iyzico + PayTR local, Lemon Squeezy + Stripe global).
- [ ] **Admin panel** — license/customer management (issue, revoke, look up; webhook event log).
- [ ] **Issuer activation** (owner/business step, not code): generate the real Ed25519 keypair →
      paste the public key into `src/license.js` `PUBKEY_B64`; sign up with the actual PSPs; set real
      product/price IDs in `issuer/issuer.config.json`. Then flip `KEYFLIP_LICENSING=1`.

## B. RoleCraft integration — cross-agent skill/role + MCP distribution (NEW)

Absorb the capability of **RoleCraft** (github.com/sametcelikbicak/rolecraft — zero-dep JS CLI, MIT):
install/sync AI-agent **skills (SKILL.md) + MCP servers** across **all detected agents** (82+ targets:
Cursor, Gemini, Codex, Copilot, opencode, Windsurf, Kiro, Aider, …), not just Claude Code — so every
account's assets travel everywhere. Port the approach (zero-dep, MIT-attributed in `CREDITS.md`), the
same way `provusage.js` ported CodexBar. Goal (owner's words): "convert all assets of all accounts."

- [ ] Read RoleCraft's real surface (targets registry, SKILL.md schema, security scan, lockfile,
      `agents-xml`); decide port vs adapter. Confirm the target-agent config-dir map against
      keyflip's existing `agents.js` REGISTRY + `surface.js` SURFACES.
- [ ] New `src/rolecraft.js` (or extend `agents.js`/`skills`): install a skill/MCP-server to N detected
      agents from any source (local/GitHub/npm), with SHA256 integrity + a lockfile, security-scanned
      (reuse `secretscan.js` where possible) — never install a skill carrying a secret.
- [ ] CLI: extend `keyflip skill` (today Claude-Code-only) to a cross-agent `keyflip skill add <src>
      [--agents a,b|--all]`, `skill sync`, `skill list --all`, `skill remove`, plus MCP-server
      distribution via the existing `mcpreg`. Bilingual docs (README EN/TR + SKILL).
- [ ] MCP tools for agents (mutating → confirm-gated), in lockstep with docs.
- [ ] Adversarial review (secret-in-skill leak, path traversal into an agent's config dir, integrity
      spoofing, install-without-confirm) → fix → regression tests.

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
