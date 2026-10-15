/**
 * IRON ID — first-boot protection for the seed accounts.
 *
 * A fresh database is filled from engine/export_data.json, whose account passwords are
 * known (they are in this repository's history). When the entrypoint imports the seed it
 * leaves a 'seed_passwords_pending' marker; once the gateway has engine access it gives
 * every seeded mailbox a new random password (nobody learns it: admins use "Reset sign-in"
 * in the admin console, or the recovery admin, to hand out access), then removes the marker.
 *
 * An existing database (production) never gets the marker, so nothing changes there.
 */
const crypto = require('crypto');
const db = require('./db');
const engineAdmin = require('./engineAdmin');

const SERVICE_ACCOUNT = 'gateway';

async function pending() {
  try {
    const r = await db.query(`SELECT 1 FROM ironid_meta WHERE key = 'seed_passwords_pending'`);
    return r.rows.length > 0;
  } catch (e) { return false; } // no ironid_meta table (local development)
}

/** Returns the number of mailboxes given new passwords, or 0. Never throws. */
async function rotateSeedPasswords() {
  try {
    if (!(await pending())) return 0;
    // The recovery admin can change every account (including engine administrators).
    const run = calls => (engineAdmin.recoveryAdminSet() ? engineAdmin.asRecovery(calls) : engineAdmin.call(calls));
    const accounts = engineAdmin.firstResult(await run([['x:Account/get', { ids: null, properties: ['@type', 'name'] }, 'a']]), 'a').list || [];
    const update = {};
    for (const a of accounts) {
      if (a['@type'] !== 'User' || a.name === SERVICE_ACCOUNT) continue;
      update[a.id] = { credentials: { 0: { '@type': 'Password', secret: crypto.randomBytes(24).toString('base64url') } } };
    }
    if (Object.keys(update).length) {
      const res = engineAdmin.firstResult(await run([['x:Account/set', { update }, 'u']]), 'u');
      const done = Object.keys(res.updated || {}).length;
      if (done !== Object.keys(update).length) throw new Error(`only ${done} of ${Object.keys(update).length} updated`);
    }
    await db.query(`DELETE FROM ironid_meta WHERE key = 'seed_passwords_pending'`);
    await db.audit({ actor: 'system', action: 'seed.passwords_replaced', target: String(Object.keys(update).length) + ' mailboxes' }).catch(() => {});
    console.log(`[seed] Gave ${Object.keys(update).length} seeded mailbox(es) new random passwords. Use "Reset sign-in" in the admin console to hand out access.`);
    return Object.keys(update).length;
  } catch (e) {
    console.error('[seed] Could not replace the seed passwords yet (will retry on the next start):', e.message);
    return 0;
  }
}

module.exports = { rotateSeedPasswords };
