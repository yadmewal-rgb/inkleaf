# Handoff

## FIRST: v48 handwriting search review (Claude Code, 2026-11-18)

Tested v48 on the live site with the owner's notes. Working: `gemini-3.5-flash-lite`, 1 request per page,
VER 2 re-read, yellow boxes (`unionBounds`), library search. Fix these, in order:

1. **All-blank pages retry forever and burn quota (urgent).** `indexPage` in `js/hwsearch.js` throws
   "Transcriptions empty, will retry later" when every row comes back `""`, but `readBatch` already succeeded and
   `recordHwCall` counted it. Pages of ticks/crosses/lines go back in the queue at priority 9 and are re-sent every
   ~5 s. Measured live: 23 requests for 11 pages in 2 minutes. Fix: if `readBatch` returned, save the result even
   when all blank. Throw only for real failures (network, 429, 5xx, bad JSON).
2. **No back-off on real failures.** With no key, offline, or a 501 from the Worker, `run()` loops forever, re-drawing
   the page picture every 5 s. Fix: back off (e.g. 5 s, 30 s, 2 min). After ~3 failures in a row, stop the loop and
   show the error in Settings. Resume on `online`, notebook open, or new ink. Don't start at all if `!navigator.onLine`.
3. **Rows are clipped.** `batchedPicture` clamps `rh` to 120 and `rw` to 1500 but still draws at scale `k`, so tall
   writing spills into the next row. Pick `k` so the run fits: `k = min(44/lh, 5, (120 - 2*pad*k0)/h, 1500/w)`, or
   just shrink `k` until `(h + 2*pad)*k <= 120` and `(w + 2*pad)*k <= 1500`.
4. **Paid answers thrown away.** In `indexPage`, chunks of 35 runs are read one after another. If chunk 2 fails,
   chunk 1's answer is lost. Save after each chunk (or keep the partial `known` map in `mem` for the retry).
5. **Worker `/ocr` takes any `model` string.** Allow only the 4 models in the Settings list; otherwise use
   `gemini-3.5-flash-lite`. Also cap `n` (e.g. 1..40). Low risk because only ALLOWED emails sign in.
6. **"Current page first" is not done.** `editor.js` queues all pages at priority 3. Queue the open page at 1 and its
   neighbours at 2.
7. **Dead offline reader.** `indexPage` no longer uses `read()`/`hw-worker.js`, and `vendor/hw/` is not deployed.
   Remove `read()`'s worker fallback, `js/hw-worker.js`, the `HW_CACHE`/`/vendor/hw/` code in `sw.js`, and the
   "Loading offline reader backup" text in Settings (`js/sync.js`).
8. **Every device re-reads every page.** The index lives only in local meta `hw:<pageId>` and is not synced. The
   owner's iPad and laptop each spend requests on the same ~380 pages against the same Google key. Fix: sync the
   index (e.g. store `{v, pm, r}` on the page record as `hw`, or as its own synced record kind) so a page is read
   once and every device can search it. Keep stroke ids in `r[].ids` so highlights still work on other devices.
   Don't bump `pm`/`modified` when writing it, or it will look like an edit and trigger re-reads.
9. **Search filter buttons (owner's request, drawn on a screenshot).** In the library, while a search has text, show
   filter buttons in the All/Favourites row with counts: **All (37) · Handwriting (1) · Text (36)**.
   - Handwriting = results with `where === 'Handwriting'`.
   - Text = everything else (typed text, page names, PDF text).
   - Remember the last choice in localStorage. When the search box is cleared, go back to the normal All/Favourites.
   - Filter `hits` in `mountLibrary` (`js/library.js` ~line 583); no new reading needed.

Still the owner's call: `GEMINI_KEY` is not set on the Worker. Today only devices with the key typed into Settings
read handwriting.

Test: open the live site with handwriting search on. In the console, watch `getHwUsage().calls` versus pages done for
5 minutes; calls should not exceed pages by more than a few. Search a word you wrote and check the yellow box. Check
the filter buttons on the iPad. Bump `sw.js` to `inkleaf-v49`.

---

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
