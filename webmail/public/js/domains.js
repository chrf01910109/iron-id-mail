// "Your domains": addresses on the person's own domain (contact@company.fr) in their name@<platform> mailbox.
// Connect a domain they own (one payment: DNS set-up and a copy of their old emails) or buy one (paid every year),
// then add addresses on it. The page replaces the message list and the reader while it is open.
// Server text (domain names, DNS values, errors) is only ever inserted with textContent via h().

import * as api from './api.js';
import * as mail from './mail.js';
import { h, $, icon, toast, dialog, formatSize } from './util.js';
import { t, tn, locale } from './i18n.js';

const GLOBE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
const globe = () => h('span', { class: 'ic', style: { display: 'inline-flex' }, html: GLOBE });

// Countries whose residents may own .fr and .eu domains (the same list as the gateway's).
const EU = 'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO'.split(' ');
const OTHER = 'AD AE AR AU BR CA CH CI CM CN DZ EG GB HK IL IN JP KR LB MA MC MG MU MX NZ QA SA SG SN TN TR UA US ZA'.split(' ');

// Where a domain's DNS is hosted, guessed from its name servers.
const DNS_HOSTS = [
  [/(^|\.)ovh\.(net|com|ca)$|(^|\.)anycast\.me$/, 'OVHcloud'], [/(^|\.)cloudflare\.com$/, 'Cloudflare'], [/(^|\.)gandi\.net$/, 'Gandi'],
  [/(^|\.)(ui-dns|ionos)\./, 'IONOS'], [/(^|\.)domaincontrol\.com$/, 'GoDaddy'], [/awsdns/, 'Amazon Route 53'], [/azure-dns/, 'Microsoft Azure'],
  [/(^|\.)(googledomains|google)\.com$/, 'Google'], [/squarespace/, 'Squarespace'], [/(^|\.)registrar-servers\.com$/, 'Namecheap'],
  [/hostinger|(^|\.)dns-parking\.com$/, 'Hostinger'], [/(^|\.)o2switch\.net$/, 'o2switch'], [/(^|\.)lws(-hosting)?\.(com|fr|net)$/, 'LWS'],
  [/(^|\.)online\.net$|scaleway/, 'Scaleway'], [/(^|\.)(orange|wanadoo)\.(fr|com)$/, 'Orange'], [/(^|\.)wixdns\.net$/, 'Wix'],
  [/(^|\.)infomaniak\.(ch|com)$/, 'Infomaniak'], [/(^|\.)hetzner\.(com|de)$/, 'Hetzner'], [/(^|\.)nsone\.net$/, 'NS1'], [/(^|\.)digitalocean\.com$/, 'DigitalOcean']
];

// Old providers for the copy of old emails: server name, and whether they need an app password.
const PROVIDERS = [
  { name: 'Gmail', host: 'imap.gmail.com', appPassword: true },
  { name: 'Outlook / Hotmail', host: 'outlook.office365.com', appPassword: true },
  { name: 'Yahoo', host: 'imap.mail.yahoo.com', appPassword: true },
  { name: 'iCloud', host: 'imap.mail.me.com', appPassword: true },
  { name: 'Orange', host: 'imap.orange.fr' },
  { name: 'SFR', host: 'imap.sfr.fr' },
  { name: 'Free', host: 'imap.free.fr' },
  { name: 'OVHcloud', host: 'ssl0.ovh.net' },
  { name: 'IONOS', host: 'imap.ionos.fr' }
];

let platformDomain = null;
let resolvePlatform;
const platformReady = new Promise(r => { resolvePlatform = r; });
let eligible = false;
let notices = [];
let data = null;            // GET /account/domains
let quotaLimit = null;      // bytes, for "share its 5 GB"
let openNow = false;
let view = { name: 'home' };
let gen = 0;                // bumps on every render; pollers of an older render stop
let timer = null;
let flash = null;           // { text, kind } shown once at the top of the next page
let onShowMail = () => {};

/* ——— Small helpers ——— */
function money(cents, { short = false } = {}) {
  const currency = (data && data.prices && data.prices.currency) || 'EUR';
  const whole = short && cents % 100 === 0;
  return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(cents / 100);
}
const longDay = iso => (iso ? new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' }) : '');
const shortDay = iso => (iso ? new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const badge = (label, kind = '') => h('span', { class: 'badge' + (kind ? ' ' + kind : '') }, label);
const price = kind => (data && data.prices && data.prices.prices && data.prices.prices[kind]) || { ttc: 0, ht: 0, vat: 0, rate: 0 };
const errText = e => (e && e.message) || t('Something went wrong. Please try again.');
const isSessionEnd = e => e instanceof api.SessionEndedError;

function statusOf(d) {
  return {
    awaiting_payment: [t('Waiting for payment'), 'warn'],
    setting_up: [t('Being set up'), 'info'],
    problem: [t('Problem'), 'bad'],
    pending: [t('Waiting for DNS records'), 'warn'],
    active: [t('Active'), 'ok']
  }[d.status] || [d.status, ''];
}

function orderStatus(o) {
  return {
    pending: [t('Waiting for payment'), 'warn'],
    paid: [t('Paid'), 'info'],
    fulfilled: [t('Paid'), 'ok'],
    failed: [t('Problem'), 'bad'],
    cancelled: [t('Cancelled'), ''],
    refunded: [t('Refunded'), '']
  }[o.status] || [o.status, ''];
}

function orderWhat(o) {
  if (o.kind === 'domain_connect') return t('Connect {domain}', { domain: o.domain });
  if (o.kind === 'domain_register') return t('Buy {domain} (1 year)', { domain: o.domain });
  if (o.kind === 'domain_renew') return t('Renew {domain} (1 year)', { domain: o.domain });
  return o.domain || o.kind;
}

function dnsHost(nameservers) {
  for (const ns of nameservers || []) for (const [re, name] of DNS_HOSTS) if (re.test(ns)) return name;
  return null;
}

function countryOptions(selected) {
  let names = null;
  try { names = new Intl.DisplayNames([locale], { type: 'region' }); } catch (e) { /* old browser: codes */ }
  const label = c => (names && names.of(c)) || c;
  const opts = list => list.map(c => ({ c, n: label(c) })).sort((a, b) => a.n.localeCompare(b.n, locale))
    .map(({ c, n }) => h('option', { value: c, selected: c === selected }, n));
  return [h('optgroup', { label: t('European Economic Area') }, ...opts(EU)), h('optgroup', { label: t('Other countries') }, ...opts(OTHER))];
}

/** "I accept the {link}." with a real link in place of {link}. */
function withLink(text, link) {
  const i = text.indexOf('{link}');
  if (i < 0) return [text, ' ', link];
  return [text.slice(0, i), link, text.slice(i + 6)];
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast(t('Copied')); }
  catch (e) {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); toast(t('Copied')); } catch (e2) { toast(t('Could not copy. Select the text and copy it.'), false); }
    ta.remove();
  }
}

