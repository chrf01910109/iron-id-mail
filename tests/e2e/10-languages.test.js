// English and French: the gateway's messages, the saved language, and the webmail and admin
// console in a real browser. Needs PLATFORM_ADMINS to include e2e-platform-admin@<TEST_DOMAIN>.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const h = require('./helpers');

let user, platform, browser;
const errors = [];
const XF = n => ({ 'x-forwarded-for': `198.51.100.${n}` });
const langCookie = setCookie => (String(setCookie).match(/ironid_lang=(\w+)/) || [])[1];

before(async () => {
  await h.waitHealthy(120000, { requireAdmin: true });
  user = await h.createTestUser('lang');
  platform = await h.createTestUser('e2e-platform-admin', { exactName: true });
  browser = await chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  await h.deleteTestUser(user);
  await h.deleteTestUser(platform);
});

test('the page is served in the browser’s language; English stays the default', async () => {
  const fr = await h.gw('/', { headers: { 'accept-language': 'fr-DZ,fr;q=0.9,en;q=0.5' } });
  assert.match(fr.text, /<html lang="fr" class="i18n-wait">/);
  const en = await h.gw('/', { headers: { 'accept-language': 'en-US,en;q=0.9' } });
  assert.match(en.text, /<html lang="en">/);
  const other = await h.gw('/');
  assert.match(other.text, /<html lang="en">/, 'no Accept-Language: English');
  const cookieWins = await h.gw('/admin', { headers: { 'accept-language': 'en', cookie: 'ironid_lang=fr' } });
  assert.match(cookieWins.text, /<html lang="fr"/);
  const bogus = await h.gw('/', { headers: { cookie: 'ironid_lang="><script>' } });
  assert.match(bogus.text, /<html lang="en">/, 'an unknown cookie value is ignored');
});

test('gateway messages come back in French, and unchanged in English', async () => {
  const body = { email: user.email, password: 'wrong-password-123' };
  const fr = await h.gw('/auth/login', { method: 'POST', body, headers: { ...XF(201), cookie: 'ironid_lang=fr' } });
  assert.equal(fr.status, 401);
  assert.equal(fr.json.error, 'Identifiants de boîte mail incorrects');
  const en = await h.gw('/auth/login', { method: 'POST', body, headers: XF(202) });
  assert.equal(en.json.error, 'Invalid mailbox credentials');
  const signedOut = await h.gw('/account/security', { headers: { 'accept-language': 'fr' } });
  assert.equal(signedOut.status, 401);
  assert.equal(signedOut.json.error, 'Votre session a expiré. Veuillez vous reconnecter.');
});

