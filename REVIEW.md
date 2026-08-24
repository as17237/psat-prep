# Code Review — PSAT Prep Mastery Platform

**Reviewed:** 2026-08-23 · commit `6bec447` (main)
**Scope:** `extractor.py`, `validator.py`, `extract_questions.py`, `test_extractor.py`, `upload_to_azure.py`, `index.html`, `parent.html`, `data/*`, project docs.

## What the project does

A local, dependency-free PSAT prep app. A Python pipeline (`extractor.py`) parses four College Board PDFs — a question bank and its matching answer/rationale bank for each of ELA and Math — into structured JSON, and renders each question's source pages as a stitched PNG "card" so formulas and charts survive as pixels. `validator.py` checks the extracted records, `extract_questions.py` orchestrates both and emits `data/questions_data.js`. Two static pages consume that bundle: `index.html` (practice, analytics, question explorer, `localStorage` progress) and `parent.html` (parent-facing summary). `upload_to_azure.py` is a one-shot migration to Cosmos DB + Blob Storage.

Verified during this review: the answer PDFs contain exactly 1,554 (ELA) and 1,505 (Math) question IDs, and all 3,059 are present in the JSON with unique IDs and a matching image on disk. Every extracted ID also exists in the corresponding *question* PDF, so no card was accidentally rendered from an answer page.

---

## Extraction verification (independent audit)

I re-derived the dataset from the four source PDFs and compared against the committed JSON and images. **Verdict: extraction is correct and complete.** The defects in this codebase are in the consuming code and the documentation, not in the extracted data.

### Structural checks — all pass

| Check | ELA | Math |
| :--- | :--- | :--- |
| Question IDs in answer PDF | 1,554 | 1,505 |
| Records in JSON | 1,554 | 1,505 |
| Unique IDs (no duplicates, no collisions) | ✓ | ✓ |
| Every JSON ID present in the *question* PDF | ✓ (0 missing) | ✓ (0 missing) |
| JSON record order matches PDF order | ✓ | ✓ |
| Page runs per question contiguous | ✓ (0 gaps) | ✓ (0 gaps) |
| PDF pages accounted for by the index map | 1,564 / 1,564 | 1,520 / 1,520 |

No question was dropped, duplicated, merged, or reordered. Notably, the `q_pages_map.get(qid, a_pages)` fallback at `extractor.py:287` — which would render a card from the *answer* PDF and spoil the question — never fires, because every ID exists in both PDFs.

### Image checks — all pass

All 3,059 images exist, none are undersized, and there are no orphans. Rendered heights match page counts exactly, confirming multi-page stitching is correct and nothing was truncated:

| Source pages | Questions | Rendered height |
| :--- | :--- | :--- |
| 1 | 3,039 | 1584 px (all) |
| 2 | 15 | 3168 px (all) |
| 3 | 5 | 4752 px (all) |

### Content checks — 60-question random ground-truth audit

I sampled 60 questions at random, pulled their raw text back out of the answer PDFs, and independently re-derived every field. **60/60 matched** on `assessment`, `test`, `domain`, `skill`, `difficulty`, and `correct_answer`. A separate 40-question ELA audit found **0/40** with any discrepancy in option text or question text.

Dataset-wide cross-checks:
- **MCQ answer keys:** 2,692 of 2,694 agree with the "Choice X is correct" claim in their own rationale.
- **Answer distribution:** A 689 / B 687 / C 631 / D 687 — uniform, as expected. A systematic parsing bias would show here.
- **Option integrity:** 0 MCQs with the wrong option count or key sequence; 0 free-response items carrying stray options.
- **Free-response keys:** all 365 come from the explicit `Correct Answer:` line, not from rationale guessing.

### Four data caveats worth knowing (none are extraction failures)

1. **Math text is lossy by design — 875 of 1,505 Math questions have placeholder option text.** College Board renders math as vector curves, so the PDF text layer genuinely has no formula in it: rationales read "The correct answer is ." with the number missing. The card image is the authoritative rendering and it is complete. This is the right tradeoff, but it must be *labeled* rather than reported as 100% fidelity (fix plan item 6).
2. **72 free-response keys hold several accepted forms in one string** (`".2, 1/5"`). The data is correct; the grader in `index.html` is not (fix plan item 3).
3. **Two questions have a self-contradictory source.** For `f302230c` and `ac972578`, the PDF's own `Correct Answer:` line says A/B while its rationale says "Choice D is correct"/"Choice C is correct". The extractor correctly follows the explicit key. This is a College Board defect; it needs a UI caveat, not a code fix (item 7b).
4. **One skill name appears in two casings** — `Cross-Text Connections` (41) and `Cross-text Connections` (2) — which splits it into two buckets in every analytics grouping (item 7a).

---

## Top 5 things that work well

### 1. The image-card strategy is the right call, and it is executed cleanly
College Board PDFs render math as vector curves, so text extraction inevitably drops formulas. Rendering the source pages instead (`extractor.py:211-227`) sidesteps the whole problem, and multi-page questions are stitched into one image rather than truncated. The page-index map (`extractor.py:37-59`) that makes this possible is a simple, correct approach to a genuinely awkward problem.

