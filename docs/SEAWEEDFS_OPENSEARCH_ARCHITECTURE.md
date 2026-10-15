# 🌟 IRON ID Sovereign Mail — SeaweedFS & OpenSearch Architectural Review
## The 100% Permissive Open-Source (Apache 2.0) Sovereign Stack

> **Strategic Architecture Update:** Transitioning from MinIO (AGPLv3) to **SeaweedFS (Apache 2.0)** and from Elasticsearch (SSPL) to **OpenSearch (Apache 2.0)**.  
> **Target Domain:** `iron-id.io` / `iron-id.dz`  
> **Date:** October 5, 2026

---

## 1. Why SeaweedFS Over MinIO: The Decisive Advantages

| Criterion | MinIO | SeaweedFS (Selected) | Why It Matters for IRON ID |
| :--- | :--- | :--- | :--- |
| **Open-Source License** | ⚠️ **AGPLv3** (Restricted / High Legal Risk for SaaS) | ✅ **Apache 2.0** (100% Permissive Open Source) | MinIO's AGPLv3 forces companies modifying or wrapping services to open-source proprietary code. **SeaweedFS carries zero legal risk** for commercial and enterprise hosting. |
| **Small-File Architecture** | Standard POSIX metadata crawling | **Facebook Haystack / F4 Architecture** | Email attachments are typically small to medium files (50 KB – 10 MB). Storing millions of small files degrades standard filesystems. **SeaweedFS packs blobs into large volume files with O(1) in-memory index lookups** (zero seek delays). |
| **Memory Consumption** | ~300 MB – 500 MB RAM | **~30 MB – 80 MB RAM** | SeaweedFS is written in Go and extremely lightweight, leaving maximum RAM available for OpenSearch and PostgreSQL. |
| **Built-in S3 API** | Yes (Port 9000) | **Yes (Native `-s3` flag on Port 8333)** | Direct drop-in replacement for IRON ID Core Engine's S3 blob driver (`[store.s3]`). |
| **Multi-Tiering** | Cloud tiering (enterprise tier) | Built-in cloud & cold-tier offloading | Can automatically migrate emails older than 1 year to cold storage. |

---

## 2. Why OpenSearch Over Elasticsearch: The Strategic Shift

| Criterion | Elasticsearch | OpenSearch (Selected) | Why It Matters for IRON ID |
| :--- | :--- | :--- | :--- |
| **Open-Source License** | ⚠️ **SSPL** (Server Side Public License, Non-OSI) | ✅ **Apache 2.0** (Linux Foundation / Community) | True vendor-neutral open source backed by AWS, Red Hat, and the Linux Foundation. |
| **Security & RBAC** | Gated behind proprietary Elastic X-Pack tiers | **100% Free & Built-In under Apache 2.0** | Full TLS encryption, fine-grained role-based access control, and auditing included out-of-the-box. |
| **IRON ID Core Engine Compatibility** | Native | **100% Wire-Compatible** | IRON ID Core Engine's built-in `[store.elastic]` driver interacts with OpenSearch seamlessly using the standard REST API (`_bulk`, `_search`, index templates). |
| **Linguistic Search** | Standard analyzers | Enhanced Arabic, French, and English NLP plugins | Crucial for Algerian enterprise compliance and fuzzy search across bilingual emails. |

---

## 3. The Complete 5-Tier Sovereign Enterprise Stack

```
                          [ INCOMING / OUTGOING TRAFFIC ]
                                         │
                 ┌───────────────────────┴───────────────────────┐
                 ▼                                               ▼
         [ CLIENT ACCESS TIER ]                         [ EXTERNAL MTAs ]
     • Sovereign Webmail (Port 3001)                 • Gmail, Outlook, Yahoo
     • Admin Console (Port 3001/admin)               • Port 25 (ESMTP Server-to-Server)
     • Desktop Clients (Port 993 IMAPS)              • Port 465/587 (SMTPS Submissions)
                 │                                               │
                 └───────────────────────┬───────────────────────┘
                                         │
                                         ▼
                     [ TIER 1: STALWART MAIL SERVER (RUST CORE) ]
                     • High-throughput memory-safe unified protocol engine
                     • DKIM Ed25519 signer & Sieve anti-spam heuristics
                     • JMAP RFC 8620/8621 engine (Port 8080)
                                         │
       ┌─────────────────────────────────┼─────────────────────────────────┐
       ▼                                 ▼                                 ▼
[ TIER 2: POSTGRESQL 16 ]     [ TIER 3: OPENSEARCH 2.x ]        [ TIER 4: SEAWEEDFS (S3) ]
• Accounts & Passwords        • Distributed Full-Text Search    • Raw MIME Payload Storage
• Tenant Isolation & Quotas   • Multi-lingual Tokenization      • Attachment Blobs (PDF, ZIP)
• Mailbox States & Folders    • Sub-10ms JMAP Querying          • Haystack O(1) Fast Lookups
• ACID Audit Logging          • Arabic / French Stemming        • On-the-Fly LZ4 Compression
```

---

## 4. Hardware Sizing for the SeaweedFS + OpenSearch Stack

Because SeaweedFS is significantly lighter than MinIO, the overall memory budget is optimized:

| Service | Memory Allocation | Role |
| :--- | :--- | :--- |
| **IRON ID Sovereign Mail Engine** | ~500 MB – 1 GB | Unified MTA, IMAP, JMAP daemon |
| **PostgreSQL 16** | ~1 GB – 2 GB | Relational metadata & buffer pool |
| **OpenSearch 2.x** | ~2 GB – 3 GB (Heap: 1.5 GB) | Search indexing and query cache |
| **SeaweedFS** | ~100 MB – 250 MB | S3 Object store & volume engine |
| **Node.js Webmail Gateway** | ~150 MB | Reverse proxy and Single-Page client |
| **OS & Buffer Cache** | ~1.5 GB – 2 GB | Linux page cache for NVMe I/O |
| **Total Recommended VPS** | **8 GB RAM (4 vCPU)** | e.g. **Hetzner CPX31 (~€14/mo)** |

---

## 5. Deployment Orchestration

The updated stack is ready to run with a single command on your VPS:
```bash
docker compose -f /opt/iron-id/deploy/docker-compose.yml up -d
```
All persistent volumes (`pgdata`, `opensearchdata`, `seaweeddata`, `maildata`) are isolated and survive container restarts with zero data loss.
