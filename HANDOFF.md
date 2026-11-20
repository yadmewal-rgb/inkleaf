# Handoff

**Written:** 2026-11-20 by agy (Antigravity). **Next:** Claude Code or agy.

## What the owner asked
"while taking notes or marking on pdf , pdf slides due to accidental touch on scrollbar on the right edge , how can we solve this ?"

## Done (v56 Release)
1. **Accidental Palm Touch Prevention on Scrollbar (`js/editor.js`, `css/app.css`)**:
   - **Auto-hides during handwriting/annotation**: The scrollbar is now hidden (`opacity: 0; pointer-events: none;`) while writing notes. The right margin is completely inert, so a resting palm cannot touch or trigger it.
   - **Smooth appearance on scroll**: When two fingers scroll or pages glide, the scrollbar smoothly appears (`opacity: 1; pointer-events: auto;`), and automatically fades away 1.4 seconds after scrolling stops.
   - **Touch Palm Rejection**: If the stylus is on the screen or was used within the last 800ms (`PALM_MS`), touches on the scrollbar are completely ignored.
   - **No Track-Tap Jumps on Touch**: On touch devices, tapping or touching the empty track no longer jumps the page. Only intentionally dragging the thumb pill moves the view.
2. **Scrollbar Placement Options in More Menu (`js/editor.js`, `js/editor-consts.js`)**:
   - Added a menu option in the More (`...`) menu: **`Scrollbar: auto-hide (right edge) | left edge | hidden`**.
   - Right-handed writers can move the scrollbar to the **left edge** away from the resting palm, or hide it entirely if they prefer two-finger scrolling.
3. **App Version & Cache**:
   - Bumped service worker cache to `inkleaf-v56` in `sw.js`.
   - Bumped app version to `v56` in `js/sync.js`.

## Tested
- Verified JS syntax with `node --check js/editor.js`, `js/sync.js`, `js/editor-consts.js`, `sw.js`.
- Ran automated browser test via Edge CDP in Inkleaf editor:
  - Verified resting scrollbar is hidden and inert (`pointer-events: none`).
  - Verified scrolling flashes scrollbar with page count indicator (`2 / 4`).
  - Verified More menu item `Scrollbar: auto-hide (right edge)`.
  - Verified cycling between `left edge`, `hidden`, and `auto-hide (right edge)`.
- Combined screenshot saved and verified:
  - `C:\Users\yadram\AgentTools\shots\scrollbar_fix_row.png`

## Live now
- Committed locally to branch `main`.
- Running locally at http://localhost:8080.

## Owner must do
- Push to GitHub: Run `git push origin main` in PowerShell when ready to release `v56` to GitHub Pages.