### 2. Extraction coverage is complete and independently verifiable
Re-scanning all four PDFs confirmed 3,059 of 3,059 questions extracted, zero duplicate IDs, zero IDs missing from the question-side PDFs. Answer-key recovery is layered sensibly (`extractor.py:155-174`): explicit `Correct Answer:` line first, then three rationale-based fallbacks for MCQ, multi-form SPR answers, and plain free-response. That layering is why coverage is complete rather than ~90%.

### 3. Clean separation of extract / validate / publish
`extractor.py`, `validator.py`, and `extract_questions.py` have one job each, communicate through plain dicts, and the CLI is properly parameterized (`--subject`, `--limit`, `--workers`, `--no-images`). Parallelism is handled correctly for `ProcessPoolExecutor` — paths, not PDF handles, are sent to workers, and each worker opens its own documents (`extractor.py:230-237`).

### 4. Zero-install, zero-CORS deployment
Shipping the data as `window.QUESTIONS_DATA` in a `.js` file instead of a `fetch`ed JSON means `python3 -m http.server` — or even `file://` — is enough to run the whole thing. For a personal study tool that is worth more than an elegant build pipeline.

### 5. The student UI is genuinely usable
Filters, a paginated question palette with per-question correct/incorrect/flagged state, dual card/text mode, keyboard shortcuts, collapsible rationales, and a searchable bank explorer all work off a single `progress` object with straightforward persistence (`index.html:429-448`). Pagination on both the palette and the bank table keeps DOM size bounded despite 3,059 records.

---

## Top 5 things that need improvement

### 1. The parent portal displays fabricated numbers
`parent.html` hardcodes a study streak of "5 Days" (`:70`), "185 mins / 200 min goal" (`:74`), "14 Questions" due for review (`:86`), and a top weakness of "Inferences" (`:126`). No JavaScript ever writes to `hero-streak`, `hero-study-time`, `hero-srs-due`, or `stat-top-weakness` — `renderParentMetrics()` (`:211-275`) sets only four other fields. The score forecaster compounds it: with zero questions attempted it prints **1460** (`parent.html:246`), and the formula `700 + accuracy × 820` is an invented linear mapping with no relationship to College Board scaling — 100% accuracy on ten easy questions reads as 1520. This is the highest-priority fix: a parent looking at this dashboard is being shown numbers that are not measurements. Either compute these from real data or remove the tiles until the data exists.

### 2. The SRS engine does not exist
Spaced repetition is feature #3 in `README.md`, has a full SM-2 specification with ease-factor math in `SYSTEM_ARCHITECTURE_AND_PLAN.md` §3, and a due-count tile in the parent portal. There is no implementation. Grepping the codebase finds no ease factor, no interval, no review queue, and — critically — no timing capture at all: `selectMultipleChoice()` (`index.html:655-667`) records only `answered`, `selectedAnswer`, `isCorrect`, `timestamp`. The documented algorithm grades on response time (q=3/4/5 by 90s/45s thresholds), so the data required to ever compute it is not being collected. Start by recording per-question elapsed time on question load/submit; the scheduler is short work once that exists.

### 3. Free-response grading is a naive string comparison
`index.html:668` does `inputVal.toLowerCase() === q.correct_answer.toLowerCase()`. Of the 365 free-response items, **72 store multiple accepted forms in one string** — e.g. `".2, 1/5"`, `"14.66, 14.67, 44/3"`, `"-.3266, -.3267, -49/150"`. A student who types the correct `0.2` is marked wrong, and so is anyone entering `2.5` where the key says `5/2`. Fix in two places: split the stored key on commas into a list of accepted answers, and compare numerically (parse fractions and decimals, compare within tolerance) rather than as text.

### 4. The validator reports 100% while ~29% of options are placeholders
When choice parsing fails, `extractor.py:190-194` substitutes literal `"Option A"…"Option D"` text. That fires on **875 of 1,505 Math questions** (and 1 ELA) — 900 questions have at least one placeholder choice. `validate_question()` checks only that four options exist with keys `A`–`D` (`validator.py:47-53`), so all of them pass, and the docs report "100% validated / zero dropped formulas". Text Mode, the bank explorer's search, and any future text-based feature are unusable for those questions. Two changes: have the validator flag placeholder text as a warning and report a real "text-complete" percentage separately from schema validity, and correct the claims in `README.md` / `SYSTEM_ARCHITECTURE_AND_PLAN.md` to state that Math text mode is card-backed by design.

### 5. Repository hygiene and the Azure path
Several things will bite on the next machine or the first real deploy:
- **325 MB of PNGs are committed** (`.git` is 264 MB). The `.gitignore` excludes the PDFs but not the derived images. They belong in Blob Storage — which `upload_to_azure.py` already exists to do.
- **The test suite cannot run from a fresh clone.** `test_extractor.py:118-132` extracts from `ELA1.pdf`/`MATH1.pdf`, which are gitignored, so all nine tests fail on checkout. Commit small fixture PDFs or record parsed text fixtures, and split the pure parsing tests (`parse_question_text`, `parse_choices_robust`) from the ones needing real PDFs.
- **`upload_to_azure.py` doesn't match its own schema.** It upserts records with `question_image: "images/x.png"`, but the documented Cosmos document uses an absolute `image_url` blob URL — nothing rewrites the path, so the deployed app would have broken images. It also uploads 3,059 items and 3,059 blobs in sequential loops with no batching or retry, takes connection strings as CLI args (they land in shell history — prefer env vars or `DefaultAzureCredential`), and sets `public_access="blob"`, which makes copyrighted College Board content world-readable.
- **Minor, same area:** several render paths use `innerHTML` with question data interpolated (`index.html:625-628`, `:975-991`); the data is self-generated so this is low-risk today, but a `<` in a rationale or option will silently mangle the DOM.

