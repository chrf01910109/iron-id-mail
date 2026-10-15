#!/usr/bin/env bash
# Builds the real production image, starts it against a fresh PostgreSQL, and runs
# the end-to-end tests against it. Used by CI (.github/workflows/e2e.yml) and locally.
# Requires: docker, node 20+, openssl. Uses host networking (Linux).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP=ironid-e2e-app
PG=ironid-e2e-pg
OS=ironid-e2e-search
KEEP="${KEEP:-0}"   # KEEP=1 leaves the containers running after the tests

cleanup() {
  if [ "$KEEP" != "1" ]; then docker rm -f "$APP" "$PG" "$OS" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

docker rm -f "$APP" "$PG" "$OS" >/dev/null 2>&1 || true

echo "==> Starting PostgreSQL 16"
docker run -d --name "$PG" --network host \
  -e POSTGRES_USER=iron -e POSTGRES_PASSWORD=ironpw -e POSTGRES_DB=ironmail \
  -e PGPORT=55432 postgres:16 >/dev/null
for i in $(seq 1 60); do
  docker exec "$PG" pg_isready -h 127.0.0.1 -p 55432 -U iron >/dev/null 2>&1 && break
  sleep 1
done

echo "==> Building and starting mail search (OpenSearch)"
OPENSEARCH_PASSWORD="$(openssl rand -hex 24)"
docker build -t ironid-search:e2e "$ROOT/deploy/opensearch"
docker run -d --name "$OS" --network host -e OPENSEARCH_PASSWORD="$OPENSEARCH_PASSWORD" ironid-search:e2e >/dev/null

echo "==> Building the production image"
# The seed (engine/export_data.json) holds private keys, so git only has an encrypted copy.
# CI unlocks it with the SEED_KEY secret; production images are built without it.
if [ ! -d "$ROOT/engine/export_data.json" ]; then
  [ -n "${SEED_KEY:-}" ] || { echo "SEED_KEY is not set: cannot unlock engine/export_data.tar.gz.enc"; exit 1; }
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:SEED_KEY -in "$ROOT/engine/export_data.tar.gz.enc" | tar -C "$ROOT/engine" -xzf -
fi
docker build -t ironid:e2e "$ROOT"

for i in $(seq 1 120); do
  docker logs "$OS" 2>&1 | grep -q 'READY' && break
  if ! docker ps -q -f name="^$OS$" | grep -q .; then docker logs --tail 80 "$OS"; echo "mail search failed to start"; exit 1; fi
  [ "$i" = 120 ] && { docker logs --tail 80 "$OS"; echo "mail search not ready in time"; exit 1; }
  sleep 3
done
echo "==> Mail search is ready"

RECOVERY_ADMIN="e2e-recovery:$(openssl rand -hex 16)"
ADMIN_TOKEN="$(openssl rand -hex 24)"
export RECOVERY_ADMIN
# DNS answers for the admin console tests (domain verification) come from this file.
DNS_FAKE_FILE="$(mktemp)"; echo '{}' > "$DNS_FAKE_FILE"; chmod 644 "$DNS_FAKE_FILE"
export DNS_FAKE_FILE

echo "==> Starting the server"
docker run -d --name "$APP" --network host \
  -e PORT=3001 \
  -e DATABASE_URL="postgresql://iron:ironpw@127.0.0.1:55432/ironmail" \
  -e ADMIN_TOKEN="$ADMIN_TOKEN" \
  -e STALWART_RECOVERY_ADMIN="$RECOVERY_ADMIN" \
  -e OPENSEARCH_URL=https://localhost:9200 \
  -e OPENSEARCH_PASSWORD="$OPENSEARCH_PASSWORD" \
  -e PLATFORM_ADMINS=e2e-platform-admin@iron-id.io \
  -e SIGNUP_ENABLED=true \
  -e IRONID_DNS_FAKE=/run/ironid-dns-fake.json -v "$DNS_FAKE_FILE:/run/ironid-dns-fake.json:ro" \
  ironid:e2e >/dev/null

echo "==> Installing test dependencies"
(cd "$ROOT/webmail" && npm ci --omit=dev --silent)
(cd "$ROOT/tests/e2e" && npm install --silent --no-audit --no-fund)
if [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ] || [ ! -d "${PLAYWRIGHT_BROWSERS_PATH}" ]; then
  (cd "$ROOT/tests/e2e" && npx playwright install --with-deps chromium)
fi

echo "==> Running tests"
set +e
(cd "$ROOT/tests/e2e" && \
  BASE_URL=http://127.0.0.1:3001 ENGINE_URL=http://127.0.0.1:8080 \
  RESTART_CMD="docker restart $APP" EXPECT_OPENSEARCH=1 \
  OPENSEARCH_TEST_URL=https://localhost:9200 OPENSEARCH_TEST_PASSWORD="$OPENSEARCH_PASSWORD" \
  npm test -- ./*.test.js)
STATUS=$?
set -e

if [ $STATUS -ne 0 ]; then
  echo "==> Tests failed; last server log lines:"
  docker logs --tail 80 "$APP" || true
  echo "==> Last mail search log lines:"
  docker logs --tail 40 "$OS" || true
fi
exit $STATUS
