/**
 * Ask Danny — product update list.
 *
 *   POST /api/subscribe        { email, source }   -> add an address
 *   GET  /api/unsubscribe?t=.. one click, no login -> remove it
 *   GET  /api/subscribers      (admin)             -> export the list
 *
 * Three rules this endpoint exists to enforce, because a mailing list that
 * breaks any of them is a liability rather than an asset:
 *
 *   1. Nobody is added without asking. There is no import path and no bulk
 *      add — an address gets here because a person typed it into the box and
 *      ticked the consent box, and what they agreed to is stored with it.
 *   2. Unsubscribe always works, in one click, with no account and no login.
 *      The token is in the link. That is a legal requirement under CAN-SPAM
 *      and the right thing regardless.
 *   3. The list is never readable without the admin token, so a leak of the
 *      site does not leak everyone's address.
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const SUBSCRIBE_LIMIT = 5;        // per IP
const SUBSCRIBE_WINDOW = 3600;    // per hour
const MAX_EMAIL_LEN = 254;        // RFC 5321

// Deliberately conservative. A rejected valid address is a lost subscriber; an
// accepted invalid one is a bounce that damages sending reputation for everyone
// else on the list.
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,63}$/;

const ALLOWED_ORIGINS = [
  'https://diagnostechai.com',
  'https://www.diagnostechai.com',
  'https://ask-danny.netlify.app',
];

// What the person actually agreed to, stored verbatim with their address. If
// anyone ever asks why they are on this list, the answer should be a record and
// not a recollection.
const CONSENT_TEXT =
  'I want occasional emails about Ask Danny updates. I can unsubscribe any time.';

function corsFor(event) {
  const origin = event.headers.origin || event.headers.Origin || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Vary': 'Origin',
  };
}

function store() {
  return getStore({ name: 'subscribers', consistency: 'strong' });
}

// The address itself is not the key. Blob keys turn up in logs and listings,
// and a key that IS the address leaks the list to anyone who can enumerate it.
function keyFor(email) {
  return crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');
}

function token() {
  return crypto.randomBytes(24).toString('base64url');
}

function normalise(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LEN) return null;
  if (!EMAIL_RE.test(email)) return null;
  return email;
}

function ipOf(event) {
  return (event.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || event.headers['client-ip'] || 'unknown';
}

async function rateLimited(event) {
  let s;
  try { s = getStore({ name: 'rate-limits', consistency: 'strong' }); }
  catch { return false; }  // storage unavailable: do not lock people out

  const key = `subscribe:${ipOf(event)}`;
  const now = Math.floor(Date.now() / 1000);
  let entry = null;
  try { entry = await s.get(key, { type: 'json' }); } catch { /* fresh window */ }

  if (!entry || typeof entry.windowStart !== 'number' || now - entry.windowStart > SUBSCRIBE_WINDOW) {
    entry = { count: 1, windowStart: now };
  } else if (entry.count >= SUBSCRIBE_LIMIT) {
    return true;
  } else {
    entry.count += 1;
  }
  try { await s.setJSON(key, entry); } catch { /* best effort */ }
  return false;
}

