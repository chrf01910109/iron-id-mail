// Account security in a real browser: two-step sign-in, app passwords for mail apps,
// signed-in browsers, and the password change with two-step on.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const h = require('./helpers');
const { totp } = require('./totp');

let user, browser, page, secret, otherDevice;
const errors = [];
let dialogs = 0;
const XF = { 'x-forwarded-for': '198.51.100.150' };
const usedCodes = new Set();

/** A code that hasn't been used yet (waits for the next 30-second window when needed). */
async function freshCode() {
  for (let i = 0; i < 40; i++) {
    const c = totp(secret);
    if (!usedCodes.has(c)) { usedCodes.add(c); return c; }
    await h.sleep(1000);
  }
  throw new Error('no fresh code');
}
const statusIs = (id, re) => page.waitForFunction(([i, r]) => new RegExp(r, 'i').test(document.getElementById(i).textContent), [id, re.source], { timeout: 20000 });

before(async () => {
  await h.waitHealthy();
  user = await h.createTestUser('sec');
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => { dialogs++; d.dismiss(); });
  await page.goto(h.BASE + '/');
  await page.fill('#loginEmail', user.email);
  await page.fill('#loginPassword', user.password);
  await page.click('#loginSubmitBtn');
  await page.waitForFunction(() => !document.querySelector('#loginScreen.open'));
});

after(async () => {
  if (browser) await browser.close();
  await h.deleteTestUser(user);
});

test('the mailbox password is not what the webmail session uses', async () => {
  // The session works through the webmail's own app password: listing app passwords
  // with the real password shows it (hidden from the person's own list).
  const r = await h.engine(h.basic(user.email, user.password), [['x:AppPassword/get', { ids: null, properties: ['description'] }, 'g']]);
  assert.ok(r[0][1].list.some(a => a.description === 'IRON ID webmail'));
});

test('security tab shows two-step off and this browser', async () => {
  await page.click('#btnSettings');
  await page.click('#stab-security');
  await page.waitForFunction(() => document.querySelector('#sessionList li .this'));
  assert.equal(await page.textContent('#twoStepBadge'), 'Off');
  assert.equal(await page.locator('#appPwList li').count(), 0, 'webmail credential is not listed');
});

test('turning on two-step sign-in', async () => {
  await page.click('#twoStepStart');
  await page.waitForSelector('#twoStepSetup:not(.hidden)');
  assert.match(await page.getAttribute('#twoStepQr', 'src'), /^data:image\/svg\+xml;base64,/);
  secret = (await page.textContent('#twoStepSecret')).replace(/\s+/g, '');
  assert.match(secret, /^[A-Z2-7]{32}$/);
  await page.fill('#twoStepCode', '000000');
  await page.fill('#twoStepPassword', user.password);
  await page.click('#twoStepSetup button[type=submit]');
  await statusIs('twoStepStatus', /not right/);
  assert.equal(await page.textContent('#twoStepBadge'), 'Off', 'a wrong first code does not turn it on');
  const raw = await fetch(h.ENGINE + '/jmap/session', { headers: { authorization: h.basic(user.email, user.password) } });
  assert.equal(raw.status, 200, 'still off at the engine');
  await page.fill('#twoStepCode', await freshCode());
  await page.click('#twoStepSetup button[type=submit]');
  await statusIs('twoStepStatus', /is on/);
  assert.equal(await page.textContent('#twoStepBadge'), 'On');
  assert.ok(await page.isVisible('#pwCodeRow'), 'password change now asks for a code');
  // The password alone no longer opens the mailbox at the engine.
  const r = await fetch(h.ENGINE + '/jmap/session', { headers: { authorization: h.basic(user.email, user.password) } });
  assert.equal(r.status, 402);
});

test('sign-in needs the code; wrong and reused codes are refused', async () => {
  const noCode = await h.login(user.email, user.password, XF);
  assert.equal(noCode.status, 401);
  assert.equal(noCode.json.mfaRequired, true);
  const wrong = await h.gw('/auth/login', { method: 'POST', body: { email: user.email, password: user.password, code: '123456' }, headers: XF });
  assert.equal(wrong.status, 401);
  const code = await freshCode();
  const ok = await h.gw('/auth/login', { method: 'POST', body: { email: user.email, password: user.password, code }, headers: XF });
  assert.equal(ok.status, 200);
  const reused = await h.gw('/auth/login', { method: 'POST', body: { email: user.email, password: user.password, code }, headers: XF });
  assert.equal(reused.status, 401, 'a code works once');
  const bad = await h.gw('/auth/login', { method: 'POST', body: { email: user.email, password: 'wrong-password', code: await freshCode() }, headers: XF });
  assert.equal(bad.status, 401);
  assert.ok(!bad.json.mfaRequired, 'a wrong password does not reveal that two-step is on');
  otherDevice = ok.cookie;
});

test('signing in through the page asks for the code', async () => {
  await page.keyboard.press('Escape');
  await page.click('#btnSignOut');
  await page.waitForSelector('#loginScreen.open');
  await page.fill('#loginEmail', user.email);
  await page.fill('#loginPassword', user.password);
  await page.click('#loginSubmitBtn');
  await page.waitForSelector('#loginCodeRow:not(.hidden)');
  assert.match(await page.textContent('#loginAlert'), /two-step/i);
  await page.fill('#loginCode', await freshCode());
  await page.click('#loginSubmitBtn');
  await page.waitForFunction(() => !document.querySelector('#loginScreen.open'), null, { timeout: 15000 });
});

