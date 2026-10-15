/**
 * Sign-up: anyone can create a personal mailbox name@<platform domain> (iron-id.io).
 *
 * Off unless SIGNUP_ENABLED=true. It stays off in production until IRON ID's own mail server
 * receives the platform domain's mail (the VPS and the MX move): before that, mail from outside
 * would not reach new addresses.
 *
 * Protections, all on IRON ID's own server (no outside service, no tracking):
 *   - a proof-of-work puzzle the browser solves (instead of a CAPTCHA): each account costs the
 *     sender CPU time; a puzzle works once and expires;
 *   - limits per IP address and per day (SIGNUP_PER_IP_DAY, default 3; SIGNUP_PER_DAY, default 200);
 *   - reserved names (postmaster, abuse, admin, support…) and names already in use, aliases included;
 *   - passwords: 12+ characters, not in a list of ~47,000 common long passwords, not the person's name
 *     or address.
 * Settings (cp.settings): signup.quota_mb (storage per new mailbox, default 5120 = 5 GB) and
 * signup.external_daily_limit (messages a day to outside addresses for new accounts; recorded now,
 * enforced when outgoing mail moves to the VPS).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const db = require('./db');
const engineAdmin = require('./engineAdmin');
const security = require('./accountSecurity');
const adminConsole = require('./adminConsole');

const DOMAIN = adminConsole.PLATFORM_DOMAIN;
const TERMS_VERSION = '2026-10-draft';
const MB = 1024 * 1024;
const FREE_QUOTA_MB = 5120; // the free personal mailbox: 5 GB, shared with addresses on own domains

class SignupError extends Error {
  constructor(message, status = 400, extra = {}) { super(message); this.status = status; this.userError = true; Object.assign(this, extra); }
}
const fail = (msg, status, extra) => { throw new SignupError(msg, status, extra); };

const enabled = () => process.env.SIGNUP_ENABLED === 'true' && !!process.env.ADMIN_TOKEN;
const intEnv = (name, def) => { const n = parseInt(process.env[name], 10); return Number.isFinite(n) && n >= 0 ? n : def; };

/* ——— Names ——— */
// Names that belong to the platform, its staff or mail standards (RFC 2142), or that invite impersonation.
const RESERVED = new Set(`
  abuse admin administrator administrators billing compliance contact dmarc dns docs ftp help helpdesk hostmaster
  hr info ironid iron-id iron.id it legal mail mailer-daemon mailerdaemon marketing media news newsletter no-reply
  noc noreply notifications office owner payments postmaster press privacy root sales security service staff
  support sysadmin system team tech test uucp webmaster www accounts account billing-team ceo cto director
  official moderator report reports spam unsubscribe usenet verification verify welcome hello
`.split(/\s+/).filter(Boolean));
// Words refused anywhere in a name (after removing . _ - and reading 0/1/3/4/5/7 as o/i/e/a/s/t):
// they would let someone pass for IRON ID staff or a system address.
const STRONG = ['admin', 'postmaster', 'hostmaster', 'webmaster', 'abuse', 'ironid', 'noreply', 'donotreply',
  'mailerdaemon', 'daemon', 'helpdesk', 'support', 'security', 'billing', 'official', 'moderator', 'sysadmin',
  'gateway', 'staff', 'root', 'contactus'];
const LOCAL_RE = /^[a-z0-9][a-z0-9._-]{2,28}[a-z0-9]$/;
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't' };

/** Why a name can't be used, or null. Does not look at whether it is taken. */
function nameProblem(local) {
  if (!LOCAL_RE.test(local) || /[._-]{2}/.test(local) || /^\d+$/.test(local)) return 'format';
  const squash = local.replace(/[._-]/g, '');
  const base = squash.replace(/\d+$/, '');
  const look = squash.replace(/[013457]/g, d => LEET[d]);
  if (RESERVED.has(local) || RESERVED.has(squash) || RESERVED.has(base) || STRONG.some(w => squash.includes(w) || look.includes(w))) return 'reserved';
  return null;
}

