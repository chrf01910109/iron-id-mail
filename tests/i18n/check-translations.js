#!/usr/bin/env node
/**
 * Checks that every piece of text people see has a French translation.
 *
 *   node tests/i18n/check-translations.js            # everything; exit 1 if anything is missing
 *   node tests/i18n/check-translations.js --verbose  # also list unused French entries
 *
 * What it reads (no browser, no server needed):
 *   - webmail/public/js/**  : the first argument of t('…'), both arguments of tn('…', '…', n),
 *     and tx('context', '…') (French key "context|…")
 *   - webmail/public/index.html, admin.html : text and the placeholder/title/aria-label/alt
 *     attributes, exactly what i18n.js translates when the page loads
 *   - webmail/server.js, webmail/services/*.js : messages sent to people
 *     (error: '…', problem: '…', purpose: '…', warnings.push('…'), fail('…'), new LabelError('…'),
 *     new UserError('…'), new Error('…') marked userError; 'a' + x + 'b' is read as "a{}b")
 * and the French in webmail/public/js/i18n/fr/*.js and webmail/services/i18n-fr.js.
 *
 * Also checks that each French entry keeps the same {placeholders} as its English key.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const WEB = path.join(ROOT, 'webmail');
const PUB = path.join(WEB, 'public');
const verbose = process.argv.includes('--verbose');

// Text that is the same in both languages (brand, symbols, examples, technical names).
const SAME = new Set([
  'IRON ID', 'ID', 'MAIL', 'ADMIN', 'IRON ID Mail', 'IRON ID Admin', 'OK', 'IMAP', 'SMTP', 'SSL', 'DKIM', 'SPF', 'DMARC', 'MX', 'TXT', 'CNAME',
  'Google Authenticator', 'Microsoft Authenticator', 'Outlook', 'Apple Mail', 'Cc', 'Bcc', 'Email'
]);
const hasWords = s => /[A-Za-z]{2,}/.test(s);

/* ——— Load the dictionaries ——— */
async function loadClientFr() {
  const url = 'file://' + path.join(PUB, 'js/i18n/fr/index.js');
  const mod = await import(url);
  return mod.default;
}
const serverFr = require(path.join(WEB, 'services/i18n-fr.js'));

/* ——— JS string literal reader ——— */
function readString(src, i) {
  const q = src[i];
  if (q !== "'" && q !== '"' && q !== '`') return null;
  let out = '';
  let j = i + 1;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') {
      const n = src[++j];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'u' ? String.fromCharCode(parseInt(src.slice(j + 1, j + 5), 16)) + ((j += 4), '') : n;
      continue;
    }
    if (q === '`' && c === '$' && src[j + 1] === '{') {
      let depth = 0; j++;
      for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
      out += '{}';
      continue;
    }
    if (c === q) return { value: out, end: j + 1, template: q === '`' };
    out += c;
  }
  return null;
}
const skipWs = (src, i) => { while (/\s/.test(src[i] || '')) i++; return i; };

function listFiles(dir, filter, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['i18n', 'vendor', 'node_modules'].includes(e.name)) listFiles(p, filter, out); }
    else if (filter(p)) out.push(p);
  }
  return out;
}

