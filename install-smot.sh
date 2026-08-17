#!/usr/bin/env bash
# Install System Monitor on Top Panel (SMOT) into the user GNOME Shell
# extensions directory.
#
# Usage:
#   ./install-smot.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
UUID="smot@stretchenv.github.io"
SRC="$ROOT/$UUID"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
LEGACY_DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/smot@local"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--help]

  --help      Show this help.
EOF
}

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ! -d "$SRC" ]]; then
  echo "Source extension not found: $SRC" >&2
  exit 1
fi

if ! command -v glib-compile-schemas >/dev/null; then
  echo "glib-compile-schemas not found (install libglib2.0-bin)" >&2
  exit 1
fi

glib-compile-schemas "$SRC/schemas"

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
if [[ -d "$LEGACY_DEST" ]]; then
  echo "Removing previous install: $LEGACY_DEST"
  rm -rf "$LEGACY_DEST"
fi
cp -a "$SRC" "$DEST"

echo "Installed to: $DEST"
echo
echo "IMPORTANT (Wayland / GNOME 50):"
echo "  After code updates, disable/enable is NOT enough — Shell keeps the old"
echo "  JS module cached in memory. Log out and log back in to load changes."
echo
echo "Then enable SMOT:"
echo "  gnome-extensions enable $UUID"
echo "Open settings via:"
echo "  gnome-extensions prefs $UUID"
