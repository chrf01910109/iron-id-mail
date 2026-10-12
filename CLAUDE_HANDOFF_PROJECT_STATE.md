# 🛡️ IRON ID Sovereign Mail — Complete Project State & Handoff Guide for Claude

> **Generated Date:** October 10, 2026  
> **Workspace:** `iron-id-workspace`  
> **GitHub Repository:** [https://github.com/chrf01910109/iron-id-mail.git](https://github.com/chrf01910109/iron-id-mail.git)  
> **Railway Live Production App:** [https://iron-id-mail-production.up.railway.app](https://iron-id-mail-production.up.railway.app)  
> **Admin Console:** [https://iron-id-mail-production.up.railway.app/admin](https://iron-id-mail-production.up.railway.app/admin)  
> **Target Domain:** `iron-id.io`  

---

## 📌 1. Executive Summary & Purpose

This document provides a **complete, standalone technical handover** for Claude on macOS to immediately resume work on the **IRON ID Sovereign Mail Server** project.

The goal of this project is to build and deploy an enterprise-grade, sovereign email and identity platform for `iron-id.io` and multi-tenant clients. The infrastructure features **PostgreSQL 16**, the **Stalwart Rust Mail Engine (RFC 8620/8621 JMAP + SMTP + IMAP)**, an **OpenSearch 2.x search index**, and a **custom Node.js Webmail Gateway & Sovereign Admin Console**.

---

## 🚦 2. Current State & Recent Discoveries (The Critical Context)

### The Business Dilemma & Constraint:
* **The User (Charaf):** Wants to receive and send emails using `charaf@iron-id.io` on the newly deployed sovereign mail server.
* **Colleague (Issam):** Currently relies on **Namecheap Private Email** for his daily business email (`issam@iron-id.io`).
* **Non-Negotiable Rule:** Issam’s mailbox must **never experience downtime, lost emails, or disruption**.

---

### Diagnosis of What Happened (Chronology of Tests):

1. **Test 1: Mail sent to `charaf@iron-id.io` arrived in `issam@iron-id.io`'s inbox.**
   * **Root Cause Found:** Issam had a **"Catch-All"** setting enabled in his Namecheap email control panel. Any email sent to `@iron-id.io` that wasn't an explicitly mapped mailbox got automatically rerouted to Issam.
2. **Test 2: Issam disabled the Catch-All in Namecheap.**
3. **Test 3: An inbound test email sent to `charaf@iron-id.io` immediately bounced:**
   ```text
   Mail Delivery System <MAILER-DAEMON@asp-relay-pe.jellyfish.systems>
   To: <sender>
   The mail system <charaf@iron-id.io>: 
   host relay.privateemail.services[198.177.121.37] said: 
   550 5.1.1 <charaf@iron-id.io>: Recipient address rejected: Mailbox not available at the moment. (in reply to RCPT TO command)
   ```
   * **Why it bounced:**
     * The DNS nameservers for `iron-id.io` are hosted at **GoDaddy** (`ns13.domaincontrol.com`, `ns14.domaincontrol.com`).
     * In GoDaddy DNS, the root MX records currently point to **Namecheap Private Email**:
       * `MX 10 mx1.privateemail.com`
       * `MX 10 mx2.privateemail.com`
     * When external mail servers (e.g. Gmail) send email to `charaf@iron-id.io`, DNS directs them to Namecheap (`relay.privateemail.services`).
     * Namecheap checks its mailboxes for `iron-id.io`: `issam@` exists, but `charaf@` does NOT exist in Namecheap (and Catch-All is off).
     * Therefore, Namecheap rejects the email with `550 5.1.1 Recipient address rejected`.
4. **Test 4: Outbound email from `charaf@iron-id.io` on Railway to personal Gmail did not arrive.**
   * **Why it failed:**
     * Railway (like Render/Heroku and residential ISPs) blocks outbound TCP Port 25.
     * Container IPs do not have dedicated Reverse DNS (PTR) or SPF authorization for Gmail.
     * Outbound email from Railway requires an **Outbound SMTP Smart Relay** (Port 587 with TLS) via Brevo, SendGrid, AWS SES, or Namecheap's SMTP.

---

## 🗺️ 3. Architecture & Live Deployments

### A. Live Railway Deployment
* **Project Name:** `vivacious-passion`
* **Service Name:** `iron-id-mail`
* **GitHub Repository Linked:** `https://github.com/chrf01910109/iron-id-mail.git` (Branches: `main` & `master`)
* **Public Domain:** `https://iron-id-mail-production.up.railway.app`
* **Container Architecture:** Ubuntu 24.04 "Virtual VPS" container:
  * **PostgreSQL 16**: Internal socket/service or connected via `DATABASE_URL`.
  * **Stalwart Engine (Rust)**: Binary `/usr/local/bin/ironid-engine` listening on internal port 8080.
  * **Node.js Webmail Gateway & Admin Console**: Listening on `$PORT` (3001) proxying JMAP calls to 8080.
  * **OpenSearch Subsystem**: High-performance OpenSearch 2.x compatible node on port 9200 (`engine/opensearch-node.js`).

### B. DNS Infrastructure (GoDaddy)
* **Domain:** `iron-id.io`
* **Nameservers:** `ns13.domaincontrol.com`, `ns14.domaincontrol.com`
* **Current Records:**
  * `MX 10 mx1.privateemail.com`
  * `MX 10 mx2.privateemail.com`
  * `TXT @ "v=spf1 include:spf.privateemail.com ~all"`

---

## 🔀 4. The Solution Paths for Split-Domain Routing (Coexistence)

Because DNS MX records apply domain-wide, GoDaddy DNS cannot route `issam@` to Namecheap and `charaf@` to Railway directly at the root level without a coordination layer.

### Solution Option 1: Forwarder in Namecheap (Zero Disruption, Immediate)
* **How it works:** In Namecheap Private Email / Namecheap Dashboard, add an Email Forwarding rule:
  * Address: `charaf@iron-id.io`
  * Forward to: A testing address or ingestion webhook.
* **Benefit:** Issam stays 100% untouched on Namecheap; `charaf@` no longer bounces with 550.

### Solution Option 2: Dedicated Subdomain for Sovereign Server (`@mail.iron-id.io`)
* **How it works:**
  * Leave root `@iron-id.io` MX records pointing to Namecheap (Issam is completely isolated and safe).
  * In GoDaddy DNS, create an MX record for the subdomain:
    * Host: `mail` (or `sovereign`)
    * Points to: Sovereign MTA
  * Test sovereign email with `charaf@mail.iron-id.io`.
* **Benefit:** Clean separation between existing commercial email and new sovereign infrastructure.

### Solution Option 3: Inbound HTTP Webhook on Railway + Free Gateway
* **Railway Limitation:** Railway PaaS does **NOT** expose raw TCP Port 25 for inbound SMTP.
* **Workaround:** Add an inbound email endpoint (`POST /api/inbound`) on the Railway app.
* Connect a free inbound email parser (e.g. **Cloudflare Email Routing**, **SendGrid Inbound Parse**, or **Brevo**) which receives the email and delivers it via HTTPS POST directly into Railway.

### Outbound Fix: Outbound SMTP Smart Relay (Port 587)
* To allow `charaf@iron-id.io` to deliver straight into personal Gmail/Outlook inboxes:
  * Set up a free **Brevo** account (300 emails/day free) or **SendGrid**.
  * Add the following environment variables to the Railway service:
    ```bash
    SMTP_RELAY_HOST=smtp-relay.brevo.com
    SMTP_RELAY_PORT=587
    SMTP_RELAY_USER=<your-brevo-login>
    SMTP_RELAY_PASS=<your-brevo-smtp-key>
    ```
  * Update the server/Stalwart config to relay external mail through this authenticated port 587 connection.

---

## 📂 5. Codebase Repository Map

```
iron-id-workspace/
├── Dockerfile                   # Ubuntu 24.04 all-in-one Virtual VPS container for Railway
├── package.json                 # Node.js dependencies
├── server.js                    # Root server entrypoint
├── railway.json                 # Railway deployment config
├── deploy/
│   ├── init.sql                 # PostgreSQL 16 schema migrations
│   ├── railway/entrypoint.sh    # Multi-process entrypoint (Postgres, Stalwart, Node.js)
│   ├── vps-setup.sh             # Alternative standalone Linux VPS deployment script
│   └── docker-compose.yml       # Local multi-container compose
├── engine/
│   ├── opensearch-node.js       # Standalone OpenSearch 2.x wire-compatible daemon (port 9200)
│   ├── config.toml              # Stalwart Engine configuration (listeners, storage, JMAP)
│   ├── export_data.json         # Seed accounts and mailboxes
│   └── tenants.json             # Tenant registry and DKIM keys
├── webmail/
│   ├── server.js                # Webmail Gateway & JMAP reverse proxy
│   ├── client.html              # Sovereign Webmail SPA (JMAP RFC 8620/8621, search, mail composer)
│   ├── admin.html               # Sovereign Admin Console & Interactive DNS Zone Editor
│   ├── routes/
│   │   └── api.js               # Administrative REST API (/api/stats, /api/tenants, /api/dns/verify)
│   └── services/
│       ├── tenantService.js     # Multi-tenant isolation & Ed25519 key generation
│       ├── dnsValidator.js      # Live DNS health checks (MX, SPF, DKIM, DMARC, TLSA, MTA-STS)
│       ├── openSearchService.js # Full-text search ingestion & querying client
│       └── dbUrlParser.js       # Safe PostgreSQL connection string parser
├── tests/
│   └── test_opensearch_live.js  # 8-scenario multilingual test suite for search
└── docs/
    ├── CORE_EMAILING_ARCHITECTURE_AND_PROVISIONING.md  # Detailed architecture document
    ├── RAILWAY_INTEGRATION_GUIDE.md                    # Railway deployment architecture
    └── VPS_INTEGRATION_RUNBOOK.md                      # Linux VPS procurement and setup runbook
```

---

## 🔑 6. Active Credentials, Ports & Endpoints

| Service / Resource | Location / Value | Notes |
| :--- | :--- | :--- |
| **Railway Production App** | `https://iron-id-mail-production.up.railway.app` | Public HTTPS |
| **Admin Console** | `https://iron-id-mail-production.up.railway.app/admin` | Interactive DNS Editor |
| **Webmail Client** | `https://iron-id-mail-production.up.railway.app` | JMAP SPA |
| **Master Admin Account** | `admin@iron-id.io` | Full system privileges |
| **User Mailbox 1** | `charaf@iron-id.io` | Sovereign user |
| **User Mailbox 2** | `issam@iron-id.io` | Namecheap Private Email user |
| **Default Password (Dev)** | `Sovereign2026!` (or provisioned per tenant) | Configured in seed |
| **Engine Port (Internal)** | `8080` (JMAP HTTP) | Stalwart Rust engine |
| **Gateway Port** | `3001` (HTTP/HTTPS) | Node.js reverse proxy |
| **OpenSearch Port** | `9200` (HTTP) | OpenSearch 2.x |

---

## 🎯 7. Next Action Checklist for Claude on Mac

When Claude picks up this task on macOS, execute these steps in order:

- [ ] **Step 1: Outbound Email (Gmail Delivery)**
  - Register free Brevo (300/day) or SendGrid SMTP credentials.
  - Add `SMTP_RELAY_*` environment variables in Railway project settings.
  - Wire outbound relay into Stalwart / Node gateway so sending to personal Gmail succeeds.
- [ ] **Step 2: Inbound Email Routing for `charaf`**
  - Decide between:
    - **Namecheap Forwarding**: Add forwarder for `charaf@iron-id.io` in Namecheap.
    - **Subdomain Routing**: Add `mail.iron-id.io` MX in GoDaddy.
    - **Inbound Webhook**: Add `POST /api/inbound` route to Railway gateway.
- [ ] **Step 3: Verification Test Cycle**
  1. Send test mail to `issam@iron-id.io` ➔ Verify delivery in Issam’s Namecheap inbox.
  2. Send test mail from personal Gmail to `charaf@iron-id.io` ➔ Verify arrival in Sovereign Webmail.
  3. Send reply from `charaf@iron-id.io` in Sovereign Webmail ➔ Verify arrival in personal Gmail Primary Inbox.
- [ ] **Step 4: Full Documentation & Git Sync**
  - Commit any configuration updates and push to GitHub `main`.
