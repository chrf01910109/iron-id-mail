/**
 * IRON ID — admin console API (/admin-api/*).
 *
 * Admins sign in to the webmail with their own mailbox; their role comes from cp.admins:
 *   platform  IRON ID staff: every customer, plans, retention, platform admins
 *   customer  admin of one customer: that customer's domains, mailboxes, teams, admins, audit
 *
 * Every change goes to the engine through the gateway's scoped API key (engineAdmin.call),
 * only after checking that the target belongs to the admin's customer, and is written to
 * the audit log. Engine administrators and the gateway's own service account can never be
 * changed from here.
 */
const crypto = require('crypto');
const db = require('./db');
const engineAdmin = require('./engineAdmin');
const dnsCheck = require('./dnsCheck');
const sessions = require('./sessionStore');
const security = require('./accountSecurity');

const PLATFORM_DOMAIN = (process.env.PLATFORM_DOMAIN || process.env.GATEWAY_ACCOUNT_DOMAIN || 'iron-id.io').toLowerCase();
const MAIL_HOST = (process.env.MAIL_HOST || 'mail.iron-id.io').toLowerCase();
const SERVICE_ACCOUNT = 'gateway';
// DKIM keys whose private half was exposed. They must never be offered for publishing.
const NEVER_PUBLISH = new Set(['v1-ed25519-20260921', 'v1-rsa-20260921', 'v1-ed25519-20260922', 'v1-rsa-20260922']);
const MB = 1024 * 1024;
const DAY = 86400000;
const PENDING_DAYS = 7;   // an unverified domain claim lapses after this
const MAX_PENDING = 5;    // unverified domains per customer

class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; this.userError = true; }
}
const fail = (msg, status) => { throw new UserError(msg, status); };

