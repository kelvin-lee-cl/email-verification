const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { verifyEmail, sleep, isConnectionError, DEFAULTS } = require('./smtp');

const JOBS_DIR = path.join(__dirname, '..', 'data', 'jobs');
const activeJobs = new Map();

function ensureJobsDir() {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
}

function jobPath(id, file) {
  return path.join(JOBS_DIR, id, file);
}

function readMeta(id) {
  const raw = fs.readFileSync(jobPath(id, 'meta.json'), 'utf8');
  return JSON.parse(raw);
}

function writeMeta(id, meta) {
  meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(jobPath(id, 'meta.json'), JSON.stringify(meta, null, 2));
}

function emptyCounts() {
  return { YES: 0, NO: 0, UNKNOWN: 0, TEMP: 0, ERROR: 0, INVALID: 0 };
}

function parseVerifyOptions(payload) {
  const emails = Array.isArray(payload.emails) ? payload.emails : [];
  if (emails.length === 0) throw new Error('No emails provided');
  if (emails.length > 10000) throw new Error('Maximum 10,000 emails per batch');

  return {
    emails,
    delayMs: typeof payload.delayMs === 'number'
      ? Math.max(1000, Math.min(payload.delayMs, 60000))
      : DEFAULTS.delayBetweenMs,
    cooldownEvery: typeof payload.cooldownEvery === 'number'
      ? Math.max(0, Math.min(payload.cooldownEvery, 100))
      : 8,
    cooldownMs: typeof payload.cooldownMs === 'number'
      ? Math.max(10000, Math.min(payload.cooldownMs, 600000))
      : 90000,
    streakCooldownMs: typeof payload.streakCooldownMs === 'number'
      ? Math.max(30000, Math.min(payload.streakCooldownMs, 600000))
      : 120000,
    streakThreshold: 3,
  };
}

function createJob(payload) {
  ensureJobsDir();
  const options = parseVerifyOptions(payload);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  fs.mkdirSync(jobPath(id, ''), { recursive: true });
  fs.writeFileSync(jobPath(id, 'emails.json'), JSON.stringify(options.emails));
  fs.writeFileSync(jobPath(id, 'results.ndjson'), '');

  const meta = {
    id,
    status: 'pending',
    total: options.emails.length,
    done: 0,
    progressDetail: 'Queued…',
    counts: emptyCounts(),
    settings: {
      delayMs: options.delayMs,
      cooldownEvery: options.cooldownEvery,
      cooldownMs: options.cooldownMs,
    },
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    error: null,
  };

  writeMeta(id, meta);
  setImmediate(() => runJob(id).catch((err) => {
    console.error(`Job ${id} failed:`, err);
    try {
      const failed = readMeta(id);
      failed.status = 'failed';
      failed.error = err.message;
      failed.finishedAt = new Date().toISOString();
      writeMeta(id, failed);
    } catch {
      /* ignore */
    }
    activeJobs.delete(id);
  }));

  return meta;
}

function appendResult(id, index, result) {
  const line = JSON.stringify({ index, ...result }) + '\n';
  fs.appendFileSync(jobPath(id, 'results.ndjson'), line);
}

function readResults(id, offset = 0) {
  const file = jobPath(id, 'results.ndjson');
  if (!fs.existsSync(file)) return [];

  const content = fs.readFileSync(file, 'utf8');
  if (!content.trim()) return [];

  return content
    .trim()
    .split('\n')
    .slice(offset)
    .map((line) => JSON.parse(line));
}

