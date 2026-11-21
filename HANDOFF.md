# Handoff

**Written:** 2026-11-21 by agy (Antigravity). **Next:** Claude Code or agy.

## What the owner asked
1. "add promodoro with clock , first tell me what features you can add in this"
2. "floating can be good , it can be seen if i make notes in fullscreen and hide everything other , first show me how it will look like"
3. "it can be like this with showing its round also and show time only when i click on it then auto hide in 1.5 seconds" (with reference image of retro flip clock with round counter)
4. "make it smaller or can be scaleable ? , does these extra feature affect the stability of app ?"
5. "increase resolution of screenshots and save this to memory"
6. "go"

## Done (v65 Release)
1. **Retro Flip Pomodoro & Clock Widget (`js/editor.js`, `js/editor-consts.js`, `css/app.css`)**:
   - Designed retro flip-clock cards with dark rounded cards and horizontal center split line.
   - **Pomodoro Cycles:** Focus (25m), Short Break (5m), and Long Break (15m after round 4).
   - **Round Counter:** Displays the study round (`01`, `02`, `03`, `04`) in the bottom-left corner of the minutes tile.
   - **Tap-to-Peek Clock:** Tapping the cards temporarily reveals the real current wall-clock time (`TIME PM 12:21`) and auto-hides back to the timer after exactly 1.5 seconds.
   - **Scalable / Compact Mode:** Built with compact mini scale (~65%) by default so it takes minimal space during fullscreen note-taking; double-tapping the cards toggles to Standard size.
   - **Draggable Anywhere:** Drag-and-drop support with touch or mouse to position the widget anywhere on the screen without interfering with handwriting strokes.
   - **Side Control Strip:** Action buttons for Close (`✕`), Skip to next stage (`⏭`), Play/Pause (`⏸`/`▶`), and Reset (`⏹`).
2. **Icons (`js/icons.js`)**:
   - Added SVG icons for `skip` (`⏭`) and `stop` (`⏹`).
3. **App Stability & Safety**:
   - Implemented as an isolated overlay element above the canvas; zero interference with pen/highlighter stroke rendering, memory limits, or sync loop.
4. **Project Memory (`AGENTS.md`)**:
   - Added Pomodoro specifications and high-resolution screenshot requirements to `AGENTS.md` so Claude Code and agy share the memory.
5. **Cache & Settings Bump (`sw.js`, `js/sync.js`)**:
   - Updated service worker cache to `inkleaf-v65`.
   - Updated Settings to `Inkleaf v65 · Build 2026.11`.

## Live now
- Pushed to `origin/main` (live on https://yadmewal-rgb.github.io/inkleaf/).
- Running locally at http://localhost:8080.
