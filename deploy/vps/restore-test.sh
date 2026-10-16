#!/usr/bin/env bash
# Proves the latest backup can be restored: decrypts it, restores it into a throw-away database
# next to the real one, checks the tables are all there, then deletes the copy.
# Run after the first backup and then monthly (cron:  30 4 1 * *  ./restore-test.sh).
# Usage: ./restore-test.sh [backup file]   (default: the newest in $BACKUP_DIR)
set -euo pipefail
cd "$(dirname "$0")"
. ./lib.sh
BACKUP_DIR="${BACKUP_DIR:-/var/backups/ironid}"
KEY_FILE="${BACKUP_KEY_FILE:-/etc/ironid/backup.key}"
FILE="${1:-$(ls -1t "$BACKUP_DIR"/*.dump.enc 2>/dev/null | head -1)}"
[ -n "$FILE" ] && [ -r "$FILE" ] || die "no backup found in $BACKUP_DIR"
TEST_DB=ironid_restore_test
echo "Restoring $FILE into $TEST_DB"
target_psql -qc "DROP DATABASE IF EXISTS $TEST_DB" -c "CREATE DATABASE $TEST_DB"
cleanup() { target_psql -qc "DROP DATABASE IF EXISTS $TEST_DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT
if [ -n "${LOCAL_TARGET_URL:-}" ]; then TEST_URL="${LOCAL_TARGET_URL%/*}/$TEST_DB"; else TEST_URL="$TEST_DB"; fi
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$KEY_FILE" -in "$FILE" | target_restore "$TEST_URL"
if [ -n "${LOCAL_TARGET_URL:-}" ]; then
  RESTORED=$(LOCAL_TARGET_URL="$TEST_URL" table_counts target)
else
  RESTORED=$(docker compose exec -T db psql -U ironid -d "$TEST_DB" -tAc "$COUNT_SQL" | sed 's/$/;/' | docker compose exec -T db psql -U ironid -d "$TEST_DB" -tA | sort)
fi
TABLES=$(printf '%s\n' "$RESTORED" | grep -c . || true)
[ "$TABLES" -gt 10 ] || die "only $TABLES tables restored"
for t in cp.customers cp.audit_log; do
  printf '%s\n' "$RESTORED" | grep -q "^$t " || die "$t missing in the restored copy"
done
echo "OK: $TABLES tables restored; e.g. $(printf '%s\n' "$RESTORED" | grep -E '^cp\.(customers|orders) ' | tr '\n' ' ')"
echo "The restored copy is deleted now."
