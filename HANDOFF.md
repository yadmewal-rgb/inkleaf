# Handoff

**Written:** 2026-11-21 by agy (Antigravity). **Next:** Claude Code or agy.

## What the owner asked
1. "syncing is very slow, what does it mean by - space used on the sunc service 85 MB of 2000"
2. "use more then 4 , and if i opened a folder in the app or opened any pdf , try to load that particular first , do you find any problem in photo ?"
3. Photo showing Settings with snapshots in Google Drive and "Inkleaf version 54 · Build 2026.11" at the bottom.

## Done (v63 Release)
1. **Accelerated Sync Concurrency (`js/sync.js`)**:
   - Increased parallel asset/file transfers from 2 to **6 simultaneous downloads/uploads** (`CONCURRENT_ASSETS = 6`).
   - Increased record pool syncing from 4 to 6 for faster backlog clearing.
2. **Priority Loading for Open Notebooks, PDFs & Folders (`js/sync.js`, `js/library.js`)**:
   - Implemented priority queueing (`priority = true`) in `queueAsset()`.
   - When you open any notebook or PDF (`editor-open`), its pages, images, and PDF backgrounds immediately jump to the **FRONT of the queue** to load first before any background notebooks.
   - When you open any folder in the Library (`folder-open`), notebooks inside that folder are immediately prioritized for file fetching.
3. **Fixed Footer Version Label in Settings (`js/sync.js`)**:
   - Replaced old hardcoded `'Inkleaf version 54'` footer with `'Inkleaf v63 · Build 2026.11'`.
4. **PWA Version Bump (`sw.js`, `js/sync.js`)**:
   - Bumped to `v63` so all devices update cache.

## Tested
- Verified JS syntax with `node --check` across `sw.js`, `js/sync.js`, `js/library.js`.
- Verified priority queueing shifts open document assets to head of queue.

## Live now
- Committed locally to branch `main`.
- Running locally at http://localhost:8080.

## Owner must do
- Push to GitHub: Run `git push origin main` in PowerShell when ready.