function setBusy(btn, busy, label) {
  if (!btn) return;
  btn.disabled = busy;
  if (label !== undefined) btn.textContent = label;
}

/* ——— Loading ——— */
async function load() {
  data = await api.account('domains');
  // A renewal paid elsewhere removes its notice.
  notices = notices.filter(n => { const d = data.domains.find(x => x.domain === n.domain); return d && d.renewable; });
  renderNotice();
  renderSidebar();
  return data;
}

async function loadQuota() {
  if (quotaLimit !== null) return;
  const q = await mail.loadQuota().catch(() => null);
  quotaLimit = q ? (q.hardLimit || q.warnLimit || 0) : 0;
}

/* ——— Sidebar and notices ——— */
function renderSidebar() {
  const sec = $('#domainSection');
  if (!sec) return;
  sec.classList.toggle('hidden', !eligible);
  if (!eligible) return;
  const list = data ? data.domains : [];
  const rows = list.map(d => {
    const active = openNow && view.name === 'detail' && view.domain === d.domain;
    const [label, kind] = statusOf(d);
    const btn = h('button', { type: 'button', class: 'sb-btn' + (active ? ' active' : ''), 'aria-current': active ? 'page' : null, title: d.domain },
      globe(), h('span', { class: 'sb-name' }, d.domain),
      h('span', { class: 'status-dot ' + (kind === 'ok' ? 'ok' : kind === 'bad' ? 'bad' : 'warn'), role: 'img', 'aria-label': label, title: label }));
    btn.addEventListener('click', () => open({ name: 'detail', domain: d.domain }));
    return h('div', { class: 'folder-row dom-row' }, btn);
  });
  if (!rows.length) {
    const active = openNow && view.name !== 'detail';
    const btn = h('button', { type: 'button', class: 'sb-btn dom-add' + (active ? ' active' : ''), 'aria-current': active ? 'page' : null },
      icon('plus', 18, 1.5), h('span', { class: 'sb-name' }, t('Connect or buy a domain')));
    btn.addEventListener('click', () => open({ name: 'home' }));
    rows.push(h('div', { class: 'folder-row dom-row' }, btn));
  }
  $('#domainList').replaceChildren(...rows);
}

function renderNotice() {
  const box = $('#domainNotice');
  if (!box) return;
  const list = eligible ? notices : [];
  box.replaceChildren(...list.map(n => h('div', { class: 'notice' + (n.expired ? ' danger' : ''), role: 'status' },
    h('span', {}, n.expired
      ? t('Your domain {domain} ended on {date}. Renew it soon to keep its addresses.', { domain: n.domain, date: longDay(n.expiresAt) })
      : t('Your domain {domain} ends on {date}. Renew it to keep its addresses.', { domain: n.domain, date: longDay(n.expiresAt) })),
    h('button', { type: 'button', class: 'lh-link', on: { click: () => open({ name: 'detail', domain: n.domain }) } }, t('Renew')))));
  box.classList.toggle('hidden', !list.length);
}

/* ——— Page frame ——— */
function head(title, sub, ...actions) {
  return h('div', { class: 'page-head' }, h('h1', { tabindex: '-1' }, title),
    actions.filter(Boolean).length ? h('div', { class: 'actions' }, ...actions.filter(Boolean)) : null,
    sub ? h('div', { class: 'sub' }, sub) : null);
}
const backBtn = () => h('button', { type: 'button', class: 'act-btn', on: { click: () => go({ name: 'home' }) } }, t('‹ Your domains'));
const card = (title, ...children) => h('section', { class: 'card' }, title ? h('h2', {}, title) : null, ...children);
const help = text => h('p', { class: 'help' }, text);
const note = (text, kind = 'info') => h('div', { class: 'notice' + (kind ? ' ' + kind : ''), role: 'status' }, text);

function takeFlash() {
  const f = flash; flash = null;
  return f ? note(f.text, f.kind) : null;
}

function hashFor(v) {
  return '#domains' + (v.name === 'detail' ? '/' + encodeURIComponent(v.domain) : v.name === 'connect' || v.name === 'buy' ? '/' + v.name : '');
}
function viewFromHash() {
  const m = /^#domains(?:\/(.*))?$/.exec(location.hash);
  if (!m) return null;
  const rest = m[1] ? decodeURIComponent(m[1]) : '';
  if (!rest) return { name: 'home' };
  if (rest === 'connect' || rest === 'buy') return { name: rest };
  return { name: 'detail', domain: rest };
}
function cleanUrl(v = view) {
  history.replaceState(history.state, '', location.pathname + (openNow ? hashFor(v) : ''));
}

function stopTimer() { clearTimeout(timer); timer = null; }
function later(fn, ms) {
  const g = gen;
  stopTimer();
  timer = setTimeout(() => { if (g === gen && openNow) fn(); }, ms);
}

async function render({ top = true } = {}) {
  stopTimer();
  const g = ++gen;
  const v = view;
  const page = $('#domainsPage');
  if (top) page.replaceChildren(h('div', { class: 'dom-wrap' }, h('div', { class: 'loading-text' }, t('Loading…'))));
  let nodes;
  try {
    nodes = await (VIEWS[v.name] || homeView)(v);
  } catch (e) {
    if (isSessionEnd(e)) return;
    nodes = [head(t('Your domains')), note(errText(e), 'danger'), h('div', {}, h('button', { type: 'button', class: 'act-btn', on: { click: () => render() } }, t('Try again')))];
  }
  if (g !== gen || !openNow) return;
  page.replaceChildren(h('div', { class: 'dom-wrap' }, ...nodes.filter(Boolean)));
  if (top) {
    page.scrollTop = 0;
    const h1 = page.querySelector('h1');
    if (h1) h1.focus({ preventScroll: true });
  }
}

function go(v) {
  view = v;
  if (openNow) cleanUrl(v);
  renderSidebar();
  render();
}

