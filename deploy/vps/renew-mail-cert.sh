#!/usr/bin/env bash
# Nightly: copies Caddy's current certificate for WEB_HOST into the mail engine; when it changed
# (a renewal every ~60 days), restarts the app so the mail ports present it (about 30 seconds without
# mail connections; senders retry). Then checks every port.
# cron (root):  40 4 * * *  cd /opt/ironid/deploy/vps && ./renew-mail-cert.sh >> /var/log/ironid-cert.log 2>&1
set -uo pipefail
cd "$(dirname "$0")"
HOST=$(grep -E '^WEB_HOST=' .env | cut -d= -f2-)
[ -n "$HOST" ] || { echo "WEB_HOST missing in .env"; exit 1; }
echo "$(date -u +%FT%TZ) certificate check for $HOST"
docker compose exec -T app node /opt/iron-id/webmail/scripts/import-certificate.js --host "$HOST" --dir /caddy-data
rc=$?
if [ "$rc" = 3 ]; then
  echo "Restarting the app so the engine presents the new certificate"
  docker compose restart app && sleep 45
elif [ "$rc" != 0 ]; then
  echo "Import failed (exit $rc)"; exit 1
fi
./check-tls.sh "$HOST"
