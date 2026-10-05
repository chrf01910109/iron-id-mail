#!/usr/bin/env node
/**
 * IRON ID Sovereign Email — Administrative CLI (admin-cli.js)
 * Phase 2 Delivery: Programmatic command-line interface for tenant lifecycle,
 * DNS audits, account suspensions, password resets, and quota policy management.
 */
const tenantService = require('./webmail/services/tenantService');
const dnsValidator = require('./webmail/services/dnsValidator');

const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];

function printHeader() {
  console.log('\x1b[36m===============================================================\x1b[0m');
  console.log('\x1b[36m   IRON ID Sovereign Mail — Administrative Management CLI      \x1b[0m');
  console.log('\x1b[36m===============================================================\x1b[0m');
}

function printUsage() {
  printHeader();
  console.log(`
Usage: node admin-cli.js <command> <subcommand> [options]

Commands:
  \x1b[32mstats\x1b[0m                                     Display overall system & storage metrics
  
  \x1b[32mtenant list\x1b[0m                               List all provisioned tenant domains
  \x1b[32mtenant add <domain> [displayName]\x1b[0m          Provision a new tenant domain with Ed25519 DKIM
  \x1b[32mtenant show <domain>\x1b[0m                       Show tenant details, mailboxes, & DNS plan
  
  \x1b[32mmailbox list [domain]\x1b[0m                      List mailboxes (optionally filtered by domain)
  \x1b[32mmailbox add <email> <password> [name]\x1b[0m      Create a new tenant mailbox with quota & limits
  \x1b[32mmailbox reset-pw <email> <newPassword>\x1b[0m     Reset a mailbox password
  \x1b[32mmailbox suspend <email>\x1b[0m                    Suspend a mailbox (blocks sends & logins)
  \x1b[32mmailbox resume <email>\x1b[0m                     Re-activate a suspended mailbox
  \x1b[32mmailbox quota <email> <quotaMb> [limit]\x1b[0m    Adjust storage quota (MB) and daily send limit
  
  \x1b[32mdns verify <domain>\x1b[0m                        Run live automated DNS health check & scoring
`);
}

