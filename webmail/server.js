/**
 * IRON ID Sovereign Email — Webmail Gateway & Client Server
 * Protocol: RFC 8620 / RFC 8621 JMAP
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const sessions = require('./services/sessionStore');
const db = require('./services/db');
const engineAdmin = require('./services/engineAdmin');
const searchBackend = require('./services/searchBackend');
const security = require('./services/accountSecurity');
const adminConsole = require('./services/adminConsole');
const labels = require('./services/labels');
const i18n = require('./services/i18n');
const signup = require('./services/signup');

let PORT = parseInt(process.env.PORT, 10) || 3001;
const ENGINE_HOST = process.env.IRONID_ENGINE_HOST || process.env.MAIL_ENGINE_HOST || '127.0.0.1';
const ENGINE_PORT = parseInt(process.env.IRONID_ENGINE_PORT || process.env.MAIL_ENGINE_PORT, 10) || 8080;

// Prevent port collision with internal mail engine
if (PORT === ENGINE_PORT) {
  PORT = 3001;
}
const PUBLIC_DIR = path.join(__dirname, 'public');
const JMAP_MAX_REQUEST = 10 * 1024 * 1024; // the engine's own limit (maxSizeRequest)
const HTML_FILE = path.join(PUBLIC_DIR, 'index.html');
const ADMIN_HTML_FILE = path.join(PUBLIC_DIR, 'admin.html');
const SIGNUP_HTML_FILE = path.join(PUBLIC_DIR, 'signup.html');
const LEGAL_PAGES = new Set(['terms', 'acceptable-use', 'privacy']);

// Webmail static files (/app/...). Only these types are served.
const STATIC_TYPES = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

// The webmail page: scripts only from this site, nothing loaded from elsewhere. Remote
// images are allowed by the page policy only so a user can choose to show them in an
// email; each email's frame carries its own stricter policy (see public/js/safeHtml.js).
// The admin console: nothing from other sites at all.
const ADMIN_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
  "font-src 'self'", "connect-src 'self'", "frame-src 'none'", "worker-src 'none'", "object-src 'none'",
  "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"
].join('; ');

const WEBMAIL_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:", "font-src 'self'", "connect-src 'self'",
  "frame-src 'self'", "child-src 'self'", "worker-src 'none'", "object-src 'none'",
  "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"
].join('; ');

// Attachment downloads come from strangers. They are served with a sandbox policy so
// that even an HTML or SVG attachment opened in the browser cannot run code on this site,
// and anything but plain images, PDF and text is always downloaded, never displayed.
const DOWNLOAD_CSP = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'";
const INLINE_SAFE_TYPES = /^(image\/(png|jpeg|gif|webp|bmp)|application\/pdf|text\/plain)(;|$)/i;

function serveStatic(res, pathname) {
  const rel = decodeURIComponent(pathname.slice('/app/'.length));
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || rel.includes('\0')) return false;
  const type = STATIC_TYPES[path.extname(file).toLowerCase()];
  if (!type) return false;
  let data;
  try { data = fs.readFileSync(file); } catch (e) { return false; }
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Length': data.length });
  res.end(data);
  return true;
}

// Only the JMAP paths the webmail needs are forwarded to the engine. Everything else
// (Stalwart's management API, web admin, etc.) stays private.
// Exactly the engine addresses the webmail uses, per method. Every segment must be non-empty
// (an extra slash would otherwise reach the engine's API without the gateway's checks).
const ENGINE_ROUTES = {
  GET: [/^\/jmap\/session\/?$/, /^\/\.well-known\/jmap$/, /^\/jmap\/download\/[^/]+\/[^/]+\/[^/]+$/, /^\/jmap\/eventsource\/?$/],
  POST: [/^\/jmap\/?$/, /^\/jmap\/upload\/[^/]+\/?$/]
};
const JMAP_API_PATH = /^\/jmap\/?$/;

const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000'
};

let schemaReady = false;

// Reads a small JSON request body (login form). An oversized body is rejected with
// status 413 and the rest is ignored; the reply then closes the connection (sendBodyError).
// Destroying the socket instead would leave no reply, which Railway's proxy turns into a 502.
function readJson(req, limit = 10000) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    req.on('data', c => {
      if (tooLarge) return;
      body += c;
      if (body.length > limit) { tooLarge = true; body = ''; reject(Object.assign(new Error('too large'), { status: 413 })); }
    });
    req.on('end', () => { if (tooLarge) return; try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Asks the engine who these credentials belong to. Returns the JMAP session or null.
function fetchEngineSession(authHeader) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      hostname: ENGINE_HOST, port: ENGINE_PORT, path: '/jmap/session', method: 'GET',
      headers: { authorization: authHeader, host: ENGINE_HOST + ':' + ENGINE_PORT }
    }, (er) => {
      let data = '';
      er.on('data', c => (data += c));
      er.on('end', () => {
        if (er.statusCode !== 200) return resolve(null);
        try {
          const session = JSON.parse(data);
          resolve(session && session.username ? session : null);
        } catch (e) { resolve(null); }
      });
    });
    r.on('error', reject);
    r.end();
  });
}

// Runs JMAP method calls on the engine with the given credentials (used for account actions).
function engineJmap(authHeader, methodCalls) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls });
    const r = http.request({
      hostname: ENGINE_HOST, port: ENGINE_PORT, path: '/jmap/', method: 'POST',
      headers: { authorization: authHeader, host: ENGINE_HOST + ':' + ENGINE_PORT, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      timeout: 20000
    }, er => {
      let data = '';
      er.on('data', c => (data += c));
      er.on('end', () => {
        if (er.statusCode !== 200) return reject(Object.assign(new Error('engine HTTP ' + er.statusCode), { status: er.statusCode }));
        try { resolve(JSON.parse(data).methodResponses); } catch (e) { reject(e); }
      });
    });
    r.on('timeout', () => r.destroy(new Error('engine timeout')));
    r.on('error', reject);
    r.end(payload);
  });
}

// The language a person chose (cp.user_prefs). Missing table or row → null (use the browser's).
async function getLangPref(email) {
  try {
    const r = await db.query('SELECT lang FROM cp.user_prefs WHERE email = $1', [String(email).toLowerCase()]);
    return r.rows.length ? i18n.validLang(r.rows[0].lang) : null;
  } catch (e) { return null; }
}
async function setLangPref(email, lang) {
  await db.query(`INSERT INTO cp.user_prefs (email, lang) VALUES ($1, $2)
                  ON CONFLICT (email) DO UPDATE SET lang = EXCLUDED.lang, updated_at = NOW()`, [String(email).toLowerCase(), lang]);
}

function sendJson(res, status, obj, extraHeaders = {}) {
  // Messages for people are written in English; send them in the request's language.
  if (obj && res.ironLang && res.ironLang !== 'en') obj = i18n.translateMessages(res.ironLang, obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(obj));
}

// Answers a request whose JSON body readJson() refused.
function sendBodyError(res, e) {
  if (e && e.status === 413) return sendJson(res, 413, { error: 'Request too large' }, { Connection: 'close' });
  return sendJson(res, 400, { error: 'Invalid request' });
}

// Blocks cross-site form posts that would ride on the session cookie.
function isCrossSite(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host !== req.headers.host; } catch (e) { return true; }
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  res.ironLang = i18n.langFrom(req);

  let reqUrl;
  try {
    reqUrl = new URL(req.url, 'http://localhost');
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }

  try {

  // 2. Admin console: the page, and its API for admins signed in with their mailbox.
  if ((reqUrl.pathname === '/admin' || reqUrl.pathname === '/admin/') && (req.method === 'GET' || req.method === 'HEAD')) {
    try {
      const html = i18n.htmlFor(fs.readFileSync(ADMIN_HTML_FILE, 'utf8'), res.ironLang);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': ADMIN_CSP, 'Cache-Control': 'no-cache', 'Vary': 'Cookie, Accept-Language' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error loading the admin console');
    }
    return;
  }
  if (reqUrl.pathname.startsWith('/admin-api/')) {
    if (!schemaReady) return sendJson(res, 503, { error: 'The server is starting. Please try again in a moment.' });
    const session = await sessions.getSession(sessions.sessionIdFrom(req));
    return adminConsole.handle(req, res, reqUrl, { readJson, sendJson, sendBodyError, isCrossSite, session, ip: sessions.clientIp(req) });
  }


  // 2b. Sign-up for name@<platform domain> (off unless SIGNUP_ENABLED=true) and the pages it links to.
  if ((reqUrl.pathname === '/signup' || reqUrl.pathname === '/signup/') && (req.method === 'GET' || req.method === 'HEAD')) {
    try {
      const html = i18n.htmlFor(fs.readFileSync(SIGNUP_HTML_FILE, 'utf8'), res.ironLang);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': ADMIN_CSP, 'Cache-Control': 'no-cache', 'Vary': 'Cookie, Accept-Language' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error loading the sign-up page');
    }
    return;
  }
  const legal = /^\/legal\/([a-z-]+)$/.exec(reqUrl.pathname);
  if (legal && LEGAL_PAGES.has(legal[1]) && (req.method === 'GET' || req.method === 'HEAD')) {
    try {
      const html = i18n.htmlFor(fs.readFileSync(path.join(PUBLIC_DIR, 'legal', legal[1] + '.html'), 'utf8'), res.ironLang);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': ADMIN_CSP, 'Cache-Control': 'no-cache', 'Vary': 'Cookie, Accept-Language' });
      res.end(html);
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
    return;
  }
  if (reqUrl.pathname.startsWith('/signup-api/')) {
    if (!schemaReady) return sendJson(res, 503, { error: 'The server is starting. Please try again in a moment.' });
    const ip = sessions.clientIp(req);
    return signup.handle(req, res, reqUrl, {
      readJson, sendJson, sendBodyError, isCrossSite, ip, lang: res.ironLang,
      // The new account is signed in straight away, like /auth/login.
      openSession: async (email, webAuth) => {
        await sessions.destroySession(sessions.sessionIdFrom(req));
        const id = await sessions.createSession(email, webAuth, { ip, userAgent: req.headers['user-agent'] });
        await setLangPref(email, res.ironLang).catch(e => console.error('[signup] saving language:', e.message));
        return { 'Set-Cookie': [sessions.sessionCookie(req, id), i18n.langCookie(req, res.ironLang)] };
      }
    });
  }

  // 3. Serve Webmail Client Single-Page App
  if (reqUrl.pathname.startsWith('/app/') && (req.method === 'GET' || req.method === 'HEAD')) {
    let ok = false;
    try { ok = serveStatic(res, reqUrl.pathname); } catch (e) { ok = false; }
    if (!ok) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not Found'); }
    return;
  }
  if (reqUrl.pathname === '/' || reqUrl.pathname === '/index.html') {
    try {
      const html = i18n.htmlFor(fs.readFileSync(HTML_FILE, 'utf8'), res.ironLang);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': WEBMAIL_CSP, 'Cache-Control': 'no-cache', 'Vary': 'Cookie, Accept-Language' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error loading client HTML: ' + err.message);
    }
    return;
  }

  // 3b. Webmail sign-in / sign-out (server-side session, HttpOnly cookie)
  if (reqUrl.pathname === '/auth/login' && req.method === 'POST') {
    if (isCrossSite(req)) return sendJson(res, 403, { error: 'Forbidden' });
    if (!schemaReady) return sendJson(res, 503, { error: 'The server is starting. Please try again in a moment.' });
    const ip = sessions.clientIp(req);
    let body;
    try { body = await readJson(req); } catch (e) { return sendBodyError(res, e); }
    const email = String(body.email || '').trim();
    const password = String(body.password || '');
    const code = String(body.code || '').replace(/\s+/g, '');
    if (!email || !password) return sendJson(res, 400, { error: 'Email and password are required.' });
    if (sessions.isLoginBlocked(ip, email)) {
      return sendJson(res, 429, { error: 'Too many failed sign-in attempts. Please wait 15 minutes and try again.' });
    }
    try {
      const check = await security.checkPassword(email, password);
      const signInAudit = (ok, reason) => adminConsole.auditSignIn({ email, ok, reason, ip, userAgent: req.headers['user-agent'] });
      if (check.result === 'bad') {
        sessions.recordFailedLogin(ip, email);
        signInAudit(false, 'password');
        return sendJson(res, 401, { error: 'Invalid mailbox credentials' });
      }
      let proof; // credentials that prove this sign-in, used to set up the webmail's access
      if (check.result === 'mfa') {
        if (!code) return sendJson(res, 401, { mfaRequired: true, error: 'Enter the 6-digit code from your authenticator app.' });
        // The password is proven at this point, so claiming the code first is safe and stops
        // two parallel sign-ins from using the same code.
        if (!security.validCodeFormat(code) || !(await security.claimCode(email, code))) {
          sessions.recordFailedLogin(ip, email);
          signInAudit(false, 'code');
          return sendJson(res, 401, { mfaRequired: true, error: 'That code is not right. Wait for a new code and try again.' });
        }
        proof = await security.signInWithCode(email, password, code);
        if (!proof) {
          sessions.recordFailedLogin(ip, email);
          signInAudit(false, 'code');
          return sendJson(res, 401, { mfaRequired: true, error: 'That code is not right. Wait for a new code and try again.' });
        }
      } else {
        proof = security.basic(email, password);
      }
      const webAuth = await security.webmailAuthFor(email, proof);
      const session = await security.engineSession(webAuth);
      if (!session) throw new Error('webmail credential not accepted');
      sessions.clearFailedLogins(ip, session.username);
      await sessions.destroySession(sessions.sessionIdFrom(req)); // replace any previous session from this browser
      const id = await sessions.createSession(session.username, webAuth, { ip, userAgent: req.headers['user-agent'] });
      adminConsole.auditSignIn({ email: session.username, ok: true, reason: check.result === 'mfa' ? 'two-step' : undefined, ip, userAgent: req.headers['user-agent'] });
      // Language: a choice made on the sign-in screen is saved to the account; otherwise the
      // account's saved choice wins, so the same language follows the person to every device.
      const picked = i18n.validLang(body.lang);
      let lang = picked || await getLangPref(session.username) || res.ironLang;
      if (picked) await setLangPref(session.username, picked).catch(e => console.error('[auth] saving language:', e.message));
      res.ironLang = lang;
      return sendJson(res, 200, { session, lang }, { 'Set-Cookie': [sessions.sessionCookie(req, id), i18n.langCookie(req, lang)] });
    } catch (e) {
      console.error('[auth] sign-in failed:', e.message);
      if (e.code === 'overQuota') return sendJson(res, 409, { error: e.message });
      return sendJson(res, 502, { error: 'Mail engine is temporarily unavailable. Please try again shortly.' });
    }
  }

  if (reqUrl.pathname === '/auth/logout' && req.method === 'POST') {
    if (isCrossSite(req)) return sendJson(res, 403, { error: 'Forbidden' });
    try { await sessions.destroySession(sessions.sessionIdFrom(req)); } catch (e) { console.error('[auth] logout:', e.message); }
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessions.clearCookie(req) });
  }

  // 3c. Account security (password, two-step, signed-in browsers, app passwords).
  if (reqUrl.pathname.startsWith('/account/')) {
    if (req.method !== 'GET' && isCrossSite(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const sid = sessions.sessionIdFrom(req);
    const current = await sessions.getSession(sid);
    if (!current) return sendJson(res, 401, { error: 'Your session has ended. Please sign in again.' });
    const ip = sessions.clientIp(req);
    const route = req.method + ' ' + reqUrl.pathname;
    const engineDown = e => {
      if (e && e.status === 401) return sendJson(res, 401, { error: 'Your session has ended. Please sign in again.' });
      console.error('[account] ' + route + ':', e && e.message);
      return sendJson(res, 502, { error: 'Mail engine is temporarily unavailable. Please try again shortly.' });
    };
    let body = {};
    if (req.method === 'POST') {
      try { body = await readJson(req); } catch (e) { return sendBodyError(res, e); }
    }
    const needsBrake = ['POST /account/password', 'POST /account/two-step/enable', 'POST /account/two-step/disable'].includes(route);
    if (needsBrake && sessions.isLoginBlocked(ip, current.email)) {
      return sendJson(res, 429, { error: 'Too many failed attempts. Please wait 15 minutes and try again.' });
    }
    try {
      if (route === 'GET /account/security') {
        const [twoStep, appPasswords, list, recent] = await Promise.all([
          security.twoStepEnabled(current.auth), security.mailAppPasswords(current.auth), sessions.listSessionsFor(current.email, sid),
          db.query(`SELECT at, action, ip, details->>'agent' AS agent, details->>'reason' AS reason FROM cp.audit_log
                     WHERE target = $1 AND action LIKE 'signin.%' ORDER BY at DESC LIMIT 10`, [String(current.email).toLowerCase()]).then(r => r.rows).catch(() => [])
        ]);
        return sendJson(res, 200, { twoStep, appPasswords, sessions: list, recentSignIns: recent.map(x => ({ at: x.at, ok: x.action === 'signin.ok', ip: x.ip, agent: x.agent, reason: x.reason })) });
      }

      // Who am I to the gateway: admin console access, teams (shared mailboxes) and labels.
      if (route === 'GET /account/me') {
        const [admin, teams, myLabels, lang] = await Promise.all([
          adminConsole.isAdmin(current.email),
          adminConsole.teamsFor(current.email).catch(e => { console.error('[account] teams:', e.message); return []; }),
          labels.list(String(current.email).toLowerCase()),
          getLangPref(current.email)
        ]);
        return sendJson(res, 200, { email: current.email, admin, teams, labels: myLabels, lang });
      }
      if (route === 'POST /account/labels') return sendJson(res, 200, await labels.create(String(current.email).toLowerCase(), body));
      if (route === 'POST /account/labels/update') return sendJson(res, 200, await labels.update(String(current.email).toLowerCase(), body));
      if (route === 'POST /account/labels/delete') return sendJson(res, 200, await labels.remove(String(current.email).toLowerCase(), body));

      // Change own password. Every other browser is signed out (their access is revoked in
      // the engine too) and this browser gets fresh access.
      if (route === 'POST /account/password') {
        const currentPassword = String(body.currentPassword || '');
        const newPassword = String(body.newPassword || '');
        const code = String(body.code || '').replace(/\s+/g, '');
        if (newPassword.length < 12) return sendJson(res, 400, { error: 'New password must be at least 12 characters.' });
        if (newPassword === currentPassword) return sendJson(res, 400, { error: 'The new password must be different from the current one.' });
        const twoStep = await security.twoStepEnabled(current.auth);
        if (twoStep && !security.validCodeFormat(code)) {
          return sendJson(res, 400, { needCode: true, error: 'Enter the current 6-digit code from your authenticator app.' });
        }
        if (twoStep && !(await security.claimCode(current.email, code))) {
          return sendJson(res, 400, { needCode: true, error: 'That code was already used. Wait for the next one.' });
        }
        if (twoStep ? !(await security.signInWithCode(current.email, currentPassword, code)) : (await security.checkPassword(current.email, currentPassword)).result !== 'ok') {
          sessions.recordFailedLogin(ip, current.email);
          return sendJson(res, 400, { error: twoStep ? 'Your current password or the code is not right.' : 'Your current password is incorrect.' });
        }
        const update = { currentSecret: currentPassword, secret: newPassword };
        if (twoStep) update.otpAuth = { otpCode: code };
        const result = await engineJmap(current.auth, [['x:AccountPassword/set', { update: { singleton: update } }, 'pw']]);
        const [name, r] = result[0] || [];
        if (name === 'x:AccountPassword/set' && r.updated && 'singleton' in r.updated) {
          sessions.clearFailedLogins(ip, current.email);
          const working = (await security.engineSession(current.auth)) ? current.auth : security.basic(current.email, newPassword);
          const webAuth = await security.rotateWebmailCredential(current.email, working);
          const id = await sessions.replaceSessionsFor(current.email, webAuth, { ip, userAgent: req.headers['user-agent'] });
          db.audit({ actor: current.email, action: 'account.password_changed', target: current.email, ip }).catch(() => {});
          return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessions.sessionCookie(req, id) });
        }
        const failure = (r && r.notUpdated && r.notUpdated.singleton) || r || {};
        const msg = security.friendly(failure.description || 'The password could not be changed.');
        if (/incorrect|not right/i.test(msg)) sessions.recordFailedLogin(ip, current.email);
        return sendJson(res, 400, { error: msg });
      }

      if (route === 'POST /account/two-step/setup') {
        return sendJson(res, 200, security.newTotpSetup(current.email));
      }

      if (route === 'POST /account/two-step/enable' || route === 'POST /account/two-step/disable') {
        const enabling = route.endsWith('enable');
        const password = String(body.password || '');
        const code = String(body.code || '').replace(/\s+/g, '');
        const secret = enabling ? String(body.secret || '').replace(/\s+/g, '').toUpperCase() : null;
        if (!password) return sendJson(res, 400, { error: 'Enter your current password.' });
        if (!security.validCodeFormat(code)) return sendJson(res, 400, { error: 'Enter the 6-digit code from your authenticator app.' });
        if (enabling && !security.validSecret(secret)) return sendJson(res, 400, { error: 'Start the setup again.' });
        // The URL is built here from the secret alone, so only settings this server supports are saved.
        const otpUrl = enabling ? security.otpUrlFor(current.email, secret) : null;
        if (!(await security.claimCode(current.email, code))) return sendJson(res, 400, { error: 'That code was already used. Wait for the next one.' });
        // Verify here: the engine does not check the first code when two-step is turned on.
        if (enabling) {
          const pw = await security.checkPassword(current.email, password);
          if (pw.result !== 'ok') {
            sessions.recordFailedLogin(ip, current.email);
            return sendJson(res, 400, { error: pw.result === 'mfa' ? 'Two-step sign-in is already on.' : 'Your password is incorrect.' });
          }
          if (!security.totpMatches(secret, code)) {
            return sendJson(res, 400, { error: 'That code is not right. Check that your app shows "' + current.email + '" and enter the current code.' });
          }
        } else if (!(await security.signInWithCode(current.email, password, code))) {
          sessions.recordFailedLogin(ip, current.email);
          return sendJson(res, 400, { error: 'Your password or the code is not right.' });
        }
        const problem = await security.setTwoStep(current.auth, password, otpUrl, code);
        if (problem) {
          sessions.recordFailedLogin(ip, current.email);
          return sendJson(res, 400, { error: problem });
        }
        sessions.clearFailedLogins(ip, current.email);
        db.audit({ actor: current.email, action: enabling ? 'account.two_step_on' : 'account.two_step_off', target: current.email, ip }).catch(() => {});
        return sendJson(res, 200, { ok: true, twoStep: enabling });
      }

      if (route === 'POST /account/sessions/sign-out') {
        if (body.others === true) {
          const webAuth = await security.rotateWebmailCredential(current.email, current.auth);
          const id = await sessions.replaceSessionsFor(current.email, webAuth, { ip, userAgent: req.headers['user-agent'] });
          db.audit({ actor: current.email, action: 'account.signed_out_others', target: current.email, ip }).catch(() => {});
          return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessions.sessionCookie(req, id) });
        }
        const ok = await sessions.destroySessionByKey(current.email, String(body.key || ''));
        return ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'That browser is already signed out.' });
      }

      if (route === 'POST /account/app-passwords') {
        if (sessions.isLoginBlocked(ip, current.email)) return sendJson(res, 429, { error: 'Too many failed attempts. Please wait 15 minutes and try again.' });
        const pw = await security.checkPassword(current.email, String(body.password || ''));
        if (pw.result === 'bad') {
          sessions.recordFailedLogin(ip, current.email);
          return sendJson(res, 400, { error: 'Your password is incorrect.' });
        }
        const created = await security.createMailAppPassword(current.auth, body.name);
        db.audit({ actor: current.email, action: 'account.app_password_created', target: String(body.name || '').slice(0, 60), ip }).catch(() => {});
        return sendJson(res, 200, { id: created.id, secret: created.secret });
      }

      if (route === 'GET /account/prefs') {
        return sendJson(res, 200, { lang: (await getLangPref(current.email)) || res.ironLang, languages: i18n.SUPPORTED });
      }

      if (route === 'POST /account/prefs') {
        const lang = i18n.validLang(body.lang);
        if (!lang) return sendJson(res, 400, { error: 'Choose English or French.' });
        await setLangPref(current.email, lang);
        res.ironLang = lang;
        return sendJson(res, 200, { ok: true, lang }, { 'Set-Cookie': i18n.langCookie(req, lang) });
      }

      if (route === 'POST /account/app-passwords/delete') {
        const ok = await security.deleteMailAppPassword(current.auth, body.id);
        if (ok) db.audit({ actor: current.email, action: 'account.app_password_revoked', target: String(body.id), ip }).catch(() => {});
        return ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'That app password no longer exists.' });
      }
    } catch (e) {
      if (e.userError) return sendJson(res, e.status || 400, { error: e.message });
      return engineDown(e);
    }
    return sendJson(res, 404, { error: 'Not found' });
  }

  // 4. Transparent Proxy for JMAP requests
  if (reqUrl.pathname.startsWith('/proxy/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD' && isCrossSite(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    const targetPath = reqUrl.pathname.slice('/proxy'.length);
    const allowed = ENGINE_ROUTES[req.method === 'HEAD' ? 'GET' : req.method] || [];
    if (!allowed.some(re => re.test(targetPath)) || /[%\\]/.test(targetPath.replace(/^\/jmap\/download\//, ''))) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    const options = {
      hostname: ENGINE_HOST,
      port: ENGINE_PORT,
      path: targetPath + reqUrl.search,
      method: req.method,
      headers: {
        ...req.headers,
        host: ENGINE_HOST + ':' + ENGINE_PORT
      }
    };
    // Only the signed-in user's credentials from the server-side session reach the engine:
    // never the browser's cookies or an Authorization header the caller supplies (that would
    // let anyone guess passwords at the engine without the gateway's sign-in brake), nor
    // connection-level or forwarding headers.
    for (const name of ['cookie', 'authorization', 'proxy-authorization', 'connection', 'keep-alive', 'proxy-connection',
      'te', 'trailer', 'upgrade', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']) {
      delete options.headers[name];
    }
    const s = await sessions.getSession(sessions.sessionIdFrom(req));
    if (s) options.headers.authorization = s.auth;

    const isDownload = /^\/jmap\/download\//.test(targetPath);
    const proxyRes_headers = (h) => {
      const out = { ...h };
      delete out['www-authenticate']; // avoid the browser's native password popup
      delete out['set-cookie'];
      if (isDownload) {
        out['content-security-policy'] = DOWNLOAD_CSP;
        out['x-content-type-options'] = 'nosniff';
        out['cache-control'] = 'private, no-store';
        const type = String(out['content-type'] || '');
        const inlineAsked = reqUrl.searchParams.get('inline') === '1';
        if (inlineAsked && INLINE_SAFE_TYPES.test(type)) {
          const cd = String(out['content-disposition'] || '');
          out['content-disposition'] = /^\s*attachment/i.test(cd) ? cd.replace(/^\s*attachment/i, 'inline') : (cd || 'inline');
        } else {
          // Never trust the sender's file type for something we don't display: an opaque
          // type means the browser can't use it as a script or style sheet either.
          out['content-type'] = 'application/octet-stream';
          // Keep the engine's file name but always download.
          const cd = String(out['content-disposition'] || '');
          out['content-disposition'] = /^\s*inline/i.test(cd) ? cd.replace(/^\s*inline/i, 'attachment') : (cd && /^\s*attachment/i.test(cd) ? cd : 'attachment');
        }
      }
      return out;
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes_headers(proxyRes.headers));
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      if (res.writableEnded) return; // already answered (e.g. refused by the gateway)
      console.error('[proxy] engine unreachable:', err.message);
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: i18n.translate(res.ironLang, 'Mail engine is temporarily unavailable. Please try again shortly.') }));
    });

    // Webmail sessions may use the standard mail functions only. The engine's own
    // management objects (urn:stalwart:jmap, x:…) stay behind the gateway's /account routes,
    // which re-check the password and code. Anything that isn't clean JSON is refused.
    if (req.method === 'POST' && JMAP_API_PATH.test(targetPath)) {
      if (!options.headers.authorization) {
        proxyReq.destroy();
        return sendJson(res, 401, { error: 'Not signed in' });
      }
      const chunks = [];
      let size = 0, done = false;
      const refuse = (status, error) => {
        if (done) return;
        done = true;
        proxyReq.destroy();
        if (!res.headersSent) sendJson(res, status, { error });
        res.on('finish', () => req.destroy());
      };
      req.on('data', c => {
        if (done) return;
        size += c.length;
        if (size > JMAP_MAX_REQUEST) { chunks.length = 0; return refuse(413, 'Request too large'); }
        chunks.push(c);
      });
      req.on('aborted', () => { done = true; proxyReq.destroy(); });
      req.on('end', () => {
        if (done) return;
        const raw = Buffer.concat(chunks);
        let parsed;
        try { parsed = JSON.parse(raw.toString('utf8')); } catch (e) { return refuse(400, 'Invalid request'); }
        const usesEngineAdmin = !parsed || typeof parsed !== 'object' ||
          !Array.isArray(parsed.using) || parsed.using.some(u => /^urn:stalwart:/i.test(String(u))) ||
          !Array.isArray(parsed.methodCalls) || parsed.methodCalls.some(m => !Array.isArray(m) || /^x:/i.test(String(m[0])));
        if (usesEngineAdmin) return refuse(403, 'Not allowed from the webmail');
        done = true;
        const clean = Buffer.from(JSON.stringify(parsed));
        proxyReq.setHeader('content-type', 'application/json');
        proxyReq.setHeader('content-length', clean.length);
        proxyReq.removeHeader('transfer-encoding');
        proxyReq.end(clean);
      });
      return;
    }
    req.pipe(proxyReq);
    return;
  }

  // 4b. Health check for monitoring (no secrets)
  if (reqUrl.pathname === '/healthz' && req.method === 'GET') {
    const result = { gateway: 'ok', engine: 'down', database: 'down', schema: schemaReady ? 'ok' : 'pending', adminAccess: engineAdmin.getStatus(), recoveryAdminSet: engineAdmin.recoveryAdminSet(), search: searchBackend.getStatus() };
    try {
      const r = await new Promise((resolve, reject) => {
        const er = http.get({ hostname: ENGINE_HOST, port: ENGINE_PORT, path: '/jmap/session', timeout: 5000 }, x => { x.resume(); resolve(x.statusCode); });
        er.on('timeout', () => er.destroy(new Error('timeout')));
        er.on('error', reject);
      });
      if (r === 200 || r === 401) result.engine = 'ok';
    } catch (e) { /* engine down */ }
    try { await db.query('SELECT 1'); result.database = 'ok'; } catch (e) { /* db down */ }
    const healthy = result.engine === 'ok' && result.database === 'ok' && schemaReady;
    return sendJson(res, healthy ? 200 : 503, result);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
  } catch (err) {
    console.error('[gateway] request failed:', err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
});

