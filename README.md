# Ask Danny

**Describe the job. Get a one-trip material list with aisle numbers.**

[diagnostechai.com](https://diagnostechai.com/) · Live, free beta

---

Trades lose hours and margin on the second trip to the supply store — the fitting that didn't fit, the tool left back at the shop, the size that was wrong.

Ask Danny takes a job described the way someone actually says it:

> *"My toilet keeps running"*

and returns one list: materials with quantities and specs, the tools needed, a rough price, and the **aisle number** at Home Depot, Lowe's, or AutoZone.

## The two problems this has to solve

**Models invent products.** A general model will happily produce a plausible part number for something that does not exist. So the server retrieves from a curated inventory (`products.json`, 249 products across 10 trade buckets), injects the matches into its own prompt, and replaces any aisle the model guessed with the verified one. Anything not in the inventory is included but marked low confidence, and an aisle we cannot verify is printed as "Ask associate" rather than invented.

About half of returned items currently carry a verified aisle. That ratio is the honest measure of whether this product is useful, and it is the number worth improving before anything else.

**Models sell the expensive part.** Asked why an AC runs but does not cool, a model will reach for refrigerant. The usual answer is a $20 capacitor. The system prompt carries per-trade check-order guidance — capacitor before refrigerant, flapper before a new toilet, coils before a compressor, battery before a starter, jam wrench before a new disposal — because selling someone the costly part when a cheap one usually fixes it is the worst thing this tool can do.

There is also a hard stop above all of it: for a gas smell, a suspected leak, carbon monoxide, sparking or burning wiring, or standing water near live electricity, it returns **no materials at all** and says to leave and call the utility or the fire department. A short list of nothing plus the right instruction is the correct answer.

## How an answer gets made

Several models answer independently, then one synthesises. This is not majority voting — a judge reads the drafts and produces a single list, weighing safety, technical correctness and compatibility.

```
Browser (index.html)
    │
    └── POST /api/council
           │
           ▼
    netlify/functions/ai-council.js
           │
           ├── retrieval over products.json        (server-side, not client-supplied)
           ├── system prompt built server-side     (never accepted from the request)
           ├── persistent rate limit               (Netlify Blobs)
           │
           ├──► Gemini  ─┐
           ├──► Groq    ─┼──► drafts
           │             │
           └──► judge ───┘  synthesises one list
                    │
                    └── verified aisles substituted from our own data
```

If the council cannot be reached the client falls back to `/api/ai`, a single-model path that carries the same server-owned prompt and the same safety rules.

A circuit breaker opens after three consecutive failures from a provider and retries with a single trial request after a cooldown, so one sick provider does not slow every request.

## Features

| | |
|---|---|
| Voice input | Describe the job hands-free (Web Speech API) |
| Photo input | Photograph the problem instead of describing it |
| Multi-store compare | Home Depot vs Lowe's, side by side |
| Tool checklist | What to bring, per trade |
| Offline mode | Last result cached for the truck |
| Quantity calculator | Coverage, runs and counts |
| Job history | Firestore when signed in, `localStorage` as a guest |
| Usage ring | How many free lists are left today |

**Trades:** Plumbing · HVAC · Carpentry · Auto · Appliance

**Plans:** free is 5 lists a day with up to 4 drafters, all on free-tier providers. Pro (40/hour, paid models) is built but not sold — `verifyProToken()` returns `false` until real accounts exist, and the tier is never taken from the request.

## Evaluation

Architecture is easy to add and hard to justify. The thing that actually tells you whether this works is a set of real jobs and someone qualified marking the answers.

| Path | What it is |
|---|---|
| `eval/jobs.json` | 58 jobs phrased as real people speak, 13 of them traps |
| `eval/run.js` | Runs them against the live API, writes a CSV with columns for a tradesperson to grade |
| `eval/local-check.js` | 53 checks against mocked providers — run before every deploy |

The traps are the interesting part: a gas smell must refuse rather than sell parts, an AC that won't cool must reach for the capacitor and not refrigerant, a humming disposal needs a jam wrench and not a new unit, a load-bearing wall needs an engineer, and a prompt injection must produce a normal list and leak nothing.

`local-check.js` runs both handlers in-process against scripted providers and has caught two `ReferenceError`s that `node --check` could not see. Run it before every deploy.

## Security

- **No API key reaches the browser.** Keys are resolved server-side from an explicit allowlist of environment variable names, and the value must carry the right prefix — so an unrelated secret cannot be picked up and sent to a model provider.
- **The system prompt is owned by the server.** Both endpoints previously accepted `body.system` and forwarded it, which let anyone replace the instructions wholesale — safety rules included. It is now read and discarded.
- **CORS is an allowlist**, on both endpoints. `/api/ai` was `*`, which let any website spend our provider quota from a browser.
- **Verified aisles come from our own data.** The client used to post `verifiedAisles` and the server trusted them, so a crafted request could assert any aisle it liked.
- Persistent per-IP rate limiting via Netlify Blobs, so a redeploy does not reset everyone's quota.
- Input sanitisation, and a token cap enforced against the plan rather than the request.
- Firestore rules restrict every document to its owner and cap field sizes.
- `netlify.toml` sets HSTS, `X-Frame-Options: DENY`, `nosniff`, a strict referrer policy, and a permissions policy denying camera, payment, USB and motion sensors.

**Known gap:** the CSP still requires `script-src 'unsafe-inline'`, because the UI wires events through inline `onclick` handlers. That materially weakens its XSS protection, so it is not claimed as a defence here. Migrating to delegated listeners is the next security task.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Privacy and disclosure

Analytics load only after the visitor accepts — Consent Mode defaults every category to denied before any tag can run, and declining is the same size and weight as accepting. Every user acknowledges that AI can be wrong and that they are 18 or older before using the app, and each result carries an AI-generated label on the result itself, so a printed or screenshotted list still says a machine wrote it.

Photos are sent to an AI provider to answer one request and are not stored. No face recognition, no biometric extraction. Job history for guests never leaves the device.

See [privacy.html](privacy.html), [terms.html](terms.html) and [cookies.html](cookies.html).

## Running locally

```bash
python3 -m http.server 4173
```

Then open <http://localhost:4173/index.html>.

Set `USE_LOCAL = true` near the top of `index.html` to run against a local Ollama model instead of the deployed functions.

Before any deploy:

```bash
node eval/local-check.js
```

## Layout

| Path | What it is |
|---|---|
| `index.html` | The entire client app |
| `products.json` | Curated per-trade inventory used for retrieval |
| `netlify/functions/ai-council.js` | The council: retrieval, prompt, drafters, judge, rate limiting |
| `netlify/functions/ai-proxy.js` | Single-model fallback, same server-owned prompt |
| `eval/` | Job set, live harness, and pre-deploy checks |
| `netlify.toml` | Security headers, CSP, redirects |
| `firestore.rules` | Owner-only Firestore access rules |
| `privacy.html` `terms.html` `cookies.html` | Disclosure, DMCA agent, AI policy |

## Status

Live and free while in beta. Accounts are not wired up yet — Firebase config is still a placeholder, so everyone is a guest and history stays on the device.

Material lists are generated by AI and are not checked by a licensed tradesperson. Verify quantities, specs and aisle numbers before buying, and hire a professional for gas, electrical or structural work.

## License

Source-available, not open source. See [LICENSE](LICENSE).

© 2026 Matthew John Sanchez. All rights reserved.
