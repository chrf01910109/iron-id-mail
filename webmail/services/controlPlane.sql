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

-- Sign-up (name@iron-id.io): one row per sign-up. A row is reserved ('pending') before the account is
-- created and removed if that fails, so the limits per network (IPv4 address or IPv6 /64) and per day
-- hold under parallel requests. external_daily_limit is the sending limit that applied at sign-up.
-- An address can appear more than once (a deleted mailbox's address can be taken again).
CREATE TABLE IF NOT EXISTS cp.signup_log (
  id                    BIGSERIAL PRIMARY KEY,
  email                 TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip                    TEXT,
  network               TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'created')),
  terms_version         TEXT NOT NULL,
  lang                  TEXT,
  external_daily_limit  INTEGER
);
CREATE INDEX IF NOT EXISTS signup_log_created ON cp.signup_log (created_at DESC);
CREATE INDEX IF NOT EXISTS signup_log_network ON cp.signup_log (network, created_at DESC);
CREATE INDEX IF NOT EXISTS signup_log_email ON cp.signup_log (email);

-- Sign-up security-check puzzles already used (each works once).
CREATE TABLE IF NOT EXISTS cp.signup_puzzles (
  challenge  TEXT PRIMARY KEY,
  used_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "Forgot password?" links (off unless PASSWORD_RESET_ENABLED=true). Only the SHA-256 of the
-- link's secret is kept; a link works once, until expires_at.
CREATE TABLE IF NOT EXISTS cp.password_resets (
  id          BIGSERIAL PRIMARY KEY,
  email       TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  sent_to     TEXT NOT NULL,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS password_resets_email ON cp.password_resets (email, created_at);
-- Confirming the recovery address: a 6-digit code sent to it, typed in Settings (only a salted hash is kept).
ALTER TABLE cp.recovery ADD COLUMN IF NOT EXISTS confirm_hash TEXT;
ALTER TABLE cp.recovery ADD COLUMN IF NOT EXISTS confirm_expires TIMESTAMPTZ;
ALTER TABLE cp.recovery ADD COLUMN IF NOT EXISTS confirm_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE cp.recovery ADD COLUMN IF NOT EXISTS confirm_sends INT NOT NULL DEFAULT 0;
ALTER TABLE cp.recovery ADD COLUMN IF NOT EXISTS confirm_window TIMESTAMPTZ;

-- Billing (2026-10): personal customers own the domains a person connects or buys from the webmail.
ALTER TABLE cp.customers ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'business';
ALTER TABLE cp.customers ADD COLUMN IF NOT EXISTS owner_email TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS customers_personal_owner ON cp.customers (lower(owner_email)) WHERE kind = 'personal';

-- Orders: one per thing sold. Amounts in cents, VAT as it was when ordered.
CREATE TABLE IF NOT EXISTS cp.orders (
  id               BIGSERIAL PRIMARY KEY,
  customer_id      UUID REFERENCES cp.customers(id) ON DELETE SET NULL,
  email            TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('domain_connect', 'domain_register', 'domain_renew')),
  domain           TEXT,
  amount_cents     INTEGER NOT NULL,
  amount_ht_cents  INTEGER NOT NULL,
  vat_cents        INTEGER NOT NULL,
  vat_rate         NUMERIC(5,2) NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'EUR',
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'fulfilled', 'failed', 'cancelled', 'refunded')),
  provider         TEXT,
  provider_ref     TEXT,
  payment_ref      TEXT,
  details          JSONB NOT NULL DEFAULT '{}',
  lang             TEXT,
  error            TEXT,
  invoice_number   TEXT UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at          TIMESTAMPTZ,
  fulfilled_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS orders_customer ON cp.orders (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status ON cp.orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_payment_ref ON cp.orders (payment_ref);

-- Invoice numbers without gaps, per year (F2026-000001…).
CREATE TABLE IF NOT EXISTS cp.invoice_seq (
  year  INTEGER PRIMARY KEY,
  last  INTEGER NOT NULL
);

-- Domains bought through IRON ID (registered at the registrar on the person's behalf).
CREATE TABLE IF NOT EXISTS cp.registered_domains (
  domain          TEXT PRIMARY KEY,
  customer_id     UUID REFERENCES cp.customers(id) ON DELETE SET NULL,
  registrar       TEXT NOT NULL,
  registrar_ref   TEXT,
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired')),
  reminded_at     TIMESTAMPTZ
);

-- Copies of old mailboxes into IRON ID (IMAP). The old password is encrypted and erased when the copy ends.
CREATE TABLE IF NOT EXISTS cp.migrations (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL,
  source_host   TEXT NOT NULL,
  source_port   INTEGER NOT NULL,
  source_user   TEXT NOT NULL,
  secret_enc    TEXT,
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  folders_total INTEGER NOT NULL DEFAULT 0,
  folders_done  INTEGER NOT NULL DEFAULT 0,
  messages_done INTEGER NOT NULL DEFAULT 0,
  bytes_done    BIGINT NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  state         JSONB NOT NULL DEFAULT '{}',
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS migrations_email ON cp.migrations (email, created_at DESC);
