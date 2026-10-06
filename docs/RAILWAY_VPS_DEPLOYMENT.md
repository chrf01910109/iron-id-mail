# 🚂 Complete Guide: Deploying the Sovereign "VPS Container" on Railway

> **Goal:** Run the entire sovereign mail stack (Ubuntu 24.04 + PostgreSQL 16 + SeaweedFS + IRON ID Core Engine Rust + Webmail Gateway) as a self-contained virtual VPS directly on Railway.app.  
> **Date:** October 5, 2026

---

## 💡 What This Gives You

Instead of provisioning, configuring, and maintaining an external bare-metal or cloud VPS:
* Railway runs our **All-in-One Ubuntu 24.04 Container** (`deploy/railway/Dockerfile.all-in-one`).
* **`supervisord`** automatically monitors and manages all 4 core daemons inside the container:
  1. **PostgreSQL 16** (ACID metadata, accounts, directory, and tenant quotas).
  2. **SeaweedFS** (Apache 2.0 S3 storage for email attachment blobs).
  3. **IRON ID Sovereign Mail Engine** (Unified Rust core for JMAP, SMTP, and IMAP).
  4. **Node.js Gateway** (Webmail Single-Page App & Admin Console).
* Railway provides **zero-downtime deploys**, **automated health monitoring**, and **free automatic HTTPS/SSL** for your custom domain (`mail.iron-id.io`).

---

## 🚀 3-Step Deployment Guide

### Step 1: Push Your Workspace to GitHub
From your local machine terminal:
```bash
cd C:\Users\LENOVO\.gemini\antigravity-ide\scratch\iron-id-workspace

git init
git add .
git commit -m "feat: complete sovereign mail stack for Railway VPS"
git branch -M main
git remote add origin https://github.com/<YOUR_GITHUB_USERNAME>/iron-id-mail.git
git push -u origin main
```

---

### Step 2: Deploy on Railway
1. Open [Railway.app](https://railway.app) and sign in.
2. Click **"New Project"** ➔ **"Deploy from GitHub repo"**.
3. Select your repository: `iron-id-mail`.
4. Click on the newly created service in the Railway canvas.
5. Go to **Settings** ➔ **Build**:
   * Change **Dockerfile Path** to:
     ```text
     deploy/railway/Dockerfile.all-in-one
     ```
6. Click **Deploy**.

Railway will automatically build the Ubuntu 24.04 image, download IRON ID Core Engine and SeaweedFS, run database migrations, and boot all services under `supervisord`.

---

### Step 3: Generate Public Domain & Bind `mail.iron-id.io`
1. Inside your Railway service, go to **Settings** ➔ **Networking**.
2. Click **"Generate Domain"** to get an instant testing URL:
   `https://iron-id-mail-production.up.railway.app`
3. To attach your official domain:
   * Click **"Custom Domain"** ➔ Enter: `mail.iron-id.io`
   * Copy the CNAME record shown by Railway.
   * In Cloudflare DNS for `iron-id.io`, add:
     * **Type**: `CNAME`
     * **Name**: `mail`
     * **Target**: `<your-railway-cname>.railway.app`
     * **Proxy Status**: `Proxied (Orange Cloud)`

---

## 🎯 What You Can Do Once Deployed

1. **Access Webmail**:  
   Open `https://mail.iron-id.io` (or your `.up.railway.app` URL).  
   Log in with `charaf@iron-id.io` / `Ch@r@firon-!D`.
2. **Access Admin Console**:  
   Open `https://mail.iron-id.io/admin`.  
   Provision new tenant domains, adjust mailbox quotas, and run live DNS checks.
3. **Inspect Real-Time Logs**:  
   In Railway ➔ Click on your service ➔ **View Logs** to see live output from PostgreSQL, SeaweedFS, IRON ID Core Engine, and the Webmail Gateway simultaneously.
