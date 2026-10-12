#!/usr/bin/env bash
# keyflip uninstaller for macOS / Linux.
# Saved profiles are kept unless you pass --purge.
set -euo pipefail

SHARE_DIR="${KEYFLIP_DIR:-${KEYFLIP_SHARE_DIR:-$HOME/.local/share/keyflip}}"
BIN_DIR="${KEYFLIP_BIN_DIR:-$HOME/.local/bin}"
APP_DIR="${KEYFLIP_APP_DIR:-$HOME/Applications}"
APP_NAME="Keyflip"
CONFIG_DIR="${KEYFLIP_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/keyflip}"
KC_PREFIX="keyflip:"
KC_ACCT="${USER:-$(id -un)}"

info(){ printf '%s\n' "$*"; }

removed_any=0
# Global npm install (if that's how it was installed). An `npm link` from a source
# checkout is a developer's live install, not ours to remove — leave it (and say so).
if command -v npm >/dev/null 2>&1; then
  if NPM_LS="$(npm ls --global --depth=0 keyflip 2>/dev/null)"; then
    # `npm ls` marks a link as "keyflip@x.y.z -> <target>". (Don't build a path from
    # `npm root`: npm masks UUID-looking path segments as *** in its output.)
    if printf '%s\n' "$NPM_LS" | grep -q 'keyflip@[^ ]* -> '; then
      info "• kept npm link to a source checkout (remove with: npm unlink --global keyflip)"
    else
      npm uninstall --global keyflip >/dev/null 2>&1 && { info "• removed npm global package"; removed_any=1; } || true
    fi
  fi
fi
# Local (copy) install.
if [ -L "$BIN_DIR/keyflip" ] || [ -e "$BIN_DIR/keyflip" ]; then
  rm -f "$BIN_DIR/keyflip"; info "• removed CLI: $BIN_DIR/keyflip"; removed_any=1
fi
if [ -L "$SHARE_DIR" ]; then
  # install.sh --link: only the link goes; the checkout it points at is untouched.
  rm -f "$SHARE_DIR"; info "• removed link: $SHARE_DIR"; removed_any=1
elif [ -d "$SHARE_DIR" ]; then
  rm -rf "$SHARE_DIR"; info "• removed files: $SHARE_DIR"; removed_any=1
fi
if [ -d "$APP_DIR/$APP_NAME.app" ]; then
  rm -rf "$APP_DIR/$APP_NAME.app"; info "• removed app: $APP_DIR/$APP_NAME.app"; removed_any=1
fi
[ "$removed_any" -eq 1 ] || info "• nothing to remove (already uninstalled?)"

if [ "${1:-}" = "--purge" ]; then
  # Delete macOS Keychain items for any profiles we can still name.
  if [ -d "$CONFIG_DIR" ] && command -v security >/dev/null 2>&1; then
    for f in "$CONFIG_DIR"/*.json; do
      [ -e "$f" ] || continue
      name="$(basename "$f" .json)"
      security delete-generic-password -s "$KC_PREFIX$name" -a "$KC_ACCT" >/dev/null 2>&1 || true
    done
  fi
  if [ -d "$CONFIG_DIR" ]; then rm -rf "$CONFIG_DIR"; info "• purged saved profiles: $CONFIG_DIR"; fi
else
  info ""
  info "Saved profiles were kept. Remove them too with:  ./uninstall.sh --purge"
  info "Also delete the '# keyflip PATH' block from ~/.zshrc / ~/.bashrc if present."
fi