function page(title, heading, body, accent = '#E85B2A') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} — Ask Danny</title>
<style>
  :root{color-scheme:light}
  body{margin:0;background:#faf9f5;color:#1a1a18;
       font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
       display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .card{background:#fff;border:1px solid #e4e3dc;border-radius:14px;
        padding:36px 32px;max-width:460px;width:100%}
  .mark{display:inline-flex;align-items:center;justify-content:center;
        width:44px;height:44px;border-radius:10px;background:${accent};
        color:#fff;font-weight:700;letter-spacing:.5px;margin-bottom:18px}
  h1{font-size:22px;margin:0 0 10px}
  p{margin:0 0 14px;color:#4a4a44}
  a{color:${accent}}
</style></head><body><div class="card">
<div class="mark">AD</div><h1>${heading}</h1>${body}
<p><a href="https://diagnostechai.com">Back to Ask Danny</a></p>
</div></body></html>`;
}

const html = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  body,
});

exports.handler = async (event) => {
  const cors = corsFor(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  const path = event.path || '';
  const json = (statusCode, obj) => ({
    statusCode,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });

  // ── unsubscribe ──────────────────────────────────────────────────────────
  // A GET, so it works from an email client with one click and no JavaScript.
  if (path.includes('unsubscribe')) {
    const t = (event.queryStringParameters || {}).t || '';
    if (!t) return html(400, page('Unsubscribe', 'That link is incomplete',
      '<p>The unsubscribe link was missing its code. Reply to any update and we will remove you by hand.</p>'));

    let s;
    try { s = store(); } catch {
      return html(503, page('Unsubscribe', 'Something went wrong',
        '<p>We could not reach the list just now. Try the link again shortly, or reply to any update and we will remove you by hand.</p>'));
    }

    let hit = null;
    try {
      const { blobs } = await s.list();
      for (const b of blobs) {
        const rec = await s.get(b.key, { type: 'json' });
        if (rec && rec.unsubToken === t) { hit = { key: b.key, rec }; break; }
      }
    } catch { /* fall through to the generic answer */ }

    if (hit) {
      hit.rec.status = 'unsubscribed';
      hit.rec.unsubscribedAt = new Date().toISOString();
      try { await s.setJSON(hit.key, hit.rec); } catch { /* best effort */ }
    }

    // Same page whether or not the token matched. Confirming that a token is
    // unknown tells a stranger which tokens are real.
    return html(200, page('Unsubscribed', 'You are unsubscribed',
      '<p>You will not get any more Ask Danny update emails. Service notices about your account are separate and are not affected.</p>'
      + '<p>Changed your mind? You can sign up again on the site any time.</p>', '#1e7d45'));
  }

  // ── admin export ─────────────────────────────────────────────────────────
  if (path.includes('subscribers')) {
    const admin = process.env.ADMIN_TOKEN;
    const given = (event.headers['x-admin-token'] || '').trim();
    // Rejecting when unconfigured is the safe direction: an empty env var must
    // not become a password of "".
    if (!admin || !given || given.length !== admin.length
        || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(admin))) {
      return json(404, { error: 'Not found' });
    }

    let s;
    try { s = store(); } catch { return json(503, { error: 'Store unavailable' }); }

    const out = [];
    try {
      const { blobs } = await s.list();
      for (const b of blobs) {
        const rec = await s.get(b.key, { type: 'json' });
        if (rec) out.push({
          email: rec.email, status: rec.status, source: rec.source,
          createdAt: rec.createdAt, unsubscribedAt: rec.unsubscribedAt,
        });
      }
    } catch { return json(503, { error: 'Could not read the list' }); }

    out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return json(200, {
      total: out.length,
      active: out.filter(r => r.status === 'subscribed').length,
      subscribers: out,
    });
  }

  // ── subscribe ────────────────────────────────────────────────────────────
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid request.' }); }

  if (body.consent !== true) {
    return json(400, { error: 'Please tick the box to confirm you want these emails.' });
  }

  const email = normalise(body.email);
  if (!email) return json(400, { error: 'That does not look like an email address.' });

  if (await rateLimited(event)) {
    return json(429, { error: 'Too many sign-ups from this connection. Try again later.' });
  }

  let s;
  try { s = store(); }
  catch { return json(503, { error: 'Could not save that just now. Try again shortly.' }); }

  const key = keyFor(email);
  let existing = null;
  try { existing = await s.get(key, { type: 'json' }); } catch { /* treat as new */ }

  // Re-subscribing after unsubscribing is allowed, and is a fresh consent —
  // so the record and its timestamp are replaced, not revived.
  const record = {
    email,
    status: 'subscribed',
    source: String(body.source || 'site').slice(0, 40),
    consentText: CONSENT_TEXT,
    createdAt: existing && existing.status === 'subscribed'
      ? existing.createdAt : new Date().toISOString(),
    consentedAt: new Date().toISOString(),
    consentIp: ipOf(event),
    unsubToken: (existing && existing.unsubToken) || token(),
  };

  try { await s.setJSON(key, record); }
  catch { return json(503, { error: 'Could not save that just now. Try again shortly.' }); }

  // The same answer whether the address was already on the list or not.
  // Saying "you are already subscribed" turns this into a way to test whether
  // a given person uses Ask Danny.
  return json(200, { ok: true, message: 'You are on the list. We will only email about Ask Danny.' });
};
