## [Promotion] — 2026-08-29T02:05:20Z (Commit: 2c8854e)
* **Branch:** `main`
* **Verified Suites:** SM-2 SRS, Mini Exam Simulation, Backup Checksums, Free-Response Grading, PDF Extractor.
* **Target:** Azure Storage Account `psatprep4915` (`$web` root and `beta/` subfolder).

## [Promotion] — 2026-08-29T02:01:59Z (Commit: c9ab218)
* **Branch:** `main`
* **Verified Suites:** SM-2 SRS, Mini Exam Simulation, Backup Checksums, Free-Response Grading, PDF Extractor.
* **Target:** Azure Storage Account `psatprep4915` (`$web` root and `beta/` subfolder).

## [Promotion] — 2026-08-29T01:53:51Z (Commit: feafd6c)
* **Branch:** `main`
* **Verified Suites:** SM-2 SRS, Mini Exam Simulation, Backup Checksums, Free-Response Grading, PDF Extractor.
* **Target:** Azure Storage Account `psatprep4915` (`$web` root and `beta/` subfolder).

# 📋 PSAT 8/9 Prep — Beta Promotion Changelog

## [Promotion v2.0] — 2026-08-28 (Commit: feafd6c)
* **Features Promoted:**
  - **`DATA-04` (Durable Sync Outbox)**: Offline question attempts & exam completions queued with immutable IDs; synchronized with server acks.
  - **`DATA-05` (Transactional Destructive Actions)**: Mandatory pre-action safety snapshots with automatic rollback on storage failure or exception.
  - **`DATA-06` (Compact SRS State)**: Summary lifetime counter retention with 20-event sliding window bounding.
  - **`SCORE-01` (Official Module Blueprints & Score Ranges)**: Balanced domain quotas (RW 7/7/7/6, Math 8/6/5/3) with 17 MCQ + 5 SPR and calibrated 90% confidence score ranges.
  - **`SRS-02` (Adaptive Error Tag Coaching)**: Tag-driven coaching drills, 45s speed pacing for time pressure errors, longitudinal weekly trend analytics, and historical error tag preservation.
  - **`BACKUP-03` (Checksummed Backups & DR Runbook)**: SHA-256 sidecars for cloud and CLI backups; tamper detection and disaster recovery runbook.
  - **`BETA-02` (Reproducible Beta Promotion)**: Automated test verification and one-command promotion tool (`promote_beta.sh`).
* **Verified Test Suites:** SM-2 SRS, Mini Exam Simulation, Free-Response Grading, PDF Extractor, Backup Integrity & Checksums.
* **Target:** Azure Storage Account `psatprep4915` (`$web` root and `beta/` subfolder).

