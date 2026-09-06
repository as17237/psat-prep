# WI-22 review plan — how this drop gets reviewed when it lands

Prepared 2026-09-06, before the incoming implementation is complete. Scope: the
work described in `docs/PRODUCT_REVIEW_AND_IMPLEMENTATION_PLAN.md` — Milestone 1
(EX-01..04, DATA-05), Milestone 2 (SRS-01..03), the DATA-02/DATA-01 server merge,
and Milestone 4A (parent focused-test builder).

The governing standard is `CLAUDE.md`. This is not a general code review: every
tier below exists because that exact class of defect has already shipped in this
repo, and the review's job is to catch it happening a seventh time.

**The one rule that decides most of this review:** I do not accept "tests pass"
or a clean-looking diff as evidence. I execute the real code path against the
real dataset and paste the real numbers. Every green suite in this repo's history
has at some point coexisted with a shipped data-loss bug.

---

## 0. Taking delivery

Before reading a single line:

1. **Freeze a reference point.** Record `git rev-parse HEAD`, `git status
   --porcelain`, and a full `git diff --stat`. If the work is uncommitted, ask for
   a commit or take my own snapshot copy first — I will not review a tree that is
   still being written underneath me, because a finding I cannot reproduce is
   worthless.
2. **Establish what "before" was.** The pre-existing baseline on branch
   `wi-22-lifecycle-integrity` was: node suites 10/11 passing, Playwright
   chromium-desktop **60 passed**. The single known-failing node suite was
   `test_explainer_links`, and it fails for an unrelated reason — the uncommitted
   rewrite of `explanations/area-and-volume.html` swapped its drill ids
   (`0a44345a`, `1d2c5e42` out; `26ba1380`, `75f5ed87` in) without
   `build_index.py` being re-run. **That failure is not part of this work and must
   not be "fixed" by regenerating the index**, which would certify a page whose
   figures nobody has verified.
3. **Confirm nothing sacred moved.** `explanations/area-and-volume.html` and
   `model-review-link` are the user's; they must appear untouched by this work.
4. **Confirm no production side effects.** `git log`, deploy scripts, and any
   `scripts/` invocation. Nothing in this work item is authorised to deploy, to
   run a migration, or to write to Cosmos. Evidence of a live write is a
   stop-the-review finding, not a note.

---

## 1. Tier 0 — does it actually run

Cheap, mechanical, and it gates everything else. Run all of it before reading code.

```bash
# Node engine + integrity suites
for t in tests/test_*.js; do printf "%-44s " "$t"; node "$t" >/dev/null 2>&1 && echo PASS || echo FAIL; done
node tests/integrity/test_merge_pins.js
node tests/integrity/test_merge_semantics.js
node tests/integrity/test_datamodel.js
node tests/integrity/test_shard_routing.js
node tests/integrity/test_doc_size_budget.js

# Python side
python3 -m unittest test_extractor.py -v            # expect 7 pass + 2 skip
python3 rebuild_bundle.py && git diff --stat data/questions_data.js   # expect NO drift
python3 -c "import json; from validator import validate_dataset; \
  q=json.load(open('data/ela_questions.json'))+json.load(open('data/math_questions.json')); \
  r=validate_dataset(q); print(r['valid_count'], r['invalid_count'], r['text_complete_count'])"
# expect exactly: 3059 0 2158

# Browser
./node_modules/.bin/playwright test --project=chromium-desktop --workers=2 --reporter=line
./node_modules/.bin/playwright test --project=chromium-mobile  --workers=2 --reporter=line
```

Pass condition: **at least 60 desktop e2e passing plus the new specs**, and no
node suite regressing from the baseline. A suite that got *removed* or *renamed*
counts as a regression until proven otherwise.

Mobile matters here: the review doc explicitly notes no mobile audit was done,
and the parent builder is new UI.

---

## 2. Tier 1 — data integrity (highest stakes, review first)

This is the tier I will spend the most time on, because it is the only one where
a mistake destroys a real child's year of work rather than annoying him.

### 2a. The server merge — `api/src/lib/merge.js`

The two defects and their measured baselines, which I captured myself at `HEAD`
before any change:

```
DATA-02 baseline: mergeSessions(stored 10 answers, incoming 0)
                  -> {"questionsAnswered":0,"correct":0,"totalTimeMs":0}   ← 10 answers erased
DATA-01 baseline: two devices off a shared base -> timesSeen 2   (true count 3)
```

I re-run both reproductions against the delivered code and paste the real output.
Specific checks:

- **DATA-02 must be genuinely closed.** A day present on both sides always takes
  the per-field maximum; an incoming zero can never subtract. A day only the
  incoming side knows about is still added.
