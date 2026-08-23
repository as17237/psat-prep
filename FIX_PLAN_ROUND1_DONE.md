# Fix Plan — PSAT Prep Mastery Platform

**Companion to:** `REVIEW.md` · **Baseline:** commit `6bec447`
**Audience:** the agent/developer implementing these changes.

Work is ordered by priority. Each item states the defect, the files to touch, the approach, and how to know it's done. Items 1–4 are independent and can be done in any order; item 5 depends on item 4 (timing capture), and item 9 should be done last since it rewrites git history.

**Global ground rules**
- Do not re-run extraction. The dataset was audited (see `REVIEW.md` § Extraction verification) and is correct; regenerating 325 MB of images to fix a UI bug is wasted work. Items 6 and 7 are the only ones that touch `data/`, and both are small, targeted rewrites of the JSON.
- After any change to `data/*.json`, regenerate `data/questions_data.js` from them so the bundle and the JSON never drift. Add a small `rebuild_bundle.py` (or a `--bundle-only` flag on `extract_questions.py`) for this — right now the bundle can only be produced by a full re-extraction, which is why nobody will keep it in sync by hand.
- Keep `index.html`/`parent.html` dependency-free and runnable from `python3 -m http.server`. No build step, no framework migration.

---

## 1. Remove the fabricated numbers from the parent portal — **do this first**

**Defect.** `parent.html` shows four values that are hardcoded HTML and never written by any JavaScript: streak `5 Days` (`:70`), study time `185 mins / 200 min goal` (`:74`), SRS due `14 Questions` (`:86`), top weakness `Inferences` (`:126`). `renderParentMetrics()` (`:211-275`) writes only `stat-total-attempted`, `stat-overall-accuracy`, `stat-flagged-count`, `hero-scaled-score` and the two domain-bar containers. A parent reading this dashboard is being shown invented measurements.

**Fix.**
- `stat-top-weakness` — compute it. The data exists: build per-skill `{correct, attempted}` in the same loop that already builds `domainStats`, then pick the lowest accuracy among skills with at least 5 attempts. Render `"None yet"` when nothing qualifies.
- `hero-streak` and `hero-study-time` — the underlying data does not exist yet (no session log, no timing). Delete both tiles now. Re-add them in item 5 once `progress[].timeSpentMs` and a per-day session log exist; a tile that will be real in two weeks is still a lie today.
- `hero-srs-due` — same: delete now, re-add in item 5 as `Object.values(srs).filter(c => c.dueAt <= Date.now()).length`.
- Sweep the rest of both pages for the same class of bug: any element with an `id` that no script ever assigns. `index.html` has the same issue in its static placeholders (`Q1 of 3059`, `ID: 737870c6`, `Hard`, `Information and Ideas`, `Inferences` at `:135-146`) — those are harmless because `loadQuestion()` overwrites them on load, but if the bundle ever fails to load the user sees a fake question header. Guard `DOMContentLoaded` with a check that `window.QUESTIONS_DATA` is a non-empty array and render an explicit error state if not.

**Done when.** Every `id`-bearing display element in `parent.html` is either written by `renderParentMetrics()` or removed. With an empty `localStorage`, the page shows zeros and empty states, not a plausible-looking week of study.

---

## 2. Replace the score projection with a defensible estimate

**Defect.** `parent.html:245-247`:
```js
const baseScore = 700;
const estimatedScore = totalAttempted > 0 ? Math.min(1520, Math.round(baseScore + (overallAcc/100)*820)) : 1460;
```
Three problems. (a) With zero attempts it prints **1460** — the fallback shows a near-perfect score for a student who has done nothing. (b) The mapping is invented: it is linear in overall accuracy, ignores which section the questions came from, and ignores sample size, so 8-for-8 on easy Algebra reads as 1520. (c) **The scale is wrong for this dataset** — all 3,059 questions are `assessment: "PSAT 8/9"`, which scores **240–1440** (120–720 per section), not the 320–1520 of the PSAT/NMSQT that the code and docs assume.

