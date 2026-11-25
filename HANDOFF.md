# Handoff

**Written:** 2026-11-25 by Claude Code. **Next:** Claude Code or agy.

## What the owner asked
"go for 1,2,4": (1) stop reading from undoing changes, (2) an automatic check before every release, (4) two small
visual problems. The owner agreed to a quiet week: no new AI features and no new toolbar now.

## Done (v95, committed on this PC, NOT pushed: waiting for the owner's yes)
1. **Reading no longer undoes changes.** Proved first on v94: a device that only read pages while offline undid a rename,
   a move and a "move to bin" on both devices. Now `editedAt` / `touchDoc` (util.js) keep the time of the last real
   change; `mergeDoc` goes by that. A notebook binned elsewhere while open here also stays in the bin.
2. **Checks:** `tests/check.cmd` before a push (115 checks: code, sync server, app, two devices, guest) and
   `tests/after-publish.cmd` after it. Run against old versions they find 9 failures in v94 and 35 in v93.
4. Tip-size dots have a thin ring (black ones show on the dark tool bar). Turning the screen in side-by-side mode keeps the
   page centred, and fitted if it was.

## Live
v94 (app and server) since 2026-11-25. v95 changes the app only, not the server.

## Next step
Push v95 when the owner says yes, run `tests/after-publish.cmd`, then ask how it feels on the iPad.

## Not covered / seen, not changed
- Not tested on the real iPad, nor signed-in sync on the real server. The spell-check buttons have no check.
- Two REAL changes to one notebook at the same time (a rename on one device, adding a page on another): the later one
  still wins for the name, folder and bin.
- In portrait a sliver of the tool bar shows to the right of the "..." button.
- Restoring a weekly backup has never been tested (suggested to the owner, not asked for yet).