/* ——— Start ——— */
async function homeView() {
  await Promise.all([load(), loadQuota()]);
  const p = data.prices;
  const out = [head(t('Your domains'), quotaLimit
    ? t('Addresses on your own domain (for example contact@company.fr) arrive in this mailbox and share its {size} of storage.', { size: formatSize(quotaLimit) })
    : t('Addresses on your own domain (for example contact@company.fr) arrive in this mailbox and share its storage.'))];
  out.push(takeFlash());
  if (p.provider === 'off') out.push(note(t('Payments are not available yet. Please try again later.'), 'danger'));

  if (data.domains.length) {
    const rows = data.domains.map(d => {
      const [label, kind] = statusOf(d);
      const tr = h('tr', { class: 'clickable' },
        h('td', {}, h('button', { type: 'button', class: 'dom-link primary', on: { click: () => go({ name: 'detail', domain: d.domain }) } }, d.domain),
          d.bought && d.expiresAt ? h('div', { class: 'secondary' }, t('Paid until {date}', { date: shortDay(d.expiresAt) })) : null),
        h('td', {}, badge(label, kind)),
        h('td', { class: 'num hide-sm' }, d.status === 'active' ? tn('{n} address', '{n} addresses', d.addresses.length) : ''),
        h('td', { class: 'actions', 'aria-hidden': 'true' }, h('span', { class: 'muted' }, '›')));
      tr.addEventListener('click', e => { if (!e.target.closest('button')) go({ name: 'detail', domain: d.domain }); });
      return tr;
    });
    out.push(h('div', { class: 'tbl-wrap dom-block' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, h('th', {}, t('Domain')), h('th', {}, t('Status')), h('th', { class: 'hide-sm', style: { textAlign: 'right' } }, t('Addresses')), h('th', {}))),
      h('tbody', {}, ...rows))));
    out.push(h('h2', { class: 'dom-subhead' }, t('Add another domain')));
  }

  const endings = (p.tlds || []).map(x => '.' + x).join(' ');
  out.push(h('div', { class: 'dom-choices' },
    h('section', { class: 'card dom-choice' },
      h('h2', {}, t('I already have a domain')),
      h('div', { class: 'dom-price' }, money(price('domain_connect').ttc, { short: true }), h('span', {}, t('incl. VAT, paid once'))),
      help(t('We set up the DNS records with you and copy your old emails into this mailbox.')),
      h('div', { class: 'dom-choice-go' }, h('button', { type: 'button', class: 'compose-btn', on: { click: () => go({ name: 'connect' }) } }, t('Connect my domain')))),
    h('section', { class: 'card dom-choice' },
      h('h2', {}, t('Buy a new domain')),
      h('div', { class: 'dom-price' }, money(price('domain_register').ttc, { short: true }), h('span', {}, t('incl. VAT, per year'))),
      help(t('Choose a name ending in {endings}. We register it in your name and set everything up for you.', { endings })),
      h('div', { class: 'dom-choice-go' }, h('button', { type: 'button', class: 'compose-btn', on: { click: () => go({ name: 'buy' }) } }, t('Find a domain'))))));

  if (data.orders.length) out.push(ordersCard());
  return out;
}

function ordersCard() {
  const rows = data.orders.map(o => {
    const [label, kind] = orderStatus(o);
    return h('tr', {},
      h('td', { class: 'hide-sm secondary' }, shortDay(o.createdAt)),
      h('td', {}, h('div', { class: 'primary' }, orderWhat(o)), h('div', { class: 'secondary show-sm' }, shortDay(o.createdAt) + ' · ' + money(o.amountCents))),
      h('td', { class: 'num hide-sm' }, money(o.amountCents)),
      h('td', {}, badge(label, kind)),
      h('td', { class: 'actions' }, o.invoiceNumber
        ? h('a', { class: 'lh-link', href: '/account/invoice?id=' + encodeURIComponent(o.id), target: '_blank', rel: 'noopener', 'aria-label': t('Invoice {number}', { number: o.invoiceNumber }) }, t('Invoice'))
        : null));
  });
  return card(t('Orders and invoices'),
    help(t('Amounts include VAT. Invoices open in a new tab, ready to print or save as PDF.')),
    h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, h('th', { class: 'hide-sm' }, t('Date')), h('th', {}, t('Order')), h('th', { class: 'hide-sm', style: { textAlign: 'right' } }, t('Amount')), h('th', {}, t('Status')), h('th', {}))),
      h('tbody', {}, ...rows))));
}

/* ——— Connect a domain the person owns ——— */
async function connectView(v) {
  if (!data) await load();
  const input = h('input', { id: 'domConnect', class: 'fl-input', type: 'text', inputmode: 'url', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: t('company.fr'), value: v.domain || '', required: true });
  const status = h('div', { class: 'form-status', role: 'status' });
  const result = h('div', { class: 'dom-result', 'aria-live': 'polite' });
  const checkBtn = h('button', { type: 'submit', class: 'compose-btn' }, t('Check'));
  const form = h('form', { class: 'stack', novalidate: true },
    h('div', {}, h('label', { class: 'fl-label', for: 'domConnect' }, t('Your domain')),
      h('div', { class: 'dom-inline' }, input, checkBtn),
      h('div', { class: 'muted small dom-hint' }, t('Only the name, without www or http. For example: company.fr'))),
    status);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const domain = input.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (!domain) { status.className = 'form-status err'; status.textContent = t('Enter your domain.'); input.focus(); return; }
    status.className = 'form-status'; status.textContent = '';
    result.replaceChildren(h('div', { class: 'muted small' }, t('Checking {domain}…', { domain })));
    setBusy(checkBtn, true);
    try {
      const info = await api.account('domains/check', { domain });
      v.domain = info.domain;
      result.replaceChildren(connectResult(info));
    } catch (err) {
      if (isSessionEnd(err)) return;
      result.replaceChildren();
      status.className = 'form-status err';
      status.textContent = errText(err);
      if (err.data && err.data.code === 'nodomain') {
        status.append(' ', h('button', { type: 'button', class: 'lh-link', on: { click: () => go({ name: 'buy', q: domain.split('.')[0] }) } }, t('Find a domain to buy')));
      }
      input.focus();
    } finally { setBusy(checkBtn, false); }
  });
  if (v.domain) setTimeout(() => form.requestSubmit ? form.requestSubmit() : null, 0);
  const p = price('domain_connect');
  return [head(t('Connect your domain'), t('You keep your domain where it is. We show you the DNS records to add, then copy your old emails here.'), backBtn()),
    card(null, form, result),
    help(t('Price: {price} incl. VAT, paid once ({ht} excl. VAT + {vat} VAT).', { price: money(p.ttc), ht: money(p.ht), vat: money(p.vat) }))];
}