**Fix.**
- Score each section separately. Compute accuracy over attempted questions where `test === "Reading and Writing"` and where `test === "Math"`, map each to the 120–720 section range, and sum for the total.
- Use a per-section mapping with a floor, e.g. `120 + accuracy * 600` clamped to `[120, 720]`, so 0% maps to the true scale minimum rather than to an arbitrary 700 baseline. If you want better fidelity than a linear map, weight by difficulty — the bank is 60% Hard, so raw accuracy on it understates a scaled score — but a documented linear map is acceptable as long as it is labeled.
- **Gate on sample size.** Show `—` with the text "Not enough practice yet — needs at least 25 questions per section" until both sections have ≥25 attempts. Below that the estimate is noise.
- Label it in the UI as an estimate derived from practice accuracy, not a predicted official score, and state the sample it is based on ("based on 143 questions attempted").
- Drive the range from the data rather than hardcoding: read `assessment` off the questions and pick the scale (`PSAT 8/9` → 240–1440, `PSAT/NMSQT`/`PSAT 10` → 320–1520, `SAT` → 400–1600). Put the table in one constant so a future mixed-assessment bank works.

**Done when.** Zero attempts shows no number; the maximum achievable readout is 1440; and section scores are computed independently. Add a couple of assertions in a scratch test (or a browser console check) for the boundary cases: 0 attempts, 100% on one section only, 100% on both.

---

## 3. Fix free-response grading

**Defect.** `index.html:668` grades with `inputVal.toLowerCase() === q.correct_answer.toLowerCase()`. Of 365 free-response items, **72 store several accepted forms in one comma-separated string** — `".2, 1/5"`, `"3.5, 7/2"`, `"14.66, 14.67, 44/3"`, `"-.3266, -.3267, -49/150"`. A student typing `0.2` for the first is marked wrong. Even for single-valued keys, `2.5` fails against `5/2`. This is the bug most likely to actively mislead the student about what they know.

**Fix.** Add a grading helper in `index.html` and use it from `submitFreeResponse()`:

```js
function parseNumeric(s) {
  s = String(s).trim().replace(/[$,%\s]/g, '');
  if (!s) return null;
  const frac = s.match(/^(-?\d*\.?\d+)\/(-?\d*\.?\d+)$/);
  if (frac) { const d = parseFloat(frac[2]); return d === 0 ? null : parseFloat(frac[1]) / d; }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function gradeFreeResponse(input, key) {
  const accepted = String(key).split(',').map(s => s.trim()).filter(Boolean);
  const userNum = parseNumeric(input);
  return accepted.some(a => {
    if (userNum !== null) {
      const keyNum = parseNumeric(a);
      // College Board accepts any value that rounds/truncates to the key at 3+ significant digits
      if (keyNum !== null) return Math.abs(userNum - keyNum) <= Math.max(1e-4, Math.abs(keyNum) * 1e-3);
    }
    return input.trim().toLowerCase() === a.toLowerCase();
  });
}
```

Notes for the implementer:
- Keep the string fallback — a handful of keys are not numeric.
- Tolerance matters: keys like `14.66, 14.67, 44/3` are the truncated and rounded forms of 44/3, so a student entering `14.6667` should pass. The relative tolerance above handles that; verify against that specific question (`id` findable by grepping the JSON for `14.66`).
- On an incorrect answer, show the full accepted set in the feedback banner (`index.html:638-651` currently prints the raw `q.correct_answer` string, which reads oddly as `".2, 1/5"` — render it as "Accepted answers: .2 or 1/5").

**Done when.** For every one of the 72 multi-form keys, each individual form grades as correct. Write a throwaway Node script that loads `data/questions_data.js`, runs `gradeFreeResponse(form, key)` for every comma-separated form of every FR key, and asserts all pass — then delete it or keep it under `tests/`.

---

## 4. Record response time (prerequisite for SRS)

**Defect.** `selectMultipleChoice()` (`index.html:655-667`) and `submitFreeResponse()` (`:669-684`) record `{answered, selectedAnswer, isCorrect, timestamp, isFlagged}`. The SM-2 variant specified in `SYSTEM_ARCHITECTURE_AND_PLAN.md` §3.1 grades on response time (`<45s` → q=5, `45–90s` → q=4, `>90s` → q=3), so the one input the documented algorithm needs is never captured.

