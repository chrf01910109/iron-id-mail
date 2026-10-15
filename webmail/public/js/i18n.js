// IRON ID Mail — English and French.
//
// Text is written in English in the code and passed through t(). The French text lives in
// i18n/fr/*.js, keyed by the English text itself (like gettext). Anything without a French
// entry stays in English, and tests/i18n/check-translations.js fails the build when an
// entry is missing.
//
//   t('Delete')                                   → "Supprimer"
//   t('Moved to {folder}', { folder: name })      → "Déplacé vers Archives"
//   tn('{n} message', '{n} messages', count)      → singular/plural by the language's rules
//
// Static text in index.html and admin.html is translated in place when the page loads
// (text nodes and the placeholder/title/aria-label/alt attributes).
//
// The language comes from the `ironid_lang` cookie, which the server sets from the account's
// saved choice when someone signs in; before that, from the browser's language.

import FR from './i18n/fr/index.js';

export const LANGS = [
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'Français' }
];
const SUPPORTED = LANGS.map(l => l.code);
const COOKIE = 'ironid_lang';

function readCookie() {
  const m = /(?:^|;\s*)ironid_lang=([a-z]{2})(?:;|$)/.exec(document.cookie || '');
  return m && SUPPORTED.includes(m[1]) ? m[1] : null;
}

function fromBrowser() {
  for (const l of navigator.languages || [navigator.language || '']) {
    const code = String(l).slice(0, 2).toLowerCase();
    if (SUPPORTED.includes(code)) return code;
  }
  return 'en';
}

/** The page's language: 'en' or 'fr'. The server already picked it for <html lang> (cookie, then Accept-Language). */
export const lang = readCookie() || (SUPPORTED.includes(document.documentElement.lang) ? document.documentElement.lang : fromBrowser());

/** Locale for dates and numbers. Day/month order in both languages. */
export const locale = lang === 'fr' ? 'fr-FR' : 'en-GB';

const DICT = lang === 'fr' ? FR : null;
const plural = new Intl.PluralRules(locale);

function fill(s, vars) {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) && vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
}

/** Translates an English text. `vars` fill {placeholders}. */
export function t(msg, vars) {
  const s = (DICT && Object.prototype.hasOwnProperty.call(DICT, msg)) ? DICT[msg] : msg;
  return fill(s, vars);
}

/**
 * Same as t(), for a word whose French depends on where it is used ("Archive": the folder
 * "Archives" or the action "Archiver"). The French key is "context|English"; English stays as is.
 */
export function tx(context, msg, vars) {
  const key = context + '|' + msg;
  if (DICT && Object.prototype.hasOwnProperty.call(DICT, key)) return fill(DICT[key], vars);
  return t(msg, vars);
}

/** Singular or plural by the language's rules (French uses the singular for 0 and 1). {n} is the count. */
export function tn(one, other, n, vars) {
  const form = plural.select(Number(n)) === 'one' ? one : other;
  return t(form, Object.assign({ n }, vars));
}

/** Formats a number for the current language. */
export function num(n, opts) {
  return new Intl.NumberFormat(locale, opts).format(n);
}

/** Saves the language in this browser and reloads the page in it. The account's choice is saved separately (/account/prefs). */
export function setLang(code, { reload = true } = {}) {
  if (!SUPPORTED.includes(code)) return false;
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE}=${code}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  if (readCookie() !== code) return false; // cookies blocked: reloading would not change anything
  if (reload && code !== lang) location.reload();
  return true;
}

const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
const SKIP = new Set(['SCRIPT', 'STYLE', 'KBD', 'CODE', 'TEXTAREA']);

/** Translates the static text of a page or fragment in place. Only for markup that ships with the app, never for mail content. */
export function translateDom(root = document.documentElement) {
  if (!DICT) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      for (let p = node.parentNode; p && p !== root.parentNode; p = p.parentNode) {
        if (p.nodeType === 1 && (SKIP.has(p.nodeName) || p.hasAttribute('data-no-i18n'))) return NodeFilter.FILTER_REJECT;
      }
      return node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const raw = node.nodeValue;
    const key = raw.trim().replace(/\s+/g, ' ');
    if (Object.prototype.hasOwnProperty.call(DICT, key)) {
      const lead = raw.match(/^\s*/)[0], trail = raw.match(/\s*$/)[0];
      node.nodeValue = lead + DICT[key] + trail;
    }
  }
  const els = root.querySelectorAll ? root.querySelectorAll(ATTRS.map(a => `[${a}]`).join(',')) : [];
  for (const el of els) {
    if (el.closest('[data-no-i18n]')) continue;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && Object.prototype.hasOwnProperty.call(DICT, v.trim())) el.setAttribute(a, DICT[v.trim()]);
    }
  }
  const meta = document.querySelector('meta[name="description"]');
  if (meta && root === document.documentElement && Object.prototype.hasOwnProperty.call(DICT, meta.content)) meta.content = DICT[meta.content];
}

// Translate the page's own markup as soon as this module loads (before the app starts).
document.documentElement.lang = lang;
translateDom();
document.documentElement.classList.remove('i18n-wait');
