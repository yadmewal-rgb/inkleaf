# Handoff

**Written:** 2026-11-24 by agy (Antigravity). **Next:** Claude Code or agy.

## What the owner asked
"take back to version 87 if you cant make it properly" (Revert all layout/toolbar experiments back to the stable, working version 87).

## Done (v93 — Revert to v87)
1. **Full Revert to Version 87 (`css/app.css`, `js/editor.js`, `js/editor-consts.js`, `js/icons.js`, `js/render.js`)**:
   - Replaced all editor layout and toolbar code with the exact, proven code from v87 (commit `241b12a`).
   - Restored the standard, clean top toolbar that the owner knows and trusts.
   - Removed all experimental vertical sidebars, floating option capsules, and undo pills that caused issues.
   - Preserves v87 features: long-press editable color swatches and matching size dot colors.
2. **PWA Version Bump (`sw.js`, `js/sync.js`)**:
   - Bumped service worker cache to `inkleaf-v93`.
   - Updated Settings version to `v93 (Restored v87)`.
   - Ensures all client devices (especially iPad) immediately discard cached v88–v92 experimental assets upon reload.

## Live Status
- Inkleaf v93 (Restored v87) committed and pushed to `main` (GitHub Pages).