---

## Suggested order of work

1. Remove or wire up the fabricated parent-portal tiles, and re-derive the score projection from a defensible mapping (or label it clearly as a rough estimate).
2. Fix free-response grading (multi-form keys + numeric comparison).
3. Capture per-question response time — the prerequisite for everything SRS.
4. Make the validator distinguish "schema valid" from "text complete", and align the docs with reality.
5. Purge `data/images/` from git, fix the image-URL rewrite in the Azure uploader, and make the test suite runnable from a clean clone.

See **`FIX_PLAN.md`** for the implementation plan covering every item above.

---
---

# Re-review — round 2

**Reviewed:** 2026-08-23 · commit `302086b` ("fix: implement review items") vs `6bec447`
**Verdict: 8 of 9 plan items are genuinely fixed, and the fixes are real — not cosmetic.** I verified them by executing the code, not by reading it. Four defects remain, one of which (the section-score gate leak) is a smaller instance of the exact problem round 1 was about. None are large.

## Verification performed

| Check | Result |
| :--- | :--- |
| Dataset schema validation | 3,059 / 3,059 valid, 0 errors |
| Text-completeness metric | 2,158 (70.5%) — matches independent recount |
| Bundle ↔ JSON sync | in sync, IDs and order preserved |
| Skill casing collisions | 0 (26 skills, down from 27) |
| Python tests on a **clean clone with no PDFs** | 7 passed, 2 skipped, 0 failed |
| Python tests with PDFs present | 9 passed |
| Node test suites (3) | all pass |
| SM-2 ladder, executed | 1 → 3 → 7 → 18 → 45 days, EF floor 1.3 holds, failure resets to reps 0 / 1 day |
| Free-response grader vs **all 365 items** | every stored form of every key grades correct (446 forms) |
| Azure uploader `--dry-run` | image_url rewrite produces correct absolute blob URLs |

## Item-by-item status

| # | Item | Status |
| :--- | :--- | :--- |
| 1 | Parent-portal fabrications | **Fixed** — one leak, see A |
| 2 | Score projection | **Fixed** — 240–1440, per-section, sample-gated |
| 3 | Free-response grading | **Fixed** — 363/365; see B |
| 4 | Response-time capture | **Fixed** — see C |
| 5 | SRS engine | **Implemented and correct** |
| 6 | Validator text-completeness | **Fixed** |
| 7a | Skill casing | **Fixed** |
| 7b | Contradictory-source flag | **Fixed** — hardcoded rather than derived, see D |
| 8 | Azure uploader | **Mostly fixed** — see E |
| 9a | Purge images from git | **Not done** — deferred as instructed |
| 9b | Portable test suite | **Fixed and verified** |
| 9c | Multi-ID-per-page warning | **Fixed** |
| 9d | `innerHTML` hardening | **Partial** — options and palette use `textContent`; bank table and parent domain bars still concatenate |

## What was done well

`srs.js` is the standout. Making it a UMD module with zero DOM access means the SM-2 logic, the grader, and the score model are all directly testable from Node — and the three test files actually exercise them, including one that runs the grader across the entire real dataset. That is a better structure than I proposed.

The timing capture is also more careful than asked: `visibilitychange` accounting genuinely excludes background time, verified by inspection of the accumulate-on-hide / reset-on-show pair.

And the empty-states are honest now. With `localStorage` cleared, the parent hero shows `—` with "Needs at least 15 questions attempted per section (current: 0 RW, 0 Math)". That is the right behaviour.

## Remaining defects

### A. Section scores bypass the sample-size gate — `parent.html:307-312`

The hero score correctly refuses to render until both sections have 15 attempts. The two section-header badges do not:

```js
if (scoreData.rwScore !== null) {
  document.getElementById('ela-section-score').innerText = `Est. Section Score: ${scoreData.rwScore} / 720`;
}
```

`calculateScaledScore` returns `rwScore` whenever `rwAttempted > 0` (`srs.js:162-163`), so **one** correct Reading question renders "Est. Section Score: 720 / 720" next to the ELA mastery header — while the hero directly above it says there isn't enough data yet. A parent reads the 720. Gate both badges on `scoreData.isReady` (or add a per-section readiness flag), and show `—` otherwise.

### B. Two free-response keys are ungradeable — `srs.js:38-58`

The grader splits accepted forms on commas. Two questions store their key in prose instead:

- `67c08ea4` → `"either 8 or 9"`
- `7d0fa86a` → `"either 2 or 8"`

Verified by execution: `gradeFreeResponse("8", "either 8 or 9")` returns **false**. Both correct answers are marked wrong, and no test caught it because `tests/test_dataset_free_response.js` splits on commas the same way the grader does — so it checks the key against itself and passes vacuously. Split on `/\s*(?:,|\bor\b)\s*/` and strip a leading `either`, then add these two IDs as explicit test cases so the test stops mirroring the implementation.

