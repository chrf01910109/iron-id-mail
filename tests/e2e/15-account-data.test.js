// "Your data": downloading everything (.tar.gz with .eml files, account.json, README) and closing an
// account (people who signed up themselves): confirmation, other browsers signed out, cancelling, and the
// deletion after the closing date. Mailboxes from an organisation can't close themselves.
// The closing tests mark an account as self-registered and move its closing date in the database: they
// need PSQL_DOCKER=<postgres container> (CI) or TEST_DATABASE_URL (local), and the gateway started with
// IRONID_CLOSE_CHECK_SECONDS=5 (checks for due closings every 5 s instead of every hour).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const h = require('./helpers');

const tag = crypto.randomBytes(3).toString('hex');
const XF = n => ({ 'x-forwarded-for': `198.51.103.${n}` });
let owner, org, closer, browser;

function sql(q) {
  if (process.env.PSQL_DOCKER) {
    return execFileSync('docker', ['exec', process.env.PSQL_DOCKER, 'psql', '-U', 'iron', '-d', 'ironmail', '-p', '55432', '-At', '-c', q]).toString().trim();
  }
  if (process.env.TEST_DATABASE_URL) return execFileSync('psql', [process.env.TEST_DATABASE_URL, '-At', '-c', q]).toString().trim();
  return null;
}
const HAVE_DB = !!(process.env.PSQL_DOCKER || process.env.TEST_DATABASE_URL);
const dbTest = HAVE_DB ? test : test.skip;
const safe = e => { assert.match(e, /^[a-z0-9.@-]+$/); return e; };

