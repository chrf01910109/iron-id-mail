/**
 * IRON ID — control-plane database access.
 *
 * Uses the same PostgreSQL database as the mail engine, in a separate `cp`
 * schema that holds only what the engine has no place for: customers, domain
 * ownership, admin roles, sessions, settings and the audit log.
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { getPostgresConfig } = require('./dbUrlParser');

let pool = null;

function getPool() {
  if (!pool) {
    const c = getPostgresConfig();
    pool = new Pool({
      host: c.host,
      port: c.port,
      user: c.user,
      password: c.password,
      database: c.database,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
    pool.on('error', err => console.error('[db] idle client error:', err.message));
  }
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'controlPlane.sql'), 'utf8');
  await query(sql);
  // Platform admins come from configuration (comma-separated mailbox addresses).
  const admins = (process.env.PLATFORM_ADMINS || 'charaf@iron-id.io')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const email of admins) {
    await query(
      `INSERT INTO cp.admins (email, customer_id, role)
       SELECT $1, NULL, 'platform'
       WHERE NOT EXISTS (SELECT 1 FROM cp.admins WHERE email = $1 AND customer_id IS NULL)`,
      [email]
    );
  }
  // The platform's own domain belongs to an internal customer (never billed).
  const platformDomain = (process.env.PLATFORM_DOMAIN || process.env.GATEWAY_ACCOUNT_DOMAIN || 'iron-id.io').toLowerCase();
  await query(
    `INSERT INTO cp.customers (name, internal, contact_email)
     SELECT 'IRON ID', TRUE, NULL WHERE NOT EXISTS (SELECT 1 FROM cp.customers WHERE internal)`
  );
  await query(
    `INSERT INTO cp.customer_domains (domain, customer_id, verify_token, verified_at, status)
     SELECT $1, id, 'platform', NOW(), 'active' FROM cp.customers WHERE internal ORDER BY created_at LIMIT 1
     ON CONFLICT (domain) DO NOTHING`,
    [platformDomain]
  );
}

async function getSetting(key) {
  const r = await query('SELECT value FROM cp.settings WHERE key = $1', [key]);
  return r.rows.length ? r.rows[0].value : null;
}

async function setSetting(key, value) {
  await query(
    `INSERT INTO cp.settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value]
  );
}

async function audit({ actor, customerId = null, action, target = null, details = null, ip = null }) {
  await query(
    'INSERT INTO cp.audit_log (actor, customer_id, action, target, details, ip) VALUES ($1, $2, $3, $4, $5, $6)',
    [actor, customerId, action, target, details ? JSON.stringify(details) : null, ip]
  );
}

module.exports = { getPool, query, migrate, getSetting, setSetting, audit };
