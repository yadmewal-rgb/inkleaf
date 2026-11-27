# Handoff

**Written:** 2026-11-27 evening, by Claude Code. **Next:** owner makes the read-only Cloudflare key (see v102 below); then confirm the analytics field names, set the secrets, push v102.
**State:** v101 + row-limit fix LIVE (). **v102 committed locally, NOT pushed** (); full check 179/179 ready to publish.

## What the owner asked
1. (to agy) check every line, remove code of removed features, find conflicting commands -> v101 (`6b85bb9`).
2. (to Claude Code) "check handoff", "yes check it": review agy's v101, run the check, push.
3. "bring it back pencil hold".
4. Make the app FAST ("size is not a problem, lightweight = fast"): "you can do open in offline one"; the dictionary
   "is weak, does not recognise all words, shows correct words as mistakes, also very slow".

## Live now
- App **v101** (`1eca652`) on GitHub Pages; sync server rebuilt from it.

## Done (all in v101, live)
- agy's v101 (`6b85bb9`): dead code removed, 5 conflict fixes. Reviewed by Claude Code: fine, except what follows.
- **AI model sync fixed:** each device pushed its own choice, so a choice on one device (also "Auto") was undone by
  the next device that synced. Now the server's value wins; a device sends its own only when the server has none.
- **Apple Pencil hold menu back** (owner's wish); the pen's barrel button / eraser end still never opens it.
- **Backups:** cloud snapshots named `<time>-<random 6>`, so two devices backing up in the same ms keep both.
- **Opening offline first (`sw.js`):** the app opens from the copy kept on the device; it never waits for the network.
  Measured by the new check part `opening` (slow network = 250 ms per answer): **1.42 s before, 0.10 s now**; also opens
  with the network off, and when it is connected but answers nothing (before: blank screen until it gave up).
  A release: the new `sw.js` fetches the whole new copy in the background (`cache: 'reload'`, and refuses a mix: its
  `CACHE` must match `APP_VER` in the fetched sync.js), takes over, and a toast "A new version of Inkleaf is ready. Reload"
  appears (else it is used from the next start). The app asks for a new version when it comes back on screen (at most
  twice an hour). If the browser throws the copy away, the copy is made again in the background (at most every 10 min).
  The SW now only handles the app's own files (`SHELL`) and the share-target POST to `./`.
  The check runs the app under `/app/` for this (like `/inkleaf/`); the check server's `/sw.js` is a copy-keeper that
  removes itself, so a copy left by an older check (kept alive by an old check tab) never feeds old files to other parts.
- **Spell check rebuilt (`js/spellcheck.js`):** word list `vendor/words/en.txt` (SCOWL, ~200,000 words with every
  form, British + American, names, contractions; + Indian polity/history/geography terms and Latin legal terms),
  replacing `js/vocab.js` (40,700 words with scraps like "stration" that hid mistakes). Handles curly apostrophes,
  possessives, hyphenated words, e.g./i.e., Hindi script (not checked). Removed the loose rules ("anything ending in
  -ology", un-/re- prefixes, which let "untill" through). Suggestions: computed only when a mark is tapped, ranked by
  fewest changes then commonness, case kept, "alot" -> "a lot". The list is read when a notebook opens, in steps
  (no stutter); marks appear when it is ready. **Pages on screen are now checked when a notebook opens and after
  scrolling** (before: only a page just written on, so other pages were never checked).
  Tested: 79 tricky correct words, none marked; 21 different mistakes, all caught; checks added in `writing`.

## Cloudflare limit (2026-11-27, after v101 went live)
- Dashboard (owner logged in, Durable Objects page): today 9.14k requests, **5.06M rows read** (free plan ~5M/day),
  10.27k written, 247 errors. ~550 rows read per request.
- Cause, measured with the new `tests/rows.mjs` (real worker.js in Miniflare, 3,000-page library): `/changes` went
  through the WHOLE recs table whenever anything had changed (3,528 rows for 3 changes; also after every wake-up),
  because SQLite picked another index for `k IN (...)`. Fixed with `INDEXED BY recs_s`: now 3 rows (wake-up: 8).
  `check.mjs` (server part) now fails if an everyday request reads more than 50 rows.
- Fix LIVE (pushed `88e3f2a`, after-publish ALL GOOD). Next: owner checks rows read on the dashboard tomorrow (should be far below 5M).

## v102 (local, not pushed): Cloudflare limits meter
- Owner: the old meter showed false remaining limits (it counted requests, 9%, while rows read had run out).
-  (worker.js, top level, no sign-in, no database): asks Cloudflare's GraphQL analytics for today's rows read,
  rows written ( sum rowsRead/rowsWritten: **field names NOT confirmed yet**, the docs do not
  list them; confirm by introspection with the key) and Worker requests (). Each is its own
  question, so one failing shows only that line as "not known". Asked at most every 5 min (1 min after a failure).
- Needs secrets **CF_API_TOKEN** (custom token, Account Analytics: Read) and **CF_ACCOUNT** (account ID) in the dashboard.
  Owner was asked to save the key in C:UsersYadraminkleaf-meter-key.txt (outside the repo) for the one-time field check.
- App: Settings > Sync box (bars amber 50%, red 80%), toast once per level (50/80/100) per day; meter read 10 s after
  start, every 30 min while on screen, and when Settings opens. Checks added (server "limits meter", Settings in writing).
- Old request counter (trackUsage/app_usage) still runs and writes rows: remove the Cloudflare-calls part once the meter
  is live (keep the Gemini/OCR count and per-user bytes).
- Owner's ideas, agreed as steps 2 and 3 (not started): Google Drive as a backup sync route when Cloudflare is out;
  a live-sharing on/off switch (own devices: don't turn the live link off, polling every 6 s costs more).

## Not done / ideas
- Handwriting marks still wait ~1 s + Gemini's reading (1-3 s). When Gemini's word count for a line differs from the
  stroke groups, that line gets no spell check at all (`w: null` in hwsearch.js indexPage); could align words by position.
- "Add to dictionary" words are kept per device (localStorage), not synced.

## Next step
1. Owner tries it on the iPad: opening speed, and spell check on their notes. On each device the first open after
   the update still runs v100 (it has no Reload toast) and fetches v101 in the background: close and reopen once.
   From then on releases show the Reload toast.
