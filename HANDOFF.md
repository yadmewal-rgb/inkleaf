# Handoff

**Written:** 2026-11-26, about 20:30, by Claude Code. **Next:** Claude Code or agy.
**State:** nothing half-done. The app is unchanged since v98; today's commits are tests and notes only, kept on this PC (not
pushed: they go up with the next release, so no extra build).

## Live now
- App **v98** (`055440f`, by agy) on GitHub Pages; sync server from the same commit; `tests/after-publish.cmd` ALL GOOD (agy).
- **Full `tests/check.cmd` on v98 in the owner's own Chrome: 144 passed, 0 failed, 111 s** (agy could only run `--quick`).

## Owner's words on 2026-11-26 (to Claude Code)
1. "inkleaf" -> read the handoff; 2. "check handoff" -> agy had made v97 + v98 meanwhile; 3. "yes agy is closed, go" (full
check + read v97/v98); 4. "check only failed and which take more time than required"; 5. "okay" (make the check faster);
6. "yes go" (run it).

## Done today (tests only, app untouched)
- agy's v98 check "switching multi-page PDF tabs avoids repeated asset reads" was wrong, not the app: it used 32 empty bytes as a
  PDF, which pdf.js cannot open, so every page tried again (7 reads). With a real 39-page PDF: 2 reads in all (one by sync's
  `readyAssets`, one by `pdfDoc`), none per tab switch. The check now makes a real PDF and allows 2.
- `--only=<parts>` (code, server, library, writing, devices) and a time report at the end.
- Fixed waits replaced by `until(...)` / `settle()` (go on when ready, with a limit): about 180 s -> 111 s, no check removed.
  "No uploads" checks first wait until uploads in progress end (`settle`), then watch 6 s (was 12) and name what was uploaded.
- Found while doing that: each new device uploads its first weekly backup (kind `b`) 8 s after it starts (`autoBackup` in
  sync.js). The old check missed it only by its timing. "No uploads" now counts the changes feed (f/d/p/a); a new check says
  each device makes exactly one backup.
- Read by eye: all of v97/v98 `server/worker.js`, the user manager in sync.js, the v98 editor changes. The user manager is
  owner-only and the internal `app_config` / `app_usage` objects cannot be reached from outside (keys must be digits).
  Saving still happens on switching notebooks (`destroy()` does `commitText` + `flush`).
- An earlier failure "one finger held opens the menu" was the tab being out of sight; it passes.

## Open questions (asked, not answered)
1. **Removing an allowed user** (Settings > Allowed users, v97) does not sign them out: their devices keep syncing; only new
   sign-ins are refused. Offered: removing also ends their sessions. (Same for addresses taken out of Cloudflare ALLOWED.)
2. **Folder dots** (from v96): a folder without a chosen colour gets one by its sidebar position but is red elsewhere.
   Offered: one fixed colour per folder from its id (`folderColorOf` in library.js), chosen colours kept.
3. Offered: run the faster check on an old copy (v93, `INKLEAF_ROOT`) to prove it still catches the old upload loop.

## What the owner must do
1. Reload Inkleaf twice on every device (friends too) until Settings shows **v98**; try switching between open PDF notebooks
   on the iPad.
2. Friends: open Settings once so they appear in the usage count.
3. Answer the questions above. Problems go into the "Temp" notebook.

## Not tested
- The real iPad and phone; signed-in sync on the real account; the Cloudflare dashboard's own usage charts (needs sign-in).

## Seen, not changed (from 2026-11-25, still true)
- Opening a notebook changes its "Last edited" date and its place in that sort order.
- Two real changes to one notebook at once: the later one wins for name, folder and bin.
- In portrait a sliver of the editor's tool bar shows right of the "..." button.

Pictures: AgentTools\shots (`v93_*` to `v96_*`).
