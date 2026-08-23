# Fix Plan — Round 2

**Companion to:** `REVIEW.md` § "Re-review — round 2" · **Baseline:** commit `302086b`
**Audience:** the agent/developer implementing these changes.

> **Round 1 is complete.** All nine items from the previous plan were verified as fixed by execution, except item 9a (purge images from git), which was correctly deferred and is carried forward here as item 8. The round-1 plan is archived in `FIX_PLAN_ROUND1_DONE.md` — **do not re-implement it**. Everything below is new.

**Global ground rules (unchanged)**
- Do not re-run PDF extraction. Item 5 is the only one that touches `extractor.py`, and it changes a flag, not the parse.
- After any change to `data/*.json`, run `python3 rebuild_bundle.py` so the bundle never drifts.
- Keep both HTML pages dependency-free and runnable from `python3 -m http.server`. No build step.
- After each item, run the full suite: `python3 -m unittest test_extractor.py`, `node tests/test_free_response.js`, `node tests/test_srs.js`, `node tests/test_dataset_free_response.js`.

Items 1–6 are independent. Item 7 is deploy-blocking but not urgent. Item 8 goes last because it rewrites git history.

---

## 1. Gate the section-score badges — `parent.html:306-311`

**Defect.** The hero score correctly refuses to render until both sections have 15 attempts (`parent.html:297-305`). The two section-header badges do not:

```js
if (scoreData.rwScore !== null) {
  document.getElementById('ela-section-score').innerText = `Est. Section Score: ${scoreData.rwScore} / 720`;
}
```

`calculateScaledScore` returns `rwScore` whenever `rwAttempted > 0` (`srs.js:162-163`), so **one** correct Reading question renders "Est. Section Score: 720 / 720" next to the ELA mastery header — while the hero directly above it says there is not enough data yet. A parent reads the 720. This is the same class of defect round 1 existed to remove.

**Fix.**
- Add per-section readiness to `calculateScaledScore`'s return: `rwReady: rwAttempted >= MIN_PER_SECTION`, `mathReady: mathAttempted >= MIN_PER_SECTION`. Keep the existing `isReady` (both sections) for the hero.
- In `parent.html`, render each badge only when its own section is ready. Otherwise show the attempt count instead of a score — e.g. `12 / 15 questions attempted` — so the badge still says something useful and the reader can see what unlocks it.
- Do not reuse the static `1,554 Total Qs` text as the not-ready state; it reads as if the feature is missing rather than pending.

**Done when.** With one correct Reading answer in `localStorage`, no "720" appears anywhere on the page. With 15 Reading and 0 Math answers, the ELA badge shows a score and the Math badge shows progress toward 15.

---

## 2. Use local calendar dates, not UTC — `srs.js:184`, `srs.js:207`, `parent.html:281`

**Defect.** `new Date().toISOString().split('T')[0]` yields the **UTC** date. In America/New_York it rolls over at 8pm local. Verified by execution:

```
Mon 24 Aug 21:00 EDT -> date key 2026-08-25
Tue 25 Aug 10:00 EDT -> date key 2026-08-25
```

A Monday-evening session and a Tuesday-morning session collapse into one entry, so a real two-day streak reports as one, and "Past 7 Days Practice" attributes evening minutes to the following day. Every evening study session is mis-dated.

**Fix.** Add one helper to `srs.js` and export it:

```js
function localDateKey(d) {
  d = d || new Date();
  return d.getFullYear() + '-' +
         String(d.getMonth() + 1).padStart(2, '0') + '-' +
         String(d.getDate()).padStart(2, '0');
}
```

Use it in three places:
- `recordDailySession` (`srs.js:184`) — replace the `toISOString` default.
- `calculateStreak` (`srs.js:207`) — for `today`. Also replace the `new Date(dateString)` arithmetic inside the loop (`:211-221`): that constructor parses a bare `YYYY-MM-DD` as **UTC midnight**, so the day-difference maths is doing UTC subtraction on what are now local dates. Parse with `new Date(y, m-1, d)` from split parts, or compare via a day-count integer.
- `parent.html:281` — the 7-day lookback loop.

The stored key format is unchanged, so existing `psat_sessions` data stays readable. Do not attempt to migrate old keys — they are at most a day off and rewriting them risks merging two real days.

**Done when.** `TZ=America/New_York node` shows a session at 21:00 and one at 10:00 the next morning producing two distinct entries and `calculateStreak` returning 2. Add that as a test case in `tests/test_srs.js` with an explicit `TZ` note, plus a case that crosses a month boundary (31 Aug → 1 Sep).

---

## 3. Fix the two prose free-response keys — `srs.js:43`

**Defect.** The grader splits accepted forms on commas only. Two questions store their key as prose:

- `67c08ea4` → `"either 8 or 9"`
- `7d0fa86a` → `"either 2 or 8"`

Verified: `gradeFreeResponse("8", "either 8 or 9")` returns **false**. Both correct answers are marked wrong.

