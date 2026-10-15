/**
 * IRON ID — DNS lookups for domain verification and mail-record checks.
 *
 * Uses public DNS-over-HTTPS resolvers (Cloudflare, then Google), falling back to the
 * system resolver. For automated tests, IRONID_DNS_FAKE may point to a JSON file
 * {"name|TYPE": ["value", ...]} that replaces real lookups.
 */
const fs = require('fs');
const dns = require('dns').promises;

const TYPES = { TXT: 16, MX: 15, CNAME: 5, A: 1, NS: 2 };
const FAKE = process.env.IRONID_DNS_FAKE || '';
if (FAKE) console.warn('[dns] IRONID_DNS_FAKE is set: DNS answers come from a test file. Never set this in production.');

function fakeLookup(name, type) {
  try {
    const db = JSON.parse(fs.readFileSync(FAKE, 'utf8'));
    return db[`${name.toLowerCase()}|${type}`] || [];
  } catch (e) { return []; }
}

async function doh(url, name, type) {
  const r = await fetch(`${url}?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(6000)
  });
  if (!r.ok) throw new Error('DoH HTTP ' + r.status);
  const j = await r.json();
  if (j.Status !== 0 && j.Status !== 3) throw new Error('DNS status ' + j.Status);
  return (j.Answer || []).filter(a => a.type === TYPES[type]).map(a => {
    let d = String(a.data || '');
    if (type === 'TXT') d = d.replace(/^"|"$/g, '').replace(/"\s+"/g, ''); // join split TXT strings
    return d.replace(/\.$/, '');
  });
}

/** Returns the record values (TXT strings joined; MX as "10 host"), [] if none. */
async function lookup(name, type) {
  name = String(name).replace(/\.$/, '');
  if (FAKE) return fakeLookup(name, type);
  for (const url of ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve']) {
    try { return await doh(url, name, type); } catch (e) { /* try the next one */ }
  }
  try {
    if (type === 'TXT') return (await dns.resolveTxt(name)).map(parts => parts.join(''));
    if (type === 'MX') return (await dns.resolveMx(name)).map(m => `${m.priority} ${m.exchange}`);
    if (type === 'CNAME') return await dns.resolveCname(name);
    if (type === 'A') return await dns.resolve4(name);
    if (type === 'NS') return await dns.resolveNs(name);
  } catch (e) {
    if (['ENOTFOUND', 'ENODATA', 'ENOTIMP', 'ESERVFAIL'].includes(e.code)) return [];
    throw e;
  }
  return [];
}

const norm = s => String(s || '').replace(/\s+/g, '').replace(/"/g, '').toLowerCase();

/**
 * Checks one expected record. kind:
 *  'txt-exact'  : a TXT value equals `value` (whitespace ignored)
 *  'txt-prefix' : a TXT value starts with `value` (e.g. v=spf1 / v=DMARC1)
 *  'mx'         : an MX points to `value`
 *  'cname'      : a CNAME points to `value`
 * Returns { ok, found: [...] }.
 */
async function check({ name, type, kind, value, contains }) {
  let found;
  try { found = await lookup(name, type); } catch (e) { return { ok: false, found: [], error: 'lookup failed' }; }
  let ok = false;
  if (kind === 'txt-exact') ok = found.some(v => norm(v) === norm(value));
  else if (kind === 'txt-prefix') ok = found.some(v => norm(v).startsWith(norm(value)) && (!contains || norm(v).includes(norm(contains))));
  else if (kind === 'mx') ok = found.some(v => norm(v).endsWith(norm(value).replace(/\.$/, '')));
  else if (kind === 'cname') ok = found.some(v => norm(v) === norm(value).replace(/\.$/, ''));
  return { ok, found };
}

module.exports = { lookup, check };
