// DiagnosTech AI Council — free by default.
//
// Flow (3 calls per job, to stay inside free-tier quotas):
//   1. Gemini  answers independently
//   2. Groq    answers independently
//   3. Gemini  reviews both and synthesizes one list
//
// Why a judge instead of a vote: vote-counting treats agreement as truth, so
// three models repeating the same unsafe or incomplete answer scores perfectly.
// The judge is told to weigh safety, technical correctness, compatibility and
// missing information above how many models said a thing.
//
// Aisle numbers are still never decided by the models. The verified product DB
// wins; anything it doesn't cover is returned aisleVerified:false.
//
// Paid council (Claude / GPT / Grok) stays off unless ENABLE_PAID_COUNCIL=true.
//
// Env: GEMINI_API_KEY, GROQ_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY,
//      XAI_API_KEY, ANTHROPIC_MODEL, ENABLE_PAID_COUNCIL

const MODELS = {
  gemini:     'gemini-2.5-flash',
  openai:     'gpt-4o',
  xai:        'grok-2-vision-1212',
};

// Groq retires model names on its own schedule and access varies by key, so
// try a list. Instruction-following models first; reasoning models (gpt-oss)
// last, because they spend the token budget thinking and frequently return
// empty content at small max_tokens.
const GROQ_TEXT_MODELS = [
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
];
const GROQ_VISION_MODELS = [
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'llama-3.1-8b-instant',
];

const RETRYABLE = /does not exist|do not have access|decommissioned|not found|empty content/i;

// ── Plan configuration ───────────────────────────────────────────────
// Council review itself is available to EVERYONE. Plans differ only in how
// often you can run it and how large the council is. Adding a paid tier later
// should mean editing this block, not rewriting the flow.
const PLANS = {
  free: {
    label:        'Free',
    max:          5,          // council runs per window
    win:          86400,      // 24h
    maxOpinions:  4,          // every free agent configured, up to 4 drafters
    allowPaid:    false,      // never call paid providers
    maxTokens:    1600,
  },
  pro: {
    label:        'Pro',
    max:          40,
    win:          3600,       // 1h
    maxOpinions:  6,          // wider council when paid mode is on
    allowPaid:    true,       // still gated by ENABLE_PAID_COUNCIL
    maxTokens:    2000,
  },
};

function planFor(tier) {
  return PLANS[tier] || PLANS.free;
}

// Resolve the caller's plan.
//
// SECURITY — READ BEFORE CHARGING MONEY: this trusts the client's `tier`
// field. That is fine while every account is free, because both tiers cost the
// same (nothing) and paid providers are independently gated by
// ENABLE_PAID_COUNCIL. The moment Pro is a paid product, this must verify a
// Firebase ID token and read the plan from Firestore — otherwise anyone can
// set tier:'pro' in devtools and take the larger allowance.
//
// The verification hook is stubbed below so wiring it later is a small change.
async function resolveTier(body, event) {
  const claimed = body.tier === 'pro' ? 'pro' : 'free';
  if (claimed === 'free') return 'free';

  const verifier = process.env.FIREBASE_PROJECT_ID ? verifyProToken : null;
  if (!verifier) return 'free';   // can't prove Pro -> treat as free

  try {
    const token = (event.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return (await verifier(token)) ? 'pro' : 'free';
  } catch {
    return 'free';
  }
}

// Stub: implement when Pro launches.
// Verify the Firebase ID token, then read users/{uid}.plan from Firestore and
// return true only when it equals 'pro'. Until then Pro is unreachable, which
// is the safe default.
async function verifyProToken(/* idToken */) {
  return false;
}

// Per-provider timeout. Netlify kills synchronous functions around 10s, and
// Promise.allSettled waits for the slowest — without this one hung provider
// takes the whole request down even though the others already answered.
const STAGE_TIMEOUT_MS = 7000;
const JUDGE_TIMEOUT_MS = 8000;

const rateLimitStore = {};

function paidEnabled() {
  return String(process.env.ENABLE_PAID_COUNCIL || '').toLowerCase() === 'true';
}

function getRateLimitKey(event, tier) {
  const ip =
    event.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    event.headers['client-ip'] || 'unknown';
  return `council:${tier}:${ip}`;
}

function checkRateLimit(key, tier) {
  const { max, win } = planFor(tier);
  const now = Math.floor(Date.now() / 1000);
  const e = rateLimitStore[key];
  if (!e || now - e.windowStart > win) {
    rateLimitStore[key] = { count: 1, windowStart: now };
    return { allowed: true, remaining: max - 1, max };
  }
  if (e.count >= max) {
    return { allowed: false, remaining: 0, max, resetIn: e.windowStart + win - now };
  }
  e.count += 1;
  return { allowed: true, remaining: max - e.count, max };
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

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms)),
  ]);
}

