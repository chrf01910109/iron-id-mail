/**
 * "Your data" in Settings → Security:
 *   - Download my data: one .tar.gz with every message as an .eml file (by folder), the account's
 *     settings and history as account.json, invoices as HTML, and a short README (EN/FR). Streamed, so
 *     any mailbox size works; one download at a time per mailbox, a few a day.
 *   - Close my account: for accounts people created themselves (sign-up). The account is deleted after
 *     CLOSE_DAYS days; until then the person can sign in and cancel. Deletion removes the mailbox, its
 *     mail, addresses and own domains from the mail server, and the person's settings here. Orders and
 *     invoices are kept (accounting law: 10 years).
 * Mailboxes given by an organisation are closed by its administrator (admin console), never by the
 * person; admins and engine-managed accounts can't close themselves either.
 */
const http = require('http');
const zlib = require('zlib');
const db = require('./db');
const security = require('./accountSecurity');
const sessions = require('./sessionStore');
const adminConsole = require('./adminConsole');

const ENGINE_HOST = process.env.IRONID_ENGINE_HOST || process.env.MAIL_ENGINE_HOST || '127.0.0.1';
const ENGINE_PORT = parseInt(process.env.IRONID_ENGINE_PORT || process.env.MAIL_ENGINE_PORT, 10) || 8080;
const MAIL = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];
const CLOSE_DAYS = 14;
const SYSTEM = { email: 'system', platform: true, customerIds: null, customers: [], ip: null };
const EXPORTS_PER_DAY = 3;

class DataError extends Error {
  constructor(message, status = 400, extra = {}) { super(message); this.status = status; this.userError = true; Object.assign(this, extra); }
}
const fail = (m, s, x) => { throw new DataError(m, s, x); };

/* ——— tar (ustar) writer, streamed into gzip ——— */
function tarHeader(name, size, mtime) {
  const b = Buffer.alloc(512);
  let prefix = '';
  if (Buffer.byteLength(name) > 100) { const i = name.lastIndexOf('/', 154); prefix = name.slice(0, i); name = name.slice(i + 1); }
  b.write(name.slice(0, 100), 0, 'utf8');
  b.write('0000600\0', 100); b.write('0000000\0', 108); b.write('0000000\0', 116);
  b.write(size.toString(8).padStart(11, '0') + '\0', 124);
  b.write(Math.floor(mtime / 1000).toString(8).padStart(11, '0') + '\0', 136);
  b.write('        ', 148); b.write('0', 156); b.write('ustar\0', 257); b.write('00', 263);
  b.write(prefix.slice(0, 155), 345, 'utf8');
  let sum = 0; for (const x of b) sum += x;
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return b;
}
/** Writes one file into the gzip stream, waiting when the client reads slowly. */
async function addFile(gz, name, data, mtime = Date.now()) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const pad = (512 - (buf.length % 512)) % 512;
  for (const part of [tarHeader(name, buf.length, mtime), buf, Buffer.alloc(pad)]) {
    if (part.length && !gz.write(part)) await new Promise(ok => gz.once('drain', ok));
  }
}
const safeName = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ._-]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Folder';

/** The raw message (bytes as stored), with the person's own access. */
function download(auth, accountId, blobId) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: ENGINE_HOST, port: ENGINE_PORT, method: 'GET', timeout: 60000,
      path: `/jmap/download/${encodeURIComponent(accountId)}/${encodeURIComponent(blobId)}/m.eml?accept=message/rfc822`,
      headers: { authorization: auth, host: `${ENGINE_HOST}:${ENGINE_PORT}` } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error('download HTTP ' + res.statusCode)));
    });
    req.on('timeout', () => req.destroy(new Error('download timed out')));
    req.on('error', reject);
    req.end();
  });
}

/* ——— Export ——— */
const running = new Set();
const today = new Map(); // email -> [timestamps]
function exportAllowed(email) {
  if (running.has(email)) fail('A download of your data is already running. Wait for it to finish.', 429);
  const now = Date.now(), list = (today.get(email) || []).filter(t => now - t < 86400e3);
  if (list.length >= EXPORTS_PER_DAY) fail('You can download your data 3 times a day. Please try again tomorrow.', 429);
  list.push(now); today.set(email, list);
  if (today.size > 10000) today.clear();
}

