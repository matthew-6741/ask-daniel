# DiagnostechAI — Setup Checklist

Ordered by what unblocks the most. **Steps 1–2 are all you need for a working
public beta.** Everything below that is optional polish.

---

## ✅ CRITICAL PATH (~10 minutes) — do these two and you're live

### 1. Get one free AI key (5 min)

Pick **either**. Groq is faster, Gemini handles photos on the free tier.
Getting both is better (photos route to Gemini automatically).

**Groq** — https://console.groq.com/keys
1. Sign in with Google
2. "Create API Key" → name it `diagnostechai`
3. Copy it (starts with `gsk_`)

**Gemini** — https://aistudio.google.com/apikey
1. Sign in with Google
2. "Create API key"
3. Copy it (starts with `AIza`)

> Both have free tiers that can carry a beta. No credit card required.

### 2. Deploy with the key set (5 min)

1. Go to https://app.netlify.com/drop
2. Drag the **`diagnostech-deploy`** folder onto the page
3. Once deployed: **Site configuration → Environment variables → Add a variable**
   - Key: `GROQ_API_KEY`   Value: your `gsk_...` key
   - and/or `GEMINI_API_KEY`  Value: your `AIza...` key
4. **Deploys → Trigger deploy → Clear cache and deploy site**
   (env vars only apply to builds that happen *after* you add them)

**Test it:** open the site, enter `TRADE2026`, tick the AI acknowledgement,
type "replace leaking P-trap under kitchen sink", hit Build.

If you see a list with aisle numbers — you're live. Share the link.

---

## OPTIONAL — add later, in this order

### 3. Claude key for the Pro tier
https://console.anthropic.com/settings/keys → Create Key → add to Netlify as
`ANTHROPIC_API_KEY`.

⚠️ **Rotate your old key first.** The key from earlier in development was
committed to git history and deployed publicly. Delete it in the console and
create a fresh one.

### 4. OpenAI key — third voice in cross-check
https://platform.openai.com/api-keys → add to Netlify as `OPENAI_API_KEY`.
Cross-check works with 1, 2, or 3 providers; missing ones are skipped.

### 5. Google Analytics
https://analytics.google.com → Admin → Data Streams → Web → copy the
Measurement ID (`G-XXXXXXXXXX`).
In `index.html`, replace **both** occurrences of `G-XXXXXXXXXX` near the top.

### 6. Firebase — accounts, saved history, Pro plans
https://console.firebase.google.com
1. Create project → add a **Web app**
2. **Authentication** → enable Email/Password and Google
3. **Firestore** → create database
4. **Firestore → Rules** → paste the contents of `firestore.rules` → Publish
5. Copy the config object into `FIREBASE_CONFIG` in **both** `index.html`
   and `login.html`

Until this is done the app runs in guest-only mode, which is fine for a beta.

To make yourself Pro: in Firestore, open your `users/{uid}` doc and set
`plan` to `"pro"`.

### 7. GitHub
`gh` CLI is installed and authenticated as `matthew-6741`:

```bash
cd ~/diagnostech-trade && gh repo create diagnostechai --private --source=. --push
```

Keep it **private** — the access code is in the source.

---

## Known gaps (not blockers)

- **Aisle numbers are unverified estimates.** This is the product's core
  promise and its weakest data. Verifying one local store beats any new feature.
- **Cross-check counters reset on cold start.** Fine as a deterrent; move them
  to Firestore before charging money.
- **`resolveTier()` trusts the client.** Anyone can set themselves to Pro in
  devtools. Harmless while everything is free — must verify a Firebase ID token
  server-side before there's a paywall.
- **No error reporting.** If the parser breaks for a user, you'll never know.
