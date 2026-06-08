const PER_EMAIL_MS = 12000;
const POLL_MS = 3000;
const ACTIVE_JOB_KEY = 'emailVerificationActiveJobId';

const emailInput = document.getElementById('emailInput');
const lineCountEl = document.getElementById('lineCount');
const etaEl = document.getElementById('eta');
const delaySelect = document.getElementById('delaySelect');
const slowModeCheck = document.getElementById('slowModeCheck');
const autoStartCheck = document.getElementById('autoStartCheck');
const csvUpload = document.getElementById('csvUpload');
const uploadHint = document.getElementById('uploadHint');
const verifyBtn = document.getElementById('verifyBtn');
const stopBtn = document.getElementById('stopBtn');
const exportBtn = document.getElementById('exportBtn');
const clearBtn = document.getElementById('clearBtn');
const jobsList = document.getElementById('jobsList');
const networkBanner = document.getElementById('networkBanner');
const networkBannerTitle = document.getElementById('networkBannerTitle');
const networkBannerText = document.getElementById('networkBannerText');
const progressSection = document.getElementById('progressSection');
const progressLabel = document.getElementById('progressLabel');
const progressCount = document.getElementById('progressCount');
const progressFill = document.getElementById('progressFill');
const progressDetail = document.getElementById('progressDetail');
const resultsBody = document.getElementById('resultsBody');
const summary = document.getElementById('summary');
const countYes = document.getElementById('countYes');
const countNo = document.getElementById('countNo');
const countUnknown = document.getElementById('countUnknown');
const countTemp = document.getElementById('countTemp');
const countError = document.getElementById('countError');

let activeJobId = null;
let pollTimer = null;
let loadedResultCount = 0;
let results = [];
let counts = { YES: 0, NO: 0, UNKNOWN: 0, TEMP: 0, ERROR: 0, INVALID: 0 };
let port25Open = null;

function getDelayMs() {
  return parseInt(delaySelect.value, 10) || 15000;
}

function getCooldownSettings() {
  if (!slowModeCheck.checked) {
    return { cooldownEvery: 0, cooldownMs: 0 };
  }
  const delayMs = getDelayMs();
  if (delayMs >= 30000) {
    return { cooldownEvery: 5, cooldownMs: 120000 };
  }
  return { cooldownEvery: 8, cooldownMs: 90000 };
}

function formatDuration(seconds) {
  if (seconds < 60) return `~${seconds}s`;
  if (seconds < 3600) return `~${Math.ceil(seconds / 60)} min`;
  return `~${(seconds / 3600).toFixed(1)} hours`;
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function updateLineCount() {
  const emails = parseEmails(emailInput.value);
  const n = emails.length;
  lineCountEl.textContent = `${n.toLocaleString()} email${n === 1 ? '' : 's'}`;

  if (n === 0) {
    etaEl.textContent = '—';
    return;
  }

  const delayMs = getDelayMs();
  const perEmail = port25Open === false ? 5000 : PER_EMAIL_MS;
  const { cooldownEvery, cooldownMs } = getCooldownSettings();
  const batchPauses = cooldownEvery > 0 ? Math.floor(Math.max(0, n - 1) / cooldownEvery) : 0;
  const seconds = Math.ceil(
    (n * perEmail + Math.max(0, n - 1) * delayMs + batchPauses * cooldownMs) / 1000
  );
  etaEl.textContent = formatDuration(seconds);
}

function parseEmails(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

function extractEmailFromCell(value) {
  if (!value) return null;
  const match = value.match(/[^\s,;"<>]+@[^\s,;"<>]+\.[^\s,;"<>]+/);
  return match ? match[0].trim().toLowerCase() : null;
}

function parseCsvEmails(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) return [];

  const header = parseCsvLine(lines[0]);
  let emailColIndex = header.findIndex((h) => /email/i.test(h));
  const isHeader = emailColIndex !== -1 || !extractEmailFromCell(header[0]);

  const emails = [];
  const seen = new Set();
  const startRow = isHeader ? 1 : 0;

  if (isHeader && emailColIndex === -1) {
    emailColIndex = 0;
  }

  for (let i = startRow; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    let email = null;

    if (isHeader && emailColIndex < cols.length) {
      email = extractEmailFromCell(cols[emailColIndex]);
    } else {
      for (const col of cols) {
        email = extractEmailFromCell(col);
        if (email) break;
      }
    }

    if (email && !seen.has(email)) {
      seen.add(email);
      emails.push(email);
    }
  }

  return emails;
}

function setNetworkBanner(state, title, text) {
  networkBanner.hidden = false;
  networkBanner.className = `network-banner ${state}`;
  networkBannerTitle.textContent = title;
  networkBannerText.textContent = text;
}

async function loadNetworkStatus() {
  setNetworkBanner(
    'checking',
    'Checking outbound port 25…',
    'SMTP verification needs TCP port 25. This usually takes a few seconds.'
  );

  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error('Could not load server status');
    const data = await response.json();
    port25Open = data.port25?.open;

    if (port25Open === true) {
      networkBanner.hidden = true;
    } else if (port25Open === false) {
      setNetworkBanner(
        'blocked',
        'Port 25 is blocked on this network',
        `Could not reach ${data.port25.host}:${data.port25.port}. Verification will likely return errors for every email. Run this tool on a VPS or server with open port 25 for real results.`
      );
    } else {
      setNetworkBanner(
        'checking',
        'Port 25 check still running…',
        'You can start verification, but results may fail until the check completes.'
      );
      pollNetworkStatus();
    }
  } catch (err) {
    setNetworkBanner('blocked', 'Could not check port 25', err.message);
  }

  updateLineCount();
}

async function pollNetworkStatus(attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const response = await fetch('/api/status');
      if (!response.ok) continue;
      const data = await response.json();
      if (data.port25?.open === null) continue;

      port25Open = data.port25.open;
      if (port25Open) {
        networkBanner.hidden = true;
      } else {
        setNetworkBanner(
          'blocked',
          'Port 25 is blocked on this network',
          `Could not reach ${data.port25.host}:${data.port25.port}. Verification will likely return errors for every email. Run this tool on a VPS or server with open port 25 for real results.`
        );
      }
      updateLineCount();
      return;
    } catch {
      /* retry */
    }
  }
}

