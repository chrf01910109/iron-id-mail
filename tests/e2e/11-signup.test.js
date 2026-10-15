// Sign-up for name@<TEST_DOMAIN>: address checks, password rules, the security puzzle, limits,
// the new account signed in with a welcome message, and the page in a real browser.
// Needs the gateway started with SIGNUP_ENABLED=true (and the default SIGNUP_PER_IP_DAY=3).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { chromium } = require('playwright');
const h = require('./helpers');

const tag = crypto.randomBytes(3).toString('hex');
const created = []; // local parts to delete afterwards
let existing, browser;
const ipBase = 10 + crypto.randomInt(200);
const XF = n => ({ 'x-forwarded-for': `198.18.${ipBase}.${n}` });
const GOOD_PW = 'Blue tables sing at noon 47';

async function puzzle() {
  const r = await h.gw('/signup-api/challenge');
  assert.equal(r.status, 200, r.text);
  const c = r.json;
  let n = 0;
  while (crypto.createHash('sha256').update(c.salt + n).digest('hex') !== c.challenge) n++;
  return { salt: c.salt, challenge: c.challenge, signature: c.signature, number: n };
}
const create = (body, headers) => h.gw('/signup-api/create', { method: 'POST', body: { acceptTerms: true, first: 'Karim', last: 'Benali', ...body }, headers });

before(async () => {
  await h.waitHealthy(120000, { requireAdmin: true });
  existing = await h.createTestUser('su-existing');
  browser = await chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  await h.deleteTestUser(existing);
  const [[, all]] = await h.engine(h.recoveryAuth(), [['x:Account/get', { ids: null, properties: ['name', 'domainId'] }, 'g']]);
  const did = await h.domainId();
  const ids = all.list.filter(a => a.domainId === did && created.includes(a.name)).map(a => a.id);
  if (ids.length) await h.engine(h.recoveryAuth(), [['x:Account/set', { destroy: ids }, 'x']]);
});

test('sign-up is open here, and says so', async () => {
  const r = await h.gw('/signup-api/config');
  assert.equal(r.status, 200);
  assert.equal(r.json.enabled, true, 'start the gateway with SIGNUP_ENABLED=true');
  assert.equal(r.json.domain, h.TEST_DOMAIN);
  const page = await h.gw('/signup');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
});

test('address check: format, reserved, taken (with suggestions), available', async () => {
  const check = local => h.gw('/signup-api/check', { method: 'POST', body: { local, first: 'Karim', last: 'Benali' }, headers: XF(1) });
  assert.equal((await check('ab')).json.reason, 'format');
  assert.equal((await check('a..b.c')).json.reason, 'format');
  assert.equal((await check('12345678')).json.reason, 'format');
  assert.equal((await check('postmaster')).json.reason, 'reserved');
  assert.equal((await check('support-team')).json.reason, 'reserved');
  const taken = await check(existing.email.split('@')[0]);
  assert.equal(taken.json.reason, 'taken');
  assert.ok(taken.json.suggestions.length >= 1);
  assert.ok(taken.json.suggestions.every(s => /^[a-z0-9][a-z0-9._-]+$/.test(s)));
  const free = await check('su-' + tag);
  assert.deepEqual(free.json, { available: true, email: `su-${tag}@${h.TEST_DOMAIN}` });
  const form = await fetch(h.BASE + '/signup-api/check', { method: 'POST', body: 'local=x', headers: { 'content-type': 'application/x-www-form-urlencoded', ...XF(1) } });
  assert.equal(form.status, 415, 'JSON only');
  const other = await h.gw('/signup-api/check', { method: 'POST', body: { local: 'x' }, headers: { origin: 'https://evil.example', ...XF(1) } });
  assert.equal(other.status, 403, 'other websites refused');
});

