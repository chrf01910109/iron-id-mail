// Own domains and payments in a real browser (webmail "Your domains" and the console's Payments), and the
// yearly renewal of a bought domain: the notice 30 days before the end, paying again, cancelled payments,
// and the limits after the end. Same gateway switches as 12-domains-billing.test.js.
// The renewal tests move a domain's end date in the database: they need PSQL_DOCKER=<postgres container>
// (CI) or TEST_DATABASE_URL (local), and are skipped without.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const h = require('./helpers');

const tag = crypto.randomBytes(3).toString('hex');
const BUY = `uidom${tag}.fr`;
const XF = n => ({ 'x-forwarded-for': `198.51.102.${n}` });
let owner, platform, P, O, browser, state;

function sql(q) {
  if (process.env.PSQL_DOCKER) {
    return execFileSync('docker', ['exec', process.env.PSQL_DOCKER, 'psql', '-U', 'iron', '-d', 'ironmail', '-p', '55432', '-At', '-c', q]).toString().trim();
  }
  if (process.env.TEST_DATABASE_URL) return execFileSync('psql', [process.env.TEST_DATABASE_URL, '-At', '-c', q]).toString().trim();
  return null;
}
const HAVE_DB = !!(process.env.PSQL_DOCKER || process.env.TEST_DATABASE_URL);
const dbTest = HAVE_DB ? test : test.skip;
// Only for this test's own domain name (letters, digits, dots), never user input.
const setEnd = (domain, days) => { assert.match(domain, /^[a-z0-9.]+$/); sql(`UPDATE cp.registered_domains SET expires_at = NOW() + INTERVAL '${Number(days)} days' WHERE domain = '${domain}'`); };
const acct = (path, cookie = O) => h.gw('/account/' + path, { cookie });
const post = (path, body, cookie = O) => h.gw('/account/' + path, { method: 'POST', cookie, body });

function watch(page, errors) {
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
}
async function signIn(page, u) {
  await page.goto(h.BASE + '/');
  await page.fill('#loginEmail', u.email);
  await page.fill('#loginPassword', u.password);
  await page.click('#loginSubmitBtn');
  await page.waitForFunction(() => !document.querySelector('#loginScreen.open') && document.getElementById('hdrUserEmail').textContent.includes('@'));
}
/** On the fake payment page: pay (like Stripe's page would), then come back as Stripe sends people back. */
async function payOnPage(page) {
  await page.waitForURL(/fake-checkout/, { timeout: 20000 });
  await page.waitForSelector('#fakePay');
  const u = new URL(page.url());
  const st = await page.evaluate(async ([order, sig]) => (await fetch('/billing/fake-pay', { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ order, sig }).toString() })).status,
  [u.searchParams.get('order'), u.searchParams.get('sig')]);
  assert.ok([0, 303].includes(st), 'fake payment accepted: ' + st); // 0 = opaque redirect
  await page.goto(`${h.BASE}/?order=${u.searchParams.get('order')}&paid=1#domains`);
  return Number(u.searchParams.get('order'));
}
const noSideScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

before(async () => {
  await h.waitHealthy(120000, { requireAdmin: true });
  const hz = (await h.gw('/healthz')).json;
  assert.equal(hz.payments, 'fake', 'start the gateway with PAYMENTS_FAKE=true');
  assert.equal(hz.registrar, 'fake', 'start the gateway with REGISTRAR=fake');
  owner = await h.createTestUser('dom-ui');
  platform = await h.createTestUser('e2e-platform-admin', { exactName: true });
  O = (await h.login(owner.email, owner.password, XF(1))).cookie;
  P = (await h.login(platform.email, platform.password, XF(2))).cookie;
  browser = await chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  await post('addresses/remove', { email: `contact@${BUY}` }).catch(() => {});
  await h.gw('/admin-api/domains/remove', { method: 'POST', cookie: P, body: { domain: BUY, confirm: BUY } }).catch(() => {});
  for (const u of [owner, platform]) await h.deleteTestUser(u);
});