// Resolve a provider's key.
//
// Environment variables get named by hand and rarely match exactly — a Groq key
// has turned up as GROQ_API_KEY, KeyfromGroq and plain "key". Rather than fail
// with "no provider configured" while a perfectly good key sits right there,
// resolve in three passes:
//   1. the canonical name
//   2. any variable whose name mentions the provider
//   3. any variable whose VALUE carries the provider's key prefix — the most
//      reliable signal, since a value starting gsk_ is a Groq key whatever it
//      was called
function resolveKey(canonical, providerWord, valuePrefixes = []) {
  // When the provider's keys have a known prefix, the value must carry it —
  // however the variable was named. A variable called GEMINI_KEY holding a
  // Google session token ("AQ.…") is not a Gemini key, and accepting it would
  // put the agent in the council only to fail with 401 on every request.
  const looksRight = v =>
    !valuePrefixes.length || valuePrefixes.some(pre => String(v).startsWith(pre));

  const direct = process.env[canonical];
  if (direct && looksRight(direct)) return direct;

  const entries = Object.entries(process.env).filter(([, v]) => v && looksRight(v));
  const word = providerWord.toLowerCase();

  const byName = entries.find(([k]) => k.toLowerCase().includes(word));
  if (byName) return byName[1];

  // No name hint, but the value's prefix identifies the provider unambiguously.
  if (valuePrefixes.length && entries.length) return entries[0][1];

  return null;
}

const KEY_HINTS = {
  GEMINI_API_KEY:      ['gemini', ['AIza']],
  GROQ_API_KEY:        ['groq',   ['gsk_']],
  ANTHROPIC_API_KEY:   ['anthropic', ['sk-ant-']],
  OPENAI_API_KEY:      ['openai', ['sk-proj-']],
  XAI_API_KEY:         ['xai',    ['xai-']],
  CEREBRAS_API_KEY:    ['cerebras', ['csk-']],
  MISTRAL_API_KEY:     ['mistral', []],
  OPENROUTER_API_KEY:  ['openrouter', ['sk-or-']],
  GITHUB_MODELS_TOKEN: ['github', ['ghp_', 'github_pat_']],
};

function keyFor(envName) {
  const [word, prefixes] = KEY_HINTS[envName] || [envName.toLowerCase(), []];
  return resolveKey(envName, word, prefixes);
}

// ── Agent registry ───────────────────────────────────────────────────
//
// ADDING A NEW AGENT: append one entry below. Nothing else needs to change —
// membership, timeouts, judging, fallback and reporting all read this list.
//
//   id       stable key used in logs and responses
//   name     shown to the user
//   env      env var holding the key; absent key = agent is skipped, never fatal
//   cost     'free' | 'paid'   ('paid' also requires ENABLE_PAID_COUNCIL=true)
//   vision   true if it can read an attached photo
//   roles    which jobs it can do: 'opinion' (draft a list), 'judge'
//            (synthesize drafts). An agent can do both.
//   call(system, prompt, maxTokens, image) -> raw text in NOTES/TOOLS/MATERIALS
//
// Agents need not be LLMs. Anything matching that call signature can join —
// a rules engine, a supplier API wrapper, a retrieval-only responder.

