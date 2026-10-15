/**
 * IRON ID Sovereign Email — Server-side webmail sessions
 *
 * The browser never keeps the mailbox password. After a successful login the
 * gateway keeps the engine credentials server-side and gives the browser an
 * opaque, HttpOnly session cookie.
 *
 * Sessions are stored in PostgreSQL (cp.sessions) so they survive redeploys:
 * only a SHA-256 hash of the cookie value is stored, and the credentials are
 * encrypted (secretBox). A short in-memory cache avoids a database read on
 * every request. If ADMIN_TOKEN is missing (no encryption key), sessions fall
 * back to memory only and are lost on redeploy.
 */
const crypto = require('crypto');
const db = require('./db');
const box = require('./secretBox');

const COOKIE_NAME = 'iid_session';
const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;      // sign out after 12h without activity
const ABSOLUTE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // and after 7 days in any case
const MAX_FAILED_LOGINS = 10;                      // per client IP ...
const MAX_FAILED_LOGINS_PER_ACCOUNT = 30;          // per mailbox, from all IPs ...
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;     // ... within 15 minutes
const CACHE_MS = 60 * 1000;                        // re-check the database at least once a minute
const TOUCH_MS = 5 * 60 * 1000;                    // write last_seen at most every 5 minutes

const cache = new Map();          // idHash -> { email, auth, createdAt, lastSeen, cachedAt, touchedAt }
const failedLogins = new Map();   // key -> { count, firstAt }
const revoked = new Map();        // idHash -> time; sign-outs whose database delete failed (retried later)

function now() { return Date.now(); }
function hashId(id) { return crypto.createHash('sha256').update(String(id)).digest('hex'); }
function persistent() { return box.isAvailable(); }

function expired(s, t) {
  return t - s.lastSeen > IDLE_TIMEOUT_MS || t - s.createdAt > ABSOLUTE_TIMEOUT_MS;
}

async function createSession(email, auth, meta = {}) {
  const id = crypto.randomBytes(32).toString('base64url');
  const h = hashId(id);
  const t = now();
  cache.set(h, { email, auth, createdAt: t, lastSeen: t, cachedAt: t, touchedAt: t });
  if (persistent()) {
    await db.query(
      'INSERT INTO cp.sessions (id_hash, email, auth_enc, ip, user_agent) VALUES ($1, $2, $3, $4, $5)',
      [h, email, box.encrypt(auth, 'session:' + h), meta.ip || null, (meta.userAgent || '').slice(0, 300) || null]
    );
  }
  return id;
}

async function getSession(id) {
  if (!id) return null;
  const h = hashId(id);
  const t = now();
  if (revoked.has(h)) return null;
  let s = cache.get(h);
  if (s && t - s.cachedAt > CACHE_MS) s = null;     // stale: confirm with the database
  if (!s && persistent()) {
    const r = await db.query('SELECT email, auth_enc, created_at, last_seen FROM cp.sessions WHERE id_hash = $1', [h]);
    if (!r.rows.length) { cache.delete(h); return null; }
    const row = r.rows[0];
    let auth;
    try { auth = box.decrypt(row.auth_enc, 'session:' + h); } catch (e) { await destroyHash(h); return null; }
    s = { email: row.email, auth, createdAt: row.created_at.getTime(), lastSeen: row.last_seen.getTime(), cachedAt: t, touchedAt: row.last_seen.getTime() };
    cache.set(h, s);
  }
  if (!s) return null;
  if (expired(s, t)) { await destroyHash(h); return null; }
  s.lastSeen = t;
  if (persistent() && t - s.touchedAt > TOUCH_MS) {
    s.touchedAt = t;
    db.query('UPDATE cp.sessions SET last_seen = NOW() WHERE id_hash = $1', [h]).catch(() => {});
  }
  return s;
}

async function destroyHash(h) {
  cache.delete(h);
  if (!persistent()) return;
  try {
    await db.query('DELETE FROM cp.sessions WHERE id_hash = $1', [h]);
    revoked.delete(h);
  } catch (e) {
    revoked.set(h, now());   // keep it signed out in this process; housekeeping retries the delete
    console.error('[sessions] could not delete session, will retry:', e.message);
  }
}

async function destroySession(id) {
  if (id) await destroyHash(hashId(id));
}

async function destroySessionsFor(email) {
  for (const [h, s] of cache) if (s.email === email) cache.delete(h);
  if (persistent()) await db.query('DELETE FROM cp.sessions WHERE email = $1', [email]);
}

/** Ends every session of this mailbox and starts a fresh one with the new credentials. */
async function replaceSessionsFor(email, auth, meta = {}) {
  await destroySessionsFor(email);
  return createSession(email, auth, meta);
}