### C. Streak and daily totals use the UTC date, not the local one — `srs.js:184, 207` and `parent.html:279`

`new Date().toISOString().split('T')[0]` yields the **UTC** calendar date. In America/New_York that rolls over at 8pm local. Executed proof:

```
Mon 24 Aug 21:00 EDT -> date key 2026-08-25
Tue 25 Aug 10:00 EDT -> date key 2026-08-25
```

An evening session on Monday and a morning session on Tuesday collapse into a single day entry, so a real two-day streak reports as one, and "Past 7 Days Practice" attributes evening minutes to the following day. Use a local-date formatter instead:

```js
function localDateKey(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
```

Apply it in `recordDailySession`, `calculateStreak`, and the 7-day loop in `parent.html`. Existing stored keys stay readable — the format is identical.

**Two smaller timing issues in the same area:**
- `index.html:766` defaults to `timeSpentMs = 30000` when the clock is missing, and `srs.js:76` defaults to `60000` for the same condition. The two disagree, and 30s maps to grade **5** — the best possible grade, invented. Use one shared default, pick the conservative grade (3), and carry the `timingReliable: false` flag the plan called for so the SRS can tell "answered fast" from "we don't know".
- `parent.html:288` measures the study bar against a hardcoded 120-minute weekly goal that appears nowhere in the UI, so the bar fills against an invisible target. Show the goal or drop the bar.

### D. The contradictory-source flag is hardcoded — `extractor.py:41`, `normalize_data.py:47`

`MISMATCH_QIDS = {"f302230c", "ac972578"}` is a literal set of the two IDs I happened to report. Re-extracting a different bank flags nothing. The generic detector already exists and works — it's in `validator.py:77-80`. Move that same regex comparison into `parse_question_text` and set the flag from it; delete the constant from both files.

### E. Azure uploader — three gaps before it is deploy-safe

The important fixes landed: `image_url` rewriting, private-by-default containers, env-var credentials, threaded blob upload, `--dry-run`. Remaining:

1. **`--blob-base-url` is optional**, and when omitted the rewrite loop is skipped silently (`upload_to_azure.py:31`) — reproducing the original broken-images bug with no warning. Verified: a dry run without it prints no `image_url` line and exits 0. Make it required whenever a Cosmos upload is requested, or fail loudly.
2. **No resume / skip-existing.** A failed run re-uploads all 3,059 blobs.
3. **Retry is a flat `time.sleep(1.0)` × 3 on any `CosmosHttpResponseError`** (`:62-72`) — it burns retries on non-retryable 4xx and doesn't back off on the 429s that serverless Cosmos will actually produce. Check the status code and use exponential backoff. Also, "upload completed successfully" is logged unconditionally even when individual items failed.

### F. `SYSTEM_ARCHITECTURE_AND_PLAN.md` was never updated

`README.md` and `AGENT_HANDOFF.md` were revised accurately — the handoff now states 70.5% text completeness and the 240–1440 scale. The architecture doc still says:

- "validated with **100% integrity**" (§1) — the claim item 6 was meant to retire
- "320–1520 for PSAT 8/9" (§4.1, and the diagram at §4) — factually wrong, and the exact bug fixed in the code
- "Decrease Ease Factor (-0.2)" (§3, diagram) — the implementation correctly applies the SM-2 formula, which yields **-0.54** at q=1; the doc's prose and its own formula have always contradicted each other

Fix the doc to match the shipped behaviour, or the next agent will "fix" the code back to the wrong scale.

### G. Minor: skills with high accuracy but few attempts vanish — `index.html:1003-1005`

```js
if (acc !== null && acc >= 75 && data.t >= 3) { strengths }
else if (acc !== null && acc < 75) { weaknesses }
```

A skill at 100% on 2 attempts matches neither branch and disappears from both panels with no explanation. Add an "In progress" grouping, or show it greyed in strengths with the attempt count.

### H. Minor: `python3 -m unittest discover tests` finds 0 tests

The Python tests live in `test_extractor.py` at the repo root, so the discover command in the round-1 checklist runs nothing. CI uses `python -m unittest test_extractor.py`, which works — the checklist was wrong, not the code. Worth aligning so nobody mistakes an empty run for a pass.

**Forward-looking:** the CI validate step passes `base_image_dir='data/images'`, so it will start failing the moment item 9a removes the images from git. Make the image check conditional on the directory existing before that purge happens.

## Suggested order for round 2

1. Gate the section-score badges (A) — same class of defect as round 1, user-visible.
2. Fix the local-date keys (C) — silently corrupts streaks and daily totals from day one.
3. Fix the two prose free-response keys, and make the test stop mirroring the implementation (B).
4. Unify the timing default and add `timingReliable` (C, sub-item).
5. Derive the mismatch flag instead of hardcoding it (D).
6. Update `SYSTEM_ARCHITECTURE_AND_PLAN.md` (F).
7. Require `--blob-base-url`, add resume and real backoff (E) — before any deploy, not before.
8. Then item 9a: purge `data/images/` from git, and make the CI image check conditional first.

---
---

# Re-review — round 3

**Reviewed:** 2026-08-23 · commit `1ba85fd` ("fix(round-2)") vs `302086b`
**Verdict: all eight round-2 items are genuinely fixed and verified by execution.** The codebase is in good shape. Round 3 is small: **one real defect** (a test that will start failing by itself on 2026-09-03 — proven, not speculated), a few minor consistency issues, and the still-pending git history purge, which is now unblocked.

