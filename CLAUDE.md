# CLAUDE.md — Working rules for this repository

Read this before writing code here. It is not general advice: every rule below exists because the same class of defect shipped repeatedly across six review rounds (`REVIEW.md`). Each rule cites the rounds it came from so you can see it is a real pattern, not a preference.

## What this project is

A static, dependency-free PSAT 8/9 prep app over 3,059 questions extracted from College Board PDFs.

- **Data pipeline (Python):** `extractor.py` → `validator.py` → `extract_questions.py`; `rebuild_bundle.py` regenerates `data/questions_data.js` from the two JSON files. `normalize_data.py` is a one-shot normaliser.
- **Logic (JS, testable):** `srs.js` — a UMD module with **no DOM access**: grading, SM-2 scheduling, score modelling, exam/drill generation. This is where logic belongs.
- **UI:** `index.html` (student), `parent.html` (parent portal), `feedback.html`. No build step; must run from `python3 -m http.server`.
- **State:** browser `localStorage` only — `psat_progress`, `psat_srs`, `psat_sessions`, `psat_exam_history`, `psat_active_exam_state`.

---

## The one rule that would have caught most past bugs

**Execute the real code path against the real dataset before you say it works.**

Inspection and "tests pass" have both been insufficient here. The 88-question exam sold as 98, the grid-in filter returning 0, the placeholder answer buttons, the 209 KB storage records — every one survived a green test suite and would have died instantly to one `node -e` run against `data/questions_data.js`.

```bash
node -e "
const E=require('./srs.js'), fs=require('fs');
const js=fs.readFileSync('data/questions_data.js','utf8');
const data=JSON.parse(js.slice(js.indexOf('=')+1, js.lastIndexOf(']')+1));
// …now call the function you changed and print what it actually returns
"
```

If a change touches generation, filtering, scoring, or storage, paste the real numbers into your summary. "Should work" is not a result.

---

## The seven recurring failure modes

### 1. Inventing a number and showing it as a measurement — *rounds 1, 2, 4, 5, 6*

The most persistent defect in this project's history.

> Hardcoded "5 Days" streak and "185 mins" (R1) · score of **1460 with zero questions attempted** (R1) · invented 30 s / 60 s timing defaults where 30 s silently earned the *best* SM-2 grade (R2, R4) · "phantom minutes" crediting ≥1 s for skipped questions (R4) · an invented linear map labelled **"Official"** (R5) · sample data rendered as real results, and a **1290/1440 score from an 8-question quiz** (R6).

**Rules.**
- A number shown to a student or parent is either a real measurement or it is **visibly labelled as not one**. There is no third option.
- Never invent a fallback value for missing data. Use `null` and a `…Reliable: false` flag — the pattern already in `recordAttempt`/`gradeAttempt`. Then handle `null` conservatively (grade 3, not 5).
- Never call an estimate "Official", "Actual", or "Projected" unless it comes from a published, cited method.
- No score without a minimum sample. `MIN_PER_SECTION = 15` exists in `calculateScaledScore`; **any new scoring path must honour it too** (see mode 2).
- Empty state means empty: with `localStorage` cleared, no non-zero number may appear on any page.

### 2. Applying a rule in one place but not its twin — *rounds 2, 3, 4, 5, 6*

> Hero score gated, section badges not (R2) · parent required ≥3 attempts, student page didn't (R3) · two provisioners built different blob URLs (R4) · `question_type` fixed everywhere **except `parent.html`** (R5) · `MIN_PER_SECTION` in one scoring engine but not the other, and `toLeanReport` used for history but not the resume snapshot (R6).

**Rules.**
- Before fixing a rule in one file, `grep` the whole repo for the concept and fix **every** site in the same commit. State in your summary how many sites you found and changed.
- The student app and parent portal display the same metrics. Any threshold change must be applied to both, or extracted into `srs.js` and shared. Prefer extracting.
- Two functions doing the same job (scoring, URL building, payload trimming) is the bug. Call the existing one.

### 3. Writing code against an imagined schema — *rounds 1, 2, 4*

> `q.question_type` and `q.prompt` read on **0 of 3,059 records** — producing an 88-question exam advertised as 98 (R4) · `q.options['A']` indexed on an array, so every exam answer button showed placeholder text (R4) · free-response keys assumed single-valued when 72 hold several forms, and 2 are prose (`"either 8 or 9"`) (R1, R2).

**The real record shape** — confirm against the data, never from memory:

```
id, assessment, test, domain, skill, difficulty,
type ("multiple_choice" | "free_response"),   ← NOT question_type
question_text,                                 ← NOT prompt
options: [ {key:"A", text:"…"}, … ],           ← ARRAY, look up with .find(o => o.key === letter)
correct_answer, rationale, has_image, question_image,
text_complete, rationale_letter_mismatch
```

**Rule.** Before using any field, verify it exists:

```bash
python3 -c "import json; d=json.load(open('data/ela_questions.json'))+json.load(open('data/math_questions.json')); \
f='FIELD'; print(f, sum(1 for q in d if f in q), 'of', len(d))"
```

