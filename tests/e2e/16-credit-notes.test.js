// Refunds made in Stripe give credit notes (avoirs): numbered AV<year>-NNNNNN, one per refund, never
// twice for the same money, a full refund closes the order; shown to the customer and in the console.
// Needs PAYMENTS_FAKE=true, REGISTRAR=fake, PLATFORM_ADMINS with e2e-platform-admin@, and the same
// STRIPE_WEBHOOK_SECRET in the gateway and in this test's environment (signed webhook events).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

const SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const tag = crypto.randomBytes(3).toString('hex');
const BUY = `refund${tag}.fr`;
const XF = n => ({ 'x-forwarded-for': `198.51.104.${n}` });
const CONTACT = { firstName: 'Karim', lastName: 'Benali', address: '10 rue de la Paix', city: 'Paris', postalCode: '75002', country: 'FR', phone: '06 12 34 56 78' };
let owner, platform, O, P, orderId;

async function webhook(event, { sign = true } = {}) {
  const raw = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
  const r = await fetch(h.BASE + '/billing/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', ...(sign ? { 'stripe-signature': `t=${t},v1=${sig}` } : {}) }, body: raw });
  return r.status;
}
const refunded = (paymentIntent, total) => ({ id: 'evt_' + crypto.randomBytes(6).toString('hex'), type: 'charge.refunded',
  data: { object: { id: 'ch_' + tag, object: 'charge', payment_intent: paymentIntent, amount: 1400, amount_refunded: total, refunded: total >= 1400 } } });
const order = async () => (await h.gw('/account/domains', { cookie: O })).json.orders.find(x => x.id === orderId);

before(async () => {
  assert.ok(SECRET, 'set STRIPE_WEBHOOK_SECRET (the same value as the gateway)');
  await h.waitHealthy(120000, { requireAdmin: true });
  owner = await h.createTestUser('refund-owner');
  platform = await h.createTestUser('e2e-platform-admin', { exactName: true });
  O = (await h.login(owner.email, owner.password, XF(1))).cookie;
  P = (await h.login(platform.email, platform.password, XF(2))).cookie;
  // A domain bought and paid (fake card payment).
  const r = await h.gw('/account/domains/buy', { method: 'POST', cookie: O, body: { domain: BUY, contact: CONTACT, acceptTerms: true } });
  assert.equal(r.status, 200, r.text);
  const u = new URL(r.json.checkoutUrl, h.BASE);
  const pay = await fetch(h.BASE + '/billing/fake-pay', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ order: u.searchParams.get('order'), sig: u.searchParams.get('sig') }).toString() });
  assert.equal(pay.status, 303);
  orderId = Number(u.searchParams.get('order'));
  assert.equal((await order()).status, 'fulfilled');
});

after(async () => {
  await h.gw('/admin-api/domains/remove', { method: 'POST', cookie: P, body: { domain: BUY, confirm: BUY } }).catch(() => {});
  for (const u of [owner, platform]) await h.deleteTestUser(u);
});

test('a partial refund gives a credit note for that amount; the same notification twice gives one', async () => {
  const pi = 'fake_' + orderId;
  assert.equal(await webhook(refunded(pi, 500), { sign: false }), 400, 'unsigned: refused');
  assert.equal((await order()).creditNotes.length, 0);
  assert.equal(await webhook(refunded(pi, 500)), 200);
  assert.equal(await webhook(refunded(pi, 500)), 200, 'Stripe may send it again');
  const o = await order();
  assert.equal(o.creditNotes.length, 1);
  assert.equal(o.creditNotes[0].amountCents, 500);
  assert.match(o.creditNotes[0].number, /^AV\d{4}-\d{6}$/);
  assert.equal(o.status, 'fulfilled', 'a partial refund leaves the order as it was');
  const html = await h.gw('/account/credit-note?id=' + o.creditNotes[0].id, { cookie: O });
  assert.equal(html.status, 200);
  assert.match(html.text, new RegExp(o.creditNotes[0].number));
  assert.match(html.text, new RegExp(o.invoiceNumber), 'names the invoice it corrects');
  assert.match(html.text, /-5,00/);
  assert.match(html.text, /(Avoir|Credit note)/);
});

test('the rest refunded: a second credit note for the difference, the order is refunded', async () => {
  assert.equal(await webhook(refunded('fake_' + orderId, 1400)), 200);
  const o = await order();
  assert.equal(o.status, 'refunded');
  assert.deepEqual(o.creditNotes.map(c => c.amountCents), [500, 900]);
  const [a, b] = o.creditNotes.map(c => Number(c.number.slice(-6)));
  assert.equal(b, a + 1, 'numbers follow each other');
  const other = await h.createTestUser('refund-other');
  const OC = (await h.login(other.email, other.password, XF(3))).cookie;
  assert.equal((await h.gw('/account/credit-note?id=' + o.creditNotes[0].id, { cookie: OC })).status, 404, 'not someone else’s');
  await h.deleteTestUser(other);
});

test('the console: credit notes on the order, refunds by month, and the client’s refunded total', async () => {
  const b = await h.gw('/admin-api/billing', { cookie: P });
  assert.equal(b.status, 200, b.text);
  const o = b.json.orders.find(x => x.id === orderId);
  assert.equal(o.creditNotes.length, 2);
  const month = new Date().toISOString().slice(0, 7);
  const m = b.json.months.find(x => x.month === month);
  assert.ok(m && m.refundTtc >= 1400, JSON.stringify(m));
  const c = await h.gw('/admin-api/customers', { cookie: P });
  const pc = c.json.customers.find(x => x.ownerEmail === owner.email);
  assert.equal(pc.billing.refundedCents, 1400);
  assert.equal(pc.billing.paidCents, 1400, 'the sale is still counted in its month');
  const html = await h.gw('/admin-api/credit-note?id=' + o.creditNotes[1].id, { cookie: P });
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
});
