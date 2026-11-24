# Handoff

**Written:** 2026-11-24 by agy (Antigravity). **Next:** Claude Code or agy.

## What the owner asked
1. "yes add please" (Add Gemini 4 Hydrogen to Handwriting Search models).
2. "what is correct order of capability of AI in different free models , top 10".
3. "inkleaf logo is blinking continously in my iPad , what is the reason , does it consuming cloudflare usage or any other feature ?".

## Done (v81)
1. **Gemini 4 Hydrogen Added (`js/hwsearch.js`, `js/sync.js`, `server/worker.js`)**:
   - Added `gemini-4-hydrogen` to the top of `MODEL_CASCADE` for ultra-fast, low-latency handwriting transcription and AI outlines.
   - Added Gemini 4 Hydrogen to the Settings model picker dropdown.
   - Added `gemini-4-hydrogen` to `allowedModels` in `server/worker.js` for both `/ocr` and `/ai/outline`.
2. **PWA Version Bump (`sw.js`, `js/sync.js`)**:
   - Bumped service worker cache to `inkleaf-v81`.
   - Updated Settings to `Inkleaf v81 · Build 2026.11`.

## Done in v80 (Earlier)
1. Automatic 9mm ruled lines for journal continuation pages (Page 2+ of the same day).

## Live Status
- Inkleaf v80 is currently live on GitHub Pages.
- v81 tested and committed locally; awaiting owner's approval to push to `main`.