// Addresses that hold admin rights (cp.admins, PLATFORM_ADMINS) are never given out, even when no
// mailbox exists for them: whoever owns that address would get the admin console.
async function adminAddresses() {
  const set = new Set(String(process.env.PLATFORM_ADMINS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
  try { for (const r of (await db.query('SELECT lower(email) AS email FROM cp.admins')).rows) set.add(r.email); } catch (e) { /* table missing: env only */ }
  return set;
}

// Addresses in use on the platform domain (mailboxes, teams, aliases), cached briefly for the live check.
let taken = { at: 0, set: null };
async function takenAddresses({ fresh = false } = {}) {
  if (!fresh && taken.set && Date.now() - taken.at < 20000) return taken.set;
  const dir = await adminConsole.engineDirectory();
  const set = new Set();
  for (const a of dir.accounts) {
    if (a.domain === DOMAIN) set.add(a.email);
    for (const x of adminConsole.aliasEmails(a, dir.domainById)) set.add(x);
  }
  taken = { at: Date.now(), set };
  return set;
}

function suggestions(local, first, last, used) {
  const clean = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  const f = clean(first), l = clean(last), base = clean(local) || f || 'name';
  const year = new Date().getFullYear();
  const ideas = [f && l && `${f}.${l}`, f && l && `${f[0]}.${l}`, f && l && `${l}.${f}`, f && l && `${f}${l}`, `${base}.${year}`, `${base}${crypto.randomInt(10, 100)}`];
  return [...new Set(ideas.filter(Boolean))].filter(x => !nameProblem(x) && !used.has(`${x}@${DOMAIN}`)).slice(0, 3);
}

/** Live check while typing: { available, reason?, suggestions? } — reason: format | reserved | taken. */
async function check(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) fail('Invalid request');
  const local = String(b.local || '').trim().toLowerCase();
  const problem = nameProblem(local);
  const used = await takenAddresses();
  if (!problem && (await adminAddresses()).has(`${local}@${DOMAIN}`)) return { available: false, reason: 'reserved', suggestions: suggestions(local, b.first, b.last, used) };
  if (problem) return { available: false, reason: problem, suggestions: problem === 'reserved' ? suggestions(local, b.first, b.last, used) : [] };
  if (used.has(`${local}@${DOMAIN}`)) return { available: false, reason: 'taken', suggestions: suggestions(local, b.first, b.last, used) };
  return { available: true, email: `${local}@${DOMAIN}` };
}

/* ——— Passwords ——— */
let common = null;
function commonPasswords() {
  if (!common) {
    const file = path.join(__dirname, '..', 'data', 'common-passwords-12plus.txt.gz');
    try {
      common = new Set(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').split('\n').filter(l => l && !l.startsWith('#')));
    } catch (e) {
      console.error('[signup] common password list missing:', e.message);
      common = new Set();
    }
  }
  return common;
}

/** Why a new password is not acceptable, or null. */
function passwordProblem(pw, { local = '', first = '', last = '' } = {}) {
  if (typeof pw !== 'string' || pw.length < 12) return 'Use at least 12 characters for your password.';
  if (pw.length > 128) return 'Use at most 128 characters for your password.';
  const lower = pw.toLowerCase();
  if (/^(.)\1+$/.test(pw) || new Set(pw).size < 5) return 'This password is too simple. A short sentence works well.';
  if (commonPasswords().has(lower)) return 'This password is too common. Choose another one.';
  const parts = [local, ...String(local).split(/[._-]/), first, last].map(x => String(x || '').toLowerCase()).filter(x => x.length >= 4);
  if (parts.some(x => lower.includes(x)) || lower.includes('ironid') || lower.includes('iron-id')) return 'Don’t use your name or your address in your password.';
  return null;
}

if (enabled()) setImmediate(() => commonPasswords());

/* ——— Proof of work (ALTCHA-style, verified here) ——— */
const POW_MAX = intEnv('SIGNUP_POW_MAX', 300000); // average ~150,000 SHA-256 in the browser (well under a second)
const POW_TTL_S = 20 * 60;
let powKey = null;
function hmacKey() {
  if (!powKey) powKey = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(process.env.ADMIN_TOKEN || ''), Buffer.from('iron-id-cp'), Buffer.from('signup-pow-v1'), 32));
  return powKey;
}
const sha256hex = s => crypto.createHash('sha256').update(s).digest('hex');
const sign = s => crypto.createHmac('sha256', hmacKey()).update(s).digest('hex');