server.listen(PORT, () => {
  console.log('[IRON ID Email] Gateway, Webmail & Admin Console running at http://localhost:' + PORT);
});

// Control-plane schema, then the gateway's engine admin key. Both are retried until
// they succeed (Postgres or the engine may still be starting), with a capped backoff.
(async () => {
  const wait = n => new Promise(r => setTimeout(r, Math.min(60000, 2000 * n)));
  for (let attempt = 1; !schemaReady; attempt++) {
    try {
      await db.migrate();
      schemaReady = true;
      // Once: sessions made before the webmail used its own app password hold real mailbox
      // passwords (encrypted). They are ended so no stored password remains.
      try {
        if (!(await db.getSetting('sessions_without_passwords'))) {
          const r = await db.query('DELETE FROM cp.sessions');
          await db.setSetting('sessions_without_passwords', new Date().toISOString());
          console.log(`[sessions] Ended ${r.rowCount} older session(s) that held mailbox passwords; people sign in once more.`);
        }
      } catch (e) { console.error('[sessions] one-time clean-up failed (will retry next start):', e.message); }
      console.log('[db] Control-plane schema ready.');
      adminConsole.pruneAudit();
      setInterval(() => adminConsole.pruneAudit(), 24 * 3600 * 1000).unref();
    } catch (e) {
      console.error(`[db] Control-plane migration failed (attempt ${attempt}), retrying:`, e.message);
      await wait(attempt);
    }
  }
  let st;
  for (let attempt = 1; ; attempt++) {
    st = await engineAdmin.ensureApiKey();
    if (st !== 'error') break;
    await wait(attempt);
  }
  // A freshly seeded database: replace the seed accounts' known passwords.
  if (st === 'ok' || st === 'provisioned' || st === 'needs_update') await require('./services/seedGuard').rotateSeedPasswords();
  // Mail search backend (OpenSearch): configure if asked, then keep an eye on it.
  if (st === 'ok' || st === 'provisioned' || st === 'needs_update') await searchBackend.start();
})();
