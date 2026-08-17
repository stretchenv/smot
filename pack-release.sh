#!/usr/bin/env bash
# Build a GNOME Shell extension zip suitable for EGO and
# `gnome-extensions install`.
#
# Layout inside the zip (files at archive root — no UUID wrapper):
#   metadata.json
#   extension.js
#   …
#
# Excludes compiled schemas.
# Copies ../LICENSE into the extension root when present.
#
# Usage:
#   ./pack-release.sh           # writes dist/<uuid>-v<version>.zip
#   ./pack-release.sh --help
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR_NAME="smot@stretchenv.github.io"
SRC="$ROOT/$SRC_DIR_NAME"
OUT_DIR="$ROOT/dist"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--out-dir DIR] [--help]

  --out-dir DIR   Output directory (default: dist/)
  --help          Show this help.

Reads uuid and version from $SRC_DIR_NAME/metadata.json.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir)
      [[ $# -ge 2 ]] || { echo "--out-dir needs a path" >&2; exit 1; }
      OUT_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$SRC/metadata.json" ]]; then
  echo "Missing metadata: $SRC/metadata.json" >&2
  exit 1
fi

if ! command -v zip >/dev/null; then
  echo "zip not found (install zip)" >&2
  exit 1
fi

# Prefer python3 for reliable JSON; fall back to a tiny node one-liner.
read_meta() {
  local key="$1"
  if command -v python3 >/dev/null; then
    python3 -c "import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])" \
      "$SRC/metadata.json" "$key"
  elif command -v node >/dev/null; then
    node -e "const m=require(process.argv[1]); process.stdout.write(String(m[process.argv[2]]));" \
      "$SRC/metadata.json" "$key"
  else
    echo "Need python3 or node to read metadata.json" >&2
    exit 1
  fi
}

UUID="$(read_meta uuid)"
VERSION="$(read_meta version)"

if [[ -z "$UUID" || -z "$VERSION" ]]; then
  echo "Could not read uuid/version from metadata.json" >&2
  exit 1
fi

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/smot-pack.XXXXXX")"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

# Copy tree, then strip packaging exclusions.
cp -a "$SRC/." "$STAGE/"

rm -f "$STAGE/schemas/gschemas.compiled"
find "$STAGE" -type f \( \
  -name '*.o' -o -name '*~' -o -name '*.swp' -o -name '.DS_Store' \
\) -delete 2>/dev/null || true

if [[ -f "$ROOT/LICENSE" ]]; then
  cp -a "$ROOT/LICENSE" "$STAGE/LICENSE"
fi

mkdir -p "$OUT_DIR"
ZIP_PATH="$OUT_DIR/${UUID}-v${VERSION}.zip"
rm -f "$ZIP_PATH"

# zip from STAGE so metadata.json is at the archive root (EGO / gnome-extensions).
(
  cd "$STAGE"
  zip -qr "$ZIP_PATH" .
)

echo "Created: $ZIP_PATH"
echo "Contents (top):"
unzip -l "$ZIP_PATH" | head -n 25
