// In a real browser: team mailboxes (shared inbox, assigning, replying as the team), labels,
// and the admin console pages. Needs PLATFORM_ADMINS to include e2e-platform-admin@<TEST_DOMAIN>.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { chromium } = require('playwright');
const h = require('./helpers');

const tag = crypto.randomBytes(3).toString('hex');
const TEAM = `team-${tag}@${h.TEST_DOMAIN}`;
let platform, anna, bob, P, browser, page, team;
const errors = [];
let dialogs = 0;
const XF = n => ({ 'x-forwarded-for': `198.51.100.${n}` });

async function adminApi(path, body) {
  const r = await h.gw('/admin-api/' + path, body === undefined ? { cookie: P } : { method: 'POST', cookie: P, body });
  assert.equal(r.status, 200, `${path}: ${r.text}`);
  return r.json;
}

async function signInPage(p, user) {
  await p.goto(h.BASE + '/');
  await p.fill('#loginEmail', user.email);
  await p.fill('#loginPassword', user.password);
  await p.click('#loginSubmitBtn');
  await p.waitForFunction(() => !document.querySelector('#loginScreen.open') && document.getElementById('hdrUserEmail').textContent.includes('@'));
}

before(async () => {
  await h.waitHealthy(120000, { requireAdmin: true });
  platform = await h.createTestUser('e2e-platform-admin', { exactName: true });
  anna = await h.createTestUser('anna');
  bob = await h.createTestUser('bob');
  P = (await h.login(platform.email, platform.password, XF(170))).cookie;
  team = await adminApi('teams', { email: TEAM, name: 'Support ' + tag, members: [anna.email, bob.email] });
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => { dialogs++; d.dismiss(); });
});

after(async () => {
  if (browser) await browser.close();
  try { await h.gw('/admin-api/teams/delete', { method: 'POST', cookie: P, body: { id: team.id, confirm: TEAM } }); } catch (e) { /* ignore */ }
  await h.deleteTestUser(anna);
  await h.deleteTestUser(bob);
  await h.deleteTestUser(platform);
});

test('the team mailbox shows up in the sidebar; no Admin link for ordinary users', async () => {
  // Mail for the team, sent by Bob before Anna signs in.
  const B = (await h.login(bob.email, bob.password, XF(171))).cookie;
  await h.sendMail(B, { from: bob.email, to: [TEAM], subject: 'Customer question ' + tag, text: 'Can someone help?' });
  await signInPage(page, anna);
  assert.ok(await page.isHidden('#btnAdmin'), 'not an admin');
  await page.waitForSelector('#teamList .team-btn');
  assert.match(await page.textContent('#teamList'), new RegExp('Support ' + tag));
});

test('open the team inbox and assign a conversation to me', async () => {
  await page.click('#teamList .team-btn');
  await page.waitForSelector(`#emailList .email-item:has-text("Customer question ${tag}")`, { timeout: 20000 });
  assert.match(await page.textContent('#activeFolderName'), /Support/);
  assert.ok(await page.isVisible('#filterMine'));
  await page.click(`#emailList .email-item:has-text("Customer question ${tag}")`);
  await page.waitForSelector('#readerPane .tb-btn[aria-label="Assign"]');
  await page.click('#readerPane .tb-btn[aria-label="Assign"]');
  await page.click('#menu button:has-text("Me")');
  await page.waitForSelector('#readerPane .assign-chip');
  await page.waitForSelector('#emailList .email-item .assign-chip');
  await page.click('.filter-tab[data-filter="mine"]');
  await page.waitForSelector(`#emailList .email-item:has-text("Customer question ${tag}")`);
  await page.click('.filter-tab[data-filter="all"]');
});

test('Bob sees the assignment', async () => {
  const B = (await h.login(bob.email, bob.password, XF(172))).cookie;
  const s = (await h.gw('/proxy/jmap/session', { cookie: B })).json;
  const acc = Object.keys(s.accounts).find(id => !s.accounts[id].isPersonal);
  const [[, q]] = await h.mail(B, [['Email/query', { accountId: acc, filter: { hasKeyword: 'assigned:' + anna.email.toLowerCase() } }, 'q']]);
  assert.equal(q.ids.length, 1);
});

