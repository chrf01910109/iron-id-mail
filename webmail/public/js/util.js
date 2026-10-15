// Small helpers shared by the webmail views.
// Untrusted text (subjects, names, bodies) is only ever inserted with textContent via h().

/** Creates an element. attrs: class, dataset {…}, on {event: fn}, any attribute. Children: nodes or strings. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'style' && typeof v === 'object') {
      for (const [p, val] of Object.entries(v)) { if (p.startsWith('--')) el.style.setProperty(p, val); else el.style[p] = val; }
    }
    // nosemgrep: innerhtml-with-non-constant -- only constant icon markup is ever passed as html (checked in review)
    else if (k === 'html') el.innerHTML = v; // trusted, constant markup only (icons)
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ——— Icons (constant, trusted SVG) ——— */
const P = {
  inbox: '<path d="M22 12h-6l-2 3H10l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/>',
  sent: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>',
  drafts: '<path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>',
  junk: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>',
  reply: '<path d="M9 17 4 12l5-5M20 18v-2a4 4 0 0 0-4-4H4"/>',
  replyAll: '<path d="m7 17-5-5 5-5M12 17l-5-5 5-5M22 18v-2a4 4 0 0 0-4-4H7"/>',
  forward: '<path d="m15 17 5-5-5-5M4 18v-2a4 4 0 0 1 4-4h12"/>',
  mailOpen: '<path d="M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h9"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/><path d="m16 19 2 2 4-4"/>',
  star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
  move: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><path d="m12 10 3 3-3 3M8 13h7"/>',
  clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  print: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/>',
  dots: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  notSpam: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  restore: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  tag: '<path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  plus: '<path d="M12 5v14M5 12h14"/>'
};