function connectResult(info) {
  const host = dnsHost(info.nameservers);
  const p = price('domain_connect');
  const pay = h('button', { type: 'button', class: 'compose-btn' }, t('Pay {price} and continue', { price: money(p.ttc, { short: true }) }));
  const status = h('div', { class: 'form-status', role: 'status' });
  const terms = h('input', { type: 'checkbox', id: 'own-connect-terms' });
  pay.addEventListener('click', async () => {
    if (!terms.checked) { status.className = 'form-status err'; status.textContent = t('Please accept the Terms of Sale to continue.'); terms.focus(); return; }
    setBusy(pay, true);
    status.className = 'form-status'; status.textContent = t('Opening the payment page…');
    try {
      const r = await api.account('domains/connect', { domain: info.domain, acceptTerms: true });
      window.location.assign(r.checkoutUrl);
    } catch (e) {
      if (isSessionEnd(e)) return;
      status.className = 'form-status err'; status.textContent = errText(e);
      setBusy(pay, false);
    }
  });
  return h('div', { class: 'dom-check' },
    h('h3', {}, info.domain),
    h('dl', { class: 'dom-facts' },
      h('dt', {}, t('DNS hosted by')), h('dd', {}, host ? h('b', {}, host) : h('span', { class: 'muted' }, t('A company we don’t recognise (see the name servers)'))),
      h('dt', {}, t('Name servers')), h('dd', {}, ...info.nameservers.map(n => h('code', { class: 'mono' }, n))),
      h('dt', {}, t('Current mail server (MX)')), h('dd', {}, info.mx.length ? info.mx.map(m => h('code', { class: 'mono' }, m)) : h('span', { class: 'muted' }, t('None: this domain does not receive email yet.')))),
    help(host
      ? t('After payment you will see the DNS records to add at {host}. Your current email keeps working until you change the MX record.', { host })
      : t('After payment you will see the DNS records to add where your DNS is hosted. Your current email keeps working until you change the MX record.')),
    h('label', { class: 'check-row dom-terms', for: 'own-connect-terms' }, terms,
      h('span', {}, ...withLink(t('I accept the {link}, and I ask for the service to start right away: once it is done, I can no longer withdraw within 14 days.'), h('a', { href: '/legal/sale', target: '_blank', rel: 'noopener' }, t('Terms of Sale'))))),
    h('div', { class: 'row-actions' }, pay, h('span', { class: 'muted small' }, t('Card payment on a secure page.'))),
    status);
}

/* ——— Buy a new domain ——— */
async function buyView(v) {
  if (!data) await load();
  const p = data.prices;
  const input = h('input', { id: 'domSearch', class: 'fl-input', type: 'search', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: t('my-company'), value: v.q || '', enterkeyhint: 'search' });
  const status = h('div', { class: 'form-status', role: 'status' });
  const results = h('div', { 'aria-live': 'polite' });
  const owner = h('div', {});
  const searchBtn = h('button', { type: 'submit', class: 'compose-btn' }, t('Search'));
  const form = h('form', { class: 'stack', role: 'search' },
    h('div', {}, h('label', { class: 'fl-label', for: 'domSearch' }, t('Name you would like')),
      h('div', { class: 'dom-inline' }, input, searchBtn),
      h('div', { class: 'muted small dom-hint' }, t('Endings we sell: {endings}. {price} incl. VAT per year.', { endings: (p.tlds || []).map(x => '.' + x).join(' '), price: money(price('domain_register').ttc) }))),
    status);

  const showResults = r => {
    v.results = r;
    const items = r.results.map(x => {
      const chosen = v.chosen === x.domain;
      const avail = x.available === true ? badge(t('Available'), 'ok') : x.available === false ? badge(t('Taken'), 'bad') : badge(t('Could not check'), 'warn');
      const choose = x.available === true ? h('button', { type: 'button', class: chosen ? 'compose-btn' : 'act-btn', 'aria-pressed': String(chosen),
        on: { click: () => { v.chosen = x.domain; showResults(r); owner.replaceChildren(ownerForm(v, x)); owner.scrollIntoView({ behavior: 'smooth', block: 'start' });
          const first = $('#own-firstName'); if (first) first.focus({ preventScroll: true }); } } }, chosen ? t('Chosen') : t('Choose')) : null;
      return h('li', { class: chosen ? 'chosen' : '' },
        h('span', { class: 'grow dom-name' }, x.domain), avail,
        x.available === true ? h('span', { class: 'dom-per-year' }, t('{price} / year', { price: money(x.priceCents || price('domain_register').ttc) })) : null, choose);
    });
    results.replaceChildren(...[
      r.unsupported ? note(t('We don’t sell .{ending} domains. Here are the endings we offer.', { ending: r.unsupported }), '') : null,
      h('ul', { class: 'sec-list dom-results', 'aria-label': t('Search results') }, ...items)].filter(Boolean));
  };

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) { input.focus(); return; }
    v.q = q; v.chosen = null; owner.replaceChildren();
    status.className = 'form-status'; status.textContent = '';
    results.replaceChildren(h('div', { class: 'muted small' }, t('Searching…')));
    setBusy(searchBtn, true);
    try { showResults(await api.account('domains/search?q=' + encodeURIComponent(q))); }
    catch (err) {
      if (isSessionEnd(err)) return;
      results.replaceChildren();
      status.className = 'form-status err'; status.textContent = errText(err);
      input.focus();
    } finally { setBusy(searchBtn, false); }
  });
  if (v.results) {
    showResults(v.results);
    const x = v.chosen && v.results.results.find(r => r.domain === v.chosen);
    if (x) owner.replaceChildren(ownerForm(v, x));
  } else if (v.q) setTimeout(() => form.requestSubmit ? form.requestSubmit() : null, 0);

  return [head(t('Buy a domain'), t('We register the domain in your name, publish its DNS records and add it to your mailbox. Nothing to configure.'), backBtn()),
    card(null, form, results), owner];
}

