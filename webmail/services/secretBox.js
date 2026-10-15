/**
 * IRON ID — encryption for secrets stored in the control-plane database
 * (session credentials, the engine API key). AES-256-GCM.
 *
 * The key is derived from ADMIN_TOKEN, which lives only in Railway's
 * variables, so a copy of the database alone does not reveal these secrets.
 * Changing ADMIN_TOKEN makes old values unreadable: users sign in again and
 * the engine API key must be provisioned again (see engineAdmin.js).
 */
const crypto = require('crypto');

const PREFIX = 'v2';
let cachedKey = null;

function key() {
  if (cachedKey) return cachedKey;
  const secret = process.env.ADMIN_TOKEN;
  if (!secret) throw new Error('ADMIN_TOKEN is not set; cannot encrypt or decrypt stored secrets.');
  // The key is only as strong as the token: it must be long and random (e.g. openssl rand -hex 32).
  if (secret.length < 32 || new Set(secret).size < 10) {
    console.warn('[secretbox] WARNING: ADMIN_TOKEN is short or simple. Use at least 32 random characters (it protects stored sessions and the engine key).');
  }
  cachedKey = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.from('iron-id-cp'), Buffer.from('secretbox-v1'), 32));
  return cachedKey;
}

// `context` binds a ciphertext to where it is stored (e.g. the session's id hash),
// so a value copied into another row or setting cannot be decrypted there.
function encrypt(plaintext, context) {
  if (!context) throw new Error('secretBox.encrypt needs a context');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(String(context), 'utf8'));
  const data = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return [PREFIX, iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

function decrypt(box, context) {
  if (!context) throw new Error('secretBox.decrypt needs a context');
  const [prefix, iv, tag, data] = String(box).split('.');
  if (prefix !== PREFIX || !iv || !tag || !data) throw new Error('Unrecognised secret format');
  const tagBuf = Buffer.from(tag, 'base64url');
  const ivBuf = Buffer.from(iv, 'base64url');
  if (tagBuf.length !== 16 || ivBuf.length !== 12) throw new Error('Invalid secret');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), ivBuf, { authTagLength: 16 });
  d.setAAD(Buffer.from(String(context), 'utf8'));
  d.setAuthTag(tagBuf);
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

function isAvailable() {
  return !!process.env.ADMIN_TOKEN;
}

module.exports = { encrypt, decrypt, isAvailable };