/* ——— Validation ——— */
const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const LOCAL_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{3,253}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanDomain(v) {
  const d = String(v || '').trim().toLowerCase().replace(/\.$/, '');
  if (!DOMAIN_RE.test(d)) fail('Enter a domain name such as company.dz.');
  return d;
}
function cleanEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  if (!EMAIL_RE.test(e)) fail('Enter a full email address.');
  return e;
}
function splitAddress(v) {
  const e = String(v || '').trim().toLowerCase();
  const i = e.lastIndexOf('@');
  if (i < 1) fail('Enter a full email address.');
  const local = e.slice(0, i), domain = e.slice(i + 1);
  if (!LOCAL_RE.test(local) || local.includes('..')) fail(`"${local}" can't be used before the @. Use letters, numbers, dots, dashes or underscores.`);
  return { local, domain: cleanDomain(domain), email: `${local}@${domain}` };
}
function cleanText(v, max = 100) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max); }
function cleanUuid(v) { const s = String(v || ''); if (!UUID_RE.test(s)) fail('Unknown customer.', 404); return s; }
function optInt(v, { min = 0, max = 1e9, name = 'value' } = {}) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${name} must be a whole number between ${min} and ${max}.`);
  return n;
}

/** A temporary password that is easy to read out: 4 groups of 4 (no 0/O, 1/l/I). */
function tempPassword() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += abc[crypto.randomInt(abc.length)];
    groups.push(s);
  }
  return groups.join('-');
}

/* ——— Engine helpers ——— */
async function eng(calls) {
  try {
    return await engineAdmin.call(calls);
  } catch (e) {
    if (e.code === 'not_configured') fail('Admin access to the mail engine is not set up yet. See the setup notes (STALWART_RECOVERY_ADMIN, one deploy).', 503);
    throw e;
  }
}

function resultOf(responses, id) {
  const r = responses.find(x => x[2] === id);
  if (!r) throw new Error('No engine response for ' + id);
  if (r[0] === 'error') {
    if (r[1].type === 'forbidden') fail('The gateway is not allowed to do this yet. Deploy once with STALWART_RECOVERY_ADMIN set so it can update its permissions, then remove it again.', 503);
    throw new Error(`${id}: ${r[1].type} ${r[1].description || ''}`);
  }
  return r[1];
}

function engineMessage(err, what) {
  const d = String((err && (err.description || err.type)) || '');
  if (/already exists|primaryKey|duplicate|in use/i.test(d)) return `Could not ${what}: that address or name is already in use.`;
  if (err && err.type === 'forbidden') return `Could not ${what}: not allowed.`;
  return `Could not ${what}${d ? ': ' + d : '.'}`;
}

/** Runs one x:<Object>/set and throws a readable error if anything was refused. */
async function engineSet(object, args, what) {
  const res = resultOf(await eng([[`x:${object}/set`, args, 's']]), 's');
  for (const k of ['notCreated', 'notUpdated', 'notDestroyed']) {
    const failed = res[k] && Object.values(res[k])[0];
    if (failed) fail(engineMessage(failed, what));
  }
  return res;
}

async function engineGet(object, ids = null, properties) {
  const args = { ids };
  if (properties) args.properties = properties;
  return resultOf(await eng([[`x:${object}/get`, args, 'g']]), 'g').list || [];
}

const DOMAIN_PROPS = ['name', 'isEnabled', 'dkimManagement', 'catchAllAddress', 'createdAt'];
const ACCOUNT_PROPS = ['@type', 'name', 'domainId', 'emailAddress', 'description', 'roles', 'permissions', 'quotas', 'usedDiskQuota', 'aliases', 'memberGroupIds', 'createdAt'];

/** The engine's domains and accounts, read together (credentials only to tell whether two-step is on; the engine masks them). */
async function engineDirectory({ withCredentials = false } = {}) {
  const r = await eng([
    ['x:Domain/get', { ids: null, properties: DOMAIN_PROPS }, 'd'],
    ['x:Account/get', { ids: null, properties: withCredentials ? ACCOUNT_PROPS.concat('credentials') : ACCOUNT_PROPS }, 'a']
  ]);
  const domains = resultOf(r, 'd').list || [];
  const accounts = resultOf(r, 'a').list || [];
  const domainById = new Map(domains.map(d => [d.id, d]));
  const domainByName = new Map(domains.map(d => [d.name.toLowerCase(), d]));
  for (const a of accounts) {
    const d = domainById.get(a.domainId);
    a.domain = d ? d.name.toLowerCase() : '';
    a.email = (a.emailAddress || (a.name + '@' + a.domain)).toLowerCase();
  }
  return { domains, accounts, domainById, domainByName };
}

/** Why an account can't be changed from the console (null when it can). */
function protectedReason(a) {
  const role = a.roles && a.roles['@type'];
  if (a.name === SERVICE_ACCOUNT && a.domain === PLATFORM_DOMAIN) return 'IRON ID service account';
  if (role === 'Admin') return 'Mail engine administrator';
  if (role === 'Custom' || role === 'Tenant') return 'Special engine role';
  if (a.permissions && a.permissions['@type'] && !['Inherit', 'Merge'].includes(a.permissions['@type'])) return 'Special permissions';
  if (a.permissions && a.permissions['@type'] === 'Merge' && Object.keys(a.permissions.enabledPermissions || {}).length) return 'Special permissions';
  return null;
}
const isSuspended = a => !!(a.permissions && a.permissions['@type'] === 'Merge' && a.permissions.disabledPermissions && a.permissions.disabledPermissions.authenticate);
const twoStepOn = a => Object.values(a.credentials || {}).some(c => c && c['@type'] === 'Password' && c.otpAuth);
const quotaBytes = a => (a.quotas && Number(a.quotas.maxDiskQuota)) || 0;
const aliasEmails = (a, domainById) => Object.values(a.aliases || {}).map(x => {
  const d = domainById.get(x.domainId);
  return d ? `${x.name}@${d.name}`.toLowerCase() : null;
}).filter(Boolean);

/* ——— Who is asking ——— */
async function adminFor(email) {
  const r = await db.query(
    `SELECT a.role, a.customer_id, c.name, c.status, c.internal
       FROM cp.admins a LEFT JOIN cp.customers c ON c.id = a.customer_id
      WHERE lower(a.email) = lower($1)`, [email]);
  if (!r.rows.length) return null;
  if (r.rows.some(x => x.role === 'platform')) return { email, platform: true, customerIds: null, customers: [] };
  const active = r.rows.filter(x => x.role === 'customer' && x.status === 'active');
  if (!active.length) return null;
  return { email, platform: false, customerIds: active.map(x => x.customer_id), customers: active.map(x => ({ id: x.customer_id, name: x.name })) };
}

const canCustomer = (ctx, id) => ctx.platform || ctx.customerIds.includes(id);
function requirePlatform(ctx) { if (!ctx.platform) fail('Only IRON ID staff can do this.', 403); }

/** cp.customer_domains rows the admin can see. */
async function scopedDomainRows(ctx) {
  const r = await db.query(
    `SELECT d.*, c.name AS customer_name, c.internal
       FROM cp.customer_domains d JOIN cp.customers c ON c.id = d.customer_id
      ${ctx.platform ? '' : 'WHERE d.customer_id = ANY($1::uuid[])'}
      ORDER BY d.domain`, ctx.platform ? [] : [ctx.customerIds]);
  return r.rows;
}

async function domainRow(ctx, domain) {
  const r = await db.query(
    `SELECT d.*, c.name AS customer_name, c.internal, c.plan_id
       FROM cp.customer_domains d JOIN cp.customers c ON c.id = d.customer_id WHERE d.domain = $1`, [domain]);
  const row = r.rows[0];
  if (!row || !canCustomer(ctx, row.customer_id)) fail('That domain was not found.', 404);
  return row;
}

/** Customer id for a mailbox address (for audit entries), cached briefly. */
let ownerCache = { at: 0, map: new Map() };
async function customerForEmail(email) {
  const domain = String(email || '').toLowerCase().split('@')[1] || '';
  if (Date.now() - ownerCache.at > 60000) {
    const r = await db.query('SELECT domain, customer_id FROM cp.customer_domains');
    ownerCache = { at: Date.now(), map: new Map(r.rows.map(x => [x.domain, x.customer_id])) };
  }
  return ownerCache.map.get(domain) || null;
}
function forgetOwners() { ownerCache.at = 0; }

/** Writes an audit entry; never fails the request. */
function audit(ctx, action, target, details, customerId) {
  db.audit({ actor: ctx.email, customerId: customerId || null, action, target, details, ip: ctx.ip })
    .catch(e => console.error('[admin] audit write failed:', e.message));
}

/** Addresses (mailboxes, teams, aliases) that exist, cached a few minutes: failed sign-ins are only recorded for these. */
let known = { at: 0, set: null };
async function knownAddress(email) {
  const e = String(email || '').toLowerCase();
  const age = Date.now() - known.at;
  // Refresh when old, or on a miss once it is more than 30 s old (a mailbox may be new).
  if (!known.set || age > 300000 || (!known.set.has(e) && age > 30000)) {
    try {
      const dir = await engineDirectory();
      const set = new Set();
      for (const a of dir.accounts) { set.add(a.email); for (const x of aliasEmails(a, dir.domainById)) set.add(x); }
      known = { at: Date.now(), set };
    } catch (e) { return false; }
  }
  return known.set.has(e);
}

const SIGNIN_KEEP_DAYS = 180;
/** Removes sign-in entries older than SIGNIN_KEEP_DAYS (changes are kept). */
async function pruneAudit() {
  try {
    const r = await db.query(`DELETE FROM cp.audit_log WHERE action LIKE 'signin.%' AND at < NOW() - make_interval(days => $1)`, [SIGNIN_KEEP_DAYS]);
    if (r.rowCount) console.log(`[audit] Removed ${r.rowCount} sign-in entries older than ${SIGNIN_KEEP_DAYS} days.`);
  } catch (e) { console.error('[audit] clean-up failed:', e.message); }
}

/** Sign-in audit for the webmail (called by server.js). Failures are recorded only for real addresses. */
async function auditSignIn({ email, ok, reason, ip, userAgent }) {
  try {
    if (!ok && !(await knownAddress(email))) return;
    const customerId = await customerForEmail(email);
    await db.audit({
      actor: String(email || '').slice(0, 254).toLowerCase(), customerId, action: ok ? 'signin.ok' : 'signin.failed',
      target: String(email || '').slice(0, 254).toLowerCase(), details: { reason: reason || undefined, agent: String(userAgent || '').slice(0, 160) }, ip
    });
  } catch (e) { console.error('[audit] sign-in entry failed:', e.message); }
}

/* ——— Accounts in scope ——— */
/**
 * The engine directory narrowed to what this admin may see. Only verified (active) domains
 * count: a pending claim on a domain gives no access to anything in it.
 */
async function scopedDirectory(ctx, opts) {
  const [dir, rows] = await Promise.all([engineDirectory(opts), scopedDomainRows(ctx)]);
  const owned = new Map(rows.filter(r => r.status === 'active').map(r => [r.domain, r]));
  const visible = dir.accounts.filter(a => owned.has(a.domain) && !(a.name === SERVICE_ACCOUNT && a.domain === PLATFORM_DOMAIN));
  return { ...dir, rows, owned, visible };
}

async function accountInScope(ctx, id, type, opts) {
  const dir = await scopedDirectory(ctx, opts);
  const a = typeof id === 'string' ? dir.visible.find(x => x.id === id) : null;
  if (!a || (type && a['@type'] !== type)) fail(type === 'Group' ? 'That team was not found.' : 'That mailbox was not found.', 404);
  if (type === 'Group' && protectedReason(a)) fail(`${a.email} is managed by IRON ID staff (${protectedReason(a)}).`, 403);
  return { a, dir, row: dir.owned.get(a.domain) };
}

async function adminEmails() {
  const r = await db.query('SELECT lower(email) AS email, role, customer_id FROM cp.admins');
  return r.rows;
}

function mailboxView(a, dir, admins) {
  const teams = Object.keys(a.memberGroupIds || {}).map(gid => dir.accounts.find(x => x.id === gid)).filter(Boolean).map(g => g.email);
  return {
    id: a.id, email: a.email, name: a.description || '', domain: a.domain,
    quotaMb: quotaBytes(a) ? Math.round(quotaBytes(a) / MB) : null, usedBytes: a.usedDiskQuota || 0,
    suspended: isSuspended(a), twoStep: twoStepOn(a), aliases: aliasEmails(a, dir.domainById), teams,
    admin: admins.some(x => x.email === a.email), protected: protectedReason(a), createdAt: a.createdAt
  };
}

function teamView(g, dir) {
  const members = dir.accounts.filter(a => a['@type'] === 'User' && a.memberGroupIds && a.memberGroupIds[g.id]).map(a => a.email).sort();
  return { id: g.id, email: g.email, name: g.description || '', domain: g.domain, usedBytes: g.usedDiskQuota || 0, members, aliases: aliasEmails(g, dir.domainById), createdAt: g.createdAt };
}

/** Ends every webmail session of a mailbox and forgets its webmail access. */
async function signOutEverywhere(email) {
  await sessions.destroySessionsFor(email);
  await security.forgetWebmailCredential(email);
}

/* ——— Plans and usage ——— */
async function planFor(customerId) {
  const r = await db.query('SELECT p.* FROM cp.customers c LEFT JOIN cp.plans p ON p.id = c.plan_id WHERE c.id = $1', [customerId]);
  return r.rows[0] && r.rows[0].id ? r.rows[0] : null;
}

function usageFor(customer, dir) {
  const domains = dir.rows ? dir.rows.filter(r => r.customer_id === customer.id).map(r => r.domain) : [];
  const accts = dir.accounts.filter(a => domains.includes(a.domain) && !(a.name === SERVICE_ACCOUNT && a.domain === PLATFORM_DOMAIN));
  const users = accts.filter(a => a['@type'] === 'User');
  const billable = users.filter(a => !protectedReason(a));
  const usedBytes = accts.reduce((s, a) => s + (a.usedDiskQuota || 0), 0);
  const allocatedBytes = accts.reduce((s, a) => s + quotaBytes(a), 0);
  const price = customer.price_per_mailbox != null ? Number(customer.price_per_mailbox) : null;
  return {
    customerId: customer.id, customer: customer.name, internal: customer.internal, status: customer.status,
    plan: customer.plan_id ? { id: customer.plan_id, name: customer.plan_name, maxMailboxes: customer.max_mailboxes, mailboxQuotaMb: customer.mailbox_quota_mb, pricePerMailbox: price, currency: customer.currency } : null,
    domains: domains.length, mailboxes: users.length, billableMailboxes: billable.length, teams: accts.filter(a => a['@type'] === 'Group').length,
    usedBytes, allocatedBytes,
    monthlyEstimate: customer.internal || price == null ? null : Math.round(billable.length * price * 100) / 100
  };
}

async function customersWithPlans(ctx) {
  const r = await db.query(
    `SELECT c.*, p.name AS plan_name, p.max_mailboxes, p.mailbox_quota_mb, p.price_per_mailbox, p.currency
       FROM cp.customers c LEFT JOIN cp.plans p ON p.id = c.plan_id
      ${ctx.platform ? '' : 'WHERE c.id = ANY($1::uuid[])'}
      ORDER BY c.internal DESC, lower(c.name)`, ctx.platform ? [] : [ctx.customerIds]);
  return r.rows;
}

/* ——— DNS records ——— */
function dkimRecordValue(k) {
  const alg = k['@type'] === 'Dkim1RsaSha256' ? 'rsa' : 'ed25519';
  return `v=DKIM1; k=${alg}; p=${k.publicKey}`;
}

const norm = s => String(s || '').replace(/\s+/g, '').replace(/"/g, '').toLowerCase();

async function checkRecord(rec) {
  let found = [];
  try { found = await dnsCheck.lookup(rec.name, rec.type); } catch (e) { return { ok: false, found: [], problem: 'Could not look this up right now.' }; }
  if (rec.id === 'spf') {
    const spf = found.filter(v => /^v=spf1(\s|$)/i.test(v.trim()));
    if (spf.length > 1) return { ok: false, found: spf, problem: 'There is more than one SPF record. Merge them into one.' };
    if (!spf.length) return { ok: false, found: [] };
    const tokens = spf[0].toLowerCase().split(/\s+/);
    const ok = tokens.some(t => /^[+~?]?mx$/.test(t) || t === `a:${MAIL_HOST}` || t === `include:_spf.${PLATFORM_DOMAIN}`);
    return { ok, found: spf, problem: ok ? null : 'The SPF record does not allow IRON ID yet: add "mx".' };
  }
  if (rec.type === 'MX') {
    const ok = found.some(v => norm(v).replace(/^\d+/, '') === norm(MAIL_HOST));
    return { ok, found };
  }
  if (rec.id === 'dmarc') {
    const d = found.filter(v => /^v=dmarc1/i.test(v.trim()));
    return { ok: d.length === 1, found: d, problem: d.length > 1 ? 'There is more than one DMARC record.' : null };
  }
  if (rec.match === 'exact') return { ok: found.some(v => norm(v) === norm(rec.value)), found };
  // DKIM: the key must match exactly.
  const want = norm(rec.value).match(/p=([^;]+)/);
  return { ok: !!want && found.some(v => (norm(v).match(/p=([^;]+)/) || [])[1] === want[1]), found };
}

async function domainKeys(engineDomain) {
  if (!engineDomain) return [];
  const keys = await engineGet('DkimSignature', null, ['@type', 'selector', 'domainId', 'stage', 'publicKey', 'createdAt']);
  return keys.filter(k => k.domainId === engineDomain.id);
}

/** The records a customer adds at their DNS provider, with their current state. */
async function dnsRecords(row, engineDomain, keys) {
  const d = row.domain;
  const platform = d === PLATFORM_DOMAIN;
  const recs = [];
  if (!platform) {
    recs.push({ id: 'verify', purpose: 'Proves that you own this domain', type: 'TXT', host: '@', name: d, value: `iron-id-verification=${row.verify_token}`, match: 'exact', required: true });
    recs.push({ id: 'mx', purpose: 'Delivers this domain’s mail to IRON ID', type: 'MX', host: '@', name: d, value: `10 ${MAIL_HOST}`, required: true });
    recs.push({ id: 'spf', purpose: 'Allows IRON ID to send mail for this domain (SPF)', type: 'TXT', host: '@', name: d, value: 'v=spf1 mx ~all', required: true });
  }
  for (const k of keys.filter(k => k.stage === 'active' || k.stage === 'pending')) {
    if (NEVER_PUBLISH.has(k.selector)) continue;
    recs.push({
      id: 'dkim:' + k.selector, purpose: k.stage === 'pending' ? 'New signing key (DKIM) — add it before switching' : 'Signs outgoing mail (DKIM)',
      type: 'TXT', host: `${k.selector}._domainkey`, name: `${k.selector}._domainkey.${d}`, value: dkimRecordValue(k), required: k.stage === 'active'
    });
  }
  if (!platform) {
    recs.push({ id: 'dmarc', purpose: 'Tells receivers what to do with mail that fails the checks (DMARC). Start with p=none.', type: 'TXT', host: '_dmarc', name: `_dmarc.${d}`, value: `v=DMARC1; p=none; rua=mailto:postmaster@${d}`, required: false });
  }
  const checked = await Promise.all(recs.map(async r => ({ ...r, ...(await checkRecord(r)) })));
  return checked.map(({ match, ...r }) => r);
}

function keyView(k) {
  return { id: k.id, selector: k.selector, algorithm: k['@type'] === 'Dkim1RsaSha256' ? 'RSA 2048' : 'Ed25519', stage: k.stage, createdAt: k.createdAt, exposed: NEVER_PUBLISH.has(k.selector) };
}

function newKeyPair() {
  const ed = crypto.generateKeyPairSync('ed25519');
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = k => k.export({ type: 'pkcs8', format: 'pem' });
  return { ed: pem(ed.privateKey), rsa: pem(rsa.privateKey) };
}

/** Selectors like ironid20261014e / ironid20261014r, unique among the domain's keys. */
function newSelectors(existing) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const used = new Set(existing.map(k => k.selector));
  for (let i = 0; i < 26; i++) {
    const suffix = i ? String.fromCharCode(97 + i) : '';
    const e = `ironid${day}${suffix}e`, r = `ironid${day}${suffix}r`;
    if (!used.has(e) && !used.has(r) && !NEVER_PUBLISH.has(e) && !NEVER_PUBLISH.has(r)) return { e, r };
  }
  fail('Too many new keys today. Try again tomorrow.');
}

async function createKeys(domainId, stage, existing) {
  const sel = newSelectors(existing);
  const keys = newKeyPair();
  await engineSet('DkimSignature', { create: {
    e: { '@type': 'Dkim1Ed25519Sha256', domainId, selector: sel.e, stage, privateKey: { '@type': 'Text', secret: keys.ed } },
    r: { '@type': 'Dkim1RsaSha256', domainId, selector: sel.r, stage, privateKey: { '@type': 'Text', secret: keys.rsa } }
  } }, 'create the signing keys');
  return sel;
}

/* ——— Route handlers ——— */
const routes = {};
const route = (method, path, fn) => { routes[method + ' ' + path] = fn; };

route('GET', '/admin-api/me', async ctx => {
  let twoStep = null;
  try { twoStep = await security.twoStepEnabled(ctx.session.auth); } catch (e) { twoStep = null; }
  return { email: ctx.email, role: ctx.platform ? 'platform' : 'customer', customers: ctx.customers, platformDomain: PLATFORM_DOMAIN, mailHost: MAIL_HOST, twoStep };
});

route('GET', '/admin-api/overview', async ctx => {
  const [dir, customers] = await Promise.all([scopedDirectory(ctx), customersWithPlans(ctx)]);
  const usage = customers.map(c => usageFor(c, dir));
  const recent = await db.query(
    `SELECT at, actor, action, target FROM cp.audit_log
      WHERE action NOT LIKE 'signin.%' ${ctx.platform ? '' : 'AND customer_id = ANY($1::uuid[])'}
      ORDER BY at DESC LIMIT 8`, ctx.platform ? [] : [ctx.customerIds]);
  const pending = dir.rows.filter(r => r.status === 'pending').map(r => r.domain);
  const out = {
    customers: customers.length,
    domains: dir.rows.length, pendingDomains: pending,
    mailboxes: dir.visible.filter(a => a['@type'] === 'User').length,
    teams: dir.visible.filter(a => a['@type'] === 'Group').length,
    usedBytes: usage.reduce((s, u) => s + u.usedBytes, 0),
    recent: recent.rows
  };
  if (ctx.platform) {
    out.engine = { adminAccess: engineAdmin.getStatus(), recoveryAdminSet: engineAdmin.recoveryAdminSet() };
    out.unassignedDomains = dir.domains.map(d => d.name.toLowerCase()).filter(n => !dir.owned.has(n));
  }
  return out;
});

/* Customers (platform manages; customer admins see their own). */
route('GET', '/admin-api/customers', async ctx => {
  const [customers, dir, admins] = await Promise.all([customersWithPlans(ctx), scopedDirectory(ctx), adminEmails()]);
  return {
    customers: customers.map(c => ({
      id: c.id, name: c.name, status: c.status, internal: c.internal, contactEmail: c.contact_email, planId: c.plan_id, createdAt: c.created_at,
      admins: admins.filter(a => a.customer_id === c.id).map(a => a.email).sort(),
      usage: usageFor(c, dir)
    }))
  };
});

route('POST', '/admin-api/customers', async (ctx, b) => {
  requirePlatform(ctx);
  const name = cleanText(b.name, 120);
  if (!name) fail('Enter the customer’s name.');
  const contact = b.contactEmail ? cleanEmail(b.contactEmail) : null;
  const planId = b.planId ? String(b.planId) : null;
  if (planId && !(await db.query('SELECT 1 FROM cp.plans WHERE id = $1', [planId])).rows.length) fail('That plan does not exist.');
  const r = await db.query('INSERT INTO cp.customers (name, contact_email, plan_id) VALUES ($1, $2, $3) RETURNING id', [name, contact, planId]);
  audit(ctx, 'customer.created', name, { planId }, r.rows[0].id);
  return { id: r.rows[0].id };
});

route('POST', '/admin-api/customers/update', async (ctx, b) => {
  requirePlatform(ctx);
  const id = cleanUuid(b.id);
  const cur = (await db.query('SELECT * FROM cp.customers WHERE id = $1', [id])).rows[0];
  if (!cur) fail('Unknown customer.', 404);
  const name = b.name !== undefined ? cleanText(b.name, 120) : cur.name;
  if (!name) fail('Enter the customer’s name.');
  const contact = b.contactEmail !== undefined ? (b.contactEmail ? cleanEmail(b.contactEmail) : null) : cur.contact_email;
  const planId = b.planId !== undefined ? (b.planId ? String(b.planId) : null) : cur.plan_id;
  if (planId && !(await db.query('SELECT 1 FROM cp.plans WHERE id = $1', [planId])).rows.length) fail('That plan does not exist.');
  const status = b.status !== undefined ? String(b.status) : cur.status;
  if (!['active', 'suspended'].includes(status)) fail('Unknown status.');
  if (cur.internal && status !== 'active') fail('The IRON ID customer cannot be suspended.');
  await db.query('UPDATE cp.customers SET name = $2, contact_email = $3, plan_id = $4, status = $5 WHERE id = $1', [id, name, contact, planId, status]);
  audit(ctx, 'customer.updated', name, { planId, status }, id);
  return { ok: true };
});

route('POST', '/admin-api/customers/delete', async (ctx, b) => {
  requirePlatform(ctx);
  const id = cleanUuid(b.id);
  const cur = (await db.query('SELECT * FROM cp.customers WHERE id = $1', [id])).rows[0];
  if (!cur) fail('Unknown customer.', 404);
  if (cur.internal) fail('The IRON ID customer cannot be deleted.');
  if ((await db.query('SELECT 1 FROM cp.customer_domains WHERE customer_id = $1', [id])).rows.length) fail('Remove this customer’s domains first.');
  await db.query('DELETE FROM cp.customers WHERE id = $1', [id]);
  audit(ctx, 'customer.deleted', cur.name, null, id);
  return { ok: true };
});

/* Admin roles. */
route('GET', '/admin-api/admins', async ctx => {
  const r = await db.query(
    `SELECT lower(a.email) AS email, a.role, a.customer_id, c.name AS customer
       FROM cp.admins a LEFT JOIN cp.customers c ON c.id = a.customer_id
      ${ctx.platform ? '' : 'WHERE a.customer_id = ANY($1::uuid[])'} ORDER BY a.role, lower(a.email)`,
    ctx.platform ? [] : [ctx.customerIds]);
  return { admins: r.rows.map(x => ({ email: x.email, role: x.role, customerId: x.customer_id, customer: x.customer })) };
});

/** Admin rights go only to an existing mailbox on one of the customer's verified domains. */
async function requireMailboxOf(customerId, email) {
  const dir = await engineDirectory();
  const domains = new Set((await db.query(`SELECT domain FROM cp.customer_domains WHERE customer_id = $1 AND status = 'active'`, [customerId])).rows.map(r => r.domain));
  const a = dir.accounts.find(x => x.email === email && x['@type'] === 'User');
  if (!a || !domains.has(a.domain)) fail('Create that mailbox first: admins sign in with a mailbox on one of the organisation’s own domains.');
  if (protectedReason(a)) fail(`${email} is managed by IRON ID staff in the engine.`);
}

route('POST', '/admin-api/admins/add', async (ctx, b) => {
  const email = cleanEmail(b.email);
  if (b.role === 'platform') {
    requirePlatform(ctx);
    const internal = (await db.query('SELECT id FROM cp.customers WHERE internal ORDER BY created_at LIMIT 1')).rows[0];
    if (internal) await requireMailboxOf(internal.id, email);
    await db.query(`INSERT INTO cp.admins (email, customer_id, role) SELECT $1, NULL, 'platform'
                    WHERE NOT EXISTS (SELECT 1 FROM cp.admins WHERE lower(email) = $1 AND customer_id IS NULL)`, [email]);
    audit(ctx, 'admin.added', email, { role: 'platform' });
    return { ok: true };
  }
  const customerId = cleanUuid(b.customerId);
  if (!canCustomer(ctx, customerId)) fail('Unknown customer.', 404);
  const c = (await db.query('SELECT internal FROM cp.customers WHERE id = $1', [customerId])).rows[0];
  if (!c) fail('Unknown customer.', 404);
  if (c.internal) fail('Add IRON ID staff as platform admins instead.');
  await requireMailboxOf(customerId, email);
  await db.query(`INSERT INTO cp.admins (email, customer_id, role) SELECT $1, $2, 'customer'
                  WHERE NOT EXISTS (SELECT 1 FROM cp.admins WHERE lower(email) = $1 AND customer_id = $2)`, [email, customerId]);
  audit(ctx, 'admin.added', email, { role: 'customer' }, customerId);
  return { ok: true };
});

route('POST', '/admin-api/admins/remove', async (ctx, b) => {
  const email = cleanEmail(b.email);
  if (email === ctx.email.toLowerCase()) fail('You cannot remove your own admin access. Ask another admin.');
  if (b.role === 'platform') {
    requirePlatform(ctx);
    const r = await db.query('DELETE FROM cp.admins WHERE lower(email) = $1 AND customer_id IS NULL', [email]);
    if (!r.rowCount) fail('That admin was not found.', 404);
    audit(ctx, 'admin.removed', email, { role: 'platform' });
    return { ok: true };
  }
  const customerId = cleanUuid(b.customerId);
  if (!canCustomer(ctx, customerId)) fail('Unknown customer.', 404);
  const r = await db.query('DELETE FROM cp.admins WHERE lower(email) = $1 AND customer_id = $2', [email, customerId]);
  if (!r.rowCount) fail('That admin was not found.', 404);
  audit(ctx, 'admin.removed', email, { role: 'customer' }, customerId);
  return { ok: true };
});

/* Plans. */
route('GET', '/admin-api/plans', async ctx => {
  const r = await db.query(
    `SELECT p.*, (SELECT count(*) FROM cp.customers c WHERE c.plan_id = p.id)::int AS customers FROM cp.plans p ORDER BY p.price_per_mailbox NULLS LAST, p.name`);
  let visible = r.rows;
  if (!ctx.platform) {
    const own = await db.query('SELECT DISTINCT plan_id FROM cp.customers WHERE id = ANY($1::uuid[])', [ctx.customerIds]);
    const ids = own.rows.map(x => x.plan_id);
    visible = r.rows.filter(p => ids.includes(p.id));
  }
  return { plans: visible.map(p => ({ id: p.id, name: p.name, maxMailboxes: p.max_mailboxes, mailboxQuotaMb: p.mailbox_quota_mb, pricePerMailbox: p.price_per_mailbox != null ? Number(p.price_per_mailbox) : null, currency: p.currency, customers: p.customers })) };
});

route('POST', '/admin-api/plans', async (ctx, b) => {
  requirePlatform(ctx);
  const name = cleanText(b.name, 60);
  if (!name) fail('Enter a plan name.');
  const maxMailboxes = optInt(b.maxMailboxes, { min: 1, max: 1000000, name: 'Mailboxes' });
  const quota = optInt(b.mailboxQuotaMb, { min: 50, max: 10 * 1024 * 1024, name: 'Storage per mailbox (MB)' });
  let price = b.pricePerMailbox === '' || b.pricePerMailbox == null ? null : Number(b.pricePerMailbox);
  if (price !== null && (!isFinite(price) || price < 0 || price > 1e7)) fail('Enter a valid price.');
  if (price !== null) price = Math.round(price * 100) / 100;
  const currency = String(b.currency || 'DZD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) fail('Currency must be a 3-letter code such as DZD or EUR.');
  let id = b.id ? String(b.id) : null;
  if (id) {
    const r = await db.query('UPDATE cp.plans SET name=$2, max_mailboxes=$3, mailbox_quota_mb=$4, price_per_mailbox=$5, currency=$6 WHERE id=$1', [id, name, maxMailboxes, quota, price, currency]);
    if (!r.rowCount) fail('That plan was not found.', 404);
  } else {
    id = (name.toLowerCase().normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'plan') + '-' + crypto.randomBytes(2).toString('hex');
    await db.query('INSERT INTO cp.plans (id, name, max_mailboxes, mailbox_quota_mb, price_per_mailbox, currency) VALUES ($1,$2,$3,$4,$5,$6)', [id, name, maxMailboxes, quota, price, currency]);
  }
  audit(ctx, b.id ? 'plan.updated' : 'plan.created', name, { id, maxMailboxes, quota, price, currency });
  return { id };
});

route('POST', '/admin-api/plans/delete', async (ctx, b) => {
  requirePlatform(ctx);
  const id = String(b.id || '');
  if ((await db.query('SELECT 1 FROM cp.customers WHERE plan_id = $1', [id])).rows.length) fail('Customers still use this plan. Move them to another plan first.');
  const r = await db.query('DELETE FROM cp.plans WHERE id = $1 RETURNING name', [id]);
  if (!r.rowCount) fail('That plan was not found.', 404);
  audit(ctx, 'plan.deleted', r.rows[0].name, { id });
  return { ok: true };
});

/* Domains. */
route('GET', '/admin-api/domains', async ctx => {
  const dir = await scopedDirectory(ctx);
  const count = (d, t) => dir.visible.filter(a => a.domain === d && a['@type'] === t).length;
  const list = dir.rows.map(r => {
    const ed = dir.domainByName.get(r.domain);
    return {
      domain: r.domain, customerId: r.customer_id, customer: r.customer_name, status: r.status, platform: r.domain === PLATFORM_DOMAIN,
      verifiedAt: r.verified_at, createdAt: r.created_at, inEngine: !!ed && r.status === 'active', catchAll: ed && r.status === 'active' ? ed.catchAllAddress : null,
      dkim: ed && ed.dkimManagement ? ed.dkimManagement['@type'] : null,
      mailboxes: count(r.domain, 'User'), teams: count(r.domain, 'Group')
    };
  });
  if (ctx.platform) {
    const claimed = new Set(dir.rows.map(r => r.domain));
    for (const d of dir.domains) {
      const n = d.name.toLowerCase();
      if (!claimed.has(n)) list.push({ domain: n, status: 'unassigned', inEngine: true, platform: false, mailboxes: dir.accounts.filter(a => a.domain === n && a['@type'] === 'User').length, teams: 0 });
    }
  }
  return { domains: list };
});

route('POST', '/admin-api/domains', async (ctx, b) => {
  const domain = cleanDomain(b.domain);
  const customerId = ctx.platform ? cleanUuid(b.customerId) : (b.customerId ? cleanUuid(b.customerId) : ctx.customerIds[0]);
  if (!canCustomer(ctx, customerId)) fail('Unknown customer.', 404);
  const cust = (await db.query('SELECT * FROM cp.customers WHERE id = $1', [customerId])).rows[0];
  if (!cust) fail('Unknown customer.', 404);
  if (domain === PLATFORM_DOMAIN || domain.endsWith('.' + PLATFORM_DOMAIN)) {
    requirePlatform(ctx);
    if (!cust.internal) fail(`${PLATFORM_DOMAIN} addresses belong to IRON ID.`);
  }
  const claim = (await db.query('SELECT customer_id, status, created_at FROM cp.customer_domains WHERE domain = $1', [domain])).rows[0];
  if (claim) {
    // An unverified claim lapses after PENDING_DAYS, so nobody can hold someone else's domain hostage.
    const lapsed = claim.status === 'pending' && claim.customer_id !== customerId && Date.now() - new Date(claim.created_at).getTime() > PENDING_DAYS * DAY;
    if (!lapsed) fail('This domain is already on IRON ID. If it is yours, contact IRON ID support.');
    await db.query(`DELETE FROM cp.customer_domains WHERE domain = $1 AND status = 'pending'`, [domain]);
    audit(ctx, 'domain.claim_lapsed', domain, null, claim.customer_id);
  }
  if (!ctx.platform) {
    const n = (await db.query(`SELECT count(*)::int AS n FROM cp.customer_domains WHERE customer_id = $1 AND status = 'pending'`, [customerId])).rows[0].n;
    if (n >= MAX_PENDING) fail(`Verify or remove your other new domains first (at most ${MAX_PENDING} waiting at a time).`);
  }
  const existing = (await engineGet('Domain', null, ['name'])).find(d => d.name.toLowerCase() === domain);
  const token = crypto.randomBytes(16).toString('hex');
  if (existing) {
    // Already set up in the engine (from before the console): only IRON ID staff may assign it.
    if (!ctx.platform) fail('This domain is already on IRON ID. If it is yours, contact IRON ID support.');
    await db.query(`INSERT INTO cp.customer_domains (domain, customer_id, engine_domain_id, verify_token, verified_at, status)
                    VALUES ($1, $2, $3, $4, NOW(), 'active')`, [domain, customerId, existing.id, token]);
    forgetOwners();
    audit(ctx, 'domain.assigned', domain, null, customerId);
    return { domain, status: 'active' };
  }
  await db.query('INSERT INTO cp.customer_domains (domain, customer_id, verify_token) VALUES ($1, $2, $3)', [domain, customerId, token]);
  forgetOwners();
  audit(ctx, 'domain.added', domain, null, customerId);
  return { domain, status: 'pending' };
});

route('GET', '/admin-api/domains/dns', async (ctx, b, url) => {
  const row = await domainRow(ctx, cleanDomain(url.searchParams.get('domain')));
  const ed = (await engineGet('Domain', null, DOMAIN_PROPS)).find(d => d.name.toLowerCase() === row.domain);
  const keys = await domainKeys(ed);
  const records = await dnsRecords(row, ed, keys);
  const warnings = [];
  if (keys.some(k => k.stage === 'active' && NEVER_PUBLISH.has(k.selector))) {
    warnings.push('This domain still signs mail with keys that were exposed. Create new DKIM keys and switch to them.');
  }
  if (row.domain === PLATFORM_DOMAIN) warnings.push(`MX, SPF and DMARC for ${PLATFORM_DOMAIN} are managed separately and are not changed from here.`);
  return {
    domain: row.domain, status: row.status, platform: row.domain === PLATFORM_DOMAIN, records, warnings,
    keys: keys.map(keyView), dkimManagement: ed && ed.dkimManagement ? ed.dkimManagement['@type'] : null,
    catchAll: ed ? ed.catchAllAddress : null
  };
});

route('POST', '/admin-api/domains/verify', async (ctx, b) => {
  const row = await domainRow(ctx, cleanDomain(b.domain));
  if (row.status !== 'pending') fail('This domain is already verified.');
  const skip = ctx.platform && b.skipCheck === true;
  if (!skip) {
    const v = await checkRecord({ id: 'verify', type: 'TXT', name: row.domain, value: `iron-id-verification=${row.verify_token}`, match: 'exact' });
    if (!v.ok) fail('The verification record was not found yet. DNS changes can take from a few minutes to a few hours; try again later.');
  }
  let ed = (await engineGet('Domain', null, ['name'])).find(d => d.name.toLowerCase() === row.domain);
  // A domain that already exists in the engine (set up some other way) is only handed over by IRON ID staff.
  if (ed && !ctx.platform) fail('This domain is already on IRON ID. Contact IRON ID support to have it assigned to you.');
  let created = false;
  if (!ed) {
    const r = await engineSet('Domain', { create: { d: { name: row.domain, dkimManagement: { '@type': 'Manual' } } } }, 'add the domain to the mail server');
    ed = { id: r.created.d.id };
    created = true;
  }
  try {
    const existing = await domainKeys(ed);
    if (!existing.some(k => k.stage === 'active')) await createKeys(ed.id, 'active', existing);
  } catch (e) {
    if (created) await eng([['x:Domain/set', { destroy: [ed.id] }, 'x']]).catch(() => {});
    throw e;
  }
  await db.query(`UPDATE cp.customer_domains SET status = 'active', verified_at = NOW(), engine_domain_id = $2 WHERE domain = $1`, [row.domain, ed.id]);
  audit(ctx, 'domain.verified', row.domain, skip ? { skipCheck: true } : null, row.customer_id);
  return { domain: row.domain, status: 'active' };
});

route('POST', '/admin-api/domains/settings', async (ctx, b) => {
  const row = await domainRow(ctx, cleanDomain(b.domain));
  const ed = (await engineGet('Domain', null, ['name'])).find(d => d.name.toLowerCase() === row.domain);
  if (!ed || row.status !== 'active') fail('Verify the domain first.');
  let catchAll = null;
  if (b.catchAll) {
    catchAll = cleanEmail(b.catchAll);
    if (!catchAll.endsWith('@' + row.domain)) fail(`The catch-all address must end with @${row.domain}.`);
    const dir = await engineDirectory();
    if (!dir.accounts.some(a => a.email === catchAll)) fail('Create that mailbox or team first.');
  }
  await engineSet('Domain', { update: { [ed.id]: { catchAllAddress: catchAll } } }, 'save the domain settings');
  audit(ctx, 'domain.catch_all', row.domain, { catchAll }, row.customer_id);
  return { ok: true };
});

route('POST', '/admin-api/domains/dkim/prepare', async (ctx, b) => {
  const row = await domainRow(ctx, cleanDomain(b.domain));
  if (row.domain === PLATFORM_DOMAIN) requirePlatform(ctx);
  const ed = (await engineGet('Domain', null, DOMAIN_PROPS)).find(d => d.name.toLowerCase() === row.domain);
  if (!ed || row.status !== 'active') fail('Verify the domain first.');
  // Keys are managed here from now on (the engine would otherwise rotate on its own schedule).
  if (!ed.dkimManagement || ed.dkimManagement['@type'] !== 'Manual') {
    await engineSet('Domain', { update: { [ed.id]: { dkimManagement: { '@type': 'Manual' } } } }, 'switch the domain to managed keys');
  }
  const keys = await domainKeys(ed);
  const stalePending = keys.filter(k => k.stage === 'pending').map(k => k.id);
  if (stalePending.length) await engineSet('DkimSignature', { destroy: stalePending }, 'replace the earlier new keys');
  const sel = await createKeys(ed.id, 'pending', keys.filter(k => !stalePending.includes(k.id)));
  audit(ctx, 'domain.dkim_prepared', row.domain, { selectors: [sel.e, sel.r] }, row.customer_id);
  return { selectors: [sel.e, sel.r] };
});

route('POST', '/admin-api/domains/dkim/activate', async (ctx, b) => {
  const row = await domainRow(ctx, cleanDomain(b.domain));
  if (row.domain === PLATFORM_DOMAIN) requirePlatform(ctx);
  const ed = (await engineGet('Domain', null, ['name'])).find(d => d.name.toLowerCase() === row.domain);
  if (!ed || row.status !== 'active') fail('Verify the domain first.');
  const keys = await domainKeys(ed);
  const pending = keys.filter(k => k.stage === 'pending');
  if (!pending.length) fail('There are no new keys to switch to. Create new keys first.');
  if (!(ctx.platform && b.skipCheck === true)) {
    for (const k of pending) {
      const c = await checkRecord({ id: 'dkim', type: 'TXT', name: `${k.selector}._domainkey.${row.domain}`, value: dkimRecordValue(k) });
      if (!c.ok) fail(`The record ${k.selector}._domainkey is not visible in DNS yet. Add it, wait a little, and try again.`);
    }
  }
  const update = {};
  for (const k of pending) update[k.id] = { stage: 'active' };
  for (const k of keys.filter(k => k.stage === 'active')) update[k.id] = { stage: 'retiring' };
  await engineSet('DkimSignature', { update }, 'switch keys');
  audit(ctx, 'domain.dkim_activated', row.domain, { selectors: pending.map(k => k.selector) }, row.customer_id);
  return { ok: true };
});

route('POST', '/admin-api/domains/dkim/remove-old', async (ctx, b) => {
  const row = await domainRow(ctx, cleanDomain(b.domain));
  if (row.domain === PLATFORM_DOMAIN) requirePlatform(ctx);
  const ed = (await engineGet('Domain', null, ['name'])).find(d => d.name.toLowerCase() === row.domain);
  if (!ed || row.status !== 'active') fail('Verify the domain first.');
  const keys = await domainKeys(ed);
  const old = keys.filter(k => k.stage === 'retiring' || k.stage === 'retired');
  if (!old.length) fail('There are no old keys to remove.');
  if (!keys.some(k => k.stage === 'active')) fail('Keep at least one active key.');
  await engineSet('DkimSignature', { destroy: old.map(k => k.id) }, 'remove the old keys');
  audit(ctx, 'domain.dkim_removed', row.domain, { selectors: old.map(k => k.selector) }, row.customer_id);
  return { removed: old.map(k => k.selector) };
});

route('POST', '/admin-api/domains/remove', async (ctx, b) => {
  const row = await domainRow(ctx, cleanDomain(b.domain));
  if (row.domain === PLATFORM_DOMAIN) fail(`${PLATFORM_DOMAIN} cannot be removed.`);
  if (String(b.confirm || '').toLowerCase() !== row.domain) fail('Type the domain name to confirm.');
  const dir = await engineDirectory();
  const ed = dir.domainByName.get(row.domain);
  // Only a verified domain is the customer's to remove from the mail server; an unverified
  // claim is just forgotten (the engine may hold a domain of the same name set up otherwise).
  if (ed && row.status === 'active') {
    if (dir.accounts.some(a => a.domainId === ed.id)) fail('Delete this domain’s mailboxes and teams first.');
    const aliased = dir.accounts.find(a => Object.values(a.aliases || {}).some(x => x.domainId === ed.id));
    if (aliased) fail(`${aliased.email} still has an alias on ${row.domain}. Remove it first.`);
    const keys = await domainKeys(ed);
    if (keys.length) await engineSet('DkimSignature', { destroy: keys.map(k => k.id) }, 'remove the signing keys');
    await engineSet('Domain', { destroy: [ed.id] }, 'remove the domain');
  }
  await db.query('DELETE FROM cp.customer_domains WHERE domain = $1', [row.domain]);
  // Admin rights tied to addresses on this domain end with it (someone may register it later).
  await db.query(`DELETE FROM cp.admins WHERE right(lower(email), length($1)) = $1`, ['@' + row.domain]);
  forgetOwners();
  audit(ctx, 'domain.removed', row.domain, null, row.customer_id);
  return { ok: true };
});

/* Mailboxes. */
route('GET', '/admin-api/mailboxes', async (ctx, b, url) => {
  const [dir, admins] = await Promise.all([scopedDirectory(ctx, { withCredentials: true }), adminEmails()]);
  const domain = url.searchParams.get('domain');
  const list = dir.visible.filter(a => a['@type'] === 'User' && (!domain || a.domain === domain.toLowerCase()));
  return { mailboxes: list.map(a => mailboxView(a, dir, admins)).sort((x, y) => x.email.localeCompare(y.email)) };
});

/** Domains of the same customer (aliases and members must stay within one customer). */
function sameCustomerDomains(dir, row) {
  return new Set(dir.rows.filter(r => r.customer_id === row.customer_id && r.status === 'active').map(r => r.domain));
}

function aliasPatch(list, dir, row, ownEmail) {
  if (!Array.isArray(list)) fail('Aliases must be a list of addresses.');
  const allowed = sameCustomerDomains(dir, row);
  const out = {};
  const seen = new Set();
  (Array.isArray(list) ? list : []).slice(0, 50).forEach(raw => {
    if (!String(raw || '').trim()) return;
    const { local, domain, email } = splitAddress(raw);
    if (email === ownEmail || seen.has(email)) return;
    if (!allowed.has(domain)) fail(`Aliases must use one of your verified domains (${email}).`);
    const ed = dir.domainByName.get(domain);
    if (!ed) fail(`${domain} is not ready yet.`);
    const taken = dir.accounts.find(a => a.email === email || aliasEmails(a, dir.domainById).includes(email));
    if (taken && taken.email !== ownEmail) fail(`${email} is already used by ${taken.email}.`);
    seen.add(email);
    out[String(Object.keys(out).length)] = { name: local, domainId: ed.id, enabled: true };
  });
  return out;
}

/** Plan limits: mailboxes up to max_mailboxes; teams (free) up to the same number. */
async function enforcePlan(row, dir, adding) {
  const plan = await planFor(row.customer_id);
  if (!plan) return null;
  if (adding && plan.max_mailboxes) {
    const domains = dir.rows.filter(r => r.customer_id === row.customer_id).map(r => r.domain);
    const type = adding === 'team' ? 'Group' : 'User';
    const n = dir.accounts.filter(a => a['@type'] === type && domains.includes(a.domain) && !protectedReason(a)).length;
    if (n >= plan.max_mailboxes) {
      fail(adding === 'team' ? `The ${plan.name} plan allows up to ${plan.max_mailboxes} teams. Ask IRON ID to change the plan.`
        : `The ${plan.name} plan includes ${plan.max_mailboxes} mailboxes, and all are in use. Ask IRON ID to change the plan.`);
    }
  }
  return plan;
}

/** One create at a time per customer, so two requests can't both pass the plan limit. */
const createLocks = new Map();
async function withCustomerLock(customerId, fn) {
  const prev = createLocks.get(customerId) || Promise.resolve();
  let release;
  const mine = new Promise(r => { release = r; });
  const chain = prev.then(() => mine);
  createLocks.set(customerId, chain);
  await prev;
  try { return await fn(); } finally { release(); if (createLocks.get(customerId) === chain) createLocks.delete(customerId); }
}

/** Storage limit in MB: what was asked, never above the plan's (empty = the plan's, or none without a plan). */
function quotaFor(value, plan) {
  const mb = optInt(value, { min: 50, max: 10 * 1024 * 1024, name: 'Storage (MB)' });
  const limit = plan && plan.mailbox_quota_mb;
  if (mb && limit && mb > limit) fail(`The plan allows up to ${limit} MB per mailbox.`);
  return mb || limit || null;
}

route('POST', '/admin-api/mailboxes', async (ctx, b) => {
  const { domain } = splitAddress(b.email);
  const row0 = (await db.query('SELECT customer_id FROM cp.customer_domains WHERE domain = $1', [domain])).rows[0];
  return withCustomerLock(row0 ? row0.customer_id : 'none', () => createMailbox(ctx, b));
});

async function createMailbox(ctx, b) {
  const { local, domain, email } = splitAddress(b.email);
  const dir = await scopedDirectory(ctx);
  const row = dir.owned.get(domain);
  if (!row) fail('Add and verify that domain first.', 404);
  if (row.status !== 'active') fail('Verify the domain before adding mailboxes.');
  const ed = dir.domainByName.get(domain);
  if (!ed) fail('Verify the domain before adding mailboxes.');
  if (dir.accounts.some(a => a.email === email || aliasEmails(a, dir.domainById).includes(email))) fail(`${email} already exists.`);
  const plan = await enforcePlan(row, dir, 'mailbox');
  const quotaMb = quotaFor(b.quotaMb, plan);
  const password = tempPassword();
  const res = await engineSet('Account', { create: { u: {
    '@type': 'User', name: local, domainId: ed.id, description: cleanText(b.name, 100) || null,
    roles: { '@type': 'User' }, permissions: { '@type': 'Inherit' }, encryptionAtRest: { '@type': 'Disabled' },
    quotas: quotaMb ? { maxDiskQuota: quotaMb * MB } : {},
    credentials: { 0: { '@type': 'Password', secret: password } }
  } } }, 'create the mailbox');
  audit(ctx, 'mailbox.created', email, { quotaMb }, row.customer_id);
  return { id: res.created.u.id, email, password };
}

route('POST', '/admin-api/mailboxes/update', async (ctx, b) => {
  const { a, dir, row } = await accountInScope(ctx, b.id, 'User');
  if (protectedReason(a)) fail(`${a.email} is managed by IRON ID staff (${protectedReason(a)}).`, 403);
  const patch = {};
  if (b.name !== undefined) patch.description = cleanText(b.name, 100) || null;
  if (b.quotaMb !== undefined) {
    const mb = quotaFor(b.quotaMb === '' ? null : b.quotaMb, await planFor(row.customer_id));
    patch.quotas = mb ? { maxDiskQuota: mb * MB } : {};
  }
  if (b.aliases !== undefined) patch.aliases = aliasPatch(b.aliases, dir, row, a.email);
  if (!Object.keys(patch).length) return { ok: true };
  await engineSet('Account', { update: { [a.id]: patch } }, 'save the mailbox');
  audit(ctx, 'mailbox.updated', a.email, { fields: Object.keys(patch) }, row.customer_id);
  return { ok: true };
});

/**
 * Mailboxes the caller may reset, suspend or delete: not engine-managed ones, not their own,
 * and (for customer admins) not one that holds admin rights anywhere else.
 */
async function guardChange(ctx, a, row) {
  if (protectedReason(a)) fail(`${a.email} is managed by IRON ID staff (${protectedReason(a)}).`, 403);
  if (a.email === ctx.email.toLowerCase()) fail('You cannot do this to your own mailbox from here. Use Settings → Security in the webmail.');
  if (!ctx.platform) {
    const rights = (await adminEmails()).filter(x => x.email === a.email);
    if (rights.some(x => x.role === 'platform' || x.customer_id !== row.customer_id)) fail(`${a.email} is an administrator elsewhere on IRON ID. Ask IRON ID support.`, 403);
  }
}

route('POST', '/admin-api/mailboxes/reset-signin', async (ctx, b) => {
  const { a, row } = await accountInScope(ctx, b.id, 'User', { withCredentials: true });
  await guardChange(ctx, a, row);
  const password = tempPassword();
  // Replacing the credentials sets a new password and removes two-step sign-in and every app password.
  await engineSet('Account', { update: { [a.id]: { credentials: { 0: { '@type': 'Password', secret: password } } } } }, 'reset the sign-in');
  await signOutEverywhere(a.email);
  audit(ctx, 'mailbox.signin_reset', a.email, { hadTwoStep: twoStepOn(a) }, row.customer_id);
  return { email: a.email, password };
});

route('POST', '/admin-api/mailboxes/suspend', async (ctx, b) => {
  const { a, row } = await accountInScope(ctx, b.id, 'User');
  await guardChange(ctx, a, row);
  const suspend = b.suspended === true;
  // Only sign-in is switched off or on; any other permission settings are kept.
  const cur = a.permissions && a.permissions['@type'] === 'Merge' ? a.permissions : { enabledPermissions: {}, disabledPermissions: {} };
  const disabled = { ...(cur.disabledPermissions || {}) };
  if (suspend) disabled.authenticate = true; else delete disabled.authenticate;
  const permissions = !Object.keys(disabled).length && !Object.keys(cur.enabledPermissions || {}).length
    ? { '@type': 'Inherit' }
    : { '@type': 'Merge', enabledPermissions: cur.enabledPermissions || {}, disabledPermissions: disabled };
  await engineSet('Account', { update: { [a.id]: { permissions } } }, suspend ? 'suspend the mailbox' : 'restore the mailbox');
  if (suspend) await signOutEverywhere(a.email);
  audit(ctx, suspend ? 'mailbox.suspended' : 'mailbox.restored', a.email, null, row.customer_id);
  return { ok: true };
});

route('POST', '/admin-api/mailboxes/delete', async (ctx, b) => {
  const { a, dir, row } = await accountInScope(ctx, b.id, 'User');
  await guardChange(ctx, a, row);
  if (String(b.confirm || '').toLowerCase() !== a.email) fail('Type the mailbox address to confirm.');
  const ed = dir.domainByName.get(a.domain);
  if (ed && ed.catchAllAddress && ed.catchAllAddress.toLowerCase() === a.email) {
    await engineSet('Domain', { update: { [ed.id]: { catchAllAddress: null } } }, 'clear the catch-all address');
  }
  await engineSet('Account', { destroy: [a.id] }, 'delete the mailbox');
  await signOutEverywhere(a.email);
  await db.query('DELETE FROM cp.labels WHERE email = $1', [a.email]).catch(() => {});
  // Admin rights belong to the mailbox: a new mailbox with the same address doesn't inherit them.
  await db.query('DELETE FROM cp.admins WHERE lower(email) = $1', [a.email]);
  audit(ctx, 'mailbox.deleted', a.email, null, row.customer_id);
  return { ok: true };
});

/* Teams (shared mailboxes). */
route('GET', '/admin-api/teams', async (ctx, b, url) => {
  const dir = await scopedDirectory(ctx);
  const domain = url.searchParams.get('domain');
  const list = dir.visible.filter(a => a['@type'] === 'Group' && (!domain || a.domain === domain.toLowerCase()));
  return { teams: list.map(g => teamView(g, dir)).sort((x, y) => x.email.localeCompare(y.email)) };
});

async function setMembers(g, dir, row, members) {
  if (!Array.isArray(members)) fail('Members must be a list of addresses.');
  const allowed = sameCustomerDomains(dir, row);
  const want = new Set();
  for (const raw of members.slice(0, 500)) {
    const email = cleanEmail(raw);
    const u = dir.accounts.find(a => a.email === email && a['@type'] === 'User');
    if (!u || !allowed.has(u.domain)) fail(`${email} is not one of your mailboxes.`);
    want.add(u.id);
  }
  const update = {};
  for (const u of dir.accounts.filter(a => a['@type'] === 'User')) {
    const has = !!(u.memberGroupIds && u.memberGroupIds[g.id]);
    if (has === want.has(u.id)) continue;
    if (want.has(u.id) && protectedReason(u)) fail(`${u.email} is managed by IRON ID staff and can't be added here.`);
    // A patch changes only this membership (others made at the same time are kept).
    update[u.id] = { ['memberGroupIds/' + g.id]: want.has(u.id) ? true : null };
  }
  if (Object.keys(update).length) await engineSet('Account', { update }, 'update the team members');
  return Object.keys(update).length;
}

