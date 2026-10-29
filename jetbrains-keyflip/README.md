# keyflip for JetBrains IDEs

Companion plugin for [keyflip](https://github.com/hakkisagdic/keyflip): shows the active
Claude account in the status bar, switches accounts, lists them in a tool window, and opens
the local dashboard — all without leaving the IDE. The IntelliJ Platform port of the
[VS Code companion](../vscode-keyflip).

> 🇹🇷 [Türkçe README](README.tr.md)

> The IDE's Claude integration **shares the CLI's credential store**, so a keyflip switch
> already applies to it — this plugin is convenience UI. It **never handles tokens itself**:
> it only reads `keyflip --json` and runs the documented switch / rebind / panel commands.

## Requirements

- A JetBrains IDE on the IntelliJ Platform **2023.2+** (build 232+)
- `keyflip` installed and on PATH (or set the path in Settings)
- At least one account saved (`keyflip add`)

## Features

- **Status bar**: the active account at a glance (hover for CLI + desktop-app + active
  provider). Refreshes every 60 s; network-free (no quota fetch on the hot path). Shows a
  **warning (`⚠`) when the desktop app is on a different account than the CLI** (a mismatch a
  `--restart` switch would fix). **Click to switch.**
- **Claude Accounts tool window** (right dock): every saved account with the active one
  flagged and its quota shown; **double-click a row to switch** to it (confirms first).
  Refresh from the toolbar.
- **keyflip: Switch Claude Account** (also the status-bar click): a popup of saved accounts
  showing capture state (`cli ✓ | app ✓`) and current 5h/7d quota → confirm → switch
  (closes/reopens the desktop app if needed) → offers an **IDE restart** so the Claude
  integration picks up the new login.
- **keyflip: Re-link Chat History (moved folder)**: after you move/rename a project folder,
  re-link its Claude chat history to the new path (runs `keyflip sessions rebind`; defaults the
  new path to the project base directory).
- **keyflip: Open Dashboard**: launches `keyflip panel --open` in an integrated terminal
  (the local read-only web dashboard; Ctrl-C stops it).
- **keyflip: Show Account Status**: full CLI + desktop-app + provider status in a dialog.

All actions live under **Tools › keyflip**.

## Settings

Open **Settings/Preferences › Tools › keyflip**:

| Setting | Default | Meaning |
|---|---|---|
| Keyflip executable path | `keyflip` | Path to the keyflip executable (resolve from PATH by default). |

## Build & install (local, no Marketplace)

```bash
cd jetbrains-keyflip
./gradlew buildPlugin
# → build/distributions/jetbrains-keyflip-<version>.zip
```

Then in the IDE: **Settings/Preferences › Plugins › ⚙ › Install Plugin from Disk…** and pick
the zip from `build/distributions/`.

To run a sandbox IDE with the plugin loaded during development:

```bash
./gradlew runIde
```

> **Gradle wrapper JAR:** the binary `gradle/wrapper/gradle-wrapper.jar` is committed, so
> `./gradlew` works from a fresh clone with a JDK 17 on `JAVA_HOME` (the IntelliJ plugin builds
> against Java 17; a newer JDK is not enough for Kotlin 1.9). If the wrapper is ever missing,
> regenerate it with a system Gradle 8.x (`gradle wrapper --gradle-version 8.9`).
>
> **Turkish (or any non-English) system locale:** `gradle-intellij-plugin` 1.x uppercases
> `application` with the JVM's default locale, so on a tr_TR host the IDE's own plugin descriptor
> fails to parse as `APPLİCATİON` and the build stops with "Cannot find builtin plugin
> 'org.jetbrains.plugins.terminal'". `gradle.properties` pins `-Duser.language=en -Duser.country=US`
> for the Gradle JVM; if a daemon was already running under the old locale, stop it
> (`./gradlew --stop`) or run with `--no-daemon`.
>
> The plugin indexes the IDE's bundled plugins once and caches the result inside the **extracted
> IDE** (`~/.gradle/caches/modules-2/files-2.1/com.jetbrains.intellij.idea/ideaIC/<v>/<hash>/ideaIC-<v>/plugins/builtinRegistry-1.xml`).
> A cache written by a mis-locale run stays incomplete — `terminal` reads as missing even after the
> fix — so delete that one file and let the next build re-scan the directory.

Marketplace publishing requires a vendor account and is not set up yet.

## Development

All logic that can run without the IDE host lives in
[`KeyflipModels.kt`](src/main/kotlin/dev/keyflip/KeyflipModels.kt) (`--json` parsing +
view-model shaping — no IntelliJ imports) and is unit-tested in
[`KeyflipModelsTest.kt`](src/test/kotlin/dev/keyflip/KeyflipModelsTest.kt):

```bash
./gradlew test
```

`KeyflipCli.kt` shells out to the binary; the rest of `dev/keyflip/` is the thin IntelliJ glue
(status bar widget, tool window, actions, settings). It mirrors the VS Code companion's CLI
contracts and confirm-before-switch / restart-after-switch UX exactly.
