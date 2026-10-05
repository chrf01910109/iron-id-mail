#!/usr/bin/env bash
# ==============================================================================
# IRON ID Sovereign Mail — Automated Linux VPS Provisioning & Deployment Script
# Target OS: Ubuntu 24.04 LTS (x86_64)
# Target Hostname: mail.iron-id.io
# ==============================================================================

set -euo pipefail

DOMAIN="iron-id.io"
HOSTNAME="mail.iron-id.io"
STALWART_VERSION="0.16.23"
INSTALL_DIR="/opt/iron-id"

echo "================================================================"
echo " [IRON ID] Sovereign Mail Engine & Gateway VPS Setup"
echo " Target Domain: ${DOMAIN} (${HOSTNAME})"
echo "================================================================"

# 1. Update OS and Install Base Tools
echo "--> [1/7] Updating package index and installing dependencies..."
apt-get update -y
apt-get install -y curl ufw tar unzip git libssl-dev ca-certificates

# Install Node.js 20+ LTS
if ! command -v node &> /dev/null; then
  echo "--> Installing Node.js LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# 2. Configure Hostname
echo "--> [2/7] Setting system hostname to ${HOSTNAME}..."
hostnamectl set-hostname "${HOSTNAME}"
if ! grep -q "${HOSTNAME}" /etc/hosts; then
  echo "127.0.0.1 ${HOSTNAME}" >> /etc/hosts
fi

# 3. Configure Firewall (UFW)
echo "--> [3/7] Setting up UFW firewall rules for sovereign email ports..."
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH Remote Access'
ufw allow 25/tcp comment 'SMTP Inbound MTA (Server-to-Server)'
ufw allow 80/tcp comment 'HTTP ACME Let Encrypt'
ufw allow 443/tcp comment 'HTTPS JMAP & Web API'
ufw allow 465/tcp comment 'SMTPS Secure Outbound Submission'
ufw allow 587/tcp comment 'SMTP Submission'
ufw allow 993/tcp comment 'IMAPS Encrypted Client Sync'
ufw allow 4190/tcp comment 'ManageSieve Rule Engine'
ufw allow 3001/tcp comment 'IRON ID Webmail & Admin Gateway'
ufw --force enable

# 4. Install Stalwart Mail Server
echo "--> [4/7] Downloading and installing Stalwart Mail Engine v${STALWART_VERSION}..."
mkdir -p "${INSTALL_DIR}/engine/data"
mkdir -p "${INSTALL_DIR}/webmail"

ARCH=$(uname -m)
if [ "${ARCH}" = "x86_64" ]; then
  STALWART_ARCH="x86_64-unknown-linux-gnu"
elif [ "${ARCH}" = "aarch64" ]; then
  STALWART_ARCH="aarch64-unknown-linux-gnu"
else
  echo "Unsupported architecture: ${ARCH}"
  exit 1
fi

STALWART_URL="https://github.com/stalwartlabs/mail-server/releases/download/v${STALWART_VERSION}/stalwart-mail-${STALWART_ARCH}.tar.gz"
echo "Downloading from: ${STALWART_URL}"
curl -sSL "${STALWART_URL}" | tar -xz -C "${INSTALL_DIR}/engine"

chmod +x "${INSTALL_DIR}/engine/stalwart-mail"
ln -sf "${INSTALL_DIR}/engine/stalwart-mail" /usr/local/bin/stalwart-mail

# 5. Production Configuration (config.toml)
echo "--> [5/7] Writing Stalwart production configuration..."
cat << 'EOF' > "${INSTALL_DIR}/engine/config.toml"
[server]
hostname = "mail.iron-id.io"

[storage]
data = "rocksdb"
blob = "rocksdb"
lookup = "rocksdb"
fts = "rocksdb"

[store.rocksdb]
type = "rocksdb"
path = "/opt/iron-id/engine/data"
compression = "lz4"
cache-size = "512MB"
write-buffer-size = "256MB"

[directory.internal]
type = "internal"
store = "rocksdb"

# TLS & ACME Automatic Certificate Provisioning
[certificate."letsencrypt"]
acme = "letsencrypt"
domains = ["mail.iron-id.io"]

[acme."letsencrypt"]
directory = "https://acme-v02.api.letsencrypt.org/directory"
contact = ["admin@iron-id.io"]

# Network Listeners
[server.listener."smtp"]
bind = ["0.0.0.0:25", "[::]:25"]
protocol = "smtp"

[server.listener."submissions"]
bind = ["0.0.0.0:465", "[::]:465"]
protocol = "smtp"
tls.implicit = true
tls.certificate = "letsencrypt"

[server.listener."submission"]
bind = ["0.0.0.0:587", "[::]:587"]
protocol = "smtp"
tls.certificate = "letsencrypt"

[server.listener."imaps"]
bind = ["0.0.0.0:993", "[::]:993"]
protocol = "imap"
tls.implicit = true
tls.certificate = "letsencrypt"

[server.listener."http"]
bind = ["127.0.0.1:8080"]
protocol = "http"

[jmap]
allow-insecure-auth = true

[authentication]
allow-cleartext = true
EOF

# 6. Set up Systemd Services
echo "--> [6/7] Setting up Systemd services (Auto-start on boot)..."

# Stalwart Mail Engine Service
cat << EOF > /etc/systemd/system/stalwart-mail.service
[Unit]
Description=Stalwart Sovereign Mail Engine
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}/engine
ExecStart=${INSTALL_DIR}/engine/stalwart-mail -c ${INSTALL_DIR}/engine/config.toml
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

# Node.js Webmail & Admin Gateway Service
cat << EOF > /etc/systemd/system/iron-webmail.service
[Unit]
Description=IRON ID Sovereign Webmail & Admin Gateway
After=stalwart-mail.service

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}/webmail
ExecStart=/usr/bin/node ${INSTALL_DIR}/webmail/server.js
Restart=always
RestartSec=5
Environment=PORT=3001
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable stalwart-mail.service
systemctl enable iron-webmail.service

echo "--> [7/7] Deployment script prepared successfully."
echo "================================================================"
echo " Installation blueprint is ready at /opt/iron-id."
echo " Start services when DNS records propagate:"
echo "   systemctl start stalwart-mail"
echo "   systemctl start iron-webmail"
echo "================================================================"