function challenge() {
  const number = crypto.randomInt(0, POW_MAX + 1);
  const salt = crypto.randomBytes(12).toString('hex') + '?expires=' + (Math.floor(Date.now() / 1000) + POW_TTL_S);
  const c = sha256hex(salt + number);
  return { algorithm: 'SHA-256', challenge: c, salt, signature: sign(c), maxnumber: POW_MAX };
}

/** Checks a solved puzzle and uses it up. Throws if it is wrong, expired or already used. */
async function usePuzzle(p) {
  const bad = () => fail('The security check did not work. Please run it again.', 400, { code: 'pow' });
  if (!p || typeof p !== 'object') bad();
  const { salt, challenge: c, signature, number } = p;
  if (typeof salt !== 'string' || typeof c !== 'string' || typeof signature !== 'string' || !Number.isInteger(number) || number < 0 || number > POW_MAX) bad();
  if (!/^[0-9a-f]{64}$/.test(c) || !/^[0-9a-f]{64}$/.test(signature) || salt.length > 100) bad();
  const exp = Number((/\?expires=(\d+)$/.exec(salt) || [])[1]);
  if (!exp || exp < Date.now() / 1000) bad();
  if (!crypto.timingSafeEqual(Buffer.from(sign(c), 'hex'), Buffer.from(signature, 'hex'))) bad();
  if (sha256hex(salt + number) !== c) bad();
  db.query("DELETE FROM cp.signup_puzzles WHERE used_at < NOW() - INTERVAL '1 hour'").catch(() => {});
  const r = await db.query('INSERT INTO cp.signup_puzzles (challenge) VALUES ($1) ON CONFLICT DO NOTHING', [c]);
  if (!r.rowCount) bad(); // used before
}

