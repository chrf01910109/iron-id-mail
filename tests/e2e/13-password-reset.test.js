// "Forgot password?": the recovery address in Settings (outside IRON ID, confirmed with a code sent to it),
// the same answer for any address, the link mailed to the confirmed recovery address, one use only,
// everyone signed out afterwards, links cancelled when the address or password changes or an
// administrator steps in, admins left out, and the page in a real browser.
// Needs the gateway started with PASSWORD_RESET_ENABLED=true, PUBLIC_URL=<BASE_URL> and
// IRONID_RECOVERY_TEST_DOMAIN=recovery-e2e.test (the throwaway domain this test uses as "outside" mail),
// and PLATFORM_ADMINS including e2e-platform-admin@<TEST_DOMAIN>.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { chromium } = require('playwright');
const h = require('./helpers');

const tag = crypto.randomBytes(3).toString('hex');
const RDOMAIN = 'recovery-e2e.test';
const HOSTED = `hosted-${tag}.test`;
const SUBJECT = 'Reset your IRON ID password';
const CODE_SUBJECT = 'Confirm your IRON ID recovery address';
const NEW_PW = 'Seven quiet lanterns drift home 82';
const ipBase = 10 + crypto.randomInt(200);
const XF = n => ({ 'x-forwarded-for': `198.19.${ipBase}.${n}` });
let rDomainId, hostedId, createdRDomain = false, inbox, inbox2, platform, P, browser;
const users = {};
const seen = new Set(); // account id + message id (ids repeat across accounts)
const seenValues = new Set(); // a message delivered twice must not give the same code again

async function userOn(domainId, domain, prefix) {
  const name = `${prefix}-${crypto.randomBytes(3).toString('hex')}`;
  const password = 'T-' + crypto.randomBytes(18).toString('base64url');
  const [[, res]] = await h.engine(h.recoveryAuth(), [['x:Account/set', { create: { u: {
    '@type': 'User', name, domainId, description: 'Throwaway e2e test account',
    roles: { '@type': 'User' }, permissions: { '@type': 'Inherit' }, encryptionAtRest: { '@type': 'Disabled' },
    credentials: { 0: { '@type': 'Password', secret: password } }
  } } }, 'c']]);
  if (!res.created || !res.created.u) throw new Error('could not create user: ' + JSON.stringify(res.notCreated));
  return { id: res.created.u.id, email: `${name}@${domain}`, password };
}
async function makeDomain(name) {
  const [[, all]] = await h.engine(h.recoveryAuth(), [['x:Domain/get', { ids: null, properties: ['name'] }, 'd']]);
  const old = all.list.find(d => d.name === name);
  if (old) return { id: old.id, created: false };
  const [[, d]] = await h.engine(h.recoveryAuth(), [['x:Domain/set', { create: { d: { name, dkimManagement: { '@type': 'Manual' } } } }, 'd']]);
  if (!d.created || !d.created.d) throw new Error('could not create the test domain: ' + JSON.stringify(d.notCreated));
  return { id: d.created.d.id, created: true };
}
async function signedIn(u, n) {
  const r = await h.login(u.email, u.password, XF(n));
  assert.equal(r.status, 200, r.text);
  u.cookie = r.cookie;
  return u;
}

const ask = (email, n = 1) => h.gw('/recover-api/request', { method: 'POST', body: { email }, headers: XF(n) });
// Account calls carry their own test network, so wrong-password checks here don't add to other tests' counts.
const OK_NET = 30, BAD_NET = 31;
const setRecovery = (cookie, body, n = OK_NET) => h.gw('/account/recovery', { method: 'POST', cookie, body, headers: XF(n) });
const sendCode = (cookie, body, n = OK_NET) => h.gw('/account/recovery/code', { method: 'POST', cookie, body, headers: XF(n) });
const check = (token, n = 2) => h.gw('/recover-api/check', { method: 'POST', body: { token }, headers: XF(n) });