test('webmail: find a domain, give the owner details, pay, then add an address', async () => {
  const ctx = await browser.newContext({ locale: 'en-GB', viewport: { width: 1360, height: 900 }, extraHTTPHeaders: XF(3) });
  const page = await ctx.newPage();
  const errors = []; watch(page, errors);
  await signIn(page, owner);
  await page.waitForSelector('#domainSection:not(.hidden) #domainList button', { timeout: 30000 });
  await page.click('#domainList button');
  await page.waitForSelector('.dom-choices');
  assert.match(await page.textContent('.dom-choices'), /€2/);
  assert.match(await page.textContent('.dom-choices'), /€14/);
  await page.click('text=Find a domain');
  await page.fill('#domSearch', 'uidom' + tag);
  await page.click('button:has-text("Search")');
  await page.waitForSelector('.dom-results li');
  await page.locator('.dom-results li', { hasText: BUY }).locator('button').click();
  await page.waitForSelector('#own-firstName');
  await page.fill('#own-firstName', 'Karim'); await page.fill('#own-lastName', 'Benali');
  await page.fill('#own-address', '10 rue de la Paix'); await page.fill('#own-postalCode', '75002'); await page.fill('#own-city', 'Paris');
  await page.fill('#own-phone', 'abc');
  await page.check('#own-terms');
  await page.click('form button:has-text("Pay")');
  await page.waitForFunction(() => { const e = document.querySelector('#own-phone-err'); return e && e.textContent.length > 0; }, null, { timeout: 10000 });
  await page.fill('#own-phone', '06 12 34 56 78');
  await page.click('form button:has-text("Pay")');
  const orderId = await payOnPage(page);
  await page.waitForSelector('h2:has-text("Addresses")', { timeout: 60000 });
  await page.fill('#domLocal', 'contact');
  await page.click('button:has-text("Add address")');
  await page.waitForSelector(`.sec-list li:has-text("contact@${BUY}")`, { timeout: 20000 });
  const o = (await acct('domains')).json;
  assert.equal(o.domains.find(d => d.domain === BUY).status, 'active');
  assert.equal(o.orders.find(x => x.id === orderId).status, 'fulfilled');
  await page.click('text=‹ Your domains');
  await page.waitForSelector('text=Orders and invoices');
  assert.ok(await page.locator('a:has-text("Invoice")').count() >= 1, 'an invoice link');
  assert.deepEqual(errors, []);
  state = await ctx.storageState();
  await ctx.close();
});

dbTest('renewal opens 30 days before the end, not earlier', async () => {
  const early = await post('domains/renew', { domain: BUY });
  assert.equal(early.status, 400, early.text);
  assert.match(early.json.error, /30 days/);
  assert.deepEqual((await acct('me')).json.domainNotices, []);
  setEnd(BUY, 10);
  const n = (await acct('me')).json.domainNotices;
  assert.equal(n.length, 1);
  assert.equal(n[0].domain, BUY);
  assert.equal(n[0].expired, false);
});