// Most providers speak the OpenAI chat format, so they share one adapter.
function openAICompatible({ url, keyEnv, model, visionModel }) {
  return async (system, prompt, maxTokens, image) => {
    const content = image
      ? [{ type: 'text', text: prompt },
         { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.base64}` } }]
      : prompt;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keyFor(keyEnv)}`,
      },
      body: JSON.stringify({
        model: image && visionModel ? visionModel : model,
        temperature: 0,
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `${model} ${res.status}`);
    return data.choices?.[0]?.message?.content || '';
  };
}

async function callGroq(system, prompt, maxTokens, image) {
  const candidates = image ? GROQ_VISION_MODELS : GROQ_TEXT_MODELS;
  let lastErr = null;
  for (const model of candidates) {
    const once = openAICompatible({
      url: 'https://api.groq.com/openai/v1/chat/completions',
      keyEnv: 'GROQ_API_KEY', model,
    });
    try {
      const out = await once(system, prompt, maxTokens, image);
      if (out && out.trim()) return out;
      lastErr = new Error(`${model} returned empty content`);
    } catch (e) {
      lastErr = e;
      if (!RETRYABLE.test(e.message)) throw e;
    }
  }
  throw lastErr || new Error('No usable Groq model');
}

async function callGemini(system, prompt, maxTokens, image) {
  const parts = [{ text: prompt }];
  if (image) parts.push({ inlineData: { mimeType: image.mediaType, data: image.base64 } });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini}:generateContent?key=${keyFor('GEMINI_API_KEY')}`;
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
    ? [{ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
       { type: 'text', text: prompt }]
    : prompt;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': keyFor('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-6',
      max_tokens: maxTokens, temperature: 0, system,
      messages: [{ role: 'user', content }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Claude ${res.status}`);
  return data.content?.map(b => b.text || '').join('') || '';
}

const AGENTS = [
  // ---- Free tier: every provider with a usable free plan ----
  { id: 'gemini', name: 'Gemini', env: 'GEMINI_API_KEY', cost: 'free', vision: true,
    roles: ['opinion', 'judge'], call: callGemini },

  { id: 'groq', name: 'Groq', env: 'GROQ_API_KEY', cost: 'free', vision: true,
    roles: ['opinion', 'judge'], call: callGroq },

  { id: 'cerebras', name: 'Cerebras', env: 'CEREBRAS_API_KEY', cost: 'free', vision: false,
    roles: ['opinion'],
    call: openAICompatible({ url: 'https://api.cerebras.ai/v1/chat/completions',
      keyEnv: 'CEREBRAS_API_KEY', model: 'llama-3.3-70b' }) },

  { id: 'mistral', name: 'Mistral', env: 'MISTRAL_API_KEY', cost: 'free', vision: true,
    roles: ['opinion'],
    call: openAICompatible({ url: 'https://api.mistral.ai/v1/chat/completions',
      keyEnv: 'MISTRAL_API_KEY', model: 'mistral-large-latest', visionModel: 'pixtral-large-latest' }) },

  { id: 'openrouter', name: 'OpenRouter', env: 'OPENROUTER_API_KEY', cost: 'free', vision: true,
    roles: ['opinion'],
    call: openAICompatible({ url: 'https://openrouter.ai/api/v1/chat/completions',
      keyEnv: 'OPENROUTER_API_KEY', model: 'meta-llama/llama-3.3-70b-instruct:free' }) },

  { id: 'github', name: 'GitHub Models', env: 'GITHUB_MODELS_TOKEN', cost: 'free', vision: true,
    roles: ['opinion'],
    call: openAICompatible({ url: 'https://models.inference.ai.azure.com/chat/completions',
      keyEnv: 'GITHUB_MODELS_TOKEN', model: 'gpt-4o-mini' }) },

  // ---- Paid tier: requires ENABLE_PAID_COUNCIL=true AND a plan allowing it ----
  { id: 'claude', name: 'Claude', env: 'ANTHROPIC_API_KEY', cost: 'paid', vision: true,
    roles: ['opinion', 'judge'], call: callClaude },

  { id: 'gpt', name: 'GPT', env: 'OPENAI_API_KEY', cost: 'paid', vision: true,
    roles: ['opinion', 'judge'],
    call: openAICompatible({ url: 'https://api.openai.com/v1/chat/completions',
      keyEnv: 'OPENAI_API_KEY', model: MODELS.openai }) },

  { id: 'grok', name: 'Grok', env: 'XAI_API_KEY', cost: 'paid', vision: true,
    roles: ['opinion'],
    call: openAICompatible({ url: 'https://api.x.ai/v1/chat/completions',
      keyEnv: 'XAI_API_KEY', model: MODELS.xai }) },
];