function ownerForm(v, choice) {
  const tld = choice.domain.split('.').slice(1).join('.');
  const needsEu = tld === 'fr' || tld === 'eu';
  const p = price('domain_register');
  const saved = v.contact || {};
  const fields = {};
  const field = (name, label, attrs = {}, hint = null) => {
    const id = 'own-' + name;
    const el = attrs.tag === 'select'
      ? h('select', { id, name, class: 'fl-input', autocomplete: attrs.autocomplete, 'aria-describedby': id + '-err' + (hint ? ' ' + id + '-hint' : '') }, ...attrs.options)
      : h('input', { id, name, class: 'fl-input', type: attrs.type || 'text', autocomplete: attrs.autocomplete, maxlength: attrs.maxlength, required: attrs.optional ? null : true,
        inputmode: attrs.inputmode, value: saved[name] !== undefined ? saved[name] : (attrs.value || ''), 'aria-describedby': id + '-err' + (hint ? ' ' + id + '-hint' : '') });
    fields[name] = el;
    return h('div', { class: 'dom-field' }, h('label', { class: 'fl-label', for: id }, label), el,
      hint ? h('div', { class: 'muted small dom-hint', id: id + '-hint' }, hint) : null,
      h('div', { class: 'dom-field-err', id: id + '-err' }));
  };
  const terms = h('input', { id: 'own-terms', type: 'checkbox', required: true });
  const status = h('div', { class: 'form-status', role: 'status' });
  const pay = h('button', { type: 'submit', class: 'compose-btn' }, t('Pay {price}', { price: money(p.ttc, { short: true }) }));
  const form = h('form', { class: 'stack', novalidate: true },
    h('div', { class: 'two-col' },
      field('firstName', t('First name'), { autocomplete: 'given-name', maxlength: 60 }),
      field('lastName', t('Last name'), { autocomplete: 'family-name', maxlength: 60 })),
    field('organisation', t('Organisation (optional)'), { autocomplete: 'organization', maxlength: 100, optional: true }),
    field('address', t('Address'), { autocomplete: 'street-address', maxlength: 120 }),
    h('div', { class: 'two-col' },
      field('postalCode', t('Postal code'), { autocomplete: 'postal-code', maxlength: 16 }),
      field('city', t('City'), { autocomplete: 'address-level2', maxlength: 60 })),
    h('div', { class: 'two-col' },
      field('country', t('Country'), { tag: 'select', autocomplete: 'country', options: countryOptions(saved.country || 'FR') },
        needsEu ? t('.{ending} domains need an owner in the European Union (or Iceland, Liechtenstein, Norway).', { ending: tld }) : null),
      field('phone', t('Phone'), { type: 'tel', autocomplete: 'tel', maxlength: 24, inputmode: 'tel' }, t('With the country code, for example +33 6 12 34 56 78.'))),
    field('email', t('Email'), { type: 'email', autocomplete: 'email', maxlength: 254, value: mail.state.user.email || '' }, t('The registry may write to this address about the domain.')),
    h('label', { class: 'check-row dom-terms', for: 'own-terms' }, terms,
      h('span', {}, ...withLink(t('I accept the {link}, and I ask for the service to start right away: once it is done, I can no longer withdraw within 14 days.'), h('a', { href: '/legal/sale', target: '_blank', rel: 'noopener' }, t('Terms of Sale'))))),
    h('div', { class: 'dom-total' }, h('b', {}, t('Total: {price} incl. VAT for 1 year', { price: money(p.ttc) })),
      h('span', { class: 'muted small' }, t('({ht} excl. VAT + {vat} VAT). Renewal is not automatic: a Renew button appears here 30 days before the end of the year.', { ht: money(p.ht), vat: money(p.vat) }))),
    status,
    h('div', { class: 'row-actions' }, pay, h('span', { class: 'muted small' }, t('Card payment on a secure page.'))));

  const clearErrors = () => {
    for (const el of Object.values(fields)) { el.removeAttribute('aria-invalid'); $('#' + el.id + '-err', form).textContent = ''; }
    status.className = 'form-status'; status.textContent = '';
  };
  const fieldError = (name, text) => {
    const el = fields[name];
    if (!el) { status.className = 'form-status err'; status.textContent = text; return; }
    el.setAttribute('aria-invalid', 'true');
    $('#' + el.id + '-err', form).textContent = text;
    el.focus();
  };
  for (const el of Object.values(fields)) el.addEventListener('input', () => { el.removeAttribute('aria-invalid'); $('#' + el.id + '-err', form).textContent = ''; });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    clearErrors();
    const contact = {};
    for (const [k, el] of Object.entries(fields)) contact[k] = el.value.trim();
    v.contact = contact;
    for (const k of ['firstName', 'lastName', 'address', 'postalCode', 'city', 'phone']) {
      if (!contact[k]) return fieldError(k, t('Please fill in this field.'));
    }
    if (needsEu && !EU.includes(contact.country)) return fieldError('country', t('.{ending} domains need an owner in the European Union (or Iceland, Liechtenstein, Norway).', { ending: tld }));
    if (!terms.checked) { status.className = 'form-status err'; status.textContent = t('Please accept the Terms of Sale to continue.'); terms.focus(); return; }
    if (!contact.organisation) delete contact.organisation;
    setBusy(pay, true);
    status.className = 'form-status'; status.textContent = t('Opening the payment page…');
    try {
      const r = await api.account('domains/buy', { domain: choice.domain, contact, acceptTerms: true });
      window.location.assign(r.checkoutUrl);
    } catch (err) {
      if (isSessionEnd(err)) return;
      status.className = 'form-status'; status.textContent = '';
      const d = err.data || {};
      if (d.code === 'contact' && d.field) fieldError(d.field, errText(err));
      else { status.className = 'form-status err'; status.textContent = errText(err); }
      if (d.code === 'taken') { choice.available = false; v.chosen = null; }
      setBusy(pay, false);
    }
  });
  return card(t('Owner of {domain}', { domain: choice.domain }),
    help(t('The domain is registered in the name of this person or organisation. Use real details: the registry may check them.')),
    form);
}

/* ——— Back from the payment page ——— */
async function returnView(v) {
  await load();
  const o = data.orders.find(x => x.id === v.order);
  if (!o) { view = { name: 'home' }; cleanUrl(view); return homeView(); }
  if (!v.paid || o.status === 'cancelled') {
    if (o.status === 'pending') { await api.account('orders/cancel', { id: o.id }).catch(() => {}); await load(); }
    flash = { text: t('Payment cancelled. Nothing was charged.'), kind: '' };
    view = o.kind === 'domain_renew' || data.domains.some(d => d.domain === o.domain && d.status !== 'awaiting_payment') ? { name: 'detail', domain: o.domain } : { name: 'home' };
    cleanUrl(view);
    renderSidebar();
    return (VIEWS[view.name])(view);
  }
  if (o.status === 'fulfilled' || o.status === 'failed') {
    if (o.status === 'fulfilled' && o.kind === 'domain_connect') toast(t('Payment received. Thank you.'));
    flash = o.status === 'fulfilled' && o.kind === 'domain_connect' ? null : o.status === 'fulfilled'
      ? { text: o.kind === 'domain_renew' ? t('Thank you: {domain} is renewed for one more year.', { domain: o.domain }) : t('Your domain {domain} is ready. Add your first address below.', { domain: o.domain }), kind: 'info' }
      : { text: t('Your payment was received, but setting up {domain} did not work. IRON ID has been told and will fix it or refund you.', { domain: o.domain }), kind: 'danger' };
    view = { name: 'detail', domain: o.domain };
    cleanUrl(view);
    renderSidebar();
    return detailView(view);
  }
  // Paid (or the card payment is still being confirmed): the domain is being set up.
  const waited = Date.now() - (v.since || (v.since = Date.now()));
  later(() => render({ top: false }), 2000);
  return [head(t('Your domains')),
    h('section', { class: 'card dom-wait' },
      h('div', { class: 'dom-spinner', 'aria-hidden': 'true' }),
      h('div', { role: 'status', 'aria-live': 'polite' },
        h('h2', {}, o.status === 'pending' ? t('Confirming your payment…') : t('Payment received — setting up your domain…')),
        h('p', { class: 'help' }, orderWhat(o)),
        waited > 90000 ? h('p', { class: 'help' }, t('This is taking longer than usual. You can leave this page: we keep working on it and your domain will appear here when it is ready.')) : null))];
}

