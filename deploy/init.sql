-- ==============================================================================
-- IRON ID Sovereign Mail — PostgreSQL 16 Schema Migration
-- Database: stalwart_mail
-- ==============================================================================

CREATE TABLE IF NOT EXISTS tenants (
    id SERIAL PRIMARY KEY,
    domain VARCHAR(255) UNIQUE NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    dkim_selector VARCHAR(50) DEFAULT 'stalwart',
    dkim_key_type VARCHAR(50) DEFAULT 'ed25519',
    dkim_public_key TEXT NOT NULL,
    dkim_dns_txt TEXT NOT NULL,
    default_quota_mb INTEGER DEFAULT 5120,
    default_daily_limit INTEGER DEFAULT 250,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mailboxes (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    domain VARCHAR(255) NOT NULL REFERENCES tenants(domain) ON DELETE CASCADE,
    account_id VARCHAR(50) UNIQUE NOT NULL,
    identity_id VARCHAR(50) UNIQUE NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'tenant_user' CHECK (role IN ('admin', 'tenant_user', 'system')),
    status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    password_hash VARCHAR(255) NOT NULL,
    storage_quota_mb INTEGER DEFAULT 5120,
    used_storage_mb NUMERIC(10, 2) DEFAULT 0.1,
    daily_send_limit INTEGER DEFAULT 250,
    today_sent_count INTEGER DEFAULT 0,
    last_active_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_attachments (
    id SERIAL PRIMARY KEY,
    message_id VARCHAR(255) NOT NULL,
    sender_email VARCHAR(255) NOT NULL,
    recipient_email VARCHAR(255) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    content_type VARCHAR(100) DEFAULT 'application/octet-stream',
    size_bytes BIGINT NOT NULL,
    s3_bucket VARCHAR(100) DEFAULT 'iron-id-mail-blobs',
    s3_key VARCHAR(500) NOT NULL,
    sha256_hash VARCHAR(64) NOT NULL,
    is_archived_to_box BOOLEAN DEFAULT FALSE,
    box_archive_id VARCHAR(255),
    archived_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    action VARCHAR(100) NOT NULL,
    target_domain VARCHAR(255),
    details TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indices for performance
CREATE INDEX IF NOT EXISTS idx_mailboxes_domain ON mailboxes(domain);
CREATE INDEX IF NOT EXISTS idx_mailboxes_email ON mailboxes(email);
CREATE INDEX IF NOT EXISTS idx_attachments_msg ON email_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_sha256 ON email_attachments(sha256_hash);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at DESC);

-- Seed Initial Verified Sovereign Tenants & Mailboxes
INSERT INTO tenants (domain, display_name, status, dkim_selector, dkim_key_type, dkim_public_key, dkim_dns_txt, default_quota_mb, default_daily_limit)
VALUES 
(
    'iron-id.io', 
    'IRON ID Sovereign HQ', 
    'active', 
    'stalwart', 
    'ed25519', 
    '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAn8D9QO7Kq7rT+Lp/bK2lK8gJ+7Z1X9X0mP6q8Q4bX0Q=\n-----END PUBLIC KEY-----', 
    'v=DKIM1; k=ed25519; p=n8D9QO7Kq7rT+Lp/bK2lK8gJ+7Z1X9X0mP6q8Q4bX0Q=', 
    10240, 
    1000
),
(
    'client.dz', 
    'Client DZ Partner Tenant', 
    'active', 
    'stalwart', 
    'ed25519', 
    '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAd5X8J2eQ3uY9kP+M4tL1mQ8vZ3bX2vW1qO9sT8yU7X8=\n-----END PUBLIC KEY-----', 
    'v=DKIM1; k=ed25519; p=d5X8J2eQ3uY9kP+M4tL1mQ8vZ3bX2vW1qO9sT8yU7X8=', 
    5120, 
    250
)
ON CONFLICT (domain) DO NOTHING;

INSERT INTO mailboxes (email, domain, account_id, identity_id, display_name, role, status, password_hash, storage_quota_mb, used_storage_mb, daily_send_limit, today_sent_count)
VALUES
(
    'charaf@iron-id.io',
    'iron-id.io',
    'c',
    'b',
    'Charaf Sellam',
    'admin',
    'active',
    '9e26e5be799e6919e1e24fb835b3e2307ef6be6f2d6c697864aa9a7852a65a25',
    10240,
    42.5,
    1000,
    2
),
(
    'anis@client.dz',
    'client.dz',
    'e',
    'd',
    'Anis Client',
    'tenant_user',
    'active',
    'cf5bfecdebf7b25121b643a6d71b4028ce8995a940989f64c1ecdddd1b3152a6',
    5120,
    14.8,
    250,
    1
)
ON CONFLICT (email) DO NOTHING;

INSERT INTO audit_logs (action, target_domain, details)
VALUES 
('SYSTEM_INITIALIZED', 'iron-id.io', 'PostgreSQL 16 relational store initialized with authoritative tenants.');
