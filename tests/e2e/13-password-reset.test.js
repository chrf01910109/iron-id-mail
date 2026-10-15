// "Forgot password?": the recovery address in Settings, the same answer for any address, the link
// mailed to the recovery address (a mailbox on a throwaway domain of this engine), one use only,
// everyone signed out afterwards, admins left out, and the page in a real browser.
// Needs the gateway started with PASSWORD_RESET_ENABLED=true and PUBLIC_URL=<BASE_URL>.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { chromium } = require('playwright');
const h = require('./helpers');

const tag = crypto.randomBytes(3).toString('hex');
const RDOMAIN = `rt-${tag}.test`;
const SUBJECT = 'Reset your IRON ID password';
const NEW_PW = 'Seven quiet lanterns drift home 82';
const ipBase = 10 + crypto.randomInt(200);
const XF = n => ({ 'x-forwarded-for': `198.19.${ipBase}.${n}` });
let rDomainId, inbox, target, adminish, other, browser, inboxCookie, inboxAcct;
const seen = new Set();

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

const ask = (email, n = 1) => h.gw('/recover-api/request', { method: 'POST', body: { email }, headers: XF(n) });
const setRecovery = (cookie, body) => h.gw('/account/recovery', { method: 'POST', cookie, body });

/** Waits for a new reset message for `email` in the recovery inbox; returns its link token. */
async function linkFor(email, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const [, [, got]] = await h.mail(inboxCookie, [
      ['Email/query', { accountId: inboxAcct, filter: { subject: SUBJECT }, sort: [{ property: 'receivedAt', isAscending: false }] }, 'q'],
      ['Email/get', { accountId: inboxAcct, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
        properties: ['subject', 'from', 'textBody', 'bodyValues'], fetchTextBodyValues: true }, 'g']]);
    for (const m of got.list) {
      if (seen.has(m.id)) continue;
      const text = Object.values(m.bodyValues || {}).map(v => v.value).join('\n');
      if (!text.includes(email)) continue;
      seen.add(m.id);
      assert.equal(m.from[0].email, `no-reply@${h.TEST_DOMAIN}`);
      const link = new RegExp(h.BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/forgot#token=([A-Za-z0-9_-]{43})').exec(text);
      assert.ok(link, 'the message holds a link to this server: ' + text);
      return link[1];
    }
    await h.sleep(1000);
  }
  return null;
}

before(async () => {
  await h.waitHealthy(120000, { requireAdmin: true });
  const [[, d]] = await h.engine(h.recoveryAuth(), [['x:Domain/set', { create: { d: { name: RDOMAIN, dkimManagement: { '@type': 'Manual' } } } }, 'd']]);
  if (!d.created || !d.created.d) throw new Error('could not create the test domain: ' + JSON.stringify(d.notCreated));
  rDomainId = d.created.d.id;
  inbox = await userOn(rDomainId, RDOMAIN, 'rinbox');
  target = await h.createTestUser('fp');
  adminish = await h.createTestUser('fp-adm');
  other = await h.createTestUser('fp-ui');
  const r = await h.login(inbox.email, inbox.password);
  assert.equal(r.status, 200, r.text);
  inboxCookie = r.cookie;
  inboxAcct = await h.primaryAccount(inboxCookie);
  browser = await chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  for (const u of [target, adminish, other, inbox]) await h.deleteTestUser(u);
  if (rDomainId) await h.engine(h.recoveryAuth(), [['x:Domain/set', { destroy: [rDomainId] }, 'x']]).catch(() => {});
});

test('recovery by email is open here, and its page loads', async () => {
  const c = await h.gw('/recover-api/config');
  assert.equal(c.status, 200);
  assert.equal(c.json.enabled, true, 'start the gateway with PASSWORD_RESET_ENABLED=true and PUBLIC_URL');
  const page = await h.gw('/forgot');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await h.gw('/healthz')).json.passwordReset, 'on');
});

