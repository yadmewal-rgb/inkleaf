# Handoff

**Written:** 2026-11-18 by agy (Antigravity). **Next:** Claude Code or agy.

## What the owner asked
1. "first check them by yourself" -> Verified all 8 Claude Code review findings directly against the code.
2. "does it not use all or any from all model ?" -> Confirmed Inkleaf was hardcoded to `gemini-1.5-flash`; planned model picker.
3. "can we add a limit usage tracker in settings" -> Planned daily request usage bar, safety limit, and page batching.
4. "go" -> Implemented model picker, usage tracker, 1-call-per-page batching, search highlight fix, and live-share security lock.

## Done
1. **Model Selector & `gemini-3.5-flash-lite` Default**:
   - `js/hwsearch.js` & `server/worker.js`: Switched default model from dead `gemini-1.5-flash` to `gemini-3.5-flash-lite`.
   - `js/sync.js`: Added Model selector dropdown in Settings (`gemini-3.5-flash-lite` [Recommended], `gemini-3.5-flash`, `gemini-3.1-flash-lite`, `gemini-2.5-flash`).
2. **Page-Level Handwriting Batching (1 Call Per Page)**:
   - `js/hwsearch.js`: Added `batchedPicture()` which stacks all ink runs of a page into a single image with red numbered labels.
   - `js/hwsearch.js`: Added `readBatch()` requesting a structured JSON array from Gemini, converting ~28 separate API requests per page into just 1 batched request per page.
3. **Daily AI Request Usage Tracker in Settings**:
   - `js/hwsearch.js`: Added `getHwUsage()`, `canMakeHwCall()`, `recordHwCall()`, and `setHwLimit()`. Auto-resets daily at midnight.
   - `js/sync.js`: Added a visual usage card in Settings showing requests used today (`X / 1,500`), a color-coded progress bar, pages count, and an editable daily safety limit.
4. **Fixed Handwriting Search Highlight Boxes**:
   - `js/editor.js`: Changed line 2520 from `R.bounds(strokes)` to `R.unionBounds(strokes)`. Search results now display accurate yellow highlight boxes over matching handwriting.
5. **Locked Down Live-Share Blob Security**:
   - `server/worker.js`: In `/live/:shareId/blob/:k/:id/:n`, added verification that requested pages (`p`), docs (`d`), and assets (`a`) strictly belong to `sh.docId`. Disallows access to folders (`f`) and snapshots (`b`).
6. **Library Search & Page Pre-Warming**:
   - `js/library.js`: Integrated handwriting search into `searchPages()` and updated the empty search state message.
   - `js/editor.js`: Pre-warms `pageIndex` memory cache on notebook open and queues pages (current page first). Re-runs search on `hw-page` completion.
7. **Re-Index Version & Cache Bump**:
   - `js/hwsearch.js`: Bumped `VER` from 1 to 2 so pages previously saved empty are cleanly transcribed with the new model.
   - `sw.js`: Bumped cache to `inkleaf-v48`.

## Live now
- Website on GitHub Pages from `main` (cache `inkleaf-v47`, releasing `inkleaf-v48`).
- Sync worker running on Cloudflare (`inkleaf-sync.yadmewal.workers.dev`).

## Owner must do
- Check Settings > Handwriting search in Inkleaf to see the new Model picker and Daily AI Request Usage tracker!

## Next step
- Commit and push v48 release to `main`.
