# Handoff

**Written:** 2026-11-24 by agy (Antigravity). **Next:** Claude Code or agy.

## What the owner asked
1. "i asked to make a extra floating window so that upper portal will remain contant and lower portal will appear according to option choosen up like for pen only pens option available like goodnotes . do you understood ?" (Upper bar stays constant; lower floating window appears with options for the selected tool).
2. "in highlighter dot size are equal , make then according to their size" (Scale highlighter size dots by real thickness).
3. "also add option of dotted lines like in goodnotes" (Add dotted and dashed line options).

## Done (v88)
1. **Constant Upper Portal & Extra Lower Floating Window (`js/editor.js`, `css/app.css`)**:
   - The main upper toolbar is **100% constant**: holds all tools (`Pen`, `Highlighter`, `Eraser`, `Lasso`, `Tape`, `Text`, `Shape`, `Laser`, `Sticky`, `Insert (+)`) plus navigation and utility buttons. It never resizes, shifts, or scrolls.
   - An **extra lower floating window** (`.opts-floating`) floats directly above the notebook paper, showing ONLY the options for the tool chosen in the upper bar:
     - For Pen: Pen nib selector (`Fountain`, `Ballpoint`, `Brush`), line style (`—`, `- -`, `···`), tip sizes (0.3, 0.5, 0.7, 1.0 mm), color swatches, and favorite chips.
     - For Highlighter: Line style (`—`, `- -`, `···`), tip sizes (7px, 11px, 15px), color swatches.
     - For Eraser: Whole stroke vs Precise, eraser sizes, erase target filter.
     - For Shape: Shape types, line style (`—`, `- -`, `···`), stroke sizes, stroke colors, fill colors.
     - For Text & Tape: Text formatting, tape sizes and colors.
2. **Dotted & Dashed Lines (`js/render.js`, `js/editor.js`, `js/editor-consts.js`)**:
   - Added line style selector: Solid (`—`), Dashed (`- -`), and Dotted (`···`) for Pen, Highlighter, and Shape.
   - Canvas `setLineDash([0.01, gap])` with `round` caps renders mathematically crisp circular dots along strokes and shapes.
3. **Scaled Tip Size Dots (`js/editor.js`)**:
   - Size dots scale accurately by real thickness: Highlighter dots are 7px (small), 11px (medium), and 15px (large).
4. **PWA Version Bump (`sw.js`, `js/sync.js`)**:
   - Bumped service worker cache to `inkleaf-v88`.
   - Updated Settings to `Inkleaf v88 · Build 2026.11`.

## Live Status
- Inkleaf v88 is live on GitHub Pages.
- Includes constant upper toolbar, GoodNotes floating capsule for all tool options (pen styles, dotted/dashed/solid line styles, scaled size dots, and swatches).
