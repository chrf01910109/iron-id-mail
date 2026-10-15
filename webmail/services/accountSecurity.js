/**
 * IRON ID — account security: sign-in with two-step codes, the webmail's own app
 * password, two-step (TOTP) setup, app passwords for mail apps, and code replay protection.
 *
 * How sign-in works
 *  1. The password is checked against the engine (HTTP Basic on /jmap/session).
 *     - 200: correct, no two-step.  - 402: correct, two-step code needed.  - else: wrong.
 *  2. With two-step, the code is checked by the engine's own login API (/api/auth, the
 *     OAuth "authCode" flow) and exchanged for a short-lived access token (/auth/token).
 *  3. The browser session then uses an engine app password made for the webmail
 *     ("IRON ID webmail"), shared by the mailbox's signed-in browsers and stored encrypted.
 *     The mailbox password itself is never stored.
 */
const http = require('http');
const crypto = require('crypto');
const qrcode = require('qrcode-generator');
const db = require('./db');
const box = require('./secretBox');

const ENGINE_HOST = process.env.IRONID_ENGINE_HOST || process.env.MAIL_ENGINE_HOST || '127.0.0.1';
const ENGINE_PORT = parseInt(process.env.IRONID_ENGINE_PORT || process.env.MAIL_ENGINE_PORT, 10) || 8080;
const USING = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'];
const WEBMAIL_CRED_NAME = 'IRON ID webmail';
const WEBMAIL_CRED_DAYS = 30;
const REUSE_MIN_DAYS = 8;          // a session lasts at most 7 days
const OAUTH_CLIENT = 'ironid-webmail';
const OAUTH_REDIRECT = 'https://webmail.iron-id.invalid/signed-in';
const ISSUER = process.env.TOTP_ISSUER || 'IRON ID';

/* ——— Engine HTTP ——— */
function engineRequest(method, path, { headers = {}, body = null, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(body));
    const r = http.request({
      hostname: ENGINE_HOST, port: ENGINE_PORT, path, method, timeout,
      headers: { host: ENGINE_HOST + ':' + ENGINE_PORT, ...headers, ...(data ? { 'content-length': data.length } : {}) }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    r.on('timeout', () => r.destroy(new Error('engine timeout')));
    r.on('error', reject);
    r.end(data);
  });
}

const basic = (user, secret) => 'Basic ' + Buffer.from(user + ':' + secret, 'utf8').toString('base64');

async function jmap(auth, methodCalls, using = USING) {
  const r = await engineRequest('POST', '/jmap/', {
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify({ using, methodCalls })
  });
  if (r.status === 401) throw Object.assign(new Error('not authorized'), { status: 401 });
  if (r.status !== 200 || !r.json) throw Object.assign(new Error('engine HTTP ' + r.status), { status: r.status });
  return r.json.methodResponses;
}

