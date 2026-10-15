/**
 * Copies a person's old mailbox (any provider that offers IMAP: Gmail, Outlook, OVH, Orange…) into their
 * IRON ID mailbox. Part of the €2 own-domain service.
 *
 * - The old password (or app password) is encrypted (secretBox) and erased when the copy ends.
 * - Only public internet servers on port 993 (TLS) or 143 (STARTTLS) are contacted, and the address is
 *   pinned after the check, so the feature can't be used to reach IRON ID's private network.
 * - Folders keep their names (Inbox, Sent, Drafts, Junk, Trash, Archive go to the matching IRON ID folder),
 *   messages keep their date, read and starred state. A copy that stops (restart) resumes where it was.
 * - IRONID_MIGRATION_TEST=true allows private addresses and test certificates — tests only.
 */
const dns = require('dns').promises;
const net = require('net');
const { ImapFlow } = require('imapflow');
const db = require('./db');
const box = require('./secretBox');
const security = require('./accountSecurity');

const TEST = process.env.IRONID_MIGRATION_TEST === 'true';
const MAX_MESSAGE = 50 * 1024 * 1024;
const MAX_RUNNING = 2;
const MAIL_USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];

class MigrationError extends Error {
  constructor(message, status = 400, extra = {}) { super(message); this.status = status; this.userError = true; Object.assign(this, extra); }
}
const fail = (m, s, x) => { throw new MigrationError(m, s, x); };

/* ——— Where we may connect ——— */
function isPublic(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;          // carrier-grade NAT
    if (a === 169 && b === 254) return false;                    // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && ip.startsWith('192.0.0.')))) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;       // benchmarking
    return true;
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return false;
  if (v.startsWith('::ffff:')) return isPublic(v.slice(7));
  if (/^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff')) return false;
  if (v.startsWith('64:ff9b:') || v.startsWith('2001:db8')) return false;
  return true;
}

async function resolveServer(host) {
  const h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h) && !(TEST && net.isIP(h))) fail('Enter the server name of your old email provider, for example imap.gmail.com.', 400, { code: 'host' });
  let addrs;
  try { addrs = net.isIP(h) ? [{ address: h }] : await dns.lookup(h, { all: true }); } catch (e) { fail('That server name was not found.', 400, { code: 'host' }); }
  if (!addrs.length) fail('That server name was not found.', 400, { code: 'host' });
  if (!TEST && addrs.some(a => !isPublic(a.address))) fail('That server cannot be used.', 400, { code: 'host' });
  return { host: h, ip: addrs[0].address };
}