route('POST', '/admin-api/teams', async (ctx, b) => {
  const { domain } = splitAddress(b.email);
  const row0 = (await db.query('SELECT customer_id FROM cp.customer_domains WHERE domain = $1', [domain])).rows[0];
  return withCustomerLock(row0 ? row0.customer_id : 'none', () => createTeam(ctx, b));
});

async function createTeam(ctx, b) {
  const { local, domain, email } = splitAddress(b.email);
  const dir = await scopedDirectory(ctx);
  const row = dir.owned.get(domain);
  if (!row) fail('Add and verify that domain first.', 404);
  const ed = dir.domainByName.get(domain);
  if (!ed || row.status !== 'active') fail('Verify the domain before adding teams.');
  if (dir.accounts.some(a => a.email === email || aliasEmails(a, dir.domainById).includes(email))) fail(`${email} already exists.`);
  const plan = await enforcePlan(row, dir, 'team');
  const quotaMb = plan && plan.mailbox_quota_mb;
  const res = await engineSet('Account', { create: { g: {
    '@type': 'Group', name: local, domainId: ed.id, description: cleanText(b.name, 100) || null,
    quotas: quotaMb ? { maxDiskQuota: quotaMb * MB } : {}
  } } }, 'create the team');
  const g = { id: res.created.g.id };
  if (Array.isArray(b.members) && b.members.length) await setMembers(g, await scopedDirectory(ctx), row, b.members);
  audit(ctx, 'team.created', email, { members: Array.isArray(b.members) ? b.members.length : 0 }, row.customer_id);
  return { id: g.id, email };
}

