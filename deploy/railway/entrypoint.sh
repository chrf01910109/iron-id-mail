#!/usr/bin/env bash
set -e

echo "===================================================================="
echo " [IRON ID] Initializing Sovereign VPS Container with PostgreSQL 16"
echo "===================================================================="

mkdir -p /opt/iron-id/data /var/log /opt/iron-id/engine

# 1. Determine PostgreSQL Connection Parameters
DB_HOST="${PGHOST:-127.0.0.1}"
DB_PORT="${PGPORT:-5432}"
DB_USER="${PGUSER:-stalwart}"
DB_PASS="${PGPASSWORD:-StalwartSecretPass2026!}"
DB_NAME="${PGDATABASE:-stalwart_mail}"

if [ -n "$DATABASE_URL" ]; then
  echo "--> Detected Railway DATABASE_URL environment variable..."
  DB_USER=$(echo "$DATABASE_URL" | sed -E 's|^postgresql://([^:]+):.*|\1|')
  DB_PASS=$(echo "$DATABASE_URL" | sed -E 's|^postgresql://[^:]+:([^@]+)@.*|\1|')
  DB_HOST=$(echo "$DATABASE_URL" | sed -E 's|^postgresql://[^@]+@([^:]+):.*|\1|')
  DB_PORT=$(echo "$DATABASE_URL" | sed -E 's|^postgresql://[^:]+:[^@]+@[^:]+:([0-9]+)/.*|\1|')
  DB_NAME=$(echo "$DATABASE_URL" | sed -E 's|^postgresql://.*/([^?]+).*|\1|')
fi

echo "--> Target PostgreSQL: host=$DB_HOST port=$DB_PORT user=$DB_USER db=$DB_NAME"

# 2. If connecting to local postgres, start and initialize PostgreSQL service
if [ "$DB_HOST" = "127.0.0.1" ] || [ "$DB_HOST" = "localhost" ]; then
  echo "--> Starting local PostgreSQL 16 server..."
  service postgresql start || /etc/init.d/postgresql start
  
  until su - postgres -c "pg_isready" > /dev/null 2>&1; do
    echo "Waiting for local PostgreSQL to initialize..."
    sleep 1
  done

  # Create role and database if not already existing
  su - postgres -c "psql -tc \"SELECT 1 FROM pg_user WHERE usename = '$DB_USER'\" | grep -q 1 || psql -c \"CREATE USER $DB_USER WITH PASSWORD '$DB_PASS' SUPERUSER;\""
  su - postgres -c "psql -tc \"SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'\" | grep -q 1 || psql -c \"CREATE DATABASE $DB_NAME OWNER $DB_USER;\""
fi

# 3. Apply Schema Migrations
echo "--> Applying PostgreSQL schema migrations from init.sql..."
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f /opt/iron-id/init.sql 2>&1 || true

# 4. Generate Stalwart config.toml pointing to PostgreSQL
echo "--> Generating Stalwart PostgreSQL 16 configuration..."
cat <<EOF > /opt/iron-id/config.toml
# ==============================================================================
# IRON ID Sovereign Mail — PostgreSQL 16 Configuration
# ==============================================================================
[server]
hostname = "mail.iron-id.io"

[storage]
data = "postgres"
lookup = "postgres"
blob = "postgres"
fts = "postgres"

[store.postgres]
type = "postgres"
host = "$DB_HOST"
port = $DB_PORT
database = "$DB_NAME"
user = "$DB_USER"
password = "$DB_PASS"
max-connections = 32

[directory.internal]
type = "internal"
store = "postgres"

[server.listener."http"]
bind = ["127.0.0.1:8085"]
protocol = "http"

[jmap]
allow-insecure-auth = true

[authentication]
allow-cleartext = true
EOF

# 5. Import Seed Accounts & Mailboxes into PostgreSQL if fresh
if [ -d "/opt/iron-id/export_data.json" ]; then
  echo "--> Importing seed identities and accounts into PostgreSQL store..."
  /usr/local/bin/stalwart -c /opt/iron-id/config.toml -i /opt/iron-id/export_data.json 2>&1 || true
fi

# 6. Start Stalwart Mail Server (PostgreSQL) in background
echo "--> Starting Stalwart Mail Engine (PostgreSQL 16) on port 8085..."
/usr/local/bin/stalwart -c /opt/iron-id/config.toml > /var/log/stalwart.log 2>&1 &

# 7. Wait for Stalwart to report healthy
echo "--> Verifying Stalwart PostgreSQL engine is listening..."
MAX_RETRIES=30
RETRY_COUNT=0
READY=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  if curl -s http://127.0.0.1:8085/jmap/session > /dev/null 2>&1; then
    READY=1
    break
  fi
  RETRY_COUNT=$((RETRY_COUNT+1))
  echo "Waiting for Stalwart PostgreSQL engine to initialize... ($RETRY_COUNT/$MAX_RETRIES)"
  sleep 1
done

if [ $READY -eq 1 ]; then
  echo "--> Stalwart PostgreSQL 16 Engine is LIVE and READY on port 8085!"
else
  echo "[WARNING] Stalwart took longer than expected. Logs:"
  cat /var/log/stalwart.log || true
fi

# 8. Start Webmail & Admin Gateway in foreground
echo "--> Starting Webmail & Admin Gateway on port ${PORT:-8080}..."
cd /opt/iron-id/webmail
exec node server.js
