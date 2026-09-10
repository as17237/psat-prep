# PSAT 8/9 product review and implementation handoff

Reviewed September 5–6, 2026. Repository HEAD: `632fbe1`.

## Start here next session

> **STATUS AS OF 2026-09-07 — the paragraph below is superseded. Read this first.**
>
> The work described here has been reviewed, committed, merged and **deployed to
> production**. `aed2e7e` (client → `$web`) and the Azure Function separately;
> promotion log `6c7ee09`. DATA-02 was verified fixed against the live server.
>
> **DONE and live:** EX-01..04 exam recovery · SRS-01..03 genuine repeat review ·
> DATA-05 safe import (explicit Merge / Replace / Cancel) · exam history no longer
> truncated to 15 · Milestone 4A parent focused-test builder · DATA-02 zero-answer
> day erasure · DATA-01 made monotonic — **not closed**, it still yields 2 where
> the truth is 3; the real fix is Milestone 3.
>
> **NOT done, still outstanding:** Milestone 3 exact concurrent-device sync
> (durable append-only events with stable ids) · Milestone 4 exam blueprint and
> score calibration · Milestone 5 conceptual-learning workflows · remaining mobile
> layout cleanup · **the 46 exam-skipped questions that leave no record anywhere**
> (audited 2026-09-07: true "seen" is 909; the portal's 863 is a correct count of
> *attempted*, which is what its label says).
>
> **Do not mark the broader roadmap complete.** Those are separate implementation
> scope, not regressions.

Implementation continued September 6 after Claude's partial work, with the user's authorization. *(Superseded: at the time this was written nothing had been committed, merged or deployed. It has since been.)* Read the checkpoint below before using the original audit/roadmap that follows; those findings describe the earlier code, not a claim that every defect is still present.

The overriding requirement remains preservation of student data. Read `CLAUDE.md`, `README.md`, and `docs/DISASTER_RECOVERY_RUNBOOK.md`. The repository requires the live backup preflight immediately before merge for storage/API changes. *(Superseded: it has since been run twice and passed — `PREFLIGHT_BACKUP_OK cosmos_backup_2026-09-07T02-44-38-509Z.json` before the client promotion and `...T05-27-27-868Z.json` before the API change, 11/11 live integrity checks each. A `$web` rollback manifest exists at `refactor-baseline/pre_cutover_20260907T024509Z/manifest.json` and the pre-WI-22 API package at `function-releases/pre_wi22_20260907T025329Z_632fbe1.zip`.)* Run the required restore drill at the appropriate refactor phase boundary. Neither live backup health nor infrastructure access controls have been verified here.

Pre-existing `explanations/area-and-volume.html` edits and the `model-review-link` symlink were left untouched. Before continuation, modified/untracked regular files were copied to `/private/tmp/psat-before-continuation-20260906`; this temporary source checkpoint is not a backup of live student data.

### September 6 implementation checkpoint

| Area | Current working-tree behavior |
| --- | --- |
| Parent builder (Milestone 4A) | **Parent portal → Exam Builder → Practice Drill → Build a focused test.** Subjects, selectable domains and nested skills, 1–100 questions, 10/20-question shortcuts, available minutes with review reservation, timed/untimed mode, optional format/difficulty/selection preference. Preview precedes launch; insufficient pools need explicit smaller-set acceptance; incompatible filters do not widen silently. |
| Gap guidance | Domain and skill cards show wrong/answered counts, latest-answer accuracy, last practice, sparse/older evidence, repeated misses and explicitly recorded concept-gap tags. Suggested skills can be selected together. Recent 14 days/all-time views use retained progress evidence without double-counting exam reports. Historical miss evidence is retained separately from the latest correct retry. |
| Handoff and reporting | Versioned JSON setup links preserve skill names containing commas and contain no student history. Parent launch transfers question IDs and plan metadata through lane-prefixed session storage. The active snapshot, local report and completion outbox retain that plan. Focused reports display raw performance, with no scaled PSAT score. Existing unfinished work blocks another launch. |
| SRS (SRS-01/02/03) | A previously answered due question opens with the old answer hidden and accepts one new MC/SPR submission. Progress retains attempt identity and reliable-timing flag. Repeat submit is guarded; SM-2/session increments occur once. Browser attempts get a stable per-attempt UUID suffix. |
| Exam lifecycle (EX-01/03/04) | Expired snapshots remain available; resumed countdown derives from the saved absolute deadline. Expired/submitted modules reject edits. Break deadline/phase and submitted module indices persist across reloads. Missing saved bank IDs fail visibly while retaining the snapshot. |
| Completion recovery (EX-02) | Full lean pending report remains in the active snapshot until checked multi-key persistence succeeds. Per-exam/question identity prevents grading a retry twice. A durable journal replays the same target values and clears only after all writes succeed. |
| Storage failures | Failed writes block further answers and sync. Retry and recovery-download controls preserve pending in-memory values even if the journal itself cannot fit. Recovery downloads include raw stored data plus pending targets; they are support recovery files, not standard profile imports. Startup attempts journal recovery before reading/migrating state. |
| Imports (DATA-05) | Validate → preview → explicit Merge/Replace/Cancel. Invalid or partially rejected files make no profile change. Replace explains local erasure and requires confirmation. A successful client snapshot is mandatory before apply. A changed profile invalidates a stale preview. Existing saved exams block imports. |
| Retention and merge mitigation | Local sync pulls retain all merged reports instead of truncating to 15 (both normal and beta-seed paths). The outbox no longer drops unsynced items at 500. Client/server attempt unions prefer attempt IDs over timestamp identity; historical tags and flags survive merges. Server counters cannot decrease; zero incoming sessions cannot erase stored activity. |
| Browser loading/offline shell | All three engine-consuming root pages load the new required parts before `srs.js`. New assets are in the versioned service-worker shell. A separate local-only Playwright config excludes production smoke and service-worker offline specs. |

### Remaining work and limits — do not mark the entire roadmap complete

