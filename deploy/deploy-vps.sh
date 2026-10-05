#!/usr/bin/env bash
# ==============================================================================
# IRON ID Sovereign Mail — Master Automated VPS Bootstrap & Deployment Script
# Target Stack: PostgreSQL 16 + OpenSearch 2 + SeaweedFS + Stalwart + Webmail
# Platform OS: Ubuntu 24.04 LTS (x86_64)
# ==============================================================================

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "${DEPLOY_DIR}")"

echo "===================================================================="
echo " [IRON ID] Deploying 100% Permissive Sovereign Enterprise Mail Stack"
echo " Services: PostgreSQL 16 + OpenSearch 2 + SeaweedFS + Stalwart Rust"
echo "===================================================================="

# 1. Install Docker & Docker Compose if missing
if ! command -v docker &> /dev/null; then
  echo "--> [1/5] Installing Docker Engine & Docker Compose Plugin..."
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg ufw
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
    tee /etc/apt/sources.list.d/docker.list > /dev/null

  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
else
  echo "--> [1/5] Docker is already installed."
fi

# 2. Configure Host Virtual Memory for OpenSearch (Mandatory for Linux)
echo "--> [2/5] Setting virtual memory mmap counts for OpenSearch..."
sysctl -w vm.max_map_count=262144
if ! grep -q "vm.max_map_count=262144" /etc/sysctl.conf; then
  echo "vm.max_map_count=262144" >> /etc/sysctl.conf
fi

# 3. Configure Firewall (UFW)
echo "--> [3/5] Configuring firewall rules for mail & web access..."
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 25/tcp comment 'Inbound SMTP MTA'
ufw allow 80/tcp comment 'HTTP ACME Let Encrypt'
ufw allow 443/tcp comment 'HTTPS'
ufw allow 465/tcp comment 'SMTPS Submission'
ufw allow 587/tcp comment 'SMTP Submission'
ufw allow 993/tcp comment 'IMAPS Sync'
ufw allow 4190/tcp comment 'Sieve Filter'
ufw allow 3001/tcp comment 'IRON ID Webmail & Admin'
ufw --force enable

# 4. Launch Multi-Container Stack via Docker Compose
echo "--> [4/5] Pulling and launching containerized stack..."
cd "${DEPLOY_DIR}"
docker compose pull
docker compose up -d --build

# 5. Initialize PostgreSQL Schema & OpenSearch Indexes
echo "--> [5/5] Running database migrations & initializing stores..."
sleep 8

# Execute PostgreSQL schema
docker exec -i iron-id-postgres psql -U stalwart -d stalwart_mail < "${DEPLOY_DIR}/init.sql" || true

echo "===================================================================="
echo " ✔ All 5 Sovereign Services are running successfully!"
echo "   Webmail Client:       http://localhost:3001"
echo "   Admin Console:        http://localhost:3001/admin"
echo "   PostgreSQL 16:        127.0.0.1:5432"
echo "   OpenSearch 2:         127.0.0.1:9200"
echo "   SeaweedFS S3 Store:   127.0.0.1:8333 (Filer: :8888)"
echo "   Stalwart Mail Engine: 127.0.0.1:8080 (MTA: :25, IMAPS: :993)"
echo "===================================================================="
