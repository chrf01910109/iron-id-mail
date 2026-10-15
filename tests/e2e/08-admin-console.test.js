// Admin console API: roles and scoping, domains with DNS verification and DKIM keys,
// mailboxes, aliases, teams, suspension, sign-in reset, plans, usage, retention and audit.
//
// Needs the gateway started with PLATFORM_ADMINS including e2e-platform-admin@<TEST_DOMAIN>
// and IRONID_DNS_FAKE=<file>; the same file path is given to the tests as DNS_FAKE_FILE.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const h = require('./helpers');

const DNS_FAKE = process.env.DNS_FAKE_FILE || '';
const skip = !DNS_FAKE && 'DNS_FAKE_FILE not set';
const tag = crypto.randomBytes(3).toString('hex');
const DOMAIN = `acme-e2e-${tag}.com`;
let platform, plainUser, P, U; // platform admin + its cookie, ordinary user + cookie
const state = {};
const dns = {};
const setDns = (name, type, values) => { dns[`${name}|${type}`] = values; fs.writeFileSync(DNS_FAKE, JSON.stringify(dns)); };
const XF = n => ({ 'x-forwarded-for': `198.51.100.${n}` });

async function api(cookie, path, body, headers = {}) {
  const r = await h.gw('/admin-api/' + path, body === undefined ? { cookie, headers } : { method: 'POST', cookie, body, headers });
  return r;
}
async function ok(cookie, path, body) {
  const r = await api(cookie, path, body);
  assert.equal(r.status, 200, `${path}: ${r.status} ${r.text}`);
  return r.json;
}
const signedIn = async cookie => !!(await h.gw('/proxy/jmap/session', { cookie })).json?.username;
async function signIn(email, password, n) {
  const r = await h.login(email, password, XF(n));
  assert.equal(r.status, 200, `sign-in ${email}: ${r.text}`);
  return r.cookie;
}

before(async () => {
  if (skip) return;
  fs.writeFileSync(DNS_FAKE, '{}');
  await h.waitHealthy(120000, { requireAdmin: true });
  platform = await h.createTestUser('e2e-platform-admin', { exactName: true });
  plainUser = await h.createTestUser('plain');
  P = await signIn(platform.email, platform.password, 160);
  U = await signIn(plainUser.email, plainUser.password, 161);
});

after(async () => {
  if (skip) return;
  // Best-effort clean-up through the console itself, then the engine.
  try {
    for (const t of (await api(P, 'teams?domain=' + DOMAIN)).json.teams || []) await api(P, 'teams/delete', { id: t.id, confirm: t.email });
    for (const m of (await api(P, 'mailboxes?domain=' + DOMAIN)).json.mailboxes || []) await api(P, 'mailboxes/delete', { id: m.id, confirm: m.email });
    await api(P, 'domains/remove', { domain: DOMAIN, confirm: DOMAIN });
    if (state.customerId) await api(P, 'customers/delete', { id: state.customerId });
    if (state.planId) await api(P, 'plans/delete', { id: state.planId });
  } catch (e) { /* ignore */ }
  await h.deleteTestUser(platform);
  await h.deleteTestUser(plainUser);
  try { fs.writeFileSync(DNS_FAKE, '{}'); } catch (e) { /* ignore */ }
});