1. **Milestone 3 / DATA-01,03,04 remain open.** Independent device counters are monotonic maxima, not exact event accounting: the concrete shared-base example can still merge to 2 instead of the true 3. Counters can disagree with correct+incorrect totals. There is no new server event ledger, ETag transaction/retry implementation, or cross-tab serialization. The three-entry attempt tail and bounded SRS tail remain; do not claim full event history or guaranteed concurrent durability. In-flight/failed local saves are guarded, but broader concurrent merges need their own design and tests.
2. **Milestone 4 exam fidelity remains open.** Full-test routing was checked, not calibrated against Bluebook. Existing Math weights, hand-tuned score curves/confidence language, cross-subject mini routing and simulator claims still need correction using the cited official specifications. Focused reports now avoid scaled-score claims. Existing automatic gap-drill presets still have legacy fallback semantics; the new focused builder uses the strict planner.
3. **Milestone 5 conceptual learning remains a future feature set.** Current gap cards honestly use latest stored answers and limited retained history. They do not infer first-attempt mastery, distinguish every assisted/guessed answer, prove transfer to unseen problems, or establish retention across days. The guided explanation/transfer/retest loop below is still the recommended product work.
4. Existing cloud reset/restore identity and access-control questions remain. Recovery downloads intentionally need recovery assistance; normal import does not apply their raw journal. Browser storage remains quota-limited; no completed reports or pending operations are automatically pruned to make room.
5. Exam snapshots preserve the compatible existing shape with lifecycle fields; Claude's pure `exam_state.js` helpers are not a wholesale replacement of the runner. Untimed focused tests are not official accommodations. Real device sleep/background timing and a fresh service-worker offline journey have not been certified in this continuation. Mobile screenshots show the older portal header and automatic-drill action row still overflow horizontally outside the new builder; the card-width test does not certify the entire portal layout. Keep that responsive-layout cleanup on the UX backlog.

### Continuation verification

- Real bank: **3,059 questions, 3,059 unique IDs; both source JSON files match the browser bundle exactly.** No dataset files were regenerated or edited.
- Strict Craft and Structure plans returned **3, 7, 13 and 25** questions as requested. The browser launch returned **7**, all in that domain. With explicit 120-second assumptions, **15 available minutes minus 3 review minutes selected 6 questions and a 12-minute timer**. Assumptions are labeled in the preview.
- **25 local Node suites passed**, covering planner/gaps, attempt/exam helpers, API loading, adaptive configuration/routing, SM-2, storage/sync, backup/restore, scoring, real free-response data, offline pin logic, HTML/UI contracts and server merge/model integrity.
- Python extractor tests: **7 passed, 2 skipped** (PDF-dependent). `git diff --check` passed. A separately run `test_explainer_links.js` still fails for the pre-existing area/volume anchor mismatch (`q-0a44345a`); the page is byte-identical to the pre-continuation checkpoint. Do not regenerate its index as part of this work.
- A broader browser run passed **80/82**. Both failures were an existing test clicking the intentionally desktop-only numbered palette on mobile. The test now uses the visible Review button; the subsequent **26/26** desktop/mobile adaptive + focused-builder + SRS checks passed. Other passing checks include old-crash recovery, standard practice, parent analytics, schema migration/rollback and offline outbox retry.
- Focused browser tests inject a failed report write and a failed initial journal write, recover one saved report/answer with no double increment, verify expired/break resume, reject unknown-domain links, exercise real import Cancel and preserve **21 existing reports plus 1 imported report**. A mock cloud pull preserves all **120** reports, including the oldest.
- A further **4/4** desktop/mobile handoff checks passed: the real **34-question** skill pool requires explicit acceptance of a request for 100, beta launch leaves a production sentinel unchanged, topic cards fit the viewport, and an unfinished test blocks replacement. Builder screenshots were inspected; button sizes were aligned with the existing design system.
- Local browser fixtures intercept student API requests. There were no live student-data writes, live migrations, production smoke runs, resets, production restores, or deployment. Several runner-answer clicks use the existing harness's forced-click convention; these checks establish state transitions, not complete touch usability of the older exam layout. The new import Cancel and builder controls were exercised with ordinary clicks.

Reproduce the targeted browser gate safely from this repository:

```sh
./node_modules/.bin/playwright test --config=playwright.local.config.js tests/e2e/adaptive.spec.js tests/e2e/focused-builder.spec.js tests/e2e/focused-handoff.spec.js tests/e2e/srs_attempt.spec.js --workers=1
node tests/test_focused_builder.js
node tests/test_attempt.js
node tests/test_exam_state.js
node tests/test_srs.js
node tests/test_storage_v2.js
node tests/integrity/test_merge_semantics.js
```

The rest of this document preserves the original audit, evidence and acceptance criteria for work still outstanding.

## Assessment

The app has a useful foundation: official question-card images, answer rationales, free-response grading, adaptive module generation, SRS scheduling, error tags, targeted drills, post-exam recovery plans, math tools, explanations, and parent analytics. The engine/page separation supports incremental fixes.

The biggest product opportunity is to connect these tools into **attempt → diagnose → understand → solve a new related question → retain later**, while keeping the original evidence intact. Current dashboard improvement can reflect familiarity with an answer rather than independent conceptual understanding.

### Dataset checks

Read-only checks against the actual bank found:

| Check | Result |
| --- | --- |
| Questions / unique IDs | 3,059 / 3,059 |
| JSON sources equal browser bundle | Yes |
| Reading and Writing / Math | 1,554 / 1,505 |
| Multiple-choice / free-response | 2,694 / 365 |
| Difficulty | 1,846 Hard; 937 Medium; 276 Easy |
| Missing referenced question-card files | 0 |
| Missing rationales | 0 |
| Text-incomplete records | 901; image cards remain essential |
| Rationale-letter mismatch flags | 2; flags are not a new answer-key audit |
| Indexed explanation coverage | 71 question IDs, 11 pages; 3 page URLs external |

All records say `assessment: PSAT 8/9`; that metadata alone is not a content-level scope verification. Do not regenerate the bank or re-extract PDFs as part of reliability work.

## Adaptive test validation

**Verdict: the full test's route-selection mechanism works in the tested cases. Exam recovery, content balancing, and score interpretation do not yet justify calling the overall experience a faithful official simulator.**

### Verified functioning behavior

