# 🚀 IRON ID Sovereign Email — Engineering Checklist & Delivery Roadmap

> **Platform:** IRON ID Sovereign Business Email  
> **Target Domain:** `iron-id.io`  
> **Engineering Lead:** Charaf Sellam  
> **Stakeholders:** Antigravity / Executive  
> **Overall Progress:** 🟩 55% Complete (Phase 1 & Phase 2: 100% DONE)  
> **Last Updated:** October 5, 2026

---

## 📌 Properties & Overview

| Property | Value |
| :--- | :--- |
| **Status** | 🟢 Phase 2 Complete ➔ Ready for Phase 3 (Native React Client & VPS Deployment) |
| **Priority** | 🔴 High |
| **Target Launch** | 8-Week Cycle (Commercial Release: Weeks 7–8) |
| **Core Stack** | Stalwart Mail Server (Rust) + RocksDB + JMAP (RFC 8620/8621) + Node.js Gateway |
| **Primary Mailbox** | `charaf@iron-id.io` |
| **Client Test Mailbox** | `anis@client.dz` |

---

## 🎯 Immediate Next Action Items (Sprint 1)

- [ ] **Action 1: VPS & Clean IP Procurement (Target: 3 Days)**
  - [ ] Select unblocked Port 25 cloud host (Hetzner Cloud, Vultr, or OVHcloud).
  - [ ] Request dedicated static IPv4 and IPv6 assignment.
  - [ ] Configure hosting control panel Reverse DNS (PTR record) to resolve `VPS_IP ↔ mail.iron-id.io`.
  - [ ] Provision Ubuntu 24.04 LTS (2 vCPU, 4GB RAM, 80GB NVMe).
  - [ ] Set up UFW firewall rules for ports `25`, `465`, `587`, `993`, `8080`, `4190`.

- [ ] **Action 2: DNS Cutover & Cryptographic Records (Target: 5 Days)**
  - [ ] Export Stalwart's public DKIM keys (RSA-2048 & Ed25519).
  - [ ] Configure Cloudflare DNS records:
    - [ ] `MX` record: `@` → `mail.iron-id.io` (Priority 10).
    - [ ] `SPF` record: `v=spf1 mx ip4:<VPS_IP> ~all`.
    - [ ] `DKIM` record: TXT under `stalwart._domainkey.iron-id.io`.
    - [ ] `DMARC` record: `v=DMARC1; p=quarantine; rua=mailto:dmarc@iron-id.io`.
    - [ ] `MTA-STS` record: `v=STSv1; id=20260923T01` and TLS-RPT record.
  - [ ] Run automated DNS health verification script to ensure 100% propagation.

---

## ✅ Completed Milestones (Phase 1 — Protocol Hardening & Audit)

<details open>
<summary><b>Phase 1: Verification & Core Architecture (100% COMPLETED)</b></summary>

- [x] **Milestone 1: Authoritative Domain & DKIM Setup**
  - [x] Provision `iron-id.io` as the authoritative domain inside Stalwart.
  - [x] Generate internal 2048-bit RSA and Ed25519 cryptographic key pairs for outbound DKIM signing.
  - [x] Configure embedded RocksDB LSM-Tree key-value store.

- [x] **Milestone 2: Sovereign Identity & Tenant Accounts**
  - [x] Create primary master mailbox `charaf@iron-id.io` (Account ID: `c`, Identity: `b`).
  - [x] Provision secondary tenant mailbox `anis@client.dz` (Account ID: `e`, Identity: `d`).
  - [x] Verify account credentials and password hashes stored directly in RocksDB.

- [x] **Milestone 3: RFC 5321 Inbound MTA Verification (Port 25)**
  - [x] Connect raw TCP socket to port 25 and receive 220 ESMTP banner.
  - [x] Validate strict RFC 5321 FQDN enforcement (reject `EHLO localhost` with `550 5.5.0`).
  - [x] Confirm ESMTP capability negotiation (`STARTTLS`, `SMTPUTF8`, `PIPELINING`, `SIZE 104857600`, `CHUNKING`, `BINARYMIME`, `8BITMIME`).
  - [x] Transmit live RFC 5322 MIME email payload via `MAIL FROM` and `RCPT TO`.
  - [x] Verify message queue acceptance: `250 2.0.0 Message queued with id 49893dc52e00200`.
  - [x] Verify anti-spam Sieve engine automatically routes unauthenticated external mail into **Junk Mail**.

- [x] **Milestone 4: RFC 9051 IMAPS Protocol Verification (Port 993)**
  - [x] Connect encrypted TLS socket to port 993 and verify IMAP4rev2 greeting.
  - [x] Perform authenticated SASL login: `A01 LOGIN charaf@iron-id.io`.
  - [x] Execute `A02 LIST "" "*"` to enumerate mailboxes (`INBOX`, `Sent Items`, `Drafts`, `Deleted Items`, `Junk Mail`).
  - [x] Execute `A03 SELECT "Junk Mail"` and `A04 FETCH 1:* (ENVELOPE)` to verify message metadata extraction.

- [x] **Milestone 5: RFC 8620 / 8621 JMAP Protocol Handshake (Port 8080)**
  - [x] Query `/jmap/session` endpoint with HTTP Basic Auth and obtain primary account mappings.
  - [x] Execute atomic send payload (`Email/set` + `EmailSubmission/set`) with `#msg1` backreferencing.
  - [x] Verify zero-hop intra-server delivery from `charaf@iron-id.io` to `anis@client.dz`.