## Verification performed

| Check | Result |
| :--- | :--- |
| Python tests (9) · Node suites (3) · `TZ=America/New_York` run | all pass |
| Section badges (item 1) | `rwReady`/`mathReady` gate both badges; not-ready state shows `N / 15 questions attempted` — no score leaks from a single answer |
| Local dates (item 2) | `localDateKey()` used in `recordDailySession`, `calculateStreak`, and the parent 7-day loop; day arithmetic via UTC day-numbers, immune to DST |
| Prose FR keys (item 3) | `gradeFreeResponse('8','either 8 or 9')` → true (and `'7'` → false); literal test cases present; dataset test now independently asserts every key parses to ≥1 numeric form (72 multi-form keys / 448 forms) |
| Timing reliability (item 4) | `timeSpentMs: null` + `timingReliable: false` when unknown; no invented durations; `gradeAttempt(true, null)` → 3, `gradeAttempt(true, 30000, false)` → 3, both tested |
| Mismatch flag (item 5) | derived dynamically in `extractor.py` and `normalize_data.py`; re-deriving over the committed JSON reproduces exactly `{ac972578, f302230c}`; no hardcoded ID lists remain |
| Architecture doc (item 6) | greps for `1520`, `100% integrity`, `-0.2` all clean |
| Uploader (item 7) | exits 1 without `--blob-base-url` (verified without a pipe masking the exit code); resume via up-front blob listing + `--force`; retry only on 429/503, honours `x-ms-retry-after-ms`, exponential backoff; final log reports real success/failure counts |
| CI image check (item 8 prereq) | `base_image_dir` now conditional on the directory existing |
| Minor cleanups (item 9) | In Progress panel added; `120 min goal` shown in the label; `esc()` applied to bank table and parent domain bars; README documents the correct test command |
| Dataset | 3,059 valid / 0 errors / 2,158 text-complete; bundle rebuilt with zero drift |

## Round-3 findings

### 1. The streak tests are a time bomb — they start failing on 2026-09-03 with no code change

`tests/test_srs.js:92-96` tries to control "today" by monkeypatching the export:

```js
const original = PSAT_ENGINE.localDateKey;
PSAT_ENGINE.localDateKey = () => referenceToday;
```

But `calculateStreak` (`srs.js:258`) calls the **internal closure** `localDateKey()`, not the exported property — so the patch is a no-op and the function always uses the real system clock. The month-boundary assertions (`tests/test_srs.js:100-101`) pass today only by coincidence: their fixture dates (2026-08-31, 2026-09-01) are in the *future* relative to the real date, which makes `diffDays` negative and slips past the `diffDays > 1` staleness check.

**Proven by execution:** with the system clock mocked to 2026-09-05, the identical assertion returns 0 instead of 2 and the suite fails. From 2026-09-03 onward, every CI run goes red with no code change — and whoever hits it will be debugging the wrong thing.

**Fix:** add an optional `todayKey` parameter — `calculateStreak(sessionsMap, todayKey)` — defaulting to `localDateKey()`; pass the reference date explicitly in the tests and delete the monkeypatch. Same pattern already used by `recordDailySession`'s `dateStr` parameter, so this makes the API consistent too.

### 2. Future-dated sessions extend streaks (same code path)

Because `diffDays > 1` is the only staleness check, a session entry dated after today (clock rolled back, restored backup, imported data) yields a negative diff and counts as an active streak. Treat `diffDays < 0` as broken (return 0) or clamp it — one line, worth adding alongside finding 1 with a test case.

### 3. Student analytics crowns a "Top Weakness" after one wrong answer — `index.html:1033-1037`

The weakness branch has no minimum-attempts gate: one incorrect answer puts that skill at 0% and makes it the Top Weakness. The parent portal already requires ≥3 attempts for the same metric (`parent.html:261`), so the two pages can disagree about the student's biggest gap. Relatedly, the In Progress panel's badge says "1-2 Attempts" but the branch only routes `acc >= 75` skills there — a skill at 0% on 1 attempt lands in Focus Areas, contradicting the label.

**Fix:** make attempt count the primary split: `data.t < 3` → In Progress (any accuracy, relabel badge "< 3 Attempts"); `data.t >= 3 && acc >= 75` → Mastered; `data.t >= 3 && acc < 75` → Focus Areas, and only those are Top Weakness candidates. This matches the parent portal exactly.

### 4. Minor / latent

- **`esc()` doesn't escape single quotes** yet is interpolated into a single-quoted inline handler: `onclick="jumpToQuestion('${esc(q.id)}')"` (`index.html` bank table). Safe today because IDs are hex, but it's the one spot where the escaping helper doesn't actually cover the context it's used in. Prefer attaching the handler with `addEventListener` and reading the ID from a `data-` attribute (the pattern the palette buttons already use via `btn.onclick = () => ...`).
- **Blob-only dry runs demand `--blob-base-url`.** The guard `if args.dry_run or args.cosmos_conn:` (`upload_to_azure.py:195`) makes *any* dry run take the Cosmos path, so testing just the blob upload without a base URL exits 1. Require the base URL only when a Cosmos upload is actually part of the run.
- **Uploader failure counts don't reach the exit code.** `upload_questions_to_cosmos` now returns `(succeeded, failed)` but the call sites discard it; a run with failures still exits 0, so scripts and CI can't detect partial failure. Aggregate and `sys.exit(1)` when `failed > 0`.

