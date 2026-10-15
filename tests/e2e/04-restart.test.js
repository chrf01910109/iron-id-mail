// Restart / redeploy behaviour: data, sign-ins and admin access survive.
// Runs only when RESTART_CMD is set (for example "docker restart ironid-e2e-app").
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const h = require('./helpers');

const RESTART = process.env.RESTART_CMD;
let user;

before(async () => { if (RESTART) { await h.waitHealthy(); user = await h.createTestUser('restart'); } });
after(async () => { if (user) await h.deleteTestUser(user); });

test('mail, passwords and sign-ins survive a restart', { skip: !RESTART && 'RESTART_CMD not set' }, async () => {
  const s = await h.login(user.email, user.password, { 'x-forwarded-for': '198.51.100.30' });
  assert.equal(s.status, 200);
  const acct = await h.primaryAccount(s.cookie);
  const [[, boxes]] = await h.mail(s.cookie, [['Mailbox/query', { accountId: acct, filter: { role: 'inbox' } }, 'm']]);
  const created = await h.mail(s.cookie, [['Email/set', { accountId: acct, create: { e: {
    mailboxIds: { [boxes.ids[0]]: true }, subject: 'Survives restart', from: [{ email: 'test@example.com' }],
    bodyValues: { b: { value: 'still here' } }, textBody: [{ partId: 'b', type: 'text/plain' }]
  } } }, 'e']]);
  const emailId = created[0][1].created.e.id;

  execSync(RESTART, { stdio: 'inherit' });
  const health = await h.waitHealthy(180000, { requireAdmin: true });
  assert.ok(['ok', 'provisioned'].includes(health.adminAccess), 'admin access after restart');

  const sess = await h.gw('/proxy/jmap/session', { cookie: s.cookie });
  assert.equal(sess.json.username, user.email, 'still signed in after restart');
  const [[, got]] = await h.mail(s.cookie, [['Email/get', { accountId: acct, ids: [emailId], properties: ['subject'] }, 'g']]);
  assert.equal(got.list[0].subject, 'Survives restart', 'message kept');
});