async function main() {
  if (!command || ['--help', '-h', 'help'].includes(command)) {
    printUsage();
    return;
  }

  try {
    // 1. STATS
    if (command === 'stats') {
      printHeader();
      const s = tenantService.getSystemStats();
      console.log(`Tenants:            \x1b[32m${s.activeTenants} Active\x1b[0m / ${s.totalTenants} Total`);
      console.log(`Mailboxes:          \x1b[32m${s.activeMailboxes} Active\x1b[0m / \x1b[31m${s.suspendedMailboxes} Suspended\x1b[0m (${s.totalMailboxes} Total)`);
      console.log(`Allocated Quota:    ${(s.totalAllocatedQuotaMb / 1024).toFixed(1)} GB`);
      console.log(`Used Storage:       ${s.totalUsedStorageMb} MB (${s.storageUtilizationPct}% utilized)`);
      console.log(`Audit Trail Items:  ${s.totalAuditEntries}`);
      return;
    }

    // 2. TENANT
    if (command === 'tenant') {
      if (subcommand === 'list') {
        printHeader();
        const list = tenantService.listTenants();
        console.table(list.map(t => ({
          Domain: t.domain,
          Name: t.displayName,
          Status: t.status,
          Mailboxes: t.mailboxCount,
          'Used (MB)': t.totalUsedStorageMb,
          'Allocated (MB)': t.totalAllocatedQuotaMb,
          DKIM: t.dkim.keyType.toUpperCase()
        })));
        return;
      }

      if (subcommand === 'add') {
        const domain = args[2];
        const displayName = args[3] || domain;
        if (!domain) return console.error('\x1b[31mError: Domain name is required. Example: node admin-cli.js tenant add acme.org "Acme Corp"\x1b[0m');
        
        printHeader();
        console.log(`Provisioning sovereign tenant domain: \x1b[33m${domain}\x1b[0m ...`);
        const created = tenantService.createTenant({ domain, displayName });
        console.log(`\x1b[32m✔ Tenant domain successfully provisioned!\x1b[0m`);
        console.log(`\n--- Recommended DNS Blueprint for ${domain} ---`);
        console.log(`MX:      @                   -> ${created.dnsPlan.mx.priority} ${created.dnsPlan.mx.host}`);
        console.log(`SPF:     @                   -> "${created.dnsPlan.spf}"`);
        console.log(`DKIM:    ${created.dkim.selector}._domainkey -> "${created.dkim.dnsTxt}"`);
        console.log(`DMARC:   _dmarc              -> "${created.dnsPlan.dmarc}"`);
        console.log(`MTA-STS: _mta-sts            -> "${created.dnsPlan.mtaSts}"`);
        return;
      }

      if (subcommand === 'show') {
        const domain = args[2];
        if (!domain) return console.error('\x1b[31mError: Domain name is required.\x1b[0m');
        const tenant = tenantService.getTenant(domain);
        if (!tenant) return console.error(`\x1b[31mError: Tenant "${domain}" not found.\x1b[0m`);
        
        printHeader();
        console.log(`Domain:        ${tenant.domain} (${tenant.displayName})`);
        console.log(`Status:        \x1b[32m${tenant.status.toUpperCase()}\x1b[0m`);
        console.log(`Created:       ${tenant.createdAt}`);
        console.log(`DKIM Type:     ${tenant.dkim.keyType.toUpperCase()} (Selector: ${tenant.dkim.selector})`);
        console.log(`DKIM Record:   ${tenant.dkim.dnsTxt}`);
        console.log(`\nMailboxes (${tenant.mailboxes.length}):`);
        console.table(tenant.mailboxes.map(m => ({
          Email: m.email,
          Name: m.displayName,
          Role: m.role,
          Status: m.status,
          'Quota (MB)': m.storageQuotaMb,
          'Used (MB)': m.usedStorageMb,
          'Daily Limit': m.dailySendLimit
        })));
        return;
      }
    }

    // 3. MAILBOX
    if (command === 'mailbox') {
      if (subcommand === 'list') {
        printHeader();
        const filter = args[2] || null;
        const list = tenantService.listMailboxes(filter);
        console.table(list.map(m => ({
          Email: m.email,
          Name: m.displayName,
          Role: m.role,
          Status: m.status === 'active' ? 'ACTIVE' : 'SUSPENDED',
          'Quota (MB)': m.storageQuotaMb,
          'Used (MB)': m.usedStorageMb,
          'Sent Today': `${m.todaySentCount}/${m.dailySendLimit}`
        })));
        return;
      }

      if (subcommand === 'add') {
        const email = args[2];
        const password = args[3];
        const displayName = args[4] || email.split('@')[0];
        if (!email || !password) {
          return console.error('\x1b[31mError: Email and password are required. Example: node admin-cli.js mailbox add user@domain.com SecretP@ss123\x1b[0m');
        }
        printHeader();
        const mb = tenantService.createMailbox({ email, password, displayName });
        console.log(`\x1b[32m✔ Mailbox provisioned successfully!\x1b[0m`);
        console.log(`Email:       ${mb.email}`);
        console.log(`Account ID:  ${mb.accountId}`);
        console.log(`Identity ID: ${mb.identityId}`);
        console.log(`Quota:       ${mb.storageQuotaMb} MB`);
        console.log(`Daily Limit: ${mb.dailySendLimit} messages/day`);
        return;
      }

      if (subcommand === 'reset-pw') {
        const email = args[2];
        const newPassword = args[3];
        if (!email || !newPassword) return console.error('\x1b[31mError: Email and new password required.\x1b[0m');
        printHeader();
        const res = tenantService.resetPassword(email, newPassword);
        console.log(`\x1b[32m✔ ${res.message}\x1b[0m`);
        return;
      }

      if (subcommand === 'suspend') {
        const email = args[2];
        if (!email) return console.error('\x1b[31mError: Email required.\x1b[0m');
        printHeader();
        tenantService.updateMailboxStatus(email, 'suspended');
        console.log(`\x1b[31m✔ Mailbox ${email} has been SUSPENDED.\x1b[0m`);
        return;
      }

      if (subcommand === 'resume') {
        const email = args[2];
        if (!email) return console.error('\x1b[31mError: Email required.\x1b[0m');
        printHeader();
        tenantService.updateMailboxStatus(email, 'active');
        console.log(`\x1b[32m✔ Mailbox ${email} has been RE-ACTIVATED.\x1b[0m`);
        return;
      }

      if (subcommand === 'quota') {
        const email = args[2];
        const quotaMb = args[3];
        const dailySendLimit = args[4];
        if (!email || !quotaMb) return console.error('\x1b[31mError: Email and quotaMb required.\x1b[0m');
        printHeader();
        const updated = tenantService.updateQuota(email, { quotaMb, dailySendLimit });
        console.log(`\x1b[32m✔ Mailbox quota updated:\x1b[0m ${updated.storageQuotaMb}MB, Daily Limit: ${updated.dailySendLimit}`);
        return;
      }
    }

    // 4. DNS VERIFY
    if (command === 'dns' && subcommand === 'verify') {
      const domain = args[2];
      if (!domain) return console.error('\x1b[31mError: Domain required. Example: node admin-cli.js dns verify iron-id.io\x1b[0m');
      printHeader();
      console.log(`Running live DNS verification for: \x1b[33m${domain}\x1b[0m ...\n`);
      
      const tenant = tenantService.getTenant(domain);
      const dkimTxt = tenant && tenant.dkim ? tenant.dkim.dnsTxt : null;
      const res = await dnsValidator.verifyDomain(domain, { dkimTxt });
      
      console.log(`Audit Timestamp:  ${res.timestamp}`);
      console.log(`Overall Health:   \x1b[32m${res.score} / 100 (${res.status})\x1b[0m\n`);
      
      console.log('--- Diagnostic Checks ---');
      for (const [key, check] of Object.entries(res.checks)) {
        const badge = check.status === 'pass' ? '\x1b[32m[PASS]\x1b[0m' : (check.status === 'warn' ? '\x1b[33m[WARN]\x1b[0m' : '\x1b[31m[FAIL]\x1b[0m');
        console.log(`${badge} ${check.name}: ${check.details ? check.details.message : ''}`);
      }

      if (res.remediationPlan.length > 0) {
        console.log('\n--- Remediation Steps ---');
        res.remediationPlan.forEach((step, idx) => {
          console.log(`  ${idx + 1}. [${step.record}] ${step.instruction}`);
        });
      }
      return;
    }

    printUsage();
  } catch (err) {
    console.error(`\x1b[31mError: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

main();
