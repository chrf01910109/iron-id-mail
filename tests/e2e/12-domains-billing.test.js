// Own domains from the webmail, with payments: buy a domain (€14/year) or connect one (€2), addresses on
// it in the same mailbox, the copy of an old mailbox (IMAP), invoices, and the admin console's Payments.
// Needs the gateway started with PAYMENTS_FAKE=true, REGISTRAR=fake, IRONID_MIGRATION_TEST=true and
// IRONID_DNS_FAKE=<file> (the same file as DNS_FAKE_FILE here); PLATFORM_ADMINS must include e2e-platform-admin@.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const h = require('./helpers');

const DNS_FAKE = process.env.DNS_FAKE_FILE || '';
const tag = crypto.randomBytes(3).toString('hex');
const BUY = `mybiz${tag}.fr`;
const OWN = `own${tag}.test`;
let owner, friend, oldbox, platform, O, F, P;
const XF = n => ({ 'x-forwarded-for': `198.51.101.${n}` });

function setDns(name, type, values) {
  let d = {};
  try { d = JSON.parse(fs.readFileSync(DNS_FAKE, 'utf8')); } catch (e) { /* new */ }
  d[`${name}|${type}`] = values;
  fs.writeFileSync(DNS_FAKE, JSON.stringify(d));
}
const acct = path => h.gw('/account/' + path, { cookie: O });
const post = (path, body, cookie = O) => h.gw('/account/' + path, { method: 'POST', cookie, body });

async function pay(checkoutUrl) {
  const u = new URL(checkoutUrl, h.BASE);
  const page = await h.gw(u.pathname + u.search);
  assert.equal(page.status, 200, 'fake checkout page');
  const r = await fetch(h.BASE + '/billing/fake-pay', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ order: u.searchParams.get('order'), sig: u.searchParams.get('sig') }).toString() });
  assert.equal(r.status, 303);
  return Number(u.searchParams.get('order'));
}
async function waitFor(fn, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await h.sleep(1000); }
}

before(async () => {
  assert.ok(DNS_FAKE, 'DNS_FAKE_FILE must be set');
  await h.waitHealthy(120000, { requireAdmin: true });
  const hz = await h.gw('/healthz');
  assert.equal(hz.json.payments, 'fake', 'start the gateway with PAYMENTS_FAKE=true');
  assert.equal(hz.json.registrar, 'fake', 'start the gateway with REGISTRAR=fake');
  [owner, friend, oldbox, platform] = await Promise.all([h.createTestUser('dom-owner'), h.createTestUser('dom-friend'), h.createTestUser('dom-old'), h.createTestUser('e2e-platform-admin', { exactName: true })]);
  O = (await h.login(owner.email, owner.password, XF(1))).cookie;
  F = (await h.login(friend.email, friend.password, XF(2))).cookie;
  P = (await h.login(platform.email, platform.password, XF(3))).cookie;
});

after(async () => {
  for (const d of [BUY, OWN]) await post('domains/remove', { domain: d, confirm: d }).catch(() => {});
  for (const u of [owner, friend, oldbox, platform]) await h.deleteTestUser(u);
});

test('prices: €2 to connect, €14 a year to buy, VAT 20% included', async () => {
  const r = await acct('domains');
  assert.equal(r.status, 200, r.text);
  const p = r.json.prices;
  assert.equal(p.currency, 'EUR');
  assert.equal(p.vatRate, 20);
  assert.deepEqual(p.prices.domain_connect, { ttc: 200, ht: 167, vat: 33, rate: 20 });
  assert.deepEqual(p.prices.domain_register, { ttc: 1400, ht: 1167, vat: 233, rate: 20 });
  assert.deepEqual(p.tlds, ['fr', 'com', 'net', 'org', 'eu']);
  assert.deepEqual(r.json.domains, []);
});

test('searching for a domain to buy', async () => {
  const r = await acct('domains/search?q=' + encodeURIComponent(`mybiz${tag}`));
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.results.map(x => x.domain), ['fr', 'com', 'net', 'org', 'eu'].map(t => `mybiz${tag}.${t}`));
  assert.ok(r.json.results.every(x => x.available === true && x.priceCents === 1400));
  const taken = await acct('domains/search?q=taken' + tag + '.com');
  assert.equal(taken.json.results[0].domain, `taken${tag}.com`, 'the ending asked for comes first');
  assert.equal(taken.json.results[0].available, false);
  assert.equal((await acct('domains/search?q=' + encodeURIComponent('bad name!'))).status, 400);
  const io = await acct('domains/search?q=mybiz' + tag + '.io');
  assert.equal(io.json.unsupported, 'io');
});

