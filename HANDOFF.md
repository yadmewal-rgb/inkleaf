# Handoff

**Written:** 2026-11-25 by Claude Code. **Next:** Claude Code or agy.

## What the owner asked
"yes verify and also each line of code so that no conflicting commands are there" (verify v93, and check the code
for conflicting commands).

## Done (v94, committed on this PC, NOT pushed: waiting for the owner's yes)
v93 is exactly v87 apart from the version numbers (checked with git). Found and fixed:
1. **Endless upload loop** (`mergeDoc` in sync.js, since v76): it always returned a new copy, so two devices kept
   sending each other the same notebook (135 uploads in 20 s with nobody touching anything; now 0). Keep its rule:
   return one of the inputs untouched when nothing differs. Extra `pushDoc` calls in the editor removed: saving
   already tells sync to upload.
2. **Server never deployed since 20 Nov** (`newSize` declared twice in worker.js: Cloudflare builds fail; live = commit
   4992a62). Fixing only that would have broken live sync (the WebSocket answer was rewrapped). Both fixed. Also: forged
   keys opened private shared notebooks and showed an e-mail address; 1 in 4 share links failed (secret with "_");
   sharing a notebook over 100 pages failed; sign-out took 10 minutes; guests could send ink to other notebooks.
3. **Every pop-up threw an error on closing** (`opts` in ui.js, since v76): selection colour, spell-check Ignore / Add to
   dictionary / Translate and "Add New Preset" did nothing.
4. **Edited swatches and tip sizes were lost** on reopening a notebook.
5. Copy ink then paste inserted old text from another app; a long press opened two pop-ups; a resting palm or two
   fingers opened the hold menu; the owner's own editor went read-only on "view-only" sharing; view-only guests could
   draw; `db` not imported in app.js; listeners left behind; pages panel placed left and right in CSS.

## Tested
Local copy of the sync server (Miniflare) plus visible Chrome: before/after of most bugs above, two devices, the 8 tools
and their shortcuts, and the More menu except print, export, send, delete, full screen, template and side by side.
Not tested: the real iPad, the real server, the spell-check buttons and the guest's view-only screen.
Every line of JS/CSS/server code went through a checker; read by eye: worker.js, ui.js, app.js, editor-consts.js and the
input, tool bar, paste and sync parts of editor.js / sync.js. Not read by eye: render, export, goodnotes, pdftools, most of library.

## Next step
Push (releases the app AND deploys the server), check that the Cloudflare build is green, then ask the owner to try it.

## Seen, not changed (ask the owner)
- Turning pages counts as a change to the notebook, so reading on one device can undo a rename, a page move or a "move to
  bin" made on another device just before.
- Black tip-size dots are invisible on the dark tool bar. Rotating the iPad in side-by-side mode leaves the view between pages.