/* ——— One domain ——— */
async function detailView(v) {
  await load();
  const d = data.domains.find(x => x.domain === v.domain);
  if (!d) {
    return [head(v.domain, null, backBtn()), note(t('That domain was not found.'), 'danger')];
  }
  const [label, kind] = statusOf(d);
  const out = [head(d.domain, null, backBtn()), h('div', { class: 'dom-badges' }, badge(label, kind), d.bought ? badge(t('Bought through IRON ID'), 'info') : null), takeFlash()];

  if (d.status === 'awaiting_payment') {
    const again = h('button', { type: 'button', class: 'compose-btn' }, d.bought ? t('Start again') : t('Pay {price} and continue', { price: money(price('domain_connect').ttc, { short: true }) }));
    again.addEventListener('click', async () => {
      if (d.bought) return go({ name: 'buy', q: d.domain });
      setBusy(again, true);
      try { window.location.assign((await api.account('domains/connect', { domain: d.domain })).checkoutUrl); }
      catch (e) { if (!isSessionEnd(e)) toast(errText(e), false); setBusy(again, false); }
    });
    out.push(card(null, help(t('The payment for this domain was not completed.')), h('div', { class: 'row-actions' }, again)));
    return out;
  }
  if (d.status === 'setting_up') {
    later(() => render({ top: false }), 2000);
    out.push(h('section', { class: 'card dom-wait' }, h('div', { class: 'dom-spinner', 'aria-hidden': 'true' }),
      h('div', { role: 'status', 'aria-live': 'polite' }, h('h2', {}, t('Payment received — setting up your domain…')), h('p', { class: 'help' }, t('This usually takes less than a minute.')))));
    return out;
  }
  if (d.status === 'problem') {
    out.push(note(t('Your payment was received, but setting up {domain} did not work. IRON ID has been told and will fix it or refund you.', { domain: d.domain }), 'danger'));
    return out;
  }
  if (d.status === 'pending') {
    out.push(note(t('Step 1: add the records below where your domain’s DNS is hosted, then press Verify. Mail starts arriving here once the MX record points to IRON ID.'), 'info'));
    out.push(dnsCard(d));
  }
  if (d.status === 'active') {
    out.push(addressesCard(d));
    if (d.bought) out.push(renewCard(d));
    // The copy of old emails comes with the connect service; it is the person's, shown on their connected domains.
    if (!d.bought && data.orders.some(o => o.kind === 'domain_connect' && ['paid', 'fulfilled'].includes(o.status))) out.push(copyCard());
    out.push(dnsCard(d));
  }
  out.push(removeCard(d));
  return out;
}

function dnsCard(d) {
  const body = h('div', { 'aria-live': 'polite' }, h('div', { class: 'muted small' }, t('Checking the DNS records…')));
  const check = h('button', { type: 'button', class: 'act-btn' }, t('Check now'));
  const verify = d.status === 'pending' ? h('button', { type: 'button', class: 'compose-btn' }, t('Verify')) : null;
  const status = h('div', { class: 'form-status', role: 'status' });
  const g = gen;
  const fill = async () => {
    setBusy(check, true);
    try {
      const r = await api.account('domains/dns?domain=' + encodeURIComponent(d.domain));
      if (g !== gen) return;
      const records = d.status === 'active' ? r.records.filter(rec => rec.id !== 'verify') : r.records;
      body.replaceChildren(
        ...(r.warnings || []).map(w => note(w, '')),
        h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl dns-tbl' },
          h('thead', {}, h('tr', {}, h('th', {}, t('Status')), h('th', {}, t('Type')), h('th', {}, t('Host')), h('th', {}, t('Value')))),
          h('tbody', {}, ...records.map(rec => {
            const mx = rec.type === 'MX' ? /^(\d+)\s+(.*)$/.exec(rec.value) : null;
            const value = mx ? mx[2] : rec.value;
            const state = rec.ok ? t('Found') : rec.problem ? t('Problem') : t('Missing');
            return h('tr', {},
              h('td', { 'data-label': t('Status') }, h('span', { class: 'status-dot ' + (rec.ok ? 'ok' : rec.required ? 'bad' : 'warn'), 'aria-hidden': 'true' }), state),
              h('td', { 'data-label': t('Type') }, h('b', {}, rec.type)),
              h('td', { 'data-label': t('Host') }, h('div', { class: 'dns-value' }, h('code', {}, rec.host), copyBtn(rec.host, t('Copy the host of the {type} record', { type: rec.type })))),
              h('td', { 'data-label': t('Value') },
                h('div', { class: 'dns-value' }, h('code', {}, value), copyBtn(value, t('Copy the value of the {type} record', { type: rec.type }))),
                mx ? h('div', { class: 'secondary' }, t('Priority {n}', { n: mx[1] })) : null,
                h('div', { class: 'secondary' }, rec.purpose),
                rec.problem ? h('div', { class: 'secondary dom-problem' }, rec.problem) : null));
          })))));
    } catch (e) {
      if (isSessionEnd(e)) return;
      body.replaceChildren(note(errText(e), 'danger'));
    } finally { setBusy(check, false); }
  };
  check.addEventListener('click', () => { status.textContent = ''; status.className = 'form-status'; fill(); });
  if (verify) verify.addEventListener('click', async () => {
    setBusy(verify, true);
    status.className = 'form-status'; status.textContent = '';
    try {
      await api.account('domains/verify', { domain: d.domain });
      flash = { text: t('Domain verified. You can add addresses now.'), kind: 'info' };
      render({ top: false });
    } catch (e) {
      if (isSessionEnd(e)) return;
      status.className = 'form-status err'; status.textContent = errText(e);
      setBusy(verify, false);
      fill();
    }
  });
  fill();
  return card(t('DNS records'),
    help(d.bought
      ? t('IRON ID publishes these records for you. There is nothing to do.')
      : t('Add these records where your domain’s DNS is hosted. Host "@" means the domain itself; some providers want the full name instead. Changes can take up to a few hours to show.')),
    d.bought ? h('details', { class: 'dom-details' }, h('summary', {}, t('Show the records')), body) : body, status,
    d.bought ? null : h('div', { class: 'row-actions' }, verify, check));
}

function copyBtn(text, label) {
  return h('button', { type: 'button', class: 'lh-link', title: label, 'aria-label': label, on: { click: () => copyText(text) } }, t('Copy'));
}

