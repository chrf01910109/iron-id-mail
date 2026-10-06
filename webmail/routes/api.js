/**
 * IRON ID Sovereign Email — Administrative REST API Router
 * Phase 2 Delivery: Clean HTTP REST endpoints for tenant onboarding, mailbox lifecycle,
 * quota enforcement, password resets, and automated DNS health checks.
 */
const tenantService = require('../services/tenantService');
const dnsValidator = require('../services/dnsValidator');

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 1e6) { // 1MB flood limit
        reject(new Error('Payload Too Large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON payload: ' + err.message));
      }
    });
    req.on('error', reject);
  });
}

function getRequester(req) {
  const fromHeader = req.headers['x-admin-account'] || req.headers['x-authenticated-user'] || '';
  if (fromHeader) return fromHeader.trim().toLowerCase();
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim().toLowerCase();
  return '';
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Account, X-Authenticated-User'
  });
  res.end(JSON.stringify(data, null, 2));
}

async function handleApiRequest(req, res, pathname) {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Account, X-Authenticated-User'
    });
    res.end();
    return true;
  }

  try {
    // 1. GET /api/stats
    if (req.method === 'GET' && pathname === '/api/stats') {
      const stats = tenantService.getSystemStats();
      sendJson(res, 200, { success: true, stats });
      return true;
    }

    // 2. GET /api/tenants
    if (req.method === 'GET' && pathname === '/api/tenants') {
      const tenants = tenantService.listTenants();
      sendJson(res, 200, { success: true, count: tenants.length, tenants });
      return true;
    }

    // 3. POST /api/tenants (Provision new tenant domain - Restricted to Master Admin)
    if (req.method === 'POST' && pathname === '/api/tenants') {
      const requester = getRequester(req);
      if (!tenantService.isMasterAdmin(requester)) {
        sendJson(res, 403, {
          success: false,
          error: 'Access Denied: Only the master administrator (admin@iron-id.io) has authority to provision sovereign domains.'
        });
        return true;
      }
      const payload = await parseBody(req);
      const newTenant = tenantService.createTenant({ ...payload, requesterEmail: requester });
      sendJson(res, 201, {
        success: true,
        message: `Tenant domain "${newTenant.domain}" successfully provisioned with Ed25519 DKIM keys.`,
        tenant: newTenant
      });
      return true;
    }

    // 4. GET /api/tenants/:domain
    const tenantMatch = pathname.match(/^\/api\/tenants\/([a-zA-Z0-9.-]+)$/);
    if (req.method === 'GET' && tenantMatch) {
      const domain = tenantMatch[1];
      const tenant = tenantService.getTenant(domain);
      if (!tenant) return sendJson(res, 404, { success: false, error: 'Tenant domain not found' });
      sendJson(res, 200, { success: true, tenant });
      return true;
    }

    // 4b. PATCH /api/tenants/:domain/dns (Update and customize DNS records & plan - Restricted to Master Admin)
    const tenantDnsMatch = pathname.match(/^\/api\/tenants\/([a-zA-Z0-9.-]+)\/dns$/);
    if (req.method === 'PATCH' && tenantDnsMatch) {
      const domain = tenantDnsMatch[1];
      const requester = getRequester(req);
      if (!tenantService.isMasterAdmin(requester)) {
        sendJson(res, 403, {
          success: false,
          error: 'Access Denied: Only the master administrator (admin@iron-id.io) has authority to modify sovereign DNS records.'
        });
        return true;
      }
      const payload = await parseBody(req);
      const updated = tenantService.updateTenantDns(domain, payload, requester);
      sendJson(res, 200, {
        success: true,
        message: `DNS records and plan updated for ${domain}.`,
        tenant: updated
      });
      return true;
    }

    // 4c. POST /api/tenants/:domain/regenerate-dkim (Re-key cryptographic DKIM - Restricted to Master Admin)
    const tenantDkimMatch = pathname.match(/^\/api\/tenants\/([a-zA-Z0-9.-]+)\/regenerate-dkim$/);
    if (req.method === 'POST' && tenantDkimMatch) {
      const domain = tenantDkimMatch[1];
      const requester = getRequester(req);
      if (!tenantService.isMasterAdmin(requester)) {
        sendJson(res, 403, {
          success: false,
          error: 'Access Denied: Only the master administrator (admin@iron-id.io) has authority to regenerate cryptographic keys.'
        });
        return true;
      }
      const payload = await parseBody(req);
      const updated = tenantService.regenerateDkim(domain, payload.keyType || 'ed25519', requester);
      sendJson(res, 200, {
        success: true,
        message: `Cryptographic DKIM regenerated for ${domain}.`,
        dkim: updated.dkim
      });
      return true;
    }

    // 5. GET /api/tenants/:domain/mailboxes
    const tenantMbMatch = pathname.match(/^\/api\/tenants\/([a-zA-Z0-9.-]+)\/mailboxes$/);
    if (req.method === 'GET' && tenantMbMatch) {
      const domain = tenantMbMatch[1];
      const mailboxes = tenantService.listMailboxes(domain);
      sendJson(res, 200, { success: true, domain, count: mailboxes.length, mailboxes });
      return true;
    }

    // 6. POST /api/tenants/:domain/mailboxes (Provision mailbox under tenant)
    if (req.method === 'POST' && tenantMbMatch) {
      const domain = tenantMbMatch[1];
      const payload = await parseBody(req);
      const email = payload.email && payload.email.includes('@') ? payload.email : `${payload.username}@${domain}`;
      const mailbox = tenantService.createMailbox({
        ...payload,
        email
      });
      sendJson(res, 201, { success: true, message: `Mailbox "${mailbox.email}" created successfully.`, mailbox });
      return true;
    }

    // 7. GET /api/mailboxes (List all across all domains)
    if (req.method === 'GET' && pathname === '/api/mailboxes') {
      const mailboxes = tenantService.listMailboxes();
      sendJson(res, 200, { success: true, count: mailboxes.length, mailboxes });
      return true;
    }

    // 8. PATCH /api/mailboxes/:email/status (Suspend / Activate)
    const mbStatusMatch = pathname.match(/^\/api\/mailboxes\/([^/]+)\/status$/);
    if (req.method === 'PATCH' && mbStatusMatch) {
      const email = decodeURIComponent(mbStatusMatch[1]);
      const payload = await parseBody(req);
      const result = tenantService.updateMailboxStatus(email, payload.status);
      sendJson(res, 200, { success: true, message: `Mailbox status set to ${payload.status}.`, result });
      return true;
    }

    // 9. POST /api/mailboxes/:email/reset-password
    const mbPwMatch = pathname.match(/^\/api\/mailboxes\/([^/]+)\/reset-password$/);
    if (req.method === 'POST' && mbPwMatch) {
      const email = decodeURIComponent(mbPwMatch[1]);
      const payload = await parseBody(req);
      const result = tenantService.resetPassword(email, payload.newPassword);
      sendJson(res, 200, { success: true, result });
      return true;
    }

    // 10. PATCH /api/mailboxes/:email/quota
    const mbQuotaMatch = pathname.match(/^\/api\/mailboxes\/([^/]+)\/quota$/);
    if (req.method === 'PATCH' && mbQuotaMatch) {
      const email = decodeURIComponent(mbQuotaMatch[1]);
      const payload = await parseBody(req);
      const updated = tenantService.updateQuota(email, payload);
      sendJson(res, 200, { success: true, message: 'Quota and limits updated.', mailbox: updated });
      return true;
    }

    // 11. POST /api/mailboxes/validate-submission (Check quota & rate limit before send)
    if (req.method === 'POST' && pathname === '/api/mailboxes/validate-submission') {
      const payload = await parseBody(req);
      const check = tenantService.validateSubmission(payload.email, payload.estimatedBytes);
      sendJson(res, 200, { success: true, validation: check });
      return true;
    }

    // 12. GET /api/dns/verify/:domain (Live automated DNS verification)
    const dnsMatch = pathname.match(/^\/api\/dns\/verify\/([a-zA-Z0-9.-]+)$/);
    if (req.method === 'GET' && dnsMatch) {
      const domain = dnsMatch[1];
      const tenant = tenantService.getTenant(domain);
      const dkimTxt = tenant && tenant.dkim ? tenant.dkim.dnsTxt : null;
      const verification = await dnsValidator.verifyDomain(domain, { dkimTxt });
      sendJson(res, 200, { success: true, verification });
      return true;
    }

    // 13. GET /api/audit (Audit log entries)
    if (req.method === 'GET' && pathname === '/api/audit') {
      sendJson(res, 200, { success: true, log: tenantService.store.auditLog });
      return true;
    }

    // If matches /api/* but route not found:
    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { success: false, error: `API route not found: ${req.method} ${pathname}` });
      return true;
    }

    return false; // Not an API route
  } catch (err) {
    sendJson(res, 400, { success: false, error: err.message });
    return true;
  }
}

module.exports = { handleApiRequest };
