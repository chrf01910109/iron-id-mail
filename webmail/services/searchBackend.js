/**
 * IRON ID — mail search backend (OpenSearch).
 *
 * The engine keeps its full-text index either in its own database ("Default") or in
 * OpenSearch ("ElasticSearch" store type; OpenSearch speaks the same API).
 *
 * Switching to OpenSearch:
 *   1. iron-id-mail variables:
 *        OPENSEARCH_URL=https://${{opensearch.RAILWAY_PRIVATE_DOMAIN}}:9200
 *        OPENSEARCH_PASSWORD=${{opensearch.OPENSEARCH_PASSWORD}}
 *      The engine reads OPENSEARCH_PASSWORD itself; the password is never stored in
 *      the engine's database.
 *   2. One deploy with STALWART_RECOVERY_ADMIN set: configure() points the engine at
 *      OpenSearch (changing the engine's search store needs the recovery admin).
 *   3. Remove STALWART_RECOVERY_ADMIN and deploy again. The engine starts on OpenSearch
 *      and check() starts a one-time re-index of all mailboxes (the engine spreads the
 *      work over a few minutes). New mail is searchable straight away.
 *
 * check() runs every minute with the gateway's own engine key and reports a status
 * for /healthz. If OpenSearch lost its index (for example its volume was replaced),
 * check() starts a new re-index once per gateway start.
 */
const https = require('https');
const http = require('http');
const db = require('./db');
const engineAdmin = require('./engineAdmin');

const SETTING = 'search_backend';
const PASSWORD_VAR = 'OPENSEARCH_PASSWORD';
const USERNAME = process.env.OPENSEARCH_USER || 'stalwart';
const BOOTED_AT = Date.now();
const CHECK_EVERY_MS = 60000;

let status = 'unknown';
let reindexRetriedThisBoot = false;
let timer = null;

/** The search store the engine should use, from OPENSEARCH_URL; null = leave unchanged. */
function desiredStore() {
  const raw = (process.env.OPENSEARCH_URL || '').trim();
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch (e) { throw new Error('OPENSEARCH_URL is not a valid URL'); }
  if (!['https:', 'http:'].includes(u.protocol)) throw new Error('OPENSEARCH_URL must start with https:// or http://');
  return {
    '@type': 'ElasticSearch',
    url: `${u.protocol}//${u.host}`,
    // The OpenSearch service makes its own private certificate authority, which the
    // engine cannot be told about; traffic stays on Railway's encrypted private network
    // and access is protected by the password.
    allowInvalidCerts: u.protocol === 'https:',
    httpAuth: { '@type': 'Basic', username: USERNAME, secret: { '@type': 'EnvironmentVariable', variableName: PASSWORD_VAR } },
    numShards: 1,
    numReplicas: 0
  };
}

function sameStore(current, want) {
  if (!current || current['@type'] !== want['@type']) return false;
  const auth = current.httpAuth || {};
  const secret = auth.secret || {};
  return current.url === want.url &&
    !!current.allowInvalidCerts === want.allowInvalidCerts &&
    auth.username === want.httpAuth.username &&
    secret.variableName === want.httpAuth.secret.variableName &&
    current.numShards === want.numShards &&
    current.numReplicas === want.numReplicas;
}

async function readState() {
  const raw = await db.getSetting(SETTING);
  if (!raw) return {};
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return {}; }
}

async function writeState(state) {
  await db.setSetting(SETTING, JSON.stringify(state));
}

async function getStore(callFn) {
  const res = engineAdmin.firstResult(await callFn([['x:SearchStore/get', { ids: ['singleton'] }, 's']]), 's');
  return res.list && res.list[0];
}

/**
 * Points the engine at OpenSearch when OPENSEARCH_URL is set and the engine uses
 * something else. Needs the recovery admin. Takes effect after the engine restarts.
 */
async function configure() {
  const want = desiredStore();
  if (!want) return 'unchanged';
  const current = await getStore(engineAdmin.asRecovery);
  if (sameStore(current, want)) return 'unchanged';
  const update = { ...want };
  engineAdmin.firstResult(await engineAdmin.asRecovery([['x:SearchStore/set', { update: { singleton: update } }, 'u']]), 'u');
  const state = await readState();
  await writeState({ ...state, url: want.url, configuredAt: Date.now() });
  console.log(`[search] Engine search now set to OpenSearch at ${want.url}. It takes effect after the next restart: remove STALWART_RECOVERY_ADMIN and deploy again.`);
  db.audit({ actor: 'system', action: 'search_backend.configured', target: want.url })
    .catch(e => console.error('[search] audit write failed:', e.message));
  status = 'restart-needed';
  return 'configured';
}

