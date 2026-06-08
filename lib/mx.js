const dns = require('dns').promises;

/**
 * Resolve and sort MX records for a domain (lowest priority number first).
 */
async function lookupMx(domain) {
  try {
    const records = await dns.resolveMx(domain);
    records.sort((a, b) => a.priority - b.priority);
    return records.map((r) => r.exchange.replace(/\.$/, ''));
  } catch {
    return [];
  }
}

module.exports = { lookupMx };