test('the recovery address needs the password, must be outside IRON ID, and is saved', async () => {
  const s = await h.login(target.email, target.password);
  assert.equal(s.status, 200, s.text);
  target.cookie = s.cookie;
  const wrong = await setRecovery(target.cookie, { recoveryEmail: inbox.email, currentPassword: 'not the password' });
  assert.equal(wrong.status, 400);
  const inside = await setRecovery(target.cookie, { recoveryEmail: `someone@${h.TEST_DOMAIN}`, currentPassword: target.password });
  assert.equal(inside.status, 400);
  assert.match(inside.json.error, /outside IRON ID/);
  const bad = await setRecovery(target.cookie, { recoveryEmail: 'not an address', currentPassword: target.password });
  assert.equal(bad.status, 400);
  const ok = await setRecovery(target.cookie, { recoveryEmail: inbox.email.toUpperCase(), currentPassword: target.password });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json.recovery, { email: inbox.email, verified: false });
  const sec = await h.gw('/account/security', { cookie: target.cookie });
  assert.equal(sec.json.recovery.email, inbox.email);
  assert.equal(sec.json.passwordReset, true);
  const cross = await h.gw('/account/recovery', { method: 'POST', cookie: target.cookie, body: { recoveryEmail: '', currentPassword: target.password }, headers: { origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
});

test('asking for a link gives the same answer for any address', async () => {
  const unknown = await ask(`nobody-${tag}@${h.TEST_DOMAIN}`, 1);
  const known = await ask(target.email, 1);
  assert.equal(unknown.status, 200);
  assert.equal(known.status, 200);
  assert.equal(unknown.text, known.text);
  assert.equal((await ask('not-an-address', 1)).status, 400);
  const cross = await h.gw('/recover-api/request', { method: 'POST', body: { email: target.email }, headers: { ...XF(1), origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
});

test('the link arrives at the recovery address, works once, and signs everyone out', async () => {
  const token = await linkFor(target.email);
  assert.ok(token, 'no reset message arrived');
  const who = await h.gw('/recover-api/check', { method: 'POST', body: { token }, headers: XF(2) });
  assert.equal(who.status, 200, who.text);
  assert.equal(who.json.email, target.email);

  // A weak password is refused and the link still works afterwards.
  const weak = await h.gw('/recover-api/reset', { method: 'POST', body: { token, password: 'short' }, headers: XF(2) });
  assert.equal(weak.status, 400);
  assert.equal(weak.json.code, 'password');
  const done = await h.gw('/recover-api/reset', { method: 'POST', body: { token, password: NEW_PW }, headers: XF(2) });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.email, target.email);

  const again = await h.gw('/recover-api/reset', { method: 'POST', body: { token, password: NEW_PW + '!' }, headers: XF(2) });
  assert.equal(again.status, 400);
  assert.equal(again.json.code, 'expired');
  assert.equal((await h.gw('/account/security', { cookie: target.cookie })).status, 401, 'the old session ended');
  assert.equal((await h.login(target.email, target.password, XF(3))).status, 401, 'the old password no longer works');
  const fresh = await h.login(target.email, NEW_PW, XF(3));
  assert.equal(fresh.status, 200, fresh.text);
  const sec = await h.gw('/account/security', { cookie: fresh.cookie });
  assert.equal(sec.json.recovery.verified, true, 'a used link proves the recovery address');
});

test('a newer link replaces the older one; made-up links are refused', async () => {
  await ask(target.email, 4);
  const first = await linkFor(target.email);
  assert.ok(first);
  await ask(target.email, 4);
  const second = await linkFor(target.email);
  assert.ok(second);
  assert.equal((await h.gw('/recover-api/check', { method: 'POST', body: { token: first }, headers: XF(4) })).status, 400);
  assert.equal((await h.gw('/recover-api/check', { method: 'POST', body: { token: second }, headers: XF(4) })).status, 200);
  const madeUp = await h.gw('/recover-api/check', { method: 'POST', body: { token: crypto.randomBytes(32).toString('base64url') }, headers: XF(4) });
  assert.equal(madeUp.status, 400);
  assert.equal((await h.gw('/recover-api/check', { method: 'POST', body: { token: '../../etc' }, headers: XF(4) })).status, 400);
});

test('engine administrators get no link, even with a recovery address', async () => {
  for (const u of [adminish, other]) {
    const s = await h.login(u.email, u.password, XF(5));
    assert.equal(s.status, 200, s.text);
    assert.equal((await setRecovery(s.cookie, { recoveryEmail: inbox.email, currentPassword: u.password })).status, 200);
  }
  const [[, up]] = await h.engine(h.recoveryAuth(), [['x:Account/set', { update: { [adminish.id]: { roles: { '@type': 'Admin' } } } }, 'u']]);
  assert.ok(up.updated && adminish.id in up.updated, JSON.stringify(up));
  assert.equal((await ask(adminish.email, 5)).status, 200);
  assert.equal((await ask(other.email, 5)).status, 200);
  assert.ok(await linkFor(other.email), 'the ordinary mailbox got its link');
  assert.equal(await linkFor(adminish.email, 3000), null, 'no link for the administrator');
});

test('the page in a real browser: ask for a link, open it, choose a new password', async () => {
  const ctx = await browser.newContext({ locale: 'en-GB', viewport: { width: 1280, height: 900 }, extraHTTPHeaders: XF(6) });
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
  assert.equal((await h.login(other.email, NEW_PW, XF(7))).status, 200);
  assert.deepEqual(errors, []);
  await ctx.close();
});
