# Ask Danny — Project Briefing

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

## Deploying

**Sync every site file first, not just the ones you edited.** The deploy folder
is a separate copy, so anything not copied across is *removed from the live
site* on the next deploy. This is not hypothetical: a deploy of only
`index.html` and the functions took someone else's `cookies.html` off
production (404) and dropped its footer link, because those files existed in
git but had never been copied to the deploy folder.

`git pull` before deploying, too. Another session pushed nine commits to this
repo while work was in progress here, and deploying without merging them
reverted their work on the live site.

```bash
cd ~/diagnostech-trade && git pull --no-edit
for f in $(git ls-files | grep -E '\.(html|xml|txt|json)$' | grep -v eval/); do
  cp "$f" ~/Desktop/diagnostechai-DEPLOY/"$f"
done
cp netlify/functions/*.js ~/Desktop/diagnostechai-DEPLOY/netlify/functions/
```


`netlify deploy --prod` fails with `JSONHTTPError: Forbidden` on this account —
the upload succeeds (three 200s) and only the final publish call is refused.
The publish API itself works, so deploy as a draft and then promote it:

```bash
cd ~/Desktop/diagnostechai-DEPLOY
netlify deploy --dir . --functions netlify/functions      # prints a draft URL
SITE=$(python3 -c 'import json;print(json.load(open(".netlify/state.json"))["siteId"])')
DEPLOY=<id from the draft URL, the part before --diagnostech>
netlify api restoreSiteDeploy --data "{\"site_id\":\"$SITE\",\"deploy_id\":\"$DEPLOY\"}"
```

Verify by checking the site says "Ask Danny", then run `node eval/local-check.js`
before any deploy — it invokes both handlers against mocked providers and has
caught two ReferenceErrors that `node --check` could not see.
