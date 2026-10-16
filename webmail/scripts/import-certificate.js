#!/usr/bin/env node
/**
 * Puts the server's TLS certificate (obtained and renewed by Caddy, see deploy/vps) into the mail
 * engine, so IMAP (993) and SMTP (25/465/587) present the same valid certificate as the website.
 *
 * Why not the engine's own ACME: it always adds the bare domain (iron-id.io) to the order, and that
 * name points at the website host, not this server, so the HTTP check would fail.
 *
 *   ... | node scripts/import-certificate.js --host mail.iron-id.io --stdin [--check]
 *   node scripts/import-certificate.js --host mail.iron-id.io --dir <caddy data folder> [--check]
 *
 * --stdin reads the certificate chain and its private key as PEM (deploy/vps/renew-mail-cert.sh pipes
 * them from the Caddy container, so the app container never holds Caddy's other keys).
 *
 * Exit codes: 0 = already up to date, 3 = certificate created or updated (restart the app so the
 * engine presents it), 1 = error. --check only reports, never writes.
 * Uses the gateway's engine key (its role gets the certificate permissions when it is synced once with
 * the recovery admin). When STALWART_RECOVERY_ADMIN is set, it also makes this certificate the
 * engine's default (for mail servers that connect without saying which name they want).
 * Never prints the private key.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf('--' + name); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null; };
const HOST = String(opt('host') || process.env.MAIL_HOST || '').toLowerCase();
const DIR = String(opt('dir') || '/caddy-data');
const CHECK = !!opt('check');
const STDIN = !!opt('stdin');

function fail(msg) { console.error('import-certificate: ' + msg); process.exit(1); }
if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(HOST)) fail('give the mail host name: --host mail.example.com');

/** Caddy keeps certificates under <data>/caddy/certificates/<issuer>/<host>/<host>.crt|.key. */
function findFiles() {
  const base = path.join(DIR, 'caddy', 'certificates');
  if (!fs.existsSync(base)) fail(`no Caddy certificates under ${base} (is the Caddy volume mounted?)`);
  const found = [];
  for (const issuer of fs.readdirSync(base)) {
    const d = path.join(base, issuer, HOST);
    const crt = path.join(d, HOST + '.crt'), key = path.join(d, HOST + '.key');
    if (fs.existsSync(crt) && fs.existsSync(key)) found.push({ crt, key, mtime: fs.statSync(crt).mtimeMs });
  }
  if (!found.length) fail(`Caddy has no certificate for ${HOST} yet (check: docker compose logs web)`);
  return found.sort((a, b) => b.mtime - a.mtime)[0];
}

function describe(pem) {
  const c = new crypto.X509Certificate(pem);
  return { names: (c.subjectAltName || '').split(',').map(x => x.trim().replace(/^DNS:/, '').toLowerCase()), notAfter: new Date(c.validTo), issuer: c.issuer.replace(/\n/g, ', ') };
}

/** The PEM blocks read from standard input: certificates (in order) and one private key. */
function fromStdin() {
  const text = fs.readFileSync(0, 'utf8');
  const certs = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  const keys = text.match(/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC )?PRIVATE KEY-----/g) || [];
  if (!certs.length) fail('no certificate on standard input');
  if (keys.length !== 1) fail('expected exactly one private key on standard input');
  return { certPem: certs.join('\n') + '\n', keyPem: keys[0] + '\n' };
}

async function main() {
  let certPem, keyPem;
  if (STDIN) ({ certPem, keyPem } = fromStdin());
  else { const files = findFiles(); certPem = fs.readFileSync(files.crt, 'utf8'); keyPem = fs.readFileSync(files.key, 'utf8'); }
  const info = describe(certPem);
  if (!info.names.includes(HOST)) fail(`the certificate found does not cover ${HOST}`);
  if (info.notAfter < new Date()) fail(`Caddy's certificate for ${HOST} has expired (${info.notAfter.toISOString()})`);
  // The private key must belong to the certificate.
  const pub = crypto.createPublicKey(crypto.createPrivateKey(keyPem)).export({ type: 'spki', format: 'der' });
  if (!pub.equals(new crypto.X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' }))) fail('the key file does not match the certificate');

  const engineAdmin = require('../services/engineAdmin');
  const state = await engineAdmin.ensureApiKey();
  if (!['ok', 'provisioned', 'needs_update'].includes(state)) fail(`no engine access (${state})`);
  const call = async calls => engineAdmin.call(calls);
  const got = engineAdmin.firstResult(await call([['x:Certificate/get', { ids: null, properties: ['subjectAlternativeNames', 'notValidAfter'] }, 'g']]), 'g');
  const mine = (got.list || []).filter(c => Object.keys(c.subjectAlternativeNames || {}).map(x => x.toLowerCase()).includes(HOST))
    .sort((a, b) => new Date(b.notValidAfter) - new Date(a.notValidAfter));
  const current = mine[0];
  // Up to date = the engine's certificate for this name ends at the same second (Caddy renews well
  // before the end, so a renewal always changes it). The PEM text is not compared: the engine may
  // return it normalised.
  const same = current && Math.abs(new Date(current.notValidAfter).getTime() - info.notAfter.getTime()) < 1000;
  console.log(`Caddy: ${HOST}, valid until ${info.notAfter.toISOString().slice(0, 10)}, issuer ${info.issuer}`);
  console.log(`Engine: ${current ? `certificate ${current.id}, valid until ${String(current.notValidAfter).slice(0, 10)}` : 'none for this name'}`);

  let changed = false, id = current && current.id;
  if (same) console.log('Up to date.');
  else if (CHECK) console.log('Would ' + (current ? 'update' : 'create') + ' the engine certificate (--check: nothing written).');
  else {
    const value = { certificate: { '@type': 'Text', value: certPem }, privateKey: { '@type': 'Text', secret: keyPem } };
    if (current) {
      engineAdmin.firstResult(await call([['x:Certificate/set', { update: { [current.id]: value } }, 'u']]), 'u');
      console.log(`Updated engine certificate ${current.id}.`);
    } else {
      const made = engineAdmin.firstResult(await call([['x:Certificate/set', { create: { c: value } }, 'c']]), 'c');
      id = made.created.c.id;
      console.log(`Created engine certificate ${id}.`);
    }
    changed = true;
  }

  if (id && process.env.STALWART_RECOVERY_ADMIN && !CHECK) {
    const s = engineAdmin.firstResult(await engineAdmin.asRecovery([['x:SystemSettings/get', { ids: null, properties: ['defaultCertificateId'] }, 's']]), 's');
    const now = s.list && s.list[0] && s.list[0].defaultCertificateId;
    if (now !== id) {
      engineAdmin.firstResult(await engineAdmin.asRecovery([['x:SystemSettings/set', { update: { singleton: { defaultCertificateId: id } } }, 'd']]), 'd');
      console.log('Made it the engine\'s default certificate.');
      changed = true;
    }
  }
  if (changed) console.log('Restart the app so the engine presents it: docker compose restart app');
  process.exit(changed ? 3 : 0);
}

main().catch(e => fail(String(e.message || e).replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, '[pem]')));
