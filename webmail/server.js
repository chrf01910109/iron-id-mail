/**
 * IRON ID Sovereign Email — Webmail Gateway & Client Server
 * Protocol: RFC 8620 / RFC 8621 JMAP
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleApiRequest } = require('./routes/api');

const PORT = parseInt(process.env.PORT, 10) || 8080;
const STALWART_HOST = process.env.STALWART_HOST || '127.0.0.1';
const STALWART_PORT = parseInt(process.env.STALWART_PORT, 10) || 8085;
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
      hostname: STALWART_HOST,
      port: STALWART_PORT,
      path: targetPath,
      method: req.method,
      headers: {
        ...req.headers,
        host: STALWART_HOST + ':' + STALWART_PORT
      }
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Stalwart proxy connection failed', details: err.message }));
    });

    req.pipe(proxyReq);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log('[IRON ID Email] Gateway, Webmail & Admin Console running at http://localhost:' + PORT);
});
