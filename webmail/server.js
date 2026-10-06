/**
 * IRON ID Sovereign Email — Webmail Gateway & Client Server
 * Protocol: RFC 8620 / RFC 8621 JMAP
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleApiRequest } = require('./routes/api');

let PORT = parseInt(process.env.PORT, 10) || 3001;
const ENGINE_HOST = process.env.IRONID_ENGINE_HOST || process.env.MAIL_ENGINE_HOST || '127.0.0.1';
const ENGINE_PORT = parseInt(process.env.IRONID_ENGINE_PORT || process.env.MAIL_ENGINE_PORT, 10) || 8080;

// Prevent port collision with internal mail engine
if (PORT === ENGINE_PORT) {
  PORT = 3001;
}
const HTML_FILE = path.join(__dirname, 'client.html');
const ADMIN_HTML_FILE = path.join(__dirname, 'admin.html');

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, 'http://' + (req.headers.host || 'localhost:3001'));

  // 1. Administrative REST API (Phase 2)
  if (reqUrl.pathname.startsWith('/api/')) {
    const handled = await handleApiRequest(req, res, reqUrl.pathname);
    if (handled) return;
  }

  // 2. Serve Admin Management Console (Phase 2)
  if (reqUrl.pathname === '/admin' || reqUrl.pathname === '/admin.html') {
    try {
      const html = fs.readFileSync(ADMIN_HTML_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error loading admin HTML: ' + err.message);
    }
    return;
  }

  // 3. Serve Webmail Client Single-Page App
  if (reqUrl.pathname === '/' || reqUrl.pathname === '/index.html') {
    try {
      const html = fs.readFileSync(HTML_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error loading client HTML: ' + err.message);
    }
    return;
  }

  // 4. Transparent Proxy for JMAP requests
  if (reqUrl.pathname.startsWith('/proxy/')) {
    const targetPath = reqUrl.pathname.replace('/proxy', '');
    const options = {
      hostname: ENGINE_HOST,
      port: ENGINE_PORT,
      path: targetPath,
      method: req.method,
      headers: {
        ...req.headers,
        host: ENGINE_HOST + ':' + ENGINE_PORT
      }
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      let logSnippet = '';
      try {
        const logPath = '/var/log/ironid-engine.log';
        let logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
        logSnippet = logContent.split('\n').slice(-15).join('\n');
      } catch (e) {
        logSnippet = 'Log not available: ' + e.message;
      }
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'IRON ID Sovereign Mail Engine connection failed',
        details: err.message,
        target: `${ENGINE_HOST}:${ENGINE_PORT}${targetPath}`,
        engineLog: logSnippet
      }));
    });

    req.pipe(proxyReq);
    return;
  }

  // 5. System Diagnostic Debug Route
  if (reqUrl.pathname === '/debug') {
    let logContent = '';
    try {
      const logPath = '/var/log/ironid-engine.log';
      if (fs.existsSync(logPath)) logContent = fs.readFileSync(logPath, 'utf8');
    } catch(e) { logContent = e.message; }
    let cfgContent = '';
    try { cfgContent = fs.readFileSync('/opt/iron-id/config.json', 'utf8'); } catch(e) { cfgContent = e.message; }
    let pgLogContent = '';
    try { pgLogContent = fs.readFileSync('/var/log/postgresql/postgresql.log', 'utf8'); } catch(e) { pgLogContent = e.message; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      product: 'IRON ID Sovereign Mail',
      env: {
        PORT: process.env.PORT,
        ENGINE_PORT: ENGINE_PORT,
        DATABASE_URL_SET: !!process.env.DATABASE_URL
      },
      engineLog: logContent.slice(-4000),
      postgresLog: pgLogContent.slice(-2000),
      configJson: cfgContent
    }, null, 2));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log('[IRON ID Email] Gateway, Webmail & Admin Console running at http://localhost:' + PORT);
});
