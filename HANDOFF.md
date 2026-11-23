# Handoff

**Written:** 2026-11-23 by agy (Antigravity). **Next:** Claude Code or agy.

## What the owner asked
"all" (add all Apple Pencil Pro features: Barrel Roll nib rotation, Hover Cursor Preview, Tilt Shading, and Apple Pencil Only strict palm rejection).

## Done (v73)
1. **Barrel Roll Nib Rotation (`PointerEvent.twist`) (`js/editor.js`)**:
   - WebKit exposes `e.twist` (0°–359°) for Apple Pencil Pro.
   - Added **Calligraphy (Roll nib)** pen style: rotating the pencil barrel smoothly rotates the calligraphy nib angle in real-time, allowing instant switching between thin edges and broad flourishes.
   - Enhanced **Highlighter**: rolling the pencil rolls the chisel tip between full broad highlight (0°/180°) and thin precision underline (90°/270°).
2. **Hover Cursor Preview (`css/app.css`, `js/editor.js`)**:
   - Floating `.pen-hover-cur` indicator displayed when Apple Pencil Pro / stylus hovers up to 12 mm above the glass.
   - Displays exact stroke thickness, active color, and real-time nib rotation angle before the tip touches down.
   - Smoothly auto-hides during active drawing and when the pencil leaves the screen.
3. **Tilt-to-Shade (`e.altitudeAngle` / `e.tiltX`, `e.tiltY`) (`js/editor.js`)**:
   - Added tilt detection for **Pencil (Tilt shade)** style.
   - Upright pencil creates sharp, fine graphite sketching lines.
   - Tilting the pencil flat against the screen (< 35°) automatically broadens the stroke into soft, grainy graphite shading.
4. **Strict "Apple Pencil Only" Mode (100% Palm Rejection) (`js/editor-consts.js`, `js/editor.js`)**:
   - Added toggle to Pen menu and More menu.
   - When enabled, single/multi-finger touches can NEVER leave accidental ink marks or stray dots; fingers are strictly reserved for scrolling and pinch-zooming.
   - Only the Apple Pencil (`pointerType === 'pen'`) draws ink.
5. **PWA Version Bump (`sw.js`, `js/sync.js`)**:
   - Bumped service worker cache to `inkleaf-v73`.
   - Updated Settings to `Inkleaf v73 · Build 2026.11`.
6. **Automated Verification**:
   - Verified pen menu options, barrel roll stroke rendering, hover cursor preview, tilt shading, and palm lock via Chrome CDP.
   - Captured and verified showcase screenshots.

## Done in v72 (Earlier today)
1. **Resume Last Active Page on Any Notebook Click (`js/library.js`, `js/app.js`, `js/editor.js`)**:
   - Clicking ANY notebook in the library navigates directly to the last active page via `#/d/<id>?p=<lastPage>`.
   - Cards display `Page X of Y` subtitle.
2. **Sidebar Studio Navigation, Jump Back In, Folder Colors, Drag & Drop, Pinning, Multi-Select**.

## Local Status
- Clean local build, tested at http://localhost:8080.
- Changes committed locally (v72 and v73). Ready to push to `origin/main` upon owner confirmation.
