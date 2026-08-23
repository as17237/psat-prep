# Fix Plan — Round 3

**Companion to:** `REVIEW.md` § "Re-review — round 3" · **Baseline:** commit `1ba85fd`
**Audience:** the agent/developer implementing these changes.

> **Rounds 1 and 2 are complete and verified by execution.** Their plans are archived in `FIX_PLAN_ROUND1_DONE.md` and `FIX_PLAN_ROUND2_DONE.md` — **do not re-implement them.** Round 3 is small: one urgent test fix, two consistency fixes, three minors, and the long-deferred git purge.

**Global ground rules (unchanged)**
- Do not re-run PDF extraction. No item below touches the dataset.
- Keep both HTML pages dependency-free and runnable from `python3 -m http.server`.
- After each item, run: `python3 -m unittest test_extractor.py && node tests/test_free_response.js && node tests/test_srs.js && node tests/test_dataset_free_response.js`.

Items 1–2 are one change set in one file pair. Items 3–4 are independent. Item 5 goes last and needs explicit user confirmation.

---

## 1. Fix the streak-test date injection — **urgent: CI self-destructs on 2026-09-03**

**Defect.** `tests/test_srs.js:92-96` monkeypatches `PSAT_ENGINE.localDateKey` to control "today", but `calculateStreak` (`srs.js:258`) calls the module-internal closure `localDateKey()`, not the exported property — the patch is a no-op. The month-boundary assertions (`:100-101`) pass today only because their fixture dates (2026-08-31 / 2026-09-01) are in the future relative to the real clock, which makes `diffDays` negative and slips past the `diffDays > 1` staleness check. Proven by execution: with the clock at 2026-09-05 the same assertion returns 0 and the suite fails. **From 2026-09-03, every test run and CI build fails with no code change.**

**Fix.**
- Add an optional second parameter: `function calculateStreak(sessionsMap, todayKey)`, with `var todayDayNum = parseLocalDayNumber(todayKey || localDateKey());`. This mirrors the `dateStr` parameter `recordDailySession` already has, so the API becomes consistent.
- In `tests/test_srs.js`, delete the monkeypatch helper entirely and call `calculateStreak(map, '2026-09-01')` directly.
- Add a regression case that would have caught this: a fixture whose dates are all in the *past* relative to the injected today (e.g. sessions `['2026-08-30','2026-08-31']` with today `'2026-09-10'` → expect 0).

**Done when.** All Node suites pass, and they still pass when run with the system clock faked forward (e.g. `node` with a mocked `Date`, or `faketime` if available: sessions dated years ago must not make anything green by accident).

---

## 2. Clamp negative day diffs in `calculateStreak` — same change set as item 1

**Defect.** `diffDays > 1` is the only staleness check (`srs.js:261`). A session entry dated *after* today — clock rolled back, restored backup, hand-imported data — produces a negative diff, passes the check, and counts as an active streak.

**Fix.** `if (diffDays > 1 || diffDays < 0) return 0;` and skip any dates beyond today inside the counting loop (or filter `dates` to `<= todayDayNum` up front, which handles both). Add a test: sessions `['2026-09-15']` with today `'2026-09-01'` → 0.

**Done when.** Future-dated entries never contribute to a streak, covered by a test using the item-1 injection parameter.

---

## 3. Align the analytics buckets between student and parent pages — `index.html:1031-1041`

**Defect.** The student analytics weakness branch has no minimum-attempts gate: one incorrect answer makes that skill 0% and crowns it "Top Weakness" (`index.html:1033-1037`), while the parent portal requires ≥3 attempts for the same metric (`parent.html:261`) — so the two pages can name different "biggest gaps" from the same data. Relatedly, the In Progress panel's badge reads "1-2 Attempts" but its branch only accepts `acc >= 75`; a skill at 0% on 1 attempt lands in Focus Areas, contradicting the label.

**Fix.** Make attempt count the primary split, identical on both pages:

```js
if (acc === null) { /* unattempted — leave out or list separately as today */ }
else if (data.t < 3)        { inprogressList }   // any accuracy
else if (acc >= 75)          { strengthsList }
else                         { weaknessesList; /* topWeakness candidates only here */ }
```