const CONTACT = { firstName: 'Karim', lastName: 'Benali', address: '10 rue de la Paix', city: 'Paris', postalCode: '75002', country: 'FR', phone: '06 12 34 56 78' };

test('buying a domain: details checked, paid once, registered, invoice', async () => {
  let r = await post('domains/buy', { domain: BUY, contact: { ...CONTACT, phone: '' }, acceptTerms: true });
  assert.equal(r.status, 400); assert.equal(r.json.code, 'contact'); assert.equal(r.json.field, 'phone');
  r = await post('domains/buy', { domain: BUY, contact: { ...CONTACT, country: 'DZ' }, acceptTerms: true });
  assert.equal(r.status, 400); assert.match(r.json.error, /European Union/);
  r = await post('domains/buy', { domain: `mybiz${tag}.io`, contact: CONTACT, acceptTerms: true });
  assert.equal(r.status, 400);
  r = await post('domains/buy', { domain: BUY, contact: CONTACT });
  assert.equal(r.status, 400, 'terms of sale');
  r = await post('domains/buy', { domain: BUY, contact: CONTACT, acceptTerms: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.order.amountCents, 1400);
  assert.equal(r.json.order.status, 'pending');
  assert.match(r.json.checkoutUrl, /\/billing\/fake-checkout\?order=\d+&sig=[0-9a-f]{64}$/);

  let o = await acct('domains');
  assert.equal(o.json.domains.find(d => d.domain === BUY).status, 'awaiting_payment');
  // A forged checkout link is refused.
  const forged = new URL(r.json.checkoutUrl, h.BASE); forged.searchParams.set('sig', 'a'.repeat(64));
  assert.equal((await h.gw(forged.pathname + forged.search)).status, 404);

  const id = await pay(r.json.checkoutUrl);
  o = await acct('domains');
  const d = o.json.domains.find(x => x.domain === BUY);
  assert.equal(d.status, 'active', JSON.stringify(o.json));
  assert.equal(d.bought, true);
  assert.ok(new Date(d.expiresAt) - Date.now() > 360 * 86400000, 'paid for a year');
  const order = o.json.orders.find(x => x.id === id);
  assert.equal(order.status, 'fulfilled');
  assert.match(order.invoiceNumber, /^F\d{4}-\d{6}$/);

  // Paying again (a notification sent twice) changes nothing.
  await pay(r.json.checkoutUrl);
  const again = (await acct('domains')).json.orders.find(x => x.id === id);
  assert.equal(again.invoiceNumber, order.invoiceNumber);

  const inv = await h.gw('/account/invoice?id=' + id, { cookie: O });
  assert.equal(inv.status, 200);
  assert.match(inv.text, new RegExp(order.invoiceNumber));
  assert.match(inv.text, /(TVA|VAT) 20 %/);
  assert.match(inv.text, /14,00/);
  assert.equal((await h.gw('/account/invoice?id=' + id, { cookie: F })).status, 404, 'not someone else’s invoice');
  // Buying the same domain again: no longer available.
  assert.equal((await post('domains/buy', { domain: BUY, contact: CONTACT, acceptTerms: true })).status, 409);
});

test('addresses on the domain arrive in the same mailbox and can be used as sender', async () => {
  let r = await post('addresses', { local: 'contact', domain: BUY });
  assert.equal(r.status, 200, r.text);
  assert.equal((await post('addresses', { local: 'contact', domain: BUY })).status, 409);
  assert.equal((await post('addresses', { local: 'x', domain: 'not-mine.fr' })).status, 400);
  const accId = await h.primaryAccount(O);
  const ids = (await h.mail(O, [['Identity/get', { accountId: accId }, 'i']]))[0][1].list;
  assert.ok(ids.some(i => i.email === `contact@${BUY}`), 'can send as contact@');

  await h.sendMail(F, { from: friend.email, to: [`contact@${BUY}`], subject: 'Hello business ' + tag, text: 'Hi' });
  await waitFor(async () => {
    const res = await h.mail(O, [['Email/query', { accountId: accId, filter: { subject: 'Hello business ' + tag } }, 'q']]);
    return res[0][1].ids.length > 0;
  });
  const o = await acct('domains');
  assert.deepEqual(o.json.domains.find(x => x.domain === BUY).addresses, [`contact@${BUY}`]);
  r = await post('addresses/remove', { email: `contact@${BUY}` });
  assert.equal(r.status, 200, r.text);
  const ids2 = (await h.mail(O, [['Identity/get', { accountId: accId }, 'i']]))[0][1].list;
  assert.ok(!ids2.some(i => i.email === `contact@${BUY}`));
});

test('connecting a domain you own: €2, DNS records, verification, then addresses', async () => {
  let r = await post('domains/check', { domain: OWN });
  assert.equal(r.status, 400); assert.equal(r.json.code, 'nodomain');
  setDns(OWN, 'NS', ['ns1.some-host.test', 'ns2.some-host.test']);
  r = await post('domains/check', { domain: OWN });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.nameservers, ['ns1.some-host.test', 'ns2.some-host.test']);
  assert.equal((await post('domains/check', { domain: 'iron-id.io' })).status, 400);

  assert.equal((await post('domains/connect', { domain: OWN })).status, 400, 'terms of sale');
  r = await post('domains/connect', { domain: OWN, acceptTerms: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.order.amountCents, 200);
  await pay(r.json.checkoutUrl);
  let o = await acct('domains');
  assert.equal(o.json.domains.find(x => x.domain === OWN).status, 'pending');
  // Someone else can't take it any more.
  assert.equal((await post('domains/check', { domain: OWN }, F)).status, 409);

  const dns = await acct('domains/dns?domain=' + OWN);
  assert.equal(dns.status, 200, dns.text);
  const verify = dns.json.records.find(x => x.id === 'verify');
  assert.match(verify.value, /^iron-id-verification=/);
  assert.equal((await post('domains/verify', { domain: OWN })).status, 400, 'not published yet');
  setDns(OWN, 'TXT', [verify.value]);
  r = await post('domains/verify', { domain: OWN });
  assert.equal(r.status, 200, r.text);
  o = await acct('domains');
  assert.equal(o.json.domains.find(x => x.domain === OWN).status, 'active');
  assert.equal((await post('addresses', { local: 'hello', domain: OWN })).status, 200);
});

test('copying an old mailbox (IMAP): folders, dates, read state; wrong password refused', async () => {
  // The old mailbox: two messages in the inbox and one (read) in a folder "Projects".
  const OB = (await h.login(oldbox.email, oldbox.password, XF(4))).cookie;
  await h.sendMail(F, { from: friend.email, to: [oldbox.email], subject: 'Old one ' + tag, text: '1' });
  await h.sendMail(F, { from: friend.email, to: [oldbox.email], subject: 'Old two ' + tag, text: '2' });
  const ob = await h.primaryAccount(OB);
  const mk = await h.mail(OB, [['Mailbox/set', { accountId: ob, create: { p: { name: 'Projects ' + tag } } }, 'm']]);
  const projects = mk[0][1].created.p.id;
  await h.mail(OB, [['Email/set', { accountId: ob, create: { e: { mailboxIds: { [projects]: true }, keywords: { $seen: true }, from: [{ email: friend.email }],
    subject: 'Old project ' + tag, receivedAt: '2024-03-01T10:00:00Z', bodyValues: { b: { value: 'p' } }, textBody: [{ partId: 'b', type: 'text/plain' }] } } }, 'e']]);
  await waitFor(async () => (await h.mail(OB, [['Email/query', { accountId: ob, filter: { text: tag } }, 'q']]))[0][1].ids.length >= 3);

  // Only with the €2 service.
  assert.equal((await post('migrations', { host: '127.0.0.1', port: 993, username: oldbox.email, password: oldbox.password }, F)).status, 403);
  let r = await post('migrations', { host: '127.0.0.1', port: 993, username: oldbox.email, password: 'wrong-' + tag });
  assert.equal(r.status, 400); assert.equal(r.json.code, 'login');
  assert.equal((await post('migrations', { host: '127.0.0.1', port: 25, username: oldbox.email, password: 'x' })).status, 400, 'IMAP ports only');
  r = await post('migrations', { host: '127.0.0.1', port: 993, username: oldbox.email, password: oldbox.password });
  assert.equal(r.status, 200, r.text);
  assert.equal((await post('migrations', { host: '127.0.0.1', port: 993, username: oldbox.email, password: oldbox.password })).status, 409, 'one at a time');
  const done = await waitFor(async () => {
    const m = (await acct('migrations')).json.migrations[0];
    return ['done', 'failed'].includes(m.status) ? m : null;
  }, 120000);
  assert.equal(done.status, 'done', JSON.stringify(done));
  assert.ok(done.messages >= 3);

  const acc = await h.primaryAccount(O);
  const res = await h.mail(O, [
    ['Mailbox/get', { accountId: acc, properties: ['name', 'role'] }, 'm'],
    ['Email/query', { accountId: acc, filter: { text: tag } }, 'q'],
    ['Email/get', { accountId: acc, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject', 'mailboxIds', 'keywords', 'receivedAt'] }, 'g']]);
  const boxes = res[0][1].list, mails = res[2][1].list;
  const inbox = boxes.find(b => b.role === 'inbox').id;
  const proj = boxes.find(b => b.name === 'Projects ' + tag);
  assert.ok(proj, 'the folder was created');
  const p = mails.find(m => m.subject === 'Old project ' + tag);
  assert.ok(p && p.mailboxIds[proj.id], 'in its folder');
  assert.ok(p.keywords.$seen, 'still read');
  assert.equal(p.receivedAt.slice(0, 10), '2024-03-01', 'date kept');
  assert.ok(mails.some(m => m.subject === 'Old one ' + tag && m.mailboxIds[inbox]), 'inbox to inbox');
});

test('admin console: payments, totals per client, invoices, prices', async () => {
  const b = await h.gw('/admin-api/billing', { cookie: P });
  assert.equal(b.status, 200, b.text);
  assert.equal(b.json.provider, 'fake');
  assert.equal(b.json.registrar, 'fake');
  assert.equal(b.json.registrarBalance.balance, 1000);
  const mine = b.json.orders.filter(o => o.email === owner.email);
  assert.deepEqual(mine.map(o => o.status).sort(), ['fulfilled', 'fulfilled']);
  const c = await h.gw('/admin-api/customers', { cookie: P });
  const pc = c.json.customers.find(x => x.ownerEmail === owner.email);
  assert.equal(pc.kind, 'personal');
  assert.equal(pc.billing.paidCents, 1600);
  assert.equal(pc.billing.vatCents, 233 + 33);
  const inv = await h.gw('/admin-api/invoice?id=' + mine[0].id, { cookie: P });
  assert.equal(inv.status, 200);
  assert.match(inv.headers.get('content-type'), /text\/html/);
  // Prices are settings: change, check, put back.
  let s = await h.gw('/admin-api/billing/settings', { method: 'POST', cookie: P, body: { 'price.domain_connect_cents': 300, 'billing.vat_rate': 0 } });
  assert.equal(s.status, 200, s.text);
  const p = (await acct('domains')).json.prices;
  assert.deepEqual(p.prices.domain_connect, { ttc: 300, ht: 300, vat: 0, rate: 0 });
  s = await h.gw('/admin-api/billing/settings', { method: 'POST', cookie: P, body: { 'price.domain_connect_cents': 200, 'billing.vat_rate': 20 } });
  assert.equal(s.status, 200);
  assert.equal((await h.gw('/admin-api/billing/settings', { method: 'POST', cookie: P, body: { 'billing.vat_rate': 99 } })).status, 400);
  // An ordinary user has no access.
  assert.equal((await h.gw('/admin-api/billing', { cookie: O })).status, 403);
});

test('a webhook without Stripe’s signature is refused', async () => {
  const r = await fetch(h.BASE + '/billing/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=00' }, body: '{"type":"checkout.session.completed"}' });
  assert.equal(r.status, 400);
});

test('removing a domain removes its addresses', async () => {
  const r = await post('domains/remove', { domain: OWN, confirm: OWN });
  assert.equal(r.status, 200, r.text);
  const o = await acct('domains');
  assert.ok(!o.json.domains.some(x => x.domain === OWN));
  const accId = await h.primaryAccount(O);
  const ids = (await h.mail(O, [['Identity/get', { accountId: accId }, 'i']]))[0][1].list;
  assert.ok(!ids.some(i => i.email === `hello@${OWN}`));
});
