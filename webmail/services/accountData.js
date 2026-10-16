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
const { ACCOUNT_CLOSED } = require('./billing');

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
function tarHeader(name, size, mtime, type = '0') {
  const b = Buffer.alloc(512);
  b.write(name, 0, 100, 'utf8');
  b.write('0000600\0', 100); b.write('0000000\0', 108); b.write('0000000\0', 116);
  b.write(size.toString(8).padStart(11, '0') + '\0', 124);
  b.write(Math.floor(mtime / 1000).toString(8).padStart(11, '0') + '\0', 136);
  b.write('        ', 148); b.write(type, 156); b.write('ustar\0', 257); b.write('00', 263);
  let sum = 0; for (const x of b) sum += x;
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return b;
}
/** A PAX record "<len> path=<name>\n" (the length counts itself). */
function paxPath(name) {
  const body = ` path=${name}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(String(len) + body) !== len) len = Buffer.byteLength(String(len) + body);
  return Buffer.from(String(len) + body, 'utf8');
}
const pad512 = n => Buffer.alloc((512 - (n % 512)) % 512);
/** Headers for one file: a PAX header first when the name doesn't fit ustar's 100 bytes (or isn't ASCII). */
function tarHeaders(name, size, mtime) {
  if (Buffer.byteLength(name) <= 100 && /^[\x20-\x7e]*$/.test(name)) return [tarHeader(name, size, mtime)];
  const pax = paxPath(name);
  const short = Buffer.from(name.replace(/[^\x20-\x7e]/g, '_')).subarray(-100).toString('latin1');
  return [tarHeader('PaxHeader/' + short.slice(-90), pax.length, mtime, 'x'), pax, pad512(pax.length), tarHeader(short, size, mtime)];
}
class Stopped extends Error {}
/** Writes one file into the gzip stream, waiting when the client reads slowly; stops when it went away. */
async function addFile(gz, name, data, mtime = Date.now()) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  for (const part of [...tarHeaders(name, buf.length, mtime), buf, pad512(buf.length)]) {
    if (gz.destroyed) throw new Stopped();
    if (part.length && !gz.write(part)) {
      await new Promise(ok => {
        const done = () => { gz.off('drain', done); gz.off('close', done); gz.off('error', done); ok(); };
        gz.on('drain', done); gz.on('close', done); gz.on('error', done);
      });
    }
  }
}
/** A folder name usable on any computer: letters of any language kept; never "." or "..". */
const safeName = s => {
  // Cut to 40 characters, then no space or dot at the end (Windows can't open such folders).
  const clean = Array.from(String(s || '').normalize('NFC').replace(/[^\p{L}\p{M}\p{N} ._-]+/gu, '_').replace(/\s+/g, ' ').trim()).slice(0, 40).join('').replace(/[ .]+$/, '');
  return !clean ? 'Folder' : /^\./.test(clean) ? '_' + clean.slice(1) : clean;
};

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
function exportAllowed(email, { record = true } = {}) {
  if (running.has(email)) fail('A download of your data is already running. Wait for it to finish.', 429);
  const now = Date.now(), list = (today.get(email) || []).filter(t => now - t < 86400e3);
  if (list.length >= EXPORTS_PER_DAY) fail('You can download your data 3 times a day. Please try again tomorrow.', 429);
  if (!record) return;
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
Invoices/    your invoices and credit notes (open in a browser to print or save as PDF).

A message filed under several labels appears once, in its first folder.
`,
  fr: email => `Vos données IRON ID — ${email}

Mail/        un dossier par dossier de la boîte mail ; chaque message est un fichier .eml (le message tel que reçu).
             Ouvrez-le d’un double clic, ou importez un dossier : Thunderbird (glissez les .eml dans un dossier, ou
             l’extension ImportExportTools NG), Apple Mail (Fichier → Importer des boîtes), Outlook (glissez dans un dossier).
account.json vos réglages, libellés, adresse de récupération, historique de connexion, commandes et domaines.
Invoices/    vos factures et avoirs (ouvrez-les dans un navigateur pour les imprimer ou les enregistrer en PDF).

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
  // The browser cancelled or lost the connection: stop reading mail and free this download's place.
  res.on('close', () => { if (!res.writableFinished) { aborted = true; gz.destroy(); } });
  let count = 0;
  try {
    await addFile(gz, `${root}/README.txt`, (README[lang] || README.en)(email));
    const info = await accountJson(current, lang);
    await addFile(gz, `${root}/account.json`, JSON.stringify(info, null, 2));
    if (billing) {
      const docLang = lang === 'en' ? 'en' : 'fr';
      const invoiced = info.orders.filter(x => x.invoice_number);
      const credits = await billing.creditsFor(invoiced.map(x => x.id)).catch(() => new Map());
      for (const o of invoiced) {
        let order;
        try {
          order = await billing.order(o.id);
          await addFile(gz, `${root}/Invoices/${o.invoice_number}.html`, await billing.invoiceHtml(order, docLang));
          for (const c of credits.get(Number(o.id)) || []) {
            await addFile(gz, `${root}/Invoices/${c.number}.html`, await billing.creditNoteHtml(c, order, docLang));
          }
        } catch (e) { if (e instanceof Stopped) throw e; console.error('[export] invoice', o.id, e.message); }
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
    if (!aborted) await new Promise(ok => { gz.once('close', ok); gz.end(Buffer.alloc(1024), ok); }); // two empty blocks end a tar
    db.audit({ actor: email, action: aborted ? 'account.export_stopped' : 'account.exported', target: email, details: { messages: count } }).catch(() => {});
  } catch (e) {
    if (e instanceof Stopped || aborted) db.audit({ actor: email, action: 'account.export_stopped', target: email, details: { messages: count } }).catch(() => {});
    else console.error('[export]', email, e.message);
    gz.destroy();
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
/** Only whether a closing is scheduled (asked on every page load: no look at the mail server). */
async function closingFor(email) {
  const r = await db.query('SELECT requested_at, delete_after FROM cp.account_closures WHERE email = $1', [String(email).toLowerCase()]);
  return r.rows.length ? { requestedAt: r.rows[0].requested_at, deleteAfter: r.rows[0].delete_after } : null;
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
  // Not while a deletion run is working on it, nor once the mailbox is gone.
  const r = await db.query(`DELETE FROM cp.account_closures WHERE email = $1 AND mailbox_deleted_at IS NULL
                              AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL '1 hour')`, [me]);
  if (r.rowCount) db.audit({ actor: me, action: 'account.close_cancelled', target: me, ip }).catch(() => {});
  else if ((await db.query('SELECT 1 FROM cp.account_closures WHERE email = $1', [me])).rows.length) {
    fail('Your account is being deleted now; this can no longer be cancelled.', 409);
  }
  return closeStatus(me);
}

/**
 * Deletes one account whose closing date has passed. The caller holds the claim on its row. Every
 * step can run again: if one fails, the next run continues where this one stopped.
 */
async function deleteAccount(email) {
  const me = String(email).toLowerCase();
  const row = (await db.query('SELECT * FROM cp.account_closures WHERE email = $1', [me])).rows[0];
  if (!row) return false; // cancelled meanwhile
  const dir = await adminConsole.engineDirectory();
  const a = dir.accounts.find(x => x.email === me && x['@type'] === 'User');
  if (!row.mailbox_deleted_at) {
    const problem = await closeProblem(me);
    if (problem) { // became an admin or similar meanwhile: keep it, tell staff through the log
      await db.query('DELETE FROM cp.account_closures WHERE email = $1', [me]);
      db.audit({ actor: 'system', action: 'account.close_refused', target: me, details: { reason: problem } }).catch(() => {});
      return false;
    }
    // 1. Its addresses are never given out again (first, so there is no moment when they are free).
    const addresses = [me, ...(a ? adminConsole.aliasEmails(a, dir.domainById) : [])];
    for (const x of addresses) {
      await db.query(`INSERT INTO cp.retired_addresses (email, reason) VALUES ($1, 'account closed') ON CONFLICT (email) DO NOTHING`, [String(x).toLowerCase()]);
    }
    // 2. The mailbox (its mail and its addresses on own domains go with it).
    if (a) await adminConsole.engineSet('Account', { destroy: [a.id] }, 'delete the mailbox');
    await db.query('UPDATE cp.account_closures SET mailbox_deleted_at = NOW() WHERE email = $1', [me]);
  } else if (a) {
    await adminConsole.engineSet('Account', { destroy: [a.id] }, 'delete the mailbox');
  }
  await adminConsole.signOutEverywhere(me);
  await adminConsole.forgetRecovery(me);
  // 3. Own domains: off the mail server (a bought domain stays the person's at the registrar).
  const cust = (await db.query(`SELECT id FROM cp.customers WHERE kind = 'personal' AND owner_email = $1`, [me])).rows[0];
  if (cust) {
    const doms = (await db.query('SELECT domain FROM cp.customer_domains WHERE customer_id = $1', [cust.id])).rows;
    for (const d of doms) {
      try { await adminConsole.runRoute(SYSTEM, 'POST', '/admin-api/domains/remove', { domain: d.domain, confirm: d.domain }); }
      catch (e) { console.error('[close] domain', d.domain, e.message); }
    }
    await db.query(`UPDATE cp.registered_domains SET status = 'released' WHERE customer_id = $1`, [cust.id]);
    // A checkout still open in a browser tab: paying it later is refused (billing.markPaid).
    await db.query(`UPDATE cp.orders SET status = 'cancelled', error = $2 WHERE customer_id = $1 AND status = 'pending'`, [cust.id, ACCOUNT_CLOSED]);
    await db.query(`UPDATE cp.orders SET error = $2 WHERE customer_id = $1 AND status = 'cancelled' AND error IS NULL`, [cust.id, ACCOUNT_CLOSED]);
  }
  await db.query('DELETE FROM cp.migrations WHERE lower(email) = $1', [me]);
  // 4. Settings here. Orders/invoices and the audit log stay (legal obligations).
  await db.query('DELETE FROM cp.labels WHERE email = $1', [me]);
  await db.query('DELETE FROM cp.user_prefs WHERE email = $1', [me]);
  await db.query('DELETE FROM cp.account_closures WHERE email = $1', [me]);
  adminConsole.forgetOwners();
  db.audit({ actor: 'system', action: 'account.closed', target: me }).catch(() => {});
  return true;
}

/** Hourly: deletes the accounts whose closing date has passed, one claimed row at a time. */
let closing = false;
async function runClosures() {
  if (closing) return; // the previous run is still working
  closing = true;
  try {
    for (let n = 0; n < 50; n++) {
      // The claim: no other run (another instance during a deploy) and no cancel can take this row now.
      const r = await db.query(`UPDATE cp.account_closures SET claimed_at = NOW() WHERE email = (
                                  SELECT email FROM cp.account_closures WHERE delete_after <= NOW()
                                     AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL '1 hour')
                                   ORDER BY delete_after LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING email`);
      if (!r.rows.length) break;
      try { await deleteAccount(r.rows[0].email); } catch (e) { console.error('[close] could not delete', r.rows[0].email + ':', e.message); }
    }
  } catch (e) { console.error('[close] check failed:', e.message); }
  finally { closing = false; }
}

/** Asked by Settings before starting the download, so a refusal shows as a message, not a saved file. */
const exportCheck = email => { exportAllowed(String(email).toLowerCase(), { record: false }); return { ok: true }; };

module.exports = { exportData, exportCheck, closeStatus, closingFor, requestClose, cancelClose, deleteAccount, runClosures, DataError, CLOSE_DAYS, tarHeader, addFile, safeName };
