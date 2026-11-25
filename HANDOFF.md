# Handoff

**Written:** 2026-11-25 by Claude Code. **Next:** Claude Code or agy.

## What the owner asked
A picture from the iPad with a drawing (no words), then "is this solved ?": the sidebar button, logo and name in the
library's top bar are boxed, with an arrow from that button to the sidebar's X, which is crossed out.

## Done (v96, committed on this PC, NOT pushed)
- Sidebar open: the top bar no longer repeats the button, logo and name; the sidebar button is where the X was (same button
  in the phone drawer). Sidebar closed: the top bar shows them, as before.
- The cause of the mess in the picture: at 820 px wide the search box had about 80 px left, so the AI label lay on the
  name and the box spilled over the Journal and Sync buttons. Now nothing overlaps at any width; where the search box is too
  narrow for the AI label (phones around 375 px), the label goes.
- The lines under the two headers now meet (they were 5 px apart).
- `tests/check.mjs` has a new part "library" (16 checks; 6 of them fail on v95). Windowless: 130 passed, 0 failed.

## Live
v95 since 2026-11-25. The server is unchanged in v96.

## Next step
Ask the owner, run `tests/check.cmd` in their Chrome, push, run `tests/after-publish.cmd`, ask how it looks on the iPad.

## Seen, not changed (ask the owner)
- Folder dots: a folder without a chosen colour gets one by its position in the sidebar but is always red in the list, on
  cards and in the colour chooser (`folderColorOf` gets an index in one place only). Chosen colours stay on that device.
- Not tested on the real iPad, nor signed-in sync on the real server. The spell-check buttons have no check.
- Two REAL changes to one notebook at the same time (a rename on one device, adding a page on another): the later one
  still wins for the name, folder and bin.
- In portrait a sliver of the editor's tool bar shows to the right of the "..." button.
- Restoring a weekly backup has never been tested (suggested to the owner, not asked for yet).
- The owner has not said yes or no to a quiet week without new AI features or a new toolbar.
