const DELAY_MS = 2000;
const PER_EMAIL_MS = 7000;

const emailInput = document.getElementById('emailInput');
const lineCountEl = document.getElementById('lineCount');
const etaEl = document.getElementById('eta');
const verifyBtn = document.getElementById('verifyBtn');
const stopBtn = document.getElementById('stopBtn');
const exportBtn = document.getElementById('exportBtn');
const clearBtn = document.getElementById('clearBtn');
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

let abortController = null;
let results = [];
let counts = { YES: 0, NO: 0, UNKNOWN: 0, TEMP: 0, ERROR: 0, INVALID: 0 };
let port25Open = null;

function formatDuration(seconds) {
  if (seconds < 60) return `~${seconds}s`;
  if (seconds < 3600) return `~${Math.ceil(seconds / 60)} min`;
  return `~${(seconds / 3600).toFixed(1)} hours`;
}

function updateLineCount() {
  const emails = parseEmails(emailInput.value);
  const n = emails.length;
  lineCountEl.textContent = `${n.toLocaleString()} email${n === 1 ? '' : 's'}`;

  if (n === 0) {
    etaEl.textContent = '—';
    return;
  }

  const perEmail = port25Open === false ? 5000 : PER_EMAIL_MS;
  const seconds = Math.ceil((n * perEmail + Math.max(0, n - 1) * DELAY_MS) / 1000);
  etaEl.textContent = formatDuration(seconds);
}

function parseEmails(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
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
    setNetworkBanner(
      'blocked',
      'Could not check port 25',
      err.message
    );
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

function describeProgress(msg) {
  const n = msg.index + 1;
  const email = msg.email || '';

  switch (msg.stage) {
    case 'starting':
      return `Email ${n} of ${msg.total}: starting ${email}`;
    case 'mx_lookup':
      return `Email ${n} of ${msg.total}: looking up MX records for ${msg.domain || email}`;
    case 'smtp_connect':
      return `Email ${n} of ${msg.total}: connecting to ${msg.mxHost} (${msg.mxIndex + 1}/${msg.mxTotal})`;
    case 'waiting':
      return `Waiting ${Math.round((msg.delayMs || DELAY_MS) / 1000)}s before next email…`;
    case 'invalid':
      return `Email ${n}: invalid format — ${email}`;
    default:
      return `Email ${n} of ${msg.total}: working on ${email}`;
  }
}

function setProgressDetail(text) {
  progressDetail.textContent = text || '';
}

function resetResults() {
  results = [];
  counts = { YES: 0, NO: 0, UNKNOWN: 0, TEMP: 0, ERROR: 0, INVALID: 0 };
  resultsBody.innerHTML = '';
  summary.hidden = true;
  exportBtn.disabled = true;
  setProgressDetail('');
  updateSummary();
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
  tr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function updateProgress(done, total, label) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  progressFill.style.width = `${pct}%`;
  progressCount.textContent = `${done.toLocaleString()} / ${total.toLocaleString()}`;
  if (label) {
    progressLabel.textContent = label;
  } else {
    progressLabel.textContent = done >= total ? 'Complete' : 'Verifying…';
  }
}

function csvEscape(value) {
  const str = value == null ? '' : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function exportCsv() {
  if (results.length === 0) return;

  const headers = ['#', 'Email', 'Status', 'SMTP Code', 'MX Server', 'Error', 'What it means'];
  const lines = [headers.map(csvEscape).join(',')];

  results.forEach((row, i) => {
    lines.push([
      i + 1,
      row.email,
      row.status,
      row.smtpCode ?? '',
      row.mxServer ?? '',
      row.error ?? '',
      row.meaning ?? '',
    ].map(csvEscape).join(','));
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

async function startVerification() {
  const emails = parseEmails(emailInput.value);
  if (emails.length === 0) {
    alert('Paste at least one email address (one per line).');
    return;
  }

  resetResults();
  abortController = new AbortController();

  verifyBtn.disabled = true;
  stopBtn.disabled = false;
  exportBtn.disabled = true;
  progressSection.hidden = false;
  updateProgress(0, emails.length, 'Starting…');
  setProgressDetail('Connecting to server…');

  try {
    const response = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails, delayMs: DELAY_MS }),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Server error (${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);

        if (msg.type === 'start') {
          updateProgress(0, msg.total, 'Verifying…');
          if (msg.port25Open === false && port25Open !== false) {
            port25Open = false;
            setNetworkBanner(
              'blocked',
              'Port 25 is blocked on this network',
              'SMTP connections are failing. Run this tool on a VPS or server with open port 25 for real results.'
            );
            updateLineCount();
          }
        } else if (msg.type === 'progress') {
          setProgressDetail(describeProgress(msg));
          if (msg.stage === 'starting') {
            updateProgress(msg.index, msg.total, `Checking email ${msg.index + 1} of ${msg.total}`);
          }
        } else if (msg.type === 'result') {
          const row = {
            email: msg.email,
            status: msg.status,
            smtpCode: msg.smtpCode,
            mxServer: msg.mxServer,
            error: msg.error,
            meaning: msg.meaning,
          };
          results.push(row);
          if (counts[row.status] !== undefined) {
            counts[row.status]++;
          } else {
            counts.ERROR++;
          }
          addResultRow(msg.index, row);
          summary.hidden = false;
          updateSummary();
          updateProgress(msg.index + 1, msg.total);
          setProgressDetail(
            msg.index + 1 >= msg.total
              ? 'All emails processed.'
              : `Finished ${msg.email}. Preparing next…`
          );
        } else if (msg.type === 'done') {
          updateProgress(msg.total, msg.total, 'Complete');
          setProgressDetail('Verification finished.');
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      alert(`Verification failed: ${err.message}`);
    }
  } finally {
    verifyBtn.disabled = false;
    stopBtn.disabled = true;
    abortController = null;
    if (results.length > 0) {
      exportBtn.disabled = false;
    }
  }
}

function stopVerification() {
  if (abortController) {
    abortController.abort();
  }
  stopBtn.disabled = true;
  verifyBtn.disabled = false;
  progressLabel.textContent = 'Stopped';
  setProgressDetail('Verification stopped.');
  if (results.length > 0) {
    exportBtn.disabled = false;
  }
}

emailInput.addEventListener('input', updateLineCount);
verifyBtn.addEventListener('click', startVerification);
stopBtn.addEventListener('click', stopVerification);
exportBtn.addEventListener('click', exportCsv);
clearBtn.addEventListener('click', () => {
  if (abortController) stopVerification();
  emailInput.value = '';
  resetResults();
  progressSection.hidden = true;
  setProgressDetail('');
  updateLineCount();
});

loadNetworkStatus();
updateLineCount();
