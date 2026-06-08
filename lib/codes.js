/**
 * Human-readable explanations for SMTP response codes and verification outcomes.
 */
const SMTP_CODE_MEANINGS = {
  220: 'Server ready — SMTP session started successfully.',
  221: 'Session closed — server acknowledged QUIT.',
  250: 'Requested action completed — mailbox accepted for delivery.',
  251: 'User not local; server will forward — address may still be valid.',
  252: 'Cannot verify user — server cannot confirm if mailbox exists.',
  354: 'Ready to receive message data.',
  421: 'Service temporarily unavailable — try again later.',
  450: 'Mailbox temporarily unavailable — often greylisting; retry later.',
  451: 'Local error in processing — temporary failure.',
  452: 'Insufficient storage — temporary failure.',
  500: 'Syntax error — server rejected the command format.',
  501: 'Syntax error in parameters.',
  502: 'Command not implemented.',
  503: 'Bad sequence of commands.',
  521: 'Server does not accept mail.',
  530: 'Authentication required.',
  550: 'Mailbox unavailable — address likely does not exist.',
  551: 'User not local — recipient rejected.',
  552: 'Mailbox full — exists but cannot receive mail.',
  553: 'Mailbox name not allowed — invalid address format.',
  554: 'Transaction failed.',
};

const OUTCOME_MEANINGS = {
  YES: 'Mailbox appears to exist — RCPT TO was accepted (250/251).',
  NO: 'Mailbox likely does not exist or was rejected.',
  UNKNOWN: 'Server could not confirm mailbox existence (e.g. catch-all or 252).',
  TEMP: 'Temporary failure — server asked to retry later (greylisting).',
  ERROR: 'Verification could not be completed due to a connection or DNS error.',
  INVALID: 'Input is not a valid email address format.',
};

function explainSmtpCode(code) {
  if (code == null) return 'No SMTP response received.';
  return SMTP_CODE_MEANINGS[code] || `SMTP response code ${code} — see RFC 5321 for details.`;
}

function explainOutcome(result) {
  if (result.meaning) return result.meaning;
  if (OUTCOME_MEANINGS[result.status]) return OUTCOME_MEANINGS[result.status];
  if (result.smtpCode) return explainSmtpCode(result.smtpCode);
  return result.error || 'No additional details.';
}

module.exports = {
  SMTP_CODE_MEANINGS,
  OUTCOME_MEANINGS,
  explainSmtpCode,
  explainOutcome,
};
