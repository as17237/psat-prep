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

---
---
# Re-review — round 5

**Reviewed:** 2026-08-24 · commits `cee88a6`..`0f2ee8e` (6 commits, ~4,800 lines) vs `1ba85fd`
**New since round 4's fixes:** on-demand Desmos calculator, official math reference sheet, auto-save of completed exams, persistent Exam History and full Score Reports with Question Review in both the student app and parent portal.

**Verdict:** the round-4 fix commit (`9d3f587`) landed and holds — but **one of its fixes was applied to the wrong parameter slot, and another was applied everywhere except one file**. Both are proven below by execution. Three further defects come from the new exam-history feature. All 12 tests still pass, and the dataset is unchanged (3,059 valid / 2,158 text-complete).

## Round-4 items: verified

| Round-4 finding | Status |
| :--- | :--- |
| 1 — `q.options['A']` array lookup | **Fixed.** `q.options.find(o => o.key === letter)` (`index.html:1929`) |
| 2 — phantom `question_type` | **Mostly fixed.** `q.type \|\| q.question_type` in `srs.js` and `index.html`; exam now generates a true 98 (27/27/22/22), verified by execution. **Missed in `parent.html` — see finding 3 below.** |
| 3 — `currentGapCount` undeclared | **Fixed.** `let currentGapCount = 20;` (`parent.html:524`) |
| 4 — timer dilation / expiry | **Fixed.** Wall-clock `examModuleDeadline` (`index.html:1826`), expiry forces module review |
| 5 — save loop corrupts analytics | **Partly fixed.** Now gated on `q.answered && q.userAnswer !== 'Unanswered'` (`index.html:2186`) — but the `recordDailySession` reliability argument was reintroduced in the wrong position. **See finding 2 below.** |
| 7 — phantom `prompt` | **Fixed.** `q.question_text \|\| q.prompt` at all three sites |
| 8 — blob container divergence | **Fixed.** `migrate_to_cosmos.py:82` now uses `blob_container_name` |
| 9 — time flush + storage crash | **Fixed.** `flushExamQuestionTime()` before review/submit/finish; `safeGetStorage`/`safeSetStorage` wrappers added — but the quota problem they were meant to solve is now *worse*. **See finding 1 below.** |
| Round-3 item 5 — git purge | **Still pending** (3,059 images tracked, `.git` 267 MB) |

## Top 5 round-5 findings

### 1. Exam history overruns the localStorage quota and silently destroys all progress

Round-4 finding 9 added `safeSetStorage` to stop corrupt storage white-screening the app. It catches the error — but the new exam-history feature now guarantees that error, and the catch makes it invisible.

`scoreStandardExam` embeds full question text, rationale, and image path for all 98 questions in every report. Measured: **one report is 209 KB**. `index.html:2213` caps history at 50 → **10.2 MB against a ~5 MB budget**; quota blows around the **24th exam**.

`safeSetStorage` (`index.html:910-917`) catches `QuotaExceededError`, logs to console, and returns normally — the caller believes the write succeeded. Because `saveProgress()` writes `psat_progress`, `psat_srs`, and `psat_sessions` through the same helper into the same budget, once exam history fills it **every subsequent answer, SRS update, and session silently fails to persist** while the UI keeps confirming success. The round-4 fix converted a loud crash into silent data loss.

**Fix:** store reports lean — question **IDs** plus `userAnswer`/`isCorrect`/`timeMs`, rehydrating text and rationale from `QUESTIONS_DATA` at render time (already loaded on both pages). ~95% smaller. Lower the cap to ~10, make `safeSetStorage` return a boolean, and surface a real error to the user on failure instead of swallowing it.

### 2. The round-4 reliability fix went into the wrong argument slot — exams corrupt the session log

Round-4 finding 5 flagged that `recordDailySession` was called without `timingReliable`. The argument was added — one position too early. `index.html:2203`:

```js
PSAT_ENGINE.recordDailySession(sessionsState, q.isCorrect, timeSpent, isReliable);
```

The signature is `(sessionsMap, isCorrect, timeSpentMs, dateStr, timingReliable)` — so `isReliable` lands in **`dateStr`**. Verified by execution: the session is filed under the literal key **`"true"`**, with `date: true` in the record.

So the exam's study minutes never reach the parent portal's "Past 7 Days" total (it reads date keys), and the exam day never counts as a practice day — a student whose only activity today was a full 134-minute exam sees their streak stay at **2 instead of advancing to 3** (confirmed by execution). A junk `"true"` key also accumulates. The practice path 900 lines earlier (`index.html:1280`) passes `null` for `dateStr` correctly, which is what makes this a pure slip.

**Fix:** `recordDailySession(sessionsState, q.isCorrect, timeSpent, null, isReliable)`. Then harden the function — reject a `dateStr` that isn't `YYYY-MM-DD` — and have `calculateStreak` ignore malformed keys so existing corrupted logs self-heal. Add a test asserting the exam path files under today's date.

### 3. Round-4's `question_type` fix missed the parent portal — the grid-in filter still returns zero

Round-4 finding 2 listed `parent.html:831-832` among the sites to fix. Every other site was corrected; this one was not. It now sits at `parent.html:1080-1081`, still reading the phantom field with **no `q.type` fallback**:

```js
if (qtypeVal === 'mcq' && q.question_type === 'free_response') return false;
if (qtypeVal === 'spr' && q.question_type !== 'free_response') return false;
```

`question_type` exists on **0 of 3,059** records. Verified by executing the exact predicate against the real bundle:

| Builder setting | Returns | Should return |
| :--- | ---: | ---: |
| Free-Response Only | **0** | 365 |
| MCQ Only | **3,059** | 2,694 |

So a parent building a grid-in drill gets an empty test, and an "MCQ Only" test silently includes all 365 grid-ins. **Fix:** `(q.type \|\| q.question_type)` at both lines, matching the pattern used everywhere else, and add a Node test that runs the parent builder's filters against the real bundle and asserts the counts.

### 4. A 134-minute exam is lost completely on refresh, crash, or accidental tab close

`activeExam`, `examUserAnswers`, `examUserTimes`, and `examModuleDeadline` live only in memory (`index.html:1680+`). Nothing persists in-progress exam state — `psat_active_exam` does not exist — and there is no `beforeunload` handler anywhere in the file. A student 130 minutes into a full-length exam who reloads loses every answer, with no warning beforehand and no way to resume.

Round 4 correctly made the timer deadline-based, so the mechanism for a trustworthy resume already exists — it just isn't saved.

**Fix:** persist a compact snapshot (exam ID + question IDs, answers, times, `currentModuleIndex`, absolute `examModuleDeadline`) on each answer and module transition; offer "Resume exam in progress" on load, honouring the stored wall-clock deadline so time keeps running as it would have. Add a `beforeunload` guard while an exam is active.

### 5. "Official PSAT 8/9 Score Report" is built on an invented linear mapping

`srs.js:631` labels `120 + (correct/total) × 600` as the *"Official PSAT 8/9 Scaled Score Mapping"*, and the UI presents the result under **"Official PSAT 8/9 Score Report"** (`index.html:808`, `parent.html:1721`). The 240–1440 range is correct, but College Board scaling is a nonlinear equating table, not a linear function of raw accuracy.

The exam undercuts the claim further: the real digital PSAT 8/9 is **multistage adaptive** (Module 2 difficulty is selected from Module 1 performance), while `generateStandardPSAT89Exam` draws Module 2 at random from the same shuffled pool (`srs.js:350-352`). A linear map over a non-adaptive random draw cannot reproduce official scaling.

This is the honesty problem rounds 1–2 removed from the parent portal, reintroduced with a stronger word attached — and it now carries more weight, because it sits on a full-length score report a parent will read as a predicted exam result.

**Fix:** drop "Official" from the code comment and both headings, label it "Estimated score (practice-based)", and state the method in one line beside the number. If closer fidelity is wanted, implement adaptive Module 2 selection — and still say plainly that the mapping is an approximation.

## Also worth noting

- **The UAT feedback form never delivers feedback.** `feedback.html` writes only to `localStorage['psat_uat_feedback']` (`:218`, `:273`, `:280`) — no network call — while `migrate_to_cosmos.py` provisions a `UATFeedback` container nothing writes to. Testers see a success state; their feedback stays in their own browser. It also uses raw `localStorage.setItem` with no quota guard, so finding 1 will make it throw mid-submit. Either wire it to an Azure Function endpoint (a browser must not hold a Cosmos key), or state on the page that it is local-only and add an export button.
- **`.cosmos_account_name` / `.storage_account_name` are committed** (`psat-cosmos-15958`, `psatprep4915`). Not credentials, but infrastructure identifiers that belong in a gitignored `.env` or CI variables.
- **`scoreStandardExam`'s `totalAttempted`** counts every key in the answers map (`srs.js:645`) rather than only this exam's questions — over-counts if the map is reused.
- **Git purge** (rounds 1–3) still pending, still unblocked.

## Suggested order for round 5

1. Finding 2 — one line, actively corrupting the session log on every exam.
2. Finding 3 — two lines, a parent-facing feature that currently returns nothing.
3. Finding 1 — the most damaging; silent loss of all practice progress.
4. Finding 4 — protects the 134-minute investment.
5. Finding 5 — wording plus an honest method line.

**Process note:** findings 2 and 3 are both round-4 fixes that were applied imprecisely — one to the wrong parameter, one to all sites but one. Both would have been caught by a test executing the real path against the real bundle. Round 4's own suggestion 7 ("add Node tests that generate exams/drills from the real bundle and assert counts") is still the highest-leverage item on this list; adding it would close this class of defect permanently.

---
---

# Re-review — round 6

**Reviewed:** 2026-08-24 · commits `6c132d4` (round-5 fixes) and `82d0231` (new feature) vs `0f2ee8e`
**New feature reviewed:** 10-minute Mini PSAT 8/9 simulation exam + "Load Sample Data" diagnostic generator.

**Verdict:** all five round-5 findings are properly fixed — the lean-storage fix in particular is excellent (201 KB → 9.8 KB per report, a 95% reduction). **The new feature, however, ships a data-destruction bug on the parent portal and reintroduces the round-1 fabricated-metrics problem through a new door.** All 12 tests pass; dataset unchanged.