test('signed-in browsers: another browser can be signed out', async () => {
  await page.click('#btnSettings');
  await page.click('#stab-security');
  await page.waitForFunction(() => document.querySelectorAll('#sessionList li').length >= 2);
  const other = otherDevice;
  assert.ok((await h.gw('/proxy/jmap/session', { cookie: other })).json.username);
  await page.locator('#sessionList li', { hasNotText: 'This browser' }).first().locator('button').click();
  await page.waitForFunction(() => document.querySelectorAll('#sessionList li').length === 1);
  assert.ok(!(await h.gw('/proxy/jmap/session', { cookie: other })).json.username, 'that browser is signed out');
});

test('app password for a mail app: created once, works, can be revoked', async () => {
  await page.fill('#appPwName', 'Outlook test');
  await page.fill('#appPwPassword', 'wrong-password');
  await page.click('#appPwForm button[type=submit]');
  await statusIs('appPwStatus', /incorrect/);
  await page.fill('#appPwPassword', user.password);
  await page.click('#appPwForm button[type=submit]');
  await page.waitForSelector('#appPwNew:not(.hidden)');
  const pw = (await page.textContent('#appPwSecret')).trim();
  assert.match(pw, /^app_/);
  await page.waitForSelector('#appPwList li:has-text("Outlook test")');
  // Mail apps sign in with it, even with two-step on.
  assert.equal((await fetch(h.ENGINE + '/jmap/session', { headers: { authorization: h.basic(user.email, pw) } })).status, 200);
  // ...but it never opens the webmail or replaces the password (it would skip two-step).
  const viaApp = await h.login(user.email, pw, XF);
  assert.equal(viaApp.status, 401, 'app password refused at webmail sign-in');
  await page.click('#appPwList li:has-text("Outlook test") button');
  await page.click('#dialogOk');
  await page.waitForFunction(() => !document.querySelector('#appPwList').textContent.includes('Outlook test'));
  assert.equal((await fetch(h.ENGINE + '/jmap/session', { headers: { authorization: h.basic(user.email, pw) } })).status, 401);
});

test('password change with two-step on needs the code and signs out other browsers', async () => {
  const other = await h.gw('/auth/login', { method: 'POST', body: { email: user.email, password: user.password, code: await freshCode() }, headers: XF });
  assert.equal(other.status, 200);
  const next = 'N-' + require('crypto').randomBytes(12).toString('base64url');
  await page.fill('#pwCurrent', user.password);
  await page.fill('#pwNew', next);
  await page.fill('#pwConfirm', next);
  await page.click('#pwSubmitBtn');
  await statusIs('pwStatus', /6-digit code/);
  await page.fill('#pwCode', await freshCode());
  await page.click('#pwSubmitBtn');
  await statusIs('pwStatus', /changed/);
  user.password = next;
  assert.ok(!(await h.gw('/proxy/jmap/session', { cookie: other.cookie })).json.username, 'other browser signed out');
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#loginScreen.open') && document.getElementById('hdrUserEmail').textContent.includes('@'));
});

test('turning two-step off again', async () => {
  await page.click('#btnSettings');
  await page.click('#stab-security');
  await page.waitForSelector('#twoStepOn:not(.hidden)');
  await page.fill('#twoStepOffCode', await freshCode());
  await page.fill('#twoStepOffPassword', user.password);
  await page.click('#twoStepOn button[type=submit]');
  await statusIs('twoStepStatus', /is off/);
  const r = await h.login(user.email, user.password, XF);
  assert.equal(r.status, 200, 'password alone works again');
});

test('engine management calls are blocked through the webmail connection', async () => {
  const s = await h.login(user.email, user.password, XF);
  for (const body of [
    { using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls: [['x:AppPassword/set', { create: { a: { description: 'sneaky' } } }, 's']] },
    { using: ['urn:ietf:params:jmap:core'], methodCalls: [['x:AccountPassword/get', { ids: ['singleton'] }, 'g']] }
  ]) {
    const r = await h.gw('/proxy/jmap', { method: 'POST', cookie: s.cookie, body });
    assert.equal(r.status, 403);
  }
  const sneaky = { using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls: [['x:AppPassword/get', { ids: null }, 'g']] };
  for (const p of ['/proxy/jmap//', '/proxy/jmap//x', '/proxy/jmap/session', '/proxy/jmap/upload', '/proxy/jmap/%2F']) {
    const r = await h.gw(p, { method: 'POST', cookie: s.cookie, body: sneaky });
    assert.ok([403, 404].includes(r.status), `${p} refused (got ${r.status})`);
  }
  const bom = await fetch(h.BASE + '/proxy/jmap', { method: 'POST', headers: { cookie: 'iid_session=' + s.cookie, 'content-type': 'application/json' }, body: '\ufeff' + JSON.stringify(sneaky) });
  assert.equal(bom.status, 400, 'anything but clean JSON is refused');
  const anon = await h.gw('/proxy/jmap', { method: 'POST', body: sneaky });
  assert.equal(anon.status, 401, 'nothing is accepted before signing in');
  const ok = await h.gw('/proxy/jmap', { method: 'POST', cookie: s.cookie, body: { using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls: [['Mailbox/get', { accountId: (await h.primaryAccount(s.cookie)), ids: null, properties: ['name'] }, 'm']] } });
  assert.equal(ok.status, 200, 'normal mail calls still work');
});

test('no page errors or browser popups', () => {
  assert.deepEqual(errors, []);
  assert.equal(dialogs, 0);
});