/* ——— Client JS: t('…') and tn('…', '…', n) ——— */
function clientMessages() {
  const found = []; // { msg, where }
  const dynamic = [];
  for (const file of listFiles(path.join(PUB, 'js'), p => p.endsWith('.js'))) {
    if (file.endsWith(path.join('js', 'i18n.js'))) continue;
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    const re = /(^|[^\w$.])(tn|tx|t)\(/g;
    let m;
    while ((m = re.exec(src))) {
      const fn = m[2];
      let i = skipWs(src, m.index + m[0].length);
      const line = src.slice(0, m.index).split('\n').length;
      let a = readString(src, i);
      if (a && fn === 'tx') {
        const ctx = a.value;
        i = skipWs(src, a.end);
        a = src[i] === ',' ? readString(src, skipWs(src, i + 1)) : null;
        if (a) { found.push({ msg: ctx + '|' + a.value, where: `${rel}:${src.slice(0, m.index).split('\n').length}`, fallback: a.value }); continue; }
      }
      if (!a) { dynamic.push(`${rel}:${line} ${fn}(${src.slice(i, i + 30).split('\n')[0]}…)`); continue; }
      if (a.template && a.value.includes('{}')) dynamic.push(`${rel}:${line} ${fn}() with \${…} — use {placeholders}`);
      found.push({ msg: a.value, where: `${rel}:${line}` });
      if (fn === 'tn') {
        i = skipWs(src, a.end);
        if (src[i] === ',') {
          const b = readString(src, skipWs(src, i + 1));
          if (b) found.push({ msg: b.value, where: `${rel}:${line}` });
          else dynamic.push(`${rel}:${line} tn() second form is not a plain string`);
        }
      }
    }
  }
  return { found, dynamic };
}

/* ——— HTML: same rules as translateDom() in i18n.js ——— */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'path', 'circle', 'line', 'polyline', 'rect']);
const SKIP_TAGS = new Set(['script', 'style', 'kbd', 'code', 'textarea']);
const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
const decode = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&rarr;/g, '→').replace(/&hellip;/g, '…');

function htmlMessages(file) {
  const src = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[^>]*>/i, '');
  const rel = path.relative(ROOT, file);
  const found = [];
  const stack = []; // { tag, skip }
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  let last = 0, m;
  const skipping = () => stack.some(s => s.skip);
  const pushText = (text, at) => {
    const v = decode(text).trim().replace(/\s+/g, ' ');
    if (v && !skipping()) found.push({ msg: v, where: `${rel}:${src.slice(0, at).split('\n').length}` });
  };
  while ((m = tagRe.exec(src))) {
    pushText(src.slice(last, m.index), m.index);
    last = tagRe.lastIndex;
    const [, close, rawTag, attrs, selfClose] = m;
    const tag = rawTag.toLowerCase();
    if (close) {
      const k = stack.map(s => s.tag).lastIndexOf(tag);
      if (k >= 0) stack.length = k;
      continue;
    }
    const attrMap = {};
    attrs.replace(/([^\s=]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g, (all, name, _v, d, s1, bare) => { attrMap[name.toLowerCase()] = decode(d ?? s1 ?? bare ?? ''); return ''; });
    const skip = SKIP_TAGS.has(tag) || 'data-no-i18n' in attrMap;
    if (!skip && !skipping()) {
      for (const a of ATTRS) if (attrMap[a] && attrMap[a].trim()) found.push({ msg: attrMap[a].trim(), where: `${rel} [${a}]` });
      if (tag === 'meta' && attrMap.name === 'description') found.push({ msg: attrMap.content, where: `${rel} <meta description>` });
    }
    if (!VOID.has(tag) && !selfClose) {
      stack.push({ tag, skip });
      if (tag === 'script' || tag === 'style') {
        const endIdx = src.indexOf('</' + tag, tagRe.lastIndex);
        tagRe.lastIndex = last = endIdx < 0 ? src.length : endIdx;
      }
    }
  }
  return found;
}

