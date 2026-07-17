#!/usr/bin/env bash
# Pull live cloud data/ down to local LAN dev (reverse of sync-to-cloud.sh).
# Usage:
#   CLOUD_HOST=root@YOUR_SERVER_IP ./scripts/sync-from-cloud.sh
# Or set CLOUD_HOST once in .env, then:
#   ./scripts/sync-from-cloud.sh
#
# Optional:
#   CLOUD_DIR=/opt/dashbird
#   SKIP_DOWN=1   # skip docker compose down (not recommended — SQLite may be open)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${CLOUD_HOST:-}"
REMOTE_DIR="${CLOUD_DIR:-/opt/dashbird}"
SKIP_DOWN="${SKIP_DOWN:-0}"

if [[ -z "$HOST" && -f "$ROOT/.env" ]]; then
  HOST="$(grep -E '^CLOUD_HOST=' "$ROOT/.env" 2>/dev/null | cut -d= -f2- | tr -d '\r' || true)"
fi
HOST="${HOST:?Set CLOUD_HOST=root@your-server-ip (env or .env)}"

cd "$ROOT"

if [[ "$SKIP_DOWN" != "1" ]]; then
  echo "[dashbird] Stopping local stack (SQLite must not be open during sync)"
  docker compose down || true
fi

# Docker may have created data/ subdirs as root; fix ownership so rsync can write.
if [[ -d "$ROOT/data/telegram-intake-media" ]] && [[ ! -w "$ROOT/data/telegram-intake-media" ]]; then
  echo "[dashbird] Fixing root-owned data/telegram-intake-media"
  docker run --rm -v "$ROOT/data:/data" alpine chown -R "$(id -u):$(id -g)" /data/telegram-intake-media
fi

echo "[dashbird] Pulling data/ from ${HOST}:${REMOTE_DIR}/"
mkdir -p "$ROOT/data" "$ROOT/public/data"
rsync -avz "${HOST}:${REMOTE_DIR}/data/" "$ROOT/data/"

for f in bookmarks-personal.json notes.md last-backup.txt; do
  rsync -avz "${HOST}:${REMOTE_DIR}/public/data/$f" "$ROOT/public/data/$f" 2>/dev/null || true
done

echo "[dashbird] Starting local stack"
docker compose up -d --build
docker compose logs lan-url

echo "[dashbird] Done — local data matches cloud snapshot from ${HOST}"
