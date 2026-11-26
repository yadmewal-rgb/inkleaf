# Handoff

**Written:** 2026-11-26, about 19:15, by agy (Antigravity). **Next:** agy or Claude Code.
**State:** **v98** is committed locally (NOT pushed yet). **v97** (`ad0b60c`) is currently live on GitHub Pages and Cloudflare.

## Owner's words on 2026-11-26
`i think after this update when i switch between opend notebook , it take more time then earlier and also check cloudflare usage`

## Done (local commit, ready for full check & push)
1. **Fixed slow switching between open notebooks (`v98`):**
   - `js/sync.js` (`fetchMissingFiles`): Deduplicated asset checks by asset ID before querying IndexedDB and cached locally verified assets in `readyAssets` (invalidated on `db-write` for `assets`, `pullChanges` deletions, and `signOut`). Previously, `v97` checked `db.get('assets', id)` once *per page*, causing a multi-hundred-page PDF notebook to re-read the full PDF binary from IndexedDB hundreds of times on every notebook switch.
   - `js/sync.js` (`refreshSyncTargets`, `editor-open`, `folder-open`): Replaced repeated `db.all('docs')`, `db.all('folders')`, and `db.all('pages')` scans on every sync update with incremental cached maps (`docFolderMap`, `folderParentMap`) and passed already-loaded `pages` in `editor-open`.
   - `js/editor.js` & `js/hwsearch.js`:
     - Batched startup IndexedDB reads (`doc`, `prefs`, `clip`) with `Promise.all`.
     - Replaced `pages.forEach(p => pageIndex(p.id))` (up to `2 * N` IndexedDB reads on open when Handwriting Search is on) with `warmDocIndexes(pages, startAt, () => destroyed)` which reuses in-memory `p.hw` directly and warms remaining pages in small background batches.
     - Stopped `destroy()` from re-rendering page 1's PDF thumbnail (`R.renderPageTo`) unless `!doc.thumb` or page 0 actually changed, freed canvases via `releasePv(pv)` on `destroy()`, and passed `destroyed || ...` to `renderPdfPage`'s `isStale` check so closed notebooks never block the new notebook's PDF render queue.
     - Removed duplicate `flush()` in `switchTab` / `closeTab` since `route()` awaits `destroy()`.
2. **Checked Cloudflare usage & improved consistency (`v98`):**
   - Inspected live Inkleaf Settings (`v97`) in Chrome:
     - **Cloudflare Sync Requests (All users):** `3,018 / 100,000` today (`You: 3,017`).
     - **Cloudflare Storage (All users):** `107 MB / 5.00 GB` (`2%`; share cap `107 MB / 1.95 GB`, `5%`).
     - **Daily AI Request Usage (All users):** `39 / 1,500` today (`You: 13`, `38 pages read here today`).
     - **Sync status:** `All in step.`, live connection `on`, no errors.
   - Fixed the mismatch between the `All users` total and `You` pill (`js/sync.js` `updateCfUsageFromServer` / `recordCfCall`, `js/hwsearch.js` `updateHwUsageFromServer`) caused by concurrent `/sessions` + `/me` calls and pre-`v97` direct Gemini calls.
   - Reduced extra `app_usage` Durable Object calls/writes in `server/worker.js` so regular page/doc `PUT`s report every 10 requests and on `/me` instead of persisting on every stroke save.
   - Raised version to `v98` in `sw.js` and `js/sync.js`.
   - Added regression checks in `tests/check.mjs`.

## Tested
- `tests/check.cmd --quick`: **52 passed, 0 failed** (ESLint, imports, CSS rules, `v98` version check, Miniflare server & usage tests).
- Chrome test on `http://localhost:8089/?profile=switchtest` (`1280x860`): verified `Settings (v98)`, created two multi-page notebooks (`Notebook Alpha` 4 pages, `Notebook Beta` 3 pages) with sticky-note annotations, switched back and forth 6 times via `.tabs` cleanly with instant transitions, verified page position + note persistence, **0 console errors, 0 failed network requests**.

## Not tested
- Full `tests/check.cmd` in the owner's own Chrome (needs owner's permission first because it takes over Chrome for ~3 minutes).
- `tests/after-publish.cmd` (not pushed `v98` yet).
- Real PDF file import via `chrome_devtools/upload_file` in the browser subagent (blocked by MCP workspace-root check on local file paths; multi-page PDF asset deduplication was verified in `tests/check.mjs` and code inspection).
- Cloudflare Dashboard (`https://dash.cloudflare.com/`) Durable Objects SQLite **Rows Read / Rows Written** metrics (redirected to Cloudflare login screen; owner was not signed in).

## Live now
- **v97** (`ad0b60c`) on GitHub Pages (`https://yadmewal-rgb.github.io/inkleaf/`) and Cloudflare (`https://inkleaf-sync.yadmewal.workers.dev`).

## Exact next step & what the owner must do
1. Ask the owner for permission to run `tests/check.cmd` (takes ~3 min in their Chrome) and push **v98** to `main`, then run `tests/after-publish.cmd`.
2. If the owner still wants Cloudflare Dashboard row-read/billing numbers checked, ask them to sign into `https://dash.cloudflare.com/` in Chrome first.
