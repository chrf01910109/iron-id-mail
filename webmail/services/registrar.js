/**
 * Domain registrar: checks availability, registers and renews domains bought through IRON ID,
 * and publishes their DNS records (MX, SPF, DKIM, DMARC) on the registrar's DNS service.
 *
 * REGISTRAR=opensrs  OpenSRS reseller API (XCP over HTTPS). Env: OPENSRS_USER, OPENSRS_KEY,
 *                    OPENSRS_ENV=test|live (test = OpenSRS's sandbox "Horizon"). OpenSRS only accepts
 *                    calls from IP addresses added in its control panel ("Add IPs for Script/API Access"):
 *                    the VPS's fixed address, or Railway static outbound IPs.
 *                    NOTE: written from the XCP documentation; check every call in the test environment
 *                    before going live (balance, lookup, register, DNS, renew).
 * REGISTRAR=fake     In-memory stand-in for tests: any name containing "taken" is registered already.
 * unset              Buying domains is unavailable ("not set up yet").
 */
const crypto = require('crypto');
const https = require('https');

class RegistrarError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; this.userError = true; }
}

const kind = () => (['opensrs', 'fake'].includes(process.env.REGISTRAR) ? process.env.REGISTRAR : null);

/* ——— OpenSRS XCP ——— */
const xmlEsc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
function toXml(v) {
  if (Array.isArray(v)) return '<dt_array>' + v.map((x, i) => `<item key="${i}">${toXml(x)}</item>`).join('') + '</dt_array>';
  if (v && typeof v === 'object') return '<dt_assoc>' + Object.entries(v).filter(([, x]) => x !== undefined && x !== null).map(([k, x]) => `<item key="${xmlEsc(k)}">${toXml(x)}</item>`).join('') + '</dt_assoc>';
  return xmlEsc(v);
}
function envelope(body) {
  return "<?xml version='1.0' encoding='UTF-8' standalone='no' ?><!DOCTYPE OPS_envelope SYSTEM 'ops.dtd'><OPS_envelope><header><version>0.9</version></header><body><data_block>"
    + toXml(body) + '</data_block></body></OPS_envelope>';
}

/** Parses OpenSRS's dt_assoc / dt_array / dt_scalar XML into plain objects. */
function parseXml(xml) {
  const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  let i = 0;
  const tokens = [];
  const re = /<(\/?)([a-zA-Z_]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[5] !== undefined) { if (m[5].trim()) tokens.push({ text: unesc(m[5]) }); continue; }
    if (m[2] === 'xml' || m[0].startsWith('<!') || m[0].startsWith('<?')) continue;
    const key = /key="([^"]*)"/.exec(m[3] || '');
    tokens.push({ close: !!m[1], tag: m[2], key: key ? unesc(key[1]) : null, self: !!m[4] });
  }
  function value() { // at a token after <item>
    const t = tokens[i];
    if (!t) return null;
    if (t.text !== undefined) { i++; return t.text; }
    if (!t.close && (t.tag === 'dt_assoc' || t.tag === 'dt_array')) {
      const isArr = t.tag === 'dt_array';
      const out = isArr ? [] : {};
      i++;
      while (tokens[i] && !(tokens[i].close && tokens[i].tag === t.tag)) {
        const it = tokens[i];
        if (!it.close && it.tag === 'item') {
          i++;
          const v = it.self ? '' : (tokens[i] && tokens[i].close && tokens[i].tag === 'item' ? '' : value());
          if (isArr) out[Number(it.key)] = v; else out[it.key] = v;
          while (tokens[i] && !(tokens[i].close && tokens[i].tag === 'item')) i++;
          i++;
        } else i++;
      }
      i++;
      return out;
    }
    if (!t.close && t.tag === 'dt_scalar') { i++; const v = tokens[i] && tokens[i].text !== undefined ? tokens[i++].text : ''; i++; return v; }
    i++;
    return value();
  }
  while (i < tokens.length && !(tokens[i].tag === 'data_block' && !tokens[i].close)) i++;
  i++;
  return value();
}

function opensrsCall(action, object, attributes) {
  const user = process.env.OPENSRS_USER, key = process.env.OPENSRS_KEY;
  if (!user || !key) throw new RegistrarError('Buying domains is not set up yet. Please try again later.', 503);
  const live = process.env.OPENSRS_ENV === 'live';
  const host = live ? 'rr-n1-tor.opensrs.net' : 'horizon.opensrs.net';
  const xml = envelope({ protocol: 'XCP', action, object, attributes });
  const md5 = s => crypto.createHash('md5').update(s).digest('hex');
  const signature = md5(md5(xml + key) + key);
  return new Promise((resolve, reject) => {
    const r = https.request({
      host, port: 55443, path: '/', method: 'POST', timeout: 60000,
      headers: { 'content-type': 'text/xml', 'x-username': user, 'x-signature': signature, 'content-length': Buffer.byteLength(xml) }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(`OpenSRS HTTP ${res.statusCode}`));
        let out;
        try { out = parseXml(text); } catch (e) { return reject(new Error('OpenSRS answer not understood')); }
        if (!out || String(out.is_success) !== '1') return reject(Object.assign(new Error(`OpenSRS ${action}: ${out && out.response_code} ${out && out.response_text}`), { code: out && out.response_code, out }));
        resolve(out);
      });
    });
    r.on('timeout', () => r.destroy(new Error('OpenSRS timeout')));
    r.on('error', reject);
    r.end(xml);
  });
}