route('POST', '/admin-api/teams/update', async (ctx, b) => {
  const { a: g, dir, row } = await accountInScope(ctx, b.id, 'Group');
  const patch = {};
  if (b.name !== undefined) patch.description = cleanText(b.name, 100) || null;
  if (b.aliases !== undefined) patch.aliases = aliasPatch(b.aliases, dir, row, g.email);
  if (Object.keys(patch).length) await engineSet('Account', { update: { [g.id]: patch } }, 'save the team');
  let changed = 0;
  if (b.members !== undefined) changed = await setMembers(g, dir, row, b.members);
  audit(ctx, 'team.updated', g.email, { fields: Object.keys(patch), memberChanges: changed }, row.customer_id);
  return { ok: true };
});

route('POST', '/admin-api/teams/delete', async (ctx, b) => {
  const { a: g, dir, row } = await accountInScope(ctx, b.id, 'Group');
  if (String(b.confirm || '').toLowerCase() !== g.email) fail('Type the team address to confirm.');
  await setMembers(g, dir, row, []);
  const ed = dir.domainByName.get(g.domain);
  if (ed && ed.catchAllAddress && ed.catchAllAddress.toLowerCase() === g.email) {
    await engineSet('Domain', { update: { [ed.id]: { catchAllAddress: null } } }, 'clear the catch-all address');
  }
  await engineSet('Account', { destroy: [g.id] }, 'delete the team');
  audit(ctx, 'team.deleted', g.email, null, row.customer_id);
  return { ok: true };
});

