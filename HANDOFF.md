# Handoff

**Written:** 2026-11-19 by agy (Antigravity). **Next:** Claude Code or agy.

## What the owner asked
1. "make multiple tab sizable" -> Made side-by-side notebook split view resizable with a draggable handle.
2. "add option to add friends email ID so that can be shared directly" and "Full: 'Share with specific people' — at present my only 1 friend is using this app , i already added somewhere in allowed secret" -> Implemented restricted sharing with friend's Google email, auto-populated from Cloudflare ALLOWED secret, with live link authorization and 1-click email drafting.
3. "make a folder shareable like this is also" -> Added folder sharing in the library with 1-click email and .inkleaf folder packaging.

## Done (v50 Release)
1. **Resizable Side-by-Side Split View (`css/app.css`, `js/app.js`)**:
   - Added a visible 5px draggable `.split-handle` with hover/touch highlighting.
   - Live pointer drag support for horizontal (laptop/landscape) and vertical (phone/portrait) split views with minimum 80px guardrails.
   - Automatically dispatches `resize` event on drop to recalculate editor layout.
2. **Share with Specific People & Friend Email Integration (`server/worker.js`, `js/sync.js`, `js/app.js`)**:
   - `/me` endpoint now returns `friends` list parsed from Cloudflare's `ALLOWED` secret.
   - In Share modal, added 1-tap friend selector chips (auto-populating the friend's email from `ALLOWED` or recents).
   - `shares` table on server now supports `allowedEmails`.
   - Access control enforced on `/live/:shareId/...`: if `allowedEmails` is set, verifies the guest's Google account matches the allowed email address.
   - Clean UI in `app.js` when accessing a private share: prompts for Google sign-in if not logged in, or shows an access denied explanation if signed in with an unauthorized account.
   - Added 1-click "Email link" (`mailto:`) and "Share via app..." (`navigator.share`).
3. **Folder Sharing (`js/sync.js`, `js/library.js`)**:
   - Added "Send a copy" option to the folder menu in the library.
   - Implemented `folderFile(folderId)`: exports the entire folder, subfolders, all notebooks inside, pages, and assets into `<folder-name>.inkleaf`.
   - In Share folder modal: shows notebook and page count, 1-click "Email folder to friend", and "Download folder (.inkleaf)".
   - `importBackup` handles `data.kind === 'folder'` with "Folder added" notification.
4. **Service Worker Cache**:
   - Bumped to `inkleaf-v50` in `sw.js`.

## Live now
- Running locally at http://localhost:8080.
- Ready to be pushed to `main` for GitHub Pages and Cloudflare Worker deployment.

## Owner must do
- Test the new Share modal in Inkleaf (both on a notebook and on a folder).
- When ready to publish to your live site and Cloudflare Worker, let me know to run `git commit` and `git push`!
