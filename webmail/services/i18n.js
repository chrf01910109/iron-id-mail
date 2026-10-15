/**
 * English and French for the gateway's own messages (errors shown to people).
 *
 * Messages are written in English in the code. The French text lives in i18n-fr.js, keyed by
 * the English text. Keys may contain {placeholders} for parts that change ("You can have up
 * to {n} labels."): the English message is matched against the key and the parts carried over.
 *
 * The language of a request: the `ironid_lang` cookie (set from the account's saved choice at
 * sign-in), else the browser's Accept-Language, else English.
 */
const FR = require('./i18n-fr');

const SUPPORTED = ['en', 'fr'];
const COOKIE = 'ironid_lang';
const ONE_YEAR = 365 * 24 * 3600;

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function fromAcceptLanguage(header) {
  const tags = String(header || '').split(',').map(p => {
    const [tag, ...params] = p.trim().split(';');
    const q = params.map(x => x.trim()).find(x => x.startsWith('q='));
    return { code: tag.slice(0, 2).toLowerCase(), q: q ? parseFloat(q.slice(2)) || 0 : 1 };
  }).filter(x => x.code && x.q > 0).sort((a, b) => b.q - a.q);
  const hit = tags.find(x => SUPPORTED.includes(x.code));
  return hit ? hit.code : null;
}

/** The language for this request: 'en' or 'fr'. */
function langFrom(req) {
  const c = cookieValue(req.headers.cookie, COOKIE);
  if (c && SUPPORTED.includes(c)) return c;
  return fromAcceptLanguage(req.headers['accept-language']) || 'en';
}

function validLang(v) {
  return SUPPORTED.includes(v) ? v : null;
}

function langCookie(req, code) {
  const https = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  // Not HttpOnly: the page reads it to pick its language before anyone signs in.
  return [`${COOKIE}=${code}`, 'Path=/', `Max-Age=${ONE_YEAR}`, 'SameSite=Lax'].concat(https ? ['Secure'] : []).join('; ');
}

// Keys with {placeholders} become patterns, built once.
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TEMPLATES = Object.keys(FR).filter(k => /\{\w+\}/.test(k)).map(key => {
  const names = [];
  const re = new RegExp('^' + key.split(/(\{\w+\})/).map(part => {
    const m = /^\{(\w+)\}$/.exec(part);
    if (m) { names.push(m[1]); return '([\\s\\S]+?)'; }
    return escapeRe(part);
  }).join('') + '$');
  return { re, names, fr: FR[key] };
});

/** Translates one English message into `lang`. Unknown messages stay as they are. */
function translate(lang, msg) {
  if (lang !== 'fr' || typeof msg !== 'string' || !msg) return msg;
  if (Object.prototype.hasOwnProperty.call(FR, msg)) return FR[msg];
  for (const tpl of TEMPLATES) {
    const m = tpl.re.exec(msg);
    if (m) {
      const vals = {};
      tpl.names.forEach((n, i) => { vals[n] = m[i + 1]; });
      return tpl.fr.replace(/\{(\w+)\}/g, (all, n) => (n in vals ? vals[n] : all));
    }
  }
  return msg;
}

// Fields of a JSON answer that carry the gateway's own English text for people (never mail
// data): error messages, and the admin console's DNS checks and account notes.
const MESSAGE_FIELDS = new Set(['error', 'problem', 'purpose', 'warnings', 'protected']);

/** A copy of a JSON answer with its message fields in `lang`. Other fields are left alone. */
function translateMessages(lang, value, depth = 0) {
  if (lang === 'en' || depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => translateMessages(lang, v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (MESSAGE_FIELDS.has(k) && typeof v === 'string') out[k] = translate(lang, v);
    else if (MESSAGE_FIELDS.has(k) && Array.isArray(v)) out[k] = v.map(x => (typeof x === 'string' ? translate(lang, x) : x));
    else out[k] = translateMessages(lang, v, depth + 1);
  }
  return out;
}

/** The page markup with <html lang> set, and the page hidden until its text is translated (a CSS fallback shows it after 3 s regardless). */
function htmlFor(html, lang) {
  const cls = lang === 'en' ? '' : ' class="i18n-wait"';
  return html.replace(/<html lang="[a-z]{2}"[^>]*>/, `<html lang="${lang}"${cls}>`);
}

module.exports = { SUPPORTED, COOKIE, langFrom, validLang, langCookie, translate, translateMessages, htmlFor, FR };