function setProgressDetail(text) {
  progressDetail.textContent = text || '';
}

function resetResults() {
  results = [];
  loadedResultCount = 0;
  counts = { YES: 0, NO: 0, UNKNOWN: 0, TEMP: 0, ERROR: 0, INVALID: 0 };
  resultsBody.innerHTML = '';
  summary.hidden = true;
  exportBtn.disabled = true;
  setProgressDetail('');
  updateSummary();
}

function applyCountsFromMeta(metaCounts) {
  counts = { ...emptyCounts(), ...metaCounts };
  updateSummary();
  summary.hidden = results.length === 0;
}

function emptyCounts() {
  return { YES: 0, NO: 0, UNKNOWN: 0, TEMP: 0, ERROR: 0, INVALID: 0 };
}

function updateSummary() {
  countYes.textContent = `YES: ${counts.YES}`;
  countNo.textContent = `NO: ${counts.NO}`;
  countUnknown.textContent = `UNKNOWN: ${counts.UNKNOWN}`;
  countTemp.textContent = `TEMP: ${counts.TEMP}`;
  countError.textContent = `ERROR: ${counts.ERROR + counts.INVALID}`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function addResultRow(index, row) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${index + 1}</td>
    <td class="mono">${escapeHtml(row.email)}</td>
    <td><span class="status-pill ${row.status}">${row.status}</span></td>
    <td class="mono">${row.smtpCode ?? '—'}</td>
    <td class="mono">${escapeHtml(row.mxServer) || '—'}</td>
    <td>${escapeHtml(row.error) || '—'}</td>
    <td class="meaning">${escapeHtml(row.meaning) || '—'}</td>
  `;
  resultsBody.appendChild(tr);

  if (results.length <= 50 || results.length % 25 === 0) {
    tr.scrollIntoView({ behavior: results.length <= 50 ? 'smooth' : 'auto', block: 'nearest' });
  }
}

function updateProgress(done, total, label) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  progressFill.style.width = `${pct}%`;
  progressCount.textContent = `${done.toLocaleString()} / ${total.toLocaleString()}`;
  progressLabel.textContent = label || (done >= total ? 'Complete' : 'Verifying…');
}

function setFormDisabled(disabled) {
  verifyBtn.disabled = disabled;
  stopBtn.disabled = !disabled;
  delaySelect.disabled = disabled;
  slowModeCheck.disabled = disabled;
  csvUpload.disabled = disabled;
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function isJobActive(status) {
  return status === 'running' || status === 'pending';
}

async function fetchJob(jobId) {
  const response = await fetch(`/api/jobs/${jobId}`);
  if (!response.ok) throw new Error('Job not found');
  return response.json();
}

async function fetchNewResults(jobId) {
  if (loadedResultCount === 0 && results.length > 0) {
    loadedResultCount = results.length;
  }

  const response = await fetch(`/api/jobs/${jobId}/results?offset=${loadedResultCount}`);
  if (!response.ok) throw new Error('Could not load results');
  const data = await response.json();
  return data.results || [];
}

function ingestResults(rows) {
  for (const row of rows) {
    results.push(row);
    addResultRow(row.index, row);
  }
  if (rows.length > 0) {
    summary.hidden = false;
    exportBtn.disabled = false;
  }
}

async function refreshJobView(job, { fullReload = false } = {}) {
  if (fullReload) {
    resetResults();
    const all = await fetch(`/api/jobs/${job.id}/results?offset=0`).then((r) => r.json());
    loadedResultCount = 0;
    ingestResults(all.results || []);
    loadedResultCount = job.done;
  } else if (job.done > loadedResultCount) {
    const newRows = await fetchNewResults(job.id);
    ingestResults(newRows);
    loadedResultCount = job.done;
  }

  applyCountsFromMeta(job.counts || emptyCounts());
  updateProgress(job.done, job.total, isJobActive(job.status) ? 'Verifying…' : job.status);
  setProgressDetail(job.progressDetail || '');
  progressSection.hidden = false;
}

async function pollActiveJob() {
  if (!activeJobId) return;

  try {
    const job = await fetchJob(activeJobId);
    await refreshJobView(job);
    renderJobsList(await listJobsCached());

    if (isJobActive(job.status)) {
      pollTimer = setTimeout(pollActiveJob, POLL_MS);
    } else {
      setFormDisabled(false);
      localStorage.removeItem(ACTIVE_JOB_KEY);
      if (job.status === 'completed') {
        updateProgress(job.total, job.total, 'Complete');
        setProgressDetail('Verification finished. Export CSV or download from job list.');
      }
    }
  } catch (err) {
    console.error(err);
    pollTimer = setTimeout(pollActiveJob, POLL_MS * 2);
  }
}

async function listJobsCached() {
  const response = await fetch('/api/jobs');
  if (!response.ok) return [];
  const data = await response.json();
  return data.jobs || [];
}

function renderJobsList(jobs) {
  if (!jobs.length) {
    jobsList.innerHTML = '<p class="jobs-empty">No jobs yet.</p>';
    return;
  }

  jobsList.innerHTML = jobs.map((job) => {
    const shortId = job.id.slice(0, 8);
    const activeClass = job.id === activeJobId ? ' active' : '';
    const canDownload = job.done > 0;
    return `
      <div class="job-card${activeClass}" data-job-id="${job.id}">
        <div class="job-card-main">
          <span class="job-card-id">${shortId}… · ${formatTime(job.createdAt)}</span>
          <span class="job-card-meta">
            <span class="job-status ${job.status}">${job.status}</span>
            ${job.done.toLocaleString()} / ${job.total.toLocaleString()} emails
          </span>
        </div>
        <div class="job-card-actions">
          <button type="button" class="btn secondary job-view-btn" data-job-id="${job.id}">View</button>
          ${canDownload ? `<a class="btn secondary" href="/api/jobs/${job.id}/download">Download CSV</a>` : ''}
          ${isJobActive(job.status) ? `<button type="button" class="btn ghost job-cancel-btn" data-job-id="${job.id}">Cancel</button>` : ''}
        </div>
      </div>
    `;
  }).join('');

  jobsList.querySelectorAll('.job-view-btn').forEach((btn) => {
    btn.addEventListener('click', () => attachToJob(btn.dataset.jobId, { fullReload: true }));
  });

  jobsList.querySelectorAll('.job-cancel-btn').forEach((btn) => {
    btn.addEventListener('click', () => cancelJob(btn.dataset.jobId));
  });
}

async function attachToJob(jobId, { fullReload = false } = {}) {
  stopPolling();
  activeJobId = jobId;
  localStorage.setItem(ACTIVE_JOB_KEY, jobId);

  try {
    const job = await fetchJob(jobId);
    await refreshJobView(job, { fullReload });
    renderJobsList(await listJobsCached());

    if (isJobActive(job.status)) {
      setFormDisabled(true);
      pollTimer = setTimeout(pollActiveJob, POLL_MS);
    } else {
      setFormDisabled(false);
    }
  } catch (err) {
    alert(`Could not load job: ${err.message}`);
    activeJobId = null;
    localStorage.removeItem(ACTIVE_JOB_KEY);
  }
}

async function cancelJob(jobId) {
  try {
    await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
    if (jobId === activeJobId) {
      const job = await fetchJob(jobId);
      await refreshJobView(job);
      setFormDisabled(false);
      stopPolling();
      localStorage.removeItem(ACTIVE_JOB_KEY);
    }
    renderJobsList(await listJobsCached());
  } catch (err) {
    alert(`Could not cancel job: ${err.message}`);
  }
}

async function startVerification() {
  const emails = parseEmails(emailInput.value);
  if (emails.length === 0) {
    alert('Paste at least one email address or upload a CSV file.');
    return;
  }

  if (activeJobId) {
    const existing = await fetchJob(activeJobId).catch(() => null);
    if (existing && isJobActive(existing.status)) {
      alert('A job is already running. View it in Background jobs or cancel it first.');
      return;
    }
  }

  const delayMs = getDelayMs();

  try {
    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails, delayMs, ...getCooldownSettings() }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Server error (${response.status})`);
    }

    const data = await response.json();
    resetResults();
    setFormDisabled(true);
    progressSection.hidden = false;
    updateProgress(0, emails.length, 'Starting…');
    setProgressDetail(`Background job started for ${emails.length.toLocaleString()} emails.`);

    await attachToJob(data.jobId, { fullReload: true });
    renderJobsList(await listJobsCached());
  } catch (err) {
    alert(`Could not start job: ${err.message}`);
    setFormDisabled(false);
  }
}

