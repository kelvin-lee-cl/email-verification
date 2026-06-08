const http = require('http');
const fs = require('fs');
const path = require('path');
const { verifyEmail, sleep, DEFAULTS } = require('./lib/smtp');
const { checkPort25Open } = require('./lib/port25');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

let port25Status = { open: null, host: null, port: null, error: null, checkedAt: null };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(PUBLIC_DIR, filePath);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function handleVerifyStream(req, res) {
  let payload;
  try {
    payload = await parseBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  const emails = Array.isArray(payload.emails) ? payload.emails : [];
  if (emails.length === 0) {
    sendJson(res, 400, { error: 'No emails provided' });
    return;
  }

  const delayMs = typeof payload.delayMs === 'number' ? payload.delayMs : DEFAULTS.delayBetweenMs;

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const writeLine = async (obj) => {
    if (res.writableEnded) return;
    const line = JSON.stringify(obj) + '\n';
    if (!res.write(line)) {
      await new Promise((resolve) => res.once('drain', resolve));
    }
  };

  const total = emails.length;
  await writeLine({
    type: 'start',
    total,
    port25Open: port25Status.open,
  });

  for (let i = 0; i < emails.length; i++) {
    if (res.writableEnded) break;

    await writeLine({
      type: 'progress',
      index: i,
      total,
      stage: 'starting',
      email: emails[i],
    });

    let result;
    try {
      result = await verifyEmail(emails[i], {}, (progress) => {
        writeLine({
          type: 'progress',
          index: i,
          total,
          ...progress,
        });
      });
    } catch (err) {
      result = {
        email: emails[i],
        domain: null,
        mxServer: null,
        smtpCode: null,
        smtpMessage: null,
        status: 'ERROR',
        error: err.message,
        meaning: err.message,
      };
    }

    if (res.writableEnded) break;

    await writeLine({ type: 'result', index: i, total, ...result });

    if (i < emails.length - 1) {
      await writeLine({
        type: 'progress',
        index: i,
        total,
        stage: 'waiting',
        email: emails[i + 1],
        delayMs,
      });
      await sleep(delayMs);
    }
  }

  if (!res.writableEnded) {
    await writeLine({ type: 'done', total });
    res.end();
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/verify') {
    handleVerifyStream(req, res).catch((err) => {
      console.error('Verify stream error:', err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: err.message });
      } else if (!res.writableEnded) {
        res.end();
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/status') {
    sendJson(res, 200, {
      port25: port25Status,
      defaults: {
        connectTimeoutMs: DEFAULTS.connectTimeoutMs,
        timeoutMs: DEFAULTS.timeoutMs,
        delayBetweenMs: DEFAULTS.delayBetweenMs,
      },
    });
    return;
  }

  if (req.method === 'GET') {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405);
  res.end('Method not allowed');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Email verification running at http://127.0.0.1:${PORT}`);
  console.log(`MAIL FROM: ${DEFAULTS.mailFrom}`);
  console.log(`Delay between checks: ${DEFAULTS.delayBetweenMs}ms`);
  console.log('Checking outbound port 25…');

  checkPort25Open().then((result) => {
    port25Status = {
      open: result.open,
      host: result.host,
      port: result.port,
      error: result.error,
      checkedAt: new Date().toISOString(),
    };

    if (result.open) {
      console.log(`Port 25 is reachable (${result.host}:${result.port})`);
    } else {
      console.warn('Port 25 appears blocked or unreachable.');
      console.warn(`  Probe: ${result.host}:${result.port}`);
      console.warn(`  Reason: ${result.error}`);
      console.warn('  SMTP verification will fail until you run this on a network with open port 25 (e.g. a VPS).');
    }
  });
});
