# Codex Review — Prioritized Next Work

The recent backup/restore, beta-isolation, recovery-plan, and snapshot fixes are accepted. The following work is the highest-value path to a resilient and genuinely useful PSAT-prep product.

## 1. DATA-04 — Durable Sync Outbox

**Problem:** The pending-sync indicator is only a count. It does not retain the actual unsynced attempts; an interruption before cloud persistence can still lose work.

**Implement:** Store each attempt/change as an immutable operation with a stable ID, persist unsynced operations in a local outbox, acknowledge and remove each only after the server confirms it, and make retries idempotent. Derive aggregate progress, sessions, SRS state, and analytics from this durable attempt history.

**Done when:** An offline answer survives browser close/reopen and later syncs exactly once. Repeated pull/push cycles never inflate or regress totals.

**Tests:** Offline answer → reload → reconnect; lost acknowledgement → retry; two-device merge preserving both attempts.

## 2. DATA-05 — Transactional Destructive Actions

**Problem:** Production reset, imports, and bulk writes still need one consistent snapshot/rollback mechanism.

**Implement:** Create a shared destructive-action helper that verifies a snapshot before any import, reset, demo load, restore, or bulk overwrite; aborts on snapshot failure; rolls back all keys if any write fails; includes an active exam snapshot; and shows the recovery snapshot created.

**Done when:** No destructive action can leave partial writes or erase records after a failed snapshot/write.

**Tests:** Fail each core storage write in turn; ensure failed pre-action snapshot changes no state; restore a replaced import from its automatic snapshot.

## 3. DATA-06 — Compact Long-Term SRS State

**Problem:** Detailed SRS review history can grow without bound, risking browser quota and oversized cloud records.

**Implement:** Retain the newest 20 detailed review events per card while preserving durable summaries: total reviews, lapses, first/last review, and average response time. Version/migrate card schema safely and enforce a storage-size budget before sync.

**Done when:** Thousands of reviews remain compact while scheduling and analytics remain correct.

## 4. SCORE-01 — Calibrated Score Ranges and Blueprint-Balanced Exams

**Problem:** Current score/routing logic is a useful practice signal but not yet calibrated enough for a precise projection. High-yield sorting can also bias test composition.

**Implement:** Define explicit per-module blueprints (domain, skill, difficulty, MCQ/free-response mix), choose unseen items within each bucket, persist blueprint/high-yield version in reports, show a score range plus confidence level, and separate high-yield practice from standard full-test trends.

**Done when:** Every full test matches a measurable blueprint with no duplicates, and every score states its range, confidence, and data basis.

## 5. SRS-02 — Make Error Tags Drive Coaching

**Problem:** Root-cause tags are captured/displayed but do not yet change what the student practices next.

**Implement:** Prioritize concept gaps ahead of careless/time-pressure errors; offer tag-specific interventions (transfer questions, timed drills, review checklists); show weekly error trends; preserve the original error after a later correct retry.

**Done when:** The student sees why an item is due and receives an action tailored to the error type.

## 6. BACKUP-03 — Disaster-Recovery Verification

**Implement:** Add an integration test from backup payload through validation/dry-run/pre-restore snapshot to test-container restore; include feedback in pre-restore snapshots; add checksum/byte-count integrity metadata; document a recovery runbook.

**Done when:** A backup from either path can be validated and restored in a tested workflow.

## 7. BETA-02 — Controlled Beta Promotion

**Implement:** Make beta deployment reproducible, verify all static assets before exposure, display build/version IDs, maintain a beta smoke-test checklist, and promote a named tested commit rather than copying files ad hoc.

**Recommended order:** DATA-04 → DATA-05 → DATA-06 → SCORE-01 → SRS-02 → BACKUP-03 → BETA-02.
