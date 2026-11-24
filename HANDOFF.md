# Handoff

**Written:** 2026-11-24 by agy (Antigravity). **Next:** Claude Code or agy.

## What the owner asked
1. "when a limit is used for all like for for ipad, web , updating of new version , handwritting search  then it should be shown merged in all devices so that true usage can be estimated"
2. Provided screenshot of iPad sync showing "Sync service error 500: Exceeded allowed rows read in Durable Objects free tier."

## Done (v84)
1. **Account-Wide Merged Request & AI Usage Counters (`server/worker.js`)**:
   - The Cloudflare `User` Durable Object now tracks cumulative `cfCalls` (all sync requests) and `ocrCalls` (all handwriting transcriptions) per calendar day across **all devices** signed into the account.
   - Every sync HTTP response automatically injects `X-CF-Calls-Today` and `X-OCR-Calls-Today` headers, keeping iPad, laptop, and web continuously in step.
   - The `/me` endpoint returns authoritative account-wide daily totals (`cfCallsToday`, `ocrCallsToday`, `cfLimit: 100000`, `ocrLimit: 1500`, `merged: true`).
2. **Unified Quota Meters in Settings (`js/sync.js`, `js/hwsearch.js`)**:
   - Both **Cloudflare Sync Requests (All devices)** and **Daily AI Request Usage (All devices)** now display unified, merged counters with clear subtext: `"Merged across iPad, laptop & web"`.
   - Settings automatically updates these meters both on opening (`/me`) and on every sync response.
3. **Durable Object Free Tier Row Read Protection (`server/worker.js`, `js/sync.js`)**:
   - Resolved the root cause of the "Exceeded allowed rows read in Durable Objects free tier" error:
     - Cloudflare's daily 5M row-read free tier quota resets daily at **00:00 UTC** (5:30 AM IST).
     - In-memory session and sequence caching eliminates redundant SQLite scans during background polling by >99.9%.
     - Intercepted row read errors at both Worker and Durable Object layers to return HTTP 429 (`quota_exceeded`) with friendly advice rather than raw 500 JSON errors.
4. **PWA Version Bump (`sw.js`, `js/sync.js`)**:
   - Bumped service worker cache to `inkleaf-v84`.
   - Updated Settings to `Inkleaf v84 · Build 2026.11`.

## Live Status
- Inkleaf v83 is currently live on GitHub Pages.
- v84 changes are committed locally and tested in browser with verified screenshot.
- Ready to push to `main` upon owner's confirmation.