## Round-5 items: all verified fixed

| Round-5 finding | Status |
| :--- | :--- |
| 1 — exam history quota cascade | **Fixed.** `toLeanReport` strips text/rationale/images; measured **9.8 KB** per report (was 201 KB). Cap lowered to 15 → ~147 KB total. `safeSetStorage` now returns a boolean and prunes old history to rescue critical writes. |
| 2 — `recordDailySession` argument slot | **Fixed.** Both call sites pass `null` for `dateStr` (`index.html:1349`, `:2297`). |
| 3 — parent portal `question_type` residual | **Fixed.** `const qType = q.type \|\| q.question_type \|\| 'multiple_choice'` (`parent.html:1139`); SPR filter now returns 365, MCQ 2,694. |
| 4 — no exam resume | **Fixed in behaviour.** `psat_active_exam_state` snapshot + restore prompt + `beforeunload` guard (`index.html:2440-2525`). **But see finding 5 below for how it stores state.** |
| 5 — "Official" score mapping | **Fixed.** No occurrences of "Official PSAT 8/9 Score/Scaled" remain in any page or in `srs.js`. |

## Round-6 findings

### 1. "Load Sample Data" silently destroys all real student data — parent portal, production UI

`loadSampleDiagnosticSession()` (`parent.html:1233`) ends with four **whole-key overwrites**:

```js
safeSetStorage('psat_progress',      sampleProgress);
safeSetStorage('psat_srs',           sampleSrs);
safeSetStorage('psat_sessions',      sampleSessions);
safeSetStorage('psat_exam_history',  [leanReport]);
location.reload();
```

These replace, not merge. A parent who clicks this on the browser where their child actually practises **instantly loses every attempt, every SRS schedule, the entire streak/session history, and all completed exams** — replaced by 24 synthetic attempts and one sample report. There is no backup, no undo, and `location.reload()` makes it final before anything can be reconsidered.

The confirmation text does not warn about any of this. It reads: *"Load realistic sample diagnostic session data? This will populate 24 practice attempts… to demonstrate the full parent analytics experience."* — "populate" implies addition, not replacement. And the button (`parent.html:45`, **"Load Sample Data"**) sits permanently in the parent-portal header between *Feedback* and *Export Audit Trail* — not behind a dev flag, not hidden, one click plus one misleading confirm from irreversible loss.

**Fix (in order):** back up all four keys to `psat_pre_sample_backup` before writing and offer a one-click "Restore my real data"; rewrite the confirm to state plainly that existing progress will be **erased and replaced**; refuse to run when real data is present unless the parent types a confirmation; and gate the button behind a URL flag (`?demo=1`) or a UAT build so it cannot be reached by accident in normal use.

### 2. Sample data is indistinguishable from real data once loaded — round-1 regression

Nothing marks the synthetic records as synthetic. `sampleProgress[q.id] = { answered: true, isCorrect, timeSpentMs, timingReliable: true, … }` is byte-identical in shape to a genuine attempt, and it flows through the same analytics pipeline. After the reload the parent portal shows a scaled score, a streak, mastery bars, and a weakness ranking — **all computed from fabricated attempts and presented exactly as real measurements.** The only trace is the words "(Sample Test)" inside one exam-history title.

This is the defect round 1 existed to remove — a parent dashboard showing numbers that are not measurements. It is now *harder* to detect than the original hardcoded HTML, because the numbers are rendered through the legitimate pipeline and look fully earned.

**Fix:** stamp every synthetic record (`isSample: true`) and every affected key with a `sampleDataLoaded` marker; render a persistent, dismissible banner across the parent portal and student app — *"Showing sample data — not real practice results"* — for as long as that marker is present; and expose a "Clear sample data" control that restores the backup from finding 1. `exportAuditTrail` should carry the flag too, so an exported audit can never be mistaken for genuine history.

### 3. An 8-question, 10-minute quiz produces a full 240–1440 "scaled score"

`generateMiniPSAT89Exam` (`srs.js:406`) builds 4 R&W + 4 Math questions, and its report is scored by the same `scoreStandardExam` used for the 98-question exam. Because the mapping is `120 + (correct / total) × 600` per section, **each single question is worth 150 composite points.** Verified by execution against the real bundle:

