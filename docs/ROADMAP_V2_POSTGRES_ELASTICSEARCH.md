# 🏗️ IRON ID Sovereign Mail — Architecture & Roadmap V2
## Migration from Embedded RocksDB to PostgreSQL + Elasticsearch

> **Document Version:** 2.0 (Enterprise Sovereign Architecture)  
> **Target Domain:** `iron-id.io` / `iron-id.dz`  
> **Status:** Proposed Architectural Upgrade  
> **Date:** October 5, 2026

---

## 1. Architectural Evolution: RocksDB vs. PostgreSQL + Elasticsearch

| Dimension | Baseline (RocksDB Embedded) | Target V2 (PostgreSQL + Elasticsearch) |
| :--- | :--- | :--- |
| **Architecture Type** | Single-node embedded key-value store | Disaggregated 3-tier enterprise stack |
| **Directory & Metadata** | Key-value records in local LSM-tree | Relational ACID tables in **PostgreSQL 16** |
| **Full-Text Search (FTS)** | Basic built-in RocksDB token index | Distributed **Elasticsearch 8 / OpenSearch** |
| **Blob / MIME Storage** | RocksDB SSTable blocks or local FS | Dedicated S3 / MinIO / Fast NVMe local store |
| **Concurrency & Locks** | Single-process exclusive file lock (`LOCK`) | High-concurrency connection pool (pgbouncer) |
| **High Availability (HA)** | Hard to replicate live (requires cold copies) | Multi-replica streaming replication & ES clusters |
| **Multi-Tenancy** | Key-prefix isolation | Relational row/schema isolation + foreign keys |
| **Multi-Language Search** | Plain whitespace tokenization | Stemming analyzers for **Arabic**, **French**, **English** |
| **Backup / DR** | Raw directory snapshots | Native `pg_dump` / WAL archiving & ES snapshot API |

---

## 2. Why This Strategic Change is Superior for IRON ID

1. **Elimination of Database Lock Bottlenecks**:
   * RocksDB places an OS-level exclusive file lock (`engine/data/LOCK`). When IRON ID Core Engine is running, external CLI tools or scripts cannot query the store directly without shutting down the mail server.
   * With **PostgreSQL**, the Node.js API Gateway, Admin Console, and CLI tools can query accounts, quotas, and audit trails simultaneously with zero locking conflicts.

2. **Enterprise Multi-Lingual Search (Arabic & French)**:
   * IRON ID operates in Algeria and international enterprise markets where emails contain French, Arabic, and English.
   * Elasticsearch provides dedicated language analyzers (`arabic` analyzer with root extraction, `french` elision and accent normalization), enabling lightning-fast fuzzy searches across subject lines, body text, and attachments.

3. **Ecosystem Interoperability**:
   * PostgreSQL connects natively with IRON ID's central IAM, SSO, and billing backends without requiring custom binary serializers.

---

## 3. Impact on Server Sizing & VPS Specifications

Because PostgreSQL and Elasticsearch (JVM) require more system memory than an embedded RocksDB file, the target VPS specifications must be adjusted:

| Specification | RocksDB (Phase 1 Baseline) | PostgreSQL + Elasticsearch (V2) |
| :--- | :--- | :--- |
| **Minimum CPU** | 2 vCPU | **4 vCPU** |
| **Minimum RAM** | 4 GB | **8 GB – 16 GB** (ES Heap: 2–4GB, Postgres: 1–2GB, IRON ID Core Engine: 1GB) |
| **Minimum Storage** | 40 GB NVMe | **80 GB – 160 GB NVMe** (Fast IOPS for indexing) |
| **Recommended VPS** | Hetzner CX22 (~€5/mo) | **Hetzner CPX31 (4 vCPU, 8GB RAM, ~€14/mo)** or **CPX41 (8 vCPU, 16GB RAM)** |

---

## 4. IRON ID Core Engine Production Configuration Blueprint (`config.toml`)

In IRON ID Core Engine, migrating from RocksDB to PostgreSQL and Elasticsearch is fully native:

```toml
# ==============================================================================
# IRON ID Sovereign Mail — PostgreSQL + Elasticsearch Configuration
# ==============================================================================

[server]
hostname = "mail.iron-id.io"

# ------------------------------------------------------------------------------
# Storage Subsystem Routing
# ------------------------------------------------------------------------------
[storage]
data = "postgres"        # Metadata, mailboxes, identities, sessions
lookup = "postgres"      # High-speed routing lookups
blob = "fs"              # or "s3" (MinIO / S3 bucket for large attachments)
fts = "elastic"          # Distributed full-text search

# ------------------------------------------------------------------------------
# PostgreSQL Connection Pool
# ------------------------------------------------------------------------------
[store.postgres]
type = "postgres"
host = "127.0.0.1"
port = 5432
database = "ironid_mail"
user = "stalwart"
password = "SECRET_DB_PASSWORD"
max-connections = 32

# ------------------------------------------------------------------------------
# Elasticsearch Full-Text Search Node
# ------------------------------------------------------------------------------
[store.elastic]
type = "elastic"
url = "http://127.0.0.1:9200"
index = "iron_id_emails"
bulk-size = 1000

# ------------------------------------------------------------------------------
# Blob Storage (MIME Attachments)
# ------------------------------------------------------------------------------
[store.fs]
type = "fs"
path = "/opt/iron-id/storage/blobs"
compression = "lz4"

# ------------------------------------------------------------------------------
# Internal Directory on PostgreSQL
# ------------------------------------------------------------------------------
[directory.internal]
type = "internal"
store = "postgres"
```

---

## 5. Phase-by-Phase Roadmap Impact

```
Phase 1: Architecture & Core Engine
  └── Updated: Initialize PostgreSQL 16 schema + Elasticsearch cluster instead of RocksDB.

Phase 2: Multi-Tenancy & Directory
  └── Updated: Relational tenant tables, SQL-native quotas, and foreign key cascades.

Phase 3: Custom Webmail Frontend
  └── Updated: JMAP search queries backed by Elasticsearch with instant autocomplete & highlights.

Phase 4: IRON ID Ecosystem Interoperability
  └── Updated: Direct SQL federated views with IRON ID Auth and Box storage pipelines.

Phase 5: Deliverability & DNS Hardening
  └── Unchanged: PTR, SPF, DKIM (Ed25519), DMARC (quarantine), MTA-STS.

Phase 6: Sovereign Deployment Packaging
  └── Updated: Production Docker Compose stack orchestrating [IRON ID Core Engine + PostgreSQL + Elasticsearch + Node Gateway].
```
