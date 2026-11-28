# Handoff

**Written:** 2026-11-28 ~21:00 India, by Claude Code. **State:** **v103 LIVE** (`5fd8dd8`, check 192/192, after-publish ALL GOOD).

## v103 (2026-11-28), from the owner's real-Drive test (screenshots in Pictures\Screenshots, 20:08-20:09)
- The owner tested annotated PDFs with the real Drive: they arrive. Found and fixed:
  - **Journal/planner words missing in the PDF** (date, weather marks, DO FIRST / BRAIN DUMP / POMODORO headings, hours,
    Round labels + circles): export.js drew only templateGeometry. Now render.js `drawPaperText` (split out of drawPaper)
    is drawn as a clear PNG (3x) over the lines; `paperHasText(pg)` says which pages need it; same words = one image.
    Affects normal PDF export too.
  - **Stray "null" in Settings** (replaceChildren got a null child). Now filtered.
  - **"1 notebook was too big for this device" on the LAPTOP** (owner: "1 pdf is not syncing even in laptop"). The crash
    guard counted closing/reloading Inkleaf mid-PDF as a crash. Now `pagehide` clears inkleaf.annTrying (a real crash never
    says goodbye). Settings names the left-out notebook(s) with a **Try again** button (`annRetry`). The old marks stay on
    the laptop until Try again is tapped. **Which notebook it is: not known yet** (owner should look in Settings). If it is a
    very big book (SnT?), the real cause may be memory while MAKING the PDF (pdf-lib loads the whole source), not the
    upload: then a lighter build is the next job (e.g. draw ink onto the loaded source PDF instead of embedPages).
  - Page count: Drive copy had 31 pages, app 32; the Drive screenshot was taken before "Update now", probably just older.
    Check it on the next look.
- Owner asked "upload in small packets ... merge in google drive": **done**. `driveResumable` (sync.js): files over
  5 MB go up in 8 MB pieces; after a break Drive is asked how much arrived (Range) and only the rest is sent; up to 6 breaks,
  waits 1-30 s. Used by big library PDFs (>= 500 MB, before: ONE multipart request) and annotated PDFs.
  Test switches `_setPiece(n, wait)`, `_driveUpload`. Not yet tried against the real Drive with a file over 5 MB.
- Owner asked: Settings shows **"In Google Drive: X of Y notebooks up to date"** (kept in localStorage inkleaf.annCount).
- Check: the Apple Pencil hold-menu check failed once (timing), passed alone and in the next full run.

## Next step
1. Owner: open Settings on the laptop, read which notebook is "Left out", tap Try again (keep Inkleaf open until it is made).
   If it stops again: it is memory while making that book -> build a lighter way for big PDFs.
2. Check the journal PDF in Drive now has its headings, and the Drive count.
3. Later (agreed): Drive as backup sync route when Cloudflare is out; live-sharing on/off switch.

## Earlier (2026-11-27)
### What the owner asked
1. (to agy) check every line, remove code of removed features, find conflicting commands -> v101 (`6b85bb9`).
2. (to Claude Code) "check handoff", "yes check it": review agy's v101, run the check, push.
3. "bring it back pencil hold".
4. (evening) Cloudflare limit: "does this limit crossing also affect other apps?" (no: only Inkleaf uses Cloudflare
   with a database; BrothersCompany is static files). "can we bypass cloudflare and still use app with full
   functionality?" (no: sign-in, sync, live sharing need it). The old meter "can tell false remaining limits like
   today": build a meter with true figures (done, v102). Ideas agreed for later: Google Drive as a backup sync route
   when Cloudflare is out (step 2), a live-sharing on/off switch (step 3). Told: the $5 paid plan is the surest fix.
5. "make annotated files in google drive, it is very important" (done, v102); then "Remove the limit. The iPad tries
   everything, and we risk crashes on big books" (done, with a crash guard).
6. "save it to handoff" (this file).
7. Earlier: make the app FAST ("size is not a problem, lightweight = fast"): "you can do open in offline one"; the dictionary
   "is weak, does not recognise all words, shows correct words as mistakes, also very slow".

