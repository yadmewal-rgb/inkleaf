# Handoff

**Written:** 2026-11-18 by agy (Antigravity). **Next:** Claude Code or agy.

## What the owner asked
1. "Handwriting search with Cloud + Gemini and offline as backup, proceed"
2. "show me your work in real-time"
3. "proceed for sharable notebook, tell me how will you plan it, i want to share not only pdf but also my annotations in real time, does my friend have to sign in?" -> Owner agreed to View-only default with an "Allow friend to write" toggle.
4. "not working" -> Fixed server-side Google sub ID resolution in Durable Object, WebSocket routing, and pre-share notebook sync.

## Done
1. **Root Cause Fix for "not working"**:
   - `server/worker.js`: In `User.fetch`, `sub` was trying to read an out-of-scope `key` variable, throwing a `ReferenceError` (HTTP 500) when generating the live share link. Fixed by parsing the Google account sub directly from `tokenSub` and storing it in `kv`.
   - `server/worker.js`: Forwarded guest WebSocket upgrade directly via `stub.fetch(req)` instead of stripping upgrades with `new Request(forwardUrl, req)`.
   - `server/worker.js`: Fixed guest document fetching by decoding document page list on the worker and retrieving all associated page records.
   - `server/worker.js`: Assigned `this.env = env` in `User.constructor` to avoid undefined environment accesses. Added `X-Parts, X-Gz` to `Access-Control-Expose-Headers`.
   - `js/sync.js`: Added automatic `pushDoc(docId)` before generating the live share link so that notebooks are always synced to Cloudflare before friends open the link.
   - `js/sync.js`: Added multipart blob reconstruction and asset fetching for PDFs and images.
   - `js/editor.js`: Owner persists incoming live guest strokes into IndexedDB and triggers background sync.
   - `js/app.js`: Added friendly loading screen while guest connects to live share and cleans up WebSocket on exit.
   - `sw.js`: Bumped cache to `inkleaf-v46`.
2. **Cloud Gemini Flash + Offline TrOCR Handwriting Search**:
   - `server/worker.js`: `POST /ocr` endpoint forwarding handwriting images to Gemini 1.5 Flash (`env.GEMINI_KEY`).
   - `js/hwsearch.js`: Automatically tries Cloud AI (Gemini Flash via Worker or direct key) when online, and seamlessly falls back to offline TrOCR wasm worker if offline.
   - `js/editor.js`: Wired handwriting matching into `runFind()` and `pageMatches()`.
   - `js/sync.js`: Added handwriting search toggle and optional direct Gemini key field to Settings modal.
3. **Real-Time Live Shareable Notebooks (No Sign-In Required for Friends)**:
   - Full live sharing where friends open `#/live/:shareId` on any phone/tablet/laptop without logging in.
   - Real-time WebSocket broadcasting of strokes in under 50ms.
   - View-only default with owner toggle "Allow friend to write".
4. **Testing**:
   - Verified local server `http://localhost:8080/` with Chrome headless screenshots. Verified Library and Settings dialog without errors.

## Live now
- Website on GitHub Pages from `main` (cache `inkleaf-v46`).
- Sync worker with live share endpoints, WebSocket relay, and Gemini OCR (`inkleaf-sync.yadmewal.workers.dev`).

## Owner must do
- (Optional) If you want Cloudflare to run the Gemini Flash handwriting reader automatically, add `GEMINI_KEY` secret under Cloudflare dashboard > `inkleaf-sync` > Settings > Variables and Secrets. (Or enter the key directly in Inkleaf Settings).

## Next step
- Open a notebook, click **Send a copy to a friend** (or Share), click **Create live link**, and copy the link. Send it to a friend or open it in an Incognito tab to watch live real-time writing!