/** Signed-in browsers of a mailbox, newest first. `key` is a short public handle (not the cookie). */
async function listSessionsFor(email, currentId) {
  const cur = currentId ? hashId(currentId) : null;
  const t = now();
  let rows = [];
  if (persistent()) {
    const r = await db.query('SELECT id_hash, created_at, last_seen, ip, user_agent FROM cp.sessions WHERE email = $1 ORDER BY last_seen DESC', [email]);
    rows = r.rows.map(x => ({ h: x.id_hash, createdAt: x.created_at.getTime(), lastSeen: x.last_seen.getTime(), ip: x.ip, userAgent: x.user_agent }));
  } else {
    for (const [h, s] of cache) if (s.email === email) rows.push({ h, createdAt: s.createdAt, lastSeen: s.lastSeen, ip: null, userAgent: null });
  }
  return rows
    .filter(x => !expired(x, t) && !revoked.has(x.h))
    .map(x => {
      const c = cache.get(x.h);
      return { key: x.h.slice(0, 16), current: x.h === cur, createdAt: x.createdAt, lastSeen: Math.max(x.lastSeen, c ? c.lastSeen : 0), ip: x.ip, userAgent: x.userAgent };
    });
}

/** Signs out one browser of this mailbox by its public handle. Returns true if found. */
async function destroySessionByKey(email, key) {
  if (!/^[0-9a-f]{16}$/.test(String(key))) return false;
  let found = null;
  if (persistent()) {
    const r = await db.query("SELECT id_hash FROM cp.sessions WHERE email = $1 AND id_hash LIKE $2 || '%'", [email, key]);
    if (r.rows.length === 1) found = r.rows[0].id_hash;
  } else {
    for (const [h, s] of cache) if (s.email === email && h.startsWith(key)) found = h;
  }
  if (!found) return false;
  await destroyHash(found);
  return true;
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) {
      const v = part.slice(i + 1).trim();
      try { out[part.slice(0, i).trim()] = decodeURIComponent(v); } catch (e) { out[part.slice(0, i).trim()] = v; }
    }
  });
  return out;
}

function sessionIdFrom(req) {
  return parseCookies(req.headers.cookie)[COOKIE_NAME] || null;
}

function isHttps(req) {
  return (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function sessionCookie(req, id) {
  const parts = [`${COOKIE_NAME}=${id}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
    `Max-Age=${Math.floor(ABSOLUTE_TIMEOUT_MS / 1000)}`];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

function clearCookie(req) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

// Railway's edge proxy appends the real client address as the LAST entry of
// X-Forwarded-For; earlier entries can be faked by the client, so they are ignored.
// Behind Railway's proxy the last X-Forwarded-For entry is the real client. When the gateway
// is reached directly (no proxy in front), set TRUST_PROXY=false so a client can't pick its address.
const TRUST_PROXY = String(process.env.TRUST_PROXY || 'true').toLowerCase() !== 'false';
function clientIp(req) {
  const socketIp = req.socket.remoteAddress || 'unknown';
  if (!TRUST_PROXY) return socketIp;
  const parts = (req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : socketIp;
}

function overLimit(key, max) {
  const f = failedLogins.get(key);
  if (!f) return false;
  if (now() - f.firstAt > FAILED_LOGIN_WINDOW_MS) { failedLogins.delete(key); return false; }
  return f.count >= max;
}

function bump(key) {
  const f = failedLogins.get(key);
  if (!f || now() - f.firstAt > FAILED_LOGIN_WINDOW_MS) failedLogins.set(key, { count: 1, firstAt: now() });
  else f.count++;
}

function isLoginBlocked(ip, email) {
  return overLimit('ip:' + ip, MAX_FAILED_LOGINS) ||
    overLimit('acct:' + String(email).toLowerCase(), MAX_FAILED_LOGINS_PER_ACCOUNT);
}

function recordFailedLogin(ip, email) {
  bump('ip:' + ip);
  bump('acct:' + String(email).toLowerCase());
}

/**
 * After a successful sign-in, only that mailbox's counter is reset. The address's counter is
 * left to expire, so signing in to one's own mailbox can't be used to keep guessing others'.
 */
function clearFailedLogins(ip, email) { if (email) failedLogins.delete('acct:' + String(email).toLowerCase()); }

// Housekeeping
setInterval(() => {
  const t = now();
  for (const [h, s] of cache) if (expired(s, t) || t - s.cachedAt > 10 * CACHE_MS) cache.delete(h);
  for (const [k, f] of failedLogins) if (t - f.firstAt > FAILED_LOGIN_WINDOW_MS) failedLogins.delete(k);
  for (const [h, at] of revoked) {
    if (t - at > ABSOLUTE_TIMEOUT_MS) { revoked.delete(h); continue; }
    if (persistent()) db.query('DELETE FROM cp.sessions WHERE id_hash = $1', [h]).then(() => revoked.delete(h)).catch(() => {});
  }
  if (persistent()) {
    db.query(
      `DELETE FROM cp.sessions WHERE last_seen < NOW() - ($1 || ' milliseconds')::interval
                                OR created_at < NOW() - ($2 || ' milliseconds')::interval`,
      [String(IDLE_TIMEOUT_MS), String(ABSOLUTE_TIMEOUT_MS)]
    ).catch(() => {});
  }
}, 10 * 60 * 1000).unref();

module.exports = {
  createSession, getSession, destroySession, destroySessionsFor, replaceSessionsFor,
  listSessionsFor, destroySessionByKey,
  sessionIdFrom, sessionCookie, clearCookie,
  clientIp, isLoginBlocked, recordFailedLogin, clearFailedLogins
};