**Why the tests missed it.** `tests/test_dataset_free_response.js` derives its expected forms by splitting the key on commas — the same rule the grader uses — so it compares the implementation against itself and passes vacuously on exactly the keys that are broken. A test that shares the parser it is testing cannot catch a parser bug.

**Fix.**
- Split on `/\s*(?:,|\bor\b)\s*/` and strip a leading `either\s+` from the key before splitting.
- Guard the `or` split so it cannot fire inside a numeric token (it can't today, but keep the regex word-bounded).
- Add both IDs as **explicit literal test cases** in `tests/test_free_response.js` — `assert(gradeFreeResponse('8', 'either 8 or 9'))` and the same for `9`, `2`, `8` — written by hand, not derived from the key.
- In `tests/test_dataset_free_response.js`, add an independent assertion that every FR key parses to at least one numeric form. That catches the next prose key without knowing its shape in advance.

**Done when.** All 365 items still pass, the two prose keys grade correctly for each of their values, and the dataset test would fail if a non-numeric key were introduced.

---

## 4. Unify the timing fallback and record reliability — `index.html:768`, `srs.js:76`

**Defect.** Two different invented defaults for the same "we don't know how long this took" condition:
- `index.html:768` — `let timeSpentMs = 30000;` which maps to grade **5**, the best possible grade.
- `srs.js:76` — `... : 60000;` which maps to grade 4.

Round 1 was about not inventing numbers; a silent 30-second default that produces a "Mastered" grade is a small instance of the same thing. The plan also asked for a `timingReliable` flag, which was not implemented — the 10-minute cap at `index.html:771` is applied silently, so a genuinely capped 10-minute answer and a real 10-minute answer are indistinguishable.

**Fix.**
- Export one `UNKNOWN_TIME_GRADE = 3` (conservative — "hesitant") from `srs.js` and have `gradeAttempt` return it when `timeMs` is not a usable number. Delete the `60000` default.
- In `index.html`, when `questionShownAt === null`, store `timeSpentMs: null` and `timingReliable: false` rather than a made-up 30000.
- Set `timingReliable: false` when the 600000ms cap actually trips, too.
- `gradeAttempt` should take the flag into account: unreliable timing → grade 3 for a correct answer, never 4 or 5.
- Display: `index.html:735` prints `(30s)` in the feedback banner; when timing is unreliable, print nothing rather than a fabricated duration.

**Done when.** No code path invents a duration. `tests/test_srs.js` covers `gradeAttempt(true, null)`, `gradeAttempt(true, undefined)`, and the capped case, all returning 3.

---

## 5. Derive the contradictory-source flag instead of hardcoding it — `extractor.py:41`, `normalize_data.py:47`

**Defect.** `MISMATCH_QIDS = {"f302230c", "ac972578"}` is a literal set of the two IDs from the round-1 audit, duplicated in two files. Re-extracting a different question bank flags nothing, and the constant will silently rot.

**Fix.** The generic detector already exists and works — `validator.py:77-80` parses `Choice ([A-D]) is (the best answer|correct)` from the rationale and compares it to `correct_answer`. Move that same comparison into `parse_question_text` in `extractor.py`, set `rationale_letter_mismatch` from it, and delete `MISMATCH_QIDS` from both files. Keep the validator warning as the independent cross-check — it is fine for the same rule to be asserted in two places as long as neither is a hardcoded ID list.

`normalize_data.py` was a one-shot migration; once the flag is derived, either delete it or reduce it to the skill-alias pass it still legitimately performs.

**Done when.** Re-deriving the flag over the committed JSON reproduces exactly the same two IDs, with no ID literals anywhere in the source.

---

## 6. Update `SYSTEM_ARCHITECTURE_AND_PLAN.md`

**Defect.** `README.md` and `AGENT_HANDOFF.md` were revised accurately (70.5% text completeness, 240–1440 scale). The architecture doc was not touched at all and now contradicts the shipped code in three places:

- §1 — "validated with **100% integrity** across all 3,059 questions". This is the claim item 6 of round 1 existed to retire. Replace with the two separate numbers: 3,059/3,059 schema-valid, 2,158/3,059 (70.5%) text-complete, and a sentence explaining that Math inline formulas live in the card images by design.
- §4.1 and the §4 diagram — "320–1520 for PSAT 8/9". **Factually wrong**, and it is the exact bug that was just fixed in `srs.js`. PSAT 8/9 is 240–1440 (120–720 per section). Correct both, and state the 15-attempts-per-section gate.
- §3 and the §3 diagram — "Decrease Ease Factor (-0.2)". The implementation applies the SM-2 formula, which yields **-0.54** at q=1. The doc's prose has always contradicted its own formula two lines below. Delete the "-0.2" prose and let the formula stand.

Also add `srs.js`, `rebuild_bundle.py`, `tests/`, and `.github/workflows/` to the repository-structure listing in §5, and drop the `src/backend/` and `src/frontend/` tree that never existed.

**Done when.** No number in the architecture doc contradicts the code. Grep for `1520`, `100% integrity`, and `-0.2` and confirm each hit is either gone or correct.

---

## 7. Azure uploader — three gaps before any deploy

The important fixes landed and are verified working by `--dry-run`: `image_url` rewriting, private-by-default containers, env-var credentials, threaded blob upload. Remaining:

1. **`--blob-base-url` is optional and fails silently** (`upload_to_azure.py:31`). When omitted the rewrite loop is skipped with no warning, reproducing the original broken-images bug — verified: a dry run without it prints no `image_url` line and exits 0. **Fix:** require it whenever a Cosmos upload is requested; `parser.error()` if absent. Also assert in the dry-run output that every record got an `image_url`.
2. **No resume / skip-existing.** A run that fails at blob 2,900 re-uploads all 3,059. **Fix:** list existing blob names once up front and skip those already present unless `--force` is passed.
3. **Retry is a flat `time.sleep(1.0)` × 3 on any `CosmosHttpResponseError`** (`:62-72`) — it burns retries on non-retryable 4xx and does not back off on the 429s serverless Cosmos actually produces. **Fix:** retry only on 429/503, honour the `x-ms-retry-after-ms` header when present, otherwise exponential backoff. Collect failed IDs and write them to a file; do not log "upload completed successfully" unconditionally when items failed (`:77`, `:130`).

**Done when.** `--dry-run` without `--blob-base-url` exits non-zero with a clear message; a forced mid-run failure can be resumed without duplicate uploads; the final log line reflects actual success or failure counts.

---

## 8. Repository hygiene (carried over from round 1, item 9a)

**Do this last — it rewrites git history. Confirm with the user before force-pushing anything.**

`data/images/` is still tracked (3,059 files) and `.git` is 267 MB. The images are derived artifacts, reproducible from the PDFs by `extract_questions.py`.

**Order matters — one prerequisite first:** `.github/workflows/test-and-validate.yml:45` passes `base_image_dir='data/images'` to the validator, so CI will start failing the moment the images leave the repo. **Before** the purge, make that argument conditional on the directory existing (pass `None` when absent), and note in the workflow why.

Then: add `data/images/` to `.gitignore`, remove it from history with `git filter-repo --path data/images --invert-paths` (or `git lfs migrate` if versioning them is preferred), and document in `README.md` that images are produced by `extract_questions.py` or fetched from Blob Storage.

**Done when.** A fresh clone is small and the test suite plus CI validation still pass without any images on disk.

---

## 9. Minor cleanups

- **Skills with high accuracy but few attempts disappear** — `index.html:1003-1005`. `acc >= 75 && data.t >= 3` goes to strengths, `acc < 75` goes to weaknesses; a skill at 100% on 2 attempts matches neither branch and vanishes from both panels with no explanation. Add an "In progress" grouping or show it greyed in strengths with its attempt count.
- **Invisible weekly goal** — `parent.html:288`. The study bar fills against a hardcoded 120-minute weekly goal that appears nowhere in the UI, so the reader sees a bar at 40% with no idea of what. Show the goal in the label (`48 mins / 120 min goal`) or drop the bar.
- **`innerHTML` hardening is partial** (round 1 item 9d). Options and the palette now use `textContent`, but the bank table rows (`index.html:1129-1145`) and the parent domain bars (`parent.html:325-335`) still concatenate question fields into HTML. Same low risk as before — self-generated data — but finish the job with a small `esc()` helper.
- **`python3 -m unittest discover tests` finds 0 tests.** The Python tests live in `test_extractor.py` at the repo root; only fixtures are under `tests/`. CI uses the correct invocation, so nothing is broken — but the discover form silently reports success on zero tests, which is a trap. Either move the Python tests under `tests/` with an `__init__.py`, or document the correct command in `README.md`.

---

## Verification checklist

```bash
# Python parser tests (7 pass, 2 skip without PDFs; 9 pass with them)
python3 -m unittest test_extractor.py -v

# JS suites
node tests/test_free_response.js
node tests/test_srs.js
node tests/test_dataset_free_response.js

# Timezone regression (item 2) — must report 2 distinct days
TZ=America/New_York node tests/test_srs.js

# Dataset validity + text completeness (expect 3059 / 0 / 2158)
python3 -c "import json; from validator import validate_dataset; \
  q=json.load(open('data/ela_questions.json'))+json.load(open('data/math_questions.json')); \
  r=validate_dataset(q, base_image_dir='data/images'); \
  print(r['valid_count'], r['invalid_count'], r['text_complete_count'])"

# Bundle in sync
python3 rebuild_bundle.py && git diff --stat data/questions_data.js   # expect no change

# Uploader must now refuse to run without a blob base URL (item 7)
python3 upload_to_azure.py --dry-run          # expect non-zero exit + clear message
python3 upload_to_azure.py --dry-run --blob-base-url https://acct.blob.core.windows.net
```

**Manual pass, `localStorage` cleared:** open `parent.html` — no number on the page may be non-zero and no "/ 720" score may appear. Answer one Reading question — still no 720 anywhere. Answer 15 Reading and 15 Math — the hero score and both section badges appear together, and the total is at most 1440.