/** Waits for a new message with `subject` about `email` in `box`; returns the first match of `re` in its text. */
async function waitFor(box, subject, email, re, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const [, [, got]] = await h.mail(box.cookie, [
      ['Email/query', { accountId: box.acct, filter: { subject }, sort: [{ property: 'receivedAt', isAscending: false }] }, 'q'],
      ['Email/get', { accountId: box.acct, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
        properties: ['subject', 'from', 'textBody', 'bodyValues'], fetchTextBodyValues: true }, 'g']]);
    for (const m of got.list) {
      const key = box.acct + '/' + m.id;
      if (seen.has(key)) continue;
      const text = Object.values(m.bodyValues || {}).map(v => v.value).join('\n');
      if (email && !text.includes(email)) continue;
      seen.add(key);
      const found = re.exec(text);
      assert.ok(found, 'unexpected message text: ' + text);
      if (seenValues.has(subject + '/' + email + '/' + found[1])) continue;
      seenValues.add(subject + '/' + email + '/' + found[1]);
      return found[1];
    }
    await h.sleep(1000);
  }
  if (process.env.DEBUG_WAIT) {
    const [, [, all]] = await h.mail(box.cookie, [['Email/query', { accountId: box.acct }, 'q'],
      ['Email/get', { accountId: box.acct, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject', 'bodyValues'], fetchTextBodyValues: true }, 'g']]);
    console.error('waitFor timeout', subject, email, JSON.stringify(all.list.map(m => [m.id, m.subject, seen.has(box.acct + '/' + m.id), Object.values(m.bodyValues || {}).map(v => v.value).join('').includes(email)])));
  }
  return null;
}
const LINK_RE = () => new RegExp(h.BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/forgot#token=([A-Za-z0-9_-]{43})');
const linkFor = (email, ms, box = inbox) => waitFor(box, SUBJECT, email, LINK_RE(), ms);
const codeFor = (email, ms, box = inbox) => waitFor(box, CODE_SUBJECT, email, /\n(\d{6})\n/, ms);

/** Saves `addr` as the recovery address of `u` and confirms it with the code sent there. */
async function setAndConfirm(u, box = inbox) {
  const r = await setRecovery(u.cookie, { recoveryEmail: box.email, currentPassword: u.password });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.recovery, { email: box.email, verified: false, codeSent: true });
  const code = await codeFor(u.email, 60000, box);
  assert.ok(code, 'no confirmation code arrived');
  const c = await h.gw('/account/recovery/confirm', { method: 'POST', cookie: u.cookie, body: { code } });
  assert.equal(c.status, 200, c.text);
  assert.equal(c.json.recovery.verified, true);
}
/** Waits until the mailbox's own inbox holds a message with this subject (notices from IRON ID). */
async function hasNotice(u, subject, timeoutMs = 30000) {
  const acct = await h.primaryAccount(u.cookie);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const [, [, got]] = await h.mail(u.cookie, [
      ['Email/query', { accountId: acct, sort: [{ property: 'receivedAt', isAscending: false }], limit: 50 }, 'q'],
      ['Email/get', { accountId: acct, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject', 'from'] }, 'g']]);
    if (got.list.some(m => m.subject === subject && m.from && m.from[0].email.startsWith('no-reply@'))) return true;
    await h.sleep(1000);
  }
  return false;
}

before(async () => {
  await h.waitHealthy(120000, { requireAdmin: true });
  ({ id: rDomainId, created: createdRDomain } = await makeDomain(RDOMAIN));
  ({ id: hostedId } = await makeDomain(HOSTED));
  inbox = await userOn(rDomainId, RDOMAIN, 'rinbox');
  inbox2 = await userOn(rDomainId, RDOMAIN, 'rinbox2');
  for (const b of [inbox, inbox2]) { await signedIn(b, 1); b.acct = await h.primaryAccount(b.cookie); }
  for (const k of ['target', 'adminish', 'other', 'unconf', 'chg', 'pwc', 'adm', 'par', 'lock']) users[k] = await h.createTestUser('fp-' + k);
  platform = await h.createTestUser('e2e-platform-admin', { exactName: true });
  P = (await signedIn(platform, 9)).cookie;
  browser = await chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  for (const u of [...Object.values(users), inbox, inbox2, platform]) await h.deleteTestUser(u);
  if (hostedId) await h.engine(h.recoveryAuth(), [['x:Domain/set', { destroy: [hostedId] }, 'x']]).catch(() => {});
  if (rDomainId && createdRDomain) await h.engine(h.recoveryAuth(), [['x:Domain/set', { destroy: [rDomainId] }, 'x']]).catch(() => {});
});

test('recovery by email is open here, and its page loads', async () => {
  const c = await h.gw('/recover-api/config');
  assert.equal(c.status, 200);
  assert.equal(c.json.enabled, true, 'start the gateway with PASSWORD_RESET_ENABLED=true and PUBLIC_URL');
  const page = await h.gw('/forgot');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  const hz = (await h.gw('/healthz')).json;
  assert.equal(hz.recoveryLinks, 'on');
  assert.ok((hz.testFeatures || []).includes('recovery-test-domain'), 'the test domain switch is listed as test-only');
});

test('the recovery address needs the password and must be outside IRON ID', async () => {
  const t = await signedIn(users.target, 2);
  const wrong = await setRecovery(t.cookie, { recoveryEmail: inbox.email, currentPassword: 'not the password' }, BAD_NET);
  assert.equal(wrong.status, 400);
  await h.sleep(500);
  assert.equal((await h.gw('/account/security', { cookie: t.cookie })).json.recovery, null, 'a refused request changes nothing');
  for (const inside of [`someone@${h.TEST_DOMAIN}`, `someone@sub.${h.TEST_DOMAIN}`, `someone@${HOSTED}`, `x@mail.${HOSTED}`, t.email.toUpperCase()]) {
    const r = await setRecovery(t.cookie, { recoveryEmail: inside, currentPassword: t.password });
    assert.equal(r.status, 400, inside + ' ' + r.text);
    assert.equal(r.json.code, 'recovery', inside);
  }
  assert.equal((await setRecovery(t.cookie, { recoveryEmail: 'not an address', currentPassword: t.password })).status, 400);
  const cross = await h.gw('/account/recovery', { method: 'POST', cookie: t.cookie, body: { recoveryEmail: '', currentPassword: t.password }, headers: { ...XF(OK_NET), origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
});

test('a new recovery address is confirmed with a code sent to it; the mailbox gets a notice', async () => {
  const t = users.target;
  const r = await setRecovery(t.cookie, { recoveryEmail: inbox.email.toUpperCase(), currentPassword: t.password });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.recovery, { email: inbox.email, verified: false, codeSent: true });
  const code = await codeFor(t.email);
  assert.ok(code, 'no confirmation code arrived');
  const bad = await h.gw('/account/recovery/confirm', { method: 'POST', cookie: t.cookie, body: { code: code === '000000' ? '111111' : '000000' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'code');
  const ok = await h.gw('/account/recovery/confirm', { method: 'POST', cookie: t.cookie, body: { code } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.recovery.verified, true);
  assert.equal((await h.gw('/account/security', { cookie: t.cookie })).json.recovery.verified, true);
  assert.ok(await hasNotice(t, 'Your recovery address was changed'), 'notice in the mailbox');
});

test('too many wrong codes end the code', async () => {
  const u = await signedIn(users.lock, 3);
  assert.equal((await setRecovery(u.cookie, { recoveryEmail: inbox.email, currentPassword: u.password })).status, 200);
  const code = await codeFor(u.email);
  assert.ok(code);
  const wrongCode = String((Number(code) + 1) % 1000000).padStart(6, '0');
  for (let i = 0; i < 5; i++) assert.equal((await h.gw('/account/recovery/confirm', { method: 'POST', cookie: u.cookie, body: { code: wrongCode } })).status, 400);
  const late = await h.gw('/account/recovery/confirm', { method: 'POST', cookie: u.cookie, body: { code } });
  assert.equal(late.status, 400, 'the right code no longer works after 5 wrong ones');
  const noPw = await sendCode(u.cookie, {}, BAD_NET);
  assert.equal(noPw.status, 400, 'sending a code needs the password');
  await h.sleep(1500);
  assert.equal(await codeFor(u.email, 3000), null, 'and a refused request sends nothing');
  const again = await sendCode(u.cookie, { currentPassword: u.password });
  assert.equal(again.status, 200, again.text);
  const fresh = await codeFor(u.email);
  const last = await h.gw('/account/recovery/confirm', { method: 'POST', cookie: u.cookie, body: { code: fresh } });
  if (last.status !== 200) { // say which codes arrived, to tell a delivery problem from a code problem
    const [, [, got]] = await h.mail(inbox.cookie, [
      ['Email/query', { accountId: inbox.acct, filter: { subject: CODE_SUBJECT }, sort: [{ property: 'receivedAt', isAscending: false }] }, 'q'],
      ['Email/get', { accountId: inbox.acct, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['receivedAt', 'bodyValues'], fetchTextBodyValues: true }, 'g']]);
    const mine = got.list.map(m => [m.id, m.receivedAt, Object.values(m.bodyValues || {}).map(v => v.value).join('')]).filter(x => x[2].includes(u.email)).map(x => [x[0], x[1], (/\n(\d{6})\n/.exec(x[2]) || [])[1]]);
    assert.fail(`fresh ${fresh} refused (${last.text}); codes for this mailbox: ${JSON.stringify(mine)}; first ${code}`);
  }
});

test('asking for a link gives the same answer for any address; unconfirmed addresses get nothing', async () => {
  const u = await signedIn(users.unconf, 4);
  assert.equal((await setRecovery(u.cookie, { recoveryEmail: inbox2.email, currentPassword: u.password })).status, 200);
  const unknown = await ask(`nobody-${tag}@${h.TEST_DOMAIN}`, 1);
  const known = await ask(users.target.email, 1);
  const unconfirmed = await ask(u.email, 1);
  for (const r of [unknown, known, unconfirmed]) { assert.equal(r.status, 200); assert.equal(r.text, known.text); }
  assert.equal((await ask('not-an-address', 1)).status, 400);
  const cross = await h.gw('/recover-api/request', { method: 'POST', body: { email: users.target.email }, headers: { ...XF(1), origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  assert.equal(await linkFor(u.email, 4000, inbox2), null, 'no link to an unconfirmed address');
});

test('the link arrives at the recovery address, works once, signs everyone out and leaves a notice', async () => {
  const t = users.target;
  const token = await linkFor(t.email);
  assert.ok(token, 'no reset message arrived');
  const who = await check(token);
  assert.equal(who.status, 200, who.text);
  assert.equal(who.json.email, t.email);

  // A weak password is refused and the link still works afterwards.
  const weak = await h.gw('/recover-api/reset', { method: 'POST', body: { token, password: 'short' }, headers: XF(2) });
  assert.equal(weak.status, 400);
  assert.equal(weak.json.code, 'password');
  const done = await h.gw('/recover-api/reset', { method: 'POST', body: { token, password: NEW_PW }, headers: XF(2) });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.email, t.email);

  const again = await h.gw('/recover-api/reset', { method: 'POST', body: { token, password: NEW_PW + '!' }, headers: XF(2) });
  assert.equal(again.status, 400);
  assert.equal(again.json.code, 'expired');
  assert.equal((await h.gw('/account/security', { cookie: t.cookie })).status, 401, 'the old session ended');
  assert.equal((await h.login(t.email, t.password, XF(3))).status, 401, 'the old password no longer works');
  t.password = NEW_PW;
  await signedIn(t, 3);
  assert.equal((await h.gw('/account/security', { cookie: t.cookie })).json.recovery.verified, true);
  assert.ok(await hasNotice(t, 'Your password was reset'), 'notice in the mailbox');
});

test('a newer link replaces the older one; made-up links are refused', async () => {
  const t = users.target;
  await ask(t.email, 4);
  const first = await linkFor(t.email);
  assert.ok(first);
  await ask(t.email, 4);
  const second = await linkFor(t.email);
  assert.ok(second);
  assert.equal((await check(first, 4)).status, 400);
  assert.equal((await check(second, 4)).status, 200);
  assert.equal((await check(crypto.randomBytes(32).toString('base64url'), 4)).status, 400);
  assert.equal((await check('../../etc', 4)).status, 400);
});

test('changing the recovery address cancels links already sent', async () => {
  const u = await signedIn(users.chg, 5);
  await setAndConfirm(u);
  await ask(u.email, 5);
  const token = await linkFor(u.email);
  assert.ok(token);
  const r = await setRecovery(u.cookie, { recoveryEmail: inbox2.email, currentPassword: u.password });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.recovery.verified, false);
  assert.equal((await check(token, 5)).status, 400, 'the link sent to the old address stopped working');
});

test("the owner's password change cancels links and asks to confirm the recovery address again", async () => {
  const u = await signedIn(users.pwc, 6);
  await setAndConfirm(u);
  await ask(u.email, 6);
  const token = await linkFor(u.email);
  assert.ok(token);
  const next = 'Brass kettles hum at dawn 4417';
  const ch = await h.gw('/account/password', { method: 'POST', cookie: u.cookie, body: { currentPassword: u.password, newPassword: next }, headers: XF(OK_NET) });
  assert.equal(ch.status, 200, ch.text);
  assert.equal(ch.json.recoveryToConfirm, true);
  u.password = next; u.cookie = ch.cookie || u.cookie;
  assert.equal((await check(token, 6)).status, 400, 'the link stopped working');
  await signedIn(u, 6);
  assert.equal((await h.gw('/account/security', { cookie: u.cookie })).json.recovery.verified, false);
  // A session alone (no password) can't get a new code sent to the saved address.
  assert.equal((await sendCode(u.cookie, {}, BAD_NET)).status, 400);
  assert.equal((await sendCode(u.cookie, { currentPassword: 'wrong password here' }, BAD_NET)).status, 400);
  await ask(u.email, 6);
  assert.equal(await linkFor(u.email, 4000), null, 'no link until the address is confirmed again');
});

test("an administrator's sign-in reset removes the recovery address and its links", async () => {
  const u = await signedIn(users.adm, 7);
  await setAndConfirm(u);
  await ask(u.email, 7);
  const token = await linkFor(u.email);
  assert.ok(token);
  const r = await h.gw('/admin-api/mailboxes/reset-signin', { method: 'POST', cookie: P, body: { id: u.id } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await check(token, 7)).status, 400, 'the link stopped working');
  const s = await signedIn({ email: u.email, password: r.json.password }, 7);
  assert.equal((await h.gw('/account/security', { cookie: s.cookie })).json.recovery, null, 'the recovery address was removed');
});

test('requests arriving together send at most 3 links an hour, and only the newest works', async () => {
  const u = await signedIn(users.par, 8);
  await setAndConfirm(u);
  await Promise.all([20, 21, 22, 23, 24, 25].map(n => ask(u.email, n)));
  const tokens = [];
  for (;;) { const tk = await linkFor(u.email, tokens.length < 3 ? 60000 : 6000); if (!tk) break; tokens.push(tk); }
  assert.equal(tokens.length, 3, 'exactly 3 links');
  const working = [];
  for (const tk of tokens) if ((await check(tk, 8)).status === 200) working.push(tk);
  assert.equal(working.length, 1, 'only one link works');
});

test('engine administrators get no link, even with a confirmed recovery address', async () => {
  const { adminish, other } = users;
  for (const u of [adminish, other]) { await signedIn(u, 5); await setAndConfirm(u); }
  const [[, up]] = await h.engine(h.recoveryAuth(), [['x:Account/set', { update: { [adminish.id]: { roles: { '@type': 'Admin' } } } }, 'u']]);
  assert.ok(up.updated && adminish.id in up.updated, JSON.stringify(up));
  assert.equal((await ask(adminish.email, 10)).status, 200);
  assert.equal((await ask(other.email, 10)).status, 200);
  assert.ok(await linkFor(other.email), 'the ordinary mailbox got its link');
  assert.equal(await linkFor(adminish.email, 3000), null, 'no link for the administrator');
});

test('the page in a real browser: ask for a link, open it, choose a new password', async () => {
  const other = users.other;
  const ctx = await browser.newContext({ locale: 'en-GB', viewport: { width: 1280, height: 900 }, extraHTTPHeaders: XF(11) });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(h.BASE + '/');
  await page.click('#loginForgot:not(.hidden) a[href="/forgot"]');
  await page.waitForSelector('#fpAsk:not(.hidden)');
  await page.fill('#fpEmail', other.email);
  await page.click('#fpAskBtn');
  await page.waitForSelector('#fpSent:not(.hidden)');

  const token = await linkFor(other.email);
  assert.ok(token);
  await page.goto('about:blank'); // a new page load, as when the link is opened from the mail
  await page.goto(`${h.BASE}/forgot#token=${token}`);
  await page.waitForSelector('#fpReset:not(.hidden)');
  assert.equal(await page.textContent('#fpWho'), other.email);
  assert.ok(!page.url().includes('token='), 'the token is removed from the address bar');
  await page.fill('#fpPw', NEW_PW);
  await page.fill('#fpPw2', NEW_PW + 'x');
  await page.click('#fpResetBtn');
  await page.waitForSelector('#fpResetError.login-alert');
  await page.fill('#fpPw2', NEW_PW);
  await page.click('#fpResetBtn');
  await page.waitForSelector('#fpDone:not(.hidden)');
  assert.equal((await h.login(other.email, NEW_PW, XF(12))).status, 200);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Settings: the recovery card asks for the code and confirms the address', async () => {
  const u = users.unconf; // its address (inbox2) is saved but not confirmed
  assert.ok(await codeFor(u.email, 30000, inbox2), 'the code sent when the address was saved'); // replaced by the one asked below
  const ctx = await browser.newContext({ locale: 'en-GB', viewport: { width: 1280, height: 900 }, extraHTTPHeaders: XF(13) });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(h.BASE + '/');
  await page.fill('#loginEmail', u.email);
  await page.fill('#loginPassword', u.password);
  await page.click('#loginSubmitBtn');
  await page.waitForSelector('#btnSettings', { state: 'visible', timeout: 30000 });
  await page.click('#btnSettings');
  await page.click('#stab-security');
  await page.waitForSelector('#recConfirm:not(.hidden)');
  assert.match(await page.textContent('#recBadge'), /Not confirmed/);
  await page.click('#recResendBtn');
  await page.waitForSelector('#recConfirmStatus.err');
  assert.match(await page.textContent('#recConfirmStatus'), /password/i, 'the password is asked for');
  await page.fill('#recSendPassword', u.password);
  await page.click('#recResendBtn');
  const code = await codeFor(u.email, 60000, inbox2);
  assert.ok(code);
  await page.waitForSelector('#recConfirmCode:visible');
  await page.fill('#recConfirmCode', code);
  await page.click('#recConfirmBtn');
  await page.waitForSelector('#recBadge.on', { timeout: 15000 }).catch(async e => { throw new Error(e.message + ' — ' + await page.textContent('#recConfirmStatus')); });
  assert.match(await page.textContent('#recBadge'), /Confirmed/);
  assert.deepEqual(errors, []);
  await ctx.close();
});
