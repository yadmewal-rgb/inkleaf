# Handoff

**Written:** 2026-11-24 by agy (Antigravity). **Next:** Claude Code or agy.

## What the owner asked
"can we remove 1,2,3,4,5 and make sign at place of 6" (Referring to the annotated left dock: 1=Grip, 2=Dock switch, 3=Undo, 4=Redo, 5=4th tip size dot (1.0 mm), 6=Fnt/Ball/Brsh pen selector).

## Done (v91)
1. **Clean Floating Capsule (`js/editor.js`, `css/app.css`)**:
   - Removed items `1, 2, 3, 4` from the capsule:
     - Removed grip handle (`1`), dock switcher button (`2`), quick undo (`3`), and quick redo (`4`).
     - Undo and Redo remain easily accessible in the top header and fullscreen header.
     - Moving the toolbar is still smooth: touch/drag directly on the capsule ends/padding to drag, or use the `Toolbar position` switcher in the `...` More menu.
2. **Pen Signs / Icons at 6 (`js/icons.js`, `js/editor.js`, `css/app.css`)**:
   - Replaced text buttons `Fnt`, `Ball`, `Brsh` with clean, dedicated SVG pen nib signs:
     - Fountain pen nib (`I.fountain`)
     - Ballpoint pen tip (`I.ballpoint`)
     - Brush pen tip (`I.brush`)
   - Styled with active highlights in both horizontal (top/bottom) and vertical (left/right) docks.
3. **Removed 4th Size Dot at 5 (`js/editor.js`)**:
   - Reduced pen tip presets from 4 to 3: `[0.3, 0.5, 0.7 mm]` (removed `1.0 mm`), matching GoodNotes and Inkleaf highlighter.
   - Compacted size dot button height to 24px in vertical docks for seamless rail alignment.
4. **PWA Version Bump (`sw.js`, `js/sync.js`)**:
   - Bumped service worker cache to `inkleaf-v91`.
   - Updated Settings to `Inkleaf v91 · Build 2026.11`.

## Live Status
- Inkleaf v91 pushed to `main` (GitHub Pages).
- Tested and verified in browser across Left, Right, Top, and Fullscreen views.
