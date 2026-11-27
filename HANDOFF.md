# Handoff

**Written:** 2026-11-27, 13:00, by agy (Antigravity). **Next:** Claude Code or agy.
**State:** committed locally on `main` (NOT pushed to `origin/main` yet). Full `tests/check.cmd` in the owner's Chrome is still waiting for the owner's yes.

## What the owner asked
"read handoff, in INKleaf project check every line, remove unnecessary code and lines of features which we removed , detect any conflicting commands"

## Live now
- App **v100** (`999a7a1`) on GitHub Pages; sync server from `999a7a1`.
- Local `main` has the cleaned **v101** code (plus two prior handoff doc commits from 2026-11-26) committed locally, not pushed.

## Done (v101 — local only, waiting for full check + push)
1. **Removed leftover code and styles from removed or replaced features:**
   - `js/icons.js`: removed unused `layers` (Layers feature) and `pin` (replaced by `bookmark`).
   - `js/library.js`: removed leftover `dot-red` .. `dot-purple` class entries in `FOLDER_COLORS` (replaced by whole-folder `fc-*` classes in v99).
   - `css/app.css`: removed `.folder-dot`, `.dot-red`..`.dot-purple`, `.tag-folder-ic` (replaced by `.folder-ic`), `.flip-status-tag.time-mode` (old Pomodoro mode), `.hl-text` / `.tag-c.hl-shot` (old Highlights view), and `.usage-text` (old quota label); fixed `.cal-fire` to use `pulseDot` instead of missing `@keyframes pulse`.
   - `js/hwsearch.js`: updated stale comments mentioning the removed offline `js/hw-worker.js` / `90 MB` download / `(gemini-3.8-flash)`, and removed dead `IDLE_MS`, `DEFAULT_MODEL`, `getHwModel()`, `indexText()`, and `retryHw()`.
   - `js/editor-consts.js`: removed orphaned trailing comment.
2. **Removed dead variables, redundant code, and unreachable checks:**
   - `js/spellcheck.js`: removed unused `lev()` function and self-mapping `colleague: ['colleague']`; reused `userDict` in `getCandidates()` instead of reading `localStorage` twice per unknown word.
   - `js/editor.js`: removed unused `changed` state flag and dead writes, unused destructured `pv`, unused callback args (`n`, `p`, `slotIdx`), unused `const m`, and unused `defaultDots` parameter in `sizes()` across its 5 call sites.
   - `js/pdftools.js`: removed unused `x` coordinate in `generatePdfOutline()`'s fallback heading scan and redundant `if (sRes.ok)` check after `call()`.
   - `js/sync.js`: removed unused `getHwModel` / `MODEL_CASCADE` imports; removed dead `if (!r.ok)` inside `syncOcr()` (since `call()` throws on HTTP errors) and preserved HTTP status in error objects; wrapped `/admin/users` `POST`/`DELETE` in `try/catch` inside `drawAllowedUsers()` so errors actually show a toast instead of throwing before dead `if (!res.ok)` checks.
   - `sw.js`: removed unused loop variable `k` in Share Target POST handler; bumped cache to `inkleaf-v101` (matching `APP_VER = 'v101'` in `js/sync.js`).
3. **Fixed conflicting commands:**
   - **Touch hold menu vs stylus / native `contextmenu` (`js/editor.js`):** skipped `startPointerHold` on `pen` pointers and non-primary buttons (`button !== 0 || (buttons & 34)`) so barrel-button erasing and hold-to-straighten/shape never cancel or pop a menu unexpectedly; added `holdFired` and `lastPenEraseT` guards so Android/Windows native `contextmenu` does not open a duplicate popup after `holdTimer` or after lifting the pen eraser button.
   - **Keyboard `Ctrl/Cmd+V` vs native `paste` (`js/editor.js`):** added `lastKeyPasteT` guard in `onNativePaste()` so browsers where `preventDefault()` on `keydown` `'v'` still fires `paste` (e.g. WebKit/Safari) do not paste twice, while right-click Paste and Edit > Paste still work.
   - **Apple Pencil only vs Finger drawing & Open view-only (`js/editor.js`):** made `openRead()` respect `!prefs.applePencilOnly` so strict Apple Pencil mode does not lock a fresh iPad into view-only; showed `Finger drawing: off (Apple Pencil only is on)` when `applePencilOnly` is active and automatically turn `applePencilOnly` off if the user turns finger drawing back on; unified menu wording (`Apple Pencil only`, `Pencil hover preview`).
   - **`Escape` key vs open popup menus (`.pop`) (`js/ui.js`):** pressing `Escape` now closes an open `.pop` menu (`popMenu` / `popover`) and stops propagation so it does not change fullscreen or clear selection behind an open menu first.
   - **Gemini AI model mismatch (`js/pdftools.js`, `js/sync.js`, `server/worker.js`):** `generatePdfOutline()` now uses `getActiveHwModel()` instead of stale `gemini-3.5-flash-lite` or literal `'auto'`; `syncUserSettings()` now syncs `geminiModel` across devices; `server/worker.js` shares one `GEMINI_MODELS` allow-list across `/ocr` and `/ai/outline` and defaults `'auto'`/unset to `'gemini-4-hydrogen'` (matching client `MODEL_CASCADE[0]`).

## Tested
- `node tests/check.mjs --quick`: **56 passed, 0 failed** (all 21 JS files ESLint-clean, imports, CSS rules, `sw.js`/`APP_VER` `v101` version sync, all 29 Miniflare sync-server tests).
- Visible Chrome test (`http://127.0.0.1:8085/?profile=audit101` via browser agent): verified `v101` in Settings, full-colour folders with no `.folder-dot`, Pen & More menu conflict fixes, `Ctrl+V` / `Ctrl+Z`, and `Escape` closing `.pop` cleanly without leaving Full screen first; **0 app console/network errors**.
- Pictures saved in `C:\Users\yadram\AgentTools\shots\`: `inkleaf_v101_settings.png`, `inkleaf_v101_library.png`, `inkleaf_v101_penmenu.png`, `inkleaf_v101_fullscreen_esc.png`.

## Not tested (and exact next step)
- **Full `tests/check.cmd` in the owner's own Chrome** (not started because `AGENTS.md` requires asking before taking over the owner's Chrome for ~2 minutes).
- Canvas drawing/touch long-press/pen barrel-button flows on physical hardware or Chrome headless tools (DevTools MCP `click` lacks canvas coordinates/right-click).
- Duplicate `Sign in` / `Sign out` buttons in Settings (still in both top `.account-card` and lower `Live sync` section) and legacy `_test/` manual test folder (`_test/hwtest.html`, `_test/seg.js`) were left untouched.

## What the owner must do
1. Say yes to running the full check in Chrome (`tests/check.cmd`, ~2 minutes) and pushing **v101** live (and optionally whether to clean up Settings' lower Sign-in buttons or `_test/`).
