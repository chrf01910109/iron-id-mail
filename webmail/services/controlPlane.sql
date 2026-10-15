-- IRON ID control plane schema. Idempotent: safe to run on every start.
-- Mail data (domains, accounts, messages, DKIM keys) lives in the engine, not here.

CREATE SCHEMA IF NOT EXISTS cp;

CREATE TABLE IF NOT EXISTS cp.settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cp.plans (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    max_mailboxes     INTEGER,
    mailbox_quota_mb  INTEGER,
    daily_send_limit  INTEGER,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cp.customers (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name           TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    plan_id        TEXT REFERENCES cp.plans(id),
    contact_email  TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cp.customer_domains (
    domain            TEXT PRIMARY KEY,
    customer_id       UUID NOT NULL REFERENCES cp.customers(id) ON DELETE RESTRICT,
    engine_domain_id  TEXT,
    verify_token      TEXT NOT NULL,
    verified_at       TIMESTAMPTZ,
    status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'verified', 'active', 'suspended')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- role 'platform' = IRON ID staff (customer_id NULL); 'customer' = admin of one customer
CREATE TABLE IF NOT EXISTS cp.admins (
    id           BIGSERIAL PRIMARY KEY,
    email        TEXT NOT NULL,
    customer_id  UUID REFERENCES cp.customers(id) ON DELETE CASCADE,
    role         TEXT NOT NULL CHECK (role IN ('platform', 'customer')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((role = 'platform') = (customer_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS admins_platform_uniq ON cp.admins (email) WHERE customer_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS admins_customer_uniq ON cp.admins (email, customer_id) WHERE customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS cp.audit_log (
    id           BIGSERIAL PRIMARY KEY,
    at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor        TEXT NOT NULL,
    customer_id  UUID,
    action       TEXT NOT NULL,
    target       TEXT,
    details      JSONB,
    ip           TEXT
);
CREATE INDEX IF NOT EXISTS audit_customer_at ON cp.audit_log (customer_id, at DESC);

-- Webmail sessions. The cookie value is never stored, only its SHA-256 hash;
-- the engine credentials are encrypted (see secretBox.js).
CREATE TABLE IF NOT EXISTS cp.sessions (
    id_hash     TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    auth_enc    TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ip          TEXT,
    user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS sessions_email ON cp.sessions (email);

CREATE TABLE IF NOT EXISTS cp.recovery (
    email           TEXT PRIMARY KEY,
    recovery_email  TEXT NOT NULL,
    verified_at     TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The app password the webmail uses for a mailbox (one per mailbox, shared by its signed-in
-- browsers). The mailbox password itself is never stored. The secret is encrypted (secretBox,
-- context 'webmail-credential:<email>').
CREATE TABLE IF NOT EXISTS cp.webmail_credentials (
  email       TEXT PRIMARY KEY,
  cred_id     TEXT NOT NULL,
  secret_enc  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Two-step codes already used (sha256 of mailbox|code), kept a few minutes so a code works once.
CREATE TABLE IF NOT EXISTS cp.used_codes (
  code_key  TEXT PRIMARY KEY,
  used_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Admin console (phase 3b).
-- An internal customer owns the platform's own domain (iron-id.io); it is never billed.
ALTER TABLE cp.customers ADD COLUMN IF NOT EXISTS internal BOOLEAN NOT NULL DEFAULT FALSE;
-- Plan prices are per mailbox per month; currency is a 3-letter code (DZD, EUR, ...).
ALTER TABLE cp.plans ADD COLUMN IF NOT EXISTS price_per_mailbox NUMERIC(12, 2);
ALTER TABLE cp.plans ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'DZD';
CREATE INDEX IF NOT EXISTS audit_target_at ON cp.audit_log (target, at DESC);
CREATE INDEX IF NOT EXISTS audit_at ON cp.audit_log (at DESC);

-- Labels a person made in the webmail. The label itself is a keyword on each message
-- ("label:<slug>"); this table only keeps its display name and colour.
CREATE TABLE IF NOT EXISTS cp.labels (
  email       TEXT NOT NULL,
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT 'slate',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (email, slug)
);

-- A person's own choices that follow them to every device (language for now: 'en' or 'fr').
CREATE TABLE IF NOT EXISTS cp.user_prefs (
  email       TEXT PRIMARY KEY,
  lang        TEXT CHECK (lang IN ('en', 'fr')),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
