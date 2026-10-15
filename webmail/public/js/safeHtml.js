// Safe display of email bodies.
//
// HTML emails are written by strangers. Three layers keep them harmless:
//  1. DOMPurify removes scripts, event handlers, forms, frames, plugins and dangerous links.
//  2. The result is shown in an <iframe sandbox> without "allow-scripts": nothing can run.
//  3. The frame has its own Content-Security-Policy: no network access except pictures from
//     the internet, and those only after the reader asks for them (blocks tracking pixels).
// Plain-text emails are rendered with textContent only.

import DOMPurify from '../vendor/purify.es.mjs';
import { h } from './util.js';
import { t } from './i18n.js';

const FORBID_TAGS = ['form', 'input', 'button', 'select', 'option', 'textarea', 'iframe', 'frame', 'frameset', 'object',
  'embed', 'applet', 'meta', 'link', 'base', 'script', 'noscript', 'template', 'portal', 'dialog', 'audio', 'video', 'source', 'track'];
const FORBID_ATTR = ['action', 'formaction', 'autofocus', 'srcdoc', 'ping', 'srcset', 'xlink:href', 'http-equiv'];
const SAFE_LINK = /^(https?:|mailto:|tel:)/i;
const REMOTE = /^\s*(https?:)?\/\//i;
const REMOTE_CSS = /url\s*\(\s*['"]?\s*(https?:)?\/\//i;

let ctx = null; // set while sanitizing one email

DOMPurify.addHook('uponSanitizeElement', (node, data) => {
  if (!ctx) return;
  if (data.tagName === 'style' && REMOTE_CSS.test(node.textContent || '')) ctx.remote++;
});

DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (!ctx || node.nodeType !== 1) return;
  // Links open in a new tab, never as this site, and only to web/mail/phone addresses.
  if (node.hasAttribute('href')) {
    const href = node.getAttribute('href').trim();
    if (href.startsWith('#')) { node.removeAttribute('href'); }
    else if (!SAFE_LINK.test(href)) { node.removeAttribute('href'); }
    else { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer nofollow'); }
  }
  if (node.hasAttribute('target') && !node.hasAttribute('href')) node.removeAttribute('target');
  // Pictures: attached ones (cid:) become local copies; internet ones wait for permission.
  for (const attr of ['src', 'background', 'poster']) {
    if (!node.hasAttribute(attr)) continue;
    const v = node.getAttribute(attr).trim();
    if (/^cid:/i.test(v)) {
      const url = ctx.cid.get(normCid(v.slice(4)));
      if (url) node.setAttribute(attr, url); else node.removeAttribute(attr);
    } else if (REMOTE.test(v)) {
      ctx.remote++;
      if (!ctx.allowRemote) { node.removeAttribute(attr); if (node.tagName === 'IMG') { node.setAttribute('data-blocked', '1'); } }
      else if (v.startsWith('//')) node.setAttribute(attr, 'https:' + v);
    } else if (/^data:image\/(png|jpe?g|gif|webp|bmp)[;,]/i.test(v)) {
      // embedded picture: fine
    } else {
      node.removeAttribute(attr);
    }
  }
  if (node.hasAttribute('style') && REMOTE_CSS.test(node.getAttribute('style'))) ctx.remote++;
});

export function normCid(c) {
  try { c = decodeURIComponent(c); } catch (e) { /* keep as is */ }
  return String(c || '').trim().replace(/^<|>$/g, '').toLowerCase();
}

/**
 * Cleans an HTML email. Returns { styles, body, remote } where remote is the number of
 * internet resources found (blocked unless allowRemote).
 */
export function sanitizeEmailHtml(html, { cidMap = new Map(), allowRemote = false } = {}) {
  ctx = { cid: cidMap, allowRemote, remote: 0 };
  let root;
  try {
    root = DOMPurify.sanitize(String(html || ''), {
      WHOLE_DOCUMENT: true, RETURN_DOM: true, FORBID_TAGS, FORBID_ATTR,
      ALLOW_DATA_ATTR: false, ALLOW_UNKNOWN_PROTOCOLS: false, ADD_ATTR: ['target'], SANITIZE_NAMED_PROPS: true
    });
  } finally {
    var remote = ctx.remote; // eslint-disable-line no-var
    ctx = null;
  }
  const htmlEl = root.nodeName === 'HTML' ? root : (root.querySelector('html') || root);
  const styleEls = Array.from(htmlEl.querySelectorAll('style'));
  const styles = styleEls.map(s => s.textContent).join('\n');
  styleEls.forEach(s => s.remove());
  const body = htmlEl.querySelector('body') || htmlEl;
  const bodyStyle = body.getAttribute && body.getAttribute('style') || '';
  const bodyBg = body.getAttribute && body.getAttribute('bgcolor') || '';
  return { styles, body: body.innerHTML, bodyStyle, bodyBg, remote };
}

const FRAME_BASE_CSS = `
html{overflow-x:auto}
body{margin:0;padding:0;font:14px/1.6 Inter,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Arabic",sans-serif;color:#1F2937;overflow-wrap:anywhere;word-break:normal}
img{max-width:100%;height:auto}
img[data-blocked]{display:inline-block;min-width:16px;min-height:16px;background:#F3F4F6;outline:1px dashed #D0D5DD}
table{max-width:100%}
pre{white-space:pre-wrap}
blockquote{margin:0 0 0 .8ex;border-left:2px solid #D0D5DD;padding-left:1ex;color:#475467}
a{color:#2457E6}`;

/**
 * Renders cleaned HTML into a sandboxed iframe inside `container`.
 * Returns { frame, remote }.
 */
export function renderHtmlEmail(container, html, { cidMap, allowRemote = false } = {}) {
  const clean = sanitizeEmailHtml(html, { cidMap, allowRemote });
  const csp = `default-src 'none'; img-src data: blob:${allowRemote ? ' https:' : ''}; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'`;
  const esc = s => String(s).replace(/<\/(style)/gi, '<\\/$1');
  const wrapAttrs = [clean.bodyStyle ? `style="${clean.bodyStyle.replace(/"/g, '&quot;')}"` : '', clean.bodyBg && /^#?[\w]+$/.test(clean.bodyBg) ? `bgcolor="${clean.bodyBg}"` : ''].join(' ');
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<meta name="referrer" content="no-referrer">` +
    `<style>${FRAME_BASE_CSS}</style><style>${esc(clean.styles)}</style></head>` +
    `<body><div class="ironid-mail" ${wrapAttrs}>${clean.body}</div></body></html>`;
  const frame = h('iframe', {
    class: 'mail-frame',
    sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox',
    referrerpolicy: 'no-referrer',
    title: t('Message content'),
    scrolling: 'no'
  });
  frame.srcdoc = doc;
  container.replaceChildren(frame);
  const fit = () => {
    try {
      const d = frame.contentDocument;
      if (!d || !d.documentElement) return;
      const hgt = Math.max(d.documentElement.scrollHeight, d.body ? d.body.scrollHeight : 0);
      frame.style.height = Math.min(hgt + 4, 200000) + 'px';
      const wide = d.documentElement.scrollWidth > frame.clientWidth + 4;
      frame.setAttribute('scrolling', wide ? 'auto' : 'no');
    } catch (e) { /* frame gone */ }
  };
  frame.addEventListener('load', () => {
    fit();
    try {
      const d = frame.contentDocument;
      d.addEventListener('load', fit, true); // pictures finishing
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fit).observe(d.body);
      // Middle-click / ctrl-click still open links in a new tab; plain clicks too (target=_blank).
    } catch (e) { /* ignore */ }
  });
  return { frame, remote: clean.remote };
}

/* ——— Plain text ——— */
const URL_RE = /\b(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}])|\b(mailto:[^\s<>"']+)/gi;

function linkify(text) {
  const out = [];
  let last = 0, m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const url = m[0];
    out.push(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer nofollow' }, url));
    last = m.index + url.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Renders a plain-text body; quoted blocks ("> …") are folded away behind a toggle. */
export function renderPlainText(container, text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const root = h('div', { class: 'plain-body', dir: 'auto' });
  let buf = [], quote = [];
  const flushText = () => { if (buf.length) { root.append(...linkify(buf.join('\n') + '\n')); buf = []; } };
  const flushQuote = () => {
    if (!quote.length) return;
    const q = h('div', { class: 'plain-quote hidden' }, ...linkify(quote.join('\n')));
    const tog = h('button', { type: 'button', class: 'quote-toggle', title: t('Show quoted text'), 'aria-expanded': 'false' }, '•••');
    tog.addEventListener('click', () => { const hid = q.classList.toggle('hidden'); tog.setAttribute('aria-expanded', String(!hid)); });
    root.append(tog, q, '\n');
    quote = [];
  };
  for (const line of lines) {
    if (/^\s*>/.test(line)) { flushText(); quote.push(line.replace(/^\s*> ?/, '')); }
    else { if (quote.length && line.trim() === '') { quote.push(''); continue; } flushQuote(); buf.push(line); }
  }
  flushText(); flushQuote();
  container.replaceChildren(root);
}

/** Converts HTML to readable text (for quoting in replies). Never loads anything. */
export function htmlToText(html) {
  const clean = DOMPurify.sanitize(String(html || ''), { RETURN_DOM: true, FORBID_TAGS: [...FORBID_TAGS, 'style', 'img'] });
  const out = [];
  const BLOCK = /^(P|DIV|TR|TABLE|UL|OL|H[1-6]|BLOCKQUOTE|PRE|SECTION|ARTICLE|HEADER|FOOTER|LI|HR)$/;
  const walk = n => {
    if (n.nodeType === 3) { out.push(n.nodeValue.replace(/\s+/g, ' ')); return; }
    if (n.nodeType !== 1) return;
    if (n.tagName === 'BR') { out.push('\n'); return; }
    if (n.tagName === 'LI') out.push('\n- ');
    else if (BLOCK.test(n.tagName)) out.push('\n');
    for (const c of n.childNodes) walk(c);
    if (n.tagName === 'A' && n.getAttribute('href') && /^https?:/i.test(n.getAttribute('href')) && n.textContent.trim() !== n.getAttribute('href')) {
      out.push(` <${n.getAttribute('href')}>`);
    }
    if (BLOCK.test(n.tagName)) out.push('\n');
  };
  walk(clean);
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
