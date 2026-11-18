# Handoff

**Written:** 2026-11-18 by Claude Code. **Next:** agy (the owner asked the IDE to build this; Claude Code reviews after).

## What the owner asked
1. "Handwriting Search: search for words written by hand, highlighting matching strokes directly on the page."
2. After comparing options, the owner wants **Gemini Flash** as the reader (better on messy handwriting/cursive),
   called through the Cloudflare Worker. "i am asking IDE to create this and then you check it".

## Where the work is
Branch **`hw-search`** (NOT on main, nothing pushed, nothing live). Main is unchanged at 7748586 (cache v43).

- `js/hwsearch.js` — done and tested:
  - `segment(pg)`: splits a page's pen strokes (not highlighter) into lines -> words -> "runs" of up to 4 words.
    Each run keeps `ids` (all stroke ids) and `words` (stroke ids per word). Drops big drawings and long underlines.
  - `picture(run)`: the run drawn black on white (~44 px letter height) as ImageData. This is what a reader gets.
  - Per-page index in IndexedDB meta `hw:<pageId>` = `{v, pm: page.modified, r: [{k: sig(ids), t: text, ids,
    w: [{ids, t}] | null}]}`. `w` is set when the reader returned exactly one word per stroke group, so a hit
    marks just that word; otherwise the whole run is marked. Runs already read (same stroke ids) are reused.
  - Matching: `matchIndex(x, q)` / `matchPage(pg, q)` / `matchSync(pg, q)` -> `[{ids, text}]`. Case/accents ignored,
    multi-word queries, last word may be a prefix, 1-2 letter typos allowed for longer words.
  - Background queue: `queuePages(ids, pri)`, `indexAll()`, re-reads pages after `db-write` (4 s quiet) and after
    sync `remote-record`. On/off in localStorage `inkleaf.hw` (`hwOn`, `setHwOn`). Status object `status` +
    bus events `hw-status`, `hw-page`.
  - The reader today is `read(img)` -> the offline worker below. **Swap this one function for the Gemini call.**
- `js/hw-worker.js` — offline reader (TrOCR small handwritten via transformers.js 3.0.2, wasm). Works.
- `vendor/hw/` (~90 MB: transformers.min.js, ort wasm, model) is on disk but **untracked on purpose**
  (in `.git/info/exclude`): don't commit 90 MB unless the owner decides to keep the offline reader.
- `sw.js`: cache v44, separate cache `inkleaf-hw-1` (cache-first) for `/vendor/hw/` so releases don't re-download it.
- `serve.ps1`: serves `.wasm` as application/wasm.

## Test results (laptop Chrome, owner's real MAD test-paper pages)
- Offline reader got "not owned by", "5 or 4?", "doubt feel", "SC and correct", "MP 1971". Ticks, crosses and
  strike-through lines come back as junk ("v", "0", "x") — harmless, but consider ignoring runs that read as 1 char.
- Speed offline: ~1.4 s per run (wasm), ~0.7 s on WebGPU fp32 (fp32 files are ~250 MB: not worth it). Model load 5-11 s.
- Word splitting gap = 0.42 x line height; "doubt fal" came out as one word (then the whole run is marked; fine).

## NOT done (the job for the IDE)
1. **Gemini reader via the Worker.** New worker endpoint (e.g. POST /read, authenticated like the other calls)
   that takes the run pictures (PNG/JPEG, one page's runs per request, numbered) and returns one text per run.
   Key = Worker secret `GEMINI_KEY` (the owner creates it in Google AI Studio and adds it in Cloudflare; never in
   the repo, never in the app). Keep stroke positions from `segment()`: Gemini's own boxes are not needed.
   Check Gemini free-tier limits and the owner's choice on free vs paid tier (on the free tier Google may use the
   pictures to improve its products — the owner has not answered this yet).
2. **Sync the index** so one device reads and all devices can search (today `hw:<pageId>` is local only).
3. Wire into the UI (none of this is done yet):
   - editor.js `runFind` (~line 2490): add hits `{pg, rects: [R.unionBounds(items with m.ids)]}` from `matchPage`;
     on `hw-page` for this notebook re-run the find if the bar is open; queue this notebook's pages on open
     (current page first), and call `pageIndex` for each page so `matchSync` works.
   - editor.js `pageMatches` (~line 3845, pages panel): `|| (hwOn() && matchSync(pg, q).length)`.
   - library.js `searchPages` (~line 221): add a 'Handwriting' result; update the "Handwriting is not searchable
     yet" message.
   - Settings (sync.js `openSettings`): on/off switch + progress ("N pages left").
4. Test in a visible browser with screenshots (owner wants to SEE it), then on the iPad.

## Live now
- Website on GitHub Pages from `main` (cache `inkleaf-v43`). Sync worker unchanged.
- Local server may be running at http://localhost:8080/ (profile `?profile=hw` has the GoodNotes test notebook).
- `_test/` (ignored) holds a GoodNotes sample and test pages; delete when done.

## Owner must do
- Create a Gemini API key and add it as Worker secret `GEMINI_KEY` (Cloudflare > inkleaf-sync > Settings >
  Variables and Secrets).
- Say whether the Gemini free tier (pictures may be used by Google) is OK, or use the paid tier.
