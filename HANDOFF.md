# Handoff

**Written:** 2026-11-24 by agy (Antigravity). **Next:** Claude Code or agy.

## What the owner asked
1. "make it in single line for left and right sidebar" (Single-column vertical layout for left and right docked positions).

## Done (v90)
1. **Single-Column Vertical Rail (`css/app.css`, `js/editor.js`)**:
   - For `Left` and `Right` dock positions, the floating capsule is now an ultra-sleek **single vertical line**:
     - Width is only **32px - 36px** with rounded pill ends (`border-radius: 9999px`), maximizing the handwriting area on iPad.
     - Single vertical column: Grip (`⋮⋮`), Dock icon, Undo, Redo, Nib styles, Line dashes (`—`, `- -`, `···`), Tip size dots, and all 8 color swatches + rainbow color picker.
     - Nib labels automatically show compact forms (`Fnt`, `Ball`, `Brsh`) in vertical mode and full names in horizontal mode.
     - Size mm text pill is hidden in vertical mode to stay razor-thin (tooltips still show exact mm).
     - Proportional compact spacing so the entire vertical palette fits on screen without any items getting cut off.
2. **PWA Version Bump (`sw.js`, `js/sync.js`)**:
   - Bumped service worker cache to `inkleaf-v90`.
   - Updated Settings to `Inkleaf v90 · Build 2026.11`.

## Live Status
- Inkleaf v90 is live on GitHub Pages.
- Tested across Left and Right single-line sidebars, Top, Bottom, and Fullscreen modes.