function stopVerification() {
  if (activeJobId) {
    cancelJob(activeJobId);
  }
}

function exportCsv() {
  if (activeJobId) {
    window.location.href = `/api/jobs/${activeJobId}/download`;
    return;
  }

  if (results.length === 0) return;

  const headers = ['#', 'Email', 'Status', 'SMTP Code', 'MX Server', 'Error', 'What it means'];
  const escape = (value) => {
    const str = value == null ? '' : String(value);
    if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  };

  const lines = [headers.map(escape).join(',')];
  results.forEach((row, i) => {
    lines.push([
      i + 1, row.email, row.status, row.smtpCode ?? '', row.mxServer ?? '',
      row.error ?? '', row.meaning ?? '',
    ].map(escape).join(','));
  });

  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.href = url;
  a.download = `email-verification-${stamp}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

async function handleCsvUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  uploadHint.textContent = `Reading ${file.name}…`;

  try {
    const text = await file.text();
    const emails = parseCsvEmails(text);

    if (emails.length === 0) {
      alert('No email addresses found in this CSV.');
      uploadHint.textContent = 'No emails found — try a column named “Email” or one email per line';
      return;
    }

    emailInput.value = emails.join('\n');
    updateLineCount();
    uploadHint.textContent = `Loaded ${emails.length.toLocaleString()} unique emails from ${file.name}`;

    if (autoStartCheck.checked) {
      await startVerification();
    }
  } catch (err) {
    alert(`Could not read CSV: ${err.message}`);
    uploadHint.textContent = 'CSV upload failed';
  } finally {
    csvUpload.value = '';
  }
}

async function initJobs() {
  const jobs = await listJobsCached();
  renderJobsList(jobs);

  const savedId = localStorage.getItem(ACTIVE_JOB_KEY);
  const running = jobs.find((j) => isJobActive(j.status));
  const attachId = savedId || running?.id;

  if (attachId) {
    await attachToJob(attachId, { fullReload: true });
  }
}

emailInput.addEventListener('input', updateLineCount);
delaySelect.addEventListener('change', updateLineCount);
slowModeCheck.addEventListener('change', updateLineCount);
verifyBtn.addEventListener('click', startVerification);
stopBtn.addEventListener('click', stopVerification);
exportBtn.addEventListener('click', exportCsv);
csvUpload.addEventListener('change', handleCsvUpload);
clearBtn.addEventListener('click', () => {
  stopPolling();
  activeJobId = null;
  localStorage.removeItem(ACTIVE_JOB_KEY);
  emailInput.value = '';
  uploadHint.textContent = 'CSV with an “Email” column, or one email per line';
  resetResults();
  progressSection.hidden = true;
  setFormDisabled(false);
  updateLineCount();
  renderJobsList([]);
  listJobsCached().then(renderJobsList);
});

loadNetworkStatus();
updateLineCount();
initJobs();
