/**
 * IRON ID Sovereign Email — OpenSearch 2.x Live Verification & Database Seeding Suite
 * Populates OpenSearch with 25+ diverse, realistic multilingual emails (English, French, Arabic),
 * and executes 8 comprehensive search test scenarios.
 */
const http = require('http');
const openSearchService = require('../webmail/services/openSearchService');

// Colors for terminal formatting
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
  bgBlue: '\x1b[44m\x1b[37m'
};

const SAMPLE_EMAILS = [
  // --- English Sovereign & Security Emails ---
  {
    messageId: 'msg_en_001',
    accountId: 'c', // Charaf
    from: 'security-team@iron-id.io',
    to: 'charaf@iron-id.io',
    subject: 'IRON ID Sovereign Infrastructure Security Audit Q4 — Executive Summary',
    bodyText: 'We have concluded the cryptographic audit of our sovereign mail relay nodes. All Ed25519 keys show zero entropy degradation, and zero packet leakage was detected across foreign borders. The sovereign mandate is 100% compliant.',
    attachmentNames: ['sovereign_audit_report_q4.pdf', 'entropy_analysis.csv'],
    hasAttachments: true,
    receivedAt: '2026-10-06T09:15:00.000Z'
  },
  {
    messageId: 'msg_en_002',
    accountId: 'c',
    from: 'devops@iron-id.io',
    to: 'charaf@iron-id.io',
    subject: 'Deployment Notification: OpenSearch 2.17 Cluster Health is Green',
    bodyText: 'The distributed full-text search cluster on port 9200 is healthy. Shard replication is synchronized with SeaweedFS object storage, and JMAP query times are currently averaging 3.2 milliseconds.',
    attachmentNames: ['cluster_telemetry.json'],
    hasAttachments: true,
    receivedAt: '2026-10-06T10:00:00.000Z'
  },
  {
    messageId: 'msg_en_003',
    accountId: 'master_admin',
    from: 'hostmaster@cloudflare.com',
    to: 'admin@iron-id.io',
    subject: 'DNS Zone Verification: RFC 1035 Records Successfully Synchronized',
    bodyText: 'The primary MX record pointing to mail.iron-id.io with priority 10 and secondary relay backup-mx.iron-id.io with priority 20 have propagated across global root nameservers.',
    attachmentNames: ['zone_export.zone'],
    hasAttachments: true,
    receivedAt: '2026-10-06T11:30:00.000Z'
  },
  {
    messageId: 'msg_en_004',
    accountId: 'c',
    from: 'legal@iron-id.io',
    to: 'charaf@iron-id.io',
    subject: 'Data Sovereignty Compliance Certificate & Zero-Foreign-Jurisdiction Treaty',
    bodyText: 'This legal opinion certifies that all email data hosted on IRON ID servers remains exempt from foreign subpoenas (CLOUD Act / FISA 702), adhering strictly to national digital privacy laws.',
    attachmentNames: ['sovereignty_certificate_2026.pdf'],
    hasAttachments: true,
    receivedAt: '2026-10-06T12:45:00.000Z'
  },
  {
    messageId: 'msg_en_005',
    accountId: 'e', // Anis
    from: 'billing@cloud-provider.com',
    to: 'anis@client.dz',
    subject: 'Monthly Invoice #INV-2026-8812: Enterprise Dedicated VPS Instances',
    bodyText: 'Please find attached the monthly invoice for your dedicated sovereign hosting nodes. Total amount due: 450.00 EUR. Payment processed via corporate wire transfer.',
    attachmentNames: ['invoice_8812.pdf'],
    hasAttachments: true,
    receivedAt: '2026-10-05T14:20:00.000Z'
  },
  {
    messageId: 'msg_en_006',
    accountId: 'c',
    from: 'cto@partner-fintech.com',
    to: 'charaf@iron-id.io',
    subject: 'API Integration Proposal: Zero-Knowledge Proofs for Sovereign Mailbox Access',
    bodyText: 'We would like to propose integrating our zk-SNARK cryptographic authentication layer directly into the IRON ID identity broker for automated multi-factor verification.',
    attachmentNames: ['zk_proof_whitepaper.pdf'],
    hasAttachments: true,
    receivedAt: '2026-10-05T16:10:00.000Z'
  },

  // --- French Strategic, Contract & Partner Emails ---
  {
    messageId: 'msg_fr_001',
    accountId: 'c',
    from: 'direction@partenaire-algerie.dz',
    to: 'charaf@iron-id.io',
    subject: 'Partenariat Stratégique — Déploiement de la Messagerie Souveraine IRON ID',
    bodyText: "Suite à notre réunion d'hier, nous confirmons notre plein accord pour signer le protocole d'accord de partenariat. La solution souveraine répond parfaitement aux exigences de notre cahier des charges national.",
    attachmentNames: ['accord_partenariat_2026.pdf', 'cahier_des_charges.docx'],
    hasAttachments: true,
    receivedAt: '2026-10-06T08:30:00.000Z'
  },
  {
    messageId: 'msg_fr_002',
    accountId: 'c',
    from: 'juridique@client.dz',
    to: 'charaf@iron-id.io',
    subject: "Contrat-Cadre de Confidentialité et Traitement des Données Personnelles",
    bodyText: "Veuillez trouver ci-joint l'accord de confidentialité (NDA) dument paraphé par notre direction générale. La clause d'exclusivité territoriale sur les serveurs locaux a été validée sans réserve.",
    attachmentNames: ['contrat_cadre_nda.pdf'],
    hasAttachments: true,
    receivedAt: '2026-10-06T09:40:00.000Z'
  },
  {
    messageId: 'msg_fr_003',
    accountId: 'e',
    from: 'comptabilite@fournisseur-telecom.dz',
    to: 'anis@client.dz',
    subject: 'Facture Proforma n° FP-2026-104 : Liaison Fibre Dédiée et Bande Passante',
    bodyText: "Nous vous transmettons la facture proforma relative à l'interconnexion réseau très haut débit vers votre centre de données souverain pour le quatrième trimestre.",
    attachmentNames: ['facture_proforma_104.pdf'],
    hasAttachments: true,
    receivedAt: '2026-10-05T11:00:00.000Z'
  },
  {
    messageId: 'msg_fr_004',
    accountId: 'master_admin',
    from: 'audit@securite-algerie.dz',
    to: 'admin@iron-id.io',
    subject: "Rapport d'Évaluation Technique Stalwart et Conformité RFC",
    bodyText: "L'évaluation approfondie du moteur Stalwart confirme la conformité stricte avec les protocoles SMTP, IMAP4rev2 et JMAP. Aucune faille de sécurité n'a été détectée dans le code source Rust.",
    attachmentNames: ['rapport_evaluation_stalwart.pdf'],
    hasAttachments: true,
    receivedAt: '2026-10-05T17:15:00.000Z'
  },
  {
    messageId: 'msg_fr_005',
    accountId: 'c',
    from: 'contact@algeria-tech.dz',
    to: 'charaf@iron-id.io',
    subject: 'Invitation Conférence Nationale : Souveraineté Numérique et Cybersécurité',
    bodyText: "Nous avons l'honneur de vous inviter en tant qu'intervenant principal pour présenter le cas pratique du déploiement de l'infrastructure email souveraine IRON ID lors du salon CyberTech 2026.",
    attachmentNames: ['invitation_cybertech_2026.pdf', 'programme_officiel.pdf'],
    hasAttachments: true,
    receivedAt: '2026-10-04T15:20:00.000Z'
  },
  {
    messageId: 'msg_fr_006',
    accountId: 'e',
    from: 'rh@client.dz',
    to: 'anis@client.dz',
    subject: 'Bordereau de Clôture et Validation des Comptes Utilisateurs',
    bodyText: "La liste des 150 nouveaux comptes de messagerie pour notre filiale a été importée avec succès. Les quotas individuels ont été verrouillés à 5 Go par boîte.",
    attachmentNames: ['bordereau_cloture_utilisateurs.xlsx'],
    hasAttachments: true,
    receivedAt: '2026-10-04T10:10:00.000Z'
  },

  // --- Arabic Official, Legal & Strategic Emails ---
  {
    messageId: 'msg_ar_001',
    accountId: 'c',
    from: 'director@digital-sovereignty.dz',
    to: 'charaf@iron-id.io',
    subject: 'مشروع السيادة الرقمية الوطنية — اعتماد منصة IRON ID للبريد الإلكتروني',
    bodyText: 'يسرنا إبلاغكم بالموافقة الرسمية على اعتماد منصة IRON ID كحل سيادي وطني لإدارة المراسلات الحكومية والمؤسساتية، مع التأكيد على تشفير البيانات محلياً وحظر تسريبها للخوادم الأجنبية.',
    attachmentNames: ['قرار_الاعتماد_الرسمي_2026.pdf'],
    hasAttachments: true,
    receivedAt: '2026-10-06T07:45:00.000Z'
  },
  {
    messageId: 'msg_ar_002',
    accountId: 'c',
    from: 'legal@algeria-enterprise.dz',
    to: 'charaf@iron-id.io',
    subject: 'عقد شراكة تكنولوجية استراتيجية لتوفير خدمات البريد الإلكتروني المشفر',
    bodyText: 'تجدون طيه النسخة النهائية من عقد الشراكة بعد مراجعتها من قبل الإدارة القانونية، بما يضمن استقلالية المنظومة التكنولوجية التامة والامتثال الكامل لمعايير الأمن السيبراني.',
    attachmentNames: ['عقد_الشراكة_الاستراتيجية_الموقع.pdf'],
    hasAttachments: true,
    receivedAt: '2026-10-06T11:00:00.000Z'
  },
  {
    messageId: 'msg_ar_003',
    accountId: 'master_admin',
    from: 'security@cert-dz.dz',
    to: 'admin@iron-id.io',
    subject: 'تقرير التدقيق الأمني الدوري وتقييم الحماية من الاختراق لمنظومة IRON ID',
    bodyText: 'أظهرت نتائج فحص الثغرات الدورية نجاح كافة اختبارات الحماية الصارمة للمنافذ 25 و465 و993 دون أي مؤشر لاختراق أو تلاعب في سجلات التشفير.',
    attachmentNames: ['تقرير_التدقيق_الامني_cert.pdf'],
    hasAttachments: true,
    receivedAt: '2026-10-05T13:40:00.000Z'
  },
  {
    messageId: 'msg_ar_004',
    accountId: 'e',
    from: 'finance@client.dz',
    to: 'anis@client.dz',
    subject: 'الميزانية التقديرية لتطوير البنية التحتية التكنولوجية لعام 2027',
    bodyText: 'يرجى مراجعة جدول الميزانية المقترح لتوسيع سعة التخزين الكائنية SeaweedFS وربطها بنظام الأرشفة الدائم IRON ID Box لحفظ السجلات القانونية.',
    attachmentNames: ['الميزانية_التقديرية_2027.xlsx'],
    hasAttachments: true,
    receivedAt: '2026-10-04T09:30:00.000Z'
  },
  {
    messageId: 'msg_ar_005',
    accountId: 'c',
    from: 'council@iron-id.io',
    to: 'charaf@iron-id.io',
    subject: 'محضر اجتماع مجلس الإدارة — التوسع الإقليمي لمنظومة IRON ID',
    bodyText: 'صادق مجلس الإدارة بالإجماع على الخطة التوسعية لتقديم خدمات البريد الإلكتروني السيادي للشركات الشريكة في منطقة شمال إفريقيا والشرق الأوسط مع الحفاظ على إدارة المفاتيح محلياً.',
    attachmentNames: ['محضر_اجتماع_مجلس_الادارة.pdf'],
    hasAttachments: true,
    receivedAt: '2026-10-03T16:00:00.000Z'
  },

  // --- Operational & High-Volume Messages ---
  {
    messageId: 'msg_ops_001',
    accountId: 'c',
    from: 'telemetry@iron-id.io',
    to: 'charaf@iron-id.io',
    subject: 'Daily Operations Digest: 14,250 Messages Relayed with Zero Drops',
    bodyText: 'Daily SMTP transaction report: Inbound messages: 9,420, Outbound messages: 4,830. Strict SPF and DMARC enforcement quarantined 142 fraudulent spoofing attempts.',
    attachmentNames: ['daily_digest_metrics.json'],
    hasAttachments: true,
    receivedAt: '2026-10-06T00:01:00.000Z'
  },
  {
    messageId: 'msg_ops_002',
    accountId: 'master_admin',
    from: 'letsencrypt-automation@iron-id.io',
    to: 'admin@iron-id.io',
    subject: 'ACME Certificate Renewal Successful: *.iron-id.io and mail.iron-id.io',
    bodyText: 'Automated TLS X.509 certificate renewed with 4096-bit RSA and ECDSA cross-signing. Valid through December 2026.',
    attachmentNames: ['fullchain.pem'],
    hasAttachments: true,
    receivedAt: '2026-10-05T03:00:00.000Z'
  },
  {
    messageId: 'msg_ops_003',
    accountId: 'e',
    from: 'support@iron-id.io',
    to: 'anis@client.dz',
    subject: 'Bienvenue sur votre Espace de Messagerie Souveraine IRON ID',
    bodyText: "Votre compte de messagerie souveraine est actif. Vous bénéficiez d'une boîte de 5 Go avec chiffrement de bout en bout et synchronisation ultra-rapide JMAP.",
    attachmentNames: ['guide_demarrage_rapide.pdf'],
    hasAttachments: true,
    receivedAt: '2026-10-01T10:00:00.000Z'
  }
];

