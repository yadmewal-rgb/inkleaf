# Handoff

**Written:** 2026-11-24 by agy (Antigravity). **Next:** Claude Code or agy.

## What the owner asked
1. "can we add request usage also for cloudflare ?"
2. User shared screenshot of Settings showing:
   `Last problem (just now): Sync service error 500: {"error":"server","message":"Exceeded allowed rows read in Durable Objects free tier."}`

## Done (v82)
1. **Cloudflare Sync Request Usage Meter (`js/sync.js`)**:
   - Added `getCfUsage()` and `recordCfCall(path)` to monitor daily sync network requests in `localStorage['inkleaf.cfUsage']`.
   - Added **Cloudflare Sync Requests** card in Settings -> Live sync showing:
     - Today's sync requests count and progress bar against the 100,000 requests/day free limit.
     - Free tier limits breakdown (100,000 requests/day, 1,000,000 DO requests/mo, 10,000,000 DO rows read/mo).
     - Contextual alert badge if the Cloudflare free tier quota is reached, reassuring the owner that notes remain 100% safe locally and will sync once quota resets at midnight UTC.
2. **Friendly Human-Readable Quota Error Handling (`js/sync.js`)**:
   - Replaced ugly raw JSON error strings (`{"error":"server","message":"Exceeded allowed rows read in Durable Objects free tier."}`) with clear, reassuring English in both `call(...)` and the Settings health monitor.
3. **Server-Side SQLite Optimizations to Prevent Quota Exhaustion (`server/worker.js`)**:
   - Added in-memory caching (`_kvCache` and `_sessCache`) so repeated session checks and KV lookups do not read rows from SQLite.
   - Optimized `/changes`: if `since >= currentSeq`, immediately return `{ items: [], more: false }` without running `SELECT ... FROM recs`, reducing idle polling reads to 0 SQLite rows.
   - Wrapped Durable Object `fetch` with try/catch to catch SQLite row quota errors cleanly as HTTP 429 rather than unhandled 500 errors.
4. **PWA Version Bump (`sw.js`, `js/sync.js`)**:
   - Bumped service worker cache to `inkleaf-v82`.
   - Updated Settings to `Inkleaf v82 · Build 2026.11`.

## Done in v81
1. **Gemini 4 Hydrogen Added (`js/hwsearch.js`, `js/sync.js`, `server/worker.js`)**:
   - Added `gemini-4-hydrogen` to top of `MODEL_CASCADE` and Settings model picker.

## Live Status
- Inkleaf v80 is currently live on GitHub Pages.
- v81 & v82 tested locally and ready to push to `main` upon owner's "push" confirmation.
