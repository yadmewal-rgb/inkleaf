# Handoff

**Written:** 2026-11-25 by Claude Code. **Next:** Claude Code or agy.

## What the owner asked
"go for 1,2,4": (1) stop reading from undoing changes, (2) an automatic check before every release, (4) two small
visual problems. Claude suggested a quiet week without new AI features or a new toolbar; the owner asked why and was told,
but has not said yes or no to it. Later: "open chrome in same chrome , not in separate", then "In your own Chrome".

## Done (v95)
1. **Reading no longer undoes changes.** Proved first on v94: a device that only read pages while offline undid a rename,
   a move and a "move to bin" on both devices. Now `editedAt` / `touchDoc` (util.js) keep the time of the last real
   change; `mergeDoc` goes by that. A notebook binned elsewhere while open here also stays in the bin.
2. **Checks:** `tests/check.cmd` before a push (115 checks: code, sync server, app, two devices, guest) and
   `tests/after-publish.cmd` after it. Run against old versions they find 9 failures in v94 and 31 in v93.
4. Tip-size dots have a thin ring (black ones show on the dark tool bar). Turning the screen in side-by-side mode keeps the
   page centred, and fitted if it was.

## Live
v95 since 2026-11-25 (owner said okay). `tests/check.cmd`: 115 passed; `tests/after-publish.cmd`: ALL GOOD.

## Next step
Ask how v95 feels on the iPad. Every device must be reloaded (one still on v94 can undo a rename).

## Half done: the check in the owner's own Chrome
`tests/check.cmd` now opens a tab "Inkleaf check" in the owner's Chrome (tests only: the app is unchanged, nothing to
publish). First full run there: 4 failures, all from the test setup (an earlier run that was cut off had left its test data
behind; repeated exactly in a windowless browser). Fixed: cleans up before it starts, new test libraries every run, waits
only count while the tab is visible, and a part that was out of sight is run again once. Windowless it passes everything,
also after a cut-off run, pauses and a closed tab. **Still to do: one full pass in the owner's own Chrome, when they can leave
the tab in front (and the Chrome window uncovered) for about 3 minutes. Ask them first.**

## Not covered / seen, not changed
- Not tested on the real iPad, nor signed-in sync on the real server. The spell-check buttons have no check.
- Two REAL changes to one notebook at the same time (a rename on one device, adding a page on another): the later one
  still wins for the name, folder and bin.
- In portrait a sliver of the tool bar shows to the right of the "..." button.
- Restoring a weekly backup has never been tested (suggested to the owner, not asked for yet).
