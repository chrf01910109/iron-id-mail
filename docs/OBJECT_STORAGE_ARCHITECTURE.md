# 📦 IRON ID Sovereign Mail — Object Storage Architecture & Tiering Guide
## S3 / MinIO Blob Disaggregation for Attachments & Evidentiary Archiving

> **Target Platform:** IRON ID Sovereign Business Email  
> **Key Integration:** S3 API / MinIO / Cloudflare R2 / IRON ID Box  
> **Applicable Roadmap Milestones:** 1.2, 4.4, 6.2  
> **Date:** October 5, 2026

---

## 1. Why Object Storage is Crucial for Enterprise Email

In traditional email servers (like Postfix or basic Dovecot), emails and attachments are dumped into flat directory trees (`Maildir`) or stored directly in relational databases. At scale, this causes major bottlenecks:

| Problem in Legacy Storage | Modern S3 Object Storage Solution |
| :--- | :--- |
| **Database Bloat**: PostgreSQL tables balloon to hundreds of GBs with binary attachment blobs. | **Complete Disaggregation**: PostgreSQL only stores tiny metadata (~few KB/msg). Raw MIME files and attachments stream to S3. |
| **Disk Exhaustion on VPS**: Running out of local server disk crashes the entire mail server. | **Infinite Elastic Storage**: Attachments scale to terabytes without resizing the VPS volume. |
| **Slow Backup Windows**: `pg_dump` takes hours and locks tables when backing up heavy binary files. | **Sub-Second Backups**: Database dumps remain tiny (<100MB) while S3 syncs continuously in the background. |
| **Data Loss on VPS Failure**: Local disk corruption loses user attachments. | **Replication & Immutability**: S3 supports versioning, cross-region replication, and WORM (Write-Once-Read-Many) policies. |

---

## 2. Stalwart 4-Tier Storage Disaggregation Topology

Stalwart separates every incoming email into 4 isolated subsystems:

```
                         [ INCOMING EMAIL PAYLOAD ]
                                     │
                 ┌───────────────────┴───────────────────┐
                 ▼                                       ▼
     [ 1. Structured Metadata ]               [ 2. Raw MIME Blobs & Files ]
     • Headers, Sender, Recipient             • Email Bodies (HTML/Text)
     • Mailbox IDs, Flags, Read States        • PDF, DOCX, ZIP, Images
                 │                                       │
                 ▼                                       ▼
         [ POSTGRESQL 16 ]                      [ S3 / MINIO STORE ]
                 │                                       │
                 └───────────────────┬───────────────────┘
                                     │
                                     ▼
                        [ 3. Full-Text Inverted Index ]
                        • Multi-language tokenization
                        • Subject & body search
                                     │
                                     ▼
                           [ ELASTICSEARCH 8 ]
```

---

## 3. Stalwart Native S3 Configuration (`config.toml`)

Stalwart features high-performance native async S3 drivers with **on-the-fly LZ4 / ZSTD compression**:

```toml
# ------------------------------------------------------------------------------
# Storage Subsystem Routing
# ------------------------------------------------------------------------------
[storage]
data = "postgres"        # Metadata, mailboxes, identities
lookup = "postgres"      # High-speed routing lookups
fts = "elastic"          # Distributed full-text search
blob = "s3"              # Raw email bodies & attachments to S3!

# ------------------------------------------------------------------------------
# S3 / MinIO Object Storage Configuration
# ------------------------------------------------------------------------------
[store.s3]
type = "s3"
endpoint = "http://minio:9000"              # Or Cloudflare R2 / AWS S3 / Wasabi
region = "us-east-1"
bucket = "iron-id-mail-blobs"
access-key = "ironadmin"
secret-key = "IronMinioSecret2026!"
use-path-style = true                       # Required for MinIO & self-hosted S3
compression = "lz4"                         # Transparent on-the-fly compression!
max-connections = 64
```

---

## 4. The Two Deployment Options for IRON ID

### Option A: Sovereign Self-Hosted MinIO (Recommended for Air-Gapped / National Hosting)
* **What it is**: High-performance, S3-compatible object storage server running directly alongside Stalwart in Docker Compose.
* **Benefits**: 
  * 100% data sovereignty within Algerian national borders.
  * Zero third-party cloud dependencies.
  * Zero egress bandwidth costs.
* **Included in our Docker Compose stack**:
  * MinIO S3 API on `port 9000`.
  * MinIO Web Management Console on `port 9001`.
  * Auto-initialization script creating the `iron-id-mail-blobs` bucket.

### Option B: Cloudflare R2 / Wasabi (Recommended for Global High-Throughput)
* **What it is**: Managed S3 storage with **$0 egress fees**.
* **Benefits**:
  * Never worry about running out of disk space on the VPS.
  * Low cost (~$0.015 / GB / month).
  * Direct HTTP/S3 endpoints.

---

## 5. Direct Integration with IRON ID Box (Roadmap Milestone 4.4)

In Phase 4 of the roadmap, **IRON ID Box** serves as the immutable legal vault:

1. **1-Click Evidentiary Archiving**:
   * A user receives a signed contract or financial statement in Webmail.
   * Clicking **"📁 Archive to IRON ID Box"** triggers a direct server-to-server S3 bucket copy (`iron-id-mail-blobs` ➔ `iron-id-box-vault`).
   * The file **never downloads to the user's laptop**, preventing security leaks.
2. **Cryptographic SHA-256 Proof**:
   * The object storage system computes and registers the SHA-256 hash in the database, pairing it with an RFC 3161 cryptographic timestamp to prove the attachment was received untampered.
3. **WORM / Object Lock**:
   * Enables regulatory retention policies (e.g., contracts locked from deletion for 5 or 10 years).
