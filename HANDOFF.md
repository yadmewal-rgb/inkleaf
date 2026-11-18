# Handoff

**Written:** 2026-11-18 by agy (Antigravity). **Next:** Claude Code or agy.

## What the owner asked
"okay , file sharing is working  and when i highlight any thing then every time a window opens at bottum , how to stop it happening automatically  side menu on clicking more wont slide up and down , now  , how can i make it availabe for my friends , they like to use this app  for their study , how can the log in it, where their data will save . tell me your plan how can we do this"

## Done
1. **Prevent Highlights Window From Automatically Popping Up**:
   - `js/editor-consts.js`: Added `hlTray: false` to `DEFAULTS`. The bottom highlights tray now defaults to off so taking notes is uninterrupted.
   - `js/editor.js`: Saved preferences from IndexedDB now properly restore `hlTray`. Added dynamic "Show them on screen" / "Hide from screen" toggle in `highlightsDialog()`. Closing the tray via `X` persists permanently.
2. **Fixed "More" Side Menu Sliding / Scrolling**:
   - `css/app.css`: Added `max-height: calc(100dvh - 20px)`, `overflow-y: auto`, `-webkit-overflow-scrolling: touch;`, and `overscroll-behavior: contain` to `.pop`.
   - `js/ui.js`: Updated `popover()` to bound popup height to available viewport space (`spaceBelow` / `spaceAbove`) so long menus like the 28-item More menu fit on screen and scroll smoothly up and down with touch or mouse.
3. **Friend Access, Sign-In & Data Plan Explained**:
   - Detailed plan for sharing Inkleaf with friends: direct web access, offline-first IndexedDB storage, Google Sign-In with Cloudflare `ALLOWED` whitelist, and isolated private Durable Object cloud sync (500 MB quota per friend).
4. **Cache Bump**:
   - `sw.js`: Bumped cache to `inkleaf-v47`.

## Live now
- Website on GitHub Pages from `main` (cache `inkleaf-v46`).
- Sync worker running on Cloudflare (`inkleaf-sync.yadmewal.workers.dev`).

## Owner must do
- (Optional) When ready to let friends sync, add their Google emails to the `ALLOWED` secret in Cloudflare Dashboard (`inkleaf-sync` > Settings > Variables and Secrets).

## Next step
- Commit and push v47 release to `main`.