// Agents eligible for this request: key present, cost allowed by plan + switch,
// able to see the photo if one was attached, and able to do the role asked for.
function eligibleAgents(tier, { role = 'opinion', hasImage = false } = {}) {
  const plan = planFor(tier);
  const paidOk = plan.allowPaid && paidEnabled();
  return AGENTS.filter(a =>
    keyFor(a.env) &&
    (a.cost === 'free' || paidOk) &&
    a.roles.includes(role) &&
    (!hasImage || a.vision)
  );
}

// Opinion panel for this request, capped by the plan.
//
// Ordering matters once the cap bites. In paid mode the paid models are the
// reason someone upgraded, so they seat first — otherwise the free agents,
// which happen to come first in the registry, would fill every seat and the
// paid keys would go unused.
function councilMembers(tier, hasImage) {
  const plan = planFor(tier);
  const eligible = eligibleAgents(tier, { role: 'opinion', hasImage });
  const paidMode = plan.allowPaid && paidEnabled();
  const ordered = paidMode
    ? [...eligible].sort((a, b) => (a.cost === 'paid' ? 0 : 1) - (b.cost === 'paid' ? 0 : 1))
    : eligible;
  return ordered.slice(0, plan.maxOpinions);
}

// Judge should ideally not be one of the drafters — an independent reviewer is
// less likely to simply re-assert its own draft. Falls back to a drafter, then
// to any judge-capable agent, when the roster is small.
function pickJudge(tier, hasImage, drafterIds = []) {
  const judges = eligibleAgents(tier, { role: 'judge', hasImage });
  return judges.find(j => !drafterIds.includes(j.id)) || judges[0] || null;
}

// ── Parsing ──────────────────────────────────────────────────────────

function cleanAisle(raw) {
  const v = String(raw || '').trim();
  if (!v) return 'Ask associate';
  return /\d/.test(v) ? v : 'Ask associate';
}

function parseResponse(text) {
  const notesMatch = text.match(/NOTES:\s*(.+?)(?=\nTOOLS:|\nMATERIALS:|$)/s);
  const notes = notesMatch ? notesMatch[1].trim() : '';

  const toolsMatch = text.match(/TOOLS:\s*([\s\S]+?)(?:\/TOOLS|(?=\nMATERIALS:)|$)/);
  const tools = [];
  if (toolsMatch) {
    toolsMatch[1].split('\n').map(l => l.trim()).filter(l => l.startsWith('-')).forEach(line => {
      const p = line.replace(/^-\s*/, '').split('|').map(s => s.trim());
      if (p[0]) tools.push({ name: p[0], why: p[1] || '' });
    });
  }

  const matsMatch = text.match(/MATERIALS:\s*([\s\S]+?)(?:\/MATERIALS|$)/);
  const items = [];
  if (matsMatch) {
    matsMatch[1].split('\n').map(l => l.trim()).filter(l => l.startsWith('-')).forEach(line => {
      const p = line.replace(/^-\s*/, '').split('|').map(s => s.trim());
      if (p.length >= 4) {
        items.push({ name: p[0], spec: p[1], qty: p[2], aisle: cleanAisle(p[3]), price: p[4] || '' });
      }
    });
  }
  return { notes, tools, items };
}

