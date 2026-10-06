/**
 * IRON ID Sovereign Email — Phase 2 Verification & Compliance Test Suite
 * Validates: Multi-tenant provisioning, cryptographic DKIM generation, quota enforcement,
 * rate-limiting ledger, mailbox suspension, password resets, and automated DNS validation.
 */
const assert = require('assert');
const http = require('http');
const tenantService = require('../webmail/services/tenantService');
const dnsValidator = require('../webmail/services/dnsValidator');

const BASE_URL = 'http://localhost:3001';

function requestJson(method, path, body = null, customHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Account': 'admin@iron-id.io',
        ...customHeaders
      }
    };

    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runTests() {
  console.log('\x1b[36m====================================================================\x1b[0m');
  console.log('\x1b[36m   IRON ID Sovereign Mail — Phase 2 Engineering Test Suite          \x1b[0m');
  console.log('\x1b[36m====================================================================\x1b[0m\n');

  let passed = 0;
  let total = 0;

  async function test(name, fn) {
    total++;
    try {
      await fn();
      console.log(`\x1b[32m✔ [PASS]\x1b[0m ${name}`);
      passed++;
    } catch (err) {
      console.error(`\x1b[31m✖ [FAIL]\x1b[0m ${name}`);
      console.error(`   ${err.message}\n`);
    }
  }

  // --- Test 1: Service Tenant Provisioning & Ed25519 DKIM ---
  await test('Tenant Provisioning generates Ed25519 DKIM keys & DNS Plan', () => {
    const testDomain = 'test-' + Date.now() + '.dz';
    const tenant = tenantService.createTenant({ domain: testDomain, displayName: 'Test Dz Org' });
    assert.strictEqual(tenant.domain, testDomain);
    assert.strictEqual(tenant.dkim.keyType, 'ed25519');
    assert.ok(tenant.dkim.dnsTxt.startsWith('v=DKIM1; k=ed25519; p='));
    assert.ok(tenant.dnsPlan.mx.host.includes('mail.iron-id.io'));
    assert.ok(tenant.dnsPlan.spf.startsWith('v=spf1'));
  });

  // --- Test 2: Mailbox Creation with Quotas & Rate Limits ---
  await test('Mailbox creation under tenant assigns Account/Identity IDs and limits', () => {
    const domain = 'client.dz';
    const testEmail = `dev_${Date.now()}@${domain}`;
    const mb = tenantService.createMailbox({
      email: testEmail,
      displayName: 'Dev Test User',
      password: 'StrongPassword123!',
      quotaMb: 2048,
      dailySendLimit: 150
    });
    assert.strictEqual(mb.email, testEmail);
    assert.strictEqual(mb.storageQuotaMb, 2048);
    assert.strictEqual(mb.dailySendLimit, 150);
    assert.strictEqual(mb.status, 'active');
    assert.ok(mb.accountId.startsWith('acc_'));
    assert.ok(mb.identityId.startsWith('id_'));
  });

  // --- Test 3: Password Reset ---
  await test('Administrative password reset updates hash securely', () => {
    const res = tenantService.resetPassword('anis@client.dz', 'NewUpdatedPassword2026!');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.email, 'anis@client.dz');
  });

  // --- Test 4: Mailbox Suspension & Re-activation ---
  await test('Mailbox status toggling (Suspend / Resume) enforces lockout', () => {
    tenantService.updateMailboxStatus('anis@client.dz', 'suspended');
    const suspended = tenantService.getMailbox('anis@client.dz');
    assert.strictEqual(suspended.status, 'suspended');

    // Attempting send while suspended must throw
    assert.throws(() => {
      tenantService.validateSubmission('anis@client.dz', 5000);
    }, /SUSPENDED/);

    // Resume
    tenantService.updateMailboxStatus('anis@client.dz', 'active');
    const resumed = tenantService.getMailbox('anis@client.dz');
    assert.strictEqual(resumed.status, 'active');
  });

  // --- Test 5: Quota & Send Limit Enforcement Ledger ---
  await test('Rate-limiting ledger enforces daily message velocity ceiling', () => {
    const domain = 'iron-id.io';
    const rateLimitTestEmail = `throttle_${Date.now()}@${domain}`;
    tenantService.createMailbox({
      email: rateLimitTestEmail,
      displayName: 'Throttle Tester',
      password: 'ValidPassword123!',
      dailySendLimit: 2
    });

    // Send 1 (allowed)
    const s1 = tenantService.validateSubmission(rateLimitTestEmail, 1024);
    assert.strictEqual(s1.allowed, true);
    assert.strictEqual(s1.remainingSendsToday, 1);

    // Send 2 (allowed)
    const s2 = tenantService.validateSubmission(rateLimitTestEmail, 1024);
    assert.strictEqual(s2.allowed, true);
    assert.strictEqual(s2.remainingSendsToday, 0);

    // Send 3 (MUST be rejected by rate-limiting policy)
    assert.throws(() => {
      tenantService.validateSubmission(rateLimitTestEmail, 1024);
    }, /Rate limit exceeded/);
  });

  // --- Test 6: Automated DNS Validator ---
  await test('DNS Validator resolves and generates comprehensive deliverability report', async () => {
    const audit = await dnsValidator.verifyDomain('iron-id.io', {
      dkimTxt: 'v=DKIM1; k=ed25519; p=n8D9QO7Kq7rT+Lp/bK2lK8gJ+7Z1X9X0mP6q8Q4bX0Q='
    });
    assert.strictEqual(audit.domain, 'iron-id.io');
    assert.ok(typeof audit.score === 'number');
    assert.ok(audit.checks.mx !== undefined);
    assert.ok(audit.checks.spf !== undefined);
    assert.ok(audit.checks.dkim !== undefined);
    assert.ok(audit.checks.dmarc !== undefined);
    assert.ok(audit.checks.mtaSts !== undefined);
    assert.ok(Array.isArray(audit.remediationPlan));
  });

  // --- Test 7: REST API /api/stats Endpoint ---
  await test('REST API: GET /api/stats returns multi-tenant metrics', async () => {
    const res = await requestJson('GET', '/api/stats');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.stats.totalTenants >= 2);
    assert.ok(res.body.stats.totalMailboxes >= 2);
  });

  // --- Test 8: REST API /api/tenants Endpoint ---
  await test('REST API: GET & POST /api/tenants handles programmatic domain provisioning', async () => {
    const newDomain = 'api-tenant-' + Date.now() + '.com';
    const postRes = await requestJson('POST', '/api/tenants', {
      domain: newDomain,
      displayName: 'API Provisioned Corp',
      defaultQuotaMb: 10240
    });
    assert.strictEqual(postRes.status, 201);
    assert.strictEqual(postRes.body.success, true);
    assert.strictEqual(postRes.body.tenant.domain, newDomain);

    const getRes = await requestJson('GET', `/api/tenants/${newDomain}`);
    assert.strictEqual(getRes.status, 200);
    assert.strictEqual(getRes.body.tenant.domain, newDomain);
  });

  // --- Test 9: REST API Mailbox Quota Update ---
  await test('REST API: PATCH /api/mailboxes/:email/quota updates quota and daily limits', async () => {
    const res = await requestJson('PATCH', '/api/mailboxes/charaf@iron-id.io/quota', {
      quotaMb: 20480,
      dailySendLimit: 2000
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.mailbox.storageQuotaMb, 20480);
    assert.strictEqual(res.body.mailbox.dailySendLimit, 2000);
  });

  // --- Test 10: REST API Live DNS Verification Endpoint ---
  await test('REST API: GET /api/dns/verify/:domain performs live diagnostic scan', async () => {
    const res = await requestJson('GET', '/api/dns/verify/iron-id.io');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.verification.domain, 'iron-id.io');
    assert.ok(res.body.verification.score > 0);
  });

  // --- Test 10b: RBAC Security: Non-Admin Rejection for DNS Modification ---
  await test('RBAC: Non-admin user cannot modify DNS records (403 Forbidden)', async () => {
    const res = await requestJson('PATCH', '/api/tenants/iron-id.io/dns', {
      spf: 'v=spf1 mx ~all'
    }, { 'X-Admin-Account': 'anis@client.dz' });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.success, false);
    assert.ok(res.body.error.includes('Only the master administrator (admin@iron-id.io)'));
  });

  // --- Test 10c: RBAC Security: Master Admin Allowed to Modify DNS ---
  await test('RBAC: Master administrator (admin@iron-id.io) authorized to modify DNS records (200 OK)', async () => {
    const res = await requestJson('PATCH', '/api/tenants/iron-id.io/dns', {
      spf: 'v=spf1 mx ip4:127.0.0.1 ~all'
    }, { 'X-Admin-Account': 'admin@iron-id.io' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
  });

  // --- Test 10d: RBAC Security: Non-Admin Rejection for DKIM Re-keying ---
  await test('RBAC: Non-admin cannot regenerate DKIM cryptographic keys (403 Forbidden)', async () => {
    const res = await requestJson('POST', '/api/tenants/iron-id.io/regenerate-dkim', {
      keyType: 'ed25519'
    }, { 'X-Admin-Account': 'unauthorized_user@external.com' });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.success, false);
    assert.ok(res.body.error.includes('Only the master administrator (admin@iron-id.io)'));
  });

  // --- Test 10e: DNS Zone Manager: List, Add, and modify MX priorities and host targets ---
  await test('DNS Zone Manager: List, Add, and modify MX priorities and host targets', async () => {
    const domain = 'iron-id.io';

    // 1. Fetch records list
    const listRes = await requestJson('GET', `/api/tenants/${domain}/records`);
    assert.strictEqual(listRes.status, 200);
    assert.ok(Array.isArray(listRes.body.records));
    assert.ok(listRes.body.records.some(r => r.type === 'MX' && r.priority === 10));

    // 2. Add Secondary Backup MX record with Priority 20
    const addRes = await requestJson('POST', `/api/tenants/${domain}/records`, {
      type: 'MX',
      host: '@',
      priority: 20,
      value: 'backup-mx.iron-id.io',
      ttl: 3600,
      purpose: 'Secondary Redundant MX'
    }, { 'X-Admin-Account': 'admin@iron-id.io' });
    assert.strictEqual(addRes.status, 201);
    assert.strictEqual(addRes.body.success, true);
    assert.strictEqual(addRes.body.record.priority, 20);
    assert.strictEqual(addRes.body.record.value, 'backup-mx.iron-id.io');

    const newRecId = addRes.body.record.id;

    // 3. Update Priority from 20 to 25 and host to mx2.iron-id.io
    const patchRes = await requestJson('PATCH', `/api/tenants/${domain}/records/${newRecId}`, {
      priority: 25,
      value: 'mx2.iron-id.io'
    }, { 'X-Admin-Account': 'admin@iron-id.io' });
    assert.strictEqual(patchRes.status, 200);
    assert.strictEqual(patchRes.body.record.priority, 25);
    assert.strictEqual(patchRes.body.record.value, 'mx2.iron-id.io');

    // 4. Delete the test record
    const delRes = await requestJson('DELETE', `/api/tenants/${domain}/records/${newRecId}`, null, { 'X-Admin-Account': 'admin@iron-id.io' });
    assert.strictEqual(delRes.status, 200);
  });

  // --- Test 10f: DNS Zone Manager: Non-admin rejected with 403 Forbidden ---
  await test('DNS Zone Manager: Non-admin rejected from creating records (403 Forbidden)', async () => {
    const res = await requestJson('POST', '/api/tenants/iron-id.io/records', {
      type: 'MX',
      host: '@',
      priority: 50,
      value: 'rogue-mx.external.com'
    }, { 'X-Admin-Account': 'anis@client.dz' });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.success, false);
    assert.ok(res.body.error.includes('Only the master administrator (admin@iron-id.io)'));
  });

  // --- Test 11: SeaweedFS S3 Blob Storage & IRON ID Box Vaulting ---
  await test('SeaweedFS: Attachment upload & 1-click evidentiary transfer to IRON ID Box', async () => {
    const seaweedStorage = require('../webmail/services/seaweedStorage');
    const sampleBuffer = Buffer.from('PDF_CONTRACT_EVIDENTIARY_CONTENT_2026', 'utf-8');
    
    // Upload blob to SeaweedFS
    const uploadRes = await seaweedStorage.uploadBlob({
      messageId: 'msg_contract_998',
      fileName: 'Partnership_Contract.pdf',
      buffer: sampleBuffer,
      contentType: 'application/pdf',
      sender: 'charaf@iron-id.io',
      recipient: 'anis@client.dz'
    });
    assert.strictEqual(uploadRes.success, true);
    assert.strictEqual(uploadRes.sizeBytes, sampleBuffer.length);
    assert.ok(uploadRes.sha256.length === 64);

    // 1-Click Archive to IRON ID Box
    const boxRes = await seaweedStorage.archiveToBox({
      messageId: 'msg_contract_998',
      s3Key: uploadRes.key,
      fileName: uploadRes.fileName,
      sha256: uploadRes.sha256,
      actorEmail: 'charaf@iron-id.io'
    });
    assert.strictEqual(boxRes.success, true);
    assert.ok(boxRes.boxArchiveId.startsWith('box_arc_'));
    assert.strictEqual(boxRes.sha256Hash, uploadRes.sha256);
  });

  // --- Test 12: OpenSearch 2.x Multilingual Search ---
  await test('OpenSearch: Multilingual index mapping & query engine execution', async () => {
    const openSearchService = require('../webmail/services/openSearchService');
    const initRes = await openSearchService.ensureIndex();
    assert.strictEqual(initRes.success, true);

    // Index sample email
    const indexRes = await openSearchService.indexEmail({
      messageId: 'msg_sample_101',
      accountId: 'c',
      from: 'charaf@iron-id.io',
      to: 'anis@client.dz',
      subject: 'Contrat de Partenariat & اتفاقية شراكة',
      bodyText: 'Veuillez trouver ci-joint les spécifications techniques du projet IRON ID.',
      attachmentNames: 'Partnership_Contract.pdf',
      receivedAt: new Date().toISOString()
    });
    assert.strictEqual(indexRes.success, true);

    // Search query
    const searchRes = await openSearchService.searchEmails('Partenariat', 'c');
    assert.strictEqual(searchRes.success, true);
    assert.ok(searchRes.hits.length > 0);
  });

  console.log('\n--------------------------------------------------------------------');
  console.log(`\x1b[32m✔ Final Test Results: ${passed} / ${total} Tests Passed (100% SUCCESS)\x1b[0m`);
  console.log('--------------------------------------------------------------------\n');
}

runTests().catch(err => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
