/**
 * Own domains from the webmail ("Pro" mail): a person with a name@iron-id.io mailbox connects a domain
 * they own (€2: DNS set-up + copy of their old mail) or buys one through IRON ID (€14 a year), then
 * creates addresses on it (contact@company.fr…) that arrive in the same mailbox and share its storage.
 *
 * Each person who does this gets a "personal" customer (cp.customers kind='personal') that owns their
 * domains and orders, so IRON ID staff see them in the admin console like any other client. The domain
 * work itself (claim, DNS records, verification, signing keys) reuses the admin console's routes.
 */
const db = require('./db');
const dnsCheck = require('./dnsCheck');
const billing = require('./billing');
const registrar = require('./registrar');
const security = require('./accountSecurity');
const adminConsole = require('./adminConsole');

const PLATFORM_DOMAIN = adminConsole.PLATFORM_DOMAIN;
const MAX_ADDRESSES = 20;     // own-domain addresses per person
const RENEW_DAYS = 30;        // renewal opens this many days before the end of the year paid for

class DomainError extends Error {
  constructor(message, status = 400, extra = {}) { super(message); this.status = status; this.userError = true; Object.assign(this, extra); }
}
const fail = (m, s, x) => { throw new DomainError(m, s, x); };

const SYSTEM = { email: 'system', platform: true, customerIds: null, customers: [], ip: null };
const ctxFor = (email, customerId, ip) => ({ email, platform: false, customerIds: [customerId], customers: [], ip });

/* ——— The person's own customer ——— */
async function personalCustomer(email, { create = false, name = null } = {}) {
  const e = String(email).toLowerCase();
  const r = await db.query(`SELECT * FROM cp.customers WHERE kind = 'personal' AND lower(owner_email) = $1`, [e]);
  if (r.rows[0] || !create) return r.rows[0] || null;
  const ins = await db.query(`INSERT INTO cp.customers (name, contact_email, kind, owner_email) VALUES ($1, $2, 'personal', $2)
                              ON CONFLICT DO NOTHING RETURNING *`, [String(name || e).slice(0, 120), e]);
  if (ins.rows[0]) {
    db.audit({ actor: e, customerId: ins.rows[0].id, action: 'customer.created', target: ins.rows[0].name, details: { kind: 'personal' } }).catch(() => {});
    return ins.rows[0];
  }
  return (await db.query(`SELECT * FROM cp.customers WHERE kind = 'personal' AND lower(owner_email) = $1`, [e])).rows[0];
}

function ownMailboxOnly(email) {
  if (!String(email).toLowerCase().endsWith('@' + PLATFORM_DOMAIN)) fail(`Own domains are available for ${PLATFORM_DOMAIN} mailboxes.`, 403);
}

/* ——— Checks ——— */
async function domainInUse(domain) {
  const claim = (await db.query('SELECT customer_id, status, created_at FROM cp.customer_domains WHERE domain = $1', [domain])).rows[0];
  if (claim && !(claim.status === 'pending' && Date.now() - new Date(claim.created_at).getTime() > 7 * 86400000)) return true;
  const dir = await adminConsole.engineDirectory();
  return !!dir.domainByName.get(domain);
}

