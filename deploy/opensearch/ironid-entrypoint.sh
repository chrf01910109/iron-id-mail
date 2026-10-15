#!/usr/bin/env bash
# IRON ID mail search (OpenSearch) - container start.
#
# Runs as root only to prepare the volume and certificates, then runs OpenSearch as
# the unprivileged "opensearch" user. Order matters:
#   1. certificates (generated once, kept on the volume)
#   2. OpenSearch starts with an EMPTY user list, so the mail engine cannot connect yet
#   3. index templates are installed (engine index layout + accent-insensitive search)
#   4. the "stalwart" user is created / its password reset from OPENSEARCH_PASSWORD
#
# Variables:
#   OPENSEARCH_PASSWORD  required. 24+ characters, letters/digits/_/- only
#                        (generate with: openssl rand -hex 24)
#   IRONID_SEARCH_STATE  volume mount (default /var/lib/ironid-search)
#   OPENSEARCH_HOME      default /usr/share/opensearch
#   OPENSEARCH_START     command that starts OpenSearch (default: the official image's entrypoint)
set -euo pipefail

OS_HOME="${OPENSEARCH_HOME:-/usr/share/opensearch}"
STATE="${IRONID_SEARCH_STATE:-/var/lib/ironid-search}"
START="${OPENSEARCH_START:-./opensearch-docker-entrypoint.sh opensearch}"
HERE="$(cd "$(dirname "$0")" && pwd)"
RUN_USER=opensearch
URL=https://localhost:9200

log() { echo "[ironid-search] $*"; }
die() { echo "[ironid-search] FATAL: $*" >&2; exit 1; }

PW="${OPENSEARCH_PASSWORD:-}"
[ -n "$PW" ] || die "OPENSEARCH_PASSWORD is not set. Generate one with: openssl rand -hex 24"
[[ "$PW" =~ ^[A-Za-z0-9_-]{24,128}$ ]] || die "OPENSEARCH_PASSWORD must be 24-128 characters of letters, digits, _ or - (openssl rand -hex 24)"

# --- 1. volume and certificates -------------------------------------------------------
mkdir -p "$STATE/data" "$STATE/certs"
chown -R "$RUN_USER:$RUN_USER" "$STATE/data"
chmod 700 "$STATE/certs"

