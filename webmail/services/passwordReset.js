/**
 * "Forgot password?": a one-time link sent to the mailbox's recovery address (an address outside
 * IRON ID that the person saved in Settings → Security, or gave at sign-up).
 *
 * Off unless PASSWORD_RESET_ENABLED=true. It stays off in production until IRON ID's own mail server
 * sends mail to outside addresses (the VPS): before that, the link would not arrive or land in spam.
 *
 * Who can use it: ordinary mailboxes with a *confirmed* recovery address (the person typed a code
 * sent to it, while signed in). Not admins (cp.admins, PLATFORM_ADMINS),
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
 *   - after the reset, every browser and mail app of that mailbox is signed out;
 *   - the recovery address must be outside IRON ID (not the platform domain, not any domain hosted here,
 *     not any address of a mailbox or team here), so a stolen session alone can't reset the password;
 *   - links stop working when the recovery address changes, when the owner changes the password, and
 *     when an administrator resets the sign-in, suspends or deletes the mailbox; the owner's password
 *     change also asks to confirm the recovery address again, and an administrator's reset removes it;
 *   - the mailbox gets a notice when its recovery address changes or the password is reset by link.
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
const CODE_TTL_MIN = 15;       // confirmation code for the recovery address
const CODE_ATTEMPTS = 5;
const CODES_PER_HOUR = 5;
const KEEP_DAYS = 30;          // old link rows are deleted after this
// Tests only: one throwaway domain on the test engine may be used as a recovery address (listed in /healthz testFeatures).
const TEST_DOMAIN = String(process.env.IRONID_RECOVERY_TEST_DOMAIN || '').toLowerCase();
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
  const r = await db.query('SELECT recovery_email, verified_at, confirm_expires FROM cp.recovery WHERE email = $1', [String(email).toLowerCase()]);
  if (!r.rows.length) return null;
  const x = r.rows[0];
  return { email: x.recovery_email, verified: !!x.verified_at, codeSent: !x.verified_at && !!x.confirm_expires && new Date(x.confirm_expires) > new Date() };
}

/** Links not used yet stop working (address changed, password changed, admin action, mailbox deleted). */
async function cancelLinks(email) {
  await db.query('UPDATE cp.password_resets SET used_at = NOW() WHERE email = $1 AND used_at IS NULL', [String(email).toLowerCase()]);
}

/**
 * Why an address can't be a recovery address (null when it can). It must be outside IRON ID: not the
 * platform domain or any domain hosted here (or a sub-domain of one), and not any mailbox, team or alias
 * here — mail to those lands in a mailbox on this platform, so a stolen session could read the link.
 */
async function recoveryProblem(rec, me) {
  if (rec.length > 254 || !EMAIL_RE.test(rec)) return 'Enter a valid email address.';
  if (rec === me) return 'Use another address than this mailbox.';
  const domain = rec.split('@')[1];
  const OUTSIDE = 'Use an address outside IRON ID for recovery, so you can still reach it if you are locked out.';
  const suffixes = domain.split('.').map((_, i, all) => all.slice(i).join('.')).filter(d => d.includes('.'));
  if (suffixes.includes(DOMAIN)) return OUTSIDE;
  if (TEST_DOMAIN && domain === TEST_DOMAIN && TEST_DOMAIN !== DOMAIN) return null;
  // Every mailbox, team and alias here is on a domain of the engine, so the domains are enough.
  // Cached names first; a name not found there is checked against a fresh list (at most one engine read every 5 s).
  if ((await engineDomains(60000)).some(d => suffixes.includes(d))) return OUTSIDE;
  if ((await engineDomains(5000)).some(d => suffixes.includes(d))) return OUTSIDE;
  const claimed = await db.query('SELECT 1 FROM cp.customer_domains WHERE domain = ANY($1::text[]) LIMIT 1', [suffixes]);
  if (claimed.rows.length) return OUTSIDE;
  return null;
}
// The engine's domain names, re-read when older than maxAge (requests at the same moment share one read).
let engineDomainSet = new Set(), engineDomainsAt = 0, engineDomainsLoad = null;
async function engineDomains(maxAge) {
  if (Date.now() - engineDomainsAt < maxAge) return [...engineDomainSet];
  if (!engineDomainsLoad) {
    engineDomainsLoad = engineAdmin.call([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']]).then(r => {
      const d = r.find(x => x[2] === 'd');
      if (!d || d[0] === 'error') throw new Error('engine domains: ' + (d ? d[1].type : 'no answer'));
      engineDomainSet = new Set((d[1].list || []).map(x => String(x.name).toLowerCase()));
      engineDomainsAt = Date.now();
    }).finally(() => { engineDomainsLoad = null; });
  }
  await engineDomainsLoad;
  return [...engineDomainSet];
}

