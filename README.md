# DiagnostechAI

**Describe the job. Get a one-trip material list with aisle numbers.**

[diagnostechai.com](https://diagnostechai.com/) · Private beta

---

Contractors lose hours and margin on the second trip to the supply store — the fitting that didn't fit, the tool left back at the shop, the size that was wrong.

DiagnostechAI takes a job described in plain language:

> *"Replace a 40-gallon gas water heater"*

and returns a single list: materials with quantities and specs, the tools the job needs, a rough price, and the **exact aisle number** at Home Depot, Lowe's, or AutoZone.

## Why it doesn't invent part numbers

A general-purpose model will happily produce plausible-sounding products that don't exist. DiagnostechAI grounds every answer in a curated inventory instead:

1. `searchProducts(query, trade)` keyword-scores a 181-item product database (`products.json`)
2. Top matches are injected into the system prompt as a **VERIFIED STORE INVENTORY** block
3. The model is instructed to prefer verified items and mark anything it can't confirm with `(*)`

The contractor can tell at a glance which line items are real and which need a second look.

## Features

| | |
|---|---|
| 🎤 Voice input | Describe the job hands-free (Web Speech API) |
| 🏪 Multi-store compare | Home Depot vs Lowe's, side by side |
| 🧰 Tool checklist | What to bring, per trade |
| 📴 Offline mode | Last result cached for the truck |
| 🧮 Quantity calculator | Coverage, runs, and counts |
| 📋 Job history | Firestore when signed in, `localStorage` as a guest |

**Trades:** 🔧 Plumbing · ❄️ HVAC · 🪵 Carpentry

## Architecture

Plain HTML/CSS/JS — no framework, no build step. The entire client is one file.

```
Browser (index.html)
   │
   ├── RAG: searchProducts() over products.json
   │
   └── POST /api/ai
          │
          ▼
   Netlify Function (netlify/functions/ai-proxy.js)
          │   · API key read from env, never sent to the browser
          │   · 10 req/hr/IP rate limit
          │   · input sanitization + model pinned server-side
          ▼
   Claude API
```

Auth is Firebase (email/password + Google). Signed-in job history lives in Firestore under owner-only rules; guests stay entirely in `localStorage`.

A `USE_LOCAL` toggle at the top of `index.html` swaps the proxy for a local Ollama model at `localhost:11434` during development.

## Security

- **The Anthropic API key never reaches the browser.** Every model call routes through a serverless proxy that reads `ANTHROPIC_API_KEY` from the environment.
- The model and token cap are pinned server-side, so a crafted request can't escalate to a pricier model.
- Per-IP rate limiting (10 requests/hour) and input sanitization at the proxy.
- CSP and HSTS headers set in `netlify.toml`.
- Firestore rules restrict every document to its owner and cap field sizes.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Running locally

```bash
python3 -m http.server 4173
```

Then open <http://localhost:4173/index.html>.

Set `USE_LOCAL = true` near the top of `index.html` to run against a local Ollama model, or deploy the Netlify function and leave it `false`.

## Layout

| Path | What it is |
|---|---|
| `index.html` | The entire client app |
| `products.json` | 181-item product database used for retrieval |
| `netlify/functions/ai-proxy.js` | Serverless proxy that holds the API key |
| `netlify.toml` | Security headers, CSP, redirects |
| `firestore.rules` | Owner-only Firestore access rules |

## License

Source-available, not open source. See [LICENSE](LICENSE).

© 2026 Matthew John Sanchez. All rights reserved.