/** Uploads a blob (e.g. a whole message) to an account. Over-quota answers throw { overQuota: true }. */
async function uploadBlob(auth, accountId, data, type) {
  const r = await engineRequest('POST', `/jmap/upload/${encodeURIComponent(accountId)}/`, {
    headers: { authorization: auth, 'content-type': type }, body: data, timeout: 120000
  });
  if (r.status === 401) throw Object.assign(new Error('not authorized'), { status: 401 });
  if (/overQuota|quota/i.test(r.text || '') && r.status >= 400) throw Object.assign(new Error('over quota'), { overQuota: true });
  if (r.status < 200 || r.status >= 300 || !r.json || !r.json.blobId) throw new Error('upload HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 200));
  return r.json;
}

function first(responses, id) {
  const hit = responses.find(x => x[2] === id);
  if (!hit) throw new Error('no answer from the mail engine');
  if (hit[0] === 'error') throw Object.assign(new Error(hit[1].description || hit[1].type), { type: hit[1].type });
  return hit[1];
}

/** 'ok' (password right, no two-step) | 'mfa' (password right, code needed) | 'bad' */
// App passwords ("app_…") and API keys ("API_…") open mail apps, never the webmail: they skip
// two-step by design, so accepting them here would let a phone's app password bypass it.
const NOT_A_PASSWORD = /^(app_[a-z0-9]{20,}|API_[A-Za-z0-9_-]{20,})$/;

async function checkPassword(email, password) {
  if (NOT_A_PASSWORD.test(String(password))) return { result: 'bad' };
  const r = await engineRequest('GET', '/jmap/session', { headers: { authorization: basic(email, password) } });
  if (r.status === 200 && r.json && r.json.username) {
    // Belt and braces: a 200 for an account with two-step on means the secret was not its password.
    try { if (await twoStepEnabled(basic(email, password))) return { result: 'bad' }; } catch (e) { /* treat as ok */ }
    return { result: 'ok', session: r.json };
  }
  if (r.status === 402) return { result: 'mfa' };
  if (r.status >= 500) throw new Error('engine HTTP ' + r.status);
  return { result: 'bad' };
}

async function engineSession(auth) {
  const r = await engineRequest('GET', '/jmap/session', { headers: { authorization: auth } });
  return r.status === 200 && r.json && r.json.username ? r.json : null;
}

/** Verifies password + code with the engine. Returns an access token ('Bearer …') or null. */
async function signInWithCode(email, password, code) {
  const r = await engineRequest('POST', '/api/auth', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'authCode', accountName: email, accountSecret: password, mfaToken: code, clientId: OAUTH_CLIENT, redirectUri: OAUTH_REDIRECT })
  });
  if (r.status !== 200 || !r.json || r.json.type !== 'authenticated' || !r.json.client_code) return null;
  const t = await engineRequest('POST', '/auth/token', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: r.json.client_code, client_id: OAUTH_CLIENT, redirect_uri: OAUTH_REDIRECT }).toString()
  });
  if (t.status !== 200 || !t.json || !t.json.access_token) throw new Error('could not complete two-step sign-in');
  return 'Bearer ' + t.json.access_token;
}

/* ——— Two-step code replay protection ——— */
const usedCodes = new Map(); // email|code -> expiry (when there is no database key)

/**
 * Claims a code for one use. Returns false if it was already used in the last few minutes.
 * Atomic in the database, so two parallel sign-ins (or two gateways) can't both use it.
 */
async function claimCode(email, code) {
  const key = String(email).toLowerCase() + '|' + code;
  if (box.isAvailable()) {
    db.query("DELETE FROM cp.used_codes WHERE used_at < NOW() - INTERVAL '5 minutes'").catch(() => {});
    const r = await db.query('INSERT INTO cp.used_codes (code_key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING code_key',
      [crypto.createHash('sha256').update(key).digest('hex')]);
    return r.rowCount === 1;
  }
  const t = Date.now();
  for (const [k, exp] of usedCodes) if (exp < t) usedCodes.delete(k);
  if (usedCodes.has(key)) return false;
  usedCodes.set(key, t + 300000);
  return true;
}
const validCodeFormat = code => /^\d{6}$/.test(String(code || ''));

/* ——— The webmail's app password ——— */
const isoIn = days => new Date(Date.now() + days * 86400e3).toISOString().replace(/\.\d{3}Z$/, 'Z');

async function listAppPasswords(auth) {
  const res = first(await jmap(auth, [['x:AppPassword/get', { ids: null, properties: ['description', 'createdAt', 'expiresAt'] }, 'g']]), 'g');
  return res.list || [];
}

async function createAppPassword(auth, description, expiresAt = null) {
  const value = { description };
  if (expiresAt) value.expiresAt = expiresAt;
  const res = first(await jmap(auth, [['x:AppPassword/set', { create: { a: value } }, 's']]), 's');
  if (res.created && res.created.a) return { id: res.created.a.id, secret: res.created.a.secret };
  const e = res.notCreated && res.notCreated.a;
  if (e && e.type === 'overQuota') throw Object.assign(new Error('This mailbox already has the maximum number of app passwords. Remove one in Settings → Security, then try again.'), { code: 'overQuota', userError: true });
  throw new Error((e && e.description) || 'Could not create an app password');
}

async function destroyAppPasswords(auth, ids) {
  if (!ids.length) return;
  first(await jmap(auth, [['x:AppPassword/set', { destroy: ids }, 'd']]), 'd');
}

const memCredentials = new Map(); // used only when there is no encryption key (development)

async function storeCredential(email, cred, expiresAt) {
  if (!box.isAvailable()) { memCredentials.set(email, { id: cred.id, secret: cred.secret, expiresAt: Date.parse(expiresAt) }); return; }
  await db.query(
    `INSERT INTO cp.webmail_credentials (email, cred_id, secret_enc, expires_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET cred_id = EXCLUDED.cred_id, secret_enc = EXCLUDED.secret_enc, expires_at = EXCLUDED.expires_at, created_at = NOW()`,
    [email, cred.id, box.encrypt(cred.secret, 'webmail-credential:' + email), expiresAt]
  );
}

