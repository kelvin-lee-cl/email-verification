const net = require('net');

const PROBE_HOST = 'gmail-smtp-in.l.google.com';
const PROBE_PORT = 25;
const PROBE_TIMEOUT_MS = 5000;

/**
 * Test whether outbound TCP to port 25 is reachable from this machine.
 */
function checkPort25Open(options = {}) {
  const host = options.host || PROBE_HOST;
  const port = options.port || PROBE_PORT;
  const timeoutMs = options.timeoutMs || PROBE_TIMEOUT_MS;

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        open: false,
        host,
        port,
        error: `Connection to ${host}:${port} timed out after ${timeoutMs / 1000}s`,
      });
    }, timeoutMs);

    socket.once('error', (err) => {
      finish({ open: false, host, port, error: err.message });
    });

    socket.connect(port, host, () => {
      finish({ open: true, host, port, error: null });
    });
  });
}

module.exports = { checkPort25Open, PROBE_HOST, PROBE_PORT };