- Full exam has RW modules of 27 questions / 32 minutes each and Math modules of 22 questions / 35 minutes each: 98 questions, 134 working minutes, plus a configured 10-minute section break.
- Actual browser submission routes RW from RW M1 and Math from Math M1 independently.
- Configured threshold is `0.58`: RW 15/27 → Easy, 16/27 → Hard; Math 12/22 → Easy, 13/22 → Hard. This is an app modeling choice, not a verified College Board cutoff.
- Existing browser tests passed Hard/Hard and Easy/Easy routes through final reports.
- Additional browser tests passed Easy/Hard (RW 15, Math 13 correct) and Hard/Easy (RW 16, Math 12 correct). Tests answered real question controls, including SPR where encountered, and asserted the exact selected M2 IDs equal the pre-generated route pool. Final reports preserved both route labels and expected attempted counts.
- Generated 100 random full forms from the real bank and examined all four route combinations per form: **400 combinations, zero count/type/duplicate failures**. Every tested route contained 98 distinct IDs; each Math module contained five SPR questions. This is empirical coverage, not a proof over every random form or reduced pool.

Key files: `js/engine/adaptive_config.js`, `js/engine/examgen.js` (`_assembleModuleByBlueprint`, `generateStandardPSAT89Exam`), `js/pages/student.js` (`submitCurrentExamModule`), `js/engine/scoring.js`.

### Exam fidelity gaps

| Finding | Evidence and implication | Recommended change |
| --- | --- | --- |
| Math weighting differs from PSAT 8/9 | Generated modules contain Algebra 8, Advanced Math 6, PSDA 5, Geometry 3: 36.4%, 27.3%, 22.7%, 13.6%. College Board specifies approximately 42.5%, 20%, 25%, 12.5%. | Adopt a documented section-level integer allocation with justified rounding. Inspect the treatment of pretest items before choosing exact counts. |
| Math targets duplicated | `adaptive_config.js` has domain targets; `examgen.js` independently hardcodes MCQ targets 6/5/4/2 and SPR targets 2/1/1/1. Changing config alone will not repair generation. | One versioned blueprint consumed by all generators and checked against generated output. |
| Baseline difficulty is not controlled | In 100 sampled forms, RW M1 was 62.9% Hard, Math M1 59.5% Hard. Selection inherits bank composition. Hard RW M2 was 65.2% Hard, Math 67.6%, so the upward step was modest in this sample. | Explicit pedagogical difficulty mixtures per route; label them approximations unless calibrated. Keep challenge drills distinct from benchmark forms. |
| Route pools restrict difficulty | In the sample, Hard M2 had zero Easy questions; Easy M2 had zero Hard questions. Real second modules contain mixed difficulty. | Specify deliberate mixtures and test them, with an explicit insufficient-pool policy. |
| Mini exam crosses sections | `submitCurrentExamModule` uses 3/4 RW correct to choose the mini exam's Math difficulty. Source-confirmed; not a faithful section-adaptive design. | Prefer a clearly labeled nonadaptive mixed mini drill, or a short two-stage drill within one subject. |
| Short bank silently produces short exam | Passing ten bank records generated ten actual questions while advertising 98. This is an isolated reduced-input reproduction, not the current full-bank result. | Validate the assembled form and fail visibly before starting an invalid full exam. |
| Score output is not calibrated | Unvalidated 0.58 routing cutoff, power curves and Easy cap 580; Wilson accuracy intervals are displayed as a 90% score confidence interval. All questions are scored, unlike official unscored pretest items. | Call it an uncalibrated practice estimate, emphasize raw performance, and use official Bluebook results for benchmarks. Do not imply a validated prediction interval. |
| Potential scope/ordering differences | Bank has 34 records under “Right triangles and trigonometry”; PSAT 8/9 excludes trigonometry. Modules are shuffled. | Review actual question content before changing eligibility; preserve IDs and original records. Check official question ordering and RW domain guidance separately. |

Official facts checked September 6, 2026:

