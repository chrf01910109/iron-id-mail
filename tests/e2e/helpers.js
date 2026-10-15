/**
 * Shared helpers for the end-to-end tests.
 *
 * Environment:
 *   BASE_URL        gateway URL                (default http://127.0.0.1:3001)
 *   ENGINE_URL      engine HTTP URL            (default http://127.0.0.1:8080)
 *   RECOVERY_ADMIN  user:password of the engine's temporary recovery admin (required)
 *   TEST_DOMAIN     domain for throwaway test accounts (default iron-id.io)
 *   RESTART_CMD     shell command that restarts the server (optional; enables restart tests)
 */
const crypto = require('crypto');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3001';
const ENGINE = process.env.ENGINE_URL || 'http://127.0.0.1:8080';
const RECOVERY = process.env.RECOVERY_ADMIN || '';
const TEST_DOMAIN = process.env.TEST_DOMAIN || 'iron-id.io';
const ADMIN_USING = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'];
const MAIL_USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const basic = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

async function engine(auth, methodCalls, using = ADMIN_USING) {
  const r = await fetch(`${ENGINE}/jmap/`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify({ using, methodCalls })
  });
  if (!r.ok) throw new Error(`engine HTTP ${r.status}`);
  return (await r.json()).methodResponses;
}

function recoveryAuth() {
  if (!RECOVERY.includes(':')) throw new Error('RECOVERY_ADMIN (user:password) is required for the e2e tests');
  const i = RECOVERY.indexOf(':');
  return basic(RECOVERY.slice(0, i), RECOVERY.slice(i + 1));
}

async function domainId(name = TEST_DOMAIN) {
  const [[, res]] = await engine(recoveryAuth(), [['x:Domain/get', { ids: null, properties: ['name'] }, 'd']]);
  const d = res.list.find(x => x.name === name);
  if (!d) throw new Error(`domain ${name} not found`);
  return d.id;
}

/** Creates a throwaway mailbox with a random password. */
async function createTestUser(prefix = 'e2e', { exactName = false } = {}) {
  const name = exactName ? prefix : `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
  if (exactName) { // remove a leftover from an earlier run
    const [[, all]] = await engine(recoveryAuth(), [['x:Account/get', { ids: null, properties: ['name', 'domainId'] }, 'g']]);
    const did0 = await domainId();
    const old = all.list.find(a => a.name === name && a.domainId === did0);
    if (old) await engine(recoveryAuth(), [['x:Account/set', { destroy: [old.id] }, 'x']]);
  }
  const password = 'T-' + crypto.randomBytes(18).toString('base64url');
  const did = await domainId();
  const [[, res]] = await engine(recoveryAuth(), [['x:Account/set', { create: { u: {
    '@type': 'User', name, domainId: did,
    description: 'Throwaway e2e test account',
    roles: { '@type': 'User' }, permissions: { '@type': 'Inherit' },
    encryptionAtRest: { '@type': 'Disabled' },
    credentials: { 0: { '@type': 'Password', secret: password } }
  } } }, 'c']]);
  if (!res.created || !res.created.u) throw new Error('could not create test user: ' + JSON.stringify(res.notCreated));
  return { id: res.created.u.id, email: `${name}@${TEST_DOMAIN}`, password };
}

async function deleteTestUser(user) {
  if (!user) return;
  try { await engine(recoveryAuth(), [['x:Account/set', { destroy: [user.id] }, 'x']]); } catch (e) { /* best effort */ }
}

/** Raw request to the gateway. Returns { status, headers, json, text, cookie }. */
async function gw(path, { method = 'GET', cookie, body, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = `iid_session=${cookie}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  const sc = r.headers.get('set-cookie') || '';
  const m = sc.match(/iid_session=([^;]*)/);
  return { status: r.status, headers: r.headers, json, text, cookie: m ? m[1] : null, setCookie: sc };
}

const login = (email, password, headers) => gw('/auth/login', { method: 'POST', body: { email, password }, headers });

/** JMAP mail calls through the gateway with a session cookie. */
async function mail(cookie, methodCalls) {
  const r = await gw('/proxy/jmap', { method: 'POST', cookie, body: { using: MAIL_USING, methodCalls } });
  if (r.status !== 200) throw new Error(`gateway JMAP HTTP ${r.status}`);
  return r.json.methodResponses;
}

/** Uploads a blob through the gateway. Returns { blobId, type, size }. */
async function upload(cookie, accountId, body, type) {
  const r = await fetch(`${BASE}/proxy/jmap/upload/${accountId}/`, {
    method: 'POST', headers: { cookie: `iid_session=${cookie}`, 'content-type': type }, body
  });
  if (!r.ok) throw new Error('upload HTTP ' + r.status);
  return r.json();
}

/** Sends a message from a signed-in user (JMAP create + submission). */
async function sendMail(cookie, { from, to, subject, text }) {
  const acct = await primaryAccount(cookie);
  const [[, boxes], [, ids]] = await mail(cookie, [
    ['Mailbox/get', { accountId: acct }, 'm'], ['Identity/get', { accountId: acct }, 'i']]);
  const drafts = boxes.list.find(b => b.role === 'drafts').id;
  const res = await mail(cookie, [
    ['Email/set', { accountId: acct, create: { m: { mailboxIds: { [drafts]: true }, from: [{ email: from }], to: to.map(email => ({ email })), subject,
      bodyValues: { b: { value: text } }, textBody: [{ partId: 'b', type: 'text/plain' }] } } }, 'e'],
    ['EmailSubmission/set', { accountId: acct, create: { s: { identityId: ids.list[0].id, emailId: '#m' } },
      onSuccessDestroyEmail: ['#s'] }, 's']]);
  if (!res[1][1].created || !res[1][1].created.s) throw new Error('send failed: ' + JSON.stringify(res));
}

async function primaryAccount(cookie) {
  const s = await gw('/proxy/jmap/session', { cookie });
  return s.json.primaryAccounts['urn:ietf:params:jmap:mail'];
}

async function waitHealthy(timeoutMs = 120000, { requireAdmin = false } = {}) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      last = await r.json();
      const adminReady = !requireAdmin || ['ok', 'provisioned'].includes(last.adminAccess);
      if (r.status === 200 && adminReady) return last;
    } catch (e) { /* not up yet */ }
    await sleep(2000);
  }
  throw new Error('server not healthy in time: ' + JSON.stringify(last));
}

module.exports = {
  BASE, ENGINE, TEST_DOMAIN, MAIL_USING, sleep, basic, engine, recoveryAuth,
  createTestUser, deleteTestUser, gw, login, mail, primaryAccount, waitHealthy, upload, sendMail
};
