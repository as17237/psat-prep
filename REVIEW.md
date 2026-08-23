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
