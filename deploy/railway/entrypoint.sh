#!/usr/bin/env bash
set -e

echo "===================================================================="
echo " [IRON ID] Initializing Sovereign VPS Container on Railway"
echo "===================================================================="

# 1. Start PostgreSQL service
echo "--> Starting PostgreSQL service..."
service postgresql start

# Wait for PostgreSQL to be ready
until su - postgres -c "pg_isready" > /dev/null 2>&1; do
  echo "Waiting for PostgreSQL to initialize..."
  sleep 1
done

# 2. Initialize user and database if not already created
echo "--> Verifying database and user..."
su - postgres -c "psql -tc \"SELECT 1 FROM pg_user WHERE usename = 'stalwart'\" | grep -q 1 || psql -c \"CREATE USER stalwart WITH PASSWORD 'StalwartSecretPass2026!' SUPERUSER;\""
su - postgres -c "psql -tc \"SELECT 1 FROM pg_database WHERE datname = 'stalwart_mail'\" | grep -q 1 || psql -c \"CREATE DATABASE stalwart_mail OWNER stalwart;\""

# Run schema migrations
echo "--> Executing schema migrations..."
su - postgres -c "psql -d stalwart_mail -f /opt/iron-id/init.sql" || true

# 3. Start SeaweedFS S3 engine
mkdir -p /data/seaweed /opt/iron-id/data /var/log
echo "--> Starting SeaweedFS S3 engine on port 8333..."
/usr/local/bin/weed server -dir=/data/seaweed -s3 -s3.port=8333 -s3.allowEmptyFolder=true -ip=127.0.0.1 > /var/log/seaweedfs.log 2>&1 &

sleep 2

# 4. Start Stalwart Mail Server
echo "--> Starting Stalwart Mail Engine on port 8080..."
/usr/local/bin/stalwart-mail -c /opt/iron-id/config.toml > /var/log/stalwart.log 2>&1 &

sleep 2

# 5. Start Webmail & Admin Gateway in foreground
echo "--> Starting Webmail & Admin Gateway on port ${PORT:-3001}..."
cd /opt/iron-id/webmail
exec node server.js
