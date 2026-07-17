#!/usr/bin/env bash
# Push local dashbird to a public VPS (Vultr Silicon Valley + DuckDNS).
# Usage:
#   CLOUD_HOST=root@YOUR_SERVER_IP ./scripts/sync-to-cloud.sh
# Optional:
#   CLOUD_DIR=/opt/dashbird
#   SYNC_DATA=1          # also rsync data/ + public/data bookmarks/notes
#   SYNC_ENV=1           # push local .env to the server
#   COMPOSE_FILE=docker-compose.cloud.yml
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${CLOUD_HOST:?Set CLOUD_HOST=root@your-server-ip}"
REMOTE_DIR="${CLOUD_DIR:-/opt/dashbird}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.cloud.yml}"
SYNC_DATA="${SYNC_DATA:-0}"
SYNC_ENV="${SYNC_ENV:-0}"

RSYNC_CODE=(rsync -avz --delete
  --exclude node_modules
  --exclude .git
  --exclude .env
  --exclude data/
  --exclude 'public/data/bookmarks-personal.json'
  --exclude 'public/data/notes.md'
  --exclude 'public/data/last-backup.txt'
  --exclude 'public/data/phone-lan-url.txt'
)

echo "[dashbird] Syncing repo code to ${HOST}:${REMOTE_DIR}/"
ssh "$HOST" "mkdir -p '${REMOTE_DIR}/data' '${REMOTE_DIR}/public/data' '${REMOTE_DIR}/data/vikunja/db' '${REMOTE_DIR}/data/vikunja/files'"
"${RSYNC_CODE[@]}" "$ROOT/" "${HOST}:${REMOTE_DIR}/"

if [[ "$SYNC_ENV" == "1" ]]; then
  echo "[dashbird] Syncing .env (if present locally)"
  if [[ -f "$ROOT/.env" ]]; then
    rsync -avz "$ROOT/.env" "${HOST}:${REMOTE_DIR}/.env"
  else
    echo "  (no local .env — configure on server from deploy/env.cloud.example)"
  fi
fi

if [[ "$SYNC_DATA" == "1" ]]; then
  echo "[dashbird] Syncing persistent data/ (tools, network, events, assets — never commit these)"
  mkdir -p "$ROOT/data"
  rsync -avz "$ROOT/data/" "${HOST}:${REMOTE_DIR}/data/"

  for f in bookmarks-personal.json notes.md last-backup.txt; do
    if [[ -f "$ROOT/public/data/$f" ]]; then
      rsync -avz "$ROOT/public/data/$f" "${HOST}:${REMOTE_DIR}/public/data/$f"
    fi
  done
fi

echo "[dashbird] Remote restart (${COMPOSE_FILE})"
ssh "$HOST" "cd '${REMOTE_DIR}' && docker compose -f '${COMPOSE_FILE}' up -d --build"

DOMAIN="$(ssh "$HOST" "grep -E '^DASHBOARD_DOMAIN=' '${REMOTE_DIR}/.env' 2>/dev/null | cut -d= -f2-" || true)"
echo "[dashbird] Done. Open https://${DOMAIN:-dashbird.duckdns.org}/"
echo "[dashbird] New tool Playwright snapshots: enrich on LAN, then SYNC_DATA=1 ./scripts/sync-to-cloud.sh"
