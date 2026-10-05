# ==============================================================================
# IRON ID Sovereign Mail — All-in-One Railway Virtual VPS Container
# Runs: PostgreSQL 16 + SeaweedFS + Stalwart Rust + Node.js Webmail Gateway
# ==============================================================================

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PORT=3001
ENV NODE_ENV=production

# 1. Install System Dependencies, PostgreSQL, and Node.js LTS
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    tar \
    ca-certificates \
    gnupg \
    postgresql \
    postgresql-contrib \
    tzdata \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# 2. Download and Install Stalwart Mail Server (Rust)
RUN curl -fsSL https://github.com/stalwartlabs/stalwart/releases/download/v0.16.23/stalwart-x86_64-unknown-linux-gnu.tar.gz \
    | tar -xz -C /usr/local/bin/ \
    && chmod +x /usr/local/bin/stalwart \
    && ln -sf /usr/local/bin/stalwart /usr/local/bin/stalwart-mail

# 3. Download and Install SeaweedFS (Apache 2.0 S3 Storage)
RUN curl -fsSL https://github.com/seaweedfs/seaweedfs/releases/download/3.74/linux_amd64.tar.gz \
    | tar -xz -C /usr/local/bin/ \
    && chmod +x /usr/local/bin/weed

# 4. Set up Application Workspace
WORKDIR /opt/iron-id

COPY webmail /opt/iron-id/webmail
COPY deploy/init.sql /opt/iron-id/init.sql
COPY deploy/railway/config.all-in-one.toml /opt/iron-id/config.toml
COPY deploy/railway/entrypoint.sh /opt/iron-id/entrypoint.sh

RUN chmod +x /opt/iron-id/entrypoint.sh \
    && cd /opt/iron-id/webmail && npm install --production || true

EXPOSE 3001 8080 25 465 587 993

ENTRYPOINT ["/opt/iron-id/entrypoint.sh"]
