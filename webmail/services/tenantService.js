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
        selector: 'ironid',
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
        selector: 'ironid',
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
    'admin@iron-id.io': {
      email: 'admin@iron-id.io',
      domain: 'iron-id.io',
      accountId: 'master_admin',
      identityId: 'id_admin',
      displayName: 'IRON ID Master Administrator',
      role: 'superadmin',
      status: 'active',
      passwordHash: hashPassword('AdminIronID2026!'),
      storageQuotaMb: 51200,
      usedStorageMb: 0.1,
      dailySendLimit: 5000,
      todaySentCount: 0,
      lastActiveAt: '2026-10-06T18:00:00.000Z',
      createdAt: '2026-09-23T18:00:00.000Z'
    },
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
        const store = JSON.parse(raw);
        let migrated = false;
        for (const t of Object.values(store.tenants || {})) {
          if (t.dkim && (t.dkim.selector === 'stalwart' || !t.dkim.selector)) {
            t.dkim.selector = 'ironid';
            migrated = true;
          }
        }
        // Ensure authoritative master admin exists
        if (!store.mailboxes || !store.mailboxes['admin@iron-id.io']) {
          if (!store.mailboxes) store.mailboxes = {};
          store.mailboxes['admin@iron-id.io'] = {
            email: 'admin@iron-id.io',
            domain: 'iron-id.io',
            accountId: 'master_admin',
            identityId: 'id_admin',
            displayName: 'IRON ID Master Administrator',
            role: 'superadmin',
            status: 'active',
            passwordHash: hashPassword('AdminIronID2026!'),
            storageQuotaMb: 51200,
            usedStorageMb: 0.1,
            dailySendLimit: 5000,
            todaySentCount: 0,
            lastActiveAt: new Date().toISOString(),
            createdAt: '2026-09-23T18:00:00.000Z'
          };
          migrated = true;
        }
        if (migrated) {
          try {
            fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
          } catch(e) {}
        }
        return store;
      }
    } catch (err) {
      console.warn('[TenantService] Failed reading tenants.json, initializing default:', err.message);
    }
    this.saveStore(DEFAULT_STORE);
    return DEFAULT_STORE;
  }

  isMasterAdmin(email) {
    if (!email) return false;
    const clean = String(email).trim().toLowerCase();
    return clean === 'admin@iron-id.io' || clean === 'charaf@iron-id.io';
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

  // --- DNS Zone & Record Management Methods ---

  buildDefaultRecords(tenant) {
    const domain = tenant.domain;
    const mxHost = tenant.dnsPlan?.mx?.host || 'mail.iron-id.io';
    const mxPriority = tenant.dnsPlan?.mx?.priority ?? 10;
    const spf = tenant.dnsPlan?.spf || 'v=spf1 mx ip4:127.0.0.1 ~all';
    const sel = tenant.dkim?.selector || 'ironid';
    const dkimTxt = tenant.dkim?.dnsTxt || '';
    const dmarc = tenant.dnsPlan?.dmarc || `v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@${domain}`;
    const mtaSts = tenant.dnsPlan?.mtaSts || `v=STSv1; id=20261006T01; mode=enforce; max_age=86400`;

    return [
      {
        id: 'rec_mx_10',
        type: 'MX',
        host: '@',
        priority: Number(mxPriority) || 10,
        value: mxHost,
        ttl: 3600,
        purpose: 'Primary Sovereign Mail Exchanger'
      },
      {
        id: 'rec_txt_spf',
        type: 'TXT',
        host: '@',
        priority: null,
        value: spf,
        ttl: 3600,
        purpose: 'Sender Policy Framework (SPF Policy)'
      },
      {
        id: 'rec_txt_dkim',
        type: 'TXT',
        host: `${sel}._domainkey`,
        priority: null,
        value: dkimTxt,
        ttl: 3600,
        purpose: `Cryptographic DKIM Signature (Selector: ${sel})`
      },
      {
        id: 'rec_txt_dmarc',
        type: 'TXT',
        host: '_dmarc',
        priority: null,
        value: dmarc,
        ttl: 3600,
        purpose: 'DMARC Sovereign Alignment Policy'
      },
      {
        id: 'rec_txt_mtasts',
        type: 'TXT',
        host: '_mta-sts',
        priority: null,
        value: mtaSts,
        ttl: 86400,
        purpose: 'Strict Transport Security (MTA-STS)'
      },
      {
        id: 'rec_cname_mail',
        type: 'CNAME',
        host: 'mail',
        priority: null,
        value: 'iron-id.io',
        ttl: 3600,
        purpose: 'Webmail Ingress & MTA Endpoint'
      },
      {
        id: 'rec_cname_autoconfig',
        type: 'CNAME',
        host: 'autoconfig',
        priority: null,
        value: 'mail.iron-id.io',
        ttl: 3600,
        purpose: 'Thunderbird / K-9 Client Auto-Discovery'
      },
      {
        id: 'rec_cname_autodiscover',
        type: 'CNAME',
        host: 'autodiscover',
        priority: null,
        value: 'mail.iron-id.io',
        ttl: 3600,
        purpose: 'Exchange ActiveSync / Outlook Auto-Discovery'
      }
    ];
  }

  ensureTenantRecords(tenant) {
    if (!tenant.records || !Array.isArray(tenant.records) || tenant.records.length === 0) {
      tenant.records = this.buildDefaultRecords(tenant);
      this.saveStore();
    }
    return tenant.records;
  }

  syncDnsPlanFromRecords(tenant) {
    if (!tenant.records) return;
    const mxRecords = tenant.records
      .filter(r => r.type === 'MX')
      .sort((a, b) => (Number(a.priority) || 10) - (Number(b.priority) || 10));
    if (mxRecords.length > 0) {
      if (!tenant.dnsPlan) tenant.dnsPlan = {};
      tenant.dnsPlan.mx = {
        host: mxRecords[0].value,
        priority: Number(mxRecords[0].priority) || 10
      };
    }
    const spfRec = tenant.records.find(r => r.type === 'TXT' && (r.host === '@' || r.host === '') && String(r.value).startsWith('v=spf1'));
    if (spfRec) {
      if (!tenant.dnsPlan) tenant.dnsPlan = {};
      tenant.dnsPlan.spf = spfRec.value;
    }
    const dkimRec = tenant.records.find(r => r.type === 'TXT' && String(r.host).includes('._domainkey'));
    if (dkimRec) {
      const match = String(dkimRec.host).match(/^([^.]+)\._domainkey/);
      if (match && match[1]) {
        if (!tenant.dkim) tenant.dkim = {};
        tenant.dkim.selector = match[1];
      }
      if (tenant.dkim) tenant.dkim.dnsTxt = dkimRec.value;
    }
    const dmarcRec = tenant.records.find(r => r.type === 'TXT' && String(r.host) === '_dmarc');
    if (dmarcRec) {
      if (!tenant.dnsPlan) tenant.dnsPlan = {};
      tenant.dnsPlan.dmarc = dmarcRec.value;
    }
    const stsRec = tenant.records.find(r => r.type === 'TXT' && String(r.host) === '_mta-sts');
    if (stsRec) {
      if (!tenant.dnsPlan) tenant.dnsPlan = {};
      tenant.dnsPlan.mtaSts = stsRec.value;
    }
  }

  syncRecordsFromDnsPlan(tenant) {
    if (!tenant.records) {
      tenant.records = this.buildDefaultRecords(tenant);
      return;
    }
    if (tenant.dnsPlan?.mx) {
      const mx = tenant.records.find(r => r.type === 'MX');
      if (mx) {
        mx.value = tenant.dnsPlan.mx.host;
        mx.priority = Number(tenant.dnsPlan.mx.priority) || 10;
      }
    }
    if (tenant.dnsPlan?.spf) {
      const spf = tenant.records.find(r => r.type === 'TXT' && (r.host === '@' || r.host === '') && String(r.value).startsWith('v=spf1'));
      if (spf) spf.value = tenant.dnsPlan.spf;
    }
    if (tenant.dkim) {
      const dkim = tenant.records.find(r => r.type === 'TXT' && String(r.host).includes('._domainkey'));
      if (dkim) {
        dkim.host = `${tenant.dkim.selector || 'ironid'}._domainkey`;
        dkim.value = tenant.dkim.dnsTxt;
      }
    }
    if (tenant.dnsPlan?.dmarc) {
      const dmarc = tenant.records.find(r => r.type === 'TXT' && String(r.host) === '_dmarc');
      if (dmarc) dmarc.value = tenant.dnsPlan.dmarc;
    }
    if (tenant.dnsPlan?.mtaSts) {
      const sts = tenant.records.find(r => r.type === 'TXT' && String(r.host) === '_mta-sts');
      if (sts) sts.value = tenant.dnsPlan.mtaSts;
    }
  }

  getTenantRecords(domain) {
    const cleanDomain = (domain || '').trim().toLowerCase();
    const tenant = this.store.tenants[cleanDomain];
    if (!tenant) throw new Error(`Tenant domain "${cleanDomain}" not found.`);
    return this.ensureTenantRecords(tenant);
  }

  addTenantRecord(domain, recordData, requesterEmail = 'admin@iron-id.io') {
    if (!this.isMasterAdmin(requesterEmail)) {
      throw new Error(`Access Denied: Only the master administrator (admin@iron-id.io) has authority to modify sovereign DNS records.`);
    }
    const cleanDomain = (domain || '').trim().toLowerCase();
    const tenant = this.store.tenants[cleanDomain];
    if (!tenant) throw new Error(`Tenant domain "${cleanDomain}" not found.`);
    this.ensureTenantRecords(tenant);

    const type = (recordData.type || 'TXT').toUpperCase().trim();
    const host = (recordData.host || '@').trim();
    const value = (recordData.value || '').trim();
    if (!value) throw new Error('Record target/value cannot be empty.');

    let priority = null;
    if (type === 'MX' || type === 'SRV') {
      priority = parseInt(recordData.priority, 10);
      if (isNaN(priority)) priority = 10;
    }

    const ttl = parseInt(recordData.ttl, 10) || 3600;
    const newRecord = {
      id: 'rec_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      type,
      host,
      priority,
      value,
      ttl,
      purpose: recordData.purpose || (type === 'MX' ? `Mail Exchanger (Priority ${priority})` : `${type} Record`)
    };

    tenant.records.push(newRecord);
    this.syncDnsPlanFromRecords(tenant);
    tenant.updatedAt = new Date().toISOString();
    this.logAudit('RECORD_ADDED', cleanDomain, `Added ${type} record (${host} -> ${value}, priority: ${priority ?? 'N/A'}) by ${requesterEmail}.`);
    this.saveStore();
    return newRecord;
  }

  updateTenantRecord(domain, recordId, updates, requesterEmail = 'admin@iron-id.io') {
    if (!this.isMasterAdmin(requesterEmail)) {
      throw new Error(`Access Denied: Only the master administrator (admin@iron-id.io) has authority to modify sovereign DNS records.`);
    }
    const cleanDomain = (domain || '').trim().toLowerCase();
    const tenant = this.store.tenants[cleanDomain];
    if (!tenant) throw new Error(`Tenant domain "${cleanDomain}" not found.`);
    this.ensureTenantRecords(tenant);

    const record = tenant.records.find(r => r.id === recordId);
    if (!record) throw new Error(`Record ID "${recordId}" not found in domain "${cleanDomain}".`);

    if (updates.type) record.type = updates.type.toUpperCase().trim();
    if (updates.host !== undefined) record.host = updates.host.trim();
    if (updates.value !== undefined) record.value = updates.value.trim();
    if (updates.ttl !== undefined) record.ttl = parseInt(updates.ttl, 10) || 3600;
    if (updates.purpose !== undefined) record.purpose = updates.purpose.trim();

    if (record.type === 'MX' || record.type === 'SRV') {
      if (updates.priority !== undefined && updates.priority !== null && updates.priority !== '') {
        record.priority = parseInt(updates.priority, 10);
        if (isNaN(record.priority)) record.priority = 10;
      }
    } else {
      record.priority = null;
    }

    this.syncDnsPlanFromRecords(tenant);
    tenant.updatedAt = new Date().toISOString();
    this.logAudit('RECORD_UPDATED', cleanDomain, `Updated ${record.type} record (${record.host}) host: ${record.value}, priority: ${record.priority ?? 'N/A'} by ${requesterEmail}.`);
    this.saveStore();
    return record;
  }

  deleteTenantRecord(domain, recordId, requesterEmail = 'admin@iron-id.io') {
    if (!this.isMasterAdmin(requesterEmail)) {
      throw new Error(`Access Denied: Only the master administrator (admin@iron-id.io) has authority to modify sovereign DNS records.`);
    }
    const cleanDomain = (domain || '').trim().toLowerCase();
    const tenant = this.store.tenants[cleanDomain];
    if (!tenant) throw new Error(`Tenant domain "${cleanDomain}" not found.`);
    this.ensureTenantRecords(tenant);

    const idx = tenant.records.findIndex(r => r.id === recordId);
    if (idx === -1) throw new Error(`Record ID "${recordId}" not found in domain "${cleanDomain}".`);

    const deleted = tenant.records.splice(idx, 1)[0];
    this.syncDnsPlanFromRecords(tenant);
    tenant.updatedAt = new Date().toISOString();
    this.logAudit('RECORD_DELETED', cleanDomain, `Deleted ${deleted.type} record (${deleted.host}) by ${requesterEmail}.`);
    this.saveStore();
    return { success: true, deletedRecord: deleted };
  }

  applyMailPreset(domain, presetName = 'single-mx', requesterEmail = 'admin@iron-id.io') {
    if (!this.isMasterAdmin(requesterEmail)) {
      throw new Error(`Access Denied: Only the master administrator (admin@iron-id.io) has authority to modify sovereign DNS records.`);
    }
    const cleanDomain = (domain || '').trim().toLowerCase();
    const tenant = this.store.tenants[cleanDomain];
    if (!tenant) throw new Error(`Tenant domain "${cleanDomain}" not found.`);

    if (presetName === 'dual-mx') {
      const nonMx = (tenant.records || this.buildDefaultRecords(tenant)).filter(r => r.type !== 'MX');
      tenant.records = [
        {
          id: 'rec_mx_10',
          type: 'MX',
          host: '@',
          priority: 10,
          value: 'mail.iron-id.io',
          ttl: 3600,
          purpose: 'Primary Sovereign Mail Exchanger'
        },
        {
          id: 'rec_mx_20',
          type: 'MX',
          host: '@',
          priority: 20,
          value: 'backup-mx.iron-id.io',
          ttl: 3600,
          purpose: 'High-Availability Redundant Fallback MX'
        },
        ...nonMx
      ];
    } else if (presetName === 'single-mx') {
      const nonMx = (tenant.records || this.buildDefaultRecords(tenant)).filter(r => r.type !== 'MX');
      tenant.records = [
        {
          id: 'rec_mx_10',
          type: 'MX',
          host: '@',
          priority: 10,
          value: 'mail.iron-id.io',
          ttl: 3600,
          purpose: 'Primary Sovereign Mail Exchanger'
        },
        ...nonMx
      ];
    } else if (presetName === 'reset-all') {
      tenant.records = this.buildDefaultRecords(tenant);
    }

    this.syncDnsPlanFromRecords(tenant);
    tenant.updatedAt = new Date().toISOString();
    this.logAudit('PRESET_APPLIED', cleanDomain, `Applied mail preset "${presetName}" by ${requesterEmail}.`);
    this.saveStore();
    return tenant.records;
  }

  // --- Tenant Domain Methods ---

  listTenants() {
    return Object.values(this.store.tenants).map(tenant => {
      this.ensureTenantRecords(tenant);
      const tenantMailboxes = Object.values(this.store.mailboxes).filter(m => m.domain === tenant.domain);
      const totalUsedStorage = tenantMailboxes.reduce((acc, m) => acc + (m.usedStorageMb || 0), 0);
      const totalAllocatedQuota = tenantMailboxes.reduce((acc, m) => acc + (m.storageQuotaMb || 0), 0);
      return {
        ...tenant,
        records: tenant.records,
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

    this.ensureTenantRecords(tenant);
    const mailboxes = Object.values(this.store.mailboxes).filter(m => m.domain === cleanDomain);
    return {
      ...tenant,
      records: tenant.records,
      mailboxes: mailboxes.map(m => {
        const { passwordHash, ...safe } = m;
        return safe;
      })
    };
  }

  createTenant({ domain, displayName, defaultQuotaMb = 5120, defaultDailyLimit = 250, vpsIp = '127.0.0.1', requesterEmail = 'admin@iron-id.io' }) {
    if (!this.isMasterAdmin(requesterEmail)) {
      throw new Error(`Access Denied: Only the master administrator (admin@iron-id.io) has authority to provision sovereign domains.`);
    }
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
        selector: 'ironid',
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

    newTenant.records = this.buildDefaultRecords(newTenant);
    this.store.tenants[cleanDomain] = newTenant;
    this.logAudit('TENANT_CREATED', cleanDomain, `Provisioned new tenant domain by ${requesterEmail} with Ed25519 DKIM keys.`);
    this.saveStore();

    return newTenant;
  }

  updateTenantDns(domain, updates = {}, requesterEmail = 'admin@iron-id.io') {
    if (!this.isMasterAdmin(requesterEmail)) {
      throw new Error(`Access Denied: Only the master administrator (admin@iron-id.io) has authority to modify sovereign DNS records.`);
    }
    const cleanDomain = (domain || '').trim().toLowerCase();
    const tenant = this.store.tenants[cleanDomain];
    if (!tenant) {
      throw new Error(`Tenant domain "${cleanDomain}" not found.`);
    }

    if (!tenant.dnsPlan) tenant.dnsPlan = {};
    if (!tenant.dkim) tenant.dkim = {};

    if (updates.selector) {
      tenant.dkim.selector = updates.selector.trim();
    }
    if (updates.mxHost) {
      tenant.dnsPlan.mx = {
        host: updates.mxHost.trim(),
        priority: parseInt(updates.mxPriority, 10) || 10
      };
    }
    if (updates.spf !== undefined) {
      tenant.dnsPlan.spf = updates.spf.trim();
    }
    if (updates.dmarc !== undefined) {
      tenant.dnsPlan.dmarc = updates.dmarc.trim();
    }
    if (updates.mtaSts !== undefined) {
      tenant.dnsPlan.mtaSts = updates.mtaSts.trim();
    }
    if (updates.displayName) {
      tenant.displayName = updates.displayName.trim();
    }

    this.syncRecordsFromDnsPlan(tenant);
    tenant.updatedAt = new Date().toISOString();
    this.logAudit('DNS_UPDATED', cleanDomain, `Customized DNS plan by ${requesterEmail} (Selector: ${tenant.dkim.selector}, MX: ${tenant.dnsPlan.mx?.host}, Priority: ${tenant.dnsPlan.mx?.priority}).`);
    this.saveStore();

    return tenant;
  }

  regenerateDkim(domain, keyType = 'ed25519', requesterEmail = 'admin@iron-id.io') {
    if (!this.isMasterAdmin(requesterEmail)) {
      throw new Error(`Access Denied: Only the master administrator (admin@iron-id.io) has authority to regenerate cryptographic keys.`);
    }
    const cleanDomain = (domain || '').trim().toLowerCase();
    const tenant = this.store.tenants[cleanDomain];
    if (!tenant) {
      throw new Error(`Tenant domain "${cleanDomain}" not found.`);
    }

    let pubPem, rawPubBase64;
    if (keyType === 'rsa' || keyType === 'rsa2048') {
      const { publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
      });
      pubPem = publicKey;
      rawPubBase64 = pubPem.replace(/-----BEGIN PUBLIC KEY-----|\n|-----END PUBLIC KEY-----/g, '').trim();
      tenant.dkim = {
        selector: tenant.dkim?.selector || 'ironid',
        keyType: 'rsa2048',
        publicKeyPem: pubPem,
        dnsTxt: `v=DKIM1; k=rsa; p=${rawPubBase64}`
      };
    } else {
      const { publicKey } = crypto.generateKeyPairSync('ed25519');
      pubPem = publicKey.export({ type: 'spki', format: 'pem' });
      rawPubBase64 = pubPem.replace(/-----BEGIN PUBLIC KEY-----|\n|-----END PUBLIC KEY-----/g, '').trim();
      tenant.dkim = {
        selector: tenant.dkim?.selector || 'ironid',
        keyType: 'ed25519',
        publicKeyPem: pubPem,
        dnsTxt: `v=DKIM1; k=ed25519; p=${rawPubBase64}`
      };
    }

    this.syncRecordsFromDnsPlan(tenant);
    this.logAudit('DKIM_REGENERATED', cleanDomain, `Re-keyed cryptographic DKIM (${tenant.dkim.keyType}) under selector "${tenant.dkim.selector}".`);
    this.saveStore();

    return tenant;
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
