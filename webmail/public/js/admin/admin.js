// IRON ID admin console. Admins are signed in with their own mailbox (same session as
// the webmail); everything goes through /admin-api, which checks the role and scope.
// Untrusted text is only inserted with textContent (h()).

import { t, tn, tx, locale, lang } from '../i18n.js'; // first: translates the page before anything else runs
import { h, $, $$, toast, dialog, openMenu, formatSize, initials, icon } from '../util.js';

/* ——— API ——— */
class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
async function api(path, body) {
  let res;
  try {
    res = await fetch('/admin-api/' + path, body === undefined
      ? { credentials: 'same-origin', cache: 'no-store' }
      : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) { throw new ApiError(t('Network problem: the server could not be reached.'), 0); }
  let data = {};
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) throw new ApiError(data.error || t('Server error (HTTP {status})', { status: res.status }), res.status);
  return data;
}

/* ——— Small helpers ——— */
const NAV_ICONS = {
  overview: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  customers: '<path d="M3 21h18M5 21V7l7-4 7 4v14"/><path d="M9 21v-6h6v6"/>',
  domains: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',
  mailboxes: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  teams: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  audit: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  usage: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>',
  payments: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
  plans: '<path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
};
// nosemgrep: h-helper-html-attribute-with-variable -- constant icon table, names from code
const navIcon = name => h('span', { class: 'ic', style: { display: 'inline-flex' }, html: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${NAV_ICONS[name]}</svg>` });

const fmtDate = iso => iso ? new Date(iso).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
const fmtDateTime = iso => iso ? new Date(iso).toLocaleString(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtCents = (cents, cur = 'EUR') => {
  if (cents == null) return '—';
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency: cur || 'EUR' }).format(cents / 100); }
  catch (e) { return fmtMoney(cents / 100, cur); }
};
const fmtMoney = (n, cur) => n == null ? '—' : new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(n) + ' ' + (cur || '');
const badge = (text, kind = '') => h('span', { class: 'badge ' + kind }, text);
const btn = (label, onClick, cls = '') => h('button', { type: 'button', class: 'btn ' + cls, on: { click: onClick } }, label);
const table = (heads, rows, empty = t('Nothing here yet.')) => rows.length
  ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ...heads.map(x => typeof x === 'string' ? h('th', {}, x) : h('th', x.attrs || {}, x.label)))), h('tbody', {}, ...rows)))
  : h('div', { class: 'card empty' }, empty);
const moreButton = items => {
  const b = h('button', { type: 'button', class: 'icon-btn row-more', title: t('Actions'), 'aria-label': t('Actions') }, icon('dots', 15));
  b.addEventListener('click', e => { e.stopPropagation(); openMenu(b, items()); });
  return b;
};
function meter(used, limit) {
  if (!limit) return h('div', { class: 'secondary' }, t('{size} used', { size: formatSize(used) }));
  const pct = Math.min(100, Math.round(used / limit * 100));
  return h('div', {}, h('div', { class: 'secondary' }, t('{used} of {limit}', { used: formatSize(used), limit: formatSize(limit) })),
    h('div', { class: 'meter' }, h('div', { class: pct >= 95 ? 'full' : pct >= 80 ? 'warn' : '', style: { width: Math.max(pct, 1) + '%' } })));
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast(t('Copied')); }
  catch (e) { toast(t('Select the text and copy it'), false); }
}
const copyBtn = text => h('button', { type: 'button', class: 'btn small', on: { click: () => copy(text) } }, t('Copy'));
async function run(fn, done) {
  try { const r = await fn(); if (done) toast(done); return r; }
  catch (e) { if (e.status === 401) return signedOut(); toast(e.message, false); return undefined; }
}

/** A modal form. fields: [{name, label, type, value, options, help, required, placeholder, rows, choices}] */
function formDialog({ title, intro, fields, okLabel = t('Save'), danger = false, submit }) {
  return new Promise(resolve => {
    const bg = $('#formDialog');
    const status = h('div', { class: 'form-status' });
    const inputs = {};
    const body = h('div', { class: 'modal-body' }, intro ? h('p', { class: 'muted' }, intro) : null);
    for (const f of fields) {
      let input;
      const id = 'f_' + f.name;
      if (f.type === 'select') {
        input = h('select', { id, class: 'fl-input' }, ...f.options.map(o => h('option', { value: o.value, selected: String(o.value) === String(f.value ?? '') }, o.label)));
      } else if (f.type === 'textarea') {
        input = h('textarea', { id, class: 'fl-input', rows: f.rows || 4, placeholder: f.placeholder || '' });
        input.value = f.value || '';
      } else if (f.type === 'checks') {
        input = h('div', { class: 'check-list', id },
          ...(f.choices.length ? f.choices.map(c => h('label', {}, h('input', { type: 'checkbox', value: c.value, checked: (f.value || []).includes(c.value) }), c.label)) : [h('span', { class: 'muted small' }, t('No mailboxes yet.'))]));
      } else if (f.type === 'address') {
        const local = h('input', { id, class: 'fl-input', type: 'text', placeholder: f.placeholder || t('name'), autocomplete: 'off', value: f.value || '' });
        const dom = h('select', { class: 'fl-input', 'aria-label': t('Domain') }, ...f.domains.map(d => h('option', { value: d }, '@' + d)));
        input = h('div', { class: 'addr-row' }, local, dom);
        input.getValue = () => `${local.value.trim().toLowerCase()}@${dom.value}`;
        input.focusEl = local;
      } else {
        input = h('input', { id, class: 'fl-input' + (f.mono ? ' mono' : ''), type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder || '', autocomplete: 'off', min: f.min, max: f.max, step: f.step });
      }
      inputs[f.name] = { f, input };
      body.append(h('div', { class: 'field' }, h('label', { class: 'fl-label', for: id }, f.label), input, f.help ? h('div', { class: 'help' }, f.help) : null));
    }
    body.append(status);
    const cancel = h('button', { type: 'button', class: 'act-btn' }, t('Cancel'));
    const ok = h('button', { type: 'submit', class: 'compose-btn', style: danger ? { background: 'var(--color-danger)' } : null }, okLabel);
    const form = h('form', { class: 'modal form', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-hdr' }, h('h3', {}, title)), body, h('div', { class: 'modal-ftr' }, cancel, ok));
    const close = v => { bg.classList.remove('open'); bg.setAttribute('aria-hidden', 'true'); bg.replaceChildren(); resolve(v); };
    cancel.addEventListener('click', () => close(null));
    form.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const values = {};
      for (const [k, { f, input }] of Object.entries(inputs)) {
        if (f.type === 'checks') values[k] = $$('input:checked', input).map(x => x.value);
        else if (f.type === 'address') values[k] = input.getValue();
        else values[k] = input.value.trim();
      }
      ok.disabled = true; status.className = 'form-status'; status.textContent = '';
      try {
        const r = await submit(values);
        close(r === undefined ? true : r);
      } catch (err) {
        status.className = 'form-status err'; status.textContent = err.message;
        if (err.status === 401) signedOut();
      } finally { ok.disabled = false; }
    });
    bg.replaceChildren(form);
    bg.classList.add('open');
    bg.setAttribute('aria-hidden', 'false');
    const first = Object.values(inputs)[0];
    setTimeout(() => { const el = first && (first.input.focusEl || first.input); if (el && el.focus) el.focus(); }, 40);
  });
}

/** Shows a one-time secret (temporary password) with a copy button. */
function showSecret(title, text, secret) {
  const bg = $('#formDialog');
  const done = h('button', { type: 'button', class: 'compose-btn' }, t('Done'));
  const box = h('div', { class: 'secret-box', id: 'secretValue' }, secret);
  const m = h('div', { class: 'modal form', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-hdr' }, h('h3', {}, title)),
    h('div', { class: 'modal-body' }, h('p', {}, text), box, h('div', {}, copyBtn(secret)),
      h('p', { class: 'muted small' }, t('This is shown only once. Share it privately (not by email to the same mailbox), and ask the person to change it in Settings → Security after signing in.'))),
    h('div', { class: 'modal-ftr' }, done));
  return new Promise(resolve => {
    done.addEventListener('click', () => { bg.classList.remove('open'); bg.replaceChildren(); resolve(); });
    bg.replaceChildren(m); bg.classList.add('open'); bg.setAttribute('aria-hidden', 'false');
    setTimeout(() => done.focus(), 40);
  });
}

/* ——— State and navigation ——— */
let me = null;
const pages = {};
const NAV = [
  { id: 'overview', label: t('Overview') },
  { id: 'customers', label: t('Customers') },
  { id: 'domains', label: t('Domains') },
  { id: 'mailboxes', label: t('Mailboxes') },
  { id: 'teams', label: t('Teams') },
  { id: 'audit', label: t('Activity log') },
  { id: 'usage', label: t('Usage & billing') },
  { id: 'payments', label: t('Payments') },
  { id: 'plans', label: t('Plans'), platform: true },
  { id: 'settings', label: t('Platform settings'), platform: true }
];

function currentRoute() {
  const [page, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  return { page: NAV.some(n => n.id === page) ? page : 'overview', arg: rest.map(decodeURIComponent).join('/') };
}
export function go(page, arg = '') { location.hash = '#/' + page + (arg ? '/' + encodeURIComponent(arg) : ''); }

function renderNav() {
  const { page } = currentRoute();
  const items = NAV.filter(n => !n.platform || me.role === 'platform').map(n => {
    const a = h('a', { href: '#/' + n.id, class: 'sb-btn' + (n.id === page ? ' active' : ''), 'aria-current': n.id === page ? 'page' : null }, navIcon(n.id === 'audit' ? 'audit' : n.id), h('span', {}, n.label));
    a.addEventListener('click', () => document.body.classList.remove('nav-open'));
    return a;
  });
  $('#adminNav').replaceChildren(h('div', { class: 'sb-section' }, me.role === 'platform' ? t('IRON ID staff') : (me.customers[0] ? me.customers[0].name : t('Admin'))), ...items);
}

let renderSeq = 0;
async function render() {
  if (!me) return;
  renderNav();
  const { page, arg } = currentRoute();
  const seq = ++renderSeq;
  const root = $('#page');
  root.replaceChildren(h('div', { class: 'loading-text' }, t('Loading…')));
  try {
    const node = await pages[page](arg);
    if (seq !== renderSeq) return;
    root.replaceChildren(...[].concat(node));
  } catch (e) {
    if (seq !== renderSeq) return;
    if (e.status === 401) return signedOut();
    root.replaceChildren(h('div', { class: 'alert bad' }, e.message));
  }
}
const refresh = () => render();

function head(title, sub, ...actions) {
  return h('div', { class: 'page-head' }, h('h1', {}, title), actions.length ? h('div', { class: 'actions' }, ...actions) : null, sub ? h('div', { class: 'sub' }, sub) : null);
}

/* ——— Pages ——— */
const ACTION_LABELS = {
  'signin.ok': tx('signin', 'Signed in'), 'signup.created': t('Account created by sign-up'), 'signin.failed': t('Failed sign-in'), 'mailbox.created': t('Mailbox created'), 'mailbox.updated': t('Mailbox changed'),
  'mailbox.deleted': t('Mailbox deleted'), 'mailbox.suspended': t('Mailbox suspended'), 'mailbox.restored': t('Mailbox restored'), 'mailbox.signin_reset': t('Sign-in reset'),
  'team.created': t('Team created'), 'team.updated': t('Team changed'), 'team.deleted': t('Team deleted'), 'domain.added': t('Domain added'), 'domain.assigned': t('Domain assigned'),
  'domain.verified': t('Domain verified'), 'domain.removed': t('Domain removed'), 'domain.catch_all': t('Catch-all changed'), 'domain.dkim_prepared': t('New DKIM keys created'),
  'domain.dkim_activated': t('Switched DKIM keys'), 'domain.dkim_removed': t('Old DKIM keys removed'), 'customer.created': t('Customer created'), 'customer.updated': t('Customer changed'),
  'customer.deleted': t('Customer deleted'), 'admin.added': t('Admin added'), 'admin.removed': t('Admin removed'), 'plan.created': t('Plan created'), 'plan.updated': t('Plan changed'),
  'plan.deleted': t('Plan deleted'), 'retention.updated': t('Retention changed'), 'account.password_changed': t('Password changed'), 'account.two_step_on': t('Two-step turned on'),
  'account.two_step_off': t('Two-step turned off'), 'account.signed_out_others': t('Signed out other browsers'), 'account.app_password_created': t('App password created'),
  'account.app_password_revoked': t('App password removed'), 'engine_api_key.provisioned': t('Engine access set up'),
  'billing.paid': t('Payment received'), 'billing.retried': t('Delivery retried'), 'billing.settings': t('Prices or invoice details changed'),
  'address.added': t('Address added'), 'address.removed': t('Address removed'), 'migration.started': t('Copy of old mailbox started'),
  'migration.done': t('Copy of old mailbox finished'), 'domain.expired': t('Domain expired')
};
const actionLabel = a => ACTION_LABELS[a] || a;

pages.overview = async () => {
  const o = await api('overview');
  const out = [head(t('Overview'), me.role === 'platform' ? t('Everything on IRON ID Mail.') : t('Your organisation on IRON ID Mail.'))];
  if (me.twoStep === false) {
    out.push(h('div', { class: 'alert warn' }, t('Your admin mailbox does not use two-step sign-in. Turn it on in the webmail: Settings → Security.')));
  }
  if (o.engine && o.engine.adminAccess === 'needs_update') {
    out.push(h('div', { class: 'alert warn' }, t('The gateway needs a one-time permission update for the admin console: deploy once with STALWART_RECOVERY_ADMIN set, then remove it and deploy again.')));
  }
  if (o.engine && o.engine.recoveryAdminSet) {
    out.push(h('div', { class: 'alert bad' }, t('STALWART_RECOVERY_ADMIN is still set on the server. Remove it and deploy again.')));
  }
  if (o.engine && !['ok', 'provisioned', 'needs_update'].includes(o.engine.adminAccess)) {
    out.push(h('div', { class: 'alert bad' }, t('Admin access to the mail engine is not working ({status}).', { status: o.engine.adminAccess })));
  }
  const stat = (n, l, page) => { const s = h('a', { class: 'stat', href: '#/' + page, style: { textDecoration: 'none', color: 'inherit' } }, h('div', { class: 'n' }, String(n)), h('div', { class: 'l' }, l)); return s; };
  out.push(h('div', { class: 'stats' },
    me.role === 'platform' ? stat(o.customers, t('Customers'), 'customers') : null,
    stat(o.domains, t('Domains'), 'domains'), stat(o.mailboxes, t('Mailboxes'), 'mailboxes'), stat(o.teams, t('Teams'), 'teams'),
    stat(formatSize(o.usedBytes), t('Storage used'), 'usage')));
  if (o.pendingDomains.length) {
    out.push(h('div', { class: 'card' }, h('h2', {}, t('Waiting for DNS verification')),
      h('div', { class: 'chips' }, ...o.pendingDomains.map(d => h('a', { class: 'chip', href: '#/domains/' + encodeURIComponent(d) }, d)))));
  }
  if (o.unassignedDomains && o.unassignedDomains.length) {
    out.push(h('div', { class: 'card' }, h('h2', {}, t('Domains not assigned to a customer')),
      h('p', { class: 'help' }, t('These were set up in the mail engine before the console. Assign them on the Domains page.')),
      h('div', { class: 'chips' }, ...o.unassignedDomains.map(d => h('span', { class: 'chip' }, d)))));
  }
  out.push(h('div', { class: 'card' }, h('h2', {}, t('Recent changes'), h('span', { class: 'actions' }, h('a', { class: 'btn small', href: '#/audit' }, t('All activity')))),
    o.recent.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('tbody', {}, ...o.recent.map(r => h('tr', {},
      h('td', { class: 'secondary' }, fmtDateTime(r.at)), h('td', { class: 'audit-action' }, actionLabel(r.action)), h('td', {}, r.target || ''), h('td', { class: 'secondary hide-sm' }, r.actor))))))
      : h('div', { class: 'muted' }, t('No changes yet.'))));
  return out;
};

/* Customers */
async function loadPlans() { return (await api('plans')).plans; }

pages.customers = async () => {
  const [{ customers }, plans] = await Promise.all([api('customers'), loadPlans()]);
  const planOptions = [{ value: '', label: t('No plan') }, ...plans.map(p => ({ value: p.id, label: p.name }))];
  const newBtn = me.role === 'platform' ? btn(t('New customer'), async () => {
    const r = await formDialog({
      title: t('New customer'), okLabel: t('Create'),
      fields: [{ name: 'name', label: t('Organisation name') }, { name: 'contactEmail', label: t('Contact email (optional)'), type: 'email' }, { name: 'planId', label: t('Plan'), type: 'select', options: planOptions }],
      submit: v => api('customers', v)
    });
    if (r) { toast(t('Customer created')); refresh(); }
  }, 'primary') : null;
  const rows = customers.map(c => {
    const adminChips = h('div', { class: 'chips' }, ...c.admins.map(email => h('span', { class: 'chip' }, email,
      email !== me.email.toLowerCase() ? h('button', { type: 'button', title: t('Remove admin'), 'aria-label': t('Remove admin {email}', { email }), on: { click: async e => {
        e.stopPropagation();
        if (!(await dialog({ title: t('Remove admin'), text: t('{email} will no longer be able to manage {customer}.', { email, customer: c.name }), okLabel: t('Remove'), danger: true }))) return;
        if (await run(() => api('admins/remove', { email, customerId: c.id }), t('Admin removed'))) refresh();
      } } }, '×') : null)));
    const actions = () => {
      const items = [];
      if (!c.internal) items.push({ label: t('Add an admin'), run: async () => {
        const r = await formDialog({ title: t('Add an admin for {customer}', { customer: c.name }), okLabel: t('Add'), intro: t('Admins sign in to the webmail with their own mailbox, then open the admin console.'),
          fields: [{ name: 'email', label: t('Their mailbox address'), type: 'email' }], submit: v => api('admins/add', { email: v.email, customerId: c.id }) });
        if (r) { toast(t('Admin added')); refresh(); }
      } });
      if (me.role === 'platform') {
        items.push({ label: t('Edit'), run: async () => {
          const r = await formDialog({ title: t('Edit {name}', { name: c.name }), fields: [
            { name: 'name', label: t('Organisation name'), value: c.name },
            { name: 'contactEmail', label: t('Contact email'), value: c.contactEmail || '' },
            { name: 'planId', label: t('Plan'), type: 'select', options: planOptions, value: c.planId || '' },
            ...(c.internal ? [] : [{ name: 'status', label: t('Status'), type: 'select', value: c.status, options: [{ value: 'active', label: t('Active') }, { value: 'suspended', label: t('Suspended (its admins cannot use the console)') }] }])
          ], submit: v => api('customers/update', { id: c.id, ...v }) });
          if (r) { toast(t('Saved')); refresh(); }
        } });
        if (!c.internal) items.push({ label: t('Delete'), danger: true, run: async () => {
          if (!(await dialog({ title: t('Delete customer'), text: t('Delete {name}? Its domains must be removed first.', { name: c.name }), okLabel: t('Delete'), danger: true }))) return;
          if (await run(() => api('customers/delete', { id: c.id }), t('Customer deleted'))) refresh();
        } });
      }
      return items;
    };
    const u = c.usage;
    const b = c.billing || {};
    const paidExtra = [b.refundedCents ? t('{amount} refunded', { amount: fmtCents(b.refundedCents) }) : '', b.pendingCents ? t('{amount} waiting', { amount: fmtCents(b.pendingCents) }) : ''].filter(Boolean).join(' · ');
    const paid = h('a', { class: 'paid-link', href: '#/payments/' + encodeURIComponent('customer=' + c.id), title: t('See this client’s payments') },
      h('div', {}, fmtCents(b.paidCents || 0)), paidExtra ? h('div', { class: 'secondary' }, paidExtra) : null);
    return h('tr', {},
      h('td', {}, h('div', { class: 'primary' }, c.name, ' ', c.internal ? badge('IRON ID', 'info') : null, c.kind === 'personal' ? badge(t('Personal'), '') : null, c.status === 'suspended' ? badge(t('Suspended'), 'bad') : null),
        h('div', { class: 'secondary' }, (c.kind === 'personal' ? c.ownerEmail : c.contactEmail) || c.contactEmail || '')),
      h('td', { class: 'hide-sm' }, u.plan ? u.plan.name : h('span', { class: 'muted' }, t('No plan'))),
      h('td', { class: 'num' }, String(u.domains)), h('td', { class: 'num' }, String(u.mailboxes) + (u.plan && u.plan.maxMailboxes ? ' / ' + u.plan.maxMailboxes : '')),
      h('td', { class: 'hide-sm' }, meter(u.usedBytes, u.allocatedBytes)),
      h('td', { class: 'num' }, paid),
      h('td', { class: 'hide-sm' }, adminChips.childNodes.length ? adminChips : h('span', { class: 'muted small' }, t('No admins'))),
      h('td', { class: 'actions' }, moreButton(actions)));
  });
  return [head(me.role === 'platform' ? t('Customers') : t('Your organisation'), null, newBtn),
    table([t('Customer'), { label: t('Plan'), attrs: { class: 'hide-sm' } }, { label: t('Domains'), attrs: { style: 'text-align:right' } }, { label: t('Mailboxes'), attrs: { style: 'text-align:right' } }, { label: t('Storage'), attrs: { class: 'hide-sm' } }, { label: t('Paid'), attrs: { style: 'text-align:right' } }, { label: t('Admins'), attrs: { class: 'hide-sm' } }, ''], rows, t('No customers yet.'))];
};

/* Domains */
const STATUS_BADGE = { pending: [t('Waiting for DNS'), 'warn'], active: [t('Active'), 'ok'], verified: [t('Verified'), 'ok'], suspended: [t('Suspended'), 'bad'], unassigned: [t('Not assigned'), ''] };

pages.domains = async arg => {
  if (arg) return domainDetail(arg);
  const [{ domains }, custs] = await Promise.all([api('domains'), me.role === 'platform' ? api('customers') : Promise.resolve({ customers: [] })]);
  const customerOptions = custs.customers.map(c => ({ value: c.id, label: c.name + (c.internal ? ' (IRON ID)' : '') }));
  const add = btn(t('Add domain'), async () => {
    const fields = [{ name: 'domain', label: t('Domain name'), placeholder: 'company.dz', help: t('The part after @ in the addresses, without www.') }];
    if (me.role === 'platform') fields.push({ name: 'customerId', label: t('Customer'), type: 'select', options: customerOptions });
    const r = await formDialog({ title: t('Add a domain'), okLabel: t('Add'), fields, submit: v => api('domains', v) });
    if (r) { toast(r.status === 'active' ? t('Domain assigned') : t('Domain added. Now add the DNS records.')); go('domains', r.domain); }
  }, 'primary');
  const rows = domains.map(d => {
    const [label, kind] = STATUS_BADGE[d.status] || [d.status, ''];
    const tr = h('tr', { class: d.status === 'unassigned' ? '' : 'clickable' },
      h('td', {}, h('div', { class: 'primary' }, d.domain), d.customer ? h('div', { class: 'secondary' }, d.customer) : null),
      h('td', {}, badge(label, kind), ' ', d.platform ? badge(t('Platform'), 'info') : null),
      h('td', { class: 'num' }, String(d.mailboxes || 0)), h('td', { class: 'num hide-sm' }, String(d.teams || 0)),
      h('td', { class: 'hide-sm secondary' }, d.verifiedAt ? t('Verified {date}', { date: fmtDate(d.verifiedAt) }) : d.createdAt ? t('Added {date}', { date: fmtDate(d.createdAt) }) : ''),
      h('td', { class: 'actions' }, d.status === 'unassigned' && me.role === 'platform'
        ? btn(t('Assign'), async e => {
          e.stopPropagation();
          const r = await formDialog({ title: t('Assign {domain}', { domain: d.domain }), okLabel: t('Assign'), intro: t('This domain already works in the mail engine. Choose the customer it belongs to.'),
            fields: [{ name: 'customerId', label: t('Customer'), type: 'select', options: customerOptions }], submit: v => api('domains', { domain: d.domain, customerId: v.customerId }) });
          if (r) { toast(t('Domain assigned')); refresh(); }
        }, 'small') : h('span', { class: 'muted' }, '›')));
    if (d.status !== 'unassigned') tr.addEventListener('click', () => go('domains', d.domain));
    return tr;
  });
  return [head(t('Domains'), t('Each domain needs a few DNS records at the company that hosts its DNS (registrar).'), add),
    table([t('Domain'), t('Status'), { label: t('Mailboxes'), attrs: { style: 'text-align:right' } }, { label: t('Teams'), attrs: { class: 'hide-sm', style: 'text-align:right' } }, { label: '', attrs: { class: 'hide-sm' } }, ''], rows, t('No domains yet. Add your company’s domain to start.'))];
};

async function domainDetail(domain) {
  const d = await api('domains/dns?domain=' + encodeURIComponent(domain));
  const out = [];
  const [label, kind] = STATUS_BADGE[d.status] || [d.status, ''];
  const removeBtn = !d.platform ? btn(t('Remove domain'), async () => {
    const v = await dialog({ title: t('Remove {domain}', { domain: d.domain }), text: t('Type {domain} to confirm. Its mailboxes and teams must be deleted first.', { domain: d.domain }), input: '', okLabel: t('Remove'), danger: true });
    if (!v) return;
    if (await run(() => api('domains/remove', { domain: d.domain, confirm: v }), t('Domain removed'))) go('domains');
  }, 'danger') : null;
  out.push(head(d.domain, null, h('a', { class: 'btn', href: '#/domains' }, t('‹ All domains')), btn(t('Check again'), refresh), removeBtn));
  out.push(h('div', { style: { marginTop: '-8px', marginBottom: '14px' } }, badge(label, kind), ' ', d.platform ? badge(t('Platform domain'), 'info') : null));
  for (const w of d.warnings) out.push(h('div', { class: 'alert warn' }, w));

  if (d.status === 'pending') {
    const verify = btn(t('Verify now'), async () => {
      const r = await run(() => api('domains/verify', { domain: d.domain }));
      if (r) { toast(t('Domain verified. You can add mailboxes now.')); refresh(); }
    }, 'primary');
    const skip = me.role === 'platform' ? btn(t('Verify without the DNS check'), async () => {
      if (!(await dialog({ title: t('Skip the DNS check'), text: t('Only do this when IRON ID manages this domain’s DNS or the owner is confirmed another way.'), okLabel: t('Verify'), danger: true }))) return;
      if (await run(() => api('domains/verify', { domain: d.domain, skipCheck: true }), t('Domain verified'))) refresh();
    }) : null;
    out.push(h('div', { class: 'alert info' }, h('div', {}, h('b', {}, t('Step 1: prove that you own the domain. ')),
      t('Add the first TXT record below at your DNS provider, then press Verify. The other records can be added now too; mail starts arriving once the MX record points to IRON ID.'))));
    out.push(h('div', { class: 'toolbar' }, verify, skip));
  }

  const recs = d.records.map(r => h('tr', {},
    h('td', {}, h('span', { class: 'status-dot ' + (r.ok ? 'ok' : r.required ? 'bad' : 'warn') }), r.ok ? t('Found') : r.problem ? t('Problem') : t('Missing')),
    h('td', {}, h('div', { class: 'primary' }, r.type), h('div', { class: 'secondary' }, r.purpose), r.problem ? h('div', { class: 'secondary', style: { color: 'var(--color-danger)' } }, r.problem) : null),
    h('td', {}, h('div', { class: 'dns-value' }, h('code', {}, r.host), copyBtn(r.host))),
    h('td', {}, h('div', { class: 'dns-value' }, h('code', {}, r.value), copyBtn(r.type === 'MX' ? r.value.replace(/^\d+\s+/, '') : r.value)), r.type === 'MX' ? h('div', { class: 'secondary' }, t('Priority 10')) : null)));
  out.push(h('div', { class: 'card' }, h('h2', {}, t('DNS records')),
    h('p', { class: 'help' }, t('Host "@" means the domain itself. Some providers want the full name instead (for example {name}). Long DKIM values may need to be pasted as one line; changes can take up to a few hours to show.', { name: d.records[0] ? d.records[0].name : d.domain })),
    table([t('Status'), t('Record'), t('Host / name'), t('Value')], recs, d.platform ? t('Nothing to publish until new signing keys are created (below).') : t('No records to show.'))));

  if (d.status !== 'pending') {
    const keys = d.keys.map(k => h('tr', {},
      h('td', {}, h('code', {}, k.selector), k.exposed ? h('div', {}, badge(t('Exposed — replace'), 'bad')) : null),
      h('td', {}, k.algorithm), h('td', {}, badge({ active: t('Signing'), pending: t('New — not used yet'), retiring: t('Old'), retired: t('Old') }[k.stage] || k.stage, k.stage === 'active' ? 'ok' : k.stage === 'pending' ? 'info' : '')),
      h('td', { class: 'secondary hide-sm' }, fmtDate(k.createdAt))));
    const hasPending = d.keys.some(k => k.stage === 'pending');
    const hasOld = d.keys.some(k => k.stage === 'retiring' || k.stage === 'retired');
    const canKeys = !d.platform || me.role === 'platform';
    out.push(h('div', { class: 'card' }, h('h2', {}, t('Signing keys (DKIM)'), canKeys ? h('span', { class: 'actions' },
      btn(hasPending ? t('Make other new keys') : t('Create new keys'), async () => {
        if (await run(() => api('domains/dkim/prepare', { domain: d.domain }), t('New keys created. Add their DNS records, then switch.'))) refresh();
      }, 'small'),
      hasPending ? btn(t('Switch to the new keys'), async () => {
        if (await run(() => api('domains/dkim/activate', { domain: d.domain }), t('Now signing with the new keys'))) refresh();
      }, 'small primary') : null,
      hasOld ? btn(t('Remove old keys'), async () => {
        if (!(await dialog({ title: t('Remove old keys'), text: t('Remove the old keys? Afterwards you can delete their DNS records.'), okLabel: t('Remove'), danger: true }))) return;
        if (await run(() => api('domains/dkim/remove-old', { domain: d.domain }), t('Old keys removed'))) refresh();
      }, 'small danger') : null) : null),
      h('p', { class: 'help' }, t('To change keys: create new keys, add their DNS records, wait until they show as Found, then switch. Mail stays signed the whole time.')),
      table([t('Selector'), t('Type'), t('State'), { label: t('Created'), attrs: { class: 'hide-sm' } }], keys, t('No keys yet.'))));

    out.push(h('div', { class: 'card' }, h('h2', {}, t('Catch-all address')),
      h('p', { class: 'help' }, t('Mail sent to an address that does not exist on {domain} can go to one mailbox or team instead of bouncing.', { domain: d.domain })),
      h('div', { class: 'toolbar' }, h('span', {}, d.catchAll ? h('b', {}, d.catchAll) : h('span', { class: 'muted' }, t('Off — unknown addresses bounce'))),
        btn(d.catchAll ? t('Change') : t('Set up'), async () => {
          const v = await dialog({ title: t('Catch-all address'), text: t('Mailbox or team address on {domain} (leave empty to turn off).', { domain: d.domain }), input: d.catchAll || '', okLabel: t('Save') });
          if (v === null) return;
          if (await run(() => api('domains/settings', { domain: d.domain, catchAll: v }), t('Saved'))) refresh();
        }, 'small'))));
  }
  return out;
}

/* Mailboxes */
async function activeDomains() {
  const { domains } = await api('domains');
  return domains.filter(d => d.status === 'active').map(d => d.domain);
}

pages.mailboxes = async () => {
  const [{ mailboxes }, domains, admins] = await Promise.all([api('mailboxes'), activeDomains(), api('admins')]);
  const filter = { q: '', domain: '' };
  const listBox = h('div');
  const domainSel = h('select', { class: 'fl-input', 'aria-label': t('Domain') }, h('option', { value: '' }, t('All domains')), ...domains.map(d => h('option', { value: d }, d)));
  const search = h('input', { class: 'fl-input', type: 'search', placeholder: t('Search address or name'), 'aria-label': t('Search mailboxes') });
  const draw = () => {
    const q = filter.q.toLowerCase();
    const list = mailboxes.filter(m => (!filter.domain || m.domain === filter.domain) && (!q || m.email.includes(q) || (m.name || '').toLowerCase().includes(q)));
    listBox.replaceChildren(table([t('Mailbox'), { label: t('Storage'), attrs: { class: 'hide-sm' } }, t('Status'), ''], list.map(m => mailboxRow(m, admins.admins)), mailboxes.length ? t('No mailbox matches.') : t('No mailboxes yet.')));
  };
  domainSel.addEventListener('change', () => { filter.domain = domainSel.value; draw(); });
  search.addEventListener('input', () => { filter.q = search.value.trim(); draw(); });
  draw();
  const add = btn(t('New mailbox'), async () => {
    if (!domains.length) { toast(t('Add and verify a domain first'), false); return; }
    const r = await formDialog({ title: t('New mailbox'), okLabel: t('Create'), fields: [
      { name: 'email', label: t('Address'), type: 'address', domains, placeholder: t('firstname') },
      { name: 'name', label: t('Person’s name'), placeholder: t('Firstname Lastname') },
      { name: 'quotaMb', label: t('Storage limit in MB (optional)'), type: 'number', min: 50, help: t('Leave empty to use the plan’s limit.') }
    ], submit: v => api('mailboxes', { email: v.email, name: v.name, quotaMb: v.quotaMb || null }) });
    if (r) { await showSecret(t('Mailbox created'), t('{email} is ready. Its temporary password:', { email: r.email }), r.password); refresh(); }
  }, 'primary');
  return [head(t('Mailboxes'), null, add), h('div', { class: 'toolbar' }, search, domainSel), listBox];
};

function mailboxRow(m, admins) {
  const isMe = m.email === me.email.toLowerCase();
  const status = h('div', { class: 'chips' },
    m.suspended ? badge(tx('mailbox', 'Suspended'), 'bad') : badge(tx('mailbox', 'Active'), 'ok'),
    m.twoStep ? badge(t('Two-step'), 'info') : null, m.admin ? badge(tx('badge', 'Admin'), 'warn') : null, m.protected ? badge(m.protected, '') : null);
  const items = () => {
    if (m.protected) return [{ title: t('Managed by IRON ID staff in the engine') }];
    const out = [{ label: t('Edit name, storage, aliases'), run: () => editMailbox(m) }];
    if (!isMe) {
      out.push({ label: t('Reset sign-in…'), run: async () => {
        if (!(await dialog({ title: t('Reset sign-in for {email}', { email: m.email }), text: t('This sets a new temporary password, turns off two-step sign-in, removes all app passwords (mail apps must sign in again) and signs out every browser.'), okLabel: t('Reset'), danger: true }))) return;
        const r = await run(() => api('mailboxes/reset-signin', { id: m.id }));
        if (r) { await showSecret(t('New temporary password'), t('{email} can now sign in with:', { email: r.email }), r.password); refresh(); }
      } });
      out.push(m.suspended
        ? { label: tx('mailbox', 'Restore'), run: async () => { if (await run(() => api('mailboxes/suspend', { id: m.id, suspended: false }), t('Mailbox restored'))) refresh(); } }
        : { label: t('Suspend'), run: async () => {
          if (!(await dialog({ title: t('Suspend {email}', { email: m.email }), text: t('The person is signed out and cannot sign in until you restore the mailbox. Mail keeps arriving.'), okLabel: t('Suspend'), danger: true }))) return;
          if (await run(() => api('mailboxes/suspend', { id: m.id, suspended: true }), t('Mailbox suspended'))) refresh();
        } });
    }
    const customerId = me.role === 'customer' && me.customers[0] ? me.customers[0].id : null;
    if (customerId && !m.admin) out.push({ label: t('Make admin'), run: async () => { if (await run(() => api('admins/add', { email: m.email, customerId }), t('Admin added'))) refresh(); } });
    if (customerId && m.admin && !isMe) out.push({ label: t('Remove admin'), run: async () => { if (await run(() => api('admins/remove', { email: m.email, customerId }), t('Admin removed'))) refresh(); } });
    if (!isMe) out.push({ label: t('Delete…'), danger: true, run: async () => {
      const v = await dialog({ title: t('Delete {email}', { email: m.email }), text: t('This deletes the mailbox and all its mail for good. Type {email} to confirm.', { email: m.email }), input: '', okLabel: t('Delete'), danger: true });
      if (!v) return;
      if (await run(() => api('mailboxes/delete', { id: m.id, confirm: v }), t('Mailbox deleted'))) refresh();
    } });
    return out;
  };
  return h('tr', {},
    h('td', {}, h('div', { class: 'primary' }, m.email), h('div', { class: 'secondary' }, [m.name, m.aliases.length ? t('also {list}', { list: m.aliases.join(', ') }) : '', m.teams.length ? t('teams: {list}', { list: m.teams.join(', ') }) : ''].filter(Boolean).join(' · '))),
    h('td', { class: 'hide-sm' }, meter(m.usedBytes, m.quotaMb ? m.quotaMb * 1024 * 1024 : 0)),
    h('td', {}, status),
    h('td', { class: 'actions' }, moreButton(items)));
}

async function editMailbox(m) {
  const r = await formDialog({ title: t('Edit {name}', { name: m.email }), fields: [
    { name: 'name', label: t('Person’s name'), value: m.name },
    { name: 'quotaMb', label: t('Storage limit in MB'), type: 'number', min: 50, value: m.quotaMb || '', help: t('Empty = no limit (or the plan’s limit).') },
    { name: 'aliases', label: t('Other addresses (aliases), one per line'), type: 'textarea', value: m.aliases.join('\n'), placeholder: 'contact@' + m.domain, help: t('Mail to these addresses arrives in this mailbox.') }
  ], submit: v => api('mailboxes/update', { id: m.id, name: v.name, quotaMb: v.quotaMb === '' ? null : v.quotaMb, aliases: v.aliases.split(/[\s,;]+/).filter(Boolean) }) });
  if (r) { toast(t('Saved')); refresh(); }
}

/* Teams */
pages.teams = async () => {
  const [{ teams }, { mailboxes }, domains] = await Promise.all([api('teams'), api('mailboxes'), activeDomains()]);
  const choices = mailboxes.filter(m => !m.protected).map(m => ({ value: m.email, label: m.name ? `${m.name} <${m.email}>` : m.email }));
  const add = btn(t('New team'), async () => {
    if (!domains.length) { toast(t('Add and verify a domain first'), false); return; }
    const r = await formDialog({ title: t('New team mailbox'), okLabel: t('Create'), intro: t('A shared address such as contact@ or support@. Its members see it in their webmail, can assign messages to each other and reply as the team.'), fields: [
      { name: 'email', label: t('Address'), type: 'address', domains, placeholder: 'support' },
      { name: 'name', label: t('Team name'), placeholder: t('Customer support') },
      { name: 'members', label: t('Members'), type: 'checks', choices }
    ], submit: v => api('teams', v) });
    if (r) { toast(t('Team created')); refresh(); }
  }, 'primary');
  const rows = teams.map(tm => h('tr', {},
    h('td', {}, h('div', { class: 'primary' }, tm.email), h('div', { class: 'secondary' }, [tm.name, tm.aliases.length ? t('also {list}', { list: tm.aliases.join(', ') }) : ''].filter(Boolean).join(' · '))),
    h('td', {}, tm.members.length ? h('div', { class: 'chips' }, ...tm.members.map(x => h('span', { class: 'chip' }, x))) : h('span', { class: 'muted small' }, t('No members'))),
    h('td', { class: 'hide-sm' }, meter(tm.usedBytes, 0)),
    h('td', { class: 'actions' }, moreButton(() => [
      { label: t('Edit name, members, aliases'), run: async () => {
        const r = await formDialog({ title: t('Edit {name}', { name: tm.email }), fields: [
          { name: 'name', label: t('Team name'), value: tm.name },
          { name: 'members', label: t('Members'), type: 'checks', choices, value: tm.members },
          { name: 'aliases', label: t('Other addresses (aliases), one per line'), type: 'textarea', value: tm.aliases.join('\n') }
        ], submit: v => api('teams/update', { id: tm.id, name: v.name, members: v.members, aliases: v.aliases.split(/[\s,;]+/).filter(Boolean) }) });
        if (r) { toast(t('Saved')); refresh(); }
      } },
      { label: t('Delete…'), danger: true, run: async () => {
        const v = await dialog({ title: t('Delete {email}', { email: tm.email }), text: t('This deletes the team mailbox and all its mail. Type {email} to confirm.', { email: tm.email }), input: '', okLabel: t('Delete'), danger: true });
        if (!v) return;
        if (await run(() => api('teams/delete', { id: tm.id, confirm: v }), t('Team deleted'))) refresh();
      } }
    ]))));
  return [head(t('Teams'), t('Shared mailboxes: one address, several people.'), add),
    table([t('Team'), t('Members'), { label: t('Storage'), attrs: { class: 'hide-sm' } }, ''], rows, t('No teams yet.'))];
};

/* Activity log */
pages.audit = async () => {
  const state = { kind: '', q: '', entries: [], done: false };
  const listBox = h('div');
  const kindSel = h('select', { class: 'fl-input', 'aria-label': t('Show') }, h('option', { value: '' }, t('Everything')), h('option', { value: 'changes' }, t('Changes')), h('option', { value: 'signin' }, t('Sign-ins')));
  const search = h('input', { class: 'fl-input', type: 'search', placeholder: t('Search address or action'), 'aria-label': t('Search activity') });
  const more = btn(t('Load more'), () => load(true));
  const load = async (append = false) => {
    const before = append && state.entries.length ? state.entries[state.entries.length - 1].id : '';
    const r = await run(() => api(`audit?limit=50&kind=${state.kind}&q=${encodeURIComponent(state.q)}${before ? '&before=' + before : ''}`));
    if (!r) return;
    state.entries = append ? state.entries.concat(r.entries) : r.entries;
    state.done = r.entries.length < 50;
    listBox.replaceChildren(table([t('When'), t('What'), t('Who / what'), { label: t('From'), attrs: { class: 'hide-sm' } }], state.entries.map(e => h('tr', {},
      h('td', { class: 'secondary' }, fmtDateTime(e.at)),
      h('td', {}, h('span', { class: 'audit-action', style: e.action === 'signin.failed' ? { color: 'var(--color-danger)' } : null }, actionLabel(e.action)),
        e.details && e.details.reason ? h('div', { class: 'secondary' }, e.action === 'signin.failed' ? (e.details.reason === 'code' ? t('wrong code') : t('wrong password')) : e.details.reason) : null),
      h('td', {}, h('div', {}, e.target || ''), e.actor && e.actor !== e.target ? h('div', { class: 'secondary' }, t('by {actor}', { actor: e.actor })) : null),
      h('td', { class: 'secondary hide-sm' }, e.ip || ''))), t('No activity.')), state.done ? null : h('div', { class: 'list-more' }, more));
  };
  kindSel.addEventListener('change', () => { state.kind = kindSel.value; load(); });
  let timer = null;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.q = search.value.trim(); load(); }, 300); });
  await load();
  return [head(t('Activity log'), t('Sign-ins and every change made in the console, newest first.')), h('div', { class: 'toolbar' }, search, kindSel), listBox];
};

/* Usage & billing */
pages.usage = async () => {
  const { usage } = await api('usage');
  const rows = usage.map(u => h('tr', {},
    h('td', {}, h('div', { class: 'primary' }, u.customer, ' ', u.internal ? badge('IRON ID', 'info') : null), h('div', { class: 'secondary' }, u.plan ? u.plan.name : t('No plan'))),
    h('td', { class: 'num' }, String(u.billableMailboxes) + (u.plan && u.plan.maxMailboxes ? ' / ' + u.plan.maxMailboxes : '')),
    h('td', { class: 'num hide-sm' }, String(u.teams)),
    h('td', {}, meter(u.usedBytes, u.allocatedBytes)),
    h('td', { class: 'num' }, u.internal ? h('span', { class: 'muted' }, t('Not billed')) : u.monthlyEstimate == null ? h('span', { class: 'muted' }, t('No price set')) : fmtMoney(u.monthlyEstimate, u.plan.currency))));
  return [head(t('Usage & billing'), t('Estimated monthly amount = mailboxes × the plan’s price per mailbox. Teams are included. Card payments for domains are on the Payments page.')),
    table([t('Customer'), { label: t('Mailboxes'), attrs: { style: 'text-align:right' } }, { label: t('Teams'), attrs: { class: 'hide-sm', style: 'text-align:right' } }, t('Storage'), { label: t('Per month'), attrs: { style: 'text-align:right' } }], rows, t('No customers yet.'))];
};

/* Payments */
const ORDER_KIND = { domain_connect: t('Domain set-up'), domain_register: t('Domain purchase'), domain_renew: t('Domain renewal') };
const ORDER_STATUS = {
  pending: [t('Waiting for payment'), ''], paid: [t('Paid'), 'info'], fulfilled: [t('Done'), 'ok'],
  failed: [t('Delivery failed'), 'bad'], cancelled: [t('Cancelled'), ''], refunded: [t('Refunded'), 'warn']
};
const PROVIDERS = { 'stripe-live': t('Stripe live'), 'stripe-test': t('Stripe test'), fake: t('Test payments (fake)'), off: t('Not set up') };
const paymentsArg = (customer, status) => new URLSearchParams(Object.entries({ customer, status }).filter(([, v]) => v)).toString();
const invoiceUrl = id => '/admin-api/invoice?id=' + encodeURIComponent(id) + (lang === 'en' ? '&lang=en' : '');

pages.payments = async arg => {
  const params = new URLSearchParams(arg || '');
  const customer = /^[0-9a-f-]{36}$/i.test(params.get('customer') || '') ? params.get('customer') : '';
  const status = ORDER_STATUS[params.get('status')] ? params.get('status') : '';
  const base = 'billing' + (customer ? '?customer=' + encodeURIComponent(customer) : '');
  const [all, filtered] = await Promise.all([api(base), status ? api(base + (customer ? '&' : '?') + 'status=' + status) : null]);
  const staff = me.role === 'platform';
  const orders = (filtered || all).orders;

  // Stats: this month (paid orders), orders to fix, and for staff the registrar and payment provider.
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const m = all.months.find(x => x.month === thisMonth) || { ttc: 0, ht: 0, vat: 0, n: 0 };
  const failed = all.orders.filter(o => o.status === 'failed').length;
  const stat = (n, l, extra = {}) => h(extra.href ? 'a' : 'div', { class: 'stat', href: extra.href, style: extra.href ? { textDecoration: 'none', color: 'inherit' } : null },
    h('div', { class: 'n' + (extra.small ? ' small' : ''), style: extra.danger ? { color: 'var(--color-danger)' } : null }, n), h('div', { class: 'l' }, l, extra.badge ? [' ', extra.badge] : null), extra.more || null);
  const stats = [
    stat(fmtCents(m.ttc), t('This month, incl. VAT')),
    stat(fmtCents(m.ht), t('This month, excl. VAT')),
    stat(fmtCents(m.vat), t('This month, VAT')),
    stat(String(failed), t('Orders to fix'), { href: '#/payments/' + encodeURIComponent(paymentsArg(customer, 'failed')), danger: failed > 0 })
  ];
  if (staff) {
    let regN, regL = t('Registrar balance'), regMore = null;
    if (all.registrar === 'off' || !all.registrar) { regN = '—'; regL = t('Registrar not set up'); }
    else if (all.registrarError || !all.registrarBalance) {
      regN = '—';
      regMore = h('div', { class: 'l', style: { color: 'var(--color-danger)' } }, all.registrarError === 'The registrar could not be reached.' ? t('The registrar could not be reached.') : (all.registrarError || t('Unknown')));
    } else {
      const rb = all.registrarBalance;
      let v;
      try { v = new Intl.NumberFormat(locale, { style: 'currency', currency: rb.currency || 'USD' }).format(rb.balance); } catch (e) { v = fmtMoney(rb.balance, rb.currency); }
      regN = v;
      if (rb.holdBalance) regMore = h('div', { class: 'l' }, t('{amount} on hold', { amount: fmtMoney(rb.holdBalance, rb.currency) }));
    }
    stats.push(stat(regN, regL, { more: regMore }));
    const live = all.provider === 'stripe-live';
    stats.push(stat(PROVIDERS[all.provider] || all.provider, t('Card payments'), { small: true, badge: live ? badge(t('Real payments'), 'ok') : badge(all.provider === 'off' ? t('Cannot take payments') : t('Test only'), 'warn') }));
  }

  // Filters
  const statusSel = h('select', { class: 'fl-input', 'aria-label': t('Status') }, h('option', { value: '' }, t('All statuses')),
    ...Object.entries(ORDER_STATUS).map(([k, [label]]) => h('option', { value: k, selected: k === status }, label)));
  statusSel.addEventListener('change', () => go('payments', paymentsArg(customer, statusSel.value)));
  let customerName = '';
  if (customer) {
    const o = all.orders.find(x => x.customerId === customer);
    if (o) customerName = o.customer || '';
    else { const c = await api('customers').catch(() => ({ customers: [] })); const x = c.customers.find(y => y.id === customer); customerName = x ? x.name : ''; }
  }
  const chip = customer ? h('span', { class: 'chip' }, t('Client: {name}', { name: customerName || t('Unknown') }),
    h('button', { type: 'button', title: t('Show every client'), 'aria-label': t('Show every client'), on: { click: () => go('payments', paymentsArg('', status)) } }, '×')) : null;

  // Orders
  const rows = orders.map(o => {
    const [label, kind] = ORDER_STATUS[o.status] || [o.status, ''];
    const retry = staff && o.status === 'failed' ? btn(t('Try again'), async e => {
      const b = e.currentTarget; b.disabled = true;
      const r = await run(() => api('billing/retry', { id: o.id }));
      b.disabled = false;
      if (!r) return;
      if (r.status === 'failed') toast(t('Delivery failed again: {error}', { error: r.error || '' }), false);
      else toast(t('Delivered'));
      refresh();
    }, 'small') : null;
    const inv = o.invoiceNumber ? h('a', { href: invoiceUrl(o.id), target: '_blank', rel: 'noopener', class: 'inv-link mono', title: t('Open the invoice') }, o.invoiceNumber) : h('span', { class: 'muted' }, '—');
    // Credit notes (avoirs) made when the payment was refunded in Stripe.
    const creditLinks = (o.creditNotes || []).map(c => h('div', {}, h('a', { href: '/admin-api/credit-note?id=' + c.id + '&lang=' + (lang === 'en' ? 'en' : 'fr'), target: '_blank', rel: 'noopener', class: 'inv-link mono', title: t('Open the credit note (refund of {amount})', { amount: fmtCents(c.amountCents, o.currency) }) }, c.number)));
    return h('tr', {},
      h('td', { class: 'secondary nowrap' }, fmtDateTime(o.paidAt || o.createdAt)),
      staff ? h('td', {}, h('div', { class: 'primary' }, h('a', { href: '#/payments/' + encodeURIComponent(paymentsArg(o.customerId, status)), class: 'plain-link', title: t('Only this client') }, o.customer || t('Unknown')),
        o.customerKind === 'personal' ? [' ', badge(t('Personal'), '')] : null), o.email ? h('div', { class: 'secondary' }, o.email) : null) : null,
      h('td', { class: 'order-what' }, h('div', { class: 'primary' }, o.domain), h('div', { class: 'secondary' }, ORDER_KIND[o.kind] || o.kind)),
      h('td', { class: 'num' }, fmtCents(o.amountCents, o.currency), h('div', { class: 'secondary' }, t('excl. VAT {amount}', { amount: fmtCents(o.amountHtCents, o.currency) }))),
      h('td', {}, badge(label, kind), o.status === 'failed' && o.error ? h('div', { class: 'secondary order-error' }, o.error) : null),
      h('td', { class: 'hide-sm' }, inv, ...creditLinks),
      h('td', { class: 'actions' }, retry));
  });
  const heads = [t('Date'), staff ? t('Client') : null, t('What'), { label: t('Amount incl. VAT'), attrs: { style: 'text-align:right' } }, t('Status'), { label: t('Invoice'), attrs: { class: 'hide-sm' } }, ''].filter(x => x !== null);

  // By month
  const monthName = ym => { const [y, mo] = ym.split('-').map(Number); const s = new Date(y, mo - 1, 1).toLocaleDateString(locale, { month: 'long', year: 'numeric' }); return s.charAt(0).toUpperCase() + s.slice(1); };
  const monthRows = all.months.map(x => h('tr', {},
    h('td', {}, monthName(x.month)), h('td', { class: 'num' }, String(x.n)),
    h('td', { class: 'num' }, fmtCents(x.ht)), h('td', { class: 'num' }, fmtCents(x.vat)), h('td', { class: 'num' }, h('b', {}, fmtCents(x.ttc))),
    h('td', { class: 'num' }, x.refundTtc ? '−' + fmtCents(x.refundTtc) : '—'),
    h('td', { class: 'num' }, h('b', {}, fmtCents(x.ttc - (x.refundTtc || 0))))));

  return [head(t('Payments'), staff ? t('Card payments for domains: every order, what was paid and the invoices.') : t('What your organisation paid for domains, with the invoices.')),
    h('div', { class: 'stats' }, ...stats),
    h('div', { class: 'card' }, h('h2', {}, t('By month')),
      h('p', { class: 'help' }, t('Paid orders, by the month they were paid. Refunds (credit notes) count in the month they were made.')),
      table([t('Month'), { label: t('Orders'), attrs: { style: 'text-align:right' } }, { label: t('Excl. VAT'), attrs: { style: 'text-align:right' } }, { label: t('VAT'), attrs: { style: 'text-align:right' } }, { label: t('Incl. VAT'), attrs: { style: 'text-align:right' } },
        { label: t('Refunds'), attrs: { style: 'text-align:right' } }, { label: t('Net incl. VAT'), attrs: { style: 'text-align:right' } }], monthRows, t('No payments yet.'))),
    h('h2', { class: 'section-title' }, t('Orders')),
    h('div', { class: 'toolbar' }, statusSel, chip),
    table(heads, rows, customer || status ? t('No order matches.') : t('No orders yet.'))];
};

/* Plans (platform) */
pages.plans = async () => {
  const plans = await loadPlans();
  const edit = p => formDialog({ title: p ? t('Edit {name}', { name: p.name }) : t('New plan'), okLabel: p ? t('Save') : t('Create'), fields: [
    { name: 'name', label: t('Plan name'), value: p ? p.name : '' },
    { name: 'maxMailboxes', label: t('Mailboxes included'), type: 'number', min: 1, value: p ? p.maxMailboxes ?? '' : '', help: t('Empty = no limit.') },
    { name: 'mailboxQuotaMb', label: t('Storage per mailbox (MB)'), type: 'number', min: 50, value: p ? p.mailboxQuotaMb ?? '' : '', help: t('10240 MB = 10 GB. Empty = no limit.') },
    { name: 'pricePerMailbox', label: t('Price per mailbox per month'), type: 'number', min: 0, step: '0.01', value: p ? p.pricePerMailbox ?? '' : '' },
    { name: 'currency', label: t('Currency'), value: p ? p.currency : 'DZD', mono: true }
  ], submit: v => api('plans', { id: p ? p.id : undefined, ...v }) });
  const rows = plans.map(p => h('tr', {},
    h('td', {}, h('div', { class: 'primary' }, p.name), h('div', { class: 'secondary' }, tn('{n} customer', '{n} customers', p.customers))),
    h('td', { class: 'num' }, p.maxMailboxes == null ? t('No limit') : String(p.maxMailboxes)),
    h('td', { class: 'num' }, p.mailboxQuotaMb == null ? t('No limit') : formatSize(p.mailboxQuotaMb * 1024 * 1024)),
    h('td', { class: 'num' }, fmtMoney(p.pricePerMailbox, p.currency)),
    h('td', { class: 'actions' }, moreButton(() => [
      { label: t('Edit'), run: async () => { if (await edit(p)) { toast(t('Saved')); refresh(); } } },
      { label: t('Delete'), danger: true, run: async () => {
        if (!(await dialog({ title: t('Delete {name}', { name: p.name }), text: t('Delete this plan? Customers must be moved to another plan first.'), okLabel: t('Delete'), danger: true }))) return;
        if (await run(() => api('plans/delete', { id: p.id }), t('Plan deleted'))) refresh();
      } }
    ]))));
  return [head(t('Plans'), t('What each customer gets and pays. The mailbox limit and storage are enforced when admins add mailboxes.'), btn(t('New plan'), async () => { if (await edit(null)) { toast(t('Plan created')); refresh(); } }, 'primary')),
    table([t('Plan'), { label: t('Mailboxes'), attrs: { style: 'text-align:right' } }, { label: t('Storage each'), attrs: { style: 'text-align:right' } }, { label: t('Price / mailbox'), attrs: { style: 'text-align:right' } }, ''], rows, t('No plans yet.'))];
};

/* Platform settings */
pages.settings = async () => {
  const [ret, { admins }, bs] = await Promise.all([api('retention').catch(e => ({ error: e.message })), api('admins'), api('billing/settings').catch(e => ({ error: e.message }))]);
  const days = h('input', { class: 'fl-input', type: 'number', min: 1, max: 3650, value: ret.trashDays ?? '', style: { width: '120px' }, 'aria-label': t('Days') });
  const retention = h('div', { class: 'card' }, h('h2', {}, t('Trash and Junk')),
    h('p', { class: 'help' }, t('Messages in Trash and Junk are deleted for good after this many days, for every mailbox.')),
    ret.error ? h('div', { class: 'alert warn' }, ret.error) : h('div', { class: 'toolbar' }, days, h('span', {}, t('days')), btn(t('Save'), async () => {
      if (await run(() => api('retention', { trashDays: days.value }), t('Saved'))) refresh();
    }, 'primary')));
  const platform = admins.filter(a => a.role === 'platform');
  const staff = h('div', { class: 'card' }, h('h2', {}, t('IRON ID staff (platform admins)'), h('span', { class: 'actions' }, btn(t('Add'), async () => {
    const r = await formDialog({ title: t('Add a platform admin'), okLabel: t('Add'), intro: t('Platform admins can manage every customer. Use IRON ID staff mailboxes only.'), fields: [{ name: 'email', label: t('Mailbox address'), type: 'email' }], submit: v => api('admins/add', { email: v.email, role: 'platform' }) });
    if (r) { toast(t('Admin added')); refresh(); }
  }, 'small'))),
    h('p', { class: 'help' }, t('Addresses listed in the PLATFORM_ADMINS setting are added back on every start.')),
    h('div', { class: 'chips' }, ...platform.map(a => h('span', { class: 'chip' }, a.email, a.email !== me.email.toLowerCase() ? h('button', { type: 'button', title: t('Remove'), 'aria-label': t('Remove {email}', { email: a.email }), on: { click: async () => {
      if (!(await dialog({ title: t('Remove platform admin'), text: t('Remove {email}?', { email: a.email }), okLabel: t('Remove'), danger: true }))) return;
      if (await run(() => api('admins/remove', { email: a.email, role: 'platform' }), t('Removed'))) refresh();
    } } }, '×') : null))));
  return [head(t('Platform settings')), pricesCard(bs), retention, staff];
};

/** Prices, VAT and the seller details printed on invoices (POST /admin-api/billing/settings). */
function pricesCard(bs) {
  const card = h('div', { class: 'card' }, h('h2', {}, t('Prices and invoices')));
  if (bs.error) { card.append(h('div', { class: 'alert warn' }, bs.error)); return card; }
  const unset = v => (!v || /^\[.*\]$/.test(v) ? '' : v); // "[SIRET]" etc. = not filled in yet
  const euros = c => (c == null ? '' : (Math.round(c) / 100).toFixed(2));
  const fields = [];
  const field = (label, input, help, wide) => {
    const id = 'bs_' + fields.length;
    input.id = id;
    fields.push(h('div', { class: 'field' + (wide ? ' wide' : '') }, h('label', { class: 'fl-label', for: id }, label), input, help ? h('div', { class: 'help' }, help) : null));
    return input;
  };
  const num = (value, attrs = {}) => h('input', { class: 'fl-input', type: 'number', min: 0, step: '0.01', value, ...attrs });
  const txt = (value, attrs = {}) => h('input', { class: 'fl-input', type: 'text', value, autocomplete: 'off', ...attrs });
  const connect = field(t('Price to connect a domain (€)'), num(euros(bs.prices.domain_connect)), t('Paid once: DNS set-up and copy of the old mailbox.'));
  const register = field(t('Price of a domain per year (€)'), num(euros(bs.prices.domain_register)), t('For a domain bought through IRON ID, and for each renewal.'));
  const vat = field(t('VAT rate (%)'), num(String(bs.vatRate), { max: 50, step: '0.1' }), t('0 = “TVA non applicable, art. 293 B du CGI” is printed on invoices.'));
  const quota = field(t('Free mailbox storage (GB)'), num(bs.quotaMb ? String(Math.round(bs.quotaMb / 1024 * 100) / 100) : '', { min: 0.05, step: '0.5' }), t('For new personal mailboxes created by sign-up.'));
  const incl = h('input', { type: 'checkbox', checked: bs.pricesIncludeVat });
  fields.push(h('div', { class: 'field wide' }, h('label', { class: 'check-row' }, incl, t('Prices include VAT')),
    h('div', { class: 'help' }, t('Ticked: the prices above are what people pay (incl. VAT). Not ticked: VAT is added on top.'))));
  const tlds = field(t('Domain endings sold'), txt(bs.tlds.join(', '), { class: 'fl-input mono', placeholder: 'fr, com, net, org, eu' }), t('Separated by commas, without the dot.'), true);
  fields.push(h('h3', { class: 'field-group wide' }, t('Seller details printed on invoices')));
  const sName = field(t('Company name'), txt(unset(bs.seller.name)));
  const sEmail = field(t('Contact email'), txt(unset(bs.seller.email), { type: 'email' }));
  const sAddr = field(t('Address'), txt(unset(bs.seller.address), { placeholder: t('Street, postcode, town') }), null, true);
  const sSiret = field(t('SIRET'), txt(unset(bs.seller.siret), { class: 'fl-input mono' }));
  const sVat = field(t('VAT number'), txt(unset(bs.seller.vatNumber), { class: 'fl-input mono', placeholder: 'FR…' }), t('Leave empty if you have none.'));
  const cents = (input, label) => {
    const n = Number(String(input.value).replace(',', '.'));
    if (input.value === '' || !Number.isFinite(n) || n < 0) throw new ApiError(t('Enter a price for “{field}”, for example 14 or 14.50.', { field: label }), 400);
    return Math.round(n * 100);
  };
  const gbToMb = v => {
    const n = Number(String(v).replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) throw new ApiError(t('Enter the storage in GB, for example 5.'), 400);
    return Math.round(n * 1024);
  };
  const save = btn(t('Save'), async () => {
    let body;
    try {
      body = {
        'price.domain_connect_cents': cents(connect, t('Price to connect a domain (€)')),
        'price.domain_register_cents': cents(register, t('Price of a domain per year (€)')),
        'billing.vat_rate': vat.value === '' ? 'x' : String(vat.value).replace(',', '.'),
        'billing.prices_include_vat': incl.checked,
        'billing.tlds': tlds.value,
        'signup.quota_mb': quota.value === '' ? '' : gbToMb(quota.value),
        'seller.name': sName.value.trim(), 'seller.address': sAddr.value.trim(), 'seller.siret': sSiret.value.trim(),
        'seller.vat_number': sVat.value.trim(), 'seller.email': sEmail.value.trim()
      };
    } catch (e) { toast(e.message, false); return; }
    save.disabled = true;
    const r = await run(() => api('billing/settings', body), t('Prices and invoice details saved'));
    save.disabled = false;
    if (r) refresh();
  }, 'primary');
  card.append(h('p', { class: 'help' }, t('What people pay for their own domain, and what is printed on their invoices. Changes apply to new orders only.')),
    h('div', { class: 'billing-form' }, ...fields), h('div', { class: 'toolbar', style: { marginTop: '14px', marginBottom: '0' } }, save));
  return card;
}

/* ——— Start ——— */
function signedOut(message) {
  me = null;
  $('#adminNav').replaceChildren();
  $('#page').replaceChildren(h('div', { class: 'signed-out' }, h('div', { class: 'card' },
    h('h1', {}, 'IRON ID Admin'),
    h('p', {}, message || t('Sign in to the webmail with your admin mailbox, then come back here.')),
    h('a', { class: 'btn primary', href: '/' }, t('Go to sign in')))));
}

async function start() {
  try { me = await api('me'); }
  catch (e) {
    if (e.status === 401) return signedOut();
    if (e.status === 403) return signedOut(t('This mailbox is not an administrator. Ask your organisation’s admin or IRON ID.'));
    return signedOut(e.message);
  }
  $('#hdrUserEmail').textContent = me.email;
  $('#hdrRole').textContent = me.role === 'platform' ? t('IRON ID staff') : t('Admin · {customer}', { customer: me.customers[0] ? me.customers[0].name : '' });
  $('#userAvatar').textContent = initials('', me.email);
  render();
}

window.addEventListener('hashchange', render);
$('#btnSignOut').addEventListener('click', async () => {
  try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) { /* offline */ }
  window.location.replace('/');
});
$('#navToggle').addEventListener('click', () => {
  const open = document.body.classList.toggle('nav-open');
  $('#navToggle').setAttribute('aria-expanded', String(open));
});
$('#navScrim').addEventListener('click', () => document.body.classList.remove('nav-open'));
start();