### 5. Carried forward: the git history purge (round-1 item 9a, round-2 item 8)

Still pending, as expected — 3,059 images tracked, `.git` at 267 MB. Its prerequisite (the conditional CI image check) landed in this round, so the purge is now **unblocked**. It rewrites history, so it stays gated on your explicit go-ahead.

## Suggested order for round 3

1. Fix the streak test injection (finding 1) — **before 2026-09-03**, when CI starts failing on its own.
2. Clamp negative day diffs (finding 2) — same file, same PR.
3. Align the analytics buckets between student and parent pages (finding 3).
4. The three minors (finding 4) — quick, low risk.
5. The git purge (finding 5) — last, with explicit confirmation, since it rewrites history.

---
---

# Re-review — round 4

**Reviewed:** 2026-08-23 · commit `e2c1fa7` vs `b8ba313`
**Verdict: all four round-3 items landed and verify clean. But three feature commits (`9e9b197`…`e2c1fa7`) added an entire exam engine, drill generator, custom-test builder, and feedback reporter — and that engine was never run against the real data schema. Five new defects follow from it, two of which make the flagship PSAT 8/9 exam mode ship-broken.** Every finding below was proven by executing the code against the committed dataset, not by inspection alone.

## Verification performed

| Check | Result |
| :--- | :--- |
| Python tests (9) · Node suites (3) | all pass |
| Round-3 item 1 & 2 (streak tests / future dates) | `calculateStreak(sessionsMap, todayKey)` param present; `diffDays < 0` returns 0; future-dated entries filtered — closed |
| Round-3 item 3 (analytics buckets) | attempt-count primary split with In Progress panel, matches parent portal — closed |
| Round-3 item 4 minors | bank table uses safe `onclick` closure; blob-only dry run decoupled from Cosmos; uploader aggregates failures into exit code — closed |
| Dataset schema re-check | `options` is an **array** of `{key, text}` on all 3,059 records; `question_type` exists on **zero** records (only `type`) |
| `generateStandardPSAT89Exam`, executed | module sizes **27 / 27 / 17 / 17 = 88 questions**, advertised as 98; zero grid-ins placed by the MCQ/SPR mixer |
| `generateCustomTest({questionType:'spr'})`, executed | **0 questions** returned |
| `renderExamMcqOptions` lookup `q.options['A']` | `undefined` → renders placeholder text |

## Round-4 findings

### 1. Exam mode renders "Choice (A)" placeholders instead of real option text — `index.html:1834`

```js
const optText = (q.options && q.options[letter]) ? q.options[letter] : `Choice (${letter})`;
```

`q.options` is an array indexed `0–3`; `q.options['A']` is always `undefined`. Every multiple-choice question in the exam runner displays four generic buttons with no answer text — for 40% of the bank (Math), the card image is the only place the choices exist at all, so text mode plus this bug makes the exam unanswerable. The practice view does this correctly one viewport away (`index.html:1113`). **Fix:** resolve the choice with `q.options.find(o => o.key === letter)`.

### 2. Phantom `question_type` field breaks the exam engine end-to-end

The dataset carries `type`; nothing carries `question_type`. Every consumer of the phantom field silently misbehaves:

| Location | Consequence |
| :--- | :--- |
| `srs.js:345-346` | Standard-exam MCQ/SPR mixer puts all 1,505 Math questions in the "MCQ" bucket and none in the "SPR" bucket → Math modules get 17 questions instead of 22 (**verified: 88-question exam sold as 98**) |
| `srs.js:602-604, :609-612` | Scoring divides by hardcoded `rwTotal=54 / mathTotal=44` and reports `/ 98` regardless of what was generated — with only 34 live Math questions, the Math scaled score caps at ~584 even at 100% correct |
| `index.html:1671-1675` | "Math Half-Test" builds two 17-question modules — **34 questions advertised as 44** |
| `index.html:1799`, `srs.js:558-561` | Grid-in input never renders in exam mode; free responses would be graded by letter-string comparison |
| `srs.js:505-506`, `parent.html:831-832` | Parent portal "Free-Response Only" filter matches **0 questions** (verified) and its matching counter lies for MCQ-only |

**Fix:** replace every `q.question_type` with `q.type` (six sites), stop hardcoding 54/44/98 in scoring — derive totals from the generated modules.

### 3. Parent portal gap-drill launcher crashes on first use — `parent.html:872, :914`

`currentGapCount` is read by `launchGapDrill()` and `copyShareableTestLink('gap')` but never declared or initialized — `setGapCount()` only assigns it *after* a preset button is clicked, while the HTML pre-paints "20 Qs" as selected via hardcoded classes. Clicking **Launch Gap Drill in Student App** on a fresh page load throws `ReferenceError: currentGapCount is not defined` and silently does nothing. **Fix:** `let currentGapCount = 20;` and call `setGapCount(20)` from `DOMContentLoaded`.

### 4. Exam timer leaks time, and expired modules stay editable — `index.html:1740-1752, :714-716`

