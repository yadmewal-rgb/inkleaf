# Handoff

**Written:** 2026-11-25, about 12:45, by Claude Code. **Next:** Claude Code or agy.
**State:** nothing half-done in the code. Working tree clean. The newest commits on this PC are notes only (not pushed; they
go up with the next release). Nothing is waiting to be published.

## Live now
- App **v96** (commit 6b5cb82) on GitHub Pages. Sync server: the v94 code (243f512), unchanged since; Cloudflare build green.
- `tests/after-publish.cmd` after v96: ALL GOOD. `tests/check.cmd` on v96 in the owner's own Chrome: 131 passed, 0 failed.

## Owner's words on 2026-11-25, in order
1. "take handoff from agy"
2. "yes verify and also each line of code so that no conflicting commands are there" -> v94; "ok" (publish)
3. "do you want to suggest anything ?" -> five suggestions; "... why ?, go for 1,2,4" -> v95; "okay" (publish)
4. "open chrome in same chrome , not in separate"; asked hidden or own Chrome: "In your own Chrome:"; "go"
5. A picture from the iPad with a red drawing (library, sidebar open); "is this solved ?" -> v96; "go" (check and publish)
6. "save it all to handoff"

## What the owner must do
1. Reload Inkleaf twice on every device (friends too); Settings must show **v96**. A device still on v94 or older can undo a
   rename made elsewhere; two devices on v93 or older keep uploading to each other.
2. Look at v96 on the iPad, held upright with the sidebar open; tap Journal and Sync (the search box used to cover them).
3. Write on the iPad and see it on the laptop: signed-in sync on the real account was never tested by an agent.
4. Answer the open question below. Problems go into the "Temp" notebook.

## Open question (asked, not answered)
**Folder dots:** a folder without a chosen colour gets one by its position in the sidebar, but is always red in the list, on
cards and in the colour chooser ("Understand UPSC" was blue and red in the owner's picture). Offered: one fixed colour per
folder used everywhere, chosen colours left alone; some automatic dots would change. How: `folderColorOf` in library.js gets
an index in one place only; take the default from the folder's id instead and drop the index. Chosen colours are kept in
localStorage `inkleaf.folderColors`, so they stay on that device (not synced).

## Next step
Wait for the owner's view of v96. If they say yes to the folder dots: v97 (raise the version in sw.js AND sync.js, add a check,
ask before running `tests/check.cmd`, push only after "go", then `tests/after-publish.cmd`).

## Done on 2026-11-25
**v94 (243f512): conflicting commands.** v93 was exactly v87 apart from version numbers.
- Endless upload loop: `mergeDoc` (since v76) always returned a new copy; two devices made 135 uploads in 20 s with nobody
  touching anything, now 0. Extra `pushDoc` calls in the editor removed (saving already tells sync).
- The server had not deployed since 20 Nov (`newSize` declared twice in worker.js; live was 4992a62, v60). Fixing only that
  would have broken live sync (the WebSocket answer was rewrapped); both fixed. Also: the e-mail limit of private share links
  could be got round with a made-up key, and it showed an e-mail address; share links whose secret has "_" failed (11 of 40
  test links); sharing more than 100 pages failed; signing out took 10 minutes in the undeployed code; guests could send ink
  to other notebooks; the app could not read the usage headers.
  Old share links are protected too now; making new ones is only needed to switch the old ones off.
- Every pop-up threw an error on closing (`opts` in ui.js, since v76): the selection's colour, the spell-check buttons and
  "Add New Preset" did nothing.
- Edited pen colours and tip sizes were lost on reopening. One pop-up per long press. No hold menu from a resting palm or two
  fingers. "View-only" sharing no longer turns the owner's own editor read-only, and really holds for guests.
- Copy and paste: the latest copy wins. **Side effect (tell the owner if they ask):** copying ink puts the text "Copied in
  Inkleaf (paste it inside Inkleaf)" (`CLIP_MARK`) on the device's clipboard, so pasting in another app gives that text.
- Pasted text takes the chosen text colour and has a place in the stack; `db` imported in app.js; listeners cleaned up; a file
  shared to Inkleaf survives an update (sw.js); the pages panel is no longer told to sit left and right.

**v95 (8fa1431): suggestions 1, 2 and 4.**
- Reading never undoes a change: proved first on v94 (a device that only read pages while offline undid a rename, a move and
  a "move to bin" on both devices). `editedAt` / `touchDoc` in util.js; `mergeDoc` goes by the last REAL change. A notebook
  binned elsewhere while open here stays in the bin (`docGone`).
- `tests/` (see below). Thin ring on the tip-size dots. Turning the screen in side-by-side mode keeps the page centred.

**v96 (6b5cb82): the owner's drawing.** Sidebar open: the top bar no longer repeats the sidebar button, logo and name, and the
sidebar button is where the X was (same button in the phone drawer). Sidebar closed: the top bar has them. At 820 px wide the
search box had about 80 px left, so the AI label lay on the name and the box covered Journal and Sync; nothing overlaps now at
the 8 widths tested (375 to 1366). Where the box is too narrow for the label (phones around 375 px) the label is hidden. Both
headers are 61 px high (from 641 px width up).

## The checks (`tests/`)
- `check.cmd` (3 minutes; `--quick` = code and server only): code, styles, versions, a local copy of the sync server
  (Miniflare), then the app in a tab "Inkleaf check" of the owner's own Chrome (http://localhost:8099, own test library,
  pretend clipboard; cleans up before and after). It must stay in front and uncovered; it pauses otherwise, gives up after
  10 minutes, and runs a part that failed while out of sight once more. **Ask the owner before starting it.**
- `INKLEAF_ROOT=<folder> node check.mjs` checks another copy. It finds 9 failures in v94 and 31 in v93; the "library" part
  fails 6 times on v95.
- For its own debugging Claude ran a throwaway copy in a hidden browser (no window; not in the project) and told the owner.
- The first run in the owner's Chrome failed 4 checks because an earlier run that was cut off had left test data; fixed.

## Not tested, not read
- The real iPad and phone; signed-in sync on the real account; the spell-check buttons; in the More menu: print, export, send
  a copy, page as a picture, full screen, a second notebook beside, delete.
- Every line of JS, CSS and server code goes through the checker. Read by eye: worker.js, ui.js, app.js, editor-consts.js, the
  input, tool bar, paste and sync parts of editor.js / sync.js, the top bar and sidebar of library.js. Not read by eye: render,
  export, goodnotes, pdftools, hwsearch (most), spellcheck, the rest of library.js and editor.js.

## Seen, not changed (ask the owner first)
- Opening a notebook changes its "Last edited" date and its place in that sort order (since v76: they show `modified`, which
  opening stamps). `rd.e` is no replacement, because writing does not set it.
- Two REAL changes to one notebook at the same time (a rename on one device, adding a page on another): the later one wins
  for the name, folder and bin.
- In portrait a sliver of the editor's tool bar shows to the right of the "..." button.
- A few unused variables (harmless): in editor.js, sync.js, hwsearch.js, spellcheck.js, pdftools.js, sw.js.

## Suggested, not chosen
- A quiet week without new AI features or a new toolbar: the owner asked why, was told, and has not said yes or no.
- Testing once that a weekly backup can be restored (with a test notebook, never the real notes).

Pictures: AgentTools\shots, `v93_*` to `v96_*` (for example `v95_lib_upright_open` = before, `v96_lib_upright_open` = after).
