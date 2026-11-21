# Handoff

**Written:** 2026-11-21 by agy (Antigravity). **Next:** Claude Code or agy.

## What the owner asked
1. "add promodoro with clock , first tell me what features you can add in this"
2. "floating can be good , it can be seen if i make notes in fullscreen and hide everything other , first show me how it will look like"
3. "it can be like this with showing its round also and show time only when i click on it then auto hide in 1.5 seconds" (with reference image of retro flip clock with round counter)
4. "make it smaller or can be scaleable ? , does these extra feature affect the stability of app ?"
5. "increase resolution of screenshots and save this to memory"
6. "go"
7. "not able to drag promodoro"
8. "not working , not able to set it , it just set at there and do nothing"
9. "compare it with https://play.google.com/store/apps/details?id=com.wssc.simpleclock&hl=en_IN"
10. "C:\Users\Yadram\Pictures\Screenshots i meant for these"
11. "add them according to our interface, and when i click on it to see time then show it beside it not on itself"

## Done (v67 Release)
1. **Tag & Preset Selector Popover (`js/editor.js`, `js/editor-consts.js`, `css/app.css`)**:
   - Added top pill button on the widget showing current active tag with a color dot and arrow (e.g. `🔴 pre ans reading ›`).
   - Clicking the pill opens the "Select Tag" popover menu with presets (`Focus 25:00`, `pre ans reading 20:00`, `Study 30:00`), active checkmark, and a `+ Add New Preset` button.
   - Selecting any preset updates the active tag, countdown length, color dot, and resets the timer smoothly.
2. **Side Peek Clock ("beside it, not on itself") (`js/editor.js`, `css/app.css`)**:
   - Tapping the flip cards displays a floating glass badge (`⏰ HH:MM AM/PM`) **BESIDE** the widget for 1.5 seconds.
   - The countdown digits on the flip cards stay visible and uninterrupted.
   - Intelligently positions on the right or left depending on widget screen position so it never overflows off-screen.
3. **Timer Settings Modal (`js/editor.js`, `css/app.css`)**:
   - Tapping `⚙` on the action strip or `+ Add New Preset` in the tag popover opens the complete Timer Settings modal.
   - Mode switch: **Pomodoro** (countdown) vs **Stopwatch** (countup).
   - Tag name text input.
   - Tag color picker dots from `SEC_COLORS`.
   - Focus duration (minutes), Break duration (minutes), and Round/Loop count inputs.
   - Saves into `TM.presets` and immediately applies to the active session.
4. **Tested & Verified Visually in Chrome**:
   - Verified tag selection popover, side clock badge, and modal dialog.
   - Captured and reviewed high-resolution screenshots.
5. **PWA Cache Bump (`sw.js`, `js/sync.js`)**:
   - Bumped service worker cache to `inkleaf-v67`.
   - Updated Settings to `Inkleaf v67 · Build 2026.11`.

## Live now
- Tested locally on http://localhost:8080.
- Ready to commit and push to `origin/main` upon owner confirmation.
