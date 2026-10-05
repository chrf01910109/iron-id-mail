# 🚀 IRON ID Sovereign Mail — Complete Delivery Summary & VPS Integration Runbook

> **Platform:** IRON ID Sovereign Business Email  
> **Authoritative Domain:** `iron-id.io`  
> **Target Hostname:** `mail.iron-id.io`  
> **Current Version:** Phase 1 & Phase 2 Verified (100% Complete)  
> **Date:** October 5, 2026

---

## 📌 Part 1: Everything We Have Built & Delivered

### 1. Phase 1 — Sovereign Mail Engine & Core Protocols (100% Done)
* **Core Engine**: Stalwart Mail Server (Rust) with embedded high-performance RocksDB LSM-tree key-value store.
* **Inbound Server-to-Server MTA (Port 25)**: Strict RFC 5321 transaction enforcement, rejection of invalid EHLO/HELO, and automated Sieve Junk Mail routing for unauthorized external mail.
* **Encrypted Client Sync (Port 993)**: RFC 9051 IMAPS with TLS 1.3 encryption and mailbox listing.
* **Modern JMAP Protocol (Port 8080)**: RFC 8620/8621 JSON-based JMAP engine with zero-hop intra-server delivery between `charaf@iron-id.io` and `anis@client.dz`.
* **Sovereign Webmail Client**: Single-Page App running on Port 3001 with dark-mode aesthetic, live folder counts, rich composer, account switcher, and CORS transparent proxy.

---

