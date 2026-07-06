# keyflip for VS Code

Status-bar companion for [keyflip](https://github.com/hakkisagdic/keyflip): shows
the active Claude account, switches accounts, and opens the local dashboard — all
without leaving the editor.

> 🇹🇷 [Türkçe README](README.tr.md)

> The VS Code **Claude Code extension shares the CLI's credential store**, so a
> keyflip switch already applies to it — this extension is just convenience UI.

## Requirements

- `keyflip` installed and on PATH (or set `keyflip.path` in settings)
- At least one account saved (`keyflip add`)

## Features

- **Status bar**: active account at a glance (hover for CLI + desktop-app + active
  provider). Refreshes every 60 s; network-free (no quota fetch on the hot path).
- **`keyflip: Switch Claude Account`** (also the status-bar click): a QuickPick of
  saved accounts showing capture state (`cli ✓ | app ✓`) and current 5h/7d quota →
  confirm → switch (closes/reopens the desktop app if needed) → offers a window
  reload so the Claude extension picks up the new login.
- **`keyflip: Open Dashboard`**: launches `keyflip panel --open` in an integrated
  terminal (the local read-only web dashboard; Ctrl-C stops it).
- **`keyflip: Show Account Status`**: full CLI + desktop-app + provider status in an
  output channel.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `keyflip.path` | `keyflip` | Path to the keyflip executable (resolve from PATH by default). |

## Install (local, no marketplace)

```bash
cd vscode-keyflip
npx --yes @vscode/vsce package        # produces keyflip-vscode-<version>.vsix
code --install-extension keyflip-vscode-*.vsix
```

Marketplace publishing requires a publisher account and is not set up yet.

## Development

All logic that can run without the VS Code host lives in [`lib.js`](lib.js) (output
parsing + view-model shaping) and is unit-tested from the parent repo
(`node --test test/vscode-lib.test.js`). `extension.js` is the thin VS Code glue.