// ── Aisle verification (models never decide this) ────────────────────

const NOISE = new Set(['the','and','for','with','a','an','of','in','on','to','or','kit','pack','inch','inches','ft','feet','new','standard','type','size']);

function tokenize(name) {
  return String(name || '').toLowerCase()
    .replace(/1-1\/2|1 1\/2|1\.5/g, '15').replace(/3\/4|0\.75/g, '34').replace(/1\/2|0\.5/g, '12')
    .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(t => t.length > 1 && !NOISE.has(t))
    .map(w => (w.length > 3 && w.endsWith('es')) ? w.slice(0,-2) : (w.length > 3 && w.endsWith('s')) ? w.slice(0,-1) : w);
}

function similarity(a, b) {
  if (!a.length || !b.length) return 0;
  const bs = new Set(b);
  return a.filter(t => bs.has(t)).length / Math.min(a.length, b.length);
}

function verifyAisles(items, verifiedAisles) {
  if (!Array.isArray(verifiedAisles) || !verifiedAisles.length) {
    return items.map(i => ({ ...i, aisleVerified: false }));
  }
  return items.map(item => {
    const t = tokenize(item.name);
    let best = null, score = 0;
    for (const row of verifiedAisles) {
      const s = similarity(t, tokenize(row.name));
      if (s > 0.7 && s > score) { score = s; best = row.aisle; }
    }
    return best
      ? { ...item, aisle: best, aisleVerified: true }
      : { ...item, aisleVerified: false };
  });
}

// ── Judge ────────────────────────────────────────────────────────────

function buildJudgePrompt(job, drafts) {
  const blocks = drafts.map((d, i) =>
    `--- DRAFT ${i + 1} (from ${d.provider}) ---\n${d.raw.slice(0, 6000)}`
  ).join('\n\n');

  return `You are the chairman of a materials council. Independent assistants each produced a materials list for the same job. Produce ONE final list.

THE JOB:
${job}

${blocks}

HOW TO DECIDE — read carefully:
- Do NOT simply take the majority or merge everything. Agreement between drafts is weak evidence; two assistants can repeat the same mistake.
- Judge each item on whether the job actually requires it. Keep an item only one draft listed if it is genuinely needed. Drop an item both drafts listed if it is not.
- Prioritise, in order: safety, technical correctness, compatibility between parts, then completeness.
- If the drafts disagree on a specification (pipe material, size, voltage, thread type), choose the one that is correct for the job and say why in NOTES. Never split the difference.
- If a required part is missing from both drafts, add it.
- If the job description lacks something you need in order to be sure (pipe diameter, model number, dimensions), say so plainly in NOTES rather than guessing silently.
- Never invent an aisle number you are not confident about. Write "Ask associate" instead.

Reply in EXACTLY this format and nothing else:

NOTES: <one or two sentences: key decisions, disagreements you resolved, and anything the user must confirm>
TOOLS:
- <Tool name> | <Why it is needed>
/TOOLS
MATERIALS:
- <Item> | <Spec> | <Qty> | Aisle <n> | ~$<price>
/MATERIALS`;
}

