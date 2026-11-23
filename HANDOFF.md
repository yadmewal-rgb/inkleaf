# Handoff

**Written:** 2026-11-23 by agy (Antigravity). **Next:** Claude Code or agy.

## What the owner asked
1. "new notebook can not be adding in laptop"
2. "add option to add new folder here and then paste" (with screenshot of Destination folder in Open PDF dialog)

## Done (v71)
1. **Fixed "+ New" Menu Crash on Laptops (`js/ui.js`, `js/library.js`)**:
   - On screens wider than 760px (laptops and desktops), mobile-only items in `newMenu` evaluated to `null`.
   - `popMenu` attempted to read `.danger` on the `null` item, causing an uncaught `TypeError` that prevented the "+ New" menu from opening on laptops.
   - Guarded `popMenu` in `js/ui.js` with `(items || []).filter(Boolean)` and added `.filter(Boolean)` to `newMenu`. The "+ New" menu now opens reliably on all screen sizes.
2. **Added New Folder Creation to Destination Folder Picker (`js/library.js`)**:
   - Added a visible **`+ New folder`** button right next to the "Destination folder" dropdown in the "Open PDF in Inkleaf" modal.
   - Also added a **`➕ Create new folder...`** option at the end of the folder select dropdown.
   - Prompts for a folder name, creates the folder in IndexedDB, and automatically selects it as the destination folder so the PDF imports directly into it.
3. **Added New Folder Creation to "Move to" Picker (`js/library.js`)**:
   - Added a `+ New folder` action at the top of the "Move to" folder list to let users create and move notebooks into a new folder in one step.
4. **PWA Version Bump (`sw.js`, `js/sync.js`)**:
   - Bumped service worker cache to `inkleaf-v71`.
   - Updated Settings to `Inkleaf v71 · Build 2026.11`.
5. **Tested in Headless Chrome**:
   - Verified "+ New" menu opening and notebook modal on desktop resolution (1200x750).
   - Verified folder creation inside PDF import dialog and auto-selection of the new folder.

## Live now
- Pushed to `origin/main` (live on https://yadmewal-rgb.github.io/inkleaf/).
- Running locally at http://localhost:8080.
