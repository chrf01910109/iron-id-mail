/**
 * "Forgot password?": a one-time link sent to the mailbox's recovery address (an address outside
 * IRON ID that the person saved in Settings → Security, or gave at sign-up).
 *
 * Off unless PASSWORD_RESET_ENABLED=true. It stays off in production until IRON ID's own mail server
 * sends mail to outside addresses (the VPS): before that, the link would not arrive or land in spam.
 *
 * Who can use it: ordinary mailboxes with a recovery address. Not admins (cp.admins, PLATFORM_ADMINS),
 * not engine-managed accounts (Admin role, special permissions), not suspended mailboxes, and not
 * mailboxes with two-step sign-in (an email alone must not get past the second step). They ask an
 * administrator, who uses Mailboxes → Reset sign-in.
 *
 * Protections:
 *   - the answer is the same whether or not the address exists or can use this (no account discovery),
 *     and the work happens after answering (no timing difference);
 *   - the link holds 32 random bytes; only their SHA-256 is stored; it works once, for 30 minutes, and a
 *     newer link replaces older ones;
 *   - at most 3 links per mailbox per hour, and limits per network;
 *   - the link points at PUBLIC_URL (or Railway's public domain), never at the Host header;
 *   - after the reset, every browser and mail app of that mailbox is signed out.
 * The mail is sent by the mailbox no-reply@<platform domain>, which the gateway creates on first use
 * (random password, kept encrypted in cp.settings).
 */
const crypto = require('crypto');
const db = require('./db');
const box = require('./secretBox');
const engineAdmin = require('./engineAdmin');
const security = require('./accountSecurity');
const sessions = require('./sessionStore');
const adminConsole = require('./adminConsole');
const signup = require('./signup');

const DOMAIN = adminConsole.PLATFORM_DOMAIN;
const SENDER = 'no-reply';
const SENDER_SETTING = 'password_reset_sender';
const TOKEN_TTL_MIN = 30;
const PER_MAILBOX_HOUR = 3;
const MAIL_USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'];
const MB = 1024 * 1024;

class ResetError extends Error {
  constructor(message, status = 400, extra = {}) { super(message); this.status = status; this.userError = true; Object.assign(this, extra); }
}
const fail = (msg, status, extra) => { throw new ResetError(msg, status, extra); };