- **DATA-01 must be claimed honestly.** Monotonic counters (never decrease) is
  the acceptable outcome here; "DATA-01 fixed" is not, because two independent
  branches off a shared base of 1 still merge to 2 without stable per-attempt
  identity. If the code or a comment claims the reproduction returns 3, I verify
  it — and if it does, I want to know what identity mechanism appeared, because
  that would be Milestone 3 arriving unannounced.
- **`timesSeen` must never be derived from the capped `attempts` array.** That
  array is `.slice(-3)` and lossy by design; deriving from it makes counters
  shrink. This is a specific thing to grep for.
- **Purity holds.** No clock, no network, no mutation of either argument. I test
  argument mutation directly rather than reading for it.
- **The pin tests were updated, not deleted.** `tests/integrity/test_merge_pins.js`
  pinned the destructive behaviour deliberately; the file header says changing it
  "must update the pin tests in the same commit". A rewritten pin with a comment
  explaining why the old one was wrong is correct. A *deleted* pin is a finding.
- **Twin sites (CLAUDE.md mode 2).** `js/engine/sync.js` holds client-side
  `mergeProgress` / `mergeSessionsState`. Server and client must now agree. I grep
  the whole repo for every merge implementation and check the count matches what
  the report claims.

**Known live hazard from the interrupted work:** an in-flight version of this
change broke `tests/test_storage_v2.js` at line 512 — *"a delta post must merge to
the SAME master document as a full post"* — because `accuracyPercent` was being
attached on one path and not the other. That equivalence is a real invariant of
the sharded sync path, not a test detail: two clients writing the same work must
converge on byte-identical documents, or the shard codec stores spurious `$v`
overrides and later snapshot diffs report phantom regressions. **I will run that
test specifically and, if it passes, confirm it passes for the right reason
rather than because the assertion was loosened.**

### 2b. Local storage writes

- Every `safeSetStorage` return value checked at every call site. Before this
  work the unchecked sites were: `js/pages/mistakes.js:529`, `js/pages/parent.js`
  (the replace branch, ~1374–1377), and `js/pages/student.js` at the exam-history
  write (~1981), the active-exam snapshot (~2235) and the error-tag write (~2499).
  I re-grep and expect zero unchecked sites, and I expect the report to state the
  count found and changed.
- A failed write must produce a **visible, non-blocking warning to the user**. A
  `console.error` and a normal return is the exact defect (mode 5) that once let
  exam history silently kill all progress saving while the UI confirmed success.
- **Payload size (mode 6).** This repo has shipped a 209 KB and then a 193 KB
  localStorage record, the second one *re-created a commit after the first was
  fixed*. I measure `JSON.stringify(...).length` for the active-exam snapshot on a
  real 98-question form and for anything new the builder persists. Anything that
  stores question objects rather than ids is a finding regardless of measured size.

### 2c. Destructive paths (mode 7)

For the parent import specifically, and for anything else that overwrites:

- Cancel must mean cancel. The old single `confirm()` where **Cancel = wipe and
  replace everything** is the headline defect; I will drive the real dialog, press
  Escape, and assert nothing changed.
- The Replace confirmation must state, in plain words, what will be **erased**,
  with real counts, and name the restore path. "Populate"/"replace" without an
  erasure count is the wording defect CLAUDE.md calls out by name.
- A backup must exist *before* the mutation, via the existing
  `runTransactionalAction` snapshot ring — not a second, new snapshot mechanism.
- **A fallback path may never be more destructive than the primary path.** I look
  specifically for cleanup/quota-recovery code that deletes on failure.
- Exam history must not be silently capped at 15 on import. If quota forces a cap,
  the parent is told exactly how many were not stored.

---

## 3. Tier 2 — each defect, verified by executing the failing case

