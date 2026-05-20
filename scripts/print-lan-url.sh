#!/usr/bin/env bash
# Print the dashbird URL to open on a phone on the same Wi‑Fi as this host.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=8787

if [[ -f "$ROOT/.env" ]]; then
  line="$(grep -E '^HOST_PORT=' "$ROOT/.env" 2>/dev/null | tail -n1 || true)"
  if [[ -n "$line" ]]; then
    val="${line#HOST_PORT=}"
    val="${val%\"}"
    val="${val#\"}"
    val="${val%\'}"
    val="${val#\'}"
    if [[ -n "$val" ]]; then
      PORT="$val"
    fi
  fi
fi

pick_ip() {
  if command -v ip >/dev/null 2>&1; then
    ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1
    return
  fi
  if command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null | awk '{print $1}'
    return
  fi
  echo ""
}

IP="$(pick_ip)"
if [[ -z "$IP" ]]; then
  echo "Could not detect a LAN IP. Set DASHBOARD_LAN_ORIGIN in .env after you know your Wi‑Fi address." >&2
  exit 1
fi

echo "http://${IP}:${PORT}/"