/**
 * Saves (or with '' removes) the recovery address. The caller has checked the password (and code).
 * A new address starts unconfirmed; links already sent stop working. Returns { recovery, previous }.
 */
async function setRecovery(email, value) {
  const me = String(email).toLowerCase();
  const rec = String(value || '').trim().toLowerCase();
  const previous = await getRecovery(me);
  if (!rec) {
    await db.query('DELETE FROM cp.recovery WHERE email = $1', [me]);
    await cancelLinks(me);
    return { recovery: null, previous };
  }
  const problem = await recoveryProblem(rec, me);
  if (problem) fail(problem, 400, { code: 'recovery' });
  await db.query(`INSERT INTO cp.recovery (email, recovery_email, verified_at, updated_at) VALUES ($1, $2, NULL, NOW())
                  ON CONFLICT (email) DO UPDATE SET recovery_email = EXCLUDED.recovery_email,
                    verified_at = CASE WHEN cp.recovery.recovery_email = EXCLUDED.recovery_email THEN cp.recovery.verified_at END,
                    confirm_hash = CASE WHEN cp.recovery.recovery_email = EXCLUDED.recovery_email THEN cp.recovery.confirm_hash END,
                    confirm_expires = CASE WHEN cp.recovery.recovery_email = EXCLUDED.recovery_email THEN cp.recovery.confirm_expires END,
                    updated_at = NOW()`,
    [me, rec]);
  if (!previous || previous.email !== rec) await cancelLinks(me);
  return { recovery: await getRecovery(me), previous };
}

/**
 * After the owner changes the password: links stop working and the recovery address must be confirmed
 * again (someone who knew the old password may have set it). Sending a new code needs the new password,
 * so a stolen session can't re-confirm it. If this fails, the address is removed (never left confirmed).
 */
async function afterPasswordChange(email) {
  const me = String(email).toLowerCase();
  try {
    await db.query(`WITH c AS (UPDATE cp.password_resets SET used_at = NOW() WHERE email = $1 AND used_at IS NULL)
                    UPDATE cp.recovery SET verified_at = NULL, confirm_hash = NULL, confirm_expires = NULL WHERE email = $1`, [me]);
  } catch (e) {
    console.error('[password-reset] after password change:', e.message);
    await db.query('DELETE FROM cp.recovery WHERE email = $1', [me]).catch(() => {});
    await cancelLinks(me).catch(() => {});
  }
  return !!(await getRecovery(me).catch(() => null));
}

/* ——— Confirming the recovery address: a 6-digit code sent to it, typed in Settings ——— */
// Keyed with the server secret, so a database copy alone can't be used to try all million codes.
const codeHash = (salt, email, rec, code) => salt + ':' + crypto.createHmac('sha256', 'recovery-code:' + String(process.env.ADMIN_TOKEN || ''))
  .update(`${salt}:${email}:${rec}:${code}`).digest('hex');

