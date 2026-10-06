/**
 * IRON ID Sovereign Email — Tenant & Mailbox Provisioning Service
 * Phase 2 Delivery: Multi-tenant directory management, cryptographic DKIM generation,
 * quota tracking, and rate-limiting ledger.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function resolveDataFile() {
  const candidates = [
    path.join(__dirname, '..', '..', 'engine', 'tenants.json'),
    path.join('/opt/iron-id/engine/tenants.json'),
    path.join(process.cwd(), 'engine', 'tenants.json'),
    path.join(process.cwd(), '..', 'engine', 'tenants.json')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}
const DATA_FILE = resolveDataFile();

// Default Seed Data
const DEFAULT_STORE = {
  tenants: {
    'iron-id.io': {
      domain: 'iron-id.io',
      displayName: 'IRON ID Sovereign HQ',
      status: 'active',
      createdAt: '2026-09-23T18:00:00.000Z',
      dkim: {
        selector: 'stalwart',
        keyType: 'ed25519',
        publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAn8D9QO7Kq7rT+Lp/bK2lK8gJ+7Z1X9X0mP6q8Q4bX0Q=\n-----END PUBLIC KEY-----',
        dnsTxt: 'v=DKIM1; k=ed25519; p=n8D9QO7Kq7rT+Lp/bK2lK8gJ+7Z1X9X0mP6q8Q4bX0Q='
      },
      dnsPlan: {
        mx: { host: 'mail.iron-id.io', priority: 10 },
        spf: 'v=spf1 mx ip4:127.0.0.1 ~all',
        dmarc: 'v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@iron-id.io; ruf=mailto:dmarc@iron-id.io; fo=1',
        mtaSts: 'v=STSv1; id=20260923T01; mode=enforce; max_age=86400'
      },
      defaultQuotaMb: 10240, // 10 GB
      defaultDailyLimit: 1000
    },
    'client.dz': {
      domain: 'client.dz',
      displayName: 'Client DZ Partner Tenant',
      status: 'active',
      createdAt: '2026-09-23T18:30:00.000Z',
      dkim: {
        selector: 'stalwart',
        keyType: 'ed25519',
        publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAd5X8J2eQ3uY9kP+M4tL1mQ8vZ3bX2vW1qO9sT8yU7X8=\n-----END PUBLIC KEY-----',
        dnsTxt: 'v=DKIM1; k=ed25519; p=d5X8J2eQ3uY9kP+M4tL1mQ8vZ3bX2vW1qO9sT8yU7X8='
      },
      dnsPlan: {
        mx: { host: 'mail.iron-id.io', priority: 10 },
        spf: 'v=spf1 mx ip4:127.0.0.1 ~all',
        dmarc: 'v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@client.dz',
        mtaSts: 'v=STSv1; id=20260923T01; mode=enforce; max_age=86400'
      },
      defaultQuotaMb: 5120, // 5 GB
      defaultDailyLimit: 250
    }
  },
  mailboxes: {
    'charaf@iron-id.io': {
      email: 'charaf@iron-id.io',
      domain: 'iron-id.io',
      accountId: 'c',
      identityId: 'b',
      displayName: 'Charaf Sellam',
      role: 'admin',
      status: 'active', // 'active' | 'suspended'
      passwordHash: hashPassword('Ch@r@firon-!D'),
      storageQuotaMb: 10240,
      usedStorageMb: 42.5,
      dailySendLimit: 1000,
      todaySentCount: 2,
      lastActiveAt: '2026-10-05T20:10:00.000Z',
      createdAt: '2026-09-23T18:00:00.000Z'
    },
    'anis@client.dz': {
      email: 'anis@client.dz',
      domain: 'client.dz',
      accountId: 'e',
      identityId: 'd',
      displayName: 'Anis Client',
      role: 'tenant_user',
      status: 'active',
      passwordHash: hashPassword('anistestmail'),
      storageQuotaMb: 5120,
      usedStorageMb: 14.8,
      dailySendLimit: 250,
      todaySentCount: 1,
      lastActiveAt: '2026-10-05T20:10:00.000Z',
      createdAt: '2026-09-23T18:30:00.000Z'
    }
  },
  auditLog: [
    {
      timestamp: '2026-09-23T18:00:00.000Z',
      action: 'TENANT_INITIALIZED',
      domain: 'iron-id.io',
      details: 'Root authoritative sovereign domain provisioned.'
    },
    {
      timestamp: '2026-09-23T18:30:00.000Z',
      action: 'TENANT_INITIALIZED',
      domain: 'client.dz',
      details: 'Secondary client test tenant provisioned.'
    }
  ]
};

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + '_IRON_ID_SALT_2026').digest('hex');
}

class TenantService {
  constructor() {
    this.store = this.loadStore();
  }

  loadStore() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.warn('[TenantService] Failed reading tenants.json, initializing default:', err.message);
    }
    this.saveStore(DEFAULT_STORE);
    return DEFAULT_STORE;
  }

  saveStore(data = this.store) {
    try {
      const dir = path.dirname(DATA_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error('[TenantService] Store save error:', err.message);
    }
  }

  logAudit(action, domain, details) {
    this.store.auditLog.unshift({
      timestamp: new Date().toISOString(),
      action,
      domain,
      details
    });
    if (this.store.auditLog.length > 200) this.store.auditLog.pop();
  }

  // --- Tenant Domain Methods ---

  listTenants() {
    return Object.values(this.store.tenants).map(tenant => {
      const tenantMailboxes = Object.values(this.store.mailboxes).filter(m => m.domain === tenant.domain);
      const totalUsedStorage = tenantMailboxes.reduce((acc, m) => acc + (m.usedStorageMb || 0), 0);
      const totalAllocatedQuota = tenantMailboxes.reduce((acc, m) => acc + (m.storageQuotaMb || 0), 0);
      return {
        ...tenant,
        mailboxCount: tenantMailboxes.length,
        totalUsedStorageMb: parseFloat(totalUsedStorage.toFixed(2)),
        totalAllocatedQuotaMb: totalAllocatedQuota
      };
    });
  }

  getTenant(domain) {
    const cleanDomain = (domain || '').trim().toLowerCase();
    const tenant = this.store.tenants[cleanDomain];
    if (!tenant) return null;

    const mailboxes = Object.values(this.store.mailboxes).filter(m => m.domain === cleanDomain);
    return {
      ...tenant,
      mailboxes: mailboxes.map(m => {
        const { passwordHash, ...safe } = m;
        return safe;
      })
    };
  }

  createTenant({ domain, displayName, defaultQuotaMb = 5120, defaultDailyLimit = 250, vpsIp = '127.0.0.1' }) {
    const cleanDomain = (domain || '').trim().toLowerCase();
    if (!cleanDomain || !cleanDomain.includes('.')) {
      throw new Error('Invalid domain format. Domain must contain a valid TLD.');
    }
    if (this.store.tenants[cleanDomain]) {
      throw new Error(`Tenant domain "${cleanDomain}" is already provisioned.`);
    }

    // Generate cryptographic Ed25519 DKIM Keypair
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const rawPubBase64 = pubPem.replace(/-----BEGIN PUBLIC KEY-----|\n|-----END PUBLIC KEY-----/g, '').trim();

    const newTenant = {
      domain: cleanDomain,
      displayName: displayName || cleanDomain.toUpperCase(),
      status: 'active',
      createdAt: new Date().toISOString(),
      dkim: {
        selector: 'stalwart',
        keyType: 'ed25519',
        publicKeyPem: pubPem,
        dnsTxt: `v=DKIM1; k=ed25519; p=${rawPubBase64}`
      },
      dnsPlan: {
        mx: { host: 'mail.iron-id.io', priority: 10 },
        spf: `v=spf1 mx ip4:${vpsIp} ~all`,
        dmarc: `v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@${cleanDomain}`,
        mtaSts: `v=STSv1; id=${new Date().toISOString().slice(0, 10).replace(/-/g, '')}T01; mode=enforce; max_age=86400`
      },
      defaultQuotaMb: Number(defaultQuotaMb) || 5120,
      defaultDailyLimit: Number(defaultDailyLimit) || 250
    };

    this.store.tenants[cleanDomain] = newTenant;
    this.logAudit('TENANT_CREATED', cleanDomain, `Provisioned new tenant domain with Ed25519 DKIM keys.`);
    this.saveStore();

    return newTenant;
  }

  // --- Mailbox Methods ---

  listMailboxes(domainFilter = null) {
    let list = Object.values(this.store.mailboxes);
    if (domainFilter) {
      const cleanFilter = domainFilter.trim().toLowerCase();
      list = list.filter(m => m.domain === cleanFilter);
    }
    return list.map(m => {
      const { passwordHash, ...safe } = m;
      return safe;
    });
  }

  getMailbox(email) {
    const cleanEmail = (email || '').trim().toLowerCase();
    const mb = this.store.mailboxes[cleanEmail];
    if (!mb) return null;
    const { passwordHash, ...safe } = mb;
    return safe;
  }

  createMailbox({ email, displayName, password, quotaMb, dailySendLimit, role = 'tenant_user' }) {
    const cleanEmail = (email || '').trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      throw new Error('Invalid email format.');
    }
    if (this.store.mailboxes[cleanEmail]) {
      throw new Error(`Mailbox "${cleanEmail}" already exists.`);
    }

    const domain = cleanEmail.split('@')[1];
    const tenant = this.store.tenants[domain];
    if (!tenant) {
      throw new Error(`Domain "${domain}" is not a registered tenant. Provision domain first.`);
    }
    if (tenant.status !== 'active') {
      throw new Error(`Tenant domain "${domain}" is currently suspended.`);
    }

    if (!password || password.length < 8) {
      throw new Error('Password must be at least 8 characters long.');
    }

    // Auto-generate stable deterministic JMAP accountId & identityId
    const accountId = 'acc_' + crypto.createHash('md5').update(cleanEmail).digest('hex').slice(0, 8);
    const identityId = 'id_' + crypto.createHash('md5').update(cleanEmail + '_identity').digest('hex').slice(0, 8);

    const newMb = {
      email: cleanEmail,
      domain,
      accountId,
      identityId,
      displayName: displayName || cleanEmail.split('@')[0],
      role: role === 'admin' ? 'admin' : 'tenant_user',
      status: 'active',
      passwordHash: hashPassword(password),
      storageQuotaMb: Number(quotaMb) || tenant.defaultQuotaMb || 5120,
      usedStorageMb: 0.1,
      dailySendLimit: Number(dailySendLimit) || tenant.defaultDailyLimit || 250,
      todaySentCount: 0,
      lastActiveAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    };

    this.store.mailboxes[cleanEmail] = newMb;
    this.logAudit('MAILBOX_CREATED', domain, `Created mailbox ${cleanEmail} (Quota: ${newMb.storageQuotaMb}MB, Limit: ${newMb.dailySendLimit}/day)`);
    this.saveStore();

    const { passwordHash, ...safe } = newMb;
    return safe;
  }

  resetPassword(email, newPassword) {
    const cleanEmail = (email || '').trim().toLowerCase();
    const mb = this.store.mailboxes[cleanEmail];
    if (!mb) throw new Error(`Mailbox "${cleanEmail}" does not exist.`);
    if (!newPassword || newPassword.length < 8) {
      throw new Error('New password must be at least 8 characters long.');
    }

    mb.passwordHash = hashPassword(newPassword);
    this.logAudit('PASSWORD_RESET', mb.domain, `Password reset executed for ${cleanEmail}.`);
    this.saveStore();

    return { email: cleanEmail, success: true, message: 'Password updated successfully.' };
  }

  updateMailboxStatus(email, status) {
    const cleanEmail = (email || '').trim().toLowerCase();
    const mb = this.store.mailboxes[cleanEmail];
    if (!mb) throw new Error(`Mailbox "${cleanEmail}" does not exist.`);
    if (!['active', 'suspended'].includes(status)) {
      throw new Error('Status must be either "active" or "suspended".');
    }

    mb.status = status;
    this.logAudit('MAILBOX_STATUS_CHANGE', mb.domain, `Mailbox ${cleanEmail} status changed to ${status}.`);
    this.saveStore();

    return { email: cleanEmail, status: mb.status, success: true };
  }

  updateQuota(email, { quotaMb, dailySendLimit }) {
    const cleanEmail = (email || '').trim().toLowerCase();
    const mb = this.store.mailboxes[cleanEmail];
    if (!mb) throw new Error(`Mailbox "${cleanEmail}" does not exist.`);

    if (quotaMb !== undefined) mb.storageQuotaMb = Number(quotaMb);
    if (dailySendLimit !== undefined) mb.dailySendLimit = Number(dailySendLimit);

    this.logAudit('QUOTA_UPDATED', mb.domain, `Mailbox ${cleanEmail} quota: ${mb.storageQuotaMb}MB, sendLimit: ${mb.dailySendLimit}/day.`);
    this.saveStore();

    const { passwordHash, ...safe } = mb;
    return safe;
  }

  // --- Rate-Limiting & Quota Validation Engine ---

  validateSubmission(email, estimatedBytes = 10240) {
    const cleanEmail = (email || '').trim().toLowerCase();
    const mb = this.store.mailboxes[cleanEmail];
    if (!mb) throw new Error(`Sender mailbox "${cleanEmail}" not found.`);

    if (mb.status === 'suspended') {
      throw new Error(`Mailbox "${cleanEmail}" is SUSPENDED by administrator policy.`);
    }

    const tenant = this.store.tenants[mb.domain];
    if (tenant && tenant.status === 'suspended') {
      throw new Error(`Tenant domain "${mb.domain}" is currently suspended.`);
    }

    // Check Daily Send Limit
    if (mb.todaySentCount >= mb.dailySendLimit) {
      throw new Error(`Rate limit exceeded: Mailbox "${cleanEmail}" has reached its daily quota of ${mb.dailySendLimit} messages.`);
    }

    // Check Storage Quota
    const estimatedMb = estimatedBytes / (1024 * 1024);
    if ((mb.usedStorageMb + estimatedMb) > mb.storageQuotaMb) {
      throw new Error(`Storage quota exceeded: Mailbox "${cleanEmail}" has used ${mb.usedStorageMb.toFixed(1)}MB of allowed ${mb.storageQuotaMb}MB.`);
    }

    // Increment Send Counter and Storage
    mb.todaySentCount += 1;
    mb.usedStorageMb = parseFloat((mb.usedStorageMb + estimatedMb).toFixed(3));
    mb.lastActiveAt = new Date().toISOString();
    this.saveStore();

    return {
      allowed: true,
      remainingSendsToday: mb.dailySendLimit - mb.todaySentCount,
      usedStorageMb: mb.usedStorageMb,
      quotaMb: mb.storageQuotaMb
    };
  }

  getSystemStats() {
    const tenantsList = Object.values(this.store.tenants);
    const mailboxesList = Object.values(this.store.mailboxes);

    const totalUsedMb = mailboxesList.reduce((acc, m) => acc + (m.usedStorageMb || 0), 0);
    const totalAllocatedMb = mailboxesList.reduce((acc, m) => acc + (m.storageQuotaMb || 0), 0);

    return {
      totalTenants: tenantsList.length,
      activeTenants: tenantsList.filter(t => t.status === 'active').length,
      totalMailboxes: mailboxesList.length,
      activeMailboxes: mailboxesList.filter(m => m.status === 'active').length,
      suspendedMailboxes: mailboxesList.filter(m => m.status === 'suspended').length,
      totalUsedStorageMb: parseFloat(totalUsedMb.toFixed(2)),
      totalAllocatedQuotaMb: totalAllocatedMb,
      storageUtilizationPct: totalAllocatedMb > 0 ? parseFloat(((totalUsedMb / totalAllocatedMb) * 100).toFixed(2)) : 0,
      totalAuditEntries: this.store.auditLog.length
    };
  }
}

module.exports = new TenantService();
