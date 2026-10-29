# Credits

keyflip stands on the shoulders of prior open-source work. This file records
attribution for approaches and ideas we reimplemented.

## CodexBar — multi-provider usage / limit detection

- Project: **CodexBar** — https://github.com/steipete/CodexBar
- Author: Peter Steinberger (@steipete) and contributors
- License: **MIT**

CodexBar is a macOS menu-bar app that surfaces AI coding-provider usage limits
and reset windows across many providers (Codex/OpenAI, Claude, Cursor, Copilot,
Gemini, opencode, OpenRouter, and more) by reading each tool's own local config
/ cache files, running its CLI, or calling its usage API.

keyflip's `src/provusage.js` (a zero-dependency, multi-provider usage/limit
reader) **reimplements the CAPABILITY** of CodexBar — the idea of a normalized,
per-provider registry that detects presence and reads usage windows + reset
times from each provider's own known local surfaces — in original,
zero-dependency Node.js. **No CodexBar Swift source was transliterated.** Only
the approach (which local files/CLIs/endpoints hold usage data, and how to
normalize them into a common "windows + resetsAt" shape) was adapted.

Thank you to the CodexBar authors for mapping out where each provider keeps its
usage data.

## RoleCraft — per-agent skill directory registry

- Project: **RoleCraft** — https://github.com/sametcelikbicak/rolecraft
- Author: Samet Çelikbicak and contributors
- License: **MIT**

RoleCraft is a catalog of role definitions and an installer that knows where 90+
AI coding agents keep their skills, MCP configuration and instruction files, plus
a per-agent support level and last-verified date.

keyflip's `src/skillsync.js` reuses **the registry knowledge** — which tool reads
skills from which HOME-level directory, and which tools share one (`~/.agents/skills`
serves Codex, Warp, Goose, Zed, …) — as a static table. The install/verify/sync
logic is keyflip's own (SHA-256 per target, secret refusal, edited-copy protection).
RoleCraft's project-level-only targets (Copilot, Devin, Replit, …) are deliberately
absent because keyflip cannot know your repositories. Support levels are carried as
labels from RoleCraft; they are **not** a keyflip verification claim.

Thank you to the RoleCraft authors for doing the catalogue work.