async function accountJson(current, lang) {
  const email = String(current.email).toLowerCase();
  const q = (sql, args) => db.query(sql, args).then(r => r.rows).catch(() => []);
  const [prefs, labels, recovery, signIns, orders, domains] = await Promise.all([
    q('SELECT lang, prefs FROM cp.user_prefs WHERE email = $1', [email]),
    q('SELECT * FROM cp.labels WHERE email = $1', [email]),
    q('SELECT recovery_email, verified_at FROM cp.recovery WHERE email = $1', [email]),
    q(`SELECT at, action, ip, details->>'agent' AS agent FROM cp.audit_log WHERE target = $1 AND action LIKE 'signin.%' ORDER BY at DESC LIMIT 500`, [email]),
    q(`SELECT o.id, o.kind, o.domain, o.status, o.amount_cents, o.amount_ht_cents, o.vat_cents, o.vat_rate, o.currency, o.invoice_number, o.created_at, o.paid_at
         FROM cp.orders o JOIN cp.customers c ON c.id = o.customer_id WHERE c.kind = 'personal' AND c.owner_email = $1 ORDER BY o.id`, [email]),
    q(`SELECT d.domain, d.status, r.expires_at FROM cp.customer_domains d JOIN cp.customers c ON c.id = d.customer_id
         LEFT JOIN cp.registered_domains r ON r.domain = d.domain WHERE c.kind = 'personal' AND c.owner_email = $1`, [email])
  ]);
  return { email, exportedAt: new Date().toISOString(), language: (prefs[0] && prefs[0].lang) || lang || null,
    preferences: (prefs[0] && prefs[0].prefs) || null, labels, recoveryAddress: recovery[0] || null,
    signIns, orders, domains };
}

const README = {
  en: email => `Your IRON ID data — ${email}

Mail/        one folder per mailbox folder; each message is an .eml file (the message exactly as received).
             Open one by double-clicking, or import a folder: Thunderbird (drag the .eml files into a folder,
             or the ImportExportTools NG add-on), Apple Mail (File → Import Mailboxes), Outlook (drag into a folder).
account.json your settings, labels, recovery address, sign-in history, orders and own domains.
Invoices/    your invoices (open in a browser to print or save as PDF).

A message filed under several labels appears once, in its first folder.
`,
  fr: email => `Vos données IRON ID — ${email}

Mail/        un dossier par dossier de la boîte mail ; chaque message est un fichier .eml (le message tel que reçu).
             Ouvrez-le d’un double clic, ou importez un dossier : Thunderbird (glissez les .eml dans un dossier, ou
             l’extension ImportExportTools NG), Apple Mail (Fichier → Importer des boîtes), Outlook (glissez dans un dossier).
account.json vos réglages, libellés, adresse de récupération, historique de connexion, commandes et domaines.
Invoices/    vos factures (ouvrez-les dans un navigateur pour les imprimer ou les enregistrer en PDF).

Un message classé sous plusieurs libellés n’apparaît qu’une fois, dans son premier dossier.
`
};

/**
 * Streams the archive to res. Errors before the first byte are answered as JSON by the caller; after
 * that the archive is cut short and the README says nothing more (the browser shows a failed download).
 */
