const http = require('http');
const fs = require('fs');
const path = require('path');
const { DEFAULTS } = require('./lib/smtp');
const { checkPort25Open } = require('./lib/port25');
const {
  createJob,
  getJob,
  listJobs,
  cancelJob,
  readResults,
  resultsToCsv,
  recoverJobsOnStartup,
} = require('./lib/jobs');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
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
      if (body.length > 15 * 1024 * 1024) {
        reject(new Error('Request body too large (max 15 MB)'));
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

function parseQuery(url) {
  const i = url.indexOf('?');
  if (i === -1) return {};
  const params = new URLSearchParams(url.slice(i + 1));
  const out = {};
  for (const [key, value] of params) out[key] = value;
  return out;
}

function matchJobRoute(url) {
  const pathOnly = url.split('?')[0];
  const m = pathOnly.match(/^\/api\/jobs\/([0-9a-f-]{36})(\/results|\/download|\/cancel)?$/);
  if (!m) return null;
  return { id: m[1], action: m[2] ? m[2].slice(1) : null };
}

async function handleCreateJob(req, res) {
  try {
    const payload = await parseBody(req);
    const meta = createJob(payload);
    sendJson(res, 201, { jobId: meta.id, job: meta });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

function handleGetJob(res, id) {
  try {
    sendJson(res, 200, getJob(id));
  } catch {
    sendJson(res, 404, { error: 'Job not found' });
  }
}

function handleGetResults(res, id, query) {
  try {
    const offset = Math.max(0, parseInt(query.offset, 10) || 0);
    const results = readResults(id, offset);
    sendJson(res, 200, { results, offset, count: results.length });
  } catch {
    sendJson(res, 404, { error: 'Job not found' });
  }
}

function handleDownload(res, id) {
  try {
    const meta = getJob(id);
    const csv = resultsToCsv(id);
    const stamp = meta.createdAt.slice(0, 19).replace(/[:T]/g, '-');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="email-verification-${stamp}.csv"`,
    });
    res.end(csv);
  } catch {
    sendJson(res, 404, { error: 'Job not found' });
  }
}

async function handleCancelJob(req, res, id) {
  try {
    const cancelled = cancelJob(id);
    if (!cancelled) {
      sendJson(res, 409, { error: 'Job is not running' });
      return;
    }
    sendJson(res, 200, { ok: true, job: getJob(id) });
  } catch {
    sendJson(res, 404, { error: 'Job not found' });
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

  if (req.url.startsWith('/api/jobs')) {
    if (req.method === 'POST' && req.url.split('?')[0] === '/api/jobs') {
      handleCreateJob(req, res);
      return;
    }

    if (req.method === 'GET' && req.url.split('?')[0] === '/api/jobs') {
      sendJson(res, 200, { jobs: listJobs() });
      return;
    }

    const route = matchJobRoute(req.url);
    if (!route) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    const query = parseQuery(req.url);

    if (req.method === 'GET' && !route.action) {
      handleGetJob(res, route.id);
      return;
    }
    if (req.method === 'GET' && route.action === 'results') {
      handleGetResults(res, route.id, query);
      return;
    }
    if (req.method === 'GET' && route.action === 'download') {
      handleDownload(res, route.id);
      return;
    }
    if (req.method === 'POST' && route.action === 'cancel') {
      handleCancelJob(req, res, route.id);
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  if (req.method === 'GET') {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405);
  res.end('Method not allowed');
});

recoverJobsOnStartup();

server.listen(PORT, HOST, () => {
  console.log(`Email verification running at http://${HOST}:${PORT}`);
  console.log(`MAIL FROM: ${DEFAULTS.mailFrom}`);
  console.log(`Delay between checks: ${DEFAULTS.delayBetweenMs}ms`);
  console.log('Background jobs enabled — stored in data/jobs/');
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