**Fix.**
- Add a module-level `let questionShownAt = null;` and set it at the end of `loadQuestion()` (`index.html:534-654`) — only when the question is unanswered, so revisiting a completed question doesn't restart the clock.
- On submit, record `timeSpentMs: Date.now() - questionShownAt`. Guard against absurd values (tab left open overnight): cap at, say, 10 minutes and store a `timingReliable: false` flag when the cap trips, so SRS can fall back to q=3 rather than treating it as a 6-hour hesitation.
- Pause the clock when the tab is hidden — `document.addEventListener('visibilitychange', ...)` accumulating only foreground time — otherwise every overnight-tab session poisons the grade.
- Also append to a per-day session log in `localStorage` (`psat_sessions`): `{date: 'YYYY-MM-DD', questionsAnswered, correct, totalTimeMs}`. That is what item 1's study-time and streak tiles need.
- Migrate existing progress gracefully: entries without `timeSpentMs` are pre-existing data, treat as unknown timing, do not backfill a guess.

**Done when.** Answering a question writes a plausible `timeSpentMs`; switching tabs for a minute does not inflate it; and `psat_sessions` accumulates one entry per calendar day of practice.

---

## 5. Implement the SRS engine (or stop advertising it)

**Defect.** Spaced repetition is feature #3 in `README.md`, has a full specification in `SYSTEM_ARCHITECTURE_AND_PLAN.md` §3, and a due-count tile in the parent portal — and does not exist in any file. There is no ease factor, no interval, no review queue, no scheduler.

**Decision to make first.** Either implement it or cut the claims. Do not leave it documented-but-absent. If cutting: remove feature #3 from `README.md`, remove §3 from the architecture doc (or retitle it "Proposed design — not implemented"), and drop the parent tile. If implementing, proceed as below.

