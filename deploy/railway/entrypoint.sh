#!/usr/bin/env bash
set -e

echo "===================================================================="
echo " [IRON ID] Initializing Sovereign VPS Container with PostgreSQL 16"
echo "===================================================================="

mkdir -p /opt/iron-id/data /var/log /opt/iron-id/engine /var/log/postgresql

# 1. Generate config.json using Node.js URL parser (handles DATABASE_URL and env vars safely)
node /opt/iron-id/webmail/scripts/generateConfig.js

DB_HOST=$(node -e "console.log(require('/opt/iron-id/webmail/services/dbUrlParser').getPostgresConfig().host)")
DB_PORT=$(node -e "console.log(require('/opt/iron-id/webmail/services/dbUrlParser').getPostgresConfig().port)")
DB_USER=$(node -e "console.log(require('/opt/iron-id/webmail/services/dbUrlParser').getPostgresConfig().user)")
DB_PASS=$(node -e "console.log(require('/opt/iron-id/webmail/services/dbUrlParser').getPostgresConfig().password)")
DB_NAME=$(node -e "console.log(require('/opt/iron-id/webmail/services/dbUrlParser').getPostgresConfig().database)")

echo "--> Target PostgreSQL: host=$DB_HOST port=$DB_PORT user=$DB_USER db=$DB_NAME"

# 2. Without DATABASE_URL, run a PostgreSQL inside this container (data is lost on redeploy)
if [ -z "$DATABASE_URL" ]; then
  echo "--> Setting up local PostgreSQL 16 socket and data directories..."
  mkdir -p /var/run/postgresql /var/lib/postgresql
  chown -R postgres:postgres /var/run/postgresql /var/log/postgresql /var/lib/postgresql 2>/dev/null || true
  chmod 2777 /var/run/postgresql 2>/dev/null || true

  # Configure pg_hba.conf for trust authentication
  find /etc/postgresql -name pg_hba.conf -exec sed -i 's/scram-sha-256/trust/g; s/md5/trust/g; s/peer/trust/g' {} + 2>/dev/null || true

  echo "--> Starting local PostgreSQL 16 server..."
  service postgresql start || /etc/init.d/postgresql start || su - postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/postgresql/16/main -l /var/log/postgresql/postgresql.log start" || true

  PG_WAIT=0
  until su - postgres -c "pg_isready" > /dev/null 2>&1; do
    PG_WAIT=$((PG_WAIT+1))
    if [ $PG_WAIT -ge 60 ]; then
      echo "[FATAL] Local PostgreSQL did not start within 60s. Exiting so Railway restarts the container."
      exit 1
    fi
    echo "Waiting for local PostgreSQL to initialize... ($PG_WAIT/60)"
    sleep 1
  done

  # Create role and database if not already existing
  su - postgres -c "psql -tc \"SELECT 1 FROM pg_user WHERE usename = '$DB_USER'\" | grep -q 1 || psql -c \"CREATE USER $DB_USER WITH PASSWORD '$DB_PASS' SUPERUSER;\"" || true
  su - postgres -c "psql -tc \"SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'\" | grep -q 1 || psql -c \"CREATE DATABASE $DB_NAME OWNER $DB_USER;\"" || true
fi

# 3. Apply Schema Migrations
echo "--> Applying PostgreSQL schema migrations from init.sql..."
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f /opt/iron-id/init.sql 2>&1 || true

# 4. Import seed accounts ONLY ONCE per database.
#    A marker row in ironid_meta records that the seed was imported, so later
#    deploys never overwrite real mail or changed passwords.
if [ -z "$DATABASE_URL" ]; then
  echo "[WARNING] DATABASE_URL is not set: using a database INSIDE the container."
  echo "[WARNING] All mail and password changes are LOST on every redeploy."
  echo "[WARNING] Attach a Railway PostgreSQL service and set DATABASE_URL to keep data."
fi

