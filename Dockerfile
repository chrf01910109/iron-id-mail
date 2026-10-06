# ==============================================================================
# IRON ID Sovereign Mail — All-in-One Railway Virtual VPS Container
# Runs: Stalwart Mail Server (Rust + RocksDB) + Node.js Webmail Gateway
# ==============================================================================

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PORT=8080
ENV NODE_ENV=production

# 1. Install System Dependencies and Node.js LTS
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    tar \
    ca-certificates \
    tzdata \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# 2. Download and Install Stalwart Mail Server (Rust)
RUN curl -fsSL https://github.com/stalwartlabs/stalwart/releases/download/v0.16.23/stalwart-x86_64-unknown-linux-gnu.tar.gz \
    | tar -xz -C /usr/local/bin/ \
    && chmod +x /usr/local/bin/stalwart \
    && ln -sf /usr/local/bin/stalwart /usr/local/bin/stalwart-mail

# 3. Set up Application Workspace
WORKDIR /opt/iron-id

COPY webmail /opt/iron-id/webmail
COPY engine /opt/iron-id/engine
COPY engine/data /opt/iron-id/data
COPY deploy/railway/config.all-in-one.toml /opt/iron-id/config.toml
COPY deploy/railway/entrypoint.sh /opt/iron-id/entrypoint.sh
COPY server.js /opt/iron-id/server.js
COPY package.json /opt/iron-id/package.json

RUN chmod +x /opt/iron-id/entrypoint.sh \
    && mkdir -p /app \
    && ln -sf /opt/iron-id/server.js /app/server.js \
    && cd /opt/iron-id/webmail && npm install --production || true

EXPOSE 8080 8085 25 465 587 993

ENTRYPOINT ["/opt/iron-id/entrypoint.sh"]
