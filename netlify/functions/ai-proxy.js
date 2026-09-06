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

// Resolve a provider's key tolerantly — see ai-council.js for the reasoning.
// Variables get hand-named (KeyfromGroq, "key"), and a value's prefix is a more
// reliable signal of which provider it belongs to than the name it was given.
function resolveKey(canonical, providerWord, valuePrefixes = []) {
  const looksRight = v =>
    !valuePrefixes.length || valuePrefixes.some(pre => String(v).startsWith(pre));

  const direct = process.env[canonical];
  if (direct && looksRight(direct)) return direct;

  const entries = Object.entries(process.env).filter(([, v]) => v && looksRight(v));
  const byName = entries.find(([k]) => k.toLowerCase().includes(providerWord.toLowerCase()));
  if (byName) return byName[1];

  if (valuePrefixes.length && entries.length) return entries[0][1];
  return null;
}

// Google issues two key formats. "AIza..." is the older standard API key,
// retired as of September 2026; "AQ..." is the newer auth key that AI Studio
// now creates by default. Accept both — rejecting AQ. keys would turn a valid
// credential away.
const KEY_HINTS = {
  GROQ_API_KEY:      ['groq',      ['gsk_']],
  GEMINI_API_KEY:    ['gemini',    ['AIza', 'AQ.']],
  ANTHROPIC_API_KEY: ['anthropic', ['sk-ant-']],
};

function keyFor(envName) {
  const [word, prefixes] = KEY_HINTS[envName] || [envName.toLowerCase(), []];
  return resolveKey(envName, word, prefixes);
}

// A model that hangs rather than erroring would otherwise consume the whole
// function budget and return a platform timeout — which reaches the user as a
// raw Lambda error, not a message. Each attempt gets its own ceiling, and the
// loop as a whole gets one too, so a slow model costs a retry rather than the
// request.
const PER_MODEL_TIMEOUT_MS = 8000;   // a hang should cost one retry, not the request
const TOTAL_TIMEOUT_MS     = 25000;   // Netlify kills the function at 30s

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// ── Provider calls. Each returns raw text in the NOTES/TOOLS/MATERIALS format.

// Groq retires model names on its own schedule, and which ones an account can
// reach varies. Try a list rather than pinning one — a dead name should cost a
// retry, not the whole request.
// Groq's current production line-up (console.groq.com/docs/models).
// Smallest/most widely available first, so a restricted key still gets served.
const GROQ_TEXT_MODELS = [
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  // Reasoning models last: they spend the token budget thinking and often
  // return empty content at small max_tokens.
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
];
// Groq lists no vision model in production right now, so photo jobs fall back
// to describing the text prompt only. Gemini handles photos when configured.
// Groq lists no vision model in production. Scout is kept as a single
// optimistic attempt for accounts that have it; there is no text fallback,
// because a text model handed a photo answers confidently about nothing.
const GROQ_VISION_MODELS = [
  'meta-llama/llama-4-scout-17b-16e-instruct',
];

async function callGroq(system, prompt, maxTokens, image) {
  const candidates = image ? GROQ_VISION_MODELS : GROQ_TEXT_MODELS;
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let lastErr = null;
  for (const model of candidates) {
    if (Date.now() > deadline) break;
    try {
      return await withTimeout(
        groqOnce(model, system, prompt, maxTokens, image),
        Math.min(PER_MODEL_TIMEOUT_MS, deadline - Date.now()), model);
    } catch (e) {
      lastErr = e;
      // Only a missing/forbidden model is worth retrying; anything else is real.
      if (!/does not exist|do not have access|decommissioned|empty content|no longer available|not found|does not exist|not supported|timed out|high demand|overloaded|RESOURCE_EXHAUSTED|try again|unavailable|rate limit|429|503/i.test(e.message)) throw e;
    }
  }
  throw lastErr || new Error('No usable Groq model');
}

async function groqOnce(model, system, prompt, maxTokens, image) {
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
      'Authorization': `Bearer ${keyFor('GROQ_API_KEY')}`,
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

  const msg = data.choices?.[0]?.message || {};
  // Reasoning models put chain-of-thought in `reasoning` and the answer in
  // `content`. An empty `content` means it never reached an answer — the
  // scratchpad is not a substitute, so treat it as this model failing and let
  // the caller try the next one.
  const text = msg.content || '';
  if (!text.trim()) {
    throw new Error(`${model} does not have access to a usable completion (empty content, finish: ${data.choices?.[0]?.finish_reason || '?'})`);
  }
  lastGroqModel = model;
  return text;
}

let lastGroqModel = null;

// Google retires Gemini model names too. Same approach as Groq: try a list.
// Order is by measured behaviour, not version number. gemini-3.6-flash hangs
// on this key — it burned the full 12s per-model timeout on every request
// before falling through, making photo jobs take 17s instead of 5s. Known-good
// first; the newer name stays last in case access changes.
// gemini-3.6-flash is dropped, not reordered: it hung on every request until
// the per-model timeout fired, so keeping it as a fallback only added 12s to
// the failure path without ever succeeding.
const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-flash-latest',
];

async function callGemini(system, prompt, maxTokens, image) {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let lastErr = null;
  for (const model of GEMINI_MODELS) {
    if (Date.now() > deadline) break;
    try {
      return await withTimeout(
        geminiOnce(model, system, prompt, maxTokens, image),
        Math.min(PER_MODEL_TIMEOUT_MS, deadline - Date.now()), model);
    } catch (e) {
      lastErr = e;
      if (!/no longer available|not found|does not exist|not supported|timed out|high demand|overloaded|RESOURCE_EXHAUSTED|try again|unavailable|rate limit|429|503/i.test(e.message)) throw e;
    }
  }
  throw lastErr || new Error('No usable Gemini model');
}

async function geminiOnce(model, system, prompt, maxTokens, image) {
  const parts = [{ text: prompt }];
  if (image) parts.push({ inlineData: { mimeType: image.mediaType, data: image.base64 } });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${keyFor('GEMINI_API_KEY')}`;
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
      'x-api-key': keyFor('ANTHROPIC_API_KEY'),
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
  // `vision` reflects what the provider can actually do today. Groq lists no
  // vision model in production, so handing it a photo produces a confident
  // answer about an image it never received — worse than refusing.
  const groq   = { name: 'Groq',   env: 'GROQ_API_KEY',      call: callGroq,   vision: false };
  const gemini = { name: 'Gemini', env: 'GEMINI_API_KEY',    call: callGemini, vision: true  };
  const claude = { name: 'Claude', env: 'ANTHROPIC_API_KEY', call: callClaude, vision: true  };

  const freeChain = hasImage ? [gemini] : [groq, gemini];  // only Gemini sees
  const chain = tier === 'pro' ? [claude, ...freeChain] : freeChain;
  return chain.find(p => keyFor(p.env) && (!hasImage || p.vision)) || null;
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
    // A photo needs a vision-capable provider. Saying "no provider configured"
    // when text works fine would send someone hunting the wrong problem.
    const textProvider = pickProvider(tier, false);
    const msg = image && textProvider
      ? 'Photo analysis needs a vision-capable model, which is not configured yet. Describe the job in words instead, or add a GEMINI_API_KEY.'
      : 'No AI provider configured on the server.';
    return {
      statusCode: image && textProvider ? 400 : 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: msg, needsVisionProvider: !!(image && textProvider) }),
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
      body: JSON.stringify({ text, provider: provider.name, model: lastGroqModel || undefined, tier, remaining: rl.remaining }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({ error: `${provider.name} failed: ${String(err.message).slice(0, 200)}` }),
    };
  }
};