test('reply from the team mailbox goes out as the team', async () => {
  await page.click(`#emailList .email-item:has-text("Customer question ${tag}")`);
  await page.waitForSelector('#readerPane .msg-actions button:has-text("Reply")');
  await page.click('#readerPane .msg-card.expanded .msg-actions button:has-text("Reply")');
  await page.waitForSelector('#composeModal.open');
  const from = await page.$eval('#cmpFrom', s => s.options[s.selectedIndex].textContent);
  assert.match(from, new RegExp(TEAM.replace(/[.]/g, '\\.')), 'answers from the team address');
  await page.fill('#cmpBody', 'We are on it.');
  await page.click('#sendBtn');
  await page.waitForFunction(() => !document.querySelector('#composeModal.open'), null, { timeout: 20000 });
  // Bob gets the answer from the team address.
  await h.sleep(2500);
  const B = (await h.login(bob.email, bob.password, XF(173))).cookie;
  const acc = await h.primaryAccount(B);
  const [[, q], [, g]] = await h.mail(B, [['Email/query', { accountId: acc, filter: { subject: 'Customer question ' + tag }, sort: [{ property: 'receivedAt', isAscending: false }] }, 'q'],
    ['Email/get', { accountId: acc, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['from', 'subject'] }, 'g']]);
  assert.ok(g.list.some(e => /^Re:/.test(e.subject) && e.from[0].email.toLowerCase() === TEAM), JSON.stringify(g.list));
  // The team message is marked as answered (in the team mailbox).
  await page.waitForTimeout(800);
});

test('labels: create, apply, open the label, rename, delete', async () => {
  const B = (await h.login(bob.email, bob.password, XF(174))).cookie;
  await h.sendMail(B, { from: bob.email, to: [anna.email], subject: 'Contract draft ' + tag, text: 'see attached' });
  // Back to Anna's own Inbox.
  await page.click('#folderList .sb-btn[title="Inbox"]');
  await page.waitForSelector(`#emailList .email-item:has-text("Contract draft ${tag}")`, { timeout: 20000 });
  await page.click('#btnNewLabel');
  await page.fill('#dialogInput', 'Clients ' + tag);
  await page.click('#dialogOk');
  await page.waitForSelector(`#labelList .sb-btn:has-text("Clients ${tag}")`);
  // Opening the new label shows nothing yet.
  await page.waitForSelector('#emailList .loading-text:has-text("No messages with this label")');
  await page.click('#folderList .sb-btn[title="Inbox"]');
  await page.click(`#emailList .email-item:has-text("Contract draft ${tag}")`);
  await page.waitForSelector('#readerPane .tb-btn[aria-label="Label"]');
  assert.ok(await page.isHidden('#readerPane .tb-btn[aria-label="Assign"]'), 'no assigning in the own mailbox');
  await page.click('#readerPane .tb-btn[aria-label="Label"]');
  await page.click(`#menu button:has-text("Clients ${tag}")`);
  await page.waitForSelector(`#readerPane .label-chip:has-text("Clients ${tag}")`);
  await page.waitForSelector(`#emailList .email-item .label-chip:has-text("Clients ${tag}")`);
  await page.click(`#labelList .sb-btn:has-text("Clients ${tag}")`);
  await page.waitForSelector(`#emailList .email-item:has-text("Contract draft ${tag}")`);
  assert.match(await page.textContent('#activeFolderName'), new RegExp('Clients ' + tag));
  // Rename and recolour.
  await page.hover(`#labelList .folder-row:has-text("Clients ${tag}")`);
  await page.click(`#labelList .folder-row:has-text("Clients ${tag}") .folder-more`);
  await page.click('#menu button:has-text("Rename")');
  await page.fill('#dialogInput', 'Customers ' + tag);
  await page.click('#dialogOk');
  await page.waitForSelector(`#labelList .sb-btn:has-text("Customers ${tag}")`);
  await page.waitForSelector(`#emailList .label-chip:has-text("Customers ${tag}")`);
  await page.hover(`#labelList .folder-row:has-text("Customers ${tag}")`);
  await page.click(`#labelList .folder-row:has-text("Customers ${tag}") .folder-more`);
  await page.click('#menu button:has-text("Green")');
  await page.waitForSelector('#labelList .lbl-dot.c-green');
  // A reload keeps the label (stored on the server) and the message keeps its keyword.
  await page.reload();
  await page.waitForSelector(`#labelList .sb-btn:has-text("Customers ${tag}")`);
  // Delete: the label disappears and is taken off the message.
  await page.hover(`#labelList .folder-row:has-text("Customers ${tag}")`);
  await page.click(`#labelList .folder-row:has-text("Customers ${tag}") .folder-more`);
  await page.click('#menu button:has-text("Delete label")');
  await page.click('#dialogOk');
  await page.waitForFunction(t => !document.getElementById('labelList').textContent.includes(t), 'Customers ' + tag);
  await h.sleep(1500);
  const A = (await h.login(anna.email, anna.password, XF(175))).cookie;
  const acc = await h.primaryAccount(A);
  const [[, q]] = await h.mail(A, [['Email/query', { accountId: acc, filter: { hasKeyword: 'label:customers-' + tag } }, 'q']]);
  assert.equal(q.ids.length, 0);
});