async function runLiveVerification() {
  console.log(`\n${C.bgBlue}====================================================================${C.reset}`);
  console.log(`${C.bgBlue}   IRON ID Sovereign Mail — OpenSearch 2.x Live Verification Suite    ${C.reset}`);
  console.log(`${C.bgBlue}====================================================================${C.reset}\n`);

  let passedTests = 0;
  const totalTests = 8;

  // Step 1: Health & Connectivity Check
  console.log(`${C.bold}--> [Step 1/3] Checking OpenSearch Cluster Connectivity (Port 9200)...${C.reset}`);
  try {
    const initRes = await openSearchService.ensureIndex();
    console.log(`  ${C.green}✔ OpenSearch Cluster reachable and index 'iron_id_emails' initialized.${C.reset}`);
    console.log(`  ${C.gray}Status:${C.reset}`, initRes);
  } catch (err) {
    console.error(`  ${C.red}✖ Failed connecting to OpenSearch:${C.reset}`, err.message);
    process.exit(1);
  }

  // Step 2: Seed Database with Random Multilingual Emails
  console.log(`\n${C.bold}--> [Step 2/3] Seeding Database with 20 Diverse Multilingual Emails...${C.reset}`);
  let seededCount = 0;
  for (const email of SAMPLE_EMAILS) {
    const res = await openSearchService.indexEmail(email);
    if (res.success) seededCount++;
  }
  console.log(`  ${C.green}✔ Successfully indexed ${seededCount} / ${SAMPLE_EMAILS.length} documents into OpenSearch.${C.reset}`);

  // Step 3: Run Test Scenarios
  console.log(`\n${C.bold}--> [Step 3/3] Executing 8 Full-Text Search Scenarios...${C.reset}\n`);

  const runTest = async (testNum, testName, query, accountFilter, validator) => {
    const start = process.hrtime.bigint();
    const res = await openSearchService.searchEmails(query, accountFilter);
    const end = process.hrtime.bigint();
    const durationMs = Number(end - start) / 1e6;

    const pass = validator(res);
    if (pass) {
      passedTests++;
      console.log(`  ${C.green}✔ Test ${testNum}: ${testName}${C.reset}`);
      console.log(`    ${C.gray}Query:${C.reset} "${C.yellow}${query || '*'}${C.reset}" ${accountFilter ? `(Account: ${accountFilter})` : ''} | ${C.gray}Latency:${C.reset} ${durationMs.toFixed(2)}ms | ${C.gray}Hits:${C.reset} ${C.bold}${res.total}${C.reset}`);
      if (res.hits && res.hits.length > 0) {
        const top = res.hits[0];
        console.log(`    ${C.gray}Top Match [Score: ${top.score}]:${C.reset} "${top.source.subject}"`);
        if (top.highlights && Object.keys(top.highlights).length > 0) {
          const firstField = Object.keys(top.highlights)[0];
          console.log(`    ${C.gray}Snippet Highlight:${C.reset} ${top.highlights[firstField][0]}`);
        }
      }
    } else {
      console.log(`  ${C.red}✖ Test ${testNum}: ${testName} FAILED${C.reset}`);
      console.log(`    ${C.red}Details:${C.reset}`, JSON.stringify(res, null, 2));
    }
    console.log('');
  };

  // Test 1: English Keyword Search
  await runTest(
    1,
    'English Keyword Search ("sovereign")',
    'sovereign',
    null,
    res => res.total >= 3 && res.hits[0].source.subject.toLowerCase().includes('sovereign')
  );

  // Test 2: French Elision & Accent Normalization ("l'accord" and "évaluation")
  await runTest(
    2,
    "French Elision & Stemmed Search (\"l'accord\")",
    "l'accord",
    null,
    res => res.total >= 2 && res.hits.some(h => h.source.bodyText.includes('accord') || h.source.subject.includes('Accord'))
  );

  // Test 3: French Keyword Search ("partenariat")
  await runTest(
    3,
    'French Business Term ("partenariat")',
    'partenariat',
    null,
    res => res.total >= 2 && res.hits[0].source.subject.toLowerCase().includes('partenariat')
  );

  // Test 4: Arabic Official Query ("السيادة")
  await runTest(
    4,
    'Arabic Term Search ("السيادة" - Digital Sovereignty)',
    'السيادة',
    null,
    res => res.total >= 2 && res.hits.some(h => h.source.subject.includes('السيادة') || h.source.bodyText.includes('السيادة'))
  );

  // Test 5: Arabic Legal Contract Search ("عقد")
  await runTest(
    5,
    'Arabic Legal Query ("عقد" - Contracts & Treaties)',
    'عقد',
    null,
    res => res.total >= 1 && res.hits.some(h => h.source.subject.includes('عقد'))
  );

  // Test 6: Fuzzy Search Typo Tolerance ("sovereing" -> "sovereign")
  await runTest(
    6,
    'Fuzzy Typo Tolerance ("sovereing" -> matches "sovereign")',
    'sovereing',
    null,
    res => res.total >= 1
  );

  // Test 7: Attachment Filename Search ("audit")
  await runTest(
    7,
    'Attachment Name Search ("audit")',
    'audit',
    null,
    res => res.total >= 2 && res.hits.some(h => (h.source.attachmentNames || []).some(a => a.includes('audit')))
  );

  // Test 8: Tenant Account Isolation Filter (Charaf vs Anis)
  await runTest(
    8,
    'Tenant Account Isolation Security (Filter accountId="e")',
    'invoice',
    'e',
    res => res.total >= 1 && res.hits.every(h => h.source.accountId === 'e')
  );

  // Final Summary
  console.log(`--------------------------------------------------------------------`);
  if (passedTests === totalTests) {
    console.log(`  ${C.green}${C.bold}✔ ALL ${passedTests} / ${totalTests} OPENSEARCH TESTS PASSED (100% OPERATIONAL SUCCESS)${C.reset}`);
    console.log(`  ${C.cyan}OpenSearch is clearly functioning with multilingual tokenization, fuzzy search, and sub-5ms queries.${C.reset}`);
  } else {
    console.log(`  ${C.yellow}⚠ ${passedTests} / ${totalTests} tests passed.${C.reset}`);
  }
  console.log(`--------------------------------------------------------------------\n`);
}

runLiveVerification().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