function addressesCard(d) {
  const local = h('input', { id: 'domLocal', class: 'fl-input', type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: 64, placeholder: t('contact'), required: true });
  const add = h('button', { type: 'submit', class: 'compose-btn' }, t('Add address'));
  const status = h('div', { class: 'form-status', role: 'status' });
  const form = h('form', { class: 'dom-addr-form', novalidate: true },
    h('label', { class: 'fl-label', for: 'domLocal' }, t('New address')),
    h('div', { class: 'dom-inline' }, h('div', { class: 'dom-local' }, local, h('span', { class: 'dom-at' }, '@' + d.domain)), add));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const v = local.value.trim().toLowerCase();
    if (!v) { status.className = 'form-status err'; status.textContent = t('Enter the part before the @, for example contact.'); local.focus(); return; }
    setBusy(add, true);
    status.className = 'form-status'; status.textContent = '';
    try {
      const r = await api.account('addresses', { local: v, domain: d.domain });
      toast(t('{email} added', { email: r.email }));
      mail.loadIdentities().catch(() => {});
      await render({ top: false });
      const again = $('#domLocal'); if (again) again.focus();
    } catch (err) {
      if (isSessionEnd(err)) return;
      status.className = 'form-status err'; status.textContent = errText(err);
      setBusy(add, false);
      local.focus();
    }
  });
  const items = d.addresses.map(a => {
    const rm = h('button', { type: 'button', class: 'act-btn danger-text', 'aria-label': t('Remove {email}', { email: a }) }, t('Remove'));
    rm.addEventListener('click', async () => {
      const ok = await dialog({ title: t('Remove address'), text: t('Remove {email}? Mail sent to it will no longer arrive. Messages already received stay in your mailbox.', { email: a }), okLabel: t('Remove'), danger: true });
      if (!ok) return;
      try {
        await api.account('addresses/remove', { email: a });
        toast(t('{email} removed', { email: a }));
        mail.loadIdentities().catch(() => {});
        render({ top: false });
      } catch (e) { if (!isSessionEnd(e)) toast(errText(e), false); }
    });
    return h('li', {}, h('span', { class: 'grow dom-name' }, a), rm);
  });
  return card(t('Addresses'),
    help(t('Mail sent to these addresses arrives in this mailbox. You can also send from them: choose the address in From when you write.')),
    h('ul', { class: 'sec-list' }, ...(items.length ? items : [h('li', { class: 'muted' }, t('No addresses yet. Add your first one below.'))])),
    form, status);
}

function renewCard(d) {
  const expired = d.expiresAt && new Date(d.expiresAt) < new Date();
  const p = price('domain_renew');
  const parts = [help(expired
    ? t('The year paid for ended on {date}. Renew now to keep the domain and its addresses.', { date: longDay(d.expiresAt) })
    : t('Paid until {date}.', { date: longDay(d.expiresAt) }))];
  if (d.renewable) {
    const btn = h('button', { type: 'button', class: 'compose-btn' }, t('Renew for 1 year ({price})', { price: money(p.ttc, { short: true }) }));
    btn.addEventListener('click', async () => {
      setBusy(btn, true);
      try { window.location.assign((await api.account('domains/renew', { domain: d.domain })).checkoutUrl); }
      catch (e) { if (!isSessionEnd(e)) toast(errText(e), false); setBusy(btn, false); }
    });
    parts.push(h('div', { class: 'row-actions' }, btn));
  } else {
    parts.push(h('p', { class: 'muted small' }, t('A Renew button appears here 30 days before this date.')));
  }
  return card(t('Registration'), ...parts);
}

/* ——— Copy of old emails (IMAP) ——— */
function copyCard() {
  const box = h('div', {});
  const last = (data.migrations || [])[0];
  if (last && ['queued', 'running'].includes(last.status)) box.replaceChildren(copyProgress(last, box));
  else box.replaceChildren(...[last ? copyResult(last) : null, copyForm(box)].filter(Boolean));
  return card(t('Copy my old emails'),
    help(t('We copy every folder of your old mailbox into this one: messages keep their date, and read and starred marks. Your old mailbox is not changed.')),
    box);
}

function copyResult(m) {
  if (m.status === 'done') {
    return note(h('span', {}, tn('Copy finished: {n} message copied from {host} ({size}).', 'Copy finished: {n} messages copied from {host} ({size}).', m.messages, { host: m.host, size: formatSize(m.bytes) }),
      m.skipped ? ' ' + tn('{n} message was skipped (too large or unreadable).', '{n} messages were skipped (too large or unreadable).', m.skipped) : ''), 'info');
  }
  if (m.status === 'failed') return note(t('The copy from {host} stopped: {error}', { host: m.host, error: m.error || t('unknown error') }), 'danger');
  if (m.status === 'cancelled') return note(t('The copy from {host} was cancelled.', { host: m.host }), '');
  return null;
}

function copyForm(box) {
  const server = h('input', { id: 'cpHost', class: 'fl-input', type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'imap.example.com', required: true });
  const port = h('select', { id: 'cpPort', class: 'fl-input' }, h('option', { value: '993' }, t('993 (SSL)')), h('option', { value: '143' }, t('143 (STARTTLS)')));
  const user = h('input', { id: 'cpUser', class: 'fl-input', type: 'email', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: t('you@old-provider.com'), required: true });
  const pass = h('input', { id: 'cpPass', class: 'fl-input', type: 'password', autocomplete: 'off', required: true });
  const appNote = h('div', { class: 'notice hidden', role: 'status' });
  const status = h('div', { class: 'form-status', role: 'status' });
  const start = h('button', { type: 'submit', class: 'compose-btn' }, t('Start the copy'));
  const picks = PROVIDERS.map(p => {
    const b = h('button', { type: 'button', class: 'preset-btn', 'aria-pressed': 'false' }, p.name);
    b.addEventListener('click', () => {
      for (const x of picks) x.setAttribute('aria-pressed', String(x === b));
      server.value = p.host; port.value = '993';
      appNote.classList.toggle('hidden', !p.appPassword);
      appNote.textContent = p.appPassword ? t('{provider} needs an app password: create one in the security settings of your {provider} account and use it as the password here, instead of your usual password.', { provider: p.name }) : '';
      user.focus();
    });
    return b;
  });
  const field = (id, label, el) => h('div', {}, h('label', { class: 'fl-label', for: id }, label), el);
  const form = h('form', { class: 'stack', novalidate: true },
    h('div', {}, h('div', { class: 'fl-label', id: 'cpPickLabel' }, t('Your old provider')),
      h('div', { class: 'dom-picks', role: 'group', 'aria-labelledby': 'cpPickLabel' }, ...picks)),
    h('div', { class: 'dom-grid-3' }, field('cpHost', t('Server (IMAP)'), server), field('cpPort', t('Port'), port)),
    h('div', { class: 'two-col' }, field('cpUser', t('Old address (user name)'), user), field('cpPass', t('Password'), pass)),
    appNote,
    h('p', { class: 'muted small' }, t('Gmail, Outlook, Yahoo and iCloud need an app password. Your password is only used for this copy and erased when it ends.')),
    status,
    h('div', { class: 'row-actions' }, start));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    status.className = 'form-status'; status.textContent = '';
    for (const el of [server, user, pass]) el.removeAttribute('aria-invalid');
    const body = { host: server.value.trim(), port: Number(port.value), username: user.value.trim(), password: pass.value };
    if (!body.host) { status.className = 'form-status err'; status.textContent = t('Enter the server name of your old provider.'); server.setAttribute('aria-invalid', 'true'); server.focus(); return; }
    if (!body.username || !body.password) { status.className = 'form-status err'; status.textContent = t('Enter the address and password of your old mailbox.'); (body.username ? pass : user).focus(); return; }
    setBusy(start, true, t('Checking the sign-in…'));
    try {
      const m = await api.account('migrations', body);
      pass.value = '';
      toast(t('The copy has started'));
      box.replaceChildren(copyProgress(m, box));
    } catch (err) {
      if (isSessionEnd(err)) return;
      status.className = 'form-status err'; status.textContent = errText(err);
      const code = err.data && err.data.code;
      const el = code === 'host' || code === 'port' ? (code === 'port' ? port : server) : code === 'login' ? pass : null;
      if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); }
      setBusy(start, false, t('Start the copy'));
    }
  });
  return form;
}

