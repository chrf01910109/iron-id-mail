#!/usr/bin/env bash
# Checks the certificate each mail port and the website present: who issued it, for which name, and
# how many days are left. Fails when a port shows the engine's built-in "rcgen" certificate or one that
# ends within $MIN_DAYS days.
#   ./check-tls.sh [host]                  (default: WEB_HOST from .env)
#   ./check-tls.sh --restart-if-stale      also restarts the app once if the mail ports still show an old
#                                          or built-in certificate (the engine loads new ones at start);
#                                          meant for a nightly cron at a quiet hour.
set -uo pipefail
cd "$(dirname "$0")"
RESTART=0; HOST=""
for a in "$@"; do case "$a" in --restart-if-stale) RESTART=1 ;; *) HOST="$a" ;; esac; done
[ -z "$HOST" ] && [ -f .env ] && HOST=$(grep -E '^WEB_HOST=' .env | cut -d= -f2-)
[ -n "$HOST" ] || { echo "usage: $0 [host]"; exit 2; }
MIN_DAYS="${MIN_DAYS:-20}"

served() { # port starttls-proto -> "subject|issuer|days left"
  local opts=(-connect "$HOST:$1" -servername "$HOST")
  [ -n "$2" ] && opts+=(-starttls "$2")
  local pem; pem=$(echo | timeout 15 openssl s_client "${opts[@]}" 2>/dev/null | openssl x509 2>/dev/null) || true
  [ -z "$pem" ] && { echo "no certificate||-1"; return; }
  local end; end=$(printf '%s\n' "$pem" | openssl x509 -noout -enddate | cut -d= -f2)
  local days=$(( ( $(date -d "$end" +%s) - $(date +%s) ) / 86400 ))
  echo "$(printf '%s\n' "$pem" | openssl x509 -noout -subject | sed 's/^subject=//')|$(printf '%s\n' "$pem" | openssl x509 -noout -issuer | sed 's/^issuer=//')|$days"
}

check_all() {
  BAD=0; MAILBAD=0
  for spec in "443:" "993:" "465:" "587:smtp" "25:smtp"; do
    port=${spec%%:*}; proto=${spec#*:}
    IFS='|' read -r subj iss days <<< "$(served "$port" "$proto")"
    status=OK
    if [ "$days" -lt 0 ]; then status="NO CERTIFICATE"; elif printf '%s' "$subj$iss" | grep -qi rcgen; then status="BUILT-IN (not the real certificate)"; elif [ "$days" -lt "$MIN_DAYS" ]; then status="ENDS SOON"; fi
    printf '%-4s %-36s %-30s %4s days  %s\n' "$port" "${subj:0:36}" "${iss:0:30}" "$days" "$status"
    if [ "$status" != OK ]; then BAD=1; [ "$port" != 443 ] && MAILBAD=1; fi
  done
}

check_all
if [ "$MAILBAD" = 1 ] && [ "$RESTART" = 1 ]; then
  echo "Restarting the app so the engine loads its current certificate..."
  docker compose restart app >/dev/null && sleep 40 && check_all
fi
exit "$BAD"
