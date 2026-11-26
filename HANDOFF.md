# Handoff

**Written:** 2026-11-26, about 21:00, by Claude Code. **Next:** Claude Code or agy.
**State:** nothing half-done, working tree clean. **v100** is live. Only the notes are newer (committed on this PC, not pushed:
they go up with the next release, so no extra build).

## Live now
- App **v100** (`999a7a1`) on GitHub Pages; sync server from the same commit (unchanged since v99). `tests/check.cmd` in the
  owner's Chrome: **153 passed, 0 failed** (115 s); `tests/after-publish.cmd`: **ALL GOOD**.

## v100 (owner: "why didnt you make it syncking ?" -> "yes make it and go")
- Chosen folder colours sync: kept in the folder record (`color`, set by `setFolderColor(folder, key)` with `modified`, so
  the later choice wins like a rename). `moveLocalFolderColors()` moves the old per-device localStorage colours into the
  folders whenever the library opens and that key still exists (a colour already synced in is kept), then removes the key.
- Found by the new check: while a notebook was open, `pushNow` only pushed that notebook, so folder changes (now colours;
  before also e.g. a folder made from the editor) waited until it closed. `savedFolders` now go up with it.
- The first v100 check failed on both points (not published then); fixed, then 153/153.

## v99 (owner: "1 make it , 2 color the whole folder not only dot , 3 okay", then "1", "and 2 also and go")
- **Removing a user signs them out.** Settings > Allowed users > Remove: `revokeAll()` on their Durable Object deletes every
  session and closes their own live connections (guests of their share links are left alone); notes stay. `app_config`
  learns address -> account (`email_subs`) at sign-in and on each check. Safety net `allowedNow()`: every signed-in request,
  live connection and private-link guest is checked at most every 5 minutes (ALLOWED secret read at once), so people taken
  out of Cloudflare ALLOWED, or never mapped, go too. No answer = allowed: a failed question never signs anybody out.
  Checks: at once, old key refused, never-allowed refused, allowed people stay. They fail on the v98 server (proved).
- **Folder colours.** `folderColorOf(folder)` = chosen colour, else from the folder's id (no list position any more). The whole
  folder takes it: tinted cover with a filled folder sign on folder cards (corner dot gone), coloured folder signs in the
  sidebar and on notebook cards, coloured folders in the chooser (`.fc-*`, `--fc` in app.css). Some automatic colours changed
  once. (Chosen colours were per device in v99; they sync from v100.) Pictures:
  AgentTools/shots/v99_before_* and v99_after_* (taken in a hidden Chrome with its own empty profile; testing was in the owner's).
- **Proof:** the faster check on v93's app (with today's server) fails 10 two-device checks (uploads while both open, undone
  rename/move/bin). It still catches the old bugs.

## Earlier today, by agy (between 2026-11-25 13:41 and 2026-11-26 19:28)
- **v97** (`ad0b60c`): OneDrive-style spinning sync signs on folders and notebooks; owner-only "Allowed users" in Settings
  (add friends without Cloudflare); Sign out easy to find (account card, sidebar); combined usage "You" / "Other user".
- **v98** (`055440f`): faster switching between open notebooks (PDF read once, fewer full scans); usage counters consistent.
- agy could only run `tests/check.cmd --quick`; the full check on v98 in the owner's Chrome (run by Claude Code): 144 passed.

## Owner's words on 2026-11-26 (to Claude Code), in order
1. "inkleaf" -> read the handoff
2. "check handoff" -> agy had made v97 + v98 meanwhile; full check never run on them
3. "yes agy is closed, go" -> full check + read v97/v98 code
4. "check only failed and which take more time than required" -> `--only`, time report
5. "okay" (make the check faster); "yes go" (run it)
6. "1 make it , 2 color the whole folder not only dot , 3 okay" -> sign-out on removal, coloured folders, v93 proof
7. "1" (run the check), "and 2 also and go" (pictures, publish) -> v99
8. "... why didnt you make it syncking ?" -> "yes make it and go" -> v100
9. "is it done ?" -> yes; "save it all to handoff"

## The checks (tests/), changed today (before v99)
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
- How long now: code 1 s, server 8 s, library 11 s, writing 41 s, two devices 51 s; about 2 minutes in all.

## Mistakes made today (told to the owner)
- A patch script stopped halfway and the next line started the old full check in the owner's Chrome without asking; stopped
  after about 2 minutes, nothing harmed. Lesson: never chain a check run after a patch step in one command.
- A first "before" picture captured the whole laptop screen (the terminal covered Chrome) and was deleted unseen by anyone.
  Pictures are now taken in a hidden Chrome of the page only (scratchpad `folder_pics.mjs`; not in the project).

## Next step
Wait for the owner's view of v100 on the iPad and phone, or new notes in "Temp". No question is waiting.

## What the owner must do
1. Reload Inkleaf twice on every device (friends too) until Settings shows **v100**; try switching between open PDF notebooks
   on the iPad, and look at the coloured folders.
2. Friends: open Settings once so they appear in the usage count.
3. Problems go into the "Temp" notebook.

## Not tested
- The real iPad and phone; signed-in sync on the real account; the Cloudflare dashboard's own usage charts (needs sign-in).

## Seen, not changed (from 2026-11-25, still true)
- Opening a notebook changes its "Last edited" date and its place in that sort order.
- Two real changes to one notebook at once: the later one wins for name, folder and bin.
- In portrait a sliver of the editor's tool bar shows right of the "..." button.

Pictures: AgentTools\shots (`v93_*` to `v96_*`, `v99_before_*`, `v99_after_*`).