Two independent integrity holes in a product whose selling point is strict timing:

1. **Background-tab time dilation.** The countdown decrements a counter once per `setInterval(…, 1000)` tick. Browsers clamp inactive-tab timers to ~1 tick/minute, so a student who switches tabs during a 32-minute module earns most of it back. Compute remaining time from a wall-clock deadline (`deadline - Date.now()`), never from tick counts.
2. **Expiry isn't enforced.** At 0:00 the code alerts, clears the interval, and lands on the module review screen — whose "**← Return to Questions**" button (`index.html:2006`) happily reopens the module with no timer running. A student can answer indefinitely after time expires. Auto-submit the module on expiry, or lock the return path once `examModuleTimerSeconds === 0`.

(The `alert('⚠️ 5 Minutes Remaining')` also blocks the event loop mid-question — swap for an inline banner while touching this code.)

### 5. "Save to Practice & SRS History" corrupts the analytics it feeds — `index.html:2177-2202`

`saving` iterates **all** module-report rows, not just answered ones, and writes `answered: true` for each — so skipped questions enter the progress map with `selectedAnswer: 'Unanswered'` (invented at `srs.js:579`: `userAnswer: userAns || 'Unanswered'`). Consequences, all mechanical:

- Accuracy stats count fabricated attempts; the bank explorer shows them as plain "Incorrect".
- `isFlagged` bookmarks on those questions are overwritten away.
- `recordDailySession` is called without the `timingReliable` argument (`index.html:2193`), so its clamp (`srs.js:234`: `max(1000, timeSpentMs)`) credits **≥1 second per question — ~1.6 phantom minutes per saved exam**, even if every item was skipped instantly.
- `timingReliable: true` is hardcoded even when `timeSpentMs` is 0, contradicting the round-2 convention the SRS relies on to distinguish "fast" from "unknown".

**Fix:** persist only rows with `answered === true`, preserve `isFlagged`, pass the real reliability flag, and store `null` time as unreliable rather than 0.

### 6. Minor / latent

- **Enter doesn't submit grid-ins in practice mode** (`index.html:189-197`) — the SPR input has no form wrapper or keydown handler; mouse-only. Keyboard users hit Submit with the tab key today.
- **Biased shuffle**: `[...pool].sort(() => Math.random() - 0.5)` (`index.html:1662, :1674`) skews permutation order; `_shuffle` already exists in `srs.js` — use it.
- **Silently ignored drill options**: `gap-focus-type` offers `srs_only` and `weak_only` (`parent.html:243-244`) but `launchGapDrill()` handles only `math_only`/`rw_only`; selecting either quietly produces a comprehensive drill.
- **Shareable gap links drop their parameters**: `copyShareableTestLink('gap')` emits `count`/`focus`, but `index.html`'s `mode=gap_drill` branch ignores both and hardcodes 20.
- **`migrate_to_cosmos.py:29`**: `getattr(e, 'headers', {})` still yields `None` when the exception carries no headers → `.get` raises inside the retry path. Use `(getattr(e, 'headers', None) or {}).get(...)`.
- **Exam zoom overflows vertically**: `applyExamZoom` CSS-scales an image inside an `overflow-x-auto` container (`index.html:641`); above 100% the bottom clips into the answer area.

## Suggested order for round 4

1. Finding 2 — replace `question_type` with `type` everywhere and de-hardcode exam totals/scoring. Biggest blast radius: wrong exam composition *and* wrong scores.
2. Finding 1 — same surface, one-line lookup fix; verify by launching a standard exam.
3. Finding 3 — declare `currentGapCount`; unblocks the parent-portal launcher.
4. Finding 4 — deadline-based timer + enforce expiry.
5. Finding 5 — gate the save loop on `answered`, preserve flags/reliability.
6. Finding 6 minors — batch in one PR.
7. Add Node tests that generate exams/drills from the *real* bundle (`data/questions_data.js`) and assert module sizes, SPR counts, and option-text resolution — the exact gap that let findings 1–2 ship.

---

## Addendum to Round 4 — 3 additional defects not in original review (appended 2026-08-23)

> These were found on a second pass over `e2c1fa7` and are distinct from findings 1–6 above. They are high-priority and will be fixed next, in the order listed.

### 7. Phantom `prompt` field breaks exam Text Mode and score report — `srs.js:573`, `index.html:1796`, `index.html:2149` *(not in original round-4 list)*

Dataset schema carries `question_text` on all 3,059 records; `prompt` exists on zero (`validator.py:15-98`, `extractor.py:235-241`). Exam engine stores `prompt: q.prompt` (`srs.js:573`) which is always `undefined`, and renders `q.prompt || 'View official question card above.'` (`index.html:1796`) so exam Text Mode is permanently empty even for text-complete questions. Score report fallback `index.html:2149` (`${esc(q.prompt)}`) is always empty; only `q.image_url` path masks it. Same class as finding 2 but separate field, not flagged above. Verified: `python3 -c "import json; print(any('prompt' in q for q in json.load(open('data/ela_questions.json'))+json.load(open('data/math_questions.json'))))"` → `False` while `q.question_text` present on 3,059. **Fix:** replace all three sites with `q.question_text` (carry `question_text` in `scoreStandardExam` review object, fallback to empty only when `text_complete===false`).

