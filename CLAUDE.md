# Ask Daniel — Project Briefing

## What this is
AI-powered trade assistant. User describes a job → AI returns a one-trip material list with exact store aisle numbers. Targets Home Depot, Lowe's, and AutoZone.

## Key files
- `index.html` — entire app (single file, ~2200 lines)
- `products.json` — 181-item local product DB used for RAG injection into AI prompts
- `/Users/sanchez/diagnostech-deploy/` — Netlify deploy folder (copy of both files + netlify.toml + Netlify Function)

## Architecture
- Plain HTML/CSS/JS, no framework
- AI backend toggle at top of `index.html`:
  - `USE_LOCAL = true` → Ollama local (`qwen3.6` at `http://localhost:11434`)
  - `USE_LOCAL = false` → Netlify proxy function (`/api/ai`) → Claude `claude-sonnet-4-6`
- API key lives in Netlify env var `ANTHROPIC_API_KEY` — never in the browser
- Firebase Auth (compat SDK v10.12.0) for login — config placeholder at `FIREBASE_CONFIG` constant
- Firestore for authenticated user job history; localStorage for guests

## Current feature set
1. Voice input (Web Speech API)
2. Job history (localStorage for guests, Firestore for auth users)
3. Tool checklist per trade
4. Multi-store compare (Home Depot vs Lowe's side by side)
5. Quick templates per trade
6. Offline mode (cache last result)
7. Quantity calculator
8. Access gate (`TRADE2026` — sessionStorage key `diagnostech_access`)
9. Ollama local model toggle

## Trades (reduced from 9 to 3)
- `plumbing` — 🔧 Plumbing
- `hvac` — ❄️ Basic HVAC
- `carpentry` — 🪵 Carpentry (maps to `framing` key in products.json)

## Auth flow
Gate → Auth screen → App
- Continue as Guest: localStorage only, no account needed
- Sign In / Create Account: Firebase email+password or Google
- Account types on sign-up: Consumer, Contractor, Corporation
- Firebase not configured yet (placeholder values) → auth screen still shows, guest always works

## Security layers added
- Netlify Function (`netlify/functions/ai-proxy.js`): API key never reaches browser, rate limit 10 req/hr/IP, input sanitization
- CSP + HSTS + security headers in `netlify.toml`
- Firestore rules in `firestore.rules` — owner-only access, field size limits
- No API key in client-side code

## RAG flow
`searchProducts(query, trade)` → keyword scores `products.json` → top matches injected into system prompt as "VERIFIED STORE INVENTORY" block → AI prefers verified items, marks unknown items with `(*)`

## AI response format
```
NOTES: <notes>
TOOLS:
- <Tool name> | <Why>
/TOOLS
MATERIALS:
- <Item> | <Spec> | <Qty> | Aisle <n> | ~$<price>
/MATERIALS
```

## Deploy
Drag `/Users/sanchez/diagnostech-deploy/` to app.netlify.com/drop.
Set env var `ANTHROPIC_API_KEY` in Netlify site settings before going live.
Paste `firestore.rules` into Firebase Console → Firestore → Rules tab.

## Git
Repo at `/Users/sanchez/diagnostech-trade/` (branch: main)
Latest commit: security hardening (proxy, CSP, rate limiting, Firestore rules)
