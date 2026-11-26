# Handoff

**Written:** 2026-11-26, about 19:21, by agy (Antigravity). **Next:** agy or Claude Code.
**State:** **v98** (`055440f`) is pushed and live everywhere. Working tree has only this handoff note committed locally (not pushed, so it goes up with the next release without triggering an extra build).

## Live now
- App **v98** (commit `055440f`) on GitHub Pages (`https://yadmewal-rgb.github.io/inkleaf/`).
- Sync service (`server/worker.js` from `055440f`) on Cloudflare (`https://inkleaf-sync.yadmewal.workers.dev`); Cloudflare build `success`, `tests/after-publish.cmd`: **ALL GOOD**.

## Owner's words on 2026-11-26
1. `i think after this update when i switch between opend notebook , it take more time then earlier and also check cloudflare usage`
2. `push live`

## Done in v98 (`055440f`)
1. **Faster open-notebook tab switching (`js/sync.js`, `js/editor.js`, `js/hwsearch.js`):**
   - `fetchMissingFiles` deduplicates by asset ID before checking IndexedDB and caches locally verified assets in `readyAssets` (no more N-per-page full PDF reads on tab switch).
   - `refreshSyncTargets` uses incremental cached `docFolderMap` / `folderParentMap` instead of full `db.all('docs')` / `db.all('folders')` scans on every sync tick.
   - `mountEditor` batches startup reads (`Promise.all`), uses `warmDocIndexes` instead of `pages.forEach(p => pageIndex(p.id))`, passes `pages` to `editor-open`, skips redundant `flush()` in `switchTab`/`closeTab`, and in `destroy()` frees canvases (`releasePv`), marks `destroyed` in `renderPdfPage` stale checks, and skips re-rendering page 1's thumbnail unless `!doc.thumb` or page 0 changed.
2. **Cloudflare usage & counter consistency (`js/sync.js`, `js/hwsearch.js`, `server/worker.js`):**
   - Checked live Inkleaf Settings (`v97` before push): Cloudflare Sync Requests `3,018 / 100,000`, Cloudflare Storage `107 MB / 5.00 GB (2%)`, Daily AI Request Usage `39 / 1,500`, sync status `All in step.`.
   - Kept the `You` usage pill consistent with `totalCalls` across concurrent Settings calls and pre-`v97` direct Gemini calls.
   - Reduced extra `app_usage` Durable Object writes during regular stroke/page `PUT`s.
   - Added regression checks in `tests/check.mjs`; bumped `sw.js` & `js/sync.js` to `v98`.

## Tested
- `tests/check.cmd --quick`: **52 passed, 0 failed**.
- `tests/after-publish.cmd`: **ALL GOOD** (`website inkleaf-v98`, Cloudflare build `success`, sync server answers `yes`).
- Visible Chrome test on `http://localhost:8089/?profile=switchtest`: `Settings (v98)`, 6 tab switches between two multi-page notebooks with persistent notes, **0 console errors, 0 failed network requests**.

## Not tested
- Full `tests/check.cmd` in the owner's Chrome (`spawn(chrome.exe)` from this background runner could not open a tab: `the check tab did not open in Chrome`; `tests/check.cmd --quick` passed 52/52).
- Real PDF file import via `chrome_devtools/upload_file` (blocked by MCP workspace-root check on local paths; multi-page PDF asset deduplication verified via `tests/check.mjs` and code review).
- Cloudflare Dashboard (`https://dash.cloudflare.com/`) SQLite row-read/billing metrics (login page required).
- Real iPad / real multi-user PDF switching on live **v98**.

## What the owner must do
1. Reload Inkleaf twice on iPad, phone, and other devices until Settings shows **v98**, and test switching between open PDF notebooks on the iPad.
2. Open Settings once on any friend accounts so they register in the cumulative usage tracker.
3. Optional: if you still want Cloudflare Dashboard's internal SQLite row-read charts checked, sign into `https://dash.cloudflare.com/` in Chrome and ask.
