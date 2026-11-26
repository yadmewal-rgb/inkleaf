# Handoff

**Written:** 2026-11-26, about 18:15, by agy (Antigravity). **Next:** agy or Claude Code.
**State:** v97 changes are committed locally only (**NOT pushed**). `tests/check.cmd --quick` passed **51 / 51** (all JS/CSS/version checks and Miniflare sync server tests). Browser UI checks (`tests/check.cmd`) and screenshots are waiting because Chrome could not open a visible tab from this session.

## Live now
- App **v96** (commit 6b5cb82) on GitHub Pages. Sync server: **v94** (243f512), unchanged. Nothing new has been published yet.

## Owner's words on 2026-11-26, in order
1. Six items:
   1. While rotating the syncing sign, show exactly which notebook or folder is syncing (folder in main menu, exact file/subfolder when opened), like OneDrive.
   2. How to add users without going to Cloudflare.
   3. How to get more than 5 GB space for total?
   4. There is no option of sign out.
   5. Show cumulative usage of limit in Gemini and Cloudflare, mention others as "Other user", show every user's usage without showing names or subdividing their usage.
   6. When any user shares any file, it first uploads from that user and then shares — is it the only way? It is time-consuming.
2. `/plan /grill-me /teamwork /boost /swarm /learn /generative_ui` (skipped the follow-up mode choice).
3. `go and keep 'How to get more than 5 GB total space:' unchanged`
4. `go`

## Done locally (v97, tested with `tests/check.cmd --quick`: 51 passed, 0 failed)
- **OneDrive-style per-folder & per-notebook syncing signs** (`js/sync.js`, `js/library.js`, `js/db.js`, `css/app.css`):
  - `db-write` emits `docIds` / `folderIds`; `sync.js` tracks active records, pending writes, and queued/active assets (`assetDocs`) and resolves ancestor folders all the way to the root (`syncTargets()`, `bus` event `'sync-targets'`, `_setSyncTargets` test helper).
  - `library.js` shows `.item-sync-badge` on folder cards, notebook cards, Jump Back In cards, and `.side-sync-item` on sidebar folder rows.
- **In-app Allowed Users for owner without Cloudflare** (`server/worker.js`, `js/sync.js`):
  - `app_config` Durable Object stores `extra_allowed`; `allowedEmail` & `GET /me` merge `env.ALLOWED` + `extra_allowed`.
  - Owner-only routes `GET/POST/DELETE /admin/users` (enforces first email in `ALLOWED`; `403` for everyone else; `/config` blocked `404` externally).
  - Settings shows an **Allowed users** box to the owner account only.
- **Prominent Sign out** (`js/sync.js`, `js/library.js`, `js/icons.js`, `js/app.js`):
  - Added top **Account** card in Settings with **Sign out**, **Sign out** button on `"this device"` in Signed-in devices, sidebar footer `I.logOut` button, and **Sign out** on the `FORBIDDEN` screen (`js/app.js`). `signOut()` clears cached share metadata too (`shared_items`, `my_shares`, `my_shared_folders`, `cloudState`, `cloudCursor`).
- **Cumulative usage across all users (anonymous)** (`server/worker.js`, `js/sync.js`, `js/hwsearch.js`):
  - `app_usage` Durable Object aggregates daily `cfCalls`, `ocrCalls`, and stored `bytes` across users (`/usage` blocked `404` externally; internal DO calls excluded from `trackUsage` to avoid loops).
  - `GET /me` returns `cfTotalToday`, `ocrTotalToday`, `totalBytesAll`, `cfStorageLimit` (5 GB), and `usageUsers` (`You`, `Other user` / `Other user 1`, `Other user 2`...) with zero emails/names or sub-breakdowns.
  - Direct browser Gemini calls report via `POST /usage-ocr`, and `/ai/outline` counts toward Gemini usage too.
  - Custom `inkleaf.hwLimit` is no longer overwritten by server headers.
- **Storage unchanged:** 500 MB `BIG` threshold and `QUOTA_MB` / `OWNER_QUOTA_MB` left untouched per owner's request.
- **Version bumped:** `v97` in `sw.js` and `js/sync.js`. Automated tests added in `tests/check.mjs`.

## Half-done / blocked right now
- **Chrome browser verification & screenshots (`tests/check.cmd`):** Failed 4 browser checks (`the check tab did not open in Chrome`). From this session (`SessionId=4`), `shots.ps1 -Screen` hit `CopyFromScreen: The handle is invalid` (blank screen), `Get-Process` showed zero processes with `MainWindowTitle`, and Chrome DevTools MCP failed (`DevToolsActivePort` missing / remote debugging off).

## Next step
1. Once the laptop desktop is unlocked with Chrome visible on screen (or `chrome://inspect/#remote-debugging` enabled), run `tests/check.cmd` in the owner's Chrome and verify all checks pass (including the new OneDrive sync badge and Settings checks in `tests/check.mjs`).
2. Take crisp 1000px screenshots via `shots.ps1` showing the folder -> subfolder -> notebook sync signs and the updated Settings dialog, verify them visually, and show them in chat.
3. Only after `tests/check.cmd` prints `ready to publish` and the owner confirms, push `main` and run `tests/after-publish.cmd`.

## What the owner must do (plus open items from earlier)
1. To run the Chrome browser test: keep the Windows screen unlocked with Google Chrome open and visible, or turn on `chrome://inspect/#remote-debugging` in Chrome, then tell the agent **"go"**.
2. Still open from `v96` handoff: answer on fixed **folder dots** colour (`folderColorOf`), check `v96` on iPad portrait, test real signed-in iPad sync.
