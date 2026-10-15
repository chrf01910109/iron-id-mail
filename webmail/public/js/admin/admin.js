// IRON ID admin console. Admins are signed in with their own mailbox (same session as
// the webmail); everything goes through /admin-api, which checks the role and scope.
// Untrusted text is only inserted with textContent (h()).

import { h, $, $$, toast, dialog, openMenu, formatSize, initials, icon } from '../util.js';

/* ——— API ——— */
class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
async function api(path, body) {
  let res;
  try {
    res = await fetch('/admin-api/' + path, body === undefined
      ? { credentials: 'same-origin', cache: 'no-store' }
      : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) { throw new ApiError('Network problem: the server could not be reached.', 0); }
  let data = {};
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) throw new ApiError(data.error || ('Server error (HTTP ' + res.status + ')'), res.status);
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
  plans: '<path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
};
// nosemgrep: h-helper-html-attribute-with-variable -- constant icon table, names from code
const navIcon = name => h('span', { class: 'ic', style: { display: 'inline-flex' }, html: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${NAV_ICONS[name]}</svg>` });

const fmtDate = iso => iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
const fmtDateTime = iso => iso ? new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtMoney = (n, cur) => n == null ? '—' : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n) + ' ' + (cur || '');
const badge = (text, kind = '') => h('span', { class: 'badge ' + kind }, text);
const btn = (label, onClick, cls = '') => h('button', { type: 'button', class: 'btn ' + cls, on: { click: onClick } }, label);
const table = (heads, rows, empty = 'Nothing here yet.') => rows.length
  ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ...heads.map(x => typeof x === 'string' ? h('th', {}, x) : h('th', x.attrs || {}, x.label)))), h('tbody', {}, ...rows)))
  : h('div', { class: 'card empty' }, empty);
const moreButton = items => {
  const b = h('button', { type: 'button', class: 'icon-btn row-more', title: 'Actions', 'aria-label': 'Actions' }, icon('dots', 15));
  b.addEventListener('click', e => { e.stopPropagation(); openMenu(b, items()); });
  return b;
};
function meter(used, limit) {
  if (!limit) return h('div', { class: 'secondary' }, formatSize(used) + ' used');
  const pct = Math.min(100, Math.round(used / limit * 100));
  return h('div', {}, h('div', { class: 'secondary' }, `${formatSize(used)} of ${formatSize(limit)}`),
    h('div', { class: 'meter' }, h('div', { class: pct >= 95 ? 'full' : pct >= 80 ? 'warn' : '', style: { width: Math.max(pct, 1) + '%' } })));
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch (e) { toast('Select the text and copy it', false); }
}
const copyBtn = text => h('button', { type: 'button', class: 'btn small', on: { click: () => copy(text) } }, 'Copy');
async function run(fn, done) {
  try { const r = await fn(); if (done) toast(done); return r; }
  catch (e) { if (e.status === 401) return signedOut(); toast(e.message, false); return undefined; }
}

/** A modal form. fields: [{name, label, type, value, options, help, required, placeholder, rows, choices}] */
function formDialog({ title, intro, fields, okLabel = 'Save', danger = false, submit }) {
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
          ...(f.choices.length ? f.choices.map(c => h('label', {}, h('input', { type: 'checkbox', value: c.value, checked: (f.value || []).includes(c.value) }), c.label)) : [h('span', { class: 'muted small' }, 'No mailboxes yet.')]));
      } else if (f.type === 'address') {
        const local = h('input', { id, class: 'fl-input', type: 'text', placeholder: f.placeholder || 'name', autocomplete: 'off', value: f.value || '' });
        const dom = h('select', { class: 'fl-input', 'aria-label': 'Domain' }, ...f.domains.map(d => h('option', { value: d }, '@' + d)));
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
    const cancel = h('button', { type: 'button', class: 'act-btn' }, 'Cancel');
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
  const done = h('button', { type: 'button', class: 'compose-btn' }, 'Done');
  const box = h('div', { class: 'secret-box', id: 'secretValue' }, secret);
  const m = h('div', { class: 'modal form', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-hdr' }, h('h3', {}, title)),
    h('div', { class: 'modal-body' }, h('p', {}, text), box, h('div', {}, copyBtn(secret)),
      h('p', { class: 'muted small' }, 'This is shown only once. Share it privately (not by email to the same mailbox), and ask the person to change it in Settings → Security after signing in.')),
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
  { id: 'overview', label: 'Overview' },
  { id: 'customers', label: 'Customers' },
  { id: 'domains', label: 'Domains' },
  { id: 'mailboxes', label: 'Mailboxes' },
  { id: 'teams', label: 'Teams' },
  { id: 'audit', label: 'Activity log' },
  { id: 'usage', label: 'Usage & billing' },
  { id: 'plans', label: 'Plans', platform: true },
  { id: 'settings', label: 'Platform settings', platform: true }
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
  $('#adminNav').replaceChildren(h('div', { class: 'sb-section' }, me.role === 'platform' ? 'IRON ID staff' : (me.customers[0] ? me.customers[0].name : 'Admin')), ...items);
}

let renderSeq = 0;
async function render() {
  if (!me) return;
  renderNav();
  const { page, arg } = currentRoute();
  const seq = ++renderSeq;
  const root = $('#page');
  root.replaceChildren(h('div', { class: 'loading-text' }, 'Loading…'));
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
  'signin.ok': 'Signed in', 'signin.failed': 'Failed sign-in', 'mailbox.created': 'Mailbox created', 'mailbox.updated': 'Mailbox changed',
  'mailbox.deleted': 'Mailbox deleted', 'mailbox.suspended': 'Mailbox suspended', 'mailbox.restored': 'Mailbox restored', 'mailbox.signin_reset': 'Sign-in reset',
  'team.created': 'Team created', 'team.updated': 'Team changed', 'team.deleted': 'Team deleted', 'domain.added': 'Domain added', 'domain.assigned': 'Domain assigned',
  'domain.verified': 'Domain verified', 'domain.removed': 'Domain removed', 'domain.catch_all': 'Catch-all changed', 'domain.dkim_prepared': 'New DKIM keys created',
  'domain.dkim_activated': 'Switched DKIM keys', 'domain.dkim_removed': 'Old DKIM keys removed', 'customer.created': 'Customer created', 'customer.updated': 'Customer changed',
  'customer.deleted': 'Customer deleted', 'admin.added': 'Admin added', 'admin.removed': 'Admin removed', 'plan.created': 'Plan created', 'plan.updated': 'Plan changed',
  'plan.deleted': 'Plan deleted', 'retention.updated': 'Retention changed', 'account.password_changed': 'Password changed', 'account.two_step_on': 'Two-step turned on',
  'account.two_step_off': 'Two-step turned off', 'account.signed_out_others': 'Signed out other browsers', 'account.app_password_created': 'App password created',
  'account.app_password_revoked': 'App password removed', 'engine_api_key.provisioned': 'Engine access set up'
};
const actionLabel = a => ACTION_LABELS[a] || a;

pages.overview = async () => {
  const o = await api('overview');
  const out = [head('Overview', me.role === 'platform' ? 'Everything on IRON ID Mail.' : 'Your organisation on IRON ID Mail.')];
  if (me.twoStep === false) {
    out.push(h('div', { class: 'alert warn' }, 'Your admin mailbox does not use two-step sign-in. Turn it on in the webmail: Settings → Security.'));
  }
  if (o.engine && o.engine.adminAccess === 'needs_update') {
    out.push(h('div', { class: 'alert warn' }, 'The gateway needs a one-time permission update for the admin console: deploy once with STALWART_RECOVERY_ADMIN set, then remove it and deploy again.'));
  }
  if (o.engine && o.engine.recoveryAdminSet) {
    out.push(h('div', { class: 'alert bad' }, 'STALWART_RECOVERY_ADMIN is still set on the server. Remove it and deploy again.'));
  }
  if (o.engine && !['ok', 'provisioned', 'needs_update'].includes(o.engine.adminAccess)) {
    out.push(h('div', { class: 'alert bad' }, 'Admin access to the mail engine is not working (' + o.engine.adminAccess + ').'));
  }
  const stat = (n, l, page) => { const s = h('a', { class: 'stat', href: '#/' + page, style: { textDecoration: 'none', color: 'inherit' } }, h('div', { class: 'n' }, String(n)), h('div', { class: 'l' }, l)); return s; };
  out.push(h('div', { class: 'stats' },
    me.role === 'platform' ? stat(o.customers, 'Customers', 'customers') : null,
    stat(o.domains, 'Domains', 'domains'), stat(o.mailboxes, 'Mailboxes', 'mailboxes'), stat(o.teams, 'Teams', 'teams'),
    stat(formatSize(o.usedBytes), 'Storage used', 'usage')));
  if (o.pendingDomains.length) {
    out.push(h('div', { class: 'card' }, h('h2', {}, 'Waiting for DNS verification'),
      h('div', { class: 'chips' }, ...o.pendingDomains.map(d => h('a', { class: 'chip', href: '#/domains/' + encodeURIComponent(d) }, d)))));
  }
  if (o.unassignedDomains && o.unassignedDomains.length) {
    out.push(h('div', { class: 'card' }, h('h2', {}, 'Domains not assigned to a customer'),
      h('p', { class: 'help' }, 'These were set up in the mail engine before the console. Assign them on the Domains page.'),
      h('div', { class: 'chips' }, ...o.unassignedDomains.map(d => h('span', { class: 'chip' }, d)))));
  }
  out.push(h('div', { class: 'card' }, h('h2', {}, 'Recent changes', h('span', { class: 'actions' }, h('a', { class: 'btn small', href: '#/audit' }, 'All activity'))),
    o.recent.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('tbody', {}, ...o.recent.map(r => h('tr', {},
      h('td', { class: 'secondary' }, fmtDateTime(r.at)), h('td', { class: 'audit-action' }, actionLabel(r.action)), h('td', {}, r.target || ''), h('td', { class: 'secondary hide-sm' }, r.actor))))))
      : h('div', { class: 'muted' }, 'No changes yet.')));
  return out;
};

/* Customers */
async function loadPlans() { return (await api('plans')).plans; }

pages.customers = async () => {
  const [{ customers }, plans] = await Promise.all([api('customers'), loadPlans()]);
  const planOptions = [{ value: '', label: 'No plan' }, ...plans.map(p => ({ value: p.id, label: p.name }))];
  const newBtn = me.role === 'platform' ? btn('New customer', async () => {
    const r = await formDialog({
      title: 'New customer', okLabel: 'Create',
      fields: [{ name: 'name', label: 'Organisation name' }, { name: 'contactEmail', label: 'Contact email (optional)', type: 'email' }, { name: 'planId', label: 'Plan', type: 'select', options: planOptions }],
      submit: v => api('customers', v)
    });
    if (r) { toast('Customer created'); refresh(); }
  }, 'primary') : null;
  const rows = customers.map(c => {
    const adminChips = h('div', { class: 'chips' }, ...c.admins.map(email => h('span', { class: 'chip' }, email,
      email !== me.email.toLowerCase() ? h('button', { type: 'button', title: 'Remove admin', 'aria-label': 'Remove admin ' + email, on: { click: async e => {
        e.stopPropagation();
        if (!(await dialog({ title: 'Remove admin', text: `${email} will no longer be able to manage ${c.name}.`, okLabel: 'Remove', danger: true }))) return;
        if (await run(() => api('admins/remove', { email, customerId: c.id }), 'Admin removed')) refresh();
      } } }, '×') : null)));
    const actions = () => {
      const items = [];
      if (!c.internal) items.push({ label: 'Add an admin', run: async () => {
        const r = await formDialog({ title: 'Add an admin for ' + c.name, okLabel: 'Add', intro: 'Admins sign in to the webmail with their own mailbox, then open the admin console.',
          fields: [{ name: 'email', label: 'Their mailbox address', type: 'email' }], submit: v => api('admins/add', { email: v.email, customerId: c.id }) });
        if (r) { toast('Admin added'); refresh(); }
      } });
      if (me.role === 'platform') {
        items.push({ label: 'Edit', run: async () => {
          const r = await formDialog({ title: 'Edit ' + c.name, fields: [
            { name: 'name', label: 'Organisation name', value: c.name },
            { name: 'contactEmail', label: 'Contact email', value: c.contactEmail || '' },
            { name: 'planId', label: 'Plan', type: 'select', options: planOptions, value: c.planId || '' },
            ...(c.internal ? [] : [{ name: 'status', label: 'Status', type: 'select', value: c.status, options: [{ value: 'active', label: 'Active' }, { value: 'suspended', label: 'Suspended (its admins cannot use the console)' }] }])
          ], submit: v => api('customers/update', { id: c.id, ...v }) });
          if (r) { toast('Saved'); refresh(); }
        } });
        if (!c.internal) items.push({ label: 'Delete', danger: true, run: async () => {
          if (!(await dialog({ title: 'Delete customer', text: `Delete ${c.name}? Its domains must be removed first.`, okLabel: 'Delete', danger: true }))) return;
          if (await run(() => api('customers/delete', { id: c.id }), 'Customer deleted')) refresh();
        } });
      }
      return items;
    };
    const u = c.usage;
    return h('tr', {},
      h('td', {}, h('div', { class: 'primary' }, c.name, ' ', c.internal ? badge('IRON ID', 'info') : null, c.status === 'suspended' ? badge('Suspended', 'bad') : null),
        h('div', { class: 'secondary' }, c.contactEmail || '')),
      h('td', { class: 'hide-sm' }, u.plan ? u.plan.name : h('span', { class: 'muted' }, 'No plan')),
      h('td', { class: 'num' }, String(u.domains)), h('td', { class: 'num' }, String(u.mailboxes) + (u.plan && u.plan.maxMailboxes ? ' / ' + u.plan.maxMailboxes : '')),
      h('td', { class: 'hide-sm' }, meter(u.usedBytes, u.allocatedBytes)),
      h('td', { class: 'hide-sm' }, adminChips.childNodes.length ? adminChips : h('span', { class: 'muted small' }, 'No admins')),
      h('td', { class: 'actions' }, moreButton(actions)));
  });
  return [head(me.role === 'platform' ? 'Customers' : 'Your organisation', null, newBtn),
    table(['Customer', { label: 'Plan', attrs: { class: 'hide-sm' } }, { label: 'Domains', attrs: { style: 'text-align:right' } }, { label: 'Mailboxes', attrs: { style: 'text-align:right' } }, { label: 'Storage', attrs: { class: 'hide-sm' } }, { label: 'Admins', attrs: { class: 'hide-sm' } }, ''], rows, 'No customers yet.')];
};

/* Domains */
const STATUS_BADGE = { pending: ['Waiting for DNS', 'warn'], active: ['Active', 'ok'], verified: ['Verified', 'ok'], suspended: ['Suspended', 'bad'], unassigned: ['Not assigned', ''] };

pages.domains = async arg => {
  if (arg) return domainDetail(arg);
  const [{ domains }, custs] = await Promise.all([api('domains'), me.role === 'platform' ? api('customers') : Promise.resolve({ customers: [] })]);
  const customerOptions = custs.customers.map(c => ({ value: c.id, label: c.name + (c.internal ? ' (IRON ID)' : '') }));
  const add = btn('Add domain', async () => {
    const fields = [{ name: 'domain', label: 'Domain name', placeholder: 'company.dz', help: 'The part after @ in the addresses, without www.' }];
    if (me.role === 'platform') fields.push({ name: 'customerId', label: 'Customer', type: 'select', options: customerOptions });
    const r = await formDialog({ title: 'Add a domain', okLabel: 'Add', fields, submit: v => api('domains', v) });
    if (r) { toast(r.status === 'active' ? 'Domain assigned' : 'Domain added. Now add the DNS records.'); go('domains', r.domain); }
  }, 'primary');
  const rows = domains.map(d => {
    const [label, kind] = STATUS_BADGE[d.status] || [d.status, ''];
    const tr = h('tr', { class: d.status === 'unassigned' ? '' : 'clickable' },
      h('td', {}, h('div', { class: 'primary' }, d.domain), d.customer ? h('div', { class: 'secondary' }, d.customer) : null),
      h('td', {}, badge(label, kind), ' ', d.platform ? badge('Platform', 'info') : null),
      h('td', { class: 'num' }, String(d.mailboxes || 0)), h('td', { class: 'num hide-sm' }, String(d.teams || 0)),
      h('td', { class: 'hide-sm secondary' }, d.verifiedAt ? 'Verified ' + fmtDate(d.verifiedAt) : d.createdAt ? 'Added ' + fmtDate(d.createdAt) : ''),
      h('td', { class: 'actions' }, d.status === 'unassigned' && me.role === 'platform'
        ? btn('Assign', async e => {
          e.stopPropagation();
          const r = await formDialog({ title: 'Assign ' + d.domain, okLabel: 'Assign', intro: 'This domain already works in the mail engine. Choose the customer it belongs to.',
            fields: [{ name: 'customerId', label: 'Customer', type: 'select', options: customerOptions }], submit: v => api('domains', { domain: d.domain, customerId: v.customerId }) });
          if (r) { toast('Domain assigned'); refresh(); }
        }, 'small') : h('span', { class: 'muted' }, '›')));
    if (d.status !== 'unassigned') tr.addEventListener('click', () => go('domains', d.domain));
    return tr;
  });
  return [head('Domains', 'Each domain needs a few DNS records at the company that hosts its DNS (registrar).', add),
    table(['Domain', 'Status', { label: 'Mailboxes', attrs: { style: 'text-align:right' } }, { label: 'Teams', attrs: { class: 'hide-sm', style: 'text-align:right' } }, { label: '', attrs: { class: 'hide-sm' } }, ''], rows, 'No domains yet. Add your company’s domain to start.')];
};

async function domainDetail(domain) {
  const d = await api('domains/dns?domain=' + encodeURIComponent(domain));
  const out = [];
  const [label, kind] = STATUS_BADGE[d.status] || [d.status, ''];
  const removeBtn = !d.platform ? btn('Remove domain', async () => {
    const v = await dialog({ title: 'Remove ' + d.domain, text: `Type ${d.domain} to confirm. Its mailboxes and teams must be deleted first.`, input: '', okLabel: 'Remove', danger: true });
    if (!v) return;
    if (await run(() => api('domains/remove', { domain: d.domain, confirm: v }), 'Domain removed')) go('domains');
  }, 'danger') : null;
  out.push(head(d.domain, null, h('a', { class: 'btn', href: '#/domains' }, '‹ All domains'), btn('Check again', refresh), removeBtn));
  out.push(h('div', { style: { marginTop: '-8px', marginBottom: '14px' } }, badge(label, kind), ' ', d.platform ? badge('Platform domain', 'info') : null));
  for (const w of d.warnings) out.push(h('div', { class: 'alert warn' }, w));

  if (d.status === 'pending') {
    const verify = btn('Verify now', async () => {
      const r = await run(() => api('domains/verify', { domain: d.domain }));
      if (r) { toast('Domain verified. You can add mailboxes now.'); refresh(); }
    }, 'primary');
    const skip = me.role === 'platform' ? btn('Verify without the DNS check', async () => {
      if (!(await dialog({ title: 'Skip the DNS check', text: 'Only do this when IRON ID manages this domain’s DNS or the owner is confirmed another way.', okLabel: 'Verify', danger: true }))) return;
      if (await run(() => api('domains/verify', { domain: d.domain, skipCheck: true }), 'Domain verified')) refresh();
    }) : null;
    out.push(h('div', { class: 'alert info' }, h('div', {}, h('b', {}, 'Step 1: prove that you own the domain. '),
      'Add the first TXT record below at your DNS provider, then press Verify. The other records can be added now too; mail starts arriving once the MX record points to IRON ID.')));
    out.push(h('div', { class: 'toolbar' }, verify, skip));
  }

  const recs = d.records.map(r => h('tr', {},
    h('td', {}, h('span', { class: 'status-dot ' + (r.ok ? 'ok' : r.required ? 'bad' : 'warn') }), r.ok ? 'Found' : r.problem ? 'Problem' : 'Missing'),
    h('td', {}, h('div', { class: 'primary' }, r.type), h('div', { class: 'secondary' }, r.purpose), r.problem ? h('div', { class: 'secondary', style: { color: 'var(--color-danger)' } }, r.problem) : null),
    h('td', {}, h('div', { class: 'dns-value' }, h('code', {}, r.host), copyBtn(r.host))),
    h('td', {}, h('div', { class: 'dns-value' }, h('code', {}, r.value), copyBtn(r.type === 'MX' ? r.value.replace(/^\d+\s+/, '') : r.value)), r.type === 'MX' ? h('div', { class: 'secondary' }, 'Priority 10') : null)));
  out.push(h('div', { class: 'card' }, h('h2', {}, 'DNS records'),
    h('p', { class: 'help' }, 'Host "@" means the domain itself. Some providers want the full name instead (for example ' + (d.records[0] ? d.records[0].name : d.domain) + '). Long DKIM values may need to be pasted as one line; changes can take up to a few hours to show.'),
    table(['Status', 'Record', 'Host / name', 'Value'], recs, d.platform ? 'Nothing to publish until new signing keys are created (below).' : 'No records to show.')));

  if (d.status !== 'pending') {
    const keys = d.keys.map(k => h('tr', {},
      h('td', {}, h('code', {}, k.selector), k.exposed ? h('div', {}, badge('Exposed — replace', 'bad')) : null),
      h('td', {}, k.algorithm), h('td', {}, badge({ active: 'Signing', pending: 'New — not used yet', retiring: 'Old', retired: 'Old' }[k.stage] || k.stage, k.stage === 'active' ? 'ok' : k.stage === 'pending' ? 'info' : '')),
      h('td', { class: 'secondary hide-sm' }, fmtDate(k.createdAt))));
    const hasPending = d.keys.some(k => k.stage === 'pending');
    const hasOld = d.keys.some(k => k.stage === 'retiring' || k.stage === 'retired');
    const canKeys = !d.platform || me.role === 'platform';
    out.push(h('div', { class: 'card' }, h('h2', {}, 'Signing keys (DKIM)', canKeys ? h('span', { class: 'actions' },
      btn(hasPending ? 'Make other new keys' : 'Create new keys', async () => {
        if (await run(() => api('domains/dkim/prepare', { domain: d.domain }), 'New keys created. Add their DNS records, then switch.')) refresh();
      }, 'small'),
      hasPending ? btn('Switch to the new keys', async () => {
        if (await run(() => api('domains/dkim/activate', { domain: d.domain }), 'Now signing with the new keys')) refresh();
      }, 'small primary') : null,
      hasOld ? btn('Remove old keys', async () => {
        if (!(await dialog({ title: 'Remove old keys', text: 'Remove the old keys? Afterwards you can delete their DNS records.', okLabel: 'Remove', danger: true }))) return;
        if (await run(() => api('domains/dkim/remove-old', { domain: d.domain }), 'Old keys removed')) refresh();
      }, 'small danger') : null) : null),
      h('p', { class: 'help' }, 'To change keys: create new keys, add their DNS records, wait until they show as Found, then switch. Mail stays signed the whole time.'),
      table(['Selector', 'Type', 'State', { label: 'Created', attrs: { class: 'hide-sm' } }], keys, 'No keys yet.')));

    out.push(h('div', { class: 'card' }, h('h2', {}, 'Catch-all address'),
      h('p', { class: 'help' }, 'Mail sent to an address that does not exist on ' + d.domain + ' can go to one mailbox or team instead of bouncing.'),
      h('div', { class: 'toolbar' }, h('span', {}, d.catchAll ? h('b', {}, d.catchAll) : h('span', { class: 'muted' }, 'Off — unknown addresses bounce')),
        btn(d.catchAll ? 'Change' : 'Set up', async () => {
          const v = await dialog({ title: 'Catch-all address', text: 'Mailbox or team address on ' + d.domain + ' (leave empty to turn off).', input: d.catchAll || '', okLabel: 'Save' });
          if (v === null) return;
          if (await run(() => api('domains/settings', { domain: d.domain, catchAll: v }), 'Saved')) refresh();
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
  const domainSel = h('select', { class: 'fl-input', 'aria-label': 'Domain' }, h('option', { value: '' }, 'All domains'), ...domains.map(d => h('option', { value: d }, d)));
  const search = h('input', { class: 'fl-input', type: 'search', placeholder: 'Search address or name', 'aria-label': 'Search mailboxes' });
  const draw = () => {
    const q = filter.q.toLowerCase();
    const list = mailboxes.filter(m => (!filter.domain || m.domain === filter.domain) && (!q || m.email.includes(q) || (m.name || '').toLowerCase().includes(q)));
    listBox.replaceChildren(table(['Mailbox', { label: 'Storage', attrs: { class: 'hide-sm' } }, 'Status', ''], list.map(m => mailboxRow(m, admins.admins)), mailboxes.length ? 'No mailbox matches.' : 'No mailboxes yet.'));
  };
  domainSel.addEventListener('change', () => { filter.domain = domainSel.value; draw(); });
  search.addEventListener('input', () => { filter.q = search.value.trim(); draw(); });
  draw();
  const add = btn('New mailbox', async () => {
    if (!domains.length) { toast('Add and verify a domain first', false); return; }
    const r = await formDialog({ title: 'New mailbox', okLabel: 'Create', fields: [
      { name: 'email', label: 'Address', type: 'address', domains, placeholder: 'firstname' },
      { name: 'name', label: 'Person’s name', placeholder: 'Firstname Lastname' },
      { name: 'quotaMb', label: 'Storage limit in MB (optional)', type: 'number', min: 50, help: 'Leave empty to use the plan’s limit.' }
    ], submit: v => api('mailboxes', { email: v.email, name: v.name, quotaMb: v.quotaMb || null }) });
    if (r) { await showSecret('Mailbox created', `${r.email} is ready. Its temporary password:`, r.password); refresh(); }
  }, 'primary');
  return [head('Mailboxes', null, add), h('div', { class: 'toolbar' }, search, domainSel), listBox];
};

function mailboxRow(m, admins) {
  const isMe = m.email === me.email.toLowerCase();
  const status = h('div', { class: 'chips' },
    m.suspended ? badge('Suspended', 'bad') : badge('Active', 'ok'),
    m.twoStep ? badge('Two-step', 'info') : null, m.admin ? badge('Admin', 'warn') : null, m.protected ? badge(m.protected, '') : null);
  const items = () => {
    if (m.protected) return [{ title: 'Managed by IRON ID staff in the engine' }];
    const out = [{ label: 'Edit name, storage, aliases', run: () => editMailbox(m) }];
    if (!isMe) {
      out.push({ label: 'Reset sign-in…', run: async () => {
        if (!(await dialog({ title: 'Reset sign-in for ' + m.email, text: 'This sets a new temporary password, turns off two-step sign-in, removes all app passwords (mail apps must sign in again) and signs out every browser.', okLabel: 'Reset', danger: true }))) return;
        const r = await run(() => api('mailboxes/reset-signin', { id: m.id }));
        if (r) { await showSecret('New temporary password', `${r.email} can now sign in with:`, r.password); refresh(); }
      } });
      out.push(m.suspended
        ? { label: 'Restore', run: async () => { if (await run(() => api('mailboxes/suspend', { id: m.id, suspended: false }), 'Mailbox restored')) refresh(); } }
        : { label: 'Suspend', run: async () => {
          if (!(await dialog({ title: 'Suspend ' + m.email, text: 'The person is signed out and cannot sign in until you restore the mailbox. Mail keeps arriving.', okLabel: 'Suspend', danger: true }))) return;
          if (await run(() => api('mailboxes/suspend', { id: m.id, suspended: true }), 'Mailbox suspended')) refresh();
        } });
    }
    const customerId = me.role === 'customer' && me.customers[0] ? me.customers[0].id : null;
    if (customerId && !m.admin) out.push({ label: 'Make admin', run: async () => { if (await run(() => api('admins/add', { email: m.email, customerId }), 'Admin added')) refresh(); } });
    if (customerId && m.admin && !isMe) out.push({ label: 'Remove admin', run: async () => { if (await run(() => api('admins/remove', { email: m.email, customerId }), 'Admin removed')) refresh(); } });
    if (!isMe) out.push({ label: 'Delete…', danger: true, run: async () => {
      const v = await dialog({ title: 'Delete ' + m.email, text: `This deletes the mailbox and all its mail for good. Type ${m.email} to confirm.`, input: '', okLabel: 'Delete', danger: true });
      if (!v) return;
      if (await run(() => api('mailboxes/delete', { id: m.id, confirm: v }), 'Mailbox deleted')) refresh();
    } });
    return out;
  };
  return h('tr', {},
    h('td', {}, h('div', { class: 'primary' }, m.email), h('div', { class: 'secondary' }, [m.name, m.aliases.length ? 'also ' + m.aliases.join(', ') : '', m.teams.length ? 'teams: ' + m.teams.join(', ') : ''].filter(Boolean).join(' · '))),
    h('td', { class: 'hide-sm' }, meter(m.usedBytes, m.quotaMb ? m.quotaMb * 1024 * 1024 : 0)),
    h('td', {}, status),
    h('td', { class: 'actions' }, moreButton(items)));
}

async function editMailbox(m) {
  const r = await formDialog({ title: 'Edit ' + m.email, fields: [
    { name: 'name', label: 'Person’s name', value: m.name },
    { name: 'quotaMb', label: 'Storage limit in MB', type: 'number', min: 50, value: m.quotaMb || '', help: 'Empty = no limit (or the plan’s limit).' },
    { name: 'aliases', label: 'Other addresses (aliases), one per line', type: 'textarea', value: m.aliases.join('\n'), placeholder: 'contact@' + m.domain, help: 'Mail to these addresses arrives in this mailbox.' }
  ], submit: v => api('mailboxes/update', { id: m.id, name: v.name, quotaMb: v.quotaMb === '' ? null : v.quotaMb, aliases: v.aliases.split(/[\s,;]+/).filter(Boolean) }) });
  if (r) { toast('Saved'); refresh(); }
}

/* Teams */
pages.teams = async () => {
  const [{ teams }, { mailboxes }, domains] = await Promise.all([api('teams'), api('mailboxes'), activeDomains()]);
  const choices = mailboxes.filter(m => !m.protected).map(m => ({ value: m.email, label: m.name ? `${m.name} <${m.email}>` : m.email }));
  const add = btn('New team', async () => {
    if (!domains.length) { toast('Add and verify a domain first', false); return; }
    const r = await formDialog({ title: 'New team mailbox', okLabel: 'Create', intro: 'A shared address such as contact@ or support@. Its members see it in their webmail, can assign messages to each other and reply as the team.', fields: [
      { name: 'email', label: 'Address', type: 'address', domains, placeholder: 'support' },
      { name: 'name', label: 'Team name', placeholder: 'Customer support' },
      { name: 'members', label: 'Members', type: 'checks', choices }
    ], submit: v => api('teams', v) });
    if (r) { toast('Team created'); refresh(); }
  }, 'primary');
  const rows = teams.map(t => h('tr', {},
    h('td', {}, h('div', { class: 'primary' }, t.email), h('div', { class: 'secondary' }, [t.name, t.aliases.length ? 'also ' + t.aliases.join(', ') : ''].filter(Boolean).join(' · '))),
    h('td', {}, t.members.length ? h('div', { class: 'chips' }, ...t.members.map(x => h('span', { class: 'chip' }, x))) : h('span', { class: 'muted small' }, 'No members')),
    h('td', { class: 'hide-sm' }, meter(t.usedBytes, 0)),
    h('td', { class: 'actions' }, moreButton(() => [
      { label: 'Edit name, members, aliases', run: async () => {
        const r = await formDialog({ title: 'Edit ' + t.email, fields: [
          { name: 'name', label: 'Team name', value: t.name },
          { name: 'members', label: 'Members', type: 'checks', choices, value: t.members },
          { name: 'aliases', label: 'Other addresses (aliases), one per line', type: 'textarea', value: t.aliases.join('\n') }
        ], submit: v => api('teams/update', { id: t.id, name: v.name, members: v.members, aliases: v.aliases.split(/[\s,;]+/).filter(Boolean) }) });
        if (r) { toast('Saved'); refresh(); }
      } },
      { label: 'Delete…', danger: true, run: async () => {
        const v = await dialog({ title: 'Delete ' + t.email, text: `This deletes the team mailbox and all its mail. Type ${t.email} to confirm.`, input: '', okLabel: 'Delete', danger: true });
        if (!v) return;
        if (await run(() => api('teams/delete', { id: t.id, confirm: v }), 'Team deleted')) refresh();
      } }
    ]))));
  return [head('Teams', 'Shared mailboxes: one address, several people.', add),
    table(['Team', 'Members', { label: 'Storage', attrs: { class: 'hide-sm' } }, ''], rows, 'No teams yet.')];
};

/* Activity log */
pages.audit = async () => {
  const state = { kind: '', q: '', entries: [], done: false };
  const listBox = h('div');
  const kindSel = h('select', { class: 'fl-input', 'aria-label': 'Show' }, h('option', { value: '' }, 'Everything'), h('option', { value: 'changes' }, 'Changes'), h('option', { value: 'signin' }, 'Sign-ins'));
  const search = h('input', { class: 'fl-input', type: 'search', placeholder: 'Search address or action', 'aria-label': 'Search activity' });
  const more = btn('Load more', () => load(true));
  const load = async (append = false) => {
    const before = append && state.entries.length ? state.entries[state.entries.length - 1].id : '';
    const r = await run(() => api(`audit?limit=50&kind=${state.kind}&q=${encodeURIComponent(state.q)}${before ? '&before=' + before : ''}`));
    if (!r) return;
    state.entries = append ? state.entries.concat(r.entries) : r.entries;
    state.done = r.entries.length < 50;
    listBox.replaceChildren(table(['When', 'What', 'Who / what', { label: 'From', attrs: { class: 'hide-sm' } }], state.entries.map(e => h('tr', {},
      h('td', { class: 'secondary' }, fmtDateTime(e.at)),
      h('td', {}, h('span', { class: 'audit-action', style: e.action === 'signin.failed' ? { color: 'var(--color-danger)' } : null }, actionLabel(e.action)),
        e.details && e.details.reason ? h('div', { class: 'secondary' }, e.action === 'signin.failed' ? (e.details.reason === 'code' ? 'wrong code' : 'wrong password') : e.details.reason) : null),
      h('td', {}, h('div', {}, e.target || ''), e.actor && e.actor !== e.target ? h('div', { class: 'secondary' }, 'by ' + e.actor) : null),
      h('td', { class: 'secondary hide-sm' }, e.ip || ''))), 'No activity.'), state.done ? null : h('div', { class: 'list-more' }, more));
  };
  kindSel.addEventListener('change', () => { state.kind = kindSel.value; load(); });
  let t = null;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { state.q = search.value.trim(); load(); }, 300); });
  await load();
  return [head('Activity log', 'Sign-ins and every change made in the console, newest first.'), h('div', { class: 'toolbar' }, search, kindSel), listBox];
};

/* Usage & billing */
pages.usage = async () => {
  const { usage } = await api('usage');
  const rows = usage.map(u => h('tr', {},
    h('td', {}, h('div', { class: 'primary' }, u.customer, ' ', u.internal ? badge('IRON ID', 'info') : null), h('div', { class: 'secondary' }, u.plan ? u.plan.name : 'No plan')),
    h('td', { class: 'num' }, String(u.billableMailboxes) + (u.plan && u.plan.maxMailboxes ? ' / ' + u.plan.maxMailboxes : '')),
    h('td', { class: 'num hide-sm' }, String(u.teams)),
    h('td', {}, meter(u.usedBytes, u.allocatedBytes)),
    h('td', { class: 'num' }, u.internal ? h('span', { class: 'muted' }, 'Not billed') : u.monthlyEstimate == null ? h('span', { class: 'muted' }, 'No price set') : fmtMoney(u.monthlyEstimate, u.plan.currency))));
  return [head('Usage & billing', 'Estimated monthly amount = mailboxes × the plan’s price per mailbox. Teams are included. Payments are not collected here yet.'),
    table(['Customer', { label: 'Mailboxes', attrs: { style: 'text-align:right' } }, { label: 'Teams', attrs: { class: 'hide-sm', style: 'text-align:right' } }, 'Storage', { label: 'Per month', attrs: { style: 'text-align:right' } }], rows, 'No customers yet.')];
};

/* Plans (platform) */
pages.plans = async () => {
  const plans = await loadPlans();
  const edit = p => formDialog({ title: p ? 'Edit ' + p.name : 'New plan', okLabel: p ? 'Save' : 'Create', fields: [
    { name: 'name', label: 'Plan name', value: p ? p.name : '' },
    { name: 'maxMailboxes', label: 'Mailboxes included', type: 'number', min: 1, value: p ? p.maxMailboxes ?? '' : '', help: 'Empty = no limit.' },
    { name: 'mailboxQuotaMb', label: 'Storage per mailbox (MB)', type: 'number', min: 50, value: p ? p.mailboxQuotaMb ?? '' : '', help: '10240 MB = 10 GB. Empty = no limit.' },
    { name: 'pricePerMailbox', label: 'Price per mailbox per month', type: 'number', min: 0, step: '0.01', value: p ? p.pricePerMailbox ?? '' : '' },
    { name: 'currency', label: 'Currency', value: p ? p.currency : 'DZD', mono: true }
  ], submit: v => api('plans', { id: p ? p.id : undefined, ...v }) });
  const rows = plans.map(p => h('tr', {},
    h('td', {}, h('div', { class: 'primary' }, p.name), h('div', { class: 'secondary' }, p.customers + (p.customers === 1 ? ' customer' : ' customers'))),
    h('td', { class: 'num' }, p.maxMailboxes == null ? 'No limit' : String(p.maxMailboxes)),
    h('td', { class: 'num' }, p.mailboxQuotaMb == null ? 'No limit' : formatSize(p.mailboxQuotaMb * 1024 * 1024)),
    h('td', { class: 'num' }, fmtMoney(p.pricePerMailbox, p.currency)),
    h('td', { class: 'actions' }, moreButton(() => [
      { label: 'Edit', run: async () => { if (await edit(p)) { toast('Saved'); refresh(); } } },
      { label: 'Delete', danger: true, run: async () => {
        if (!(await dialog({ title: 'Delete ' + p.name, text: 'Delete this plan? Customers must be moved to another plan first.', okLabel: 'Delete', danger: true }))) return;
        if (await run(() => api('plans/delete', { id: p.id }), 'Plan deleted')) refresh();
      } }
    ]))));
  return [head('Plans', 'What each customer gets and pays. The mailbox limit and storage are enforced when admins add mailboxes.', btn('New plan', async () => { if (await edit(null)) { toast('Plan created'); refresh(); } }, 'primary')),
    table(['Plan', { label: 'Mailboxes', attrs: { style: 'text-align:right' } }, { label: 'Storage each', attrs: { style: 'text-align:right' } }, { label: 'Price / mailbox', attrs: { style: 'text-align:right' } }, ''], rows, 'No plans yet.')];
};

/* Platform settings */
pages.settings = async () => {
  const [ret, { admins }] = await Promise.all([api('retention').catch(e => ({ error: e.message })), api('admins')]);
  const days = h('input', { class: 'fl-input', type: 'number', min: 1, max: 3650, value: ret.trashDays ?? '', style: { width: '120px' }, 'aria-label': 'Days' });
  const retention = h('div', { class: 'card' }, h('h2', {}, 'Trash and Junk'),
    h('p', { class: 'help' }, 'Messages in Trash and Junk are deleted for good after this many days, for every mailbox.'),
    ret.error ? h('div', { class: 'alert warn' }, ret.error) : h('div', { class: 'toolbar' }, days, h('span', {}, 'days'), btn('Save', async () => {
      if (await run(() => api('retention', { trashDays: days.value }), 'Saved')) refresh();
    }, 'primary')));
  const platform = admins.filter(a => a.role === 'platform');
  const staff = h('div', { class: 'card' }, h('h2', {}, 'IRON ID staff (platform admins)', h('span', { class: 'actions' }, btn('Add', async () => {
    const r = await formDialog({ title: 'Add a platform admin', okLabel: 'Add', intro: 'Platform admins can manage every customer. Use IRON ID staff mailboxes only.', fields: [{ name: 'email', label: 'Mailbox address', type: 'email' }], submit: v => api('admins/add', { email: v.email, role: 'platform' }) });
    if (r) { toast('Admin added'); refresh(); }
  }, 'small'))),
    h('p', { class: 'help' }, 'Addresses listed in the PLATFORM_ADMINS setting are added back on every start.'),
    h('div', { class: 'chips' }, ...platform.map(a => h('span', { class: 'chip' }, a.email, a.email !== me.email.toLowerCase() ? h('button', { type: 'button', title: 'Remove', 'aria-label': 'Remove ' + a.email, on: { click: async () => {
      if (!(await dialog({ title: 'Remove platform admin', text: `Remove ${a.email}?`, okLabel: 'Remove', danger: true }))) return;
      if (await run(() => api('admins/remove', { email: a.email, role: 'platform' }), 'Removed')) refresh();
    } } }, '×') : null))));
  return [head('Platform settings'), retention, staff];
};

/* ——— Start ——— */
function signedOut(message) {
  me = null;
  $('#adminNav').replaceChildren();
  $('#page').replaceChildren(h('div', { class: 'signed-out' }, h('div', { class: 'card' },
    h('h1', {}, 'IRON ID Admin'),
    h('p', {}, message || 'Sign in to the webmail with your admin mailbox, then come back here.'),
    h('a', { class: 'btn primary', href: '/' }, 'Go to sign in'))));
}

async function start() {
  try { me = await api('me'); }
  catch (e) {
    if (e.status === 401) return signedOut();
    if (e.status === 403) return signedOut('This mailbox is not an administrator. Ask your organisation’s admin or IRON ID.');
    return signedOut(e.message);
  }
  $('#hdrUserEmail').textContent = me.email;
  $('#hdrRole').textContent = me.role === 'platform' ? 'IRON ID staff' : 'Admin · ' + (me.customers[0] ? me.customers[0].name : '');
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
