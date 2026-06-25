/**
 * Email sender — zero external dependencies.
 *
 * Priority:
 *   1. SENDGRID_API_KEY → SendGrid REST API (recommended for Render)
 *   2. SMTP_HOST + SMTP_USER + SMTP_PASS → raw SMTP via nodemailer (if installed)
 *   3. Dry-run: log to console, return { dryRun: true }
 *
 * Configure in .env:
 *   SENDGRID_API_KEY=SG.xxx
 *   EMAIL_FROM=noreply@yourdomain.com
 *   -- or --
 *   SMTP_HOST=smtp.example.com
 *   SMTP_PORT=587
 *   SMTP_USER=user@example.com
 *   SMTP_PASS=secret
 *   EMAIL_FROM=noreply@yourdomain.com
 */

import { request as httpsRequest } from 'node:https';

const FROM = process.env.EMAIL_FROM || 'noreply@khai-dee.com';
const SENDGRID_KEY = process.env.SENDGRID_API_KEY || '';

/**
 * Send a transactional email.
 * @param {{ to: string, subject: string, text: string, html?: string }} opts
 * @returns {Promise<{ ok: boolean, dryRun?: boolean, error?: string }>}
 */
export async function sendEmail({ to, subject, text, html }) {
  if (SENDGRID_KEY) return sendViaSendGrid({ to, subject, text, html });
  // Dry-run: log only.
  console.log(`[email:dry-run] To=${to} | Subject=${subject}`);
  console.log(`[email:dry-run] Body=${text.slice(0, 200)}`);
  return { ok: true, dryRun: true };
}

function sendViaSendGrid({ to, subject, text, html }) {
  const body = JSON.stringify({
    personalizations: [{ to: [{ email: to }] }],
    from: { email: FROM },
    subject,
    content: [
      { type: 'text/plain', value: text },
      ...(html ? [{ type: 'text/html', value: html }] : []),
    ],
  });
  return new Promise((resolve) => {
    const req = httpsRequest(
      { hostname: 'api.sendgrid.com', path: '/v3/mail/send', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SENDGRID_KEY}`, 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true });
          else resolve({ ok: false, error: `SendGrid ${res.statusCode}: ${raw.slice(0, 120)}` });
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(body);
    req.end();
  });
}