const OPENSRS_DNS = ['ns1.systemdns.com', 'ns2.systemdns.com', 'ns3.systemdns.com'];

function contactFor(c) {
  return {
    first_name: c.firstName, last_name: c.lastName, org_name: c.organisation || `${c.firstName} ${c.lastName}`,
    address1: c.address, city: c.city, state: c.region || '', country: c.country, postal_code: c.postalCode,
    phone: c.phone, email: c.email
  };
}

const opensrs = {
  async available(domain) {
    const out = await opensrsCall('LOOKUP', 'DOMAIN', { domain });
    return String((out.attributes || {}).status) === 'available';
  },
  async register(domain, contact) {
    const ct = contactFor(contact);
    const out = await opensrsCall('SW_REGISTER', 'DOMAIN', {
      domain, period: '1', reg_type: 'new', handle: 'process',
      reg_username: 'ironid' + crypto.randomBytes(4).toString('hex'), reg_password: crypto.randomBytes(12).toString('base64url'),
      custom_tech_contact: '0', custom_nameservers: '1',
      nameserver_list: OPENSRS_DNS.map((name, i) => ({ name, sortorder: String(i + 1) })),
      contact_set: { owner: ct, admin: ct, billing: ct, tech: ct },
      f_whois_privacy: '1', f_lock_domain: '1', auto_renew: '0'
    });
    return { ref: String((out.attributes || {}).id || ''), nameservers: OPENSRS_DNS };
  },
  async renew(domain, currentExpiryYear) {
    const out = await opensrsCall('RENEW', 'DOMAIN', { domain, period: '1', currentexpirationyear: String(currentExpiryYear), handle: 'process', auto_renew: '0' });
    return { ref: String((out.attributes || {}).order_id || '') };
  },
  /** records: [{ type, host ('@' or name), value, priority? }] */
  async setDns(domain, records) {
    const zone = { A: [], MX: [], TXT: [], CNAME: [] };
    for (const r of records) {
      const sub = r.host === '@' ? '' : r.host;
      if (r.type === 'MX') zone.MX.push({ subdomain: sub, priority: String(r.priority || 10), hostname: r.value });
      else if (r.type === 'TXT') zone.TXT.push({ subdomain: sub, text: r.value });
      else if (r.type === 'CNAME') zone.CNAME.push({ subdomain: sub, hostname: r.value });
      else if (r.type === 'A') zone.A.push({ subdomain: sub, ip_address: r.value });
    }
    try { await opensrsCall('CREATE_DNS_ZONE', 'DOMAIN', { domain, records: zone }); }
    catch (e) { if (!/exists/i.test(e.message)) throw e; await opensrsCall('SET_DNS_ZONE', 'DOMAIN', { domain, records: zone }); }
  },
  async balance() {
    const out = await opensrsCall('GET_BALANCE', 'BALANCE', {});
    const a = out.attributes || {};
    return { balance: Number(a.balance), holdBalance: Number(a.hold_balance || 0), currency: 'USD' };
  }
};

/* ——— Fake (tests) ——— */
const fakeState = { registered: new Map(), dns: new Map() };
const fake = {
  async available(domain) { return !/taken/.test(domain) && !fakeState.registered.has(domain); },
  async register(domain, contact) {
    if (/fail/.test(domain)) throw new Error('fake registrar refused ' + domain);
    if (!(await fake.available(domain))) throw new RegistrarError('That domain was just registered by someone else.', 409);
    fakeState.registered.set(domain, { contact, at: Date.now() });
    return { ref: 'fake-' + crypto.randomBytes(4).toString('hex'), nameservers: ['ns1.fake-registrar.test', 'ns2.fake-registrar.test'] };
  },
  async renew(domain) { if (!fakeState.registered.has(domain)) throw new Error('not registered here'); return { ref: 'fake-renew' }; },
  async setDns(domain, records) { fakeState.dns.set(domain, records); },
  async balance() { return { balance: 1000, holdBalance: 0, currency: 'USD' }; },
  state: fakeState
};

function impl() {
  const k = kind();
  if (k === 'opensrs') return opensrs;
  if (k === 'fake') return fake;
  throw new RegistrarError('Buying domains is not set up yet. Please try again later.', 503);
}

module.exports = {
  kind,
  available: d => impl().available(d),
  register: (d, c) => impl().register(d, c),
  renew: (d, y) => impl().renew(d, y),
  setDns: (d, r) => impl().setDns(d, r),
  balance: () => impl().balance(),
  fakeState, parseXml, envelope, RegistrarError
};
