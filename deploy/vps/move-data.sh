#!/usr/bin/env bash
# Phase 2 of the move: copies the Railway database into this server's database, then checks that
# every table has the same number of rows. Run on the server, from deploy/vps, with Railway in
# maintenance (service stopped) so nothing changes during the copy.
#   ./move-data.sh            asks for Railway's DATABASE_PUBLIC_URL (not shown, not stored)
# The dump is kept (encrypted) in $BACKUP_DIR as a first backup.
set -euo pipefail
cd "$(dirname "$0")"
umask 077
. ./lib.sh
BACKUP_DIR="${BACKUP_DIR:-/var/backups/ironid}"
KEY_FILE="${BACKUP_KEY_FILE:-/etc/ironid/backup.key}"

if [ -n "${SOURCE_DATABASE_URL:-}" ]; then SRC="$SOURCE_DATABASE_URL"; else read -rsp "Railway DATABASE_PUBLIC_URL (not shown): " SRC; echo; fi
[ -n "$SRC" ] || die "no source database"
[ -r "$KEY_FILE" ] || die "backup key $KEY_FILE missing (README step: create it first)"
mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"

echo "1/6 Source version"
SRC_MAJOR=$(PG_CLIENT_MAJOR=17 url_psql "$SRC" -tAc "SELECT current_setting('server_version_num')::int / 10000")
echo "    Railway runs PostgreSQL $SRC_MAJOR; this server runs $PG_IMAGE_MAJOR."
[ "$SRC_MAJOR" -le "$PG_IMAGE_MAJOR" ] || die "set the db image in compose.yml to postgres:${SRC_MAJOR}-bookworm and PG_IMAGE_MAJOR=$SRC_MAJOR before the first start"

echo "2/6 This server's database must be empty"
if [ -z "${LOCAL_TARGET_URL:-}" ]; then docker compose stop app >/dev/null 2>&1 || true; docker compose up -d db >/dev/null; fi
N=$(target_psql -tAc "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')")
[ "$N" = 0 ] || die "the database here already has $N tables; this script only copies into an empty one"

echo "3/6 Copying (dump)"
STAMP=$(date -u +%Y%m%d-%H%M%S)
DUMP="$BACKUP_DIR/railway-$STAMP.dump"
PG_CLIENT_MAJOR="$SRC_MAJOR" url_dump "$SRC" > "$DUMP"
chmod 600 "$DUMP"
echo "    $(du -h "$DUMP" | cut -f1) dumped"

echo "4/6 Restoring here"
target_restore < "$DUMP"

echo "5/6 Comparing every table's row count"
diff <(PG_CLIENT_MAJOR="$SRC_MAJOR" table_counts "$SRC") <(table_counts target) > /tmp/ironid-move-diff.txt \
  || { cat /tmp/ironid-move-diff.txt; die "row counts differ (see above); nothing was started"; }
echo "    $(table_counts target | wc -l) tables, identical counts"

echo "6/6 Keeping the dump encrypted as the first backup"
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$KEY_FILE" -in "$DUMP" -out "$DUMP.enc"
rm -f "$DUMP"
echo "    $DUMP.enc"
[ -z "${LOCAL_TARGET_URL:-}" ] && docker compose up -d app
echo "Done. Next: README.md phase 2 checks (sign in, read mail, re-index search)."