/* ——— Request brakes ——— */
/** The network a request comes from: the IPv4 address, or the /64 of an IPv6 address (one home or server). */
function networkOf(ip) {
  let a = String(ip || '').toLowerCase().replace(/^::ffff:(?=\d+\.)/, '');
  if (!a.includes(':')) return a;
  a = a.split('%')[0];
  const [head, tail = ''] = a.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const full = a.includes('::') ? h.concat(Array(Math.max(0, 8 - h.length - t.length)).fill('0'), t) : h;
  return full.slice(0, 4).map(x => x.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
const hits = new Map(); // key -> [timestamps], oldest keys first
const MAX_KEYS = 20000;
function brake(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (list.length >= max) return true;
  list.push(now);
  hits.delete(key);
  hits.set(key, list);
  if (hits.size > MAX_KEYS) { // forget the least recently seen networks
    let n = hits.size - MAX_KEYS;
    for (const k of hits.keys()) { if (n-- <= 0) break; hits.delete(k); }
  }
  return false;
}
const slowDown = () => fail('Too many requests. Please wait a few minutes and try again.', 429);

/* ——— Settings set by IRON ID later (empty = none) ——— */
async function setting(key) {
  try {
    const r = await db.query('SELECT value FROM cp.settings WHERE key = $1', [key]);
    const n = r.rows.length ? parseInt(r.rows[0].value, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (e) { return null; }
}

/* ——— Welcome message, delivered straight into the new inbox ——— */
const WELCOME = {
  en: {
    subject: 'Welcome to IRON ID Mail',
    body: (first, email) => `Hello ${first},

Your new address is ${email}. Three things to do first:

1. Turn on two-step sign-in: Settings → Security. It protects your account even if your password leaks.
2. Mail on your phone or in Outlook: Settings → Security → App passwords.
3. Have your own domain, like company.dz? Connecting it from the webmail is coming soon, so you can use addresses such as contact@company.dz in this same inbox.

You can change the language at any time in Settings → Preferences.

The IRON ID team`
  },
  fr: {
    subject: 'Bienvenue sur IRON ID Mail',
    body: (first, email) => `Bonjour ${first},

Votre nouvelle adresse est ${email}. Trois choses à faire pour commencer :

1. Activez la validation en deux étapes : Paramètres → Sécurité. Elle protège votre compte même si votre mot de passe fuite.
2. Vos e-mails sur votre téléphone ou dans Outlook : Paramètres → Sécurité → Mots de passe d’application.
3. Vous avez votre propre domaine, comme entreprise.dz ? Il sera bientôt possible de le connecter depuis la messagerie web, pour utiliser des adresses comme contact@entreprise.dz dans cette même boîte de réception.

Vous pouvez changer de langue à tout moment dans Paramètres → Préférences.

L’équipe IRON ID`
  }
};

async function deliverWelcome(auth, session, { first, email, lang }) {
  const MAIL = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];
  const accountId = session.primaryAccounts && session.primaryAccounts['urn:ietf:params:jmap:mail'];
  if (!accountId) return;
  const call = calls => security.jmap(auth, calls, MAIL);
  const boxes = security.first(await call([['Mailbox/get', { accountId, properties: ['role'] }, 'm']]), 'm').list || [];
  const inbox = boxes.find(b => b.role === 'inbox');
  if (!inbox) return;
  const w = WELCOME[lang] || WELCOME.en;
  const r = await call([['Email/set', { accountId, create: { w: {
    mailboxIds: { [inbox.id]: true }, keywords: {},
    from: [{ name: 'IRON ID', email: 'hello@' + DOMAIN }], to: [{ name: first, email }],
    subject: w.subject, receivedAt: new Date().toISOString(),
    textBody: [{ partId: 't', type: 'text/plain' }], bodyValues: { t: { value: w.body(first, email) } }
  } } }, 's']]);
  const res = security.first(r, 's');
  if (!res.created || !res.created.w) console.error('[signup] welcome message not created:', JSON.stringify(res.notCreated || {}));
}

/* ——— Create ——— */
const cleanName = v => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
const EMAIL_RE = /^[^\s@<>"]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/**
 * Creates the mailbox and signs the person in. Returns { email, auth, session } for the caller
 * to open the webmail session (as /auth/login does).
 */
async function create(b, { ip, lang }) {
  if (!enabled()) fail('Sign-up is not open yet.', 403);
  if (!b || typeof b !== 'object' || Array.isArray(b)) fail('Invalid request');
  const net = networkOf(ip);
  if (brake('create:' + net, 10, 10 * 60e3)) slowDown();
  const first = cleanName(b.first), last = cleanName(b.last);
  const local = String(b.local || '').trim().toLowerCase();
  const password = typeof b.password === 'string' ? b.password : '';
  const recovery = String(b.recovery || '').trim().toLowerCase();
  if (!first) fail('Enter your first name.', 400, { code: 'name' });
  const problem = nameProblem(local);
  if (problem === 'format') fail('Use 4 to 30 letters, numbers, dots, dashes or underscores for your address.', 400, { code: 'address' });
  if (problem === 'reserved') fail('That address is reserved. Choose another one.', 400, { code: 'address' });
  const pw = passwordProblem(password, { local, first, last });
  if (pw) fail(pw, 400, { code: 'password' });
  if (recovery && (!EMAIL_RE.test(recovery) || recovery.length > 254)) fail('Enter a valid recovery email address, or leave it empty.', 400, { code: 'recovery' });
  if (recovery && recovery.endsWith('@' + DOMAIN)) fail('Use an address outside IRON ID for recovery, so you can still reach it if you are locked out.', 400, { code: 'recovery' });
  if (b.acceptTerms !== true) fail('Please accept the Terms of Service to continue.');
  const email = `${local}@${DOMAIN}`;
  if ((await adminAddresses()).has(email)) fail('That address is reserved. Choose another one.', 400, { code: 'address' });
  await usePuzzle(b.pow);
  if ((await takenAddresses({ fresh: true })).has(email)) fail('That address was just taken. Choose another one.', 409, { code: 'taken' });

  // Limits per network and per day, counted and reserved in one step (a lock makes parallel
  // requests wait their turn), so they hold even if many requests arrive at once.
  const reservation = await reserve({ email, ip, net, lang });
  try {
    return await createAccount({ email, local, first, last, password, recovery, lang, ip }, reservation);
  } catch (e) {
    if (!e.accountCreated) await db.query('DELETE FROM cp.signup_log WHERE id = $1', [reservation]).catch(() => {});
    throw e;
  }
}

async function reserve({ email, ip, net, lang }) {
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('iron-id-signup'))");
    const c = (await client.query(`SELECT COUNT(*) FILTER (WHERE network = $1) AS net, COUNT(*) AS total
                                     FROM cp.signup_log WHERE created_at > NOW() - INTERVAL '1 day'`, [net])).rows[0];
    if (Number(c.net) >= intEnv('SIGNUP_PER_IP_DAY', 3)) fail('Too many accounts were created from this network today. Please try again tomorrow.', 429);
    if (Number(c.total) >= intEnv('SIGNUP_PER_DAY', 200)) fail('Sign-up is busy right now. Please try again later.', 429);
    const r = await client.query(`INSERT INTO cp.signup_log (email, ip, network, terms_version, lang, external_daily_limit, status)
                                  VALUES ($1, $2, $3, $4, $5, $6, 'pending') RETURNING id`,
      [email, ip, net, TERMS_VERSION, lang, await setting('signup.external_daily_limit')]);
    await client.query('COMMIT');
    return r.rows[0].id;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function createAccount({ email, local, first, last, password, recovery, lang, ip }, reservation) {
  const dom = (await engineAdmin.call([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']]))
    .find(x => x[2] === 'd');
  const domainRec = dom && dom[0] !== 'error' && (dom[1].list || []).find(d => d.name.toLowerCase() === DOMAIN);
  if (!domainRec) throw new Error('platform domain not found in the engine');
  const quotaMb = (await setting('signup.quota_mb')) || FREE_QUOTA_MB;
  const r = (await engineAdmin.call([['x:Account/set', { create: { u: {
    '@type': 'User', name: local, domainId: domainRec.id, description: [first, last].filter(Boolean).join(' '),
    roles: { '@type': 'User' }, permissions: { '@type': 'Inherit' }, encryptionAtRest: { '@type': 'Disabled' },
    quotas: quotaMb ? { maxDiskQuota: quotaMb * MB } : {},
    credentials: { 0: { '@type': 'Password', secret: password } }
  } } }, 's']])).find(x => x[2] === 's');
  if (!r || r[0] === 'error') throw new Error('account create: ' + JSON.stringify(r && r[1]));
  if (!r[1].created || !r[1].created.u) {
    const d = JSON.stringify(r[1].notCreated || {});
    if (/already exists|primaryKey|duplicate|in use/i.test(d)) { taken.at = 0; fail('That address was just taken. Choose another one.', 409, { code: 'taken' }); }
    // The engine also judges password strength (repeats, common words…).
    if (/password is too weak|"secret"/i.test(d)) fail('This password is too easy to guess. Add another word or two.', 400, { code: 'password' });
    throw new Error('account create refused: ' + d);
  }
  taken.at = 0;

  // From here the mailbox exists: problems below are logged, never reported as a failed sign-up.
  const note = (what, e) => console.error(`[signup] ${email}: ${what}:`, e.message);
  await db.query("UPDATE cp.signup_log SET status = 'created' WHERE id = $1", [reservation]).catch(e => note('log', e));
  // A reused address must not keep an earlier owner's recovery address or choices.
  await db.query('DELETE FROM cp.recovery WHERE email = $1', [email]).catch(e => note('recovery', e));
  await db.query('DELETE FROM cp.labels WHERE email = $1', [email]).catch(e => note('labels', e));
  if (recovery) {
    await db.query('INSERT INTO cp.recovery (email, recovery_email) VALUES ($1, $2)', [email, recovery]).catch(e => note('recovery', e));
  }
  db.audit({ actor: email, action: 'signup.created', target: email, details: { lang, recovery: !!recovery, quotaMb }, ip }).catch(() => {});

  // Sign in the way /auth/login does, then put the welcome message in the inbox.
  let auth = null, session = null;
  try {
    auth = await security.webmailAuthFor(email, security.basic(email, password));
    session = await security.engineSession(auth);
  } catch (e) { note('sign-in', e); }
  if (session) {
    try { await deliverWelcome(auth, session, { first, email, lang }); } catch (e) { note('welcome message', e); }
  }
  return { email, auth: session ? auth : null, session };
}

/* ——— HTTP ——— */
/** /signup-api/… — config, challenge, check, create. `openSession(email, auth)` returns the cookie headers. */
async function handle(req, res, url, { readJson, sendJson, sendBodyError, isCrossSite, ip, lang, openSession }) {
  const route = req.method + ' ' + url.pathname;
  try {
    if (route === 'GET /signup-api/config') {
      return sendJson(res, 200, { enabled: enabled(), domain: DOMAIN, minPassword: 12, terms: TERMS_VERSION, ownDomains: process.env.OWN_DOMAINS_ENABLED === 'true' });
    }
    if (!enabled()) return sendJson(res, 403, { error: 'Sign-up is not open yet.' });
    if (route === 'GET /signup-api/challenge') {
      if (brake('pow:' + ip, 30, 10 * 60e3)) slowDown();
      return sendJson(res, 200, challenge());
    }
    if (req.method !== 'POST' || !['/signup-api/check', '/signup-api/create'].includes(url.pathname)) return sendJson(res, 404, { error: 'Not found' });
    if (isCrossSite(req)) return sendJson(res, 403, { error: 'Forbidden' });
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return sendJson(res, 415, { error: 'JSON expected' });
    let body;
    try { body = await readJson(req); } catch (e) { return sendBodyError(res, e); }
    if (route === 'POST /signup-api/check') {
      if (brake('check:' + ip, 60, 60e3)) slowDown();
      return sendJson(res, 200, await check(body));
    }
    const out = await create(body, { ip, lang });
    let headers = {};
    if (out.auth) { try { headers = await openSession(out.email, out.auth); } catch (e) { console.error('[signup] session:', e.message); } }
    // signedIn false: the mailbox exists, the person signs in normally.
    return sendJson(res, 200, { ok: true, email: out.email, lang, signedIn: !!headers['Set-Cookie'] }, headers);
  } catch (e) {
    if (e.userError) return sendJson(res, e.status || 400, { error: e.message, code: e.code });
    console.error('[signup] ' + route + ':', e.message);
    return sendJson(res, 502, { error: 'Mail engine is temporarily unavailable. Please try again shortly.' });
  }
}

module.exports = { handle, enabled, networkOf, nameProblem, passwordProblem, check, challenge, usePuzzle, DOMAIN, TERMS_VERSION, WELCOME };
