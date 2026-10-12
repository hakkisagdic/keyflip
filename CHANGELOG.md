# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

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

[Unreleased]: https://github.com/hakkisagdic/keyflip/compare/v1.5.2...HEAD
[1.5.2]: https://github.com/hakkisagdic/keyflip/compare/v1.5.0...v1.5.2
[1.5.0]: https://github.com/hakkisagdic/keyflip/releases/tag/v1.5.0