export PGPASSWORD="$DB_PASS"
PSQL="psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -tA -v ON_ERROR_STOP=1"

if ! $PSQL -c "CREATE TABLE IF NOT EXISTS ironid_meta (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW());" > /dev/null; then
  echo "[FATAL] Cannot reach the database at $DB_HOST:$DB_PORT/$DB_NAME. Exiting so Railway restarts the container."
  exit 1
fi

SEEDED=$($PSQL -c "SELECT value FROM ironid_meta WHERE key = 'seed_imported';" || echo "")
if [ -n "$SEEDED" ]; then
  echo "--> Seed already imported on $SEEDED. Keeping existing accounts and mail."
elif [ -d "/opt/iron-id/engine/export_data.json" ]; then
  echo "--> Fresh database: importing seed accounts and mailboxes (one time only)..."
  if /usr/local/bin/stalwart -c /opt/iron-id/config.json -i /opt/iron-id/engine/export_data.json; then
    $PSQL -c "INSERT INTO ironid_meta (key, value) VALUES ('seed_imported', NOW()::text) ON CONFLICT (key) DO NOTHING;" > /dev/null
    # The seed's account passwords are in this repository's history: the gateway replaces
    # them with random ones as soon as it has engine access (webmail/services/seedGuard.js).
    $PSQL -c "INSERT INTO ironid_meta (key, value) VALUES ('seed_passwords_pending', NOW()::text) ON CONFLICT (key) DO NOTHING;" > /dev/null
    echo "--> Seed import complete and recorded."
  else
    echo "[FATAL] Seed import failed. Exiting so it is retried on the next start."
    exit 1
  fi
fi
unset PGPASSWORD

# 5. Start IRON ID Sovereign Mail Engine (PostgreSQL 16) in background
echo "--> Starting IRON ID Sovereign Mail Engine (PostgreSQL 16) in background..."
touch /var/log/ironid-engine.log
ln -sf /var/log/ironid-engine.log /var/log/stalwart.log 2>/dev/null || true
(/usr/local/bin/ironid-engine -c /opt/iron-id/config.json || /usr/local/bin/stalwart -c /opt/iron-id/config.json) > /var/log/ironid-engine.log 2>&1 &

# 6. Wait for Engine to report healthy on internal port
echo "--> Verifying IRON ID Sovereign Mail Engine is listening..."
MAX_RETRIES=30
RETRY_COUNT=0
DETECTED_PORT=""

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  if curl -s http://127.0.0.1:8080/jmap/session > /dev/null 2>&1; then
    DETECTED_PORT="8080"
    break
  fi
  if curl -s http://127.0.0.1:8085/jmap/session > /dev/null 2>&1; then
    DETECTED_PORT="8085"
    break
  fi
  RETRY_COUNT=$((RETRY_COUNT+1))
  echo "Waiting for IRON ID Sovereign Engine... ($RETRY_COUNT/$MAX_RETRIES)"
  sleep 1
done

if [ -n "$DETECTED_PORT" ]; then
  echo "--> IRON ID Sovereign Engine (PostgreSQL 16) is LIVE and READY on internal port $DETECTED_PORT!"
else
  echo "[WARNING] IRON ID Engine log output:"
  cat /var/log/ironid-engine.log || true
fi

# 7. Start Webmail & Sovereign Admin Gateway
FINAL_ENGINE_PORT="${DETECTED_PORT:-8080}"
WEB_PORT="${PORT:-3001}"

# If Webmail port matches internal engine port, offset Webmail port
if [ "$WEB_PORT" = "$FINAL_ENGINE_PORT" ]; then
  WEB_PORT="3001"
fi

echo "--> Starting IRON ID Webmail & Sovereign Admin Gateway on port $WEB_PORT (connecting to internal engine on $FINAL_ENGINE_PORT)..."
cd /opt/iron-id/webmail
PORT="$WEB_PORT" IRONID_ENGINE_PORT="$FINAL_ENGINE_PORT" exec node server.js
