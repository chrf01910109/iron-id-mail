/**
 * IRON ID Sovereign Email — Automated DNS Record Validator
 * Phase 2 Delivery: Live cryptographic DNS audit (MX, SPF, DKIM, DMARC, MTA-STS),
 * health score calculation, and remediation blueprints.
 */
const dns = require('dns').promises;

class DnsValidator {
  /**
   * Run full cryptographic and delivery DNS audit for a tenant domain
   * @param {string} domain - Domain name to verify (e.g. iron-id.io)
   * @param {Object} options - Optional expected values
   */
  async verifyDomain(domain, options = {}) {
    const cleanDomain = (domain || '').trim().toLowerCase();
    const selector = options.selector || 'ironid';
    const expectedMx = options.expectedMx || 'mail.iron-id.io';
    const vpsIp = options.vpsIp || '127.0.0.1';

    const results = {
      domain: cleanDomain,
      timestamp: new Date().toISOString(),
      score: 0, // 0 to 100
      status: 'pending',
      checks: {
        mx: { name: 'MX (Mail Exchanger)', status: 'fail', points: 25, details: null, recommended: null },
        spf: { name: 'SPF (Sender Policy Framework)', status: 'fail', points: 25, details: null, recommended: null },
        dkim: { name: 'DKIM (Cryptographic Signature)', status: 'fail', points: 25, details: null, recommended: null },
        dmarc: { name: 'DMARC (Domain-based Auth & Reporting)', status: 'fail', points: 15, details: null, recommended: null },
        mtaSts: { name: 'MTA-STS (Strict Transport Security)', status: 'fail', points: 10, details: null, recommended: null }
      },
      remediationPlan: []
    };

    // 1. Audit MX Record
    try {
      const mxRecords = await dns.resolveMx(cleanDomain);
      if (mxRecords && mxRecords.length > 0) {
        const hasExpected = mxRecords.some(r => r.exchange.toLowerCase().includes('mail') || r.exchange.toLowerCase() === expectedMx.toLowerCase());
        results.checks.mx.status = hasExpected ? 'pass' : 'warn';
        results.checks.mx.details = {
          found: mxRecords.map(r => `${r.priority} ${r.exchange}`),
          message: hasExpected ? `Valid MX found pointing to ${expectedMx}` : `MX found, but does not match expected ${expectedMx}`
        };
        results.score += hasExpected ? 25 : 15;
      } else {
        throw new Error('No MX records returned');
      }
    } catch (err) {
      results.checks.mx.status = 'fail';
      results.checks.mx.details = { error: err.code || err.message, message: 'No MX record found on domain.' };
      results.checks.mx.recommended = {
        type: 'MX',
        host: '@',
        value: expectedMx,
        priority: 10,
        purpose: 'Directs inbound server-to-server emails to your IRON ID MTA.'
      };
      results.remediationPlan.push({
        record: 'MX',
        instruction: `Add MX record pointing to ${expectedMx} with Priority 10.`
      });
    }

    // 2. Audit SPF Record
    try {
      const txtRecords = await dns.resolveTxt(cleanDomain);
      const flattened = txtRecords.map(chunk => chunk.join(''));
      const spfRecord = flattened.find(t => t.startsWith('v=spf1'));

      if (spfRecord) {
        const hasIp = spfRecord.includes('ip4:') || spfRecord.includes('mx');
        const isStrict = spfRecord.endsWith('-all') || spfRecord.endsWith('~all');
        results.checks.spf.status = (hasIp && isStrict) ? 'pass' : 'warn';
        results.checks.spf.details = {
          raw: spfRecord,
          message: results.checks.spf.status === 'pass' ? 'Valid SPF policy found.' : 'SPF found, but lacks strict -all/~all or IP qualifiers.'
        };
        results.score += results.checks.spf.status === 'pass' ? 25 : 15;
      } else {
        throw new Error('No SPF record found');
      }
    } catch (err) {
      results.checks.spf.status = 'fail';
      results.checks.spf.details = { error: err.code || err.message, message: 'No SPF TXT record detected.' };
      results.checks.spf.recommended = {
        type: 'TXT',
        host: '@',
        value: `v=spf1 mx ip4:${vpsIp} ~all`,
        purpose: 'Authorizes your IRON ID VPS IP to transmit emails for your domain.'
      };
      results.remediationPlan.push({
        record: 'SPF',
        instruction: `Publish TXT record at root "@": "v=spf1 mx ip4:${vpsIp} ~all"`
      });
    }

    // 3. Audit DKIM Record (Checks ironid._domainkey)
    const selectorsToTry = [selector || 'ironid', 'ironid'].filter((v, i, a) => Boolean(v) && a.indexOf(v) === i);
    let dkimFound = false;
    let successfulSelector = selector;

    for (const sel of selectorsToTry) {
      const curHost = `${sel}._domainkey.${cleanDomain}`;
      try {
        const dkimRecords = await dns.resolveTxt(curHost);
        const dkimFlattened = dkimRecords.map(chunk => chunk.join('')).join('');
        if (dkimFlattened.includes('v=DKIM1') && (dkimFlattened.includes('p=') || dkimFlattened.includes('k='))) {
          results.checks.dkim.status = 'pass';
          results.checks.dkim.details = {
            host: curHost,
            selector: sel,
            raw: dkimFlattened.slice(0, 50) + '...',
            message: `Valid cryptographic DKIM public key published under selector "${sel}".`
          };
          results.score += 25;
          dkimFound = true;
          successfulSelector = sel;
          break;
        }
      } catch (e) {}
    }

    if (!dkimFound) {
      const primaryHost = `${selector}._domainkey.${cleanDomain}`;
      results.checks.dkim.status = 'fail';
      results.checks.dkim.details = { host: primaryHost, message: `DKIM public key TXT record missing under "${selector}._domainkey".` };
      results.checks.dkim.recommended = {
        type: 'TXT',
        host: `${selector}._domainkey`,
        value: options.dkimTxt || `v=DKIM1; k=ed25519; p=<GENERATED_PUBLIC_KEY>`,
        purpose: 'Allows external MTAs (Gmail, Outlook) to cryptographically verify outbound signatures.'
      };
      results.remediationPlan.push({
        record: 'DKIM',
        instruction: `Publish TXT record at "${selector}._domainkey": "${options.dkimTxt || 'v=DKIM1; k=ed25519; p=...'}"`
      });
    }

    // 4. Audit DMARC Record
    const dmarcHost = `_dmarc.${cleanDomain}`;
    try {
      const dmarcRecords = await dns.resolveTxt(dmarcHost);
      const dmarcFlattened = dmarcRecords.map(chunk => chunk.join('')).join('');
      if (dmarcFlattened.startsWith('v=DMARC1')) {
        const isEnforced = dmarcFlattened.includes('p=quarantine') || dmarcFlattened.includes('p=reject');
        results.checks.dmarc.status = isEnforced ? 'pass' : 'warn';
        results.checks.dmarc.details = {
          raw: dmarcFlattened,
          policy: isEnforced ? 'Enforced (Quarantine/Reject)' : 'Monitoring Only (p=none)',
          message: isEnforced ? 'Strong DMARC protection active.' : 'DMARC active in monitoring mode (p=none).'
        };
        results.score += isEnforced ? 15 : 10;
      } else {
        throw new Error('DMARC record malformed');
      }
    } catch (err) {
      results.checks.dmarc.status = 'fail';
      results.checks.dmarc.details = { host: dmarcHost, error: err.code || err.message, message: 'No DMARC policy detected.' };
      results.checks.dmarc.recommended = {
        type: 'TXT',
        host: '_dmarc',
        value: `v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@${cleanDomain}`,
        purpose: 'Specifies how receiving servers handle unauthenticated emails claiming to be from your domain.'
      };
      results.remediationPlan.push({
        record: 'DMARC',
        instruction: `Publish TXT record at "_dmarc": "v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@${cleanDomain}"`
      });
    }

    // 5. Audit MTA-STS Record
    const mtaStsHost = `_mta-sts.${cleanDomain}`;
    try {
      const mtaStsRecords = await dns.resolveTxt(mtaStsHost);
      const stsFlattened = mtaStsRecords.map(chunk => chunk.join('')).join('');
      if (stsFlattened.startsWith('v=STSv1')) {
        results.checks.mtaSts.status = 'pass';
        results.checks.mtaSts.details = { raw: stsFlattened, message: 'Strict Transport Security policy published.' };
        results.score += 10;
      } else {
        throw new Error('MTA-STS malformed');
      }
    } catch (err) {
      results.checks.mtaSts.status = 'fail';
      results.checks.mtaSts.details = { host: mtaStsHost, error: err.code || err.message, message: 'MTA-STS record missing.' };
      results.checks.mtaSts.recommended = {
        type: 'TXT',
        host: '_mta-sts',
        value: `v=STSv1; id=20261005T01`,
        purpose: 'Prevents man-in-the-middle attacks on inbound SMTP connections by enforcing TLS encryption.'
      };
      results.remediationPlan.push({
        record: 'MTA-STS',
        instruction: `Publish TXT record at "_mta-sts": "v=STSv1; id=20261005T01"`
      });
    }

    // Overall Status
    if (results.score >= 90) results.status = 'EXCELLENT';
    else if (results.score >= 65) results.status = 'GOOD';
    else if (results.score >= 40) results.status = 'ACTION_REQUIRED';
    else results.status = 'CRITICAL_SETUP_PENDING';

    return results;
  }
}

module.exports = new DnsValidator();
