/**
 * Ask Danny — send a product update to the list.
 *
 *   POST /api/broadcast   x-admin-token: <ADMIN_TOKEN>
 *   { "subject": "...", "body": "plain text, blank line between paragraphs",
 *     "dryRun": true, "testTo": "you@example.com" }
 *
 * Nothing here can run by accident. It needs an admin token AND a configured
 * mail provider, it defaults to a dry run, and every send is one-at-a-time so a
 * failure part way through cannot be mistaken for a success.
 *
 * Env:
 *   ADMIN_TOKEN      required, the same one /api/subscribers uses
 *   RESEND_API_KEY   required to actually send (https://resend.com, free tier)
 *   MAIL_FROM        e.g. "Ask Danny <updates@diagnostechai.com>"
 *                    The domain must be verified with the provider first.
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const SITE = 'https://diagnostechai.com';
const RESEND_URL = 'https://api.resend.com/emails';
const SEND_GAP_MS = 120;      // stay well under provider rate limits
const MAX_SUBJECT = 160;
const MAX_BODY = 20000;

function adminOk(event) {
  const admin = process.env.ADMIN_TOKEN;
  const given = (event.headers['x-admin-token'] || '').trim();
  // An unset ADMIN_TOKEN must not become a password of "".
  if (!admin || !given || given.length !== admin.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(admin));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render(bodyText, unsubUrl) {
  const paras = String(bodyText).split(/\n{2,}/).map(p =>
    `<p style="margin:0 0 16px;line-height:1.6">${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`
  ).join('');

  return `<!doctype html><html><body style="margin:0;background:#faf9f5;padding:24px;
font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a18">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e4e3dc;
border-radius:14px;padding:32px">
  <div style="font-weight:700;font-size:18px;margin-bottom:22px">Ask Danny</div>
  ${paras}
  <hr style="border:0;border-top:1px solid #e4e3dc;margin:28px 0 16px">
  <p style="margin:0;font-size:12px;color:#7a7a72;line-height:1.5">
    You are getting this because you signed up for Ask Danny updates at
    <a href="${SITE}" style="color:#7a7a72">diagnostechai.com</a>.<br>
    <a href="${unsubUrl}" style="color:#7a7a72">Unsubscribe</a> — one click, takes effect immediately.
  </p>
</div></body></html>`;
}

function plain(bodyText, unsubUrl) {
  return `${bodyText}\n\n---\nYou are getting this because you signed up for Ask Danny `
    + `updates at ${SITE}.\nUnsubscribe: ${unsubUrl}\n`;
}

async function sendOne(apiKey, from, to, subject, bodyText, unsubUrl) {
  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from, to: [to], subject,
      html: render(bodyText, unsubUrl),
      text: plain(bodyText, unsubUrl),
      // Lets mail clients show their own unsubscribe button and honour a
      // one-click POST. Without these, updates land in spam far more often.
      headers: {
        'List-Unsubscribe': `<${unsubUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error?.message || `Resend ${res.status}`);
  return data.id || 'sent';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };
  const json = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });

  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  // 404 rather than 401: an admin endpoint should not confirm it exists.
  if (!adminOk(event)) return json(404, { error: 'Not found' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON.' }); }

  const subject = String(body.subject || '').trim().slice(0, MAX_SUBJECT);
  const text = String(body.body || '').trim().slice(0, MAX_BODY);
  if (!subject || !text) return json(400, { error: 'Both subject and body are required.' });

  // Default true. A missing flag must not mean "mail everyone".
  const dryRun = body.dryRun !== false;
  const testTo = body.testTo ? String(body.testTo).trim().toLowerCase() : null;

  let s;
  try { s = getStore({ name: 'subscribers', consistency: 'strong' }); }
  catch { return json(503, { error: 'Subscriber store unavailable.' }); }

  const recipients = [];
  try {
    const { blobs } = await s.list();
    for (const b of blobs) {
      const rec = await s.get(b.key, { type: 'json' });
      if (rec && rec.status === 'subscribed' && rec.email) {
        recipients.push({ email: rec.email, unsubToken: rec.unsubToken });
      }
    }
  } catch { return json(503, { error: 'Could not read the subscriber list.' }); }

  const targets = testTo
    ? recipients.filter(r => r.email === testTo)
    : recipients;

  if (testTo && !targets.length) {
    return json(400, { error: `${testTo} is not an active subscriber, so nothing was sent.` });
  }

  if (dryRun) {
    return json(200, {
      dryRun: true,
      wouldSend: targets.length,
      subject,
      sample: targets.slice(0, 3).map(r => r.email),
      note: 'Nothing was sent. Pass "dryRun": false to send for real.',
    });
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!apiKey || !from) {
    return json(503, {
      error: 'Sending is not configured yet.',
      needs: ['RESEND_API_KEY', 'MAIL_FROM'],
      hint: 'Create a key at resend.com and verify the sending domain, then set both as Netlify environment variables.',
    });
  }

  const sent = [], failed = [];
  for (const r of targets) {
    const unsubUrl = `${SITE}/api/unsubscribe?t=${encodeURIComponent(r.unsubToken)}`;
    try {
      await sendOne(apiKey, from, r.email, subject, text, unsubUrl);
      sent.push(r.email);
    } catch (e) {
      // Keep going. One bad address must not stop the rest of the list.
      failed.push({ email: r.email, error: String(e.message).slice(0, 140) });
    }
    await sleep(SEND_GAP_MS);
  }

  return json(200, { dryRun: false, sent: sent.length, failed: failed.length, failures: failed.slice(0, 10) });
};
