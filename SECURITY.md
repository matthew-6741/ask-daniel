# Security Policy

## Reporting a vulnerability

Email **matthewsanchez00024@gmail.com** with `SECURITY` in the subject line.

Please include what you found, the steps to reproduce it, and what an attacker could do with it. A proof of concept helps.

- I'll acknowledge your report within **72 hours**.
- I'll follow up with an assessment and a fix timeline within **7 days**.
- Please give me 90 days before disclosing publicly.

Do not open a public GitHub issue for a security report.

## Scope

In scope:

- `diagnostechai.com` and its Netlify Functions
- This repository's source
- Firestore access rules

Out of scope:

- Denial of service and volumetric testing
- Findings that require physical access to a user's device
- Reports from automated scanners with no demonstrated impact
- Social engineering

## What this app does with your data

- **The Anthropic API key is never exposed to the client.** Model calls go through a serverless proxy that reads it from the environment.
- Guest users' job history stays in `localStorage` and is never transmitted.
- Signed-in users' history is stored in Firestore under rules that restrict every document to its owner.
- No payment data is collected.

## Supported versions

DiagnostechAI is a continuously deployed web app in private beta. Only the currently deployed version at `diagnostechai.com` is supported — there are no tagged releases to patch.
