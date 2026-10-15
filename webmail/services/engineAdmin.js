/**
 * IRON ID — the gateway's own admin access to the Stalwart engine.
 *
 * The gateway calls the engine's management API (x:Domain, x:Account, ...)
 * with an API key belonging to a dedicated service account, gateway@<domain>,
 * whose custom role grants only what the admin console needs. The key is
 * stored encrypted in cp.settings.
 *
 * One-time setup: set STALWART_RECOVERY_ADMIN=<user>:<password> on the service,
 * deploy once (this module creates the role, the account and the key), then
 * remove the variable and deploy again. See ensureApiKey().
 */
const http = require('http');
const crypto = require('crypto');
const db = require('./db');
const box = require('./secretBox');

const ENGINE_HOST = process.env.IRONID_ENGINE_HOST || process.env.MAIL_ENGINE_HOST || '127.0.0.1';
const ENGINE_PORT = parseInt(process.env.IRONID_ENGINE_PORT || process.env.MAIL_ENGINE_PORT, 10) || 8080;
const USING = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'];

const ROLE_DESCRIPTION = 'IRON ID Gateway (control plane)';
const SERVICE_ACCOUNT = 'gateway';
const SETTING_KEY = 'engine_api_key';

// Exactly what the admin console needs. No mail access, no server settings.
const ROLE_PERMISSIONS = (() => {
  const p = { authenticate: true };
  const grant = (obj, ops) => ops.forEach(op => { p[`sys${obj}${op}`] = true; });
  grant('Domain', ['Get', 'Query', 'Create', 'Update', 'Destroy']);
  grant('Account', ['Get', 'Query', 'Create', 'Update', 'Destroy']);
  grant('DkimSignature', ['Get', 'Query', 'Create', 'Update', 'Destroy']);
  grant('MailingList', ['Get', 'Query', 'Create', 'Update', 'Destroy']);
  grant('Role', ['Get', 'Query']);
  grant('ApiKey', ['Get', 'Query', 'Create', 'Destroy']); // its own key only
  // Mail search: read which search backend the engine uses, and start / follow re-index jobs.
  grant('SearchStore', ['Get']);
  grant('Task', ['Get', 'Query', 'Create']);
  p.taskStoreMaintenance = true;
  // Admin console: how long Trash and Junk keep messages.
  grant('DataRetention', ['Get', 'Update']);
  return p;
})();

let apiKey = null;   // decrypted key, in memory
let status = 'unknown';

