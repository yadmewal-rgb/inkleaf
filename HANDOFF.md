# Handoff

**Written:** 2026-11-20 by agy (Antigravity). **Next:** Claude Code or agy.

## What the owner asked
1. "make it like = use gemini 3.8 then 3.7 then 3.6 and then lower 3.5 and switchthem automatically if any of them is failed , when i open this every time then start it from best version available , keep option of changing it from settings, ,,, when genimi do not work then shift it to cloudflare and if its limit is exahusted then use device,, when device is offline then use divices and when it came online then check these with AI , tell me is it correct and how you going to do it ?"
2. "if lite version of 3.8,3.7 ,3.6 available then use them according to their capability and go ahead"

## Done (v58 Release)
1. **Tiered Model Cascade Waterfall (`js/hwsearch.js`)**:
   - Sequential capability waterfall:
     `gemini-3.8-flash` ➔ `gemini-3.8-flash-lite` ➔ `gemini-3.7-flash` ➔ `gemini-3.7-flash-lite` ➔ `gemini-3.6-flash` ➔ `gemini-3.6-flash-lite` ➔ `gemini-3.5-flash` ➔ `gemini-3.5-flash-lite` ➔ `gemini-3.1-flash-lite` ➔ `gemini-2.5-flash`.
   - On every fresh app open / session start, always begins at the top best model (`gemini-3.8-flash`).
   - If an active model fails (404 not found, 429 quota exhausted, 503 overloaded), it automatically steps down to the next model in the waterfall without crashing or stopping.
2. **Provider Failover (Direct Gemini ➔ Cloudflare Worker ➔ On-Device)**:
   - **Provider 1 (Direct Gemini)**: If user entered an API key, tries direct Gemini stepping down models.
   - **Provider 2 (Cloudflare Worker)**: If direct Gemini fails or no key is present, shifts automatically to Cloudflare Worker (`/ocr`). Worker whitelist updated to support all 3.8, 3.7, 3.6, and 3.5 models with built-in fallback.
   - **Provider 3 (On-Device)**: If offline or daily AI limits are exhausted, shifts to 100% on-device spellcheck and search with zero interruption.
3. **Automatic Online Reconnection Sync**:
   - `online` event listener automatically restores fail count, resets waterfall to the top model (`gemini-3.8-flash`), and scans/indexes all notes written while offline.
   - Newly transcribed handwriting automatically triggers live spellcheck red dotted underlines on screen.
4. **Settings UI & Live Waterfall Status (`js/sync.js`)**:
   - Added **Auto (Best Available: 3.8 ➔ 3.5 fallback) — Recommended** as default setting.
   - Dropdown includes options for all individual models if the user prefers to lock a specific version.
   - Real-time status subtitle badge showing the active model and waterfall path:
     `Active now: gemini-3.8-flash · Fallback path: 3.8 ➔ 3.7 ➔ 3.6 ➔ 3.5 ➔ Cloudflare ➔ Device`.
5. **App Version & Cache**:
   - Bumped to `v58` in `sw.js` and `js/sync.js`.

## Tested
- Verified JS syntax with `node --check`.
- Ran unit tests verifying:
  - 10-model cascade hierarchy and capability order.
  - Fresh session starts at `gemini-3.8-flash`.
  - Sequential stepDown through all models.
  - Graceful stepDown termination.
  - Online reconnection reset back to `gemini-3.8-flash`.
  - Settings manual lock and Auto restore.
- Ran live browser tests via Edge CDP:
  - Verified Settings modal renders `Settings (v58)` and `Inkleaf v58`.
  - Verified default dropdown shows `Auto (Best Available: 3.8 ➔ 3.5 fallback) — Recommended`.
  - Verified live active model status badge.
  - Simulated model step-down in live session updating status to `Active now: gemini-3.7-flash (auto fallback)`.
- Verified screenshots:
  - `C:\Users\yadram\AgentTools\shots\ai_waterfall_settings_row.png`
  - `C:\Users\yadram\AgentTools\shots\settings_waterfall_card.png`

## Live now
- Committed locally to branch `main`.
- Running locally at http://localhost:8080.

## Owner must do
- Push to GitHub: Run `git push origin main` in PowerShell when ready to release to GitHub Pages and Cloudflare Worker.
