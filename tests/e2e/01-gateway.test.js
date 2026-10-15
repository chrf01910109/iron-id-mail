// Gateway security and sign-in behaviour (no browser).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const h = require('./helpers');

let user;
before(async () => { await h.waitHealthy(); user = await h.createTestUser('gw'); });
after(async () => { await h.deleteTestUser(user); });

test('health check reports gateway, engine and database up', async () => {
  const r = await h.gw('/healthz');
  assert.equal(r.status, 200);
  assert.equal(r.json.engine, 'ok');
  assert.equal(r.json.database, 'ok');
  assert.equal(r.json.schema, 'ok');
  assert.ok(!/secret|password|token/i.test(r.text), 'no secrets in health output');
});

test('security headers are set', async () => {
  const r = await h.gw('/');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
});

test('debug page and admin API are closed', async () => {
  assert.equal((await h.gw('/debug')).status, 404);
  assert.equal((await h.gw('/api/stats')).status, 404);
  assert.equal((await h.gw('/admin-legacy')).status, 404);
});

test('proxy only forwards mail (JMAP) paths', async () => {
  assert.equal((await h.gw('/proxy/jmap/session')).status, 200);
  for (const p of ['/proxy/api/principal', '/proxy/', '/proxy/account', '/proxy/jmap/../api/principal', '/proxy/%2e%2e/api']) {
    assert.equal((await h.gw(p)).status, 404, p);
  }
});

test('malformed request gets 400 and the server stays up', async () => {
  const u = new URL(h.BASE);
  const status = await new Promise((resolve, reject) => {
    const s = net.createConnection({ host: u.hostname, port: Number(u.port || 80) }, () => s.write('GET //[ HTTP/1.1\r\nHost: x\r\n\r\n'));
    s.on('data', d => { resolve(String(d).split(' ')[1]); s.destroy(); });
    s.on('error', reject);
  });
  assert.equal(status, '400');
  assert.equal((await h.gw('/healthz')).status, 200);
});

test('wrong password is refused without a browser password popup', async () => {
  const r = await h.login(user.email, 'wrong-password', { 'x-forwarded-for': '198.51.100.1' });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('www-authenticate'), null);
  const p = await h.gw('/proxy/jmap/session', { headers: { authorization: h.basic(user.email, 'nope') } });
  assert.equal(p.headers.get('www-authenticate'), null);
});

test('the proxy never passes on credentials the caller supplies (no password guessing past the sign-in brake)', async () => {
  // Even the right password in an Authorization header gives nothing without a session.
  const p = await h.gw('/proxy/jmap/session', { headers: { authorization: h.basic(user.email, user.password) } });
  assert.ok(!(p.json && p.json.username), 'no session from a caller-supplied Authorization header');
  const q = await h.gw('/proxy/jmap', { method: 'POST', headers: { authorization: h.basic(user.email, user.password) },
    body: { using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls: [['Mailbox/get', { accountId: 'x' }, 'm']] } });
  assert.equal(q.status, 401);
});

test('signing in to your own mailbox does not reset the brake for guessing others', async () => {
  const victim = await h.createTestUser('brake');
  const ip = { 'x-forwarded-for': '203.0.113.88' };
  try {
    for (let i = 0; i < 9; i++) assert.equal((await h.login(victim.email, `guess-${i}`, ip)).status, 401);
    assert.equal((await h.login(user.email, user.password, ip)).status, 200, 'own mailbox still works');
    assert.equal((await h.login(victim.email, 'guess-9', ip)).status, 401);
    assert.equal((await h.login(victim.email, 'guess-10', ip)).status, 429, 'the address is now blocked');
  } finally {
    await h.deleteTestUser(victim);
  }
});

test('sign-in sets a secure session cookie; sign-out ends it', async () => {
  const r = await h.login(user.email, user.password);
  assert.equal(r.status, 200);
  assert.ok(r.cookie && r.cookie.length >= 40);
  assert.match(r.setCookie, /HttpOnly/);
  assert.match(r.setCookie, /SameSite=Strict/);
  const s = await h.gw('/proxy/jmap/session', { cookie: r.cookie });
  assert.equal(s.json.username, user.email);
  await h.gw('/auth/logout', { method: 'POST', cookie: r.cookie });
  const after = await h.gw('/proxy/jmap/session', { cookie: r.cookie });
  assert.ok(!after.json.username, 'ticket rejected after sign-out');
});

test('requests from another website are refused', async () => {
  const evil = { origin: 'https://evil.example' };
  assert.equal((await h.login(user.email, user.password, evil)).status, 403);
  const ok = await h.login(user.email, user.password);
  const r = await h.gw('/proxy/jmap', { method: 'POST', cookie: ok.cookie, headers: evil, body: {} });
  assert.equal(r.status, 403);
});

test('password guessing is slowed down, even with faked addresses', async () => {
  const victim = await h.createTestUser('brute');
  try {
    for (let i = 0; i < 10; i++) {
      const r = await h.login(victim.email, `guess-${i}`, { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.77` });
      assert.equal(r.status, 401);
    }
    const blocked = await h.login(victim.email, victim.password, { 'x-forwarded-for': '10.0.0.99, 203.0.113.77' });
    assert.equal(blocked.status, 429, 'blocked even with the right password');
  } finally {
    await h.deleteTestUser(victim);
  }
});
