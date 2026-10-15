#!/usr/bin/env node
/**
 * IRON ID — read-only HTTP security probe.
 *
 *   node tests/security/http-probe.js https://mail.example.com
 *
 * Safe to run against production: it only sends anonymous requests (no sign-in, nothing
 * created or changed, at most two deliberately bad sign-in attempts for an address that
 * doesn't exist). Exit code 1 if any check fails. Prints one line per check.
 */
const base = (process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); };

async function get(path, opts = {}) {
  const r = await fetch(base + path, { redirect: 'manual', ...opts });
  const text = await r.text().catch(() => '');
  return { status: r.status, headers: r.headers, text };
}

(async () => {
  const https = base.startsWith('https://');

  // 1. Pages and their security headers
  const home = await get('/');
  check('webmail page loads', home.status === 200, 'HTTP ' + home.status);
  for (const [h, want] of [['x-frame-options', /^DENY$/i], ['x-content-type-options', /^nosniff$/i], ['referrer-policy', /no-referrer/i]]) {
    check(`header ${h}`, want.test(home.headers.get(h) || ''), home.headers.get(h) || 'missing');
  }
  if (https) check('HSTS', /max-age=\d{7,}/.test(home.headers.get('strict-transport-security') || ''), home.headers.get('strict-transport-security') || 'missing');
  const csp = home.headers.get('content-security-policy') || '';
  check('webmail CSP: scripts only from this site', /script-src 'self'(;|$)/.test(csp) && !/unsafe-eval/.test(csp), csp.slice(0, 80));
  check('webmail CSP: no framing, no plugins, no base tag', /frame-ancestors 'none'/.test(csp) && /object-src 'none'/.test(csp) && /base-uri 'none'/.test(csp));
  const admin = await get('/admin');
  const acsp = admin.headers.get('content-security-policy') || '';
  check('admin console page has a strict CSP', admin.status === 200 && /script-src 'self'/.test(acsp) && /frame-ancestors 'none'/.test(acsp), 'HTTP ' + admin.status);

  // 2. Nothing is open without signing in
  check('admin API needs a session', (await get('/admin-api/me')).status === 401);
  check('account API needs a session', (await get('/account/security')).status === 401);
  const anon = await get('/proxy/jmap/session');
  let anonUser = null; try { anonUser = JSON.parse(anon.text).username; } catch (e) { /* not JSON */ }
  check('mail session is empty without signing in', !anonUser);
  const jm = await fetch(base + '/proxy/jmap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"using":[],"methodCalls":[]}' });
  check('mail API refuses calls without a session', jm.status === 401, 'HTTP ' + jm.status);

  // 3. Removed / private routes stay closed
  for (const p of ['/debug', '/api/stats', '/admin-legacy', '/admin.html', '/proxy/api/principal', '/proxy/', '/proxy/jmap/../api/principal',
    '/proxy/%2e%2e/api', '/proxy/jmap//', '/app/../server.js', '/app/%2e%2e/server.js', '/app/js/../../server.js', '/.env', '/package.json']) {
    const r = await get(p);
    check(`closed: ${p}`, [400, 403, 404].includes(r.status), 'HTTP ' + r.status);
  }

  // 4. Caller-supplied credentials are not passed to the engine
  const cred = await get('/proxy/jmap/session', { headers: { authorization: 'Basic ' + Buffer.from('probe@example.invalid:x').toString('base64') } });
  check('no password popup / no engine auth through the proxy', !cred.headers.get('www-authenticate'));

  // 5. Cross-site and non-JSON requests are refused
  const evil = await fetch(base + '/auth/login', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  check('sign-in refuses other websites', evil.status === 403, 'HTTP ' + evil.status);
  const form = await fetch(base + '/admin-api/plans', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  check('admin API refuses form posts', [401, 415].includes(form.status), 'HTTP ' + form.status);

  // 6. No permissive CORS
  for (const p of ['/', '/admin-api/me', '/proxy/jmap/session', '/healthz']) {
    const r = await get(p, { headers: { origin: 'https://evil.example' } });
    const aco = r.headers.get('access-control-allow-origin');
    check(`no CORS for other sites on ${p}`, !aco || aco === base, aco || 'none');
  }

  // 7. Sign-in errors don't reveal whether an address exists
  const a = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'no-such-user@example.invalid', password: 'x' }) });
  const aj = await a.json().catch(() => ({}));
  check('unknown address: same answer as a wrong password', [401, 429].includes(a.status) && !aj.mfaRequired, `HTTP ${a.status} ${aj.error || ''}`);

  // 8. Oversized and malformed bodies are refused
  const big = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(20000) }) }).catch(() => ({ status: 0 }));
  check('oversized sign-in body refused', [400, 413, 0].includes(big.status), 'HTTP ' + big.status);
  const bad = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
  check('malformed JSON refused', bad.status === 400, 'HTTP ' + bad.status);

  // 9. Health endpoint shows no secrets
  const hz = await get('/healthz');
  check('healthz has no secrets', hz.status === 200 && !/password|secret|token|postgres(ql)?:\/\//i.test(hz.text), hz.text.slice(0, 160));
  let health = {}; try { health = JSON.parse(hz.text); } catch (e) { /* not JSON */ }
  if (health.recoveryAdminSet !== undefined) check('recovery admin login is not left set', health.recoveryAdminSet === false, 'recoveryAdminSet=' + health.recoveryAdminSet);
  if (health.adminAccess !== undefined) check('gateway engine access is ok', health.adminAccess === 'ok', 'adminAccess=' + health.adminAccess);

  // Report
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  (' + r.detail + ')' : ''}`);
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed against ${base}`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('probe failed:', e.message); process.exit(2); });
