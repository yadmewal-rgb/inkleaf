# Inkleaf — handwriting notes and PDF annotation web app (PWA)

> **For every AI agent on this project:** Claude Code (its `CLAUDE.md` just imports this file) and agy
> (Antigravity). Keep project knowledge HERE so whichever agent continues knows it. This repo is PUBLIC:
> never write e-mail addresses, secrets or tokens in any file.

## Agents: start, stop and hand over
**Only one agent works on this project at a time.**
- Start: read `HANDOFF.md`, then `git status` and `git log --oneline -5`. Uncommitted changes are the last agent's
  unfinished work.
- Stop: commit what works locally, never push unfinished work (a push to `main` is a release, see below), replace
  `HANDOFF.md` (date/time + agent, owner's words, done, half-done, next step, what is live, what the owner must do).

## The owner
- Not a programmer; plain short English; ask open questions one at a time. Wants the owner to SEE the testing:
  test in a visible browser and show screenshots.
- Writes on an iPad (Apple Pencil with hover) in Chrome for iPad (WebKit), also an Android phone and this laptop.
  Uses GoodNotes and wants Inkleaf to have its features. Personal use plus a few friends; no app stores.
- Sends feedback by handwriting in a notebook called **"Temp"** inside Inkleaf ("check temp file in notes"):
  open the live site in the laptop's Chrome (it has the synced library) and read that notebook.
- Pushing tested fixes to `main` is allowed.
- **English learning:** At the very start of every response, show the grammatically corrected version of what the owner wrote (e.g. `> **English Practice:** ...`) so they can improve their English naturally.

## What it is
Plain HTML + ES modules, no build step. Vendored pdf.js 3.11.174 and pdf-lib 1.17.1 in `vendor/`.
`js/`: app.js, library.js, editor.js (~7,700 lines, the big one), editor-consts.js, render.js, pageshots.js,
scan.js, export.js, pdfrender.js, pdftools.js, goodnotes.js (GoodNotes import), sync.js, db.js (IndexedDB), ui.js,
util.js, icons.js, hwsearch.js (handwriting search), spellcheck.js, vocab.js. `sw.js` = service worker. On every release
raise the version in BOTH `sw.js` (CACHE) and `js/sync.js` (APP_VER, shown in Settings).
`server/` = Cloudflare Worker sync service (worker.js, wrangler.jsonc). `tests/` = the checks (not part of the app).

## Live
- Website: https://yadmewal-rgb.github.io/inkleaf/ (GitHub Pages from `main`). **A push to main is a release.**
- Sync service: https://inkleaf-sync.yadmewal.workers.dev (Cloudflare Worker `inkleaf-sync`, rebuilt by Cloudflare
  on every push to main; it sometimes misses one: check Builds, push an empty commit if needed).
  Worker + Durable Object `User` per Google account; Google sign-in once per device (code flow, worker keeps the
  refresh token, secret GOOGLE_SECRET); secret ALLOWED = allowed e-mails (set in the Cloudflare dashboard, never in
  the repo). PDFs under 500 MB (`BIG` in sync.js) on Cloudflare, bigger ones in the owner's Google Drive (app folder), and every PDF
  also copied to a visible "Inkleaf" Drive folder. Quota: owner 2000 MB, friends 500 MB.
  Friends need: e-mail in ALLOWED.

## This PC
- Node 24 is installed (`C:\Program Files\nodejs`); no Python or Flutter. Git is `C:\Program Files\Git\cmd\git.exe` (may not be on PATH). Commits use the
  repo-local noreply identity: keep it that way (no personal e-mail in public history).
- Run locally: `start.cmd`, or `powershell -ExecutionPolicy Bypass -File serve.ps1` -> http://localhost:8080.
- **The owner wants testing in their own Chrome, as a normal tab, never in a separate Chrome window.** `tests/check.cmd`
  does that: it opens a tab "Inkleaf check" (own local address, pretend clipboard, no reach to the real library) that must
  stay in front, with the Chrome window not covered; it pauses when it is not, and gives up after 10 minutes. Ask the
  owner before starting it: it takes over their Chrome for about 3 minutes.
