// Mail search on OpenSearch: new mail, accents, French elisions, Arabic variants, hyphens,
// older mail after the automatic re-index, and the search service's own access rules.
// Runs only when EXPECT_OPENSEARCH=1 (run-docker.sh sets it). It needs the engine to have
// restarted once after the switch, which 04-restart.test.js does.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const h = require('./helpers');

const ON = process.env.EXPECT_OPENSEARCH === '1';
const OS_URL = process.env.OPENSEARCH_TEST_URL || 'https://localhost:9200';
const OS_PW = process.env.OPENSEARCH_TEST_PASSWORD || '';
let user, s, acct, ids;

async function waitSearch(timeoutMs) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = (await h.gw('/healthz')).json || {};
    if (['ok', 'reindexing'].includes(last.search)) return last.search;
    await h.sleep(3000);
  }
  throw new Error('search never became active: ' + JSON.stringify(last));
}

function os(path, { user: u, pass, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = u ? { authorization: h.basic(u, pass) } : {};
    const req = https.request(new URL(path, OS_URL), { method, headers, rejectUnauthorized: false, timeout: 10000 }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  if (!ON) return;
  await h.waitHealthy(180000, { requireAdmin: true });
  await waitSearch(240000);
  user = await h.createTestUser('search');
  s = await h.login(user.email, user.password, { 'x-forwarded-for': '198.51.100.40' });
  acct = await h.primaryAccount(s.cookie);
  const [[, boxes]] = await h.mail(s.cookie, [['Mailbox/query', { accountId: acct, filter: { role: 'inbox' } }, 'm']]);
  const mk = (subject, body) => ({
    mailboxIds: { [boxes.ids[0]]: true }, subject, from: [{ name: 'Nadia Benali', email: 'nadia@partner.example' }],
    to: [{ email: user.email }], bodyValues: { b: { value: body } }, textBody: [{ partId: 'b', type: 'text/plain' }]
  });
  const r = await h.mail(s.cookie, [['Email/set', { accountId: acct, create: {
    a: mk('Quarterly invoice ZX-4471', 'Please find the e-mail attached regarding the shipment to Oran.'),
    b: mk('Réunion du conseil', 'La réunion de l’équipe est prévue à Alger, merci de confirmer.'),
    c: mk('اجتماع مهم', 'نلتقي في المكتب غدًا إن شاء الله، الإجتماع مُهِمّ.'),
    d: mk('Lunch plans', 'Nothing about invoices here, just sandwiches.')
  } }, 'e']]);
  ids = Object.fromEntries(Object.entries(r[0][1].created).map(([k, v]) => [v.id, k]));
});

after(async () => { if (user) await h.deleteTestUser(user); });

async function find(filter) {
  const [[, res]] = await h.mail(s.cookie, [['Email/query', { accountId: acct, filter }, 'q']]);
  assert.ok(Array.isArray(res.ids), 'query failed: ' + JSON.stringify(res));
  return res.ids.map(id => ids[id] || 'other').sort().join(',');
}

async function eventually(filter, expect) {
  let got;
  for (let i = 0; i < 20; i++) { got = await find(filter); if (got === expect) return; await h.sleep(1000); }
  assert.equal(got, expect, JSON.stringify(filter));
}

test('health check reports OpenSearch search', { skip: !ON && 'EXPECT_OPENSEARCH not set' }, async () => {
  assert.ok(['ok', 'reindexing'].includes((await h.gw('/healthz')).json.search));
});

test('new mail is searchable, including stems and hyphenated words', { skip: !ON && 'EXPECT_OPENSEARCH not set' }, async () => {
  await eventually({ text: 'shipment' }, 'a');
  await eventually({ text: 'invoice' }, 'a,d');          // "invoices" matches too
  await eventually({ subject: 'ZX-4471' }, 'a');
  await eventually({ body: 'e-mail' }, 'a');
  await eventually({ from: 'nadia' }, 'a,b,c,d');
  await eventually({ text: 'qwertyzzz' }, '');
});

test('search ignores accents, French elisions and Arabic spelling variants', { skip: !ON && 'EXPECT_OPENSEARCH not set' }, async () => {
  await eventually({ text: 'reunion' }, 'b');
  await eventually({ text: 'réunion' }, 'b');
  await eventually({ text: 'equipe' }, 'b');             // l’équipe
  await eventually({ text: 'الاجتماع' }, 'c');            // written الإجتماع
  await eventually({ text: 'مهم' }, 'c');                 // written مُهِمّ (vowel marks)
});

test('search service refuses anonymous, wrong-password and out-of-scope access', { skip: (!ON || !OS_PW) && 'no OpenSearch credentials' }, async () => {
  assert.equal(await os('/'), 401, 'no login');
  assert.equal(await os('/', { user: 'stalwart', pass: 'wrong-' + OS_PW }), 401, 'wrong password');
  assert.equal(await os('/', { user: 'admin', pass: 'admin' }), 401, 'demo admin login');
  assert.equal(await os('/st_email/_count', { user: 'stalwart', pass: OS_PW }), 200, 'engine reads its index');
  assert.equal(await os('/_plugins/_security/api/internalusers', { user: 'stalwart', pass: OS_PW }), 403, 'engine cannot manage users');
  assert.equal(await os('/not-mail', { user: 'stalwart', pass: OS_PW, method: 'PUT' }), 403, 'engine cannot create other indexes');
});
