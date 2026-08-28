# Feature & Reliability Roadmap

**Audience:** Developer implementing the next product-focused iteration.

**Goal:** Make one student's records resilient to device/browser failure, make score feedback appropriately trustworthy, and turn practice into a stronger learning loop. This assumes a private, single-student deployment; account/authentication work is intentionally out of scope here.

## Ground Rules

- Do not re-run PDF extraction or change the question dataset unless a task explicitly requires it.
- Preserve the dependency-free browser application model.
- Never discard, overwrite, or reset student data without first creating a recoverable snapshot.
- Keep the current tests passing and add regression coverage for every changed data path.

## 1. Make Student Records Recoverable — Highest Priority

### Current risks

- Complete profiles are sent on every sync, increasing latency and storage/document-size risk as history grows.
- SRS histories are unbounded, unlike question attempts.
- A missing or corrupt pre-demo backup can cause restore to clear real data.
- Import replaces state without validation, preview, or a recovery snapshot.
- Local reset and cloud merge do not have one explicit, predictable policy.

### Implementation tasks

1. Define a versioned student-data envelope with schema version, creation time, last update time, progress, SRS state, sessions, and exams.
2. Before import, reset, or sample-data activation, write a dated snapshot. If it fails, cancel the destructive action and explain why.
3. Change restore behavior: a missing/invalid pre-demo backup must leave real-data keys untouched and show an error. It must never delete records.
4. Retain only the most recent 20 SRS review events per question, plus durable summaries: total reviews/lapses and first/last review time.
5. Store individual attempts as append-only records with stable IDs. Sync only unsynced changes, then derive aggregate progress, sessions, SRS, and analytics from those records.
6. Add a local outbox for unsynced operations; retry at startup, on reconnect, and from manual sync. Show last successful cloud backup and pending count.
7. Give reset a documented policy: archive current records then start fresh, or delete both local/cloud records. Do not mix the two.
8. Export using `Blob`/object URLs rather than a `data:` URL so large backup downloads remain reliable.
9. Validate imports, show record counts/date/sample status, provide Replace or Merge, and automatically snapshot before either choice.

### Required tests

- Failed demo backup and restore never remove real progress.
- Invalid import changes nothing; valid import creates a recovery snapshot first.
- Interrupted sync/reload persists the outbox and eventually stores each attempt once.
- Heavily reviewed cards retain bounded history while summary counters remain correct.
- Repeated pull/push cycles neither inflate nor regress sessions, progress, or SRS.
- Reset conforms to its documented cloud/local policy.

**Done when:** the UI reports a successful recent backup, supports restoring a named snapshot, and no action can erase data after a failed backup or invalid import.

## 2. Make Projected Scores Calibrated and Honest

### Current gap

The existing linear accuracy mapping, fixed 58% routing cutoff, and hand-authored adaptive curves are useful placeholders. They are not yet a calibrated score model.

### Implementation tasks

1. Label the existing output **Practice score estimate**.
2. Return a score interval and low/medium/high confidence, driven by sample size, section coverage, recency, timing, and full-test completion.
3. Generate full modules to a written blueprint: section, domain, skill, difficulty, question type, and free-response mix. Keep unseen-first selection only inside each bucket.
4. Persist module-1 performance, module-2 route, timing, and question mix with every exam report.
5. Move routing thresholds and score conversion tables into versioned configuration, not inline constants.
6. Calibrate from representative timed full tests. Until then, use broad ranges and state the assumptions in the UI.
7. Explain confidence factors: incomplete coverage, insufficient evidence, untimed work, or inconsistent performance.

### Required tests

- Generated full tests meet every blueprint count and contain no duplicate question.
- Identical input produces the same range and model version.
- More correct answers never lower the estimate or lower bound.
- Smaller/untimed samples yield wider intervals than full timed exams.
- Routing boundary cases choose the expected module-2 pool.

**Done when:** every score shows its range, confidence, and data basis; every full test is blueprint-balanced.

## 3. Make SRS Diagnose and Repair Learning Gaps

### Implementation tasks

1. After a miss, offer an optional error tag: concept, misread, vocabulary, strategy, calculation, graph/table, or time pressure.
2. Provide a correction loop: rationale, retry or sibling question, then scheduling.
3. Track skill mastery separately from individual question cards. Require success across multiple questions and days before marking a skill stable.
4. Prioritize overdue cards, repeated misses, evidenced weak skills, then unseen coverage.
5. Treat pacing and accuracy as separate signals; slow-correct answers should drive pacing recommendations.
6. Add a daily forecast: cards due, expected minutes, skills affected, and urgent reviews.

### Required tests

- Error tags persist and affect analytics/drill ranking.
- A correct retry never erases the original miss.
- Repeated same-skill misses outrank generic unseen questions.
- Slow-correct answers affect pacing without being marked wrong.

**Done when:** the student knows why a question is due, what kind of error occurred, and the next targeted action.

## 4. Improve the Post-Exam Learning Loop

1. Add an exam debrief: accuracy, pacing, unanswered items, domain/skill performance, and adaptive route per section.
2. Compare a full timed exam only with the prior comparable full timed exams; exclude mini-tests from that trend.
3. Generate a 10-question recovery plan mixing missed-item review and transfer questions from the same skills.
4. Identify the two or three skills most likely to improve a section, clearly labelled as prioritization guidance rather than a guarantee.

**Done when:** a full exam yields both a clear diagnosis and the next practice session.

## Delivery Sequence

1. Snapshots plus non-destructive demo/import/reset flows.
2. Bounded histories, outbox-based incremental sync, and sync regression tests.
3. Blueprint-balanced tests and score ranges/confidence.
4. Error tags, correction loop, and adaptive drill improvements.
5. Post-exam debrief and recovery-plan experience.

## Verification

Run after each milestone:

```bash
python3 -m unittest test_extractor.py -v
node tests/test_free_response.js
node tests/test_srs.js
node tests/test_dataset_free_response.js
```

Also manually test import/export, snapshot restore, reset, offline queueing, and full exam completion in the browser.