async function checkConnect(email, b) {
  ownMailboxOnly(email);
  const domain = adminConsole.cleanDomain(b.domain);
  if (domain === PLATFORM_DOMAIN || domain.endsWith('.' + PLATFORM_DOMAIN)) fail(`${PLATFORM_DOMAIN} belongs to IRON ID.`);
  if (await domainInUse(domain)) fail('This domain is already on IRON ID. If it is yours, contact IRON ID support.', 409);
  const [ns, mx] = await Promise.all([dnsCheck.lookup(domain, 'NS').catch(() => []), dnsCheck.lookup(domain, 'MX').catch(() => [])]);
  if (!ns.length) fail('This domain does not seem to exist yet (no name servers found). Check the spelling, or buy it below.', 400, { code: 'nodomain' });
  return { domain, nameservers: ns.map(x => x.toLowerCase()).sort(), mx: mx.map(x => x.toLowerCase()) };
}

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
async function search(email, q) {
  ownMailboxOnly(email);
  const s = await billing.settings();
  const raw = String(q || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  const [label, ...rest] = raw.split('.');
  if (!LABEL_RE.test(label || '')) fail('Use letters, numbers and dashes (for example: my-company).', 400, { code: 'name' });
  const wanted = rest.join('.');
  const tlds = wanted && s.tlds.includes(wanted) ? [wanted, ...s.tlds.filter(t => t !== wanted)] : s.tlds;
  const price = billing.amounts(s.prices.domain_register, s);
  const results = await Promise.all(tlds.map(async tld => {
    const domain = `${label}.${tld}`;
    let available = false;
    try { available = !(await domainInUse(domain)) && await registrar.available(domain); } catch (e) {
      if (e.userError) throw e;
      console.error('[domains] availability', domain, e.message);
      return { domain, available: null };
    }
    return { domain, available, priceCents: price.ttc };
  }));
  return { results, currency: s.currency, sells: s.tlds, unsupported: wanted && !s.tlds.includes(wanted) ? wanted : undefined };
}

/* ——— Orders ——— */
function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  return `${proto}://${req.headers.host}`;
}

async function connect(email, b, { req, lang, name }) {
  const info = await checkConnect(email, b);
  if (b.acceptTerms !== true) fail('Please accept the Terms of Sale to continue.');
  const cust = await personalCustomer(email, { create: true, name });
  const open = (await db.query(`SELECT id FROM cp.orders WHERE customer_id = $1 AND domain = $2 AND kind IN ('domain_connect','domain_register')
                                AND status IN ('paid','fulfilled') LIMIT 1`, [cust.id, info.domain])).rows[0];
  if (open) fail('You have already paid for this domain.', 409);
  return billing.createOrder({ customerId: cust.id, email, kind: 'domain_connect', domain: info.domain, details: { name }, lang, baseUrl: baseUrl(req) });
}