/** Sends a new confirmation code to the saved (unconfirmed) recovery address. The caller checked the password. */
async function sendCode(email, lang) {
  if (!enabled()) fail('Confirming a recovery address is not available yet.', 403);
  const me = String(email).toLowerCase();
  const TOO_MANY = 'Too many codes were sent. Please wait an hour and try again.';
  // Also counted in memory per mailbox, so removing and re-adding the address doesn't reset the count.
  if (signup.brake('recovery-code:' + me, CODES_PER_HOUR, 3600e3)) fail(TOO_MANY, 429);
  const row = (await db.query('SELECT recovery_email, verified_at FROM cp.recovery WHERE email = $1', [me])).rows[0];
  if (!row) fail('Save a recovery address first.');
  if (row.verified_at) fail('This recovery address is already confirmed.');
  const rec = row.recovery_email;
  const problem = await recoveryProblem(rec, me);
  if (problem) fail(problem, 400, { code: 'recovery' });
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const hash = codeHash(crypto.randomBytes(12).toString('base64url'), me, rec, code);
  // One statement: only for the same, still unconfirmed address, and only under the hourly limit.
  // "In the window" = a code was first sent less than an hour ago.
  const u = await db.query(`UPDATE cp.recovery SET confirm_hash = $2, confirm_expires = NOW() + make_interval(mins => $3), confirm_attempts = 0,
                              confirm_sends = CASE WHEN confirm_window > NOW() - INTERVAL '1 hour' THEN confirm_sends + 1 ELSE 1 END,
                              confirm_window = CASE WHEN confirm_window > NOW() - INTERVAL '1 hour' THEN confirm_window ELSE NOW() END
                            WHERE email = $1 AND recovery_email = $4 AND verified_at IS NULL
                              AND NOT (COALESCE(confirm_window > NOW() - INTERVAL '1 hour', false) AND confirm_sends >= $5)
                            RETURNING 1`, [me, hash, CODE_TTL_MIN, rec, CODES_PER_HOUR]);
  if (!u.rowCount) {
    const now = (await db.query('SELECT recovery_email, verified_at FROM cp.recovery WHERE email = $1', [me])).rows[0];
    if (now && now.recovery_email === rec && !now.verified_at) fail(TOO_MANY, 429);
    fail('Your recovery address changed meanwhile. Reload Settings and try again.', 409);
  }
  const m = CODE_MESSAGE[await prefLang(me, lang)];
  try {
    await sendMail({ to: rec, subject: m.subject, text: m.body(me, code) });
  } catch (e) {
    await db.query('UPDATE cp.recovery SET confirm_hash = NULL, confirm_expires = NULL WHERE email = $1 AND confirm_hash = $2', [me, hash]).catch(() => {});
    throw e;
  }
  return getRecovery(me);
}