test('only signed-in admins get in', { skip }, async () => {
  assert.equal((await api(null, 'me')).status, 401);
  assert.equal((await api(U, 'me')).status, 403, 'an ordinary mailbox is not an admin');
  const me = await ok(P, 'me');
  assert.equal(me.role, 'platform');
  // Same-site JSON only for changes.
  const cross = await api(P, 'plans', { name: 'x' }, { origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
  const form = await fetch(h.BASE + '/admin-api/plans', { method: 'POST', headers: { cookie: 'iid_session=' + P, 'content-type': 'text/plain' }, body: '{"name":"x"}' });
  assert.equal(form.status, 415);
  // The console page has a strict policy.
  const page = await fetch(h.BASE + '/admin');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
});

test('plan and customer', { skip }, async () => {
  state.planId = (await ok(P, 'plans', { name: 'E2E Business ' + tag, maxMailboxes: 2, mailboxQuotaMb: 200, pricePerMailbox: 300, currency: 'DZD' })).id;
  state.customerId = (await ok(P, 'customers', { name: 'Acme ' + tag, contactEmail: 'boss@' + DOMAIN, planId: state.planId })).id;
  const list = await ok(P, 'customers');
  assert.ok(list.customers.some(c => c.id === state.customerId && c.planId === state.planId));
  assert.ok(list.customers.some(c => c.internal), 'the IRON ID customer exists');
});

test('domain: pending until the DNS proof is found, then created with fresh DKIM keys', { skip }, async () => {
  const add = await ok(P, 'domains', { domain: DOMAIN, customerId: state.customerId });
  assert.equal(add.status, 'pending');
  assert.equal((await api(P, 'domains', { domain: DOMAIN, customerId: state.customerId })).status, 400, 'no duplicates');
  let d = await ok(P, 'domains/dns?domain=' + DOMAIN);
  const proof = d.records.find(r => r.id === 'verify');
  assert.match(proof.value, /^iron-id-verification=[0-9a-f]{32}$/);
  assert.equal(proof.ok, false);
  const early = await api(P, 'domains/verify', { domain: DOMAIN });
  assert.equal(early.status, 400);
  assert.match(early.json.error, /not found yet/);
  assert.equal((await api(P, 'mailboxes', { email: 'x@' + DOMAIN })).status, 404, 'no mailboxes before verification');
  setDns(DOMAIN, 'TXT', [proof.value]);
  assert.equal((await ok(P, 'domains/verify', { domain: DOMAIN })).status, 'active');
  d = await ok(P, 'domains/dns?domain=' + DOMAIN);
  assert.equal(d.keys.filter(k => k.stage === 'active').length, 2, 'Ed25519 + RSA keys');
  assert.ok(d.keys.every(k => /^ironid\d{8}[er]$/.test(k.selector)));
  const dkim = d.records.filter(r => r.id.startsWith('dkim:'));
  assert.equal(dkim.length, 2);
  assert.match(d.records.find(r => r.id === 'dmarc').value, /p=none/);
  assert.equal(d.records.find(r => r.id === 'spf').value, 'v=spf1 mx ~all');
  // Publish everything: every check turns green.
  setDns(DOMAIN, 'TXT', [proof.value, 'v=spf1 mx ~all']);
  setDns(DOMAIN, 'MX', ['10 mail.iron-id.io']);
  setDns('_dmarc.' + DOMAIN, 'TXT', ['v=DMARC1; p=none']);
  for (const r of dkim) setDns(r.name, 'TXT', [r.value]);
  d = await ok(P, 'domains/dns?domain=' + DOMAIN);
  assert.deepEqual(d.records.filter(r => !r.ok).map(r => r.id), []);
  // Two SPF records are reported as a problem.
  setDns(DOMAIN, 'TXT', [proof.value, 'v=spf1 mx ~all', 'v=spf1 include:other ~all']);
  d = await ok(P, 'domains/dns?domain=' + DOMAIN);
  assert.match(d.records.find(r => r.id === 'spf').problem, /more than one/);
  setDns(DOMAIN, 'TXT', [proof.value, 'v=spf1 mx ~all']);
});

test('the platform domain never offers exposed keys or MX changes', { skip }, async () => {
  const d = await ok(P, 'domains/dns?domain=' + h.TEST_DOMAIN);
  assert.ok(d.platform);
  assert.ok(!d.records.some(r => ['mx', 'spf', 'dmarc', 'verify'].includes(r.id)));
  assert.ok(!d.records.some(r => /v1-(ed25519|rsa)-2026092[12]/.test(r.name)), 'exposed selectors are never shown for publishing');
  assert.equal((await api(P, 'domains/remove', { domain: h.TEST_DOMAIN, confirm: h.TEST_DOMAIN })).status, 400);
});

test('mailboxes: create with a temporary password, plan limits, quota', { skip }, async () => {
  const a = await ok(P, 'mailboxes', { email: 'anna@' + DOMAIN, name: 'Anna Admin' });
  assert.match(a.password, /^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);
  state.anna = { id: a.id, email: 'anna@' + DOMAIN, password: a.password };
  const b = await ok(P, 'mailboxes', { email: 'bob@' + DOMAIN, name: 'Bob' });
  state.bob = { id: b.id, email: 'bob@' + DOMAIN, password: b.password };
  const third = await api(P, 'mailboxes', { email: 'carl@' + DOMAIN });
  assert.equal(third.status, 400);
  assert.match(third.json.error, /includes 2 mailboxes/);
  assert.equal((await api(P, 'mailboxes', { email: 'bad name@' + DOMAIN })).status, 400);
  const list = (await ok(P, 'mailboxes?domain=' + DOMAIN)).mailboxes;
  assert.deepEqual(list.map(m => m.email), ['anna@' + DOMAIN, 'bob@' + DOMAIN]);
  assert.equal(list[0].quotaMb, 200, 'plan storage applies');
  assert.equal((await api(P, 'mailboxes/update', { id: b.id, quotaMb: 5000 })).status, 400, 'not above the plan');
  await ok(P, 'mailboxes/update', { id: b.id, quotaMb: 100, name: 'Bob B.' });
  await ok(P, 'mailboxes/update', { id: a.id, quotaMb: null });
  assert.equal((await ok(P, 'mailboxes?domain=' + DOMAIN)).mailboxes.find(m => m.id === a.id).quotaMb, 200, 'clearing the limit falls back to the plan, never unlimited');
  assert.equal((await api(P, 'mailboxes/update', { id: a.id, aliases: 'x@' + DOMAIN })).status, 400, 'aliases must be a list');
  // The new mailbox signs in to the webmail with the temporary password.
  state.bobCookie = await signIn(state.bob.email, state.bob.password, 162);
});

test('customer admins only see and change their own customer', { skip }, async () => {
  assert.equal((await api(P, 'admins/add', { email: 'nobody@' + DOMAIN, customerId: state.customerId })).status, 400, 'only existing mailboxes become admins');
  assert.equal((await api(P, 'admins/add', { email: plainUser.email, customerId: state.customerId })).status, 400, 'only mailboxes of that customer');
  await ok(P, 'admins/add', { email: state.anna.email, customerId: state.customerId });
  const A = await signIn(state.anna.email, state.anna.password, 163);
  state.annaCookie = A;
  const me = await ok(A, 'me');
  assert.equal(me.role, 'customer');
  assert.deepEqual((await ok(A, 'domains')).domains.map(d => d.domain), [DOMAIN]);
  const boxes = (await ok(A, 'mailboxes')).mailboxes;
  assert.ok(boxes.every(m => m.email.endsWith('@' + DOMAIN)), 'nothing from other customers');
  assert.ok(boxes.find(m => m.email === state.anna.email).admin);
  // Someone else's mailbox is simply not found.
  assert.equal((await api(A, 'mailboxes/suspend', { id: plainUser.id, suspended: true })).status, 404);
  assert.equal((await api(A, 'mailboxes/reset-signin', { id: platform.id })).status, 404);
  assert.equal((await api(A, 'domains/dns?domain=' + h.TEST_DOMAIN)).status, 404);
  // Platform-only areas.
  assert.equal((await api(A, 'customers', { name: 'Other' })).status, 403);
  assert.equal((await api(A, 'retention')).status, 403);
  assert.equal((await api(A, 'plans', { name: 'Free for me' })).status, 403);
  assert.equal((await api(A, 'domains', { domain: h.TEST_DOMAIN })).status, 403);
  assert.equal((await api(A, 'domains', { domain: 'acme-other-' + tag + '.com', customerId: '00000000-0000-0000-0000-000000000000' })).status, 404);
  // A claimed but unverified domain gives no access to anything in it.
  const claim = await ok(A, 'domains', { domain: 'pending-' + tag + '.com' });
  assert.equal(claim.status, 'pending');
  assert.equal((await api(A, 'mailboxes', { email: 'x@pending-' + tag + '.com' })).status, 404);
  await ok(A, 'domains/remove', { domain: 'pending-' + tag + '.com', confirm: 'pending-' + tag + '.com' });
  // Not their own mailbox from the console.
  assert.equal((await api(A, 'mailboxes/reset-signin', { id: state.anna.id })).status, 400);
  // The customer's plan is visible, others are not.
  assert.deepEqual((await ok(A, 'plans')).plans.map(p => p.id), [state.planId]);
});

test('aliases stay within the customer’s domains', { skip }, async () => {
  const A = state.annaCookie;
  await ok(A, 'mailboxes/update', { id: state.bob.id, aliases: ['robert@' + DOMAIN] });
  assert.deepEqual((await ok(A, 'mailboxes?domain=' + DOMAIN)).mailboxes.find(m => m.id === state.bob.id).aliases, ['robert@' + DOMAIN]);
  assert.equal((await api(A, 'mailboxes/update', { id: state.bob.id, aliases: ['bob2@' + h.TEST_DOMAIN] })).status, 400);
  assert.equal((await api(A, 'mailboxes/update', { id: state.bob.id, aliases: ['anna@' + DOMAIN] })).status, 400, 'an address in use');
});

test('teams: shared mailbox with members, visible in their webmail', { skip }, async () => {
  const A = state.annaCookie;
  const t = await ok(A, 'teams', { email: 'support@' + DOMAIN, name: 'Support', members: [state.anna.email, state.bob.email] });
  state.team = t;
  let teams = (await ok(A, 'teams')).teams;
  assert.deepEqual(teams.find(x => x.id === t.id).members, [state.anna.email, state.bob.email]);
  assert.equal((await api(A, 'teams/update', { id: t.id, members: [plainUser.email] })).status, 400, 'only own mailboxes');
  // Bob sees the team in the webmail.
  await h.sleep(500);
  const me = await h.gw('/account/me', { cookie: state.bobCookie });
  assert.equal(me.status, 200);
  const team = me.json.teams.find(x => x.email === 'support@' + DOMAIN);
  assert.ok(team, JSON.stringify(me.json));
  assert.deepEqual(team.members.map(m => m.email), [state.anna.email, state.bob.email]);
  const fresh = await signIn(state.bob.email, state.bob.password, 164);
  const s = (await h.gw('/proxy/jmap/session', { cookie: fresh })).json;
  assert.ok(Object.values(s.accounts).some(acc => !acc.isPersonal), 'the team mailbox is in the JMAP session');
  await ok(A, 'teams/update', { id: t.id, members: [state.anna.email] });
  teams = (await ok(A, 'teams')).teams;
  assert.deepEqual(teams.find(x => x.id === t.id).members, [state.anna.email]);
});

test('suspend and restore a mailbox', { skip }, async () => {
  const A = state.annaCookie;
  await ok(A, 'mailboxes/suspend', { id: state.bob.id, suspended: true });
  assert.equal(await signedIn(state.bobCookie), false, 'signed out at once');
  assert.notEqual((await h.login(state.bob.email, state.bob.password, XF(165))).status, 200);
  assert.ok((await ok(A, 'mailboxes?domain=' + DOMAIN)).mailboxes.find(m => m.id === state.bob.id).suspended);
  await ok(A, 'mailboxes/suspend', { id: state.bob.id, suspended: false });
  state.bobCookie = await signIn(state.bob.email, state.bob.password, 166);
});

test('reset sign-in: new password, two-step and app passwords removed, browsers signed out', { skip }, async () => {
  const A = state.annaCookie;
  const app = await h.gw('/account/app-passwords', { method: 'POST', cookie: state.bobCookie, body: { name: 'Phone', password: state.bob.password } });
  assert.equal(app.status, 200);
  const r = await ok(A, 'mailboxes/reset-signin', { id: state.bob.id });
  assert.notEqual(r.password, state.bob.password);
  assert.equal(await signedIn(state.bobCookie), false);
  assert.equal((await fetch(h.ENGINE + '/jmap/session', { headers: { authorization: h.basic(state.bob.email, app.json.secret) } })).status, 401, 'app password gone');
  assert.notEqual((await h.login(state.bob.email, state.bob.password, XF(167))).status, 200, 'old password gone');
  state.bob.password = r.password;
  state.bobCookie = await signIn(state.bob.email, r.password, 168);
});

test('DKIM: new keys, switch only once published, then remove the old ones', { skip }, async () => {
  const A = state.annaCookie;
  const before = (await ok(A, 'domains/dns?domain=' + DOMAIN)).keys;
  const prep = await ok(A, 'domains/dkim/prepare', { domain: DOMAIN });
  assert.equal(prep.selectors.length, 2);
  let d = await ok(A, 'domains/dns?domain=' + DOMAIN);
  const pend = d.records.filter(r => r.id.startsWith('dkim:') && prep.selectors.includes(r.id.slice(5)));
  assert.equal(pend.length, 2);
  const early = await api(A, 'domains/dkim/activate', { domain: DOMAIN });
  assert.equal(early.status, 400);
  assert.match(early.json.error, /not visible in DNS/);
  for (const r of pend) setDns(r.name, 'TXT', [r.value]);
  await ok(A, 'domains/dkim/activate', { domain: DOMAIN });
  d = await ok(A, 'domains/dns?domain=' + DOMAIN);
  assert.deepEqual(d.keys.filter(k => k.stage === 'active').map(k => k.selector).sort(), prep.selectors.slice().sort());
  assert.deepEqual(d.keys.filter(k => k.stage === 'retiring').map(k => k.selector).sort(), before.map(k => k.selector).sort());
  const rm = await ok(A, 'domains/dkim/remove-old', { domain: DOMAIN });
  assert.equal(rm.removed.length, 2);
  d = await ok(A, 'domains/dns?domain=' + DOMAIN);
  assert.equal(d.keys.length, 2);
});

test('catch-all address must be on the domain', { skip }, async () => {
  const A = state.annaCookie;
  assert.equal((await api(A, 'domains/settings', { domain: DOMAIN, catchAll: plainUser.email })).status, 400);
  await ok(A, 'domains/settings', { domain: DOMAIN, catchAll: 'support@' + DOMAIN });
  assert.equal((await ok(A, 'domains')).domains[0].catchAll, 'support@' + DOMAIN);
  await ok(A, 'domains/settings', { domain: DOMAIN, catchAll: '' });
});

test('usage and billing estimate', { skip }, async () => {
  const u = (await ok(state.annaCookie, 'usage')).usage;
  assert.equal(u.length, 1);
  assert.equal(u[0].billableMailboxes, 2);
  assert.equal(u[0].teams, 1);
  assert.equal(u[0].monthlyEstimate, 600);
  assert.equal(u[0].plan.currency, 'DZD');
  const all = (await ok(P, 'usage')).usage;
  assert.ok(all.find(x => x.internal).monthlyEstimate === null, 'IRON ID itself is not billed');
});

test('retention rule for Trash and Junk (platform)', { skip }, async () => {
  const cur = await ok(P, 'retention');
  assert.ok(cur.trashDays === null || cur.trashDays > 0);
  await ok(P, 'retention', { trashDays: 45 });
  assert.equal((await ok(P, 'retention')).trashDays, 45);
  assert.equal((await api(P, 'retention', { trashDays: 0 })).status, 400);
  await ok(P, 'retention', { trashDays: cur.trashDays || 30 });
});

test('audit log: sign-ins and changes, scoped per customer', { skip }, async () => {
  const mine = (await ok(state.annaCookie, 'audit?limit=200')).entries;
  const actions = new Set(mine.map(e => e.action));
  for (const a of ['mailbox.created', 'team.created', 'mailbox.suspended', 'mailbox.signin_reset', 'domain.dkim_activated', 'signin.ok']) assert.ok(actions.has(a), 'has ' + a);
  assert.ok(mine.every(e => !String(e.target || '').endsWith('@' + h.TEST_DOMAIN)), 'nothing about other customers');
  assert.ok((await ok(state.annaCookie, 'audit?kind=signin')).entries.every(e => e.action.startsWith('signin.')));
  const failed = (await ok(P, 'audit?kind=signin&q=' + encodeURIComponent(state.bob.email))).entries;
  assert.ok(failed.some(e => e.action === 'signin.failed'), 'failed sign-ins are recorded');
  // The person sees their own recent sign-ins in Settings → Security.
  const sec = await h.gw('/account/security', { cookie: state.bobCookie });
  assert.ok(sec.json.recentSignIns.length >= 1);
});

test('delete: team, mailbox, domain (with confirmation), customer', { skip }, async () => {
  const A = state.annaCookie;
  assert.equal((await api(A, 'domains/remove', { domain: DOMAIN, confirm: DOMAIN })).status, 400, 'not while mailboxes exist');
  assert.equal((await api(A, 'teams/delete', { id: state.team.id, confirm: 'wrong' })).status, 400);
  await ok(A, 'teams/delete', { id: state.team.id, confirm: 'support@' + DOMAIN });
  assert.ok(await signedIn(state.bobCookie));
  await ok(A, 'mailboxes/delete', { id: state.bob.id, confirm: state.bob.email });
  assert.equal(await signedIn(state.bobCookie), false);
  await ok(P, 'mailboxes/delete', { id: state.anna.id, confirm: state.anna.email });
  assert.equal((await api(P, 'customers/delete', { id: state.customerId })).status, 400, 'domains first');
  await ok(P, 'domains/remove', { domain: DOMAIN, confirm: DOMAIN });
  await ok(P, 'customers/delete', { id: state.customerId });
  await ok(P, 'plans/delete', { id: state.planId });
  state.customerId = state.planId = null;
});
