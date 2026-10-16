#!/usr/bin/env bash
# Nightly backup: the whole database (mail, accounts, settings, control plane), encrypted with
# the key in $BACKUP_KEY_FILE, kept $KEEP_DAYS days here, and copied off the server when
# RCLONE_REMOTE is set (e.g. "ovh-s3:ironid-backups"). The search index is not backed up: the
# engine rebuilds it from the mail.
# cron (root):  15 3 * * *  cd /opt/ironid/deploy/vps && ./backup.sh >> /var/log/ironid-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")"
. ./lib.sh
BACKUP_DIR="${BACKUP_DIR:-/var/backups/ironid}"
KEY_FILE="${BACKUP_KEY_FILE:-/etc/ironid/backup.key}"
KEEP_DAYS="${KEEP_DAYS:-30}"
[ -r "$KEY_FILE" ] || die "backup key $KEY_FILE missing"
mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
umask 077

OUT="$BACKUP_DIR/ironid-$(date -u +%Y%m%d-%H%M%S).dump.enc"
target_dump | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$KEY_FILE" -out "$OUT.part"
mv "$OUT.part" "$OUT"
[ -s "$OUT" ] || die "empty backup"
echo "$(date -u +%FT%TZ) backup $OUT $(du -h "$OUT" | cut -f1)"

find "$BACKUP_DIR" -name 'ironid-*.dump.enc' -mtime +"$KEEP_DAYS" -print -delete
if [ -n "${RCLONE_REMOTE:-}" ]; then
  rclone copy "$OUT" "$RCLONE_REMOTE/" && echo "copied off the server to $RCLONE_REMOTE"
  rclone delete --min-age "${KEEP_DAYS}d" "$RCLONE_REMOTE/" || true
fi
