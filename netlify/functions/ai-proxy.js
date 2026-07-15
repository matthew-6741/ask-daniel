// Netlify serverless function — keeps Claude API key off the browser.
// Set ANTHROPIC_API_KEY in Netlify → Site settings → Environment variables.

const RATE_LIMIT_MAX  = 10;   // requests per window
const RATE_LIMIT_WIN  = 3600; // seconds (1 hour)

// In-memory store (resets on cold start, good enough for abuse deterrence)
const rateLimitStore = {};

function getRateLimitKey(event) {
  return (
    event.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    event.headers['client-ip'] ||
    'unknown'
  );
}

function checkRateLimit(key) {
  const now = Math.floor(Date.now() / 1000);
  const entry = rateLimitStore[key];

  if (!entry || now - entry.windowStart > RATE_LIMIT_WIN) {
    rateLimitStore[key] = { count: 1, windowStart: now };
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 };
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    const reset = entry.windowStart + RATE_LIMIT_WIN - now;
    return { allowed: false, remaining: 0, resetIn: reset };
  }

  entry.count += 1;
  return { allowed: true, remaining: RATE_LIMIT_MAX - entry.count };
}

function sanitizeInput(text) {
  if (typeof text !== 'string') return '';
  return text
    .slice(0, 1600)                         // job description (800) + measurements suffix
    .replace(/<[^>]*>/g, '')                // strip HTML tags
    .replace(/\bignore\s+(all\s+)?previous\s+instructions?\b/gi, '[removed]')
    .replace(/\bsystem\s*prompt\b/gi, '[removed]')
    .replace(/\bdisregard\s+\w+/gi, '[removed]')
    .trim();
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };
  }

  // Rate limit check
  const clientKey = getRateLimitKey(event);
  const rl = checkRateLimit(clientKey);
  if (!rl.allowed) {
    return {
      statusCode: 429,
      headers: { ...corsHeaders, 'Retry-After': String(rl.resetIn) },
      body: JSON.stringify({
        error: `Rate limit reached. Try again in ${Math.ceil(rl.resetIn / 60)} minutes.`,
      }),
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'API key not configured on server.' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON.' }) };
  }

  // Sanitize the user-supplied messages
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map(msg => ({
      ...msg,
      content: typeof msg.content === 'string' ? sanitizeInput(msg.content) : msg.content,
    }));
  }

  // Only allow safe fields to reach Anthropic. Model is pinned server-side so a
  // crafted request can't switch to a pricier model on your bill. System cap is
  // generous — it carries the RAG inventory block (~30 products) + instructions.
  const payload = {
    model:      'claude-sonnet-4-6',
    max_tokens: Math.min(Number(body.max_tokens) || 1600, 2000),
    system:     typeof body.system === 'string' ? body.system.slice(0, 16000) : undefined,
    messages:   body.messages,
  };

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    return {
      statusCode: response.status,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'X-RateLimit-Remaining': String(rl.remaining),
      },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to reach AI provider.' }),
    };
  }
};
