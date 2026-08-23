# GitHub Labels

**English** | [Turkce](./LABELS.tr.md)

> Recommended GitHub labels for the keyflip repository. Use these labels
> consistently to categorize issues and pull requests.

---

## Issue Type

| Label | Color | Description |
|-------|-------|-------------|
| `bug` | `#d73a4a` | Something isn't working |
| `feature` | `#a2eeef` | New feature or request |
| `enhancement` | `#84b6eb` | Improvement to existing functionality |
| `docs` | `#0075ca` | Documentation improvements |
| `question` | `#d876e3` | Further information is requested |
| `discussion` | `#f9d0c4` | Open-ended discussion topic |

## Priority

| Label | Color | Description |
|-------|-------|-------------|
| `priority: critical` | `#b60205` | Must be fixed immediately |
| `priority: high` | `#d93f0b` | Should be addressed in the current cycle |
| `priority: medium` | `#fbca04` | Important but not urgent |
| `priority: low` | `#0e8a16` | Nice to have, address when possible |

## Platform

| Label | Color | Description |
|-------|-------|-------------|
| `platform: macos` | `#c5def5` | Specific to macOS |
| `platform: linux` | `#c5def5` | Specific to Linux |
| `platform: windows` | `#c5def5` | Specific to Windows |
| `platform: wsl` | `#c5def5` | Specific to Windows Subsystem for Linux |

## Module Area

| Label | Color | Description |
|-------|-------|-------------|
| `area: core` | `#d4c5f9` | Core account switching logic |
| `area: providers` | `#d4c5f9` | Provider system and routing |
| `area: sessions` | `#d4c5f9` | Session management |
| `area: fleet` | `#d4c5f9` | Fleet and transfer features |
| `area: security` | `#d4c5f9` | Security, vault, and secret scanning |
| `area: tui` | `#d4c5f9` | Terminal UI and panel |
| `area: mcp` | `#d4c5f9` | MCP server integration |
| `area: desktop` | `#d4c5f9` | Desktop and browser integration |
| `area: context` | `#d4c5f9` | Context layer and project awareness |
| `area: cli` | `#d4c5f9` | CLI commands and argument parsing |

## Workflow

| Label | Color | Description |
|-------|-------|-------------|
| `good first issue` | `#7057ff` | Good for newcomers |
| `help wanted` | `#008672` | Extra attention is needed |
| `wontfix` | `#ffffff` | This will not be worked on |
| `duplicate` | `#cfd3d7` | This issue or pull request already exists |
| `invalid` | `#e4e669` | This doesn't seem right |

## Status

| Label | Color | Description |
|-------|-------|-------------|
| `status: triage` | `#ededed` | Needs triage and categorization |
| `status: blocked` | `#b60205` | Blocked by another issue or external dependency |
| `status: in-progress` | `#fbca04` | Currently being worked on |
| `status: needs-review` | `#0e8a16` | Ready for review |
| `status: stale` | `#ededed` | No recent activity |

## CI/CD

| Label | Color | Description |
|-------|-------|-------------|
| `ci` | `#f9d0c4` | Related to CI/CD pipelines |
| `dependencies` | `#0366d6` | Dependency updates |
| `breaking-change` | `#b60205` | Introduces a breaking change |
| `release` | `#0e8a16` | Related to releases |

---

## Usage Guidelines

1. **Every issue** should have at least one type label (`bug`, `feature`, `docs`, etc.)
2. **Every issue** should have a priority label once triaged
3. **Platform labels** are optional - add only when the issue is platform-specific
4. **Area labels** help route issues to the right maintainer
5. **Status labels** track the lifecycle of an issue

## Applying Labels via CLI

```bash
# Create a label
gh label create "priority: high" --color "d93f0b" --description "Should be addressed in the current cycle"

# List all labels
gh label list

# Apply a label to an issue
gh issue edit 42 --add-label "bug,priority: high,platform: macos"
```
