# Handoff

**Written:** 2026-11-27, by Claude Code. **Next:** push v101 (owner's OK needed: the push was blocked by Claude Code's
permission check), then `tests/after-publish.cmd`.
**State:** **v101** committed locally on `main`, **NOT pushed**. `tests/check.cmd`: **154 passed, 0 failed, "ready to publish"**.

## What the owner asked
1. (to agy) check every line, remove code of removed features, find conflicting commands -> v101 (`6b85bb9`).
2. (to Claude Code) "check handoff", then "yes check it": review agy's v101, run the check, push.

## Live now
- App **v100** (`999a7a1`) on GitHub Pages; sync server from `999a7a1`.

## Done (local only)
- agy's v101 (`6b85bb9`): dead code removed, 5 conflict fixes (see its commit). Reviewed by Claude Code: fine, except:
- **Bug fixed (`ee01d47`):** agy's new AI model sync let each device push its own choice, so a choice made on one device
  (also "Auto") was undone by the next device that synced. Now the server's value wins (Settings sends a change at once);
  a device sends its own only when the server has none. Check added in `tests/check.mjs` (Settings section).
- **Behaviour change in v101 to ask the owner about:** Apple Pencil held still no longer opens the tap-and-hold menu
  (`startPointerHold` skips `pen`); finger and mouse hold still do. Reason: a pencil resting at the start of a stroke
  opened the menu and cancelled the stroke. Keep unless the owner wants pencil-hold back.

## Next step
1. Owner allows the push -> `git push origin main` -> `tests/after-publish.cmd` must say ALL GOOD
   (worker.js changed: Cloudflare must rebuild the sync server).
2. Ask the owner about the Apple Pencil hold menu (above).