function clientFor({ host, ip, port, user, pass }) {
  return new ImapFlow({
    host: ip, port, secure: port === 993, doSTARTTLS: port === 143 ? true : undefined,
    servername: net.isIP(host) ? undefined : host,
    auth: { user, pass }, logger: false, emitLogs: false,
    tls: TEST ? { rejectUnauthorized: false } : { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    connectionTimeout: 20000, greetingTimeout: 15000, socketTimeout: 120000
  });
}

/* ——— Starting a copy ——— */
async function start(current, b) {
  const port = Number(b.port || 993);
  if (![993, 143].includes(port)) fail('Use port 993 (or 143 with STARTTLS).', 400, { code: 'port' });
  const user = String(b.username || '').trim().slice(0, 254);
  const pass = typeof b.password === 'string' ? b.password : '';
  if (!user || !pass) fail('Enter the address and password of your old mailbox.', 400, { code: 'login' });
  if (pass.length > 1024) fail('That password is too long.', 400, { code: 'login' });
  const email = String(current.email).toLowerCase();
  const allowed = await db.query(`SELECT 1 FROM cp.orders o JOIN cp.customers c ON c.id = o.customer_id
                                   WHERE c.kind = 'personal' AND lower(c.owner_email) = $1 AND o.kind = 'domain_connect' AND o.status IN ('paid','fulfilled') LIMIT 1`, [email]);
  if (!allowed.rows.length) fail('Copying your old emails is part of the own-domain service. Connect a domain first.', 403);
  const r0 = await db.query(`SELECT count(*) FILTER (WHERE status IN ('queued','running'))::int AS open, count(*)::int AS total FROM cp.migrations WHERE email = $1`, [email]);
  if (r0.rows[0].open) fail('A copy is already running. Wait for it to finish.', 409);
  if (r0.rows[0].total >= 5) fail('You have reached the number of copies included. Contact IRON ID support.', 429);
  const server = await resolveServer(b.host);

  // Check the login now, so a mistake is shown at once instead of in a failed job.
  const c = clientFor({ ...server, port, user, pass });
  try { await c.connect(); } catch (e) {
    const auth = e.authenticationFailed || /auth|login|credentials|password/i.test(String(e.responseText || e.message));
    fail(auth ? 'The old provider refused this address or password. Some providers (Gmail, Outlook) need an app password.'
      : 'Could not reach the old server. Check its name and port.', 400, { code: auth ? 'login' : 'host' });
  } finally { await c.logout().catch(() => {}); }

  const r = await db.query(`INSERT INTO cp.migrations (email, source_host, source_port, source_user) VALUES ($1,$2,$3,$4) RETURNING id`, [email, server.host, port, user]);
  const id = r.rows[0].id;
  // Both secrets are bound to this job (secretBox context): the old password, and the webmail's
  // credential to write into the IRON ID mailbox.
  await db.query('UPDATE cp.migrations SET secret_enc = $2, state = $3 WHERE id = $1', [id,
    box.encrypt(JSON.stringify({ pass, target: current.auth }), 'migration:' + id), { folders: {} }]);
  db.audit({ actor: email, action: 'migration.started', target: email, details: { host: server.host, user } }).catch(() => {});
  setImmediate(tick);
  return view((await db.query('SELECT * FROM cp.migrations WHERE id = $1', [id])).rows[0]);
}

async function cancel(current, b) {
  const r = await db.query(`UPDATE cp.migrations SET status = 'cancelled', secret_enc = NULL, finished_at = NOW()
                            WHERE id = $1 AND email = $2 AND status IN ('queued','running') RETURNING *`, [Number(b.id), String(current.email).toLowerCase()]);
  if (!r.rows.length) fail('That copy was not found or has already finished.', 404);
  return { ok: true };
}

function view(m) {
  return {
    id: Number(m.id), host: m.source_host, username: m.source_user, status: m.status, foldersTotal: m.folders_total, foldersDone: m.folders_done,
    messages: m.messages_done, bytes: Number(m.bytes_done), skipped: m.skipped, error: m.error, createdAt: m.created_at, finishedAt: m.finished_at
  };
}
async function list(current) {
  const r = await db.query('SELECT * FROM cp.migrations WHERE email = $1 ORDER BY created_at DESC LIMIT 10', [String(current.email).toLowerCase()]);
  return { migrations: r.rows.map(view) };
}

/* ——— The worker ——— */
const running = new Set();
let timer = null;

function startWorker() {
  // Jobs that were running when the server stopped continue from where they were.
  db.query(`UPDATE cp.migrations SET status = 'queued' WHERE status = 'running'`).catch(() => {});
  if (!timer) timer = setInterval(tick, 15000);
  if (timer.unref) timer.unref();
}

async function tick() {
  if (running.size >= MAX_RUNNING) return;
  let job;
  try {
    const r = await db.query(`UPDATE cp.migrations SET status = 'running', started_at = COALESCE(started_at, NOW())
                              WHERE id = (SELECT id FROM cp.migrations WHERE status = 'queued' AND NOT (id = ANY($1::bigint[]))
                                          ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`, [[...running]]);
    job = r.rows[0];
  } catch (e) { return; }
  if (!job) return;
  running.add(job.id);
  run(job).catch(async e => {
    console.error(`[migration] ${job.id}:`, e.message);
    await finish(job.id, 'failed', friendly(e));
  }).finally(() => { running.delete(job.id); setImmediate(tick); });
}

function friendly(e) {
  if (e && e.userError) return e.message;
  if (e && e.overQuota) return 'Your IRON ID mailbox is full. Free some space, then start the copy again.';
  if (e && (e.authenticationFailed || /authentication|login failed|credentials/i.test(e.message))) return 'The old provider refused the password. Start the copy again with the right one.';
  return 'The copy stopped because of a problem with the old server. Start it again: it continues where it stopped.';
}

async function finish(id, status, error = null) {
  await db.query(`UPDATE cp.migrations SET status = $2, error = $3, secret_enc = NULL, finished_at = NOW() WHERE id = $1 AND status = 'running'`, [id, status, error]);
}

const stillRunning = async id => (await db.query('SELECT status FROM cp.migrations WHERE id = $1', [id])).rows[0]?.status === 'running';

const ROLE_BY_USE = { '\\Inbox': 'inbox', '\\Sent': 'sent', '\\Drafts': 'drafts', '\\Junk': 'junk', '\\Trash': 'trash', '\\Archive': 'archive' };
const ROLE_BY_NAME = { inbox: 'inbox', sent: 'sent', 'sent items': 'sent', 'sent mail': 'sent', 'éléments envoyés': 'sent', 'envoyés': 'sent', drafts: 'drafts', brouillons: 'drafts', junk: 'junk', spam: 'junk', 'courrier indésirable': 'junk', trash: 'trash', 'deleted items': 'trash', corbeille: 'trash', archive: 'archive', archives: 'archive' };
const KEYWORDS = { '\\Seen': '$seen', '\\Flagged': '$flagged', '\\Answered': '$answered', '\\Draft': '$draft' };

async function run(job) {
  const secret = JSON.parse(box.decrypt(job.secret_enc, 'migration:' + job.id));
  const target = secret.target;
  const session = await security.engineSession(target);
  if (!session) throw new MigrationError('Your IRON ID session for this copy has ended. Start the copy again.');
  const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail'];
  const jmap = async calls => security.jmap(target, calls, MAIL_USING);

  // IRON ID folders, by role and by name.
  const boxes = security.first(await jmap([['Mailbox/get', { accountId, properties: ['name', 'role', 'parentId'] }, 'm']]), 'm').list;
  const fullName = mb => { const parts = []; for (let x = mb; x; x = boxes.find(y => y.id === x.parentId)) parts.unshift(x.name); return parts.join('/'); };
  const byRole = new Map(boxes.filter(b => b.role).map(b => [b.role, b.id]));
  const byPath = new Map(boxes.map(b => [fullName(b).toLowerCase(), b.id]));
  async function targetFolder(path, delimiter, specialUse) {
    const role = ROLE_BY_USE[specialUse] || ROLE_BY_NAME[path.toLowerCase()] || (path.toUpperCase() === 'INBOX' ? 'inbox' : null);
    if (role && byRole.has(role)) return byRole.get(role);
    const parts = path.split(delimiter || '/').filter(Boolean);
    let parentId = null, sofar = '';
    for (const p of parts) {
      sofar = sofar ? sofar + '/' + p : p;
      if (byPath.has(sofar.toLowerCase())) { parentId = byPath.get(sofar.toLowerCase()); continue; }
      const res = security.first(await jmap([['Mailbox/set', { accountId, create: { n: { name: p.slice(0, 255), parentId } } }, 's']]), 's');
      if (!res.created || !res.created.n) throw new Error('could not create folder ' + sofar);
      parentId = res.created.n.id;
      byPath.set(sofar.toLowerCase(), parentId);
    }
    return parentId;
  }

  const src = clientFor({ host: job.source_host, ip: (await resolveServer(job.source_host)).ip, port: job.source_port, user: job.source_user, pass: secret.pass });
  await src.connect();
  try {
    const folders = (await src.list()).filter(f => !(f.flags && (f.flags.has('\\Noselect') || f.flags.has('\\NonExistent'))));
    // Gmail's "All Mail" and "Important" repeat what the other folders hold.
    const skipUse = new Set(['\\All', '\\Important', '\\Flagged']);
    const todo = folders.filter(f => !skipUse.has(f.specialUse));
    const state = job.state || { folders: {} };
    state.folders = state.folders || {};
    await db.query('UPDATE cp.migrations SET folders_total = $2 WHERE id = $1', [job.id, todo.length]);

    for (const f of todo) {
      if (!(await stillRunning(job.id))) return;
      const fs = state.folders[f.path] || { lastUid: 0, done: false };
      if (fs.done) continue;
      const mailboxId = await targetFolder(f.path, f.delimiter, f.specialUse);
      const lock = await src.getMailboxLock(f.path, { readOnly: true });
      try {
        let count = 0;
        for await (const msg of src.fetch(`${fs.lastUid + 1}:*`, { uid: true, flags: true, internalDate: true, size: true, source: { maxLength: MAX_MESSAGE } }, { uid: true })) {
          if (msg.uid <= fs.lastUid) continue;
          if (!msg.source || (msg.size && msg.size > MAX_MESSAGE)) {
            await db.query('UPDATE cp.migrations SET skipped = skipped + 1 WHERE id = $1', [job.id]);
          } else {
            await importOne({ target, accountId, mailboxId, msg, jmap });
            await db.query('UPDATE cp.migrations SET messages_done = messages_done + 1, bytes_done = bytes_done + $2 WHERE id = $1', [job.id, msg.source.length]);
          }
          fs.lastUid = msg.uid;
          if (++count % 25 === 0) {
            state.folders[f.path] = fs;
            await db.query('UPDATE cp.migrations SET state = $2 WHERE id = $1', [job.id, state]);
            if (!(await stillRunning(job.id))) return;
          }
        }
      } finally { lock.release(); }
      fs.done = true;
      state.folders[f.path] = fs;
      await db.query('UPDATE cp.migrations SET state = $2, folders_done = folders_done + 1 WHERE id = $1', [job.id, state]);
    }
  } finally { await src.logout().catch(() => {}); }
  await finish(job.id, 'done');
  db.audit({ actor: job.email, action: 'migration.done', target: job.email }).catch(() => {});
}

async function importOne({ target, accountId, mailboxId, msg, jmap }) {
  const up = await security.uploadBlob(target, accountId, msg.source, 'message/rfc822');
  const keywords = {};
  for (const fl of msg.flags || []) if (KEYWORDS[fl]) keywords[KEYWORDS[fl]] = true;
  const res = security.first(await jmap([['Email/import', { accountId, emails: { m: {
    blobId: up.blobId, mailboxIds: { [mailboxId]: true }, keywords,
    receivedAt: msg.internalDate ? new Date(msg.internalDate).toISOString() : undefined
  } } }, 'i']]), 'i');
  if (res.notCreated && res.notCreated.m) {
    const t = res.notCreated.m.type;
    if (t === 'overQuota') throw Object.assign(new Error('over quota'), { overQuota: true });
    throw new Error('import refused: ' + t + ' ' + (res.notCreated.m.description || ''));
  }
}

module.exports = { start, cancel, list, startWorker, tick, isPublic, resolveServer, MigrationError };
