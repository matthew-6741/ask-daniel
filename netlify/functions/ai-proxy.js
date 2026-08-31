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

// ── Provider calls. Each returns raw text in the NOTES/TOOLS/MATERIALS format.

async function callGroq(system, prompt, maxTokens) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: prompt },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Groq ${res.status}`);
  return data.choices?.[0]?.message?.content || '';
}

async function callGemini(system, prompt, maxTokens) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: maxTokens },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Gemini ${res.status}`);
  return data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
}

async function callClaude(system, prompt, maxTokens) {
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
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Claude ${res.status}`);
  return data.content?.map(b => b.text || '').join('') || '';
}

// Pick a provider for the tier, falling back down the list if keys are missing.
function pickProvider(tier) {
  const freeChain = [
    { name: 'Groq',   env: 'GROQ_API_KEY',      call: callGroq },
    { name: 'Gemini', env: 'GEMINI_API_KEY',    call: callGemini },
  ];
  const proChain = [
    { name: 'Claude', env: 'ANTHROPIC_API_KEY', call: callClaude },
    ...freeChain,   // if the paid key is missing, still serve something
  ];
  const chain = tier === 'pro' ? proChain : freeChain;
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

  const provider = pickProvider(tier);
  if (!provider) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'No AI provider configured on the server.' }),
    };
  }

  // Accept both shapes: {system, prompt} and the older {system, messages:[...]}
  const system = typeof body.system === 'string' ? body.system.slice(0, 16000) : '';
  const rawPrompt = body.prompt ?? body.messages?.find(m => m.role === 'user')?.content ?? '';
  const prompt = sanitizeInput(rawPrompt);
  const maxTokens = Math.min(Number(body.max_tokens) || 1600, 2000);

  if (!prompt) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing job description.' }) };
  }

  try {
    const text = await provider.call(system, prompt, maxTokens);
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
