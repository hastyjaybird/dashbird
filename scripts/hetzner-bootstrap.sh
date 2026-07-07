#!/usr/bin/env bash
# Bootstrap a fresh Ubuntu 22.04/24.04 Hetzner Cloud server for dashbird.
# Run ON THE SERVER as root (or with sudo):
#   curl -fsSL https://raw.githubusercontent.com/YOU/dashbird/main/scripts/hetzner-bootstrap.sh | bash
# Or after cloning:
#   sudo bash scripts/hetzner-bootstrap.sh
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt-get install -y -qq ca-certificates curl git ufw

# Docker Engine + Compose plugin (official convenience script)
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

systemctl enable --now docker

# Firewall: SSH + web only
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

DEPLOY_DIR="${DASHBIRD_DEPLOY_DIR:-/opt/dashbird}"
mkdir -p "$DEPLOY_DIR"

cat <<EOF

[dashbird] Docker $(docker --version)
[dashbird] UFW enabled (22, 80, 443)

Next steps:
  1. Clone or rsync this repo to $DEPLOY_DIR
  2. cd $DEPLOY_DIR
  3. cp deploy/env.hetzner.example .env && edit .env (domain, email, secrets, basic auth hash)
  4. cp public/data/bookmarks-personal.example.json public/data/bookmarks-personal.json  # if needed
  5. docker compose -f docker-compose.hetzner.yml up -d --build
  6. Point DNS A/AAAA for your domain at this server's public IP

See docs/deploy-hetzner.md for the full guide.

EOF
