/**
 * Billing: orders, prices with French VAT (TVA), invoices, and card payments with Stripe Checkout.
 *
 * Prices and the VAT rate are settings (cp.settings), so they change without new code:
 *   price.domain_connect_cents   default 200   (€2: connect a domain you own, DNS set-up + copy of old mail)
 *   price.domain_register_cents  default 1400  (€14 a year: a new domain bought through IRON ID)
 *   billing.vat_rate             default 20    (percent; 0 = "TVA non applicable, art. 293 B du CGI")
 *   billing.prices_include_vat   default true  (prices shown to people are TTC)
 *   seller.*                     name, address, siret, vat_number, email — printed on invoices
 *
 * Payment providers (env):
 *   STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET → Stripe Checkout (test keys sk_test_… while building).
 *   PAYMENTS_FAKE=true → a local "pay" button, for tests only (healthz reports it; never in production).
 *   neither → paid features answer "Payments are not set up yet."
 *
 * Order life: pending → paid (money received) → fulfilled (the service was delivered), or
 * cancelled / failed (paid but delivery failed: shown to IRON ID staff to fix or refund) / refunded.
 * Each step is a guarded UPDATE, so a webhook delivered twice cannot deliver the service twice.
 */
const crypto = require('crypto');
const https = require('https');
const db = require('./db');

class BillingError extends Error {
  constructor(message, status = 400, extra = {}) { super(message); this.status = status; this.userError = true; Object.assign(this, extra); }
}
const fail = (m, s, x) => { throw new BillingError(m, s, x); };

const KINDS = {
  domain_connect: { price: 'price.domain_connect_cents', def: 200, label: { en: 'Own domain set-up: {domain} (DNS and copy of your mail)', fr: 'Mise en service du domaine {domain} (DNS et copie de vos e-mails)' } },
  domain_register: { price: 'price.domain_register_cents', def: 1400, label: { en: 'Domain {domain}, 1 year', fr: 'Nom de domaine {domain}, 1 an' } },
  domain_renew: { price: 'price.domain_register_cents', def: 1400, label: { en: 'Domain {domain}, renewal for 1 year', fr: 'Nom de domaine {domain}, renouvellement 1 an' } }
};

/* ——— Settings ——— */
async function settings() {
  const r = await db.query(`SELECT key, value FROM cp.settings WHERE key LIKE 'price.%' OR key LIKE 'billing.%' OR key LIKE 'seller.%'`).catch(() => ({ rows: [] }));
  const m = Object.fromEntries(r.rows.map(x => [x.key, x.value]));
  const int = (k, d) => { const n = parseInt(m[k], 10); return Number.isFinite(n) && n >= 0 ? n : d; };
  const rate = m['billing.vat_rate'] !== undefined && m['billing.vat_rate'] !== '' ? Number(m['billing.vat_rate']) : 20;
  return {
    currency: 'EUR',
    vatRate: Number.isFinite(rate) && rate >= 0 && rate <= 50 ? rate : 20,
    pricesIncludeVat: m['billing.prices_include_vat'] !== 'false',
    prices: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, int(v.price, v.def)])),
    tlds: String(m['billing.tlds'] || 'fr,com,net,org,eu').split(',').map(x => x.trim().toLowerCase().replace(/^\./, '')).filter(x => /^[a-z]{2,24}$/.test(x)),
    seller: {
      name: m['seller.name'] || '[Raison sociale]', address: m['seller.address'] || '[Adresse]',
      siret: m['seller.siret'] || '[SIRET]', vatNumber: m['seller.vat_number'] || '', email: m['seller.email'] || '[contact]'
    }
  };
}

/** Amounts in cents for a price: { ttc, ht, vat, rate }. */
function amounts(priceCents, s) {
  const rate = s.vatRate;
  if (s.pricesIncludeVat) {
    const ht = Math.round(priceCents / (1 + rate / 100));
    return { ttc: priceCents, ht, vat: priceCents - ht, rate };
  }
  const vat = Math.round(priceCents * rate / 100);
  return { ttc: priceCents + vat, ht: priceCents, vat, rate };
}

/** What people see before paying: price TTC per kind, VAT rate. */
async function priceList() {
  const s = await settings();
  const out = {};
  for (const k of Object.keys(KINDS)) out[k] = amounts(s.prices[k], s);
  return { currency: s.currency, vatRate: s.vatRate, prices: out, tlds: s.tlds, provider: provider().name };
}

/* ——— Providers ——— */
function provider() {
  if (process.env.STRIPE_SECRET_KEY) return { name: process.env.STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'stripe-live' : 'stripe-test', kind: 'stripe' };
  if (process.env.PAYMENTS_FAKE === 'true') return { name: 'fake', kind: 'fake' };
  return { name: 'off', kind: null };
}