test('admin console in the browser: mailbox created, suspended, deleted; team listed', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(e.message));
  p.on('dialog', d => { dialogs++; d.dismiss(); });
  await p.goto(h.BASE + '/admin');
  await p.waitForSelector('.signed-out a[href="/"]');
  await signInPage(p, platform);
  assert.ok(await p.isVisible('#btnAdmin'), 'admins get the Admin link');
  await p.click('#btnAdmin');
  await p.waitForSelector('.page-head h1:has-text("Overview")');
  await p.click('#adminNav a[href="#/teams"]');
  await p.waitForSelector('.page-head h1:has-text("Teams")');
  await p.waitForSelector(`.tbl td:has-text("${TEAM}")`);
  assert.match(await p.textContent(`.tbl tr:has-text("${TEAM}")`), new RegExp(anna.email.replace(/[.]/g, '\\.')));
  await p.click('#adminNav a[href="#/mailboxes"]');
  await p.waitForSelector('.page-head h1:has-text("Mailboxes")');
  await p.click('.page-head button:has-text("New mailbox")');
  const local = 'ui-' + tag;
  await p.fill('#f_email', local);
  await p.selectOption('#formDialog .addr-row select', h.TEST_DOMAIN);
  await p.fill('#f_name', 'UI Person');
  await p.click('#formDialog button[type=submit]');
  await p.waitForSelector('#secretValue');
  const pw = (await p.textContent('#secretValue')).trim();
  assert.match(pw, /^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);
  await p.click('#formDialog button:has-text("Done")');
  const email = `${local}@${h.TEST_DOMAIN}`;
  const row = `.tbl tr:has-text("${email}")`;
  await p.waitForSelector(row);
  assert.equal((await h.login(email, pw, XF(176))).status, 200, 'the new mailbox signs in');
  await p.click(`${row} .row-more`);
  await p.click('#menu button:has-text("Suspend")');
  await p.click('#dialogOk');
  await p.waitForSelector(`${row} .badge:has-text("Suspended")`);
  assert.notEqual((await h.login(email, pw, XF(177))).status, 200);
  await p.click(`${row} .row-more`);
  await p.click('#menu button:has-text("Delete")');
  await p.fill('#dialogInput', email);
  await p.click('#dialogOk');
  await p.waitForFunction(e => !document.querySelector('.admin-page').textContent.includes(e), email);
  // Activity log lists what happened.
  await p.click('#adminNav a[href="#/audit"]');
  await p.waitForSelector('.page-head h1:has-text("Activity log")');
  await p.waitForSelector(`.tbl tr:has-text("Mailbox deleted"):has-text("${email}")`);
  // Domain page for the platform domain.
  await p.goto(h.BASE + '/admin#/domains/' + h.TEST_DOMAIN);
  await p.waitForSelector('.page-head h1:has-text("' + h.TEST_DOMAIN + '")');
  await p.waitForSelector('.card h2:has-text("Signing keys")');
  await ctx.close();
});

test('no page errors or browser popups', () => {
  assert.deepEqual(errors, []);
  assert.equal(dialogs, 0);
});