async function storedCredential(email) {
  if (!box.isAvailable()) return memCredentials.get(email) || null;
  const r = await db.query('SELECT cred_id, secret_enc, expires_at FROM cp.webmail_credentials WHERE email = $1', [email]);
  if (!r.rows.length) return null;
  try {
    return { id: r.rows[0].cred_id, secret: box.decrypt(r.rows[0].secret_enc, 'webmail-credential:' + email), expiresAt: r.rows[0].expires_at.getTime() };
  } catch (e) { return null; }
}

/** The webmail's stored access for a mailbox, if it still works ('Basic …'), else null. Used by background jobs (mail import). */
async function storedWebmailAuth(email) {
  const stored = await storedCredential(String(email).toLowerCase());
  if (!stored || stored.expiresAt < Date.now()) return null;
  const auth = basic(String(email).toLowerCase(), stored.secret);
  return (await engineSession(auth)) ? auth : null;
}

/** Forgets the webmail's stored access for a mailbox (after an admin reset, suspension or deletion). */
async function forgetWebmailCredential(email) {
  memCredentials.delete(email);
  if (box.isAvailable()) await db.query('DELETE FROM cp.webmail_credentials WHERE email = $1', [email]);
}

/** Makes a new webmail app password with `auth`; removes other webmail ones (expired ones only unless `revokeOthers`). */
async function newWebmailCredential(email, auth, { revokeOthers = false } = {}) {
  let existing = [];
  try { existing = (await listAppPasswords(auth)).filter(a => a.description === WEBMAIL_CRED_NAME); } catch (e) { existing = []; }
  const now = Date.now();
  const expiredIds = existing.filter(a => a.expiresAt && Date.parse(a.expiresAt) < now).map(a => a.id);
  if (expiredIds.length) await destroyAppPasswords(auth, expiredIds).catch(() => {});
  const expiresAt = isoIn(WEBMAIL_CRED_DAYS);
  let cred;
  try {
    cred = await createAppPassword(auth, WEBMAIL_CRED_NAME, expiresAt);
  } catch (e) {
    if (e.code !== 'overQuota') throw e;
    // Make room by dropping the oldest webmail credential (its browsers sign in again).
    const live = existing.filter(a => !expiredIds.includes(a.id)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    if (!live.length) throw e;
    await destroyAppPasswords(auth, [live[0].id]);
    cred = await createAppPassword(auth, WEBMAIL_CRED_NAME, expiresAt);
  }
  const newAuth = basic(email, cred.secret);
  if (revokeOthers) {
    const others = existing.filter(a => a.id !== cred.id && !expiredIds.includes(a.id)).map(a => a.id);
    if (others.length) await destroyAppPasswords(newAuth, others);
  }
  await storeCredential(email, cred, expiresAt);
  return newAuth;
}

/**
 * The engine credentials a new browser session of this mailbox should use.
 * `auth` proves the person just signed in (password, or token after a two-step code).
 */
async function webmailAuthFor(email, auth) {
  const stored = await storedCredential(email);
  if (stored && stored.expiresAt - Date.now() > REUSE_MIN_DAYS * 86400e3) {
    const candidate = basic(email, stored.secret);
    if (await engineSession(candidate)) return candidate;
  }
  return newWebmailCredential(email, auth);
}

/** New webmail credential; every other one is revoked (other browsers are signed out). */
function rotateWebmailCredential(email, auth) {
  return newWebmailCredential(email, auth, { revokeOthers: true });
}

/* ——— Two-step (TOTP) ——— */
function base32Decode(str) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of String(str).toUpperCase().replace(/=+$/, '')) { const v = A.indexOf(c); if (v < 0) return null; bits += v.toString(2).padStart(5, '0'); }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