### 8. Blob `image_url` container divergence between provisioners — `migrate_to_cosmos.py:82` vs `upload_to_azure.py:39` *(not in original round-4 list)*

* `migrate_to_cosmos.py:82`: `f"{base_url}/data/images/{filename}"`
* `upload_to_azure.py:39`: `f"{base_url}/{blob_container_name}/{filename}"` where default `blob_container_name="question-cards"` (`upload_to_azure.py:187`, `SYSTEM_ARCHITECTURE_AND_PLAN.md` diagram: `question-cards/*.png`)
* Local fallback `index.html:1078` / `srs.js:585` correctly uses `data/` + `question_image` (`images/...` → `data/images/...`) for file-served mode.

Whichever script last provisioned Cosmos, the other URL 404s on the live site `https://psatprep4915.z13.web.core.windows.net` (static hosting expects one container path). Round-4 covered rewrite existence but not name mismatch. Verified by reading both files; `git log --oneline` shows both provisioners live. **Fix:** unify on parameterized container (default `question-cards`), update `migrate_to_cosmos.py:82` to use `blob_container_name`, assert in dry-run that every `image_url` contains the container name, and document single canonical URL format.

### 9. Exam last-question time never flushed + `localStorage` parse crash bricks app — `index.html:1772-1780`, `index.html:2011`, `index.html:873`, `parent.html:489` *(not in original round-4 list)*

Two independent reliability bugs:

1. **Last-question time loss.** `loadExamQuestion` `index.html:1772-1780` accumulates `examUserTimes[prevQ.id] += Date.now()-examQuestionShownAt` only on *next* navigation. `showModuleReviewScreen` (`:1953`), `submitCurrentExamModule` (`:2011`), and `finishExamAndShowReport` never flush the current `examQuestionShownAt`. The final question in each of 4 modules records `0ms`; `totalTimeSpentMs` undercounts by up to ~140 min per full exam, report shows wrong `1h 48m`, and `saveExamResultsToHistory` persists `0ms` as reliable timing.
2. **Corrupted storage white-screens app.** `index.html:873-875` / `parent.html:489-491` do `JSON.parse(localStorage.getItem('psat_progress')||'{}')` with no `try/catch`. A truncated/quota-exceeded value (progress ~300KB + `psat_srs` history can exceed 5MB `localStorage` limit; `saveProgress` `:919-922` does three `setItem` without quota guard) throws uncaught `SyntaxError` before first paint. Recovery requires manual `localStorage.clear()`.

Round-4 finding 4 covers timer dilation/expiry and finding 5 covers save-loop corruption, but neither covers missing flush nor storage crash. **Fix:** flush `examQuestionShownAt` into `examUserTimes` before review/submit/finish; wrap all `JSON.parse(localStorage.getItem(...))` in `try/catch` fallback `{}` and guard `setItem` with quota handling + version flag for `timingReliable` migration.

### Suggested order for addendum (fix next)

1. Finding 7 — `prompt` → `question_text` (one-line at 3 sites, exam Text Mode 100% broken).
2. Finding 8 — unify blob container to `question-cards` in both provisioners (production 404).
3. Finding 9 — flush last-question timing + harden `localStorage` parsing (data-loss / white-screen).

---

## Full ranked fix list (independent verification, 2026-08-23)

Verified independently against real dataset (`data/*.json` = 3,059 records; `question_type` = 0; `prompt` = 0; `options` array structure confirmed) and executed paths (`node` + `python` checks passed; timer tick-based; save-loop unguarded; `currentGapCount` undeclared; blob paths diverge; `JSON.parse` unprotected). No contradictions found.

| Rank | Finding | File refs | Blast radius |
|---|---|---|---|
| 1 | 2 — `question_type` phantom | `srs.js:345-346`, `:505-506`, `:558-561`, `:602-612`; `index.html:1662-1675`, `:1799`; `parent.html:831-832` | Exam broken (88 Q sold as 98; SPR=0; scoring/filter broken) |
| 2 | 1 — options array lookup (`q.options['A']`) | `index.html:1834` | Exam unanswerable (all MCQ buttons show placeholder) |
| 3 | 9 — exam time flush + `localStorage` crash | `index.html:1772-1780`, `:1953`, `:2011` + `:873-875`, `parent.html:489-491` | Data loss (last Q = 0ms) + white-screen (corrupt storage) |
| 4 | 5 — save loop corrupts analytics | `index.html:2177-2202` | Fabricates attempts; overwrites flags; phantom minutes |
| 5 | 4 — timer dilates / expiry unenforced | `index.html:1740-1752`, `:714-716` | Student gains time by switching tabs; answers after expiry |
| 6 | 3 — `currentGapCount` undeclared | `parent.html:872`, `:914` | Parent gap drill crashes on fresh load |
| 7 | 8 — blob container divergence | `migrate_to_cosmos.py:82` vs `upload_to_azure.py:39` | Production 404 (depends which provisioner ran) |
| 8 | 7 — phantom `prompt` | `srs.js:573`, `index.html:1796`, `:2149` | Exam Text Mode empty; score report blank |
| 9 | 6 — minors batch | `index.html:1662-1674`, `parent.html:243-244`, `srs.js`, `upload_to_azure.py` | Biased shuffle; ignored drill options; partial `innerHTML`; retry `None`; gap params lost |
