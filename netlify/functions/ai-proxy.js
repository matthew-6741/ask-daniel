// Single-model proxy. Keeps API keys off the browser and routes by plan tier.
//
// TIERS
//   free — beta / unregistered users. Runs on a provider with a usable free
//          tier (Groq or Gemini Flash), so serving beta traffic costs $0.
//   pro  — paid plan. Runs Claude for better list quality.
//
// Ollama is deliberately NOT a tier here. It listens on localhost, so it only
// works on the machine running it — a visitor's phone can't reach it. Local
// Ollama stays a dev-only path, selected client-side by hostname.
//
// Env vars (set what you have):
//   GROQ_API_KEY       free tier, fast          -> preferred for `free`
//   GEMINI_API_KEY     free tier                -> fallback for `free`
//   ANTHROPIC_API_KEY  paid                     -> used for `pro`

const LIMITS = {
  free: { max: 8,  win: 3600 },   // generous enough to try, tight enough to deter abuse
  pro:  { max: 40, win: 3600 },
};

const rateLimitStore = {};

function getRateLimitKey(event, tier) {
  const ip =
    event.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    event.headers['client-ip'] ||
    'unknown';
  return `${tier}:${ip}`;
}

function checkRateLimit(key, tier) {
  const { max, win } = LIMITS[tier] || LIMITS.free;
  const now = Math.floor(Date.now() / 1000);
  const entry = rateLimitStore[key];

  if (!entry || now - entry.windowStart > win) {
    rateLimitStore[key] = { count: 1, windowStart: now };
    return { allowed: true, remaining: max - 1 };
  }
  if (entry.count >= max) {
    return { allowed: false, remaining: 0, resetIn: entry.windowStart + win - now };
  }
  entry.count += 1;
  return { allowed: true, remaining: max - entry.count };
}

function sanitizeInput(text) {
  if (typeof text !== 'string') return '';
  return text
    .slice(0, 1600)
    .replace(/<[^>]*>/g, '')
    .replace(/\bignore\s+(all\s+)?previous\s+instructions?\b/gi, '[removed]')
    .replace(/\bsystem\s*prompt\b/gi, '[removed]')
    .replace(/\bdisregard\s+\w+/gi, '[removed]')
    .trim();
}

// Validate an attached photo. Returns null when absent, false when malformed,
// or the cleaned {base64, mediaType}. The client already downscales to ~1024px;
// this cap is the backstop against a hand-crafted request.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_MEDIA = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function validateImage(image) {
  if (!image) return null;
  if (typeof image !== 'object') return false;

  const { base64, mediaType } = image;
  if (typeof base64 !== 'string' || !base64) return false;
  if (!ALLOWED_MEDIA.includes(mediaType)) return false;
  if (!/^[A-Za-z0-9+/=]+$/.test(base64.slice(0, 256))) return false;
  if (base64.length * 0.75 > MAX_IMAGE_BYTES) return false;

  return { base64, mediaType };
}

// ── Provider calls. Each returns raw text in the NOTES/TOOLS/MATERIALS format.

async function callGroq(system, prompt, maxTokens, image) {
  // Groq's text model can't see; its vision model can. Swap when a photo is sent.
  const model = image ? 'llama-3.2-90b-vision-preview' : 'llama-3.3-70b-versatile';
  const userContent = image
    ? [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.base64}` } },
      ]
    : prompt;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: userContent },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Groq ${res.status}`);
  return data.choices?.[0]?.message?.content || '';
}

async function callGemini(system, prompt, maxTokens, image) {
  const parts = [{ text: prompt }];
  if (image) parts.push({ inlineData: { mimeType: image.mediaType, data: image.base64 } });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0, maxOutputTokens: maxTokens },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Gemini ${res.status}`);
  return data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
}

async function callClaude(system, prompt, maxTokens, image) {
  const content = image
    ? [
        { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
        { type: 'text', text: prompt },
      ]
    : prompt;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      temperature: 0,
      system,
      messages: [{ role: 'user', content }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Claude ${res.status}`);
  return data.content?.map(b => b.text || '').join('') || '';
}

// Pick a provider for the tier, falling back down the list if keys are missing.
// Gemini leads the free chain when a photo is attached: its vision support is
// on the same free tier, whereas Groq's vision model is a separate preview.
function pickProvider(tier, hasImage) {
  const groq   = { name: 'Groq',   env: 'GROQ_API_KEY',      call: callGroq };
  const gemini = { name: 'Gemini', env: 'GEMINI_API_KEY',    call: callGemini };
  const claude = { name: 'Claude', env: 'ANTHROPIC_API_KEY', call: callClaude };

  const freeChain = hasImage ? [gemini, groq] : [groq, gemini];
  const chain = tier === 'pro' ? [claude, ...freeChain] : freeChain;
  return chain.find(p => process.env[p.env]) || null;
}

// Resolve the caller's plan.
//
// SECURITY: right now this trusts the client, which is fine while every account
// is free/beta. Before charging money, verify a Firebase ID token here with the
// Admin SDK and read the plan from Firestore — a client-declared "pro" is just
// a devtools edit away from free premium access.
function resolveTier(body) {
  return body.tier === 'pro' ? 'pro' : 'free';
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

  const tier = resolveTier(body);

  const rl = checkRateLimit(getRateLimitKey(event, tier), tier);
  if (!rl.allowed) {
    const mins = Math.ceil(rl.resetIn / 60);
    return {
      statusCode: 429,
      headers: { ...corsHeaders, 'Retry-After': String(rl.resetIn) },
      body: JSON.stringify({
        error: tier === 'free'
          ? `Free plan limit reached — ${mins} minutes until it resets. Upgrade for more lists.`
          : `Rate limit reached. Try again in ${mins} minutes.`,
        tier,
        upgradeSuggested: tier === 'free',
      }),
    };
  }

  // Accept both shapes: {system, prompt} and the older {system, messages:[...]}
  const system = typeof body.system === 'string' ? body.system.slice(0, 16000) : '';
  const rawPrompt = body.prompt ?? body.messages?.find(m => m.role === 'user')?.content ?? '';
  const prompt = sanitizeInput(rawPrompt);
  const maxTokens = Math.min(Number(body.max_tokens) || 1600, 2000);

  const image = validateImage(body.image);
  if (image === false) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'That image could not be read. Try a smaller JPEG or PNG.' }) };
  }

  if (!prompt && !image) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing job description.' }) };
  }

  const provider = pickProvider(tier, !!image);
  if (!provider) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'No AI provider configured on the server.' }),
    };
  }

  try {
    const text = await provider.call(system, prompt, maxTokens, image);
    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'X-RateLimit-Remaining': String(rl.remaining),
      },
      // Normalized shape so the client doesn't care which provider answered.
      body: JSON.stringify({ text, provider: provider.name, tier, remaining: rl.remaining }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({ error: `${provider.name} failed: ${String(err.message).slice(0, 200)}` }),
    };
  }
};