/** Reads a .tar.gz into [{ name, data }] (PAX "path" records give long or non-ASCII names). */
function untar(gz) {
  const buf = zlib.gunzipSync(gz), out = [];
  let paxPath = null;
  for (let off = 0; off + 512 <= buf.length;) {
    const hdr = buf.subarray(off, off + 512);
    if (hdr.every(b => b === 0)) break;
    const str = (a, b) => hdr.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const name = (str(345, 500) ? str(345, 500) + '/' : '') + str(0, 100);
    const size = parseInt(str(124, 136).trim(), 8);
    const type = String.fromCharCode(hdr[156]);
    // The header's checksum must be right (some tools refuse the archive otherwise).
    const copy = Buffer.from(hdr); copy.fill(0x20, 148, 156);
    assert.equal(copy.reduce((s, b) => s + b, 0), parseInt(str(148, 156).trim(), 8), 'tar checksum of ' + name);
    const data = buf.subarray(off + 512, off + 512 + size);
    if (type === 'x') {
      const m = /^(\d+) path=([\s\S]*)\n$/.exec(data.toString('utf8'));
      assert.ok(m && Number(m[1]) === data.length, 'PAX record length');
      paxPath = m[2];
    } else {
      out.push({ name: paxPath || name, data });
      paxPath = null;
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
async function download(cookie, n = 1) {
  const r = await fetch(h.BASE + '/account/export', { headers: { cookie: `iid_session=${cookie}`, ...XF(n) } });
  return { status: r.status, type: r.headers.get('content-type'), disposition: r.headers.get('content-disposition'), body: Buffer.from(await r.arrayBuffer()) };
}
const RAW = (subject, extra = '') => Buffer.from(
  `From: Friend <friend@example.org>\r\nTo: someone@example.org\r\nSubject: ${subject}\r\nDate: Tue, 13 Oct 2026 10:00:00 +0200\r\n` +
  `MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/plain; charset=utf-8\r\n` +
  `Content-Transfer-Encoding: 8bit\r\n\r\nBonjour, voilà l’équipe ${extra}\r\n--b1\r\nContent-Type: application/octet-stream; name="x.bin"\r\n` +
  `Content-Transfer-Encoding: base64\r\n\r\n${crypto.randomBytes(3000).toString('base64').replace(/.{76}/g, '$&\r\n')}\r\n--b1--\r\n`, 'utf8');

before(async () => {
  await h.waitHealthy(120000, { requireAdmin: true });
  [owner, org, closer] = await Promise.all([h.createTestUser('data-owner'), h.createTestUser('data-org'), h.createTestUser('data-close')]);
  for (const [u, n] of [[owner, 1], [org, 2], [closer, 3]]) {
    const r = await h.login(u.email, u.password, XF(n));
    assert.equal(r.status, 200, r.text);
    u.cookie = r.cookie;
  }
  browser = await chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  for (const u of [owner, org, closer]) await h.deleteTestUser(u);
  if (HAVE_DB && closer) {
    sql(`DELETE FROM cp.signup_log WHERE email = '${safe(closer.email)}'`);
    sql(`DELETE FROM cp.retired_addresses WHERE email = '${safe(closer.email)}'`); // test addresses are random
  }
});

test('download my data: every message as .eml (exact bytes), by folder, with account.json and README', async () => {
  const acct = await h.primaryAccount(owner.cookie);
  const [[, boxes]] = await h.mail(owner.cookie, [['Mailbox/get', { accountId: acct }, 'm']]);
  const inbox = boxes.list.find(b => b.role === 'inbox').id;
  const [[, made]] = await h.mail(owner.cookie, [['Mailbox/set', { accountId: acct, create: { p: { name: `Projets été ${tag}` } } }, 'm']]);
  const folder = made.created.p.id;
  // Deep folders with long names (paths over 100 bytes) and a folder called "..".
  const long = 'Clients et partenaires du projet ' + tag;
  const [[, deep]] = await h.mail(owner.cookie, [['Mailbox/set', { accountId: acct, create: {
    a: { name: long, parentId: folder }, b: { name: long + ' bis', parentId: '#a' }, c: { name: '..', parentId: '#b' } } }, 'm']]);
  assert.ok(deep.created && deep.created.c, JSON.stringify(deep));
  const raws = [RAW('Un ' + tag, 'one'), RAW('Deux ' + tag, 'two'), RAW('Trois ' + tag, 'three'), RAW('Quatre ' + tag, 'four'), RAW('Cinq ' + tag, 'five')];
  const targets = [inbox, inbox, folder, deep.created.c.id, deep.created.c.id];
  for (let i = 0; i < raws.length; i++) {
    const up = await h.upload(owner.cookie, acct, raws[i], 'message/rfc822');
    const [[, imp]] = await h.mail(owner.cookie, [['Email/import', { accountId: acct, emails: { e: { blobId: up.blobId, mailboxIds: { [targets[i]]: true }, receivedAt: `2026-10-1${i}T08:00:00Z` } } }, 'i']]);
    assert.ok(imp.created && imp.created.e, JSON.stringify(imp));
  }

  const d = await download(owner.cookie);
  assert.equal(d.status, 200);
  assert.equal(d.type, 'application/gzip');
  assert.match(d.disposition, /attachment; filename="iron-id-.*\.tar\.gz"/);
  const files = untar(d.body);
  const names = files.map(f => f.name);
  assert.ok(names.some(n => /\/README\.txt$/.test(n)), 'README');
  const info = JSON.parse(files.find(f => /\/account\.json$/.test(f.name)).data.toString('utf8'));
  assert.equal(info.email, owner.email);
  assert.ok(Array.isArray(info.signIns) && info.signIns.length >= 1, 'sign-in history');
  const emls = files.filter(f => f.name.endsWith('.eml'));
  assert.equal(emls.filter(f => /\/Mail\/Inbox\//.test(f.name)).length, 2, names.join('\n'));
  assert.equal(emls.filter(f => f.name.includes(`/Mail/Projets été ${tag}/2`)).length, 1, 'folder names kept, accents too');
  const cut = x => Array.from(x).slice(0, 40).join('').replace(/[ .]+$/, ''); // folder names: 40 characters
  const deepFiles = emls.filter(f => f.name.includes(`/Mail/Projets été ${tag}/${cut(long)}/${cut(long + ' bis')}/Folder/`));
  assert.equal(deepFiles.length, 2, 'long paths kept whole, ".." made harmless: ' + names.join('\n'));
  assert.ok(names.every(n => !n.split('/').includes('..')), 'no ".." in any path');
  for (const raw of raws) assert.ok(emls.some(f => f.data.equals(raw)), 'a message is byte-for-byte the original');
});

test('download my data: signed in only, 3 a day', async () => {
  assert.equal((await fetch(h.BASE + '/account/export')).status, 401, 'not signed in');
  assert.equal((await download(owner.cookie)).status, 200);
  assert.equal((await download(owner.cookie)).status, 200);
  const fourth = await download(owner.cookie);
  assert.equal(fourth.status, 429);
  assert.match(fourth.body.toString(), /3 times a day/);
  // Settings asks first, so the refusal is shown as a message (not saved as a file).
  const check = await h.gw('/account/export/check', { cookie: owner.cookie });
  assert.equal(check.status, 429);
  assert.match(check.json.error, /3 times a day/);
  assert.equal((await h.gw('/account/export/check', { cookie: org.cookie })).status, 200);
});

test('close my account: a mailbox from an organisation can’t, and is told why', async () => {
  const s = await h.gw('/account/close', { cookie: org.cookie });
  assert.equal(s.status, 200);
  assert.equal(s.json.canClose, false);
  assert.match(s.json.problem, /organisation/);
  const r = await h.gw('/account/close', { method: 'POST', cookie: org.cookie, body: { confirm: org.email, currentPassword: org.password }, headers: XF(2) });
  assert.equal(r.status, 403);
  assert.equal((await h.login(org.email, org.password, XF(2))).status, 200, 'still there');
});

dbTest('close my account: confirmation, other browsers signed out, cancel, then deleted after the date', async () => {
  sql(`INSERT INTO cp.signup_log (email, ip, network, terms_version, lang, status) VALUES ('${safe(closer.email)}', '198.51.103.3', '198.51.103.3', 'test', 'en', 'created')`);
  const other = await h.login(closer.email, closer.password, XF(4));
  assert.equal(other.status, 200);
  let s = await h.gw('/account/close', { cookie: closer.cookie });
  assert.equal(s.json.canClose, true, JSON.stringify(s.json));
  assert.equal(s.json.closeDays, 14);
  const post = body => h.gw('/account/close', { method: 'POST', cookie: closer.cookie, body, headers: XF(3) });
  assert.equal((await post({ confirm: 'someone@else.example', currentPassword: closer.password })).json.code, 'confirm');
  assert.equal((await post({ confirm: closer.email, currentPassword: 'not the password' })).status, 400);
  await h.sleep(500);
  assert.equal((await h.gw('/account/close', { cookie: closer.cookie })).json.scheduled, null, 'a wrong password schedules nothing');
  const cross = await h.gw('/account/close', { method: 'POST', cookie: closer.cookie, body: { confirm: closer.email, currentPassword: closer.password }, headers: { ...XF(3), origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  const ok = await post({ confirm: closer.email.toUpperCase(), currentPassword: closer.password });
  assert.equal(ok.status, 200, ok.text);
  const days = (new Date(ok.json.scheduled.deleteAfter) - Date.now()) / 86400000;
  assert.ok(days > 13.9 && days < 14.1, 'in 14 days: ' + days);
  assert.equal((await h.gw('/account/me', { cookie: other.cookie })).status, 401, 'the other browser was signed out');
  assert.ok((await h.gw('/account/me', { cookie: closer.cookie })).json.closing, 'this browser shows the notice');

  // Cancel, then ask again.
  const c = await h.gw('/account/close/cancel', { method: 'POST', cookie: closer.cookie, body: {}, headers: XF(3) });
  assert.equal(c.status, 200);
  assert.equal(c.json.scheduled, null);
  assert.equal((await h.gw('/account/me', { cookie: closer.cookie })).json.closing, null);
  assert.equal((await post({ confirm: closer.email, currentPassword: closer.password })).status, 200);

  // The date passes: the account is deleted (the gateway checks every few seconds in tests).
  sql(`UPDATE cp.account_closures SET delete_after = NOW() - INTERVAL '1 minute' WHERE email = '${safe(closer.email)}'`);
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) {
    await h.sleep(1000);
    gone = sql(`SELECT count(*) FROM cp.account_closures WHERE email = '${safe(closer.email)}'`) === '0';
  }
  assert.ok(gone, 'the closing was carried out');
  assert.equal((await h.login(closer.email, closer.password, XF(5))).status, 401, 'can no longer sign in');
  const [[, all]] = await h.engine(h.recoveryAuth(), [['x:Account/get', { ids: null, properties: ['name'] }, 'a']]);
  assert.ok(!all.list.some(a => a.id === closer.id), 'the mailbox is gone from the mail server');
  assert.equal(sql(`SELECT count(*) FROM cp.audit_log WHERE action = 'account.closed' AND target = '${safe(closer.email)}'`), '1');
  closer.id = null;
  // The address is never given out again: not by sign-up, not by the admin console.
  assert.equal(sql(`SELECT count(*) FROM cp.retired_addresses WHERE email = '${safe(closer.email)}'`), '1');
  const [local, domain] = closer.email.split('@');
  if (domain === 'iron-id.io') {
    const chk = await h.gw('/signup-api/check', { method: 'POST', body: { local }, headers: XF(7) });
    if (chk.status === 200) assert.equal(chk.json.reason, 'taken', JSON.stringify(chk.json));
  }
  const platform = await h.createTestUser('e2e-platform-admin', { exactName: true });
  try {
    const P = (await h.login(platform.email, platform.password, XF(8))).cookie;
    const again = await h.gw('/admin-api/mailboxes', { method: 'POST', cookie: P, body: { email: closer.email, name: 'New owner' } });
    assert.equal(again.status, 400, again.text);
    assert.match(again.json.error, /closed/);
  } finally { await h.deleteTestUser(platform); }
});

dbTest('close my account: no cancelling while the deletion runs; a stopped deletion is finished later', async () => {
  const u = await h.createTestUser('data-close2');
  try {
    const me = safe(u.email);
    const L = await h.login(u.email, u.password, XF(9));
    sql(`INSERT INTO cp.signup_log (email, ip, network, terms_version, lang, status) VALUES ('${me}', '198.51.103.9', '198.51.103.9', 'test', 'en', 'created')`);
    sql(`INSERT INTO cp.user_prefs (email, lang) VALUES ('${me}', 'fr') ON CONFLICT (email) DO NOTHING`);
    assert.equal((await h.gw('/account/close', { method: 'POST', cookie: L.cookie, body: { confirm: u.email, currentPassword: u.password }, headers: XF(9) })).status, 200);
    // A deletion run is working on it: cancelling is refused.
    sql(`UPDATE cp.account_closures SET claimed_at = NOW() WHERE email = '${me}'`);
    const c = await h.gw('/account/close/cancel', { method: 'POST', cookie: L.cookie, body: {}, headers: XF(9) });
    assert.equal(c.status, 409, c.text);
    // A run that stopped after deleting the mailbox: the next one finishes the clean-up, it is not "refused".
    await h.deleteTestUser(u); u.id = null;
    sql(`UPDATE cp.account_closures SET claimed_at = NOW() - INTERVAL '2 hours', mailbox_deleted_at = NOW(), delete_after = NOW() - INTERVAL '1 minute' WHERE email = '${me}'`);
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) { await h.sleep(1000); gone = sql(`SELECT count(*) FROM cp.account_closures WHERE email = '${me}'`) === '0'; }
    assert.ok(gone, 'finished');
    assert.equal(sql(`SELECT count(*) FROM cp.user_prefs WHERE email = '${me}'`), '0', 'settings removed');
    assert.equal(sql(`SELECT count(*) FROM cp.audit_log WHERE action = 'account.close_refused' AND target = '${me}'`), '0');
  } finally {
    if (u.id) await h.deleteTestUser(u);
    sql(`DELETE FROM cp.signup_log WHERE email = '${safe(u.email)}'`);
    sql(`DELETE FROM cp.retired_addresses WHERE email = '${safe(u.email)}'`);
  }
});

test('Settings: "Your data" and the closing card in the browser (French)', async () => {
  const ctx = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 }, extraHTTPHeaders: XF(6) });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(h.BASE + '/');
  await page.fill('#loginEmail', org.email);
  await page.fill('#loginPassword', org.password);
  await page.click('#loginSubmitBtn');
  await page.waitForSelector('#btnSettings', { state: 'visible', timeout: 30000 });
  await page.click('#btnSettings');
  await page.click('#stab-security');
  await page.waitForSelector('#dataDownload');
  assert.equal(await page.getAttribute('#dataDownload', 'href'), '/account/export');
  assert.match(await page.textContent('#dataDownload'), /Télécharger mes données/);
  await page.waitForFunction(() => document.querySelector('#closeIntro').textContent.length > 0);
  assert.match(await page.textContent('#closeIntro'), /organisation/);
  assert.ok(await page.isHidden('#closeForm'), 'no closing form for an organisation mailbox');
  assert.deepEqual(errors, []);
  await ctx.close();
});