// ── Handler ──────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: cors, body: 'Method not allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

  const tier = await resolveTier(body, event);
  const plan = planFor(tier);
  const rl = checkRateLimit(getRateLimitKey(event, tier), tier);
  if (!rl.allowed) {
    const hrs = Math.ceil(rl.resetIn / 3600);
    return {
      statusCode: 429,
      headers: { ...cors, 'Retry-After': String(rl.resetIn) },
      body: JSON.stringify({
        error: tier === 'free'
          ? `You've used all ${rl.max} free council runs. More in about ${hrs} hour${hrs === 1 ? '' : 's'}.`
          : `Council limit reached. Try again in ${Math.ceil(rl.resetIn / 60)} minutes.`,
        tier, upgradeSuggested: tier === 'free',
      }),
    };
  }

  const system = typeof body.system === 'string' ? body.system.slice(0, 16000) : '';
  const prompt = sanitizeInput(body.prompt || '');
  const maxTokens = Math.min(Number(body.max_tokens) || 1600, plan.maxTokens);
  const verifiedAisles = Array.isArray(body.verifiedAisles) ? body.verifiedAisles.slice(0, 60) : null;

  const image = validateImage(body.image);
  if (image === false) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'That image could not be read. Try a smaller JPEG or PNG.' }) };
  }
  if (!prompt && !image) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing job description.' }) };
  }

  const members = councilMembers(tier, !!image);
  if (!members.length) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'No AI providers configured on the server.' }) };
  }

  // ── Stage 1: independent opinions ──
  const settled = await Promise.allSettled(
    members.map(m => withTimeout(m.call(system, prompt, maxTokens, image), STAGE_TIMEOUT_MS, m.name))
  );

  const drafts = [];
  const status = [];
  settled.forEach((r, i) => {
    const name = members[i].name;
    if (r.status === 'fulfilled' && parseResponse(r.value).items.length) {
      drafts.push({ id: members[i].id, provider: name, raw: r.value, parsed: parseResponse(r.value) });
      status.push({ provider: name, ok: true, stage: 'opinion', itemCount: parseResponse(r.value).items.length });
    } else {
      const why = r.status === 'rejected'
        ? String(r.reason?.message || r.reason).slice(0, 160)
        : 'returned no parseable materials';
      status.push({ provider: name, ok: false, stage: 'opinion', error: why });
    }
  });

  if (!drafts.length) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'No council member returned a usable list.', providers: status }) };
  }

  // ── Stage 2: judge ──
  // One draft needs no adjudication — sending it to a judge would spend a call
  // to rewrite a list nobody disagreed with.
  let finalParsed = drafts[0].parsed;
  let judged = false;
  let judgeName = null;

  if (drafts.length > 1) {
    const judge = pickJudge(tier, !!image, drafts.map(d => d.id));
    if (judge) {
      judgeName = judge.name;
      try {
        const verdict = await withTimeout(
          judge.call(
            'You are an expert trade materials chairman. Follow the requested output format exactly.',
            buildJudgePrompt(prompt || 'See attached photo.', drafts),
            maxTokens,
            image
          ),
          JUDGE_TIMEOUT_MS,
          'Judge'
        );
        const parsed = parseResponse(verdict);
        if (parsed.items.length) {
          finalParsed = parsed;
          judged = true;
          status.push({ provider: judge.name, ok: true, stage: 'judge', itemCount: parsed.items.length });
        } else {
          status.push({ provider: judge.name, ok: false, stage: 'judge', error: 'judge output unparseable — used best single draft' });
        }
      } catch (e) {
        status.push({ provider: judge.name, ok: false, stage: 'judge', error: String(e.message).slice(0, 160) });
      }
    }
  }

  // Fallback when the judge failed: prefer the most complete draft rather than
  // silently returning whichever provider happened to answer first.
  if (!judged && drafts.length > 1) {
    finalParsed = drafts.slice().sort((a, b) => b.parsed.items.length - a.parsed.items.length)[0].parsed;
  }

  // ── Aisle verification always runs last ──
  const items = verifyAisles(finalParsed.items, verifiedAisles);

  return {
    statusCode: 200,
    headers: { ...cors, 'Content-Type': 'application/json', 'X-RateLimit-Remaining': String(rl.remaining) },
    body: JSON.stringify({
      council: true,
      mode: (plan.allowPaid && paidEnabled()) ? 'paid' : 'free',
      plan: plan.label,
      judged,
      judge: judgeName,
      opinionsUsed: drafts.map(d => d.provider),
      agentsAvailable: eligibleAgents(tier, { role: 'opinion', hasImage: !!image }).map(a => a.name),
      providers: status,
      apiCalls: drafts.length + (judged ? 1 : 0),
      tier,
      remaining: rl.remaining,
      limit: rl.max,
      notes: finalParsed.notes,
      tools: finalParsed.tools,
      items,
    }),
  };
};
