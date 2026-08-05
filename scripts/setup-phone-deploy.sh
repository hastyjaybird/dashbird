#!/usr/bin/env bash
# One-time setup: authorize GitHub Actions to deploy Dashbird to Vultr.
# Prerequisites: gh auth login, SSH to CLOUD_HOST already works from this machine.
#
# Usage:
#   CLOUD_HOST=root@YOUR_VULTR_IP ./scripts/setup-phone-deploy.sh
# Or set CLOUD_HOST in .env first.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

HOST="${CLOUD_HOST:-}"
if [[ -z "$HOST" && -f "$ROOT/.env" ]]; then
  HOST="$(grep -E '^CLOUD_HOST=' "$ROOT/.env" 2>/dev/null | cut -d= -f2- | tr -d '\r' || true)"
fi
HOST="${HOST:?Set CLOUD_HOST=root@your-server-ip (env or .env)}"

if ! command -v gh >/dev/null 2>&1; then
  echo "Install GitHub CLI first: https://cli.github.com/"
  exit 1
fi
gh auth status >/dev/null

SECRETS_DIR="$ROOT/.deploy-secrets"
KEY="$SECRETS_DIR/dashbird-gha-deploy"
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

if [[ ! -f "$KEY" ]]; then
  ssh-keygen -t ed25519 -f "$KEY" -N '' -C 'dashbird-github-actions-deploy'
  chmod 600 "$KEY"
fi

PUB="$(cat "${KEY}.pub")"
echo "[dashbird] Installing deploy public key on ${HOST}"
ssh -o BatchMode=yes "$HOST" "mkdir -p /root/.ssh && chmod 700 /root/.ssh; grep -qxF '${PUB}' /root/.ssh/authorized_keys 2>/dev/null || echo '${PUB}' >> /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys"

echo "[dashbird] Verifying deploy key"
ssh -o BatchMode=yes -i "$KEY" -o IdentitiesOnly=yes "$HOST" 'echo DEPLOY_KEY_OK'

echo "[dashbird] Setting GitHub Actions secrets (CLOUD_HOST, CLOUD_SSH_PRIVATE_KEY)"
printf '%s' "$HOST" | gh secret set CLOUD_HOST
gh secret set CLOUD_SSH_PRIVATE_KEY < "$KEY"

echo "[dashbird] Done. Push to main (or Actions → Deploy cloud → Run workflow) deploys code-only."
echo "  Phone Cursor: commit + push main → GitHub Actions rebuilds dashbird.jayhasty.com"
echo "  Laptop data sync unchanged: SYNC_DATA=1 SYNC_DATA_CONFIRM=1 ./scripts/sync-to-cloud.sh"