## Live now
- App **v102** (`f1fc83e`) on GitHub Pages; sync server rebuilt from `917c7d2` (empty commit), meter answering.
- Local only (not pushed, docs only): `cc6d35c` and this handoff. They need no release; push with the next real change.

## Warning (learnt 2026-11-27)
- **Editing a variable or secret in the Cloudflare dashboard can deploy an OLDER copy of the server code.** The owner's
  CF_ACCOUNT edit at 17:01 UTC replaced v102 (built 16:59) with old code; `/meter` answered `signin`. Fixed by an empty
  commit. After any dashboard edit: `curl .../meter` must answer with `used`, else push an empty commit. (Also in AGENTS.md.)
- The owner's first CF_ACCOUNT value was wrong ("not authorized for that account"); the right one is the 32-character
  account ID (`GET /client/v4/accounts` with the key shows it).
- While Cloudflare's rows are used up, annotated PDFs stop too: the Drive pass comes from the sync service. Step 2
  (asking Google directly) would fix that.
- Claude Code's Chrome tool (claude-in-chrome) opens its own window, which the owner does not want; tests/check.mjs's
  ownChrome works only for local pages, not the live site.

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

## v102 (local, not pushed), part 1: Cloudflare limits meter
- Owner: the old meter showed false remaining limits (it counted requests, 9%, while rows read had run out).
- `GET /meter` (worker.js, top level, no sign-in, no database): asks Cloudflare's GraphQL analytics for today's rows read,
  rows written (`durableObjectsPeriodicGroups` sum rowsRead/rowsWritten: **confirmed by introspection** with the owner's
  key; a real run gave 5,059,242 rows read / 10,267 written / 8,694 requests on 2026-11-27, matching the dashboard) and Worker requests (`workersInvocationsAdaptive`). Each is its own
  question, so one failing shows only that line as "not known". Asked at most every 5 min (1 min after a failure).
- Needs secrets **CF_API_TOKEN** (custom token, Account Analytics: Read) and **CF_ACCOUNT** (account ID) in the dashboard.
  The key is in a text file in the owner's home folder (outside the repo; Windows named it `.txt.txt`); can be deleted.
- App: Settings > Sync box (bars amber 50%, red 80%), toast once per level (50/80/100) per day; meter read 10 s after
  start, every 30 min while on screen, and when Settings opens. Checks added (server "limits meter", Settings in writing).
- Old request counter (trackUsage/app_usage) still runs and writes rows: remove the Cloudflare-calls part once the meter
  is live (keep the Gemini/OCR count and per-user bytes).
## v102 part 2: annotated PDFs in Google Drive (owner: "it is very important")
- sync.js `annotatedPass`: every notebook (PDF + ink, or written pages) via export.js `buildPdf` into the visible Drive
  folder Inkleaf > Annotated PDFs (folder appProperties inkleaf=annotated; files appProperties inkleafDoc=<doc id>,
  e=<edit time = max(editedAt(doc), page.modified)>). Only notebooks newer than their copy are made again, the same file
  is replaced (PATCH upload; resumable over 5 MB, multipart if the Location header is not readable). Name =
  "Folder - Sub - Title.pdf"; a folder rename only renames; binned/deleted -> Drive bin; extra copies (two devices at
  once) -> bin. Never while a notebook is open; a pass a minute after start, 15 s after closing a notebook, every 20 min.
  Skips a notebook whose PDF is not on this device yet. No size limit (owner chose: iPad tries everything); crash guard:
  localStorage inkleaf.annTrying marks the notebook being made; found at the next start = it crashed; after 2 crashes in
  the same state that device leaves it to another (inkleaf.annCrashed), new writing = fresh try.
- Settings: switch "Annotated PDFs in Google Drive" (per device, localStorage inkleaf.annotated, on by default),
  progress line, Update now (waits for a running pass, then runs). Checks with a pretend Drive in the writing part.
- NOT yet tried against the real Google Drive (only the pretend one).

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