CERTS="$STATE/certs"
if [ ! -s "$CERTS/ca.pem" ] || [ ! -s "$CERTS/node.pem" ] || [ ! -s "$CERTS/admin.pem" ]; then
  log "Generating private certificates (first start)..."
  rm -f "$CERTS"/*
  tmp="$(mktemp -d)"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$CERTS/ca-key.pem" 2>/dev/null
  openssl req -x509 -new -key "$CERTS/ca-key.pem" -sha256 -days 3650 \
    -subj "/O=IRON ID/CN=ironid-search-ca" -out "$CERTS/ca.pem"

  issue() { # name subject extfile
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$CERTS/$1-key.pem" 2>/dev/null
    openssl req -new -key "$CERTS/$1-key.pem" -subj "$2" -out "$tmp/$1.csr"
    openssl x509 -req -in "$tmp/$1.csr" -CA "$CERTS/ca.pem" -CAkey "$CERTS/ca-key.pem" -CAcreateserial \
      -sha256 -days 3650 -extfile "$3" -out "$CERTS/$1.pem" 2>/dev/null
  }
  san="DNS:localhost,IP:127.0.0.1,IP:::1,DNS:opensearch.railway.internal"
  [ -n "${RAILWAY_PRIVATE_DOMAIN:-}" ] && san="$san,DNS:$RAILWAY_PRIVATE_DOMAIN"
  printf 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=%s\n' "$san" > "$tmp/node.ext"
  printf 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\n' > "$tmp/admin.ext"
  issue node "/O=IRON ID/CN=ironid-search-node" "$tmp/node.ext"
  issue admin "/O=IRON ID/CN=ironid-search-admin" "$tmp/admin.ext"
  rm -rf "$tmp" "$CERTS/ca.srl"
  chmod 600 "$CERTS"/*
fi

CONF="$OS_HOME/config"
mkdir -p "$CONF/certs"
cp "$CERTS/ca.pem" "$CERTS/node.pem" "$CERTS/node-key.pem" "$CONF/certs/"
chown -R "$RUN_USER:$RUN_USER" "$CONF/certs"
chmod 600 "$CONF/certs"/*

# Our security configuration replaces the image defaults (which include demo users).
cp "$HERE/security/"*.yml "$CONF/opensearch-security/"
chown "$RUN_USER:$RUN_USER" "$CONF/opensearch-security/"*.yml

# --- 2. start OpenSearch as the unprivileged user -------------------------------------
export DISABLE_INSTALL_DEMO_CONFIG=true DISABLE_PERFORMANCE_ANALYZER_AGENT_CLI=true
export OPENSEARCH_JAVA_OPTS="${OPENSEARCH_JAVA_OPTS:--Xms512m -Xmx512m}"
cd "$OS_HOME"
extra=()
if [ ! -s /proc/net/if_inet6 ]; then
  log "No IPv6 in this container: listening on IPv4 only."
  extra+=(-Ehttp.host=0.0.0.0)
fi
log "Starting OpenSearch..."
# shellcheck disable=SC2086
setpriv --reuid="$RUN_USER" --regid="$RUN_USER" --init-groups --reset-env -- \
  env PATH="$PATH" JAVA_HOME="${JAVA_HOME:-$OS_HOME/jdk}" OPENSEARCH_JAVA_OPTS="$OPENSEARCH_JAVA_OPTS" \
  DISABLE_INSTALL_DEMO_CONFIG=true DISABLE_PERFORMANCE_ANALYZER_AGENT_CLI=true \
  $START "${extra[@]}" &
child=$!
trap 'kill -TERM "$child" 2>/dev/null; wait "$child"; exit 0' TERM INT

admin() { # method path [json-file]
  local args=(-sS -m 30 -o /tmp/ironid-admin.out -w '%{http_code}' --cacert "$CERTS/ca.pem"
    --cert "$CERTS/admin.pem" --key "$CERTS/admin-key.pem" -X "$1" "$URL$2")
  [ $# -ge 3 ] && args+=(-H 'content-type: application/json' --data-binary "@$3")
  curl "${args[@]}" 2>/dev/null || echo 000
}

log "Waiting for OpenSearch and its security index..."
for i in $(seq 1 180); do
  kill -0 "$child" 2>/dev/null || die "OpenSearch exited during start-up (see log above)"
  [ "$(admin GET /_plugins/_security/api/internalusers)" = 200 ] && break
  [ "$i" = 180 ] && die "OpenSearch did not become ready within 6 minutes"
  sleep 2
done

# --- 3. index templates ------------------------------------------------------------------
ls "$HERE"/templates/*.json >/dev/null 2>&1 || die "no index templates found in $HERE/templates"
for f in "$HERE"/templates/*.json; do
  name="$(basename "$f" .json)"
  code="$(admin PUT "/_index_template/$name" "$f")"
  [ "$code" = 200 ] || die "installing template $name failed (HTTP $code): $(cat /tmp/ironid-admin.out)"
done
log "Search templates installed."

# --- 4. engine user ------------------------------------------------------------------------
printf '{"password":"%s","description":"IRON ID mail engine","attributes":{}}' "$PW" > /tmp/ironid-user.json
code="$(admin PUT /_plugins/_security/api/internalusers/stalwart /tmp/ironid-user.json)"
rm -f /tmp/ironid-user.json
[ "$code" = 200 ] || [ "$code" = 201 ] || die "setting the engine user failed (HTTP $code): $(cat /tmp/ironid-admin.out)"
rm -f /tmp/ironid-admin.out

log "READY: mail search is up; the engine can sign in as 'stalwart'."
wait "$child"