function listJobs(limit = 20) {
  ensureJobsDir();
  const dirs = fs.readdirSync(JOBS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const jobs = [];
  for (const id of dirs) {
    try {
      const meta = readMeta(id);
      jobs.push({
        id: meta.id,
        status: meta.status,
        total: meta.total,
        done: meta.done,
        counts: meta.counts,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        finishedAt: meta.finishedAt,
      });
    } catch {
      /* skip corrupt job */
    }
  }

  jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return jobs.slice(0, limit);
}

function getJob(id) {
  return readMeta(id);
}

function cancelJob(id) {
  const runner = activeJobs.get(id);
  if (runner) {
    runner.cancelled = true;
    return true;
  }

  const meta = readMeta(id);
  if (meta.status === 'running' || meta.status === 'pending') {
    meta.status = 'cancelled';
    meta.finishedAt = new Date().toISOString();
    meta.progressDetail = 'Cancelled';
    writeMeta(id, meta);
    return true;
  }
  return false;
}

function setProgress(id, detail) {
  const meta = readMeta(id);
  meta.progressDetail = detail;
  writeMeta(id, meta);
}

async function runJob(id) {
  if (activeJobs.has(id)) return;
  activeJobs.set(id, { cancelled: false });

  const meta = readMeta(id);
  const emails = JSON.parse(fs.readFileSync(jobPath(id, 'emails.json'), 'utf8'));
  const {
    delayMs,
    cooldownEvery,
    cooldownMs,
    streakCooldownMs,
    streakThreshold,
  } = { ...parseVerifyOptions({ emails, ...meta.settings }), emails };

  meta.status = 'running';
  meta.progressDetail = 'Starting…';
  writeMeta(id, meta);

  let consecutiveConnectionErrors = 0;
  const startIndex = meta.done;

  for (let i = startIndex; i < emails.length; i++) {
    const runner = activeJobs.get(id);
    if (!runner || runner.cancelled) {
      const cancelled = readMeta(id);
      cancelled.status = 'cancelled';
      cancelled.finishedAt = new Date().toISOString();
      cancelled.progressDetail = 'Cancelled';
      writeMeta(id, cancelled);
      activeJobs.delete(id);
      return;
    }

    setProgress(id, `Email ${i + 1} of ${emails.length}: starting ${emails[i]}`);

    let result;
    try {
      result = await verifyEmail(emails[i], {}, (progress) => {
        const detail = describeServerProgress(i, emails.length, emails[i], progress);
        setProgress(id, detail);
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

    appendResult(id, i, result);

    const current = readMeta(id);
    current.done = i + 1;
    if (current.counts[result.status] !== undefined) {
      current.counts[result.status]++;
    } else {
      current.counts.ERROR++;
    }
    current.progressDetail = i + 1 >= emails.length
      ? 'All emails processed.'
      : `Finished ${emails[i]}. Preparing next…`;
    writeMeta(id, current);

    if (isConnectionError(result)) {
      consecutiveConnectionErrors++;
      if (consecutiveConnectionErrors >= streakThreshold) {
        setProgress(id, `Rate limit pause — waiting ${streakCooldownMs / 1000}s…`);
        await sleep(streakCooldownMs);
        consecutiveConnectionErrors = 0;
      }
    } else {
      consecutiveConnectionErrors = 0;
    }

    if (i < emails.length - 1) {
      if (cooldownEvery > 0 && (i + 1) % cooldownEvery === 0) {
        setProgress(id, `Batch pause — waiting ${cooldownMs / 1000}s after ${cooldownEvery} emails…`);
        await sleep(cooldownMs);
      }

      setProgress(id, `Waiting ${delayMs / 1000}s before next email…`);
      await sleep(delayMs);
    }
  }

  const finished = readMeta(id);
  finished.status = 'completed';
  finished.finishedAt = new Date().toISOString();
  finished.progressDetail = 'Verification finished.';
  writeMeta(id, finished);
  activeJobs.delete(id);
}

function describeServerProgress(index, total, email, progress) {
  const n = index + 1;
  switch (progress.stage) {
    case 'mx_lookup':
      return `Email ${n} of ${total}: looking up MX for ${progress.domain || email}`;
    case 'smtp_connect':
      return `Email ${n} of ${total}: connecting to ${progress.mxHost} (${progress.mxIndex + 1}/${progress.mxTotal})`;
    case 'retry':
      return `Email ${n} of ${total}: retry ${progress.attempt}/${progress.maxAttempts - 1} for ${progress.mxHost}…`;
    default:
      return `Email ${n} of ${total}: working on ${email}`;
  }
}

function recoverJobsOnStartup() {
  ensureJobsDir();
  for (const id of fs.readdirSync(JOBS_DIR)) {
    const dir = path.join(JOBS_DIR, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    try {
      const meta = readMeta(id);
      if (meta.status === 'running' || meta.status === 'pending') {
        meta.status = 'interrupted';
        meta.progressDetail = 'Interrupted by server restart. Partial results saved.';
        meta.finishedAt = new Date().toISOString();
        writeMeta(id, meta);
      }
    } catch {
      /* skip */
    }
  }
}

function resultsToCsv(id) {
  const results = readResults(id, 0);
  const headers = ['#', 'Email', 'Status', 'SMTP Code', 'MX Server', 'Error', 'What it means'];

  const escape = (value) => {
    const str = value == null ? '' : String(value);
    if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  };

  const lines = [headers.map(escape).join(',')];
  results.forEach((row, i) => {
    lines.push([
      i + 1,
      row.email,
      row.status,
      row.smtpCode ?? '',
      row.mxServer ?? '',
      row.error ?? '',
      row.meaning ?? '',
    ].map(escape).join(','));
  });

  return lines.join('\r\n');
}

module.exports = {
  createJob,
  getJob,
  listJobs,
  cancelJob,
  readResults,
  resultsToCsv,
  recoverJobsOnStartup,
  parseVerifyOptions,
};
