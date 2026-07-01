#!/usr/bin/env bash
# ccswitch installer for macOS / Linux (Windows: use install.ps1).
#
# One-liner (public repo):
#   curl -fsSL https://raw.githubusercontent.com/hakkisagdic/ccswitch/main/install.sh | bash
# From a clone:
#   ./install.sh
#
# It fetches the (dependency-free) sources into ~/.local/share/ccswitch, links the
# `ccswitch` command into ~/.local/bin, and on macOS builds a launcher app.
set -euo pipefail

REPO_OWNER="${CCSWITCH_OWNER:-hakkisagdic}"
REPO_NAME="${CCSWITCH_REPO:-ccswitch}"
REPO_REF="${CCSWITCH_REF:-main}"
GIT_URL="https://github.com/$REPO_OWNER/$REPO_NAME.git"
TARBALL_URL="https://github.com/$REPO_OWNER/$REPO_NAME/archive/refs/heads/$REPO_REF.tar.gz"

INSTALL_DIR="${CCSWITCH_DIR:-$HOME/.local/share/ccswitch}"
BIN_DIR="${CCSWITCH_BIN_DIR:-$HOME/.local/bin}"
APP_DIR="${CCSWITCH_APP_DIR:-$HOME/Applications}"
APP_NAME="Claude Account Switcher"

info(){ printf '%s\n' "$*"; }
die(){ printf 'error: %s\n' "$*" >&2; exit 1; }

OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) : ;;
  *) die "Unsupported OS '$OS'. On Windows run install.ps1." ;;
esac
command -v node >/dev/null 2>&1 || die "Node.js (>=18) is required. Install it and re-run."

# Are we running from a checkout (has the sources next to us) or piped from the web?
SELF_DIR=""
if [ -n "${BASH_SOURCE:-}" ] && [ -f "${BASH_SOURCE[0]:-}" ]; then
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

info "Installing ccswitch ..."
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR" "$BIN_DIR"

if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/package.json" ] && [ -f "$SELF_DIR/bin/ccswitch.js" ]; then
  cp -R "$SELF_DIR/bin" "$SELF_DIR/src" "$SELF_DIR/package.json" "$INSTALL_DIR/"
  info "  • source -> local checkout"
else
  # Remote install: try git, then fall back to a tarball (like nvm). Either works
  # for a public repo without auth.
  fetched=0
  if command -v git >/dev/null 2>&1; then
    if git clone -q --depth 1 --branch "$REPO_REF" "$GIT_URL" "$INSTALL_DIR" 2>/dev/null \
       || { rm -rf "$INSTALL_DIR"; git clone -q --depth 1 "$GIT_URL" "$INSTALL_DIR" 2>/dev/null; }; then
      fetched=1; info "  • source -> git clone"
    fi
  fi
  if [ "$fetched" -eq 0 ] && command -v curl >/dev/null 2>&1; then
    rm -rf "$INSTALL_DIR"; mkdir -p "$INSTALL_DIR"
    if curl -fsSL "$TARBALL_URL" | tar xz -C "$INSTALL_DIR" --strip-components=1; then
      fetched=1; info "  • source -> tarball"
    fi
  fi
  [ "$fetched" -eq 1 ] || die \
"could not fetch ccswitch (no network, or the repo is private).
Manual install: gh repo clone $REPO_OWNER/$REPO_NAME && cd $REPO_NAME && ./install.sh"
fi

[ -f "$INSTALL_DIR/bin/ccswitch.js" ] || die "install payload is missing bin/ccswitch.js"
chmod +x "$INSTALL_DIR/bin/ccswitch.js"
ln -sf "$INSTALL_DIR/bin/ccswitch.js" "$BIN_DIR/ccswitch"
CCS_BIN="$BIN_DIR/ccswitch"
info "  • CLI  -> $BIN_DIR/ccswitch"

# Put BIN_DIR on PATH for future shells (only touch rc files that already exist).
ensure_path(){   # returns 0 only if it actually appended
  local rc="$1"
  [ -f "$rc" ] || return 1
  grep -q 'ccswitch PATH' "$rc" 2>/dev/null && return 1
  grep -qF "$BIN_DIR" "$rc" 2>/dev/null && return 1
  { printf '\n# ccswitch PATH\n'; printf 'export PATH="%s:$PATH"\n' "$BIN_DIR"; } >> "$rc"
  info "  • PATH -> added $BIN_DIR to $rc"
  return 0
}
path_done=0
if ensure_path "$HOME/.zshrc"; then path_done=1; fi
if ensure_path "$HOME/.bashrc"; then path_done=1; fi
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) [ "$path_done" -eq 1 ] || info "  • Note: add $BIN_DIR to your PATH to run 'ccswitch'." ;;
esac

# macOS: build a double-clickable launcher that opens the menu in Terminal.
if [ "$OS" = "Darwin" ] && command -v osacompile >/dev/null 2>&1; then
  mkdir -p "$APP_DIR"
  # The path is embedded inside shell single-quotes AND an AppleScript "..." literal.
  q="'"; esc="'\\''"
  CCS_SH=${CCS_BIN//$q/$esc}      # safe inside shell single quotes
  CCS_AS=${CCS_SH//\\/\\\\}       # AppleScript literal: escape backslashes
  CCS_AS=${CCS_AS//\"/\\\"}       # AppleScript literal: escape double quotes
  TMP_AS="${TMPDIR:-/tmp}/ccswitch-build-$$.applescript"
  cat > "$TMP_AS" <<AS
on run
	tell application "Terminal"
		activate
		do script "clear; '$CCS_AS' menu"
	end tell
end run
AS
  rm -rf "$APP_DIR/$APP_NAME.app"
  if osacompile -o "$APP_DIR/$APP_NAME.app" "$TMP_AS" >/dev/null 2>&1; then
    info "  • App  -> $APP_DIR/$APP_NAME.app"
  fi
  rm -f "$TMP_AS"
fi

info ""
info "✅ Installed."
info ""
info "Next steps:"
info "  1) In Claude, log in to your first account, then run:   ccswitch add"
info "  2) Claude /login to your other account, then run:        ccswitch add"
if [ "$OS" = "Darwin" ]; then
  info "  3) Switch anytime — open \"$APP_NAME\" (Launchpad/Spotlight), or run:  ccswitch"
else
  info "  3) Switch anytime:  ccswitch   (then restart Claude Code to apply)"
fi
info ""
info "Open a new terminal (or 'export PATH=\"$BIN_DIR:\$PATH\"') to use 'ccswitch' now."