function engineRequest(path, { method = 'POST', auth, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: ENGINE_HOST, port: ENGINE_PORT, path, method,
      headers: {
        authorization: auth,
        host: `${ENGINE_HOST}:${ENGINE_PORT}`,
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
      },
      timeout: 20000
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('engine request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Runs JMAP method calls with the given auth header. Throws on transport/HTTP errors. */
async function jmap(auth, methodCalls) {
  const r = await engineRequest('/jmap/', { auth, body: { using: USING, methodCalls } });
  if (r.status === 401) throw Object.assign(new Error('Engine rejected the credentials'), { code: 'unauthorized' });
  if (r.status !== 200 || !r.json) throw new Error(`Engine returned HTTP ${r.status}`);
  return r.json.methodResponses;
}

/** Calls the engine with the gateway's API key. */
async function call(methodCalls) {
  if (!apiKey) throw Object.assign(new Error('Engine admin access is not set up yet'), { code: 'not_configured' });
  return jmap('Bearer ' + apiKey, methodCalls);
}

function basic(userPass) {
  return 'Basic ' + Buffer.from(userPass, 'utf8').toString('base64');
}

function firstResult(responses, callId) {
  const r = responses.find(x => x[2] === callId);
  if (!r) throw new Error(`No response for ${callId}`);
  if (r[0] === 'error') throw new Error(`${callId}: ${r[1].type}: ${r[1].description || ''}`);
  for (const k of ['notCreated', 'notUpdated', 'notDestroyed']) {
    if (r[1][k] && Object.keys(r[1][k]).length) throw new Error(`${callId}: ${k} ${JSON.stringify(r[1][k])}`);
  }
  return r[1];
}

/** 'ok' | 'revoked' (engine said 401) | 'unreachable' (engine down, timeout, 5xx, ...) */
async function checkKey(key) {
  try {
    const res = await jmap('Bearer ' + key, [['x:Domain/query', {}, 'p']]);
    return res[0][0] === 'x:Domain/query' ? 'ok' : 'revoked';
  } catch (e) {
    return e.code === 'unauthorized' ? 'revoked' : 'unreachable';
  }
}

const SETTING_CONTEXT = 'setting:' + 'engine_api_key';

// The engine only lets an account create mailboxes and teams with permissions it holds
// itself, so the gateway role also carries those of the built-in User and Group roles.
// (They apply to the gateway's own, empty account; it cannot read anyone's mail.)
const GRANTABLE_ROLES = ['User', 'Group'];

/**
 * Creates the gateway role, or adds permissions a newer gateway version needs.
 * Needs the recovery admin: the gateway cannot change its own role.
 */
async function syncRole(rec, checkWith = null) {
  const roles = firstResult(await jmap(rec || checkWith, [['x:Role/get', { ids: null, properties: ['description', 'enabledPermissions'] }, 'r']]), 'r').list;
  const wanted = { ...ROLE_PERMISSIONS };
  for (const r of roles.filter(x => GRANTABLE_ROLES.includes(x.description))) {
    for (const [k, v] of Object.entries(r.enabledPermissions || {})) if (v) wanted[k] = true;
  }
  const role = roles.find(r => r.description === ROLE_DESCRIPTION);
  if (!rec) return role ? Object.keys(wanted).filter(p => !(role.enabledPermissions || {})[p]) : null; // check only
  if (!role) {
    const created = firstResult(await jmap(rec, [['x:Role/set', { create: { r1: { description: ROLE_DESCRIPTION, enabledPermissions: wanted } } }, 'c']]), 'c');
    if (!created.created || !created.created.r1) throw new Error('Could not create the gateway role: ' + JSON.stringify(created.notCreated));
    return { id: created.created.r1.id };
  }
  const missing = Object.keys(wanted).filter(p => !(role.enabledPermissions || {})[p]);
  if (missing.length) {
    const patch = {};
    missing.forEach(p => { patch[`enabledPermissions/${p}`] = true; });
    firstResult(await jmap(rec, [['x:Role/set', { update: { [role.id]: patch } }, 'u']]), 'u');
    console.log(`[engine-admin] Gateway role updated with: ${missing.join(', ')}`);
  }
  return role;
}

/** Creates (or repairs) the role, service account and API key using the recovery admin. */
async function provision(recoveryAdmin) {
  const rec = basic(recoveryAdmin);
  const domainName = (process.env.GATEWAY_ACCOUNT_DOMAIN || 'iron-id.io').toLowerCase();

  // 1. Role
  const role = await syncRole(rec);

  // 2. Domain for the service account
  const doms = firstResult(await jmap(rec, [['x:Domain/get', { ids: null, properties: ['name'] }, 'd']]), 'd').list;
  const dom = doms.find(d => d.name === domainName);
  if (!dom) throw new Error(`Domain ${domainName} not found in the engine (set GATEWAY_ACCOUNT_DOMAIN)`);

  // 3. Service account with a fresh random password (never stored; it only bootstraps the key)
  const password = crypto.randomBytes(36).toString('base64url');
  const accounts = firstResult(await jmap(rec, [['x:Account/get', { ids: null, properties: ['name', 'domainId'] }, 'a']]), 'a').list;
  const existing = accounts.find(a => a.name === SERVICE_ACCOUNT && a.domainId === dom.id);
  const credentials = { 0: { '@type': 'Password', secret: password } }; // replaces old credentials, revoking old keys
  if (existing) {
    firstResult(await jmap(rec, [['x:Account/set', { update: { [existing.id]: { credentials, roles: { '@type': 'Custom', roleIds: { [role.id]: true } } } } }, 'u']]), 'u');
  } else {
    const res = firstResult(await jmap(rec, [['x:Account/set', { create: { g: {
      '@type': 'User', name: SERVICE_ACCOUNT, domainId: dom.id,
      description: 'Service account for the IRON ID gateway. Do not use for mail.',
      roles: { '@type': 'Custom', roleIds: { [role.id]: true } },
      permissions: { '@type': 'Inherit' },
      encryptionAtRest: { '@type': 'Disabled' },
      credentials
    } } }, 'g']]), 'g');
    if (!res.created || !res.created.g) throw new Error('Could not create the gateway account: ' + JSON.stringify(res.notCreated));
  }

  // 4. API key, created by the service account itself
  const svc = basic(`${SERVICE_ACCOUNT}@${domainName}:${password}`);
  const k = firstResult(await jmap(svc, [['x:ApiKey/set', { create: { k: { description: 'IRON ID gateway key', permissions: { '@type': 'Inherit' } } } }, 'k']]), 'k');
  const secret = k.created && k.created.k && k.created.k.secret;
  if (!secret) throw new Error('Engine did not return an API key secret');
  if ((await checkKey(secret)) !== 'ok') throw new Error('New API key does not work');
  return secret;
}

/**
 * Makes sure the gateway has a working engine API key.
 * Returns 'ok', 'provisioned', 'missing' (nothing to do until set up) or
 * 'error' (temporary problem such as the engine still starting; retry). Never throws.
 */
async function ensureApiKey() {
  const recovery = process.env.STALWART_RECOVERY_ADMIN;
  if (recovery) {
    console.warn('[engine-admin] WARNING: STALWART_RECOVERY_ADMIN is set. It is a full-admin login on the engine; remove it from the service as soon as setup is done.');
  }
  try {
    if (!box.isAvailable()) {
      status = 'missing';
      console.warn('[engine-admin] ADMIN_TOKEN is not set; admin features are disabled.');
      return status;
    }
    const stored = await db.getSetting(SETTING_KEY);
    if (stored) {
      let k = null;
      try { k = box.decrypt(stored, SETTING_CONTEXT); } catch (e) {
        console.warn('[engine-admin] Stored engine API key cannot be decrypted (ADMIN_TOKEN changed?).');
      }
      if (k) {
        const state = await checkKey(k);
        if (state === 'ok') {
          apiKey = k; status = 'ok';
          // With the recovery admin present, also bring the role up to date (a newer
          // gateway version may need permissions the stored key's role lacks).
          if (recovery) {
            try { await syncRole(basic(recovery)); } catch (e) {
              console.error('[engine-admin] Could not update the gateway role:', e.message);
            }
          } else {
            // Without it, report when this version needs permissions the role lacks.
            try {
              const missing = await syncRole(null, 'Bearer ' + k);
              if (missing && missing.length) {
                status = 'needs_update';
                console.warn(`[engine-admin] The gateway role lacks ${missing.length} permission(s) this version uses (admin console). Deploy once with STALWART_RECOVERY_ADMIN set, then remove it.`);
              }
            } catch (e) { /* cannot tell; carry on */ }
          }
          return status;
        }
        if (state === 'unreachable') { status = 'error'; return status; } // engine not ready: retry, never re-provision
        console.warn('[engine-admin] Stored engine API key was rejected by the engine (revoked).');
      }
    }
    if (!recovery) {
      status = 'missing';
      console.warn('[engine-admin] No engine API key. To set it up: add STALWART_RECOVERY_ADMIN=<user>:<password> to the service, deploy once, then remove it and deploy again.');
      return status;
    }
    const secret = await provision(recovery);
    await db.setSetting(SETTING_KEY, box.encrypt(secret, SETTING_CONTEXT));
    apiKey = secret;
    status = 'provisioned';
    console.log('[engine-admin] Engine API key provisioned and stored. Remove STALWART_RECOVERY_ADMIN from the service now and deploy again.');
    db.audit({ actor: 'system', action: 'engine_api_key.provisioned', target: `${SERVICE_ACCOUNT}@${process.env.GATEWAY_ACCOUNT_DOMAIN || 'iron-id.io'}` })
      .catch(e => console.error('[engine-admin] audit write failed:', e.message));
    return status;
  } catch (e) {
    status = 'error';
    console.error('[engine-admin] Setup failed:', e.message);
    return status;
  }
}

function recoveryAdminSet() { return !!process.env.STALWART_RECOVERY_ADMIN; }

/** Runs JMAP calls as the recovery admin (only while STALWART_RECOVERY_ADMIN is set). */
async function asRecovery(methodCalls) {
  const recovery = process.env.STALWART_RECOVERY_ADMIN;
  if (!recovery) throw Object.assign(new Error('STALWART_RECOVERY_ADMIN is not set'), { code: 'not_configured' });
  return jmap(basic(recovery), methodCalls);
}

function getStatus() { return status; }

module.exports = { ensureApiKey, call, asRecovery, firstResult, getStatus, recoveryAdminSet, ROLE_PERMISSIONS };