/** Small HTTPS request to OpenSearch with the engine's credentials. Resolves { status, json }. */
function openSearch(path, url) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, url);
    const lib = u.protocol === 'https:' ? https : http;
    const pw = process.env[PASSWORD_VAR] || '';
    // OpenSearch uses its own self-signed certificate on Railway's private network; the password still protects it.
    const req = lib.request(u, { // nosemgrep: tls-verification-disabled
      method: 'GET',
      timeout: 8000,
      rejectUnauthorized: false, // same trust model as the engine (see desiredStore)
      headers: { authorization: 'Basic ' + Buffer.from(`${USERNAME}:${pw}`).toString('base64') }
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

// Engine job types that belong to (re-)indexing; other jobs (calendar alarms etc.) don't count.
const INDEX_JOB_TYPES = new Set(['StoreMaintenance', 'AccountMaintenance', 'IndexDocument']);

async function pendingIndexJobs() {
  const res = engineAdmin.firstResult(await engineAdmin.call([['x:Task/get', { ids: null, properties: ['id', '@type'] }, 't']]), 't');
  return (res.list || []).filter(t => INDEX_JOB_TYPES.has(t['@type'])).length;
}

async function startReindex(state, reason) {
  engineAdmin.firstResult(await engineAdmin.call([['x:Task/set', { create: { r: { '@type': 'StoreMaintenance', maintenanceType: 'reindexAccounts' } } }, 'r']]), 'r');
  await writeState({ ...state, reindexedUrl: state.url, reindexRequestedAt: Date.now() });
  console.log(`[search] Re-index of all mailboxes started (${reason}). New mail is searchable right away; older mail follows over the next minutes.`);
  db.audit({ actor: 'system', action: 'search_backend.reindex', target: state.url, details: { reason } })
    .catch(e => console.error('[search] audit write failed:', e.message));
}

/**
 * Updates the status and starts the one-time re-index when due. Never throws.
 * Status: 'builtin' | 'waiting-for-setup' | 'restart-needed' | 'unreachable' |
 *         'auth-failed' | 'reindexing' | 'ok' | 'error'
 */
async function check() {
  try {
    if (!['ok', 'provisioned', 'needs_update'].includes(engineAdmin.getStatus())) { status = 'unknown'; return status; }
    const current = await getStore(engineAdmin.call);
    const want = desiredStore();
    if (!current || current['@type'] !== 'ElasticSearch') {
      status = want ? 'waiting-for-setup' : 'builtin';
      return status;
    }

    let state = await readState();
    if (state.url !== current.url) { state = { url: current.url }; await writeState(state); }
    if (state.configuredAt && state.configuredAt > BOOTED_AT) { status = 'restart-needed'; return status; }

    let ping;
    try { ping = await openSearch('/st_email/_count', current.url); } catch (e) { status = 'unreachable'; return status; }
    if (ping.status === 401 || ping.status === 403) { status = 'auth-failed'; return status; }
    const indexMissing = ping.status === 404;
    if (ping.status !== 200 && !indexMissing) { status = 'unreachable'; return status; }
    const docs = indexMissing ? 0 : Number(ping.json && ping.json.count) || 0;

    if (state.reindexedUrl !== current.url) {
      await startReindex(state, 'switched to OpenSearch');
    } else if (docs === 0 && !reindexRetriedThisBoot &&
               Date.now() - (state.reindexRequestedAt || 0) > 15 * 60000) {
      // Empty index long after the last re-index: OpenSearch probably lost its data.
      reindexRetriedThisBoot = true;
      await startReindex(state, 'search index was empty');
    }

    status = (await pendingIndexJobs()) > 0 ? 'reindexing' : 'ok';
    return status;
  } catch (e) {
    if (/forbidden/i.test(e.message)) {
      // The gateway's role predates the search permissions: one recovery-admin deploy adds them.
      if (status !== 'waiting-for-setup') {
        console.warn('[search] The gateway cannot read the engine search settings yet. Deploy once with STALWART_RECOVERY_ADMIN set to finish setup.');
      }
      status = 'waiting-for-setup';
      return status;
    }
    status = 'error';
    console.error('[search] check failed:', e.message);
    return status;
  }
}

/** Called once the gateway has its engine key. Safe to call more than once. */
async function start() {
  if (engineAdmin.recoveryAdminSet()) {
    try { await configure(); } catch (e) { console.error('[search] Could not configure the engine search backend:', e.message); }
  }
  await check();
  if (!timer) { timer = setInterval(check, CHECK_EVERY_MS); timer.unref(); }
}

function getStatus() { return status; }

module.exports = { start, check, configure, getStatus, desiredStore };
