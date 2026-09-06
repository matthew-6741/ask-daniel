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

const MODELS = {
  gemini:     'gemini-3.6-flash',
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

// Transient capacity errors are retryable too — a provider saying "high demand"
// means try elsewhere, not give up. Treating them as fatal was collapsing the
// council to a single opinion whenever Gemini was busy.
const RETRYABLE = /does not exist|do not have access|decommissioned|empty content|no longer available|not found|does not exist|not supported|timed out|high demand|overloaded|RESOURCE_EXHAUSTED|try again|unavailable|rate limit|429|503/i;

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

// Netlify kills synchronous functions at ~10s on the free plan, and the council
// is two sequential stages: opinions in parallel, then the judge. Fixed
// per-stage timeouts of 7s + 8s could reach 15s and get the whole request
// killed, losing work that had already completed.
//
// So the stages share one budget. Opinions get most of it; the judge only runs
// if enough time remains, and is skipped rather than risking the response.
// Netlify's function ceiling is 30s, not the 10s assumed when these were first
// set. The old 5.5s opinion window was cutting Gemini off mid-answer and
// collapsing the council to a single drafter on every run.
const TOTAL_BUDGET_MS   = 24000;  // leaves ~6s of headroom under the 30s kill
const OPINION_BUDGET_MS = 12000;  // Gemini answers in 2-3s but spikes higher
const JUDGE_MIN_MS      = 4000;
const STAGE_TIMEOUT_MS  = OPINION_BUDGET_MS;

// ── Rate limiting ────────────────────────────────────────────────────
//
// Counters live in Netlify Blobs rather than module memory. The in-memory
// version reset on every cold start, so the "5 free council runs per day" cap
// was really "5 per warm container" — anyone could wait out a restart, and the
// number shown in the UI was fiction.
//
// Blobs is eventually consistent, so two requests landing in the same instant
// can both read the same count. That is an acceptable overshoot for abuse
// deterrence; it is not a billing meter.
const { getStore } = require('@netlify/blobs');

function limitStore() {
  return getStore({ name: 'rate-limits', consistency: 'strong' });
}

async function checkRateLimit(key, tier) {
  const { max, win } = planFor(tier);
  const now = Math.floor(Date.now() / 1000);

  let store;
  try {
    store = limitStore();
  } catch {
    // Blobs unavailable (local dev, misconfigured deploy) — fail open rather
    // than locking every user out of a free product.
    return { allowed: true, remaining: max - 1, max, degraded: true };
  }

  let entry = null;
  try {
    entry = await store.get(key, { type: 'json' });
  } catch { /* treat a read failure as a fresh window */ }

  if (!entry || typeof entry.windowStart !== 'number' || now - entry.windowStart > win) {
    entry = { count: 1, windowStart: now };
  } else if (entry.count >= max) {
    return { allowed: false, remaining: 0, max, resetIn: entry.windowStart + win - now };
  } else {
    entry.count += 1;
  }

  try {
    await store.setJSON(key, entry);
  } catch {
    // The count is spent either way; letting the request through is kinder
    // than failing it over a bookkeeping error.
  }

  return { allowed: true, remaining: Math.max(0, max - entry.count), max };
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
function resolveKey(canonical, aliases = [], valuePrefixes = []) {
  // Only these names are consulted. An earlier version scanned every
  // environment variable for anything matching a key prefix, which meant an
  // unrelated secret could be picked up and sent to a model provider. Aliases
  // exist because real deployments get hand-named ("newapikey", "photos"), but
  // the list is explicit and the value must still carry the right prefix.
  const looksRight = v =>
    !valuePrefixes.length || valuePrefixes.some(pre => String(v).startsWith(pre));

  for (const name of [canonical, ...aliases]) {
    const v = process.env[name];
    if (v && looksRight(v)) return v;
  }
  return null;
}

// Google issues two key formats. "AIza..." is the older standard API key,
// retired as of September 2026; "AQ..." is the newer auth key that AI Studio
// now creates by default. Accept both — rejecting AQ. keys would turn a valid
// credential away.
// canonical -> [accepted alternative names], [required value prefixes]
const KEY_HINTS = {
  GEMINI_API_KEY:    [['GEMINI_KEY', 'GOOGLE_API_KEY', 'photos'],      ['AIza', 'AQ.']],
  GROQ_API_KEY:      [['GROQ_KEY', 'newapikey', 'KeyfromGroq'],        ['gsk_']],
  ANTHROPIC_API_KEY: [['CLAUDE_API_KEY'],                              ['sk-ant-']],
  OPENAI_API_KEY:    [['OPENAI_KEY'],                                  ['sk-proj-', 'sk-']],
  XAI_API_KEY:       [['GROK_API_KEY'],                                ['xai-']],
};

function keyFor(envName) {
  const [aliases, prefixes] = KEY_HINTS[envName] || [[], []];
  return resolveKey(envName, aliases, prefixes);
}


// ── System prompt ────────────────────────────────────────────────────
//
// Owned by the server. The client used to send `system` and we forwarded it,
// which meant anyone posting to this endpoint could replace the instructions
// wholesale — dropping the safety rules, the output format, or the instruction
// to prefer verified inventory. The client now sends only what it legitimately
// knows: store, trade, location, and the matched inventory rows.

const STORES = {
  hd: { name: 'Home Depot', aisles: '1-45' },
  lw: { name: "Lowe's",     aisles: '1-40' },
  az: { name: 'AutoZone',   aisles: '1-12' },
};

const TRADE_LABELS = {
  plumbing:  'Plumbing',
  hvac:      'Basic HVAC',
  carpentry: 'Carpentry / Framing / Drywall',
  auto:      'Automotive',
  appliance: 'Appliance repair',
};

// The product database is loaded here, not accepted from the request. The
// client used to post `verifiedAisles` and the server treated them as ground
// truth — so a crafted request could assert any aisle it liked and have it come
// back stamped "verified from our database", which is precisely the claim the
// database exists to make trustworthy.
const PRODUCTS = require('./products.json');

const TRADE_BUCKET = { carpentry: 'framing' };

// Retrieval mirrors the client's, but the server decides what is verified.
function lookupInventory(trade, query, limit = 30) {
  const bucket = TRADE_BUCKET[trade] || trade;
  const pool = []
    .concat(Array.isArray(PRODUCTS[bucket]) ? PRODUCTS[bucket] : [])
    .concat(Array.isArray(PRODUCTS.general) ? PRODUCTS.general : []);

  const seen = new Set();
  const unique = pool.filter(p => {
    const k = String(p.name).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  const kw = tokenize(query);
  if (!kw.length) return unique.slice(0, limit);

  return unique
    .map(p => {
      const name = new Set(tokenize(p.name));
      const tags = new Set((p.tags || []).flatMap(t => tokenize(t)));
      const spec = new Set(tokenize(p.spec));
      let score = 0;
      for (const w of kw) {
        if (name.has(w))      score += 3;
        else if (tags.has(w)) score += 2;
        else if (spec.has(w)) score += 1;
      }
      return { ...p, score };
    })
    .filter(p => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function formatInventory(rows) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const lines = rows.slice(0, 60).map(r => {
    const name  = String(r.name  || '').slice(0, 90);
    const spec  = String(r.spec  || '').slice(0, 60);
    const aisle = String(r.aisle || '').slice(0, 30);
    const price = r.price != null ? ` | ~$${Number(r.price).toFixed(2)}` : '';
    return `- ${name}${spec ? ' | ' + spec : ''} | ${aisle}${price}`;
  });
  return `\nVERIFIED STORE INVENTORY (use these first — real aisles and prices):\n${lines.join('\n')}\n`;
}

function buildSystemPrompt({ storeKey, trade, city, region, inventoryRows }) {
  const store = STORES[storeKey] || STORES.hd;
  const loc = city
    ? `The technician is in ${String(city).slice(0, 60)}${region ? ', ' + String(region).slice(0, 40) : ''}.`
    : 'Location unknown — use general North American product availability.';
  const inventory = formatInventory(inventoryRows);
  const tradeLabel = TRADE_LABELS[trade] || 'General trade work';

  return `You are a trade materials expert assistant for ${store.name} (aisles ${store.aisles}).
${loc}

The technician's trade category: ${tradeLabel}.
${inventory}
Your ONLY job is to produce a complete, precise material list so the technician can complete this job in ONE trip with ZERO return visits.

Rules:
1. Include EVERY item needed — fasteners, fittings, tape, primer, accessories. Never leave anything out.
2. Be specific on sizes, grades, and specs. Wrong spec = wasted trip.
3. ${inventory
      ? 'Prioritize items from the VERIFIED STORE INVENTORY above — use the exact aisle and price shown. If an item is not in the inventory, add it anyway and mark the name with (*) to flag it as estimated.'
      : `Use realistic ${store.name} product names and aisle numbers.`}
4. Flag any permit, code, or safety concern in NOTES.
5. Suggest a 10-15% overage on consumables (screws, fasteners, tape, caulk).
6. List the tools required in the TOOLS section.
7. If measurements are provided, calculate EXACT quantities and round up to sellable pack sizes.
8. Never invent an aisle number you are not confident about — write "Ask associate" instead.
9. Mark each item's confidence honestly: "high" when you are sure the job needs it, "medium" when it depends on what they find, "low" when you are guessing. Guessing and saying so is more useful than sounding certain.

Respond as JSON matching this shape:
{"notes": "...", "tools": [{"name":"...","why":"..."}],
 "materials": [{"name":"...","spec":"...","qty":"...","aisle":"Aisle 12","price":"~$8.47","confidence":"high"}]}

If you cannot produce JSON, use this exact text format instead:

NOTES: <one or two sentences about code/permit/safety concerns, or "None.">

TOOLS:
- <Tool name> | <Why it's needed / spec>
/TOOLS

MATERIALS:
- <Item name> | <Exact spec / size / grade> | <Quantity + unit> | Aisle <number> | ~$<price>
/MATERIALS`;
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
        response_format: { type: 'json_object' },
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
  let lastErr = null;
  for (const model of GEMINI_MODELS) {
    try { return await geminiOnce(model, system, prompt, maxTokens, image); }
    catch (e) {
      lastErr = e;
      if (!RETRYABLE.test(e.message) && !/no longer available|not supported/i.test(e.message)) throw e;
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
      generationConfig: {
        temperature: 0,
        maxOutputTokens: maxTokens,
        responseMimeType: 'application/json',
        responseSchema: LIST_SCHEMA,
      },
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

// ── Structured output ────────────────────────────────────────────────
//
// Both providers can return JSON directly. Asking for JSON removes the entire
// class of bug that has cost the most time on this project: a response cut off
// before its closing marker, a model that omits /MATERIALS, an aisle field
// truncated to "Ais", a reasoning model whose prose never matched the format.
// The text parser stays as a fallback for models that ignore the instruction.
const LIST_SCHEMA = {
  type: 'object',
  properties: {
    notes: { type: 'string' },
    tools: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, why: { type: 'string' } },
        required: ['name'],
      },
    },
    materials: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name:  { type: 'string' },
          spec:  { type: 'string' },
          qty:   { type: 'string' },
          aisle: { type: 'string' },
          price: { type: 'string' },
          // The model states its own certainty rather than the UI inferring it.
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['name', 'spec', 'qty'],
      },
    },
  },
  required: ['notes', 'materials'],
};

// Accept either shape: parsed JSON, or the older tagged text.
function normalizeResponse(raw) {
  const text = String(raw || '').trim();

  // JSON first — providers sometimes wrap it in a code fence.
  const candidate = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (candidate.startsWith('{')) {
    try {
      const j = JSON.parse(candidate);
      if (Array.isArray(j.materials)) {
        return {
          notes: String(j.notes || ''),
          tools: (j.tools || []).map(t => ({ name: String(t.name || ''), why: String(t.why || '') })).filter(t => t.name),
          items: j.materials.map(m => ({
            name:  String(m.name || ''),
            spec:  String(m.spec || ''),
            qty:   String(m.qty || '1'),
            aisle: cleanAisle(m.aisle),
            price: String(m.price || ''),
            confidence: ['high', 'medium', 'low'].includes(m.confidence) ? m.confidence : 'medium',
          })).filter(m => m.name),
          format: 'json',
        };
      }
    } catch { /* fall through to the text parser */ }
  }

  const parsed = parseResponse(text);
  return { ...parsed, format: 'text' };
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

function stemTok(w) {
  if (w.length > 4 && /(?:s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function tokenize(name) {
  return String(name || '').toLowerCase()
    .replace(/1-1\/2|1 1\/2|1\.5/g, '15').replace(/3\/4|0\.75/g, '34').replace(/1\/2|0\.5/g, '12')
    .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(t => t.length > 1 && !NOISE.has(t))
    .map(stemTok);
}

// Attributes that are mutually exclusive. Two names carrying different values
// from the same group are different products however similar the rest reads —
// "Copper Pipe 1/2" and "PVC Pipe 1/2" would otherwise score high enough to
// merge, which could send someone home with the wrong material.
const EXCLUSIVE_GROUPS = [
  ['copper', 'pvc', 'cpvc', 'pex', 'abs', 'galvanized', 'brass', 'steel', 'iron'],
  ['front', 'rear'],
  ['hot', 'cold'],
  ['interior', 'exterior'],
  ['male', 'female'],
  ['gas', 'electric'],
  ['left', 'right'],
];

function conflicts(aTokens, bTokens) {
  const aSet = new Set(aTokens), bSet = new Set(bTokens);
  return EXCLUSIVE_GROUPS.some(group => {
    const inA = group.filter(g => aSet.has(g));
    const inB = group.filter(g => bSet.has(g));
    if (!inA.length || !inB.length) return false;
    return !inA.some(v => inB.includes(v));
  });
}

// How alike two product names are.
//
// Plain token overlap is too blunt for this. A model writes "Coil Cleaning
// Brush" where the database holds "Condenser Coil Brush" — the same object,
// scoring 0.67 and falling short of any sane threshold. What actually
// identifies a product is its head noun: brush, blade, valve, filter. Two names
// sharing a head noun and some qualifier are the same thing; two names with
// different head nouns are not, however many words they share.
function similarity(a, b) {
  if (!a.length || !b.length) return 0;
  // Conflicting attributes (copper vs pvc, gas vs electric, front vs rear) mean
  // different products however much text they share. Restored after a rewrite
  // dropped it and let "Gas Water Heater" match "Electric Water Heater".
  if (conflicts(a, b)) return 0;
  const bs = new Set(b);
  const shared = a.filter(t => bs.has(t)).length;
  const overlap = shared / Math.min(a.length, b.length);

  // The head noun is the last WORD, not the last token — product names trail
  // sizes and quantities ("Wiper Blade 22 in."), and a number identifies
  // nothing.
  const head = toks => {
    for (let i = toks.length - 1; i >= 0; i--) {
      if (!/^\d+$/.test(toks[i])) return toks[i];
    }
    return toks[toks.length - 1];
  };
  const sameHead = head(a) === head(b);

  // Sharing the head noun plus at least one qualifier is strong evidence.
  if (sameHead && shared >= 2) return Math.max(overlap, 0.8);
  // Same head noun alone is suggestive but not enough on its own.
  if (sameHead) return Math.max(overlap, 0.55);
  return overlap;
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
    // Confidence the user sees is not the model's opinion alone. A verified
    // aisle is a fact from our data; an unverified one is a guess however
    // certain the model sounded. Report both so the UI can be honest about
    // which is which rather than presenting one number as though it covered
    // both the part and its location.
    const stated = item.confidence || 'medium';
    return best
      ? { ...item, aisle: best, aisleVerified: true,  aisleConfidence: 'verified', itemConfidence: stated }
      : { ...item, aisleVerified: false, aisleConfidence: 'unverified', itemConfidence: stated };
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

function priceOf(i) {
  const n = parseFloat(String(i.price || '').replace(/[^0-9.]/g, ''));
  return isNaN(n) ? 0 : n;
}
function qtyOf(i) {
  const n = parseFloat(String(i.qty || '').replace(/[^0-9.]/g, ''));
  return !isNaN(n) && n > 0 ? n : 1;
}

// ── Circuit breaker ──────────────────────────────────────────────────
//
// A provider that is down still costs the full per-stage timeout on every
// request. During an outage that is the difference between a council answering
// in 3s with one model and answering in 12s with the same one model.
//
// After repeated failures a provider is skipped outright for a cooldown, then
// allowed a single trial request. If that succeeds the circuit closes.
//
// State is per-container: a cold start resets it. That is fine for what this
// protects against — a burst of requests during an outage — and avoids adding
// a storage round-trip to the hot path of every call.
const BREAKER_THRESHOLD  = 3;      // consecutive failures before opening
const BREAKER_COOLDOWN_MS = 60000; // how long to skip before a trial request

const breakers = {};

function breakerFor(id) {
  if (!breakers[id]) breakers[id] = { failures: 0, openedAt: 0, trialInFlight: false };
  return breakers[id];
}

// Should this provider be skipped right now?
function circuitOpen(id) {
  const b = breakerFor(id);
  if (b.failures < BREAKER_THRESHOLD) return false;

  const elapsed = Date.now() - b.openedAt;
  if (elapsed < BREAKER_COOLDOWN_MS) return true;

  // Cooldown elapsed — let exactly one request through to test the water.
  if (b.trialInFlight) return true;
  b.trialInFlight = true;
  return false;
}

function recordSuccess(id) {
  const b = breakerFor(id);
  b.failures = 0;
  b.openedAt = 0;
  b.trialInFlight = false;
}

function recordFailure(id) {
  const b = breakerFor(id);
  b.failures += 1;
  b.trialInFlight = false;
  if (b.failures >= BREAKER_THRESHOLD && !b.openedAt) b.openedAt = Date.now();
  else if (b.failures >= BREAKER_THRESHOLD) b.openedAt = Date.now();
}

// ── Handler ──────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const startedAt = Date.now();
  const msLeft = () => TOTAL_BUDGET_MS - (Date.now() - startedAt);
  // Only our own front-ends. A wildcard let any site call this endpoint from a
  // visitor's browser and spend the quota attributed to their IP.
  const ALLOWED_ORIGINS = [
    'https://diagnostechai.com',
    'https://www.diagnostechai.com',
    'https://diagnostech.netlify.app',
    'http://localhost:3456',
  ];
  const origin = event.headers.origin || event.headers.Origin || '';
  const cors = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Vary': 'Origin',
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
  const rl = await checkRateLimit(getRateLimitKey(event, tier), tier);
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

  // Built here, never taken from the request.
  // Retrieval happens here, from our own database.
  const serverInventory = lookupInventory(body.trade, prompt);
  const system = buildSystemPrompt({
    storeKey:      body.store,
    trade:         body.trade,
    city:          body.city,
    region:        body.region,
    inventoryRows: serverInventory,
  });
  const prompt = sanitizeInput(body.prompt || '');
  const maxTokens = Math.min(Number(body.max_tokens) || 1600, plan.maxTokens);


  const image = validateImage(body.image);
  if (image === false) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'That image could not be read. Try a smaller JPEG or PNG.' }) };
  }
  if (!prompt && !image) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing job description.' }) };
  }

  const allMembers = councilMembers(tier, !!image);
  const members = allMembers.filter(m => !circuitOpen(m.id));
  const skipped = allMembers.filter(m => circuitOpen(m.id)).map(m => m.name);
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
    if (r.status === 'fulfilled' && normalizeResponse(r.value).items.length) {
      recordSuccess(members[i].id);
      drafts.push({ id: members[i].id, provider: name, raw: r.value, parsed: normalizeResponse(r.value) });
      status.push({ provider: name, ok: true, stage: 'opinion', itemCount: parseResponse(r.value).items.length });
    } else {
      recordFailure(members[i].id);
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

  const timeForJudge = msLeft();
  if (drafts.length > 1 && timeForJudge < JUDGE_MIN_MS) {
    status.push({ provider: 'judge', ok: false, stage: 'judge',
      error: `skipped — only ${Math.max(0, timeForJudge)}ms left of the ${TOTAL_BUDGET_MS}ms budget` });
  } else if (drafts.length > 1) {
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
          Math.max(JUDGE_MIN_MS, msLeft() - 300),
          'Judge'
        );
        const parsed = normalizeResponse(verdict);
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

  // Judge failed but several drafts exist. Taking the longest draft throws away
  // whatever the others caught — a part only one model spotted is often the one
  // that saves the second trip. Union them instead, deduped by the same
  // similarity used elsewhere, and mark how many drafts backed each item so the
  // UI can still show confidence.
  if (!judged && drafts.length > 1) {
    const merged = [];
    drafts.forEach(d => {
      d.parsed.items.forEach(item => {
        const t = tokenize(item.name);
        const hit = merged.find(m => similarity(t, tokenize(m.name)) > 0.7);
        if (hit) {
          if (!hit.providers.includes(d.provider)) {
            hit.providers.push(d.provider);
            hit.votes += 1;
          }
        } else {
          merged.push({ ...item, votes: 1, providers: [d.provider], totalProviders: drafts.length });
        }
      });
    });
    merged.sort((a, b) => b.votes - a.votes);
    finalParsed = {
      notes: drafts.map(d => d.parsed.notes).find(Boolean) || '',
      tools: finalParsed.tools,
      items: merged,
    };
  }

  // ── Aisle verification always runs last ──
  const items = verifyAisles(
    finalParsed.items,
    serverInventory.map(p => ({ name: p.name, aisle: `Aisle ${p.aisle}` }))
  );

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
      agentsSkipped: skipped.length ? skipped : undefined,
      providers: status,
      apiCalls: drafts.length + (judged ? 1 : 0),
      elapsedMs: Date.now() - startedAt,
      tier,
      remaining: rl.remaining,
      limit: rl.max,
      notes: finalParsed.notes,
      tools: finalParsed.tools,
      items,
      // Structured summary so callers don't re-parse text to learn basics.
      summary: {
        itemCount:     items.length,
        verifiedCount: items.filter(i => i.aisleVerified).length,
        estimatedLow:  Number(items.reduce((n, i) => n + priceOf(i) * qtyOf(i) * 0.9, 0).toFixed(2)),
        estimatedHigh: Number(items.reduce((n, i) => n + priceOf(i) * qtyOf(i) * 1.1, 0).toFixed(2)),
        lowConfidenceItems: items.filter(i => i.itemConfidence === 'low').length,
        // What fraction of aisles came from real data rather than a guess.
        // This is the number worth watching as the product database grows.
        aisleVerifiedRatio: items.length
          ? Number((items.filter(i => i.aisleVerified).length / items.length).toFixed(2))
          : 0,
      },
    }),
  };
};
