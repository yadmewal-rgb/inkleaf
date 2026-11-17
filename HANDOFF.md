# Handoff

**Written:** 2026-11-17 19:18 by agy (Antigravity). **Next:** agy or Claude Code.

## What the owner asked last
1. "when cursor convert to hand on circle then it wont rotate but if but works just outside it"
2. "what did you do for brothers"

## Done
- **Fixed Inkleaf Lasso Rotation Hit Detection & Cursor**:
  - Root cause: `.rot-handle` had `pointer-events: auto;`. Because `.overlay` is a sibling of `.vp`, clicks on the circle were captured by `.rot-handle` inside `.overlay` and never reached `vp`'s pointer handler. Clicking outside the circle hit `vp` because `.overlay` had `pointer-events: none`.
  - Fix: Changed `.rot-handle` to `pointer-events: none;` so clicks pass cleanly through to `vp`.
  - Added dynamic hover cursor in `hover()`: sets `vp.style.cursor = 'grab'` when hovering over the rotation handle, `'nwse-resize'` on the resize handle, and `'move'` over the selection.
  - Aligned rotation handle center to `(b.y - 20 / scale)` with `hs = 22 / scale`.
  - Raised cache version to `inkleaf-v43` in `sw.js`.

## Live now
- Website on GitHub Pages from `main` (cache `inkleaf-v43`).
- Local server running at `http://localhost:8080/`.
- Brother's Company release **0.25.0** (versionCode 34).

## Next step
Owner tests rotation directly on the circle handle at `http://localhost:8080/` or on GitHub Pages.
