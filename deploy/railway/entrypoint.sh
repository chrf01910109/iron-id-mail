#!/usr/bin/env bash
set -e

echo "===================================================================="
echo " [IRON ID] Initializing Sovereign Mail Engine & Webmail Gateway"
echo "===================================================================="

mkdir -p /opt/iron-id/data /var/log /opt/iron-id/engine

# 1. Start Stalwart Mail Server in background
echo "--> Starting Stalwart Mail Engine on internal port 8085..."
/usr/local/bin/stalwart -c /opt/iron-id/config.toml > /var/log/stalwart.log 2>&1 &
STALWART_PID=$!

# 2. Wait for Stalwart to be ready
echo "--> Verifying Stalwart Mail Engine is listening..."
MAX_RETRIES=20
RETRY_COUNT=0
READY=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  if curl -s http://127.0.0.1:8085/jmap/session > /dev/null 2>&1; then
    READY=1
    break
  fi
  RETRY_COUNT=$((RETRY_COUNT+1))
  echo "Waiting for Stalwart Mail Engine to initialize... ($RETRY_COUNT/$MAX_RETRIES)"
  sleep 1
done

if [ $READY -eq 1 ]; then
  echo "--> Stalwart Mail Engine is LIVE and READY on port 8085!"
else
  echo "[WARNING] Stalwart took longer than expected to report ready. Logs:"
  cat /var/log/stalwart.log || true
fi

# 3. Start Webmail & Admin Gateway in foreground
echo "--> Starting Webmail & Admin Gateway on port ${PORT:-8080}..."
cd /opt/iron-id/webmail
exec node server.js
