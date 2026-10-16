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
trap 'rm -f "$OUT.part"' EXIT
target_dump | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$KEY_FILE" -out "$OUT.part"
mv "$OUT.part" "$OUT"
[ -s "$OUT" ] || die "empty backup"
echo "$(date -u +%FT%TZ) backup $OUT $(du -h "$OUT" | cut -f1)"

# Old backups (and the move's first copy of Railway's data, railway-*.dump.enc) go after KEEP_DAYS days,
# as the privacy policy says; failed runs' leftovers too.
find "$BACKUP_DIR" -maxdepth 1 \( -name 'ironid-*.dump.enc' -o -name 'railway-*.dump.enc' \) -mtime +"$KEEP_DAYS" -print -delete
find "$BACKUP_DIR" -maxdepth 1 \( -name '*.part' -o -name 'railway-*.dump' \) -mmin +120 -print -delete
if [ -n "${RCLONE_REMOTE:-}" ]; then
  # A failed copy fails the run (cron mails / the log shows it). Only our own files are ever deleted
  # there. Better still: give the bucket its own expiry rule and remove delete rights from this key, so
  # a broken-into server can't wipe the off-site copies.
  rclone copy "$OUT" "$RCLONE_REMOTE/"
  echo "copied off the server to $RCLONE_REMOTE"
  if [ "${RCLONE_PRUNE:-yes}" = yes ]; then
    rclone delete --min-age "${KEEP_DAYS}d" --include 'ironid-*.dump.enc' --max-depth 1 "$RCLONE_REMOTE/" \
      || echo "WARNING: could not remove old off-site copies (no delete right?)"
  fi
fi
