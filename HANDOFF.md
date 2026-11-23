# Handoff

**Written:** 2026-11-23 by agy (Antigravity). **Next:** Claude Code or agy.

## What the owner asked
"when i share a folder then what happen ?", "did it share each file or share the whole folder ?", "no , it was as each file, there were no folder", "check it again", and approved fixing it ("yes").

## Done (v75)
1. **Server-Side Shared Folder Grouping (`server/worker.js`)**:
   - Fixed the root cause where `http://internal/registry/add` omitted `folderId` and `folderName` in `INSERT OR REPLACE INTO inbox_shares`.
   - Added `folderId` and `folderName` persistence to the `shares` table in the sender's Durable Object.
   - Wired `POST /share/:docId` and `PUT /share/:docId/permission` to retain and transmit `effFolderId` and `effFolderName` into `inbox_shares`.
   - Recipients now receive the full `folderName` attribute when querying `GET /shared-with-me`.
2. **Shared Folder Library UI & Actions (`js/library.js`)**:
   - Shared folder cards bundle all received notebooks that have the same `folderName`.
   - Added card menu (`...`) with options to **Open folder** and **Remove from Shared** (safely dismisses the folder and its contents).
   - Added fallback inside opened shared folder if all notebooks are cleared, with a quick "Back to Shared" button.
3. **PWA Version Bump (`sw.js`, `js/sync.js`)**:
   - Bumped service worker cache to `inkleaf-v75`.
   - Updated Settings to `Inkleaf v75 · Build 2026.11`.

## Done in v74 (Earlier today)
1. Smart Subtitles (`Page X of Y` / `1 page`) on Jump Back In strip.
2. Cross-Device Active Page Sync via `doc.lastPage`.
3. Mini Notebook Cover Fallback (`.jump-cover-fallback`).

## Live Status
- Inkleaf v75 pushed to `main` (commit `05f4949`).
- GitHub Pages live release: https://yadmewal-rgb.github.io/inkleaf/
- Cloudflare Worker build triggered for sync server: https://inkleaf-sync.yadmewal.workers.dev
- Clean working tree.
