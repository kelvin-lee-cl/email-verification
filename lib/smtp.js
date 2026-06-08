const net = require('net');
const { lookupMx } = require('./mx');
const { explainSmtpCode, explainOutcome } = require('./codes');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULTS = {
  mailFrom: 'admin@futureleadersunion.com',
  ehloHost: 'futureleadersunion.com',
  port: 25,
  connectTimeoutMs: 5000,
  timeoutMs: 12000,
  delayBetweenMs: 10000,
  retryDelayMs: 5000,
};

function isConnectionError(result) {
  return result.status === 'ERROR' && result.smtpCode == null;
}

/**
 * Buffered SMTP response reader — avoids losing data when multiple responses arrive in one chunk.
 */
function createSmtpReader(socket) {
  let buffer = '';
  const queue = [];

  const pushChunk = (chunk) => {
    buffer += chunk.toString();
    drain();
  };

  const drain = () => {
    while (queue.length > 0) {
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';

      let resolvedAt = -1;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const match = line.match(/^(\d{3})([\s-])/);
        if (!match) continue;
        if (match[2] === ' ') {
          const waiter = queue.shift();
          waiter.resolve({ code: parseInt(match[1], 10), message: line });
          resolvedAt = i;
          break;
        }
      }

      if (resolvedAt === -1) {
        buffer = lines.join('\n') + (buffer ? '\n' + buffer : '');
        break;
      }

      const remaining = lines.slice(resolvedAt + 1);
      buffer = remaining.join('\n') + (buffer ? '\n' + buffer : '');
    }
  };

  socket.on('data', pushChunk);

  return {
    read() {
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        queue.push(waiter);
        drain();
      });
    },
    destroy() {
      socket.removeListener('data', pushChunk);
    },
  };
}

