#!/usr/bin/env bash
# Pull only dev-requests from cloud (lighter than sync-from-cloud.sh).
# Usage:
#   CLOUD_HOST=root@YOUR_SERVER_IP ./scripts/pull-dev-requests-from-cloud.sh
# Or set CLOUD_HOST once in .env, then:
#   ./scripts/pull-dev-requests-from-cloud.sh
#
# For HTTPS basic-auth pull (no SSH), use:
#   node scripts/pull-dev-requests-from-cloud.mjs
#
# Optional:
#   CLOUD_DIR=/opt/dashbird
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${CLOUD_HOST:-}"
REMOTE_DIR="${CLOUD_DIR:-/opt/dashbird}"

if [[ -z "$HOST" && -f "$ROOT/.env" ]]; then
  HOST="$(grep -E '^CLOUD_HOST=' "$ROOT/.env" 2>/dev/null | cut -d= -f2- | tr -d '\r' || true)"
fi
HOST="${HOST:?Set CLOUD_HOST=root@your-server-ip (env or .env)}"

cd "$ROOT"
mkdir -p "$ROOT/data/dev-requests"

echo "[dashbird] Pulling dev-requests from ${HOST}:${REMOTE_DIR}/data/"
rsync -avz \
  "${HOST}:${REMOTE_DIR}/data/dev-requests/" \
  "$ROOT/data/dev-requests/"

for f in dev-requests.db dev-requests.db-wal dev-requests.db-shm; do
  rsync -avz "${HOST}:${REMOTE_DIR}/data/${f}" "$ROOT/data/" 2>/dev/null || true
done

if command -v node >/dev/null 2>&1; then
  node -e "
    import { rebuildDevRequestsIndex } from './src/lib/dev-requests-store.js';
    const p = await rebuildDevRequestsIndex();
    console.log('[dashbird] Regenerated', p);
  "
fi

echo "[dashbird] Done — see data/dev-requests/inbox.md"