- [x] **Milestone 6: Gateway Middleware & Webmail UI Fixes**
  - [x] Build transparent Node.js reverse proxy on port 3001 to resolve browser CORS constraints.
  - [x] Update proxy URL parsing to modern WHATWG `URL` standard.
  - [x] Fix folder navigation: implement dynamic JMAP mailbox enumeration (`filterFolder`) with live counts.
  - [x] Fix draft placement bug: ensure outgoing messages are saved to **Sent Items** (`role: 'sent'`).
  - [x] Sanitize UI rendering: eliminate `null` sender fallbacks and safely index emails by ID.
  - [x] Consolidate all components into self-contained `iron-id-workspace/` directory with 1-click launchers.

</details>

---

## 🗓️ 8-Week Execution Delivery Roadmap

<details open>
<summary><b>Weeks 1–2: Tenant Provisioning & Automated DNS Verification (100% COMPLETED)</b></summary>

- [x] Audit Stalwart RocksDB directory schema and account storage mechanics.
- [x] Develop REST API wrapper for programmatically provisioning new tenant domains (`webmail/services/tenantService.js`, `webmail/routes/api.js`).
- [x] Build automated DNS record checker verifying MX, SPF, DKIM, and DMARC status (`webmail/services/dnsValidator.js`).
- [x] Enforce custom storage quotas and rate-limiting per tenant mailbox (`validateSubmission` enforcement engine).
- [x] Create administrative CLI/API for account password resets and mailbox suspension (`admin-cli.js` & `webmail/admin.html`).

</details>

<details>
<summary><b>Weeks 3–5: Native JMAP React Webmail Client (SCHEDULED)</b></summary>

- [ ] Initialize modern React / Next.js webmail frontend leveraging Tailwind CSS.
- [ ] Build native JMAP state machine with batched delta-sync and server-side search.
- [ ] Implement conversation threading and threaded reply views.
- [ ] Integrate DOMPurify and HTML sanitization for safe rendering of rich emails.
- [ ] Build multi-folder drag-and-drop organization (Inbox, Sent, Archive, Trash, Custom tags).
- [ ] Add rich-text editor (TipTap or Quill) with inline image pasting and attachment drag-and-drop.
- [ ] Develop mobile-optimized responsive webmail shell.

</details>

<details>
<summary><b>Week 6: Sovereign Linux VPS Production Deployment (SCHEDULED)</b></summary>

- [ ] Deploy hardened Ubuntu 24.04 LTS instance with static IP.
- [ ] Bind host Reverse DNS (PTR record) to `mail.iron-id.io`.
- [ ] Configure Stalwart built-in ACME client for automated Let's Encrypt TLS certificate generation.
- [ ] Activate production Cloudflare DNS zone records with live proxy bypass (DNS only).
- [ ] Set up systemd service definitions with automatic restart and log rotation.
- [ ] Configure automatic daily snapshot backups of the RocksDB database.

</details>

<details>
<summary><b>Weeks 7–8: Deliverability, Warm-Up & Commercial Launch (SCHEDULED)</b></summary>

- [ ] Configure S3 / MinIO object storage tiering for large MIME attachments.
- [ ] Implement outbound rate-limiting and progressive IP warm-up pipeline (50 → 200 → 1,000 emails/day).
- [ ] Publish auto-discovery XML/JSON configurations for Apple Mail, Outlook, and Thunderbird.
- [ ] Link email authentication with central IRON ID SSO OAuth2 identity provider.
- [ ] Production cutover and release of `contact@iron-id.io` and commercial tenant onboarding.

</details>

---

## 🛡️ Deliverability & Security Quality Gate

Before opening commercial customer traffic, each of the following checklist criteria must be verified:

| Check | Requirement | Target Standard | Current Status |
| :---: | :--- | :--- | :---: |
| 🔲 | **Reverse DNS (PTR)** | `VPS_IP` resolves strictly to `mail.iron-id.io` | Pending VPS |
| 🔲 | **Forward DNS (A/AAAA)** | `mail.iron-id.io` resolves strictly to `VPS_IP` | Pending VPS |
| 🔲 | **SPF Record** | `v=spf1 mx ip4:<VPS_IP> ~all` | Config Ready |
| 🔲 | **DKIM Signature** | Valid Ed25519 / RSA-2048 under `stalwart._domainkey` | Keys Generated |
| 🔲 | **DMARC Policy** | `v=DMARC1; p=quarantine; rua=mailto:dmarc@iron-id.io` | Config Ready |
| 🔲 | **MTA-STS Policy** | Strict transport policy enabled on HTTPS endpoint | Drafted |
| 🔲 | **Port 25 Outbound** | Verified unblocked by cloud hosting provider | Pending VPS |
| 🔲 | **TLS Encryption** | TLS 1.3 enforced on SMTP submission (587/465) & IMAP (993) | Verified Local |

---

## 💻 Quick Reference Commands

<details>
<summary><b>Local Testing & Diagnostic Commands</b></summary>

**Start Local Engine:**
```powershell
cd C:\Users\LENOVO\.gemini\antigravity-ide\scratch\iron-id-workspace\engine
.\stalwart.exe -c config.json
```

**Start Webmail Gateway:**
```powershell
cd C:\Users\LENOVO\.gemini\antigravity-ide\scratch\iron-id-workspace\webmail
node server.js
```

**1-Click Full Startup:**
```powershell
cd C:\Users\LENOVO\.gemini\antigravity-ide\scratch\iron-id-workspace
.\start-all.ps1
```

**Check Mail Ports:**
```powershell
Get-NetTCPConnection -State Listen | Where-Object {$_.LocalPort -in 25, 465, 993, 8080, 3001}
```

</details>
