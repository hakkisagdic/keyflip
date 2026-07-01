# ccswitch for VS Code

Status-bar companion for [ccswitch](https://github.com/hakkisagdic/ccswitch): shows
the active Claude account and switches accounts with two clicks.

> The VS Code **Claude Code extension shares the CLI's credential store**, so a
> ccswitch switch already applies to it — this extension is just convenience UI.

## Requirements

- `ccswitch` installed and on PATH (or set `ccswitch.path` in settings)
- At least one account saved (`ccswitch add`)

## Features

- **Status bar**: active account at a glance (hover for CLI + desktop-app detail)
- **Click / `ccswitch: Switch Claude Account`**: QuickPick of saved accounts →
  confirm → switch (closes/reopens the desktop app if needed) → offers a window
  reload so the Claude extension picks up the new login

## Install (local, no marketplace)

```bash
cd vscode-ccswitch
npx --yes @vscode/vsce package        # produces ccswitch-vscode-<version>.vsix
code --install-extension ccswitch-vscode-*.vsix
```

Marketplace publishing requires a publisher account and is not set up yet.
