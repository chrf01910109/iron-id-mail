/**
 * Admin console: payments. IRON ID staff see every order, totals (TTC / HT / TVA, by month and by client),
 * the registrar's prepaid balance, and change prices, VAT and invoice details. Customer admins see their
 * own customer's orders only.
 */
const db = require('./db');
const billing = require('./billing');
const registrar = require('./registrar');
const ac = require('./adminConsole');

const fail = (m, s) => { throw new ac.UserError(m, s); };

ac.addRoute('GET', '/admin-api/billing', async (ctx, b, url) => {
  const customerId = url.searchParams.get('customer') || null;
  const status = url.searchParams.get('status') || null;
  if (customerId && !/^[0-9a-f-]{36}$/i.test(customerId)) fail('Unknown customer.', 404);
  if (customerId && !ac.canCustomer(ctx, customerId)) fail('Unknown customer.', 404);
  const where = [], args = [];
  if (!ctx.platform) { args.push(ctx.customerIds); where.push(`o.customer_id = ANY($${args.length}::uuid[])`); }
  if (customerId) { args.push(customerId); where.push(`o.customer_id = $${args.length}`); }
  if (status && ['pending', 'paid', 'fulfilled', 'failed', 'cancelled', 'refunded'].includes(status)) { args.push(status); where.push(`o.status = $${args.length}`); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const [orders, months, refunds] = await Promise.all([
    // nosemgrep: sql-built-with-template-or-concat -- fixed clauses chosen in code, values are $n parameters
    db.query(`SELECT o.*, c.name AS customer_name, c.kind AS customer_kind FROM cp.orders o LEFT JOIN cp.customers c ON c.id = o.customer_id
              ${w} ORDER BY o.created_at DESC LIMIT 300`, args),
    // nosemgrep: sql-built-with-template-or-concat -- fixed clauses chosen in code, values are $n parameters
    db.query(`SELECT to_char(date_trunc('month', paid_at), 'YYYY-MM') AS month,
                     SUM(amount_cents)::int AS ttc, SUM(amount_ht_cents)::int AS ht, SUM(vat_cents)::int AS vat, COUNT(*)::int AS n
                FROM cp.orders o ${w ? w + ' AND' : 'WHERE'} o.status IN ('paid','fulfilled','failed','refunded') AND o.paid_at IS NOT NULL
               GROUP BY 1 ORDER BY 1 DESC LIMIT 24`, args),
    // Refunds count in the month of their credit note (the sale stays in its own month).
    // nosemgrep: sql-built-with-template-or-concat -- fixed clauses chosen in code, values are $n parameters
    db.query(`SELECT to_char(date_trunc('month', c.created_at), 'YYYY-MM') AS month, SUM(c.amount_cents)::int AS ttc,
                     SUM(c.amount_ht_cents)::int AS ht, SUM(c.vat_cents)::int AS vat, COUNT(*)::int AS n
                FROM cp.credit_notes c JOIN cp.orders o ON o.id = c.order_id ${w}
               GROUP BY 1 ORDER BY 1 DESC LIMIT 24`, args)
  ]);
  const credits = await billing.creditsFor(orders.rows.map(o => o.id));
  const monthMap = new Map(months.rows.map(m => [m.month, { ...m, refundTtc: 0, refundHt: 0, refundVat: 0 }]));
  for (const r of refunds.rows) {
    const m = monthMap.get(r.month) || { month: r.month, ttc: 0, ht: 0, vat: 0, n: 0 };
    monthMap.set(r.month, { ...m, refundTtc: r.ttc, refundHt: r.ht, refundVat: r.vat });
  }
  const out = {
    provider: billing.provider().name,
    orders: orders.rows.map(o => ({ ...billing.orderView(o, credits), customerId: o.customer_id, customer: o.customer_name, customerKind: o.customer_kind, email: o.email, error: o.error })),
    months: [...monthMap.values()].sort((a, b) => b.month.localeCompare(a.month)).slice(0, 24)
      .map(m => ({ ...m, refundTtc: m.refundTtc || 0, refundHt: m.refundHt || 0, refundVat: m.refundVat || 0 }))
  };
  if (ctx.platform) {
    out.registrar = registrar.kind() || 'off';
    if (registrar.kind()) {
      try { out.registrarBalance = await registrar.balance(); } catch (e) { out.registrarBalance = null; out.registrarError = 'The registrar could not be reached.'; }
    }
  }
  return out;
});

ac.addRoute('POST', '/admin-api/billing/retry', async (ctx, b) => {
  ac.requirePlatform(ctx);
  const o = await billing.retry(Number(b.id));
  db.audit({ actor: ctx.email, action: 'billing.retried', target: o.domain, details: { order: o.id, status: o.status }, ip: ctx.ip }).catch(() => {});
  return o;
});

ac.addRoute('GET', '/admin-api/credit-note', async (ctx, b, url) => {
  const c = await billing.creditNote(Number(url.searchParams.get('id')));
  const o = c && await billing.order(Number(c.order_id));
  if (!o || !ac.canCustomer(ctx, o.customer_id)) fail('That credit note was not found.', 404);
  return { __html: await billing.creditNoteHtml(c, o, url.searchParams.get('lang') === 'en' ? 'en' : 'fr') };
});

ac.addRoute('GET', '/admin-api/invoice', async (ctx, b, url) => {
  const o = await billing.order(Number(url.searchParams.get('id')));
  if (!o || !o.invoice_number || !ac.canCustomer(ctx, o.customer_id)) fail('That invoice was not found.', 404);
  return { __html: await billing.invoiceHtml(o, url.searchParams.get('lang') === 'en' ? 'en' : 'fr') };
});

const SETTING_KEYS = {
  'price.domain_connect_cents': v => int(v, 0, 1000000),
  'price.domain_register_cents': v => int(v, 0, 1000000),
  'billing.vat_rate': v => { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 50) fail('VAT rate must be between 0 and 50.'); return String(n); },
  'billing.prices_include_vat': v => (v === true || v === 'true' ? 'true' : 'false'),
  'billing.tlds': v => { const list = String(v || '').split(',').map(x => x.trim().toLowerCase().replace(/^\./, '')).filter(Boolean); if (!list.length || list.some(x => !/^[a-z]{2,24}$/.test(x))) fail('List the domain endings like: fr, com, net'); return list.join(','); },
  'signup.quota_mb': v => (v === '' || v === null ? '' : int(v, 50, 10 * 1024 * 1024)),
  'seller.name': v => text(v, 120), 'seller.address': v => text(v, 300), 'seller.siret': v => text(v, 20),
  'seller.vat_number': v => text(v, 20), 'seller.email': v => text(v, 120)
};
function int(v, min, max) { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) fail(`Enter a whole number between ${min} and ${max}.`); return String(n); }
function text(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max); }

ac.addRoute('GET', '/admin-api/billing/settings', async ctx => {
  ac.requirePlatform(ctx);
  const s = await billing.settings();
  const quota = await db.getSetting('signup.quota_mb').catch(() => null);
  return { ...s, quotaMb: quota ? Number(quota) : 5120 };
});

ac.addRoute('POST', '/admin-api/billing/settings', async (ctx, b) => {
  ac.requirePlatform(ctx);
  // Check every value first, so a bad one saves nothing.
  const values = Object.entries(SETTING_KEYS).filter(([k]) => b[k] !== undefined).map(([k, clean]) => [k, clean(b[k])]);
  const changed = [];
  for (const [k, v] of values) {
    if (v === '') await db.query('DELETE FROM cp.settings WHERE key = $1', [k]);
    else await db.setSetting(k, v);
    changed.push(k);
  }
  db.audit({ actor: ctx.email, action: 'billing.settings', target: null, details: { changed }, ip: ctx.ip }).catch(() => {});
  return { ok: true, changed };
});

module.exports = {};
