#!/usr/bin/env bash
# Nightly host-side backup for the cloud VPS: encrypt the latest data backup and ship it
# OFF the box, then prune. Run ON the VPS via cron AFTER the in-app daily backup (03:15):
#   30 3 * * * /opt/dashbird/scripts/cloud-backup.sh >> /var/log/dashbird-backup.log 2>&1
#
# What it does:
#   1. Prefer the newest in-app tarball data/backups/daily-*.tar.gz (all DBs VACUUM-snapshotted
#      by the Node scheduler). If none exists, make a fallback tarball here.
#   2. Encrypt it (age recipient or gpg passphrase). Plaintext is NEVER shipped offsite
#      because data/ contains Gmail OAuth tokens and other secrets.
#   3. Upload the encrypted artifact to an rclone remote (Backblaze B2 / S3 / etc.).
#   4. Prune old local + remote copies, write a heartbeat, and alert on failure.
#
# All offsite behavior is opt-in via env; with nothing configured it degrades to a local
# tarball + prune (same as before), so this is safe to install as-is.
#
# See docs/backups.md and docs/recovery-runbook.md.
set -euo pipefail

ROOT="${DASHBIRD_ROOT:-/opt/dashbird}"
BACKUP_DIR="${DASHBIRD_BACKUP_DIR:-/var/backups/dashbird}"
INAPP_BACKUP_DIR="${DASHBIRD_INAPP_BACKUP_DIR:-${ROOT}/data/backups}"
KEEP_DAYS="${DASHBIRD_BACKUP_KEEP_DAYS:-14}"

# Offsite / encryption (all optional)
OFFSITE_REMOTE="${DASHBIRD_OFFSITE_REMOTE:-}"       # e.g. b2:my-bucket/dashbird  (rclone remote:path)
AGE_RECIPIENT="${DASHBIRD_AGE_RECIPIENT:-}"          # age public key (recommended)
GPG_PASSPHRASE="${DASHBIRD_GPG_PASSPHRASE:-}"        # gpg symmetric fallback
REQUIRE_ENCRYPTION="${DASHBIRD_REQUIRE_ENCRYPTION:-1}"

# Alerting (optional)
ALERT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
ALERT_CHAT_ID="${DASHBIRD_ALERT_CHAT_ID:-}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

log() { echo "[dashbird] $*"; }

alert() {
  local msg="$1"
  log "ALERT: ${msg}"
  if [[ -n "$ALERT_TOKEN" && -n "$ALERT_CHAT_ID" ]]; then
    curl -fsS --max-time 20 \
      "https://api.telegram.org/bot${ALERT_TOKEN}/sendMessage" \
      -d chat_id="${ALERT_CHAT_ID}" \
      --data-urlencode "text=⚠️ Dashbird cloud backup failed on $(hostname): ${msg}" \
      >/dev/null 2>&1 || log "(telegram alert failed to send)"
  fi
}

trap 'alert "line ${LINENO}: ${BASH_COMMAND}"' ERR

mkdir -p "$BACKUP_DIR"

# 1) Pick the source tarball: newest in-app daily backup if present, else build one.
SRC_TARBALL=""
if [[ -d "$INAPP_BACKUP_DIR" ]]; then
  SRC_TARBALL="$(ls -1t "${INAPP_BACKUP_DIR}"/daily-*.tar.gz 2>/dev/null | head -n1 || true)"
fi

if [[ -z "$SRC_TARBALL" ]]; then
  log "no in-app daily tarball found; building a fallback snapshot"
  FALLBACK="${BACKUP_DIR}/dashbird-data-${STAMP}.tar.gz"
  if command -v sqlite3 >/dev/null 2>&1; then
    for db in events-finder.db network.db telegram-intake.db dev-requests.db; do
      src="${ROOT}/data/${db}"
      [[ -f "$src" ]] && sqlite3 "$src" ".backup '${ROOT}/data/${db}.bak'"
    done
  fi
  tar -czf "$FALLBACK" \
    -C "$ROOT" \
    --exclude='data/backups' \
    --exclude='data/**/*.bak' \
    data \
    public/data/bookmarks-personal.json \
    public/data/notes.md \
    2>/dev/null || tar -czf "$FALLBACK" -C "$ROOT" data
  SRC_TARBALL="$FALLBACK"
fi
log "source tarball: ${SRC_TARBALL}"

# 2) Encrypt (never ship plaintext secrets offsite).
UPLOAD_FILE="$SRC_TARBALL"
ENC_TMP=""
if [[ -n "$AGE_RECIPIENT" ]] && command -v age >/dev/null 2>&1; then
  ENC_TMP="${BACKUP_DIR}/$(basename "$SRC_TARBALL").age"
  age -r "$AGE_RECIPIENT" -o "$ENC_TMP" "$SRC_TARBALL"
  UPLOAD_FILE="$ENC_TMP"
  log "encrypted with age → $(basename "$ENC_TMP")"
elif [[ -n "$GPG_PASSPHRASE" ]] && command -v gpg >/dev/null 2>&1; then
  ENC_TMP="${BACKUP_DIR}/$(basename "$SRC_TARBALL").gpg"
  gpg --batch --yes --passphrase "$GPG_PASSPHRASE" --symmetric --cipher-algo AES256 \
    -o "$ENC_TMP" "$SRC_TARBALL"
  UPLOAD_FILE="$ENC_TMP"
  log "encrypted with gpg → $(basename "$ENC_TMP")"
else
  if [[ -n "$OFFSITE_REMOTE" && "$REQUIRE_ENCRYPTION" == "1" ]]; then
    alert "offsite remote set but no encryption configured (set DASHBIRD_AGE_RECIPIENT or DASHBIRD_GPG_PASSPHRASE); refusing to upload plaintext secrets"
    exit 1
  fi
  log "no encryption configured; keeping local copy only"
fi

# 3) Upload offsite (if configured).
if [[ -n "$OFFSITE_REMOTE" ]]; then
  if command -v rclone >/dev/null 2>&1; then
    rclone copy --no-traverse "$UPLOAD_FILE" "$OFFSITE_REMOTE/" >/dev/null
    log "uploaded to ${OFFSITE_REMOTE}/$(basename "$UPLOAD_FILE")"
    # Prune remote copies older than KEEP_DAYS.
    rclone delete --min-age "${KEEP_DAYS}d" "$OFFSITE_REMOTE/" >/dev/null 2>&1 || true
  else
    alert "DASHBIRD_OFFSITE_REMOTE set but rclone is not installed on the host"
    exit 1
  fi
fi

# 4) Prune local + heartbeat.
find "$BACKUP_DIR" -type f \( -name 'dashbird-data-*.tar.gz' -o -name '*.age' -o -name '*.gpg' \) \
  -mtime "+${KEEP_DAYS}" -delete 2>/dev/null || true
date -Iseconds > "${ROOT}/public/data/last-offsite-backup.txt" 2>/dev/null || true

log "backup ok: ${UPLOAD_FILE}${OFFSITE_REMOTE:+ → ${OFFSITE_REMOTE}}"