/** Checks a 6-digit code against a TOTP secret (current 30 s step, ±1 step for clock drift). */
function totpMatches(secretB32, code) {
  const key = base32Decode(secretB32);
  if (!key || !/^\d{6}$/.test(String(code))) return false;
  const step = Math.floor(Date.now() / 30000);
  for (const d of [-1, 0, 1]) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step + d));
    const hm = crypto.createHmac('sha1', key).update(counter).digest();
    const o = hm[hm.length - 1] & 15;
    const v = String(((hm.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
    if (crypto.timingSafeEqual(Buffer.from(v), Buffer.from(String(code)))) return true;
  }
  return false;
}

/** The secret inside an otpauth URL this server made. */
function otpSecret(url) {
  try { return new URL(url).searchParams.get('secret'); } catch (e) { return null; }
}

function base32(buf) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += A[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

function otpUrlFor(email, secret) {
  const label = encodeURIComponent(ISSUER) + ':' + encodeURIComponent(email);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=30`;
}
const validSecret = s => /^[A-Z2-7]{32}$/.test(String(s || ''));

/** A new secret and the QR code to scan. Nothing is saved until the person confirms a code. */
function newTotpSetup(email) {
  const secret = base32(crypto.randomBytes(20));
  const otpUrl = otpUrlFor(email, secret);
  const qr = qrcode(0, 'M');
  qr.addData(otpUrl);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true });
  return { secret, otpUrl, qr: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') };
}

/** Accepts only otpauth URLs this server could have made for this mailbox. */
function validOtpUrl(email, url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'otpauth:' || u.host !== 'totp') return false;
    const label = decodeURIComponent(u.pathname.replace(/^\//, ''));
    if (label !== `${ISSUER}:${email}`) return false;
    return /^[A-Z2-7]{32}$/.test(u.searchParams.get('secret') || '') && (u.searchParams.get('digits') || '6') === '6';
  } catch (e) { return false; }
}

async function twoStepEnabled(auth) {
  const res = first(await jmap(auth, [['x:AccountPassword/get', { ids: ['singleton'] }, 'g']]), 'g');
  const item = (res.list || [])[0] || {};
  return !!(item.otpAuth && item.otpAuth.otpUrl);
}

/** Sets (otpUrl) or clears (otpUrl null) two-step. Returns null or an error message. */
async function setTwoStep(auth, password, otpUrl, code) {
  const res = first(await jmap(auth, [['x:AccountPassword/set', { update: { singleton: { currentSecret: password, otpAuth: { otpUrl, otpCode: code } } } }, 's']]), 's');
  if (res.updated && 'singleton' in res.updated) return null;
  const e = (res.notUpdated && res.notUpdated.singleton) || {};
  return friendly(e.description || e.type || 'The change was refused');
}

function friendly(msg) {
  const m = String(msg || '');
  if (/current.*(secret|password)|incorrect|invalid.*(secret|password)/i.test(m)) return 'Your current password is incorrect.';
  if (/otp|code|token/i.test(m)) return 'That code is not right. Use the current code from your authenticator app.';
  return m.replace(/secret/gi, 'password');
}

/* ——— App passwords for mail apps ——— */
async function mailAppPasswords(auth) {
  return (await listAppPasswords(auth))
    .filter(a => a.description !== WEBMAIL_CRED_NAME)
    .map(a => ({ id: a.id, name: a.description || 'App password', createdAt: a.createdAt || null, expiresAt: a.expiresAt || null }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function createMailAppPassword(auth, name) {
  const clean = String(name || '').replace(/[\x00-\x1f]/g, '').trim().slice(0, 60);
  if (!clean) throw Object.assign(new Error('Give the app password a name, for example "Outlook on my laptop".'), { userError: true });
  if (clean.toLowerCase() === WEBMAIL_CRED_NAME.toLowerCase()) throw Object.assign(new Error('That name is reserved. Please choose another.'), { userError: true });
  return createAppPassword(auth, clean);
}

async function deleteMailAppPassword(auth, id) {
  const list = await listAppPasswords(auth);
  const target = list.find(a => a.id === String(id));
  if (!target || target.description === WEBMAIL_CRED_NAME) return false;
  await destroyAppPasswords(auth, [target.id]);
  return true;
}

module.exports = {
  totpMatches, otpSecret, otpUrlFor, validSecret,
  basic, checkPassword, signInWithCode, engineSession, webmailAuthFor, rotateWebmailCredential,
  claimCode, validCodeFormat,
  newTotpSetup, validOtpUrl, twoStepEnabled, setTwoStep, friendly,
  mailAppPasswords, createMailAppPassword, deleteMailAppPassword, WEBMAIL_CRED_NAME, forgetWebmailCredential,
  jmap, first, engineRequest, storedWebmailAuth, uploadBlob
};