### 2. Phase 2 — Multi-Tenant Architecture, Quotas & DNS Automation (100% Done)
* **Multi-Tenant Provisioning REST API**:
  * [`webmail/services/tenantService.js`](file:///c:/Users/LENOVO/.gemini/antigravity-ide/scratch/iron-id-workspace/webmail/services/tenantService.js) & [`webmail/routes/api.js`](file:///c:/Users/LENOVO/.gemini/antigravity-ide/scratch/iron-id-workspace/webmail/routes/api.js).
  * Automated **Ed25519 & RSA-2048 cryptographic DKIM keypair generation** on domain creation.
  * Programmatic mailbox provisioning with auto-assigned JMAP Account/Identity IDs.
* **Automated Cryptographic DNS Validator**:
  * [`webmail/services/dnsValidator.js`](file:///c:/Users/LENOVO/.gemini/antigravity-ide/scratch/iron-id-workspace/webmail/services/dnsValidator.js).
  * Live querying of **MX, SPF, DKIM, DMARC, and MTA-STS** records.
  * 0–100 Deliverability Health Score calculation and exact copy-paste remediation blueprints.
* **Storage Quota & Rate-Limiting Engine**:
  * Per-mailbox storage threshold limits (MB/GB) and daily send velocity counters.
  * Rejection of unauthorized submissions if account is suspended or quotas are exceeded.
* **Administrative Management Interfaces**:
  * **Web Console**: Accessible at [**http://localhost:3001/admin**](http://localhost:3001/admin) (or via the **🛡️ Admin** button in the Webmail header).
  * **Command-Line CLI**: [`admin-cli.js`](file:///c:/Users/LENOVO/.gemini/antigravity-ide/scratch/iron-id-workspace/admin-cli.js) for terminal management (`node admin-cli.js tenant list`, `node admin-cli.js dns verify iron-id.io`).
* **Automated Test Suite**:
  * [`tests/phase2_verification.js`](file:///c:/Users/LENOVO/.gemini/antigravity-ide/scratch/iron-id-workspace/tests/phase2_verification.js) ➔ **10 / 10 Tests Passing (100% PASS)**.

---

## 🛠️ Part 2: Step-by-Step VPS Integration Runbook

To transition this verified local sovereign platform into live production on the public internet, follow these **5 clear steps**:

---

### Step 1: Procure an Unblocked Port 25 Linux VPS
Because external mail servers communicate over **Port 25 (SMTP)**, you must choose a cloud provider that allows outbound Port 25:

| Provider | Recommended Plan | Port 25 Policy | Typical Cost |
| :--- | :--- | :--- | :--- |
| **Hetzner Cloud** (Recommended) | **CPX21** (3 vCPU AMD, 4GB RAM, 80GB NVMe) or **CX22** | Unblocked after 1 month or upon simple ID verification request | ~€5–€8/month |
| **OVHcloud** | **VPS Starter / Value** (2 vCPU, 4GB RAM) | Unblocked by default on most regions | ~€6–€10/month |
| **Vultr** | **Cloud Compute** (2 vCPU, 4GB RAM) | Open support ticket: "Request Port 25 unblock for mail.iron-id.io" | ~$12/month |

> **OS Selection:** Choose **Ubuntu 24.04 LTS (x86_64)**.  
> **IP Requirement:** 1 Dedicated Static IPv4 (and IPv6 if available).

---

### Step 2: Configure Reverse DNS (PTR Record)
> **Crucial Anti-Spam Step:** Google and Microsoft will immediately drop inbound emails if the sending IP's reverse lookup does not match the server hostname.

1. Go into your VPS hosting control panel (e.g. Hetzner Cloud Console ➔ Server ➔ Networking).
2. Find **Reverse DNS (PTR)** for your server's public IPv4 address.
3. Set the PTR value strictly to:
   ```text
   mail.iron-id.io
   ```

---

### Step 3: Publish Cloudflare DNS Records
In your Cloudflare (or registrar) DNS control panel for `iron-id.io`, add the following records:

> ⚠️ **Important:** For the mail host (`mail`), ensure the Cloudflare Proxy is set to **DNS Only** (Grey Cloud), NOT Proxied (Orange Cloud), because Cloudflare HTTP proxy does not proxy raw SMTP/IMAP ports.

| Type | Name / Host | Content / Value | Priority / TTL | Proxy Status |
| :---: | :--- | :--- | :---: | :---: |
| **A** | `mail` | `<YOUR_VPS_PUBLIC_IP>` | Auto | 🔘 **DNS Only (Grey)** |
| **MX** | `@` (or `iron-id.io`) | `mail.iron-id.io` | **10** | — |
| **TXT** | `@` | `v=spf1 mx ip4:<YOUR_VPS_PUBLIC_IP> ~all` | Auto | — |
| **TXT** | `stalwart._domainkey` | `v=DKIM1; k=ed25519; p=n8D9QO7Kq7rT+Lp/bK2lK8gJ+7Z1X9X0mP6q8Q4bX0Q=` | Auto | — |
| **TXT** | `_dmarc` | `v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@iron-id.io` | Auto | — |
| **TXT** | `_mta-sts` | `v=STSv1; id=20261005T01` | Auto | — |

---

### Step 4: Transfer Files & Run 1-Command Deployment

We created an automated setup script at [`deploy/vps-setup.sh`](file:///c:/Users/LENOVO/.gemini/antigravity-ide/scratch/iron-id-workspace/deploy/vps-setup.sh).

#### From your local computer (PowerShell / Terminal):
Copy the workspace to your new VPS:
```bash
# Upload workspace to your server
scp -r "C:\Users\LENOVO\.gemini\antigravity-ide\scratch\iron-id-workspace" root@<YOUR_VPS_IP>:/opt/iron-id
```

#### On your VPS (SSH):
Connect to your VPS and execute the automated setup script:
```bash
ssh root@<YOUR_VPS_IP>

# Make setup script executable and run it
chmod +x /opt/iron-id/deploy/vps-setup.sh
/opt/iron-id/deploy/vps-setup.sh
```

**What the setup script automatically does:**
1. Installs Node.js LTS, system dependencies, and opens firewall ports (`25`, `80`, `443`, `465`, `587`, `993`, `3001`).
2. Downloads the Linux Stalwart Mail Server binary and sets permissions.
3. Automatically sets up automated Let's Encrypt TLS certificates (ACME) for `mail.iron-id.io`.
4. Creates systemd daemons (`stalwart-mail.service` and `iron-webmail.service`) configured to restart automatically on boot.

#### Start the Services:
```bash
systemctl start stalwart-mail
systemctl start iron-webmail
```

---

### Step 5: Live Verification & Testing

Once running on the VPS:
1. **Audit Live DNS**:
   Run the CLI validator on the VPS or from your local machine:
   ```bash
   node /opt/iron-id/admin-cli.js dns verify iron-id.io
   ```
   Or open your Admin Console in your browser:  
   👉 `http://<YOUR_VPS_IP>:3001/admin`
2. **Send Test Email to External Address**:
   * Open Webmail at `http://<YOUR_VPS_IP>:3001`
   * Log in with `charaf@iron-id.io` / `Ch@r@firon-!D`
   * Compose an email to a real Gmail or Outlook account.
   * Send to [Mail-Tester.com](https://www.mail-tester.com) to verify a **10/10 Deliverability Score**!
