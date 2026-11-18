# Handoff

**Written:** 2026-11-18 by agy (Antigravity). **Next:** Claude Code or agy.

## What the owner asked
1. "first check them by yourself" -> Verified all 9 review findings left by Claude Code.
2. "yes" -> Implemented all fixes across the app, worker, and service worker.

## Done (v49 Release)
1. **Urgent Quota Leak Fixed (`js/hwsearch.js`)**:
   - Removed the artificial `throw new Error('Transcriptions empty, will retry later')` when pages contained only marks/ticks/crosses.
   - All-blank / non-text ink pages now save once as indexed instead of re-entering the queue at priority 9 and looping indefinitely every 5 seconds.
2. **Exponential Back-Off & Safe Pausing (`js/hwsearch.js`)**:
   - Added back-off on failures (5s, 30s) and automatic pausing after 3 consecutive errors to protect daily API quotas.
   - Added `!navigator.onLine` check to avoid running while offline. Automatically resumes via `window.addEventListener('online', ...)`.
3. **Prevented Row Clipping in Batched Images (`js/hwsearch.js`)**:
   - In `batchedPicture()`, scaled `k` down when `rawW * k > 1500` or `rawH * k > 120`. Handwriting never overlaps across row lines.
4. **Preserved Multi-Chunk Work Across Retries (`js/hwsearch.js`)**:
   - Added `partialMem` cache. If page transcription requires multiple 35-run chunks and a later chunk fails, previous chunk results are preserved without re-calling the API.
5. **Cross-Device Handwriting Index Sync (`js/hwsearch.js`)**:
   - Added `saveHw(pg, x)`: writes `{v, pm, r}` to the local IndexedDB metadata and attaches it to `pg.hw` on the page record without modifying `pg.modified`.
   - Updated `pageIndex(pageId)`: reads synced `pg.hw` first. The owner's iPad and laptop now share the indexed handwriting, eliminating duplicate API calls for the same notes.
6. **Current Page First Priority (`js/editor.js`)**:
   - In `mountEditor`, queued active page at priority 1, neighbor page at priority 2, and other pages at priority 3.
   - In `scrollToPage(i)`, re-prioritized the newly visible page to priority 1 if `hwOn()`.
7. **Search Filter Chips in Library (`js/library.js`)**:
   - Added filter chips above page search results: `All (X) · Handwriting (Y) · Text (Z)`.
   - Filter selection persists in `localStorage.getItem('inkleaf.searchFilter')`.
   - Instantly filters results between handwriting and typed/PDF text without re-querying the database.
8. **Cloudflare Worker `/ocr` Whitelist & Cap (`server/worker.js`)**:
   - Restricted `model` parameter to allowed Gemini models (`gemini-3.5-flash-lite`, `gemini-3.5-flash`, `gemini-3.1-flash-lite`, `gemini-2.5-flash`), defaulting to `gemini-3.5-flash-lite`.
   - Capped `n` parameter between 1 and 40.
9. **Dead Worker & Model Cache Cleanup (`sw.js`, `js/sync.js`, deleted `js/hw-worker.js`)**:
   - Deleted `js/hw-worker.js`.
   - Removed `HW_CACHE` and offline worker references from `sw.js`. Service worker activation now reclaims ~90 MB of storage on clients.
   - Cleaned up offline reader backup strings in Settings.
   - Bumped service worker cache to `inkleaf-v49`.

## Live now
- Website on GitHub Pages from `main` (releasing `inkleaf-v49`).
- Sync worker running on Cloudflare (`inkleaf-sync.yadmewal.workers.dev`).

## Owner must do
- Nothing required! The app updates automatically to v49 on next visit. You can test typing a handwritten word in the search box in the Library to test the new All / Handwriting / Text filter buttons.