/* Audit log. */
route('GET', '/admin-api/audit', async (ctx, b, url) => {
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 50));
  const before = url.searchParams.get('before');
  const kind = url.searchParams.get('kind'); // 'signin' | 'changes' | null
  const q = String(url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 100);
  const where = [], params = [];
  if (!ctx.platform) { params.push(ctx.customerIds); where.push(`customer_id = ANY($${params.length}::uuid[])`); }
  if (before && /^\d+$/.test(before)) { params.push(before); where.push(`id < $${params.length}`); }
  if (kind === 'signin') where.push(`action LIKE 'signin.%'`);
  if (kind === 'changes') where.push(`action NOT LIKE 'signin.%'`);
  if (q) { params.push('%' + q.replace(/[%_\\]/g, '\\$&') + '%'); where.push(`(lower(actor) LIKE $${params.length} OR lower(coalesce(target, '')) LIKE $${params.length} OR action LIKE $${params.length})`); }
  params.push(limit);
  const r = await db.query(
    `SELECT id, at, actor, action, target, details, ip FROM cp.audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC LIMIT $${params.length}`, params);
  return { entries: r.rows.map(x => ({ id: String(x.id), at: x.at, actor: x.actor, action: x.action, target: x.target, details: x.details, ip: x.ip })) };
});