Zero is a schema error, not a fallback opportunity. Note that `data/*.json` and `data/questions_data.js` must never drift — run `python3 rebuild_bundle.py` after any data change.

### 4. Writing a test that cannot fail — *rounds 1, 2, 3, 4, 5*

> Tests required gitignored PDFs, so "9/9 passing" meant nothing on a clean clone (R1) · the free-response dataset test split keys on commas **exactly as the grader did**, so it compared the implementation to itself and passed on the broken prose keys (R2) · a streak test monkeypatched an exported property while the code called the internal closure — a no-op that passed only because its fixture dates were in the future (R3) · no test ever generated an exam from the real bundle (R4, R5).

**Rules.**
- A test must not reuse the parser, splitter, or helper it is testing to build its own expectations. Write expected values **by hand**.
- Before committing a test, **break the code on purpose and watch it fail.** A test never seen red is not evidence.
- Never inject time, randomness, or dates by patching module exports — pass them as parameters (`calculateStreak(map, todayKey)` is the established pattern).
- Tests must run on a clean clone. PDF-dependent tests use `@unittest.skipUnless`.
- New generation/filtering logic needs a test that runs it against `data/questions_data.js` and asserts real counts.

### 5. Swallowing failures — *rounds 1, 5, 6*

> The validator reported **100% valid** while hiding 900 placeholder-option questions (R1) · `safeSetStorage` caught `QuotaExceededError`, logged to console, and returned normally — so exam history silently killed *all* progress saving while the UI confirmed success (R5) · the boolean return added to fix that is still ignored at all six call sites (R6).

**Rules.**
- `catch` must either recover or report. Logging to console and returning as if nothing happened is data loss with a clean UI.
- If a function returns a success flag, **check it at every call site.** Adding the mechanism without wiring it up fixes nothing.
- A storage write that fails must produce a visible, non-blocking warning to the user.
- Metrics must separate "valid" from "complete". Report both numbers, never one that flatters.

### 6. Applying a fix imprecisely, or re-creating one you just fixed — *rounds 5, 6*

> A round-4 fix added the right argument **one position early**, landing `timingReliable` in the `dateStr` slot and filing sessions under the literal key `"true"` (R5) · a fix applied to every site but one (R5) · payload bloat fixed in exam history, then **re-created one commit later** in the resume snapshot at 193 KB (R6) · a return value added but never checked (R6).

**Rules.**
- When adding an argument, re-read the signature and count positions. Prefer an options object for anything past three parameters.
- After fixing a defect, `grep` for the *pattern*, not the symptom — if you just removed a 200 KB payload from storage, check every other thing being stored.
- Re-read the review item after implementing it and confirm each clause is satisfied, not just the headline.
- Verify the fix by executing the failing case, not by re-reading the diff.

### 7. Destructive actions without a guard — *rounds 1, 6*

> Blob container created world-readable for copyrighted material (R1) · "Load Sample Data" overwriting four `localStorage` keys wholesale — destroying all real progress, with a confirm saying "populate" and an immediate `location.reload()` (R6) · quota recovery silently pruning completed exam reports (R6).

**Rules.**
- Any action that overwrites or deletes user data must: back up first, say plainly in the confirm text what will be **erased** (not "populated"), and offer a restore path.
- Demo/test conveniences never write to production keys unguarded. Gate behind `?demo=1`, mark the records (`isSample: true`), and show a persistent banner while they are live.
- **A fallback path may never be more destructive than the primary path.** When the safe operation is unavailable, do nothing and report it — never "clean up". (Round 8: a restore fallback deleted the only backup when the engine failed to load.)
- Default to private/least-privilege for anything cloud-facing. Credentials come from env vars, never `argv`.

---

## Before you commit

```bash
python3 -m unittest test_extractor.py -v          # 7 pass + 2 skip without PDFs
node tests/test_free_response.js && node tests/test_srs.js && node tests/test_dataset_free_response.js
python3 rebuild_bundle.py && git diff --stat data/questions_data.js   # expect no drift
python3 -c "import json; from validator import validate_dataset; \
  q=json.load(open('data/ela_questions.json'))+json.load(open('data/math_questions.json')); \
  r=validate_dataset(q); print(r['valid_count'], r['invalid_count'], r['text_complete_count'])"
# expect: 3059 0 2158
```

Then confirm, honestly:

1. Did I **run** the changed path against real data and see real output? (mode 0)
2. Is every number I display a measurement, or labelled as not one? (mode 1)
3. Did I grep for every other site of this rule and fix them all? (mode 2)
4. Did I verify each data field exists in the dataset? (mode 3)
5. Did I watch my new test fail before making it pass? (mode 4)
6. Does every `catch` recover or report, and is every returned flag checked? (mode 5)
7. Did I re-read the original request and satisfy every clause? (mode 6)
8. Can this destroy user data, and if so what is the backup and the warning? (mode 7)

**Report what you actually verified, with numbers.** If you did not test something, say so plainly — an unflagged gap is how most of the defects above reached review.