test('the request is refused before the puzzle is spent: name, address, password, recovery, terms', async () => {
  const pow = await puzzle();
  const local = 'su-rules-' + tag;
  const cases = [
    [{ local, password: GOOD_PW, first: '' }, 'name'],
    [{ local: 'abuse', password: GOOD_PW }, 'address'],
    [{ local, password: 'short' }, 'password'],
    [{ local, password: 'aaaaaaaaaaaaaaaa' }, 'password'],
    [{ local, password: 'qwertyuiopasdfghjkl' }, 'password'],       // in the common-password list
    [{ local, password: 'karim.benali.2026!' }, 'password'],          // contains the name
    [{ local, password: GOOD_PW, recovery: 'not-an-address' }, 'recovery'],
    [{ local, password: GOOD_PW, recovery: 'me@' + h.TEST_DOMAIN }, 'recovery']
  ];
  for (const [body, code] of cases) {
    const r = await create({ ...body, pow }, XF(2));
    assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.text}`);
    assert.equal(r.json.code, code, JSON.stringify(body));
  }
  const noTerms = await create({ local, password: GOOD_PW, pow, acceptTerms: false }, XF(2));
  assert.equal(noTerms.status, 400);
  assert.match(noTerms.json.error, /Terms of Service/);
  const fr = await create({ local, password: 'short', pow }, { ...XF(2), cookie: 'ironid_lang=fr' });
  assert.equal(fr.json.error, 'Votre mot de passe doit comporter au moins 12 caractères.');
});

test('the security puzzle: wrong answer, forged signature, and each puzzle works once', async () => {
  const pow = await puzzle();
  const local = 'su-pow-' + tag;
  const wrong = await create({ local, password: GOOD_PW, pow: { ...pow, number: pow.number + 1 } }, XF(3));
  assert.equal(wrong.json.code, 'pow');
  const forged = await create({ local, password: GOOD_PW, pow: { ...pow, signature: 'a'.repeat(64) } }, XF(3));
  assert.equal(forged.json.code, 'pow');
  const missing = await create({ local, password: GOOD_PW }, XF(3));
  assert.equal(missing.json.code, 'pow');

  const ok = await create({ local, password: GOOD_PW, pow }, XF(3));
  assert.equal(ok.status, 200, ok.text);
  created.push(local);
  const again = await create({ local: local + 'b', password: GOOD_PW, pow }, XF(3));
  assert.equal(again.json.code, 'pow', 'a used puzzle is refused');
});

test('a new account is signed in, in its language, with a welcome message; the address is then taken', async () => {
  const local = 'su-new-' + tag;
  const r = await create({ local, password: GOOD_PW, recovery: 'karim@example.com', pow: await puzzle() }, { ...XF(4), cookie: 'ironid_lang=fr' });
  assert.equal(r.status, 200, r.text);
  created.push(local);
  assert.equal(r.json.email, `${local}@${h.TEST_DOMAIN}`);
  assert.equal(r.json.lang, 'fr');
  assert.ok(r.cookie, 'session cookie');
  assert.match(r.setCookie, /ironid_lang=fr/);
  const me = await h.gw('/account/me', { cookie: r.cookie });
  assert.equal(me.json.email, r.json.email);
  assert.equal(me.json.lang, 'fr');
  assert.equal(me.json.admin, false);

  const acc = await h.primaryAccount(r.cookie);
  const res = await h.mail(r.cookie, [
    ['Email/query', { accountId: acc }, 'q'],
    ['Email/get', { accountId: acc, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject', 'from', 'keywords'] }, 'g']
  ]);
  const list = res.find(x => x[2] === 'g')[1].list;
  assert.equal(list.length, 1);
  assert.equal(list[0].subject, 'Bienvenue sur IRON ID Mail');
  assert.equal(list[0].from[0].email, 'hello@' + h.TEST_DOMAIN);
  assert.ok(!list[0].keywords.$seen, 'unread');

  // The password works for a normal sign-in too.
  const login = await h.login(r.json.email, GOOD_PW, XF(5));
  assert.equal(login.status, 200, login.text);

  const check = await h.gw('/signup-api/check', { method: 'POST', body: { local }, headers: XF(4) });
  assert.equal(check.json.reason, 'taken');
  const dup = await create({ local, password: GOOD_PW, pow: await puzzle() }, XF(6));
  assert.equal(dup.status, 409);
  assert.equal(dup.json.code, 'taken');
});

test('at most 3 accounts a day from one network', async () => {
  const ip = XF(7);
  for (let i = 1; i <= 3; i++) {
    const local = `su-lim${i}-${tag}`;
    const r = await create({ local, password: GOOD_PW, pow: await puzzle() }, ip);
    assert.equal(r.status, 200, r.text);
    created.push(local);
  }
  const fourth = await create({ local: 'su-lim4-' + tag, password: GOOD_PW, pow: await puzzle() }, ip);
  assert.equal(fourth.status, 429);
  assert.match(fourth.json.error, /from this network today/);
});

test('the sign-up page in a real browser: three steps, then the mailbox with the welcome message', async () => {
  const ctx = await browser.newContext({ locale: 'en-GB', viewport: { width: 1280, height: 900 }, extraHTTPHeaders: XF(8) });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  // The sign-in card links to sign-up.
  await page.goto(h.BASE + '/');
  await page.waitForSelector('#loginSignup:not(.hidden) a[href="/signup"]');
  await page.click('#loginSignup a');
  await page.waitForSelector('#suForm:not(.hidden)');
  assert.match(await page.textContent('#suStepOf'), /Step 1 of 3/);

  // Step 1: the address is suggested from the name and checked live.
  const local = 'su-ui-' + tag;
  await page.fill('#suFirst', 'Amina');
  await page.fill('#suLast', 'Kaci');
  await page.fill('#suLocal', existing.email.split('@')[0]);
  await page.waitForSelector('#suAddrStatus.err');
  assert.ok(await page.isDisabled('#suNext'), 'taken: cannot continue');
  assert.ok(await page.isVisible('#suSuggest .preset-btn'));
  await page.fill('#suLocal', local);
  await page.waitForSelector('#suAddrStatus.ok');
  assert.match(await page.textContent('#suAddrStatus'), new RegExp(local + '@'));
  await page.click('#suNext');

  // Step 2: password.
  await page.waitForSelector('[data-step="2"]:not(.hidden)');
  assert.equal(await page.textContent('#suAddrShow'), `${local}@${h.TEST_DOMAIN}`);
  await page.fill('#suPw', 'short');
  assert.ok(await page.isDisabled('#suNext'));
  await page.fill('#suPw', GOOD_PW);
  await page.click('#suNext');

  // Step 3: the puzzle runs by itself; terms must be accepted.
  await page.waitForSelector('[data-step="3"]:not(.hidden)');
  await page.waitForSelector('#suPowBadge.on', { timeout: 30000 });
  assert.ok(await page.isDisabled('#suNext'), 'terms not accepted yet');
  await page.check('#suTerms');
  await page.click('#suNext');
  await page.waitForSelector('#suDone:not(.hidden)', { timeout: 30000 });
  created.push(local);
  assert.equal(await page.textContent('#suWelcome'), 'Welcome, Amina');

  // Straight into the mailbox, already signed in, with the welcome message.
  await page.click('#suDone a.su-open');
  await page.waitForSelector('#emailList .email-item', { timeout: 30000 });
  assert.match(await page.textContent('#emailList'), /Welcome to IRON ID Mail/);
  assert.equal((await page.textContent('#hdrUserEmail')).trim(), `${local}@${h.TEST_DOMAIN}`);
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('the sign-up page in French, and the draft legal pages', async () => {
  const ctx = await browser.newContext({ locale: 'fr-FR', viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(h.BASE + '/signup');
  await page.waitForSelector('#suForm:not(.hidden)');
  assert.equal(await page.getAttribute('html', 'lang'), 'fr');
  assert.match(await page.textContent('#suStepOf'), /Étape 1 sur 3/);
  assert.equal(await page.textContent('label[for="suFirst"]'), 'Prénom');
  assert.match(await page.textContent('#suIntro'), /@iron-id\.io|@/);
  const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  assert.ok(noScroll, 'no sideways scrolling on a phone');
  await ctx.close();
  for (const p of ['terms', 'acceptable-use', 'privacy']) {
    const r = await h.gw('/legal/' + p);
    assert.equal(r.status, 200, p);
    assert.match(r.text, /Draft, version 2026-10/);
  }
  assert.equal((await h.gw('/legal/other')).status, 404);
});