export function icon(name, size = 15, strokeWidth = 1.8) {
  const span = document.createElement('span');
  span.className = 'ic';
  span.style.display = 'inline-flex';
  // nosemgrep: innerhtml-with-non-constant -- built from the constant icon table and numbers from code
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || P.folder}</svg>`;
  return span;
}

/* ——— Formatting ——— */
const AV_COLORS = [
  ['#DBEAFE', '#1E40AF'], ['#FDE68A', '#78350F'], ['#D1FAE5', '#065F46'], ['#C7D2FE', '#3730A3'],
  ['#FBCFE8', '#831843'], ['#FED7AA', '#9A3412'], ['#E9D5FF', '#6B21A8'], ['#FECACA', '#991B1B']
];
export function avatarColor(str) {
  let x = 0;
  for (let i = 0; i < (str || '').length; i++) x = str.charCodeAt(i) + ((x << 5) - x);
  return AV_COLORS[Math.abs(x) % AV_COLORS.length];
}

export function initials(name, email) {
  const n = (name || '').replace(/["'<>]/g, '').trim();
  if (n) {
    const parts = n.split(/\s+/).filter(Boolean);
    const first = Array.from(parts[0])[0] || '';
    const last = parts.length > 1 ? (Array.from(parts[parts.length - 1])[0] || '') : (Array.from(parts[0])[1] || '');
    return (first + last).toUpperCase();
  }
  return Array.from(email || '??').slice(0, 2).join('').toUpperCase();
}

export function avatar(name, email, cls = 'ei-avatar') {
  const [bg, fg] = avatarColor((email || name || '').toLowerCase());
  return h('div', { class: cls, style: { background: bg, color: fg }, 'aria-hidden': 'true' }, initials(name, email));
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Short date for lists: time today, "13 Oct" this year, "13/10/2025" before. */
export function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  if (sameDay(d, now)) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return d.toLocaleDateString();
}

export function longDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatSize(bytes) {
  if (bytes === undefined || bytes === null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB';
  if (bytes < 1024 ** 3) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 ** 3).toFixed(2) + ' GB';
}

export function displayName(addr) {
  if (!addr) return '';
  return addr.name && addr.name.trim() ? addr.name.trim() : (addr.email || '');
}

export function formatAddress(a) {
  if (!a) return '';
  const name = (a.name || '').trim();
  if (!name) return a.email || '';
  const needsQuotes = /[,;<>@"()[\]:\\]/.test(name);
  return `${needsQuotes ? '"' + name.replace(/["\\]/g, '\\$&') + '"' : name} <${a.email}>`;
}

export function formatAddressList(list) {
  return (list || []).map(formatAddress).join(', ');
}

const EMAIL_RE = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]{2,}$/;
export const isEmail = s => EMAIL_RE.test(String(s || '').trim());

/**
 * Parses "Name <a@b.c>, d@e.f; "Last, First" <g@h.i>" into [{name, email}].
 * Returns { list, invalid } where invalid holds entries that are not addresses.
 */
export function parseAddresses(input) {
  const list = [], invalid = [];
  const parts = [];
  let cur = '', inQuote = false, inAngle = false;
  for (const ch of String(input || '')) {
    if (ch === '"' && !inAngle) inQuote = !inQuote;
    if (ch === '<' && !inQuote) inAngle = true;
    if (ch === '>' && !inQuote) inAngle = false;
    if ((ch === ',' || ch === ';' || ch === '\n') && !inQuote && !inAngle) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  for (let p of parts) {
    p = p.trim();
    if (!p) continue;
    const m = p.match(/^(.*)<([^<>]+)>\s*$/);
    let name = '', email = p;
    if (m) { name = m[1].trim().replace(/^"(.*)"$/, '$1').replace(/\\(["\\])/g, '$1'); email = m[2].trim(); }
    if (isEmail(email)) list.push(name ? { name, email } : { email });
    else invalid.push(p);
  }
  return { list, invalid };
}

export function debounce(fn, ms) {
  let t = null;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  d.cancel = () => clearTimeout(t);
  d.flush = (...args) => { clearTimeout(t); return fn(...args); };
  return d;
}

/* ——— Preferences (this device only) ——— */
const PREF_KEY = 'iron_id_prefs';
const DEFAULT_PREFS = { autoSeen: true, confirmDelete: true, remoteImages: 'ask', trustedSenders: [] };
export function loadPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch (e) { p = {}; }
  // Older versions kept these under separate keys.
  try {
    const a = localStorage.getItem('iron_id_auto_seen');
    if (a !== null && p.autoSeen === undefined) p.autoSeen = a === 'true';
    const c = localStorage.getItem('iron_id_confirm_delete');
    if (c !== null && p.confirmDelete === undefined) p.confirmDelete = c === 'true';
  } catch (e) { /* storage blocked */ }
  return { ...DEFAULT_PREFS, ...p, trustedSenders: Array.isArray(p.trustedSenders) ? p.trustedSenders.slice(0, 500) : [] };
}
export function savePrefs(prefs) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* storage blocked */ }
}

/* ——— Toast ——— */
let toastTimer = null;
export function toast(msg, ok = true, action = null) {
  const t = $('#toast');
  $('#toastMsg').textContent = msg;
  const i = $('#toastIcon');
  i.textContent = ok ? '✓' : '✕';
  i.style.color = ok ? '#4ADE80' : '#F87171';
  const btn = $('#toastAction');
  btn.onclick = null;
  if (action) {
    btn.textContent = action.label;
    btn.classList.remove('hidden');
    btn.onclick = () => { t.classList.remove('visible'); action.run(); };
  } else {
    btn.classList.add('hidden');
  }
  t.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('visible'), action ? 6000 : 3500);
}

/* ——— Dialog: confirm / prompt without browser popups ——— */
let dialogResolve = null;
export function dialog({ title, text = '', input = null, okLabel = 'OK', danger = false, validate = null }) {
  return new Promise(resolve => {
    if (dialogResolve) dialogResolve(null);
    dialogResolve = resolve;
    const bg = $('#dialog');
    $('#dialogTitle').textContent = title;
    $('#dialogText').textContent = text;
    const inp = $('#dialogInput');
    const err = $('#dialogError');
    err.textContent = ''; err.className = 'form-status';
    if (input !== null) { inp.classList.remove('hidden'); inp.value = input; } else inp.classList.add('hidden');
    const ok = $('#dialogOk');
    ok.textContent = okLabel;
    ok.style.background = danger ? 'var(--color-danger)' : '';
    bg.classList.add('open');
    bg.setAttribute('aria-hidden', 'false');
    setTimeout(() => (input !== null ? (inp.focus(), inp.select()) : ok.focus()), 30);
    const close = value => {
      bg.classList.remove('open');
      bg.setAttribute('aria-hidden', 'true');
      $('#dialogForm').onsubmit = null;
      $('#dialogCancel').onclick = null;
      bg.onkeydown = null;
      const r = dialogResolve; dialogResolve = null;
      if (r) r(value);
    };
    $('#dialogForm').onsubmit = e => {
      e.preventDefault();
      const value = input !== null ? inp.value.trim() : true;
      if (validate) {
        const problem = validate(value);
        if (problem) { err.textContent = problem; err.className = 'form-status err'; return; }
      }
      close(value);
    };
    $('#dialogCancel').onclick = () => close(null);
    bg.onkeydown = e => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
  });
}
export const isDialogOpen = () => $('#dialog').classList.contains('open');

/* ——— Popover menu ——— */
let menuCleanup = null;
/** items: [{label, icon?, dot?, checked?, run, danger?} | {title}]. Anchored under `anchor` (element) or at {x,y}. */
export function openMenu(anchor, items) {
  closeMenu();
  const menu = $('#menu');
  menu.replaceChildren(...items.map(it => it.title
    ? h('div', { class: 'pop-title' }, it.title)
    : h('button', { type: 'button', class: it.danger ? 'danger' : '', style: it.indent ? { paddingLeft: (10 + it.indent * 14) + 'px' } : null,
        'aria-checked': it.checked === undefined ? null : String(!!it.checked), role: it.checked === undefined ? 'menuitem' : 'menuitemcheckbox',
        on: { click: () => { closeMenu(); it.run(); } } },
      it.icon ? icon(it.icon, 14) : null, it.dot ? h('span', { class: 'lbl-dot c-' + it.dot }) : null, h('span', { class: 'pop-label' }, it.label),
      it.checked ? h('span', { class: 'pop-check' }, icon('check', 14)) : null)));
  menu.classList.remove('hidden');
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y, top: anchor.y };
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - mw - 8);
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = top + 'px';
  const first = menu.querySelector('button');
  if (first) first.focus();
  const onDoc = e => { if (!menu.contains(e.target)) closeMenu(); };
  const onKey = e => {
    if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); if (anchor instanceof Element) anchor.focus(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const btns = $$('button', menu);
      const i = btns.indexOf(document.activeElement);
      const n = btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length];
      if (n) n.focus();
    }
  };
  setTimeout(() => document.addEventListener('mousedown', onDoc), 0);
  menu.addEventListener('keydown', onKey);
  menuCleanup = () => { document.removeEventListener('mousedown', onDoc); menu.removeEventListener('keydown', onKey); };
}
export function closeMenu() {
  const menu = $('#menu');
  menu.classList.add('hidden');
  if (menuCleanup) { menuCleanup(); menuCleanup = null; }
}
export const isMenuOpen = () => !$('#menu').classList.contains('hidden');
