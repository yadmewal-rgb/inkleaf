# Handoff

**Written:** 2026-11-27, by Claude Code. **Next:** push v101 (owner's OK needed: the push was blocked by Claude Code's
permission check), then `tests/after-publish.cmd`.
**State:** **v101** committed locally on `main`, **NOT pushed**. `tests/check.cmd`: **166 passed, 0 failed, "ready to publish"**.

## What the owner asked
1. (to agy) check every line, remove code of removed features, find conflicting commands -> v101 (`6b85bb9`).
2. (to Claude Code) "check handoff", "yes check it": review agy's v101, run the check, push.
3. "bring it back pencil hold".
4. Make the app FAST ("size is not a problem, lightweight = fast"): "you can do open in offline one"; the dictionary
   "is weak, does not recognise all words, shows correct words as mistakes, also very slow".

## Live now
- App **v100** (`999a7a1`) on GitHub Pages; sync server from `999a7a1`.

## Done (local only, all in v101)
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
  Tested: 79 tricky correct words, none marked; 22 mistakes, all caught; checks added in `writing`.

## Not done / ideas
- Handwriting marks still wait ~1 s + Gemini's reading (1-3 s). When Gemini's word count for a line differs from the
  stroke groups, that line gets no spell check at all (`w: null` in hwsearch.js indexPage); could align words by position.
- "Add to dictionary" words are kept per device (localStorage), not synced.

## Next step
1. Owner allows the push -> `git push origin main` -> `tests/after-publish.cmd` must say ALL GOOD
   (worker.js changed in v101: Cloudflare must rebuild the sync server).
2. Owner tries it on the iPad: opening speed, and spell check on their notes.
