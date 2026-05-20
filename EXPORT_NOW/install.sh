#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/icons/DashbirdChase"

if [[ ! -d "$ROOT/DashbirdChase/cursors" ]]; then
  echo "Building cursors…" >&2
  python3 "$ROOT/generate-dashbird-cursor.py"
fi

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -a "$ROOT/DashbirdChase" "$DEST"
echo "Installed to $DEST"

if command -v gsettings >/dev/null 2>&1; then
  gsettings set org.gnome.desktop.interface cursor-theme DashbirdChase
  gsettings set org.gnome.desktop.interface cursor-size 32
  echo "Set GNOME cursor theme to DashbirdChase (size 32)."
  echo "Log out and back in if the pointer does not update."
else
  echo "Pick DashbirdChase in your desktop cursor settings."
fi
