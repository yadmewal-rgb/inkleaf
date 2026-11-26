# Handoff

**Written:** 2026-11-26, about 18:45, by agy (Antigravity). **Next:** agy or Claude Code.
**State:** **v97** (`ad0b60c`) is pushed and live everywhere. Working tree has only this handoff note committed locally (not pushed, so it goes up with the next release without triggering an extra build).

## Live now
- App **v97** (commit `ad0b60c`) on GitHub Pages (`https://yadmewal-rgb.github.io/inkleaf/`).
- Sync service (`server/worker.js` from `ad0b60c`) on Cloudflare (`https://inkleaf-sync.yadmewal.workers.dev`); Cloudflare build `success`, `tests/after-publish.cmd`: **ALL GOOD**.
- `tests/check.cmd --quick`: **51 passed, 0 failed** (code, imports, CSS rules, versions, and Miniflare sync server checks).
- Chrome visual check (`browser` tool against local `http://localhost:8089/?profile=visualdemo`): loaded with **0 console errors and 0 warnings**, tested folder -> subfolder -> notebook creation, editor open, and Settings (`v97`). Fixed `.account-meta .bk-sub` left-alignment in `css/app.css` after inspecting screenshot.

## Owner's words on 2026-11-26
1. Six items:
   1. OneDrive-style rotating sync icon on folders/subfolders/notebooks. -> **Live in v97.**
   2. Add users without going to Cloudflare. -> **Live in v97 (owner-only Allowed users in Settings).**
   3. How to get more than 5 GB total space? -> **Answered; storage logic kept unchanged as owner requested.**
   4. Missing/hidden sign out option. -> **Live in v97 (top Account card in Settings, `this device` button, sidebar footer icon, Access denied button).**
   5. Cumulative Gemini & Cloudflare usage without names or sub-division (`You`, `Other user` / `Other user 1`, ...). -> **Live in v97.**
   6. Why sharing uploads first and how to make it faster. -> **Answered.**
2. `go and keep 'How to get more than 5 GB total space:' unchanged`
3. `go` (checked in Chrome, fixed CSS alignment, pushed `v97` live).

## What the owner must do
1. Reload Inkleaf twice on every device (friends too) until Settings shows **v97**.
2. Open Settings once while signed in on each user's account so every user registers in the new cumulative usage tracker (`You` / `Other user`).
3. Still open from earlier (`v96`): check if fixed **folder dots** colour (`folderColorOf`) should be switched on, and test on the real iPad.

## Not tested
- Full `tests/check.cmd` in the owner's own Chrome (`spawn(chrome.exe)` from this background runner could not open a tab; `evaluate_script` is blocked by user rule, so signed-in mock UI states like active rotating sync badges, Allowed users, and multi-user usage pills were tested via `tests/check.cmd --quick` Miniflare tests rather than visually in Chrome).
- Real iPad, real signed-in multi-user sync, and real Cloudflare Worker live `/me` after `v97` deploy.
