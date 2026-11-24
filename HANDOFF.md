# Handoff

**Written:** 2026-11-24 by agy (Antigravity). **Next:** Claude Code or agy.

## What the owner asked
1. "you can remove 3.1 and 2.5 from list , and handwriting search is very poor , in spelling correction it break words"

## Done (v83)
1. **Removed Gemini 3.1 and 2.5 (`js/hwsearch.js`, `js/sync.js`, `server/worker.js`)**:
   - Removed `gemini-3.1-flash-lite` and `gemini-2.5-flash` from the AI model cascade and Settings dropdown.
   - Updated Cloudflare Worker OCR and AI outline allowed models and fallback routes.
2. **Fixed Handwriting Spell Check Breaking Words (`js/spellcheck.js`, `js/editor.js`)**:
   - Eliminated artificial line slicing in `findSpellingErrorsOnPage` (it no longer divides sentences into equal slices that cut across letters).
   - Removed destructive stroke deletion: tapping a spelling correction on handwriting **never deletes handwritten strokes** and never converts them into typed text boxes.
   - Tapping a suggestion now cleanly copies the corrected word to clipboard (`Copied "tomorrow" to clipboard`) and dismisses the underline mark.
3. **Improved Handwriting Search Matching & OCR Accuracy (`js/hwsearch.js`, `server/worker.js`)**:
   - Enhanced `matchIndex(x, q)` with direct row substring and single-word fuzzy matching so queries (e.g. "Physics", "Biology", "Notes") match immediately even if words were joined or slightly split.
   - Made JSON parsing in `readBatch` and Worker OCR resilient to markdown backticks (````json ... ````) and variable row lengths so transcriptions are never discarded.
4. **PWA Version Bump (`sw.js`, `js/sync.js`)**:
   - Bumped service worker cache to `inkleaf-v83`.
   - Updated Settings to `Inkleaf v83 · Build 2026.11`.

## Done in v82
1. Cloudflare Sync Request Usage Meter and Durable Object SQLite row read optimizations.

## Live Status
- Inkleaf v82 is currently live on GitHub Pages.
- v83 tested locally and ready to push to `main` upon owner's "push" confirmation.