/* ——— Server messages ——— */
// Reads 'a' + x + 'b' (string concatenation) as "a{}b".
function readJoined(src, i) {
  const first = readString(src, i);
  if (!first) return null;
  let value = first.value, end = first.end;
  for (;;) {
    let j = skipWs(src, end);
    if (src[j] !== '+') break;
    j = skipWs(src, j + 1);
    const next = readString(src, j);
    if (next) { value += next.value; end = next.end; continue; }
    const expr = /^[\w$.]+(?:\([^()]*\))?/.exec(src.slice(j));
    if (!expr) break;
    value += '{}'; end = j + expr[0].length;
  }
  return { value, end };
}
function serverMessages() {
  const files = [path.join(WEB, 'server.js'), ...fs.readdirSync(path.join(WEB, 'services')).filter(f => f.endsWith('.js') && !f.startsWith('i18n')).map(f => path.join(WEB, 'services', f))];
  const found = [];
  const patterns = [
    { re: /[{,]\s*(?:error|problem|purpose):\s*(?=['"`])/g },
    { re: /\b(?:problem|purpose):\s*[^,'"`}]{1,80}\?\s*(?=['"`])/g },
    { re: /warnings\.push\(\s*(?=['"`])/g },
    { re: /\bfail\(\s*(?=['"`])/g },
    { re: /\bnew (?:LabelError|UserError)\(\s*(?=['"`])/g },
    { re: /new Error\(\s*(?=['"`])/g, userErrorOnly: true }
  ];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    for (const { re, userErrorOnly } of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        const s = readJoined(src, m.index + m[0].length);
        if (!s) continue;
        if (userErrorOnly && !/^\s*\)\s*,\s*\{[^}]*userError\s*:\s*true/.test(src.slice(s.end, s.end + 200))) continue;
        found.push({ msg: s.value, where: `${rel}:${src.slice(0, m.index).split('\n').length}` });
      }
    }
  }
  return found;
}

/* ——— Compare ——— */
const norm = s => s.replace(/\{\w*\}/g, '{}');
const placeholders = s => (s.match(/\{\w+\}/g) || []).sort().join(',');

function check(label, items, dict) {
  const keysByNorm = new Map(Object.keys(dict).map(k => [norm(k), k]));
  const missing = [];
  const used = new Set();
  for (const { msg, where, fallback } of items) {
    if (!hasWords(msg) || SAME.has(msg) || (fallback && SAME.has(fallback))) continue;
    if (fallback && !Object.prototype.hasOwnProperty.call(dict, msg) && Object.prototype.hasOwnProperty.call(dict, fallback)) { used.add(fallback); continue; }
    if (Object.prototype.hasOwnProperty.call(dict, msg)) { used.add(msg); continue; }
    const k = keysByNorm.get(norm(msg));
    if (k) { used.add(k); continue; }
    missing.push(`  ${where}  ${JSON.stringify(msg)}`);
  }
  const bad = [];
  for (const [k, v] of Object.entries(dict)) {
    if (typeof v !== 'string' || !v.trim()) bad.push(`  ${JSON.stringify(k)} has no French text`);
    else if (placeholders(k) !== placeholders(v)) bad.push(`  ${JSON.stringify(k)} → ${JSON.stringify(v)}: placeholders differ`);
  }
  return { missing: [...new Set(missing)], bad, used };
}

(async () => {
  const clientFr = await loadClientFr();
  const { found: jsFound, dynamic } = clientMessages();
  const htmlFound = ['index.html', 'admin.html'].flatMap(f => htmlMessages(path.join(PUB, f)));
  const client = check('client', [...jsFound, ...htmlFound], clientFr);
  const server = check('server', serverMessages(), serverFr);

  let failed = false;
  const section = (title, lines) => { if (lines.length) { failed = true; console.log(`\n${title} (${lines.length}):\n${lines.join('\n')}`); } };
  section('Webmail and admin text without French', client.missing);
  section('Gateway messages without French', server.missing);
  section('French entries with problems', [...client.bad, ...server.bad]);
  if (dynamic.length) console.log(`\nt()/tn() calls the check cannot read (make sure their text is translated another way) (${dynamic.length}):\n  ${dynamic.join('\n  ')}`);
  if (verbose) {
    const unusedC = Object.keys(clientFr).filter(k => !client.used.has(k));
    const unusedS = Object.keys(serverFr).filter(k => !server.used.has(k));
    console.log(`\nUnused French entries: ${unusedC.length} webmail/admin, ${unusedS.length} gateway`);
    unusedC.concat(unusedS).forEach(k => console.log('  ' + JSON.stringify(k)));
  }
  const total = jsFound.length + htmlFound.length;
  console.log(`\n${failed ? 'FAIL' : 'OK'}: ${total} webmail/admin texts, ${Object.keys(clientFr).length} French entries; gateway ${Object.keys(serverFr).length} French entries.`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
