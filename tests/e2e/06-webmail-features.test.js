// Phase 2 webmail features in a real browser: composing (Cc/Bcc, attachments, drafts),
// threads, search box, flags kept intact, folders, moving with undo, live updates,
// inline pictures, settings and the phone layout.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const h = require('./helpers');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
let A, B, C, sA, sB, accA, browser, page;
const errors = [];
let dialogs = 0;
const toastIs = re => page.waitForFunction(r => new RegExp(r, 'i').test(document.getElementById('toastMsg').textContent), re.source, { timeout: 15000 });

async function find(cookie, acct, subject, extra = {}) {
  for (let i = 0; i < 40; i++) {
    const r = await h.mail(cookie, [['Email/query', { accountId: acct, filter: { subject } }, 'q'],
      ['Email/get', { accountId: acct, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject', 'keywords', 'mailboxIds', 'threadId', 'cc', 'bcc', 'header:Bcc', 'hasAttachment'], ...extra }, 'g']]);
    if (r[1][1].list.length) return r[1][1].list;
    await h.sleep(500);
  }
  return [];
}

before(async () => {
  await h.waitHealthy();
  [A, B, C] = await Promise.all([h.createTestUser('fa'), h.createTestUser('fb'), h.createTestUser('fc')]);
  sA = await h.login(A.email, A.password, { 'x-forwarded-for': '198.51.100.101' });
  sB = await h.login(B.email, B.password, { 'x-forwarded-for': '198.51.100.102' });
  accA = await h.primaryAccount(sA.cookie);
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => { dialogs++; d.dismiss(); });
  await page.goto(h.BASE + '/');
  await page.fill('#loginEmail', A.email);
  await page.fill('#loginPassword', A.password);
  await page.click('#loginSubmitBtn');
  await page.waitForFunction(() => !document.querySelector('#loginScreen.open'));
  await page.waitForFunction(() => document.getElementById('connText').textContent !== 'Connecting…');
});

after(async () => {
  if (browser) await browser.close();
  for (const u of [A, B, C]) await h.deleteTestUser(u);
});

test('compose with Cc, Bcc and an attachment; draft saves itself, then goes to Sent', async () => {
  await page.click('#btnCompose');
  await page.click('#cmpTo');
  await page.fill('#cmpTo', B.email);
  await page.click('#cmpShowCc'); await page.fill('#cmpCc', 'Someone Else <nobody@iron-id.io>');
  await page.click('#cmpShowBcc'); await page.fill('#cmpBcc', C.email);
  await page.fill('#cmpSub', 'Project kickoff ZX-4471');
  await page.fill('#cmpBody', 'Hello,\nThe plan is attached.\n');
  await page.setInputFiles('#cmpFile', { name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('the plan') });
  await page.waitForFunction(() => document.querySelector('#cmpAtt .att') && !document.querySelector('#cmpAtt .att.uploading'));
  await page.waitForFunction(() => /saved/i.test(document.getElementById('cmpStatus').textContent), null, { timeout: 10000 });
  const drafts = await find(sA.cookie, accA, 'kickoff');
  assert.ok(drafts.some(e => e.keywords.$draft), 'draft saved on the server');
  await page.click('#sendBtn');
  await toastIs(/sent/);
  await h.sleep(800);
  const mine = await find(sA.cookie, accA, 'kickoff');
  assert.equal(mine.length, 1, 'one copy left (the draft was replaced)');
  assert.ok(!mine[0].keywords.$draft, 'no longer a draft');
});

test('recipients get it; the Bcc recipient stays hidden', async () => {
  const accB = await h.primaryAccount(sB.cookie);
  const got = (await find(sB.cookie, accB, 'kickoff'))[0];
  assert.ok(got, 'B received it');
  assert.ok(got.hasAttachment, 'attachment arrived');
  assert.equal(got.bcc, null);
  assert.equal(got['header:Bcc'], null, 'no Bcc header in the delivered message');
  assert.deepEqual(got.cc, [{ name: 'Someone Else', email: 'nobody@iron-id.io' }]);
  const sC = await h.login(C.email, C.password, { 'x-forwarded-for': '198.51.100.103' });
  const accC = await h.primaryAccount(sC.cookie);
  assert.equal((await find(sC.cookie, accC, 'kickoff')).length, 1, 'Bcc recipient received it');
});

test('reply all keeps the conversation together for the recipient', async () => {
  await page.click('#folderList .sb-btn:has-text("Sent")');
  await page.click('.email-item:has-text("kickoff")');
  await page.waitForSelector('.msg-card');
  await page.click('#readerPane .ev-toolbar button[title="Reply all"]');
  assert.equal(await page.inputValue('#cmpTo'), B.email);
  assert.match(await page.inputValue('#cmpCc'), /nobody@iron-id\.io/);
  assert.equal(await page.inputValue('#cmpSub'), 'Re: Project kickoff ZX-4471');
  assert.match(await page.inputValue('#cmpBody'), /wrote:\n> Hello,/);
  await page.click('#sendBtn');
  await toastIs(/sent/);
  const accB = await h.primaryAccount(sB.cookie);
  let list = [];
  for (let i = 0; i < 20 && list.length < 2; i++) { list = await find(sB.cookie, accB, 'kickoff'); if (list.length < 2) await h.sleep(500); }
  assert.equal(list.length, 2);
  assert.equal(list[0].threadId, list[1].threadId, 'same thread');
  await page.waitForSelector('.email-item:has-text("kickoff") .ei-count');
  assert.equal(await page.textContent('.email-item:has-text("kickoff") .ei-count'), '2', 'list shows a 2-message conversation');
});

test('closing keeps a draft; it reopens and can be discarded', async () => {
  await page.click('#btnCompose');
  await page.click('#cmpTo');
  await page.fill('#cmpTo', B.email);
  await page.fill('#cmpSub', 'Unfinished thought');
  await page.click('#cmpClose');
  await toastIs(/draft saved/);
  await page.click('#folderList .sb-btn:has-text("Drafts")');
  await page.click('.email-item:has-text("Unfinished")');
  await page.waitForSelector('#composeModal.open');
  assert.equal(await page.inputValue('#cmpSub'), 'Unfinished thought');
  await page.click('#cmpDiscard');
  await toastIs(/discarded/);
  await page.waitForFunction(() => !document.querySelector('.email-item'));
});

test('search box finds mail on the server, including codes with hyphens', async () => {
  await page.fill('#searchInput', 'ZX-4471 in:all');
  await page.press('#searchInput', 'Enter');
  await page.waitForSelector('.email-item:has-text("kickoff")', { timeout: 20000 });
  assert.equal(await page.textContent('#activeFolderName'), 'Search results');
  await page.fill('#searchInput', 'from:nobody-at-all');
  await page.press('#searchInput', 'Enter');
  await page.waitForSelector('.loading-text:has-text("No messages match")');
  await page.fill('#searchInput', '');
  await page.press('#searchInput', 'Enter');
});

test('reading, starring and archiving keep the other flags (old bug)', async () => {
  // A message with a custom flag and a star, unread.
  const [[, boxes]] = await h.mail(sA.cookie, [['Mailbox/get', { accountId: accA }, 'm']]);
  const inbox = boxes.list.find(b => b.role === 'inbox').id;
  await h.mail(sA.cookie, [['Email/set', { accountId: accA, create: { k: {
    mailboxIds: { [inbox]: true }, keywords: { $flagged: true, $important: true, 'project-x': true },
    subject: 'Flag keeper', from: [{ email: 'keeper@partner.example' }], to: [{ email: A.email }],
    bodyValues: { b: { value: 'flags' } }, textBody: [{ partId: 'b', type: 'text/plain' }] } } }, 'e']]);
  await page.click('#folderList .sb-btn:has-text("Inbox")');
  await page.click('.email-item:has-text("Flag keeper")');
  await page.waitForSelector('.msg-card');
  await h.sleep(800);
  let [e] = await find(sA.cookie, accA, 'Flag keeper');
  assert.ok(e.keywords.$seen && e.keywords.$flagged && e.keywords.$important && e.keywords['project-x'], 'opening only added $seen: ' + JSON.stringify(e.keywords));
  await page.click('#readerPane .ev-toolbar button[aria-label="Archive"]');
  await toastIs(/archived/);
  [e] = await find(sA.cookie, accA, 'Flag keeper');
  assert.ok(e.keywords.$flagged && e.keywords.$important && e.keywords['project-x'], 'archiving kept flags');
  assert.equal(Object.keys(e.mailboxIds).length, 1);
  assert.ok(!e.mailboxIds[inbox], 'left the Inbox');
  await page.click('#toastAction'); // Undo
  await toastIs(/undone/);
  [e] = await find(sA.cookie, accA, 'Flag keeper');
  assert.ok(e.mailboxIds[inbox], 'undo brought it back');
});

test('folders: create, move a conversation in, rename, refuse deleting a full folder', async () => {
  await page.click('#btnNewFolder');
  await page.fill('#dialogInput', 'Clients');
  await page.click('#dialogOk');
  await page.waitForSelector('#folderList .sb-btn:has-text("Clients")');
  await page.click('#folderList .sb-btn:has-text("Inbox")');
  await page.click('.email-item:has-text("Flag keeper")');
  await page.waitForSelector('.msg-card');
  await page.click('#readerPane .ev-toolbar button[aria-label="Move"]');
  await page.click('#menu button:has-text("Clients")');
  await toastIs(/moved to clients/);
  await page.click('#folderList .sb-btn:has-text("Clients")');
  await page.waitForSelector('.email-item:has-text("Flag keeper")');
  const row = page.locator('.folder-row:has-text("Clients")');
  await row.hover(); await row.locator('.folder-more').click();
  await page.click('#menu button:has-text("Rename")');
  await page.fill('#dialogInput', 'Clients 2026');
  await page.click('#dialogOk');
  await page.waitForSelector('#folderList .sb-btn:has-text("Clients 2026")');
  const row2 = page.locator('.folder-row:has-text("Clients 2026")');
  await row2.hover(); await row2.locator('.folder-more').click();
  await page.click('#menu button:has-text("Delete")');
  await page.click('#dialogOk');
  await toastIs(/still has messages/);
  assert.ok(await page.isVisible('#folderList .sb-btn:has-text("Clients 2026")'), 'full folder kept');
});

test('delete forever in Trash keeps copies filed in other folders', async () => {
  const [[, boxes]] = await h.mail(sA.cookie, [['Mailbox/get', { accountId: accA }, 'm']]);
  const trash = boxes.list.find(b => b.role === 'trash').id;
  let [e] = await find(sA.cookie, accA, 'Flag keeper');
  await h.mail(sA.cookie, [['Email/set', { accountId: accA, update: { [e.id]: { ['mailboxIds/' + trash]: true } } }, 's']]);
  await page.click('#folderList .sb-btn:has-text("Trash")');
  await page.click('.email-item:has-text("Flag keeper")');
  await page.waitForSelector('.msg-card');
  await page.click('#readerPane .ev-toolbar button[aria-label="Delete forever"]');
  await page.click('#dialogOk');
  await toastIs(/deleted forever/);
  [e] = await find(sA.cookie, accA, 'Flag keeper');
  assert.ok(e, 'message still exists');
  assert.ok(!e.mailboxIds[trash], 'gone from Trash');
  assert.equal(Object.keys(e.mailboxIds).length, 1, 'still in its other folder');
});

test('new mail appears by itself (live updates)', async () => {
  await page.click('#folderList .sb-btn:has-text("Inbox")');
  assert.match(await page.textContent('#connText'), /^(Live|Online)$/);
  await h.sendMail(sB.cookie, { from: B.email, to: [A.email], subject: 'Live push test', text: 'hi' });
  await page.waitForSelector('.email-item:has-text("Live push test")', { timeout: 20000 });
  assert.match(await page.title(), /^\(\d+\) IRON ID Mail$/, 'unread count in the tab title');
});

test('pictures attached inside an email are shown; internet pictures wait for permission', async () => {
  const [[, boxes]] = await h.mail(sA.cookie, [['Mailbox/get', { accountId: accA }, 'm']]);
  const inbox = boxes.list.find(b => b.role === 'inbox').id;
  const blob = await h.upload(sA.cookie, accA, PNG, 'image/png');
  const svg = await h.upload(sA.cookie, accA, '<svg xmlns="http://www.w3.org/2000/svg"><text y="20">fake login</text></svg>', 'image/svg+xml');
  await h.mail(sA.cookie, [['Email/set', { accountId: accA, create: { a: {
    mailboxIds: { [inbox]: true }, subject: 'Logo inline', from: [{ name: 'Désirée', email: 'desiree@partner.example' }], to: [{ email: A.email }],
    bodyStructure: { type: 'multipart/related', subParts: [{ partId: 'h', type: 'text/html' },
      { blobId: blob.blobId, type: 'image/png', cid: 'logo1', disposition: 'inline', name: 'logo.png' },
      { blobId: svg.blobId, type: 'image/svg+xml', cid: 'svg1', disposition: 'inline', name: 'x.svg' }] },
    bodyValues: { h: { value: '<p>Logo <img alt="logo" src="cid:logo1" width="40" height="40"></p><p><img alt="remote" src="https://img.example/r.png"><img alt="svgcid" src="cid:svg1"></p>' } }
  } } }, 'e']]);
  await page.click('.email-item:has-text("Logo inline")');
  await page.waitForSelector('iframe.mail-frame');
  const frame = page.frames().find(f => f !== page.mainFrame());
  await frame.waitForFunction(() => { const i = document.querySelector('img[alt="logo"]'); return i && i.complete && i.naturalWidth > 0; });
  assert.equal(await frame.evaluate(() => document.querySelector('img[alt="remote"]').getAttribute('src')), null, 'internet picture held back');
  assert.equal(await frame.evaluate(() => document.querySelector('img[alt="svgcid"]').getAttribute('src')), null, 'SVG pictures are not turned into local pages');
  assert.equal(await page.locator('#readerPane a.att').count(), 0, 'inline picture is not listed as an attachment');
});

test('profile, signature and out-of-office are saved to the mailbox', async () => {
  await page.click('#btnSettings');
  await page.fill('#setDisplayName', 'Test Person');
  await page.fill('#setSignature', 'Test Person\nIRON ID');
  await page.click('#profileForm button[type=submit]');
  await page.waitForFunction(() => /saved/i.test(document.getElementById('profileStatus').textContent));
  assert.equal(await page.textContent('#hdrUserName'), 'Test Person');
  await page.click('#stab-vacation');
  await page.check('#vacEnabled');
  await page.fill('#vacSubject', 'Away');
  await page.fill('#vacText', 'Back on Monday.');
  await page.click('#vacationForm button[type=submit]');
  await page.waitForFunction(() => /automatic reply is on/i.test(document.getElementById('vacStatus').textContent));
  const [[, ids]] = await h.mail(sA.cookie, [['Identity/get', { accountId: accA }, 'i']]);
  assert.equal(ids.list[0].name, 'Test Person');
  await page.keyboard.press('Escape');
  await page.click('#btnCompose');
  assert.match(await page.inputValue('#cmpBody'), /-- \nTest Person\nIRON ID$/);
  await page.click('#cmpDiscard');
});

test('keyboard shortcuts move through and act on conversations', async () => {
  await page.click('#folderList .sb-btn:has-text("Inbox")');
  await page.waitForSelector('.email-item');
  await page.locator('#emailList').focus();
  await page.keyboard.press('j');
  await page.waitForFunction(() => {
    const sel = document.querySelector('.email-item.selected .ei-subject');
    const subj = document.querySelector('#readerPane .thread-subject');
    return sel && subj && sel.textContent === subj.textContent;
  }, null, { timeout: 10000 }).catch(async e => {
    const info = await page.evaluate(() => ({
      active: document.activeElement && (document.activeElement.id || document.activeElement.className),
      items: Array.from(document.querySelectorAll('.email-item')).map(x => x.className + ' | ' + x.querySelector('.ei-subject').textContent),
      reader: (document.querySelector('#readerPane') || {}).textContent.slice(0, 120)
    }));
    throw new Error('j did not open the next conversation: ' + JSON.stringify(info));
  });
  await page.keyboard.press('s');
  await page.waitForSelector('.email-item.selected .ei-star.on');
  await page.keyboard.press('c');
  await page.waitForSelector('#composeModal.open');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#composeModal.open', { state: 'detached' });
});

test('phone layout shows one pane at a time', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#readerPane .back-btn').catch(() => {});
  await page.waitForSelector('.list-panel', { state: 'visible' });
  assert.ok(!(await page.isVisible('#readerPane')));
  await page.click('.email-item:has-text("Live push test")');
  await page.waitForSelector('#readerPane .msg-card');
  assert.ok(!(await page.isVisible('.list-panel')));
  const scrollX = await page.evaluate(() => document.querySelector('.main-layout').scrollLeft + document.documentElement.scrollLeft);
  assert.equal(scrollX, 0, 'nothing pushed sideways');
  await page.click('#readerPane .back-btn');
  await page.waitForSelector('.list-panel', { state: 'visible' });
  await page.click('#navToggle');
  await page.waitForSelector('body.nav-open');
  await page.click('#folderList .sb-btn:has-text("Sent")');
  await page.waitForSelector('body:not(.nav-open)');
  await page.setViewportSize({ width: 1360, height: 860 });
});

test('no page errors or browser popups along the way', () => {
  assert.deepEqual(errors, []);
  assert.equal(dialogs, 0);
});