test('the language is saved to the account and follows the person at sign-in', async () => {
  // First sign-in: nothing saved yet → the browser's language, and a cookie for it.
  let r = await h.login(user.email, user.password, { ...XF(203), 'accept-language': 'en-GB' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.lang, 'en');
  assert.equal(langCookie(r.setCookie), 'en');
  const S = r.cookie;
  let p = await h.gw('/account/prefs', { cookie: S });
  assert.deepEqual(p.json, { lang: 'en', languages: ['en', 'fr'] });

  // Settings → Preferences → Français.
  const bad = await h.gw('/account/prefs', { method: 'POST', cookie: S, body: { lang: 'ar' } });
  assert.equal(bad.status, 400);
  const set = await h.gw('/account/prefs', { method: 'POST', cookie: S, body: { lang: 'fr' } });
  assert.equal(set.status, 200, set.text);
  assert.equal(langCookie(set.setCookie), 'fr');
  assert.match(set.setCookie, /SameSite=Lax/);
  assert.doesNotMatch(set.setCookie, /HttpOnly/, 'the page reads it before sign-in');

  // A browser already signed in learns the new language from /account/me on its next load.
  const me = await h.gw('/account/me', { cookie: S });
  assert.equal(me.json.lang, 'fr');
  // French answers keep their dates (recent sign-ins come from the database as dates).
  const sec = await h.gw('/account/security', { headers: { cookie: `iid_session=${S}; ironid_lang=fr` } });
  assert.equal(sec.status, 200, sec.text);
  assert.ok(sec.json.recentSignIns.length > 0);
  assert.ok(!Number.isNaN(Date.parse(sec.json.recentSignIns[0].at)), 'a real date, not {}');

  // Another device with an English browser: the account's French wins.
  r = await h.login(user.email, user.password, { ...XF(204), 'accept-language': 'en-US' });
  assert.equal(r.json.lang, 'fr');
  assert.equal(langCookie(r.setCookie), 'fr');

  // Choosing on the sign-in screen saves the new choice.
  r = await h.gw('/auth/login', { method: 'POST', body: { email: user.email, password: user.password, lang: 'en' }, headers: XF(205) });
  assert.equal(r.json.lang, 'en');
  p = await h.gw('/account/prefs', { cookie: r.cookie });
  assert.equal(p.json.lang, 'en');
});

test('webmail in French: sign-in screen, language buttons, mailbox, settings', async () => {
  const ctx = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(h.BASE + '/');
  await page.waitForSelector('#loginScreen.open');
  assert.equal(await page.getAttribute('html', 'lang'), 'fr');
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('i18n-wait')), false, 'page shown');
  assert.equal((await page.textContent('#loginSubmitBtn')).trim(), 'Se connecter');
  assert.equal(await page.getAttribute('#loginPassword', 'type'), 'password');
  assert.equal(await page.textContent('label[for="loginEmail"]'), 'Adresse e-mail');

  // Switch the sign-in screen to English and back to French with the buttons.
  await Promise.all([page.waitForNavigation(), page.click('.login-lang [data-lang="en"]')]);
  assert.equal((await page.textContent('#loginSubmitBtn')).trim(), 'Sign in');
  assert.equal(await page.getAttribute('.login-lang [data-lang="en"]', 'aria-pressed'), 'true');
  await Promise.all([page.waitForNavigation(), page.click('.login-lang [data-lang="fr"]')]);
  assert.equal((await page.textContent('#loginSubmitBtn')).trim(), 'Se connecter');

  // Sign in: the French picked on this screen is saved to the account.
  await page.fill('#loginEmail', user.email);
  await page.fill('#loginPassword', user.password);
  await page.click('#loginSubmitBtn');
  await page.waitForFunction(() => !document.querySelector('#loginScreen.open') && document.getElementById('hdrUserEmail').textContent.includes('@'), null, { timeout: 30000 });
  await page.waitForSelector('#folderList .sb-btn');
  const sidebar = await page.textContent('#folderList');
  assert.match(sidebar, /Boîte de réception/);
  assert.doesNotMatch(sidebar, /Inbox/);
  assert.match(await page.textContent('#btnCompose'), /Nouveau message/);
  assert.match(await page.textContent('#btnSettings'), /Paramètres/);
  assert.equal(await page.getAttribute('#searchInput', 'placeholder'), 'Rechercher dans les messages');

  // No English left in the main screen's visible text (besides names and addresses).
  const visible = await page.evaluate(() => document.body.innerText);
  for (const word of ['Inbox', 'Drafts', 'Settings', 'Sign out', 'Compose', 'Mark all read', 'Unread', 'Starred', 'Folders', 'Labels', 'Storage', 'Select a message']) {
    assert.ok(!visible.includes(word), `"${word}" is still in English`);
  }

  // Settings → Preferences shows French selected; switching to English reloads in English.
  await page.click('#btnSettings');
  await page.click('#stab-preferences');
  assert.equal(await page.inputValue('#prefLang'), 'fr');
  assert.equal(await page.textContent('label[for="prefLang"]'), 'Langue');
  await page.selectOption('#prefLang', 'en');
  await Promise.all([page.waitForNavigation(), page.click('#prefsForm button[type="submit"]')]);
  await page.waitForSelector('#folderList .sb-btn');
  assert.match(await page.textContent('#folderList'), /^Inbox/);
  const p = await h.gw('/account/prefs', { cookie: (await ctx.cookies()).find(c => c.name === 'iid_session').value });
  assert.equal(p.json.lang, 'en');
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('admin console in French', async () => {
  const ctx = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(h.BASE + '/');
  await page.fill('#loginEmail', platform.email);
  await page.fill('#loginPassword', platform.password);
  await page.click('#loginSubmitBtn');
  await page.waitForFunction(() => !document.querySelector('#loginScreen.open'), null, { timeout: 30000 });
  await page.goto(h.BASE + '/admin');
  await page.waitForSelector('#adminNav .sb-btn');
  assert.equal(await page.getAttribute('html', 'lang'), 'fr');
  const nav = await page.textContent('#adminNav');
  assert.match(nav, /Vue d’ensemble/);
  assert.match(nav, /Domaines/);
  assert.doesNotMatch(nav, /Overview|Domains|Mailboxes/);
  await page.waitForSelector('#page .page-head h1');
  assert.doesNotMatch(await page.textContent('#page'), /Loading|Overview/);
  await ctx.close();
  assert.deepEqual(errors, []);
});