Reading the diff does not count (mode 6: "verify the fix by executing the failing
case, not by re-reading the diff"). For each of the seven, I reproduce the
original failure scenario in a real browser and assert the corrected outcome.

| ID | The reproduction I will run | What must be true after |
|---|---|---|
| EX-01 | Start full exam, answer one question, pass the M1 deadline, reload, open Exam | `psat_active_exam_state` still holds the answers; a valid continuation is offered; **nothing deleted** |
| EX-02 | Finish an exam with `setItem` throwing only for `psat_exam_history` | A recoverable copy of the report survives; a **visible** warning appears; retry saves exactly once, not twice |
| EX-03 | Reload mid-module, resume; then pass the deadline and click a review question | Timer shows real remaining time and counts down; post-expiry editing is refused at the *handler*, not just hidden in the UI |
| EX-04 | Submit RW M2, enter break, reload, resume | Resumes **in the break** with correct remaining time; submitted module cannot reopen |
| SRS-01 | Seed a previously answered MC question **plus** its overdue card; open due review | Prior answer and rationale hidden; a click records a genuinely new attempt; the card actually moves |
| SRS-02 | Same for SPR; click Submit twice | Input enabled and empty; Submit disabled after grading; `timesSeen` increases by exactly **1** — the reported bug was 1 → 3 |
| SRS-03 | One genuine review attempt on a real seeded profile | New attempt identity; review count +1 exactly; **the original miss and its history still present**; due date moved |

The last clause of SRS-03 is the one I care most about: the tempting way to make
the review UI work is to set the old record back to `answered: false`, which is a
data-destroying "fix". I will diff the stored `psat_progress` entry before and
after and confirm history was *appended*, never rewritten.

For EX-03 I check the guard is enforced where the answer is written, not only
where the button is drawn. A disabled button with a live handler underneath is
still the bug.

---

## 4. Tier 3 — the test-quality audit (mode 4)

This repo has shipped a test that could not fail five separate times. This tier
is non-negotiable and I do it *before* trusting any green result above.

1. **`git diff` every pre-existing test file.** Any modification to a test that
   already existed gets read line by line and justified. As of now
   `tests/test_srs.js` and `tests/integrity/test_merge_pins.js` are both modified.
   A weakened assertion, a loosened tolerance, a deleted case, or a `skip` is a
   finding until proven to be a deliberate, explained contract change.
2. **Demand red-run evidence.** For each new test I want the mutation that was
   applied to the source and the exact failing output it produced. A test never
   seen red is not evidence. Where that evidence is missing, I will mutate the
   source myself and confirm the test fails — and if it does not, that test is
   decoration.
3. **Check for self-referential expectations.** A test must not build its expected
   value using the parser/helper it is testing. This repo once compared the
   free-response splitter to itself and passed on genuinely broken data.
4. **Check the known blind spots were actually closed.**
   `tests/e2e/srs_progression.spec.js` empties `psat_progress` before testing a
   mature card, and `srs-review-queue.spec.js` asserts a badge that can already be
   present before the click. If those files are unchanged and the new specs seed
   realistic progress + card *together*, good. If the new specs repeat the same
   evasion, the SRS work is unverified no matter how green it looks.
5. **Real-dataset coverage.** Any new generation/filtering/selection logic needs a
   test that runs against `data/questions_data.js` and asserts real counts, not
   only hand-written fixtures. This is explicit in CLAUDE.md.
6. **No time/randomness injected by patching module exports.** The established
   pattern is passing them as parameters. A monkeypatched export once produced a
   test that was a silent no-op.

---

## 5. Tier 4 — the invented-number audit (mode 1)

The most persistent defect in this project's history, and the parent builder's
time estimates are exactly the shape it takes.

- Every number rendered to the student or parent is either a real measurement or
  **visibly labelled as not one**. I will read the rendered strings, not the
  variables.
- Time estimates must carry their basis and whether they are measured. A planning
  assumption presented in the same typography as a measured average is the defect.
- No fallback default for missing data — `null` plus a `...Reliable: false` flag,
  handled conservatively (grade 3, not 5). The 30 s/60 s timing defaults that
  silently earned the *best* SM-2 grade shipped twice.
- No estimate labelled "Official", "Actual", or "Projected" without a cited
  published method.
- `MIN_PER_SECTION = 15` honoured by **every** scoring path, including any new
  one. A short focused test must not produce a composite PSAT score or enter
  full-exam trends.
- **Empty-state test:** clear `localStorage` entirely and load every page. No
  non-zero number may appear anywhere. This one check has caught this class of
  defect repeatedly and takes two minutes.

---

## 6. Tier 5 — consistency and schema

- **Twin sites (mode 2).** For every rule changed, grep the whole repo for the
  concept and confirm every site changed together. The student app and parent
  portal display the same metrics; a threshold changed in one must change in both,
  or be extracted into the engine and shared. I expect the report to state how
  many sites were found and changed — a fix applied to "every site but one" is a
  documented past failure here.
- **Schema reality (mode 3).** Any newly referenced field gets verified to exist
  in the dataset before I accept it:
  ```bash
  python3 -c "import json; d=json.load(open('data/ela_questions.json'))+json.load(open('data/math_questions.json')); \
    f='FIELD'; print(f, sum(1 for q in d if f in q), 'of', len(d))"
  ```
  Zero is a schema error, not a fallback opportunity. Watch specifically for
  `question_type` (does not exist — the field is `type`) and `prompt` (does not
  exist — it is `question_text`), and for `options` being indexed as a map when it
  is an **array** of `{key, text}`.
- **Skill labels contain commas** ("Lines, angles, and triangles"). Any share-link
  or URL encoding that comma-splits skills is broken for real data — I will test
  that specific label round-trips.
- **Engine/page separation.** New logic belongs in `js/engine/*`, not in a page.
  A decision function that reads the DOM cannot be tested and will drift.
- **Facade discipline.** Every new engine part registered in `srs.js`'s
  `API_MANIFEST`, in `tests/test_engine_api_surface.js`'s independent hand-written
  copy, and in the `<script>` tags of every page that needs it — with the load
  order respected. A missing page tag yields a page that renders and then silently
  does nothing.

---

## 7. Specific hazards in this particular drop

Things I already know to look at, from the state of the tree:

- **Files changed that no plan of mine authorised**, so I have no prior context
  for them and will read them closely: `js/engine/scoring.js`, `js/engine/sync.js`,
  `js/shared/storage.js`, `mistakes.html`, `sw.js`, `tests/test_srs.js`.
- **`sw.js` changed.** The service worker is root-scoped and caches the app. A
  caching mistake ships a stale app to a real user and is invisible locally. I
  check cache-name/versioning and that a changed asset actually invalidates.
- **New modules with no obvious test file:** `js/engine/persistence.js`,
  `js/engine/gap_summary.js`, `js/shared/import_dialog.js`,
  `js/shared/focused_builder.js`. Untested new logic in the storage path is the
  highest-risk shape in this repo.
- **`js/engine/persistence.js` specifically** — a new abstraction over saving is
  exactly where a swallowed failure hides. Every path through it gets the mode-5
  treatment.
- **`tests/e2e/exam_lifecycle.spec.js` is absent** while `srs_attempt.spec.js`
  exists. If the four EX defects have no browser regression test, they are
  unverified — the review doc reproduced all four in a real browser, so there is
  no excuse for asserting them only at unit level.
- **`js/pages/student.js` is +389 lines.** It was already 2,717 lines. I check
  whether logic landed in the page that belongs in the engine.
- **`styles/builder.css` is new.** Check it against the existing design system
  rather than introducing a parallel one, and check the palette matches the app
  (warm ivory / charcoal / terracotta, not a new scheme).

### State I left behind, for whoever reads this next

I completed and verified two engine parts before stopping, both green:

- `js/engine/exam_state.js` + `tests/test_exam_state.js` — 31 checks passing;
  measured snapshot size for a real 98-question form **6,967 bytes** against a
  20 KB bound.
- `js/engine/attempt.js` + `tests/test_attempt.js` — 31 checks passing; the
  SRS-02 reproduction prints guarded `timesSeen 1 → 2` beside unguarded `1 → 3`.

Both were wired into the `srs.js` facade and the api-surface contract, which now
pins **97 symbols** and passes. Those two modules and their tests carry their own
red-run evidence, which I have; they still get the Tier 3 treatment, but from a
known starting point.

---

## 8. Gate conditions

I will not sign this off while any of these is true:

1. A test that previously existed was weakened or deleted without an explicit,
   justified reason.
2. Any of the seven defects is claimed fixed but I cannot reproduce the fix by
   executing the original failing scenario.
3. `tests/test_storage_v2.js` passes only because its assertion changed.
4. Any number shown to the student or parent is an estimate not labelled as one.
5. Any `catch` that neither recovers nor reports, or any returned success flag
   that is ignored at a call site.
6. A destructive path without a backup taken first and an erasure count in its
   confirmation text.
7. Evidence of a production write, deploy, or Cosmos mutation during development.
8. `python3 rebuild_bundle.py` produces drift in `data/questions_data.js`.

## 9. What I hand back

A findings list ordered by severity, each with: the file and line, a concrete
failure scenario (inputs → wrong output), and whether I **confirmed** it by
execution or consider it **plausible** from reading. Plus the real output of every
gate command, the measured numbers, and an explicit list of what I did **not**
verify — an unflagged gap is how most of this project's defects reached review.

Before merge, two repository gates still apply and I will run them and cite their
output lines: `./scripts/preflight_backup.sh` (required for anything touching
`api/`, storage, sync or deploy — cite `PREFLIGHT_BACKUP_OK <filename>`) and
`./scripts/weekly_restore_check.sh` (cite `WEEKLY_RESTORE_CHECK_OK <baseline>`).
Both talk to production and need an authenticated `az` session, so they are the
last step, not part of the review pass.