| Mini-exam result | Composite shown |
| :--- | ---: |
| 7 of 8 correct (the sample generator's own data) | **1290 / 1440** |
| 6 of 8 correct | **1140 / 1440** |

One question swings the reported score by 150 points, and this lands in exam history rendered by the same score-report UI as a full-length exam — a parent has no visual cue that this "PSAT 8/9 score" came from ten minutes of work.

This also contradicts the project's own established rule: `calculateScaledScore` refuses to report anything below `MIN_PER_SECTION = 15` attempts (`srs.js`), a gate added in round 2 for exactly this reason. `scoreStandardExam` has no such gate.

**Fix:** suppress the scaled score for any exam below a minimum per-section count — show raw "7 of 8 correct" plus per-skill feedback instead — or label mini-exam output unmistakably as a practice check with no score projection. Apply the same `MIN_PER_SECTION` rule both engines already agree on elsewhere.

### 4. The resume snapshot re-creates the storage-bloat bug round 5 just fixed

`persistActiveExamState()` (`index.html:2441`) stores `activeExam: activeExam` — **the entire exam object including all 98 full question records** with text, options, and rationales. Measured: **193 KB per snapshot**, written on every answer and every module transition (~100+ writes per exam). An ID-only snapshot carrying the same information is **1.1 KB — 175× smaller**.

This is the same payload-duplication that made exam history blow the quota; `toLeanReport` was written days ago for precisely this problem and is not used here. Worse, when this 193 KB write fails, `safeSetStorage`'s new recovery path **prunes the student's exam history down to 5 entries** to make room — so a bloated resume snapshot can silently delete completed exam reports.

**Fix:** persist `examId`, the module question **IDs**, answers, times, marked-for-review, indices, and the deadline; rehydrate the question objects from `QUESTIONS_DATA` on resume, exactly as `rehydrateLeanReport` already does.

### 5. `safeSetStorage`'s return value is ignored at every call site

Round 5's fix correctly made `safeSetStorage` return `true`/`false` so failures could surface. No caller checks it — all six sites (`index.html:1041-1043`, `:1053`, `:2309`, `:2454`) discard the result:

```js
safeSetStorage('psat_progress', progress);   // returns false on failure; nobody looks
```

So after the recovery-pruning path also fails, the student still gets a silent no-op with a UI that confirms success. The mechanism to fix this is now in place and simply isn't wired up.

**Fix:** have `saveProgress()` check the results and surface one visible, non-blocking warning — *"Your progress could not be saved (storage full)"* — with a link to export or clear old exams.

### 6. ~23% of synthetic "incorrect" records contradict themselves

The generator marks wrong answers with a hardcoded letter: `selectedAnswer: isCorrect ? q.correct_answer : 'B'` for R&W and `'C'` for Math (`parent.html:1252`, `:1261`). When the real key *is* that letter — measured at **~23% of sampled R&W items** — the record claims `isCorrect: false` while `selectedAnswer === correct_answer`. The question-review UI then shows *"Your answer: B | Correct: B"* flagged incorrect.

**Fix:** pick a wrong letter relative to the key, e.g. `['A','B','C','D'].find(l => l !== q.correct_answer)`, and for free-response items use a value that is genuinely not in `extractAcceptedForms(q.correct_answer)`.

## Suggested order for round 6

1. Finding 1 — backup, honest confirm text, and gate the button. Irreversible data loss, reachable in one click today.
2. Finding 2 — mark and banner sample data. Restores the round-1 guarantee.
3. Finding 4 — lean resume snapshot; also stops history from being pruned away.
4. Finding 3 — gate the mini-exam scaled score.
5. Finding 5 — wire up the return value that already exists.
6. Finding 6 — one-line fix to the synthetic wrong-answer picker.

**Process note:** findings 1, 2, and 3 are all the same root cause — a testing convenience was built directly on the production data path and the production score report, with no separation between demo state and real state. Whatever ships, the invariant worth holding is the one this project has been converging on for six rounds: **a number on the parent dashboard is either a real measurement or it is visibly labelled as not one.**

---
---

# Re-review — round 7

**Reviewed:** 2026-08-24 · commit `641e387` (round-6 fixes) vs `82d0231`

**Verdict:** five of six round-6 findings are fully fixed, and two of the fixes are excellent — the resume snapshot dropped **193 KB → 1.9 KB** (100×) and the scaled-score gate now works in both engines. **Two gaps remain, and both are instances of the failure modes this project keeps repeating:** the sample-data backup can still destroy real data (mode 7), and the demo banner was added to one of the two surfaces that need it (mode 2). All 12 tests pass; dataset unchanged.

## Round-6 items: verified

| Round-6 finding | Status |
| :--- | :--- |
| 1 — sample data destroys real data | **Partly fixed.** Backup to `psat_pre_sample_backup`, a restore button in the demo banner, and honest confirm text. **But the backup is unguarded — see finding 1 below.** |
| 2 — sample data indistinguishable from real | **Partly fixed.** `isSample: true` on every record, `psat_sample_data_active` flag, demo banner + restore button in `parent.html`, and `isSampleData` in the audit export. **Missing from the student app — see finding 2 below.** |
| 3 — mini exam yields a full scaled score | **Fixed.** `MIN_PER_SECTION = 15` now enforced in `scoreStandardExam` (`srs.js:683-685`). Verified: mini at 100% returns `totalScaled: null, isScaledReady: false`; full exam returns 1440. |
| 4 — resume snapshot bloat | **Fixed.** Stores `questionIds` and rehydrates from `QUESTIONS_DATA`. Measured **1.9 KB, down from 193 KB**. Legacy `activeExam` snapshots still restore. |
| 5 — `safeSetStorage` return ignored | **Fixed.** `saveProgress()` checks all three writes and calls `showStorageWarningBanner()` (`index.html:1041-1046`). |
| 6 — self-contradictory sample records | **Fixed.** Wrong answer is now chosen relative to the key: `['A','B','C','D'].find(l => l !== correct)`. |

## Round-7 findings

### 1. Clicking "Load Sample Data" twice permanently destroys the student's real data

`loadSampleDiagnosticSession()` (`parent.html:1268`) backs up unconditionally — there is no check for whether sample data is already loaded:

```js
const existingBackup = {
  progress:      safeGetStorage('psat_progress', {}),      // ← sample data on the 2nd call
  srsState:      safeGetStorage('psat_srs', {}),
  sessionsState: safeGetStorage('psat_sessions', {}),
  examHistory:   safeGetStorage('psat_exam_history', [])
};
safeSetStorage('psat_pre_sample_backup', existingBackup);   // ← overwrites the real backup
```

The `psat_sample_data_active` flag needed to prevent this is set on the very next line but never read here. Simulated against the exact sequence:

| Step | `psat_pre_sample_backup` holds |
| :--- | :--- |
| After 1st "Load Sample Data" | the student's **real** progress ✅ |
| After 2nd "Load Sample Data" | the **sample** progress ❌ |
| After "Restore my real data" | restores sample data; real work unrecoverable ❌ |

The demo banner sits at the top of the page with **both** buttons available while sample data is active, so a second click is an easy mistake — and the confirm text now explicitly promises *"allowing you to restore your real data at any time with one click"*, a guarantee that becomes false the moment it is clicked twice. A promise of recoverability that silently expires is worse than no promise.

**Fix:** guard the backup — only write it when `localStorage.getItem('psat_sample_data_active') !== 'true'`. If sample data is already active, either no-op with a message ("Sample data is already loaded") or regenerate the samples **without** touching the backup. Hide or disable the "Load Sample Data" button while the demo banner is showing. Add a test that runs load → load → restore and asserts the real data comes back.

### 2. The demo banner never reaches the student app

`psat_sample_data_active`, the `isSample` markers, the banner, and the restore button exist only in `parent.html`. `index.html` contains no reference to any of them (verified by grep).

So after sample data is loaded, the student app shows 24 fabricated attempts as genuine practice history: the header accuracy figure, the Strengths / Focus Areas / In Progress panels, the domain and difficulty charts, the SRS due queue, and the question palette all render synthetic records as real measurements with nothing to indicate otherwise. Round-6 finding 2 asked for the banner "across the parent portal **and student app**"; it landed on one.

The data needed is already there — every synthetic record carries `isSample: true` and the flag is in `localStorage`, so `index.html` can detect it in one line.

**Fix:** read `psat_sample_data_active` on load in `index.html` and render the same persistent banner with the same restore control. Better: extract the banner into a shared helper in `srs.js` (or a tiny `demo-mode.js`) that both pages call, so this cannot diverge again — the same remedy prescribed for `MIN_PER_SECTION`, which is why finding 3 of round 6 stayed fixed this time.

### 3. Minor

- **`provisionalScaled` is a gated score left in the payload.** `srs.js:711` returns the ungated composite alongside `totalScaled: null`. Nothing displays it today (verified), but it is precisely the shape of the round-2 defect where the hero was gated and the section badges were not — an ungated number sitting one `.provisionalScaled` away from a template. Remove it, or rename to `_ungatedInternalOnly` so any use is obviously wrong.
- **Resume can silently shorten an exam.** Rehydration maps `questionIds` through `qMap` and ends with `.filter(Boolean)` (`index.html:~2545`). If any ID is missing from the current bundle, the module comes back shorter, and `scoreStandardExam` divides by `mod.questions.length` — scoring a 27-question module out of however many survived, with no warning. Compare the rehydrated count against `questionsCount` and refuse to resume (or warn) on mismatch.
- **Git purge** (rounds 1–3) still pending: 3,059 images tracked, `.git` 267 MB.

## Suggested order for round 7

1. Finding 1 — guard the backup and disable the button while demo mode is active. Still irreversible data loss, now two clicks away.
2. Finding 2 — shared banner helper used by both pages.
3. Finding 3 minors — batch together.

**Process note.** Both findings are textbook instances of modes already documented in `CLAUDE.md`: *destructive action without a guard* (mode 7) and *a rule applied in one place but not its twin* (mode 2). The round-6 fixes were correct in substance — what slipped was coverage, not comprehension. The checklist question that would have caught both is the same one: **"did I grep for every other site of this rule and fix them all?"**

---
---

# Re-review — round 8

**Reviewed:** 2026-08-24 · commit `d66b2a0` (round-7 fixes) vs `641e387`

**Verdict: all four round-7 items are fixed, and the approach taken was the right one — the demo-mode logic was extracted into `srs.js` as a testable, storage-injectable module rather than duplicated across the two pages.** All 12 tests pass, including a new "Demo Backup Guard" suite. **One finding remains: a fallback branch in `index.html` deletes the backup instead of restoring from it** — the same two-surfaces divergence pattern, this time in error-handling code.

## Round-7 items: verified by execution

| Round-7 finding | Status |
| :--- | :--- |
| 1 — double-load destroys the backup | **Fixed, with defence in depth.** `backupRealData()` (`srs.js:849`) refuses to write when demo mode is active, and `loadSampleDiagnosticSession()` (`parent.html:1278`) refuses outright with a message pointing at the restore button. |
| 2 — banner missing from student app | **Fixed correctly.** `isDemoModeActive()`/`backupRealData()`/`restoreRealData()` extracted into `srs.js` with injectable storage; both pages call the shared helpers. Student app now has its own banner (`index.html:105-116`) with a restore control. |
| 3a — `provisionalScaled` | **Removed.** Zero occurrences repo-wide. |
| 3b — resume can silently shorten an exam | **Fixed, and it fails loudly.** Rehydration compares against `expectedCount`, and on mismatch warns the user, clears the state, and returns to the lobby rather than scoring a short exam (`index.html:2595-2622`). |

The decisive test — the sequence that previously destroyed real data — now passes:

```
load #1: backupRealData -> true  | backup holds: REAL STUDENT WORK
load #2: backupRealData -> false | backup holds: REAL STUDENT WORK
load #3: backupRealData -> false | backup holds: REAL STUDENT WORK
after restore -> progress: REAL STUDENT WORK ✅   history: REAL EXAM ✅
demo flag cleared: true   backup key cleared: true
restore with no backup at all: returns true, no crash
```

## Round-8 finding

### 1. `index.html`'s restore fallback deletes the backup without restoring it

Both pages guard the shared helper the same way, but the fallback branches differ. `parent.html` (`:1386-1412`) correctly reads `psat_pre_sample_backup` and writes each key back before clearing. `index.html` (`:1079-1086`) does not:

```js
function restoreRealStudentData() {
  if (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.restoreRealData) {
    PSAT_ENGINE.restoreRealData(localStorage, safeGetStorage, safeSetStorage);
  } else {
    localStorage.removeItem('psat_sample_data_active');
    localStorage.removeItem('psat_pre_sample_backup');   // ← deletes the only copy
  }
  location.reload();
}
```

If `PSAT_ENGINE` is unavailable, this removes the backup **without writing it back** — the sample data stays in `psat_progress`, the demo flag is cleared so nothing indicates it any more, and the student's real work is unrecoverable. A student clicking "Restore My Real Data" gets the exact opposite of what the button promises.

The trigger is unlikely (it needs `srs.js` to fail to load, which breaks much of the app anyway), so this is low-probability — but the severity is total, permanent data loss, and it sits in the one code path whose entire purpose is preventing that.

**Fix — do not mirror `parent.html`'s fallback.** Deleting a backup can never be the safe response to "the restore code is missing." Make the fallback a no-op that reports the problem:

```js
} else {
  alert('Restore is unavailable because the app engine did not load. Your backup is intact — please reload the page and try again.');
  return;   // change nothing, delete nothing
}
```

Then apply the same reasoning to `parent.html`: its fallback duplicates ~20 lines of `restoreRealData` and will drift from it. Replace it with the same no-op-and-report.

**Rule worth adding to `CLAUDE.md` mode 7:** *a fallback path may never be more destructive than the primary path.* When the safe operation is unavailable, do nothing and say so — never "clean up".

## Also worth noting

- **`validate.md` is untracked** (`git status`). It reports a full extraction audit claiming 3,059/3,059 validated by a deterministic layer plus an LLM map-reduce pass. I have not verified its claims — it was not part of this review. Either commit it or remove it; an untracked report making 100% claims is the kind of artifact that gets cited later as if it were reviewed.
- **Git purge** (rounds 1–3) still pending: 3,059 images tracked, `.git` 267 MB.

## Assessment

This is the cleanest round so far. Round 7 asked for a shared helper rather than a copied banner, and that is what was built — `isDemoModeActive` and friends now live in `srs.js` with injectable storage, which is both the correct architecture and directly unit-testable; the new "Demo Backup Guard" test proves the guard rather than asserting it. The rehydration fix chose to fail loudly instead of silently, which is the right instinct and the opposite of the swallowed-failure pattern from rounds 1, 5, and 6.

The one remaining finding is a fallback branch — the least-travelled code in the file. That is a meaningful change in where the defects are landing.

---
---

# Re-review — round 9

**Reviewed:** 2026-08-24 · commit `9741e00` (round-8 fix) vs `d66b2a0`

**Verdict: the round-8 fix is correct on both pages and the demo-mode subsystem is now sound.** But `validate.md` — committed in this same commit — reports a defect neither my reviews nor the project's validator caught, and **I independently confirmed it: 6 answer keys are wrong, and students are being graded against them.** That is now the most important open item in the project.

## Round-8 item: verified fixed

Both `restoreRealStudentData()` implementations now reload only on success and fall back to a non-destructive message:

```js
if (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.restoreRealData) {
  PSAT_ENGINE.restoreRealData(localStorage, safeGetStorage, safeSetStorage);
  location.reload();
} else {
  alert('Restore is unavailable because the app engine did not load. Your backup is intact — please reload the page and try again.');
  return;
}
```

`parent.html`'s duplicated 20-line fallback is gone, so the two pages can no longer drift. Swept the repo for the pattern: the only remaining `removeItem` calls are `clearActiveExamState()` (legitimate) and the internal helper inside `restoreRealData`. All 12 tests pass. End-to-end demo flow re-run: repeat "load sample" clicks leave the backup intact, and restore returns the real progress and exam history with both flags cleared.

## Round-9 finding

### 1. Six answer keys are wrong — students are graded against them *(confirmed independently)*

`validate.md` reports 5 SPR keys truncated at the decimal point. **I verified this against the source PDFs and the claim is accurate.**

`extractor.py:183`'s rationale fallback `The\s+correct\s+answer\s+is\s+([^.\n]+)` stops at the first period. These 5 questions have **no explicit `Correct Answer:` line** in the PDF text layer, so the fallback fired and cut the decimal off:

| ID | Stored key | Rationale in the PDF actually says | Verified |
| :--- | :--- | :--- | :--- |
| `7a026c5b` | `1` | `1.3.` | ✓ no explicit key line |
| `a602f738` | `2` | `2.6.` | ✓ no explicit key line |
| `d9281ab5` | `1` | `1.5.` | ✓ no explicit key line |
| `e83a38d3` | `1` | `1.2.` | ✓ no explicit key line |
| `ebe77ad7` | `4` | `4.44.` | ✓ no explicit key line |

A student entering the correct `1.3` is marked **wrong**; a student entering `1` is marked **right**. All five are Math, Hard, SPR.

An independent sentence-aware scan of all 365 SPR records — written without reusing the extractor's regex — returns **exactly these 5, no others**. The count is confirmed.

**A sixth key is wrong from a different cause.** `2c14fa19` asks for 20,300 mph in yards/hour given 1 mi = 1,760 yd. The arithmetic is 20,300 × 1,760 = **35,728,000**; the PDF's own key line reads `35728`, and the extractor faithfully stored that. Confirmed: the explicit key line really does say `35728`. Extraction is correct; the source is wrong. Either way the student is graded against a value off by a factor of 1,000.

**Fix.**
1. Correct the regex to capture to the sentence end: `The\s+correct\s+answer\s+is\s+(.+?)\.(?:\s|$)` — this prevents recurrence on any future bank.
2. **Do not re-run full extraction** to apply it — that regenerates 325 MB of images for a text-only change. Patch the five keys in `data/*.json` with a small script, add `2c14fa19` as an explicit source-override (with a UI caveat like the existing `rationale_letter_mismatch` treatment), then `python3 rebuild_bundle.py`.
3. Add a validator rule: for any SPR record whose rationale contains `The correct answer is <number>`, assert the stored key equals that number exactly. That converts this class into a permanent check.

**Why every existing check missed it — including mine.** `validator.py` only tests presence and format. A re-extraction diff reuses the same regex, comparing the implementation to itself. And my own round-1 audit tested `correct_answer not in rationale` — a **substring** test: `"1"` is a substring of `"1.3"`, so all five passed silently. That is mode 4 in `CLAUDE.md` — *a test that cannot fail* — committed in the review layer rather than the code. My round-1 statement that "extraction is correct and complete" was wrong on these six records, and I'm correcting it here.

## Housekeeping

- **`validate.md` was committed, then deleted from the working tree and moved to `agent-review/` (untracked).** Right now the report is in git history but not on disk, and an untracked copy exists outside version control. Pick one location and commit it — its BUG-1 finding is the most valuable thing produced this round and should not live in an untracked folder.
- Its other claims that I spot-checked hold up: the two `rationale_letter_mismatch` records match what I found in round 1, and the 900-placeholder / 72-multi-form figures match my own counts exactly.
- **Git purge** (rounds 1–3) still pending: 3,059 images tracked, `.git` 267 MB.

## Assessment

The demo-mode work is finished and the code-level defect rate has dropped sharply — round 8's finding was in a fallback branch, and round 9 found nothing new in the application code at all.

The open item is now a **data** defect, not a code one, and it is the most consequential kind this project can have: a prep app that marks a correct answer wrong. It also demonstrates the value of the validation pass — six rounds of code review did not find it, because every check involved, mine included, was structural rather than semantic.

---

# Re-review — round 10

Reviewed commits `0ce0c53` (Cosmos DB cloud sync across student app + parent portal) and `ea5c2ee` (immutable longitudinal exam tracking). All findings below were produced by executing the shipped code.

**Scope: this app serves one student.** Findings are assessed against that, not against a multi-tenant deployment. Multi-user concerns raised in the first pass of this round are withdrawn — see the note under finding 1.

## Status of round 9

**Not fixed.** The six wrong answer keys are still in the dataset:

```
7a026c5b -> '1'      (should be 1.3)
a602f738 -> '2'      (should be 2.6)
d9281ab5 -> '1'      (should be 1.5)
e83a38d3 -> '1'      (should be 1.2)
ebe77ad7 -> '4'      (should be 4.44)
2c14fa19 -> '35728'  (source defect; true value 35728000)
```

`extractor.py:183` still carries the truncating regex. This remains the highest-priority item in the repository: the student is graded wrong on real questions today, and no cloud feature changes that.

## What is right in this round

- The new cloud-sync test **can fail.** I broke the `mergedHistoryCount` assertion on purpose and got `AssertionError` with `EXIT=1` — the async IIFE surfaces as an unhandled rejection and Node 24 exits non-zero. This is the first new test in ten rounds I did not have to reject under mode 4.
- `pushToCloud`/`pullFromCloud` both short-circuit on `isDemoModeActive`. Sample data cannot reach the cloud — the mode-7 rule was correctly applied to a brand-new surface.
- No secrets are committed. `COSMOS_CONNECTION_STRING` comes from the environment, there is no `local.settings.json` in the tree, and no account key appears in any tracked file.

## Finding 1 — Two devices, one student: the newest work is destroyed, permanently

This is the top finding of the round. It is not a multi-user problem — it happens with one student and two devices, which is the setup the feature exists to serve.

`pullFromCloud` merges local over cloud unconditionally, with no timestamp comparison:

```js
var mergedProg = Object.assign({}, cloud.progress || {}, localProg);
var mergedSess = Object.assign({}, cloud.sessionsState || {}, localSess);
```

`sessionsState` is keyed by **date**, so two study sittings on the same day from two devices collide on one key and one replaces the other rather than combining. And because `index.html` both pulls (line 3054) and pushes (line 1097), the loss round-trips back into the cloud and becomes permanent.

Executed — tablet in the morning, laptop at night, same date:

```
cloud after tablet : {"2026-08-25":{"count":12,"correct":10}}
laptop after pull  : {"2026-08-25":{"count":5,"correct":4}}   <- expected count:17 correct:14
cloud after laptop : {"2026-08-25":{"count":5,"correct":4}}   <- morning work now gone from the cloud
```

Twelve questions of real work erased from both devices and the cloud. The same rule applies to `progress` for any question answered on both devices, and to `srsState` — the SM-2 scheduling state silently reverts to whichever device happened to sync last, so review intervals regress.

The shipped test only covers an **empty** parent store, where local-wins is indistinguishable from correct. The conflict case — the only case where the merge rule matters — is untested.

**Fix.** Make `sessionsState` additive per day key rather than last-write-wins. For `progress` and `srsState`, compare a per-record timestamp and keep the newer. Add a test for the same-day two-device case and watch it fail before fixing it.

### Withdrawn: multi-tenant concerns

My first pass flagged that every client writes to a single `default_student` record and that families would overwrite each other. With one student that is not a defect — it is the design, and the fixed record id is a reasonable simplification. I withdraw that half of the finding.

What remains, at much lower severity: the endpoint is `authLevel: 'anonymous'` on the public internet, so anyone who learns the hostname can read the student's practice record or `POST` garbage over it. With one obscure URL and a child's practice scores the exposure is small, and it is your call whether it is worth anything. If you want it closed cheaply, validate an `x-sync-key` header against an app-setting secret — about ten lines in each function, no change to the data model. The write side is the part I would weigh: an unauthenticated `POST` combined with the merge rule above means a stray request can corrupt the record with no way to tell it happened.

Note `api/src/functions/feedback.js` is the same shape and stores `name` and `email`.

## Finding 2 — A server error is reported to the parent as "everything is synchronized" (mode 1, mode 5)

When Cosmos is unreachable, `sync.js` returns HTTP 500 with `{error: "..."}`. That body has no `success` field, so `pullFromCloud` falls through to its trailing `return { success: true, updated: false }`. Executed:

```
server 500 -> pullFromCloud returns {"success":true,"updated":false}
parent.html branch taken: ELSE -> alert("Cosmos DB is up to date — all attempts and reports are currently synchronized.")
```

A parent is told, in plain words, that everything is synced at the exact moment the sync failed. This is mode 1 and mode 5 in one line: a failure swallowed and rendered as a positive measurement.

Two more instances of the same class in this commit:

- `index.html` ships a static badge reading **"Cosmos DB Active"** in the markup, before any request is made. It is not a measurement of anything.
- `feedback.html` prints `"✓ Feedback entry logged & synced to Cosmos DB successfully!"` **synchronously**, before the `fetch` resolves; the failure path is a bare `.catch(err => console.warn(...))`.

**Fix.** `pullFromCloud` must return `{success:false}` when the response carries an `error` field or a non-2xx status; every call site must distinguish "up to date" from "could not reach the server" and say which. Start the badge in an unknown state and let a real response move it.

## Finding 3 — Cloud pull re-creates the storage bloat rounds 5–7 removed (mode 6)

`pullFromCloud` writes four keys with `store.setItem` directly. It does not use `safeSetStorage`, so there is no quota guard and no return flag to check — the exact mechanism rounds 5 and 6 existed to install. The merged history is also unbounded: local caps at 15, the cloud master doc caps at 30, but the GET handler merges every immutable `exam_session` doc on top with no limit. Executed with a year of testing (120 exams):

```
merged history entries written to localStorage: 120   (local cap is 15)
psat_exam_history size: 533.7 KB                       (localStorage quota ~5120 KB total)
```

533 KB in one key, written through an unguarded `setItem`, inside a promise chain whose `.catch` converts `QuotaExceededError` into a silent `{success:false}` that no call site inspects. One student accumulates this just as fast as many — it is driven by exams taken over time, not by user count.

**Fix.** Route every write through `safeSetStorage` and check the flag; cap the merged history at the same 15 the local path uses.

## Finding 4 — "Immutable" is `upsert`, and sync fires on every answered question

The commit message and code comment call the per-exam records immutable, but the handler uses `upsert`, which overwrites:

```js
for (const exam of body.examHistory) { ... await c.items.upsert(examDoc); }
```

Nothing enforces immutability — a POST carrying an altered payload for an existing `examId` replaces the historical record, which defeats the stated point of longitudinal tracking. Either enforce it (`items.create`, ignore the conflict) or stop calling it immutable. Mode 1 applies to labels as much as to numbers.

The efficiency half is minor at one student and I am not asking for it: `saveProgress()` → `triggerCloudSync()` means every answered question POSTs the full payload and re-upserts every exam document sequentially. At one student the RU cost is negligible and throttling is unlikely. Worth knowing only because a 429 would arrive as the silent failure in finding 2.

## Finding 5 — 8,133 dependency files committed to a repo already at 267 MB

`0ce0c53` added `api/node_modules` to version control: **8,133 files, 266,694 insertions**. `.gitignore` has no `node_modules/` entry. There is also an untracked 9 MB `api.zip` deployment artifact in the project root.

The git-purge item has been open since round 1 (3,059 tracked images); this makes it materially worse and is trivially avoidable.

**Fix.** Add `node_modules/` and `*.zip` to `.gitignore`, `git rm -r --cached api/node_modules`, and commit. Fold the rest into the history rewrite when it happens.

## Housekeeping still open

- `validate.md` is committed in `9741e00` but deleted from the working tree, with an untracked copy in `agent-review/`. Its BUG-1 finding is the most valuable output of round 8 and should live in one canonical, tracked location.
- Git purge of 3,059 images + `api/node_modules`. Needs explicit sign-off; rewrites history.
- `COSMOS_CONNECTION_STRING` is a connection string. Round 1 flagged the same pattern for the storage account and recommended `DefaultAzureCredential`; the rule was not applied to its twin here (mode 2).

---

# Re-review — round 11

Reviewed commit `ba3a022`. Scope remains **one student**.

## Fixed and verified

**Round 9 — the six answer keys. Done, and the regression is now guarded.**

```
OK  7a026c5b -> '1.3'    OK  a602f738 -> '2.6'    OK  d9281ab5 -> '1.5'
OK  e83a38d3 -> '1.2'    OK  ebe77ad7 -> '4.44'   OK  2c14fa19 -> '35728000'
```

All six read back correctly from `data/questions_data.js` (3,059 records), `python3 rebuild_bundle.py` produces **no drift**, and full-dataset validation still reports `3059 0 2158`. The regex at `extractor.py:183` now reads `(.+?)\.(?:\s|$)`, and extraction was correctly *not* re-run.

The new validator rule was tested by reintroducing the defect. It fires on exactly the failure it exists to catch and does not false-positive on the fixed record:

```
good key 1.3 -> ([], [])
bad  key 1   -> (["[7a026c5b] Free-response key '1' does not match sentence rationale component '1.3'"], [])
```

**Round 10 finding 3 — storage. Done.** Same 120-exam scenario as last round:

```
120 cloud exams -> merged entries: 15
psat_exam_history size: 65.8 KB   (was 533.7 KB)
quota failure  -> {"success":false,"error":"Storage quota exceeded while writing merged data","quotaExceeded":true}
```

All four writes go through the injected setter, all four flags are checked, and `safeSetStorage` is passed in the correct 4th positional slot at both call sites (`index.html:3064`, `parent.html:610`) — the argument-position rule from mode 6 was followed.

**Round 10 finding 2 — false success. Done at every site.** `pullFromCloud`/`pushToCloud` now return `{success:false}` on non-2xx or on a body carrying `error`. `parent.html` distinguishes failure and says so; the student badge starts at "Connecting…" rather than asserting "Active"; `feedback.html` waits for the response before claiming a sync.

**Round 10 findings 4 and 5 — done.** `items.create` with a 409 ignore makes "immutable" an accurate label. `api/node_modules` is untracked (`git ls-files` → 0) and `.gitignore` now covers `node_modules/`, `api/node_modules/`, `*.zip`.

## Finding 1 — The merge helpers were written against a schema that does not exist (mode 3), and the test was written against the same imagined schema (mode 4)

`mergeProgress` is correct — `progress` records really do carry `timestamp` (`index.html:1430`), so newest-wins works.

The other two read and write fields that appear on **zero** records.

The real session record, from `recordDailySession` (`srs.js:227`), executed:

```
{"date":"2026-08-25","questionsAnswered":2,"correct":1,"totalTimeMs":50000}
```

`mergeSessionsState` reads `totalAnswered || count` and writes `totalAnswered`, `totalCorrect`, `totalTimeSpentMs`. Only `correct` overlaps. Executed on the exact two-device case this fix was written for:

```
tablet : {"date":"2026-08-25","questionsAnswered":12,"correct":10,"totalTimeMs":400000}
laptop : {"date":"2026-08-25","questionsAnswered":5,"correct":4,"totalTimeMs":150000}
merged : {"date":"2026-08-25","totalAnswered":0,"totalCorrect":14,"totalTimeSpentMs":0,"streakCount":0,"lastAttemptTime":0}
expected: questionsAnswered:17 correct:14 totalTimeMs:550000
streak sees: 0
```

**This is worse than the bug it replaces.** Before, one device's counts survived; now both are destroyed — `questionsAnswered` and `totalTimeMs` are gone from the record entirely, and `calculateStreak` returns **0** for a day the student actually studied. The one field that survives is written under a name nothing reads.

The real SRS card, from `scheduleNext` (`srs.js:156`), carries `lastReviewedAt` and `dueAt`. `mergeSrsState` looks for `lastReviewedDate`, `dueDate`, `timestamp` — all three missing, so both sides evaluate to 0 and `lTime >= cTime` makes local win every time. Executed with real cards:

```
cloud card (NEWER, lastReviewedAt 1900000000000) reps=2 interval=3
local card (older,  lastReviewedAt 1000000000000) reps=1 interval=1
merged  -> lastReviewedAt 1000000000000 reps=1 interval=1
fields the merge actually looks for: lastReviewedDate=MISSING dueDate=MISSING timestamp=MISSING
```

The SRS half of the fix is a no-op. Review scheduling still reverts to whichever device synced last, exactly as reported in round 10.

**Why the test did not catch this.** The new test builds its fixtures from the *same invented schema the implementation invented*:

```js
'2026-08-25': { totalAnswered: 12, totalCorrect: 10, totalTimeSpentMs: 120000, lastAttemptTime: 1000 }
'q1': { repetitions: 1, easeFactor: 2.3, lastReviewedDate: 1000 }
```

It therefore compares the implementation to itself and passes green while the feature is broken against every real record. This is mode 4 in its purest form — the same shape as the round-2 free-response test that split keys exactly as the grader did. The `CLAUDE.md` mode-3 field-existence check exists to prevent precisely this and was not run.

**Fix.**
- `mergeSessionsState`: read and write `questionsAnswered`, `correct`, `totalTimeMs`, `date`. Drop `streakCount` and `lastAttemptTime` — they are not part of the record. Streak is derived by `calculateStreak`, not stored.
- `mergeSrsState`: compare `lastReviewedAt`. Do not include `dueAt` in a recency comparison — a card scheduled further out is not a more recent review.
- Rebuild both test fixtures by calling `recordDailySession` and `scheduleNext` to produce them, rather than hand-writing field names. Watch the test fail against the current implementation before fixing it.

## Minor

- On a partial quota failure the merge writes some keys and not others, then reports failure — leaving `localStorage` in a half-merged state with no rollback. Low likelihood at 65 KB, but the four writes are not atomic.
- A quota failure surfaces to the parent as `"Sync Warning: Storage quota exceeded… Please check your internet connection."` The advice does not match the error.
- When the cloud has no record yet, the parent is told `"Cosmos DB is up to date — all attempts and reports are currently synchronized."` Reachable-but-empty and genuinely-in-sync read identically; `res.empty` is returned but unused.

## Housekeeping still open

- `validate.md` — still committed in `9741e00`, still deleted from the working tree, untracked copy in `agent-review/`.
- Git purge of 3,059 tracked images. `api/node_modules` is out of the index but remains in history until a rewrite. Needs explicit sign-off.
- `COSMOS_CONNECTION_STRING` is still a connection string; round 1's `DefaultAzureCredential` recommendation was never applied to its twin (mode 2).
- The sync endpoint remains `authLevel: 'anonymous'`. Owner's call, as noted in round 10.

---

# Re-review — round 12

Reviewed commit `d29ddab`. Scope remains **one student**.

## Fixed and verified

**Session merge — correct.** `mergeSessionsState` now reads and writes the real `recordDailySession` fields, and tolerates the previous round's invented names on the read side. Executed with sessions built by the engine itself:

```
tablet: {"date":"2026-08-25","questionsAnswered":12,"correct":10,"totalTimeMs":120000}
laptop: {"date":"2026-08-25","questionsAnswered":5,"correct":4,"totalTimeMs":50000}
merged: {"date":"2026-08-25","questionsAnswered":17,"correct":14,"totalTimeMs":170000}
calculateStreak(merged) = 1     (was 0 last round)
```

The invented `streakCount`/`lastAttemptTime` fields are gone. The coder's reported numbers match mine exactly.

**Test fixtures — rebuilt from the real engine.** `tests/test_srs.js` now calls `recordDailySession` and `scheduleNext` to construct its inputs instead of hand-writing field names, and asserts on `questionsAnswered`, `correct`, `totalTimeMs`, and `calculateStreak`. This closes the mode-4 defect from round 11: the test can no longer pass against a record shape that does not exist.

**All three minor items — done.** Rollback restores the raw pre-merge snapshots on a partial write failure; a quota error now says storage is full rather than advising a network check; `res.empty` is consumed and reports "Cosmos DB Connected … no attempts submitted yet" distinctly from a genuine in-sync state.

## Finding 1 — `dueAt` is still in the SRS recency comparison, and it discards failed reviews

Round 11 asked for two things in `mergeSrsState`: use the real field names, and **do not include `dueAt` in the recency comparison**. The first clause landed; the second did not.

```js
var cTime = Math.max(c.lastReviewedAt || 0, c.dueAt || 0, c.timestamp || 0);
```

`dueAt` is always `lastReviewedAt + intervalDays × 86400000`, so it dominates the `Math.max` in every case — the comparison is not "which card was reviewed more recently" but "which card is scheduled furthest into the future." Those diverge precisely when the student **fails** a card, because failure resets the ladder to a 1-day interval.

Executed with cards produced by `scheduleNext`. Monday on the tablet the student answers correctly (interval 7); Tuesday on the laptop they answer the same card wrong (ladder resets):

```
tablet  Mon (correct, OLDER): lastReviewedAt=1900000000000 dueAt=1900604800000 reps=3 interval=7 lastGrade=5
laptop  Tue (WRONG,  NEWER): lastReviewedAt=1900086400000 dueAt=1900172800000 reps=0 interval=1 lastGrade=1

merged -> lastReviewedAt=1900000000000 reps=3 interval=7 lastGrade=5
winner is the OLDER tablet card  <-- the failed review was DISCARDED
```

The student got the question wrong, and after sync the engine believes they got it right a day earlier and schedules it a week out. The card they most need to see is the one the merge throws away. This is the SM-2 reversion reported in round 10, now surviving only in the failure case — which is the case spaced repetition exists to handle.

**Why the new test does not catch it.** The fixtures are real calls now, which is the right fix, but they exercise the one ordering where the bug is invisible:

```js
const tabletCard = PSAT_ENGINE.scheduleNext({ questionId: 'q1' }, 2, 1000); // Fail at t=1000
const laptopCard = PSAT_ENGINE.scheduleNext({ questionId: 'q1' }, 5, 2000); // Pass at t=2000
```

Both cards land on a 1-day interval, so `dueAt` orders identically to `lastReviewedAt` and the assertion passes whether or not `dueAt` is in the `Math.max`. The fixture is honest; the scenario is the wrong one.

**Fix.** Compare `lastReviewedAt` alone:

```js
var cTime = c.lastReviewedAt || c.timestamp || 0;
var lTime = l.lastReviewedAt || l.timestamp || 0;
```

Then add the newer-fail-versus-older-pass case above as a test and confirm it fails against the current code first.

## Minor

- The rollback writes with raw `store.setItem`, outside the `try` that guards the forward path. If a rollback write itself throws, the exception escapes to the outer `.catch` and the caller loses the `quotaExceeded` flag. Low risk — restoring a smaller previous value should fit — but the rollback is not itself guarded.
- Rollback restores keys that had a prior value; a key that did not exist before (`localProgRaw === null`) but was written successfully is left in place rather than removed, so the rollback is not complete in that case.

## Housekeeping still open

Unchanged from round 11: `validate.md` tracked in one place, git purge of 3,059 images, `DefaultAzureCredential` for `COSMOS_CONNECTION_STRING`, and the anonymous sync endpoint (owner's call).

---

# Re-review — round 13

Reviewed commit `b9f1f2a`. Scope remains **one student**.

## Fixed and verified

**Round 12 finding 1 — the SRS merge. Correct, in both directions.** `mergeSrsState` now compares `lastReviewedAt` alone. Executed with cards from `scheduleNext` — correct on the tablet Monday, wrong on the laptop Tuesday:

```
tablet Mon (correct, OLDER): lastReviewedAt=1900000000000 dueAt=1900604800000 reps=3 interval=7 grade=5
laptop Tue (WRONG,  NEWER): lastReviewedAt=1900086400000 dueAt=1900172800000 reps=0 interval=1 grade=1
merged -> lastReviewedAt=1900086400000 reps=0 interval=1 grade=1
PASS: failed review retained
reverse (cloud=newer fail, local=older pass) -> PASS
```

The failed review now survives the merge and the card stays due tomorrow, which is the whole point of SM-2.

**The regression test is real.** It asserts its own precondition first —

```js
assert.ok(monCardPass.dueAt > tueCardFail.dueAt, 'Precondition: older pass dueAt dominates newer fail dueAt');
```

— which guarantees the fixture actually exercises the ordering where the bug lived, rather than the one where it hid. I reintroduced the `Math.max(lastReviewedAt, dueAt)` comparison on purpose and the suite failed with `AssertionError: Newer review timestamp must win`. This is the second consecutive round where a new test was seen red before being trusted.

**Both round-12 minor items — done.** The rollback is wrapped in `try/catch`, and keys that had no prior value are now removed rather than left behind. A rollback test covering the not-previously-present case was added.

**Full pre-commit suite, run clean:**

```
python3 -m unittest test_extractor.py   -> OK (7 pass, 2 skip)
node tests/test_srs.js                  -> pass
node tests/test_free_response.js        -> 0
node tests/test_dataset_free_response.js-> 0
python3 rebuild_bundle.py               -> no drift in data/questions_data.js
validate_dataset                        -> 3059 0 2158
```

## Minor — the rollback's `else` can delete real data (mode 7 shape)

```js
if (localProgRaw !== null && store.setItem) store.setItem('psat_progress', localProgRaw);
else if (store.removeItem) store.removeItem('psat_progress');
```

The `else` is meant to handle "there was no prior value, so remove the key." But the condition also falls through when the prior value **did** exist and `store.setItem` is unavailable — in which case the rollback deletes the very data it is restoring. Executed against a store holding real progress but lacking `setItem`:

```
result: {"success":false,"error":"Storage quota exceeded while writing merged data","quotaExceeded":true}
psat_progress after rollback: null
  -> real data was present and is now DELETED by the rollback
```

**This is not reachable in the shipped app** — `store` is always `localStorage`, which always has `setItem`. I am flagging it because it is the exact shape mode 7 prohibits after round 8: *a fallback path may never be more destructive than the primary path*. Two unrelated conditions are fused into one branch. One line each:

```js
if (localProgRaw !== null) { if (store.setItem) store.setItem('psat_progress', localProgRaw); }
else if (store.removeItem) store.removeItem('psat_progress');
```

## Housekeeping still open

Unchanged since round 11 — none of these are code defects, and all four need a decision rather than a fix:

- `validate.md` is tracked in `9741e00`, deleted from the working tree, with an untracked copy in `agent-review/`. Pick one canonical tracked location.
- Git purge of the 3,059 tracked images. `api/node_modules` is out of the index but stays in history until a rewrite. Needs explicit sign-off.
- `COSMOS_CONNECTION_STRING` is still a connection string; round 1 recommended `DefaultAzureCredential` for the storage account and the rule was never applied to its twin.
- The sync endpoint is `authLevel: 'anonymous'`. Owner's call at one student; an `x-sync-key` header closes it in about ten lines per function.

## State of the review

Rounds 9 through 12 are fully closed. There are no open correctness defects in the application code. The remaining items are one unreachable defensive nit and four decisions for the owner.

---

# Parent portal — pre-fix baseline (from screenshots, 2026-08-25 19:49 / 19:52)

Recorded **before** reviewing the coder's in-progress fixes, so the diagnosis is independent of what they report. Screenshots predate commit `8b5f5fe` (19:54:10).

## What the screenshots show

Header says **DB Synced ✓**, and the portal renders:

| Panel | Displayed |
| :--- | :--- |
| Total Attempted | `0 / 3059` |
| Overall Accuracy | `0%` |
| Active Streak | `0 Days` |
| Completed Tests | `1 Completed Test` — "Test 1", 11/14/2023, **18/20** |
| Overall Accuracy (card) | `undefined% (18/20)` |
| Reading & Writing | `0/0 Correct` |
| Math Section | `0/0 Correct` |
| Total Exam Time | `0h 0m` |
| Reading & Writing (ELA) Mastery | `0 / 15 questions attempted`, every bar empty |
| Math Mastery | `0 / 15 questions attempted`, every bar empty |

The signature to explain is the **contradiction**: a completed 18/20 test is displayed while Total Attempted is 0 and both mastery panels are empty.

## Root cause 1 — push-before-pull wipes the cloud master document

`index.html:1101` (added in `6716d84`) pushes on app load and only then pulls:

```js
PSAT_ENGINE.pushToCloud(localStorage).then(pushRes => {
  if (pushRes && pushRes.success) {
    return PSAT_ENGINE.pullFromCloud(localStorage, null, 'default_student', safeSetStorage);
  }
```

`pushToCloud` uploads whatever `localStorage` currently holds. Server-side, the master document is written with `upsert` (`progress`, `srsState`, `sessionsState` replaced wholesale), while individual exam records are written with `items.create` and are immutable. So a browser opening the app with cleared or fresh storage **erases the cloud's progress, SRS and session state before it ever reads them**, and the exam documents survive.

Reproduced through the real `srs.js` functions against a mock implementing `sync.js` semantics:

```
cloud progress keys after student push : 20
cloud progress keys after empty push   : 0
cloud sessions after empty push        : {}

parent portal then sees:
  psat_progress entries : 0  -> Total Attempted 0/3059, both Mastery panels 0/15
  psat_exam_history     : 1 record(s) -> "1 Completed Test  18/20" still displayed
```

That is the screenshot, exactly. The mastery panels are empty because `calculateScaledScore(questions, progress)` is handed an empty `progress` map, so `rwAttempted`/`mathAttempted` are 0 (`parent.html:791`, `parent.html:800`).

**Fix.** Pull before push, and never let a push send an empty state over a non-empty cloud record. Server-side, the master document should merge rather than replace — or at minimum refuse a payload whose `progress` is empty when the stored document's is not.

## Root cause 2 — the exam card renders a standard-exam template for a record that has no sections

The stored record carries `totalCorrect`/`totalQuestions` but no `overallAccuracyPercent`, no `scores.*`, and no `totalTimeSpentMs` — hence `undefined%`, `0/0 Correct` twice, and `0h 0m`.

`8b5f5fe` addressed only the first of these, adding a computed fallback for `accPercent` (`parent.html:865`). The section and time cells are unchanged, and they are the mode-1 problem: **`0/0 Correct` is not a measurement.** It reads as "zero correct out of zero attempted" when the truth is "this record type has no section breakdown." Same for `0h 0m` when no timing was recorded.

**Fix.** Where `scores` is absent, render `—` or "No section breakdown for this test type", not `0/0`. Where `totalTimeSpentMs` is missing, render `—`, not `0h 0m`. This is the `…Reliable: false` pattern already established in `recordAttempt`/`gradeAttempt`.

## Separately introduced in `7d0f554` — quota recovery deletes completed exam reports

`safeSetStorage`'s new self-healing path, duplicated in `index.html:1003` and `parent.html:602`:

```js
let h = safeGetStorage('psat_exam_history', []);
if (Array.isArray(h) && h.length > 0) {
  let leanH = h.slice(0, 5).map(item => ... toLeanReport(item) ...);
  localStorage.setItem('psat_exam_history', JSON.stringify(leanH));
}
localStorage.setItem(key, JSON.stringify(val));
return true;
```

On a quota error this **discards every completed exam past the newest five** and then returns `true`, so the caller is told the write succeeded. This is the round-6 defect verbatim — `CLAUDE.md` mode 7 names it: *"quota recovery silently pruning completed exam reports."* It also violates mode 5: a `catch` that destroys data and reports success.

**Fix.** Prune only what is regenerable, never completed reports. If space cannot be reclaimed safely, return `false` and warn the user.

## Verdict to apply when the coder reports done

1. Does `progress` survive a load from a cleared browser? (root cause 1 — the top complaint)
2. Do the mastery panels populate from real `progress`, with real attempted counts?
3. Are missing section scores and missing timing shown as `—`, not `0/0` and `0h 0m`?
4. Has the exam-history pruning in both files been removed or made non-destructive?

---

# Re-review — round 14 (parent portal, v0.26)

Reviewed commits `23a273f` and `7969dc0` against the four checks recorded in the pre-fix baseline.

## The top complaint is not fixed

**Check 1 — push-before-pull: UNCHANGED.** `index.html` was not modified in either commit (mtime 19:47:36, predating both). `index.html:1101` still reads:

```js
PSAT_ENGINE.pushToCloud(localStorage).then(pushRes => {
  if (pushRes && pushRes.success) {
    return PSAT_ENGINE.pullFromCloud(localStorage, null, 'default_student', safeSetStorage);
```

Re-ran the reproduction against the v0.26 engine:

```
cloud progress after real student push : 20 entries
cloud sessions after real student push : {"2026-08-25":{...,"questionsAnswered":20,"correct":18,...}}

AFTER v0.26, cleared browser opens the app:
  cloud progress : 0 entries
  cloud sessions : {}
  parent psat_progress entries : 0
  -> Total Attempted 0/3059; ELA Mastery 0/15; Math Mastery 0/15
```

**Check 2 — mastery panels: UNCHANGED.** They read `calculateScaledScore(questions, progress)`, and `progress` is still emptied by the above.

## What the commits actually did

`23a273f` adds a hardcoded filter on one literal record id, in three places:

```js
// parent.html:854
const history = safeGetStorage('psat_exam_history', []).filter(h => h && h.examId !== 'custom_test_test1');
// srs.js, twice inside mergeExamHistory
if (h && (h.examId || h.completedAt) && h.examId !== 'custom_test_test1') {
```

This removes the *one record that made the bug visible*. With the 18/20 card filtered away, the screenshot's contradiction disappears — "1 Completed Test" is gone — while Total Attempted stays 0 and both mastery panels stay empty. **The symptom that was reported is untouched; only the evidence for it was removed.**

Three separate problems with the approach:

1. **It treats the wrong thing as the defect.** The coder's note explains the record as "a curl probe payload cached in browser history." The record was real output of the sync path; what was missing was `progress`, wiped by the push-before-pull. Deleting the record does not restore the student's attempts.
2. **A specific record id is now hardcoded in the shipped engine.** `mergeExamHistory` in `srs.js` will silently drop any genuine exam that carries that id, on every device, forever. Test 5 asserts this behaviour, which locks it in.
3. **It is a display filter over a data-loss bug.** `CLAUDE.md` mode 1: the portal now shows a clean empty state for a student who has real work in the system.

## Check 3 — missing section scores and timing: UNCHANGED

`parent.html:863, 868-869` still render zeros where data is absent:

```js
const timeStr  = `${Math.floor(totalMins/60)}h ${totalMins%60}m`;
const rwText   = hasScaled ? ... : `${h.scores?.rwCorrect || 0}/${h.scores?.rwTotal || 0} Correct`;
const mathText = hasScaled ? ... : `${h.scores?.mathCorrect || 0}/${h.scores?.mathTotal || 0} Correct`;
```

`0/0 Correct` and `0h 0m` are still presented as measurements when the underlying fields do not exist.

## Check 4 — quota pruning deletes completed exams: UNCHANGED

Still present verbatim at `index.html:1009` and `parent.html:608`, still slicing history to five records inside a `catch` that then returns `true`. The coder's note lists this as a *fix* — "automatic self-healing pruning (compresses to 8 KB lean records)" — but compression and deletion are different things, and this path does both. `toLeanReport` is the compression; `slice(0, 5)` is the deletion, and it is not required for the compression to work.

## What is genuinely good in `7969dc0`

Test 6 is a real test and worth keeping: it builds a full score report, compresses it with `toLeanReport`, asserts the redundant prompt text is stripped, then rehydrates and asserts `question_text` and `isCorrect` come back. That exercises a round-trip that has never been covered.

All suites pass: `test_srs.js`, `test_free_response.js`, `test_dataset_free_response.js` (365 SPR items, 449 forms), `test_extractor.py` (9 tests). The free-response and SRS work from rounds 9–13 remains solid.

## Required to actually close the complaint

1. **Pull before push on app load** (`index.html:1101`), and never push an empty `progress`/`srsState`/`sessionsState` over a non-empty cloud record. Server-side, merge the master document instead of `upsert`-ing it wholesale, or reject a payload that would empty a populated field.
2. **Remove the `custom_test_test1` filter** from `srs.js` and `parent.html`, and the test that asserts it. If a specific bad record needs removing, delete it from Cosmos once — do not ship a permanent id blocklist in the engine.
3. **Render `—` for absent section scores and absent timing**, not `0/0` and `0h 0m`.
4. **Stop deleting exam reports in the quota path.** Compress with `toLeanReport`; drop the `slice(0, 5)`; return `false` and warn if space still cannot be reclaimed.
5. **Add a regression test for the real bug**: push real progress, then simulate a cleared browser doing load-sync, and assert the cloud still holds 20 attempts. Watch it fail against the current code first.

---

# Re-review — round 15 (parent portal, v0.27)

Reviewed commit `7c213bc`. This round fixed the data-destroying paths. It also exposed a defect that the destroyed data had been hiding.

## Fixed and verified

**Check 1 — load-time push removed; the order is now pull-then-push.** `index.html:1085` pulls first, re-reads local state, re-renders, and only then pushes.

**The server-side merge is real and non-destructive.** `api/src/functions/sync.js` now reads the existing master document and merges into it — `progress` by newer `timestamp`, `srsState` by newer `lastReviewedAt`, `examHistory` deduplicated by `examId` — instead of replacing the document wholesale.

**Check 4 — the exam-report pruning is gone.** `slice(0, 5)` no longer appears in `index.html` or `parent.html`. Compression via `toLeanReport` is retained; the deletion is not.

**The `custom_test_test1` blocklist is gone** from `srs.js`, `parent.html`, and the test that asserted it. This was the right call: no record id is hardcoded in the engine any more.

All suites pass: `test_srs.js`, `test_free_response.js`, `test_dataset_free_response.js`, `test_extractor.py`.

## Finding 1 — Session counts now double on every app load

`mergeSessionsState` in `srs.js` is **unconditionally additive** — correct for combining two devices, wrong when re-merging state the device already contributed. The new load path runs pull-then-push on every page load, so the client re-adds the cloud's copy of its own totals each time. Executed through the real engine against a mock implementing the new server merge:

```
real work today: questionsAnswered = 12
after push          : 12 (cloud 12)
after app load #1   : 24 (cloud 24)
after app load #2   : 48 (cloud 48)
after app load #3   : 96 (cloud 96)
after app load #4   : 192 (cloud 192)
```

Twelve questions become 192 after four page refreshes, in local storage **and** in the cloud. Every downstream number inflates with it: "Past 7 Days Practice" minutes, the daily goal bar, accuracy per day, and the parent's session history.

**This defect is not new — it was masked.** Before `7c213bc`, the load path pushed first and wiped the cloud's sessions, so the additive merge had nothing to add back. Fixing the wipe exposed the double-count. The second reviewer's report (`REVIEW_R2.md`, untracked) independently flagged the session merge as non-idempotent.

There is also a **mode-2 split**: the client merges sessions additively while the server merges the same field with `Math.max`:

```js
mergedSessions[dStr] = {
  questionsAnswered: Math.max(existing.questionsAnswered || 0, sess.questionsAnswered || 0),
```

Two engines, two different rules for one concept. `Math.max` alone would lose a genuine second device's work; addition alone double-counts. Neither is right on its own.

**Fix.** Make the merge idempotent rather than additive — the client must be able to tell its own already-synced contribution from another device's new work. The simplest correct form is to store per-device day counters (`sessionsState[day][deviceId]`) and sum across devices at read time, so re-merging the same device's entry replaces rather than adds. Then use that one rule on both sides, or extract it into `srs.js` and have the server call the same logic. Add a test that pulls and pushes three times in a row and asserts the count is unchanged; watch it fail first.

## Finding 2 — A transient read failure lets the merge wipe the cloud document

```js
try {
  const { resource } = await c.item(masterDocId, targetStudent).read();
  existingMaster = resource;
} catch (readErr) {
  // Document does not exist yet; first push for this student
}
```

The comment assumes the only possible failure is a 404. Any error — throttling (429), a timeout, a transient network fault — is swallowed identically, leaving `existingMaster` null. The merge then starts from empty and the subsequent `upsert` writes the client's payload over the stored document. A single throttled read on a serverless account reproduces exactly the data loss this commit set out to fix.

**Fix.** Branch on `readErr.code === 404` / `statusCode === 404` and treat only that as "first push." On any other error, abort with a 503 and do not write — the client already handles a failed push. Nothing here should ever `catch` and continue as if the store were empty.

Note also that `c.item(masterDocId, targetStudent).read()` assumes the container's partition key is `/student_name`. If it is `/id`, this read throws on every request and finding 2 becomes the normal path rather than the rare one. Worth confirming against the actual container definition.

## Check 3 — still unchanged

`parent.html:848, 853-854` still render `0/0 Correct` and `0h 0m` for records that carry no `scores` and no `totalTimeSpentMs`. Third round reported; still a mode-1 defect. Absent data must read `—`.

---

# Re-review — round 16

Reviewed commit `2213fe8`. **All three round-15 findings are fixed and verified.** No new defects found.

## Finding 1 — session merge: fixed, and the approach is the right one

`mergeSessionsState` now takes a third argument, the merged progress map, and derives ground truth from it:

```js
function mergeSessionsState(cloudSessions, localSessions, mergedProgress)
```

Day totals are combined with `Math.max`, then reconciled against `deriveSessionsFromProgress(mergedProgress)`. This is the correct insight: `progress` is keyed by question id, so it merges idempotently, which makes counts derived from it stable under repeated syncs *and* complete across devices. Neither `Math.max` nor addition achieves both on its own.

Both properties verified by execution against a mock implementing the current `sync.js` merge:

```
A) idempotency (12 real questions):
   after push       : 12
   after app load #1: 12 (cloud 12)
   after app load #2: 12 (cloud 12)
   after app load #3: 12 (cloud 12)
   after app load #4: 12 (cloud 12)

B) two devices same day (12 + 5 disjoint questions):
   laptop after sync: {"date":"2026-08-25","questionsAnswered":17,"correct":14,"totalTimeMs":170000}
   cloud            : {"date":"2026-08-25","questionsAnswered":17,"correct":14,"totalTimeMs":170000}
```

12 stays 12 across four refreshes; 12 + 5 still yields 17 correct-14. The regression test is real — I reintroduced the additive merge and the suite failed with `AssertionError: Session count must not inflate on refresh 1`.

The new third argument is passed in the correct position at the single call site (`srs.js:1242`).

## Finding 2 — transient read errors: fixed

```js
} catch (readErr) {
  if (readErr.statusCode === 404) {
    existingMaster = null;
  } else {
    context.error('Cosmos DB read error on master profile:', readErr);
    return { status: 503, jsonBody: { error: 'Database read failed. Please retry.' } };
  }
}
```

Only a genuine 404 is treated as "first push"; a throttle, timeout, or transient fault now aborts before the `upsert` instead of overwriting the stored document with an empty merge. The `catch` reports rather than swallows.

## Finding 3 — absent data displayed as zeros: fixed at both sites

`parent.html:848, 853-857` gate on real presence:

```js
const timeStr  = (h.totalTimeSpentMs && h.totalTimeSpentMs > 0) ? `${...}h ${...}m` : '—';
const hasRw    = (h.scores && typeof h.scores.rwTotal === 'number' && h.scores.rwTotal > 0);
const rwText   = hasScaled ? `${h.scores?.rwScaled} / 720` : (hasRw ? `${h.scores.rwCorrect}/${h.scores.rwTotal} Correct` : '—');
```

Importantly, the same treatment was applied to the **modal review twin** at `parent.html:930-931`, not only the history card. Mode 2 satisfied without needing to be asked.

## Suite

```
node tests/test_srs.js                   -> pass
node tests/test_free_response.js         -> 0
node tests/test_dataset_free_response.js -> 0
python3 -m unittest test_extractor.py    -> OK
```

## Standing decisions (not defects)

Unchanged and awaiting the owner, not the coder:

- `validate.md` tracked in one canonical location.
- Git purge of the 3,059 tracked images; `api/node_modules` is out of the index but remains in history until a rewrite.
- `DefaultAzureCredential` in place of `COSMOS_CONNECTION_STRING`.
- The sync endpoint is `authLevel: 'anonymous'`; an `x-sync-key` header closes it in about ten lines per function.
- ~~Confirm the Cosmos container's partition key~~ **Resolved.** `migrate_to_cosmos.py:59` creates `UATStudentAnswers` with `PartitionKey(path="/student_name")`, so `c.item(masterDocId, targetStudent).read()` addresses it correctly.

## State of the review

No open correctness defects in the application or engine code across rounds 9–16.

---

# Re-review — round 17 (three owner-requested items)

Reviewed the 11 commits from `bde2c89` to `e64e22c`. All four suites pass; `rebuild_bundle.py` shows no drift.

## Item 3 — Math/RW section totals: FIXED

`parent.html` now derives section splits from `moduleReports` by looking each question up in `QUESTIONS_DATA`, instead of trusting a `scores` object that non-standard exams never carried.

Field check against the real dataset — `test` is a real field with exactly two values, `Math` (1505) and `Reading and Writing` (1554). Executed against a freshly generated 98-question exam:

```
modules: Reading and Writing:27  Reading and Writing:27  Math:22  Math:22
classified -> RW 36/54  Math 28/44  total 98
ground truth-> RW total 54  Math total 44
PASS: section split matches the real exam
```

Two notes, neither blocking:
- `qMeta.section` appears in the `||` chain but exists on **0 of 3,059** records. Dead branch, harmless.
- The ~20-line classification block is duplicated verbatim in the history card and the modal. Mode 2 — extract it into `srs.js` and call it twice.

## Item 1 — Wrong-answer tracking: works, but the counters shrink after every sync

`buildTroubleSpots` verified against the real bank. 40 answered, 20 trouble spots, correctly ranked, with `test`/`domain`/`skill` available for grouping:

```
3x wrong | Reading and Writing | Information and Ideas | Central Ideas and Details
3x wrong | Reading and Writing | Information and Ideas | Command of Evidence
```

Double counting between `progress` and `examHistory` is correctly guarded by `if (!prog[qid])`.

### Finding 1 — `timesSeen` / `timesIncorrect` decrease after syncing

`mergeProgress` derives the counters from the union of attempt records — the same idempotent insight that fixed the session merge, and right in principle. But it then truncates the evidence it derived them from:

```js
chosen.timesSeen  = combinedAttempts.length;
chosen.attempts   = combinedAttempts.slice(-10);
```

The next merge sees only 10 attempts, so the counters fall to 10. Executed on a question genuinely attempted 15 times:

```
true history: timesSeen=15  timesIncorrect=5
after sync #1: timesSeen=15  timesCorrect=10  timesIncorrect=5  attempts kept=10
after sync #2: timesSeen=10  timesCorrect=7   timesIncorrect=3  attempts kept=10
after sync #3: timesSeen=10  timesCorrect=7   timesIncorrect=3  attempts kept=10
```

**"Wrong 5 times" silently becomes "wrong 3 times."** This defeats the purpose of the feature: the hardest questions are exactly the ones with the most attempts, so they are the ones whose counts decay. Under mode 1 it is also a displayed number that is no longer a measurement.

**Fix.** Keep the counters as authoritative stored values and take `Math.max(storedCounter, derivedFromAttempts)`, so truncating the attempt log cannot walk them backwards. Add a test that merges three times against a 15-attempt record and asserts `timesSeen` stays 15 — watch it fail first.

### Finding 2 — the attempts log will exhaust localStorage

Measured cost of the new per-question `attempts` array at full bank coverage:

```
all 3059 questions,  1 attempt each  -> psat_progress = 0.97 MB
all 3059 questions,  3 attempts each -> psat_progress = 1.55 MB
all 3059 questions, 10 attempts each -> psat_progress = 3.58 MB
localStorage quota is ~5 MB TOTAL across all psat_* keys
```

`psat_progress` alone reaches 3.58 MB, before `psat_srs`, `psat_sessions` and `psat_exam_history`, and the whole payload is POSTed to Cosmos on every save. Combined with the new bank-coverage rotation that drives the student toward all 3,059 questions, this is on a path to the quota rather than near it. Cap the attempts log at 3, or store only the aggregate counters plus the most recent attempt.

## Item 2 — Cosmos backup: real and working, with one path that destroys the backup

`scripts/backup_cosmos.js` genuinely runs. `backups/cosmos_backup_latest.json` is 105 KB, 5 documents, containing real student progress — not a stub.

### Finding 3 — an empty fetch overwrites the last good backup (mode 7)

```js
fs.writeFileSync(backupPath, JSON.stringify(backupPayload, null, 2), 'utf8');
console.log('✓ Backup successfully written to: ...');
fs.copyFileSync(backupPath, latestPath);
```

Nothing asserts `allDocs.length > 0`. A wrong `COSMOS_CONTAINER_NAME`, a transient empty result, or a query against a fresh container writes a structurally valid backup containing `documents: []`, prints a success tick, and then **unconditionally overwrites `cosmos_backup_latest.json`** — the file `restore_cosmos.js` reads by default. The good backup is gone and the run reports success.

**Fix.** Refuse to write, and refuse to move the pointer, when `documentCount` is 0 or has dropped sharply versus the previous backup. Exit non-zero and say why.

### Finding 4 — restore overwrites newer data with no guard (mode 7)

`runRestore` loops `container.items.upsert(doc)` with no dry run, no confirmation, and no comparison of backup age against what is live. Restoring a week-old snapshot silently replaces a week of newer work — the mode-7 rule requires a destructive action to state plainly what will be erased and offer a way back.

**Fix.** Default to a dry run listing what would change; require an explicit `--apply`; and snapshot the current live state before writing.

### Finding 5 — the backup shares a failure domain with what it protects

`backups/` is gitignored, so the only copy lives on this machine — the same machine that already exclusively holds the four source PDFs. A disk failure takes the student's history and the only means of regenerating the question images at once. It is also manual: the backup exists only when someone remembers to run it.

**Fix.** Push each snapshot somewhere off-machine — Azure Blob in the same account is enough — and schedule it. Also note the script imports `../api/node_modules/@azure/cosmos`, which is now untracked, so a fresh clone needs `npm install` in `api/` before the backup can run at all.

### Finding 6 — "the questions" are not in the backup

Your stated goal was not losing "the questions as well as their answering history." The script exports only `UATStudentAnswers`. The `Questions` container (3,059 items) and `UATFeedback` are not exported. Questions are still redundant in git, so they are covered in practice — but feedback is backed up nowhere, and the script's own description claims broader coverage than it delivers.

## Summary

| Item | Status |
| :--- | :--- |
| 3 — Math section totals | **Fixed**, verified against a real exam |
| 1 — Wrong-answer tracking | Works, but counters shrink on sync, and storage is on a path to the quota |
| 2 — Cosmos backup | Real and working; empty-fetch destroys the pointer, restore is unguarded, single copy on one machine |
