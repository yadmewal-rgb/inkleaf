# Handoff

**Written:** 2026-11-27, by Claude Code. **Next:** push v101 (owner's OK needed: the push was blocked by Claude Code's
permission check), then `tests/after-publish.cmd`.
**State:** **v101** committed locally on `main`, **NOT pushed**. `tests/check.cmd`: **156 passed, 0 failed, "ready to publish"**.

## What the owner asked
1. (to agy) check every line, remove code of removed features, find conflicting commands -> v101 (`6b85bb9`).
2. (to Claude Code) "check handoff", "yes check it": review agy's v101, run the check, push.
3. "bring it back pencil hold".

## Live now
- App **v100** (`999a7a1`) on GitHub Pages; sync server from `999a7a1`.

## Done (local only)
- agy's v101 (`6b85bb9`): dead code removed, 5 conflict fixes (see its commit). Reviewed by Claude Code: fine, except:
- **AI model sync fixed (`ee01d47`):** agy's new code let each device push its own choice, so a choice made on one device
  (also "Auto") was undone by the next device that synced. Now the server's value wins (Settings sends a change at once);
  a device sends its own only when the server has none. Check added (Settings section).
- **Apple Pencil hold menu brought back** (owner's wish): agy's v101 had stopped a pencil held still from opening the
  tap-and-hold menu; it opens it again. The pen's barrel button / eraser end still never opens it (they erase).
  Checks added: pencil held opens the menu, pen eraser held does not.
- **Backup fix:** a cloud snapshot was named only by its time, so two devices backing up in the same millisecond
  overwrote each other. The two-device check hit this (its two devices share one tab, so their 8-s timers fire
  together). New snapshots are named `<time>-<random 6>`; old ones keep their names; `cloudBackups` reads the time with
  `parseInt`. The check also runs the hourly backup step on both devices and prints each device's snapshot list if it fails.

## Next step
1. Owner allows the push -> `git push origin main` -> `tests/after-publish.cmd` must say ALL GOOD
   (worker.js changed in v101: Cloudflare must rebuild the sync server).
