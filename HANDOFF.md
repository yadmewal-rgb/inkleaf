# Handoff

**Written:** 2026-11-21 by agy (Antigravity). **Next:** Claude Code or agy.

## What the owner asked
1. "load PDFs less than 500MB to cloudflare also for faster sync"
2. "when we share a pdf from phone (like from other app and files) , can option appear like open in inkleaf, and then open or add in perticular folder of add to exixting notes like this ?"
3. "still no option" (with screenshot showing phone Android share sheet without Inkleaf)

## Done (v64 Release)
1. **500 MB Cloudflare Upload Limit & Edge-First Streaming (`js/sync.js`)**:
   - Raised the direct Cloudflare upload threshold from 200 MB to **500 MB** (`BIG = 500 * 1048576`). PDFs and assets under 500 MB now sync directly through Cloudflare's edge network rather than offloading to Google Drive.
   - Updated `pullAsset()` to always query Cloudflare's edge cache first before querying Google Drive.
2. **Mobile Web Share Target & File Handling (`manifest.webmanifest`, `sw.js`, `js/app.js`)**:
   - Added `share_target` in `manifest.webmanifest` allowing Android system share sheet to send PDFs to Inkleaf.
   - Intercepted incoming share requests in `sw.js` with robust multi-field fallback parsing, storing the incoming PDF file in the `inkleaf-shared` cache and redirecting to `./?shared=1`.
   - In `js/app.js`, automatically loads shared files and triggers the import dialog.
   - Added File Handling API (`launchQueue`) for desktop/Chrome OS.
3. **Interactive PDF Import Modal (`js/library.js`)**:
   - Implemented `promptImportPdf()` dialog with two distinct modes:
     - **"Create as a new notebook"**: Set custom title and choose target folder (Library root or any folder).
     - **"Add pages to an existing notebook"**: Choose an existing notebook to append all PDF pages to the end.
   - Added `appendPdfToDoc()` helper to unpack PDF pages and append to `doc.pages`.
   - Wired the dialog to the top "Import PDF" button, the empty-folder import button, and drag-and-drop.
4. **Settings & PWA Cache Bump (`sw.js`, `js/sync.js`)**:
   - Updated cache to `inkleaf-v64`.
   - Updated Settings title and footer to `Inkleaf v64 · Build 2026.11`.

## Android Share Sheet Explanation
- Android only includes web apps (PWAs) in the system share sheet if the app's installed **WebAPK** package includes the `ACTION_SEND` intent filter.
- Because Inkleaf was already installed on the phone before today, Android is still running the old WebAPK package.
- To make Inkleaf appear in Android's Share Sheet immediately, the user needs to **uninstall the Inkleaf app from their phone's home screen, then re-install it from Chrome** (Chrome ➔ Three dots ➔ Install app). Chrome will immediately mint the new WebAPK containing the share intent.

## Live now
- Pushed to `origin/main` (live on https://yadmewal-rgb.github.io/inkleaf/).
- Running locally at http://localhost:8080.