**Fix.** New `localStorage` key `psat_srs`, one card per attempted question:
```js
{ questionId, repetitions, intervalDays, easeFactor, lastReviewedAt, dueAt, history: [{at, grade, timeMs, correct}] }
```
- Implement `gradeAttempt(isCorrect, timeMs)` → q per the spec's thresholds, and `scheduleNext(card, q)` per SM-2: `EF' = max(1.3, EF + (0.1 - (5-q)*(0.08 + (5-q)*0.02)))`; on `q < 3` reset `repetitions = 0, interval = 1`; otherwise interval `1 / 3 / 7` for repetitions `0 / 1 / 2` and `round(interval * EF')` beyond; `dueAt = now + interval * 86400000`.
- Write this as a **plain function block near the top of the script, with no DOM access**, so it is unit-testable. Extracting it to `srs.js` and loading it with a second `<script>` tag is the cleaner option and costs nothing (still no build step).
- Wire a "Review Due (N)" option into the existing status filter in `index.html` (`filter-status`, `:100-106`) so `applyFilters()` (`:504-533`) can select `dueAt <= Date.now()`. That reuses the whole existing practice flow — no new view needed.
- Call the scheduler from both submit paths after `saveProgress()`.
- Then restore the parent portal's due tile from real card state.

**Done when.** A unit test (Node, no DOM) covers: first correct-fast answer → interval 1 day, EF up; three consecutive correct → 1/3/7 day ladder; an incorrect answer → interval resets to 1 and EF drops by 0.2 with a 1.3 floor. The "Review Due" filter returns exactly the cards whose `dueAt` has passed.

---

## 6. Make the validator tell the truth about text completeness

**Defect.** When choice parsing fails, `extractor.py:190-194` substitutes literal `"Option A"…"Option D"`. That fires on **875 of 1,505 Math questions** (900 questions have at least one placeholder). `validate_question()` (`validator.py:47-53`) checks only that four options exist with keys A–D, so all of them pass and the pipeline reports 100% valid. The docs then claim "zero dropped formulas". The image cards *do* preserve everything, so nothing is truly lost — but Text Mode, the bank explorer's search, and any future text feature are blank for those questions, and the metric hides it.

**Fix.**
- Split validation into **errors** (schema violations — keep the current behaviour) and **warnings** (content-quality signals). Add warnings for: option text matching `^Option [A-D]$`; `question_text` shorter than ~40 chars; `question_text` containing the tell-tale collapsed-formula gap (`\s{2,}` mid-sentence or a sentence ending in a preposition/article before a newline).
- Add a `text_complete` boolean per question and report `text_complete_count` / `text_complete_pct` in `validate_dataset()`'s summary alongside `valid_count`.
- Make `extract_questions.py` log both numbers so the run output stops implying the text layer is perfect.
- **Also stamp `text_complete` onto each question record in the JSON.** The frontend needs it (see below) and computing it in the browser duplicates the rule.
- Frontend follow-through: in `index.html`, when `text_complete` is false, disable the Text Mode toggle for that question with a tooltip ("This question's formulas are only in the official card view") instead of silently showing `Option A / Option B / Option C / Option D`. In the bank explorer, exclude those from text search matching or mark the row.
- Docs: correct `README.md` ("100% Visual Fidelity … Zero Dropped Formulas") and `SYSTEM_ARCHITECTURE_AND_PLAN.md` §1 to state plainly that **Math text extraction loses inline formulas by design and the card image is authoritative**, with the real numbers (2,159 of 3,059 text-complete).

**Done when.** The validation summary reports schema validity and text completeness as two separate numbers, the JSON carries `text_complete`, Text Mode is unavailable rather than misleading, and no doc claims zero loss.

---

## 7. Two small data-integrity fixes

Both are targeted edits to `data/*.json` (then regenerate the bundle). Neither requires re-extraction.

**7a. Skill-name casing collision.** The source PDFs spell one skill two ways: `Cross-Text Connections` (41 questions) and `Cross-text Connections` (2). They become two separate buckets in every analytics grouping (`index.html:812-840`, `parent.html:220-236`), so one skill silently splits in the strengths/weaknesses lists. Normalize the 2 outliers to the dominant spelling in the JSON, **and** add a canonicalization step in `extractor.py` (a `SKILL_ALIASES` dict applied in `parse_question_text`) so a re-run doesn't reintroduce it. Assert in `validator.py` that no two skills differ only by case.

**7b. Two questions where the source contradicts itself.** For `f302230c` and `ac972578` (both Math), the answer PDF's `Correct Answer:` line says `A` / `B` while its own rationale text says "Choice D is correct" / "Choice C is correct". This is a defect in the College Board PDF, not in the extractor — the extractor correctly follows the explicit key, which is the one that matches the rendered card. But a student who answers correctly and then reads a rationale about a different letter will be confused. Add a `rationale_letter_mismatch: true` flag to those two records (detected generically: parse `Choice ([A-D]) is (the best answer|correct)` from the rationale and compare to `correct_answer`), and have `index.html` show a short note above the rationale when it is set. Add the same check to `validator.py` as a warning so future banks surface it automatically.

**Done when.** `Cross-text Connections` no longer appears; the two flagged questions render a caveat; both checks run in the validator.

---

## 8. Harden `upload_to_azure.py` before any deploy

**Defects.** Four separate problems, none of which have bitten yet only because the script has never been run for real.

1. **Image paths are never rewritten.** The script upserts records containing `question_image: "images/abc_question.png"`, but the schema in `SYSTEM_ARCHITECTURE_AND_PLAN.md` §2.2 specifies an absolute `image_url` blob URL. Nothing performs that translation, so a cloud-hosted frontend would show broken images for all 3,059 questions. **Fix:** in `upload_questions_to_cosmos()`, before upsert, set `q["image_url"] = f"{blob_base_url}/{container}/{os.path.basename(q['question_image'])}"`. Take the blob base URL as a CLI arg / env var and require it when `--cosmos-conn` is given.
2. **The blob container is created world-readable.** `upload_images_to_blob()` (`:63`) passes `public_access="blob"`, publishing 325 MB of copyrighted College Board material to an anonymous-readable URL. **Fix:** default to private and serve via SAS tokens or a CDN with a restricted origin; make public access an explicit opt-in flag if it is ever wanted.
3. **Credentials come in on `argv`.** `--cosmos-conn` / `--blob-conn` land in shell history and in the process list. **Fix:** read from `COSMOS_CONNECTION_STRING` / `BLOB_CONNECTION_STRING` env vars, and prefer `DefaultAzureCredential` + account URL over connection strings entirely. Keep the CLI flags only as a documented override.
4. **Serial upload with no retry.** 3,059 sequential `upsert_item` calls and 3,059 sequential blob uploads, with no error handling — one transient 429 (very likely on serverless Cosmos) aborts the run with no record of what was uploaded. **Fix:** wrap each item in try/except with exponential backoff on 429/503, use a `ThreadPoolExecutor` (8–16 workers) for blobs, log failures to a file, and support resuming by skipping blobs that already exist. Consider converting the PNGs to WebP on upload — the architecture doc already assumes `.webp`, and it will cut the 325 MB by roughly two-thirds.

**Done when.** A dry-run mode (`--dry-run`) prints exactly what would be written, credentials come from the environment, the container is private by default, and a forced failure mid-run can be resumed without duplicate work.

---

## 9. Repository hygiene and a runnable test suite

**9a. Get the images out of git.** `data/images/` is 325 MB and `.git` is 264 MB — a fresh clone is punishing, and the images are *derived artifacts* reproducible from the PDFs. Add `data/images/` to `.gitignore`, remove it from history with `git filter-repo --path data/images --invert-paths` (or `git lfs migrate` if you'd rather keep them versioned), and document in `README.md` that images are produced by `extract_questions.py` or downloaded from Blob Storage. **Do this last** — it rewrites history, so land every other change first. Confirm with the user before force-pushing anything.

**9b. Make the tests runnable from a clean clone.** `test_extractor.py:118-132` calls `extract_questions_from_bank("ELA1.pdf", ...)` in `setUpClass`, and the PDFs are gitignored — so all nine tests fail immediately on checkout, and CI is impossible. Restructure:
- Split the suite in two. **Pure parser tests** for `parse_question_text()` and `parse_choices_robust()` driven by small committed text fixtures (`tests/fixtures/*.txt`, a few KB — capture the raw page text for the ~8 questions currently asserted on). These run anywhere, in milliseconds, and cover the logic that actually breaks.
- **Integration tests** that need the real PDFs, guarded by `@unittest.skipUnless(os.path.exists("ELA1.pdf"), "source PDFs not present")` so they skip cleanly instead of failing.
- Add cases for the paths that currently have none: the three answer-key fallbacks (`extractor.py:160-174`), numeric-key options `1.`–`4.` mapping to A–D (`NUM_TO_LETTER`), multi-line option text, and the placeholder-substitution branch (assert it *is* flagged as not text-complete).
- Add the new JS-side tests from items 3 and 5 (Node, no DOM) under `tests/`.
- Then add `.github/workflows/test-and-validate.yml` — the architecture doc §5 already promises it. It should run the parser tests and the validator against the committed JSON.

**9c. Latent robustness in the extractor** (no live defect — worth fixing while nearby). `index_pdf_questions()` (`extractor.py:44-58`) takes `matches[0]` per page, so if two questions ever begin on the same page the second is silently swallowed into the first. I verified this never happens in the current four PDFs (0 pages with more than one distinct ID), but it is a silent-data-loss failure mode for the next bank. Handle multiple IDs per page, or at minimum `logger.warning` when `len(set(matches)) > 1`. Same function: if the PDF begins with front matter before the first `Question ID:`, those pages are dropped silently — fine today (verified 0 unassigned pages), worth a warning.

**9d. `innerHTML` with interpolated question data.** `index.html:625-628` (option text), `:975-991` (bank table rows), and `parent.html:255-265` build HTML by string concatenation with question fields inside. The data is self-generated so this is not an exploitable XSS today, but a `<` or `&` in a rationale or option will silently mangle the DOM. Use `textContent` for the text nodes, or escape via a small `esc()` helper. Low priority, quick win.

---

## Verification checklist for the implementing agent

Run these before declaring done:

```bash
# 1. Parser + validator tests pass from a clean checkout (no PDFs needed)
python3 -m unittest discover tests -v

# 2. Dataset still validates, and now reports text-completeness separately
python3 -c "import json; from validator import validate_dataset; \
  q=json.load(open('data/ela_questions.json'))+json.load(open('data/math_questions.json')); \
  r=validate_dataset(q, base_image_dir='data/images'); \
  print(r['valid_count'], r['invalid_count'], r.get('text_complete_count'))"

# 3. Bundle matches the JSON (no drift)
python3 -c "import json,re; \
  js=open('data/questions_data.js').read(); \
  b=json.loads(js[js.index('=')+1:js.rstrip().rstrip(';').rindex(']')+1]); \
  src=json.load(open('data/ela_questions.json'))+json.load(open('data/math_questions.json')); \
  print('bundle in sync:', b==src)"

# 4. Free-response grader accepts every stored form (script from item 3)
node tests/test_free_response.js

# 5. SRS scheduler unit tests
node tests/test_srs.js
```

Manual pass, with `localStorage` cleared: open `parent.html` — no number on the page may be non-zero. Then answer 30 questions in `index.html` and reopen it — every displayed number must be traceable to those 30 answers.