function baseUrl() {
  const u = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '');
  return u.replace(/\/+$/, '');
}
const enabled = () => process.env.PASSWORD_RESET_ENABLED === 'true' && !!process.env.ADMIN_TOKEN && !!baseUrl();
const sha256hex = s => crypto.createHash('sha256').update(s).digest('hex');
const EMAIL_RE = /^[^\s@<>"(),;:]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$/i;

/* ——— Recovery address (Settings → Security) ——— */
async function getRecovery(email) {
  const r = await db.query('SELECT recovery_email, verified_at FROM cp.recovery WHERE email = $1', [String(email).toLowerCase()]);
  return r.rows.length ? { email: r.rows[0].recovery_email, verified: !!r.rows[0].verified_at } : null;
}

/** Saves (or with '' removes) the recovery address. The caller has checked the password. */
async function setRecovery(email, value) {
  const me = String(email).toLowerCase();
  const rec = String(value || '').trim().toLowerCase();
  if (!rec) {
    await db.query('DELETE FROM cp.recovery WHERE email = $1', [me]);
    return null;
  }
  if (rec.length > 254 || !EMAIL_RE.test(rec)) fail('Enter a valid email address.');
  if (rec === me) fail('Use another address than this mailbox.');
  if (rec.endsWith('@' + DOMAIN)) fail('Use an address outside IRON ID for recovery, so you can still reach it if you are locked out.', 400, { code: 'recovery' });
  await db.query(`INSERT INTO cp.recovery (email, recovery_email, verified_at, updated_at) VALUES ($1, $2, NULL, NOW())
                  ON CONFLICT (email) DO UPDATE SET recovery_email = EXCLUDED.recovery_email,
                    verified_at = CASE WHEN cp.recovery.recovery_email = EXCLUDED.recovery_email THEN cp.recovery.verified_at END, updated_at = NOW()`,
    [me, rec]);
  return getRecovery(me);
}

/* ——— Who may reset by email ——— */
/** The engine account, or why this mailbox can't use "Forgot password?" (never shown to the requester). */
async function eligibility(email) {
  const dir = await adminConsole.engineDirectory({ withCredentials: true });
  const a = dir.accounts.find(x => x.email === email && x['@type'] === 'User');
  if (!a) return { reason: 'unknown' };
  if (a.name === SENDER && a.domain === DOMAIN) return { reason: 'protected' };
  const role = a.roles && a.roles['@type'];
  if (role && role !== 'User') return { reason: 'protected' };
  const p = a.permissions || {};
  if (p['@type'] && !['Inherit', 'Merge'].includes(p['@type'])) return { reason: 'protected' };
  if (p['@type'] === 'Merge' && Object.keys(p.enabledPermissions || {}).length) return { reason: 'protected' };
  if (p.disabledPermissions && p.disabledPermissions.authenticate) return { reason: 'suspended' };
  if (Object.values(a.credentials || {}).some(c => c && c['@type'] === 'Password' && c.otpAuth)) return { reason: 'two-step' };
  // Any admin right, active or not (cp.admins also holds PLATFORM_ADMINS).
  if ((await db.query('SELECT 1 FROM cp.admins WHERE lower(email) = $1', [email])).rows.length) return { reason: 'admin' };
  return { a };
}

/* ——— The sending mailbox: no-reply@<platform domain> ——— */
let sender = null; // { email, auth }
async function senderAuth() {
  if (sender) return sender;
  const email = `${SENDER}@${DOMAIN}`;
  const ctx = 'setting:' + SENDER_SETTING;
  let password = null;
  const stored = await db.getSetting(SENDER_SETTING).catch(() => null);
  if (stored) { try { password = box.decrypt(stored, ctx); } catch (e) { password = null; } }
  if (password && await security.engineSession(security.basic(email, password))) return (sender = { email, auth: security.basic(email, password) });

  // First use (or the stored password no longer works): create the mailbox, or give it a new password.
  password = crypto.randomBytes(24).toString('base64url');
  const dir = await adminConsole.engineDirectory();
  const existing = dir.accounts.find(x => x.email === email);
  const credentials = { 0: { '@type': 'Password', secret: password } };
  if (existing) {
    if (existing['@type'] !== 'User' || (existing.roles && existing.roles['@type'] && existing.roles['@type'] !== 'User')) {
      throw new Error(`${email} exists with a special role; it can't be used to send recovery links`);
    }
    await adminConsole.engineSet('Account', { update: { [existing.id]: { credentials } } }, 'set up the sending mailbox');
  } else {
    const d = dir.domainByName.get(DOMAIN);
    if (!d) throw new Error('platform domain not found in the engine');
    await adminConsole.engineSet('Account', { create: { u: {
      '@type': 'User', name: SENDER, domainId: d.id, description: 'IRON ID (sends account messages; do not reply)',
      roles: { '@type': 'User' }, permissions: { '@type': 'Inherit' }, encryptionAtRest: { '@type': 'Disabled' },
      quotas: { maxDiskQuota: 50 * MB }, credentials
    } } }, 'create the sending mailbox');
  }
  await db.setSetting(SENDER_SETTING, box.encrypt(password, ctx));
  return (sender = { email, auth: security.basic(email, password) });
}

async function sendMail({ to, subject, text }) {
  const s = await senderAuth();
  const session = await security.engineSession(s.auth);
  const accountId = session && session.primaryAccounts && session.primaryAccounts['urn:ietf:params:jmap:submission'];
  if (!accountId) { sender = null; throw new Error('sending mailbox: no access'); }
  const got = await security.jmap(s.auth, [
    ['Mailbox/get', { accountId, properties: ['role'] }, 'm'],
    ['Identity/get', { accountId }, 'i']
  ], MAIL_USING);
  const drafts = (security.first(got, 'm').list || []).find(b => b.role === 'drafts');
  if (!drafts) throw new Error('sending mailbox: no drafts folder');
  let identity = (security.first(got, 'i').list || []).find(i => String(i.email).toLowerCase() === s.email);
  if (!identity) {
    const made = security.first(await security.jmap(s.auth, [['Identity/set', { accountId, create: { i: { email: s.email, name: 'IRON ID' } } }, 'n']], MAIL_USING), 'n');
    identity = made.created && made.created.i;
    if (!identity) throw new Error('sending mailbox: no identity');
  }
  const r = await security.jmap(s.auth, [
    ['Email/set', { accountId, create: { m: {
      mailboxIds: { [drafts.id]: true }, from: [{ name: 'IRON ID', email: s.email }], to: [{ email: to }], subject,
      keywords: { $seen: true }, bodyValues: { b: { value: text } }, textBody: [{ partId: 'b', type: 'text/plain' }]
    } } }, 'e'],
    ['EmailSubmission/set', { accountId, create: { s: { identityId: identity.id, emailId: '#m' } }, onSuccessDestroyEmail: ['#s'] }, 's']
  ], MAIL_USING);
  const made = security.first(r, 's');
  if (!made.created || !made.created.s) throw new Error('send refused: ' + JSON.stringify(made.notCreated || {}));
}

/* ——— The message ——— */
const MESSAGE = {
  en: {
    subject: 'Reset your IRON ID password',
    body: (email, link) => `Hello,

Someone asked to reset the password of ${email}. If it was you, open this link within ${TOKEN_TTL_MIN} minutes and choose a new password:

${link}

The link works once. After the change, every browser and mail app signed in to this mailbox is signed out.

If you didn't ask for this, ignore this message: your password stays as it is.

The IRON ID team`
  },
  fr: {
    subject: 'Réinitialisez votre mot de passe IRON ID',
    body: (email, link) => `Bonjour,

Quelqu’un a demandé à réinitialiser le mot de passe de ${email}. Si c’est vous, ouvrez ce lien dans les ${TOKEN_TTL_MIN} minutes et choisissez un nouveau mot de passe :

${link}

Le lien ne fonctionne qu’une fois. Après le changement, tous les navigateurs et applications de messagerie connectés à cette boîte sont déconnectés.

Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : votre mot de passe ne change pas.

L’équipe IRON ID`
  }
};

/* ——— Asking for a link ——— */
/** Does the work behind POST /recover-api/request. Never throws; the requester always gets the same answer. */
async function sendLink(email, { ip, lang }) {
  let outcome = 'sent';
  try {
    const recent = await db.query(`SELECT COUNT(*)::int AS n FROM cp.password_resets WHERE email = $1 AND created_at > NOW() - INTERVAL '1 hour'`, [email]);
    if (recent.rows[0].n >= PER_MAILBOX_HOUR) outcome = 'limit';
    const rec = outcome === 'sent' ? await getRecovery(email) : null;
    if (outcome === 'sent' && !rec) outcome = 'no-recovery';
    const ok = outcome === 'sent' ? await eligibility(email) : null;
    if (ok && ok.reason) outcome = ok.reason;
    if (outcome === 'sent') {
      const token = crypto.randomBytes(32).toString('base64url');
      await db.query(`UPDATE cp.password_resets SET used_at = NOW() WHERE email = $1 AND used_at IS NULL`, [email]); // older links stop working
      await db.query(`INSERT INTO cp.password_resets (email, token_hash, sent_to, ip, expires_at) VALUES ($1, $2, $3, $4, NOW() + make_interval(mins => $5))`,
        [email, sha256hex(token), rec.email, ip, TOKEN_TTL_MIN]);
      // In the language saved on the account, else the one of the page that asked.
      const pref = await db.query('SELECT lang FROM cp.user_prefs WHERE email = $1', [email]).then(r => r.rows[0] && r.rows[0].lang).catch(() => null);
      const m = MESSAGE[pref] || MESSAGE[lang] || MESSAGE.en;
      await sendMail({ to: rec.email, subject: m.subject, text: m.body(email, `${baseUrl()}/forgot#token=${token}`) });
    }
  } catch (e) {
    outcome = 'error';
    console.error('[password-reset] request:', e.message);
  }
  db.audit({ actor: email, action: 'recovery.link_requested', target: email, details: { outcome }, ip }).catch(() => {});
}

/* ——— Using a link ——— */
async function linkFor(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const r = await db.query('SELECT id, email FROM cp.password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()', [sha256hex(token)]);
  return r.rows[0] || null;
}
const expired = () => fail('This link has expired or was already used. Ask for a new one.', 400, { code: 'expired' });

async function reset(b, { ip }) {
  const link = await linkFor(b.token);
  if (!link) expired();
  const local = link.email.split('@')[0];
  const problem = signup.passwordProblem(b.password, { local });
  if (problem) fail(problem, 400, { code: 'password' });
  const ok = await eligibility(link.email);
  if (ok.reason) fail('Your password can’t be reset this way. Ask your administrator.', 403);

  // The link works once, even when two tabs send it at the same moment.
  const claim = await db.query('UPDATE cp.password_resets SET used_at = NOW() WHERE id = $1 AND used_at IS NULL AND expires_at > NOW() RETURNING id', [link.id]);
  if (!claim.rowCount) expired();
  try {
    const r = (await engineAdmin.call([['x:Account/set', { update: { [ok.a.id]: { credentials: { 0: { '@type': 'Password', secret: b.password } } } } }, 's']])).find(x => x[2] === 's');
    const refused = !r || r[0] === 'error' ? (r && r[1]) || {} : r[1].notUpdated && r[1].notUpdated[ok.a.id];
    if (refused) {
      const d = JSON.stringify(refused);
      if (/password is too weak|"secret"/i.test(d)) fail('This password is too easy to guess. Add another word or two.', 400, { code: 'password' });
      throw new Error('engine refused the new password: ' + d.replace(b.password, '***'));
    }
  } catch (e) {
    await db.query('UPDATE cp.password_resets SET used_at = NULL WHERE id = $1', [link.id]).catch(() => {}); // try again with the same link
    throw e;
  }
  await db.query('UPDATE cp.password_resets SET used_at = NOW() WHERE email = $1 AND used_at IS NULL', [link.email]).catch(() => {});
  await db.query('UPDATE cp.recovery SET verified_at = NOW() WHERE email = $1', [link.email]).catch(() => {});
  await sessions.destroySessionsFor(link.email).catch(e => console.error('[password-reset] sessions:', e.message));
  await security.forgetWebmailCredential(link.email).catch(e => console.error('[password-reset] webmail access:', e.message));
  db.audit({ actor: link.email, action: 'recovery.password_reset', target: link.email, ip }).catch(() => {});
  return { ok: true, email: link.email };
}

/* ——— HTTP ——— */
/** /recover-api/… — config, request, check, reset. */
async function handle(req, res, url, { readJson, sendJson, sendBodyError, isCrossSite, ip, lang }) {
  const route = req.method + ' ' + url.pathname;
  try {
    if (route === 'GET /recover-api/config') return sendJson(res, 200, { enabled: enabled(), minPassword: 12 });
    if (!enabled()) return sendJson(res, 403, { error: 'Password recovery is not open yet.' });
    if (req.method !== 'POST') return sendJson(res, 404, { error: 'Not found' });
    if (isCrossSite(req)) return sendJson(res, 403, { error: 'Forbidden' });
    let b;
    try { b = await readJson(req); } catch (e) { return sendBodyError(res, e); }
    if (!b || typeof b !== 'object' || Array.isArray(b)) fail('Invalid request');
    const net = signup.networkOf(ip);

    if (route === 'POST /recover-api/request') {
      if (signup.brake('reset-request:' + net, 10, 60 * 60e3)) fail('Too many requests. Please wait a few minutes and try again.', 429);
      const email = String(b.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email) || email.length > 254) fail('Enter your full IRON ID address, like name@iron-id.io.');
      setImmediate(() => sendLink(email, { ip, lang }));
      return sendJson(res, 200, { ok: true });
    }
    if (route === 'POST /recover-api/check') {
      if (signup.brake('reset-check:' + net, 30, 10 * 60e3)) fail('Too many requests. Please wait a few minutes and try again.', 429);
      const link = await linkFor(b.token);
      if (!link) expired();
      return sendJson(res, 200, { ok: true, email: link.email });
    }
    if (route === 'POST /recover-api/reset') {
      if (signup.brake('reset-use:' + net, 20, 10 * 60e3)) fail('Too many requests. Please wait a few minutes and try again.', 429);
      return sendJson(res, 200, await reset(b, { ip }));
    }
    return sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    if (e.userError) return sendJson(res, e.status || 400, { error: e.message, ...(e.code ? { code: e.code } : {}) });
    console.error('[password-reset] ' + route + ':', e.message);
    return sendJson(res, 502, { error: 'Mail engine is temporarily unavailable. Please try again shortly.' });
  }
}

module.exports = { handle, enabled, getRecovery, setRecovery, eligibility, ResetError, MESSAGE };
