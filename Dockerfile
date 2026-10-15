# ==============================================================================
# IRON ID Sovereign Mail — All-in-One Railway Virtual VPS Container
# Runs: PostgreSQL 16 + IRON ID Sovereign Mail Engine (Rust) + Node.js Webmail Gateway
# ==============================================================================

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PORT=3001
ENV NODE_ENV=production

# 1. Install System Dependencies, PostgreSQL 16, and Node.js LTS
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    tar \
    ca-certificates \
    tzdata \
    postgresql \
    postgresql-contrib \
    postgresql-client \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# 2. Download and Install IRON ID Sovereign Mail Engine (Rust)
#    The download is checked against a pinned SHA-256 (same file fetched on 2026-10-12 and 2026-10-14).
ARG STALWART_SHA256=967dfad2bed7ee7b475e78dfcf2f75bbfc30c851afb7d5951b0a80f2061cd3d4
RUN curl -fsSL -o /tmp/stalwart.tgz https://github.com/stalwartlabs/stalwart/releases/download/v0.16.23/stalwart-x86_64-unknown-linux-gnu.tar.gz \
    && echo "${STALWART_SHA256}  /tmp/stalwart.tgz" | sha256sum -c - \
    && tar -xzf /tmp/stalwart.tgz -C /usr/local/bin/ && rm /tmp/stalwart.tgz \
    && chmod +x /usr/local/bin/stalwart \
    && ln -sf /usr/local/bin/stalwart /usr/local/bin/ironid-engine \
    && ln -sf /usr/local/bin/stalwart /usr/local/bin/stalwart-mail

# 3. Set up Application Workspace
WORKDIR /opt/iron-id

COPY webmail /opt/iron-id/webmail
COPY engine /opt/iron-id/engine
COPY deploy/init.sql /opt/iron-id/init.sql
COPY deploy/railway/entrypoint.sh /opt/iron-id/entrypoint.sh
COPY server.js /opt/iron-id/server.js
COPY package.json /opt/iron-id/package.json

RUN chmod +x /opt/iron-id/entrypoint.sh \
    && mkdir -p /app \
    && ln -sf /opt/iron-id/server.js /app/server.js \
    && cd /opt/iron-id/webmail && npm ci --omit=dev

EXPOSE 3001

ENTRYPOINT ["/opt/iron-id/entrypoint.sh"]
