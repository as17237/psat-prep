# REFACTOR_STATE.md — Continuation Handoff

**Purpose:** Everything needed to continue the refactor from a fresh clone on any machine.
**Companion to:** `REFACTOR_PLAN.md` (the full 19-work-item plan — read it first; this file is the "where are we" overlay).
**Last updated:** 2026-08-30 (after WI-11's agent was cut off by a spend limit; coordinator completed its verification). Supersedes `AGENT_HANDOFF.md` for refactor context.
**Coordinator session:** https://claude.ai/code/session_01TToAjtgAQcWjJhKYYUjUV2 · Plan artifact: https://claude.ai/code/artifact/c8ffedd6-5c2c-486d-ada6-3ac028d8f547

---

## 1. Position in the plan

| Item | Status | Commit(s) | One-line evidence |
| :-- | :-- | :-- | :-- |
| WI-01 backup CLI fix | ✅ | `08a5dd1` | Live run: 10 docs exported, restore dry-run "Integrity Verified" |
| WI-02 baseline snapshot | ✅ | `c51d746` | `refactor-baseline/baseline_2026-08-29T14-09-29Z/` — 3059/10/0 docs, 3,059 images, MANIFEST, private ACL |
| WI-03 restore proof (⛔gate) | ✅ | `5093e90` | Scratch restore 0 mismatches; red demo caught exactly 1; runbook §5 |
| WI-04 backup gaps closed | ✅ | `ff5828a` | Nightly = v1.1 payload w/ 3,059 questions; `/api/backup-status`; FAILED markers; parent widget |
| WI-05 cadence gates | ✅ | `f1f1663` | `scripts/preflight_backup.sh`, `scripts/weekly_restore_check.sh`; CLAUDE.md gate block |
| WI-06 /v2/ lane | ✅ | `1ee8bc8` | Lane-asserted deploy scripts; client_version through sync; write-isolation proven by etag |
| WI-07 integrity suite | ✅ | `d3c20d5` | `api/src/lib/merge.js` + 38 pins + 20k-case equivalence; `tests/integrity/run_integrity.js` 9 live checks |
| WI-08 Playwright harness | ✅ | `a6629a4` | 52×2 green; quarantine fixture; **found 5 real prod defects** |
| WI-08.5 hotfix (unplanned) | ✅ | `177e377` | 6 crash sites guarded + 2 bonus fixes; **promoted to prod by owner** (`PROMOTE_TO_PROD_OK 177e377`) |
| WI-09 inline-JS extraction | ✅ | `5afa761`→`811267b`,`73bba13` | 5,361 lines → `js/pages/` + `js/shared/`; dup ledger 57→31; localStorage-equivalence 0 diffs |
| WI-10 srs.js decomposition | ✅ | `5cf781e`,`e2ef70a` | `js/engine/*` 6 UMD parts; 56-symbol API pinned; generation sha-identical (`7f7a542f…`) |
| **WI-11 storage/sync hardening** | **🟠 CODE LANDED, NOT ACCEPTED** | `1733ca8`,`a135d7b`,`0049a75`,`bc92fbf`,`3642fce` | Envelope v2, exact summaries, delta sync, transactional restore unified, compaction script — all committed and green. **BLOCKED on the growth finding in §8.** Its `api/src/functions/sync.js` change is committed but deliberately NOT deployed |
| WI-12 design system | ⬜ | | Next after WI-11 (sonnet) |
| WI-13 student rebuild | ⬜ | | opus |
| WI-14 parent rebuild | ⬜ | | opus — inherits latent-defect fix: 5 lucide icon `className` assignments never applied (see js/shared/dom.js note) |
| WI-15 mistakes/feedback rebuild | ⬜ | | sonnet |
| WI-16 adaptive verification | ⬜ | | opus (downgraded from fable per owner budget request) |
| WI-17 parity suites | ⬜ | | sonnet |
| WI-18 parallel run ≥5 days | ⬜ | | coordinator + haiku dailies; **owner approval point** |
| WI-19 cutover | ⬜ | | **owner executes** `promote_to_prod.sh` |

## 2. Live environment (all names exact)

- **Prod site:** https://psatprep4915.z13.web.core.windows.net/ — serving hotfix `177e377`. **Do not deploy to root except via `scripts/promote_to_prod.sh` (owner-run).**
- **Staging:** https://psatprep4915.z13.web.core.windows.net/v2/ — refactored app, deployed via `scripts/deploy_v2.sh` (prefix-asserted). Beta (`/beta/`) is stale and has a known image-404 defect; untouched by choice.
- **API:** Functions app `psat-api-4915` — `/api/sync`, `/api/backup`, `/api/backup-status`, `/api/feedback`. Deployed from `api/` via `az functionapp deployment source config-zip --build-remote true`. Currently at WI-07 state (merge.js extraction) + WI-06 clientVersion.
- **Cosmos:** `psat-cosmos-15958` / `psat-prep-db` (rg `rg-psat-prep`): `Questions` (3,059, /domain, frozen), `UATStudentAnswers` (/student_name — `student_default_student` = THE LIVE STUDENT, ~406 progress/392 SRS/9 exams; `student_e2e_test_student` = test identity; 9 immutable `exam_*` docs), `UATFeedback` (/category).
- **Storage `psatprep4915`:** `$web` (site + `data/images/` 3,059 PNGs + bundle), `cosmos-backups` (nightly 02:00 UTC, v1.1 ~8.4 MB, sha256 sidecars), `refactor-baseline` (PRIVATE; restore-verified baseline + superseded partials — never delete anything in either backup container).

## 3. Non-negotiables (from REFACTOR_PLAN §3/§7 — enforced all session)

1. **Never write `student_default_student` or any `exam_*` doc** from tests/tooling. Playwright quarantine fixture (tests/e2e/fixtures.js) rewrites/hard-fails; keep it in every spec.
2. Preflight before merging anything touching `api/`, storage, sync, deploys: `./scripts/preflight_backup.sh` → cite `PREFLIGHT_BACKUP_OK <file>`. Weekly: `./scripts/weekly_restore_check.sh` (its red-demo is mandatory for the run to count).
3. Question content frozen: `data/*.json`, `data/questions_data.js`, `data/images/**`.
4. Every sub-agent completion is verified by the coordinator re-running key checks before commit. Red-first tests, real-data numbers pasted, honest gaps flagged (CLAUDE.md is binding).
5. Renaming free within owning work items; live data contracts (Cosmos container/doc names/fields, `psat_*` localStorage keys, blob containers) are NEVER renamed.
6. Model budget (owner request 2026-08-29): no fable sub-agents; opus for critical/large/deploy work, sonnet for bounded work, haiku for repetitive runs.

## 4. Fresh-machine setup

```bash
git clone https://github.com/as17237/psat-prep.git && cd psat-prep
az login                        # subscription: Visual Studio Professional (580d0d70-…)
cd api && npm ci && cd ..       # @azure/cosmos etc. for scripts/
npm ci && npx playwright install --with-deps chromium   # e2e harness
python3 -m pip install -r requirements.txt
# Sanity: all suites green + live integrity
for t in tests/test_*.js; do node "$t" || break; done
node tests/integrity/run_integrity.js         # needs az login (live checks)
python3 -m unittest test_extractor.py         # 7 pass + 2 skip without PDFs (PDFs are gitignored, optional)
npx playwright test                           # local projects; @v2smoke needs internet
```
Secrets: none in repo — Cosmos/storage keys fetched at runtime via `az` into env vars. Never put keys on argv.
Note: `backups/` (local snapshots) and the 4 source PDFs are gitignored — not needed to continue; cloud backups are canonical.

## 5. Open threads beyond the work items

- **Student's interrupted exam (2026-08-29):** an exam crashed at Finish under the pre-hotfix code. Answers are safe in their browser's localStorage; the exam records only when the student clicks **Resume → Finish** in the fixed app. Until then cloud history stays at 9 exams. Check: `curl -s '<api>/api/sync?student_name=default_student'` → examHistory length.
- **SRS history compaction of the live doc:** `scripts/compact_srs_history.js` (WI-11) is dry-run-only; `--apply --backup <blob>` is a human-approved step, sensible to fold into WI-18's window.
- **Latent data facts (pinned, not bugs to fix silently):** 392 SRS cards have `questionId:""` (key carries the id); 13 progress entries lack `timestamp`; older exam-history entries have `type/title` undefined (mismatch fixed in `177e377` for new exams).
- **`tests/integrity/expected_floor.json`** floors (docs ≥11, default progress ≥406) are hand-raised at checkpoints — raise after real growth, never auto.
- **Beta lane:** stale + broken images; either retire it or redeploy via `scripts/deploy_beta.sh` when convenient.
- **Deploy side-fact:** Functions app switched to remote-build zip deploy (WEBSITE_RUN_FROM_PACKAGE removed) — documented in runbook §6.5.

## 6. WI-11 acceptance checklist (complete these before moving to WI-12 if resuming mid-flight)

Envelope `schemaVersion:2` + v1 readable · SRS cap 20 w/ exact summaries · delta sync via outbox (v1 clients unaffected — merge.js proof) · transactional restore unified (student.js twin) · migration idempotent + reversible w/ `psat_*_v1_backup` · full-bank sim < 400 KB (capped vs uncapped printed) · compaction dry-run only · live /v2/ e2e_test_student doc shows v2 fields · `default_student` etag fenced · integrity + 17 suites + Playwright ×2 green · api-surface test green.

## 7. How the work gets done (process)

One sub-agent per work item (briefs follow the plan's 7-field format; see REFACTOR_PLAN §5 for each item's spec). The coordinator: launches with the §3.6 model assignment, independently re-verifies key claims (live curls, suite re-runs, etag checks), commits per accepted item with descriptive messages, and pauses for the owner at: prod deploys, WI-18 start, WI-19 cutover, and anything touching `default_student`.


---

## 8. ⚠️ OPEN ARCHITECTURAL FINDING — read before continuing WI-11

`node scripts/simulate_full_bank.js` (WI-11's own simulation, run 2026-08-30):

```
FULL BANK, CAPPED (what this build writes)
  master doc ....... 3,367,863 bytes (3.29 MB)   <-- OVER the 2 MB Cosmos wall
    progress ....... 1,764,614 B  (3,059 entries, 577 B/entry)
    srsState ....... 1,512,683 B  (3,059 cards,  495 B/card)
  cap saves ........ 0 bytes (0.0%)
400 KB budget crossed between 250 and 406 distinct questions
2 MB Cosmos wall crossed between 1,500 and 2,000 distinct questions
```

**Two conclusions, both material:**

1. **WI-11's DoD is NOT met.** The plan requires the full-bank simulation to stay under 400 KB. It reaches 3.29 MB and crosses Cosmos' hard 2 MB per-document limit at roughly 1,500–2,000 distinct questions. The live student is at 406 (~288 KB today), so this is a real future outage, not a hypothetical.
2. **The 20-event SRS history cap does not address the actual growth driver.** The simulation drives only 3 reviews/question, so the cap never engages (`cap saves 0 bytes`, longest history 3). Growth comes from *per-entry size* — 577 B per progress entry, 495 B per SRS card — not from history length. `scripts/compact_srs_history.js` dry-run against the live doc agrees: 393 cards inspected, **0 history events to trim**.

**Therefore the single-master-document model does not scale to the full 3,059-question bank**, with or without WI-11's caps.

### ✅ DECIDED 2026-08-30 — owner chose option C

Owner's words: *"smallest data and no wall, no data loss, and the existing app should continue to work."* Specced as **WI-11.5** in `REFACTOR_PLAN.md` (inserted just before Phase 3): slim per-entry payloads **and** shard the master document into `progress_shard`/`srs_shard` buckets, with three hard acceptance criteria — additive migration that never deletes the legacy doc, full v1-client compatibility (prod app untouched; server reassembles and accepts v1 full-state payloads), and every document under 400 KB at full 3,059-question coverage. Run it after WI-12; never concurrently with WI-13/14. Fix `simulate_full_bank.js` first — it drives only 3 reviews/question, so the cap never engages.

### Options as originally presented

- **A. Slim the per-entry payload.** Drop derivable fields (`accuracyPercent`, `timesSeen`/`timesCorrect`/`timesIncorrect`, redundant flags) and shorten keys. Plausibly 40–60% smaller → ~1.4–2.0 MB at full bank. Cheapest change; still uncomfortably close to the wall.
- **B. Shard the master document** (recommended): keep the profile doc small and store progress/SRS in bucketed documents (e.g. by question-id prefix or domain), or attempts as append-only docs with periodic rollups. The delta-sync path WI-11 just built is what makes this tractable — the client already computes per-key deltas. Server merge is per-key, so sharding is compatible with the existing `api/src/lib/merge.js` contract.
- **C. A + B together** — the durable answer.

Whatever is chosen, also **fix the simulation** so it actually exercises the cap (drive 25+ reviews on a subset) — as written it cannot fail on history growth.

### WI-11 acceptance status (what IS verified)

Green today: 77 Playwright tests (incl. `@v2smoke` live), every `tests/*.js` suite, both offline integrity suites, the 56-symbol engine API surface, and the localStorage-equivalence proof (now date-independent, 0 differences beyond the 3 documented WI-11 deltas).

Still outstanding for WI-11: the growth finding above; deploying the `api/src/functions/sync.js` schemaVersion change (preflight first — currently NOT deployed, live API verified without it); and a live `/v2/` `e2e_test_student` round-trip showing the v2 envelope end to end.
