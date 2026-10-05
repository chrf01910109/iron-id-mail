# 🚂 IRON ID Sovereign Mail — Railway Integration & Deployment Guide

> **Target Platform:** Railway.app  
> **Components:** PostgreSQL 16 + OpenSearch 2 + SeaweedFS + Stalwart Rust + Webmail Gateway  
> **Date:** October 5, 2026

---

## 📌 1. Critical Engineering Overview: Railway & Mail Protocols

Before deploying, it is essential to understand the technical boundary between **Web Apps** and **Email Servers**:

| Component | Railway Capability | Assessment |
| :--- | :--- | :--- |
| **PostgreSQL 16** | 1-Click Managed Database Plugin | ⭐ **Flawless**: Automated daily backups, zero ops, high performance. |
| **Webmail & Admin Console** | Native Node.js / Docker Service | ⭐ **Flawless**: Auto HTTPS, zero-downtime deploys, custom domain `mail.iron-id.io`. |
| **SeaweedFS (S3)** | Docker Container + Persistent Volume | ⭐ **Flawless**: Provides fast internal S3 endpoint on `seaweedfs.railway.internal:8333`. |
| **OpenSearch 2.x** | Docker Container + Persistent Volume | ⭐ **Flawless**: Provides internal search endpoint on `opensearch.railway.internal:9200`. |
| **JMAP Protocol (HTTP)** | Standard HTTP over port 8080 | ⭐ **Flawless**: Modern JSON protocol works natively over Railway HTTPS. |
| **Port 25 Inbound/Outbound MTA** | Standard raw server-to-server SMTP | ⚠️ **PaaS Constraint**: Like Heroku/Render, Railway does not allocate a raw dedicated public IP with custom Reverse DNS (PTR) on standard Port 25. |

---

## 🎯 2. The Two Proven Deployment Patterns

### Pattern A: Hybrid Architecture (Recommended for Enterprise Deliverability)
* **Railway Hosts**:
  1. **PostgreSQL** (Managed Database).
  2. **OpenSearch** (Search Engine).
  3. **SeaweedFS** (Object Storage with Railway Persistent Volume).
  4. **Webmail Gateway & Admin Console** (Hosted at `mail.iron-id.io` with free automatic SSL).
* **Small Linux VPS (€4/mo on Hetzner/OVH) Hosts**:
  * **Stalwart Mail Engine** (The lightweight Rust binary running on port 25 with a dedicated IP and Reverse DNS / PTR record).
  * Stalwart connects directly to Railway's PostgreSQL, OpenSearch, and SeaweedFS!
* **Why this is best**: You get 100% zero-maintenance databases and web apps on Railway, while keeping a clean dedicated IP for 10/10 Google & Microsoft inbox deliverability.

---

### Pattern B: 100% Full Railway Deployment (Internal / API-First)
If you want **every service running exclusively inside Railway**:
* Deploy all 5 containers directly within a single Railway Project.
* All internal services communicate over **Railway Private Networking** (`.railway.internal`).
* Access Webmail and the JMAP Admin API over Railway public HTTPS.
* For outbound email delivery to external consumer inboxes (Gmail/Yahoo), configure Stalwart to relay outbound traffic through a sovereign relay or transactional service.

---

## 🛠️ 3. Step-by-Step Deployment on Railway