- **Before every push run `tests/check.cmd`** and push only if it
  says "ready to publish". **After every push run `tests/after-publish.cmd`**: a release is done only when it says ALL
  GOOD (the Cloudflare server failed to build for five days in Nov 2026 and nobody noticed). First run installs its
  tools into `tests/node_modules` (not in git). When a bug is fixed, add a check for it in `tests/check.mjs`.
- Notebook records: a real change sets `modified`; opening, page turns, thumbnails and writing use `touchDoc`
  (util.js) so they never undo a rename, move or bin made on another device. `mergeDoc` must return one of its
  inputs untouched when nothing differs, or two devices upload to each other without end.
- **Never push without loading the app in the browser first, even for a one-line change** (a pushed syntax error
  once broke the whole app).
- Testing: `?profile=a` / `?profile=b` give separate local libraries (two iframes = two devices);
  `sync.js` has `_setHttp`, `_setSocket`, `_setBig` test switches. Make a test PDF in the page with the vendored
  pdf-lib and feed it to the PDF file input with a DataTransfer.
- Gotchas: a fresh tab can load a stale editor.js from cache (`fetch(url, {cache:'reload'})` then reload);
  `.empty` is a library CSS class with big padding, don't reuse the name; headless Chrome can't render windows
  narrower than ~500 px; pdf-lib `copyPages` on the huge SnT.pdf froze a tab (don't).

## Lessons from the owner's reports
- Blurry writing on iPad: WebKit blurs content enlarged by CSS `scale()`; pages are laid out at on-screen size,
  CSS scale only during a zoom gesture.
- IndexedDB "connection is closing" on iPad: db.js `withDb` reopens and retries.
- Writing "disappears" on iPad: likely canvas memory limit; temp canvases are zeroed, fewer pages kept drawn on
  touch devices.
- Layers and hold-to-erase were REMOVED at the owner's request; don't bring them back.
- Library (owner's drawing, 2026-11-25): while the sidebar is open, the name and the sidebar button are ONLY in the sidebar
  (the button sits where the X was); the top bar shows them only while the sidebar is closed. Don't bring the copy back.
- Apple Pencil double-tap/squeeze are not available to web apps (pressure, tilt, hover are).
- Screenshots for chat: Always capture and resize website/desktop screenshots at full 1000px width with high DPI (`shots.ps1 ... -Width 1000` or `--force-device-scale-factor=1.5`) so all menus, text, and labels are crisp and easy to read.
- Pomodoro & Clock Widget specifications (owner chosen):
  - Retro flip-clock design with dark rounded cards and horizontal split line.
  - Shows study countdown (Focus 25m / Break 5m / Long 15m) with session round counter in the bottom-left corner of the minutes card (`01`, `02`, etc.).
  - Side vertical action buttons: Skip (`⏭`), Play/Pause (`⏸`/`▶`), and Stop/Reset (`⏹`).
  - Tap-to-peek Clock: Tapping the cards temporarily reveals the real current wall-clock time (`TIME PM 12:10`) and auto-hides back to the timer after 1.5 seconds.
  - Scalable: Compact mini mode (~65% scale) so it stays unobtrusive during fullscreen handwriting on iPad/laptop, with ability to scale or toggle size.
  - Stability: Keep as an isolated DOM overlay layer above the viewport (`overlay.append(...)`); never interfere with canvas stroke rendering or sync loop.

## Open ideas (not chosen yet; ask before building)
AI features (ask about a page; handwriting search exists), Android APK via PWABuilder, more for live shared notebooks (they
exist), page sizes (A5/widescreen/square), endless whiteboard, audio recording, more editor.js splitting
(highlights/flashcards/tray, notebook versions, zoom window). Most features were tested only on the laptop with
synthetic events: feedback from the iPad and phone is the most useful next step.