const CONTACT_FIELDS = { firstName: 60, lastName: 60, organisation: 100, address: 120, city: 60, postalCode: 16, country: 2, phone: 24, email: 254, region: 60 };
function cleanContact(c, email) {
  if (!c || typeof c !== 'object') fail('Enter the owner’s details.', 400, { code: 'contact' });
  const out = {};
  for (const [k, max] of Object.entries(CONTACT_FIELDS)) out[k] = String(c[k] == null ? '' : c[k]).replace(/[\u0000-\u001f\u007f<>"]/g, ' ').trim().slice(0, max);
  out.country = out.country.toUpperCase();
  out.email = out.email || email;
  for (const k of ['firstName', 'lastName', 'address', 'city', 'postalCode', 'country', 'phone']) if (!out[k]) fail('Fill in every required field of the owner’s details.', 400, { code: 'contact', field: k });
  if (!/^[A-Z]{2}$/.test(out.country)) fail('Choose the country.', 400, { code: 'contact', field: 'country' });
  // Registries want +CC.NUMBER (for example +33.612345678).
  const digits = out.phone.replace(/[^\d+]/g, '');
  const m = /^\+(\d{1,3})(\d{4,14})$/.exec(digits.startsWith('+') ? digits : (digits.startsWith('0') && out.country === 'FR' ? '+33' + digits.slice(1) : '+' + digits));
  if (!m) fail('Enter the phone number with its country code, for example +33 6 12 34 56 78.', 400, { code: 'contact', field: 'phone' });
  out.phone = `+${m[1]}.${m[2]}`;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) fail('Enter a valid email address for the owner.', 400, { code: 'contact', field: 'email' });
  return out;
}

async function buy(email, b, { req, lang, name }) {
  ownMailboxOnly(email);
  const s = await billing.settings();
  const domain = adminConsole.cleanDomain(b.domain);
  const tld = domain.split('.').slice(1).join('.');
  if (domain.split('.').length !== 2 || !s.tlds.includes(tld)) fail(`IRON ID sells domains ending in ${s.tlds.map(t => '.' + t).join(', ')}.`);
  const contact = cleanContact(b.contact, email);
  if (['fr', 'eu'].includes(tld) && !EU.has(contact.country)) fail(`.${tld} domains need an owner in the European Union.`, 400, { code: 'contact', field: 'country' });
  if (b.acceptTerms !== true) fail('Please accept the Terms of Sale to continue.');
  if (await domainInUse(domain) || !(await registrar.available(domain))) fail('This domain is no longer available.', 409, { code: 'taken' });
  const cust = await personalCustomer(email, { create: true, name: name || `${contact.firstName} ${contact.lastName}` });
  return billing.createOrder({
    customerId: cust.id, email, kind: 'domain_register', domain, lang, baseUrl: baseUrl(req),
    details: { contact, name: `${contact.firstName} ${contact.lastName}`, address: contact.address, postalCode: contact.postalCode, city: contact.city, country: contact.country }
  });
}
const EU = new Set('AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO'.split(' '));

async function renew(email, b, { req, lang }) {
  const cust = await personalCustomer(email);
  const domain = adminConsole.cleanDomain(b.domain);
  const reg = cust && (await db.query('SELECT * FROM cp.registered_domains WHERE domain = $1 AND customer_id = $2', [domain, cust.id])).rows[0];
  if (!reg) fail('That domain was not found.', 404);
  const daysLeft = (new Date(reg.expires_at).getTime() - Date.now()) / 86400000;
  if (daysLeft > RENEW_DAYS) fail(`You can renew from ${RENEW_DAYS} days before the end of the year already paid.`);
  if (daysLeft < -30) fail('This domain has expired for too long to be renewed here. Contact IRON ID support.');
  return billing.createOrder({ customerId: cust.id, email, kind: 'domain_renew', domain, lang, baseUrl: baseUrl(req), details: { name: cust.name } });
}

/* ——— Delivering paid orders ——— */
billing.onPaid('domain_connect', async order => {
  // Claim the domain for the person's customer: they then publish the DNS records and verify.
  await adminConsole.runRoute(ctxFor(order.email, order.customer_id, null), 'POST', '/admin-api/domains', { domain: order.domain, customerId: order.customer_id });
});

billing.onPaid('domain_register', async order => {
  const c = order.details.contact;
  const already = (await db.query('SELECT 1 FROM cp.registered_domains WHERE domain = $1', [order.domain])).rows[0];
  if (!already) {
    const reg = await registrar.register(order.domain, c);
    await db.query(`INSERT INTO cp.registered_domains (domain, customer_id, registrar, registrar_ref, expires_at)
                    VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 year')`, [order.domain, order.customer_id, registrar.kind(), reg.ref]);
  }
  // We hold the domain, so no ownership check is needed: claim, create it in the engine with signing keys,
  // and publish its records on the registrar's DNS.
  const row = (await db.query('SELECT status FROM cp.customer_domains WHERE domain = $1', [order.domain])).rows[0];
  if (!row) await adminConsole.runRoute(ctxFor(order.email, order.customer_id, null), 'POST', '/admin-api/domains', { domain: order.domain, customerId: order.customer_id });
  if (!row || row.status === 'pending') await adminConsole.runRoute(SYSTEM, 'POST', '/admin-api/domains/verify', { domain: order.domain, skipCheck: true });
  await publishDns(order.domain);
});

billing.onPaid('domain_renew', async order => {
  const reg = (await db.query('SELECT * FROM cp.registered_domains WHERE domain = $1', [order.domain])).rows[0];
  if (!reg) throw new Error('not a domain registered through IRON ID');
  await registrar.renew(order.domain, new Date(reg.expires_at).getUTCFullYear());
  await db.query(`UPDATE cp.registered_domains SET expires_at = expires_at + INTERVAL '1 year', status = 'active', reminded_at = NULL WHERE domain = $1`, [order.domain]);
});

async function publishDns(domain) {
  const dns = await adminConsole.runRoute(SYSTEM, 'GET', '/admin-api/domains/dns', {}, new URL('http://x/admin-api/domains/dns?domain=' + encodeURIComponent(domain)));
  const records = dns.records.filter(r => r.id !== 'verify').map(r => {
    if (r.type === 'MX') { const [prio, host] = r.value.split(/\s+/); return { type: 'MX', host: r.host, value: host, priority: Number(prio) }; }
    return { type: r.type, host: r.host, value: r.value };
  });
  await registrar.setDns(domain, records);
}

/* ——— Addresses on own domains (aliases of the person's mailbox) ——— */
async function myAccount(email) {
  const dir = await adminConsole.engineDirectory();
  const a = dir.accounts.find(x => x.email === String(email).toLowerCase() && x['@type'] === 'User');
  if (!a) fail('Your mailbox was not found.', 404);
  return { a, dir };
}

async function ownedActiveDomains(customerId) {
  if (!customerId) return new Set();
  const r = await db.query(`SELECT domain FROM cp.customer_domains WHERE customer_id = $1 AND status = 'active'`, [customerId]);
  return new Set(r.rows.map(x => x.domain));
}

async function addAddress(current, b) {
  ownMailboxOnly(current.email);
  const cust = await personalCustomer(current.email);
  const { local, domain, email } = adminConsole.splitAddress(`${String(b.local || '').trim().toLowerCase()}@${String(b.domain || '').trim().toLowerCase()}`);
  if (!(await ownedActiveDomains(cust && cust.id)).has(domain)) fail('Connect and verify that domain first.', 400);
  const { a, dir } = await myAccount(current.email);
  const mine = adminConsole.aliasEmails(a, dir.domainById);
  if (mine.length >= MAX_ADDRESSES) fail(`You can have up to ${MAX_ADDRESSES} addresses on your own domains.`);
  const used = dir.accounts.find(x => x.email === email || adminConsole.aliasEmails(x, dir.domainById).includes(email));
  if (used) fail(used.id === a.id ? 'You already have this address.' : 'This address is already used.', 409);
  const ed = dir.domainByName.get(domain);
  const aliases = Object.values(a.aliases || {}).concat([{ name: local, domainId: ed.id, enabled: true }]);
  await adminConsole.engineSet('Account', { update: { [a.id]: { aliases: Object.fromEntries(aliases.map((x, i) => [String(i), x])) } } }, 'save the mailbox');
  // So the address can be chosen as "From" in the webmail.
  await identity(current, 'create', email, a.description).catch(e => console.error('[domains] identity', email, e.message));
  db.audit({ actor: current.email, customerId: cust.id, action: 'address.added', target: email }).catch(() => {});
  return { ok: true, email };
}

async function removeAddress(current, b) {
  const email = String(b.email || '').trim().toLowerCase();
  const { a, dir } = await myAccount(current.email);
  const keep = Object.values(a.aliases || {}).filter(x => {
    const d = dir.domainById.get(x.domainId);
    return !(d && `${x.name}@${d.name}`.toLowerCase() === email);
  });
  if (keep.length === Object.keys(a.aliases || {}).length) fail('That address was not found.', 404);
  await adminConsole.engineSet('Account', { update: { [a.id]: { aliases: Object.fromEntries(keep.map((x, i) => [String(i), x])) } } }, 'save the mailbox');
  await identity(current, 'destroy', email).catch(e => console.error('[domains] identity', email, e.message));
  const cust = await personalCustomer(current.email);
  db.audit({ actor: current.email, customerId: cust && cust.id, action: 'address.removed', target: email }).catch(() => {});
  return { ok: true };
}

const MAIL_USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'];
async function identity(current, op, email, name) {
  const session = await security.engineSession(current.auth);
  const accountId = session && session.primaryAccounts['urn:ietf:params:jmap:submission'];
  if (!accountId) return;
  const got = security.first(await security.jmap(current.auth, [['Identity/get', { accountId }, 'g']], MAIL_USING), 'g').list || [];
  const existing = got.filter(i => String(i.email).toLowerCase() === email);
  if (op === 'create' && !existing.length) {
    security.first(await security.jmap(current.auth, [['Identity/set', { accountId, create: { i: { email, name: name || '' } } }, 's']], MAIL_USING), 's');
  } else if (op === 'destroy' && existing.length) {
    security.first(await security.jmap(current.auth, [['Identity/set', { accountId, destroy: existing.map(i => i.id) }, 's']], MAIL_USING), 's');
  }
}

async function removeDomain(current, b) {
  const cust = await personalCustomer(current.email);
  if (!cust) fail('That domain was not found.', 404);
  const domain = adminConsole.cleanDomain(b.domain);
  // Its addresses go first (they are aliases of this mailbox).
  const { a, dir } = await myAccount(current.email);
  for (const e of adminConsole.aliasEmails(a, dir.domainById).filter(x => x.endsWith('@' + domain))) await removeAddress(current, { email: e });
  return adminConsole.runRoute(ctxFor(current.email, cust.id, null), 'POST', '/admin-api/domains/remove', { domain, confirm: b.confirm });
}

/** The person left the payment page without paying: the order is closed (a new one can be made). */
async function cancelOrder(current, b) {
  const cust = await personalCustomer(current.email);
  const r = cust && await db.query(`UPDATE cp.orders SET status = 'cancelled' WHERE id = $1 AND customer_id = $2 AND status = 'pending' RETURNING id`, [Number(b.id), cust.id]);
  if (!r || !r.rowCount) fail('That order was not found.', 404);
  return { ok: true };
}

/* ——— Reading ——— */
async function overview(current) {
  const prices = await billing.priceList();
  const cust = await personalCustomer(current.email);
  if (!cust) return { prices, domains: [], orders: [], addresses: [] };
  const [rows, regs, orders, acct] = await Promise.all([
    db.query('SELECT domain, status, created_at, verified_at FROM cp.customer_domains WHERE customer_id = $1 ORDER BY domain', [cust.id]),
    db.query('SELECT domain, expires_at, status FROM cp.registered_domains WHERE customer_id = $1', [cust.id]),
    billing.ordersFor(cust.id),
    myAccount(current.email).catch(() => null)
  ]);
  const regBy = new Map(regs.rows.map(r => [r.domain, r]));
  const addresses = acct ? adminConsole.aliasEmails(acct.a, acct.dir.domainById) : [];
  const domains = rows.rows.map(r => {
    const reg = regBy.get(r.domain);
    return {
      domain: r.domain, status: r.status, verifiedAt: r.verified_at, bought: !!reg,
      expiresAt: reg ? reg.expires_at : null, renewable: reg ? (new Date(reg.expires_at) - Date.now()) / 86400000 <= RENEW_DAYS : false,
      addresses: addresses.filter(x => x.endsWith('@' + r.domain))
    };
  });
  // Paid orders not delivered yet, and payments still open, appear as "being set up" / "waiting for payment".
  for (const o of orders) {
    if (['domain_connect', 'domain_register'].includes(o.kind) && !domains.some(d => d.domain === o.domain) && ['pending', 'paid', 'failed'].includes(o.status)) {
      domains.push({ domain: o.domain, status: o.status === 'pending' ? 'awaiting_payment' : o.status === 'failed' ? 'problem' : 'setting_up', orderId: o.id, bought: o.kind === 'domain_register', addresses: [] });
    }
  }
  return { prices, domains, orders, addresses };
}

/** Domains bought through IRON ID whose paid year ends soon (shown as a notice in the webmail). */
async function notices(email) {
  const cust = await personalCustomer(email);
  if (!cust) return [];
  const r = await db.query(`SELECT domain, expires_at FROM cp.registered_domains WHERE customer_id = $1 AND expires_at < NOW() + INTERVAL '${RENEW_DAYS} days'`, [cust.id]);
  return r.rows.map(x => ({ domain: x.domain, expiresAt: x.expires_at, expired: new Date(x.expires_at) < new Date() }));
}

/** Daily: marks domains past their paid year as expired. */
async function expireDomains() {
  try {
    // Payment pages that were never completed (Stripe's own expire after an hour).
    await db.query(`UPDATE cp.orders SET status = 'cancelled' WHERE status = 'pending' AND created_at < NOW() - INTERVAL '1 day'`);
    const r = await db.query(`UPDATE cp.registered_domains SET status = 'expired' WHERE status = 'active' AND expires_at < NOW() RETURNING domain`);
    for (const x of r.rows) db.audit({ actor: 'system', action: 'domain.expired', target: x.domain }).catch(() => {});
  } catch (e) { console.error('[domains] expiry check:', e.message); }
}

module.exports = {
  personalCustomer, checkConnect, search, connect, buy, renew, addAddress, removeAddress, removeDomain, overview, notices,
  publishDns, expireDomains, cleanContact, cancelOrder, DomainError, MAX_ADDRESSES
};