function stripeRequest(path, form) {
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const r = https.request({
      host: 'api.stripe.com', path: '/v1/' + path, method: 'POST', timeout: 20000,
      headers: { authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY, 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body), 'stripe-version': '2024-06-20' }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* not JSON */ }
        if (res.statusCode >= 200 && res.statusCode < 300 && json) resolve(json);
        else reject(new Error('Stripe HTTP ' + res.statusCode + ': ' + (json && json.error ? json.error.message : '')));
      });
    });
    r.on('timeout', () => r.destroy(new Error('Stripe timeout')));
    r.on('error', reject);
    r.end(body);
  });
}

// The fake checkout link is signed so nobody can mark someone else's order as paid by guessing ids.
let fakeKey = null;
const fakeSig = id => {
  if (!fakeKey) fakeKey = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(process.env.ADMIN_TOKEN || 'x'), Buffer.from('iron-id-cp'), Buffer.from('fake-pay-v1'), 32));
  return crypto.createHmac('sha256', fakeKey).update(String(id)).digest('hex');
};

/* ——— Orders ——— */
const labelFor = (kind, domain, lang) => (KINDS[kind].label[lang] || KINDS[kind].label.en).replace('{domain}', domain);

/**
 * Creates a pending order and the payment page to send the person to.
 * Returns { order, checkoutUrl }. `baseUrl` is this site's https origin (for the return links).
 */
async function createOrder({ customerId, email, kind, domain, details = {}, lang = 'en', baseUrl }) {
  if (!KINDS[kind]) throw new Error('unknown order kind ' + kind);
  const p = provider();
  if (!p.kind) fail('Payments are not set up yet. Please try again later.', 503);
  const s = await settings();
  const a = amounts(s.prices[kind], s);
  const r = await db.query(`INSERT INTO cp.orders (customer_id, email, kind, domain, amount_cents, amount_ht_cents, vat_cents, vat_rate, currency, provider, details, lang)
                            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [customerId, email, kind, domain, a.ttc, a.ht, a.vat, a.rate, s.currency, p.name, details, lang]);
  const order = r.rows[0];
  let checkoutUrl;
  if (p.kind === 'stripe') {
    const session = await stripeRequest('checkout/sessions', {
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'eur',
      'line_items[0][price_data][unit_amount]': String(a.ttc),
      'line_items[0][price_data][product_data][name]': labelFor(kind, domain, lang),
      customer_email: email,
      client_reference_id: String(order.id),
      'metadata[order_id]': String(order.id),
      'payment_intent_data[metadata][order_id]': String(order.id),
      locale: lang === 'fr' ? 'fr' : 'en',
      success_url: `${baseUrl}/?order=${order.id}&paid=1#domains`,
      cancel_url: `${baseUrl}/?order=${order.id}&paid=0#domains`,
      expires_at: String(Math.floor(Date.now() / 1000) + 3600)
    });
    await db.query('UPDATE cp.orders SET provider_ref = $2 WHERE id = $1', [order.id, session.id]);
    checkoutUrl = session.url;
  } else {
    checkoutUrl = `${baseUrl}/billing/fake-checkout?order=${order.id}&sig=${fakeSig(order.id)}`;
  }
  return { order: orderView(order), checkoutUrl };
}

function orderView(o) {
  return {
    id: Number(o.id), kind: o.kind, domain: o.domain, status: o.status, amountCents: o.amount_cents, amountHtCents: o.amount_ht_cents,
    vatCents: o.vat_cents, vatRate: Number(o.vat_rate), currency: o.currency, createdAt: o.created_at, paidAt: o.paid_at,
    fulfilledAt: o.fulfilled_at, invoiceNumber: o.invoice_number, error: o.status === 'failed' ? o.error : undefined
  };
}

/* What to do when an order is paid, registered by the features that sell something. */
const fulfillers = {};
function onPaid(kind, fn) { fulfillers[kind] = fn; }