### Step 1: Create a Railway Project
1. Log in to [Railway.app](https://railway.app).
2. Click **"New Project"** ➔ **"Empty Project"**.
3. Name your project: `iron-id-sovereign-mail`.

---

### Step 2: Add Managed PostgreSQL 16
1. In your project canvas, click **"New"** ➔ **"Database"** ➔ **"Add PostgreSQL"**.
2. Railway will instantly provision PostgreSQL 16 and provide a private connection string:
   `${{Postgres.DATABASE_URL}}`
3. Click on the PostgreSQL service ➔ **Data** tab ➔ execute the SQL migrations from [`deploy/init.sql`](file:///c:/Users/LENOVO/.gemini/antigravity-ide/scratch/iron-id-workspace/deploy/init.sql).

---

### Step 3: Deploy SeaweedFS (S3 Object Storage)
1. Click **"New"** ➔ **"Docker Image"**.
2. Image: `chrislusf/seaweedfs:latest`
3. Click on the service ➔ **Settings**:
   * **Service Name**: `seaweedfs`
   * **Custom Start Command**: `server -dir=/data -s3 -s3.port=8333 -s3.allowEmptyFolder=true -ip=0.0.0.0`
4. Go to **Volumes** ➔ Click **"Add Volume"**:
   * Mount path: `/data`
   * Size: 20 GB (or custom)
5. *Result*: SeaweedFS is now accessible internally at `http://seaweedfs.railway.internal:8333`.

---

### Step 4: Deploy OpenSearch 2.x
1. Click **"New"** ➔ **"Docker Image"**.
2. Image: `opensearchproject/opensearch:2.17.0`
3. Click on the service ➔ **Settings**:
   * **Service Name**: `opensearch`
4. Go to **Variables** ➔ Add:
   * `discovery.type` = `single-node`
   * `plugins.security.disabled` = `true`
   * `OPENSEARCH_JAVA_OPTS` = `-Xms1g -Xmx1g`
5. Go to **Volumes** ➔ Add Volume:
   * Mount path: `/usr/share/opensearch/data`
6. *Result*: OpenSearch is now accessible internally at `http://opensearch.railway.internal:9200`.

---

### Step 5: Deploy the Webmail Client & Admin Gateway
1. Click **"New"** ➔ **"GitHub Repo"** (push your `iron-id-workspace` to GitHub, or use Railway CLI).
2. Railway detects [`railway.json`](file:///c:/Users/LENOVO/.gemini/antigravity-ide/scratch/iron-id-workspace/railway.json) and builds using [`webmail/Dockerfile`](file:///c:/Users/LENOVO/.gemini/antigravity-ide/scratch/iron-id-workspace/webmail/Dockerfile).
3. Go to **Variables** ➔ Add:
   * `PORT` = `3001`
   * `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   * `OPENSEARCH_URL` = `http://opensearch.railway.internal:9200`
   * `SEAWEED_ENDPOINT` = `http://seaweedfs.railway.internal:8333`
   * `STALWART_HOST` = `stalwart.railway.internal` (or your VPS IP if using Hybrid)
   * `STALWART_PORT` = `8080`
4. Go to **Settings** ➔ **Networking** ➔ Click **"Generate Domain"** (or add your custom domain `mail.iron-id.io`).

---

### Step 6: Deploy Stalwart Mail Engine
If deploying Stalwart directly on Railway:
1. Click **"New"** ➔ **"Docker Image"**.
2. Image: `stalwartlabs/mail-server:v0.16.23`
3. Mount a volume at `/opt/stalwart-mail/data`.
4. Point Stalwart's `config.toml` to:
   * PostgreSQL: `postgres.railway.internal:5432`
   * OpenSearch: `http://opensearch.railway.internal:9200`
   * SeaweedFS: `http://seaweedfs.railway.internal:8333`

---

## 📊 Summary of Service Endpoints on Railway

| Service | Internal Railway Host | Public Access |
| :--- | :--- | :--- |
| **PostgreSQL 16** | `postgres.railway.internal:5432` | Private (Secured) |
| **OpenSearch 2** | `opensearch.railway.internal:9200` | Private (Secured) |
| **SeaweedFS S3** | `seaweedfs.railway.internal:8333` | Private (Secured) |
| **Stalwart Engine** | `stalwart.railway.internal:8080` | JMAP HTTP / Proxy |
| **Webmail & Admin** | `webmail.railway.internal:3001` | 🌐 **https://mail.iron-id.io** |