- [College Board PSAT 8/9 structure](https://satsuite.collegeboard.org/in-school-assessments/whats-on-the-test/psat-8-9/structure): section totals and working time.
- [College Board adaptive testing/scoring](https://satsuite.collegeboard.org/scores/what-scores-mean/how-scores-calculated): separate section stages, mixed difficulty, two unscored pretest items per module, performance across both modules.
- [College Board Math specifications, Table 3](https://satsuite.collegeboard.org/k12-educators/about/alignment/math): PSAT 8/9 domain percentages and scope; distinguish these from SAT and PSAT/NMSQT tables on the same page.
- [PSAT 8/9 Reading and Writing](https://satsuite.collegeboard.org/in-school-assessments/whats-on-the-test/psat-8-9/reading): content-domain reference for the implementation alignment pass.

### Original audit: confirmed exam lifecycle defects

All four cases below were reproduced in a real isolated Chromium browser, with controlled time or an injected storage error. They are not hypothetical code-review warnings.

| ID / priority | Reproduction and observed outcome | Source |
| --- | --- | --- |
| EX-01 / P0 | Start full exam, answer one question, advance past M1 deadline, reload, open Exam. `psat_active_exam_state` becomes null: saved unfinished answers are deleted, not recovered. | `checkActiveExamResume`, around student.js:2244 |
| EX-02 / P0 | Complete full exam while `Storage.prototype.setItem` throws only for `psat_exam_history`. Report renders, history has no report, active snapshot is cleared. The outbox contains only summary fields for exam completion, not the full recoverable report. | `finishExamAndShowReport`, around student.js:1934 |
| EX-03 / P1 | Reload mid-module before deadline, resume: timer reads `00:00` and remains unchanged. Advance beyond deadline; review opens, but clicking a review question permits editing and saving a new answer. | `resumeActiveExamState` does not recompute timer seconds or set `examModuleExpired` on expiry; answer handlers lack their own deadline guard |
| EX-04 / P1 | Submit RW M2, enter break, reload, resume. Already-submitted RW M2 reopens as editable. Snapshot has module index 1, no break phase/deadline or submitted-module state. | `startBreakTimer`, `persistActiveExamState`, `resumeActiveExamState` |

Related source findings: fresh-module expiry waits at a confirmation/review screen instead of automatically advancing; the break counts interval callbacks rather than a persisted wall-clock deadline. Snapshots omit `blueprintVersion` and `isHighYield`; report rehydration can consequently lose provenance. Missing question rehydration also clears the active snapshot. These need regression coverage during the lifecycle fix.

## SRS validation

**Verdict: scheduler arithmetic works for the covered inputs; the normal repeat-review experience is broken. Preserve the existing scheduler initially and fix the attempt/session boundary.**

### What works

- Covered grading: incorrect → 1; correct under 45 seconds → 5; 45–90 seconds → 4; slower or unreliable timing → 3.
- The implemented SM-2-derived ladder advances 1 → 3 → 7 days, then multiplies by updated ease; a lapse resets repetitions to 0 and interval to 1 day. This is the app's variant, not evidence of learning-outcome calibration.
- Browser tests with injected clocks verified fresh grade 5 → 1 day / EF 2.6; mature 7-day card with EF 2.6 and grade 5 → 19 days / EF 2.7; mature wrong answer with EF 2.7 → 1 day / EF 2.16.
- Unit coverage passed bounded 20-event SRS history, summary counters, migration/rollback, missing timing, and scheduling checks. Due filters identify the seeded cards.

### Original audit: confirmed SRS defects and test blind spots

| ID / priority | Reproduction and outcome | Required behavior |
| --- | --- | --- |
| SRS-01 / P1 | Seed a previously answered MC question plus its overdue card. Open due review. Correct answer and rationale are visible; clicking a choice does not change the SRS card. Confirmed in browser and direct rendering execution. | A fresh review attempt hides prior answers, starts timing, accepts a response and records a new event without deleting prior history. |
| SRS-02 / P1 | Seed a previously answered SPR question plus overdue card. Input is disabled and contains the old answer, but Submit is active. Two clicks increased `timesSeen` from 1 to 3; first click increased total reviews from 1 to 2. | Exactly one submission per attempt; input enabled for a new attempt, submit disabled after grading. No resubmission of a frozen old answer. |
| SRS-03 / P1 | `srs_progression.spec.js` explicitly empties progress before testing a mature SRS card. `srs-review-queue.spec.js` asserts “Correct!” and a non-new-card badge that can already exist before the click. All existing browser tests passed despite SRS-01. | Seed realistic progress + SRS together; assert a new attempt ID, exact counter delta, new last-review time, due-date movement and removal from the completed queue. |

Relevant code: `loadQuestion`, `recordAttempt`, `submitFreeResponse`, `startSrsReview`, `applyFilters` in `js/pages/student.js`; `gradeAttempt` in `js/engine/grading.js`; `scheduleNext` in `js/engine/scheduler.js`.

Product improvements after the correctness repair:

- Separate recall/understanding from speed: a slow correct algebra solution should produce a pacing recommendation without suggesting a conceptual failure. Current time thresholds apply to every subject and question alike.
- Distinguish an independent answer, guess, assisted answer, immediate retry, and delayed retrieval. Never retroactively label old records with evidence that was not collected.
- Choose due-date semantics explicitly: current scheduling uses exact 24-hour intervals and `dueAt <= now`, whereas “due today” can imply calendar-day scheduling.
- Make a bounded daily review session with reasons, sensible ordering, completion feedback and an option to continue. Currently filtering follows bank order.
- Measure skill retention across different questions/days; a card's familiarity is not concept mastery.

## Data-integrity findings carried forward

These came from the preceding review and remain relevant to every implementation milestone.

| ID | Evidence | Work needed |
| --- | --- | --- |
| DATA-01 | Real `api/src/lib/merge.js` reproduction: shared base attempt plus two independent same-question device attempts retains counter 2 instead of actual 3. Whole-entry timestamp replacement loses one branch. | Stable immutable attempt IDs, durable event ingestion, deduplication and aggregate derivation; preserve legacy evidence. |
| DATA-02 | Real server merge reproduction: a stored day with ten answers is replaced by an incoming day with zero answers. Max merging also cannot add independent same-day device work correctly. | Correct zero semantics immediately; derive totals from durable unique events for new data. |
| DATA-03 | API reads a partition, plans updates, then upserts shards/master without visible ETag conflict handling or a transaction. | Test overlapping writes; use conditional writes/retry and appropriate transactional boundaries. This is a source-confirmed risk, not a live concurrency reproduction. |
| DATA-04 | Server acknowledges `outboxOps` IDs but does not persist/replay each operation as its own event. Local queue drops oldest beyond 500; progress retains three detailed attempts. | Durable local operations, server-side event persistence, acknowledgement only after durability. No silent pruning of unsynced records. |
| DATA-05 | Parent import uses Cancel to mean Replace. Validation is shallow, replacement ignores write failure flags, and merge caps exam history at 15. | Explicit Merge / Replace / Cancel UI, schema validation + preview, verified recovery snapshot, transactional checked writes, lossless handling of imported exams. |
| DATA-06 | Local reset is followed by non-destructive cloud merging; reset/restore semantics can conflict with cloud state. | Define archive/start-new versus local cache clearing. Do not solve this by adding unguarded cloud deletion. |
| DATA-07 | Sync handler is anonymous and trusts caller-supplied identity. External infrastructure controls were not checked. Localhost and `/v2/` can resolve to production identity; current `/beta/` maps separately. | Verify access controls and development isolation before any real browsing/writing. Do not rely on environment names or old README claims. |

Backup and restore code exists, but backup existence, freshness and successful restoration were **not revalidated live** in this review. Historical runbook results are not current proof.

## Implementation sequence and acceptance criteria

### Milestone 0 — establish a safe working baseline

1. Recheck Git status and preserve user changes. Work on an isolated branch/check-out as appropriate.
2. Use local synthetic fixtures with cloud requests intercepted before navigation; block service workers where they could bypass routing. Do not run `v2smoke` for routine validation.
3. Before any authorized storage/API migration or release, follow the repository backup gate and scratch-restore runbook. Capture dated archives, checksums, record counts and reconciliation. `CLAUDE.md` requires `PREFLIGHT_BACKUP_OK` before merge for storage/sync/API/deploy changes and the applicable restore-check proof.
4. Keep old schemas and IDs readable; migrations must be additive, repeatable and reversible. Retain original exports. No automatic data pruning or rewriting of completed historical exam scores.

Done when: isolated test environment is verified, a recovery approach is concrete, and the intended change can be validated without live student writes.

### Milestone 1 — preserve exam work and make import safe

Address EX-01/02 and DATA-05 first; include EX-03/04 because they share the lifecycle boundary.

- Add a versioned exam state with explicit phase (`module`, `review`, `break`, `completed_pending_save`), module lock/submission state, immutable form IDs/pools, route decisions, timing deadlines, blueprint/scoring versions and answer records.
- Use one deadline computation and enforce expiry inside answer-writing handlers as well as the UI. Keep expired work recoverable; lock the expired module and offer a valid continuation/report path.
- Persist transitions before entering the next phase. Resume a break as a break, using an absolute deadline; never reopen a submitted module.
- Retain a recoverable completed report until durable local persistence succeeds. Make submission idempotent by exam/attempt identity so retry/reload cannot double-count answers, sessions or SRS reviews.
- Replace the import confirm with a real cancelable preview. Validate shapes, types, IDs, dates and sample status before mutation; check every write and keep failed operations recoverable.

Acceptance: original and resumed expiry prevent edits; reload in each phase preserves answers and locks; a quota failure at every relevant write never destroys the sole recoverable copy; retry saves once; invalid/canceled import changes nothing; merge retains every imported and existing exam; existing active snapshots remain recoverable.

### Milestone 2 — repair SRS attempts without resetting history

- Add explicit ephemeral attempt state, separate from lifetime `progress[qid].answered`. Review entry creates a new attempt identity; do not delete progress or set old records to unanswered to make the UI work.
- Use one submission guard for MC and SPR, disable graded controls, and pass the same identity through storage/outbox.
- Preserve original misses, tags, counters and attempts; append the new evidence. Keep the current scheduling policy for the first correctness fix.
- Advance the session queue after grading and provide review-completion feedback. Revisiting a completed attempt should display its result without recording another attempt.

Acceptance: realistic previous-answer + due-card fixtures pass for MC and SPR, both correct and incorrect; double-click/Enter repetition records once; reload and sync do not replay an attempt; original miss remains available; totalReviews increments exactly once and due date moves correctly; foreground timing works on fresh review attempts.

### Milestone 3 — make synchronization lossless under concurrency

- Introduce durable append-only events with stable IDs, source, question/exam linkage, answer, grading/timing evidence and schema version. Evaluate IndexedDB for atomic local event+outbox transactions; retain localStorage compatibility while migrating.
- Persist events server-side before acknowledgement; derive new counters from unique events. Use appropriate Cosmos conditional/transactional writes so overlapping requests cannot erase other events.
- Preserve a legacy baseline for historical aggregates; do not fabricate missing old attempts or add new event totals twice to migrated counters. Keep existing backup/document formats readable.
- Display saved-on-device, pending-sync, cloud-acknowledged and verified-backup states distinctly. A successful HTTP request does not by itself prove every intended record was saved.

Acceptance: two devices answering the same/different questions concurrently, overlapping same-day work, out-of-order pushes, duplicate delivery, interrupted acknowledgement, offline >500 operations, quota failures and reconnect/reload all preserve unique events and consistent totals. Test against a scratch service/database before authorized rollout. Include backwards compatibility with existing clients.

### Milestone 4 — align adaptive practice and communicate scores honestly

- Consolidate the blueprint and validate section/domain/type/difficulty allocations across every route, including exhausted/partially filtered banks. Add injectable randomness for reproducible forms; preserve persisted IDs across reloads.
- Correct PSAT 8/9 weighting after reconciling operational/pretest counts and integer rounding. Retain out-of-scope questions as optional enrichment via metadata, not deletion.
- Remove cross-subject adaptation from mini exams or label/redesign them explicitly. Keep the working independent full-test routing while describing its cutoff as an approximation.
- Persist module-1 evidence, route, model version and timing context in all lean/snapshot/report paths. Keep historical reports unchanged; unknown old provenance stays unknown.
- Replace unsupported score-confidence claims; store official Bluebook results separately and compare only comparable timed, sufficiently fresh full tests.

Acceptance: generated forms satisfy the documented new blueprint across all routes; deterministic boundary tests verify both subjects and SPR grading; reduced pools fail safely; scores are monotonic within their stated model; student/parent labels agree; old reports remain readable without retrospective rescoring.

### Milestone 4A — parent test builder by topic, count, or available time

**User requirement:** a parent can give the student a short, focused test that fits the time available, rather than choosing only a full exam or a fixed 10/20-question drill. Examples: seven Craft and Structure questions; twenty questions on selected ELA skills; or a session designed for fifteen available minutes.

#### Current implementation review

Inspected `parent.html`, `js/pages/parent.js`, `js/pages/student.js`, `js/engine/examgen.js`, and `js/shared/drill.js`. Executed the pure generators against the real 3,059-question bundle; no live profiles were used.

| Existing capability / gap | Verified result |
| --- | --- |
| Parent presets | The gap builder offers 10/20/30/50 questions. `setGapCount` changes the preset; no arbitrary numeric input or available-minutes input is exposed. |
| Parent focus choices | Broad options: all gaps, due SRS, weak skills, Math, Reading and Writing. Difficulty and question-format controls exist. Domain breakdown chips are informational spans, not selectable topics. |
| Engine already supports custom selection | `generateCustomTest` accepts `test`, `domains`, `skills`, `difficulties`, `questionType`, `count`, `timeLimitMinutes`, `isUntimed`, and progress for unseen-first ordering. Seven questions from each of Craft and Structure and Information and Ideas were generated correctly with a 12-minute limit. Reuse this capability. |
| Time limit does not size the test | Calling `generateCustomTest` with Reading and Writing and `timeLimitMinutes: 10`, but no count, returned **20 questions in 10 minutes**. It sets a timer, not a workload budget. The default is a generic 1.5 minutes per question. |
| Removed/disconnected custom UI | `launchCustomTest()` delegates to `launchGapDrill()`. The custom share-link branch still references removed `cust-diff`, `cust-count`, and `selectedSkillsSet` controls/state. Do not revive that branch without updating its contract. |
| Incomplete handoff | `custom_filter` URL parsing passes subject, skills, difficulty and count, but not domains, time limit or untimed status. Gap links omit difficulty/format. The direct parent launch serializes full questions into `sessionStorage`, usable in that tab but not a reliable cross-device assignment. |
| Filters can be silently relaxed | Real reproduction: `generateGapTargetedDrill` with `focus: rw_only`, `questionType: spr`, `count: 10` returned ten questions and **zero SPR**. Empty filtered pools revert to the previous pool. The weak-only branch can also replace previously filtered candidates with a new full-bank weak pool. |
| Preview differs from selection | `updateGapTestCalculations` computes pool metrics without applying every difficulty/format constraint used by launch. `generateCustomTest` silently reduces count if the pool is too small. Preview and generation need one shared eligibility function. |

This is a source review plus isolated generator execution, not a new parent-browser end-to-end test. The implementation must add that coverage.

#### Parent-facing flow

Place **Build a focused test** prominently in the Parent Tests tab, alongside the full exam. Keep 10 and 20 question quick actions.

1. **Choose subject and topics.** Reading and Writing (ELA), Math, or both. Show selectable domains and optional nested skills, including multi-select. Use real bank taxonomy: **Craft and Structure**, **Information and Ideas**, **Expression of Ideas**, **Standard English Conventions**. The user's phrase “craft and ideas” should be served by making the first two domains easy to find/select, not by inventing a combined bank domain. Math offers its existing domains/skills with the scope caveats in Milestone 4.
2. **Choose how to size the test.** Two clear modes: **By number of questions** (presets plus any positive integer up to the valid pool/product limit) or **Fit available time** (10/15/20/30-minute shortcuts plus a custom minutes input). Count mode preserves the requested count; time mode recommends a count. Do not silently reinterpret one as the other.
3. **Choose timed test or untimed practice.** Timed test hides answers until submission and uses a real deadline. Untimed practice uses the time estimate for planning without imposing a cutoff. Allow the parent to reserve part of the time budget for reviewing explanations; show that reservation explicitly rather than treating all available time as answering time.
4. **Optional refinements.** Difficulty, question format where applicable, and selection preference: new questions first (default), unseen only, previous mistakes, due reviews, or all matching questions. These constrain/rank the selected topics, never widen them. Reject or disable incompatible combinations such as ELA + SPR.
5. **Preview and start.** Show selected topic/skill breakdown, eligible and unseen counts, actual question count, estimated answering time, review allowance, total planned time, and any shortage. Show the timer separately from the estimate. Start only after a valid preview; generating or previewing does not count as student activity.

Example: “Reading and Writing → Craft and Structure → Words in Context → Fit 15 minutes → reserve 3 minutes for review.” The engine selects a count estimated to fit the remaining 12 minutes and shows its assumptions. Do not hardcode a promised number of questions for that example.

#### Visual gap guidance in the topic picker — explicit user requirement

The parent should immediately see which domains/skills need attention and select them without consulting another dashboard. Place a **Suggested focus areas** panel above the full topic picker. Use compact selectable domain cards with expandable skill rows; keep every topic available, including topics without enough evidence. This is part of Milestone 4A, not a separate optional analytics project.

Each card/row should show:

- Domain or skill name, a visible selection checkbox, and a text status such as **Needs practice**, **Repeated mistakes**, **Concept gaps tagged**, **Limited evidence**, or **Not practiced**. Use restrained color plus text/icons; color alone must never carry the meaning.
- The evidence behind the status: wrong/answered count and accuracy for the displayed period, unique questions represented, and last practice date when known. Example copy: “4 wrong out of 8 answered · 50% accuracy · last 14 days.” This is illustrative copy, never seed data for an empty student profile.
- For recurring difficulty, show “Missed on multiple questions” versus “Same question missed repeatedly” separately. For a tagged misunderstanding, show “Concept gap tagged on 2 questions,” not an inferred diagnosis presented as fact.
- A short recommendation reason, such as “Recent errors across three different questions,” and an expandable evidence view. Expand a domain to show which skills drive its recommendation; do not let a strong aggregate hide a struggling skill.
- One-click selection on the card or skill row, plus **Select suggested areas** and **Clear selection**. Keep a selected-topic summary visible next to the count/time controls. Recommendations never silently select topics or override a parent's manual selections.

Suggested layout (illustrative evidence, not real student data):

```text
Suggested focus areas                 Recent 14 days | All time

[ ] Craft and Structure               Needs practice
    4 wrong / 8 answered · 50% accuracy
    Recent errors across different questions
    Show skills ▾
      [ ] Words in Context            Repeated mistakes
      [ ] Text Structure and Purpose  Limited evidence

[ ] Information and Ideas            Concept gaps tagged
    View evidence ▾

[Select suggested areas]             Selected: none
```

Evidence and ranking requirements:

- Reuse one pure gap-summary calculation for parent cards, skill rows, recommendations and student analytics; do not reproduce the inconsistent mastery thresholds documented earlier. Version and document thresholds. Prefer recent evidence, repeated independent misses and explicit concept tags; use error rate with sample size rather than raw error count alone so frequently practiced domains are not automatically ranked worst.
- Separate **performance difficulty** from **conceptual misunderstanding**. Wrong answers can reflect calculation, misreading, vocabulary or timing. Only label concept gaps as tagged/confirmed evidence; otherwise use “Needs practice” or “Possible gap” with the basis explained. A single miss must not create a strong understanding-gap claim.
- Offer recent 14 days and all-time views with clearly labeled denominators. Use actual attempt events/timestamps where available. Legacy `progress` contains latest answers plus limited history: do not relabel its aggregate as recent first-attempt accuracy or reconstruct missing events. Show an honest label such as “Latest recorded answers” or “Limited history,” and fall back conservatively until the event model is available.
- Distinguish unique questions, total attempts, independent first attempts and answer-known retries wherever the stored data supports it. A correct immediate retry must not erase the original miss or instantly remove a recommendation. Do not count the same exam answer once from progress and again from exam history; deduplicate by event identity where present, or choose one documented authoritative source for legacy data.
- Do not invent concept tags, elapsed time, dates, progress or sample size. Show **Not practiced** for no evidence, **Limited evidence** for small samples, and **Older evidence** when recency is stale. Avoid “Mastered” or green reassurance without the retention criteria in Milestone 5. A clear empty state should invite a short diagnostic or manual topic selection.
- Selecting a suggested skill/domain must feed exactly the same strict eligibility/planning path as manual selection. Counts and estimated time update immediately; expanding evidence is read-only and must not start a drill or record an attempt.
- On mobile, stack cards and use accessible disclosure controls for skill rows. Support keyboard selection, visible focus, screen-reader status/selection labels, and sufficiently contrasted text. The full topic picker remains usable with recommendations collapsed.

Acceptance tests for gap-guided selection:

- Hand-written synthetic profiles include: no attempts; one wrong answer; repeated independent misses; many correct answers with a few misses; repeated misses on one question; tagged concept errors; old evidence; and a weak skill inside a strong domain. Verify status, ranking, counts and reasons without deriving expected values from the implementation under test.
- A correct retry preserves the historical miss; an untagged wrong answer never becomes a confirmed concept gap; duplicate exam/progress representations do not inflate evidence. Sparse or legacy history receives the correct limitation label, including in the recent-period view.
- Selecting a recommended domain and then a nested skill updates the visible selected-topic summary and preview without surprising union/intersection behavior. The planner generates only the intended topic set. Define domain selection as all its skills, child deselection as partial selection, and show an indeterminate domain checkbox for a partial selection.
- **Select suggested areas** selects exactly the currently displayed recommended topic set, deduplicates overlapping domain/skill choices, and updates counts. **Clear selection** clears only builder selections. Neither action modifies student records. Manual selections survive sorting, evidence expansion and time/count edits.
- Desktop/mobile browser tests confirm the cards are visible in the builder, evidence is readable, keyboard interaction works, and selection flows through to the student test with matching topic IDs. Empty profiles show no fabricated weakness statistics.

#### Selection and time-budget contract

- Add a shared pure planner around the existing custom generator. Proposed request fields: `schemaVersion`, `subjects`, `domains`, `skills`, `difficulties`, `questionType`, `selectionPreference`, `sizeMode`, `requestedCount`, `availableMinutes`, `reviewMinutes`, `timingMode`, and an optional explicit timer limit in count mode. Use the same normalized request in preview, launch, share-link parsing and saved reports.
- Apply the union of selected values within a category, and intersection across categories. Subject/domain/skill combinations must be consistent. When multiple skills are explicitly selected, spread questions across them where feasible; show allocation in preview. If count is smaller than selected skill count, explain incomplete coverage or request a larger count. Never imply all topics are covered when they are not.
- Separate **eligibility** from **ranking**. All strict filters apply first. Unseen-first and weakness/SRS priorities operate only inside that pool. Empty or insufficient pools produce a clear result with options to reduce count or explicitly change filters. Never add off-topic questions, relax difficulty, repeat IDs, or silently switch to generic practice.
- Count mode validates finite positive integers and delivers exactly the requested count if available. If insufficient, show the actual availability and require the parent to accept the smaller set. Counts such as 3, 7, 13 and 25 must work; remove the gap path's implicit minimum of five for this builder. Preserve any documented upper bound visibly in the UI.
- Time mode validates finite positive minutes and `0 <= reviewMinutes < availableMinutes`. Use reliable independent-attempt timing grouped by skill/subject and difficulty when enough observations exist; define the minimum sample and robust estimator in versioned configuration. Exclude unreliable timing, inactive-tab inflation and immediate answer-known retries. Avoid an unreliable per-question model with tiny samples.
- With insufficient student timing, use explicitly labeled, versioned planning assumptions. These are heuristic estimates, not measured student performance or official completion guarantees. Do not display false precision. Untimed learning can need more time than a test; account for mode rather than reusing a single universal speed.
- Choose a set whose modeled answering time plus review reservation fits the budget; report uncertainty in plain language. If no item reasonably fits, explain and offer a longer budget or untimed practice rather than forcing one question or returning an empty playable test. If the parent edits count after a time recommendation, switch to count mode and warn if the estimate exceeds available time.
- In timed time-budget mode, the answering deadline is the available budget minus the explicit review reservation. The review portion is a planning allowance, not a claim that explanations can always be completed within it. On expiry, preserve answers and submit/lock according to the corrected exam lifecycle; offer recovery if saving fails.
- Custom focused tests are **nonadaptive practice sets** by default, not truncated official adaptive PSAT exams. Results emphasize accuracy, omissions, timing, topics and next practice. Do not display an overall PSAT score or insert them into full-exam score trends merely because they exceed the current sample-size gate. Persist an explicit custom-test category and sizing metadata.

#### Handoff, persistence and safety

- Reuse the corrected student custom-test runner and shared grading/report paths; do not implement a second exam runner in the parent page. Update `startCustomTestDirect`, URL parsing, snapshot/lean-report serialization and parent history together so settings and provenance survive start → reload → finish → sync.
- Store selected question **IDs** and a versioned request/plan instead of full question objects. Freeze the selected IDs when the parent accepts the preview. Keep recipe identity separate from run identity; starting the same recipe twice creates distinct attempts and reports.
- Provide **Start in student app** and a working **Copy setup link**. A setup link carries validated settings only, with no student history, answers or credentials. Opening it previews a newly generated matching set on that device; say this explicitly. An exact shared assignment with frozen question IDs is a separate optional extension, not something `sessionStorage` already guarantees.
- Preserve beta/production lane information in launch/share paths. Validate URL values as strictly as UI input. Avoid comma-splitting skill names: real labels such as “Lines, angles, and triangles” contain commas; use structured encoding or repeated parameters.
- Do not replace an unfinished exam when a parent generates or opens another test. Offer Resume existing / Save for later / Explicitly archive and start new after the recovery mechanisms exist. Opening a setup link must not auto-start over active work.
- Planning, preview, cancel and sharing must not mutate progress, SRS, sessions or exam history. Record actual submitted student attempts exactly once. Handle storage failure visibly and keep the recoverable run/report. No dataset migration is needed for the first version of this feature.

#### Implementation slices and acceptance tests

1. **Shared planner + topic/count UI:** extend `generateCustomTest` with shared validation/eligibility, expose topic/skill selection and custom counts, add the selectable gap-guidance cards and skill evidence described above, and preview actual availability. Eliminate silent fallback behavior on the integrated gap path.
2. **Time-budget planning:** add the estimate model, explicit uncertainty/fallback basis, review allowance, and timed/untimed controls. Test with hand-written timing fixtures and injected randomness/clock.
3. **Safe student handoff + reports:** preserve the configuration and frozen IDs through the existing runner, reload, reports and history. Repair sharing and remove stale custom-control references.
4. **Browser acceptance:** use isolated desktop/mobile fixtures. Test parent selection through student completion, not just the pure generator.

Required cases:

- Seven Craft and Structure questions contain only that domain; thirteen questions in two selected ELA skills cover only those skills and match the preview allocation. Ten/twenty shortcuts still work. Changing subject resets incompatible selections visibly.
- A deterministic test fixture with 120-second item estimates, 15 available minutes and 3 review minutes selects six questions: 12 answering minutes plus 3 review minutes. Clearly mark these as synthetic test assumptions. Test mixed item estimates and sparse timing fallbacks separately.
- Count mode requests 20 even if estimated duration exceeds the budget; UI explains the conflict rather than silently lowering count. Time mode sizes automatically and exposes the recommended count before launch.
- Reject zero, negative, fractional counts, NaN/infinite/invalid URL values, and review allowance consuming the entire budget. Very small budgets and empty/undersized pools have non-destructive empty/shortage states.
- ELA + SPR produces no playable test, not MCQ fallback; due-only with no due questions stays empty; weak-only preserves selected domain/difficulty/type constraints. No generated set contains duplicate IDs.
- Preview count/topics equal launched count/topics. Changing filters invalidates the old preview. Canceled preview or setup-link opening leaves all learning records unchanged.
- Timed/untimed mode, requested/actual count, available minutes, review allowance, topics, frozen IDs and category survive reload and final report serialization. Timeout and injected save failures preserve all work.
- Setup links round-trip domains, multiple skills (including commas), count/time mode, timing settings, difficulty and selection preference; opening on a fresh browser previews a valid set. Existing active work is retained.
- Short custom tests show no misleading composite PSAT prediction and do not contaminate full-test trends. Original attempts and SRS history remain intact after completion.

**Dependencies and priority:** build the pure planner/UI in isolation at any time; gate release of the runner integration on Milestone 1 recovery protections, and due-review integration on Milestone 2's genuine-attempt fix. Do not delay this explicit user feature until all Milestone 5 teaching tools exist. Milestone 3's future event model must remain compatible with the new request/run IDs.

### Milestone 5 — build the conceptual learning experience

Start with one recurring weak concept using existing reviewed explanations. Expand based on observed use rather than adding an open-ended chatbot first.

1. **Today's plan:** bounded session of due reviews, one weak concept, independent transfer questions; explain why these were selected. Ask for available minutes and test date when implementing personalization.
2. **Correction loop:** optional confidence/error tag → progressive hint → worked method and distractor explanation → fresh related question → delayed follow-up. Preserve whether help was used.
3. **Concept mapping:** refine broad skill labels into misconceptions/prerequisites and verified sibling relationships; reuse `generatePostExamRecoveryPlan` and coaching drills rather than duplicating them.
4. **Mastery evidence:** first-attempt accuracy, assisted performance, delayed retention and timing separately. Current three-question/75% mastery threshold is insufficient for strong claims.
5. **Strategy labs:** graph versus algebra, estimation, checking units/signs, reading evidence and eliminating distractors. Teach calculator use intentionally; do not push every question toward a universal 45-second target.
6. **Parent brief:** what improved, recurring misconception, whether independent transfer occurred, and a concrete supportive next action.

Acceptance: a student can follow one complete learning sequence without navigating unrelated dashboards; explain the method and solve a new example; parent and student see the same evidence; opening an explanation alone does not count as mastery. Track independent transfer success and later retention as product outcomes, without promising score gains.

## Original review validation record and repeatable checks

September 6 local Node suites, all passed:

```sh
node tests/test_adaptive_config.js
node tests/test_adaptive_routing.js
node tests/test_srs.js
node tests/test_free_response.js
node tests/test_dataset_free_response.js
node tests/test_scaled_score.js
node tests/test_storage_v2.js
```

Free-response suite checked 365 records / 449 accepted forms. Injected quota errors printed by safety tests were expected. Passing score tests demonstrate implementation consistency, not psychometric calibration.

Existing isolated desktop browser run: **9 passed in 10.8 seconds**.

```sh
./node_modules/.bin/playwright test \
  tests/e2e/adaptive.spec.js \
  tests/e2e/srs_progression.spec.js \
  tests/e2e/srs-review-queue.spec.js \
  --project=chromium-desktop \
  --output=/private/tmp/psat-review-20260905-existing \
  --workers=1
```

The localhost server needed sandbox permission. The fixture intercepted sync; no production smoke test was run.

Additional temporary browser audit: eight scenarios (six defect observations, two mixed-route validations) were confirmed. Initial run had six successful observations and two test-locator timeouts because the Resume button includes an arrow; after correcting only that locator, both recovery cases passed their observation assertions. **These assertions intentionally describe defects; they are not green acceptance tests declaring the app correct.**

Temporary files, if still available:

- `/private/tmp/psat-audit-20260906/audit.spec.js`
- `/private/tmp/psat-audit-20260906/playwright.config.js`
- `/private/tmp/psat-audit-20260906/results/`

Do not depend on temporary files surviving. Reproduction steps and required corrected outcomes are retained in the finding tables above. During implementation, add permanent behavioral regressions using `tests/e2e/fixtures.js`, write the desired outcome, observe the failure on old code, then fix it. In particular, do not keep assertions that endorse old-answer resubmission or expired-state deletion as desired behavior.

### Coverage limits / remaining verification

- No live Cosmos concurrency exercise, backup restore, current deployed-code comparison or access-control audit.
- The initial audit did not include mobile. The continuation checkpoint above records the subsequent desktop/mobile implementation checks.
- No long-duration real-clock exam, device sleep/background throttling test, or new service-worker offline run. Controlled-clock browser tests established the specific deadline defects above.
- No full content audit of 3,059 questions or verification of every worked explanation. The user's edited area/volume page was not changed or certified.
- RW detailed weighting, exact official question ordering and any accommodation modes need a focused specification pass before claiming simulation fidelity.

## Suggested next-session instruction

“Read the September 6 implementation checkpoint in `docs/PRODUCT_REVIEW_AND_IMPLEMENTATION_PLAN.md` and inspect the current diff. The focused parent builder and local exam/SRS/import recovery are already implemented; do not start those over. Preserve existing student data and unrelated user edits. Run the local-only regression gate, then prioritize Milestone 3's exact concurrent event persistence and Milestone 4's exam fidelity before the remaining conceptual-learning roadmap. Follow the backup preflight/restore runbook before any merge or release. Deployment and production migration require separate scope.”