/** Marks an order paid (once), gives it an invoice number, then delivers the service. */
async function markPaid(orderId, { paymentRef = null } = {}) {
  const client = await db.getPool().connect();
  let order;
  try {
    await client.query('BEGIN');
    // 'cancelled' too: someone may leave the payment page, then pay in the still-open Stripe tab.
    const r = await client.query(`UPDATE cp.orders SET status = 'paid', paid_at = NOW(), payment_ref = COALESCE($2, payment_ref)
                                   WHERE id = $1 AND status IN ('pending', 'cancelled') RETURNING *`, [orderId, paymentRef]);
    order = r.rows[0];
    if (order) {
      const year = new Date().getFullYear();
      const seq = await client.query(`INSERT INTO cp.invoice_seq (year, last) VALUES ($1, 1)
                                      ON CONFLICT (year) DO UPDATE SET last = cp.invoice_seq.last + 1 RETURNING last`, [year]);
      const number = `F${year}-${String(seq.rows[0].last).padStart(6, '0')}`;
      await client.query('UPDATE cp.orders SET invoice_number = $2 WHERE id = $1', [orderId, number]);
      order.invoice_number = number;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
  if (!order) return null; // already paid (webhook sent twice) or not pending
  db.audit({ actor: order.email, customerId: order.customer_id, action: 'billing.paid', target: order.domain, details: { order: Number(order.id), kind: order.kind, amountCents: order.amount_cents, invoice: order.invoice_number } }).catch(() => {});
  await fulfil(order);
  return order;
}

/** Delivers a paid order. On failure the order is marked failed with the reason (for staff), never lost. */
async function fulfil(order) {
  const fn = fulfillers[order.kind];
  try {
    if (!fn) throw new Error('nothing delivers ' + order.kind);
    await fn(order);
    await db.query(`UPDATE cp.orders SET status = 'fulfilled', fulfilled_at = NOW(), error = NULL WHERE id = $1 AND status IN ('paid', 'failed')`, [order.id]);
  } catch (e) {
    console.error(`[billing] order ${order.id} (${order.kind} ${order.domain}) could not be delivered:`, e.message);
    await db.query(`UPDATE cp.orders SET status = 'failed', error = $2 WHERE id = $1 AND status = 'paid'`, [order.id, String(e.message).slice(0, 500)]);
  }
}

/** Staff: try the delivery of a failed order again. */
async function retry(orderId) {
  const o = (await db.query(`SELECT * FROM cp.orders WHERE id = $1`, [orderId])).rows[0];
  if (!o) fail('That order was not found.', 404);
  if (o.status !== 'failed') fail('Only a paid order whose delivery failed can be retried.');
  await db.query(`UPDATE cp.orders SET status = 'paid' WHERE id = $1 AND status = 'failed'`, [orderId]);
  await fulfil({ ...o, status: 'paid' });
  return orderView((await db.query('SELECT * FROM cp.orders WHERE id = $1', [orderId])).rows[0]);
}

/* ——— Stripe webhook ——— */
/** Checks the Stripe-Signature header (HMAC-SHA256 of "t.payload", 5 minutes tolerance). */
function verifyStripeSignature(raw, header, secret, now = Date.now()) {
  const parts = Object.fromEntries(String(header || '').split(',').map(x => x.split('=')).filter(x => x.length === 2).map(([k, v]) => [k.trim(), v]));
  const sigs = String(header || '').split(',').filter(x => x.trim().startsWith('v1=')).map(x => x.trim().slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return sigs.some(s => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

async function stripeWebhook(raw, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !verifyStripeSignature(raw, signature, secret)) return { status: 400, body: { error: 'Invalid signature' } };
  let ev;
  try { ev = JSON.parse(raw); } catch (e) { return { status: 400, body: { error: 'Invalid request' } }; }
  const obj = ev.data && ev.data.object || {};
  const orderId = Number((obj.metadata && obj.metadata.order_id) || obj.client_reference_id);
  if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') {
    if (obj.payment_status === 'paid' && orderId) {
      const o = (await db.query('SELECT provider_ref FROM cp.orders WHERE id = $1', [orderId])).rows[0];
      if (o && o.provider_ref === obj.id) await markPaid(orderId, { paymentRef: obj.payment_intent || null });
    }
  } else if (ev.type === 'checkout.session.expired' && orderId) {
    await db.query(`UPDATE cp.orders SET status = 'cancelled' WHERE id = $1 AND status = 'pending' AND provider_ref = $2`, [orderId, obj.id]);
  } else if (ev.type === 'charge.refunded') {
    const pi = obj.payment_intent;
    if (pi) await db.query(`UPDATE cp.orders SET status = 'refunded' WHERE payment_ref = $1`, [pi]);
  }
  return { status: 200, body: { received: true } };
}

/* ——— Fake provider (tests only) ——— */
function fakeCheckoutValid(orderId, sig) {
  if (provider().kind !== 'fake') return false;
  const want = fakeSig(orderId);
  return typeof sig === 'string' && sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

/* ——— Reading ——— */
async function ordersFor(customerId) {
  const r = await db.query('SELECT * FROM cp.orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 200', [customerId]);
  return r.rows.map(orderView);
}
async function order(id) {
  const r = await db.query('SELECT * FROM cp.orders WHERE id = $1', [id]);
  return r.rows[0] || null;
}

/** Totals per customer: paid (TTC, HT, VAT), refunded, waiting for payment. */
async function totalsByCustomer() {
  const r = await db.query(`
    SELECT customer_id,
           COALESCE(SUM(amount_cents) FILTER (WHERE status IN ('paid','fulfilled','failed')), 0)::int AS paid_cents,
           COALESCE(SUM(amount_ht_cents) FILTER (WHERE status IN ('paid','fulfilled','failed')), 0)::int AS paid_ht_cents,
           COALESCE(SUM(vat_cents) FILTER (WHERE status IN ('paid','fulfilled','failed')), 0)::int AS vat_cents,
           COALESCE(SUM(amount_cents) FILTER (WHERE status = 'refunded'), 0)::int AS refunded_cents,
           COALESCE(SUM(amount_cents) FILTER (WHERE status = 'pending'), 0)::int AS pending_cents,
           COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
           MAX(paid_at) AS last_paid_at
      FROM cp.orders GROUP BY customer_id`);
  return new Map(r.rows.map(x => [x.customer_id, x]));
}

/** Invoice as a printable HTML page (French invoice mentions). Text is escaped. */
async function invoiceHtml(o, lang = 'fr') {
  const s = await settings();
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const eur = c => (c / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
  const d = o.details || {};
  const buyer = [d.name || o.email, d.address, [d.postalCode, d.city].filter(Boolean).join(' '), d.country].filter(Boolean);
  const fr = lang === 'fr';
  const vatLine = Number(o.vat_rate) === 0
    ? `<p>${fr ? 'TVA non applicable, art. 293 B du CGI.' : 'VAT not applicable, art. 293 B of the French tax code (CGI).'}</p>` : '';
  return `<!DOCTYPE html><html lang="${fr ? 'fr' : 'en'}"><head><meta charset="utf-8"><title>${fr ? 'Facture' : 'Invoice'} ${esc(o.invoice_number)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;color:#111827;max-width:760px;margin:32px auto;padding:0 20px}h1{font-size:22px}table{width:100%;border-collapse:collapse;margin:18px 0}td,th{border-bottom:1px solid #E5E7EB;padding:8px;text-align:left}th:last-child,td:last-child{text-align:right}.muted{color:#667085}.cols{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap}@media print{button{display:none}}</style></head><body>
<h1>${fr ? 'Facture' : 'Invoice'} ${esc(o.invoice_number)}</h1>
<p class="muted">${fr ? 'Date :' : 'Date:'} ${esc(new Date(o.paid_at).toLocaleDateString(fr ? 'fr-FR' : 'en-GB'))}</p>
<div class="cols"><div><b>${esc(s.seller.name)}</b><br>${esc(s.seller.address)}<br>SIRET ${esc(s.seller.siret)}${s.seller.vatNumber ? '<br>' + (fr ? 'N° TVA ' : 'VAT no. ') + esc(s.seller.vatNumber) : ''}<br>${esc(s.seller.email)}</div>
<div><b>${fr ? 'Client' : 'Customer'}</b><br>${buyer.map(esc).join('<br>')}<br>${esc(o.email)}</div></div>
<table><tr><th>${fr ? 'Désignation' : 'Description'}</th><th>${fr ? 'Montant HT' : 'Amount excl. VAT'}</th></tr>
<tr><td>${esc(labelFor(o.kind, o.domain, fr ? 'fr' : 'en'))}</td><td>${eur(o.amount_ht_cents)}</td></tr>
<tr><td>${fr ? 'TVA' : 'VAT'} ${esc(Number(o.vat_rate))} %</td><td>${eur(o.vat_cents)}</td></tr>
<tr><td><b>${fr ? 'Total TTC' : 'Total incl. VAT'}</b></td><td><b>${eur(o.amount_cents)}</b></td></tr></table>
${vatLine}<p class="muted">${fr ? 'Payée par carte le' : 'Paid by card on'} ${esc(new Date(o.paid_at).toLocaleDateString(fr ? 'fr-FR' : 'en-GB'))}${o.payment_ref ? ' (' + esc(o.payment_ref) + ')' : ''}.</p>
</body></html>`;
}

module.exports = {
  settings, amounts, priceList, provider, createOrder, markPaid, retry, onPaid, orderView, ordersFor, order, totalsByCustomer,
  stripeWebhook, verifyStripeSignature, fakeCheckoutValid, invoiceHtml, labelFor, KINDS, BillingError
};
