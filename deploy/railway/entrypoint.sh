#!/usr/bin/env bash
set -e

echo "===================================================================="
echo " [IRON ID] Initializing All-in-One Sovereign VPS Container on Railway"
echo "===================================================================="

# Ensure data directories exist
mkdir -p /data/seaweed /opt/iron-id/data /var/log /var/run /var/lib/postgresql/16/main
chown -R postgres:postgres /var/lib/postgresql

# Initialize PostgreSQL cluster if not already initialized
if [ ! -f /var/lib/postgresql/16/main/PG_VERSION ]; then
  echo "--> Initializing PostgreSQL 16 cluster..."
  su - postgres -c "/usr/lib/postgresql/16/bin/initdb -D /var/lib/postgresql/16/main"
fi

# Temporarily start PostgreSQL to run init.sql
echo "--> Starting PostgreSQL for database bootstrap..."
su - postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/postgresql/16/main -l /var/log/pg_boot.log start"

# Create database and user
echo "--> Bootstrapping database and running migrations..."
su - postgres -c "psql -c \"CREATE USER stalwart WITH PASSWORD 'StalwartSecretPass2026!' SUPERUSER;\"" || true
su - postgres -c "psql -c \"CREATE DATABASE stalwart_mail OWNER stalwart;\"" || true
su - postgres -c "psql -d stalwart_mail -f /opt/iron-id/init.sql" || true

# Stop temporary PostgreSQL
su - postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/postgresql/16/main stop"

echo "--> Launching Supervisor daemon..."
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