Update the In Progress badge to "&lt; 3 Attempts". The parent portal logic is already correct — do not touch it; this brings the student page to match.

**Done when.** With exactly one wrong answer in `localStorage`, the student analytics shows that skill under In Progress and "Top Weakness: None yet" — matching what the parent portal reports. With 3 attempts at 0%, both pages name it.

---

## 4. Three minor cleanups

**4a. `esc()` and single quotes in inline handlers.** `esc()` doesn't escape `'`, yet the bank table interpolates into a single-quoted attribute: `onclick="jumpToQuestion('${esc(q.id)}')"` (`index.html:~1172`). Safe today (IDs are hex) but it's the one place the helper doesn't cover its context. Replace the inline handler: build the row's Practice button with `document.createElement`, set `btn.onclick = () => jumpToQuestion(q.id)` — the pattern the palette buttons already use — or read the ID from a `data-qid` attribute. Either removes the string-context problem entirely; do not just add `'` to `esc()`.

**4b. Blob-only dry runs shouldn't demand `--blob-base-url`.** The guard `if args.dry_run or args.cosmos_conn:` (`upload_to_azure.py:195`) routes every dry run through the Cosmos path, so `--dry-run --blob-conn ...` (testing only the image upload) exits 1 asking for a base URL it doesn't need. Require the base URL only when a Cosmos upload is actually part of the run: `if args.cosmos_conn or (args.dry_run and not args.blob_conn):` — or cleaner, an explicit `wants_cosmos = args.cosmos_conn or (args.dry_run and not blob-only intent)`; pick a readable formulation, and cover both dry-run shapes in the done-when check.

**4c. Uploader failures don't reach the exit code.** `upload_questions_to_cosmos` returns `(succeeded, failed)` but both call sites discard it (`upload_to_azure.py:198-201`), so a run with partial failures exits 0 and no script or CI step can detect it. Accumulate the counts across both files and the blob phase, log a final summary, and `sys.exit(1)` if any failures occurred.

**Done when.** A blob-only dry run works without a base URL; a Cosmos dry run still refuses without one; a simulated failure (easiest: point at an unreachable endpoint with a 1-item file) exits non-zero.

---

## 5. Purge `data/images/` from git history (carried from rounds 1–2 — now unblocked)

3,059 derived PNGs tracked; `.git` is 267 MB. The prerequisite landed in round 2: the CI validate step now passes `base_image_dir` only when the directory exists, so nothing breaks when the images leave the repo.

**Do this last — it rewrites history. Get explicit user confirmation before running `git filter-repo` or force-pushing anything.**

Steps: add `data/images/` to `.gitignore` → `git filter-repo --path data/images --invert-paths` (or `git lfs migrate` if the user prefers versioning them) → document in `README.md` that images are regenerated by `extract_questions.py` or fetched from Blob Storage → verify a fresh clone is small and `python3 -m unittest test_extractor.py` plus the CI validation command pass with no images on disk.

**Done when.** Fresh-clone `.git` is a few MB, all tests pass without images, and the user has confirmed the history rewrite (and any force-push) beforehand.

---

## Verification checklist

```bash
# Full suite
python3 -m unittest test_extractor.py -v
node tests/test_free_response.js && node tests/test_srs.js && node tests/test_dataset_free_response.js

# Item 1 regression: suite must still pass with the clock moved forward
# (any mechanism — mocked Date wrapper, faketime, or a CI matrix date)

# Item 4b: both dry-run shapes
python3 upload_to_azure.py --dry-run --blob-conn "x"        # expect success, no base URL needed
python3 upload_to_azure.py --dry-run                        # expect exit 1 (Cosmos path, no base URL)

# Dataset untouched (expect: 3059 0 2158, and no bundle drift)
python3 -c "import json; from validator import validate_dataset; \
  q=json.load(open('data/ela_questions.json'))+json.load(open('data/math_questions.json')); \
  r=validate_dataset(q); print(r['valid_count'], r['invalid_count'], r['text_complete_count'])"
python3 rebuild_bundle.py && git diff --stat data/questions_data.js
```

**Manual pass, `localStorage` cleared:** answer one question incorrectly → student analytics shows the skill under In Progress and Top Weakness reads "None yet"; open `parent.html` → it agrees.