async function exportData(current, res, { lang, billing }) {
  const email = String(current.email).toLowerCase();
  exportAllowed(email);
  const session = await security.engineSession(current.auth);
  const accountId = session && session.primaryAccounts && session.primaryAccounts['urn:ietf:params:jmap:mail'];
  if (!accountId) fail('Your mailbox could not be read. Please sign in again.', 401);
  const call = calls => security.jmap(current.auth, calls, MAIL);
  const boxes = security.first(await call([['Mailbox/get', { accountId, properties: ['name', 'role', 'parentId'] }, 'm']]), 'm').list || [];
  const byId = new Map(boxes.map(b => [b.id, b]));
  const pathOf = b => { const parts = []; for (let x = b, n = 0; x && n < 10; x = byId.get(x.parentId), n++) parts.unshift(safeName(x.name)); return parts.join('/'); };

  running.add(email);
  const day = new Date().toISOString().slice(0, 10);
  const root = `iron-id-${email.replace(/[^a-z0-9.-]/g, '_')}-${day}`;
  res.writeHead(200, {
    'Content-Type': 'application/gzip',
    'Content-Disposition': `attachment; filename="${root}.tar.gz"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  const gz = zlib.createGzip({ level: 6 });
  gz.pipe(res);
  let aborted = false;
  res.on('close', () => { if (!res.writableFinished) aborted = true; });
  let count = 0;
  try {
    await addFile(gz, `${root}/README.txt`, (README[lang] || README.en)(email));
    const info = await accountJson(current, lang);
    await addFile(gz, `${root}/account.json`, JSON.stringify(info, null, 2));
    if (billing) {
      for (const o of info.orders.filter(x => x.invoice_number)) {
        try {
          const order = await billing.order(o.id);
          await addFile(gz, `${root}/Invoices/${o.invoice_number}.html`, await billing.invoiceHtml(order, lang === 'en' ? 'en' : 'fr'));
        } catch (e) { console.error('[export] invoice', o.id, e.message); }
      }
    }
    const seen = new Set();
    for (const b of boxes) {
      const dir = `${root}/Mail/${pathOf(b)}`;
      for (let position = 0; !aborted; position += 200) {
        const r = await call([
          ['Email/query', { accountId, filter: { inMailbox: b.id }, sort: [{ property: 'receivedAt', isAscending: true }], position, limit: 200 }, 'q'],
          ['Email/get', { accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['blobId', 'receivedAt'] }, 'g']]);
        const list = security.first(r, 'g').list || [];
        for (const m of list) {
          if (aborted) break;
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          const when = new Date(m.receivedAt || Date.now());
          const stamp = when.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
          const raw = await download(current.auth, accountId, m.blobId);
          await addFile(gz, `${dir}/${stamp}-${m.id}.eml`, raw, when.getTime());
          count++;
        }
        if (list.length < 200) break;
      }
      if (aborted) break;
    }
    if (!aborted) await new Promise(ok => gz.end(Buffer.alloc(1024), ok)); // two empty blocks end a tar
    db.audit({ actor: email, action: aborted ? 'account.export_stopped' : 'account.exported', target: email, details: { messages: count } }).catch(() => {});
  } catch (e) {
    console.error('[export]', email, e.message);
    gz.destroy(e);
    res.destroy();
  } finally {
    running.delete(email);
  }
}

/* ——— Closing an account ——— */
/** Why this mailbox can't be closed by its owner (null when it can). */
async function closeProblem(email) {
  const me = String(email).toLowerCase();
  if ((await db.query('SELECT 1 FROM cp.admins WHERE lower(email) = $1', [me])).rows.length) return 'admin';
  const own = await db.query(`SELECT 1 FROM cp.signup_log WHERE lower(email) = $1 AND status = 'created' LIMIT 1`, [me]).catch(() => ({ rows: [] }));
  if (!own.rows.length) return 'organisation';
  const dir = await adminConsole.engineDirectory();
  const a = dir.accounts.find(x => x.email === me && x['@type'] === 'User');
  if (!a) return 'organisation';
  if (adminConsole.protectedReason(a)) return 'protected';
  return null;
}
const REASONS = {
  admin: 'Administrators can’t close their own account here. Ask IRON ID support.',
  organisation: 'This mailbox was given to you by your organisation: ask its administrator to close it.',
  protected: 'This account is managed by IRON ID staff. Ask IRON ID support.'
};

async function closeStatus(email) {
  const me = String(email).toLowerCase();
  const r = await db.query('SELECT requested_at, delete_after FROM cp.account_closures WHERE email = $1', [me]);
  const problem = r.rows.length ? null : await closeProblem(me);
  return { canClose: !problem, problem: problem ? REASONS[problem] : null, closeDays: CLOSE_DAYS,
    scheduled: r.rows.length ? { requestedAt: r.rows[0].requested_at, deleteAfter: r.rows[0].delete_after } : null };
}

async function requestClose(current, { ip, lang, keepSession }) {
  const me = String(current.email).toLowerCase();
  const problem = await closeProblem(me);
  if (problem) fail(REASONS[problem], 403);
  await db.query(`INSERT INTO cp.account_closures (email, requested_at, delete_after, ip, lang)
                  VALUES ($1, NOW(), NOW() + make_interval(days => $2), $3, $4) ON CONFLICT (email) DO NOTHING`, [me, CLOSE_DAYS, ip, lang || null]);
  // Every other browser is signed out; this one stays to show the notice and allow cancelling.
  await sessions.destroySessionsFor(me, { except: keepSession }).catch(e => console.error('[close] sessions:', e.message));
  db.audit({ actor: me, action: 'account.close_requested', target: me, ip }).catch(() => {});
  return closeStatus(me);
}

async function cancelClose(current, { ip }) {
  const me = String(current.email).toLowerCase();
  const r = await db.query('DELETE FROM cp.account_closures WHERE email = $1', [me]);
  if (r.rowCount) db.audit({ actor: me, action: 'account.close_cancelled', target: me, ip }).catch(() => {});
  return closeStatus(me);
}

/** Deletes one account now (the closing date has passed). */
async function deleteAccount(email) {
  const me = String(email).toLowerCase();
  const problem = await closeProblem(me);
  if (problem) { // became an admin or similar meanwhile: keep it, tell staff through the log
    await db.query('DELETE FROM cp.account_closures WHERE email = $1', [me]);
    db.audit({ actor: 'system', action: 'account.close_refused', target: me, details: { reason: problem } }).catch(() => {});
    return false;
  }
  const dir = await adminConsole.engineDirectory();
  const a = dir.accounts.find(x => x.email === me && x['@type'] === 'User');
  const cust = (await db.query(`SELECT id FROM cp.customers WHERE kind = 'personal' AND owner_email = $1`, [me])).rows[0];
  // 1. The mailbox (its mail and its addresses on own domains go with it).
  if (a) await adminConsole.engineSet('Account', { destroy: [a.id] }, 'delete the mailbox');
  await adminConsole.signOutEverywhere(me);
  await adminConsole.forgetRecovery(me);
  // 2. Own domains: off the mail server (a bought domain stays the person's at the registrar).
  if (cust) {
    const doms = (await db.query('SELECT domain FROM cp.customer_domains WHERE customer_id = $1', [cust.id])).rows;
    for (const d of doms) {
      try { await adminConsole.runRoute(SYSTEM, 'POST', '/admin-api/domains/remove', { domain: d.domain, confirm: d.domain }); }
      catch (e) { console.error('[close] domain', d.domain, e.message); }
    }
    await db.query(`UPDATE cp.registered_domains SET status = 'released' WHERE customer_id = $1`, [cust.id]).catch(() => {});
    await db.query(`UPDATE cp.orders SET status = 'cancelled' WHERE customer_id = $1 AND status = 'pending'`, [cust.id]).catch(() => {});
    await db.query('DELETE FROM cp.migrations WHERE lower(email) = $1', [me]).catch(() => {});
  }
  // 3. Settings here. Orders/invoices and the audit log stay (legal obligations).
  for (const t of ['cp.labels', 'cp.user_prefs']) await db.query(`DELETE FROM ${t} WHERE email = $1`, [me]).catch(() => {});
  await db.query('DELETE FROM cp.account_closures WHERE email = $1', [me]);
  adminConsole.forgetOwners();
  db.audit({ actor: 'system', action: 'account.closed', target: me }).catch(() => {});
  return true;
}

/** Hourly: deletes the accounts whose closing date has passed. */
async function runClosures() {
  try {
    const due = (await db.query('SELECT email FROM cp.account_closures WHERE delete_after <= NOW() ORDER BY delete_after LIMIT 50')).rows;
    for (const r of due) {
      try { await deleteAccount(r.email); } catch (e) { console.error('[close] could not delete', r.email + ':', e.message); }
    }
  } catch (e) { console.error('[close] check failed:', e.message); }
}

module.exports = { exportData, closeStatus, requestClose, cancelClose, deleteAccount, runClosures, DataError, CLOSE_DAYS, tarHeader };
