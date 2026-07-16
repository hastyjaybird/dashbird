#!/usr/bin/env bash
# Nightly (or on-demand) backup of dashbird data on the cloud host.
# Intended to run ON the VPS via cron, e.g.:
#   15 3 * * * /opt/dashbird/scripts/cloud-backup.sh >> /var/log/dashbird-backup.log 2>&1
#
# Keeps the last KEEP_DAYS of tarballs under BACKUP_DIR.
set -euo pipefail

ROOT="${DASHBIRD_ROOT:-/opt/dashbird}"
BACKUP_DIR="${DASHBIRD_BACKUP_DIR:-/var/backups/dashbird}"
KEEP_DAYS="${DASHBIRD_BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR}/dashbird-data-${STAMP}.tar.gz"

mkdir -p "$BACKUP_DIR"

# Consistent SQLite snapshots when sqlite3 is available.
if command -v sqlite3 >/dev/null 2>&1; then
  for db in events-finder.db network.db telegram-intake.db; do
    src="${ROOT}/data/${db}"
    if [[ -f "$src" ]]; then
      sqlite3 "$src" ".backup '${ROOT}/data/${db}.bak'"
    fi
  done
fi

tar -czf "$OUT" \
  -C "$ROOT" \
  --exclude='data/**/*.bak' \
  data \
  public/data/bookmarks-personal.json \
  public/data/notes.md \
  2>/dev/null || tar -czf "$OUT" -C "$ROOT" data

# Prune old backups
find "$BACKUP_DIR" -type f -name 'dashbird-data-*.tar.gz' -mtime "+${KEEP_DAYS}" -delete 2>/dev/null || true

# Touch last-backup marker for the health sidebar (optional).
date -Iseconds > "${ROOT}/public/data/last-backup.txt" 2>/dev/null || true

echo "[dashbird] backup ok: ${OUT}"