function sendCommand(socket, command) {
  return new Promise((resolve, reject) => {
    socket.write(command + '\r\n', (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Perform SMTP handshake against a single MX host.
 */
async function handshakeOnHost(email, mxHost, options) {
  const { mailFrom, ehloHost, port, connectTimeoutMs, timeoutMs } = options;

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let reader = null;
    let settled = false;
    let connectTimer = null;
    let handshakeTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      if (handshakeTimer) clearTimeout(handshakeTimer);
      if (reader) reader.destroy();
      try {
        socket.write('QUIT\r\n');
      } catch {
        /* ignore */
      }
      socket.destroy();
      resolve(result);
    };

    connectTimer = setTimeout(() => {
      finish({
        mxServer: mxHost,
        smtpCode: null,
        smtpMessage: null,
        status: 'ERROR',
        error: `Could not connect to ${mxHost} within ${connectTimeoutMs / 1000}s`,
      });
    }, connectTimeoutMs);

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => finish({
      mxServer: mxHost,
      smtpCode: null,
      smtpMessage: null,
      status: 'ERROR',
      error: 'SMTP handshake timed out',
    }));

    socket.on('error', (err) => finish({
      mxServer: mxHost,
      smtpCode: null,
      smtpMessage: null,
      status: 'ERROR',
      error: err.message,
    }));

    socket.connect(port, mxHost, async () => {
      clearTimeout(connectTimer);
      connectTimer = null;

      handshakeTimer = setTimeout(() => {
        finish({
          mxServer: mxHost,
          smtpCode: null,
          smtpMessage: null,
          status: 'ERROR',
          error: `SMTP handshake timed out after ${timeoutMs / 1000}s`,
        });
      }, timeoutMs);

      reader = createSmtpReader(socket);
      try {
        const greeting = await reader.read();
        if (greeting.code !== 220) {
          finish({
            mxServer: mxHost,
            smtpCode: greeting.code,
            smtpMessage: greeting.message,
            status: 'ERROR',
            error: 'Unexpected greeting from server',
          });
          return;
        }

        await sendCommand(socket, `EHLO ${ehloHost}`);
        const ehlo = await reader.read();
        if (ehlo.code !== 250) {
          await sendCommand(socket, `HELO ${ehloHost}`);
          const helo = await reader.read();
          if (helo.code !== 250) {
            finish({
              mxServer: mxHost,
              smtpCode: helo.code,
              smtpMessage: helo.message,
              status: 'ERROR',
              error: 'EHLO/HELO rejected',
            });
            return;
          }
        }

        await sendCommand(socket, `MAIL FROM:<${mailFrom}>`);
        const mailFromResp = await reader.read();
        if (mailFromResp.code !== 250) {
          finish({
            mxServer: mxHost,
            smtpCode: mailFromResp.code,
            smtpMessage: mailFromResp.message,
            status: 'ERROR',
            error: 'MAIL FROM rejected — sender may be blocked',
          });
          return;
        }

        await sendCommand(socket, `RCPT TO:<${email}>`);
        const rcpt = await reader.read();
        const status = classifyRcptResponse(rcpt.code);

        finish({
          mxServer: mxHost,
          smtpCode: rcpt.code,
          smtpMessage: rcpt.message,
          status,
          error: status === 'ERROR' || status === 'NO' ? rcpt.message : null,
        });
      } catch (err) {
        finish({
          mxServer: mxHost,
          smtpCode: null,
          smtpMessage: null,
          status: 'ERROR',
          error: err.message,
        });
      }
    });
  });
}

function classifyRcptResponse(code) {
  if (code === 250 || code === 251) return 'YES';
  if (code === 252) return 'UNKNOWN';
  if (code === 450 || code === 451 || code === 452 || code === 421) return 'TEMP';
  if (code >= 500) return 'NO';
  return 'ERROR';
}

function parseEmail(raw) {
  const email = raw.trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return { valid: false, email: raw.trim() };
  }
  const domain = email.split('@')[1];
  return { valid: true, email, domain };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function emitProgress(onProgress, payload) {
  if (typeof onProgress === 'function') {
    onProgress(payload);
  }
}

/**
 * Verify a single email: MX lookup then SMTP RCPT TO handshake.
 */
async function verifyEmail(rawEmail, options = {}, onProgress) {
  const opts = { ...DEFAULTS, ...options };
  const parsed = parseEmail(rawEmail);

  if (!parsed.valid) {
    emitProgress(onProgress, { stage: 'invalid', email: parsed.email || rawEmail });
    return {
      email: parsed.email || rawEmail,
      domain: null,
      mxServer: null,
      smtpCode: null,
      smtpMessage: null,
      status: 'INVALID',
      error: 'Invalid email format',
      meaning: explainOutcome({ status: 'INVALID' }),
    };
  }

  emitProgress(onProgress, { stage: 'mx_lookup', email: parsed.email, domain: parsed.domain });

  const mxHosts = await lookupMx(parsed.domain);
  if (mxHosts.length === 0) {
    return {
      email: parsed.email,
      domain: parsed.domain,
      mxServer: null,
      smtpCode: null,
      smtpMessage: null,
      status: 'ERROR',
      error: 'No MX records found for domain',
      meaning: 'Domain has no mail servers configured — email cannot be delivered.',
    };
  }

  let lastResult = null;
  for (let mxIndex = 0; mxIndex < mxHosts.length; mxIndex++) {
    const mxHost = mxHosts[mxIndex];
    emitProgress(onProgress, {
      stage: 'smtp_connect',
      email: parsed.email,
      domain: parsed.domain,
      mxHost,
      mxIndex,
      mxTotal: mxHosts.length,
    });

    lastResult = await handshakeOnHost(parsed.email, mxHost, opts);

    if (isConnectionError(lastResult)) {
      emitProgress(onProgress, {
        stage: 'retry',
        email: parsed.email,
        domain: parsed.domain,
        mxHost,
        mxIndex,
        mxTotal: mxHosts.length,
        waitMs: opts.retryDelayMs,
      });
      await sleep(opts.retryDelayMs);
      lastResult = await handshakeOnHost(parsed.email, mxHost, {
        ...opts,
        connectTimeoutMs: opts.connectTimeoutMs * 2,
      });
    }

    if (lastResult.status === 'YES' || lastResult.status === 'UNKNOWN') break;
    if (lastResult.status === 'TEMP') break;
    if (lastResult.status === 'NO' && lastResult.smtpCode >= 550) break;
    if (isConnectionError(lastResult)) break;
  }

  return {
    email: parsed.email,
    domain: parsed.domain,
    ...lastResult,
    meaning: buildMeaning(lastResult),
  };
}

function buildMeaning(result) {
  if (result.status === 'YES') return explainOutcome({ status: 'YES' });
  if (result.status === 'NO') {
    const codePart = result.smtpCode ? explainSmtpCode(result.smtpCode) : '';
    return `${explainOutcome({ status: 'NO' })} ${codePart}`.trim();
  }
  if (result.status === 'UNKNOWN') return explainOutcome({ status: 'UNKNOWN' });
  if (result.status === 'TEMP') {
    return `${explainOutcome({ status: 'TEMP' })} ${explainSmtpCode(result.smtpCode)}`;
  }
  if (result.error) return result.error;
  return explainOutcome({ status: 'ERROR' });
}

module.exports = {
  verifyEmail,
  parseEmail,
  sleep,
  isConnectionError,
  DEFAULTS,
};
