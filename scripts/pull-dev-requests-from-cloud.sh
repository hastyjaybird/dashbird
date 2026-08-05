#!/usr/bin/env bash
# Pull only data/dev-requests/ + dev-requests.db from cloud (lighter than sync-from-cloud.sh).
# Usage:
#   CLOUD_HOST=root@YOUR_VULTR_IP ./scripts/pull-dev-requests-from-cloud.sh
# Or set CLOUD_HOST in .env, then:
#   ./scripts/pull-dev-requests-from-cloud.sh
#
# HTTPS fallback (no SSH): set DASHBOARD_BASIC_AUTH_USER + DASHBOARD_BASIC_AUTH_PASSWORD and run:
#   node scripts/pull-dev-requests-from-cloud.mjs
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${CLOUD_HOST:-}"
REMOTE_DIR="${CLOUD_DIR:-/opt/dashbird}"

if [[ -z "$HOST" && -f "$ROOT/.env" ]]; then
  HOST="$(grep -E '^CLOUD_HOST=' "$ROOT/.env" 2>/dev/null | cut -d= -f2- | tr -d '\r' || true)"
fi

if [[ -z "$HOST" ]]; then
  if [[ -n "${DASHBOARD_BASIC_AUTH_USER:-}" && -n "${DASHBOARD_BASIC_AUTH_PASSWORD:-}${DASHBOARD_BASIC_AUTH_PASS:-}" ]]; then
    exec node "$ROOT/scripts/pull-dev-requests-from-cloud.mjs"
  fi
  echo "[dashbird] Set CLOUD_HOST (SSH) or DASHBOARD_BASIC_AUTH_* (HTTPS) to pull dev-requests from cloud"
  exit 1
fi

cd "$ROOT"

if docker compose ps --status running -q dashboard 2>/dev/null | grep -q .; then
  echo "[dashbird] Stopping local stack (dev-requests.db must not be open during sync)"
  docker compose down || true
fi

echo "[dashbird] Pulling dev-requests from ${HOST}:${REMOTE_DIR}/"
mkdir -p "$ROOT/data/dev-requests"
rsync -avz --delete "${HOST}:${REMOTE_DIR}/data/dev-requests/" "$ROOT/data/dev-requests/"
rsync -avz "${HOST}:${REMOTE_DIR}/data/dev-requests.db" "$ROOT/data/dev-requests.db"

echo "[dashbird] Rebuilding inbox index"
node -e "import('./src/lib/dev-requests-store.js').then((m) => m.rebuildDevRequestsIndex()).then(() => console.log('[dashbird] inbox rebuilt'))"

echo "[dashbird] Starting local stack"
docker compose up -d --build
docker compose logs lan-url

echo "[dashbird] Done — dev-requests synced from ${HOST}"