function copyProgress(m, box) {
  const g = gen;
  const mine = box.tick = (box.tick || 0) + 1; // only the newest progress view keeps polling
  const pct = m.foldersTotal ? Math.round(m.foldersDone / m.foldersTotal * 100) : 0;
  const cancel = h('button', { type: 'button', class: 'act-btn danger-text' }, t('Cancel the copy'));
  cancel.addEventListener('click', async () => {
    const ok = await dialog({ title: t('Cancel the copy'), text: t('Stop copying your old emails? Messages already copied stay in your mailbox.'), okLabel: t('Stop the copy'), danger: true });
    if (!ok) return;
    try { await api.account('migrations/cancel', { id: m.id }); } catch (e) { if (!isSessionEnd(e)) toast(errText(e), false); }
    poll();
  });
  const poll = async () => {
    if (g !== gen || !openNow || !box.isConnected || box.tick !== mine) return;
    try {
      const r = await api.account('migrations');
      if (g !== gen || !box.isConnected || box.tick !== mine) return;
      const cur = r.migrations.find(x => x.id === m.id) || r.migrations[0];
      if (data) data.migrations = r.migrations;
      if (cur && ['queued', 'running'].includes(cur.status)) box.replaceChildren(copyProgress(cur, box));
      else box.replaceChildren(...[cur ? copyResult(cur) : null, copyForm(box)].filter(Boolean));
    } catch (e) {
      if (isSessionEnd(e)) return;
      setTimeout(poll, 6000);
    }
  };
  setTimeout(poll, 3000);
  return h('div', { class: 'dom-progress' },
    h('div', { role: 'status', 'aria-live': 'polite' },
      h('b', {}, m.status === 'queued' ? t('Waiting to start…') : t('Copying from {host}…', { host: m.host })),
      h('div', { class: 'muted small' },
        m.foldersTotal ? t('{done} of {total} folders', { done: m.foldersDone, total: m.foldersTotal }) : t('Looking at the folders…'),
        ' · ', tn('{n} message', '{n} messages', m.messages || 0), ' · ', formatSize(m.bytes || 0))),
    h('div', { class: 'sb-meter', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': t('Copy progress') },
      h('div', { class: 'sb-meter-fill', style: { width: Math.max(pct, 2) + '%' } })),
    h('div', { class: 'row-actions' }, cancel, h('span', { class: 'muted small' }, t('You can leave this page: the copy continues.'))));
}

function removeCard(d) {
  const btn = h('button', { type: 'button', class: 'act-btn danger-text' }, t('Remove domain'));
  btn.addEventListener('click', async () => {
    const v = await dialog({
      title: t('Remove {domain}', { domain: d.domain }),
      text: t('Its addresses stop working at once. Type {domain} to confirm.', { domain: d.domain }),
      input: '', okLabel: t('Remove'), danger: true,
      validate: x => (x.toLowerCase() === d.domain ? null : t('Type the domain name exactly as shown.'))
    });
    if (!v) return;
    try {
      await api.account('domains/remove', { domain: d.domain, confirm: v.toLowerCase() });
      mail.loadIdentities().catch(() => {});
      toast(t('{domain} removed', { domain: d.domain }));
      go({ name: 'home' });
    } catch (e) { if (!isSessionEnd(e)) toast(errText(e), false); }
  });
  return h('section', { class: 'card dom-danger' }, h('h2', {}, t('Remove this domain')),
    help(d.bought
      ? t('Its addresses stop working and mail sent to them is no longer delivered. Messages already received stay in your mailbox. The domain stays registered in your name until the end of the year paid for.')
      : t('Its addresses stop working and mail sent to them is no longer delivered. Messages already received stay in your mailbox.')),
    h('div', {}, btn));
}

const VIEWS = { home: homeView, connect: connectView, buy: buyView, return: returnView, detail: detailView };

/* ——— Opening and closing ——— */
export function isOpen() { return openNow; }

export function open(target = { name: 'home' }) {
  if (!eligible) return;
  const was = openNow;
  openNow = true;
  view = target;
  const body = document.body;
  body.classList.add('view-domains');
  body.classList.remove('view-reader', 'nav-open');
  body.classList.add('view-list');
  const nt = $('#navToggle'); if (nt) nt.setAttribute('aria-expanded', 'false');
  if (!was && !location.hash.startsWith('#domains')) history.pushState({ domains: true }, '', location.pathname + location.search + hashFor(target));
  else history.replaceState(history.state, '', location.pathname + location.search + hashFor(target));
  if (!was) mail.emit('mailboxes'); // folders lose their highlight
  renderSidebar();
  render();
}

export function close() {
  if (!openNow) return;
  openNow = false;
  gen++;
  stopTimer();
  document.body.classList.remove('view-domains');
  if (location.hash.startsWith('#domains') || location.search) history.replaceState(history.state, '', location.pathname);
  $('#domainsPage').replaceChildren();
  renderSidebar();
}

/** The platform's own domain (from /signup-api/config): only its mailboxes can add own domains. */
export function setPlatformDomain(d) { platformDomain = d ? String(d).toLowerCase() : null; resolvePlatform(platformDomain); }

export function init({ showMail }) {
  onShowMail = showMail || onShowMail;
  $('#btnAddDomain').addEventListener('click', () => open({ name: 'home' }));
  window.addEventListener('popstate', () => {
    const v = viewFromHash();
    if (v && eligible) { if (!openNow || v.name !== view.name || v.domain !== view.domain) open(v); }
    else if (openNow) onShowMail();
  });
}

/** After sign-in: shows the section and the renewal notices, and opens the page if the address asks for it. */
export async function setup({ email, notices: list }) {
  notices = Array.isArray(list) ? list : [];
  const dom = await Promise.race([platformReady, new Promise(r => setTimeout(() => r(platformDomain), 8000))]);
  eligible = !!dom && String(email || '').toLowerCase().endsWith('@' + dom);
  renderSidebar();
  renderNotice();
  if (!eligible) return;
  const q = new URLSearchParams(location.search);
  const order = Number(q.get('order'));
  if (order && q.has('paid')) open({ name: 'return', order, paid: q.get('paid') === '1' });
  else if (viewFromHash()) open(viewFromHash());
  else load().catch(() => {});
}
