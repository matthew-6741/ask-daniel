# Ask Daniel Council Plan

This branch is for the multi-model council upgrade inspired by `karpathy/llm-council`.

## Current decision

For now, keep the system FREE. Do not call paid Claude, OpenAI, or xAI APIs by default.

### Free Council

1. Gemini 2.5 Flash — primary vision/materials answer
2. Groq free-plan model — second independent answer
3. Gemini 2.5 Flash — judge/synthesizer

That is 3 API calls per job instead of a full 9-call council, to preserve free-tier quotas.

Uploaded photos must continue to work.

## Later Paid Council

When the owner intentionally enables paid mode, expand to:

- Claude (preferred model configurable with `ANTHROPIC_MODEL`; owner currently wants Opus when paid mode is enabled)
- Gemini
- OpenAI GPT
- xAI Grok

Then use a Karpathy-style flow:

1. Independent first opinions
2. Anonymous peer review/ranking
3. Chairman synthesizes final answer

Do not blindly majority-vote. Safety, technical correctness, compatibility, and missing information matter more than vote count.

## Safety / cost switch

Add a server-side environment switch such as:

`ENABLE_PAID_COUNCIL=false`

Default must be false.

When false, paid providers must not be called even if their API keys exist.

When true, the paid council may use configured keys.

## Existing DiagnosTech behavior to preserve

- Photo upload / vision analysis
- Existing NOTES / TOOLS / MATERIALS output format
- Existing product / aisle verification logic
- Existing rate limiting
- Existing frontend result flow
- Existing single-model fallback behavior where practical

## Provider environment variables

Preferred clean names:

- `GEMINI_API_KEY`
- `GROQ_API_KEY`
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `XAI_API_KEY`
- `ANTHROPIC_MODEL`
- `ENABLE_PAID_COUNCIL`

Do not expose secrets in browser code.

## Important note

Groq and Grok are different services. Free mode should use Groq. xAI Grok belongs only in the later paid council.

## Next implementation step

Implement the free council first in `netlify/functions/ai-consensus.js` or a new `ai-council.js`, test it with text and photo jobs, then add the paid council behind the environment switch.
