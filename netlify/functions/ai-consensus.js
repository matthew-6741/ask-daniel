// Multi-model consensus endpoint.
//
// Fans one job description out to Claude, Gemini, and GPT in parallel, then
// merges their material lists by vote. The point is NOT that three models
// average into truth — it's that disagreement is information:
//   * an item all three list is almost certainly needed
//   * an item one model lists alone is either a good catch or a hallucination,
//     and the user deserves to see which items those are
//
// Aisle numbers are deliberately NOT decided by vote. Models guess store
// layouts from training data, so three guesses agreeing means nothing. The
// client's verified product DB wins; anything the DB doesn't cover is returned
// with aisleVerified:false so the UI can mark it.
//
// Env vars (set whichever you have — missing providers are skipped, not fatal):
//   ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY

// Cross-check is available to EVERYONE — the free plan just gets a smaller
// allowance, because each run costs ~3x a normal list.
//
// NOTE ON DURABILITY: this counter lives in module memory, which Netlify wipes
// on cold start. It deters casual overuse but is not real metering. Before this
// gates anything you charge for, move the counters to Firestore keyed by uid.
const LIMITS = {
  free: { max: 5,  win: 86400 },  // 5 cross-checks per day
  pro:  { max: 40, win: 3600  },  // 40 per hour
};

const rateLimitStore = {};

function getRateLimitKey(event, tier) {
  const ip =
    event.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    event.headers['client-ip'] ||
    'unknown';
  return `consensus:${tier}:${ip}`;
}

function checkRateLimit(key, tier) {
  const { max, win } = LIMITS[tier] || LIMITS.free;
  const now = Math.floor(Date.now() / 1000);
  const entry = rateLimitStore[key];
  if (!entry || now - entry.windowStart > win) {
    rateLimitStore[key] = { count: 1, windowStart: now };
    return { allowed: true, remaining: max - 1, max };
  }
  if (entry.count >= max) {
    return { allowed: false, remaining: 0, max, resetIn: entry.windowStart + win - now };
  }
  entry.count += 1;
  return { allowed: true, remaining: max - entry.count, max };
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

// ── Provider adapters ────────────────────────────────────────────────
// Each returns raw text in the NOTES/TOOLS/MATERIALS format, or throws.

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

async function callGemini(system, prompt, maxTokens) {
  const model = 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
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

async function callOpenAI(system, prompt, maxTokens) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `OpenAI ${res.status}`);
  return data.choices?.[0]?.message?.content || '';
}

const PROVIDERS = [
  { name: 'Claude', env: 'ANTHROPIC_API_KEY', call: callClaude },
  { name: 'Gemini', env: 'GEMINI_API_KEY',    call: callGemini },
  { name: 'GPT',    env: 'OPENAI_API_KEY',    call: callOpenAI },
];

// ── Parsing (mirrors the client parser, closing markers optional) ─────

function parseResponse(text) {
  const notesMatch = text.match(/NOTES:\s*(.+?)(?=\nTOOLS:|\nMATERIALS:|$)/s);
  const notes = notesMatch ? notesMatch[1].trim() : '';

  const toolsMatch = text.match(/TOOLS:\s*([\s\S]+?)(?:\/TOOLS|(?=\nMATERIALS:)|$)/);
  const tools = [];
  if (toolsMatch) {
    toolsMatch[1].split('\n').map(l => l.trim()).filter(l => l.startsWith('-')).forEach(line => {
      const parts = line.replace(/^-\s*/, '').split('|').map(p => p.trim());
      if (parts[0]) tools.push({ name: parts[0], why: parts[1] || '' });
    });
  }

  const matsMatch = text.match(/MATERIALS:\s*([\s\S]+?)(?:\/MATERIALS|$)/);
  const items = [];
  if (matsMatch) {
    matsMatch[1].split('\n').map(l => l.trim()).filter(l => l.startsWith('-')).forEach(line => {
      const parts = line.replace(/^-\s*/, '').split('|').map(p => p.trim());
      if (parts.length >= 4) {
        items.push({
          name:  parts[0],
          spec:  parts[1],
          qty:   parts[2],
          aisle: parts[3],
          price: parts[4] || '',
        });
      }
    });
  }
  return { notes, tools, items };
}

// ── Fuzzy item matching ──────────────────────────────────────────────
// "P-Trap Kit 1-1/2 in PVC" and "1.5 inch PVC P-trap kit" are the same item.
// Compare significant tokens rather than raw strings.

const NOISE = new Set([
  'the','and','for','with','a','an','of','in','on','to','or','kit','pack',
  'inch','inches','in','ft','feet','x','new','standard','type','size',
]);

function tokenize(name) {
  return name
    .toLowerCase()
    .replace(/1-1\/2|1 1\/2|1\.5/g, '15')   // normalize common fractions
    .replace(/3\/4|0\.75/g, '34')
    .replace(/1\/2|0\.5/g, '12')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !NOISE.has(t));
}

function similarity(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0;
  const bSet = new Set(bTokens);
  const shared = aTokens.filter(t => bSet.has(t)).length;
  return shared / Math.min(aTokens.length, bTokens.length);
}

