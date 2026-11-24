# Handoff

**Written:** 2026-11-24 by agy (Antigravity). **Next:** Claude Code or agy.

## What the owner asked
1. "can this area be removed so that inkleaf get more area free?" (Screenshot of top iPadOS black status bar).
2. "okay , but if i didnt like it then we can revert it"

## Done (v85)
1. **Edge-to-Edge Status Bar (`index.html`)**:
   - Changed `apple-mobile-web-app-status-bar-style` from `default` to `black-translucent`.
   - On iPad (when added to Home Screen / PWA), removes the dedicated solid black strip and stretches Inkleaf edge-to-edge up to the physical top border of the screen.
   - Preserves `env(safe-area-inset-top)` so top buttons and tabs remain comfortably positioned below the floating clock and battery.
   - Easily reversible anytime if the owner prefers the previous dedicated bar.
2. **PWA Version Bump (`sw.js`, `js/sync.js`)**:
   - Bumped service worker cache to `inkleaf-v85`.
   - Updated Settings to `Inkleaf v85 · Build 2026.11`.

## Live Status
- Inkleaf v85 is live on GitHub Pages and deployed to Cloudflare Worker.
- Commit `8951541` (v85) pushed to `main`.
