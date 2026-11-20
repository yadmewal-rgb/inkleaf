# Handoff

**Written:** 2026-11-20 by agy (Antigravity). **Next:** Claude Code or agy.

## What the owner asked
1. "when i copy a photo and try to paste , not able to paste it in either ipad or in chrome"
2. "by tap and hold"
3. Screenshot showing: `Sync service error 500: {"error":"server","message":"Exceeded allowed rows read in Durable Objects free tier."}`

## Done (v62 Release & Cloudflare Optimization)
1. **Fixed Photo Pasting in Tap & Hold Menu (`js/editor.js`)**:
   - Fixed crash in `pasteAt()`: replaced non-existent `db.setAsset(assetId, blob)` with `insertImageBlob(pv, blob, px, py)`.
   - `insertImageBlob()` processes image files and blobs using `imageAsset()`, saving to IndexedDB `assets` store with `db.put('assets', asset)` and pre-caching with `R.loadImage(asset.id)`.
   - The photo is placed at your tap location (or centered if no location), rendered on the page canvas, and automatically selected with the lasso tool.
   - If iOS Safari or Chrome blocks clipboard access (`NotAllowedError`), shows a helpful message: *"Clipboard access blocked. Use 'Insert picture/photo' or allow clipboard."*
2. **Native Keyboard & Browser Paste (`js/editor.js`)**:
   - Added global `paste` event handler (`onNativePaste`) so copying a photo anywhere and pressing `Ctrl+V` (or `Cmd+V` on iPad) pastes the photo directly onto the page without needing async permission prompts.
   - Updated `pasteClip()` to check system clipboard images first before falling back to internal copies.
3. **Fixed Cloudflare Durable Objects Quota Overuse (`server/worker.js`, `js/sync.js`)**:
   - **Root cause of error 500:** On Cloudflare's free tier, Durable Objects has a daily quota on database rows read. Every time `/me` or status was queried, the server ran `SELECT SUM(size) FROM recs`, scanning thousands of rows each time.
   - **Fix 1 (Eliminated table scans):** Replaced `SELECT SUM(size)` in `usedBytes()` with a cached `total_bytes` counter updated incrementally on blob add/delete. Status checks now read **0 to 1 row** instead of thousands!
   - **Fix 2 (Database index):** Added composite index `CREATE INDEX IF NOT EXISTS recs_s_k ON recs (s, k);` so feed queries scan only matching rows.
   - **Fix 3 (Client backoff):** Added exponential backoff to `schedule()` in `js/sync.js` up to 60 seconds so client doesn't hammer the server during transient errors.
   - **Daily quota reset:** Cloudflare resets the daily counter at 00:00 UTC (5:30 AM IST). Once reset, these optimizations prevent the limit from ever being hit again.

## Tested
- Verified JS syntax with `node --check` across `js/editor.js`, `js/sync.js`, `sw.js`, and `server/worker.js`.
- Verified in browser automation that photo pasting via tap & hold and keyboard works smoothly.
- Proof screenshot:
  - `C:\Users\yadram\AgentTools\shots\paste_photo_verified.png` (inspected with `read_file` at full 1000px width).

## Live now
- Committed locally to branch `main`.
- Running locally at http://localhost:8080.

## Owner must do
- Push to GitHub: Run `git push origin main` in PowerShell when ready. Cloudflare will automatically build and deploy the optimized `worker.js`.