dbTest('webmail: the renewal notice, a cancelled payment, then paying for one more year', async () => {
  const ctx = await browser.newContext({ locale: 'en-GB', viewport: { width: 1360, height: 900 }, storageState: state, extraHTTPHeaders: XF(4) });
  const page = await ctx.newPage();
  const errors = []; watch(page, errors);
  await page.goto(h.BASE + '/');
  await page.waitForSelector('#domainNotice .notice', { timeout: 30000 });
  assert.match(await page.textContent('#domainNotice'), new RegExp(BUY.replace(/\./g, '\\.')));
  await page.click('#domainNotice button');
  await page.click('button:has-text("Renew for 1 year")');
  await page.waitForURL(/fake-checkout/);
  await page.click('#fakeCancel');
  await page.waitForSelector('text=Payment cancelled', { timeout: 30000 });
  const cancelled = (await acct('domains')).json.orders.filter(x => x.kind === 'domain_renew');
  assert.ok(cancelled.length >= 1 && cancelled.every(x => x.status === 'cancelled'), JSON.stringify(cancelled));

  const before = new Date((await acct('domains')).json.domains.find(d => d.domain === BUY).expiresAt);
  await page.click('button:has-text("Renew for 1 year")');
  const id = await payOnPage(page);
  const after = await (async () => {
    for (let i = 0; i < 30; i++) {
      const o = (await acct('domains')).json;
      if (o.orders.find(x => x.id === id).status === 'fulfilled') return new Date(o.domains.find(d => d.domain === BUY).expiresAt);
      await h.sleep(1000);
    }
    throw new Error('renewal not delivered');
  })();
  const days = (after - before) / 86400000;
  assert.ok(days > 364 && days < 367, 'one more year: ' + days);
  assert.deepEqual((await acct('me')).json.domainNotices, [], 'no notice after renewing');
  const inv = (await acct('domains')).json.orders.find(x => x.id === id);
  assert.match(inv.invoiceNumber, /^F\d{4}-\d{6}$/);
  assert.equal(inv.amountCents, 1400);
  assert.deepEqual(errors, []);
  await ctx.close();
});

dbTest('after the end: renewal is possible for 30 days, then only through support', async () => {
  setEnd(BUY, -10);
  const n = (await acct('me')).json.domainNotices;
  assert.equal(n.length, 1);
  assert.equal(n[0].expired, true);
  const r = await post('domains/renew', { domain: BUY });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.order.kind, 'domain_renew');
  assert.equal((await post('orders/cancel', { id: r.json.order.id })).status, 200);
  setEnd(BUY, -40);
  const late = await post('domains/renew', { domain: BUY });
  assert.equal(late.status, 400);
  assert.match(late.json.error, /support/);
  setEnd(BUY, 300); // back to normal for the next tests
});

test('admin console: Payments, the client\'s total, prices and invoices settings (French)', async () => {
  const ctx = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1360, height: 900 }, extraHTTPHeaders: XF(5) });
  const page = await ctx.newPage();
  const errors = []; watch(page, errors);
  await signIn(page, platform);
  await page.goto(h.BASE + '/admin#/payments');
  await page.waitForSelector(`td:has-text("${BUY}")`, { timeout: 30000 });
  assert.match(await page.textContent('main, body'), /Paiements/);
  assert.match(await page.textContent('main, body'), /Paiements de test|fictifs/);
  await page.goto(h.BASE + '/admin#/customers');
  await page.waitForSelector('a.paid-link', { timeout: 30000 });
  await page.goto(h.BASE + '/admin#/settings');
  await page.waitForSelector('text=Prix et factures', { timeout: 30000 });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phone, French: the domain pages fit the screen', async () => {
  const ctx = await browser.newContext({ locale: 'fr-FR', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: state, extraHTTPHeaders: XF(6) });
  await ctx.addCookies([{ name: 'ironid_lang', value: 'fr', url: h.BASE }]); // the first test chose English
  const page = await ctx.newPage();
  const errors = []; watch(page, errors);
  for (const hash of ['#domains', '#domains/' + BUY, '#domains/buy', '#domains/connect']) {
    await page.goto(h.BASE + '/' + hash);
    await page.waitForSelector('.dom-choices, .dom-details, #domSearch, #domConnect, h2', { timeout: 30000 });
    await page.waitForTimeout(500);
    assert.ok(await noSideScroll(page), 'no sideways scroll on ' + hash);
  }
  await page.goto(h.BASE + '/#domains');
  await page.waitForSelector('.dom-choices', { timeout: 30000 });
  assert.match(await page.textContent('#domainSection'), /Vos domaines/i);
  assert.deepEqual(errors, []);
  await ctx.close();
});