/** Checks the typed code; on success the recovery address is confirmed. */
async function confirmCode(email, code) {
  const me = String(email).toLowerCase();
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) fail('Enter the 6-digit code from the message.', 400, { code: 'code' });
  const row = (await db.query('SELECT * FROM cp.recovery WHERE email = $1', [me])).rows[0];
  if (!row || row.verified_at) return getRecovery(me);
  const wrong = () => fail('That code is not right, or it has expired. Send a new one.', 400, { code: 'code' });
  if (!row.confirm_hash || !row.confirm_expires || new Date(row.confirm_expires) <= new Date()) wrong();
  // Count the attempt first, so parallel guesses can't get past the limit.
  const n = await db.query('UPDATE cp.recovery SET confirm_attempts = confirm_attempts + 1 WHERE email = $1 AND confirm_hash = $2 AND confirm_attempts < $3 RETURNING confirm_attempts',
    [me, row.confirm_hash, CODE_ATTEMPTS]);
  if (!n.rowCount) wrong();
  const salt = row.confirm_hash.split(':')[0];
  const expect = Buffer.from(row.confirm_hash), got = Buffer.from(codeHash(salt, me, row.recovery_email, c));
  if (expect.length !== got.length || !crypto.timingSafeEqual(expect, got)) wrong();
  await db.query('UPDATE cp.recovery SET verified_at = NOW(), confirm_hash = NULL, confirm_expires = NULL WHERE email = $1 AND recovery_email = $2', [me, row.recovery_email]);
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
const SENDER_DESCRIPTION = 'IRON ID (sends account messages; do not reply)';
let sender = null;        // { email, auth }
let senderLoading = null; // one set-up at a time
function senderAuth() {
  if (sender) return Promise.resolve(sender);
  if (!senderLoading) senderLoading = loadSender().finally(() => { senderLoading = null; });
  return senderLoading;
}
async function loadSender() {
  const email = `${SENDER}@${DOMAIN}`;
  const ctx = 'setting:' + SENDER_SETTING;
  let password = null;
  const stored = await db.getSetting(SENDER_SETTING).catch(() => null);
  if (stored) { try { password = box.decrypt(stored, ctx); } catch (e) { password = null; } }
  if (password) {
    const r = await security.engineRequest('GET', '/jmap/session', { headers: { authorization: security.basic(email, password) } });
    if (r.status === 200) return (sender = { email, auth: security.basic(email, password) });
    // Only a refused password leads to a new one; a busy or unreachable engine is just an error.
    if (r.status !== 401) throw new Error(`sending mailbox: engine answered HTTP ${r.status}`);
  }

  // First use (or the stored password was refused): create the mailbox, or give it a new password.
  password = crypto.randomBytes(24).toString('base64url');
  const dir = await adminConsole.engineDirectory();
  const existing = dir.accounts.find(x => x.email === email);
  const credentials = { 0: { '@type': 'Password', secret: password } };
  if (existing) {
    // Only a mailbox the gateway made itself (its description) is taken over; never a person's or an admin's.
    const isAdminRow = (await db.query('SELECT 1 FROM cp.admins WHERE lower(email) = $1', [email])).rows.length > 0;
    if (existing['@type'] !== 'User' || (existing.roles && existing.roles['@type'] && existing.roles['@type'] !== 'User') ||
        existing.description !== SENDER_DESCRIPTION || isAdminRow) {
      throw new Error(`${email} already exists and was not made by the gateway; it can't be used to send account messages`);
    }
    await adminConsole.engineSet('Account', { update: { [existing.id]: { credentials } } }, 'set up the sending mailbox');
  } else {
    const d = dir.domainByName.get(DOMAIN);
    if (!d) throw new Error('platform domain not found in the engine');
    await adminConsole.engineSet('Account', { create: { u: {
      '@type': 'User', name: SENDER, domainId: d.id, description: SENDER_DESCRIPTION,
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
  const boxes = security.first(got, 'm').list || [];
  const drafts = boxes.find(b => b.role === 'drafts');
  if (!drafts) throw new Error('sending mailbox: no drafts folder');
  await emptySenderMailbox(s.auth, accountId, boxes).catch(e => console.error('[password-reset] clean sending mailbox:', e.message));
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
  if (!made.created || !made.created.s) {
    // Don't leave the message (with its link or code) in the sending mailbox.
    const draft = security.first(r, 'e').created;
    if (draft && draft.m) await security.jmap(s.auth, [['Email/set', { accountId, destroy: [draft.m.id] }, 'd']], MAIL_USING).catch(() => {});
    const why = Object.values(made.notCreated || {}).map(x => x && x.type).filter(Boolean).join(', ');
    throw new Error('send refused' + (why ? ': ' + why : ''));
  }
}

/** Mail sent *to* no-reply@ (replies, bounces, spam) is deleted, so it never fills the mailbox and stops account messages. */
async function emptySenderMailbox(auth, accountId, boxes) {
  const keep = new Set(boxes.filter(b => b.role === 'drafts').map(b => b.id));
  const others = boxes.filter(b => !keep.has(b.id)).map(b => b.id);
  if (!others.length) return;
  const q = security.first(await security.jmap(auth, [['Email/query', { accountId, filter: { inMailboxOtherThan: [...keep] }, limit: 500 }, 'q']], MAIL_USING), 'q');
  if (q.ids && q.ids.length) await security.jmap(auth, [['Email/set', { accountId, destroy: q.ids }, 'x']], MAIL_USING);
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

const CODE_MESSAGE = {
  en: {
    subject: 'Confirm your IRON ID recovery address',
    body: (email, code) => `Hello,

This address was added as the recovery address of the IRON ID mailbox ${email}.

To confirm it, type this code in Settings → Security (it works for ${CODE_TTL_MIN} minutes):

${code}

If you don't know this mailbox, ignore this message: the address stays unconfirmed and no password link will be sent here.

The IRON ID team`
  },
  fr: {
    subject: 'Confirmez votre adresse de récupération IRON ID',
    body: (email, code) => `Bonjour,

Cette adresse a été ajoutée comme adresse de récupération de la boîte mail IRON ID ${email}.

Pour la confirmer, saisissez ce code dans Paramètres → Sécurité (il est valable ${CODE_TTL_MIN} minutes) :

${code}

Si vous ne connaissez pas cette boîte mail, ignorez ce message : l’adresse reste non confirmée et aucun lien de mot de passe ne sera envoyé ici.

L’équipe IRON ID`
  }
};

// Notices put straight into the mailbox (no outgoing mail needed) and, for changes, to the previous recovery address.
const NOTICE = {
  en: {
    set: { subject: 'Your recovery address was changed', body: (email, x) => `Hello,

The recovery address of ${email} is now ${x.to}${x.from ? ` (it was ${x.from})` : ''}.

If you didn't make this change, someone else knows your password: change it now in Settings → Security, then check the recovery address there.

The IRON ID team` },
    removed: { subject: 'Your recovery address was removed', body: (email, x) => `Hello,

The recovery address of ${email}${x.from ? ` (${x.from})` : ''} was removed. "Forgot your password?" can't send you a link until you add one again in Settings → Security.

If you didn't make this change, change your password now.

The IRON ID team` },
    reset: { subject: 'Your password was reset', body: (email, x) => `Hello,

The password of ${email} was changed with a link sent to ${x.to}. Every browser and mail app was signed out.

If this wasn't you, contact your administrator or IRON ID support now.

The IRON ID team` },
    old: { subject: 'Your IRON ID recovery address was changed', body: email => `Hello,

This address is no longer the recovery address of the IRON ID mailbox ${email}.

If the owner of that mailbox didn't make this change, they should contact IRON ID support.

The IRON ID team` }
  },
  fr: {
    set: { subject: 'Votre adresse de récupération a été modifiée', body: (email, x) => `Bonjour,

L’adresse de récupération de ${email} est désormais ${x.to}${x.from ? ` (auparavant ${x.from})` : ''}.

Si vous n’êtes pas à l’origine de ce changement, quelqu’un d’autre connaît votre mot de passe : changez-le maintenant dans Paramètres → Sécurité, puis vérifiez l’adresse de récupération.

L’équipe IRON ID` },
    removed: { subject: 'Votre adresse de récupération a été supprimée', body: (email, x) => `Bonjour,

L’adresse de récupération de ${email}${x.from ? ` (${x.from})` : ''} a été supprimée. « Mot de passe oublié ? » ne pourra pas vous envoyer de lien tant que vous n’en aurez pas ajouté une dans Paramètres → Sécurité.

Si vous n’êtes pas à l’origine de ce changement, changez votre mot de passe maintenant.

L’équipe IRON ID` },
    reset: { subject: 'Votre mot de passe a été réinitialisé', body: (email, x) => `Bonjour,

Le mot de passe de ${email} a été changé grâce à un lien envoyé à ${x.to}. Tous les navigateurs et applications de messagerie ont été déconnectés.

Si ce n’était pas vous, contactez votre administrateur ou le support IRON ID dès maintenant.

L’équipe IRON ID` },
    old: { subject: 'Votre adresse de récupération IRON ID a changé', body: email => `Bonjour,

Cette adresse n’est plus l’adresse de récupération de la boîte mail IRON ID ${email}.

Si le titulaire de cette boîte n’est pas à l’origine de ce changement, il doit contacter le support IRON ID.

L’équipe IRON ID` }
  }
};

async function prefLang(email, fallback) {
  const pref = await db.query('SELECT lang FROM cp.user_prefs WHERE email = $1', [email]).then(r => r.rows[0] && r.rows[0].lang).catch(() => null);
  return MESSAGE[pref] ? pref : MESSAGE[fallback] ? fallback : 'en';
}

/** Puts a notice in the mailbox's inbox with the mailbox's own access (works without outgoing mail). */
async function noticeToMailbox(auth, email, kind, data, lang) {
  try {
    const n = NOTICE[await prefLang(email, lang)][kind];
    const session = await security.engineSession(auth);
    const accountId = session && session.primaryAccounts && session.primaryAccounts['urn:ietf:params:jmap:mail'];
    if (!accountId) return;
    const MAIL = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];
    const boxes = security.first(await security.jmap(auth, [['Mailbox/get', { accountId, properties: ['role'] }, 'm']], MAIL), 'm').list || [];
    const inbox = boxes.find(b => b.role === 'inbox');
    if (!inbox) return;
    await security.jmap(auth, [['Email/set', { accountId, create: { n: {
      mailboxIds: { [inbox.id]: true }, keywords: {}, from: [{ name: 'IRON ID', email: `${SENDER}@${DOMAIN}` }], to: [{ email }],
      subject: n.subject, receivedAt: new Date().toISOString(),
      textBody: [{ partId: 't', type: 'text/plain' }], bodyValues: { t: { value: n.body(email, data || {}) } }
    } } }, 's']], MAIL);
  } catch (e) { console.error('[password-reset] notice:', e.message); }
}

/** After the owner changed the recovery address: a notice in the mailbox, and one to the previous confirmed address. */
async function recoveryChanged(auth, email, { recovery, previous }, lang) {
  const me = String(email).toLowerCase();
  if (previous && recovery && previous.email === recovery.email) return;
  await noticeToMailbox(auth, me, recovery ? 'set' : 'removed', { to: recovery && recovery.email, from: previous && previous.email }, lang);
  if (previous && previous.verified && enabled()) {
    const n = NOTICE[await prefLang(me, lang)].old;
    await sendMail({ to: previous.email, subject: n.subject, text: n.body(me) }).catch(e => console.error('[password-reset] notice to the previous address:', e.message));
  }
}

/* ——— Asking for a link ——— */
/** Does the work behind POST /recover-api/request. Never throws; the requester always gets the same answer. */
async function sendLink(email, { ip, lang }) {
  let outcome = 'sent', token = null, rec = null;
  try {
    rec = await getRecovery(email);
    if (!rec) outcome = 'no-recovery';
    else if (!rec.verified) outcome = 'not-confirmed';
    else if (await recoveryProblem(rec.email, email)) outcome = 'recovery-inside';
    if (outcome === 'sent') { const ok = await eligibility(email); if (ok.reason) outcome = ok.reason; }
    if (outcome === 'sent') {
      // Count, cancel older links and add the new one in one step per mailbox, so requests arriving
      // together can't pass the limit or leave two links working.
      const client = await db.getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['password-reset:' + email]);
        const recent = await client.query(`SELECT COUNT(*)::int AS n FROM cp.password_resets WHERE email = $1 AND created_at > NOW() - INTERVAL '1 hour'`, [email]);
        if (recent.rows[0].n >= PER_MAILBOX_HOUR) outcome = 'limit';
        else {
          token = crypto.randomBytes(32).toString('base64url');
          await client.query('UPDATE cp.password_resets SET used_at = NOW() WHERE email = $1 AND used_at IS NULL', [email]);
          await client.query(`INSERT INTO cp.password_resets (email, token_hash, sent_to, ip, expires_at) VALUES ($1, $2, $3, $4, NOW() + make_interval(mins => $5))`,
            [email, sha256hex(token), rec.email, ip, TOKEN_TTL_MIN]);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    }
    if (outcome === 'sent') {
      // In the language saved on the account, else the one of the page that asked.
      const m = MESSAGE[await prefLang(email, lang)];
      await sendMail({ to: rec.email, subject: m.subject, text: m.body(email, `${baseUrl()}/forgot#token=${token}`) });
    }
  } catch (e) {
    outcome = 'error';
    console.error('[password-reset] request:', e.message);
    // A link that may not have arrived must not stay usable.
    if (token) await db.query('UPDATE cp.password_resets SET used_at = NOW() WHERE token_hash = $1', [sha256hex(token)]).catch(() => {});
  }
  // Addresses that aren't mailboxes here are not written to the log (anyone can type anything).
  const known = !['unknown', 'no-recovery'].includes(outcome);
  db.audit({ actor: 'forgot-password page', action: 'recovery.link_requested', target: known ? email : null, details: { outcome }, ip }).catch(() => {});
}

/* ——— Using a link ——— */
async function linkFor(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const r = await db.query('SELECT id, email, sent_to FROM cp.password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()', [sha256hex(token)]);
  return r.rows[0] || null;
}
const expired = () => fail('This link has expired or was already used. Ask for a new one.', 400, { code: 'expired' });

async function reset(b, { ip }) {
  const link = await linkFor(b.token);
  if (!link) expired();
  if (typeof b.password !== 'string') fail('Enter a new password.', 400, { code: 'password' });
  const local = link.email.split('@')[0];
  const problem = signup.passwordProblem(b.password, { local });
  if (problem) fail(problem, 400, { code: 'password' });
  const ok = await eligibility(link.email);
  if (ok.reason) fail('Your password can’t be reset this way. Ask your administrator.', 403);
  // The link must have gone to the recovery address that is confirmed now.
  const rec = await getRecovery(link.email);
  if (!rec || !rec.verified || rec.email !== link.sent_to) expired();

  // The link works once, even when two tabs send it at the same moment.
  const claim = await db.query(`UPDATE cp.password_resets p SET used_at = NOW() FROM cp.recovery r
                                 WHERE p.id = $1 AND p.used_at IS NULL AND p.expires_at > NOW() AND r.email = p.email
                                   AND r.recovery_email = p.sent_to AND r.verified_at IS NOT NULL AND r.verified_at <= p.created_at
                                 RETURNING p.id`, [link.id]);
  if (!claim.rowCount) expired();
  const r = (await engineAdmin.call([['x:Account/set', { update: { [ok.a.id]: { credentials: { 0: { '@type': 'Password', secret: b.password } } } } }, 's']])).find(x => x[2] === 's');
  const refused = !r || r[0] === 'error' ? (r && r[1]) || {} : r[1].notUpdated && r[1].notUpdated[ok.a.id];
  if (refused) {
    if (/password is too weak/i.test(String(refused.description || '')) || (refused.properties || []).includes('secret')) {
      // The engine refused this password only: the same link can be used again — unless a newer link exists.
      await db.query(`UPDATE cp.password_resets SET used_at = NULL WHERE id = $1 AND expires_at > NOW()
                        AND NOT EXISTS (SELECT 1 FROM cp.password_resets n WHERE n.email = $2 AND n.id > $1)`, [link.id, link.email]).catch(() => {});
      fail('This password is too easy to guess. Add another word or two.', 400, { code: 'password' });
    }
    // Never log the engine's text: it could hold the password.
    throw new Error('engine refused the new password: ' + String(refused.type || 'unknown'));
  }
  await db.query('UPDATE cp.password_resets SET used_at = NOW() WHERE email = $1 AND used_at IS NULL', [link.email]).catch(() => {});
  await sessions.destroySessionsFor(link.email).catch(e => console.error('[password-reset] sessions:', e.message));
  await security.forgetWebmailCredential(link.email).catch(e => console.error('[password-reset] webmail access:', e.message));
  db.audit({ actor: link.email, action: 'recovery.password_reset', target: link.email, ip }).catch(() => {});
  // A notice in the mailbox itself (local delivery from no-reply@, the same way the link was sent).
  const n = NOTICE[await prefLang(link.email)].reset;
  await sendMail({ to: link.email, subject: n.subject, text: n.body(link.email, { to: link.sent_to }) })
    .catch(e => console.error('[password-reset] notice after reset:', e.message));
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
    // Requests for links: IPv6 counted per /48 (one site), so many /64s can't each get their own allowance.
    const site = net.endsWith('::/64') ? net.split(':').slice(0, 3).join(':') + '::/48' : net;

    if (route === 'POST /recover-api/request') {
      if (signup.brake('reset-request:' + site, 10, 60 * 60e3)) fail('Too many requests. Please wait a few minutes and try again.', 429);
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

/** Deletes old link rows (they hold the address mail was sent to and the asking network). */
async function prune() {
  try {
    await db.query('DELETE FROM cp.password_resets WHERE created_at < NOW() - make_interval(days => $1)', [KEEP_DAYS]);
  } catch (e) { console.error('[password-reset] clean-up:', e.message); }
}

module.exports = { handle, enabled, getRecovery, setRecovery, recoveryProblem, afterPasswordChange, cancelLinks,
  sendCode, confirmCode, recoveryChanged, prune, eligibility, ResetError, MESSAGE, CODE_MESSAGE, NOTICE, TEST_DOMAIN };
