# keyflip Architecture

**English** | [Turkce](./ARCHITECTURE.tr.md)

> A comprehensive overview of keyflip's internal architecture, module organization,
> data flow, security model, and cross-platform strategy.

---

## Table of Contents

- [Directory Layout](#directory-layout)
- [Module Categories](#module-categories)
- [Data Flow: Account Switching](#data-flow-account-switching)
- [Security Model](#security-model)
- [Cross-Platform Strategy](#cross-platform-strategy)
- [Extension Points](#extension-points)

---

## Directory Layout

```
keyflip/
├── bin/               CLI entry point (keyflip.js)
├── src/               Source modules (100+ files)
├── test/              Test suite (node:test, 1200+ tests)
├── docs/              Additional documentation
├── skills/            Claude Code skill definitions
├── issuer/            License issuer skeleton
├── .github/workflows/ CI (ci.yml) and publishing (publish.yml)
└── package.json       Zero runtime dependencies
```

### Key Directories

| Directory | Purpose |
|-----------|---------|
| `bin/` | Single entry point (`keyflip.js`) that bootstraps the CLI |
| `src/` | All application logic, organized by responsibility |
| `test/` | Mirrors `src/` structure with unit and integration tests |
| `docs/` | Extended documentation (architecture, use cases, SSO, porting) |
| `skills/` | Claude Code skill definitions for AI-assisted workflows |
| `issuer/` | License issuer service skeleton |

---

## Module Categories

keyflip's `src/` directory contains 100+ modules organized into logical categories:

### Core Account Management

The foundation of keyflip - manages profiles, configuration, and CLI commands.

| Module | Responsibility |
|--------|---------------|
| `core.js` | Central orchestration, profile activation, and account switching logic |
| `profiles.js` | Profile CRUD operations, profile storage, and validation |
| `cli.js` | CLI argument parsing and command dispatch |
| `commands.js` | Command registry and handler definitions |
| `config.js` | Configuration file management (paths, defaults, read/write) |
| `menu.js` | Interactive menu system for profile selection |
| `platform.js` | Platform detection and OS-specific path resolution |
| `lock.js` | File locking for concurrent access prevention |
| `txn.js` | Transactional operations with rollback support |

### Providers

Multi-provider support for different AI services and routing logic.

| Module | Responsibility |
|--------|---------------|
| `provider.js` | Provider abstraction and registration |
| `provusage.js` | Per-provider usage tracking and analytics |
| `proxy.js` | Proxy configuration and tunneling |
| `router.js` | Request routing across multiple providers |
| `breaker.js` | Circuit breaker pattern for provider failover |

### Sessions

Session lifecycle management, transcript handling, and recall.

| Module | Responsibility |
|--------|---------------|
| `session.js` | Single session lifecycle (create, resume, end) |
| `sessions.js` | Session collection management and listing |
| `sessionmap.js` | Session-to-profile mapping |
| `sessionedit.js` | Session metadata editing |
| `transcript.js` | Conversation transcript storage and retrieval |
| `recall.js` | Session recall and search across transcripts |

### Fleet and Transfer

Multi-device synchronization, team management, and data transfer.

| Module | Responsibility |
|--------|---------------|
| `fleet.js` | Fleet management (multiple devices/instances) |
| `transfer.js` | Profile transfer between devices |
| `lantransfer.js` | LAN-based local network transfer |
| `relaytransfer.js` | Relay-based transfer through intermediary |
| `relayserver.js` | Relay server implementation |
| `sync.js` | Configuration synchronization |
| `teampool.js` | Team account pooling and shared access |

### Context Layer

Project-aware context management, checkpointing, and collaboration.

| Module | Responsibility |
|--------|---------------|
| `context.js` | Context abstraction and lifecycle |
| `projctx.js` | Project-specific context binding |
| `checkpoint.js` | State checkpointing and restore |
| `ctxsync.js` | Context synchronization across sessions |
| `handoff.js` | Session handoff between agents/users |
| `rulesmodel.js` | Rules model for context-aware switching |

### Security

Credential storage, secret scanning, OAuth, and encryption.

| Module | Responsibility |
|--------|---------------|
| `secretscan.js` | Secret detection and redaction in outputs |
| `secretpaths.js` | Known secret file path definitions |
| `vault.js` | Encrypted credential vault |
| `wincrypt.js` | Windows DPAPI credential encryption |
| `oauth.js` | OAuth flow implementation |
| `login.js` | Authentication and login handling |

### Desktop and Browser Integration

Claude desktop app, browser automation, and app-level session management.

| Module | Responsibility |
|--------|---------------|
| `claude.js` | Claude desktop application integration |
| `appauth.js` | Desktop app authentication |
| `appsessions.js` | Desktop app session management |
| `browser.js` | Browser profile and cookie management |
| `chat.js` | Chat interface integration |
| `cowork.js` | Co-working and collaboration features |
| `desktopgw.js` | Desktop gateway for cross-app communication |

### TUI and Panel

Terminal UI components and visual presentation.

| Module | Responsibility |
|--------|---------------|
| `tui.js` | Terminal UI framework and rendering |
| `panel.js` | Panel layout and composition |
| `style.js` | ANSI styling and color management |
| `menubar.js` | Menu bar component |

### MCP (Model Context Protocol)

MCP server integration for AI tool interoperability.

| Module | Responsibility |
|--------|---------------|
| `mcp.js` | MCP server implementation |
| `mcpreg.js` | MCP server registration and discovery |

### Utilities

File system helpers, encoding, data format readers, and miscellaneous tools.

| Module | Responsibility |
|--------|---------------|
| `fsutil.js` | File system utilities (safe read/write, temp files) |
| `qr.js` | QR code generation for transfer links |
| `embed.js` | Embedding utilities |
| `llm.js` | LLM interaction helpers |
| `sqliteread.js` | SQLite database reader (for Claude local DB) |
| `yamlread.js` | YAML file parser |
| `walmerge.js` | WAL (Write-Ahead Log) merge operations |

### Other Modules

Specialized features spanning automation, monitoring, and system integration.

| Module | Responsibility |
|--------|---------------|
| `autoswitch.js` | Automatic account switching based on rules |
| `autoswitchservice.js` | Background service for auto-switching |
| `backup.js` | Profile backup and restore |
| `brain.js` | Intelligent decision engine |
| `budget.js` | Usage budget management |
| `cost.js` | Cost tracking and estimation |
| `doctor.js` | System health diagnostics |
| `groups.js` | Profile group management |
| `history.js` | Command and switch history |
| `license.js` | License validation and management |
| `links.js` | Shareable link generation |
| `log.js` | Structured logging |
| `memory.js` | Persistent memory store |
| `migrate.js` | Configuration migration between versions |
| `notify.js` | Notification system (desktop, terminal) |
| `onboard.js` | First-run onboarding flow |
| `orchestrator.js` | Multi-step operation orchestration |
| `policy.js` | Access policy enforcement |
| `schedule.js` | Scheduled operations (rotation, cleanup) |
| `share.js` | Profile sharing between users |
| `shellhook.js` | Shell hook integration (cd, prompt) |
| `skill.js` | Skill definition and execution |
| `skillstore.js` | Skill marketplace and storage |
| `surface.js` | Surface detection (terminal, IDE, desktop) |
| `swarm.js` | Multi-agent swarm coordination |
| `uninstall.js` | Clean uninstall handler |
| `update.js` | Self-update mechanism |
| `usage.js` | Usage statistics and reporting |
| `vcs.js` | Version control system integration |
| `wsl.js` | Windows Subsystem for Linux support |

---

## Data Flow: Account Switching

The core operation of keyflip is switching between AI tool accounts. Here is the complete flow:

```
User Request (CLI / TUI / Auto-trigger)
        │
        ▼
┌─────────────────┐
│    cli.js       │  Parse command and arguments
│    commands.js  │  Dispatch to handler
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│    core.js      │  Orchestrate the switch
│    lock.js      │  Acquire file lock (prevent concurrent switches)
│    txn.js       │  Begin transactional operation
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   profiles.js   │  Load target profile credentials
│   config.js     │  Read/update configuration files
│   platform.js   │  Resolve OS-specific credential paths
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   vault.js      │  Decrypt credentials from vault
│   wincrypt.js   │  (Windows) Use DPAPI for decryption
│   secretscan.js │  Scan for accidental secret exposure
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   claude.js     │  Write credentials to Claude config
│   browser.js    │  Update browser session cookies
│   appsessions.js│  Sync desktop app sessions
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   session.js    │  Create/update session record
│   history.js    │  Log the switch event
│   notify.js     │  Send notification
└─────────────────┘
```

### Key Design Principles

1. **Transactional Safety**: Every switch operation is wrapped in a transaction (`txn.js`). If any step fails, the entire operation rolls back to the previous state.

2. **Lock-based Concurrency**: File locks (`lock.js`) prevent multiple keyflip instances from modifying credentials simultaneously.

3. **Platform Abstraction**: `platform.js` resolves all OS-specific paths and behaviors, allowing the core logic to remain platform-agnostic.

4. **Credential Isolation**: Credentials are never held in memory longer than necessary. The vault decrypts on demand and clears after use.

---

## Security Model

### Credential Storage

- **Vault encryption**: Credentials are stored in an encrypted vault (`vault.js`) using platform-native encryption where available
- **Windows DPAPI**: On Windows, `wincrypt.js` leverages the Data Protection API for hardware-bound encryption
- **File permissions**: Configuration files are written with restrictive permissions (600/700)

### Secret Scanning

- **Output scanning**: `secretscan.js` scans all outputs for accidental credential leakage
- **Path detection**: `secretpaths.js` maintains a registry of known secret file locations
- **Redaction**: Detected secrets are replaced with `keyflip_redacted` markers

### Transactional Integrity

- **Atomic operations**: `txn.js` ensures that profile switches are atomic - either fully complete or fully rolled back
- **Lock files**: `lock.js` prevents race conditions in concurrent access scenarios
- **Backup on switch**: Previous state is preserved before any modification

### Access Control

- **Policy enforcement**: `policy.js` can restrict which profiles are accessible in which contexts
- **Budget limits**: `budget.js` enforces usage caps to prevent runaway spending
- **Audit trail**: `history.js` maintains a complete log of all operations

---

## Cross-Platform Strategy

keyflip supports macOS, Linux, and Windows with a unified codebase:

### Platform Detection (`platform.js`)

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   macOS     │     │    Linux     │     │   Windows   │
├─────────────┤     ├──────────────┤     ├─────────────┤
│ ~/Library/  │     │ ~/.config/   │     │ %APPDATA%   │
│ Keychain    │     │ Secret Svc   │     │ DPAPI       │
│ launchd     │     │ systemd      │     │ Task Sched  │
└─────────────┘     └──────────────┘     └─────────────┘
        │                   │                    │
        └───────────────────┼────────────────────┘
                            │
                    ┌───────┴───────┐
                    │  platform.js  │
                    │  (abstraction)│
                    └───────────────┘
```

### Key Platform Differences

| Concern | macOS | Linux | Windows |
|---------|-------|-------|---------|
| Config path | `~/Library/Application Support/` | `~/.config/` | `%APPDATA%` |
| Credential encryption | Keychain Access | libsecret | DPAPI (`wincrypt.js`) |
| Background service | launchd | systemd | Task Scheduler |
| Shell integration | zsh/bash | bash/zsh/fish | PowerShell/cmd |
| WSL support | N/A | N/A | `wsl.js` |

### CI Matrix

The GitHub Actions CI pipeline tests across all supported platforms and Node.js versions:

- **OS**: ubuntu-latest, macos-latest, windows-latest
- **Node.js**: 18, 20, 22

---

## Extension Points

### MCP Server (`mcp.js`, `mcpreg.js`)

keyflip exposes an MCP (Model Context Protocol) server, allowing AI tools to programmatically manage accounts. This enables:
- Automated account switching from within AI sessions
- Tool-driven profile queries
- Integration with any MCP-compatible client

### Auto-Switch Rules (`autoswitch.js`, `rulesmodel.js`)

Automatic profile switching based on:
- Working directory (project-based)
- Git remote URL
- Time-based schedules
- Cost/budget thresholds

### Skills System (`skill.js`, `skillstore.js`)

Extensible skill system for adding new capabilities:
- Custom switching strategies
- Provider-specific logic
- Team workflow automation

---

## Design Philosophy

1. **Zero runtime dependencies**: The entire application runs on Node.js built-ins only, minimizing supply chain risk and ensuring fast installs.

2. **ES Modules throughout**: Modern JavaScript with full ESM, enabling tree-shaking awareness and clean import/export boundaries.

3. **Test-first approach**: 1200+ tests using Node.js built-in test runner, no external test framework needed.

4. **Progressive disclosure**: Simple `keyflip switch` for basic use, with deep features available for power users and teams.

5. **Security by default**: Encrypted storage, secret scanning, and transactional safety are always active - not opt-in features.
