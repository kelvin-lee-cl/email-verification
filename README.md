# SMTP Email Verification (localhost)

Verifies email addresses via DNS MX lookup and SMTP RCPT TO handshake. No email is actually sent.

## Quick start

```bash
cd email_verification
npm start
```

Open **http://127.0.0.1:3000** in your browser.

## How it works

1. Paste emails (one per line).
2. Backend extracts each domain and resolves MX records.
3. Connects to the MX server on port 25, runs `EHLO` → `MAIL FROM` → `RCPT TO` → `QUIT`.
4. Streams results to the browser with live table updates and a progress bar.
5. Export results as CSV when finished.

## Result statuses

| Status | Meaning |
|--------|---------|
| **YES** | RCPT TO accepted (250/251) — mailbox likely exists |
| **NO** | Rejected (550+) — mailbox likely does not exist |
| **UNKNOWN** | Server cannot confirm (252) — possible catch-all |
| **TEMP** | Temporary failure (450/451) — greylisting, retry later |
| **ERROR** | DNS, connection, or timeout issue |
| **INVALID** | Malformed email address |

## Configuration

SMTP settings are in `lib/smtp.js`:

- `mailFrom`: `admin@futureleadersunion.com`
- `ehloHost`: `futureleadersunion.com`
- `delayBetweenMs`: `2000` (2 seconds between checks)

## Port 25 requirement

SMTP verification needs **outbound port 25**. Many residential ISPs block this. If you see connection timeouts or errors for all domains, port 25 may be blocked on your network.

## Large batches (~4000 emails)

At 2 seconds per email, 4000 addresses takes roughly **2+ hours**. Keep the browser tab open and the server running. Use **Stop** to pause; partial results can still be exported as CSV.

## No template email needed

The handshake only uses SMTP commands (`MAIL FROM`, `RCPT TO`). No message body is sent, so no email template is required.