/* Retention (platform-wide). */
route('GET', '/admin-api/retention', async ctx => {
  requirePlatform(ctx);
  const r = resultOf(await eng([['x:DataRetention/get', { ids: ['singleton'], properties: ['expungeTrashAfter'] }, 'g']]), 'g');
  const ms = r.list && r.list[0] ? r.list[0].expungeTrashAfter : null;
  return { trashDays: ms ? Math.round(ms / DAY) : null };
});

route('POST', '/admin-api/retention', async (ctx, b) => {
  requirePlatform(ctx);
  const days = optInt(b.trashDays, { min: 1, max: 3650, name: 'Days' });
  if (!days) fail('Enter a number of days.');
  await engineSet('DataRetention', { update: { singleton: { expungeTrashAfter: days * DAY } } }, 'save the retention rule');
  audit(ctx, 'retention.updated', 'trash', { days });
  return { ok: true };
});

/* Usage and billing estimate. */
route('GET', '/admin-api/usage', async ctx => {
  const [dir, customers] = await Promise.all([scopedDirectory(ctx), customersWithPlans(ctx)]);
  return { usage: customers.map(c => usageFor(c, dir)) };
});

/* ——— Entry point ——— */
async function handle(req, res, url, { readJson, sendJson, sendBodyError, isCrossSite, session, ip }) {
  const key = req.method + ' ' + url.pathname;
  const fn = routes[key];
  if (!fn) return sendJson(res, 404, { error: 'Not found' });
  if (req.method === 'POST') {
    if (isCrossSite(req)) return sendJson(res, 403, { error: 'Forbidden' });
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return sendJson(res, 415, { error: 'JSON expected' });
  }
  if (!session) return sendJson(res, 401, { error: 'Please sign in with your mailbox.' });
  let ctx;
  try { ctx = await adminFor(session.email); } catch (e) { return sendJson(res, 503, { error: 'The server is starting. Please try again in a moment.' }); }
  if (!ctx) return sendJson(res, 403, { error: 'This mailbox is not an administrator.' });
  ctx.ip = ip;
  ctx.session = session;
  let body = {};
  if (req.method === 'POST') {
    try { body = await readJson(req, 100000); } catch (e) { return sendBodyError(res, e); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'Invalid request' });
  }
  try {
    return sendJson(res, 200, await fn(ctx, body, url));
  } catch (e) {
    if (e.userError) return sendJson(res, e.status || 400, { error: e.message });
    console.error('[admin] ' + key + ':', e.message);
    return sendJson(res, 502, { error: 'The mail server could not complete this. Please try again.' });
  }
}

/** Mailbox → whether it may open the admin console (for the webmail's Admin link). */
async function isAdmin(email) {
  try { return !!(await adminFor(email)); } catch (e) { return false; }
}

/** The teams (shared mailboxes) a person belongs to, with their members (for assigning mail). */
async function teamsFor(email) {
  const dir = await engineDirectory();
  const me = dir.accounts.find(a => a.email === String(email).toLowerCase() && a['@type'] === 'User');
  if (!me) return [];
  return Object.keys(me.memberGroupIds || {}).map(gid => dir.accounts.find(a => a.id === gid)).filter(Boolean).map(g => ({
    email: g.email, name: g.description || '',
    members: dir.accounts.filter(a => a['@type'] === 'User' && a.memberGroupIds && a.memberGroupIds[g.id] && !isSuspended(a))
      .map(a => ({ email: a.email, name: a.description || '' })).sort((x, y) => x.email.localeCompare(y.email))
  }));
}

module.exports = { handle, auditSignIn, pruneAudit, isAdmin, teamsFor, customerForEmail, PLATFORM_DOMAIN, tempPassword };