function numeric(str) {
  const n = parseFloat(String(str).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

function mostCommon(values) {
  const counts = {};
  values.filter(v => v != null && v !== '').forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries[0][0] : '';
}

function median(nums) {
  const clean = nums.filter(n => n != null).sort((a, b) => a - b);
  if (!clean.length) return null;
  return clean[Math.floor(clean.length / 2)];
}

// Merge per-provider lists into one voted list.
function mergeItems(perProvider, verifiedAisles) {
  const clusters = [];

  perProvider.forEach(({ provider, items }) => {
    items.forEach(item => {
      const tokens = tokenize(item.name);
      // find an existing cluster this item belongs to
      let target = null;
      let best = 0;
      for (const c of clusters) {
        const s = similarity(tokens, c.tokens);
        if (s > 0.6 && s > best) { best = s; target = c; }
      }
      if (target) {
        target.variants.push({ ...item, provider });
        if (!target.providers.includes(provider)) target.providers.push(provider);
      } else {
        clusters.push({
          tokens,
          providers: [provider],
          variants: [{ ...item, provider }],
        });
      }
    });
  });

  const totalProviders = perProvider.length;

  return clusters.map(c => {
    // Prefer the most detailed name among variants — usually the most useful one.
    const name = c.variants.map(v => v.name).sort((a, b) => b.length - a.length)[0];
    const spec = mostCommon(c.variants.map(v => v.spec));
    const qty  = mostCommon(c.variants.map(v => v.qty));

    const prices = c.variants.map(v => numeric(v.price)).filter(n => n != null);
    const medPrice = median(prices);
    const price = medPrice != null ? `~$${medPrice.toFixed(2)}` : '';

    // Aisle: verified DB first. Models guessing in agreement is not verification.
    const verified = verifiedAisles ? lookupVerified(name, verifiedAisles) : null;
    const modelAisles = c.variants.map(v => v.aisle).filter(Boolean);
    const aisleAgree = new Set(modelAisles).size === 1;

    return {
      name,
      spec,
      qty,
      price,
      aisle: verified || mostCommon(modelAisles) || 'Ask associate',
      aisleVerified: !!verified,
      aisleDisputed: !verified && modelAisles.length > 1 && !aisleAgree,
      votes: c.providers.length,
      totalProviders,
      providers: c.providers,
    };
  })
  // Most-agreed items first, so the confident stuff is at the top of the list.
  .sort((a, b) => b.votes - a.votes);
}

// Match an item name against the client's verified inventory rows.
function lookupVerified(name, verifiedAisles) {
  const tokens = tokenize(name);
  let best = null, bestScore = 0;
  for (const row of verifiedAisles) {
    const s = similarity(tokens, tokenize(row.name));
    if (s > 0.7 && s > bestScore) { bestScore = s; best = row.aisle; }
  }
  return best;
}

// ── Handler ──────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

  const tier = body.tier === 'pro' ? 'pro' : 'free';

  const rl = checkRateLimit(getRateLimitKey(event, tier), tier);
  if (!rl.allowed) {
    const hrs = Math.ceil(rl.resetIn / 3600);
    return {
      statusCode: 429,
      headers: { ...corsHeaders, 'Retry-After': String(rl.resetIn) },
      body: JSON.stringify({
        error: tier === 'free'
          ? `You've used all ${rl.max} free cross-checks. More in about ${hrs} hour${hrs === 1 ? '' : 's'}, or upgrade for 40 an hour.`
          : `Cross-check limit reached. Try again in ${Math.ceil(rl.resetIn / 60)} minutes.`,
        tier,
        upgradeSuggested: tier === 'free',
      }),
    };
  }

  const system = typeof body.system === 'string' ? body.system.slice(0, 16000) : '';
  const prompt = sanitizeInput(body.prompt || '');
  const maxTokens = Math.min(Number(body.max_tokens) || 1600, 2000);
  const verifiedAisles = Array.isArray(body.verifiedAisles) ? body.verifiedAisles.slice(0, 60) : null;

  if (!prompt) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing job description.' }) };
  }

  const active = PROVIDERS.filter(p => process.env[p.env]);
  if (active.length === 0) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'No AI providers configured on the server.' }),
    };
  }

  // Fan out in parallel. allSettled so one provider being down still returns a list.
  const settled = await Promise.allSettled(
    active.map(p => p.call(system, prompt, maxTokens))
  );

  const perProvider = [];
  const status = [];
  const allNotes = [];
  const allTools = [];

  settled.forEach((result, i) => {
    const name = active[i].name;
    if (result.status === 'fulfilled') {
      const parsed = parseResponse(result.value);
      if (parsed.items.length) {
        perProvider.push({ provider: name, items: parsed.items });
        if (parsed.notes) allNotes.push({ provider: name, note: parsed.notes });
        parsed.tools.forEach(t => allTools.push(t));
        status.push({ provider: name, ok: true, itemCount: parsed.items.length });
      } else {
        status.push({ provider: name, ok: false, error: 'Returned no parseable materials' });
      }
    } else {
      status.push({ provider: name, ok: false, error: String(result.reason?.message || result.reason).slice(0, 200) });
    }
  });

  if (perProvider.length === 0) {
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'All providers failed to return a usable list.', providers: status }),
    };
  }

  const items = mergeItems(perProvider, verifiedAisles);

  // De-duplicate tools by name.
  const toolMap = new Map();
  allTools.forEach(t => { if (!toolMap.has(t.name.toLowerCase())) toolMap.set(t.name.toLowerCase(), t); });

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-RateLimit-Remaining': String(rl.remaining) },
    body: JSON.stringify({
      consensus: true,
      providers: status,
      respondedCount: perProvider.length,
      tier,
      remaining: rl.remaining,
      limit: rl.max,
      notes: allNotes.length ? allNotes[0].note : '',
      tools: [...toolMap.values()],
      items,
    }),
  };
};
