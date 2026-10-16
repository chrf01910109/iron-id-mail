// The gateway's own engine access: set up automatically, and limited to what the console needs.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { ROLE_PERMISSIONS, OPTIONAL_PERMISSIONS } = require('../../webmail/services/engineAdmin');

before(async () => { await h.waitHealthy(120000, { requireAdmin: true }); });

test('gateway has working engine admin access', async () => {
  const r = await h.gw('/healthz');
  assert.ok(['ok', 'provisioned'].includes(r.json.adminAccess), `adminAccess = ${r.json.adminAccess}`);
});

test('gateway role grants only the expected permissions', async () => {
  const [[, roles]] = await h.engine(h.recoveryAuth(), [['x:Role/get', { ids: null, properties: ['description', 'enabledPermissions'] }, 'r']]);
  const role = roles.list.find(r => r.description === 'IRON ID Gateway (control plane)');
  assert.ok(role, 'gateway role exists');
  const granted = Object.keys(role.enabledPermissions || {}).filter(k => role.enabledPermissions[k]);
  // The engine only lets an account create mailboxes and teams with permissions it holds, so the
  // role also carries the built-in User and Group permissions (for its own, empty account).
  const grantable = new Set();
  for (const r of roles.list.filter(x => ['User', 'Group'].includes(x.description))) {
    for (const [k, v] of Object.entries(r.enabledPermissions || {})) if (v) grantable.add(k);
  }
  // The certificate permissions (server kit, import-certificate.js) are added when the role is synced
  // with the recovery admin.
  const unexpected = granted.filter(p => !ROLE_PERMISSIONS[p] && !OPTIONAL_PERMISSIONS[p] && !grantable.has(p));
  assert.deepEqual(unexpected, [], 'no permissions beyond the console needs');
  for (const p of ['impersonate', 'sysSystemSettingsGet', 'sysSystemSettingsUpdate', 'sysNetworkListenerGet', 'sysRoleCreate', 'sysRoleUpdate', 'fetchAnyBlob']) {
    assert.ok(!granted.includes(p), `must not have ${p}`);
  }
});

test('gateway service account uses only its custom role (no mail rights)', async () => {
  const [[, accts]] = await h.engine(h.recoveryAuth(), [['x:Account/get', { ids: null, properties: ['name', 'roles'] }, 'a']]);
  const svc = accts.list.find(a => a.name === 'gateway');
  assert.ok(svc, 'service account exists');
  assert.equal(svc.roles['@type'], 'Custom');
});
